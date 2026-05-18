# CloudStudio Staging/Demo Deploy Runbook

This runbook is for the staging/demo server only:

- Host: `8.209.66.134`
- SSH alias: `cloudstudio-new`
- User: `root`
- App directory: `/opt/cloudstudio`
- Web directory: `/opt/cloudstudio/web-uploader`
- PM2 process: `cloudstudio`
- Node listener: `127.0.0.1:8090`
- Customer URL: `https://cloudstudio.tersus-gnss.com`
- Temporary IP debug URL: `http://8.209.66.134`

Do not treat this host as production. Use it to validate reviewed GitHub branches before any production promotion.

## Source Of Truth

Code must move through GitHub, not server-only edits:

```text
local branch -> pull request -> audit/product-hardening -> staging/demo deploy -> health checks -> production decision
```

For this hardening pass, deploy only from reviewed branches based on `audit/product-hardening`. If an emergency server edit is unavoidable, copy it back into the repository immediately and open a PR.

## Runtime Data Directory

Recommended staging setting:

```bash
CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data
```

`CLOUDSTUDIO_DATA_DIR` keeps mutable runtime data outside `/opt/cloudstudio` so code rsyncs cannot erase uploads, converted point clouds, projects, exports, cache, or job artifacts. The legacy `CLOUDSTUDIO_STORAGE_ROOT` variable still works, but new deploys should use `CLOUDSTUDIO_DATA_DIR`.

Create the directories before first start:

```bash
install -d -m 0755 \
  /srv/cloudstudio-data/uploads \
  /srv/cloudstudio-data/pointclouds \
  /srv/cloudstudio-data/gaussians \
  /srv/cloudstudio-data/projects \
  /srv/cloudstudio-data/exports \
  /srv/cloudstudio-data/cache
```

Do not migrate real data as part of this runbook. For existing data, first take a backup, stop PM2, copy with `rsync -a --dry-run`, review the output, then run the real copy in a separate maintenance task.

## Preflight

Run read-only checks before changing anything:

```bash
ssh cloudstudio-new '
set -e
cd /opt/cloudstudio
git rev-parse --short HEAD 2>/dev/null || true
pm2 status cloudstudio
pm2 describe cloudstudio
systemctl is-active nginx
curl -sS http://127.0.0.1:8090/health
'
curl -I https://cloudstudio.tersus-gnss.com
curl -I http://8.209.66.134
```

In `/health`, verify:

- `ok: true`
- `pathsExposed: false`
- `potreeRuntime.ok: true` with `potreeRuntime.missing: []`; if `build/potree/potree.js`, `build/potree/potree.css`, or any `build/potree/workers/*` runtime file is listed as missing, stop the deploy because the viewer can render blank or fail to decode point data.
- `storage.configured: true` and `storage.external: true` for new deployments using `CLOUDSTUDIO_DATA_DIR`
- Existing staging data may temporarily report `storage.configured: false` while legacy colocated runtime directories are preserved for a separate migration task.
- each `storage.directories.*.primaryWritable: true`

## Backup Before Deploy

Create a timestamped backup on the staging/demo host:

```bash
ssh cloudstudio-new '
set -e
ts=$(date +%Y%m%d-%H%M%S)
backup=/opt/cloudstudio/backups/predeploy-$ts
install -d "$backup"
cp -a /opt/cloudstudio/web-uploader/server.js "$backup/server.js"
cp -a /opt/cloudstudio/web-uploader/index.html "$backup/index.html"
cp -a /opt/cloudstudio/web-uploader/viewer.html "$backup/viewer.html"
cp -a /opt/cloudstudio/web-uploader/package.json "$backup/package.json"
cp -a /opt/cloudstudio/web-uploader/package-lock.json "$backup/package-lock.json"
cp -a /opt/cloudstudio/web-uploader/.env "$backup/.env" 2>/dev/null || true
cp -a /etc/nginx/sites-available/cloudstudio "$backup/nginx-cloudstudio" 2>/dev/null || true
pm2 save
cp -a /root/.pm2/dump.pm2 "$backup/dump.pm2" 2>/dev/null || true
echo "$backup"
'
```

