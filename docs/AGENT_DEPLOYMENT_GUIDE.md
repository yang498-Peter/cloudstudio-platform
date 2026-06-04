# AI Agent Deployment Guide

This guide is written for AI coding agents helping a partner deploy CloudStudio
from a private GitHub repository.

## Objective

Deploy CloudStudio on an Ubuntu server and verify that the browser app, point
cloud conversion, Python scripts, and runtime storage are working.

## Information to Request From the Human

Ask for:

- Server IP or hostname
- SSH username
- SSH key or approved access method
- Domain name, if HTTPS is required
- Whether the server is fresh or already contains data
- Expected deployment path, usually `/opt/cloudstudio`
- Whether sample LAS/LAZ data is available for validation

Do not ask for secrets to be pasted into chat. Ask the human to configure keys,
tokens, or environment files directly on the machine.

## Preflight Checks

On the server:

```bash
uname -a
cat /etc/os-release
df -h
free -h
whoami
```

Confirm Ubuntu 22.04 or 24.04 when possible.

## Clone and Install

```bash
cd /opt
git clone <PRIVATE_REPOSITORY_URL> cloudstudio
cd /opt/cloudstudio
sudo bash setup.sh
```

If the repository is already present:

```bash
cd /opt/cloudstudio
git status
git pull --ff-only
sudo bash setup.sh
```

## Verify Services

```bash
pm2 status cloudstudio
curl -s http://127.0.0.1:8090/health
systemctl status nginx
curl -I http://127.0.0.1:8090/
```

Expected `/health` indicators:

- `ok:true`
- `converter:true`
- `exportPython:true`
- `systemPython:true`
- `pathsExposed:false`

## Verify PotreeConverter

```bash
ls -lah /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
/opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter --help
ldd /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
```

If `ldd` reports missing libraries, install dependencies and rebuild on the
same server:

```bash
apt-get install -y libtbb-dev build-essential cmake
cd /opt/cloudstudio/PotreeConverter
cmake -S . -B build-gcc
cmake --build build-gcc --parallel "$(nproc)"
```

## Configure HTTPS

Only do this after HTTP is healthy and DNS points to the server:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d <DOMAIN>
curl -I https://<DOMAIN>/
curl -s https://<DOMAIN>/health
```

## Protect Runtime Data During Updates

Never delete or overwrite:

```text
/opt/cloudstudio/web-uploader/uploads/
/opt/cloudstudio/web-uploader/projects/
/opt/cloudstudio/web-uploader/pointclouds/
/opt/cloudstudio/web-uploader/gaussians/
/opt/cloudstudio/web-uploader/exports/
/opt/cloudstudio/web-uploader/cache/
/opt/cloudstudio/web-uploader/*_jobs/
/opt/cloudstudio/web-uploader/.env
```

Avoid `rsync --delete` unless explicit exclusions are present and the human has
approved the operation.

## Troubleshooting Decision Tree

### Website returns 502

Check:

```bash
pm2 status cloudstudio
pm2 logs cloudstudio --lines 100
curl -s http://127.0.0.1:8090/health
nginx -t
systemctl status nginx
```

### `/health` has `converter:false`

Check and rebuild PotreeConverter:

```bash
ls -lah /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
cd /opt/cloudstudio/PotreeConverter
cmake -S . -B build-gcc
cmake --build build-gcc --parallel "$(nproc)"
```

### Upload is rejected

Check Nginx size limits:

```bash
grep -n "client_max_body_size" /etc/nginx/sites-available/cloudstudio
```

Increase if needed, then reload Nginx.

### Python export fails

Check:

```bash
/opt/cloudstudio/web-uploader/.venv/bin/python -m pip list
/opt/cloudstudio/web-uploader/.venv/bin/pip install -r /opt/cloudstudio/web-uploader/requirements-export.txt
pm2 restart cloudstudio --update-env
```

## Final Report Template

Report these items back to the human:

- Server OS and deployment path
- PM2 status
- Nginx status
- `/health` result summary
- Public URL
- PotreeConverter status
- Python export status
- Disk space
- Any unresolved risk or missing input
