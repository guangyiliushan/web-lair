#!/usr/bin/env bash
# Backup entry point: data and config repositories stay separate; the nightly
# schedule lives in Backrest (RUNBOOK, "Backups (D-4)").
# `backup.sh` = dump → data repo → config repo → retention → backup ping (the
# manual/fallback path); `--dump-only` = dump and gates only, what Backrest's
# CONDITION_SNAPSHOT_START hook runs before snapshotting $BACKUP_DIR (a dump
# failing a gate cancels the operation).
# Backup set (data repository): 1. pg_dump -Fc (never file-copy a running PG
# dir), 2. $DATA_DIR, 3. RustFS volume. Step 4 `.env` is NOT in that set: it
# goes to a SECOND repository with a DIFFERENT password (it holds
# BETTER_AUTH_SECRET, SUPPRESSION_HMAC_KEY and the DB password — a leaked data
# repository must not decrypt the app secrets; pinned by
# `secrets/backup-split.test.ts › "backup repository split"`).
# `deploy/backup.env` holds both repository passwords and is backed up nowhere
# (password manager + offline copy); both repositories are offsite. Env vars:
# see `deploy/backup.env.example`.
# DB access (BACKUP_PG_MODE): `docker` (default) runs the client through
# `compose-prod.sh exec -T db`; `local` runs inside the backrest container,
# which deliberately has no Docker socket (a container that can drive Docker
# can delete the backups it protects).
# Failures are loud: `set -e` aborts before the backup ping, so a missing ping
# raises the alarm.
set -euo pipefail
umask 077

# Resolve through symlinks: a /usr/local/bin/backup.sh -> checkout link, or a
# call via PATH, otherwise makes dirname point somewhere count-user-rows.sh is
# not (readlink -f is GNU/busybox; realpath is the fallback).
_self=${BASH_SOURCE[0]}
if command -v readlink >/dev/null 2>&1 && readlink -f -- "$_self" >/dev/null 2>&1; then
	_self=$(readlink -f -- "$_self")
elif command -v realpath >/dev/null 2>&1; then
	_self=$(realpath -- "$_self")
fi
SCRIPT_DIR=$(cd -- "$(dirname -- "$_self")" && pwd)
APP_DIR=${APP_DIR:-/srv/web-lair/app}
BACKUP_DIR=${BACKUP_DIR:-/srv/web-lair/backup}
DC="${APP_DIR}/deploy/compose-prod.sh"
RESTIC_IMAGE=${RESTIC_IMAGE:-restic/restic:0.19.1}
PG_MODE=${BACKUP_PG_MODE:-docker}

mode=full
while [ $# -gt 0 ]; do
	case "$1" in
		--dump-only) mode=dump-only ;;
		*)
			echo "[backup] unknown argument: $1 (usage: backup.sh [--dump-only])" >&2
			exit 2
			;;
	esac
	shift
done

# --- DB access --------------------------------------------------------------

require_pg_env() {
	: "${POSTGRES_USER:?POSTGRES_USER is not set}"
	: "${POSTGRES_DB:?POSTGRES_DB is not set}"
	case "$PG_MODE" in
		docker)
			[ -d "$APP_DIR" ] || {
				echo "[backup] APP_DIR=$APP_DIR does not exist (BACKUP_PG_MODE=docker)" >&2
				exit 1
			}
			[ -x "$DC" ] || {
				echo "[backup] $DC is missing or not executable (BACKUP_PG_MODE=docker)" >&2
				exit 1
			}
			# The backrest container has no docker CLI and no socket: hitting that
			# through `compose-prod.sh exec docker …` says only "command not found".
			command -v docker >/dev/null 2>&1 || {
				echo "[backup] BACKUP_PG_MODE=docker needs the docker CLI; inside the backrest container use BACKUP_PG_MODE=local" >&2
				exit 1
			}
			;;
		local)
			# Only this mode needs the password: in docker mode the client runs in
			# the db container and authenticates over the container network.
			: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required when BACKUP_PG_MODE=local (RUNBOOK §4)}"
			export PGPASSWORD="$POSTGRES_PASSWORD"
			export PGHOST="${PGHOST:-db}" PGPORT="${PGPORT:-5432}"
			;;
		*)
			echo "[backup] BACKUP_PG_MODE must be docker or local, got '$PG_MODE'" >&2
			exit 2
			;;
	esac
}

