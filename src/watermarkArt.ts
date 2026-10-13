/**
 * Resolves a `backgroundWatermarkSymbol` value into drawable artwork: a shipped
 * glyph (`assets/svg/docker.svg` answers to `"docker"`), the user's own `.svg`
 * (path, inline markup, or data URI), or — for anything else — text, drawn as
 * the first two characters. See {@link resolveWatermarkArt}.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WatermarkArt, parseSvgMarkup } from './colors';
import { isSvgSource } from './config';

// Watermark artwork shipped in the box, relative to the extension root. A file
// dropped in here is addressable by its bare filename — `assets/svg/docker.svg`
// is `backgroundWatermarkSymbol: "docker"` — with no code change; only the
// examples in package.json's schema need updating so it autocompletes.
const GLYPH_DIR = path.join('assets', 'svg');

/**
 * Turn a `backgroundWatermarkSymbol` value into drawable artwork.
 *
 * An SVG source — a path to an `.svg` file, inline markup, or a data URI — is
 * loaded and reduced to its inner markup, which the pattern stamps once into
 * `<defs>` and reuses for every copy. A bare name is looked up against the glyphs
 * shipped in `assets/svg`, so `docker` draws the whale without anyone having to
 * find an icon first. Anything else is a character, drawn as text.
 *
 * The shipped glyphs are tried *after* a path, so a workspace's own `docker.svg`
 * still wins over the one in the box.
 */
export function resolveWatermarkArt(source: string, absPath: string, extensionRoot: string): WatermarkArt {
  const initial = (Array.from(path.basename(absPath))[0] ?? '?').toUpperCase();
  const isPath = isSvgSource(source);
  let markup = '';
  if (isPath) {
    markup = source.startsWith('<svg') ? source
      : source.startsWith('data:image/svg+xml') ? decodeSvgDataUri(source)
        : readSvgFile(source, absPath);
  }
  if (!markup) {
    markup = builtinGlyph(source, extensionRoot);
  }
  const parsed = markup ? parseSvgMarkup(markup) : undefined;
  if (parsed) {
    // Seed off the source, not the markup, so the scatter survives edits to the file.
    return { kind: 'svg', content: parsed.body, viewBox: parsed.viewBox, key: source };
  }
  if (isPath) {
    console.warn(`premium-explorer: could not load backgroundWatermarkSymbol "${source}"`);
    return { kind: 'watermark', content: initial, key: initial };
  }
  // Not a drawing, so it is text. Two code points is all that fits legibly, and a
  // longer value is a misspelt glyph name rather than something anyone wants drawn.
  const text = Array.from(source).slice(0, 2).join('');
  if (Array.from(source).length > 2) {
    console.warn(`premium-explorer: backgroundWatermarkSymbol "${source}" is neither a readable .svg `
      + `nor a built-in glyph (${glyphNames(extensionRoot).join(', ') || 'none found'}); drawing "${text}".`);
  }
  return { kind: 'watermark', content: text || initial, key: text || initial };
}

/**
 * The glyphs shipped with the extension, by lowercased name -> filename. Read once:
 * this is asked per colored folder, and the set only changes when the extension is
 * updated. Missing directory (a stripped build) = no built-ins, never an error.
 */
let glyphCache: { root: string; files: Map<string, string> } | undefined;
function glyphCatalogue(extensionRoot: string): Map<string, string> {
  if (glyphCache?.root !== extensionRoot) {
    const dir = path.join(extensionRoot, GLYPH_DIR);
    const files = new Map<string, string>();
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.toLowerCase().endsWith('.svg')) {
          files.set(file.slice(0, -4).toLowerCase(), path.join(dir, file));
        }
      }
    } catch {
      // No assets directory — every name falls through to the text watermark.
    }
    glyphCache = { root: extensionRoot, files };
  }
  return glyphCache.files;
}

/** Names the shipped glyphs answer to, for the warning that lists them. */
function glyphNames(extensionRoot: string): string[] {
  return [...glyphCatalogue(extensionRoot).keys()].sort();
}

/**
 * Load a shipped glyph by name. Case-insensitive and a trailing `.svg` is allowed,
 * so `docker`, `Docker` and `docker.svg` all name the same drawing. Anything
 * carrying a path separator is a path, not a name, and never reaches here.
 */
function builtinGlyph(source: string, extensionRoot: string): string {
  const name = source.trim().replace(/\.svg$/i, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return '';
  }
  const file = glyphCatalogue(extensionRoot).get(name);
  if (!file) {
    return '';
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Read an `.svg` file: absolute, `~`-relative, or relative to the folder it decorates. */
function readSvgFile(source: string, absPath: string): string {
  const expanded = source.startsWith('~/') ? path.join(os.homedir(), source.slice(2)) : source;
  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : [
      path.resolve(absPath, expanded),
      ...(vscode.workspace.workspaceFolders ?? []).map(f => path.resolve(f.uri.fsPath, expanded)),
    ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      // Try the next candidate root.
    }
  }
  return '';
}

/** Decode a `data:image/svg+xml` URI, whether percent-encoded or base64. */
function decodeSvgDataUri(uri: string): string {
  const comma = uri.indexOf(',');
  if (comma < 0) {
    return '';
  }
  const payload = uri.slice(comma + 1);
  try {
    return uri.slice(0, comma).includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return '';
  }
}
