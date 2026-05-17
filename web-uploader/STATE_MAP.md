# Viewer 状态地图

最后更新：2026-04-09  
适用范围：

- `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/viewer.html`
- `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/assets/app/entry/viewer-entry.js`
- `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server/web-uploader/assets/app/features/*`

目的：

- 给当前 viewer 的真实状态结构建立一份可维护地图
- 区分“状态域”“兼容代理”“Potree 运行时对象”“feature 私有状态”
- 帮接手者快速判断某个 bug 应该从哪一层切入

这份文档描述的是“当前实际状态”，不是重构计划。

---

## 1. 先建立整体心智模型

当前 viewer 的状态不是单一来源，而是四层叠加：

1. `APP_SHELL` state domain
   - 通过 `APP_SHELL.ensureStateDomain(...)` 创建的显式状态域
   - 当前已有：
     - `viewer.ui`
     - `viewer.datasetContext`
     - `viewer.scannerSelection`
     - `viewer.displaySettings`
     - `viewer.crsCatalog`
     - `viewer.scannerRegistry`

2. legacy shell 本地状态
   - 直接定义在 `viewer.html` 中的对象/变量
   - 例如：
     - `profileState`
     - `deleteSelectionState`
     - `volumeMeasureState`
     - `clipBoxState`
     - `captureActive`
     - `capturePoints`

3. 兼容代理 / 混合桥接状态
   - 主要是：
     - `scannerGlobalState`
     - `scannerState` Proxy
     - `activeDatasetContext` 这个本地别名
   - 它们是当前最大的不透明风险来源

4. Potree 自己持有的运行时状态
   - 例如：
     - `viewer.scene.pointclouds`
     - `viewer.scene.measurements`
     - `viewer.scene.volumes`
     - `viewer.scene.profiles`
     - `viewer.profileWindow`
     - `viewer.profileWindowController`

排障最容易犯的错，就是把这四层混成一层看。

---

## 2. 当前显式状态域

这些状态域在 `viewer.html` 开头通过 `APP_SHELL.ensureStateDomain(...)` 建立，是当前最接近“正式状态层”的部分。

### 2.1 `viewer.ui`

当前字段：

- `toolMode`
- `navigationPivotMode`
- `activeRightPane`
- `rightPanelCollapsed`

职责：

- 记录当前 UI 交互模式和右侧面板状态

关键写入方：

- `setTool(name)`
- 右侧 pane/tab 切换逻辑
- 导航 pivot 切换逻辑

关键读取方：

- measurement feature
- dxf draw feature
- profile / clip / delete / volume 等工具入口
- `syncRightPanelUi()`

风险等级：中高

说明：

- 这是当前工具模式的显式来源，已经比旧版文档所说的“完全隐式 tool mode”更进一步了。
- 但它仍只是 UI 层状态，不等于各功能真的已经停止运行。比如某工具 `toolMode` 变了，不代表所有事件监听器已经解除。

### 2.2 `viewer.datasetContext`

当前字段：

- `active`

`active` 的典型形态：

- 普通点云：
  - `{ type: 'cloud', cloudName, ... }`
- 扫描项目：
  - `{ type: 'scanner', projectId, projectName, cloudName?, ... }`

职责：

- 当前 viewer 正在操作的“数据集上下文”
- 是导出、Auto Extract、terrain、scanner 关联、source resolution 的主键之一

关键写入方：

- `setActiveDatasetContext(context)`
- `loadCloud(...)`
- `loadScanProject(...)`
- `open-load-orchestration` feature
- `setSelectedScannerProject(..., { syncContext: true })`

关键读取方：

- `export-las` feature
- `terrain` feature
- `dxf-draw` 的 Auto Extract
- 部分 scanner / cloud 联动逻辑

风险等级：高

说明：

- `setActiveDatasetContext()` 变化时会清理删除区域和体积区域，这是一个很关键的联动副作用。
- 如果这个上下文错了，很多功能不是直接报错，而是“悄悄跑错数据”。

### 2.3 `viewer.scannerSelection`

当前字段：

- `selectedProjectId`
- `sceneAnchorProjectId`

职责：

- 当前选中的 scanner project
- 当前多扫描项目场景中的锚点 project

关键写入方：

- `patchScannerSelectionState(...)`
- `setSelectedScannerProject(...)`
- scanner project 移除/清理流程

关键读取方：

- `getCurrentScannerProjectId()`
- `getSceneAnchorProjectId()`
- scanner UI / minimap / photo / CRS / 坐标转换

风险等级：高

说明：

- 这已经是“选中 scanner 项目”的真实来源。
- 旧文档里提到的 `activeScanProject` 现在不再是主选中源，应视为历史说法。

### 2.4 `viewer.displaySettings`

当前字段：

- `current`

`current` 的主要内容：

