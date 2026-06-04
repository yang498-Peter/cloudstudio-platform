# CloudStudio Platform

CloudStudio Platform is a web application for uploading, converting, browsing, reviewing, and exporting point-cloud and 3D Gaussian Splatting data. It combines a Node.js/Express application, a CloudStudio-customized Potree viewer, Python processing scripts, and PotreeConverter.

This repository is intended to store source code, operational scripts, developer documentation, and lightweight static assets only. Runtime datasets, generated point clouds, job outputs, and server-local configuration must remain outside Git.

---

## 1. Who This Repository Is For

Use this repository if you need to:

- Deploy CloudStudio on a new Linux server.
- Configure a staging or production CloudStudio instance.
- Run CloudStudio locally for development.
- Extend upload, viewer, conversion, volume, DXF, export, or 3DGS features.
- Troubleshoot point-cloud conversion, static asset exposure, or Python analysis jobs.

If you are opening the project for the first time, read the documents in this order:

1. `README.md` - project overview and local quick start.
2. `DEPLOY.md` - complete first-time server deployment guide.
3. `DEPLOY_SOP.md` - safe upgrade, rollback, and production maintenance workflow.
4. `web-uploader/README.md` - application architecture and development guide.
5. `web-uploader/CODEBASE_MAP.md` - code map for finding the right module quickly.
6. `web-uploader/STATE_MAP.md` - viewer runtime state map for debugging feature interactions.
7. `docs/staging-deploy-runbook.md` - reviewed staging/demo deployment procedure.

---

## 2. Repository Layout

```text
cloudstudio-platform/
├── README.md                         # Project overview and onboarding entry point
├── DEPLOY.md                         # First-time server deployment guide
├── DEPLOY_SOP.md                     # Production/staging release and rollback SOP
├── MIGRATION_WINDOWS_TO_SERVER.md    # Historical migration notes
├── docs/                             # Runbooks, audits, and operational notes
├── web-uploader/                     # Main CloudStudio web application
├── potree/                           # CloudStudio-customized Potree viewer runtime/source
└── PotreeConverter/                  # PotreeConverter source used for point-cloud conversion
```

### Main Components

| Path | Responsibility |
| --- | --- |
| `web-uploader/` | Main product application: Express server, upload workflow, viewer pages, feature modules, tests, i18n, Python job orchestration, and runtime path handling. |
| `potree/` | Viewer engine and CloudStudio-specific Potree runtime customizations. Touch this only when changing low-level rendering, measuring, input, or viewer behavior. |
| `PotreeConverter/` | Converter used to transform LAS/LAZ source data into Potree-compatible output. Treat it as a third-party engine unless you are explicitly changing conversion behavior. |
| `docs/` | Deployment runbooks, dependency audit notes, repository-management notes, and hardening records. |

---

## 3. Runtime Data Policy

Do not commit runtime data or server-local configuration.

The following paths are runtime-only and must stay out of Git:

- `web-uploader/uploads/`
- `web-uploader/projects/`
- `web-uploader/pointclouds/`
- `web-uploader/gaussians/`
- `web-uploader/exports/`
- `web-uploader/cache/`
- `web-uploader/*_jobs/`
- `web-uploader/.env`
- `web-uploader/node_modules/`
- `web-uploader/.venv/`
- `PotreeConverter/build*/`

Large source datasets such as `.las`, `.laz`, `.ply`, `.sog`, `.octree.bin`, and customer archives belong in server storage or object storage, not in Git.

For servers, always prefer an external runtime data directory:

```bash
CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data
```

This keeps uploads, converted point clouds, 3DGS assets, exports, caches, and job artifacts outside the application code directory.

---

## 4. Local Development Quick Start

### 4.1 Prerequisites

Install these tools before starting:

- Node.js 18 or newer.
- npm 9 or newer.
- Python 3.10 or newer with `venv` support.
- Git.
- A C++ build toolchain only if you need to build PotreeConverter locally.

### 4.2 Set Up the Application

