# Deployment image (platform plan §C / D-1): one Node process behind Caddy.
# Node 24: the password gate imports `argon2` from `node:crypto`, which Node 22
# does not export (the postbuild analyse fails with "no export named argon2").
# Build runs inside the deployment host; the gate is
# < 4 GB peak and < 8 minutes.

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
# Ops surface: ship the whole scripts tree + the `lair` shim instead of a
# hand-maintained file list. A missed COPY used to surface only when the
# A deploy ran a script the image did not contain. The manifest
# (scripts/manifest.ts) + scripts/deploy-hooks.ts make that class checkable:
# scripts/check-entries.ts asserts every entry exists and every hook resolves,
# and verify-image.sh asserts `bin/lair --list` works inside the image.
# The tree is ~250 KB of text; tsx-only entries are inert in this stage.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/bin ./bin
# Drain executes `node jobs/drain.ts`; that graph uses only relative .ts imports,
# so ship the jobs tree and the server modules it pulls in.
COPY --from=build /app/jobs ./jobs
COPY --from=build /app/src ./src
COPY package.json ./
# uid/gid 1000 matches a standard Ubuntu deploy user so bind-mounted DATA_DIR
# works without chown gymnastics.
USER node
EXPOSE 3000
CMD ["node", "build"]
