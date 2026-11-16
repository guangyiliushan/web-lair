# Deployment image (platform plan §C / D-1): one Node process behind Caddy.
# Node 24: the password gate imports `argon2` from `node:crypto`, which Node 22
# does not export (the postbuild analyse fails with "no export named argon2").
# Build runs inside the deployment host (see deploy/RUNBOOK.md); the gate is
# < 4 GB peak and < 8 minutes (deploy opening note, Q2).

# --- build: full dependency tree + SvelteKit build ---------------------------
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# SvelteKit's route analysis imports server modules at build time; these
# placeholders satisfy import-time guards. They are passed per-command (not
# ENV) so no secret-looking value lands in image metadata, and they never
# reach the runtime stage.
# Pinned to `package.json` `packageManager` (pnpm@12.16.1): a different pnpm
# interprets the lockfile with its own settings and can silently re-resolve
# the tree (P1/T1.3).
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
	ORIGIN=http://localhost:3000 \
	BETTER_AUTH_SECRET=build-time-placeholder-secret-000000 \
	pnpm build

# --- prod deps: runtime tree only (sharp/exiftool postinstall needs network) --
FROM node:24-bookworm-slim AS prod-deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
# Curated prune (P1/T1.4 fallback; plan §3.5 route 3). The manifest removes the
# paraglide COMPILER chain (~480 MB unpacked: @lix-js/sdk-linux-x64 alone is
# ~360 MB) that only the build stage uses; the runtime imports nothing from it
# (`build/server` references exactly one paraglide subpath,
# `@inlang/paraglide-js/urlpattern-polyfill`). The script also asserts the
# packages the runtime does import are still present - a wrong prune fails the
# build here instead of at 03:00.
COPY deploy/prune-prod-modules.sh deploy/image-prune.txt ./
RUN bash prune-prod-modules.sh image-prune.txt /app

# --- runtime: glibc + perl (exiftool-vendored.pl shebang), non-root ----------
FROM node:24-bookworm-slim AS runtime
# exiftool-vendored 39 runs `exiftool-vendored.pl` on POSIX (#!/usr/bin/perl);
# sharp ships linux-x64 glibc prebuilds. No build toolchain in the image.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends perl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/.drizzle ./.drizzle
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
COPY --from=build /app/scripts/verify-baseline.ts ./scripts/verify-baseline.ts
COPY --from=build /app/scripts/ensure-job-schedules.ts ./scripts/ensure-job-schedules.ts
COPY --from=build /app/scripts/backfill-email-consent.ts ./scripts/backfill-email-consent.ts
COPY --from=build /app/scripts/backfill-suppressions.ts ./scripts/backfill-suppressions.ts
COPY --from=build /app/scripts/verify-suppression-version.ts ./scripts/verify-suppression-version.ts
COPY --from=build /app/scripts/verify-oauth-token-storage.ts ./scripts/verify-oauth-token-storage.ts
COPY --from=build /app/scripts/print-subscribe-token.ts ./scripts/print-subscribe-token.ts
COPY --from=build /app/scripts/secret-alerts.ts ./scripts/secret-alerts.ts
COPY --from=build /app/scripts/migrate-webhook-secrets.ts ./scripts/migrate-webhook-secrets.ts
COPY --from=build /app/scripts/verify-secret-key-versions.ts ./scripts/verify-secret-key-versions.ts
# Drain executes `node jobs/drain.ts`; that graph uses only relative .ts imports,
# so ship the jobs tree and the server modules it pulls in.
COPY --from=build /app/jobs ./jobs
COPY --from=build /app/src ./src
COPY package.json ./
# uid/gid 1000 matches a standard Ubuntu deploy user so bind-mounted DATA_DIR
# works without chown gymnastics (deploy/RUNBOOK.md).
USER node
EXPOSE 3000
CMD ["node", "build"]
