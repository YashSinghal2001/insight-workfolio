#!/usr/bin/env bash
# Insight Workfolio — Phase 1 READ-ONLY VPS audit.
# Changes nothing: no installs, no service/firewall/user/permission changes.
# Prints no secrets: no shadow hashes, keys, env files or tokens.
# Run from your Mac:  ssh root@189.72.144.117 'bash -s' < vps-audit.sh > vps-audit.txt 2>&1
set -u
export LC_ALL=C
s() { printf '\n===== %s =====\n' "$1"; }
v() { if command -v "$1" >/dev/null 2>&1; then printf '%-16s ' "$1"; shift; "$@" 2>&1 | head -1; else printf '%-16s NOT INSTALLED\n' "$1"; fi; }

s "A. OS"
whoami; hostname; cat /etc/os-release | grep -E '^(PRETTY_NAME|VERSION_ID|VERSION_CODENAME)='
uname -r; uname -m; uptime -p; uptime
timedatectl 2>/dev/null | grep -E 'Local time|Time zone|NTP|synchronized' || date

s "B. CPU"
nproc; lscpu | grep -E '^(Model name|CPU\(s\)|Thread|Core|Socket|Virtualization|Hypervisor)'
s "B. MEMORY / SWAP"
free -h; swapon --show; cat /proc/sys/vm/swappiness
s "B. DISK"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT; df -hT -x tmpfs -x devtmpfs -x overlay; df -i /
s "B. LOAD / TOP PROCESSES"
cat /proc/loadavg
ps -eo pid,user,%cpu,%mem,rss,comm --sort=-rss | head -15

s "C. NETWORK INTERFACES"
ip -br addr; ip route | grep default
s "C. PUBLIC IP (outbound check)"
curl -s -4 --max-time 8 https://ifconfig.me || echo "curl failed"; echo
s "C. DNS"
resolvectl status 2>/dev/null | grep -E 'DNS Servers|Current DNS' | head -5
getent hosts github.com registry.npmjs.org login.microsoftonline.com graph.microsoft.com | head -8
s "C. LISTENING PORTS"
ss -tulpn
s "C. FIREWALL"
ufw status verbose 2>&1
nft list ruleset 2>/dev/null | grep -cE 'rule|accept|drop' | sed 's/^/nft rule-ish lines: /'
iptables -S 2>/dev/null | head -30

s "D. SSH"
systemctl is-active ssh 2>/dev/null; systemctl is-enabled ssh 2>/dev/null
sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|challengeresponseauthentication|permitemptypasswords|maxauthtries|x11forwarding|allowusers|allowgroups|usepam) '
ls /etc/ssh/sshd_config.d/ 2>/dev/null
printf 'root authorized_keys entries: '; [ -f /root/.ssh/authorized_keys ] && grep -cvE '^\s*(#|$)' /root/.ssh/authorized_keys || echo 0
s "D. USERS (uid>=1000, no hashes)"
awk -F: '$3>=1000 && $3<65534 {print $1, "uid="$3, "shell="$7, "home="$6}' /etc/passwd
printf 'sudo group: '; getent group sudo | cut -d: -f4
printf 'admin group: '; getent group admin | cut -d: -f4
ls /etc/sudoers.d/ 2>/dev/null
printf 'accounts with login shell: '; awk -F: '$7 !~ /(nologin|false|sync|halt|shutdown)$/ {printf "%s ", $1}' /etc/passwd; echo
s "D. RECENT LOGINS (no IPs beyond last 5)"
last -n 5 -a 2>/dev/null | head -7
printf 'failed SSH attempts in journal (24h): '; journalctl -u ssh --since '24 hours ago' 2>/dev/null | grep -ciE 'failed password|invalid user'
s "D. FAIL2BAN / UNATTENDED UPGRADES / SECURITY SERVICES"
systemctl is-active fail2ban 2>&1; fail2ban-client status 2>/dev/null | head -5
dpkg -l unattended-upgrades 2>/dev/null | grep -E '^ii' || echo "unattended-upgrades not installed"
cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null
systemctl is-active apparmor 2>&1; aa-status --enabled 2>/dev/null && echo "apparmor enabled"
for svc in auditd clamav-daemon crowdsec ufw; do printf '%s: ' "$svc"; systemctl is-active "$svc" 2>&1; done
s "D. PENDING UPDATES (no changes, cached lists only)"
apt list --upgradable 2>/dev/null | grep -c upgradable | sed 's/^/upgradable packages: /'
apt list --upgradable 2>/dev/null | grep -ci security | sed 's/^/security-pocket packages: /'
[ -f /var/run/reboot-required ] && echo "REBOOT REQUIRED" || echo "no reboot required flag"

s "E. SOFTWARE VERSIONS"
v git git --version
v node node --version
v npm npm --version
v pnpm pnpm --version
v corepack corepack --version
v docker docker --version
v caddy caddy version
v nginx nginx -v
v apache2 apache2 -v
v pm2 pm2 --version
v systemctl systemctl --version
v curl curl --version
v wget wget --version
v gcc gcc --version
v make make --version
dpkg -l build-essential 2>/dev/null | grep -E '^ii' || echo "build-essential   NOT INSTALLED"

s "F. RUNNING SERVICES"
systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}'
s "F. CUSTOM SYSTEMD UNITS (/etc/systemd/system)"
ls /etc/systemd/system/*.service 2>/dev/null
s "F. FAILED UNITS"
systemctl --failed --no-pager --no-legend
s "F. APP DIRECTORIES (names only)"
ls -la /opt /srv /var/www /home 2>/dev/null
du -sh /opt/* /srv/* /var/www/* /home/* 2>/dev/null | head -20
s "F. CONTAINERS"
command -v docker >/dev/null && { docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>&1; docker volume ls 2>&1 | head; } || echo "docker not installed"
s "F. CRON / TIMERS"
ls /etc/cron.d/ 2>/dev/null; printf 'root crontab lines: '; crontab -l 2>/dev/null | grep -cvE '^\s*(#|$)'
systemctl list-timers --all --no-pager --no-legend | awk '{print $(NF-1), $NF}'

s "G. BACKUP / SNAPSHOT HINTS (in-VM only)"
systemctl list-units --no-pager --no-legend | grep -iE 'backup|snapshot|qemu-guest|hostinger' || echo "no backup-related units"
ls /etc/hostinger* /opt/hostinger* 2>/dev/null || echo "no hostinger agent files"
echo "Note: Hostinger backups are hypervisor-level; restore points are only visible in hPanel."

s "DONE"
date -u
