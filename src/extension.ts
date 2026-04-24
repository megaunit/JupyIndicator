import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseNotebook } from './notebookParser';
import { RawLineChange } from './cellDiffer';
import { getGitVersions } from './gitProvider';
import { computeNotebookChanges } from './notebookDiffer';
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
  ParsedCell,
  ParsedNotebook,
  GitWatchPaths,
} from './types';

interface GitCache {
  head: ParsedNotebook | null;
  index: ParsedNotebook | null;
  inRepo: boolean;
  repoRoot: string | null;
}

interface NotebookState {
  /** Latest per-cell change list, keyed by current cell id. */
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

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('JupyIndicator');
  context.subscriptions.push(output);

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
      scheduleRecompute(ev.notebook, getDebounceMs());
    }),
    vscode.workspace.onDidSaveNotebookDocument((nb) => {
      if (isTargetNotebook(nb)) scheduleRecompute(nb, 0);
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

  const current = fromNotebookDocument(nb);

  if (!s.git) {
    const raw = await getGitVersions(nb.uri.fsPath);
    if (!enabled || generation !== s.generation || !states.has(key)) return;
    s.git = {
      inRepo: raw.inRepo,
      repoRoot: raw.repoRoot,
      head: raw.head !== null ? parseNotebook(raw.head) : null,
      index: raw.index !== null ? parseNotebook(raw.index) : null,
    };
    if (raw.repoRoot && raw.watchPaths) registerWatcher(raw.repoRoot, raw.watchPaths, key);
  }

  if (!s.git.inRepo) {
    s.changes.clear();
    if (!enabled || generation !== s.generation || !states.has(key)) return;
    paintAll(nb, s);
    return;
  }

  // Compute total changes (HEAD → current) and unstaged (index → current).
  // A line is "staged" iff it appears in total but not in unstaged.
  const total = computeNotebookChanges(s.git.head, current);
  const unstaged = computeNotebookChanges(s.git.index ?? s.git.head, current);

  s.changes.clear();
  for (const cur of current.cells) {
    const all = total.get(cur.id) ?? [];
    const un = unstaged.get(cur.id) ?? [];
    const unSet = new Set(un.map((c) => `${c.line}|${c.type}`));
    const merged: CellLineChange[] = [];
    for (const ch of all) {
      const staged = !unSet.has(`${ch.line}|${ch.type}`);
      merged.push({ ...ch, staged });
    }
    // Any unstaged change that wasn't in total (rare: e.g. identical lines in
    // current and HEAD but different in index) is still worth showing.
    const mergedKey = new Set(merged.map((c) => `${c.line}|${c.type}`));
    for (const ch of un) {
      const k = `${ch.line}|${ch.type}`;
      if (!mergedKey.has(k)) merged.push({ ...ch, staged: false });
    }
    s.changes.set(cur.id, merged);
  }
  if (!enabled || generation !== s.generation || !states.has(key)) return;
  paintAll(nb, s);
}

function paintAll(nb: vscode.NotebookDocument, s: NotebookState): void {
  for (const cell of nb.getCells()) {
    const editor = findCellEditor(cell.document.uri);
    if (!editor) continue;
    const cellId = cellIdFor(cell);
    const changes = s.changes.get(cellId) ?? [];
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
  const changes = s.changes.get(cellIdFor(cell)) ?? [];
  if (changes.length === 0) clearCellDecorations(editor, decorations);
  else applyCellDecorations(editor, changes, decorations);
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

/** Build a ParsedNotebook from the in-memory NotebookDocument. */
function fromNotebookDocument(doc: vscode.NotebookDocument): ParsedNotebook {
  const cells: ParsedCell[] = doc.getCells().map((cell, index) => {
    const cellType: CellType =
      cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
    const source = cell.document.getText();
    const stableId = extractCellMetadataId(cell.metadata);
    return {
      id: stableId ?? synthesizeId(index, cellType, source),
      hasStableId: stableId !== null,
      index,
      cellType,
      source,
    };
  });
  return { nbformat: 4, nbformatMinor: 5, cells };
}

function cellIdFor(cell: vscode.NotebookCell): string {
  const stableId = extractCellMetadataId(cell.metadata);
  if (stableId !== null) return stableId;
  const cellType: CellType =
    cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
  return synthesizeId(cell.index, cellType, cell.document.getText());
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
