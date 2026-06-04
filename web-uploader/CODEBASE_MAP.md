# CloudStudio `web-uploader` Code Map

Last reviewed: 2026-06-03

Scope: `web-uploader/` and its relationship with repository-level `potree/` and `PotreeConverter/`.

Audience: engineers onboarding to CloudStudio, maintainers, troubleshooting owners, and future automation agents.

---

## 1. Purpose

This document is a practical code map. Use it to find the correct files before fixing bugs, adding features, or refactoring the application.

For installation and deployment, start with:

- `../README.md`
- `../DEPLOY.md`
- `../DEPLOY_SOP.md`
- `README.md`

---

## 2. System Layers

```text
cloudstudio-platform/
├── web-uploader/       main application: Express, viewer pages, feature modules, Python jobs
├── potree/             customized Potree viewer runtime/source
└── PotreeConverter/    point-cloud conversion tool
```

### `web-uploader/`

This is the main product application. It owns uploads, project browsing, viewer page orchestration, DXF, measurements, exports, terrain workflows, volume workflows, Python job execution, and most tests.

### `potree/`

This is the low-level point-cloud viewer engine/runtime. Touch it only when you need engine-level rendering, input, material, measurement, profile, or scene behavior changes.

### `PotreeConverter/`

This converts LAS/LAZ source data into Potree-browsable output. Treat it as a conversion engine, not as normal product UI code.

---

## 3. First Files To Read

| File | Why It Matters |
| --- | --- |
| `server.js` | Main backend entry. Owns routes, static serving, upload handling, runtime paths, job orchestration, and Python process execution. |
| `viewer.html` | Main Potree viewer page. Still contains significant legacy DOM, event, and runtime logic. |
| `assets/app/entry/viewer-entry.js` | Main modular viewer entry. Initializes app shell, services, i18n, feature factories, and compatibility bridges. |
| `assets/app/entry/load-legacy-inline-module.js` | Bridge that keeps legacy inline viewer code working with newer module code. |
| `assets/app/services/api-client.js` | Shared frontend API client. New feature modules should reuse it. |
| `assets/app/features/*` | Main location for product feature modules. |
| `STATE_MAP.md` | Viewer state ownership and compatibility bridge map. |

---

## 4. Frontend Map

```text
assets/app/
├── core/       shared foundations: environment, constants, DOM helpers, i18n, state, formatting
├── entry/      page entry points and legacy bridge
├── features/   feature modules
├── services/   frontend API client
└── ui/         shared feedback UI
```

### Core Modules

| File | Purpose |
| --- | --- |
| `core/env.js` | Page/runtime environment helpers. |
| `core/i18n.js` | Shared translation initialization and bridge helpers. |
| `core/state.js` | `createAppShell()` and shared state-domain support. |
| `core/formatters.js` | Number, coordinate, unit, and display formatting helpers. |
| `core/dom.js` | DOM utilities. |
| `core/constants.js` | Shared constants. |

### Entry Modules

| File | Purpose |
| --- | --- |
| `entry/viewer-entry.js` | Initializes viewer shell, services, feature factories, and legacy integration. |
| `entry/load-legacy-inline-module.js` | Loads legacy inline module source from `viewer.html`. |
| `entry/index-entry.js` | Home page entry module. |

### Important Feature Modules

| Directory/File | Responsibility |
| --- | --- |
| `features/open/open-modal.js` | Open-cloud, scan-project, and related entry UI. |
| `features/open-load-orchestration/index.js` | Context switching, state sync, and scene cleanup after loading. |
| `features/scene-tree/index.js` | Left scene tree for clouds, measurements, volumes, and related scene objects. |
| `features/display-settings/index.js` | Point budget, FOV, EDL, and display settings that affect Potree viewer state. |
| `features/scanner-info/index.js` | Scanner/project metadata panel. |
| `features/scanner-runtime/index.js` | Scanner runtime, CRS/grid, camera, and trajectory coordination. |
| `features/minimap/index.js` | Minimap, basemap, and projected trajectory UI. |
| `features/photo/index.js` | Photo/camera visualization and navigation. |
| `features/capture/index.js` | Point capture and capture export workflow. |
| `features/measurement/index.js` | Non-DXF measurement panel and measurement UI shell. |
| `features/profile/index.js` | Profile tool and profile panel integration. |
| `features/volume/index.js` | Volume UI, volume reports, and related workflow orchestration. |
| `features/volume/compute.js` | Pure volume computation helpers covered by tests. |
| `features/clip-box/index.js` | Clip box UI and interaction configuration. |
| `features/delete-region/index.js` | Delete-region panel and related workflow coordination. |
| `features/dxf/index.js` | DXF import, file list, and layer visibility. |
| `features/dxf-draw/index.js` | DXF drawing, endpoint snapping, constrained lines, and Auto Extract UI integration. |
| `features/dxf-draw/topology.js` | Pure DXF topology helpers used by tests. |
| `features/export-las/index.js` | LAS/LAZ/export UI. |
| `features/terrain/index.js` | DTM, surfaces, contours, HAG/classification/tree workflows. |
| `features/magnifier/index.js` | Mouse magnifier UI. |

---

## 5. Backend and Script Map

### Backend

| File | Responsibility |
| --- | --- |
| `server.js` | Express app, routes, static serving, upload handling, runtime storage, job orchestration, Python process execution, conversion integration. |
| `lib/` | Shared helper modules used by server or tests. |

`server.js` is intentionally listed as high risk because it owns many unrelated concerns. Prefer small changes and focused tests.

### Python Scripts

