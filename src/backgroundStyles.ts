/**
 * Generates the CSS + JS files consumed by the `be5invis.vscode-custom-css`
 * extension to paint Explorer **backgrounds** — something the VS Code API cannot
 * do. The JS (media/inject.js) walks the Explorer DOM and paints each colored
 * folder plus everything inside it; this module resolves the rules into the set
 * of colored folders and bakes their composable layers (background/edge/pill/text)
 * plus selection options into that script. See README.md for the full rationale.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WatermarkArt, HEX_RE, contrastColor, paletteSequence, parseSvgMarkup } from './colors';
import { ColoredFolder, Part, buildPart } from './layers';
import { LayerStyle, NO_ANCESTOR_FALLBACK, PartConfig, FolderColorerConfig, ResolvedRule, deepestRuleFor, gitRepoColorHex, isSvgSource, WATERMARK_COLOR_ORIGINAL } from './config';
import { findRepositories } from './repositoryScanner';

const CSS_FILE = 'premium-explorer.css';
const JS_FILE = 'premium-explorer.js';
/** Generated pairs we own, including the one shipped under the extension's old name. */
const OURS = [CSS_FILE, JS_FILE, 'premium-stash.css', 'premium-stash.js'];
const CUSTOM_CSS_IMPORTS = 'vscode_custom_css.imports';

// The injected file is a single global file shared by every window, but rules are
// per-workspace. We persist a union of each workspace's colored folders (keyed by
// workspace-folder name) so opening another workspace doesn't inherit these colors
// and both windows can be colored at once. See media/inject.js for the paint side.
const WORKSPACE_COLORS_STATE = 'premiumExplorer.workspaceColors';

/** Persisted union: workspace-folder name (lowercased) -> { folder name -> per-state colors }. */
type WorkspaceColors = Record<string, Record<string, FolderColors>>;

/** The root row and inner rows of one colored folder, baked into the injected script. */
interface FolderColors {
	root: Part;
	inner: Part;
}

interface GeneratedFiles {
	cssUri: vscode.Uri;
	jsUri: vscode.Uri;
	count: number;
}

/**
 * Write the CSS + JS files. Always writes (empty when the rules match nothing, so
 * removing rules clears the backgrounds on reload); `count` is how many folders
 * are colored.
 */
export async function writeBackgroundFiles(
	context: vscode.ExtensionContext,
	config: FolderColorerConfig,
): Promise<GeneratedFiles> {
	// When disabled, write inert files. vscode-custom-css loads these files
	// independently of the extension, so `premiumExplorer.enabled` has to clear them
	// here — otherwise the last-generated backgrounds/selection keep painting.
	if (!config.enabled) {
		return writeFiles(context,
			'/* premium-explorer disabled (premiumExplorer.enabled = false). */\n',
			'// premium-explorer disabled (premiumExplorer.enabled = false).\n',
			0,
		);
	}

	// Resolve this window's colored folders (each already expanded into its baked
	// layers) and attribute each to the workspace folder that owns it, then merge
	// into the persisted cross-workspace union so other workspaces' colors survive
	// (and this workspace's stale ones are cleared).
	const coloredFolders = await resolveColoredFolders(config);
	const thisWindow = groupByWorkspace(coloredFolders, bakeAll(coloredFolders));
	const workspaces = mergeWorkspaceColors(context, thisWindow);

	const staticSelectedText = resolveStaticSelectedText(config);
	const css = buildCss(config, staticSelectedText);
	const js = await buildInjectedScript(context, {
		workspaces,
		selection: {
			bg: config.selection.background,
			shift: config.selection.shift,
			text: config.selection.text,
			opacity: config.selection.opacity,
			border: config.selection.border,
			inactiveDarken: config.selection.inactiveDarken,
			overrides: config.selection.overrides,
			watermark: config.selection.watermark,
			watermarkContrast: config.selection.watermarkContrast,
		},
		// When CSS can statically own the selected text color, the JS leaves text
		// alone; otherwise the JS tints the filename per row.
		paintText: staticSelectedText === null && config.selection.overrides.includes('text-color'),
	});

	// `count` is what this workspace matched (drives the "no folders" warning).
	const count = Object.values(thisWindow).reduce((n, m) => n + Object.keys(m).length, 0);
	return writeFiles(context, css, js, count);
}


