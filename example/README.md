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
| `pills/` | The four §8 pill fills, plus square and fully-round variants. |
| `inner-styles/` | `inherit` (a nested rule adopting its parent's fill), children with their own fill, children left unpainted, and children carrying their own pill and edge bar. |
| `rotation/` | The same two-stop fill at 0°, 45°, 90°, 120° and 180° — a `direction` number is a CSS angle. |
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

A row is about 22px tall and a few hundred wide, so `horizontal` and the
diagonals have the most room to read; `vertical` runs within each row's own
height rather than across the whole folder block (stretching one fill over a
folder's full height is tracked separately as the "at scale" work).

## Tests

The same settings are the fixture for the automated check:

```bash
pnpm run compile-tests
node scripts/verify-example.js
```

It bakes this workspace with the real generator (the `vscode` API stubbed) and
asserts what reaches the painter for every folder above.
