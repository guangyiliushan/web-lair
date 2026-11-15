# Secrets P2 — threat model and key lifecycle

> Scope: runtime credentials stored in the database (`ai_provider_secrets`,
> `webhook_secrets`), the master-key keyring, and the backup split that makes the
> encryption meaningful. Design source: `notes/notes/settings-truth-complete-plan-20261113.md`
> W2.0–W2.13, `notes/notes/secrets-decision-register-20261112.md` §0.1
> (D0-C / T1-A / T2-A / T3-A / T4-B / T5-A).
>
> This document states what the controls buy and what they do not. It is part of
> the deliverable: an "encrypted" claim without its boundary is an overstatement.

## 1. Assets

| Asset                         | Where it lives                                                                    | Who can read it                                                     | Why it matters                                               |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| AI provider keys              | `ai_provider_secrets.ciphertext` (AES-256-GCM)                                    | app process at call time; owner via write-only UI (never displayed) | spend, upstream account take-over                            |
| Webhook signing secrets       | `webhook_secrets.ciphertext` + `previous_ciphertext`                              | app process and job drain at delivery time                          | forged deliveries to every receiver that trusts the endpoint |
| OAuth access/refresh tokens   | better-auth `account` table (`encryptOAuthTokens`, W1.5)                          | app process                                                         | GitHub repository access of the signed-in reader             |
| Auth signing secret / keyring | `.env` → process env (`BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS`)                | host root, container env                                            | session forgery, 2FA/OAuth token decryption                  |
| Master keyring                | `.env` → process env (`SECRETS_KEYS`, `SECRETS_KEY_ACTIVE`); legacy `SECRETS_KEY` | host root, container env                                            | decrypts every DB-stored credential                          |
| Database dumps                | restic data repository (encrypted)                                                | restic password holder                                              | offline copy of the DB                                       |
| Config backup                 | restic config repository, different password                                      | config-repo password holder                                         | `.env`: DB password, auth secret, master keyring             |

## 2. Adversaries and what each control buys

| #   | Adversary / scenario                                                      | Control                                                                                                                                | What it buys                                                                                                                                                       | What it does **not** buy                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Data-repository leak** (restic repo + its password, i.e. the DB dump)   | Envelope encryption with a keyring that is never inside the data repository                                                            | Provider keys and webhook secrets stay ciphertext; OAuth tokens stay `$ba$…` ciphertext. A DB-only dump cannot decrypt anything.                                   | It does not protect rows the app stores in plaintext for functional reasons (see §4). It does not protect a dump that also carries the master key.                                                                                                                           |
| A2  | **Read-only DB access** (SQL injection read, replica, `pg_dump` by a DBA) | Same encryption; UI returns status only; audit payloads carry hints, never values                                                      | Same as A1 for encrypted columns; no plaintext secret is reachable with `select *`.                                                                                | The attacker sees ciphertext, provider names, hints (`sk-…Abcd`), timestamps. Traffic analysis and denial of service remain.                                                                                                                                                 |
| A3  | **Both repositories + both passwords leak**                               | Separate passwords, different key material, offline copy in the password manager                                                       | Forces two independent compromises and raises the bar for the "backup" thief.                                                                                      | If both repos and both passwords are stolen, the attacker holds the DB and the `.env` — equivalent to application compromise (see A5).                                                                                                                                       |
| A4  | **Host root / container escape / malicious dependency**                   | None. Documented non-goal.                                                                                                             | Nothing.                                                                                                                                                           | Root can read `/proc/<pid>/environ`, process memory, modify code and audit rows, and decrypt everything. The DB encryption is not a control against root; it only raises the bar for a leaked _file_.                                                                        |
| A5  | **Admin account takeover** (owner credentials, session theft)             | Owner-only writes; write-only display; audit rows; 3 alert rules; admin 2FA policy (W1.6)                                              | A stolen _reader_ session cannot read or write secrets; a stolen owner session can rotate/clear keys (destructive, audited) but still cannot read existing values. | A stolen **owner** session can point a provider at an attacker host (SSRF guard limits this) or clear/rotate keys — availability and future calls are at risk. Any admin can be impersonated by the owner role (`impersonate-admins`); that is an existing product decision. |
| A6  | **Support bundle / logs / error pages**                                   | Typed errors carry no ciphertext; redaction at every log site; audit payload = `{providerId, hint, source}`                            | Diagnostics do not become a credential leak.                                                                                                                       | Crash dumps / heap snapshots taken by an operator can still contain plaintext in memory.                                                                                                                                                                                     |
| A7  | **CI logs**                                                               | Secret values are never in the repo; guards only compare schema/SQL                                                                    | A public CI log cannot leak a runtime credential.                                                                                                                  | A compromised CI runner with deployment secrets has the same power as A4.                                                                                                                                                                                                    |
| A8  | **Laptop theft / `.env` copy**                                            | `.env` is in the config repository only, `chmod 600`, never in the data repository                                                     | A data-repo-only theft cannot read the env.                                                                                                                        | A copied `.env` is plaintext. Full-disk encryption and a password manager are the controls there; the app cannot detect a copy.                                                                                                                                              |
| A9  | **Old dump after a key rotation**                                         | Keyring keeps every version used by a retained backup for at least the backup retention window + one release cycle                     | A dump from before the rotation still decrypts with the old version in the keyring.                                                                                | A dump restored after the old version is retired is unreadable — that is the documented cost of retiring a version.                                                                                                                                                          |
| A10 | **Decrypt failure treated as "try another key"**                          | Typed resolver: `missing`, `decrypt_failed`, `unknown_key_version`, `store_unavailable`, `denied`; only `missing` may fall back to env | A wrong master key fails closed (no silent failover to another provider / env value), so a rotation bug is visible instead of billing another account.             | A misconfigured environment still takes the feature down; the failure is deliberate and visible.                                                                                                                                                                             |

