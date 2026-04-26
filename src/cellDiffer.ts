import { diffChars, diffLines, type Change } from 'diff';
import { CellChangeGroup, ChangeType } from './types';

const EDITED_SPLIT_SIMILARITY_THRESHOLD = 0.6;

export interface RawLineChange {
  line: number;
  type: ChangeType;
  changeId: number;
  group: CellChangeGroup;
}

interface LineChangeLike {
  line: number;
  type: ChangeType;
  changeId: number;
  group: CellChangeGroup;
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
 *
 * Every returned line also carries a logical change group. Touching markers
 * share one `changeId`, so a split modified line (one old line becoming two
 * current lines) is represented as two blue markers but one logical change.
 */
export function diffCellSources(oldSrc: string, newSrc: string): RawLineChange[] {
  const simple = diffSingleContiguousChange(oldSrc, newSrc);
  if (simple !== null) return simple;

  const result: RawLineChange[] = [];
  const changes = diffLines(oldSrc, newSrc);
  let oldLine = 0;
  let newLine = 0;
  let nextChangeId = 0;

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const currentLineCount = changeLineCount(c);
    if (c.added) {
      // A lone `added` — any `added` that was paired with a preceding
      // `removed` is consumed inside the removed branch below.
      const addedLines = lineTokens(c.value);
      const group = createGroup(nextChangeId++, oldLine, 0, newLine, addedLines.length);
      const startLine = anchorAddedLines(newSrc, newLine, addedLines);
      for (let j = 0; j < addedLines.length; j++) {
        result.push(lineChange(startLine + j, 'added', group));
      }
      newLine += currentLineCount;
      continue;
    }
    if (c.removed) {
      const next: Change | undefined = changes[i + 1];
      const totalRm = currentLineCount;
      if (next && next.added) {
        const totalAd = changeLineCount(next);
        const removedLinesAll = lineTokens(c.value);
        const addedLinesAll = lineTokens(next.value);

        // diffLines reports a remove+add even for cases where most of the
        // content is identical line-by-line — e.g. when only the trailing
        // newline differs ('foo' → 'foo\n') or when the user pressed Enter
        // at the end of an existing line ('foo' → 'foo\nNEW\n'). Peeling
        // common prefix/suffix lines first lets the classifier focus only
        // on the genuinely changed slice.
        const { prefixCount, suffixCount } = commonAffixCounts(
          removedLinesAll,
          addedLinesAll,
        );
        const removedLines = removedLinesAll.slice(
          prefixCount,
          removedLinesAll.length - suffixCount,
        );
        const addedLines = addedLinesAll.slice(
          prefixCount,
          addedLinesAll.length - suffixCount,
        );
        const rm = removedLines.length;
        const ad = addedLines.length;
        const lineBase = newLine + prefixCount;
        const oldBase = oldLine + prefixCount;

        if (rm === 0 && ad === 0) {
          // Trailing-newline-only difference, or some other no-op slice.
          newLine += totalAd;
          oldLine += totalRm;
          i++;
          continue;
        }
        if (rm === 0) {
          // Pure addition once the unchanged prefix/suffix is removed —
          // e.g. typing content on a fresh line after pressing Enter.
          const group = createGroup(nextChangeId++, oldBase, 0, lineBase, ad);
          const startLine = anchorAddedLines(newSrc, lineBase, addedLines);
          for (let j = 0; j < ad; j++) {
            result.push(lineChange(startLine + j, 'added', group));
          }
          newLine += totalAd;
          oldLine += totalRm;
          i++;
          continue;
        }
        if (ad === 0) {
          const group = createGroup(nextChangeId++, oldBase, rm, lineBase, 0);
          result.push(lineChange(lineBase, 'deleted', group));
          newLine += totalAd;
          oldLine += totalRm;
          i++;
          continue;
        }

        // Trailing blank lines on the added side are "Enter at end"
        // additions — they must not be folded into the modification or
        // split heuristics, since visually they're the new empty line(s)
        // the user just created, not part of the line they edited.
        const trailingBlanks = countTrailingEnterBlanks(removedLines, addedLines);
        const coreAd = ad - trailingBlanks;
        const core = trailingBlanks === 0 ? addedLines : addedLines.slice(0, coreAd);

        const group = createGroup(nextChangeId++, oldBase, rm, lineBase, ad);
        const splitLines = splitLineModifiedLines(removedLines, core);
        if (splitLines) {
          for (const line of splitLines) {
            result.push(lineChange(lineBase + line, 'modified', group));
          }
        } else {
          const modCount = Math.min(rm, coreAd);
          for (let j = 0; j < modCount; j++) {
            result.push(lineChange(lineBase + j, 'modified', group));
          }
          if (coreAd > rm) {
            for (let j = modCount; j < coreAd; j++) {
              result.push(lineChange(lineBase + j, 'added', group));
            }
          } else if (rm > coreAd) {
            // Surplus removed lines → one deletion marker anchored at the
            // line following the paired modification. Clamped to cell
            // length later.
            result.push(lineChange(lineBase + modCount, 'deleted', group));
          }
        }
        for (let j = 0; j < trailingBlanks; j++) {
          result.push(lineChange(lineBase + coreAd + j, 'added', group));
        }
        newLine += totalAd;
        oldLine += totalRm;
        i++; // consumed the paired added hunk
        continue;
      }
      // Lone removed: anchor the marker on the next line in `newSrc`.
      const group = createGroup(nextChangeId++, oldLine, totalRm, newLine, 0);
      result.push(lineChange(newLine, 'deleted', group));
      oldLine += totalRm;
      continue;
    }
    // unchanged
    oldLine += currentLineCount;
    newLine += currentLineCount;
  }

