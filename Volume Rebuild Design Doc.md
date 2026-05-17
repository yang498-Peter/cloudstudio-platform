# Volume Rebuild Design Doc

最后更新：2026-04-23  
适用范围：`/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server`  
主实现目录：`/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader`

---

## 1. 背景与目标

当前软件的体积计算链路存在以下根本问题：

- 主计算仍依赖浏览器当前已加载的 `visibleNodes` 和前端抽样点，不依赖完整源数据。
- `Build Mesh` 与 `Compute Volume` 是两条不同口径的链路，客户看到的参考表面和最终体积结果并非严格同源。
- 边界格网按整格面积积分，边界误差和覆盖率误判明显。
- DTM / 地面样本逻辑不稳，分类、过滤、拟合地面等功能无法自然扩展。
- UI 无法清晰表达“本次体积到底是按哪张表面、哪种基准、哪种过滤规则计算出来的”。

### 1.1 重构目标

本次重构的目标不是简单修补现有逻辑，而是建立统一的体积分析引擎与可审计工作流：

1. 用户先圈选区域
2. 服务端基于完整 LAS/LAZ 数据构建分析面
3. 同时生成可视化 mesh，让客户先看到用于计算的参考表面
4. 基于同源分析面与基准面计算体积
5. 输出可解释、可核对、可导出的结果与参数

### 1.2 设计原则

- 统一口径：显示、计算、导出必须来自同一个 volume job。
- 服务端为准：体积结果不能依赖前端当前视角、点预算和加载完成度。
- 可审计：每次计算都要能回答“用了什么数据、什么参数、什么基准面、什么过滤规则”。
- 场景优先：围绕真实测量工作流设计，而不是围绕当前代码结构设计。
- 渐进替换：允许复用现有 selection、mesh 渲染、contour、导出等可用模块，但废弃前端直接积分主链。

---

## 2. 典型场景

### 2.1 堆体体积

典型对象：

- 料堆
- 土堆
- 砂石堆
- 建筑垃圾堆

目标：

- 计算堆体相对于地面的凸起体积
- 支持起伏地面，不要求底面必须是水平面
- 支持去除草、树、少量飞点

推荐模式：

- `stockpile_boundary`
- `stockpile_ground_fit`

### 2.2 平面 cut/fill

典型对象：

- 场地平整
- 指定标高土方
- 施工面相对参考高程的挖填方

目标：

- 相对一个常量高程平面计算 cut / fill / net

推荐模式：

- `plane_cut_fill`

### 2.3 地面拟合体积

典型对象：

- 起伏地面上的堆体
- 林地/草地上的土方
- 地表并不平整，但需要估算相对地表的净凸起体积

目标：

- 从区域内或邻域点云拟合地面基准面
- 可依赖分类 ground points，也可在无分类时退化到鲁棒地面近似

推荐模式：

- `ground_fit_volume`

### 2.4 两个表面之间的体积差

典型对象：

- 设计面 vs 实测面
- 施工前 vs 施工后
- 两次扫描对比

目标：

- 基于两张对齐的 surface 做标准 cut/fill

推荐模式：

- `surface_to_surface`

说明：

- 本阶段先把架构和数据结构预留出来，后续再补完整 UI。

---

## 3. 现状问题整理

### 3.1 当前主链路

当前体积主流程位于：

- `web-uploader/viewer.html`
- `web-uploader/assets/app/features/volume/index.js`
- `web-uploader/assets/app/features/volume/compute.js`

当前问题概括：

- 主计算函数 `computeVolumeRegion()` 在前端遍历 `pointcloud.visibleNodes` 做抽样积分。
- `buildLocalSurfaceForVolumeRegion()` 虽然能调用服务端生成局部 mesh，但并不是体积主计算的唯一来源。
- `computeVolumeRegionFromSurfaceGrid()` 已存在，但没有真正成为统一主链。

### 3.2 当前不应继续沿用的部分

- 前端按当前可见点直接计算体积
- 当前 `coverageRatio` 与 hole fill 混合后的定义
- 把边界整格按满面积积分
- 把结果强依赖浏览器当前加载状态

### 3.3 当前可复用的部分

- 区域圈选与 `volumeMeasureState`
- 体积区域 overlay / pick / boundary 交互
- terrain feature 中的 mesh 渲染能力
- contour 生成与导出链路
- 现有 Python 表面构建脚本中的部分点筛选、表面聚合、hole fill 工具函数

---

## 4. 目标架构

### 4.1 总体架构

新的体积模块统一为：

```text
区域选择
  -> 创建 Volume Region
  -> 提交 Volume Job（服务端）
  -> 构建 Analysis Surface
  -> 构建 Base Surface
  -> 计算 Delta / Cut / Fill / Net
  -> 返回 Result + Mesh + Grid + Meta
  -> 前端展示 mesh / 结果 / 诊断信息
```

### 4.2 核心对象

#### `VolumeRegion`

前端交互对象，表示用户画出的范围和本地 UI 状态。

职责：

- 保存 polygon、边界顶点、创建时间、当前 UI 配置
- 触发 volume job
- 展示结果和 3D 参考对象

#### `VolumeJob`

