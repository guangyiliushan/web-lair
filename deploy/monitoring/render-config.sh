#!/usr/bin/env bash
# Render the Gatus config directory: core gatus.yaml (with the always-on Bark
# config) plus the optional zz-domain / zz-drain / zz-app-ready fragments.
# The output directory is the one GATUS_CONFIG_PATH points at; only gatus.yaml
# and zz-*.yaml are touched, never other files.
# Usage: bash deploy/monitoring/render-config.sh <out-dir>
# Inputs (all optional; empty = the matching fragment is not rendered):
#   SITE_DOMAIN           site domain                  → zz-domain.yaml
#   DRAIN_HEARTBEAT_TOKEN drain heartbeat Bearer token → zz-drain.yaml
#   READY_TOKEN           /api/ready Bearer token      → zz-app-ready.yaml
#   BARK_URL              checked here, rendered in gatus.yaml (always on)
# **Content-idempotent**: write a file only when its content changed, keeping
# the mtime stable — Gatus polls the config directory mtime every 30s and any
# write wipes the monitoring history plus the "alert already fired" state
# (repeated alerts, no RESOLVED). This script runs on every up/create and
# possibly from parallel sessions, so it must never touch the disk when
# nothing changed.
# deploy/compose-prod.sh calls this script only before up/create; local
# validation uses deploy/monitoring/verify-config.sh (renders into a temp
# directory itself).
set -euo pipefail

# Deterministic permissions: under `umask 000` (service managers, some CI) the
# rendered config would otherwise be world-writable, letting any local user
# retarget the alerting or add internal probes. 022 keeps the
# directory readable by the Gatus container without write access.
umask 022

usage() {
	echo "usage: bash $0 <out-dir>" >&2
	exit 2
}

[ $# -eq 1 ] && [ -n "${1:-}" ] || usage

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OUT=$1

install_if_changed() {
	# $1 = source, $2 = destination, $3 = label
	if [ -f "$2" ] && cmp -s "$1" "$2"; then
		printf '[render-config] = %s (unchanged)\n' "$3"
	else
		# Atomic replace: Gatus watches this directory and reloads within ~30s.
		# `cp` in place truncates the target first, so a reload landing mid-copy
		# would read a half file and (with restart: always) crash-loop.
		local tmp
		tmp=$(mktemp "$2.tmp.XXXXXX")
		cp "$1" "$tmp"
		mv "$tmp" "$2"
		printf '[render-config] + %s\n' "$3"
	fi
}

fail() {
	printf '[render-config] %s\n' "$*" >&2
	exit 1
}

# The value lands in a single-quoted YAML scalar and is expanded by Gatus'
# os.ExpandEnv, so the charset must be narrow: whitespace/quotes/backslash/
# newline/`$` can all change the structure or trigger an unexpected expansion.
validate_token() {
	case "$1" in
	*[!A-Za-z0-9._~+/=-]*) fail "$2 must be a token of [A-Za-z0-9._~+/=-] (got invalid characters)" ;;
	esac
	# The drain token can forge a heartbeat and suppress the alarm; a short one
	# is guessable.
	if [ "${#1}" -lt 16 ]; then
		fail "$2 must be at least 16 characters (use 'openssl rand -hex 32')"
	fi
}

validate_domain() {
	case "$1" in
	*[!A-Za-z0-9.-]*) fail "SITE_DOMAIN must be a plain hostname (A-Z a-z 0-9 . -)" ;;
	.* | *. | *..*) fail "SITE_DOMAIN is not a valid hostname: $1" ;;
	esac
}

# BARK_URL lands in a single-quoted YAML scalar (Gatus runs os.ExpandEnv
# before parsing), so:
# - only https is accepted (the device key is in the path; http is cleartext);
# - whitespace/quotes/backslash/$ are rejected (they escape the scalar or
#   trigger an unexpected expansion).
# The local mock uses http, so it must set BARK_ALLOW_INSECURE=1 explicitly
# (allowed only in mock scripts).
validate_bark_url() {
	local lower
	lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
	case "$lower" in
	https://*) ;;
	http://*)
		[ "${BARK_ALLOW_INSECURE:-}" = 1 ] ||
			fail 'BARK_URL must be https:// (BARK_ALLOW_INSECURE=1 is for the local mock only)'
		;;
	*) fail 'BARK_URL must start with https://' ;;
	esac
	if printf '%s' "$1" | grep -qE "[[:space:]'\"\$\\\\]"; then
		fail 'BARK_URL contains whitespace/quote/backslash characters that would corrupt the Gatus YAML scalar'
	fi
	# A malformed percent escape makes http.NewRequest fail; Gatus' custom
	# provider then dereferences a nil request and panics on the next alert.
	# Count valid escapes against all '%' occurrences.
	local all valid
	all=$(printf '%s' "$1" | tr -cd '%' | wc -c | tr -d ' ')
	valid=$(printf '%s' "$1" | { grep -oE '%[0-9A-Fa-f]{2}' || true; } | wc -l | tr -d ' ')
	if [ "$all" != "$valid" ]; then
		fail 'BARK_URL contains a malformed percent escape (only %HH is allowed)'
	fi
}

