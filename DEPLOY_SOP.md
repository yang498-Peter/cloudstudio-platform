# CloudStudio Release, Upgrade, and Production Maintenance SOP

This SOP describes how to safely update an existing CloudStudio server without damaging runtime data or creating extended downtime.

Use `DEPLOY.md` for a brand-new server. Use this document when the server already has CloudStudio, user uploads, converted point clouds, 3DGS assets, or job outputs.

---

## 1. Core Principles

1. **The server is a deployment target, not the source of truth.** Source changes should come from a committed branch or release artifact.
2. **Runtime data must be separated from application code.** Prefer `CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data`.
3. **Never delete or overwrite runtime directories during deployment.** Protect uploads, projects, pointclouds, gaussians, exports, cache, and job directories.
4. **Use the smallest safe deployment scope.** Hotfix a few files when only a few files changed; use controlled `rsync` when many files changed.
5. **Back up before changing.** Even a one-file hotfix should have a rollback copy.
6. **Validate locally on the server before validating through the public domain.** Check `127.0.0.1:8090` first, then Nginx/public access.
7. **Rollback first when a release breaks availability.** Do not stack unverified patches on a failing production instance.

---

## 2. Current Staging/Demo Profile

The reviewed staging/demo deployment profile is:

| Item | Value |
| --- | --- |
| Host | `8.209.66.134` |
| SSH alias | `cloudstudio-new` |
| SSH user | `root` |
| Application directory | `/opt/cloudstudio` |
| Web application directory | `/opt/cloudstudio/web-uploader` |
| Recommended data directory | `/srv/cloudstudio-data` |
| Required data variable | `CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data` |
| PM2 process | `cloudstudio` |
| Local app URL | `http://127.0.0.1:8090` |
| Health endpoint | `/health` |
| Reverse proxy | Nginx |
| Customer URL | `https://cloudstudio.tersus-gnss.com` |
| Temporary IP URL | `http://8.209.66.134` |

For the detailed staging/demo runbook, see `docs/staging-deploy-runbook.md`.

---

## 3. Pre-Deployment Read-Only Inspection

Run these commands before modifying files:

```bash
ssh cloudstudio-new
pm2 status cloudstudio
pm2 describe cloudstudio
systemctl is-active nginx
nginx -t
curl -s http://127.0.0.1:8090/health
```

Confirm application and data boundaries:

```bash
cd /opt/cloudstudio/web-uploader
pwd
cat .env | sed -E 's/(TOKEN|SECRET|PASSWORD|KEY)=.*/\1=***REDACTED***/g' || true
find /srv/cloudstudio-data -maxdepth 2 -type d | sort | head -n 50
```

Do not proceed until you know where runtime data is stored.

---

## 4. Files and Directories That Must Be Protected

Never overwrite or delete these paths during deployment:

- `web-uploader/uploads/`
- `web-uploader/projects/`
- `web-uploader/pointclouds/`
- `web-uploader/gaussians/`
- `web-uploader/exports/`
- `web-uploader/cache/`
- `web-uploader/*_jobs/`
- `web-uploader/.env`
- `web-uploader/scan_roots.json`
- `/srv/cloudstudio-data/`
- `PotreeConverter/build-gcc/` unless you are intentionally rebuilding the converter

If runtime data still lives inside the application directory, migrate it to `/srv/cloudstudio-data` before large upgrades.

---

## 5. Pre-Deployment Backup

Create a timestamp and backup directory:

```bash
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "/opt/cloudstudio/backups/predeploy-${TS}"
mkdir -p "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}"
```

Back up important files:

```bash
cp -a /opt/cloudstudio/web-uploader/server.js "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}/server.js" 2>/dev/null || true
cp -a /opt/cloudstudio/web-uploader/viewer.html "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}/viewer.html" 2>/dev/null || true
cp -a /opt/cloudstudio/web-uploader/index.html "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}/index.html" 2>/dev/null || true
cp -a /opt/cloudstudio/web-uploader/package.json "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}/package.json" 2>/dev/null || true
cp -a /opt/cloudstudio/web-uploader/package-lock.json "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}/package-lock.json" 2>/dev/null || true
cp -a /opt/cloudstudio/web-uploader/requirements-export.txt "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}/requirements-export.txt" 2>/dev/null || true
cp -a /opt/cloudstudio/web-uploader/.env "/opt/cloudstudio/web-uploader/backups/predeploy-${TS}/.env" 2>/dev/null || true
cp -a /etc/nginx/sites-available/cloudstudio "/opt/cloudstudio/backups/predeploy-${TS}/nginx-cloudstudio" 2>/dev/null || true
pm2 save
pm2 dump >/tmp/cloudstudio-pm2-dump-${TS}.txt 2>&1 || true
```

---

## 6. Choose the Deployment Method

### 6.1 Small Hotfix Deployment

Use this when only a few known files changed.

From your local repository:

```bash
scp web-uploader/server.js cloudstudio-new:/opt/cloudstudio/web-uploader/server.js
scp web-uploader/viewer.html cloudstudio-new:/opt/cloudstudio/web-uploader/viewer.html
scp web-uploader/index.html cloudstudio-new:/opt/cloudstudio/web-uploader/index.html
```

Then restart and validate:

```bash
ssh cloudstudio-new '
set -e
cd /opt/cloudstudio/web-uploader
pm2 restart cloudstudio --update-env
sleep 3
curl -s http://127.0.0.1:8090/health
'
```

