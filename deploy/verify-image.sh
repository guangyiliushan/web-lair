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
