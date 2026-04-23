import { diffLines, type Change } from 'diff';
import { ChangeType } from './types';

export interface RawLineChange {
  line: number;
  type: ChangeType;
}

/**
 * Compute line-level changes between two cell sources. Output line numbers
 * are 0-based positions in `newSrc`.
 *
 * Classification rules:
 *   - A `removed` hunk immediately followed by an `added` hunk → up to
 *     `min(rm, ad)` lines of `modified`; the surplus on either side becomes
 *     `added` or `deleted`.
 *   - A lone `added` hunk → `added`.
 *   - A lone `removed` hunk → one `deleted` marker on the line that follows
 *     the deletion in `newSrc`. If the deletion is at the end, fall back to
 *     the last line of `newSrc`.
 */
export function diffCellSources(oldSrc: string, newSrc: string): RawLineChange[] {
  const result: RawLineChange[] = [];
  const changes = diffLines(oldSrc, newSrc);
  let newLine = 0;

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.added) {
      // A lone `added` — any `added` that was paired with a preceding
      // `removed` is consumed inside the removed branch below.
      for (let j = 0; j < c.count; j++) {
        result.push({ line: newLine + j, type: 'added' });
      }
      newLine += c.count;
      continue;
    }
    if (c.removed) {
      const next: Change | undefined = changes[i + 1];
      if (next && next.added) {
        const rm = c.count;
        const ad = next.count;
        const modCount = Math.min(rm, ad);
        for (let j = 0; j < modCount; j++) {
          result.push({ line: newLine + j, type: 'modified' });
        }
        if (ad > rm) {
          for (let j = modCount; j < ad; j++) {
            result.push({ line: newLine + j, type: 'added' });
          }
        } else if (rm > ad) {
          // Surplus removed lines → one deletion marker anchored at the line
          // following the paired modification. Clamped to cell length later.
          result.push({ line: newLine + modCount, type: 'deleted' });
        }
        newLine += ad;
        i++; // consumed the paired added hunk
        continue;
      }
      // Lone removed: anchor the marker on the next line in `newSrc`.
      result.push({ line: newLine, type: 'deleted' });
      continue;
    }
    // unchanged
    newLine += c.count;
  }

  // Clamp any deletion markers that landed past end of cell onto the previous
  // line (fallback when the deletion is at the very end of the cell).
  const totalNew = newLine;
  for (const r of result) {
    if (r.type === 'deleted' && r.line >= totalNew) {
      r.line = totalNew > 0 ? totalNew - 1 : 0;
    }
  }

  return result;
}

/** Returns a list of `added` changes covering every line in `source`. */
export function allLinesAdded(source: string): RawLineChange[] {
  if (source.length === 0) return [];
  const count = source.split('\n').length;
  const changes: RawLineChange[] = [];
  for (let i = 0; i < count; i++) changes.push({ line: i, type: 'added' });
  return changes;
}
