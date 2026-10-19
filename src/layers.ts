/**
 * Bakes one colored folder's row styling into the values the injected painter
 * applies: a fill, a striped edge bar, a label pill, text style and the tiled
 * watermark. Everything here is resolved once at generate time — the
 * painter should only ever pick from what these produce, never recompute it.
 *
 * `inherit` is what ties a nested rule to the folder around it: each builder
 * takes the already-baked layer from the nearest enclosing folder's inner rows
 * and reuses it wholesale, falling back to the shipped default when nothing
 * encloses the folder (see NO_ANCESTOR_FALLBACK).
 */
import { Fill, Radius, WatermarkArt, fillDirectionOf, fillHasVertical, isSquare, markDataUri, mixHex, resolveFill, resolvePadding, resolveRadius, watermarkPatternDataUri, hexToRgba, lightenHex, stripeGradient } from './colors';
import { GLOW_MAX_SPREAD, GlowStyle, WATERMARK_COLOR_ORIGINAL, FillScale, LayerStyle, NO_ANCESTOR_FALLBACK, PartConfig, RadiusScale } from './config';

/** A colored folder: its base color, its source path, and its resolved root/inner layers. */
export interface ColoredFolder {
  name: string;
  hex: string;
  /** Unique colour sequence for the striped edge; first entry is `hex`. */
  sequence: string[];
  /**
   * Artwork for the watermark (the rule's `backgroundWatermarkSymbol`, else the
   * global one, else the name's initial). More than one entry mixes them across
   * the canvas.
   */
  arts: WatermarkArt[];
  /**
   * Artwork for the `mark` layer, keyed by the `*Mark` source that asked for it —
   * resolving one needs the filesystem and the shipped glyph set, so it is done
   * once per folder, up front, rather than inside the bake.
   */
  markArt: Record<string, WatermarkArt>;
  absPath: string;
  /** Whether corner radii round each row or the folder's whole rendered block. */
  radiusScale: RadiusScale;
  root: PartConfig;
  inner: PartConfig;
}

// Hover shows a lighter, slightly more opaque variant of a layer's color.
const HOVER_LIGHTEN = 0.2;
const HOVER_OPACITY_BOOST = 0.15;

/** One baked fill layer: its normal + hover CSS colors (empty string = layer off). */
export interface Layer {
  value: string;
  hover: string;
  /**
   * Set only when `value` is a gradient image: the fill's ground (its color at
   * the element's centre) as an `rgba(...)`, for everything in the painter that
   * composites "the row's color" and cannot parse a gradient string.
   */
  ground?: string;
  /**
   * `"block"` only, and only on a gradient `value`: stretch this one fill over the
   * folder's rendered block instead of repainting it inside every row. The block's
   * height is only known in the browser, so the painter does the sizing — the one
   * deliberate bend of "bake at generate time" (docs/fill-spec.md §2). Absent =
   * per-row, which is what every solid and every horizontal fill wants.
   */
  scale?: 'block';
}

/**
 * The baked left bar: a CSS gradient confined to a `width`px strip (empty = off).
 * No hover variant: the bar keeps its resting colours under the cursor — a 3px
 * stripe brightening was never legible, and dropping it is what lets hover be
 * pure CSS (the fill and pill brighten via custom properties instead).
 */
export interface StripeLayer {
  image: string;
  width: number;
}

/**
 * The baked mark: one stamp of artwork placed just after the row's text (empty =
 * off). The painter positions it, because where a row's text ends is only known
 * in the browser (`textEnd()` in inject.js).
 */
export interface MarkLayer {
  image: string;
  size: number;
  gap: number;
  /**
   * How much of the pill's right padding exists only to enclose this mark
   * (`markInPill`). The painter subtracts it when placing the mark, because
   * `textEnd()` measures the label's padded *box*: without the subtraction the
   * widened pill would push the mark straight back outside it.
   */
  inset: number;
}

