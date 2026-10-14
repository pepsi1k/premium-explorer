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
