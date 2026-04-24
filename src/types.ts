export type CellType = 'code' | 'markdown' | 'raw';

export interface ParsedCell {
  /** `metadata.id` when present, otherwise a synthesized id stable within this parse. */
  id: string;
  /** Whether `id` came from nbformat `metadata.id` (stable across parses). */
  hasStableId: boolean;
  /** Cell position in the notebook, 0-based. */
  index: number;
  cellType: CellType;
  /** Cell source joined into one string. nbformat allows string or string[]; we normalize to string. */
  source: string;
}

export interface ParsedNotebook {
  nbformat: number;
  nbformatMinor: number;
  cells: ParsedCell[];
}

export type ChangeType = 'added' | 'modified' | 'deleted';

export interface CellLineChange {
  /** 0-based line number in the *current* (working-tree) cell source. */
  line: number;
  type: ChangeType;
  staged: boolean;
}

export interface CellDiffResult {
  /** Id of the matched cell in the current notebook. */
  cellId: string;
  /** Index in the current notebook. */
  cellIndex: number;
  changes: CellLineChange[];
}

export interface GitVersions {
  inRepo: boolean;
  /** Contents of the file at HEAD, or null if file is not in HEAD (untracked / new). */
  head: string | null;
  /** Contents of the file in the index, or null if file is not present in the index. */
  index: string | null;
  /** Path to the repo root (`git rev-parse --show-toplevel`) or null when not in a repo. */
  repoRoot: string | null;
  /** Files whose changes can invalidate cached git versions for this repository. */
  watchPaths: GitWatchPaths | null;
}

export interface GitWatchPaths {
  /** Worktree-specific HEAD file. */
  head: string;
  /** Worktree-specific index file. */
  index: string;
  /** Active branch ref file, null when HEAD is detached. */
  ref: string | null;
  /** Packed refs file, used when the active branch ref is packed. */
  packedRefs: string;
}
