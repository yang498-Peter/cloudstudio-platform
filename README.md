# CloudStudio Platform

**CloudStudio turns massive point clouds into browser-native project links.**

Point clouds should not be trapped inside specialist desktop software. A scan can
capture a mine, road, building, stockpile, facade, forest plot, or construction
site in extraordinary detail, but the result is often locked inside multi-GB
files that only trained operators can open. Clients cannot inspect it. Sales
teams cannot share it easily. Project owners cannot measure it without asking a
specialist. Valuable 3D information becomes a file-transfer problem.

CloudStudio is built to change that.

It is a self-hostable web platform for uploading, converting, viewing, measuring,
sharing, and extending LiDAR point cloud workflows directly in the browser. The
goal is simple and ambitious:

> **Make point cloud sharing as easy as sending a web link.**

With CloudStudio, a team can move from "please install this point cloud tool
first" to "open this link and inspect the site." It brings together the pieces
that are usually scattered across desktop software, conversion tools, manual
exports, screenshots, and large file transfers:

- upload LAS/LAZ point cloud data
- convert data into browser-ready Potree projects
- open and review scenes from a standard web browser
- measure distance, height, XYZ coordinates, profiles, and clipped regions
- run practical stockpile and earthwork volume workflows
- draw and export DXF linework
- browse, download, and share project outputs
- view 3D Gaussian Splatting assets through the bundled SuperSplat integration
- deploy the entire stack privately on your own server

This is not just another point cloud viewer. It is a starting point for a
browser-based 3D work platform: scanner to server, server to browser, browser to
decision. For dealers, survey teams, SLAM and LiDAR product groups, mining and
construction users, BIM teams, and reality-capture developers, CloudStudio offers
a practical path toward making 3D data easier to understand, easier to share, and
easier to turn into action.

## Why It Matters

Modern reality capture hardware is advancing quickly, but sharing the result is
still painful. A beautiful scan is not useful if the people who need it cannot
open it, measure it, or discuss it without installing professional tools.

CloudStudio targets that gap:

- **For customers:** open a link, inspect the result, and understand the project.
- **For dealers and sales teams:** demonstrate scan value without sending giant files.
- **For field teams:** publish site data to a private server and review it from anywhere.
- **For developers:** extend a real point-cloud workflow instead of starting from zero.
- **For AI agents:** use the deployment guide to install and validate the platform step by step.

The long-term opportunity is large: self-hosted digital twin review, web-based
LiDAR collaboration, 3D Gaussian Splatting publishing, browser-side measurement,
private point cloud portals, dealer demo servers, and AI-assisted geospatial
workflows can all build on the same foundation.

## What You Can Do With It

- Run a local CloudStudio viewer for development, testing, and demos.
- Deploy CloudStudio to an Ubuntu server with the included installer.
- Upload LAS/LAZ point clouds and convert them to Potree format.
- Open and inspect point cloud projects in a browser.
- Review measurements, profiles, clipping, display settings, and export tools.
- Use volume workflows for stockpile and earthwork-style calculations.
- Use DXF drawing/export workflows for lightweight linework handoff.
- Use 3D Gaussian Splatting viewer assets through the bundled SuperSplat integration.
- Give the repository and deployment guide to an AI coding agent to assist setup.
- Extend the frontend modules and backend processing scripts for your workflow.

## Current Position

CloudStudio is functional and deployable, but it is still evolving. Treat it as a
powerful technical platform and product prototype: ready for private evaluation,
partner testing, internal demos, and engineering extension, not yet as a polished
public SaaS product.

The repository is prepared for private sharing with partners, dealers, and
technical teams. It contains source code, setup scripts, documentation, and
lightweight static assets. Runtime datasets, customer files, credentials,
generated point clouds, and internal development notes are intentionally excluded.

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

## Before Broader Release

Before broad public release, review licensing, third-party attribution, security
configuration, sample data policy, and production hardening.
