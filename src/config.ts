/**
 * Reads and resolves all `premiumExplorer.*` settings into a single, ready-to-use
 * {@link FolderColorerConfig}, and resolves the base color for any folder.
 *
 * The core model is a list of path-scoped **rules** (see `premiumExplorer.rules`):
 *   - a `git` rule auto-colors every repository found under its path;
 *   - a `manual` rule colors its folder (and everything inside) with a fixed hex.
 * For any folder we pick the **deepest matching rule** (most specific path).
 *
 * Each folder is painted by four **independent, composable layers** — background
 * fill, left edge bar, pill, and text — configured separately for the repo root
 * row ({@link PartConfig} `root`) and the inner rows (`inner`). Global defaults
 * come from `premiumExplorer.root*`/`inner*`; a rule may override any layer per path.
 * All painting is done by the generated CSS/JS (see backgroundStyles.ts), which
 * uses resolved hex colors directly — there is no ThemeColor bridging anymore.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Fill, FillDirection, HEX_RE, Radius, StripeBlend, WatermarkLayout, hashString, normalizePath, parseFill, parseRadius } from './colors';

export const CONFIG_SECTION = 'premiumExplorer';

/** Built-in palette; mirrors the defaults contributed in package.json. */
export const DEFAULT_PALETTE = [
  '#e6194b', '#3cb44b', '#f58231', '#4363d8',
  '#911eb4', '#008080', '#f032e6', '#9a6324',
  '#808000', '#c99700', '#2a9d8f', '#d62728',
  '#7f4fc9', '#1f9e89', '#b5651d', '#5d8aa8',
];

export type Engine = 'git' | 'manual';

/**
 * How a folder that is **itself** a symlink is painted when a rule names its path.
 * It would otherwise be indistinguishable from the folder it points at, so it is
 * left alone unless the user asks for it.
 *   `none`   — never painted, even though a rule names it (the default).
 *   `dim`    — painted in the rule's color but dimmer, so it reads as a link.
 *   `normal` — painted exactly like a real folder.
 */
export type SymlinkStyle = 'none' | 'dim' | 'normal';
const SYMLINK_STYLES: readonly SymlinkStyle[] = ['none', 'dim', 'normal'];
function parseSymlinkStyle(value: unknown): SymlinkStyle | undefined {
  return SYMLINK_STYLES.includes(value as SymlinkStyle) ? value as SymlinkStyle : undefined;
}

/**
 * How a fill layer (background/edge/pill) is drawn:
 *   - `none`    — not painted at all (bare VS Code styling);
 *   - `solid`   — painted with this layer's own color;
 *   - `inherit` — reuse whatever the nearest **enclosing** colored folder paints
 *                 on its inner rows, so a nested rule blends into its parent
 *                 instead of punching a hole in it. With nothing enclosing the
 *                 folder it falls back to {@link NO_ANCESTOR_FALLBACK}.
 */
export type LayerStyle = 'none' | 'solid' | 'inherit';
/** Label weight/style. */
export type TextStyle = 'none' | 'bold' | 'italic' | 'bold-italic';

const LAYER_STYLES: readonly LayerStyle[] = ['none', 'solid', 'inherit'];
const TEXT_STYLES: readonly TextStyle[] = ['none', 'bold', 'italic', 'bold-italic'];

function parseLayerStyle(value: unknown): LayerStyle | undefined {
  return LAYER_STYLES.includes(value as LayerStyle) ? value as LayerStyle : undefined;
}

/**
 * How far a multi-stop background fill is stretched.
 *   `row`   — each row paints the whole fill in its own 22px box (the historical
 *             behaviour, and the only one that makes sense for a horizontal fill).
 *   `block` — one fill stretched over the folder's rendered block, each row
 *             showing the slice that belongs at its depth. The folder's height is
 *             only known in the browser, so the painter sizes it (see inject.js).
 *   `auto`  — `block` for any direction with a vertical component, `row` for a
 *             purely horizontal one. A diagonal or vertical fill has ~7% of its
 *             colour change left on the vertical axis inside one row, which is why
 *             diagonals used to be indistinguishable from horizontal ones (EM-104).
 */
export type FillScale = 'auto' | 'row' | 'block';

/**
 * What a corner radius is rounded *around*.
 *   `block` — the folder's rendered block reads as one plate: the root row takes
 *             the top corners, the last row rendered under it the bottom ones,
 *             everything between stays square (the default — a stack of
 *             separately rounded 22px bars is almost never what "rounded" means).
 *   `row`   — every row rounds its own box.
 * Inert until a radius is actually set.
 */
export type RadiusScale = 'row' | 'block';
function parseRadiusScale(value: unknown): RadiusScale | undefined {
  return value === 'row' || value === 'block' ? value : undefined;
}
const FILL_SCALES: readonly string[] = ['auto', 'row', 'block'];
function parseFillScale(value: unknown): FillScale | undefined {
  return typeof value === 'string' && FILL_SCALES.includes(value) ? value as FillScale : undefined;
}

const FILL_DIRECTIONS: readonly string[] = ['vertical', 'horizontal', 'diagonal', 'diagonal-reverse'];
function parseFillDirection(value: unknown): FillDirection | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return typeof value === 'string' && FILL_DIRECTIONS.includes(value) ? value as FillDirection : undefined;
}
function parseStripeBlend(value: unknown): StripeBlend | undefined {
  return value === 'bands' || value === 'gradient' ? value : undefined;
}
function parseTextStyle(value: unknown): TextStyle | undefined {
  return TEXT_STYLES.includes(value as TextStyle) ? value as TextStyle : undefined;
}

/** A validated hex string, or undefined (empty string included -> undefined = "use base/default"). */
function hexOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_RE.test(value) ? value : undefined;
}
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
/** The valid hex entries of a settings array, or an empty array. */
function hexArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((c): c is string => typeof c === 'string' && HEX_RE.test(c))
    : [];
}

/**
 * The four composable layers for one row-kind (root or inner). A `*Color` of
 * `undefined` means "use the folder's base color" (or, for text, "leave to the
 * theme"). Opacity is authoritative for each fill layer's alpha.
 */
