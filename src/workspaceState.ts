/**
 * The per-workspace unions behind the one global config file. The generated
 * files are shared by every window, but rules and selection settings are
 * per-workspace — so `globalState` persists a union keyed by lowercased
 * workspace-folder name, each window replaces only its own entries, and the
 * painter picks the entry for the workspace in its window. Without this,
 * whichever window generated last would decide what every other one shows.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { ColoredFolder } from './layers';
import { FolderColorerConfig } from './config';
import { FolderColors, isWithin } from './coloredFolders';
import { Fill, mixHex, resolveFill, splitHexAlpha } from './colors';

// The injected file is a single global file shared by every window, but rules are
// per-workspace. We persist a union of each workspace's colored folders (keyed by
// workspace-folder name) so opening another workspace doesn't inherit these colors
// and both windows can be colored at once. See media/inject.js for the paint side.
const WORKSPACE_COLORS_STATE = 'premiumExplorer.workspaceColors';

// Selection options are per-workspace for exactly the same reason, and were not:
// they were baked as one global block, so whichever window generated last decided
// how a selected row looked in *every* workspace. A window with the default
// `"invert"` would silently take a neighbour's `"#ffffff"` away.
const WORKSPACE_SELECTION_STATE = 'premiumExplorer.workspaceSelection';

/**
 * Persisted union: workspace-folder name (lowercased) -> { folder key -> per-state
 * colors }, where the folder key is {@link folderKey} — the folder's path relative
 * to that workspace folder.
 */
export type WorkspaceColors = Record<string, Record<string, FolderColors>>;

/**
 * A `selectedBackgroundFill`, baked for the painter: the focused and the
 * inactive (each stop darkened by `selectedInactiveDarken`) variants, plus the
 * fill's ground — the color at the row's centre — for every derivation that
 * needs "the selection's color" (text contrast, auto watermark, auto border).
 */
export interface SelectionFill {
  /** `rgba(...)` or `linear-gradient(...)`, `selectedOpacity` baked in. */
  value: string;
  /** True when `value` (and `inactive`) are gradient images, not colors. */
  image: boolean;
  /** Ground hex + alpha; the painter composites them over the live backdrop. */
  ground: string;
  groundAlpha: number;
  inactive: string;
  inactiveGround: string;
}

/** One workspace's selection settings, as the painter reads them. */
export interface SelectionOptions {
  bg: string; shift: number; text: string; opacity: number; border: string;
  inactiveDarken: number; overrides: string[]; watermark: string;
  watermarkContrast: number; bold: boolean;
  /** Set only when `selectedBackgroundFill` is configured; wins over `bg`. */
  fill?: SelectionFill;
}

/** Every stop stepped toward black — the unfocused variant of a selection fill. */
function darkenFill(fill: Fill, amount: number): Fill {
  if (typeof fill === 'string') {
    const { hex, alpha } = splitHexAlpha(fill);
    return { stops: [{ color: mixHex(hex, '#000000', amount), alpha }], blend: 'gradient', direction: 'horizontal' };
  }
  return { ...fill, stops: fill.stops.map(s => ({ ...s, color: mixHex(s.color, '#000000', amount) })) };
}

/** Bake a `selectedBackgroundFill` into what the painter applies (see {@link SelectionFill}). */
function bakeSelectionFill(fill: Fill, opacity: number, inactiveDarken: number): SelectionFill {
  const normal = resolveFill(fill, opacity);
  const inactive = resolveFill(darkenFill(fill, inactiveDarken), opacity);
  return {
    value: normal.color || normal.image,
    image: !!normal.image,
    ground: normal.hex,
    groundAlpha: normal.alpha,
    inactive: inactive.color || inactive.image,
    inactiveGround: inactive.hex,
  };
}

/** Persisted union: workspace-folder name (lowercased) -> that workspace's selection. */
export type WorkspaceSelection = Record<string, SelectionOptions>;

/** The baked config, written as its own JSON file the painter fetches at boot. */
export interface InjectedConfig {
  /** Workspace-folder name (lowercased) -> {@link folderKey} -> per-state colors. */
  workspaces: WorkspaceColors;
  /** Same keys: the selection settings that workspace's own window generated. */
  selections: WorkspaceSelection;
  /** Used for a workspace that has colors in the union but no selection entry yet. */
  selection: SelectionOptions;
}

