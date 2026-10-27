/**
 * Entry point. Wires together:
 *   - the {@link FolderColorerProvider} that tints repo folder labels,
 *   - the background-styles generator that (re)writes the injected CSS/JS pair, and
 *   - the workbench patch that loads that pair without a second extension.
 *
 * The actual logic lives in the sibling modules; this file only handles activation
 * and event wiring.
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION, readConfig } from './config';
import { FolderColorerProvider } from './decorationProvider';
import { regenerateIfConfigured, regenerateIfStale } from './backgroundStyles';
import { disableInjection, enableInjection, refreshInjectionIfStale, restoreInjectionIfLost } from './injection';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let config = readConfig();

  const provider = new FolderColorerProvider(config);
  context.subscriptions.push(
    provider,
    vscode.window.registerFileDecorationProvider(provider),
  );

  // Re-read settings, refresh decorations, and (if the generated files already
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
  //
  // Order matters. Re-stamping the workbench patch comes first, because that is
  // what makes a reload actually fetch the new painter instead of Chromium's
  // cached copy of the old one (EM-121); when it handles the update it also
  // regenerates and asks for the reload, so the plain regenerate would only add a
  // second prompt for the same thing. A VS Code update silently undoes the patch
  // altogether, which is a different case and is offered back separately.
  void (async () => {
    const restamped = await refreshInjectionIfStale(context, config);
    if (!restamped) {
      await regenerateIfStale(context, config);
    }
    await restoreInjectionIfLost(context, config);
  })();

  context.subscriptions.push(
    // Regenerate too: the painter's config is baked into the generated JS, so a
    // refresh that skips regeneration can never change what the Explorer paints.
    vscode.commands.registerCommand('premium-explorer.refresh', () => reload(true)),
    vscode.commands.registerCommand('premium-explorer.enableInjection', () =>
      enableInjection(context, config),
    ),
    vscode.commands.registerCommand('premium-explorer.disableInjection', () =>
      disableInjection(context),
    ),
  );
}

export function deactivate(): void {}