/** The baked watermark: a tiled `url(data:image/svg+xml,...)` pattern (empty = off). */
export interface WatermarkLayer {
  image: string;
  size: number;
  /**
   * The hex baked into `image`, so the painter can swap it for a selected row.
   * Empty when the artwork keeps its own colors (`watermarkColor: "original"`) and
   * there is therefore nothing to re-tint.
   */
  tint: string;
  /**
   * True when no `watermarkColor` was set, so the painter picks the tint itself off
   * the color the row is composited to — the fill's own opacity, and whatever
   * shows through it, are only known there. `contrast` is how far off that color
   * to land. The baked `tint` is the fallback the painter replaces.
   */
  auto: boolean;
  contrast: number;
  /**
   * The `text` cover: how far a copy the row's text reaches is dimmed (0 = off),
   * and where every copy landed, as flat `x, y, size, opacity` quadruples. The
   * painter needs the geometry to dim a watermark whole instead of clipping it.
   */
  textDim: number;
  spots: number[];
}

/**
 * The baked glow (EM-116). It is the one layer that lands in two different places,
 * because CSS decides where it can land: `soft` and `neon` are nothing but a
 * `text-shadow`, which an inline style sets directly on the label, while `halo`,
 * `aurora` and `underglow` draw in a `::before`/`::after` — a pseudo-element no
 * inline style can reach — so those travel as a class plus the colours as custom
 * properties, exactly like the git marks (see generatedCss.ts). Empty `style` = off.
 */
export interface GlowLayer {
  /** `""` when the glow is off; otherwise the style that was asked for. */
  style: GlowStyle | '';
  /** The finished `text-shadow` value for `soft`/`neon`; `""` for the rest. */
  shadow: string;
  /** The gradient's strong stop (`--fc-glow-core`), for the pseudo-element styles. */
  core: string;
  /** `halo`'s faded 60% stop (`--fc-glow-fade`); `""` where the style has none. */
  fade: string;
  /** `aurora`'s second lobe (`--fc-glow-second`); `""` for every other style. */
  second: string;
  /** The blur radius in px, already clamped (`--fc-glow-blur`). */
  spread: number;
}

/** The empty glow — what every style resolves to when it is off or has no colour. */
const NO_GLOW: GlowLayer = { style: '', shadow: '', core: '', fade: '', second: '', spread: 0 };

/**
 * The spread the approved design was drawn at. Every radius below is expressed as
 * the design's own px value scaled by `spread / GLOW_DESIGN_SPREAD`, so the default
 * reproduces the canvas exactly and a different spread scales the whole glow
 * rather than just its outer edge.
 */
const GLOW_DESIGN_SPREAD = 3;

/** How far `neon`'s inner and outer rings are lightened/darkened off the base colour. */
const NEON_STEP = 0.35;

/**
 * Bake the glow. Colour precedence matches the edge bar's: an explicit
 * `glowColors` list, else the folder's auto-derived sequence — so one global
 * `glowEffect` still gives every folder a glow of its own. No `inherit`: a nested
 * rule does not pick up an enclosing folder's glow, for the same reason it does
 * not pick up its mark.
 */
