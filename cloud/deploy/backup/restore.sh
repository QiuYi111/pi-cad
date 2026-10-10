#!/usr/bin/env bash
# Restore one user's workspace volume and database rows (plan 8.5, acceptance V12).
#
# DEFAULT IS A DRY RUN. Nothing on the live system changes unless you pass --apply.
#
# Usage:
#   restore.sh --user-id <uuid> [--pg-dump <file.sql.gz>] [--snapshot <restic-id|latest>] [--apply]
#
#   --user-id    users.id of the user to restore (UUID)
#   --pg-dump    database dump to read (default: newest file in the pg backup folder)
#   --snapshot   restic snapshot id for the volume (default: latest)
#   --apply      perform the restore. Without it, the script only reports what it would do.
#
# What --apply does, in order (stop at the first error):
#   1. Refuses if the user's rows still exist in the live database.
#      Delete them first (see the manual steps in cloud/deploy/README.md).
#   2. Refuses if the PVC ws-<id>-data still exists. Delete it first, on purpose.
#   3. Creates the PVC, binds it with a short helper pod, and restores the files from restic
#      into the local-path directory for that PVC.
#   4. Copies the user's rows from the dump into the live database.
#      The workspace row is set to stopped, so the controller does not start it on its own.
#
# A dry run loads the dump into a scratch database (reify_restore_<time>) and drops it at the end.
# It does not change the live database or the volume.
#
# Environment (same as backup.sh):
#   REIFY_BACKUP_MOUNT, REIFY_BACKUP_ROOT, REIFY_VOLUMES_DIR, RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE
#   REIFY_WORKSPACE_IMAGE   image used by the helper pod (any image with sleep)
set -euo pipefail

BACKUP_MOUNT="${REIFY_BACKUP_MOUNT:-/mnt/d}"
BACKUP_ROOT="${REIFY_BACKUP_ROOT:-$BACKUP_MOUNT/reify-backup}"
VOLUMES_DIR="${REIFY_VOLUMES_DIR:-/var/lib/reify/volumes}"
RESTIC_REPO="${RESTIC_REPOSITORY:-$BACKUP_ROOT/restic}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/reify/restic-password}"
export RESTIC_REPOSITORY="$RESTIC_REPO" RESTIC_PASSWORD_FILE
WS_IMAGE="${REIFY_WORKSPACE_IMAGE:-}"

KUBECTL=(k3s kubectl)
NS_SYSTEM=reify-system
NS_WS=reify-ws
PG_POD=postgres-0
PG_DIR="$BACKUP_ROOT/pg"

USER_ID=""
PG_DUMP=""
SNAPSHOT="latest"
APPLY=0
TS="$(date +%Y%m%d%H%M%S)"
SCRATCH_DB="reify_restore_$TS"
WS_NAME=""
PVC_NAME=""
HELPER_POD=""
SCRATCH_CREATED=0

log() { echo "[restore] $*"; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

usage() { sed -n '2,25p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user-id) USER_ID="${2:?}"; shift 2 ;;
    --pg-dump) PG_DUMP="${2:?}"; shift 2 ;;
    --snapshot) SNAPSHOT="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