export interface PartConfig {
  backgroundStyle: LayerStyle;
  backgroundColor?: string;
  /**
   * Multi-stop fill for the row background (the shared `Fill` — see
   * docs/fill-spec.md). Applies only while `backgroundStyle` is `solid`, and
   * wins over `backgroundColor`.
   */
  backgroundFill?: Fill;
  /** How far {@link backgroundFill} is stretched: per row, or over the folder's block. */
  backgroundFillScale: FillScale;
  backgroundOpacity: number;
  edge: LayerStyle;
  edgeColor?: string;
  edgeOpacity: number;
  /** Explicit colour sequence for the bar; empty = auto-derived from the folder's hash. */
  edgeColors: string[];
  /** Bar width in px. */
  edgeWidth: number;
  /** Thickness in px of one diagonal stripe band. */
  edgeStripeSize: number;
  /**
   * Where the bar's stripe runs (the shared Fill spelling): `diagonal-reverse`
   * is the historical 45° stripe, `vertical` stacks the bands horizontally, a
   * number is a CSS angle in degrees.
   */
  edgeDirection: FillDirection;
  /** Hard `bands` (the historical look), or the sequence blended into a `gradient`. */
  edgeBlend: StripeBlend;
  pill: LayerStyle;
  pillColor?: string;
  /**
   * Multi-stop fill for the pill (the shared `Fill` — see docs/fill-spec.md).
   * Applies only while `pill` is `solid`, and wins over `pillColor`.
   */
  pillFill?: Fill;
  pillOpacity: number;
  /** Pill corner radius: a number, or the per-corner CSS form (see {@link Radius}). */
  pillRadius: Radius;
  /**
   * Space the pill leaves around the label, in px. A single number is
   * **horizontal only** — the shipped pill is `0 5px` and `5` has to keep meaning
   * that; `[v, h]` and the three/four-value CSS forms work as in CSS.
   */
  pillPadding: Radius;
  /**
   * Grow the pill rightwards so it encloses the {@link mark} instead of letting it
   * sit just outside. A no-op where no pill or no mark is painted.
   */
  markInPill: boolean;
  /**
   * How the pill's plate is placed around the label (EM-118). Both settings keep
   * the **text** lined up with every unpilled row at the same depth — they differ
   * only in where the plate goes, because a plate can never reach left of the
   * label on its own (three `overflow: hidden` ancestors begin exactly there).
   */
  pillAlign: PillAlign;
  /**
   * Corner radius for the row fill. Applied as a `border-radius` on the row, which
   * clips *every* background layer at once — fill, edge bar and watermark — so it
   * rounds the whole painted plate. `radiusScale` decides whether that is the row
   * or the folder's block.
   */
  backgroundRadius: Radius;
  /**
   * Corner radius for the edge bar. The bar is a background image and an image
   * cannot carry a radius of its own, so this rounds the row's *left* corners —
   * exactly the two the bar occupies. An inset capsule bar would need its own
   * element and is deliberately out of scope (see the key's description).
   */
  edgeRadius: Radius;
  textStyle: TextStyle;
  textColor?: string;
  /**
   * A single fixed glyph stamped just after the label — the **mark** (EM-94).
   * Takes the same sources as `backgroundWatermarkSymbol` (a shipped glyph name,
   * an `.svg` path, inline markup, a data URI, or a character), and keeps the
   * drawing's own colours unless {@link markColor} names a tint. Empty = no mark.
   *
   * It does not compete with git's letter: that one lives in VS Code's single
   * `FileDecoration` badge slot, while the mark is painted by the injected CSS, so
   * both can show at once.
   */
  mark?: string;
  /** Hex tint for the mark; unset keeps an SVG's own colours. */
  markColor?: string;
  /** The mark's size in px (it is square). */
  markSize: number;
  /** Gap in px between the end of the row's text and the mark. */
  markGap: number;
  /**
   * The glow behind the row's label (EM-116) — a soft blurred halo around the
   * text, `off` by default. No `inherit`: a glow is a deliberate per-folder
   * choice, and the styles are not interchangeable the way a fill colour is.
   */
  glowEffect: GlowStyle;
  /**
   * Colours for the glow. Empty derives them from the folder's own sequence,
   * exactly as the edge bar derives its stripes, so a glow set globally still
   * gives every folder its own. `aurora` is the only style that reads a second
   * colour; the rest take the first and ignore the others.
   */
  glowColors: string[];
  /**
   * 0..100 — scales the alpha of every stop the chosen style draws. 100 is the
   * approved design (see the canvas on EM-116); lower fades the whole glow
   * without changing its shape.
   */
  glowIntensity: number;
  /**
   * Blur radius in px. Clamped to {@link GLOW_MAX_SPREAD} so the glow stays
   * inside the 22px row instead of bleeding into its neighbours, and it scales
   * the `soft`/`neon` shadow radii in the same proportion.
   */
  glowSpread: number;
  /**
   * Also light the **label text itself**, on top of whatever `glowEffect` draws.
   * Off by default: `halo`, `aurora` and `underglow` put their light *behind* the
   * text and leave the glyphs alone, which is what the approved design shows, so
   * this only ever adds. `soft` and `neon` already are a text glow and ignore it.
   */
  glowText: boolean;
  /** The tiled watermark behind the row. */
  watermarkStyle: LayerStyle;
  /** Hex tint, or `"original"` to keep an SVG's own colors. */
  watermarkColor?: string;
  /**
   * With no `watermarkColor`, how far the watermark steps off the fill color it
   * inherits, as a fraction of the distance to black/white — enough to lift clear
   * of the row without becoming a colour of its own. Resolved in the browser (see
   * inject.js), where the color the row composites to is known.
   */
  watermarkContrast: number;
  /**
   * 0..1 — how far the watermark is dimmed at the centre of the Explorer, where
   * the names run. Applied in the browser (see inject.js), where the pane's width
   * is known — the field has to stay centred on it as it is resized.
   */
  watermarkDim: number;
  /** Which dimming applies: the baked clearing, the text cover, or both. */
  watermarkDimStyle: WatermarkDimStyle;
  /**
   * How the copies are arranged on the canvas: the jittered field, a band at the
   * right edge, one line in the top band, or a single corner badge (see
   * {@link WatermarkLayout}).
   */
  watermarkLayout: WatermarkLayout;
  /** The lens's width in px — the clearing is baked into the canvas, so it is fixed. */
  watermarkDimWidth: number;
  /** The lens's height in px: how far apart its points sit down the canvas. */
  watermarkDimHeight: number;
  watermarkOpacity: number;
  /** Watermark size in px (the average — individual watermarks vary by `watermarkVariation`). */
  watermarkSize: number;
  /** Size in px of the square canvas the watermarks are scattered across. */
  watermarkCanvas: number;
  /** Watermarks per 100x100px of canvas. */
  watermarkDensity: number;
  /** 0..1 — how much watermark size, brightness and position vary. */
  watermarkVariation: number;
  /** Max tilt in degrees; each copy is rotated somewhere in +/- this. */
  watermarkRotation: number;
}

