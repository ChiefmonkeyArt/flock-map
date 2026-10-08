# Flock Map

Flock Safety / ALPR surveillance camera map — a static web app showing 178,674
cameras and 4,253 data-sharing networks across 8,218 geohash cells.

Served self-hosted at `https://chiefmonkey.art/flock-map/`. Version **1.1.0**.

## Files

- `index.html` — **generated**. Inlined Leaflet 1.9.4 + a single-canvas
  cluster/point renderer (Esri dark basemap, no key), hash-pinned CSP
- `cams.js` — **generated**. `window.FLOCK_PACK`: the full dataset packed
  losslessly (Morton-sorted varint deltas at 1e-7°, string dictionaries,
  deflate-raw, base64) — 1.4 MB instead of 7.6 MB
- `manifest.json` — dataset tile manifest (geohash cells); cross-checked at
  build time, not fetched by the page
- `web/index.src.html` — page template (edit this, not `index.html`)
- `tools/build.mjs` — reproducible build (`--check` fails if outputs are stale)
- `tools/test.mjs` — lossless round-trip, manifest cross-check, CSP, whitelist
- `napplet/` — standalone Nostr napplet (NIP-5A kind 35129) — see `napplet/README.md`
- `ops/flock-map-deploy` — forced-command dispatcher run by the restricted key
- `ops/flock-map-install-root` — pinned root installer (fixed-path sudoers target)
- `ops/bootstrap-vps.sh` — one-time (idempotent) VPS setup for the restricted key
- `.github/workflows/deploy-flock-map.yml` — manual VPS deploy (host-key verified)

## Build and test

```sh
node tools/build.mjs && node tools/test.mjs
```

The source dataset is `napplet/cams.js` (`window.CAMS = [[lat, lon, name,
operator, camera_type], ...]`). CI runs the tests on every PR, and the deploy
workflow refuses to ship a bundle that fails them.

## Performance (v1.1.0 vs v1.0.0, 25 Mbit/s, headless Chromium)

| | v1.0.0 | v1.1.0 |
| --- | --- | --- |
| Transferred (excl. basemap) | 8.75 MB | 1.59 MB |
| Time to cameras ready | 32.4 s | 0.86 s |
| JS heap | 247 MB | 21 MB |
| DOM nodes | 8,291 | 77 |
| Redraw on pan/zoom | — | 1–12 ms |

v1.0.0 built 178,674 Leaflet markers with popups and 8,218 SVG rectangles up
front behind a render-blocking 7.6 MB script. v1.1.0 decodes typed arrays,
clusters only what is on screen into one canvas, and builds popups on click.

## Deploy security model

The deploy key is a **restricted key**: sshd forces it to run only
`/usr/local/bin/flock-map-deploy` — no shell, no pty, no port/agent/X11
forwarding. That dispatcher:

1. reads a gzipped tarball of the app on stdin,
2. validates it against a strict whitelist (`index.html`, `cams.js`,
   `manifest.json` — nothing else),
3. hands it to the pinned root installer via a single fixed-path sudoers rule
   (`ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/flock-map-install-root`).

The root installer re-validates the payload independently and performs the
atomic install (`/apps/flock-map/{current,releases,data}` symlink flip + nginx
fragment + `torii register`). No broad sudo remains after bootstrap.

## Deploy

```sh
gh workflow run deploy-flock-map.yml --repo ChiefmonkeyArt/flock-map --ref v1.1.0
```

Deploy from the release tag so VPS == tag == main.

The workflow verifies the VPS host-key fingerprint against the
`VPS_DEPLOY_HOST_KEY` secret before any remote command runs.