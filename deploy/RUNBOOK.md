# Deployment runbook (web-lair)

> Target: one self-hosted Ubuntu 24.04 box behind Caddy (platform plan §C).
> Branches are deployed by commit; the image is built on the box and tagged
> with the commit SHA. Every step below is idempotent unless marked otherwise.

> [!IMPORTANT]
> **Production commands go through `deploy/compose-prod.sh`.**
> A bare `docker compose` auto-loads `compose.override.yaml`, which publishes the
> dev loopback ports and attaches the `devhost` network. The wrapper loads
> `compose.yaml` + `compose.prod.yaml` only and never the dev overlay.
> `deploy/compose-prod.sh <args>` is equivalent to
> `docker compose -f compose.yaml -f compose.prod.yaml <args>`.
> Run every block from `/srv/web-lair/app` unless the block changes directory.

## 0. Host prerequisites

| Item                                                     | Check                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Docker Engine + compose plugin                           | `docker version && docker compose version`                                            |
| Tailscale up (SSH / Kuma only via tailnet)               | `tailscale status`                                                                    |
| Time sync (TLS, TOTP, DB timestamps)                     | `timedatectl` → `System clock synchronized: yes`                                      |
| Only 80/443 public                                       | `ss -lntp \| grep -E ':(80\|443)\b'`; everything else bound to `127.0.0.1` or tailnet |
| Deploy user uid/gid 1000 (matches the image `node` user) | `id -u`                                                                               |

## 1. First deploy

```bash
git clone <repo> /srv/web-lair/app && cd /srv/web-lair/app
git checkout <commit-sha>

cp .env.example .env
chmod 600 .env
$EDITOR .env      # see §1.1 for the required keys
```

### 1.1 Required `.env` keys

| Key                                                   | Value                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | strong, unique, **URL-safe** (`openssl rand -hex 32`) — the password is interpolated into `DATABASE_URL` verbatim |
| `BETTER_AUTH_SECRET`                                  | ≥32 chars, high entropy                                                                                           |
| `ORIGIN`                                              | `https://<domain>` (no trailing slash)                                                                            |
| `DOMAIN`                                              | same host, used by Caddy                                                                                          |
| `ACME_EMAIL`                                          | Let's Encrypt expiry notices                                                                                      |
| `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`             | object-store credentials                                                                                          |
| `DATA_DIR`                                            | absolute host path, e.g. `/srv/web-lair/data`                                                                     |
| `MAIL_*`                                              | see §1.2                                                                                                          |
| `SUBSCRIBE_TOKEN_TTL_DAYS` / `SUBSCRIBE_HMAC_KEY`     | see §1.2 (confirmation-link lifetime + per-address cap key)                                                       |
| `SUPPRESSION_HMAC_KEY` / `MAIL_EVENTS_HMAC_KEY`       | see §8 (suppression list hash key + bounce/complaint webhook key)                                                 |
| `OWNER_EMAIL` / `OWNER_PASSWORD`                      | first owner seed (`pnpm db:seed-owner` from the host, dev only)                                                   |
| `DEADMAN_PING_URL`                                    | healthchecks.io **liveness** check (5 min); unset ⇒ the dead-man timer skips (no alarm)                           |
| `JOBS_HEARTBEAT_URL`                                  | per-tick drain ping (Kuma push or a second healthchecks check)                                                    |
| `ALERT_WEBHOOK_URL`                                   | systemd `OnFailure` target; leave empty to disable the alert unit                                                 |
| `MAIL_DEV_LOG` / `MAIL_DEV_LOG_OK`                    | dev/e2e only; production ignores dev logging unless BOTH are set                                                  |

`SUPPRESSION_HMAC_KEY` is mandatory before the first start (production boot
refuses to start without it; dev needs it for subscribe/unsubscribe). Generate
with `openssl rand -base64 32` and back it up. `MAIL_EVENTS_HMAC_KEY` is only
needed when a bounce/complaint relay is configured.

Create the data directory with the image's uid **before** the first start —
Docker would otherwise create it as root and the `node` user (uid 1000) could
not write the job scaffold:

```bash
sudo install -d -m 0750 -o 1000 -g 1000 /srv/web-lair/data
```

Backup credentials go in their own file (not `.env`), so the app container
never sees the credential that can delete the offsite repository:

