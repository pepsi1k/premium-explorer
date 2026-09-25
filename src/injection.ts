/**
 * The VS Code-facing half of painting the workbench ourselves: commands, prompts,
 * and healing the patch after a VS Code update. All the file surgery lives in
 * [workbenchPatch.ts](src/workbenchPatch.ts), which knows nothing about `vscode` —
 * this module is the only place that decides what the user is told.
 */
import * as vscode from 'vscode';
import { FolderColorerConfig } from './config';
import { unwireCustomCssImports, writeBackgroundFiles } from './backgroundStyles';
import { PatchError, apply, checkAccess, inspect, permissionHint, remove } from './workbenchPatch';

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

  // Ask before attempting, not after failing. A system-wide install is the normal
  // shape on Linux and Windows, so the first run of this command usually lands on a
  // root-owned directory — and discovering that from the deepest write meant a raw
  // EACCES with an absolute path in it twice (issue #2).
  const access = checkAccess(status.workbench.dir);
  if (!access.writable) {
    await reportNoAccess(status.workbench.dir, access.reason);
    return;
  }

  const files = await writeBackgroundFiles(context, config);
  const version = String(context.extension?.packageJSON?.version ?? '0');
  try {
    apply(status.workbench, version, { css: files.cssUri.fsPath, js: files.jsUri.fsPath });
  } catch (e) {
    await reportPatchFailure(e, status.workbench.dir);
    return;
  }

  await context.globalState.update(INJECTION_STATE, true);
  // Migration: users who were on the old vscode-custom-css path still have our
  // files in its import list, and both injectors loading the same script would
  // paint every row twice. Anything the user added themselves stays.
  await unwireCustomCssImports();

  if (status.customCss) {
    vscode.window.showWarningMessage(
      'Premium Explorer: vscode-custom-css has also patched this workbench. ' +
      'Premium Explorer does not need it — if nothing else depends on it, run ' +
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
    await reportPatchFailure(e, status.workbench.dir);
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
  const status = inspect();
  if (status.state !== 'unpatched') {
    return;
  }
  // The update that removed the patch usually restored the install's own ownership
  // too, so the write access the user granted last time is gone with it. Say that
  // outright rather than offering a "Re-apply" that can only fail.
  const access = checkAccess(status.workbench.dir);
  if (!access.writable) {
    await reportNoAccess(status.workbench.dir, access.reason, true);
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

/** Where the install shapes and their fixes are written up. */
const DOCS_URL = 'https://github.com/pepsi1k/premium-explorer#system-owned-installs';

/**
 * Report an install we cannot write into, and say what the user has to do about it.
 *
 * Reporting is the whole of our part. Granting write access to a system-owned
 * directory needs privileges this process does not have, so the extension never
 * runs anything — it names the directory, states the situation, and behind
 * **Details** shows the command for the user to run themselves, outside VS Code.
 *
 * `lost` marks the call that follows a VS Code update, which is the one place the
 * user needs telling that this recurs: the update replaced the whole directory and
 * took their ownership of it along with the patch.
 */
async function reportNoAccess(
  dir: string,
  reason: 'permission' | 'readonly',
  lost = false,
): Promise<void> {
  if (reason === 'readonly') {
    // Snap and Flatpak mount the app from a read-only image, so there is no
    // permission to grant — the only fix is a different package.
    const choice = await vscode.window.showErrorMessage(
      'Premium Explorer: this VS Code is installed on a read-only image (Snap or Flatpak), ' +
      'so its workbench cannot be patched at all. Folder badges and label colors still ' +
      'work; background painting needs the .deb/.rpm or tarball build.',
      'Details',
    );
    if (choice === 'Details') {
      await showFix(dir, 'readonly');
    }
    return;
  }

  const lead = lost
    ? 'Premium Explorer: the VS Code update removed its background painting and restored ' +
      'the installation to system ownership, so it cannot be put back yet.'
    : 'Premium Explorer: background painting needs write access to this VS Code ' +
      'installation, and does not have it. Nothing has been changed.';
  const choice = await vscode.window.showWarningMessage(
    `${lead} ${permissionHint()} Give your user account write access to ${dir}, ` +
    'then run the command again.',
    'Details',
  );
  if (choice === 'Details') {
    await showFix(dir, 'permission');
  }
}

/**
 * Show why a patch step failed. The permission case is preflighted in
 * {@link enableInjection}, so what reaches here is the rarer kind — an unreadable
 * file, a layout we don't recognise, a directory that turned unwritable between
 * the check and the write. Each {@link PatchError} carries its own hint.
 */
async function reportPatchFailure(e: unknown, dir: string): Promise<void> {
  if (!(e instanceof PatchError)) {
    vscode.window.showErrorMessage(`Premium Explorer: ${(e as Error).message}`);
    return;
  }
  const choice = await vscode.window.showErrorMessage(
    `Premium Explorer: ${e.message} ${e.hint}`,
    'Details',
  );
  if (choice === 'Details') {
    await showFix(dir, 'permission');
  }
}

/**
 * What **Details** opens: the fix itself, in a modal that stays up until dismissed.
 * A notification closes the moment one of its buttons is clicked, so linking out
 * from it left nothing on screen to act on.
 *
 * The command is shown and can be copied, never run — granting access to a
 * system-owned directory is the user's to do, in their own terminal.
 */
async function showFix(dir: string, reason: 'permission' | 'readonly'): Promise<void> {
  const rerun = 'then run "Premium Explorer: Enable Background Painting" again.';
  let detail: string;
  let command: string | undefined;
  if (reason === 'readonly') {
    detail =
      'Snap and Flatpak mount VS Code from a read-only image, so no permission exists ' +
      'to grant. Background painting needs the .deb/.rpm package or the tarball build; ' +
      'after switching, ' + rerun;
  } else if (process.platform === 'win32') {
    detail =
      `Premium Explorer needs write access to:\n${dir}\n\n` +
      'Permanent fix: reinstall VS Code with the User Installer, which puts it under ' +
      '%LOCALAPPDATA% where your account already has access. One-off: start VS Code ' +
      'with "Run as administrator" once, and ' + rerun;
  } else {
    command = `sudo chown -R "$USER" "${dir}"`;
    detail =
      `Premium Explorer needs write access to:\n${dir}\n\n` +
      `Run this in a terminal:\n\n${command}\n\n` +
      `…${rerun}\n\n` +
      'Each VS Code update resets the ownership and removes the patch, so expect to ' +
      'repeat this after updating.';
  }
  const actions = command ? ['Copy Command', 'Open Docs'] : ['Open Docs'];
  const choice = await vscode.window.showInformationMessage(
    'How to enable background painting',
    { modal: true, detail },
    ...actions,
  );
  if (choice === 'Copy Command' && command) {
    await vscode.env.clipboard.writeText(command);
    vscode.window.showInformationMessage(
      `Premium Explorer: command copied. Run it in a terminal, ${rerun}`,
    );
  } else if (choice === 'Open Docs') {
    await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
  }
}

async function offerReload(message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, 'Reload Window');
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