服务端计算对象，表示一次完整体积分析。

职责：

- 固定输入数据与参数
- 生成 analysis surface
- 生成 base surface
- 生成可视化 mesh
- 输出 volume result 与可审计元数据

#### `Analysis Surface`

用于表示被测对象表面的 canonical surface。

可能来源：

- 全部点
- 去除植被后的点
- ground-only 点
- robust percentile 聚合

#### `Base Surface`

用于和分析面做差的基准面。

可能模式：

- 常量高程面
- 边界橡皮膜面
- ground fit 面
- 外部导入设计面

### 4.3 统一口径

从本阶段开始，以下结果必须来自同一份 volume job：

- 面板中的体积值
- 3D 中显示的分析 mesh
- 3D 中显示的基准 mesh / plane
- contour / OBJ / JSON 导出
- 报告中的参数和统计信息

---

## 5. 场景模式设计

### 5.1 `stockpile_boundary`

定义：

- 分析面：区域内的目标表面
- 基准面：由 polygon 边界顶点高程生成的边界拟合面

适合：

- 常见料堆
- 地面有缓坡但变化不剧烈的场景

优点：

- 客户容易理解
- 不需要额外 ground classification 也可工作

风险：

- 边界点本身如果压在树、草、杂物上，会把基准面抬高

### 5.2 `plane_cut_fill`

定义：

- 分析面：区域内目标表面
- 基准面：常量高程平面

适合：

- 指定标高土方
- 平整度分析

优点：

- 简洁、稳定、可解释性强

风险：

- 不适合坡地上的堆体体积

### 5.3 `ground_fit_volume`

定义：

- 分析面：区域内目标表面
- 基准面：由 ground-only 点或地面拟合算法得到的地面面

适合：

- 起伏地面上的堆体
- 草地/林地/非平整硬化地面

优点：

- 更接近真实地表

风险：

- 对分类质量、地面提取质量敏感

### 5.4 `surface_to_surface`

定义：

- 分析面：目标表面 A
- 基准面：参考表面 B

适合：

- 设计面 vs 实测面
- 两期数据对比

备注：

- 本阶段先把 API 和数据结构预留，完整交互留待下一阶段。

---

## 6. 算法设计

## 6.1 总体算法流程

### Step 1. 数据读取

输入：

- LAS/LAZ 路径
- polygon 顶点
- 分辨率
- 场景模式
- 表面聚合模式
- 点过滤模式

要求：

- 必须基于完整源数据读取
- 不允许依赖浏览器当前已加载点

### Step 2. 点过滤

支持以下点过滤模式：

- `all`
- `exclude_vegetation`
- `exclude_vegetation_buildings`
- `ground_only`

过滤顺序建议：

1. 先按 bbox 粗裁
2. 再按 polygon 精裁
3. 再按 classification / filter mode 过滤
4. 再进入 surface aggregation

分类建议：

- ground: `2`
- low / medium / high vegetation: `3 / 4 / 5`
- building: `6`

备注：

- 若无分类数据，不能伪装成已过滤，只能明确标记为“未分类 fallback”。

### Step 3. 分析面构建

支持分析面模式：

- `stockpile`
- `dsm`
- `dtm`

推荐聚合：

- stockpile：`p80` / `p85` / `median`
- dsm：`max`
- dtm：`ground-only p20`，无 ground 分类时退化到 `all-point p20`

### Step 4. 基准面构建

#### 6.4.1 常量高程面

- 直接以 `referenceHeight` 作为所有 cell 的 base z

#### 6.4.2 边界拟合面

- 输入为 polygon 边界顶点的 3D 高程
- 在 polygon 内部对边界高程进行拟合
- 第一版使用 IDW / 边界约束插值
- 后续可升级为 TIN rubber-sheet

#### 6.4.3 Ground fit 面

- 优先使用 class-2 ground points 建立 base surface
- 若无 ground 分类，可退化为鲁棒地面近似

### Step 5. 边界裁剪与面积权重

当前整格积分误差较大，新方案中每个 cell 必须带有 `coverageRatio`。

第一版建议：

- 通过子采样估算 cell 与 polygon 的相交比例
- `effectiveArea = cellArea * coverageRatio`

后续升级：

- 用真实 polygon clipping 计算精确相交面积

### Step 6. 体积积分

对每个有效 cell：

- `delta = analysisZ - baseZ`
- `volume = delta * effectiveArea`

累计规则：

- `cutVolume += volume`，当 `delta > 0`
- `fillVolume += abs(volume)`，当 `delta < 0`
- `netVolume = fillVolume - cutVolume` 保持与当前 UI 兼容

补充：

- 文案上必须明确说明符号规则，避免客户理解偏差

### Step 7. 结果诊断

每次 volume job 都应输出：

- 原始采样点数
- 过滤后点数
- ground 点数
- 有效 cell 数
- 真实数据覆盖率
- 插值填补 cell 数
- boundary 部分面积占比
- fallback 标志
- 可信度等级

---

## 7. API 设计

## 7.1 新增主 API

### `POST /api/volume-jobs`

职责：

- 创建并执行一次统一 volume job

请求体建议：

