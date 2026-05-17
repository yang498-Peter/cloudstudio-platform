# Volume Module Exploration & Risk Tracker

> 体积测量模块「现状探索 + 风险登记 + 优化追踪」工作文档

- 创建时间：2026-05-07
- 最后更新：2026-05-07
- 当前维护人：Peter Yang
- 适用范围：`/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader`
- 与现有文档的关系：
  - [`Volume Rebuild Design Doc.md`](Volume%20Rebuild%20Design%20Doc.md) 是**前瞻性设计 + 进度日志**（目标架构、迁移步骤、Windows 合并交接）。
  - **本文档是诊断性的现状档**：以"当前已部署的代码"为基准，逐条登记潜在算法风险、UI/交互风险、隐藏假设、性能瓶颈，给后续每一次修复留追踪位。
  - 修复完成后请把对应条目移到「§9 已修复 / 已验证」并补一行验证证据。

---

## 0. 这份文档怎么用

```
发现新问题  →  §3-§7 任一类目下追加一条
准备修复     →  §8 路线图里挑一条 / 改优先级
修完          →  §9 写一行：日期 + 改动文件 + 测试证据
```

不要把这份文档当成「设计 spec」来读，它是工作笔记。条目尽量做到 **精确到文件:行号 + 证据 + 影响**，避免空泛批评。

---

## 1. 模块全景（代码地图）

```
体积测量
├── 前端 UI 与状态
│   ├── viewer.html                                      (≈3 万行单文件，体积部分集中在 9000-10500)
│   │   ├── 多边形几何 helpers          polygonArea2D / polygonCentroid2D / pointInPolygon2D
│   │   ├── 选区采样                    getVolumeSelectionPick / registerVolumeSelectionHandlers
│   │   ├── region 构造                 buildVolumeRegion           [行 9504]
│   │   ├── 计算入口                    computeVolumeRegion         [行 10061]
│   │   ├── grid 回算辅助                buildComputedCellsFromVolumeGrids / summarizeComputedCells
│   │   └── 回调到 feature 层
│   └── assets/app/features/volume/
│       ├── index.js                                      (1274 行)
│       │   └── createVolumeFeature: renderPanelList / updatePanel / 区段事件绑定
│       └── compute.js                                    (226 行)
│           ├── normalizeVolumeHoleFillMode / normalizeSurfaceBuildHoleMode
│           ├── resolveVolumeSurfaceProfile
│           ├── computeNetVolume
│           └── 老版 cell 累积器（P2 quantile estimator） — 现已不在主链路使用
│
├── 后端
│   ├── server.js
│   │   ├── 限额：VOLUME_SURFACE_LIMITS                    [行 4261]
│   │   ├── 校验：normalizeVolumeJobPolygon / validateVolumeJobRequest [行 4537]
│   │   ├── 互斥：acquireVolumeComputeSlot                 [行 4508]   (默认 maxConcurrentJobs=1)
│   │   ├── POST /api/volume-jobs                          [行 5470]
│   │   ├── GET  /api/volume-results                       [行 5610]
│   │   ├── GET  /api/volume-mesh / -grid / -surface-mesh  [行 5428-5669]
│   │   └── POST /api/volume-report-view-snapshot          [行 5669]
│   └── scripts/
│       ├── compute_volume_analysis.py                    主链路 (1035 行)
│       └── generate_volume_surface.py                    旧链路（仅生成单 surface，已被 compute_volume_analysis.py 取代但未删除）
│
└── 输出物（每个 jobId 一目录，VOLUME_JOB_DIR）
    ├── result.json
    ├── analysis_surface_grid.json + base_surface_grid.json
    ├── analysis_surface_mesh.json + base_surface_mesh.json
    ├── analysis_surface.obj      + base_surface.obj
    ├── preview_analysis.png      + preview_base.png
    ├── viewer_snapshot.png       (POST snapshot 时写入)
    └── volume_report.pdf
```

---

## 2. 当前数据流与控制流

```
[viewer.html]
   1. 工具栏点 "Volume" → activateMeasureTab('volume')
   2. registerVolumeSelectionHandlers 注册 mousedown / dblclick
   3. 用户单击多次记录 pendingPoints → 双击触发 buildVolumeRegion
   4. buildVolumeRegion 在 region 上写入：
        polygon (local xyz), polygonArea, cellSize=estimateVolumeCellSize,
        scenarioMode='stockpile_boundary', pointFilterMode='exclude_vegetation', ...
   5. 自动调用 computeVolumeRegion(region)

[viewer.html computeVolumeRegion]   行 10061
   6. resolveVolumeRegionLasPath(region)  (扫描仪项目 → 真实 LAS 路径)
   7. POST /api/volume-jobs  body = { lasPath, polygon[xyz], resolution,
                                       scenarioMode, analysisSurface{...},
                                       baseSurface{ mode, referenceHeight }, holeFillMode,
                                       spikeThreshold }
   8. 同时拉 result.json / analysis_grid.json / base_grid.json
   9. 把 stats / volume / diagnostic 回写到 region；buildComputedCellsFromVolumeGrids
      在前端再生成 cells 用于 overlay 显示
   10. 触发 updatePanel + refreshSceneTree

[server.js POST /api/volume-jobs]   行 5470
   11. 限额校验：source LAS 大小、多边形顶点数、面积、估算 cell 数
   12. acquireVolumeComputeSlot (默认全局只允许 1 个并发)
   13. 构造 payload.json 写入 outputDir
   14. spawn python (EFFECTIVE_TERRAIN_PYTHON_BIN compute_volume_analysis.py payload.json)
   15. 等 4 分钟 timeout 内完成
   16. 校验 5 个产物文件存在 → 读 result.json → 返回 { jobId, urls, stats, ... }

[compute_volume_analysis.py]   行 666
   17. iter_batches_laspy/_fallback：分块读 LAS，按 polygon bbox + 类别过滤 + 多边形 inside 测试
   18. build_grid_from_batches(profile)：把点抛进 (rows, cols) 格子，每格做 P80/P85/median/max 等
   19. 可选 surface_ceiling 截掉过高点（reference + 自适应上限）
   20. 可选 spike de-noise（仅正向异常）
   21. downsample_grid_if_needed
   22. fill_grid_holes(analysis_grid, hole_mode)
   23. base 面构建（boundary IDW / fixed plane / ground fit + 三级 fallback）
   24. fill_grid_holes(base_grid, 'interpolate') ← 此处不受用户 hole_mode 控制
   25. 双层循环遍历每格：估边缘覆盖率 4×4 supersample → 累加 cut/fill
   26. 生成 mesh、preview、PDF report
   27. print('RESULT:' + json) → server.js 解析最后一行
```

