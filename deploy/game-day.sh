#!/usr/bin/env bash
# M6 game day (T7.3): drive controlled faults at the alerting layer and record
# detection / recovery times.
#
# Why this exists: the runbook covers *what to do* when an alert fires; this
# script answers the other question — *would we even be told, and how long
# would it take*. Every drill asserts three things:
#   1. the fault is DETECTED by the monitor (TRIGGERED),
#   2. recovery is OBSERVED (RESOLVED),
#   3. both are recorded as wall-clock deltas in the receipt.
#
# Drill classes:
#   pg / container   self-contained: a throwaway target container + a Gatus
#                    monitor on a scratch network. Safe on any host, no data
#                    touched, cleaned up on exit. This is the runnable default.
#   drain / disk     dry-run only: they need the box (systemd timers) or write
#                    to a real mount. The script prints the exact recipe and the
#                    assertions to check; run it during the production window.
#
# usage:
#   bash deploy/game-day.sh                         # dry-run: print every drill
#   bash deploy/game-day.sh --drill pg              # run the PG drill (safe, disposable)
#   bash deploy/game-day.sh --drill container       # run the container drill
#   bash deploy/game-day.sh --drill all --receipt /tmp/gd.json
#   ALLOW_GAME_DAY=1 bash deploy/game-day.sh --drill pg   # required to actually run
#
# flags:
#   --drill <pg|container|drain|disk|all>   default: all
#   --receipt <path>                        write the JSON receipt here
#   --interval <seconds>                    monitor interval (default 5)
#   --timeout <seconds>                     per-phase wait budget (default 120)
#   --keep                                  keep the scratch containers for inspection
#   -h | --help
#
# guarantees:
#   - no secret is read or printed (the drill config carries no BARK_URL);
#   - the target is ALWAYS a container this script created (never `db`/`app`);
#   - a trap removes containers/network even when the drill fails.
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GATUS_IMAGE=${GATUS_IMAGE:-$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$HERE/monitoring/compose.monitoring.yaml" | head -n 1)}
PG_IMAGE=${PG_IMAGE:-postgres:18}
APP_IMAGE_FOR_HTTP=${APP_IMAGE_FOR_HTTP:-nginx:alpine}
DRILL=all
RECEIPT=
INTERVAL=5
WAIT_TIMEOUT=120
KEEP=0
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NET="gd-$STAMP-$$"
TMP=""
# The Gatus image is distroless (no shell, no wget/curl), so the drill reads the
# status API from the host over a loopback port it publishes itself. Nothing is
# exposed beyond 127.0.0.1 and the container is removed on exit.
MONITOR_PORT=${MONITOR_PORT:-18099}

say() { printf '%s\n' "$*"; }
die() {
	printf '[game-day] %s\n' "$*" >&2
	exit 1
}

usage() { sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [ $# -gt 0 ]; do
	case "$1" in
		--drill)
			DRILL=${2:?--drill needs a value}
			shift 2
			;;
		--receipt)
			RECEIPT=${2:?--receipt needs a value}
			shift 2
			;;
		--interval)
			INTERVAL=${2:?--interval needs a value}
			shift 2
			;;
		--timeout)
			WAIT_TIMEOUT=${2:?--timeout needs a value}
			shift 2
			;;
		--keep)
			KEEP=1
			shift
			;;
		-h | --help) usage ;;
		*) die "unknown argument: $1 (try --help)" ;;
	esac
done

case "$DRILL" in pg | container | drain | disk | all) : ;; *) die "--drill must be pg|container|drain|disk|all" ;; esac
# $INTERVAL is interpolated into the Gatus YAML and $WAIT_TIMEOUT into `[ -ge ]`;
# a non-numeric value would either corrupt the config or make the wait loop
# never terminate (review P2).
case "$INTERVAL" in '' | *[!0-9]*) die "--interval must be a whole number of seconds" ;; esac
case "$WAIT_TIMEOUT" in '' | *[!0-9]*) die "--timeout must be a whole number of seconds" ;; esac
[ "$INTERVAL" -ge 1 ] || die "--interval must be >= 1"
[ "$WAIT_TIMEOUT" -ge 5 ] || die "--timeout must be >= 5"

RUN=0
[ "${ALLOW_GAME_DAY:-0}" = 1 ] && RUN=1

command -v docker >/dev/null 2>&1 || die "docker is required"

