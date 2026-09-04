import * as vscode from 'vscode';

/** Directories we never descend into while scanning for repositories. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.hg', '.svn', '.Trash']);

/** How deep to recurse from the scan root. */
const MAX_DEPTH = 8;

/**
 * Recursively find every Git repository root (a folder that directly contains a
 * `.git` entry) under `root`. Used by `git` rules to discover the repos they
 * should color.
 */
export async function findRepositories(root: vscode.Uri): Promise<vscode.Uri[]> {
	const results: vscode.Uri[] = [];

	async function walk(dir: vscode.Uri, depth: number): Promise<void> {
		if (depth > MAX_DEPTH) {
			return;
		}
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			return; // unreadable/missing directory — skip it
		}
		if (entries.some(([name]) => name === '.git')) {
			results.push(dir);
		}
		for (const [name, type] of entries) {
			if ((type & vscode.FileType.Directory) && !SKIP_DIRECTORIES.has(name)) {
				await walk(vscode.Uri.joinPath(dir, name), depth + 1);
			}
		}
	}

	await walk(root, 0);
	return results;
}
