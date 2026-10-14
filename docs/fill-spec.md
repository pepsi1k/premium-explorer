# Fill spec — the shared multi-stop fill (EM-90)

The "Explorer Concepts" design handoff gives several features (root backgrounds
§2, edge bar §3, selection §5, pills §8) the same multi-stop fill. This is the
one spelling of that fill, the bake/paint split, and the rules every consumer
follows. Implementation: `parseFill()` / `resolveFill()` in
[src/colors.ts](../src/colors.ts).

## 1. The `Fill` type (settled spelling)

```ts
type ColorStop = string                       // "#rrggbb" / "#rrggbbaa" / "#rgb"
  | { color: string; alpha?: number; at?: number };  // alpha 0–1, at 0–100 (%)

type Fill = string | {                        // string = solid hex
  stops: ColorStop[];
  blend?: 'split' | 'gradient';               // default 'gradient'; split = hard edges
  direction?: 'vertical' | 'horizontal' | 'diagonal' | 'diagonal-reverse' | number;
                                              // default 'horizontal'; number = CSS deg
};
```

Decisions vs. the handoff:

- **`direction`, not `angle`** (the handoff's §8 JSON used `angle`; its README
  used `direction` — the README wins). A raw number is a CSS gradient angle in
  degrees, so `direction: 90` ≡ `'horizontal'`, `180` ≡ `'vertical'`.
- **`diagonal` is split into `diagonal` (135°) and `diagonal-reverse` (45°)** —
  the edge-bar section (§3) needs both diagonals and one word can't carry two.
- **No `shape` key in v1.** `radial`/`conic` exist only in §2's "at scale" mocks;
  per-row they are meaningless and at-scale they need the painter mechanism in
  §3 below. The key is *reserved* — `parseFill` rejects any object carrying an
  unknown blend, and a future `shape` extension stays additive.
- **Diagonal hard splits are hard-stop `linear-gradient`s**, never the
  handoff's clip-path triangles — clip-path interacts badly with inline row
  painting and the gradient form needs no painter change.
- A stop's `#rrggbbaa` alpha and its `alpha` field **multiply**; the layer's
  `*Opacity` setting multiplies on top of both. Alpha-0 stops stay invisible
  under any opacity.
- Positions: in `gradient` blend, `at` is the stop's position (CSS semantics:
  first defaults to 0, last to 100, gaps spread evenly, clamped monotonic). In
  `split` blend, `at` is where the stop's band **ends**; omitted ends divide
  the remaining run equally (`n` stops with no `at`s = `n` equal bands).

### Key naming

Flat `root*`/`inner*` keys, never nested objects:

| Feature | Key (plus `inner*` twin and per-rule override) |
| --- | --- |
| Background (EM-92) | `rootBackgroundFill` |
| Pill (EM-98) | `rootPillFill` |
| Selection (EM-95) | `selectedBackgroundFill` (global + per-rule, no root/inner split) |
| Edge bar (EM-93) | keeps `rootEdgeColors`; gains `rootEdgeDirection`, `rootEdgeBlend` |

A `*Fill` key applies only while the layer's style enum is `solid` — `none` and
`inherit` keep their exact current meaning (`inherit` adopts the ancestor's
whole **resolved** fill, stops and all, because it reuses the baked layer
object). Where both `*Fill` and the legacy `*Color` are set, `*Fill` wins; the
legacy key keeps working untouched.

## 2. Bake/paint responsibilities

`resolveFill(fill, opacity, lighten?, alphaBoost?)` returns a `ResolvedFill`:

```ts
{ color: string;   // "rgba(...)" when the fill collapses to one stop
  image: string;   // "linear-gradient(...)" otherwise — exactly one is set
  hex: string;     // the GROUND: opaque hex at the element's centre (t = 50%)
  alpha: number }  // the ground's alpha, opacity multiplier applied
```

- **Solid path unchanged:** a one-stop fill comes back as `color` and goes
  where solids go today (`row.style.backgroundColor`, pill background-color,
  the hover custom properties).
- **A gradient is a background *image*:** the painter's row stack is
  `backgroundColor` + stacked `backgroundImage`s (edge bar, text cover,
  watermark — `media/inject.js` `setBg`). A gradient fill joins that stack as
  the **bottom-most** image; everything else keeps painting over it.
- **Hover** variants are baked at generate time like today's solids:
  `resolveFill(fill, opacity, HOVER_LIGHTEN, HOVER_OPACITY_BOOST)` lifts every
  stop toward white and nudges alpha (an alpha-0 stop stays at 0 — a fade-in's
  invisible edge never surfaces on hover). A gradient's hover is a second short
  string, not a second watermark-sized canvas — cheap enough to bake always.
  The **pill** swaps it in through `--fc-pill-hover` (the hover rule uses the
  `background` shorthand). The **row background** does not: its hover custom
  property can only swap a color, and swapping the whole image stack per hover
  would reintroduce the EM-85 repaint cost — a gradient row fill keeps its
  resting look under the cursor.
- **At-scale fills (§2 item 4, EM-92)** are the one deliberate bend of "bake at
  generate time; the painter only picks": the bake ships the resolved gradient
  string, and the painter sizes it over the folder's block the same way the
  watermark is block-anchored today (fixed `background-size` = the folder
  block's rendered extent, `background-position` offsetting each row's slice).
  The folder's total height is only known in the browser. When the folder is
  partially scrolled out, the gradient spans the rendered extent the walk can
  see — the ends drift, which is accepted and documented. Linear only; radial/
  conic would need per-row 2-D repositioning of one shared image and are out
  of scope until someone asks.

## 3. The ground rule (derive-from-fill)

Four shipped mechanisms assume one color per row: hover/pill brighten,
`selectedShift`, `watermarkContrast`, and the git chip plate (EM-96). On a
multi-stop fill **the ground is the fill's color at the element's centre
(t = 50%)** — `split` takes the band covering the centre, `gradient`
interpolates color and alpha between the neighbouring stops. `ResolvedFill`
carries it as `hex`/`alpha`, baked next to the fill, so:

- `Part.solid` (what `"invert"`/`"shift"` selections and the watermark auto
  tint read) becomes the fill's ground hex.
- The painter's `flatten()` composites `hexToRgba(ground.hex, ground.alpha)`
  over the backdrop — it never parses a gradient string.
- Hover is **not** ground-derived: it lifts every stop, so a gradient stays a
  gradient under the cursor.

Centre-sample was chosen over stop-averaging because it is what actually sits
behind the label and the git letter in every §2/§8 mock (left edges fade to
transparent; averaging would report a color the row visibly isn't).

## 4. Delivery and themes

- Anything per-workspace (gradient **selection** fills, the coming `gitMark*`,
  `symlinkMarkColor`) rides the per-workspace unions in `globalState`
  (`premiumExplorer.workspaceColors` / `workspaceSelection`) exactly like
  `--fc-sel-fg` — never baked once into the shared global file, or the last
  window to generate wins.
- Baked fills are theme-independent user colors and may be baked. Every
  **"auto" derivation stays in the painter**, computed off the composited
  ground (which already accounts for the live theme): watermark auto tint,
  selection `"auto"` text, the EM-96 chip plates. The handoff's mock hexes
  (`#252526` tree, lifted git labels, `#8a8a92` arrow) are **dark-theme
  constants** — document them as examples, never bake them as defaults.
