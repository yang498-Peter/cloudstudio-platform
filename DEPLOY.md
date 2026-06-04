# CloudStudio First-Time Server Deployment Guide

This guide explains how to deploy CloudStudio on a clean Linux server and how to prepare that server for ongoing operation and secondary development.

Target audience:

- Engineers deploying CloudStudio for the first time.
- Operators preparing a staging or production server.
- Developers who need a repeatable server environment for feature testing.

Recommended operating systems:

- Ubuntu 22.04 LTS
- Ubuntu 24.04 LTS

Recommended deployment model:

- Application code: `/opt/cloudstudio`
- Runtime/customer data: `/srv/cloudstudio-data`
- Node application port: `8090`
- Process manager: PM2
- Reverse proxy: Nginx
- Public access: HTTPS through Nginx

---

## 1. Deployment Architecture

```text
Internet
  |
  v
Nginx :80/:443
  |
  v
CloudStudio Node.js app on 127.0.0.1:8090
  |
  +-- web-uploader/           application code
  +-- potree/                 viewer runtime
  +-- PotreeConverter/        point-cloud converter
  +-- Python scripts          analysis/export jobs
  +-- /srv/cloudstudio-data   uploads, converted clouds, exports, caches, jobs
```

Keep application code and runtime data separate. This is the most important deployment rule because it allows safe upgrades without deleting customer data.

---

## 2. Prepare DNS and Server Access

Before installing CloudStudio, prepare:

1. A Linux server with root or sudo access.
2. A domain name, if this server will be public.
3. Inbound firewall/security-group rules for:
   - TCP `22` for SSH.
   - TCP `80` for HTTP.
   - TCP `443` for HTTPS.
4. A deployment SSH key.

Example SSH connection:

```bash
ssh root@YOUR_SERVER_IP
```

---

## 3. Install System Dependencies

Run these commands on the server:

```bash
apt-get update
apt-get install -y \
  git curl ca-certificates build-essential cmake pkg-config \
  nginx python3 python3-venv python3-pip \
  libtbb-dev libboost-all-dev unzip rsync
```

Install Node.js 20 LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version
```

Install PM2 globally:

```bash
npm install -g pm2
pm2 --version
```

---

## 4. Create Application and Data Directories

```bash
mkdir -p /opt/cloudstudio
mkdir -p /srv/cloudstudio-data/{uploads,projects,pointclouds,gaussians,exports,cache,jobs}
chown -R root:root /opt/cloudstudio /srv/cloudstudio-data
```

If you run the application as a non-root service user, create that user and adjust ownership accordingly:

```bash
useradd --system --create-home --shell /bin/bash cloudstudio || true
chown -R cloudstudio:cloudstudio /opt/cloudstudio /srv/cloudstudio-data
```

---

## 5. Upload or Clone the Code

### Option A: Clone from Git

```bash
cd /opt
rm -rf /opt/cloudstudio
GIT_SSH_COMMAND='ssh -i /path/to/deploy_key' git clone YOUR_PRIVATE_REPO_URL /opt/cloudstudio
cd /opt/cloudstudio
```

### Option B: Upload a Release Archive

From your local machine:

```bash
tar -czf cloudstudio-platform.tar.gz \
  --exclude='cloudstudio-platform/web-uploader/node_modules' \
  --exclude='cloudstudio-platform/web-uploader/.venv' \
  --exclude='cloudstudio-platform/web-uploader/uploads' \
  --exclude='cloudstudio-platform/web-uploader/projects' \
  --exclude='cloudstudio-platform/web-uploader/pointclouds' \
  --exclude='cloudstudio-platform/web-uploader/gaussians' \
  --exclude='cloudstudio-platform/web-uploader/exports' \
  --exclude='cloudstudio-platform/web-uploader/cache' \
  cloudstudio-platform/

