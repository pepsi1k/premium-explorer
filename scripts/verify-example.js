// Bakes the example workspace (example/.vscode/settings.json) with the real
// generator and asserts what reaches the painter — one block of checks per
// feature. Run `pnpm run compile-tests` first (needs out/), then:
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

(async () => {
  const { readConfig } = require(path.join(ROOT, 'out/config.js'));
  const { writeBackgroundFiles } = require(path.join(ROOT, 'out/backgroundStyles.js'));

  await writeBackgroundFiles(context, readConfig());
  const js = fs.readFileSync(path.join(storage, 'premium-explorer.js'), 'utf8');
  const css = fs.readFileSync(path.join(storage, 'premium-explorer.css'), 'utf8');
  const baked = JSON.parse(fs.readFileSync(path.join(storage, 'premium-explorer.json'), 'utf8'));
  const ws = baked.workspaces[path.basename(EXAMPLE).toLowerCase()];
  const root = name => ws[name].root;

  // ---------- EM-90: the shared Fill (parseFill/resolveFill) ----------
  console.log('\n-- EM-90: shared Fill foundation --');
  const solid = root('fill-string-solid').background;
  check(solid.value.startsWith('rgba(48, 92, 85') && !solid.ground,
    'EM-90 string fill collapses to a solid color (no gradient, no ground)', solid.value);
  const grad = root('fill-gradient-bg').background;
  check(grad.value.startsWith('linear-gradient('),
    'EM-90 stop-list fill bakes a linear-gradient image', grad.value.slice(0, 40));
  check(!!grad.ground && grad.ground.startsWith('rgba('),
    'EM-90 gradient fill ships its ground for compositing', grad.ground);
  check(root('fill-gradient-bg').solid === root('fill-gradient-bg').solid.toLowerCase()
    && /^#[0-9a-f]{6}$/.test(root('fill-gradient-bg').solid),
    'EM-90 part.solid is the fill ground hex (centre sample)', root('fill-gradient-bg').solid);
  check(root('fill-numeric-direction').background.value === grad.value,
    'EM-90 direction: 90 is identical to direction: "horizontal"');
  const split = root('fill-split-blend').background.value;
  check(/50%.*50%/.test(split),
    'EM-90 split blend bakes hard stops (shared 50% boundary)', split);
  // The default rootBackgroundOpacity (0.5) multiplies on top of every stop's
  // own alpha — docs/fill-spec.md §1, "Alpha-0 stops stay invisible...".
  const wins = root('fill-wins-over-color').background.value;
  check(wins.startsWith('rgba(0, 255, 0') && !wins.startsWith('rgba(255, 0, 0'),
    'EM-90 *Fill wins over the legacy *Color', wins);
  check(wins.includes('0.251'),
    'EM-90 #rrggbbaa alpha x layer opacity (0.502 x 0.5 = 0.251)', wins);
  const mult = root('fill-hex-alpha-multiply').background.value;
  check(mult.includes('0.1255'),
    'EM-90 hex alpha x alpha field x layer opacity (0.502 x 0.5 x 0.5 = 0.1255)', mult);

  // ---------- EM-93: edge bar direction + blend ----------
  console.log('\n-- EM-93: edge bar direction/blend --');
  const hb = root('edge-horizontal-bands').edge;
  check(hb.image.startsWith('repeating-linear-gradient(90deg'),
    'EM-93 horizontal direction bakes a 90deg stripe', hb.image.slice(0, 44));
  check((hb.image.match(/rgba\(/g) || []).length >= 3 && hb.width === 6,
    'EM-93 three bands at the configured 6px width');
  const dg = root('edge-diagonal-gradient').edge;
  check(dg.image.startsWith('repeating-linear-gradient(135deg'),
    'EM-93 diagonal direction bakes a 135deg stripe', dg.image.slice(0, 44));
  check((dg.image.match(/rgba\(/g) || []).length === 4,
    'EM-93 gradient blend loops back to the first color (3 colors -> 4 stops)', dg.image);
  check(dg.image.includes('8px') || dg.image.includes(' 8'),
    'EM-93 edgeStripeSize still controls band thickness', dg.image);
  const oc = root('edge-one-color').edge;
  check((oc.image.match(/rgba\(/g) || []).length <= 2 && oc.image.includes('rgba(228, 179, 99'),
    'EM-93 a single color still collapses to a solid bar', oc.image);
  check(!('hover' in hb), 'EM-93 edge still bakes no hover variant');

  // ---------- EM-98: pill fills ----------
  console.log('\n-- EM-98: pill background fills --');
  const ps = root('pill-solid').pill;
  check(ps.value === 'rgba(124, 77, 180, 0.55)',
    'EM-98 one-stop pill fill is a plain color at its alpha', ps.value);
  const pf = root('pill-fade-in').pill;
  check(pf.value.startsWith('linear-gradient(')
    && pf.value.includes('rgba(20, 184, 166, 0)')
    && pf.value.includes('rgba(20, 184, 166, 0.55) 70%'),
    'EM-98 fade-in pill: alpha 0 -> 0.55 at 70%', pf.value);
  const pm = root('pill-multi-stop').pill;
  check((pm.value.match(/rgba\(/g) || []).length === 3 && pm.value.includes('45%') && pm.value.includes('100%'),
    'EM-98 multi-stop pill: violet 0 -> .5@45 -> pink .6@100', pm.value);
  const pb = root('pill-fade-both').pill;
  check((pb.value.match(/rgba\(/g) || []).length === 4
    && pb.value.includes('rgba(228, 161, 27, 0)') && pb.value.includes('rgba(232, 89, 12, 0)'),
    'EM-98 fade-both pill: transparent at both ends', pb.value);
  check(pf.hover.startsWith('linear-gradient(') && pf.hover !== pf.value
    && pf.hover.includes('rgba(') && /,\s*0\)/.test(pf.hover),
    'EM-98 pill hover is a lifted gradient; alpha-0 stops stay invisible', pf.hover);

  // ---------- Regression: shipped behavior stays put ----------
  console.log('\n-- Regression --');
  check(!js.includes('__premiumExplorerConfig')
    && js.includes('fetch("./premium-explorer.json", { cache: "no-store" })'),
    'EM-86 painter is static and fetches the config JSON with no-store');
  check(!js.includes('addEventListener("mouseover"')
    && css.includes('.fc-hover-bg:hover') && css.includes('.fc-hover-pill:hover'),
    'EM-85 hover is CSS-only');
  check(css.includes('.fc-sel-text.fc-pill-own .label-name'),
    'EM-89 selection text color spares a kept pill');
  const reg = ws['regression-inner-none'];
  check(reg.root.background.value !== '' && reg.inner.background.value === '',
    'EM-83 innerBackgroundStyle "none" leaves inner rows unpainted');
  const bare = ws['regression-bare-rule'];
  check(bare.root.background.value === '' && bare.root.edge.image === '' && bare.root.pill.value === '',
    'EM-87 a bare manual rule paints nothing');
  check(!js.includes('"defaultColor"'), 'EM-87 defaultColor absent from the generated config');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
  fs.rmSync(storage, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
