# CloudStudio 3DGS / SuperSplat 接入记录

## 目标

CloudStudio 基于 MVP S1 扫描仪点云平台继续扩展 3D Gaussian Splatting 浏览能力。目标是让用户像上传点云一样上传 MVPS1 生成的 3DGS 模型，并在网页端得到可分享、流畅、接近桌面端体验的浏览链接。

本轮选择 SuperSplat / PlayCanvas SOG 作为第一阶段落地方案：保留现有 GaussianSplats3D 旧 viewer 作为 fallback，同时新增服务端自动转换发布包。

## 本轮改动

- 在 `web-uploader` 中安装 `@playcanvas/splat-transform@2.0.3`。
- `/api/upload-gaussian` 从“保存单个文件并直接浏览”升级为：
  - 接收 `.ply / .splat / .ksplat`。
  - 保存原始文件到 `gaussians/<scene>/scene.<ext>`。
  - 自动运行 `splat-transform -g cpu -U -E settings.json ...`。
  - 生成 SuperSplat / PlayCanvas viewer 包到 `gaussians/<scene>/supersplat/`。
  - 更新 `source.json`，记录转换状态、输出文件、耗时、源文件大小、网页包大小和 viewer URL。
- 新增 `/api/import-local-gaussian`，用于从本机测试目录导入大文件，避免浏览器重复上传 849MB 测试数据。
  - 默认允许目录：`/Users/yangqi/Downloads/robin`
  - 本轮测试数据：`/Users/yangqi/Downloads/robin/gs.ply`
- 首页列表增强：
  - 3DGS 项目显示 `SuperSplat SOG` 状态。
  - 显示源文件大小与网页包大小。
  - 打开按钮指向新的 SuperSplat viewer。
  - 修复 Gaussian 删除时缺少 `data-resource-type` 的问题。
- 文案更新：
  - Gaussian 上传说明从实验性 PLY viewer 改为 SuperSplat / PlayCanvas SOG 发布流程。

## 当前数据结构

```text
web-uploader/
  gaussians/
    <scene-name>/
      scene.ply              # 原始上传或本地导入文件
      source.json            # CloudStudio manifest
      supersplat/
        index.html           # SuperSplat viewer 入口
        index.js             # PlayCanvas/SuperSplat viewer runtime
        index.css
        settings.json
        scene.sog            # SOG 压缩发布文件
```

## 关键命令

安装依赖：

```bash
cd /Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader
npm install @playcanvas/splat-transform@2.0.3
```

快速验证转换器：

```bash
npx splat-transform --version
```

小文件转换探针：

```bash
npx splat-transform -g cpu -U -w /Users/yangqi/Downloads/robin/sky.ply /private/tmp/cloudstudio-sog-probe/sky.html
```

本地导入测试数据：

```bash
curl -s -X POST http://127.0.0.1:8090/api/import-local-gaussian \
  -H 'Content-Type: application/json' \
  -d '{"sourcePath":"/Users/yangqi/Downloads/robin/gs.ply","name":"robin-supersplat"}'
```

## 本轮实测结果

小文件冒烟测试：

- 输入：`/Users/yangqi/Downloads/robin/sky.ply`
- 输入大小：约 5.3MB
- Gaussian 数量：约 100K
- 输出：`gaussians/sky-supersplat-smoke/supersplat/`
- `scene.sog`：约 1.2MB
- 总网页包：约 4.1MB
- CPU 转换耗时：约 1.6 秒

正式测试数据：

- 输入：`/Users/yangqi/Downloads/robin/gs.ply`
- 输入大小：`890,464,204` bytes，约 849MB
- Gaussian 数量：约 15.9M
- 输出：`gaussians/robin-supersplat/supersplat/`
- `scene.sog`：`183,149,794` bytes，约 174.7MB
- 总网页包：`185,995,485` bytes，约 177.4MB
- CPU 转换耗时：约 55.6 秒
- 峰值内存：约 1.94GB
- 本地 viewer URL：
  - `http://127.0.0.1:8090/gaussians/robin-supersplat/supersplat/index.html?content=scene.sog&settings=settings.json&aa=&webgpu=`

浏览器验证：

- Playwright 打开 viewer 成功，页面标题为 `robin-supersplat - CloudStudio 3DGS`。
- 控制台显示 `SuperSplat Viewer v1.21.0 | Engine v2.18.1`。
- 控制台显示渲染器为 `webgpu, compute`。
- 截图确认画布已渲染 robin 场景，不是空白页。
- 当前初始相机偏近、画面偏暗，后续需要根据场景包围盒自动设置相机和背景/曝光。

## 选型记录

SuperSplat / SOG 的定位：

- 更适合第一阶段产品化落地。
- 官方 viewer 界面完整，具备轨道/飞行模式、设置、全屏、移动端触控等交互。
- SOG 是 PlayCanvas 推荐的 Web 交付格式，比原始 PLY 更适合网页分享。
- 可以后续继续接裁剪、清理、压缩参数、质量档位。

Spark 2.0 的定位：

- 更像下一代高性能渲染与 LOD/streaming 引擎。
- 后续如果要追求接近 LCC 的超大场景体验，仍需要单独验证 Spark 2.0 / RAD 路线。

## 待优化

- 当前 `splat-transform` 使用 `-g cpu`，本机和服务器都不依赖 GPU，但大模型转换会耗时。后续可评估服务器 GPU / WebGPU 可用性。
- 当前生成的是单场景 SOG viewer，不是真正多级 LOD。后续需要继续研究 LCC 输入转 `lod-meta.json` 或 Spark RAD。
- 需要为转换任务做异步队列、进度轮询、失败重试，避免大文件上传请求长时间阻塞。
- 需要增加缩略图生成、质量档位、自动裁剪/清理、移动端默认性能模式。
- 正式上线前需要把 3DGS 项目纳入账号、权限、分享链接和管理后台。

## 2026-05-03 复盘：官方 SuperSplat Editor 的关键差异

老板在 `https://superspl.at/editor` 直接导入 `/Users/yangqi/Downloads/robin/gs.ply`，约三四秒即可本地打开，效果符合预期；正确轴向为 `rotate=90,0,180`。

这说明前一版 CloudStudio 接入路线绕远了：

- 官方 editor 的本地导入不是先上传到云端服务器转换。
- 浏览器通过文件选择/拖拽拿到本地 `File` / `Blob`，数据仍留在用户本机浏览器沙箱内。
- SuperSplat 源码用 `@playcanvas/splat-transform` 的浏览器能力读取 PLY，并直接创建 PlayCanvas Gaussian Splat 资源。
- 这条链路适合“本地快速预览/调参/确认轴向”，不应该经过 Node 上传、服务端复制、SOG 转换、再打开 viewer。

当前 CloudStudio 服务端方案仍有价值，但定位应调整：

- 本地预览：前端直读本地 PLY，快速打开，默认应用 `rotate=90,0,180`，用于确认效果、轴向、裁剪和封面。
- 发布分享：用户确认后再上传到 CloudStudio/服务器，服务端生成可分享的 SOG 或 LOD 包。
- 客户链接：不能依赖客户本地文件，需要服务器托管转换后的资源。

下一步优先方案：

- 在 CloudStudio 新增“本地 3DGS 快速预览”入口，尽量复用官方 SuperSplat editor/viewer 的前端加载方式。
- 上传发布改成第二步，不再把“本地预览”和“云端发布”混成一个长流程。
- 默认 viewer 旋转参数设为 `rotate=90,0,180`。
- 继续保留服务端 `splat-transform` 发布能力，但作为发布/分享管线，不作为本地预览的唯一入口。

## 2026-05-03 实现：CloudStudio 本地 3DGS 快速预览

