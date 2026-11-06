#!/usr/bin/env bash
# One-time VPS preparation (Phase 1B/F of the Hostinger rollout). Run as root on Ubuntu 24.04/26.04, from a
# checkout of this repository (e.g. /opt/workfolio/repo). Idempotent: safe to re-run. It installs packages,
# the workfolio user, directories, systemd units, Caddy and the firewall. It does NOT write secrets, does
# not migrate the database, does not deploy a release and does not harden SSH unless --harden-ssh is given.
#
#   install-vps.sh                 everything below except SSH hardening
#   install-vps.sh --harden-ssh    also: PermitRootLogin no, PasswordAuthentication no (only when an
#                                  authorized key already exists for the admin user you name in ADMIN_USER)
#
# Review before running; every step prints what it does. Take a Hostinger snapshot first.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
here="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"   # deploy/
: "${WORKFOLIO_USER:=workfolio}"
: "${ADMIN_USER:=$WORKFOLIO_USER}"
: "${NODE_MAJOR:=24}"
: "${SWAP_GB:=2}"
harden=0
[ "${1:-}" = "--harden-ssh" ] && harden=1
log() { printf '\n==> %s\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
log "packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git ufw fail2ban sqlite3 ffmpeg unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

log "ffmpeg: libx264 and WebP demuxer (required by the timelapse encoder)"
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 || { echo "ffmpeg without libx264" >&2; exit 1; }
ffmpeg -hide_banner -demuxers 2>/dev/null | grep -q webp_pipe || { echo "ffmpeg without webp_pipe" >&2; exit 1; }
ffmpeg -version | head -1

log "Node.js $NODE_MAJOR + corepack/pnpm"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  # NodeSource first (apt-managed updates), added by hand (signing key + sources entry; no remote script is
  # executed). If it has no build for this Ubuntu release yet (26.04 is new), fall back to the official
  # tarball from nodejs.org under /usr/local, linked as /usr/bin/node for the units.
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  if apt-get update -q && apt-get install -y -q nodejs && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]; then
    echo "  installed from NodeSource"
  else
    rm -f /etc/apt/sources.list.d/nodesource.list
    echo "  NodeSource unavailable for this release; installing the official tarball"
    tarball="node-$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" | grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz" | head -1)"
    tarball=${tarball#node-}
    [ -n "$tarball" ] || { echo "could not determine the Node ${NODE_MAJOR} tarball" >&2; exit 1; }
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$tarball" -o /tmp/node.tar.xz
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep " $tarball\$" | sed 's# .*# /tmp/node.tar.xz#' | sha256sum -c -
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner
    rm -f /tmp/node.tar.xz
    ln -sfn /usr/local/bin/node /usr/bin/node
    ln -sfn /usr/local/bin/corepack /usr/bin/corepack
  fi
fi
node --version
corepack enable
corepack install -g pnpm@11.9.0 2>/dev/null || corepack prepare pnpm@11.9.0 --activate
pnpm --version

log "Caddy (official apt repository)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi
caddy version

log "user $WORKFOLIO_USER"
id "$WORKFOLIO_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$WORKFOLIO_USER" --shell /bin/bash "$WORKFOLIO_USER"
# monitor.sh reads the API's journal (storage failures); members of systemd-journal may read it, nothing more.
usermod -aG systemd-journal "$WORKFOLIO_USER"

log "directories (tmpfiles.d)"
install -m 644 "$here/tmpfiles/workfolio.conf" /etc/tmpfiles.d/workfolio.conf
systemd-tmpfiles --create /etc/tmpfiles.d/workfolio.conf

log "environment file templates (only if missing; fill them in, mode 0640 root:$WORKFOLIO_USER)"
for f in api dashboard backup monitor; do
  if [ ! -e "/etc/workfolio/$f.env" ]; then
    install -m 640 -o root -g "$WORKFOLIO_USER" "$here/env/$f.env.example" "/etc/workfolio/$f.env"
    echo "  wrote /etc/workfolio/$f.env from the example: EDIT IT"
  fi
done
if [ ! -e /etc/caddy/workfolio.env ]; then
  install -m 640 -o root -g caddy "$here/caddy/workfolio.env.example" /etc/caddy/workfolio.env
  echo "  wrote /etc/caddy/workfolio.env from the example: set WORKFOLIO_DOMAIN and ACME_EMAIL"
fi

log "systemd units, journald limits"
install -m 644 "$here"/systemd/workfolio-*.service "$here"/systemd/workfolio-*.timer /etc/systemd/system/
install -d -m 755 /etc/systemd/journald.conf.d
install -m 644 "$here/journald/workfolio.conf" /etc/systemd/journald.conf.d/workfolio.conf
install -d -m 755 /etc/systemd/system/caddy.service.d
install -m 644 "$here/caddy/caddy-override.conf" /etc/systemd/system/caddy.service.d/override.conf
systemctl daemon-reload
systemctl restart systemd-journald
systemd-analyze verify /etc/systemd/system/workfolio-*.service /etc/systemd/system/workfolio-*.timer
systemctl enable workfolio-api workfolio-dashboard workfolio-backup.timer workfolio-monitor.timer >/dev/null
echo "  units enabled (not started: deploy a release first, then: systemctl start workfolio-backup.timer workfolio-monitor.timer)"

log "sudoers: $WORKFOLIO_USER may restart its own services (deploy.sh)"
cat > /etc/sudoers.d/workfolio <<EOF
$WORKFOLIO_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart workfolio-api, /usr/bin/systemctl restart workfolio-dashboard, /usr/bin/systemctl start workfolio-api, /usr/bin/systemctl stop workfolio-api
EOF
chmod 440 /etc/sudoers.d/workfolio
visudo -cf /etc/sudoers.d/workfolio

log "Caddyfile (validated; Caddy reloaded only if WORKFOLIO_DOMAIN is set)"
install -m 644 -o root -g caddy "$here/caddy/Caddyfile" /etc/caddy/Caddyfile
install -d -m 755 -o caddy -g caddy /var/log/caddy
if grep -qE '^WORKFOLIO_DOMAIN=(example\.com)?$' /etc/caddy/workfolio.env; then
  echo "  WORKFOLIO_DOMAIN not set yet: Caddy left as is (no public site until the domain exists)"
else
  (set -a; . /etc/caddy/workfolio.env; set +a; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile)
  systemctl enable --now caddy
  systemctl reload caddy
fi

log "swap ${SWAP_GB}G (build headroom)"
if ! swapon --show | grep -q .; then
  fallocate -l "${SWAP_GB}G" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-workfolio.conf && sysctl -q -p /etc/sysctl.d/90-workfolio.conf
fi
swapon --show

log "firewall: SSH, HTTP, HTTPS only (the apps listen on loopback; nothing else is reachable)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status verbose

log "fail2ban (sshd jail, defaults)"
systemctl enable --now fail2ban >/dev/null
fail2ban-client status sshd 2>/dev/null | head -3 || true

if [ "$harden" = 1 ]; then
  log "SSH hardening"
  keys="/home/$ADMIN_USER/.ssh/authorized_keys"
  [ -s "$keys" ] || { echo "refusing: no authorized key in $keys for $ADMIN_USER; add yours first" >&2; exit 1; }
  cat > /etc/ssh/sshd_config.d/70-workfolio-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 3
EOF
  sshd -t && systemctl reload ssh
  echo "  root and password logins are now refused; keep this session open and test a new key login as $ADMIN_USER"
fi

log "done. Next: fill /etc/workfolio/*.env and /etc/caddy/workfolio.env, then as $WORKFOLIO_USER: deploy/scripts/deploy.sh --migrate; then start the timers"
[ -f /var/run/reboot-required ] && echo "NOTE: a reboot is pending ($(cat /var/run/reboot-required.pkgs 2>/dev/null | tr '\n' ' '))"
exit 0