Do not place backups under directories served as runtime assets.

## Rsync Deploy

From the local repository root, sync code with explicit runtime-data excludes:

```bash
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'web-uploader/.env' \
  --exclude 'web-uploader/node_modules/' \
  --exclude 'web-uploader/.venv/' \
  --exclude 'web-uploader/uploads/' \
  --exclude 'web-uploader/pointclouds/' \
  --exclude 'web-uploader/gaussians/' \
  --exclude 'web-uploader/projects/' \
  --exclude 'web-uploader/exports/' \
  --exclude 'web-uploader/cache/' \
  --exclude 'web-uploader/*_jobs/' \
  --exclude 'PotreeConverter/build*/' \
  ./ cloudstudio-new:/opt/cloudstudio/
```

Use `--dry-run` first when the changed file set is large:

```bash
rsync -az --delete --dry-run [same excludes as above] ./ cloudstudio-new:/opt/cloudstudio/
```

Never deploy by deleting `/opt/cloudstudio` and recreating it.

## Install And Restart

```bash
ssh cloudstudio-new '
set -e
cd /opt/cloudstudio/web-uploader
npm ci --omit=dev
set -a
. ./.env
set +a
pm2 restart cloudstudio --update-env
pm2 save
nginx -t
systemctl reload nginx
'
```

If `PotreeConverter` changes, rebuild it in a separate step and keep `/opt/cloudstudio/PotreeConverter/build-gcc/` out of rsync deletes unless the rebuild is intentional.

## Health And Smoke Checks

```bash
ssh cloudstudio-new '
set -e
pm2 status cloudstudio
systemctl is-active nginx
curl -sS http://127.0.0.1:8090/health
curl -sS http://127.0.0.1:8090/api/clouds
curl -sS http://127.0.0.1:8090/api/grids
'
curl -I https://cloudstudio.tersus-gnss.com
curl -I http://8.209.66.134
```

Open these staging/demo pages in a browser:

- `https://cloudstudio.tersus-gnss.com/`
- `https://cloudstudio.tersus-gnss.com/viewer`
- `http://8.209.66.134/` for IP-only debugging
- one known existing point cloud
- one known existing 3DGS asset, if present

## Rollback

If PM2 is online but `/health` fails, or Nginx returns 502, roll back the last changed code files first:

```bash
ssh cloudstudio-new '
set -e
backup=/opt/cloudstudio/backups/predeploy-YYYYmmdd-HHMMSS
cp -a "$backup/server.js" /opt/cloudstudio/web-uploader/server.js
cp -a "$backup/index.html" /opt/cloudstudio/web-uploader/index.html
cp -a "$backup/viewer.html" /opt/cloudstudio/web-uploader/viewer.html
cp -a "$backup/package.json" /opt/cloudstudio/web-uploader/package.json
cp -a "$backup/package-lock.json" /opt/cloudstudio/web-uploader/package-lock.json
cd /opt/cloudstudio/web-uploader
npm ci --omit=dev
pm2 restart cloudstudio --update-env
curl -sS http://127.0.0.1:8090/health
'
```

Only restore `.env`, Nginx config, or PM2 dump when those files were part of the failed change. Runtime data under `CLOUDSTUDIO_DATA_DIR` must not be rolled back or deleted during code rollback.

## Data Protection Checklist

Before every deploy, confirm the rsync excludes or backup plan protects:

- `web-uploader/.env`
- `web-uploader/uploads/`
- `web-uploader/pointclouds/`
- `web-uploader/gaussians/`
- `web-uploader/projects/`
- `web-uploader/exports/`
- `web-uploader/cache/`
- `web-uploader/*_jobs/`
- `web-uploader/scan_roots.json`
- `PotreeConverter/build*/`
- the external `CLOUDSTUDIO_DATA_DIR`
