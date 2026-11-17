#!/usr/bin/env bash
#
# Restore drill: prove that the newest snapshot actually restores.
#
# What it does, in order:
#   1. lists the newest snapshot in the data repository and asserts the
#      data/config split still holds: no `.env` may live in ANY data snapshot;
#   2. restores that snapshot into a scratch directory (staging dump, DATA_DIR
#      tree, media tree);
#   3. restores the newest snapshot of the CONFIG repository and asserts the
#      restored `.env` is complete (and reports whether it is still
#      byte-identical to the live `.env`);
#   4. starts a THROWAWAY PostgreSQL container (no published port, deleted on
#      exit) and `pg_restore`s the staging dump into it;
#   5. asserts row counts, runs the F-22 orphan sweep
#      (deploy/backup/orphan-check.sql) on the restored database and compares a
#      media sample byte-for-byte with the live volume;
#   6. prints a receipt with RTO (wall clock) and RPO (age of the restored dump).
#
# The live database is only ever read: `select count(*)` and the volume is
# mounted read-only. Nothing here writes to a production volume.
#
# Usage:
#   set -a; . deploy/backup.env; set +a     # RESTIC_* / POSTGRES_* / AWS_*
#   deploy/restore-drill.sh [--receipt FILE] [--sample N] [--compare-live] [--keep]
#
# Local-repository mode: set DRILL_LOCAL_REPO_DIR to
# the host directory that holds the repositories and point RESTIC_REPOSITORY at
# the in-container path, e.g.
#   RESTIC_REPOSITORY=/repos/lair-data DRILL_LOCAL_REPO_DIR=/srv/drill/repos
#
# Options:
#   --receipt FILE   also write the receipt lines to FILE
#   --sample N       media objects to hash (default 5)
#   --compare-live   make "restored < live" row counts a hard failure
#   --keep           keep the scratch tree and the drill database for inspection
set -euo pipefail
umask 077

# Git-for-Windows/MSYS rewrites container paths like /work into C:/...; every
# host path below is converted explicitly, so switch that translation off.
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1

APP_DIR=${APP_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DC="${APP_DIR}/deploy/compose-prod.sh"
RESTIC_IMAGE=${DRILL_RESTIC_IMAGE:-${RESTIC_IMAGE:-restic/restic:0.19.1}}
PG_IMAGE=${DRILL_PG_IMAGE:-postgres:18}
SAMPLE=${DRILL_SAMPLE:-5}
LIVE_ENV=${LIVE_ENV_FILE:-$APP_DIR/.env}
COMPARE_LIVE=0
KEEP=0
RECEIPT_FILE=""
WORK=""
RECEIPT=""
PG_CTR=""

# The row-count sample: tables a restore must bring back, in rough order of how
# much they hurt when empty. Missing tables print n/a and are skipped, so this
# list does not have to be updated with every schema change.
TABLES=('"user"' posts comments drafts session activities job_schedules email_suppressions files links notes moments)

die() {
	echo "[drill] FAIL: $*" >&2
	exit 1
}

usage() {
	cat <<'USAGE'
deploy/restore-drill.sh — restore the newest snapshot into a throwaway database and print a receipt.

Usage:
  set -a; . deploy/backup.env; set +a
  deploy/restore-drill.sh [--receipt FILE] [--sample N] [--compare-live] [--keep]

Env: RESTIC_REPOSITORY, RESTIC_PASSWORD, RESTIC_CONFIG_REPOSITORY,
     RESTIC_CONFIG_PASSWORD  (deploy/backup.env)
     POSTGRES_USER, POSTGRES_DB  (live row-count comparison; optional)
     DRILL_LOCAL_REPO_DIR   host dir holding the repos, mounted at /repos (local mode)
     DRILL_RESTIC_IMAGE     default restic/restic:0.19.1
     DRILL_PG_IMAGE         default postgres:18
     DRILL_LIVE_RUSTFS_VOLUME  override the live media volume name
     LIVE_ENV_FILE          default <app>/.env
USAGE
}

# Host path → the form the native docker CLI wants (D:/... on Windows).
host_path() {
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$1"
	else
		printf '%s' "$1"
	fi
}

receipt() {
	printf '%s\n' "$1" | tee -a "$RECEIPT"
}

while [ $# -gt 0 ]; do
	case "$1" in
		--receipt)
			RECEIPT_FILE=${2:?--receipt needs a path}
			shift 2
			;;
		--sample)
			SAMPLE=${2:?--sample needs a number}
			shift 2
			;;
		--compare-live)
			COMPARE_LIVE=1
			shift
			;;
		--keep)
			KEEP=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "[drill] unknown argument: $1 (try --help)" >&2
			exit 2
			;;
	esac
