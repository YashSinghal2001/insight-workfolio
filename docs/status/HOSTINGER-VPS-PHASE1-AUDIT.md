# Insight Workfolio — Phase 1: Hostinger VPS Pre-Deployment Audit

**Date:** 2026-11-05 10:33–10:40 UTC · **Method:** read-only commands via the already-authenticated Hostinger Web Terminal (Brave) + read-only hPanel pages · **Changes made to the server:** none.

Status key: ✅ VERIFIED · ❓ NOT VERIFIED · ⚠️ WARNING · ⛔ BLOCKED

---

## 1. Server information

| Item | Finding | Status |
|---|---|---|
| Provider / plan | Hostinger KVM 2, `srv2130302.hstgr.cloud`, status Running, expires 2026-12-05 (hPanel) | ✅ |
| OS | **Ubuntu 26.04.1 LTS** (`VERSION_ID=26.04`) — **not** 24.04 as stated in the brief | ⚠️ |
| Kernel | `7.0.0-38-generic`; `7.0.0-42-generic` is installed and waiting for a reboot | ⚠️ |
| Architecture | `x86_64` | ✅ |
| Hostname | `srv2130302` | ✅ |
| Uptime | 2 h 15 min at audit time | ✅ |
| Date / time / TZ | `2026-11-05 10:33 UTC`, timezone `Etc/UTC`, clock synchronized (chrony) | ✅ |
| Reboot required | `/var/run/reboot-required` present (`linux-image-7.0.0-42-generic`, `linux-base`) | ⚠️ |

> OS mismatch: the brief said Ubuntu 24.04. The server is 26.04.1 LTS. Node 24 and the rest of the stack run fine on it, but any Phase 1B commands should target 26.04 (noble → resolute package names, newer systemd 259).

## 2. CPU, RAM and storage

| Item | Finding | Status |
|---|---|---|
| CPU | 2 vCPU, AMD EPYC 9354P, KVM full virtualization | ✅ |
| RAM | 7.7 GiB total, 536 MiB used, 7.2 GiB available | ✅ |
| Swap | **None** (`swapon --show` empty, `Swap: 0B`), swappiness 60 | ⚠️ |
| Disk | `/dev/sda` 100 G: `sda1` 98.9 G ext4 `/`, `sda13` 1 G ext4 `/boot`, `sda15` 106 M vfat `/boot/efi` | ✅ |
| Root FS | ext4, 96 G size, 2.0 G used, **94 G free (3 %)** | ✅ |
| Inodes | 12.4 M total, 68 k used (1 %) | ✅ |
| Load | `0.00 0.00 0.00`, 140 processes | ✅ |
| Top RSS | dockerd 90 MB, containerd 44 MB, monarx-agent 37 MB, unattended-upgrades 32 MB | ✅ |

## 3. Network readiness

| Item | Finding | Status |
|---|---|---|
| Interfaces | `eth0` UP `189.72.144.117/24` + IPv6 `2a02:4780:63:e134::1/48`; `docker0` DOWN `172.17.0.1/16`; `lo` | ✅ |
| Public IP | Outbound check (`ifconfig.me`) returned `189.72.144.117` — matches | ✅ |
| Default gateway | `189.72.144.254` via `eth0` | ✅ |
| DNS | systemd-resolved; servers `153.92.2.6` (Hostinger), `1.1.1.1`, `8.8.4.4`; `github.com`, `registry.npmjs.org`, `graph.microsoft.com` all resolve | ✅ |
| Listening ports | **Only `tcp/22` (sshd) is public.** Everything else is loopback: `:53` resolved, `:323` chronyd, `:1721`/`:65529` monarx-agent | ✅ |
| Web servers / proxies | None (no Caddy, nginx, Apache) | ✅ |
| UFW | installed, **`Status: inactive`** | ⚠️ |
| iptables / nftables | Policies `INPUT ACCEPT`, `FORWARD DROP`, `OUTPUT ACCEPT`; 15 of 18 rules are Docker's own chains; no host-level filtering | ⚠️ |
| Hostinger cloud firewall (hPanel) | No firewall created ("Protect your VPS with a firewall") | ⚠️ |

## 4. Security audit

