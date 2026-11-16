# Phase 1B deployment readiness audit (Hostinger VPS), corrected

**Date:** 2026-11-06 (revision 3: VPS facts re-verified read-only through the Brave web terminal, session user
`workfolio`, no root) · **Audit only:** nothing installed, changed, migrated, connected, pushed or committed; this
file is the only new artifact (uncommitted) · **Branch/commit audited:** `deploy/hostinger-vps` @
`ee053a0998922662fada9f2cd2d3873a4c2252bd`, working tree clean apart from this file.

Status key: ✅ VERIFIED (seen in code, from this machine, or on the VPS on 2026-11-06) · ❓ NOT VERIFIED (needs
root on the VPS, the domain or the tenant; the web-terminal session is the unprivileged `workfolio` user and no
password was entered) · ⛔ BLOCKED (needs a decision or action).

## 0. Summary

| Area | Status | One line |
|---|---|---|
| 1 Git and deployment | ⛔ | Code ready; `deploy.sh` needs **only an explicit ref argument**, no code change. Blocked on the push of `deploy/hostinger-vps` (GitHub has only `main`) and on choosing where the VPS clone lives (`/home/workfolio/app` today vs `/opt/workfolio/repo` expected) |
| 2 VPS readiness | ✅ / ❓ | Verified on the VPS: hardening drop-in, UFW and fail2ban active+enabled, only port 22 public, 2 GB swap + swappiness 10 persisted, kernel 7.0.0-42 (no reboot pending), Node 24.22.2 at `/usr/bin/node` from NodeSource, pnpm 11.9.0, gpg 2.4.8, both users, non-shallow clone with SSH origin. Root-only checks (`sshd -T`, `ufw status`, `fail2ban-client`, Docker containers, sudoers) not verified. The passphrase-protected deploy key mismatch found in revision 3 was **resolved on 2026-11-06 17:00 UTC** with a new passphrase-less read-only deploy key (§2a item 1): non-interactive `git fetch` now works |
| 3 Hostname | ✅ | Decided: single origin `https://189.72.144.117` via `Caddyfile.ip` + Let's Encrypt short-lived IP certificate; no DNS needed; values in §3 |
| 4 OneDrive | ⛔ | The **existing** Entra registration must **not** be reused (SEC-11, documented); a **new** delegated registration is required, whose redirect URI needs the domain |
| 5 Backups and monitoring | ⛔ | Scripts ready; passphrase file to create on the VPS; two decisions open |
| 6 Deployment sequence | ✅ | Re-ordered for the already-done steps; approval gates unchanged |

**Earliest safe point to open Insight Workfolio in a browser:** unchanged: after stage D (first `deploy.sh
--migrate` succeeded, Caddy holds a certificate for `app.<domain>`, first admin created), at `https://app.<domain>`,
before OneDrive is connected. No earlier path exists: both apps bind to loopback, cookies are `Secure` and
`SameSite=Strict`, so there is no IP-address or plain-HTTP route.

---

## 1. Git and deployment

