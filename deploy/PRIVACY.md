# Privacy operations and DSR runbook (W6.11)

Operator-side companion to `/privacy`: every claim on the public page maps to an implementation fact here; if one becomes false, change both files in the same batch.

Scope: data inventory, retention, DSR handling and audit queries only. Log/edge configuration lives in `deploy/EDGE.md`; operations in `deploy/RUNBOOK.md`.

## 1. Data inventory and retention

| Data                                                              | Where                                           | Retention                                           | Notes                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Account email, name, password hash, sessions                      | `user`, `session` (Better Auth)                 | until account deletion                              | Argon2id hash; no plaintext                                                                                                    |
| Profile (display name, avatar URL, header label)                  | `user_profiles`                                 | until account deletion / clear                      |                                                                                                                                |
| Comments (text, author snapshot, timestamps, moderation, anchors) | `comments`                                      | author-controlled (soft delete)                     | `ip`, `agent`, `location` stay NULL by construction                                                                            |
| Comment country / region                                          | `comments.country_code`, `comments.region_code` | `comments.privacy.retentionDays` (default 90)       | only with `collectCountry`; cleared by `jobs.prune` even after the switch is turned off; deleting a comment clears immediately |
| Comment country opt-in flag                                       | `comments.meta.showCountry`                     | same as the comment                                 | public label needs site `showCountry` **and** this flag                                                                        |
| Newsletter subscriptions                                          | `subscriptions`                                 | until unsubscribe                                   | token links are excluded from access logs                                                                                      |
| Audit trail                                                       | `activities`                                    | 24 months (`jobs.prune`)                            | settings events carry `deliver:false` (no webhook fan-out)                                                                     |
| AI usage / chat                                                   | `ai_usage`, `ai_agent_conversations`            | 24 months / `ai.chat.retentionDays` (archived only) |                                                                                                                                |
| Uploaded media                                                    | storage provider + `files` rows                 | until purge / delete                                |                                                                                                                                |
| HTTP access log                                                   | Caddy `caddy_logs` volume                       | 30 days                                             | the only place an IP appears; token paths excluded; config in deploy/EDGE.md                                                   |
| Traffic analytics aggregates                                      | `sentinel_data` volume (Sentinel SQLite)        | 48 h (1m) / 30 d (1h) / 395 d (1d) tiers            | derived from the access log; `TRAFFIC_IP_MODE=off` stores no IP; referer/UA/device/status breakdowns; rebuildable              |

The raw commenter IP is **never** written to a business table: read from the adapter, used in-request for the per-IP rate bucket and optional CIDR check, then dropped.

## 2. Access-log handling

- Container volume `caddy_logs`, readable only by operators with host access to the Docker daemon. Never copy logs off-host; if a provider needs data, export a redacted slice.
- Privacy facts: the access log is the **only** place an IP appears, it is retained 30 days, and token paths never reach it. Rotation, exclusion-path and Sentinel tail configuration lives in deploy/EDGE.md.
- On-demand deletion: remove the volume contents or the whole volume; nothing else references the files.
- Analytics privacy: with `TRAFFIC_IP_MODE=off` the `sentinel_data` SQLite stores no IP addresses — unique-visitor counts are HyperLogLog sketches over fixed-key SipHash hashes of the client IP (counts, not addresses), and query paths are capped at `TRAFFIC_TOPN` with the remainder in `__other__`. To erase the aggregates, stop `sentinel` and delete the `sentinel_data` volume; the data is derived and rebuilds from future log lines.

## 3. Data-subject requests (DSR)

Identify the subject by the email they used (never by IP — it is not stored).

**Access / export** (run against production, read-only):

```sql
select id, email, name, created_at from "user" where email = $1;
select id, created_at, text, state, country_code, region_code
  from comments where reader_id = $2 order by created_at;
select email, lang, state, created_at from subscriptions where email = $1;
```

**Deletion**:

1. Comments: the reader can delete each comment from the UI (soft delete clears `country_code`, `region_code`, `meta`). For an erasure request, additionally anonymise `author`/`avatar` and hard-delete after the audit window if required by the jurisdiction.
2. Account: the account-deletion flow (W8) must (a) delete `session`, `user` rows and (b) clear comment country/region/meta for that reader. Until the flow ships, run:

   ```sql
   update comments set country_code = null, region_code = null, meta = null
     where reader_id = $1;
   delete from session where user_id = $1;
   delete from "user" where id = $1;
   ```

   (Check FKs first; `comments.reader_id` is `ON DELETE SET NULL`.)

3. Subscriptions: unsubscribe from the email link, or move the address to the suppression list.

**Objection**: turn off `comments.privacy` (owner) — country/region collection stops immediately; existing values are cleared by the next prune.

Answer within the period required by law; record the request and the actions in the audit trail (`activities`) without storing extra PII.

## 4. Audit queries

```sql
-- No raw IP ever landed in comments (must be 0)
select count(*) from comments where ip is not null or agent is not null or location is not null;

-- Country rows older than the configured window (must be 0 after jobs.prune)
select count(*) from comments
 where created_at < now() - interval '90 days'
   and (country_code is not null or region_code is not null);

-- Settings events never fanned out to webhooks
select count(*) from webhook_deliveries d join activities a on a.id = d.activity_id
 where a.event in ('comments.settings_update','friends.update','presence.update',
                   'notes_gate.update','privacy.update');
```

Run these after a retention change and before a release that touches comments.

## 5. Registered deferrals

Consent records, raw-IP evidence storage, `/terms`, provider DPAs and GeoIP library selection are registered in the decision register §3C.7 with their triggers; none of them is silently assumed here.