- `linearUnit`
- `profileBackground`
- 其它 viewer 显示相关偏好

职责：

- viewer 级显示偏好
- 单位、剖面背景等跨功能显示设置

关键写入方：

- `setDisplaySettingsState(...)`
- display settings UI
- scanner runtime / profile 背景切换

关键读取方：

- 格式化函数
- measurement / scanner-info / export 等显示文本
- profile 背景渲染

风险等级：中

### 2.5 `viewer.crsCatalog`

当前字段：

- `availableServerGrids`
- `authorityRegistry`
- `authorityRequests`

职责：

- 全局 CRS/格网支持状态

关键写入方：

- `setAvailableServerGrids(...)`
- authority code resolve 逻辑
- grid import / refresh 逻辑

关键读取方：

- scanner runtime
- CRS UI
- 坐标系统 summary / preview

风险等级：中高

说明：

- 这是全局支持缓存，不是项目专属配置。
- 真正项目级 CRS 配置还在各个 `projectState.coordConfig` 中。

### 2.6 `viewer.scannerRegistry`

当前字段：

- `projects: Map`

职责：

- 存储每个 scanner project 的状态对象

关键写入方：

- `ensureScannerProjectState(...)`
- `loadCloud(...)`
- `loadScanProject(...)`
- scanner 数据载入/清理逻辑

关键读取方：

- 几乎所有 scanner 相关功能

风险等级：高

说明：

- 这是 project-scoped state 的容器，不是单个项目状态本身。

---

## 3. 当前 project-scoped 状态：`ScannerProjectState`

真实形态来自 `createEmptyScannerProjectState(projectId)`。

## 3.1 关键字段分组

### A. 标识与路径

- `projectId`
- `projectName`
- `scanDataUrl`
- `pointcloudUrl`
- `cloudName`
- `accentColor`

用途：

- 标识当前项目
- 生成 UI 标签
- 推导 scanner 相关静态资源路径

### B. 场景对象引用

- `pointcloud`
- `pointcloudContainer`
- `overlayContainer`
- `trajGroup`
- `camGroup`
- `frustumGroup`

用途：

- 指向该项目在 3D scene 中的对象
- 支撑多项目同时存在时的容器变换与显隐控制

风险：

- 这是最容易和 scene-tree、多项目叠加、相机/轨迹可视化打架的部分。

### C. 原始数据 / 元数据

- `odomData`
- `cameras`
- `geoInfo`
- `paramsJson`
- `metaJson`
- `transformsJson`
- `transformsCentroid`
- `photoManifest`

用途：

- 这些字段是 scanner-info、photo、minimap、camera marker、坐标转换的基础数据源

说明：

- `photoManifest` 是近期较新的状态，用于过滤掉不存在的图片帧，避免 photo 404。

### D. 项目内 UI / 运行时

- `photoIndex`
- `photoSide`
- `timelineAnim`
- `overlayRotation`

用途：

- 控制当前项目照片浏览和时间线动画

风险：

- 这些虽然是项目级，但常被 `scannerState` proxy 隐式访问，写的时候很容易误以为是全局状态。

### E. 坐标系 / 变换运行时

- `coordConfig`
- `resolvedCoordinateSystem`
- `geoMouseMoveHandler`
- `importedGridFile`
- `authorityResolveError`
- `nativeTransformCache`
- `nativeTransformInflight`
- `nativeTransformQueue`
- `nativeTransformTimer`

用途：

- 当前项目的 CRS 配置、解析结果、native transform batching 等

风险：

- 高风险区。很多“坐标显示正常但导出不对”的问题都在这里。

### F. 轨迹 / 相机显示设置

- `trajSettings`
- `cameraSettings`

用途：

- 当前项目轨迹与相机的显示参数

---

## 4. 兼容桥接状态

这些状态不是“错误”，但它们会显著增加理解和排障难度。

### 4.1 `activeDatasetContext` 本地变量

现状：

- `let activeDatasetContext = datasetContextState.active || null`
- `getActiveDatasetContext()` 真正返回的是 `datasetContextState.active`
- `setActiveDatasetContext()` 会同时更新这个本地变量和 state domain

结论：

- 真正应该相信的是 `datasetContextState.active`
- 本地变量目前只是 legacy 兼容别名

风险等级：中

### 4.2 `scannerGlobalState`

现状：

- 它把以下内容拼在一起：
  - `projects`
  - `selectedProjectId`
  - `sceneAnchorProjectId`
  - `displaySettings`
  - `authorityCrsRegistry`
  - `authorityCrsRequests`
  - `availableServerGrids`

结论：

- 它更像“兼容视图模型”，不是新的单一真相

风险等级：高

### 4.3 `scannerState` Proxy

现状：

- 对外伪装成一个统一对象：
  - 先读写 `scannerGlobalState`
  - 再把 `SCANNER_PROJECT_STATE_KEYS` 上的字段代理到“当前选中项目”的 state

