# Premium Explorer

Color folders in the VS Code Explorer using **path-scoped rules**. Point a rule at
a folder and choose how it's colored:

- **`git` engine** — every Git repository found under that path gets an automatic,
  stable color (hashed from its name), so a directory full of projects is
  color-coded at a glance.
- **`manual` engine** — that folder, and everything inside it, gets a color you pick.
- **`default` engine** — same as `manual` but uses `premiumExplorer.defaultColor`.
  It's the engine used when a rule omits `engine`, and it's handy for resetting an
  inner path back to the default color.

Rules are resolved by **path specificity**: a deeper rule wins, so a `manual` rule
inside a `git` region overrides it for that subtree.

With **no rules configured, nothing is colored** — you opt in per path.

## Quick start

```jsonc
"premiumExplorer.rules": [
  // Auto-color every Git repo in the workspace:
  { "path": ".", "engine": "git" },

  // Give a specific folder (and its contents) a fixed color:
  { "path": "./notes", "engine": "manual", "color": "#00b8ff" },

  // Override one project inside the git region with your own color:
  { "path": "./github/special", "engine": "manual", "color": "#ff8800" },

  // engine omitted -> "default" engine (uses premiumExplorer.defaultColor):
  { "path": "./scratch" }
]
```

Paths may be **workspace-relative** (`.`, `./projects`) or **absolute**.

## How it works

VS Code has **no API for Explorer row backgrounds**. Through `FileDecorationProvider`
an extension can set a label's badge and tooltip, and nothing else — and extensions
run in a separate process from the window you see, so none of them can reach the
workbench DOM directly.

Premium Explorer therefore works in two halves:

1. **Generate.** It resolves your rules into a set of colored folders and bakes each
   one's layers — background fill, left edge bar, label pill, text style, tiled
   watermark — into a CSS/JS pair in the extension's global storage.
2. **Paint.** That script runs inside the workbench, walks the Explorer's row DOM,
   and applies the pre-computed values to each row.

Step 2 is the part VS Code doesn't sanction: the only way into the workbench is to
edit what it loads from disk. Premium Explorer can do that itself, or leave it to
`be5invis.vscode-custom-css`. **Until you turn painting on you get the badge and
nothing else** — every colour, bar, pill and watermark comes from the injected pair.

## Turning on background painting

Run **Premium Explorer: Enable Background Painting** from the Command Palette and
reload the window. That is the whole setup.

It writes the generated pair into your VS Code installation's workbench directory
and adds two lines to `workbench.html`:

```html
<link rel="stylesheet" href="./premium-explorer.css">
<script src="./premium-explorer.js"></script>
```

**Premium Explorer: Disable Background Painting (Restore Workbench)** undoes it.
The original `workbench.html` is backed up before the first patch and restored
byte-for-byte.

### Before you enable it

- **VS Code will report that your installation "appears corrupt."** `workbench.html`
  is checksummed, so any change trips that banner. It's safe to dismiss — it means
  the file differs from the shipped one, not that anything is broken.
- **A VS Code update reverts it.** Updates replace the whole directory. Premium
  Explorer notices on the next launch and offers to re-apply.
- **The first run may need permission.** VS Code's install directory is usually
  system-owned; if the patch can't be written you get the exact command to fix it.
- **Desktop only.** The patch has to be applied on the machine drawing the window,
  so this does nothing in the browser, or on the remote side of an SSH, WSL or
  container window. Rules and badges still work there.
- **It targets VS Code's internal DOM** (`.monaco-list-row`), which carries no
  compatibility promise — an update can change it.

Two deliberate differences from how vscode-custom-css patches the same file: the
Content Security Policy is left intact (custom-css deletes it), and the tags above
*reference* the generated files rather than carrying their contents, so changing a
setting rewrites only those two files and never revisits `workbench.html`.

### Using vscode-custom-css instead

