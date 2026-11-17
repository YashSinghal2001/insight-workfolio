#!/usr/bin/env bash
# ONE-TIME, as root on the VPS (needs approval: it changes sshd configuration and folder ownership).
# Creates the restricted identity GitHub Actions publishes desktop installers with:
#
#   install-desktop-publisher.sh <public-key-file>
#
# - system user `workfolio-publisher`: no password, root-owned home and authorized_keys (it cannot edit its
#   own key options), no sudo, not in any workfolio group
# - its key may run exactly one program, the receiver (authorized_keys `restrict,command=` AND sshd
#   `ForceCommand`): no shell, no sftp/scp, no forwarding, no tty
# - /srv/workfolio-downloads becomes root:workfolio-publisher 1775 (group-writable + STICKY). The publisher can
#   add files and replace only files it owns (its manifest); it cannot delete, rename or replace the root-owned
#   installers already there (rollback copies). Owning the folder would NOT be enough: a directory owner may
#   unlink any entry, sticky bit or not.
# - seeds /srv/workfolio-downloads/desktop-releases.json from the repo copy if none exists yet
# Re-running is safe; it replaces the key with the one given.
. "$(dirname "$(readlink -f "$0")")/lib.sh"
here="$(dirname "$(readlink -f "$0")")"
pub=${1:-}
user=workfolio-publisher
home=/var/lib/workfolio-publisher
dir=/srv/workfolio-downloads
receiver=/usr/local/lib/workfolio/desktop-downloads-receiver

[ "$(id -u)" = 0 ] || die "run as root"
[ -r "$pub" ] || die "usage: $0 <public-key-file>"
need python3
need sshd
[ "$(wc -l < "$pub")" -le 1 ] && ssh-keygen -lf "$pub" >/dev/null || die "$pub is not a single SSH public key"
case "$(cut -d' ' -f1 "$pub")" in ssh-ed25519) ;; *) die "use an ed25519 key" ;; esac

log "user $user"
id "$user" >/dev/null 2>&1 || useradd --system --home-dir "$home" --no-create-home --shell /bin/sh "$user"
passwd -l "$user" >/dev/null
install -d -m 755 -o root -g root "$home" "$home/.ssh"
printf 'restrict,command="%s" %s\n' "$receiver" "$(cut -d' ' -f1,2 "$pub")" > "$home/.ssh/authorized_keys"
chown root:root "$home/.ssh/authorized_keys"; chmod 644 "$home/.ssh/authorized_keys"

log "receiver $receiver"
install -d -m 755 -o root -g root /usr/local/lib/workfolio
install -m 755 -o root -g root "$here/desktop-downloads-receiver.py" "$receiver"

log "downloads folder $dir (root:$user 1775)"
install -d -m 755 -o root -g root "$dir"
chown root:"$user" "$dir"
chmod 1775 "$dir"
manifest="$dir/desktop-releases.json"
[ ! -L "$manifest" ] || die "$manifest is a symlink; inspect the folder"
if [ ! -e "$manifest" ]; then
  install -m 644 -o "$user" -g "$user" "$here/../../apps/dashboard/src/lib/desktop-releases.json" "$manifest"
else
  # The receiver replaces it by rename, which the sticky bit allows only for its owner.
  chown -h "$user:$user" "$manifest"; chmod 644 "$manifest"
fi
sudo -u "$user" "$receiver" status >/dev/null || die "receiver cannot read the manifest"

log "sshd: force the receiver for $user"
conf=/etc/ssh/sshd_config.d/60-workfolio-publisher.conf
cat > "$conf" <<EOF
# Desktop installer publishing (deploy/scripts/install-desktop-publisher.sh). Key only, one program, nothing else.
Match User $user
	AuthenticationMethods publickey
	ForceCommand $receiver
	DisableForwarding yes
	PermitTTY no
	PermitTunnel no
	PermitUserRC no
	AllowTcpForwarding no
	AllowStreamLocalForwarding no
	AllowAgentForwarding no
	X11Forwarding no
	GatewayPorts no
EOF
chmod 644 "$conf"
sshd -t || { rm -f "$conf"; die "sshd rejected the configuration; removed $conf, nothing reloaded"; }
eff=$(sshd -T -C "user=$user,host=localhost,addr=127.0.0.1")
grep -qx "forcecommand $receiver" <<<"$eff" && grep -qx "permittty no" <<<"$eff" && grep -qx "allowtcpforwarding no" <<<"$eff" \
  || { rm -f "$conf"; die "sshd does not apply the Match block (an earlier Include/Match overrides it?); removed $conf"; }
# Ubuntu 24.04 starts sshd per connection via ssh.socket (config read fresh); otherwise reload the daemon.
systemctl try-reload-or-restart ssh
log "done. Host key line for the GitHub secret DESKTOP_PUBLISH_KNOWN_HOSTS:"
for k in /etc/ssh/ssh_host_ed25519_key.pub; do printf '%s %s\n' "${WORKFOLIO_PUBLIC_IP:-<host>}" "$(cut -d' ' -f1,2 "$k")"; done