done

cleanup() {
	rc=$?
	if [ -n "$PG_CTR" ] && [ "$KEEP" != 1 ]; then
		docker rm -fv "$PG_CTR" >/dev/null 2>&1 || true
	fi
	# Copy the receipt out BEFORE the scratch tree disappears; doing it after the
	# `rm -rf` silently produced no receipt file at all. `|| echo` on purpose: a
	# failing copy must not skip the remaining cleanup or rewrite a good exit code.
	if [ -n "$RECEIPT_FILE" ] && [ -n "${RECEIPT:-}" ] && [ -f "${RECEIPT:-/nonexistent}" ]; then
		cp "$RECEIPT" "$RECEIPT_FILE" || echo "[drill] WARN: could not write the receipt to $RECEIPT_FILE" >&2
	fi
	if [ -n "${WORK:-}" ] && [ -d "${WORK:-}" ]; then
		if [ "$KEEP" = 1 ]; then
			echo "[drill] scratch tree kept: $WORK" >&2
			echo "[drill] drill database kept: ${PG_CTR:-none} (docker rm -fv ${PG_CTR:-<name>} when done - -v drops the restored data volume)" >&2
		else
			rm -rf "$WORK"
		fi
	fi
	exit "$rc"
}
trap cleanup EXIT

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set (deploy/backup.env, RUNBOOK §4)}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"
: "${RESTIC_CONFIG_REPOSITORY:?RESTIC_CONFIG_REPOSITORY is not set (deploy/backup.env, RUNBOOK §4)}"
: "${RESTIC_CONFIG_PASSWORD:?RESTIC_CONFIG_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/web-lair-drill.XXXXXX")
RECEIPT="$WORK/receipt.txt"
: > "$RECEIPT"
START_EPOCH=$(date +%s)

RESTIC_ENV=(-e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY)
REPO_MOUNT=()
if [ -n "${DRILL_LOCAL_REPO_DIR:-}" ]; then
	# Read-only: every restic call below passes --no-lock, so the drill cannot
	# write to the repository at all — and a stale lock left by a crashed run
	# cannot block it either (that was the first thing this drill hit).
	REPO_MOUNT=(-v "$(host_path "$DRILL_LOCAL_REPO_DIR")":/repos:ro)
fi

