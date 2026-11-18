#!/usr/bin/env bash
# Verify Sentinel traffic analytics end to end. Four probes, each with its own
# verdict: 1. running - compose service healthy and /api/health answers "ok";
# 2. parsing - a site request appears in Sentinel's top paths; 3. retention -
# analytics DB exists, tier retention pinned, 30d series returns 30 buckets;
# 4. reconcile - one closed minute: Sentinel's request count vs Caddy access
# log line count, within OBS_RECON_DEVIATION_PCT.
# Reads SENTINEL_TOKEN from the environment or APP_DIR/.env and never prints
# it; needs curl + docker compose, reaches Sentinel through `compose exec`
# (the port is never published).
# usage:
#   bash deploy/verify-observability.sh [--receipt <path>]
#   SITE_URL=https://example.com bash deploy/verify-observability.sh
# `bash` (not `./`) on purpose: core.filemode=false means the 100755 mode does
# not survive a commit unless the index is updated explicitly.
# exit: 0 = all four probes pass, 1 = at least one failed, 2 = usage/setup.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}
COMPOSE="${APP_DIR}/deploy/compose-prod.sh"
ENV_FILE=${ENV_FILE:-"${APP_DIR}/.env"}

SITE_URL=${SITE_URL:-}
SENTINEL_TOKEN=${SENTINEL_TOKEN:-}
OBS_RECON_DEVIATION_PCT=${OBS_RECON_DEVIATION_PCT:-10}
OBS_PARSE_WAIT_SECS=${OBS_PARSE_WAIT_SECS:-90}
OBS_HEALTH_WAIT_SECS=${OBS_HEALTH_WAIT_SECS:-30}
OBS_RECEIPT=${OBS_RECEIPT:-}
OBS_RECON_REQUESTS=${OBS_RECON_REQUESTS:-20}
OBS_RECON_GRACE_SECS=${OBS_RECON_GRACE_SECS:-8}
# A static, 2xx path the PV filter excludes (default /robots.txt). The probes
# must not create 404s or page requests in the dataset they verify.
OBS_PROBE_PATH=${OBS_PROBE_PATH:-/robots.txt}
PROBE_PATH=$OBS_PROBE_PATH

RUNNING_OK=0
PARSING_OK=0
RETENTION_OK=0
RECON_OK=0
RUNNING_DETAIL=""
PARSING_DETAIL=""
RETENTION_DETAIL=""
RECON_DETAIL=""
FAILED=0

usage() {
	sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
		--receipt)
			[ $# -ge 2 ] || { echo "[obs] --receipt needs a path" >&2; exit 2; }
			OBS_RECEIPT=$2
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "[obs] unknown argument: $1" >&2
			exit 2
			;;
	esac
done

env_value() {
	local file=$1 key=$2
	[ -f "$file" ] || return 0
	sed -n "s/^${key}=//p" "$file" | tail -n 1 | tr -d '\r' | sed 's/^"//; s/"$//'
}

compose_exec() {
	"${COMPOSE}" exec -T "$@"
}

sentinel_get() {
	local path=$1
	# The token travels on stdin, not in the docker exec argv (visible in ps /
	# auditd). The inner shell expands it inside the container only.
	printf '%s\n' "$SENTINEL_TOKEN" |
		compose_exec -i sentinel sh -c '
			IFS= read -r token
			wget -q -O - --header="Authorization: Bearer $token" "http://127.0.0.1:8888$1"
		' sh "$path" | tr -d '\r'
}

pass() {
	local name=$1 detail=$2
	case "$name" in
		running) RUNNING_OK=1 ;;
		parsing) PARSING_OK=1 ;;
		retention) RETENTION_OK=1 ;;
		reconcile) RECON_OK=1 ;;
	esac
	printf '[PASS] %-9s %s\n' "$name" "$detail"
}

fail() {
	local name=$1 detail=$2
	FAILED=1
	printf '[FAIL] %-9s %s\n' "$name" "$detail" >&2
}

json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r\t'
}

