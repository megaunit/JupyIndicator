import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { GitVersions } from './types';

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function runGit(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
        });
      },
    );
  });
}

async function findRepoRoot(startDir: string): Promise<string | null> {
  if (!fs.existsSync(startDir)) return null;
  const res = await runGit(['rev-parse', '--show-toplevel'], startDir);
  if (res.code !== 0) return null;
  const root = res.stdout.trim();
  return root.length > 0 ? root : null;
}

async function gitShow(repoRoot: string, ref: string): Promise<string | null> {
  const res = await runGit(['show', ref], repoRoot);
  if (res.code !== 0) return null;
  return res.stdout;
}

/**
 * Read HEAD and index versions of a file. Both may be null:
 *   - head is null when the file was never committed
 *   - index is null when the file is not staged (or identical-to-HEAD with no staged entry)
 */
export async function getGitVersions(filePath: string): Promise<GitVersions> {
  const repoRoot = await findRepoRoot(path.dirname(filePath));
  if (!repoRoot) {
    return { inRepo: false, head: null, index: null, repoRoot: null };
  }
  const relPath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  const [head, index] = await Promise.all([
    gitShow(repoRoot, `HEAD:${relPath}`),
    gitShow(repoRoot, `:${relPath}`),
  ]);
  return { inRepo: true, head, index, repoRoot };
}

/** Returns paths to the `.git/HEAD` and `.git/index` files for watching. */
export function gitStateFiles(repoRoot: string): { head: string; index: string } {
  return {
    head: path.join(repoRoot, '.git', 'HEAD'),
    index: path.join(repoRoot, '.git', 'index'),
  };
}