/**
 * How the watermark gets out of the way.
 *   `radius` — a clearing baked down the middle of the canvas: fewer, fainter
 *              copies where the names run, full strength out in the margins.
 *   `text`   — every copy a row's text actually reaches is dimmed, whole.
 *   `smart`  — both. The clearing does the general work and breaks up the
 *              pattern; the text cover catches whatever a long name still runs
 *              into, which the clearing alone cannot know about.
 */
export type WatermarkDimStyle = 'smart' | 'text' | 'radius';

/**
 * Where a pill's plate sits relative to its label (EM-118).
 *   `hug`   — the default. No shift and no left inset: the plate starts at the
 *             first glyph, which is exactly where an unpilled row's text starts,
 *             so the gap between a row's chevron and its content is the same
 *             whether the row carries a pill or not (EM-120).
 *   `shift` — the row's label block is moved left by {@link PartConfig.pillPadding}'s
 *             left value, so the plate keeps that inset and the text still lands
 *             where an unpilled row's text lands. The padding is what decides how
 *             far left the plate reaches — and the plate then sits that much
 *             closer to the chevron than an unpilled row's text does.
 */
export type PillAlign = 'shift' | 'hug';

const PILL_ALIGNS: readonly string[] = ['shift', 'hug'];

function parsePillAlign(raw: unknown): PillAlign | undefined {
  return typeof raw === 'string' && PILL_ALIGNS.includes(raw) ? raw as PillAlign : undefined;
}

/**
 * How the label glow is drawn (EM-116). Three of them draw in a pseudo-element
 * and so need the generated stylesheet; `soft` and `neon` are pure `text-shadow`,
 * which an inline style can set on its own.
 *   `halo`      — a blurred plate behind the text, masked so no box edge shows.
 *   `soft`      — two soft text-shadow rings in the glow colour.
 *   `neon`      — three tighter rings, light to dark, for a tube-light look.
 *   `aurora`    — the `halo` plate with two colours, lobed left and right.
 *   `underglow` — a thin blurred bar under the text rather than behind it.
 */
export type GlowStyle = 'off' | 'halo' | 'soft' | 'neon' | 'aurora' | 'underglow';

/** The spread beyond which a glow starts bleeding out of a 22px row. */
export const GLOW_MAX_SPREAD = 4;

const GLOW_STYLES: readonly string[] = ['off', 'halo', 'soft', 'neon', 'aurora', 'underglow'];

function parseGlowStyle(raw: unknown): GlowStyle | undefined {
  return typeof raw === 'string' && GLOW_STYLES.includes(raw) ? raw as GlowStyle : undefined;
}

const WATERMARK_LAYOUTS: readonly string[] = ['scatter', 'right-edge', 'row', 'corner'];
function parseWatermarkLayout(value: unknown): WatermarkLayout | undefined {
  return typeof value === 'string' && WATERMARK_LAYOUTS.includes(value) ? value as WatermarkLayout : undefined;
}
const WATERMARK_DIM_STYLES: readonly string[] = ['smart', 'text', 'radius'];

function parseDimStyle(raw: unknown): WatermarkDimStyle | undefined {
  return typeof raw === 'string' && WATERMARK_DIM_STYLES.includes(raw) ? raw as WatermarkDimStyle : undefined;
}

/** Global default parts, mirroring the defaults contributed in package.json. */
const ROOT_DEFAULTS: PartConfig = {
  backgroundStyle: 'solid', backgroundFillScale: 'auto', backgroundOpacity: 0.5,
  edge: 'none', edgeOpacity: 1, edgeColors: [], edgeWidth: 3, edgeStripeSize: 6, edgeDirection: 'diagonal-reverse', edgeBlend: 'bands',
  pill: 'none', pillOpacity: 1, pillRadius: 6, pillPadding: 5, markInPill: false, pillAlign: 'hug', backgroundRadius: 0, edgeRadius: 0,
  textStyle: 'none',
  markSize: 14, markGap: 6,
  glowEffect: 'off', glowColors: [], glowIntensity: 100, glowSpread: 3, glowText: false,
  watermarkStyle: 'none', watermarkContrast: 0.15, watermarkDim: 0.7, watermarkDimStyle: 'smart', watermarkLayout: 'scatter', watermarkDimWidth: 260, watermarkDimHeight: 560, watermarkOpacity: 0.3, watermarkSize: 24, watermarkCanvas: 512, watermarkDensity: 4, watermarkVariation: 0.4, watermarkRotation: 40,
};
const INNER_DEFAULTS: PartConfig = {
  backgroundStyle: 'inherit', backgroundFillScale: 'auto', backgroundOpacity: 0.15,
  edge: 'inherit', edgeOpacity: 1, edgeColors: [], edgeWidth: 3, edgeStripeSize: 6, edgeDirection: 'diagonal-reverse', edgeBlend: 'bands',
  pill: 'inherit', pillOpacity: 1, pillRadius: 3, pillPadding: 5, markInPill: false, pillAlign: 'hug', backgroundRadius: 0, edgeRadius: 0,
  textStyle: 'none',
  markSize: 14, markGap: 6,
  glowEffect: 'off', glowColors: [], glowIntensity: 100, glowSpread: 3, glowText: false,
  watermarkStyle: 'inherit', watermarkContrast: 0.15, watermarkDim: 0.7, watermarkDimStyle: 'smart', watermarkLayout: 'scatter', watermarkDimWidth: 260, watermarkDimHeight: 560, watermarkOpacity: 0.3, watermarkSize: 24, watermarkCanvas: 512, watermarkDensity: 4, watermarkVariation: 0.4, watermarkRotation: 40,
};

/**
 * What an `inherit` layer resolves to when nothing encloses the folder (a
 * top-level colored folder). Mirrors the historical defaults, so a lone repo
 * still gets its solid fill and no stray edge/pill appears.
 */
