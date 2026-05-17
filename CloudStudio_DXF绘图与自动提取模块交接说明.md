# CloudStudio DXF绘图与自动提取模块交接说明

## 1. 文档目的
这份文档用于记录当前 CloudStudio 中与 DXF 相关的两条能力线：

1. DXF 导入/显示
2. DXF 绘图与室内墙线自动提取（Beta）

目标是方便后续维护人员快速理解：

- 这次开发改了什么
- 核心文件在哪里
- 现在的能力边界是什么
- 后续如果继续开发，优先从哪里入手

本文档只聚焦当前实际代码状态，不展开历史需求讨论。

---

## 2. 当前功能范围

### 2.1 DXF 导入
当前系统支持在网页端导入 `.dxf` 文件，并在 3D 视图中作为叠加图层显示。

当前特性：

- 支持多文件导入
- 支持拖拽导入与文件选择器导入
- 支持按 DXF 图层显示/隐藏
- 支持 DXF 文件整体移除
- 支持颜色导入
  - 优先读取 `420` true color
  - 回退读取 `62` ACI 颜色
- 避免同一文件因重复绑定事件而在面板中出现两份

### 2.2 DXF 绘图
当前系统支持在 DXF pane 内直接绘制和编辑线段。

当前绘图模式：

- 自由线段
- 垂线
- 水平线
- 交点画线（两墙求交）

当前绘图能力：

- 图层管理
- 颜色选择与图层统一上色
- 线段删除
- 选中已有线段并删除
- 撤销
- DXF 导出
- 连续绘制
- 端点吸附
- 顶点联动拖拽

### 2.3 自动提取（Beta）
当前已经补入首版“基于水平切片的室内墙线自动提取”主链路。

当前目标不是生成最终 CAD 平面图，而是：

- 从当前原始 LAS/LAZ 数据中提取候选墙线
- 结果先在前端预览
- 用户确认后导入为可编辑 DXF 线段

当前假设：

- 单层室内
- 近 Manhattan / 近正交墙体
- 水平切片可覆盖主要墙面

明确不做：

- 自动门洞识别
- 墙厚恢复
- 多楼层自动拆层
- 完整拓扑闭合
- IFC/BIM 输出

---

## 3. 关键文件

### 3.1 前端

#### 1) `web-uploader/viewer.html`
作用：

- Viewer 主页面
- DXF pane 静态结构
- feature 初始化入口
- 多语言切换总线
- 旧版 DXF 内联导入逻辑（已保留但加了 feature 存在时跳过）

和 DXF 相关的重要位置：

- DXF pane 结构
- `createDxfFeature(...)`
- `createDxfDrawFeature(...)`
- 切换语言时的 DXF 面板重绘

#### 2) `web-uploader/assets/app/features/dxf/index.js`
作用：

- 管理 DXF 文件列表区
- 文件项、图层项的动态渲染
- DXF 文件输入 / 拖拽导入绑定

当前注意点：

- 已修复 dropZone 和 document 级 `drop` 的重复处理
- 已接入 `translate / translateText`

#### 3) `web-uploader/assets/app/features/dxf-draw/index.js`
作用：

- DXF 绘图核心模块
- 当前最复杂的前端文件之一

负责内容：

- 线段数据状态
- 图层与颜色管理
- 导出 DXF
- 端点吸附与联动拖拽
- 交点画线状态机
- 垂线/水平线约束绘制
- 自动提取 Beta 卡片
- 自动提取结果 preview
- 自动提取结果导入现有 DXF 绘线系统

这是后续修改的主战场。

#### 4) `web-uploader/assets/app/features/scanner-info/index.js`
作用：

- 扫描项目信息面板
- 本次只补了一个漏翻译点：`Extent`

### 3.2 服务端

#### 5) `web-uploader/server.js`
作用：

- Node/Express 服务端主入口
- 所有 API 路由

本次新增内容：

- `POST /api/floorplan/extract`
- `floorplan_jobs` 静态目录
- 自动提取脚本调用链

### 3.3 Python

#### 6) `web-uploader/scripts/extract_floorplan.py`
作用：

- 首版室内墙线候选提取脚本

当前算法流程：

1. 读取 LAS/LAZ
2. 取 `zCenter ± thickness/2` 的水平切片
3. XY 投影后做 PCA 旋正（可关闭）
4. 栅格化为密度图
5. 形态学清理
6. 按“vertical/horizontal”方向做候选墙线提取
7. 合并共线段
8. 逆变换回世界坐标
9. 输出 `segments / corners / debugImages / stats`

当前依赖：

- `numpy`
- `scipy`
- `laspy`
- `matplotlib`