```bash
cp deploy/backup.env.example deploy/backup.env
chmod 600 deploy/backup.env
$EDITOR deploy/backup.env      # + POSTGRES_USER / POSTGRES_DB / DATA_DIR (same values as .env),
                               #   RESTIC_* + AWS_* + BACKUP_PING_URL + CHECK_PING_URL
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

- 25 open **and** PTR matches the sending subdomain **and** not PBL-listed → set
  `MAIL_ENABLED=true`, `MAIL_SMTP_HOST=host.docker.internal`, `MAIL_FROM=...` (a host MTA) and skip
  the relay. The app runs in its own network namespace: `127.0.0.1` there is the
  container, not the box — compose maps the host gateway for this reason.
- Any red → point `MAIL_SMTP_HOST/PORT/USER/PASS` at the relay; the app code is
  unchanged (one env switch).

DKIM is signed by the app: set `MAIL_DKIM_DOMAIN=mail.<domain>`,
`MAIL_DKIM_SELECTOR` and the PEM key (`\n` escapes accepted). The signature
covers the RFC 4871 default header set **plus `List-Unsubscribe-Post`**
(RFC 8058 §4); `List-Unsubscribe` was already in nodemailer's default set.

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
  values are clamped and logged) bounds the confirmation link. The 24h default
  borrows the NIST SP 800-63B-4 §4.2.1.2 bound for emailed recovery codes
  (that section governs account recovery, not list subscriptions); expired
  links render "link expired" and never confirm. Unsubscribe links are not
  TTL-bound, but a pending/unsubscribed resubmit outside the 15-minute resend
  cooldown rotates the token, so older mails' links stop working — the newest
  mail always carries a valid opt-out. A stable, never-rotating unsubscribe
  token is registered as a follow-up (F-15).
- `SUBSCRIBE_HMAC_KEY` (`openssl rand -base64 32`) keys the per-address
  **5 / 24 h** cap. Empty/invalid degrades to IP-only limiting (`10 / h`) and
  logs `[email-hash] SUBSCRIBE_HMAC_KEY is missing...`; set it in production.
- The confirmation mail is transactional: it carries **no**
  `List-Unsubscribe` headers. Bulk mail (not implemented yet) must send both
  headers, and the one-click URI is
  `POST /api/unsubscribe/one-click?token=<token>` (`List-Unsubscribe-Post:
List-Unsubscribe=One-Click`, no cookies, no redirect).

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
deploy/compose-prod.sh run --rm app node scripts/migrate.ts
deploy/compose-prod.sh run --rm app node scripts/verify-baseline.ts
# Default maintenance schedules (idempotent; adjust in admin afterwards).
# Seed rows are one-per-job and use options.site.timezone (fallback UTC); times
# are not critical for maintenance, and admin-created schedules use the same tz.
deploy/compose-prod.sh run --rm app node scripts/ensure-job-schedules.ts
deploy/compose-prod.sh up -d
deploy/compose-prod.sh ps          # all healthy
```

### 1.5 Smoke

```bash
export DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d '"')
curl -fsS https://$DOMAIN/api/health
curl -sI https://$DOMAIN | head -1                    # 200
curl -sI http://$DOMAIN | head -1                     # 308 → https
deploy/compose-prod.sh exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>console.log(r.status))"
```

Then: register a test account (verification mail must arrive), subscribe a test
address (confirmation link must land on `/subscribe/confirm`), upload one photo
(EXIF must parse — this proves `perl` + exiftool in the image).

Setup does not require mail: the owner claim marks the first account verified,
so `/admin/setup` still works before `MAIL_*` exists. Configure mail before
relying on verification or password-reset emails.

## 2. Update

```bash
set -euo pipefail
cd /srv/web-lair/app
git fetch && git checkout <new-sha>
export APP_IMAGE="web-lair-app:$(git rev-parse --short HEAD)"
deploy/compose-prod.sh build app
deploy/verify-image.sh "$APP_IMAGE"
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
deploy/compose-prod.sh run --rm app node scripts/migrate.ts
deploy/compose-prod.sh run --rm app node scripts/verify-baseline.ts
# Default maintenance schedules (idempotent; adjust in admin afterwards).
# Seed rows are one-per-job and use options.site.timezone (fallback UTC); times
# are not critical for maintenance, and admin-created schedules use the same tz.
deploy/compose-prod.sh run --rm app node scripts/ensure-job-schedules.ts
deploy/compose-prod.sh up -d
```

