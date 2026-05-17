# CloudStudio 更新发布与生产维护 SOP（Jarvis）

## 目标
将本地 `potree-local/cloudstudio-server` 的最新代码安全发布到生产服务器，并在**不误伤历史数据**的前提下完成巡检、清理、回滚与稳定性控制。

---

## 0. 生产维护核心原则（今天之后固定执行）

### 0.1 先分流：这台服务器是“轻量 Web 端”，不是高计算工作站
生产服务器的默认定位应是：
- 浏览
- 展示
- 查询
- 轻量交互

默认**不承载高计算量任务**。复杂计算应优先在：
- 本地版本
- 或更高性能机器
执行。

### 0.2 一切改动优先走“本地先改，再上传”
以后凡涉及：
- `server.js`
- 大型前端页面
- 多接口改动
- 稳定性修复
- 高风险功能封禁

都必须遵循：
1. **先把服务器当前可用文件拉回本地作为基线**
2. **在本地修改**
3. **先做本地确认/差异核对**
4. **只上传改过的文件**
5. **重启并验收**

### 0.3 禁止在生产长文件上直接做高风险在线手术
已经踩过一次坑：在线改 `server.js` 时引入语法错误，直接导致站点 502。

结论：
- 小文件小改可考虑热修
- 长文件多段修改，**禁止直接在线改**

### 0.4 出问题优先回滚单文件，不要乱试
如果改完后：
- `localhost:8090` 不起
- 外网 502
- PM2 看着 online 但服务不可达

优先动作：
1. 找最近热更新备份
2. 回滚单文件（通常先回滚 `server.js`）
3. `pm2 restart cloudstudio`
4. 验证恢复

不要在故障状态下继续叠加补丁。

---

## 1. 发布策略（必须先判断）

### 1.1 默认优先：小改动热更新（最小变更）
当用户已明确“只改了哪些文件”时：
- 仅上传这些文件
- 重启 `cloudstudio`
- 验收

例如：
- `web-uploader/server.js`
- `web-uploader/viewer.html`
- `web-uploader/index.html`
- `assets/i18n/*.json`
- 某个 feature JS 文件

### 1.2 仅在这些场景做全量同步/定向整包同步
- 用户明确要求全量升级
- 本地与线上结构差异较大
- 多目录同时变动，不适合逐文件传输
- 需要建立完整新版本基线

### 1.3 明确禁止事项
- 用户说“只传 2 个文件”时，擅自整包覆盖
- 未做数据保护就整目录同步
- 覆盖 `.env`
- 覆盖运行时数据目录
- 在线直接手改大型 `server.js` 再赌运气

---

## 2. 服务器信息（当前固定）
- Host: `47.253.63.0`
- User: `root`
- SSH key: `~/.ssh/openclaw_cloudstudio_ed25519`
- 生产代码目录：`/opt/cloudstudio`
- Web 应用目录：`/opt/cloudstudio/web-uploader`
- PM2 进程：`cloudstudio`
- Nginx 反代：`127.0.0.1:8090`
- 外网域名：`https://lidar361.com`

---

## 3. 升级前必须先做的只读勘察
先确认以下内容：

### 3.1 当前部署路径与启动方式
- `pm2 status cloudstudio`
- `pm2 describe cloudstudio`
- `systemctl is-active nginx`
- `cat /etc/nginx/sites-available/cloudstudio`

### 3.2 当前数据目录与代码目录边界
重点确认并保护：
- `web-uploader/uploads/`
- `web-uploader/pointclouds/`
- `web-uploader/projects/`
- `web-uploader/exports/`
- `web-uploader/cache/`
- `web-uploader/dtm_jobs/`
- `web-uploader/contour_jobs/`
- `web-uploader/surface_jobs/`
- `web-uploader/volume_surface_jobs/`
- `.env`
- `scan_roots.json`

### 3.3 升级前健康检查
```bash
curl -s http://localhost:8090/health
curl -I https://lidar361.com
```

---

## 4. 升级前备份规则

### 4.1 最少备份项
至少备份：
- `server.js`
- `viewer.html`
- `index.html`
- `package.json`
- `package-lock.json`
- `requirements-export.txt`
- `.env`
- Nginx 配置
- PM2 dump

### 4.2 推荐备份路径
- `/opt/cloudstudio/web-uploader/backups/preupgrade-YYYYmmdd-HHMMSS/`
- `/opt/cloudstudio/backups/preupgrade-YYYYmmdd-HHMMSS/`

### 4.3 热更新也要留单文件回滚点
每次重要热更新前，至少保留：
- `backups/code-hotdeploy-YYYYmmdd_HHMMSS/server.js`
- 必要的前端文件备份

---

## 5. 同步边界（极重要）

### 5.1 可以同步的内容
通常包括：
- `web-uploader/server.js`
- `web-uploader/index.html`
- `web-uploader/viewer.html`
- `web-uploader/assets/`
- `web-uploader/scripts/`
- `web-uploader/assets/app/`
- `web-uploader/package.json`
- `web-uploader/package-lock.json`
- `web-uploader/requirements-export.txt`
- `potree/`
- `PotreeConverter/`（仅确有必要）

### 5.2 严禁误覆盖的内容
绝不能直接覆盖：
- `uploads/`
- `pointclouds/`
- `projects/`
- `exports/`
- `cache/`
- `dtm_jobs/`
- `contour_jobs/`
- `surface_jobs/`
- `volume_surface_jobs/`
- `.env`
- `scan_roots.json`

