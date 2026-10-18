#!/usr/bin/env bash
#
# Nightly backup (deploy batch D-4, platform plan §C.6).
#
# Backup set:
#   1. pg_dump -Fc           (logical dump; never file-copy a running PG dir)
#   2. $DATA_DIR             (user job scripts + sidecars)
#   3. RustFS volume         (media, read-only mount)
#   4. .env + backup env     (config; restic password also kept OFFLINE)
#
# The restic repo is the offsite target (R2/B2). There is deliberately no
# local repo on the same disk: that is a snapshot, not a backup.
#
# Env (systemd EnvironmentFile=/srv/web-lair/app/deploy/backup.env):
#   POSTGRES_USER, POSTGRES_DB, DATA_DIR
#   RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#   BACKUP_PING_URL (optional, dedicated check — never the liveness one)
#
# Failures are loud: set -e aborts before the backup ping, so a missing ping
# raises the alarm.
set -euo pipefail
umask 077

APP_DIR=${APP_DIR:-/srv/web-lair/app}
BACKUP_DIR=${BACKUP_DIR:-/srv/web-lair/backup}
RESTIC_IMAGE=${RESTIC_IMAGE:-restic/restic:0.19.1}

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set}"
: "${DATA_DIR:?DATA_DIR is not set}"

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

# 1) Logical dump to a temp file, validate, then swap: a failed dump must not
#    truncate yesterday's good staging copy.
docker compose exec -T db pg_dump -Fc -U "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" \
	> "$BACKUP_DIR/pg.dump.tmp"
docker compose exec -T db pg_restore -l < "$BACKUP_DIR/pg.dump.tmp" > /dev/null
mv "$BACKUP_DIR/pg.dump.tmp" "$BACKUP_DIR/pg.dump"

# 3) Resolve the media volume from the running service (project-scoped).
RUSTFS_CONTAINER=$(docker compose ps -q rustfs)
RUSTFS_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$RUSTFS_CONTAINER")
: "${RUSTFS_VOLUME:?could not resolve the rustfs volume from the rustfs container}"

if [ ! -f "$APP_DIR/.env" ]; then
	echo "[backup] $APP_DIR/.env is missing; refusing to snapshot a directory" >&2
	exit 1
fi

# 2 + 3 + 4) One restic run mounts the dump dir, the data dir, the media
# volume and the config file read-only. --retry-lock survives an interrupted
# previous run instead of failing every night until manual unlock.
# `--host` pins the snapshot host: without it every nightly container gets a
# fresh hostname and `forget --keep-daily` groups each run separately.
docker run --rm --env-file "$APP_DIR/deploy/backup.env" \
	-v "$BACKUP_DIR":/backup:ro \
	-v "$DATA_DIR":/data:ro \
	-v "$RUSTFS_VOLUME":/rustfs:ro \
	-v "$APP_DIR/.env":/config/.env:ro \
	"$RESTIC_IMAGE" --retry-lock 30m backup --host web-lair /backup /data /rustfs /config

# Retention: keep-daily 7 / weekly 4 / monthly 6. Group by paths (host is
# pinned above); prune only on Sunday so the nightly run does not hold the repo
# lock for a full data rewrite.
forget_args=(--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --group-by paths)
if [ "$(date +%u)" = "7" ]; then forget_args+=(--prune); fi
docker run --rm --env-file "$APP_DIR/deploy/backup.env" \
	"$RESTIC_IMAGE" --retry-lock 30m forget "${forget_args[@]}"

# Dedicated backup check (never the 5-minute liveness URL: sharing it would
# make a failed backup invisible on the next liveness tick).
if [ -n "${BACKUP_PING_URL:-}" ]; then
	curl -fsS --max-time 10 "$BACKUP_PING_URL" >/dev/null
fi

echo "[backup] ok $(date -Is)"
