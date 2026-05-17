# CloudStudio 优化执行计划与维护记录

最后更新：2026-04-19  
适用范围：

- `/Users/yangqi/.openclaw/workspace/potree-local/cloudstudio-server`
- 重点子目录：`web-uploader/`

这份文档是后续长期维护、重构、清废代码、补测试、做稳定性治理的总纲。  
目标不是写成“漂亮的理想架构说明”，而是作为真实执行记录和后续推进基线。

---

## 1. 这份文档的用途

这份文档用于固定以下内容：

- 当前项目的真实架构判断
- 已确定的长期优化方向
- 已经执行过的操作
- 当前正在进行中的改动
- 下一步任务和优先级
- 明确的“不偏航”原则
- 排查过程中踩过的坑和经验

后续如果继续做深度维护，应优先更新这份文档，而不是只在脑子里记。

---

## 2. 当前项目的真实判断

### 2.1 总体评价

这个项目已经明显进入“长期服役型技术债系统”阶段。

更准确地说：

- 它不是完全失控的垃圾堆
- 但也绝对不是干净、现代、边界清晰的工程
- 它是一个“产品能力很强、需求持续叠加、很多功能已经能跑，但架构没有同步收口”的项目

因此可以直说：

- 有明显屎山化倾向
- 有不少兼容残留、历史分支和重复逻辑
- 有些代码看起来像废代码，但不一定能直接删，因为很多是 fallback 或旧路径兼容
- 现在最大的问题不是“代码风格不好”，而是“状态、职责和运行时目录边界不清”

### 2.2 前端判断

当前前端不是纯模块化应用，而是典型的：

- `viewer.html` 大型 legacy 主程序
- `assets/app/entry/viewer-entry.js` 模块化入口
- `assets/app/features/*` 增量壳层
- 最后再通过 `loadLegacyInlineModule()` 回注 legacy 逻辑

前端的核心问题有三个：

1. `viewer.html` 过大  
   当前文件体量已经超过两万行，是实际运行核心。

2. 状态来源过多  
   当前至少并存：
   - `APP_SHELL` state domain
   - `viewer.html` legacy 本地变量
   - `scannerGlobalState / scannerState Proxy`
   - Potree 自己的 runtime state

3. “新旧并存但未收口”  
   已有不少 feature 模块，但真正的状态真相仍分散在 `viewer.html` 和兼容代理里。

### 2.3 后端判断

后端当前就是单体大后端。

`web-uploader/server.js` 同时承担：

- 静态资源托管
- 上传与本地导入
- 点云转换
- 扫描项目发现
- CRS / grid
- 导出
- Python 作业调度
- terrain / floorplan / forestry 任务
- 结果目录暴露

这会带来几个后果：

- 改一点功能容易误伤别的域
- 环境问题、路径问题、业务问题都堆在一个文件里
- 很难有清晰的单元测试边界

### 2.4 仓库体积判断

当前仓库大的主要原因不是源码多，而是运行时数据和工作数据混在源码工作树里。

当前已确认的大头目录：

- `web-uploader/pointclouds/`
- `web-uploader/projects/`
- `web-uploader/uploads/`
- `web-uploader/gaussians/`
- `web-uploader/*_jobs/`

也就是说：

- 这是“源码仓 + 本地数据仓 + 缓存目录 + 产物目录”混住
- 不是单纯的代码仓体积过大

这件事必须进入正式治理范围，而不是继续放任。

---

## 3. 长期优化方向

### 3.1 总原则

后续优化必须遵守以下总原则：

1. 稳定性优先，不做大爆炸重写
2. 先补安全网，再拆结构
3. 先收状态与边界，再谈 UI 重写
4. 先把运行时数据迁出源码树，再谈“仓库为什么大”
5. 清废代码必须在替代路径稳定后执行，不能靠感觉乱删

### 3.2 本次确定的执行方向

本轮已经确定的方向是：

- 改造力度：中度重构
- 第一优先级：稳定性优先
- 存储治理：纳入本轮计划

