#!/bin/bash
# =============================================================
# CloudStudio 服务器一键安装脚本
# 适用于：Ubuntu 22.04 / 24.04 LTS
# 运行方式：sudo bash setup.sh
# =============================================================
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$APP_DIR/web-uploader"
CONVERTER_BUILD="$APP_DIR/PotreeConverter/build-gcc"
DEFAULT_DATA_DIR="${CLOUDSTUDIO_DATA_DIR:-/srv/cloudstudio-data}"

echo "======================================================"
echo " CloudStudio 服务器安装脚本"
echo " 安装目录: $APP_DIR"
echo "======================================================"

# ---------- 1. 系统依赖 ----------
echo ""
echo "[1/6] 安装系统依赖..."
apt-get update -qq
apt-get install -y -qq \
  curl git cmake build-essential \
  libtbb-dev \
  python3 python3-pip python3-venv \
  nginx \
  lsof \
  unzip

# ---------- 2. Node.js 18 ----------
echo ""
echo "[2/6] 安装 Node.js 18..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
  echo "  Node.js $(node -v) 安装完成"
else
  echo "  Node.js $(node -v) 已存在，跳过"
fi

# ---------- 3. 编译 PotreeConverter ----------
echo ""
echo "[3/6] 编译 PotreeConverter (Linux)..."
if [ -f "$CONVERTER_BUILD/PotreeConverter" ]; then
  echo "  PotreeConverter 已编译，跳过"
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
    echo "  PotreeConverter 编译成功: $CONVERTER_BUILD/PotreeConverter"
  else
    echo "  ⚠ 编译失败，请查看上方错误信息"
    echo "  提示：可能缺少 libtbb-dev，运行: apt-get install -y libtbb-dev"
    exit 1
  fi
fi

# ---------- 4. Python 虚拟环境（export/grid 脚本用） ----------
echo ""
echo "[4/6] 配置 Python 虚拟环境..."
cd "$WEB_DIR"
if [ ! -f ".venv/bin/python" ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip -q
  .venv/bin/pip install -r requirements-export.txt -q
  echo "  Python venv 创建完成 (.venv/)"
else
  echo "  Python venv 已存在，更新依赖..."
  .venv/bin/pip install -r requirements-export.txt -q
fi

# 安装 DTM/GC/等高线 脚本依赖（使用系统 python3）
echo "  安装系统 Python 依赖 (numpy, matplotlib, scipy)..."
pip3 install numpy matplotlib scipy --quiet --break-system-packages 2>/dev/null || \
pip3 install numpy matplotlib scipy --quiet || true

# ---------- 5. npm 安装 ----------
echo ""
echo "[5/6] 安装 Node.js 依赖..."
cd "$WEB_DIR"
npm install --production --silent
echo "  npm install 完成"

# ---------- 6. PM2 进程守护 ----------
echo ""
echo "[6/6] 配置 PM2 进程守护..."
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --silent
  echo "  PM2 安装完成"
fi

# 生成 .env（如果不存在）
if [ ! -f "$WEB_DIR/.env" ]; then
  cp "$WEB_DIR/.env.example" "$WEB_DIR/.env"
  cat >> "$WEB_DIR/.env" << ENV_DEFAULTS

# Staging/demo default: keep runtime data outside application code.
CLOUDSTUDIO_DATA_DIR=$DEFAULT_DATA_DIR
ENV_DEFAULTS
  echo "  已生成 .env 文件（可按需修改）"
elif ! grep -Eq '^(CLOUDSTUDIO_DATA_DIR|CLOUDSTUDIO_STORAGE_ROOT)=' "$WEB_DIR/.env"; then
  echo "  提醒：建议在 $WEB_DIR/.env 设置 CLOUDSTUDIO_DATA_DIR=$DEFAULT_DATA_DIR"
fi

if [ -f "$WEB_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$WEB_DIR/.env"
  set +a
fi
ACTIVE_DATA_DIR="${CLOUDSTUDIO_DATA_DIR:-${CLOUDSTUDIO_STORAGE_ROOT:-$DEFAULT_DATA_DIR}}"
mkdir -p \
  "$ACTIVE_DATA_DIR/uploads" \
  "$ACTIVE_DATA_DIR/pointclouds" \
  "$ACTIVE_DATA_DIR/gaussians" \
  "$ACTIVE_DATA_DIR/projects" \
  "$ACTIVE_DATA_DIR/exports" \
  "$ACTIVE_DATA_DIR/cache"

# ---------- 配置 nginx ----------
echo ""
echo "配置 nginx..."
cat > /etc/nginx/sites-available/cloudstudio << 'NGINX_CONF'
server {
    listen 80;
    server_name _;

    # 允许大文件上传（LAS 文件可能很大）
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

        # 超时设置（点云处理可能需要数分钟）
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_connect_timeout 60s;
    }
}
NGINX_CONF

ln -sf /etc/nginx/sites-available/cloudstudio /etc/nginx/sites-enabled/cloudstudio
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "  nginx 配置完成"

# ---------- 启动应用 ----------
echo ""
echo "======================================================"
echo " 启动 CloudStudio..."
echo "======================================================"
cd "$WEB_DIR"
if [ -f "$WEB_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$WEB_DIR/.env"
  set +a
fi
pm2 delete cloudstudio 2>/dev/null || true
pm2 start server.js --name cloudstudio --interpreter node --update-env
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash 2>/dev/null || true

echo ""
echo "======================================================"
echo " ✅ 安装完成！"
echo ""
echo " 访问地址: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo " 应用状态: pm2 status"
echo " 实时日志: pm2 logs cloudstudio"
echo " 重启应用: pm2 restart cloudstudio"
echo "======================================================"