export const NO_ANCESTOR_FALLBACK = {
  background: 'solid',
  edge: 'none',
  pill: 'none',
  watermark: 'none',
} as const;

/** A rule resolved to a concrete absolute path. */
export interface ResolvedRule {
  absPath: string;
  engine: Engine;
  /**
   * Artwork tiled behind this folder's rows: the name of a glyph shipped in
   * `assets/svg` (`docker`, `terraform`, ...), a character/emoji, or a path to an
   * `.svg` file (also inline `<svg>` markup or a data URI). Falls back to the
   * global `backgroundWatermarkSymbol`, then to the folder name's initial.
   *
   * More than one entry mixes them: every copy on the canvas picks one, seeded off
   * the folder so the mix is stable (EM-91 §5/§6).
   */
  backgroundWatermarkSymbol?: string[];
  /**
   * Whether this folder's corner radii round each row or the whole block. Not a
   * layer key: block rounding needs the root row and the last inner row to agree,
   * so it belongs to the folder, not to one row-kind.
   */
  radiusScale?: RadiusScale;
  /** Per-rule layer overrides for the root row / inner rows (merged over the globals). */
  root?: Partial<PartConfig>;
  inner?: Partial<PartConfig>;
}

export interface SelectionConfig {
  /** `"shift"` (the row's own color, lifted), `"invert"` (the folder's color), or a hex. */
  background: string;
  /**
   * Multi-stop fill for the selection (the shared `Fill` — see
   * docs/fill-spec.md). When set it wins over `background` entirely; the
   * painter derives text/watermark/border off its ground.
   */
  fill?: Fill;
  /** 0..1 — how far `"shift"` lifts the row's own color off itself. */
  shift: number;
  /** `"auto"` (contrast) or a hex text color. */
  text: string;
  opacity: number;
  bold: boolean;
  /** Focus-ring while the Explorer is focused: `"none"`, `"auto"` (theme), or a hex. */
  border: string;
  /** How much darker the selection is while the Explorer is unfocused (0..1). */
  inactiveDarken: number;
  /** Which styles the selection color takes over; everything else paints as usual. */
  overrides: SelectedOverride[];
  /** Watermark color on a selected row: `"auto"` (a shade off the selection) or a hex. */
  watermark: string;
  /** 0..1 — how far the `"auto"` watermark sits off the selection color. */
  watermarkContrast: number;
  /** How a row being renamed is treated (see {@link RenameStyle}). */
  renameStyle: RenameStyle;
}

/**
 * How a row looks while its inline rename box is open, on top of the step the row
 * itself takes (`EDIT_SHIFT` in inject.js).
 *   `dim`   — the box gets out of the way entirely: transparent field, the row's
 *             own fill and watermark carrying through, a border marking where the
 *             typing goes (the default, and what shipped before this key).
 *   `field` — the box shows as a real inset text field in the theme's own input
 *             colours, over the shifted row.
 *   `edge`  — `dim`, plus the edge bar switches to the theme's focus accent for as
 *             long as the box is open. This is the **one** exception to "the edge
 *             bar always keeps its own colours": it is opt-in, it lasts only while
 *             a rename is actually open, and renaming — unlike selection — is the
 *             one state where saying *where the typing is* outranks saying which
 *             folder the row belongs to.
 */
export type RenameStyle = 'dim' | 'field' | 'edge';
const RENAME_STYLES: readonly string[] = ['dim', 'field', 'edge'];
function parseRenameStyle(value: unknown): RenameStyle | undefined {
  return typeof value === 'string' && RENAME_STYLES.includes(value) ? value as RenameStyle : undefined;
}

/**
 * A style the selection color may take over rather than leave alone. The edge bar
 * is deliberately not one of them: it is the row's narrowest mark and the only one
 * that still says which folder a selected — or renaming — row belongs to, so it
 * always keeps its own colours.
 */
export type SelectedOverride = 'background' | 'watermarks' | 'text-color' | 'pills';
const SELECTED_OVERRIDES: readonly string[] = ['background', 'watermarks', 'text-color', 'pills'];

/* ------------------------------------------------------------------------- *
 * Git marks (EM-96)
 * ------------------------------------------------------------------------- */

/**
 * How Git's status marks are painted once a background is under them.
 *   `bare`    — exactly what VS Code does: the status colour untouched. Over an
 *               amber fill that is 3.4:1 for modified and 1.3:1 for deleted, so
 *               this is the state the ticket calls a defect; it is kept as an
 *               opt-out, not as the default.
 *   `chip`    — the filename, the letter and the folder dot are lifted clear of
 *               the row, and the letter gets a plate stepped off the row's ground
 *               with a border in Git's own colour. The default **wherever a
 *               background actually paints**; a row with no fill keeps `bare`,
 *               because there is nothing there to fail against.
 *   `outline` — the lift, with a border in the lifted hue and no plate.
 *   `solid`   — the status colour becomes the plate and the letter is knocked out
 *               of it, lifted until the knockout reads.
 *   `none`    — the letter and the dot are hidden; the filename still lifts.
 */
export type GitMarkStyle = 'bare' | 'chip' | 'outline' | 'solid' | 'none';
const GIT_MARK_STYLES: readonly string[] = ['bare', 'chip', 'outline', 'solid', 'none'];
function parseGitMarkStyle(value: unknown): GitMarkStyle | undefined {
  return typeof value === 'string' && GIT_MARK_STYLES.includes(value) ? value as GitMarkStyle : undefined;
}

/** The four statuses Git decorates a row with. */
export type GitStatus = 'modified' | 'added' | 'untracked' | 'deleted';
const GIT_STATUSES: readonly GitStatus[] = ['modified', 'added', 'untracked', 'deleted'];

/**
 * One of the git-mark colours: a hex, `"auto"` (derived in the painter off what
 * the row actually shows — see docs/fill-spec.md §4), `"off"` (leave whatever VS
 * Code painted alone), or a per-status map of those.
 *
 * The handoff's mock hexes (`#E2C08D` modified, lifted `#F8E7C8`, …) are
 * dark-theme constants and are deliberately **not** defaults: `"auto"` derives
 * them from the live theme and the live fill instead.
 */
export type GitColor = string | Partial<Record<GitStatus, string>>;

