#!/bin/sh
#
# Backrest CONDITION_SNAPSHOT_START command hook.
#
# Data plan (no argument): runs `backup.sh --dump-only`, which keeps every gate
# of the nightly path (.tmp → `pg_restore -l` → live user-row comparison →
# atomic mv, umask 077) and stops before restic. Backrest then snapshots
# $BACKUP_DIR, so the snapshot can only ever contain a dump that passed.
# Wired with ON_ERROR_CANCEL: a non-zero exit cancels the operation and no
# snapshot is written.
#
# Config plan (--config): the data repository's `.env` copy lives in the SECOND
# repository; an empty or incomplete .env there is worthless, so refuse the
# operation instead of writing a config snapshot that restores to nothing.
# Wired with ON_ERROR_FATAL: this one *is* an error, not a quiet cancel.
set -eu

export BACKUP_PG_MODE="${BACKUP_PG_MODE:-local}"
export BACKUP_DIR="${BACKUP_DIR:-/staging}"

hook_dir=$(dirname "$0")
# The success ping is gated on "the dump this operation produced", so the start
# hook records when it began: a cancelled run leaves the previous dump in place,
# and the end hook compares mtimes instead of trusting the file's existence.
RUN_MARKER=${BACKUP_RUN_MARKER:-/tmp/web-lair-backup-run-start}

# An empty data set is legitimate on a fresh install, so only a *missing*
# directory fails here — that means the bind mount did not happen and the
# snapshot would silently cover nothing. The counts go into the run log so the
# receipt shows what was actually captured.
report_tree() {
	[ -d "$1" ] || return 1
	printf '%s entries in %s' "$(ls -A "$1" 2>/dev/null | wc -l | tr -d ' ')" "$1"
}

# A directory that exists but cannot be read is worse than a missing one: restic
# still "completes" (with "some files could not be read") and the run only turns
# red after a long upload. Probe one file up front so the failure message names
# the tree and the likely cause. An empty tree stays allowed (fresh install).
readable_tree() {
	[ -d "$1" ] || return 1
	sample=$(find "$1" -type f 2>/dev/null | head -n 1)
	[ -n "$sample" ] || return 0
	[ -r "$sample" ] || return 2
	return 0
}

case "${1:-}" in
	"")
		mkdir -p "$BACKUP_DIR" 2>/dev/null || true
		# Atomic: a half-written number would compare as a bogus epoch.
		printf '%s\n' "$(date +%s)" > "$RUN_MARKER.tmp" && mv "$RUN_MARKER.tmp" "$RUN_MARKER"
		for tree in /lair-data /lair-rustfs; do
			report=$(report_tree "$tree") || {
				echo "[hook] $tree is missing; refusing to snapshot an empty data set" >&2
				exit 1
			}
			probe=0
			readable_tree "$tree" || probe=$?
			case "$probe" in
				0) echo "[hook] $report" ;;
				2)
					echo "[hook] $tree exists but its files are not readable (wrong uid, or a capability missing from the container); refusing to snapshot a tree restic would only half-read" >&2
					exit 1
					;;
				*)
					echo "[hook] cannot probe $tree (rc=$probe); refusing to snapshot it blind" >&2
					exit 1
					;;
			esac
		done
		# bash, not sh: backup.sh uses arrays. The script is bind-mounted from
		# the checkout, so its exec bit is not relied on.
		exec bash "$hook_dir/backup.sh" --dump-only
		;;
	--config)
		env_file=${CONFIG_ENV_FILE:-/lair-env/.env}
		[ -s "$env_file" ] || {
			echo "[hook] $env_file is missing or empty; the config snapshot would restore to nothing" >&2
			exit 1
		}
		for key in BETTER_AUTH_SECRET SUPPRESSION_HMAC_KEY POSTGRES_PASSWORD; do
			# `=.+` and not just `=`: an emptied secret ("KEY=") passes a
			# presence test but restores an application that cannot boot.
			grep -qE "^${key}=.+" "$env_file" || {
				echo "[hook] $env_file has no value for $key; refusing to snapshot an incomplete config" >&2
				exit 1
			}
		done
		echo "[hook] $env_file carries $(grep -c . "$env_file") non-empty lines; snapshot may proceed"
		;;
	*)
		echo "[hook] unknown argument: $1 (usage: hook-snapshot-start.sh [--config])" >&2
		exit 2
		;;
esac
