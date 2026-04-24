import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGitVersions, gitStateFiles } from '../src/gitProvider';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function makeTempDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jupyindicator-'));
  return tmpDir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('gitProvider.gitStateFiles', () => {
  it('builds watch paths for a normal branch checkout', () => {
    const gitDir = path.join('/repo', '.git');
    const paths = gitStateFiles({
      gitDir,
      gitCommonDir: gitDir,
      headRef: 'refs/heads/main',
    });

    expect(paths).toEqual({
      head: path.join(gitDir, 'HEAD'),
      index: path.join(gitDir, 'index'),
      ref: path.join(gitDir, 'refs', 'heads', 'main'),
      packedRefs: path.join(gitDir, 'packed-refs'),
    });
  });

  it('builds worktree-specific HEAD/index paths and common ref paths', () => {
    const gitDir = path.join('/repo', '.git', 'worktrees', 'feature');
    const gitCommonDir = path.join('/repo', '.git');
    const paths = gitStateFiles({
      gitDir,
      gitCommonDir,
      headRef: 'refs/heads/feature',
    });

    expect(paths.head).toBe(path.join(gitDir, 'HEAD'));
    expect(paths.index).toBe(path.join(gitDir, 'index'));
    expect(paths.ref).toBe(path.join(gitCommonDir, 'refs', 'heads', 'feature'));
    expect(paths.packedRefs).toBe(path.join(gitCommonDir, 'packed-refs'));
  });

  it('omits the branch ref path for detached HEAD', () => {
    const gitDir = path.join('/repo', '.git');
    const paths = gitStateFiles({ gitDir, gitCommonDir: gitDir, headRef: null });

    expect(paths.ref).toBeNull();
  });
});

describe('gitProvider.getGitVersions', () => {
  it('reads HEAD and index content and returns real watch paths', async () => {
    const repo = makeTempDir();
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'JupyIndicator Test']);
    git(repo, ['config', 'user.email', 'jupyindicator@example.com']);

    const notebookPath = path.join(repo, 'notebook.ipynb');
    fs.writeFileSync(notebookPath, JSON.stringify({ nbformat: 4, cells: [] }));
    git(repo, ['add', 'notebook.ipynb']);
    git(repo, ['commit', '-m', 'initial']);

    fs.writeFileSync(notebookPath, JSON.stringify({ nbformat: 4, cells: [{ source: 'staged' }] }));
    git(repo, ['add', 'notebook.ipynb']);
    fs.writeFileSync(notebookPath, JSON.stringify({ nbformat: 4, cells: [{ source: 'working' }] }));

    const versions = await getGitVersions(notebookPath);
    const realRepo = fs.realpathSync(repo);

    expect(versions.inRepo).toBe(true);
    expect(versions.repoRoot).toBe(realRepo);
    expect(versions.head).toContain('"cells":[]');
    expect(versions.index).toContain('staged');
    expect(versions.index).not.toContain('working');
    expect(versions.watchPaths?.head).toBe(path.join(repo, '.git', 'HEAD'));
    expect(versions.watchPaths?.index).toBe(path.join(repo, '.git', 'index'));
    expect(versions.watchPaths?.ref).toContain(path.join('.git', 'refs', 'heads'));
    expect(versions.watchPaths?.packedRefs).toBe(path.join(repo, '.git', 'packed-refs'));
  });
});
