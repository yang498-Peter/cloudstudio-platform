# CloudStudio Repository Management

CloudStudio should be developed from this repository, reviewed through Git
history, and deployed to servers as a controlled release. Production, demo, or
test servers must not become the primary place where code is edited.

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

## GitHub Push Workflow

Use this flow before pushing local work to GitHub:

```bash
git status --short
git diff --stat
git diff --check

cd web-uploader
npm run check:release
cd ..
```

Review the exact files before staging:

```bash
git status --short
git diff --name-only
```

Prefer staging explicit files instead of using `git add -A` blindly:

```bash
git add README.md DEPLOY.md docs/AGENT_DEPLOYMENT_GUIDE.md
git add docs/TECHNICAL_OVERVIEW.md docs/repository-management.md
git add CONTRIBUTING.md SECURITY.md THIRD_PARTY_NOTICES.md LICENSE
```

Then inspect the staged result:

```bash
git diff --cached --stat
git diff --cached --name-only
git diff --cached --check
```

Commit and push only after the staged file list looks intentional:

```bash
git commit -m "Prepare repository for open source release"
git push origin main
```

## Public Release Guardrails

The repository includes `npm run check:release` in `web-uploader`. Run it before
commits and rely on CI to run it again on GitHub.

The check blocks common accidental-publication risks:

- internal memory folders and development journals
- operational runbooks and audit reports
- Word documents, DXF files, and local handoff files
- private repository placeholders
- real server IPs, SSH aliases, SSH identities, and root login snippets
- customer data paths that should remain runtime storage

The Tersus brand may appear in public-facing product or company context. Do not
commit private server domains, login methods, credentials, customer data, or
deployment records.

## Release Checklist

1. Run local smoke tests for the homepage, point cloud viewer, upload flow, and 3DGS viewer.
2. Run `npm run check:release` inside `web-uploader`.
3. Run `npm run check:i18n` inside `web-uploader` after UI text changes if you
   need a faster localization-only check.
4. Confirm `git status` is clean except intentional changes.
5. Push the branch to GitHub or publish a controlled release package.
6. Deploy to a test or staging environment first and verify `/health`, homepage,
   viewer, and at least one existing point cloud.
7. Promote to production only after validation passes.
