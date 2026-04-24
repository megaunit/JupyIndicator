import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { GitVersions, GitWatchPaths } from './types';

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface GitRepositoryInfo {
  repoRoot: string;
  gitDir: string;
  gitCommonDir: string;
  headRef: string | null;
}

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

async function findRepoInfo(startDir: string): Promise<GitRepositoryInfo | null> {
  if (!fs.existsSync(startDir)) return null;
  const [rootRes, gitDirRes, gitCommonDirRes, headRefRes] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel'], startDir),
    runGit(['rev-parse', '--git-dir'], startDir),
    runGit(['rev-parse', '--git-common-dir'], startDir),
    runGit(['symbolic-ref', '--quiet', 'HEAD'], startDir),
  ]);
  if (rootRes.code !== 0 || gitDirRes.code !== 0 || gitCommonDirRes.code !== 0) {
    return null;
  }
  const repoRoot = rootRes.stdout.trim();
  const gitDir = resolveGitPath(startDir, gitDirRes.stdout.trim());
  const gitCommonDir = resolveGitPath(startDir, gitCommonDirRes.stdout.trim());
  const headRef = headRefRes.code === 0 ? headRefRes.stdout.trim() : null;
  if (repoRoot.length === 0 || gitDir.length === 0 || gitCommonDir.length === 0) {
    return null;
  }
  return { repoRoot, gitDir, gitCommonDir, headRef: headRef || null };
}

async function gitShow(repoRoot: string, ref: string): Promise<string | null> {
  const res = await runGit(['show', ref], repoRoot);
  if (res.code !== 0) return null;
  return res.stdout;
}

/**
 * Read HEAD and index versions of a file. Both may be null:
 *   - head is null when the file was never committed
 *   - index is null when the file is not present in the index
 */
export async function getGitVersions(filePath: string): Promise<GitVersions> {
  const repo = await findRepoInfo(path.dirname(filePath));
  if (!repo) {
    return { inRepo: false, head: null, index: null, repoRoot: null, watchPaths: null };
  }
  const relPath = relativeGitPath(repo.repoRoot, filePath);
  const [head, index] = await Promise.all([
    gitShow(repo.repoRoot, `HEAD:${relPath}`),
    gitShow(repo.repoRoot, `:${relPath}`),
  ]);
  return {
    inRepo: true,
    head,
    index,
    repoRoot: repo.repoRoot,
    watchPaths: gitStateFiles(repo),
  };
}

/** Returns git state files for watching, including worktree and packed-ref layouts. */
export function gitStateFiles(repo: {
  gitDir: string;
  gitCommonDir: string;
  headRef: string | null;
}): GitWatchPaths {
  return {
    head: path.join(repo.gitDir, 'HEAD'),
    index: path.join(repo.gitDir, 'index'),
    ref: repo.headRef ? path.join(repo.gitCommonDir, ...repo.headRef.split('/')) : null,
    packedRefs: path.join(repo.gitCommonDir, 'packed-refs'),
  };
}

function resolveGitPath(cwd: string, rawPath: string): string {
  if (rawPath.length === 0) return rawPath;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function relativeGitPath(repoRoot: string, filePath: string): string {
  let relPath = path.relative(repoRoot, filePath);
  if (isOutsideRepo(relPath)) {
    relPath = path.relative(repoRoot, realpathIfExists(filePath));
  }
  return relPath.split(path.sep).join('/');
}

function isOutsideRepo(relPath: string): boolean {
  return relPath.startsWith('..') || path.isAbsolute(relPath);
}

function realpathIfExists(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}
