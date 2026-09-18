# KURA runs as one container: the engine (Fastify + SQLite + a stdio MCP child) and the
# Next.js console beside it. They are deliberately not split — the engine holds a
# WAL SQLite hash chain on disk, a long-lived child process, and in-memory chaos state,
# none of which survive a serverless function boundary.
FROM node:24-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/engine/package.json apps/engine/
COPY apps/web/package.json apps/web/
# better-sqlite3 is a native module; it must be built against this image's Node ABI.
# npm 11 defers install scripts behind allowScripts, so `npm ci` alone leaves it without
# a compiled binary and the engine cannot open the ledger at runtime. `npm rebuild`
# runs the build explicitly, and the check below fails the image rather than shipping
# one that dies on first write.
RUN npm ci \
 && npm rebuild better-sqlite3 --foreground-scripts \
 && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node

FROM base AS build
# npm workspaces hoist every dependency to the root node_modules — apps/*/node_modules
# are not created at all. Copying from those paths is what made every earlier build of
# this file fail at "stat app/apps/engine/node_modules: file does not exist".
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --workspace=apps/web

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./

# The ledger lives on a mounted volume so the hash chain survives a redeploy. Without
# this the chain silently restarts from genesis on every release, which would make the
# audit trail worthless.
ENV LEDGER_PATH=/data/kura_flight_recorder.db
ENV ENGINE_PORT=4000
ENV ENGINE_ORIGIN=http://127.0.0.1:4000
ENV PORT=3000
RUN mkdir -p /data

COPY docker-start.sh /usr/local/bin/kura-start
RUN chmod +x /usr/local/bin/kura-start

EXPOSE 3000
CMD ["/usr/local/bin/kura-start"]
