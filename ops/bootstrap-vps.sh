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
PUBKEY_BLOB="${1:-}"

# The key arrives as the space-free base64 BLOB only (a full "ssh-ed25519 <blob> <comment>"
# line has spaces, which `sudo bash -s --` word-splits — this is exactly why the first
# attempt wrote a truncated authorized_keys entry). Reconstruct the full key here.
if [[ -z "$PUBKEY_BLOB" || ! "$PUBKEY_BLOB" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
  echo "error: expected an ssh-ed25519 public-key base64 blob (no spaces) as \$1" >&2
  exit 1
fi
PUBKEY="ssh-ed25519 ${PUBKEY_BLOB}"

# Derive the deploy user's REAL home (never assume /home/<user>).
# This mirrors quest/ops/install-deploy-ssh.sh (ADR-0101), the proven pattern.
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
DEPLOY_HOME="${DEPLOY_HOME:-/home/$DEPLOY_USER}"

BIN="/usr/local/bin/flock-map-deploy"
ROOT_INSTALL="/usr/local/sbin/flock-map-install-root"
STAGE_DIR="/var/lib/flock-map-deploy"
SUDOERS="/etc/sudoers.d/flock-map-deploy"
AUTHKEY="${DEPLOY_HOME}/.ssh/authorized_keys"

echo "==> deploy user: $DEPLOY_USER (home $DEPLOY_HOME)"

# --- 1+2. Install the dispatcher and pinned root installer FROM THE REPO FILES
# (ops/flock-map-deploy, ops/flock-map-install-root). The caller prepends
#   FLOCK_DISPATCHER_B64=<base64>  FLOCK_INSTALLER_B64=<base64>
# to this script on stdin, so what runs on the VPS is byte-for-byte the
# reviewed file at the deployed tag — no second hand-maintained copy here.
install_pinned() { # <b64> <dest>
  local b64="$1" dest="$2" tmp
  [[ -n "$b64" && "$b64" =~ ^[A-Za-z0-9+/=]+$ ]] || { echo "error: missing/invalid payload for $dest" >&2; exit 1; }
  tmp="$(mktemp "${dest}.XXXXXX")"
  printf '%s' "$b64" | base64 -d > "$tmp"
  bash -n "$tmp" || { rm -f "$tmp"; echo "error: $dest failed syntax check" >&2; exit 1; }
  chown root:root "$tmp"; chmod 0755 "$tmp"; mv -f "$tmp" "$dest"
  echo "==> installed $dest sha256=$(sha256sum "$dest" | cut -d' ' -f1)"
}
install -d -m 0755 /usr/local/bin /usr/local/sbin
install_pinned "${FLOCK_DISPATCHER_B64:-}" "$BIN"
install_pinned "${FLOCK_INSTALLER_B64:-}" "$ROOT_INSTALL"
install -d -m 0700 -o root -g root /var/backups/flock-map

# --- 3. Stage dir owned by the deploy user (dispatcher writes here)
install -d -m 0755 "$STAGE_DIR"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$STAGE_DIR"

# --- 4. Narrow sudoers rule: ONLY the pinned installer, no other capability
cat > "$SUDOERS" <<'SUDOERS'
# flock-map-deploy: deploy user may run ONLY the pinned root installer.
ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/flock-map-install-root
SUDOERS
chmod 0440 "$SUDOERS"
chown root:root "$SUDOERS"
visudo -c >/dev/null || { echo "sudoers syntax error" >&2; exit 1; }

# --- 5. Authorized key: forced command + no shell/pty/forwarding
install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh"
touch "$AUTHKEY"; chown "${DEPLOY_USER}:${DEPLOY_USER}" "$AUTHKEY"; chmod 0600 "$AUTHKEY"
ENTRY="command=\"${BIN}\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${PUBKEY} flock-map-deploy@github-actions"
# idempotent: drop any prior line carrying this pubkey, then append the current one.
grep -vF "${PUBKEY}" "$AUTHKEY" > "$AUTHKEY.tmp" 2>/dev/null || true
mv "$AUTHKEY.tmp" "$AUTHKEY"
printf '%s\n' "$ENTRY" >> "$AUTHKEY"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$AUTHKEY"; chmod 0600 "$AUTHKEY"

# --- 6. Self-verify WITHOUT dumping secrets: confirm the exact entry landed.
count="$(grep -cF "$PUBKEY" "$AUTHKEY" || true)"
echo "==> authorized_keys path: $AUTHKEY"
echo "==> pubkey present in authorized_keys (count, expect 1): $count"
echo "==> entry (public key + forced command only, no secret):"
grep -F "$PUBKEY" "$AUTHKEY"
[[ "$count" -eq 1 ]] || { echo "error: key did not land in authorized_keys" >&2; exit 1; }

echo "bootstrap complete: restricted flock-map deploy key authorized"