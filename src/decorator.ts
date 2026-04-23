import * as vscode from 'vscode';
import { CellLineChange } from './types';

const NOTEBOOK_CELL_SCHEME = 'vscode-notebook-cell';

type Key =
  | 'unstagedAdded'
  | 'unstagedModified'
  | 'unstagedDeleted'
  | 'stagedAdded'
  | 'stagedModified'
  | 'stagedDeleted';

const ALL_KEYS: Key[] = [
  'unstagedAdded',
  'unstagedModified',
  'unstagedDeleted',
  'stagedAdded',
  'stagedModified',
  'stagedDeleted',
];

export class DecorationSet {
  private types = new Map<Key, vscode.TextEditorDecorationType>();

  rebuild(colors: Record<Key, string>): void {
    this.dispose();
    for (const k of ALL_KEYS) {
      this.types.set(k, this.build(k, colors[k]));
    }
  }

  private build(key: Key, color: string): vscode.TextEditorDecorationType {
    const isDeleted = key.endsWith('Deleted');
    const svg = isDeleted ? deleteTriangleSvg(color) : verticalBarSvg(color);
    const iconUri = vscode.Uri.parse(
      `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    );
    return vscode.window.createTextEditorDecorationType({
      gutterIconPath: iconUri,
      gutterIconSize: 'contain',
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  get(key: Key): vscode.TextEditorDecorationType | undefined {
    return this.types.get(key);
  }

  dispose(): void {
    for (const t of this.types.values()) t.dispose();
    this.types.clear();
  }
}

export function isCellEditor(editor: vscode.TextEditor): boolean {
  return editor.document.uri.scheme === NOTEBOOK_CELL_SCHEME;
}

/** Find the TextEditor (if currently visible) for a given cell document. */
export function findCellEditor(
  cellUri: vscode.Uri,
): vscode.TextEditor | undefined {
  const target = cellUri.toString();
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === target,
  );
}

/** Apply a set of line changes to one cell's editor. */
export function applyCellDecorations(
  editor: vscode.TextEditor,
  changes: CellLineChange[],
  decorations: DecorationSet,
): void {
  const buckets: Record<Key, vscode.Range[]> = {
    unstagedAdded: [],
    unstagedModified: [],
    unstagedDeleted: [],
    stagedAdded: [],
    stagedModified: [],
    stagedDeleted: [],
  };
  const lineMax = Math.max(0, editor.document.lineCount - 1);
  for (const ch of changes) {
    const line = Math.min(Math.max(0, ch.line), lineMax);
    const key = (ch.staged ? 'staged' : 'unstaged') +
      capitalize(ch.type) as Key;
    // Gutter icons render per line; use a zero-width range at column 0.
    const range = new vscode.Range(line, 0, line, 0);
    buckets[key].push(range);
  }
  for (const key of ALL_KEYS) {
    const t = decorations.get(key);
    if (t) editor.setDecorations(t, buckets[key]);
  }
}

/** Clear all JupyIndicator decorations from a cell editor. */
export function clearCellDecorations(
  editor: vscode.TextEditor,
  decorations: DecorationSet,
): void {
  for (const key of ALL_KEYS) {
    const t = decorations.get(key);
    if (t) editor.setDecorations(t, []);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function verticalBarSvg(color: string): string {
  // A thin vertical bar that fills the full line height via the viewBox.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18" viewBox="0 0 6 18">` +
    `<rect x="1.5" y="0" width="3" height="18" fill="${color}"/>` +
    `</svg>`
  );
}

function deleteTriangleSvg(color: string): string {
  // Small right-pointing triangle anchored at the top of the line, matching
  // the VS Code SCM gutter "deleted" indicator convention.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18" viewBox="0 0 6 18">` +
    `<path d="M 0 0 L 6 3 L 0 6 Z" fill="${color}"/>` +
    `</svg>`
  );
}
