# CloudStudio Repository Management

CloudStudio should be developed from this repository, reviewed through Git history, and deployed to servers as a controlled release. Production or staging servers must not become the primary place where code is edited.

## Working Model

- `main` keeps the latest stable deployable code.
- Feature work uses branches such as `feature/3dgs-publish-flow`, `feature/user-admin`, or `fix/viewer-i18n`.
- Runtime data stays outside Git: uploaded point clouds, converted projects, 3DGS scenes, exports, cache directories, job folders, `.env` files, and local dependency folders.
- Deployment pulls or syncs code from a reviewed branch/tag and preserves server runtime directories.

## Server Policy

Servers may contain:

- `.env` and service configuration
- `web-uploader/uploads/`
- `web-uploader/projects/`
- `web-uploader/pointclouds/`
- `web-uploader/gaussians/`
- generated exports, cache, and job folders
- optional CRS grid data files
- compiled `PotreeConverter` binaries

Servers should not contain uncommitted application code changes. Emergency hotfixes must be copied back into this repository and committed immediately after verification.

## Developer Handoff

Before a new developer or AI coding agent changes code, it should read:

- `README.md`
- `docs/TECHNICAL_OVERVIEW.md`
- `DEPLOY.md`
- `docs/AGENT_DEPLOYMENT_GUIDE.md`
- `web-uploader/README.md`

Internal operating notes, development journals, customer files, and local memory
documents should stay outside the shared repository.

## Release Checklist

1. Run local smoke tests for the homepage, point cloud viewer, upload flow, and 3DGS viewer.
2. Run `npm run check:i18n` inside `web-uploader` after UI text changes.
3. Confirm `git status` is clean except intentional changes.
4. Push the branch to the private GitHub repository.
5. Deploy to staging first and verify `/health`, homepage, viewer, and at least one existing point cloud.
6. Promote to production only after staging passes.
