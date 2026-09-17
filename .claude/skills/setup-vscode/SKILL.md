---
name: setup-vscode
description: Wire Premium Explorer into VS Code — the workbench patch, generated CSS/JS, and the reload dance. Use when folder colors don't show up after an install, rename, or reinstall.
argument-hint: '[optional, e.g. "colors are gone" or "after reinstall"]'
disable-model-invocation: true
allowed-tools: Bash(ls:*), Bash(cat:*), Bash(find:*), Bash(grep:*), Bash(node:*), Bash(code:*), Read, Edit
---

## Current state

- Installed extensions: !`ls -d ~/.vscode/extensions/*premium-explorer* ~/.vscode/extensions/*folder-colorer* ~/.vscode/extensions/*custom-css* 2>/dev/null || echo "none found"`
- Global storage dirs: !`ls -d ~/.config/Code/User/globalStorage/*premium-explorer* ~/.config/Code/User/globalStorage/*folder-colorer* 2>/dev/null || echo "none found"`
- Generated files: !`ls -la ~/.config/Code/User/globalStorage/*premium-explorer*/ 2>/dev/null || echo "none — never generated"`
- Workbench patch: !`grep -l 'premium-explorer' /usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html /usr/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html 2>/dev/null || echo "not patched (or VS Code installed elsewhere)"`
- Leftover custom-css imports: !`grep -A6 'vscode_custom_css.imports' ~/.config/Code/User/settings.json 2>/dev/null || echo "none"`

## Task

Get Premium Explorer actually painting. Extra context, if any: $ARGUMENTS

The extension **cannot paint backgrounds itself** — VS Code's FileDecoration API
only tints labels. It writes a CSS + JS pair into its own global storage and then
patches `workbench.html` to load it. No second extension is involved. Every
failure mode below is a break somewhere in that chain, and all of them are silent.

Work through it in order:

1. **Find the real storage directory.** It is named for the extension id, so a
   locally built VSIX with no `publisher` field lands in
   `undefined_publisher.premium-explorer` while a Marketplace install lands in
   `pepsik.premium-explorer`. **These are different directories.** Switching how you
   installed the extension silently changes which one is live.

2. **Do the generated files exist?** If `premium-explorer.css` is absent, nothing
   will ever create it on its own — `regenerateIfConfigured` stats that file and
   returns early when it's missing, so settings changes regenerate nothing. Break
   the deadlock by running **Premium Explorer: Enable Background Painting** from
   the command palette once; after that, settings changes keep it current.

3. **Is `workbench.html` patched, and does it point at files that exist?** The
   patch adds `<link>`/`<script>` tags naming `./premium-explorer.{css,js}` *in the
   workbench directory* — the pair is copied there, not loaded from global storage.
   A VS Code update replaces that whole directory and silently takes the patch and
   the copies with it; the extension offers it back on the next launch, and
   re-running **Enable Background Painting** also fixes it.

4. **Permissions.** On Linux the workbench lives in VS Code's own install
   directory, usually root-owned. If the enable command reports failure it hands
   over the exact `chown`/`chmod` to run — that's a permissions problem on the
   install, not a Premium Explorer problem.

5. **"Your installation appears corrupt."** Expected: `workbench.html` is
   checksummed, so any patch trips that banner. Dismissing it is safe and changes
   nothing.

6. **Leftover vscode-custom-css imports.** Pre-2.1.0 the pair could be delivered by
   `be5invis.vscode-custom-css` instead. If that extension is still installed *and*
   still imports our files, two copies of the script paint every row twice — look
   for doubled/darker rows. **Enable Background Painting** removes Premium
   Explorer's own entries from `vscode_custom_css.imports`; entries the user added
   themselves are left alone and are theirs to manage.

Verify by reading the generated JS rather than trusting the chain: line 2 is
`globalThis.__premiumExplorerConfig`. Parse it and check `workspaces` actually holds
the folders you expect. An empty map means the rules matched nothing, which is a
`premiumExplorer.rules` problem — a `git` engine rule only matches directories that
really contain `.git`.

## Editing settings.json

It is JSONC — comments and trailing commas are legal and `JSON.parse` will choke
on it. Never read-parse-rewrite the whole file: that silently destroys the user's
comments. Use targeted edits only.

## When done

Report which storage directory is live, whether the workbench is patched and with
which version, and whether the config in the generated JS matches the configured
rules. If a reload is still needed, say so plainly — nothing takes effect until the
window reloads.
