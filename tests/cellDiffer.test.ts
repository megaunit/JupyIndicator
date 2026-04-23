import { describe, it, expect } from 'vitest';
import { diffCellSources, allLinesAdded } from '../src/cellDiffer';

describe('cellDiffer.diffCellSources', () => {
  it('reports no changes for identical sources', () => {
    const r = diffCellSources('a\nb\nc\n', 'a\nb\nc\n');
    expect(r).toEqual([]);
  });

  it('marks pure insertions as added', () => {
    const r = diffCellSources('a\nc\n', 'a\nb\nc\n');
    expect(r).toEqual([{ line: 1, type: 'added' }]);
  });

  it('marks paired remove+add of equal size as modified', () => {
    const r = diffCellSources('a\nOLD\nc\n', 'a\nNEW\nc\n');
    expect(r).toEqual([{ line: 1, type: 'modified' }]);
  });

  it('reports surplus added lines as added on top of modification', () => {
    const r = diffCellSources('a\nOLD\nc\n', 'a\nNEW1\nNEW2\nc\n');
    expect(r).toEqual([
      { line: 1, type: 'modified' },
      { line: 2, type: 'added' },
    ]);
  });

  it('reports surplus removed lines as a deleted marker after the modification', () => {
    const r = diffCellSources('a\nOLD1\nOLD2\nc\n', 'a\nNEW\nc\n');
    expect(r).toEqual([
      { line: 1, type: 'modified' },
      { line: 2, type: 'deleted' }, // anchored on line `c`
    ]);
  });

  it('marks a lone deletion in the middle as a marker on the line that follows', () => {
    const r = diffCellSources('a\nb\nc\n', 'a\nc\n');
    expect(r).toEqual([{ line: 1, type: 'deleted' }]);
  });

  it('falls back to previous line when deletion is at end of cell', () => {
    // Removed last line with no following content.
    const r = diffCellSources('a\nb\n', 'a\n');
    // Only one line remains ('a'), so marker lands on line 0.
    expect(r).toEqual([{ line: 0, type: 'deleted' }]);
  });

  it('handles an empty new cell (everything removed)', () => {
    const r = diffCellSources('a\nb\n', '');
    expect(r).toEqual([{ line: 0, type: 'deleted' }]);
  });

  it('handles an empty old cell (all added)', () => {
    const r = diffCellSources('', 'a\nb\n');
    expect(r).toEqual([
      { line: 0, type: 'added' },
      { line: 1, type: 'added' },
    ]);
  });

  it('returns line numbers 0-based in the new content', () => {
    const r = diffCellSources('x\n', 'x\ny\n');
    expect(r).toEqual([{ line: 1, type: 'added' }]);
  });
});

describe('cellDiffer.allLinesAdded', () => {
  it('returns empty for empty source', () => {
    expect(allLinesAdded('')).toEqual([]);
  });

  it('returns one added change per line', () => {
    const r = allLinesAdded('a\nb\nc');
    expect(r).toEqual([
      { line: 0, type: 'added' },
      { line: 1, type: 'added' },
      { line: 2, type: 'added' },
    ]);
  });
});
