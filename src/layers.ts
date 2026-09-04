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
import { WatermarkArt, watermarkPatternDataUri, hexToRgba, lightenHex, stripeGradient } from './colors';
import { WATERMARK_COLOR_ORIGINAL, LayerStyle, NO_ANCESTOR_FALLBACK, PartConfig } from './config';

/** A colored folder: its base color, its source path, and its resolved root/inner layers. */
export interface ColoredFolder {
	name: string;
	hex: string;
	/** Unique colour sequence for the striped edge; first entry is `hex`. */
	sequence: string[];
	/** Artwork for the watermark (the rule's `backgroundWatermark`, else the name's initial). */
	art: WatermarkArt;
	absPath: string;
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
}

/** The baked left bar: a CSS gradient confined to a `width`px strip (empty = off). */
export interface StripeLayer {
	image: string;
	hover: string;
	width: number;
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
	/** Pill corner radius in px. */
	pillRadius: number;
	/** Label text color, or `""` to leave it to the theme. */
	text: string;
	bold: boolean;
	italic: boolean;
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
	const hex = color ?? baseHex;
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
		return { image: '', hover: '', width: 0 };
	}
	const colors = p.edgeColors.length ? p.edgeColors : (p.edgeColor ? [p.edgeColor] : sequence);
	const hoverAlpha = Math.min(1, p.edgeOpacity + HOVER_OPACITY_BOOST);
	return {
		image: stripeGradient(colors.map(c => hexToRgba(c, p.edgeOpacity)), p.edgeStripeSize),
		hover: stripeGradient(colors.map(c => hexToRgba(lightenHex(c, HOVER_LIGHTEN), hoverAlpha)), p.edgeStripeSize),
		width: Math.max(1, Math.round(p.edgeWidth)),
	};
}

/**
 * Bake the tiled watermark. The tile scatters several watermarks at varied
 * size/brightness/position, seeded off the folder so it is unique but stable.
 * No watermark -> the layer stays off.
 */
export function buildWatermark(p: PartConfig, fillHex: string, art: WatermarkArt, seed: string, inherited: WatermarkLayer | undefined): WatermarkLayer {
	let effective: LayerStyle = p.watermarkStyle;
	if (effective === 'inherit') {
		if (inherited) {
			return inherited;
		}
		effective = NO_ANCESTOR_FALLBACK.watermark;
	}
	if (effective !== 'solid' || !art.content) {
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
	const canvas = Math.max(32, Math.round(p.watermarkCanvas));
	// `radius` is baked into the scatter itself (see watermarkPatternDataUri) — nothing is
	// laid over the row, so nothing can fail to match its colour. `text` cannot be:
	// which copies a name runs into depends on the row, so the painter does that one,
	// and needs `spots` to do it per watermark rather than per pixel.
	const cleared = p.watermarkDimStyle !== 'text' ? p.watermarkDim : 0;
	const covers = p.watermarkDimStyle !== 'radius';
	const pattern = watermarkPatternDataUri(art, seed, canvas, p.watermarkSize, p.watermarkDensity, p.watermarkVariation, p.watermarkRotation,
		color, p.watermarkOpacity, cleared, p.watermarkDimWidth, p.watermarkDimHeight, covers);
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

/** Bake one row-kind's {@link PartConfig} into ready-to-apply CSS colors. */
export function buildPart(folder: ColoredFolder, p: PartConfig, inheritFrom: Part | undefined): Part {
	const baseHex = folder.hex;
	// The color this row is actually filled with: what the watermark shades itself
	// against, and what the `"invert"`/`"shift"` selections reuse. An `inherit`
	// background adopts the enclosing folder's fill wholesale, so its *color* has to
	// come from there too — falling back to this folder's own base would report grey
	// (`defaultColor`, for a manual rule) for a row painted in its parent's color,
	// and every shade derived from it would be grey with it.
	const fillHex = p.backgroundColor
		?? (p.backgroundStyle === 'inherit' && inheritFrom ? inheritFrom.solid : baseHex);
	return {
		background: buildLayer(p.backgroundStyle, p.backgroundColor, p.backgroundOpacity, baseHex, inheritFrom?.background, NO_ANCESTOR_FALLBACK.background),
		edge: buildStripe(p, folder.sequence, inheritFrom?.edge),
		pill: buildLayer(p.pill, p.pillColor, p.pillOpacity, baseHex, inheritFrom?.pill, NO_ANCESTOR_FALLBACK.pill),
		pillRadius: p.pillRadius,
		text: p.textColor ?? '',
		bold: p.textStyle === 'bold' || p.textStyle === 'bold-italic',
		italic: p.textStyle === 'italic' || p.textStyle === 'bold-italic',
		watermark: buildWatermark(p, fillHex, folder.art, folder.name, inheritFrom?.watermark),
		solid: fillHex,
	};
}

