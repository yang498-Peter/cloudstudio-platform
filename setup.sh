#!/bin/bash
# =============================================================
# CloudStudio one-command server installer
# Target OS: Ubuntu 22.04 / 24.04 LTS
# Usage: sudo bash setup.sh
# =============================================================
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$APP_DIR/web-uploader"
CONVERTER_BUILD="$APP_DIR/PotreeConverter/build-gcc"

echo "======================================================"
echo " CloudStudio server installer"
echo " Install directory: $APP_DIR"
echo "======================================================"

echo ""
echo "[1/6] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  curl git cmake build-essential \
  libtbb-dev \
  python3 python3-pip python3-venv \
  nginx \
  lsof \
  unzip

echo ""
echo "[2/6] Installing Node.js 18 if needed..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
  echo "  Node.js $(node -v) installed"
else
  echo "  Node.js $(node -v) already exists; skipping"
fi

echo ""
echo "[3/6] Building PotreeConverter for Linux..."
if [ -f "$CONVERTER_BUILD/PotreeConverter" ]; then
  echo "  PotreeConverter already exists; skipping build"
else
  mkdir -p "$CONVERTER_BUILD"
  cd "$CONVERTER_BUILD"
  cmake "$APP_DIR/PotreeConverter" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CXX_FLAGS="-O2" \
    2>&1 | tail -5
  make -j$(nproc) 2>&1 | tail -5
  cd "$APP_DIR"
  if [ -f "$CONVERTER_BUILD/PotreeConverter" ]; then
    echo "  PotreeConverter built: $CONVERTER_BUILD/PotreeConverter"
  else
    echo "  PotreeConverter build failed"
    echo "  Hint: install libtbb-dev with apt-get install -y libtbb-dev"
    exit 1
  fi
fi

echo ""
echo "[4/6] Preparing Python virtual environment..."
cd "$WEB_DIR"
if [ ! -f ".venv/bin/python" ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip -q
  .venv/bin/pip install -r requirements-export.txt -q
  echo "  Python virtual environment created at .venv/"
else
  echo "  Python virtual environment already exists; updating dependencies"
  .venv/bin/pip install -r requirements-export.txt -q
fi

echo "  Installing auxiliary system Python packages..."
pip3 install numpy matplotlib scipy --quiet --break-system-packages 2>/dev/null || \
pip3 install numpy matplotlib scipy --quiet || true

echo ""
echo "[5/6] Installing Node.js dependencies..."
cd "$WEB_DIR"
npm install --production --silent
echo "  npm install complete"

echo ""
echo "[6/6] Configuring PM2 process manager..."
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --silent
  echo "  PM2 installed"
fi

if [ ! -f "$WEB_DIR/.env" ]; then
  cp "$WEB_DIR/.env.example" "$WEB_DIR/.env"
  echo "  Created .env from .env.example"
fi
if ! grep -q '^CLOUDSTUDIO_ENV=' "$WEB_DIR/.env"; then
  echo 'CLOUDSTUDIO_ENV=production' >> "$WEB_DIR/.env"
  echo "  Set CLOUDSTUDIO_ENV=production"
fi
if ! grep -q '^UPLOAD_REVIEW_PASSWORD_SHA256=' "$WEB_DIR/.env"; then
  UPLOAD_REVIEW_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
  UPLOAD_REVIEW_PASSWORD_HASH="$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$UPLOAD_REVIEW_PASSWORD")"
  echo "UPLOAD_REVIEW_PASSWORD_SHA256=$UPLOAD_REVIEW_PASSWORD_HASH" >> "$WEB_DIR/.env"
  umask 077
  printf '%s\n' "$UPLOAD_REVIEW_PASSWORD" > /root/cloudstudio-upload-password.txt
  umask 022
  echo "  Generated upload password: /root/cloudstudio-upload-password.txt"
fi

echo ""
echo "Configuring Nginx reverse proxy..."
cat > /etc/nginx/sites-available/cloudstudio << 'NGINX_CONF'
server {
    listen 80;
    server_name _;

    client_max_body_size 4g;
    client_body_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_connect_timeout 60s;
    }
}
NGINX_CONF

ln -sf /etc/nginx/sites-available/cloudstudio /etc/nginx/sites-enabled/cloudstudio
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "  Nginx configured"

echo ""
echo "======================================================"
echo " Starting CloudStudio..."
echo "======================================================"
cd "$WEB_DIR"
pm2 delete cloudstudio 2>/dev/null || true
pm2 start server.js --name cloudstudio --interpreter node
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash 2>/dev/null || true

echo ""
echo "======================================================"
echo " CloudStudio installation complete"
echo ""
echo " URL: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo " Status: pm2 status cloudstudio"
echo " Logs: pm2 logs cloudstudio"
echo " Restart: pm2 restart cloudstudio"
echo " Health: curl -s http://127.0.0.1:8090/health"
echo "======================================================"
