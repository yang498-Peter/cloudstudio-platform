# CloudStudio Platform

CloudStudio is a web platform for publishing, converting, viewing, and reviewing
LiDAR point clouds and 3D Gaussian Splatting datasets. It is designed for teams
that need a self-hosted browser experience for project review, measurement,
profile inspection, export workflows, and lightweight data sharing.

This repository is prepared for private sharing with partners, dealers, and
technical teams. It contains source code, setup scripts, documentation, and
lightweight static assets. Runtime datasets, customer files, credentials,
generated point clouds, and internal development notes are intentionally excluded.

## What You Can Do With It

- Run a local CloudStudio viewer for development or demos.
- Deploy CloudStudio to an Ubuntu server.
- Upload LAS/LAZ point clouds and convert them to Potree format.
- Open and inspect point cloud projects in a browser.
- Review measurements, profiles, clipping, display settings, and export tools.
- Use 3D Gaussian Splatting viewer assets through the bundled SuperSplat integration.
- Extend the frontend modules and backend processing scripts for your workflow.

## Repository Layout

```text
cloudstudio-platform/
├── web-uploader/          # Main Express app, frontend shell, APIs, scripts, tests
├── potree/                # Potree viewer source and static runtime assets
├── PotreeConverter/       # PotreeConverter source, compiled on the target machine
├── docs/                  # Public technical and deployment documentation
├── setup.sh               # Ubuntu server installer
├── DEPLOY.md              # Human-readable deployment guide
└── README.md              # Repository overview
```

## Public Documentation

- [Technical overview](docs/TECHNICAL_OVERVIEW.md)
- [Deployment guide](DEPLOY.md)
- [AI agent deployment guide](docs/AGENT_DEPLOYMENT_GUIDE.md)
- [Web app notes](web-uploader/README.md)

## Local Development

Requirements:

- Node.js 18 or newer
- Python 3.10 or newer
- npm
- A local build of PotreeConverter for full point cloud conversion support

Start the local app:

```bash
cd web-uploader
npm install
cp .env.example .env
npm run setup:local
npm run start:local
```

Open:

- `http://localhost:8090/`
- `http://localhost:8090/viewer`
- `http://localhost:8090/health`

If `/health` reports `converter:false`, build PotreeConverter locally or set
`CONVERTER_PATH` in `web-uploader/.env`.

## Server Deployment

For a fresh Ubuntu server, clone this repository and run:

```bash
sudo bash setup.sh
```

The setup script installs system dependencies, builds PotreeConverter, creates
the Python environment, installs Node dependencies, configures Nginx, and starts
the app with PM2.

Read [DEPLOY.md](DEPLOY.md) before deploying to production.

## Runtime Data Policy

The following paths are runtime data and must not be committed:

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
- `potree/pointclouds/*`

Large source datasets such as LAS, LAZ, PLY, SOG, E57, ZIP archives, customer
projects, and generated Potree outputs should live in server storage or object
storage, not Git.

## Suggested Sharing Workflow

For private sharing with a colleague or dealer:

1. Keep the repository private.
2. Invite the person as a GitHub collaborator, or share access through your
   organization.
3. Ask them to start with `README.md`, `DEPLOY.md`, and
   `docs/AGENT_DEPLOYMENT_GUIDE.md`.
4. If they use an AI coding agent, give the agent the repository URL and the
   deployment guide.
5. Provide only non-sensitive sample data separately, outside the repository.

## Current Maturity

CloudStudio is functional but still evolving. Treat it as a technical platform
that can be deployed and extended by an engineering team, not yet as a polished
public open-source product.

Before broad public release, review licensing, third-party attribution, security
configuration, sample data policy, and production hardening.
