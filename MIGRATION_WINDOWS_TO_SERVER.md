# CloudStudio Windows -> Server Migration Notes

## Status

- Initial comparison completed on `2026-03-28`.
- Windows reference: `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-windows-exe-release-test`
- Server target: `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server`
- This file is the in-repo migration ledger for all later server changes.

## Core Boundary

- Migrate portable changes inside `web-uploader/`.
- Do not blindly overwrite desktop/Electron root files.
- Do not replace the server landing flow with `desktop-index.html`.
- Do not overwrite server deployment files like `setup.sh` and `DEPLOY.md`.

## Initial Merge Recommendation

- Wave 1:
  - preserve server landing page
  - migrate safe `web-uploader` runtime improvements
  - migrate CRS/grid improvements
  - migrate terrain/surface/volume backend + UI
- Wave 2:
  - migrate semantic/forestry workflows after Linux/macOS validation
- Exclude by default:
  - desktop dialog APIs
  - desktop workbench landing page
  - Electron root shell

## Confirmed Entry-Point Findings

- `web-uploader/index.html` is effectively unchanged between the two repos.
- The Windows workbench switch happens in `web-uploader/server.js`, not by replacing the shared server landing page markup.
- Preserve the server's `GET /` behavior by default.

## Forestry-Specific Risk Findings

- Forestry is not just a normal Python dependency expansion.
- `forestry_detect_stems.py` loads `treeiso` from `web-uploader/.local-dev/treeiso-src/PythonCpp`.
- `forestry_segment.py` can also import `pointtree.MultiStageAlgorithm`.
- `pointtree` is not declared in the current Windows `requirements-export.txt`.
- Forestry should not be included in the first server merge wave by default.

## Change Log

### 2026-03-28

- Created in-repo migration notes file.
- Confirmed that implementation should start with Wave 1 only.

- Copied Wave 1 shared files from the Windows `web-uploader` into the server target.
- Added server-safe runtime files:
  - `web-uploader/package.json`
  - `web-uploader/setup-local-runner.cjs`
  - `web-uploader/start-local-runner.cjs`
  - `web-uploader/setup-local.ps1`
  - `web-uploader/start-local.ps1`
- Migrated shared UI and backend assets for Wave 1:
  - `web-uploader/server.js`
  - `web-uploader/viewer.html`
  - selected `assets/app/features/*`
  - selected `assets/i18n/*`
  - selected `scripts/*`
  - `assets/grids/catalog.json`
  - `assets/grids/builtin/de_bkg_GCG2016v2023.gtx`
- Explicitly removed desktop-only server routes from the migrated server runtime:
  - `/local-pointclouds/:cloudName`
  - `/api/grids/import-dialog`
  - `/api/import/local`
  - `/api/desktop/import-dialog`
- Narrowed `requirements-export.txt` to the currently migrated server-safe dependency set:
  - `numpy`
  - `laspy`
  - `pyproj`
  - `lazrs`
  - `scipy`
  - `matplotlib`
- Adjusted Wave 1 Python dependency pins for the existing local Python 3.9 runtime:
  - `scipy` pinned to `1.13.1` instead of the Windows `1.14.1`
  - `matplotlib` pinned to `3.8.4`
- Deferred forestry runtime and scripts from active migration scope.

- Local verification was temporarily blocked by a machine-level Node runtime issue in the Codex shell path, but the session was recovered by switching the local launch path to Bun-first startup and revalidating the service on `:8090`.

- Simplified the migrated server runtime bootstrap back toward server-safe defaults:
  - `desktop` mode disabled at startup
  - fixed server-style `PYTHON_BIN` / `PYTHON3_BIN` resolution
  - static `/health` runtime reporting instead of startup-time probing
- Added timeout protection for grid probing so one problematic built-in grid cannot hang `/api/grids` indefinitely.
- Re-signed `pyproj` bundled `.so` / `.dylib` files in the local `.venv` because macOS was rejecting `libtiff.6.dylib` during grid probing.
- Updated local start scripts to support Bun-first startup when Bun is installed:
  - `web-uploader/start-local.command`
  - `web-uploader/setup-local.sh`
- Completed local smoke validation on `http://127.0.0.1:8090` with the running local service:
  - `GET /viewer` -> `200 OK`
  - `GET /health` -> `ok: true`, `exportPython: true`, `desktop: false`
  - `GET /api/clouds` -> `ok: true`
  - `GET /api/grids` -> `ok: true`, 22 installed / 22 catalog entries
  - `GET /api/crs/search?q=4326` -> `ok: true`
  - `POST /api/generate-surface` with empty payload -> structured `400 BAD_REQUEST`
  - `POST /api/generate-volume-surface` with empty payload -> structured `400 BAD_REQUEST`
  - `POST /api/run-semantic-pipeline` with empty payload -> structured `400 BAD_REQUEST`
