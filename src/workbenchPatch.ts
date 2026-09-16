/**
 * Loads the generated CSS/JS pair into the workbench ourselves, so the extension
 * paints backgrounds without `be5invis.vscode-custom-css` installed alongside it.
 *
 * There is no sanctioned way to do this. Extensions run in a separate extension
 * host process — on a remote workspace, a different machine entirely — and so have
 * no handle on the renderer's DOM; VS Code has repeatedly declined to add a CSS or
 * DOM injection API. The only door is editing what the renderer loads from disk,
 * which is what every extension in this space does, ours now included.
 *
 * Two deliberate differences from how vscode-custom-css does it:
 *
 * 1. **The CSP is left intact.** custom-css deletes the `Content-Security-Policy`
 *    meta tag outright, because `script-src` allows `'self'` but not
 *    `'unsafe-inline'` and it inlines the script. We instead write our pair into
 *    the workbench directory and reference it relatively — the same-origin form
 *    VS Code uses for `workbench.js` — so `'self'` already covers it. Nothing is
 *    weakened. (`media/inject.js` touches no `innerHTML`-style sink, so the CSP's
 *    `require-trusted-types-for 'script'` is satisfied as well.)
 *
 * 2. **The patch is constant.** Because the tags name fixed filenames instead of
 *    carrying the content, regenerating means rewriting two sibling files —
 *    `workbench.html` is not touched again and the patch never goes stale. A
 *    settings change applies on the next window reload with no second step.
 *
 * This module is pure Node — no `vscode` import, like colors.ts — so it can be
 * exercised directly. It reports problems by throwing {@link PatchError}; every
 * message and prompt belongs to the caller.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Written next to `workbench.html`; the injected tags reference these relatively. */
const CSS_FILE = 'premium-explorer.css';
const JS_FILE = 'premium-explorer.js';

/**
 * Pristine `workbench.html`, saved before the first patch so uninstalling restores
 * the file byte-for-byte rather than trusting our own region-stripping regex. A VS
 * Code update replaces the whole directory, taking this with it — which is correct:
 * the new `workbench.html` is its own pristine copy.
 */
const BACKUP_FILE = 'workbench.premium-explorer-backup.html';

const START = '<!-- premium-explorer:start -->';
const END = '<!-- premium-explorer:end -->';
/**
 * Our whole injected region, so re-patching replaces rather than stacks. It takes
 * the newline *after* the region and leaves the indentation before it, exactly
 * mirroring how {@link apply} inserts — which is what lets the no-backup path in
 * {@link remove} restore the file byte-for-byte.
 */
const REGION = /<!-- premium-explorer:start -->[\s\S]*?<!-- premium-explorer:end -->\n?/g;
/** The extension version that wrote the region currently in the file. */
const STAMP = /<!-- premium-explorer:generated-by ([^\s>]+) -->/;

/** The located workbench: the directory we write into, and the HTML we patch. */
export interface Workbench {
	dir: string;
	html: string;
}

/** Absolute paths of the generated pair in global storage, which we mirror. */
export interface Sources {
	css: string;
	js: string;
}

export type Status =
	/** No workbench HTML where one should be — a remote/web host, or an unknown layout. */
	| { state: 'missing' }
	| { state: 'unpatched'; workbench: Workbench; customCss: boolean }
	/** `version` is the extension version that applied the region that's in the file. */
	| { state: 'patched'; workbench: Workbench; version: string; customCss: boolean };

/** A patch step that failed, with something the user can actually act on. */
export class PatchError extends Error {
	constructor(message: string, readonly hint: string) {
		super(message);
		this.name = 'PatchError';
	}
}

/**
 * Find the workbench HTML belonging to the VS Code running this extension host.
 *
 * The filename and directory have both moved between versions and forks, so every
 * known spelling is tried. Returns undefined when none exists, which is the normal
 * answer on a remote host (the server install has no Electron workbench) and in the
 * browser — both cases where there is nothing on this machine to patch.
 */
export function locateWorkbench(): Workbench | undefined {
	const appDir = require.main?.filename
		? path.dirname(require.main.filename)
		: (globalThis as { _VSCODE_FILE_ROOT?: string })._VSCODE_FILE_ROOT;
	if (!appDir) {
		return undefined;
	}
	const base = path.join(appDir, 'vs', 'code');
	const dirs = [
		path.join(base, 'electron-browser', 'workbench'), // 1.102+
		path.join(base, 'electron-browser'),
		path.join(base, 'electron-sandbox', 'workbench'), // older
		path.join(base, 'electron-sandbox'),
	];
	// Dev and ESM builds first: where several exist, the more specific one is live.
	const names = [
		'workbench-dev.html',
		'workbench.esm.html',
		'workbench.html',
		'workbench-apc-extension.html', // Cursor
	];
	for (const dir of dirs) {
		for (const name of names) {
			const html = path.join(dir, name);
			if (fs.existsSync(html)) {
				return { dir, html };
			}
		}
	}
	return undefined;
}

