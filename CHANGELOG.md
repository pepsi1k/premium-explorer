# Change Log

All notable changes to the "premium-explorer" extension are documented here, following
[Keep a Changelog](http://keepachangelog.com/).

## [2.1.6] - 2026-09-25

### Changed
- **Plainer permission messages.** When background painting cannot write to the
  VS Code folder, the notification now says so in one or two plain sentences and
  says what to do — give your user account write access to the folder, then run
  **Enable Background Painting** again — without error codes or long paths.
- **Details** now shows a short explanation with the folder path and an example
  command to read. The **Copy Command** button from 2.1.5 is gone: the extension
  never runs or copies commands, and granting access stays your decision.

## [2.1.5] - 2026-09-25

### Fixed
- **Re-applying background painting after a VS Code update failed with
  `EACCES: permission denied` even though access had already been granted.** A
  `.deb`/`.rpm` update keeps the workbench directory the user took ownership of but
  replaces `workbench.html` inside it with a fresh root-owned copy, so the access
  check passed and the write then failed. Patched files are now replaced by an
  atomic rename, which needs only the directory access the user already gave.
- **Disabling painting after such an update could restore the previous VS Code's
  `workbench.html`.** The backup was kept from before the update; it is now
  refreshed whenever the workbench is found unpatched.

### Changed
- **Details** on a permission error now opens a dialog inside VS Code with the
  directory that needs access and the exact command to grant it (with **Copy
  Command**), instead of a notification that closed on click and linked out to the
  README. The command is shown, never run.

## [2.1.4] - 2026-09-23

### Fixed
- **A colored folder could vanish entirely if this machine had ever generated the
  injected file for a *different* workspace whose folder name collided with an
  ordinary subfolder in the current one** (introduced in 2.1.3's path-matching
  fix). Multi-root detection worked by testing whether a level-1 row's name
  matched any key in the cross-session color union — including keys left over
  from other windows — so an ordinary child folder named e.g. `idp` could be
  mistaken for a workspace root and misroute every lookup beneath it. Detection
  now reads VS Code's own `rootfolder-icon` marker on the row instead, which only
  ever appears on an actual workspace-folder root.

## [2.1.3] - 2026-09-23

### Fixed
- **A rule now paints the folder it names, and only that folder.** Rows were
  matched by bare folder *name*, so `{ "path": "./idp/gitops" }` also painted
  `idp/pulumi/projects/gitops` and `idp/gitops/infra/gitops` — each of them twice
  over, once in the color inherited from its real parent and again in the rule's.
  The injected painter now rebuilds each row's path from the `aria-level` chain it
  already walks and matches it against paths relative to the workspace folder, so
  same-named folders in different places keep their own colors. Where the list is
  scrolled past the top of the tree and the outer ancestors are not rendered at
  all, a row is matched on the tail of its path plus its depth, and is left
  unpainted rather than mispainted if that is still ambiguous.
- Two Git repositories that share a name inside one workspace are both colored
  now; previously the second one discovered was dropped.

## [2.1.2] - 2026-09-18

### Fixed
- **Symlinked directories are no longer colored on their own.** A `git` rule no
  longer follows symlinks while discovering repositories, so a repo reachable
  both through a link and at its real path is no longer found — and colored —
  twice. A symlink is now painted in only two cases: a rule names its path, or
  it sits inside a colored folder like any other row.
- A folder that is itself a symlink is left unpainted even when a rule names its
  path, since it would otherwise be indistinguishable from the folder it points
  at. New `premiumExplorer.symlinkFolders` setting opts back in: `"dim"` paints it
  in the rule's color but dimmer, `"normal"` paints it like a real folder,
  `"none"` (the default) leaves it alone.

## [2.1.1] - 2026-09-18

### Fixed
- **Enabling background painting on a system-wide VS Code install no longer
  dead-ends on a raw permission error** ([#2](https://github.com/pepsi1k/premium-explorer/issues/2)).
  The workbench directory is now tested for write access *before* anything is
  attempted, so instead of an `EACCES` toast quoting a 100-character path twice you
  get a warning that names the directory and says you need write access to it.
  Granting it stays a manual step you take yourself — the extension runs nothing
  privileged, asks for no password, and opens no terminal on your behalf.
- Snap and Flatpak installs are reported as what they are: the app is mounted from
  a read-only image, so no permission can be granted and background painting is not
  possible there. Previously they produced the same "run this chown" advice, which
  could never have worked.
- After a VS Code update removes the patch, the re-apply prompt now checks that the
  directory is still writable. The update usually restores the install's own
  ownership as well, so the prompt used to walk the user straight back into the
  error they had already fixed once.

### Changed
- Patch failure messages no longer repeat the absolute path — Node's `fs` errors
  are trimmed to the part that says what went wrong, and a **Details** button opens
  the README section covering every install shape.
- The Windows permission hint now recommends reinstalling with the User Installer,
  which puts VS Code somewhere the user's own account already owns, rather than
  suggesting running as Administrator.

### Removed
- The extension no longer produces, copies or offers to run a `sudo chown`. It
  reports what it can't do and names the directory; the change itself is the
  user's, made deliberately and outside VS Code. The README documents the how-to.

## [2.1.0] - 2026-09-17

### Removed
- **The `be5invis.vscode-custom-css` delivery path, and with it the command
  "Premium Explorer: Generate Background CSS (for vscode-custom-css)".** Premium
  Explorer patches the workbench itself and needs no companion extension, so
  there is now one way to turn painting on: **Enable Background Painting**.

  This also fixes [#1](https://github.com/pepsi1k/premium-explorer/issues/1). On a
  machine without vscode-custom-css the removed command failed outright with
  *"Unable to write to User Settings because vscode_custom_css.imports is not a
  registered configuration"* — that key only exists while that extension is
  installed. The same unguarded write sat in **Enable Background Painting** too,
  where it would have thrown *after* the workbench was already patched.

### Changed
- If you were on the vscode-custom-css path, running **Enable Background
  Painting** takes Premium Explorer's own entries back out of
  `vscode_custom_css.imports` as it goes, so the script isn't loaded twice and
  every row painted twice. Entries you added yourself are left alone, and the
  cleanup is skipped silently when that extension isn't installed.

### Fixed
- The version stamp that decides whether an extension update needs to regenerate
  the injected files is now written whenever those files are written. Previously
  only the removed command recorded it, so enabling painting left it unset and the
  next window launch showed a spurious "regenerated the injected files, reload to
  apply" prompt.

## [2.0.1] - 2026-09-17

### Changed
- **New icon.** The extension icon, README logo and in-repo artwork moved from
  the old `logo.svg`/`logo-*.png` to a redrawn `logo-edge` mark, shipped as
  light, dark-background (`-ondark`) and transparent variants (`assets/logo/svg/`,
  `assets/logo/png/`) so the mark can sit on either a light or dark surface.
- All TypeScript sources were reformatted from tabs to 2-space indentation, and
  ESLint's `indent` rule now enforces it going forward.

## [2.0.0] - 2026-09-16

### Added
- **Premium Explorer now paints backgrounds by itself.** Until now the colours,
  edge bars, pills and watermarks only appeared if you also installed
  `be5invis.vscode-custom-css` and wired the generated files into its import list
  by hand. Run **Premium Explorer: Enable Background Painting** and reload the
  window — that is the whole setup.

  It works the only way anything can: VS Code has no API for Explorer row
  backgrounds and extensions run in a separate process from the window you see,
  so the generated CSS/JS pair is written into the installation's workbench
  directory and two tags are added to `workbench.html` to load it. VS Code will
  say the installation "appears corrupt" afterwards, because that file is
  checksummed; the banner is safe to dismiss.

  Two things it does differently from vscode-custom-css. The Content Security
  Policy is left intact — the tags reference the files relatively, which
  `script-src 'self'` already allows, so nothing is weakened to inline a script.
  And because the tags *name* the files rather than carrying them, changing a
  setting rewrites only those two files: `workbench.html` is never revisited and
  the patch cannot go stale. There is no "reload the injected CSS" step any more.

- **Premium Explorer: Disable Background Painting (Restore Workbench)** undoes
  it. The original `workbench.html` is backed up before the first patch and
  restored byte-for-byte, and the files added beside it are removed.

- **A VS Code update no longer silently stops the colours.** An update replaces
  the whole workbench directory, taking the patch with it. Premium Explorer
  notices on the next launch and offers to re-apply.

### Changed
- **`be5invis.vscode-custom-css` is now optional, and still fully supported.**
  The command that wires it up is unchanged, retitled **Premium Explorer:
  Generate Background CSS (for vscode-custom-css)** to say which path it serves.
  Don't run both: two copies of the painter would style every row twice.
  Enabling Premium Explorer's own painting removes its entries from
  `vscode_custom_css.imports` for you.
- The README's description of how the extension works has been rewritten. The
  old one described a mechanism the extension does not use — it claimed label
  colours came from the decoration API and that custom hexes were bridged into
  `workbench.colorCustomizations`. Neither has been true for some time.

### Note
1.3.0 and 1.4.0 were tagged but never reached the Marketplace, so this release
also brings the built-in watermark glyphs described under 1.4.0 below.

## [1.4.0] - 2026-09-08

### Added
- **Watermark glyphs shipped in the box.** `premiumExplorer.backgroundWatermarkSymbol`
  now accepts the bare name of an icon that comes with the extension — `ansible`,
  `argo`, `claude`, `docker`, `fluxcd`, `git`, `kubernetes`, `pulumi`, `terraform` —
  so marking a folder as a Docker project no longer starts with going to find an
  SVG. Names are matched case-insensitively and a trailing `.svg` is allowed, so
  `docker`, `Docker` and `docker.svg` all mean the same drawing.

  A glyph is tried *after* a file path, so a workspace's own `docker.svg` still
  wins over the one in the box. A value that is neither a readable file nor a
  glyph is drawn as text as before — its first two characters — but now says so
  and lists the names available, instead of silently painting `do`.

### Changed
- **`backgroundWatermark` is now `backgroundWatermarkSymbol`**, as the global
  setting and as the per-rule key, because it no longer takes only a character or
  a path. The old names are still read wherever the new one is unset, so an
  existing configuration keeps its artwork; both are marked deprecated in the
  settings UI.
- The extension's own logo moved from `images/` to `assets/logo/`, next to the
  new `assets/svg/`.

## [1.2.3] - 2026-09-07

No changes to the extension — identical to 1.2.2. Published to exercise the
release pipeline end to end.

## [1.2.2] - 2026-09-07

### Fixed
- **Selection colours are now per-workspace, like the folder colours already were.**
  One generated file serves every window, so the single global `selection` block it
  carried meant whichever window generated last decided how a selected row looked in
  *every* workspace — a workspace left on the default `"invert"` quietly took a
  neighbour's `selectedBackgroundColor: "#ffffff"` away. Worse, `"invert"` has no
  colour to use outside a coloured folder, so rows under no rule fell back to the
  theme's own grey selection while rows inside one were painted: the same window,
  two different selection colours. The options are now keyed by workspace-folder
  name alongside the colours, and the painter picks the ones belonging to the
  workspace in its window.
- **The selected label's colour and weight likewise stopped leaking between
  workspaces.** They were literals in the shared stylesheet, baked from one window's
  `selectedTextColor`/`selectedBold`. The painter now marks the rows it styled
  (`.fc-sel-text`, `.fc-sel-bold`) and publishes the colour as `--fc-sel-fg`, so the
  stylesheet carries no workspace's answer at all.
- **An extension update now reaches the workbench.** The generated JS embeds
  `media/inject.js` verbatim, and the only things that rewrote it were a settings
  change or the command run by hand — so a new version shipped a new painter that
  nothing installed, and global storage kept serving the script from whichever
  version last happened to write it. The version the files were generated by is now
  stamped in `globalState` and the pair is re-emitted once when it moves.
- **A fixed selection colour now applies to every selected row.** The fill was
  applied inside the branch that only runs for rows belonging to a coloured folder,
  so a row outside every rule kept the theme's own selection — while the generated
  CSS still coloured its label, because that rule matched any selected row in a
  configured workspace. A black label on a dark grey row was the visible result.
  A hex (and a `"shift"`, which needs no folder) now paints wherever a row is
  selected, `"invert"` still stands down with no folder colour to use, and the label
  rule is scoped to `.fc-sel` — the rows the painter actually filled.

## [1.2.0] - 2026-09-04

### Fixed
- **A selected or renamed row no longer washes out to grey.** Both colours were
  taken by stepping the row's own colour toward white, which moves every channel
  the same distance and so flattens the ratios between them — a dark, saturated row
  arrived at grey carrying none of the folder it belonged to. The step now mixes the
  folder's own colour back in first (`selectedShift` scales both moves), so a
  selected row reads as *this row, marked, in this folder's colour*, and `F2` shows
  the row shifted rather than a grey band.
- **An `inherit` background now reports the colour it actually paints.** A rule whose
  contents blended into an enclosing folder still described itself with its own base
  colour — `defaultColor`, grey, for a manual rule — so `selectedBackgroundColor:
  "invert"`, the rename shift and the automatic watermark tint all derived grey for a
  row that was visibly painted in its parent's colour.

### Changed
- **The edge bar is never taken over by the selection.** `edge` is gone from
  `premiumExplorer.selectedOverrides` (values left over in a config are ignored): the
  bar is the narrowest mark on a row and the only one that still says which folder a
  selected — or renaming — row belongs to, so spending it on saying "selected", which
  the fill over the rest of the row already says, cost more than it bought.
- **Renamed to Premium Explorer.** The extension id is now `pepsik.premium-explorer`,
  every setting is `premiumExplorer.*`, and the generated pair is
  `premium-explorer.css` / `premium-explorer.js`. **Settings do not carry over** —
  rename the `premiumStash.*` keys in your settings. Global storage is keyed on the
  extension id, so the generated files move with it; the stale
  `vscode_custom_css.imports` entries pointing at the old pair are now dropped
  automatically when the files are generated, instead of leaving two painters
  fighting over the same rows.
- **`Glyph` is now `Watermark` everywhere.** `backgroundGlyph` →
  `backgroundWatermark`; `*GlyphStyle`, `*GlyphColor`, `*GlyphContrast`,
  `*GlyphOpacity`, `*GlyphSize`, `*GlyphCanvas`, `*GlyphDensity`,
  `*GlyphVariation`, `*GlyphRotation`, `*GlyphDim`, `*GlyphDimStyle`,
  `*GlyphDimWidth`, `*GlyphDimHeight` → the same names with `Watermark`;
  `selectedGlyphColor` / `selectedGlyphContrast` →
  `selectedWatermarkColor` / `selectedWatermarkContrast`; and the `glyphs` value of
  `selectedOverrides` → `watermarks`.
- Layer baking moved out of `backgroundStyles.ts` into `src/layers.ts`, which now
  owns how one folder's row styling is turned into what the painter applies.

### Added
- **`selectedBackgroundColor: "shift"`** — the selected row keeps the colour it
  already shows and lifts it a step (`premiumExplorer.selectedShift`, default
  `0.12`), so the selection reads as *this row, marked* rather than a foreign
  highlight, and the watermark on it stays the folder's own colour instead of
  going grey against a bright fill. A shift carries its own strength, so
  `selectedOpacity` does not apply to it — compositing a shift back over the
  colour it was measured from would cancel it out.
- **Path-scoped rules** (`premiumExplorer.rules`): each rule points at a folder and
  picks an engine — `git` (auto-color every repo found under it), `manual` (color
  the folder and its contents with a chosen hex), or `default` (same, using
  `premiumExplorer.defaultColor`; also the engine used when `engine` is omitted).
  Rules resolve by path specificity, so a deeper rule overrides a shallower one.
- Deterministic automatic color chosen by hashing, with a configurable palette.
- Optional Explorer **background** coloring (colored folders + their contents,
  hover, and selection highlight) generated for the `be5invis.vscode-custom-css`
  extension.
- Settings for text/background opacity, selection background/text/bold, and badge.
- **Two-state selection** like VS Code's native list: a focus ring while the
  Explorer is focused (`premiumExplorer.selectedBorder`) and a darker, ring-less fill
  when it isn't (`premiumExplorer.selectedInactiveDarken`).
- **Separate root/inner styling.** `premiumExplorer.rootStyle` and
  `premiumExplorer.innerStyle` each choose `full` (whole row), `pill` (rounded
  background behind the label text), or `edge` (left bar); `innerStyle` also accepts
  `none` to leave the contents uncolored.
- **Per-rule overrides**: a rule may set `rootOpacity`, `contentsOpacity`,
  `colorText`, `rootStyle`/`rootBackground`/`rootText`, and
  `innerStyle`/`innerBackground`/`innerText` to override the globals for that path.
- **Per-workspace background scoping**: the global injected files now store a union
  of every configured workspace's colors, and the injected script paints only the
  workspace shown in the current window — so opening another project no longer
  inherits its colors, and multiple windows can each show their own. This also stops
  windows from clobbering each other's colors (each replaces only its own entry).

### Fixed
- `premiumExplorer.enabled = false` now clears the generated background/selection
  styling instead of leaving the last-generated files painting.
- Background CSS/JS were imported with a `vscode-userdata:` URL that
  vscode-custom-css can't read; they're now imported as `file://` URLs.

### Changed
- Reworked the model from "color all Git repos in the workspace" to explicit
  `premiumExplorer.rules`. **With no rules, nothing is colored.**
- Split the implementation into focused modules and moved the injected browser
  script into `media/inject.js` for readability.

### Removed
- `premiumExplorer.overrides` and `premiumExplorer.colorContents` — both are now
  expressed via `premiumExplorer.rules` (a `manual` rule replaces an override and
  always colors the folder's contents).

## [1.1.0] - 2026-09-04

### Added
- **Glyph watermark layer.** `rootGlyphStyle`/`innerGlyphStyle` scatter a folder's
  mark faintly behind its rows. The artwork comes from `backgroundGlyph` — a
  character or emoji, a path to an `.svg` file, inline `<svg>` markup, or a data
  URI — and falls back to the folder name's initial. It is drawn as one canvas
  anchored to the top of the folder's block, so the scatter flows unbroken across
  the root row and everything nested inside rather than restarting per row.
  Tunable per row-kind and per rule: `*GlyphColor`, `*GlyphContrast`,
  `*GlyphOpacity`, `*GlyphSize`, `*GlyphCanvas`, `*GlyphDensity`,
  `*GlyphVariation`, `*GlyphRotation`.
- **Striped edge bar.** `rootEdgeColors`/`innerEdgeColors` paint the left bar as a
  45-degree stripe sequence, with `*EdgeWidth`, `*EdgeStripeSize` and a global
  `edgeColorCount` for automatically derived sequences.
- **`premiumExplorer.selectedOverrides`** — which styles the selection colour takes
  over (`background`, `edge`, `glyphs`, `text-color`, `pills`). Only what is listed
  changes on a selected row; every other layer keeps painting as it does
  unselected, so a selected row still shows which folder it is in.
- **`premiumExplorer.selectedGlyphColor` / `selectedGlyphContrast`** — the watermark's
  tint on a selected row: `auto` takes a shade off the colour the row actually
  paints (so `selectedOpacity` is accounted for), or pin a hex.
- **Inline rename.** While the rename box is open the row shifts a step off its own
  fill, and the box itself goes transparent with a border, so the row's colour and
  watermark carry through instead of a theme-coloured slab dropping into the tree.
- A colour picker in the Settings UI for every colour field, including the ones
  nested inside `premiumExplorer.rules`.

### Changed
- The watermark's default tint now **inherits the row's fill colour** and steps
  clear of what the row composites to (`*GlyphContrast`, default `0.15`). It used
  to be a fixed 45% darkening of the nominal fill, which ignored the fill's opacity
  and the theme behind it — on a low-opacity fill that landed within ~4/255 of the
  row and was invisible.

### Fixed
- SVG artwork exported from Sketch/Figma rendered as nothing. Those exports wrap the
  drawing in `<g stroke="none" fill="none">` and put the real colour on each path;
  flattening the artwork to one shade stripped those colours and every shape fell
  back to the group's `none`. That scaffolding is now dropped from artwork that
  fills anything, while an outline icon — where `fill="none"` *is* the drawing —
  keeps it.
- The rename box hid the typed text and the caret: the label colour is `!important`
  and the input inherited it, and `caret-color` follows `color`.
- The watermark on a selected row lost its contrast against the selection fill.
- Renaming a colored folder briefly dropped the colour from every row beneath it,
  because the open rename box empties the label the tree is matched by.

### Removed
- The per-rule `color` key. It duplicated the layer colours (`rootBackgroundColor`,
  `innerBackgroundColor`, and the rest), which are what actually paint.