export function buildGlow(p: PartConfig, sequence: string[]): GlowLayer {
  if (p.glowEffect === 'off') {
    return NO_GLOW;
  }
  const colors = p.glowColors.length ? p.glowColors : sequence;
  if (!colors.length) {
    // A manual rule derives no sequence, so without an explicit `glowColors`
    // there is no colour to glow in — paint nothing rather than a stand-in.
    return NO_GLOW;
  }
  // `glowIntensity` scales every stop's alpha together; 100 is the design.
  const k = Math.max(0, Math.min(100, p.glowIntensity)) / 100;
  const spread = Math.max(1, Math.min(GLOW_MAX_SPREAD, Math.round(p.glowSpread)));
  const px = (design: number): number => Math.max(1, Math.round(design * spread / GLOW_DESIGN_SPREAD));
  const hex = colors[0];
  // `glowText` lights the glyphs as well. The plate styles leave the text alone by
  // design, so this is purely additive — and the two text-only styles already *are*
  // the text glow, which is why they never consult it.
  const textGlow = p.glowText ? `0 0 ${px(3)}px ${hexToRgba(hex, 0.9 * k)}, 0 0 ${px(7)}px ${hexToRgba(hex, 0.55 * k)}` : '';
  if (p.glowEffect === 'soft') {
    return {
      ...NO_GLOW,
      style: 'soft',
      shadow: `0 0 ${px(3)}px ${hexToRgba(hex, 0.9 * k)}, 0 0 ${px(7)}px ${hexToRgba(hex, 0.55 * k)}`,
    };
  }
  if (p.glowEffect === 'neon') {
    // Three rings stepping light -> base -> dark is what reads as a lit tube. The
    // label's own colour is left alone: the design pairs `neon` with a near-white
    // `textColor`, but that is the user's setting to make, not ours to force.
    const light = lightenHex(hex, NEON_STEP);
    const dark = mixHex(hex, '#000000', NEON_STEP);
    return {
      ...NO_GLOW,
      style: 'neon',
      shadow: `0 0 ${px(2)}px ${hexToRgba(light, k)}, 0 0 ${px(5)}px ${hexToRgba(hex, k)}, 0 0 ${px(9)}px ${hexToRgba(dark, k)}`,
    };
  }
  if (p.glowEffect === 'underglow') {
    // The bar fades to transparent on its own (`closest-side`), so it needs no
    // second stop and no mask — and a blur a step under the plate styles', which
    // is what keeps a 5px bar from washing into the row below.
    return { ...NO_GLOW, style: 'underglow', shadow: textGlow, core: hexToRgba(hex, 0.85 * k), spread: Math.max(1, spread - 1) };
  }
  if (p.glowEffect === 'aurora') {
    // Two lobes, so the second colour is the one that makes this style what it is;
    // with only one colour available both lobes take it and it reads as `halo`.
    return { ...NO_GLOW, style: 'aurora', shadow: textGlow, core: hexToRgba(hex, 0.7 * k), second: hexToRgba(colors[1] ?? hex, 0.7 * k), spread };
  }
  return { ...NO_GLOW, style: 'halo', shadow: textGlow, core: hexToRgba(hex, 0.7 * k), fade: hexToRgba(hex, 0.25 * k), spread };
}

/**
 * The baked, ready-to-apply colors for one row kind (the root row, or the inner
 * rows). Every layer is independent, so background/edge/pill/text may all be set.
 */
export interface Part {
  /** Full-row fill (rgba), or empty. */
  background: Layer;
  /** Left accent bar: a 45° stripe gradient of the folder's colour sequence. */
  edge: StripeLayer;
  /** Rounded background behind the label (rgba), or empty. */
  pill: Layer;
  /** Pill corner radii in px, CSS order (top-left, top-right, bottom-right, bottom-left). */
  pillRadius: number[];
  /** Pill padding in px, CSS order (top, right, bottom, left). */
  pillPadding: number[];
  /**
   * How far left the painter shifts the row's label block to pay for the pill's
   * left inset, so the plate reaches left without moving the text (EM-118). Equal
   * to `pillPadding`'s left value under `pillAlign: "shift"`, and 0 under `"hug"`,
   * where that inset is dropped instead.
   */
  pillLead: number;
  /** Row-fill corner radii in px, same order. All zero = square (the default). */
  backgroundRadius: number[];
  /** Edge-bar corner radii in px, same order; only the left pair can show. */
  edgeRadius: number[];
  /** Label text color, or `""` to leave it to the theme. */
  text: string;
  bold: boolean;
  italic: boolean;
  /** One fixed glyph stamped after the row's label. */
  mark: MarkLayer;
  /** The soft glow around the row's label. */
  glow: GlowLayer;
  /** Faint tiled artwork behind the row. */
  watermark: WatermarkLayer;
  /** The folder's opaque base color — used by the `invert` selection highlight. */
  solid: string;
}