Pin the image: `APP_IMAGE=web-lair-app:<sha>` in `.env` so a rollback is a tag
change. Never roll back a migration without restoring the pre-migration dump.

### 2.1 E2 baseline rebuild (one-off, 2026-10-18)

E2 regenerated the single `0000_baseline.sql` in place (49 tables) instead of
appending a migration. `scripts/migrate.ts` therefore **refuses to start** on a
pre-E2 database (`[migrate] this database predates the E2 baseline`). Upgrade
such a box by rebuilding the schema and restoring data. Run this from the app
directory with the target image already pinned in `.env` (`APP_IMAGE=web-lair-app:<sha>`):

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
sudo systemctl stop web-lair-drain.timer web-lair-backup.timer web-lair-backup-check.timer || true
sudo systemctl stop web-lair-drain.service web-lair-backup.service || true
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
  awk '/^COPY public\."user" /{f=1;next} f&&$0=="\\\\."{exit} f{n++} END{print n+0}')
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
deploy/compose-prod.sh run --rm app node scripts/migrate.ts
deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < "$BK/pre-e2-data-$STAMP.sql"
RESTORED=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from \"user\""')
[ "$RESTORED" = "$USERS" ] || { echo "restored user rows=$RESTORED, expected $USERS; aborting" >&2; exit 1; }

# Backfills + verification run inside the image (host has no pnpm/tsx).
deploy/compose-prod.sh run --rm app node scripts/backfill-email-consent.ts --apply
deploy/compose-prod.sh run --rm app node scripts/backfill-suppressions.ts --apply
deploy/compose-prod.sh run --rm app node scripts/backfill-subscription-token-hashes.ts --apply
deploy/compose-prod.sh run --rm app node scripts/ensure-job-schedules.ts
deploy/compose-prod.sh run --rm app node scripts/verify-baseline.ts
deploy/compose-prod.sh up -d
sudo systemctl start web-lair-drain.timer web-lair-backup.timer web-lair-backup-check.timer
```

Requirements/notes:

- `SUPPRESSION_HMAC_KEY` must be present in `.env` before the backfills (the
  suppression script refuses to write unkeyed hashes; production boot also
  checks it). Generate it with `openssl rand -base64 32` once, back it up.
- `SET LOCAL session_replication_role = replica` requires the compose Postgres
  superuser (the default `POSTGRES_USER` here). It disables FK triggers for the
  restore only; `--column-inserts` makes the dump immune to the two E2 columns.
- The data-only restore never touches `drizzle.__drizzle_migrations`: the fresh
  ledger written by `migrate.ts` must remain the only row.
- Verify output must show **49 tables / 117 indexes / 75 checks / 47 FKs**. If anything
  fails after the drop, **do not re-run §2.1**; restore the full
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
node scripts/verify-baseline.ts   # 49 / 117 / 75 / 47
```

A pre-provenance full dump is a **different generation**: §3 detects it by the
absence of `posts.writing_origin` and skips `verify-baseline`; restore it with
the image tag that matches that dump.

## 3. Rollback

```bash
# code/image only (no schema change since the last rebuild)
deploy/compose-prod.sh up -d --no-build   # after APP_IMAGE points at the previous tag
```

If a migration ran (or the rebuild above was performed): stop `app`, restore the
matching full dump, then start the previous image. Migration-before-backup is
forbidden (see §4). Treat a dump and the image generation that wrote it as a
pair: a post-E2 dump is schema-compatible with the old image (the new table and
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
  awk '/^COPY public\."user" /{f=1;next} f&&$0=="\\\\."{exit} f{n++} END{print n+0}')
[ "$DUMP_USERS" = "$USERS" ] || { echo "dump has $DUMP_USERS user rows, expected $USERS; aborting" >&2; exit 1; }
# IMAGE must point at the tag that matches the dump.
sudo systemctl stop web-lair-drain.timer web-lair-backup.timer web-lair-backup-check.timer || true
sudo systemctl stop web-lair-drain.service web-lair-backup.service || true
docker rm -f web-lair-drain >/dev/null 2>&1 || true
deploy/compose-prod.sh stop app
deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "drop schema if exists drizzle cascade;" -c "drop schema if exists public cascade;" -c "create schema public;"'
# -1/--single-transaction implies --exit-on-error: never leave a partial restore.
deploy/compose-prod.sh exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges -1 -e' \
  < "$DUMP"
