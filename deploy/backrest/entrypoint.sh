#!/bin/sh
#
# Backrest entrypoint.
#
# Renders /config/config.json from the environment on first start, then hands
# over to upstream's /docker-entrypoint (which only fills in BACKREST_* defaults
# and execs /backrest).
#
# Why rendered instead of clicked once in the UI: the hook wiring and the
# backup/forget/prune/check schedules must be reviewable in git, and a rebuilt
# host has to come back with the same setup from one file. The rendered file
# holds the two repository passwords, so it is written 0600 into the config
# volume and never into the checkout.
#
# Render policy: only when the file is absent/empty, or BACKREST_RENDER_CONFIG
# is "force" (credential rotation, schedule change). Anything else would
# overwrite edits made in the UI without telling anyone.
set -eu
umask 077

CONFIG=${BACKREST_CONFIG:-/config/config.json}
INSTANCE=${BACKREST_INSTANCE:-web-lair}

log() { echo "[backrest-entrypoint] $*" >&2; }

# A value that cannot be represented in JSON must fail loudly: a silently
# mangled config.json is discovered by a backup that never runs.
json_safe() { # name value
	if printf '%s' "$2" | grep -q '["\\]'; then
		log "$1 contains a double quote or backslash; refusing to write a broken JSON config"
		exit 1
	fi
	if [ "$(printf '%s' "$2" | wc -l)" -ne 0 ]; then
		log "$1 contains a newline; refusing to write a broken JSON config"
		exit 1
	fi
}

# Schedule fragment: "disabled" (or empty) turns the operation off; anything else
# must be a 6-field cron expression (seconds first, Backrest's format). Formatting
# only — validation happens up front in validate_schedule(), because a function
# called inside $( ) cannot abort the render with `exit`.
schedule_json() {
	case "${1:-}" in
		"" | disabled) printf '{"disabled": true}' ;;
		*) printf '{"cron": "%s", "clock": "CLOCK_LAST_RUN_TIME"}' "$1" ;;
	esac
}

# A 5-field systemd-style calendar would be accepted by Backrest as "never
# fires" — the backup would simply stop — and a quote/backslash produces a
# config.json that fails to parse. Both are caught here, before anything is
# written, and the render aborts (this function is called directly, not in a
# substitution, so `exit` reaches the script).
validate_schedule() { # name value
	name=$1
	value=${2:-}
	case "$value" in
		"" | disabled) return 0 ;;
	esac
	# Field-by-field, because a space is the separator: a bracket class that must
	# also allow spaces cannot be written portably (an escaped space inside []
	# matches a literal backslash).
	old_ifs=$IFS
	# `set -f`: without it the `*` fields are pathname-expanded against the
	# current directory, so the field count depends on where the container
	# started. This is the bug that made this validator report 18 fields.
	set -f
	IFS=' 	'
	set -- $value
	IFS=$old_ifs
	set +f
	if [ "$#" -ne 6 ]; then
		log "$name has $# fields; Backrest needs 6 (seconds first), e.g. '0 30 3 * * *'"
		exit 1
	fi
	for field in "$@"; do
		case "$field" in
			*[!0-9*/,-]*)
				log "$name field '$field' contains characters that are not cron syntax"
				exit 1
				;;
		esac
	done
	return 0
}

# Extra restic environment (S3 credentials for Cloudflare and Backblaze).
# Empty for a local filesystem repository, which is what the drill uses.
repo_env=""
add_repo_env() {
	value=$(eval "printf '%s' \"\${$1:-}\"")
	[ -n "$value" ] || return 0
	json_safe "$1" "$value"
	repo_env="${repo_env:+$repo_env, }\"$1=$value\""
}

