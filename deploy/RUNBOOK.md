# Deployment runbook (web-lair)

> Target: one self-hosted Ubuntu 24.04 box behind Caddy. Branches deploy by
> commit; the image builds on the box and is tagged with the commit SHA. Every
> step is idempotent unless marked otherwise.

> Scope: operational procedures only (deploy, update, rollback, backup,
> monitoring, email ops). The security model lives in `deploy/SECRETS.md`,
> privacy/DSR in `deploy/PRIVACY.md`, edge configuration in `deploy/EDGE.md`.

> [!IMPORTANT]
> Production commands go through `deploy/compose-prod.sh`: a bare
> `docker compose` auto-loads `compose.override.yaml` (dev loopback ports +
> `devhost` network). The wrapper runs
> `docker compose --project-directory . -f compose.yaml -f compose.prod.yaml -f deploy/monitoring/compose.monitoring.yaml -f deploy/monitoring/compose.sentinel.yaml`
> plus the guards (`.env` / suppression key / Postgres password / Bark URL scheme /
> `SENTINEL_TOKEN` for a whole-stack `up`) and renders `deploy/monitoring/conf.d`
> on `up`/`create` (`deploy/monitoring/README.md`). Run every block from
> `/srv/web-lair/app` unless it changes directory.

## 0. Host prerequisites

| Item                                                                                | Check                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Docker Engine + compose plugin                                                      | `docker version && docker compose version`                                            |
| Tailscale up (SSH / Kuma 3001 / Gatus 8080 via SSH tunnel; Gatus is loopback-bound) | `tailscale status`                                                                    |
| Time sync (TLS, TOTP, DB timestamps)                                                | `timedatectl` → `System clock synchronized: yes`                                      |
| Only 80/443 public                                                                  | `ss -lntp \| grep -E ':(80\|443)\b'`; everything else bound to `127.0.0.1` or tailnet |
| Deploy user uid/gid 1000 (matches the image `node` user)                            | `id -u`                                                                               |

## 1. First deploy

Pull the monitoring image before `up` (a failed pull aborts the deploy); if the
registry is unreachable, deploy without Gatus first
(`deploy/compose-prod.sh up -d app db caddy`) and add it later:

```bash
docker pull ghcr.io/twin/gatus:v5.38.0   # or: deploy/compose-prod.sh pull gatus
```

```bash
git clone <repo> /srv/web-lair/app && cd /srv/web-lair/app
git checkout <commit-sha>

cp .env.example .env
chmod 600 .env
$EDITOR .env      # see §1.1 for the required keys
```

Or generate the secrets instead of editing them by hand:

```bash
./deploy/bootstrap-secrets.sh --dry-run   # names and targets, no values
./deploy/bootstrap-secrets.sh             # writes .env + deploy/backup.env
```

The script keeps existing non-empty values, rotates only with `--rotate NAME`,
writes no database rows and prints no secret; its receipt
(`install-receipt.json`) carries names and SHA-256 prefixes only. Copy
`SECRETS_KEYS`, `RESTIC_PASSWORD` and `RESTIC_CONFIG_PASSWORD` to the offline
password manager, then remove `ADMIN_SETUP_TOKEN` after `/admin/setup` succeeds
— the `admin.setup_complete` marker refuses a second use.

### 1.1 Required `.env` keys

| Key                                                    | Value                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`  | strong, unique, **URL-safe** (`openssl rand -hex 32`) — the password is interpolated into `DATABASE_URL` verbatim                                                         |
| `BETTER_AUTH_SECRET`                                   | ≥32 chars, high entropy                                                                                                                                                   |
| `SECRETS_KEYS` / `SECRETS_KEY_ACTIVE`                  | runtime secret keyring (W2); see §4.2 — required once an encrypted key exists                                                                                             |
| `ORIGIN`                                               | `https://<domain>` (no trailing slash)                                                                                                                                    |
| `DOMAIN`                                               | same host, used by Caddy                                                                                                                                                  |
| `ACME_EMAIL`                                           | Let's Encrypt expiry notices                                                                                                                                              |
| `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`              | object-store credentials                                                                                                                                                  |
| `DATA_DIR`                                             | absolute host path, e.g. `/srv/web-lair/data`                                                                                                                             |
| `MAIL_*`                                               | see §1.2                                                                                                                                                                  |
| `SUBSCRIBE_TOKEN_TTL_DAYS` / `SUBSCRIBE_HMAC_KEY`      | see §1.2 (confirmation-link lifetime + per-address cap key)                                                                                                               |
| `SUBSCRIBE_TOKEN_SECRET`                               | see §1.2 (derives the mailed confirmation token; required before the first start)                                                                                         |
| `SUPPRESSION_HMAC_KEY` / `MAIL_EVENTS_HMAC_KEY`        | see §8 (suppression list hash master key + bounce/complaint webhook key)                                                                                                  |
| `SUPPRESSION_HMAC_KEY_VERSION`                         | see §8 (active suppression key version; default 1, gated by `db verify-suppression-version`)                                                                              |
| `OWNER_EMAIL` / `OWNER_PASSWORD`                       | first owner seed (`pnpm ops site seed-owner` from the host, dev only)                                                                                                     |
| `DEADMAN_PING_URL` / `HC_DEADMAN_URL`                  | healthchecks.io **liveness** check (5 min); the timer prefers `HC_DEADMAN_URL` and falls back to `DEADMAN_PING_URL`; both unset ⇒ skip (no alarm)                         |
| `READY_TOKEN`                                          | Bearer for `GET /api/ready` (bootstrap generates it). Production answers 404 to everyone without it; Gatus must send the same value.                                      |
| `HEALTHCHECKS_RESOURCES_URL` / `HEALTHCHECKS_MAIL_URL` | healthchecks.io checks for the two probes (one check each; base ping URL). Empty ⇒ ping skipped.                                                                          |
| `SENTINEL_TOKEN`                                       | bearer token for the internal Sentinel traffic service (`bootstrap-secrets.sh` generates hex-32); empty ⇒ page renders “—”, and a full-stack `up` refuses until it is set |
| Monitoring (Gatus)                                     | see `deploy/monitoring/README.md` §5 (`BARK_URL`, `SITE_DOMAIN`, `DRAIN_HEARTBEAT_TOKEN`, `READY_TOKEN`, `MONITOR_*`, `HC_*`)                                             |
| `JOBS_HEARTBEAT_URL`                                   | per-tick drain ping (Kuma push; Gatus drain heartbeat is not wired yet — see `deploy/monitoring/README.md` §8)                                                            |
| `ALERT_WEBHOOK_URL`                                    | systemd `OnFailure` target; leave empty to disable the alert unit                                                                                                         |
| `MAIL_DEV_LOG` / `MAIL_DEV_LOG_OK`                     | dev/e2e only; production ignores dev logging unless BOTH are set                                                                                                          |

`deploy/compose-prod.sh` refuses to start when `POSTGRES_PASSWORD` is
missing or not URL-safe (the table row covers the DSN mechanics). `SUPPRESSION_HMAC_KEY` is mandatory
before the first start (production boot refuses; dev needs it for
subscribe/unsubscribe) — `openssl rand -base64 32`, back it up.
`SUBSCRIBE_TOKEN_SECRET` is mandatory too (F-13): the mailed token derives from
the stored nonce, so a missing secret leaves the app unable to mint a link.
`MAIL_EVENTS_HMAC_KEY` is only needed when a bounce/complaint relay is
configured.

Create the data directory with the image's uid before the first start — Docker
would otherwise create it as root and the `node` user (uid 1000) could not
write the job scaffold:

```bash
sudo install -d -m 0750 -o 1000 -g 1000 /srv/web-lair/data
```

Backup credentials go in their own file (not `.env`), so the app container
never sees the credential that can delete the offsite repository:

```bash
# `deploy/bootstrap-secrets.sh` (above) already created this file with
# RESTIC_PASSWORD / RESTIC_CONFIG_PASSWORD. `cp -n` keeps those; a plain `cp`
# would overwrite the only copy of a key already bound to an offsite repository.
# Fill in the rest by hand (or re-run bootstrap with --rotate NAME for a key you
# have NOT used yet).
cp -n deploy/backup.env.example deploy/backup.env
chmod 600 deploy/backup.env
$EDITOR deploy/backup.env      # + POSTGRES_USER / POSTGRES_DB / DATA_DIR (same values as .env),
                               #   RESTIC_* + RESTIC_CONFIG_* (second repository, own password)
                               #   + AWS_* + BACKUP_PING_URL + CHECK_PING_URL; see §4
```

### 1.2 Mail route probes (deploy note Q7)

Run on the box; the results pick **direct MTA** (default) or **relay**:

```bash
# 1) outbound port 25 reachable?
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/gmail-smtp-in.l.google.com/25' && echo OPEN || echo BLOCKED

# 2) reverse DNS of the public IP (must be a hostname you control for direct send)
curl -s https://api.ipify.org; dig +short -x "$(curl -s https://api.ipify.org)"

# 3) Spamhaus PBL lookup (use the web form; public resolvers are rate-limited)
#    https://check.spamhaus.org/  → paste the public IP
```

- 25 open **and** PTR matches the sending subdomain **and** not PBL-listed →
  `MAIL_ENABLED=true`, `MAIL_SMTP_HOST=host.docker.internal`, `MAIL_FROM=...`
  (a host MTA; the app runs in its own network namespace, so `127.0.0.1` there
  is the container — compose maps the host gateway). Any red → point
  `MAIL_SMTP_HOST/PORT/USER/PASS` at the relay; the app code is unchanged (one
  env switch).
- DKIM is signed by the app: `MAIL_DKIM_DOMAIN=mail.<domain>`,
  `MAIL_DKIM_SELECTOR` and the PEM key (`\n` escapes accepted). The signature
  covers the RFC 4871 default header set **plus `List-Unsubscribe-Post`**
  (RFC 8058 §4).

**DNS records (D-3 checklist):**

