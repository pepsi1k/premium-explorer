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
import { HEX_RE, hashString, normalizePath } from './colors';

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
	pill: LayerStyle;
	pillColor?: string;
	pillOpacity: number;
	pillRadius: number;
	textStyle: TextStyle;
	textColor?: string;
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
const WATERMARK_DIM_STYLES: readonly string[] = ['smart', 'text', 'radius'];

function parseDimStyle(raw: unknown): WatermarkDimStyle | undefined {
	return typeof raw === 'string' && WATERMARK_DIM_STYLES.includes(raw) ? raw as WatermarkDimStyle : undefined;
}

/** Global default parts, mirroring the defaults contributed in package.json. */
const ROOT_DEFAULTS: PartConfig = {
	backgroundStyle: 'solid', backgroundOpacity: 0.5,
	edge: 'none', edgeOpacity: 1, edgeColors: [], edgeWidth: 3, edgeStripeSize: 6,
	pill: 'none', pillOpacity: 1, pillRadius: 6,
	textStyle: 'none',
	watermarkStyle: 'none', watermarkContrast: 0.15, watermarkDim: 0.7, watermarkDimStyle: 'smart', watermarkDimWidth: 260, watermarkDimHeight: 560, watermarkOpacity: 0.3, watermarkSize: 24, watermarkCanvas: 512, watermarkDensity: 4, watermarkVariation: 0.4, watermarkRotation: 40,
};
const INNER_DEFAULTS: PartConfig = {
	backgroundStyle: 'inherit', backgroundOpacity: 0.15,
	edge: 'inherit', edgeOpacity: 1, edgeColors: [], edgeWidth: 3, edgeStripeSize: 6,
	pill: 'inherit', pillOpacity: 1, pillRadius: 6,
	textStyle: 'none',
	watermarkStyle: 'inherit', watermarkContrast: 0.15, watermarkDim: 0.7, watermarkDimStyle: 'smart', watermarkDimWidth: 260, watermarkDimHeight: 560, watermarkOpacity: 0.3, watermarkSize: 24, watermarkCanvas: 512, watermarkDensity: 4, watermarkVariation: 0.4, watermarkRotation: 40,
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
	 */
	backgroundWatermarkSymbol?: string;
	/** Per-rule layer overrides for the root row / inner rows (merged over the globals). */
	root?: Partial<PartConfig>;
	inner?: Partial<PartConfig>;
}

export interface SelectionConfig {
	/** `"shift"` (the row's own color, lifted), `"invert"` (the folder's color), or a hex. */
	background: string;
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
}

/**
 * A style the selection color may take over rather than leave alone. The edge bar
 * is deliberately not one of them: it is the row's narrowest mark and the only one
 * that still says which folder a selected — or renaming — row belongs to, so it
 * always keeps its own colours.
 */
export type SelectedOverride = 'background' | 'watermarks' | 'text-color' | 'pills';
const SELECTED_OVERRIDES: readonly string[] = ['background', 'watermarks', 'text-color', 'pills'];

