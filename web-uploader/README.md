# CloudStudio Web Application (`web-uploader`)

`web-uploader/` is the main CloudStudio application. It provides the web server, upload workflow, viewer pages, feature modules, i18n resources, runtime path management, Python job orchestration, and automated tests.

Despite the directory name, this is not only an uploader. Most product behavior lives here.

---

## 1. Application Responsibilities

The application is responsible for:

- Starting the CloudStudio web server.
- Serving the home page, Potree viewer, and Gaussian viewer.
- Receiving LAS/LAZ and project uploads.
- Extracting uploaded ZIP archives safely.
- Converting point clouds through PotreeConverter.
- Discovering and registering scanner projects.
- Serving runtime point-cloud, project, and 3DGS assets.
- Running Python scripts for export, terrain, floorplan, surface, and volume workflows.
- Providing DXF drawing, measurement, profile, clipping, minimap, capture, volume, terrain, and export features.
- Managing frontend i18n resources.
- Running regression tests for high-risk modules.

---

## 2. How This Directory Fits the Repository

```text
cloudstudio-platform/
├── web-uploader/       main application, APIs, viewer pages, tests, Python jobs
├── potree/             Potree engine/runtime consumed by the viewer
└── PotreeConverter/    converter used by upload/conversion workflows
```

Daily product development usually starts in `web-uploader/`, not in `potree/` or `PotreeConverter/`.

Only edit `potree/` when you need to change low-level viewer behavior such as rendering, Potree measurement internals, input handling, or engine resources. Only edit `PotreeConverter/` when conversion behavior itself must change.

---

## 3. Quick Start for Local Development

### 3.1 Prerequisites

- Node.js 18 or newer.
- npm 9 or newer.
- Python 3.10 or newer.
- Git.
- Optional: a local PotreeConverter binary if you need upload-to-conversion testing.

### 3.2 Install Dependencies

```bash
cd web-uploader
npm install
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-export.txt
```

### 3.3 Configure the Environment

Most local development works with auto-detection. If you need explicit configuration:

```bash
cp .env.example .env
```

Common variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local server port. Default: `8090`. |
| `CLOUDSTUDIO_DATA_DIR` | External runtime data root. Strongly recommended on servers. |
| `CLOUDSTUDIO_STORAGE_ROOT` | Legacy alias. Prefer `CLOUDSTUDIO_DATA_DIR`. |
| `CONVERTER_PATH` | Explicit PotreeConverter binary path. |
| `PYTHON_BIN` | Python executable for export/grid/analysis scripts. |
| `PYTHON3_BIN` | Python executable for ZIP extraction and terrain jobs. |

### 3.4 Start the Application

```bash
npm run start:local
```

Open:

- `http://localhost:8090/`
- `http://localhost:8090/viewer`
- `http://localhost:8090/gaussian-viewer`
- `http://localhost:8090/health`

---

## 4. Runtime Directory Model

Runtime data must not be committed.

Important runtime directories:

| Directory | Purpose |
| --- | --- |
| `uploads/` | Raw uploaded files. |
| `projects/` | Scanner project data. |
| `pointclouds/` | Converted Potree point-cloud output. |
| `gaussians/` | 3D Gaussian Splatting assets. |
| `exports/` | User-requested exports. |
| `cache/` | Temporary/cache files. |
| `*_jobs/` | Generated job artifacts for terrain, contour, surface, volume, and related workflows. |

For deployment, set:

```bash
CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data
```

Relative data roots resolve from `web-uploader/`; absolute paths are recommended on servers.

---

## 5. Source Layout