teardown_drill() {
	[ "$KEEP" = 1 ] && return 0
	# --keep is honoured by `cleanup` at exit; between drills the names must be
	# freed or the next `docker run --name` fails (the first local run hit this).
	# -v: the postgres/nginx images declare VOLUME, and the throwaway target must
	# not leave an anonymous data volume (with the drill database in it) behind.
	docker rm -fv "gd-monitor-$STAMP-$$" "gd-target-$STAMP-$$" >/dev/null 2>&1 || true
}

cleanup() {
	[ "$KEEP" = 1 ] && {
		say "[game-day] --keep: leaving containers/network ($NET)"
		say "[game-day]   remove them with: docker rm -fv gd-monitor-$STAMP-$$ gd-target-$STAMP-$$ && docker network rm $NET"
		# The rendered config is disposable even when the containers stay.
		[ -n "$TMP" ] && rm -rf "$TMP"
		return 0
	}
	teardown_drill
	docker network rm "$NET" >/dev/null 2>&1 || true
	[ -n "$TMP" ] && rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

mount_path() {
	# Docker on Windows needs a drive-letter path; cygpath is absent on Linux.
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$1"
	else
		printf '%s' "$1"
	fi
}

receipt="${RECEIPT:-${TMPDIR:-/tmp}/game-day-$STAMP.json}"
mkdir -p "$(dirname "$receipt")" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Receipt helpers
# ---------------------------------------------------------------------------
RESULTS=()
record() { # name detected_s recovery_s detail
	RESULTS+=("{\"drill\":\"$1\",\"detected_s\":$2,\"recovered_s\":$3,\"detail\":\"$(json_escape "$4")\"}")
	say "[game-day] RESULT $1: detected=${2}s recovered=${3}s — $4"
}

write_receipt() {
	{
		# One printf with explicit arguments: the previous version ran the
		# substitutions as separate commands after a format string that already
		# consumed its placeholders, which produced unquoted values and an
		# unparseable receipt (caught by the first local run).
		printf '{ "started_at": "%s", "host": "%s", "git_sha": "%s", "dry_run": %s, "drill_selector": "%s", ' \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			"$(json_escape "$(hostname 2>/dev/null || echo unknown)")" \
			"$(json_escape "$(git -C "$(mount_path "$HERE/..")" rev-parse --short HEAD 2>/dev/null || echo unknown)")" \
			"$([ "$RUN" = 1 ] && echo false || echo true)" \
			"$(json_escape "$DRILL")"
		printf '"gatus_image": "%s", "interval_s": %s, "results": [' "$(json_escape "$GATUS_IMAGE")" "$INTERVAL"
		first=1
		for r in "${RESULTS[@]}"; do
			[ $first = 1 ] || printf ', '
			first=0
			printf '%s' "$r"
		done
		printf '] }\n'
	} >"$receipt"
	[ -s "$receipt" ] || die "receipt was not written: $receipt"
	say "[game-day] receipt: $receipt"
}

# ---------------------------------------------------------------------------
# Self-contained drill scaffolding
# ---------------------------------------------------------------------------
render_monitor_config() { # $1 = dir, $2 = endpoint name, $3 = url, $4 = condition
	local dir=$1 name=$2 url=$3 condition=$4
	mkdir -p "$dir"
	# `[STATUS] == 200` is meaningless on a TCP endpoint (there is no HTTP
	# status), so the drill passes the condition that matches the probe type —
	# getting this wrong makes the baseline never healthy, which is exactly the
	# failure the first local run of this script hit.
	cat >"$dir/gatus.yaml" <<EOF
storage:
  type: memory

# Drill config: one endpoint, short interval, thresholds of 1 so a single bad
# poll is the alarm. No alerting block - the drill reads state, and an empty
# BARK_URL would only add a "provider ignored" warning per send.
endpoints:
  - name: $name
    group: game-day
    url: '$url'
    interval: ${INTERVAL}s
    client:
      timeout: 3s
    conditions:
      - '$condition'
EOF
}

start_monitor() { # $1 = config dir
	docker run -d --name "gd-monitor-$STAMP-$$" --network "$NET" \
		-p "127.0.0.1:$MONITOR_PORT:8080" \
		-e GATUS_CONFIG_PATH=/config -e GATUS_LOG_LEVEL=INFO \
		-v "$(mount_path "$1"):/config:ro" "$GATUS_IMAGE" >/dev/null ||
		die "could not start the Gatus monitor"
	# The config dir has to carry a real file, not an empty mount, or Gatus exits
	# on boot and every await below times out.
	local i
	for i in $(seq 1 30); do
		[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MONITOR_PORT/health" 2>/dev/null)" = 200 ] && return 0
		sleep 1
	done
	die "Gatus monitor did not become healthy on 127.0.0.1:$MONITOR_PORT"
}

# Waits until the endpoint reports the requested health. Gatus exposes the same
# JSON the UI uses; a container that reports nothing yet counts as "not ready".
await_state() { # $1 = endpoint name, $2 = healthy|unhealthy, $3 = timeout s -> echoes elapsed s or 124
	local name=$1 want=$2 budget=$3 start now body latest
	start=$(date +%s)
	while :; do
		body=$(curl -s --max-time 3 "http://127.0.0.1:$MONITOR_PORT/api/v1/endpoints/statuses" 2>/dev/null || true)
		now=$(date +%s)
		if [ -n "$body" ]; then
			# One endpoint per drill config; `results` is ordered oldest → newest
			# (verified against gatus v5.38.0), so the LAST success flag is current.
			latest=$(printf '%s' "$body" | grep -o '"success":\(true\|false\)' | tail -n 1)
			case "$want:$latest" in
				healthy:'"success":true' | unhealthy:'"success":false') echo $((now - start)); return 0 ;;
			esac
		fi
		[ $((now - start)) -ge "$budget" ] && { echo $((now - start)); return 124; }
		sleep 1
	done
}

