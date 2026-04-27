import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { normalizeChangeGroups } from './cellDiffer';
import { GitNbdimeDiffs, getGitNbdimeDiffs } from './gitProvider';
import { computeNotebookChangesFromNbdimeDiff } from './nbdimeNotebookDiffer';
import { createNbdimeDiffRunner } from './nbdimeProvider';
import { computeNotebookChanges } from './notebookDiffer';
import { parseNotebook } from './notebookParser';
import {
  DecorationSet,
  applyCellDecorations,
  clearCellDecorations,
  findCellEditor,
  isCellEditor,
} from './decorator';
import {
  CellLineChange,
  CellType,
  GitWatchPaths,
} from './types';

interface GitCache {
  inRepo: boolean;
  repoRoot: string | null;
  changes: Map<string, CellLineChange[]>;
}

interface NotebookState {
  /** Latest per-cell change list, keyed by current cell id and fallback cell index. */
  changes: Map<string, CellLineChange[]>;
  timer: NodeJS.Timeout | null;
  git: GitCache | null;
  generation: number;
}

interface GitWatch {
  disposables: vscode.Disposable[];
  /** Notebook URI strings registered against this repo. */
  notebooks: Set<string>;
  signature: string;
}

const decorations = new DecorationSet();
const states = new Map<string, NotebookState>();
const gitWatchers = new Map<string, GitWatch>();
let output: vscode.OutputChannel;
let enabled = true;
let globalStoragePath: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('JupyIndicator');
  context.subscriptions.push(output);
  globalStoragePath = context.globalStorageUri.fsPath;

  readConfigAndRebuildDecorations();
  enabled = getConfig().get<boolean>('enabled', true);

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument((nb) => {
      if (isTargetNotebook(nb)) scheduleRecompute(nb, 0);
    }),
    vscode.workspace.onDidCloseNotebookDocument((nb) => dropNotebook(nb)),
    vscode.workspace.onDidChangeNotebookDocument((ev) => {
      if (!enabled) return;
      if (!isTargetNotebook(ev.notebook)) return;
      invalidateGit(ev.notebook);
      scheduleRecompute(ev.notebook, getDebounceMs());
    }),
    vscode.workspace.onDidSaveNotebookDocument((nb) => {
      if (isTargetNotebook(nb)) {
        invalidateGit(nb);
        scheduleRecompute(nb, 0);
      }
    }),
    vscode.window.onDidChangeActiveNotebookEditor((ed) => {
      if (ed && isTargetNotebook(ed.notebook)) scheduleRecompute(ed.notebook, 0);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      if (!enabled) return;
      // A cell editor that just became visible needs its decorations applied
      // from the cached diff.
      for (const e of editors) {
        if (!isCellEditor(e)) continue;
        reapplyFromCache(e);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('jupyindicator.colors')) {
        readConfigAndRebuildDecorations();
        if (enabled) reapplyAll();
        else clearAll();
      }
      if (ev.affectsConfiguration('jupyindicator.enabled')) {
        enabled = getConfig().get<boolean>('enabled', true);
        if (!enabled) {
          cancelAllTimers();
          clearAll();
        } else {
          for (const nb of vscode.workspace.notebookDocuments) {
            if (!isTargetNotebook(nb)) continue;
            invalidateGit(nb);
            scheduleRecompute(nb, 0);
          }
        }
      }
      if (ev.affectsConfiguration('jupyindicator.nbdimePythonPath')) {
        for (const nb of vscode.workspace.notebookDocuments) {
          if (!isTargetNotebook(nb)) continue;
          invalidateGit(nb);
          scheduleRecompute(nb, 0);
        }
      }
      if (ev.affectsConfiguration('jupyindicator.autoInstallNbdime')) {
        for (const nb of vscode.workspace.notebookDocuments) {
          if (!isTargetNotebook(nb)) continue;
          invalidateGit(nb);
          scheduleRecompute(nb, 0);
        }
      }
    }),
    vscode.commands.registerCommand('jupyindicator.refresh', () => {
      for (const nb of vscode.workspace.notebookDocuments) {
        if (isTargetNotebook(nb)) {
          invalidateGit(nb);
          scheduleRecompute(nb, 0);
        }
      }
    }),
    vscode.commands.registerCommand('jupyindicator.toggle', async () => {
      const cfg = getConfig();
      const next = !cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
    }),
    { dispose: disposeAll },
  );

  for (const nb of vscode.workspace.notebookDocuments) {
    if (isTargetNotebook(nb)) scheduleRecompute(nb, 0);
  }
}