```text
web-uploader/
├── server.js                         # Express server and API routes
├── index.html                        # Home/open page
├── viewer.html                       # Main Potree viewer page with legacy runtime logic
├── gaussian-viewer.html              # 3DGS viewer page
├── package.json                      # Node scripts and dependencies
├── requirements-export.txt           # Python dependencies for analysis/export jobs
├── .env.example                      # Environment variable reference
├── assets/
│   ├── app/                          # Modular frontend code
│   ├── crs/                          # CRS bootstrap data
│   ├── grids/                        # Grid catalog and built-in grids
│   └── i18n/                         # Translation JSON files
├── scripts/                          # Python processing scripts and Node check scripts
├── tests/                            # Node and Python regression tests
└── lib/                              # Shared helper modules
```

---

## 6. Frontend Architecture

The frontend is a hybrid of legacy page logic and progressively extracted modules.

```text
assets/app/
├── core/       shared state, constants, DOM helpers, i18n, formatting, env helpers
├── entry/      page entry points and legacy bridge
├── features/   feature modules
├── services/   frontend API client
└── ui/         shared feedback UI
```

Important files:

| File | Purpose |
| --- | --- |
| `viewer.html` | Main viewer DOM and a large amount of legacy runtime logic. |
| `assets/app/entry/viewer-entry.js` | Initializes the application shell, services, i18n, and feature factories. |
| `assets/app/entry/load-legacy-inline-module.js` | Bridge that loads legacy inline module code from `viewer.html`. |
| `assets/app/services/api-client.js` | Shared frontend fetch wrapper. |
| `assets/app/features/*` | Incrementally extracted product features. |

Do not assume the viewer is a fully modular SPA. Many modules still depend on state or helpers passed from `viewer.html`.

---

## 7. Backend Architecture

`server.js` is the main backend entry point. It currently handles:

- Static asset routes.
- Upload and extraction routes.
- Conversion orchestration.
- Runtime storage path resolution.
- Scanner project discovery and registration.
- Public API sanitization.
- CRS/grid endpoints.
- Export endpoints.
- Long-running job state.
- Python process execution.
- Surface and volume job orchestration.

Because `server.js` is large, prefer targeted changes with tests. If you are adding a new standalone area, consider extracting helper logic into `lib/` or a clearly named module instead of increasing server-file complexity.

---

## 8. Feature Modules

Common feature directories under `assets/app/features/` include:

| Feature | Typical Responsibility |
| --- | --- |
| `open/` | Open-project modal and project selection flow. |
| `scene-tree/` | Scene panel and object tree behavior. |
| `measurement/` | Measurement UI shell and related orchestration. |
| `profile/` | Profile tool integration. |
| `volume/` | Volume computation UI and report flow. |
| `terrain/` | Terrain/surface workflow UI. |
| `dxf-draw/` | DXF drawing and topology behavior. |
| `delete-region/` | Region deletion workflow. |
| `clip-box/` | Clipping box UI/behavior. |
| `display-settings/` | Point cloud display settings. |
| `scanner-info/` | Scanner/project metadata UI. |
| `minimap/` | Minimap and trajectory-related UI. |
| `export-las/` | LAS export UI. |
| `capture/` | Screenshot/capture workflow. |

When adding a feature:

1. Keep feature-specific state inside the feature module when possible.
2. Use `assets/app/services/api-client.js` for backend calls.
3. Use shared feedback helpers instead of ad-hoc toast/status logic.
4. Keep compatibility with existing `viewer.html` state until the relevant legacy section is fully extracted.
5. Add tests for pure logic or high-risk behavior.

---

## 9. Testing

Run tests from `web-uploader/`.

| Command | Purpose |
| --- | --- |
| `npm run test:dxf-draw` | DXF topology, snapping, constrained endpoint behavior. |
| `npm run test:floorplan` | Job-result parsing and floorplan extraction regression. |
| `npm run test:runtime-storage` | Runtime storage path behavior. |
| `npm run test:static-runtime` | Public static runtime exposure guard. |
| `npm run test:long-jobs` | Long-running job state and timeout behavior. |
| `npm run test:public-api-sanitize` | Public API path/data sanitization. |
| `npm run test:upload-security` | ZIP extraction and upload security rules. |
| `npm run test:volume` | Volume compute, UI, and integration tests. |
| `npm run test:volume-report` | Volume report visual checks. |
| `npm run test:viewer-smoke` | Viewer smoke tests. |
| `npm run test:viewer-volume` | Viewer volume flow tests. |
| `npm run check:i18n` | Translation-key consistency. |
| `npm run check:deploy-docs` | Deployment documentation hardening markers. |

