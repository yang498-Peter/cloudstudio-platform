# CloudStudio `web-uploader` 代码地图

最后人工整理日期：2026-04-09  
适用范围：`/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader` 及其与上层 `potree/`、`PotreeConverter/` 的关联  
目标读者：新接手的程序员、排障人员、后续 AI agent

---

## 0. 这份文档怎么用

这不是产品介绍文档，而是长期维护用的“代码地图 + 接手手册 + 排障索引”。

建议用法：

1. 先看“第 1 节 项目全景”和“第 2 节 快速入口”。
2. 再按你要修的问题去看“第 6 节 常见问题快速定位”。
3. 如果涉及状态联动，优先同时看：
   - `viewer.html`
   - `assets/app/entry/viewer-entry.js`
   - 对应 `assets/app/features/*`
   - `STATE_MAP.md`
4. 如果涉及算法、导出、地形、自动提取，优先同时看：
   - `server.js`
   - `scripts/*.py`
   - 对应运行产物目录（如 `floorplan_jobs/`、`dtm_jobs/`）

维护约定：

- 每次修改功能后，至少更新：
  - “第 7 节 最近修改记录”
  - “第 8 节 坑点 / 注意事项”
  - “第 9 节 维护模板”
- 如果新增一个独立功能模块，要补到：
  - “第 3 节 前端代码地图”或“第 4 节 后端代码地图”
  - “第 5 节 运行时目录地图”

---

## 1. 项目全景

这个仓库本质上是三层组合：

```text
cloudstudio-server/
├── web-uploader/       主业务应用：Express + viewer 页面 + 功能模块 + Python 任务
├── potree/             Potree 渲染引擎源码与定制版运行时
└── PotreeConverter/    点云转换工具
```

### 1.1 三层职责

- `web-uploader/`
  - 项目真正的业务入口。
  - 包含上传、查看、DXF、测量、导出、自动提取、地形/林业流程等。
  - 也是后续维护最常改的目录。
  - 运行时统一托管 `potree/`、`pointclouds/`、`projects/`、`assets/` 等静态路径。

- `potree/`
  - 提供底层点云渲染、测量、拖拽、交互、材质、导航等能力。
  - 一些业务功能依赖 Potree 原生对象和事件模型，尤其是：
    - `Measure`
    - `MeasuringTool`
    - `InputHandler`
  - 这里的行为一旦变化，`web-uploader/assets/app/features/*` 很容易连带出问题。

- `PotreeConverter/`
  - 把原始点云转换为 Potree 可浏览格式。
  - 通常不直接参与 viewer 前端交互问题，但会影响上传后能否生成 `metadata.json`、`octree.bin` 等。
  - 是 vendored 的独立上游工具仓库，升级它要按第三方内核升级看待。

### 1.2 当前项目的真实架构状态

项目不是“纯模块化前端 + 清爽 API 层”的状态，而是“新旧结构混合”：

- `viewer.html` 仍然很大，保留大量历史内联逻辑。
- `assets/app/entry/viewer-entry.js` 开始把功能逐步模块化，但最终仍通过 `loadLegacyInlineModule()` 把 legacy inline module 挂回页面。
- `server.js` 是单文件大后端，承担：
  - 路由注册
  - 数据源解析
  - 任务调度
  - 文件系统管理
  - Python 配置作业启动
  - 静态资源服务

所以接手时不要假设“所有逻辑都已经拆干净”。

---

## 2. 快速入口

### 2.1 先看这些文件

- `server.js`
  - 后端主入口，所有 API 和大多数目录/任务逻辑都在这里。

- `viewer.html`
  - 3D viewer 主页面。
  - 页面 DOM、工具栏、很多 legacy 逻辑仍在这里。

- `assets/app/entry/viewer-entry.js`
  - 新前端入口。
  - 注册功能模块、共享状态壳、API client、反馈 UI。

- `assets/app/features/`
  - 当前前端功能拆分的主战场。

- `STATE_MAP.md`
  - viewer 状态地图，适合排查“为什么改 A 会影响 B”。

- `MEASUREMENT_SPLIT_PLAN.md`
  - 测量模块拆分计划，适合准备继续重构时参考。

