#!/bin/sh
# Engine first, console second. If the engine dies the container should die with it
# rather than serving a console wired to nothing.
set -e

npx tsx apps/engine/src/index.ts &
ENGINE_PID=$!

# Wait for the engine to answer before the console starts proxying to it.
i=0
until wget -q -O /dev/null "http://127.0.0.1:${ENGINE_PORT}/api/health" 2>/dev/null; do
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
wait -n $ENGINE_PID $WEB_PID
exit $?
