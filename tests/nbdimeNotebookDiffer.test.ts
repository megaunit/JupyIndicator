import { describe, expect, it } from 'vitest';
import { RawLineChange } from '../src/cellDiffer';
import { computeNotebookChangesFromNbdimeDiff } from '../src/nbdimeNotebookDiffer';
import { NbdimeDiff } from '../src/nbdimeTypes';

function compact(changes: RawLineChange[] | undefined) {
  return (changes ?? []).map(({ line, type, changeId }) => ({ line, type, changeId }));
}

function notebook(cells: { id: string; source: string[]; type?: string }[]): string {
  return JSON.stringify({
    cells: cells.map((cell) => ({
      cell_type: cell.type ?? 'code',
      metadata: { id: cell.id },
      source: cell.source,
    })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

describe('nbdimeNotebookDiffer.computeNotebookChangesFromNbdimeDiff', () => {
  it('uses nbdime source patches to produce modified, added, and deleted source markers', () => {
    const oldRaw = notebook([{ id: 'cell-a', source: ['a\n', 'b\n', 'c\n', 'd'] }]);
    const newRaw = notebook([{ id: 'cell-a', source: ['a\n', 'B\n', 'x\n', 'c'] }]);
    const diff: NbdimeDiff = [{
      op: 'patch',
      key: 'cells',
      diff: [{
        op: 'patch',
        key: 0,
        diff: [{ op: 'patch', key: 'source', diff: [{ op: 'patch', key: 1, diff: [] }] }],
      }],
    }];

    const changes = computeNotebookChangesFromNbdimeDiff(diff, oldRaw, newRaw);

    expect(compact(changes.get('cell-a'))).toEqual([
      { line: 1, type: 'modified', changeId: 0 },
      { line: 2, type: 'added', changeId: 0 },
      { line: 3, type: 'deleted', changeId: 0 },
    ]);
  });

  it('marks nbdime-added cells as added', () => {
    const oldRaw = notebook([{ id: 'a', source: ['a = 1'] }]);
    const newRaw = notebook([
      { id: 'a', source: ['a = 1'] },
      { id: 'b', source: ['b = 2\n', 'print(b)'] },
    ]);
    const diff: NbdimeDiff = [{
      op: 'patch',
      key: 'cells',
      diff: [{ op: 'addrange', key: 1, valuelist: [{ source: ['b = 2\n', 'print(b)'] }] }],
    }];

    const changes = computeNotebookChangesFromNbdimeDiff(diff, oldRaw, newRaw);

    expect(compact(changes.get('b'))).toEqual([
      { line: 0, type: 'added', changeId: 0 },
      { line: 1, type: 'added', changeId: 0 },
    ]);
  });

  it('anchors nbdime-deleted cells on the next surviving cell', () => {
    const oldRaw = notebook([
      { id: 'a', source: ['keep = 1'] },
      { id: 'deleted', source: ['gone = 2'] },
      { id: 'b', source: ['after = 3'] },
    ]);
    const newRaw = notebook([
      { id: 'a', source: ['keep = 1'] },
      { id: 'b', source: ['after = 3'] },
    ]);
    const diff: NbdimeDiff = [{
      op: 'patch',
      key: 'cells',
      diff: [{ op: 'removerange', key: 1, length: 1 }],
    }];

    const changes = computeNotebookChangesFromNbdimeDiff(diff, oldRaw, newRaw);

    expect(compact(changes.get('b'))).toEqual([
      { line: 0, type: 'deleted', changeId: 0 },
    ]);
  });

  it('ignores nbdime metadata-only cell patches', () => {
    const oldRaw = notebook([{ id: 'a', source: ['a = 1'] }]);
    const newRaw = notebook([{ id: 'a', source: ['a = 1'] }]);
    const diff: NbdimeDiff = [{
      op: 'patch',
      key: 'cells',
      diff: [{
        op: 'patch',
        key: 0,
        diff: [{ op: 'patch', key: 'metadata', diff: [{ op: 'add', key: 'tags', value: [] }] }],
      }],
    }];

    const changes = computeNotebookChangesFromNbdimeDiff(diff, oldRaw, newRaw);

    expect([...changes.values()].flat()).toEqual([]);
  });
});