need_setup() {
	if [ -z "$SENTINEL_TOKEN" ]; then
		SENTINEL_TOKEN=$(env_value "$ENV_FILE" SENTINEL_TOKEN)
	fi
	if [ -z "$SITE_URL" ]; then
		local domain
		domain=$(env_value "$ENV_FILE" DOMAIN)
		[ -n "$domain" ] && SITE_URL="https://${domain}"
	fi
	if [ -z "$SENTINEL_TOKEN" ]; then
		echo "[obs] SENTINEL_TOKEN is missing (env or ${ENV_FILE})" >&2
		return 1
	fi
	if [ -z "$SITE_URL" ]; then
		echo "[obs] SITE_URL is missing (env, or DOMAIN in ${ENV_FILE})" >&2
		return 1
	fi
	if [ ! -x "$COMPOSE" ]; then
		echo "[obs] ${COMPOSE} is not executable" >&2
		return 1
	fi
	command -v docker >/dev/null 2>&1 || {
		echo "[obs] docker is required" >&2
		return 1
	}
	command -v curl >/dev/null 2>&1 || {
		echo "[obs] curl is required" >&2
		return 1
	}
	return 0
}

# --- 1. running ------------------------------------------------------------
probe_running() {
	local cid="" status="" body="" dashboard="" from="" to="" waited=0
	while [ "$waited" -lt "$OBS_HEALTH_WAIT_SECS" ]; do
		cid=$("${COMPOSE}" ps -q sentinel 2>/dev/null | tr -d '\r' | head -n 1)
		[ -n "$cid" ] || break
		status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null)
		[ "$status" = "healthy" ] && break
		sleep 1
		waited=$((waited + 1))
	done
	body=$(compose_exec sentinel wget -qO- http://127.0.0.1:8888/api/health 2>/dev/null | tr -d '\r')
	if [ -n "$cid" ] && [ "$status" = "healthy" ] && [ "$body" = "ok" ]; then
		# Exercise the same dashboard query shape the app uses (whole-second
		# bounds, Bearer, all page limits). A timestamp/auth regression here is
		# exactly what took the client down before.
		from=$(date -u -d "@$(( $(date +%s) - 86400 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
			date -u -r "$(( $(date +%s) - 86400 ))" +%Y-%m-%dT%H:%M:%SZ)
		to=$(date -u +%Y-%m-%dT%H:%M:%SZ)
		dashboard=$(sentinel_get "/api/traffic/dashboard?from=${from}&to=${to}&range=24h&paths_limit=1000&breakdown_limit=50" 2>&1)
		if printf '%s' "$dashboard" | grep -q '"overview"'; then
			RUNNING_DETAIL="health=healthy api=ok dashboard=ok"
			pass running "$RUNNING_DETAIL"
		else
			RUNNING_DETAIL="dashboard contract query failed: ${dashboard:-no answer}"
			fail running "$RUNNING_DETAIL"
		fi
	else
		RUNNING_DETAIL="container=${cid:-missing} health=${status:-unknown} api=${body:-no-answer}"
		fail running "$RUNNING_DETAIL"
	fi
}