scp cloudstudio-platform.tar.gz root@YOUR_SERVER_IP:/opt/
```

On the server:

```bash
cd /opt
tar -xzf cloudstudio-platform.tar.gz
rm -rf /opt/cloudstudio
mv cloudstudio-platform /opt/cloudstudio
cd /opt/cloudstudio
```

---

## 6. Configure Environment Variables

Create `/opt/cloudstudio/web-uploader/.env`:

```bash
cat > /opt/cloudstudio/web-uploader/.env <<'EOF_ENV'
PORT=8090
CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data
PYTHON_BIN=/opt/cloudstudio/web-uploader/.venv/bin/python
PYTHON3_BIN=/opt/cloudstudio/web-uploader/.venv/bin/python
# CONVERTER_PATH=/opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
EOF_ENV
```

Important variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local Node.js port behind Nginx. Default: `8090`. |
| `CLOUDSTUDIO_DATA_DIR` | External runtime data root. Recommended: `/srv/cloudstudio-data`. |
| `PYTHON_BIN` | Python executable for export/grid/analysis scripts. |
| `PYTHON3_BIN` | Python executable for ZIP extraction and terrain jobs. |
| `CONVERTER_PATH` | Optional explicit PotreeConverter binary path. |

Use `web-uploader/.env.example` as the reference when new variables are added.

---

## 7. Install Application Dependencies

```bash
cd /opt/cloudstudio/web-uploader
npm ci || npm install
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-export.txt
```

Verify Python dependencies:

```bash
/opt/cloudstudio/web-uploader/.venv/bin/python - <<'PY'
import importlib.util
mods = ['numpy', 'laspy', 'pyproj', 'lazrs', 'scipy', 'matplotlib', 'reportlab', 'PIL']
missing = [m for m in mods if importlib.util.find_spec(m) is None]
raise SystemExit('Missing modules: ' + ', '.join(missing) if missing else 'Python dependencies OK')
PY
```

---

## 8. Build or Configure PotreeConverter

If the repository already includes a compatible converter binary, set `CONVERTER_PATH` in `.env`.

If you need to build it on Linux:

```bash
cd /opt/cloudstudio/PotreeConverter
mkdir -p build-gcc
cd build-gcc
cmake ..
cmake --build . --config Release -j"$(nproc)"
```

Then update `.env` if necessary:

```bash
printf '\nCONVERTER_PATH=/opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter\n' >> /opt/cloudstudio/web-uploader/.env
```

Verify:

```bash
/opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter --help || true
```

---

## 9. Start CloudStudio with PM2

```bash
cd /opt/cloudstudio/web-uploader
pm2 start server.js --name cloudstudio --update-env
pm2 save
pm2 startup systemd
```

Follow the command printed by `pm2 startup` if it asks you to run an additional command.

Validate locally on the server:

```bash
curl -s http://127.0.0.1:8090/health
curl -I http://127.0.0.1:8090/viewer
pm2 status cloudstudio
```

---

## 10. Configure Nginx Reverse Proxy

Create `/etc/nginx/sites-available/cloudstudio`:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_SERVER_IP;

    client_max_body_size 8g;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable it:

```bash
ln -sf /etc/nginx/sites-available/cloudstudio /etc/nginx/sites-enabled/cloudstudio
nginx -t
systemctl reload nginx
```

Validate through Nginx:

```bash
curl -I http://YOUR_DOMAIN_OR_SERVER_IP/
curl -s http://YOUR_DOMAIN_OR_SERVER_IP/health
```

---

## 11. Enable HTTPS

If you have a domain pointing to the server, install Certbot:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d YOUR_DOMAIN
systemctl reload nginx
```

Validate:

```bash
curl -I https://YOUR_DOMAIN/
curl -s https://YOUR_DOMAIN/health
```

---

## 12. Post-Deployment Checklist

Run these checks before handing the server to users:

```bash
pm2 status cloudstudio
pm2 logs cloudstudio --lines 50
systemctl status nginx --no-pager
curl -s http://127.0.0.1:8090/health
curl -I http://YOUR_DOMAIN_OR_SERVER_IP/viewer
```

Functional checks:

1. Open the home page.
2. Open `/viewer`.
3. Upload a small LAS/LAZ sample.
4. Confirm conversion creates a browsable point cloud.
5. Open the converted point cloud in the viewer.
6. Run a small export or analysis workflow if your deployment requires those features.
7. Confirm runtime files are written under `/srv/cloudstudio-data`, not under Git-tracked source directories.

---

## 13. Operations Commands

```bash
pm2 status cloudstudio
pm2 restart cloudstudio --update-env
pm2 stop cloudstudio
pm2 logs cloudstudio --lines 100
pm2 save

systemctl status nginx --no-pager
nginx -t
systemctl reload nginx
tail -f /var/log/nginx/error.log
```

---

## 14. Safe Upgrade Summary

For existing servers, do not manually overwrite the whole application without protecting runtime data. Follow `DEPLOY_SOP.md`.

Minimum safe upgrade steps:

1. Back up changed files and `.env`.
2. Confirm `/srv/cloudstudio-data` is not inside the code directory.
3. Sync source code with `rsync` excludes for runtime directories.
4. Run `npm ci || npm install` if `package.json` changed.
5. Run Python dependency updates if `requirements-export.txt` changed.
6. Restart PM2.
7. Check `/health`, Nginx, and PM2 logs.
8. Keep rollback files until the release is accepted.

---

## 15. Troubleshooting

### 15.1 Browser Shows 502 Bad Gateway

Likely cause: Node app is not reachable by Nginx.

```bash
pm2 status cloudstudio
pm2 logs cloudstudio --lines 100
curl -s http://127.0.0.1:8090/health
nginx -t
systemctl reload nginx
```

### 15.2 Upload Fails with 413 Entity Too Large

Increase Nginx upload limit:

```bash
sed -i 's/client_max_body_size .*/client_max_body_size 8g;/' /etc/nginx/sites-available/cloudstudio
nginx -t
systemctl reload nginx
```

### 15.3 Python Analysis Fails

Check Python paths and dependencies:

```bash
cd /opt/cloudstudio/web-uploader
. .venv/bin/activate
python -m pip install -r requirements-export.txt
python -c "import numpy, laspy, pyproj, scipy, matplotlib; print('ok')"
pm2 restart cloudstudio --update-env
```

### 15.4 Conversion Fails

Check converter path and executable permissions:

```bash
grep CONVERTER_PATH /opt/cloudstudio/web-uploader/.env || true
ls -lh /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
chmod +x /opt/cloudstudio/PotreeConverter/build-gcc/PotreeConverter
pm2 restart cloudstudio --update-env
```

### 15.5 Runtime Data Appears in the Code Directory

Confirm `.env` contains:

```bash
CLOUDSTUDIO_DATA_DIR=/srv/cloudstudio-data
```

Then restart:

```bash
pm2 restart cloudstudio --update-env
```

Move accidental runtime data carefully. Do not delete customer data during cleanup.