没有引入 Open3D / PCL / 深度学习依赖。

### 3.4 多语言

#### 7) `web-uploader/assets/i18n/en.json`
#### 8) `web-uploader/assets/i18n/zh-CN.json`
#### 9) `web-uploader/assets/i18n/fr.json`
#### 10) `web-uploader/assets/i18n/ko-KR.json`

本次新增了：

- `viewer.dxf.*`
- `viewer.dxf.draw.*`
- `viewer.dxf.file.*`
- `viewer.dxf.drop.*`
- `viewer.dxf.floorplan.*`

---

## 4. DXF绘图模块结构说明

### 4.1 数据结构
`dxf-draw/index.js` 内部核心状态：

- `layers: Map`
  - 每个图层包含 `color / lineWidth / visible / lines`
- `lines`
  - 每条线段绑定一个 Potree `Measure`
- `undoStack`
  - 创建顺序栈
- `vertexLinks`
  - 端点联动关系

### 4.2 正式线段 vs 临时对象
这里一定要区分：

#### 正式 DXF 线段
走 Potree `Measure`

用途：

- 可编辑
- 可导出
- 可选中
- 可删除
- 可参与端点联动

#### 临时辅助对象
走 overlay scene 的轻量对象或辅助线

用途：

- 交点提取预览
- 墙线预览
- 自动提取 preview
- 三角形辅助线

原则：

- 临时对象只用于看
- 正式对象才进入 DXF 数据状态

这条边界后续要继续保持，不要混用。

### 4.3 交点画线
交点画线当前是单独状态机：

- `PICKING_WALL_A`
- `PICKING_WALL_B`

支持：

- 链式找角点
- 预览辅助线
- `C` 闭合
- `Esc` 完成

相关状态：

- `ciState`
- `ciWallA`
- `ciCorners`
- `ciFirstLineEntry`
- `ciPrevLineEntry`

后续修改这部分时，要特别小心：

- 交点 preview 清理
- 顶点联动
- 和普通绘制模式互斥

### 4.4 垂线 / 水平线
当前是“约束线”模式。

基本原则：

- 水平线：共享同一个 Z
- 垂线：共享同一个 XY

这部分最近调试较多，容易出回归。后续改动时要重点回归：

- 初始绘制位置是否正确
- 拖动任一端点是否能正确微调
- 拖动后是否会回弹
- 辅助线是否会残留
- EDL 开启时辅助线是否可见

---

## 5. 自动提取（Beta）实现说明

### 5.1 入口位置
当前放在 DXF 绘图区域上方，作为一张独立卡片：

- 数据源
- 切片中心高度
- 切片厚度
- 最小墙长
- 合并容差
- 自动对齐
- 优先正交墙
- 显示预览
- 提取按钮
- 导入到 DXF 绘线按钮

### 5.2 数据源选择
当前前端默认通过 viewer 当前上下文拿源：

- 普通点云：`cloudName`
- 扫描项目：`projectId`

服务端再通过已有逻辑解析最佳原始 LAS/LAZ：

- 优先项目目录
- 其次 `source.json`
- 其次 uploads

这部分复用了现有 `/api/find-las` 同源思路。

### 5.3 服务端返回结构
`/api/floorplan/extract` 当前返回：

- `jobId`
- `sourcePath`
- `sourceName`
- `projectName`
- `scannerProjectId`
- `sliceBounds`
- `rasterMeta`
- `segments[]`
- `corners[]`
- `debugImages[]`
- `stats`

### 5.4 前端导入方式
提取结果不会自动写进 DXF。

流程是：

1. 先 preview
2. 用户点击“导入到 DXF 绘线”
3. 调用 `importSegments(...)`
4. 写入 `AutoFloorplan` 图层

这是有意设计的，避免算法误检直接污染用户数据。

---

## 6. 这次已经修过的一些关键问题

以下问题已经处理过，后续不要重复引入：

### 6.1 DXF 导入重复显示两份
根因：

- 旧 viewer 内联输入绑定
- 新 feature 输入绑定
- dropZone 与 document 两级 drop 都吃到同一次事件

修复：

- feature 存在时跳过旧绑定
- dropZone `drop` 加 `stopPropagation()`
- document `drop` 在 `defaultPrevented` 时跳过

### 6.2 测量面板 Clear All 误删 DXF 绘线
根因：

- DXF 线段也存在 `viewer.scene.measurements`
- 测量面板之前清空时没有排除 DXF measurement

修复：

- DXF 创建的 measure 统一打 `userData.isDxfDraw = true`
- measurement feature 的 `getMeasurements()` 过滤这些对象

原则：

- 测量工具只能清临时测量
- 不能误删 DXF 用户数据

