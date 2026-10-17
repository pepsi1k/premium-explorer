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
so the real output is a **generated CSS + JS + JSON triple** written into the
extension's `globalStorageUri` and loaded by the workbench: a static painter
script, a small static CSS, and the baked per-workspace config as JSON, which
the painter fetches with `cache: "no-store"` on every boot (the script and CSS
are served from Chromium's cache across window reloads; the JSON is what makes
a settings change apply on a plain reload). Nothing renders until the user
turns painting on and reloads.

Those files reach the workbench one way: [workbenchPatch.ts](src/workbenchPatch.ts)
patching `workbench.html` ourselves (**Premium Explorer: Enable Background
Painting**). **The extension is self-sufficient — no companion extension.** Before
2.1.0 the pair could also be handed to `be5invis.vscode-custom-css`; that path and
its **Generate Background CSS** command are gone, and all that survives is
`unwireCustomCssImports()`, a one-way cleanup so a migrating user doesn't end up
with two copies of the script painting every row twice.

Generate-time pipeline, all triggered from
[extension.ts](src/extension.ts) on activation, settings change, workspace-folder
change, or a `**/.git` watcher event:

1. [config.ts](src/config.ts) — `readConfig()` flattens all 111 `premiumExplorer.*`
   settings into a `FolderColorerConfig`. Rules are resolved to absolute paths and
   **sorted deepest-path-first**, so `deepestRuleFor()` returning the first match
   is what implements "a deeper rule wins".
2. [coloredFolders.ts](src/coloredFolders.ts) — `resolveColoredFolders()`
   expands `git` rules by scanning for `.git` ([repositoryScanner.ts](src/repositoryScanner.ts),
   depth 8, skips `node_modules`/VCS dirs) and adds `manual` rules directly
   (watermark artwork comes from [watermarkArt.ts](src/watermarkArt.ts)).
   `bakeAll()` then bakes each folder **shallowest path first**, so an enclosing
   folder is finished before anything nested in it.
3. [layers.ts](src/layers.ts) — `buildPart()` turns one folder's `PartConfig`
   into ready-to-apply CSS values: background fill, striped edge bar, label pill,
   text style, tiled watermark and the single stamped `mark`. Six independent
   layers, baked separately for the `root` row and the `inner` rows, plus the
   corner radii (resolved to four numbers each).
4. [workspaceState.ts](src/workspaceState.ts) merges the baked folders and the
   selection options into the persisted per-workspace unions, and the result is
   serialized as `premium-explorer.json` — the file the static
   [media/inject.js](media/inject.js) fetches at boot. The CSS
   ([generatedCss.ts](src/generatedCss.ts)) covers only what inline styles can't
   reach: the selected label, the inline rename box, and hover.
5. [backgroundStyles.ts](src/backgroundStyles.ts) orchestrates and delivers:
   `writeFiles()` writes all three to global storage, stamps the version that
   wrote them, and mirrors them into the patched workbench directory.
   ([customCssMigration.ts](src/customCssMigration.ts) holds the one-way
   `unwireCustomCssImports()` cleanup.)

[colors.ts](src/colors.ts) and [workbenchPatch.ts](src/workbenchPatch.ts) are pure
(no `vscode` import): the first does hashing, hex/rgba math, stripe gradients and
the SVG watermark pattern; the second does the file surgery on `workbench.html`,
with every message and prompt left to [injection.ts](src/injection.ts).

### Invariants worth preserving

- **Bake at generate time; the painter only picks.** [inject.js](media/inject.js)
  should choose among pre-computed values, not recompute them. The deliberate
  exceptions are things only the browser knows: what a translucent row composites
  over, the auto watermark tint, the pane width for the watermark clearing, where
  a row's text actually ends (the `mark`'s position), how tall a folder's
  rendered **block** is (a `block`-scaled fill and block corner rounding), and
  what colour VS Code gave a git decoration (the `git*` lift).
- **`paint()` walks the tree before it paints anything.** Two passes, because a
  block's *extent* is only known once the whole rendered slice has been walked:
  the first records each row's folder, its block, and whether that block is
  `closed` (a shallower row came after it, so its end is real rather than
  scrolled out of view); the second paints. A block still open when the rows run
  out keeps its bottom corners square instead of drawing a false end.
- **`inherit` reads the ancestor's baked `inner` part.** That is why bake order is
  shallowest-first; `NO_ANCESTOR_FALLBACK` covers a top-level folder.
- **Folders are matched by *path*, which the browser has to reconstruct.** The DOM
  carries no paths, so `groupByWorkspace()` keys each baked folder by `folderKey()`
  — its path relative to the owning workspace folder, lowercased and `/`-separated
  — and `folderAt()` in [inject.js](media/inject.js) rebuilds a row's path from the
  `aria-level` chain the walk already keeps (`segs`/`segsFrom`). Level 1 is the
  workspace folders themselves in a multi-root window and already *inside* the
  folder in a single-folder one, which is what `multiRoot` decides. When the list is
  scrolled so the outer ancestors aren't rendered, only the tail of the path is
  known; a row is then matched on that tail plus its depth, and left unpainted if
  that is ambiguous. In practice the tree's sticky-scroll rows carry `aria-level`
  and sort to the front by `style.top`, so the full chain is usually there anyway.
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
  directory (`premium-explorer.json` is never in the HTML — the script fetches it
  relative to the document), so regenerating means rewriting the three files
  (`writeFiles()` does it) and the HTML is never revisited. That is also what keeps VS Code's CSP
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

