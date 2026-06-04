# CloudStudio Technical Overview

CloudStudio is a self-hosted web platform for point cloud and 3D Gaussian
Splatting workflows. It combines an Express backend, a browser-based viewer,
Potree runtime assets, PotreeConverter, and Python processing scripts.

## Architecture

```text
Browser
  |
  | HTTP
  v
Nginx
  |
  | proxy_pass 127.0.0.1:8090
  v
Express app: web-uploader/server.js
  |
  |-- static pages and assets
  |-- upload and project APIs
  |-- PotreeConverter process execution
  |-- Python processing script execution
  |-- runtime storage directories
```

## Components

### `web-uploader`

The main application. It owns:

- HTTP routes and APIs
- static file serving
- upload handling
- project metadata
- viewer pages
- frontend feature modules
- Python script orchestration
- runtime data directories

### `potree`

The browser rendering stack for point clouds. CloudStudio uses Potree as a
viewer runtime and extends the surrounding product shell with project opening,
measurement, export, CRS, and analysis workflows.

### `PotreeConverter`

The native converter used to transform LAS/LAZ source files into Potree-compatible
point cloud output. It should be built on the target machine because Linux ABI
and library versions differ across distributions.

### Python scripts

Scripts under `web-uploader/scripts/` support export, CRS transformation,
terrain generation, volume calculations, classification, contours, and related
processing tasks.

## Key Runtime Paths

```text
web-uploader/uploads/          source uploads
web-uploader/pointclouds/      converted Potree outputs
web-uploader/projects/         project metadata
web-uploader/gaussians/        Gaussian Splatting data
web-uploader/exports/          generated downloads
web-uploader/cache/            cache files
web-uploader/*_jobs/           generated job outputs
```

These paths are runtime data, not source code.

## Main HTTP Surfaces

| Path | Purpose |
| --- | --- |
| `/` | Home page and project launcher |
| `/viewer` | Point cloud viewer |
| `/gaussian-viewer` | Gaussian Splatting viewer |
| `/health` | Deployment and runtime health check |
| `/api/clouds` | Available cloud/project listing |
| `/api/*` | Upload, export, processing, CRS, and project APIs |

## Health Model

The `/health` endpoint should be the first deployment check. Important fields:

- `ok`: application-level health
- `converter`: PotreeConverter exists and can be used
- `potreeRuntime`: required Potree browser assets are available
- `exportPython`: Python environment for export scripts is available
- `systemPython`: system Python path is available for auxiliary scripts
- `pathsExposed`: should be false in a shareable or production deployment
- `storage`: runtime directories exist and are writable

## Development Model

The viewer is a mixed legacy and modular frontend:

- `viewer.html` still contains important runtime logic.
- `assets/app/entry/viewer-entry.js` bootstraps the app shell.
- `assets/app/features/*` contains progressively extracted features.
- `server.js` is still the main backend entry point.

For new work, prefer small, well-scoped feature modules and targeted tests.
Avoid large online edits to `server.js` on production servers.

## Deployment Model

Recommended production pattern:

```text
local development
  -> Git commit
  -> private GitHub repository
  -> server git pull or controlled release package
  -> dependency update
  -> PM2 restart
  -> /health validation
```

Servers are deployment targets, not the source of truth. Do not use production
runtime directories as source control content.

## Security Notes

- Keep the repository private unless licensing and data policy are reviewed.
- Never commit `.env`, SSH keys, tokens, certificates, customer files, or generated datasets.
- Use HTTPS for public deployments.
- Put large datasets in server storage or object storage.
- Review exposed APIs before making a deployment public.