ensure_network() { docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null; }

# ---------------------------------------------------------------------------
# Drill: pg — a throwaway PostgreSQL loses its listener and comes back
# ---------------------------------------------------------------------------
drill_pg() {
	say ''
	say '[game-day] drill=pg — target: disposable postgres:18, monitor: tcp accept on 5432'
	if [ "$RUN" != 1 ]; then
		say '  (dry-run) start postgres:18 + gatus on a scratch network, then:'
		say '    docker stop  target   → expect TRIGGERED on pg-tcp'
		say '    docker start target   → expect RESOLVED'
		say '  run with ALLOW_GAME_DAY=1 to execute'
		return 0
	fi
	ensure_network
	teardown_drill
	TMP=$(mktemp -d)
	render_monitor_config "$TMP" pg-tcp "tcp://gd-target-$STAMP-$$:5432" '[CONNECTED] == true'
	docker run -d --name "gd-target-$STAMP-$$" --network "$NET" -e POSTGRES_PASSWORD=drill "$PG_IMAGE" >/dev/null || {
		record pg -1 -1 "could not start the pg target"
		return 1
	}
	start_monitor "$TMP"
	local healthy_s
	healthy_s=$(await_state pg-tcp healthy "$WAIT_TIMEOUT") || {
		say "[game-day] pg: target never became healthy (waited ${healthy_s}s)"
		record pg -1 -1 "baseline never healthy"
		return 1
	}
	say "[game-day] pg: baseline healthy after ${healthy_s}s"

	docker stop "gd-target-$STAMP-$$" >/dev/null
	local detected
	detected=$(await_state pg-tcp unhealthy "$WAIT_TIMEOUT")
	local det_rc=$?
	docker start "gd-target-$STAMP-$$" >/dev/null
	local recovered
	recovered=$(await_state pg-tcp healthy "$WAIT_TIMEOUT")
	local rec_rc=$?
	if [ "$det_rc" = 0 ] && [ "$rec_rc" = 0 ]; then
		record pg "$detected" "$recovered" "stopped the PG listener; state came back"
	else
		# A drill that was not detected is a FAILED drill: the alert never fired,
		# which is exactly the outcome this script exists to catch. Recording it
		# and returning 0 would let `--drill all` (and any CI/cron caller) pass.
		record pg "$detected" "$recovered" "FAIL: detect_rc=$det_rc recover_rc=$rec_rc"
		teardown_drill
		return 1
	fi
	docker logs "gd-monitor-$STAMP-$$" 2>&1 | grep -E "pg-tcp" | tail -n 6 | sed 's/^/[game-day]   log: /' || true
	teardown_drill
}

