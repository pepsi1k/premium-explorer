---
name: setup-vscode
description: Wire Premium Explorer into VS Code — custom-css imports, generated CSS/JS, and the reload dance. Use when folder colors don't show up after an install, rename, or reinstall.
argument-hint: '[optional, e.g. "colors are gone" or "after reinstall"]'
disable-model-invocation: true
allowed-tools: Bash(ls:*), Bash(cat:*), Bash(find:*), Bash(grep:*), Bash(node:*), Bash(code:*), Read, Edit
---

## Current state

- Installed extensions: !`ls -d ~/.vscode/extensions/*premium-explorer* ~/.vscode/extensions/*folder-colorer* ~/.vscode/extensions/*custom-css* 2>/dev/null || echo "none found"`
- Global storage dirs: !`ls -d ~/.config/Code/User/globalStorage/*premium-explorer* ~/.config/Code/User/globalStorage/*folder-colorer* 2>/dev/null || echo "none found"`
- Generated files: !`ls -la ~/.config/Code/User/globalStorage/*premium-explorer*/ 2>/dev/null || echo "none — never generated"`
- Configured imports: !`grep -A6 'vscode_custom_css.imports' ~/.config/Code/User/settings.json 2>/dev/null || echo "not configured"`

## Task

Get Premium Explorer actually painting. Extra context, if any: $ARGUMENTS

The extension **cannot paint backgrounds itself** — VS Code's FileDecoration API
only tints labels. It writes a CSS + JS pair into its own global storage, and
`be5invis.vscode-custom-css` injects them into the workbench. Every failure mode
below is a break somewhere in that chain, and all of them are silent.

Work through it in order:

1. **Both extensions installed?** Premium Explorer generates; `be5invis.vscode-custom-css`
   injects. Neither works alone, and a missing injector produces no error at all.

2. **Find the real storage directory.** It is named for the extension id, so a
   locally built VSIX with no `publisher` field lands in
   `undefined_publisher.premium-explorer` while a Marketplace install lands in
   `pepsik.premium-explorer`. **These are different directories.** Switching how you
   installed the extension silently changes which one is live.

3. **Do the generated files exist?** If `premium-explorer.css` is absent, nothing
   will ever create it on its own — `regenerateIfConfigured` stats that file and
   returns early when it's missing, so settings changes regenerate nothing. Break
   the deadlock by running **Premium Explorer: Generate Background CSS** from the
   command palette once; after that, settings changes keep it current.

4. **Do the imports point at the files that exist?** `addCustomCssImports` only
   ever appends — it never prunes. Renames and reinstalls leave dead URLs
   (`folder-colorer.*`, or the other publisher's directory) sitting in the list
   forever. Remove stale entries by hand; a stale import is a silent no-op.

5. **Apply it**: run **Enable Custom CSS and JS**, then reload the window. On
   Linux this patches VS Code's own install directory, so it needs write access
   there — if it reports failure, that's a permissions problem on the install,
   not a Premium Explorer problem.

Verify by reading the generated JS rather than trusting the chain: line 2 is
`globalThis.__premiumExplorerConfig`. Parse it and check `workspaces` actually holds
the folders you expect. An empty map means the rules matched nothing, which is a
`premiumExplorer.rules` problem — a `git` engine rule only matches directories that
really contain `.git`.

## Editing settings.json

It is JSONC — comments and trailing commas are legal and `JSON.parse` will choke
on it. Never read-parse-rewrite the whole file: that silently destroys the user's
comments. Use targeted edits to the import array only.

## When done

Report which storage directory is live, which imports point where, and whether
the config in the generated JS matches the configured rules. If a reload is still
needed, say so plainly — nothing takes effect until the window reloads.
