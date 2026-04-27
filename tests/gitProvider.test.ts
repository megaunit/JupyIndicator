import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RawLineChange } from '../src/cellDiffer';
import { getGitNbdimeDiffs, getGitVersions, gitStateFiles } from '../src/gitProvider';
import { computeNotebookChangesFromNbdimeDiff } from '../src/nbdimeNotebookDiffer';
import { NbdimeDiffRunner } from '../src/nbdimeProvider';
import { parseNotebook } from '../src/notebookParser';

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

function notebook(source: string[]): string {
  return [
    '{',
    '  "cells": [',
    '    {',
    '      "cell_type": "code",',
    '      "metadata": {"id": "cell-a"},',
    '      "source": [',
    ...source.map(
      (line, index) => `        ${JSON.stringify(line)}${index === source.length - 1 ? '' : ','}`,
    ),
    '      ]',
    '    }',
    '  ],',
    '  "nbformat": 4,',
    '  "nbformat_minor": 5',
    '}',
  ].join('\n');
}

function compact(changes: RawLineChange[] | undefined) {
  return (changes ?? []).map(({ line, type }) => ({ line, type }));
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

describe('gitProvider.getGitNbdimeDiffs', () => {
  it('returns staged and unstaged nbdime diffs separately', async () => {
    const repo = makeTempDir();
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'JupyIndicator Test']);
    git(repo, ['config', 'user.email', 'jupyindicator@example.com']);

    const notebookPath = path.join(repo, 'notebook.ipynb');
    fs.writeFileSync(notebookPath, notebook(['a\n', 'b\n', 'c']));
    git(repo, ['add', 'notebook.ipynb']);
    git(repo, ['commit', '-m', 'initial']);

    fs.writeFileSync(notebookPath, notebook(['a\n', 'B\n', 'c']));
    git(repo, ['add', 'notebook.ipynb']);
    fs.writeFileSync(notebookPath, notebook(['a\n', 'B\n', 'C']));

    const diffs = await getGitNbdimeDiffs(notebookPath, fakeNbdimeRunner);
    const staged = computeNotebookChangesFromNbdimeDiff(diffs.staged, diffs.head, diffs.index);
    const unstaged = computeNotebookChangesFromNbdimeDiff(
      diffs.unstaged,
      diffs.index,
      diffs.working,
    );
    const total = computeNotebookChangesFromNbdimeDiff(diffs.total, diffs.head, diffs.working);

    expect(compact(staged.get('cell-a'))).toEqual([{ line: 1, type: 'modified' }]);
    expect(compact(unstaged.get('cell-a'))).toEqual([{ line: 2, type: 'modified' }]);
    expect(compact(total.get('cell-a'))).toEqual([
      { line: 1, type: 'modified' },
      { line: 2, type: 'modified' },
    ]);
  });

  it('uses an in-memory notebook buffer instead of saved disk content when provided', async () => {
    const repo = makeTempDir();
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'JupyIndicator Test']);
    git(repo, ['config', 'user.email', 'jupyindicator@example.com']);

    const notebookPath = path.join(repo, 'notebook.ipynb');
    fs.writeFileSync(notebookPath, notebook(['a\n', 'b\n', 'c']));
    git(repo, ['add', 'notebook.ipynb']);
    git(repo, ['commit', '-m', 'initial']);

    fs.writeFileSync(notebookPath, notebook(['a\n', 'b\n', 'saved']));
    const inMemory = notebook(['a\n', 'b\n', 'buffer']);

    const diffs = await getGitNbdimeDiffs(notebookPath, fakeNbdimeRunner, inMemory);
    const total = computeNotebookChangesFromNbdimeDiff(diffs.total, diffs.head, diffs.working);

    expect(diffs.working).toBe(inMemory);
    expect(compact(total.get('cell-a'))).toEqual([{ line: 2, type: 'modified' }]);
  });
});

const fakeNbdimeRunner: NbdimeDiffRunner = async (baseRaw, remoteRaw) => {
  const base = parseNotebook(baseRaw);
  const remote = parseNotebook(remoteRaw);
  if (base.cells.length === 0 && remote.cells.length > 0) {
    return {
      ok: true,
      diff: [{
        op: 'patch',
        key: 'cells',
        diff: [{ op: 'addrange', key: 0, valuelist: remote.cells }],
      }],
      error: null,
    };
  }

  const cellDiff = [];
  for (let i = 0; i < Math.max(base.cells.length, remote.cells.length); i++) {
    const oldCell = base.cells[i];
    const newCell = remote.cells[i];
    if (oldCell && newCell && oldCell.source !== newCell.source) {
      cellDiff.push({
        op: 'patch',
        key: i,
        diff: [{ op: 'patch', key: 'source', diff: [{ op: 'patch', key: 0, diff: [] }] }],
      });
    }
  }

  return {
    ok: true,
    diff: cellDiff.length > 0 ? [{ op: 'patch', key: 'cells', diff: cellDiff }] : [],
    error: null,
  };
};