| Item | Finding | Status |
|---|---|---|
| SSH service | `ssh.service` active; socket-activated (`ssh.socket` active/enabled — normal on 26.04) | ✅ |
| SSH port | 22 | ✅ |
| Root login | `PermitRootLogin yes` | ⚠️ |
| Password auth | `PasswordAuthentication yes`, `KbdInteractive no`, `UsePAM yes`, `MaxAuthTries 6` | ⚠️ |
| Pubkey auth | enabled | ✅ |
| sshd drop-ins | `50-cloud-init.conf`, `60-cloudimg-settings.conf` | ✅ |
| root authorized_keys | 1 entry, a **Hostinger-managed temporary key** (`expiry-time 2026-11-05 10:34 UTC`, used by the web terminal). No persistent deploy key → root is effectively **password-only** over SSH | ⚠️ |
| Non-root users | **None** (no uid ≥ 1000 accounts) | ⚠️ |
| sudo | `sudo` group empty; `/etc/sudoers.d/` has only `90-cloud-init-users` + README | ✅ |
| fail2ban | **inactive / not running** | ⚠️ |
| Failed SSH logins (24 h) | 0 in journal (server is only 2 h up; journal is short) | ❓ |
| unattended-upgrades | installed (2.12ubuntu9), `Update-Package-Lists 1`, `Unattended-Upgrade 1`, origins include `-security`, ESM apps/infra | ✅ |
| Pending updates | 10 packages upgradable (MOTD said 3; ESM Apps not enabled) | ⚠️ |
| AppArmor | active | ✅ |
| Monarx malware scanner | active; hPanel: last scan 13 min ago, 15 files, 0 compromised, 0 malicious; auto-removal inactive | ✅ |
| Password hashes / keys | not read, not printed | ✅ |

## 5. Installed software

| Package | Version | Status |
|---|---|---|
| git | 2.53.0 | ✅ |
| Node.js | NOT INSTALLED | ⛔ (prerequisite) |
| npm | NOT INSTALLED | ⛔ |
| pnpm | NOT INSTALLED | ⛔ |
| Corepack | NOT INSTALLED | ⛔ |
| Docker | 29.9.3 (build 5457199), service active/enabled, 0 containers / 0 images / 0 volumes | ✅ (unused) |
| Caddy | NOT INSTALLED | ⛔ |
| nginx / Apache | NOT INSTALLED | ✅ (no conflict) |
| PM2 | NOT INSTALLED | ✅ (not needed, systemd) |
| systemd | 259 (259.9-0ubuntu0.1) | ✅ |
| curl | 8.18.0 | ✅ |
| wget | 1.25.0 | ✅ |
| build-essential / gcc / make | NOT INSTALLED | ⚠️ (needed only if a native module compiles) |

## 6. Existing services and workloads

| Item | Finding | Status |
|---|---|---|
| Running services | chrony, containerd, cron, dbus, docker, getty, monarx-agent, networkd-dispatcher, polkit, qemu-guest-agent, rsyslog, ssh, systemd-* (journald/logind/networkd/resolved/udevd), unattended-upgrades | ✅ |
| Custom units in `/etc/systemd/system` | only distro aliases (chronyd, resolve1, multipathd, syslog) — no app services | ✅ |
| Failed units | none | ✅ |
| App directories | `/opt` has only `containerd`; `/home`, `/srv` empty; `/var/www` does not exist | ✅ |
| Containers | none | ✅ |
| Cron | `/etc/cron.d`: `docker-builder-prune`, `docker-image-prune` (daily 02:15 `docker image prune -af --filter until=24h`), `e2scrub_all`, `monarx-update`; root crontab empty | ✅ |
| Timers | standard apt-daily, logrotate, fstrim, sysstat, etc. | ✅ |

**Conclusion: this is a clean Hostinger "Ubuntu + Docker" template with no existing workloads. Nothing on it is at risk from a deployment.**

## 7. Backup verification (hPanel, read-only)

| Item | Finding | Status |
|---|---|---|
| Backup plan | Weekly (included). Daily backups are a paid upgrade (₹589/mo) | ✅ |
| Restore points | **"There are no backups yet."** First automatic backup on or after **2026-11-12** | ⚠️ |
| Snapshot | Manual "Create snapshot" available (1 slot); **none exists** | ⚠️ |
| In-VM backup agent | none (hypervisor-level only; `qemu-guest-agent` active for consistent snapshots) | ✅ |
| Limitation | Until 2026-11-12 there is **no restore point at all**. A manual snapshot before Phase 1B is the only rollback | ⚠️ |

## 8. Missing prerequisites

