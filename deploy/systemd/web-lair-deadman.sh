#!/bin/sh
# Box-external dead-man ping (M6 P3).
#
# Two signals, one request: the ping proves the box is alive, and it must also
# prove the in-box monitor is alive. Gatus runs with `restart: always`, so a
# crash loop (bad config, bad env) keeps the host healthy while monitoring and
# alerting are silently dead - a plain ping would then report green (review
# P0-1). When Gatus' /health fails we report FAIL to healthchecks instead.
#
# The ping URL is a write capability (whoever holds it can suppress the alarm),
# so it is fed to curl through a 0600-equivalent stdin config instead of argv
# (`ps` is world-readable) (review P2-2).
set -u

url=${HC_DEADMAN_URL:-${DEADMAN_PING_URL:-}}
[ -n "$url" ] || exit 0

gatus_health=${GATUS_HEALTH_URL:-http://127.0.0.1:8080/health}
if ! curl -fsS --max-time 5 "$gatus_health" >/dev/null 2>&1; then
	case "$url" in
		*/fail) ;;
		*) url="${url%/}/fail" ;;
	esac
fi

printf 'url = "%s"\n' "$url" | curl -fsS --max-time 10 -K -