/**
 * Build one fill layer. `inherit` reuses the already-baked layer from the nearest
 * enclosing colored folder's inner rows (so a nested rule blends into its parent);
 * with nothing enclosing it, it falls back to `fallback`.
 */
export function buildLayer(
  style: LayerStyle,
  color: string | undefined,
  opacity: number,
  baseHex: string,
  inherited: Layer | undefined,
  fallback: LayerStyle,
  fill?: Fill,
  fillScale: FillScale = 'row',
): Layer {
  let effective = style;
  if (effective === 'inherit') {
    if (inherited) {
      return inherited; // adopt the parent's baked color wholesale
    }
    effective = fallback;
  }
  if (effective !== 'solid') {
    return { value: '', hover: '' };
  }
  // A multi-stop fill wins over the single color. `value` is then either an
  // `rgba(...)` (one stop) or a `linear-gradient(...)` string — the painter
  // applies both through the `background` shorthand, so it never cares which.
  if (fill !== undefined) {
    const normal = resolveFill(fill, opacity);
    const hover = resolveFill(fill, opacity, HOVER_LIGHTEN, HOVER_OPACITY_BOOST);
    // Only a gradient can be stretched — a one-stop fill is a flat colour, and
    // `auto` asks the direction: a purely horizontal fill reads exactly the same
    // whether it spans one row or twenty, so it stays per-row.
    const block = !!normal.image && (fillScale === 'block'
      || (fillScale === 'auto' && fillHasVertical(fillDirectionOf(fill))));
    return {
      value: normal.color || normal.image,
      hover: hover.color || hover.image,
      ...(normal.image ? { ground: hexToRgba(normal.hex, normal.alpha) } : {}),
      ...(block ? { scale: 'block' as const } : {}),
    };
  }
  const hex = color ?? baseHex;
  if (!hex) {
    // A manual rule has no base color: `solid` with no color named anywhere
    // paints nothing rather than a stand-in grey.
    return { value: '', hover: '' };
  }
  const lighter = lightenHex(hex, HOVER_LIGHTEN);
  return {
    value: hexToRgba(hex, opacity),
    hover: hexToRgba(lighter, Math.min(1, opacity + HOVER_OPACITY_BOOST)),
  };
}

/**
 * Bake the left bar. Colour precedence: an explicit `edgeColors` list, then a
 * single explicit `edgeColor`, then the folder's auto-derived sequence — so a
 * one-colour result renders exactly like the old solid bar.
 */
export function buildStripe(p: PartConfig, sequence: string[], inherited: StripeLayer | undefined): StripeLayer {
  let effective: LayerStyle = p.edge;
  if (effective === 'inherit') {
    if (inherited) {
      return inherited;
    }
    effective = NO_ANCESTOR_FALLBACK.edge;
  }
  if (effective !== 'solid') {
    return { image: '', width: 0 };
  }
  const colors = p.edgeColors.length ? p.edgeColors : (p.edgeColor ? [p.edgeColor] : sequence);
  if (!colors.length) {
    // A manual rule derives no sequence, so without an explicit
    // `edgeColors`/`edgeColor` there is nothing to stripe with.
    return { image: '', width: 0 };
  }
  return {
    image: stripeGradient(colors.map(c => hexToRgba(c, p.edgeOpacity)), p.edgeStripeSize, p.edgeDirection, p.edgeBlend),
    width: Math.max(1, Math.round(p.edgeWidth)),
  };
}

/**
 * Bake the tiled watermark. The tile scatters several watermarks at varied
 * size/brightness/position, seeded off the folder so it is unique but stable.
 * No watermark -> the layer stays off.
 */
