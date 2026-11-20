# Workfolio Folder and Repository Inventory

Audited 2026-11-19 (~22:30 IST) on the owner's Mac. Read-only: `git status/log/branch/worktree/cherry/diff/merge-base/
ls-remote/cat-file/apply --check`, `du`, `find`, `shasum`, and `sqlite3` on **copies** of two queue databases (copies
deleted afterwards). No `git fetch`, checkout, stash, prune, delete, move or rename was run. Secret files were located
by name only and never opened.

Parent directory: `/Users/yashsinghal/Desktop/Projects/workfolio/` — all nine requested folders are here (names differ
slightly from the brief: `hotfix-0.2.1`, `insight-workfolio-lockbreak`, `insight-workfolio-phase1`,
`insight-workfolio-wip-snapshot-20261118`, `iw-macos-test-backup-20261116`). No copies were found elsewhere.

## 1. The answer in one paragraph

There is **one** Git repository (`github.com/YashSinghal2001/insight-workfolio`, private [I]). Five of the folders are
**Git worktrees** of it — extra checkouts of different branches that share the single `.git` inside
`insight-workfolio/` (each has a `.git` *file* pointing to `insight-workfolio/.git/worktrees/<name>`). The other three
are **not Git repositories**: a hotfix staging folder, a WIP patch snapshot, and a backup of a test Mac install. So the
folder sprawl comes from **worktrees per feature branch plus ad-hoc artifact folders**, not from separate repositories.
Disk use is dominated by **regenerable Rust build output** (`src-tauri/target`: 17 G + 3.8 G + 2.5 G) and per-worktree
`node_modules` (589 M each), not by source.

## 2. Inventory table

| Folder | Purpose | Git repo? | Unique content? | Active/Archived | Safe to delete? |
|---|---|---|---|---|---|
| `insight-workfolio` | Primary checkout, branch `main` | Yes — the repository (`.git` dir, 14 M) | Yes (source of truth) | Active | **KEEP** |
| `insight-workfolio-ci` | Worktree, `ci/dual-platform-installers` | Worktree | **No** — its only commit is patch-equivalent to `40edf38` on `main`; clean; pushed | Done | **SAFE TO DELETE** (as a worktree, see §4) |
| `insight-workfolio-distribution` | Worktree, `feature/installer-distribution` | Worktree | **Yes** — 3 commits not in `main` (pushed) + 1 untracked report found nowhere else | Active (last commit 2026-11-19 12:11) | **KEEP** until merged |
| `insight-workfolio-installers` | Worktree, `feature/installer-release-manager` | Worktree | **Yes — uncommitted, not pushed**: 6 modified + 3 untracked files | Stale (edits 2026-11-18 11:45) | **NEEDS REVIEW** |
| `insight-workfolio-lockbreak` | Worktree, `feature/windows-screen-lock-break` | Worktree | Partly — feature merged; 3 CI commits not in `main` (pushed) | Done (feature) | **ARCHIVE** (tag branch, then remove worktree) |
| `insight-workfolio-phase1` | Worktree, `feature/phase1-delegated-invitation-mail` | Worktree | **No** — commit patch-equivalent to `207a2d1` on `main`; clean; pushed | Done | **SAFE TO DELETE** (as a worktree) |
| `insight-workfolio-wip-snapshot-20261118` | Patch + tar of WIP taken before the 2026-11-19 commits | No | **No** — every change verified in `main` (§3.7) | Obsolete | **SAFE TO DELETE** |
| `hotfix-0.2.1` | Staging for the 0.2.1 Windows installer + Caddy hotfix on the VPS | No | Partly — scripts are in Git (orphan branch); the `.exe` and an encrypted bundle are only here | Recent (2026-11-19 21:35) | **ARCHIVE** (after the checks in §3.8) |
| `iw-macos-test-backup-20261116` | Backup of a 0.1.0 macOS test install + its app-support data | No | Yes — 15 **unsynced** activity rows (Oct 13–19) in a local queue DB | Obsolete test data | **NEEDS REVIEW** |

## 3. Folder-by-folder evidence

Common to all worktrees: remote `origin https://github.com/YashSinghal2001/insight-workfolio.git`; no tags exist in
the repository; no stash entries. Remote state below is from `git ls-remote` (live) — it matches the local
remote-tracking refs, so the local view is current.