```bash
cd web-uploader
npm install
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-export.txt
cp .env.example .env
npm run start:local
```

Open:

- `http://localhost:8090/`
- `http://localhost:8090/viewer`
- `http://localhost:8090/health`

If auto-detection is enough for your machine, `.env` can be omitted. Use `web-uploader/.env.example` as the authoritative list of supported local/server variables.

### 4.3 Useful Development Commands

Run commands from `web-uploader/` unless noted otherwise.

```bash
npm start
npm run start:local
npm run test:dxf-draw
npm run test:floorplan
npm run test:runtime-storage
npm run test:static-runtime
npm run test:long-jobs
npm run test:public-api-sanitize
npm run test:upload-security
npm run test:volume
npm run test:viewer-smoke
npm run test:viewer-volume
npm run check:i18n
npm run check:deploy-docs
```

Some integration tests require optional Python packages, browser dependencies, or a working local graphics stack. When a test is intentionally dependency-gated, it should report a clear skip reason.

---

## 5. Development Workflow

Recommended branch model:

- `main` - stable, deployable code.
- `feature/*` - product features or larger improvements.
- `fix/*` - targeted bug fixes.
- `docs/*` - documentation-only work.

Recommended change flow:

```text
local branch -> implementation -> tests -> commit -> pull request -> staging deploy -> health check -> production deploy
```

Professional working rules:

1. Keep runtime data out of Git.
2. Do not edit production long files directly unless it is a small emergency hotfix with a rollback plan.
3. Prefer local development, committed changes, and controlled deployment.
4. Update documentation whenever deployment steps, required dependencies, environment variables, or runtime directories change.
5. Add or update tests for bug fixes and high-risk workflows.
6. Treat `potree/` and `PotreeConverter/` changes as engine-level changes that require extra regression testing.

---

## 6. Deployment Overview

Servers are deployment targets, not the source of truth.

Recommended deployment pipeline:

```text
local development -> Git commit -> private GitHub repository -> staging/demo deploy -> health check -> production deploy
```

The current staging/demo deployment profile is documented in `docs/staging-deploy-runbook.md` and uses:

- Staging/demo host: `8.209.66.134`
- SSH alias: `cloudstudio-new`
- Runtime data directory: `/srv/cloudstudio-data`
- Process manager: PM2
- Reverse proxy: Nginx
- Health endpoint: `/health`

For a brand-new server, follow `DEPLOY.md` first. For an existing staging/demo server upgrade, follow `DEPLOY_SOP.md` and `docs/staging-deploy-runbook.md`.

---

## 7. Where To Start When Debugging

| Symptom | Start Here |
| --- | --- |
| Upload or conversion fails | `web-uploader/server.js`, `PotreeConverter/`, runtime `uploads/` and `pointclouds/` directories. |
| Viewer UI bug | `web-uploader/viewer.html`, `web-uploader/assets/app/entry/viewer-entry.js`, matching `web-uploader/assets/app/features/*` module. |
| Measurement/profile/volume issue | `web-uploader/STATE_MAP.md`, feature module under `assets/app/features/`, and Potree measurement/profile classes if needed. |
| Python analysis/export failure | `web-uploader/scripts/*.py`, `web-uploader/requirements-export.txt`, `.env` Python variables, job output directory. |
| Deployment failure | `DEPLOY.md`, `DEPLOY_SOP.md`, `docs/staging-deploy-runbook.md`, PM2 logs, Nginx logs, `/health`. |
| i18n mismatch | `web-uploader/assets/i18n/*.json`, `npm run check:i18n`. |

---

## 8. Security and Operations Notes

- Keep `.env` server-local and out of Git.
- Keep customer data outside the application repository.
- Protect runtime directories during `rsync` and deployment.
- Use `/health` for post-deploy validation.
- Review public static exposure rules when adding new asset types.
- Do not expose manifests, configs, dotfiles, or private server paths through public routes.
- Use HTTPS and a reverse proxy for internet-facing deployments.