- `../CloudStudio_DXF绘图与自动提取模块交接说明.md`
  - DXF 和 Auto Extract 的专项交接文档。

- `README.md`
  - 当前项目演进历史、迁移阶段、一些真实踩坑说明。

- `../MIGRATION_WINDOWS_TO_SERVER.md`
  - 解释当前代码里很多 desktop / Windows 迁移残留为什么还存在。
  - 看到“像死代码但又不敢删”的分支时先看这份文档。

### 2.2 启动与测试

常用命令：

```bash
npm start
npm run start:local
npm run test:dxf-draw
npm run test:floorplan
```

说明：

- `npm start`
  - 直接起 `server.js`。
- `npm run start:local`
  - 走本地 runner，通常更适合开发环境。
- `npm run test:dxf-draw`
  - DXF 绘图拓扑/吸附/断链回归测试。
- `npm run test:floorplan`
  - Auto Extract 结果解析与脚本回归测试。

页面入口：

- `/`
  - 首页
- `/viewer`
  - 点云查看器主入口
- `/gaussian-viewer`
  - Gaussian viewer
- `/health`
  - 健康检查入口，先看 `converter / exportPython / systemPython / scripts`

---

## 3. 前端代码地图

## 3.1 顶层结构

```text
assets/app/
├── core/       共享基础能力：环境、状态、格式化、i18n、DOM/常量
├── entry/      页面入口与 legacy 桥接
├── services/   前端 API client
├── ui/         通用 UI 反馈
└── features/   功能模块
```

### 3.1.1 `core/`

- `core/env.js`
  - 页面环境识别。
- `core/i18n.js`
  - 共享语言初始化与翻译桥。
- `core/state.js`
  - `createAppShell()`，保存 `services / globals / domains`。
  - 新模块化状态承载入口。
- `core/formatters.js`
  - 数字/坐标/单位等格式化。
- `core/dom.js`
  - DOM 相关辅助。
- `core/constants.js`
  - 共用常量。

### 3.1.2 `entry/`

- `entry/viewer-entry.js`
  - viewer 页面模块化入口。
  - 负责：
    - 初始化环境与 i18n
    - 创建 `appShell`
    - 创建 `apiClient`
    - 注入 `window.__APP_*` 全局桥
    - 注册所有 `create*Feature`
    - 通过 `loadLegacyInlineModule()` 加载 `viewer.html` 中的 legacy inline module

- `entry/load-legacy-inline-module.js`
  - 新旧前端桥接关键点。
  - 从页面中的 `<script>` 源文本构造 module 脚本再执行。
  - 任何“为什么 feature 明明写好了却还依赖 window/global”的问题，都要想到这里。
  - 这也说明当前前端仍是 legacy 主程序 + feature 壳层并存，而不是彻底模块化。

- `entry/index-entry.js`
  - 首页入口。

### 3.1.3 `services/`

- `services/api-client.js`
  - 前端统一 fetch 封装。
  - 负责 `getJson / postJson / getText / postForm`。
  - 新 feature 如果要走后端，优先复用这里，而不是在模块里自己造 fetch 包装。

### 3.1.4 `ui/`

- `ui/feedback.js`
  - toast、状态栏等基础反馈 UI。

## 3.2 `features/` 功能模块地图

这里是现在接手时最重要的目录。

### 文件与职责总览

