# CloudStudio 服务器部署指南

> 适用系统：Ubuntu 22.04 / 24.04 LTS
> 预计总耗时：30–60 分钟

---

## 第一步：在本地打包代码

在你的 Mac 上，打开终端，进入 `cloudstudio-server` 所在目录，执行：

```bash
# 进入 cloudstudio-server 的上级目录（即 potree-local 目录）
cd /你的路径/potree-local

# 打包（排除无需上传的文件）
tar -czf cloudstudio-server.tar.gz \
  --exclude='cloudstudio-server/web-uploader/node_modules' \
  --exclude='cloudstudio-server/web-uploader/.venv' \
  cloudstudio-server/

echo "打包完成，文件大小："
ls -lh cloudstudio-server.tar.gz
```

预计打包后约 **520 MB**。

---

## 第二步：上传到阿里云服务器

```bash
# 上传（替换为你的服务器 IP）
scp cloudstudio-server.tar.gz root@你的服务器IP:/opt/

# 验证上传成功
ssh root@你的服务器IP "ls -lh /opt/cloudstudio-server.tar.gz"
```

网络正常的话，上传 520MB 约需 **5–15 分钟**（取决于你的上行带宽）。

---

## 第三步：在服务器上解压并安装

```bash
# SSH 登录服务器
ssh root@你的服务器IP

# 解压
cd /opt
tar -xzf cloudstudio-server.tar.gz
mv cloudstudio-server /opt/cloudstudio

# 运行一键安装脚本
cd /opt/cloudstudio
bash setup.sh
```

脚本会自动完成：
- 安装 Node.js 18、Python3、cmake、nginx
- 编译 Linux 版 PotreeConverter（约 5–10 分钟）
- 创建 Python 虚拟环境并安装依赖
- 安装 npm 依赖
- 配置 nginx 反向代理
- 用 PM2 启动应用并设置开机自启

---

## 第四步：开放阿里云安全组端口

登录阿里云控制台：
1. 进入 **ECS → 安全组 → 入方向规则**
2. 添加规则：**端口 80**，授权对象 `0.0.0.0/0`（所有人可访问）
3. 如需 SSH，确保 **端口 22** 已开放

---

## 第五步：验证

```bash
# 查看应用状态
pm2 status

# 查看实时日志
pm2 logs cloudstudio --lines 30
```

浏览器访问：`http://你的服务器IP`

---

## 常用运维命令

```bash
# 重启应用
pm2 restart cloudstudio

# 停止应用
pm2 stop cloudstudio

# 查看日志（最近 100 行）
pm2 logs cloudstudio --lines 100

# 查看 nginx 状态
systemctl status nginx

# 查看 nginx 错误日志
tail -f /var/log/nginx/error.log
```

---

## 上传数据文件

部署完成后，通过软件界面上传 LAS/LAZ 文件，或直接用 scp 传到服务器：

```bash
# 上传 LAS 文件（在本地 Mac 执行）
scp /你的路径/colorized.las root@你的服务器IP:/opt/cloudstudio/web-uploader/uploads/

# 上传扫描仪项目（整个文件夹）
scp -r /你的路径/2026-02-27_13-00-27vreman1 root@你的服务器IP:/opt/cloudstudio/scans/
```

扫描仪项目目录建议统一放到 `/opt/cloudstudio/scans/`，然后在软件界面"注册扫描根目录"里添加这个路径。

---

## 故障排查

**问题：访问页面报 502**
→ 应用未启动。执行 `pm2 restart cloudstudio` 并查看 `pm2 logs cloudstudio`

**问题：上传文件失败，报 413 Entity Too Large**
→ nginx 限制。执行：
```bash
sed -i 's/client_max_body_size 4g/client_max_body_size 8g/' /etc/nginx/sites-available/cloudstudio
nginx -s reload
```

**问题：PotreeConverter 编译失败**
→ 缺少依赖。执行：
```bash
apt-get install -y libtbb-dev libboost-all-dev
cd /opt/cloudstudio
bash setup.sh  # 重新运行
```

**问题：DTM/等高线生成失败，报 numpy 相关错误**
→ 系统 Python 缺包。执行：
```bash
pip3 install numpy matplotlib scipy --break-system-packages
```

---

## 目录结构说明

```
/opt/cloudstudio/
├── setup.sh              # 一键安装脚本
├── web-uploader/         # 主应用
│   ├── server.js         # Express 服务器
│   ├── viewer.html       # 3D 查看器前端
│   ├── assets/           # 静态资源（i18n、CRS 数据）
│   ├── scripts/          # Python 处理脚本
│   ├── uploads/          # 用户上传的原始文件（运行时生成）
│   ├── pointclouds/      # 转换后的点云（运行时生成）
│   └── exports/          # 导出文件（运行时生成）
├── potree/               # Potree 3D 渲染库
└── PotreeConverter/      # 点云转换器（setup.sh 编译）
```