/** All settings, resolved into ready-to-use values. */
export interface FolderColorerConfig {
	enabled: boolean;
	colorBy: 'name' | 'path';
	badge?: string;
	palette: string[];
	defaultColor: string;
	/** How many colours an auto-derived edge sequence uses (1 = a plain solid bar). */
	edgeColorCount: number;
	/**
	 * Default artwork for the watermark: a built-in glyph name, a character/emoji,
	 * or a path to an `.svg` file. Empty = each folder uses the first letter of
	 * its own name.
	 */
	backgroundWatermarkSymbol: string;
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
		backgroundOpacity: numberOrUndefined(get(`${prefix}BackgroundOpacity`)) ?? defaults.backgroundOpacity,
		edge: parseLayerStyle(get(`${prefix}Edge`)) ?? defaults.edge,
		edgeColor: hexOrUndefined(get(`${prefix}EdgeColor`)),
		edgeOpacity: numberOrUndefined(get(`${prefix}EdgeOpacity`)) ?? defaults.edgeOpacity,
		edgeColors: hexArray(get(`${prefix}EdgeColors`)),
		edgeWidth: numberOrUndefined(get(`${prefix}EdgeWidth`)) ?? defaults.edgeWidth,
		edgeStripeSize: numberOrUndefined(get(`${prefix}EdgeStripeSize`)) ?? defaults.edgeStripeSize,
		pill: parseLayerStyle(get(`${prefix}Pill`)) ?? defaults.pill,
		pillColor: hexOrUndefined(get(`${prefix}PillColor`)),
		pillOpacity: numberOrUndefined(get(`${prefix}PillOpacity`)) ?? defaults.pillOpacity,
		pillRadius: numberOrUndefined(get(`${prefix}PillRadius`)) ?? defaults.pillRadius,
		textStyle: parseTextStyle(get(`${prefix}TextStyle`)) ?? defaults.textStyle,
		textColor: hexOrUndefined(get(`${prefix}TextColor`)),
		watermarkStyle: parseLayerStyle(get(`${prefix}WatermarkStyle`)) ?? defaults.watermarkStyle,
		watermarkColor: watermarkColorOrUndefined(get(`${prefix}WatermarkColor`)),
		watermarkContrast: numberOrUndefined(get(`${prefix}WatermarkContrast`)) ?? defaults.watermarkContrast,
		watermarkDim: numberOrUndefined(get(`${prefix}WatermarkDim`)) ?? defaults.watermarkDim,
		watermarkDimStyle: parseDimStyle(get(`${prefix}WatermarkDimStyle`)) ?? defaults.watermarkDimStyle,
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
	const pillOpacity = numberOrUndefined(entry[`${prefix}PillOpacity`]);
	if (pillOpacity !== undefined) { o.pillOpacity = pillOpacity; }
	const pillRadius = numberOrUndefined(entry[`${prefix}PillRadius`]);
	if (pillRadius !== undefined) { o.pillRadius = pillRadius; }
	const textStyle = parseTextStyle(entry[`${prefix}TextStyle`]);
	if (textStyle) { o.textStyle = textStyle; }
	const textColor = hexOrUndefined(entry[`${prefix}TextColor`]);
	if (textColor) { o.textColor = textColor; }
	return Object.keys(o).length ? o : undefined;
}

/** Read and resolve all `premiumExplorer.*` settings. */
export function readConfig(): FolderColorerConfig {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const get = (key: string): unknown => cfg.get(key);

	const defaultColor = cfg.get<string>('defaultColor', '#808080');
	const badge = cfg.get<string>('badge', '').trim().slice(0, 2);

	return {
		enabled: cfg.get<boolean>('enabled', true),
		colorBy: cfg.get<'name' | 'path'>('colorBy', 'name'),
		badge: badge || undefined,
		palette: resolvePalette(cfg),
		defaultColor,
		edgeColorCount: cfg.get<number>('edgeColorCount', 3),
		// `backgroundWatermark` is the pre-1.3 name, still read so an existing config
		// keeps its artwork; the new key wins wherever both are set.
		backgroundWatermarkSymbol: readWatermarkSource(
			cfg.get<string>('backgroundWatermarkSymbol', '') || cfg.get<string>('backgroundWatermark', ''),
		) ?? '',
		root: readPart(get, 'root', ROOT_DEFAULTS),
		inner: readPart(get, 'inner', INNER_DEFAULTS),
		selection: {
			background: cfg.get<string>('selectedBackgroundColor', 'invert'),
			shift: cfg.get<number>('selectedShift', 0.12),
			text: cfg.get<string>('selectedTextColor', 'auto'),
			opacity: cfg.get<number>('selectedOpacity', 1),
			bold: cfg.get<boolean>('selectedBold', true),
			border: cfg.get<string>('selectedBorder', 'auto'),
			inactiveDarken: cfg.get<number>('selectedInactiveDarken', 0.25),
			overrides: parseOverrides(cfg.get<string[]>('selectedOverrides', [])),
			watermark: cfg.get<string>('selectedWatermarkColor', 'auto'),
			watermarkContrast: cfg.get<number>('selectedWatermarkContrast', 0.08),
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
		const watermark = readWatermarkSource(entry.backgroundWatermarkSymbol ?? entry.backgroundWatermark);

		for (const absPath of resolveRulePaths(entry.path, folders)) {
			resolved.push({ absPath, engine, backgroundWatermarkSymbol: watermark, root, inner });
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
