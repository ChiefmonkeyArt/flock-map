#!/usr/bin/env bash
# bootstrap-vps.sh — ONE-TIME privileged setup for the restricted flock-map
# deploy key. Runs as root on the VPS (via a pre-existing, temporary broad-sudo
# path). Idempotent: safe to re-run.
#
# It leaves behind NO broad sudo: the only new capability is a forced-command
# key that can run /usr/local/bin/flock-map-deploy (a whitelist-validating
# dispatcher) and its pinned root installer via ONE fixed sudoers rule.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

DEPLOY_USER="ubuntu"
PUBKEY="$1"                          # the flock-map-deploy ed25519 public key

BIN="/usr/local/bin/flock-map-deploy"
ROOT_INSTALL="/usr/local/sbin/flock-map-install-root"
STAGE_DIR="/var/lib/flock-map-deploy"
SUDOERS="/etc/sudoers.d/flock-map-deploy"

# --- 1. Write the forced-command dispatcher (root-owned, not ubuntu-writable)
install -d -m 0755 /usr/local/bin /usr/local/sbin
cat > "$BIN" <<'SCRIPT'
#!/usr/bin/env bash
# flock-map-deploy — forced-command entrypoint for the flock-map deploy key.
# Runs AS `ubuntu`. Reads a gzipped tarball on stdin, validates a strict
# whitelist, then hands off to the pinned root installer via fixed sudoers.
set -euo pipefail
STAGE_DIR="/var/lib/flock-map-deploy"
STAGE="${STAGE_DIR}/incoming.tar.gz"
mkdir -p "$STAGE_DIR"
if ! cat > "$STAGE"; then echo "error: failed to read payload" >&2; rm -f "$STAGE"; exit 1; fi
size="$(stat -c%s "$STAGE" || echo 0)"
[[ "$size" != "0" ]] || { echo "error: empty payload" >&2; rm -f "$STAGE"; exit 1; }
listing="$(tar -tzf "$STAGE" 2>/dev/null)" || { echo "error: not a valid gzip tarball" >&2; rm -f "$STAGE"; exit 1; }
for f in $listing; do
  case "$f" in
    index.html|cams.js|manifest.json) ;;
    *) echo "error: unexpected entry '$f'" >&2; rm -f "$STAGE"; exit 1;;
  esac
done
for f in index.html cams.js manifest.json; do
  grep -qxF "$f" <<<"$listing" || { echo "error: missing required file '$f'" >&2; rm -f "$STAGE"; exit 1; }
done
exec sudo -n "$ROOT_INSTALL" "$STAGE"
SCRIPT
chown root:root "$BIN"; chmod 0755 "$BIN"

# --- 2. Write the pinned root installer (root-owned, NOT ubuntu-writable)
cat > "$ROOT_INSTALL" <<'SCRIPT'
#!/usr/bin/env bash
# flock-map-install-root — pinned root installer (fixed-path sudoers target).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
APP="flock-map"; APPS_ROOT="/apps"
APP_ROOT="${APPS_ROOT}/${APP}"
RELEASE_DIR="${APP_ROOT}/releases/$(date +%Y%m%d-%H%M%S)"
CURRENT_LINK="${APP_ROOT}/current"; DATA_DIR="${APP_ROOT}/data"
FRAGMENT_FILE="/opt/torii/nginx-fragments/${APP}.conf"
BUNDLE="$1"
[[ "$#" -eq 1 && -f "$BUNDLE" ]] || { echo "usage: installer <tarball>" >&2; exit 1; }
listing="$(tar -tzf "$BUNDLE" 2>/dev/null)" || { echo "invalid tarball" >&2; exit 1; }
for f in $listing; do
  case "$f" in index.html|cams.js|manifest.json) ;; *) echo "unexpected '$f'" >&2; exit 1;; esac
done
install -d -m 0755 "${RELEASE_DIR}" "${DATA_DIR}"
tar -xzf "$BUNDLE" -C "${RELEASE_DIR}"
chown -R root:www-data "${RELEASE_DIR}" "${DATA_DIR}"
ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
install -d -m 0755 /opt/torii/nginx-fragments
cat > "${FRAGMENT_FILE}" <<'NGINX'
location /flock-map/ {
    alias /apps/flock-map/current/;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
}
location = /flock-map {
    return 301 /flock-map/;
}
location = /flock-map/index.html {
    alias /apps/flock-map/current/index.html;
    add_header Cache-Control "no-store" always;
}
NGINX
/usr/local/bin/torii register "${APP}" --display "Flock Map" --desc "Flock Safety / ALPR camera surveillance map" --version "1.0.0"
/usr/local/bin/torii reload
rm -f "$BUNDLE"
echo "flock-map installed"
SCRIPT
chown root:root "$ROOT_INSTALL"; chmod 0755 "$ROOT_INSTALL"

# --- 3. Stage dir owned by the deploy user (dispatcher writes here)
install -d -m 0755 "$STAGE_DIR"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$STAGE_DIR"

# --- 4. Narrow sudoers rule: ONLY the pinned installer, no other capability
cat > "$SUDOERS" <<'SUDOERS'
# flock-map-deploy: deploy user may run ONLY the pinned root installer.
ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/flock-map-install-root
SUDOERS
chmod 0440 "$SUDOERS"
visudo -c >/dev/null || { echo "sudoers syntax error" >&2; exit 1; }

# --- 5. Authorized key: forced command + no shell/pty/forwarding
AUTHKEY_DIR="/home/${DEPLOY_USER}/.ssh"
AUTHKEY="${AUTHKEY_DIR}/authorized_keys"
install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "$AUTHKEY_DIR"
touch "$AUTHKEY"; chown "${DEPLOY_USER}:${DEPLOY_USER}" "$AUTHKEY"; chmod 0600 "$AUTHKEY"
ENTRY="command=\"${BIN}\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${PUBKEY} flock-map-deploy@github-actions"
# idempotent: remove any prior entry for this pubkey, then append
if grep -qF "${PUBKEY}" "$AUTHKEY"; then
  grep -vF "${PUBKEY}" "$AUTHKEY" > "$AUTHKEY.tmp" && mv "$AUTHKEY.tmp" "$AUTHKEY"
fi
printf '%s\n' "$ENTRY" >> "$AUTHKEY"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$AUTHKEY"; chmod 0600 "$AUTHKEY"

echo "bootstrap complete: restricted flock-map deploy key authorized"