Notes:

- Some volume integration tests require optional Python modules such as `laspy`, `numpy`, and `CSF`.
- Browser-based smoke tests may require a compatible headless browser and graphics fallback.
- If a test is skipped because an optional dependency is unavailable, the skip reason should be explicit.

---

## 10. Development Guidelines

### 10.1 General Rules

- Keep runtime data and generated files out of Git.
- Prefer small, reviewable changes.
- Add tests for bug fixes and high-risk workflows.
- Update i18n files when adding user-facing text.
- Update documentation when changing deployment, runtime paths, dependencies, or public APIs.
- Do not expose local filesystem paths in public responses unless explicitly intended and tested.

### 10.2 Frontend Rules

- Prefer feature modules under `assets/app/features/` for new UI logic.
- Reuse `api-client.js` for backend calls.
- Reuse shared formatting and feedback helpers.
- Avoid creating new global variables unless needed for legacy compatibility.
- When touching viewer state, consult `STATE_MAP.md` first.

### 10.3 Backend Rules

- Keep file path handling explicit and sanitized.
- Validate upload and ZIP extraction paths against traversal and special-file attacks.
- Keep public static routes narrow.
- Prefer `CLOUDSTUDIO_DATA_DIR` for runtime storage.
- Use structured errors for API responses where possible.
- Avoid long-running synchronous work in request handlers when a job flow is more appropriate.

### 10.4 Python Script Rules

- Keep script inputs and outputs documented.
- Use the configured Python runtime from `.env`/server configuration.
- Write generated artifacts to job/output directories, not source directories.
- Add regression tests when changing parsing, geometry, surface, volume, or export logic.

---

## 11. Deployment Notes for Developers

For a new server, follow the root `DEPLOY.md`.

For existing staging/production servers, follow the root `DEPLOY_SOP.md` and protect:

- `.env`
- `uploads/`
- `projects/`
- `pointclouds/`
- `gaussians/`
- `exports/`
- `cache/`
- `*_jobs/`
- `scan_roots.json`
- `/srv/cloudstudio-data/`

After deployment, always check:

```bash
curl -s http://127.0.0.1:8090/health
pm2 status cloudstudio
pm2 logs cloudstudio --lines 50
```

---

## 12. Debugging Checklist

| Problem | First Files/Commands |
| --- | --- |
| Home page or viewer does not load | `server.js`, `index.html`, `viewer.html`, PM2 logs, Nginx logs. |
| Converted cloud does not open | `server.js`, converter output under runtime data, Potree metadata files. |
| Upload security issue | `server.js`, upload tests, ZIP extraction helpers. |
| Public route leaks private data | public API sanitize tests and static runtime tests. |
| Feature state behaves unexpectedly | `STATE_MAP.md`, `viewer.html`, matching feature module. |
| Translation missing | `assets/i18n/*.json`, `npm run check:i18n`. |
| Python job fails | `.env`, `requirements-export.txt`, `scripts/*.py`, PM2 logs. |

---

## 13. Related Documentation

- `../README.md` - repository overview.
- `../DEPLOY.md` - first-time server deployment.
- `../DEPLOY_SOP.md` - safe release and rollback SOP.
- `../docs/staging-deploy-runbook.md` - staging/demo deployment runbook.
- `CODEBASE_MAP.md` - detailed code map.
- `STATE_MAP.md` - viewer state map.
- `MEASUREMENT_SPLIT_PLAN.md` - measurement refactor plan.

