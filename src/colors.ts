/**
 * Pure color and string helpers. No VS Code API dependencies, so they are easy to
 * read, reuse, and unit test in isolation.
 */

/** Matches `#rgb`, `#rrggbb`, or `#rrggbbaa`. */
export const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Deterministic djb2 hash, so a given string always maps to the same number. */
export function hashString(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
	}
	return hash;
}

/** Strip trailing path separators so path keys compare cleanly. */
export function normalizePath(p: string): string {
	return p.replace(/[\\/]+$/, '');
}

/** Expand a hex color to its red/green/blue components (0-255). */
function toRgb(hex: string): { r: number; g: number; b: number } {
	let h = hex.replace('#', '');
	if (h.length === 3) {
		h = h.split('').map(c => c + c).join('');
	}
	return {
		r: parseInt(h.slice(0, 2), 16),
		g: parseInt(h.slice(2, 4), 16),
		b: parseInt(h.slice(4, 6), 16),
	};
}

/** Convert a hex color plus an alpha (0-1) into a CSS `rgba(...)` string. */
export function hexToRgba(hex: string, alpha: number): string {
	const { r, g, b } = toRgb(hex);
	const a = Math.max(0, Math.min(1, alpha));
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Mix a hex color toward white by `amount` (0-1) — a lighter shade. */
export function lightenHex(hex: string, amount: number): string {
	const { r, g, b } = toRgb(hex);
	const mix = (c: number) => Math.round(c + (255 - c) * amount);
	return '#' + [mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}


/** Black or white — whichever reads better on the given hex background. */
export function contrastColor(hex: string): '#000000' | '#ffffff' {
	const { r, g, b } = toRgb(hex);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff';
}

/** Clamp a number into the 0..1 range. */
function clamp01(n: number): number {
	return Math.max(0, Math.min(1, n));
}

/**
 * A folder's unique colour *sequence*, Telegram-style. `firstHex` stays the
 * folder's existing colour so nothing already on screen shifts; the remaining
 * entries are hashed off `basis` and de-duplicated, walking forward through the
 * palette when a hash collides with a colour already chosen.
 */
export function paletteSequence(basis: string, palette: string[], count: number, firstHex: string): string[] {
	const out = [firstHex];
	const wanted = Math.max(1, Math.min(count, palette.length || 1));
	if (wanted === 1 || palette.length === 0) {
		return out;
	}
	const used = new Set([firstHex.toLowerCase()]);
	for (let k = 1; out.length < wanted; k++) {
		const start = hashString(`${basis}:${k}`) % palette.length;
		for (let step = 0; step < palette.length; step++) {
			const candidate = palette[(start + step) % palette.length];
			if (!used.has(candidate.toLowerCase())) {
				used.add(candidate.toLowerCase());
				out.push(candidate);
				break;
			}
		}
		// The palette can hold fewer distinct colours than asked for; bail rather than spin.
		if (k > palette.length + wanted) {
			break;
		}
	}
	return out;
}

/**
 * The 45° repeating stripe used by the `edge` layer. One colour degrades to a
 * plain solid bar, which is exactly what the old box-shadow edge looked like.
 */
export function stripeGradient(colors: string[], band: number): string {
	if (colors.length === 0) {
		return '';
	}
	if (colors.length === 1) {
		return `linear-gradient(${colors[0]},${colors[0]})`;
	}
	const width = Math.max(1, Math.round(band));
	const stops = colors
		.map((c, i) => `${c} ${i * width}px ${(i + 1) * width}px`)
		.join(',');
	return `repeating-linear-gradient(45deg,${stops})`;
}

/** Escape the few characters that would break out of an SVG text node. */
function escapeXml(s: string): string {
	return s.replace(/[&<>'"]/g, c =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c] as string));
}

/** Round to 2dp — keeps the generated data URI small. */
function r2(n: number): string {
	return String(Math.round(n * 100) / 100);
}

/** Deterministic PRNG (mulberry32) so a folder's pattern is stable across runs. */
function seededRandom(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6D2B79F5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The artwork a watermark tiles: either a font watermark or a piece of SVG.
 *
 * SVG art is carried as the source's *inner* markup plus its viewBox, so the
 * pattern can stamp it into `<defs>` once and `<use>` it for every copy instead
 * of repeating the whole drawing.
 */
export interface WatermarkArt {
	kind: 'watermark' | 'svg';
	/** The watermark text, or the source SVG's inner markup. */
	content: string;
	/** SVG only: the source viewBox, so the art scales into its box. */
	viewBox?: string;
	/** Stable identity for seeding — the watermark, or where the SVG came from. */
	key: string;
}

/**
 * Pull the drawable part out of an SVG document: everything inside the root
 * `<svg>` element, plus a viewBox to scale it by (synthesised from width/height
 * when the source omits one). Returns undefined if this isn't an SVG at all.
 */
export function parseSvgMarkup(markup: string): { body: string; viewBox: string } | undefined {
	const src = markup
		.replace(/<\?xml[\s\S]*?\?>/g, '')
		.replace(/<!DOCTYPE[\s\S]*?>/g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.trim();
	const open = /<svg\b([^>]*)>/i.exec(src);
	const close = src.lastIndexOf('</svg>');
	if (!open || close < 0) {
		return undefined;
	}
	const attrs = open[1];
	// Drop what never renders — an exported logo's metadata block can dwarf the
	// drawing itself, and every byte here ends up in a data URI inside the CSS.
	const body = src.slice(open.index + open[0].length, close)
		.replace(/<(metadata|title|desc)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!body) {
		return undefined;
	}
	const viewBox = /viewBox\s*=\s*['"]([^'"]+)['"]/i.exec(attrs);
	if (viewBox) {
		return { body, viewBox: viewBox[1].trim() };
	}
	// No viewBox: fall back to the declared width/height, else a unit square.
	const num = (name: string): number => {
		const m = new RegExp(`\\b${name}\\s*=\\s*['"]\\s*([\\d.]+)`, 'i').exec(attrs);
		return m ? parseFloat(m[1]) : 0;
	};
	const w = num('width') || 24;
	const h = num('height') || w;
	return { body, viewBox: `0 0 ${w} ${h}` };
}

/**
 * Drop an SVG's own colors so it inherits one flat tint, keeping `none` (which is
 * structural — an outline icon relies on `fill="none"`) and `currentColor`.
 */
function neutralizeSvg(body: string): string {
	// `none` is structural (an outline icon relies on `fill="none"`) and
	// `currentColor` already follows the tint, so both survive. Everything else —
	// attributes, inline styles, and the CSS classes an Illustrator export uses —
	// is dropped so the artwork inherits one flat colour.
	const keep = (value: string): boolean => /^(none|currentcolor)$/i.test(value.trim());
	// ...with one exception. A Sketch/Figma export wraps the drawing in
	// `<g stroke="none" fill="none" fill-rule="evenodd">` and puts the real colour
	// on each path. Strip those colours and the paths fall back to the group's
	// `none`, so the whole artwork renders as nothing. That `none` is scaffolding,
	// not structure: it is only reachable by a shape that had its own fill. An
	// outline icon is the opposite — nothing in it is filled, and its `fill="none"`
	// is the drawing — so the group scaffolding is dropped only from artwork that
	// paints with fills somewhere, and only on containers, never on a shape itself.
	if (paintsWithFill(body)) {
		body = body.replace(/<g\b[^>]*>/gi, tag => tag.replace(/\sfill\s*=\s*(['"])\s*none\s*\1/gi, ''));
	}
	return body
		.replace(/\s(fill|stroke)\s*=\s*(['"])([^'"]*)\2/gi, (m, _p, _q, value: string) => keep(value) ? m : '')
		.replace(/(fill|stroke)\s*:\s*([^;'"}]+);?/gi, (m, _p, value: string) => keep(value) ? m : '');
}

/** Does this artwork fill any shape with a real colour (rather than only stroke it)? */
function paintsWithFill(body: string): boolean {
	return /\sfill\s*=\s*(['"])\s*(?!none|currentcolor)[^'"]+\1/i.test(body)
		|| /fill\s*:\s*(?!\s*(?:none|currentcolor)\s*[;'"}])[^;'"}]+/i.test(body);
}

/**
 * The folder's watermark as a `url(data:image/svg+xml,...)` background.
 *
 * This is a whole *canvas*, not a small repeating tile: `canvas` px square,
 * scattered with copies of the artwork on a jittered grid, each with its own
 * size, opacity and tilt (`variation` drives size and opacity, `rotation` the
 * tilt). At the
 * default 512px it is wider than any sidebar and ~23 rows tall, so a folder's
 * background reads as one unique composition rather than wallpaper. Everything
 * is seeded off the folder, so it differs per folder but is identical run to run.
 *
 * The canvas is anchored to the top of the folder's block when painted (see
 * inject.js), so the scatter flows unbroken across the root row and everything
 * nested inside it rather than restarting on every row. Copies near an edge are
 * duplicated across the seam, so the wrap on a very deep tree stays invisible.
 *
 * Shared appearance (fill, font, anchoring) lives on the root `<svg>` and is
 * inherited, which keeps the data URI small — it is embedded per folder, twice.
 */
export function watermarkPatternDataUri(
	art: WatermarkArt,
	seed: string,
	canvas: number,
	size: number,
	density: number,
	variation: number,
	rotation: number,
	color: string,
	opacity: number,
	dim: number,
	dimWidth: number,
	dimHeight: number,
	wantSpots: boolean,
): { uri: string; spots: number[] } {
	const T = Math.max(32, Math.round(canvas));
	const v = clamp01(variation);
	// `density` is per 100x100px, so the look holds when the canvas is resized.
	const n = Math.max(1, Math.min(400, Math.round(density * (T / 100) ** 2)));
	const rand = seededRandom(hashString(`${seed}|${art.key}|${n}`));
	const cols = Math.ceil(Math.sqrt(n));
	const rows = Math.ceil(n / cols);
	const cw = T / cols;
	const ch = T / rows;
	const text = art.kind === 'watermark' ? escapeXml(art.content) : '';
	// A watermark wants one flat shade, so the artwork's own fills are dropped and
	// it inherits `color` from the root svg. `color: ''` opts out and keeps them.
	const artwork = art.kind === 'svg' && color ? neutralizeSvg(art.content) : art.content;
	const nodes: string[] = [];
	// Where each copy landed, for the text cover: the painter matches these against a
	// row's label to find the watermarks it runs into. Only collected when that cover is
	// on, since it is a few KB per pattern and the file carries one per folder.
	const spots: number[] = [];
	// The clearing down the middle, where the filenames run. `depth` is 1 at its
	// centre and 0 outside it; copies that fall inside are thinned and faded by how
	// deep they sit, so the middle of the pane holds fewer, softer marks while the
	// margins keep the pattern at full strength. Doing it here rather than laying
	// something over the row is what keeps it honest — nothing is painted on top that
	// could fail to match the row's own colour.
	//
	// Across: a straight taper from the centre line out to `dimWidth / 2`.
	// Down: full strength for `dimHeight` of the canvas, then eased off to nothing by
	// the seam, which is what gives the lens its points. `dimHeight` at or above the
	// canvas removes the taper altogether — the clearing then runs the whole way down
	// and every row gets it equally, which also tiles seamlessly because there is
	// nothing left to vary.
	const lens = clamp01(dim);
	const halfW = Math.max(1, dimWidth / 2);
	const hold = clamp01(Math.max(0, dimHeight) / T);
	const depth = (px: number, py: number): number => {
		const across = 1 - Math.min(1, Math.abs(px - halfW) / halfW);
		if (across <= 0) {
			return 0;
		}
		const dy = Math.abs(py - T / 2) / (T / 2);
		if (hold >= 1) {
			return across;
		}
		if (dy >= 1) {
			return 0;
		}
		const e = dy <= hold ? 1 : 1 - (dy - hold) / (1 - hold);
		return across * e * e * (3 - 2 * e);   // smoothstep, so the seam stays invisible
	};

	for (let i = 0; i < n; i++) {
		// Jittered grid cell -> uneven gaps rather than a regular lattice.
		const x = (i % cols) * cw + cw / 2 + (rand() * 2 - 1) * cw * 0.35 * (0.4 + v);
		const y = Math.floor(i / cols) * ch + ch / 2 + (rand() * 2 - 1) * ch * 0.35 * (0.4 + v);
		const fs = Math.max(4, size * (1 + (rand() * 2 - 1) * v));
		const op = clamp01(opacity * (1 + (rand() * 2 - 1) * v));
		// Rotation is its own knob rather than another thing `variation` scales: on a
		// canvas this size the tilt is what stops rows of the same mark reading as a
		// grid, and you want it even when sizes are uniform.
		const rot = (rand() * 2 - 1) * rotation;
		// Wrap across the canvas seam so a deep tree's repeat is invisible.
		for (const dx of [-T, 0, T]) {
			for (const dy of [-T, 0, T]) {
				const px = x + dx;
				const py = y + dy;
				if (px < -fs || px > T + fs || py < -fs || py > T + fs) {
					continue;
				}
				// Thin the scatter first, then fade what survives. Both are driven by the
				// same depth, so a copy near the centre is likelier to be dropped and, if
				// it stays, dimmer — while the margins keep the pattern at full strength.
				const into = lens * depth(px, py);
				if (into > 0 && rand() < into * 0.85) {
					continue;
				}
				const dimmed = clamp01(op * (1 - into));
				if (dimmed <= 0.01) {
					continue;
				}
				if (wantSpots) {
					spots.push(Math.round(px), Math.round(py), Math.round(fs), Math.round(dimmed * 100) / 100);
				}
				const spin = rot ? ` transform='rotate(${r2(rot)} ${r2(px)} ${r2(py)})'` : '';
				nodes.push(art.kind === 'watermark'
					? `<text x='${r2(px)}' y='${r2(py)}' font-size='${r2(fs)}' fill-opacity='${r2(dimmed)}'${spin}>${text}</text>`
					: `<use href='#ps-watermark' x='${r2(px - fs / 2)}' y='${r2(py - fs / 2)}' ` +
					`width='${r2(fs)}' height='${r2(fs)}' opacity='${r2(dimmed)}'${spin}/>`,
				);
			}
		}
	}

	// Presentation attributes every copy would otherwise repeat.
	const shared = art.kind === 'watermark'
		? ` text-anchor='middle' dominant-baseline='central' font-family='sans-serif'${color ? ` fill='${color}'` : ''}`
		: (color ? ` fill='${color}' color='${color}'` : '');
	const defs = art.kind === 'svg'
		? `<defs><symbol id='ps-watermark' viewBox='${escapeXml(art.viewBox ?? '0 0 24 24')}'>${artwork}</symbol></defs>`
		: '';
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${T}' height='${T}'${shared}>${defs}${nodes.join('')}</svg>`;
	return { uri: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, spots };
}
