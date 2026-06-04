# CloudStudio Web App

`web-uploader` is the main CloudStudio application. It provides the Express
server, upload and conversion APIs, viewer pages, frontend feature modules,
Python processing scripts, and automated tests.

## Main Responsibilities

- Serve the CloudStudio home page and viewer pages.
- Accept LAS/LAZ uploads and scanner project registrations.
- Convert point clouds through PotreeConverter.
- Serve Potree and 3D Gaussian Splatting assets.
- Manage runtime project metadata and generated outputs.
- Run Python scripts for export, CRS, terrain, volume, floorplan, and related workflows.
- Provide frontend modules for measurement, clipping, profile, volume, DXF, display settings, and scene management.

## Important Files

| Path | Purpose |
| --- | --- |
| `server.js` | Main Express backend and API entry point |
| `index.html` | Home page and project entry surface |
| `viewer.html` | Main point cloud viewer page |
| `gaussian-viewer.html` | Gaussian Splatting viewer page |
| `assets/app/entry/` | Frontend bootstrapping modules |
| `assets/app/features/` | Feature modules for viewer tools |
| `assets/i18n/` | Product localization resources |
| `scripts/` | Python processing and export scripts |
| `tests/` | Node and Python regression tests |
| `.env.example` | Supported environment variables |

## Local Setup

```bash
cd web-uploader
npm install
npm run setup:local
npm run start:local
```

Open:

```text
http://localhost:8090/
http://localhost:8090/viewer
http://localhost:8090/health
```

## Environment Variables

Copy `.env.example` to `.env` when explicit paths are needed.

Common variables:

```bash
PORT=8090
CONVERTER_PATH=/opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
PYTHON_BIN=/opt/cloudstudio/web-uploader/.venv/bin/python
PYTHON3_BIN=python3
```

## Health Check

Use:

```bash
curl -s http://localhost:8090/health
```

Important fields:

- `ok`
- `converter`
- `potreeRuntime.status`
- `exportPython`
- `systemPython`
- `pathsExposed`
- `storage.directories`

## Tests

```bash
npm run test:dxf-draw
npm run test:floorplan
npm run test:volume
npm run test:viewer-smoke
npm run test:viewer-volume
npm run check:i18n
```

Some workflows still require manual browser validation because the viewer is a
large mixed legacy and modular frontend.

## Runtime Directories

These directories are generated at runtime and must not be committed:

```text
uploads/
projects/
pointclouds/
gaussians/
exports/
cache/
dtm_jobs/
contour_jobs/
surface_jobs/
volume_jobs/
volume_surface_jobs/
floorplan_jobs/
.venv/
node_modules/
.env
```

## Development Notes

The current frontend is not a fully isolated single-page app. It combines a
legacy `viewer.html` runtime with progressively modularized feature files under
`assets/app/features/`.

When debugging product behavior, start from the workflow:

1. Which page or API is involved?
2. Which runtime directory stores its state?
3. Which frontend feature module triggers it?
4. Which backend route in `server.js` handles it?
5. Which Python script or converter binary runs behind it?
