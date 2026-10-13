/**
 * Legacy cleanup for the pre-2.1.0 delivery path, where the generated pair could
 * be handed to the `be5invis.vscode-custom-css` extension instead of our own
 * workbench patch. Nothing writes imports any more; this only ever takes ours
 * back out of a list left over from that path.
 */
import * as vscode from 'vscode';

/**
 * Generated files we have ever delivered through vscode-custom-css, including the
 * pair shipped under the extension's old `premium-stash` name. Only filenames in
 * this list are ever removed; everything the user wired up themselves stays.
 */
const OURS = ['premium-explorer.css', 'premium-explorer.js', 'premium-stash.css', 'premium-stash.js'];

/**
 * Until 2.1.0 the pair could also be delivered by `be5invis.vscode-custom-css`,
 * which reads this settings key. The key is kept only so
 * {@link unwireCustomCssImports} can take ours back out of a leftover list — see
 * the extension id below for why even that has to be guarded.
 */
const CUSTOM_CSS_IMPORTS = 'vscode_custom_css.imports';

/**
 * The extension that owns {@link CUSTOM_CSS_IMPORTS}. That key is only a *registered*
 * configuration while this is installed; writing to it otherwise is rejected by
 * VS Code ("not a registered configuration"), which is what made the old command
 * fail outright on a fresh install.
 */
const CUSTOM_CSS_EXTENSION = 'be5invis.vscode-custom-css';

/**
 * Take our entries back out of a leftover `vscode_custom_css.imports` list.
 *
 * Premium Explorer loads the pair itself now, so this is a one-way cleanup for
 * users migrating off the old delivery path: two injectors loading the same
 * script would paint every row twice. It removes only filenames in {@link OURS}
 * (including any copy at a global-storage path we no longer write to — that
 * directory is keyed on the extension id, so renaming the extension moves it).
 * Everything the user wired up themselves is left exactly where it is.
 *
 * Silent when there is nothing to do, including when vscode-custom-css isn't
 * installed: the key is only a *registered* configuration while it is, so the
 * write would be rejected — and a list with no reader is not worth an error.
 */
export async function unwireCustomCssImports(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  const current = cfg.get<string[]>(CUSTOM_CSS_IMPORTS) ?? [];
  const next = current.filter((url) => !OURS.some((file) => url.endsWith('/' + file)));
  if (next.length === current.length) {
    return;
  }
  if (!vscode.extensions.getExtension(CUSTOM_CSS_EXTENSION)) {
    return;
  }
  await cfg.update(CUSTOM_CSS_IMPORTS, next, vscode.ConfigurationTarget.Global);
}