function parseGitColor(raw: unknown): GitColor | undefined {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return v === 'auto' || v === 'off' ? v : hexOrUndefined(raw);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const map: Partial<Record<GitStatus, string>> = {};
  for (const status of GIT_STATUSES) {
    const one = parseGitColor((raw as Record<string, unknown>)[status]);
    if (typeof one === 'string') {
      map[status] = one;
    }
  }
  return Object.keys(map).length ? map : undefined;
}

/** All `premiumExplorer.git*` settings, resolved. */
export interface GitMarkConfig {
  style: GitMarkStyle;
  /** The status letter's ink. */
  color: GitColor;
  /** The letter's plate (`chip`/`solid`). */
  background: GitColor;
  /** The letter's border. */
  border: GitColor;
  /** The filename's colour. */
  label: GitColor;
  /** The dot on a folder containing changes. */
  folderDot: GitColor;
  /**
   * The **symlink arrow** VS Code appends to the same badge (`⤷`). Only applies
   * where it is the whole badge: beside a status letter the two share one
   * `::after`, and Git's colouring governs. `"auto"` is the tree's icon
   * foreground, and a selected row swaps it for `selectedTextColor`, exactly as
   * the letter does (design §7).
   */
  symlink: GitColor;
  /** The WCAG contrast ratio an `"auto"` colour is lifted to. */
  contrast: number;
}

/** All settings, resolved into ready-to-use values. */
export interface FolderColorerConfig {
  enabled: boolean;
  colorBy: 'name' | 'path';
  symlinkStyle: SymlinkStyle;
  badge?: string;
  palette: string[];
  /** How many colours an auto-derived edge sequence uses (1 = a plain solid bar). */
  edgeColorCount: number;
  /**
   * Default artwork for the watermark: built-in glyph names, characters/emoji, or
   * paths to `.svg` files. Empty = each folder uses the first letter of its own
   * name; more than one entry mixes them across the canvas.
   */
  backgroundWatermarkSymbol: string[];
  /** Whether corner radii round each row or the folder's whole block. */
  radiusScale: RadiusScale;
  /** How Git's status marks are kept readable over a painted row (EM-96). */
  git: GitMarkConfig;
  /**
   * Artwork stamped on a folder that is itself a symlink and that a rule names —
   * **our own** mark, because VS Code draws none (EM-97). Empty = no mark.
   */
  symlinkMark?: string;
  /** Tint for {@link symlinkMark}; unset keeps an SVG's own colours. */
  symlinkMarkTint?: string;
  /** Global default layers for the repo root row and the inner rows. */
  root: PartConfig;
  inner: PartConfig;
  selection: SelectionConfig;
  /** Rules sorted by path depth, deepest first (so the first match is the most specific). */
  rules: ResolvedRule[];
}

/** The flat setting/rule keys for one row-kind, read into a {@link PartConfig}. */
type PartInput = Record<string, unknown>;

/** Read a full {@link PartConfig} from the flat `${prefix}*` keys, falling back to `defaults`. */
function readPart(get: (key: string) => unknown, prefix: 'root' | 'inner', defaults: PartConfig): PartConfig {
  return {
    backgroundStyle: parseLayerStyle(get(`${prefix}BackgroundStyle`)) ?? defaults.backgroundStyle,
    backgroundColor: hexOrUndefined(get(`${prefix}BackgroundColor`)),
    backgroundFill: parseFill(get(`${prefix}BackgroundFill`)),
    backgroundFillScale: parseFillScale(get(`${prefix}BackgroundFillScale`)) ?? defaults.backgroundFillScale,
    backgroundOpacity: numberOrUndefined(get(`${prefix}BackgroundOpacity`)) ?? defaults.backgroundOpacity,
    edge: parseLayerStyle(get(`${prefix}Edge`)) ?? defaults.edge,
    edgeColor: hexOrUndefined(get(`${prefix}EdgeColor`)),
    edgeOpacity: numberOrUndefined(get(`${prefix}EdgeOpacity`)) ?? defaults.edgeOpacity,
    edgeColors: hexArray(get(`${prefix}EdgeColors`)),
    edgeWidth: numberOrUndefined(get(`${prefix}EdgeWidth`)) ?? defaults.edgeWidth,
    edgeStripeSize: numberOrUndefined(get(`${prefix}EdgeStripeSize`)) ?? defaults.edgeStripeSize,
    edgeDirection: parseFillDirection(get(`${prefix}EdgeDirection`)) ?? defaults.edgeDirection,
    edgeBlend: parseStripeBlend(get(`${prefix}EdgeBlend`)) ?? defaults.edgeBlend,
    pill: parseLayerStyle(get(`${prefix}Pill`)) ?? defaults.pill,
    pillColor: hexOrUndefined(get(`${prefix}PillColor`)),
    pillFill: parseFill(get(`${prefix}PillFill`)),
    pillOpacity: numberOrUndefined(get(`${prefix}PillOpacity`)) ?? defaults.pillOpacity,
    pillRadius: parseRadius(get(`${prefix}PillRadius`)) ?? defaults.pillRadius,
    pillPadding: parseRadius(get(`${prefix}PillPadding`)) ?? defaults.pillPadding,
    markInPill: get(`${prefix}MarkInPill`) === true,
    pillAlign: parsePillAlign(get(`${prefix}PillAlign`)) ?? defaults.pillAlign,
    backgroundRadius: parseRadius(get(`${prefix}BackgroundRadius`)) ?? defaults.backgroundRadius,
    edgeRadius: parseRadius(get(`${prefix}EdgeRadius`)) ?? defaults.edgeRadius,
    textStyle: parseTextStyle(get(`${prefix}TextStyle`)) ?? defaults.textStyle,
    textColor: hexOrUndefined(get(`${prefix}TextColor`)),
    mark: readWatermarkSource(get(`${prefix}Mark`)),
    markColor: hexOrUndefined(get(`${prefix}MarkColor`)),
    markSize: numberOrUndefined(get(`${prefix}MarkSize`)) ?? defaults.markSize,
    markGap: numberOrUndefined(get(`${prefix}MarkGap`)) ?? defaults.markGap,
    glowEffect: parseGlowStyle(get(`${prefix}GlowEffect`)) ?? defaults.glowEffect,
    glowColors: hexArray(get(`${prefix}GlowColors`)),
    glowIntensity: numberOrUndefined(get(`${prefix}GlowIntensity`)) ?? defaults.glowIntensity,
    glowSpread: numberOrUndefined(get(`${prefix}GlowSpread`)) ?? defaults.glowSpread,
    glowText: get(`${prefix}GlowText`) === true,
    watermarkStyle: parseLayerStyle(get(`${prefix}WatermarkStyle`)) ?? defaults.watermarkStyle,
    watermarkColor: watermarkColorOrUndefined(get(`${prefix}WatermarkColor`)),
    watermarkContrast: numberOrUndefined(get(`${prefix}WatermarkContrast`)) ?? defaults.watermarkContrast,
    watermarkDim: numberOrUndefined(get(`${prefix}WatermarkDim`)) ?? defaults.watermarkDim,
    watermarkDimStyle: parseDimStyle(get(`${prefix}WatermarkDimStyle`)) ?? defaults.watermarkDimStyle,
    watermarkLayout: parseWatermarkLayout(get(`${prefix}WatermarkLayout`)) ?? defaults.watermarkLayout,
    watermarkDimWidth: numberOrUndefined(get(`${prefix}WatermarkDimWidth`)) ?? defaults.watermarkDimWidth,
    watermarkDimHeight: numberOrUndefined(get(`${prefix}WatermarkDimHeight`)) ?? defaults.watermarkDimHeight,
    watermarkOpacity: numberOrUndefined(get(`${prefix}WatermarkOpacity`)) ?? defaults.watermarkOpacity,
    watermarkSize: numberOrUndefined(get(`${prefix}WatermarkSize`)) ?? defaults.watermarkSize,
    watermarkCanvas: numberOrUndefined(get(`${prefix}WatermarkCanvas`)) ?? defaults.watermarkCanvas,
    watermarkDensity: numberOrUndefined(get(`${prefix}WatermarkDensity`)) ?? defaults.watermarkDensity,
    watermarkVariation: numberOrUndefined(get(`${prefix}WatermarkVariation`)) ?? defaults.watermarkVariation,
    watermarkRotation: numberOrUndefined(get(`${prefix}WatermarkRotation`)) ?? defaults.watermarkRotation,
  };
}

