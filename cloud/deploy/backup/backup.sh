#!/usr/bin/env bash
# Daily backup for Reify on compute (plan 8.5). Run as root on the WSL host, usually from cron at 03:00.
#
#   1. pg_dump of the platform database, gzip, into $BACKUP_MOUNT/reify-backup/pg/<date>.sql.gz
#   2. restic backup of the workspace volumes (/var/lib/reify/volumes) into the restic repository
#   3. retention: pg dumps keep 14 daily files plus Sunday files for 8 weeks; restic keeps 14 daily and 8 weekly snapshots
#
# Requirements:
#   - the D: drive is mounted at /mnt/d (the script refuses to write to the WSL disk otherwise)
#   - restic installed, and the password in $RESTIC_PASSWORD_FILE (mode 600, outside the repository)
#   - kubectl access through k3s (run as root, because the k3s kubeconfig is root-only)
set -euo pipefail

BACKUP_MOUNT="${REIFY_BACKUP_MOUNT:-/mnt/d}"
BACKUP_ROOT="${REIFY_BACKUP_ROOT:-$BACKUP_MOUNT/reify-backup}"
VOLUMES_DIR="${REIFY_VOLUMES_DIR:-/var/lib/reify/volumes}"
PG_DIR="$BACKUP_ROOT/pg"
RESTIC_REPO="${RESTIC_REPOSITORY:-$BACKUP_ROOT/restic}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/reify/restic-password}"
export RESTIC_REPOSITORY="$RESTIC_REPO" RESTIC_PASSWORD_FILE

KUBECTL=(k3s kubectl)
NS_SYSTEM=reify-system
PG_POD=postgres-0
DATE="$(date +%F)"
TMP_DUMP=""

log() { echo "[backup $(date '+%F %T')] $*"; }
die() { echo "[backup $(date '+%F %T')] ERROR: $*" >&2; exit 1; }
cleanup() { [ -n "$TMP_DUMP" ] && rm -f "$TMP_DUMP"; return 0; }
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || die "run as root"
mountpoint -q "$BACKUP_MOUNT" || die "$BACKUP_MOUNT is not mounted. Refusing to write backups to the WSL disk."
[ -r "$RESTIC_PASSWORD_FILE" ] || die "restic password file missing: $RESTIC_PASSWORD_FILE"
command -v restic >/dev/null 2>&1 || die "restic is not installed"

mkdir -p "$PG_DIR"

# 1. Database dump. The file is written under a temporary name and renamed only when complete.
log "pg_dump from $NS_SYSTEM/$PG_POD"
TMP_DUMP="$PG_DIR/.$DATE.sql.gz.tmp"
"${KUBECTL[@]}" -n "$NS_SYSTEM" exec "$PG_POD" -- \
  sh -c 'pg_dump --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip -9 >"$TMP_DUMP"
gzip -t "$TMP_DUMP"
size="$(stat -c %s "$TMP_DUMP")"
[ "$size" -gt 1024 ] || die "dump is only $size bytes; not keeping it"
mv -f "$TMP_DUMP" "$PG_DIR/$DATE.sql.gz"
TMP_DUMP=""
log "wrote $PG_DIR/$DATE.sql.gz ($size bytes before rename check)"

# Prune database dumps: keep files up to 14 days old, plus Sunday files up to 56 days old.
today_s="$(date +%s)"
for f in "$PG_DIR"/*.sql.gz; do
  [ -e "$f" ] || continue
  base="$(basename "$f" .sql.gz)"
  d_s="$(date -d "$base" +%s 2>/dev/null)" || continue
  age=$(( (today_s - d_s) / 86400 ))
  [ "$age" -le 14 ] && continue
  dow="$(date -d "$base" +%u)"   # 7 = Sunday
  if [ "$dow" = 7 ] && [ "$age" -le 56 ]; then
    continue
  fi
  log "removing old dump $(basename "$f")"
  rm -f -- "$f"
done

# 2. Workspace volumes with restic. The repository is created on first run.
if ! restic snapshots >/dev/null 2>&1; then
  log "initializing restic repository at $RESTIC_REPO"
  restic init
fi
log "restic backup of $VOLUMES_DIR"
restic backup --tag daily --host reify-compute "$VOLUMES_DIR"

# 3. Restic retention. Prune also removes unreferenced data.
restic forget --keep-daily 14 --keep-weekly 8 --prune
log "done"
