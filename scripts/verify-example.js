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
  check(at('pills/radius-square').root.pillRadius === 0 && at('pills/radius-full').root.pillRadius === 9,
    'pill radius is per-rule (0 and 9)');
  const pHover = at('pills/fade-in').root.pill.hover;
  check(pHover.startsWith('linear-gradient(') && pHover !== pFade && /,\s*0\)/.test(pHover),
    'pill hover is a lifted gradient; alpha-0 stops stay invisible', pHover);

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

  // ---------- regression ----------
  console.log('\n-- regression --');
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
