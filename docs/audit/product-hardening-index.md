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
| Architecture and module boundaries | Explorer agent | Complete | Issues #5, #6, #13 |
| Security, permissions, and file safety | Explorer agent | Complete | Issues #1-#6, #14, #16 |
| Viewer and i18n | Explorer agent | Complete | Issues #9, #11 |
| Upload and conversion flows | Explorer agent | Complete | Issues #1, #2, #10 |
| 3DGS and SuperSplat | Explorer agent | Complete | Issues #7, #8, #10 |
| Deployment and staging operations | Explorer agent | Complete | Issues #12-#15 |

## Issue Register

| Issue | Priority | Area | Status | PR |
| --- | --- | --- | --- | --- |
| [#1 ZIP uploads can write outside the extraction directory](https://github.com/yang498-Peter/cloudstudio-platform/issues/1) | P0 | upload/security | In review | [#17](https://github.com/yang498-Peter/cloudstudio-platform/pull/17) |
| [#2 Multipart uploads are accepted before authentication and size limits](https://github.com/yang498-Peter/cloudstudio-platform/issues/2) | P0 | upload/security | In review | [#17](https://github.com/yang498-Peter/cloudstudio-platform/pull/17) |
| [#3 Default upload password hash is used when production secret is missing](https://github.com/yang498-Peter/cloudstudio-platform/issues/3) | P1 | upload/security/deploy | In audit | [#18](https://github.com/yang498-Peter/cloudstudio-platform/pull/18) |
| [#4 Unauthenticated scan root registration can expose server directories](https://github.com/yang498-Peter/cloudstudio-platform/issues/4) | P1 | security/storage | In audit | [#18](https://github.com/yang498-Peter/cloudstudio-platform/pull/18) |
| [#5 Absolute path APIs can read or write outside CloudStudio storage](https://github.com/yang498-Peter/cloudstudio-platform/issues/5) | P1 | security/storage | In audit | [#18](https://github.com/yang498-Peter/cloudstudio-platform/pull/18) |
| [#6 Runtime data and job artifacts are publicly exposed as static files](https://github.com/yang498-Peter/cloudstudio-platform/issues/6) | P1 | security/storage/viewer | In audit | [#22](https://github.com/yang498-Peter/cloudstudio-platform/pull/22) |
| [#7 3DGS publishing reports ready before SOG optimization is complete](https://github.com/yang498-Peter/cloudstudio-platform/issues/7) | P1 | 3dgs/upload/tests | In audit | [#19](https://github.com/yang498-Peter/cloudstudio-platform/pull/19) |
| [#8 3DGS rotation is hard-coded instead of stored per asset](https://github.com/yang498-Peter/cloudstudio-platform/issues/8) | P1 | 3dgs/viewer | In audit | [#19](https://github.com/yang498-Peter/cloudstudio-platform/pull/19) |
| [#9 i18n failures can keep homepage and viewer hidden](https://github.com/yang498-Peter/cloudstudio-platform/issues/9) | P1 | i18n/viewer/tests | In audit | [#20](https://github.com/yang498-Peter/cloudstudio-platform/pull/20) |
| [#10 Long-running conversion jobs lack timeouts and queryable job state](https://github.com/yang498-Peter/cloudstudio-platform/issues/10) | P1 | upload/3dgs/tests | In audit | [#23](https://github.com/yang498-Peter/cloudstudio-platform/pull/23) |
| [#11 Volume and clip dynamic UI still leaks English in non-English locales](https://github.com/yang498-Peter/cloudstudio-platform/issues/11) | P1 | i18n/viewer | In audit | [#20](https://github.com/yang498-Peter/cloudstudio-platform/pull/20) |
| [#12 Staging PM2 startup and rollback safeguards are incomplete](https://github.com/yang498-Peter/cloudstudio-platform/issues/12) | P1 | deploy | In audit | [#21](https://github.com/yang498-Peter/cloudstudio-platform/pull/21) |
| [#13 Runtime storage is still colocated with application code on staging](https://github.com/yang498-Peter/cloudstudio-platform/issues/13) | P1 | storage/deploy | In audit | [#21](https://github.com/yang498-Peter/cloudstudio-platform/pull/21) |
| [#14 Public health and API responses leak absolute server paths](https://github.com/yang498-Peter/cloudstudio-platform/issues/14) | P2 | security/deploy | Open | Pending |
| [#15 Staging code differs from Git HEAD and deployment docs reference old targets](https://github.com/yang498-Peter/cloudstudio-platform/issues/15) | P2 | deploy | In audit | [#21](https://github.com/yang498-Peter/cloudstudio-platform/pull/21) |
| [#16 Dependency audit reports high severity path-to-regexp vulnerability](https://github.com/yang498-Peter/cloudstudio-platform/issues/16) | P2 | security/tests/upload | In audit | [#21](https://github.com/yang498-Peter/cloudstudio-platform/pull/21) |

## Baseline Results

- `npm ci`: passed; npm warned about Multer 1.x deprecation and reported 2 vulnerabilities.
- `npm run check:i18n`: passed; extra locale key warnings remain and are tracked under i18n follow-ups.
- `npm run test:dxf-draw`: passed.
- `npm run test:static-runtime`: passed.
- `npm run test:runtime-storage`: passed.
- `npm run test:long-jobs`: passed.
- `npm run test:volume`: passed.
- `npm run test:floorplan`: passed.
- `npm audit --omit=dev --json`: 0 vulnerabilities after #21 lockfile patch updates.

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

`test:viewer-volume` depends on the real `BEL-JOEL` point cloud being present, so it is part of local/staging validation rather than the GitHub Actions smoke gate.

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
