// Bakes the example workspace (example/.vscode/settings.json) with the real
// generator and asserts what reaches the painter — one block of checks per
// feature group. Run `pnpm run compile-tests` first (needs out/), then:
//
//   node scripts/verify-example.js
//
// Exits non-zero on any failure.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'example');

// Route `require('vscode')` from the compiled extension code to the stub.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') { return path.join(__dirname, 'vscode-stub.js'); }
  return origResolve.call(this, request, ...rest);
};
process.env.PE_SETTINGS = path.join(EXAMPLE, '.vscode', 'settings.json');
process.env.PE_WS = EXAMPLE;

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-verify-'));
const uri = p => ({ fsPath: p });
const state = {};
const context = {
  extensionUri: uri(ROOT),
  globalStorageUri: uri(storage),
  extension: { packageJSON: { version: 'verify' } },
  globalState: {
    get: (k, d) => (k in state ? state[k] : d),
    update: async (k, v) => { state[k] = v; },
  },
  subscriptions: [],
};

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? ' — ' + detail : ''}`);
  if (!ok) { failures++; }
}

/** The CSS angle a baked gradient string carries. */
function angleOf(image) {
  const m = /^(?:repeating-)?linear-gradient\(([-\d.]+deg)/.exec(image || '');
  return m ? m[1] : '';
}
/** How many rgba() stops a baked gradient carries. */
function stopCount(image) {
  return ((image || '').match(/rgba\(/g) || []).length;
}
/** The SVG source inside a baked `url("data:image/svg+xml,...")` background. */
function svgOf(image) {
  const m = /^url\("data:image\/svg\+xml,([\s\S]*)"\)$/.exec(image || '');
  return m ? decodeURIComponent(m[1]) : '';
}
/** A baked watermark's copies as `{x, y, size, opacity}` objects. */
function spotsOf(watermark) {
  const out = [];
  const s = watermark.spots || [];
  for (let i = 0; i < s.length; i += 4) {
    out.push({ x: s[i], y: s[i + 1], size: s[i + 2], opacity: s[i + 3] });
  }
  return out;
}
/**
 * The named top-level functions of the painter, evaluated here so their maths can
 * be *measured* rather than grepped for. They sit at one tab inside the IIFE and
 * close on `\n\t}`, which nothing nested can match (a nested block closes deeper).
 */
function painterFns(js, names) {
  const src = names.map(name => {
    const m = new RegExp(`\\n\\tfunction ${name}\\([\\s\\S]*?\\n\\t\\}`).exec(js);
    if (!m) { throw new Error(`painter function ${name}() not found — did it move or get renamed?`); }
    return m[0];
  }).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}

/** Deep-equal for the small number arrays the radii bake into. */
function sameNumbers(got, want) {
  return Array.isArray(got) && got.length === want.length && want.every((n, i) => got[i] === n);
}

(async () => {
  const { readConfig } = require(path.join(ROOT, 'out/config.js'));
  const { writeBackgroundFiles } = require(path.join(ROOT, 'out/backgroundStyles.js'));

  await writeBackgroundFiles(context, readConfig());
  const js = fs.readFileSync(path.join(storage, 'premium-explorer.js'), 'utf8');
  const css = fs.readFileSync(path.join(storage, 'premium-explorer.css'), 'utf8');
  const baked = JSON.parse(fs.readFileSync(path.join(storage, 'premium-explorer.json'), 'utf8'));
  const ws = baked.workspaces[path.basename(EXAMPLE).toLowerCase()];
  const at = key => {
    const folder = ws[key];
    if (!folder) { throw new Error(`no baked folder for "${key}" — did a rule path change?`); }
    return folder;
  };

  // ---------- backgrounds: split and gradient, every direction ----------
  console.log('\n-- backgrounds (design 2.2-2.4) --');
  const solid = at('backgrounds/01-solid');
  check(solid.root.background.value === 'rgba(67, 99, 216, 0.55)'
    && solid.inner.background.value === 'rgba(67, 99, 216, 0.14)',
    'solid: root at .55, children at .14 (design opacities)',
    `${solid.root.background.value} / ${solid.inner.background.value}`);

  const dirs = {
    'backgrounds/02-split-vertical': '180deg',
    'backgrounds/03-split-horizontal': '90deg',
    'backgrounds/04-split-diagonal': '135deg',
  };
  for (const [key, deg] of Object.entries(dirs)) {
    const img = at(key).root.background.value;
    check(angleOf(img) === deg && /(\d|\.)+%\s+(\d|\.)+%/.test(img),
      `${key.split('/').pop()}: hard split at ${deg}`, img);
  }
  for (const [key, deg] of Object.entries({
    'backgrounds/05-gradient-horizontal': '90deg',
    'backgrounds/06-gradient-vertical': '180deg',
    'backgrounds/07-gradient-diagonal': '135deg',
  })) {
    const part = at(key);
    check(angleOf(part.root.background.value) === deg && stopCount(part.root.background.value) === 3,
      `${key.split('/').pop()}: 3-stop blend at ${deg}`, part.root.background.value);
    check(!!part.inner.background.ground && part.inner.background.value.startsWith('linear-gradient('),
      `${key.split('/').pop()}: children carry the gradient too, with a ground`);
  }

  // ---------- alpha gradients: the design's own 2.6 mocks ----------
  console.log('\n-- alpha gradients (design 2.6) --');
  const fadeIn = at('alpha-gradients/fade-in').root.background.value;
  check(fadeIn.includes('rgba(67, 99, 216, 0) 0%') && fadeIn.includes('rgba(67, 99, 216, 0) 15%')
    && fadeIn.includes('rgba(67, 99, 216, 0.85) 75%'),
    'fade-in: transparent to 15%, .85 by 75%', fadeIn);
  const fadeOut = at('alpha-gradients/fade-out').root.background.value;
  check(fadeOut.includes('rgba(230, 25, 75, 0.8) 0%') && fadeOut.includes('rgba(230, 25, 75, 0) 70%'),
    'fade-out: .8 at the left edge, gone by 70%', fadeOut);
  const island = at('alpha-gradients/island').root.background.value;
  check(stopCount(island) === 4 && island.includes('0.75) 40%') && island.includes('0.75) 60%'),
    'island: solid band across the middle only', island);
  const gap = at('alpha-gradients/transparent-gap').root.background.value;
  check(gap.includes('rgba(145, 30, 180, 0) 35%') && gap.includes('rgba(245, 130, 49, 0) 60%'),
    'transparent gap: both colours reach alpha 0 across the middle', gap);
  const d120 = at('alpha-gradients/diagonal-120').root.background.value;
  check(angleOf(d120) === '120deg' && stopCount(d120) === 4,
    'diagonal-120: a numeric angle is honoured verbatim', d120);
  const v180 = at('alpha-gradients/vertical-180').root.background.value;
  check(angleOf(v180) === '180deg' && v180.includes('rgba(201, 151, 0, 0.85) 0%'),
    'vertical-180: amber fading out downwards', v180);

  // ---------- rotation: named and numeric directions agree ----------
  console.log('\n-- rotation --');
  for (const [key, deg] of Object.entries({
    'rotation/deg-0': '0deg',
    'rotation/deg-45': '45deg',
    'rotation/deg-90': '90deg',
    'rotation/deg-120': '120deg',
    'rotation/deg-180': '180deg',
  })) {
    check(angleOf(at(key).root.background.value) === deg,
      `${key.split('/').pop()}: baked as ${deg}`, at(key).root.background.value);
  }
  check(angleOf(at('rotation/deg-90').root.background.value)
    === angleOf(at('backgrounds/05-gradient-horizontal').root.background.value),
    'numeric 90 and named "horizontal" bake the same angle');
  check(angleOf(at('rotation/deg-180').root.background.value)
    === angleOf(at('backgrounds/06-gradient-vertical').root.background.value),
    'numeric 180 and named "vertical" bake the same angle');

  // ---------- edge bar ----------
  console.log('\n-- edge bar (design 3) --');
  for (const [key, deg] of Object.entries({
    'edge-bar/bands-horizontal': '90deg',
    'edge-bar/bands-diagonal': '135deg',
    'edge-bar/bands-diagonal-reverse': '45deg',
  })) {
    const edge = at(key).root.edge;
    check(angleOf(edge.image) === deg && stopCount(edge.image) === 3 && edge.width === 6,
      `${key.split('/').pop()}: 3 bands at ${deg}, 6px wide`, edge.image.slice(0, 60));
  }
  const blended = at('edge-bar/blended-gradient').root.edge;
  check(stopCount(blended.image) === 4 && blended.image.includes('10px'),
    'blended-gradient: sequence loops back to the first colour, 10px band', blended.image.slice(0, 70));
  const single = at('edge-bar/single-colour').root.edge;
  check(stopCount(single.image) <= 2 && single.image.includes('rgba(0, 128, 128') && single.width === 3,
    'single-colour: collapses to a plain solid bar', single.image);
  check(!('hover' in blended), 'edge bakes no hover variant (kept from EM-85)');

  // ---------- pills ----------
  console.log('\n-- pills (design 8) --');
  check(at('pills/solid').root.pill.value === 'rgba(124, 77, 180, 0.55)',
    'solid pill is a plain colour, not a gradient', at('pills/solid').root.pill.value);
  const pFade = at('pills/fade-in').root.pill.value;
  check(pFade.includes('rgba(45, 180, 160, 0) 0%') && pFade.includes('rgba(45, 180, 160, 0.55) 70%'),
    'fade-in pill: 0 to .55 at 70%', pFade);
  const pMulti = at('pills/multi-stop').root.pill.value;
  check(stopCount(pMulti) === 3 && pMulti.includes('rgba(236, 72, 153, 0.6) 100%'),
    'multi-stop pill: violet fading in, then pink', pMulti);
  const pBoth = at('pills/both-ends').root.pill.value;
  check(stopCount(pBoth) === 4 && pBoth.includes('rgba(228, 161, 27, 0) 0%') && pBoth.includes('rgba(232, 89, 12, 0) 100%'),
    'both-ends pill: transparent at both ends', pBoth);
  check(sameNumbers(at('pills/radius-square').root.pillRadius, [0, 0, 0, 0])
    && sameNumbers(at('pills/radius-full').root.pillRadius, [9, 9, 9, 9]),
    'pill radius is per-rule (0 and 9), baked as four corners',
    JSON.stringify(at('pills/radius-full').root.pillRadius));
  const pHover = at('pills/fade-in').root.pill.hover;
  check(pHover.startsWith('linear-gradient(') && pHover !== pFade && /,\s*0\)/.test(pHover),
    'pill hover is a lifted gradient; alpha-0 stops stay invisible', pHover);

  // ---------- pill padding and enclosed marks (EM-109, EM-108) ----------
  console.log('\n-- pill padding and enclosed marks (EM-109, EM-108) --');
  check(sameNumbers(at('pills/solid').root.pillPadding, [0, 5, 0, 5]),
    'EM-109 the default padding is the shipped "0 5px", so nothing already set changes',
    JSON.stringify(at('pills/solid').root.pillPadding));
  const padded = at('pills/padded');
  check(sameNumbers(padded.root.pillPadding, [2, 10, 2, 10]) && sameNumbers(padded.inner.pillPadding, [0, 1, 0, 1]),
    'EM-109 [v, h] and the horizontal-only single number both parse',
    `${JSON.stringify(padded.root.pillPadding)} / ${JSON.stringify(padded.inner.pillPadding)}`);
  const inPill = at('marks/in-pill');
  // The pill grows by markGap + markSize + a 5px trail, and the mark carries that
  // same number so the painter can anchor it to the text rather than the padded box.
  check(inPill.root.mark.inset === 6 + 12 + 5 && sameNumbers(inPill.root.pillPadding, [0, 5 + 23, 0, 5]),
    'EM-108 the pill grows by exactly the space the mark needs',
    `${inPill.root.mark.inset} / ${JSON.stringify(inPill.root.pillPadding)}`);
  check(at('marks/icon').root.mark.inset === 0 && sameNumbers(at('marks/icon').root.pillPadding, [0, 5, 0, 5]),
    'EM-108 a mark with no pill is left exactly where it was (the flag is a no-op)');
  check(at('pills/padded').root.mark.inset === 0,
    'EM-108 a pill with no mark grows by nothing');
  // An enclosed mark has to be painted on the label, not on the row: the pill is a
  // background on `.label-name`, a child element, so it covers every background
  // image the row carries — the mark included, which simply vanished behind it.
  check(js.includes('part.mark.image && !part.mark.inset && !editing')
    && js.includes('setLabelBg(row, labelBg, labelRadius, labelPadding, labelOutline, pillMark)')
    && js.includes('trail: Math.max(0, part.mark.inset - part.mark.gap - part.mark.size)'),
    'EM-108 an enclosed mark is painted on the label, above the pill, not under it');
  check(js.includes('s.padding = value ? padding : ""') && !js.includes('"0 5px"'),
    'EM-109 the padding is baked, not hardcoded in the painter');

  // ---------- inner styles ----------
  console.log('\n-- inner styles --');
  const ownFill = at('inner-styles/own-fill');
  check(ownFill.root.background.value === 'rgba(145, 30, 180, 0.55)'
    && ownFill.inner.background.value.startsWith('linear-gradient(')
    && ownFill.inner.background.value.includes('rgba(0, 128, 128'),
    'own-fill: children carry a different fill from the root');
  const innerNone = at('inner-styles/none');
  check(innerNone.root.background.value !== '' && innerNone.inner.background.value === '',
    'none: root painted, children unpainted');
  const inherited = at('inner-styles/inherit/src');
  const parentInner = at('inner-styles/inherit').inner.background.value;
  check(inherited.root.background.value === parentInner && parentInner !== '',
    'inherit: a nested rule adopts the parent\'s resolved inner fill',
    `${inherited.root.background.value} vs ${parentInner}`);
  const pillEdge = at('inner-styles/pill-and-edge');
  check(pillEdge.inner.pill.value.startsWith('linear-gradient(') && pillEdge.inner.edge.image !== ''
    && pillEdge.inner.edge.width === 2,
    'pill-and-edge: children get their own pill fill and a 2px edge bar');

  // ---------- at-scale fills (EM-92 / EM-104) ----------
  console.log('\n-- at-scale fills (EM-92, EM-104) --');
  const blockDiag = at('at-scale/diagonal-block');
  check(blockDiag.root.background.scale === 'block' && blockDiag.inner.background.scale === 'block'
    && angleOf(blockDiag.root.background.value) === '135deg',
    'diagonal-block: the fill is marked for the folder\'s whole block, at 135deg',
    `${blockDiag.root.background.scale} / ${angleOf(blockDiag.root.background.value)}`);
  const rowDiag = at('at-scale/diagonal-row');
  check(rowDiag.root.background.scale === undefined && rowDiag.inner.background.scale === undefined
    && angleOf(rowDiag.root.background.value) === '135deg',
    'diagonal-row: an explicit "row" scale keeps the old per-row fill', rowDiag.root.background.scale);
  // EM-104: the reported bug is that a diagonal looks horizontal *by default*, so
  // the default has to be what fixes it — `auto` stretches anything with a vertical
  // component and leaves a purely horizontal fill exactly as it was.
  check(at('at-scale/vertical-block').root.background.scale === 'block',
    'auto: a vertical fill is stretched over the block without naming a scale');
  check(at('backgrounds/04-split-diagonal').root.background.scale === 'block'
    && at('backgrounds/06-gradient-vertical').root.background.scale === 'block',
    'EM-104 the folders the bug was reported against now stretch by default');
  check(at('backgrounds/05-gradient-horizontal').root.background.scale === undefined
    && at('rotation/deg-90').root.background.scale === undefined,
    'auto: a purely horizontal fill (named or 90deg) stays per-row');
  check(at('backgrounds/01-solid').root.background.scale === undefined,
    'a flat colour has no scale to carry');
  check(js.includes('bgBlock && block && block.height > 0') && js.includes('rowTop - block.top'),
    'EM-92 the painter sizes a block fill over the block and offsets each row\'s slice');

  // ---------- corner radii (EM-103) ----------
  console.log('\n-- corner radii (EM-103) --');
  const plate = at('radius/block-plate');
  check(sameNumbers(plate.root.backgroundRadius, [8, 8, 8, 8]) && plate.radiusScale === 'block',
    'block-plate: one radius for the folder, rounded around the block',
    `${JSON.stringify(plate.root.backgroundRadius)} / ${plate.radiusScale}`);
  const perRow = at('radius/per-row');
  check(perRow.radiusScale === 'row' && sameNumbers(perRow.root.backgroundRadius, [6, 6, 0, 0])
    && sameNumbers(perRow.inner.backgroundRadius, [4, 4, 4, 4]),
    'per-row: per-corner array and the string form both parse, per-rule scale honoured',
    `${JSON.stringify(perRow.root.backgroundRadius)} / ${JSON.stringify(perRow.inner.backgroundRadius)}`);
  const capsule = at('radius/edge-capsule');
  check(sameNumbers(capsule.root.edgeRadius, [3, 3, 3, 3]) && sameNumbers(capsule.inner.edgeRadius, [3, 3, 3, 3]),
    'edge-capsule: the edge bar takes a radius on both row kinds',
    JSON.stringify(capsule.inner.edgeRadius));
  // `inherit` reads the *enclosing* folder's inner part, so a nested rule is what
  // shows a radius travelling with the layer it inherits.
  const nestedBar = at('radius/edge-capsule/src');
  check(sameNumbers(nestedBar.root.edgeRadius, [3, 3, 3, 3])
    && nestedBar.root.edge.image === capsule.inner.edge.image,
    'an inherited edge bar brings the parent\'s radius with it',
    JSON.stringify(nestedBar.root.edgeRadius));
  const pillCorners = at('radius/pill-corners');
  check(sameNumbers(pillCorners.root.pillRadius, [9, 9, 0, 0]) && sameNumbers(pillCorners.inner.pillRadius, [0, 6, 0, 6]),
    'pill-corners: per-corner pills, and "0 6" fills in like the CSS shorthand',
    `${JSON.stringify(pillCorners.root.pillRadius)} / ${JSON.stringify(pillCorners.inner.pillRadius)}`);
  check(sameNumbers(at('backgrounds/01-solid').root.backgroundRadius, [0, 0, 0, 0]),
    'square is the default, so nothing already configured changes shape');
  check(js.includes('function cornersCss') && js.includes('row.style.borderRadius')
    && js.includes('block.closed && i === block.last'),
    'EM-103 the painter rounds the block and leaves a scrolled-out end square');

  // ---------- marks (EM-94) ----------
  console.log('\n-- marks (EM-94) --');
  const markIcon = at('marks/icon');
  const markSvg = svgOf(markIcon.root.mark.image);
  check(markSvg.startsWith('<svg') && markSvg.includes('<path') && markIcon.root.mark.size === 13
    && markIcon.inner.mark.image === '',
    'icon: a shipped glyph is stamped on the root row only, at the configured size',
    `${markIcon.root.mark.size} / inner "${markIcon.inner.mark.image}"`);
  check(!/ps-watermark/.test(markSvg) && !/opacity=/.test(markSvg),
    'icon: the mark is one plain stamp, not the tiled watermark pattern');
  // A one-colour icon that paints by inheriting a `fill` from its own root <svg>
  // renders black — invisible on a dark row — if that attribute is dropped with
  // the rest of the root element.
  const claudeMark = svgOf(at('marks/in-pill').root.mark.image);
  check(/<svg[^>]*fill='#D97757'/i.test(claudeMark),
    'an untinted mark keeps the fill its source declared on the root <svg>',
    claudeMark.slice(0, 80));
  const markChar = at('marks/character');
  const charSvg = svgOf(markChar.root.mark.image);
  check(charSvg.includes('<text') && charSvg.includes("fill='#ffe08a'") && charSvg.includes('\u2605')
    && markChar.root.mark.gap === 8,
    'character: a non-SVG mark is drawn as text in markColor', charSvg.slice(0, 120));
  const innerMark = at('marks/inner-mark');
  check(innerMark.root.mark.image !== '' && innerMark.inner.mark.image !== ''
    && innerMark.inner.mark.image !== innerMark.root.mark.image && innerMark.inner.mark.size === 10,
    'inner-mark: root and inner rows can carry different marks');
  check(at('backgrounds/01-solid').root.mark.image === '',
    'a folder that names no mark gets none (no inheriting a parent\'s logo)');
  check(js.includes('ends[i] + part.mark.gap'),
    'EM-94 the painter places the mark past where the row\'s text ends');

  // ---------- watermark layouts (EM-91) ----------
  console.log('\n-- watermark layouts (EM-91) --');
  // A pattern carries its own copies across the canvas seam, so a spot's recorded
  // position can sit one canvas out in either axis; compare it modulo the canvas.
  const wrapped = (v, canvas) => ((v % canvas) + canvas) % canvas;
  const rightEdge = spotsOf(at('watermark-layouts/right-edge').root.watermark);
  const rightCanvas = at('watermark-layouts/right-edge').root.watermark.size;
  const band = Math.min(rightCanvas, Math.max(18 * 2.5, rightCanvas * 0.22));
  check(rightEdge.length > 4 && rightEdge.every(s => wrapped(s.x, rightCanvas) >= rightCanvas - band - 1),
    'right-edge: every copy sits in the band at the right edge',
    `${rightEdge.length} copies, canvas ${rightCanvas}, band ${Math.round(band)}`);
  const oneRowWm = at('watermark-layouts/one-row').root.watermark;
  const oneRow = spotsOf(oneRowWm);
  const rowYs = new Set(oneRow.map(s => wrapped(s.y, oneRowWm.size)));
  const rowBand = Math.min(oneRowWm.size, Math.max(11 * 2.5, oneRowWm.size * 0.22));
  check(oneRow.length > 2 && rowYs.size === 1 && [...rowYs][0] <= 22
    && oneRow.every(s => wrapped(s.x, oneRowWm.size) >= oneRowWm.size - rowBand - 1),
    'one-row: one line of glyphs in the top band, kept to the right edge',
    `${oneRow.length} copies at y ${[...rowYs].join(',')}, canvas ${oneRowWm.size}`);
  const corner = spotsOf(at('watermark-layouts/corner').root.watermark);
  const cornerCanvas = at('watermark-layouts/corner').root.watermark.size;
  check(corner.length === 1 && corner[0].x > cornerCanvas * 0.5 && corner[0].y < cornerCanvas * 0.5,
    'corner: exactly one oversized badge in the top-right, never wrapped across the seam',
    JSON.stringify(corner));
  const mixed = svgOf(at('watermark-layouts/mixed-glyphs').root.watermark.image);
  check(/id='ps-watermark'/.test(mixed) && /id='ps-watermark1'/.test(mixed) && /id='ps-watermark2'/.test(mixed)
    && /href='#ps-watermark1'/.test(mixed) && /href='#ps-watermark2'/.test(mixed),
    'mixed-glyphs: three drawings in one canvas, and copies drawn from each');
  const dense = svgOf(at('watermark-layouts/dense').root.watermark.image);
  check(dense.includes('\u2726') && dense.includes('\u25c7') && spotsOf(at('watermark-layouts/dense').root.watermark).length > 20,
    'dense: both characters mixed across a small, crowded canvas',
    `${spotsOf(at('watermark-layouts/dense').root.watermark).length} copies`);
  check(at('watermark-layouts/full-dim').root.watermark.textDim === 0.93,
    'full-dim: watermarkDim 0.93 with dimStyle "text" is how "drops to 7%" is spelt',
    String(at('watermark-layouts/full-dim').root.watermark.textDim));
  // The clearing is a taper off the centre line, so the layouts that keep clear of
  // the names by construction are never thinned by it.
  check(rightEdge.every(s => s.opacity > 0) && corner.length === 1 && corner[0].opacity > 0
    && oneRow.every(s => s.opacity === oneRow[0].opacity),
    'a deliberately placed layout is never thinned or faded by the centre clearing');

  // ---------- selection and rename (EM-95) ----------
  console.log('\n-- selection and rename (EM-95) --');
  check(baked.selection.renameStyle === 'edge'
    && baked.selections[path.basename(EXAMPLE).toLowerCase()].renameStyle === 'edge',
    'selectedRenameStyle travels per workspace, not baked once globally',
    JSON.stringify(baked.selection.renameStyle));
  check(js.includes('SEL.renameStyle === "edge"') && js.includes('SEL.renameStyle === "field"')
    && js.includes('themeHex("--vscode-focusBorder")'),
    'EM-95 all three rename treatments are implemented in the painter');
  check(js.includes('1px solid " + darken(fillBase, 0.3)'),
    'EM-95 an "auto" border on a selection fill derives from the fill\'s own ground');

  // ---------- git marks (EM-96) ----------
  console.log('\n-- git marks (EM-96) --');
  check(baked.selection.git.style === 'chip' && baked.selection.git.contrast === 4.5
    && baked.selection.git.label === 'auto'
    && baked.selections[path.basename(EXAMPLE).toLowerCase()].git.style === 'chip',
    'the git settings travel per workspace, with every "auto" left for the painter',
    JSON.stringify(baked.selection.git));
  check(css.includes('.fc-git-ink .monaco-icon-label.monaco-decoration-text-badge::after')
    && css.includes('.monaco-decoration-badge:not(.monaco-decoration-text-badge)::after')
    && css.includes('--fc-git-plate') && css.includes('--fc-git-border'),
    'the letter and the folder dot are reached through their stable VS Code classes');
  check(css.includes('color: var(--fc-git-fg) !important')
    && /\.fc-git-off[\s\S]*?display: none !important/.test(css),
    'the letter\'s ink is forced over VS Code\'s own ::after rule, and "none" hides it');
  check(js.includes('GIT_VARS') && js.includes('decorationToken') && js.includes('scanDecorations')
    && js.includes('--vscode-gitDecoration-(\\w+?)Resource'),
    'EM-96 the status is read from VS Code\'s generated rule, not localized text');
  // Reading the colour back off the element is the trap: our own `::after` rule
  // paints the lifted colour, so the next paint would lift that again and every
  // mark would drift to white within a few frames.
  check(!js.includes('getComputedStyle(icon, "::after")') && !js.includes("getComputedStyle(icon, '::after')"),
    'EM-96 the lift never re-reads its own output off the element');
  // §6 "root x inner grounds": with `innerBackgroundStyle: none` the children sit
  // on the theme's own ground and still get chips — three of git's four hexes pass
  // there untouched and the lift is a no-op, but deleted fails even there. Rows
  // outside every coloured folder keep exactly what VS Code painted.
  check(js.includes('GIT.style === "chip" && !part ? "bare"'),
    'EM-96 chip covers every row of a coloured folder, not only the ones with a fill');
  // §6: "Selection is the one state that outranks git: the row's ink goes to
  // selectedTextColor and the status colour is dropped, since the plate and border
  // still carry the letter."
  check(js.includes('if (!selFill && labelPick !== "off"'),
    'EM-96 selection outranks git for the label, as the design specifies');
  check(js.includes('gitPlate = lifted;') && js.includes('gitFg = contrast(lifted);'),
    'EM-96 the chip inverts to dark-on-light on a selected row and keeps its border');
  check(js.includes('badges[r]') && js.includes('function badgeBox'),
    'EM-96 the watermark treats the status letter and the folder dot as text');

  // The lift is the whole point of the ticket, so measure it rather than grep it:
  // the hexes and the failing ratios below are the ones the ticket reported.
  const fns = painterFns(js, ['channels', 'toHex', 'luma', 'nudge', 'luminance', 'contrastRatio', 'liftToContrast']);
  const amber = '#8a6a30';           // what a .55 amber fill composites to on a dark theme
  const gitHexes = { modified: '#e2c08d', added: '#81b88b', untracked: '#73c991', deleted: '#c74e39' };
  let lifted = 0, bareFails = 0;
  const detail = [];
  for (const [status, hex] of Object.entries(gitHexes)) {
    const before = fns.contrastRatio(hex, amber);
    const after = fns.contrastRatio(fns.liftToContrast(hex, amber, 4.5), amber);
    if (before < 4.5) { bareFails++; }
    if (after >= 4.5) { lifted++; }
    detail.push(`${status} ${before.toFixed(2)}->${after.toFixed(2)}`);
  }
  check(bareFails === 4 && lifted === 4,
    'EM-96 all four statuses fail 4.5:1 bare over a fill and all four reach it lifted',
    detail.join(', '));
  check(fns.contrastRatio('#ffffff', '#000000') > 20.9 && fns.contrastRatio('#777777', '#777777') === 1,
    'the contrast ratio is WCAG\'s, not a luma difference');
  const already = fns.liftToContrast('#ffffff', '#101010', 4.5);
  check(already === '#ffffff', 'a colour that already reads is left exactly as Git painted it', already);

  // ---------- symlinks (EM-97) ----------
  console.log('\n-- symlinks (EM-97) --');
  const linked = at('symlink/linked');
  const linkTarget = at('symlink/target');
  check(linked.root.background.value === 'rgba(42, 157, 143, 0.3025)',
    'symlinkFolders "dim" halves the fill of a folder that is itself a symlink',
    linked.root.background.value);
  check(!/rgba\([^)]*\d{6,}\)/.test(JSON.stringify(baked)),
    'no float noise in a baked alpha (0.30250000000000005 and friends)');
  // VS Code already marks a symlink with a `⤷` in the file-decoration badge, so
  // the default is to colour *that* rather than stamp a second arrow beside it.
  check(linked.root.mark.image === '' && baked.selection.git.symlink === 'auto',
    'no second arrow by default; symlinkMarkColor rides the per-workspace git block',
    `${linked.root.mark.image} / ${baked.selection.git.symlink}`);
  check(linkTarget.root.mark.image === '' && linkTarget.root.background.value === 'rgba(201, 151, 0, 0.55)',
    'the real folder behind the link gets neither a mark nor the dimming');
  check(js.includes('SYMLINK_GLYPH') && js.includes('function symlinkOnly')
    && js.includes('decoContent'),
    'EM-97 the painter recognises an arrow-only badge from the rule\'s own content');
  check(js.includes('selFill && selText ? selText'),
    'EM-97 a selected row swaps the arrow for selectedTextColor, like the git letter');

  // ---------- regression ----------
  console.log('\n-- regression --');
  check(js.includes('FALLBACK_SEL') && !/\bconfig\.selection\b/.test(js.split('function start()')[0]),
    'the painter never reads an out-of-scope `config` (ReferenceError on an unconfigured workspace)');
  check(!js.includes('__premiumExplorerConfig')
    && js.includes('fetch("./premium-explorer.json", { cache: "no-store" })'),
    'EM-86 painter is static and fetches the config JSON with no-store');
  check(!js.includes('addEventListener("mouseover"')
    && css.includes('.fc-hover-bg:hover') && css.includes('.fc-hover-pill:hover'),
    'EM-85 hover is CSS-only');
  check(css.includes('.fc-sel-text.fc-pill-own .label-name'),
    'EM-89 selection text colour spares a kept pill');
  // EM-101: a label's change-tracking key has to live in the inline style it
  // guards, so a re-rendered label (which drops that style) is repainted rather
  // than skipped for ever.
  // `fcPillOwn` is a row-level marker for a row-level write, so it stays.
  check(js.includes('--fc-pill-key') && js.includes('--fc-text-key') && js.includes('--fc-ts-key')
    && !/dataset\.fcPill\b(?!Own)/.test(js) && !/dataset\.fcTextStyle\b/.test(js),
    'EM-101 label styles are keyed inside the style they guard, not on the row');
  // EM-100: keep up with the list frame by frame while paints are cheap, and
  // repaint on scroll rather than waiting out a fixed throttle.
  check(js.includes('lastCost <= BUDGET_MS') && js.includes('requestAnimationFrame'),
    'EM-100 cheap paints are scheduled per animation frame');
  check(js.includes('addEventListener("scroll"') && js.includes('passive: true'),
    'EM-100 scrolling schedules a repaint');
  const reg = at('regression/inner-none');
  check(reg.root.background.value !== '' && reg.inner.background.value === '',
    'EM-83 innerBackgroundStyle "none" leaves inner rows unpainted');
  const bare = at('regression/bare-rule');
  check(bare.root.background.value === '' && bare.root.edge.image === '' && bare.root.pill.value === '',
    'EM-87 a bare manual rule paints nothing');
  check(!ws['regression/not-ruled'], 'a folder no rule names is not baked at all');
  check(!js.includes('"defaultColor"'), 'EM-87 defaultColor absent from the generated config');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
  fs.rmSync(storage, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e.message || e); process.exit(2); });
