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

/**
 * Split a hex into its opaque 6-digit form and its own alpha channel
 * (`#rrggbbaa` carries one; everything else is opaque).
 */
export function splitHexAlpha(hex: string): { hex: string; alpha: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h.split('').map(c => c + c).join('');
  }
  const alpha = h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1;
  return { hex: '#' + h.slice(0, 6).toLowerCase(), alpha };
}

/** Mix two hex colors: `t` = 0 gives `a`, 1 gives `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = toRgb(a);
  const cb = toRgb(b);
  const f = clamp01(t);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * f);
  return '#' + [mix(ca.r, cb.r), mix(ca.g, cb.g), mix(ca.b, cb.b)]
    .map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert a hex color plus an alpha (0-1) into a CSS `rgba(...)` string. The alpha
 * is rounded: it is often the product of two settings (a layer opacity times a
 * symlink dim, say), and float error would otherwise write
 * `rgba(42, 157, 143, 0.30250000000000005)` into every row's inline style.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = toRgb(hex);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 10000) / 10000;
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

/* ------------------------------------------------------------------------- *
 * Corner radii (EM-103)
 * ------------------------------------------------------------------------- */

/**
 * A corner radius: one number for all four corners, or the CSS order
 * *top-left, top-right, bottom-right, bottom-left* as a short array (`[6, 6, 0, 0]`)
 * or a string (`"6 6 0 0"`). Fewer than four entries fill in exactly as the CSS
 * `border-radius` shorthand does, so what the user writes means what it means in
 * CSS.
 */
export type Radius = number | number[] | string;

/** Validate a raw settings value into a {@link Radius} (undefined = not set). */
export function parseRadius(raw: unknown): Radius | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  const parts = typeof raw === 'string'
    ? raw.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    : Array.isArray(raw) ? raw.map(Number) : undefined;
  if (!parts || !parts.length || parts.length > 4 || parts.some(n => !Number.isFinite(n))) {
    return undefined;
  }
  return parts;
}

/**
 * The four corners in CSS order (tl, tr, br, bl), clamped at 0. One value covers
 * all four; two are tl/br and tr/bl; three are tl, tr/bl, br — the CSS shorthand,
 * so `"6 0"` rounds the diagonal pair exactly as it would in a stylesheet.
 */
export function resolveRadius(radius: Radius): number[] {
  const parts = (typeof radius === 'number' ? [radius] : typeof radius === 'string'
    ? (parseRadius(radius) as number[] | undefined) ?? [0] : radius).map(n => Math.max(0, n || 0));
  switch (parts.length) {
    case 1: return [parts[0], parts[0], parts[0], parts[0]];
    case 2: return [parts[0], parts[1], parts[0], parts[1]];
    case 3: return [parts[0], parts[1], parts[2], parts[1]];
    default: return [parts[0], parts[1], parts[2], parts[3]];
  }
}

/**
 * The padding inside a pill, in px: `[top, right, bottom, left]`.
 *
 * A **single number is horizontal only**, with the vertical left at 0 — which is
 * CSS's `padding: 5px` meaning something else, and is deliberate: the shipped pill
 * is `0 5px`, so `5` has to keep reproducing it. Two values are `[vertical,
 * horizontal]` and three or four follow the CSS shorthand, both as in CSS.
 */
export function resolvePadding(padding: Radius): number[] {
  const parts = (typeof padding === 'number' ? [padding] : typeof padding === 'string'
    ? (parseRadius(padding) as number[] | undefined) ?? [0] : padding).map(n => Math.max(0, n || 0));
  switch (parts.length) {
    case 1: return [0, parts[0], 0, parts[0]];
    case 2: return [parts[0], parts[1], parts[0], parts[1]];
    case 3: return [parts[0], parts[1], parts[2], parts[1]];
    default: return [parts[0], parts[1], parts[2], parts[3]];
  }
}

