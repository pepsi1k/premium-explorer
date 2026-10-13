/**
 * Resolves the configured rules into the set of colored folders and bakes each
 * one's composable layers into ready-to-apply colors: `git` rules are expanded
 * by scanning for repositories, `manual` rules are added directly, and
 * {@link bakeAll} finishes enclosing folders before anything nested inside them
 * so an `inherit` layer can simply read its ancestor's result.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { paletteSequence } from './colors';
import { ColoredFolder, Part, buildPart } from './layers';
import { PartConfig, FolderColorerConfig, ResolvedRule, deepestRuleFor, gitRepoColorHex } from './config';
import { findRepositories } from './repositoryScanner';
import { resolveWatermarkArt } from './watermarkArt';

/** The root row and inner rows of one colored folder, baked for the painter. */
export interface FolderColors {
  root: Part;
  inner: Part;
}

/** Is `target` the same path as `ancestor`, or somewhere inside it? */
export function isWithin(ancestor: string, target: string): boolean {
  return target === ancestor || target.startsWith(ancestor + path.sep);
}

/**
 * Resolve the rules into the list of colored folders (name, base hex, source path,
 * and the merged root/inner layer configs). Keyed by absolute path, so two folders
 * that happen to share a name are two separate entries — the injected script tells
 * them apart by their path relative to the workspace folder (see `folderKey` in
 * workspaceState.ts).
 */
export async function resolveColoredFolders(config: FolderColorerConfig, extensionRoot: string): Promise<ColoredFolder[]> {
  const byPath = new Map<string, ColoredFolder>();

  // Git repos discovered under `git` rules, unless a deeper (manual) rule governs
  // them — in that case the manual folder below covers the region instead.
  for (const rule of config.rules) {
    if (rule.engine !== 'git') {
      continue;
    }
    for (const repo of await findRepositories(vscode.Uri.file(rule.absPath))) {
      if (deepestRuleFor(config, repo)?.engine !== 'git') {
        continue; // masked by a more specific manual rule
      }
      const name = path.basename(repo.fsPath);
      if (byPath.has(repo.fsPath)) {
        continue;
      }
      if (isSymlink(repo.fsPath) && config.symlinkStyle === 'none') {
        continue;
      }
      const hex = gitRepoColorHex(config, repo);
      byPath.set(repo.fsPath, {
        name, hex, absPath: repo.fsPath,
        ...identityOf(config, name, repo.fsPath, hex, extensionRoot, rule.backgroundWatermarkSymbol),
        ...symlinkAdjusted(config, repo.fsPath, mergedParts(rule, config)),
      });
    }
  }

  // Manual folders take precedence over a git repo at the same path. They have
  // no base color: a layer paints only when a `*Color` names one (rule-level or
  // global), so a rule that sets no color for a layer leaves that layer off —
  // never a stand-in grey. Only the git engine, which derives its base from the
  // repo's hash, has a color to fall back to.
  for (const rule of config.rules) {
    if (rule.engine !== 'git') {
      if (isSymlink(rule.absPath) && config.symlinkStyle === 'none') {
        continue;
      }
      const name = path.basename(rule.absPath);
      byPath.set(rule.absPath, {
        name, hex: '', absPath: rule.absPath,
        ...identityOf(config, name, rule.absPath, '', extensionRoot, rule.backgroundWatermarkSymbol),
        ...symlinkAdjusted(config, rule.absPath, mergedParts(rule, config)),
      });
    }
  }

  return [...byPath.values()];
}

/**
 * Bake every folder, keyed by absolute path. Shallowest paths first, so an
 * enclosing folder is always baked before the folders nested inside it and an
 * `inherit` layer can simply read the ancestor's finished colors.
 */
export function bakeAll(colored: ColoredFolder[]): Map<string, FolderColors> {
  const ordered = [...colored].sort((a, b) => a.absPath.length - b.absPath.length);
  const baked = new Map<string, FolderColors>();
  for (const folder of ordered) {
    // Nearest enclosing colored folder = the longest ancestor path.
    let nearest: ColoredFolder | undefined;
    for (const other of ordered) {
      if (other.absPath === folder.absPath || !isWithin(other.absPath, folder.absPath)) {
        continue;
      }
      if (!nearest || other.absPath.length > nearest.absPath.length) {
        nearest = other;
      }
    }
    // Nested rules inherit from what the parent paints on its *contents*.
    const inheritFrom = nearest ? baked.get(nearest.absPath)?.inner : undefined;
    baked.set(folder.absPath, {
      root: buildPart(folder, folder.root, inheritFrom),
      inner: buildPart(folder, folder.inner, inheritFrom),
    });
  }
  return baked;
}

/** Is this path (not any ancestor) itself a symlink? Missing/unreadable = no. */
function isSymlink(absPath: string): boolean {
  try {
    return fs.lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** How much a symlinked folder's fill/pill layers are dimmed under `symlinkStyle: "dim"`. */
const SYMLINK_OPACITY_FACTOR = 0.55;

/**
 * A symlink only reaches here when a rule names its path *and* the user opted into
 * painting it at all (`none` is the default and drops it before this). Under `dim`
 * it would otherwise be painted exactly like the folder it points at, so the fill
 * and pill keep the colour the rule gave them and lose the brightness — the row
 * still reads as that rule's folder while looking like the link it is. Nothing else
 * is touched: a layer the config leaves off stays off.
 */
function symlinkAdjusted(
  config: FolderColorerConfig,
  absPath: string,
  parts: { root: PartConfig; inner: PartConfig },
): { root: PartConfig; inner: PartConfig } {
  if (config.symlinkStyle !== 'dim' || !isSymlink(absPath)) {
    return parts;
  }
  const dim = (p: PartConfig): PartConfig => ({
    ...p,
    backgroundOpacity: p.backgroundOpacity * SYMLINK_OPACITY_FACTOR,
    pillOpacity: p.pillOpacity * SYMLINK_OPACITY_FACTOR,
  });
  return { root: dim(parts.root), inner: dim(parts.inner) };
}

/**
 * A folder's identity extras: the unique colour sequence driving its striped edge
 * (first entry is the colour it already had, so nothing on screen shifts) and the
 * artwork for its watermark — the rule's `backgroundWatermarkSymbol`, else the
 * name's initial.
 */
function identityOf(
  config: FolderColorerConfig,
  name: string,
  absPath: string,
  hex: string,
  extensionRoot: string,
  watermark?: string,
): Pick<ColoredFolder, 'sequence' | 'art'> {
  const basis = config.colorBy === 'path' ? absPath : name;
  const source = watermark || config.backgroundWatermarkSymbol || (Array.from(name)[0] ?? '').toUpperCase();
  return {
    // No base color (a manual rule) -> no auto-derived sequence: the edge then
    // paints only from an explicit `edgeColors`/`edgeColor`.
    sequence: hex ? paletteSequence(basis, config.palette, config.edgeColorCount, hex) : [],
    art: resolveWatermarkArt(source, absPath, extensionRoot),
  };
}

/** Merge a rule's per-layer overrides over the global root/inner defaults. */
function mergedParts(rule: ResolvedRule, config: FolderColorerConfig): { root: PartConfig; inner: PartConfig } {
  return {
    root: { ...config.root, ...rule.root },
    inner: { ...config.inner, ...rule.inner },
  };
}