# The helpers below read and write the same streams as the original compose
# calls, so the gates stay byte-for-byte the ones that ran before Backrest
# took over the schedule.
pg_dump_db() { # → archive on stdout
	if [ "$PG_MODE" = local ]; then
		pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"
	else
		( cd "$APP_DIR" && "${DC}" exec -T db pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" )
	fi
}

pg_restore_toc() { # archive on stdin → TOC validation only
	if [ "$PG_MODE" = local ]; then
		pg_restore -l > /dev/null
	else
		( cd "$APP_DIR" && "${DC}" exec -T db pg_restore -l ) > /dev/null
	fi
}

pg_restore_data() { # archive on stdin → SQL on stdout
	if [ "$PG_MODE" = local ]; then
		pg_restore -a -f -
	else
		( cd "$APP_DIR" && "${DC}" exec -T db pg_restore -a -f - 2>/dev/null )
	fi
}

pg_user_count() { # live count of public."user"
	if [ "$PG_MODE" = local ]; then
		psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'select count(*) from "user"'
	else
		( cd "$APP_DIR" &&
			"${DC}" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'select count(*) from "user"' )
	fi
}

# 1) Logical dump to a temp file, validate, then swap: a failed dump must not
#    truncate yesterday's good staging copy.
dump_pg() {
	require_pg_env
	mkdir -p "$BACKUP_DIR"
	# Not `local`: the EXIT trap runs after this function returns, so the names
	# must still be in scope there (a local would expand to empty and leave the
	# half dump and the lock behind).
	DUMP_LOCK="$BACKUP_DIR/.pg-dump.lock"
	DUMP_TMP=""
	# Two producers exist — Backrest's hook and this script run by hand — and both
	# would otherwise write the same pg.dump.tmp. The second writer truncates the
	# file the first one is validating, and the first then renames that half file
	# into place as pg.dump (which is the file the restore drill trusts).
	# mkdir is the lock: portable, no util-linux dependency, and a stale one ages
	# out instead of blocking the nightly run forever.
	if ! mkdir "$DUMP_LOCK" 2>/dev/null; then
		if [ -n "$(find "$DUMP_LOCK" -maxdepth 0 -mmin +"${BACKUP_LOCK_STALE_MIN:-360}" 2>/dev/null)" ]; then
			echo "[backup] removing stale dump lock $DUMP_LOCK" >&2
			rm -rf "$DUMP_LOCK"
		fi
		mkdir "$DUMP_LOCK" 2>/dev/null || {
			echo "[backup] another backup is already writing $BACKUP_DIR; refusing to interleave" >&2
			exit 1
		}
	fi
	DUMP_TMP=$(mktemp "$BACKUP_DIR/.pg.dump.XXXXXX")
	# A failed gate must not leave a half dump behind for the next snapshot, and
	# must not keep the lock.
	trap 'rm -f "$DUMP_TMP"; rmdir "$DUMP_LOCK" 2>/dev/null || true' EXIT
	echo "[backup] pg_dump ${POSTGRES_DB} (${PG_MODE} client) → $DUMP_TMP"
	pg_dump_db > "$DUMP_TMP"
	pg_restore_toc < "$DUMP_TMP"
	# TOC presence is not data. Compare the user-row count in the archive with
	# the live table so an empty/partial dump never replaces yesterday's good
	# copy. The counter lives in count-user-rows.sh: it must drain stdin (an
	# early exit SIGPIPEs pg_restore and, under pipefail, kills the whole run).
	EXPECTED_USERS=$(pg_user_count)
	DUMP_USERS=$(pg_restore_data < "$DUMP_TMP" | bash "${SCRIPT_DIR}/count-user-rows.sh")
	[ "$DUMP_USERS" = "$EXPECTED_USERS" ] || {
		echo "[backup] dump has $DUMP_USERS user rows, expected $EXPECTED_USERS; refusing to replace pg.dump" >&2
		exit 1
	}
	mv "$DUMP_TMP" "$BACKUP_DIR/pg.dump"
	DUMP_TMP=""
	rmdir "$DUMP_LOCK" 2>/dev/null || true
	trap - EXIT
	# The receipt line the Backrest hook log keeps: without it, a nightly run
	# that produced a truncated-but-parseable dump looks exactly like a good one.
	echo "[backup] dump ok: $(wc -c < "$BACKUP_DIR/pg.dump") bytes, ${DUMP_USERS} user rows"
}

if [ "$mode" = full ]; then
	# Fail before the dump when the restic side is obviously unconfigured: a
	# half-run leaves a fresh dump but no snapshot, which reads as success.
	: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
	: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set}"
	: "${RESTIC_CONFIG_REPOSITORY:?RESTIC_CONFIG_REPOSITORY is not set}"
	: "${RESTIC_CONFIG_PASSWORD:?RESTIC_CONFIG_PASSWORD is not set}"
	: "${DATA_DIR:?DATA_DIR is not set}"