### 5.3 推荐同步方式
优先使用：
- `scp` 逐文件热更新（少量文件）
- `rsync + exclude`（多文件但要保护数据）

避免：
- `rm -rf` 后全量覆盖
- 直接整目录清空

---

## 6. 快速热更新（推荐默认路径）

```bash
cd /Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server

scp -i ~/.ssh/openclaw_cloudstudio_ed25519 web-uploader/server.js root@47.253.63.0:/opt/cloudstudio/web-uploader/server.js
scp -i ~/.ssh/openclaw_cloudstudio_ed25519 web-uploader/viewer.html root@47.253.63.0:/opt/cloudstudio/web-uploader/viewer.html
scp -i ~/.ssh/openclaw_cloudstudio_ed25519 web-uploader/index.html root@47.253.63.0:/opt/cloudstudio/web-uploader/index.html

ssh -i ~/.ssh/openclaw_cloudstudio_ed25519 root@47.253.63.0 '
set -e
cd /opt/cloudstudio/web-uploader
pm2 restart cloudstudio
pm2 save
sleep 3
curl -s http://localhost:8090/health
'
```

> 只改了几个文件，就只传几个文件。

---

## 7. 全量/定向同步（仅必要时）

推荐：
- 基于本地目录 `potree-local/cloudstudio-server`
- 用 `rsync -az --delete + --exclude` 同步
- 明确排除所有运行时数据目录和 `.env`

同步完成后：
- `npm install`
- 必要时 `./.venv/bin/pip install -r requirements-export.txt`
- `pm2 restart cloudstudio`

---

## 8. 验收门（每次必做）

### 8.1 本机健康
```bash
curl -s http://localhost:8090/health
```

### 8.2 外网健康
```bash
curl -I https://lidar361.com
```

### 8.3 必测接口
至少测：
```bash
curl -s http://localhost:8090/api/clouds
curl -s http://localhost:8090/api/grids
curl -s "http://localhost:8090/api/crs/search?q=4326"
```

### 8.4 修改过的功能专项验证
例如：
- 改了页面 → 验首页 / viewer
- 改了禁用接口 → 逐个 POST 验证 errorCode
- 改了数据识别逻辑 → 验历史项目仍在

---

## 9. 清理与巡检 SOP（今天新增）

### 9.1 清理前原则
先做只读盘点，再删。

优先盘点：
- `du -sh pointclouds/*`
- `du -sh projects/*`
- `du -sh backups/*`
- 缺 `metadata.json` 的点云目录
- 无 matching project 且不在 API 暴露列表中的目录

### 9.2 可低风险清理对象
- `.DS_Store`
- `index-old-*`
- 小型旧热更新备份
- 确认无效的孤儿目录

### 9.3 中风险清理对象
需要先确认再删：
- 大体积备份
- 无 metadata 且无 project 且无 API 暴露的孤儿点云

### 9.4 清理后必须复查
```bash
df -h /
curl -s http://localhost:8090/health
curl -I https://lidar361.com
```

---

## 10. 故障恢复 SOP（今天新增，必须记住）

### 10.1 症状：外网超时 / SSH 抖动 / 控制台卡顿
优先怀疑：
- 重计算任务拖死服务
- 应用层卡死，不一定是整机关机

先查：
```bash
pm2 status cloudstudio
curl -sS http://localhost:8090/health
systemctl is-active nginx
ss -ltnp | grep -E '(:80 |:443 |:8090 )'
```

### 10.2 如果刚跑过体积/地形/分类任务后挂了
优先怀疑高计算任务拖死服务器。

### 10.3 如果是代码改挂
典型特征：
- nginx 正常
- 8090 不监听
- PM2 看似 online
- 实际外网 502
- error log 出现 `SyntaxError`

恢复步骤：
1. 找最近热更新备份
2. 回滚 `server.js`
3. `pm2 restart cloudstudio`
4. 验证 `/health` 与外网

### 10.4 已验证可用的快速回滚路径
这次有效回滚文件：
- `backups/code-hotdeploy-20260328_195541/server.js`

---

## 11. 生产稳定模式（今天新增，长期有效）

### 11.1 这台生产服务器默认禁用的高风险接口
当前已封禁：
- `/api/generate-volume-surface`
- `/api/generate-dtm`
- `/api/generate-surface`
- `/api/generate-contours`
- `/api/classify-ground`
- `/api/classify-rule-based`
- `/api/run-semantic-pipeline`
- `/api/generate-hag`
- `/api/compute-geometric-features`
- `/api/segment-individual-trees`
- `/api/forestry/prepare`
- `/api/forestry/detect-stems`

### 11.2 首页提示策略
首页应低干扰提示：
- Web 端主要用于浏览、展示、查询
- 复杂计算请下载本地版本
- 该提示需接入多语言

### 11.3 后续新增重计算功能时
默认先问自己：
- 这会不会拖死当前服务器？
- 是否应该默认只放到本地版？
- 是否应该在生产版直接返回 disabled？

---

## 12. 今日关键教训（必须记住）
1. **先在本地改，再上传**，比在线长文件手改安全太多。
2. **生产服务器不是工作站**，重计算一律保守处理。
3. **单文件回滚非常重要**，尤其是 `server.js`。
4. **小改热更新优先**，用户点名只传几个文件时，不要擅自全量覆盖。
5. **数据目录必须永远保护**，代码升级和数据保护必须分开。
6. **事故复盘必须进 SOP**，否则下次还会重复踩坑。