| 路径 | 主要职责 | 关键注意点 |
| --- | --- | --- |
| `features/open/open-modal.js` | 打开点云 / 扫描项目 / 网格文件等的入口 UI | 与后端 `/api/clouds`、`/api/scan-projects`、本地导入逻辑相关 |
| `features/open-load-orchestration/index.js` | 负责加载后的上下文切换、状态同步、场景清理 | 任何“打开 A 影响 B”的问题都要看这里 |
| `features/scene-tree/index.js` | 左侧场景树 | 负责云、测量、体素/面层等对象展示与删除 |
| `features/display-settings/index.js` | 点预算、FOV、EDL 等显示设置 | 对 Potree viewer 参数直接生效 |
| `features/scanner-info/index.js` | 扫描项目的信息面板 | 依赖 `geo_info.csv`、metadata、坐标系解析 |
| `features/scanner-runtime/index.js` | 扫描项目运行时、CRS、格网、相机/轨迹联动 | 强状态联动区，高风险 |
| `features/minimap/index.js` | 小地图 / basemap / 轨迹投影 | 涉及坐标转换与 tile 缓存 |
| `features/photo/index.js` | 照片/相机可视化与飞行 | 与 scanner 项目照片资源和相机轨迹耦合 |
| `features/capture/index.js` | 点位采集、导出采集结果 | 依赖当前坐标系统 |
| `features/measurement/index.js` | 非 DXF 的测量面板 | 仍与 Potree measurement runtime 有深绑定 |
| `features/profile/index.js` | 剖面工具与剖面面板 | 与 profile runtime、clip 联动强 |
| `features/volume/index.js` | 体积/裁剪/删除区域面板 | 与 clip box、delete region、scene-tree 联动 |
| `features/clip-box/index.js` | Clip Box UI 与交互配置 | 直接影响 volume/clip 状态 |
| `features/delete-region/index.js` | 删除区域面板 | 与导出、地形、体积流程存在数据耦合 |
| `features/dxf/index.js` | DXF 导入、文件列表、图层可见性 | 只管导入侧，不管绘图侧 |
| `features/dxf-draw/index.js` | DXF 绘图、端点吸附/连接、约束线、Auto Extract | 当前单文件很大，是近期高改动区 |
| `features/dxf-draw/topology.js` | DXF 绘图纯算法辅助 | 端点约束、拓扑判断、测试都依赖这里 |
| `features/export-las/index.js` | LAS/LAZ/格式导出 UI | 与坐标系、delete region、source resolution 高耦合 |
| `features/terrain/index.js` | DTM、地表、等高线、HAG、分类、树分割等流程 | 功能最多、后端任务链最长 |
| `features/magnifier/index.js` | 鼠标放大镜 | 局部 UI 功能，低风险 |

### 特别高风险的前端文件

- `viewer.html`
  - 仍然是 UI 结构和 legacy 逻辑中心。
  - 改 DOM id/class 时，很容易把 feature 模块一起打断。

- `assets/app/entry/viewer-entry.js`
  - feature 注册入口。
  - 少注册一个 feature，页面上对应功能会“静默消失”。

- `assets/app/features/dxf-draw/index.js`
  - 体量大、交互复杂、与 Potree runtime/scene 对象强耦合。

- `assets/app/features/terrain/index.js`
  - 牵涉后端任务、结果回读、预览层、场景树、scanner context。

- `assets/app/features/scanner-runtime/index.js`
  - 坐标系统、格网、项目选择联动集中地。

---

## 4. 后端与脚本代码地图

## 4.1 `server.js` 的职责分层

`server.js` 是当前最大的维护点。它同时承担：

- 静态页面服务
- 上传与本地导入
- 扫描项目发现与注册
- 点云源路径解析
- CRS/格网接口
- Python 作业调度
- 结果下载与静态结果目录暴露
- 部分作业状态管理

### 主要常量目录

在 `server.js` 顶部可以看到这些关键目录常量：

- `UPLOADS_DIR`
- `POINTCLOUDS_DIR`
- `GAUSSIANS_DIR`
- `PROJECTS_DIR`
- `EXPORTS_DIR`
- `CACHE_DIR`
- `GRID_STORAGE_DIR`
- 各类 `*_SCRIPT`

修改这些常量会影响整条链路，不只是单个功能。

### API 大致分组

`server.js` 当前路由可以按下面理解：

#### A. 扫描项目 / 数据发现

- `/api/scan-projects`
- `/api/scan-projects/photos`
- `/api/scan-projects/register`
- `/api/scan-roots`
- `/api/find-las`
- `/api/project-dir`
- `/api/clouds`
- `/api/cloud-source`

#### B. 上传 / 导入

- `/api/upload`
- `/api/upload-project`
- `/api/upload-preconverted`
- `/api/upload-gaussian`
- `/api/upload-by-path`

#### C. CRS / 格网 / 坐标转换

