# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`pepsik.premium-explorer`) that colors Explorer rows per
path-scoped rule. Node/TypeScript, bundled with esbuild, **pnpm only** (a
`pnpm-workspace.yaml` pins `allowBuilds`, and `.npmrc` sets
`enable-pre-post-scripts`). No runtime dependencies; `vscode` is an esbuild
external.

## Commands

```bash
pnpm install
pnpm run watch          # tsc --noEmit --watch + esbuild --watch (or press F5)
pnpm run check-types    # tsc --noEmit
pnpm run lint           # eslint src
pnpm run package        # check-types + lint + production bundle -> dist/extension.js
pnpm run package:vsix   # vsce package --no-dependencies -> dist/out/*.vsix
pnpm test               # compiles src -> out/ via pretest, then runs @vscode/test-cli
pnpm test -- -g "name"  # single test (mocha --grep passes through)
```

F5 ("Run Extension") launches an Extension Development Host. Note
[.vscode/launch.json](.vscode/launch.json) hard-codes a personal folder as the
test workspace — change that path to something you actually have.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs check-types, lint
and `package:vsix`. It does **not** run `pnpm test`; the only test file is the
generated sample.

## Architecture

The extension paints almost nothing itself. VS Code's `FileDecorationProvider`
can only set a badge/tooltip on a label — there is no API for row backgrounds —
so the real output is a **generated CSS + JS pair** written into the extension's
`globalStorageUri` and injected into the workbench by the third-party
`be5invis.vscode-custom-css` extension. Nothing renders until the user runs
**Premium Explorer: Generate Background CSS**, enables custom CSS, and reloads.

Generate-time pipeline, all triggered from
[extension.ts](src/extension.ts) on activation, settings change, workspace-folder
change, or a `**/.git` watcher event:

1. [config.ts](src/config.ts) — `readConfig()` flattens all 74 `premiumExplorer.*`
   settings into a `FolderColorerConfig`. Rules are resolved to absolute paths and
   **sorted deepest-path-first**, so `deepestRuleFor()` returning the first match
   is what implements "a deeper rule wins".
2. [backgroundStyles.ts](src/backgroundStyles.ts) — `resolveColoredFolders()`
   expands `git` rules by scanning for `.git` ([repositoryScanner.ts](src/repositoryScanner.ts),
   depth 8, skips `node_modules`/VCS dirs) and adds `manual` rules directly.
   `bakeAll()` then bakes each folder **shallowest path first**, so an enclosing
   folder is finished before anything nested in it.
3. [layers.ts](src/layers.ts) — `buildPart()` turns one folder's `PartConfig`
   into ready-to-apply CSS values: background fill, striped edge bar, label pill,
   text style, tiled watermark. Five independent layers, baked separately for the
   `root` row and the `inner` rows.
4. The result is serialized as `globalThis.__premiumExplorerConfig` and
   **prepended verbatim** to the static [media/inject.js](media/inject.js), which
   is written alongside a small CSS file (the CSS covers only what inline styles
   can't reach: the selected label and the inline rename box).
5. `addCustomCssImports()` rewrites `vscode_custom_css.imports` to point at the
   two files.

[colors.ts](src/colors.ts) is pure (no `vscode` import): hashing, hex/rgba math,
stripe gradients, and the SVG watermark pattern generator.

### Invariants worth preserving

- **Bake at generate time; the painter only picks.** [inject.js](media/inject.js)
  should choose among pre-computed values, not recompute them. The deliberate
  exceptions are things only the browser knows: what a translucent row composites
  over, the auto watermark tint, the pane width for the watermark clearing, and
  where a row's text actually ends.
- **`inherit` reads the ancestor's baked `inner` part.** That is why bake order is
  shallowest-first; `NO_ANCESTOR_FALLBACK` covers a top-level folder.
- **Folders are matched by *name*, not path, in the browser.** The DOM has no
  paths. Two same-named folders in one workspace therefore share a color.
- **One global file, per-workspace colors.** The injected file is shared by every
  window, so `globalState` (`premiumExplorer.workspaceColors`) holds a union keyed
  by lowercased workspace-folder name; `inject.js` paints only the map(s) for the
  workspace in the current window and sets `body.fc-active` to gate the CSS.
- **The Explorer list is virtualized and flat.** `inject.js` reconstructs the tree
  by sorting rows on `style.top` and walking `aria-level` with a stack.
- **Only touch rows we own.** Every write in `inject.js` is inline and tracked via
  a `data-fc-*` marker, both to avoid `MutationObserver` write loops and to never
  clear styling that isn't ours.
- **`premiumExplorer.enabled: false` must write inert files.** vscode-custom-css
  loads the generated pair independently of the extension, so disabling has to
  actively blank them or the last-generated colors keep painting.

### Adding a layer setting

A per-layer setting touches at least four places, all of which use the same flat
`root*`/`inner*` key naming: the `contributes.configuration` schema in
[package.json](package.json), the `PartConfig` interface, `readPart()` (global
default) and `readPartOverride()` (per-rule override) in
[config.ts](src/config.ts) — then whatever consumes it in
[layers.ts](src/layers.ts) and [media/inject.js](media/inject.js).

## Gotchas

- **[README.md](README.md) is stale.** Its Settings section still describes the
  pre-`layers.ts` model (rule-level `"color"`, `rootStyle`/`innerStyle` as
  `full`/`pill`/`edge`, `colorText`, `rootOpacity`/`contentsOpacity`, and
  bridging hexes into `workbench.colorCustomizations`). None of that exists.
  `contributes.configuration` in [package.json](package.json) is the authoritative
  settings documentation; treat the README's Quick start and Settings as fiction
  until someone rewrites them.
- **`globalStorageUri` is keyed on the extension id.** A locally built VSIX with no
  `publisher` lands in `undefined_publisher.premium-explorer`, a Marketplace
  install in `pepsik.premium-explorer`. Switching install method silently changes
  which directory is live and the old imports keep pointing at the dead one.
- **`regenerateIfConfigured()` stats the CSS file and returns early if absent**, so
  settings changes regenerate nothing until the command has been run once.
- `addCustomCssImports()` only prunes filenames in its own `OURS` list (which
  includes the extension's old `premium-stash.*` names); anything else in the
  user's import list is left alone.
- Settings files are JSONC — never read-parse-rewrite them, it destroys comments.
- Commits in this repo are GPG-signed (`commit.gpgsign = true`). If signing fails,
  hand the commit to the user rather than reaching for `--no-gpg-sign`.

## Releasing

Tag-driven: pushing a `v*` tag runs
[.github/workflows/release.yml](.github/workflows/release.yml), which fails unless
the tag matches `package.json`'s version exactly, then packages, `vsce publish`es,
polls the gallery via [scripts/wait-for-marketplace.mjs](scripts/wait-for-marketplace.mjs),
and pings Telegram. **A published version can never be republished** — fix a
broken release by bumping, never by retrying.

Two project skills cover the recurring workflows: `/release` (bump → tag → watch
it land) and `/setup-vscode` (diagnose why colors aren't showing after an install,
rename, or reinstall). Read [.claude/skills/](.claude/skills/) before doing either
by hand.
