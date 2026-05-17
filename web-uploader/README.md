# CloudStudio `web-uploader`

最后更新：2026-04-09  
当前状态：长期维护中的主业务应用  
适用范围：`/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader`

---

## 1. 这是什么

`web-uploader` 是 CloudStudio 当前真正的主应用目录。

它不是一个“单纯上传器”，而是整个点云业务壳层，负责：

- 启动 Web 服务
- 托管 viewer 页面
- 管理点云 / 扫描项目 / Gaussian 数据
- 调用 Potree 与 PotreeConverter
- 调度 Python 分析脚本
- 提供 DXF 绘图、Auto Extract、导出、地形/表面/体积相关能力

如果你要改产品行为、修前后端 bug、排查数据路径问题，大多数情况下应该先看这里，而不是先看上层 `potree/` 或 `PotreeConverter/`。

---

## 2. 项目在整个仓库中的位置

上层仓库结构可以这样理解：

```text
cloudstudio-server/
├── web-uploader/       主业务应用（本目录）
├── potree/             底层点云渲染引擎与资源
└── PotreeConverter/    点云转换工具
```

关系说明：

- `web-uploader/`
  - 业务入口、页面、API、Python 任务调度、运行时目录都在这里。

- `potree/`
  - 被本应用以静态资源形式挂到 `/potree`。
  - 提供 Viewer、Measure、Profile、InputHandler 等底层能力。

- `PotreeConverter/`
  - 负责把原始 LAS/LAZ 转成 Potree 格式。
  - 上传、转换失败时才需要深入看它。

不要把 `potree/` 当作日常业务开发主目录。  
绝大多数产品 bug 都发生在：

- `web-uploader/viewer.html`
- `web-uploader/server.js`
- `web-uploader/assets/app/features/*`

---

## 3. 当前架构现状

当前前端不是彻底模块化的 SPA，而是“legacy 主程序 + 增量模块化 feature”并存结构。

### 3.1 前端真实形态

- [viewer.html](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/viewer.html)
  - 仍然持有大量核心 runtime、DOM、事件与 legacy 逻辑

- [assets/app/entry/viewer-entry.js](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/assets/app/entry/viewer-entry.js)
  - 负责初始化 `APP_SHELL / APP_SERVICES / APP_UI`
  - 注册 feature factory
  - 通过 `loadLegacyInlineModule()` 加载 `viewer.html` 内的 legacy 模块源码