| # | Missing | Needed for |
|---|---|---|
| 1 | Node.js 24.x | API + Dashboard runtime |
| 2 | Corepack → pnpm 11.9.0 | monorepo install/build |
| 3 | Caddy | reverse proxy + TLS (install only after a domain exists; can be installed and left bound to localhost/no sites) |
| 4 | Non-root deploy user (e.g. `workfolio`) with sudo + SSH key | running services and deploying without root |
| 5 | Swap file (2 GB) | build headroom, see §9 |
| 6 | Firewall (UFW or Hostinger cloud firewall) | only 22/80/443 exposed |
| 7 | fail2ban (or disable SSH passwords) | brute-force protection on port 22 |
| 8 | Domain + DNS | public HTTPS, secure cookies, OneDrive OAuth redirect URI |
| 9 | Reboot | activate kernel 7.0.0-42 (do during Phase 1B maintenance, before any service is deployed) |
| 10 | build-essential | only if `pnpm install` needs to compile a native module (`better-sqlite3`/`libsql` ship prebuilt binaries for x86_64; install only on failure) |

## 9. Workfolio deployment compatibility

**Verdict: compatible. 2 vCPU / 8 GB / 100 GB is comfortably sufficient for staging.**

Runtime budget (measured + estimates):

| Component | RAM |
|---|---|
| OS + Docker + monarx + journald baseline (measured) | ~540 MB |
| NestJS API idle (measured) | ~170 MB |
| Next.js dashboard (standalone server, estimate) | ~250–400 MB |
| Caddy | ~30–50 MB |
| Background jobs / OneDrive uploads (inside API) | ~100–200 MB bursts |
| **Steady state total** | **~1.2–1.4 GB** |

Build budget: API ~444 MB peak, Dashboard ~920 MB peak. Sequential builds peak ≈ 1.0 GB on top of ~1.4 GB steady → ~2.5 GB, leaving ~5 GB free. Parallel builds (`turbo` with both) peak ≈ 1.5 GB extra — still fine.

Recommendations:

- **Swap: yes, 2 GB file**, `vm.swappiness=10`. Not for normal operation (RAM is ample) but as an OOM safety net during builds while the API/dashboard are running, and Next.js build is occasionally spiky beyond its measured peak. 94 GB free disk makes this free.
- **Build strategy:** build on the VPS sequentially (`pnpm --filter api build` then dashboard), or build in CI and `rsync`/`scp` artifacts. Both fit; sequential is the lazy default.
- **CPU:** 2 vCPU means builds take minutes, not seconds; run builds off-peak and never both at once if staging is in use.
- **Docker:** installed but unused (0 containers). Leave it; it costs ~130 MB RSS and the prune crons. Optionally `systemctl disable --now docker containerd` in Phase 1B to reclaim RAM and remove its iptables chains — your call, not required.
- **Disk:** 94 GB free; node_modules + builds + logs + screenshots cache will stay well under 20 GB. OneDrive is the screenshot store, not local disk.
- **Turso:** hosted libSQL, outbound HTTPS only — no local DB, no port to open. DNS/outbound verified working.

### Domain and HTTPS planning (no action in Phase 1)

Needed before public exposure:

| Record | Name | Type | Value |
|---|---|---|---|
| Dashboard | `app.<domain>` | A | `189.72.144.117` |
| API | `api.<domain>` | A | `189.72.144.117` |
| (optional) | `app.<domain>` / `api.<domain>` | AAAA | `2a02:4780:63:e134::1` |
| (optional) apex | `<domain>` | A | `189.72.144.117` → Caddy redirect to `app.` |

