#!/usr/bin/env bash
#
# Nightly backup (deploy batch D-4, platform plan §C.6; split per T3-A).
#
# Backup set (data repository):
#   1. pg_dump -Fc           (logical dump; never file-copy a running PG dir)
#   2. $DATA_DIR             (user job scripts + sidecars)
#   3. RustFS volume         (media, read-only mount)
#
# `.env` is deliberately NOT in that set. It goes to a SECOND repository with a
# DIFFERENT password, because it holds BETTER_AUTH_SECRET, SUPPRESSION_HMAC_KEY
# and the DB password: a leaked data repository plus its password must not
# decrypt the application secrets (T3-A, secrets register §0.1).
# deploy/backup.env is backed up nowhere — it holds both repository passwords,
# which live in the password manager with an offline copy (RUNBOOK §4).
#
# Both repositories are offsite targets (R2/B2). There is deliberately no
# local repository on the same disk: that is a snapshot, not a backup.
#
# Env (systemd EnvironmentFile=/srv/web-lair/app/deploy/backup.env):
#   POSTGRES_USER, POSTGRES_DB, DATA_DIR
#   RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#   RESTIC_CONFIG_REPOSITORY, RESTIC_CONFIG_PASSWORD   (second repo, own key)
#   BACKUP_PING_URL (optional, dedicated check — never the liveness one)
#
# Failures are loud: set -e aborts before the backup ping, so a missing ping
# raises the alarm.
set -euo pipefail
umask 077

APP_DIR=${APP_DIR:-/srv/web-lair/app}
BACKUP_DIR=${BACKUP_DIR:-/srv/web-lair/backup}
DC="${APP_DIR}/deploy/compose-prod.sh"
RESTIC_IMAGE=${RESTIC_IMAGE:-restic/restic:0.19.1}

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set}"
: "${RESTIC_CONFIG_REPOSITORY:?RESTIC_CONFIG_REPOSITORY is not set}"
: "${RESTIC_CONFIG_PASSWORD:?RESTIC_CONFIG_PASSWORD is not set}"
: "${DATA_DIR:?DATA_DIR is not set}"

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

# 1) Logical dump to a temp file, validate, then swap: a failed dump must not
#    truncate yesterday's good staging copy.
"${DC}" exec -T db pg_dump -Fc -U "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" \
	> "$BACKUP_DIR/pg.dump.tmp"
"${DC}" exec -T db pg_restore -l < "$BACKUP_DIR/pg.dump.tmp" > /dev/null
# TOC presence is not data. Compare the user-row count in the archive with the
# live table so an empty/partial dump never replaces yesterday's good copy.
EXPECTED_USERS=$("${DC}" exec -T db psql -U "${POSTGRES_USER:?}" -d "${POSTGRES_DB:?}" -tAc 'select count(*) from "user"')
DUMP_USERS=$("${DC}" exec -T db pg_restore -a -f - < "$BACKUP_DIR/pg.dump.tmp" 2>/dev/null | \
	awk '/^COPY public\."user" /{f=1;next} f&&/^\\\.$/{exit} f{n++} END{print n+0}')
[ "$DUMP_USERS" = "$EXPECTED_USERS" ] || {
	echo "[backup] dump has $DUMP_USERS user rows, expected $EXPECTED_USERS; refusing to replace pg.dump" >&2
	exit 1
}
mv "$BACKUP_DIR/pg.dump.tmp" "$BACKUP_DIR/pg.dump"

# 3) Resolve the media volume from the running service (project-scoped).
RUSTFS_CONTAINER=$("${DC}" ps -q rustfs)
RUSTFS_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$RUSTFS_CONTAINER")
: "${RUSTFS_VOLUME:?could not resolve the rustfs volume from the rustfs container}"

if [ ! -f "$APP_DIR/.env" ]; then
	echo "[backup] $APP_DIR/.env is missing; the config backup would be empty" >&2
	exit 1
fi

# 2 + 3) One restic run mounts the dump dir, the data dir and the media volume
# read-only. `.env` is not mounted: config is the second repository below.
# --retry-lock survives an interrupted previous run instead of failing every
# night until manual unlock. `--host` pins the snapshot host: without it every
# nightly container gets a fresh hostname and `forget --keep-daily` groups each
# run separately.
#
# `docker --env-file` does not strip the quotes in `VAR="value"` (systemd does,
# for this script's own environment), so a quoted backup.env would hand restic
# a literal `"/repos"`. `-e VAR` (no value) forwards the value the script
# validated instead; extra cloud/restic variables still come from the file.
RESTIC_ENV=(-e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY)

docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
	-v "$BACKUP_DIR":/backup:ro \
	-v "$DATA_DIR":/data:ro \
	-v "$RUSTFS_VOLUME":/rustfs:ro \
	"$RESTIC_IMAGE" --retry-lock 30m backup --host web-lair /backup /data /rustfs

# 4) Config (.env) → its own repository, its own password. One file, no
# directory: `--host` keeps it out of the data repo's forget groups. The
# subshell re-exports the config credentials so the same `-e VAR` forwarding
# above sends them, without leaking into the data runs.
(
	export RESTIC_REPOSITORY="$RESTIC_CONFIG_REPOSITORY"
	export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"
	docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
		-v "$APP_DIR/.env":/config/.env:ro \
		"$RESTIC_IMAGE" --retry-lock 30m backup --host web-lair-config /config
)

# Retention: keep-daily 7 / weekly 4 / monthly 6. Group by paths (host is
# pinned above); prune only on Sunday so the nightly run does not hold the repo
# lock for a full data rewrite. The config repository keeps a month of dailies
# plus a year of monthlies — it is a few KB per snapshot.
forget_args=(--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --group-by paths)
config_forget_args=(--keep-daily 30 --keep-monthly 12 --group-by paths)
if [ "$(date +%u)" = "7" ]; then
	forget_args+=(--prune)
	config_forget_args+=(--prune)
fi
docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
	"$RESTIC_IMAGE" --retry-lock 30m forget "${forget_args[@]}"
(
	export RESTIC_REPOSITORY="$RESTIC_CONFIG_REPOSITORY"
	export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"
	docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
		"$RESTIC_IMAGE" --retry-lock 30m forget "${config_forget_args[@]}"
)

# Dedicated backup check (never the 5-minute liveness URL: sharing it would
# make a failed backup invisible on the next liveness tick).
if [ -n "${BACKUP_PING_URL:-}" ]; then
	curl -fsS --max-time 10 "$BACKUP_PING_URL" >/dev/null
fi

echo "[backup] ok $(date -Is)"
