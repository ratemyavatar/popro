// Build: node build.js <extracted-ropro-dir> <out.user.js>
// Needs esbuild + acorn resolvable (NODE_PATH or local node_modules).
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const esbuild = require('esbuild');

const SRC = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
// Your RoPro-compatible API server (ropro-rokori-api), e.g. https://ropro.example.com
const API_BASE = String(process.argv[4] || process.env.ROPRO_API_BASE || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(API_BASE)) { console.error('usage: node build.js <ropro-dir> <out.user.js> https://your-api-domain'); process.exit(1); }
const API_HOST = new URL(API_BASE).host;
const rd = (p) => fs.readFileSync(path.join(SRC, p.replace(/^\//, '')), 'utf8');
const exists = (p) => fs.existsSync(path.join(SRC, p.replace(/^\//, '')));
const norm = (p) => p.replace(/^\.?\//, '').replace(/^\/+/, '');
const manifest = JSON.parse(rd('manifest.json'));

/* ---------- source patching ---------- */
function patchJs(code) {
  return code
    // any roblox.com URL (incl. API subdomains) -> rokori, which serves every API path on www
    .replace(/https?:\/\/(?:[a-z0-9-]+\.)*roblox\.com(?![a-z0-9-])/gi, 'https://www.rokori.com')
    .replace(/(["'`])www\.roblox\.com\1/g, '$1www.rokori.com$1')
    .replace(/(["'`])roblox\.com\1/g, '$1rokori.com$1')
    .replace(/(["'`])\.roblox\.com\1/g, '$1.rokori.com$1')
    .replace(/(["'`])\*:\/\/\*\.roblox\.com/g, '$1*://*.rokori.com')
    // RoPro's API -> your server (other ropro.io hosts serve static images/theme frames and stay as-is)
    .replace(/https:\/\/api\.ropro\.io/g, API_BASE)
    .replace(/(["'`])api\.ropro\.io\1/g, '$1' + API_HOST + '$1');
}

/* ---------- assets ---------- */
const MIME = { png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2', eot: 'application/vnd.ms-fontobject', otf: 'font/otf' };
function dataUri(rel) {
  const ext = rel.split('.').pop().toLowerCase();
  const buf = fs.readFileSync(path.join(SRC, rel));
  return `data:${MIME[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
}
function walk(dir) {
  const out = []; const abs = path.join(SRC, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel)); else out.push(rel);
  }
  return out;
}
const ASSETS = {};
for (const f of [...walk('images'), ...walk('fonts')]) if (MIME[f.split('.').pop().toLowerCase()]) ASSETS[f] = dataUri(f);
for (const f of ['icon.png', 'icon16.png', 'icon48.png', 'icon128.png', 'logo.png']) if (exists(f)) ASSETS[f] = dataUri(f);

const TEXT = {};
for (const f of ['locales/_manifest.json', 'locales/en.json', '_locales/en/messages.json', 'featureCatalog.json']) if (exists(f)) TEXT[f] = rd(f);

/* ---------- CSS ---------- */
const CSS = {};
function loadCss(rel) {
  rel = norm(rel);
  if (CSS[rel] != null || !exists(rel)) return;
  const dir = path.posix.dirname(rel);
  CSS[rel] = rd(rel).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, q, u) => {
    if (/^(data:|https?:|#)/.test(u)) return m;
    let target = u.replace(/^chrome-extension:\/\/(__MSG_@@extension_id__|[a-p]{32})\//, '/');
    const clean = target.split(/[?#]/)[0];
    const resolved = clean.startsWith('/') ? norm(clean) : path.posix.normalize(path.posix.join(dir, clean));
    if (!exists(resolved)) return m;
    if (!ASSETS[resolved]) ASSETS[resolved] = dataUri(resolved);
    const frag = target.includes('#') ? '#' + target.split('#')[1] : '';
    return `url("${ASSETS[resolved]}${frag}")`;
  });
}

/* ---------- content units ---------- */
const UNITS = {};
function topLevelNames(code, file) {
  let ast; try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); } catch (e) { throw new Error(file + ': ' + e.message); }
  const names = {}; // name -> writable?
  const addPat = (p, w) => {
    if (!p) return;
    if (p.type === 'Identifier') names[p.name] = w;
    else if (p.type === 'ObjectPattern') p.properties.forEach((pr) => addPat(pr.type === 'RestElement' ? pr.argument : pr.value, w));
    else if (p.type === 'ArrayPattern') p.elements.forEach((el) => addPat(el, w));
    else if (p.type === 'AssignmentPattern') addPat(p.left, w);
    else if (p.type === 'RestElement') addPat(p.argument, w);
  };
  for (const n of ast.body) {
    if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => addPat(d.id, n.kind !== 'const'));
    else if (n.type === 'FunctionDeclaration' && n.id) names[n.id.name] = true;
    else if (n.type === 'ClassDeclaration' && n.id) names[n.id.name] = false;
  }
  return names;
}
function makeUnit(file, code) {
  const names = topLevelNames(code, file);
  const binds = Object.entries(names).map(([n, w]) =>
    `${JSON.stringify(n)}:[function(){return ${n}}${w ? `,function(v){${n}=v}` : ''}]`).join(',');
  return `function(__p,__bind){with(__p){return function(){void 0;\n__bind({${binds}});\n${code}\n};}}`;
}
// Per-file source patches for things that only existed on RoPro's servers
const BIO_VERIFY = `
;/* rokori: verification is done with a phrase in your bio instead of RoPro's in-game check */
function roproVerificationModal() { rokoriBioVerify() }
`;
// No paid tiers in this port: upgrade prompts do nothing (paid features stay locked and are hidden).
const NO_UPSELL = `
;/* rokori: no paid tiers here, so upgrade prompts are disabled */
if (window.RoProUpgradeModal) { window.RoProUpgradeModal.open = function () { return null } }
`;
const NO_UPSELL_ADAPTER = `
;/* rokori: no paid tiers here, so upgrade prompts are disabled */
if (window.roproApiAdapter) { window.roproApiAdapter.openUpgradeModalForVisualGate = function () { return false } }
`;
const FILE_PATCHES = {
  '/js/shared/roproUpgradeModal.js': (c) => c + NO_UPSELL,
  '/js/shared/roproApiAdapter.js': (c) => c + NO_UPSELL_ADAPTER,
  '/js/page/home/verificationModal.js': (c) => c + BIO_VERIFY,
  '/js/page/options/api-and-verification.js': (c) => c + BIO_VERIFY,
  '/js/page/gamePage/10-features.js': (c) => {
    const a = 'playTimeText.target = "_blank"';
    if (!c.includes(a)) throw new Error('gamePage verify hook not found');
    return c.split(a).join('playTimeText.target = "_self"; playTimeText.onclick = function (e) { e.preventDefault(); rokoriBioVerify() }');
  },
  '/js/page/sandbox/html-template.js': (c) => c.split('https://ropro.io/render/?load').join('about:blank'),
  '/js/page/sandbox/wearing.js': (c) => c + `
;/* rokori: show renders with rokori's own 2D/3D renderers instead of the ropro.io/render iframe */
function buildSandboxRenderUrl(rawRenderUrl, backgroundValue) { return roproRokoriView(rawRenderUrl, backgroundValue) }
function resolveSandboxRenderUrl(rawRenderUrl, backgroundValue) { return roproRokoriView(rawRenderUrl, backgroundValue) }
`,
};
function addUnit(file) {
  file = '/' + norm(file);
  if (UNITS[file]) return;
  let code = patchJs(rd(file));
  if (FILE_PATCHES[file]) code = FILE_PATCHES[file](code);
  UNITS[file] = makeUnit(file, code);
}

/* ---------- groups ---------- */
function globToRegex(pattern) {
  // *://*.roblox.com/<path>  ->  ^https://www\.rokori\.com/<path>$
  const m = pattern.match(/^\*:\/\/\*\.roblox\.com(\/.*)$/);
  if (!m) return null;
  const p = m[1].split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return '^https://www\\.rokori\\.com' + p + '$';
}
const GROUPS = [];
for (const cs of manifest.content_scripts) {
  const patterns = cs.matches.map(globToRegex).filter(Boolean);
  if (!patterns.length) continue; // ropro.io-only groups are dropped
  const runAt = (cs.run_at || 'document_idle').replace('document_', '');
  (cs.js || []).forEach(addUnit);
  (cs.css || []).forEach(loadCss);
  GROUPS.push({ patterns, run_at: runAt, js: (cs.js || []).map((f) => '/' + norm(f)), css: (cs.css || []).map(norm) });
}

/* ---------- page-world scripts (web_accessible_resources) ---------- */
const PAGE_SRC = {};
for (const war of manifest.web_accessible_resources || []) for (const r of war.resources) {
  if (r.endsWith('.js')) PAGE_SRC[norm(r)] = patchJs(rd(r));
}

/* ---------- options page ---------- */
let optHtml = rd('options.html');
const optJs = [], optCss = [];
optHtml = optHtml.replace(/<script[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (m, src) => { optJs.push('/' + norm(src)); return ''; });
optHtml = optHtml.replace(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi, (m, href) => { optCss.push(norm(href)); return ''; });
optHtml = optHtml.replace(/(src|href)=(["'])(?:\.\/|\/)?((?:images|fonts)\/[^"']+|icon\d*\.png|logo\.png)\2/g, (m, a, q, rel) => {
  if (!exists(rel)) return m; if (!ASSETS[rel]) ASSETS[rel] = dataUri(rel); return `${a}=${q}${ASSETS[rel]}${q}`;
});
optHtml = optHtml.replace(/url\(\s*(["']?)(?:\.\/|\/)?((?:images|fonts)\/[^"')]+)\1\s*\)/g, (m, q, rel) => {
  if (!exists(rel)) return m; if (!ASSETS[rel]) ASSETS[rel] = dataUri(rel); return `url("${ASSETS[rel]}")`;
});
optHtml = optHtml.replace(/chrome-extension:\/\/__MSG_@@extension_id__\//g, '/');
optJs.forEach(addUnit); optCss.forEach(loadCss);
const OPTIONS = { html: patchJs(optHtml), css: optCss, js: optJs };

/* ---------- paid settings (from RoPro's own tier lists) ---------- */
const gating = rd('js/background/featureGating.js');
const setOf = (name) => { const m = gating.match(new RegExp(name + ' = new Set\\(\\[([\\s\\S]*?)\\]\\)')); return m ? [...m[1].matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1]) : []; };
const PAID_SETTINGS = [...setOf('ROPRO_STANDARD_SETTINGS'), ...setOf('ROPRO_PRO_SETTINGS')];
if (PAID_SETTINGS.length < 20) throw new Error('could not read RoPro paid settings lists');

/* ---------- background ---------- */
const bgBundle = esbuild.buildSync({
  entryPoints: [path.join(SRC, manifest.background.service_worker)],
  bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2020', logLevel: 'error', legalComments: 'none'
}).outputFiles[0].text;
const BG_UNIT = `function(__p,__bind){with(__p){return function(){void 0;\n${patchJs(bgBundle)}\n};}}`;

/* ---------- assemble ---------- */
const unitsSrc = '{\n' + Object.entries(UNITS).map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',\n') + '\n}';
const runtime = fs.readFileSync(path.join(__dirname, 'runtime.js'), 'utf8');
const sub = {
  __MANIFEST__: JSON.stringify(manifest), __ASSETS__: JSON.stringify(ASSETS), __TEXT__: JSON.stringify(TEXT),
  __CSS__: JSON.stringify(CSS), __PAGE_SRC__: JSON.stringify(PAGE_SRC), __GROUPS__: JSON.stringify(GROUPS),
  __OPTIONS__: JSON.stringify(OPTIONS), __API_BASE__: JSON.stringify(API_BASE), __PAID_SETTINGS__: JSON.stringify(PAID_SETTINGS), __CONTENT_UNITS__: unitsSrc, __BACKGROUND_UNIT__: BG_UNIT,
};
let body = runtime;
for (const [k, v] of Object.entries(sub)) body = body.split(k).join(v); // split/join: no $-pattern surprises

const header = `// ==UserScript==
// @name         PoPro (RoPro for Rokori)
// @namespace    popro
// @version      ${manifest.version}-rokori.1
// @description  RoPro ${manifest.version} patched to run on rokori.com, backed by your PoPro API server (${API_HOST}).
// @match        https://www.rokori.com/*
// @connect      ${API_HOST}
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @noframes
// ==/UserScript==
`;
const out = header + '(function(){\n' + body + '\n})();\n';
// sanity: whole script must parse as a sloppy-mode script
acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'script' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log('units', Object.keys(UNITS).length, 'groups', GROUPS.length, 'css', Object.keys(CSS).length,
  'assets', Object.keys(ASSETS).length, 'page', Object.keys(PAGE_SRC).length, 'bytes', out.length);