- `/api/scan-projects/crs`
- `/api/crs/resolve`
- `/api/crs/search`
- `/api/grids`
- `/api/grids/import`
- `/api/crs/transform`

#### D. 导出

- `/api/export-sources`
- `/api/export-pointcloud`
- `/api/export-las`

#### E. 自动提取 / 地形 / 表面 / 等高线

- `/api/floorplan/extract`
- `/api/generate-dtm`
- `/api/download-dtm`
- `/api/generate-surface`
- `/api/surface-mesh`
- `/api/surface-grid`
- `/api/generate-volume-surface`
- `/api/volume-surface-mesh`
- `/api/volume-surface-grid`
- `/api/generate-contours`
- `/api/contour-geojson`

#### F. 分类 / 林业流水线

- `/api/classify-ground`
- `/api/generate-hag`
- `/api/compute-geometric-features`
- `/api/classify-rule-based`
- `/api/segment-individual-trees`
- `/api/run-semantic-pipeline`
- `/api/forestry/*`

#### G. 其它

- `/api/mesh-file`
- `/api/delete-cloud`
- `/health`
- `/viewer`
- `/gaussian-viewer`

## 4.2 `lib/`

- `lib/job-result.js`
  - Python 作业 stdout 结果解析辅助。
  - 当前支持两种输出格式：
    - 纯 JSON 行
    - `RESULT:{...}` 前缀行
  - 如果以后 Python 脚本结果返回又变“成功但前端拿空对象”，先检查这里。

## 4.3 `scripts/` Python 脚本地图

| 脚本 | 大致用途 | 常见触发 API / 功能 |
| --- | --- | --- |
| `extract_floorplan.py` | Auto Extract(Beta) 自动提取墙线 | `/api/floorplan/extract` |
| `export_pointcloud.py` | 点云导出 | `/api/export-pointcloud` |
| `export_las.py` | LAS/LAZ 导出与坐标处理 | `/api/export-las` |
| `transform_coords.py` | 坐标转换 | `/api/crs/transform` |
| `grid_probe.py` | 格网探测/验证 | `/api/grids/import` 相关 |
| `generate_dtm.py` | 生成 DTM | `/api/generate-dtm` |
| `generate_surface_mesh.py` | 生成表面网格 | `/api/generate-surface` |
| `generate_volume_surface.py` | 体积区域表面 | `/api/generate-volume-surface` |
| `generate_contours.py` | 等高线 | `/api/generate-contours` |
| `classify_ground.py` | 地面分类 | `/api/classify-ground` |
| `generate_hag.py` | HAG | `/api/generate-hag` |
| `compute_geometric_features.py` | 几何特征计算 | `/api/compute-geometric-features` |
| `classify_rule_based.py` | 规则分类 | `/api/classify-rule-based` |
| `segment_individual_trees.py` | 单木分割 | `/api/segment-individual-trees` |
| `sanitize_for_potree.py` | Potree 转换前清理 | 上传/转换链路 |

### 维护建议

- 脚本输出建议统一保留 `RESULT:{...}` 风格。
- 任何脚本异常都应该保证最后能输出一个结构化错误 JSON，否则后端难以稳定解析。
- 脚本对 Python 依赖较重，默认应走 `web-uploader/.venv/bin/python`，不要假设系统 `python3` 具备同样依赖。
- `server.js` 当前仍存在林业相关脚本引用与 `scripts/` 目录文件不完全对齐的风险，启用林业链前先核对对应脚本是否真实存在。

---

## 5. 运行时目录地图

这些目录很多是“数据目录”或“任务产物目录”，不是普通源码目录。