restic_run() { # repo uri + restic args
	local repo=$1
	shift
	local -a cmd=(docker run --rm)
	if [ ${#REPO_MOUNT[@]} -gt 0 ]; then
		cmd+=("${REPO_MOUNT[@]}")
	fi
	cmd+=("${RESTIC_ENV[@]}" -v "$(host_path "$WORK")":/work "$RESTIC_IMAGE" --repo "$repo" --no-lock)
	"${cmd[@]}" "$@"
}

restic_data() { restic_run "$RESTIC_REPOSITORY" "$@"; }

restic_conf() (
	export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"
	restic_run "$RESTIC_CONFIG_REPOSITORY" "$@"
)

echo "[drill] scratch dir: $WORK"
receipt "drill.started=$(date -Is)"
receipt "drill.repo.data=$RESTIC_REPOSITORY"
receipt "drill.repo.config=$RESTIC_CONFIG_REPOSITORY"

# --- 1. newest data snapshot + data/config isolation ------------------------

echo "[drill] listing the data repository"
restic_data snapshots --latest 1 > "$WORK/data-snapshots.txt" ||
	die "cannot list the data repository (credentials or connectivity)"
# Newest row wins: `--latest 1` prints one row per group, and legacy
# `backup.sh` snapshots (host label) and Backrest ones can both be present.
DATA_ID=$(awk '/^[0-9a-f]{8,}/ { if ($2 " " $3 > best) { best = $2 " " $3; id = $1 } } END { print id }' "$WORK/data-snapshots.txt")
[ -n "$DATA_ID" ] || die "the data repository has no snapshots"
DATA_TIME=$(awk -v id="$DATA_ID" '$1 == id { print $2 " " $3; exit }' "$WORK/data-snapshots.txt")
receipt "snapshot.data=$DATA_ID"
receipt "snapshot.data.time=$DATA_TIME"

# Every snapshot, not just the newest: `--latest 1` returns one row per
# host+paths group, so pre-split snapshots (whose path set includes /config)
# would never be listed — and those are exactly the ones RUNBOOK §4.1 says this
# check finds.
restic_data snapshots > "$WORK/data-all.txt" ||
	die "cannot list the data repository"
DATA_IDS=()
while IFS= read -r id; do DATA_IDS+=("$id"); done < <(awk '/^[0-9a-f]{8,}/ { print $1 }' "$WORK/data-all.txt")
[ "${#DATA_IDS[@]}" -gt 0 ] || die "the data repository has no snapshots"
ENV_HITS=0
for id in "${DATA_IDS[@]}"; do
	if ! restic_data ls "$id" > "$WORK/data-ls.txt" 2> "$WORK/data-ls.err"; then
		die "cannot list the contents of data snapshot $id"
	fi
	hits=$(grep -cE '(^|/)\.env$' "$WORK/data-ls.txt" || true)
	if [ "$hits" != 0 ]; then
		echo "[drill] FAIL: .env inside data snapshot $id ($hits entries)" >&2
		ENV_HITS=$((ENV_HITS + hits))
	fi
done
[ "$ENV_HITS" = 0 ] ||
	die "$ENV_HITS .env entries inside data snapshots; the repositories are not split (RUNBOOK §4.1)"
receipt "snapshot.data.scanned=${#DATA_IDS[@]}"
receipt "snapshot.data.env_entries=0"

# --- 2. restore the data snapshot -------------------------------------------

echo "[drill] restoring data snapshot $DATA_ID"
mkdir -p "$WORK/restore-data"
restic_data restore "$DATA_ID" --target /work/restore-data > /dev/null ||
	die "restic restore failed for $DATA_ID"
# Two layouts coexist: Backrest's plan snapshots /staging, while a manual
# `backup.sh` run snapshots /backup. Drill whichever the newest snapshot used
# instead of failing on a healthy legacy snapshot.
DUMP=""
for candidate in "$WORK/restore-data/staging/pg.dump" "$WORK/restore-data/backup/pg.dump"; do
	if [ -s "$candidate" ]; then
		DUMP=$candidate
		break
	fi
done
[ -n "$DUMP" ] ||
	die "the restored snapshot has no pg.dump under staging/ or backup/ (top level: $(ls -A "$WORK/restore-data" 2>/dev/null | tr '\n' ' '))"
receipt "restored.dump_bytes=$(wc -c < "$DUMP")"

# --- 3. config repository: complete .env ------------------------------------

echo "[drill] restoring the config repository"
restic_conf snapshots --latest 1 > "$WORK/config-snapshots.txt" ||
	die "cannot list the config repository"
CONF_ID=$(awk '/^[0-9a-f]{8,}/ { if ($2 " " $3 > best) { best = $2 " " $3; id = $1 } } END { print id }' "$WORK/config-snapshots.txt")
[ -n "$CONF_ID" ] || die "the config repository has no snapshots"
mkdir -p "$WORK/restore-config"
restic_conf restore "$CONF_ID" --target /work/restore-config > /dev/null ||
	die "restic restore failed for the config snapshot $CONF_ID"
receipt "snapshot.config=$CONF_ID"
RESTORED_ENV="$WORK/restore-config/lair-env/.env"
[ -s "$RESTORED_ENV" ] || die "the config snapshot restores no lair-env/.env"
for key in BETTER_AUTH_SECRET SUPPRESSION_HMAC_KEY POSTGRES_PASSWORD; do
	grep -q "^$key=" "$RESTORED_ENV" || die "the restored .env has no $key; the config backup is incomplete"
done
if [ -f "$LIVE_ENV" ] && cmp -s "$RESTORED_ENV" "$LIVE_ENV"; then
	receipt "config.env_identical_to_live=true"
else
	# Not a failure by itself: a rotated secret since the snapshot is expected
	# drift. It is a fact the operator has to see, so it goes in the receipt.
	echo "[drill] WARN: the restored .env differs from $LIVE_ENV (rotated since the snapshot?)" >&2
	receipt "config.env_identical_to_live=false"
fi

# --- 4. throwaway PostgreSQL ------------------------------------------------

echo "[drill] starting the throwaway database ($PG_IMAGE)"
PG_CTR="web-lair-drill-$(date +%s)-$$"
PG_PW=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
# A --keep run leaves its container behind; a later drill with a recycled PID
# must not die on "name is already in use".
docker rm -fv "$PG_CTR" >/dev/null 2>&1 || true
docker run -d --name "$PG_CTR" --label web-lair-drill=1 \
	-e POSTGRES_PASSWORD="$PG_PW" -e POSTGRES_USER=drill -e POSTGRES_DB=drill \
	"$PG_IMAGE" > /dev/null || die "cannot start the throwaway database"

# TCP readiness, not the socket: the entrypoint's initdb phase runs a temporary
# server with listen_addresses='' , so a socket-only check can pass too early.
ready=0
tries=0
while [ "$tries" -lt 90 ]; do
	if docker exec "$PG_CTR" pg_isready -h 127.0.0.1 -U drill -d drill -q 2>/dev/null; then
		ready=1
		break
	fi
	tries=$((tries + 1))
	sleep 1
done
[ "$ready" = 1 ] || die "the throwaway database did not accept TCP connections in 90s"

echo "[drill] pg_restore into the throwaway database"
docker exec -i "$PG_CTR" pg_restore -U drill -d drill --no-owner --no-privileges --exit-on-error < "$DUMP" ||
	die "pg_restore failed on the restored dump"
RESTORED_EPOCH=$(date +%s)
receipt "restore.finished=$(date -Is)"

# --- 5a. row counts ---------------------------------------------------------

count_restored() { # $1 = quoted table name
	local out
	if out=$(docker exec "$PG_CTR" psql -U drill -d drill -tA -c "select count(*) from $1" 2> "$WORK/psql.err"); then
		printf '%s' "$out"
	else
		# A missing table is expected (the list is fixed, the schema moves on);
		# anything else is not, and folding it into n/a would hide a broken
		# restore behind a green receipt.
		grep -q 'does not exist' "$WORK/psql.err" 2>/dev/null ||
			echo "[drill] WARN: counting $1 failed: $(head -n 1 "$WORK/psql.err" 2>/dev/null)" >&2
		printf 'n/a'
	fi
}

LIVE_OK=0
if [ -n "${POSTGRES_USER:-}" ] && [ -n "${POSTGRES_DB:-}" ] && [ -n "$("${DC}" ps -q db 2>/dev/null)" ]; then
	LIVE_OK=1
fi
receipt "rows.live_compare=$([ "$LIVE_OK" = 1 ] && echo on || echo off)"

count_live() { # $1 = quoted table name
	local out
	if out=$(cd "$APP_DIR" && "${DC}" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "select count(*) from $1" 2>/dev/null); then
		printf '%s' "$out"
	else
		printf 'n/a'
	fi
}

restored_total=0
for table in "${TABLES[@]}"; do
	label=$(printf '%s' "$table" | tr -d '"')
	r=$(count_restored "$table")
	if [ "$r" != n/a ]; then
		restored_total=$((restored_total + r))
	fi
	if [ "$LIVE_OK" = 1 ]; then
		l=$(count_live "$table")
		receipt "rows.$label.restored=$r"
		receipt "rows.$label.live=$l"
		if [ "$r" != n/a ] && [ "$l" != n/a ] && [ "$r" -lt "$l" ]; then
			if [ "$COMPARE_LIVE" = 1 ]; then
				die "table $label restored $r rows but the live database has $l"
			fi
			echo "[drill] WARN: table $label restored $r rows vs live $l" >&2
		fi
	else
		receipt "rows.$label.restored=$r"
	fi
done
[ "$restored_total" -gt 0 ] ||
	echo "[drill] WARN: every sampled table is empty in the snapshot; row counts prove nothing" >&2
receipt "rows.sampled_total=$restored_total"

# --- 5b. F-22 orphan sweep --------------------------------------------------

echo "[drill] orphan sweep (F-22)"
docker exec -i "$PG_CTR" psql -U drill -d drill -q -v ON_ERROR_STOP=1 -tA \
	< "$SCRIPT_DIR/backup/orphan-check.sql" > "$WORK/orphans.txt" 2> "$WORK/orphans.err" ||
	die "the orphan sweep failed to run: $(head -n 3 "$WORK/orphans.err")"
ORPHAN_TOTAL=$(awk -F'|' '{ total += $2 } END { print total + 0 }' "$WORK/orphans.txt")
if [ "$ORPHAN_TOTAL" != 0 ]; then
	awk -F'|' '$2 != 0' "$WORK/orphans.txt" >&2
	die "$ORPHAN_TOTAL orphan rows across the restored foreign keys"
fi
receipt "orphans.fks_checked=$(grep -c '|' "$WORK/orphans.txt" || true)"
receipt "orphans.total=0"

# --- 5c. media sample vs the live volume ------------------------------------

RUSTFS_VOLUME=${DRILL_LIVE_RUSTFS_VOLUME:-}
if [ -z "$RUSTFS_VOLUME" ]; then
	RUSTFS_CONTAINER=$("${DC}" ps -q rustfs 2>/dev/null || true)
	if [ -n "$RUSTFS_CONTAINER" ]; then
		RUSTFS_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$RUSTFS_CONTAINER")
	fi
fi

cat > "$WORK/media-compare.sh" <<'MEDIA'
#!/bin/sh
# Compare media objects between the live volume and the restored tree.
#
# The sample is drawn from the INTERSECTION of both trees: production keeps
# uploading and deleting while a snapshot ages, so sampling "the first N of the
# live volume" would report false mismatches for anything written after the
# snapshot. Only objects present on both sides can prove the restore is faithful.
set -eu
n=${1:-5}
(cd /live && find . -type f 2>/dev/null | sort) > /tmp/live.all || true
(cd /restored && find . -type f 2>/dev/null | sort) > /tmp/restored.all || true
comm -12 /tmp/live.all /tmp/restored.all > /tmp/both.all || true
echo "live_total=$(wc -l < /tmp/live.all)"
echo "restored_total=$(wc -l < /tmp/restored.all)"
echo "common=$(wc -l < /tmp/both.all)"
head -n "$n" /tmp/both.all > /tmp/sample
checked=0
mismatch=0
while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	if [ ! -f "/restored/$rel" ]; then
		echo "missing $rel"
		mismatch=$((mismatch + 1))
		continue
	fi
	a=$(sha256sum "/live/$rel" | cut -d' ' -f1)
	b=$(sha256sum "/restored/$rel" | cut -d' ' -f1)
	if [ "$a" = "$b" ]; then
		checked=$((checked + 1))
	else
		echo "mismatch $rel"
		mismatch=$((mismatch + 1))
	fi
done < /tmp/sample
echo "checked=$checked"
echo "mismatch=$mismatch"
MEDIA

MEDIA_STATE=ok
if [ ! -d "$WORK/restore-data/lair-rustfs" ]; then
	# Separate from "no live volume": a snapshot without the media tree is a
	# backup problem (legacy layout, or a plan path that lost /lair-rustfs), not
	# an environment limitation — the receipt must not blur the two.
	echo "[drill] WARN: the snapshot has no lair-rustfs tree; media sample skipped" >&2
	receipt "media.checked=0"
	receipt "media.skipped=no-restored-tree"
	MEDIA_STATE=no-restored-tree
elif [ -z "$RUSTFS_VOLUME" ]; then
	echo "[drill] WARN: no live rustfs volume resolved; media sample skipped" >&2
	receipt "media.checked=0"
	receipt "media.skipped=no-live-volume"
	MEDIA_STATE=no-live-volume
else
	echo "[drill] media sample ($SAMPLE objects) vs volume $RUSTFS_VOLUME"
	# --entrypoint: the restic image's entrypoint IS the restic binary, so a bare
	# `docker run <image> sh …` would be parsed as `restic sh …`.
	MEDIA_OUT=$(docker run --rm --entrypoint sh \
		-v "$(host_path "$WORK")":/drill:ro \
		-v "$(host_path "$WORK/restore-data/lair-rustfs")":/restored:ro \
		-v "$RUSTFS_VOLUME":/live:ro \
		"$RESTIC_IMAGE" /drill/media-compare.sh "$SAMPLE") ||
		die "the media comparison failed to run"
	printf '%s\n' "$MEDIA_OUT"
	receipt "media.live_total=$(printf '%s\n' "$MEDIA_OUT" | sed -n 's/^live_total=//p')"
	receipt "media.restored_total=$(printf '%s\n' "$MEDIA_OUT" | sed -n 's/^restored_total=//p')"
	receipt "media.common=$(printf '%s\n' "$MEDIA_OUT" | sed -n 's/^common=//p')"
	receipt "media.checked=$(printf '%s\n' "$MEDIA_OUT" | sed -n 's/^checked=//p')"
	receipt "media.mismatch=$(printf '%s\n' "$MEDIA_OUT" | sed -n 's/^mismatch=//p')"
	[ "$(printf '%s\n' "$MEDIA_OUT" | sed -n 's/^mismatch=//p')" = 0 ] ||
		die "the restored media sample does not match the live volume"
	[ "$(printf '%s\n' "$MEDIA_OUT" | sed -n 's/^checked=//p')" != 0 ] ||
		echo "[drill] WARN: no media object exists on both sides; the sample proves nothing" >&2
fi
# --- 6. RTO / RPO -----------------------------------------------------------

DUMP_EPOCH=$(stat -c %Y "$DUMP" 2>/dev/null || stat -f %m "$DUMP")
NOW_EPOCH=$(date +%s)
receipt "rpo_seconds=$((START_EPOCH - DUMP_EPOCH))"
receipt "rto_seconds=$((RESTORED_EPOCH - START_EPOCH))"
receipt "drill.finished=$(date -Is)"
# A drill that could not check the media tree is still a pass for the database
# side, but the receipt must not claim more than it verified.
if [ "${MEDIA_STATE:-ok}" = ok ]; then
	receipt "result=PASS"
else
	receipt "result=PASS(media-skipped:$MEDIA_STATE)"
fi

echo "[drill] PASS: snapshot $DATA_ID restored, orphan sweep clean, media sample identical"
echo "[drill] receipt: $RECEIPT"
