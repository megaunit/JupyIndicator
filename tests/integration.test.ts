import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseNotebook } from '../src/notebookParser';
import { matchCells } from '../src/cellMatcher';
import { RawLineChange, diffCellSources } from '../src/cellDiffer';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function compact(changes: RawLineChange[]) {
  return changes.map(({ line, type, changeId }) => ({ line, type, changeId }));
}

describe('integration: parse → match → diff', () => {
  it('detects a one-line modification in cell-a between basic and basic_modified', () => {
    const base = parseNotebook(fixture('basic.ipynb'));
    const current = parseNotebook(fixture('basic_modified.ipynb'));

    const { pairs, addedCurrent, deletedBase } = matchCells(base.cells, current.cells);
    expect(pairs).toHaveLength(3);
    expect(addedCurrent).toHaveLength(0);
    expect(deletedBase).toHaveLength(0);

    const cellA = pairs.find((p) => p.current.id === 'cell-a')!;
    const changes = diffCellSources(cellA.base.source, cellA.current.source);
    // Only the middle line changed: `y = 2` → `y = 3`.
    expect(compact(changes)).toEqual([{ line: 1, type: 'modified', changeId: 0 }]);

    // Untouched cells yield no changes.
    const cellB = pairs.find((p) => p.current.id === 'cell-b')!;
    expect(compact(diffCellSources(cellB.base.source, cellB.current.source))).toEqual([]);
    const cellC = pairs.find((p) => p.current.id === 'cell-c')!;
    expect(compact(diffCellSources(cellC.base.source, cellC.current.source))).toEqual([]);
  });
});
