# Contributing to CloudStudio

Thanks for your interest in CloudStudio. This project is being opened so more
people can experiment with browser-based point cloud workflows, self-hosted 3D
review platforms, and AI-assisted deployment.

## Good First Contributions

- Improve deployment documentation for different cloud providers.
- Add focused tests around upload, conversion, export, and viewer workflows.
- Improve i18n coverage and UI text clarity.
- Fix browser compatibility and local setup issues.
- Add safe sample datasets or sample-data instructions that do not include
  customer or proprietary data.

## Development Workflow

1. Fork the repository.
2. Create a branch from `main`.
3. Keep changes focused.
4. Run the relevant tests before opening a pull request.
5. Explain what changed, why it changed, and how it was verified.

Useful commands:

```bash
cd web-uploader
npm run check:i18n
npm run test:volume
npm run test:viewer-smoke
```

## What Not To Commit

Do not commit:

- credentials, tokens, SSH keys, certificates, or `.env` files
- customer data, scans, LAS/LAZ/E57 files, or generated point clouds
- private server IPs, domains, usernames, or operational runbooks
- local memory files, internal notes, screenshots, or temporary artifacts
- generated dependency folders such as `node_modules/` and `.venv/`

## Pull Request Expectations

Pull requests should be understandable to someone who has not seen your local
environment. Include:

- a concise summary
- testing performed
- screenshots or short recordings for UI changes when useful
- notes about deployment or migration impact

Large rewrites are harder to review. Prefer smaller PRs that improve one
workflow at a time.