/** Lowercased workspace-folder name used as the union key (and matched in the DOM). */
function workspaceKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The key the painter matches an Explorer row on: a colored folder's path relative
 * to the workspace folder that owns it, lowercased and always `/`-separated. `""`
 * is the workspace folder itself.
 *
 * This is the whole reason the painter can tell `projects/gitops` from a top-level
 * `gitops`: the DOM carries no paths, so the script rebuilds each row's path from
 * the `aria-level` stack it already walks and looks it up here. Matching on the bare
 * name — which is what this used to be — painted *every* folder called `gitops` in
 * the colors of whichever rule named one, on top of the color it already inherited
 * from its real parent.
 */
function folderKey(ownerRoot: string, absPath: string): string {
  return path.relative(ownerRoot, absPath)
    .split(path.sep)
    .filter(Boolean)
    .join('/')
    .toLowerCase();
}

/**
 * Attribute each colored folder to the workspace folder that contains it, keyed by
 * its path relative to that folder. Folders outside every workspace folder — e.g. an
 * absolute rule pointing elsewhere — are dropped (they can't appear in this tree).
 */
export function groupByWorkspace(colored: ColoredFolder[], baked: Map<string, FolderColors>): WorkspaceColors {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const grouped: WorkspaceColors = {};
  // Ensure every current root has an entry, so a workspace whose rules now match
  // nothing overwrites its stale union entry with an empty map (clearing it).
  for (const folder of folders) {
    grouped[workspaceKey(folder.name)] = {};
  }
  for (const folder of colored) {
    const owner = folders.find(f => isWithin(f.uri.fsPath, folder.absPath));
    const colors = baked.get(folder.absPath);
    if (owner && colors) {
      grouped[workspaceKey(owner.name)][folderKey(owner.uri.fsPath, folder.absPath)] = colors;
    }
  }
  return grouped;
}

/**
 * Merge this window's per-workspace colors into the persisted union: replace the
 * entries for the current workspace's roots (so removed rules clear), keep the rest
 * (so other open/closed workspaces stay colored). Persists the result.
 */
export function mergeWorkspaceColors(
  context: vscode.ExtensionContext,
  thisWindow: WorkspaceColors,
): WorkspaceColors {
  const stored = context.globalState.get<WorkspaceColors>(WORKSPACE_COLORS_STATE) ?? {};
  const union: WorkspaceColors = { ...stored, ...thisWindow };
  void context.globalState.update(WORKSPACE_COLORS_STATE, union);
  return union;
}

/** This window's `premiumExplorer.selected*` settings, as the painter reads them. */
export function buildSelection(config: FolderColorerConfig): SelectionOptions {
  const s = config.selection;
  return {
    bg: s.background,
    shift: s.shift,
    text: s.text,
    opacity: s.opacity,
    border: s.border,
    inactiveDarken: s.inactiveDarken,
    overrides: s.overrides,
    watermark: s.watermark,
    watermarkContrast: s.watermarkContrast,
    bold: s.bold,
    ...(s.fill !== undefined ? { fill: bakeSelectionFill(s.fill, s.opacity, s.inactiveDarken) } : {}),
  };
}

/**
 * Merge this window's selection options into the persisted union, the same way
 * colors are merged: every root open here takes this window's settings, every other
 * workspace keeps its own. Without this the single global file could only hold one
 * workspace's answer, and the last window to generate won.
 */
export function mergeWorkspaceSelection(
  context: vscode.ExtensionContext,
  selection: SelectionOptions,
): WorkspaceSelection {
  const thisWindow: WorkspaceSelection = {};
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    thisWindow[workspaceKey(folder.name)] = selection;
  }
  const stored = context.globalState.get<WorkspaceSelection>(WORKSPACE_SELECTION_STATE) ?? {};
  const union: WorkspaceSelection = { ...stored, ...thisWindow };
  void context.globalState.update(WORKSPACE_SELECTION_STATE, union);
  return union;
}
