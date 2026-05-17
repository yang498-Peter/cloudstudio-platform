# CloudStudio Platform

CloudStudio is Tersus GNSS' web platform for publishing, browsing, and reviewing point cloud and 3D Gaussian Splatting data.

This repository is intended to contain source code, scripts, documentation, and lightweight static assets only. Runtime datasets and generated outputs are deliberately excluded from Git.

## Main Components

- `web-uploader/` - Node.js web application, upload flow, point cloud viewer wrapper, 3DGS/SuperSplat integration, i18n resources, frontend modules, and local scripts.
- `potree/` - Potree viewer source with CloudStudio-specific frontend adjustments.
- `PotreeConverter/` - PotreeConverter source used for point cloud conversion.
- `DEPLOY.md`, `DEPLOY_SOP.md`, `MIGRATION_WINDOWS_TO_SERVER.md` - deployment and migration notes.
- `CloudStudio_3DGS_SuperSplat_接入记录.md` - ongoing 3DGS/SuperSplat implementation record.

## What Must Not Be Committed

The following paths are runtime data and must stay out of Git:

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

Large source datasets such as `.las`, `.laz`, `.ply`, `.sog`, `.octree.bin`, and customer archives should be stored in server storage or object storage, not Git.

## Local Development

```bash
cd web-uploader
npm install
cp .env.example .env
npm run start:local
```

If local auto-detection is enough, `.env` may be omitted. See `web-uploader/.env.example` for supported variables.

## Deployment Policy

Servers should be deployment targets, not the source of truth. The intended workflow is:

```text
local development -> Git commit -> private GitHub repo -> staging deploy -> health check -> production deploy
```

When syncing to a server, protect runtime data directories and server-local configuration. Never run a deploy command that deletes:

- `uploads/`
- `projects/`
- `pointclouds/`
- `gaussians/`
- `exports/`
- `cache/`
- `*_jobs/`
- `.env`
- `PotreeConverter/build-gcc/`

## GitHub Workflow

Recommended branch model:

- `main` - stable, deployable code
- `feature/*` - new feature development
- `fix/*` - targeted bug fixes

Add a heavier `develop` branch only when team collaboration needs it.