## 3. Restic scenario, stated exactly

Two repositories, two passwords (`deploy/backup/backup.sh`):

| Repository | Contents                                                        | Password                 |
| ---------- | --------------------------------------------------------------- | ------------------------ |
| data       | `pg.dump` (compressed logical dump), `$DATA_DIR`, RustFS volume | `RESTIC_PASSWORD`        |
| config     | `.env` only (one file, no directory)                            | `RESTIC_CONFIG_PASSWORD` |

Consequences:

- **Data repo + its password, no config repo** → every encrypted column is
  ciphertext. `SECRETS_KEYS` is not in this repository by construction; the
  backup script mounts neither `.env` nor the app directory.
- **Config repo + its password, no data repo** → the env is readable but there is
  no ciphertext to decrypt. (`.env` still holds the DB password; treat it as a
  full infrastructure secret.)
- **Both** → equivalent to A4/A5. Do not claim otherwise.
- **Master key lost** → every DB-stored credential is unrecoverable. Re-enter
  the provider keys and rotate every webhook secret; the DB rows are garbage.
- **DB lost, master key kept** → restore the dump, keep the same keyring, start
  the app; credentials work. No re-encryption is required.

The keyring lives in `.env` and therefore in the **config** repository. That is
deliberate: one encrypted backup with a different password is more recoverable
than a key that exists on exactly one disk. The offline copy in the password
manager covers the "config repo is gone" case.

## 4. Registered residual risks (not fixed by P2)

| Risk                                                        | Why it remains                                                         | Trigger / follow-up                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plaintext in process memory                                 | unavoidable while the app uses the key                                 | host-root model (A4)                                                                                                                                                                                                                |
| `webhooks.payload_url` is plaintext                         | it is configuration, not a credential; needed for display and delivery | none                                                                                                                                                                                                                                |
| Hints (`sk-…Abcd`, `whsec_…Abcd`) reveal a prefix/suffix    | needed to identify a key without revealing it                          | shorten the hint if a vendor's prefix is itself sensitive                                                                                                                                                                           |
| Env fallback for AI keys (`api_key_env`)                    | bootstrap compatibility; the UI shows `source: env`                    | retire after one release cycle (W2.4 keeps it)                                                                                                                                                                                      |
| Legacy `webhooks.secret` column during the migration window | old rows and a rollback must keep verifying                            | after `db:migrate-webhook-secrets --apply` the old column is NULL, so an image rollback would break every delivery: roll forward or restore the pre-backfill dump (RUNBOOK §4.2 rollback window); drop the column in a later window |
| Alert delivery is best-effort                               | `ALERT_WEBHOOK_URL` is a systemd hook, not a durable queue             | M6 outbox (W11) is the durable path                                                                                                                                                                                                 |
| A second webhook rotation inside the 24 h grace window      | the table holds one previous value, not a history                      | rotate once per window, or accept that the first previous value stops verifying; a multi-generation history would need a separate table                                                                                             |
| Multi-replica keyring distribution                          | one `.env` today                                                       | KMS / existingSecret when the deployment grows                                                                                                                                                                                      |

## 5. Keyring and rotation

### 5.1 Format

```
SECRETS_KEYS="2:<base64 32B>,1:<base64 32B>"   # newest/active first
SECRETS_KEY_ACTIVE="2"                          # must name a version above
SECRETS_KEY="<base64 32B>"                      # legacy single key -> version 1
```

- `SECRETS_KEYS` is the map. `SECRETS_KEY_ACTIVE` must be present and must
  name a version in the map, otherwise the first secret read or write fails
  with a configuration error (fail-closed, no implicit "first key" guess).
  There is no boot-time probe: a bad keyring surfaces on the first operation,
  not at `up -d`, so run `node scripts/verify-secret-key-versions.ts` (or the
  smoke test) as a deploy gate.