### 6.2 Controlled Multi-File Sync

Use this when a feature touches multiple directories.

From your local repository root:

```bash
rsync -az --delete \
  --exclude 'web-uploader/.env' \
  --exclude 'web-uploader/node_modules/' \
  --exclude 'web-uploader/.venv/' \
  --exclude 'web-uploader/uploads/' \
  --exclude 'web-uploader/projects/' \
  --exclude 'web-uploader/pointclouds/' \
  --exclude 'web-uploader/gaussians/' \
  --exclude 'web-uploader/exports/' \
  --exclude 'web-uploader/cache/' \
  --exclude 'web-uploader/*_jobs/' \
  --exclude 'web-uploader/scan_roots.json' \
  --exclude 'PotreeConverter/build-gcc/' \
  ./ cloudstudio-new:/opt/cloudstudio/
```

Then on the server:

```bash
ssh cloudstudio-new '
set -e
cd /opt/cloudstudio/web-uploader
npm ci || npm install
if [ -x .venv/bin/python ]; then
  .venv/bin/python -m pip install -r requirements-export.txt
fi
pm2 restart cloudstudio --update-env
sleep 3
curl -s http://127.0.0.1:8090/health
'
```

---

## 7. Post-Deployment Validation

Validate the local application first:

```bash
ssh cloudstudio-new '
set -e
pm2 status cloudstudio
curl -s http://127.0.0.1:8090/health
curl -I http://127.0.0.1:8090/viewer
'
```

Validate through Nginx and the public endpoint:

```bash
curl -I http://8.209.66.134/
curl -I https://cloudstudio.tersus-gnss.com/
curl -s https://cloudstudio.tersus-gnss.com/health
```

Functional smoke checklist:

1. Home page opens.
2. Viewer page opens.
3. Existing projects are still visible.
4. Existing point clouds still load.
5. Upload of a small sample file works if upload was affected.
6. Export or analysis workflow works if Python scripts changed.
7. Browser console and PM2 logs do not show new critical errors.

---

## 8. Rollback Procedure

If the release causes 502 errors, broken viewer loading, or critical workflow failures, rollback quickly.

### 8.1 Roll Back a Hotfixed File

```bash
ssh cloudstudio-new '
set -e
cd /opt/cloudstudio/web-uploader
cp backups/predeploy-YYYYmmdd-HHMMSS/server.js ./server.js
pm2 restart cloudstudio --update-env
sleep 3
curl -s http://127.0.0.1:8090/health
'
```

Replace `YYYYmmdd-HHMMSS` with the actual backup timestamp.

### 8.2 Roll Back from Git

```bash
ssh cloudstudio-new '
set -e
cd /opt/cloudstudio
git status --short
git log --oneline -n 5
git checkout PREVIOUS_COMMIT -- web-uploader server.js potree PotreeConverter 2>/dev/null || true
cd web-uploader
pm2 restart cloudstudio --update-env
sleep 3
curl -s http://127.0.0.1:8090/health
'
```

Use a precise rollback command based on the files changed in the failed release. Do not reset runtime directories.

---

## 9. Dependency Changes

If `web-uploader/package.json` or lock files changed:

```bash
cd /opt/cloudstudio/web-uploader
npm ci || npm install
pm2 restart cloudstudio --update-env
```

If `web-uploader/requirements-export.txt` changed:

```bash
cd /opt/cloudstudio/web-uploader
. .venv/bin/activate
python -m pip install -r requirements-export.txt
pm2 restart cloudstudio --update-env
```

If PotreeConverter changed:

1. Back up the old converter binary.
2. Rebuild in a separate build directory when possible.
3. Update `CONVERTER_PATH` only after the new binary is verified.
4. Test conversion with a small LAS/LAZ sample.

---

## 10. Release Notes Template

Use this template for deployment notes:

```text
Release: YYYY-MM-DD / short title
Commit: <git sha>
Server: <host>
Operator: <name>

Changed areas:
- web-uploader/server.js
- web-uploader/assets/app/features/...
- docs/...

Pre-check:
- PM2 status: ok
- Nginx config: ok
- /health before deploy: ok

Deployment method:
- hotfix scp / rsync / git pull / archive upload

Post-check:
- /health after deploy: ok
- viewer: ok
- upload/conversion: ok or not applicable
- export/analysis: ok or not applicable

Rollback point:
- /opt/cloudstudio/backups/predeploy-YYYYmmdd-HHMMSS
```

---

## 11. Common Failure Patterns

| Failure | Likely Cause | First Action |
| --- | --- | --- |
| Public 502 | PM2 app down or Nginx proxy mismatch | `pm2 logs cloudstudio`, `curl http://127.0.0.1:8090/health` |
| Viewer static assets 404 | Bad sync path or missing `potree/`/`assets/` files | Check Nginx logs and application static paths. |
| Upload 413 | Nginx body size too small | Increase `client_max_body_size`, reload Nginx. |
| Conversion fails | Missing/bad `CONVERTER_PATH` or converter binary | Verify converter path and executable permission. |
| Python jobs fail | Missing `.venv` packages or wrong `PYTHON_BIN` | Reinstall `requirements-export.txt`, restart PM2. |
| Existing projects disappear | Runtime data path changed | Check `.env`, `CLOUDSTUDIO_DATA_DIR`, and `/srv/cloudstudio-data`. |