| 目录 | 用途 | 维护注意点 |
| --- | --- | --- |
| `uploads/` | 上传的原始文件 | 不要和 `pointclouds/` 混淆 |
| `pointclouds/` | viewer 可直接打开的 Potree 点云目录 | 里面可能有 `source.json`，也可能没有 |
| `projects/` | 扫描项目原始目录 | 经常同时包含 `colorized.las`、轨迹、照片、坐标文件 |
| `gaussians/` | Gaussian viewer 数据 | 与 Potree 点云链路不同 |
| `exports/` | 导出结果 | 清理前确认是否仍被引用 |
| `cache/` | 本地缓存、CRS 缓存、格网注册等 | 很多“环境问题”出在这里 |
| `floorplan_jobs/` | Auto Extract 输出目录 | 会有 `floorplan_preview.png` 与 job config |
| `dtm_jobs/` | DTM 任务产物 | 大文件，注意磁盘占用 |
| `surface_jobs/` | 表面任务产物 | 同上 |
| `volume_surface_jobs/` | 体积表面任务产物 | 同上 |
| `contour_jobs/` | 等高线任务产物 | 同上 |
| `.venv/` | Python 虚拟环境 | 后端任务依赖这里 |

### 重点提醒

- `pointclouds/<cloudName>/` 和 `projects/<projectId>/` 不是同一层概念。
- 很多功能需要“追溯回原始 LAS/LAZ”，所以不能只看 `pointclouds/` 是否存在。
- 如果 `cloudName` 与 `projectId` 同名，优先确认当前代码是否应该使用项目原始数据还是上传源数据。

---

## 6. 常见问题快速定位

## 6.1 viewer 页面能开，但某个功能按钮没反应

优先看：

- `viewer.html`
- `assets/app/entry/viewer-entry.js`
- 对应 `features/<name>/index.js`
- 浏览器控制台

重点排查：

- DOM id / class 是否被改了
- feature 是否在 `viewer-entry.js` 注册
- legacy inline module 是否仍引用旧全局名

## 6.2 打开点云后载入错数据 / 用错原始 LAS

优先看：

- `server.js`
  - `resolveBestLasPathForContext()`
  - `readUploadSourceManifest()`
  - `getCloudSourceFiles()`
  - 本地导入 registry 相关函数

风险点：

- `cloudName`、`projectId`、`originalPath` 三者可能不一致
- `pointclouds/<name>/source.json` 可能没有
- 历史本地导入映射可能把当前 cloudName 串到旧项目

## 6.3 DXF 绘图端点吸附 / 断链 / 水平线手感异常

优先看：

- `assets/app/features/dxf-draw/index.js`
- `assets/app/features/dxf-draw/topology.js`
- `potree/src/utils/Measure.js`
- `potree/src/utils/MeasuringTool.js`
- `potree/src/navigation/InputHandler.js`
- `../CloudStudio_DXF绘图与自动提取模块交接说明.md`

重点排查：

- 是“绘制新线”的吸附问题，还是“编辑已有线”的吸附问题
- 是显示逻辑问题，还是最终落点逻辑问题
- 是否存在 stale link group 没拆掉

## 6.4 Auto Extract(Beta) 点了没结果 / 结果为空

优先看：

- 前端：
  - `assets/app/features/dxf-draw/index.js`
  - `requestFloorplanExtraction()`
- 后端：
  - `server.js`
  - `/api/floorplan/extract`
  - `resolveBestLasPathForContext()`
  - `readLastJsonLine()`，现在已迁到 `lib/job-result.js`
- Python：
  - `scripts/extract_floorplan.py`
- 输出目录：
  - `floorplan_jobs/`

快速判断顺序：

1. 返回的是 HTTP 错误还是 `ok: true` 但 `segments` 空？
2. `sourcePath` 是否真的是你期望的数据源？
3. `floorplan_jobs/<jobId>/floorplan_preview.png` 是否存在？
4. Python 脚本 stderr 是否有 traceback？

## 6.5 导出 / 地形 / 分类任务失败

优先看：

- `server.js` 对应 API
- `scripts/*.py`
- 对应 jobs 目录
- `.venv/` 依赖是否完整

## 6.6 多项目叠加、轨迹/照片/坐标系联动奇怪

优先看：

- `STATE_MAP.md`
- `features/open-load-orchestration/index.js`
- `features/scanner-runtime/index.js`
- `features/scanner-info/index.js`
- `features/minimap/index.js`
- `features/photo/index.js`

---

## 7. 最近修改记录

## 7.1 2026-04-09：DXF 绘图体验与稳定性修复

涉及文件：

- `assets/app/features/dxf-draw/index.js`
- `assets/app/features/dxf-draw/topology.js`
- `tests/dxf-draw-topology.test.mjs`
- `package.json`

