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
if [ "$status" -ne 0 ] || ! printf '%s' "$out" | grep -q "builtins ok"; then
	echo "FAIL: builtin job graph did not load" >&2
	printf '%s\n' "$out" >&2
	exit 1
fi

echo "OK: all builtin job modules load"