/** Is every corner square? (The painter writes no `border-radius` at all then.) */
export function isSquare(corners: readonly number[]): boolean {
  return corners.every(n => !n);
}

/** How the edge bar's colour sequence is drawn: hard bands, or blended into each other. */
export type StripeBlend = 'bands' | 'gradient';

/**
 * The repeating stripe used by the `edge` layer. One colour degrades to a
 * plain solid bar, which is exactly what the old box-shadow edge looked like.
 * `direction` follows the shared Fill spelling (`diagonal-reverse` = the
 * historical 45° stripe); `gradient` blends the sequence instead of cutting
 * hard bands, wrapping back to the first colour so the repeat stays seamless.
 */
export function stripeGradient(
  colors: string[],
  band: number,
  direction: FillDirection = 'diagonal-reverse',
  blend: StripeBlend = 'bands',
): string {
  if (colors.length === 0) {
    return '';
  }
  if (colors.length === 1) {
    return `linear-gradient(${colors[0]},${colors[0]})`;
  }
  const width = Math.max(1, Math.round(band));
  const angle = fillAngle(direction);
  if (blend === 'gradient') {
    const loop = [...colors, colors[0]];
    const stops = loop.map((c, i) => `${c} ${i * width}px`).join(',');
    return `repeating-linear-gradient(${angle},${stops})`;
  }
  const stops = colors
    .map((c, i) => `${c} ${i * width}px ${(i + 1) * width}px`)
    .join(',');
  return `repeating-linear-gradient(${angle},${stops})`;
}

/* ------------------------------------------------------------------------- *
 * Multi-stop fills (the shared `Fill` type — see docs/fill-spec.md)
 * ------------------------------------------------------------------------- */

/**
 * Where a fill runs. The names map to CSS gradient angles:
 * `vertical` 180° (top → bottom), `horizontal` 90° (left → right),
 * `diagonal` 135° (top-left → bottom-right), `diagonal-reverse` 45°
 * (bottom-left → top-right). A number is a CSS angle in degrees.
 */
export type FillDirection = 'vertical' | 'horizontal' | 'diagonal' | 'diagonal-reverse' | number;

/** One normalized stop: an opaque hex, its own alpha (0–1), and its position (0–100). */
export interface FillStop {
  color: string;
  alpha: number;
  /**
   * `gradient` blend: the stop's position. `split` blend: where this stop's hard
   * band *ends*. Omitted positions are distributed (see {@link normalizedStops}).
   */
  at?: number;
}

/** A multi-stop fill, as validated by {@link parseFill}. */
export interface FillSpec {
  stops: FillStop[];
  /** `split` = hard edges between the colors; `gradient` = blended. */
  blend: 'split' | 'gradient';
  direction: FillDirection;
}

/**
 * The shared fill vocabulary: a plain hex (alpha-carrying `#rrggbbaa` allowed),
 * or a stop list. Settings carry the raw user value; `parseFill` is the one
 * place that turns it into this.
 */
export type Fill = string | FillSpec;

const FILL_DIRECTIONS: readonly string[] = ['vertical', 'horizontal', 'diagonal', 'diagonal-reverse'];

/** One raw stop from settings into a {@link FillStop}, or undefined if unusable. */
function parseFillStop(raw: unknown): FillStop | undefined {
  if (typeof raw === 'string') {
    if (!HEX_RE.test(raw)) {
      return undefined;
    }
    const { hex, alpha } = splitHexAlpha(raw);
    return { color: hex, alpha };
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.color !== 'string' || !HEX_RE.test(o.color)) {
    return undefined;
  }
  const { hex, alpha: hexAlpha } = splitHexAlpha(o.color);
  // An explicit `alpha` multiplies on whatever the hex itself carries.
  const alpha = typeof o.alpha === 'number' ? clamp01(o.alpha) * hexAlpha : hexAlpha;
  const at = typeof o.at === 'number' ? Math.max(0, Math.min(100, o.at)) : undefined;
  return { color: hex, alpha, at };
}