关键归一化点：

| 字段                | 默认值                  | 注入位置                                      |
|---------------------|------------------------|---------------------------------------------|
| `scenarioMode`      | stockpile_boundary     | viewer.html:9536, applyScenarioDefaultsToRegion |
| `pointFilterMode`   | exclude_vegetation     | viewer.html:9537                            |
| `surfaceType`       | stockpile              | viewer.html:9540                            |
| `surfaceAggregateMode` | p80                 | viewer.html:9541                            |
| `holeFillMode`      | interpolate            | viewer.html:9539                            |
| `spikeThreshold`    | 0.35 m                 | viewer.html:9542 / 10115                    |
| `cellSize`          | estimateVolumeCellSize | viewer.html:9532（最小 0.25 m）             |

---

## 3. 算法层潜在问题

### 3.1 严重：Net Volume 符号约定与堆体场景不一致

**位置**：[`compute_volume_analysis.py:856-861, 985`](web-uploader/scripts/compute_volume_analysis.py#L856)

代码：
```python
delta = float(analysis_z - base_z)
volume = delta * cell_area * coverage
if volume > 0:    cut_volume  += volume
elif volume < 0:  fill_volume += -volume
...
'netVolume': float(fill_volume - cut_volume)
```

**含义**：分析面在基准面**之上**（堆体的实际情况）→ delta>0 → 计入 **cut**。所以一个典型的料堆体积，在结果里显示为 `cutVolume = +堆体积，fillVolume ≈ 0，netVolume = -堆体积（负数）`。

**风险**：
1. 测绘行业的常见口径是 **"pile / stockpile volume = + 数值"**（料堆体积 = 正）。当前 KPI 卡片里 Net Volume 显示一个大负数，操作员第一反应是"程序坏了"。
2. 在 plane_cut_fill 场景下符号是合理的（高于目标标高 = cut，低于 = fill），所以**不能简单翻号**。需要按 `scenarioMode` 区分显示口径。
3. UI 上 `formatVolumeMeasurement` 直接显示带符号的数值，没有按场景做语义包装。

**建议修复方向**：
- 在 [`getVolumeResultInterpretation`](web-uploader/assets/app/features/volume/index.js#L59) 之外，再加一层「场景化展示模型」：
  - stockpile：主指标 = `pileVolume = cutVolume`（隐藏 netVolume，或者在 `Advanced` 里展示原始量）
  - plane_cut_fill：cut/fill/net 三项都展示，net = fill − cut（保持当前算法）
  - ground_fit：主指标 = `pileVolumeAboveGround = cutVolume`

### 3.2 中：Boundary IDW 基准面对边界顶点 Z 极敏感

**位置**：[`compute_volume_analysis.py:250-272`](web-uploader/scripts/compute_volume_analysis.py#L250)

只用多边形顶点 Z 做 1/d² IDW，没有任何正则化或离群剔除。

**风险**：
1. 用户在画多边形时如果**有一个顶点恰好落在堆体上**（很常见，因为画的时候为了贴边会点到堆边的高点），整个 base 面会被往上拉，导致 cut volume 被严重低估。
2. 顶点分布越不均匀，IDW 就越偏向密集的一侧。圆形选区 + 顶点稀疏一侧表现尤差。

**建议修复方向**：
- 在 IDW 之前对顶点 Z 做一次中位数 + MAD 过滤，把明显高于其他顶点的丢掉；或者
- 改成 boundary 周围 ~1m 缓冲带内的低分位点拟合（更稳健，但需要先读点云）。

**当前实现说明（2026-05-07）**：
- 已在 IDW 前加入中位数 + MAD 过滤，MAD=0 的平坦边界会用绝对偏差兜底，并过滤 NaN/Inf 顶点 Z。
- 为保证 IDW 至少有 3 个锚点，3 顶点三角形选区不会剔除到少于 3 个点。也就是说，三角形边界里如果某个顶点 Z 明显点错，算法会尽量保守，不会强行丢点；后续可以在 UI 上对三角形 + 高程离散过大的情况给出更醒目的提示。

### 3.3 中：Ground fit 三级 fallback 中"P20 of all points"作为伪地面有可乘之机

**位置**：[`compute_volume_analysis.py:783-820`](web-uploader/scripts/compute_volume_analysis.py#L783)

ground fit 链路：
1. 用 class=2 的点构建 → 不够则
2. 用所有点的 P20 当伪地面 → 不够则
3. 退到 boundary IDW。

**风险**：
- 第 2 步在密林、树冠下的隐蔽地点云里 P20 仍然显著高于真地面（树底反射 + 噪点），结果 cut 被低估 5–30%。代码里有 warning 字符串，但没有强制 UI 高亮，操作员很容易忽略。
- 当前 warning 是软提示，不会阻断结果展示。

**建议修复方向**：
- 在 region 上加一个 `confidenceLevel = 'high' | 'medium' | 'low'`，由 `groundSupportRatio` + `baseSourceUsed` 决定。
- UI 在 Net Volume 旁边显示置信度徽章；当 `low` 时禁用「Export Report」并要求用户手动确认。

### 3.4 中：Spike 去噪只过滤正向异常，不过滤负向

**位置**：[`compute_volume_analysis.py:749-770`](web-uploader/scripts/compute_volume_analysis.py#L749)

```python
if local > upper + threshold and analysis_support[iy, ix] <= 2:
    updated[iy, ix] = np.float32(max(median, upper))
```

**风险**：地面凹陷（实际洞、积水镜面反射、车辙）在分析面上呈现为低于邻居 0.3–1m 的脏值，会导致 cut 被高估、fill 被低估。当前阈值只对 `local > upper + threshold` 触发。

**建议修复方向**：对称处理 `local < lower − threshold and support<=2`，或者改用 5×5 中位数滤波再做。

### 3.5 中：Hole-fill 模式在 base grid 上被强制为 'interpolate'

**位置**：[`compute_volume_analysis.py:826`](web-uploader/scripts/compute_volume_analysis.py#L826)

```python
base_grid, base_filled_count = fill_grid_holes(base_grid, 'interpolate', fixed_height=reference_height)
```

用户在 UI 上选的 holeFillMode 只作用于 analysis grid（行 773），base grid 总是被 interpolate。

**风险**：选择"Leave holes"的用户期望的是"哪些格子没数据就不算"，但实际 base grid 仍然被填，最终积分时只要 analysis 这格有数就一定有 base，effective_cell_count 反而比预期大。

**建议修复方向**：把 `hole_mode` 同时传给 base 的 hole-fill；或者文档里说清楚 "Leave holes" 只是控制 analysis 面，base 总是被填。

### 3.6 低：Reference Height 的隐式 fallback

**位置**：[`compute_volume_analysis.py:778-779`](web-uploader/scripts/compute_volume_analysis.py#L778)

```python
if reference_height is None or not math.isfinite(float(reference_height)):
    reference_height = float(np.nanmean([float(p.get('z', 0.0)) for p in polygon]))
```

**风险**：用户选了 fixed-plane 模式但没填高程 → 静默 fallback 到顶点 Z 平均值。前端兜底逻辑（[`viewer.html:9531`](web-uploader/viewer.html#L9531)）已经默认填了顶点平均，所以这里几乎不会触发，但出现时是悄悄的，没有 warning。

**建议修复方向**：要么把这条加进 warnings；要么前端对 `referenceHeight === null` 做硬校验拒绝提交。

### 3.7 低：多边形面积 shoelace 在 python 里被同口径写了三遍

**位置**：[`compute_volume_analysis.py:867, 869, 977`](web-uploader/scripts/compute_volume_analysis.py#L867)

```python
abs(sum((polygon_xy[i][0]*polygon_xy[(i+1)%len][1] -
         polygon_xy[(i+1)%len][0]*polygon_xy[i][1])
        for i in range(len(polygon_xy)))) * 0.5
```

**风险**：未来想加签名约定（顺时针/逆时针）或自交检测时，三处需要同时改，容易遗漏。

**建议修复方向**：抽 `polygon_signed_area` / `polygon_area` 一组小函数；同时和 frontend [`viewer.html:9270 polygonArea2D`](web-uploader/viewer.html#L9270) / server.js [`computePolygonAreaFromPairs`](web-uploader/server.js) 对齐契约。

### 3.8 低：前端 fallback summary 与服务端口径不一致

**位置**：[`viewer.html:9926-9956 summarizeComputedCells`](web-uploader/viewer.html#L9926)

前端 fallback 里：
```javascript
const volume = cell.delta * cellArea;       // 没有 coverage 因子
const coverageArea = computedCells.length * cellArea;
```

而服务端是 `delta * cell_area * coverage`。

**风险**：当 `stats.effectiveArea / coverageRatio / cutVolume` 都缺失时，前端会显示一个**比真实值大几个百分点**的 cut/fill（边缘格子按全格计算）。在网络出错或 result.json 损坏时表现尤为明显。

**建议修复方向**：
- 让 fallback 仅显示 `Pending`，不展示数字；或者
- 在 `buildComputedCellsFromVolumeGrids` 里把每格的 coverage 也从某处带过来（grid 里目前没有）。

### 3.9 低：computed cell `kind` 阈值 ≠ 数学积分阈值

**位置**：[`viewer.html:9918`](web-uploader/viewer.html#L9918)

```javascript
kind: delta > 0.01 ? 'cut' : (delta < -0.01 ? 'fill' : 'neutral')
```

但服务端积分用的是严格 `volume > 0` / `< 0`。

**风险**：可视化 overlay 着色与 KPI 数字有 1cm 不一致——overlay 里的"中性灰"格子，对积分有微小贡献。这是 UI vs 算法语义错位的轻微例子。

**建议修复方向**：要么 overlay 也按严格符号上色；要么积分也用 1cm 死区。

---

## 4. 性能与扩展性瓶颈

### 4.1 严重：内层 binning 循环纯 python 实现

**位置**：[`compute_volume_analysis.py:205-222`](web-uploader/scripts/compute_volume_analysis.py#L205)

```python
for idx in range(x.size):
    key = (int(iy[idx]), int(ix[idx]))
    cell = cells.get(key)
    if cell is None: ...
    cell['z'].append(float(z[idx]))
```

对 10M 级别 in-region 点 → 1000 万次 dict + list.append + float() 转换。

**冲击**：在大堆体（覆盖 1000+ m² 半米格密点云）单次 compute 从 4 秒可能拉到 40 秒。已经接近 4 分钟 timeout。

**建议修复方向**：
- 用 `np.histogram2d` 做 count；用 `scipy.stats.binned_statistic_2d` 做 percentile/median。
- 或者按 cell index 排序后一次性切片做 group-by。
- 兜底：把这段循环 cython/numba 化。

### 4.2 中：`point_batches = list(iter_fn(...))` 把流式迭代器物化

**位置**：[`compute_volume_analysis.py:715`](web-uploader/scripts/compute_volume_analysis.py#L715)

理由是 ground-fit 路径需要二次遍历同一批点（行 784）。

**冲击**：超大文件 + 大 polygon 时 OOM 风险。1.5 GB LAS / 8000 m² 圈选已经接近极限（被 `VOLUME_SURFACE_LIMITS.maxSourceBytes` 1.5 GB 卡住）。

**建议修复方向**：
- 缓存到磁盘 `.npy`，二次遍历时 mmap；
- 或者两次都走 laspy chunk_iterator（多读一次 LAS，但 IO < 内存膨胀）；
- 或者把 ground 面构建合并到第一次扫描中（一遍同时算 P80 和 P20）。

### 4.3 中：`estimate_cell_coverage` 4×4 supersample 纯 python

**位置**：[`compute_volume_analysis.py:287-300`](web-uploader/scripts/compute_volume_analysis.py#L287)

每格 16 次 `polygon_path.contains_point` 调用，对 100×100 grid = 16 万次。

**冲击**：500×500 已经是几百万次调用，单这一步就要 10 秒+。

**建议修复方向**：
- 矩形栅格在内部的格子 coverage = 1，外部 = 0，只对边界格子做 supersample；
- 用 `MplPath.contains_points` 一次性批量化（而不是 for 循环逐点）；
- 或者用近似快速算法：boundary-cell coverage ≈ (cell ∩ polygon) / cell_area，shapely 的精确解析法。

### 4.4 低：volume_jobs 目录无 GC

**位置**：[`server.js:4250 VOLUME_JOB_DIR`](web-uploader/server.js#L4250) + [`5753`](web-uploader/server.js#L5753)

每个 job 写 5 个 JSON + 2 个 OBJ + 2 个 PNG + 1 个 PDF（+ 可能 viewer_snapshot.png），且静态对外暴露。没有清理脚本。

**冲击**：磁盘每周可能涨几 GB；预览图泄露过往工程数据。

**建议修复方向**：
- 加定时清理（保留 30 天 / 最近 50 个）；
- 或者把 volume_jobs 改成有 owner / project 命名空间；
- 至少在文档里登记这个事实。

### 4.5 低：volume slot 全局 1 并发

**位置**：[`server.js:4267 maxConcurrentJobs=1`](web-uploader/server.js#L4267)

任何一个用户的体积 job 跑 4 分钟，全服务其他人都得排队（前端会收到 `VOLUME_JOB_BUSY`）。

**冲击**：多人协作场景退化严重。多用户场景下，前端没有友好的"前面还有 X 个任务"反馈。

**建议修复方向**：
- 把 slot 改成 per-user / per-project；
- 或者保留 1 并发但前端排队 UX；
- 或者引入 worker queue（bullmq / 简单 file lock）。

---

## 5. UI / 交互层潜在问题

### 5.1 中：默认 `pointFilterMode = 'exclude_vegetation'` 静默改变结果

**位置**：[`viewer.html:9537`](web-uploader/viewer.html#L9537)

新建 region 时默认就排除 class 3/4/5（低/中/高植被）。如果用户的点云**没有任何分类信息**（class 全是 0），等价于不过滤；但如果点云有人工分类、把树标错成了 class 5，部分实际地表会被丢。这个默认值在 UI 上没有明显标注。

**建议修复方向**：
- 检测到 `classifiedNonDefaultCount === 0`（已经在 `stats` 里返回）时，UI 上显示一行"该点云未带分类，过滤设置无效"；
- 或者把默认改成 'all'，让用户主动开启。

### 5.2 中：场景切换会丢失用户已经手动调过的字段

**位置**：[`assets/app/features/volume/index.js:80-92 applyScenarioDefaultsToRegion`](web-uploader/assets/app/features/volume/index.js#L80) + [`event handler 1062-1067`](web-uploader/assets/app/features/volume/index.js#L1062)

```javascript
applyScenarioDefaultsToRegion(region, value);
updatePanel();
computeVolumeRegion(region);
```

切换场景 → 强制覆盖 baseSurfaceMode + pointFilterMode + surfaceType，立刻重算。

**风险**：用户在 stockpile 模式下已经手动改了 cellSize，切去 ground_fit_volume 看一眼再切回来——cellSize 没动，但 pointFilterMode、surfaceType 都被重置。这是"切换 = reset"还是"切换 = patch"的语义没说明。

**建议修复方向**：
- 切换时弹一个轻量确认（"重置高级设置？"）；
- 或者只覆盖 `defaultBaseMode`，其他字段保留。

### 5.3 中：每次微调字段都立刻触发 recompute

**位置**：散布在 [`index.js:1002-1081`](web-uploader/assets/app/features/volume/index.js#L1002)（cellSize / referenceHeight / displayDensity / surfaceType / pointFilterMode / scenarioMode 全部 onChange 调 `computeVolumeRegion(region)`）

**风险**：
- 用户拖 cellSize input 微调，每次值变更都跑一轮 4-min job。在并发=1 的服务端会迅速堵死。
- 移动端键盘弹起 / 切焦失误，会触发不必要的 job。

**建议修复方向**：
- 加 debounce（500–1500 ms），或者把"自动重算"改成显式按钮（已有 "Re-run" 按钮）。
- 把 `displayDensity` 改成纯前端 viz 调整，不触发后端 recompute（代码里已有这条分支：行 1038-1044，但前提是 `region.computeState === 'ready' && computedCells.length > 0`）。

### 5.4 中：Pick Height 与其他 tool mode 没有互斥保护

**位置**：[`index.js:1083-1126`](web-uploader/assets/app/features/volume/index.js#L1083)

进入 pick height 模式后只挂了 `mousedown` 一次性 listener + ESC，没有 `setToolMode` 切换。

**风险**：如果用户在 pick 状态下又点了工具栏的 Distance / Volume / DXF 等工具，pick listener 还活着，下一次任意点击都会被当成"取高程"。
（实际验证：listener 用了 `{ once: true }`，所以只触发一次，但 `pickHeightActive` 状态可能与新 tool mode 冲突，按钮一直高亮 picking。）

**建议修复方向**：进入 pick 时调 `setToolMode('pick-volume-elevation')`，离开时复位；或者监听全局 toolModeChange 主动 endPickHeightMode。

### 5.5 中：surface display "Both" 状态切换不直观

**位置**：[`index.js:961-970 show-both-surfaces`](web-uploader/assets/app/features/volume/index.js#L961)

逻辑是"如果当前已经是 both 就两个都关，否则把两个都开"。但 UI 是 4 个并列按钮 [Analysis / Base / Both / None]。

**风险**：用户预期"按 Both → 必定显示两层"。但如果当前已经 Both，再点 Both 会**全部关闭**，等价于按了 None。这是反直觉的。

**建议修复方向**：让 [Analysis / Base / Both / None] 严格作为单选，点击谁就显示谁；不要把"已激活时切换"塞进 Both 这一个按钮。

### 5.6 低：导出 Report 的 viewer 截图链路不可降级

**位置**：[`index.js:873-901`](web-uploader/assets/app/features/volume/index.js#L873)

如果 `/api/volume-report-view-snapshot` 失败，前端只 toast "Could not embed the current view screenshot" 然后还是继续下载 PDF——但下载的是**上一次成功带截图的版本**或者**没截图的初始版本**。用户拿到 PDF 时不会注意到里面那张图是过期的。

**建议修复方向**：snapshot 失败时在 PDF 里写"截图未更新（{时间戳}）"，或者把 snapshot 改成 PDF 生成的**前置必要步骤**——失败就不让下载。

### 5.7 低：列表里的 region 顺序与"Active Workspace"指代不一致

**位置**：[`index.js:538 getActiveRegion`](web-uploader/assets/app/features/volume/index.js#L538) / [`renderHistoryRow`](web-uploader/assets/app/features/volume/index.js#L509)

active region 默认是"最后创建的那个"。但如果用户从 Recent Jobs 点了一个老的 region，它就变成 active；下次新建一个 region 又会变成新的 active。期间历史区里"刚刚操作过的"那条会消失（变成 active）。

**风险**：用户一直在两个 region 之间切换比较时容易混乱。

**建议修复方向**：active region 改成"最近交互的"而不是"最近创建的"；history 里高亮"上一次 active"。

### 5.8 低：volume-card-note 前端 inline color 直接写 hex

**位置**：[`viewer.html:10488`](web-uploader/viewer.html#L10488)

```javascript
style="${region.computeState === 'ready' ? (region.coverageRatio < 0.8 || region.samplePoints < 100 ? 'color:#f59e0b;' : 'color:#10b981;') : ''}"
```

我在最近的 light theme 修复里已经用 `[style*="#f59e0b"]` 属性选择器接管了，但这是一个脆弱的耦合。

**建议修复方向**：改成 `class="volume-card-note ${region.coverageRatio < 0.8 ? 'is-warn' : 'is-ok'}"` + 标准 CSS。

---

## 6. 隐藏假设清单（容易踩雷）

逐条登记代码里"现在能跑只是因为某个外部前提"，破前提就失效。

| #   | 假设                                                                 | 一旦破坏发生什么                              | 文件:行                                        |
|-----|----------------------------------------------------------------------|-------------------------------------------|------------------------------------------------|
| H1  | 多边形顶点 Z 必须是真实地表/边界高程                                    | boundary base 偏离实际地面，cut/fill 全偏 | viewer.html:9531 / volume_analysis.py:250     |
| H2  | Polygon 在前端用的"local"坐标 = python 接收到的 LAS 坐标系             | 偏移导致选区与点云完全错位                  | viewer.html:9508-9512 / volume_analysis.py:710 |
| H3  | LAS 文件坐标单位永远是米                                                | 美国测量英尺 / 英尺数据 cellSize/area 全错  | volume_analysis.py 全文未做单位检查           |
| H4  | python 进程 stdout 最后一行是 `RESULT:{json}`                          | server.js 拿不到 result，job 报"未生成产物"| compute_volume_analysis.py:1023 / server.js:4302 |
| H5  | `terrain_python` venv 已装 numpy/laspy/matplotlib/reportlab              | python 启动时 ImportError → 用户看到 "Python exited with code 1" | volume_analysis.py:25-39                |
| H6  | `VOLUME_JOB_DIR` 可写且未被外部清理                                      | 计算成功但写文件失败被报"未生成产物"        | server.js:4277 / 5566                          |
| H7  | 客户端 LAS 路径解析（resolveVolumeRegionLasPath）能拿到一个真实可读文件   | 路径解析失败时 server.js 抛 FILE_NOT_FOUND  | viewer.html:10039 / 10088                      |
| H8  | reportlab 失败可降级——只写 PDF 失败，其他产物照样能出                    | 当前已经是 try/except 软失败，OK            | volume_analysis.py:1001-1018                   |

---

## 7. 已知 bug 与待确认 bug

### 7.1 已确认（来自此次代码阅读）

- [x] **[Bug-V1]** 堆体场景 Net Volume 显示为负数（§3.1）。2026-05-07：UI 按场景显示主指标，堆体/地形拟合显示 Measured Volume。
- [x] **[Bug-V2]** Boundary IDW 受顶点高程异常拖动（§3.2）。2026-05-07：Boundary Z 加 MAD/平坦边界离群过滤。
- [x] **[Bug-V3]** Spike 去噪只过滤正向异常（§3.4）。2026-05-07：改为正负双向过滤，并修正服务端 spikeThreshold payload 位置。
- [x] **[Bug-V4]** holeFillMode='leave' 仍然填 base grid（§3.5）。2026-05-07：analysis/base 都遵守 holeFillMode，并兼容 reference/fixed、ignore/leave。
- [x] **[Bug-V5]** 前端 fallback summary 不带 coverage 因子（§3.8）。2026-05-07：fallback grid 汇总补每格 coverage，边界格按 4x4 采样。
- [x] **[Bug-V6]** 切换场景静默重置 cellSize 之外的所有高级字段（§5.2）。2026-05-07：切换方法前增加轻量确认，避免无提示重置方法参数。
- [x] **[Bug-V7]** 微调字段每次 onChange 都立刻 recompute，无 debounce（§5.3）。2026-05-07：字段变更改为 per-region debounce；displayDensity 改为纯前端显示参数。
- [x] **[Bug-V8]** Pick height 状态与其他 tool mode 没有互斥（§5.4）。2026-05-07：Pick height 会退出截取/删除/绘制状态并进入独立 tool mode。
- [x] **[Bug-V9]** Both surfaces 按钮的"再点关闭"语义反直觉（§5.5）。2026-05-07：Analysis/Base/Both 改为严格单选，None 才负责关闭。

### 7.2 历史用户反馈（占位区——逐条登记）

后续从 issue tracker / 用户反馈搬过来填这里。模板：

```
- [ ] [Bug-V*] 一句话现象
  - 触发步骤：…
  - 预期：…
  - 实际：…
  - 怀疑相关代码：file:line
  - 当前优先级：P0/P1/P2
```

---

## 8. 优化与修复路线图

按"业务影响 × 实施成本"排序，路线图不是承诺，是讨论起点。

### 8.1 P0：必须做（影响结果可信度）

| 编号 | 工作                                                            | 涉及                                     | 估时   |
|------|----------------------------------------------------------------|-----------------------------------------|--------|
| R-1  | 已完成：按场景显示 Net Volume 语义（Pile vs Cut/Fill）           | volume/index.js renderPanelList         | 0.5d   |
| R-2  | 已完成：Boundary IDW 顶点 Z 加 MAD/平坦边界离群过滤              | compute_volume_analysis.py:250          | 0.5d   |
| R-3  | 已完成：Spike 去噪对称化 + 修正服务端 spikeThreshold 字段透传     | compute_volume_analysis.py + server.js  | 0.3d   |
| R-4  | 已完成：holeFillMode 同时作用 base grid，并兼容 reference/ignore  | compute_volume_analysis.py + generate_surface_mesh.py | 0.2d |
| R-5  | 已完成：字段 onChange 加 debounce + displayDensity 设成纯前端调整 | volume/index.js + viewer.html fallback  | 0.5d   |

### 8.2 P1：应该做（提升体验和稳定性）

| 编号 | 工作                                                            | 涉及                                     | 估时   |
|------|----------------------------------------------------------------|-----------------------------------------|--------|
| R-6  | 已完成：引入 confidence 等级 + UI 徽章                            | volume/index.js + viewer.html CSS       | 0.5d   |
| R-7  | 已完成："Both" 按钮严格单选化                                     | volume/index.js                         | 0.2d   |
| R-8  | 已完成：Pick height 切 toolMode + 全局监听变更                    | volume/index.js + viewer.html toolMode  | 0.5d   |
| R-9  | 已完成：volume_jobs 定时清理任务                                  | server.js                               | 0.5d   |
| R-10 | 已完成：切场景前的"高级字段会重置"轻量确认                         | volume/index.js                         | 0.3d   |

### 8.3 P2：性能优化（看用户量决定）

| 编号 | 工作                                                            | 涉及                                     | 估时   |
|------|----------------------------------------------------------------|-----------------------------------------|--------|
| R-11 | 已完成：binning 从逐点循环改为按 cell 分组聚合                  | compute_volume_analysis.py              | 1d     |
| R-12 | 已完成：内部格 coverage 直接取 1，仅边界格 supersample           | compute_volume_analysis.py              | 0.5d   |
| R-13 | 已完成：ground class-2 与 fallback p20 grid 单次聚合生成         | compute_volume_analysis.py              | 1d     |
| R-14 | 已完成：volume slot 改成轻量队列 + 前端排队提示                  | server.js + viewer.html                 | 1.5d   |
| R-15 | 已完成：class-2 不足时对圈选区域启用 Local CSF 地面分类增强 fallback | compute_volume_analysis.py + requirements | 1d   |
| R-16 | 已完成：spike denoise 从 Python 双层循环改为分块 NumPy 邻域批处理    | compute_volume_analysis.py              | 0.5d   |

### 8.4 P3：架构清理（不阻塞业务）

- 删除 `generate_volume_surface.py` 旧链路（已被 `compute_volume_analysis.py` 取代）。
- `volume/compute.js` 里的 P² quantile estimator 已不在主链路使用，确认无人调用后删除。
- shoelace 三处重复抽函数。
- viewer.html 内 `volume*` 函数 ~600 行迁回 `assets/app/features/volume/` 子模块。

---

## 9. 已修复 / 已验证（修复后请追加）

> 模板：日期 · 编号 · 一句话总结 · 改动文件 · 验证证据

```
2026-05-07 · 体积面板浅色覆盖 · viewer.html (LIGHT THEME OVERRIDES — VOLUME PANEL section)
            · 视觉 QA：操作员目视确认体积面板在浅色 viewer 下完全融入 Apple 系
2026-05-07 · R-1 · 结果语义按场景显示：堆体/地形拟合显示 Measured Volume，避免直接把 Fill-Cut 的负数当主指标
           · web-uploader/assets/app/features/volume/index.js, web-uploader/viewer.html
           · 验证：node --check volume/index.js；npm run test:volume
2026-05-07 · R-2 · Boundary IDW 顶点 Z 增加 MAD 过滤；MAD=0 的平坦边界增加绝对偏差兜底；非数值 Z 安全处理
           · web-uploader/scripts/compute_volume_analysis.py
           · 验证：Python 探针 [10,10,10,80] 滤掉 80；Python AST 解析通过；npm run test:volume
2026-05-07 · R-3 · Spike 去噪改为正负双向过滤，并修正 /api/volume-jobs 到 Python 的 analysisSurface.spikeThreshold 透传
           · web-uploader/scripts/compute_volume_analysis.py, web-uploader/server.js
           · 验证：node --check server.js；Python AST 解析通过；npm run test:volume
2026-05-07 · R-4 · analysis/base 两张 grid 都遵守 holeFillMode；reference/fixed、ignore/leave 语义统一
           · web-uploader/scripts/compute_volume_analysis.py, web-uploader/scripts/generate_surface_mesh.py, web-uploader/server.js
           · 验证：Python 探针 reference 填洞为固定高程；Python AST 解析通过；npm run test:volume
2026-05-07 · R-5 · 字段变更改为 per-region debounce；displayDensity 永远只影响前端 overlay，不触发后端 volume job
           · web-uploader/assets/app/features/volume/index.js, web-uploader/viewer.html
           · 验证：node --check volume/index.js；npm run test:volume
2026-05-07 · R-6 · Result 区增加 Confidence 状态徽章，和 warnings 一起帮助判断结果可信度
           · web-uploader/assets/app/features/volume/index.js, web-uploader/viewer.html
           · 验证：node --check volume/index.js；npm run test:volume
2026-05-07 · R-7 · Surface 显示按钮改为严格单选；Analysis/Base/Both 再点不关闭，只有 None 关闭
           · web-uploader/assets/app/features/volume/index.js
           · 验证：node --check volume/index.js；npm run test:volume
2026-05-07 · R-8 · Pick height 进入独立 tool mode，先退出截取/删除/绘制状态，并用捕获阶段监听点击
           · web-uploader/assets/app/features/volume/index.js
           · 验证：node --check volume/index.js；npm run test:volume
2026-05-07 · R-9 · volume_jobs 增加自动清理，默认保留 3 天，每 6 小时清理一次，可用环境变量调整
           · web-uploader/server.js
           · 验证：node --check server.js；npm run test:volume
2026-05-07 · R-10 · 场景/方法切换前增加确认，避免静默重置 base surface、point filter、surface mode
           · web-uploader/assets/app/features/volume/index.js
           · 验证：node --check volume/index.js；npm run test:volume
2026-05-07 · R-11 · grid binning 从逐点 Python 循环改为每批数据按 flat cell 排序分组，再按 cell 求 percentile/max/min
           · web-uploader/scripts/compute_volume_analysis.py
           · 验证：python -m py_compile；npm run test:volume；25 万点合成探针 grid 聚合约 0.27s
2026-05-07 · R-12 · coverage 计算改为内部格直接 1，只有边界候选格做 4x4 supersample
           · web-uploader/scripts/compute_volume_analysis.py
           · 验证：python -m py_compile；npm run test:volume；矩形全覆盖探针 coverage 均值 1.0、耗时约 0.002s
2026-05-07 · R-13 · ground-fitted base 的 class-2 grid 与 low-percentile fallback grid 共用一次 cell 聚合缓存
           · web-uploader/scripts/compute_volume_analysis.py
           · 验证：python -m py_compile；npm run test:volume；25 万点合成探针 ground-pair 聚合约 0.47s
2026-05-07 · R-14 · volume 计算槽从直接 429 改为轻量 FIFO 队列；默认 1 并发、4 个排队、最多等 10 分钟
           · web-uploader/server.js, web-uploader/viewer.html
           · 验证：node --check server.js；npm run test:volume
2026-05-07 · R-15 · Ground-Fitted 在 class-2 不足时先对圈选区域跑 Local CSF，成功则使用 local_csf_fit，失败才退回 P20 fallback
           · web-uploader/scripts/compute_volume_analysis.py, web-uploader/scripts/classify_ground.py, web-uploader/requirements-export.txt, web-uploader/setup-local.sh, web-uploader/assets/app/features/volume/index.js, web-uploader/viewer.html
           · 验证：本地安装 cloth-simulation-filter；CSF import 检查通过；新增 local_csf_fit 集成测试；npm run test:volume 17/17 通过
2026-05-07 · Bug-V5 · 前端 fallback summary 补 coverage 因子；边界格按 4x4 估算，cut/fill 体积不再把边缘格按全格计算
           · web-uploader/viewer.html
           · 验证：node --check viewer 相关依赖；npm run test:volume
2026-05-07 · §3.9 · computed cell kind 阈值与积分阈值对齐，fallback overlay 也按严格正负号区分 cut/fill/neutral
           · web-uploader/viewer.html
           · 验证：npm run test:volume
2026-05-07 · §3.6 · fixed-plane 模式增加前端 reference elevation 硬校验，缺失时拒绝提交而不是静默使用顶点平均
           · web-uploader/viewer.html
           · 验证：node --check；npm run test:volume
2026-05-07 · §5.8 · legacy fallback 面板状态颜色从 inline style 改为 is-ok/is-warn class，浅色主题不再依赖属性选择器兜底
           · web-uploader/viewer.html
           · 验证：node --check；npm run test:volume
2026-05-07 · 审核跟进 · ground_fit_volume 主指标改为显示 cut/fill 中占主导的一侧，凹坑/填方场景不再把接近 0 的 cut 当 Measured Volume
           · web-uploader/assets/app/features/volume/index.js
           · 验证：node --check volume/index.js；npm run test:volume 17/17
2026-05-07 · 审核跟进 · 删除/重画/清空 region 时同步清理 pendingComputeTimers，避免 600ms debounce 后触发幽灵计算
           · web-uploader/assets/app/features/volume/index.js
           · 验证：node --check volume/index.js；npm run test:volume 17/17
2026-05-07 · 审核跟进 · Pick Height 进入前记录原 toolMode/status，退出后恢复原状态，不再硬编码回 Ready
           · web-uploader/assets/app/features/volume/index.js, web-uploader/viewer.html
           · 验证：node --check volume/index.js；npm run test:volume 17/17
2026-05-07 · 审核跟进 · VOLUME_JOB_BUSY / 排队超时在前端显示专门提示，避免用户只看到通用 compute failed
           · web-uploader/viewer.html
           · 验证：npm run test:volume 17/17
2026-05-07 · R-16 · spike denoise 从 rows x cols Python 双层循环改为 3x3 邻域分块 NumPy 批处理；去噪阈值、support>2 跳过、P25/P50/P75 口径保持不变，同时避免超大网格一次性堆 9 份邻域数组
           · web-uploader/scripts/compute_volume_analysis.py
           · 验证：python -m py_compile；npm run test:volume 17/17
2026-05-07 · UI 跟进 · Cancel/Clear 按钮按 pending selection + regions 判断启用；Clear 会清理体积 region、pending 状态、overlay、surface 和 volume contours
           · web-uploader/assets/app/features/volume/index.js
           · 验证：node --check volume/index.js；npm run test:volume；npm run test:viewer-volume
2026-05-07 · UI 跟进 · 新体积 region 首次计算直接采用推荐 Cell size；推荐提示在已采用时显示 Using recommended，不再要求用户再点 Apply
           · web-uploader/viewer.html, web-uploader/assets/app/features/volume/index.js
           · 验证：npm run test:viewer-volume 覆盖 Volume workspace 的 recommended hint
2026-05-07 · UI 跟进 · Volume 面板顺序调整为 Surfaces → Advanced settings → Contours，把 Contours 保持在体积模块最后，和计算设置分离
           · web-uploader/assets/app/features/volume/index.js, web-uploader/tests/viewer-volume-flow.test.mjs
           · 验证：npm run test:viewer-volume 断言最后两个 drawer 为 Advanced settings / Contours
```

---

## 10. 文档维护约定

- **新增**：发现新问题 → 加进 §3-§7 对应位置 + §8 给个编号 R-X
- **修复**：完成后把对应 [ ] 改 [x]，再到 §9 追加一行验证记录
- **作废**：被替代或不再适用的条目，加 `~~删除线~~` 而不是直接删，留住历史
- **更新顶端"最后更新"日期**

文档路径相关引用都用相对仓库根的 markdown 链接，CI / GitHub web 视图和 cursor 都能跳转。

---

## 附录 A：相关文件快速查阅

| 文件                                                | 关键行                       | 作用                              |
|-----------------------------------------------------|------------------------------|-----------------------------------|
| `web-uploader/viewer.html`                          | 9270, 9504, 10061           | 多边形几何 / region 创建 / 计算入口 |
| `web-uploader/assets/app/features/volume/index.js`  | 80, 528, 1192               | scenario defaults / 主渲染 / updatePanel |
| `web-uploader/assets/app/features/volume/compute.js`| 全文                         | 旧版 cell 累积器（半弃用）         |
| `web-uploader/server.js`                            | 4261, 5470, 5610             | 限额 / 入口 / 结果读取             |
| `web-uploader/scripts/compute_volume_analysis.py`   | 176, 250, 287, 666, 840    | grid 构建 / boundary IDW / coverage / main / 积分 |
| `web-uploader/scripts/generate_volume_surface.py`   | 全文                         | 旧链路（待删除）                  |
| `Volume Rebuild Design Doc.md`                      | §3, §6, §13                  | 现状问题 / 算法设计 / Windows 合并 |

## 附录 B：关键限额与默认值

| 项                            | 值                | 来源                                  |
|-------------------------------|-------------------|---------------------------------------|
| 最小 cell size                | 0.25 m            | `VOLUME_SURFACE_LIMITS.minResolution` |
| 最大多边形面积                  | 10000 m²          | `CLOUDSTUDIO_VOLUME_MAX_AREA_M2`     |
| 最大 cell 数                   | 12000              | `CLOUDSTUDIO_VOLUME_MAX_CELLS`        |
| 最大顶点数                     | 80                 | `CLOUDSTUDIO_VOLUME_MAX_VERTICES`     |
| 最大源 LAS                     | 1.5 GB             | `CLOUDSTUDIO_VOLUME_MAX_SOURCE_MB`    |
| 并发 job                       | 1                  | `CLOUDSTUDIO_VOLUME_MAX_CONCURRENT`   |
| Python 超时                    | 4 min              | `CLOUDSTUDIO_VOLUME_TIMEOUT_MS`       |
| 默认 spike threshold           | 0.35 m             | viewer.html:9542                      |
| 默认 cell size 估算            | extent / 160-180  | viewer.html:9376                      |
| 默认 displayDensity            | 1                  | viewer.html:9533                      |
| coverage_ratio warning 阈值    | 0.85              | compute_volume_analysis.py:940        |
| effective_cell_count warning 阈值 | 500             | compute_volume_analysis.py:942        |
| ground_support_ratio warning 阈值 | 0.05            | compute_volume_analysis.py:938        |
