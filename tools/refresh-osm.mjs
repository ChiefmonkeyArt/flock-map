#!/usr/bin/env node
// tools/refresh-osm.mjs — refresh data/cams.source.js from OpenStreetMap.
//
//   node tools/refresh-osm.mjs                  fetch live from Overpass
//   node tools/refresh-osm.mjs --input f.json   use a saved Overpass JSON reply
//   node tools/refresh-osm.mjs --allow-drop     skip the shrink guard (manual use)
//
// Source: every OSM node tagged man_made=surveillance + surveillance:type=ALPR
// (the same query DeFlock runs hourly). Data © OpenStreetMap contributors,
// ODbL 1.0 — attribution is rendered on the map.
//
// Writes data/cams.source.js (one record per line so weekly git diffs stay
// small) and data/SOURCE.json (provenance). Prints a JSON summary.
// Refuses to write if the reply looks broken (too few cameras, or the set
// shrank by more than MAX_DROP), so a bad Overpass answer can't wipe the map.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QUERY = '[out:json][timeout:300];node["man_made"="surveillance"]["surveillance:type"="ALPR"];out body;';
export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const MIN_CAMERAS = 50_000;
export const MAX_DROP = 0.25;
const UA = 'flock-map-refresh/1 (+https://github.com/ChiefmonkeyArt/flock-map)';

const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '');
const first = (t, keys) => { for (const k of keys) { const v = clean(t[k]); if (v) return v; } return ''; };
const r7 = (x) => Math.round(x * 1e7) / 1e7;

// Overpass elements -> [lat, lon, name, operator, manufacturer], deduped, sorted.
export function toRecords(elements) {
  const seen = new Set(), out = [];
  for (const e of elements || []) {
    if (!e || e.type !== 'node' || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    if (Math.abs(e.lat) > 90 || Math.abs(e.lon) > 180) continue;
    const t = e.tags || {};
    const rec = [r7(e.lat), r7(e.lon),
      first(t, ['name', 'ref']),
      first(t, ['operator', 'surveillance:operator']),
      first(t, ['manufacturer', 'surveillance:manufacturer', 'brand', 'surveillance:brand'])];
    const k = JSON.stringify(rec);
    if (seen.has(k)) continue;
    seen.add(k); out.push(rec);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] + '\u0000' + a[3] + '\u0000' + a[4] < b[2] + '\u0000' + b[3] + '\u0000' + b[4] ? -1 : 1));
  return out;
}

export function serialize(recs) {
  return 'window.CAMS=[\n' + recs.map((r) => JSON.stringify(r)).join(',\n') + '\n];\n';
}

export function diff(before, after) {
  const k = (r) => JSON.stringify(r);
  const a = new Set(before.map(k)), b = new Set(after.map(k));
  let added = 0, removed = 0;
  for (const x of b) if (!a.has(x)) added++;
  for (const x of a) if (!b.has(x)) removed++;
  return { before: before.length, after: after.length, added, removed };
}

export function guard(before, after, allowDrop = false) {
  if (after.length < MIN_CAMERAS) throw new Error(`only ${after.length} cameras (< ${MIN_CAMERAS}); refusing to write`);
  if (!allowDrop && before.length && after.length < before.length * (1 - MAX_DROP))
    throw new Error(`camera count fell ${before.length} -> ${after.length} (> ${MAX_DROP * 100}%); refusing to write`);
}

async function fetchOverpass() {
  const errors = [];
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST', body: new URLSearchParams({ data: QUERY }),
          headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(420_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!Array.isArray(j.elements)) throw new Error('reply has no elements');
        if (j.remark && /error|timed out|runtime/i.test(j.remark)) throw new Error(`remark: ${j.remark.slice(0, 120)}`);
        return { json: j, endpoint: url };
      } catch (e) {
        errors.push(`${url} #${attempt}: ${e.message}`);
        await new Promise((r) => setTimeout(r, attempt * 20_000));
      }
    }
  }
  throw new Error('all Overpass endpoints failed:\n  ' + errors.join('\n  '));
}

function loadCurrent() {
  const p = path.join(ROOT, 'data/cams.source.js');
  if (!fs.existsSync(p)) return [];
  const s = fs.readFileSync(p, 'utf8');
  return JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;$/, ''));
}

export async function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--input');
  const { json, endpoint } = i >= 0
    ? { json: JSON.parse(fs.readFileSync(argv[i + 1], 'utf8')), endpoint: 'file:' + path.basename(argv[i + 1]) }
    : await fetchOverpass();
  const before = loadCurrent();
  const after = toRecords(json.elements);
  guard(before, after, argv.includes('--allow-drop'));
  const osmBase = (json.osm3s && json.osm3s.timestamp_osm_base) || '';
  const source = {
    source: 'OpenStreetMap',
    query: QUERY,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    osm_timestamp: osmBase,
    data_date: (osmBase || new Date().toISOString()).slice(0, 10),
    endpoint,
    cameras: after.length,
  };
  fs.writeFileSync(path.join(ROOT, 'data/cams.source.js'), serialize(after));
  fs.writeFileSync(path.join(ROOT, 'data/SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
  const summary = { ...diff(before, after), data_date: source.data_date, endpoint };
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
