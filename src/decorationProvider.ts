import * as vscode from 'vscode';
import * as path from 'path';
import { FolderColorerConfig, deepestRuleFor } from './config';
import { normalizePath } from './colors';

/**
 * Adds the optional {@link FolderColorerConfig.badge} to colored folder **roots**
 * via VS Code's `FileDecorationProvider`. All visual coloring (background, edge,
 * pill, text) is painted by the generated CSS/JS instead (see backgroundStyles.ts);
 * the decoration API can only add a label badge/tooltip, so that's all this does.
 * When no badge is configured the provider is inert.
 */
export class FolderColorerProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly _onDidChange =
		new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChange.event;

	/** Caches whether a directory is a repo root (has a `.git` entry). */
	private readonly repoRootCache = new Map<string, boolean>();

	constructor(private config: FolderColorerConfig) {}

	setConfig(config: FolderColorerConfig): void {
		this.config = config;
	}

	async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
		// Nothing to decorate without a badge — coloring is done by the injected CSS/JS.
		if (uri.scheme !== 'file' || !this.config.enabled || !this.config.badge) {
			return undefined;
		}
		const rule = deepestRuleFor(this.config, uri);
		if (!rule) {
			return undefined;
		}
		if (rule.engine === 'git') {
			const repoRoot = await this.findRepoRootWithin(uri, rule.absPath);
			if (!repoRoot || repoRoot.toString() !== uri.toString()) {
				return undefined; // badge the repo root only
			}
			return { badge: this.config.badge, tooltip: 'Contains a Git repository' };
		}
		// manual / default: badge the rule's folder itself.
		if (normalizePath(uri.fsPath) !== rule.absPath) {
			return undefined;
		}
		return { badge: this.config.badge, tooltip: `Premium Explorer: ${rule.engine} color` };
	}

	/** Nearest ancestor (including `uri`) that is a repo root, without leaving `boundaryAbs`. */
	private async findRepoRootWithin(uri: vscode.Uri, boundaryAbs: string): Promise<vscode.Uri | undefined> {
		let current = uri;
		while (true) {
			const currentAbs = normalizePath(current.fsPath);
			if (currentAbs !== boundaryAbs && !currentAbs.startsWith(boundaryAbs + path.sep)) {
				return undefined; // walked above the rule's path
			}
			if (await this.isRepoRoot(current)) {
				return current;
			}
			if (currentAbs === boundaryAbs) {
				return undefined;
			}
			const parent = vscode.Uri.joinPath(current, '..');
			if (parent.fsPath === current.fsPath) {
				return undefined; // filesystem root
			}
			current = parent;
		}
	}

	private async isRepoRoot(uri: vscode.Uri): Promise<boolean> {
		const key = uri.toString();
		const cached = this.repoRootCache.get(key);
		if (cached !== undefined) {
			return cached;
		}

		// `.git` is a directory for normal repos and a file for worktrees/submodules;
		// stat succeeds for both. Statting a plain file's `.git` fails -> false.
		let isRepo = false;
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, '.git'));
			isRepo = true;
		} catch {
			isRepo = false;
		}
		this.repoRootCache.set(key, isRepo);
		return isRepo;
	}

	/** Drop cached repo-root results and re-query every decoration. */
	refreshAll(): void {
		this.repoRootCache.clear();
		this._onDidChange.fire(undefined);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
