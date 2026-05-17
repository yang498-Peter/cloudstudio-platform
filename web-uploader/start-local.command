#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

PORT="${PORT:-8090}"
URL="http://localhost:${PORT}/viewer"
VENV_PYTHON="$APP_DIR/.venv/bin/python"

python_runtime_ok() {
  local py_bin="$1"
  [ -x "$py_bin" ] || return 1
  "$py_bin" -c "import importlib.util, sys; mods = ['numpy', 'laspy', 'pyproj', 'lazrs', 'scipy', 'matplotlib']; missing = [m for m in mods if importlib.util.find_spec(m) is None]; sys.exit(0 if not missing else 1)" >/dev/null 2>&1
}

resolve_js_runtime() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  return 1
}

JS_RUNTIME="$(resolve_js_runtime || true)"
if [ -z "$JS_RUNTIME" ]; then
  echo "[error] no JavaScript runtime found. Install Bun or Node.js."
  exit 1
fi

if [ ! -d "node_modules" ] || ! python_runtime_ok "$VENV_PYTHON"; then
  echo "[setup] local runtime not ready, running setup:local ..."
  if [[ "$JS_RUNTIME" == *"bun" ]]; then
    bash ./setup-local.sh --runtime bun
  else
    npm run setup:local
  fi
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[info] port ${PORT} is already in use."
  echo "[info] assuming the local server is already running; opening browser only."
  open "$URL"
  echo "[info] if you want this window to own the server process, close the other terminal window first and run this script again."
  exit 0
fi

echo "[start] launching local server on port ${PORT} using $(basename "$JS_RUNTIME") ..."

(
  echo "[wait] waiting for ${URL} ..."
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:${PORT}/viewer" >/dev/null 2>&1; then
      echo "[open] ${URL}"
      open "$URL"
      exit 0
    fi
    sleep 0.5
  done
  echo "[warn] browser was not opened automatically because the server did not become ready in time."
) &

exec env PYTHON_BIN="$VENV_PYTHON" PYTHON3_BIN=python3 PORT="$PORT" "$JS_RUNTIME" server.js
