#!/usr/bin/env bash
# Build a git ref into a new release directory, gate on pending migrations, switch the `current` symlink,
# restart both services and health-check. Run as the workfolio user on the VPS (it owns /opt/workfolio; the
# sudoers rule from install-vps.sh lets it restart the two units).
#
#   deploy.sh [<ref>]            build <ref> (default origin/main); refuse to activate while migrations are pending
#   deploy.sh <ref> --migrate    same, but back up the database and apply pending migrations before activating
#   deploy.sh --migrate-only     back up and migrate with the CURRENT release's build (after a restore)
#   deploy.sh --rollback         switch back to the previous release and restart (schema is not rolled back)
#
# Layout: $WORKFOLIO_ROOT/repo (bare-ish clone), releases/<ts>-<sha>/ (git archive + build), current -> release,
# current.previous -> the one before. The three newest releases are kept.
. "$(dirname "$(readlink -f "$0")")/lib.sh"

: "${WORKFOLIO_REPO_URL:=}"
: "${KEEP_RELEASES:=3}"
repo="$WORKFOLIO_ROOT/repo"
releases="$WORKFOLIO_ROOT/releases"
current="$WORKFOLIO_ROOT/current"
previous="$WORKFOLIO_ROOT/current.previous"
dashboard_env="$WORKFOLIO_ENV_DIR/dashboard.env"
scripts="$(dirname "$(readlink -f "$0")")"

ref="origin/main"
migrate=0
mode=deploy
for arg in "$@"; do
  case "$arg" in
    --migrate) migrate=1 ;;
    --migrate-only) mode=migrate-only ;;
    --rollback) mode=rollback ;;
    -*) die "unknown option $arg" ;;
    *) ref="$arg" ;;
  esac
done
[ "$(id -u)" != 0 ] || die "run as $WORKFOLIO_USER, not root"

restart_and_check() {
  log "restarting $API_SERVICE"
  svc restart "$API_SERVICE"
  sleep 3
  "$scripts/healthcheck.sh" --no-ready --no-dashboard || die "API unhealthy after restart; journalctl -u $API_SERVICE --since -5min"
  log "restarting $DASHBOARD_SERVICE"
  svc restart "$DASHBOARD_SERVICE"
  sleep 3
  "$scripts/healthcheck.sh" --no-ready || die "dashboard unhealthy after restart; journalctl -u $DASHBOARD_SERVICE --since -5min"
}

backup_and_migrate() {
  if [ -f "$WORKFOLIO_DB" ]; then
    log "backup before migrating"
    "$scripts/backup-db.sh"
  else
    log "no database yet at $WORKFOLIO_DB (first deploy): nothing to back up"
  fi
  log "applying migrations"
  migrate_cli
}

case "$mode" in
  rollback)
    [ -L "$previous" ] || die "no previous release recorded"
    target=$(readlink -f "$previous")
    [ -d "$target" ] || die "previous release $target is gone"
    log "rolling back to $target (the database schema stays as it is; an older build refuses unknown migrations by design)"
    ln -sfn "$(readlink -f "$current")" "$previous"
    ln -sfn "$target" "$current"
    restart_and_check
    log "rollback complete: current -> $target"
    exit 0 ;;
  migrate-only)
    out=$(migrate_cli --dry-run)
    printf '%s\n' "$out"
    printf '%s\n' "$out" | grep -q '^PENDING' || { log "nothing pending"; exit 0; }
    backup_and_migrate
    log "migrated; restart the API: sudo systemctl restart $API_SERVICE"
    exit 0 ;;
esac

# ---- deploy -------------------------------------------------------------------------------
need git
need "$NODE"
need pnpm
[ -r "$dashboard_env" ] || die "cannot read $dashboard_env (NEXT_PUBLIC_API_URL is baked into the dashboard build)"
[ -r "$WORKFOLIO_API_ENV" ] || die "cannot read $WORKFOLIO_API_ENV"

if [ ! -d "$repo/.git" ]; then
  [ -n "$WORKFOLIO_REPO_URL" ] || die "first deploy: set WORKFOLIO_REPO_URL (e.g. git@github.com:YashSinghal2001/insight-workfolio.git)"
  log "cloning $WORKFOLIO_REPO_URL"
  git clone --quiet "$WORKFOLIO_REPO_URL" "$repo"
fi
git -C "$repo" fetch --quiet --prune origin
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}") || die "unknown ref $ref"
release="$releases/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"
mkdir -p "$release"
log "release $release from $ref ($sha)"
git -C "$repo" archive "$sha" | tar -x -C "$release"
printf '%s\n' "$sha" > "$release/RELEASE_SHA"

cd "$release"
export NODE_ENV=production
log "installing dependencies (frozen lockfile)"
pnpm install --frozen-lockfile --prod=false --reporter=append-only
log "building packages and API"
pnpm build:packages
pnpm --filter @workfolio/api build
# NEXT_PUBLIC_API_URL is the only build-time value; read just that key (no sourcing of the whole file).
NEXT_PUBLIC_API_URL=$(sed -n 's/^NEXT_PUBLIC_API_URL=//p' "$dashboard_env" | tail -1)
[ -n "$NEXT_PUBLIC_API_URL" ] || die "NEXT_PUBLIC_API_URL missing in $dashboard_env"
export NEXT_PUBLIC_API_URL
log "building dashboard for $NEXT_PUBLIC_API_URL"
pnpm --filter @workfolio/dashboard build

# ---- migration gate (against the NEW build's migrations) ---------------------------------------
WORKFOLIO_API_DIR="$release/apps/api"
out=$(migrate_cli --dry-run)
printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -q '^PENDING'; then
  if [ "$migrate" = 1 ]; then
    backup_and_migrate
  else
    die "pending migrations: review the list above and re-run with --migrate. The release is built at $release but NOT activated; nothing was changed"
  fi
fi

# ---- activate -----------------------------------------------------------------------------
if [ -L "$current" ]; then ln -sfn "$(readlink -f "$current")" "$previous"; fi
ln -sfn "$release" "$current"
restart_and_check

# ---- prune old releases (never current / previous) ------------------------------------------
keep=$(readlink -f "$current"); prev=$(readlink -f "$previous" 2>/dev/null || true)
ls -1dt "$releases"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  old=${old%/}
  [ "$old" = "$keep" ] || [ "$old" = "$prev" ] || { log "pruning $old"; rm -rf "$old"; }
done
log "deployed $sha -> $current"
