#!/usr/bin/env bash
# Sandeshika launcher.
set -euo pipefail
cd "$(dirname "$0")"

[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q -r requirements.txt

MODE="${1:-real}"
PORT="${PORT:-5000}"

if [ "$MODE" = "mock" ]; then
  echo "Demo mode: synthetic inbox, no phone required."
  exec python3 app.py --mock --port "$PORT"
fi

# No token is required to start. Paste it in the Setup screen instead --
# demanding it here is what previously left users stuck behind a locked field
# when the exported value was stale.
if [ -z "${MEDHA_TOKEN:-}" ]; then
  echo "No MEDHA_TOKEN exported - you can paste the token in the Setup screen."
fi

MEDHA_PORT="${MEDHA_PORT:-8080}"
echo "Forwarding the phone's Medha (port $MEDHA_PORT) to this machine..."
adb forward "tcp:$MEDHA_PORT" "tcp:$MEDHA_PORT" \
  || echo "  (adb not available - set the address in Setup instead)"
echo "Making this server reachable from the phone as localhost..."
adb reverse "tcp:$PORT" "tcp:$PORT" || true

exec python3 app.py --port "$PORT" \
  --medha "http://127.0.0.1:$MEDHA_PORT" \
  ${MEDHA_TOKEN:+--token "$MEDHA_TOKEN"}