为什么危险：

- 同样的 `scannerState.xxx = value`
  - 有的字段是全局写入
  - 有的字段实际写到当前项目
- 读代码时非常不透明

当前结论：

- 这是当前最大的状态理解风险点
- 接手者遇到 scanner / CRS / photo / minimap / export 联动问题，必须先确认你操作的字段是全局的还是项目级的

---

## 5. feature 私有状态

这些状态不在 `APP_SHELL` 里，而是各 feature 或 legacy shell 自己维护。

## 5.1 `profileState`

当前字段：

- `activeProfile`
- `pointSize`
- `infoEnabled`
- `panel.visible`
- `panel.positioned`
- `triangle.*`

职责：

- profile 面板与剖面三角测量的私有状态

注意：

- 旧版文档把 `activeProfile` 作为顶层裸变量已经不准确，现在它在 `profileState` 内。

## 5.2 Capture

当前状态：

- `captureActive`
- `capturePoints`
- `captureIdSeq`

职责：

- 点位采集模式和采集结果

说明：

- `captureFeature` 只是 UI/封装层，真实数据仍在 legacy shell 变量里。

## 5.3 `deleteSelectionState`

当前职责：

- 删除区域绘制
- staged / committed 区域
- preview overlay
- preview clip task/method
- panel dismissed 状态

关键风险：

- 它不仅是 UI 状态，还会影响导出和点过滤逻辑。

## 5.4 `volumeMeasureState`

当前职责：

- 体积区域绘制、preview、结果、overlay、compute token

关键风险：

- 它和 terrain、surface、contour、scene-tree 强联动，不是一个“只画框”的轻状态。

## 5.5 `clipBoxState`

当前字段：

- `active`
- `mode`
- `translationEnabled`
- `rotationEnabled`
- `selectionCounter`
- `currentInsertionVolume`
- `selectedVolume`
- `selectionLock`

关键风险：

- 它和 `viewer.scene.volumes` 以及 Potree selection 共同决定当前 clip box 的真正状态。

## 5.6 DXF Draw feature 私有状态

来自 `assets/app/features/dxf-draw/index.js` 的闭包状态，当前重要字段包括：

- 图层/线段：
  - `layers`
  - `activeLayer`
  - `selectedLineId`
  - `undoStack`
- 绘制交互：
  - `drawing`
  - `pendingMeasure`
  - `activeDrawSession`
  - `pendingDrawMode`
- 拓扑/拖拽：
  - `vertexLinks`
- Auto Extract：
  - `floorplanLoading`
  - `floorplanResult`
  - `floorplanPreviewVisible`
  - `floorplanPreviewObjects`
  - `floorplanSourceMode`
  - `floorplanConfig`

结论：

- 这些状态不在 `viewer.html` 顶层，但对 DXF 功能来说是真正的主状态。

## 5.7 其它 feature 私有状态

当前明确存在的还有：

- `minimapState`
  - 在 `features/minimap/index.js` 中管理
- `terrain` 内部状态
  - `dtmState`
  - `surfaceState`
  - `contourState`
  - `gcState`
  - `semanticState`
  - `treeState`

结论：

- 文档和排障时不要只盯 `viewer.html`。有些新模块已经把关键状态收进 feature 闭包了。

---

## 6. Potree 自己持有的运行时状态

这些对象不是我们定义的，但很多业务功能直接依赖它们。

### 6.1 Scene 对象

- `viewer.scene.pointclouds`
- `viewer.scene.measurements`
- `viewer.scene.volumes`
- `viewer.scene.profiles`

### 6.2 Profile runtime

- `viewer.profileTool`
- `viewer.profileWindow`
- `viewer.profileWindowController`

### 6.3 输入与选择

- `viewer.inputHandler.selection`
- `viewer.inputHandler.drag`

### 6.4 结论

- 这些状态不能简单复制到自己的状态层里，否则会与 Potree 真值脱节。
- 更合理的方式是“引用 + 包装访问”，而不是镜像存一份。

---

## 7. 当前高风险联动图

## 7.1 数据主键链路

最关键的跨模块主键：

- `activeDatasetContext`
- `selectedProjectId`
- `projectState.cloudName`
- `projectState.pointcloudUrl`

受影响功能：

- open/load orchestration
- scanner runtime
- export-las
- terrain
- dxf-draw Auto Extract

只要这条链任何一处不同步，就可能出现：

- 用错源 LAS
- 导出打错数据
- Auto Extract 跑错数据
- scanner 信息与当前 viewer 数据不一致

## 7.2 工具模式链路

共享一套工具切换约定的功能：

- measurement
- profile
- clip box
- delete region
- volume
- capture
- dxf draw

当前显式 UI 状态是：

- `uiState.toolMode`