| Record | Name                                      | Value                                                                                           |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SPF    | `mail.<domain>` TXT                       | `v=spf1 ip4:<public-ip> -all` (or the relay's `include:`)                                       |
| DKIM   | `<selector>._domainkey.mail.<domain>` TXT | public key from `MAIL_DKIM_PRIVATE_KEY`                                                         |
| DMARC  | `_dmarc.mail.<domain>` TXT                | `v=DMARC1; p=none; rua=mailto:<mailbox>` first, tighten to `quarantine` after a week of reports |
| PTR    | sending IP                                | matches `mail.<domain>` (direct MTA only)                                                       |

Send from the **subdomain** so a reputation problem never touches the apex.

Subscription tokens (email hardening E1):

- `SUBSCRIBE_TOKEN_TTL_DAYS` (default `1` = 24h; ceiling `3` = 72h, larger
  values are clamped and logged) bounds the confirmation link; expired links
  render "link expired" and never confirm. Unsubscribe links are not TTL-bound,
  but a pending/unsubscribed resubmit outside the 15-minute resend cooldown
  rotates the token, so older mails' links stop working — the newest mail always
  carries a valid opt-out. A stable, never-rotating unsubscribe token is a
  registered follow-up (F-15).
- `SUBSCRIBE_HMAC_KEY` (`openssl rand -base64 32`) keys the per-address
  **5 / 24 h** cap. Empty/invalid degrades to IP-only limiting (`10 / h`) and
  logs `[email-hash] SUBSCRIBE_HMAC_KEY is missing...`; set it in production.
- The confirmation mail is transactional: it carries **no** `List-Unsubscribe`
  headers. Bulk mail (not implemented yet) must send both headers, and the
  one-click URI is `POST /api/unsubscribe/one-click?token=<token>`
  (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`, no cookies, no redirect).

### 1.3 Build (gate: ≤ 8 min, ≤ 4 GB peak)

```bash
set -euo pipefail
cd /srv/web-lair/app
export HTTP_PROXY= HTTPS_PROXY=        # the box has no local proxy
# Tag this build with its commit; the default `:local` is overwritten on every
# deploy and makes the rollback-by-tag in §3 impossible. Compose still reads
# .env for the other values; do not `source` it (unquoted spaces break bash).
export APP_IMAGE="web-lair-app:$(git rev-parse --short HEAD)"
/usr/bin/time -v deploy/compose-prod.sh build app 2>&1 | tail -30
# record "Elapsed" and "Maximum resident set size"; over the gate → build on a
# workstation instead: docker save | ssh box docker load (image tag = SHA).
# Prove the drain/builtin graph loads in the image that was just tagged.
deploy/verify-image.sh "$APP_IMAGE"
```

### 1.4 Migrate, then start

```bash
set -euo pipefail
export APP_IMAGE="web-lair-app:$(git rev-parse --short HEAD)"
mkdir -p /srv/web-lair/pre-migrate
# tmpfiles prunes dumps older than 30 days (install once; see §4).
sudo tee /etc/tmpfiles.d/web-lair.conf >/dev/null <<'EOF'
d /srv/web-lair/pre-migrate 0750 1000 1000 30d
EOF
sudo systemd-tmpfiles --create
# The first deploy reaches this block before `up -d`; the db must be up first.
deploy/compose-prod.sh up -d db
# The entrypoint's temporary server only listens on the unix socket; probe TCP.
for i in $(seq 1 30); do
  deploy/compose-prod.sh exec -T db pg_isready -h 127.0.0.1 -q && break
  [ "$i" = 30 ] && { echo "db did not become ready" >&2; exit 1; }
  sleep 2
done
dump=/srv/web-lair/pre-migrate/pre-migrate-$(date +%F_%H%M%S).dump
# The container has POSTGRES_USER/POSTGRES_DB; the host shell does not.
deploy/compose-prod.sh exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$dump.tmp"
mv "$dump.tmp" "$dump"
deploy/compose-prod.sh exec -T db pg_restore -l < "$dump" > /dev/null
deploy/compose-prod.sh run --rm app node bin/lair db migrate-prod
deploy/compose-prod.sh run --rm app node bin/lair site ensure-categories
deploy/compose-prod.sh run --rm app node bin/lair db verify-baseline
# Default maintenance schedules (idempotent; adjust in admin afterwards).
# Seed rows are one-per-job and use options.site.timezone (fallback UTC); times
# are not critical for maintenance, and admin-created schedules use the same tz.
deploy/compose-prod.sh run --rm app node bin/lair site ensure-schedules
deploy/compose-prod.sh up -d
deploy/compose-prod.sh ps          # all healthy
```

These four steps equal `deploy/compose-prod.sh run --rm app node bin/lair deploy post`
(ordered in `scripts/deploy-hooks.ts`); the manual form lets you stop at the
failed step.

### 1.5 Smoke

```bash
export DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d '"')
curl -fsS https://$DOMAIN/api/health
curl -sI https://$DOMAIN | head -1                    # 200
curl -sI http://$DOMAIN | head -1                     # 308 → https
deploy/compose-prod.sh exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>console.log(r.status))"

# M6: readiness (needs READY_TOKEN) and the ops surfaces that must be reachable
deploy/compose-prod.sh exec app sh -lc \
  'wget -qO- --header="Authorization: Bearer $READY_TOKEN" http://127.0.0.1:3000/api/ready'
deploy/compose-prod.sh ps gatus sentinel backrest     # sentinel/backrest "(healthy)"; gatus "Up" (no healthcheck: scratch image)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health   # Gatus, via SSH tunnel
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/admin/analytics # 303 (login) — page is admin-only
```

Readiness must answer `{"status":"ready","db":"ok","valkey":"ok"}`; a `404`
means `READY_TOKEN` is missing (fail closed) and a `503` prints the failing
dependency. `ps` showing `(healthy)` for `gatus`/`sentinel`/`backrest` proves
the three services loaded their config; `bash deploy/monitoring/verify-config.sh`
runs the full Gatus assertion set.

Then: register a test account (verification mail must arrive), subscribe a test
address (confirmation link must land on `/subscribe/confirm`), upload one photo
(EXIF must parse — this proves `perl` + exiftool in the image). Setup does not
require mail (the owner claim marks the first account verified), but configure
mail before relying on verification or password-reset emails.

## 2. Update

```bash
set -euo pipefail
cd /srv/web-lair/app
git fetch && git checkout <new-sha>
export APP_IMAGE="web-lair-app:$(git rev-parse --short HEAD)"
deploy/compose-prod.sh build app
deploy/verify-image.sh "$APP_IMAGE"
```

Then run the §1.4 migrate block unchanged (it is idempotent) and finish with
`deploy/compose-prod.sh up -d`. Pin the image: `APP_IMAGE=web-lair-app:<sha>` in
`.env` so a rollback is a tag change. Never roll back a migration without
restoring the pre-migration dump.

### 2.1 E2 baseline rebuild (one-off, 2026-10-18)

E2 regenerated the single `0000_baseline.sql` in place (49 tables) instead of
appending a migration, so `scripts/migrate.ts` **refuses to start** on a pre-E2
database (`[migrate] this database predates the E2 baseline`). Upgrade such a
box by rebuilding the schema and restoring data. Run from the app directory
with the target image pinned in `.env` (`APP_IMAGE=web-lair-app:<sha>`):

```bash
set -euo pipefail
cd /srv/web-lair/app
grep -Eq '^APP_IMAGE="?web-lair-app:' .env || { echo 'pin APP_IMAGE first' >&2; exit 1; }
export APP_IMAGE=$(grep -E '^APP_IMAGE=' .env | cut -d= -f2- | tr -d '"')
case "$APP_IMAGE" in *:local) echo 'APP_IMAGE=:local is overwritten per build; pin a SHA tag' >&2; exit 1;; esac
docker image inspect "$APP_IMAGE" > /dev/null
docker run --rm --entrypoint node "$APP_IMAGE" -e \
  "const fs=require('node:fs'); if(!fs.readFileSync('drizzle/0000_baseline.sql','utf8').includes('CREATE TABLE \"email_suppressions\"')){console.error('image predates the E2 baseline');process.exit(1)}"
STAMP=$(date +%F_%H%M%S)
BK=/srv/web-lair/pre-migrate
mkdir -p "$BK"
sudo systemctl stop web-lair-drain.timer || true
sudo systemctl stop web-lair-drain.service || true
# Pause Backrest (§4): no snapshot may capture a dropped/half-restored database.
deploy/compose-prod.sh stop backrest || true
docker rm -f web-lair-drain >/dev/null 2>&1 || true
deploy/compose-prod.sh stop app
deploy/compose-prod.sh up -d db
for i in $(seq 1 30); do deploy/compose-prod.sh exec -T db pg_isready -h 127.0.0.1 -q && break; [ "$i" = 30 ] && { echo 'db not ready' >&2; exit 1; }; sleep 2; done

# Refuse to rebuild an empty/unknown database: record the critical row count.
USERS=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from \"user\""')
[ "${USERS:-0}" -gt 0 ] || { echo 'no user rows before rebuild; aborting' >&2; exit 1; }
echo "pre-rebuild user rows=$USERS" | tee "$BK/pre-counts-$STAMP.txt"

# Full backup first; no -t (a TTY merges pg_dump warnings into stdout).
deploy/compose-prod.sh exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$BK/pre-e2-$STAMP.dump"
deploy/compose-prod.sh exec -T db pg_restore -l < "$BK/pre-e2-$STAMP.dump" > /dev/null
# TOC presence is not data: an empty dump still lists every table. Count the
# user rows inside the archive before dropping anything.
DUMP_USERS=$(docker exec -i db pg_restore -a -f - < "$BK/pre-e2-$STAMP.dump" 2>/dev/null | \
  bash deploy/backup/count-user-rows.sh)
[ "$DUMP_USERS" = "$USERS" ] || { echo "dump has $DUMP_USERS user rows, expected $USERS; aborting" >&2; exit 1; }

