import {
  RawLineChange,
  allLinesAdded,
  diffCellSources,
  makeRawLineChange,
  normalizeChangeGroups,
} from './cellDiffer';
import { CellPair, matchCells } from './cellMatcher';
import { ParsedCell, ParsedNotebook } from './types';

export function computeNotebookChanges(
  base: ParsedNotebook | null,
  current: ParsedNotebook,
): Map<string, RawLineChange[]> {
  const out = new Map<string, RawLineChange[]>();
  if (!base) {
    for (const cur of current.cells) {
      out.set(cur.id, allLinesAdded(cur.source));
    }
    return out;
  }

  const { pairs, deletedBase } = matchCells(base.cells, current.cells);
  const pairByCurrent = new Map<number, ParsedCell>();
  for (const p of pairs) pairByCurrent.set(p.current.index, p.base);

  for (const cur of current.cells) {
    const baseCell = pairByCurrent.get(cur.index);
    if (baseCell) {
      out.set(cur.id, diffCellSources(baseCell.source, cur.source));
    } else {
      out.set(cur.id, allLinesAdded(cur.source));
    }
  }

  for (const deleted of deletedBase) {
    const anchor = findDeletedCellAnchor(deleted, pairs, current.cells);
    if (!anchor) continue;
    pushUnique(
      out,
      anchor.cell.id,
      makeRawLineChange(anchor.line, 'deleted', {
        oldStartLine: 0,
        oldLineCount: sourceLineCount(deleted.source),
        newStartLine: anchor.line,
        newLineCount: 0,
      }),
    );
  }

  for (const [cellId, changes] of out) {
    out.set(cellId, normalizeChangeGroups(changes));
  }

  return out;
}

interface DeletedCellAnchor {
  cell: ParsedCell;
  line: number;
}

function findDeletedCellAnchor(
  deleted: ParsedCell,
  pairs: CellPair[],
  currentCells: ParsedCell[],
): DeletedCellAnchor | null {
  if (currentCells.length === 0) return null;

  let next: CellPair | null = null;
  let prev: CellPair | null = null;
  for (const pair of pairs) {
    if (pair.base.index > deleted.index && (!next || pair.base.index < next.base.index)) {
      next = pair;
    }
    if (pair.base.index < deleted.index && (!prev || pair.base.index > prev.base.index)) {
      prev = pair;
    }
  }

  if (next) return { cell: next.current, line: 0 };
  if (prev) return { cell: prev.current, line: lastLineIndex(prev.current.source) };

  const fallback = currentCells[Math.min(deleted.index, currentCells.length - 1)];
  return { cell: fallback, line: deleted.index === 0 ? 0 : lastLineIndex(fallback.source) };
}

function lastLineIndex(source: string): number {
  if (source.length === 0) return 0;
  return Math.max(0, source.split('\n').length - 1);
}

function sourceLineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split('\n').length;
}

function pushUnique(
  changes: Map<string, RawLineChange[]>,
  cellId: string,
  change: RawLineChange,
): void {
  const list = changes.get(cellId) ?? [];
  if (!list.some((c) => c.line === change.line && c.type === change.type)) {
    list.push(change);
  }
  changes.set(cellId, list);
}
