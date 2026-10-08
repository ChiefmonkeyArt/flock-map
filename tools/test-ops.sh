#!/usr/bin/env bash
# tools/test-ops.sh — hermetic tests for the VPS deploy scripts (no root, no VPS).
# Exercises the payload validator through `flock-map-install-root --validate-only`
# and checks the dispatcher carries a byte-identical validator.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INST="$ROOT/ops/flock-map-install-root"
DISP="$ROOT/ops/flock-map-deploy"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1"; }

for f in "$INST" "$DISP" "$ROOT/ops/bootstrap-vps.sh"; do bash -n "$f" && ok "syntax $(basename "$f")" || bad "syntax $(basename "$f")"; done

extract() { sed -n '/^# --- BEGIN validate_payload/,/^# --- END validate_payload/p' "$1"; }
if [[ -n "$(extract "$INST")" ]] && diff <(extract "$INST") <(extract "$DISP") >/dev/null; then ok "validator identical in dispatcher and installer"; else bad "validator drift between dispatcher and installer"; fi

mk() { # <name> then build files under $T/<name>/ and tar them
  local d="$T/$1"; mkdir -p "$d"; (cd "$d" && printf '<html>' > index.html && printf 'x' > cams.js && printf '{}' > manifest.json && printf '1.2.0\n' > VERSION); echo "$d"
}
expect() { # <label> <want: ok|reject> <tarball>
  if bash "$INST" --validate-only "$3" >/dev/null 2>&1; then got=ok; else got=reject; fi
  [[ "$got" == "$2" ]] && ok "$1" || bad "$1 (wanted $2, got $got)"
}

d="$(mk good)"; tar -czf "$T/good.tgz" -C "$d" index.html cams.js manifest.json VERSION
expect "accepts the four-file payload" ok "$T/good.tgz"
tar -czf "$T/nover.tgz" -C "$d" index.html cams.js manifest.json
expect "rejects payload missing VERSION" reject "$T/nover.tgz"
d="$(mk extra)"; printf 'x' > "$d/evil.sh"; tar -czf "$T/extra.tgz" -C "$d" index.html cams.js manifest.json VERSION evil.sh
expect "rejects unexpected file" reject "$T/extra.tgz"
d="$(mk link)"; rm "$d/cams.js"; ln -s /etc/passwd "$d/cams.js"; tar -czf "$T/link.tgz" -C "$d" index.html cams.js manifest.json VERSION
expect "rejects symlink disguised as cams.js" reject "$T/link.tgz"
d="$(mk hard)"; ln "$d/index.html" "$d/hl"; rm "$d/cams.js"; mv "$d/hl" "$d/cams.js"; tar -czf "$T/hard.tgz" -C "$d" index.html cams.js manifest.json VERSION
expect "rejects hard link entry" reject "$T/hard.tgz"
d="$(mk trav)"; mkdir -p "$T/trav2/x"; cp "$d"/* "$T/trav2/x/"; tar -czf "$T/trav.tgz" -C "$T/trav2" x/index.html x/cams.js x/manifest.json x/VERSION
expect "rejects paths/directories" reject "$T/trav.tgz"
d="$(mk dup)"; tar -czf "$T/dup.tgz" -C "$d" index.html cams.js manifest.json VERSION index.html
expect "rejects duplicate entries" reject "$T/dup.tgz"
printf 'not a tarball' > "$T/junk.tgz"
expect "rejects non-tarball" reject "$T/junk.tgz"
d="$(mk big)"; head -c $((33 * 1024 * 1024)) /dev/zero > "$d/cams.js"; tar -czf "$T/big.tgz" -C "$d" index.html cams.js manifest.json VERSION
expect "rejects oversized unpacked payload" reject "$T/big.tgz"

# VERSION regex used by the installer
re='^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'
for v in 1.2.0 10.0.12; do [[ "$v" =~ $re ]] && ok "VERSION accepts $v" || bad "VERSION accepts $v"; done
for v in '1.2' 'v1.2.0' '1.2.0;rm' '$(id)' ''; do [[ ! "$v" =~ $re ]] && ok "VERSION rejects '$v'" || bad "VERSION rejects '$v'"; done
grep -qF "$re" "$INST" && ok "installer uses the tested VERSION regex" || bad "installer VERSION regex differs from test"

# nginx fragment must enable gzip for JS/JSON and roll back on nginx -t failure
grep -q 'gzip_types application/javascript application/json' "$INST" && ok "fragment gzips JS/JSON" || bad "fragment gzip_types"
[[ "$(grep -c 'X-Frame-Options "SAMEORIGIN"' "$INST")" -ge 3 && "$(grep -c 'X-Content-Type-Options "nosniff"' "$INST")" -ge 3 ]] && ok "fragment restores security headers in every location" || bad "security headers"
grep -q 'nginx -t' "$INST" && grep -q 'rolled back' "$INST" && ok "installer validates nginx and rolls back" || bad "nginx -t rollback"
grep -q -- '--version "\$VERSION"' "$INST" && ok "launcher tile version comes from payload VERSION" || bad "tile version not from VERSION"
grep -q 'tar -czf flock-release.tar.gz index.html cams.js manifest.json VERSION' "$ROOT/.github/workflows/deploy-flock-map.yml" && ok "workflow ships VERSION" || bad "workflow payload"

echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