### Git decorations, in the DOM

Worth knowing before touching the `git*` keys, because none of it is documented
and all of it was read out of devtools:

- VS Code renders a file decoration as a **generated class** on
  `.monaco-icon-label` — `monaco-decoration-itemColor-<hash>` for the filename's
  colour, with a sibling `::after` rule carrying the status letter (a file) or the
  dot (a folder). The hash is minted at runtime, so **no stylesheet can name it**.
- Those rules are **not `!important`**, and the colour reaches `.label-name` by
  inheritance — so a plain inline `color` on the label wins, no weight needed.
- The letter and the dot are `::after` **pseudo-elements**, so they cannot be
  styled inline at all. What *can* be named is the stable class beside the hash:
  `.monaco-decoration-text-badge` is the letter, and a `.monaco-decoration-badge`
  without it is the dot. [generatedCss.ts](src/generatedCss.ts) keys off those and
  the painter publishes the colours as custom properties, like `--fc-sel-fg`.
- The `::after` rule sets its own `color`, so it keeps reporting **Git's**
  intended colour even through our `!important` selected-label rules — which is
  how the painter reads the status colour back (`decorationHex()`), cached per
  decoration and dropped every paint.
- The status itself is identified by matching that colour against the four
  `--vscode-gitDecoration-*ResourceForeground` theme colours. Never parse the
  `aria-label`: it is localized prose.
- **Deleted files have no row in the Explorer**, so the design's "strikethrough
  on deleted" case does not arise there; the `deleted` status reaches a row only
  through a folder's combined dot. VS Code draws the strikethrough itself from
  `FileDecoration.strikethrough` where it does apply, and we neither add nor
  remove it — only `color` is ever written.
- **Selection outranks Git**, per the design: on a selected row the label takes
  the selection's text colour and the status colour is dropped, because the
  chip's plate and border still say which status it is. The chip inverts to
  dark-on-light there so the letter survives a bright selection. This is the one
  style that does *not* go through `selectedOverrides`.

### The symlink mark is a character inside Git's badge

VS Code *does* mark a symlink — but not the way the design handoff assumed, and
not anywhere it can be styled on its own. Verified in devtools (1.141):

- The mark is a **`⤷` appended to the single FileDecoration badge**, not a
  separate element at the row's right edge: the generated rule reads
  `content: "U, ⤷"` and its colour is Git's
  `--vscode-gitDecoration-untrackedResourceForeground`. With no git status it is
  the badge on its own; with one, the two share the slot, comma-separated.
  `scanDecorations()` reads that `content` string, which is how the painter tells
  an arrow-only badge (ours to colour, via `symlinkMarkColor`) from one sharing
  the slot with a status letter (Git's colouring governs, because there is only
  one colour to give).
- So it **cannot be coloured independently of Git's letter** — they are one
  `::after`. Anything that restyles the git badge restyles the arrow with it,
  which is why `gitMarkStyle: chip` plates `U, ⤷` as one chip.
- `premiumExplorer.badge` on a manual rule takes that slot outright, hiding the
  git letter *and* the arrow.
- A **compressed** row (VS Code collapsing `linked/nested` into one row) carries
  no decoration for the outer segment, so the mark disappears there.

`premiumExplorer.symlinkMark` therefore draws **our own** mark through the EM-94
mark layer: at the label rather than the badge, in its own colour, and surviving
a `badge` that has taken the slot. It reaches only a folder a rule names —
symlink-ness is an `lstat` host-side, and the painter has no per-row path for
anything else.

### Adding a built-in watermark glyph

`premiumExplorer.backgroundWatermarkSymbol` (and the per-rule key of the same
name) accepts the bare name of any `.svg` in [assets/svg/](assets/svg/) —
`docker`, `terraform`, … `resolveWatermarkArt()` in
[watermarkArt.ts](src/watermarkArt.ts) scans that directory at generate
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

- **[README.md](README.md) is a short pitch, not the settings reference.** It was
  rewritten against 2.5.0 (EM-113) and its examples are schema-valid, but it names
  only a handful of keys on purpose. The illustrated tour — one screenshot and the
  rule behind it per feature — lives in [docs/examples.md](docs/examples.md), and
  `contributes.configuration` in [package.json](package.json) stays the
  authoritative settings documentation, with [example/](example/) the working
  demonstration of each feature. A renamed or removed setting means checking that
  both files' examples still parse.
- **The README screenshots are generated, not drawn.** Every image in
  [assets/readme/](assets/readme/) is a crop of the Explorer painting `example/`,
  captured over CDP exactly as [.claude/rules/screenshot-proof-in-jira.md](.claude/rules/screenshot-proof-in-jira.md)
  describes (isolated profile, `Page.captureScreenshot` with a clip over the row
  range, live workbench files restored afterwards). Re-shoot them from that same
  workspace when a layer's look changes, or the README quietly documents an old
  build. `example/` has no `git` rule, so `git-colors.png` is the one image shot
  from a throwaway workspace of real repositories.
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
  [coloredFolders.ts](src/coloredFolders.ts) drops those too unless
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
