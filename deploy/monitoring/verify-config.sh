#!/usr/bin/env bash
# Gatus config startup validation (can be called directly from CI).
#
# Usage:
#   bash deploy/monitoring/verify-config.sh
#   GATUS_VERIFY_PORT=18081 bash deploy/monitoring/verify-config.sh
#   GATUS_IMAGE=ghcr.io/twin/gatus:<tag> bash ...   # defaults to compose.monitoring.yaml
#
# Starts a temporary container (port 127.0.0.1:$GATUS_VERIFY_PORT) against five
# scenarios — core config, full config, two negative cases, and the hardened
# production flags — each of which can really fail; the five assertions are
# listed in deploy/monitoring/README.md "6. 校验（T3.5，供 P1 的 CI 接入）".
# On failure the container log is printed. Any failed assertion → exit 1.
# Under the heavy-task discipline it runs serially through
# notes/coordination/m6/scripts/heavy.sh like build/check/vitest.
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Single source of truth: the image tag lives only in compose.monitoring.yaml;
# GATUS_IMAGE overrides it explicitly.
IMAGE=${GATUS_IMAGE:-$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$HERE/compose.monitoring.yaml" | head -n 1)}
PORT=${GATUS_VERIFY_PORT:-18081}
NAME="gatus-verify-$$"
FAILED=0
CONTAINER=
BAD_CONTAINER=
BAD2_CONTAINER=

say() { printf '%s\n' "$*"; }
fail() {
	say "FAIL: $*"
	FAILED=1
}

for bin in docker curl; do
	command -v "$bin" >/dev/null 2>&1 || {
		say "FAIL: $bin not found"
		exit 1
	}
done
[ -n "$IMAGE" ] || {
	say 'FAIL: could not read image from compose.monitoring.yaml and GATUS_IMAGE is unset'
	exit 1
}

mount_path() {
	# Docker on Windows needs a drive-letter path; cygpath is absent on Linux.
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$1"
	else
		printf '%s' "$1"
	fi
}

TMP=$(mktemp -d)
cleanup() {
	[ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1
	[ -n "$BAD_CONTAINER" ] && docker rm -f "$BAD_CONTAINER" >/dev/null 2>&1
	[ -n "$BAD2_CONTAINER" ] && docker rm -f "$BAD2_CONTAINER" >/dev/null 2>&1
	rm -rf "$TMP"
}
trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

# Target addresses: for parsing only, no connectivity required (a failing
# Gatus check does not affect /health).
export MONITOR_APP_ADDR='127.0.0.1:9'
export MONITOR_PG_ADDR='127.0.0.1:9'
export MONITOR_RUSTFS_ADDR='127.0.0.1:9'
export MONITOR_INTERVAL='1h'
export MONITOR_FAILURE_THRESHOLD='3'
export MONITOR_SUCCESS_THRESHOLD='2'

# Production-equivalent startup flags: the scratch image has no shell, but
# the process itself needs no writable root filesystem or capability; config
# is read-only and storage=memory. Running this once proves the hardening
# does not block startup.
HARDEN=(--read-only --cap-drop ALL --tmpfs /tmp)

docker_run_detached() {
	# $1 = container name, $2 = config dir; rest = extra args
	local name dir
	name=$1
	dir=$2
	shift 2
	docker run -d --name "$name" "${HARDEN[@]}" -e GATUS_CONFIG_PATH=/config \
		-e GATUS_LOG_LEVEL=INFO \
		-e MONITOR_APP_ADDR -e MONITOR_PG_ADDR -e MONITOR_RUSTFS_ADDR \
		-e MONITOR_INTERVAL -e MONITOR_FAILURE_THRESHOLD -e MONITOR_SUCCESS_THRESHOLD \
		-e READY_TOKEN -e BARK_URL -e SITE_DOMAIN -e DRAIN_HEARTBEAT_TOKEN \
		"$@" -v "$(mount_path "$dir"):/config:ro" "$IMAGE"
}

wait_exit_or_health() {
	# $1 = container, $2 = "health" | "exit"; echoes health code or exit code
	local name mode i code
	name=$1
	mode=$2
	for i in $(seq 1 30); do
		if [ "$mode" = health ]; then
			code=$(curl -s -o "$TMP/health.out" -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
			[ "$code" = '200' ] && {
				echo 200
				return 0
			}
			# container died early → stop waiting
			[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != 'true' ] && break
			sleep 1
		else
			[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != 'true' ] && break
			sleep 1
		fi
	done
	if [ "$mode" = health ]; then
		echo "${code:-000}"
	else
		docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo missing
	fi
}

run_config() {
	# $1 = dir, $2 = label, $3 = expected "N endpoints", $4 = expected "M external endpoints"
	# $5 = app-ready expectation: "absent" (not rendered) | "monitored" (rendered)
	local dir mount log_file health expect_ready
	dir=$1
	mount=$(mount_path "$dir")
	log_file="$TMP/$2.log"
	expect_ready=${5:-absent}
	CONTAINER="$NAME-$2"
	docker rm -f "$CONTAINER" >/dev/null 2>&1
	if ! docker_run_detached "$CONTAINER" "$dir" -p "127.0.0.1:$PORT:8080" >"$TMP/$2.run" 2>&1; then
		fail "$2: docker run failed"
		sed -n '1,20p' "$TMP/$2.run"
		CONTAINER=
		return 1
	fi

	health=$(wait_exit_or_health "$CONTAINER" health)
	# Give Gatus' first check round a moment before collecting logs (the
	# app-ready "not monitored" assertion depends on it).
	sleep 2
	docker logs "$CONTAINER" >"$log_file" 2>&1
	if ! docker rm -f "$CONTAINER" >/dev/null 2>&1; then
		say "WARN: could not remove $CONTAINER (cleanup will retry)"
	else
		CONTAINER=
	fi

	if [ "$health" != '200' ]; then
		fail "$2: /health=$health (expected 200)"
		sed -n '1,40p' "$log_file"
		return 1
	fi
	say "PASS: $2 (/health 200)"

	if ! grep -q "Validated $3" "$log_file"; then
		fail "$2: expected 'Validated $3' in log"
		grep -E 'Validated' "$log_file" | sed -n '1,6p'
	else
		say "PASS: $2 (Validated $3)"
	fi
	if ! grep -q "Validated $4" "$log_file"; then
		fail "$2: expected 'Validated $4' in log"
		grep -E 'Validated' "$log_file" | sed -n '1,6p'
	else
		say "PASS: $2 (Validated $4)"
	fi
	if [ "$expect_ready" = monitored ]; then
		if grep -q 'endpoint=app-ready;' "$log_file"; then
			say "PASS: $2 (app-ready monitored: /api/ready covered)"
		else
			fail "$2: app-ready is not monitored although READY_TOKEN is set (P4 probe lost)"
		fi
	elif grep -q 'endpoint=app-ready;' "$log_file"; then
		fail "$2: app-ready is being monitored without READY_TOKEN (would be permanently red)"
	else
		say "PASS: $2 (app-ready absent)"
	fi
	return 0
}

# 1) core config: all fragments off + BARK_URL empty (the production default shape)
unset SITE_DOMAIN DRAIN_HEARTBEAT_TOKEN
export BARK_URL=''
export READY_TOKEN=''
CORE_DIR="$TMP/core"
bash "$HERE/render-config.sh" "$CORE_DIR" >/dev/null || fail 'core: render failed'
run_config "$CORE_DIR" core '6 endpoints' '0 external endpoints' absent || true
if grep -q 'configuredProviders=\[custom\]' "$TMP/core.log" 2>/dev/null; then
	fail 'core: Bark provider was configured with an empty BARK_URL'
elif grep -q 'Ignoring provider=custom due to error=url not set' "$TMP/core.log" 2>/dev/null; then
	say 'PASS: core (empty BARK_URL → provider ignored, alerts log-only)'
else
	fail 'core: expected "Ignoring provider=custom due to error=url not set"'
fi

# 2) full config: both fragments + non-empty BARK_URL (device-key shape,
#    matching README §4). SKIP_FULL=1 is for offline environments (this case
#    makes Gatus perform one real TLS/RDAP request against example.com).
if [ "${SKIP_FULL:-0}" = 1 ]; then
	say 'SKIP: full (SKIP_FULL=1; outbound network not used)'
else
	export BARK_URL='https://127.0.0.1:9/verify-device-key'
	export SITE_DOMAIN='example.com'
	export DRAIN_HEARTBEAT_TOKEN='verify-token-0123456789abcdef'
	export READY_TOKEN='verify-token-0123456789abcdef'
	FULL_DIR="$TMP/full"
	bash "$HERE/render-config.sh" "$FULL_DIR" >/dev/null || fail 'full: render failed'
	run_config "$FULL_DIR" full '9 endpoints' '1 external endpoints' monitored || true
	if grep -q 'configuredProviders=\[custom\]' "$TMP/full.log" 2>/dev/null; then
		say 'PASS: full (custom Bark provider configured)'
	else
		fail 'full: expected configuredProviders=[custom]'
		grep -E 'configuredProviders|Ignoring provider' "$TMP/full.log" | sed -n '1,6p'
	fi
fi

# 3) negative A: an endpoint missing `url` must exit 2 and report the missing url
BAD_DIR="$TMP/bad"
mkdir -p "$BAD_DIR"
printf 'storage:\n  type: memory\nendpoints:\n  - name: broken\n' >"$BAD_DIR/gatus.yaml"
BAD_CONTAINER="$NAME-bad"
docker rm -f "$BAD_CONTAINER" >/dev/null 2>&1
if ! docker_run_detached "$BAD_CONTAINER" "$BAD_DIR" >"/dev/null" 2>&1; then
	fail 'negative: docker run failed'
	BAD_CONTAINER=
else
	BAD_RC=$(wait_exit_or_health "$BAD_CONTAINER" exit)
	BAD_LOG=$(docker logs "$BAD_CONTAINER" 2>&1)
	docker rm -f "$BAD_CONTAINER" >/dev/null 2>&1 && BAD_CONTAINER=
	if [ "$BAD_RC" != '2' ]; then
		fail "negative: expected exit code 2, got $BAD_RC"
		printf '%s' "$BAD_LOG" | sed -n '1,10p'
	elif ! printf '%s' "$BAD_LOG" | grep -q 'you must specify an url'; then
		fail 'negative: exit 2 but without "you must specify an url"'
		printf '%s' "$BAD_LOG" | sed -n '1,10p'
	else
		say 'PASS: negative (exit 2, "you must specify an url")'
	fi
fi

# 4) negative B: drain fragment present but token empty → exit 2 and report the missing token
BAD2_DIR="$TMP/bad-token"
mkdir -p "$BAD2_DIR"
cp "$HERE/gatus.yaml" "$BAD2_DIR/gatus.yaml"
sed 's/${DRAIN_HEARTBEAT_TOKEN}//' "$HERE/fragments/drain.yaml" >"$BAD2_DIR/zz-drain.yaml"
BAD2_CONTAINER="$NAME-badtoken"
docker rm -f "$BAD2_CONTAINER" >/dev/null 2>&1
if ! docker_run_detached "$BAD2_CONTAINER" "$BAD2_DIR" >"/dev/null" 2>&1; then
	fail 'negative-token: docker run failed'
	BAD2_CONTAINER=
else
	BAD2_RC=$(wait_exit_or_health "$BAD2_CONTAINER" exit)
	BAD2_LOG=$(docker logs "$BAD2_CONTAINER" 2>&1)
	docker rm -f "$BAD2_CONTAINER" >/dev/null 2>&1 && BAD2_CONTAINER=
	if [ "$BAD2_RC" != '2' ]; then
		fail "negative-token: expected exit code 2, got $BAD2_RC"
		printf '%s' "$BAD2_LOG" | sed -n '1,10p'
	elif ! printf '%s' "$BAD2_LOG" | grep -q 'must specify a token'; then
		fail 'negative-token: exit 2 but without "must specify a token"'
		printf '%s' "$BAD2_LOG" | sed -n '1,10p'
	else
		say 'PASS: negative-token (exit 2, "must specify a token")'
	fi
fi

if [ "$FAILED" != 0 ]; then
	say 'RESULT: FAILED'
	exit 1
fi
say 'RESULT: all checks passed'
