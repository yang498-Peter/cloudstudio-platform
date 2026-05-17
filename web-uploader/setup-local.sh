#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

repair_macos_pyproj_signatures() {
  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi

  if ! command -v codesign >/dev/null 2>&1; then
    return 0
  fi

  local pyproj_dir=".venv/lib/python3.9/site-packages/pyproj"
  if [ ! -d "$pyproj_dir" ]; then
    return 0
  fi

  echo "[macOS] Refreshing pyproj native-extension signatures..."

  local found=0
  while IFS= read -r -d '' file; do
    found=1
    codesign --force --sign - "$file" >/dev/null
  done < <(find "$pyproj_dir" -type f \( -name '*.so' -o -name '*.dylib' \) -print0)

  if [ "$found" -eq 1 ]; then
    echo "[macOS] pyproj signatures refreshed."
  fi
}

RUNTIME="${2:-}"
if [ "${1:-}" = "--runtime" ]; then
  RUNTIME="${2:-}"
fi

if [ -z "$RUNTIME" ]; then
  if command -v node >/dev/null 2>&1; then
    RUNTIME="node"
  elif command -v bun >/dev/null 2>&1; then
    RUNTIME="bun"
  else
    echo "[error] no JavaScript runtime found. Install Bun or Node.js."
    exit 1
  fi
fi

echo "[1/3] Installing JavaScript dependencies with ${RUNTIME}..."
if [ "$RUNTIME" = "bun" ]; then
  bun install
else
  npm install
fi

echo "[2/3] Preparing Python virtual environment..."
if [ ! -x ".venv/bin/python" ]; then
  python3 -m venv .venv
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-export.txt
repair_macos_pyproj_signatures

echo "[3/3] Verifying local runtime..."
.venv/bin/python -c "import importlib.util, sys; mods = ['numpy', 'laspy', 'pyproj', 'lazrs', 'scipy', 'matplotlib', 'CSF']; missing = [name for name in mods if importlib.util.find_spec(name) is None]; sys.exit(('Missing Python modules: ' + ', '.join(missing)) if missing else 0)"
echo "Python runtime OK"

echo "JavaScript runtime OK (${RUNTIME})"

cat <<'DONE'

Local setup completed.

Start the local server with:
  ./start-local.command

Open:
  http://localhost:8090
  http://localhost:8090/viewer
DONE