### 6.3 DXF 导出再导入没有颜色
根因：

- 导出仅写 `62` ACI
- 导入不认 `420` true color

修复：

- 导出同时写 `62 + 420`
- 导入优先 `420`
- ACI 增加最近色兜底

### 6.4 连续绘制无法取消
根因：

- Potree `inputHandler` 的拖拽状态未正确清理
- 自动续画 `setTimeout` 未纳入取消链

修复：

- 显式清理 drag
- 清理续画 timer

---

## 7. 已知边界 / 已知技术债

### 7.1 自动提取算法边界
当前算法更适合：

- 规则室内
- 近正交墙体
- 噪声不太离谱的 SLAM 点云

当前不适合：

- 弧墙
- 大量斜墙
- 家具遮挡特别重
- 墙厚恢复
- 房间闭合自动化

### 7.2 `dxf-draw/index.js` 已经较大
这个文件当前已经承担了太多职责：

- DXF 绘图
- 图层管理
- 交点工具
- 选中与删除
- 自动提取 UI
- 自动提取 preview
- 导入接口
- 多语言文案

后续如果继续扩展，建议拆分为：

- `draw-core`
- `draw-constrained`
- `draw-corner`
- `draw-floorplan-beta`
- `draw-ui`

但本轮没有做这个重构，避免功能震荡。

### 7.3 自动提取仍然是 Beta
当前只是打通流程，不代表结果已经达到商业可交付水平。

建议后续升级顺序：

1. 结果过滤和评分阈值
2. 线段合并与延长裁剪
3. 门洞/缺口规则识别
4. 房间闭合
5. 真正的平面图输出

---

## 8. 后续修改建议

### 8.1 如果要继续提升自动提取质量
优先从 `extract_floorplan.py` 下手，而不是先改 UI。

建议方向：

- 多层 slice 融合，不只取单一切片
- 墙线评分和去重
- 线段聚类更稳
- 角点与墙段拓扑关系建立

### 8.2 如果要继续提升 DXF 绘图体验
优先从 `dxf-draw/index.js` 下手。

建议方向：

- 工具状态提示更清楚
- 自动提取结果支持“只导入高分线”
- 手工线和自动线视觉区分更明显
- 图层操作更细化

### 8.3 如果要继续补多语言
优先检查：

- `viewer.html` 里动态插入但没 key 的文本
- `dxf/index.js`
- `dxf-draw/index.js`
- `scanner-info/index.js`

原则：

- 尽量用 `translate(key, fallback)`
- 少依赖“中文原文直接翻译”

---

## 9. 建议回归清单

### DXF 导入

- 文件选择器导入一次，不重复出现
- 拖拽导入一次，不重复出现
- 图层显隐正常
- 文件删除正常

### DXF 绘图

- 自由线段正常
- 连续绘制正常
- 水平线/垂线辅助线和拖动编辑正常
- 交点画线可继续链式绘制
- 选中线段删除正常

### 自动提取（Beta）

- 有活动点云时能发起提取
- 无点云时有友好提示
- preview 能显示
- 导入到 `AutoFloorplan` 图层成功
- 导入后可以继续删线、改色、导出

### 测量与 DXF 隔离

- 测量面板 `Clear All` 不会删除 DXF 绘图线段

### 多语言

- 中文、英文、法语、韩语切换时：
  - DXF 导入区
  - DXF 文件列表
  - DXF 绘图区
  - 自动提取区
  都能同步刷新

---

## 10. 这次主要新增/修改的文件清单

### 新增

- `web-uploader/scripts/extract_floorplan.py`
- `CloudStudio_DXF绘图与自动提取模块交接说明.md`（本文档）

### 修改

- `web-uploader/server.js`
- `web-uploader/viewer.html`
- `web-uploader/assets/app/features/dxf/index.js`
- `web-uploader/assets/app/features/dxf-draw/index.js`
- `web-uploader/assets/app/features/measurement/index.js`
- `web-uploader/assets/app/features/scanner-info/index.js`
- `web-uploader/assets/i18n/en.json`
- `web-uploader/assets/i18n/zh-CN.json`
- `web-uploader/assets/i18n/fr.json`
- `web-uploader/assets/i18n/ko-KR.json`

---

## 11. 一句话总结

当前代码已经从“单纯手工 DXF 绘线”演进成了：

**DXF 导入 + DXF 手工绘图 + 交点画线 + 约束线 + 自动墙线提取（Beta） + 多语言 + 与测量系统隔离**

后续如果继续开发，请优先守住两个原则：

1. **正式 DXF 用户数据不能被临时测量或自动流程误删**
2. **自动提取结果必须先 preview，再由用户确认导入**

