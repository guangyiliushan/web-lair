#!/usr/bin/env bash
#
# Nightly backup (deploy batch D-4, platform plan §C.6).
#
# Backup set:
#   1. pg_dump -Fc           (logical dump; never file-copy a running PG dir)
#   2. $DATA_DIR             (user job scripts + sidecars)
#   3. RustFS volume         (media, read-only mount)
#   4. .env + restic password (config; password also kept OFFLINE)
#
# The restic repo is the offsite target (R2/B2). There is deliberately no
# local repo on the same disk: that is a snapshot, not a backup.
#
# Env (usually exported by systemd from /srv/web-lair/app/.env):
#   RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#   DATA_DIR, DEADMAN_PING_URL (optional), RUSTFS_VOLUME (optional)
#
# Failures are loud: set -e aborts before the dead-man ping, so the missing
# ping raises the alarm.
set -euo pipefail

APP_DIR=${APP_DIR:-/srv/web-lair/app}
BACKUP_DIR=${BACKUP_DIR:-/srv/web-lair/backup}
RESTIC_IMAGE=${RESTIC_IMAGE:-restic/restic:0.19.1}

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set}"
: "${DATA_DIR:?DATA_DIR is not set}"

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

# 1) Logical dump (extension matches the compose service name).
docker compose exec -T db pg_dump -Fc -U "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" \
	> "$BACKUP_DIR/pg.dump"

# 3) RustFS volume name (compose prefixes it with the project name).
RUSTFS_VOLUME=${RUSTFS_VOLUME:-$(docker volume ls \
	--filter label=com.docker.compose.volume=rustfsdata \
	--format '{{.Name}}' | head -n1)}
: "${RUSTFS_VOLUME:?could not resolve the rustfs volume name}"

# 2 + 3 + 4) One restic run mounts the dump dir, the data dir, the media
# volume and the config file read-only.
docker run --rm \
	-e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
	-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
	-v "$BACKUP_DIR":/backup:ro \
	-v "$DATA_DIR":/data:ro \
	-v "$RUSTFS_VOLUME":/rustfs:ro \
	-v "$APP_DIR/.env":/config/.env:ro \
	"$RESTIC_IMAGE" backup /backup /data /rustfs /config

# Retention: keep-daily 7 / weekly 4 / monthly 6.
docker run --rm \
	-e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
	-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
	"$RESTIC_IMAGE" forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# Optional box-external dead-man ping on success.
if [ -n "${DEADMAN_PING_URL:-}" ]; then
	curl -fsS --max-time 10 "$DEADMAN_PING_URL" >/dev/null
fi

echo "[backup] ok $(date -Is)"