render() {
	: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set (deploy/backup.env, RUNBOOK §4)}"
	: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"
	: "${RESTIC_CONFIG_REPOSITORY:?RESTIC_CONFIG_REPOSITORY is not set (deploy/backup.env, RUNBOOK §4)}"
	: "${RESTIC_CONFIG_PASSWORD:?RESTIC_CONFIG_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"
	# Same guard as the keep branch: the hook runs pg_dump with BACKUP_PG_MODE=local,
	# so a first start without this would come up healthy and then fail every
	# night (and ON_ERROR_CANCEL skips the END hook, so no /fail either).
	: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"

	json_safe RESTIC_REPOSITORY "$RESTIC_REPOSITORY"
	json_safe RESTIC_PASSWORD "$RESTIC_PASSWORD"
	json_safe RESTIC_CONFIG_REPOSITORY "$RESTIC_CONFIG_REPOSITORY"
	json_safe RESTIC_CONFIG_PASSWORD "$RESTIC_CONFIG_PASSWORD"
	json_safe BACKREST_INSTANCE "$INSTANCE"

	validate_schedule BACKREST_DATA_CRON "${BACKREST_DATA_CRON:-0 30 3 * * *}"
	validate_schedule BACKREST_CONFIG_CRON "${BACKREST_CONFIG_CRON:-0 40 3 * * *}"
	validate_schedule BACKREST_CHECK_CRON "${BACKREST_CHECK_CRON:-0 30 4 * * 0}"
	validate_schedule BACKREST_CONFIG_CHECK_CRON "${BACKREST_CONFIG_CHECK_CRON:-0 0 6 1 * *}"
	validate_schedule BACKREST_PRUNE_CRON "${BACKREST_PRUNE_CRON:-0 0 5 * * 0}"

	add_repo_env AWS_ACCESS_KEY_ID
	add_repo_env AWS_SECRET_ACCESS_KEY
	add_repo_env AWS_DEFAULT_REGION
	add_repo_env AWS_SESSION_TOKEN

	mkdir -p "$(dirname -- "$CONFIG")"
	cat > "$CONFIG.new" <<EOF
{
  "version": 6,
  "modno": 0,
  "instance": "$INSTANCE",
  "auth": { "disabled": true },
  "repos": [
    {
      "id": "lair-data",
      "uri": "$RESTIC_REPOSITORY",
      "password": "$RESTIC_PASSWORD",
      "env": [ $repo_env ],
      "autoInitialize": true,
      "autoUnlock": true,
      "hooks": [
        {
          "conditions": ["CONDITION_CHECK_SUCCESS"],
          "onError": "ON_ERROR_IGNORE",
          "actionCommand": { "command": "sh /hooks/hook-check-end.sh" }
        },
        {
          "conditions": ["CONDITION_CHECK_ERROR"],
          "onError": "ON_ERROR_IGNORE",
          "actionCommand": { "command": "sh /hooks/hook-check-end.sh --failed" }
        }
      ],
      "checkPolicy": { "schedule": $(schedule_json "${BACKREST_CHECK_CRON:-0 30 4 * * 0}"), "readDataSubsetPercent": 5 },
      "prunePolicy": { "schedule": $(schedule_json "${BACKREST_PRUNE_CRON:-0 0 5 * * 0}"), "maxUnusedPercent": 5 }
    },
    {
      "id": "lair-config",
      "uri": "$RESTIC_CONFIG_REPOSITORY",
      "password": "$RESTIC_CONFIG_PASSWORD",
      "env": [ $repo_env ],
      "autoInitialize": true,
      "autoUnlock": true,
      "hooks": [
        {
          "conditions": ["CONDITION_CHECK_SUCCESS"],
          "onError": "ON_ERROR_IGNORE",
          "actionCommand": { "command": "sh /hooks/hook-check-end.sh --config" }
        },
        {
          "conditions": ["CONDITION_CHECK_ERROR"],
          "onError": "ON_ERROR_IGNORE",
          "actionCommand": { "command": "sh /hooks/hook-check-end.sh --config --failed" }
        }
      ],
      "checkPolicy": { "schedule": $(schedule_json "${BACKREST_CONFIG_CHECK_CRON:-0 0 6 1 * *}"), "readDataSubsetPercent": 100 }
    }
  ],
  "plans": [
    {
      "id": "lair-nightly",
      "repo": "lair-data",
      "paths": ["/staging", "/lair-data", "/lair-rustfs"],
      "schedule": $(schedule_json "${BACKREST_DATA_CRON:-0 30 3 * * *}"),
      "retention": { "policyTimeBucketed": { "daily": 7, "weekly": 4, "monthly": 6 } },
      "hooks": [
        {
          "conditions": ["CONDITION_SNAPSHOT_START"],
          "onError": "ON_ERROR_CANCEL",
          "actionCommand": { "command": "sh /hooks/hook-snapshot-start.sh" }
        },
        {
          "conditions": ["CONDITION_SNAPSHOT_END"],
          "onError": "ON_ERROR_IGNORE",
          "actionCommand": { "command": "{{ if .Error }}sh /hooks/hook-snapshot-end.sh --failed{{ else }}sh /hooks/hook-snapshot-end.sh {{ .SnapshotId }}{{ end }}" }
        }
      ]
    },
    {
      "id": "lair-config-daily",
      "repo": "lair-config",
      "paths": ["/lair-env"],
      "schedule": $(schedule_json "${BACKREST_CONFIG_CRON:-0 40 3 * * *}"),
      "retention": { "policyTimeBucketed": { "daily": 30, "monthly": 12 } },
      "hooks": [
        {
          "conditions": ["CONDITION_SNAPSHOT_START"],
          "onError": "ON_ERROR_FATAL",
          "actionCommand": { "command": "sh /hooks/hook-snapshot-start.sh --config" }
        },
        {
          "conditions": ["CONDITION_SNAPSHOT_END"],
          "onError": "ON_ERROR_IGNORE",
          "actionCommand": { "command": "{{ if .Error }}sh /hooks/hook-snapshot-end.sh --config --failed{{ else }}sh /hooks/hook-snapshot-end.sh --config {{ .SnapshotId }}{{ end }}" }
        }
      ]
    }
  ]
}
EOF
	mv "$CONFIG.new" "$CONFIG"
	chmod 600 "$CONFIG"
	log "rendered $CONFIG (repos lair-data/lair-config, plans lair-nightly/lair-config-daily)"
}

if [ ! -s "$CONFIG" ]; then
	log "$CONFIG is absent; rendering it from the environment"
	render
elif [ "${BACKREST_RENDER_CONFIG:-}" = force ]; then
	log "BACKREST_RENDER_CONFIG=force; re-rendering $CONFIG"
	render
else
	# Keeping the file must not mean ignoring a vanished credential file: a
	# container that comes up healthy and then silently fails every hook is the
	# exact failure mode this batch removes.
	: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set (deploy/backup.env, RUNBOOK §4)}"
	: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"
	: "${RESTIC_CONFIG_REPOSITORY:?RESTIC_CONFIG_REPOSITORY is not set (deploy/backup.env, RUNBOOK §4)}"
	: "${RESTIC_CONFIG_PASSWORD:?RESTIC_CONFIG_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"
	: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set (deploy/backup.env, RUNBOOK §4)}"
	log "keeping the existing $CONFIG (set BACKREST_RENDER_CONFIG=force to re-render)"
fi

exec /docker-entrypoint /backrest "$@"