- **Same parent domain** for `app.` and `api.` is required: the API sets the session cookie with `Domain=.<domain>`, `Secure`, `SameSite=Lax/None`, so the dashboard on `app.` can send it to `api.` as a first-party cookie. With two unrelated domains the cookie would be third-party and modern browsers drop it.
- **Keep the existing secure-cookie configuration** (`secure: true`, `httpOnly`, `sameSite`, domain scoping). Do not relax it for staging: Caddy terminates TLS automatically (Let's Encrypt), so staging will be HTTPS from day one and the config works unchanged. Relaxing it "temporarily" is how it ends up relaxed in production.
- Caddy's `Caddyfile` will have two site blocks: `app.<domain>` → `reverse_proxy localhost:3000` (Next.js) and `api.<domain>` → `reverse_proxy localhost:4000` (NestJS). Both apps bind to `127.0.0.1` only; the firewall exposes only 22/80/443.
- OneDrive (Microsoft identity) OAuth redirect URI must be registered as `https://api.<domain>/...` — this needs the domain to exist, so OneDrive auth is blocked until DNS is done.
- Until a domain exists, staging can be reached only via an SSH tunnel (`ssh -L 3000:localhost:3000`) — nothing public.

## 10. Recommended security changes — proposed Phase 1B plan (needs your approval)

Nothing below has been run. Order matters.

| Step | Action | Why |
|---|---|---|
| 0 | **Create a manual snapshot in hPanel** (Snapshots & Backups → Create snapshot) | Only rollback point until the first weekly backup on 2026-11-12 |
| 1 | `apt update && apt upgrade` (10 pending), then **reboot** to kernel 7.0.0-42 | Already flagged by the OS; do it before anything is deployed |
| 2 | Create non-root user `workfolio`, add to `sudo`, install **your** public key into its `authorized_keys` | Root-password SSH is the single biggest risk; the only root key present expires today |
| 3 | sshd drop-in `/etc/ssh/sshd_config.d/70-hardening.conf`: `PermitRootLogin no`, `PasswordAuthentication no`, `MaxAuthTries 3` — only after step 2 is tested from your Mac | Closes password brute-force on port 22 |
| 4 | Enable UFW: `default deny incoming`, `allow 22/tcp`, `allow 80/tcp`, `allow 443/tcp`, enable | Host firewall; Docker's chains are unaffected. (Alternative: the free Hostinger cloud firewall in hPanel with the same 3 rules) |
| 5 | Install and enable **fail2ban** (sshd jail, defaults) | Belt-and-braces with step 3; cheap |
| 6 | Create 2 GB swap file, `vm.swappiness=10`, persist in `/etc/fstab` and `sysctl.d` | Build safety net (§9) |
| 7 | Install Node.js 24 LTS (NodeSource or `nvm` under the `workfolio` user), `corepack enable`, `corepack prepare pnpm@11.9.0 --activate` | Runtime prerequisites |
| 8 | Install Caddy (official apt repo) but **do not** write a public Caddyfile yet; leave it stopped or serving nothing | Ready for the domain; nothing exposed |
| 9 | (optional) `systemctl disable --now docker containerd` and remove the two docker prune cron files | Unused; reclaims ~130 MB and simplifies iptables. Skip if you may want containers later |
| 10 | Verify: `ssh workfolio@189.72.144.117` with key works, root/password login rejected, `ufw status`, `fail2ban-client status sshd`, `node -v`, `pnpm -v`, `free -h` shows swap | Phase 1B exit criteria |

Not in Phase 1B (needs domain first): Caddyfile, DNS, TLS, OneDrive OAuth redirect, cloning the repo, `.env`, migrations, systemd units for api/dashboard.

---

### Appendix — commands run (all read-only)

OS/HW: `grep /etc/os-release`, `uname -rm`, `hostname`, `uptime`, `timedatectl`, `nproc`, `lscpu`, `free -h`, `swapon --show`, `lsblk`, `df -hT`, `df -i`, `/proc/loadavg`, `ps --sort=-rss`
Network: `ip -br addr`, `ip route`, `curl ifconfig.me`, `resolvectl status`, `getent hosts`, `ss -tulpn`, `ufw status verbose`, `iptables -S`, `nft list ruleset | wc -l`
Security: `systemctl is-active/is-enabled ssh ssh.socket fail2ban apparmor monarx-agent`, `sshd -T` (filtered), `ls /etc/ssh/sshd_config.d`, authorized_keys line **count + comment only**, `awk /etc/passwd` (uid ≥ 1000, no hashes), `getent group sudo`, `ls /etc/sudoers.d`, `dpkg -l unattended-upgrades`, `cat 20auto-upgrades`, `grep 50unattended-upgrades`, `journalctl -u ssh` (count only), `apt list --upgradable` (count), `/var/run/reboot-required*`
Software: `command -v` + `--version` for each tool, `dpkg-query build-essential`, `docker ps -a / images / volume ls`
Workloads: `systemctl list-units --state=running`, `ls /etc/systemd/system`, `systemctl --failed`, `ls /opt /srv /var/www /home`, `ls /etc/cron.d`, `crontab -l` (count), `systemctl list-timers`
hPanel (read-only pages): VPS list, Overview, Snapshots & Backups, Firewall, Malware Scanner
