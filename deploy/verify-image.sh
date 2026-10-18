#!/usr/bin/env bash
# Runtime-image smoke gate (F-2).
#
# The image ships `jobs/` + `src/` and runs drain with Node's type stripping.
# A syntax feature Vite accepts but the stripper rejects would only fail in
# production, so every release proves the graph loads: without DATABASE_URL
# the entry must exit 2 at its configuration guard.
#
# Usage: deploy/verify-image.sh <image>
set -euo pipefail

IMAGE="${1:?usage: deploy/verify-image.sh <image>}"
[ -n "$IMAGE" ] || { echo "image tag is empty" >&2; exit 1; }

echo "-> drain entry in $IMAGE"
set +e
out="$(docker run --rm --entrypoint node "$IMAGE" jobs/drain.ts 2>&1)"
status=$?
set -e

if [ "$status" -ne 2 ]; then
	echo "FAIL: expected exit 2 (DATABASE_URL missing), got $status" >&2
	printf '%s\n' "$out" >&2
	exit 1
fi

case "$out" in
	*"DATABASE_URL is not set"*) ;;
	*)
		echo "FAIL: drain did not reach the configuration guard:" >&2
		printf '%s\n' "$out" >&2
		exit 1
		;;
esac

echo "OK: drain graph loads and stops on configuration"

# The entry only loads its static imports; builtin jobs are imported lazily by
# the loader on the first tick. Load every registered builtin here so an
# unsupported-syntax regression fails at release time, not at 03:00.
echo "-> builtin job modules"
set +e
out="$(timeout 60 docker run --rm --entrypoint node "$IMAGE" --input-type=module -e "
const { createBuiltinLoader } = await import('./src/lib/server/jobs/loader.ts');
const { JOBS } = await import('./src/lib/server/jobs/registry.ts');
const load = createBuiltinLoader();
for (const name of Object.keys(JOBS)) await load(name);
console.log('builtins ok: ' + Object.keys(JOBS).length);
" 2>&1)"
status=$?
set -e
if [ "$status" -ne 0 ] || ! printf '%s' "$out" | grep -qE "builtins ok: [1-9][0-9]*"; then
	echo "FAIL: builtin job graph did not load" >&2
	printf '%s\n' "$out" >&2
	exit 1
fi

echo "OK: all builtin job modules load"

# Release gate for the app itself: the image must start with production deps
# (a build-server import missing from dependencies only fails here).
echo "-> server startup"
app="web-lair-verify-$$"
cleanup() { docker rm -f "$app" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$app" \
	-e ORIGIN=http://localhost -e PORT=3000 -e HOST=0.0.0.0 \
	-e DATABASE_URL='postgres://x:***@127.0.0.1:1/x' \
	-e BETTER_AUTH_SECRET='0123456789abcdef0123456789abcdef' \
	-e SUPPRESSION_HMAC_KEY='BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' \
	-p 127.0.0.1::3000 "$IMAGE" >/dev/null
port="$(docker port "$app" 3000/tcp | head -n1 | sed 's/.*://')"
code=""
for _ in $(seq 1 30); do
	code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/health" || true)"
	[ "$code" = 200 ] && break
	sleep 1
done
if [ "$code" != 200 ]; then
	echo "FAIL: server did not answer /api/health (last: $code)" >&2
	docker logs "$app" >&2 || true
	exit 1
fi
echo "OK: server starts and /api/health answers"