```json
{
  "lasPath": "/abs/path/to/file.las",
  "polygon": [
    { "x": 0, "y": 0, "z": 10.2 },
    { "x": 10, "y": 0, "z": 10.4 },
    { "x": 10, "y": 8, "z": 10.1 }
  ],
  "resolution": 0.25,
  "scenarioMode": "stockpile_boundary",
  "analysisSurface": {
    "surfaceType": "stockpile",
    "aggregateMode": "p80",
    "pointFilterMode": "exclude_vegetation"
  },
  "baseSurface": {
    "mode": "boundary",
    "referenceHeight": null
  },
  "holeFillMode": "interpolate"
}
```

返回体建议：

```json
{
  "ok": true,
  "jobId": "vol_123",
  "resultUrl": "/api/volume-results?jobId=vol_123",
  "analysisMeshUrl": "/api/volume-mesh?jobId=vol_123&surface=analysis",
  "baseMeshUrl": "/api/volume-mesh?jobId=vol_123&surface=base",
  "analysisGridUrl": "/api/volume-grid?jobId=vol_123&surface=analysis",
  "baseGridUrl": "/api/volume-grid?jobId=vol_123&surface=base"
}
```

## 7.2 结果 API

### `GET /api/volume-results?jobId=...`

返回：

- 体积结果
- 诊断信息
- surface meta
- 参数快照

### `GET /api/volume-mesh?jobId=...&surface=analysis|base`

返回：

- 指定 surface 的 mesh json

### `GET /api/volume-grid?jobId=...&surface=analysis|base`

返回：

- 指定 surface 的 grid json

### `GET /api/download-volume-job?jobId=...&artifact=...`

下载内容：

- analysis mesh
- base mesh
- volume result
- raw meta

### `POST /api/volume-report-view-snapshot`

职责：

- 不重新跑 volume job，只重建当前 job 的 PDF 报告
- 将当前 viewer 视角截图写入 job 目录
- 基于既有 `result.json`、analysis/base preview 与当前视图截图重新生成 `volume_report.pdf`

请求体建议：

```json
{
  "jobId": "vol_123",
  "imageDataUrl": "data:image/png;base64,..."
}
```

返回体建议：

```json
{
  "ok": true,
  "jobId": "vol_123",
  "reportPdfUrl": "/api/download-volume-job?jobId=vol_123&artifact=report-pdf",
  "viewportPreviewUrl": "/volume-jobs/vol_123/viewer_snapshot.png"
}
```

备注：

- 这是报告增强用的新辅助接口，不改变 `/api/volume-jobs` 的输入输出契约
- 要求 job 目录内已存在 `result.json`、`preview_analysis.png`、`preview_base.png`

## 7.3 兼容策略

短期保留但逐步废弃：

- `/api/generate-volume-surface`
- `/api/volume-surface-mesh`
- `/api/volume-surface-grid`

中期目标：

- volume 全面切到 `/api/volume-jobs`

---

## 8. 数据结构设计

## 8.1 前端 `VolumeRegion`

建议字段：

```js
{
  id,
  name,
  polygon,
  bounds,
  centroid,
  vertexHeightStats,
  pointcloudUuid,
  attachParentUuid,
  scenarioMode,
  analysisSurface: {
    surfaceType,
    aggregateMode,
    pointFilterMode
  },
  baseSurface: {
    mode,
    referenceHeight
  },
  resolution,
  holeFillMode,
  volumeJobId,
  analysisMeshLayerName,
  baseMeshLayerName,
  contoursVisible,
  result: {
    cutVolume,
    fillVolume,
    netVolume,
    effectiveArea,
    coverageRatio,
    diagnostic
  },
  computeState,
  computeMessage
}
```

## 8.2 服务端 `VolumeJob`

目录：

```text
web-uploader/volume_jobs/<jobId>/
  request_payload.json
  result.json
  analysis_surface_grid.json
  analysis_surface_mesh.json
  base_surface_grid.json
  base_surface_mesh.json
  preview_analysis.png
  preview_base.png
  viewer_snapshot.png
  report_refresh_payload.json
```

## 8.3 `result.json`

建议结构：

```json
{
  "jobId": "vol_123",
  "scenarioMode": "stockpile_boundary",
  "analysisSurface": {
    "surfaceType": "stockpile",
    "aggregateMode": "p80",
    "pointFilterMode": "exclude_vegetation"
  },
  "baseSurface": {
    "mode": "boundary",
    "referenceHeight": null
  },
  "stats": {
    "inputPointCount": 0,
    "filteredPointCount": 0,
    "groundPointCount": 0,
    "effectiveCellCount": 0,
    "interpolatedCellCount": 0,
    "coverageRatio": 0
  },
  "volume": {
    "cutVolume": 0,
    "fillVolume": 0,
    "netVolume": 0
  },
  "diagnostic": {
    "confidence": "medium",
    "warnings": []
  }
}
```

---

## 9. UI 设计

## 9.1 工作流

新的 UI 采用“任务导向”而不是“参数堆砌”：

