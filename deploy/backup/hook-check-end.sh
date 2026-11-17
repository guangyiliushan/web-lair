#!/bin/sh
#
# Backrest CONDITION_CHECK_SUCCESS / CONDITION_CHECK_ERROR hook.
#
# Replaces the ping that `web-lair-backup-check.service` used to send after the
# weekly `restic check`: the timer is gone (Backrest's `checkPolicy` owns the
# schedule), but the dead-man signal must survive — silence on a periodic check
# is exactly the failure mode nobody notices until a restore is needed.
#
# Usage: [--config] [--failed]
#   --config  report on CHECK_PING_URL_CONFIG instead of CHECK_PING_URL, so a
#             failing config-repo check cannot be masked by a green data check
#   --failed  send <url>/fail instead of the success ping
#
# Unset URL ⇒ log and exit 0 (a fresh install has no UUID yet).
set -eu

scope=data
failed=0
for arg in "$@"; do
	case "$arg" in
		--config) scope=config ;;
		--failed) failed=1 ;;
		--*) echo "[hook] unknown option: $arg" >&2; exit 2 ;;
	esac
done

if [ "$scope" = config ]; then
	url=${CHECK_PING_URL_CONFIG:-}
else
	url=${CHECK_PING_URL:-}
fi

if [ -z "$url" ]; then
	echo "[hook] the ${scope} check URL is not configured; skipping the repository-check ping"
	exit 0
fi

if [ "$failed" = 1 ]; then
	echo "[hook] the ${scope} repository check failed; reporting /fail"
	curl -fsS --max-time 10 "${url%/}/fail" >/dev/null ||
		echo "[hook] /fail ping delivery failed; the check will go red on its own period" >&2
else
	curl -fsS --max-time 10 "$url" >/dev/null
	echo "[hook] pinged the ${scope} repository-check check"
fi