/** Read only the explicitly-set flat `${prefix}*` keys from a rule into a partial override. */
function readPartOverride(entry: PartInput, prefix: 'root' | 'inner'): Partial<PartConfig> | undefined {
  const o: Partial<PartConfig> = {};
  const backgroundStyle = parseLayerStyle(entry[`${prefix}BackgroundStyle`]);
  if (backgroundStyle) { o.backgroundStyle = backgroundStyle; }
  const backgroundColor = hexOrUndefined(entry[`${prefix}BackgroundColor`]);
  if (backgroundColor) { o.backgroundColor = backgroundColor; }
  const backgroundFill = parseFill(entry[`${prefix}BackgroundFill`]);
  if (backgroundFill !== undefined) { o.backgroundFill = backgroundFill; }
  const backgroundFillScale = parseFillScale(entry[`${prefix}BackgroundFillScale`]);
  if (backgroundFillScale) { o.backgroundFillScale = backgroundFillScale; }
  const backgroundOpacity = numberOrUndefined(entry[`${prefix}BackgroundOpacity`]);
  if (backgroundOpacity !== undefined) { o.backgroundOpacity = backgroundOpacity; }
  const edge = parseLayerStyle(entry[`${prefix}Edge`]);
  if (edge) { o.edge = edge; }
  const edgeColor = hexOrUndefined(entry[`${prefix}EdgeColor`]);
  if (edgeColor) { o.edgeColor = edgeColor; }
  const edgeOpacity = numberOrUndefined(entry[`${prefix}EdgeOpacity`]);
  if (edgeOpacity !== undefined) { o.edgeOpacity = edgeOpacity; }
  const edgeColors = hexArray(entry[`${prefix}EdgeColors`]);
  if (edgeColors.length) { o.edgeColors = edgeColors; }
  const edgeWidth = numberOrUndefined(entry[`${prefix}EdgeWidth`]);
  if (edgeWidth !== undefined) { o.edgeWidth = edgeWidth; }
  const edgeStripeSize = numberOrUndefined(entry[`${prefix}EdgeStripeSize`]);
  if (edgeStripeSize !== undefined) { o.edgeStripeSize = edgeStripeSize; }
  const edgeDirection = parseFillDirection(entry[`${prefix}EdgeDirection`]);
  if (edgeDirection !== undefined) { o.edgeDirection = edgeDirection; }
  const edgeBlend = parseStripeBlend(entry[`${prefix}EdgeBlend`]);
  if (edgeBlend) { o.edgeBlend = edgeBlend; }
  const watermarkStyle = parseLayerStyle(entry[`${prefix}WatermarkStyle`]);
  if (watermarkStyle) { o.watermarkStyle = watermarkStyle; }
  const watermarkColor = watermarkColorOrUndefined(entry[`${prefix}WatermarkColor`]);
  if (watermarkColor) { o.watermarkColor = watermarkColor; }
  const watermarkContrast = numberOrUndefined(entry[`${prefix}WatermarkContrast`]);
  if (watermarkContrast !== undefined) { o.watermarkContrast = watermarkContrast; }
  const watermarkDim = numberOrUndefined(entry[`${prefix}WatermarkDim`]);
  if (watermarkDim !== undefined) { o.watermarkDim = watermarkDim; }
  const watermarkDimStyle = parseDimStyle(entry[`${prefix}WatermarkDimStyle`]);
  if (watermarkDimStyle) { o.watermarkDimStyle = watermarkDimStyle; }
  const watermarkLayout = parseWatermarkLayout(entry[`${prefix}WatermarkLayout`]);
  if (watermarkLayout) { o.watermarkLayout = watermarkLayout; }
  const watermarkDimWidth = numberOrUndefined(entry[`${prefix}WatermarkDimWidth`]);
  if (watermarkDimWidth !== undefined) { o.watermarkDimWidth = watermarkDimWidth; }
  const watermarkDimHeight = numberOrUndefined(entry[`${prefix}WatermarkDimHeight`]);
  if (watermarkDimHeight !== undefined) { o.watermarkDimHeight = watermarkDimHeight; }
  const watermarkOpacity = numberOrUndefined(entry[`${prefix}WatermarkOpacity`]);
  if (watermarkOpacity !== undefined) { o.watermarkOpacity = watermarkOpacity; }
  const watermarkSize = numberOrUndefined(entry[`${prefix}WatermarkSize`]);
  if (watermarkSize !== undefined) { o.watermarkSize = watermarkSize; }
  const watermarkCanvas = numberOrUndefined(entry[`${prefix}WatermarkCanvas`]);
  if (watermarkCanvas !== undefined) { o.watermarkCanvas = watermarkCanvas; }
  const watermarkDensity = numberOrUndefined(entry[`${prefix}WatermarkDensity`]);
  if (watermarkDensity !== undefined) { o.watermarkDensity = watermarkDensity; }
  const watermarkVariation = numberOrUndefined(entry[`${prefix}WatermarkVariation`]);
  if (watermarkVariation !== undefined) { o.watermarkVariation = watermarkVariation; }
  const watermarkRotation = numberOrUndefined(entry[`${prefix}WatermarkRotation`]);
  if (watermarkRotation !== undefined) { o.watermarkRotation = watermarkRotation; }
  const pill = parseLayerStyle(entry[`${prefix}Pill`]);
  if (pill) { o.pill = pill; }
  const pillColor = hexOrUndefined(entry[`${prefix}PillColor`]);
  if (pillColor) { o.pillColor = pillColor; }
  const pillFill = parseFill(entry[`${prefix}PillFill`]);
  if (pillFill !== undefined) { o.pillFill = pillFill; }
  const pillOpacity = numberOrUndefined(entry[`${prefix}PillOpacity`]);
  if (pillOpacity !== undefined) { o.pillOpacity = pillOpacity; }
  const pillRadius = parseRadius(entry[`${prefix}PillRadius`]);
  if (pillRadius !== undefined) { o.pillRadius = pillRadius; }
  const pillPadding = parseRadius(entry[`${prefix}PillPadding`]);
  if (pillPadding !== undefined) { o.pillPadding = pillPadding; }
  if (entry[`${prefix}MarkInPill`] === true) { o.markInPill = true; }
  const pillAlign = parsePillAlign(entry[`${prefix}PillAlign`]);
  if (pillAlign) { o.pillAlign = pillAlign; }
  const backgroundRadius = parseRadius(entry[`${prefix}BackgroundRadius`]);
  if (backgroundRadius !== undefined) { o.backgroundRadius = backgroundRadius; }
  const edgeRadius = parseRadius(entry[`${prefix}EdgeRadius`]);
  if (edgeRadius !== undefined) { o.edgeRadius = edgeRadius; }
  const textStyle = parseTextStyle(entry[`${prefix}TextStyle`]);
  if (textStyle) { o.textStyle = textStyle; }
  const textColor = hexOrUndefined(entry[`${prefix}TextColor`]);
  if (textColor) { o.textColor = textColor; }
  const mark = readWatermarkSource(entry[`${prefix}Mark`]);
  if (mark) { o.mark = mark; }
  const markColor = hexOrUndefined(entry[`${prefix}MarkColor`]);
  if (markColor) { o.markColor = markColor; }
  const markSize = numberOrUndefined(entry[`${prefix}MarkSize`]);
  if (markSize !== undefined) { o.markSize = markSize; }
  const markGap = numberOrUndefined(entry[`${prefix}MarkGap`]);
  if (markGap !== undefined) { o.markGap = markGap; }
  const glowEffect = parseGlowStyle(entry[`${prefix}GlowEffect`]);
  if (glowEffect) { o.glowEffect = glowEffect; }
  const glowColors = hexArray(entry[`${prefix}GlowColors`]);
  if (glowColors.length) { o.glowColors = glowColors; }
  const glowIntensity = numberOrUndefined(entry[`${prefix}GlowIntensity`]);
  if (glowIntensity !== undefined) { o.glowIntensity = glowIntensity; }
  const glowSpread = numberOrUndefined(entry[`${prefix}GlowSpread`]);
  if (glowSpread !== undefined) { o.glowSpread = glowSpread; }
  if (entry[`${prefix}GlowText`] === true) { o.glowText = true; }
  return Object.keys(o).length ? o : undefined;
}