1. 新建体积区域
2. 进入当前区域的活动工作区
3. 先选择场景模式与少量关键参数
4. 运行体积分析
5. 先看 cut / fill / net 等核心结果
6. 再查看表面状态、可视化开关、等高线与导出
7. 历史区域折叠为轻量列表，需要时再重新打开

## 9.2 面板结构

当前推荐结构不再是“一张超长配置卡”，而是三段式活动工作区：

### Region

- 区域名
- 点云名
- 区域面积
- 边界顶点数
- 轻量操作：重画边界 / 重新计算

说明：

- 这部分只保留摘要信息，不再强调复杂状态文案
- 不再把 `Status / Ready` 之类重复信息单独做成高权重卡片

### Method

- 堆体体积
- 平面挖填方
- 地面拟合体积
- 分辨率
- 常量高程
- 高级设置抽屉：
  - Base Surface override
  - Surface type
  - Aggregate mode
  - Point filter
  - Hole fill
  - Display density
  - OBJ 导出

说明：

- 常用参数直接显示
- 不常用参数收进 `Advanced Settings`
- `referenceHeight` 仅在固定高程基准下显示
- `aggregate` 仅在 `stockpile` 表面模式下显示

### 结果

- Cut
- Fill
- Net
- Cells / Coverage
- 可视化切换：Analysis / Base / Both / None
- Export Report
- View Options

说明：

- 结果区优先展示真正体积结果，不再在 KPI 前面堆放解释长文案
- `Analysis / Base / Both / None` 为互斥切换按钮，再点一次可关闭当前显示
- 表面状态摘要（Analysis ready / Base source / Contour source / Warnings）放到结果说明后面，且视觉降权

### Contours

- Interval
- Label Size
- Contour Source：Analysis / Base
- Generate
- Clear
- Labels ON / OFF
- Export DXF

说明：

- 等高线模块已恢复为独立 section，放在工作区最下方
- 不再隐藏在高级设置里，避免用户找不到常用 contour 操作

## 9.3 3D 可视化要求

必须支持：

- 分析面 mesh
- 基准面 mesh / plane
- 边界 polygon
- cut/fill overlay
- 等高线

视觉建议：

- 分析面：实色半透明
- 基准面：浅色半透明
- cut：暖色
- fill：冷色

## 9.4 对客户可解释的文案

面板与报告里必须明确：

- “本次体积基于完整 LAS 数据服务端计算”
- “分析面模式”
- “基准面模式”
- “点过滤模式”
- “是否使用 ground 分类”
- “是否存在 fallback / hole fill”

补充约束：

- 默认用户通常不会先做 LAS 分类，因此“仅有 class 0 / 类过滤可能未生效”不再作为 warning 暴露给用户
- 无分类数据应被视为常见输入，而不是默认异常

---

## 10. 迁移步骤

## 10.1 Phase 1

目标：

- 建立正式设计文档
- 固定对象模型
- 固定统一 volume job 方向

交付：

- 本文档

## 10.2 Phase 2

目标：

- 服务端新增统一 `/api/volume-jobs`
- Python 新增统一 volume analysis 脚本
- 前端切换到服务端结果驱动

交付：

- 第一版统一体积链路

## 10.3 Phase 3

目标：

- 新 UI 面板
- analysis/base mesh 双表面可视化
- 诊断与报告字段落地

## 10.4 Phase 4

目标：

- surface-to-surface 模式
- ground fit 强化
- 更好的部分面积积分
- 自动 stockpile detection

---

## 11. 当前实施计划

### 11.1 本轮计划

1. 新增 `Volume Rebuild Design Doc.md`
2. 增加统一 volume job 服务端链路
3. 让前端 `Compute Volume` 走统一 volume job
4. 将分析面 mesh 变成默认可视化参考面
5. 在文档中持续更新进度

### 11.2 本轮非目标

- 完整的 surface-to-surface UI
- 最终版 PDF 报告
- 自动 stockpile detection
- 高精度几何裁剪积分

---

## 12. 进度记录

### 2026-04-23

- 已完成 volume UI 的第二轮重构与细节打磨：
  - 由“超长配置卡”改为“活动工作区 + 最近历史列表”
  - 当前 region 采用 `Region / Method / Result / Contours` 的任务导向结构
  - 旧 region 折叠为 `Recent Jobs` 轻量摘要行
- 已按用户反馈持续收敛信息密度：
  - `Region` 区块改为更轻的摘要样式
  - 去除 `Status / Ready` 这类重复信息
  - 去除工作区顶部多余说明文案
  - 去除结果区中的复杂解释长句与服务端状态长句
- 已完成结果区视觉整理：
  - 体积 KPI 保持最高视觉优先级
  - 表面状态摘要移到 KPI 与 warning 之后
  - `Analysis / Base / Both / None` 改为可切换、可再次关闭的按钮
  - 显示切换按钮与导出/视图操作重新编排为规则网格
- 已恢复等高线模块为独立 section：
  - 放回工作区最下方
  - 支持 `Interval`、`Label Size`
  - 支持 `Analysis Source / Base Source`
  - 支持 `Generate / Clear / Labels ON-OFF / Export DXF`
  - 沿用原有 contour 生成与导出逻辑