# --- 2. parsing ------------------------------------------------------------
probe_parsing() {
	if [ "$RUNNING_OK" != 1 ]; then
		PARSING_DETAIL="skipped: Sentinel is not running"
		fail parsing "$PARSING_DETAIL"
		return
	fi
	local probe_path=$PROBE_PATH probe_query code deadline body i baseline baseline_body count
	probe_query="__obs_parse=$(date +%s)-$$"
	code=""
	baseline_body=$(sentinel_get "/api/traffic/paths?limit=1000")
	baseline=$(printf '%s' "$baseline_body" |
		grep -o "\"path\":\"${probe_path}\"[^}]*" |
		grep -o '"requests":[0-9]*' | head -n 1 | cut -d: -f2)
	baseline=${baseline:-0}
	for i in 1 2 3 4 5; do
		code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${SITE_URL}${probe_path}?${probe_query}-${i}" 2>/dev/null || true)
	done
	if [ -z "$code" ] || [ "${code#2}" = "$code" ]; then
		PARSING_DETAIL="probe path ${probe_path} returned ${code:-000}; set OBS_PROBE_PATH to a 2xx static path"
		fail parsing "$PARSING_DETAIL"
		return
	fi
	deadline=$(($(date +%s) + OBS_PARSE_WAIT_SECS))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		body=$(sentinel_get "/api/traffic/paths?limit=1000")
		count=$(printf '%s' "$body" |
			grep -o "\"path\":\"${probe_path}\"[^}]*" |
			grep -o '"requests":[0-9]*' | head -n 1 | cut -d: -f2)
		if [ "${count:-0}" -ge $((baseline + 5)) ]; then
			PARSING_DETAIL="path=${probe_path} http=${code} requests=${count} (baseline ${baseline})"
			pass parsing "$PARSING_DETAIL"
			return
		fi
		sleep 2
	done
	PARSING_DETAIL="path=${probe_path} did not rise by 5 after ${OBS_PARSE_WAIT_SECS}s (http=${code}, baseline=${baseline}, last=${count:-?})"
	fail parsing "$PARSING_DETAIL"
}

# --- 3. retention ----------------------------------------------------------
probe_retention() {
	if [ "$RUNNING_OK" != 1 ]; then
		RETENTION_DETAIL="skipped: Sentinel is not running"
		fail retention "$RETENTION_DETAIL"
		return
	fi
	local db retention_1m retention_1h retention_1d buckets body
	db=$(compose_exec sentinel sh -c 'test -s /app/db/analytics.sqlite && echo ok' 2>/dev/null | tr -d '\r')
	retention_1m=$(compose_exec sentinel printenv TRAFFIC_RETENTION_1M_HOURS 2>/dev/null | tr -d '\r')
	retention_1h=$(compose_exec sentinel printenv TRAFFIC_RETENTION_1H_DAYS 2>/dev/null | tr -d '\r')
	retention_1d=$(compose_exec sentinel printenv TRAFFIC_RETENTION_1D_DAYS 2>/dev/null | tr -d '\r')
	body=$(sentinel_get "/api/traffic/series?range=30d")
	buckets=$(printf '%s' "$body" | grep -o '"bucket":' | wc -l | tr -d ' ')
	if [ "$db" = "ok" ] &&
		[ "$retention_1m" = "48" ] && [ "$retention_1h" = "30" ] && [ "$retention_1d" = "395" ] &&
		[ "$buckets" = "30" ]; then
		RETENTION_DETAIL="db=ok 1m=48h 1h=30d 1d=395d series30d=30"
		pass retention "$RETENTION_DETAIL"
	else
		RETENTION_DETAIL="db=${db:-missing} 1m=${retention_1m:-?}h 1h=${retention_1h:-?}d 1d=${retention_1d:-?}d series30d=${buckets:-0}"
		fail retention "$RETENTION_DETAIL"
	fi
}