本次已按上述复盘改成本地直读预览路线：

- 新增本地预览页：
  - `web-uploader/assets/gaussian-local-preview.html`
  - 入口：`http://127.0.0.1:8091/assets/gaussian-local-preview.html`（当前测试服务端口）
  - 选择 PLY / SPLAT / KSPLAT 后使用 `URL.createObjectURL(file)` 生成浏览器 Blob URL，不上传服务器。
- 新增本地 SuperSplat viewer 资源：
  - `web-uploader/assets/supersplat-local-viewer/index.html`
  - `web-uploader/assets/supersplat-local-viewer/index.js`
  - `web-uploader/assets/supersplat-local-viewer/index.css`
  - `web-uploader/assets/supersplat-local-viewer/settings.json`
- 首页 3DGS / Gaussian 面板新增“先本地快速预览”入口，上传发布保留为第二步。
- 默认旋转为 `rotate=90,0,180`。
- 渲染器选择新增 Auto：真实浏览器有 WebGPU adapter 时走 WebGPU；没有 adapter 时避免误传 `webgpu` 参数。

验证结果：

- 使用本地测试文件 `/Users/yangqi/Downloads/robin/gs.ply`，大小约 849MB。
- Playwright 自动选择本地文件后，页面状态显示：
  - `正在本地预览：gs.ply (849.2 MB)。文件未上传服务器。`
  - iframe URL 中 `content=blob:http://127.0.0.1:8091/...`，确认是浏览器 Blob 直读，不是服务端上传。
- Headless Chromium 无 WebGPU/WebGL，不能用于画面质量判断。
- 有界面 Chromium 验证成功，控制台输出：
  - `SuperSplat Viewer v1.21.0 | Engine v2.18.1`
  - `Renderer: webgpu, compute`
- 这个结果与老板在官方 `https://superspl.at/editor` 中看到的体验一致。

后续产品路线：

- 本地预览用于快速检查效果、方向、质量。
- 发布分享仍走服务端上传/转换/托管，客户链接不能依赖用户本地 Blob。
- 下一步可把本地预览页视觉整合进 CloudStudio 主界面，并加“确认效果后发布”按钮，把当前 Blob 对应的原文件上传到发布管线。

## 2026-05-05 交接说明：新 Agent 接手必读

本文件是 CloudStudio 3DGS / SuperSplat 工作流的项目交接入口。新的 agent 或 OpenClaw 替代执行者接手时，先读本文件，再读工作区记忆。目标是让新 agent 能像 OpenClaw / Jarvis 一样继续管理本地项目、记忆、服务器和后续任务，而不是只看当前聊天上下文。

### 角色与工作方式

- 用户称呼：叫用户“老板”。
- 助手身份：Jarvis / OpenClaw 式工作助手，负责理解上下文、执行本地开发、服务器运维、写记录、持续更新记忆。
- 默认工作方式：本机开发和验证优先，服务器只部署确认可跑的版本。
- 重要事项要写入：
  - 当日流水：`/Users/yangqi/.openclaw/workspace/memory/YYYY-MM-DD.md`
  - 当前恢复缓冲：`/Users/yangqi/.openclaw/workspace/memory/working-buffer.md`
  - 稳定长期记忆：`/Users/yangqi/.openclaw/workspace/MEMORY.md`
- 不要把明文密码写入 repo、MD 文档或普通记忆；服务器密码如需查找，应使用已记录的 Keychain 服务名。

### 启动时读取顺序

新的 agent 接手 CloudStudio / 点云平台任务时，建议按这个顺序读：

1. `/Users/yangqi/.openclaw/workspace/AGENTS.md`
2. `/Users/yangqi/.openclaw/workspace/MEMORY.md`
3. `/Users/yangqi/.openclaw/workspace/memory/working-buffer.md`
4. 最近的 daily memory，例如：
   - `/Users/yangqi/.openclaw/workspace/memory/2026-05-01.md`
   - `/Users/yangqi/.openclaw/workspace/memory/2026-05-02.md`
   - 当天的 `/Users/yangqi/.openclaw/workspace/memory/YYYY-MM-DD.md`
5. 本文件：`/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/CloudStudio_3DGS_SuperSplat_接入记录.md`
6. 如涉及部署，再读：
   - `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/DEPLOY_SOP.md`
   - `/Users/yangqi/.openclaw/workspace/skills/cloudstudio-deploy-guardrails/SKILL.md`

注意：`DEPLOY_SOP.md` 中有旧服务器 `47.253.63.0 / lidar361.com` 的历史内容。以最新 `MEMORY.md` 和 `working-buffer.md` 为准：旧美国服务器目前不要默认使用；当前临时 CloudStudio 服务器是 `8.209.66.134`。

### 当前本地项目位置

- CloudStudio 项目根目录：
  - `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server`
- Web app 目录：
  - `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader`
- 主要代码：
  - `web-uploader/server.js`
  - `web-uploader/index.html`
  - `web-uploader/assets/i18n/zh-CN.json`
  - `web-uploader/assets/i18n/en.json`
- 3DGS 本地预览页：
  - `web-uploader/assets/gaussian-local-preview.html`
- 本地 SuperSplat viewer 资源：
  - `web-uploader/assets/supersplat-local-viewer/`
- 本地测试数据：
  - `/Users/yangqi/Downloads/robin/gs.ply`
  - `/Users/yangqi/Downloads/robin/sky.ply`

### 当前 3DGS 功能状态

已经完成两条链路：

1. 服务端上传/转换/发布链路
   - `/api/upload-gaussian` 支持 `.ply / .splat / .ksplat`。
   - 服务端用 `@playcanvas/splat-transform@2.0.3` 生成 SuperSplat / SOG viewer 包。
   - `/api/import-local-gaussian` 可从本机测试目录导入大 PLY，避免浏览器重复上传。
   - 这条链路适合后续做“确认后发布分享链接”。

2. 本地快速预览链路
   - `assets/gaussian-local-preview.html` 通过浏览器 `File` / `Blob` 直读本地 PLY。
   - 文件不上传服务器，体验接近官方 `https://superspl.at/editor`。
   - 默认旋转参数是 `rotate=90,0,180`。
   - 这条链路适合老板先检查模型效果、方向、质量，再决定是否上传发布。

当前判断：本地预览是正确的第一步，服务端 SOG 发布是第二步；不要再把“快速预览”和“云端发布”混成一个长阻塞流程。

### 本地验证方式

常见本地启动方式是运行项目已有脚本：

```bash
cd /Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader
./start-local.command
```

之前测试端口出现过 `8090` 和 `8091`，以实际启动输出和 `/health` 为准：

```bash
curl -s http://127.0.0.1:8090/health
curl -s http://127.0.0.1:8091/health
```

本地 3DGS 快速预览页通常为：

```text
http://127.0.0.1:8091/assets/gaussian-local-preview.html
```

如果端口是 8090，则改为：

```text
http://127.0.0.1:8090/assets/gaussian-local-preview.html
```

验证重点：

- 选择 `/Users/yangqi/Downloads/robin/gs.ply`。
- 页面应显示“文件未上传服务器”。
- iframe 的 `content` 参数应是 `blob:http://127.0.0.1:...`。
- 有界面浏览器应输出 SuperSplat viewer / PlayCanvas engine 信息。
- Headless Chromium 可能没有 WebGPU/WebGL，不能作为画质最终判断。

### 当前服务器信息

当前临时线上调试服务器：