/**
 * Validate a raw settings value into a {@link Fill}. A hex string passes
 * through; an object needs a non-empty `stops` list (invalid entries make the
 * whole fill invalid — a half-read gradient would paint something the user
 * never wrote). Anything else is undefined, i.e. "no fill set".
 */
export function parseFill(raw: unknown): Fill | undefined {
  if (typeof raw === 'string') {
    return HEX_RE.test(raw) ? raw : undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.stops) || o.stops.length === 0) {
    return undefined;
  }
  const stops: FillStop[] = [];
  for (const s of o.stops) {
    const stop = parseFillStop(s);
    if (!stop) {
      return undefined;
    }
    stops.push(stop);
  }
  const blend = o.blend === 'split' || o.blend === 'gradient' ? o.blend : 'gradient';
  const direction: FillDirection =
    typeof o.direction === 'number' && Number.isFinite(o.direction) ? o.direction
      : typeof o.direction === 'string' && FILL_DIRECTIONS.includes(o.direction) ? o.direction as FillDirection
        : 'horizontal';
  return { stops, blend, direction };
}

/** A fill resolved to ready-to-apply CSS (see docs/fill-spec.md for the contract). */
export interface ResolvedFill {
  /** `rgba(...)` when the fill collapses to one color — goes where a solid goes today. */
  color: string;
  /** `linear-gradient(...)` when it doesn't — the bottom-most background image. */
  image: string;
  /** The fill's *ground*: its opaque hex at the element's centre (t = 50%). */
  hex: string;
  /** The ground's alpha, after the layer opacity multiplier. */
  alpha: number;
}

/**
 * Does this direction carry any vertical component at all? A CSS gradient splits
 * its colour change between the two axes in proportion to the box it fills, so on
 * a 22px row anything but a purely horizontal fill has almost no room to read
 * (EM-104) — which is what decides whether an `auto` fill scale stretches over the
 * folder's block. 90deg and 270deg (`horizontal`) are the only purely horizontal
 * angles.
 */
export function fillHasVertical(direction: FillDirection): boolean {
  if (typeof direction === 'number') {
    const mod = ((direction % 180) + 180) % 180;
    return Math.abs(mod - 90) > 0.5;
  }
  return direction !== 'horizontal';
}

/** The direction a {@link Fill} runs (a plain hex has none worth speaking of). */
export function fillDirectionOf(fill: Fill): FillDirection {
  return typeof fill === 'string' ? 'horizontal' : fill.direction;
}

/** CSS angle for a {@link FillDirection}. */
function fillAngle(direction: FillDirection): string {
  if (typeof direction === 'number') {
    return `${Math.round(direction * 100) / 100}deg`;
  }
  switch (direction) {
    case 'vertical': return '180deg';
    case 'horizontal': return '90deg';
    case 'diagonal': return '135deg';
    default: return '45deg';   // diagonal-reverse
  }
}

/**
 * Concrete positions for every stop. `gradient`: explicit `at`s anchor, the
 * first/last default to 0/100, gaps spread evenly between anchors (what CSS
 * itself would do) — made explicit so the ground can be computed. `split`: `at`
 * is where a band ends; missing ends divide the remaining run equally. Both are
 * clamped monotonic so an out-of-order list degrades instead of flipping.
 */
function normalizedStops(stops: FillStop[], blend: 'split' | 'gradient'): { color: string; alpha: number; at: number }[] {
  const n = stops.length;
  const out = stops.map(s => ({ color: s.color, alpha: s.alpha, at: s.at }));
  if (blend === 'split') {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const fallback = prev + (100 - prev) / (n - i);
      const at = i === n - 1 ? 100 : Math.max(prev, out[i].at ?? fallback);
      out[i].at = at;
      prev = at;
    }
  } else {
    out[0].at = out[0].at ?? 0;
    out[n - 1].at = out[n - 1].at ?? 100;
    let anchor = 0;
    for (let i = 1; i < n; i++) {
      if (out[i].at === undefined) {
        continue;
      }
      const gap = i - anchor;
      const from = out[anchor].at as number;
      const to = Math.max(from, out[i].at as number);
      out[i].at = to;
      for (let k = 1; k < gap; k++) {
        out[anchor + k].at = from + ((to - from) * k) / gap;
      }
      anchor = i;
    }
  }
  return out as { color: string; alpha: number; at: number }[];
}