修改内容：

- 修复水平/垂直线在断开后仍然藕断丝连的问题。
- 端点拓扑改为按几何位置重分组，而不是只记历史连接。
- 修复共享端点拖动与断链后的联动逻辑。
- 绘制新线时，拖拽过程中视觉上就真正吸附到候选端点，而不是只高亮。
- `Auto Extract(Beta)` 面板在 DXF UI 中改到最底部，避免夹在绘制功能中间。

新增测试：

- `npm run test:dxf-draw`

## 7.2 2026-04-09：Auto Extract(Beta) 整链路修复

涉及文件：

- `scripts/extract_floorplan.py`
- `server.js`
- `lib/job-result.js`
- `tests/job-result.test.mjs`
- `tests/extract_floorplan_regression.py`
- `package.json`

修改内容：

- 修复 `merge_positions()` 对 generator 调用 `len()` 导致脚本直接失败的问题。
- 修复 `cloudName` 指向错误原始 LAS 的问题：同名 scanner project 现在优先匹配自身项目原始数据。
- 修复 Python 脚本输出 `RESULT:{...}` 时后端没有正确解析，导致接口看似成功但 `segments/stats` 为空的问题。
- 整理 `extract_floorplan.py` 的导入与旋转逻辑，消除运行时告警。
- 用 `house` 数据真实验收：
  - 数据源：`projects/2026-03-05_10-58-54_-_house/colorized.las`
  - 候选段：39
  - 角点：7
  - 预览图：1

新增测试：

- `npm run test:floorplan`

## 7.3 当前最近新增/变更文件清单

- `CODEBASE_MAP.md`
- `STATE_MAP.md`
- `assets/app/features/dxf-draw/topology.js`
- `lib/job-result.js`
- `tests/dxf-draw-topology.test.mjs`
- `tests/job-result.test.mjs`
- `tests/extract_floorplan_regression.py`
- `tests/__init__.py`

## 7.4 2026-04-09：状态文档同步到当前现状

涉及文件：

- `STATE_MAP.md`
- `CODEBASE_MAP.md`

修改内容：

- 重写 `STATE_MAP.md`，按当前真实生效的状态层次重新梳理：
  - `viewer.ui`
  - `viewer.datasetContext`
  - `viewer.scannerSelection`
  - `viewer.displaySettings`
  - `viewer.crsCatalog`
  - `viewer.scannerRegistry`
- 把 `profileState`、`deleteSelectionState`、`volumeMeasureState`、`clipBoxState`、DXF Draw 和 terrain 的 feature 私有状态补进正式状态地图。
- 明确 `scannerSelectionState.selectedProjectId` 已是当前 scanner 主选中源。
- 明确 `scannerState` Proxy 仍然是当前最大状态理解风险点。
- 同步更新 `CODEBASE_MAP.md` 中对 `STATE_MAP.md` 的描述、接手顺序和注意事项。

---

## 8. 坑点 / 注意事项 / 小技巧

## 8.1 不要把 `pointclouds/` 当成唯一真相

很多业务需要回溯原始 LAS/LAZ，真正的“源文件真相”可能在：

- `projects/<projectId>/`
- `pointclouds/<cloudName>/source.json`
- 本地导入 registry

错误的 source resolution 会让算法在“看起来正常”的情况下跑错数据。

## 8.2 `viewer.html` 仍是高风险文件

虽然 feature 已经拆到 `assets/app/features/`，但页面结构和大量运行时桥接仍在 `viewer.html`。

经验：

- 改 DOM id 前，先全局搜这个 id。
- 改工具栏/面板结构时，要同时验证 feature 是否还能 `bindControls()`。

## 8.3 `server.js` 是单文件大后端

不要在没搜清 helper 的前提下直接复制逻辑。

尤其先搜这些名字：

- `resolveBestLasPathForContext`
- `readUploadSourceManifest`
- `getCloudSourceFiles`
- `runPythonConfigJob`
- `sendApiError`
- `readLastJsonLine`

## 8.4 Windows / desktop 迁移残留仍然存在

当前代码仍保留：