export function deactivate(): void {
  disposeAll();
}

function disposeAll(): void {
  for (const s of states.values()) {
    if (s.timer) clearTimeout(s.timer);
  }
  states.clear();
  for (const w of gitWatchers.values()) {
    for (const d of w.disposables) d.dispose();
  }
  gitWatchers.clear();
  decorations.dispose();
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('jupyindicator');
}

function getDebounceMs(): number {
  return getConfig().get<number>('debounceMs', 150);
}

function getNbdimePythonPath(): string {
  return getConfig().get<string>('nbdimePythonPath', '');
}

function getAutoInstallNbdime(): boolean {
  return getConfig().get<boolean>('autoInstallNbdime', true);
}

function readConfigAndRebuildDecorations(): void {
  const cfg = getConfig();
  decorations.rebuild({
    unstagedAdded: cfg.get('colors.unstagedAdded', '#2ea043'),
    unstagedModified: cfg.get('colors.unstagedModified', '#1f6feb'),
    unstagedDeleted: cfg.get('colors.unstagedDeleted', '#f85149'),
    stagedAdded: cfg.get('colors.stagedAdded', '#0f5323'),
    stagedModified: cfg.get('colors.stagedModified', '#0c3d8a'),
    stagedDeleted: cfg.get('colors.stagedDeleted', '#8b1a1a'),
  });
}

function isTargetNotebook(nb: vscode.NotebookDocument): boolean {
  if (nb.uri.scheme !== 'file') return false;
  return nb.notebookType === 'jupyter-notebook' || nb.uri.fsPath.endsWith('.ipynb');
}

function stateFor(nb: vscode.NotebookDocument): NotebookState {
  const key = nb.uri.toString();
  let s = states.get(key);
  if (!s) {
    s = { changes: new Map(), timer: null, git: null, generation: 0 };
    states.set(key, s);
  }
  return s;
}

function dropNotebook(nb: vscode.NotebookDocument): void {
  const key = nb.uri.toString();
  const s = states.get(key);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  states.delete(key);
  if (s.git?.repoRoot) unregisterFromWatcher(s.git.repoRoot, key);
}

function invalidateGit(nb: vscode.NotebookDocument): void {
  const s = states.get(nb.uri.toString());
  if (s) s.git = null;
}

function cancelAllTimers(): void {
  for (const s of states.values()) {
    s.generation++;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  }
}

function invalidateGitForRepo(repoRoot: string): void {
  for (const [key, s] of states.entries()) {
    if (s.git?.repoRoot === repoRoot) {
      s.git = null;
      const nb = vscode.workspace.notebookDocuments.find(
        (n) => n.uri.toString() === key,
      );
      if (nb) scheduleRecompute(nb, 0);
    }
  }
}

function scheduleRecompute(nb: vscode.NotebookDocument, delayMs: number): void {
  if (!enabled) return;
  const s = stateFor(nb);
  const generation = ++s.generation;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    recompute(nb, generation).catch((err) => output.appendLine(`recompute error: ${err}`));
  }, delayMs);
}

async function recompute(nb: vscode.NotebookDocument, generation: number): Promise<void> {
  const key = nb.uri.toString();
  const s = stateFor(nb);
  if (!enabled || generation !== s.generation) return;

  if (!s.git) {
    const currentRaw = notebookDocumentToIpynb(nb);
    const raw = await getGitNbdimeDiffs(
      nb.uri.fsPath,
      createNbdimeDiffRunner({
        pythonPath: getNbdimePythonPath(),
        managedStoragePath: globalStoragePath,
        autoInstall: getAutoInstallNbdime(),
      }),
      currentRaw,
    );
    if (!enabled || generation !== s.generation || !states.has(key)) return;
    s.git = buildGitCache(raw);
    if (raw.repoRoot && raw.watchPaths) registerWatcher(raw.repoRoot, raw.watchPaths, key);
    if (!raw.nbdimeAvailable && raw.nbdimeError) {
      output.appendLine(`nbdime unavailable, using snapshot fallback: ${raw.nbdimeError}`);
    }
  }

  if (!s.git.inRepo) {
    s.changes.clear();
    if (!enabled || generation !== s.generation || !states.has(key)) return;
    paintAll(nb, s);
    return;
  }

  s.changes.clear();
  for (const [cellId, changes] of s.git.changes) {
    s.changes.set(cellId, changes);
  }
  if (!enabled || generation !== s.generation || !states.has(key)) return;
  paintAll(nb, s);
}

