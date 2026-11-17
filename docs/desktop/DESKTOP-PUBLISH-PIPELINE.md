# Desktop installer publishing pipeline (VPS downloads page)

Puts verified Windows and macOS installers on the employee dashboard's **Desktop app** card. It does **not**
ship in-app updates: those still go through `desktop-release.yml` and the dashboard's Desktop app updates
page (AUTO-UPDATE-RELEASE-GUIDE.md).

## Flow

```
push tag desktop-vX.Y.Z  (tag ruleset: only release managers)
  guard     tag format; commit must be on deploy/hostinger-vps
  build     desktop-build.yml, env `production`: version check in 3 files, tests, signing,
            version + CPU arch read from the built DMG/EXE, installer.json {file,size,sha256,commit}
            Windows and macOS independent (fail-fast off)
  publish   per platform, env `desktop-downloads` (REQUIRED REVIEWERS = manual approval; holds only the SSH key)
            1 re-check artifact against installer.json
            2 ssh workfolio-publisher upload  (receiver re-checks size+sha, refuses overwrite/downgrade)
            3 GET https://<host>/desktop-downloads/<file>, compare sha256
            4 ssh workfolio-publisher activate (atomic manifest swap, previous entry kept)
            5 GET the public manifest, check file+sha256
  report    job summary + artifact release-report-X.Y.Z: commit, version, platform, file, size, sha256, URL, status
```

The dashboard reads `/desktop-downloads/desktop-releases.json` at runtime (validated; same-origin links only)
and falls back to the bundled `apps/dashboard/src/lib/desktop-releases.json`. So publishing needs **no
dashboard deploy, no restart, no migration**.

## What the GitHub identity can do on the VPS

User `workfolio-publisher`: no password, no shell access, no sudo. Its key runs only
`/usr/local/lib/workfolio/desktop-downloads-receiver` (authorized_keys `restrict,command=` plus sshd
`ForceCommand`). The receiver accepts `upload`, `activate` and `status` and nothing else. File names must match
`insight-workfolio_X.Y.Z_{windows-x86_64-setup.exe|macos-universal.dmg|macos-aarch64.dmg}`. It writes only in
`/srv/workfolio-downloads` and never deletes or replaces an installer. Its home and authorized_keys are root-owned.

The folder is `root:workfolio-publisher` with mode `1775` (group-writable and **sticky**). The publisher can add
files, and can rename over only files it owns (its manifest). It cannot delete, rename or replace the root-owned
installers already there, even with a shell. Owning the folder would not be enough: a directory's owner can
remove any entry in it, sticky bit or not. Installers the publisher uploaded are its own files. They are protected
by the forced command (the receiver never deletes or replaces), not by file permissions.

| Guarantee | Where |
|---|---|
| No partial file served | upload goes to `.incoming/` (not served by Caddy), then `link()` to the final name only after size+sha match |
| Never overwrite | `link()` fails on an existing name; identical bytes = no-op, different = refused |
| No duplicate/downgrade | upload and activate refuse a version ≤ the published one (same version + same bytes = no-op, so re-runs are safe) |
| Metadata only after verification | activate runs after the public https check; it re-hashes the file under a lock |
| Atomic metadata | temp file + `rename()`; readers see old or new, never half |
| Rollback kept | installers are never deleted; each entry carries `previous` |
| Root-owned rollback installers | sticky folder owned by root; tested with a real shell as the publisher (rm, mv, rename-over, append, chmod) |
| Concurrent publishes | the two platforms' activations serialize on `.publish.lock` (flock); tested in parallel |
| No secrets in logs | key written to a 0600 temp file from a masked secret and deleted on exit; tested by grepping the client logs for key material |
| Platforms independent | separate build legs, publish legs and manifest keys; one failing leaves the other published |

## One-time setup (needs approval; changes production)

1. Generate a key **offline**: `ssh-keygen -t ed25519 -N '' -C desktop-publish -f publish_key`.
2. On the VPS as root, from a checkout of the commit containing this pipeline:
   `deploy/scripts/install-desktop-publisher.sh publish_key.pub`. It prints the host-key line.
3. Caddy: install the updated `deploy/caddy/Caddyfile.ip` (adds the `desktop-releases.json` route), using the
   validate → restart procedure from the 0.2.1 runbook.
4. Deploy the dashboard once (`deploy.sh <SHA>`, no `--migrate`) so it reads the runtime manifest.
5. GitHub → Settings → Environments → `desktop-downloads`: required reviewers; deployment tags `desktop-v*` only;
   secrets `DESKTOP_PUBLISH_SSH_KEY` (private key), `DESKTOP_PUBLISH_KNOWN_HOSTS` (line from step 2);
   variables `DESKTOP_DOWNLOADS_ORIGIN=https://189.72.144.117`, `DESKTOP_PUBLISH_SSH_TARGET=workfolio-publisher@189.72.144.117`.
   Then delete the local private key.
6. Settings → Rules → new tag ruleset for `desktop-v*`: restrict creation/update/deletion to release managers.
7. Environment `production` must hold the updater key pair (`TAURI_SIGNING_*`, `WORKFOLIO_UPDATER_PUBKEY`)
   and `WORKFOLIO_API_URL`/`WORKFOLIO_DASHBOARD_URL`. The build refuses to run without them.

## Releasing

Bump the version in the 3 files, merge to `deploy/hostinger-vps`, then
`git tag desktop-vX.Y.Z <sha> && git push origin desktop-vX.Y.Z`. Approve the two `desktop-downloads`
deployments when the builds finish. Read the release report.

A failed platform can be retried with **Re-run failed jobs**: completed steps are no-ops. If one platform's
build is broken, the other is still published. Fix it and release a new patch version for both.

## Rollback (root on the VPS, no CI)

```
sudo -u workfolio-publisher /usr/local/lib/workfolio/desktop-downloads-receiver status
sudo -u workfolio-publisher /usr/local/lib/workfolio/desktop-downloads-receiver rollback windows   # or macos; run again to undo
```

This swaps the current and previous manifest entries. The installer files stay in place. Download links change
immediately. Nothing restarts.

## Tests

- `deploy/scripts/desktop-publish-selftest.sh` (any developer machine: python3, jq, curl, caddy). Runs the real
  receiver behind a fake `ssh`, the real client, and Caddy with the production route block over https. Covers
  refusals (including names with a quoted trailing newline), overwrite, downgrade, tampered artifacts, platform
  independence, the public-URL gate and rollback.
- `deploy/scripts/desktop-publish-sshtest.sh` (**disposable Linux machine only**: it refuses to run where
  `/opt/workfolio` exists). As root it runs the real installer, real sshd with the Match block, and official
  Caddy. It then tests the forced command (shell, sftp, scp, port forwarding, pty, injection), the sticky-bit
  protection, concurrent publishing, the logs and rollback.
- `.github/workflows/desktop-publish-test.yml` runs both on GitHub runners. It also builds the unsigned
  placeholder Windows installer and checks `verify-windows-installer.ps1` accepts it and rejects a wrong
  version, a 32-bit binary and a non-PE file. And it runs actionlint.
