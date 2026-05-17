# CloudStudio Product Hardening Audit Index

Branch: `audit/product-hardening`  
Repository: `yang498-Peter/cloudstudio-platform`  
Staging target: `8.209.66.134`  
Scope: P0-P2 findings across architecture, upload, security, i18n, viewer, 3DGS, storage, testing, and deployment.

## Operating Rules

- `main` stays stable; audit and fixes land on `audit/product-hardening` first.
- Every P0-P2 finding gets a GitHub Issue with impact, evidence, reproduction, recommended fix, and acceptance criteria.
- Every P0-P2 fix gets a focused branch and PR before merging into `audit/product-hardening`.
- Servers are deployment targets only; no server-only code edits.
- Staging deploys must preserve `.env`, runtime data directories, job directories, and generated assets.

## Audit Workstreams

| Workstream | Owner | Status | Output |
| --- | --- | --- | --- |
| Architecture and module boundaries | Explorer agent | In progress | Pending Issues |
| Security, permissions, and file safety | Explorer agent | In progress | Pending Issues |
| Viewer and i18n | Explorer agent | In progress | Pending Issues |
| Upload and conversion flows | Explorer agent | In progress | Pending Issues |
| 3DGS and SuperSplat | Explorer agent | In progress | Pending Issues |
| Deployment and staging operations | Explorer agent | In progress | Pending Issues |

## Issue Register

| Issue | Priority | Area | Status | PR |
| --- | --- | --- | --- | --- |
| Pending | Pending | Pending | Pending | Pending |

## Baseline Commands

Local checks:

```bash
cd web-uploader
npm ci
npm run check:i18n
npm run test:dxf-draw
npm run test:volume
npm run test:floorplan
npm run test:viewer-smoke
npm run test:viewer-volume
```

Staging read-only checks:

```bash
ssh cloudstudio-new 'pm2 status cloudstudio && systemctl is-active nginx && curl -s http://127.0.0.1:8090/health'
curl -I http://8.209.66.134
```

## Staging Data Protection

Never overwrite or delete these paths during deploy:

- `web-uploader/uploads/`
- `web-uploader/projects/`
- `web-uploader/pointclouds/`
- `web-uploader/gaussians/`
- `web-uploader/exports/`
- `web-uploader/cache/`
- `web-uploader/*_jobs/`
- `web-uploader/.env`
- `web-uploader/scan_roots.json`

## Resolution Policy

- P0: Fix immediately in a single-purpose PR.
- P1: Fix in module-focused PRs before staging deployment.
- P2: Fix or explicitly defer with a reason in the Issue.
- P3/P4: Record only; not blocking this hardening pass.