- 已处理无分类数据的 warning 策略：
  - 后端不再输出“仅有 class 0 / class-based filter 无明显效果”这条 warning
  - 前端也会过滤历史 job 中遗留的同类 warning
  - 文档与产品策略统一为：无分类数据是默认常见场景，不作为异常提示
- 已补充并通过回归：
  - 新增 `web-uploader/tests/volume-ui.test.mjs`
  - `npm run test:volume` 已纳入 UI preset 同步规则测试
  - `npm run test:viewer-volume` 已覆盖新工作区、surface 显示切换、scene-tree 注册、contour 操作与报告导出入口
  - 当前 volume UI 重构后的关键路径仍受浏览器级自动化保护
- 已完成报告导出链路增强：
  - 导出报告时前端会先抓取当前 viewer 视角截图
  - 后端新增 `POST /api/volume-report-view-snapshot`
  - Python 报告脚本新增 `reportOnly` 模式，只重建 PDF，不重跑体积分析
  - 报告中移除 `Source LAS` 行
  - 报告中新增 `Current Point Cloud View` 图块，展示导出当下的真实点云窗口视角
- 已更新报告版式：
  - 结果摘要与风险摘要后插入当前点云视图图块
  - 分析面 / 基准面预览图保留在后续页面
  - 当前视图截图与预览图均按版心自动缩放，避免超宽或溢出
- 已完成当前轮完整验证：
  - `npm run test:volume`
  - `npm run test:viewer-volume`
  - `npm run test:volume-report`
  - `npm run test:viewer-smoke`
  - 另补做一轮真实 BEL-JOEL 交互烟测：新建区域 -> 计算 -> 导出报告 -> 成功下载 PDF

### 2026-04-22

- 完成行业调研与现状问题梳理
- 形成正式重构设计文档
- 确认新体积模块核心方向为：
  - 统一 volume job
  - 服务端完整数据计算
  - analysis surface + base surface 双表面
  - mesh 同源可视化
- 已完成第一版代码落地：
  - 新增统一后端入口：`POST /api/volume-jobs`
  - 新增结果读取：`/api/volume-results`、`/api/volume-mesh`、`/api/volume-grid`
  - 新增统一脚本：`web-uploader/scripts/compute_volume_analysis.py`
  - 前端 `Compute Volume` 已切到服务端 volume job
  - volume 面板已支持 analysis/base surface 双结果展示
  - terrain 已支持按内联 mesh/grid 数据直接载入 3D
- 当前仍待完成：
  - 浏览器内完整交互烟测
  - 场景模式文案与字段进一步对齐
  - contour / export / scene-tree 的交互细节回归

### 2026-04-22 烟测记录

- 已验证本地服务可启动，`/health` 正常返回。
- 已在真实 LAS 数据上验证统一 `volume job`：
  - `stockpile_boundary + exclude_vegetation`
  - `plane_cut_fill + dtm + ground_only + fixed base`
- 已确认以下产物可成功生成并读取：
  - `result.json`
  - `analysis_surface_mesh.json`
  - `analysis_surface_grid.json`
  - `base_surface_mesh.json`
  - `base_surface_grid.json`
  - `preview_analysis.png`
  - `preview_base.png`
- 已确认以下读取接口返回 `200`：
  - `/api/volume-results`
  - `/api/volume-mesh?surface=analysis|base`
  - `/api/volume-grid?surface=analysis|base`
  - `/volume-jobs/<jobId>/preview_analysis.png`
  - `/volume-jobs/<jobId>/preview_base.png`
- 烟测中修复的问题：
  - 统一 `volume job` 初始误用系统 `python3`，现已改为优先使用项目 `.venv` Python。
- 已补充自动化回归：
  - `web-uploader/tests/volume-job.integration.test.mjs`
  - 通过合成 LAS 直接验证统一 volume job 生成 `result.json` 与 analysis/base 双表面产物
  - `npm run test:volume` 当前通过
- 已补充第一版过滤规则 UI / API：
  - `All points`
  - `Exclude grass / trees`
  - `Exclude vegetation / buildings`
  - `Ground only (class 2)`
- 已补充第一版场景模式 UI：
  - `Stockpile`
  - `Plane Cut/Fill`
  - `Ground-Fitted Volume`
  - 并显式暴露 `Base Surface` 选择
- 已补充结果解释层：
  - 面板会根据 `Scenario Mode` 和 `Base Surface` 展示解释性文案
  - volume job 的 `diagnostic.warnings` 已开始透传到 UI
- 已加强 `Ground-Fitted Volume`：
  - 后端会区分 `ground_class2_fit` 与 `boundary_fallback`
  - 会输出 `groundSupportRatio` 与 `usedGroundSupport`
  - 前端会根据这些诊断解释 ground-fit 结果是否真正建立在地面类点上
- 已新增 `ground_fit_volume` 回归测试：
  - 集成测试会生成合成 class-2 地面 LAS
  - 验证 `baseSourceUsed=ground_class2_fit`
  - 验证 `usedGroundSupport=true`
- 已基于真实 `BEL-JOEL` 项目做无分类数据验证：
  - `colorized.las` 分类全为 `0`
  - `ground_fit_volume` 现不再误报为真实 ground fit
  - 会显式给出 `ground_quantile_fallback`、低 ground support 等 warning
