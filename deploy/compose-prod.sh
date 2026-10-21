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
require_suppression_key() {
	local env_file="$APP_DIR/.env"
	if [ ! -f "$env_file" ]; then
		echo "[compose-prod] $env_file is missing; create it from .env.example (RUNBOOK §1)" >&2
		exit 1
	fi
	local value
	value=$(sed -n 's/^SUPPRESSION_HMAC_KEY=//p' "$env_file" | tail -n 1 | tr -d '\r' | tr -d '"' | tr -d "'")
	if [ -z "$value" ]; then
		echo "[compose-prod] SUPPRESSION_HMAC_KEY is missing in $env_file; generate one with 'openssl rand -base64 32' (RUNBOOK §8)" >&2
		exit 1
	fi
	if [ "$(printf '%s' "$value" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" != "32" ]; then
		echo "[compose-prod] SUPPRESSION_HMAC_KEY is not 32 base64-encoded bytes (RUNBOOK §8)" >&2
		exit 1
	fi
}

case "${1:-}" in
	up | start | restart | run) require_suppression_key ;;
esac

exec docker compose \
	--project-directory "$APP_DIR" \
	-f "$APP_DIR/compose.yaml" \
	-f "$APP_DIR/compose.prod.yaml" \
	"$@"
