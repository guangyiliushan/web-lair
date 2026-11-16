# Backrest + PostgreSQL 18 client (M6 P2, T2.1).
#
# Why a derived image instead of the upstream tag: the dump gates have to run
# *inside* the backup container (the CONDITION_SNAPSHOT_START hook), and
# pg_dump refuses a server newer than itself — the server here is postgres:18,
# while the upstream Alpine image ships no PostgreSQL client at all.
#
# Pinning policy: the base is pinned by tag *and* digest, so a re-tagged
# upstream cannot silently change what a deploy builds. Bump both together
# (`docker buildx imagetools inspect garethgeorge/backrest:vX.Y.Z-alpine`) and
# re-run deploy/restore-drill.sh before deploying.
FROM garethgeorge/backrest:v1.14.1-alpine@sha256:b852979754281026230cc69fb11428e6d57c9a97784ab4a444ffc7934c53a215

# Build-time proxy for CI/LAN builds behind one; empty by default. BuildKit
# forwards these to RUN as environment variables.
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=

# postgresql18-client: pg_dump / pg_restore / psql 18 for the dump gates.
# bash, curl and restic already come from the upstream image (Dockerfile.alpine).
RUN apk add --no-cache postgresql18-client

# Renders /config/config.json from the environment, then execs upstream's
# entrypoint. Kept in the image (not bind-mounted) so the config schema and the
# image tag move together.
COPY entrypoint.sh /lair-entrypoint
RUN chmod 0755 /lair-entrypoint

# Same hand-over as upstream: tini reaps zombies, the entrypoint fills in docker
# defaults and execs the command.
ENTRYPOINT ["/sbin/tini", "--", "/lair-entrypoint"]
CMD ["/backrest"]