  // Clamp any deletion markers that landed past end of cell onto the previous
  // line (fallback when the deletion is at the very end of the cell).
  const totalNew = newLine;
  for (const r of result) {
    if (r.type === 'deleted' && r.line >= totalNew) {
      r.line = totalNew > 0 ? totalNew - 1 : 0;
    }
  }

  return normalizeChangeGroups(result);
}

function diffSingleContiguousChange(
  oldSrc: string,
  newSrc: string,
): RawLineChange[] | null {
  const oldLines = visualLineTokens(oldSrc);
  const newLines = visualLineTokens(newSrc);
  const { prefixCount, suffixCount } = commonAffixCounts(oldLines, newLines);
  const removedLines = oldLines.slice(
    prefixCount,
    oldLines.length - suffixCount,
  );
  const addedLines = newLines.slice(
    prefixCount,
    newLines.length - suffixCount,
  );

  if (removedLines.length === 0 && addedLines.length === 0) return [];

  if (removedLines.length === 0) {
    if (prefixCount !== oldLines.length) return null;

    const group = createGroup(0, prefixCount, 0, prefixCount, addedLines.length);
    return normalizeChangeGroups(
      addedLines.map((_, j) => lineChange(prefixCount + j, 'added', group)),
    );
  }

  if (addedLines.length === 0) return null;
  if (removedLines.length !== 1 && addedLines.length !== 1) return null;

  const group = createGroup(
    0,
    prefixCount,
    removedLines.length,
    prefixCount,
    addedLines.length,
  );
  const result: RawLineChange[] = [];
  const trailingBlanks = countTrailingEnterBlanks(removedLines, addedLines);
  const coreAd = addedLines.length - trailingBlanks;
  const core = addedLines.slice(0, coreAd);
  const splitLines = splitLineModifiedLines(removedLines, core);

  if (splitLines) {
    for (const line of splitLines) {
      result.push(lineChange(prefixCount + line, 'modified', group));
    }
  } else {
    const modCount = Math.min(removedLines.length, coreAd);
    for (let j = 0; j < modCount; j++) {
      result.push(lineChange(prefixCount + j, 'modified', group));
    }
    if (coreAd > removedLines.length) {
      for (let j = modCount; j < coreAd; j++) {
        result.push(lineChange(prefixCount + j, 'added', group));
      }
    } else if (removedLines.length > coreAd) {
      result.push(lineChange(prefixCount + modCount, 'deleted', group));
    }
  }

  for (let j = 0; j < trailingBlanks; j++) {
    result.push(lineChange(prefixCount + coreAd + j, 'added', group));
  }
  return normalizeChangeGroups(result);
}