- `SECRETS_KEY` alone is accepted as version 1 for a single-key deployment and
  for compatibility with W1's documentation. When both are set, the legacy key
  is merged as version 1 if the map has no version 1; a conflict (same version,
  different bytes) is a configuration error rather than a silent preference.
- Keys are exactly 32 bytes, base64 or hex. Anything else is a configuration
  error, not a fallback.
- The keyring must **never** be derived from `BETTER_AUTH_SECRET`: rotating the
  auth secret would destroy every stored credential.

### 5.2 Three-phase rotation

1. **Distribute**: add the new version to every replica's `SECRETS_KEYS` (keep
   the old one), restart. No writes use it yet; every replica can now read it.
2. **Activate**: set `SECRETS_KEY_ACTIVE=<new>`, restart. New writes use the
   new version; old ciphertext stays readable through the keyring.
3. **Retire**: after the backup retention window + one release cycle, remove the
   old version and restart. Before removing it run
   `node --env-file=.env scripts/verify-secret-key-versions.ts --retire <n>`:
   it decrypts every live row (both webhook slots, skipping expired grace
   values) and exits 1 while any row is still encrypted under `<n>`. A plain
   run without `--retire` only proves that listed versions exist; it cannot
   fail at this step because the version is still in `SECRETS_KEYS`.

A `current + previous` pair is not enough: a rolling deploy lets a new replica
write v2 while an old replica cannot read it, and a dump from two rotations ago
references a version that a two-slot scheme already dropped.

### 5.3 Failure modes

| Code                  | Meaning                                  | Behaviour                                                            |
| --------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `missing`             | no DB row and no env fallback            | env fallback may answer (`source: env`); audited as `ai.key_missing` |
| `decrypt_failed`      | ciphertext present, tag/AAD/key wrong    | terminal; `ai.key_decrypt_failed`; alert                             |
| `unknown_key_version` | row names a version the keyring lacks    | terminal; same alert as decrypt failure                              |
| `store_unavailable`   | table/schema missing                     | terminal 503; do not boot-loop the feature                           |
| `denied`              | caller is not owner / write path refused | `ai.key_denied`; alert after 3 in 10 min                             |

Only `missing` may fall back. Every other code fails closed.

## 6. Alerts (decision A3)

Reuses `ALERT_WEBHOOK_URL` (the same systemd `OnFailure` target). Three rules:

1. `ai.key_decrypt_failed` — any occurrence in 5 minutes.
2. `ai.key_missing` — at least 3 for the same provider in 10 minutes with zero
   successful calls for that provider in the window.
3. `ai.key_denied` — at least 3 for the same actor in 10 minutes.

Delivery is best-effort and throttled per rule (one POST per rule per 5
minutes); the audit row is the durable record. An empty URL disables delivery
without disabling the audit.

## 7. Verification checklist

Status after the W2 gate (2026-11-13); items that need a live deployment stay
open on purpose.

- [x] Data repository contains no `.env` (backup.sh mounts only the dump dir,
      `$DATA_DIR`, RustFS volume).
- [x] A row written under one keyring fails closed: a different key gives
      `decrypt_failed`, an absent version gives `unknown_key_version`, and no
      env value is consulted (local DB probe, 3/3). A full restic restore drill
      is still required before production sign-off (RUNBOOK §4.2).
- [ ] Restore **with** the keyring proves credentials work with no re-entry
      (needs the production repository and a scratch database).
- [x] Three-phase rotation is pinned by unit tests: old rows stay readable, new
      writes use the active version, a retired version fails with
      `unknown_key_version`. A live rotation follows RUNBOOK §4.2.
- [ ] `grep` page HTML / network responses / live server logs for a plaintext
      key: the write-only UI and resolver tests cover the code path, but no live
      deployment was searched in this session.
- [x] `ai.key_*` rows are written for set / rotate / clear / decrypt_failed /
      missing / denied with no value in the payload (action and reporter tests;
      `deliver: false` keeps them off the webhook plane).
- [ ] Alert rules fire against a real receiver (`ALERT_WEBHOOK_URL`); only the
      dry-run evaluation was exercised here.

## 8. Related documents

- `deploy/RUNBOOK.md` §1.1 (required env), §3.1 (better-auth keyring),
  §4.2 (runtime keyring, rotation, restore matrix), §4 (backup split).
- `src/lib/server/db/AUTH_SCHEMA.md` (generated schema guard, allowed options).
- `notes/notes/secrets-architecture-20261112.md` (design record),
  `notes/notes/secrets-decision-register-20261112.md` §0.1 (final rulings).