### 3.1 `insight-workfolio` (primary)
- Path `/Users/yashsinghal/Desktop/Projects/workfolio/insight-workfolio`; branch `main` @ `0493e54` (2026-11-19 08:17 +0530), equal to `origin/main`; working tree clean (before these audit docs were added).
- Size 18 G = `apps/desktop/src-tauri/target` **17 G** (build cache) + `node_modules` 589 M + `.next` caches + `graphify-out` 9.7 M (ignored) + `.git` 14 M.
- Installer artifacts: `apps/dashboard/public/downloads/Insight-Workfolio_0.1.0_universal.dmg` (6.6 M, **committed to Git**); build outputs in `target/`: `Insight Workfolio_0.2.1_aarch64.dmg`, `Insight Workfolio Test_0.2.1_universal.dmg`.
- Database files: `apps/api/data/dev.db` (local development DB, ignored).
- Secret-bearing files (by name, not opened): `apps/api/.env.staging` (git-ignored). No `.pem/.key/.p12/.pfx/.p8/id_*` outside build dirs.
- Worktree metadata also lists a **prunable** worktree at a deleted `/private/tmp/claude-501/…/scratchpad/rel` (detached `4d66269`); the directory no longer exists.

### 3.2 Local and remote branches

| Branch | Tip | vs `main` (behind/ahead) | Patch-unique commits | On origin | Worktree |
|---|---|---|---|---|---|
| `main` | `0493e54` | 0/0 | — | ✓ | `insight-workfolio` |
| `ci/dual-platform-installers` | `445b1e0` | 5/1 | 0 | ✓ | `-ci` |
| `feature/phase1-delegated-invitation-mail` | `a5f9796` | 5/1 | 0 | ✓ | `-phase1` |
| `feature/windows-screen-lock-break` | `0f6dd86` | 5/4 | **3** (`6c22308`, `0d94cfc`, `0f6dd86`: CI only) | ✓ | `-lockbreak` |
| `feature/installer-distribution` | `74ad393` | 5/4 | **3** (`2289431`, `d37bd73`, `74ad393`) | ✓ | `-distribution` |
| `feature/installer-release-manager` | `4215c8e` | 5/0 | 0 (but dirty worktree) | ✗ local only | `-installers` |
| `deploy/hostinger-vps` | `4215c8e` | 5/0 | 0 | ✓ | — |
| `feature/automated-desktop-publishing` | `4215c8e` | 5/0 | 0 | ✓ | — |
| `release/desktop-0.2.1` | `cebfb5c` | 8/0 | 0 | ✓ | — |
| `origin/hotfix/0.2.1-vps-transfer` | `d93dd2d` | **orphan** (no common ancestor), 1 commit | 2 files | ✓ remote only | — |

"Patch-unique" = `git cherry main <branch>` lines marked `+`. On 2026-11-19 08:16–08:17 the feature work was
re-applied onto `main` as fresh commits (`40edf38`, `06bb9ed`, `207a2d1`, `2f43266`), which is why branches show
"ahead" counts that are not real unmerged work.

### 3.3 `insight-workfolio-ci`
- `.git` file → `insight-workfolio/.git/worktrees/insight-workfolio-ci`. Branch `ci/dual-platform-installers` @ `445b1e0` (2026-11-18 23:50).
- `git cherry`: `- 445b1e0` (equivalent in `main`). Every file it changed is byte-identical in `main`.
- Clean, 13 M (no build output, no `node_modules`). **Redundant.**

