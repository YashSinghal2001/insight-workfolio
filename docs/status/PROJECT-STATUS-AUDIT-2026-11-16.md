# Insight Workfolio — project status audit, 2026-11-16

Read-only audit. Observations made 2026-11-16 between about 08:20 and 09:10 UTC (13:50–14:40 IST). Nothing was
changed, deployed, restarted, sent or committed. The only file written is this report.

**Evidence sources actually used**

| Source | Access | Used for |
|---|---|---|
| Local repository | Full | Code, git state, local tests, builds |
| GitHub (`gh`) | Full | Remote heads, Actions runs, artifacts, failed-step logs |
| Claude in Chrome (macOS "Browser 2") | hPanel signed in; dashboard signed in as Super Admin `it@tffdigital.com` | Hostinger VPS panel, live dashboard (read-only pages) |
| Public network probes from this Mac | `curl`, `openssl`, `nc` | `/api/v1/health`, `/api/v1/ready`, TLS cert, open ports, route fingerprinting (unauthenticated GETs only) |
| **VPS shell** | **None.** `ssh` with `~/.ssh/hostinger_workfolio_ed25519` → `Permission denied (publickey)` for `tffdigitaladmin` and `workfolio`. Opening the hPanel root web console was refused by this session's permission policy | — |
| UptimeRobot dashboard | Not signed in | — |
| Microsoft 365 connector | Signed in as a personal staff account, not `IT@` | No access to the IT OneDrive backup folder |

Everything that needs a shell on the VPS is therefore **NOT VERIFIED** in this audit (listed in §16.3).

---

## 1. Executive summary

- **Production is up and serving real (but tiny) data.** HTTPS valid, health and readiness green (DB up, Microsoft
  Graph storage up), Super Admin dashboard loads with zero console errors and every API call 200. There is **one
  employee** (Suraj Sharma, Windows device) and **one admin**; one real shift was recorded (12→13 Nov, 7 h 00 m,
  17 activity intervals). Nothing since 13 Nov 01:31 IST.
- **Production runs commit `4d66269` (API and dashboard), which its own commit message says was "Not deployed".** The
  deploy was never recorded in the status docs. The uncommitted invitation-email work is **not** deployed.
- **The desktop installers served to employees are older than the server** (0.1.0, built 11 Nov, before `4d66269`).
  The desktop half of `4d66269` (live state, lock = idle, screenshot hardening) has **not reached any employee**, and
  both versions are labelled 0.1.0.
- **Windows CI is red on the latest commit** (3 desktop TypeScript privacy-guard tests fail on Windows path
  separators), so **no Windows installer exists for `4d66269`**. The only remaining Windows artifact (from `27fd0be`)
  expires 2026-11-18.
- **Hosting renewal risk:** the Hostinger KVM 2 plan **expires 2026-12-05 with auto-renewal OFF** (19 days).
- **Locally everything is green** on the working tree: 704 JS/TS tests + 103 Rust tests pass, typecheck, lint,
  clippy, API and dashboard production builds all pass.
- **Not production-ready for a real rollout:** all monitoring notices are still *drafts*, retention is not approved,
  macOS and Windows physical checklists are 0 % run on the current code, invitation emails are blocked on Exchange
  admin work, the app is on a bare IP (6-day certificates), and backups/alerting could not be verified in this audit.

## 2. Overall project status

| Dimension | Status | Basis |
|---|---|---|
| Implementation (code) | **IMPLEMENTED**, broad | 30 migrations, 26 API controllers, 43 dashboard routes, Tauri desktop (macOS + Windows), browser extension |
| Automated tests | **DONE locally / FAILED on Windows CI** | §20 |
| Physical-hardware verification | **PARTIAL** | Windows: one real shift recorded in production on 0.1.0 (pre-`4d66269`); 0/77 Windows checklist rows run. macOS: historical evidence only; 0/53 checklist rows run after `4d66269` |
| Deployment | **PARTIAL** | Server at `4d66269`; desktop clients older; invitations not deployed |
| Live operation | **IMPLEMENTED, lightly used** | 2 accounts, 1 device, 1 shift |