# Data-only file: column lists + FK triggers disabled inside the transaction.
{ echo 'BEGIN;'; echo 'SET LOCAL session_replication_role = replica;'; \
  deploy/compose-prod.sh exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only --column-inserts --no-owner --no-privileges -n public'; \
  echo 'COMMIT;'; } > "$BK/pre-e2-data-$STAMP.sql"
test -s "$BK/pre-e2-data-$STAMP.sql"
grep -q '^INSERT INTO' "$BK/pre-e2-data-$STAMP.sql" || { echo 'data dump has no rows; aborting' >&2; exit 1; }

# The suppression backfill runs after the drop; a bad key here would leave the
# app stopped with an empty schema. Check it while the old database is intact.
deploy/compose-prod.sh run --rm app node -e \
  "const s=(process.env.SUPPRESSION_HMAC_KEY??'').trim(); if(!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)||![43,44].includes(s.length)||Buffer.from(s,'base64').length!==32){console.error('SUPPRESSION_HMAC_KEY invalid');process.exit(1)}"

# Empty schema, fresh baseline, restore data. All psql runs inside the container
# so $POSTGRES_USER/$POSTGRES_DB are expanded there, never on the host.
deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "drop schema if exists drizzle cascade;" -c "drop schema if exists public cascade;" -c "create schema public;"'
deploy/compose-prod.sh run --rm app node bin/lair db migrate-prod
deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < "$BK/pre-e2-data-$STAMP.sql"
RESTORED=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from \"user\""')
[ "$RESTORED" = "$USERS" ] || { echo "restored user rows=$RESTORED, expected $USERS; aborting" >&2; exit 1; }

# Seed the fallback category only after the restore: running it before would
# insert a row the dumped categories data may already carry.
deploy/compose-prod.sh run --rm app node bin/lair site ensure-categories

# Backfills + verification run inside the image (host has no pnpm/tsx).
deploy/compose-prod.sh run --rm app node bin/lair db backfill-consent --apply
deploy/compose-prod.sh run --rm app node bin/lair db backfill-suppressions --apply
deploy/compose-prod.sh run --rm app node bin/lair db verify-suppression-version
deploy/compose-prod.sh run --rm app node bin/lair site ensure-schedules
deploy/compose-prod.sh run --rm app node bin/lair db verify-baseline
deploy/compose-prod.sh up -d
sudo systemctl start web-lair-drain.timer
deploy/compose-prod.sh start backrest || true
```

Requirements/notes:

- The backrest image must exist locally: `deploy/compose-prod.sh up` builds it
  when missing (registry + Alpine repo access), so build it explicitly after
  every deploy and after any `docker image prune`: `deploy/compose-prod.sh build backrest`.
- `SUPPRESSION_HMAC_KEY` must be present in `.env` before the backfills (they
  refuse unkeyed hashes; production boot checks it too).
- `SET LOCAL session_replication_role = replica` requires the compose Postgres
  superuser (the default `POSTGRES_USER` here). It disables FK triggers for the
  restore only; `--column-inserts` makes the dump immune to the two E2 columns.
- The data-only restore never touches `drizzle.__drizzle_migrations`: the fresh
  ledger written by `migrate.ts` must remain the only row.
- **tags are ASCII-only since 2026-10-23.** Before restoring a pre-taxonomy
  dump, audit the old rows (`select name, slug from tags where name !~ '^[A-Za-z0-9 .,+#&''()/_-]+$' or slug !~ '^[a-z0-9][a-z0-9._+~-]*$'`);
  a legacy CJK tag name aborts the data restore _after_ the schema drop (CHECKs
  are not disabled by `session_replication_role = replica`). Rename/drop those
  rows in the source dump first, or the restore will fail with `23514`.
- Verify output must show **49 tables / 119 indexes / 93 checks / 47 FKs**. If
  anything fails after the drop, **do not re-run §2.1**; restore the full
  `pre-e2-<stamp>.dump` per §3 and ask for review.

### 2.2 Provenance baseline rebuild (one-off, 2026-10-20)

The provenance window regenerated the single `0000_baseline.sql` again (six AI
provenance columns, three CHECKs, one FK, one partial FK index). The journal
timestamp is intentionally unchanged, so `scripts/migrate.ts` now exits 1 on a
pre-provenance database with the `[migrate] this database predates the provenance
baseline` message. Rebuild; do **not** hand-apply the baseline over a live schema.

Use the §2.1 sequence unchanged — stop timers/drain, pre-count users, full dump,
validate the dump, data-only dump, drop `public`/`drizzle`, `migrate.ts`, restore,
then verify — with these differences:

```bash
# 1. The image must already contain the provenance baseline.
docker run --rm --entrypoint node "$APP_IMAGE" -e \
  "const fs=require('node:fs'); if(!fs.readFileSync('drizzle/0000_baseline.sql','utf8').includes('\\\"writing_origin\\\"')){console.error('image predates provenance');process.exit(1)}"

# 2. After the data restore, re-apply the two test disclosures (idempotent).
#    Replace with an authoritative backfill list before the next restore.
psql ... -v ON_ERROR_STOP=1 -c "
  update posts set writing_origin='none', provenance_source='author', provenance_updated_at=now()
    where slug='welcome-to-lair' and writing_origin is distinct from 'none';
  update posts set writing_origin='mostly_ai', provenance_source='author', provenance_updated_at=now()
    where slug='real-data-ui' and writing_origin is distinct from 'mostly_ai';"

# 3. The post-provenance gate.
node bin/lair db verify-baseline   # 49 / 119 / 93 / 47
```

A pre-provenance full dump is a **different generation**: §3 detects it by the
absence of `posts.writing_origin` and skips `verify-baseline`; restore it with
the image tag that matches that dump.

## 3. Rollback

```bash
# code/image only (no schema change since the last rebuild)
deploy/compose-prod.sh up -d --no-build   # after APP_IMAGE points at the previous tag
```

If a migration ran (or a rebuild was performed): stop `app`, restore the
matching full dump, then start the previous image. Migration-before-backup is
forbidden (§4). Treat a dump and the image generation that wrote it as a pair:
a post-E2 dump is schema-compatible with the old image (the new table and
columns are additive), but the old code neither writes `email_suppressions`
nor `consent_version`, so running it over E2 data silently violates the E2
invariants. Do not mix generations.

```bash
set -euo pipefail
cd /srv/web-lair/app
# Compose reads APP_IMAGE from .env; pin it to the tag that matches the dump.
grep -Eq '^APP_IMAGE="?web-lair-app:' .env || { echo 'pin APP_IMAGE first' >&2; exit 1; }
export APP_IMAGE=$(grep -E '^APP_IMAGE=' .env | cut -d= -f2- | tr -d '"')
case "$APP_IMAGE" in *:local) echo 'APP_IMAGE=:local cannot identify a generation; pin the dump-matching SHA' >&2; exit 1;; esac
docker image inspect "$APP_IMAGE" > /dev/null
echo "restoring with APP_IMAGE=$APP_IMAGE"
DUMP=/srv/web-lair/pre-migrate/<matching-dump>.dump
USERS=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from \"user\""')
DUMP_USERS=$(deploy/compose-prod.sh exec -T db pg_restore -a -f - < "$DUMP" 2>/dev/null | \
  bash deploy/backup/count-user-rows.sh)
[ "$DUMP_USERS" = "$USERS" ] || { echo "dump has $DUMP_USERS user rows, expected $USERS; aborting" >&2; exit 1; }
sudo systemctl stop web-lair-drain.timer || true
sudo systemctl stop web-lair-drain.service || true
# Pause Backrest for the whole restore window (§4).
deploy/compose-prod.sh stop backrest || true
docker rm -f web-lair-drain >/dev/null 2>&1 || true
deploy/compose-prod.sh stop app
deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "drop schema if exists drizzle cascade;" -c "drop schema if exists public cascade;" -c "create schema public;"'
# -1/--single-transaction implies --exit-on-error: never leave a partial restore.
deploy/compose-prod.sh exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges -1 -e' \
  < "$DUMP"
# The dump may be pre-E2 (48 tables), pre-provenance (49 tables, E2, no
# writing_origin) or current. Probe both generation shapes and stop on
# anything else.
TABLES=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from information_schema.tables where table_schema = '\''public'\'' and table_type = '\''BASE TABLE'\''"')
HAS_E2=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select to_regclass('\''public.email_suppressions'\'') is not null"')
HAS_PROV=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select exists (select 1 from information_schema.columns where table_schema='\''public'\'' and table_name='\''posts'\'' and column_name='\''writing_origin'\'')"')
HAS_SECRETS=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select to_regclass('\''public.ai_provider_secrets'\'') is not null and to_regclass('\''public.webhook_secrets'\'') is not null"')
# Never key this gate on a table count (every migration changes it): the
# provenance-era schema is checked against the image journal by verify-baseline;
# older generations must run their matching image.
if [ "$HAS_SECRETS" = "t" ] && [ "$HAS_E2" = "t" ] && [ "$HAS_PROV" = "t" ]; then
  deploy/compose-prod.sh run --rm app node bin/lair db verify-baseline
elif [ "$TABLES" = "49" ] && [ "$HAS_E2" = "t" ] && [ "$HAS_PROV" = "t" ]; then
  deploy/compose-prod.sh run --rm app node bin/lair db verify-baseline
elif [ "$TABLES" = "49" ] && [ "$HAS_E2" = "t" ] && [ "$HAS_PROV" = "f" ]; then
  echo "restored pre-provenance schema (49 tables, E2, no writing_origin); verify-baseline skipped — use the matching pre-provenance image"
elif [ "$TABLES" = "48" ] && [ "$HAS_E2" = "f" ]; then
  echo "restored pre-E2 schema (48 public tables); verify-baseline skipped"
else
  echo "unexpected restore shape (tables=$TABLES e2=$HAS_E2 provenance=$HAS_PROV secrets=$HAS_SECRETS); refusing to start" >&2
  exit 1
