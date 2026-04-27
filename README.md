# JupyIndicator

Live, per-line git change indicators inside Jupyter notebook (`.ipynb`) cells in
VS Code. Shows **added**, **modified**, and **deleted** lines with distinct
styling for **staged** vs **unstaged** changes.

VS Code's native SCM gutter does not render inside notebook cell editors.
JupyIndicator fills that gap: it reads git HEAD/index snapshots, serializes the
current notebook editor buffer, compares them with nbdime's notebook-aware diff
engine, and paints indicators using `TextEditor.setDecorations` on the
individual cell editors that back each notebook cell.

## Install (development)

```bash
npm install
npm run compile
```

Then press `F5` in VS Code with this folder open — a second Extension Host
window launches with the extension loaded. Open any notebook inside a git
repository to see indicators.

## How it works

1. `gitProvider.ts` — shells out to git only to read the HEAD/index notebook
   snapshots needed for staged and unstaged comparisons.
2. `nbdimeProvider.ts` — shells out to Python and calls nbdime's
   `diff_notebooks` API to get a semantic notebook diff. If nbdime is not
   available and `jupyindicator.autoInstallNbdime` is enabled, the extension
   installs it into an extension-managed Python virtual environment under VS
   Code global storage.
3. `nbdimeNotebookDiffer.ts` — maps nbdime cell/source diff decisions onto the
   extension's added / modified / deleted cell-line marker model. `cellDiffer.ts`
   is now a scoped line-placement helper after nbdime identifies a source patch.
4. `notebookParser.ts` — parses `.ipynb` JSON into a normalized per-cell shape.
5. `decorator.ts` — applies `TextEditorDecorationType`s to the cell editor
   (found via `window.visibleTextEditors` filtered by the
   `vscode-notebook-cell` URI scheme).
6. `extension.ts` — wires events (notebook changes, saves, visibility, and git
   state watchers for HEAD/index/active refs) with a 150 ms per-notebook debounce.

Staged vs unstaged is computed from nbdime diffs: HEAD → current editor buffer
gives the _total_ change set, index → current editor buffer gives the
_unstaged_ set, and the difference is staged. Each line's indicator reflects
whichever category it falls into (unstaged wins on conflicts). The direct
HEAD → index diff is also read for the initial-commit case where `HEAD` is not
available.

Unsaved notebook edits are included. On every debounced notebook edit,
JupyIndicator serializes the in-memory notebook model to a temporary nbformat
shape and compares that text against git's HEAD/index snapshots.

## Settings

| Setting                                 | Default   | Purpose                          |
| --------------------------------------- | --------- | -------------------------------- |
| `jupyindicator.enabled`                 | `true`    | Turn indicators on/off globally. |
| `jupyindicator.debounceMs`              | `150`     | Per-notebook recompute debounce. |
| `jupyindicator.nbdimePythonPath`        | `""`      | Python executable that can import nbdime. |
| `jupyindicator.autoInstallNbdime`       | `true`    | Install nbdime into an extension-managed venv when needed. |
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

Unit tests cover nbdime diff mapping, staged vs unstaged diff collection,
deletion anchoring, `notebookParser`, `cellMatcher`, and the legacy cell diff
line-placement helper.

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
- **Unsaved buffers use a generated notebook representation.** The extension
  serializes visible cell source and stable cell ids from VS Code's in-memory
  notebook model. Outputs and most metadata are intentionally omitted from this
  temporary representation because gutter indicators only track cell source.
- **nbdime is managed through Python.** The extension first tries the configured
  `jupyindicator.nbdimePythonPath`, then `python3` / `python` (and `py -3` on
  Windows). If none can import `nbdime`, it installs nbdime into an
  extension-managed virtual environment by default. If installation fails or is
  disabled, indicators fall back to the older snapshot comparison and the output
  channel reports the import error.
- **Line status is projected from source patches.** nbdime decides which
  notebook cells and sources changed; JupyIndicator still performs a scoped
  line comparison inside changed sources so VS Code can decorate exact editor
  lines.
- **Performance.** Target is <50 ms per recompute for notebooks up to
  500 cells. Full-notebook recompute runs on every change (debounced).
  Very large notebooks may feel sluggish; there's no incremental path yet.
- **Git-only.** The extension shells out to `git`; it won't do anything for
  notebooks outside a git repository (silent no-op).

## License

MIT. See [`LICENSE`](./LICENSE).