# ---------------------------------------------------------------------------
# Drill: container — one HTTP container is killed and restarted
# ---------------------------------------------------------------------------
drill_container() {
	say ''
	say '[game-day] drill=container — target: disposable nginx, monitor: HTTP 200'
	if [ "$RUN" != 1 ]; then
		say '  (dry-run) start nginx:alpine + gatus on a scratch network, then:'
		say '    docker kill target    → expect TRIGGERED on the HTTP endpoint'
		say '    docker start target   → expect RESOLVED'
		say '  run with ALLOW_GAME_DAY=1 to execute'
		return 0
	fi
	ensure_network
	teardown_drill
	TMP=${TMP:-$(mktemp -d)}
	render_monitor_config "$TMP" drill-http "http://gd-target-$STAMP-$$/" '[STATUS] == 200'
	docker run -d --name "gd-target-$STAMP-$$" --network "$NET" "$APP_IMAGE_FOR_HTTP" >/dev/null || {
		record container -1 -1 "could not start the http target"
		return 1
	}
	start_monitor "$TMP"
	local healthy_s
	healthy_s=$(await_state drill-http healthy "$WAIT_TIMEOUT") || {
		say "[game-day] container: target never became healthy (waited ${healthy_s}s)"
		record container -1 -1 "baseline never healthy"
		return 1
	}
	say "[game-day] container: baseline healthy after ${healthy_s}s"

	docker kill "gd-target-$STAMP-$$" >/dev/null
	local detected
	detected=$(await_state drill-http unhealthy "$WAIT_TIMEOUT")
	local det_rc=$?
	docker start "gd-target-$STAMP-$$" >/dev/null
	local recovered
	recovered=$(await_state drill-http healthy "$WAIT_TIMEOUT")
	local rec_rc=$?
	if [ "$det_rc" = 0 ] && [ "$rec_rc" = 0 ]; then
		record container "$detected" "$recovered" "killed and restarted an HTTP container"
	else
		record container "$detected" "$recovered" "FAIL: detect_rc=$det_rc recover_rc=$rec_rc"
		teardown_drill
		return 1
	fi
	docker logs "gd-monitor-$STAMP-$$" 2>&1 | grep -E "drill-http" | tail -n 6 | sed 's/^/[game-day]   log: /' || true
	teardown_drill
}

# ---------------------------------------------------------------------------
# Drill: drain — box only (systemd). Dry-run everywhere.
# ---------------------------------------------------------------------------
drill_drain() {
	say ''
	say '[game-day] drill=drain — box only (systemd timer). Never executed by this script.'
	say '  1) stop the tick:      sudo systemctl stop web-lair-drain.timer'
	say '  2) expected (in-box):  Gatus jobs-drain external endpoint goes TRIGGERED after 30m'
	say '                         — requires the drain→Gatus POST wiring (README §8); today the'
	say '                         signal is the Kuma/healthchecks drain check instead'
	say '  3) expected (external): the healthchecks drain check turns late (grace), then emails'
	say '  4) recover:            sudo systemctl start web-lair-drain.timer; wait one tick'
	say '  5) record:              detection = first alert timestamp − stop timestamp;'
	say '                         recovery = RESOLVED timestamp − start timestamp'
}

# ---------------------------------------------------------------------------
# Drill: disk — needs a real (or tmpfs) mount at 85%. Dry-run everywhere.
# ---------------------------------------------------------------------------
drill_disk() {
	say ''
	say '[game-day] drill=disk — writes to a real mount. Never executed by this script.'
	say '  Safe variant (tmpfs, no data at risk):'
	say '    sudo mount -t tmpfs -o size=10m tmpfs /mnt/gd-disk'
	say '    DATA_DIR=/mnt/gd-disk docker ... (run system.resources with the fixture mount)'
	say '    dd if=/dev/zero of=/mnt/gd-disk/fill bs=1M count=9   # ~90% > 85% warn'
	say '  Expected: system.disk_high in the outbox (ops group) + HEALTHCHECKS_RESOURCES_URL /fail'
	say '  Recover:  rm /mnt/gd-disk/fill  → usage ≤75% clears the latch (no ALERT RESOLVED mail,'
	say '            the clear is recorded in the run summary); healthchecks goes back to green'
	say '  Record:   detection = first outbox row created_at − fill time;'
	say '            recovery  = first successful run with disk under the clear line'
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
say "[game-day] selector=$DRILL run=$RUN receipt=$receipt"
[ "$RUN" = 1 ] || say '[game-day] dry-run (set ALLOW_GAME_DAY=1 to execute the self-contained drills)'

failed=0
case "$DRILL" in
	pg) drill_pg || failed=1 ;;
	container) drill_container || failed=1 ;;
	drain) drill_drain ;;
	disk) drill_disk ;;
	all)
		drill_pg || failed=1
		drill_container || failed=1
		drill_drain
		drill_disk
		;;
esac

write_receipt
[ "$failed" = 0 ] || exit 1