/** Lowercased workspace-folder name used as the union key (and matched in the DOM). */
function workspaceKey(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Attribute each colored folder to the workspace folder that contains it, keyed by
 * that folder's (lowercased) name. Folders outside every workspace folder — e.g. an
 * absolute rule pointing elsewhere — are dropped (they can't appear in this tree).
 */
function groupByWorkspace(colored: ColoredFolder[], baked: Map<string, FolderColors>): WorkspaceColors {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const grouped: WorkspaceColors = {};
	// Ensure every current root has an entry, so a workspace whose rules now match
	// nothing overwrites its stale union entry with an empty map (clearing it).
	for (const folder of folders) {
		grouped[workspaceKey(folder.name)] = {};
	}
	for (const folder of colored) {
		const owner = folders.find(f => isWithin(f.uri.fsPath, folder.absPath));
		const colors = baked.get(folder.absPath);
		if (owner && colors) {
			grouped[workspaceKey(owner.name)][folder.name] = colors;
		}
	}
	return grouped;
}

function isWithin(ancestor: string, target: string): boolean {
	return target === ancestor || target.startsWith(ancestor + path.sep);
}

/**
 * Merge this window's per-workspace colors into the persisted union: replace the
 * entries for the current workspace's roots (so removed rules clear), keep the rest
 * (so other open/closed workspaces stay colored). Persists the result.
 */
function mergeWorkspaceColors(
	context: vscode.ExtensionContext,
	thisWindow: WorkspaceColors,
): WorkspaceColors {
	const stored = context.globalState.get<WorkspaceColors>(WORKSPACE_COLORS_STATE) ?? {};
	const union: WorkspaceColors = { ...stored, ...thisWindow };
	void context.globalState.update(WORKSPACE_COLORS_STATE, union);
	return union;
}

/** Write the CSS + JS into global storage and return their URIs. */
async function writeFiles(
	context: vscode.ExtensionContext,
	css: string,
	js: string,
	count: number,
): Promise<GeneratedFiles> {
	await vscode.workspace.fs.createDirectory(context.globalStorageUri);
	const cssUri = vscode.Uri.joinPath(context.globalStorageUri, CSS_FILE);
	const jsUri = vscode.Uri.joinPath(context.globalStorageUri, JS_FILE);
	await vscode.workspace.fs.writeFile(cssUri, Buffer.from(css, 'utf8'));
	await vscode.workspace.fs.writeFile(jsUri, Buffer.from(js, 'utf8'));
	return { cssUri, jsUri, count };
}

/**
 * Resolve the rules into the list of colored folders (name, base hex, source path,
 * and the merged root/inner layer configs). The injected script matches rows by
 * name, so two folders with the same name inside one workspace share a color.
 */
async function resolveColoredFolders(config: FolderColorerConfig): Promise<ColoredFolder[]> {
	const byName = new Map<string, ColoredFolder>();

	// Git repos discovered under `git` rules, unless a deeper (manual) rule governs
	// them — in that case the manual folder below covers the region instead.
	for (const rule of config.rules) {
		if (rule.engine !== 'git') {
			continue;
		}
		for (const repo of await findRepositories(vscode.Uri.file(rule.absPath))) {
			if (deepestRuleFor(config, repo)?.engine !== 'git') {
				continue; // masked by a more specific manual rule
			}
			const name = path.basename(repo.fsPath);
			if (!byName.has(name)) {
				const hex = gitRepoColorHex(config, repo);
				byName.set(name, {
					name, hex, absPath: repo.fsPath,
					...identityOf(config, name, repo.fsPath, hex, rule.backgroundWatermark),
					...mergedParts(rule, config),
				});
			}
		}
	}

	// Manual folders take precedence over a git repo that shares their name. Their
	// base color is `premiumExplorer.defaultColor` — the fallback each layer uses when
	// its own `*Color` is empty. Set those per layer to color a folder deliberately.
	for (const rule of config.rules) {
		if (rule.engine !== 'git') {
			const name = path.basename(rule.absPath);
			byName.set(name, {
				name, hex: config.defaultColor, absPath: rule.absPath,
				...identityOf(config, name, rule.absPath, config.defaultColor, rule.backgroundWatermark),
				...mergedParts(rule, config),
			});
		}
	}

	return [...byName.values()];
}

/**
 * A folder's identity extras: the unique colour sequence driving its striped edge
 * (first entry is the colour it already had, so nothing on screen shifts) and the
 * artwork for its watermark — the rule's `backgroundWatermark`, else the name's initial.
 */
function identityOf(config: FolderColorerConfig, name: string, absPath: string, hex: string, watermark?: string): Pick<ColoredFolder, 'sequence' | 'art'> {
	const basis = config.colorBy === 'path' ? absPath : name;
	const source = watermark || config.backgroundWatermark || (Array.from(name)[0] ?? '').toUpperCase();
	return {
		sequence: paletteSequence(basis, config.palette, config.edgeColorCount, hex),
		art: resolveWatermarkArt(source, absPath),
	};
}

/**
 * Turn a `backgroundWatermark` value into drawable artwork.
 *
 * A plain character is drawn as text. An SVG source — a path to an `.svg` file,
 * inline markup, or a data URI — is loaded and reduced to its inner markup, which
 * the pattern stamps once into `<defs>` and reuses for every copy. A path that
 * can't be read falls back to the folder's initial rather than painting nothing.
 */
function resolveWatermarkArt(source: string, absPath: string): WatermarkArt {
	const initial = (Array.from(path.basename(absPath))[0] ?? '?').toUpperCase();
	if (!isSvgSource(source)) {
		return { kind: 'watermark', content: source, key: source };
	}
	let markup = source;
	if (!source.startsWith('<svg')) {
		markup = source.startsWith('data:image/svg+xml')
			? decodeSvgDataUri(source)
			: readSvgFile(source, absPath);
	}
	const parsed = markup ? parseSvgMarkup(markup) : undefined;
	if (!parsed) {
		console.warn(`premium-explorer: could not load backgroundWatermark "${source}"`);
		return { kind: 'watermark', content: initial, key: initial };
	}
	// Seed off the source, not the markup, so the scatter survives edits to the file.
	return { kind: 'svg', content: parsed.body, viewBox: parsed.viewBox, key: source };
}

/** Read an `.svg` file: absolute, `~`-relative, or relative to the folder it decorates. */
function readSvgFile(source: string, absPath: string): string {
	const expanded = source.startsWith('~/') ? path.join(os.homedir(), source.slice(2)) : source;
	const candidates = path.isAbsolute(expanded)
		? [expanded]
		: [
			path.resolve(absPath, expanded),
			...(vscode.workspace.workspaceFolders ?? []).map(f => path.resolve(f.uri.fsPath, expanded)),
		];
	for (const file of candidates) {
		try {
			return fs.readFileSync(file, 'utf8');
		} catch {
			// Try the next candidate root.
		}
	}
	return '';
}

/** Decode a `data:image/svg+xml` URI, whether percent-encoded or base64. */
function decodeSvgDataUri(uri: string): string {
	const comma = uri.indexOf(',');
	if (comma < 0) {
		return '';
	}
	const payload = uri.slice(comma + 1);
	try {
		return uri.slice(0, comma).includes(';base64')
			? Buffer.from(payload, 'base64').toString('utf8')
			: decodeURIComponent(payload);
	} catch {
		return '';
	}
}

/** Merge a rule's per-layer overrides over the global root/inner defaults. */
function mergedParts(rule: ResolvedRule, config: FolderColorerConfig): { root: PartConfig; inner: PartConfig } {
	return {
		root: { ...config.root, ...rule.root },
		inner: { ...config.inner, ...rule.inner },
	};
}

/**
 * Bake every folder, keyed by absolute path. Shallowest paths first, so an
 * enclosing folder is always baked before the folders nested inside it and an
 * `inherit` layer can simply read the ancestor's finished colors.
 */
function bakeAll(colored: ColoredFolder[]): Map<string, FolderColors> {
	const ordered = [...colored].sort((a, b) => a.absPath.length - b.absPath.length);
	const baked = new Map<string, FolderColors>();
	for (const folder of ordered) {
		// Nearest enclosing colored folder = the longest ancestor path.
		let nearest: ColoredFolder | undefined;
		for (const other of ordered) {
			if (other.absPath === folder.absPath || !isWithin(other.absPath, folder.absPath)) {
				continue;
			}
			if (!nearest || other.absPath.length > nearest.absPath.length) {
				nearest = other;
			}
		}
		// Nested rules inherit from what the parent paints on its *contents*.
		const inheritFrom = nearest ? baked.get(nearest.absPath)?.inner : undefined;
		baked.set(folder.absPath, {
			root: buildPart(folder, folder.root, inheritFrom),
			inner: buildPart(folder, folder.inner, inheritFrom),
		});
	}
	return baked;
}

/**
 * The selected text color as a static hex, when known up front (a fixed text hex,
 * or `"auto"` over a fixed background hex). Null for the per-folder `"invert"` +
 * `"auto"` case, which the JS resolves per row.
 */
function resolveStaticSelectedText(config: FolderColorerConfig): string | null {
	const { background, text, overrides } = config.selection;
	// Nothing to emit when the selection doesn't take the label color over — the
	// row keeps whatever its own `*TextColor` set.
	if (!overrides.includes('text-color')) {
		return null;
	}
	if (HEX_RE.test(text)) {
		return text;
	}
	if (text === 'auto' && HEX_RE.test(background)) {
		return contrastColor(background);
	}
	return null;
}

/**
 * The only CSS we emit: styling for the selected/focused row's label + twistie.
 * It's non-destructive (reverts on deselect) and, with `!important`, overrides
 * the inline decoration colors so badges stay readable on a bright selection.
 */
function buildCss(config: FolderColorerConfig, staticSelectedText: string | null): string {
	const header =
		'/* Auto-generated by premium-explorer for be5invis.vscode-custom-css. */\n' +
		'/* Backgrounds, hover and selection are painted by premium-explorer.js. */\n';

	// The inline rename box. VS Code paints it with the theme's own input colors, so on
	// a colored row it lands as a foreign slab with the row's fill left showing as a
	// stub in the indent gutter. Instead the row itself shifts a step off its usual
	// color while it is being edited (see `EDIT_SHIFT` in the script) and the box gets
	// out of the way entirely — transparent, so the shifted fill and the watermark over
	// it carry straight through, with a border to mark where the typing goes. The
	// script publishes that border and a foreground that reads against the shifted
	// color; the fallbacks leave rows we don't paint with the theme's own input look.
	//
	// This has to be applied from here rather than inline, because
	// `InputBox.applyStyles()` rewrites its own inline colors on every validation pass
	// and would win against a script that set them directly — `!important` from a
	// stylesheet outranks any inline declaration. `caret-color` follows `color`, so the
	// caret is lit by the same rule.
	const editRow = 'body.fc-active .explorer-folders-view .monaco-list-row.fc-editing';
	const editCss =
		'\n/* Inline rename box: the row itself shifts, the box just marks the field. */\n' +
		`${editRow} .monaco-inputbox {\n` +
		'\tbackground-color: transparent !important;\n' +
		'\tborder-color: transparent !important;\n' +
		'\tcolor: var(--fc-edit-fg, var(--vscode-input-foreground)) !important;\n' +
		'}\n' +
		`${editRow} .monaco-inputbox input {\n` +
		'\tbackground-color: var(--fc-edit-field, var(--vscode-input-background)) !important;\n' +
		'\tcolor: var(--fc-edit-fg, var(--vscode-input-foreground)) !important;\n' +
		'\toutline: 1px solid var(--fc-edit-border, var(--vscode-focusBorder)) !important;\n' +
		'\toutline-offset: -1px !important;\n' +
		'\tborder-radius: 3px;\n' +
		'}\n';

	const declarations: string[] = [];
	if (config.selection.bold) {
		declarations.push('\tfont-weight: bold !important;');
	}
	if (staticSelectedText) {
		declarations.push(`\tcolor: ${staticSelectedText} !important;`);
	}
	if (declarations.length === 0) {
		return header + editCss;
	}

	// `body.fc-active` is set by the injected script only in a window whose workspace
	// is configured, so this selected-label styling doesn't apply in other workspaces.
	// Match only `.selected` (not a stale `.focused` row), and color the whole row
	// contents — not just `.monaco-icon-label` — so a decoration badge stays this
	// color. `.monaco-tl-twistie` (the expand/collapse chevron) is listed too.
	// `.fc-editing` is set by the injected script on a row showing the inline rename
	// box. Its `<input>` is inside `.monaco-tl-contents`, so an `!important` color
	// here would apply to the text being typed — and to the caret, which follows
	// `color` — leaving the rename invisible. Stand down for those rows.
	const row = 'body.fc-active .explorer-folders-view .monaco-list-row.selected:not(.fc-editing)';
	const selectors = [
		`${row} .monaco-tl-contents`,
		`${row} .monaco-tl-contents *`,
		`${row} .monaco-tl-twistie`,
	].join(',\n');

	return header + editCss +
		'\n/* Selected-row label + twistie. */\n' +
		selectors + ' {\n' + declarations.join('\n') + '\n}\n';
}

/** Config baked into the injected script as `globalThis.__premiumExplorerConfig`. */
interface InjectedConfig {
	/** Workspace-folder name (lowercased) -> folder name -> per-state colors. */
	workspaces: Record<string, Record<string, FolderColors>>;
	selection: {
		bg: string; shift: number; text: string; opacity: number; border: string;
		inactiveDarken: number; overrides: string[]; watermark: string; watermarkContrast: number;
	};
	paintText: boolean;
}

/** Prepend the baked config to the static browser script (media/inject.js). */
async function buildInjectedScript(
	context: vscode.ExtensionContext,
	injected: InjectedConfig,
): Promise<string> {
	const templateUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'inject.js');
	const template = Buffer.from(await vscode.workspace.fs.readFile(templateUri)).toString('utf8');
	return (
		'// Auto-generated by premium-explorer. Do not edit — regenerated from settings.\n' +
		`globalThis.__premiumExplorerConfig = ${JSON.stringify(injected)};\n\n` +
		template
	);
}

/**
 * Point the vscode-custom-css imports list at our current generated files.
 *
 * Any import of ours already in the list is dropped first, so a pair left behind
 * at a path we no longer write to — global storage is keyed on the extension id,
 * so renaming the extension moves it — can't be inlined alongside the live pair
 * and leave two painters fighting over the same rows. Everything the user wired
 * up themselves is left exactly where it is.
 */
export async function addCustomCssImports(urls: string[]): Promise<void> {
	const cfg = vscode.workspace.getConfiguration();
	const current = cfg.get<string[]>(CUSTOM_CSS_IMPORTS) ?? [];
	const next = current.filter((url) => !OURS.some((file) => url.endsWith('/' + file))).concat(urls);
	const same = next.length === current.length && next.every((url, i) => url === current[i]);
	if (!same) {
		await cfg.update(CUSTOM_CSS_IMPORTS, next, vscode.ConfigurationTarget.Global);
	}
}

/** `premium-explorer.generateBackgroundCss` command: write files + wire up imports. */
export async function generateBackgroundCss(
	context: vscode.ExtensionContext,
	config: FolderColorerConfig,
): Promise<void> {
	const result = await writeBackgroundFiles(context, config);
	// vscode-custom-css can only read `file://` URLs. globalStorageUri's scheme is
	// `vscode-userdata`, so convert via fsPath instead of using cssUri.toString().
	await addCustomCssImports([
		vscode.Uri.file(result.cssUri.fsPath).toString(),
		vscode.Uri.file(result.jsUri.fsPath).toString(),
	]);
	if (result.count === 0) {
		vscode.window.showWarningMessage(
			'Premium Explorer: your rules matched no folders. Add a rule to "premiumExplorer.rules", e.g. { "path": ".", "engine": "git" }.',
		);
		return;
	}
	vscode.window.showInformationMessage(
		`Premium Explorer: configured vscode-custom-css for ${result.count} folder(s). ` +
		'Run "Reload Custom CSS and JS" and restart to apply.',
	);
}

/**
 * Once the files exist, keep them current when settings change so tweaks to
 * rules/palette/opacity/selection apply on the next window reload — no command
 * needed.
 */
export async function regenerateIfConfigured(
	context: vscode.ExtensionContext,
	config: FolderColorerConfig,
): Promise<void> {
	const cssUri = vscode.Uri.joinPath(context.globalStorageUri, CSS_FILE);
	try {
		await vscode.workspace.fs.stat(cssUri);
	} catch {
		return; // not set up yet — nothing to keep in sync
	}
	await writeBackgroundFiles(context, config);
	const choice = await vscode.window.showInformationMessage(
		'Premium Explorer: background styles updated. Reload to apply.',
		'Reload Window',
	);
	if (choice === 'Reload Window') {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}
