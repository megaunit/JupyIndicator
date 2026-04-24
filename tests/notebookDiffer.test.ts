import { describe, it, expect } from 'vitest';
import { computeNotebookChanges } from '../src/notebookDiffer';
import { CellType, ParsedCell, ParsedNotebook } from '../src/types';

function notebook(cells: ParsedCell[]): ParsedNotebook {
  return { nbformat: 4, nbformatMinor: 5, cells };
}

function cell(
  index: number,
  id: string,
  source: string,
  opts: { stable?: boolean; type?: CellType } = {},
): ParsedCell {
  return {
    index,
    id,
    hasStableId: opts.stable ?? true,
    cellType: opts.type ?? 'code',
    source,
  };
}

describe('notebookDiffer.computeNotebookChanges', () => {
  it('marks every current line as added when the base notebook is missing', () => {
    const current = notebook([cell(0, 'a', 'x = 1\ny = 2')]);

    const changes = computeNotebookChanges(null, current);

    expect(changes.get('a')).toEqual([
      { line: 0, type: 'added' },
      { line: 1, type: 'added' },
    ]);
  });

  it('anchors a deleted whole cell on the next surviving cell', () => {
    const base = notebook([
      cell(0, 'a', 'keep = 1'),
      cell(1, 'deleted', 'gone = 2'),
      cell(2, 'b', 'keep = 3'),
    ]);
    const current = notebook([
      cell(0, 'a', 'keep = 1'),
      cell(1, 'b', 'keep = 3'),
    ]);

    const changes = computeNotebookChanges(base, current);

    expect(changes.get('a')).toEqual([]);
    expect(changes.get('b')).toEqual([{ line: 0, type: 'deleted' }]);
  });

  it('anchors a trailing deleted whole cell on the previous surviving cell', () => {
    const base = notebook([
      cell(0, 'a', 'keep = 1\nstill_here = 2'),
      cell(1, 'deleted', 'gone = 2'),
    ]);
    const current = notebook([cell(0, 'a', 'keep = 1\nstill_here = 2')]);

    const changes = computeNotebookChanges(base, current);

    expect(changes.get('a')).toEqual([{ line: 1, type: 'deleted' }]);
  });

  it('combines line diffs with deleted whole-cell anchors', () => {
    const base = notebook([
      cell(0, 'a', 'x = 1'),
      cell(1, 'deleted', 'gone = 2'),
      cell(2, 'b', 'y = 2'),
    ]);
    const current = notebook([
      cell(0, 'a', 'x = 10'),
      cell(1, 'b', 'y = 2'),
    ]);

    const changes = computeNotebookChanges(base, current);

    expect(changes.get('a')).toEqual([{ line: 0, type: 'modified' }]);
    expect(changes.get('b')).toEqual([{ line: 0, type: 'deleted' }]);
  });
});