function buildGitCache(raw: GitNbdimeDiffs): GitCache {
  if (!raw.inRepo || raw.working === null) {
    return { inRepo: raw.inRepo, repoRoot: raw.repoRoot, changes: new Map() };
  }

  const current = parseNotebook(raw.working);
  let unstaged = computeNotebookChangesFromNbdimeDiff(raw.unstaged, raw.index, raw.working);
  let total = computeNotebookChangesFromNbdimeDiff(raw.total, raw.head, raw.working);

  if (!raw.nbdimeAvailable) {
    unstaged = computeNotebookChanges(
      parseNotebook(raw.index ?? raw.head),
      current,
    );
    total = computeNotebookChanges(parseNotebook(raw.head), current);
  }

  // In a repository with no commits yet, the direct HEAD -> index comparison
  // is the staged source of truth when the index and saved file match.
  if (!hasChanges(total) && raw.index !== null && raw.index === raw.working) {
    const staged = computeNotebookChangesFromNbdimeDiff(raw.staged, raw.head, raw.index);
    if (hasChanges(staged)) total = staged;
  }

  const changes = new Map<string, CellLineChange[]>();
  for (const cur of current.cells) {
    const all = total.get(cur.id) ?? [];
    const un = unstaged.get(cur.id) ?? [];
    const unSet = new Set(un.map((c) => `${c.line}|${c.type}`));
    const merged: CellLineChange[] = [];

    for (const ch of all) {
      merged.push({ ...ch, staged: !unSet.has(`${ch.line}|${ch.type}`) });
    }

    // If the index contains a change that the saved worktree reverted, total
    // can be empty while the index-to-worktree diff still has an unstaged
    // deletion. That deletion is visible in git status and should be shown.
    const mergedKey = new Set(merged.map((c) => `${c.line}|${c.type}`));
    for (const ch of un) {
      const k = `${ch.line}|${ch.type}`;
      if (!mergedKey.has(k)) merged.push({ ...ch, staged: false });
    }

    const normalized = normalizeChangeGroups(merged);
    changes.set(cur.id, normalized);
    changes.set(cellIndexKey(cur.index), normalized);
  }

  return { inRepo: raw.inRepo, repoRoot: raw.repoRoot, changes };
}

function hasChanges<T>(changes: Map<string, T[]>): boolean {
  for (const list of changes.values()) {
    if (list.length > 0) return true;
  }
  return false;
}

function paintAll(nb: vscode.NotebookDocument, s: NotebookState): void {
  for (const cell of nb.getCells()) {
    const editor = findCellEditor(cell.document.uri);
    if (!editor) continue;
    const changes = changesForCell(s, cell);
    if (changes.length === 0) clearCellDecorations(editor, decorations);
    else applyCellDecorations(editor, changes, decorations);
  }
}

function reapplyFromCache(editor: vscode.TextEditor): void {
  const notebookUri = cellNotebookUri(editor.document.uri);
  if (!notebookUri) return;
  const nb = vscode.workspace.notebookDocuments.find(
    (n) => n.uri.toString() === notebookUri,
  );
  if (!nb) return;
  const s = states.get(notebookUri);
  if (!s) return;
  const cell = nb.getCells().find((c) => c.document.uri.toString() === editor.document.uri.toString());
  if (!cell) return;
  const changes = changesForCell(s, cell);
  if (changes.length === 0) clearCellDecorations(editor, decorations);
  else applyCellDecorations(editor, changes, decorations);
}

function changesForCell(s: NotebookState, cell: vscode.NotebookCell): CellLineChange[] {
  return s.changes.get(cellIdFor(cell)) ?? s.changes.get(cellIndexKey(cell.index)) ?? [];
}

function cellIndexKey(index: number): string {
  return `__cell_index_${index}`;
}

