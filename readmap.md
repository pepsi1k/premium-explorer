

# Example structure
```
.
├── docker-compose
│   ├── gatus
│   ├── kodoreader
│   ├── linux-desktop
│   ├── ollama
│   └── zabbix-mcp-server
├── gitops
│   ├── app
│   ├── clusters
│   ├── infrastructure
│   └── readme.md
├── iac
│   ├── images
│   ├── provisioning
│   ├── pulumi
│   ├── readme.md
│   ├── stuff
│   └── terragrunt
└── .vscode
    ├── docker.svg
    ├── fluxcd.svg
    ├── pulumi.svg
    └── settings.json
```

# Requiremnts

- *Most important* Be able to color backgrounds of selected folders
    ```json

    ```
- Additional to selected folder
- By default you can color folders that

# Explorer Concepts — main features

Pulled from the Claude Design project **Premium Explorer UI concepts**
(`3fb1d620-c30c-4168-a856-7983bf55deae`, canvas `Explorer Concepts.dc.html`).
That canvas was built against this repo on 2026-09-15 and mocks everything at
real Explorer scale — 22px rows, 13px labels. Four treatments below, each with
the settings it proposes and where it stands against today's code.

## 1. Right-edge glyph watermark

Move the glyph field to the **right edge**, away from the labels, instead of
letting it compete with the text down the middle. A glyph that a long name
actually reaches drops hard — 34% → 5% opacity, not merely softened — so it
reads as "cleared out of the way" rather than muddy.

Variants mocked:

- **Dense scatter** — many small copies, a Telegram-sticker-pattern feel.
- **Single corner badge** — one oversized glyph bleeding off the corner.
- **Mixed symbols** — no icon file needed; a good default for a folder with no
  matching logo.
- **Several icons in one watermark** — for a folder spanning several tools, each
  glyph drawn from a different icon instead of one repeated.

Glyph count should grow with the folder's height while density (opacity,
spacing) stays constant.

*Status — mostly already built.* `watermarkDensity` is per 100×100px of canvas
and the pattern tiles, so count already scales with height
([colors.ts:260](src/colors.ts#L260)). Per-glyph text dimming exists too: `spots`
records where each copy landed and the painter matches them against a row's label
([colors.ts:274](src/colors.ts#L274), [inject.js:378](media/inject.js#L378),
[inject.js:402](media/inject.js#L402)).

Genuinely new: the clearing is currently **centred** down the middle of the pane,
"where the filenames run" ([colors.ts:275-292](src/colors.ts#L275-L292)), so
biasing the scatter to the right edge is a *placement* change, not a dim change.
The harder 34% → 5% falloff is a curve/parameter change on top. Mixing several
icons in one watermark needs `WatermarkArt` to become a list — it is a single
drawing today ([colors.ts:141](src/colors.ts#L141)).

## 2. Diagonal two-colour split background

The row background splits along a top-left → bottom-right diagonal into two
independently-styled triangles, each flat or carrying its own gradient — so a
folder can hold two affinities at once (the mock's analogy: a PoE stash tab
carrying two colours). Three modes: solid one colour (today's default), solid
multiple colours with a hard edge, and multiple colours blended.

Proposed settings:

```jsonc
"rootBackgroundColors":      [],                 // string[]
"rootBackgroundSplit":       "diagonal",         // | "vertical" | "horizontal"
"rootBackgroundBlend":       "hard",             // | "gradient"
"rootBackgroundGradientType": "linear"           // | "radial" | "conic"
```

At scale the mock stretches a colour list over a tall folder and treats the
gradient's own shape as a setting — linear, radial, conic.

*Status — new.* The background layer takes a single `backgroundColor` plus
`backgroundOpacity` today ([config.ts](src/config.ts)). Per the "Adding a layer
setting" note in [CLAUDE.md](CLAUDE.md), each of these keys lands in at least
four places: the `contributes.configuration` schema in
[package.json](package.json), the `PartConfig` interface, `readPart()` and
`readPartOverride()` in [config.ts](src/config.ts), then
[layers.ts](src/layers.ts) and [media/inject.js](media/inject.js). The proposed
names already follow the repo's flat `root*`/`inner*` convention.

## 3. Left-edge accent bar

A thin coloured bar on the row's left edge — the same idea as VS Code's
git-decoration stripe, driven by the folder rule instead. Same colour-list
settings as the background: solid, multiple colours, or a gradient, laid out
horizontally or on either diagonal. The mock uses a 6px bar so the split reads
clearly.

Proposed settings:

```jsonc
"edgeSplit": "horizontal",   // | "left-diagonal" | "right-diagonal"
"edgeBlend": "hard"          // | "gradient"
```

*Status — largely already built.* `edge`, `edgeColor`, `edgeColors` ("explicit
colour sequence for the bar; empty = auto-derived from the folder's hash"),
`edgeWidth` and `edgeStripeSize` all exist in `PartConfig`
([config.ts](src/config.ts)), and `stripeGradient()` already renders a
multi-colour bar ([colors.ts:97](src/colors.ts#L97)). New is only the
*direction* and *blend*: the stripe is a hard-coded 45° `repeating-linear-gradient`
today ([colors.ts:108](src/colors.ts#L108)), so `edgeSplit` generalises the angle
and `edgeBlend` swaps the repeating stripe for a blended ramp.

## 4. Root directory marks

One fixed, hand-picked mark per rule — not scattered, not randomised — sitting
right after the root label, the way Telegram Premium places a chosen sticker
straight after someone's name. Real icons from the shipped set (git, claude,
terraform), placed once and left at **full colour** instead of tiled and tinted.

Proposed setting: `rootMark`, alongside the existing
`backgroundWatermarkSymbol`.

*Status — new, and the most architecturally interesting.* Placing a mark after
the label means knowing where the label ends, which the painter already computes
— `textEnd()` at [inject.js:378](media/inject.js#L378). Two constraints from
[CLAUDE.md](CLAUDE.md) to respect: the watermark pipeline calls `neutralizeSvg()`
to strip an SVG's own fills so it takes one flat tint, so a full-colour mark must
bypass that path (`watermarkColor: "original"` is the existing opt-out); and
every write in `inject.js` must stay inline and `data-fc-*`-tracked.

## Cross-cutting caveats

These are UI concepts, and the extension's real rendering surface is generated
CSS injected into the workbench by the extension's own patch — so two invariants
bound all four:

- **Folders are matched by *name*, not path, in the browser.** The DOM has no
  paths, so two same-named folders in one workspace share a mark and a colour.
  A per-rule `rootMark` inherits that limit.
- **One global generated file serves every window.** Anything baked once for the
  whole file is decided by whichever window generated last — a bug every time the
  setting behind it is per-workspace. New per-rule colour lists and marks need
  the same per-workspace treatment as `premiumExplorer.workspaceColors`.