/**
 * THE fill resolver — every layer that takes a `Fill` goes through here, so a
 * gradient means the same thing on a background, a pill, a selection or the
 * edge bar. `opacity` multiplies each stop's alpha (the layer's `*Opacity`
 * setting); `lighten`/`alphaBoost` bake a hover variant the same way solids
 * brighten today (each stop lifted toward white, alpha nudged up).
 */
export function resolveFill(fill: Fill, opacity = 1, lighten = 0, alphaBoost = 0): ResolvedFill {
  const spec: FillSpec = typeof fill === 'string'
    ? (({ hex, alpha }) => ({ stops: [{ color: hex, alpha }], blend: 'gradient' as const, direction: 'horizontal' as const }))(splitHexAlpha(fill))
    : fill;
  const stops = normalizedStops(spec.stops, spec.blend).map(s => ({
    color: lighten > 0 ? lightenHex(s.color, lighten) : s.color,
    // An alpha-0 stop is a shape choice (a fade-in's invisible edge), so a hover
    // boost never surfaces it — only stops that already show brighten.
    alpha: s.alpha > 0 ? clamp01(clamp01(s.alpha * opacity) + alphaBoost) : 0,
    at: s.at,
  }));

  // The ground: what the fill shows at the element's centre. Everything that
  // assumes "the row's color" (shift/invert, watermarkContrast, flatten in the
  // painter) reads this instead of guessing at a gradient.
  let hex = stops[0].color;
  let alpha = stops[0].alpha;
  if (stops.length > 1) {
    if (spec.blend === 'split') {
      const seg = stops.find(s => s.at > 50) ?? stops[stops.length - 1];
      hex = seg.color;
      alpha = seg.alpha;
    } else {
      let lo = stops[0];
      let hi = stops[stops.length - 1];
      for (const s of stops) {
        if (s.at <= 50) { lo = s; }
      }
      for (let i = stops.length - 1; i >= 0; i--) {
        if (stops[i].at >= 50) { hi = stops[i]; }
      }
      const span = hi.at - lo.at;
      const t = span > 0 ? (50 - lo.at) / span : 0;
      hex = mixHex(lo.color, hi.color, t);
      alpha = lo.alpha + (hi.alpha - lo.alpha) * t;
    }
  }
  alpha = Math.round(alpha * 1000) / 1000;

  if (stops.length === 1) {
    return { color: hexToRgba(stops[0].color, stops[0].alpha), image: '', hex, alpha };
  }
  const angle = fillAngle(spec.direction);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  let body: string;
  if (spec.blend === 'split') {
    let prev = 0;
    body = stops.map(s => {
      const piece = `${hexToRgba(s.color, s.alpha)} ${r1(prev)}% ${r1(s.at)}%`;
      prev = s.at;
      return piece;
    }).join(',');
  } else {
    body = stops.map(s => `${hexToRgba(s.color, s.alpha)} ${r1(s.at)}%`).join(',');
  }
  return { color: '', image: `linear-gradient(${angle},${body})`, hex, alpha };
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
  /**
   * SVG only: a `fill` declared on the source's own root `<svg>`, which every
   * shape inside inherits. It has to be carried separately because only the
   * *inner* markup is kept — drop it and a one-colour icon that paints entirely by
   * inheritance (`<svg fill="#D97757">…`) renders black, which on a dark row is
   * invisible. Only used where the artwork keeps its own colours.
   */
  fill?: string;
  /** Stable identity for seeding — the watermark, or where the SVG came from. */
  key: string;
}