- `desktop-local-*`
- desktop dialog 相关逻辑
- Windows PowerShell 探测
- 本地导入 registry 语义

这不代表主链路仍然是桌面版，而是历史迁移没有完全删除。  
看到这类代码先查 `MIGRATION_WINDOWS_TO_SERVER.md`，不要直接当死代码清掉。

## 8.5 Python 任务不要默认用系统 `python3`

当前很多脚本依赖 `web-uploader/.venv/bin/python` 中的包。

经验：

- 手工复现脚本问题时，先确认你用的是不是与服务一致的 Python。
- 如果系统 `python3` 跑不起来，不代表服务环境就坏了。

## 8.6 Auto Extract 的结果链路分三段

不要只看其中一段。

要同时确认：

1. 前端是否发对 payload
2. 后端是否选对 `sourcePath`
3. 脚本是否输出结构化结果
4. 后端是否把 stdout 解析回 JSON
5. 前端是否把 `segments/debugImages/stats` 正确渲染

## 8.7 DXF 绘图问题经常不是单点问题

一个“端点吸附异常”，可能同时涉及：

- `dxf-draw/index.js`
- `dxf-draw/topology.js`
- Potree `Measure`
- Potree `InputHandler`
- viewer 当前是否处于 `drawing` 状态

## 8.8 `potree/` 与 `PotreeConverter/` 不是普通业务目录

这两个目录都带独立上游属性，且仓库里自带 `.git`。

经验：

- 不要把业务 bug 的第一反应放在升级内核。
- 真要改这里，先确认问题不是 `viewer.html` 或 `features/*` 的二次封装引起。
- 升级前必须先看静态资源路径、API 兼容性、转换器输出兼容性。

## 8.9 运行产物目录会越来越大

重点关注：

- `dtm_jobs/`
- `surface_jobs/`
- `volume_surface_jobs/`
- `contour_jobs/`
- `floorplan_jobs/`

清理前先确认是否仍需要下载或回溯。

## 8.10 现在的测试覆盖还不高

目前已有的自动回归更偏“近期高风险功能”：

- DXF 绘图拓扑
- Auto Extract 结果解析与脚本回归

其余大部分功能仍主要靠手工回归。

---

## 9. 维护模板

## 9.1 每次修改后至少补这一段

建议在“第 7 节 最近修改记录”追加：

```md
## YYYY-MM-DD：修改标题

涉及文件：

- 路径 A
- 路径 B

修改内容：

- 做了什么
- 修了什么
- 有没有影响相邻模块

验证：

- 命令 1
- 命令 2
- 手工回归场景

风险 / 备注：

- 仍未覆盖的边界
- 下次容易踩坑的点
```

## 9.2 新增功能模块时要补的地方

新增前端 feature：

- “第 3 节 前端代码地图”
- “第 6 节 常见问题快速定位”

新增后端 API / Python 脚本：

- “第 4 节 后端与脚本代码地图”
- “第 5 节 运行时目录地图”

新增长期状态联动：

- `STATE_MAP.md`

新增专项复杂子系统：

- 单独再写一份专项交接文档，类似 DXF 交接说明

---

## 10. 相关文档索引

- `README.md`
  - 项目概览、迁移历史、部分高风险说明
- `../MIGRATION_WINDOWS_TO_SERVER.md`
  - Windows / desktop 迁移背景与残留语义说明
- `STATE_MAP.md`
  - viewer 状态地图
- `MEASUREMENT_SPLIT_PLAN.md`
  - measurement 后续拆分路线
- `../CloudStudio_DXF绘图与自动提取模块交接说明.md`
  - DXF 与 Auto Extract 的专项说明
- `../项目技术说明文档.md`
  - 项目整体说明
- `../DEPLOY.md`
  - 部署指南
- `../DEPLOY_SOP.md`
  - 生产维护 SOP

---

## 11. 一句话总结

如果你只记住一件事：

这个项目的真实维护难点，不是“某个功能文件太长”，而是“viewer 前端、Potree runtime、server.js、Python 任务、运行时数据目录”五层一起联动。  
排障时一定要先确定问题属于哪一层，再确认它和哪几层有耦合，不要只盯着一个文件修。