Still supported. Install
[`be5invis.vscode-custom-css`](https://marketplace.visualstudio.com/items?itemName=be5invis.vscode-custom-css),
run **Premium Explorer: Generate Background CSS (for vscode-custom-css)** — which
writes the pair and adds it to `vscode_custom_css.imports` — then run **Reload
Custom CSS and JS** and restart. Don't enable both: two copies of the script would
paint every row twice. Enabling Premium Explorer's own painting removes its entries
from `vscode_custom_css.imports` for you.

Either way, editing any `premiumExplorer.*` setting regenerates the files and offers
a **Reload Window** button. After cloning or removing repositories, re-run the
generate (or enable) command so the new folders are picked up.

**Multiple workspaces:** the generated files are a single global set shared by
every window, but colors are scoped **per workspace** — the injected script only
paints the workspace shown in the current window, so opening a different project
doesn't inherit another one's colors. Within one workspace, folders are matched by
**name** (two folders with the same name there share a color).

## Settings

### Rules
- `premiumExplorer.rules` — the list described above. Each entry is
  `{ "path": string, "engine"?: "git" | "manual" | "default", "color"?: hex }`.
  `engine` defaults to `"default"`.
  A rule may also **override the global settings for that path** with optional
  `"rootOpacity"`, `"contentsOpacity"`, `"colorText"`, and — styled separately for
  the folder row vs. its contents — `"rootStyle"`/`"rootBackground"`/`"rootText"` and
  `"innerStyle"`/`"innerBackground"`/`"innerText"`. Example:
  `{ "path": "./notes", "engine": "manual", "color": "#00b8ff", "rootStyle": "pill", "innerStyle": "none" }`.
- `premiumExplorer.defaultColor` (`#808080`) — color used by the `default` engine.

### Coloring
- `premiumExplorer.enabled` (`true`) — master on/off.
- `premiumExplorer.colorText` (`true`) — tint label text. Turn off for
  background-only.
- `premiumExplorer.colorBy` (`"name"` | `"path"`, `"name"`) — what to hash for a
  git repo's automatic color.
- `premiumExplorer.palette` (string[], up to 16 hex) — the pool of automatic colors.
- `premiumExplorer.badge` (string, ≤ 2 chars) — optional badge on colored roots.

### Backgrounds (used by the generated files)
- `premiumExplorer.rootOpacity` (`0.5`) — background opacity of the colored root row.
- `premiumExplorer.contentsOpacity` (`0.15`) — background opacity of inner files.
- `premiumExplorer.rootStyle` (`"full"` | `"pill"` | `"edge"`) — how the **root** folder
  row is painted: `full` = whole row, `pill` = a rounded background behind just the
  label text, `edge` = a bar on the left side.
- `premiumExplorer.innerStyle` (`"full"` | `"pill"` | `"edge"` | `"none"`) — how the
  **contents** are painted, or `none` to leave them uncolored.
  Both are overridable per path (`"rootStyle"` / `"innerStyle"`), and a rule may set
  explicit `rootBackground`/`rootText`/`innerBackground`/`innerText` colors.
- `premiumExplorer.selectedBackgroundColor` (`"invert"` | hex) — selected row
  background. `invert` uses the folder's own color.
- `premiumExplorer.selectedTextColor` (`"auto"` | hex) — selected row text color.
- `premiumExplorer.selectedOpacity` (`1`) — opacity of the selected background.
- `premiumExplorer.selectedBold` (`true`) — bold the selected label.
- `premiumExplorer.selectedBorder` (`"auto"` | `"none"` | hex) — focus ring drawn
  around the selected row **while the Explorer is focused**. `auto` uses the theme's
  focus-outline color.
- `premiumExplorer.selectedInactiveDarken` (`0.25`) — how much darker the selection
  gets when the Explorer loses focus (0 = unchanged, 1 = black); the border is also
  dropped, mirroring VS Code's inactive selection.

## Commands

- **Premium Explorer: Enable Background Painting** — generate the CSS/JS pair and
  patch this VS Code install to load it.
- **Premium Explorer: Disable Background Painting (Restore Workbench)** — undo that
  patch and remove the files it added.
- **Premium Explorer: Refresh Decorations** — re-read settings and re-apply.
- **Premium Explorer: Generate Background CSS (for vscode-custom-css)** — (re)write
  the background files and wire up `vscode_custom_css.imports` instead.

## Architecture

```
src/
  extension.ts          Activation + event wiring (thin).
  config.ts             Reads settings; resolves rules to absolute paths, sorted
                        deepest-first so a deeper rule wins.
  colors.ts             Pure hex/rgba/hash helpers and the SVG watermark pattern
                        generator (no VS Code deps).
  decorationProvider.ts FileDecorationProvider. Adds the optional badge — the only
                        Explorer styling the API allows.
  repositoryScanner.ts  Recursively finds Git repos under a path (for git rules).
  backgroundStyles.ts   Resolves rules into colored folders and generates the
                        CSS/JS pair.
  layers.ts             Bakes one folder's row styling into ready-to-apply values.
  workbenchPatch.ts     Patches workbench.html to load that pair, and restores it.
                        Pure Node, no VS Code deps.
  injection.ts          The VS Code side of that: commands, prompts, and offering
                        the patch back after a VS Code update removes it.
media/
  inject.js             The browser script that does the painting. Static logic;
                        the per-folder colors are prepended at generate time.
```

## Development

```bash
pnpm install
pnpm run watch      # or press F5 to launch the Extension Development Host
pnpm run package    # type-check + lint + production bundle
```

## Publishing checklist

Before `vsce publish`, set in `package.json`:

- `publisher` — your VS Marketplace publisher id. **Note:** this changes the
  extension's storage path, so re-run **Generate Background CSS** and update your
  `vscode_custom_css.imports` afterward.
- `icon` — path to a 128×128 PNG.
- `repository` / `bugs` / `homepage` — once the repo is hosted.
