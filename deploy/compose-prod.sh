#!/usr/bin/env bash
# Production Compose entry point.
# Always loads compose.yaml + compose.prod.yaml; never compose.override.yaml.
#
# Why a wrapper: compose.override.yaml is auto-loaded by any bare
# `docker compose` call, so production commands must pass an explicit -f list.
# Keeping that list here means the RUNBOOK, systemd and backup script cannot
# drift apart.
set -euo pipefail

APP_DIR=${APP_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}

# Native Docker on Windows (Git Bash/MSYS) needs a drive-letter path; cygpath
# is absent on Linux, where the POSIX path is already correct.
if command -v cygpath >/dev/null 2>&1; then
	APP_DIR=$(cygpath -m "$APP_DIR")
fi

# F-12 / RUNBOOK §8: the app fails closed at boot when this key is missing or
# malformed (suppression hashes must never be written unkeyed). Fail here with
# an actionable message instead of letting the container crash-loop.
require_env_file() {
	if [ ! -f "$APP_DIR/.env" ]; then
		echo "[compose-prod] $APP_DIR/.env is missing; create it from .env.example (RUNBOOK §1)" >&2
		exit 1
	fi
}

env_value() {
	local raw
	raw=$(sed -n "s/^$1=//p" "$APP_DIR/.env" | tail -n 1 | tr -d '\r')
	# Remove at most one matching outer quote pair, the way compose's env_file
	# parser does. Deleting every quote (as an earlier version did) validates a
	# different string than compose uses: `p'ass` would be checked as `pass`.
	case "$raw" in
		\"*\") raw=${raw#\"}; raw=${raw%\"} ;;
		\'*\') raw=${raw#\'}; raw=${raw%\'} ;;
	esac
	printf '%s' "$raw"
}

require_suppression_key() {
	local value
	value=$(env_value SUPPRESSION_HMAC_KEY)
	if [ -z "$value" ]; then
		echo "[compose-prod] SUPPRESSION_HMAC_KEY is missing in $APP_DIR/.env; generate one with 'openssl rand -base64 32' (RUNBOOK §8)" >&2
		exit 1
	fi
	if [ "$(printf '%s' "$value" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" != "32" ]; then
		echo "[compose-prod] SUPPRESSION_HMAC_KEY is not 32 base64-encoded bytes (RUNBOOK §8)" >&2
		exit 1
	fi
}

# P0-1 / RUNBOOK §1.1: compose.prod.yaml builds DATABASE_URL from
# ${POSTGRES_PASSWORD} at parse time. A missing or non-URL-safe value produces
# an unparseable DSN and an opaque auth failure inside the app, so refuse to
# start instead of shipping the mistake to the container.
# Allowed set = RFC 3986 unreserved characters plus `+` and `=`: those are legal
# unencoded in URL userinfo and appear in base64-generated passwords, and `/`,
# `@`, `:`, `?` and `#` genuinely break the DSN. Quotes are rejected too: an
# interior quote survives env_file parsing and would land in the URL.
require_postgres_password() {
	local value
	value=$(env_value POSTGRES_PASSWORD)
	if [ -z "$value" ]; then
		echo "[compose-prod] POSTGRES_PASSWORD is missing in $APP_DIR/.env; the app DSN is built from it (RUNBOOK §1.1)" >&2
		exit 1
	fi
	case "$value" in
	*[!A-Za-z0-9._~+=-]*)
		echo "[compose-prod] POSTGRES_PASSWORD contains characters that are not URL-safe (allowed: A-Z a-z 0-9 . _ ~ + = -); generate one with 'openssl rand -hex 32' (RUNBOOK §1.1)" >&2
		exit 1
		;;
	esac
}

# The guards above must run whatever the command shape is: `up`, but also a
# command preceded by global flags (`--profile x up`, `-p name up`) or `create`.
# Scan the whole argument list instead of trusting $1.
need_guards=0
for arg in "$@"; do
	case "$arg" in
		up | start | restart | run | create) need_guards=1 ;;
	esac
done
if [ "$need_guards" = 1 ]; then
	require_env_file
	require_suppression_key
	require_postgres_password
fi

exec docker compose \
	--project-directory "$APP_DIR" \
	-f "$APP_DIR/compose.yaml" \
	-f "$APP_DIR/compose.prod.yaml" \
	"$@"
