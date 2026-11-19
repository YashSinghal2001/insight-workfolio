# Desktop release distribution pipeline (GitHub Actions → VPS)

Builds the Windows and macOS desktop apps on GitHub, verifies them, and publishes them to the VPS:

- **installers** (`.exe`, `.dmg`) for the employee dashboard's **Desktop app** card, and
- the **in-app updater packages** and their signatures (`.exe` + `.sig`, `.app.tar.gz` + `.sig`).

Publishing is independent of the API, the dashboard and the database: no deploy, no restart, no migration.
Rolling a desktop release back never rolls anything else back.

## Flow

```
PRODUCTION  git tag -a desktop-vX.Y.Z -m "<release notes>" <sha> && git push origin desktop-vX.Y.Z
TEST        Actions → Desktop publish (VPS downloads) → Run workflow (any branch)

guard     production: tag format; commit must be on deploy/hostinger-vps; notes = the tag's message
build     desktop-build.yml, Windows x64 NSIS + macOS universal DMG (Apple Silicon + Intel):
          version in 3 files · unit + Rust tests · signing (production) · version, CPU architectures, bundle
          identity and code signature read from the built bytes · updater signatures verified with the API's
          own verifier (and a tampered copy must fail) · installer.json {file,size,sha256,commit,extra[]}
publish   starts only if BOTH platforms built and verified (deploy/scripts/desktop-publish.sh):
          1 re-check every file against installer.json; exactly one installer per platform
          2 ssh <publisher> upload   (receiver re-checks size+sha, refuses overwrite/downgrade)
          3 GET every file over public https, compare sha256
          4 ssh <publisher> activate (ONE atomic manifest write for both platforms, previous entries kept)
          5 GET the public manifest, then download each installer through the link it publishes
report    job summary + artifact release-report-<channel>-<version> (files, sizes, SHA-256, URLs, status)
```

A failure at any step leaves the published release exactly as it was: files of an unfinished release sit in
the folder but no manifest points at them.

| | Production | TEST |
|---|---|---|
| Trigger | approved tag `desktop-vX.Y.Z` | manual run |
| App | Insight Workfolio, real API | "Insight Workfolio Test" (`com.insightworkfolio.desktop.test`), placeholder API `https://api.example.invalid`: installs beside a real app, can reach no server |
| Secrets in the build | environment `production` | none (the caller passes no secrets) |
| Updater key | the environment's key pair | a pair generated in the job, masked, gone with the runner |
| GitHub environment for publishing | `desktop-downloads` (required reviewers) | `desktop-downloads-test` |
| VPS user / folder | `workfolio-publisher` / `/srv/workfolio-downloads` | `workfolio-publisher-test` / `/srv/workfolio-downloads/test` |
| File names | `insight-workfolio_X.Y.Z_<kind>` | `insight-workfolio-test_X.Y.Z_r<run>-<attempt>_<kind>` |
| URLs | `/desktop-downloads/<file>` | `/desktop-downloads/test/<file>` |
| Manifest | `/desktop-downloads/desktop-releases.json` (read by the dashboard) | `/desktop-downloads/test/desktop-releases.json` (read by nothing) |

`<kind>`: `windows-x86_64-setup.exe`, `macos-universal.dmg` (installers); `windows-x86_64-setup.exe.sig`,
`darwin-universal.app.tar.gz`, `darwin-universal.app.tar.gz.sig` (updater).

An unsigned TEST build cannot become a production download: each receiver accepts only its own channel's
names, the two channels have different keys, users and folders, and the dashboard reads only the production
manifest.

## Dashboard

`/my` → **Desktop app** reads `/desktop-downloads/desktop-releases.json` at runtime (validated; same-origin
links only) and falls back to the bundled `apps/dashboard/src/lib/desktop-releases.json`. It shows the latest
version, release date, size, architecture, SHA-256, the release notes, and puts the installer for the
visitor's own computer first. No version or URL is hardcoded.

## In-app updates

The updater (Tauri updater plugin, `docs/desktop/AUTO-UPDATE-ARCHITECTURE.md`) asks the API, not the VPS
folder: an administrator creates the release in the dashboard (**Desktop app updates**) with each package's
URL and signature, tests it, and a Super Admin publishes it (`AUTO-UPDATE-RELEASE-GUIDE.md`). This pipeline
delivers the packages and signatures to `https://<host>/desktop-downloads/`; the release report lists the URLs.

**Open point:** the production API refuses package URLs whose host is an IP address
(`desktop-updates.service.ts`), and production is still `https://189.72.144.117`. Until the site has a host
name (or that rule is changed and the API redeployed), reference the GitHub pre-release packages from
`desktop-release.yml` instead.

## What a publisher key can do on the VPS

No password, no shell, no sudo. The key runs only `/usr/local/lib/workfolio/desktop-downloads-receiver`
(authorized_keys `restrict,command=` plus sshd `ForceCommand`; the channel's folder and `--test` are fixed
there, never taken from the client). The receiver accepts `upload`, `activate`, `status`, `history` and
nothing else, writes only in its folder and never deletes or replaces a published file. Home and
authorized_keys are root-owned.

Each folder is `root:<publisher>` mode `1775` (group-writable and **sticky**): the publisher can add files and
rename over only files it owns (its manifest). It cannot delete, rename or replace root-owned entries (older
rollback installers, the `test` folder), even with a shell. The test publisher has no write access to the
production folder at all.