- 公网地址：`http://8.209.66.134`
- SSH alias：`cloudstudio-new`
- 用户：`root`
- SSH key：`~/.ssh/openclaw_cloudstudio_ed25519`
- 服务器代码目录：`/opt/cloudstudio`
- 服务器 Web app：`/opt/cloudstudio/web-uploader`
- PM2 app：`cloudstudio`
- 内部端口：`127.0.0.1:8090`
- Nginx：公网 80 反代到 `127.0.0.1:8090`
- 健康检查：`http://8.209.66.134/health`
- 密码元数据：`/Users/yangqi/.openclaw/credentials/cloudstudio-new-server.json`
- 密码 Keychain service：`openclaw-cloudstudio-8.209.66.134`

服务器维护原则：

- 默认不要直接在服务器上改业务代码。
- 默认先在本机改、测试、记录，再同步到服务器。
- 同步时保护 `.env` 和运行时数据目录：
  - `uploads/`
  - `projects/`
  - `pointclouds/`
  - `gaussians/`
  - `exports/`
  - `cache/`
  - `*_jobs/`
- 旧美国服务器 `47.253.63.0 / lidar361.com` 目前不要默认使用，老板说可能已交给同事或被改动。

### 推荐下一步任务

下一位 agent 若收到“继续优化 3DGS / SuperSplat”的指令，建议优先做：

1. 把本地快速预览页视觉整合进 CloudStudio 首页或 3DGS 面板，不要只作为孤立页面。
2. 增加“确认效果后发布”按钮：从本地预览页把当前选择的文件送入上传/转换/发布链路。
3. 给 3DGS 发布做异步任务队列、进度轮询、失败日志和重试，不要让大文件请求长时间阻塞。
4. 做自动相机 framing、背景/曝光默认值、移动端性能模式。
5. 继续评估 Spark 2.0 / RAD 或真正 LOD/streaming 方案，用于未来接近 LCC 的大场景体验。
6. 后续产品化接入账号、权限、项目管理、分享链接、管理后台和磁盘用量统计。

### 交接注意事项

- 不要删除本地已有运行数据和测试数据。
- 不要误把本地 `/Users/yangqi/Downloads/robin/gs.ply` 上传到公网，除非老板明确要求。
- 不要宣称“客户可流畅浏览”直到真实公网、普通电脑、手机都测过。
- 不要盲目 `npm audit fix`，当前 `multer 1.x` 安全提示要单独做兼容升级测试。
- 文档更新优先写中文，确保老板和后续 agent 都能读懂。

## 2026-05-05 优化：3DGS 首页上传到浏览完整链路

本次按老板要求，把 3DGS 浏览链路从“实验入口很多参数”收拢成产品型流程：

- 首页 3DGS 面板主流程改为：
  - 选择 `.ply / .splat / .ksplat`
  - 填可选场景名
  - 填上传密码
  - 点击“上传并打开浏览”
  - 上传和转换完成后显示“打开浏览”结果按钮
- 本地预览入口保留，但降级为辅助动作“本地预览方向”，不再占据主流程。
- 上传进度文案从 PotreeConverter 泛用文案改为 3DGS 发布文案：
  - `正在发布 3DGS 浏览包`
  - `正在生成 SuperSplat 网页浏览包`
- 3DGS viewer 默认隐藏非必要按钮：
  - 隐藏 SuperSplat branding
  - 隐藏 info / settings / ministats 面板
  - 保留相机浏览模式、全屏等关键浏览控件
- 本地快速预览页简化：
  - 主界面只保留文件选择、打开浏览、清空、返回首页
  - 方向和性能放进折叠项
  - 默认方向仍为 `rotate=90,0,180`
  - 默认性能为“流畅”
- 服务端默认 LOD budget 上限从 24M 调整为 10M，避免大模型默认打开过重；仍可通过环境变量 `GAUSSIAN_MAX_AUTO_LOD_BUDGET_M` 覆盖。
- `/api/upload-gaussian` 成功响应补充 `originalBytes`，方便首页结果卡显示源文件大小。

验证记录：

- `node --check server.js` 通过。
- `zh-CN.json` / `en.json` JSON 解析通过。
- 本地服务临时启动：
  - `http://127.0.0.1:8092`
  - `http://127.0.0.1:8093`（测试上传密码专用）
- 首页、3DGS 本地预览页均返回 `200 OK`。
- 用 `/Users/yangqi/Downloads/robin/sky.ply` 跑通服务端本地导入：
  - 项目：`sky-3dgs-flow-check`
  - 输出 viewer：`/gaussians/sky-3dgs-flow-check/supersplat/index.html?...`
  - 转换成功，`publish.status=ready`
- 用同一个 `sky.ply` 跑通真实 multipart 上传接口：
  - 项目：`sky-3dgs-upload-check`
  - 接口：`/api/upload-gaussian`
  - 转换成功，`publish.status=ready`
- Playwright 打开 `sky-3dgs-flow-check` viewer 成功：
  - 页面标题：`sky-3dgs-flow-check - CloudStudio 3DGS`
  - 控制台：`SuperSplat Viewer v1.21.0`
  - 控制台：`Renderer: webgpu, compute`
  - 截图确认画面非空白。
- 临时测试服务 8092 / 8093 已停止。

后续建议：

- 下一步应把大模型上传改成异步任务队列和进度轮询。当前接口能跑通，但大 PLY 仍可能让请求等待较久。
- 针对 `robin-supersplat` 这类大模型，建议重新发布一次以应用新的默认 10M budget；旧项目 manifest 仍保留原先 `budget=16` 的 viewer URL。
- 部署到服务器前，同步这些文件并保护运行时目录：
  - `web-uploader/server.js`
  - `web-uploader/index.html`
  - `web-uploader/assets/gaussian-local-preview.html`
  - `web-uploader/assets/supersplat-local-viewer/index.css`
  - `web-uploader/assets/i18n/zh-CN.json`
  - `web-uploader/assets/i18n/en.json`

### 2026-05-05 补丁：统一 3DGS 浏览入口

老板上传 `gs.ply` 命名为 `newrobin` 后发现打开链接仍是 `/gaussians/newrobin/supersplat/index.html?...`，这说明底层虽已是 SuperSplat LOD 包，但产品入口还暴露了内部静态 viewer 路径。

已修正：

- 新增统一浏览入口：`/3dgs/:assetName`
  - 例如：`http://127.0.0.1:8092/3dgs/newrobin`
  - 页面由 CloudStudio 包装，内部用 iframe 加载底层 SuperSplat/LOD viewer。
  - 顶部显示场景名、源文件大小、网页包大小、返回首页和原始视图。
- `/api/clouds` 对 `publish.status=ready` 的 3DGS 项目统一返回 `/3dgs/<name>`。
- 新上传项目的 `viewerUrl` 也会写成 `/3dgs/<name>`。
- 底层 `/gaussians/<name>/supersplat/index.html?...` 仍保留作为内部实际渲染地址和调试入口，不再作为首页主按钮。

验证：

- `node --check server.js` 通过。
- `newrobin` 的 `/api/clouds` 返回：
  - `"viewerUrl":"/3dgs/newrobin"`
- `curl -I http://127.0.0.1:8092/3dgs/newrobin` 返回 `200 OK`。

### 2026-05-05 复盘：默认 LOD 链路导致 newrobin 卡顿和块缺失

老板反馈 `newrobin` 打开后仍然很卡，并且远处块缺失。截图显示的是 `/3dgs/newrobin` 内部加载 `lod-meta.json` 后的结果。

原因判断：

- 官方 `https://superspl.at/editor` 拖入 PLY 的体验，本质是浏览器直接读取本地 `File/Blob` 原始 PLY。
- 本地 CloudStudio 上传发布后默认走的是 `lod-meta.json + chunk + budget` 的网页包链路。
- 对 `newrobin` 这种 849MB / 15.9M splats 数据，默认 `budget=10` 和当前 LOD/chunk 策略会造成：
  - 只渲染部分 splats；
  - 某些块在视角/预算限制下不显示；
  - 画面出现黑色缺洞；
  - 体验反而不如官方 editor 的直读 PLY。