- 已基于真实 `BEL-JOEL` 项目验证分辨率推荐：
  - 对代表性堆体区域，`1.0m` 会被识别为过粗
  - 推荐分辨率约落在 `0.3m ~ 0.58m`
  - 与实际观测到的结果波动趋势一致
- 已解决本地浏览器烟测环境：
  - 不再依赖受限的 MCP Playwright 目录
  - 新增 `npm run test:viewer-smoke`
  - 使用本地 Playwright + `swiftshader` 软渲染参数验证 viewer 首屏可正常加载 WebGL 页面
- 已新增真实 UI 流程测试：
  - `npm run test:viewer-volume`
  - 自动起本地服务
  - 打开 `BEL-JOEL` 项目
  - 进入测量面板并启动 volume 工具
  - 对 `params.json` / `transforms.json` 这类允许缺失的扫描项目补充文件做了测试层兼容
- 已完成一轮旧链清理：
  - `viewer.html` 中旧的前端抽样限制函数不再残留引用
  - 旧的 `surfaceGrid` 本地体积积分函数已移除
- 已新增 PDF 报告导出：
  - 每个 `volume job` 产出 `volume_report.pdf`
  - 包含 cut / fill / net、coverage、effective cells、warnings、推荐分辨率、analysis/base 预览图
  - 后端下载 artifact：`report-pdf`
  - 已用真实 `BEL-JOEL` 项目验证下载与 PDF 内容可读
- 已完成报告版式强化：
  - 顶部品牌条 + 项目头部信息
  - 结果摘要卡片
  - 风险摘要卡片
  - 方法与参数区
  - 预览图分页展示
  - 已通过真实 `BEL-JOEL` 报告视觉检查
- 已补充报告视觉回归：
  - 新增 `npm run test:volume-report`
  - 使用 `qlmanage` 将 PDF 报告渲染为 PNG
  - 校验预览图存在、尺寸正常、文件体积合理
- 已继续打磨报告交付感：
  - 结果摘要卡片 + 风险摘要卡片
  - 更清晰的项目头部信息
  - 预览图与解释内容分页布局
  - 区域名 / 数据集名 / 生成时间已纳入正式报告正文
- 已补充报告正式交付细节：
  - `Region Name` / `Dataset` / `Generated` / `Current Resolution` / `Polygon Area` 纳入摘要
  - `Risk Summary` 单独成块展示
  - 真实 `BEL-JOEL` 报告已重新生成并通过视觉复查
- 当前报告状态：
  - 已具备正式交付感
  - 结果、UI、报告、报告视觉四条线均有回归保护
- 浏览器自动化现状：
  - Playwright MCP 受宿主目录权限限制，暂未完成正式浏览器自动化截图/交互脚本
  - 但 viewer 启动时已顺手修复一个非体积核心的 DXF 初始化时序错误

---

## 13. Windows 分支合并交接

这一节用于后续把当前服务器版的体积模块重构成果，人工合并到另一个 Windows 版本分支。  
重点不是“整文件覆盖”，而是“按功能块迁移 + 保持契约不变”。

### 13.1 合并目标

需要迁移的能力包括：

1. 统一 volume job 主链路
2. 新的活动工作区 UI（Region / Method / Result / Contours）
3. analysis/base 双表面 3D 可视化切换
4. contour 独立 section 与 DXF 导出
5. 无分类数据 warning 策略更新
6. PDF 报告增强：
   - 去掉 `Source LAS`
   - 新增当前 viewer 视角截图
   - 导出时先抓当前窗口截图，再重建报告

### 13.2 不建议直接覆盖的文件

由于 Windows 分支很多文件已经变化，以下文件不要直接整文件覆盖：

- `web-uploader/viewer.html`
- `web-uploader/server.js`
- `web-uploader/assets/app/features/volume/index.js`

原因：

- 这几个文件都是高耦合大文件，Windows 分支可能已有其他改动
- 直接覆盖很容易把无关功能、平台适配或已有修复一起覆盖掉
- 推荐做法是按下面的“功能块迁移清单”逐段 transplant

### 13.3 需要迁移的文件清单

#### 1. `web-uploader/assets/app/features/volume/index.js`

这是当前 volume UI 的主实现文件。  
Windows 分支应优先对齐这里，而不是继续扩展 `viewer.html` 里的旧 fallback 面板。

本轮关键改动点：

- 新增 `applyScenarioDefaultsToRegion(region, scenarioMode)`
  - 统一 `Stockpile / Plane Cut-Fill / Ground-Fitted` 的预设联动
  - 影响 `baseSurfaceMode`、`pointFilterMode`、`surfaceType`
- 新增 `getSurfaceDisplayMode(...)`
  - 管理 `Analysis / Base / Both / None` 四态切换
  - 支持再次点击关闭当前显示
- `renderPanelList()`
  - 重构为活动工作区结构：
    - `Region`
    - `Method`
    - `Result`
    - `Contours`
  - 历史 region 折叠为 `Recent Jobs`
- `updatePanel()`
  - 已去掉复杂说明文案
  - 有 region 时不再显示冗余 note
