import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseNotebook } from '../src/notebookParser';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('notebookParser', () => {
  it('parses a well-formed notebook with stable ids', () => {
    const nb = parseNotebook(fixture('basic.ipynb'));
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[0].id).toBe('cell-a');
    expect(nb.cells[0].hasStableId).toBe(true);
    expect(nb.cells[0].cellType).toBe('code');
    expect(nb.cells[0].source).toBe('x = 1\ny = 2\nprint(x + y)');
    expect(nb.cells[1].cellType).toBe('markdown');
    expect(nb.cells[1].source).toBe('# Heading\n\nSome text.');
  });

  it('accepts source as either string or string[]', () => {
    const nb = parseNotebook(fixture('basic.ipynb'));
    expect(nb.cells[0].source).toBe('x = 1\ny = 2\nprint(x + y)'); // array
    expect(nb.cells[1].source).toBe('# Heading\n\nSome text.'); // string
  });

  it('synthesizes ids when metadata.id is missing', () => {
    const nb = parseNotebook(fixture('no_ids.ipynb'));
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0].hasStableId).toBe(false);
    expect(nb.cells[0].id).toMatch(/^synth-0-/);
    expect(nb.cells[1].id).toMatch(/^synth-1-/);
    // Different cells get different synthesized ids.
    expect(nb.cells[0].id).not.toBe(nb.cells[1].id);
  });

  it('returns empty notebook for invalid JSON', () => {
    const nb = parseNotebook('not json');
    expect(nb.cells).toHaveLength(0);
  });

  it('returns empty notebook for null / empty input', () => {
    expect(parseNotebook(null).cells).toHaveLength(0);
    expect(parseNotebook(undefined).cells).toHaveLength(0);
    expect(parseNotebook('').cells).toHaveLength(0);
  });

  it('handles a notebook missing the cells array', () => {
    const nb = parseNotebook('{"nbformat":4,"nbformat_minor":5}');
    expect(nb.cells).toHaveLength(0);
  });
});
