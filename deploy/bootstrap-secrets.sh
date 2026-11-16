#!/usr/bin/env bash
#
# Bootstrap the installer-owned secrets (W2.12 / decision T5-A).
#
# Contract: deploy/secret-inventory.json. This script keeps the same list in
# bash (a unit test asserts every inventory name appears here). It writes env
# files ONLY - never the application database, never a value in argv, never a
# value in the receipt.
#
#   ./deploy/bootstrap-secrets.sh --dry-run
#   ./deploy/bootstrap-secrets.sh
#   ./deploy/bootstrap-secrets.sh --rotate SUBSCRIBE_HMAC_KEY
#
# Properties:
#   - idempotent: a non-empty existing value is kept unless --rotate names it
#   - atomic: temp file + mv, previous file backed up as <file>.bak.<epoch>
#   - umask 077, no `set -x`, no echo of values
#   - receipt: install-receipt.json with names, targets and a sha256 prefix
#
# Exit codes: 0 = ok, 1 = a write/validation failed, 2 = usage/config error.

set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}
DRY_RUN=false
ROTATE=()

usage() {
	sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=true; shift ;;
		--rotate)
			[ $# -ge 2 ] || { echo "[secrets] --rotate needs a name" >&2; exit 2; }
			ROTATE+=("$2")
			shift 2
			;;
		--app-dir)
			[ $# -ge 2 ] || { echo "[secrets] --app-dir needs a path" >&2; exit 2; }
			APP_DIR=$2
			shift 2
			;;
		-h|--help) usage; exit 0 ;;
		*) echo "[secrets] unknown argument: $1" >&2; exit 2 ;;
	esac
done

ENV_FILE="${APP_DIR}/.env"
BACKUP_FILE="${APP_DIR}/deploy/backup.env"
RECEIPT_FILE="${APP_DIR}/install-receipt.json"

# name|generator|target  (target: env | backup)
# Must stay in sync with deploy/secret-inventory.json.
INVENTORY=(
	"POSTGRES_PASSWORD|hex-32|env"
	"BETTER_AUTH_SECRET|base64-32|env"
	"SECRETS_KEYS|keyring-v1|env"
	"SECRETS_KEY_ACTIVE|fixed-1|env"
	"ADMIN_SETUP_TOKEN|base64-32|env"
	"SUBSCRIBE_HMAC_KEY|base64-32|env"
	"SUBSCRIBE_TOKEN_SECRET|base64-32|env"
	"SUPPRESSION_HMAC_KEY|base64-32|env"
	"MAIL_EVENTS_HMAC_KEY|base64-32|env"
	"READY_TOKEN|base64-32|env"
	"SENTINEL_TOKEN|hex-32|env"
	"RESTIC_PASSWORD|base64-32|backup"
	"RESTIC_CONFIG_PASSWORD|base64-32|backup"
)

command -v openssl >/dev/null 2>&1 || { echo "[secrets] openssl is required" >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 || { echo "[secrets] sha256sum is required" >&2; exit 2; }

# Values that ship in the examples or are obvious placeholders. A fresh
# install copied from `.env.example` must not inherit `POSTGRES_PASSWORD=root`.
is_placeholder() {
	case "$1" in
		''|'***'|root|postgres|password|changeme|change-me) return 0 ;;
		*) return 1 ;;
	esac
}

generate_value() {
	case "$1" in
		hex-32) openssl rand -hex 32 ;;
		base64-32) openssl rand -base64 32 | tr -d '\n' ;;
		keyring-v1) printf '1:%s' "$(openssl rand -base64 32 | tr -d '\n')" ;;
		fixed-1) printf '1' ;;
		*) echo "[secrets] unknown generator: $1" >&2; exit 2 ;;
	esac
}

# Read KEY="value" / KEY=value; never prints anything else.
get_value() {
	local file=$1 key=$2
	[ -f "$file" ] || return 0
	sed -n "s/^${key}=//p" "$file" | tail -n 1 | sed 's/^"//; s/"$//'
}

file_has_value() {
	local file=$1 key=$2
	[ -n "$(get_value "$file" "$key")" ]
}

# Atomic single-key upsert; creates the file when absent.
# The value never appears in argv (world-readable via `ps` / /proc): it is staged
# in a 0600 file and read back by awk (review P1-1).
set_value() {
	local file=$1 key=$2 value=$3
	if [ ! -f "$file" ]; then
		: >"$file"
	fi
	local tmp vtmp
	tmp=$(mktemp "${file}.tmp.XXXXXX")
	vtmp=$(mktemp "${file}.val.XXXXXX")
	chmod 600 "$vtmp"
	printf '%s' "$value" >"$vtmp"
	awk -v k="$key" -v vfile="$vtmp" '
		BEGIN { v = ""; if ((getline line < vfile) > 0) v = line }
		$0 ~ "^" k "=" { if (!done) { print k "=\"" v "\""; done = 1 } next }
		{ print }
		END { if (!done) print k "=\"" v "\"" }
	' "$file" >"$tmp"
	rm -f "$vtmp"
	mv "$tmp" "$file"
}