/** Read and resolve all `premiumExplorer.*` settings. */
export function readConfig(): FolderColorerConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const get = (key: string): unknown => cfg.get(key);

  const badge = cfg.get<string>('badge', '').trim().slice(0, 2);

  return {
    enabled: cfg.get<boolean>('enabled', true),
    colorBy: cfg.get<'name' | 'path'>('colorBy', 'name'),
    symlinkStyle: parseSymlinkStyle(cfg.get<string>('symlinkFolders')) ?? 'none',
    badge: badge || undefined,
    palette: resolvePalette(cfg),
    edgeColorCount: cfg.get<number>('edgeColorCount', 3),
    // `backgroundWatermark` is the pre-1.3 name, still read so an existing config
    // keeps its artwork; the new key wins wherever both are set.
    backgroundWatermarkSymbol: readWatermarkSources(
      cfg.get('backgroundWatermarkSymbol') || cfg.get('backgroundWatermark'),
    ) ?? [],
    radiusScale: parseRadiusScale(cfg.get<string>('radiusScale')) ?? 'block',
    git: {
      // `bare` is the no-op, and it is the default: Git's own marks are left
      // alone until the user asks for a style here.
      style: parseGitMarkStyle(cfg.get<string>('gitMarkStyle')) ?? 'bare',
      color: parseGitColor(cfg.get('gitMarkColor')) ?? 'auto',
      background: parseGitColor(cfg.get('gitMarkBackgroundColor')) ?? 'auto',
      border: parseGitColor(cfg.get('gitMarkBorderColor')) ?? 'auto',
      label: parseGitColor(cfg.get('gitLabelColor')) ?? 'auto',
      folderDot: parseGitColor(cfg.get('gitFolderDotColor')) ?? 'auto',
      symlink: parseGitColor(cfg.get('symlinkMarkColor')) ?? 'auto',
      contrast: cfg.get<number>('gitMarkContrast', 4.5),
    },
    symlinkMark: readWatermarkSource(cfg.get('symlinkMark')),
    symlinkMarkTint: hexOrUndefined(cfg.get('symlinkMarkTint')),
    root: readPart(get, 'root', ROOT_DEFAULTS),
    inner: readPart(get, 'inner', INNER_DEFAULTS),
    selection: {
      background: cfg.get<string>('selectedBackgroundColor', 'invert'),
      fill: parseFill(cfg.get('selectedBackgroundFill')),
      shift: cfg.get<number>('selectedShift', 0.12),
      text: cfg.get<string>('selectedTextColor', 'auto'),
      opacity: cfg.get<number>('selectedOpacity', 1),
      bold: cfg.get<boolean>('selectedBold', true),
      border: cfg.get<string>('selectedBorder', 'auto'),
      inactiveDarken: cfg.get<number>('selectedInactiveDarken', 0.25),
      overrides: parseOverrides(cfg.get<string[]>('selectedOverrides', [])),
      watermark: cfg.get<string>('selectedWatermarkColor', 'auto'),
      watermarkContrast: cfg.get<number>('selectedWatermarkContrast', 0.08),
      renameStyle: parseRenameStyle(cfg.get<string>('selectedRenameStyle')) ?? 'dim',
    },
    rules: resolveRules(cfg),
  };
}