## 3. Repository and Git status (2026-11-16 ~08:25 UTC)

| Item | Value |
|---|---|
| Root | `/Users/yashsinghal/Desktop/Projects/workfolio/insight-workfolio` |
| Branch | `deploy/hostinger-vps` |
| HEAD | `4d66269b776bc4cb092eea9932d94c90124467da` (2026-11-12 16:25 IST) — **still the latest commit** |
| `origin/deploy/hostinger-vps` | `4d66269…` (in sync, after `git fetch`) |
| `origin/main` | `ad869af…` — **25 commits behind** the deploy branch; deploy branch never merged |
| Staged | none |
| Unstaged | 21 files, +325/−34 (invitation emails: API, DB migration `0030_account_invitations`, shared types, dashboard UI, tests, docs) |
| Untracked | 12: `apps/api/src/employees/invitations.ts`, `apps/api/test/invitations.e2e.test.ts`, `apps/dashboard/scripts/verify-invitations.mjs`, `docs/invitations.md`, 6 × `docs/qa/*` (parity/inventory/checklists, 13 Nov), `docs/status/DESKTOP-CROSS-PLATFORM-READINESS.md`, `docs/status/HOSTINGER-VPS-PHASE1B-READINESS.md` (deliberately uncommitted) |

Risk: the invitation work, the parity reports and the remediation plan exist **only on this Mac**.

## 4. Architecture (as observed, not as documented)

```
Internet ──443/80──► Caddy (Let's Encrypt shortlived IP cert, single origin)
                        ├─ /api/*  → NestJS API   (loopback; port not reachable from outside)
                        └─ /*      → Next.js dashboard (loopback; port not reachable from outside)
                     SQLite (local file) · Microsoft Graph / OneDrive storage (IT@ account)
Desktop (Tauri: Rust + TS), Windows/macOS ──HTTPS──► same origin
Browser extension (website domains) ──► desktop app
```

Externally verified: only 22, 80, 443 open (3000, 4000, 8080, 5432, 2019 closed/filtered); 80 → 308 → https;
`via: 1.1 Caddy`; HSTS, `nosniff`, `X-Frame-Options: DENY`, `no-store`, `no-referrer`. The internal bindings
(`127.0.0.1:3000/4000`), SQLite path and WAL mode: **NOT VERIFIED** (no shell).

## 5. Backend status

| Area | Code | Tests | Live |
|---|---|---|---|
| Auth (argon2id passwords, setup links, sessions, rate limits) | IMPLEMENTED (`apps/api/src/auth/crypto.ts`) | API suite 491/491 | Super Admin session works; `/auth/me` 200 |
| RBAC: `SUPER_ADMIN`, `ADMIN` (IT Admin), `EMPLOYEE`, team-head permissions; Super-Admin-only `screenshots:delete`, `storage:manage`, `roles:manage` (`packages/shared/src/roles.ts:9,76,89`) | IMPLEMENTED | role-separation suites pass | Only Super Admin observed; **no IT Admin account exists in production** |
| Attendance, breaks, timeline (`GET /attendance/timeline`) | IMPLEMENTED | pass | Route present live (401 unauthenticated vs 404 for a made-up route); data shown |
| Activity / idle / live state (migration 0029) | IMPLEMENTED | pass | Server side live; clients do not send live state yet (old desktop build) |
| Health / readiness | IMPLEMENTED | pass | `health` 200 (uptime 180 181 s at 08:40:42 UTC → process started **2026-11-14 ≈06:37 UTC**, cause NOT VERIFIED); `ready` = ready, DB 0 ms, storage MICROSOFT_GRAPH 163 ms |
| Known open defect | `activity.service.ts:194` takes the activity `source` (macOS/Windows) from the client request, not the registered device (remediation item 5) | — | — |

## 6. Database status