### 3.3 不允许偏离的方向

以下事项属于后续执行中的硬约束：

- 不再继续往 `viewer.html` 塞新业务逻辑
- 不再继续往 `server.js` 直接追加新域功能
- 不为了“看起来更现代”而重写所有前端
- 不在没有测试保护的情况下做大面积删除
- 不把运行时数据目录问题继续拖着不处理

---

## 4. 分阶段执行计划

## 阶段 1：稳定性基线

目标：

- 让本地启动、健康检查、转换、导出、CRS、扫描项目切换这些核心链路更容易排查和回归
- 补齐最低限度的自动化测试和环境预检

核心任务：

- 启动脚本健壮化
- Python / PotreeConverter / 磁盘空间预检
- 健康检查信息增强
- 关键失败路径错误信息更结构化
- 增加少量高价值测试

验收标准：

- `start-local.command` 不再轻易因环境小问题直接炸掉
- `/health` 能看到更有用的环境信息
- 本地打开数据 / 转换 / CRS / 导出至少有一套可复现排查路径

## 阶段 2：运行时存储收口

目标：

- 把运行时数据从源码树中抽离
- 引入统一 `storage root`
- 兼容旧目录一段时间，避免一次性搬迁造成全局损坏

核心任务：

- 新增 `CLOUDSTUDIO_STORAGE_ROOT`
- 抽运行时路径解析层
- 静态资源与读路径支持 legacy fallback
- 迁移脚本和迁移验证

验收标准：

- 新目录可工作
- 旧目录在过渡期可继续读取
- 后续写入优先走新目录

## 阶段 3：前端状态收口

目标：

- 让 scanner / dataset / CRS / coordinate runtime 的状态归属清晰

核心任务：

- 抽显式 store
- 逐步替换 `scannerState` Proxy 的真实读写路径
- 让 feature 只从显式接口拿状态
- legacy 只保留 bridge，不再作为真逻辑承载层

验收标准：

- 状态写入路径可追踪
- 关键 feature 不再直接读写 legacy 裸变量

## 阶段 4：后端拆域

目标：

- 降低 `server.js` 的职责密度

核心任务：

- 拆 `scan/local-import`
- 拆 `crs-grid`
- 拆 `export`
- 拆 `terrain-job`
- 引入统一 job runner / filesystem adapter

验收标准：

- 路由形状不变
- `server.js` 只保留装配层
- 关键逻辑迁移到独立模块

## 阶段 5：清废代码与收尾

目标：

- 删除已确认替代完成的旧逻辑
- 文档与真实结构重新对齐

核心任务：

- 做废代码候选清单
- 清双轨逻辑
- 清旧 fallback
- 更新 README / CODEBASE_MAP / STATE_MAP

验收标准：

- 删除后无行为退化
- 测试通过
- 文档描述与实际结构一致

---

## 5. 本轮已经做过的操作

这一节只记录已经实际执行过的动作，不写空话。

### 5.1 本地启动链修复

已修改：

- `web-uploader/start-local.command`
- `web-uploader/setup-local.sh`

已做内容：

- 将 Python 运行时检查从 heredoc 改成 `python -c`
- 避免在磁盘空间极低时因为 bash 临时文件创建失败而直接崩溃
- 将本地 JS 运行时优先级调整为 `node` 优先、`bun` 兜底

原因：

- 实测出现过：
  - `cannot create temp file for here document: No space left on device`
  - 后续误触发 `setup:local`
  - `bun install` 在低空间环境下被系统杀掉

结果：

- 启动链对低空间场景更稳
- 更贴合当前项目实际以 `node server.js` 为主的启动路径

### 5.2 macOS 本地 pyproj 动态库修复

已修改：

- `web-uploader/setup-local.sh`

已做内容：

- 在 macOS 上对 `site-packages/pyproj` 下的 `.so` / `.dylib` 做 `codesign --force --sign -`
- 将这个修复固化到安装脚本，不再依赖手工修

原因：