export function buildWatermark(p: PartConfig, fillHex: string, arts: WatermarkArt[], seed: string, inherited: WatermarkLayer | undefined): WatermarkLayer {
  let effective: LayerStyle = p.watermarkStyle;
  if (effective === 'inherit') {
    if (inherited) {
      return inherited;
    }
    effective = NO_ANCESTOR_FALLBACK.watermark;
  }
  const drawable = arts.filter(a => !!a.content);
  if (effective !== 'solid' || !drawable.length) {
    return { image: '', size: 0, tint: '', auto: false, contrast: 0, textDim: 0, spots: [] };
  }
  // With no `watermarkColor` the watermark inherits the row's own fill colour, so the
  // pattern reads as texture in the background rather than as a foreign colour
  // laid on top. It cannot be left at exactly that colour, though: how far it has
  // to step to be visible depends on what the row composites to, which a fill's
  // opacity and the theme behind it decide, and neither is known here. So bake the
  // inherited colour and let the painter take the step (see `auto` below).
  // `original` paints the artwork as authored; an empty color tells the pattern
  // generator to leave the SVG's own fills in place.
  const auto = p.watermarkColor === undefined;
  const color = p.watermarkColor === WATERMARK_COLOR_ORIGINAL
    ? ''
    : p.watermarkColor ?? fillHex;
  if (auto && !color) {
    // An auto tint shades itself off the fill color, and a manual rule without
    // one has nothing to shade from — the watermark needs an explicit
    // `watermarkColor` (or `"original"` artwork) there.
    return { image: '', size: 0, tint: '', auto: false, contrast: 0, textDim: 0, spots: [] };
  }
  const canvas = Math.max(32, Math.round(p.watermarkCanvas));
  // `radius` is baked into the scatter itself (see watermarkPatternDataUri) — nothing is
  // laid over the row, so nothing can fail to match its colour. `text` cannot be:
  // which copies a name runs into depends on the row, so the painter does that one,
  // and needs `spots` to do it per watermark rather than per pixel.
  const cleared = p.watermarkDimStyle !== 'text' ? p.watermarkDim : 0;
  const covers = p.watermarkDimStyle !== 'radius';
  const pattern = watermarkPatternDataUri(drawable, seed, canvas, p.watermarkSize, p.watermarkDensity, p.watermarkVariation, p.watermarkRotation,
    color, p.watermarkOpacity, cleared, p.watermarkDimWidth, p.watermarkDimHeight, covers, p.watermarkLayout);
  return {
    // No hover variant: a whole-canvas pattern is ~20KB and it is embedded per
    // folder, so a second copy would dominate the generated file for an effect
    // nobody can see. The row's fill still brightens under the watermark.
    image: pattern.uri,
    // `size` is the canvas the pattern is drawn on (drives background-size, and
    // the block-anchoring maths in inject.js).
    size: canvas,
    tint: color,
    auto,
    contrast: p.watermarkContrast,
    textDim: covers ? p.watermarkDim : 0,
    spots: pattern.spots,
  };
}

/**
 * Bake the mark: one copy of the artwork, at full strength, keeping its own
 * colours unless a tint is named. No `inherit` here — a mark is a deliberate,
 * per-folder choice, and inheriting one would stamp a parent's logo onto every
 * nested rule that never asked for it.
 */
export function buildMark(p: PartConfig, art: WatermarkArt | undefined, inset: number): MarkLayer {
  if (!p.mark || !art || !art.content) {
    return { image: '', size: 0, gap: 0, inset: 0 };
  }
  return {
    image: markDataUri(art, p.markColor ?? ''),
    size: Math.max(4, Math.round(p.markSize)),
    gap: Math.round(p.markGap),
    inset,
  };
}

/** The trailing space left between an enclosed mark and the pill's right edge. */
const MARK_IN_PILL_TRAIL = 5;

/**
 * How far the pill has to grow rightwards to enclose the mark: the gap before it,
 * the mark itself, and a trailing space so it is not flush against the edge. Zero
 * unless both a mark and a pill are actually painted — the flag is a no-op, never
 * an error, where either is missing.
 */
function markInset(p: PartConfig, hasMark: boolean, hasPill: boolean): number {
  if (!p.markInPill || !hasMark || !hasPill) {
    return 0;
  }
  return Math.round(p.markGap) + Math.max(4, Math.round(p.markSize)) + MARK_IN_PILL_TRAIL;
}

