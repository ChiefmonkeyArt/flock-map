// build-manifest.mjs — reproducibly hash the flock-map napplet bundle and emit
// the UNSIGNED Nostr events for the operator to sign manually.
//
// This script NEVER signs and NEVER touches a private key. It writes two files:
//   dist/flock-map.nip5a.unsigned.json   kind 35129 named-napplet manifest
//   dist/flock-map.nip34.unsigned.json   kind 30617 repo announcement
//
// Both are complete except `id` and `sig` (and the kind:30617 `created_at` is
// left at 0 so the signer sets it). The operator signs with their own tool and
// publishes; this repo carries no signing material.
//
// Usage:  node napplet/build-manifest.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)); // napplet/
const DIST = join(ROOT, 'dist');

// ---- identity constants (public, safe to bake in) --------------------------
const PUBKEY_HEX = 'ec79b568bdea63ca6091f5b84b0c639c10a0919e175fa09a4de3154f82906f25';
const DTAG = 'flock-map';
const NAPPLET_TYPE = 'flock-map';
const RELAYS = ['wss://chiefmonkey.art/relay'];
const CLONE_URL = 'https://github.com/ChiefmonkeyArt/flock-map.git';
const WEB_URL = 'https://chiefmonkey.art/flock-map/';

// ---- walk napplet/ subtree and hash every file -----------------------------
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(ROOT)
  .filter(p => !p.includes(`${sep}dist${sep}`))
  .filter(p => !p.endsWith(`${sep}build-manifest.mjs`)) // build tooling is not shipped
  .sort();

const paths = files.map(p => {
  const rel = '/' + relative(ROOT, p).split(sep).join('/');
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
  return { rel, sha };
});

// ---- aggregate x tag (NIP-5A): sort "<sha> <path>\n" lines, sha256 ---------
const aggregate = createHash('sha256')
  .update(paths.map(({ rel, sha }) => `${sha} ${rel}\n`).sort().join(''))
  .digest('hex');

mkdirSync(DIST, { recursive: true });

// ---- kind 35129 named-napplet manifest -------------------------------------
const nip5a = {
  kind: 35129,
  pubkey: PUBKEY_HEX,
  created_at: 0, // signer sets
  tags: [
    ['d', DTAG],
    ['type', NAPPLET_TYPE],
    ['name', 'Flock Map'],
    ['description', 'Self-hosted surveillance (Flock Safety / ALPR) camera map; standalone display napplet, no shell capabilities required.'],
    ['x', aggregate, 'aggregate'],
    ['web', WEB_URL],
    ['source', CLONE_URL],
    ...RELAYS.map(r => ['relays', r]),
    ...paths.map(({ rel, sha }) => ['path', rel, sha]),
  ],
  content: 'Flock Map napplet — NIP-5A content-addressed bundle (see path tags).',
};
writeFileSync(join(DIST, 'flock-map.nip5a.unsigned.json'), JSON.stringify(nip5a, null, 2) + '\n');

// ---- kind 30617 repo announcement (NIP-34) ---------------------------------
const nip34 = {
  kind: 30617,
  pubkey: PUBKEY_HEX,
  created_at: 0, // signer sets
  tags: [
    ['d', DTAG],
    ['name', 'flock-map'],
    ['description', 'Self-hosted Flock Safety / ALPR camera surveillance map + standalone Nostr napplet.'],
    ['clone', CLONE_URL],
    ['r', '12b015bd4a7d9022140aac3c6a3e5e027000edcc'], // earliest unique commit
    ...RELAYS.map(r => ['relays', r]),
    ['web', WEB_URL],
  ],
  content: 'Flock Map — standalone self-hosted camera map and Nostr napplet (npm: flock-map).',
};
writeFileSync(join(DIST, 'flock-map.nip34.unsigned.json'), JSON.stringify(nip34, null, 2) + '\n');

// ---- human summary ----------------------------------------------------------
console.log('napplet bundle files:');
for (const { rel, sha } of paths) console.log(`  ${sha}  ${rel}`);
console.log(`\naggregate x: ${aggregate}`);
console.log('wrote dist/flock-map.nip5a.unsigned.json (kind 35129)');
console.log('wrote dist/flock-map.nip34.unsigned.json (kind 30617)');
console.log('\nSign both with your identity, then publish. id/sig are absent and');
console.log('created_at is 0 — the signer fills them.');