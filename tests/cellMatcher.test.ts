import { describe, it, expect } from 'vitest';
import { matchCells } from '../src/cellMatcher';
import { ParsedCell, CellType } from '../src/types';

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

describe('cellMatcher', () => {
  it('matches cells by stable id', () => {
    const base = [cell(0, 'a', 'x=1'), cell(1, 'b', 'y=2')];
    const current = [cell(0, 'a', 'x=1'), cell(1, 'b', 'y=2')];
    const { pairs, addedCurrent, deletedBase } = matchCells(base, current);
    expect(pairs).toHaveLength(2);
    expect(addedCurrent).toHaveLength(0);
    expect(deletedBase).toHaveLength(0);
    expect(pairs.find((p) => p.current.id === 'a')?.base.id).toBe('a');
    expect(pairs.find((p) => p.current.id === 'b')?.base.id).toBe('b');
  });

  it('matches cells by stable id even when one has edits', () => {
    const base = [cell(0, 'a', 'x=1'), cell(1, 'b', 'y=2')];
    const current = [cell(0, 'a', 'x=1\nprint(x)'), cell(1, 'b', 'y=2')];
    const { pairs } = matchCells(base, current);
    expect(pairs.find((p) => p.current.id === 'a')?.base.source).toBe('x=1');
  });

  it('reports unmatched current cells as added', () => {
    const base = [cell(0, 'a', 'x=1')];
    const current = [cell(0, 'a', 'x=1'), cell(1, 'new', 'z=3')];
    const { pairs, addedCurrent } = matchCells(base, current);
    expect(pairs).toHaveLength(1);
    expect(addedCurrent).toHaveLength(1);
    expect(addedCurrent[0].id).toBe('new');
  });

  it('reports unmatched base cells as deleted', () => {
    const base = [cell(0, 'a', 'x=1'), cell(1, 'gone', 'removed_code')];
    const current = [cell(0, 'a', 'x=1')];
    const { pairs, deletedBase } = matchCells(base, current);
    expect(pairs).toHaveLength(1);
    expect(deletedBase).toHaveLength(1);
    expect(deletedBase[0].id).toBe('gone');
  });

  it('matches cells across reordering via stable id', () => {
    const base = [cell(0, 'a', 'x=1'), cell(1, 'b', 'y=2'), cell(2, 'c', 'z=3')];
    const current = [cell(0, 'c', 'z=3'), cell(1, 'a', 'x=1'), cell(2, 'b', 'y=2')];
    const { pairs, addedCurrent, deletedBase } = matchCells(base, current);
    expect(pairs).toHaveLength(3);
    expect(addedCurrent).toHaveLength(0);
    expect(deletedBase).toHaveLength(0);
  });

  it('matches cells without stable id by exact source when types agree', () => {
    const base = [cell(0, 'x', 'a=1', { stable: false }), cell(1, 'y', 'b=2', { stable: false })];
    const current = [
      cell(0, 'different', 'b=2', { stable: false }), // matches base[1] by source
      cell(1, 'also-diff', 'a=1', { stable: false }), // matches base[0] by source
    ];
    const { pairs } = matchCells(base, current);
    expect(pairs).toHaveLength(2);
    const pA = pairs.find((p) => p.current.source === 'a=1');
    const pB = pairs.find((p) => p.current.source === 'b=2');
    expect(pA?.base.source).toBe('a=1');
    expect(pB?.base.source).toBe('b=2');
  });

  it('matches cells without stable id by similarity when above threshold', () => {
    const base = [
      cell(0, 'x', 'def f():\n    return 1\n    # comment\n', { stable: false }),
    ];
    const current = [
      cell(0, 'y', 'def f():\n    return 2\n    # comment\n', { stable: false }),
    ];
    const { pairs } = matchCells(base, current);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].current.source).toContain('return 2');
    expect(pairs[0].base.source).toContain('return 1');
  });

  it('does not match cells that are too dissimilar', () => {
    const base = [cell(0, 'x', 'foo bar baz', { stable: false })];
    const current = [cell(0, 'y', 'entirely different content here', { stable: false })];
    const { pairs, addedCurrent, deletedBase } = matchCells(base, current);
    expect(pairs).toHaveLength(0);
    expect(addedCurrent).toHaveLength(1);
    expect(deletedBase).toHaveLength(1);
  });

  it('does not pair cells of different cellType even when source matches', () => {
    const base = [cell(0, 'a', '# Heading', { stable: false, type: 'markdown' })];
    const current = [cell(0, 'b', '# Heading', { stable: false, type: 'code' })];
    const { pairs, addedCurrent, deletedBase } = matchCells(base, current);
    expect(pairs).toHaveLength(0);
    expect(addedCurrent).toHaveLength(1);
    expect(deletedBase).toHaveLength(1);
  });

  it('handles a split cell (one base → two current halves)', () => {
    // Simulates: base cell "line1\nline2\nline3" was split into
    // current[0]="line1\nline2" and current[1]="line3".
    const base = [cell(0, 'x', 'line1\nline2\nline3\n', { stable: false })];
    const current = [
      cell(0, 'y1', 'line1\nline2\n', { stable: false }),
      cell(1, 'y2', 'line3\n', { stable: false }),
    ];
    const { pairs, addedCurrent } = matchCells(base, current);
    // The better-Jaccard half wins the match; the other is reported as added.
    expect(pairs).toHaveLength(1);
    expect(addedCurrent).toHaveLength(1);
    expect(pairs[0].base.id).toBe('x');
  });
});