/**
 * Resolve one layer's corner radii, letting an `inherit` layer take the enclosing
 * folder's shape when this one names no radius of its own.
 */
function inheritedRadius(style: LayerStyle, own: Radius, inherited: number[] | undefined): number[] {
  const corners = resolveRadius(own);
  return style === 'inherit' && inherited && isSquare(corners) ? inherited : corners;
}

/** Bake one row-kind's {@link PartConfig} into ready-to-apply CSS colors. */
export function buildPart(folder: ColoredFolder, p: PartConfig, inheritFrom: Part | undefined): Part {
  const baseHex = folder.hex;
  // The color this row is actually filled with: what the watermark shades itself
  // against, and what the `"invert"`/`"shift"` selections reuse. An `inherit`
  // background adopts the enclosing folder's fill wholesale, so its *color* has to
  // come from there too — falling back to this folder's own base would misreport
  // a row painted in its parent's color (a manual rule has no base at all), and
  // every shade derived from it would be wrong with it.
  // A multi-stop fill's "color" is its ground — the hex at the row's centre
  // (docs/fill-spec.md) — so shift/invert/watermark all derive off what the eye
  // actually sees behind the label.
  const fillHex = (p.backgroundStyle === 'solid' && p.backgroundFill !== undefined
    ? resolveFill(p.backgroundFill).hex
    : undefined)
    ?? p.backgroundColor
    ?? (p.backgroundStyle === 'inherit' && inheritFrom ? inheritFrom.solid : baseHex);
  // `markInPill` grows the pill rightwards to enclose the mark. Both layers have to
  // be on for it to mean anything, so the pill is built first and the flag read off
  // the result rather than off the config.
  const pill = buildLayer(p.pill, p.pillColor, p.pillOpacity, baseHex, inheritFrom?.pill, NO_ANCESTOR_FALLBACK.pill, p.pillFill);
  const markArt = p.mark ? folder.markArt[p.mark] : undefined;
  const inset = markInset(p, !!(markArt && markArt.content), !!pill.value);
  const pillPadding = resolvePadding(p.pillPadding);
  pillPadding[1] += inset;
  // `hug` drops the left inset outright; `shift` keeps it and hands the painter the
  // same number to move the row by, which is what makes the text land unmoved. The
  // choice is resolved here rather than in the browser: the painter only picks.
  const pillLead = p.pillAlign === 'hug' ? 0 : pillPadding[3];
  if (p.pillAlign === 'hug') { pillPadding[3] = 0; }
  return {
    background: buildLayer(p.backgroundStyle, p.backgroundColor, p.backgroundOpacity, baseHex, inheritFrom?.background, NO_ANCESTOR_FALLBACK.background, p.backgroundFill, p.backgroundFillScale),
    edge: buildStripe(p, folder.sequence, inheritFrom?.edge),
    pill,
    // An `inherit` layer adopts the ancestor's *shape* along with its colours, but
    // only where this part asks for no rounding of its own: a rule that names a
    // radius means it, and square is how "none" is spelt.
    pillRadius: inheritedRadius(p.pill, p.pillRadius, inheritFrom?.pillRadius),
    pillPadding: pillPadding,
    pillLead,
    backgroundRadius: inheritedRadius(p.backgroundStyle, p.backgroundRadius, inheritFrom?.backgroundRadius),
    edgeRadius: inheritedRadius(p.edge, p.edgeRadius, inheritFrom?.edgeRadius),
    text: p.textColor ?? '',
    bold: p.textStyle === 'bold' || p.textStyle === 'bold-italic',
    italic: p.textStyle === 'italic' || p.textStyle === 'bold-italic',
    mark: buildMark(p, markArt, inset),
    glow: buildGlow(p, folder.sequence),
    watermark: buildWatermark(p, fillHex, folder.arts, folder.name, inheritFrom?.watermark),
    solid: fillHex,
  };
}

