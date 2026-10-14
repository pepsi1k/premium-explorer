# Example workspace

Open this folder in VS Code (with Premium Explorer installed and background
painting enabled, then quit and reopen) to see every feature configured, one
folder per case. Each demo folder holds files and a nested `src/lib/` so the
`inner*` layers are visible at more than one depth. The configuration is
[.vscode/settings.json](.vscode/settings.json).

| Group | What it shows |
| --- | --- |
| `backgrounds/` | A plain colour, then hard splits and blends in every named direction. Root rows at opacity `.55`, children at `.14`, as in the design handoff. |
| `alpha-gradients/` | The handoff's §2.6 mocks verbatim: fade-in, fade-out, island, two colours with a transparent gap, diagonal 120°, vertical 180°. These set `rootBackgroundOpacity: 1` so the per-stop alphas land exactly as designed. |
| `edge-bar/` | Band direction (horizontal, both diagonals), `blend: "gradient"`, and a single colour collapsing to a plain bar. |
| `pills/` | The four §8 pill fills, square and fully-round variants, and a padded pill (`[2, 10]` around the label). |
| `inner-styles/` | `inherit` (a nested rule adopting its parent's fill), children with their own fill, children left unpainted, and children carrying their own pill and edge bar. |
| `rotation/` | The same two-stop fill at 0°, 45°, 90°, 120° and 180° — a `direction` number is a CSS angle. |
| `at-scale/` | The same diagonal split at `block` scale (one slanted edge across the whole folder) and at `row` scale (the old per-row look), plus a vertical fill running down a block by default. |
| `radius/` | A rounded block plate, per-row rounding with per-corner values, a rounded edge bar, and per-corner pills. |
| `marks/` | A shipped glyph stamped after the root label, a character mark with its own colour, root and inner rows carrying different marks, and one mark enclosed by its pill (`rootMarkInPill`). |
| `watermark-layouts/` | The `right-edge`, `row` and `corner` layouts, two mixed-glyph canvases, a dense small-glyph field, and the "every glyph a name reaches drops to ~7%" setting. |
| `symlink/` | A folder that is itself a symlink, dimmed by `symlinkFolders: "dim"` and carrying `symlinkMark`, next to the real folder behind it. |
| `regression/` | A bare rule (paints nothing), `innerBackgroundStyle: "none"`, and a folder no rule names. |

## Direction and rotation

`direction` takes either a name or a number of degrees:

| Value | Angle | Runs |
| --- | --- | --- |
| `"vertical"` | 180° | top → bottom |
| `"horizontal"` | 90° | left → right |
| `"diagonal"` | 135° | top-left → bottom-right |
| `"diagonal-reverse"` | 45° | bottom-left → top-right |
| a number, e.g. `120` | that angle | any rotation you like |

A row is about 22px tall and a few hundred wide, so inside one row a diagonal has
only about 7% of its colour change left on the vertical axis — which is why a
per-row `diagonal` used to look exactly like `horizontal`, and why a per-row
`vertical` repeated its whole fade inside every 22px row.

That is what `*BackgroundFillScale` is for, and its default (`auto`) already
handles it: anything with a vertical component — both diagonals, `vertical`, any
angle that is not 90° or 270° — is stretched over the **folder's rendered block**,
where a 20-row folder puts ~60% of the change on the vertical axis and a diagonal
reads as a diagonal. A purely horizontal fill stays per-row, because it looks the
same either way. `at-scale/` shows the two scales side by side.

While a folder's end is scrolled out of view the block is the *rendered* extent,
so the fill's ends drift as you scroll. That is accepted: the alternative is
knowing a folder's full height, which the browser never does.

## Tests

The same settings are the fixture for the automated check:

```bash
pnpm run compile-tests
node scripts/verify-example.js
```

It bakes this workspace with the real generator (the `vscode` API stubbed) and
asserts what reaches the painter for every folder above — plus the parts of the
painter that can be measured without a workbench: the WCAG lift behind the git
marks, and the regression guards for EM-85/86/87/89/100/101.

`symlink/linked` is a committed symlink, so the symlink demo needs no setup; it
is excluded from the packaged extension along with the rest of `example/`.