| Check | Finding | Status |
|---|---|---|
| Branch / commit | `deploy/hostinger-vps` @ `ee053a0`, one commit ahead of `main` (`ad869af`) | ✅ |
| Working tree | clean (this report excepted) | ✅ |
| Remote | `origin` = `https://github.com/YashSinghal2001/insight-workfolio.git`, **private**. **Pushed 2026-11-06:** `refs/heads/deploy/hostinger-vps` @ `ee053a0`; `main` still @ `ad869af` (not merged). The VPS clone can now fetch the branch with the read-only deploy key | ✅ |
| Deploy key | **Replaced 2026-11-06 (owner-approved option 2).** New key `~/.ssh/github_deploy_ro_ed25519` (Ed25519, no passphrase, 0600, `workfolio`), fingerprint `SHA256:id2M6mbu1L8Vd18cCXiHZh8iQJgO1sPMHu4Pm2xNNGk`, registered on the repository as deploy key "srv2130302 workfolio read-only" (read-only, no write access). `~/.ssh/config` now pins it (`IdentitiesOnly yes`); the previous config is kept as `~/.ssh/config.bak-20261106`. Verified: `ssh -T -o BatchMode=yes git@github.com` authenticates as the repository; `git ls-remote --heads origin` and `git fetch --prune origin` complete with exit 0 and **no prompt**. The old passphrase-protected key and its GitHub entry "Hostinger Workfolio VPS" (`SHA256:qBlHhJZQ5ewNvvlR31z/fbOhiUvzZKaNro1BQq7rOrY`) were **removed on 2026-11-06 with the owner's approval**: GitHub deploy key id 168877884 deleted (only "srv2130302 workfolio read-only" remains, read-only), `github_deploy_ed25519`, its `.pub` and `config.bak-20261106` shredded (`shred -u -z`) on the VPS; a non-interactive `git fetch` afterwards exits 0 | ✅ |
| How `deploy.sh` handles a pushed `deploy/hostinger-vps` | `ref` defaults to `origin/main`; **any first non-option argument is the ref**. The script does `git fetch --prune origin` (fetches all branches with the default refspec of a normal clone) then `git rev-parse --verify "<ref>^{commit}"` and `git archive <sha>`. So `deploy.sh origin/deploy/hostinger-vps --migrate` builds exactly the pushed commit; the working tree of the clone is never used. Requirements: a non-shallow clone whose `origin` is the GitHub repository (verified above) | ✅ code; **no code change required, only the ref argument** |
| Clone state | verified: `/home/workfolio/app`, owner `workfolio:workfolio` 775, `origin git@github.com:YashSinghal2001/insight-workfolio.git`, **not shallow**, branch `main` @ `ad869af` (pre-VPS code; `deploy/hostinger-vps` cannot be there until pushed), clean tree, `node_modules/` present from a `pnpm install` on 2026-11-05 (unused by `deploy.sh`, which builds releases from `git archive`) | ✅ |
| Clone location | `deploy.sh` uses `repo="$WORKFOLIO_ROOT/repo"` = `/opt/workfolio/repo` (hard-coded relative to `WORKFOLIO_ROOT`, which also drives `releases/` and `current`, and `/opt/workfolio/current` is hard-coded in the four units). The owner's clone is at `/home/workfolio/app`. Two ways, **no code change**: (a) after `install-vps.sh` created `/opt/workfolio` (owner `workfolio`), `sudo -u workfolio mv /home/workfolio/app /opt/workfolio/repo` (recommended: one clone, the deploy key in `/home/workfolio/.ssh` keeps working), or (b) leave `/home/workfolio/app` and let `deploy.sh` make its own clone with `WORKFOLIO_REPO_URL=git@github.com:YashSinghal2001/insight-workfolio.git` (two clones to keep in sync). A one-line code change (`: "${WORKFOLIO_REPO:=$WORKFOLIO_ROOT/repo}"` in `deploy.sh`) would allow a custom path; **not recommended** and not made | ⛔ decision (a) or (b) |
| `install-vps.sh` source | runs as root from any checkout; root can read `/home/workfolio/app` (no root clone needed). Run it from that checkout **after** `sudo -u workfolio git -C /home/workfolio/app fetch origin && git -C /home/workfolio/app checkout deploy/hostinger-vps` so the `deploy/` directory exists there | ✅ |
| `install-vps.sh` against the already-done configuration | idempotent by design: `useradd` skipped (user exists); `usermod -aG systemd-journal` additive; swap step skipped when `swapon --show` is non-empty (it then does **not** write `vm.swappiness`, already set by the owner); UFW re-applies `deny incoming` / `allow OpenSSH, 80/tcp, 443/tcp` and `--force enable` (an existing `22/tcp` rule stays; harmless duplicate); fail2ban `enable --now` is a no-op; Node install skipped when `node` major is 24 (24.22.2 qualifies); `corepack enable` + `corepack install -g pnpm@11.9.0` may re-point the `pnpm` shim (check `which pnpm; pnpm -v` afterwards); SSH hardening only with `--harden-ssh`, which is **not needed** (already done by the owner) | ✅ (review) / ❓ run |
| Units reference `/opt/workfolio/current/...` | exist after the first successful deploy only | ✅ |
| Toolchain | verified on the VPS: Node v24.22.2 at `/usr/bin/node` (NodeSource package `24.22.2-1nodesource1`, repo `node_24.x nodistro`: the installer's NodeSource branch works on 26.04), npm 11.19.1, corepack 0.36.0, pnpm 11.9.0 at `/usr/bin/pnpm` (corepack shim). `install-vps.sh` will skip the Node step and only re-run `corepack enable`/`install` | ✅ |
| Native modules | `@libsql/linux-x64-gnu` in `pnpm-lock.yaml`; CI builds on `ubuntu-latest` | ❓ 26.04 glibc at first `pnpm install` |

**Decisions (Git):** (1) push the branch and deploy `origin/deploy/hostinger-vps`, or merge to `main` first and
deploy `origin/main`; recommended: push and deploy the branch ref, merge after acceptance. (2) Clone location (a)
move to `/opt/workfolio/repo` or (b) second clone.

## 2. VPS readiness: verified 2026-11-06 (read-only, as `workfolio`, Brave web terminal)

Commands run: `id`, `getent`, `sudo -n` (refused, as expected), `grep` on readable sshd files, `systemctl
is-active/is-enabled/show`, `ss -ltn`, `swapon`, `free`, `sysctl`, `df`, `uname`, `apt list`, version flags,
`git` (local only; the one network call was cancelled at the passphrase prompt), `stat`, `ls`, `ssh-keygen -F`,
`ssh-keygen -y -P ''` (passphrase test, nothing entered), `cat /etc/os-release`, `timedatectl`. No `sudo` succeeded
and none was attempted with a password.

| Item | Owner record | Found on the VPS | Status |
|---|---|---|---|
| SSH key auth | enabled | `PubkeyAuthentication yes` in `/etc/ssh/sshd_config.d/00-workfolio-hardening.conf`; the terminal session itself is key-less (web console), so a key login was not exercised | ✅ config / ❓ effective (`sshd -T` needs root) |
| Root SSH login | disabled | drop-in `PermitRootLogin no`; main `sshd_config` still says `PermitRootLogin yes`, but the drop-in is included first (`00-`, first value wins) | ✅ config / ❓ effective |
| Password auth | disabled | drop-in `PasswordAuthentication no`; `60-cloudimg-settings.conf` also `no`; `50-cloud-init.conf` unreadable (root-only); `KbdInteractiveAuthentication no` in the main file; `MaxAuthTries` not set (default 6, the earlier plan proposed 3: minor) | ✅ config / ❓ effective |
| Admin user | `tffdigitaladmin` with sudo | uid 1001, member of `sudo` (only member), home `/home/tffdigitaladmin` 750 | ✅ |
| `workfolio` user | created | uid 1000, groups `workfolio,users`, home `/home/workfolio` 750, **no sudo** (`sudo -n` refused; the four `systemctl` verbs come with `install-vps.sh`), not in `systemd-journal` (group empty; installer adds it) | ✅ |
| UFW | enabled, SSH allowed | `ufw.service` active + enabled; `ss -ltn` shows **only `0.0.0.0:22` / `[::]:22` public** (rest loopback: resolved, monarx); rule list needs root | ✅ service / ❓ rules |
| fail2ban | installed, enabled, sshd jail active | `fail2ban.service` active + enabled; `/etc/fail2ban/jail.d/sshd.local`: `[sshd] enabled = true, maxretry = 5, findtime = 10m, bantime = 1h`; live jail status needs root | ✅ config / ❓ jail runtime |
| Swap | 2 GB persistent | `/swapfile` 2G active (0 B used), `/etc/fstab` entry present, `Swap: 2.0Gi` | ✅ |
| `vm.swappiness` | 10 | `vm.swappiness = 10`, persisted in `/etc/sysctl.d/99-workfolio.conf` | ✅ |
| Node / npm / corepack / pnpm | 24.22.2 / 11.9.0 | v24.22.2, npm 11.19.1, corepack 0.36.0, pnpm 11.9.0 | ✅ |
| `/usr/bin/node` | — | regular file, root 755, 2025-10-27 (NodeSource deb); `/usr/local/bin/node` absent; `/usr/bin/pnpm` → corepack shim | ✅ (units' path resolves) |
| Users and permissions | — | `getent passwd` ≥ 1000: `workfolio`, `tffdigitaladmin` only; `sudo` group = `tffdigitaladmin`; `/etc/sudoers.d` unreadable (root) | ✅ / ❓ sudoers content |
| GitHub origin / branch / shallow / commit | deploy key, clone at `/home/workfolio/app` | `origin git@github.com:YashSinghal2001/insight-workfolio.git`, not shallow, `main` @ `ad869af`, clean | ✅ |
| Deploy key usability | read-only key configured | was passphrase-protected (prompted); **replaced 17:00 UTC** by the passphrase-less read-only key; non-interactive fetch verified | ✅ |
| App directory ownership | — | `/home/workfolio/app` and `.git` `workfolio:workfolio` 775 | ✅ |
| Disk / RAM | — | `/` 96 G, 5.4 G used, **91 G free**; RAM 7.7 Gi, 594 Mi used, 7.2 Gi available | ✅ |
| Kernel / updates | audit: reboot pending | **7.0.0-42-generic running**, no `/var/run/reboot-required`, 7 packages upgradable | ✅ (upgrade still part of A1) |
| Docker | audit: active, unused | `docker.service` active + enabled; container list needs the socket (root) | ✅ service / ❓ containers; ⛔ decision keep/disable |
| Caddy, sqlite3, ffmpeg | — | all **missing** (expected; installed by `install-vps.sh`); `/etc/caddy` absent | ✅ as expected |
| GPG | — | gpg (GnuPG) 2.4.8 present | ✅ |
| Workfolio directories / units / tmpfiles | — | `/opt/workfolio`, `/etc/workfolio`, `/var/lib/workfolio`, `/var/backups/workfolio` absent; no `workfolio-*` units; `/etc/tmpfiles.d` has only `screen-cleanup.conf`; `/etc/systemd/system` holds only distro aliases | ✅ clean slate |
| OS / time | — | Ubuntu 26.04.1 LTS; time zone `Etc/UTC`, NTP active (backup timer at 02:30 UTC is exact) | ✅ |
| Apt sources | — | `docker.sources`, `monarx.list`, `nodesource.sources`, `ubuntu.sources` | ✅ |
| hPanel snapshot | none | not checked this run (hPanel, not the terminal) | ⛔ manual before 1B |

### 2a. Mismatches against the previous setup records

1. **Deploy key passphrase: RESOLVED 2026-11-06.** The original key `~/.ssh/github_deploy_ed25519` needs a
   passphrase and no agent exists, so `deploy.sh`'s non-interactive `git fetch` would have hung. After comparing a
   persistent agent (encrypted at rest, but a human `ssh-add` after every reboot and the same exposure to a
   compromised `workfolio` account) with a dedicated passphrase-less read-only deploy key (unattended, per-repository,
   revocable, same exposure), the owner approved the latter. Done as `workfolio` through the Brave terminal: new key
   generated, public key added on GitHub as read-only, `ssh -T` + `ls-remote` verified, config backed up and
   switched, non-interactive `fetch` verified. **Closed:** with the owner's approval the old GitHub entry
   was deleted and the old private key, its public half and the config backup were shredded on the VPS; the
   repository now has exactly one deploy key, read-only, and `~/.ssh` holds only the new key pair, `config` and
   `known_hosts`.
2. **`PermitRootLogin yes` remains in the main `sshd_config`.** Harmless because the `00-` drop-in is included first
   and wins, but it reads as contradictory and will again if someone removes the drop-in. The effective value
   could not be confirmed without root (`sshd -T`); the first root session in Phase 1B should run it.
3. **`MaxAuthTries` is the default (6)**, not the 3 proposed in the Phase 1 plan. Minor; fail2ban (5 retries, 1 h
   ban) covers it.
4. **`systemd-journal` group is empty**: expected before `install-vps.sh`, but note that `monitor.sh`'s OneDrive
   log scan depends on the installer adding `workfolio` to it.
5. **Kernel and reboot**: the pending reboot from the 2026-11-05 audit has been done (7.0.0-42 running); 7 package
   updates remain. The records did not mention this; no action beyond A1's `apt upgrade`.
6. **Access path for Phase 1B**: the web terminal is logged in as `workfolio` (no sudo). The install must run as
   root through `tffdigitaladmin` + `sudo` (its SSH key from the Mac, or hPanel's root console), not from this
   session.

Still only verifiable as root (first thing in stage A, read-only): `sshd -T | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|maxauthtries)'`,
`ufw status verbose`, `fail2ban-client status sshd`, `docker ps -a`, `cat /etc/sudoers.d/*`,
`cat /etc/ssh/sshd_config.d/50-cloud-init.conf`.

## 3. Hostname: single origin on the public IP (decided 2026-11-06)

No domain is purchased and DuckDNS is not used. The first launch serves everything from
`https://189.72.144.117` through `deploy/caddy/Caddyfile.ip` (path routing `/api/*` → API, rest → dashboard) with
a Let's Encrypt short-lived IP certificate. Plain `http://` was evaluated and rejected: the production code
refuses it everywhere (env validation, Secure cookies, dashboard and desktop builds), and it would carry
credentials in clear text. Evaluation record: `deploy/README.md` "Temporary launch on the public IP".

Values to enter in Phase 1B:

| File on the VPS | Key | Value |
|---|---|---|
| `/etc/caddy/workfolio.env` | `WORKFOLIO_PUBLIC_IP` | `189.72.144.117` (`WORKFOLIO_DOMAIN` left at `example.com`) |
| `/etc/caddy/workfolio.env` | `ACME_EMAIL` | an IT mailbox |
| `/etc/workfolio/dashboard.env` | `NEXT_PUBLIC_API_URL` | `https://189.72.144.117` (build-time) |
| `/etc/workfolio/api.env` | `CORS_ORIGINS` | `https://189.72.144.117,tauri://localhost,http://tauri.localhost` |
| `/etc/workfolio/api.env` | `DASHBOARD_URL` | `https://189.72.144.117` |
| `/etc/workfolio/api.env` | `ONEDRIVE_REDIRECT_URI` | `https://189.72.144.117/api/v1/storage/onedrive/oauth/callback` (placeholder registration values; not connected) |
| Desktop release build (later) | `WORKFOLIO_API_URL`, `WORKFOLIO_DASHBOARD_URL` | `https://189.72.144.117` |
| External uptime monitor | URL | `https://189.72.144.117/api/v1/health` |

Verified on this machine (2026-11-06): `validateEnv` accepts these IP-literal https values and refuses the http
forms (`apps/api/test/env.test.ts`); `next build` succeeds with `NEXT_PUBLIC_API_URL=https://189.72.144.117`;
the desktop `releaseConfig` accepts `https://189.72.144.117` and refuses `http://`; Caddy 2.11.9 validates both
Caddyfiles and the adapted JSON of `Caddyfile.ip` carries `profile: shortlived` for subject `189.72.144.117`.
Not verifiable here: actual Let's Encrypt IP issuance and 2-day renewals (first `journalctl -u caddy` on the VPS),
Caddy's package version on Ubuntu 26.04 (installer refuses < 2.10), Entra's acceptance of an IP-literal redirect
URI (OneDrive deferred).

## 4. Microsoft OneDrive: can the existing Entra app registration be reused?

**No. A new registration is required**, for reasons already recorded in the repository, not for convenience:

| Fact | Source |
|---|---|
| The existing registration ("Insight Workfolio") is the **app-only** SharePoint app: `Sites.Selected` (Application) consent, no redirect URI, secret/certificate credential, built for `SCREENSHOT_STORAGE=graph` | `docs/onedrive.md` "Microsoft 365 setup", `ONEDRIVE-INTEGRATION-REPORT.md` row "Earlier Microsoft grants" |
| It carries the history of the rejected OneDrive-folder test: `Files.SelectedOperations.Selected` was consented, leaked SharePoint Limited Access on a personal OneDrive, and was rolled back on 2026-11-02; **two dormant Limited Access entries remain** and re-activate on any new `Files.*` consent for that app | `docs/security.md` "Microsoft app containment (SEC-11)" and "re-consent guard" |
| The OneDrive mode needs **delegated** `Files.ReadWrite` + `offline_access` + a **Web** redirect URI, i.e. exactly the kind of consent SEC-11 forbids on that app | `apps/api/src/storage/onedrive.ts` scope allow-list; `docs/onedrive.md` mode section |
| The integration report's decision already says: "Use a new registration so the old app with dormant Limited Access entries is never touched" | `ONEDRIVE-INTEGRATION-REPORT.md` §"New Entra app registration" |

What **can** be reused from the existing setup: the tenant ID, the tenant admin's process, and the SEC-11 pre-check
(confirm, read-only, that the old app is absent from the personal OneDrive's role assignments before touching
anything in the tenant). What cannot: its client ID, its secret/certificate, its permissions.

New registration (tenant admin, after the domain): single tenant, platform **Web**, redirect URI
`https://api.<domain>/api/v1/storage/onedrive/oauth/callback`, one client secret (note its expiry), delegated
`Files.ReadWrite`, `offline_access`, `openid`, `profile`, **no** application permissions; optional: assignment
required = yes, assigned only to the IT storage account. Values go only into `/etc/workfolio/api.env` on the VPS
(`ONEDRIVE_TENANT_ID`, `ONEDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_SECRET`, `ONEDRIVE_REDIRECT_URI`,
`ONEDRIVE_ACCOUNT_EMAIL`; `ONEDRIVE_TOKEN_KEY` generated on the VPS; `ONEDRIVE_TOKEN_FILE` default path). The
API's boot validation refuses a partial or inconsistent set without printing any value.

Connect = dashboard Settings › Microsoft OneDrive › Connect in the **normal Chrome profile** (Microsoft account),
signed in as the IT storage account. Safe verification order after connect (unchanged): status page →
`verify-onedrive.mjs <env-file>` read-only → `--write` → `backup-upload.js check` → one manual backup run →
`backup-upload.js list` and a look at `InsightWorkfolio/db-backups/` in the OneDrive web UI → reload the status
page (`lastCheckOk` with a fresh `lastCheckAt`: proves the shared-token re-read on the real tenant) → one test
employee's screenshot.

## 5. Backups and monitoring (unchanged)

Passphrase file (root): `(umask 077; openssl rand -base64 32 > /var/lib/workfolio/secrets/backup-passphrase); chown workfolio:workfolio /var/lib/workfolio/secrets/backup-passphrase`
after `install-vps.sh` created the 0700 `secrets` directory; store the passphrase in the company password manager
before the first backup. `backup.env`: `BACKUP_GPG_PASSPHRASE_FILE`, the OneDrive `BACKUP_UPLOAD_CMD` line from the
template, `BACKUP_KEEP_DAYS=30`. Decisions: `ONEDRIVE_BACKUP_KEEP_DAYS` (unset = never delete off-site) and the
alert destination (`ALERT_WEBHOOK_URL` and/or `ALERT_CMD`), plus an external uptime monitor on
`https://api.<domain>/api/v1/health`. First restore rehearsal: `verify-backup.sh` as `workfolio` with the
passphrase file on the first `.gpg` backup, then on a copy downloaded from OneDrive; expected `RESTORABLE`,
`Applied: 28; pending: 0`.

## 6. Phase 1B sequence, corrected for the completed steps

Legend: **[R]** read-only · **[W]** modifies the VPS · **[A]** explicit approval gate · **[M]** manual action by the
owner · **[C]** command for later execution · **[V]** fresh verification of an owner-reported fact.

### Preconditions

| # | Step | Kind |
|---|---|---|
| P0 | Done 2026-11-06 as `workfolio` (§2). Remaining root-only read-only checks run at the start of stage A | [R][V] |
| P0b | Done 2026-11-06: passphrase-less read-only deploy key in use, old key removed on GitHub and shredded on the VPS; `git -C /home/workfolio/app fetch` is prompt-free | ✅ |
| P1 | Decide: clone location (a)/(b); off-site retention; alert destination; Docker; IPv6. Decided: hostname = public IP single origin; Git = branch pushed, deploy its ref | [M] |
| P2 | No DNS records (single origin on the IP) | ✅ |
| P3 | Done 2026-11-06: `deploy/hostinger-vps` pushed; `refs/heads/deploy/hostinger-vps` = `ee053a0…` on GitHub, `main` unchanged at `ad869af`, no merge, no PR | ✅ |
| P4 | Tenant admin: **new** Entra registration (§4) with the final redirect URI; SEC-11 pre-check first | [M] |
| P5 | hPanel › Create snapshot (Brave) | [A][M] |

### Stage A: base system (root via `tffdigitaladmin` + sudo, Brave web terminal)

| # | Step | Kind |
|---|---|---|
| A1 | `apt-get update && apt-get upgrade -y`, `reboot` if `/var/run/reboot-required` exists; reconnect; `uname -r` | [A][W][C] |
| A2 | `sudo -u workfolio git -C /home/workfolio/app fetch --prune origin && sudo -u workfolio git -C /home/workfolio/app checkout deploy/hostinger-vps` (the checkout is only needed so `deploy/` exists for the installer; `deploy.sh` later builds from `origin/deploy/hostinger-vps` by sha) | [W][C] |
| A3 | `/home/workfolio/app/deploy/scripts/install-vps.sh` as root: installs Caddy, sqlite3, ffmpeg, gnupg, ufw rules 80/443, the `workfolio` directories, env **templates** (placeholders), units (validated, enabled, not started), sudoers, journald limits; skips Node, swap, user creation (already present). Review: `systemd-analyze verify` empty, `visudo` `parsed OK`, `ls -l /usr/bin/node` resolves | [A][W][C] |
| A4 | Clone location: (a) `sudo -u workfolio mv /home/workfolio/app /opt/workfolio/repo` (recommended) or (b) keep it and pass `WORKFOLIO_REPO_URL` at C1 | [W][C] |
| A0 | As root, before any change: `sshd -T \| grep -E '^(permitrootlogin\|passwordauthentication\|pubkeyauthentication\|maxauthtries)'`, `ufw status verbose`, `fail2ban-client status sshd`, `docker ps -a`, `cat /etc/sudoers.d/*` (the root-only half of §2) | [R][V][C] |
| A5 | Verify from the Mac: `ssh tffdigitaladmin@189.72.144.117` works; `ssh root@…` and a password attempt are refused; on the VPS `sudo -u workfolio sudo -n systemctl restart workfolio-api` is accepted by sudoers (unit not running yet is fine) | [R][V][C] |
| — | `install-vps.sh --harden-ssh` **not needed** (owner already hardened SSH); keep `ADMIN_USER=tffdigitaladmin` if it is ever re-run | — |

### Stage B: configuration (root)

| # | Step | Kind |
|---|---|---|
| B1 | `/etc/caddy/workfolio.env`: `WORKFOLIO_PUBLIC_IP=189.72.144.117`, `ACME_EMAIL`; re-run `install-vps.sh` (installs `Caddyfile.ip`, validates, reloads Caddy); `journalctl -u caddy -n 30` shows the short-lived certificate obtained; from the Mac `curl -I https://189.72.144.117` → Caddy 502 **with a valid Let's Encrypt certificate** (nothing behind it yet) | [W][C] |
| B2 | Fill `/etc/workfolio/api.env` (secrets generated on the VPS, URLs, `ONEDRIVE_*` from P4, `TIMELAPSE_MIN_FREE_MB=2048`), `dashboard.env`, `backup.env`, `monitor.env`; `ls -l /etc/workfolio` → `-rw-r----- root workfolio` | [A][W][M] |
| B3 | Passphrase file (§5) + password-manager entry | [M][W][C] |

### Stage C: first deploy (`sudo -iu workfolio`)

| # | Step | Kind |
|---|---|---|
| C1 | `/opt/workfolio/repo/deploy/scripts/deploy.sh origin/deploy/hostinger-vps` (with (b): prefix `WORKFOLIO_REPO_URL=git@github.com:YashSinghal2001/insight-workfolio.git` and run the script from `/home/workfolio/app/deploy/scripts/`) → clone/fetch, `pnpm install --frozen-lockfile`, builds, `db:migrate --dry-run`, **stops** on "pending migrations"; nothing activated, no database file created | [A][W][C] |
| C2 | Review the dry-run (28 PENDING on an empty file is expected); check the release's `RELEASE_SHA` equals `ee053a0…` (or the later pushed sha) | [R] |
| C3 | `… deploy.sh origin/deploy/hostinger-vps --migrate` → creates the database (WAL), applies 0001–0028, activates `current`, restarts both units, health checks | **[A] migration + production activation** [W][C] |
| C4 | `healthcheck.sh` → exit 2 (ready 503 until OneDrive) expected; `journalctl -u workfolio-api -n 30`: `Schema version 0028`, verify-only boot, no sandbox errors; `ss -ltnp` shows 3000/4000 on 127.0.0.1 only | [R][C] |

### Stage D: admin, timers, browser

| # | Step | Kind |
|---|---|---|
| D1 | From the Mac: `curl -s https://api.<domain>/api/v1/health`; `curl -sI https://app.<domain>` (200, HSTS) | [R][C] |
| D2 | `sudo -iu workfolio bash -c 'cd /opt/workfolio/current/apps/api && node --env-file=/etc/workfolio/api.env dist/cli/create-admin.js --email <admin mailbox>'`; open the setup link in Chrome | [A][W][C] |
| D3 | `systemctl start workfolio-backup.timer workfolio-monitor.timer`; `systemctl list-timers 'workfolio-*'` | [W][C] |
| D4 | **Earliest safe browser point:** sign in at `https://app.<domain>`; Settings shows OneDrive not connected | [R] |
| D5 | `systemctl start workfolio-backup` (upload step fails cleanly until OneDrive is connected; expected) → `verify-backup.sh` on the `.gpg` | [W][C] |

### Stage E: OneDrive

| # | Step | Kind |
|---|---|---|
| E1 | Dashboard › Settings › Microsoft OneDrive › Connect (Chrome, IT storage account) | **[A] real OneDrive** [M] |
| E2 | `verify-onedrive.mjs` read-only → `--write`; `backup-upload.js check`; `systemctl start workfolio-backup`; `backup-upload.js list`; OneDrive web UI shows `db-backups/` only; status page re-check | [A][W][C] |
| E3 | `healthcheck.sh` exit 0; `monitor.sh` OK; forced alert (stop the API for a minute) proves the webhook | [W][C] |
| E4 | Screenshots for one test employee; one timelapse round trip | [A][W] |

Approval gates: P3, P5, A1, A3, B2, C1, **C3**, D2, **E1**, E2, E4. Each is a separate go.

## 7. Verification matrix and acceptance checklist

Unchanged from revision 1 (dashboard, API, database, loopback binding, OneDrive, backups, monitoring, security),
with two additions to the checklist:

- [ ] §2 verification outputs recorded (SSH, UFW, fail2ban, swap, swappiness, Node path, users, deploy key, clone)
- [ ] `/usr/bin/node` resolves to Node 24 (the units depend on that path)
- [ ] Docs follow-up after acceptance: `deploy/README.md` "Install" (clone location and order), `install-vps.sh` comment about `/usr/bin/node` when Node was installed another way; merge `deploy/hostinger-vps` into `main` on the owner's decision

## 8. Pending decisions and manual actions

Decisions: (1) hostname: decided (public IP single origin); (2) Git: decided (branch pushed, deploy its ref); (3) clone location (a) move or (b) second clone; (4)
`ONEDRIVE_BACKUP_KEEP_DAYS`; (5) alert destination and uptime-monitor provider; (6) Docker keep/disable; (7) IPv6;
(8) deploy key: closed (passphrase-less read-only key in use, old key removed everywhere).

Manual actions: §2 and §1 verification run (or approve a read-only run by Claude through the Brave web terminal);
DNS records; `git push`; hPanel snapshot; new Entra registration (tenant admin) with the SEC-11 pre-check; typing
secrets into the VPS env files; the OneDrive sign-in in Chrome; the password-manager entry; the uptime-monitor
account.
