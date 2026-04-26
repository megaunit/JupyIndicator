import { describe, it, expect } from 'vitest';
import { RawLineChange, diffCellSources, allLinesAdded } from '../src/cellDiffer';

function compact(changes: RawLineChange[]) {
  return changes.map(({ line, type, changeId }) => ({ line, type, changeId }));
}

function changeCount(changes: RawLineChange[]): number {
  return new Set(changes.map((change) => change.changeId)).size;
}

describe('cellDiffer.diffCellSources', () => {
  it('reports no changes for identical sources', () => {
    const r = diffCellSources('a\nb\nc\n', 'a\nb\nc\n');
    expect(compact(r)).toEqual([]);
  });

  it('marks pure insertions as added', () => {
    const r = diffCellSources('a\nc\n', 'a\nb\nc\n');
    expect(compact(r)).toEqual([{ line: 1, type: 'added', changeId: 0 }]);
  });

  it('marks paired remove+add of equal size as modified', () => {
    const r = diffCellSources('a\nOLD\nc\n', 'a\nNEW\nc\n');
    expect(compact(r)).toEqual([{ line: 1, type: 'modified', changeId: 0 }]);
  });

  it('reports surplus added lines as added on top of modification', () => {
    const r = diffCellSources('a\nOLD\nc\n', 'a\nNEW1\nNEW2\nc\n');
    expect(compact(r)).toEqual([
      { line: 1, type: 'modified', changeId: 0 },
      { line: 2, type: 'added', changeId: 0 },
    ]);
    expect(changeCount(r)).toBe(1);
  });

  it('reports surplus removed lines as a deleted marker after the modification', () => {
    const r = diffCellSources('a\nOLD1\nOLD2\nc\n', 'a\nNEW\nc\n');
    expect(compact(r)).toEqual([
      { line: 1, type: 'modified', changeId: 0 },
      { line: 2, type: 'deleted', changeId: 0 }, // anchored on line `c`
    ]);
    expect(changeCount(r)).toBe(1);
  });

  it('marks both resulting lines as one modified change when a line is split', () => {
    const r = diffCellSources(
      'const value = computeThing();',
      'const value =\n computeThing();',
    );
    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'modified', changeId: 0 },
    ]);
    expect(changeCount(r)).toBe(1);
    expect(r[0].group).toMatchObject({
      id: 0,
      oldStartLine: 0,
      oldLineCount: 1,
      newStartLine: 0,
      newLineCount: 2,
      markerStartLine: 0,
      markerLineCount: 2,
    });
  });

  it('marks both resulting lines as modified when an already changed line is split', () => {
    const r = diffCellSources('value = 1', 'value =\n 2');
    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'modified', changeId: 0 },
    ]);
    expect(changeCount(r)).toBe(1);
  });

  it('counts adjacent modified lines as one change', () => {
    const r = diffCellSources('a\nb\nc\n', 'A\nB\nc\n');
    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'modified', changeId: 0 },
    ]);
    expect(changeCount(r)).toBe(1);
  });

  it('keeps non-touching modified lines as separate changes', () => {
    const r = diffCellSources('a\nkeep\nb\n', 'A\nkeep\nB\n');
    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 2, type: 'modified', changeId: 1 },
    ]);
    expect(changeCount(r)).toBe(2);
  });

  it('marks a lone deletion in the middle as a marker on the line that follows', () => {
    const r = diffCellSources('a\nb\nc\n', 'a\nc\n');
    expect(compact(r)).toEqual([{ line: 1, type: 'deleted', changeId: 0 }]);
  });

  it('falls back to previous line when deletion is at end of cell', () => {
    // Removed last line with no following content.
    const r = diffCellSources('a\nb\n', 'a\n');
    // Only one line remains ('a'), so marker lands on line 0.
    expect(compact(r)).toEqual([{ line: 0, type: 'deleted', changeId: 0 }]);
  });

  it('handles an empty new cell (everything removed)', () => {
    const r = diffCellSources('a\nb\n', '');
    expect(compact(r)).toEqual([{ line: 0, type: 'deleted', changeId: 0 }]);
  });

  it('handles an empty old cell (all added)', () => {
    const r = diffCellSources('', 'a\nb\n');
    expect(compact(r)).toEqual([
      { line: 0, type: 'added', changeId: 0 },
      { line: 1, type: 'added', changeId: 0 },
      { line: 2, type: 'added', changeId: 0 },
    ]);
    expect(changeCount(r)).toBe(1);
  });

  it('returns line numbers 0-based in the new content', () => {
    const r = diffCellSources('x\n', 'x\ny\n');
    expect(compact(r)).toEqual([{ line: 1, type: 'added', changeId: 0 }]);
  });
});