function reapplyAll(): void {
  for (const nb of vscode.workspace.notebookDocuments) {
    if (!isTargetNotebook(nb)) continue;
    const s = states.get(nb.uri.toString());
    if (s) paintAll(nb, s);
  }
}

function clearAll(): void {
  for (const e of vscode.window.visibleTextEditors) {
    if (isCellEditor(e)) clearCellDecorations(e, decorations);
  }
}

function cellIdFor(cell: vscode.NotebookCell): string {
  const stableId = extractCellMetadataId(cell.metadata);
  if (stableId !== null) return stableId;
  const cellType: CellType =
    cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
  return synthesizeId(cell.index, cellType, cell.document.getText());
}

function notebookDocumentToIpynb(doc: vscode.NotebookDocument): string {
  return JSON.stringify({
    cells: doc.getCells().map((cell, index) => {
      const cellType = notebookCellType(cell);
      const metadataId = extractCellMetadataId(cell.metadata) ??
        synthesizeId(index, cellType, cell.document.getText());
      const metadata = metadataId ? { id: metadataId } : {};
      const base = {
        cell_type: cellType,
        metadata,
        source: cell.document.getText(),
      };
      if (cellType === 'code') {
        return { ...base, execution_count: null, outputs: [] };
      }
      return base;
    }),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

function notebookCellType(cell: vscode.NotebookCell): CellType {
  if (cell.kind === vscode.NotebookCellKind.Markup) return 'markdown';
  return 'code';
}

function extractCellMetadataId(md: { readonly [k: string]: any }): string | null {
  const direct = md?.id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  // The Jupyter extension has historically stored nbformat metadata under
  // `metadata.custom` — check that path too.
  const custom = md?.custom?.id;
  if (typeof custom === 'string' && custom.length > 0) return custom;
  return null;
}

function synthesizeId(index: number, type: CellType, source: string): string {
  const h = crypto
    .createHash('sha1')
    .update(`${index}|${type}|${source}`)
    .digest('hex')
    .slice(0, 10);
  return `synth-${index}-${h}`;
}

function cellNotebookUri(cellUri: vscode.Uri): string | null {
  if (cellUri.scheme !== 'vscode-notebook-cell') return null;
  // The notebook's file URI uses the same path, scheme `file:`.
  return vscode.Uri.file(cellUri.fsPath).toString();
}

function registerWatcher(repoRoot: string, watchPaths: GitWatchPaths, notebookKey: string): void {
  const signature = watchSignature(watchPaths);
  let w = gitWatchers.get(repoRoot);
  if (w && w.signature !== signature) {
    const notebooks = w.notebooks;
    for (const d of w.disposables) d.dispose();
    w = createGitWatch(repoRoot, watchPaths, signature, notebooks);
    gitWatchers.set(repoRoot, w);
  } else if (!w) {
    w = createGitWatch(repoRoot, watchPaths, signature, new Set());
    gitWatchers.set(repoRoot, w);
  }
  w.notebooks.add(notebookKey);
}

function unregisterFromWatcher(repoRoot: string, notebookKey: string): void {
  const w = gitWatchers.get(repoRoot);
  if (!w) return;
  w.notebooks.delete(notebookKey);
  if (w.notebooks.size === 0) {
    for (const d of w.disposables) d.dispose();
    gitWatchers.delete(repoRoot);
  }
}

function createGitWatch(
  repoRoot: string,
  watchPaths: GitWatchPaths,
  signature: string,
  notebooks: Set<string>,
): GitWatch {
  const onChange = () => invalidateGitForRepo(repoRoot);
  const disposables: vscode.Disposable[] = [];
  for (const file of uniqueWatchFiles(watchPaths)) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
    );
    disposables.push(
      watcher.onDidChange(onChange),
      watcher.onDidCreate(onChange),
      watcher.onDidDelete(onChange),
      watcher,
    );
  }
  return { disposables, notebooks, signature };
}

function uniqueWatchFiles(watchPaths: GitWatchPaths): string[] {
  return [...new Set([
    watchPaths.head,
    watchPaths.index,
    watchPaths.ref,
    watchPaths.packedRefs,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0))];
}

function watchSignature(watchPaths: GitWatchPaths): string {
  return uniqueWatchFiles(watchPaths).sort().join('\n');
}