fi

dump_pg

if [ "$mode" = dump-only ]; then
	echo "[backup] --dump-only: ${BACKUP_DIR}/pg.dump is ready; restic is Backrest's job"
	exit 0
fi

# 3) Resolve the media volume from the running service (project-scoped).
RUSTFS_CONTAINER=$("${DC}" ps -q rustfs)
RUSTFS_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$RUSTFS_CONTAINER")
: "${RUSTFS_VOLUME:?could not resolve the rustfs volume from the rustfs container}"

if [ ! -f "$APP_DIR/.env" ]; then
	echo "[backup] $APP_DIR/.env is missing; the config backup would be empty" >&2
	exit 1
fi

# Data run: the dump dir, the data dir and the media volume are mounted
# read-only; `.env` is not mounted (it belongs to the config repository below,
# pinned by `src/lib/server/secrets/backup-split.test.ts › "backup repository
# split"`). `--retry-lock` survives an interrupted run instead of failing every
# night until a manual unlock. `--host web-lair` is only the snapshot label the
# drill resolves; grouping the nightly runs is `--group-by paths` (see the
# retention block below).
# `docker --env-file` does not strip quotes from `VAR="value"` (systemd does), so
# `-e VAR` (no value) forwards the value this script validated, while extra
# cloud/restic variables still come from the file. The repository is a CLI flag,
# not an env var: nothing in the env file can shadow it, so the config run below
# can never land in the data repository — a silent failure that would look like
# a green night.
RESTIC_ENV=(-e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY)

docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
	-v "$BACKUP_DIR":/backup:ro \
	-v "$DATA_DIR":/data:ro \
	-v "$RUSTFS_VOLUME":/rustfs:ro \
	"$RESTIC_IMAGE" --repo "$RESTIC_REPOSITORY" --retry-lock 30m \
	backup --host web-lair /backup /data /rustfs

# 4) Config (.env) → its own repository, its own password. One file, no
# directory. Isolation comes from the separate repository (and the flag above);
# `--host web-lair-config` is just the label the drill looks up. The subshell
# re-exports only the password so the data run's credential is untouched.
(
	export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"
	docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
		-v "$APP_DIR/.env":/config/.env:ro \
		"$RESTIC_IMAGE" --repo "$RESTIC_CONFIG_REPOSITORY" --retry-lock 30m \
		backup --host web-lair-config /config
)

# Retention: keep-daily 7 / weekly 4 / monthly 6. `--group-by paths` puts every
# nightly run in one forget group (host is deliberately not part of the key);
# prune only on Sunday so the nightly run does not hold the repo lock for a full
# data rewrite. The config repository keeps a month of dailies plus a year of
# monthlies — it is a few KB per snapshot.
forget_args=(--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --group-by paths)
config_forget_args=(--keep-daily 30 --keep-monthly 12 --group-by paths)
if [ "$(date +%u)" = "7" ]; then
	forget_args+=(--prune)
	config_forget_args+=(--prune)
fi
docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
	"$RESTIC_IMAGE" --repo "$RESTIC_REPOSITORY" --retry-lock 30m forget "${forget_args[@]}"
(
	export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"
	docker run --rm --env-file "$APP_DIR/deploy/backup.env" "${RESTIC_ENV[@]}" \
		"$RESTIC_IMAGE" --repo "$RESTIC_CONFIG_REPOSITORY" --retry-lock 30m forget "${config_forget_args[@]}"
)

# Dedicated backup check (never the 5-minute liveness URL: sharing it would
# make a failed backup invisible on the next liveness tick).
if [ -n "${BACKUP_PING_URL:-}" ]; then
	curl -fsS --max-time 10 "$BACKUP_PING_URL" >/dev/null
fi

echo "[backup] ok $(date -Is)"