describe('cellDiffer: edit-then-Enter consistency', () => {
  it('typing characters then pressing Enter at line end: edit is modified, new line is added', () => {
    // The "type then Enter" gesture should always classify the freshly
    // pressed-Enter line as `added`, regardless of how many characters
    // were typed first. Before the fix this was inconsistent: short
    // typings tipped past the split-similarity threshold and caused both
    // resulting lines to be tagged `modified`.
    const shortType = diffCellSources('foo\n', 'fooX\n\n');
    expect(compact(shortType)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'added', changeId: 0 },
    ]);

    const longType = diffCellSources('foo\n', 'fooBAR\n\n');
    expect(compact(longType)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'added', changeId: 0 },
    ]);
  });

  it('keeps auto-indented blanks added after typing characters and pressing Enter', () => {
    const spaces = diffCellSources('    foo\n', '    fooX\n    \n');
    expect(compact(spaces)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'added', changeId: 0 },
    ]);

    const tab = diffCellSources('    foo\n', '    fooX\n\t\n');
    expect(compact(tab)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'added', changeId: 0 },
    ]);
  });

  it('keeps indented blank fragments inside a split line modified', () => {
    const r = diffCellSources(
      "    'talk.religion.misc',",
      "    'talk\n    \n    .religion.misc',",
    );

    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'modified', changeId: 0 },
      { line: 2, type: 'modified', changeId: 0 },
    ]);
  });

  it('pressing Enter at the end of a no-trailing-newline last line is not a modification', () => {
    const r = diffCellSources('foo', 'foo\n');
    expect(compact(r)).toEqual([
      { line: 1, type: 'added', changeId: 0 },
    ]);
  });

  it('pressing Enter twice at end (with a non-trailing-newline source) adds both blank lines', () => {
    const r = diffCellSources('foo', 'foo\n\n');
    expect(compact(r)).toEqual([
      { line: 1, type: 'added', changeId: 0 },
      { line: 2, type: 'added', changeId: 0 },
    ]);
  });

  it('pressing Enter then typing content and pressing Enter again is a pure addition', () => {
    const r = diffCellSources('foo', 'foo\nNEW\n');
    expect(compact(r)).toEqual([
      { line: 1, type: 'added', changeId: 0 },
      { line: 2, type: 'added', changeId: 0 },
    ]);
  });

  it('still treats an in-place split (joined-equals-old) as both lines modified', () => {
    // Regression guard for the existing split behaviour — must keep both
    // lines blue when the user just splits an existing line.
    const r = diffCellSources('hello world\n', 'hello\n world\n');
    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'modified', changeId: 0 },
    ]);
  });

  it('keeps a split through inserted blank lines as one modified line split', () => {
    const r = diffCellSources(
      [
        'clf = MultinomialNB()',
        'clf.fit(X_train, y_train)',
        '',
        'y_pred = clf.predict(X_test)',
      ].join('\n'),
      [
        'clf = MultinomialNB()',
        'clf.fit(X_train,',
        '',
        ' y_train)',
        '',
        'y_pred = clf.predict(X_test)',
      ].join('\n'),
    );

    expect(compact(r)).toEqual([
      { line: 1, type: 'modified', changeId: 0 },
      { line: 2, type: 'modified', changeId: 0 },
      { line: 3, type: 'modified', changeId: 0 },
    ]);
  });

  it('marks split one-line function calls as modified, not added', () => {
    const r = diffCellSources(
      'print(classification_report(y_test, y_pred, target_names=train.target_names))',
      'print(classification_report(y_test, y_pred,\n target_names=train.target_names))',
    );

    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'modified', changeId: 0 },
    ]);
  });

  it('marks heavily split auto-indented notebook category strings as modified', () => {
    const oldSrc = [
      'categories = [',
      "    'alt.atheism',",
      "    'talk.religion.misc',",
      "    'comp.graphics',",
      "    'sci.space',",
      "    'rec.autos',",
      ']',
    ].join('\n');
    const newSrc = [
      'categories = [',
      "    'alt.atheism',",
      "    'ta",
      '    l',
      '    k',
      '    .',
      '    reli',
      '    gion',
      '    .',
      '    mis',
      "    c',",
      "    'comp.graphics',",
      "    'sci.space',",
      "    'rec.autos',",
      ']',
    ].join('\n');

    expect(compact(diffCellSources(oldSrc, newSrc))).toEqual([
      { line: 2, type: 'modified', changeId: 0 },
      { line: 3, type: 'modified', changeId: 0 },
      { line: 4, type: 'modified', changeId: 0 },
      { line: 5, type: 'modified', changeId: 0 },
      { line: 6, type: 'modified', changeId: 0 },
      { line: 7, type: 'modified', changeId: 0 },
      { line: 8, type: 'modified', changeId: 0 },
      { line: 9, type: 'modified', changeId: 0 },
      { line: 10, type: 'modified', changeId: 0 },
    ]);
  });

  it('marks only the split lines modified in a cell with duplicate lines and blanks', () => {
    const r = diffCellSources(
      'fdsafdsa\nfdsafs\nfdsafs\n\n\n\n',
      'fdsa\nfdsa\nfdsafs\nfdsafs\n\n\n\n',
    );

    expect(compact(r)).toEqual([
      { line: 0, type: 'modified', changeId: 0 },
      { line: 1, type: 'modified', changeId: 0 },
    ]);
  });
});

describe('cellDiffer.allLinesAdded', () => {
  it('returns empty for empty source', () => {
    expect(allLinesAdded('')).toEqual([]);
  });

  it('returns one added change per line', () => {
    const r = allLinesAdded('a\nb\nc');
    expect(compact(r)).toEqual([
      { line: 0, type: 'added', changeId: 0 },
      { line: 1, type: 'added', changeId: 0 },
      { line: 2, type: 'added', changeId: 0 },
    ]);
    expect(changeCount(r)).toBe(1);
  });
});