fi
deploy/compose-prod.sh up -d
sudo systemctl start web-lair-drain.timer
deploy/compose-prod.sh start backrest
```

If §2.1 failed after the schema drop, **do not re-run it**; restore the
`pre-e2-<stamp>.dump` exactly as above and ask for review. Never restore a
pre-E2 dump into a schema that already has E2 tables without dropping it first:
`pg_restore` without `--clean` fails on existing objects, and `--clean` leaves
`email_suppressions` behind because it is absent from the old dump.

**Code-only rollback across E2 is not symmetric.** The pre-E2 image writes
subscriptions without `consent_version` and opt-outs without
`email_suppressions`; after rolling back and later re-deploying E2, run the
three idempotent backfills again (§8) before enabling mail. Otherwise historical
opt-outs can become mailable and new rows keep a NULL consent version.

### 3.1 Auth keyring and OAuth token encryption (W1.5)

`src/lib/server/auth.ts` enables better-auth's official
`account.encryptOAuthTokens`. New OAuth access/refresh tokens are stored as
`$ba$<key-version>$<hex>` envelopes (XChaCha20-Poly1305 keyed by the auth
secret) when the keyring is set, and as bare hex otherwise; the `account` table
layout is unchanged. Legacy plaintext rows keep working — better-auth only
decrypts values that look encrypted (`$ba$...` or a bare even-length hex
string) — so no backfill is needed: a token is rewritten the next time that
account signs in or refreshes. (GitHub tokens are `gho_`/`ghu_`-prefixed, so
they are never mistaken for ciphertext.)

`BETTER_AUTH_SECRETS` is the optional keyring:

| Value               | Meaning                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset               | Every value is keyed by `BETTER_AUTH_SECRET` alone; encrypted tokens are **bare hex**, no envelope                                                             |
| `"2:<new>,1:<old>"` | New writes use version 2; values carrying `$ba$1$...` stay readable; `BETTER_AUTH_SECRET` remains the legacy key for values written before the keyring existed |

**Before touching the keyring, note what else it keys:**

- The first entry is also the **session cookie / JWT signing secret**
  (`create-context.mjs`: `secret = secrets[0].value`). Adding or rotating a
  version signs every current user out on restart — not a zero-downtime
  operation.
- It wraps **2FA/TOTP secrets** as well as OAuth tokens. TOTP secrets are
  written once and never rewritten, so a version that wrote one must stay in
  the list for that account's lifetime (or the owner re-enrolls 2FA first).
  Dropping it makes decryption fail closed and locks that account out of
  email + TOTP — the remaining admin path.
- Keep `BETTER_AUTH_SECRET` **set** while any bare-hex values exist: it is the
  `legacySecret` that decrypts them when no envelope is present.

Rotation has three phases: prepend the new version and restart (sessions are
reissued) -> wait until no _OAuth token_ still needs the old version -> drop
it, **unless a stored TOTP secret still needs it**. Dropping a version makes
values written under it unreadable (fail-closed: sign-in/decrypt errors, no
silent plaintext fallback).

Verification (prints counts only, never a token; the script ships in the
runtime image, `Dockerfile`):

```bash
deploy/compose-prod.sh run --rm app node bin/lair secrets verify-oauth-tokens
```

Exit 0 means every stored OAuth token is encrypted (or none exist). Exit 1
means plaintext rows remain (expected right after the switch, green after the
affected accounts sign in again) **or the script itself failed** — its
`query failed` line distinguishes the two; do not read every exit 1 as
"plaintext remains".

Rollback:

- **Preferred: keep the new image and fix forward.** Rotating the keyring back
  is safe as long as the version that encrypted the rows stays in the list.
- **Image rollback after tokens were encrypted is not symmetric.** The older
  image has `encryptOAuthTokens` off, so it hands `$ba$...` strings to the
  GitHub API and those accounts fail until they sign in again (a fresh OAuth
  callback writes a new token) — or until the pre-deploy dump is restored.
  Budget one re-sign-in per affected account, and do not restore a
  pre-encryption dump unless every row written after it can be lost.

### 3.2 Admin/GitHub sign-in policy (W1.6)

GitHub can no longer mint an admin/owner session (`user.validateUserInfo`
rejects it with `admin_github_sign_in_blocked`; the refusal is logged as
`[auth] admin GitHub sign-in blocked`). Email + TOTP or a passkey remain; the
passkey sign-in UI lands with W8, so email + TOTP is the available admin path
today. The tailnet owner hand-off (loopback/tailnet identity) is a separate,
registered path.

Sessions minted through GitHub **before** this deploy are not distinguishable
after the fact (the session row stores no login method) and keep their role
until they expire or are pruned. To enforce the policy immediately, revoke
every admin/owner session once after the deploy:

```bash
deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
delete from session where user_id in (select id from "user" where role in ('owner', 'admin'));
SQL
```

This logs the admins out once; their next email + TOTP (or passkey) sign-in
re-establishes the session under the new policy. No schema change is involved.

### 3.3 Password hashing and rollback (W8.8)

New credential hashes use Argon2id (`$argon2id$...`) through better-auth's
official `emailAndPassword.password` hooks. Verification is format-aware:
pre-rollout better-auth scrypt rows (`<32-hex salt>:<128-hex key>`) still
verify, and an Argon2id row written by this release stays verifiable.

To roll new hashes back to better-auth's legacy scrypt format:

1. Set `PASSWORD_HASH_ALGO=scrypt` in `.env`.
2. Restart the app container.
3. Keep the setting until the next password change; existing Argon2id rows
   keep working either way, so there is no lockout and no schema migration.

The default (`PASSWORD_HASH_ALGO` unset or `argon2id`) is the recommended
state. Node 24+ is required because Argon2id uses `node:crypto` `argon2`
(`engines.node` enforces it).

## 4. Backups (D-4)

Two repositories with two passwords (T3-A, secrets register §0.1).

**Who runs what (M6 P2).** The schedule belongs to Backrest (the `backrest`
service in `compose.prod.yaml`, UI on `127.0.0.1:9898`); the systemd backup
timers no longer carry a schedule. The dump still comes from
`deploy/backup/backup.sh --dump-only`, which Backrest runs as its
`CONDITION_SNAPSHOT_START` hook — so the gates described below run on every
scheduled night, and a dump that fails them cancels the operation instead of
being snapshotted. Running `deploy/backup/backup.sh` itself (full mode) is the
manual/fallback path; do not run it while Backrest is up: two writers on one
repository only fight over the lock.

**Data repository** — `RESTIC_REPOSITORY`:

1. `pg_dump -Fc` → staging dir on the host (logical backup; never file-copy a
   running data directory).
2. `$DATA_DIR` (user job scripts + sidecars).
3. RustFS volume (media), mounted read-only into the backup container.

**Config repository** — `RESTIC_CONFIG_REPOSITORY`, **different password**:

4. `.env` only, as a single file. It is never part of the data repository:
   `.env` holds `BETTER_AUTH_SECRET`, `SUPPRESSION_HMAC_KEY` and the database
   password, so a leaked data repository (and its password) must not decrypt
   the application secrets. `deploy/backup.env` is backed up nowhere — it holds
   both repository passwords; keep those in the password manager with an
   **offline** copy (losing one makes its repository unreadable).

```bash
# manual / fallback run (the scheduled path is Backrest, §4.4). The unit is
# still valid; its timer is not.
sudo deploy/compose-prod.sh stop backrest          # never two writers on one repo
sudo systemctl start web-lair-backup.service       # EnvironmentFile = deploy/backup.env
# or, without systemd:
# set -a; . deploy/backup.env; set +a; sudo deploy/backup/backup.sh
sudo deploy/compose-prod.sh start backrest
# sudo: the scheduled hook runs as root inside the container and writes
# root-owned pg.dump into $BACKUP_DIR, so an unprivileged run cannot replace it
# (and a `Permission denied` here is that, not a broken script).

# one-time: create both repositories, each with its own password.
# Backrest also initialises them by itself (autoInitialize), so this step is the
# way to validate the credentials BEFORE the first scheduled night.
set -a; . deploy/backup.env; set +a
# `-e VAR` (no value) forwards the loaded value. Never `-e VAR=$VALUE`: that puts
# the repository password in argv (visible to `ps`) and in ~/.bash_history.
docker run --rm -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  restic/restic:0.19.1 --repo "$RESTIC_REPOSITORY" init
( export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"
  docker run --rm -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
    restic/restic:0.19.1 --repo "$RESTIC_CONFIG_REPOSITORY" init )
```

### 4.1 Migrating a pre-split repository (one-off)

A repository created by the old `backup.sh` holds snapshots whose path set includes
`/config` (`.env` in the data repository). `--group-by paths` gives that path set
its own forget group, so the new nightly snapshots never age those old ones out —
the historical `.env` copies would stay readable with the data-repository password.

```bash
set -a; . deploy/backup.env; set +a
# list the path set of every snapshot; old ones show "/config"
docker run --rm -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  restic/restic:0.19.1 --repo "$RESTIC_REPOSITORY" snapshots --json \
  | grep -o '"paths":\[[^]]*\]'
