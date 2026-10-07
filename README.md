# Flock Map

Flock Safety / ALPR surveillance camera map — a static web app showing 178,674
cameras and 4,253 data-sharing networks across 8,218 geohash cells.

Served self-hosted at `https://chiefmonkey.art/flock-map/`.

## Files

- `index.html` — Leaflet 1.9.4 + marker clustering (Esri dark basemap, no key)
- `cams.js` — `window.CAMS` = `[lat, lon, name, operator, camera_type]`
- `manifest.json` — signed dataset manifest (geohash cells)
- `napplet/` — standalone Nostr napplet (NIP-5A kind 35129) — see `napplet/README.md`
- `ops/flock-map-deploy` — forced-command dispatcher run by the restricted key
- `ops/flock-map-install-root` — pinned root installer (fixed-path sudoers target)
- `ops/bootstrap-vps.sh` — one-time (idempotent) VPS setup for the restricted key
- `.github/workflows/deploy-flock-map.yml` — manual VPS deploy (host-key verified)

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
gh workflow run deploy-flock-map.yml --repo ChiefmonkeyArt/flock-map
```

The workflow verifies the VPS host-key fingerprint against the
`VPS_DEPLOY_HOST_KEY` secret before any remote command runs.