backup_file() {
	local file=$1
	[ -f "$file" ] || return 0
	cp -p "$file" "${file}.bak.$(date +%s)"
}

is_rotate_requested() {
	local name=$1 candidate
	for candidate in "${ROTATE[@]:-}"; do
		[ "$candidate" = "$name" ] && return 0
	done
	return 1
}

# A rotation of the master keyring through this script would orphan existing
# ciphertext; the three-phase ceremony lives in deploy/RUNBOOK.md §4.2.
for name in "${ROTATE[@]:-}"; do
	if [ "$name" = "SECRETS_KEYS" ] || [ "$name" = "SECRETS_KEY" ]; then
		echo "[secrets] refusing to rotate $name here: use the three-phase keyring rotation (RUNBOOK §4.2)" >&2
		exit 2
	fi
done

FRESH_ENV=false
FRESH_BACKUP=false
if [ "$DRY_RUN" = false ]; then
	mkdir -p "${APP_DIR}/deploy"
	if [ ! -f "$ENV_FILE" ] && [ -f "${APP_DIR}/.env.example" ]; then
		cp "${APP_DIR}/.env.example" "$ENV_FILE"
		FRESH_ENV=true
	fi
	if [ ! -f "$BACKUP_FILE" ] && [ -f "${APP_DIR}/deploy/backup.env.example" ]; then
		cp "${APP_DIR}/deploy/backup.env.example" "$BACKUP_FILE"
		FRESH_BACKUP=true
	fi
fi

INSTALL_ID="$(date +%s)-$(openssl rand -hex 4)"
RECEIPT_ENTRIES=()
GENERATED=0
KEPT=0

for row in "${INVENTORY[@]}"; do
	IFS='|' read -r name generator target <<<"$row"
	file=$ENV_FILE
	target_label=".env"
	if [ "$target" = "backup" ]; then
		file=$BACKUP_FILE
		target_label="deploy/backup.env"
	fi

	existing=$(get_value "$file" "$name")
	if [ "$FRESH_ENV" = true ] && [ "$target" = "env" ]; then
		existing=""
	fi
	if [ "$FRESH_BACKUP" = true ] && [ "$target" = "backup" ]; then
		existing=""
	fi
	if [ -n "$existing" ] && ! is_placeholder "$existing" && ! is_rotate_requested "$name"; then
		KEPT=$((KEPT + 1))
		fingerprint=$(printf '%s' "$existing" | sha256sum | cut -c1-8)
		RECEIPT_ENTRIES+=("{\"name\":\"$name\",\"target\":\"$target_label\",\"action\":\"kept\",\"sha256Prefix\":\"$fingerprint\"}")
		continue
	fi

	if [ "$DRY_RUN" = true ]; then
		echo "[secrets] would generate $name -> $target_label"
		RECEIPT_ENTRIES+=("{\"name\":\"$name\",\"target\":\"$target_label\",\"action\":\"would-generate\"}")
		GENERATED=$((GENERATED + 1))
		continue
	fi

	value=$(generate_value "$generator")
	case "$generator" in
		base64-32)
			[ "$(printf '%s' "$value" | base64 -d 2>/dev/null | wc -c)" -eq 32 ] || {
				echo "[secrets] generated $name is not 32 bytes" >&2
				exit 1
			}
			;;
		hex-32)
			[ "${#value}" -eq 64 ] || { echo "[secrets] generated $name is not 32 bytes" >&2; exit 1; }
			;;
		keyring-v1)
			[ "${#value}" -ge 44 ] || { echo "[secrets] generated $name is too short" >&2; exit 1; }
			;;
	esac

	backup_file "$file"
	set_value "$file" "$name" "$value"
	fingerprint=$(printf '%s' "$value" | sha256sum | cut -c1-8)
	RECEIPT_ENTRIES+=("{\"name\":\"$name\",\"target\":\"$target_label\",\"action\":\"$([ "$(get_value "$file" "$name")" = "$value" ] && echo generated || echo rotated)\",\"sha256Prefix\":\"$fingerprint\"}")
	GENERATED=$((GENERATED + 1))
	unset value
done

if [ "$DRY_RUN" = true ]; then
	echo "[secrets] dry run: $GENERATED planned, $KEPT kept; nothing written"
	exit 0
fi

# The receipt never contains a value: names, targets, actions, fingerprints.
receipt_json=$(
	printf '{\n  "installId": "%s",\n  "createdAt": "%s",\n  "generated": %d,\n  "kept": %d,\n  "secrets": [\n    %s\n  ]\n}\n' \
		"$INSTALL_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$GENERATED" "$KEPT" \
		"$(IFS=,; echo "${RECEIPT_ENTRIES[*]}")"
)
printf '%s' "$receipt_json" >"$RECEIPT_FILE"
chmod 600 "$RECEIPT_FILE"

echo "[secrets] generated $GENERATED, kept $KEPT; receipt: ${RECEIPT_FILE#"$APP_DIR"/}"
echo "[secrets] offline copies (password manager): SECRETS_KEYS, RESTIC_PASSWORD, RESTIC_CONFIG_PASSWORD"
echo "[secrets] after /admin/setup succeeds, remove ADMIN_SETUP_TOKEN from .env and restart the app"
