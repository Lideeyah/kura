#!/bin/sh
# Engine first, console second. If the engine dies the container should die with it
# rather than serving a console wired to nothing.
set -e

npx tsx apps/engine/src/index.ts &
ENGINE_PID=$!

# Wait for the engine to answer before the console starts proxying to it.
#
# Probed with node, not wget or curl: neither is present in node:24-slim, so the
# original probe could never succeed and this script killed a perfectly healthy engine
# after 60s without ever starting the console.
health() {
  node -e "fetch('http://127.0.0.1:'+process.env.ENGINE_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null
}

i=0
until health; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[kura] engine did not become healthy in 60s" >&2
    exit 1
  fi
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    echo "[kura] engine exited during startup" >&2
    exit 1
  fi
  sleep 1
done
echo "[kura] engine healthy, starting console"

npx next start apps/web -p "${PORT}" &
WEB_PID=$!

trap 'kill $ENGINE_PID $WEB_PID 2>/dev/null' TERM INT

# Supervise both children with a POSIX poll rather than `wait -n`, which is a bash
# builtin: /bin/sh here is dash, where it fails with "Illegal option -n" and, under
# `set -e`, tore down the container the moment the console started.
#
# Either child exiting takes the whole container down, so the platform restarts it
# rather than leaving a console wired to a dead engine.
while kill -0 "$ENGINE_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 2
done

if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
  echo "[kura] engine exited; stopping the console" >&2
else
  echo "[kura] console exited; stopping the engine" >&2
fi
kill "$ENGINE_PID" "$WEB_PID" 2>/dev/null || true
exit 1