/**
 * Pull the drawable part out of an SVG document: everything inside the root
 * `<svg>` element, plus a viewBox to scale it by (synthesised from width/height
 * when the source omits one). Returns undefined if this isn't an SVG at all.
 */
export function parseSvgMarkup(markup: string): { body: string; viewBox: string; fill?: string } | undefined {
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
  // A `fill` on the root element is inherited by everything inside it, and the
  // body alone does not carry it (see WatermarkArt.fill).
  const rootFill = /\bfill\s*=\s*['"]([^'"]+)['"]/i.exec(attrs);
  const fill = rootFill && !/^(none|currentcolor)$/i.test(rootFill[1].trim())
    ? { fill: rootFill[1].trim() } : {};
  const viewBox = /viewBox\s*=\s*['"]([^'"]+)['"]/i.exec(attrs);
  if (viewBox) {
    return { body, viewBox: viewBox[1].trim(), ...fill };
  }
  // No viewBox: fall back to the declared width/height, else a unit square.
  const num = (name: string): number => {
    const m = new RegExp(`\\b${name}\\s*=\\s*['"]\\s*([\\d.]+)`, 'i').exec(attrs);
    return m ? parseFloat(m[1]) : 0;
  };
  const w = num('width') || 24;
  const h = num('height') || w;
  return { body, viewBox: `0 0 ${w} ${h}`, ...fill };
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
 * One copy of a piece of artwork as a `url(data:image/svg+xml,...)` background —
 * the **mark** (EM-94): a fixed, hand-picked glyph sitting just after a folder's
 * label, like a per-chat sticker. Unlike the watermark this is a single stamp at
 * full strength, and it keeps the drawing's **own colours** unless `color` names a
 * tint, which is the whole point of picking a real logo for it.
 *
 * No width/height is declared, so the drawing scales to whatever
 * `background-size` the painter gives the layer.
 */
export function markDataUri(art: WatermarkArt, color: string): string {
  if (art.kind === 'watermark') {
    // Not a drawing: stamp the character, which needs *some* colour to be visible
    // at all — unlike an SVG, there is nothing of its own to keep.
    const fill = color || 'currentColor';
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>`
      + `<text x='50' y='50' font-size='86' font-family='sans-serif' text-anchor='middle' `
      + `dominant-baseline='central' fill='${fill}'>${escapeXml(art.content)}</text></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }
  const body = color ? neutralizeSvg(art.content) : art.content;
  const tint = color ? ` fill='${color}' color='${color}'`
    : art.fill ? ` fill='${escapeXml(art.fill)}'` : '';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${escapeXml(art.viewBox ?? '0 0 24 24')}'${tint}>`
    + `${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * How the watermark copies are laid out on the canvas (EM-91 §1).
 *   `scatter`    — the jittered field across the whole canvas (the default, and
 *                  what shipped before this key existed).
 *   `right-edge` — the same field squeezed into a band at the right edge, so the
 *                  glyphs hug the far side and keep clear of the filenames.
 *   `row`        — one horizontal line of glyphs in the canvas's top band, laid
 *                  out from the right edge. With the canvas left at its default
 *                  that line lands on the folder's root row and nothing else;
 *                  with `watermarkCanvas` set to a row's height it repeats once
 *                  per row.
 *   `corner`     — a single oversized glyph hugging the top-right corner, read as
 *                  a badge. One per canvas, never duplicated across the seam, so
 *                  the pane's own edge is what clips it.
 */
export type WatermarkLayout = 'scatter' | 'right-edge' | 'row' | 'corner';

/**
 * How wide the right-hand band is that the `right-edge` and `row` layouts keep to:
 * enough for a couple of glyphs, and never less than a fifth of the canvas, so it
 * reads as a margin rather than a column of clipped marks.
 */
function edgeBand(canvas: number, size: number): number {
  return Math.min(canvas, Math.max(size * 2.5, canvas * 0.22));
}

/** One placed copy, before the canvas seam is wrapped and the clearing applied. */
interface WatermarkPlacement {
  x: number;
  y: number;
  fs: number;
  op: number;
  rot: number;
  /** Index into the artwork list — which glyph this copy draws (EM-91 §5/§6). */
  art: number;
}

/**
 * The folder's watermark as a `url(data:image/svg+xml,...)` background.
 *
 * This is a whole *canvas*, not a small repeating tile: `canvas` px square,
 * laid out with copies of the artwork per `layout` — by default a jittered grid,
 * each copy with its own size, opacity and tilt (`variation` drives size and
 * opacity, `rotation` the tilt). At the
 * default 512px it is wider than any sidebar and ~23 rows tall, so a folder's
 * background reads as one unique composition rather than wallpaper. Everything
 * is seeded off the folder, so it differs per folder but is identical run to run.
 *
 * `arts` may hold more than one drawing, in which case each copy picks one
 * (seeded, so the mix is stable) — the design's "mixed symbols" and "mixed icons
 * in one watermark" cases.
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
  arts: WatermarkArt[],
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
  layout: WatermarkLayout = 'scatter',
): { uri: string; spots: number[] } {
  const T = Math.max(32, Math.round(canvas));
  const v = clamp01(variation);
  // `density` is per 100x100px, so the look holds when the canvas is resized.
  const n = Math.max(1, Math.min(400, Math.round(density * (T / 100) ** 2)));
  // `scatter` is left out of the seed, and a lone drawing never draws from the
  // random stream, so the one-glyph scatter that shipped before this key existed
  // keeps the exact pattern it had.
  const rand = seededRandom(hashString(
    `${seed}|${arts.map(a => a.key).join(',')}|${n}${layout === 'scatter' ? '' : `|${layout}`}`));
  const jit = (): number => rand() * 2 - 1;
  const pick = (): number => (arts.length > 1 ? Math.floor(rand() * arts.length) : 0);

  // Where every copy goes. Only this differs between layouts; the seam wrap, the
  // clearing and the emit below are shared.
  const places: WatermarkPlacement[] = [];
  if (layout === 'corner') {
    // One oversized glyph in the top-right corner. `density`, `variation` and
    // `rotation` have nothing to vary here — it is a single deliberate mark.
    const fs = Math.max(8, size);
    places.push({ x: T - fs * 0.3, y: fs * 0.3, fs, op: clamp01(opacity), rot: 0, art: 0 });
  } else if (layout === 'row') {
    // One line of glyphs in the top band, laid out leftwards from the right edge —
    // and no further than the same band `right-edge` uses, so the line stays clear
    // of the filenames instead of running under them across the whole pane.
    const base = Math.max(4, size);
    const gap = Math.max(2, base * 0.6);
    const fits = Math.max(1, Math.floor((edgeBand(T, size) - base) / (base + gap)));
    for (let k = 0; k < Math.min(n, fits); k++) {
      places.push({
        x: T - base - k * (base + gap) - base / 2,
        y: base * 0.9,
        fs: Math.max(4, base * (1 + jit() * v)),
        op: clamp01(opacity * (1 + jit() * v)),
        rot: jit() * rotation,
        art: pick(),
      });
    }
  } else {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = T / cols;
    const ch = T / rows;
    // `right-edge` keeps the same jittered field but squeezes it into a band at
    // the right, so the glyphs sit where no filename reaches.
    const band = layout === 'right-edge' ? edgeBand(T, size) : 0;
    for (let i = 0; i < n; i++) {
      // Jittered grid cell -> uneven gaps rather than a regular lattice.
      let x = (i % cols) * cw + cw / 2 + jit() * cw * 0.35 * (0.4 + v);
      const y = Math.floor(i / cols) * ch + ch / 2 + jit() * ch * 0.35 * (0.4 + v);
      const fs = Math.max(4, size * (1 + jit() * v));
      const op = clamp01(opacity * (1 + jit() * v));
      // Rotation is its own knob rather than another thing `variation` scales: on a
      // canvas this size the tilt is what stops rows of the same mark reading as a
      // grid, and you want it even when sizes are uniform.
      const rot = jit() * rotation;
      if (band) {
        x = T - band + (Math.max(0, Math.min(T, x)) / T) * band;
      }
      places.push({ x, y, fs, op, rot, art: pick() });
    }
  }

  // A watermark wants one flat shade, so the artwork's own fills are dropped and
  // it inherits `color` from the root svg. `color: ''` opts out and keeps them.
  const bodies = arts.map(a => (a.kind === 'svg' && color ? neutralizeSvg(a.content) : a.content));
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
  // could fail to match the row's own colour. The `right-edge`, `row` and `corner`
  // layouts keep clear of the names by construction, so the taper never reaches
  // them and they need no special case.
  //
  // Across: a straight taper from the centre line out to `dimWidth / 2`.
  // Down: full strength for `dimHeight` of the canvas, then eased off to nothing by
  // the seam, which is what gives the lens its points. `dimHeight` at or above the
  // canvas removes the taper altogether — the clearing then runs the whole way down
  // and every row gets it equally, which also tiles seamlessly because there is
  // nothing left to vary.
  // The clearing exists to keep a *scattered* field out of the filenames. `row` and
  // `corner` are placed deliberately and already sit clear of them, so thinning them
  // would only delete marks the user asked for — at a small canvas it could remove
  // the corner badge outright.
  const lens = layout === 'row' || layout === 'corner' ? 0 : clamp01(dim);
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

  // A corner badge is clipped by the pane's own edge, which is the look; wrapping it
  // across the seam would instead leave a sliver of it at the opposite edge.
  const wraps = layout === 'corner' ? [0] : [-T, 0, T];
  for (const place of places) {
    // Wrap across the canvas seam so a deep tree's repeat is invisible.
    for (const dx of wraps) {
      for (const dy of wraps) {
        const px = place.x + dx;
        const py = place.y + dy;
        const fs = place.fs;
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
        const dimmed = clamp01(place.op * (1 - into));
        if (dimmed <= 0.01) {
          continue;
        }
        if (wantSpots) {
          spots.push(Math.round(px), Math.round(py), Math.round(fs), Math.round(dimmed * 100) / 100);
        }
        const spin = place.rot ? ` transform='rotate(${r2(place.rot)} ${r2(px)} ${r2(py)})'` : '';
        nodes.push(arts[place.art].kind === 'watermark'
          ? `<text x='${r2(px)}' y='${r2(py)}' font-size='${r2(fs)}' fill-opacity='${r2(dimmed)}'${spin}>${escapeXml(arts[place.art].content)}</text>`
          : `<use href='#ps-watermark${place.art || ''}' x='${r2(px - fs / 2)}' y='${r2(py - fs / 2)}' ` +
          `width='${r2(fs)}' height='${r2(fs)}' opacity='${r2(dimmed)}'${spin}/>`,
        );
      }
    }
  }

  // Presentation attributes every copy would otherwise repeat.
  const anyText = arts.some(a => a.kind === 'watermark');
  const shared = (anyText
    ? ` text-anchor='middle' dominant-baseline='central' font-family='sans-serif'`
    : '')
    + (color ? ` fill='${color}'${arts.some(a => a.kind === 'svg') ? ` color='${color}'` : ''}` : '');
  const symbols = arts
    .map((a, i) => (a.kind === 'svg'
      ? `<symbol id='ps-watermark${i || ''}' viewBox='${escapeXml(a.viewBox ?? '0 0 24 24')}'`
      + `${!color && a.fill ? ` fill='${escapeXml(a.fill)}'` : ''}>${bodies[i]}</symbol>`
      : ''))
    .join('');
  const defs = symbols ? `<defs>${symbols}</defs>` : '';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${T}' height='${T}'${shared}>${defs}${nodes.join('')}</svg>`;
  return { uri: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, spots };
}
