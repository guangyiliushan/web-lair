# Sentinel traffic fixtures

`traffic-dashboard.json` is a verbatim `GET /api/traffic/dashboard?range=24h&paths_limit=1000&breakdown_limit=50`
response captured on 2026-11-16 from the digest pinned in
`deploy/monitoring/compose.sentinel.yaml`:

```
ghcr.io/coollabsio/sentinel@sha256:b3ee40d4d00b508c1018e67dc6a9e5693d0027b117f560c9fb003f464879243e
```

The instance ran traffic-only (`TRAFFIC_ENABLED=true`, `TRAFFIC_PROXY_TYPE=caddy`,
`TRAFFIC_IP_MODE=off`, `GEOIP_ENABLED=false`, collector/storage/push off) and
tailed nine synthetic Caddy JSON access-log lines (page paths, `/_app/`,
`/i/`, `/api/`, static files, and two 404s). The fixture is used by
`sentinel.test.ts` as the contract-shape source and as the PV-filter input.

To refresh it, run the pinned image against a synthetic log and save the
response over this file. Do not hand-edit: the point is that the test reads
the wire format the service actually emits.