- 实测出现过 `ImportError`
- 报错核心是：
  - `library load denied by system policy`

结论：

- 这不是业务代码坏了
- 是本地 `.venv` 原生扩展被系统签名策略拦住

### 5.3 grid_probe 路径健壮性修复

已修改：

- `web-uploader/scripts/grid_probe.py`

已做内容：

- 将传入路径统一先 `resolve()` 为绝对路径

原因：

- 用相对路径探测 grid 时，曾出现“明明文件存在却报找不到或无效”的误导性失败

结果：

- `grid_probe.py --path assets/grids/builtin/be_ign_hBG18.tif` 已能正常工作

### 5.4 运行时存储层开始抽离

已新增：

- `web-uploader/lib/runtime-storage.js`

已做内容：

- 新增运行时存储布局抽象
- 支持 `CLOUDSTUDIO_STORAGE_ROOT`
- 提供：
  - primary / legacy 目录候选
  - fallback static middleware
  - 目录列举
  - 运行时路径解析
  - 磁盘空间统计

当前状态：

- 已开始接入 `server.js`
- 这部分属于“进行中”
- 还没有完成完整端到端验证

注意：

- 这部分不要半途改方向
- 后续应继续沿“路径层抽离 + 兼容旧目录读取”的方向推进

---

## 6. 当前已改动文件与状态

以下按“已完成 / 进行中 / 记录文件”区分。

### 6.1 已完成并验证过

#### `web-uploader/start-local.command`

修改情况：

- 去掉 heredoc 依赖
- 调整 JS runtime 选择顺序

验证情况：

- 本地服务可通过 `node server.js` 正常拉起
- 启动脚本不再在最前面因 here-doc 临时文件而直接炸掉

#### `web-uploader/setup-local.sh`

修改情况：

- 默认运行时调整为 `node` 优先
- Python 检查改为 `python -c`
- 新增 macOS 的 pyproj 二进制重签名修复

验证情况：

- shell 语法已检查通过
- `.venv` 中 `pyproj` 已可正常导入

#### `web-uploader/scripts/grid_probe.py`

修改情况：

- 路径统一绝对化

验证情况：

- `hBG18` 探测成功，返回 `ok: true`

### 6.2 已开始但尚未完成整体验证

#### `web-uploader/lib/runtime-storage.js`

修改情况：

- 新建运行时存储布局模块

当前判断：

- 方向正确
- 是后续“运行时目录脱离源码树”的基础层
- 暂未完成全部读写路径的接管验证

#### `web-uploader/server.js`

当前正在推进的方向：

- 将运行时目录、静态资源 fallback、存储健康信息等逻辑收口到 `runtime-storage` 抽象

当前状态说明：

- 已做部分接线
- 需要继续完成兼容路径改造、health 增强、测试补齐
- 在这一部分完成前，不要再顺手往 `server.js` 增加别的业务特性

### 6.3 记录文件

#### `memory/2026-04-18.md`

内容：

- 坐标链、CRS、grid、导出路径的阅读结论

#### `memory/2026-04-19.md`

内容：

- 本地启动失败根因
- 磁盘空间问题
- 已执行修复记录

---

## 7. 当前明确的踩坑记录

这一节非常重要，后面不要重复踩。

### 坑 1：磁盘空间不足会引发非常“假”的错误

现象：

- `start-local.command` 报 here-doc 临时文件失败
- 进一步触发 `setup:local`
- 安装依赖被 kill
- 最终用户体感是“项目怎么又启动不了了”

本质：

- 真正问题不是脚本本身，而是磁盘空间极低

已确认的大目录：

- `web-uploader/pointclouds/`
- `web-uploader/projects/`
- `web-uploader/uploads/`
- `web-uploader/gaussians/`

结论：

- 运行时目录治理不是“以后再说”的优化项，而是稳定性问题

### 坑 2：macOS 上 pyproj 失败不代表代码坏了

现象：

- `pyproj` 导入失败
- 表面看像 Python 依赖坏掉

本质：

