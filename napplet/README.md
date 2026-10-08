# Flock Map — Nostr Napplet

A standalone, **single-file** display napplet for the Flock Safety / ALPR
camera map. `napplet/index.html` contains everything: Leaflet 1.9.4, the fast
single-canvas renderer shared with the web app, and the full 178,674-camera
dataset packed losslessly (~1.6 MB total). No CDN, no sibling files, no
`window.napplet.*` calls and no `requires` capabilities.

It is **not** part of Torii Quest or Continuum: any NIP-5D shell can mount it.
Because the bundle is one blob, the shell only has to verify one hash and write
the bytes into a `sandbox="allow-scripts"` srcdoc — no inlining or base-href
tricks, and nothing for an opaque-origin frame to fetch except basemap tiles.

## Layout

- `index.html` — **generated** napplet (the only file in the bundle)
- `dist/flock-map.nip5a.unsigned.json` — **generated** kind 35129 manifest
- `dist/flock-map.nip34.unsigned.json` — **generated** kind 30617 repo announcement
- `shell-test.html` — reference shell (dev harness; not in the bundle)
- `build-manifest.mjs` — compatibility wrapper for `node tools/build.mjs`

## Build (emits unsigned events — it never signs)

```sh
node tools/build.mjs          # or: node napplet/build-manifest.mjs
node tools/test.mjs           # proves path hash + aggregate match the bytes
```

The bundle is an explicit file list (`NAPPLET_FILES = ['/index.html']` in
`tools/build.mjs`), not a directory walk, so dev files can never change the
aggregate. The build is deterministic and CI fails if `dist/` is stale, so the
events you sign always match the committed napplet byte-for-byte.

Both events are complete except `id`/`sig`, with `created_at: 0` for your
signer to set. **No private key ever touches this repo.**

## Signing and publishing

Easiest: open https://chiefmonkeyart.github.io/flock-map/ in Brave with your
NIP-07 signer and press **Sign and publish** (3 approvals). Or by hand:

1. Sign both JSON files under `npub1a3um269aaf3u5cy37kuykrrrnsg2pyv7za06pxjduv25lq5sdujs2qmdj6`
   with your own signer (it sets `created_at`, `id`, `sig`).
2. Upload `napplet/index.html` to your Blossom server(s); its sha256 is the
   `path` tag hash.
3. Publish both signed events to `wss://chiefmonkey.art/relay`.

## Trust model

- Identity is the `(d, aggregate x)` pair (`flock-map` + aggregate), which the
  shell binds to the iframe `contentWindow`.
- Only `path` tags participate in the aggregate (sorted `"<sha> <path>\n"`
  lines, sha256) — the NIP-5A rule.
- The shell downloads and re-hashes each blob before mounting
  (`shell-test.html` demonstrates exactly this).

## Basemap note

Raster tiles still come from Esri ArcGIS (keyless) at runtime; the CSP allows
images from that one origin only. Swap the URL in `web/index.src.html` and
rebuild if you stand up a self-hosted tile server.
