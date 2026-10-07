# Flock Map — Nostr Napplet

A standalone, self-contained display napplet for the Flock Safety / ALPR camera
map. It ships the entire bundle (Leaflet + marker-cluster, vendored — **no CDN
at runtime**) and renders the camera dataset from `manifest.json` + `cams.js`.

It is **not** part of Torii Quest or Continuum: this is an independent app that
any NIP-5D shell can mount as a `srcdoc` iframe. It declares no `requires`
capabilities and uses no `window.napplet.*` API — a shell needs only to verify
the NIP-5A manifest, load the Blossom blobs, and write the verified HTML into
`sandbox="allow-scripts"`.

## Layout

- `index.html` — the napplet entry (self-contained map)
- `cams.js`, `manifest.json` — the camera dataset + tile manifest (same
  content as the web app; kept in sync from the repo root)
- `vendor/` — Leaflet 1.9.4 + leaflet.markercluster 1.5.3, fully vendored
- `build-manifest.mjs` — reproducible hash/path-tag/aggregate builder

## Build (emits unsigned events — it never signs)

```sh
node napplet/build-manifest.mjs
```

Produces, under `napplet/dist/`:

- `flock-map.nip5a.unsigned.json` — kind **35129** named-napplet manifest
  (`d`, `type`, `name`, `description`, `x` aggregate, `path` tags per file,
  `web`, `source`, `relays`)
- `flock-map.nip34.unsigned.json` — kind **30617** repo announcement

Both are complete except `id`/`sig` (and `created_at` is `0`). The operator
signs with their own tool and publishes — **no private key ever touches this
repo.**

## Trust model

- Identity is the `(dTag, aggregateHash)` pair (`flock-map` +
  `x` aggregate), which the shell binds to the iframe `contentWindow`.
- Only `path` tags participate in the aggregate hash (NIP-5A rule);
  other tags are ignored for equality.
- Blossom servers advertise where the blobs live (`server` tag / Blossom list);
  the shell downloads and re-hashes each blob before mounting.

## Basemap note

Raster tiles still come from Esri ArcGIS (keyless) because the map needs a
geographic backdrop; this is the same keyless basemap the web app uses. Notably
the tile endpoint is not part of the content-addressed bundle — swap it in
`index.html` if you stand up a self-hosted tile server.