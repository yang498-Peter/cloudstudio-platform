# Security Policy

CloudStudio is a self-hostable platform for working with large 3D datasets.
Deployers are responsible for protecting their servers, uploaded data, and
network access.

## Reporting Security Issues

Please do not open a public GitHub issue for a suspected vulnerability.

Report security concerns privately to the project maintainer or repository owner.
Include:

- affected version or commit
- reproduction steps
- impact
- any relevant logs or screenshots with secrets removed

## Deployment Security Notes

- Use HTTPS for public deployments.
- Do not expose upload or admin workflows without appropriate access controls.
- Keep `.env`, SSH keys, tokens, certificates, and server-specific config out of Git.
- Store runtime data outside the application code directory when possible.
- Back up runtime data before upgrades.
- Review Nginx upload limits and server resource limits before allowing public uploads.
- Treat point cloud data as potentially sensitive project information.

## Supported Versions

This project is early-stage. Security fixes are applied to the current `main`
branch unless a release branch is explicitly announced.
