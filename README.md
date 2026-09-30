# Flock Map

Flock Safety / ALPR surveillance camera map — a static web app showing 178,674 cameras and 4,253 data-sharing networks across 8,218 geohash cells.

Served self-hosted at `https://chiefmonkey.art/flock-map/` via the Torii VPS `/apps/<app>/{current,releases,data}` layout.

## Files

- `index.html` — Leaflet 1.9.4 + marker clustering (Esri dark basemap, no key)
- `cams.js` — `window.CAMS` = `[lat, lon, name, operator, camera_type]`
- `manifest.json` — signed dataset manifest (geohash cells)
- `install-flock-map.sh` — VPS installer (atomic `current` symlink flip + nginx fragment + `torii register`)
- `.github/workflows/deploy-flock-map.yml` — manual VPS deploy (dedicated deploy key, host-key verified)

## Deploy

`gh workflow run deploy-flock-map.yml --repo ChiefmonkeyArt/flock-map`
