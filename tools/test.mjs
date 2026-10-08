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
import { build, loadSource } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const html = read('index.html'), cams = read('cams.js');
let DECODED = null;

await t('build is reproducible and committed outputs are fresh', () => {
  const a = build(), b = build();
  assert.equal(a['cams.js'], b['cams.js']);
  assert.equal(a['index.html'], b['index.html']);
  assert.equal(cams, a['cams.js'], 'cams.js is stale');
  assert.equal(html, a['index.html'], 'index.html is stale');
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
  assert.match(wf, /tar -czf flock-release\.tar\.gz index\.html cams\.js manifest\.json\n/);
  for (const f of ['index.html', 'cams.js', 'manifest.json']) assert.ok(fs.existsSync(path.join(ROOT, f)));
  assert.ok(Buffer.byteLength(cams) < 2_000_000, `cams.js too large: ${Buffer.byteLength(cams)}`);
});

console.log(`${passed} passed`);
