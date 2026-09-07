/**
 * Entry point. Wires together:
 *   - the {@link FolderColorerProvider} that tints repo folder labels, and
 *   - the background-styles generator that (re)writes the vscode-custom-css files.
 *
 * The actual logic lives in the sibling modules; this file only handles activation
 * and event wiring.
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION, readConfig } from './config';
import { FolderColorerProvider } from './decorationProvider';
import { generateBackgroundCss, regenerateIfConfigured, regenerateIfStale } from './backgroundStyles';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	let config = readConfig();

	const provider = new FolderColorerProvider(config);
	context.subscriptions.push(
		provider,
		vscode.window.registerFileDecorationProvider(provider),
	);

	// Re-read settings, refresh decorations, and (if the custom-css files already
	// exist) regenerate them.
	const reload = async (regenerate: boolean): Promise<void> => {
		config = readConfig();
		provider.setConfig(config);
		provider.refreshAll();
		if (regenerate) {
			await regenerateIfConfigured(context, config);
		}
	};

	// A `.git` appearing/disappearing changes repo membership of a whole subtree.
	const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git');
	gitWatcher.onDidCreate(() => provider.refreshAll());
	gitWatcher.onDidDelete(() => provider.refreshAll());
	context.subscriptions.push(gitWatcher);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_SECTION)) {
				void reload(true);
			}
		}),
		// Relative rule paths resolve against the open folders, so re-read on change.
		vscode.workspace.onDidChangeWorkspaceFolders(() => void reload(true)),
	);

	// An update ships a new painter that nothing would otherwise install — the
	// generated files embed it verbatim and are only rewritten on a settings change.
	void regenerateIfStale(context, config);

	context.subscriptions.push(
		vscode.commands.registerCommand('premium-explorer.refresh', () => reload(false)),
		vscode.commands.registerCommand('premium-explorer.generateBackgroundCss', () =>
			generateBackgroundCss(context, config),
		),
	);
}

export function deactivate(): void {}