| Guarantee | Where |
|---|---|
| No partial file served | upload goes to `.incoming/` (not served), then `link()` to the final name only after size+sha match |
| Never overwrite | `link()` fails on an existing name; identical bytes = no-op, different = refused |
| No duplicate/downgrade | upload and activate refuse anything older than the published release |
| Both platforms or neither | the client refuses a release without exactly one installer per platform before uploading anything; `activate` writes both entries in one `rename()` |
| Metadata only after verification | activate runs after the public https check and re-hashes every file under a lock |
| Previous releases stay | files are never deleted; each entry carries `previous` |
| Audit | `desktop-release-history.jsonl` in the folder (append-only, not served): every upload, activation and rollback with time, checksum and commit; `ssh <publisher> history` or `receiver history` prints it |
| No secrets in logs | key written to a 0600 temp file from a masked secret and deleted on exit; tested by grepping the client logs for key material |
| Private updater keys never on the VPS | only packages and `.sig` files are uploaded; the receiver accepts no other kind of file |

## One-time setup

GitHub (done from a workstation with `gh`):

| Environment | Secrets | Variables | Protection |
|---|---|---|---|
| `desktop-downloads` | `DESKTOP_PUBLISH_SSH_KEY`, `DESKTOP_PUBLISH_KNOWN_HOSTS` | `DESKTOP_DOWNLOADS_ORIGIN=https://189.72.144.117`, `DESKTOP_PUBLISH_SSH_TARGET=workfolio-publisher@189.72.144.117` | required reviewers; tags `desktop-v*` only |
| `desktop-downloads-test` | same two names, the **test** key | same origin, `DESKTOP_PUBLISH_SSH_TARGET=workfolio-publisher-test@189.72.144.117` | none |
| `production` | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; code signing: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`; `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | `WORKFOLIO_UPDATER_PUBKEY`, `WORKFOLIO_API_URL`, `WORKFOLIO_DASHBOARD_URL` | required reviewers |

The key pairs are generated with `ssh-keygen -t ed25519 -N ''`; the private halves exist only as GitHub
secrets. A production build refuses to start without the updater key pair. Without the Apple / Azure
secrets it still builds, **unsigned**, and says so in the run (warning) and in `installer.json`
(`codeSigned: false`); with them, the build fails unless the signature is valid, timestamped (Windows),
hardened-runtime, notarized, stapled and accepted by Gatekeeper (macOS).

VPS, as root (changes sshd configuration; reloads sshd only):

```
git clone --depth 1 --branch <branch> https://github.com/YashSinghal2001/insight-workfolio.git /root/wf-dist
cd /root/wf-dist && git rev-parse HEAD        # must be the reviewed commit
bash deploy/scripts/install-desktop-publisher.sh /root/publish.pub
bash deploy/scripts/install-desktop-publisher.sh /root/publish-test.pub test
```

VPS, Caddy route (**needs approval**: Caddy runs with `admin off`, so this is a restart, HTTPS pauses for a
few seconds). First check the live file is the version this change was made from, then:

```
( set -euo pipefail
  cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
  install -m 644 -o root -g caddy /root/wf-dist/deploy/caddy/Caddyfile.ip /etc/caddy/Caddyfile
  (set -a; . /etc/caddy/workfolio.env; set +a; runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile)
  systemctl restart caddy; systemctl is-active caddy )
```

If validation fails, copy the backup back (Caddy was not restarted). Rollback of the route: copy the backup
back and `systemctl restart caddy`.

## Releasing

Bump the version in the 3 files (`AUTO-UPDATE-RELEASE-GUIDE.md`, step 1), merge to `deploy/hostinger-vps`,
then tag with the release notes and push the tag. Approve the `desktop-downloads` deployment when both
builds are green. Read the release report. **Re-run failed jobs** is safe: completed steps are no-ops.

## Rollback (root on the VPS, no CI)

```
R=/usr/local/lib/workfolio/desktop-downloads-receiver
sudo -u workfolio-publisher $R status                    # what is published
sudo -u workfolio-publisher $R history                   # every upload, activation, rollback
sudo -u workfolio-publisher $R rollback windows          # swap current and previous (run again to undo)
sudo -u workfolio-publisher $R rollback macos 0.2.2      # restore any earlier version from the history
```

The installer must still be on disk with its recorded checksum. Download links change immediately. Nothing
restarts. Test channel: `sudo -u workfolio-publisher-test $R --dir /srv/workfolio-downloads/test --test …`.

In-app updates are stopped or rolled back in the dashboard (`AUTO-UPDATE-RELEASE-GUIDE.md`): installed apps
never move to a lower version.

## Tests

- `deploy/scripts/desktop-publish-selftest.sh` (any developer machine: python3, jq, curl, caddy). Runs the real
  receiver behind a fake `ssh`, the real client, and Caddy with the production route block over https. Covers
  refusals, overwrite, downgrade, tampered artifacts, all-or-nothing, the public-URL gate, the TEST channel's
  isolation, updater files, release notes, the audit log and rollback (previous and by version).
- `deploy/scripts/desktop-publish-sshtest.sh` (**disposable Linux machine only**: it refuses to run where
  `/opt/workfolio` exists). As root it runs the real installer for both channels, real sshd with the Match
  blocks, and official Caddy. It then tests the forced commands (shell, sftp, scp, port forwarding, pty,
  injection, each key against the other user), the sticky-bit protection, a production and a TEST release at
  the same time, the logs and rollback.
- `.github/workflows/desktop-publish-test.yml` runs both on GitHub runners. It also builds the unsigned
  placeholder Windows installer and checks `verify-windows-installer.ps1` accepts it and rejects a wrong
  version, a 32-bit binary and a non-PE file. And it runs actionlint.
- A TEST run of `desktop-publish.yml` is the end-to-end rehearsal against the real VPS.

Not covered by CI: launching either installer, the Intel slice on Intel hardware, and an in-app update on a
physical machine (`docs/qa/AUTO-UPDATE-*-QA.md`).