/** Returns a list of `added` changes covering every line in `source`. */
export function allLinesAdded(source: string): RawLineChange[] {
  if (source.length === 0) return [];
  const count = source.split('\n').length;
  const changes: RawLineChange[] = [];
  const group = createGroup(0, 0, 0, 0, count);
  for (let i = 0; i < count; i++) changes.push(lineChange(i, 'added', group));
  return normalizeChangeGroups(changes);
}

export function makeRawLineChange(
  line: number,
  type: ChangeType,
  range: Partial<
    Pick<CellChangeGroup, 'oldStartLine' | 'oldLineCount' | 'newStartLine' | 'newLineCount'>
  > = {},
): RawLineChange {
  const group = createGroup(
    0,
    range.oldStartLine ?? line,
    range.oldLineCount ?? (type === 'added' ? 0 : 1),
    range.newStartLine ?? line,
    range.newLineCount ?? (type === 'deleted' ? 0 : 1),
  );
  return normalizeChangeGroups([lineChange(line, type, group)])[0];
}

export function normalizeChangeGroups<T extends LineChangeLike>(changes: T[]): T[] {
  if (changes.length === 0) return [];

  const ordered = [...changes].sort(compareLineChanges);
  const groupInfos = buildGroupInfos(ordered);
  const mergedGroups = coalesceTouchingGroups(groupInfos);
  const replacement = new Map<CellChangeGroup, CellChangeGroup>();

  for (let id = 0; id < mergedGroups.length; id++) {
    const merged = mergedGroups[id];
    const group: CellChangeGroup = {
      id,
      oldStartLine: merged.oldStartLine,
      oldLineCount: merged.oldEndLine - merged.oldStartLine,
      newStartLine: merged.newStartLine,
      newLineCount: merged.newEndLine - merged.newStartLine,
      markerStartLine: merged.markerStartLine,
      markerLineCount: merged.markerEndLine - merged.markerStartLine + 1,
    };
    for (const member of merged.members) replacement.set(member, group);
  }

  return ordered.map((change) => {
    const group = replacement.get(change.group) ?? change.group;
    return { ...change, changeId: group.id, group };
  });
}

function commonAffixCounts(
  a: string[],
  b: string[],
): { prefixCount: number; suffixCount: number } {
  const max = Math.min(a.length, b.length);
  let prefixCount = 0;
  while (prefixCount < max && a[prefixCount] === b[prefixCount]) prefixCount++;
  let suffixCount = 0;
  const remaining = max - prefixCount;
  while (
    suffixCount < remaining &&
    a[a.length - 1 - suffixCount] === b[b.length - 1 - suffixCount]
  ) {
    suffixCount++;
  }
  return { prefixCount, suffixCount };
}

function lineTokens(source: string): string[] {
  if (source.length === 0) return [];
  const lines = source.split('\n');
  if (source.endsWith('\n')) lines.pop();
  return lines;
}

function visualLineTokens(source: string): string[] {
  if (source.length === 0) return [];
  return source.split('\n');
}

function changeLineCount(change: Change): number {
  return change.count ?? lineTokens(change.value).length;
}

function createGroup(
  id: number,
  oldStartLine: number,
  oldLineCount: number,
  newStartLine: number,
  newLineCount: number,
): CellChangeGroup {
  return {
    id,
    oldStartLine,
    oldLineCount,
    newStartLine,
    newLineCount,
    markerStartLine: newStartLine,
    markerLineCount: Math.max(1, newLineCount),
  };
}

function lineChange(
  line: number,
  type: ChangeType,
  group: CellChangeGroup,
): RawLineChange {
  return { line, type, changeId: group.id, group };
}

function anchorAddedLines(newSrc: string, hunkStartLine: number, addedLines: string[]): number {
  if (addedLines.length === 0 || !allSame(addedLines)) return hunkStartLine;

  const newLines = lineTokens(newSrc);
  const inserted = addedLines[0];
  let line = hunkStartLine;
  while (line > 0 && newLines[line - 1] === inserted) {
    line--;
  }
  return line;
}

function allSame(lines: string[]): boolean {
  return lines.every((line) => line === lines[0]);
}

