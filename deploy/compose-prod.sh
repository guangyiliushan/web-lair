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

env_value() { # key [file] — file defaults to .env
	local raw file=${2:-$APP_DIR/.env}
	raw=$(sed -n "s/^$1=//p" "$file" | tail -n 1 | tr -d '\r')
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

# RUNBOOK §1.1: compose.prod.yaml builds DATABASE_URL from
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

# Backrest is part of the production model now. Without its
# credentials the container comes up healthy and then silently never backs
# anything up, so refuse the deploy instead of shipping that. `run` is
# deliberately excluded: the drain timer calls it every minute and must not
# depend on the backup credential file.
require_backup_env() {
	local file="$APP_DIR/deploy/backup.env" key
	if [ ! -f "$file" ]; then
		echo "[compose-prod] $file is missing; copy deploy/backup.env.example, fill it in and chmod 600 (RUNBOOK §4)" >&2
		exit 1
	fi
	for key in POSTGRES_PASSWORD RESTIC_REPOSITORY RESTIC_PASSWORD RESTIC_CONFIG_REPOSITORY RESTIC_CONFIG_PASSWORD DATA_DIR BACKUP_DIR; do
		if [ -z "$(env_value "$key" "$file")" ]; then
			echo "[compose-prod] $key is empty in $file; the scheduled backup would fail every night (RUNBOOK §4)" >&2
			exit 1
		fi
	done
	# The hook runs pg_dump inside the backrest container, so this copy of the db
	# password must equal the one the db service was created with. Rotating only
	# .env makes every night fail the dump gate — and ON_ERROR_CANCEL skips the
	# END hook, so there is no /fail, only a check that goes late.
	if [ "$(env_value POSTGRES_PASSWORD "$file")" != "$(env_value POSTGRES_PASSWORD)" ]; then
		echo "[compose-prod] POSTGRES_PASSWORD differs between $file and $APP_DIR/.env; rotate both together (RUNBOOK §1.1/§4)" >&2
		exit 1
	fi
	# The container bind-mounts .env's DATA_DIR; a relative or empty value would be
	# created as an empty ./data directory and then snapshotted as "the data set".
	# The host fallback (`backup.sh` full mode) reads it from backup.env, so both
	# copies have to be absolute.
	case "$(env_value DATA_DIR)" in
	/*) ;;
	*)
		echo "[compose-prod] DATA_DIR must be an absolute path in $APP_DIR/.env; the backrest mount uses it (RUNBOOK §4.4)" >&2
		exit 1
		;;
	esac
	case "$(env_value DATA_DIR "$file")" in
	/*) ;;
	*)
		echo "[compose-prod] DATA_DIR must be an absolute path in $file; the manual fallback uses it (RUNBOOK §4)" >&2
		exit 1
		;;
	esac
	# Two independent BACKUP_DIR definitions exist (the mount reads .env, the host
	# fallback reads this file); a mismatch silently splits the staging directory.
	if [ -n "$(env_value BACKUP_DIR "$file")" ] && [ -n "$(env_value BACKUP_DIR)" ] &&
		[ "$(env_value BACKUP_DIR "$file")" != "$(env_value BACKUP_DIR)" ]; then
		echo "[compose-prod] BACKUP_DIR differs between $file and $APP_DIR/.env; keep one value (RUNBOOK §4.4)" >&2
		exit 1
	fi
}

# Gatus reads a merged config directory (GATUS_CONFIG_PATH). Only the
# optional fragments that CANNOT be expressed by an empty value are rendered
# (domain: "https://" would be a permanently red endpoint; drain: Gatus
# rejects an external endpoint without a token). Bark lives in gatus.yaml and
# tolerates an empty URL, so its rendered state and its container env cannot
# diverge into "fragment missing but env set".
#
# RENDER ONLY ON up/create: those recreate containers, so the rendered files
# and the container environment are updated together. `restart`/`start` do
# NOT recreate containers (Docker keeps the old env), and `run` is executed by
# the drain timer every minute — rendering there would rewrite conf.d (and,
# before install_if_changed, bump its mtime) and make Gatus hot-reload and
# wipe its in-memory alert state every minute.
render_monitoring() {
	local out="$APP_DIR/deploy/monitoring/conf.d"
	local site_domain domain
	site_domain="$(env_value SITE_DOMAIN)"
	domain="$(env_value DOMAIN)"
	if [ -z "$site_domain" ] && [ -n "$domain" ]; then
		# Single source: DOMAIN is the deploy-wide value; SITE_DOMAIN only
		# overrides it. Silently keeping the monitors on an old domain while
		# the site moved is worse than inheriting.
		site_domain="$domain"
		echo "[compose-prod] SITE_DOMAIN is unset; inheriting DOMAIN ($domain) for the TLS/domain monitors" >&2
	elif [ -n "$site_domain" ] && [ -n "$domain" ] && [ "$site_domain" != "$domain" ]; then
		echo "[compose-prod] SITE_DOMAIN ($site_domain) differs from DOMAIN ($domain); refusing to render monitors for an ambiguous host" >&2
		exit 1
	fi
	SITE_DOMAIN="$site_domain" \
		DRAIN_HEARTBEAT_TOKEN="$(env_value DRAIN_HEARTBEAT_TOKEN)" \
		BARK_URL="$(env_value BARK_URL)" \
		READY_TOKEN="$(env_value READY_TOKEN)" \
		bash "$APP_DIR/deploy/monitoring/render-config.sh" "$out" >&2 ||
		{
			echo "[compose-prod] failed to render deploy/monitoring/conf.d" >&2
			exit 1
		}
	# The fragment keeps the literal `${SITE_DOMAIN}` and Gatus expands it
	# from ITS OWN environment, so the value the renderer just resolved must also
	# reach compose - otherwise an install that sets only DOMAIN renders the TLS
	# monitors and then expands them to "https:///", which makes Gatus exit 2 in a
	# restart loop while `up -d` still returns 0 (silent monitoring outage).
	# Compose interpolation prefers the shell over .env, so exporting is enough.
	if [ -n "$site_domain" ]; then
		export SITE_DOMAIN="$site_domain"
	fi
}

# The Sentinel overlay is part of every production command once it
# exists. Up-like commands need a bearer token: without one Sentinel would
# crash-loop and the analytics page would silently degrade to "—".
require_sentinel_token() {
	[ -f "$APP_DIR/deploy/monitoring/compose.sentinel.yaml" ] || return 0
	local value
	value=${SENTINEL_TOKEN:-$(env_value SENTINEL_TOKEN)}
	if [ -z "$value" ]; then
		echo "[compose-prod] SENTINEL_TOKEN is missing in $APP_DIR/.env; run deploy/bootstrap-secrets.sh or generate one with 'openssl rand -hex 32'" >&2
		exit 1
	fi
}

# The token guard applies only when the command starts the whole stack or
# explicitly names sentinel. A targeted `up app` / `restart gatus` /
# `restart backrest` must keep working on an install that has not enabled
# analytics yet (SENTINEL_TOKEN may legitimately stay empty; see .env.example).
#
# KEEP IN SYNC with `deploy/compose-prod.sh config --services`:
# app db caddy whisper rustfs valkey sentinel gatus backrest kuma.
# A service missing from this list is read as "whole stack" and inherits the
# token requirement - so a service added later must join this list too, or its
# targeted commands demand the analytics token.
sentinel_guard_needed() {
	local seen_cmd=0 seen_service=0 arg
	for arg in "$@"; do
		case "$arg" in
			up | start | restart | run | create) seen_cmd=1 ;;
			-*) ;;
			app | db | caddy | whisper | rustfs | valkey | sentinel | gatus | backrest | kuma)
				if [ "$seen_cmd" = 1 ]; then
					seen_service=1
					[ "$arg" = "sentinel" ] && return 0
				fi
				;;
		esac
	done
	[ "$seen_cmd" = 1 ] && [ "$seen_service" = 0 ]
}

# The guards above must run whatever the command shape is: `up`, but also a
# command preceded by global flags (`--profile x up`, `-p name up`) or `create`.
# Scan the whole argument list instead of trusting $1.
need_guards=0
need_backup_env=0
need_render=0
for arg in "$@"; do
	case "$arg" in
		up | start | restart | create)
			need_guards=1
			need_backup_env=1
			;;
		run) need_guards=1 ;;
	esac
	case "$arg" in
		up | create) need_render=1 ;;
	esac
done
if [ "$need_guards" = 1 ]; then
	require_env_file
	require_suppression_key
	require_postgres_password
fi

if [ "$need_backup_env" = 1 ]; then
	require_backup_env
fi

if [ "$need_render" = 1 ]; then
	# render-config.sh validates the monitoring env (BARK_URL scheme/charset,
	# SITE_DOMAIN, drain token, READY_TOKEN) and fails closed. Keeping every
	# monitoring check inside that one script means `run` (the drain tick, once a
	# minute) and `restart` are never blocked by a monitoring-only typo.
	render_monitoring
fi

# A whole-stack `up` (or an explicit `sentinel`) needs the bearer token,
# because Sentinel crash-loops without one and analytics degrades silently.
# Targeted commands (`up app`, `restart caddy`) stay usable on installs that
# have not enabled analytics yet.
if sentinel_guard_needed "$@"; then
	require_sentinel_token
fi

# Overlay list (monitoring + sentinel). Both are committed, so the
# `-f` list is stable in practice; the existence checks only keep a partially
# synced checkout from failing every command.
COMPOSE_FILES=(
	-f "$APP_DIR/compose.yaml"
	-f "$APP_DIR/compose.prod.yaml"
)
if [ -f "$APP_DIR/deploy/monitoring/compose.monitoring.yaml" ]; then
	COMPOSE_FILES+=(-f "$APP_DIR/deploy/monitoring/compose.monitoring.yaml")
fi
if [ -f "$APP_DIR/deploy/monitoring/compose.sentinel.yaml" ]; then
	COMPOSE_FILES+=(-f "$APP_DIR/deploy/monitoring/compose.sentinel.yaml")
fi

exec docker compose \
	--project-directory "$APP_DIR" \
	"${COMPOSE_FILES[@]}" \
	"$@"