# after checking each id (destructive: prunes the data those snapshots own)
docker run --rm -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  restic/restic:0.19.1 --repo "$RESTIC_REPOSITORY" forget <ids> --prune
```

The drill below asserts "no `.env` in **any** data snapshot", so before this
migration it fails by design — that failure is the confirmation that old snapshots
exist, and the list above tells you which ids to forget.

Credentials come from `deploy/backup.env` (mode 600, loaded by the systemd
unit — never from `.env`, so the app container cannot read them).

The script dumps PG to a temp file, validates it with `pg_restore -l`, swaps it
over `pg.dump` (a failed night never truncates yesterday's good copy), resolves
the RustFS volume from the running container, then runs restic with
`--retry-lock 30m` and the retention policy: data keeps 7 daily / 4 weekly /
6 monthly, config 30 daily / 12 monthly. Pre-migration dumps live in
`/srv/web-lair/pre-migrate` — **outside** the restic source paths, pruned by
age, so deploy count does not grow the backup repo.

- Periodic integrity: the repositories' `checkPolicy` (rendered config) runs
  `restic check` — data repo weekly with `--read-data-subset 5%`, config repo
  monthly with a full read — and pings `CHECK_PING_URL` / `CHECK_PING_URL_CONFIG`
  only on success. The systemd check timer no longer carries a schedule (§6).
- Monthly drill: restore to a **separate** directory and, for PG, into a
  **scratch** database on a different port; compare row counts and sample media
  hashes. The drill never touches the production database. It also proves the
  config split still holds:

  ```bash
  set -euo pipefail
  DRILL=$(mktemp -d); trap 'rm -rf "$DRILL"' EXIT
  set -a; . deploy/backup.env; set +a
  R=restic/restic:0.19.1
  # `-e VAR` (no value) forwards the exported value: no password ever enters argv.
  restic_data() { docker run --rm -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY "$R" --repo "$RESTIC_REPOSITORY" "$@"; }
  restic_conf() { docker run --rm -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY "$R" --repo "$RESTIC_CONFIG_REPOSITORY" "$@"; }

  # 1. no snapshot in the data repository may contain a .env (collect first:
  #    a failed listing must not read as "no .env found")
  ids=$(restic_data snapshots --host web-lair --json | grep -oE '"short_id":"[0-9a-f]+"' | cut -d'"' -f4) \
    || { echo 'FAIL: cannot list the data repository'; exit 1; }
  [ -n "$ids" ] || { echo 'FAIL: data repository has no snapshots'; exit 1; }
  for id in $ids; do
    if restic_data ls --host web-lair "$id" | grep -qE '(^|/)\.env$'; then
      echo "FAIL: .env is inside data snapshot $id"; exit 1
    fi
  done
  echo 'OK: no .env in any data snapshot'

  # 2. the config repository restores a byte-identical .env
  ( export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"
    docker run --rm -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
      -v "$DRILL":/restore "$R" --repo "$RESTIC_CONFIG_REPOSITORY" \
      restore --host web-lair-config latest --target /restore )
  cmp "$DRILL/config/.env" .env && echo 'OK: config restored'

  # 3. the data password must NOT open the config repository — and the refusal
  #    must be a password rejection, not a network error with the same exit code
  if restic_conf snapshots >/dev/null 2>"$DRILL/err"; then
    echo 'FAIL: config repository opened with the data password'; exit 1
  fi
  grep -qiE 'wrong password|no key found' "$DRILL/err" \
    || { echo 'FAIL: unexpected error, not a password rejection'; cat "$DRILL/err"; exit 1; }
  echo 'OK: repository passwords are separate'
  ```

  Keep the receipt (date, snapshot ids, `cmp` result) with the ops notes.

- A failed backup must fail **its own** check: `BACKUP_PING_URL` is pinged only
  on success and is deliberately separate from the 5-minute liveness URL
  (`DEADMAN_PING_URL`) — sharing one check would make a silent backup failure
  invisible on the next liveness tick.

### 4.2 Restoring encrypted runtime credentials (W2.10)

`ai_provider_secrets` and `webhook_secrets` are AES-256-GCM ciphertext under
`SECRETS_KEYS`. The key is in the **config** repository (`.env`); the ciphertext
is in the **data** repository. Restore order matters:

1. Restore the config repository first: `SECRETS_KEYS` and
   `SECRETS_KEY_ACTIVE` must be in `/srv/web-lair/app/.env` before the app
   starts. A missing/mismatched key is reported as `store_unavailable` /
   `decrypt_failed`; there is no plaintext fallback.
2. Restore the data repository (database dump, `$DATA_DIR`, media).
3. Start the app and verify: a provider probe on `/admin/settings/ai` must
   authenticate, and a webhook delivery must carry a valid signature.
4. Keep every key version that a retained backup may still reference. Retiring
   a version makes dumps from before the rotation unreadable by design
   (`scripts/verify-secret-key-versions.ts`, three-phase rotation).

| Have                                    | Result                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DB dump only                            | Every encrypted column fails with `decrypt_failed`/`unknown_key_version`; provider keys and webhook signing secrets are unrecoverable without the key. |
| Keyring only                            | No ciphertext to decrypt. The `.env` is still a full infrastructure secret (DB password, auth secret).                                                 |
| Both, same rotation                     | Credentials work; no re-entry needed.                                                                                                                  |
| Both, dump older than a retired version | Rows written under the retired version fail closed. Keep the old version in the keyring for the backup retention window.                               |

`SECRETS_KEY` (single key, version 1) is the legacy form; do not use it for new
installs. `SECRETS_KEYS` is not derived from `BETTER_AUTH_SECRET`: rotating the
auth keyring must never destroy the credential store.

#### Rollback window (webhook backfill)

Migrations 0001/0002 are additive (two new tables; `webhooks.secret` becomes
nullable). The **data** step is the one-way edge:

| Point in time                                                             | Image rollback    | Notes                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| After `migrate` (0001/0002), **before** `migrate-webhook-secrets --apply` | Safe              | Old code reads/writes the legacy `webhooks.secret`; the new tables are ignored. **0002 is data-dependent:** the first endpoint created by the new image has no legacy secret, so from then on `SET NOT NULL` cannot be restored and roll-forward is the only path. |
| After `migrate-webhook-secrets --apply`                                   | **Not safe**      | The old drain selects the legacy column, which is NULL, and throws in `signingKey()` (`null.startsWith`) on every tick: queued rows stay queued while the segment errors. Roll forward (keep the new image) or restore the pre-backfill dump.                      |
| After the new image has run                                               | Roll forward only | The new drain reads `webhook_secrets` first and falls back to the legacy column; an old image cannot read the encrypted rows.                                                                                                                                      |

Keep `SECRETS_KEYS` and the encrypted rows together: an image rollback without
the keyring turns every stored credential into `decrypt_failed`.

### 4.3 Retire the legacy webhook secret (W2.6, one-way data step)

Migrations 0001/0002 are additive and reversible; moving the plaintext value
into `webhook_secrets` is not. Do it in this order:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# 1) Dump immediately before the data step (this is the only undo).
sudo -u deploy docker compose -f compose.prod.yaml exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "/srv/web-lair/pre-webhook-backfill-$STAMP.dump"

# 2) Dry run: prints every endpoint that would move, writes nothing.
deploy/compose-prod.sh run --rm app node bin/lair db migrate-webhook-secrets

# 3) Apply. All rows move in ONE transaction; on any conflict/round-trip
#    failure it rolls back and no plaintext is retired.
deploy/compose-prod.sh run --rm app node bin/lair db migrate-webhook-secrets --apply

# 4) Prove idempotence and no plaintext left for a migrated endpoint.
deploy/compose-prod.sh run --rm app node bin/lair db migrate-webhook-secrets   # "nothing to migrate"
deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from webhooks where secret is not null"'
```

Record the dump name next to the rollback table above. The script is run with
`node` (the container image has no `tsx`); the `pnpm ops db migrate-webhook-secrets`
form is for a dev checkout only. A non-zero exit now means "rolled back, still
safe" — there is no partial state.

### 4.4 Backrest: UI, schedules, failure semantics

The `backrest` service renders `/config/config.json` on first start from the
environment (`deploy/backrest/entrypoint.sh`), which is why the hooks and the
maintenance schedules are reviewable in git instead of living only inside a
volume.

| Knob — set in `.env` (compose interpolation), **not** `deploy/backup.env` | Default                   |
| ------------------------------------------------------------------------- | ------------------------- |
| `BACKREST_DATA_CRON` (nightly data snapshot)                              | `0 30 3 * * *`            |
| `BACKREST_CONFIG_CRON` (`.env` → config repository)                       | `0 40 3 * * *`            |
| `BACKREST_CHECK_CRON` (data repo `check --read-data-subset`)              | `0 30 4 * * 0` (Sunday)   |
| `BACKREST_CONFIG_CHECK_CRON` (config repo, full read)                     | `0 0 6 1 * *` (monthly)   |
| `BACKREST_PRUNE_CRON`                                                     | `0 0 5 * * 0` (Sunday)    |
| `BACKREST_TZ`                                                             | `UTC`                     |
| `BACKREST_RENDER_CONFIG`                                                  | unset; `force` re-renders |

- Cron is Backrest's 6-field format (seconds first) evaluated in `BACKREST_TZ`.
  `03:30` therefore means 03:30 **UTC** unless TZ is changed — deliberate: a host
  timezone change must not silently move the backup. A 5-field (systemd-style)
  value is rejected at render time instead of being accepted as "never fires".
- The rendered file wins after the first start, so UI edits survive a restart.
  A `*_CRON` change in `.env` needs `BACKREST_RENDER_CONFIG=force` once
  (`deploy/compose-prod.sh up -d backrest`) before it takes effect.
- **Network isolation (review P0).** Backrest listens on `0.0.0.0:9898` inside
  the container with `auth.disabled`, and its hooks are shell commands — so any
  container that can route to it can execute commands in the container that holds
  both restic passwords. It therefore has two networks and shares neither with
  anything but `db`: `backup` (members: db, backrest) and `backrest_egress`
  (backrest only, outbound). The shared `egress` bridge is deliberately **not**
  used — whisper sits on it and on `internal`, which the app can reach.

  Verify (the first must fail _because the name does not resolve_; an absent
  `curl` would also exit non-zero and prove nothing, hence `getent`):

  ```bash
  deploy/compose-prod.sh exec -T app sh -c 'getent hosts backrest || echo unreachable'
  deploy/compose-prod.sh exec -T whisper sh -c 'getent hosts backrest || echo unreachable'
  deploy/compose-prod.sh exec -T backrest pg_isready -h db    # positive control
  ```

- UI access is the **host-side loopback publish** (`127.0.0.1:9898`) through an SSH
  tunnel: `ssh -L 9898:127.0.0.1:9898 <host>` then <http://127.0.0.1:9898>.
  Whoever can forward that port is root-equivalent over the backups (no auth);
  before exposing it anywhere else, add a bcrypt user
  (`htpasswd -nbBC 10 admin '<password>'`) to `auth.users` in
  `deploy/backrest/entrypoint.sh` and re-render.
- **`.env` is a single-file bind mount, so it is inode-bound**: after any edit
  (`sed -i`, editor atomic write, `mv`) the container keeps reading the OLD file
  until it is recreated. Rotation therefore ends with
  `deploy/compose-prod.sh up -d --force-recreate backrest`, otherwise the config
  repository keeps snapshotting the pre-rotation secrets while everything stays
  green. `DATA_DIR` must be an absolute path (the same mount), and a
  `POSTGRES_PASSWORD` that differs between `.env` and `deploy/backup.env` makes
  `up` refuse to start (`deploy/compose-prod.sh`).
