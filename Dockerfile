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
# Locked to the packageManager field so the lockfile stays authoritative.
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate
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
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

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
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
COPY package.json ./
# uid/gid 1000 matches a standard Ubuntu deploy user so bind-mounted DATA_DIR
# works without chown gymnastics (deploy/RUNBOOK.md).
USER node
EXPOSE 3000
CMD ["node", "build"]
