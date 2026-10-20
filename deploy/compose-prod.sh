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

exec docker compose \
	--project-directory "$APP_DIR" \
	-f "$APP_DIR/compose.yaml" \
	-f "$APP_DIR/compose.prod.yaml" \
	"$@"
