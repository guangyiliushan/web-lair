#!/bin/sh
#
# Backrest CONDITION_SNAPSHOT_END command hook.
#
# Usage (from the rendered config): [--config] [--failed] [<snapshot-id>]
#
# Green must mean "a snapshot exists", not "a dump was produced": the upload
# phase can be cancelled, and a plan path can be wrong — both leave a fresh,
# readable dump behind. Backrest therefore passes the snapshot id, and a success
# branch without one withholds the ping.
#
# --failed is passed when the operation reported an error (the Go template
# `{{ if .Error }}` decides): pinging success there would hide the failure until
# the next missing period. A configured URL gets an explicit /fail instead.
#
# URL selection: the data plan pings BACKUP_PING_URL, the config plan
# CONFIG_PING_URL (its own check — sharing one URL would let a green data run
# mask a red config run). Unset URL ⇒ log and exit 0.
set -eu

scope=data
failed=0
snapshot_id=""
for arg in "$@"; do
	case "$arg" in
		--failed) failed=1 ;;
		--config) scope=config ;;
		--*) echo "[hook] unknown option: $arg" >&2; exit 2 ;;
		*) snapshot_id=$arg ;;
	esac
done

STAGING=${BACKUP_DIR:-/staging}
DUMP="$STAGING/pg.dump"
if [ "$scope" = config ]; then
	url=${CONFIG_PING_URL:-}
else
	url=${BACKUP_PING_URL:-}
fi

ping() { curl -fsS --max-time 10 "$1" >/dev/null; }

if [ "$failed" = 1 ]; then
	echo "[hook] ${scope} operation reported an error; withholding the success ping"
	if [ -n "$url" ]; then
		ping "${url%/}/fail" ||
			echo "[hook] /fail ping delivery failed; the check will go red on its own period" >&2
	fi
	exit 0
fi

if [ -z "$snapshot_id" ]; then
	echo "[hook] Backrest passed no snapshot id; withholding the ${scope} success ping" >&2
	# Do not go silent: this is "the upload may have worked but the assertion
	# could not run", which needs a human — a red check says so immediately,
	# while silence would look like "the backup never ran".
	if [ -n "$url" ]; then
		ping "${url%/}/fail" ||
			echo "[hook] /fail ping delivery failed; the check will go red on its own period" >&2
	fi
	exit 1
fi

if [ "$scope" = data ]; then
	[ -s "$DUMP" ] || {
		echo "[hook] $DUMP is missing or empty; withholding the success ping" >&2
		exit 1
	}
	# The dump must be the one *this* run produced: a cancelled operation leaves
	# yesterday's dump in place, and it can still be young enough to pass a pure
	# age check. A missing marker is not "probably fine" — it is "cannot prove".
	RUN_MARKER=${BACKUP_RUN_MARKER:-/tmp/web-lair-backup-run-start}
	run_start=$(cat "$RUN_MARKER" 2>/dev/null || echo 0)
	[ "${run_start:-0}" -gt 0 ] || {
		echo "[hook] run marker $RUN_MARKER is missing; cannot prove the dump belongs to this run" >&2
		exit 1
	}
	dump_epoch=$(stat -c %Y "$DUMP" 2>/dev/null || echo 0)
	[ "$dump_epoch" -gt 0 ] || {
		echo "[hook] cannot stat $DUMP; withholding the success ping" >&2
		exit 1
	}
	[ "$dump_epoch" -ge "$run_start" ] || {
		echo "[hook] $DUMP predates this run ($dump_epoch < $run_start); withholding the success ping" >&2
		exit 1
	}
	# Ceiling for a marker that is present but stale (e.g. a volume restored from
	# an old backup). Generous on purpose: a first full media upload can take
	# hours, and the marker above is the precise signal.
	max_age=${BACKUP_PING_MAX_AGE_MIN:-1440}
	now=$(date +%s)
	[ $((now - dump_epoch)) -le $((max_age * 60)) ] || {
		echo "[hook] $DUMP is older than ${max_age} min; withholding the success ping" >&2
		exit 1
	}
	pg_restore -l < "$DUMP" >/dev/null 2>&1 || {
		echo "[hook] $DUMP is not a readable pg_dump archive; withholding the success ping" >&2
		exit 1
	}
fi

if [ -z "$url" ]; then
	echo "[hook] ${scope} check URL is not configured; skipping the ping (snapshot $snapshot_id)"
	exit 0
fi
ping "$url"
echo "[hook] pinged the ${scope} check (snapshot $snapshot_id)"