# The dump may be pre-E2 (48 tables), pre-provenance (49 tables, E2, no
# writing_origin) or current. Verify-baseline only knows the current baseline,
# so probe both generation and provenance shape; anything else must stop.
TABLES=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from information_schema.tables where table_schema = '\''public'\'' and table_type = '\''BASE TABLE'\''"')
HAS_E2=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select to_regclass('\''public.email_suppressions'\'') is not null"')
HAS_PROV=$(deploy/compose-prod.sh exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select exists (select 1 from information_schema.columns where table_schema='\''public'\'' and table_name='\''posts'\'' and column_name='\''writing_origin'\'')"')
if [ "$TABLES" = "49" ] && [ "$HAS_E2" = "t" ] && [ "$HAS_PROV" = "t" ]; then
  deploy/compose-prod.sh run --rm app node scripts/verify-baseline.ts
elif [ "$TABLES" = "49" ] && [ "$HAS_E2" = "t" ] && [ "$HAS_PROV" = "f" ]; then
  echo "restored pre-provenance schema (49 tables, E2, no writing_origin); verify-baseline skipped — use the matching pre-provenance image"
elif [ "$TABLES" = "48" ] && [ "$HAS_E2" = "f" ]; then
  echo "restored pre-E2 schema (48 public tables); verify-baseline skipped"
else
  echo "unexpected restore shape (tables=$TABLES e2=$HAS_E2 provenance=$HAS_PROV); refusing to start" >&2
  exit 1
fi
deploy/compose-prod.sh up -d
sudo systemctl start web-lair-drain.timer web-lair-backup.timer web-lair-backup-check.timer || true
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

## 4. Backups (D-4)

Backup set:

1. `pg_dump -Fc` → staging dir on the host (logical backup; never file-copy a
   running data directory).
2. `$DATA_DIR` (user job scripts + sidecars).
3. RustFS volume (media), mounted read-only into the backup container.
4. `.env` only. compose/Caddyfile come from git; the **restic password** is
   kept offline (password manager — losing it makes the repo unreadable).

```bash
# what the nightly unit runs (deploy/systemd/web-lair-backup.timer)
/srv/web-lair/app/deploy/backup/backup.sh
```

Credentials come from `deploy/backup.env` (mode 600, loaded by the systemd
unit — never from `.env`, so the app container cannot read them).

The script dumps PG to a temp file, validates it with `pg_restore -l`, swaps it
over `pg.dump` (a failed night never truncates yesterday's good copy), resolves
the RustFS volume from the running container, then runs restic with
`--retry-lock 30m` and the retention policy. Pre-migration dumps live in
`/srv/web-lair/pre-migrate` — **outside** the restic source paths, pruned by
age, so deploy count does not grow the backup repo.

- Weekly: `web-lair-backup-check.timer` runs
  `restic --retry-lock 30m check --read-data-subset=5%` (the nightly job only
  backs up) and pings `CHECK_PING_URL` only on success.
- Monthly drill: restore to a **separate** directory and, for PG, into a
  **scratch** database on a different port; compare row counts and sample media
  hashes. The drill never touches the production database.
- A failed backup must fail **its own** check: `BACKUP_PING_URL` is pinged only
  on success and is deliberately separate from the 5-minute liveness URL
  (`DEADMAN_PING_URL`) — sharing one check would make a silent backup failure
  invisible on the next liveness tick.

## 5. Monitoring

| What                                       | Where                                                        |
| ------------------------------------------ | ------------------------------------------------------------ |
| HTTPS homepage / admin login / cert expiry | Uptime Kuma (`127.0.0.1:3001`, tailnet)                      |
| Postgres TCP, RustFS health, drain push    | Uptime Kuma (internal network)                               |
| Box-external HTTP + dead-man               | healthchecks.io + UptimeRobot                                |
| Disk / memory readings                     | `system.resources` job (record-only; threshold alerts = F-7) |

Kuma setup: create monitors, then paste the push URL into `JOBS_HEARTBEAT_URL`
(Kuma expects `.../api/push/<key>?status=up&msg=OK`).

## 6. Background timers (drain)

```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now web-lair-drain.timer web-lair-deadman.timer web-lair-backup.timer web-lair-backup-check.timer
systemctl list-timers --all | grep web-lair      # verification
```

| Unit                          | Cadence                         | Job                                                                                      |
| ----------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `web-lair-drain.timer`        | 1 min                           | `deploy/compose-prod.sh run --rm --no-deps --name web-lair-drain app node jobs/drain.ts` |
| `web-lair-deadman.timer`      | 5 min                           | liveness ping (`DEADMAN_PING_URL`), skipped when unset                                   |
| `web-lair-backup.timer`       | 03:30 daily (`Persistent=true`) | `deploy/backup/backup.sh`                                                                |
| `web-lair-backup-check.timer` | Sundays 04:30                   | `restic check --read-data-subset=5%`                                                     |

`run --rm` (not `exec`) so each tick is an independent container and a dead app
container cannot masquerade as a running timer. Exit codes: 0 tick done,
1 infrastructure failure (alert on it), 2 config missing.

The timer only provides process liveness; actual work comes from rows in
`job_schedules`. `scripts/ensure-job-schedules.ts` seeds the three maintenance
jobs (§1.4): `jobs.prune` (03:00), `system.resources` (every 15 min) and
`subscriptions.sweep` (04:30, deletes pending subscriptions after 30 days);
add or edit others in the admin surface.

### 6.1 One-click unsubscribe acceptance

RFC 8058 requires the endpoint to work **without** an `Origin` header and
without cookies. Run this from the box (compose binds the app on the internal
network; use `deploy/compose-prod.sh exec app` or an equivalent local URL):

```bash
# Replace with a real token from a subscription row (it is a bearer token).
TOKEN=$(deploy/compose-prod.sh exec -T db sh -c \
  "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"select token from subscriptions where status = 'pending' limit 1\"")
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

| Symptom                                  | Likely cause                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `app` unhealthy                          | `deploy/compose-prod.sh logs app`; `/api/health` must answer 200                                                      |
| 413 on upload                            | `BODY_SIZE_LIMIT` too low (default 26M; one file per request)                                                         |
| Registration 503                         | mail unconfigured or SMTP verify failed (`MAIL_ENABLED`/`MAIL_SMTP_HOST`/`MAIL_FROM`) — form and API refuse by design |
| All visitors share one rate-limit bucket | Caddy not setting `X-Forwarded-For`, or `ADDRESS_HEADER`/`XFF_DEPTH` wrong                                            |
| SSE stalls                               | Caddy buffering — `flush_interval -1` must be present                                                                 |
| Certs fail under orange cloud            | HTTP-01 blocked at the edge — switch to DNS-01 (xcaddy + CF plugin) or grey-cloud DNS                                 |

## 8. Email retention and suppression (E2)

**Suppression list.** `email_suppressions` stores only `HMAC-SHA256(email)` with
the independent `SUPPRESSION_HMAC_KEY` (`openssl rand -base64 32`), a reason
(`unsubscribed` / `bounced` / `complained`) and a source. Writes are idempotent
and **monotonic** on the reason: a complaint upgrades a bounce, a bounce
upgrades an unsubscribe; a weaker signal never overwrites a stronger one.
`source` follows the event whose reason won. The key is required: a
missing/invalid key fails the production boot (and any suppression operation,
reads included) instead of storing unkeyed hashes. Development also needs it —
set it in `.env` before using `/subscribe` or `/unsubscribe`.

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
deploy/compose-prod.sh run --rm app node scripts/backfill-email-consent.ts            # dry-run
deploy/compose-prod.sh run --rm app node scripts/backfill-email-consent.ts --apply
```

**Suppression backfill (once, after restoring pre-E2 opt-outs):**

```bash
deploy/compose-prod.sh run --rm app node scripts/backfill-suppressions.ts             # dry-run
deploy/compose-prod.sh run --rm app node scripts/backfill-suppressions.ts --apply
```

**Token hashes (E2-3).** New writes store both `token` (dual-read window) and
`token_hash = sha256(token)`. Reads try the hash first, fall back to the
plaintext column for legacy rows and backfill the hash on first hit without
touching `updated_at` (the TTL anchor). Backfill everything once after restore:

```bash
deploy/compose-prod.sh run --rm app node scripts/backfill-subscription-token-hashes.ts   # dry-run
deploy/compose-prod.sh run --rm app node scripts/backfill-subscription-token-hashes.ts --apply
```

The plaintext `token` column is scheduled for removal in a later window after
one release of dual-read.

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