[[ "$USER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || die "--user-id must be a UUID"
mountpoint -q "$BACKUP_MOUNT" || die "$BACKUP_MOUNT is not mounted"

if [ -z "$PG_DUMP" ]; then
  PG_DUMP="$(ls -1t "$PG_DIR"/*.sql.gz 2>/dev/null | head -1 || true)"
fi
[ -n "$PG_DUMP" ] && [ -r "$PG_DUMP" ] || die "no readable database dump (use --pg-dump)"
gzip -t "$PG_DUMP"
log "mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"
log "database dump: $PG_DUMP"

pg() { "${KUBECTL[@]}" -n "$NS_SYSTEM" exec -i "$PG_POD" -- psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER_NAME" "$@"; }
POSTGRES_USER_NAME="$("${KUBECTL[@]}" -n "$NS_SYSTEM" exec "$PG_POD" -- sh -c 'printf %s "$POSTGRES_USER"')"
[ -n "$POSTGRES_USER_NAME" ] || die "cannot read POSTGRES_USER from $PG_POD"

cleanup() {
  if [ "$SCRATCH_CREATED" = 1 ]; then
    pg -d postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null 2>&1 || true
  fi
  if [ -n "$HELPER_POD" ]; then
    "${KUBECTL[@]}" -n "$NS_WS" delete pod "$HELPER_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 1. Load the dump into a scratch database. This never touches the live database.
log "loading dump into scratch database $SCRATCH_DB"
pg -d postgres -c "CREATE DATABASE \"$SCRATCH_DB\";" >/dev/null
SCRATCH_CREATED=1
gunzip -c "$PG_DUMP" | pg -d "$SCRATCH_DB" >/dev/null

scratch_q() { pg -d "$SCRATCH_DB" -tA -c "$1"; }
live_q() { pg -d reify -tA -c "$1"; }

# 2. Find the user's workspace in the dump.
WS_NAME="$(scratch_q "select k8s_name from workspaces where user_id = '$USER_ID';" || true)"
[ -n "$WS_NAME" ] || die "user $USER_ID has no workspace row in the dump"
PVC_NAME="${WS_NAME}-data"
log "user $USER_ID -> workspace $WS_NAME, PVC $PVC_NAME"

# Table list in foreign-key order, with the filter that selects this user's rows.
TABLES=(
  "users|id = '$USER_ID'"
  "password_credentials|user_id = '$USER_ID'"
  "external_identities|user_id = '$USER_ID'"
  "teams|personal_owner = '$USER_ID'"
  "team_members|user_id = '$USER_ID'"
  "projects|team_id in (select id from teams where personal_owner = '$USER_ID')"
  "project_members|user_id = '$USER_ID'"
  "workspaces|user_id = '$USER_ID'"
  "sessions|project_id in (select id from projects where team_id in (select id from teams where personal_owner = '$USER_ID'))"
  "refresh_tokens|user_id = '$USER_ID'"
  "password_resets|user_id = '$USER_ID'"
  "events|user_id = '$USER_ID'"
)

log "rows in the dump:"
for entry in "${TABLES[@]}"; do
  table="${entry%%|*}"; filter="${entry#*|}"
  n="$(scratch_q "select count(*) from $table where $filter;")"
  log "  $table: $n"
done

# 3. Dry run stops here.
if [ "$APPLY" != 1 ]; then
  log "live database: user rows present = $(live_q "select count(*) from users where id = '$USER_ID';")"
  log "live PVC: $("${KUBECTL[@]}" -n "$NS_WS" get pvc "$PVC_NAME" -o name 2>/dev/null || echo 'absent')"
  log "restic snapshots that contain this volume:"
  restic snapshots --json --path "$VOLUMES_DIR" 2>/dev/null \
    | grep -o '"short_id":"[^"]*"' | head -5 || true
  log "dry run only. Add --apply to restore. See cloud/deploy/README.md section 'Restore'."
  exit 0
fi

# 4. Apply. Safety checks first.
live_users="$(live_q "select count(*) from users where id = '$USER_ID';")"
[ "$live_users" = 0 ] || die "live database still has this user. Delete the user's rows first (README, restore section)."
if "${KUBECTL[@]}" -n "$NS_WS" get pvc "$PVC_NAME" >/dev/null 2>&1; then
  die "PVC $PVC_NAME still exists. Delete it first (README, restore section). This script does not delete data."
fi
if "${KUBECTL[@]}" -n "$NS_WS" get deployment "$WS_NAME" >/dev/null 2>&1; then
  die "deployment $WS_NAME still exists. Scale it to zero and delete it first."
fi
[ -n "$WS_IMAGE" ] || die "set REIFY_WORKSPACE_IMAGE for the helper pod"

# 4a. Create the PVC. local-path binds only when a pod uses it, so a helper pod binds it.
log "creating PVC $PVC_NAME"
"${KUBECTL[@]}" apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${PVC_NAME}
  namespace: ${NS_WS}
  labels:
    reify.dev/role: workspace
    reify.dev/workspace: ${WS_NAME}
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 50Gi
EOF

HELPER_POD="restore-bind-$TS"
log "binding PVC with helper pod $HELPER_POD"
"${KUBECTL[@]}" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${HELPER_POD}
  namespace: ${NS_WS}
  labels:
    reify.dev/verify: "restore-helper"
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: bind
      image: ${WS_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["sleep", "120"]
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: ${PVC_NAME}
EOF
"${KUBECTL[@]}" -n "$NS_WS" wait --for=condition=Ready "pod/$HELPER_POD" --timeout=300s >/dev/null
"${KUBECTL[@]}" -n "$NS_WS" delete pod "$HELPER_POD" --wait=true >/dev/null
HELPER_POD=""

# 4b. Read the bound PV's path; local-path directory naming varies by version.
pv_name="$("${KUBECTL[@]}" -n "$NS_WS" get pvc "$PVC_NAME" -o jsonpath='{.spec.volumeName}')"
live_dir="$("${KUBECTL[@]}" get pv "$pv_name" -o jsonpath='{.spec.hostPath.path}{.spec.local.path}')"
case "$live_dir" in
  "$VOLUMES_DIR"/*) ;;
  *) die "PVC path is outside $VOLUMES_DIR: $live_dir" ;;
esac
[ -n "$live_dir" ] && [ -d "$live_dir" ] || die "cannot find the local-path directory for $PVC_NAME under $VOLUMES_DIR"
stage="$(mktemp -d "/var/tmp/reify-restore-$TS.XXXX")"
log "restic restore of volume files into $stage"
restic restore "$SNAPSHOT" --verify --target "$stage" \
  --include "${VOLUMES_DIR}/pvc-*_${NS_WS}_${PVC_NAME}" \
  --include "${VOLUMES_DIR}/${NS_WS}_${PVC_NAME}_*"
mapfile -t source_dirs < <(find "$stage$VOLUMES_DIR" -mindepth 1 -maxdepth 1 -type d \
  \( -name "pvc-*_${NS_WS}_${PVC_NAME}" -o -name "${NS_WS}_${PVC_NAME}_*" \))
[ "${#source_dirs[@]}" -eq 1 ] || die "snapshot must contain exactly one volume for $PVC_NAME"
src_dir="${source_dirs[0]}"
[ -n "$src_dir" ] && [ -d "$src_dir" ] || die "snapshot does not contain $PVC_NAME"
cp -a "$src_dir/." "$live_dir/"
rm -rf "$stage"
log "files restored into $live_dir"

# 4c. Database rows, in foreign-key order. Each table is streamed from the scratch database.
log "copying database rows"
for entry in "${TABLES[@]}"; do
  table="${entry%%|*}"; filter="${entry#*|}"
  pg -d "$SCRATCH_DB" -c "\\copy (select * from $table where $filter) to stdout csv" \
    | pg -d reify -c "\\copy $table from stdin csv"
  log "  $table copied"
done
live_q "update workspaces set state = 'stopped', desired = 'stopped' where user_id = '$USER_ID';" >/dev/null

log "restore finished. Start the workspace from the desktop app and check the project and sessions."
