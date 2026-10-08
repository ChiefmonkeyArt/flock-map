#!/usr/bin/env node
// tools/test.mjs — no-dependency checks for the Flock Map web bundle.
//   1. committed cams.js / index.html are exactly what tools/build.mjs produces
//   2. the browser decoder (extracted verbatim from index.html) restores every
//      source record losslessly (coordinates at 1e-7 and all strings)
//   3. packed cell counts match manifest.json
//   4. the CSP's script hashes match the inline scripts, and there are no
//      third-party script/style origins at runtime
//   5. the deploy payload stays within the VPS whitelist
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build, loadSource, aggregateOf, PUBKEY_HEX, NAPPLET_FILES, VERSION } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const html = read('index.html'), cams = read('cams.js');
let DECODED = null;

await t('build is reproducible and every generated file is fresh', () => {
  const a = build(), b = build();
  for (const [f, body] of Object.entries(a.files)) {
    assert.equal(body, b.files[f], `${f} not deterministic`);
    assert.equal(read(f), body, `${f} is stale (run node tools/build.mjs)`);
  }
});

await t('browser decoder round-trips every record losslessly', async () => {
  const m = html.match(/\/\*DECODE-START\*\/([\s\S]*?)\/\*DECODE-END\*\//);
  assert.ok(m, 'decoder markers missing');
  const { b64ToBytes, inflateRaw, decodePack } = new Function(`${m[1]}; return { b64ToBytes, inflateRaw, decodePack };`)();
  const sandbox = {}; new Function('window', cams)(sandbox);
  const D = decodePack(await inflateRaw(b64ToBytes(sandbox.FLOCK_PACK)));
  DECODED = D;
  const src = loadSource();
  assert.equal(D.n, src.length);
  const key = (la, lo, a, b, c) => `${la}|${lo}|${a}|${b}|${c}`;
  const want = new Map();
  for (const r of src) { const k = key(Math.round(r[0] * 1e7), Math.round(r[1] * 1e7), r[2] || '', r[3] || '', r[4] || ''); want.set(k, (want.get(k) || 0) + 1); }
  for (let i = 0; i < D.n; i++) {
    const k = key(D.lat[i], D.lon[i], D.head.names[D.name[i]], D.head.ops[D.op[i]], D.head.types[D.type[i]]);
    const c = want.get(k); assert.ok(c, `decoded record ${i} not in source: ${k}`);
    if (c === 1) want.delete(k); else want.set(k, c - 1);
  }
  assert.equal(want.size, 0, `${want.size} source records not restored`);
});

await t('packed cell counts match manifest.json exactly', () => {
  assert.ok(DECODED, 'decode test must pass first');
  const man = JSON.parse(read('manifest.json'));
  assert.equal(DECODED.head.cells.length, Object.keys(man.tiles).length);
  let total = 0;
  for (const [g, c] of DECODED.head.cells) { assert.equal(man.tiles[g]?.count, c, `cell ${g}`); total += c; }
  assert.equal(total, man.total_cameras);
});

await t('CSP pins inline scripts by hash; no third-party code origins', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) {
    const h = crypto.createHash('sha256').update(s, 'utf8').digest('base64');
    assert.ok(csp.includes(`'sha256-${h}'`), 'inline script hash missing from CSP');
  }
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(html, /unpkg\.com|cdn\.jsdelivr|cdnjs/);
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external <script src> tags');
  assert.match(html, /cams\.js\?v=[0-9a-f]{16}/, 'cams.js must be cache-busted by content hash');
});

await t('deploy payload stays inside the VPS whitelist', () => {
  const wf = read('.github/workflows/deploy-flock-map.yml');
  assert.match(wf, /tar -czf flock-release\.tar\.gz index\.html cams\.js manifest\.json VERSION\n/);
  for (const f of ['index.html', 'cams.js', 'manifest.json', 'VERSION']) assert.ok(fs.existsSync(path.join(ROOT, f)));
  assert.ok(Buffer.byteLength(cams) < 2_000_000, `cams.js too large: ${Buffer.byteLength(cams)}`);
});

const nap = read('napplet/index.html');

await t('napplet is a single self-contained file carrying the same dataset', () => {
  const m = nap.match(/<script>window\.FLOCK_PACK="([A-Za-z0-9+/=]+)";<\/script>/);
  assert.ok(m, 'napplet must inline the packed dataset');
  const sandbox = {}; new Function('window', cams)(sandbox);
  assert.equal(m[1], sandbox.FLOCK_PACK, 'napplet and web app must ship the identical pack');
  assert.doesNotMatch(nap, /<script[^>]+src=|<link[^>]+href=(?!"https:\/\/server\.arcgisonline\.com")/, 'napplet must not load sibling files');
  assert.doesNotMatch(nap, /window\.napplet/, 'display-only: no shell capabilities');
  const csp = nap.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const scripts = [...nap.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  assert.equal(scripts.length, 3);
  for (const sc of scripts) assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(sc, 'utf8').digest('base64')}'`));
  assert.doesNotMatch(csp, /'self'/, 'opaque-origin napplet needs no self source');
  assert.match(nap, new RegExp(`VERSION = '${VERSION.replace(/\./g, '\\.')}'`));
});

await t('unsigned kind 35129 matches the napplet bytes exactly', () => {
  const ev = JSON.parse(read('napplet/dist/flock-map.nip5a.unsigned.json'));
  assert.equal(ev.kind, 35129); assert.equal(ev.pubkey, PUBKEY_HEX); assert.equal(ev.created_at, 0);
  assert.ok(!('id' in ev) && !('sig' in ev), 'must be unsigned');
  const paths = ev.tags.filter((x) => x[0] === 'path');
  assert.deepEqual(paths.map((x) => x[1]), NAPPLET_FILES, 'bundle must be exactly the explicit file list');
  const h = crypto.createHash('sha256').update(read('napplet/index.html'), 'utf8').digest('hex');
  assert.equal(paths[0][2], h, 'path hash != napplet/index.html');
  const x = ev.tags.find((y) => y[0] === 'x' && y[2] === 'aggregate');
  assert.equal(x[1], aggregateOf(paths.map((p) => [p[1], p[2]])));
  assert.ok(ev.tags.some((y) => y[0] === 'd' && y[1] === 'flock-map'));
});

await t('unsigned kind 30617 is well-formed NIP-34', () => {
  const ev = JSON.parse(read('napplet/dist/flock-map.nip34.unsigned.json'));
  assert.equal(ev.kind, 30617); assert.equal(ev.pubkey, PUBKEY_HEX); assert.equal(ev.created_at, 0);
  assert.ok(!('id' in ev) && !('sig' in ev), 'must be unsigned');
  const tag = (k) => ev.tags.filter((y) => y[0] === k);
  assert.deepEqual(tag('d'), [['d', 'flock-map']]);
  assert.deepEqual(tag('clone'), [['clone', 'https://github.com/ChiefmonkeyArt/flock-map.git']]);
  assert.deepEqual(tag('r'), [['r', '12b015bd4a7d9022140aac3c6a3e5e027000edcc', 'euc']]);
});

await t('no private key material anywhere in generated outputs', () => {
  for (const f of ['napplet/dist/flock-map.nip5a.unsigned.json', 'napplet/dist/flock-map.nip34.unsigned.json', 'index.html', 'napplet/index.html'])
    assert.doesNotMatch(read(f), /nsec1[02-9ac-hj-np-z]{20,}|BEGIN [A-Z ]*PRIVATE KEY/);
});

console.log(`${passed} passed`);