### 3.4 `insight-workfolio-phase1`
- Branch `feature/phase1-delegated-invitation-mail` @ `a5f9796` (2026-11-18 16:54). `git cherry`: `- a5f9796`.
- Four files differ from `main` (`apps/api/.env.example`, `apps/api/src/config/env.ts`, `deploy/env/api.env.example`, `docs/invitations.md`) only because `main`'s later notifications commit `2f43266` edited the same lines (wording about `REPORT_MAIL_PROVIDER`). Superseded, not lost.
- Clean, 605 M (`node_modules`). **Redundant.**

### 3.5 `insight-workfolio-lockbreak`
- Branch `feature/windows-screen-lock-break` @ `0f6dd86` (2026-11-18 13:14). Feature commit `c02f4e2` ≡ `06bb9ed` on `main`; `apps/desktop/src/lock-break.ts` identical.
- **Not in `main`:** three CI commits (Windows QA installer verification + SHA-256 metadata, push-triggered QA build, manual unsigned aarch64 QA DMG). `.github/workflows/ci.yml` differs from `main`. Pushed to origin, so not at risk locally.
- 4.4 G, of which `target/` 3.8 G (contains `Insight Workfolio_0.2.1_aarch64.dmg`, a rebuildable QA artifact).
- Decision needed: are the 3 CI commits wanted in `main` (they overlap `40edf38`'s dual-platform CI)? → ARCHIVE via tag.

### 3.6 `insight-workfolio-distribution`
- Branch `feature/installer-distribution` @ `74ad393` (2026-11-19 12:11). Unmerged and patch-unique: all-or-nothing release distribution to the VPS with TEST channel/history/rollback (`2289431`), dashboard Desktop-app card test (`d37bd73`), signing-variable fix (`74ad393`). 19 files / +1 462 −500 vs its base; touches `deploy/caddy/Caddyfile*`, `desktop-publish*.sh`, workflows, `/my` downloads card.
- **Untracked and found nowhere else:** `docs/status/WORKFOLIO-0.2.1-INSTALLER-HOTFIX-REPORT.md` (6.5 K) — must be preserved (commit it or copy it to `main`'s `docs/status/`).
- 3.2 G (`target/` 2.5 G, `node_modules` 589 M). **Active work.**
- Deployment relevance: production Caddy may already carry part of this via the hotfix (§3.8) — reconcile before merging.

### 3.7 `insight-workfolio-wip-snapshot-20261118`
- Files: `BASE_SHA` (= `4215c8e`), `tracked-changes.patch` (111 K, 32 files), `untracked-files.tar` (13 files).
- `git apply --check -R tracked-changes.patch` on `main` **succeeds** → every tracked change is already in `main`.
- All 13 untracked files extracted to a temp dir and compared with `main`: **13/13 byte-identical** (notifications module, lock-break, QA doc, etc.). Temp dir deleted.
- **Fully redundant.** 308 K.

### 3.8 `hotfix-0.2.1`
- `apply-hotfix-0.2.1.sh` and `Caddyfile.ip.narrow`: **byte-identical** to the two files on orphan branch `origin/hotfix/0.2.1-vps-transfer` (`d93dd2d`, 2026-11-19 21:40). `Caddyfile.ip.narrow` is also identical to `main:deploy/caddy/Caddyfile.ip`.
- `Insight-Workfolio_0.2.1_x64-setup.exe` (3 519 222 B, SHA-256 `241663ad…6febc273`) — the script pins exactly this size/hash and copies it to `/srv/workfolio-downloads/` on the VPS. **No other local copy exists.** Whether the VPS copy exists was not checked (no SSH in this audit).
- `workfolio-hotfix-bundle.tar.gz.enc` (10 K, OpenSSL salted-password encryption, created 21:35). Contents **not determinable** without the passphrase (not attempted). [I] the transfer bundle of the two scripts.
- The script's comments name a VPS path `/opt/workfolio/installer-pipeline-audit/…` (a checkout on the server).
- **ARCHIVE** once (a) the VPS copy of the `.exe` is confirmed by hash, or the `.exe` is attached to a GitHub Release, and (b) the owner confirms the `.enc` bundle is only the transfer copy.

### 3.9 `insight-workfolio-installers`
- Branch `feature/installer-release-manager` @ `4215c8e` (same commit as `main~5`; **branch never pushed**).
- **Uncommitted** (2026-11-18 ~11:45): modified `.github/workflows/desktop-build.yml`, `desktop-publish-test.yml`, `apps/dashboard/src/lib/desktop-releases.json` (9 lines removed), `deploy/scripts/desktop-publish-selftest.sh`, `desktop-publish-sshtest.sh`, `docs/desktop/DESKTOP-PUBLISH-PIPELINE.md` (+63/−19 total). **Untracked**: `deploy/scripts/desktop-build-workflow-test.py`, `verify-desktop-artifact.mjs`, `verify-desktop-artifact.test.mjs` — **absent from every branch**.
- None of the six modified files match `feature/installer-distribution`, which was written the day after. [I] an earlier draft of the distribution work, possibly superseded — **cannot be proven**, so this is the one folder where deletion could lose work.
- 670 M (`node_modules`).

### 3.10 `iw-macos-test-backup-20261116`
- `Insight Workfolio.app` (v0.1.0, 3.8 M) + `app-support-com.insightworkfolio.desktop/` (4.1 M) + `moved-originals/` (11 M: a second copy of both).
- Each `attendance-queue.db` (read from copies): `events` 0 rows; `activity` **16 rows — 15 `PENDING`, 1 `REJECTED`** (2026-10-13 → 2026-10-19 UTC); `screenshots` 0; `kv` ~153 rows of per-user/device state keys (values not read). `screenshots/` folder empty.
- The pending rows predate the production launch (2026-11-10), so they belonged to a development/test server and **cannot be synced to production**. They are employee-monitoring data (app names, times) → privacy-sensitive to keep around.
- The live Mac also has `~/Library/Application Support/com.insightworkfolio.desktop` and `…desktop.qa` (current installs; not touched).
- **NEEDS REVIEW** → recommended outcome: delete after the owner confirms it was test data.

## 4. Deletion / archive procedure (for approval — nothing executed)

Worktrees must be removed with Git, not Finder, or `.git/worktrees/` keeps stale entries:

```bash
cd ~/Desktop/Projects/workfolio/insight-workfolio
git worktree remove ../insight-workfolio-ci         # refuses if dirty — that is the safety check
git worktree remove ../insight-workfolio-phase1
git worktree prune                                   # clears the missing /private/tmp/.../rel entry
```

Branch hygiene (after the worktree is gone; the branch stays on origin unless deleted there too):

```bash
git tag archive/windows-screen-lock-break feature/windows-screen-lock-break && git push origin archive/windows-screen-lock-break
git tag desktop-v0.2.1 release/desktop-0.2.1 && git push origin desktop-v0.2.1
```

Recoverable space if every SAFE/ARCHIVE item is acted on and build caches are cleaned: ≈ 21 G of `target/` (`cargo clean` or
deleting `target/`; fully regenerable), ≈ 2.4 G of duplicate `node_modules`, ≈ 30 M of artifacts.

## 5. Deployment configuration and signing material

| Item | Location | Note |
|---|---|---|
| Production deploy scripts, Caddy, systemd, tmpfiles, journald | `insight-workfolio/deploy/` (all worktrees) | Tracked in Git |
| Hotfix scripts | `hotfix-0.2.1/` + orphan branch | Identical copies |
| Env examples | `apps/api/.env.example`, `deploy/env/*.env.example` | Templates only |
| Real env file | `insight-workfolio/apps/api/.env.staging` | Git-ignored; **not opened**; keep out of any archive that leaves the Mac |
| Signing keys / certificates | **None found** on disk outside build dirs (by filename). [D] Updater and code-signing secrets are GitHub Actions secrets (`74ad393` handles unset ones) | — |
| Encrypted bundle | `hotfix-0.2.1/workfolio-hotfix-bundle.tar.gz.enc` | Passphrase-protected; contents unknown |
