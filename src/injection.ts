/**
 * The VS Code-facing half of painting the workbench ourselves: commands, prompts,
 * and healing the patch after a VS Code update. All the file surgery lives in
 * [workbenchPatch.ts](src/workbenchPatch.ts), which knows nothing about `vscode` —
 * this module is the only place that decides what the user is told.
 */
import * as vscode from 'vscode';
import { FolderColorerConfig } from './config';
import { addCustomCssImports, writeBackgroundFiles } from './backgroundStyles';
import { PatchError, apply, inspect, remove } from './workbenchPatch';

/** Set once the user opts in, so a patch lost to a VS Code update can be offered back. */
const INJECTION_STATE = 'premiumExplorer.injectionEnabled';

/** Generate the pair, then patch this VS Code install to load it. */
export async function enableInjection(
  context: vscode.ExtensionContext,
  config: FolderColorerConfig,
): Promise<void> {
  const status = inspect();
  if (status.state === 'missing') {
    vscode.window.showErrorMessage(
      'Premium Explorer: no workbench found to patch. Backgrounds need the desktop app, ' +
      'with the extension running on the same machine — not a browser, and not the remote ' +
      'side of an SSH/WSL/container window. Folder badges and label colors still work.',
    );
    return;
  }

  const files = await writeBackgroundFiles(context, config);
  const version = String(context.extension?.packageJSON?.version ?? '0');
  try {
    apply(status.workbench, version, { css: files.cssUri.fsPath, js: files.jsUri.fsPath });
  } catch (e) {
    await reportPatchFailure(e);
    return;
  }

  await context.globalState.update(INJECTION_STATE, true);
  // Both injectors loading the same script would paint every row twice, so drop
  // our entries from vscode-custom-css. Anything the user added themselves stays.
  await addCustomCssImports([]);

  if (status.customCss) {
    vscode.window.showWarningMessage(
      'Premium Explorer: vscode-custom-css has also patched this workbench. ' +
      'Premium Explorer no longer needs it — if nothing else depends on it, run ' +
      '"Reload Custom CSS and JS" after uninstalling it to clean up its patch.',
    );
  }
  if (files.count === 0) {
    vscode.window.showWarningMessage(
      'Premium Explorer: painting is enabled, but your rules matched no folders. ' +
      'Add a rule to "premiumExplorer.rules", e.g. { "path": ".", "engine": "git" }.',
    );
  }
  await offerReload(`Premium Explorer: painting ${files.count} folder(s). Reload to apply.`);
}

/** Put `workbench.html` back and remove the files we placed beside it. */
export async function disableInjection(context: vscode.ExtensionContext): Promise<void> {
  const status = inspect();
  await context.globalState.update(INJECTION_STATE, false);
  if (status.state === 'missing') {
    vscode.window.showInformationMessage('Premium Explorer: nothing to restore on this machine.');
    return;
  }
  try {
    remove(status.workbench);
  } catch (e) {
    await reportPatchFailure(e);
    return;
  }
  await offerReload('Premium Explorer: workbench restored. Reload to apply.');
}

/**
 * A VS Code update replaces the whole `out` directory, taking the patch and the
 * files beside it with it — backgrounds simply stop appearing, with nothing to
 * explain why. If the user had turned painting on, offer it back.
 *
 * Silent when no workbench is found: that is the ordinary state of a remote window,
 * where this extension host is not the machine holding the patch, and prompting
 * there would be wrong as well as annoying.
 */
export async function restoreInjectionIfLost(
  context: vscode.ExtensionContext,
  config: FolderColorerConfig,
): Promise<void> {
  if (!context.globalState.get<boolean>(INJECTION_STATE)) {
    return;
  }
  if (inspect().state !== 'unpatched') {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Premium Explorer: the VS Code update removed its background painting. Re-apply it?',
    'Re-apply',
    'Not now',
  );
  if (choice === 'Re-apply') {
    await enableInjection(context, config);
  }
}

/** Show why a patch step failed, and hand over the fix when it is a command. */
async function reportPatchFailure(e: unknown): Promise<void> {
  if (!(e instanceof PatchError)) {
    vscode.window.showErrorMessage(`Premium Explorer: ${(e as Error).message}`);
    return;
  }
  const command = e.hint.startsWith('Run: ') ? e.hint.slice('Run: '.length) : undefined;
  const choice = await vscode.window.showErrorMessage(
    `Premium Explorer: ${e.message}\n\n${e.hint}`,
    ...(command ? ['Copy Command'] : []),
  );
  if (choice === 'Copy Command' && command) {
    await vscode.env.clipboard.writeText(command);
  }
}

async function offerReload(message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, 'Reload Window');
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