- `Export Report` 按钮逻辑
  - 先执行 `captureCurrentViewDataUrl()`
  - 再 `POST /api/volume-report-view-snapshot`
  - 成功后再下载 `/api/download-volume-job?...artifact=report-pdf`
- 等高线逻辑
  - 已从高级设置里移出
  - 独立放到最下方 `Contours` section
  - 保留原有事件接线：
    - `set-contour-source`
    - `gen-contours`
    - `remove-contours`
    - `toggle-labels`
    - `export-dxf`

迁移建议：

- 优先迁移：
  - `applyScenarioDefaultsToRegion`
  - `getSurfaceDisplayMode`
  - `renderPanelList`
  - `updatePanel`
  - `captureCurrentViewDataUrl`
- 如果 Windows 分支已有自定义按钮或样式，可以保留它们，但不要改掉这些事件名和数据流

#### 2. `web-uploader/viewer.html`

这是 volume runtime 与页面总线所在文件。  
Windows 分支通常会在这里有较多平台/UI 差异，因此只迁移必要接线。

需要对齐的点：

- `volumeMeasureState`
  - 新增 `activeRegionId`
- `buildVolumeRegion(points)`
  - 新增 UI 状态字段：
    - `uiAdvancedOpen`
    - `uiViewOptionsOpen`
- `finalizeVolumeSelection(...)`
  - 确认新建 region 后：
    - `volumeMeasureState.activeRegionId = region.id`
- `removeVolumeRegion(...)`
  - 删除当前 region 时，要把 `activeRegionId` 指向最后一个剩余 region 或 `null`
- `clearAllVolumeRegions(...)`
  - 清空时要重置 `activeRegionId`
- 新增 `filterLegacyVolumeWarnings(...)`
  - 过滤历史 job 里遗留的 `class 0` warning 文案
- `computeVolumeRegion(...)`
  - 回填 `region.diagnosticWarnings` 时使用 `filterLegacyVolumeWarnings`
- volume CSS block
  - 需要迁移新的工作区样式类，重点包括：
    - `.volume-workspace-card`
    - `.volume-inspector-section`
    - `.volume-surface-status-strip`
    - `.volume-visual-toggle-grid`
    - `.volume-visual-action-grid`
    - `.volume-contour-source-grid`
    - `.volume-contour-action-grid`

注意：

- `viewer.html` 里旧的 volume fallback 渲染仍然存在，但当前主路径实际由 `volumeFeature.updatePanel()` 接管
- 如果 Windows 分支已经有 feature bootstrap，优先保证 `createVolumeFeature(...)` 的 wiring 完整，而不是继续改旧 fallback DOM

#### 3. `web-uploader/server.js`

这是 volume job 路由与报告重建接口的落地点。

需要迁移的功能块：

- `app.use(express.json({ limit: '50mb' }))`
  - 必须迁移
  - 否则当前视图截图的 base64 PNG 可能因为 body 太大直接失败
- 新增 helper：
  - `writePngDataUrlToFile(dataUrl, filePath)`
- 保留现有：
  - `/api/volume-jobs`
  - `/api/volume-results`
  - `/api/volume-mesh`
  - `/api/volume-grid`
  - `/api/download-volume-job`
- 新增：
  - `POST /api/volume-report-view-snapshot`

这个新接口的职责：

1. 校验 `jobId`
2. 找到现有 `volume_jobs/<jobId>/`
3. 把前端传来的 PNG data URL 存成 `viewer_snapshot.png`
4. 写入 `report_refresh_payload.json`
5. 调用同一个 `compute_volume_analysis.py`，但走 `reportOnly` 模式
6. 仅重建 `volume_report.pdf`

注意：

- 不要改动已有 `/api/volume-jobs` 契约
- 新接口只是报告增强辅助接口，不影响旧主链

#### 4. `web-uploader/scripts/compute_volume_analysis.py`

这是 volume job 与 PDF 报告的核心脚本。

必须迁移的改动：

- 新增 `build_preview_image(path, max_width, max_height)`
  - 用于报告中自动缩放图片
- `build_volume_pdf_report(...)`
  - 签名从：
    - `(output_path, result, analysis_preview_path, base_preview_path)`
  - 扩展为：
    - `(output_path, result, analysis_preview_path, base_preview_path, viewport_preview_path=None)`
- 报告正文调整：
  - 删除 `summary_rows` 中的 `Source LAS`
  - 在结果摘要和风险摘要后插入 `Current Point Cloud View`
  - 保留 analysis/base preview，但自动缩放，避免溢出
- `main()`
  - 新增 `reportOnly` 模式
  - 当 payload 包含：
    - `reportOnly: true`
    - `resultPath`
    - `analysisPreviewPath`
    - `basePreviewPath`
    - `viewportPreviewPath`
  - 脚本只重建 PDF，不再读取 LAS、不再重跑体积分析
- warning 策略更新：
  - 删除“仅有 class 0 / 类过滤未明显生效”这条 warning 的生成逻辑

注意：