# --- 4. reconcile ----------------------------------------------------------
# A full minute is required: Sentinel stores 1m buckets and only exposes a
# closed window, so a partial minute would compare a bucket against a slice.
probe_reconcile() {
	if [ "$RUNNING_OK" != 1 ]; then
		RECON_DETAIL="skipped: Sentinel is not running"
		fail reconcile "$RECON_DETAIL"
		return
	fi
	local t0 t1 from to sentinel log log_size0 log_size1 i diff pct
	# Force t0 to an exact minute boundary. Sentinel floors `from` to the minute,
	# so a one-second drift would count lines outside the awk window.
	t0=$(( ($(date +%s) / 60 + 1) * 60 ))
	while [ "$(date +%s)" -lt "$t0" ]; do
		sleep 1
	done
	log_size0=$(compose_exec sentinel sh -c 'wc -c < /var/log/caddy/access.log' 2>/dev/null | tr -d ' \r')
	local probe_path=$PROBE_PATH probe_query
	for i in $(seq 1 "$OBS_RECON_REQUESTS"); do
		probe_query="__obs_recon=${t0}-${i}"
		curl -sS -o /dev/null --max-time 5 "${SITE_URL}${probe_path}?${probe_query}" 2>/dev/null || true
	done
	t1=$((t0 + 60))
	while [ "$(date +%s)" -lt $((t1 + OBS_RECON_GRACE_SECS)) ]; do
		sleep 1
	done
	log_size1=$(compose_exec sentinel sh -c 'wc -c < /var/log/caddy/access.log' 2>/dev/null | tr -d ' \r')
	if [ -n "$log_size0" ] && [ -n "$log_size1" ] && [ "$log_size1" -lt "$log_size0" ]; then
		RECON_DETAIL="access.log rotated during the window (${log_size0}->${log_size1} bytes); retry"
		fail reconcile "$RECON_DETAIL"
		return
	fi
	from=$(date -u -d "@${t0}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "${t0}" +%Y-%m-%dT%H:%M:%SZ)
	to=$(date -u -d "@${t1}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "${t1}" +%Y-%m-%dT%H:%M:%SZ)
	sentinel=$(sentinel_get "/api/traffic/overview?from=${from}&to=${to}" | grep -o '"requests":[0-9]*' | head -n 1 | cut -d: -f2)
	log=$(compose_exec sentinel sh -c '
		awk -v a="$1" -v b="$2" '"'"'
			match($0, /"ts":[0-9.]+/) {
				ts = substr($0, RSTART + 5, RLENGTH - 5) + 0
				if (ts >= a && ts < b) n++
			}
			END { print n + 0 }
		'"'"' /var/log/caddy/access.log
	' sh "$t0" "$t1" | tr -d ' \r')
	sentinel=${sentinel:-0}
	log=${log:-0}
	if [ "$log" -le 0 ]; then
		RECON_DETAIL="no access-log lines in [${from}, ${to}); sentinel=${sentinel}"
		fail reconcile "$RECON_DETAIL"
		return
	fi
	if [ "$sentinel" -ge "$log" ]; then
		diff=$((sentinel - log))
	else
		diff=$((log - sentinel))
	fi
	pct=$((diff * 100 / log))
	if [ "$pct" -le "$OBS_RECON_DEVIATION_PCT" ]; then
		RECON_DETAIL="log=${log} sentinel=${sentinel} deviation=${pct}% window=${from}..${to}"
		pass reconcile "$RECON_DETAIL"
	else
		RECON_DETAIL="log=${log} sentinel=${sentinel} deviation=${pct}% > ${OBS_RECON_DEVIATION_PCT}% window=${from}..${to}"
		fail reconcile "$RECON_DETAIL"
	fi
}

write_receipt() {
	[ -n "$OBS_RECEIPT" ] || return 0
	mkdir -p "$(dirname "$OBS_RECEIPT")" 2>/dev/null || true
	cat >"$OBS_RECEIPT" <<EOF
{
  "checkedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "siteUrl": "$(json_escape "$SITE_URL")",
  "deviationLimitPct": ${OBS_RECON_DEVIATION_PCT},
  "probes": {
    "running": { "ok": $([ "$RUNNING_OK" = 1 ] && echo true || echo false), "detail": "$(json_escape "$RUNNING_DETAIL")" },
    "parsing": { "ok": $([ "$PARSING_OK" = 1 ] && echo true || echo false), "detail": "$(json_escape "$PARSING_DETAIL")" },
    "retention": { "ok": $([ "$RETENTION_OK" = 1 ] && echo true || echo false), "detail": "$(json_escape "$RETENTION_DETAIL")" },
    "reconcile": { "ok": $([ "$RECON_OK" = 1 ] && echo true || echo false), "detail": "$(json_escape "$RECON_DETAIL")" }
  }
}
EOF
	printf '[obs] receipt: %s\n' "$OBS_RECEIPT"
}

need_setup || exit 2

echo "[obs] Sentinel traffic verification against ${SITE_URL}"
probe_running
probe_parsing
probe_retention
probe_reconcile
write_receipt

if [ "$FAILED" -eq 0 ]; then
	echo "[obs] PASS 4/4 probes"
	exit 0
fi
echo "[obs] FAIL: at least one probe failed" >&2
exit 1
