# JupyIndicator

Live, per-line git change indicators inside Jupyter notebook (`.ipynb`) cells in
VS Code. Shows **added**, **modified**, and **deleted** lines with distinct
styling for **staged** vs **unstaged** changes.

VS Code's native SCM gutter does not render inside notebook cell editors.
JupyIndicator fills that gap: it diffs each cell's _source code_ (not the raw
JSON) against its HEAD and index versions and paints indicators using
`TextEditor.setDecorations` on the individual cell editors that back each
notebook cell.

## Install (development)

```bash
npm install
npm run compile
```

Then press `F5` in VS Code with this folder open — a second Extension Host
window launches with the extension loaded. Open any notebook inside a git
repository to see indicators.

## How it works

1. `notebookParser.ts` — parses `.ipynb` JSON into a normalized per-cell shape.
2. `gitProvider.ts` — reads HEAD (`git show HEAD:<path>`) and index
   (`git show :<path>`) versions of the notebook.
3. `cellMatcher.ts` — matches cells between versions by `metadata.id`, falling
   back to exact-source hash and then a Jaccard-similarity heuristic.
4. `cellDiffer.ts` — runs Myers line diff (via the [`diff`](https://www.npmjs.com/package/diff)
   package, v9) on each matched pair and classifies each line as
   added / modified / deleted. Each painted line also carries a `changeId`
   and a `group` range with base/current line spans; touching indicators share
   the same `changeId`, so split lines and adjacent edits count as one logical
   change.
5. `decorator.ts` — applies `TextEditorDecorationType`s to the cell editor
   (found via `window.visibleTextEditors` filtered by the
   `vscode-notebook-cell` URI scheme).
6. `extension.ts` — wires events (notebook changes, saves, visibility, and git
   state watchers for HEAD/index/active refs) with a 150 ms per-notebook debounce.

Staged vs unstaged is computed by diffing **twice**: working tree vs HEAD gives
the _total_ change set, working tree vs index gives the _unstaged_ set. The
difference is staged. Each line's indicator reflects whichever category it
falls into (unstaged wins on conflicts).

## Settings

| Setting                                 | Default   | Purpose                          |
| --------------------------------------- | --------- | -------------------------------- |
| `jupyindicator.enabled`                 | `true`    | Turn indicators on/off globally. |
| `jupyindicator.debounceMs`              | `150`     | Per-notebook recompute debounce. |
| `jupyindicator.colors.unstagedAdded`    | `#2ea043` | Unstaged insertion.              |
| `jupyindicator.colors.unstagedModified` | `#1f6feb` | Unstaged modification.           |
| `jupyindicator.colors.unstagedDeleted`  | `#f85149` | Unstaged deletion marker.        |
| `jupyindicator.colors.stagedAdded`      | `#0f5323` | Staged insertion.                |
| `jupyindicator.colors.stagedModified`   | `#0c3d8a` | Staged modification.             |
| `jupyindicator.colors.stagedDeleted`    | `#8b1a1a` | Staged deletion marker.          |

Commands:

- `JupyIndicator: Refresh Indicators` — force re-read git state.
- `JupyIndicator: Toggle On/Off` — flips `jupyindicator.enabled`.

## Tests

```bash
npm test           # vitest run
npm run test:watch # vitest
```

Unit tests cover `notebookParser`, `cellMatcher`, and `cellDiffer`, plus an
integration test that threads a fixture pair end-to-end.

## Known limitations

- **Not the real SCM gutter.** VS Code does not expose the SCM gutter column
  inside notebook cells to extensions. Indicators are rendered as
  `gutterIconPath` SVGs on each cell's own line-number gutter — a colored
  vertical bar for added/modified, a small right-pointing triangle for
  deletions. The indicator sits to the left of the text rather than on the
  text itself, and there is no whole-line background tint.
- **Colors don't follow the theme.** The defaults are hard-coded hex per the
  current design; they're configurable, but they don't track your theme's
  `diffEditor.*` tokens automatically.
- **Cell matching is heuristic.** Cells with `metadata.id` match exactly;
  cells without it fall back to Jaccard similarity over non-blank source
  lines (threshold 0.4). Pathological split/merge cases may show an entire
  cell as added/deleted even when the content clearly moved.
- **Performance.** Target is <50 ms per recompute for notebooks up to
  500 cells. Full-notebook recompute runs on every change (debounced).
  Very large notebooks may feel sluggish; there's no incremental path yet.
- **Git-only.** The extension shells out to `git`; it won't do anything for
  notebooks outside a git repository (silent no-op).

## License

MIT. See [`LICENSE`](./LICENSE).
