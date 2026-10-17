#!/usr/bin/env node
// tools/ngit-events.mjs — print the signing bundle for the ngit publication.
//
//   node tools/ngit-events.mjs            (run in a full clone with all tags)
//
// Emits JSON: the unsigned events the owner signs, in order, and the relays
// each one is published to. Nothing here signs or holds a key.
//
//   1. kind 35129 napplet event        (napplet/dist, from tools/build.mjs)
//   2. kind 30617 repo announcement    (napplet/dist, from tools/build.mjs)
//   3. kind 30618 repo state           (built here from the real git refs)
//
// The state event names the exact commit of main and every release tag, so a
// GRASP server only accepts git data that matches what the owner signed. It
// cannot live in the repo itself (a commit cannot contain its own hash), so
// it is generated at signing time.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBKEY_HEX, DTAG_ID, REPO_RELAYS, NAPPLET_RELAYS, GRASP_SERVERS, OWNER_NPUB, VERSION } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OID = /^[0-9a-f]{40}$/;
const TAG = /^v\d+\.\d+\.\d+$/;

// `git show-ref -d --heads --tags` output -> NIP-34 state tags, mirroring
// ngit: annotated tags carry both "refs/tags/vX" (tag object) and
// "refs/tags/vX^{}" (the commit it points to). Only main and vX.Y.Z tags.
export function stateTags(showRef, branch = 'main') {
  const tags = [];
  for (const line of showRef.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40}) (refs\/(heads|tags)\/(.+))$/);
    if (!m) continue;
    const [, oid, ref, kind, name] = m;
    if (kind === 'heads' && name === branch) tags.push([ref, oid]);
    if (kind === 'tags' && TAG.test(name.replace(/\^\{\}$/, ''))) tags.push([ref, oid]);
  }
  if (!tags.some((t) => t[0] === `refs/heads/${branch}`)) throw new Error(`no refs/heads/${branch}`);
  tags.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, oid] of tags) if (!OID.test(oid)) throw new Error(`bad oid ${oid}`);
  return [['d', DTAG_ID], ['HEAD', `ref: refs/heads/${branch}`], ...tags];
}

export function bundle(showRef) {
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const state = { kind: 30618, pubkey: PUBKEY_HEX, created_at: 0, content: '', tags: stateTags(showRef) };
  const main = state.tags.find((t) => t[0] === 'refs/heads/main')[1];
  const tagCommit = state.tags.find((t) => t[0] === `refs/tags/v${VERSION}^{}`);
  if (!tagCommit || tagCommit[1] !== main) throw new Error(`main must be tagged v${VERSION} before signing`);
  return {
    version: VERSION, main, owner: OWNER_NPUB, grasp: GRASP_SERVERS,
    steps: [
      { label: 'napplet listing (kind 35129)', event: rd('napplet/dist/flock-map.nip5a.unsigned.json'), relays: NAPPLET_RELAYS },
      { label: 'repo announcement on ngit (kind 30617)', event: rd('napplet/dist/flock-map.nip34.unsigned.json'), relays: REPO_RELAYS },
      { label: 'repo state: main + release tags (kind 30618)', event: state, relays: REPO_RELAYS },
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const showRef = execFileSync('git', ['show-ref', '-d', '--heads', '--tags'], { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(JSON.stringify(bundle(showRef), null, 2) + '\n');
}
