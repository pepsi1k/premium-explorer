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
`globalStorageUri` and loaded by the workbench. Nothing renders until the user
turns painting on and reloads.

That pair reaches the workbench one way: [workbenchPatch.ts](src/workbenchPatch.ts)
patching `workbench.html` ourselves (**Premium Explorer: Enable Background
Painting**). **The extension is self-sufficient — no companion extension.** Before
2.1.0 the pair could also be handed to `be5invis.vscode-custom-css`; that path and
its **Generate Background CSS** command are gone, and all that survives is
`unwireCustomCssImports()`, a one-way cleanup so a migrating user doesn't end up
with two copies of the script painting every row twice.

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
5. The pair is delivered: `writeFiles()` writes it to global storage, stamps the
   version that wrote it, and mirrors it into the patched workbench directory.

[colors.ts](src/colors.ts) and [workbenchPatch.ts](src/workbenchPatch.ts) are pure
(no `vscode` import): the first does hashing, hex/rgba math, stripe gradients and
the SVG watermark pattern; the second does the file surgery on `workbench.html`,
with every message and prompt left to [injection.ts](src/injection.ts).

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
- **One global file, per-workspace colors *and* selection.** The injected file is
  shared by every window, so `globalState` holds two unions keyed by lowercased
  workspace-folder name — `premiumExplorer.workspaceColors` and
  `premiumExplorer.workspaceSelection`; `inject.js` paints only the map(s) for the
  workspace in the current window and sets `body.fc-active` to gate the CSS.
  Anything baked once for the whole file is decided by whichever window generated
  last, which is a bug every time the setting behind it is per-workspace. That is
  why the generated CSS holds no colors: the selected label's color travels as
  `--fc-sel-fg` on rows the painter marked `.fc-sel-text`/`.fc-sel-bold`.
- **The Explorer list is virtualized and flat.** `inject.js` reconstructs the tree
  by sorting rows on `style.top` and walking `aria-level` with a stack.
- **Only touch rows we own.** Every write in `inject.js` is inline and tracked via
  a `data-fc-*` marker, both to avoid `MutationObserver` write loops and to never
  clear styling that isn't ours.
- **`premiumExplorer.enabled: false` must write inert files.** The workbench loads
  the generated pair independently of the extension, so disabling has to actively
  blank them, or the last-generated colors keep painting.
- **The workbench patch names files; it never carries them.** The tags injected
  into `workbench.html` reference `./premium-explorer.{css,js}` in the same
  directory, so regenerating means rewriting those two files (`writeFiles()` does
  it) and the HTML is never revisited. That is also what keeps VS Code's CSP
  intact: a relative `src` is `'self'`, which `script-src` already allows, so
  unlike vscode-custom-css we don't have to delete the policy to inline a script.
  Keep `media/inject.js` free of `innerHTML`-style sinks or the CSP's
  `require-trusted-types-for 'script'` will start blocking the painter.

### Adding a layer setting

A per-layer setting touches at least four places, all of which use the same flat
`root*`/`inner*` key naming: the `contributes.configuration` schema in
[package.json](package.json), the `PartConfig` interface, `readPart()` (global
default) and `readPartOverride()` (per-rule override) in
[config.ts](src/config.ts) — then whatever consumes it in
[layers.ts](src/layers.ts) and [media/inject.js](media/inject.js).

### Adding a built-in watermark glyph

`premiumExplorer.backgroundWatermarkSymbol` (and the per-rule key of the same
name) accepts the bare name of any `.svg` in [assets/svg/](assets/svg/) —
`docker`, `terraform`, … `resolveWatermarkArt()` in
[backgroundStyles.ts](src/backgroundStyles.ts) scans that directory at generate
time, so **dropping a file in is the whole code change**. Two things to know:

- The name list in `contributes.configuration` is hand-written and does *not*
  update itself. Add the new name to `examples` and to the "built-in glyph"
  sentence in both `premiumExplorer.backgroundWatermarkSymbol` and the rule-level
  `backgroundWatermarkSymbol`, or it won't autocomplete.
- A glyph is tried **after** a path, so a workspace's own `docker.svg` still wins.
  A value that resolves to neither is drawn as text (first two characters), which
  is why a misspelt name warns instead of silently painting `do`.
- `neutralizeSvg()` strips the artwork's own fills so it takes one flat tint,
  including the `<style>` classes an Illustrator export uses. An icon that draws
  only with `fill="none"` outlines is the case that needs checking by eye.

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
- **Nothing discovers a symlink; only a rule that names one reaches it.**
  `findRepositories()` in [repositoryScanner.ts](src/repositoryScanner.ts) never
  descends into a symlinked directory — that avoids finding (and coloring) one repo
  twice, and avoids looping on a link back up the tree. So the only symlinked
  folders left are the ones a rule names by path, and
  [backgroundStyles.ts](src/backgroundStyles.ts) drops those too unless
  `premiumExplorer.symlinkFolders` opts in (default `"none"`); `"dim"` keeps them
  at reduced opacity via `symlinkAdjusted()`, which changes opacity only, so a
  layer the config left off stays off. A symlink *inside* a colored folder is
  painted by ancestry in the browser and never passes through any of this.
- **Symlink-ness cannot beat name matching.** The check is `fs.lstatSync` on the
  rule's own `absPath`, host-side. The painter matches rows by *name*, so a
  symlink sharing a name with a colored real folder still gets that folder's
  colors — there is no per-row path in the DOM to tell them apart.
- **`vscode_custom_css.imports` only exists while `be5invis.vscode-custom-css` is
  installed**, and writing to an unregistered configuration key throws — that is
  what made the old **Generate Background CSS** command fail outright on a fresh
  install (issue #1). `unwireCustomCssImports()` is the only thing left that touches
  the key: it checks the extension is present, removes only filenames in its own
  `OURS` list (which includes the extension's old `premium-stash.*` names), never
  adds any, and stays silent when there is nothing to do.
- **`writeFiles()` stamps `GENERATED_VERSION_STATE` on every write**, so the
  "regenerate after an update" check always has a baseline. Generating without
  stamping means `regenerateIfStale()` fires a spurious reload prompt on the next
  activation.
- **The workbench directory is usually not writable, and that is the normal case.**
  A system-wide install (`/usr/share/code`, `C:\Program Files\...`) is root- or
  Administrator-owned, so `checkAccess()` in
  [workbenchPatch.ts](src/workbenchPatch.ts) probes it with a real write before
  `apply()` is attempted — `fs.accessSync(W_OK)` gets ACLs, read-only mounts and
  root-squash wrong. Snap and Flatpak report `EROFS` and can never be patched at
  all, which is a different message, not a harsher one (issue #2). Nothing an
  extension host can do escalates privilege: the fix is always the user's `sudo`,
  their UAC prompt, or a different installer.
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