已修正方向：

- `/3dgs/:assetName` 默认改为“完整 PLY 直读模式”：
  - iframe 加载 `/assets/supersplat-local-viewer/index.html`
  - `content=/gaussians/<assetName>/scene.ply`
  - `settings=/gaussians/<assetName>/supersplat/settings.json`
  - `rotate=90,0,180`
- `?mode=lod` 才进入 LOD 网页包实验模式。
- 当前运行中的 `newrobin/source.json` 已临时改为 raw PLY 直读 URL，因此刷新 `http://127.0.0.1:8092/3dgs/newrobin` 应直接进入完整质量模式。
- 代码层面已改好；但当前 8092 进程需要重启后，所有后续新上传项目才会自动默认 raw PLY 直读。

### 2026-05-05 再修正：接入官方 SuperSplat Editor 2.25.0

老板继续反馈：即便 raw PLY 直读，当前 CloudStudio 的体验仍不如 `https://superspl.at/editor`。进一步对比后确认：

- 官方网页使用的是完整 SuperSplat Editor 应用，不是 `splat-transform -w` 导出的 SuperSplat Viewer。
- 官方 editor 的导入链路是：
  - `File/Blob` 或 URL
  - `MappedReadFileSystem`
  - `loadGSplatData`
  - `GSplatResource`
  - editor 场景管理、相机和渲染管线
- CloudStudio 之前使用的是导出 viewer 包，缺少 editor 的完整应用逻辑。

本次处理：

- 拉取并构建官方 SuperSplat Editor：
  - 源码：`https://github.com/playcanvas/supersplat`
  - 版本：`2.25.0`
  - 本地构建目录：`/private/tmp/supersplat/dist`
- 构建产物已复制到：
  - `web-uploader/assets/supersplat-editor/`
- 对官方 editor 做了一个小补丁：
  - URL 支持 `rx/ry/rz` 参数。
  - 自动导入 `load` 文件后应用旋转，例如 `rx=90&ry=0&rz=180`。
- `newrobin/source.json` 已改为默认打开官方 editor：
  - `/assets/supersplat-editor/index.html?load=%2Fgaussians%2Fnewrobin%2Fscene.ply&filename=gs.ply&rx=90&ry=0&rz=180`
- 服务端代码已改：
  - 后续新上传/本地导入的 3DGS，`publish.directViewerUrl` 默认写官方 editor URL。
  - `/3dgs/:assetName` 默认跳转官方 editor。
  - `?mode=lod` 才保留旧 LOD viewer 实验路径。

验证：

- `npm install` 和 `npm run build` 在 `/private/tmp/supersplat` 成功。
- `server.js` 语法检查通过。
- `assets/supersplat-editor/index.html` 和 `static/lib/webp/webp.wasm` 存在。
- `newrobin/source.json` 当前：
  - `viewerUrl=/3dgs/newrobin`
  - `publish.directViewerUrl=/assets/supersplat-editor/index.html?load=%2Fgaussians%2Fnewrobin%2Fscene.ply&filename=gs.ply&rx=90&ry=0&rz=180`

下一步：

- 老板应直接测试：
  - `http://127.0.0.1:8092/assets/supersplat-editor/index.html?load=%2Fgaussians%2Fnewrobin%2Fscene.ply&filename=gs.ply&rx=90&ry=0&rz=180`
- 当前 8092 进程如果未重启，`/3dgs/newrobin` 可能仍是旧服务代码包装 iframe，但因为 `newrobin/source.json` 已更新，刷新后也应加载官方 editor。
- 后续部署到服务器时，要同步整个 `web-uploader/assets/supersplat-editor/` 目录。

### 2026-05-05 浏览模式 UI 魔改

老板要求保留官方 SuperSplat Editor 的浏览性能，但隐藏编辑器界面，只作为客户浏览器使用。

已在 `web-uploader/assets/supersplat-editor/index.css` 追加 CloudStudio browse mode CSS，隐藏：

- 左上菜单：`#menu`
- 场景管理器：`#scene-panel`
- 变换面板：`#transform`
- 底部悬浮编辑工具条：`#bottom-toolbar`
- 时间线：`#timeline-panel`
- 高斯点数据面板：`#data-panel`
- 底部状态栏：`#status-bar`
- 右侧编辑工具栏：`#right-toolbar`
- 视图设置面板：`#view-panel`
- app label / cursor label / mode toggle / color panel / shortcuts / about popup

同时：

- 画布容器强制全屏。
- `tools-container` 和 `mask-canvas` 禁止鼠标事件，避免隐藏后仍截获操作。
- `buildGaussianEditorUrl()` 默认增加 `lng=en`，让 SuperSplat Editor 默认英文。
- `newrobin/source.json` 已更新为：
  - `/assets/supersplat-editor/index.html?load=%2Fgaussians%2Fnewrobin%2Fscene.ply&filename=gs.ply&lng=en&rx=90&ry=0&rz=180`

验证：

- `node --check server.js` 通过。
- `newrobin` 的 directViewerUrl 已带 `lng=en`。
- CSS 是静态文件，刷新 editor 页面即可生效；后续新上传项目的 `lng=en` URL 生成需要服务进程重启后生效。

### 2026-05-05 浏览模式缓存修正

老板反馈 Safari 里仍然看到原版 SuperSplat Editor 外壳：左上菜单、场景管理器、变换面板、底部工具条、时间线和 Splat Data 仍在。

原因确认：

- SuperSplat Editor 默认注册 `sw.js`。
- `sw.js` 会缓存 `index.html`、`index.css`、`index.js` 等资源。
- 只改 `index.css` 时，Safari / PWA service worker 可能继续返回旧资源，所以界面看起来“没变”。

本次处理：

- 直接修改 `web-uploader/assets/supersplat-editor/index.html`。
- 移除 manifest 入口，不再注册新的 service worker。
- 启动时主动注销 `/assets/supersplat-editor/` 作用域下的旧 service worker。
- CSS/JS 改成带版本号：
  - `index.css?v=cloudstudio-browse-20260505-2`
  - `index.js?v=cloudstudio-browse-20260505-2`
- 在 HTML 内联 CloudStudio browse mode CSS，避免 CSS 缓存导致失效。
- 加 `MutationObserver` 和定时兜底，SuperSplat 动态创建 UI 后也会再次隐藏：
  - `#menu`
  - `#scene-panel`
  - `#transform`
  - `#bottom-toolbar`
  - `#timeline-panel`
  - `#data-panel`
  - `#status-bar`
  - `#right-toolbar`
  - `#view-panel`
  - `#color-panel`
  - `.select-toolbar`
  - `.menu-panel`
- `buildGaussianEditorUrl()` 增加 `v=cloudstudio-browse-20260505-2`。
- `newrobin/source.json` 的 `directViewerUrl` / `editorViewerUrl` 同步增加版本号。

验证：

- 本地 8092 服务已重启。
- `http://127.0.0.1:8092/3dgs/newrobin` 302 到新 URL：
  - `/assets/supersplat-editor/index.html?load=%2Fgaussians%2Fnewrobin%2Fscene.ply&filename=gs.ply&lng=en&rx=90&ry=0&rz=180&v=cloudstudio-browse-20260505-2`
- Playwright 真实浏览器验证：
  - 页面标题是 `CloudStudio 3DGS Viewer`。
  - `navigator.serviceWorker.controller` 为 `false`。
  - 上述菜单/面板/工具条全部为 `display: none`。
  - 页面仍有 canvas。
  - 截图只剩 3DGS 画布和右上坐标轴。

后续注意：

