# syntax=docker/dockerfile:1

# --- Deno binary (used to run each app's backend) -------------------------
FROM denoland/deno:bin-2.8.3 AS deno

# --- Base image with pnpm ----------------------------------------------------
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app
RUN corepack enable

# --- Dependencies ------------------------------------------------------------
# Install ALL deps (including dev) and DO run install scripts: the platform
# needs `buf` + `protoc-gen-es` (codegen) and `esbuild` (bundling) at runtime
# when it builds apps, and those packages fetch native binaries on install.
FROM base AS deps
# pnpm-workspace.yaml carries `onlyBuiltDependencies` (incl. esbuild) — required
# so pnpm runs esbuild's install script and fetches its native binary.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- Build the platform (Nitro node server) ----------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Migrations run at server startup (nitro plugin), not during the build.
RUN SKIP_DATABASE_MIGRATIONS=true pnpm build

# --- Runtime image -----------------------------------------------------------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3700
# Deno caches npm: dependencies here (mount a volume to persist across restarts).
ENV DENO_DIR=/app/.deno

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Deno runs the app backends the platform spawns.
COPY --from=deno /deno /usr/local/bin/deno

# Runtime needs: the built server, the full dependency tree (esbuild bundling +
# buf/protoc-gen-es codegen happen on every deploy), the scaffold template, the
# agent skills, and the SQL migrations applied on startup.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY package.json ./
COPY migrations ./migrations
COPY templates ./templates
COPY skills ./skills

# The agent authors apps under /app/workspace; mount a volume to persist it.
RUN mkdir -p /app/workspace /app/.deno

EXPOSE 3700
CMD ["node", ".output/server/index.mjs"]
