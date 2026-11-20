# Repository Consolidation Plan

Status: **proposal for approval — nothing has been executed.** Evidence: `WORKFOLIO-FOLDER-AND-REPOSITORY-INVENTORY.md`.

## 1. Finding that shapes the plan

There is nothing to *merge between repositories*: CI, distribution, installers, lock-break and phase-1 are already
**branches of the single `insight-workfolio` repository**, checked out as worktrees. The proposed monorepo layout
already exists on `main`:

```
insight-workfolio/
  apps/api            NestJS API (+ apps/api/test)
  apps/dashboard      Next.js admin + employee web
  apps/desktop        Tauri 2 desktop agent (+ test/)
  apps/browser-extension   website-domain tracker (exists today; keep)
  packages/shared     roles, schemas, shared types
  packages/database   migrations, libSQL client
  deploy/             caddy, systemd, tmpfiles, journald, scripts, env examples
  docs/               architecture, security, status, qa, desktop, releases (+ audit/)
  .github/workflows/  ci, deploy-staging, desktop-build, desktop-publish(-test), desktop-release
```

So consolidation means **finishing open branches, removing redundant worktrees/folders, and introducing tags and
releases** — not restructuring code. Tests stay next to each app (the existing convention); a top-level `tests/`
is not recommended.

## 2. What stays independent

| Item | Why |
|---|---|
| The GitHub repository itself | Single source; no transfer needed |
| Production server state (`/opt/workfolio/releases/*`, `/etc/workfolio/*.env`, `/var/lib/workfolio/db`) | Runtime, never in Git |
| Signing/updater secrets | GitHub Actions secrets only |
| Installer binaries | GitHub Releases (or the VPS downloads dir), **not** Git and not ad-hoc folders |

## 3. What becomes what

| Today | Becomes | Action |
|---|---|---|
| `insight-workfolio-ci` (branch fully in `main`) | nothing | remove worktree; delete branch after tagging nothing (no unique commits) |
| `insight-workfolio-phase1` (in `main`) | nothing | remove worktree; delete branch |
| `insight-workfolio-lockbreak` (3 CI-only commits) | tag `archive/windows-screen-lock-break` | review the 3 commits; cherry-pick any wanted into `main` via PR; tag; remove worktree |
| `insight-workfolio-distribution` (3 unique commits + untracked report) | PR into `main` | commit the report; rebase on `main`; PR; review Caddy diff against the live hotfix; merge; remove worktree |
| `insight-workfolio-installers` (uncommitted, unpushed) | WIP commit on its branch, pushed, then compared | owner reviews; if superseded by distribution → tag `archive/installer-release-manager-wip` and delete; else fold into the distribution PR |
| `release/desktop-0.2.1` | tag `desktop-v0.2.1` (+ GitHub Release with the `.exe`) | tag, then delete branch |
| `deploy/hostinger-vps`, `feature/automated-desktop-publishing` (both = `4215c8e`, in `main`) | tag `prod-2026-11-17` **only if** it is confirmed to be the deployed commit | tag, then delete both branches |
| `origin/hotfix/0.2.1-vps-transfer` (orphan, 2 files) | files under `deploy/hotfix/0.2.1/` on `main` **or** tag `hotfix-0.2.1-transfer` | owner choice; an orphan branch is the least discoverable option |
| `hotfix-0.2.1/` folder | archive outside the workspace (see Inventory §3.8) | after the `.exe` is on a GitHub Release or verified on the VPS |
| `insight-workfolio-wip-snapshot-20261118/` | nothing | delete (verified redundant) |
| `iw-macos-test-backup-20261116/` | nothing | delete after owner confirms test data |
| `apps/dashboard/public/downloads/*.dmg` (committed binary) | download from Releases/VPS | stop committing binaries; do **not** rewrite history to remove it (14 M repo, not worth the risk) |

## 4. Final working model

- **One folder**: `~/Desktop/Projects/workfolio/insight-workfolio`.
- Short-lived feature branches; use a worktree only while a branch is active, remove it when merged.
- **Tags**: `desktop-vX.Y.Z` for every desktop release; `prod-YYYY-MM-DD[-n]` for every production deploy (today none exist, which is why the deployed commit cannot be identified — see Current State §1).
- **Releases**: installers attached to GitHub Releases by `desktop-release.yml`; the VPS downloads dir is fed from there.
- **Deploy record**: one line per deploy in `docs/releases/` (commit, time, migrations applied, operator).
- **Health endpoint**: add the build commit to `/api/v1/health` (small change, Phase 0) so production's version is observable.

## 5. Git history preservation

- No force-push, no history rewrite, no squash of existing commits on `main`.
- Every branch with patch-unique commits is **tagged and pushed before** its branch is deleted (lock-break, installers WIP, hotfix orphan).
- Deleting a worktree never deletes commits; deleting a local branch that exists on origin is recoverable from origin; deleting an origin branch is recoverable only from a tag or reflog → therefore tag first.
- Before step 1 of §6, take a full mirror backup: `git clone --mirror https://github.com/YashSinghal2001/insight-workfolio.git ~/Backups/insight-workfolio-<date>.git` and a `tar` of the whole parent folder **excluding** `target/` and `node_modules/`.

## 6. Branch reconciliation order

| Step | Action | Gate |
|---|---|---|
| 0 | Mirror backup + folder tar (excl. build dirs) | — |
| 1 | `git worktree remove` `-ci`, `-phase1`; `git worktree prune` | `git worktree remove` refuses dirty trees |
| 2 | Installers: `git add -A && git commit -m "wip: installer-release-manager (unreviewed)"` **inside that worktree**, push, owner reviews diff vs distribution | owner decision |
| 3 | Distribution: commit the untracked report; rebase onto `main`; open PR; CI green; compare `deploy/caddy/Caddyfile.ip` with the live `/etc/caddy/Caddyfile` hotfix | review + CI |
| 4 | Lock-break: decide on 3 CI commits; tag `archive/…`; remove worktree | owner decision |
| 5 | Tag `desktop-v0.2.1`; identify the deployed commit (SSH read: `readlink /opt/workfolio/current` or release dir name) and tag `prod-…` | read-only SSH by owner |
| 6 | Delete merged/archived branches locally and on origin | tags pushed |
| 7 | Archive `hotfix-0.2.1/` outside the workspace; delete wip-snapshot; delete test backup | owner confirmation |
| 8 | `cargo clean` / remove `target/` dirs in removed worktrees (automatic with removal) | — |

## 7. Rollback

| Step undone | How |
|---|---|
| Worktree removed by mistake | `git worktree add ../<name> <branch>` (branch still exists locally/origin) |
| Local branch deleted | `git branch <name> origin/<name>` or `git branch <name> <tag>` |
| Origin branch deleted | `git push origin <tag>:refs/heads/<name>` |
| Bad merge into `main` | `git revert -m 1 <merge-sha>` (never reset a pushed `main`) |
| Folder deleted | restore from the step-0 tar; the repository from the mirror clone |
| Hotfix artefacts | `.exe` from GitHub Release / VPS; scripts from the orphan branch or its tag |

## 8. Risks

- **Uncommitted installers work** is the only thing that can be lost — handled by step 2 before anything else.
- The production Caddy config was hot-fixed outside Git's `main`; merging the distribution branch could regress or duplicate it → diff against live config first (read-only).
- Unknown deployed commit: tag only after verifying on the server.
