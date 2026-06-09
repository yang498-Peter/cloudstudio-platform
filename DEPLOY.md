# CloudStudio Deployment Guide

This guide explains how to deploy CloudStudio on a clean Ubuntu server. It is
written for developers, deployers, and AI agents that need to bring up a working
instance from this open-source repository.

## Target Environment

Recommended server:

- Ubuntu 22.04 LTS or Ubuntu 24.04 LTS
- 4 CPU cores or more
- 8 GB RAM or more
- 80 GB disk or more for small demos
- Larger disk or object storage for production point cloud datasets
- Inbound ports 80 and 443 open
- Inbound port 22 open for SSH administration

CloudStudio can run on smaller machines for demos, but point cloud conversion
and analysis workflows are CPU, memory, and disk intensive.

## What the Installer Does

`setup.sh` performs these steps:

1. Installs system packages: Git, CMake, build tools, TBB, Python, Nginx, and utilities.
2. Installs Node.js 18 if the server does not already have a compatible Node version.
3. Builds `PotreeConverter` locally for the target Linux environment.
4. Creates `web-uploader/.venv` and installs Python script dependencies.
5. Installs Node dependencies for the Express app.
6. Creates `web-uploader/.env` from `.env.example` if needed.
7. Sets production mode and generates an upload password hash if one is not already configured.
8. Configures Nginx as a reverse proxy to `127.0.0.1:8090`.
9. Starts the app with PM2 under the process name `cloudstudio`.

## Quick Deployment

SSH into the server, then run:

```bash
cd /opt
git clone <REPOSITORY_URL> cloudstudio
cd /opt/cloudstudio
sudo bash setup.sh
```

When the script finishes, open:

```text
http://<server-ip>/
```

For production use, configure a domain name and HTTPS after the basic HTTP
deployment is healthy.

## Pre-Deploy Verification

Before deploying a changed branch, run the release gate locally:

```bash
cd web-uploader
npm run check:release
```

This checks localization, public-release hygiene, deployment docs, server-safe
API behavior, upload security, 3DGS publish state, capability gating, and viewer
smoke coverage. If Playwright Chromium is not installed, browser-only smoke
subtests may be reported as skipped; still do a manual browser check before
promoting a public demo or production server.

## Environment Configuration

The main environment file is:

```text
/opt/cloudstudio/web-uploader/.env
```

Common variables:

```bash
PORT=8090
CLOUDSTUDIO_ENV=production
UPLOAD_REVIEW_PASSWORD_SHA256=<sha256-of-your-upload-password>
CONVERTER_PATH=/opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
PYTHON_BIN=/opt/cloudstudio/web-uploader/.venv/bin/python
PYTHON3_BIN=python3
```

The app can auto-detect many paths, but production deployments should set
explicit paths so future maintenance is predictable.

Legacy desktop scan-root discovery is disabled by default on public servers.
Uploaded/runtime projects are still discovered automatically. Only set
`CLOUDSTUDIO_ENABLE_DESKTOP_SCAN_ROOTS=true` together with the desktop-local
capability flags in a controlled private environment.

`setup.sh` generates a random upload password when
`UPLOAD_REVIEW_PASSWORD_SHA256` is missing and writes the one-time plaintext
password to the server checkout:

```text
web-uploader/.cloudstudio-upload-password.txt
```

Set `CLOUDSTUDIO_UPLOAD_PASSWORD_FILE` before running the installer if you want
that one-time file somewhere else. Store the password securely and remove or
rotate it when appropriate.

## Health Check

Run this on the server:

```bash
curl -s http://127.0.0.1:8090/health
```

Expected important fields:

```json
{
  "ok": true,
  "converter": true,
  "exportPython": true,
  "systemPython": true,
  "pathsExposed": false
}
```

If `converter:false`, check:

```bash
ls -lah /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
ldd /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
```

If the binary is missing, rebuild it:

```bash
cd /opt/cloudstudio/PotreeConverter
mkdir -p build-gcc
cmake -S . -B build-gcc
cmake --build build-gcc --parallel "$(nproc)"
```

## Service Commands

```bash
pm2 status cloudstudio
pm2 logs cloudstudio --lines 100
pm2 restart cloudstudio
pm2 save
systemctl status nginx
nginx -t
```

## Nginx and Large Uploads

The installer configures Nginx with:

```nginx
client_max_body_size 4g;
client_body_timeout 600s;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

Increase `client_max_body_size` if users upload very large LAS/LAZ files.

## HTTPS

After HTTP is working, point your domain to the server and install Certbot:

```bash
apt-get update
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d <your-domain>
```

Then verify:

```bash
curl -I https://<your-domain>/
curl -s https://<your-domain>/health
```

## Runtime Data Directories

Do not delete or overwrite these directories during upgrades:

```text
web-uploader/uploads/
web-uploader/projects/
web-uploader/pointclouds/
web-uploader/gaussians/
web-uploader/exports/
web-uploader/cache/
web-uploader/dtm_jobs/
web-uploader/contour_jobs/
web-uploader/surface_jobs/
web-uploader/volume_jobs/
web-uploader/volume_surface_jobs/
web-uploader/floorplan_jobs/
web-uploader/.env
```

These contain user uploads, generated outputs, project state, and server-local
configuration.

## Upgrade Pattern

Recommended upgrade flow:

```bash
cd /opt/cloudstudio
git fetch origin
git status
git pull --ff-only
cd web-uploader
npm install --production
../web-uploader/.venv/bin/pip install -r requirements-export.txt
pm2 restart cloudstudio --update-env
pm2 save
curl -s http://127.0.0.1:8090/health
```

If PotreeConverter source changed, rebuild it:

```bash
cd /opt/cloudstudio/PotreeConverter
cmake -S . -B build-gcc
cmake --build build-gcc --parallel "$(nproc)"
```

## Troubleshooting

### Browser shows 502

The Node app is not reachable through Nginx.

```bash
pm2 status cloudstudio
pm2 logs cloudstudio --lines 100
curl -s http://127.0.0.1:8090/health
systemctl status nginx
```

### Upload fails with 413

Increase Nginx upload size:

```bash
sed -i 's/client_max_body_size 4g/client_max_body_size 8g/' /etc/nginx/sites-available/cloudstudio
nginx -t
systemctl reload nginx
```

### Conversion fails

Check PotreeConverter:

```bash
/opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter --help
ldd /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
```

Rebuild on the target server instead of copying a binary from a different Linux
distribution.

### Export or CRS scripts fail

Check Python:

```bash
/opt/cloudstudio/web-uploader/.venv/bin/python -m pip list
/opt/cloudstudio/web-uploader/.venv/bin/python - <<'PY'
import laspy, pyproj, numpy, scipy, matplotlib
print("python-ok")
PY
```

## Handoff Checklist

Before sharing the instance with users or another team:

- `/health` returns `ok:true`.
- `converter`, `exportPython`, and `systemPython` are true.
- Nginx is active.
- PM2 process `cloudstudio` is online.
- HTTPS is configured if the instance is public.
- No customer data is committed to Git.
- A separate storage plan exists for large datasets.