- 原生扩展被系统策略拦截
- 需要重新 ad-hoc 签名

结论：

- 遇到这类错误优先排查环境签名，不要第一反应改业务代码

### 坑 3：grid 文件相对路径会误导排查

现象：

- 相对路径探测时可能报 grid 无效或找不到

本质：

- 路径未统一绝对化

结论：

- 所有这类底层脚本都应优先绝对路径化

### 坑 4：仓库“大”不等于源码“烂”

现象：

- 工作树 7G 以上，看起来像代码极其臃肿

本质：

- 主要是运行时数据和产物占空间

结论：

- 体积治理和源码架构治理要分开处理，但都必须做

### 坑 5：看起来像废代码的东西不一定真能删

现象：

- `viewer.html`、scanner/minimap/CRS 等区域存在新旧双轨

本质：

- 很多旧逻辑仍被 fallback 或兼容路径使用

结论：

- 清废代码必须先做调用关系确认，再删

---

## 8. 下一步任务清单

以下是下一步明确任务，不要偏离顺序。

## 8.1 P0：把第一阶段基础设施做完整

必须完成：

1. 完成 `server.js` 对 `runtime-storage` 的接入
2. 补齐旧目录读取兼容
3. 增强 `/health`
4. 为 `runtime-storage` 增加 Node 测试
5. 跑通现有测试和新增测试

验收标准：

- 默认无环境变量时行为不变
- 设置 `CLOUDSTUDIO_STORAGE_ROOT` 后，新目录可写，旧目录关键读路径不崩
- `/health` 返回更完整的存储与环境信息

## 8.2 P1：明确运行时目录治理策略

必须完成：

1. 定义哪些目录属于源码
2. 定义哪些目录属于运行时产物
3. 更新 `.gitignore`
4. 写迁移脚本设计说明

建议纳入治理的目录：

- `pointclouds/`
- `projects/`
- `uploads/`
- `gaussians/`
- `exports/`
- `contour_jobs/`
- `dtm_jobs/`
- `surface_jobs/`
- `volume_surface_jobs/`
- `floorplan_jobs/`

## 8.3 P1：补第一批高价值测试

优先测试链路：

1. 本地打开数据 / 上传路径转换
2. scanner project 打开和切换
3. CRS resolve / search / transform
4. export-las
5. terrain 主流程最小 smoke

## 8.4 P2：前端状态收口设计

先做设计和小步实施，不做重写。

优先收口对象：

1. dataset context
2. scanner selection
3. scanner runtime
4. CRS runtime

这里的原则是：

- 先统一状态真相
- 再迁移 feature 使用方式
- 最后才清 Proxy 和 legacy 裸变量

## 8.5 P2：废代码清理候选清单

先做 inventory，不先删。

重点检查：

- minimap 双实现
- scanner runtime 双路径
- open/load orchestration 兼容分支
- CRS 旧 fallback
- viewer.html 中已被 feature 替代但仍保留的工具逻辑

输出物要求：

- 每一项候选必须写明：
  - 入口位置
  - 当前调用者
  - 是否已有替代实现
  - 删除前缺什么测试

---

## 9. 后续维护时的执行纪律

从现在开始，后续所有维护最好遵守以下纪律：

1. 每次改动先判断属于哪个阶段
2. 不在一个提交里混做“稳定性修复 + 大结构迁移 + 清废代码”
3. 优先保证可验证性
4. 每做完一块就更新本文件
5. 若方向变了，必须先改这份文档再改代码

---

## 10. 当前最重要的一句话

这个项目后续最容易失败的方式，不是“能力不够”，而是：

- 一边继续往 `viewer.html` / `server.js` 堆功能
- 一边又想靠几次零散优化把系统变干净

这条路走不通。

后续必须坚持：

- 稳定性优先
- 收边界
- 补测试
- 迁运行时目录
- 清废代码要基于证据

只要不偏离这五条，项目会慢慢从“高压可用单体”进入“可维护单体”。  
只要偏离，就会继续回到边修边烂的循环里。

