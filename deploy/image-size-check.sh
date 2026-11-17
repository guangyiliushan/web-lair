#!/usr/bin/env bash
# Image size gate: the image must not grow more than `regression_ratio` over the
# recorded baseline, so a dependency that quietly ships a 400 MB CLI chain fails
# the PR instead of the deploy.
# The metric is `docker image inspect .Size` (compressed). The baseline's
# `app_tree` figures come from `du -sb /app` (uncompressed, ~2.5x larger) and
# are documentation only — one rule per metric, never compare the two; see the
# `calibration` note in `deploy/image-size-baseline.json`.
# Usage: deploy/image-size-check.sh <image> [baseline.json]
set -euo pipefail

IMAGE="${1:?usage: deploy/image-size-check.sh <image> [baseline.json]}"
BASELINE="${2:-$(dirname "$0")/image-size-baseline.json}"

[ -f "$BASELINE" ] || { echo "FAIL: baseline file not found: $BASELINE" >&2; exit 1; }

SIZE="$(docker image inspect --format '{{.Size}}' "$IMAGE")" || {
	echo "FAIL: could not read the size of $IMAGE (docker image inspect failed)" >&2
	exit 1
}
[ -n "$SIZE" ] || { echo "FAIL: docker reported an empty size for $IMAGE" >&2; exit 1; }

read -r BASE RATIO < <(node -e '
const fs = require("node:fs");
const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const num = (v, name) => {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
		console.error(`FAIL: baseline ${name} must be a positive number`);
		process.exit(1);
	}
	return v;
};
console.log([num(b.bytes, "bytes"), num(b.regression_ratio, "regression_ratio")].join(" "));
' "$BASELINE") || { echo "FAIL: could not parse $BASELINE" >&2; exit 1; }
[ -n "${BASE:-}" ] || { echo "FAIL: baseline parse produced no values" >&2; exit 1; }

mb() { awk -v b="$1" 'BEGIN { printf "%.0f", b / 1000000 }'; }
pct() { awk -v n="$1" -v d="$2" 'BEGIN { printf "%+.1f", (n / d - 1) * 100 }'; }

LIMIT="$(awk -v b="$BASE" -v r="$RATIO" 'BEGIN { printf "%d", b * (1 + r) }')"

echo "image:      $IMAGE"
echo "size:       ${SIZE} bytes ($(mb "$SIZE") MB)"
echo "baseline:   ${BASE} bytes ($(mb "$BASE") MB), delta $(pct "$SIZE" "$BASE")%"
echo "regression: ${LIMIT} bytes (baseline x $(awk -v r="$RATIO" 'BEGIN { printf "%.2f", 1 + r }'))"

fail=0
if [ "$SIZE" -gt "$LIMIT" ]; then
	echo "FAIL: image grew $(pct "$SIZE" "$BASE")% over baseline (limit $(awk -v r="$RATIO" 'BEGIN { printf "%.0f", r * 100 }')%)" >&2
	fail=1
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo "## Image size gate"
		echo ""
		echo "| | bytes | MB |"
		echo "|---|---:|---:|"
		echo "| image \`$IMAGE\` | $SIZE | $(mb "$SIZE") |"
		echo "| baseline | $BASE | $(mb "$BASE") |"
		echo "| regression limit (+$(awk -v r="$RATIO" 'BEGIN { printf "%.0f", r * 100 }')%) | $LIMIT | $(mb "$LIMIT") |"
		echo ""
		if [ "$fail" -ne 0 ]; then echo "**result: FAIL**"; else echo "**result: PASS**"; fi
	} >>"$GITHUB_STEP_SUMMARY"
fi

[ "$fail" -eq 0 ] && echo "OK: image size within the regression budget"
exit "$fail"
