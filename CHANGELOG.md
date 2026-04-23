# Changelog

All notable changes to the JupyIndicator extension will be documented in this file.

## [0.1.0] - 2026-04-24

Initial release.

- Live per-line change indicators inside Jupyter notebook cell editors.
- Distinguishes added / modified / deleted, staged vs unstaged.
- Pure-TypeScript implementation — no Python or `nbdime` runtime dependency.
- Cell matching by `metadata.id` with a similarity-based fallback for notebooks
  lacking stable ids.
- Configurable colors and enable/disable toggle.