- `reportOnly` 模式依赖既有 artifact 已存在
- 不要让它重新进入 LAS 读取和网格计算逻辑
- Python 环境要能继续访问：
  - `reportlab`
  - `numpy`
  - `matplotlib`

#### 5. `web-uploader/tests/volume-ui.test.mjs`

新增测试文件。  
作用：

- 验证场景模式切换的 preset 联动规则
- 这在跨分支迁移时很重要，因为 UI 逻辑很容易被改坏但不报错

#### 6. `web-uploader/tests/viewer-volume-flow.test.mjs`

需要同步当前版本的浏览器回归。

本轮关键点：

- 覆盖新工作区 UI
- 验证 `Analysis / Base / Both / None`
- 验证 scene-tree 中的 `Volume Surface` 注册与隐藏/再显示
- 验证 contour 相关按钮
- 验证 `Export Report`
- 测试里对以下接口做了 stub：
  - `/api/volume-jobs`
  - `/api/volume-mesh`
  - `/api/volume-grid`
  - `/api/volume-report-view-snapshot`
  - `/api/download-volume-job?artifact=report-pdf`

#### 7. `web-uploader/tests/volume-job.integration.test.mjs`

新增了报告重建链路的覆盖：

- `report-only volume rebuild accepts a viewport screenshot artifact`

作用：

- 确认 `reportOnly` 模式真实可用
- 确认当前视图截图能够被带入报告重建

#### 8. `web-uploader/package.json`

需要同步：

- `test:volume` 现在要包含 `tests/volume-ui.test.mjs`

### 13.4 推荐迁移顺序

建议按下面顺序合并，最稳：

1. `compute_volume_analysis.py`
2. `server.js`
3. `viewer.html` 的状态字段与 helper
4. `assets/app/features/volume/index.js`
5. 测试文件
6. `package.json`

原因：

- 先把后端和脚本能力补齐，前端新按钮才不会点了报错
- 再接 viewer runtime 状态字段，最后迁 UI
- 这样每一步都可以单独验证，不会一次性打成大爆炸

### 13.5 合并时必须保持不变的契约

以下契约不要改：

- `ownerRegionId`
- `surfaceRole`
- `analysisSurfaceLayerName`
- `baseSurfaceLayerName`
- terrain 里 volume surface 的 layer naming
- `/api/volume-jobs` 的请求/响应结构
- `/api/volume-results`
- `/api/volume-mesh`
- `/api/volume-grid`
- `/api/download-volume-job`

原因：

- 这些字段被：
  - scene-tree
  - terrain surface loader
  - contour runtime
  - report / export 按钮
  - viewer-volume 回归测试
  同时依赖

### 13.6 常见坑

#### 坑 1：直接覆盖 `viewer.html` 或 `server.js`

后果：

- 会把 Windows 分支已有的非 volume 改动冲掉

正确方式：

- 只 transplant volume 相关 helper、state 字段、路由和 CSS block

#### 坑 2：忘记放大 JSON body limit

后果：

- 导出报告时前端上传当前截图会 `413` 或直接失败

必须项：

- `app.use(express.json({ limit: '50mb' }))`

#### 坑 3：只迁 UI，不迁 `/api/volume-report-view-snapshot`

后果：

- `Export Report` 按钮仍能下载 PDF，但不会带当前视角截图

#### 坑 4：只迁 server route，不迁 Python `reportOnly`

后果：

- 点击导出报告会试图重跑完整 volume job
- 可能慢、可能失败、也会让报告导出和计算耦合回去

#### 坑 5：把 `class 0` warning 又加回来

当前产品假设已经明确：

- 默认用户不会先做分类
- 无分类数据是常见输入
- 不应再把这件事作为 warning 弹给用户

#### 坑 6：把 contour 功能继续藏在高级设置里

当前用户反馈已经明确：

- contour 是高频操作
- 必须独立放在工作区底部

#### 坑 7：只改按钮文案，不保留切换行为

特别是：

- `Analysis / Base / Both / None`

当前行为要求：

- 互斥显示
- 再点一次可关闭当前显示
- 按钮要有 active 状态

### 13.7 最小验收清单

Windows 分支合并后，至少要完成以下验收：

1. `npm run test:volume`
2. `npm run test:viewer-volume`
3. `npm run test:volume-report`
4. `npm run test:viewer-smoke`
5. 真实打开一个项目，手动画一个 volume region
6. 成功切换 `Analysis / Base / Both / None`
7. 成功生成 contour 并导出 DXF
8. 成功点击 `Export Report`
9. 报告中：
   - 没有 `Source LAS`
   - 有当前 viewer 视角截图
   - analysis/base preview 仍正常

### 13.8 给另一个 AI 的执行建议

如果是让另一个 AI 在 Windows 分支上接这套功能，建议明确告诉它：

- 不要直接覆盖整文件
- 先迁 Python 脚本与 server route，再迁 UI
- 严格保留 volume job 契约和 terrain/scene-tree 的字段名
- 迁完后先跑自动化，再做人手烟测

一句话总结：

> 这次体积模块重构的关键，不是单个按钮或单个样式，而是“统一 volume job + 活动工作区 UI + analysis/base/contour/report 同一口径 + 导出报告带当前视角截图”这一整条链。
