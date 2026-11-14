# Edge and anti-abuse baseline (W6.10 / W6.11)

The site ships layered defence: Cloudflare Free at the edge when the operator
accepts the proxy, Caddy bounds at the origin, and fail-closed application
buckets per account **and** per client address. Nothing here stores a raw IP
in a business table; the only place an IP appears is the short-lived Caddy
JSON access log (30 days, token paths excluded).

## 1. Cloudflare Free (recommended start)

Free plan capabilities used here (Cloudflare docs, 2026):

- unmetered DDoS mitigation;
- **1** rate-limiting rule (10 s period, IP-counted; Free fields: Path and
  Verified Bot);
- **5** custom rules, IP Access rules, Zone Lockdown;
- Origin CA certificates.

### Setup

1. Add the zone, enable the orange cloud for the apex and `www`.
2. SSL/TLS mode **Full (strict)**; install a Cloudflare Origin CA certificate
   on the origin (Caddy `tls` stanza) or switch ACME to DNS-01.
   HTTP-01 cannot complete through the proxy.
3. Enable **Bot Fight Mode** (Free) and the managed ruleset.
4. Add the single Free rate-limit rule on the most abused family — the
   credential and write endpoints:

   | Field    | Value                                                          |
   | -------- | -------------------------------------------------------------- |
   | Path     | `/login` and `/api/auth/*` (split into two rules only on Pro+) |
   | Requests | 20 per 10 seconds per IP                                       |
   | Action   | Block (or Managed Challenge)                                   |

   Application buckets below remain the authoritative limits; the edge rule
   only sheds floods before they reach Node.

5. Custom rules (examples):
   - block requests to the origin with a Host header that is not the zone;
   - challenge `/admin/*` for non-verified bots;
   - allow the health check path (`/api/health`) from the monitor only.
6. Lock the origin: firewall port 80/443 to Cloudflare ranges only, or
   `ufw`/nftables with the current list at
   <https://www.cloudflare.com/ips/>. Direct origin access must be refused.
7. Uncomment `trusted_proxies` / `client_ip_headers` in `deploy/Caddyfile` so
   Caddy forwards the real client IP in one `X-Forwarded-For` hop; keep
   `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` in `.env`.

### Verified-bot and webhook exceptions

Do not rate-limit or challenge:

- `/api/health` (monitor);
- verified search/AI crawlers you want (the robots policy in
  `ai.crawl` is a signal, not access control);
- any provider webhook path — none exist in M4, register when they do.

## 2. Caddy at the origin

`deploy/Caddyfile` now carries:

- `request_body { max_size 26MB }` — matches `BODY_SIZE_LIMIT`, one 25 MB
  upload plus multipart overhead;
- `servers { timeouts { read_body 60s idle 120s } }` — bounds dribble attacks;
  the presence SSE stream keeps alive every 15 s, inside the idle window;
- `flush_interval -1` — SSE is never buffered;
- JSON access log, 100 MB × 10, **`roll_keep_for 720h`** (30 days), with
  `*/subscribe/confirm*`, `*/unsubscribe*`, `*/reset-password*` and
  `/api/auth/*` excluded so bearer tokens never reach a log file.

Self-hosted alternative to Cloudflare: `caddy-ratelimit` (community module,
requires an xcaddy build) plus CrowdSec and nftables. It has no volumetric
cleaning; treat it as a fallback, not an equivalent.

## 3. Application buckets (authoritative)

All security endpoints use `rateLimitStrict` — a dead Valkey answers
**503 + Retry-After**, never a free pass. Read paths keep the fail-open
limiter so the site stays usable without the cache.

| Endpoint                      | Bucket                                                                                           | Limit       |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ----------- |
| Login                         | `limits:login:<ip>`                                                                              | 10 / 15 min |
| Register                      | `limits:signup:<ip>`                                                                             | 5 / hour    |
| Verify email                  | `limits:verify:<ip>`                                                                             | 5 / hour    |
| Password reset                | `limits:password-reset:<ip>`                                                                     | 5 / hour    |
| Comment create                | per reader 2 / 60 s (fail-open, unchanged) **and** `limits:comment-ip:<ip>` 30 / 10 min (strict) |
| Uploads (files/photos/editor) | `limits:upload:<uid>` 60 / 10 min + `limits:upload-ip:<ip>` 30 / 10 min (both strict)            |
| AI chat stream                | `limits:ai-chat:<uid>` 30 / hour + `limits:ai-chat-ip:<ip>` 60 / hour (strict)                   |
| AI transcribe                 | `limits:ai-transcribe:<uid>` 20 / hour + `limits:ai-transcribe-ip:<ip>` 40 / hour (strict)       |
| Presence SSE connect          | `limits:presence-connect:<ip>` 30 / min (fail-open, 429 + X-Retry-After)                         |
| Presence heartbeat            | per token 30 / 60 s (fail-open, unchanged)                                                       |

IPv6 addresses are aggregated on their `/64` (`clientAddressKey`), so a client
rotating inside its own subnet shares one budget. IPv4 keeps the exact
address. A spoofed `X-Forwarded-For` cannot shift a bucket: the adapter reads
from the right-most trusted hop (`XFF_DEPTH=1`), and the edge must not forward
a client-supplied header when the orange cloud is off.

## 4. Verification

```sh
# 429/503 + Retry-After on each endpoint (staging)
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' \
  -X POST --data 'email=a@b.c&password=x' https://$DOMAIN/login; done; echo

# Valkey kill: security endpoints 503, read paths 200
docker compose -f compose.prod.yaml stop valkey
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/           # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://$DOMAIN/login  # 503

# IPv6 /64 aggregation: rotate inside one /64, budget stays shared
# XFF spoof: -H 'X-Forwarded-For: 203.0.113.9' must not change the bucket

# Source exposed only to Cloudflare
curl -s --resolve $DOMAIN:443:$ORIGIN_IP https://$DOMAIN/  # refused/timeout

# SSE not buffered
curl -N -H 'Accept: text/event-stream' https://$DOMAIN/api/presence/stream?c=<uuid>
```

## 5. Cloudflare plan escalation

Upgrade to Pro/Business only when the single Free rate-limit rule is
insufficient, a sustained L7 attack appears, or more WAF/rate rules are
needed. Record the trigger in the decision register §3B.6 before spending.