| Area | Typical Files |
| --- | --- |
| Export and report workflows | `scripts/*.py` plus export/report dependencies. |
| Floorplan and Auto Extract | extraction-related Python scripts and `tests/extract_floorplan_regression.py`. |
| Terrain/surface/volume workflows | terrain, surface, and volume scripts plus generated job output directories. |

When debugging Python jobs, confirm the configured runtime first:

```bash
cat .env | sed -E 's/(TOKEN|SECRET|PASSWORD|KEY)=.*/\1=***REDACTED***/g'
.venv/bin/python -m pip list
```

---

## 6. Runtime Directory Map

Runtime directories are generated by the application and must not be committed.

| Directory | Purpose |
| --- | --- |
| `uploads/` | Raw uploaded files. |
| `projects/` | Scanner project data. |
| `pointclouds/` | Converted Potree point-cloud output. |
| `gaussians/` | 3D Gaussian Splatting assets. |
| `exports/` | Exported files. |
| `cache/` | Temporary/cache files. |
| `*_jobs/` | Generated job artifacts. |

On servers, these should live under the external data root configured by:

```bash
CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data
```

---

## 7. Test Map

Run from `web-uploader/`.

| Command | Coverage |
| --- | --- |
| `npm run test:dxf-draw` | DXF endpoint topology, snapping, constraints, and shared endpoint behavior. |
| `npm run test:floorplan` | Job result parsing and floorplan extraction regression. |
| `npm run test:runtime-storage` | Runtime storage root resolution. |
| `npm run test:static-runtime` | Public static runtime exposure guard. |
| `npm run test:long-jobs` | Long-job state transitions and timeout behavior. |
| `npm run test:public-api-sanitize` | Public API data/path sanitization. |
| `npm run test:upload-security` | ZIP traversal, special file, credential, and upload filter protections. |
| `npm run test:volume` | Volume compute, UI, and Python integration scenarios. |
| `npm run test:volume-report` | Volume report visual checks. |
| `npm run test:viewer-smoke` | Headless viewer smoke tests. |
| `npm run test:viewer-volume` | Viewer volume flow tests. |
| `npm run check:i18n` | Translation-key consistency. |
| `npm run check:deploy-docs` | Deployment documentation hardening markers. |

---

## 8. Common Debugging Entry Points

| Symptom | Start Here |
| --- | --- |
| Viewer page fails to load | `viewer.html`, `viewer-entry.js`, browser console, PM2 logs. |
| Feature button disappeared | `viewer-entry.js` feature registration and the matching feature module. |
| Opening one dataset affects another | `open-load-orchestration/`, dataset context state, `STATE_MAP.md`. |
| Scene tree is stale | `features/scene-tree/index.js`, Potree scene collections. |
| DXF snapping or endpoint behavior is wrong | `features/dxf-draw/index.js`, `features/dxf-draw/topology.js`, DXF tests. |
| Volume result/report is wrong | `features/volume/`, volume Python script, generated volume job output. |
| Upload extraction behaves unexpectedly | `server.js`, upload-security tests, ZIP extraction helpers. |
| Public response exposes server paths | API sanitization helpers and `test:public-api-sanitize`. |
| Static file is exposed or blocked incorrectly | static runtime guard and `test:static-runtime`. |
| Python job fails only on server | `.env`, `PYTHON_BIN`, `.venv`, `requirements-export.txt`, PM2 logs. |
| CRS/grid issue | CRS/grid routes, `assets/grids/`, scanner runtime feature. |

---

## 9. High-Risk Areas

1. `viewer.html` remains a legacy/runtime center. DOM id/class changes can break feature modules.
2. `viewer-entry.js` controls feature registration. Missing registration can make features disappear silently.
3. `server.js` is a large backend entry. Route or path changes can affect unrelated workflows.
4. DXF drawing combines UI, Potree interaction, topology logic, and Auto Extract integration.
5. Volume and terrain workflows combine frontend state, server jobs, Python scripts, generated artifacts, and report rendering.
6. Scanner runtime combines CRS, grids, camera/photo metadata, trajectories, and dataset context.
7. `potree/` and `PotreeConverter/` changes are engine-level changes and require broader regression testing.
8. Runtime directories grow over time. Cleanup must be intentional and must not delete customer deliverables.

---

## 10. Maintenance Rules

When adding a new frontend feature:

- Add it under `assets/app/features/`.
- Register it in the relevant entry module.
- Use `services/api-client.js` for backend calls.
- Add pure logic tests where possible.
- Update this code map and `README.md` if it creates a new workflow.

When adding a backend API:

- Keep path validation and public response sanitization explicit.
- Add tests for security-sensitive paths.
- Document new environment variables or runtime directories.

When adding a Python workflow:

- Document required packages in `requirements-export.txt`.
- Use configured Python paths.
- Write outputs to runtime job directories.
- Add a regression test for parsing or pure algorithmic behavior.

---

## 11. Related Documents

- `../README.md` - repository overview and onboarding entry point.
- `../DEPLOY.md` - first-time server deployment guide.
- `../DEPLOY_SOP.md` - safe release, rollback, and maintenance SOP.
- `../docs/staging-deploy-runbook.md` - staging/demo deployment runbook.
- `README.md` - web application development guide.
- `STATE_MAP.md` - viewer state map.
- `MEASUREMENT_SPLIT_PLAN.md` - measurement refactor plan.

---

## 12. One-Sentence Summary

CloudStudio maintenance is difficult because viewer frontend state, Potree runtime objects, backend routes, Python jobs, and runtime data directories are tightly connected; always identify the owning layer before changing code.

