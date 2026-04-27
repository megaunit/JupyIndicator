import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NbdimeDiff } from './nbdimeTypes';

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  errorCode: string | null;
}

export interface NbdimeDiffResult {
  ok: boolean;
  diff: NbdimeDiff;
  error: string | null;
}

export type NbdimeDiffRunner = (
  baseRaw: string | null | undefined,
  remoteRaw: string | null | undefined,
) => Promise<NbdimeDiffResult>;

export interface NbdimeRunnerOptions {
  pythonPath?: string;
  managedStoragePath?: string;
  autoInstall?: boolean;
}

interface PythonCandidate {
  command: string;
  prefixArgs: string[];
}

const EMPTY_NOTEBOOK = JSON.stringify({
  cells: [],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

const PYTHON_HELPER = `
import json
import sys

try:
    import nbdime.diffing.notebooks as notebooks
    import nbdime.utils as nb_utils
except Exception as exc:
    print("JUPYINDICATOR_NBDIME_IMPORT_ERROR: " + str(exc), file=sys.stderr)
    sys.exit(86)

def read_notebook(path):
    with open(path, encoding="utf-8") as handle:
        return nb_utils.read_notebook(handle, on_null="empty")

base = read_notebook(sys.argv[1])
remote = read_notebook(sys.argv[2])
print(json.dumps(notebooks.diff_notebooks(base, remote)))
`;

export async function runNbdimeDiff(
  baseRaw: string | null | undefined,
  remoteRaw: string | null | undefined,
  pythonPath = '',
): Promise<NbdimeDiffResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jupyindicator-nbdime-'));
  const basePath = path.join(tmpDir, 'base.ipynb');
  const remotePath = path.join(tmpDir, 'remote.ipynb');
  try {
    await Promise.all([
      fs.writeFile(basePath, baseRaw ?? EMPTY_NOTEBOOK, 'utf8'),
      fs.writeFile(remotePath, remoteRaw ?? EMPTY_NOTEBOOK, 'utf8'),
    ]);

    let lastError = 'nbdime is not available';
    for (const candidate of pythonCandidates(pythonPath)) {
      const res = await runPython(candidate.command, [
        ...candidate.prefixArgs,
        '-c',
        PYTHON_HELPER,
        basePath,
        remotePath,
      ]);
      if (res.code === 0) {
        return parseDiffResult(res.stdout);
      }
      lastError = res.stderr.trim() || `python exited with code ${res.code}`;
      if (!isImportError(res)) break;
    }
    return { ok: false, diff: [], error: lastError };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function createNbdimeDiffRunner(
  optionsOrPythonPath: NbdimeRunnerOptions | string,
): NbdimeDiffRunner {
  const options = typeof optionsOrPythonPath === 'string'
    ? { pythonPath: optionsOrPythonPath }
    : optionsOrPythonPath;
  let managedPython: Promise<string | null> | null = null;
  let preferManaged = false;

  return async (baseRaw, remoteRaw) => {
    if (preferManaged && managedPython) {
      const pythonPath = await managedPython;
      if (pythonPath) return runNbdimeDiff(baseRaw, remoteRaw, pythonPath);
    }

    const primary = await runNbdimeDiff(baseRaw, remoteRaw, options.pythonPath ?? '');
    if (primary.ok || options.autoInstall === false) {
      return primary;
    }

    managedPython ??= ensureManagedNbdime(options.managedStoragePath, options.pythonPath ?? '');
    const pythonPath = await managedPython;
    if (!pythonPath) return primary;

    preferManaged = true;
    const managed = await runNbdimeDiff(baseRaw, remoteRaw, pythonPath);
    if (managed.ok) return managed;
    return {
      ok: false,
      diff: [],
      error: `${primary.error ?? 'nbdime unavailable'}; managed nbdime failed: ${managed.error}`,
    };
  };
}

function parseDiffResult(stdout: string): NbdimeDiffResult {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (Array.isArray(parsed)) return { ok: true, diff: parsed as NbdimeDiff, error: null };
    return { ok: false, diff: [], error: 'nbdime returned a non-list diff object' };
  } catch (err) {
    return { ok: false, diff: [], error: `failed to parse nbdime diff JSON: ${err}` };
  }
}

async function ensureManagedNbdime(
  storagePath: string | undefined,
  preferredPythonPath: string,
): Promise<string | null> {
  if (!storagePath) return null;
  const venvDir = path.join(storagePath, 'python', 'nbdime-venv');
  const pythonPath = managedPythonPath(venvDir);
  if (await canImportNbdime({ command: pythonPath, prefixArgs: [] })) return pythonPath;

  await fs.mkdir(path.dirname(venvDir), { recursive: true });
  for (const candidate of uniquePythonCandidates(preferredPythonPath)) {
    const created = await runPython(candidate.command, [
      ...candidate.prefixArgs,
      '-m',
      'venv',
      venvDir,
    ]);
    if (created.code !== 0) continue;

    await runPython(pythonPath, ['-m', 'ensurepip', '--upgrade']);
    const installed = await runPython(pythonPath, ['-m', 'pip', 'install', 'nbdime']);
    if (installed.code === 0 && await canImportNbdime({ command: pythonPath, prefixArgs: [] })) {
      return pythonPath;
    }
  }
  return null;
}

function uniquePythonCandidates(preferredPythonPath: string): PythonCandidate[] {
  const seen = new Set<string>();
  const out: PythonCandidate[] = [];
  for (const candidate of [
    ...pythonCandidates(preferredPythonPath),
    ...pythonCandidates(''),
  ]) {
    const key = `${candidate.command}\0${candidate.prefixArgs.join('\0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function canImportNbdime(candidate: PythonCandidate): Promise<boolean> {
  const res = await runPython(candidate.command, [
    ...candidate.prefixArgs,
    '-c',
    'import nbdime',
  ]);
  return res.code === 0;
}

function managedPythonPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function runPython(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const errorCode = typeof (err as NodeJS.ErrnoException | null)?.code === 'string'
          ? ((err as NodeJS.ErrnoException).code as string)
          : null;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr || (err instanceof Error ? err.message : ''),
          code: err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((err as NodeJS.ErrnoException & { code: number }).code)
            : err
              ? 1
              : 0,
          errorCode,
        });
      },
    );
  });
}

function pythonCandidates(pythonPath: string): PythonCandidate[] {
  const trimmed = pythonPath.trim();
  if (trimmed.length > 0) return [{ command: trimmed, prefixArgs: [] }];

  if (process.platform === 'win32') {
    return [
      { command: 'py', prefixArgs: ['-3'] },
      { command: 'python', prefixArgs: [] },
      { command: 'python3', prefixArgs: [] },
    ];
  }
  return [
    { command: 'python3', prefixArgs: [] },
    { command: 'python', prefixArgs: [] },
  ];
}

function isImportError(res: ExecResult): boolean {
  return res.errorCode === 'ENOENT' ||
    res.code === 86 ||
    res.stderr.includes('JUPYINDICATOR_NBDIME_IMPORT_ERROR');
}