- The rendered `config.json` holds both repository passwords in plaintext
  (Backrest's storage model): the file is written mode 0600 into the
  `backrest_config` volume, it is never in git and never inside either
  repository.
- Logs: `deploy/compose-prod.sh logs backrest`; per-run hook output is in the UI
  and prefixed `[script]` / `[output]`. A malformed rendered config is loud and
  fail-closed: the container exits with `FATAL error loading config … unexpected
token` naming the line, so a bad edit in `entrypoint.sh` cannot silently become
  "no backups".

**Switch procedure (one-off, on the target host):**

```bash
cd /srv/web-lair/app
# The derived image is built locally (see §4.4); a bare `up` would build it too,
# which needs registry + Alpine repo access. Do it explicitly while the old
# schedule is still running, so a failed build changes nothing.
deploy/compose-prod.sh build backrest
sudo systemctl disable --now web-lair-backup.timer web-lair-backup-check.timer
# the unit files stay in /etc/systemd/system (history); their [Timer] sections
# are gone in the repo, so re-copying them cannot re-arm a second schedule
deploy/compose-prod.sh up -d backrest
deploy/compose-prod.sh logs --tail 30 backrest      # expect "rendered /config/config.json"
curl -fsS http://127.0.0.1:9898/ > /dev/null && echo ui-ok
# one real run, then confirm the dedicated check went green:
curl -fsS -X POST 127.0.0.1:9898/v1.Backrest/Backup \
  -H 'Content-Type: application/json' --data '{"value":"lair-nightly"}'
```

**Failure semantics (why a green check means something).**
`CONDITION_SNAPSHOT_START` is wired `ON_ERROR_CANCEL`: a dump that fails any gate
(truncated archive, empty `user` block, unwritable `$BACKUP_DIR`), or a data tree
that did not mount at all (`/lair-data`, `/lair-rustfs`), cancels the operation
and no snapshot is written. `CONDITION_SNAPSHOT_END` withholds the success ping
unless **all** of these hold: the run reported no error, Backrest handed over a
snapshot id (a production-only run proves nothing about an uploaded snapshot),
the staging dump is newer than the run marker the start hook wrote, it is under
`BACKUP_PING_MAX_AGE_MIN` (default 24 h), and `pg_restore -l` can read it. It
sends `<BACKUP_PING_URL>/fail` instead. The config plan's start hook is
`ON_ERROR_FATAL` (a missing or _empty_ `.env` value must fail loudly, not cancel
quietly) and its END hook reports on `CONFIG_PING_URL`, a second check on
purpose: one URL for both repositories would let a green data run mask a red
config run. The repository `checkPolicy` keeps the periodic `CHECK_PING_URL` /
`CHECK_PING_URL_CONFIG` alive through `deploy/backup/hook-check-end.sh`.

### 4.5 Restore drill script (quarterly, and after any backup change)

`deploy/restore-drill.sh` replaces the hand-run part of the drill above:

```bash
cd /srv/web-lair/app
set -a; . deploy/backup.env; set +a
deploy/restore-drill.sh --receipt /srv/web-lair/drills/$(date +%F).txt
```

It restores the newest snapshot of both repositories into a scratch directory,
starts a `postgres:18` container (no published port, removed on exit),
`pg_restore`s the staging dump into it, compares row counts with the live
database (read-only), runs `deploy/backup/orphan-check.sql` over every foreign
key (F-22: the restore path disables FK triggers, so "exit 0" proves nothing),
compares N media objects byte-for-byte against the live RustFS volume and prints
`rto_seconds` / `rpo_seconds` plus the snapshot ids.

- `--compare-live` turns "restored fewer rows than live" into a failure. It is
  only meaningful with writes frozen (a maintenance window right after a backup):
  any signup or comment since the snapshot makes live bigger than restored, and
  that is drift, not a bad backup. Without the flag the difference is a warning.
- `--sample N` changes the media sample size (default 5), `--keep` leaves the
  scratch tree and the drill database for inspection.
- Local-repository rehearsal (no offsite credentials — what the M6 P2 rehearsal
  used):

```bash
DRILL_LOCAL_REPO_DIR=/srv/drill/repos \
RESTIC_REPOSITORY=/repos/lair-data RESTIC_CONFIG_REPOSITORY=/repos/lair-config \
deploy/restore-drill.sh
```

### 4.6 External media provider (W7) and the restore drill

**What backs up what.** Database and config stay restic repositories (§4); the
media objects follow the provider:

| Data                    | Backup path                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| Postgres (all metadata) | restic data repository — `pg_dump -Fc`                                  |
| `.env` (secrets)        | restic config repository, different password                            |
| Bundled RustFS volume   | restic data repository (compose volume, read-only mount)                |
| External S3 bucket      | provider versioning/replication **or** `rclone sync` to a second bucket |

Versioning is not a backup: it protects against a wrong delete, not against
account loss, a compromised key or a deleted bucket. Keep one copy the app
cannot reach (different account or credentials).

**Switching providers** (`/admin/settings/storage`, owner only). Uploads are
frozen and purge refuses while the copy runs, so pick a quiet window:

```bash
# 1) Save the target on the page and run Test (HeadBucket + capability probe).
# 2) Plan: HEADs both buckets, refuses if a registered object is missing.
pnpm ops storage migrate --dry-run
# 3) Copy with a two-ended hash proof (resumes by verifying, never rewriting).
pnpm ops storage migrate --yes
# 4) Cut over, then remove the old bucket when the evidence is in hand.
pnpm ops storage migrate --cutover
pnpm ops storage migrate --status
# Rollback is symmetric and leaves the new objects in place:
pnpm ops storage migrate --rollback
```

A cutover is refused unless: a complete copy of exactly this target exists
(when `files` > 0), and the bucket's versioning/object lock are off — or the
provider is explicitly set to **logical delete** (deletes become delete
markers; space is not reclaimed).

Provider support is tiered (decision Q11): **Tier 1 = AWS S3, Cloudflare R2,
MinIO** — the tested matrix (`providerType` aws-s3 / r2 / minio).
**Tier 2 = B2, Wasabi, Spaces** are best-effort: run the connection test and
one real upload before trusting them, and treat a failure there as a provider
gap rather than a bug in this app.

After a cutover, re-publish the map tiles — `maps/*.pmtiles` are not `files`
rows, so the migration does not carry them:

```bash
pnpm ops maps publish           # against the now-active provider
```

**Restore drill** (quarterly, and before trusting a new repository). Run
`deploy/restore-drill.sh` (§4.5) first — it automates the data/config restore
and the scratch-DB load — then complete the app-level checks by hand:

4. Prove the credentials still decrypt (the keyring must come with the
   encrypted rows): start the app against the scratch DB with `.env` restored,
   open `/admin/settings/storage` and check the credential source + key version.
5. Prove media: `pnpm ops media audit` against the active provider lists
   missing objects; a known `/i/<key>` must answer 200, a deleted one 404.

Evidence per drill: dump name + timestamp, baseline gate output, credential
source/key version from the page, `/i` status for one live and one deleted key,
and how long the drill took (RTO) — the page's read-only Database block shows
the mode, masked host and applied-migration count after the restore.

## 5. Monitoring

| What                                       | Where                                                                                                                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS homepage / hostname / cert expiry    | Gatus `site-tls` — **requires `SITE_DOMAIN`** (unset ⇒ not rendered). Admin **login page over HTTPS is not monitored**; only the internal `/admin` 303 guard is.                                                                             |
| Postgres TCP / RustFS TCP                  | Gatus (internal network; TCP accept only, not a health check)                                                                                                                                                                                |
| App routes / `/admin` guard / `/api/ready` | Gatus (internal, direct to `app:3000`); `/api/ready` answers 200 only with `READY_TOKEN`, 404 otherwise                                                                                                                                      |
| Drain heartbeat                            | Gatus external endpoint — **not wired yet** (requires the POST+Bearer change, README §8)                                                                                                                                                     |
| Box-external HTTP + dead-man               | healthchecks.io + UptimeRobot (`HC_DEADMAN_URL` wired; backup/config/check pings are owned by the backup stack — §5.1)                                                                                                                       |
| Disk / memory thresholds                   | `system.resources` job: 85% warn / 75% clear per mount + cgroup memory, one alert per metric per day via `notify()`; pings `HEALTHCHECKS_RESOURCES_URL` (`/fail` while latched, on a collection error, or when the latch file is unwritable) |
| SMTP transport                             | `mail.probe` job: daily `verify()`, one real Sunday mail to the owner; pings `HEALTHCHECKS_MAIL_URL` on failure                                                                                                                              |

In-box monitoring is Gatus (config-as-code, M6 P3); setup and the full env
list live in `deploy/monitoring/README.md`. Bark alerts stay off until
`BARK_URL` is set; `SITE_DOMAIN` gates the TLS/domain checks. Gatus UI is
`127.0.0.1:8080` (SSH tunnel only; loopback-bound). **Uptime Kuma is still
defined in `compose.prod.yaml`** (plus its `kuma_data` volume) until the
cutover window. Cutover order — do not reverse it: (1) with Kuma notifications
still ON, set `BARK_URL` and make one real failure happen; confirm the device
receives `TRIGGERED` and `RESOLVED` (duplicates are expected); (2) disable
every Kuma notification in its UI; (3) stop Kuma and soak 24h; (4) delete the
service and volume.

**What is _not_ monitored yet:**
the drain heartbeat endpoint (`jobs-drain`) exists in Gatus but is only rendered
when `DRAIN_HEARTBEAT_TOKEN` is set, and the drain still sends a plain GET to
`JOBS_HEARTBEAT_URL` (Kuma shape) — see `deploy/monitoring/README.md` §8. Until
that changes, **do not set `DRAIN_HEARTBEAT_TOKEN`** (an un-pinged external
endpoint alerts by design) and keep the Kuma/healthchecks drain check as the
liveness signal. Admin **login over HTTPS** is likewise not watched: only the
internal `/admin` 303 guard is.

### 5.1 healthchecks checks owned by the backup stack (M6 P2)

| Variable                | Fires on                                                  | Check period    |
| ----------------------- | --------------------------------------------------------- | --------------- |
| `BACKUP_PING_URL`       | data plan END, only when a validated dump was snapshotted | 1 day + grace   |
| `CONFIG_PING_URL`       | config plan END (the `.env` copy)                         | 1 day + grace   |
| `CHECK_PING_URL`        | data repo `checkPolicy` (weekly, `--read-data-subset 5%`) | 7 days + grace  |
| `CHECK_PING_URL_CONFIG` | config repo `checkPolicy` (monthly, full read)            | 31 days + grace |
| `DEADMAN_PING_URL`      | `web-lair-deadman.timer` (5-minute liveness)              | 5 minutes       |

All five are unset-tolerant (the hook logs and skips), so a fresh install without
healthchecks does not fail every run.

**P3 handoff:** the P3 task list says "deadman (5m), backup, optional external
HTTP" — the backup stack alone now owns four of these, and `CHECK_PING_URL`
changed owner (systemd weekly unit → Backrest `checkPolicy`). Do not copy the
old timer's period; use the table above.

Kuma setup: create monitors, then paste the push URL into `JOBS_HEARTBEAT_URL`
(Kuma expects `.../api/push/<key>?status=up&msg=OK`).

### 5.2 Traffic analytics (Sentinel)

`deploy/monitoring/compose.sentinel.yaml` adds a traffic-only Sentinel
container. It is on the `internal` network, publishes no host port, mounts the
Caddy JSON log read-only, keeps no IPs (`TRAFFIC_IP_MODE=off`), and stores its
derived SQLite data in the `sentinel_data` volume. `SENTINEL_TOKEN` is generated
by `bootstrap-secrets.sh`; the app reads it with `SENTINEL_URL=http://sentinel:8888`.
Sentinel 1.1.5 constructs a Docker client even with collectors disabled, so the
entrypoint creates a zero-byte `/tmp/not-a-docker.sock` and points `DOCKER_HOST`
at it; the host Docker socket is never mounted.

```bash
deploy/compose-prod.sh ps sentinel                 # expect (healthy)
deploy/compose-prod.sh logs --tail=50 sentinel     # traffic service ready...
bash deploy/verify-observability.sh --receipt /tmp/obs-receipt.json
```

The verify script runs four probes: health, log parsing (a synthetic path must
rise in `/api/traffic/paths`), retention (48 h/30 d/395 d tiers + a 30-bucket
series), and reconciliation (one closed minute of Sentinel requests vs Caddy
log lines, default ≤10% deviation). It reads `SENTINEL_TOKEN` from `.env` and
never prints it. The default probe path is `/robots.txt` (2xx, static, excluded
from the PV filter); override with `OBS_PROBE_PATH` if the site serves a
different static file. Probe traffic appears in the all-request totals for its
run, but it creates no page requests or 404s.

Sentinel tails the log from EOF: lines written while it was stopped (restart,
deploy, crash) are not ingested later, and there is no backfill. Plan changes
that matter for traffic during a quiet window.

`/admin/analytics` labels the filtered count **page requests**: paths under
`/_app/`, `/i/`, `/api/` and static extensions are excluded. Sentinel caps its
per-window top-N (`TRAFFIC_TOPN`, the 1.1.5 default 50 here); paths outside the cap fold into
`__other__`, so the page-request total is a lower bound and the UI says so.
The exact 404 count comes from the status breakdown; per-path rows expose only
the 4xx class.

### 5.3 Readiness probe (`/api/ready`, M6 P4 / F-10)

`/api/health` is **liveness** (never touches dependencies, used by the container
supervisor). `/api/ready` is **readiness**: `select 1` on PG plus a Valkey `PING`
when `VALKEY_URL` is set, 2 s timeout, 10 s per-process cache.

| Caller                   | Behaviour                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| With `READY_TOKEN` set   | `Authorization: Bearer <token>` is required from **every** caller; wrong/missing → `401 {"status":"unauthorized"}`. The private-peer shortcut is disabled in this mode. |
| Production, no token     | 404 to every caller (fail closed). `X-Forwarded-For` is caller-forgeable, so "private peer" is not a credential.                                                        |
| Non-production, no token | loopback/RFC 1918/ULA/link-local only; everyone else 404.                                                                                                               |
| At the public edge       | `deploy/Caddyfile` answers 404 for `/api/ready` regardless — the token is the second fence, not the only one.                                                           |

Response: `200 {status:'ready', db:'ok', valkey:'ok'|'disabled'}` or
`503 {status:'not_ready', …}` with per-check `ok`/`fail`/`timeout`/`disabled`.

```bash
# from the box (container-internal address; the token never goes to the public edge)
deploy/compose-prod.sh exec app sh -lc \
  'wget -qO- --header="Authorization: Bearer $READY_TOKEN" http://127.0.0.1:3000/api/ready'
```

Gatus covers it as `app-ready` — but only when `READY_TOKEN` is set:
`render-config.sh` renders `zz-app-ready.yaml` from
`deploy/monitoring/fragments/app-ready.yaml` when the token is non-empty and
removes it otherwise (an unconditional endpoint would be permanently red on an
install that never configured the token). Verify both directions with
`bash deploy/monitoring/verify-config.sh`.

### 5.4 Resource thresholds (F-7) and the mail probe (F-10)

`system.resources` (every 15 min) reads **the real data volume and the
container's cgroup limit**, not `process.cwd()` / host `os.freemem()`:

| Metric                                     | Source                                                                                                                                                                                     | Warn at    | Clear at   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------- |
| `disk` per mount (`DATA_DIR`, `/`, others) | `statfs` on the mounted path                                                                                                                                                               | **≥ 85 %** | **≤ 75 %** |
| `memory`                                   | cgroup v2 `memory.current` / `memory.max`; missing files (v1 host, dev, no limit) report **not observable** instead of a host number; `max` = unlimited reports usage with `percent: null` | **≥ 85 %** | **≤ 75 %** |

- Hysteresis: a metric between 75 % and 85 % keeps its latch — it neither
  re-alerts nor clears. One alert per metric per **UTC day** (`alertDay` survives
  a clear on purpose).
- Alert path: `notify()` seam → outbox (`system.disk_high` / `system.memory_high`
  in the `ops` preference group) **and** `HEALTHCHECKS_RESOURCES_URL` (`/fail`
  while latched, on a collection error, or when the latch file is unwritable).
  A probe that cannot write its own state counts as a failure — silently losing
  the latch is exactly the failure mode F-7 exists to prevent.
- State file: `$DATA_DIR/system-resources-state.json` (uid 1000 must be able to
  write it; a missing or corrupt file resets the latch rather than throwing).

`mail.probe` (05:10 daily) runs an SMTP `verify()`; on Sundays it sends **one
real mail** to the owner. Failure → `mail.probe.failed` in the outbox +
`HEALTHCHECKS_MAIL_URL` `/fail`. `MAIL_ENABLED=false` and a broken relay are
reported separately (a disabled feature is not an alarm).

### 5.5 Notification delivery (M6 P5: outbox → email / Bark)

Business events are written to `notification_deliveries` **inside the producing
transaction** (savepoint), then delivered by the drain's fourth segment.

| Aspect       | Behaviour                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedupe       | unique `(event_type, event_key, channel)` — one comment / one job run delivers once, per channel                                                                                                            |
| Retry        | attempt 1 immediately, then **+1 min, +5 min, +15 min**; the 4th failure is terminal `failed`                                                                                                               |
| Re-send      | the admin delivery log re-queues the **same row** and restarts its attempt budget (a manual resend is a new campaign); it never creates a duplicate; the re-send itself is audited as `notification.resend` |
| Rate limits  | `comment.pending` 10/h, `job.failed` 1/run, global 30/h; over the window the enqueue is **suppressed** (logged, no row) — suppression is not a delivery, so callers treat it as a failure and retry later   |
| Preferences  | `/admin/settings/notifications`, owner-only, per **group** (`comment`, `job`, `ops`), stored in `options['notifications.preferences']`; defaults: email on for comment/job/ops, Bark off                    |
| Delivery log | owner-editable page; the server sends only id/event/channel/status/attempts/created-at/**title** and the sanitized error — the stored `payload` (which carries the body) never reaches the browser          |
| Retention    | `jobs.prune` deletes `sent`/`failed` rows older than **30 days**; `queued` rows are never pruned                                                                                                            |
| Channels     | `email` reuses `MAIL_*`; `bark` uses `BARK_SERVER_URL` + `BARK_DEVICE_KEY` (https only, SSRF-guarded, key never in the URL, payload ≤200 chars)                                                             |

Registered events: `comment.pending`, `job.failed` (whitelist: `media.audit`),
`system.disk_high`, `system.memory_high`, `mail.probe.failed`. Adding an event is
code-only (roster in `src/lib/server/notifications/events.ts`) — no schema change.

Unconfigured Bark is a **permanent failure**, not a queue: the log row says
"not configured" and nothing is attempted (so a later key does not replay a
backlog of stale alerts).

### 5.6 Alert handling

Per-alert runbooks (meaning / first five minutes / recovery / escalation) live
in `notes/coordination/m6/p7/alert-runbooks.md`. Escalation ladder: L1 single
endpoint red → L2 two core endpoints red or two failed backup nights (freeze
releases, run a restore drill) → L3 admin exposure, corrupt repo/volume, or a
box unreachable for 15 minutes (stop the bleeding first).

### 5.7 Game day (`deploy/game-day.sh`)

The runbook answers "what do I do when it fires"; the game day answers "would we
be told, and how fast". It drives one controlled fault at a time and records
detection and recovery as wall-clock deltas in a JSON receipt.

```bash
bash deploy/game-day.sh                              # dry-run: print every drill
ALLOW_GAME_DAY=1 bash deploy/game-day.sh --drill pg        # disposable PG loses its listener
ALLOW_GAME_DAY=1 bash deploy/game-day.sh --drill container # disposable HTTP container is killed
ALLOW_GAME_DAY=1 bash deploy/game-day.sh --drill all --receipt /srv/web-lair/drills/gd.json
```

- `pg` / `container` are **self-contained**: the script creates the target
  container and a Gatus monitor on a scratch network, publishes the monitor on
  `127.0.0.1:18099` only, and removes everything on exit. No real service, data
  or credential is touched.
- `drain` / `disk` are **dry-run only**: they need the box (systemd) or write to
  a real mount. The script prints the exact recipe and the assertions to check.
- The drill config uses `interval: 5s` and **no alerts block**, so it measures
  Gatus' default evaluation (three failures to trigger, two successes to
  resolve). That is why a `postgres` stop is typically noticed in ~10 s and
  recovery in ~10 s: it measures the detection path, not production noise
  thresholds.

Local receipt (2026-11-16, `notes/coordination/m6/p7/logs/game-day-20261116.json`):
**pg detected 10 s / recovered 10 s · container detected 10 s / recovered 11 s**
(gatus v5.38.0, `postgres:18`, `nginx:alpine`).

## 6. Background timers (drain)

```bash
# Only these two timers carry a schedule; web-lair-backup*.timer are history:
# no OnCalendar, no [Install], they cannot be armed (§4.4).
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo cp deploy/systemd/web-lair-drain.timer deploy/systemd/web-lair-deadman.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now web-lair-drain.timer web-lair-deadman.timer
systemctl list-timers --all | grep web-lair      # verification
```

| Unit                          | Cadence                    | Job                                                                                                                                                    |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web-lair-drain.timer`        | 1 min                      | `deploy/compose-prod.sh run --rm --no-deps --name web-lair-drain app node jobs/drain.ts`                                                               |
| `web-lair-deadman.timer`      | 5 min                      | liveness ping (`HC_DEADMAN_URL`, falls back to `DEADMAN_PING_URL`), skipped when both are unset; reports `/fail` when Gatus' `/health` is down (M6 P3) |
| `web-lair-backup.timer`       | **none — removed (M6 P2)** | schedule moved to the `backrest` service (RUNBOOK)                                                                                                     |
| `web-lair-backup-check.timer` | **none — removed (M6 P2)** | `checkPolicy` in the rendered Backrest config (§4.4)                                                                                                   |

`run --rm` (not `exec`) so each tick is an independent container and a dead app
container cannot masquerade as a running timer. Exit codes: 0 tick done,
1 infrastructure failure (alert on it), 2 config missing.

The timer only provides process liveness; actual work comes from rows in
`job_schedules`. `scripts/ensure-job-schedules.ts` seeds the default maintenance
schedules (§1.4): `jobs.prune` (03:00), `system.resources` (every 15 min),
`subscriptions.sweep` (04:30, deletes pending subscriptions after 30 days),
`mail.probe` (05:10 daily; the job decides the weekly real send), the AI
scanners and the links/revisions maintenance rows; add or edit others in the
admin surface. An existing install that predates a job must re-run the script
(or add the schedule in `/admin/maintenance`) or the job never fires.

### 6.1 One-click unsubscribe acceptance

RFC 8058 requires the endpoint to work **without** an `Origin` header and
without cookies. Run this from the box (compose binds the app on the internal
network; use `deploy/compose-prod.sh exec app` or an equivalent local URL):

```bash
# F-13: the token is derived from the stored nonce, so print it instead of
# reading a (no longer existing) plaintext column.
TOKEN=$(deploy/compose-prod.sh run --rm app node bin/lair site print-subscribe-token reader@example.com)
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'List-Unsubscribe=One-Click' \
  "https://<domain>/api/unsubscribe/one-click?token=$TOKEN"   # expect 200
```

A malformed token (wrong shape) from an Origin-less or foreign-origin POST is
rejected by the CSRF hook with `403`; a same-origin malformed token reaches the
route and returns `200` (no token oracle). A well-formed but unknown token
answers `200`. A tripped per-IP limit answers `429 + Retry-After`, and a
database write failure answers `503 + Retry-After` — both are retryable, because
a silent `200` would let the receiver drop a valid opt-out. The ordinary form
endpoints must keep rejecting Origin-less POSTs with `403` — see
`src/lib/server/security/csrf.ts`.

## 7. Troubleshooting

| Symptom                                  | Likely cause                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `app` unhealthy                          | `deploy/compose-prod.sh logs app`; `/api/health` must answer 200                                                                              |
| 413 on upload                            | `BODY_SIZE_LIMIT` too low (default 26M; one file per request)                                                                                 |
| Registration 503                         | mail unconfigured or SMTP verify failed (`MAIL_ENABLED`/`MAIL_SMTP_HOST`/`MAIL_FROM`) — form and API refuse by design                         |
| All visitors share one rate-limit bucket | Caddy not setting `X-Forwarded-For`, or `ADDRESS_HEADER`/`XFF_DEPTH` wrong                                                                    |
| SSE stalls                               | Caddy buffering — `flush_interval -1` must be present                                                                                         |
| Certs fail under orange cloud            | HTTP-01 blocked at the edge — switch to DNS-01 (xcaddy + CF plugin) or grey-cloud DNS                                                         |
| Analytics page shows only `—`            | Sentinel not configured (`SENTINEL_URL`/`SENTINEL_TOKEN`), not healthy, or the 2 s read timed out (fail-open by design)                       |
| `/api/ready` answers 404                 | No `READY_TOKEN` in production (fail closed) or the caller is public with no token                                                            |
| A notification never arrived             | `/admin/settings/notifications` delivery log: `failed` + `response_code`/error, or the group/channel is off in preferences                    |
| Alert arrives but no recovery            | Gatus sends RESOLVED after `success-threshold`; if the endpoint was deleted instead of fixed the fragment was re-rendered (touch `zz-*.yaml`) |

Per-alert detail (meaning / first five minutes / recovery / escalation) lives in
`notes/coordination/m6/p7/alert-runbooks.md`. In-repo config truth:
`deploy/monitoring/` (Gatus) and `deploy/systemd/` (host timers).

## 8. Email retention and suppression (E2)

**Suppression list.** `email_suppressions` stores only `HMAC-SHA256(email)` with
the independent `SUPPRESSION_HMAC_KEY` (`openssl rand -base64 32`), a reason
(`unsubscribed` / `bounced` / `complained`) and a source. Writes are idempotent
and **monotonic** on the reason: a complaint upgrades a bounce, a bounce
upgrades an unsubscribe; a weaker signal never overwrites a stronger one.
`source` follows the event whose reason won. A missing/invalid key fails
every suppression operation, reads included — never an unkeyed hash
(production boot refuses too; §1.1 has setup).

- A pending or confirmed opt-out records the row in the same transaction as
  the subscription change.
- A confirmed re-subscription lifts only `unsubscribed`; `bounced` and
  `complained` are never lifted by the user flow (a deliverability problem or
  an abuse report must survive).
- Keep the key in backups. Rotating it orphans every existing hash. Addresses
  that still exist in `subscriptions.email` can be rehashed by a migration;
  addresses that exist **only** in `email_suppressions` cannot be recomputed.
  Do not rotate without a key-version migration (F-14).
- Retention: keep suppression rows **for as long as the address could ever be
  contacted**; never prune them with the subscription sweep. (Two years is a
  common audit floor, not a CAN-SPAM/ICO limit.)

**Subscription retention.** `subscriptions.sweep` deletes `pending` rows whose
`updated_at` is older than 30 days (i.e. 30 days after the last resend, not
after the first request). `subscribed` and `unsubscribed` rows stay as
consent/opt-out evidence; `consent_version` records which text the reader
agreed to (`2026-10-v1` from this release, `legacy` for rows restored from
before the column existed). A previously subscribed address that re-submits
re-enters `pending` with `verified_at` cleared; its earlier consent is not
retained in this table (registered follow-up F-16: append-only consent
history). Pre-E2 pending opt-outs were deleted without a suppression row and
are **not recoverable** by the backfill; suppression coverage starts at E2.

**Consent backfill (once, after restoring pre-E2 data):**

```bash
deploy/compose-prod.sh run --rm app node bin/lair db backfill-consent            # dry-run
deploy/compose-prod.sh run --rm app node bin/lair db backfill-consent --apply
```

**Suppression backfill (once, after restoring pre-E2 opt-outs):**

```bash
deploy/compose-prod.sh run --rm app node bin/lair db backfill-suppressions             # dry-run
deploy/compose-prod.sh run --rm app node bin/lair db backfill-suppressions --apply
```

**Subscription tokens (F-13).** Rows store `token_nonce` (random 32B, 43 chars)
and `token_hash = sha256(token)`. The mailed token is
`HMAC-SHA256(SUBSCRIBE_TOKEN_SECRET, 'wl:subscribe:token:v1:' || nonce)`, so the
database holds no usable link and the service can still re-derive the exact URL
it mailed (resend cooldown, failed-send rollback). There is nothing to backfill:
every row created since this baseline carries both columns, and the verification
path is a hash lookup.

To exercise a confirmation/unsubscribe link on a box:

```bash
deploy/compose-prod.sh run --rm app node bin/lair site print-subscribe-token <email>
```

Rotating `SUBSCRIBE_TOKEN_SECRET` invalidates every outstanding confirmation
link (the nonce stays, but the derivation changes); with the 24-72h TTL that is
a bounded loss — pending readers just request a new mail. Rotate it together
with a mail-template check, never mid-broadcast.

**Suppression key versions (F-14).** `email_suppressions.key_version` records
which derivation produced a row's hash. Version 1 is the master key itself
(`HMAC(SUPPRESSION_HMAC_KEY, email)`); v≥2 derive their key from the same master
(`HMAC(master, 'wl:suppression:key:vN')`), so the box keeps one secret and every
older row stays verifiable. Reads cover versions `1..SUPPRESSION_HMAC_KEY_VERSION`.

Rotate (no downtime, no rehash — a hash cannot be rewritten without the address):

```bash
# 1. confirm the database is not already ahead of the env
deploy/compose-prod.sh run --rm app node bin/lair db verify-suppression-version
# 2. bump the version (e.g. 1 -> 2) and restart
sed -i 's/^SUPPRESSION_HMAC_KEY_VERSION=.*/SUPPRESSION_HMAC_KEY_VERSION="2"/' .env
deploy/compose-prod.sh up -d app
# 3. rows converge to v2 as each address is touched again
```

**Never set the version below `max(key_version)`**: rows on a newer version
would fall outside the read range and an opted-out address would turn mailable.
`scripts/verify-suppression-version.ts` (run in §2 before `up -d`) exits 1 on
that mismatch. Replacing the _master_ key is not a rotation — it makes v1 rows
unreadable by construction; treat it as a data-loss event and keep the old key
in the backup set if it must be retired.

**Bounce / complaint webhook (E2-4).** `POST /api/mail/events` expects JSON
`{ "email": "...", "reason": "bounced" | "complained" }` signed over
`<timestamp>.<raw-body>`:

```bash
TS=$(date +%s)
BODY='{"email":"reader@example.com","reason":"bounced"}'
# The app base64-decodes the key and HMACs its 32 raw bytes.
KEY_HEX=$(grep '^MAIL_EVENTS_HMAC_KEY=' .env | cut -d= -f2- | tr -d '"' \
  | base64 -d | od -An -tx1 | tr -d ' \n')
SIG=$(printf '%s.%s' "$TS" "$BODY" \
  | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY_HEX" | sed 's/^.* //')
curl -sS -X POST https://<domain>/api/mail/events \
  -H 'Content-Type: application/json' \
  -H "x-mail-events-timestamp: $TS" \
  -H "x-mail-events-signature: sha256=$SIG" \
  --data "$BODY"          # expect {"ok":true}
```

Missing `MAIL_EVENTS_HMAC_KEY` makes the endpoint answer `503` (fail-closed);
signatures older/newer than five minutes are rejected. Relay webhooks are the
supported intake; self-hosted DSN parsing remains a later second entry point.

## 9. Flaky test policy

Red does not get "rerun to green" as a fix: every rerun is flake evidence, not
a pass. When a run shows failures, rerun the whole job if several tests failed
together (shared-root-cause clusters dominate — network/external services), and
record each incident in the flaky registry (project `notes/`): test name, run
id/URL, suspected class (test / environment / infrastructure), disposition.
A red stays red at most 4 days, then exactly one of: fixed, or the test is
isolated/quarantined with the reason written down. Retries in CI are capped at
1 (`playwright.config.ts`); Playwright's own "flaky" label (passed on retry)
marks the entries to log.
