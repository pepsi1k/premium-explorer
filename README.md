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

## What gets colored: labels vs. backgrounds

Out of the box the extension tints Explorer **label text**. This is the only kind
of Explorer styling the VS Code API allows — there is **no API to set row
background colors**. (Because `FileDecoration` can only reference a registered
`ThemeColor`, the extension bridges any custom hex into `workbench.colorCustomizations`
for you.)

To also color row **backgrounds**, see below.

## Background coloring (optional, via vscode-custom-css)

Install [`be5invis.vscode-custom-css`](https://marketplace.visualstudio.com/items?itemName=be5invis.vscode-custom-css)
(an unsupported extension that injects CSS/JS into the workbench), then:

1. Run **Premium Explorer: Generate Background CSS (vscode-custom-css)** from the
   Command Palette. It resolves your rules, writes two files into the extension's
   storage, and adds them to `vscode_custom_css.imports` for you.
2. Run **Reload Custom CSS and JS** (from vscode-custom-css) and restart.

After that, editing any `premiumExplorer.*` setting regenerates the files
automatically and offers a **Reload Window** button to apply the change.

**Caveats:** this targets VS Code's internal `.monaco-list-row` DOM, so a VS Code
update could break it; and after cloning/removing repos you should re-run the
generate command.

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

- **Premium Explorer: Refresh Decorations** — re-read settings and re-apply.
- **Premium Explorer: Generate Background CSS (vscode-custom-css)** — (re)write the
  background files and wire up `vscode_custom_css.imports`.

## Architecture

```
src/
  extension.ts          Activation + event wiring (thin).
  config.ts             Reads settings; resolves rules to absolute paths; maps a
                        folder to its color; bridges custom hexes into
                        workbench.colorCustomizations.
  colors.ts             Pure hex/rgba/hash helpers (no VS Code deps).
  decorationProvider.ts FileDecorationProvider that tints labels per rule.
  repositoryScanner.ts  Recursively finds Git repos under a path (for git rules).
  backgroundStyles.ts   Resolves rules into colored folders and generates the
                        vscode-custom-css CSS/JS files.
media/
  inject.js             The browser script injected by vscode-custom-css. Static
                        logic; the per-folder colors are prepended at generate time.
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
