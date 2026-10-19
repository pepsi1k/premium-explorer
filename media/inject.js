// premium-explorer — injected into the VS Code workbench by the extension's own patch.
//
// Paints Explorer row backgrounds for Git repositories and everything inside them,
// plus a per-repo hover shade and a selection highlight. It walks the Explorer
// tree by indentation level because the virtualized list renders rows as flat
// siblings, so there is no CSS way to select "everything inside folder X".
//
// This is an unsupported hack against VS Code's internal `.monaco-list-row` DOM —
// a future VS Code update could change these class names. All styling is applied
// inline and tracked via `data-fc-*` markers so we never clobber rows we don't own.
//
// The per-workspace color maps and selection options live in
// ./premium-explorer.json next to this script, fetched at boot (see start()).
(function () {
	"use strict";

	// The injected file is global (shared by every window), but colors are scoped
	// per workspace: WORKSPACES maps a workspace-folder name -> { folder key -> colors }.
	// We paint only the map(s) for the workspace shown in this window, so opening a
	// different workspace doesn't inherit another one's colors. A folder key is the
	// folder's path relative to that workspace folder ("projects/gitops"), lowercased
	// and "/"-separated — see `folderAt()`, which rebuilds a row's path to match it.
	var WORKSPACES;  // wsName -> { relPath -> { root, inner } } (each part: background/edge/pill/text layers)
	// Selection options are scoped per workspace for the same reason colors are, and
	// keyed the same way. A single global block meant whichever window generated the
	// file last decided how a selected row looked *everywhere* — so a workspace left
	// on the default "invert" would quietly take a neighbour's "#ffffff" away, and
	// with it every selection on a row outside a coloured folder, since "invert" has
	// no colour to use there. `paint()` picks this window's before it paints a row.
	var SELECTIONS;
	var SEL;         // { bg, text, opacity, border, inactiveDarken, overrides, bold, fill? }
	// The block baked alongside the unions, for a workspace that has colours in the
	// union but no entry of its own yet (its window last generated before selections
	// were split per workspace). It self-heals the next time that window generates.
	var FALLBACK_SEL;

	// How far a row being renamed shifts off the color it would otherwise paint —
	// enough to register as a change, not enough to look like a different folder.
	var EDIT_SHIFT = 0.1;
	// Which styles the selection color takes over. Only what `selectedOverrides`
	// names changes on a selected row; everything else keeps painting exactly as it
	// does unselected, so ["background"] recolors just the fill and leaves the rest.
	// The edge bar is never in this set — it always keeps its own colours.
	function overridden(layer) {
		var list = SEL.overrides || [];
		return list.indexOf(layer) >= 0;
	}

	// The focus ring for a selected row while the Explorer is focused:
	//   "none" -> no ring; "auto" -> the theme's own focus-outline color; hex -> that color.
	// With a `selectedBackgroundFill`, "auto" instead derives from the fill itself —
	// one step darker than its ground (§5: light fill → darker border, dark fill →
	// darker still) — so the ring always belongs to the selection it wraps.
	function selectionOutline(fillBase) {
		var b = SEL.border;
		if (!b || b === "none") { return ""; }
		if (b === "auto") {
			if (fillBase) { return "1px solid " + darken(fillBase, 0.3); }
			return "1px solid var(--vscode-list-focusOutline, var(--vscode-focusBorder, rgba(0, 0, 0, 0.4)))";
		}
		return "1px solid " + b;
	}

	function rowName(row) {
		var el = row.querySelector(".label-name");
		var name = el ? el.textContent.trim() : "";
		if (name) { row.dataset.fcName = name; return name; }
		// The inline rename box is rendered with `hideLabel`, which empties `.label-name`
		// for as long as it is open. Read straight through and the row stops matching its
		// folder — so renaming a colored folder would drop the color of every row beneath
		// it mid-edit. Hold the last name instead; the list refills the label, and this
		// cache with it, as soon as the edit ends.
		if (row.querySelector(".monaco-inputbox")) { return row.dataset.fcName || ""; }
		return "";
	}

	// The colored folders for the workspace shown in this window, kept as one map per
	// workspace key (they must stay apart: two roots of a multi-root workspace can
	// both hold a `projects/gitops`), plus that workspace's own selection options.
	//
	// Which case we're in is never guessed by matching a row's *name* against the
	// persisted `WORKSPACES` keys — that union spans every workspace this file has
	// ever been generated for, across every window, forever, so an ordinary folder
	// that merely happens to share a name with some *other*, unrelated workspace
	// this machine once opened directly (its own `idp`, say) would misread as a
	// workspace root and send every lookup beneath it down the wrong branch of
	// `folderAt()` — not a handful of rows painted wrong, all of them, since which
	// branch runs is decided once per paint. Multi-root-ness is instead read off a
	// signal the workbench itself only ever puts on a genuine workspace-folder row:
	// its icon carries VS Code's own `rootfolder-icon` class (`fileKind === ROOT`),
	// which an ordinary subfolder — however it's named — never gets.
	function isWorkspaceRootRow(row) {
		return !!row.querySelector(".rootfolder-icon");
	}

	// Cached across paints so a moment where the list is scrolled past every
	// level-1 row (none rendered to check) keeps the last real answer instead of
	// defaulting to "single-folder" and misreading every row until the view
	// scrolls back. The very first paint almost always renders from the top, so
	// this self-corrects immediately in practice.
	var lastMultiRoot = false;

	function activeContext(view) {
		var pane = view.closest ? view.closest(".pane") : null;
		var title = pane ? pane.querySelector(".pane-header .title") : null;
		var titleKey = title ? title.textContent.trim().toLowerCase() : "";

		var levelOne = view.querySelectorAll('.monaco-list-row[aria-level="1"]');
		var multiRoot = lastMultiRoot;
		if (levelOne.length) {
			multiRoot = false;
			for (var i = 0; i < levelOne.length; i++) {
				if (isWorkspaceRootRow(levelOne[i])) { multiRoot = true; break; }
			}
			lastMultiRoot = multiRoot;
		}

		var maps = {};
		var sel = null;
		if (multiRoot) {
			// Level 1 *is* the set of workspace folders here — each root row names the
			// map it owns directly, so no name has to be guessed at or merged across
			// unrelated roots the way stale keys used to get pulled in.
			for (var j = 0; j < levelOne.length; j++) {
				if (!isWorkspaceRootRow(levelOne[j])) { continue; }
				var rootKey = rowName(levelOne[j]).toLowerCase();
				var map = WORKSPACES[rootKey];
				if (map) { maps[rootKey] = map; }
				// First match wins. Every root open in one window was generated by that
				// window, so in a multi-root workspace they all carry the same settings.
				if (!sel && SELECTIONS[rootKey]) { sel = SELECTIONS[rootKey]; }
			}
		} else if (WORKSPACES[titleKey]) {
			// Single-folder window: the hidden root's own name is all the pane header
			// carries, and level 1 is already inside it.
			maps[titleKey] = WORKSPACES[titleKey];
			sel = SELECTIONS[titleKey] || null;
		}

		// A workspace whose window last generated before selections were split per
		// workspace has colors in the union but no entry here; fall back to the block
		// baked alongside them, which is what it used to get anyway.
		return {
			maps: maps,
			multiRoot: multiRoot,
			// Which map a row belongs to when level 1 is not itself a root row (the
			// single-folder case). Null leaves `folderAt()` to match across every map.
			soleKey: !multiRoot && WORKSPACES[titleKey] ? titleKey : null,
			selection: sel || FALLBACK_SEL
		};
	}

	/** How many segments a baked folder key has ("" — the workspace folder — is 0). */
	function segmentCount(key) {
		return key ? key.split("/").length : 0;
	}

	/** Is `tail` the trailing run of whole segments of `key`? */
	function endsWithSegments(key, tail) {
		if (!tail) { return false; }
		return key === tail || key.slice(-(tail.length + 1)) === "/" + tail;
	}

	/** The lowercased path `segs[start..level-1]` joined the way the keys are baked. */
	function pathKey(segs, start, level) {
		var parts = [];
		for (var i = start; i < level; i++) { parts.push((segs[i] || "").toLowerCase()); }
		return parts.join("/");
	}

	// Which colored folder this row *is*, if any.
	//
	// The DOM carries no paths, so the walk below rebuilds one from the ancestor
	// names it has already passed. `from` is the shallowest index of that chain it
	// can vouch for: 0 once a level-1 row has been seen, deeper while the list is
	// scrolled past the top of the tree and the outer ancestors are not rendered.
	function folderAt(ctx, segs, from, level) {
		if (from === 0) {
			// Every ancestor accounted for: the row's own path is known exactly.
			if (ctx.multiRoot) {
				var map = ctx.maps[(segs[0] || "").toLowerCase()];
				return map ? map[pathKey(segs, 1, level)] || null : null;
			}
			if (ctx.soleKey) {
				var only = ctx.maps[ctx.soleKey];
				return only ? only[pathKey(segs, 0, level)] || null : null;
			}
			// Otherwise we can't say which root this row hangs off — fall through.
		}
		// All we know is the tail of the path. Match on that plus the row's depth, and
		// only when the two together pick out exactly one folder: an ambiguous tail is
		// left unpainted rather than painted as the wrong folder, which is the bug
		// matching by bare name used to have everywhere.
		var tail = pathKey(segs, from, level);
		var depth = ctx.multiRoot ? level - 1 : level;
		var hit = null;
		for (var key in ctx.maps) {
			var m = ctx.maps[key];
			for (var p in m) {
				if (segmentCount(p) !== depth || !endsWithSegments(p, tail)) { continue; }
				if (hit) { return null; } // ambiguous
				hit = m[p];
			}
		}
		return hit;
	}

	function isFolder(row) {
		// A workspace-folder root uses `.rootfolder-icon`, not `.folder-icon` — already
		// covered by the `aria-expanded` fallback (every folder is expandable), listed
		// explicitly here too since `isWorkspaceRootRow()` checks for it by name anyway.
		return !!row.querySelector(".folder-icon") || !!row.querySelector(".rootfolder-icon")
			|| row.getAttribute("aria-expanded") !== null;
	}

	// Every color that reaches this script is a hex or an rgba() string, and almost
	// every helper below wants the three channels — so parse once, here.
	function channels(hex) {
		var h = hex.replace("#", "");
		if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
		return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
	}

	function toHex(c) {
		return "#" + c.map(function (n) { return ("0" + Math.round(n).toString(16)).slice(-2); }).join("");
	}

	/** 0..1 — how bright a color reads, for deciding which way to move off it. */
	function luma(c) {
		return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
	}

	function rgba(hex, alpha) {
		return "rgba(" + channels(hex).join(", ") + ", " + alpha + ")";
	}

	// Black or white text, whichever reads better on a solid hex background.
	function contrast(hex) {
		return luma(channels(hex)) > 0.6 ? "#000000" : "#ffffff";
	}

	// Apply with change-tracking (data-* markers) to avoid observer write loops and
	// to only ever touch rows we own (empty default -> we never clear others' styles).
	function setBg(row, value) {
		if ((row.dataset.fcBg || "") === value) { return; }
		row.dataset.fcBg = value;
		row.style.backgroundColor = value;
	}

	// The label-level writes below keep their change-tracking key *inside the very
	// inline style it guards*, as a custom property, rather than in a `data-`
	// marker on the row.
	//
	// The tree owns `.label-name`: it re-renders one whenever the label changes —
	// a recycled row, a git decoration — and that drops the inline styles we put
	// there. A marker kept anywhere else survives that and goes on claiming the
	// styling is applied, so the pill or colour is never put back and the row
	// stays bare until the computed value happens to change (EM-101). A key
	// carried in the style dies with it, so a re-rendered label always repaints.
	function setText(row, value) {
		// Only recolor the name, not the whole label, so git badges keep their color.
		var names = row.querySelectorAll(".label-name");
		for (var i = 0; i < names.length; i++) {
			var s = names[i].style;
			if (s.getPropertyValue("--fc-text-key") === value) { continue; }
			s.setProperty("--fc-text-key", value);
			s.color = value;
		}
	}

	// The row's corner rounding (EM-103). A `border-radius` here clips every
	// background layer at once — fill, edge bar and watermark — which is what makes
	// the row (or the folder's block) read as one rounded plate. It does not clip
	// the row's *contents*: that would need `overflow: hidden`, which we never set,
	// so a label is never cut off by a radius.
	function setRadius(row, value) {
		if ((row.dataset.fcRadius || "") === value) { return; }
		row.dataset.fcRadius = value;
		row.style.borderRadius = value;
	}

	// Four corners in CSS order as a `border-radius` value, or "" when all square.
	function cornersCss(c) {
		if (!c || (!c[0] && !c[1] && !c[2] && !c[3])) { return ""; }
		return c[0] + "px " + c[1] + "px " + c[2] + "px " + c[3] + "px";
	}

	// Shift one row's label block left by `lead`, so the pill's left inset costs the
	// text no horizontal position (EM-118).
	//
	// The plate cannot simply bleed outwards: `.monaco-icon-label-container`,
	// `.monaco-icon-label` and `.monaco-tl-contents` are all `overflow: hidden` and
	// all begin at the label's own left edge, so anything drawn left of it is
	// clipped flat. What *is* available is moving `.monaco-tl-contents` itself —
	// its parent `.monaco-tl-row` is the first ancestor that does not clip — so the
	// inset gets drawn in the space the shift opens and the text lands exactly where
	// an unpilled row's text lands.
	//
	// `lead` is baked (`part.pillLead`), never derived here: it is the pill's own
	// left padding under `pillAlign: "shift"` and 0 under `"hug"`. Nothing is
	// clamped — how far the plate reaches is the padding's job, and a left padding
	// big enough to reach the row's chevron will cover it. Tracked like every other
	// write we own.
	function setLabelLead(row, lead) {
		var key = lead ? String(lead) : "";
		if ((row.dataset.fcLead || "") === key) { return; }
		row.dataset.fcLead = key;
		var contents = row.querySelector(".monaco-tl-contents");
		if (contents) { contents.style.marginLeft = lead ? -lead + "px" : ""; }
	}

	// The corners one *row* shows. The edge bar is a background image and an image
	// cannot carry a radius, so `edgeRadius` rounds the two corners the bar actually
	// occupies — the left pair — and takes whichever of the two radii is larger
	// there.
	function rowCorners(part) {
		var bg = part.backgroundRadius || [0, 0, 0, 0];
		var eg = part.edgeRadius || [0, 0, 0, 0];
		return [Math.max(bg[0], eg[0]), bg[1], bg[2], Math.max(bg[3], eg[3])];
	}

	// The git-mark colours, published for the generated CSS's `::after` rules — the
	// letter and the folder dot are pseudo-elements, so they cannot be styled inline
	// and the colours have to travel as custom properties on exactly the rows we
	// decided about. `style` is "" on a row we leave entirely to VS Code.
	function setGitVars(row, style, fg, plate, border, dot) {
		var key = style + "|" + fg + "|" + plate + "|" + border + "|" + dot;
		if ((row.dataset.fcGit || "") === key) { return; }
		row.dataset.fcGit = key;
		row.classList.toggle("fc-git-ink", !!fg);
		row.classList.toggle("fc-git-chip", style === "chip" || style === "solid");
		row.classList.toggle("fc-git-outline", style === "outline");
		// "ink" is the symlink arrow: recoloured, never boxed.
		row.classList.toggle("fc-git-off", style === "none");
		var vars = {
			"--fc-git-fg": fg,
			"--fc-git-plate": plate,
			"--fc-git-border": border,
			"--fc-git-dot": dot
		};
		for (var name in vars) {
			if (vars[name]) { row.style.setProperty(name, vars[name]); }
			else { row.style.removeProperty(name); }
		}
	}

	// An inset focus ring, tracked like setBg so we only touch rows we own.
	function setOutline(row, value) {
		if ((row.dataset.fcOutline || "") === value) { return; }
		row.dataset.fcOutline = value;
		row.style.outline = value;
		row.style.outlineOffset = value ? "-1px" : "";
	}

	// A translucent wash in whichever direction reads against `hex` — white over a dark
	// color, black over a light one. Unlike `shade`, which returns an opaque color,
	// this leaves whatever is underneath showing through, so the row's fill and
	// watermark survive being covered.
	function wash(hex, alpha) {
		var toward = luma(channels(hex)) > 0.5 ? "0, 0, 0" : "255, 255, 255";
		return "rgba(" + toward + ", " + alpha + ")";
	}

	// What the inline rename box should look like, published on the row for the
	// generated CSS to pick up. The box keeps the row's own colors and watermark — it
	// is the same row, only being edited — so all this carries is a faint wash and a
	// border to mark the field, plus a foreground that reads against the row.
	//
	// Styling the box from here directly does not hold: `InputBox.applyStyles()`
	// rewrites its own inline `background-color`/`color` whenever the validation
	// message changes — which the rename does on open and on every keystroke — so it
	// would paint over us moments later, and the marker below would suppress the
	// repaint. Custom properties plus `!important` rules win instead, because inline
	// styles lose to `!important` from a stylesheet. Setting them on the row (not the
	// box) also survives the label being re-rendered.
	function setEditVars(row, fill, inset) {
		var key = fill + "|" + (inset ? "field" : "");
		if ((row.dataset.fcEdit || "") === key) { return; }
		row.dataset.fcEdit = key;
		var vars = {
			// `selectedRenameStyle: "field"` wants a real inset text field instead, so
			// both of these are left unset and the CSS falls back to the theme's own
			// input colours — over the row, which has still shifted.
			"--fc-edit-fg": fill && !inset ? contrast(fill) : "",
			// The row itself has already shifted, so the field only has to get out of the
			// way and let it — and the watermark over it — show through. Left unset on a
			// row we don't paint, where the CSS falls back to the theme's own input color.
			"--fc-edit-field": fill && !inset ? "transparent" : "",
			"--fc-edit-border": fill ? wash(fill, 0.45) : ""
		};
		for (var name in vars) {
			if (vars[name]) { row.style.setProperty(name, vars[name]); }
			else { row.style.removeProperty(name); }
		}
	}

	// The selected label's colour and weight, handed to the generated CSS rather than
	// written here. Inline on the row it would not reach the decoration badge or the
	// twistie *inside* the label, which carry colours of their own; a stylesheet
	// `!important` does. The colour cannot be a literal in that stylesheet either —
	// one file serves every window and the setting is per workspace — so it travels
	// as a variable, and the two markers make the rules match exactly the rows we
	// styled. A row we set neither on is left entirely to the theme.
	function setSelLabel(row, color, bold) {
		if ((row.dataset.fcSelFg || "") !== color) {
			row.dataset.fcSelFg = color;
			if (color) { row.style.setProperty("--fc-sel-fg", color); }
			else { row.style.removeProperty("--fc-sel-fg"); }
		}
		row.classList.toggle("fc-sel-text", !!color);
		row.classList.toggle("fc-sel-bold", !!bold);
	}

	// The hover colors, published as custom properties for the generated CSS's
	// `:hover` rules. Hover used to be painted from here — every mouseover swept a
	// full repaint across the pane, and with watermark data-URIs in the image keys
	// that dragged megabytes of string work per mouse move (EM-85). The browser's
	// own `:hover` swaps a custom property for free, so the painter only has to say
	// what the brighter color *is*; the classes keep the rules off rows we never
	// painted, exactly like `.fc-sel-text`.
	function setHoverVars(row, bg, pill, mark) {
		// A pill that encloses a mark cannot take the plain hover rule: that one
		// applies the fill with the `background` shorthand, and a shorthand resets
		// every longhand it does not mention — `background-image` among them, which
		// is the layer the mark rides on. So the whole stack is restated instead,
		// which means the fill has to travel split into its colour and its image
		// (a baked pill fill is one or the other) with the mark on top (EM-117).
		var marked = !!(pill && mark);
		var key = bg + "|" + pill + "|" + (marked ? mark.key + ":" + mark.size + ":" + mark.trail : "");
		if ((row.dataset.fcHover || "") === key) { return; }
		row.dataset.fcHover = key;
		row.classList.toggle("fc-hover-bg", !!bg);
		row.classList.toggle("fc-hover-pill", !!pill);
		row.classList.toggle("fc-hover-mark", marked);
		var isImage = marked && pill.indexOf("gradient(") !== -1;
		var vars = {
			"--fc-bg-hover": bg,
			"--fc-pill-hover": pill,
			"--fc-pill-hover-bg": marked && !isImage ? pill : "",
			"--fc-pill-hover-img": marked && isImage ? pill : "",
			"--fc-mark-img": marked ? mark.image : "",
			"--fc-mark-size": marked ? mark.size + "px " + mark.size + "px" : "",
			"--fc-mark-pos": marked ? "right " + mark.trail + "px center" : ""
		};
		for (var name in vars) {
			if (vars[name]) { row.style.setProperty(name, vars[name]); }
			else { row.style.removeProperty(name); }
		}
	}

	// A short identity for one baked watermark + tint, so change tracking never has
	// to touch the ~20-48KB URI text. The id is handed out lazily and lives on the
	// layer object itself, like the tint cache in tintedWatermark.
	var nextWatermarkId = 0;
	function watermarkKey(watermark, tint) {
		if (!watermark.id) { watermark.id = ++nextWatermarkId; }
		return "w" + watermark.id + ":" + (tint || "");
	}

	// Marks a selected row whose pill kept its own fill (EM-89). The selection's
	// text color is picked to read against the selection fill — but this label
	// sits on the pill, so the generated CSS carves `.label-name` back out of the
	// selected-label rule on rows carrying `fc-pill-own`, and the label keeps its
	// normal color: the part's own `textColor` when set (travels as
	// `--fc-pill-fg`), else the theme's foreground.
	function setPillOwn(row, fg) { // "" = off, "auto" = theme foreground, else a hex
		if ((row.dataset.fcPillOwn || "") === fg) { return; }
		row.dataset.fcPillOwn = fg;
		row.classList.toggle("fc-pill-own", !!fg);
		if (fg && fg !== "auto") { row.style.setProperty("--fc-pill-fg", fg); }
		else { row.style.removeProperty("--fc-pill-fg"); }
	}

	// The stacked background images — edge bar, text cover, watermark — as one
	// set of comma-separated CSS lists. The FIRST entry paints on top, which is why
	// the stack is pushed in that order: the bar over the cover, the cover over the
	// watermark it dims, all of them over the row's background color.
	function setBgImage(row, layers) {
		var size = [], position = [], repeat = [], key = [];
		for (var i = 0; i < layers.length; i++) {
			size.push(layers[i].size);
			position.push(layers[i].position);
			repeat.push(layers[i].repeat);
			// A layer carrying a `key` (the watermark) is identified by it; the others'
			// images are short gradient strings and identify themselves.
			key.push(layers[i].key || layers[i].image);
		}
		size = size.join(", "); position = position.join(", "); repeat = repeat.join(", ");
		// The position carries the row's phase into the canvas, so it changes as rows
		// recycle even when the image does not — it has to be part of the key.
		key = key.join("|") + "|" + size + "|" + position + "|" + repeat;
		if ((row.dataset.fcImg || "") === key) { return; }
		row.dataset.fcImg = key;
		// Only now, on a real change, pay for joining the full URIs.
		var image = [];
		for (var j = 0; j < layers.length; j++) { image.push(layers[j].image); }
		var s = row.style;
		s.backgroundImage = image.join(", ");
		s.backgroundSize = size;
		s.backgroundPosition = position;
		s.backgroundRepeat = repeat;
	}

	// A rounded background behind just the label text, for the `pill` layer.
	// `outlineColor` traces the pill's edge; it is drawn as an inset outline rather
	// than a border so switching it on never reflows the label by a pixel.
	// `value` is an rgba color or a baked gradient string — the `background`
	// shorthand takes both, which is what lets a pill carry a multi-stop fill.
	// `mark` is set only for an *enclosed* mark (`markInPill`), and it has to be
	// painted here rather than on the row: the pill is a background on `.label-name`,
	// a child element, so it paints over every background image the row carries —
	// including the mark, which simply disappeared behind it. On the label itself the
	// mark composites above the pill, anchored to the plate's right edge.
	function setLabelBg(row, value, radius, padding, outlineColor, mark) {
		var key = value
			? value + "|" + radius + "|" + padding + "|" + (outlineColor || "")
				+ "|" + (mark ? mark.key + ":" + mark.size + ":" + mark.trail : "")
			: "";
		var names = row.querySelectorAll(".label-name");
		for (var i = 0; i < names.length; i++) {
			var s = names[i].style;
			if (s.getPropertyValue("--fc-pill-key") === key) { continue; }
			s.setProperty("--fc-pill-key", key);
			s.background = value;
			if (value && mark) {
				// `background` above has just set the pill; whatever image it left (a
				// gradient fill) has to stay underneath the mark. A flat pill leaves
				// no image, but Chromium serializes that as "initial" rather than
				// "none" — carrying it into the layer list yields `url(...), initial`,
				// which is invalid, so the whole declaration is dropped and the mark
				// never paints. Normalize every no-image spelling to "" first.
				var under = s.backgroundImage;
				if (!under || under === "none" || under === "initial") { under = ""; }
				s.backgroundImage = under ? mark.image + ", " + under : mark.image;
				var size = mark.size + "px " + mark.size + "px";
				s.backgroundSize = under ? size + ", auto" : size;
				var at = "right " + mark.trail + "px center";
				s.backgroundPosition = under ? at + ", left top" : at;
				s.backgroundRepeat = under ? "no-repeat, no-repeat" : "no-repeat";
			}
			s.borderRadius = value ? radius : "";
			s.padding = value ? padding : "";
			s.outline = value && outlineColor ? "1px solid " + outlineColor : "";
			s.outlineOffset = value && outlineColor ? "-1px" : "";
		}
	}

	// The label weight/style, for the `text` layer (bold/italic). Empty = theme default.
	function setTextStyle(row, weight, style) {
		var key = weight + "|" + style;
		var names = row.querySelectorAll(".label-name");
		for (var i = 0; i < names.length; i++) {
			var s = names[i].style;
			if (s.getPropertyValue("--fc-ts-key") === key) { continue; }
			s.setProperty("--fc-ts-key", key);
			s.fontWeight = weight;
			s.fontStyle = style;
		}
	}

	// The label glow (EM-116). It lands in two places because CSS allows nothing
	// else: `soft` and `neon` are a plain `text-shadow`, which goes inline on the
	// label like the weight above, while `halo`, `aurora` and `underglow` draw in a
	// `::before`/`::after` — and no inline style can reach a pseudo-element. Those
	// get a class plus the colours as custom properties, and the shape comes from
	// the generated stylesheet, exactly as the git marks do.
	//
	// The two halves are tracked separately for the same reason setTextStyle keys
	// off the label rather than the row: the list recycles both, and a row whose
	// glow is unchanged may still have been handed a fresh `.label-name`.
	// `glow` is null on a row we paint no glow on, which removes every trace.
	function setGlow(row, glow) {
		var style = glow ? glow.style : "";
		var key = style
			? style + "|" + glow.core + "|" + glow.fade + "|" + glow.second + "|" + glow.spread
			: "";
		if ((row.dataset.fcGlow || "") !== key) {
			row.dataset.fcGlow = key;
			row.classList.toggle("fc-glow-halo", style === "halo");
			row.classList.toggle("fc-glow-aurora", style === "aurora");
			row.classList.toggle("fc-glow-under", style === "underglow");
			var vars = {
				"--fc-glow-core": style ? glow.core : "",
				"--fc-glow-fade": style ? glow.fade : "",
				"--fc-glow-second": style ? glow.second : "",
				"--fc-glow-blur": style && glow.spread ? glow.spread + "px" : ""
			};
			for (var name in vars) {
				if (vars[name]) { row.style.setProperty(name, vars[name]); }
				else { row.style.removeProperty(name); }
			}
		}
		var shadow = style ? glow.shadow : "";
		var names = row.querySelectorAll(".label-name");
		for (var i = 0; i < names.length; i++) {
			var s = names[i].style;
			if (s.getPropertyValue("--fc-glow-key") === shadow) { continue; }
			s.setProperty("--fc-glow-key", shadow);
			s.textShadow = shadow;
		}
	}



	// `hex` stepped away from whatever it is going to sit on, by `amount` of the
	// distance to white or black: lighter over a dark backdrop, darker over a light
	// one. The direction comes from `over`, not from `hex` itself, so a dark tint on
	// a dark row lifts clear of it instead of sinking further in. Passing the same
	// color as both is the common case — "a shade just off this" — which is how the
	// selected watermark is picked.
	function nudge(hex, over, amount) {
		amount = +amount || 0; // tolerate missing/invalid -> the color itself
		var toward = luma(channels(over)) > 0.5 ? 0 : 255;
		return toHex(channels(hex).map(function (v) { return v + (toward - v) * amount; }));
	}

	// How much of the folder's own color a lift pulls back in, relative to how far it
	// steps. `nudge` alone cannot mark a row: it moves every channel the same distance
	// toward white, which flattens the ratios *between* them — so a dark, saturated row
	// arrives at grey, carrying none of the folder it belongs to. Pulling the fill back
	// in first restores the hue that the step is about to wash out.
	var LIFT_HUE = 3;

	// The color a row lands on when it is marked — selected, or open for rename. Two
	// moves, in this order: mix the folder's own color back into what the row already
	// shows, then step the result clear of it. The mix is what keeps a selected row
	// recognisably part of its folder instead of a grey band; the step is what makes it
	// read as marked at all. With no fill of its own there is no hue to restore, so it
	// degrades to the plain step.
	function lift(shows, fill, amount) {
		amount = +amount || 0;
		var hued = fill ? mix(fill, shows, Math.min(1, amount * LIFT_HUE)) : shows;
		return nudge(hued, shows, amount);
	}

	// The watermark re-tinted. Its color is baked into the SVG data URI at generate
	// time, but it appears there exactly once (hoisted onto the root <svg>), so
	// swapping it is a string replace. Cached on the layer itself — these URIs run
	// to ~20KB and paint runs on every frame.
	function tintedWatermark(watermark, tint) {
		if (!watermark.tint || !tint) { return watermark.image; }
		var cache = watermark.tinted || (watermark.tinted = {});
		if (!cache[tint]) {
			cache[tint] = watermark.image.split(encodeURIComponent(watermark.tint)).join(encodeURIComponent(tint));
		}
		return cache[tint];
	}

	/* --------------------------------------------------------------------- *
	 * Git marks (EM-96)
	 * --------------------------------------------------------------------- */

	// The four colours Git decorates a row with, as the workbench publishes them.
	var GIT_VARS = {
		modified: "--vscode-gitDecoration-modifiedResourceForeground",
		added: "--vscode-gitDecoration-addedResourceForeground",
		untracked: "--vscode-gitDecoration-untrackedResourceForeground",
		deleted: "--vscode-gitDecoration-deletedResourceForeground"
	};

	// WCAG relative luminance, and the contrast ratio between two colours. The lift
	// below targets a *ratio* rather than "a step this big", because that is what the
	// defect is measured in: over an amber fill Git's modified label sits at 3.4:1,
	// its added one at 2.5:1 and its deleted one at 1.3:1, all short of 4.5:1.
	function luminance(c) {
		var s = c.map(function (v) {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
	}
	function contrastRatio(a, b) {
		var la = luminance(channels(a)) + 0.05, lb = luminance(channels(b)) + 0.05;
		return la > lb ? la / lb : lb / la;
	}

	// `hex` stepped away from `over` until it reads at `target`:1 against it — and no
	// further, so a lifted status colour keeps as much of itself as the target allows.
	// Gives up at the extreme rather than returning nothing: white on a mid grey can
	// never reach 4.5, and a mark slightly short of target still beats no mark.
	function liftToContrast(hex, over, target) {
		if (!hex || !over) { return hex; }
		if (!(target > 1) || contrastRatio(hex, over) >= target) { return hex; }
		var best = hex;
		for (var step = 1; step <= 20; step++) {
			best = nudge(hex, over, step / 20);
			if (contrastRatio(best, over) >= target) { return best; }
		}
		return best;
	}

	// VS Code publishes a file decoration as a *generated* class on
	// `.monaco-icon-label` — `monaco-decoration-itemColor-<hash>` for the filename's
	// colour, with a matching `::after` rule carrying the status letter (a file) or
	// the dot (a folder). The hash is minted at runtime, so no stylesheet can name
	// it, and the only place the decoration's *meaning* survives is the generated
	// rule's own text: `color: var(--vscode-gitDecoration-modifiedResourceForeground,
	// …)`.
	//
	// Reading the colour off the element instead does not work, and the way it fails
	// is quiet: our own `::after` rule paints the letter in the **lifted** colour, so
	// the next paint reads that back as "what Git wanted" and lifts it again — a few
	// frames of that and every mark has drifted to white, with the four statuses
	// indistinguishable. The rule text is the one copy nothing we do can touch.
	//
	// Cached by token across paints, because the hash *is* the decoration: only the
	// resolved hexes change with the theme, and those are re-read every paint.
	var decoStatus = {};
	var decoContent = {};
	var decoScanned = {};
	// VS Code marks a symlink by appending this to the file-decoration badge — the
	// same slot Git's status letter uses, so the two arrive as one string ("U, ⤷")
	// and share one colour. On its own it is the whole badge, and then it is ours to
	// colour (§7).
	var SYMLINK_GLYPH = "\u2937";
	function decorationToken(icon) {
		var list = icon.classList;
		for (var i = 0; i < list.length; i++) {
			if (list[i].indexOf("monaco-decoration-itemColor-") === 0) { return list[i]; }
		}
		return "";
	}

	// One pass over the workbench's stylesheets, mapping every decoration class it
	// finds to the git status its colour comes from. Run only when a token turns up
	// that has not been seen before — decorations are minted per distinct
	// colour+letter, so after the first repaint of a changed tree there is nothing
	// new to scan.
	function scanDecorations() {
		var sheets = document.styleSheets;
		for (var s = 0; s < sheets.length; s++) {
			var rules;
			try { rules = sheets[s].cssRules; } catch (e) { continue; }   // cross-origin
			for (var r = 0; r < rules.length; r++) {
				var selector = rules[r].selectorText;
				if (!selector || selector.indexOf(".monaco-decoration-itemColor-") !== 0) { continue; }
				var token = selector.slice(1);
				if (token in decoStatus) { continue; }
				// A folder's decoration nests fallbacks — modified, then untracked, then
				// added — which is VS Code's own order of precedence; the first one is
				// the status it is really reporting.
				var css = rules[r].cssText || "";
				var match = /--vscode-gitDecoration-(\w+?)Resource/.exec(css);
				decoStatus[token] = match ? match[1] : "";
				// The letter(s) this decoration draws, read from the badge rule beside the
				// colour rule — the only place the badge's text exists.
				var badge = "";
				for (var b2 = 0; b2 < rules.length; b2++) {
					var sel2 = rules[b2].selectorText;
					if (!sel2 || sel2.indexOf("." + token.replace("itemColor", "itemBadge")) !== 0) { continue; }
					var content = /content:\s*"([^"]*)"/.exec(rules[b2].cssText || "");
					if (content) { badge = content[1]; }
					break;
				}
				decoContent[token] = badge;
			}
		}
	}

	// Git's own colour for a decoration, or "" when it is some other provider's
	// (ESLint, an extension) — those keep exactly what VS Code painted, since the
	// `git*` settings have nothing to say about them.
	function decorationHex(token, palette) {
		if (!(token in decoStatus) && !decoScanned[token]) {
			decoScanned[token] = 1;
			scanDecorations();
		}
		return palette[decoStatus[token]] || "";
	}

	// Is this decoration the symlink arrow and nothing else? Then the badge is ours
	// to colour (§7); with a Git letter beside it the two share one `::after` and
	// Git's own colouring governs, because there is only one colour to give.
	function symlinkOnly(token) {
		var badge = decoContent[token] || "";
		return badge.indexOf(SYMLINK_GLYPH) >= 0 && !/[A-Za-z]/.test(badge);
	}

	// One of the `git*` settings resolved for this row: a hex, "auto", "off", or the
	// per-status map's entry for this status (falling back to "auto").
	function gitSetting(value, status) {
		if (typeof value === "string") { return value; }
		if (!value) { return "auto"; }
		return (status && value[status]) || "auto";
	}

	function darken(hex, amount) {
		amount = +amount || 0; // tolerate missing/invalid -> no change
		return toHex(channels(hex).map(function (v) { return v * (1 - amount); }));
	}

	// Composite `hex` over `over` at `alpha`, as an opaque hex. The selection fill is
	// translucent, so the color on screen is not the configured one — shading the
	// selected watermark off the configured color would ignore `selectedOpacity`
	// entirely and, at 0.85, land on the wrong side of the row.
	function mix(hex, over, alpha) {
		var a = Math.max(0, Math.min(1, +alpha || 0));
		var top = channels(hex), under = channels(over);
		return toHex(top.map(function (v, i) { return v * a + under[i] * (1 - a); }));
	}

	// The opaque color sitting behind the rows, so `mix` has something real to
	// composite over. The theme publishes it as a custom property on the workbench,
	// which is exact; the walk up the tree is the fallback for when that is missing,
	// and it can land on the wrong element, so prefer the variable. Getting this
	// wrong tints every color derived from it, so it is worth asking properly.
	// One of the workbench's own theme colours, as a `#rrggbb` hex, or "" when this
	// environment publishes none. VS Code declares them on the workbench element,
	// not on :root, and a stray environment may give us neither — so try both and
	// never assume the call answers at all. Read when asked rather than cached, so
	// switching theme takes effect on the next paint.
	function themeHex(name) {
		var hosts = [document.querySelector(".monaco-workbench"), document.documentElement, document.body];
		for (var h = 0; h < hosts.length; h++) {
			if (!hosts[h]) { continue; }
			var style = getComputedStyle(hosts[h]);
			var value = style && style.getPropertyValue ? style.getPropertyValue(name) : "";
			if (value && /^\s*#[0-9a-f]{6}\s*$/i.test(value)) { return value.trim().toLowerCase(); }
		}
		return "";
	}

	function backdropOf(el) {
		function hx(n) { return ("0" + (+n).toString(16)).slice(-2); }
		var themed = themeHex("--vscode-sideBar-background");
		if (themed) { return themed; }
		for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
			var c = getComputedStyle(node).backgroundColor;
			var m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c || "");
			if (m && (m[4] === undefined || +m[4] > 0.9)) {
				return "#" + hx(m[1]) + hx(m[2]) + hx(m[3]);
			}
		}
		return "#1f1f1f";
	}

	// Any color our paint produces ("#rgb", "#rrggbb" or "rgba(...)") resolved to the
	// opaque color it actually shows as once composited over `over`.
	function flatten(color, over) {
		var m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(color);
		if (!m) { return color.charAt(0) === "#" ? color : over; }
		var a = m[4] === undefined ? 1 : Math.max(0, Math.min(1, +m[4]));
		return mix(toHex([+m[1], +m[2], +m[3]]), over, a);
	}

	// Whether the Explorer holds focus — the signal for active vs. inactive selection.
	// `document.activeElement` inside the Explorer is the reliable indicator; the
	// list's `.focused` class isn't always present, which made selection look
	// permanently inactive (always darker).
	function explorerFocused(root) {
		var el = document.activeElement;
		if (el && el !== document.body && root.contains(el)) { return true; }
		var list = root.querySelector(".monaco-list");
		return !!(list && list.classList.contains("focused"));
	}

	// Where a row's text ends, in row coordinates: the far edge of the name plus any
	// description suffix. Measuring forces layout, so every row is read in one pass
	// before anything is painted (see paint). Null when the row shows no label.
	// Where a row's file-decoration badge sits, in row coordinates, or null when the
	// row carries none. The badge is rendered as `::after` on `.monaco-icon-label`,
	// so it occupies whatever lies between the name container's right edge and the
	// icon-label's own.
	function badgeBox(row, rowLeft) {
		var icon = row.querySelector(".monaco-icon-label.monaco-decoration-badge");
		if (!icon) { return null; }
		var container = icon.querySelector(".monaco-icon-label-container");
		if (!container) { return null; }
		var from = container.getBoundingClientRect().right;
		var to = icon.getBoundingClientRect().right;
		return to > from ? { from: from - rowLeft, to: to - rowLeft } : null;
	}

	function textEnd(row, rowLeft) {
		var els = row.querySelectorAll(".label-name, .label-description");
		var right = -Infinity;
		for (var i = 0; i < els.length; i++) {
			var r = els[i].getBoundingClientRect();
			if (r.width && r.right > right) { right = r.right; }
		}
		return right < 0 ? null : right - rowLeft;
	}

	// The `text` cover: one disc over every copy this row's text runs into.
	//
	// `spots` holds `x, y, size, opacity` quadruples in canvas space. A row shows the
	// canvas band `[phase, phase + height)`, so a copy is on screen here when its box
	// crosses that band — and, since the canvas repeats, so is the copy one canvas up
	// or down. Whether it is dimmed is decided per watermark, not per pixel: if the text
	// of any row the copy spans runs into its box, the whole copy is covered, so a
	// mark is never half under a name and half in the open. A copy straddling two
	// rows is one mark, so the furthest text of the rows it touches decides for all
	// of them and it dims consistently in each.
	//
	// The cover is the colour the row already shows, at `dim` of the copy's own
	// opacity — never more — so it can only ever take back what the watermark put
	// there, and cannot darken the row itself.
	function watermarkCover(watermark, phase, ends, badges, index, rowH, hex, dim) {
		var spots = watermark.spots;
		if (!spots || !spots.length || !(rowH > 0)) { return null; }
		var canvas = watermark.size;
		var images = [], sizes = [], repeats = [], positions = [], seen = {};
		for (var s = 0; s < spots.length; s += 4) {
			var gx = spots[s], gy = spots[s + 1], fs = spots[s + 2], op = spots[s + 3];
			var half = fs / 2;
			for (var wrap = -canvas; wrap <= canvas; wrap += canvas) {
				var top = gy + wrap - half - phase;
				var bottom = top + fs;
				if (bottom <= 0 || top >= rowH) { continue; }
				var first = index + Math.floor(top / rowH), last = index + Math.floor((bottom - 1) / rowH);
				var reach = -1, onBadge = false;
				for (var r = first; r <= last; r++) {
					var e = ends[r];
					if (e !== undefined && e !== null && e > reach) { reach = e; }
					// The status letter and the folder dot count as text too, and they sit
					// away to the right of it — so a copy out there is covered when it
					// overlaps one, not when it merely passes the name.
					var badge = badges[r];
					if (badge && gx + half >= badge.from && gx - half <= badge.to) { onBadge = true; }
				}
				if (!onBadge && (reach < 0 || gx - half > reach)) { continue; }
				// The pattern already carries its own copies across the canvas seam, and
				// the wrap above finds them a second time; one disc per mark, or they
				// stack and the cover doubles up right at the seam.
				var mark = Math.round(gx) + ":" + Math.round(top);
				if (seen[mark]) { continue; }
				seen[mark] = 1;
				images.push("radial-gradient(circle " + Math.round(half * 1.2) + "px at " +
					Math.round(gx) + "px " + Math.round(top + half) + "px, " +
					rgba(hex, Math.min(1, op * dim)) + " 55%, " + rgba(hex, 0) + " 100%)");
				sizes.push("100% 100%");
				repeats.push("no-repeat");
				positions.push("left top");
			}
		}
		if (!images.length) { return null; }
		return { image: images.join(", "), size: sizes.join(", "), repeat: repeats.join(", "), position: positions.join(", ") };
	}

	function paint(root) {
		var context = activeContext(root); // this window's workspace: colors + selection
		SEL = context.selection;           // read by everything below, and by overridden()

		// Is premium-explorer configured for the workspace in this window? If not (e.g.
		// a project with no rules), we paint nothing at all — including the selection
		// highlight — so other workspaces stay untouched. `fc-active` also gates the
		// selected-label CSS (see buildCss), which is otherwise global.
		var active = false;
		for (var _k in context.maps) {
			for (var _p in context.maps[_k]) { active = true; break; }
			if (active) { break; }
		}
		if (document.body) { document.body.classList.toggle("fc-active", active); }

		var focused = explorerFocused(root); // active vs. inactive selection styling
		var backdrop = backdropOf(root);     // what a translucent selection composites over
		// Read once per paint, not per row: only `selectedRenameStyle: "edge"` wants it.
		var accent = SEL.renameStyle === "edge" ? themeHex("--vscode-focusBorder") : "";
		// Git marks: the settings for this workspace, and the four status colours the
		// theme publishes, read once per paint. The decoration cache is dropped with
		// them, so a theme switch cannot leave a lifted colour behind.
		var GIT = SEL.git || null;
		var gitOn = !!GIT && GIT.style !== "bare";
		var gitPalette = {};
		if (gitOn) {
			for (var gv in GIT_VARS) { gitPalette[gv] = themeHex(GIT_VARS[gv]); }
		}
		var rows = Array.prototype.slice.call(root.querySelectorAll(".monaco-list-row"));
		// Sort by vertical position so we walk rows in tree order.
		rows.sort(function (a, b) { return (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0); });

		// Every measurement first, before a single style is written: reading a label's
		// box flushes layout, and interleaving that with the writes below would flush it
		// once per row instead of once per paint.
		var ends = [], heights = [], badges = [];
		for (var m = 0; m < rows.length; m++) {
			var box = rows[m].getBoundingClientRect();
			heights.push(box.height);
			ends.push(textEnd(rows[m], box.left));
			// Git's letter and the folder dot are text as far as the watermark is
			// concerned — a glyph that touches one drops like a glyph that touches a
			// name (§6). They are an `::after`, so their box is the gap between where
			// the name container ends and where the icon-label ends. Measured only on
			// rows that carry a badge, which are few.
			badges.push(badgeBox(rows[m], box.left));
		}

		// Which coloured folder owns each row, and the *blocks* they form: a block is
		// a folder's root row plus every rendered row inside it. Two things need the
		// block's whole extent rather than just its top — a background fill stretched
		// over the folder (`*BackgroundFillScale`, EM-92/EM-104) and block-scoped
		// corner rounding, where the top corners belong to the root row and the
		// bottom ones to the last row under it (EM-103). Neither is known until the
		// whole rendered slice has been walked, so the walk is its own pass, before
		// anything is painted.
		var repoOf = [], rootOf = [], blockOf = [], tops = [];
		var blocks = [];   // { top, level, first, last, height, closed }
		var stack = [];    // active repo subtrees: { level, repo, block }
		// The ancestor names of the row being walked, by depth: `segs[level - 1]` is the
		// name of the row's ancestor at that level. Rows arrive in tree order and the
		// list renders a *contiguous* slice of it, so a name can only be stale at a
		// level shallower than anything rendered so far — which is what `segsFrom`
		// tracks: the shallowest index the chain can be vouched for, 0 once a level-1
		// row has gone past. Together they give `folderAt()` the row's path.
		var segs = [], segsFrom = -1;
		for (var w = 0; w < rows.length; w++) {
			var wrow = rows[w];
			var wlevel = parseInt(wrow.getAttribute("aria-level") || "0", 10);
			while (stack.length && stack[stack.length - 1].level >= wlevel) {
				// A shallower row means this folder really ended here, so the block's
				// bottom is known. A block still open when the walk runs out of rendered
				// rows is *not* known to have ended — the folder may continue below the
				// viewport — and block rounding leaves its bottom corners square rather
				// than drawing a false end mid-folder.
				blocks[stack[stack.length - 1].block].closed = true;
				stack.pop();
			}

			var wname = rowName(wrow);
			if (wlevel > 0) {
				segs[wlevel - 1] = wname;
				if (segsFrom < 0 || wlevel - 1 < segsFrom) { segsFrom = wlevel - 1; }
			}
			// A folder is a colored root only where a rule actually put it, so a nested
			// `projects/gitops` no longer takes a top-level `gitops` rule's colors and
			// paints them over what it already inherits from its real parent.
			var wmatch = wlevel > 0 && isFolder(wrow) ? folderAt(context, segs, segsFrom, wlevel) : null;
			// The list positions rows absolutely in content space, so `top` is a
			// stable offset that survives scrolling — the anchor for the watermark.
			var wtop = parseFloat(wrow.style.top) || 0;
			tops.push(wtop);
			rootOf.push(!!wmatch);
			if (wmatch) {
				blocks.push({ top: wtop, level: wlevel, first: w, last: w, height: 0, closed: false });
				stack.push({ level: wlevel, repo: wmatch, block: blocks.length - 1 });
			}
			repoOf.push(stack.length ? stack[stack.length - 1].repo : null);
			blockOf.push(stack.length ? stack[stack.length - 1].block : -1);
			// Every block still open owns this row, not only the innermost one: a
			// nested rule's rows sit inside its parent's plate too, so the outer
			// block's extent has to reach past them.
			for (var s = 0; s < stack.length; s++) { blocks[stack[s].block].last = w; }
		}
		for (var b = 0; b < blocks.length; b++) {
			blocks[b].height = tops[blocks[b].last] + heights[blocks[b].last] - blocks[b].top;
		}

		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			var isRoot = rootOf[i];
			var repo = repoOf[i];
			var block = blockOf[i] >= 0 ? blocks[blockOf[i]] : null;
			var rowTop = tops[i];
			var blockTop = block ? block.top : rowTop;

			// The root row uses repo.root; everything inside uses repo.inner. Each part
			// carries five independent layers, so root and inner are painted separately.
			var part = repo ? (isRoot ? repo.root : repo.inner) : null;

			// Every row in a block shares one canvas origin — the top of the block's root
			// row — so a row shows the slice of the pattern that belongs at its depth.
			// Without this each row restarts the canvas and the whole block degenerates
			// into the same 22px sliver repeated down the tree. The text cover is anchored
			// to the same phase, so its discs land on the copies actually drawn here.
			var canvas = part && part.watermark.size ? part.watermark.size : 0;
			var phase = canvas ? (rowTop - blockTop) % canvas : 0;
			if (phase < 0) { phase += canvas; }

			// Renaming a file, and "New File/Folder", replace the label with an inline
			// input inside the row. Our label color is `!important`, which the input
			// inherits — and since `caret-color` follows `color`, that hides both the
			// typed text and the caret. `fc-editing` is what the generated CSS keys off
			// to stand down; the label-level paint below stands down with it.
			var editing = !!row.querySelector(".monaco-inputbox");
			row.classList.toggle("fc-editing", editing);

			// What the row shows right now with nothing selected: its own fill composited
			// over the theme, or the theme itself where the row has no fill of its own.
			// Every "a shade off what is already there" color — the shifted selection,
			// the rename fill, the watermark tint — is measured from this, so they all
			// land relative to the same thing the eye is comparing against.
			// A gradient fill cannot be composited as a color, so it ships its ground —
			// the color at the row's centre — in `background.ground` (see fill-spec).
			var rowShows = flatten(part && part.background.value
				? (part.background.ground || part.background.value) : backdrop, backdrop);

			// The accent the edge bar switches to while this row is being renamed, under
			// `selectedRenameStyle: "edge"`. The theme's own focus colour when it
			// publishes one, else whatever reads against the row.
			var renameAccent = editing && SEL.renameStyle === "edge"
				? (accent || contrast(rowShows)) : "";

			// Only the actually-selected row(s) — not a stale `.focused` row left behind
			// when focus moved to the editor — and only in a configured workspace.
			var selected = active && row.classList.contains("selected");
			// "shift" keeps the row's own color and lifts it a step, so the selection
			// reads as "this row, marked" instead of a foreign highlight; "invert" uses
			// the folder's own color at full strength; a hex applies to every row.
			// Focused: full color. Unfocused: darker, like VS Code's inactive selection.
			// A baked `selectedBackgroundFill` (SEL.fill) wins over all of those: its
			// variants carry opacity and the inactive darken already, and its base is
			// its ground composited over the backdrop — the color the eye actually sees.
			var F = SEL.fill || null;
			var shifting = !F && SEL.bg === "shift";
			var selBase = !selected ? null
				: F ? mix(focused ? F.ground : F.inactiveGround, backdrop, F.groundAlpha)
				: shifting ? lift(rowShows, part ? part.solid : "", focused ? SEL.shift : SEL.shift * 0.45)
				: SEL.bg === "invert" ? (part ? part.solid : null)
				: SEL.bg;
			var selFill = !selBase ? ""
				: F ? (focused ? F.value : F.inactive)
				// A shift is measured against what the row already shows, so painting it
				// back at partial alpha composites it over that very color and cancels
				// itself out. It carries its own strength instead, and dims by shifting
				// less while the Explorer is unfocused.
				: shifting ? selBase
				: focused ? rgba(selBase, SEL.opacity)
				: rgba(darken(selBase, SEL.inactiveDarken), SEL.opacity);
			// Does the selection take this style over? Only the styles named in
			// `selectedOverrides` change on a selected row; the rest keep painting as
			// they do unselected, so a selected row still shows which folder it is in.
			function taken(style) {
				return !!selFill && overridden(style);
			}
			var selText = selBase ? (SEL.text === "auto" ? contrast(selBase) : SEL.text) : "";
			// "auto" keeps the watermark a hair off whatever the row ends up painted —
			// the selection fill when it takes the background over, else the folder's
			// own. Its normal color is picked to read against the folder fill, so on a
			// bright selection it lands far too dark.
			var rowPaint = !selBase ? ""
				: !overridden("background") ? (part ? part.solid : selBase)
				// A fill's base is already composited over the backdrop; a shift is too.
				: (F || shifting) ? selBase
				: mix(selBase, backdrop, SEL.opacity);
			var selWatermark = selBase ? (SEL.watermark === "auto" ? nudge(rowPaint, rowPaint, SEL.watermarkContrast) : SEL.watermark) : "";
			// The unselected watermark's own tint, when no watermarkColor pinned it. It is
			// meant to read as the row's own color lifted a step — so it starts from the
			// folder's fill color rather than from the color the row composites to: a
			// fill carries an opacity, and at 8% over a dark theme what the row shows is
			// the theme, so shading *that* yields a grey mark with none of the folder's
			// color in it. Starting from the fill keeps the hue and lets the watermark's own
			// opacity do the muting. The step is then taken against what the row
			// actually shows, so the tint lifts clear of it whichever way that reads —
			// without it, an opaque fill would tint the watermark the row's exact color.
			var autoWatermark = part && part.watermark.auto
				? nudge(part.solid, rowShows, part.watermark.contrast)
				: "";

			var background = "";   // full-row fill
			// Stacked background images, tagged so the selection can take individual
			// ones over (see selectedOverrides). Edge bar first, so it paints over the
			// watermark; both paint over the row's background color.
			var layers = [];
			var labelBg = "";      // pill behind the label text
			var labelRadius = "";  // pill corner radii, as a ready border-radius value
			var labelPadding = ""; // ...and its padding, likewise ready to apply
			var labelLead = 0;     // ...and how far the row shifts to pay for that padding
			var corners = "";      // the row's own corner rounding
			var textColor = part ? part.text : "";
			var bold = part ? part.bold : false;
			var italic = part ? part.italic : false;
			var outline = "";
			var labelOutline = "";  // traced pill edge, only while selected

			// Composite every layer that's on. Each is independent: fill, striped edge,
			// tiled watermark and pill can all appear at once. Hover brightening is NOT
			// painted here: it travels as `--fc-bg-hover`/`--fc-pill-hover` custom
			// properties (see setHoverVars) and the generated CSS's `:hover` rules do
			// the swap — so a mouse move never costs a repaint (EM-85).
			var bgGradient = "";   // the row's fill when it is a gradient image
			var bgBlock = false;   // ...and whether it is stretched over the whole block
			var groundShows = ""; // the color standing in for that gradient when compositing
			if (part) {
				// What the row is filled with at this moment — its own fill, or the
				// selection when that takes the background over. The cover below has to
				// paint this exact color to stay invisible against it. A gradient fill
				// is a background *image* (the bottom of the stack, pushed last), so the
				// color slot stays empty and the ground stands in wherever a color is
				// composited.
				if (part.background.value) {
					if (part.background.ground) {
						bgGradient = part.background.value;
						groundShows = part.background.ground;
						bgBlock = part.background.scale === "block";
					} else { background = part.background.value; }
				}
				if (taken("background")) {
					// The selection is one row's mark, never a folder's plate, so its own
					// fill always paints per row however the folder's fill is scaled.
					if (F && F.image) { bgGradient = selFill; groundShows = selBase; background = ""; bgBlock = false; }
					else { background = selFill; bgGradient = ""; groundShows = ""; bgBlock = false; }
				}
				// The mark goes on first, so it paints over everything else on the row. It
				// sits just past where the text ends — which only the browser knows, so the
				// bake ships the stamp and the gap and the painter places it (EM-94). Not
				// while renaming: the label is replaced by an input and `textEnd()` then
				// measures a collapsed label, which would drop the mark into the box.
				// A mark outside the pill rides the row's own image stack, placed past
				// where the text ends — which only the browser knows. An *enclosed* one
				// (`inset > 0`, which the bake only sets when a pill and a mark are both
				// painted) goes on the label instead, see setLabelBg.
				if (part.mark.image && !part.mark.inset && !editing
					&& ends[i] !== null && ends[i] !== undefined) {
					layers.push({
						image: part.mark.image,
						size: part.mark.size + "px " + part.mark.size + "px",
						repeat: "no-repeat",
						position: Math.round(ends[i] + part.mark.gap) + "px center"
					});
				}
				if (part.edge.image) {
					layers.push({
						// The bar always keeps its own colours — selected, renaming and
						// hovered included. It is the narrowest mark on the row and the one
						// thing that says which folder the row belongs to; repainting it in
						// the selection colour spent it on saying "selected", which the fill
						// over the rest of the row already says, and a 3px stripe
						// brightening on hover was never legible enough to buy back the
						// whole-pane repaint it used to require.
						// ...with one opt-in, time-boxed exception: `selectedRenameStyle: "edge"`
						// switches the bar to the theme's focus accent for as long as the
						// inline rename box is open, because that is the one state where
						// marking *where the typing is* matters more than which folder the
						// row belongs to.
						image: editing && renameAccent
							? "linear-gradient(" + renameAccent + "," + renameAccent + ")"
							: part.edge.image,
						size: part.edge.width + "px 100%",
						repeat: "no-repeat",
						position: "left top"
					});
				}
				if (part.watermark.image) {
					// The text cover first, so it paints over the watermark it is dimming
					// and under the edge bar, which sits in pixels no label reaches.
					var discs = part.watermark.textDim > 0 && !editing
						? watermarkCover(part.watermark, phase, ends, badges, i, heights[i],
							flatten(background || groundShows || backdrop, backdrop),
							part.watermark.textDim)
						: null;
					if (discs) { layers.push(discs); }
					var wmTint = taken("watermarks") ? selWatermark : autoWatermark;
					layers.push({
						image: tintedWatermark(part.watermark, wmTint),
						// The URI runs to tens of KB; identity + tint pins it down just as
						// exactly, so setBgImage never has to compare the URI text itself.
						key: watermarkKey(part.watermark, wmTint),
						size: part.watermark.size + "px " + part.watermark.size + "px",
						repeat: "repeat",
						position: "left " + (-Math.round(phase * 100) / 100) + "px"
					});
				}
				if (part.pill.value) {
					labelBg = taken("pills") ? selFill : part.pill.value;
					labelRadius = cornersCss(part.pillRadius);
					// The bake already reconciled the two: `pillPadding`'s left value and
					// `pillLead` are the same number under `shift` and both zero under
					// `hug`, which is what keeps the text from moving either way.
					labelPadding = cornersCss(part.pillPadding);
					labelLead = part.pillLead || 0;
					// A pill the selection didn't take over keeps its own fill, so trace its
					// edge: an `invert` highlight paints the row in the same color as the
					// pill and would otherwise swallow it whole.
					if (selFill && !taken("pills")) { labelOutline = selText; }
				}
			}
			// Corner rounding. `radiusScale: "block"` (the default) rounds the folder's
			// rendered block as one plate — the root row takes the top corners, the last
			// row rendered under it the bottom ones, everything between stays square —
			// so a tall folder reads as one shape instead of a stack of rounded bars.
			// The outline then comes from the *root* part, since one plate has one
			// radius; `"row"` lets every row round its own box from its own part.
			if (part) {
				if (repo.radiusScale === "block" && block) {
					var plate = rowCorners(repo.root);
					var opens = i === block.first;
					var closes = block.closed && i === block.last;
					corners = cornersCss([
						opens ? plate[0] : 0, opens ? plate[1] : 0,
						closes ? plate[2] : 0, closes ? plate[3] : 0
					]);
				} else {
					corners = cornersCss(rowCorners(part));
				}
			}

			// The selection fill is not one of the folder's layers. A fixed colour — a
			// hex, a Fill, or a "shift" measured off the theme — applies to every
			// selected row in a configured workspace, rows outside any coloured folder
			// included, which is what "a hex applies the same colour everywhere" has
			// always promised. Inside a folder this is already done above, before the
			// watermark cover reads it. ("invert" has no colour without a folder, so it
			// leaves the row alone.)
			if (!part && taken("background")) {
				if (F && F.image) { bgGradient = selFill; groundShows = selBase; bgBlock = false; }
				else { background = selFill; }
			}

			// The gradient fill goes in last — the bottom of the stack, under the edge
			// bar, the cover and the watermark, exactly where the background color sits
			// for a solid fill. Not while renaming: the rename shift below paints a
			// lifted *color*, and the gradient image would sit on top of it — the
			// lifted ground stands in for the fill until the box closes.
			if (bgGradient && !editing) {
				// At-scale: one gradient stretched over the folder's rendered block, each
				// row showing the slice that belongs at its depth — the same anchoring the
				// watermark canvas uses. A 22px row leaves a diagonal only ~7% of its
				// colour change on the vertical axis, which is why diagonals were
				// indistinguishable from horizontal ones per row (EM-104). While the folder
				// is partly scrolled out the extent is whatever the walk can see, so the
				// fill's ends drift — accepted and documented (docs/fill-spec.md §2).
				var tall = bgBlock && block && block.height > 0;
				layers.push({
					image: bgGradient,
					size: tall ? "100% " + Math.round(block.height) + "px" : "100% 100%",
					repeat: "no-repeat",
					position: tall ? "left " + (-Math.round(rowTop - block.top)) + "px" : "left top"
				});
			}

			// Mark the rows we actually paint a selection on, so the generated CSS can
			// colour exactly those labels and no others. Without it the label rule fires
			// on every selected row in the workspace while the fill reaches only some —
			// which is how a black label ended up on the theme's own dark selection.
			row.classList.toggle("fc-sel", !!selFill);

			// The label colour the selection takes over, if it takes it over at all —
			// published below for the generated CSS to apply. `.fc-editing` keeps it off
			// a row being renamed, whose text is the input's.
			var selLabel = taken("text-color") ? selText : "";
			// The focus ring is its own setting, not one of the taken-over styles.
			if (selected && selFill && focused) { outline = selectionOutline(F ? selBase : ""); }

			// The row keeps its own fill, edge and watermark while the box is open:
			// blanking them punches a bare hole into the middle of the folder block, and
			// the input paints its own opaque background over them regardless. Only the
			// label-level paint goes — VS Code leaves `.label-name` in place collapsed to
			// `flex: 0`, so a pill on it surfaces as a stray blob beside the box, and the
			// row's focus ring would double up with the outline the input draws itself.
			if (editing) {
				labelBg = "";
				labelOutline = "";
				textColor = "";
				bold = false;
				italic = false;
				outline = "";
			}
			// A row being renamed drops back to its *unselected* fill, shifted a step, so
			// the edit registers as a change to the row itself rather than a box dropped
			// into it — and so you can still see which folder you are renaming in. It has
			// to be the unselected fill: a row being renamed is always selected, and with
			// `background` among the selected overrides, shifting what it currently shows
			// would shift the selection color instead — the same for every row, and it
			// says nothing about where you are. Rows with no fill of their own shift off
			// whatever sits behind them, so the edit still registers. The watermark and
			// edge bar are background *images*, so they paint over the shift and survive
			// it intact. `active` gates it like every other layer: in a workspace
			// premium-explorer has no rules for we paint nothing at all, rename included.
			var editFill = editing && active ? lift(rowShows, part ? part.solid : "", EDIT_SHIFT) : "";
			if (editFill) { background = editFill; }

			// Hover brightening, published for the generated CSS's `:hover` rules —
			// only where the fill/pill showing is the part's own. A selection or
			// rename fill never brightened under the cursor, and must not start to.
			var bgHover = part && part.background.hover && background === part.background.value
				? part.background.hover : "";
			var pillHover = part && part.pill.hover && labelBg === part.pill.value
				? part.pill.hover : "";

			// A pill the selection did not take over keeps its own text color too —
			// the selection's text color is measured against the selection fill, not
			// against the pill the label actually sits on (EM-89).
			var pillOwnFg = selLabel && labelBg && !taken("pills")
				? (textColor || "auto") : "";

			// Git marks (EM-96, design §6). VS Code picks the status colour against the
			// *theme's* background, so over a fill it can fall as low as 1.3:1. The
			// filename, the letter and the folder dot are each lifted to
			// `gitMarkContrast` against what the row actually shows, and the letter takes
			// a plate stepped off that same ground.
			//
			// `chip` applies to every row of a coloured folder, not only the rows that
			// paint a fill: with `innerBackgroundStyle: none` the children sit on the
			// theme's own ground, where three of Git's four hexes already pass and the
			// lift is simply a no-op — but deleted still fails at 3.3:1 and is lifted
			// even there (§6, "root x inner grounds"). Rows outside every coloured folder
			// keep exactly what VS Code painted.
			var gitMode = "", gitFg = "", gitPlate = "", gitBorder = "", gitDot = "";
			// Not while renaming: the label is an input then, and the block above has
			// already stood every label-level style down.
			if (gitOn && !editing) {
				var icon = row.querySelector(".monaco-icon-label");
				var token = icon ? decorationToken(icon) : "";
				if (token) {
					var over = flatten(background || groundShows || backdrop, backdrop);
					var status = decoStatus[token] || "";
					gitMode = GIT.style === "chip" && !part ? "bare" : GIT.style;
					// A badge that is only the symlink arrow is not a Git status at all, so
					// it takes `symlinkMarkColor` rather than a status lift, and no plate —
					// the design draws it as a bare right-aligned glyph (§7). On a selected
					// row it follows the selection's text colour, exactly like the letter.
					if (symlinkOnly(token) && gitMode !== "bare") {
						var link = GIT.symlink;
						gitMode = "ink";   // ink only: no plate, no border, no box
						gitFg = selFill && selText ? selText
							: link === "off" ? ""
								: link === "auto" ? (themeHex("--vscode-icon-foreground") || contrast(over))
									: link;
						gitBorder = "";
						gitPlate = "";
					} else {
					var gitHex = decorationHex(token, gitPalette);
					if (gitHex && gitMode !== "bare") {
						var want = function (key) { return gitSetting(GIT[key], status); };
						var resolve = function (value, fallbackOver) {
							return value === "auto" ? liftToContrast(gitHex, fallbackOver, GIT.contrast)
								: value === "off" ? "" : value;
						};
						// The lifted hue — a pale cast of the status colour over a dark row.
						// It is the letter's ink on an unpainted plate, and the plate itself
						// on a selected row, where the chip inverts to dark-on-light.
						var lifted = liftToContrast(gitHex, over, GIT.contrast);
						if (gitMode === "solid") {
							// The status colour becomes the plate, lifted until a knockout
							// letter reads out of it, and the letter is that knockout. The
							// handoff's "deleted lifts to #D25B45" is this rule, not a constant.
							var plateBase = want("background");
							gitPlate = plateBase === "auto"
								? liftToContrast(gitHex, contrast(gitHex), GIT.contrast)
								: plateBase === "off" ? "" : plateBase;
							var ink = want("color");
							gitFg = ink === "auto" ? contrast(gitPlate || gitHex) : ink === "off" ? "" : ink;
							var edge = want("border");
							gitBorder = edge === "auto" ? (gitPlate || gitHex) : edge === "off" ? "" : edge;
						} else if (gitMode === "chip") {
							var platePick = want("background");
							if (platePick !== "auto") {
								gitPlate = platePick === "off" ? "" : platePick;
								gitFg = resolve(want("color"), gitPlate || over);
							} else if (selFill) {
								// Selected: the chip inverts to dark-on-light and keeps its
								// border, so the letter stays legible on a bright selection
								// without borrowing the selection's own colour (§6).
								gitPlate = lifted;
								gitFg = contrast(lifted);
							} else {
								// Unselected: the plate is the row's own ground stepped off
								// itself, so the letter sits on something that still belongs to
								// this row, and the ink is the lifted status hue.
								gitPlate = nudge(over, over, 0.14);
								gitFg = resolve(want("color"), gitPlate);
							}
							// The border keeps Git's own hex: the plate says "a mark", the
							// border says *which* mark, at full saturation.
							var chipEdge = want("border");
							gitBorder = chipEdge === "auto" ? gitHex : chipEdge === "off" ? "" : chipEdge;
						} else if (gitMode === "outline") {
							gitFg = resolve(want("color"), over);
							var outlineEdge = want("border");
							gitBorder = outlineEdge === "auto" ? (gitFg || gitHex)
								: outlineEdge === "off" ? "" : outlineEdge;
						} else if (gitMode === "none") {
							gitFg = ""; gitPlate = ""; gitBorder = "";
						}
						gitDot = resolve(want("folderDot"), over);
						// The filename. **Selection is the one state that outranks Git**
						// (§6): on a selected row the ink goes to the selection's own text
						// colour and the status colour is dropped, because the plate and the
						// border still carry which status it is. Everywhere else the lifted
						// status colour wins over the folder's own `textColor`, since it is
						// the one carrying information.
						var labelPick = want("label");
						if (!selFill && labelPick !== "off" && gitMode !== "none") {
							var liftedLabel = resolve(labelPick, over);
							if (liftedLabel) { textColor = liftedLabel; }
						}
					}
					}
				}
			}

			setGitVars(row, gitMode === "bare" ? "" : gitMode, gitFg, gitPlate, gitBorder, gitDot);
			setSelLabel(row, selLabel, !!selFill && !!SEL.bold);
			setPillOwn(row, pillOwnFg);
			setEditVars(row, editFill, SEL.renameStyle === "field");
			// The enclosed mark, if there is one: anchored `trail` px in from the pill's
			// right edge, which is the space the bake reserved for it beyond the glyph.
			// Computed before the hover vars because hover has to preserve it (EM-117).
			var pillMark = part && part.mark.image && part.mark.inset && !editing
				? {
					image: part.mark.image,
					key: watermarkKey(part.mark, ""),
					size: part.mark.size,
					trail: Math.max(0, part.mark.inset - part.mark.gap - part.mark.size)
				}
				: null;
			setHoverVars(row, bgHover, pillHover, pillMark);
			setBg(row, background);
			setRadius(row, corners);
			setBgImage(row, layers);
			setLabelBg(row, labelBg, labelRadius, labelPadding, labelOutline, pillMark);
			setLabelLead(row, labelBg ? labelLead : 0);
			setOutline(row, outline);
			setText(row, textColor);
			setTextStyle(row, bold ? "bold" : "", italic ? "italic" : "");
			// The glow stands down while a row is being renamed: the rename box sits
			// where the label was, and a halo around the field reads as a focus ring.
			setGlow(row, part && !editing && part.glow && part.glow.style ? part.glow : null);
		}
	}

	var framePending = false;   // a paint is booked for the next animation frame
	var timerPending = false;   // a paint is booked after the cooldown below
	var lastPaint = 0;
	var lastCost = 0;           // how long the last paint took, in ms

	// The list recycles its rows as it scrolls: a row keeps the fill, edge bar and
	// pill we gave its previous occupant until we repaint it. So the pace to keep
	// is the one the list is redrawn at — one paint per animation frame — and
	// anything slower is measured in frames of somebody else's colours (EM-100,
	// EM-101).
	//
	// 2.1.7 instead held a fixed 80ms between paints, because a mutation storm
	// could otherwise queue a paint per frame for as long as the storm ran. That
	// brake is kept, but it now engages only while paints are actually expensive:
	// under BUDGET_MS (about half a 60fps frame) there is nothing to protect
	// against, and over it a workspace falls back to the old pace rather than
	// monopolising the main thread.
	var COOLDOWN_MS = 80;
	var BUDGET_MS = 8;

	function paintNow(root) {
		framePending = false;
		var started = (window.performance && performance.now) ? performance.now() : 0;
		paint(root);
		lastPaint = Date.now();
		lastCost = started ? performance.now() - started : lastCost;
	}

	function schedule(root) {
		if (framePending) { return; }     // already booked for this frame
		if (lastCost <= BUDGET_MS) {      // cheap: keep up with the list itself
			framePending = true;
			requestAnimationFrame(function () { paintNow(root); });
			return;
		}
		if (timerPending) { return; }     // expensive: at most one per cooldown
		timerPending = true;
		setTimeout(function () {
			timerPending = false;
			framePending = true;
			requestAnimationFrame(function () { paintNow(root); });
		}, Math.max(0, COOLDOWN_MS - (Date.now() - lastPaint)));
	}

	// The element a tree-change observer is currently attached to, so a
	// redundant attach() for the same root is a no-op.
	var attachedRoot = null;

	function attach(root) {
		if (attachedRoot === root) { return; }
		attachedRoot = root;

		// Repaint when the tree changes (scrolling recycles rows, expands,
		// decorations). Scoped to the Explorer's own root — never the whole
		// workbench, which would turn every unrelated list's churn, and the
		// editor's, into a full repaint (see waitForExplorer).
		new MutationObserver(function () { schedule(root); }).observe(root, {
			subtree: true, childList: true, attributes: true,
			attributeFilter: ["style", "class", "aria-label", "aria-level", "aria-expanded"]
		});

		// The Explorer view can be torn down and rebuilt — its pane collapsed
		// and reopened, or another sidebar view swapped in and back. Watch for
		// that and re-attach to whatever replaces it, instead of going stale
		// and never painting again.
		new MutationObserver(function (_mutations, observer) {
			if (document.body.contains(root)) { return; }
			observer.disconnect();
			attachedRoot = null;
			waitForExplorer();
		}).observe(document.body, { subtree: true, childList: true });

		// Scrolling recycles rows under us every frame, so repaint in step with it
		// instead of waiting on the mutation observer. A `scroll` event does not
		// bubble, hence the capture phase; it is passive because we never block
		// the scroll itself.
		root.addEventListener("scroll", function () { schedule(root); },
			{ capture: true, passive: true });

		// Hover needs no listener at all: the painter publishes `--fc-bg-hover`/
		// `--fc-pill-hover` up front and the generated CSS's `:hover` rules apply
		// them, so moving the mouse never schedules a repaint (EM-85).

		// Repaint when Explorer focus changes, to switch active/inactive selection.
		root.addEventListener("focusin", function () { schedule(root); });
		root.addEventListener("focusout", function () { schedule(root); });

		schedule(root);
	}

	// Wait for the Explorer to exist instead of falling back to the whole
	// workbench: a window that opens with another sidebar view visible (or
	// the sidebar hidden) would otherwise never switch back, and every
	// keystroke anywhere — not just in the Explorer — would trigger a full
	// `.monaco-list-row` scan and layout read across the entire workbench.
	function waitForExplorer() {
		var root = document.querySelector(".explorer-folders-view");
		if (root) { attach(root); return; }
		var waiter = new MutationObserver(function () {
			var found = document.querySelector(".explorer-folders-view");
			if (found) { waiter.disconnect(); attach(found); }
		});
		waiter.observe(document.body, { subtree: true, childList: true });
	}

	// The baked config is a separate file fetched fresh on every boot. It cannot
	// ride inside this script: the workbench references the injected files by a
	// fixed URL, so Chromium serves them from its cache on a window reload and
	// only a full app restart re-reads them from disk — settings changes looked
	// ignored (EM-86). This script and the CSS only change with the extension, so
	// caching them is fine; the part that changes per settings save is this JSON,
	// and `cache: "no-store"` makes every reload paint the current settings. The
	// relative URL resolves against workbench.html, which sits in the same
	// directory the extension mirrors all three files into; CSP-wise the fetch is
	// connect-src 'self', which the workbench already allows.
	function start() {
		fetch("./premium-explorer.json", { cache: "no-store" })
			.then(function (r) { return r.json(); })
			.then(function (config) {
				if (!config || !config.workspaces) { return; }
				WORKSPACES = config.workspaces;
				SELECTIONS = config.selections || {};
				FALLBACK_SEL = config.selection || { overrides: [] };
				SEL = FALLBACK_SEL;
				waitForExplorer();
			})
			// Missing/unreadable config (e.g. the extension updated the script but
			// has not generated yet) -> paint nothing; the next generate + reload
			// picks it up.
			.catch(function () {});
	}

	if (document.readyState === "complete") { start(); }
	else { window.addEventListener("load", start); }
})();