- [assets/app/features/*](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/assets/app/features)
  - 已经抽出一批功能壳层与局部模块
  - 但很多 feature 仍依赖 `viewer.html` 传入的状态和 legacy helper

一句话总结：

- 现在不是“旧代码已退场”，而是“新壳层包着旧内核逐步收口”。

### 3.2 后端真实形态

- [server.js](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/server.js)
  - 单文件大后端
  - 同时负责：
    - 静态资源服务
    - 上传与转换
    - 扫描项目发现
    - 数据源解析
    - CRS / 格网
    - 导出
    - Auto Extract / 地形 / 体积 / 林业相关任务
    - 作业结果目录暴露

这意味着：

- 排障时不要急着按“文件分层”去找
- 应该先按“功能链路”定位

---

## 4. 快速开始

## 4.1 本地启动

```bash
cd /Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader
npm run setup:local
npm run start:local
```

常用访问地址：

- `http://localhost:8090/`
- `http://localhost:8090/viewer`
- `http://localhost:8090/health`

说明：

- `setup:local`
  - 安装 `node_modules`
  - 初始化 `.venv`
  - 安装本地 Python 依赖
- `start:local`
  - 使用 `./.venv/bin/python` 作为主要 Python 运行时启动服务

如果你只是快速跑服务，也可以：

```bash
npm start
```

但要注意：

- `npm start` 依赖当前环境里的 `PYTHON_BIN` / `.venv`
- 如果 Python 环境没配好，导出、CRS、Auto Extract 等能力会受影响

## 4.2 本地一键脚本

可双击：

- [start-local.command](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/start-local.command)

适合：

- 日常本机打开 viewer
- 不想手动敲命令时

## 4.3 健康检查

优先检查：

```bash
curl http://localhost:8090/health
```

最重要的字段：

- `converter`
- `exportPython`
- `systemPython`
- 相关脚本是否存在

如果这些都不正常，先修环境，再排业务问题。

---

## 5. 当前自动化测试

当前自动化测试覆盖还比较薄，只覆盖了最近高风险功能。

### 5.1 已有测试命令

```bash
npm run test:dxf-draw
npm run test:floorplan
```

### 5.2 当前测试文件

- [tests/dxf-draw-topology.test.mjs](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/tests/dxf-draw-topology.test.mjs)
  - DXF 端点拓扑、约束线、断链、共享端点联动

- [tests/job-result.test.mjs](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/tests/job-result.test.mjs)
  - Python 作业 stdout 结果解析

- [tests/extract_floorplan_regression.py](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/tests/extract_floorplan_regression.py)
  - Auto Extract 脚本回归

### 5.3 还没有自动覆盖的高风险链路

- viewer 主流程
- scanner project 打开 / 切换
- CRS / grid 全链路
- minimap / photo / trajectory 联动
- volume / delete-region / profile 主交互
- terrain 多步工作流的大部分流程

结论：

- 现在仍然必须保留手工回归
- 自动化测试只能兜住最近修过的关键点

---

## 6. 目录地图

## 6.1 顶层源码与入口

| 路径 | 用途 |
| --- | --- |
| `viewer.html` | 主 viewer 页面，仍含大量 legacy 逻辑 |
| `index.html` | 首页 / 打开入口 |
| `gaussian-viewer.html` | Gaussian viewer 页面 |
| `server.js` | 主后端入口 |
| `package.json` | Node 依赖与脚本 |
| `assets/app/` | 渐进式模块化前端 |
| `scripts/` | Python 分析与导出脚本 |
| `tests/` | 当前少量回归测试 |
| `lib/` | 少量共享辅助模块 |

## 6.2 前端模块目录

```text
assets/app/
├── core/       环境、状态、i18n、格式化、DOM 辅助
├── entry/      页面入口与 legacy 桥接
├── services/   前端 API client
├── ui/         通用 UI 反馈
└── features/   功能模块
```

当前 `features/` 里最关键的模块：

- `open/`
- `open-load-orchestration/`
- `scene-tree/`
- `scanner-runtime/`
- `scanner-info/`
- `measurement/`
- `profile/`
- `volume/`
- `clip-box/`
- `delete-region/`
- `dxf/`
- `dxf-draw/`
- `terrain/`
- `export-las/`

其中高风险区主要是：

- `features/dxf-draw/index.js`
- `features/terrain/index.js`
- `features/scanner-runtime/index.js`

## 6.3 运行时数据目录

这些目录不是普通源码，而是运行时数据/产物目录。

| 目录 | 用途 | 注意点 |
| --- | --- | --- |
| `uploads/` | 上传原始文件 | 可能被当成兜底源路径 |
| `pointclouds/` | Potree 可直接加载的点云目录 | 可能有 `source.json`，也可能没有 |
| `projects/` | 扫描项目原始目录 | 真实源 LAS 常在这里 |
| `gaussians/` | Gaussian 数据 | 与点云链路分离 |
| `exports/` | 导出结果 | 会做过期清理 |
| `cache/` | 本地缓存、CRS/格网、本地导入 registry | 很多“行为不一致”问题在这里 |
| `floorplan_jobs/` | Auto Extract 产物 | 包含 preview 图 |
| `dtm_jobs/` | DTM 任务产物 | 大文件 |
| `surface_jobs/` | 表面任务产物 | 大文件 |
| `volume_surface_jobs/` | 体积表面任务产物 | 大文件 |
| `contour_jobs/` | 等高线任务产物 | 大文件 |
| `.venv/` | Python 运行时环境 | 服务端任务高度依赖 |

### 关键控制文件

这些文件比目录本身更值得优先检查：

- `scan_roots.json`
- `cache/desktop-local-imports.json`
- `pointclouds/<cloudName>/source.json`
- `cache/grid-registry.json`
- `cache/crs-cache.json`

---

## 7. 当前功能边界

## 7.1 稳定主链

当前实际可长期维护的主链包括：

- viewer 打开点云 / scanner 项目
- scene tree
- measurement
- DXF 导入
- DXF 绘图
- Auto Extract(Beta)
- 点云导出
- volume surface 已启用链路
- scanner runtime 基础功能

## 7.2 部分功能存在环境或默认禁用边界

代码里存在但不一定默认启用或完全打通的链路包括：

- DTM / surface / contour 的部分接口
- ground classification / HAG / rule-based classification / tree segmentation
- forestry 系列接口

注意：

- 有些接口会直接返回 disabled / 503
- 不要看到“代码里有路由、有脚本名”就默认功能可用

特别提醒：

- `server.js` 当前仍引用部分 forestry 脚本名，但 `scripts/` 目录并不完整存在对应文件
- 启用林业链前，必须先核对脚本是否真实存在

---

## 8. 排障顺序建议

## 8.1 页面能开，但按钮/工具没反应

优先看：

- `viewer.html`
- `assets/app/entry/viewer-entry.js`
- 对应 `features/*`

重点查：

- DOM id 是否改了
- feature 是否在 `viewer-entry.js` 注册
- legacy fallback 是否仍在走旧逻辑

## 8.2 打开数据后用错源 LAS / 跑错项目

优先看：

- `server.js`
  - `resolveBestLasPathForContext()`
  - `readUploadSourceManifest()`
  - `getCloudSourceFiles()`
  - `localImportRegistry`

重点查：

- `activeDatasetContext`
- `projectId`
- `cloudName`
- `source.json`
- `cache/desktop-local-imports.json`

## 8.3 DXF 绘图吸附 / 断链 / 水平垂直线异常

优先看：

- `assets/app/features/dxf-draw/index.js`
- `assets/app/features/dxf-draw/topology.js`
- `potree/src/utils/Measure.js`
- `potree/src/utils/MeasuringTool.js`
- `potree/src/navigation/InputHandler.js`
- `CloudStudio_DXF绘图与自动提取模块交接说明.md`

## 8.4 Auto Extract(Beta) 点了没结果

优先看：

- 前端：
  - `assets/app/features/dxf-draw/index.js`
  - `floorplanResult`
  - `floorplanConfig`
  - `requestFloorplanExtraction()`
- 后端：
  - `/api/floorplan/extract`
  - `resolveBestLasPathForContext()`
  - `lib/job-result.js`
- Python：
  - `scripts/extract_floorplan.py`
- 产物：
  - `floorplan_jobs/<jobId>/floorplan_preview.png`

快速判断顺序：

1. `sourcePath` 对不对
2. Python 是否 traceback
3. stdout 最后一行是否是 JSON / `RESULT:{...}`
4. 前端拿到的 `segments/stats/debugImages` 是不是空

## 8.5 scanner / CRS / 多项目叠加问题

优先看：

- `STATE_MAP.md`
- `features/open-load-orchestration/index.js`
- `features/scanner-runtime/index.js`
- `features/scanner-info/index.js`
- `features/minimap/index.js`
- `features/photo/index.js`

---

## 9. 关键文档索引

接手顺序建议：

1. [README.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/README.md)
2. [STATE_MAP.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/STATE_MAP.md)
3. [CODEBASE_MAP.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/CODEBASE_MAP.md)
4. [../MIGRATION_WINDOWS_TO_SERVER.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/MIGRATION_WINDOWS_TO_SERVER.md)
5. [../DEPLOY_SOP.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/DEPLOY_SOP.md)
6. [../CloudStudio_DXF绘图与自动提取模块交接说明.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/CloudStudio_DXF绘图与自动提取模块交接说明.md)

其它有价值文档：

- [MEASUREMENT_SPLIT_PLAN.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/MEASUREMENT_SPLIT_PLAN.md)
- [../项目技术说明文档.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/项目技术说明文档.md)
- [../DEPLOY.md](/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/DEPLOY.md)

---

## 10. 当前接手建议

如果你是新接手的开发者或 AI agent，推荐这样读代码：

1. 先看 `viewer.html`
   - 看状态初始化块
   - 看 feature 初始化
   - 看 `setTool()`、`setActiveDatasetContext()`、scanner 相关 helper

2. 再看 `viewer-entry.js`
   - 理解 feature 如何注入

3. 再看 `STATE_MAP.md`
   - 建立状态归属感

4. 再按问题进入 feature
   - DXF：`features/dxf-draw/`
   - 导出：`features/export-las/`
   - terrain：`features/terrain/`
   - scanner：`features/scanner-runtime/`
   - measurement：`features/measurement/`

---

## 11. 当前 README 与旧版相比的变化

这版 README 相比旧版，主要做了这些纠正：

- 去掉了大量已经过时的 Phase 迁移日报式内容
- 去掉了不再准确的绝对路径与旧环境假设
- 去掉了“生产就绪 / 全功能稳定”的过度描述
- 补上了当前真实结构：
  - legacy + feature 双轨
  - `server.js` 单文件后端
  - 运行时数据目录与控制文件
  - 当前自动化测试范围
  - Auto Extract / DXF / scanner / terrain 的实际排障入口

---

## 12. 一句话总结

当前维护这个项目，最重要的不是“知道某个文件在哪”，而是知道：

- 这个问题属于前端壳层、legacy runtime、Potree 内核、后端 API、Python 任务、还是运行时数据目录；
- 然后再沿着那条真实链路去找，而不是只盯一个文件修。