| Item | Status |
|---|---|
| Migrations in code | 0001…`0029_device_live_state` committed; `0030_account_invitations` uncommitted |
| Migrations applied in production | **NOT VERIFIED** directly. Indirect: 0029 features answer live, so 0029 is very likely applied; 0030 not (dashboard still shows pre-invitation text) |
| Integrity / WAL / file permissions / location | **NOT VERIFIED** (no shell) |
| Readiness DB ping | up, 0 ms (2026-11-16 08:40:49 UTC) |
| Data volume (from UI) | 2 users, 1 device, 17 activity intervals (oldest 12 Nov 18:31 IST), 18 audit events, 0 screenshots, 0 alerts/rules, 0 projects |

## 7. Dashboard status

Production build passes locally (43 routes; needs `NEXT_PUBLIC_API_URL`, which is enforced by design). Live:
Overview, Employees, Attendance (Live), Settings, Alerts and Audit opened and checked; route prefetch for Teams, Roles,
Timesheets, Corrections, Leave, Holidays, Activity, Websites, Screenshots, Projects and Reports all returned 200. No
console errors. Data comes from production APIs (`/api/v1/attendance/overview` 200), not mocks.

Observations:
- Attendance "Last sync … **Online**" for a device last seen 3 days ago. The code means "the last event was sent
  live, not from the offline queue" (`apps/dashboard/src/app/(admin)/attendance/page.tsx:260`). The label is
  ambiguous and may read as presence. Not a data bug.
- Overview "Late / absent today: —, Work schedule not configured": schedules are not set up.
- Mobile viewport: **NOT VERIFIED**. The window resize did not take effect, although a hidden "Menu" button exists
  for small screens.

## 8. Super Admin status — **DONE (read paths)**

Signed in as `it@tffdigital.com` (badge "Super Admin"). Settings shows the storage connect/disconnect and retention
controls, as the role separation intends. Write paths were not exercised (read-only audit).

## 9. IT Admin status — **NOT VERIFIED (live)** / IMPLEMENTED + tested (code)

No IT Admin account exists in production (the Audit actor/target filters list only `it@` and `surajsharma@`).

## 10. Employee status — **NOT VERIFIED (live UI)**

No employee session was available. Indirect production evidence: Suraj set a password (11 Nov 15:30 IST), registered a
**Windows** device (11 Nov 17:03 IST) and recorded one shift. The employee "My" panel with desktop downloads is in
code (`apps/dashboard/src/app/my/_components/desktop-downloads.tsx`). Both installer URLs answer 200 with the expected
sizes (6 901 787 / 2 674 954 bytes; HEAD only, nothing downloaded).

## 11. macOS status — **IMPLEMENTED; current build NOT VERIFIED on hardware**

- Code: HID-system-state idle source, lock counted as idle, display-sleep screenshot guard, Keychain credentials
  (`keyring` apple-native), tray, launch at login, offline queue (SQLite) — per `docs/qa/MACOS-FEATURE-INVENTORY.md`,
  spot-checked.
- Tests: Rust 103 pass / 1 ignored (the real-capture benchmark, deliberately not run); desktop TS 81/81.
- Hardware: historical evidence predates `4d66269`. `MACOS-RUNTIME-TEST-CHECKLIST.md`: **0 of 53 rows run** after
  `4d66269`. `verify-native.mjs` still expects "unobserved" on lock (remediation item 2), so the harness is stale.
- Distribution: unsigned and un-notarised (`signingIdentity: null`); the served DMG predates `4d66269`.
- Release logging: none (no log file in release builds; remediation item 3).

## 12. Windows status — **PARTIAL; CI FAILED on latest commit**