/**
 * Which styles the selection color takes over. Only what is named here changes on
 * a selected row; everything else keeps painting exactly as it does unselected, so
 * `["background"]` recolors just the fill and leaves the watermark and label. An
 * `"edge"` left over from an older config is simply dropped here.
 */
function parseOverrides(raw: unknown): SelectedOverride[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((v): v is SelectedOverride => typeof v === 'string' && SELECTED_OVERRIDES.includes(v));
}

/** Configured palette, or the built-in defaults. */
function resolvePalette(cfg: vscode.WorkspaceConfiguration): string[] {
  const raw = cfg.get<string[]>('palette', []);
  const cleaned = Array.isArray(raw)
    ? raw.filter(c => typeof c === 'string' && HEX_RE.test(c)).slice(0, DEFAULT_PALETTE.length)
    : [];
  return cleaned.length ? cleaned : DEFAULT_PALETTE;
}

/** Parse `premiumExplorer.rules`, resolve paths to absolute, and read per-rule layer overrides. */
function resolveRules(cfg: vscode.WorkspaceConfiguration): ResolvedRule[] {
  const raw = cfg.get<PartInput[]>('rules', []) ?? [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  const resolved: ResolvedRule[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }
    // `manual` when omitted. `default` is the old name for `manual` — they only
    // ever differed in where the base color came from, and rules no longer carry
    // one, so it is still accepted and means the same thing.
    const engine: Engine | undefined =
      entry.engine === undefined ? 'manual'
        : entry.engine === 'git' ? 'git'
          : entry.engine === 'manual' || entry.engine === 'default' ? 'manual'
            : undefined;
    if (!engine) {
      continue;
    }

    const root = readPartOverride(entry, 'root');
    const inner = readPartOverride(entry, 'inner');
    const watermark = readWatermarkSources(entry.backgroundWatermarkSymbol ?? entry.backgroundWatermark);

    const radiusScale = parseRadiusScale(entry.radiusScale);
    for (const absPath of resolveRulePaths(entry.path, folders)) {
      resolved.push({ absPath, engine, backgroundWatermarkSymbol: watermark, radiusScale, root, inner });
    }
  }

  // Deepest (longest) path first, so the first matching rule is the most specific.
  return resolved.sort((a, b) => b.absPath.length - a.absPath.length);
}

/**
 * A watermark color: a hex tint, or the literal `original`, which leaves an SVG's
 * own colors alone instead of flattening it to one shade.
 */
function watermarkColorOrUndefined(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === WATERMARK_COLOR_ORIGINAL) {
    return WATERMARK_COLOR_ORIGINAL;
  }
  return hexOrUndefined(raw);
}

/** `watermarkColor` value meaning "don't tint — draw the artwork as authored". */
export const WATERMARK_COLOR_ORIGINAL = 'original';

/**
 * Read a `backgroundWatermarkSymbol` value. Kept whole: deciding what it *is* —
 * a built-in glyph, an SVG source, or a character to draw — needs the shipped
 * assets and the filesystem, so it belongs to resolveWatermarkArt in
 * backgroundStyles.ts. That is also where a character is capped at two.
 */
function readWatermarkSource(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

/**
 * Read a `backgroundWatermarkSymbol` that may name several drawings. One string is
 * a list of one; an array keeps its order (which only the seeded pick cares about).
 * Undefined means "nothing set here", so the next fallback applies.
 */
function readWatermarkSources(raw: unknown): string[] | undefined {
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(readWatermarkSource)
    .filter((s): s is string => !!s);
  return list.length ? list : undefined;
}

/** Does this `backgroundWatermarkSymbol` name a drawing rather than a character? */
export function isSvgSource(value: string): boolean {
  return /\.svg$/i.test(value) || value.startsWith('<svg') || value.startsWith('data:image/svg+xml');
}

/** Resolve a rule path to absolute path(s): absolute as-is, relative against each workspace folder. */
function resolveRulePaths(rulePath: string, folders: readonly vscode.WorkspaceFolder[]): string[] {
  if (path.isAbsolute(rulePath)) {
    return [normalizePath(rulePath)];
  }
  return folders.map(folder => normalizePath(path.resolve(folder.uri.fsPath, rulePath)));
}

function isAncestorOrSelf(ancestorAbs: string, targetAbs: string): boolean {
  return targetAbs === ancestorAbs || targetAbs.startsWith(ancestorAbs + path.sep);
}

/** The most specific rule whose path contains `uri`, or undefined if none match. */
export function deepestRuleFor(config: FolderColorerConfig, uri: vscode.Uri): ResolvedRule | undefined {
  const target = normalizePath(uri.fsPath);
  return config.rules.find(rule => isAncestorOrSelf(rule.absPath, target));
}

function paletteIndex(config: FolderColorerConfig, repoRoot: vscode.Uri): number {
  const basis = config.colorBy === 'path' ? repoRoot.fsPath : path.basename(repoRoot.fsPath);
  return hashString(basis) % config.palette.length;
}

/** Resolved base hex for a Git repo's automatic color (used to build the injected CSS/JS). */
export function gitRepoColorHex(config: FolderColorerConfig, repoRoot: vscode.Uri): string {
  return config.palette[paletteIndex(config, repoRoot)];
}
