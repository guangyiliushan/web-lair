# Deployment runbook (web-lair)

> Target: one self-hosted Ubuntu 24.04 box behind Caddy (platform plan §C).
> Branches are deployed by commit; the image is built on the box and tagged
> with the commit SHA. Every step below is idempotent unless marked otherwise.

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
| `OWNER_EMAIL` / `OWNER_PASSWORD`                      | first owner seed (`pnpm db:seed-owner` from the host, dev only)                                                   |

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
$EDITOR deploy/backup.env      # RESTIC_* + AWS_* + BACKUP_PING_URL
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
  `MAIL_ENABLED=true`, `MAIL_SMTP_HOST=host.docker.internal` (a host MTA) and skip
  the relay. The app runs in its own network namespace: `127.0.0.1` there is the
  container, not the box — compose maps the host gateway for this reason.
- Any red → point `MAIL_SMTP_HOST/PORT/USER/PASS` at the relay; the app code is
  unchanged (one env switch).

DKIM is signed by the app: set `MAIL_DKIM_DOMAIN=mail.<domain>`,
`MAIL_DKIM_SELECTOR` and the PEM key (`\n` escapes accepted). Publish SPF
(`v=spf1 ip4:<ip> -all` or the relay's include), the DKIM TXT and a DMARC
record (`p=none` first, tighten after a week of reports). Send from a
**subdomain** so a reputation problem never touches the apex.

### 1.3 Build (gate: ≤ 8 min, ≤ 4 GB peak)

```bash
export HTTP_PROXY= HTTPS_PROXY=        # the box has no local proxy
/usr/bin/time -v docker compose --profile prod build app 2>&1 | tail -30
# record "Elapsed" and "Maximum resident set size"; over the gate → build on a
# workstation instead: docker save | ssh box docker load (image tag = SHA).
```

### 1.4 Migrate, then start

```bash
mkdir -p /srv/web-lair/backup
docker compose exec -T db pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > "/srv/web-lair/backup/pre-migrate-$(date +%F_%H%M).dump"
docker compose --profile prod run --rm app node scripts/migrate.ts
docker compose --profile prod up -d
docker compose --profile prod ps          # all healthy
```

### 1.5 Smoke

```bash
curl -fsS https://$DOMAIN/api/health
curl -sI https://$DOMAIN | head -1                    # 200
curl -sI http://$DOMAIN | head -1                     # 308 → https
docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>console.log(r.status))"
```

Then: register a test account (verification mail must arrive), subscribe a test
address (confirmation link must land on `/subscribe/confirm`), upload one photo
(EXIF must parse — this proves `perl` + exiftool in the image).

## 2. Update

```bash
cd /srv/web-lair/app
git fetch && git checkout <new-sha>
docker compose --profile prod build app
mkdir -p /srv/web-lair/backup
docker compose exec -T db pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > "/srv/web-lair/backup/pre-migrate-$(date +%F_%H%M).dump"
docker compose --profile prod run --rm app node scripts/migrate.ts
docker compose --profile prod up -d
```

Pin the image: `APP_IMAGE=web-lair-app:<sha>` in `.env` so a rollback is a tag
change. Never roll back a migration without restoring the pre-migration dump.

## 3. Rollback

```bash
# code/image only (this batch is zero-schema)
docker compose --profile prod up -d --no-build   # after APP_IMAGE points at the previous tag
```

If a migration ran: stop `app`, restore the pre-migration `pg_dump`, then start
the previous image. Migration-before-backup is forbidden (see §4).

## 4. Backups (D-4)

Backup set:

1. `pg_dump -Fc` → staging dir on the host (logical backup; never file-copy a
   running data directory).
2. `$DATA_DIR` (user job scripts + sidecars).
3. RustFS volume (media), mounted read-only into the backup container.
4. `.env` + compose/Caddyfile + **restic password** (offline copy).

```bash
# what the nightly unit runs (deploy/systemd/web-lair-backup.timer)
/srv/web-lair/app/deploy/backup/backup.sh
```

Credentials come from `deploy/backup.env` (mode 600, loaded by the systemd
unit — never from `.env`, so the app container cannot read them).

The script dumps PG to a temp file, validates it with `pg_restore -l`, swaps it
over `pg.dump` (a failed night never truncates yesterday's good copy), resolves
the RustFS volume from the running container, then runs restic with
`--retry-lock 30m` and the retention policy.

- Weekly: `web-lair-backup-check.timer` runs `restic check --read-data-subset=5%`
  (the nightly job only backs up).
- Monthly drill: restore to a **separate** directory and, for PG, into a
  **scratch** database on a different port; compare row counts and sample media
  hashes. The drill never touches the production database.
- A failed backup must fail **its own** check: `BACKUP_PING_URL` is pinged only
  on success and is deliberately separate from the 5-minute liveness URL
  (`DEADMAN_PING_URL`) — sharing one check would make a silent backup failure
  invisible on the next liveness tick.

## 5. Monitoring

| What                                       | Where                                   |
| ------------------------------------------ | --------------------------------------- |
| HTTPS homepage / admin login / cert expiry | Uptime Kuma (`127.0.0.1:3001`, tailnet) |
| Postgres TCP, RustFS health, drain push    | Uptime Kuma (internal network)          |
| Box-external HTTP + dead-man               | healthchecks.io + UptimeRobot           |
| Disk / memory thresholds                   | `system.resources` job → notification   |

Kuma setup: create monitors, then paste the push URL into `JOBS_HEARTBEAT_URL`
(Kuma expects `.../api/push/<key>?status=up&msg=OK`).

## 6. Background timers (drain)

```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now web-lair-drain.timer web-lair-deadman.timer web-lair-backup.timer web-lair-backup-check.timer
systemctl list-timers --all | grep web-lair      # verification
```

| Unit                          | Cadence                         | Job                                                                       |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `web-lair-drain.timer`        | 1 min                           | `docker compose --profile prod run --rm --no-deps app node jobs/drain.ts` |
| `web-lair-deadman.timer`      | 5 min                           | liveness ping (`DEADMAN_PING_URL`), skipped when unset                    |
| `web-lair-backup.timer`       | 03:30 daily (`Persistent=true`) | `deploy/backup/backup.sh`                                                 |
| `web-lair-backup-check.timer` | Sundays 04:30                   | `restic check --read-data-subset=5%`                                      |

`run --rm` (not `exec`) so each tick is an independent container and a dead app
container cannot masquerade as a running timer. Exit codes: 0 tick done,
1 infrastructure failure (alert on it), 2 config missing.

## 7. Troubleshooting

| Symptom                                  | Likely cause                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `app` unhealthy                          | `docker compose logs app`; `/api/health` must answer 200                              |
| 413 on upload                            | `BODY_SIZE_LIMIT` too low (default 26M; one file per request)                         |
| Registration 500                         | mail unconfigured (`MAIL_ENABLED`/`MAIL_SMTP_HOST`) — the send is fail-loud by design |
| All visitors share one rate-limit bucket | Caddy not setting `X-Forwarded-For`, or `ADDRESS_HEADER`/`XFF_DEPTH` wrong            |
| SSE stalls                               | Caddy buffering — `flush_interval -1` must be present                                 |
| Certs fail under orange cloud            | HTTP-01 blocked at the edge — switch to DNS-01 (xcaddy + CF plugin) or grey-cloud DNS |
