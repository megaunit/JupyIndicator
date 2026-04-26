import * as crypto from 'crypto';
import { diffChars } from 'diff';
import { ParsedCell } from './types';

export interface CellPair {
  base: ParsedCell;
  current: ParsedCell;
}

export interface MatchResult {
  pairs: CellPair[];
  /** Cells present in `current` but unmatched — newly added. */
  addedCurrent: ParsedCell[];
  /** Cells present in `base` but unmatched — deleted. */
  deletedBase: ParsedCell[];
}

/**
 * Similarity threshold below which unmatched cells are left unpaired rather
 * than reported as a modification.
 */
const SIMILARITY_THRESHOLD = 0.4;

export function matchCells(baseCells: ParsedCell[], currentCells: ParsedCell[]): MatchResult {
  const pairs: CellPair[] = [];
  const baseTaken = new Set<number>();
  const currentTaken = new Set<number>();

  // Phase 1: stable id on both sides.
  const baseById = new Map<string, ParsedCell>();
  for (const c of baseCells) {
    if (c.hasStableId) baseById.set(c.id, c);
  }
  for (const cur of currentCells) {
    if (!cur.hasStableId) continue;
    const base = baseById.get(cur.id);
    if (base && !baseTaken.has(base.index) && base.cellType === cur.cellType) {
      pairs.push({ base, current: cur });
      baseTaken.add(base.index);
      currentTaken.add(cur.index);
    }
  }

  // Phase 2: exact-source match (same cellType, same source). Prefer the
  // nearest-by-index candidate so reordered duplicates still align sensibly.
  const baseByHash = new Map<string, ParsedCell[]>();
  for (const c of baseCells) {
    if (baseTaken.has(c.index)) continue;
    const key = exactKey(c);
    const list = baseByHash.get(key);
    if (list) list.push(c);
    else baseByHash.set(key, [c]);
  }
  for (const cur of currentCells) {
    if (currentTaken.has(cur.index)) continue;
    const key = exactKey(cur);
    const candidates = baseByHash.get(key);
    if (!candidates || candidates.length === 0) continue;
    candidates.sort(
      (a, b) => Math.abs(a.index - cur.index) - Math.abs(b.index - cur.index),
    );
    const base = candidates.shift()!;
    pairs.push({ base, current: cur });
    baseTaken.add(base.index);
    currentTaken.add(cur.index);
  }

  // Phase 3: similarity match over remaining cells of the same type.
  // Greedy: rank all (current, base) pairs by source similarity, take the best.
  // Character similarity is included because a one-line cell split into two
  // lines has a very low line-set Jaccard score but is still the same cell.
  const remainingBase = baseCells.filter((c) => !baseTaken.has(c.index));
  const remainingCurrent = currentCells.filter((c) => !currentTaken.has(c.index));

  interface Candidate {
    current: ParsedCell;
    base: ParsedCell;
    score: number;
  }
  const candidates: Candidate[] = [];
  const baseLineSets = new Map<number, Set<string>>();
  for (const b of remainingBase) {
    baseLineSets.set(b.index, nonBlankLineSet(b.source));
  }
  for (const cur of remainingCurrent) {
    const curSet = nonBlankLineSet(cur.source);
    for (const base of remainingBase) {
      if (base.cellType !== cur.cellType) continue;
      const score = sourceSimilarity(
        cur.source,
        base.source,
        curSet,
        baseLineSets.get(base.index)!,
      );
      if (score >= SIMILARITY_THRESHOLD) {
        candidates.push({ current: cur, base, score });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.current.index - a.base.index) - Math.abs(b.current.index - b.base.index),
  );
  for (const cand of candidates) {
    if (baseTaken.has(cand.base.index) || currentTaken.has(cand.current.index)) continue;
    pairs.push({ base: cand.base, current: cand.current });
    baseTaken.add(cand.base.index);
    currentTaken.add(cand.current.index);
  }

  return {
    pairs,
    addedCurrent: currentCells.filter((c) => !currentTaken.has(c.index)),
    deletedBase: baseCells.filter((c) => !baseTaken.has(c.index)),
  };
}

function exactKey(c: ParsedCell): string {
  const h = crypto.createHash('sha1').update(c.source).digest('hex');
  return `${c.cellType}|${h}`;
}

function nonBlankLineSet(source: string): Set<string> {
  const set = new Set<string>();
  for (const raw of source.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) set.add(trimmed);
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sourceSimilarity(
  a: string,
  b: string,
  aLineSet = nonBlankLineSet(a),
  bLineSet = nonBlankLineSet(b),
): number {
  return Math.max(jaccard(aLineSet, bLineSet), characterSimilarity(a, b));
}

function characterSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;

  let unchanged = 0;
  for (const change of diffChars(a, b)) {
    if (!change.added && !change.removed) unchanged += change.value.length;
  }
  return unchanged / longest;
}