- 如果 Safari 旧标签页仍显示原版 UI，直接打开带 `v=cloudstudio-browse-20260505-2` 的 URL，或对 `127.0.0.1` 做一次硬刷新/清站点缓存。

### 2026-05-05 浏览模式滚轮操作修正

老板反馈：在浏览模式里滚轮/触控板两指上下滚动时，视角会上下转动，而不是缩放。

原因确认：

- SuperSplat Editor 上游逻辑会区分“物理鼠标滚轮”和“触控板两指滚动”。
- 在 orbit 模式下：
  - 物理滚轮默认 zoom。
  - 触控板两指滚动默认 `orbit(deltaX, deltaY)`，即转视角。
- 这对编辑器有意义，但对客户浏览器不符合直觉。

本次处理：

- 修改 `/private/tmp/supersplat/src/controllers.ts`。
- 在 `document.documentElement.classList.contains('cloudstudio-browse-mode')` 时，滚轮/触控板两指滚动统一执行 `zoom(...)`。
- 重新 `npm run build` 官方 SuperSplat。
- 只复制新的 `dist/index.js` / `dist/index.js.map` 到：
  - `web-uploader/assets/supersplat-editor/index.js`
  - `web-uploader/assets/supersplat-editor/index.js.map`
- 没有覆盖已魔改的 `index.html`，避免 service worker 和 UI 隐藏逻辑回退。
- 版本号更新到 `cloudstudio-browse-20260505-3`：
  - `index.html`
  - `server.js`
  - `newrobin/source.json`

验证：

- 本地 8092 服务已重启。
- `/3dgs/newrobin` 跳转到带 `v=cloudstudio-browse-20260505-3` 的 URL。
- Playwright 验证滚轮事件：
  - 滚轮前：`distance=0.01307203378113192`，`azim=315`，`elevation=-10`
  - 滚轮后：`distance=0.04681354197477381`，`azim=315`，`elevation=-10`
  - 结论：滚轮只改变缩放距离，不再改变视角角度。

### 2026-05-05 浏览模式默认隐藏网格、边框和文件选择

老板要求：画布网格和数据边框默认不勾选、不显示；左上角出现的“选取文件”按钮也要去除。

本次处理：

- `buildGaussianEditorUrl()` 默认增加：
  - `show.grid=false`
  - `show.bound=false`
- `newrobin/source.json` 的 editor URL 已同步增加上述参数。
- `assets/supersplat-editor/index.html` 的浏览模式兜底逻辑里持续执行：
  - `grid.setVisible(false)`
  - `camera.setBound(false)`
- 同时隐藏 SuperSplat fallback 文件选择器：
  - `#file-selector`
  - `input[type="file"]`
- 版本号更新到 `cloudstudio-browse-20260505-4`。

验证：

- 本地 8092 服务已重启。
- `/3dgs/newrobin` 跳转到带 `show.grid=false&show.bound=false&v=cloudstudio-browse-20260505-4` 的 URL。
- Playwright 验证：
  - `grid.visible=false`
  - `camera.bound=false`
  - 页面没有可见 `input[type=file] / #file-selector`
  - 可见文字只剩右上角坐标轴的 `X/Y/Z`

### 2026-05-05 清理旧 SOG/LOD 实验链路

老板要求：把之前卡顿的 SOG/LOD 实验 viewer、后端转换、接口、测试过程数据清理干净，只保留当前官方 SuperSplat Editor 浏览模式，准备后续同步服务器。

本次处理：

- 后端 `/api/upload-gaussian` 改为干净直连流程：
  - 保存上传源文件到 `web-uploader/gaussians/<assetName>/scene.<ext>`。
  - 写入 `source.json`。
  - 标记 `publish.pipeline=supersplat-editor-direct`。
  - 返回 `/3dgs/<assetName>` 浏览链接。
- `/3dgs/:assetName` 只负责读取 manifest 并跳转到：
  - `/assets/supersplat-editor/index.html?...`
  - 默认 `lng=en`、`rx=90&ry=0&rz=180`、`show.grid=false`、`show.bound=false`。
- 删除旧实验链路：
  - 删除 `publishGaussianWithSuperSplat` 以及相关 SOG/LOD 转换函数。
  - 删除 `/api/import-local-gaussian` 本地导入测试接口。
  - 删除 `assets/supersplat-local-viewer/`。
  - 删除 `assets/gaussian-local-preview.html`。
  - 删除 `web-uploader/gaussians/*/supersplat/` 旧发布包。
  - 删除之前的临时测试资产目录。
  - 从 `package.json` / `package-lock.json` 移除 `@playcanvas/splat-transform`。
- 现存 Gaussian manifest 已统一到新路线，不再指向旧实验 viewer。

验证：

- `node --check server.js` 通过。
- `assets/i18n/zh-CN.json` / `assets/i18n/en.json` JSON 解析通过。
- 应用目录内排除官方 editor 源码后，已搜不到：
  - `splat-transform`
  - `supersplat-local-viewer`
  - `gaussian-local-preview`
  - `import-local-gaussian`
  - `mode=lod`
  - `lod-meta`
  - `scene.sog`
- 文件系统确认没有遗留：
  - `lod-meta.json`
  - `scene.sog`
  - `assets/supersplat-local-viewer`
  - `assets/gaussian-local-preview.html`
- 旧入口验证：
  - `/assets/gaussian-local-preview.html` 返回 404。
  - `/assets/supersplat-local-viewer/index.html` 返回 404。
- 真实 multipart 上传验证：
  - 使用 `/Users/yangqi/Downloads/robin/sky.ply` 上传到临时资产 `sky-direct-flow-check`。
  - 返回 `viewerUrl=/3dgs/sky-direct-flow-check`。
  - 返回 `publish.pipeline=supersplat-editor-direct`。
  - 只生成 `source.json` 和 `scene.ply`，没有生成 `supersplat/` 发布包。
  - Playwright 打开 viewer 后确认：
    - 页面标题 `CloudStudio 3DGS Viewer`。
    - canvas 正常存在。
    - 左上菜单、场景管理器、变换面板、底部工具条、时间线和 Splat Data 都不可见。
    - 文件选择 input 不可见。
    - `grid.visible=false`。
    - `camera.bound=false`。
    - 没有 service worker 控制页面。
- 临时上传测试资产已删除，避免留下过程数据。
- 本地 8092 已恢复默认启动方式，供老板继续测试正式流程。

### 2026-05-05 部署到 eu.lidar361.com

老板要求：把当前干净的 3DGS 浏览链路部署到欧洲站 `https://eu.lidar361.com`，替换旧 SOG/LOD 转换链路，并接入服务器上已有的 3DGS 数据。

服务器确认：

- 目标服务器：法兰克福节点 `47.254.151.31`。
- Web 目录：`/opt/cloudstudio/web-uploader`。
- PM2 进程：`cloudstudio-frankfurt`。
- HTTPS 域名：`https://eu.lidar361.com`。
- 远端已有 3DGS：
  - `BEL-JOEL-GS`
  - `Robin-3DFS`

部署动作：

- 先备份远端关键代码、i18n、SuperSplat editor 静态资源和 3DGS manifest。
- 备份目录：
  - `/opt/cloudstudio/backups/3dgs-direct-20260506-030823`
- 热更新：
  - `web-uploader/server.js`
  - `web-uploader/index.html`
  - `web-uploader/package.json`
  - `web-uploader/package-lock.json`
  - `web-uploader/assets/i18n/zh-CN.json`
  - `web-uploader/assets/i18n/en.json`
  - `web-uploader/assets/supersplat-editor/`