# Validate every input before touching the output directory: on failure the
# disk keeps the previous round's consistent state (otherwise Gatus hot-loads
# a half-updated "new core + old fragments" directory 30s later).
SITE_DOMAIN_VALUE=${SITE_DOMAIN:-}
DRAIN_TOKEN_VALUE=${DRAIN_HEARTBEAT_TOKEN:-}
BARK_URL_VALUE=${BARK_URL:-}
READY_TOKEN_VALUE=${READY_TOKEN:-}

if [ -n "$SITE_DOMAIN_VALUE" ]; then
	# Allow a trailing FQDN dot (example.com. is a valid hostname, common in
	# dig output); strip one before validating.
	validate_domain "${SITE_DOMAIN_VALUE%.}"
fi
[ -n "$DRAIN_TOKEN_VALUE" ] && validate_token "$DRAIN_TOKEN_VALUE" DRAIN_HEARTBEAT_TOKEN
[ -n "$READY_TOKEN_VALUE" ] && validate_token "$READY_TOKEN_VALUE" READY_TOKEN
[ -n "$BARK_URL_VALUE" ] && validate_bark_url "$BARK_URL_VALUE"

mkdir -p "$OUT"

# Gatus' hot reload only compares the mtime of **existing files** (deleting
# one does not trigger it), so when a fragment is revoked the core file has
# to be touched so a running instance notices "some endpoint disappeared".
CHANGED=0

# Upgrade cleanup: the old layout kept Bark in a fragment; after it merged
# into gatus.yaml a leftover zz-bark.yaml would collide with the main file's
# alerting.custom (duplicate primitive definition → parse failure).
if [ -e "$OUT/zz-bark.yaml" ]; then
	rm -f "$OUT/zz-bark.yaml"
	CHANGED=1
fi

install_if_changed "$HERE/gatus.yaml" "$OUT/gatus.yaml" 'core: gatus.yaml'

if [ -n "$SITE_DOMAIN_VALUE" ]; then
	install_if_changed "$HERE/fragments/domain.yaml" "$OUT/zz-domain.yaml" 'zz-domain.yaml (SITE_DOMAIN set)'
else
	if [ -e "$OUT/zz-domain.yaml" ]; then
		rm -f "$OUT/zz-domain.yaml"
		CHANGED=1
	fi
	printf '[render-config] - domain: SITE_DOMAIN unset, TLS/domain checks skipped\n'
fi

if [ -n "$DRAIN_TOKEN_VALUE" ]; then
	install_if_changed "$HERE/fragments/drain.yaml" "$OUT/zz-drain.yaml" 'zz-drain.yaml (drain heartbeat enabled)'
else
	if [ -e "$OUT/zz-drain.yaml" ]; then
		rm -f "$OUT/zz-drain.yaml"
		CHANGED=1
	fi
	printf '[render-config] - drain: DRAIN_HEARTBEAT_TOKEN unset, heartbeat endpoint skipped\n'
fi

# /api/ready: that endpoint only answers when READY_TOKEN is present (in
# production, no token → 404 for everyone; Gatus is not on loopback inside the
# compose private network). Enabling it unconditionally would stay permanently
# red, so render it based on whether the token is configured — the same rule
# as domain/drain.
if [ -n "$READY_TOKEN_VALUE" ]; then
	install_if_changed "$HERE/fragments/app-ready.yaml" "$OUT/zz-app-ready.yaml" 'zz-app-ready.yaml (ready probe enabled)'
else
	if [ -e "$OUT/zz-app-ready.yaml" ]; then
		rm -f "$OUT/zz-app-ready.yaml"
		CHANGED=1
	fi
	printf '[render-config] - ready: READY_TOKEN unset, /api/ready monitor skipped\n'
fi

if [ "$CHANGED" = 1 ] && [ -f "$OUT/gatus.yaml" ]; then
	touch "$OUT/gatus.yaml"
	printf '[render-config] ~ touched gatus.yaml so Gatus notices the removed fragment(s)\n'
fi

if [ -z "$BARK_URL_VALUE" ]; then
	printf '[render-config] - bark: BARK_URL unset, alerts are log-only (provider ignored by Gatus)\n'
fi
