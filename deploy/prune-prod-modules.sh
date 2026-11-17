#!/usr/bin/env bash
# Apply the curated prune manifest to a production dependency tree. Runs
# INSIDE the image build's prod-deps stage; it only ever deletes under the
# given root (default /app), never in the repository.
#
# Usage: deploy/prune-prod-modules.sh <manifest> [root=/app]
#
# Failure semantics:
#   - a manifest pattern that matches nothing is REPORTED, not failed: the
#     lockfile may already have dropped the package, and a hard failure there
#     would block every rebuild for a stale line. (`prune: no match` in the log
#     is the signal to delete the line.)
#   - a REQUIRED runtime package that disappeared is a hard failure: that is a
#     prune mistake or a dependency-tree drift, and it must stop the build
#     before the image is tagged.
set -euo pipefail

MANIFEST="${1:?usage: prune-prod-modules.sh <manifest> [root]}"
ROOT="${2:-/app}"

cd "$ROOT"

# Packages the runtime provably imports (all direct dependencies, so pnpm's
# strict layout exposes them at the top level). If one of these is missing after
# a prune, the image would fail at boot on a path `verify-image.sh` may not
# reach (e.g. a lazily imported module), so the build stops here instead.
REQUIRED=(
	node_modules/@inlang/paraglide-js
	node_modules/drizzle-orm
	node_modules/postgres
	node_modules/sharp
)

shopt -s nullglob
removed=0
freed_kib=0
while IFS= read -r raw || [ -n "$raw" ]; do
	line="${raw%%#*}"
	line="$(printf '%s' "$line" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
	[ -n "$line" ] || continue
	matches=( $line )
	if [ "${#matches[@]}" -eq 0 ]; then
		echo "prune: no match (already absent): $line"
		continue
	fi
	for match in "${matches[@]}"; do
		[ -e "$match" ] || continue
		kib="$(du -sk "$match" | cut -f1)"
		echo "prune: $match (${kib} KiB)"
		rm -rf -- "$match"
		removed=$((removed + 1))
		freed_kib=$((freed_kib + kib))
	done
done <"$MANIFEST"

echo "prune: removed ${removed} path(s), ${freed_kib} KiB (manifest: $(basename "$MANIFEST"))"

missing=0
for required in "${REQUIRED[@]}"; do
	if [ ! -e "$required" ]; then
		echo "FAIL: required runtime package is gone: $required" >&2
		missing=1
	fi
done
[ "$missing" -eq 0 ] || exit 1
echo "prune: required runtime packages present (${#REQUIRED[@]})"

# The built server imports exactly one paraglide path:
#   import '@inlang/paraglide-js/urlpattern-polyfill'
# (grep `@inlang/paraglide-js` in build/server). Resolve it the way Node will
# at runtime instead of trusting a path guess - `urlpattern-polyfill` itself is
# transitive, so only the package's own exports map knows where it lives.
if ! node --input-type=module -e "await import('@inlang/paraglide-js/urlpattern-polyfill')"; then
	echo "FAIL: '@inlang/paraglide-js/urlpattern-polyfill' does not resolve after pruning" >&2
	exit 1
fi
echo "prune: paraglide runtime subpath resolves"

echo "prune: node_modules now $(du -sh node_modules | cut -f1)"