| Check | Result |
|---|---|
| CI run [43388023773](https://github.com/YashSinghal2001/insight-workfolio/actions/runs/43388023773) (`4d66269`, 2026-11-13) | Windows job **FAILED**: cargo clippy ✅, `cargo test` incl. native smoke ✅, **desktop TS ✖ 3 failures** (`test/privacy-apis.test.ts:52,81`: paths reported as `src-tauri\src\…`, not matched by the `/` allow-list). Installer build/verify/upload **skipped** |
| Windows installer for `4d66269` | **None exists** |
| Last Windows installer artifact | Run [43000861066](https://github.com/YashSinghal2001/insight-workfolio/actions/runs/43000861066) (`27fd0be`): `insight-workfolio-windows-nsis-UNSIGNED`, expires **2026-11-18** |
| Served installer | `Insight-Workfolio_0.1.0_x64-setup.exe`, committed in `02cbfd1` (11 Nov), unsigned (SmartScreen warning documented in the UI) |
| Physical PC | **Partial real-world evidence**: one employee's Windows PC registered and recorded a 7 h shift on the 0.1.0 build. No structured test: `WINDOWS-RUNTIME-TEST-CHECKLIST.md` **0 of 77 rows run** |
| Open code gaps (verified still present) | Credentials roam (keyring `windows-native` default = enterprise persistence, item 4); injected input counts as activity (item 10, owner decision); no owner-only DACL (item 7); shutdown/sign-out not explicit (item 8); display-off notification-only (item 9); bundle `targets: "all"` (MSI produced, untested); no release log |

## 13. Browser extension status — **IMPLEMENTED, off in production**

MV3 extension (`apps/browser-extension`: background, tracker, popup); 7/7 tests. Website tracking is off and its
notice is a draft. Live: NOT VERIFIED (not enabled, no extension connected).

## 14. Invitation-email status — **IMPLEMENTED (uncommitted) · BLOCKED · NOT DEPLOYED**

| Requirement | Finding |
|---|---|
| Employee creation | Account committed first; email failure never undoes or duplicates it (`employees.service.ts`, uncommitted) |
| Token | Existing setup-token mechanism: only the sha256 is stored; 72 h expiry (production audit: issued 11 Nov 09:58Z, expires 14 Nov 09:58Z); token in the URL fragment |
| Single use | Enforced (`used_at`); covered by e2e |
| Graph / Exchange RBAC | App-only client credentials; **refuses any token carrying Entra application roles**, so only Exchange "Application Mail.Send" scoped to `IT@` can work; `saveToSentItems: false` |
| Config | `INVITATION_MAIL_PROVIDER` (none/mock/graph; mock refused in production) + 4 `MAIL_*` vars, validated at boot |
| Retry / failure | 3 attempts in-request (1 s, 4 s back-off; 15 s timeout each); permanent errors not retried; FAILED row + audit; setup link shown to admin as fallback |
| Resend | New link, old link invalidated, 60 s cooldown, race-safe conditional insert; 30 per admin per 15 min |
| Audit | `INVITATION_SENT` / `INVITATION_FAILED` |
| Tests | `apps/api/test/invitations.e2e.test.ts` (mock + fake Graph `fetch`) inside API 491/491; `verify-invitations.mjs` 11/11 per `docs/invitations.md` (not rerun here) |
| Git | **Uncommitted** (9 modified + 4 untracked files) |
| Deployment | **Not deployed**: live `/employees/new` still shows the pre-change wording |
| Real email | **None sent**. Exchange service principal, management scope and role assignment **not done** (`docs/invitations.md` §3) |
| Design concern | Activation links to a bare IP from a company mailbox look like phishing; a DNS name first is advisable (already noted in the doc) |

## 15. Security and privacy

Verified externally: TLS 1.x via Let's Encrypt (issuer YE2, valid 2026-11-13 13:05 → **2026-11-20 05:05 UTC**,
short-lived profile, needs renewal about every 2–6 days), HSTS, strict headers, only 22/80/443 open, SSH
**publickey only** (password auth not offered), `/.env` and guessed paths 404, internal ports unreachable.
Hostinger panel: malware scanner active; **Hostinger firewall rules: 0** (host UFW status NOT VERIFIED).

Privacy posture in production: monitoring on with defaults (15 s sampling, 300 s idle); screenshots **off**,
timelapse off, website tracking off; all three notices `…-draft-1`; activity and screenshot retention **not approved**
(nothing auto-deleted). Audit log records cross-employee views (`EMPLOYEE_*_VIEWED`).

NOT VERIFIED: UFW, fail2ban, sshd_config, service users, secret file modes, journal security errors.

## 16. Hostinger VPS status

### 16.1 hPanel (2026-11-16 ~08:20 UTC)

| Item | Value |
|---|---|
| State | **Running**, Ubuntu 26.04 LTS, `srv2130302.hstgr.cloud`, India – Mumbai 2 |
| Plan | KVM 2: 2 vCPU, 8 GB RAM, 100 GB disk, 8 TB bandwidth |
| Usage | CPU 1 % (24 h), memory 10 % (24 h), disk **7 / 100 GB**, bandwidth 1.6 GB this month, traffic in 0.3 MB / out 0.2 MB (24 h) |
| VPS uptime | 5 d 2 h (booted ≈ 2026-11-11 06:xx UTC) |
| **Expiry** | **2026-12-05, auto-renewal OFF** |
| Hostinger backups | Weekly; latest **2026-11-12 14:36**, 6.65 GB, stored in Malaysia; no manual snapshot |
| Firewall rules (Hostinger) | 0 |
| Alerts | None shown |

### 16.2 Interpretation
Resources are far from pressure. Traffic of 0.3 MB in 24 h confirms **no desktop agent is currently reporting**.

### 16.3 Server checks NOT VERIFIED (need an authorised shell)
OS/kernel, processes, `systemctl --failed`, unit restart policies, the `workfolio-backup`/`workfolio-monitor` timers,
journal errors, port bindings, Caddy config on disk, UFW, fail2ban, sshd config, file modes, SQLite path,
`PRAGMA integrity_check`, `journal_mode`, applied migrations table, **deployed release SHA**
(`/opt/workfolio/current` or equivalent), the reason for the API restart on 2026-11-14 ~06:37 UTC, local backup files,
GPG status, last OneDrive upload, monitor/alert logs.

## 17. Live production application status — **WORKING (Super Admin read paths)**

Evidence in §§5, 7, 8. Deployed commit, established by **route and UI fingerprinting** (not by a server-side SHA,
which needs a shell):

| Probe | Result | Conclusion |
|---|---|---|
| `GET /api/v1/attendance/timeline` (added in `4d66269`) | 401 (unknown route → 404) | API ≥ `4d66269` |
| Audit rows `EMPLOYEE_ATTENDANCE_TIMELINE_VIEWED` at 12 Nov 18:31 IST | present | `4d66269` live by 12 Nov ~13:01 UTC, about 2.5 h after commit |
| Attendance page "Live" view with live status / screenshot state columns | present | Dashboard ≥ `4d66269` |
| `/employees/new` helper text | pre-invitation wording | Uncommitted work **not** deployed |

**Deployed = `4d66269` (high confidence, indirect). Exact SHA on disk: NOT VERIFIED.**

## 18. Backup and monitoring

| Item | Status | Evidence |
|---|---|---|
| Hostinger weekly VM backup | **DONE** | 2026-11-12 14:36 in hPanel |
| Local nightly DB backup (timer, GPG, integrity) | **NOT VERIFIED today** | Last evidence: sandbox test 2026-11-11 (status doc §§13–14) |
| Nightly OneDrive off-site upload | **NOT VERIFIED** | Enabled 2026-11-11 08:27 UTC; first unattended run (12 Nov 02:32 UTC) never observed in any record found |
| Restore rehearsal | IMPLEMENTED; controlled rehearsal 2026-11-11 (§13) | No periodic rehearsal evidence since |
| UptimeRobot | Polling verified 2026-11-11; **alert contact NOT VERIFIED**; dashboard not signed in today | — |
| Health endpoint | **DONE** | 200 / ready |
| Teams / ntfy alerts, backup-failure alerts, cert-expiry alerts | IMPLEMENTED in `deploy/scripts/monitor.sh`; **delivery NOT VERIFIED** | — |
| Certificate | Valid until 2026-11-20 05:05 UTC; renewal depends on Caddy ARI every few days | Any renewal failure becomes an outage within days |

## 19. Code vs VPS vs live application comparison

| Feature | Code Status | Test Status | VPS Status | Live UI Status | Actual Conclusion |
|---|---|---|---|---|---|
| Auth / setup links | IMPLEMENTED | pass | NOT VERIFIED (config) | Works (Super Admin) | **DONE** for admin; employee path proven by audit rows |
| RBAC Super Admin vs IT Admin | IMPLEMENTED | pass | — | Super Admin only | **IMPLEMENTED**; IT Admin never exercised live |
| Employee data isolation | IMPLEMENTED | pass | — | NOT VERIFIED | **IMPLEMENTED** |
| Employee onboarding (manual link) | IMPLEMENTED | pass | deployed | Used once (Suraj) | **DONE** |
| Invitation emails | IMPLEMENTED, uncommitted | pass (mock) | not deployed | absent | **BLOCKED** (Exchange RBAC) + **mismatch: code ≠ prod** |
| Device registration | IMPLEMENTED | pass | deployed | 1 Windows device | **DONE** (Windows, 0.1.0) |
| Attendance / breaks | IMPLEMENTED | pass | deployed | 1 shift shown | **DONE** (minimal real use) |
| Live activity state | IMPLEMENTED (server + desktop) | pass | **server deployed** | column present, no client sends it | **PARTIAL — mismatch: server ahead of clients** |
| Idle detection (lock = idle, HID source) | IMPLEMENTED in `4d66269` | pass | n/a (client) | n/a | **NOT DEPLOYED to employees** (served installers predate it) |
| Daily timelines | IMPLEMENTED | pass | deployed | route live | **IMPLEMENTED** (audit shows it was viewed) |
| Productivity / activity reports | IMPLEMENTED | pass | deployed | pages 200 | **IMPLEMENTED** (17 intervals of data) |
| Screenshots | IMPLEMENTED | pass; real capture `#[ignore]` | storage connected | **Disabled**, 0 stored | **IMPLEMENTED, off** |
| Timelapses | IMPLEMENTED | pass | — | off | **IMPLEMENTED, off** |
| OneDrive integration | IMPLEMENTED | pass | connected (`it@`, 0.00 of 1024 GB) | "Connected", last check 16 Nov 14:12 IST | **DONE (connection)**; no screenshot ever uploaded |
| Retention / deletion | IMPLEMENTED | pass | dry-run only | "Not approved: nothing is deleted" | **BLOCKED** on HR/Legal approval |
| Notices / consent | IMPLEMENTED | pass | — | all three **draft** | **BLOCKED** on final wording |
| Alerts | IMPLEMENTED | pass | — | 0 rules | **IMPLEMENTED, unused**; in-app only |
| Audit logs | IMPLEMENTED | pass | — | 18 events, correct | **DONE** |
| Desktop downloads | IMPLEMENTED | smoke | files served 200 | visible to employees | **DONE**, but builds are stale, unsigned, and labelled 0.1.0 like the newer code |
| Offline sync | IMPLEMENTED | pass | — | "Uploaded from offline queue" label exists | **IMPLEMENTED**; not observed live |
| Browser extension | IMPLEMENTED | 7/7 | — | off | **IMPLEMENTED, off** |
| Windows build pipeline | IMPLEMENTED | **FAILED** on `4d66269` | — | — | **FAILED** |
| Backups | IMPLEMENTED | selftest 42/42 (6 Nov) | NOT VERIFIED today | — | **NOT VERIFIED** |
| Monitoring / alerting | IMPLEMENTED | — | NOT VERIFIED | — | **PARTIAL** (polling yes, alert delivery unknown) |

**Mismatches found**
1. `4d66269` is deployed; its commit message and the status docs say it is not (undocumented deploy).
2. Server at `4d66269`; both served desktop installers are pre-`4d66269`, and both are labelled 0.1.0.
3. Invitation work exists in the working tree only: not committed, not deployed.
4. Windows CI red, so no installer matches the latest code.
5. `main` is 25 commits behind what runs in production.
6. The API process restarted on 14 Nov ~06:37 UTC with no record of why.

## 20. Automated tests and CI

Local run 2026-11-16, working tree (includes the uncommitted invitation work):

| Suite | Result |
|---|---|
| `pnpm build:packages` | pass |
| shared | 76/76 |
| database | 49/49 |
| API | 491/491 |
| browser extension | 7/7 |
| desktop TypeScript (macOS) | 81/81 |
| `pnpm -r typecheck` | pass |
| `pnpm -r lint` | pass |
| Rust `cargo test` (macOS) | 103 pass, 1 ignored (real capture), 0 fail |
| `cargo clippy --all-targets -D warnings` | pass |
| API build | pass |
| Dashboard `next build` | pass with `NEXT_PUBLIC_API_URL=http://localhost:4000` (fails without it, by design) |
| Browser suites (`verify:*`), `selftest.sh` | not run (need Chrome harness / Linux tooling) |

GitHub Actions: latest run [43388023773](https://github.com/YashSinghal2001/insight-workfolio/actions/runs/43388023773)
on `4d66269`: Lint/typecheck/tests ✅, macOS Rust ✅, Browser suites ✅, **Windows ✖**. Previous green Windows
run: `27fd0be`. `main`: "Deploy staging" failed 2026-11-03 (Render path, superseded).

## 21. Critical blockers

1. **Hostinger plan expires 2026-12-05, auto-renew off.**
2. **Windows CI red → no installer for current code.** Fix is small (path separators in `privacy-apis.test.ts`).
3. **Desktop clients stale vs server.** Rebuild both installers from the current commit, bump the version, replace the downloads.
4. **Legal/HR prerequisites:** three draft notices, unapproved retention. Real monitoring of employees should not scale until done.
5. **Operational blind spots:** no working shell for the auditor, backups and alert delivery unverified, UptimeRobot contact unverified, deploys undocumented, and a 6-day IP certificate.

## 22. Pending work

- Commit (or discard) the invitation work; Exchange RBAC setup by an Exchange admin; configure env; deploy migration 0030; one real test email.
- Remediation plan items 1–16 (`docs/qa/FEATURE-PARITY-REMEDIATION-PLAN.md`), all **not started** (verified in code for items 1, 3, 4, 5, 12).
- macOS checklist (53 rows) and Windows checklist (77 rows) on physical machines.
- Code signing: Apple Developer ID + notarisation; Windows Authenticode.
- DNS name for the dashboard (stops 6-day IP certificates; needed for credible invitation links).
- Work schedules, IT Admin account, alert rules.
- Merge strategy for `deploy/hostinger-vps` → `main`.

## 23. Recommended next steps (priority order)

1. Turn on Hostinger auto-renewal or renew (owner, minutes).
2. Restore server visibility: get an authorised SSH key onto `tffdigitaladmin`, or reopen the console. Then run `deploy/scripts/vps-audit.sh` and confirm the release SHA, timers, last backup, last OneDrive upload, the 14 Nov API restart and integrity_check. Record the `4d66269` deploy in the status doc.
3. Verify alert delivery end-to-end (UptimeRobot contact, ntfy/Teams test message) — by the owner.
4. Fix Windows CI (remediation item 1). Bump the desktop version (e.g. 0.2.0), rebuild DMG + NSIS from that commit, and replace the downloads.
5. Remediation items 2 (macOS harness) and 3 (release log file, needs a decision), then the macOS and Windows physical checklists.
6. Commit the invitation work. Then complete the Exchange RBAC setup, deploy, and send one real invitation to a test mailbox.
7. Get a domain name for the dashboard.
8. HR/Legal: finalise notices and approve retention. Only then consider screenshots.
9. P1 Windows items 4, 5, 7, 8, 9; decision on item 10.

## 24. Production-readiness assessment

| Layer | Assessment |
|---|---|
| Server application | Functionally ready, deployed, healthy |
| Infrastructure | Healthy and lightly loaded; **renewal and observability gaps** |
| Desktop clients | **Not ready to scale**: stale builds, unsigned, unverified current code, no logs |
| Compliance | **Not ready**: draft notices, unapproved retention |
| Onboarding | Works manually (hand-over link); automatic email blocked |

**Verdict:** suitable for a **small supervised pilot** (a few employees, manual setup links, screenshots off) once
blockers 1–3 are closed. **Not** ready for company-wide rollout.

---

## Answers to the direct questions

1. **Actual status:** server deployed and healthy at `4d66269`; desktop clients one release behind; one pilot employee (Windows); compliance and signing not done.
2. **Latest commit:** `4d66269b776bc4cb092eea9932d94c90124467da` (local = `origin/deploy/hostinger-vps`).
3. **Deployed commit:** `4d66269`, established by route/UI fingerprinting and audit timestamps. The on-disk SHA is NOT VERIFIED (no shell).
4. **Production matches intended code?** Server: yes, for committed code. Desktop downloads: **no** (older). Uncommitted invitation work: not deployed.
5. **VPS healthy?** From hPanel and HTTP: yes (running, CPU 1 %, RAM 10 %, disk 7 %). OS-level health is NOT VERIFIED. Plan expiry risk.
6. **Database healthy?** Readiness ping up (0 ms). Integrity/WAL: NOT VERIFIED.
7. **Backups running?** Hostinger weekly: yes (12 Nov). App nightly + OneDrive: **NOT VERIFIED** since 11 Nov.
8. **Live app genuinely working?** Yes, for admin read paths with real production data. Usage is minimal (one shift, nothing since 13 Nov).
9. **Complete (DONE):** admin auth, manual onboarding, device registration, attendance recording, audit log, OneDrive connection, health/readiness, TLS/headers, desktop download hosting.
10. **Implemented but unverified:** IT Admin role live, employee panel live, data isolation live, screenshots, timelapses, retention purge, alerts, browser extension, offline sync, macOS current build, Windows current build, invitation emails, backup/alert delivery.
11. **Broken:** Windows CI (3 TS tests on Windows); no installer for the current code. Minor: ambiguous "Online" label; activity `source` trusted from the client.
12. **macOS ready for real employees?** **No.** Unsigned/un-notarised, served build predates current code, 0/53 current checklist rows run.
13. **Windows ready for real employees?** **Pilot only.** One real PC has run 0.1.0, but CI is red, there's no current installer, it's unsigned, credentials roam, there are no logs, and 0/77 checklist rows have been run.
14. **Automatic invitation emails operational?** **No.** Uncommitted, undeployed, and Exchange RBAC is not configured. No email has ever been sent.
15. **Five biggest blockers:** §21.
16. **Before employee onboarding:** renew the plan, verify backups/alerts, rebuild current installers (Windows CI fix + version bump), finalise notices, run at least the critical rows of both physical checklists. Onboarding can stay manual with setup links.
17. **Before production readiness:** all of the above, plus code signing, a domain name, retention approval, P1 Windows items, invitation emails live, documented deploys, and merging the branch strategy.
18. **Next, in order:** §23.
19. **Do NOT work on yet:** turning on screenshots, timelapses or website tracking for real employees; new features; the injected-input hooks (item 10) before an owner decision; Turso/Render paths (superseded); MSI/Intune packaging; widening the OneDrive app's permissions.
20. **Remaining effort (one engineer, plus owner/admin time):**

| Bucket | Basis | Estimate |
|---|---|---|
| Implementation | Remediation P0+P1 sized S/M in the plan: ≈ 2 S + 5 M (+ item 10 if approved), plus invitation commit/deploy and versioning | **4–6 working days** |
| Automated testing | Item 11 Windows CI tests, item 14 Windows harness (L) | **2–3 days** |
| Hardware verification | 53 macOS + 77 Windows checklist rows run today: **0/130 = 0 %** | **3–5 days** incl. fixes found |
| Deployment readiness | Renewal, shell access, backup/alert verification, domain + DNS, signing certificates (lead time external), Exchange RBAC, HR/Legal notices | **1–2 days of work, plus external lead time (often 1–3 weeks for signing and legal)** |

Realistic total: **about 2–3 weeks of engineering**, gated by external approvals. Percentages beyond the 0/130
checklist ratio are not given, because there is no defensible denominator for them.