- 删除远端旧实验链路残留：
  - `assets/supersplat-local-viewer`
  - `assets/gaussian-local-preview.html`
  - `gaussians/*/sog-lod*`
  - `gaussians/*/sog-parts`
  - `gaussians/*/supersplat`
  - `gaussians/*/sog-lod*.tar.gz`
  - `gaussians/*/source.json.bak-*`
- 运行 `npm install` 后确认远端依赖只剩：
  - `express`
  - `multer`
- 执行 `node --check server.js` 通过。
- 重启 `pm2 restart cloudstudio-frankfurt`，PM2 在线。

数据接入结果：

- `BEL-JOEL-GS`
  - 源文件：`/gaussians/BEL-JOEL-GS/scene.splat`
  - 新入口：`https://eu.lidar361.com/3dgs/BEL-JOEL-GS`
  - pipeline：`supersplat-editor-direct`
- `Robin-3DFS`
  - 源文件：`/gaussians/Robin-3DFS/scene.splat`
  - 新入口：`https://eu.lidar361.com/3dgs/Robin-3DFS`
  - pipeline：`supersplat-editor-direct`

验收结果：

- 服务器内层 `/health` 正常：
  - `ok=true`
  - `converter=true`
  - `exportPython=true`
  - `potreePath` 存在
- 旧 SOG/LOD 残留检查为空。
- 旧入口 `/supersplat-viewer/?content=...sog-lod...` 返回 404。
- `/api/clouds` 已返回两个 Gaussian 资源，viewerUrl 分别为：
  - `/3dgs/BEL-JOEL-GS`
  - `/3dgs/Robin-3DFS`
- HTTPS 域名验证：
  - `https://eu.lidar361.com/3dgs/BEL-JOEL-GS` 返回 302 到 `/assets/supersplat-editor/index.html?...scene.splat...show.grid=false&show.bound=false&v=cloudstudio-browse-20260505-4`
  - `https://eu.lidar361.com/3dgs/Robin-3DFS` 返回 302 到 `/assets/supersplat-editor/index.html?...scene.splat...show.grid=false&show.bound=false&v=cloudstudio-browse-20260505-4`
  - `https://eu.lidar361.com/health` 正常。

注意：

- 本次线上链路使用已有 `scene.splat` 作为浏览源文件，不再使用之前的 SOG/LOD 包。
- 如果后续客户反馈 `scene.splat` 画质或加载体验不如直接拖 PLY 到官方 editor，需要再评估是否改为 `scene.ply` 作为线上源文件；当前选择 `scene.splat` 是为了优先用较小文件跑通线上浏览。

### 2026-05-05 首页按钮接入修正

老板反馈：欧洲站首页列表里的 3DGS `Open Viewer` 按钮也必须接到新路线，不能再让旧链接或旧缓存页面点到 `/supersplat-viewer/` 后显示 `Cannot GET /supersplat-viewer/`。

本次处理：

- 首页 `renderClouds()` 中对 Gaussian 资源强制生成：
  - `/3dgs/<cloudName>`
- 点云资源仍保持原有 Potree viewer 链接。
- 服务端增加旧链接兼容：
  - `/supersplat-viewer`
  - `/supersplat-viewer/`
- 如果旧链接里带 `content=/gaussians/<assetName>/...`，服务器会自动 302 到：
  - `/3dgs/<assetName>`
- 已同步 `index.html` 和 `server.js` 到 `eu.lidar361.com` 并重启 `cloudstudio-frankfurt`。

验证：

- 旧链接：
  - `/supersplat-viewer/?content=%2Fgaussians%2FBEL-JOEL-GS%2Fsog-lod%2Flod-meta.json&budget=12&aa`
  - 现在返回 302 到 `/3dgs/BEL-JOEL-GS`，不再 404。
- 新链接：
  - `/3dgs/BEL-JOEL-GS`
  - 返回 302 到新版 `assets/supersplat-editor/index.html?...scene.splat...`。
- Playwright 打开 `https://eu.lidar361.com/` 后确认：
  - `BEL-JOEL-GS` 按钮 href 是 `/3dgs/BEL-JOEL-GS`。
  - `Robin-3DFS` 按钮 href 是 `/3dgs/Robin-3DFS`。
- Playwright 打开 `https://eu.lidar361.com/3dgs/BEL-JOEL-GS` 后确认：
  - 页面标题 `CloudStudio 3DGS Viewer`。
  - 有 canvas。
  - 原 SuperSplat 编辑器菜单和面板不可见。
  - 文件选择 input 不可见。
  - `grid=false`。
  - `bound=false`。
### 2026-05-06 欧洲站 3DGS 浏览链路优化与部署

目标：把 `eu.lidar361.com` 上的 3DGS 浏览从“直接加载原始 PLY / 旧 `.splat` / 旧 SOG-LOD 实验”切到一条干净的正式浏览路线，首页按钮、转换产物、viewer 链接和静态文件服务全部打通。

本次结论：

- 原始 `scene.ply` 保留为源文件，不作为客户在线浏览默认文件。
- 旧 `.splat` 是历史测试产物，已从 BEL-JOEL-GS 和 Robin-3DFS 的线上 manifest 中移除，并删除 `scene.splat` / `scene-full.splat`。
- `scene.compressed.ply` 由官方 `@playcanvas/splat-transform` 生成，但在当前嵌入式 SuperSplat Editor URL 自动加载链路中一直转圈，未作为正式路线保留。
- 最终采用官方 PlayCanvas/SuperSplat `SOG` 单文件 web delivery 格式：仍然从原始 PLY 转换而来，但更适合线上链接加载。

转换结果：

- `BEL-JOEL-GS`
  - 原始 PLY：约 459MB，8.59M gaussians
  - SOG：约 95MB
  - 转换命令：`npx --yes @playcanvas/splat-transform@2.0.3 --mem --overwrite -g cpu scene.ply -r 90,0,180 scene.sog`
  - 发布链接：`https://eu.lidar361.com/3dgs/BEL-JOEL-GS`
- `Robin-3DFS`
  - 原始 PLY：约 849MB，15.9M gaussians
  - SOG：约 175MB
  - 转换命令同上，输入使用本地 `/Users/yangqi/Downloads/robin/gs.ply`
  - 发布链接：`https://eu.lidar361.com/3dgs/Robin-3DFS`

方向处理：

- MVPS1 3DGS 数据需要 `rotate=90,0,180`。
- 本次已在转换阶段用 `-r 90,0,180` 烘焙到 `scene.sog`。
- viewer URL 因此使用 `rx=0&ry=0&rz=0`，避免前端二次旋转。

服务器环境：

- 远程 `@playcanvas/splat-transform@2.0.3` 在 Alibaba Cloud Linux 3 上因 `GLIBCXX_3.4.29` 缺失无法直接运行。
- 已尝试安装 `gcc-toolset-13-runtime gcc-toolset-13-libstdc++-devel gcc-toolset-13-gcc-c++`，但未提供可直接替换的新版 `libstdc++.so.6`。
- 不强行替换系统 libstdc++，当前采用“本地转换、上传 runtime 文件”的安全路线。

部署调整：

- `source.json` 已切到：
  - `fileName: scene.sog`
  - `format: sog`
  - `publish.pipeline: supersplat-editor-sog`
  - `publish.rotationBaked: true`
  - `publish.viewerRotation: { rx: 0, ry: 0, rz: 0 }`
- `server.js` 的 `buildGaussianEditorUrl()` 已支持 `publish.rotationBaked` / `publish.viewerRotation`。
- Nginx 增加 `/gaussians/` 和 `/assets/` 静态直出，大文件 Range 请求不再经过 Node/Express 代理。
- 修复 `/opt/cloudstudio/web-uploader/assets` 目录权限，确保 Nginx 可以直接读取 SuperSplat Editor 静态资源。