/**
 * What state this machine's workbench is in. `customCss` reports whether
 * vscode-custom-css has also patched the file — both painting at once means two
 * copies of the script fighting over the same rows, so the caller should say so.
 */
export function inspect(): Status {
	const workbench = locateWorkbench();
	if (!workbench) {
		return { state: 'missing' };
	}
	let html: string;
	try {
		html = fs.readFileSync(workbench.html, 'utf8');
	} catch {
		return { state: 'missing' };
	}
	const customCss = html.includes('VSCODE-CUSTOM-CSS-START');
	if (!html.includes(START)) {
		return { state: 'unpatched', workbench, customCss };
	}
	return { state: 'patched', workbench, version: STAMP.exec(html)?.[1] ?? '', customCss };
}

/**
 * Patch `workbench.html` and copy the generated pair in beside it.
 *
 * Idempotent: an existing region of ours is replaced, so re-running after an
 * extension update refreshes the stamp without stacking a second copy.
 */
export function apply(workbench: Workbench, version: string, sources: Sources): void {
	const original = read(workbench.html);
	const clean = original.replace(REGION, '');

	// Back up the *cleaned* HTML — patching an already-patched file must not record
	// our own tags as the pristine state to restore later.
	const backup = path.join(workbench.dir, BACKUP_FILE);
	if (!fs.existsSync(backup)) {
		write(backup, clean, workbench.dir);
	}

	if (!clean.includes('</head>')) {
		throw new PatchError(
			`No </head> in ${path.basename(workbench.html)} — this VS Code build has a workbench layout Premium Explorer does not understand.`,
			'Please open an issue with your VS Code version; painting will not work until then.',
		);
	}

	// Into <head>, after the workbench's own stylesheet so ours cascades over it —
	// and so auxiliary windows, which clone the head, are painted too.
	const region = [
		START,
		`<!-- premium-explorer:generated-by ${version} -->`,
		`<link rel="stylesheet" href="./${CSS_FILE}">`,
		`<script src="./${JS_FILE}"></script>`,
		END,
	].join('\n');
	write(workbench.html, clean.replace('</head>', `${region}\n</head>`), workbench.dir);

	mirror(workbench, sources);
}

/**
 * Refresh the workbench's copy of the generated pair. This is the whole update path
 * for a settings change: the tags in the HTML name these files, so rewriting them
 * is enough and the patch itself is never revisited.
 */
export function mirror(workbench: Workbench, sources: Sources): void {
	copy(sources.css, path.join(workbench.dir, CSS_FILE), workbench.dir);
	copy(sources.js, path.join(workbench.dir, JS_FILE), workbench.dir);
}

/** Restore `workbench.html` and remove everything this module put in the directory. */
export function remove(workbench: Workbench): void {
	const backup = path.join(workbench.dir, BACKUP_FILE);
	if (fs.existsSync(backup)) {
		write(workbench.html, read(backup), workbench.dir);
	} else {
		// No backup (an update replaced it, or it was deleted); fall back to cutting
		// our own region out, which is what it contributed in the first place.
		write(workbench.html, read(workbench.html).replace(REGION, ''), workbench.dir);
	}
	for (const file of [BACKUP_FILE, CSS_FILE, JS_FILE]) {
		try {
			fs.unlinkSync(path.join(workbench.dir, file));
		} catch {
			// Already gone, which is the state we wanted.
		}
	}
}

function read(file: string): string {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (e) {
		throw new PatchError(`Could not read ${file}: ${(e as Error).message}`, permissionHint(path.dirname(file)));
	}
}

function write(file: string, content: string, dir: string): void {
	try {
		fs.writeFileSync(file, content, 'utf8');
	} catch (e) {
		throw new PatchError(`Could not write ${file}: ${(e as Error).message}`, permissionHint(dir));
	}
}

function copy(from: string, to: string, dir: string): void {
	try {
		fs.copyFileSync(from, to);
	} catch (e) {
		throw new PatchError(`Could not copy ${from} to ${to}: ${(e as Error).message}`, permissionHint(dir));
	}
}

/**
 * VS Code installs are owned by the system on every platform, so the first patch
 * fails until the user grants themselves write access. Tell them exactly how.
 */
function permissionHint(dir: string): string {
	if (process.platform === 'win32') {
		return 'Close VS Code and reopen it as Administrator, then run the command again.';
	}
	if (process.platform === 'darwin') {
		return `Run: sudo chown -R "$USER" "${dir}"  — note that modifying the app invalidates its code signature.`;
	}
	return `Run: sudo chown -R "$USER" "${dir}"`;
}
