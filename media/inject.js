// premium-explorer — injected into the VS Code workbench by be5invis.vscode-custom-css.
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
// The per-workspace color maps and selection options are injected just above this
// script as `globalThis.__premiumExplorerConfig` by the extension (see backgroundStyles.ts).
(function () {
	"use strict";

	var config = (typeof globalThis !== "undefined" && globalThis.__premiumExplorerConfig) || null;
	if (!config || !config.workspaces) { return; }

	// The injected file is global (shared by every window), but colors are scoped
	// per workspace: WORKSPACES maps a workspace-folder name -> { folder name -> colors }.
	// We paint only the map(s) for the workspace shown in this window, so opening a
	// different workspace doesn't inherit another one's colors.
	var WORKSPACES = config.workspaces;  // wsName -> { name -> { root, inner } } (each part: background/edge/pill/text layers)
	var SEL = config.selection;          // { bg, text, opacity, border, inactiveDarken, overrides }
	var PAINT_TEXT = !!config.paintText; // true when the JS (not CSS) owns the selected text color
	var hovered = null;                  // the row element currently under the cursor

	// Which styles the selection color takes over. Only what is named here changes
	// on a selected row; everything else keeps painting exactly as it does
	// unselected, so ["edge"] recolors just the edge bar and leaves the rest.
	var OVERRIDES = SEL.overrides || [];
	// How far a row being renamed shifts off the color it would otherwise paint —
	// enough to register as a change, not enough to look like a different folder.
	var EDIT_SHIFT = 0.1;
	function overridden(layer) {
		return OVERRIDES.indexOf(layer) >= 0;
	}

	// The focus ring for a selected row while the Explorer is focused:
	//   "none" -> no ring; "auto" -> the theme's own focus-outline color; hex -> that color.
	function selectionOutline() {
		var b = SEL.border;
		if (!b || b === "none") { return ""; }
		if (b === "auto") { return "1px solid var(--vscode-list-focusOutline, var(--vscode-focusBorder, rgba(0, 0, 0, 0.4)))"; }
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

	// The colored folders for the workspace shown in this window, merged into one
	// `name -> colors` map. Two signals identify the current workspace:
	//   1. the Explorer pane header title (the folder name, for a single-folder window);
	//   2. any top-level (aria-level 1) folder row whose name is a workspace key
	//      (the roots of a multi-root workspace).
	function activeRepos(view) {
		var keys = {};
		var pane = view.closest ? view.closest(".pane") : null;
		var title = pane ? pane.querySelector(".pane-header .title") : null;
		if (title) { keys[title.textContent.trim().toLowerCase()] = true; }

		var roots = view.querySelectorAll('.monaco-list-row[aria-level="1"]');
		for (var i = 0; i < roots.length; i++) {
			var k = rowName(roots[i]).toLowerCase();
			if (WORKSPACES[k]) { keys[k] = true; }
		}

		var merged = {};
		for (var key in keys) {
			var map = WORKSPACES[key];
			if (map) { for (var name in map) { merged[name] = map[name]; } }
		}
		return merged;
	}

	function isFolder(row) {
		return !!row.querySelector(".folder-icon") || row.getAttribute("aria-expanded") !== null;
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

	function setText(row, value) {
		if ((row.dataset.fcText || "") === value) { return; }
		row.dataset.fcText = value;
		// Only recolor the name, not the whole label, so git badges keep their color.
		var names = row.querySelectorAll(".label-name");
		for (var i = 0; i < names.length; i++) { names[i].style.color = value; }
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
	function setEditVars(row, fill) {
		if ((row.dataset.fcEdit || "") === fill) { return; }
		row.dataset.fcEdit = fill;
		var vars = {
			"--fc-edit-fg": fill ? contrast(fill) : "",
			// The row itself has already shifted, so the field only has to get out of the
			// way and let it — and the watermark over it — show through. Left unset on a
			// row we don't paint, where the CSS falls back to the theme's own input color.
			"--fc-edit-field": fill ? "transparent" : "",
			"--fc-edit-border": fill ? wash(fill, 0.45) : ""
		};
		for (var name in vars) {
			if (vars[name]) { row.style.setProperty(name, vars[name]); }
			else { row.style.removeProperty(name); }
		}
	}

	// The stacked background images — edge bar, text cover, watermark — as one
	// set of comma-separated CSS lists. The FIRST entry paints on top, which is why
	// the stack is pushed in that order: the bar over the cover, the cover over the
	// watermark it dims, all of them over the row's background color.
	function setBgImage(row, layers) {
		var image = [], size = [], position = [], repeat = [];
		for (var i = 0; i < layers.length; i++) {
			image.push(layers[i].image);
			size.push(layers[i].size);
			position.push(layers[i].position);
			repeat.push(layers[i].repeat);
		}
		image = image.join(", "); size = size.join(", ");
		position = position.join(", "); repeat = repeat.join(", ");
		// The position carries the row's phase into the canvas, so it changes as rows
		// recycle even when the image does not — it has to be part of the key.
		var key = image + "|" + size + "|" + position + "|" + repeat;
		if ((row.dataset.fcImg || "") === key) { return; }
		row.dataset.fcImg = key;
		var s = row.style;
		s.backgroundImage = image;
		s.backgroundSize = size;
		s.backgroundPosition = position;
		s.backgroundRepeat = repeat;
	}

	// A rounded background behind just the label text, for the `pill` layer.
	// `outlineColor` traces the pill's edge; it is drawn as an inset outline rather
	// than a border so switching it on never reflows the label by a pixel.
	function setLabelBg(row, value, radius, outlineColor) {
		var key = value ? value + "|" + radius + "|" + (outlineColor || "") : "";
		if ((row.dataset.fcPill || "") === key) { return; }
		row.dataset.fcPill = key;
		var names = row.querySelectorAll(".label-name");
		for (var i = 0; i < names.length; i++) {
			var s = names[i].style;
			s.backgroundColor = value;
			s.borderRadius = value ? radius + "px" : "";
			s.padding = value ? "0 5px" : "";
			s.outline = value && outlineColor ? "1px solid " + outlineColor : "";
			s.outlineOffset = value && outlineColor ? "-1px" : "";
		}
	}

	// The label weight/style, for the `text` layer (bold/italic). Empty = theme default.
	function setTextStyle(row, weight, style) {
		var key = weight + "|" + style;
		if ((row.dataset.fcTextStyle || "") === key) { return; }
		row.dataset.fcTextStyle = key;
		var names = row.querySelectorAll(".label-name");
		for (var i = 0; i < names.length; i++) {
			names[i].style.fontWeight = weight;
			names[i].style.fontStyle = style;
		}
	}



	// `hex` stepped away from whatever it is going to sit on, by `amount` of the
	// distance to white or black: lighter over a dark backdrop, darker over a light
	// one. The direction comes from `over`, not from `hex` itself, so a dark tint on
	// a dark row lifts clear of it instead of sinking further in. Passing the same
	// color as both is the common case — "a shade just off this" — which is how the
	// selected watermark and the rename fill are picked.
	function nudge(hex, over, amount) {
		amount = +amount || 0; // tolerate missing/invalid -> the color itself
		var toward = luma(channels(over)) > 0.5 ? 0 : 255;
		return toHex(channels(hex).map(function (v) { return v + (toward - v) * amount; }));
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
	function backdropOf(el) {
		function hx(n) { return ("0" + (+n).toString(16)).slice(-2); }
		// VS Code declares its theme colors on the workbench element, not on :root, and
		// a stray environment may give us neither — so try both and never assume the
		// call answers at all.
		var hosts = [document.querySelector(".monaco-workbench"), document.documentElement, document.body];
		for (var h = 0; h < hosts.length; h++) {
			if (!hosts[h]) { continue; }
			var style = getComputedStyle(hosts[h]);
			var themed = style && style.getPropertyValue ? style.getPropertyValue("--vscode-sideBar-background") : "";
			if (themed && /^\s*#[0-9a-f]{6}\s*$/i.test(themed)) { return themed.trim().toLowerCase(); }
		}
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
	function watermarkCover(watermark, phase, ends, index, rowH, hex, dim) {
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
				var reach = -1;
				for (var r = first; r <= last; r++) {
					var e = ends[r];
					if (e !== undefined && e !== null && e > reach) { reach = e; }
				}
				if (reach < 0 || gx - half > reach) { continue; }   // the text never gets here
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
		var REPOS = activeRepos(root); // this window's workspace map (name -> colors)

		// Is premium-explorer configured for the workspace in this window? If not (e.g.
		// a project with no rules), we paint nothing at all — including the selection
		// highlight — so other workspaces stay untouched. `fc-active` also gates the
		// selected-label CSS (see buildCss), which is otherwise global.
		var active = false;
		for (var _k in REPOS) { active = true; break; }
		if (document.body) { document.body.classList.toggle("fc-active", active); }

		var focused = explorerFocused(root); // active vs. inactive selection styling
		var backdrop = backdropOf(root);     // what a translucent selection composites over
		var rows = Array.prototype.slice.call(root.querySelectorAll(".monaco-list-row"));
		// Sort by vertical position so we walk rows in tree order.
		rows.sort(function (a, b) { return (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0); });

		// Every measurement first, before a single style is written: reading a label's
		// box flushes layout, and interleaving that with the writes below would flush it
		// once per row instead of once per paint.
		var ends = [], heights = [];
		for (var m = 0; m < rows.length; m++) {
			var box = rows[m].getBoundingClientRect();
			heights.push(box.height);
			ends.push(textEnd(rows[m], box.left));
		}

		var stack = []; // active repo subtrees: { level, repo, top }
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			var level = parseInt(row.getAttribute("aria-level") || "0", 10);
			while (stack.length && stack[stack.length - 1].level >= level) { stack.pop(); }

			var name = rowName(row);
			var isRoot = isFolder(row) && !!REPOS[name];
			var repo = isRoot ? REPOS[name] : (stack.length ? stack[stack.length - 1].repo : null);
			// The list positions rows absolutely in content space, so `top` is a
			// stable offset that survives scrolling — the anchor for the watermark.
			var rowTop = parseFloat(row.style.top) || 0;
			if (isRoot) { stack.push({ level: level, repo: repo, top: rowTop }); }
			var blockTop = stack.length ? stack[stack.length - 1].top : rowTop;

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
			var rowShows = flatten(part && part.background.value ? part.background.value : backdrop, backdrop);

			// Only the actually-selected row(s) — not a stale `.focused` row left behind
			// when focus moved to the editor — and only in a configured workspace.
			var selected = active && row.classList.contains("selected");
			// "shift" keeps the row's own color and lifts it a step, so the selection
			// reads as "this row, marked" instead of a foreign highlight; "invert" uses
			// the folder's own color at full strength; a hex applies to every row.
			// Focused: full color. Unfocused: darker, like VS Code's inactive selection.
			var shifting = SEL.bg === "shift";
			var selBase = !selected ? null
				: shifting ? nudge(rowShows, rowShows, focused ? SEL.shift : SEL.shift * 0.45)
				: SEL.bg === "invert" ? (part ? part.solid : null)
				: SEL.bg;
			var selFill = !selBase ? ""
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
				: shifting ? selBase
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
			var labelRadius = 0;   // pill corner radius
			var textColor = part ? part.text : "";
			var bold = part ? part.bold : false;
			var italic = part ? part.italic : false;
			var outline = "";
			var labelOutline = "";  // traced pill edge, only while selected

			// Composite every layer that's on. Each is independent: fill, striped edge,
			// tiled watermark and pill can all appear at once. Hover brightens them.
			if (part) {
				var hover = row === hovered;
				// What the row is filled with at this moment — its own fill, brightened on
				// hover, or the selection when that takes the background over. The cover
				// below has to paint this exact color to stay invisible against it.
				if (part.background.value) { background = hover && part.background.hover ? part.background.hover : part.background.value; }
				if (taken("background")) { background = selFill; }
				if (part.edge.image) {
					layers.push({
						// A taken-over edge is repainted flat in the selection color rather
						// than removed, so the bar still marks the row.
						image: taken("edge")
							? "linear-gradient(" + selFill + "," + selFill + ")"
							: (hover && part.edge.hover ? part.edge.hover : part.edge.image),
						size: part.edge.width + "px 100%",
						repeat: "no-repeat",
						position: "left top"
					});
				}
				if (part.watermark.image) {
					// The text cover first, so it paints over the watermark it is dimming
					// and under the edge bar, which sits in pixels no label reaches.
					var discs = part.watermark.textDim > 0 && !editing
						? watermarkCover(part.watermark, phase, ends, i, heights[i],
							flatten(background || backdrop, backdrop), part.watermark.textDim)
						: null;
					if (discs) { layers.push(discs); }
					layers.push({
						image: tintedWatermark(part.watermark, taken("watermarks") ? selWatermark : autoWatermark),
						size: part.watermark.size + "px " + part.watermark.size + "px",
						repeat: "repeat",
						position: "left " + (-Math.round(phase * 100) / 100) + "px"
					});
				}
				if (part.pill.value) {
					labelBg = taken("pills")
						? selFill
						: (hover && part.pill.hover ? part.pill.hover : part.pill.value);
					labelRadius = part.pillRadius;
					// A pill the selection didn't take over keeps its own fill, so trace its
					// edge: an `invert` highlight paints the row in the same color as the
					// pill and would otherwise swallow it whole.
					if (selFill && !taken("pills")) { labelOutline = selText; }
				}
			}

			// The JS owns selected text only when CSS can't (invert + auto); otherwise
			// the generated CSS carries it, and is emitted only when it is taken over.
			if (taken("text-color") && PAINT_TEXT) { textColor = selText; }
			// The focus ring is its own setting, not one of the taken-over styles.
			if (selected && selFill && focused) { outline = selectionOutline(); }

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
			var editFill = editing && active ? nudge(rowShows, rowShows, EDIT_SHIFT) : "";
			if (editFill) { background = editFill; }

			setEditVars(row, editFill);
			setBg(row, background);
			setBgImage(row, layers);
			setLabelBg(row, labelBg, labelRadius, labelOutline);
			setOutline(row, outline);
			setText(row, textColor);
			setTextStyle(row, bold ? "bold" : "", italic ? "italic" : "");
		}
	}

	var scheduled = false;
	function schedule(root) {
		if (scheduled) { return; }
		scheduled = true;
		requestAnimationFrame(function () { scheduled = false; paint(root); });
	}

	function start() {
		var root = document.querySelector(".explorer-folders-view") || document.querySelector(".monaco-workbench");
		if (!root) { setTimeout(start, 500); return; }

		// Repaint when the tree changes (scrolling recycles rows, expands, decorations).
		new MutationObserver(function () { schedule(root); }).observe(root, {
			subtree: true, childList: true, attributes: true,
			attributeFilter: ["style", "class", "aria-label", "aria-level", "aria-expanded"]
		});

		// Track the hovered row so we can paint a lighter shade of its repo color.
		root.addEventListener("mouseover", function (e) {
			var row = e.target && e.target.closest ? e.target.closest(".monaco-list-row") : null;
			if (row !== hovered) { hovered = row; schedule(root); }
		});
		root.addEventListener("mouseleave", function () {
			if (hovered) { hovered = null; schedule(root); }
		});

		// Repaint when Explorer focus changes, to switch active/inactive selection.
		root.addEventListener("focusin", function () { schedule(root); });
		root.addEventListener("focusout", function () { schedule(root); });

		schedule(root);
	}

	if (document.readyState === "complete") { start(); }
	else { window.addEventListener("load", start); }
})();
