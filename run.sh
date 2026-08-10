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

if [ -z "${MEDHA_TOKEN:-}" ]; then
  echo "MEDHA_TOKEN is not set."
  echo "  Medha app -> menu -> API clients -> Add client (id: sandeshika)"
  echo "  Grant it sms.read, then:  export MEDHA_TOKEN=<token>"
  echo "  Or try the demo:          ./run.sh mock"
  exit 1
fi

echo "Forwarding the phone's Medha to this machine..."
adb forward tcp:8080 tcp:8080 || echo "  (adb not available - set MEDHA_URL manually)"
echo "Making this server reachable from the phone as localhost..."
adb reverse "tcp:$PORT" "tcp:$PORT" || true

exec python3 app.py --port "$PORT" --token "$MEDHA_TOKEN"
