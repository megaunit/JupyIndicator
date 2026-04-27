import {
  RawLineChange,
  allLinesAdded,
  diffCellSources,
  makeRawLineChange,
  normalizeChangeGroups,
} from './cellDiffer';
import { parseNotebook } from './notebookParser';
import { NbdimeDiff, NbdimeDiffEntry } from './nbdimeTypes';
import { ParsedCell, ParsedNotebook } from './types';

interface DeletedCellMarker {
  oldCell: ParsedCell;
  currentIndex: number;
}

/**
 * Convert nbdime's semantic notebook diff into visible cell source markers.
 * nbdime decides which cells/sources changed; cellDiffer is only used to place
 * source edits on concrete editor lines after nbdime identifies a source patch.
 */
export function computeNotebookChangesFromNbdimeDiff(
  diff: NbdimeDiff,
  oldRaw: string | null | undefined,
  newRaw: string | null | undefined,
): Map<string, RawLineChange[]> {
  const oldNotebook = parseNotebook(oldRaw);
  const newNotebook = parseNotebook(newRaw);
  const out = new Map<string, RawLineChange[]>();
  const deletedCells: DeletedCellMarker[] = [];

  for (const op of diff) {
    if (op.op === 'patch' && op.key === 'cells' && Array.isArray(op.diff)) {
      applyCellsDiff(out, deletedCells, oldNotebook, newNotebook, op.diff);
    }
  }

  for (const deleted of deletedCells) {
    const anchor = anchorDeletedCell(newNotebook.cells, deleted.currentIndex);
    if (!anchor) continue;
    pushChange(out, anchor.cell.id, anchor.line, 'deleted', {
      oldStartLine: 0,
      oldLineCount: sourceLineCount(deleted.oldCell.source),
      newStartLine: anchor.line,
      newLineCount: 0,
    });
  }

  for (const [cellId, changes] of out) {
    out.set(cellId, normalizeChangeGroups(dedupeChanges(changes)));
  }
  return out;
}

function applyCellsDiff(
  out: Map<string, RawLineChange[]>,
  deletedCells: DeletedCellMarker[],
  oldNotebook: ParsedNotebook,
  newNotebook: ParsedNotebook,
  cellsDiff: NbdimeDiff,
): void {
  let currentOffset = 0;
  const sorted = [...cellsDiff].sort(compareSequenceOps);

  for (const op of sorted) {
    const key = numericKey(op);
    if (key === null) continue;
    const currentIndex = Math.max(0, key + currentOffset);

    if (op.op === 'addrange') {
      const count = Array.isArray(op.valuelist) ? op.valuelist.length : 0;
      for (let i = 0; i < count; i++) {
        const cell = newNotebook.cells[currentIndex + i];
        if (cell) pushAll(out, cell.id, allLinesAdded(cell.source));
      }
      currentOffset += count;
      continue;
    }

    if (op.op === 'removerange') {
      const count = typeof op.length === 'number' ? op.length : 1;
      for (let i = 0; i < count; i++) {
        const oldCell = oldNotebook.cells[key + i];
        if (oldCell) deletedCells.push({ oldCell, currentIndex });
      }
      currentOffset -= count;
      continue;
    }

    if (op.op === 'patch') {
      if (!Array.isArray(op.diff) || !cellDiffTouchesSource(op.diff)) continue;
      const oldCell = oldNotebook.cells[key];
      const newCell = findCurrentCellForPatch(newNotebook, oldCell, currentIndex);
      if (!oldCell || !newCell) continue;
      pushAll(out, newCell.id, diffCellSources(oldCell.source, newCell.source));
      continue;
    }

    if (op.op === 'replace') {
      const oldCell = oldNotebook.cells[key];
      const newCell = newNotebook.cells[currentIndex];
      if (!oldCell || !newCell || oldCell.source === newCell.source) continue;
      pushAll(out, newCell.id, diffCellSources(oldCell.source, newCell.source));
    }
  }
}

function cellDiffTouchesSource(cellDiff: NbdimeDiff): boolean {
  return cellDiff.some((op) => {
    if (op.key === 'source') return true;
    return Array.isArray(op.diff) && cellDiffTouchesSource(op.diff);
  });
}

function findCurrentCellForPatch(
  notebook: ParsedNotebook,
  oldCell: ParsedCell | undefined,
  currentIndex: number,
): ParsedCell | undefined {
  if (oldCell?.hasStableId) {
    return notebook.cells.find((cell) => cell.id === oldCell.id);
  }
  return notebook.cells[currentIndex];
}

function anchorDeletedCell(
  currentCells: ParsedCell[],
  currentIndex: number,
): { cell: ParsedCell; line: number } | null {
  if (currentCells.length === 0) return null;
  const next = currentCells[currentIndex];
  if (next) return { cell: next, line: 0 };
  const prev = currentCells[Math.min(Math.max(0, currentIndex - 1), currentCells.length - 1)];
  return { cell: prev, line: lastLineIndex(prev.source) };
}

function pushAll(out: Map<string, RawLineChange[]>, cellId: string, changes: RawLineChange[]): void {
  const existing = out.get(cellId) ?? [];
  existing.push(...changes);
  out.set(cellId, existing);
}

function pushChange(
  out: Map<string, RawLineChange[]>,
  cellId: string,
  line: number,
  type: 'added' | 'modified' | 'deleted',
  range: Parameters<typeof makeRawLineChange>[2],
): void {
  const changes = out.get(cellId) ?? [];
  changes.push(makeRawLineChange(line, type, range));
  out.set(cellId, changes);
}

function compareSequenceOps(a: NbdimeDiffEntry, b: NbdimeDiffEntry): number {
  const ak = numericKey(a) ?? Number.MAX_SAFE_INTEGER;
  const bk = numericKey(b) ?? Number.MAX_SAFE_INTEGER;
  return ak - bk || opPriority(a.op) - opPriority(b.op);
}

function opPriority(op: string): number {
  if (op === 'addrange') return 0;
  if (op === 'patch' || op === 'replace') return 1;
  if (op === 'removerange') return 2;
  return 3;
}

function numericKey(op: NbdimeDiffEntry): number | null {
  return typeof op.key === 'number' ? op.key : null;
}

function dedupeChanges(changes: RawLineChange[]): RawLineChange[] {
  const seen = new Set<string>();
  const out: RawLineChange[] = [];
  for (const change of changes) {
    const key = `${change.line}|${change.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(change);
  }
  return out;
}

function lastLineIndex(source: string): number {
  if (source.length === 0) return 0;
  return Math.max(0, source.split('\n').length - 1);
}

function sourceLineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split('\n').length;
}