验收：

- `https://eu.lidar361.com/3dgs/BEL-JOEL-GS` 已通过 Playwright 打开，页面标题 `CloudStudio 3DGS Viewer`，canvas 存在，场景加载完成并截图确认可见。
- BEL 的 SOG 文件由 Nginx 直接返回，`Content-Length=99698711`，支持 `Accept-Ranges: bytes`。
- Robin 的 SOG 文件由 Nginx 直接返回，`Content-Length=183087976`，支持 `Accept-Ranges: bytes`；由于从当前本地网络到欧洲服务器较慢，Playwright 验收需要更长等待。
- 2026-05-06 方向校准：
  - `Robin-3DFS` 用户确认追加 viewer 旋转 `rx=180&ry=0&rz=0` 后方向正确。
  - `BEL-JOEL-GS` 用户要求追加 viewer 旋转 `rx=90&ry=0&rz=0`，已更新线上 manifest。
  - 后续用户从直连链接检查发现 BEL-JOEL-GS 仍倒置，要求主页 Open Viewer 按钮同步修正。已在法兰克福线上 `/opt/cloudstudio/web-uploader/gaussians/BEL-JOEL-GS/source.json` 备份后把 `publish.viewerRotation` 改为 `{ rx: 270, ry: 0, rz: 0 }`，并同步更新 `publish.editorViewerUrl` / `publish.directViewerUrl`。验证 `https://eu.lidar361.com/3dgs/BEL-JOEL-GS` 的 302 `Location` 已包含 `rx=270&ry=0&rz=0`，因此主页按钮点击会进入新方向。

后续建议：

- 如果面向中国客户，欧洲服务器加载 95-175MB 仍会慢，正式产品应使用 OSS/CDN 或按客户区域部署。
- 若追求首屏秒开，需要继续做 preview/standard/high 多档发布包，而不是只靠单个高质量 SOG。
- 后续上传接口应自动生成 `scene.sog`，但服务器端转换环境需要 Docker/容器或单独构建新版 libstdc++，不能直接污染系统库。

### 2026-05-06 新服务器自动转换链路同步

目标：把本地代码和 `8.209.66.134` 新服务器同步成正式 3DGS 上传链路，确认新服务器能否直接运行转换。

本地代码更新：

- `/api/upload-gaussian` 从“直接发布源文件”改为：
  - 只接受原始 `.ply`
  - 保存源文件为 `gaussians/<asset>/scene.ply`
  - 调用 `@playcanvas/splat-transform@2.0.3`
  - 使用完整质量转换为 `gaussians/<asset>/scene.sog`
  - 写入 `source.json`
  - 首页和结果按钮打开 `/3dgs/<asset>`
- 默认转换旋转：
  - `GAUSSIAN_CONVERT_ROTATION=90,0,180`
  - 旋转烘焙进 `scene.sog`
  - viewer 默认 `rx=0&ry=0&rz=0`
- `package.json` 已加入：
  - `@playcanvas/splat-transform@^2.0.3`
- 首页上传文案收敛为正式 PLY 路线，不再显示 `.splat/.ksplat` 作为正式上传格式。

新服务器环境确认：

- 服务器：`8.209.66.134`
- 系统：Ubuntu 24.04.2 LTS
- Node：`v18.19.1`
- npm：`9.2.0`
- `libstdc++` 支持到 `GLIBCXX_3.4.33`
- `splat-transform v2.0.3` 可直接运行。
- 对比：欧洲服务器 Alibaba Cloud Linux 3 只有 `GLIBCXX_3.4.28`，因此运行 `splat-transform` 会报 `GLIBCXX_3.4.29 not found`。

部署到新服务器：

- 已 rsync 本地代码到 `/opt/cloudstudio`，排除运行时目录：
  - `uploads/`
  - `projects/`
  - `pointclouds/`
  - `gaussians/`
  - `exports/`
  - `cache/`
  - `*_jobs/`
- 已在 `/opt/cloudstudio/web-uploader` 执行 `npm install`。
- 已重启 PM2 进程 `cloudstudio`。
- 已给 Nginx 增加：
  - `/gaussians/` 静态直出
  - `/assets/` 静态直出
  - `.wasm` 正确 `application/wasm`
- 同步过程中 PotreeConverter 的 `build-gcc` 产物被清理，已在新服务器重新用 cmake/make 编译恢复。

验收：

- 新服务器本机 `splat-transform` 最小 PLY 转 SOG 成功。
- 用临时测试进程跑完整 HTTP 上传链路成功：
  - `POST /api/upload-gaussian`
  - `scene.ply`
  - `scene.sog`
  - `source.json`
  - `/3dgs/chain-test` 跳转到 SuperSplat Editor browse URL
  - 测试数据已删除
- 公网健康检查：
  - `http://8.209.66.134/health`
  - `ok=true`
  - `converter=true`
  - `exportPython=true`
  - `potreePath=true`
- 公网静态资源：
  - `http://8.209.66.134/assets/supersplat-editor/index.html` 返回 200
  - `http://8.209.66.134/assets/supersplat-editor/static/lib/webp/webp.wasm` 返回 200 且 `Content-Type: application/wasm`

### 2026-05-07 UI 国际化整理

目标：扫描本地 CloudStudio UI 的多语言接入，修复近期 3DGS、viewer 工具和导出弹窗新增功能里漏翻、缺 key、语言切换混乱的问题。

已完成：

- `client-i18n.js` 增加 `data-i18n-aria-label` 支持，修复语言选择器等无障碍标签无法按 key 翻译的问题。
- 首页语言选择补齐 `ko-KR`，并固定语言选项为原生显示：`English / 中文 / Français / 한국어`。
- 首页 3DGS 上传链路文案统一为正式 PLY 上传路线，修复 `打开浏览`、`3DGS 已发布` 等硬编码结果文案。
- 补齐 `en / zh-CN / fr / ko-KR` 四套语言里的 3DGS 发布、裁剪框、坐标系、本机打开、地形工作台、体积测量、多格式导出相关 key。
- 修复 `zh-CN` 里 `??`、`Fran?ais` 语言名乱码，以及体积空缺格网提示中混入的乱码中文。
- `viewer.html` 的体积面板、多格式导出弹窗接入 `data-i18n`，减少可见中文硬编码。
- SuperSplat 浏览器页面根据 `lng=zh-CN` 设置中文 title / description。

验收：

- 本地四套 JSON 均可正常 `JSON.parse`。
- 脚本扫描 `index.html`、`viewer.html`、`assets/app/**/*.js`、`client-i18n.js` 中引用的 `data-i18n` / `tr()` / `translate()` key：`missing=0`。
- 浏览器抽样验证：
  - `http://127.0.0.1:8090/` 法语切换正常，3DGS 上传按钮显示 `Importer et ouvrir`，结果按钮显示 `Ouvrir la visionneuse`。
  - `http://127.0.0.1:8090/viewer` 韩语切换正常，语言标签显示 `언어`。
  - 控制台无 error / warn。

后续风险：

- viewer 里仍有不少运行时模板字符串依赖 `phrases` 自动翻译，短期可用，但正式产品建议逐步迁移为结构化 key，例如 `viewer.volume.*`、`viewer.export.*`。
- 法语和韩语翻译目前以功能可用和不 fallback 为优先，正式对外发布前建议让母语人员做一次审校。

### 2026-05-07 Viewer 点云界面国际化专项修复

目标：只针对 `web-uploader/viewer.html` 点云显示界面，修复菜单、工具栏、左侧场景树、右侧 Inspector、上传/打开/导出弹窗、地形工具、动态 toast/status 等在英文、法语、韩语下仍显示中文或乱码的问题。

处理方式：

