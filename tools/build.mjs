#!/usr/bin/env node
// tools/build.mjs — reproducible build of the Flock Map web bundle.
//
//   node tools/build.mjs          write every generated file
//   node tools/build.mjs --check  exit 1 if any committed generated file is stale
//
// Inputs (sources of truth):
//   VERSION                 release version (also drives the launcher tile)
//   data/cams.source.js     window.CAMS = [[lat, lon, name, operator, type], ...]
//   data/SOURCE.json        provenance (data date, credit, label for field 5)
//   manifest.json           dataset tile manifest (cross-checked, not rewritten)
//   web/index.src.html      page template (web + napplet builds)
//   vendor/leaflet.{js,css} vendored Leaflet 1.9.4 (inlined)
//
// Generated outputs:
//   cams.js                 window.FLOCK_PACK = "<base64 deflate-raw pack>"
//   manifest.json           per-cell counts + sha256 of canonical records
//   index.html              web page (loads content-hashed cams.js)
//   napplet/index.html      single-file napplet (pack inlined; one blob to verify)
//   napplet/dist/flock-map.nip5a.unsigned.json   kind 35129, unsigned
//   napplet/dist/flock-map.nip34.unsigned.json   kind 30617, unsigned
// The VPS deploy payload is exactly: index.html cams.js manifest.json VERSION.
//
// Pack format v1 (after inflate), little-endian:
//   u32 headerLen | header JSON (utf8) | 5 varint columns of length n:
//   lat (zigzag delta, deg*1e7) | lon (zigzag delta, deg*1e7) |
//   nameIdx | opIdx | typeIdx      (indices into header dictionaries)
// Records are Morton-sorted so coordinate deltas stay small. Lossless: every
// source coordinate has <= 7 decimals (asserted below).
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p));
export const VERSION = rd('VERSION').toString('utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`VERSION must be semver x.y.z, got '${VERSION}'`);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function loadSource() {
  const s = rd('data/cams.source.js').toString('utf8');
  const recs = JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;$/, ''));
  if (!Array.isArray(recs) || !recs.length) throw new Error('source: no records');
  return recs;
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohash(lat, lon, prec) {
  let la = [-90, 90], lo = [-180, 180], even = true, bit = 0, ch = 0, out = '';
  while (out.length < prec) {
    const r = even ? lo : la, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

function morton(latI, lonI) {
  const y = Math.min(65535, Math.floor(((latI + 9e8) / 1.8e9) * 65536));
  const x = Math.min(65535, Math.floor(((lonI + 1.8e9) / 3.6e9) * 65536));
  let k = 0;
  for (let i = 15; i >= 0; i--) k = k * 4 + (((y >> i) & 1) << 1) + ((x >> i) & 1);
  return k; // < 2^32, exact in a double
}

function dict(values) {
  const freq = new Map();
  for (const v of values) freq.set(v, (freq.get(v) || 0) + 1);
  freq.delete('');
  const list = [''].concat([...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((e) => e[0]));
  if (list.length > 65535) throw new Error('dictionary exceeds Uint16');
  const idx = new Map(list.map((v, i) => [v, i]));
  return { list, idx };
}

export function pack(recs) {
  const rows = recs.map((r, i) => {
    if (r.length !== 5) throw new Error(`record ${i}: expected 5 fields`);
    const latI = Math.round(r[0] * 1e7), lonI = Math.round(r[1] * 1e7);
    if (Math.abs(latI / 1e7 - r[0]) > 1e-12 || Math.abs(lonI / 1e7 - r[1]) > 1e-12)
      throw new Error(`record ${i}: coordinate exceeds 7 decimals (pack would be lossy)`);
    return { latI, lonI, name: r[2] || '', op: r[3] || '', type: r[4] || '', i, k: morton(latI, lonI) };
  });
  rows.sort((a, b) => a.k - b.k || a.latI - b.latI || a.lonI - b.lonI || a.i - b.i);

  const names = dict(rows.map((r) => r.name)), ops = dict(rows.map((r) => r.op)), types = dict(rows.map((r) => r.type));

  const cellCount = new Map();
  for (const r of rows) { const g = geohash(r.latI / 1e7, r.lonI / 1e7, 4); cellCount.set(g, (cellCount.get(g) || 0) + 1); }
  const cells = [...cellCount.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const head = Buffer.from(JSON.stringify({ v: 1, n: rows.length, names: names.list, ops: ops.list, types: types.list, cells }), 'utf8');
  const out = [];
  const vu = (n) => { while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); };
  const zz = (n) => (n < 0 ? -n * 2 - 1 : n * 2);
  let p = 0; for (const r of rows) { vu(zz(r.latI - p)); p = r.latI; }
  p = 0; for (const r of rows) { vu(zz(r.lonI - p)); p = r.lonI; }
  for (const r of rows) vu(names.idx.get(r.name));
  for (const r of rows) vu(ops.idx.get(r.op));
  for (const r of rows) vu(types.idx.get(r.type));
  const hl = Buffer.alloc(4); hl.writeUInt32LE(head.length, 0);
  const raw = Buffer.concat([hl, head, Buffer.from(out)]);
  return { raw, deflated: zlib.deflateRawSync(raw, { level: 9 }), cells, n: rows.length };
}

// Provenance for the current dataset (written by tools/refresh-osm.mjs).
export function loadSourceMeta() { return validateMeta(JSON.parse(rd('data/SOURCE.json'))); }
export function validateMeta(m) {
  const safe = (v, re) => { if (typeof v !== 'string' || !re.test(v)) throw new Error(`data/SOURCE.json: bad value '${v}'`); return v; };
  return {
    ...m,
    data_date: safe(m.data_date, /^\d{4}-\d{2}-\d{2}$/),
    type_label: safe(m.type_label || 'maker', /^[a-z ]{1,20}$/),
    credit: safe(m.credit || 'Cameras &copy; OpenStreetMap contributors (ODbL)', /^[A-Za-z0-9 &;().,/-]{1,120}$/),
  };
}

// manifest.json is generated: per geohash-4 cell, the camera count and the
// sha256 of that cell's canonical records, so any mirror can verify a cell.
export function manifestOf(recs, meta) {
  const cells = new Map();
  for (const r of recs) {
    const latI = Math.round(r[0] * 1e7), lonI = Math.round(r[1] * 1e7);
    const g = geohash(latI / 1e7, lonI / 1e7, 4);
    if (!cells.has(g)) cells.set(g, []);
    cells.get(g).push(JSON.stringify([latI, lonI, r[2] || '', r[3] || '', r[4] || '']));
  }
  const tiles = {};
  for (const g of [...cells.keys()].sort()) {
    const lines = cells.get(g).sort();
    tiles[g] = { count: lines.length, sha256: sha256(lines.join('\n')) };
  }
  return JSON.stringify({ name: 'flock-map', version: 2, precision: 4, total_cameras: recs.length,
    source: meta.source, license: meta.license || null, data_date: meta.data_date, tiles }) + '\n';
}

const cspHash = (code) => `'sha256-${crypto.createHash('sha256').update(code, 'utf8').digest('base64')}'`;

// ---- napplet events (NEVER signed here; no key material in this repo) -----
export const PUBKEY_HEX = 'ec79b568bdea63ca6091f5b84b0c639c10a0919e175fa09a4de3154f82906f25';
const DTAG = 'flock-map';
const OWN_RELAY = 'wss://chiefmonkey.art/relay';
const RELAYS = [OWN_RELAY];
const GITHUB_CLONE = 'https://github.com/ChiefmonkeyArt/flock-map.git';
const CLONE_URL = GITHUB_CLONE;
const WEB_URL = 'https://chiefmonkey.art/flock-map/';

// ngit / GRASP hosting (ADR 0001, phase 1): ngit's default public GRASP
// servers. Each serves a relay at wss://<host> and git at
// https://<host>/<npub>/<d>.git; GRASP-01 requires both in the announcement.
export const GRASP_SERVERS = ['relay.ngit.dev', 'gitnostr.com', 'git.shakespeare.diy'];

const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32(hrp, hex) {
  const data = [], bytes = Buffer.from(hex, 'hex');
  let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const poly = (v) => { let c = 1; for (const x of v) { const t = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= G[i]; } return c; };
  const hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const p = poly(hx.concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const cs = [0, 1, 2, 3, 4, 5].map((i) => (p >> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(cs).map((d) => BECH[d]).join('');
}
export const OWNER_NPUB = bech32('npub', PUBKEY_HEX);
export const DTAG_ID = DTAG;
export const REPO_RELAYS = GRASP_SERVERS.map((h) => `wss://${h}`).concat([OWN_RELAY]);
export const REPO_CLONES = GRASP_SERVERS.map((h) => `https://${h}/${OWNER_NPUB}/${DTAG}.git`).concat([GITHUB_CLONE]);
export const NAPPLET_RELAYS = [OWN_RELAY];
const EARLIEST_COMMIT = '12b015bd4a7d9022140aac3c6a3e5e027000edcc';
// The napplet bundle is an explicit list (not a directory walk) so dev files
// such as README.md or shell-test.html can never leak into the aggregate.
export const NAPPLET_FILES = ['/index.html'];

export function aggregateOf(paths) {
  return sha256(paths.map(([rel, h]) => `${h} ${rel}\n`).sort().join(''));
}

function nappletEvents(files) {
  const paths = NAPPLET_FILES.map((rel) => [rel, sha256(Buffer.from(files[rel], 'utf8'))]);
  const nip5a = {
    kind: 35129, pubkey: PUBKEY_HEX, created_at: 0,
    tags: [
      ['d', DTAG], ['type', 'flock-map'], ['name', 'Flock Map'],
      ['description', 'Self-hosted surveillance (Flock Safety / ALPR) camera map; standalone single-file display napplet, no shell capabilities required.'],
      ['x', aggregateOf(paths), 'aggregate'],
      ['web', WEB_URL], ['source', CLONE_URL],
      ...RELAYS.map((r) => ['relays', r]),
      ...paths.map(([rel, h]) => ['path', rel, h]),
    ],
    content: `Flock Map napplet v${VERSION} — NIP-5A content-addressed single-file bundle (see path tags).`,
  };
  const nip34 = {
    kind: 30617, pubkey: PUBKEY_HEX, created_at: 0,
    tags: [
      ['d', DTAG], ['name', 'Flock Map'],
      ['description', 'Self-hosted Flock Safety / ALPR camera surveillance map + standalone Nostr napplet.'],
      ['web', WEB_URL, `https://gitworkshop.dev/${OWNER_NPUB}/${DTAG}`],
      ['clone', ...REPO_CLONES],
      ['relays', ...REPO_RELAYS],
      ['r', EARLIEST_COMMIT, 'euc'],
      ['t', 'alpr'], ['t', 'surveillance'], ['t', 'openstreetmap'], ['t', 'napplet'],
    ],
    content: 'Flock Map — standalone self-hosted camera map and Nostr napplet.',
  };
  const j = (o) => JSON.stringify(o, null, 2) + '\n';
  return { 'napplet/dist/flock-map.nip5a.unsigned.json': j(nip5a), 'napplet/dist/flock-map.nip34.unsigned.json': j(nip34) };
}

function page({ mode, camsHash, packB64, meta }) {
  const leafletJs = rd('vendor/leaflet.js').toString('utf8');
  // Strip image-backed rules for controls/markers we never use (keeps CSP img-src tight).
  const leafletCss = rd('vendor/leaflet.css').toString('utf8').replace(/url\((?!#)[^)]*\)/g, 'none');
  if (/<\/script/i.test(leafletJs)) throw new Error('leaflet.js contains </script');
  const web = mode === 'web';
  let html = rd('web/index.src.html').toString('utf8')
    .replaceAll('{{VERSION}}', VERSION)
    .replaceAll('{{MODE}}', mode)
    .replaceAll('{{CAMS_HASH}}', camsHash)
    .replaceAll('{{DATA_DATE}}', meta.data_date)
    .replaceAll('{{TYPE_LABEL}}', meta.type_label)
    .replaceAll('{{DATA_CREDIT}}', meta.credit)
    .replace('{{PRELOAD}}', web ? `  <link rel="preload" href="cams.js?v=${camsHash}" as="script" />\n` : '')
    .replace('{{INLINE_DATA}}', () => (web ? '' : `  <script>window.FLOCK_PACK="${packB64}";</script>\n`))
    .replace('{{LEAFLET_CSS}}', () => leafletCss)
    .replace('{{LEAFLET_JS}}', () => leafletJs);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length !== (web ? 2 : 3)) throw new Error(`${mode}: unexpected inline script count ${scripts.length}`);
  const csp = [
    "default-src 'none'",
    `script-src ${web ? "'self' " : ''}${scripts.map(cspHash).join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src https://server.arcgisonline.com data:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  html = html.replace('{{CSP}}', csp);
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error('unreplaced template token');
  return html;
}

export function build() {
  const recs = loadSource();
  const meta = loadSourceMeta();
  const pk = pack(recs);
  const packB64 = pk.deflated.toString('base64');
  const cams = `/* Flock Map packed dataset v1 (${pk.n} cameras). Generated by tools/build.mjs from data/cams.source.js — do not edit. */\nwindow.FLOCK_PACK="${packB64}";\n`;
  const camsHash = sha256(cams).slice(0, 16);
  const files = {
    'cams.js': cams,
    'manifest.json': manifestOf(recs, meta),
    'index.html': page({ mode: 'web', camsHash, packB64, meta }),
    'napplet/index.html': page({ mode: 'napplet', camsHash, packB64, meta }),
  };
  Object.assign(files, nappletEvents({ '/index.html': files['napplet/index.html'] }));
  const stats = { version: VERSION, data_date: meta.data_date, n: pk.n, cells: pk.cells.length, cams: cams.length, html: files['index.html'].length, napplet: files['napplet/index.html'].length };
  return { files, stats };
}

export function main(argv = process.argv) {
  const { files, stats } = build();
  const check = argv.includes('--check');
  let stale = false;
  for (const [f, body] of Object.entries(files)) {
    const p = path.join(ROOT, f);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (cur === body) continue;
    if (check) { console.error(`stale: ${f} (run node tools/build.mjs)`); stale = true; }
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
  }
  console.log(JSON.stringify(stats));
  if (stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