但真实运行是否结束，还要看各自是否正确：

- stop
- cancel
- 移除事件监听
- 清理 overlay

## 7.3 CRS / 坐标链路

涉及状态：

- `displaySettingsState.current`
- `crsCatalogState.*`
- `projectState.coordConfig`
- `projectState.resolvedCoordinateSystem`
- `projectState.nativeTransform*`
- `scannerState` proxy

受影响功能：

- scanner-info
- measurement
- capture
- export-las
- terrain
- minimap

## 7.4 多扫描项目链路

涉及状态：

- `scannerSelectionState.selectedProjectId`
- `scannerSelectionState.sceneAnchorProjectId`
- `projectState.pointcloudContainer`
- `projectState.overlayContainer`
- `trajGroup / camGroup / frustumGroup`

受影响功能：

- minimap
- photo
- scanner runtime
- scanner-info
- 任何 project-relative 坐标转换

## 7.5 DXF / measurement / clip 交互链路

涉及：

- `dxfDrawFeature` 闭包状态
- `viewer.scene.measurements`
- `volumeMeasureState`
- `deleteSelectionState`
- `clipBoxState`
- `uiState.toolMode`

结论：

- 这几条功能链都会抢鼠标、事件、选择和 overlay，属于最容易“改一个坏三个”的区域。

---

## 8. 当前最值得信的访问入口

排障时，优先从这些 getter / setter / helper 入手，而不是直接改裸变量。

### 数据集 / 项目选择

- `getActiveDatasetContext()`
- `setActiveDatasetContext(context)`
- `getCurrentScannerProjectId()`
- `setSelectedScannerProject(projectId, options)`
- `patchScannerSelectionState(...)`

### 项目状态

- `ensureScannerProjectState(projectId)`
- `getScannerProjectState(projectId)`
- `getCurrentScannerRuntimeState(projectId)`

### 显示与 CRS

- `getDisplaySettingsState()`
- `setDisplaySettingsState(next)`
- `getAvailableServerGrids()`
- `setAvailableServerGrids(next)`
- `getCurrentCoordConfig(projectId)`
- `setCurrentCoordConfig(next, projectId)`
- `getCurrentResolvedCoordinateSystemState(projectId)`
- `setCurrentResolvedCoordinateSystemState(next, projectId)`

### 场景容器 / 多项目变换

- `ensureScannerProjectContainers(projectId)`
- `removeScannerProjectContainers(projectId)`
- `applyScannerProjectContainerTransform(projectId)`
- `updateAllScannerSceneTransforms()`

### 工具模式

- `setTool(name)`

---

## 9. 与旧版文档相比，已经过时的说法

下面这些旧说法现在不再准确：

1. “tool mode 仍然完全隐式”
   - 现在已有 `uiState.toolMode`

2. “activeScanProject 是主选中源”
   - 当前真实选中源是 `scannerSelectionState.selectedProjectId`

3. “activeProfile 是顶层裸变量”
   - 现在已经收进 `profileState.activeProfile`

4. “只有 viewer.html 持有关键状态”
   - 现在 feature 闭包里也有重要私有状态，特别是：
     - `dxf-draw`
     - `terrain`
     - `minimap`

5. “STATE_MAP 主要是为 measurement/profile 抽离做准备”
   - 现在更应该把它当成：
     - 当前状态真相地图
     - 排障入口文档
     - 重构前的边界说明

---

## 10. 当前接手建议

如果要快速上手当前状态体系，建议按这个顺序读代码：

1. `viewer.html`
   - 看 state 初始化块
   - 看 `ensureViewerFeatureModulesInitialized()`
   - 看 `setTool()`、`setActiveDatasetContext()`、scanner project state 相关 helper

2. `assets/app/entry/viewer-entry.js`
   - 看 feature 如何注入

3. `STATE_MAP.md`
   - 建立当前状态层次感

4. 再按问题进入 feature：
   - DXF：`assets/app/features/dxf-draw/index.js`
   - 导出：`assets/app/features/export-las/index.js`
   - terrain：`assets/app/features/terrain/index.js`
   - scanner：`assets/app/features/scanner-runtime/index.js`
   - measurement：`assets/app/features/measurement/index.js`

---

## 11. 这次同步更新说明

本次更新把文档同步到了当前现状，主要反映了这些变化：

- 明确承认 `APP_SHELL` 六个 state domain 已经在使用
- 把 `scannerSelectionState.selectedProjectId` 写成当前 scanner 主选中源
- 把 `profileState`、`deleteSelectionState`、`volumeMeasureState`、`clipBoxState` 写入正式状态地图
- 把 feature 闭包私有状态纳入地图，尤其是 DXF Draw 和 terrain
- 明确 `scannerState` Proxy 仍是当前最大状态风险点
- 把这份文档用途从“抽离前分析”升级为“当前状态真相地图”