function splitLineModifiedLines(
  removedLines: string[],
  addedLines: string[],
): number[] | null {
  if (removedLines.length !== 1 || addedLines.length < 2) return null;

  const oldLine = removedLines[0];
  const joinedNewLine = addedLines.join('');
  if (
    joinedNewLine !== oldLine &&
    lineSimilarity(oldLine, joinedNewLine) < EDITED_SPLIT_SIMILARITY_THRESHOLD
  ) {
    return null;
  }

  if (addedLines[0] === oldLine) {
    return lineIndexRange(1, addedLines.length);
  }
  if (addedLines[addedLines.length - 1] === oldLine) {
    return lineIndexRange(0, addedLines.length - 1);
  }
  return lineIndexRange(0, addedLines.length);
}

function countTrailingEnterBlanks(
  removedLines: string[],
  addedLines: string[],
): number {
  let trailingBlanks = 0;
  while (
    trailingBlanks < addedLines.length - 1 &&
    addedLines[addedLines.length - 1 - trailingBlanks] === ''
  ) {
    trailingBlanks++;
  }

  if (trailingBlanks > 0 && addedLines.length - trailingBlanks < removedLines.length) {
    return 0;
  }
  return trailingBlanks;
}

function lineSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;

  let unchanged = 0;
  for (const change of diffChars(a, b)) {
    if (!change.added && !change.removed) unchanged += change.value.length;
  }
  return unchanged / longest;
}

function lineIndexRange(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

interface GroupInfo {
  members: CellChangeGroup[];
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
  markerStartLine: number;
  markerEndLine: number;
}

function buildGroupInfos(changes: LineChangeLike[]): GroupInfo[] {
  const byGroup = new Map<CellChangeGroup, GroupInfo>();
  for (const change of changes) {
    const group = change.group;
    let info = byGroup.get(group);
    if (!info) {
      info = {
        members: [group],
        oldStartLine: group.oldStartLine,
        oldEndLine: group.oldStartLine + group.oldLineCount,
        newStartLine: group.newStartLine,
        newEndLine: group.newStartLine + group.newLineCount,
        markerStartLine: change.line,
        markerEndLine: change.line,
      };
      byGroup.set(group, info);
      continue;
    }
    info.oldStartLine = Math.min(info.oldStartLine, group.oldStartLine);
    info.oldEndLine = Math.max(info.oldEndLine, group.oldStartLine + group.oldLineCount);
    info.newStartLine = Math.min(info.newStartLine, group.newStartLine);
    info.newEndLine = Math.max(info.newEndLine, group.newStartLine + group.newLineCount);
    info.markerStartLine = Math.min(info.markerStartLine, change.line);
    info.markerEndLine = Math.max(info.markerEndLine, change.line);
  }

  return [...byGroup.values()].sort(compareGroupInfos);
}

function coalesceTouchingGroups(groups: GroupInfo[]): GroupInfo[] {
  const merged: GroupInfo[] = [];
  for (const group of groups) {
    const current = merged[merged.length - 1];
    if (current && group.markerStartLine <= current.markerEndLine + 1) {
      current.members.push(...group.members);
      current.oldStartLine = Math.min(current.oldStartLine, group.oldStartLine);
      current.oldEndLine = Math.max(current.oldEndLine, group.oldEndLine);
      current.newStartLine = Math.min(current.newStartLine, group.newStartLine);
      current.newEndLine = Math.max(current.newEndLine, group.newEndLine);
      current.markerStartLine = Math.min(current.markerStartLine, group.markerStartLine);
      current.markerEndLine = Math.max(current.markerEndLine, group.markerEndLine);
    } else {
      merged.push({ ...group, members: [...group.members] });
    }
  }
  return merged;
}

function compareLineChanges(a: LineChangeLike, b: LineChangeLike): number {
  return a.line - b.line || typeOrder(a.type) - typeOrder(b.type);
}

function compareGroupInfos(a: GroupInfo, b: GroupInfo): number {
  return (
    a.markerStartLine - b.markerStartLine ||
    a.markerEndLine - b.markerEndLine ||
    a.oldStartLine - b.oldStartLine ||
    a.newStartLine - b.newStartLine
  );
}

function typeOrder(type: ChangeType): number {
  switch (type) {
    case 'modified':
      return 0;
    case 'added':
      return 1;
    case 'deleted':
      return 2;
  }
}