- 统一使用现有 `assets/i18n/*.json` 作为语言资源来源。
- 保留 viewer 的 `data-i18n-auto-root` 自动翻译机制，把裸中文 UI 文案和动态 `trText(...)` 文案统一补到四套语言文件的 `phrases` 表。
- 修复法语文件中遗留的编码损坏文案，例如 `Bo?te`、`Intensit?`、`Retour ? l?accueil` 等。
- 修复韩语界面中左侧 quickbar / 场景树仍回退为英文的问题。

验收结果：

- `viewer.html` 静态中文 UI phrases：`406` 条，英/中/法/韩缺失数 `0`。
- `viewer.html` 动态 `trText(...)` phrases：`134` 条，英/中/法/韩缺失数 `0`。
- `viewer.html` 结构化 i18n keys：`309` 个，英/中/法/韩缺失数 `0`。
- 浏览器抽样：
  - 法语：菜单、工具栏、左侧栏、Inspector 正常显示法语，未检测到 `?` 乱码。
  - 韩语：菜单、工具栏、左侧栏、Inspector 正常显示韩语，未再回退为英文。
  - 英文：正常显示英文。
  - 非中文界面剩余中文字符来自语言下拉选项里的 `中文`，属于语言名称本身。
  - 控制台无 error / warn。

追加优化：

- `client-i18n.js` 的 `SUPPORTED_LOCALES` 收敛为实际存在的四套语言文件：`en / zh-CN / fr / ko-KR`，避免声明了 `de / es / it / fi / sv` 但没有 JSON 文件导致请求失败和回退。
- `viewer.html` 补齐结构化 key：
  - 移动端 `☰ Scene` 按钮
  - Inspector 的 Coordinate tab
  - 底部测试版本免责声明
  - 底部 `Create Clip Box` 快捷动作
- 韩语补齐 Capture、Coordinate、Inspector、移动端 Scene、免责声明等可见控件。
- 再次浏览器验证：
  - 英文、法语、韩语、中文四种语言均正常切换。
  - 法语无 `Bo?te / Intensit? / l?accueil` 这类编码损坏。
  - 韩语不再在 Coordinate、Capture、Scene、免责声明位置回退英文。

### 2026-05-07 Viewer 九语种国际化底座整理

目标：前置首页已加入 `de / es / it / fi / sv` 后，为点云 `viewer.html` 正式支持九语种做底座整理，避免页面源码继续以中文作为默认文案，避免后续语言扩展时出现漏 key、中文泄漏或 fallback 混乱。

已完成：

- `client-i18n.js` 与实际语言文件重新对齐为九语种：`en / zh-CN / fr / ko-KR / de / es / it / fi / sv`。
- `viewer.html` 语言下拉补齐德语、西语、意大利语、芬兰语、瑞典语。
- 统一语言资源树：九个 `assets/i18n/*.json` 都补齐到与 `en.json` 同结构，`viewer / terrain / units / errors / phrases` 不再缺大块 key。
- 把 `index.html` 和 `viewer.html` 中可见默认文案改成英文源文案；中文显示统一走 `zh-CN.json`。
- 修复旧 `phrases` 机制导致的半中文半英文默认文案，例如上传、删除确认、CRS 说明、导出提示、DXF toast、体积测量状态等。
- `viewer.html` 的 About、免责声明和语言下拉从硬编码语言 map 改为统一走 `viewer.about.*`、`viewer.disclaimer.*`、`common.locale.*`。
- 为德语、西语、意大利语、芬兰语、瑞典语补齐 viewer 主界面文案：页面标题、菜单、工具栏、Inspector tabs、Scene、测试版免责声明、About 说明。

验收：

- `index.html` / `viewer.html` 源码扫描：无中文汉字残留；语言下拉中的 `中文` 由运行时语言资源提供。
- `viewer.html` 引用的结构化 i18n key：`317` 个；九语种缺失数 `0`。
- 九个语言 JSON 均可正常 `JSON.parse`。
- 抽取 viewer module script 语法检查通过。
- Playwright 实测 `http://127.0.0.1:8090/viewer` 九语种切换：
  - 英文、中文、法语、韩语、德语、西语、意大利语、芬兰语、瑞典语页面标题、File 菜单、Open 按钮、Coordinate tab、测试版本提示均正常显示。
  - 非中文界面未检测到中文 UI 泄漏；唯一中文字符只来自语言选项名称 `中文`。
  - 控制台 error / warning 数为 `0`。

后续建议：

- 当前 `de / es / it / fi / sv` 已覆盖 viewer 主界面，深层体积分析、terrain、DXF、导出细节等仍有部分内容通过英文 fallback 保底。正式客户版本前建议按模块逐项精翻和母语审校。

### 2026-05-07 客户可见 UI 九语种完整翻译实施

目标：落实“客户可见 CloudStudio 产品界面完整支持 `en / zh-CN / fr / ko-KR / de / es / it / fi / sv`”计划，覆盖首页、点云 viewer、客户可见功能模块、3DGS 浏览包装页；第三方 Potree / SuperSplat 内部编辑器 UI 不作为本轮阻塞项。

已完成：

- 以 `assets/i18n/en.json` 为源结构，补齐九语种 JSON 缺失 key，并补齐德语、西语、意大利语、芬兰语、瑞典语的客户可见翻译初稿。
- 清理 `index.html`、`viewer.html`、`assets/app/**/*.js` 的客户可见中文硬编码，源码默认文案统一回到英文源文案。
- 修复动态模块的翻译路线：
  - 照片信息栏：位置、朝向、相机、时间戳。
  - 扫描信息面板：RTK、着色状态、扫描时长、路径长度、经纬高、推荐投影。
  - 点云打开流程：加载中、加载点云、加载完成、就绪状态。
  - 测量模块：测量名称、空状态、长度/面积/高差/坡度、删除按钮、toast/status。
  - 导出模块：源文件列表、无可导出源文件、未知大小、导出完成、文件大小、删除区域剔除点数。
  - 场景树：显示/隐藏、适配视图、关闭、等高线图层、OBJ/Surface/Volume Surface。
  - Capture、Terrain 导入、DXF draw、Magnifier 的动态 fallback。
- `assets/supersplat-editor/index.html` 改为识别统一 `lng` 参数，为九语种设置页面 title 和 description；SuperSplat 内部隐藏编辑器 UI 暂不改源码。
- 新增只读验收脚本 `web-uploader/scripts/check-i18n.js`，并在 `package.json` 增加 `npm run check:i18n`。

验收结果：

- `npm run check:i18n` 通过：
  - 九语种 JSON 全部可解析。
  - 相对 `en.json` 缺失 key 为 `0`。
  - `data-i18n` / `tr()` / `translate()` / `translateText()` / `tt()` 静态引用 key 全部存在。
  - `{{placeholder}}` 占位符完整。
  - `index.html` / `viewer.html` / `assets/app/**/*.js` 客户可见源码无中文硬编码。
  - 保留英文只限品牌、格式、单位、CRS/EPSG/UTM/WGS84、路径示例、国际通用短术语等白名单。
- Playwright 浏览器实测：
  - `http://127.0.0.1:8090/` 九语种切换正常；非中文界面没有中文 UI 泄漏。
  - `http://127.0.0.1:8090/viewer` 九语种切换正常；File 菜单、Open、Measure、Coordinate、Capture、Export、免责声明均按语言切换。
  - 控制台 error / warning 为 `0`。

后续建议：

- 本轮是 AI 专业初稿，已经做到产品功能不大面积回退英文；正式给客户前建议对 `de / es / it / fi / sv` 做母语审校。
- 后续新增 UI 时必须走 `data-i18n`、`tr()` 或 `translateText()`，并运行 `npm run check:i18n`。
