# syntax=docker/dockerfile:1

# --- Deno binary (used to run each app's backend) -------------------------
FROM denoland/deno:bin-2.9.6 AS deno

# --- Base image with pnpm ----------------------------------------------------
FROM node:26-slim AS base
WORKDIR /app
RUN npm install --global pnpm@11.24.0

# --- Dependencies ------------------------------------------------------------
# Install ALL deps (including dev) and DO run install scripts: the platform
# needs `buf` + `protoc-gen-es` (codegen) and `esbuild` (bundling) at runtime
# when it builds apps, and those packages fetch native binaries on install.
FROM base AS deps
# pnpm-workspace.yaml carries `allowBuilds` (incl. esbuild) — required
# so pnpm runs esbuild's install script and fetches its native binary.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- Build the platform (Nitro node server) + the Agent Runner bundle --------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Migrations run at server startup (nitro plugin), not during the build.
RUN pnpm build

# --- Runtime image -----------------------------------------------------------
FROM node:26-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3700
ENV AGENT_INTERNAL_HOST=0.0.0.0
ENV AGENT_INTERNAL_PORT=3701
# Deno caches npm: dependencies here (mount /cache to persist across restarts).
ENV DENO_DIR=/cache/deno

# Runtime tools used by the platform and Agent Runner. git backs canonical
# app/workflow repos and local worktrees; the remaining tools are available to
# model-controlled commands and deployment scripts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python-is-python3 \
    python3 \
    python3-pip \
    rsync \
    unzip \
    util-linux \
    wget \
  && rm -rf /var/lib/apt/lists/*

# Compatibility user used only to probe/fallback-test setpriv. Actual Agent
# shells and worktree git run under a stable numeric UID/GID unique to their
# session. This keeps AGENT_RUNNER_TOKEN — present only in the root Runner's
# environment — unreadable from /proc and isolates sessions from one another.
# The Runner itself stays root so it can allocate identities and setpriv/chown.
RUN useradd --system --user-group --no-create-home hatch-sandbox

# Deno runs the app backends the platform spawns.
COPY --from=deno /deno /usr/local/bin/deno

# Runtime needs: the built server, the full dependency tree (esbuild bundling +
# buf/protoc-gen-es codegen happen on every deploy), the scaffold template, the
# agent skills, the built-in Hatch SDK, and SQL migrations applied on startup.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The Agent Runner service: same image, alternate entrypoint
# (`node dist/runner/main.mjs`), no DB credentials.
COPY package.json ./
COPY migrations ./migrations
COPY templates ./templates
COPY skills ./skills
COPY --from=build /app/packages/hatch-data/package.json ./packages/hatch-data/package.json
COPY --from=build /app/packages/hatch-data/dist ./packages/hatch-data/dist

# Runtime data lives in /app/workspace; dependency/tool caches live in /cache.
RUN mkdir -p /app/workspace /cache/deno

EXPOSE 3700
# Platform (default). The Agent Runner runs the same image with
# `command: ["node", "dist/runner/main.mjs"]` (see docker-compose.yml).
CMD ["node", "dist/platform/server/index.mjs"]
