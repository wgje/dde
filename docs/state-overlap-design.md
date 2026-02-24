# State Overlap — 零阻力上下文切换策划案

> 版本：v10.0（布局重构 + 真人体验深度校正 + 全量联动终版）
> 日期：2026-02-22
> 状态：Draft for implementation
> 作者：NanoFlow Team
> v10.0 变更：基于代码库全量联动分析 + 真人体验深度校正的 **8 项重大修正**——
> (1) **A6.9 布局方案重构——停泊坞（Parking Dock）**：废弃「左侧栏底部 + 右侧面板预览」分裂方案，改为**底部向上弹出的停泊坞面板**，定位在 Text Column 与 Flow Column 的分隔线（Resizer）上居中，同时侵入两侧板块。**彻底消除**三个问题：① `FlowRightPanelComponent` 实为移动端项目列表面板（非通用面板），v9.1 错误假设可复用；② Text 视图需独建 `ParkingPreviewDrawerComponent` 导致双端实现分裂；③ 用户视线在左侧栏↔右侧预览面板间全屏宽度乒乓，违反空间记忆连续性。改为单一 `ParkingDockComponent` 统一所有视图场景。
> (2) **A6.6 vs A5.2 恢复优先级冲突消除**：A6.6 原文"原行号 > structuralAnchor.line > 文档顶部"与 A5.2 四级 fallback（structuralAnchor.label > cursorPosition.line > scrollPercent > 顶部）矛盾。统一以 A5.2 的四级 fallback 为唯一规范，删除 A6.6 冗余描述。
> (3) **版本标签统一**：CURRENT 标签从 `v7.1` 更新为 `v10.0`，消除文档标头 v10.0 与正文 v7.1 的版本漂移。
> (4) **FlowRightPanelComponent 实况校正**：经代码验证，该组件为移动端专用项目列表面板（固定宽度 `calc(100vw/3)`），不具备通用面板能力。联动表中标注为"不可复用"并从方案中剔除。
> (5) **真人体验 9 项机械化风险新增**：① 全屏宽度视线乒乓（已由布局重构消除）；② 侧栏空间挤占（已消除——停泊坞独立于侧栏）；③ 预览面板入口隐蔽性（已消除——底部常驻触发条）；④ 单手操作可达性（底部弹出天然适配 thumb zone）；⑤ "即将清理"分组人为分裂视觉连续性风险（改为inline标签，不单独分组）；⑥ 轻量编辑的「+ 备注」入口可发现性不足（添加占位文案提示）；⑦ 多任务同时衰老批量撤回的列表交互成本（简化为全量撤回+单条移除）；⑧ Dock 展开时遮挡编辑内容的恢复路径（单击 Dock 外区域或 Escape 收起）；⑨ 移动端 Dock 与系统底部手势栏冲突（预留 safe-area-inset-bottom）。
> (6) **A15.2 联动表净化**：删除已失效的 `FlowRightPanelComponent` 复用行和 `ParkingPreviewDrawerComponent` 独建行，新增 `ParkingDockComponent` 落地依赖行和 `ProjectShellComponent` 模板修改行。
> (7) **A2.3 交互语义真值表对齐**：「右侧面板展开」统一改为「停泊坞展开」，「全屏详情页」统一改为「停泊坞全屏展开」。
> (8) **"即将清理"独立分组 → inline 标签**：64h+ 未访问任务不再挪到底部独立分组（打破空间记忆），改为在原位置显示橙色 inline 标签。
>
> v9.1 变更：基于真人体验实际探查 + 代码库全量联动深度校正的 10 项修正——（略，详见 git history）
> v8.3 变更：基于真人体验全量审查 + 代码库联动分析的 13 项修正——（略，详见 git history）
> v8.2 变更：基于真人体验全量审查的 18 项优化——（略，详见 git history）

---

## 生效范围协议（Normative Contract）

本文件采用双层规范：

- `[CURRENT v10.0]`：唯一可执行规范，研发/测试/验收一律以此为准。
- `[ARCHIVE]`：历史演进与回溯材料，仅用于理解背景，**不得**直接实现。

冲突处理规则：

1. `[CURRENT v10.0]` 与 `[ARCHIVE]` 冲突时，`[CURRENT v10.0]` 绝对优先。
2. 若某条规则未显式标注，则默认按所在章节标签继承。
3. 评审、拆解任务、编写测试用例时，必须引用 `[CURRENT v10.0]` 对应段落编号。

---

## 目录

### A. [CURRENT v10.0] 可执行规范

1. [A1. 产品边界与目标](#a1-current-v100-产品边界与目标)
2. [A2. 唯一真值表（Single Source of Truth）](#a2-current-v100-唯一真值表single-source-of-truth)
3. [A3. 与现有架构映射](#a3-current-v100-与现有架构映射)
4. [A4. 数据模型规范](#a4-current-v100-数据模型规范)
5. [A5. 服务层规范](#a5-current-v100-服务层规范)
6. [A6. 交互语义与体验强化规范](#a6-current-v100-交互语义与体验强化规范)
7. [A7. 桌面/移动行为兼容矩阵](#a7-current-v100-桌面移动行为兼容矩阵)
8. [A8. 核心流程时序（v10.0）](#a8-current-v100-核心流程时序v100)
9. [A9. 配置常量规范](#a9-current-v100-配置常量规范)
10. [A10. 实施路线图（体验优先版）](#a10-current-v100-实施路线图体验优先版)
11. [A11. 测试与验证场景](#a11-current-v100-测试与验证场景)
12. [A12. 验收标准](#a12-current-v100-验收标准)
13. [A13. 术语表（现行）](#a13-current-v100-术语表现行)
14. [A14. 假设与默认值](#a14-current-v100-假设与默认值)
15. [A15. 真人体验反机械校正与全量联动门禁](#a15-current-v100-真人体验反机械校正与全量联动门禁)

### B. [ARCHIVE] 历史演进（折叠）

- [B1. 历史正文（原文保留）](#b1-archive-历史正文原文保留)

---

## A1. [CURRENT v10.0] 产品边界与目标

### A1.1 产品定位

State Overlap 的定位是：**零阻力上下文切换**，而非“完整认知代理”。

系统保证：

1. 切换时自动保存物理上下文（光标、滚动锚点、结构锚点）。
2. 切回时稳定恢复并提供轻量视觉落点（编辑行高亮）。
3. 在“当前任务 / 稍后任务”之间自由导航。
4. 提供可选提醒与可撤回自动清理。

系统不承诺：

1. 自动重建用户全部认知上下文。
2. 通过复杂推断替代用户判断。
3. 用主动打断换取“提醒命中率”。

### A1.2 目标

1. 文档可执行：实现者不需要二次决策。
2. 体验优先：减少误切换、误消散、误清理。
3. 桌面+移动并重：同一语义，两端都可达。

### A1.3 边界

1. 本轮只优化策划案，不修改业务代码、数据库、测试代码。
2. 保留单文档结构，采用 Current/Archive 强隔离。

> 防误用提示：任何“恢复 v6 推断/节拍器/复杂预热”的实现提案都属于超范围。

---

## A2. [CURRENT v10.0] 唯一真值表（Single Source of Truth）

### A2.1 数据模型真值表

| 主题 | 唯一规范 | 备注 |
|---|---|---|
| Task 扩展 | `parkingMeta?: TaskParkingMeta | null` | 当前规范中禁止使用 `overlap 前缀旧命名` 命名 |
| 停泊状态 | `state: 'focused' | 'parked'` | 仅两态；使用 `focused` 而非 `active`，避免与 `Task.status: 'active'`（表示"未完成"）产生歧义 |
| 上下文快照 | `contextSnapshot: ParkingSnapshot \| null` | 不使用 `lastEditLine/lastEditContent` 分裂字段 |
| 提醒元数据 | `reminder: ParkingReminder \| null` | 含 Snooze 计数 |
| 衰老豁免 | `pinned: boolean` | `true` 时跳过 72h 衰老清理 |
| 生效约束 | 仅 `Task.status === 'active'` 的任务可持有 `parkingMeta` | completed/archived 任务不可停泊 |

### A2.2 服务接口真值表

| 服务 | 对外动作（必须稳定） | 禁止项 |
|---|---|---|
| `ParkingService` | `previewTask(taskId)`、`startWork(taskId)`、`removeParkedTask(taskId)`、`undoEviction(token)` | 不暴露 `switchFocus()` 给 UI 层直接调用 |
| `ContextRestoreService` | `saveSnapshot(taskId)`、`restore(taskId, snapshot)` | 不引入多级预热遮罩 |
| `SimpleReminderService` | `setReminder(...)`、`snoozeReminder(...)`、`cancelReminder(...)` | 不恢复 Metronome 多级升级系统 |

### A2.3 交互语义真值表

| 用户动作 | 桌面 | 移动 | 结果 |
|---|---|---|---|
| 主点击 | 单击预览 | 单击预览 | 不切换 Focus |
| 主切换 | 显式按钮`[切换到此任务]` | 显式按钮`[切换到此任务]` | 切换并自动停泊当前任务 |
| 快捷切换 | 选中卡片后按 `Enter` | 不适用 | 等价于点击`[切换到此任务]` |
| 快速回切 | `Alt+Shift+P`（macOS 为 `Ctrl+Shift+P`） | 不适用 | 直接切回最近停泊任务，跳过预览（快捷键可通过设置页自定义） |
| 删除停泊项 | 卡片 `×`（hover 显示 Tooltip"移回列表"） | 更多菜单 > 移回任务列表 | 从停泊列表移回普通任务列表；移除后 5s Snackbar 可撤回 |
| Snooze 达软上限 | Snooze 按钮视觉弱化 + 提示文案，仍可继续 snooze | 同左 | 用户仍可 snooze；`[忽略]` 后提醒取消，任务保持停泊状态，可随时重新设置提醒（snoozeCount 重置） |
| 通知消散 | 按通知类型区分消散策略（详见 A6.3） | 同左 | 防误触瞬隐 + 防盲消散 |

### A2.4 配置常量真值表

| 常量 | 值 | 说明 |
|---|---|---|
| `PARKED_TASK_STALE_THRESHOLD` | `72h` | 未访问即进入清理流程（72h 覆盖完整周末） |
| `PARKED_TASK_STALE_WARNING` | `64h` | 距 72h 剩余 8h 时，卡片显示"即将清理"橙色标签 |
| `PARKED_TASK_SOFT_LIMIT` | `10` | 只警告"停泊任务较多"，不强删（此值待 MVP 验证后调整） |
| `NOTICE_MIN_VISIBLE_MS` | `2500` | 最短可见时长，防误消散 |
| `NOTICE_FALLBACK_TIMEOUT_MS` | `15000` | 无操作兜底淡出 |
| `EDIT_LINE_FLASH_DURATION` | `1000ms` | 三段式 |
| `SNOOZE_PRESETS` | `5min / 30min / 2h-later` | 轻量三档；`2h-later` = 当前时间 + 2h，不封顶；不使用 `later-today` 命名避免跨天歧义 |
| `MAX_SNOOZE_COUNT` | `5` | 软上限（5 次后视觉弱化 Snooze 按钮并显示引导文案，但不禁止继续 snooze） |
| `REMOVE_UNDO_TIMEOUT_MS` | `5000` | 手动移除停泊项后 Snackbar 撤回窗口（5s 符合 Material Design 默认值，留够阅读+决策时间） |
| `EVICTION_UNDO_TIMEOUT_MS` | `8000` | 自动衰老清理后 Snackbar 撤回窗口（系统行为需更长理解时间） |
| `REMINDER_IMMUNE_MS` | `5000` | 提醒通知前 5s 不被外部交互消散（保证用户看到） |

### A2.5 排序规则真值表

| 场景 | 排序规则 | 说明 |
|---|---|---|
| 停泊列表默认排序 | 按 `parkedAt` 降序（最近停泊在上） | 停泊时间固定，不随预览/访问变化，保持空间位置稳定（用户依赖空间记忆定位卡片） |
| 有提醒且 < 1h 到期 | 置顶，显示倒计时标签 | 即将到期的提醒优先展示（临时性置顶，不影响基础排序） |
| "即将清理"任务 | 原位显示橙色 inline 标签「即将清理」 | **不单独分组移到底部**——将任务从原位置挪走会打破用户的空间记忆（"我记得那个任务在第三个，怎么跑到底下了？"），且来回移动造成列表抖动 |

> 防误用提示：真值表未列出的字段、服务动作和配置均不得默认新增到“当前规范”。

---

## A3. [CURRENT v10.0] 与现有架构映射

### A3.1 与 NanoFlow 基线关系

State Overlap 作为 Focus 体系的并行能力层，不替代现有 Gate/Spotlight/Strata/Black Box。

| 现有能力 | 当前关系 |
|---|---|
| `TaskStore` / `ProjectStore` / `ConnectionStore` | 继续作为状态真源，Overlap 只扩展 Task 元数据 |
| `SimpleSyncService`（LWW + 增量拉取） | 保持不变，仅新增 `parkingMeta` 字段同步 |
| `UiStateService` | 增加/复用 overlap 视图状态，不破坏 text/flow 主流程 |
| Focus 模块（Gate/Spotlight/Strata/BlackBox） | 可共存，不强依赖 FocusPod/Incubator/Metronome 历史概念 |

### A3.2 约束对齐（Hard Rules）

1. ID 仍由客户端 `crypto.randomUUID()` 生成。
2. 写路径仍是本地先写 + 3s 防抖同步 + RetryQueue。
3. 冲突策略保持 LWW，以 `updatedAt` 为关键字段。
4. 移动端保持轻量，不引入不可达的桌面交互前提。
5. **TaskStore 脏检查联动**：`stores.ts` 中 `isTaskEqual()` 必须新增 `parkingMeta?.state`、`parkingMeta?.parkedAt`、`parkingMeta?.reminder?.reminderAt` 和 `parkingMeta?.reminder?.snoozeCount` 的比较项，避免停泊状态或提醒变更被脏检查吞除（不触发 signal 通知导致 UI 不更新）。
6. **同步字段列表**：`TaskSyncOperationsService` 的增量拉取 SELECT 字段列表必须包含 `parking_meta`（snake_case，Supabase 列命名约定），确保停泊元数据不被同步查询遗漏。即 `FIELD_SELECT_CONFIG.TASK_LIST_FIELDS` 在现有字段末尾追加 `,parking_meta`。

### A3.3 停泊列表作用域

停泊列表**跨项目全局可见**——用户切换项目时，仍可在停泊坞中看到所有项目的停泊任务。停泊卡片显示所属项目名称以便区分。

理由："被打断去做另一个项目的事"是上下文切换的核心场景，按项目隔离停泊列表会导致用户忘记其他项目中的停泊任务。

### A3.4 跨项目停泊数据加载策略

现有 `TaskStore` 按项目加载任务数据——用户切换项目时只加载当前项目任务。停泊列表跨项目全局可见（A3.3），因此需要独立的数据加载路径：

1. **启动时轻量查询**：通过独立 Supabase 查询（仅 SELECT `id, title, parkingMeta, projectId, updatedAt`）加载所有 `parkingMeta IS NOT NULL` 的任务，不依赖各项目完整 Task 数据。
2. **走增量同步管道**：此查询纳入 `SimpleSyncService` 增量拉取流程，以 `updated_at > last_sync_time` 为过滤条件，不引入独立的全量拉取。
3. **IndexedDB 缓存**：停泊任务列表持久化至 IndexedDB，应用重启后先展示缓存，后台增量拉取更新。
4. **内存索引**：在 `TaskStore` 中维护 `parkedTaskIds: Set<string>`（类似现有的 `tasksByProject: Map<string, Set<string>>` 的索引模式），提供 O(1) 查找。不与 `tasksMap` 产生数据冗余——停泊任务仍存在于 `tasksMap` 中，`parkedTaskIds` 仅为二级索引。实际 Task 对象通过 `tasksMap.get(id)` 获取。
5. **加载阶段**：停泊任务轻量查询在 `StartupTierOrchestratorService` 的 `p1` 就绪后执行（auth 完成后、UI 可交互前），确保用户首次展开停泊坞时数据已就绪，同时不阻塞 P0 初始化。

### A3.5 与 Focus Gate 的优先级协调

Gate 机制在应用启动时强制弹出遗留条目处理覆盖层（由 `GateService` + `gate-overlay.component` 控制）。衰老清理 Snackbar 也可能在启动时触发。两者同时出现会互相遮挡。

优先级规则：

1. **Gate 覆盖层优先**：若 Gate 覆盖层处于激活状态，衰老清理通知排队等待 Gate 关闭后再显示。
2. **通知队列**：`ParkingService` 内部维护通知队列，当检测到 `gateService.isActive()` 为 true 时，暂存清理通知，Gate 关闭后按顺序释放。
3. **提醒通知不受此限制**：提醒通知不在启动时触发（由用户设定的提醒时间决定），因此与 Gate 不冲突。

> 防误用提示：当前架构映射不允许把历史的 FocusPod/Incubator/Metronome 作为实现前置依赖。

### A3.6 数据库迁移前提

实施 State Overlap 前，需完成以下数据库 schema 变更（`supabase/migrations/` 目录）：

1. **新增列**：`ALTER TABLE tasks ADD COLUMN parking_meta JSONB DEFAULT NULL`。类型为 JSONB，允许 `parkingMeta` 的嵌套结构（`state`, `parkedAt`, `contextSnapshot`, `reminder`, `pinned`）直接存储。
2. **RLS 策略**：现有 `tasks` 表的 RLS 策略（按 `user_id` 隔离）自动覆盖新列，无需额外策略。但 A3.4 的跨项目轻量查询需要确保 RLS 策略允许用户查询所有自己项目的 `parking_meta IS NOT NULL` 任务。
3. **索引**：为 A3.4 的启动查询添加部分索引：`CREATE INDEX idx_tasks_parking_meta ON tasks ((parking_meta IS NOT NULL)) WHERE parking_meta IS NOT NULL`，加速「所有停泊任务」的筛选查询。
4. **向后兼容**：旧版本客户端不认识 `parking_meta` 列。由于 LWW 写入时旧版代码不包含此字段，Supabase 的 `UPDATE` 不会覆盖已有值（仅更新显式传入的字段）。但需确保旧版 push 操作不会因 unknown column 报错——验证 `FIELD_SELECT_CONFIG` 的字段列表是否用于写入。

### A3.7 Undo 系统集成

停泊操作需与现有 `UndoService`（`src/services/undo.service.ts`）集成：

1. **新增 UndoActionType**：在 `UndoActionType` 联合类型中新增 `'task-park'`，用于记录停泊/取消停泊操作。
2. **Batch 模式与跨项目限制**：`startWork(taskId)` 会同时修改两个任务的 `parkingMeta`（当前 focused → parked，目标 → focused）。
   - **同项目**：两个任务属于同一项目时，使用 `UndoService.beginBatch(project)` / `endBatch(project)` 包裹，确保 Ctrl+Z 一次性回滚两个任务的停泊状态。
   - **跨项目（已知限制）**：`UndoService.beginBatch(project: Project)` 当前签名仅接受单个 Project，无法在一次 batch 内跨两个项目的 undo stack 做原子记录。跨项目情况必须退化为**分别在各自项目 undo stack 中记录两条独立的 `'task-park'` 操作**，Ctrl+Z 只能回滚当前活动项目侧的状态，另一项目侧须手动撤回。此为已知架构限制，在 `UndoService` 支持多项目 batch 之前不引入复杂绕路。UI 层须在跨项目切换后的 Snackbar/Toast 中说明：「已跨项目切换，Ctrl+Z 仅撤回当前项目侧状态」。
3. **数据结构**：`UndoAction.data.before/after` 记录两个任务的 `{ taskId, projectId, parkingMeta }` 完整快照，供跨项目分别回滚时使用。

### A3.8 与 Focus Spotlight 的共存规则

Spotlight 模式提供线性聚焦体验（一次只处理一个任务）。与 State Overlap 的交互规则：

1. **Spotlight 激活时**：禁止从停泊列表执行 `startWork()` 切换——用户必须先退出 Spotlight 模式。停泊列表中的 `[切换到此任务]` 按钮置灰并显示 Tooltip「请先退出 Spotlight 模式」。
2. **Spotlight 中的任务被停泊**：不允许在 Spotlight 模式下主动停泊当前任务（与 Spotlight「专注完成当前任务」的设计意图矛盾）。
3. **停泊任务进入 Spotlight**：Spotlight 的任务队列生成时，已停泊的任务不出现在队列中（避免重复出现在两个 UI 入口）。
   - **注入路径（代码级明确）**：`SpotlightService.selectNextTask()` 目前从 `projectState.tasks()` 中筛选任务，需增加排除已停泊任务的过滤条件。实现方式：直接读取 `TaskStore.parkedTaskIds`（二级索引 `Set<string>`，见 A3.4.4），过滤条件为 `!parkedTaskIds().has(task.id)`。不得注入 `ParkingService`（避免 SpotlightService ↔ ParkingService 循环依赖）。

### A3.9 与 Strata 沉积层的衔接

停泊任务的生命周期终点之一是「完成」，需与 Strata 沉积层衔接：

1. 停泊任务被标记 `status: 'completed'` 时，系统自动清除 `parkingMeta`（从停泊列表移除），该任务正常进入 Strata 的沉积时间线。
2. 停泊任务被归档（`status: 'archived'`）时，同理清除 `parkingMeta`。

### A3.10 搜索与停泊任务的可见性

全局搜索（`SearchService`）中停泊任务的处理规则：

1. 停泊任务出现在搜索结果中，搜索结果卡片上显示「停泊中」状态标记（与「已完成」「已归档」等标记同级）。
2. 搜索结果中点击停泊任务，行为等同于停泊列表中的「预览」（不自动切换）。

### A3.11 导出/导入兼容

项目导出（`ExportService`）和导入（`ImportService`）中 `parkingMeta` 的处理：

1. **导出时**：`parkingMeta` 整体保留，但 `contextSnapshot` 置为 `null`——快照中的光标/视口/锚点信息与导出设备的 UI 状态绑定，在其他设备导入后无法正确恢复。`state`、`parkedAt`、`reminder`、`pinned` 保留。
2. **导入时**：若导入的任务携带 `parkingMeta`，以导入时间更新 `lastVisitedAt`（防止导入后立即触发衰老清理）。`reminder` 中若 `reminderAt` 已过期则清除。

### A3.12 BeforeUnload 快照保存

关闭页面时保存 focused 任务快照：

1. `ParkingService` 在初始化时通过 `BeforeUnloadManagerService.register('parking-snapshot', callback, 5)` 注册回调（优先级 5，高于默认的 10，确保快照在同步等操作之前完成）。
2. **async 限制（已知约束）**：`BeforeUnloadCallback` 签名为 `() => boolean | void`（同步），浏览器不等待 Promise。因此 beforeunload 内**不能**用 `idb-keyval.set()`（async IDB 写入），写入无法保证完成即关标签页。正确方案：
   - beforeunload 回调内使用 `localStorage.setItem('parking-snapshot-draft', JSON.stringify(snapshot))` **同步写入** localStorage（量小、同步、可靠）作为紧急快照。快照大小限制：仅保存 `{ taskId, contentHash, cursorPosition, structuralAnchor }` 核心字段，`scrollAnchor` 和 `flowViewport` 可省略。
   - 应用**正常运行期间**，`ContextRestoreService.saveSnapshot()` 写入 IndexedDB `parked_tasks` store（完整快照，异步但可靠）。
   - 应用重启时，先检查 IndexedDB 是否有更新的快照（`savedAt` 更晚）；若无则降级读 `localStorage` 草稿，恢复后清除草稿 key。
3. `visibilitychange` 到 `hidden` 时，异步触发完整快照保存（写入 IndexedDB），此时页面未销毁，Promise 可完成——移动端切 App 场景下这是主要保存路径。

### A3.13 Toast/通知组件扩展前提

现有 `ToastService`（`src/services/toast.service.ts`）仅支持**1 个 action 按钮**。State Overlap 的提醒通知需要多个操作（`[切换过去] [5分钟] [30分钟] [2小时后] [忽略]`）。实施前需要：

1. 扩展 Toast 组件支持 `actions: Array<{ label: string; onClick: () => void }>` 多按钮模式，或
2. 创建独立的 `ParkingNoticeComponent`（底部 Snackbar 样式但支持多按钮），不修改通用 Toast 基础设施。
3. 三阶段渐进消散策略需要在通知组件中实现独立的定时器逻辑，而非复用 Toast 的简单 duration 超时。

推荐方案 2——创建独立组件，避免对通用 Toast 的侵入式修改。

### A3.14 LWW 字段级冲突的已知限制

现有 LWW 冲突策略以整个 Task 的 `updatedAt` 为粒度——如果设备 A 更新了 `content`，设备 B 更新了 `parkingMeta`，二者的 `updatedAt` 不同，LWW 会以最新的一方**整体覆盖**，导致对方的修改丢失。

**已知限制声明**：当前版本不引入字段级冲突合并（增加复杂度与 SimpleSyncService 的 LWW 核心理念冲突）。缓解措施：停泊状态变更触发的 `updatedAt` 更新使用独立的防抖通道（不与内容编辑的 3s 防抖合并），减少两类操作在时间窗口内冲突的概率。后续版本可探索字段级 LWW 或 CRDT。

### A3.15 IndexedDB 版本升级

现有 `FOCUS_CONFIG.IDB_VERSION = 2`（含 `black_box_entries`, `focus_preferences`, `offline_audio_cache`, `sync_metadata` 四个 store）。State Overlap 需要：

1. `IDB_VERSION` 从 2 升级到 3。
2. 新增 `parked_tasks` object store，用于缓存跨项目停泊任务列表（A3.4.3）。
3. 升级迁移逻辑：`onupgradeneeded` 回调中判断 `oldVersion < 3` 时创建 `parked_tasks` store。

---

## A4. [CURRENT v10.0] 数据模型规范

**不变量约束**：同一用户在同一时刻，最多只有 **1 个** `state: 'focused'` 的停泊任务。`startWork(taskId)` 执行时若已有 focused 任务，必须先自动将其停泊为 `parked`。允许 0 个 focused 任务（用户完成当前任务后不立即选择下一个）。**`parkingMeta` 仅对 `status: 'active'` 的任务有效**——`completed` 或 `archived` 状态的任务不可被停泊；如果 focused/parked 任务被标记 completed，系统自动清除其 `parkingMeta`（同时进入 Strata 沉积层，如已启用）。

```typescript
/** Task 扩展：当前规范仅允许 parkingMeta 命名 */
interface Task {
  // ...existing fields
  parkingMeta?: TaskParkingMeta | null;
  // ⚠️ current 规范禁止同级出现 overlap 前缀旧命名
}

/** 停泊元数据 */
interface TaskParkingMeta {
  /**
   * 当前/稍后两态
   * ⚠️ 使用 'focused' 而非 'active'——因为 Task.status 已有 'active' 表示"未完成"，
   * 两者含义完全不同，混用会在代码中造成歧义
   */
  state: 'focused' | 'parked';
  /** 进入 parked 的时间 */
  parkedAt: string | null;
  /** 最近访问时间（用于衰老清理计时，预览/点击都会刷新） */
  lastVisitedAt: string | null;
  /** 上下文快照 */
  contextSnapshot: ParkingSnapshot | null;
  /** 提醒元数据 */
  reminder: ParkingReminder | null;
  /** 衰老豁免标记——用户可标记「不自动清理」，适用于长期跟踪的停泊任务 */
  pinned: boolean;
}

/** 上下文快照（跨设备稳定） */
interface ParkingSnapshot {
  savedAt: string;
  contentHash: string;
  /** 保存快照时的视图模式，用于跨设备恢复降级判定 */
  viewMode: 'text' | 'flow';
  cursorPosition: { line: number; column: number } | null;
  scrollAnchor: {
    anchorType: 'heading' | 'line';
    anchorIndex: number;
    anchorOffset?: number;
    scrollPercent: number; // fallback 0..1
  } | null;
  structuralAnchor: {
    /** 简化为四类：heading（Markdown 标题）、gojs-node（流程图节点）、line（行号定位）、fallback */
    type: 'heading' | 'gojs-node' | 'line' | 'fallback';
    label: string;
    line?: number;
  } | null;
  /**
   * Flow 视图专用：GoJS 视口和选中节点状态
   * 仅当 viewMode === 'flow' 时有值
   * 恢复时使用选中节点作为视口锚点（diagram.commandHandler.scrollToPart），
   * 无选中节点时保持视口不变
   * ⚠️ 不保存绝对 centerX/centerY——跨屏幕尺寸恢复时绝对坐标无意义，
   * 以 selectedNodeId 为锚点可在任意屏幕尺寸上正确定位
   */
  flowViewport: {
    scale: number;
    selectedNodeId: string | null;
  } | null;
}

/** 提醒元数据 */
interface ParkingReminder {
  reminderAt: string;
  snoozeCount: number;
  maxSnoozeCount: number; // default 5
}

/** 通知事件契约 */
interface ParkingNotice {
  id: string;
  type: 'reminder' | 'eviction';
  /**
   * 消散策略按 type 区分：
   * - reminder：三阶段渐进消散——前 5s 不被外部交互消散；5-15s 外部点击可消散（键盘/滚动不触发）；15s 兜底淡出
   * - eviction：minVisible 2500ms + 有效交互消散（详见 A6.3）
   */
  minVisibleMs: number; // eviction: 2500, reminder: 5000 (REMINDER_IMMUNE_MS)
  fallbackTimeoutMs: number; // 固定 15000
  actions: Array<{
    key: 'start-work' | 'snooze-5m' | 'snooze-30m' | 'snooze-2h-later' | 'ignore' | 'undo-eviction' | 'keep-parked';
    label: string;
  }>;
}
```

> 防误用提示：不得在同一文档的当前规范中混用 `contextSnapshot` 与 `lastEditLine/lastEditContent` 两套快照模型。

**structuralAnchor 展示规则**：当 `structuralAnchor.type === 'fallback'` 且 `label` 与任务标题重复时，UI 层**不显示锚点行**，卡片仅展示"任务标题 + 停泊时长"，避免无意义的信息重复。

---

## A5. [CURRENT v10.0] 服务层规范

### A5.1 ParkingService（对外契约）

```typescript
interface ParkingService {
  previewTask(taskId: string): void;
  startWork(taskId: string): void; // 对外唯一切换入口
  removeParkedTask(taskId: string): void;
  undoEviction(token: string): void;
}
```

行为规则：

1. `previewTask` 只打开详情，不触发切换。
2. `startWork` 才会执行"保存当前 -> 切换目标 -> 恢复上下文"。执行时若已有 focused 任务，自动先停泊。
3. 自动衰老清理必须生成可撤回 token。
4. `undoEviction(token)` 的 token 与 Snackbar 生命周期绑定——Snackbar 消散（用户点击撤回/超时自动消失）即 token 失效。Token 仅存于内存，不持久化。
   - **多任务同时衰老的问题**：若多个任务在同一检查周期内触发衰老（例如启动时批量清理），**不得**用逐个弹出 Snackbar 并相互替换的方式处理——后一个 Snackbar 替换前一个时，前者的 token 被销毁，用户无法撤回刚被清理的任务（系统行为难以解释）。正确处理：批量衰老时合并为一条 Snackbar，显示"N 个停泊任务已移回列表 [查看并撤回]"，点击后展开列表供用户逐条选择撤回；每条有独立 token 和 8s 窗口（从最后一次批量弹出时间起算）。批量 token Map 在内存中维护，不持久化。
5. **与 TaskTrash 的协调**：当停泊中的任务被软删除（`deletedAt` 非 null）时——无论是本设备操作还是同步自其他设备——立即从停泊列表移除（清除 `parkingMeta`），不触发衰老清理流程，不显示停泊相关的可撤回 Snackbar（删除操作本身已有 `TaskTrashService` 提供的独立撤回机制）。**Trash 恢复时**：`TaskTrashService.restoreTask()` 流程中，若 `deletedMeta` 保存了 `parkingMeta`（见下条），则同时恢复停泊状态——用户的预期是「恢复=回到删除前的状态」。
5b. **deletedMeta 扩展**：`TaskTrashService.deleteTask()` 在保存 `deletedMeta`（`parentId, stage, order, rank, x, y`）时，同时保存当前 `parkingMeta`（如有）。恢复时从 `deletedMeta.parkingMeta` 还原。此扩展仅影响客户端状态，不影响数据库 schema。
6. **衰老清理启动时序**：衰老清理在 `StartupTierOrchestratorService.isTierReady('p1')` 为 true 之后执行，确保 UI 已完全可交互。具体时序为：用户首次有效交互（键盘/点击/滚动）后延迟 3s 执行清理检查。若 Gate 覆盖层处于激活状态，排队等待 Gate 关闭后再执行（详见 A3.5）。

### A5.2 ContextRestoreService

1. 保存快照时必须写入 `contentHash`、`viewMode`、`scrollAnchor`、`structuralAnchor`。Flow 视图下额外写入 `flowViewport`（视口中心坐标、缩放比例、选中节点 ID）。
2. 恢复时先尝试锚点定位，再走百分比 fallback。
3. `contentHash` 不匹配时的**降级恢复算法**（不允许静默失败）：
   - 以**底部 Snackbar** 提示："内容已变更，已跳转到最近匹配位置"。
   - Snackbar 包含 `[跳到顶部]` 按钮，供用户手动重定位。
   - **光标恢复四级 fallback**：
     1. `structuralAnchor.label` 在当前内容中做精确文本搜索 → 命中则跳转到匹配行
     2. 原行号 `cursorPosition.line`（如仍在文档范围内） → 跳转（内容可能已变）
     3. `scrollPercent` 按比例滚动 → 尽力恢复
     4. 均不可用 → 保持文档顶部（第 1 行）
   - **滚动恢复优先级**：锚点元素 `scrollIntoView()` > `scrollPercent` 百分比回退 > 不滚动（保持顶部）。
4. **跨设备/跨视图降级**：当恢复时的 viewMode 与快照 `viewMode` 不一致时（如桌面端 flow 快照在移动端 text 视图恢复），仅使用 `structuralAnchor` 和 `scrollPercent` 做尽力恢复，不尝试 `cursorPosition` 精确恢复，不尝试 `flowViewport` 恢复。不强制切换视图。
5. **Flow 视图保存与恢复**：
   - **保存**：
     - `scale`：通过 `FlowZoomService.getScale()`（已有 `diagram.scale` 读取封装，无需新 API）获取缩放比例，写入 `flowViewport.scale`。
     - `selectedNodeId`：通过 `FlowSelectionService` 或直接读 `diagram.selection.first()?.key` 获取当前选中节点 ID，写入 `flowViewport.selectedNodeId`。
     - **不保存** `positionX`/`positionY` 绝对坐标——`FlowZoomService.ViewState` 的 `positionX/positionY` 字段虽存在但为绝对值，跨屏幕尺寸恢复时无意义，明确排除。`cursorPosition` 在 Flow 视图下始终为 null。
     - `FlowDiagramService` 需新增 `getFlowParkingSnapshot()` 方法，内部封装上述两个字段的读取，返回 `{ scale: number; selectedNodeId: string | null }`，供 `ContextRestoreService` 调用。
   - **恢复**：若 `selectedNodeId` 存在且节点仍在图中，使用 `diagram.commandHandler.scrollToPart(node)` 滚动到节点位置并 `diagram.select(node)` 选中；通过 `FlowZoomService.setZoom(scale)` 恢复缩放（走现有缩放防护逻辑）。若无选中节点，仅恢复缩放比例，不做视口位移。
   - **降级**：节点已被删除时，仅通过 `FlowZoomService.setZoom(scale)` 恢复缩放，不选中节点，不报错。
   - **时序约束**：快照保存必须在 GoJS `diagram.clear()` 之前完成（Hard Rule 5.3 要求视图切换时销毁/重建 diagram），否则视口数据丢失。

### A5.3 SimpleReminderService

1. 支持提醒预设：5 分钟、30 分钟、2 小时后（边界规则详见 A2.4）。
2. Snooze **软上限** 5 次；达到上限后 Snooze 按钮视觉弱化（灰色文字），并在通知中追加引导文案「已延后 5 次，建议处理或忽略」，**但用户仍可继续 snooze**——系统通过视觉引导表达建议，不强制截断用户操作。
3. **"忽略"语义**：取消本次提醒周期，任务保持停泊状态不变。`reminder` 字段置为 `null`，用户可随时在停泊卡片上重新设置提醒（`snoozeCount` 重置为 0）。
4. 提醒类通知使用**三阶段渐进消散策略**（详见 A6.3）：前 5s 不被任何外部交互消散 → 5-15s 外部点击可消散 → 15s 兜底淡出。
5. 提醒通知连续被兜底淡出 2 次后，在停泊坞对应卡片上追加**小红点徽章**，确保用户下次展开停泊坞时能注意到未处理的提醒。

> 防误用提示：当前规范禁止恢复推断服务、节拍器升级链、Mission Control 弹窗服务。

---

## A6. [CURRENT v10.0] 交互语义与体验强化规范

### A6.1 切换语义

1. 主路径：`单击=预览`，`显式按钮[切换到此任务]=切换`。按钮是桌面和移动端**唯一**的鼠标/触控切换入口。
2. 桌面端快捷操作：选中停泊卡片后按 `Enter` 键等价于点击 `[切换到此任务]`。
3. 不使用双击作为切换方式（双击在 Web 中触发文字选中，且触控板体验差，增加交互歧义）。
4. **桌面端快速回切**：`Alt+Shift+P`（macOS 为 `Ctrl+Shift+P`）直接切回最近停泊任务（按 `parkedAt` 最近），跳过预览步骤。快捷键可通过设置页自定义。移动端不提供此快捷路径。

> 设计理由（快捷键选择）：`Ctrl+Tab` 被浏览器占用（切换标签页），`Cmd+Tab` 被 macOS 占用（切换应用），Web 应用无法拦截。`Alt+P` 在 Firefox 中触发菜单栏导航（Alt 键激活菜单），`Ctrl+P` 冲突浏览器打印。`Alt+Shift+P` 为应用级组合键，不与已知浏览器/系统快捷键冲突。

### A6.1b 预览行为规范

1. **桌面端**：单击停泊卡片时，在停泊坞面板内原地展开任务详情（标题、内容摘要、停泊时长、上下文锚点信息），不切换编辑焦点。预览内容在停泊坞的右半区域展开（列表在左半区域），无需离开停泊坞上下文。
2. **移动端**：停泊坞全屏展开后，单击卡片在坞内展开详情区域，顶部带收起箭头。
3. 预览状态支持**轻量编辑**——仅允许以下两种操作，不触发完整上下文切换流程：
   - **修改标题**：直接编辑 Task.title，走 3s 防抖同步。
   - **添加备注**：通过预览区底部专用「+ 备注」输入框追加（输入框内置占位文案："添加一条备注…"，确保入口可发现），以 `\n---\n> 备注（停泊时）: {content}` 格式写入 Task.content 末尾，来源可感知、不覆盖原文。
   - **不允许**自由编辑 content 正文——正文编辑会破坏 `contentHash` 快照的有效性，且与预览区持续显示的「稍后处理中（未切换到此任务）」状态提示产生直接认知矛盾（"我已在编辑为什么说未切换？"）。
   - 两类操作均不改变 `parkingMeta.state`；备注追加不触发重快照，仅在下次 `startWork` 时重新计算 `contentHash`。
   - 设计理由：严格只读会逼迫用户为一个微小修改触发完整「切换→工作→切回」全流程；开放正文编辑则模糊了"当前工作任务"的唯一性边界，并非必要成本。
4. 同一时刻只能预览一个任务——点击另一个卡片时，前一个预览自动关闭并替换。
5. 预览**刷新** `lastVisitedAt`——用户看了一眼等同于"访问"，防止每天查看的任务被衰老清理。
6. 关闭预览：桌面端按 `Escape` 或点击预览面板外区域；移动端按返回按钮。

### A6.2 移动端语义

1. 卡片主操作固定 `[切换到此任务]` 按钮，命中区域 >= 44px。
2. 预览放在二级入口（卡片次按钮或展开详情）。
3. 不依赖双击/长按/左滑作为必要步骤。
4. 移除停泊项：通过卡片"更多菜单 > 移回任务列表"操作，移除后提供 5s Snackbar 撤回。

### A6.2b 桌面端移除停泊项

1. 卡片 `×` 按钮执行"移回普通任务列表"操作。
2. `×` 按钮 hover 时显示 Tooltip："移回任务列表"，消除"关闭=删除"的误解。
3. 移除后提供 5s Snackbar 撤回（与 `REMOVE_UNDO_TIMEOUT_MS` 对齐）。

### A6.3 通知消散策略

通知消散策略**按类型区分**，解决心流状态下提醒被盲消散的问题：

**清理类通知（`type: 'eviction'`）**—— minVisible + intent 策略：

1. `minVisibleMs = 2500` 内不允许自动消散，也不允许被有效交互消散。
2. 超过 2500ms 后，用户的**下一次有效交互**触发消散。
3. `15s` 无操作兜底淡出。

**提醒类通知（`type: 'reminder'`）**—— 三阶段渐进消散策略：

1. **前 5s（`REMINDER_IMMUNE_MS`）**：不被任何外部交互消散（保证用户看到通知内容）。
2. **5s - 15s**：外部**鼠标点击**（通知区域外）可触发消散，但**键盘输入和滚动不触发**——允许用户在阅读通知后通过一个明确的"我看到了"动作（点击别处）关闭通知，同时不因正在打字而意外消散。
3. **15s 兜底淡出**：无操作时自动淡出。
4. 连续被兜底淡出 2 次后，在停泊坞对应卡片上显示**小红点徽章**。

> 设计理由：v8.2 的「完全不被外部交互消散」策略过于强硬——通知在屏幕上停留 15 秒无法被用户正常操作关闭，实际体验类似模态阻碍。三阶段策略平衡了「保证用户看到」（前 5s 免疫）和「不打扰工作流」（5s 后可点击消散）。

**有效交互的精确定义**（仅适用于 eviction 类通知的消散触发条件）：

| 信号 | 是否触发消散 | 说明 |
|---|---|---|
| 键盘输入（`input` / `compositionstart`） | 是 | 用户开始操作内容 |
| 鼠标点击（通知区域**外**） | 是 | 用户已转移注意力 |
| 滚动超过 30px | 是 | 实质性滚动，非微抖 |
| 鼠标移动 | **否** | 不算有效交互 |
| 通知区域**内**点击按钮 | **否**（按按钮功能处理） | 点击 `[撤回]` 等执行对应动作后通知关闭 |

### A6.4 衰老清理策略

1. 停泊任务连续 **64h** 未访问时，卡片**原位**显示**橙色 inline「即将清理」标签**（不移动卡片位置，保持空间记忆稳定）。
2. 用户可点击卡片上的「保留」按钮延长生命周期（重置 `lastVisitedAt`），标签消失。
3. 达到 **72h** 未访问后，系统自动移回普通任务列表，并显示 Snackbar 包含 `[撤回]`（可见 `EVICTION_UNDO_TIMEOUT_MS = 8000ms`）。
4. 清理动作**仅在用户在线时执行**。离线期间不触发清理，上线后重新计算剩余时间。
5. **启动时序**：衰老清理不在应用启动时立即执行——延迟到 `StartupTierOrchestratorService.isTierReady('p1')` 为 true 后、用户首次有效交互后 3s 再执行清理检查。这确保用户不会在页面尚在加载时就看到清理 Snackbar 消失。
6. **与 Gate 的优先级**：若 `gateService.isActive()` 为 true，清理通知排队等待 Gate 关闭后显示（详见 A3.5）。
7. **衰老豁免（Pinned）**：`parkingMeta.pinned === true` 的停泊任务**跳过衰老清理**——不显示"即将清理"标签、不触发自动移回。卡片上显示「已固定」图标。设计理由：长期跟踪型用户（产品经理/项目负责人）需要部分停泊任务长期留存，每隔 72h 被清理通知打扰会产生提醒疲劳。用户可在停泊卡片的"更多菜单"中切换 pinned 状态。

> 设计理由：48h 无法覆盖完整周末（周五下午停泊 → 周一早上 = 60h+），72h 确保周末后用户仍能看到停泊任务，预警从 64h 起给用户 8h 缓冲。

### A6.5 Snooze 策略

1. 预设三档：5 分钟、30 分钟、2 小时后。
2. `2h-later` 语义：当前时间 + 2h，**不封顶**（不假设用户作息时间）。不使用"今天稍后"命名——用户在 23:00 操作时 +2h 跨天，"today" 暗示日内，产生认知歧义。备选第三档"明天此刻"（+24h），当第三档选项需要替代品时使用。
3. 不引入复杂配置表单。
4. 每条提醒 Snooze **软上限 5** 次。达到上限后 Snooze 按钮视觉弱化（灰色文字、降低对比度），并在通知中显示引导文案「已延后 5 次，建议处理或忽略」——但**不禁止继续 snooze**。用户仍可点击弱化的 Snooze 按钮继续延后。
5. 用户选择`[忽略]`后，提醒取消（`reminder` 置 null），任务保持停泊状态不变，可随时重新设置提醒（snoozeCount 重置为 0）。

> 设计理由（软上限而非硬上限）：硬上限在高强度工作中会强制截断用户操作（"我正忙，但系统不让我延后了"），产生恼怒感。软上限通过视觉引导 nudge 用户，同时尊重用户的最终决策权。

### A6.6 恢复反馈

1. `contentHash` 变化时，以**底部 Snackbar** 提示"内容已变更，已跳转到最近匹配位置"。
2. Snackbar 包含 `[跳到顶部]` 按钮。
3. **光标恢复优先级统一引用 A5.2 四级 fallback**（不再在此处独立定义，消除冲突源）：
   - structuralAnchor.label 精确搜索 → cursorPosition.line 行号 → scrollPercent 比例 → 文档顶部

### A6.7 无障碍与动态控制

1. 关键动作支持键盘操作（`Enter` 切换、`Escape` 收起停泊坞/关闭预览、`Tab` 遍历卡片、`Alt+Shift+P` 快速回切）。
2. 所有操作按钮具备读屏标签与明确可点击区域（>=44px）。
3. 支持 `prefers-reduced-motion`，将闪烁降级为静态高亮。

### A6.8 视觉负担控制

1. **停泊坞触发条**（收起态）：始终显示在 `ProjectShellComponent` 主内容区底部中央，宽约 200px（自适应文案长度，详见 A6.9.3）、高 32px 的半透明胶囊条，显示「停泊 (N)」文案和任务数量。无停泊任务时不显示触发条（零视觉负担）。有停泊任务时胶囊条自然出现，提供**始终可达**的入口——无需打开侧栏、无需滚动查找。
2. **触发条位置**：定位于 Text Column 和 Flow Column 之间分隔线（Resizer）的底部中心。若文本栏折叠则居于 Flow Column 底部中央。移动端居于视口底部中央（预留 `env(safe-area-inset-bottom)` 安全距离）。
3. 有提醒且 < 1h 到期的任务：触发条文案变为「停泊 (N) · 1 个提醒即将到期」，胶囊条边框闪烁琥珀色一次（1s）。
4. 列表过长时在坞内滚动，不用硬删除替代信息架构。

### A6.9 布局集成规则——停泊坞（Parking Dock）

> **v10.0 核心变更**：废弃 v9.1 的「左侧栏底部列表 + 右侧面板预览（双端分裂实现）」方案。
> 问题根源：① `FlowRightPanelComponent` 经代码验证为移动端项目列表面板，非通用可复用面板；② Text 视图无右侧面板，需独建 `ParkingPreviewDrawerComponent`，导致双端维护；③ 列表在左侧栏、预览在右侧面板，用户视线跨全屏宽度乒乓；④ 侧栏已被项目列表+搜索框占满，嵌入停泊列表挤占空间。
> v10.0 改为**单一组件 `ParkingDockComponent`**，以底部向上弹出的方式统一所有场景。

**停泊坞的空间定位（ASCII 示意）：**

```
┌──────────────────────────────────────────────────────────┐
│  [Text Column]        │Resizer│      [Flow Column]       │
│                       │   │   │                          │
│                       │   │   │                          │
│                       │   │   │                          │
│                  ┌────┴───┴───┴────┐                     │
│                  │  Parking Dock   │                     │
│                  │  (底部弹出)      │                     │
│                  │  宽: max 720px   │                     │
│                  │  侵入两侧板块    │                     │
├──────────────────┴─────────────────┴─────────────────────┤
│                  [  停泊 (3)  ▲  ]  ← 触发条（收起态）    │
└──────────────────────────────────────────────────────────┘
```

**详细布局规范：**

1. **组件名称**：`ParkingDockComponent`（单一组件，统一桌面/移动端/Text/Flow 所有场景）。
2. **宿主位置**：在 `ProjectShellComponent` 模板中插入，`position: absolute; bottom: 0`，定位锚点为 Resizer 分隔线的水平中心。z-index 高于编辑区但低于 Toast/Gate Overlay。
3. **收起态（触发条）**：
   - 胶囊形状，宽 180-220px（自适应文案长度），高 32px，半透明背景 + backdrop-blur。
   - 显示「停泊 (N) ▲」。N 为 0 时隐藏整个触发条。
   - 点击或按 `Alt+Shift+P` 展开停泊坞。
   - 鼠标 hover 时微微上移 2px 暗示可展开，提供视觉反馈。
   - 位置锚定：`left: calc(textColumnRatio% - 触发条宽度/2)`，即始终居中于分隔线。文本栏完全折叠时以 Flow Column 左边缘为锚。移动端以视口宽度 50% 为锚。
4. **展开态（停泊坞面板）**：
   - 从触发条位置向上展开，带翻转动画（200ms ease-out）。
   - **桌面端尺寸**：宽度 `max(480px, 40vw)`，最大不超过 `min(720px, 80vw)`；高度 `max(280px, 45vh)`，最大不超过 `min(480px, 70vh)`。
   - **面板侵入两侧**：面板水平居中于 Resizer 线，向左覆盖 Text Column 的右侧边缘，向右覆盖 Flow Column 的左侧边缘。形成"横跨分隔线"的视觉效果。圆角 `12px`（底部圆角为 0，与触发条衔接）。
   - **投影与层级**：`box-shadow: 0 -4px 24px rgba(0,0,0,0.08)`，背景继承主题色 `var(--theme-bg)` + 80% 不透明度 + `backdrop-filter: blur(16px)`。
   - **内部布局**：
     - **左半区**（约 40%，`DOCK_LIST_RATIO`）：停泊任务列表，按 `parkedAt` 降序排列。每条卡片显示：任务标题、所属项目名、停泊时长、状态标签（「即将清理」橙色 inline 标签 / 「已固定」图标 / 提醒倒计时标签）。
     - **右半区**（约 60%）：当选中某个卡片时，展开该任务的预览详情（标题可编辑、内容摘要、上下文锚点信息、「+ 备注」输入框、`[切换到此任务]` 主按钮）。未选中时显示空态占位："点击左侧任务查看详情"。
     - **顶部栏**：左侧显示「稍后处理」标题；右侧显示收起按钮 `▼` 和可选的排序/筛选控件。
   - **收起方式**：点击面板外任意区域 / 按 `Escape` / 点击顶部 `▼` 收起按钮 / 再次点击触发条。
5. **移动端行为**：
   - 触发条居于视口底部中央，距底部 `max(8px, env(safe-area-inset-bottom))` 安全距离（避开 iOS 系统手势栏）。
   - 展开为底部抽屉（Bottom Sheet），宽度 100vw，高度 60vh，可向上拖拽至 70vh（`DOCK_MOBILE_MAX_HEIGHT_VH`）。
   - 内部布局改为**单栏纵向**：任务列表在上，选中后详情在列表下方内联展开。
   - 下拉超过 80px 阈值自动收起（与侧栏滑动手势模式一致）。
   - 展开时底部菜单栏（若有）被停泊坞覆盖。
6. **文本栏折叠场景**：当 `uiState.isTextColumnCollapsed() === true` 时，触发条和展开面板均以 Flow Column 底部中央为锚点（偏移到左侧边缘 + 50% 宽度）。
7. **与 Toast 的层级关系**：Toast 通知的 z-index 高于停泊坞。停泊坞展开时 Toast 仍正常显示在其上方。
8. **停泊卡片视觉区分**：卡片左侧使用 3px 宽的半透明靛蓝色边框标记（与普通任务卡片区分），hover 时整卡片浅色高亮。

> 防误用提示：禁止把"用户下一次任意交互"直接等同于"用户已读且已完成决策"。有效交互的精确定义见 A6.3。

---

## A7. [CURRENT v10.0] 桌面/移动行为兼容矩阵

| 能力 | 桌面 | 移动 | 统一语义 |
|---|---|---|---|
| 预览 | 停泊坞内单击卡片（右半区展开详情） | 停泊坞内单击卡片（坞内展开详情） | 仅查看，不切换，刷新 lastVisitedAt |
| 切换 | `[切换到此任务]` 按钮 / 选中后 Enter / `Alt+Shift+P` 快速回切 | `[切换到此任务]` 按钮 | 显式意图才切换 |
| 移除停泊 | 卡片 `×` 按钮（hover Tooltip"移回列表"） | 更多菜单 > 移回任务列表 | 移回普通列表 + 5s Snackbar 撤回 |
| 通知交互 | 底部 Snackbar + 键盘可达 | 底部 Snackbar + 大按钮 | reminder 三阶段渐进消散（A6.3）；eviction 用 minVisible+intent |
| 恢复高亮 | 1000ms 三段式，可降级 | 1000ms 三段式，可降级 | 视觉落点一致 |
| 停泊坞 | 底部触发条常驻，点击展开面板 | 底部触发条常驻，点击展开 Bottom Sheet | 信息始终可达、零视觉负担（无停泊时隐藏） |

> 防误用提示：移动端不使用左滑删除和双击操作，避免与系统手势冲突。

---

## A8. [CURRENT v10.0] 核心流程时序（v10.0）

### 场景一：当前任务 -> 稍后任务 -> 恢复

1. 用户在任务 A 工作，单击任务 B 进入预览（不切换）。
2. 用户点击 B 的 `[切换到此任务]` 按钮（或桌面端选中后按 Enter）。
3. 系统保存 A 的 `contextSnapshot`（text 视图保存光标/滚动/锚点；flow 视图保存 `flowViewport`）并将 A 设为 `parked`。
4. 系统将 B 设为 `focused`，恢复 B 快照（如有；`contentHash` 不匹配时走四级 fallback 降级恢复，详见 A5.2）。
5. 用户稍后点击 A 的 `[切换到此任务]`，系统恢复 A 并高亮编辑行（或 reduced-motion 降级高亮）。

### 场景二：提醒到达 -> Snooze

1. 任务 C 到达提醒时间，显示通知：`[切换过去] [5分钟] [30分钟] [2小时后] [忽略]`。
2. 提醒通知采用三阶段渐进消散：前 5s 不被外部交互消散 → 5-15s 外部点击可消散 → 15s 兜底淡出（详见 A6.3）。
3. 用户选择 `30分钟`，服务写入 snooze 并重新设定提醒。
4. Snooze 达到软上限（5 次）后 Snooze 按钮视觉弱化，显示引导文案，但用户仍可继续 snooze。
5. 用户选择忽略后，提醒取消，任务保持停泊状态，可随时重建提醒。

### 场景三：64h 预警 -> 72h 衰老 -> 撤回

1. 任务 D 连续 **64h** 未被访问，停泊坞中该卡片原位显示**橙色 inline「即将清理」标签**（不移动位置，保持空间记忆稳定）。
2. 用户可点击卡片上的「保留」按钮重置 `lastVisitedAt`，标签消失。
3. 用户未操作且达到 **72h**，系统移回普通任务列表，显示 Snackbar（8s 可见）：`「任务名」已移回任务列表 [撤回]`。
4. 用户点击 `[撤回]`，通过 `undoEviction(token)` 恢复 D 的 `parked` 状态与原排序位置。
5. 注意：清理仅在用户在线时执行，离线期间不触发。

### 场景四：无 focused 任务状态

1. 用户完成当前 focused 任务（标记完成/归档/删除），不立即选择任何停泊任务继续。
2. 此时没有 focused 任务，停泊坞正常展示停泊列表，无特殊处理。
3. 用户可随时从停泊坞点击 `[切换到此任务]` 切入任一停泊任务，被点击任务变为 focused。
4. 用户也可从普通任务列表直接开始新任务（与停泊功能无关的正常操作）。

### 场景五：停泊任务被软删除

1. 用户（或其他设备同步）将停泊列表中的任务 E 软删除（`deletedAt` 非 null）。
2. 系统立即从停泊列表移除任务 E，清除其 `parkingMeta`。
3. 不触发衰老清理流程，不显示停泊相关的可撤回 Snackbar。
4. 删除操作本身的撤回由 `TaskTrashService` 的独立机制处理。

> 防误用提示：核心流程只保留三条主链路，不得混入 v6 的推断/节拍/预热流程。

---

## A9. [CURRENT v10.0] 配置常量规范

```typescript
export const PARKING_CONFIG = {
  /** 72h 覆盖完整周末（周五下午 → 周一上午） */
  PARKED_TASK_STALE_THRESHOLD: 72 * 60 * 60 * 1000,
  /** 距 72h 剩余 8h 时显示"即将清理"橙色标签 */
  PARKED_TASK_STALE_WARNING: 64 * 60 * 60 * 1000,
  /** 只警告，不强删（此值待 MVP 验证后调整） */
  PARKED_TASK_SOFT_LIMIT: 10,

  NOTICE_MIN_VISIBLE_MS: 2500,
  NOTICE_FALLBACK_TIMEOUT_MS: 15000,
  /** 提醒通知前 5s 不被外部交互消散（三阶段渐进消散的第一阶段） */
  REMINDER_IMMUNE_MS: 5000,

  EDIT_LINE_FLASH_DURATION: 1000,

  SNOOZE_PRESETS: {
    QUICK: 5 * 60 * 1000,
    NORMAL: 30 * 60 * 1000,
    /**
     * 2h-later = 当前时间 + 2h，不封顶
     * ⚠️ 不使用 "later-today" 命名——用户在 23:00 操作时 +2h 会跨天，
     * "today" 暗示日内，产生认知歧义。使用纯时间量描述。
     */
    TWO_HOURS_LATER: 2 * 60 * 60 * 1000,
    /** 备选第三档：当前时间 + 24h */
    TOMORROW_SAME_TIME: 24 * 60 * 60 * 1000,
  },

  /**
   * Snooze 软上限（5 次后视觉弱化但不禁止继续 snooze）
   * 3 次在高强度工作日一上午即可用完，放宽至 5
   */
  MAX_SNOOZE_COUNT: 5,
  MIN_TOUCH_TARGET: 44,
  /** 手动移除停泊项后 Snackbar 撤回窗口（5s 符合 Material Design 默认值，留够阅读+决策时间） */
  REMOVE_UNDO_TIMEOUT_MS: 5000,
  /** 自动衰老清理后 Snackbar 撤回窗口（系统行为需更长理解时间） */
  EVICTION_UNDO_TIMEOUT_MS: 8000,
  /** 衰老清理在启动后延迟执行的等待时间（用户首次交互后再延迟此毫秒数） */
  EVICTION_STARTUP_DELAY_MS: 3000,

  // ─── Dock 布局 ───
  /** 触发条基准宽度（收起态胶囊，实际 180-220px 自适应文案长度，详见 A6.9.3） */
  DOCK_TRIGGER_WIDTH: 200,
  /** 触发条高度 */
  DOCK_TRIGGER_HEIGHT: 32,
  /** 展开态面板最大宽度（CSS: min(720px, 80vw)，详见 A6.9.4） */
  DOCK_EXPANDED_MAX_WIDTH: 720,
  /** 展开态面板基准高度 vh（CSS: clamp(280px, 45vh, min(480px, 70vh))，详见 A6.9.4） */
  DOCK_EXPANDED_HEIGHT_VH: 45,
  /** 展开/收起动画时长 */
  DOCK_ANIMATION_MS: 200,
  /** 左侧列表栏占展开面板宽度比例 */
  DOCK_LIST_RATIO: 0.4,
  /** 移动端 Bottom Sheet 最大高度（vh 百分比） */
  DOCK_MOBILE_MAX_HEIGHT_VH: 70,
} as const;
```

> 防误用提示：当前配置中不存在 `MAX_PARKED_TASKS`、`MISSION_CONTROL_THRESHOLD`、`OVERLAP_NOTICE_DURATION`、`LATER_TODAY_CAP`、`LATER_TODAY_HIDDEN_AFTER`、`TOMORROW_MORNING`、`LATER_TODAY`、`SIDEBAR_PARKING_HEIGHT` 等旧常量。Dock 布局常量集中于 `PARKING_CONFIG.DOCK_*` 命名空间。

---

## A10. [CURRENT v10.0] 实施路线图（体验优先版）

### 阶段 1：文档归一（第 1 天）

1. 建立 Current/Archive 标记。
2. 完成真值表与公共接口冻结。
3. 移除当前章节中的旧命名与旧流程引用。

### 阶段 2：规范重写（第 2 天）

1. 重写第 3/4/8/10/12 章为当前规范。
2. 输出桌面/移动兼容矩阵。
3. 将历史流程整体下沉到 Archive 折叠区。

### 阶段 3：体验条款完善（第 3 天）

1. 补齐通知可见性、衰老可逆、Snooze 档位、无障碍、reduced-motion。
2. 加入“每章防误用提示”。

### 阶段 4：干跑评审（第 4 天）

1. 按文档走查一次实现方案。
2. 校验实现者是否仍需二次决策。
3. 形成可执行任务清单（不在本次文档内展开代码实现）。

> 防误用提示：路线图中不得再出现 `mission-control.component.ts`、推断服务、节拍器服务等已废弃实现项。

---

## A11. [CURRENT v10.0] 测试与验证场景

### A11.1 真人体验探查（12 人）

1. 桌面 6 人、移动 6 人。
2. 统一任务脚本，采用 think-aloud。
3. 核心脚本：
   - A：浏览 3 个任务后切到目标任务（验证"浏览不误切换"）。
   - B：被打断后恢复原任务（验证恢复定位与认知回归速度）。
   - C：提醒到达时正在忙（验证提醒通知三阶段消散：5s 内不消散，5s 后可点击消散）。
   - D：72h 清理与撤回（验证信任与可逆）。
   - E：移动端单手操作（验证命中率与误触率）。
   - F：桌面端 `Alt+Shift+P` 快速回切（验证熟练用户快捷路径）。
   - G：Flow 视图中停泊并恢复（验证 GoJS 视口/选中节点的保存与恢复）。
   - H：停泊任务被软删除（验证从停泊列表正确移除，不显示异常状态）。
   - I：停泊坞触发条交互（验证收起态胶囊可见性、展开/收起手感、移动端底部弹出适配）。
   - J：停泊坞预览（验证列表+预览双栏布局，单击卡片右侧展开预览，视线无需跨全屏宽度移动）。

### A11.2 工程验收检查

1. 类型一致性检查（`parkingMeta` 单命名）。
2. 章节标记一致性检查（Current/Archive）。
3. 术语冲突检查（不把 Mission Control 误当现行能力）。
4. 文档 lint（锚点、编号、链接可达）。
5. 上下文恢复功能验证：停泊后修改内容，恢复时确认降级 Snackbar 提示出现且 `[跳到顶部]` 按钮可用。
6. 衰老清理功能验证：模拟 64h/72h 未访问，确认橙色标签和自动移回行为正确，`[撤回]` 可用（8s 窗口）。
7. 移除撤回验证：手动移除停泊项后确认 5s Snackbar 撤回功能正常。
8. 跨设备恢复验证：桌面端 flow 视图停泊，移动端 text 视图恢复，确认降级逻辑正确（不尝试 cursorPosition）。
9. 提醒通知消散验证：在用户持续输入时触发提醒通知，确认前 5s 通知不被消散，5s 后点击可消散，键盘输入不消散。
10. Flow 视图快照验证：在 Flow 视图停泊任务，切回后确认视口位置、缩放比例和选中节点正确恢复。
11. TaskTrash 联动验证：软删除停泊中的任务，确认从停泊列表立即移除，不显示衰老清理 Snackbar。
12. Gate 优先级验证：Gate 覆盖层激活时，模拟衰老清理触发，确认清理通知等待 Gate 关闭后才显示。
13. 衰老清理启动时序验证：应用启动后，确认清理检查在首次用户交互后 3s 才执行，非启动时立即执行。
14. 命名一致性检查：确认代码中使用 `'focused'`（非 `'active'`）作为 `parkingMeta.state` 的值，避免与 `Task.status: 'active'` 混淆。
15. Undo 集成验证：执行 startWork 后 Ctrl+Z，确认两个任务的 parkingMeta 同时回滚。
16. Spotlight 共存验证：Spotlight 激活时，确认停泊列表 `[切换到此任务]` 按钮不可用。
17. Strata 衔接验证：停泊任务标记完成后，确认从停泊列表消失并出现在 Strata 沉积层。
18. 搜索验证：全局搜索停泊任务的标题，确认搜索结果显示"停泊中"标记。
19. Pinned 验证：固定停泊任务后等待 72h+，确认不触发衰老清理。
20. BeforeUnload 验证：关闭标签页后重新打开，确认 focused 任务的快照已保存到 IndexedDB。
21. 导出/导入验证：导出包含停泊任务的项目，导入后确认 parkingMeta 保留但 contextSnapshot 为 null。
22. Trash 恢复验证：删除并恢复停泊任务，确认 parkingMeta 还原。
23. LWW 冲突验证：两设备分别修改同一任务的 content 和 parkingMeta，确认 LWW 行为符合预期（整体覆盖，不产生数据损坏）。
24. 预览轻量编辑验证：在预览状态修改标题，确认 Task.title 更新且不触发上下文切换。
25. 停泊坞定位验证：桌面端确认触发条和展开面板居中于 Resizer 分隔线；文本栏折叠时确认居于 Flow Column 底部中央。
26. 停泊坞展开/收起验证：点击触发条展开面板，点击面板外区域或按 Escape 收起，确认动画 200ms、无闪烁。
27. 停泊坞移动端验证：移动端确认以 Bottom Sheet 形式从底部弹出，支持下拉收起手势，预留 `safe-area-inset-bottom`。
28. 停泊坞与 Resizer 拖拽协同验证：拖拽 Resizer 改变 Text/Flow 比例时，确认触发条跟随 Resizer 位置实时移动。

### A11.3 通过阈值

1. 误切换率 `< 3%`。
2. 恢复成功率 `> 95%`。
3. 关键动作首次成功率 `> 90%`。
4. 撤回可达率 `= 100%`。

> 防误用提示：没有通过上述阈值前，不应扩大功能复杂度。

---

## A12. [CURRENT v10.0] 验收标准

| 编号 | 场景 | 预期结果 |
|---|---|---|
| P-01 | 单击停泊卡片 | 停泊坞内展开预览详情（桌面坞内右半区/移动端坞内展开），不切换 Focus，刷新 lastVisitedAt |
| P-02 | 点击 `[切换到此任务]` 按钮 | 执行切换并自动停泊当前任务 |
| P-02b | 桌面端选中卡片后按 Enter | 等价于点击 `[切换到此任务]`，执行切换 |
| P-02c | 桌面端按 `Alt+Shift+P` | 直接切回最近停泊任务，跳过预览 |
| P-03 | 恢复任务 | `contextSnapshot` 成功恢复（光标 + 锚点滚动） |
| P-04 | 内容变更恢复 | `contentHash` 不匹配时底部 Snackbar 提示"内容已变更"，包含 `[跳到顶部]` 按钮，光标按优先级降级恢复 |
| P-04b | 跨设备视图恢复 | viewMode 不一致时仅用 structuralAnchor+scrollPercent 恢复，不尝试 cursorPosition |
| P-05 | 提醒通知 | 前 5s 不被外部交互消散；5-15s 外部点击可消散，键盘/滚动不消散；15s 兜底淡出 |
| P-05b | 清理通知 | 至少显示 2.5 秒，2.5s 内不可被任何交互消散；之后按有效交互定义（A6.3）消散 |
| P-06 | Snooze 5/30/2h-later | 三档均可触发；2h-later = +2h 不封顶 |
| P-07 | Snooze 软上限 | 达到 5 次后 Snooze 按钮视觉弱化 + 引导文案，但用户仍可继续 snooze |
| P-07b | 忽略后重建提醒 | 忽略后 reminder 置 null，可随时重新设置，snoozeCount 重置 |
| P-08 | 64h 预警 | 64h 未访问时卡片原位显示橙色 inline「即将清理」标签，不移动位置 |
| P-09 | 72h 衰老清理 | 72h 未访问后移回普通任务列表，Snackbar 显示 `[撤回]`（8s 可见） |
| P-10 | 撤回清理 | `undoEviction(token)` 可恢复原停泊状态与排序位置 |
| P-11 | 手动移除撤回 | 移除停泊项后 5s Snackbar 可撤回 |
| P-12 | 移动端切换 | 不依赖双击/左滑，显式 `[切换到此任务]` 按钮可达且命中区域 >= 44px |
| P-13 | reduced-motion | 闪烁动画可降级为静态高亮 |
| P-14 | 命名一致性 | 当前章节不出现 `overlap 前缀旧命名`、不出现"开始做"/"继续"旧按钮文案、`parkingMeta.state` 使用 `'focused'` 而非 `'active'` |
| P-15 | structuralAnchor fallback | 当锚点退化为 fallback 且与标题重复时，卡片不显示锚点行 |
| P-16 | 离线清理保护 | 离线期间不触发衰老清理，上线后重新计算 |
| P-17 | 无 focused 任务时点击 `[切换到此任务]` | 被点击任务变为 focused，无需先停泊其他任务（因为没有 focused 任务） |
| P-18 | 停泊任务被其他设备 soft delete | 同步后本设备停泊列表中该任务消失，不显示异常状态，parkingMeta 被清除 |
| P-19 | 两设备同时操作同一任务的 parkingMeta | LWW 以 updatedAt 最新的为准，不产生数据损坏 |
| P-20 | 网络恢复后 parkingMeta 同步 | 增量拉取正确合并 parkingMeta 字段，包括 contextSnapshot |
| P-21 | 停泊列表达到 SOFT_LIMIT (10) | 显示"停泊任务较多"的非侵入式提示（Tooltip 或卡片内警告文字），不阻止继续停泊 |
| P-22 | 设置提醒时间为过去时间 | 服务端拦截并拒绝，提示"请选择未来时间" |
| P-23 | Flow 视图停泊恢复 | 停泊时保存 GoJS 视口位置/缩放/选中节点；恢复时正确 centerRect + select |
| P-24 | Flow 视图降级恢复 | 选中节点已被删除时，仅恢复视口和缩放，不报错 |
| P-25 | 衰老清理启动时序 | 清理在 `StartupTierOrchestratorService.isTierReady('p1')` 后、用户首次交互后 3s 执行，非启动时立即执行 |
| P-26 | Gate 与清理通知优先级 | Gate 覆盖层激活时，清理通知排队等待 Gate 关闭后显示 |
| P-27 | 本设备软删除停泊任务 | 从停泊列表立即移除，不触发衰老清理流程，不显示停泊相关 Snackbar |
| P-28 | isTaskEqual 脏检查 | parkingMeta.state、parkedAt、reminder.reminderAt、reminder.snoozeCount 变化时触发 signal 通知，不被脏检查吞除 |
| P-29 | Spotlight 共存 | Spotlight 模式激活时，停泊列表 `[切换到此任务]` 置灰，Tooltip 提示退出 Spotlight |
| P-30 | Strata 衔接 | 停泊任务标记完成后，从停泊列表移除并出现在 Strata 沉积层 |
| P-31 | 搜索可见性 | 停泊任务出现在全局搜索结果中，显示"停泊中"标记 |
| P-32 | Pinned 衰老豁免 | pinned=true 的停泊任务不触发 64h 预警和 72h 衰老清理 |
| P-33 | Trash 恢复停泊 | 恢复软删除的停泊任务后，parkingMeta 从 deletedMeta 还原 |
| P-34 | Undo 停泊操作 | Ctrl+Z 一次性回滚 startWork 操作（两个任务的 parkingMeta 同时还原） |
| P-35 | BeforeUnload 快照 | 关闭标签页或切换 App 时，focused 任务快照已保存到 IndexedDB |
| P-36 | 导出兼容 | 导出项目时 parkingMeta 保留但 contextSnapshot 为 null |
| P-37 | 预览轻量编辑 | 预览状态下可修改标题和添加备注，不触发上下文切换 |
| P-38 | 停泊坞触发条定位 | 触发条居中于 Resizer 分隔线底部；文本栏折叠时居于 Flow Column 底部中央；移动端居于视口底部中央且不被系统手势栏遮挡 |
| P-39 | 停泊坞展开/收起 | 点击触发条展开停泊坞面板，点击面板外区域/Escape/触发条收起；动画 200ms |
| P-40 | 停泊坞跨视图一致 | Text 视图和 Flow 视图下停泊坞行为完全一致（同一组件），无需分别实现 |

> 防误用提示：验收表统一以 `contextSnapshot` 口径描述，禁止再引入 `lastEditLine/lastEditContent` 分裂验收口径。

---

## A13. [CURRENT v10.0] 术语表（现行）

| 术语 | 定义 |
|---|---|
| Parking（停泊） | 将当前任务暂存为"稍后处理" |
| Parking Dock（停泊坞） | 底部向上弹出的停泊任务管理面板，定位于 Text/Flow 分隔线中心，是停泊功能的唯一 UI 容器 |
| Focused Task | 当前唯一工作任务（`parkingMeta.state === 'focused'`）；注意与 `Task.status: 'active'`（表示"未完成"）区分 |
| Parked Task | 已停泊、可随时恢复的任务 |
| Context Snapshot | 恢复所需的物理上下文快照（text 视图：光标/滚动/锚点；flow 视图：视口/缩放/选中节点） |
| Parking Notice | 提醒/清理通知的统一事件契约 |
| Undo Eviction | 自动清理后的可逆恢复动作 |
| Three-Phase Dismissal | 提醒通知的三阶段渐进消散策略（5s 免疫 → 点击可消散 → 15s 兜底） |

### 历史术语（仅回溯）

`Focus Pod`、`Incubator`、`Metronome`、`Mission Control`、`Correction Toast`、`Active Task`（旧称，已改为 Focused Task） 等均归入 `[ARCHIVE]`，不作为当前实现术语。

> 防误用提示：评审中如出现历史术语，必须同时标注“仅历史概念，不进入当前实现”。

---

## A14. [CURRENT v10.0] 假设与默认值

1. 默认保持 v7.1 极简核心，不恢复 v6 复杂子系统。
2. 默认保留单文档，通过 Current/Archive 强隔离避免误读。
3. 默认桌面与移动同优先，所有关键流程提供双端可达路径。
4. 默认可逆性优先于激进自动化，所有自动移除/手动移除必须可撤回。
5. 默认认知增强（如 LLM 摘要）为后续探索，不在当前规范承诺。
6. `PARKED_TASK_SOFT_LIMIT`、`MAX_SNOOZE_COUNT` 与 `SNOOZE_PRESETS` 的具体数值待 MVP 验证后调整，当前值为保守默认值。
7. 离线期间不触发衰老清理等时间驱动的自动行为。
8. 停泊列表跨项目全局可见（详见 A3.3），不按项目隔离。
9. 衰老阈值 72h 以日历时间计算，不区分工作日/非工作日（简化实现，MVP 后可扩展）。
10. `parkingMeta.state` 使用 `'focused' | 'parked'` 命名，不使用 `'active'`——避免与 `Task.status: 'active'` 歧义。
11. 快捷键 `Alt+Shift+P` 为默认绑定，可通过设置页自定义——不使用 `Ctrl+Tab` / `Cmd+Tab`（被浏览器/系统占用），不使用 `Alt+P`（Firefox 菜单栏冲突），不使用 `Ctrl+P`（浏览器打印冲突）。
12. 停泊列表数据通过独立轻量查询加载（A3.4），不依赖各项目的完整任务数据加载。
13. 衰老清理在启动时延迟执行（A5.1.6 / A6.4.5），以 `StartupTierOrchestratorService.isTierReady('p1')` 为前置，不在页面加载时立即触发。
14. Gate 覆盖层的优先级高于衰老清理通知（A3.5），`gateService.isActive()` 为 true 时清理通知排队。
15. 停泊中的任务被软删除时立即从停泊列表移除（A5.1.5），不走衰老清理流程。
16. `parkingMeta` 仅对 `status: 'active'` 的任务有效——completed/archived 任务不可停泊，已停泊任务被标记完成时自动清除 parkingMeta。
17. 停泊操作与 Undo 系统集成（A3.7），使用 batch 模式确保跨任务原子回滚。
18. Spotlight 模式激活时禁止从停泊列表切换任务（A3.8），避免两套聚焦机制冲突。
19. 数据库 schema 变更（A3.6 migration）是实施的前置依赖，必须在功能代码之前完成。
20. 现有 Toast 仅支持 1 个 action 按钮，需创建独立通知组件或扩展 Toast（A3.13）。
21. `parkingMeta.pinned` 允许用户豁免衰老清理（A6.4.7），默认 `false`。
22. 项目导出时 `contextSnapshot` 置 null（A3.11），导入时更新 `lastVisitedAt`。
23. LWW 字段级冲突为已知限制（A3.14），通过独立防抖通道缓解。
24. `flowViewport` 不保存绝对坐标，以 `selectedNodeId` 为视口锚点。

> 防误用提示：本章假设用于约束 scope，不用于偷渡新需求。

---

## A15. [CURRENT v10.0] 真人体验反机械校正与全量联动门禁

本章是实施前**强制门禁**：用于识别“纸面可行但真人不顺手”的机械化风险，并将其映射到现有模块的真实改动点。未通过本章门禁，不进入开发排期。

### A15.1 真人体验反机械校正（避免系统替用户做错误推断）

1. **预览 ≠ 切换必须被持续明示**：停泊坞内预览区头部固定显示「稍后处理中（未切换到此任务）」状态文案，避免用户误以为已切换导致编辑上下文错位。预览状态内仅允许修改标题和添加备注（A6.1b），预览区视觉上与"正在工作中的编辑器"明显区分（字号较小、背景色区分、无焦点光标）。
2. **提醒动作避免“高压按钮墙”**：提醒通知保留现有动作集合，但移动端默认只展示主动作 + Snooze 主档，其他动作收纳到二级入口（保持语义不变，降低误触）。
3. **自动清理必须可解释**：72h 清理 Snackbar 必须包含触发原因（示例："72 小时未访问"），避免用户感知为“任务被系统吞掉”。
4. **跨项目停泊必须可识别来源**：停泊卡片固定展示项目名与最近访问时间，防止“我看见任务但不知道来自哪个项目”的认知中断。
5. **禁止意图过度推断**：继续坚持“显式按钮触发切换”，不允许通过 hover/滚动/停留时长推断“用户想切换”。

### A15.2 与现有模块联动差距（全量）

| 模块 | 当前代码现状（2026-02-22） | 若不处理会出现的问题 | 方案内强制修正规则 |
|---|---|---|---|
| `models/index.ts` + `models/core-types.ts` `Task` | 无 `parkingMeta` 字段 | 类型层无法承载停泊状态，后续实现会出现大量 `as any` 与字段丢失 | 先补齐 `TaskParkingMeta`/`ParkingSnapshot`/`ParkingReminder` 类型，再进入服务层实现 |
| `TaskStore.isTaskEqual()` | 未比较 `parkingMeta` | 停泊状态变化被脏检查吞掉，UI 不刷新 | 按 A3.2 增加 `state/parkedAt/reminderAt/snoozeCount/pinned` 比较 |
| `FIELD_SELECT_CONFIG.TASK_LIST_FIELDS` + `supabase-types.ts` | 未包含 `parking_meta`；`TaskRow/TaskUpdate` 无对应列 | 增量拉取与类型映射漏字段，跨设备状态不一致 | migration、字段选择、Row/Insert/Update 类型三处同步更新 |
| 生命周期编排 | `AppLifecycleOrchestratorService` 无 `ready` 状态；P1/P2 由 `StartupTierOrchestratorService` 提供 | 文档按不存在状态编程，启动时序无法精确落地 | 文档中“ready 后执行”统一改为“`StartupTierOrchestratorService.isTierReady('p1')` 且首次有效交互后执行” |
| Gate 协调 | `GateService` 暴露 `isActive()`（signal），非 `isGateActive` 属性 | 实施时调用契约错误 | 统一使用 `gateService.isActive()` 作为门禁条件 |
| 提醒通知组件 | `ToastService` 仅单 `action`，`toast-container` 仅单按钮 | 多动作提醒无法落地，强行复用会破坏通用 Toast | 维持 A3.13：独立 `ParkingNoticeComponent`（推荐） |
| Undo 系统 | `UndoActionType` 无 `task-park`；批处理默认记录 `task-move` | 停泊回滚语义不清，测试与审计混乱 | 新增 `task-park` 类型，并定义跨项目回滚数据结构 |
| 回收站联动 | `deletedMeta` 未包含 `parkingMeta` | 恢复任务后停泊状态丢失（违背“恢复=回到删除前”） | 扩展 `deletedMeta.parkingMeta`，restore 时恢复 |
| 搜索联动 | `SearchService` 仅搜索当前活动项目任务 | 跨项目停泊"可见但不可搜"，用户感知割裂 | 在 `SearchService.search()` 结果合并层追加 `parkedTaskIds` 中非当前项目的任务（通过 `tasksMap.get(id)` 取对象），标注「停泊中」；不改底层 Supabase 全文搜索逻辑 |
| 导出/导入 | `ExportTask` / 导入映射无 `parkingMeta` | 导出后停泊语义丢失，导入后行为与预期不符 | 导出保留 `parkingMeta` 且 `contextSnapshot=null`；导入执行过期提醒清理 |
| Flow 快照 | `FlowDiagramService` 暂无停泊专用快照 API；`FlowZoomService.ViewState` 含 `positionX/positionY` 绝对坐标 | 直接复用 ViewState 会把绝对坐标写入快照（跨屏幕无意义）；无公共 API 导致"写在方案里、代码无入口" | 新增 `FlowDiagramService.getFlowParkingSnapshot()` 只取 `scale` + `selectedNodeId`，**明确排除** `positionX/positionY`（见 A5.2.5） |
| IndexedDB 版本 | `FOCUS_CONFIG.SYNC.IDB_VERSION=2`，无 `parked_tasks` store | 停泊跨项目缓存无稳定落地点 | 升级到 v3 并新增 `parked_tasks` store（含升级迁移） |
| UndoService 跨项目 batch | `beginBatch(project: Project)` 仅接受单个项目 | 跨项目停泊无法原子回滚，Ctrl+Z 只覆盖一侧 | 同项目用 batch，跨项目退化为两条独立记录 + UI 说明（见 A3.7） |
| SpotlightService 停泊任务过滤 | `selectNextTask()` 未排除 `parkingMeta != null` 的任务 | 已停泊任务重复出现在停泊列表和 Spotlight 队列 | 读取 `TaskStore.parkedTaskIds` Set，过滤 `!parkedTaskIds().has(task.id)`（见 A3.8） |
| `deletedMeta.parkingMeta` 存储层级 | `deletedMeta` 结构暂无 `parkingMeta` 字段，存于客户端内存 | Trash 恢复后停泊状态丢失 | 扩展客户端内存 `deletedMeta` 结构（不改 DB schema），追加 `parkingMeta` 快照字段 |
| UiStateService 停泊坞状态 | 未声明停泊坞展开状态；localStorage 持久化未覆盖新字段 | 刷新后停泊坞折叠状态丢失，用户重复操作 | 新增 `isParkingDockOpen: signal(false)`（默认收起），初始化时读取 localStorage，变更时写回；与 `isTextColumnCollapsed` / `activeView` 协同计算触发条定位 |
| BeforeUnload async 约束 | `BeforeUnloadCallback` 为同步签名，IDB 写入为 async | beforeunload 中 IDB 写入无法保证完成 | beforeunload 改为 `localStorage` 同步写最小草稿；visibilitychange:hidden 走完整 IDB 快照（见 A3.12） |
| 停泊坞布局容器 | `ProjectShellComponent` 模板无停泊面板插槽；`FlowRightPanelComponent` 经验证为移动端项目列表面板（`calc(100vw/3)` 固定宽度），不可复用 | 停泊功能无 UI 容器，Text 和 Flow 视图各需独立实现——维护成本翻倍 | 新建 `ParkingDockComponent`（`position: absolute; bottom: 0`），插入 `ProjectShellComponent` 模板末尾，居中于 Resizer 分隔线，收起时为触发条、展开时为列表+预览双栏面板；所有视图共享同一组件（见 A6.9） |

### A15.3 实施顺序门禁（必须按序通过）

1. **Schema/Type 门禁**：`parking_meta` migration + `Task`/Supabase 类型补齐。
2. **Sync/Store 门禁**：`FIELD_SELECT_CONFIG` + `isTaskEqual` + 停泊索引结构到位。
3. **交互门禁**：`ParkingDockComponent` + `ParkingNoticeComponent`、预览明示文案、Gate 优先级队列落地。
4. **生态门禁**：Undo、TaskTrash、Search、Export/Import、IDB 升级全部打通。
5. **验收门禁**：A11/A12 全量场景通过后，才允许追加“更聪明”的增强能力。

### A15.4 非人类化风险（明确禁止）

1. 禁止把“用户发生了操作”直接等价为“用户已经理解系统状态”。
2. 禁止用自动规则替代关键决策（例如自动切换、自动忽略提醒、自动合并冲突）。
3. 禁止为了“指标好看”牺牲可逆性（清理、移除、提醒都必须可撤回或可重建）。

> 防误用提示：A15 是实施前门禁，不是愿景章节；每一条都必须映射到具体文件和测试项。

---

## B1. [ARCHIVE] 历史正文（原文保留）

> **⛔ ARCHIVE 警告 — 搜索本文件时请忽略以下所有匹配**
>
> 以下内容仅供回溯，**不作为当前实现规范**。其中的数据模型 interface、服务接口、配置常量均为历史版本，与 CURRENT 部分存在字段名和结构差异（如 `parkingState` vs `state`、`reminderAt` vs `reminder`、`MAX_SNOOZE_COUNT: 3` vs `5`、`48h` vs `72h` 等）。**实现时必须以 A1-A15 为准**，不得直接引用 ARCHIVE 中的代码示例。
>
> 如需将 ARCHIVE 拆分为独立文件以减少搜索干扰，可移至 `docs/state-overlap-archive.md`。

<details>
<summary>展开历史版本原文（v1.0-v7.1 演进全文）</summary>

# State Overlap — 零阻力上下文切换策划案

> 版本：v7.1 | 日期：2026-02-22
> 状态：Draft
> 作者：NanoFlow Team
> v7.1 变更：**基于外部评审的八项修正**——(1) **分离"查看"与"切换"**：单击任务卡片=预览详情（不切换 Focus），双击/显式按钮"开始做"=切换 Focus 并停泊当前任务——浏览≠切换是基本约定；(2) **归档提示改为 Intent-based**：超限驱逐提示从 3 秒改为 Intent-based 消散（用户下次交互后消失），[撤回] 按钮最小 44×44px；(3) **闪烁时长调整为 1000ms**：200ms 不足以完成眼跳落地，改为 1000ms"亮起→保持→淡出"三段式动画；(4) **超限策略改为基于时间**：废弃 `MAX_PARKED_TASKS=5` 硬限制（Miller's Law 不适用于外部化列表），改为 48 小时未访问自动清理 + 软上限 15 警告；(5) **Mission Control 改为常驻侧边栏**：停泊任务列表始终可见，废弃弹窗式 Mission Control——用户随时可切换，无需流程触发；(6) **提醒增加 Snooze**：提醒到达时增加"5 分钟后再提醒"按钮，解决"用户正忙无法立刻处理"的场景；(7) **滚动位置改为内容锚点**：废弃像素级 `scrollTop` 保存（跨设备回流失效），改为基于内容锚点（段落/行号）+ 百分比回退；(8) **产品叙事重新定位**：从"注意力经纪人"调整为"零阻力上下文切换"——承认系统边界是物理上下文保存/恢复，认知上下文重建交给用户
> v7.0 变更：**做减法到最小内核**——基于真人使用视角全量审查，承认 v3.0-v6.0 陷入了"用规则堵规则"的复杂度螺旋。v7.0 执行七项根本性削减：(1) **状态二元化**：废弃孵化器/切片/冷冻/孵化完成五级流转，仅保留"当前"和"稍后"两个状态——映射用户真实心智模型"我在做的"和"我没在做的"；(2) **自动停泊替代入舱仪式**：用户切换任务时系统自动保存上下文，无需"送入孵化器"主动操作——因为被打断的用户不会执行仪式；(3) **砍掉 Checkpoint/Metronome 子系统**：用简单可选提醒替代复杂的锚点监控——大部分知识工作任务没有明确阶段；(4) **砍掉截图系统**：删除 html2canvas 依赖、base64 存储、模糊缩略图——60×80px blur(4px) 的色块辨识价值趋近于零；(5) **砍掉关键词推断**：删除 OverlapAttributionService 的规则链——NLP 关键词匹配被自然语言歧义击败，改为仅两个用户选项"需要回来"/"放着就行"；(6) **预热极简化**：合并 instant+gentle 为统一行为（闪烁最后编辑位置），删除 Memory Aid Panel——如果用户需要回忆，他自己会看内容；(7) **MVP 优先**：路线图从 6 周压缩到 2 周最小内核，用真人反馈驱动迭代而非纸面推演
> v6.0 变更：基于真人用户体验审查的五项「人性化优先」修正——(1) 意图消散柔化（Soft Dismissal）：恢复 Escape 键关闭 + 点击空白关闭 + 10 秒无操作自动淡出，消除"UI 粘手"强迫症；(2) 透明归档（Transparent Archival）替代静默冷冻：冻结时底部状态栏闪现 1.5 秒微提示，消除"任务失踪"恐慌；(3) 全屏遮罩降级为侧栏记忆辅助面板（Memory Aid Panel）：不遮挡主内容，用户可直接操作或查看辅助面板；(4) Mission Control 图文并茂：保留结构化锚点文字 + 恢复模糊缩略图作为视觉底纹，发挥人类空间记忆优势；(5) 活跃度推断极简化 + 伴随模式自动化：接受软件局限性，废弃贝叶斯评分模型，简化为"有无微操作"二元判定 + 自动检测多屏场景（无需用户理解"伴随模式"概念）
> v5.0 变更：极端压力测试下的三项"反人类本能"修正——(1) Intent 信号净化：剔除 mousedown/keydown 等"盲点动作"（Blind Click），收束为 input/compositionstart、scroll>30px、selectionchange 三个真正的内容交互信号；(2) 锚点临近度退级（Proximity Fallback）：结构锚点距光标 > 30 行时自动附加局部微观纹理（当前行前 15 字符）；(3) 静默冷冻（Silent Hibernation）：废弃挂起切片软限制弹窗，系统自动将最久闲置的切片静默平移到孵化器底部
> v4.0 变更：从"Timer-driven"到"Intent-driven"的范式跃迁——消灭所有倒计时驱动的交互，以用户的下一个实质性动作作为唯一消散信号；引入 Companion Mode（伴随模式）解决多屏工作者的 blur 误判；结构化锚点（Structural Anchors）替代 NLP 语义推断；全局 IntentDismissalService 统一管理意图消散
> v3.0 变更：深度压力测试后的四项关键修正——记忆衰减曲线、多维活跃度检测、推断纠错窗口、语义签名导航
> v2.0 变更：基于认知心理学审视，解决四大实操陷阱（上下文预热、零配置入舱、视觉静默、自由切片）

---

## 目录

1. [设计背景与核心理念](#1-设计背景与核心理念)
2. [v2.0 设计演进：四大认知陷阱的破解](#2-v20-设计演进四大认知陷阱的破解)
2.5. [v6.0 设计演进：人性化优先的五项核心修正](#25-v60-设计演进人性化优先的五项核心修正)
2.7. [v7.0 设计演进：做减法到最小内核](#27-v70-设计演进做减法到最小内核)
2.8. [v7.1 设计修正：基于外部评审的八项改进](#28-v71-设计修正基于外部评审的八项改进)
3. [与现有架构的关系](#3-与现有架构的关系)
4. [数据模型设计](#4-数据模型设计)
5. [状态管理设计](#5-状态管理设计)
6. [服务层架构](#6-服务层架构)
7. [UI 交互设计](#7-ui-交互设计)
8. [核心流程时序](#8-核心流程时序)
9. [配置常量](#9-配置常量)
10. [实施路线图](#10-实施路线图)
11. [风险评估与规避](#11-风险评估与规避)
12. [验收标准](#12-验收标准)

---

## 1. 设计背景与核心理念

### 1.1 问题陈述

传统任务管理工具对所有任务一视同仁——无论它是需要深度思考的代码编写，还是只需点击"开始"就能自动运行的测试脚本。用户被迫在列表间频繁切换，打断了最珍贵的资源：**连续注意力**。

### 1.2 隐喻：烹饪模型

做一道大餐时，厨师不会站在煮汤的锅前干等 30 分钟。他会：
- 把汤放上炉子（**后台任务**）
- 转身切菜（**前台任务**）
- 听到汤快溢出时才回头转小火（**锚点触发**）
- 切完菜后检查汤的状态（**主动轮询**）

这不是"多线程并发"（那意味着同时切菜和搅汤），而是**状态重叠（State Overlap）**——利用一件事的等待时间去推进另一件事。

### 1.3 核心价值

> **State Overlap 是一个"零阻力的任务上下文保存/恢复"工具。**
>
> v7.1 定位澄清：系统能做到的是——零阻力地保存和恢复**物理上下文**（光标、滚动位置、编辑位置）。系统做不到的是——辅助**认知上下文**（思路、问题、情境）的重建。认知上下文的恢复应交给用户自己——他看一眼内容就知道自己在干什么。未来路线图保留 LLM 摘要集成作为跨越这一鸿沟的技术手段。

它帮用户：
1. **保存** 切走时的物理上下文（光标位置、滚动位置、编辑状态），零用户操作
2. **恢复** 切回时的物理上下文，一键回到离开的准确位置
3. **导航** 在多个停泊任务间自由切换，无 LIFO 约束
4. **提醒** 可选的定时提醒（含 Snooze），帮助用户记得回到搁置的任务

---

## 2. v2.0 设计演进：四大认知陷阱的破解

> **核心认知**：v1.0 在技术架构和数据结构上无懈可击，但在处理人的"软性属性"（懒惰、遗忘、视觉易扰性、抗拒被控制）时过于理性。v2.0 针对四大实操陷阱逐一破解，核心策略是**"视觉克制"和"推断自动化"**。

### 2.1 陷阱一：机器快照 ≠ 大脑快照

**问题本质**：`ContextSnapshotService` 能在 100ms 内恢复光标和滚动位置，但人脑的工作记忆（Working Memory）重建需要 10-15 分钟。`resumeNote` 依赖用户在"救火"紧迫感下手动书写，悖于人性。

**v2.0 解决方案：上下文预热（Context Warm-up）**

系统默认假设用户**"记不住切走前在干嘛"**，回弹时自动展示预热层。

**v3.0 修正：引入记忆衰减曲线（Memory Decay Function）**

> **v2.0 的陷阱**：预热遮罩是二极管——无论离开 15 秒还是 15 分钟，一律弹出完整遮罩要求点击"我想起来了，继续"。这在短暂切走（如点击合并 PR 后秒回）时会制造不必要的物理阻力，引发暴躁。
>
> **v3.0 核心修正**：Warm-up 响应强度基于 `absentDuration`（离开时长）动态分级——遵循艾宾浩斯遗忘曲线（Ebbinghaus Forgetting Curve），短时记忆在 2 分钟内几乎无衰减，2-15 分钟为快速衰减窗口，15 分钟后需要完整重建。

**三级预热响应（Memory Decay Tiers）**：

| 离开时长 | 预热级别 | 系统行为 | 认知心理学依据 |
|---------|---------|---------|--------------|
| **< 2 分钟**（短时切换） | `instant` | **不弹遮罩**。直接秒回，最后修改的行微微闪烁一次（200ms 黄色脉冲后淡出），无任何点击要求 | 短时记忆（Short-term Memory）保持期约 15-30 秒，但有复述效应（Rehearsal Effect）——2 分钟内工作记忆几乎无衰减 |
| **2 - 15 分钟**（中度遗忘） | `gentle` | 展示**轻量化预热条**（非全屏遮罩），底部 60px 半透明浮层，显示："离开 X 分 → 最后停在：[结构化锚点]"。**不设自动倒计时**——直到用户执行首次恢复动作（敲击键盘、实质性滚动、点击编辑区域）后安静淡出，或点击预热条上的"✕"手动关闭 | 中度工作记忆衰减——用户需要一个轻推（Nudge）找回方向，但阅读速度因人而异，**不应由秒表决定信息消失的时机** |
| **> 15 分钟**（深度遗忘） | `full` | 展示**完整预热遮罩**，包含操作轨迹时间线 + 变更高亮 + 离开时长 + 模糊截图。用户必须点击"我想起来了，继续"才能恢复，确保大脑完成重建 | 工作记忆已基本丢失（15 分钟后遗忘率 > 75%），需要完整的情景记忆线索触发才能重建思维脉络 |

**完整预热遮罩组件（仅 `full` 级别展示）**：

| 预热组件 | 内容 | 认知心理学依据 |
|---------|------|--------------|
| **操作轨迹时间线** | 切走前最后 5 分钟的操作摘要（编辑了哪些段落、滚动到了哪里） | 情景记忆（Episodic Memory）线索触发——看到"自己做过的事"比看到"光标在哪"更能唤醒思维脉络 |
| **变更高亮** | 切走前最后修改的 3 行内容，以黄色背景高亮 2 秒后淡出 | 视觉锚定（Visual Anchoring）——让眼睛先"落地"，避免茫然扫视 |
| **离开时长提示** | "你离开这个任务已经 X 分 Y 秒" | 时间感校准——帮用户判断"我需要花多久重新进入状态" |
| **自动截图** | 切走瞬间对 Focus Arena 截取一张模糊化的缩略图，回弹时先闪现再淡入真实内容 | 视觉连续性（Visual Continuity）——大脑通过"画面相似性"快速重建空间记忆 |

**关键设计决策**：
- **废弃 `resumeNote` 的手动输入要求**——改为纯自动化采集，用户零操作负担
- **保留 `resumeNote` 为可选备注**——不作为核心依赖，仅在用户主动点击"备注"时出现
- **`absentDuration` 由 `ContextWarmUpService` 在 `restoreWithWarmUp()` 时实时计算**（离开时长 = 当前时间 - `snapshot.savedAt`）
- **级别阈值可通过 `OVERLAP_CONFIG.MEMORY_DECAY` 调整**，为未来个性化学习（Phase 4）预留接口
- 所有级别的预热层均可被任意键盘/鼠标操作立即消散，不阻塞工作

**v4.0 关键修正：废弃 Gentle 级别的 2 秒自动消散**

> **v3.0 的陷阱**：离开 10 分钟后，用户端着咖啡坐下点击回弹。眼睛还在寻找屏幕焦点，刚定睛看向底部预热条——"我刚才到底在干嘛？"——刚读几个字，预热条"唰"地 2 秒后自动消失。一条帮助回忆的信息，反而变成了一次"眼皮子底下的消失"，强烈的挫败感。
>
> **v4.0 核心修正**：凡涉及"阅读"的 UI 元素（尤其是帮助回忆的文字），**绝对不用自动计时器去销毁它**。Gentle 级别本意是轻推，不应有时间压迫感。预热条静静停在底部，直到用户执行了明确的**恢复意图动作**——开始打字、实质性滚动、点击编辑区域——它才安静淡出。这代表用户"已经找回方向，准备继续"。
>
> 这是 v4.0 "Timer-driven → Intent-driven" 范式转换的第一个落地点。消散不再由秒表驱动，而由**用户的下一个实质性动作**决定。
>
> 技术实现：由全局 `IntentDismissalService` 统一管理，gentle 预热条注册为 `dismissible` 元素，监听 `input` / `compositionstart` / `scroll(deltaY > 30px)` / `selectionchange(span > 0)` 信号后触发淡出。
>
> **v5.0 信号净化（Blind Click 修正）**：v4.0 使用 `keydown` / `mousedown` 作为意图信号，但两者都会产生"盲点动作"假阳性——用户切窗后随手点一下唤醒窗口（`mousedown`），或按下 Shift/Ctrl 切换输入法（`keydown`），这些行为并不代表用户已经读完预热信息、准备继续工作。v5.0 将意图信号收束为**纯内容交互边界**：
> - `input` / `compositionstart`：用户真正开始输入内容（含中文输入法 composing 阶段）
> - `scroll(deltaY > 30px)`：实质性滚动（非鼠标微抖）
> - `selectionchange(selection.toString().length > 0)`：用户主动划选了文本
> - `touchstart`（移动端保留）：移动端没有"盲点击"问题，触摸即代表有意交互
>
> 原则：**只有产生了内容副作用的动作，才算用户"已进入下一状态"的证据。**

### 2.2 陷阱二：配置项过载——Zero-Config 入舱

**问题本质**：要求用户在送入孵化器前手动选择 `cognitiveLoad`、`blockingType`、`estimatedDuration` 等属性，80% 的用户会因此放弃使用。

**v2.0 解决方案：OverlapAttributionService 提升为系统绝对核心**

**入舱操作简化为单一手势**：拖拽任务卡片到侧边区域 / 右键菜单点击"送入孵化器" / 长按后滑向右侧。**零表单、零选择、零等待**。

所有属性由 `OverlapAttributionService` 自动推断：

| 推断规则 | 输入信号 | 输出 | 准确度策略 |
|---------|---------|------|-----------|
| 标题含"等待/waiting/等/pending" | `task.title` + `task.content` | `blockingType: 'asynchronous'`，`estimatedDuration: null`，锚点: `manual` | 关键词匹配 + 同义词扩展 |
| 标题含"编写/写/review/开发" | `task.title` | `cognitiveLoad: 'deep'`，`blockingType: 'synchronous'` | 高认知动词识别 |
| 内容包含 URL | `task.content` | 自动创建 `manual` 锚点，标签为"链接内容就绪时" | URL 检测 |
| 标题含数字+时间单位（"跑 10 分钟"） | `task.title` | `estimatedDuration` 自动提取，创建 `timer` 锚点 | 正则提取 |
| 任务有 `dueDate` 且 < 24h | `task.dueDate` | `urgencyLevel` 提升 | 时间差计算 |
| 历史行为：用户过去对类似任务的属性 | 用户历史数据 | 加权推断 | Phase 4 逐步引入 |
| 无法推断 | 兜底 | `cognitiveLoad: 'moderate'`，`blockingType: 'semi-async'`，`estimatedDuration: null` | 安全默认值 |

**关键设计决策**：
- **`TaskOverlapMeta` 中所有字段改为可选**——未推断出的字段不填充，不影响系统运行
- **无估时 = 无进度条**——未设置 `estimatedDuration` 的任务只显示静态状态图标，不制造虚假进度感
- **后置可调**——用户可随时打开属性面板微调，但绝不强制前置填写
- **预设模板保留**——作为"一键快捷方式"而非"必选项"

**v3.0 修正：推断置信度反悔期（Inference Correction Toast）**

> **v2.0 的陷阱**：NLP 和启发式规则永远有推断错误的时候。当系统把一个极其紧急的"等待老板批复"推断成了普通的 async 任务扔到角落时，用户需要一种极其本能、无需进入二层菜单的纠错机制。
>
> **v3.0 核心修正**：在任务被一键送入孵化器的瞬间，在屏幕边缘提供一个转瞬即逝的微型纠错浮层（Correction Toast），让用户在推断发生的当下就能以最小成本推翻机器的决定。

**Correction Toast 机制**：

```
任务送入孵化器后，屏幕底部右侧出现微型浮层（不设自动倒计时，
直到用户在 Focus Pod 中执行首次实质性动作后安静消散）：

┌──────────────────────────────────────────────────┐
│  ✅ 已送入 → [后台等待]  ⏱ 预计 ~10 分钟         │
│  📌 锚点: 手动触发                    [修改 ✏️]   │
└──────────────────────────────────────────────────┘
                                    ↑
                              点击 [修改] 展开为：
┌──────────────────────────────────────────────────┐
│  类型: [后台等待 ▾] [深度工作 ▾] [间歇介入 ▾]      │
│  时长: [无限期 ▾] [5min] [10min] [30min] [自定义] │
│  锚点: [手动 ▾] [定时 ▾]                          │
│                              [确认] [撤回入舱]    │
└──────────────────────────────────────────────────┘
```

**交互规则**：

> **v4.0 核心修正：从 Timer-based 到 Intent-based 消散**
>
> **v3.0 的陷阱**：用户刚执行"送入孵化器"，本意是清空大脑、将注意力全盘转移到 Focus Pod 的新任务上。3 秒倒计时的 Toast 等于在喊："嘿！你快看看推断对不对，3 秒后我就定稿了！"——这把用户正在转移的注意力硬拽了回来，3 秒变成焦虑的倒计时。
>
> **v4.0 核心修正**：放弃基于墙上时间的自动消散。Toast 出现后**不设倒计时**，直到用户在 Focus Pod 中执行**首次实质性动作**——敲下第一个按键、发生首次实质性滚动（`deltaY > 30px`）或点击编辑区域——它才安静淡出。这代表用户"已经完全进入下一个状态，确认不再纠错"。
>
> 人是按**状态切换**来感知世界的，不是按秒表。当用户开始在 Focus Pod 中打字时，他的注意力已经完成转移——这个**行为信号**比任何倒计时都更精确地标记了"纠错窗口结束"的时刻。

- **Intent-based 消散**：用户在 Focus Pod 中执行首次内容交互信号（`input` / `compositionstart` / scroll `deltaY > 30px` / `selectionchange` span > 0）→ Toast 安静淡出，推断结果生效
- **hover 即驻留**：鼠标 hover 到 Toast 上时排除下一次意图动作的消散判定（用户正在审阅推断结果）
- **[修改] 一键展开**：点击后原地展开为紧凑修正面板，操作完成后关闭
- **[撤回入舱]**：终极后悔药——将任务从孵化器中取回，恢复原状态
- **置信度可视化**：推断置信度低于 `medium` 时，[修改] 按钮以蓝色高亮提醒用户"系统不太确定"
- **移动端**：Toast 改为底部全宽 Snackbar，[修改] 改为 [⬆ 上滑修改]
- **技术实现**：由全局 `IntentDismissalService` 统一管理，Toast 注册为 `dismissible` 元素，监听 Focus Pod 区域内的内容交互信号（v5.0 净化后：`input` / `compositionstart` / `scroll` / `selectionchange`）

### 2.3 陷阱三：视觉噪音——静默侧边栏设计

**问题本质**：动态进度条持续吸血周边视觉；基于时间的 Alert Escalation 在用户处于心流状态时仍会升级为红色脉冲，变成"催命闹钟"。

**v2.0 解决方案：视觉静默原则（Visual Silence Principle）**

**核心规则：侧边栏在未触发锚点前，必须是绝对静态的。**

| v1.0 设计 | 问题 | v2.0 改进 |
|-----------|------|-----------|
| `████░░░░ 53%` 动态进度条 | 周边视觉持续被动画吸引 | **废弃进度条**，改为**静态状态图标**（⏳ 孵化中 / ⏸ 暂停 / ✅ 完成） |
| 剩余时间倒计时文字 | 每分钟更新制造焦虑 | **仅在 hover 时显示**预计剩余时间，平时只显示图标 |
| calm→notice→alert 基于时间自动升级 | 心流状态被无条件打断 | **引入焦点抑制（Focus Suppression）**——检测到用户在键盘/鼠标操作时，锁定 `suppressed` 状态 |

**焦点抑制机制（Focus Suppression）**：

```
用户状态检测               提醒状态
────────────              ──────
用户在输入/操作（active）  → 所有提醒锁定为 `suppressed`（视觉零变化）
用户静止 > 阈值（idle）    → 提醒解除抑制，按原有逻辑显示
用户主动查看侧边栏          → 正常显示所有状态

升级规则调整：
- 升级计时器在 `suppressed` 状态下**暂停**
- 仅在用户处于 `idle` 状态时才累计升级时间
- 即 calm→notice 的"5 分钟"是 5 分钟的**空闲时间**，不是 5 分钟的**墙上时间**
```

**v3.0 关键修正：多维心智活跃度检测——"真 idle" vs "假 idle" 的精准划界**

> **v2.0 的致命漏洞**：`USER_IDLE_THRESHOLD = 30s` 仅依据键盘/鼠标事件判定 idle。但在"阅读技术文档"或"盯着代码推演逻辑"时，用户可能双手离开键盘沉思 3 分钟——此时大脑处于极高负载的心流状态。如果仅因"30 秒无输入"就判定为 idle 并解除提醒抑制，等于**用一个极其粗糙的物理信号去判断极其精密的心智状态**，这会对正在重度用脑的用户造成毁灭性打击。
>
> **核心问题**：在不引入眼动追踪等重度硬件的前提下，如何在纯软件逻辑层面区分"真 idle（发呆/离开）"与"假 idle（深度阅读/沉思）"？

**v3.0 解决方案：三层推断模型（Three-Layer Inference Model）**

单一的键鼠事件远远不够。我们需要用**多个弱信号叠加**来逼近一个强判断——借鉴贝叶斯推断的思路，每个维度单独准确率不高，但叠加后置信度大幅提升。

**第一层：微操作信号捕获（Micro-Interaction Signals）**

键盘敲击只是"操作"的冰山一角。深度阅读/思考虽然不产生键盘事件，但人体绝非完全静止——这些微操作可以被捕获：

| 微操作信号 | 检测方式 | 含义 |
|-----------|---------|------|
| **极微滚动** | `scroll` 事件，`deltaY` < 50px | 读到段落末尾时的小幅滚动——人在阅读 |
| **无意识鼠标移动** | `mousemove` 节流后检测 `distance > 5px` | 思考时手自然搭在鼠标上的微幅移动——人在座位上 |
| **文本选中** | `selectionchange` 事件 | 阅读时标记关键词——高度活跃的阅读行为 |
| **浏览器标签切换** | `visibilitychange` API | 标签页被切走 → 高置信度判定为真正离开 |
| **窗口失焦** | `blur` / `focus` 事件 | NanoFlow 窗口不在前台 → **需结合 Companion Mode 判定**（见 v4.0 修正） |
| **页面可见性** | `document.visibilityState` === `'hidden'` | 标签页被最小化或切走 → **立即判定**为真 idle |

**关键规则**：**任何**上述微操作信号都应重置 idle 计时器——不仅仅是键盘和鼠标点击。

**第二层：认知上下文推断（Cognitive Context Inference）**

不同类型的任务有截然不同的"沉默期特征"。系统不应对所有任务使用统一的 30 秒阈值——而应根据当前 Focus Pod 任务的认知属性动态调整阈值：

| 认知上下文 | 判定依据 | idle 阈值 | 理由 |
|-----------|---------|-----------|------|
| **deep（深度认知）** | `overlapMeta.cognitiveLoad === 'deep'`，或标题含"阅读/设计/构思/review/分析" | **5 分钟** | 深度阅读/设计时，沉默 3-5 分钟是正常的认知行为 |
| **moderate（中度认知）** | 默认值，或标题含"修改/调整/优化" | **2 分钟** | 中度任务偶尔思考，但不会长时间沉默 |
| **shallow/passive（浅度/被动）** | `overlapMeta.cognitiveLoad` 为浅度或被动 | **30 秒**（原始值） | 被动任务下长时间无操作大概率是真正离开 |
| **无分类** | `overlapMeta` 未设置 | **1 分钟** | 保守中间值 |

```typescript
// 动态 idle 阈值计算
function getDynamicIdleThreshold(focusTask: Task): number {
  const cognitiveLoad = focusTask.overlapMeta?.cognitiveLoad;
  switch (cognitiveLoad) {
    case 'deep':    return 300_000;  // 5 分钟
    case 'moderate': return 120_000;  // 2 分钟
    case 'shallow':
    case 'passive':  return 30_000;   // 30 秒
    default:         return 60_000;   // 1 分钟
  }
}
```

**第三层：离席置信度综合判定（Absence Confidence Score）**

将前两层信号综合为一个 `absenceConfidence` 评分：

| 信号 | 权重 | 判定 |
|------|------|------|
| `document.visibilityState === 'hidden'` | **100%** | **立即判定**——标签页不可见 = 人物理上不在看，是最高置信度的 idle 信号 |
| `window.blur` 持续 > 10 秒（**仅在非 Companion Mode 下**） | **60%**（v4.0 从 90% 降至 60%） | 窗口失焦未必代表离席——可能在切换到同屏应用；**Companion Mode 下此信号权重降至 0%** |
| 无任何微操作 > 动态阈值 | **70%** | 超过认知上下文调整后的阈值无微操作 |
| 无鼠标移动 > 动态阈值 × 2 | **+20%** | 叠加因子——连鼠标都没动，人可能真的离开了 |
| 有微滚动或鼠标微移 | **-50%** | 降低因子——有微操作说明人在，只是在思考 |

**综合规则**：
- `absenceConfidence >= 80%` → 判定为 `idle`，解除提醒抑制
- `absenceConfidence < 80%` → 维持 `active`，保持 Focus Suppression
- `document.visibilityState === 'hidden'` → 跳过评分，**直接判定** idle（这是唯一的硬判定信号）

**v4.0 关键修正：伴随模式（Companion Mode）——多屏工作者的救生圈**

> **v3.0 的致命盲区**：`window.blur > 10s` 赋予 90% 的极高离席置信度，完全忽略了现代核心用户（开发者、设计师）的双屏/多屏工作流。
>
> **真实场景**：用户在左屏的 IDE 里敲代码，右屏挂着 NanoFlow 查看需求和后台任务状态。此时 NanoFlow 处于持续的 `blur`（失焦）状态，但它是清晰可见且正在被大脑处理的。按 v3.0 逻辑，用户在 IDE 里写代码超过 10 秒，NanoFlow 就会判定"你不在了"，开始在余光里闪铃铛——这会让双屏用户精神崩溃。
>
> **本质矛盾**：在浏览器沙盒限制下，无法获取"NanoFlow 窗口是否在另一个显示器上可见"的信息。`window.blur` 只能告诉我们"窗口不在前台"，但无法区分"被最小化到任务栏"和"在另一块屏幕上清晰可见"。
>
> **v4.0 解决方案：Companion Mode（伴随模式）**
>
> 允许用户显式开启"伴随模式"——声明"我在多屏环境下使用 NanoFlow"。在此模式下：
>
> 1. **废弃 `window.blur` 的高权重**——blur 信号的离席置信度权重**从 60% 降至 0%**
> 2. **仅 `visibilityState === 'hidden'` 作为唯一硬信号**——只有标签页被最小化或切走时才判定 idle
> 3. **补偿机制：鼠标 Re-entry 探测**——在 Companion Mode 下，如果 NanoFlow 窗口虽然处于 blur 状态，但鼠标偶尔滑过窗口区域（`mouseenter` 事件），则重置 idle 计时器。这是**"视线停留（Gaze Surrogate）"**的最佳软件模拟——用户用余光看 NanoFlow 时，手通常会偶尔划过
> 4. **智能提示**：如果系统检测到用户频繁从 blur 状态快速切回（< 3s blur → focus 循环 > 5 次/30 分钟），自动建议开启 Companion Mode

**Companion Mode 在非多屏场景下的安全性**：
- 即使非多屏用户误开了 Companion Mode，`visibilityState === 'hidden'` 依然是 100% 置信度的硬信号——用户真正切走标签页时系统仍能正确响应
- 唯一的功能退化：窗口仅失焦（不隐藏）时 idle 检测变慢，需要等到动态阈值（如 5 分钟深度认知阈值）才能判定——这是一个安全的、宁可漏报也不要误报的权衡

**这套模型为什么能在没有眼动追踪的情况下工作？**

> 关键洞察：我们不需要"判断用户在看什么"（那需要眼动追踪），我们只需要"判断用户是否还在设备前"。而后者可以通过**排除法**实现——如果窗口在前台（或 Companion Mode 下鼠标偶尔滑过）+ 有微操作 + 任务属性暗示深度思考，那么极高概率用户还在。只有当这三个维度**同时为空**时，才能有足够置信度判定为 idle。
>
> 这本质上是从"证明用户在思考"（不可能）转变为"排除用户已离开"（可行）的范式转换。

**v2.0 卡片视觉设计**：

```
┌─────────────────────────┐
│ ⏳  后台编译              │  ← 静态图标 + 精简标题
│                          │  ← 无进度条，无百分比
│ 📌 下一锚点：部署到测试   │  ← 仅在有锚点时显示
│ [切换]                   │  ← 微型操作按钮
└─────────────────────────┘

锚点触发后：
┌─────────────────────────┐
│ 🔔 后台编译              │  ← 图标变为铃铛（静态，非动画）
│ 锚点已到达               │  ← 一行文字提示
│ [切换处理] [稍后]        │  ← 操作按钮
└─────────────────────────┘
```

### 2.4 陷阱四：暂存栈死锁——自由切片（Free Slices）模型

**问题本质**：Stack (LIFO) 在 3 层嵌套时制造认知失调；硬限制"栈已满"让工具"教用户做事"。

**v2.0 解决方案：从"暂存栈"重构为"挂起切片（Suspended Slices）"**

**核心改变**：
- **废弃 Stack 语义**——不再有 push/pop 和后进先出约束
- **引入 Slices**——所有离开 Focus Pod 的任务平等地进入"挂起切片"列表，每个切片保存独立的上下文快照
- **自由跳转**——用户可以从任意切片直接恢复，不必遵守顺序
- **Mission Control 视图**——当挂起切片 >= 2 个时，`bounceBack()` 不再直接跳回"上一个"，而是弹出一个轻量级的**全景选择面板**

**v3.0 修正：语义签名（Semantic Signatures）替代视觉截图**

> **v2.0 的陷阱**：Mission Control 面板使用 Focus Arena 的模糊截图作为切片的缩略预览。但如果挂起的 3 个任务分别是"写需求文档 A"、"改代码 B"和"写邮件 C"，它们在模糊截图下的视觉特征是高度趋同的（都是一坨带字的白底区块）。用户很难通过模糊截图一眼分辨出哪个是哪个。
>
> **v3.0 核心修正**：在 Mission Control 中，相比于截图，更有效的识别锚点是**"增量特征"**——即用户切走前"正在做什么"的语义签名。这比毫无特征的文本区块模糊图要高效得多。

**v4.0 关键修正：结构化锚点（Structural Anchors）替代 NLP 语义推断**

> **v3.0 的陷阱**：从纯前端捕获的操作轨迹（如"编辑了 42-45 行"）自动生成高度概括性的语义（"配置连接池"），如果不借助重度的大语言模型实时分析，纯靠规则提取，生成的极大概率是**工业废气**——"最后停在：删除了一个逗号"、"最后停在：滚动到了第 8 段"。这种无意义的签名不仅不能帮大脑预热，反而引发认知困惑：用户盯着签名想了 3 秒，"我删了个逗号？那又怎样？"
>
> **v4.0 核心修正**：不要试图让机器去"理解"用户的操作。改用**结构化锚点（Structural Anchors）**——从内容的**结构特征**中提取人类天然能理解的定位信息，再附加最后的物理动作：
>
> **Structural Anchor = [结构锚点] + [物理动作]**
>
> 这既不需要复杂的 NLP，又能精准唤醒位置记忆。

**结构化锚点提取规则（按内容类型分层）**：

| 内容类型 | 结构锚点来源 | 提取方法 | 示例 |
|---------|------------|---------|------|
| **Markdown 文档** | 最近的 Heading（H2/H3） | 从光标位置向上搜索最近的 `##` / `###` 标题 | "在『数据库设计』一节中编辑" |
| **代码** | 当前光标所在的 Function / Class / Method 名称 | 解析代码结构（简易正则匹配 `function xxx` / `class xxx` / `xxx()` ） | "在 `connectDB()` 中编辑" |
| **列表/大纲** | 最近的顶级列表项序号或内容 | 从光标位置向上搜索顶级 `- ` / `1.` 条目 | "在第 3 条待办项附近编辑" |
| **纯文本** | 段落序号 + 首句关键词（前 15 字符） | 计算光标所在段落的序号 | "在第 5 段『用户认证流程…』附近" |
| **GoJS Flow** | 当前选中/最后编辑的节点名称 | 从 GoJS 模型数据中提取 `node.text` | "在节点『审批流程』附近编辑" |
| **兜底** | 任务标题前 30 字符 | `task.title.substring(0, 30)` | "在『优化首页加载速度…』中" |

**v5.0 新增：锚点临近度退级（Proximity Fallback）**

> **v4.0 的盲区**：当光标距离最近的结构锚点超过 30 行时（例如一个 800 行的 `processData()` 函数），提取到的锚点名称过于宽泛——"在 `processData()` 中编辑"对用户而言等于"在某个巨大函数里的某处"，唤醒精度大幅退化。
>
> **v5.0 核心补丁**：当 `cursorLine - anchorLine > PROXIMITY_LINE_THRESHOLD(30)` 时，在结构锚点后附加**局部微观纹理**——当前行的前 15 个字符。这不需要"理解"代码含义，只需将用户眼前的文字喂给他的视觉记忆即可触发"啊对，就是那里"的瞬间唤醒。

| 光标-锚点距离 | 行为 | 示例 |
|-------------|------|------|
| ≤ 30 行 | 仅输出结构锚点（高精度） | "在 `connectDB()` 中编辑" |
| > 30 行 | 结构锚点 + 微观纹理 | "在 `processData()` 内部，修改了『 let userAuthToken = ... 』" |
| 无结构锚点 | 兜底签名 + 微观纹理 | "在『优化首页加载速度…』中，修改了『 const retryCount = ... 』" |

**微观纹理规则**：
- 取当前光标所在行的前 15 个非空字符（`line.trim().substring(0, 15)`）
- 以 `『...』` 包裹，附加 `"修改了"` 动作标签
- 若行内容为空或 < 3 字符，跳过纹理附加（退化为纯结构锚点）

**物理动作标签**：

| 最后操作类型 | 标签 |
|------------|------|
| `edit` | "编辑" |
| `scroll` | "阅读" |
| `select` | "选中" |
| `navigate` | "浏览" |
| 无操作轨迹 | "停留" |

**组合签名格式**：`"最后停在：在 [结构锚点] [物理动作]"`

**示例对比**：

| 场景 | v3.0 NLP 推断（不可靠） | v4.0 结构化锚点（确定性） |
|------|----------------------|------------------------|
| 编辑代码第 42 行 | "最后停在：配置数据库连接池" ❓ | "最后停在：在 `connectDB()` 中编辑" ✅ |
| 滚动到文档第 3 章 | "最后停在：滚动到了第 8 段" 😑 | "最后停在：在『认证流程设计』一节阅读" ✅ |
| 在大纲中修改第 5 项 | "最后停在：删除了一个逗号" 🤦 | "最后停在：在第 5 条待办项附近编辑" ✅ |
| 在 Flow 图中编辑节点 | "最后停在：修改了一个节点" 😶 | "最后停在：在节点『审批流程』附近编辑" ✅ |

**关键设计决策**：
- **零 NLP 依赖**——所有提取均基于结构特征的正则匹配或 DOM/Model 位置查找，100% 确定性输出
- **结构锚点的"辨识度"远高于操作描述**——人脑记住的是"我在写数据库那一节"而不是"我删了个逗号"
- **提取失败的优雅降级**——如果无法找到结构锚点（如空白文档），回退到 `task.title` 前 30 字符

**Semantic Signature 完整组成（v4.0 更新）**：

| 签名组件 | 来源 | 示例 |
|---------|------|------|
| **结构化锚点签名** | 内容结构特征 + 最后物理动作 | "最后停在：在 `connectDB()` 中编辑" |
| **任务图标 + 颜色标签** | 任务类型推断（文档=📝 代码=💻 沟通=💬 数据=📊） | 📝 蓝色标签 |
| **挂起时长** | `suspendedAt` 与当前时间差 | "挂起 3 分钟" |

**Mission Control 全景面板（v4.0 — 结构化锚点版）**：

```
┌──────────────────────────────────────────────────┐
│  选择要恢复的任务：                                │
│                                                  │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ │
│  │ 📝 写需求文档    │ │ 💻 修复测试     │ │ 💬 回复邮件     │ │
│  │                 │ │                 │ │                 │ │
│  │ "最后停在：      │ │ "最后停在：      │ │ "最后停在：      │ │
│  │  在『验收标准』   │ │  在 fixTimeout()│ │  在第 3 段      │ │
│  │  一节编辑"      │ │  中编辑"        │ │  『部署方案…』   │ │
│  │                 │ │                 │ │  附近编辑"       │ │
│  │ 挂起 3 分钟     │ │ 挂起 8 分钟     │ │ 挂起 1 分钟     │ │
│  │ [恢复]          │ │ [恢复]          │ │ [恢复]          │ │
│  └────────────────┘ └────────────────┘ └────────────────┘ │
│                                                  │
│                 [全部送入孵化器]                    │
└──────────────────────────────────────────────────┘
```

**与 v2.0/v3.0 方案的对比**：

| 维度 | v2.0 模糊截图 | v3.0 NLP 语义签名 | v4.0 结构化锚点 |
|------|-------------|------------------|---------------|
| 区分度 | 低——白底文本区块趋同 | 中——依赖 NLP 质量 | **高——结构特征天然独特** |
| 可靠性 | 高——截图不会出错 | **低——纯规则 NLP 产出"工业废气"概率高** | **高——基于结构正则，100% 确定性** |
| 认知负担 | 需要视觉解码模糊图像 | 文字直读（如果有意义的话） | **文字直读 + 直觉对应"我在哪"** |
| 记忆唤醒精度 | 低——"看起来像"不等于"想起来了" | 低——"删除了一个逗号"无法唤醒记忆 | **高——"在 connectDB() 中"精准定位工作上下文** |
| 存储开销 | 每张约 50-200KB | 约 200 字节 | 约 200 字节 |
| 离线友好度 | 截图可能因空间而失败 | 纯文本可靠 | 纯文本可靠 |
| 移动端适配 | 模糊截图在小屏上更难辨认 | 文字在任何屏幕上都可读 | 文字在任何屏幕上都可读 |
| NLP/LLM 依赖 | 无 | **高——不用 LLM 则质量极差** | **无——纯结构正则匹配** |

**设计决策：截图降级为可选辅助信息**：
- `screenshotDataUrl` 字段保留，但不再作为 Mission Control 的主要识别手段
- 截图仅在完整 Context Warm-up 遮罩（`full` 级别）中使用——用于视觉连续性的"画面重现"
- Mission Control 面板以结构化锚点签名为核心，截图作为 hover 时的额外预览（如有）

**规则**：
- 挂起切片数量限制为 `MAX_SUSPENDED_SLICES = 5`（去掉顺序约束后认知负担大幅降低）
- 当只有 1 个挂起切片时，`bounceBack()` 直接跳回（无需全景面板），体验与 v1.0 一致
- 当挂起切片 >= 2 时，显示 Mission Control 全景面板
- 切片超过 `MAX_SUSPENDED_SLICES`（5）个时，系统**自动静默冷冻（Silent Hibernation）**——将最久闲置的切片自动平移到孵化器底部，状态标记为 `paused/hibernated`。**不弹窗、不提示、不问用户**。一个顶级的注意力经纪人，绝不会在老板最忙的时候说"旧文件要不要帮你碎掉？"
- 每个切片的语义签名从内容**结构化锚点**自动提取（v4.0：Heading/Function/段落 + 物理动作），零额外操作

---

## 2.5 v6.0 设计演进：人性化优先的五项核心修正

> **核心反思**：v3.0-v5.0 的迭代走入了一个**"用极其复杂的规则去堵上一个规则的漏洞，从而产生更多规则"**的死胡同。系统试图用物理信号的数学组合来精确建模人类心智状态，但人类行为的混沌性、非理性和直觉性使得这个方向投入产出比急剧下降。
>
> **v6.0 的核心原则**：**宁可"笨"一点，也不能"烦"一点。** 接受软件对心智状态推断的固有局限，转而把精力集中在"万一推断错了，用户能以最低成本纠正"上。

### 2.5.1 修正一：意图消散柔化（Soft Dismissal）——消除"UI 粘手"

**v5.0 的问题**：

意图消散过于教条——预热条和纠错 Toast **只能**被"内容交互信号"（input/scroll>30px/selectionchange）消散。但用户"阅读和思考"本身就是一种意图，它不产生物理输入。用户切回来盯着屏幕看了 30 秒，已完全找回状态，但不需要打字或滚动。此时预热条像"牛皮癣"一样粘在底部（直到 60 秒兜底超时），迫使用户养成"切回来先无意义地滚一下滚轮"的强迫症肌肉记忆。

**这是系统在规训用户，而非服务用户。**

**v6.0 修正：三层消散通道（Three-Channel Dismissal）**

在保留 v5.0 内容交互信号的基础上，新增两个人类本能通道：

| 消散通道 | 触发方式 | 设计依据 |
|---------|---------|---------|
| **内容交互**（v5.0 保留） | `input` / `compositionstart` / `scroll>30px` / `selectionchange` | 用户开始操作内容 = 已进入下一状态 |
| **主动关闭**（v6.0 新增） | `Escape` 键 / 点击预热条 `✕` 按钮 / **点击空白区域** | 人类关闭弹窗的最直觉动作——"按 Esc" 和 "点掉它" |
| **无操作淡出**（v6.0 新增） | 10 秒无任何键鼠操作后自动 `opacity: 0` 淡出（200ms） | 用户看完了信息但不需要操作 = 信息已交付，UI 自行退场 |

**关键设计决策**：
- `Escape` 键是**全平台通用的"我看完了/我不要了"信号**——每个人都知道按 Esc 是"关闭"
- 点击空白区域关闭是**移动端和桌面端共通的直觉**——"点别的地方"="我完成了"
- 10 秒无操作淡出是**"阅读型用户"的救生圈**——读完预热信息后静静坐着思考的用户，不必被迫执行一个无意义的滚动或输入
- `maxLifetimeMs` 从 60 秒缩短为 15 秒——绝大多数场景 10 秒淡出已生效，15 秒是终极安全网
- **v5.0 的 `mousedown` 剔除仍保留**——盲点击（切窗回来随手点一下激活窗口）的 `mousedown` 不算"点击空白区域"，因为后者需要在 Focus Pod 编辑区域外的真正空白处发生

```
v6.0 消散优先级（从高到低）：
1. 用户主动关闭（Esc / ✕ / 点击空白）→ 立即消散
2. 内容交互信号（input/scroll/selectionchange）→ 立即消散
3. 10 秒无操作淡出 → 自动消散
4. 15 秒硬兜底 → 强制消散
```

**技术变更**：
- `IntentDismissalService` 新增 `DismissalChannel` 枚举：`'content-interaction' | 'manual-close' | 'idle-fadeout'`
- `DismissalConfig` 新增 `idleFadeoutMs: number`（默认 10_000）
- `DismissalConfig` 新增 `allowEscClose: boolean`（默认 true）
- `DismissalConfig` 新增 `allowBlankAreaClose: boolean`（默认 true）
- `maxLifetimeMs` 默认值从 60_000 调整为 15_000

### 2.5.2 修正二：透明归档（Transparent Archival）——消除"任务失踪"恐慌

**v5.0 的问题**：

静默冷冻（Silent Hibernation）在挂起切片超过 5 个时**不弹窗、不提示**，直接把最久闲置的切片扔进孵化器。设计理念是"顶级经纪人不拿碎纸机烦老板"。

但这严重违反了 UI 设计中最核心的**可预期性（Predictability）和控制感**。用户的心理模型是："我放在桌面上的东西，只要我没动，它必须在那里"。当切片"消失"时，第一反应是**数据丢失的恐慌**，而不是赞叹系统的智能。用户需要到孵化器里翻找带有 🧊 图标的任务，这打断了心流、增加了认知负担。

**v6.0 修正：非阻断式微提示（Non-blocking Micro-notification）**

系统仍然自动归档（不弹窗、不问用户），但在执行的瞬间提供**1.5 秒的底部状态栏微提示**，让用户知道发生了什么：

```
┌──────────────────────────────────────────────────────────────┐
│  底部状态栏（1.5 秒后自动消散，opacity: 0.7 → 0）：           │
│  📦 已将「等待 PM 确认」归档到孵化器 · [撤回]                  │
└──────────────────────────────────────────────────────────────┘
```

**关键设计决策**：
- **1.5 秒自动消散**——这不是需要阅读的信息，而是一个"发生了什么"的知会。1.5 秒足够扫一眼标题
- **[撤回] 按钮**——用户如果不同意系统的决定，可以在 1.5 秒内点击撤回，将切片恢复到挂起列表
- **不阻塞任何操作**——微提示在底部状态栏显示，不遮挡主内容、不抢焦点
- **仍然不弹确认框**——用户不需要选择"是否归档"，系统自动执行，用户只获得一个知会
- **与 v5.0 的差异**：v5.0 完全零提示；v6.0 有一个不打扰但可见的微提示，把控制感还给用户

**与 Silent Hibernation 的关系**：
- 「静默冷冻」更名为「**透明归档（Transparent Archival）**」——名字反映行为
- 冷冻逻辑不变（最久闲置的切片 → 孵化器底部，`overlapState = 'hibernated'`）
- 仅新增 1.5 秒微提示 + [撤回] 按钮
- 配置项 `SILENT_HIBERNATION` 更名为 `TRANSPARENT_ARCHIVAL`，新增 `NOTIFICATION_DURATION: 1_500`

### 2.5.3 修正三：全屏遮罩降级为侧栏记忆辅助面板（Memory Aid Panel）——消除"爹味"

**v5.0 的问题**：

离开超过 15 分钟时，系统弹出**全屏遮罩**，用户必须点击"我想起来了，继续"才能看到内容。系统假设每次回来都是为了"继续深度工作"。但真实场景中，用户可能只是**"抄一行代码"**或**"看一眼某个词"**就要切走。全屏遮罩强迫用户阅读操作轨迹并点击确认，引发极大的暴躁感。

**这是系统在"教用户做事"，而非帮用户做事。**

**v6.0 修正：侧栏记忆辅助面板（Memory Aid Panel）**

`full` 级别不再使用全屏遮罩。改为从屏幕**右侧滑出的记忆辅助面板**（宽度 300px），**不遮挡主内容**：

```
┌────────────────────────────────────────────────┬──────────────────────┐
│                                                │  🧠 记忆辅助          │
│              主舞台                             │                      │
│           (Focus Arena)                        │  ⏱ 你离开了 23 分钟   │
│                                                │                      │
│    ┌──────────────────────────────┐             │  📸 离开时的样子       │
│    │                              │             │  ┌────────────┐      │
│    │   ← 用户可以直接看到          │             │  │ (模糊缩略图) │      │
│    │     并操作主内容！            │             │  └────────────┘      │
│    │                              │             │                      │
│    │   光标已自动恢复到离开位置     │             │  📝 离开前你在做：     │
│    │                              │             │  · 14:30 编辑了       │
│    │   变更高亮以黄色脉冲显示       │             │    "用户故事 3"       │
│    │   （2s 后淡出）               │             │  · 14:28 移动了       │
│    │                              │             │    "性能优化"到已完成   │
│    └──────────────────────────────┘             │                      │
│                                                │  [知道了，关闭面板]    │
│                                                │                      │
├────────────────────────────────────────────────┴──────────────────────┤
│  底部状态栏                                                           │
└──────────────────────────────────────────────────────────────────────┘
```

**关键设计决策**：
- **不遮挡主内容**——用户回来只想"扫一眼某个词"时，可以直接看到主舞台，完全不被阻塞
- **光标和滚动位置仍然自动恢复**——底层行为与 v5.0 完全一致
- **变更高亮保留**——最后修改的 3 行以黄色脉冲 2 秒后淡出，在主舞台中直接可见
- **面板消散规则**：Soft Dismissal（2.5.1 的三通道）——任意键鼠操作 / Esc / 点击面板外 / 10 秒淡出
- **移动端适配**——面板改为**底部半屏抽屉**，上滑展开、下滑关闭
- **如果用户确实忘了怎么办？**——面板就在右边，转头看一眼即可。不需要被迫点击"我想起来了"
- **extreme case**：极少数用户确实需要强制重建时，可以在设置中启用"强制确认模式"（`MEMORY_AID.FORCE_CONFIRM = false`，默认关闭）

**三级预热响应（v6.0 更新）**：

| 离开时长 | 预热级别 | v5.0 行为 | v6.0 行为 |
|---------|---------|-----------|-----------|
| < 2 分钟 | `instant` | 闪烁最后编辑行，不弹任何 UI | **不变** |
| 2-15 分钟 | `gentle` | 底部 60px 预热条，内容交互后消散 | **Soft Dismissal**：保留预热条 + 新增 Esc/空白点击/10 秒淡出 |
| > 15 分钟 | `full` | **全屏遮罩，必须点击确认** | **侧栏记忆辅助面板**，不遮挡主内容，Soft Dismissal |

### 2.5.4 修正四：Mission Control 图文并茂——发挥人类空间记忆优势

**v4.0 的问题**：

v2.0 用模糊截图，v4.0 全面改成了纯文字的"结构化锚点卡片"。当用户面对 4 个挂起切片时，需要**逐字阅读** 4 张卡片上的文字来决定去哪。

但人类处理**空间和图像的速度远快于阅读文字**。模糊截图虽然细节不清，但大块的颜色、排版（代码的缩进形状 vs 文档的段落形状）能让人**一秒定位**。纯文字卡片反而增加了认知负荷。

**v6.0 修正：结构化锚点 + 模糊缩略图双通道**

Mission Control 的每张切片卡片采用**图文并茂**设计——左侧模糊缩略图提供空间记忆锚点，右侧结构化锚点文字提供语义精度：

```
┌──────────────────────────────────────────────────┐
│  选择要恢复的任务：                                │
│                                                  │
│  ┌─────────────────────────┐ ┌─────────────────────────┐ │
│  │ ┌─────┐ 📝 写需求文档    │ │ ┌─────┐ 💻 修复测试     │ │
│  │ │░░░░░│                  │ │ │▓▓▓▓▓│                  │ │
│  │ │░模糊│ "最后停在：       │ │ │▓模糊│ "最后停在：       │ │
│  │ │░截图│  在『验收标准』    │ │ │▓截图│  在 fixTimeout() │ │
│  │ │░░░░░│  一节编辑"       │ │ │▓▓▓▓▓│  中编辑"         │ │
│  │ └─────┘                  │ │ └─────┘                  │ │
│  │ 挂起 3 分钟 [恢复]       │ │ 挂起 8 分钟 [恢复]       │ │
│  └─────────────────────────┘ └─────────────────────────┘ │
│                                                  │
│                 [全部送入孵化器]                    │
└──────────────────────────────────────────────────┘
```

**关键设计决策**：
- 模糊缩略图为**60×80px 的小尺寸**，高度模糊（`blur(4px)`），仅保留大块颜色和排版形状
- 截图**仲裁代码 vs 文档 vs Flow 图**的能力极强——即使高度模糊：
  - 代码 = 深色背景 + 缩进密集的浅色文字
  - 文档 = 白色底 + 段落式排列
  - Flow 图 = 彩色方块 + 连线
- 截图**占用控制**：每张 ≤ 30KB（60×80 低分辨率 + JPEG quality 30%），5 张共 150KB，在可接受范围内
- **截图缺失时优雅降级**——如果截图保存失败（如空间不足），卡片仍然只显示结构化锚点文字 + 任务类型图标色块占位
- **v4.0 的结构化锚点文字仍是核心辨识手段**——截图是辅助而非替代
- `screenshotDataUrl` 从仅 `full` 级别使用，恢复为 Mission Control + `full` 级别双重使用

### 2.5.5 修正五：活跃度推断极简化 + 伴随模式自动化——接受软件局限性

**v3.0-v5.0 的问题**：

三层活跃度推断模型（微操作信号 + 认知上下文 + 离席置信度评分）试图用纯软件逻辑精确判断用户是否"在思考"。这套逻辑极其复杂（贝叶斯式权重叠加、置信度评分 0-100），且极易出现边缘 Case：
- 触控板用户手腕搭在上面产生微小 jitter → 系统认为在思考
- 用户真的在死盯着屏幕推演逻辑，一动不动 5 分钟 → 系统认为离开了

**用纯软件模拟眼动仪是不现实的。** 这套模型的维护成本远高于它带来的体验提升，而且它**不可能 100% 准确**。

同时，伴随模式（Companion Mode）的概念增加了普通用户的认知门槛。当系统弹窗问"检测到频繁切换，是否开启伴随模式？"时，90% 的用户会困惑。这是一个典型的"因底层技术限制而把复杂性转嫁给用户"的设计。

**v6.0 修正：极简二元判定 + 自动多屏适配**

**活跃度判定简化为两条硬规则**：

| 信号 | 判定 | 说明 |
|------|------|------|
| `document.visibilityState === 'hidden'` | **立即 idle** | 最高置信度——标签页物理不可见 |
| 动态阈值内无任何键鼠/触摸事件 | **idle** | 根据 `cognitiveLoad` 动态调整阈值（deep: 5min / moderate: 2min / shallow: 30s） |

**废弃的复杂度**：
- ~~离席置信度评分（absenceConfidence 0-100）~~ → 改为简单的 `boolean: idle/active`
- ~~多层权重叠加（blur 60%、无微操作 70%、无鼠标 +20%、微操作 -50%）~~ → 有任何事件就 active，超时就 idle
- ~~微操作信号区分（鼠标微移 distance>5px、极微滚动 deltaY<50px）~~ → 所有键鼠/触摸事件统一处理
- ~~`ABSENCE_CONFIDENCE_THRESHOLD = 80`~~ → 无需阈值，简单超时判定

**如果推断错了怎么办？**
- 用户真的在看屏幕但被判为 idle → 提醒弹出来时，动一下鼠标提醒就消失了（成本 < 0.5 秒）
- 这个成本**远低于**维护一套庞大且容易出错的贝叶斯推断模型的工程成本

**保留的合理部分**：
- `cognitiveLoad` 驱动的动态 idle 阈值仍保留（深度阅读任务放宽到 5 分钟合理）
- `visibilityState === 'hidden'` 立即判定仍保留（唯一的硬信号）
- `Focus Suppression` 机制仍保留（用户操作时提醒静默）

**伴随模式自动化**：

| v5.0 行为 | v6.0 行为 |
|-----------|-----------|
| 用户手动开启 Companion Mode | **系统自动检测并适配，不出现任何用户界面** |
| 弹窗建议"是否开启伴随模式？" | **删除弹窗。** 2 分钟内 blur→focus 切换 ≥5 次 → 系统自动将 blur 的 idle 判定延长为 30 秒（而非 10 秒） |
| 设置页 Companion Mode 开关 | **降级为高级设置**（仅高级用户可见），标签改为更直觉的"多窗口工作优化" |
| `companionMode` signal | 保留，但改为系统内部状态，不再作为用户面向概念 |

**关键原则**：**用户不需要知道"伴随模式"这个技术概念的存在。** 系统应该自动做正确的事，而不是把复杂性转嫁给用户。

### 2.5.6 概念精简：降低认知门槛

**v5.0 的问题**：

一个普通的任务管理功能，被拆分出了 Focus Pod（专注舱）、Incubator（孵化器）、Suspended Slices（挂起切片）、Hibernated（冷冻态）、Strata（沉积层）等大量专业术语。用户在实际使用中，脑容量有限——当一个任务从 Focus Pod 被挤到 Suspended Slices，又因超限被 Silent Hibernation 到了 Incubator，最后完成进入 Strata，**任务的生命周期流转过于复杂，用户失去了对任务"到底在哪"的掌控感**。

**v6.0 修正：面向用户的简化命名**

系统内部仍使用精确的技术术语（代码可读性），但**所有用户可见的 UI 标签**采用日常直觉化命名：

| 内部术语 | v5.0 用户可见名称 | v6.0 用户可见名称 | 日常类比 |
|---------|-------------------|-------------------|---------|
| Focus Pod | 专注舱 | **当前任务** | "我正在做的事" |
| Incubator | 孵化器 | **后台任务** | "放在一边等着的事" |
| Suspended Slices | 挂起切片 | **暂停的任务** | "刚放下的事" |
| Hibernated | 静默冷冻 | **已归档** | "自动收起来的事" |
| Mission Control | 任务管制 | **切换任务** | "回到哪件事？" |
| Metronome Alert | 节拍器提醒 | **后台提醒** | "那边有事了" |
| Context Warm-up | 上下文预热 | **回忆辅助** | "你刚才做到哪了" |

**关键原则**：
- **代码层不改**——内部变量名、服务名、配置项保持一致性（FocusPod、Incubator 等）
- **仅 UI 层标签更新**——按钮文字、面板标题、提示文案使用直觉化命名
- **减少用户需要理解的概念数**——从"六七个专业术语"降至"当前 / 后台 / 暂停 / 已归档"四个日常词汇

### 2.5.7 纠错 Toast 的持久化入口——错过窗口期不再痛苦

**v5.0 的问题**：

如果用户把任务送入孵化器后立刻投入 Focus 任务（触发了 input 导致 Toast 秒消散），他**错过了纠错窗口**。一个被误判的紧急任务可能因此被无限期搁置。用户要手动点开侧边栏 → 找到任务 → 展开详情 → 修改属性，比一开始就让他选更繁琐。

**v6.0 修正：Toast 消散后保留持久纠错入口**

```
Toast 消散后，孵化器侧边栏对应卡片右上角显示一个微型 ✏️ 图标（3 分钟内可见）：

默认状态                             有纠错入口
┌─────────────────────────┐          ┌─────────────────────────┐
│ ⏳  后台编译              │          │ ⏳  后台编译         ✏️  │  ← 3 分钟内可见
│                          │    →     │                          │
│ [切换]                   │          │ [切换]                   │
└─────────────────────────┘          └─────────────────────────┘

点击 ✏️ → 展开与 Correction Toast 相同的纠错面板
3 分钟后 ✏️ 自动消失 → 退化为 hover 展开详情中的 [修改属性] 链接
```

**关键设计决策**：
- **3 分钟窗口**——足够用户意识到推断可能有误并返回纠正
- **视觉最小化**——仅一个 ✏️ 图标，不占空间、不分散注意力
- **3 分钟后仍可修改**——只是入口从卡片右上角移到 hover 详情中，不是完全不可修改
- **不改变 Toast 本身的消散逻辑**——Toast 仍按 Soft Dismissal 规则消散，✏️ 是备用通道

---

## 2.7 v7.0 设计演进：做减法到最小内核

> **核心反思**：v1.0→v6.0 经过六个版本的迭代，系统复杂度单调递增。每次修正确实解决了上一版的问题，但**一个"送入孵化器"动作最终涉及 Attribution 推断→ Toast 生成→ IntentDismissalService 注册→ 三通道消散→ 持久入口→ 活跃度判定→ 多屏检测→ Focus Suppression→ Metronome 监控→ 透明归档——10 个子系统联动**。任何一环出 bug，用户的第一反应是"这个功能不好用"，而不是"IntentDismissalService 的 scroll 阈值可能需要调"。
>
> **v7.0 的核心原则**：**先做减法到最小内核，用真人反馈驱动加法。** 停止在纸面上推演第 N+1 个边界条件。

### 2.7.1 根本性问题诊断：精密机械 vs 混沌系统

v3.0-v6.0 的设计范式是**用确定性工程手段解决不确定性人类认知问题**。这导致了一个无法逃脱的螺旋：

| 版本 | 修什么 | 又引入了什么 |
|------|--------|-------------|
| v3.0 | 预热一刀切 → 记忆衰减曲线 | 三层推断模型 + 贝叶斯评分 + NLP 语义签名 |
| v4.0 | 定时器焦虑 → Intent 消散 | IntentDismissalService + 信号白名单 + Companion Mode |
| v5.0 | mousedown 假阳性 → 信号净化 | Proximity Fallback + Silent Hibernation + compositionstart |
| v6.0 | 净化太严+全屏遮罩 → 三通道消散 | Esc + 空白点击 + 10s 淡出 + Memory Aid Panel + 透明归档微提示 + 持久 ✏️ 入口 + 多屏自动检测 |

**核心问题**：策划案用"精密机械"的思维去适配"混沌系统"（人类行为）。机械越精密，故障模式越多。

### 2.7.2 七大机械思维的修正

#### 修正一：废弃基于离开时长的三级预热——因果关系不成立

**问题**：三级预热（< 2min → instant / 2-15min → gentle / > 15min → full）基于艾宾浩斯遗忘曲线——但遗忘曲线的实验对象是**无意义音节的死记硬背**，不是任务上下文。

真实场景反例：
- 离开 20 分钟喝咖啡，脑子里一直在想刚才的问题 → 回来不需要任何预热
- 离开 3 分钟接了一个紧急电话处理了另一个复杂问题 → 回来完全忘了之前在干嘛
- 被同事叫去开了 30 分钟会但会议内容与当前任务相关 → 回来反而比离开前更清楚

**遗忘程度取决于中断的认知负载和情境关联性，不取决于时钟秒数。** 系统无法获知用户离开期间做了什么，因此用时长做分级必然有大量误判。

**v7.0 修正：统一为单一行为——闪烁最后编辑位置**

无论离开多久，回来时：
1. 光标和滚动位置自动恢复（底层行为不变）
2. 最后编辑的行以黄色脉冲闪烁一次（200ms 后淡出）——这是**视觉锚点**，帮眼睛"落地"
3. **不弹任何条/面板/遮罩**——如果用户需要回忆，他自己会看内容

**废弃的复杂度**：
- ~~三级预热（instant/gentle/full）~~ → 统一行为
- ~~Context Warm-up Bar（60px 预热条）~~ → 删除
- ~~Memory Aid Panel（300px 侧栏）~~ → 删除
- ~~IntentDismissalService 对预热 UI 的消散管理~~ → 删除
- ~~三通道消散（内容交互 / Esc / 10s 淡出）~~ → 删除
- ~~操作轨迹时间线~~ → 删除
- ~~OperationTrailRecorder（持续事件监听+环形缓冲区）~~ → 删除

**为什么不需要预热条/面板？**
- "结构化锚点"假设用户靠"在哪个函数/章节"恢复记忆，但真人唤醒记忆的线索往往是**思考内容**（"我在纠结一个逻辑"）、**视觉记忆**（"那段缩进特别深"）或**社交情境**（"我在和小王讨论的那段"）。系统能提供的**物理位置**信息，远不如用户自己看一眼内容来得直接
- full 级别的 Memory Aid Panel 占据 300px 屏幕宽度，在 1366px 笔记本上主内容区只剩 866px。用户压根不需要系统"教"他回忆——**闪烁编辑位置让眼睛落地即可，大脑自己会做剩下的事**

#### 修正二：自动停泊替代入舱仪式——被打断的人不做仪式

**问题**：零配置入舱要求用户**主动执行"送入孵化器"操作**（拖拽/右键/长按滑动）。但真实被打断的用户不会执行仪式——他们直接就走了。

**v7.0 修正：当用户切换到另一个任务时，系统自动保存当前任务的上下文**

- 用户点击另一个任务进入 Focus → 当前任务**自动**变为"稍后"状态
- 上下文（光标位置 + 滚动位置）自动保存
- 无需拖拽、无需右键菜单、无需"送入孵化器"
- 任务列表中"稍后"的任务以灰色标记，点击即可切回

**"稍后"任务也可以手动标记**：用户也可以主动将当前未聚焦的任务标记为"稍后"（如长按或右键），但这不是必须的流程。

#### 修正三：砍掉 Checkpoint/Metronome 子系统——用简单提醒替代

**问题**：锚点系统适合有明确阶段的任务（编译、部署、等待审批）。但大部分知识工作任务没有阶段：
- "写一份技术方案"——什么时候算"锚点到达"？
- "思考产品架构"——没有外部事件可以触发锚点
- "改几个 bug"——每个 bug 独立，不存在阶段

结果是大部分任务的锚点设置为 `manual`（手动触发），而手动触发锚点**等于手动提醒自己**——这和不用孵化器直接写个 to-do 没区别。

**v7.0 修正：可选的简单计时提醒**

- 用户把任务标记为"稍后"时，**可选**设置一个提醒时间（"5 分钟后提醒我" / "30 分钟后提醒我" / "不提醒"）
- 提醒方式：底部状态栏一行文字 + 浏览器 Notification API（如果用户授权了通知权限）
- **没有 Focus Suppression**——提醒到了就提醒，不揣测用户是否在心流
- **没有升级机制**——提醒一次，用户没看到就算了。这不是系统的错，也不需要系统来"纠正"

**废弃的复杂度**：
- ~~Checkpoint 数据结构（id/label/triggerType/triggerValue/status/triggeredAt/handledAt）~~ → 仅保留可选的 `reminderAt: string | null`
- ~~CheckpointTrigger 类型（timer/progress/manual）~~ → 删除
- ~~MetronomeService（锚点监控+升级逻辑+suppressed 级别）~~ → 删除
- ~~MetronomeAlert 队列~~ → 删除
- ~~Focus Suppression（idle/active 状态驱动的提醒抑制）~~ → 删除
- ~~四级提醒机制（suppressed/calm/notice/alert）~~ → 一张底部通知

#### 修正四：砍掉截图系统——ROI 极低

**问题**：
- **60×80px + blur(4px) + 30% JPEG** 基本就是一个有颜色的方块。dark mode 下文档也是深色的，与代码难以区分
- 用户**不会盯着一个 60×80 的模糊色块来决定恢复哪个任务**——他们会直接读文字标题
- html2canvas 在 GoJS SVG 场景下耗时不可控（远超 100ms 目标），会导致切换卡顿
- 带来 html2canvas 依赖、base64 存储开销（150KB/5 张）、截图失败降级逻辑、移动端适配

**v7.0 修正：删除截图功能**

- Mission Control 卡片只显示**任务标题 + 类型图标 + 停泊时长**
- 结构化锚点签名保留为辅助信息（"最后在 `connectDB()` 中编辑"），但不作为主要辨识手段
- 用户通过**任务标题**选择要切回的任务——这是最自然且最可靠的

**废弃的复杂度**：
- ~~html2canvas 依赖~~ → 删除
- ~~screenshotDataUrl 字段~~ → 删除
- ~~captureScreenshot() 方法~~ → 删除
- ~~截图 200KB 尺寸限制逻辑~~ → 删除
- ~~截图缺失的降级逻辑~~ → 删除
- ~~模糊缩略图渲染组件~~ → 删除

#### 修正五：砍掉关键词推断——自然语言歧义不可战胜

**问题**：

| 标题 | 推断结果 | 实际情况 |
|------|---------|---------|
| "不要等待，马上开始" | async + manual（命中"等待"） | **大错特错** ❌ |
| "Review Bob 的 PR" | deep + synchronous（命中"review"） | 可能只是点 Approve，5 秒完事 ❌ |
| "跑 10 分钟步" | timer 10min（命中"10 分钟"） | 这是个生活任务不是技术任务 ❌ |
| "买牛奶" | moderate + semi-async（兜底） | 不属于任何知识工作范畴 ❌ |

关键词匹配永远会被自然语言歧义击败。用户只要遇到一次离谱推断，就会对整个机制失去信任。

**v7.0 修正：废弃自动推断，仅保留两个用户选项**

停泊任务时（自动或手动），系统不推断任何属性。用户只需要在想设置提醒时选择提醒时间——这是唯一的配置项，且是**可选的**。

**废弃的复杂度**：
- ~~OverlapAttributionService（推断引擎）~~ → 删除
- ~~cognitiveLoad / blockingType 推断规则链~~ → 删除
- ~~推断置信度（high/medium/low）~~ → 删除
- ~~Correction Toast（推断纠错浮层）~~ → 删除
- ~~CorrectionToastData 模型~~ → 删除
- ~~持久 ✏️ 纠错入口~~ → 删除

#### 修正六：任务状态二元化——映射真实心智模型

**问题**：即使 v6.0 将用户面向标签简化为"当前任务/后台任务/暂停的任务/已归档"，底层仍有 `none → focus → incubating → checkpoint → paused → hibernated → hatched` 七种状态。一个任务可能经历 7 次状态迁移，每次迁移都有不同的 UI 反馈。

**真人心智模型只有三种**："我正在做的" / "我没在做的" / "我做完的"。第三种（完成）已被现有 Strata 处理。State Overlap 只需要处理前两种。

**v7.0 修正：两个状态**

| 状态 | 含义 | UI 表现 |
|------|------|---------|
| `active` | 当前 Focus 中的任务 | 主舞台全屏展示 |
| `parked` | 不在 Focus 中的任务 | 侧边栏静态列表项 |

**废弃的状态**：
- ~~`incubating`（孵化中）~~ → 统一为 `parked`
- ~~`checkpoint`（锚点到达）~~ → 删除（锚点系统已删除）
- ~~`paused`（手动暂停）~~ → 统一为 `parked`
- ~~`hibernated`（静默冷冻）~~ → 统一为 `parked`（超限时直接从侧边栏移除回普通任务列表即可）
- ~~`hatched`（孵化完成）~~ → 删除（不再有"孵化"概念；任务完成直接走 Strata）

#### 修正七：砍掉不可靠的检测机制

**多屏自动检测**：2 分钟内 blur→focus 切换 ≥5 次 → "系统自动检测为多屏"。但 Alt+Tab 切换应用、同浏览器切换标签页、虚拟桌面切换都会产生完全相同的信号。误判后延长 blur idle 到 30 秒，导致用户真正离开时系统响应变慢。

**v7.0 修正：仅使用 `visibilityState === 'hidden'` 作为唯一的离开信号**

- 标签页不可见 = 用户离开（唯一的高置信度信号）
- 标签页可见 = 用户可能在操作（不需要更精确了）
- **没有 idle 检测**——State Overlap 的核心价值是"切换任务时保存上下文"，不是"检测用户是否在发呆"
- **没有 Focus Suppression**——提醒就提醒，用户自己决定要不要处理

**废弃的复杂度**：
- ~~UserActivityService（活跃度检测）~~ → 大幅简化，仅监听 `visibilitychange`
- ~~多屏自动检测（blur/focus 计数）~~ → 删除
- ~~动态 idle 阈值（deep: 5min / moderate: 2min / shallow: 30s）~~ → 删除
- ~~Focus Suppression（suppressed 状态）~~ → 删除

### 2.7.3 v7.0 最小内核设计

**核心用户流程（v7.0 → v7.1 修正）**：

```
1. 用户正在做任务 A（Focus）
2. 被打断，在侧边栏单击任务 B
   → 预览任务 B 的详情面板（不切换 Focus，不停泊任务 A）
3. 确定要切换，双击任务 B 或点击 [开始做] 按钮
   → 系统自动保存任务 A 的光标/滚动位置（内容锚点）
   → 任务 A 变为"稍后"（parked）
   → 任务 B 成为 Focus
4. 回到任务 A
   → 双击侧边栏中任务 A / 点击 [开始做]
   → 光标/滚动位置自动恢复（基于内容锚点）
   → 最后编辑行闪烁一次（1000ms 三段式动画）
   → 用户继续工作
```

> **v7.1 关键变更**：单击=预览，双击/显式按钮=切换。详见 §2.8.1。

**系统涉及的子系统数量**：2 个（上下文保存/恢复 + 侧边栏渲染）。

对比 v6.0 同一流程涉及的子系统数量：10 个。

**"稍后"任务列表**：

```
┌──────────────────────────────────┐
│ ⏸  修复登录 bug                   │  ← 任务标题
│    connectDB() · 8 分钟           │  ← 结构化锚点 + 停泊时长
│    [查看详情]  [开始做 ▶]   [×]   │  ← 单击=预览，双击/按钮=切换
└──────────────────────────────────┘
┌──────────────────────────────────┐
│ ⏸  写需求文档                      │
│    第 3 章 · 23 分钟               │
│    ⏰ 提醒：还剩 7 分钟            │  ← 仅在设置了提醒时显示
│    [查看详情]  [开始做 ▶]   [×]   │
└──────────────────────────────────┘
```

> **v7.1 变更**：卡片增加 [查看详情]（预览，不切换）和 [×]（手动移除），[切换] 改名为 [开始做]。详见 §2.8.1、§2.8.4。

**如果"稍后"任务太多怎么办？（v7.1 修正）**
- ~~`MAX_PARKED_TASKS = 5` 数量硬限制~~ → **废弃**
- **48 小时时间衰老**：停泊任务连续 48 小时未被访问 → 自动移回普通任务列表 + Intent-based 通知含 [撤回]
- **软上限 15**：停泊数 ≥ 15 时侧边栏底部显示提示"停泊任务较多"，不强制删除
- 每个卡片增加 [×] 按钮 / 左滑删除手势——手动清理 0.3 秒完成
- 详见 §2.8.4

### 2.7.4 v7.0 保留的设计资产

以下 v2.0-v6.0 中经过验证的设计保留在 v7.0 中：

| 保留的设计 | 来源 | 理由 |
|-----------|------|------|
| **自动保存光标/滚动位置** | v1.0 | 核心价值，零争议（v7.1：滚动位置改为内容锚点，§2.8.7） |
| **最后编辑行闪烁**（~~200ms~~ → **1000ms 三段式**） | v3.0 → v7.1 | v7.1 修正闪烁时长为 1000ms 三段式动画（§2.8.3） |
| **结构化锚点签名** | v4.0 | 辅助信息，零 NLP 依赖，实现简单 |
| **侧边栏静态图标**（无进度条/无动画） | v2.0 | 视觉静默原则经得起推敲 |
| **Suspended Slices 扁平模型** | v2.0 | 自由跳转（非 LIFO）是一个正确设计 |
| ~~Mission Control 全景面板~~ → **常驻侧边栏** | v2.0 → v7.1 | v7.1 废弃弹窗式 Mission Control，改为常驻侧边栏（§2.8.5） |
| **`visibilityState === 'hidden'` 作为离开信号** | v3.0 | 唯一高置信度的离席信号 |
| **用户面向的简化命名** | v6.0 | "当前任务"/"稍后"比"Focus Pod"/"Incubator"好得多 |

### 2.7.5 v7.0 对移动端的处理

**问题**：移动端用户的使用场景通常是快速查看和轻量操作——他们很少需要在手机上进行多任务切换管理。为移动端开发一整套适配（FAB + drawer + swipe gesture + 触摸消散 + compact Memory Aid）的投入，可能完全没有用户场景支撑。

**v7.0 修正：移动端延后到 MVP 验证之后**

- Phase 1（MVP）仅做桌面端
- 如果桌面端 MVP 经真人验证后确认有价值，再做移动端适配
- 移动端适配内容极简：底部一个"稍后(N)"按钮 + 点击展开半屏列表

### 2.7.6 v7.0 vs v6.0 对比：系统复杂度

| 维度 | v6.0 | v7.0 → v7.1 | 削减 |
|------|------|------|------|
| 任务状态数 | 7（none/focus/incubating/checkpoint/paused/hibernated/hatched） | 2（active/parked） | -71% |
| 服务类数量 | 7（OverlapService/FocusPod/Incubator/Metronome/ContextWarmUp/Attribution/UserActivity + IntentDismissal） | 3（ParkingService/ContextRestore/SimpleReminder） | -63% |
| UI 组件数量 | ~20（含 Memory Aid Panel/Correction Toast/Archival Notification/Mission Control 等） | ~4（ParkingList/TaskCard/Snackbar/EditFlash）——v7.1 废弃 MissionControl 弹窗 | -80% |
| 配置常量数 | ~40 | ~10（v7.1 新增 Snooze/衰老/锚点相关） | -75% |
| 用户概念数 | 8+（Focus Pod/Incubator/Checkpoint/Metronome/Warm-up/Suspended Slice/Hibernated/Mission Control） | 2（当前任务/稍后） | -75% |
| 实施周期 | 6 周 | 2 周 | -67% |

### 2.7.7 MVP 验证计划

**在写一行代码之前，先做纸面原型验证（1 天）**：

1. 制作 Figma/手绘原型，展示核心流程：切换 → 自动保存 → 侧边栏 → 切回 → 闪烁恢复
2. 找 5 个目标用户（混合：2 开发者 + 2 PM + 1 设计师）进行 15 分钟走查
3. 核心验证问题：
   - "你日常工作中有同时处理多个事情并需要来回切换的场景吗？"（需求验证）
   - "看到这个流程，你觉得它比你现在用浏览器标签页切换更好吗？"（竞品对标）
   - "你需要系统提醒你'回到之前的任务'吗？还是你自己记得住？"（提醒价值验证）
   - "你觉得还缺什么？"（开放发散）

4. 根据验证结果决定：
   - **5/5 觉得有用** → 进入 Phase 1 实现
   - **3-4/5 觉得有用** → 实现最小版本但砍掉提醒功能
   - **< 3/5 觉得有用** → **搁置整个功能**，将工程资源投入到搜索/输入/同步等核心功能

---

## 2.8 v7.1 设计修正：基于外部评审的八项改进

> **核心背景**：v7.0 策划案接受了外部评审。评审的核心论点——**v7.0 删掉了认知辅助的工程手段，但没有删掉认知辅助的产品承诺**——完全成立。"注意力经纪人"的叙事和 v7.0 的实际交付物（自动保存光标+闪烁一下）之间存在巨大的期望差。
>
> **v7.1 的核心原则**：承认系统的能力边界，修复致命的交互设计缺陷，同时保持 v7.0 的极简精神。

### 2.8.1 修正一：分离"查看"与"切换"——最核心的语义歧义修复

**v7.0 的致命缺陷**：

v7.0 的"自动停泊"将"点击任务"等同于"切换 Focus"。但**浏览 ≠ 切换**是所有任务管理工具的基本约定。用户在任务列表中浏览时，会频繁点击不同任务查看详情。如果每次点击都触发 Focus 切换和上下文停泊，用户会陷入"看一眼就被切走"的恐慌——这实际上**惩罚了浏览行为**。

**v7.1 修正：双动作模型**

| 操作 | 行为 | 设计依据 |
|------|------|---------|
| **单击**任务卡片 | **预览/查看**任务详情（不切换 Focus，不停泊当前任务） | 所有任务管理工具的标准约定（Linear/Notion/Todoist） |
| **双击** / **长按** / **显式按钮"开始做"** | **切换 Focus**——停泊当前任务 + 恢复目标任务 | 切换是一个**有意识的动作**，不是点击的副作用 |

**为什么不加确认框？** 确认框（"是否切换到此任务？"）会杀死零仪式。双击/显式按钮本身就是确认——用户主动执行一个比单击更重的操作，表达了"我要切换"的明确意图。

**技术变更**：
- `ParkingService.switchFocus()` 仅在 `startWork(taskId)` 被调用时触发（而非任何 task 点击）
- 任务卡片的 `(click)` 事件改为 `previewTask(taskId)`——打开详情面板或面包屑预览
- 新增 `(dblclick)` / 显式 `[开始做]` 按钮 → `startWork(taskId)` → 调用 `switchFocus()`

### 2.8.2 修正二：归档提示改为 Intent-based 消散

**v7.0 的问题**：

超限驱逐时"底部状态栏闪现 3 秒提示"，3 秒的时间窗口在 Fitts 定律下物理上不可完成：
- 用户识别通知：~0.5s
- 阅读内容：~0.8s
- 决策是否撤回：~0.5s
- 眼睛定位 [撤回] 按钮：~0.3s
- 鼠标移动到按钮并点击（Fitts' Law）：~0.5-1.0s
- **合计：2.6-3.1s**——实验室条件勉强可行，真实环境（用户注意力在主内容上）几乎不可能

**v7.1 修正**：

- 超限驱逐提示改为 **Intent-based 消散**——通知持续显示，直到用户的**下一次任意交互**（点击/输入/滚动）后消失
- 如果用户 **15 秒无操作**，通知自动淡出（解决离开场景）
- [撤回] 按钮最小尺寸 **44×44px**（Apple HIG 最小可点击区域），置于通知右侧最易够到的位置
- 通知高度从状态栏内嵌改为 **底部悬浮 Snackbar**（48px），确保在视觉层级上足够突出

```
超限驱逐通知（v7.1 — Intent-based）：
┌──────────────────────────────────────────────────────────┐
│  📋 「旧任务名」已移回任务列表     [撤回 ↩]              │  ← 44×44px 按钮
│                           （下次操作后自动消失）           │
└──────────────────────────────────────────────────────────┘
```

### 2.8.3 修正三：闪烁时长调整为 1000ms 三段式动画

**v7.0 的问题**：

200ms 闪烁在眼跳（saccade）落地的同时就消失了。眼跳需要 150-200ms 才能稳定在新位置，意味着 200ms 的脉冲在用户视觉系统还未完成锁定时就已淡出——用户的感受是"好像闪了一下？在哪？"

**v7.1 修正**：

闪烁时长改为 **1000ms**，采用**"亮起→保持→淡出"三段式动画**：

| 阶段 | 时长 | 行为 | 设计依据 |
|------|------|------|---------|
| 亮起 | 200ms | 黄色背景从 `opacity: 0` 渐显至 `opacity: 0.6` | 吸引眼球注意力，触发眼跳 |
| 保持 | 500ms | 黄色背景保持 `opacity: 0.6` | 眼跳完成后给视觉系统足够时间"锁定"位置 |
| 淡出 | 300ms | 黄色背景渐隐至 `opacity: 0` | 优雅退场，不突然消失 |

**实现成本**：一行 CSS animation keyframes，零额外逻辑。

```css
@keyframes edit-line-flash {
  0%   { background-color: rgba(255, 220, 50, 0); }
  20%  { background-color: rgba(255, 220, 50, 0.6); }   /* 200ms: 亮起完成 */
  70%  { background-color: rgba(255, 220, 50, 0.6); }   /* 700ms: 保持结束 */
  100% { background-color: rgba(255, 220, 50, 0); }     /* 1000ms: 淡出完成 */
}
```

### 2.8.4 修正四：超限策略改为基于时间的清理

**v7.0 的问题**：

`MAX_PARKED_TASKS = 5` 的依据引用了 Miller's Law（7±2），但 Miller's Law 描述的是**工作记忆容量**——即大脑同时保持的信息数量。侧边栏停泊列表是**外部化存储**，用户不需要记住列表内容，只需要"看一眼"即可定位——这完全不受工作记忆限制。

更关键的问题是：数量硬限制触发"最久停泊的任务被踢出"，但"最久停泊"不等于"最不重要"。用户可能有一个重要任务停了很久（等待外部依赖），而刚停泊的临时任务反而是低优先级的。

**v7.1 修正：基于时间的衰老清理 + 软上限**

| 策略 | 触发条件 | 行为 |
|------|---------|------|
| **时间衰老** | 停泊任务 **48 小时**内未被访问 | 自动移回普通任务列表 + Intent-based 通知 |
| **软上限警告** | 停泊数 **≥ 15** | 侧边栏底部显示提示"停泊任务较多，考虑清理不需要的"，**不自动删除** |
| **手动清理** | 用户操作 | 每个停泊卡片增加 **×** 按钮 / 向左滑动删除手势——0.3 秒即可清理 |

**关键设计决策**：
- **48 小时**是合理的衰老周期——超过两天没碰的任务，回来概率极低
- 衰老清理前发一条 Intent-based 通知（同 2.8.2），包含 [撤回] 按钮
- 废弃 `MAX_PARKED_TASKS` 硬限制——外部化列表不应有人为上限
- 软上限 15 只是一个建议，没有强制行为

### 2.8.5 修正五：Mission Control 改为常驻侧边栏

**v7.0 的问题**：

v7.0 的 Mission Control 是一个**弹窗式面板**——停泊数 ≥2 时 `bounceBack()` 弹出。但 Mission Control 的触发时机恰好是"用户刚完成一个任务的 3 秒内"——此时**注意力处于涣散期**（attention trough），被迫做优先级决策是最差的时机。

更根本的问题是：弹窗式 Mission Control 把"选择回到哪个任务"变成了一个**被动的、系统强加的仪式**。用户应该**随时**可以切换到任何停泊任务，而不是等系统弹出面板。

**v7.1 修正：停泊任务列表始终可见**

- 侧边栏的停泊任务列表**始终可见**——从 1 个停泊任务开始就显示，不需要 ≥2 才触发
- 废弃弹窗式 Mission Control 面板
- 用户**随时**可以双击侧边栏中的任何停泊任务切回
- 如果完成当前任务后没有明确的"下一个"，就**留在当前状态**（无 Focus 任务）——不强制选择

**视觉布局变更**：

```
v7.0 行为：
  用户完成任务 → bounceBack() → 弹出 Mission Control 面板 → 被迫选择

v7.1 行为：
  停泊列表始终可见 → 用户随时双击任何停泊任务 → 切换
  用户完成任务 → 自然地看一眼侧边栏 → 自行决定下一步
```

**保留的合理部分**：
- 如果侧边栏被折叠（48px 图标模式），点击展开按钮时以**列表形式**展开，而非弹窗
- 移动端：底部 "稍后(N)" 按钮 → 点击展开半屏列表（保持不变）

### 2.8.6 修正六：提醒增加 Snooze 机制

**v7.0 的问题**：

v7.0 的提醒是"一次性通知——5 秒后消失"。但如果用户正在深度工作、无法立刻切换，这条通知就白费了。用户既知道"那个任务需要回去"，又无法立刻行动——这产生了认知拉扯而非帮助。

**v7.1 修正**：

提醒到达时，通知增加第三个按钮 **"5 分钟后再提醒"**（Snooze）：

```
提醒到达通知（v7.1）：
┌──────────────────────────────────────────────────────────┐
│  ⏰ 「写需求文档」的提醒时间到了                           │
│  [切换过去]   [5 分钟后再提醒]   [忽略]                    │
│                          （下次操作后自动消失）              │
└──────────────────────────────────────────────────────────┘
```

**Snooze 规则**：
- 点击"5 分钟后再提醒" → 通知消散，5 分钟后再次触发同一提醒
- 每个提醒最多 Snooze **3 次**（与现有 `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY = 3` 保持一致）
- 第 3 次 Snooze 后提醒变为"最后一次提醒"，不再显示 Snooze 按钮
- 提醒通知同样使用 **Intent-based 消散**（用户下次交互后消失），而非 5 秒自动消失

### 2.8.7 修正七：滚动位置改为内容锚点

**v7.0 的问题**：

v7.0 保存 `scrollPosition: { top: number; left: number }` 作为像素值。但 `scrollTop: 847px` 在不同屏幕宽度下会回流（reflow）到完全不同的内容位置——1920px 宽屏上的第 847px 和 1366px 笔记本上的第 847px 指向不同的段落。跨设备同步时，滚动位置恢复完全失效。

**v7.1 修正：基于内容锚点的滚动恢复**

| 策略 | 实现方式 | 适用场景 |
|------|---------|---------|
| **内容锚点**（首选） | 保存 `anchorParagraph`（第 N 段的第 M 行）或 `anchorHeading`（最近的标题） | 结构化内容（Markdown/列表） |
| **百分比回退** | 保存 `scrollPercent = scrollTop / scrollHeight` | 内容锚点不可提取时的 fallback |
| **Hash 校验 + 放弃** | 恢复前检测 `contentHash`，不匹配时放弃滚动恢复，仅恢复光标 | 内容已被外部修改 |

**数据模型变更**：

```typescript
// ParkingSnapshot.scrollPosition 从像素值改为内容锚点
scrollPosition: {
  /** 内容锚点：基于段落/行号定位（跨设备稳定） */
  anchorType: 'paragraph' | 'heading' | 'line';
  anchorIndex: number;  // 段落序号 / heading 序号 / 行号
  anchorOffset?: number; // 段落内偏移行数（可选）
  /** 百分比回退：无法提取内容锚点时使用 */
  scrollPercent: number; // scrollTop / scrollHeight (0-1)
} | null;
```

**恢复逻辑**：
1. 尝试通过 `anchorType + anchorIndex` 定位内容位置 → `element.scrollIntoView()`
2. 如果锚点元素不存在（内容已变） → 使用 `scrollPercent` 回退
3. 如果 `contentHash` 已变 → 放弃滚动恢复，只恢复光标位置

### 2.8.8 修正八：产品叙事重新定位

**v7.0 的问题**：

策划案标题"注意力经纪人"和 v7.0 的实际交付物之间存在期望差：

| 叙事承诺 | v7.0 实际交付 | 差距 |
|---------|-------------|------|
| "识别任务的真实注意力需求" | 无任何识别逻辑 | **完全未交付** |
| "托管不需要大脑参与的时间碎片" | 仅停泊 + 可选提醒 | **大幅缩水** |
| "保全处理核心课题时的专注力" | 无 Focus Suppression、无 idle 检测 | **完全未交付** |
| "无缝回弹" | 恢复光标 + 闪烁 | **基本交付** |

**v7.1 修正：诚实的产品定位**

- 标题从"注意力经纪人"改为 **"零阻力上下文切换"**
- 核心价值从"识别/托管/保全/回弹"改为 **"保存/恢复/导航/提醒"**（均已交付或可交付）
- 明确声明系统边界：**物理上下文**（光标、滚动、编辑位置）的保存/恢复是核心能力；**认知上下文**（思路、问题、情境）的重建交给用户

**未来路线图预留**：

| Phase | 能力 | 技术手段 |
|-------|------|---------|
| **v7.1（当前）** | 零阻力的物理上下文保存/恢复 | 光标 + 内容锚点 + 闪烁 |
| **Phase N（未来）** | 认知上下文摘要："你上次在解决什么问题" | LLM 集成（本地 or API），基于任务内容 + 编辑差异自动生成一句话摘要 |

LLM 摘要是唯一能跨越"物理上下文→认知上下文"鸿沟的技术手段。当前 LLM 成本和速度已可行（Edge Function 代理 + Groq API），但应在 v7.1 完成验证后再引入。

### 2.8.9 v7.1 修正汇总对照表

| 编号 | 修正项 | v7.0 行为 | v7.1 行为 | 影响范围 |
|------|--------|-----------|-----------|---------|
| 1 | 查看 vs 切换 | 单击=切换 | 单击=预览，双击/按钮=切换 | ParkingService、UI 卡片 |
| 2 | 驱逐提示 | 3s 自动消失 | Intent-based + 15s fallback | StatusBarNotice |
| 3 | 闪烁时长 | 200ms 脉冲 | 1000ms 三段式 | CSS animation |
| 4 | 超限策略 | MAX=5 数量硬限 | 48h 时间衰老 + 软上限 15 | ParkingService |
| 5 | Mission Control | ≥2 弹窗 | 常驻侧边栏 | UI 布局 |
| 6 | Snooze | 无 | "5 分钟后再提醒" × 3 | SimpleReminderService |
| 7 | 滚动位置 | 像素值 scrollTop | 内容锚点 + 百分比回退 | ParkingSnapshot、ContextRestoreService |
| 8 | 产品叙事 | "注意力经纪人" | "零阻力上下文切换" | 标题、Section 1.3 |

### 2.8.10 对"过度推演"批评项的回应

以下批评有道理，但 v7.1 选择不做修改（附理由）：

| 批评项 | v7.1 立场 | 理由 |
|--------|-----------|------|
| "结构化锚点对非技术用户失效" | **部分认同，增加优先级规则** | 系统已按内容类型分层提取（Heading/列表/代码/GoJS），对非代码任务展示的是标题+段落，非技术用户可读。v7.1 新增规则：**对非代码任务优先展示任务标题+内容片段而非函数名** |
| "只有一个 active 任务违反现实" | **不修改** | "左屏需求文档+右屏写代码+Slack 窗口"在 NanoFlow 语境下是**一个任务的三个工作面**，不是三个任务。"Feature A 被打断去修 Bug B"才是真正的多任务——此时只有一个 active 是合理的简化 |
| "被打断后不一定想回来" | **已通过手动清理解决** | v7.1 为 parked 卡片增加 × 按钮和左滑删除手势，用户 0.3s 即可清理不需要的 parked 项；48h 自动衰老也会清理遗忘的停泊任务 |
| "遗忘程度 ≠ 离开时长" | **v7.0 已正确处理** | v7.0 统一为"闪烁最后编辑位置"不按时长分级，v7.1 将闪烁改为 1000ms 三段式，效果已足够。大脑的认知上下文重建应交给用户自己——看一眼内容就能回忆 |

---

## 3. 与现有架构的关系

### 3.1 现有 Focus Mode 定位

NanoFlow 已有的 Focus Mode 包含四大子模块：

| 现有模块 | 功能 | 与 State Overlap 的关系 |
|---------|------|------------------------|
| **Gate（大门）** | 每日首次打开时结算遗留 | 可扩展为包含"孵化中任务的状态检查" |
| **Spotlight（聚光灯）** | 单任务聚焦执行 | **演化为 Focus Pod（专注舱）** |
| **Strata（地质层）** | 已完成任务按天沉积 | 保持不变，增加"孵化完成"类沉积 |
| **Black Box（黑匣子）** | 语音紧急捕捉 | 保持不变，作为灵感速记入口 |

### 3.2 演化策略（非替代）

State Overlap **不是替换** Focus Mode，而是其自然扩展：

```
Focus Mode v1（当前）：
  Gate → Spotlight → Strata
         ↑
    Black Box（随时插入）

Focus Mode v2（+ State Overlap）：
  Gate → [ Focus Pod ←→ Incubator ] → Strata
           ↑               ↑
      Black Box       Metronome（协调层）
```

关键变化：
- **Spotlight → Focus Pod**：从"队列中逐个处理"升级为"持有当前唯一心智焦点 + 感知后台状态"
- **新增 Incubator**：承载不需要持续心智介入的后台任务
- **新增 Metronome**：协调 Focus Pod 与 Incubator 之间的"注意力切换契机"

### 3.3 现有可复用资源

| 现有资源 | 复用方式 |
|---------|---------|
| Task 模型的 `priority` 字段（预留） | 激活，映射为心智负载的参考输入之一 |
| Task 模型的 `tags` 字段（预留） | 激活，用于标记任务属性（如 `cognitive:high`、`blocking:async`） |
| `spotlightTask` signal | 演化为 `focusPodTask` signal |
| `spotlightMode` signal | 演化为 `overlapMode` signal |
| `SpotlightService` | 核心逻辑复用，扩展为 `FocusPodService` |
| `UiStateService.activeView` | 扩展支持 `'overlap'` 视图模式 |
| `focusPreferences` | 扩展新增 Overlap 相关偏好 |

---

## 4. 数据模型设计

### 4.0 v7.0 简化模型

> **v7.0 核心变更**：将 `TaskOverlapMeta` 从 15+ 字段精简到 4 个字段。删除 Checkpoint、cognitiveLoad、blockingType、screenshotDataUrl、operationTrail 等复杂结构。

```typescript
/**
 * v7.0 简化：任务的停泊元数据
 * 仅保存上下文恢复所需的最小信息
 */
interface TaskParkingMeta {
  /** 停泊状态：active（当前 Focus）/ parked（稍后处理） */
  parkingState: 'active' | 'parked';

  /** 停泊时间（ISO string），进入 parked 状态时自动记录 */
  parkedAt?: string | null;

  /**
   * 上下文快照：从 Focus 切走时自动保存
   * 仅包含恢复光标/滚动所需的最小数据
   */
  contextSnapshot?: ParkingSnapshot | null;

  /**
   * 可选提醒时间（ISO string）
   * 用户停泊任务时选择"5 分钟后提醒"等设置
   * null = 不提醒
   */
  reminderAt?: string | null;
}

/**
 * v7.0 简化：停泊快照
 * 删除 operationTrail、screenshotDataUrl、taskTypeIcon 等复杂字段
 * 【v7.1 修正】scrollPosition 从像素值改为内容锚点（§2.8.7）
 */
interface ParkingSnapshot {
  /** 最后编辑位置 */
  cursorPosition: { line: number; column: number } | null;
  /**
   * 【v7.1】滚动位置改为内容锚点（跨设备/跨窗口稳定）
   * v7.0 原设计：{ top: number; left: number }（像素值，跨设备失效）
   */
  scrollPosition: {
    /** 内容锚点定位方式 */
    anchorType: 'paragraph' | 'heading' | 'line';
    /** 锚点元素序号（段落序号 / heading 序号 / 行号） */
    anchorIndex: number;
    /** 段落内偏移行数（可选） */
    anchorOffset?: number;
    /** 百分比回退：无法提取内容锚点时使用（0-1） */
    scrollPercent: number;
  } | null;
  /** 快照时间 */
  savedAt: string;
  /** content 哈希，用于检测回来后内容是否被外部修改 */
  contentHash: string;
  /**
   * 结构化锚点签名（保留自 v4.0，实现简单且有用）
   * 格式："在 [结构锚点] [物理动作]"
   * 例："在 connectDB() 中编辑" / "在『认证流程设计』一节阅读"
   */
  structuralAnchor?: {
    type: 'heading' | 'function' | 'list-item' | 'paragraph' | 'gojs-node' | 'fallback';
    label: string;
    line?: number;
  } | null;
}
```

**v7.0 与 v6.0 数据模型对比**：

| 维度 | v6.0 TaskOverlapMeta | v7.0 TaskParkingMeta |
|------|---------------------|---------------------|
| 字段数 | ~15（cognitiveLoad/blockingType/checkpoints/estimatedDuration/startedAt/overlapState/contextSnapshot...） | **4**（parkingState/parkedAt/contextSnapshot/reminderAt） |
| 快照字段数 | ~12（cursorPosition/scrollPosition/resumeNote/savedAt/contentHash/operationTrail/screenshotDataUrl/semanticSignature/structuralAnchor/taskTypeIcon...） | **5**（cursorPosition/scrollPosition（内容锚点）/savedAt/contentHash/structuralAnchor） |
| 依赖外部库 | html2canvas | **无** |
| 同步体积 | 中（含 operationTrail 数组 + base64 截图） | **极小**（纯文本 < 500 字节） |

> 注：以下 4.1-4.4 为 v1.0-v6.0 的历史数据模型，保留供参考和回退。v7.0 实现应使用上述简化模型。

### 4.1 任务属性扩展：TaskOverlapMeta（v1.0-v6.0 历史设计）

在现有 Task 模型上新增 overlap 元数据，采用**可选扩展字段**策略（不破坏现有字段）：

```typescript
/**
 * 任务的「注意力属性」——描述任务对用户心智的需求画像
 * 这是 State Overlap 系统判断任务应处于前台/后台的核心依据
 *
 * 【v2.0 变更】所有属性均为可选，由 OverlapAttributionService 自动推断。
 * 用户只需执行「送入孵化器」操作，无需手动填写任何字段（Zero-Config 入舱）。
 */
interface TaskOverlapMeta {
  /** 心智负载等级（可选，系统自动推断） */
  cognitiveLoad?: CognitiveLoad;

  /** 阻塞性（可选，系统自动推断） */
  blockingType?: BlockingType;

  /** 锚点列表：后台任务在何时需要人类介入（可选，系统可自动生成） */
  checkpoints?: Checkpoint[];

  /**
   * 预计持续时间（分钟）
   * 【v2.0 变更】不再驱动进度条。仅在 hover 时用于辅助信息展示。
   * null = 不显示任何时间预估（大多数任务的合理默认值）
   */
  estimatedDuration?: number | null;

  /** 实际开始时间（ISO string），进入孵化器后自动记录 */
  startedAt?: string | null;

  /** 当前重叠状态：任务在 overlap 系统中的位置 */
  overlapState: OverlapState;

  /**
   * 思维快照：从 Focus Pod 切走时自动保存的上下文
   * 【v2.0 变更】快照由系统全自动采集，包含操作轨迹，用于 Context Warm-up
   */
  contextSnapshot?: ContextSnapshot | null;
}

/** 心智负载分级 */
type CognitiveLoad = 'deep' | 'moderate' | 'shallow' | 'passive';

/** 阻塞类型 */
type BlockingType =
  | 'synchronous'    // 必须人持续参与（写代码、构思）
  | 'semi-async'     // 间歇性介入（代码审查、回复讨论）
  | 'asynchronous';  // 设定后自行运行（编译、渲染、等待回复）

/** 锚点：后台任务需要人介入的预设时机 */
interface Checkpoint {
  id: string;              // crypto.randomUUID()
  label: string;           // 用户自定义标签，如"编译完成后部署"
  triggerType: CheckpointTrigger;
  triggerValue: number | string;  // 时间(分钟) 或 进度百分比 或 自定义条件描述
  status: 'pending' | 'triggered' | 'handled' | 'skipped';
  triggeredAt: string | null;
  handledAt: string | null;
}

/** 锚点触发方式 */
type CheckpointTrigger =
  | 'timer'          // 倒计时到达
  | 'progress'       // 进度百分比到达
  | 'manual';        // 用户手动触发（如"对方回复时"）

/** 任务在 Overlap 系统中的状态 */
type OverlapState =
  | 'none'           // 未参与 overlap 流程
  | 'focus'          // 在 Focus Pod 中（前台主角）
  | 'incubating'     // 在 Incubator 中（后台运行）
  | 'checkpoint'     // 到达锚点，等待用户介入
  | 'paused'         // 孵化暂停（用户手动）
  | 'hibernated'     // 【v5.0 新增】静默冷冻（系统自动将挂起切片超限时的最久闲置切片送入孵化器）
  | 'hatched';       // 孵化完成（可拉入 Strata 沉积）

/**
 * 思维快照：用户从 Focus Pod 切走时**全自动**保存的上下文
 * 【v2.0 变更】新增 operationTrail + screenshotDataUrl 用于 Context Warm-up 机制
 * 【v3.0 变更】新增 semanticSignature 用于 Mission Control 语义签名导航；
 *            screenshotDataUrl 降级为可选辅助（不再作为切片识别主力）
 *
 * 解决问题：机器快照 ≠ 大脑快照。系统默认用户记不住切走前在干嘛，
 * 通过操作轨迹和语义签名帮助人脑重建工作记忆。
 */
interface ContextSnapshot {
  /** 最后编辑位置（行号/段落标识） */
  cursorPosition: { line: number; column: number } | null;

  /** 最后可见的内容区域 */
  scrollPosition: { top: number; left: number } | null;

  /**
   * 用户备注（可选）
   * 【v2.0 变更】不再在切走时弹出输入框要求填写。
   * 仅当用户主动点击"添加备注"时才出现，不作为核心依赖。
   */
  resumeNote?: string;

  /** 快照时间 */
  savedAt: string;

  /** 切走前的 content 哈希，用于检测回来后内容是否被外部修改 */
  contentHash: string;

  // ═══════════ v2.0 新增：Context Warm-up 数据 ═══════════

  /**
   * 操作轨迹：切走前最后 5 分钟的操作摘要
   * 用于回弹时展示"你刚才在做什么"的时间线
   */
  operationTrail: OperationTrailEntry[];

  /**
   * 切走瞬间的 Focus Arena 模糊截图（base64 data URL）
   * 【v3.0 降级】不再用于 Mission Control 切片识别（改用语义签名）。
   * 仅在 `full` 级别 Context Warm-up 遮罩中使用，提供视觉连续性。
   * 限制：最大 200KB，超出则不保存
   */
  screenshotDataUrl?: string | null;

  // ═══════════ v3.0 新增 ═══════════

  /**
   * 语义签名：基于内容结构化锚点 + 物理动作自动生成
   * 【v4.0 重构】从 NLP 自由推断改为结构化锚点提取：
   * - Markdown → 最近的 Heading (H2/H3)
   * - 代码 → 当前光标所在的 Function/Class 名称
   * - 列表 → 最近的顶级列表项
   * - 纯文本 → 段落序号 + 首句关键词
   * - GoJS → 当前选中/最后编辑的节点名称
   * - 兜底 → task.title 前 30 字符
   * 格式："最后停在：在 [结构锚点] [物理动作]"
   *
   * 例："最后停在：在 connectDB() 中编辑"
   * 例："最后停在：在『认证流程设计』一节阅读"
   */
  semanticSignature: string;

  /**
   * 【v4.0 新增】结构化锚点原始数据
   * 保留结构化锚点的详细信息，供 Context Warm-up 精准定位
   */
  structuralAnchor: {
    /** 锚点类型 */
    type: 'heading' | 'function' | 'list-item' | 'paragraph' | 'gojs-node' | 'fallback';
    /** 锚点标识（如 heading 文本、函数名、段落序号等） */
    label: string;
    /** 光标所在行号（用于精确定位） */
    line?: number;
    /**
     * 【v5.0 新增】临近度退级微观纹理
     * 当光标距最近结构锚点 > PROXIMITY_LINE_THRESHOLD(30) 行时，
     * 自动填充当前行的前 15 个非空字符，用于增强位置记忆唤醒精度。
     * 格式：原始文本（未截断），UI 层负责截断和 `『...』` 包裹。
     * 若光标行内容 < 3 字符则为 null。
     */
    proximityText?: string | null;
  };

  /**
   * 任务类型图标标识：基于任务内容/标题自动推断
   * 用于 Mission Control 面板的视觉区分
   */
  taskTypeIcon: 'document' | 'code' | 'communication' | 'data' | 'design' | 'generic';

  /** 离开时长（回弹时动态计算，非存储字段） */
  // absentDuration 由 ContextWarmUpService 在 restore 时实时计算
  // 【v3.0】用于驱动三级预热响应（instant / gentle / full）
}

/**
 * 操作轨迹条目：记录用户在切走前的操作
 * 用于 Context Warm-up 的时间线展示
 */
interface OperationTrailEntry {
  /** 操作类型 */
  type: 'edit' | 'scroll' | 'navigate' | 'select';
  /** 操作描述（自动生成，如 "编辑了第 42-45 行"、"滚动到第 3 段"） */
  description: string;
  /** 操作时间（ISO string） */
  timestamp: string;
  /** 关联的内容摘要（如编辑的行内容前 50 字符） */
  contentPreview?: string;
}
```

### 4.2 Task 模型扩展方案

```typescript
// src/models/index.ts — 在现有 Task 接口中新增可选字段
interface Task {
  // ... 现有字段保持不变 ...

  /** State Overlap 元数据，null 表示未启用 overlap 管理 */
  overlapMeta?: TaskOverlapMeta | null;
}
```

**设计决策说明：**
- 使用 `overlapMeta` 单字段包裹，而非在 Task 顶层平铺多个字段，原因：
  1. 最小化对现有同步逻辑的冲击（`content` 字段同步查询不变）
  2. 未启用 overlap 的任务 `overlapMeta = null`，零额外序列化开销
  3. 便于整体丢弃/重置

### 4.3 孵化器条目视图模型

```typescript
/**
 * 孵化器中展示的任务卡片视图模型
 * 从 Task + TaskOverlapMeta 计算得出，非独立存储
 *
 * 【v2.0 变更】废弃 progressPercent 动态进度条，改用静态状态图标。
 * 【v3.0 变更】新增 inferenceConfidence 用于 Correction Toast 置信度可视化。
 * 解决问题：进度条动画持续吸血周边视觉（Peripheral Vision 对运动极敏感）。
 */
interface IncubatorCard {
  taskId: string;
  title: string;
  blockingType?: BlockingType;

  /**
   * 【v2.0 变更】静态状态图标，替代动态进度条
   * 侧边栏在未触发锚点前保持绝对静态，杜绝视觉噪音
   */
  statusIcon: 'hourglass' | 'paused' | 'checkpoint' | 'hatched';

  /** 计算属性：下一个待触发的锚点 */
  nextCheckpoint: Checkpoint | null;

  /**
   * 【v2.0 变更】提醒级别增加 'suppressed' 状态
   * 当用户处于键盘/鼠标活跃状态时，所有提醒锁定在 suppressed
   */
  alertLevel: 'suppressed' | 'calm' | 'notice' | 'alert';

  /** 计算属性：孵化时长（分钟），仅 hover 时展示 */
  elapsedMinutes: number;

  /** 计算属性：预计剩余时间（分钟），仅 hover 时展示，null = 无估时 */
  remainingMinutes: number | null;

  /**
   * 【v3.0 新增】推断置信度
   * 驱动 Correction Toast 的行为：低置信度时延长 Toast 展示 + 高亮 [修改] 按钮
   */
  inferenceConfidence: 'high' | 'medium' | 'low';
}
```

### 4.4 数据库存储（Supabase 扩展）

```sql
-- 在 tasks 表新增 JSONB 列存储 overlap 元数据
ALTER TABLE tasks
  ADD COLUMN overlap_meta JSONB DEFAULT NULL;

-- 为孵化中任务建索引（查询"我有哪些后台运行中的任务"）
CREATE INDEX idx_tasks_overlap_state
  ON tasks USING gin ((overlap_meta->'overlapState'));

-- RLS 策略自动继承（已有 user_id 隔离）
```

---

## 5. 状态管理设计

### 5.1 Signal 状态结构

```typescript
// src/state/overlap-stores.ts

import { signal, computed } from '@angular/core';

// ═══════════════════════════════════════════
// 核心状态
// ═══════════════════════════════════════════

/** Overlap 模式是否激活 */
export const overlapMode = signal<boolean>(false);

/** 当前 Focus Pod 中的任务 ID（null = 空闲） */
export const focusPodTaskId = signal<string | null>(null);

/** 当前孵化器中的任务 ID 集合（有序，按加入时间） */
export const incubatingTaskIds = signal<string[]>([]);

/**
 * 【v2.0 变更】挂起切片列表，替代 v1.0 的暂存栈（PauseStack）
 * 解决问题：Stack (LIFO) 在多层嵌套时制造认知失调 + 硬限制"教用户做事"
 *
 * 每个切片保存独立的上下文快照，用户可自由跳转到任意切片（非强制后进先出）
 */
export const suspendedSlices = signal<SuspendedSlice[]>([]);

/**
 * 【v2.0 新增 → v3.0 重构 → v6.0 简化】用户活跃状态——驱动焦点抑制（Focus Suppression）
 * v6.0 变更：废弃三层推断模型和贝叶斯评分，简化为二元判定（有事件=active，超时=idle）
 */
export const userActivityState = signal<'active' | 'idle'>('idle');

/**
 * 【v3.0 新增 → v6.0 废弃】离席置信度
 * v6.0：不再使用 0-100 评分模型，改为简单的二元超时判定
 * 保留字段仅用于调试/日志，不参与核心判定逻辑
 */
// export const absenceConfidence = signal<number>(0);  // v6.0 deprecated

/**
 * 【v4.0 新增 → v6.0 内部化】多屏自动检测（原 Companion Mode）
 * v6.0 变更：不再作为用户面向概念——系统自动检测多屏行为并适配
 * 不弹窗、不通知、不需要用户理解"伴随模式"概念
 */
export const multiScreenDetected = signal<boolean>(false);

/** 节拍器通知队列（待处理的锚点提醒） */
export const metronomeAlerts = signal<MetronomeAlert[]>([]);

// ═══════════════════════════════════════════
// 计算属性
// ═══════════════════════════════════════════

/** Focus Pod 中任务的完整数据（从 TaskStore 关联） */
// export const focusPodTask = computed(() => { ... });

/** 孵化器中所有任务的卡片视图 */
// export const incubatorCards = computed(() => { ... });

/** 是否有需要处理的锚点提醒（仅统计非 suppressed 状态） */
// export const hasActiveAlerts = computed(() => metronomeAlerts().some(a => a.status === 'active'));

/** 当前活跃的锚点提醒数量（用于徽标显示） */
// export const activeAlertCount = computed(() => metronomeAlerts().filter(a => a.status === 'active').length);

/**
 * 【v2.0 新增】是否应显示 Mission Control 全景面板
 * 当挂起切片 >= 2 时，bounceBack 弹出全景面板而非直接跳回
 */
// export const shouldShowMissionControl = computed(() => suspendedSlices().length >= 2);

// ═══════════════════════════════════════════
// 辅助类型
// ═══════════════════════════════════════════

/** 挂起切片：替代 v1.0 的暂存栈条目 */
interface SuspendedSlice {
  taskId: string;
  /** 挂起时间（ISO string） */
  suspendedAt: string;
  /** 该切片的上下文快照（含操作轨迹 + 语义签名） */
  snapshot: ContextSnapshot;
  /**
   * 【v3.0 新增 → v4.0 更新】结构化锚点签名快捷访问
   * 从 snapshot.semanticSignature 冗余缓存
   * 用于 Mission Control 面板快速渲染，避免遍历嵌套属性
   * v4.0：基于结构化锚点（Heading/Function/段落）而非 NLP 推断
   */
  semanticSignature: string;
  /**
   * 【v3.0 新增】任务类型图标（从 snapshot.taskTypeIcon 冗余缓存）
   */
  taskTypeIcon: 'document' | 'code' | 'communication' | 'data' | 'design' | 'generic';
  /**
   * 【v5.0 新增】静默冷冻时间戳（ISO string）
   * 当挂起切片数超过 MAX_SUSPENDED_SLICES 时，系统自动将最久闲置的切片
   * 标记为 hibernated 并平移到孵化器底部。此字段记录冷冻时刻。
   * null = 未被冷冻（正常挂起切片）
   */
  hibernatedAt?: string | null;
}

interface MetronomeAlert {
  id: string;
  taskId: string;
  checkpointId: string;
  checkpointLabel: string;
  status: 'active' | 'dismissed' | 'handled';
  triggeredAt: string;
  /**
   * 【v2.0 变更】新增 'suppressed' 级别
   * 用户活跃时自动锁定为 suppressed，停止升级计时
   */
  urgencyLevel: 'suppressed' | 'calm' | 'notice' | 'alert';
  /** 【v2.0 新增】在用户 idle 状态下累计的时间（ms），用于升级判断 */
  idleAccumulatedMs: number;
}
```

### 5.2 与现有 Store 的关系

```
TaskStore（已有）                    Overlap Stores（新增，v2.0）
┌──────────────────────┐           ┌────────────────────────────┐
│ tasksMap: Map<id,Task>│──引用────→│ focusPodTaskId: string     │
│   ↳ overlapMeta 字段  │          │ incubatingTaskIds: []      │
│                      │          │ suspendedSlices: []  ← 新   │
│ tasksByProject: ...  │          │ userActivityState    ← 新   │
│                      │          │ metronomeAlerts: []         │
│                      │          │ overlapMode: boolean        │
└──────────────────────┘          └────────────────────────────┘
        ↑ 写入                          ↑ 协调
        │                              │
  TaskOperationAdapter            OverlapService（新增）
        Service（已有）
```

**原则**：Overlap Stores 只保存"位置信息"（哪个任务在哪个轨道），任务本身的数据仍在 `TaskStore.tasksMap` 中（含 `overlapMeta`），通过 ID 引用。

---

## 6. 服务层架构

### 6.0 v7.0 简化服务架构

> **v7.0 核心变更**：从 8 个服务削减到 3 个。删除 MetronomeService、OverlapAttributionService、IntentDismissalService、UserActivityService（大幅简化）。

```
src/services/
├── overlap/
│   ├── parking.service.ts              # 【v7.0】停泊管理（替代 OverlapService + FocusPodService + IncubatorService）
│   ├── context-restore.service.ts      # 【v7.0】上下文保存/恢复（替代 ContextWarmUpService，删除截图/轨迹/预热）
│   └── simple-reminder.service.ts      # 【v7.0】简单提醒（替代 MetronomeService，仅定时通知）
```

#### 6.0.1 `ParkingService`（停泊管理 — v7.0）

```typescript
/**
 * v7.0 简化：统一管理任务的"当前"/"稍后"状态切换
 * 合并了 v6.0 的 OverlapService + FocusPodService + IncubatorService
 *
 * 核心逻辑：
 * 1. 用户显式切换到另一个任务（双击/[开始做]） → 当前任务自动 parked
 * 2. 自动保存上下文快照（光标 + 内容锚点 + 结构化锚点）
 * 3. 超过 48 小时未访问的停泊任务自动移回普通列表（v7.1）
 *
 * 【v7.1 修正】分离"查看"和"切换"（§2.8.1）：
 * - previewTask()：单击，仅查看详情，不切换 Focus
 * - switchFocus()：双击/[开始做] 按钮，执行真正的 Focus 切换
 * 【v7.1 修正】超限策略从数量硬限改为时间衰老（§2.8.4）
 */
@Injectable({ providedIn: 'root' })
class ParkingService {
  private contextRestore = inject(ContextRestoreService);
  private simpleReminder = inject(SimpleReminderService);

  /** 当前 Focus 任务 ID */
  readonly activeTaskId = signal<string | null>(null);

  /** 停泊任务列表（有序，按停泊时间排列） */
  readonly parkedTasks = signal<ParkedTask[]>([]);

  /** 停泊列表始终可见（v7.1：废弃弹窗式 Mission Control，§2.8.5） */
  readonly showParkingSidebar = computed(() => this.parkedTasks().length >= 1);

  /**
   * 【v7.1 新增】预览任务详情——不切换 Focus，不停泊当前任务
   * 单击停泊卡片时调用，打开详情面板或面包屑预览
   */
  previewTask(taskId: string): void;

  /**
   * 切换 Focus 到目标任务（仅在双击/[开始做]按钮时调用）
   * 1. 如果当前有 active 任务 → 自动保存上下文 → 状态变为 parked
   * 2. 如果目标任务是 parked → 从 parked 列表移除 → 设为 active
   * 3. 恢复目标任务的上下文快照（内容锚点）
   * 4. 检查停泊任务时间衰老
   */
  switchFocus(targetTaskId: string): void;

  /**
   * 手动停泊一个任务（可选设置提醒）
   * @param reminderMinutes 可选，N 分钟后提醒
   */
  parkTask(taskId: string, reminderMinutes?: number): void;

  /**
   * 从 parked 列表中恢复到 Focus（= switchFocus 的别名）
   * v7.1：直接切换，不再弹出 Mission Control 面板
   */
  restoreTask(taskId: string): void;

  /**
   * 【v7.1 新增】手动移除停泊任务——卡片 [×] 按钮 / 左滑删除
   */
  removeParkedTask(taskId: string): void;

  /** 退出 Overlap 模式 */
  exitOverlapMode(): void;

  /**
   * 【v7.1 修正】停泊任务时间衰老检查
   * 48 小时未访问 → 自动移回普通任务列表 + Intent-based 通知
   */
  private checkStaleParkedTasks(): void;

  /** 【v7.1】废弃硬限制，改用时间衰老 + 软上限 */
  readonly PARKED_TASK_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48h
  readonly PARKED_TASK_SOFT_LIMIT = 15;
}

/** 停泊任务 */
interface ParkedTask {
  taskId: string;
  /** 停泊时间 */
  parkedAt: string;
  /** 上下文快照 */
  snapshot: ParkingSnapshot;
  /** 结构化锚点签名（从 snapshot 缓存，用于快速渲染） */
  anchorLabel?: string;
  /** 提醒时间（如有） */
  reminderAt?: string | null;
}
```

#### 6.0.2 `ContextRestoreService`（上下文保存/恢复 — v7.0）

```typescript
/**
 * v7.0 简化：仅负责保存和恢复光标/滚动位置 + 结构化锚点提取
 * 删除：操作轨迹录制、截图、三级预热、Memory Aid Panel
 *
 * 恢复行为统一为：
 * 1. 恢复光标位置
 * 2. 通过内容锚点恢复滚动位置（v7.1：§2.8.7）
 * 3. 最后编辑行闪烁一次（1000ms 三段式动画，v7.1：§2.8.3）
 * 4. 如果 contentHash 变化 → 放弃滚动恢复，仅恢复光标 + 底部提示"离开期间内容已被修改"
 * 5. 无预热条、无面板、无遮罩
 */
@Injectable({ providedIn: 'root' })
class ContextRestoreService {
  /** 保存当前 Focus 任务的上下文（v7.1：滚动位置保存为内容锚点） */
  saveSnapshot(taskId: string): ParkingSnapshot;

  /** 恢复任务上下文——始终同一行为，不按时长分级 */
  restore(taskId: string, snapshot: ParkingSnapshot): void;

  /** 清除快照 */
  clearSnapshot(taskId: string): void;

  /**
   * 【v7.1 新增】提取内容锚点——基于段落/标题/行号定位，跨设备稳定
   * 优先级：heading > paragraph > line
   * 回退：无法提取锚点时使用 scrollPercent = scrollTop / scrollHeight
   */
  extractScrollAnchor(
    element: HTMLElement,
    cursorLine?: number
  ): ParkingSnapshot['scrollPosition'];

  /**
   * 【v7.1 新增】通过内容锚点恢复滚动位置
   * 1. 尝试 anchorType + anchorIndex 定位 → element.scrollIntoView()
   * 2. 锚点不存在 → 使用 scrollPercent 回退
   * 3. contentHash 已变 → 放弃滚动恢复，仅恢复光标
   */
  restoreScrollFromAnchor(
    snapshot: ParkingSnapshot,
    currentContentHash: string
  ): void;

  /**
   * 结构化锚点提取（保留自 v4.0，零 NLP 依赖）
   * - Markdown → 最近的 H2/H3 标题
   * - 代码块 → 当前 function/class 名
   * - 列表 → 顶级列表项
   * - GoJS → 选中节点名称
   * - 兜底 → task.title 前 30 字符
   * 【v7.1】对非代码任务优先展示任务标题+内容片段而非函数名
   */
  extractStructuralAnchor(
    task: Task,
    cursorLine?: number
  ): ParkingSnapshot['structuralAnchor'];
}
```

#### 6.0.3 `SimpleReminderService`（简单提醒 — v7.0）

```typescript
/**
 * v7.0 简化：替代复杂的 MetronomeService
 * 仅使用 setTimeout + 浏览器 Notification API
 * 无 Focus Suppression、无升级机制、无 idle 判定
 * 【v7.1 修正】增加 Snooze 机制（§2.8.6）
 */
@Injectable({ providedIn: 'root' })
class SimpleReminderService {
  /**
   * 设置一个提醒
   * @param taskId 关联的任务
   * @param reminderAt 提醒时间（ISO string）
   */
  setReminder(taskId: string, reminderAt: string): void;

  /**
   * 取消提醒
   */
  cancelReminder(taskId: string): void;

  /**
   * 【v7.1 新增】Snooze 提醒——5 分钟后再次触发
   * 每个提醒最多 Snooze 3 次（第 3 次后不再显示 Snooze 按钮）
   */
  snoozeReminder(taskId: string): void;

  /**
   * 提醒到达时的行为（v7.1 修正）：
   * 1. 底部 Snackbar 显示"「任务名」的提醒时间到了"
   *    + [切换过去] + [5 分钟后再提醒] + [忽略]
   * 2. 通知使用 Intent-based 消散（用户下次交互后消失，15s fallback）
   * 3. 如果用户授权了浏览器通知，同时发一条 Notification
   */
  private onReminderFired(taskId: string): void;

  /** 清理所有提醒 */
  clearAll(): void;

  /** 【v7.1】记录每个任务的 Snooze 次数 */
  private snoozeCount = new Map<string, number>();
  readonly MAX_SNOOZE_COUNT = 3;
}
```

**v7.0 → v7.1 服务交互流**：

```
用户操作                      服务层                      状态层
───────                     ──────                     ──────
单击停泊卡片              →  ParkingService
                            .previewTask(taskId)       → 打开详情面板（不切换）

双击/[开始做]             →  ParkingService
                            .switchFocus(targetId)
                            ├─ ContextRestore
                            │   .saveSnapshot(currentId)  → parkedTasks.update()
                            │   （保存光标+内容锚点+结构锚点）
                            │
                            ├─ activeTaskId.set(targetId)
                            │
                            └─ ContextRestore
                                .restore(targetId)        → 恢复光标 + 内容锚点滚动
                                                            + 1000ms 三段式闪烁

设置提醒                  →  SimpleReminder              → setTimeout 注册
                            .setReminder(taskId, time)

提醒到达                  →  SimpleReminder              → Intent-based Snackbar
                            .onReminderFired(taskId)       + [切换] [Snooze] [忽略]

点击 [Snooze]             →  SimpleReminder              → 5 分钟后重新触发
                            .snoozeReminder(taskId)

点击卡片 [×]              →  ParkingService              → 从 parkedTasks 移除
                            .removeParkedTask(taskId)

48h 衰老检查              →  ParkingService              → Intent-based 通知 + [撤回]
                            .checkStaleParkedTasks()
```

> 注：以下 6.1-6.3 为 v1.0-v6.0 的历史服务架构，保留供参考和回退。v7.0 实现应使用上述简化架构。

### 6.1 服务总览（v1.0-v6.0 历史设计）

```
src/services/
├── overlap/
│   ├── overlap.service.ts              # 总协调器
│   ├── focus-pod.service.ts            # Focus Pod 生命周期管理
│   ├── incubator.service.ts            # 孵化器管理
│   ├── metronome.service.ts            # 节拍器（锚点监控 + Focus Suppression）
│   ├── context-warm-up.service.ts      # 【v2.0 重命名】上下文预热（含快照 + 操作轨迹 + 截图）
│   ├── overlap-attribution.service.ts  # 【v2.0 升级为核心】Zero-Config 属性推断
│   ├── user-activity.service.ts        # 【v2.0 新增】用户活跃状态检测
│   └── intent-dismissal.service.ts     # 【v4.0 新增】全局意图消散管理
```

### 6.2 各服务职责

#### 6.2.0 `IntentDismissalService`（全局意图消散管理器 — v4.0 新增）

```typescript
/**
 * 【v4.0 新增】全局意图消散管理器
 *
 * 核心职责：统一管理所有"等待用户下一个实质性动作后消散"的 UI 元素。
 *
 * 设计哲学：v3.0 中所有 UI 元素（Correction Toast、Gentle 预热条）都用 setTimeout 来
 * 驱动消散。但人不是按秒表感知世界的，而是按**状态切换**。v4.0 将所有 Timer-based Dismissal
 * 统一替换为 Intent-based Dismissal —— 以用户的下一个实质性动作作为唯一消散信号。
 *
 * 为什么需要全局 Service 而非各组件自行监听？
 * 1. **去重**：Correction Toast 和 Gentle 预热条可能同时存在，各自监听 input / scroll
 *    会产生冗余事件绑定。全局 Service 只维护一套 listener，多个 UI 元素注册为 subscriber。
 * 2. **语义一致性**：所有可消散元素对"实质性动作"的定义必须统一（如 scroll 阈值 deltaY > 30px），
 *    避免"Toast 需要滚动 30px 才消散但预热条只需 10px"的认知不一致。
 * 3. **生命周期安全**：Service 在 Overlap 模式激活时启动，退出时统一清理。
 *    各组件的 OnDestroy 可能遗漏清理工作。
 * 4. **可测试性**：统一的 Service 可以在单元测试中模拟意图信号，验证所有 UI 元素的消散行为。
 */
@Injectable({ providedIn: 'root' })
class IntentDismissalService {
  /**
   * 注册一个可消散的 UI 元素
   *
   * @param id 唯一标识（如 'correction-toast'、'gentle-warmup-bar'）
   * @param config 消散配置
   * @param callback 消散时的回调（通常是触发淡出动画）
   * @returns 取消注册的函数
   */
  register(
    id: string,
    config: DismissalConfig,
    callback: () => void
  ): () => void;

  /**
   * 手动取消注册（组件销毁时的备用清理路径）
   */
  unregister(id: string): void;

  /**
   * 当前已注册的可消散元素数量（调试用）
   */
  readonly activeCount: Signal<number>;

  // ═══════════ 内部机制 ═══════════

  /**
   * 意图信号监听器
   * 全局只维护一套 listener，当 activeCount > 0 时激活，== 0 时自动清理
   *
   * 【v5.0 信号净化】监听的内容交互信号（全部使用 passive listener）：
   * - input → 用户在编辑区域产生了真实的输入内容（排除 Shift/Ctrl/Alt 等修饰键单独按下）
   * - compositionstart → 中文/日文等 IME 输入法开始 composing（input 未必立即触发）
   * - scroll → deltaY > INTENT_SCROLL_THRESHOLD（30px）
   * - selectionchange → selection.toString().length > 0（用户主动划选了文本）
   * - touchstart → 移动端触摸（仅限 Focus Pod 区域）
   *
   * 【v5.0 剔除的信号（Blind Click 修正）】：
   * - ~~keydown~~ → 盲点动作假阳性：用户按 Shift/Ctrl 切换输入法、按 CapsLock、
   *   甚至不小心碰到键盘，都不代表"已进入下一状态"
   * - ~~mousedown~~ → 盲点动作假阳性：用户切窗后随手点一下唤醒窗口（Blind Click），
   *   这不代表已读完 Toast / 预热条内容
   *
   * 排除信号（不触发消散）：
   * - hover 在可消散元素自身上 → 用户正在审阅该元素（如 hover 在 Toast 上）
   */
  private setupListeners(): void;

  /**
   * 意图信号触发时：遍历所有注册的元素，根据各自 config 判定是否消散
   */
  private onIntentSignal(signal: IntentSignal): void;
}

/**
 * 消散配置：每个可消散元素可以自定义哪些信号触发它的消散
 */
interface DismissalConfig {
  /** 监听区域（默认：Focus Pod 编辑区域） */
  listenScope: 'focus-pod' | 'global';
  /** 触发消散的信号类型（默认：全部） */
  dismissOnSignals: IntentSignalType[];
  /** hover 在元素本身时是否暂停消散判定（默认：true） */
  pauseOnHover: boolean;
  /**
   * 【v6.0 缩短】最大存活时长（ms）——从 60s 缩短为 15s
   * 10 秒无操作淡出 + 15 秒硬兜底的双重保险使 60 秒过于保守。
   */
  maxLifetimeMs: number;
  /**
   * 【v6.0 新增】无操作自动淡出时长（ms）——默认 10 秒
   * 用户看完信息后静静坐着思考时，UI 自行退场。
   * 解决问题："阅读型用户"不需要为了关 UI 而制造无意义的操作。
   */
  idleFadeoutMs: number;
  /**
   * 【v6.0 新增】是否允许 Escape 键关闭——默认 true
   * Escape 是全平台通用的"关闭"信号，每个人都知道按 Esc 是"我看完了"。
   */
  allowEscClose: boolean;
  /**
   * 【v6.0 新增】是否允许点击空白区域关闭——默认 true
   * 点击 Focus Pod 编辑区域外的空白处即视为"关闭"。
   * 不包含 mousedown（盲点击仍被排除），仅响应编辑区外的 click 事件。
   */
  allowBlankAreaClose: boolean;
}

type IntentSignalType = 'input' | 'compositionstart' | 'scroll' | 'selectionchange' | 'touchstart';

interface IntentSignal {
  type: IntentSignalType;
  event: Event;
  timestamp: number;
}
```

#### 6.2.1 `OverlapService`（总协调器）

```typescript
/**
 * State Overlap 的中枢协调器
 * 负责在 Focus Pod、Incubator、Metronome 之间调度注意力
 *
 * 【v2.0 变更】
 * - contextSnapshot → contextWarmUp（含操作轨迹 + 自动截图）
 * - bounceBack() 支持 Mission Control 全景选择
 * - sendToIncubator() 默认 Zero-Config 入舱
 */
@Injectable({ providedIn: 'root' })
class OverlapService {
  // 依赖注入
  private focusPod = inject(FocusPodService);
  private incubator = inject(IncubatorService);
  private metronome = inject(MetronomeService);
  private contextWarmUp = inject(ContextWarmUpService);
  private attribution = inject(OverlapAttributionService);

  /** 进入 Overlap 模式 */
  enterOverlapMode(focusTaskId: string): void;

  /** 退出 Overlap 模式，清理所有轨道 */
  exitOverlapMode(): void;

  /**
   * 核心：从 Focus Pod 切换到处理某个孵化器任务
   * 1. 自动保存当前 Focus Pod 任务的上下文（操作轨迹 + 截图，零用户操作）
   * 2. 将当前任务存为挂起切片（Suspended Slice）
   * 3. 将目标孵化器任务提升到 Focus Pod
   */
  switchFocus(targetIncubatingTaskId: string): void;

  /**
   * 【v2.0 变更】回弹逻辑重构
   * - 挂起切片 == 1：直接恢复 + 展示 Context Warm-up 预热层
   * - 挂起切片 >= 2：弹出 Mission Control 全景面板，用户自由选择
   */
  bounceBack(): void;

  /**
   * 【v2.0 新增】从 Mission Control 恢复指定切片（非 LIFO 顺序）
   */
  restoreSlice(taskId: string): void;

  /**
   * 将一个任务送入孵化器
   * 【v2.0 变更】Zero-Config 入舱——自动推断属性，用户无需填写任何表单
   * 【v3.0 变更】入舱后触发 Correction Toast（推断纠错窗口）
   * 【v4.0 变更】Correction Toast 改为 Intent-based 消散——不设倒计时，
   *   待用户在 Focus Pod 执行首次实质性动作后消散（由 IntentDismissalService 管理）
   */
  sendToIncubator(taskId: string, meta?: Partial<TaskOverlapMeta>): void;

  /**
   * 将孵化完成的任务拉出
   */
  hatchTask(taskId: string): void;
}
```

#### 6.2.2 `FocusPodService`（专注舱）

```typescript
/**
 * 管理当前唯一的心智焦点
 * 从 SpotlightService 演化而来，增加"暂离 + 自由恢复"能力
 *
 * 【v2.0 变更】废弃 PauseStack (LIFO)，改用 Suspended Slices（平行切片）
 * 解决问题：栈语义在多层嵌套时制造认知失调 + 硬限制令用户愤怒
 */
@Injectable({ providedIn: 'root' })
class FocusPodService {
  /** 设置当前聚焦任务 */
  setFocusTask(taskId: string): void;

  /** 清除聚焦（暂离） */
  clearFocus(): void;

  /**
   * 【v2.0 变更】挂起切片列表（替代 pauseStack）
   * 每个切片包含 taskId + 上下文快照，无顺序约束
   */
  readonly suspendedSlices: Signal<SuspendedSlice[]>;

  /** 将当前任务挂起为切片（自动采集上下文） */
  suspendCurrent(): void;

  /**
   * 【v2.0 变更】从挂起切片中恢复指定任务（自由选择，非 LIFO）
   * 若 slices.length == 1，直接恢复
   * 若 slices.length >= 2，由上层弹出 Mission Control 面板
   */
  restoreFromSlice(taskId: string): SuspendedSlice | null;

  /** 【v2.0 新增】将挂起切片中的任务批量送入孵化器 */
  sendSlicesToIncubator(taskIds: string[]): void;

  /**
   * 挂起切片软上限
   * 【v5.0 变更】超出时不再弹窗提示——系统自动将最久闲置的切片
   * 静默平移到孵化器底部（Silent Hibernation），标记 overlapState = 'hibernated'。
   * 用户无感知、不阻塞、不问"要不要清理"。
   */
  readonly MAX_SUSPENDED_SLICES = 5;
}
```

#### 6.2.3 `IncubatorService`（孵化器）

```typescript
/**
 * 管理后台运行中的任务集合
 * 维护进度推算、状态监控
 */
@Injectable({ providedIn: 'root' })
class IncubatorService {
  /** 将任务加入孵化器 */
  addTask(taskId: string): void;

  /** 从孵化器移除 */
  removeTask(taskId: string): void;

  /** 更新任务进度（手动 or 自动） */
  updateProgress(taskId: string, percent: number): void;

  /** 触发锚点 */
  triggerCheckpoint(taskId: string, checkpointId: string): void;

  /** 标记任务孵化完成 */
  markHatched(taskId: string): void;

  /** 暂停/恢复孵化 */
  togglePause(taskId: string): void;

  /** 获取孵化器卡片视图（computed） */
  readonly cards: Signal<IncubatorCard[]>;

  /** 最大孵化器容量（防止注意力过载） */
  readonly MAX_INCUBATING = 5;
}
```

#### 6.2.4 `MetronomeService`（节拍器）

```typescript
/**
 * 节拍器：监控孵化器中任务的锚点，在恰当时机发出非侵入式提醒
 * 核心原则：绝不弹窗打断、绝不夺取焦点
 *
 * 【v2.0 变更】引入焦点抑制（Focus Suppression）机制
 * 解决问题：基于墙上时间的 Alert Escalation 在用户心流状态下变成"催命闹钟"
 *
 * 新规则：
 * - 用户 active 状态 → 所有提醒锁定为 suppressed，升级计时暂停
 * - 用户 idle 状态 → 解除抑制，按 idle 累计时间升级
 * - 即 calm→notice 的"5 分钟"是 5 分钟的空闲时间，不是墙上时间
 */
@Injectable({ providedIn: 'root' })
class MetronomeService {
  private userActivity = inject(UserActivityService);

  /** 启动监控循环 */
  startMonitoring(): void;

  /** 停止监控 */
  stopMonitoring(): void;

  /** 处理某个提醒（用户点击后） */
  handleAlert(alertId: string): void;

  /** 忽略某个提醒 */
  dismissAlert(alertId: string): void;

  /** 当前活跃提醒列表 */
  readonly activeAlerts: Signal<MetronomeAlert[]>;

  // ═══════════ 内部机制 ═══════════

  /**
   * 定时器检查逻辑（每 30 秒）
   * - 遍历所有孵化中任务的 checkpoints
   * - 检测是否有 timer 类锚点到达
   * - 计算 progress 类锚点是否满足
   * - 生成 MetronomeAlert 并加入队列
   */
  private checkCycle(): void;

  /**
   * 【v2.0 变更】提醒强度计算——基于 idle 累计时间而非墙上时间
   * - suppressed：用户正在操作（active），视觉零变化
   * - calm：锚点刚触发且用户已 idle（铃铛图标，静态）
   * - notice：idle 累计 5 分钟未处理（底部状态栏文字提示）
   * - alert：idle 累计 15 分钟未处理（仅在 idle 时显示半透明气泡）
   *
   * 关键：升级时间在用户切回 active 时立即暂停，不会打断心流
   */
  private calculateUrgency(alert: MetronomeAlert): 'suppressed' | 'calm' | 'notice' | 'alert';
}
```

#### 6.2.5 `ContextWarmUpService`（上下文预热 — v4.0 Intent-driven + 结构化锚点）

```typescript
/**
 * 【v2.0 重命名】从 ContextSnapshotService 演化为 ContextWarmUpService
 * 【v3.0 重构】引入三级预热响应（Memory Decay Function）+ 语义签名生成
 * 【v4.0 重构】
 *   1. Gentle 级别从 2s 自动消散 → Intent-based 消散（由 IntentDismissalService 管理）
 *   2. 语义签名从 NLP 推断 → 结构化锚点提取（零 NLP 依赖）
 *
 * 不只是"保存/恢复光标"，而是帮助人脑重建工作记忆。
 *
 * v4.0 核心变更：
 * 1. restoreWithWarmUp() 中 gentle 级别不再设 setTimeout
 *    预热条静静停在底部，直到 IntentDismissalService 检测到用户首次恢复动作
 * 2. saveSnapshot() 使用结构化锚点生成 semanticSignature（零 NLP 依赖）
 *    - Markdown → 最近 Heading
 *    - 代码 → 当前 Function/Class 名
 *    - 列表 → 顶级列表项
 *    - 兜底 → task.title 前 30 字符
 * 3. screenshotDataUrl 降级为可选辅助，仅 full 级别使用
 */
@Injectable({ providedIn: 'root' })
class ContextWarmUpService {
  private intentDismissal = inject(IntentDismissalService);
  /**
   * 保存当前 Focus 任务的上下文——全自动，零用户交互
   * 自动采集：光标位置、滚动位置、操作轨迹（最近 5 分钟）、截图、语义签名
   *
   * 【v4.0 重构】语义签名改为结构化锚点提取（零 NLP 依赖）：
   * - Markdown 文档 → 从光标位置向上搜索最近的 ## / ### 标题
   * - 代码 → 解析光标所在的 function/class/method 名称（正则匹配）
   * - 列表/大纲 → 从光标位置向上搜索顶级列表项
   * - 纯文本 → 段落序号 + 首句关键词
   * - GoJS Flow → 当前选中/最后编辑的节点 text
   * - 兜底 → task.title 前 30 字符
   *
   * 【v5.0 新增】锚点临近度退级（Proximity Fallback）：
   * 当光标距最近结构锚点 > 30 行时，附加当前行前 15 字符作为微观纹理。
   * 例："在 `processData()` 内部，修改了『 let userAuthToken = ... 』"
   *
   * 物理动作标签：edit/scroll/select/navigate → 编辑/阅读/选中/浏览
   * 组合格式："最后停在：在 [结构锚点] [物理动作]"
   * 临近度退级格式："最后停在：在 [结构锚点] 内部，修改了『[前15字符]...』"
   *
   * 【v3.0 保留】taskTypeIcon 自动推断：
   * - 标题/内容含"文档/需求/方案" → 'document'
   * - 标题/内容含"代码/函数/组件/bug/修复" → 'code'
   * - 标题/内容含"邮件/回复/沟通/会议" → 'communication'
   * - 标题/内容含"数据/导出/报表/分析" → 'data'
   * - 标题/内容含"设计/原型/UI/UX" → 'design'
   * - 兜底 → 'generic'
   */
  saveSnapshot(taskId: string): ContextSnapshot;

  /**
   * 【v4.0 重构】恢复任务上下文——基于离开时长的三级动态响应 + Intent-driven 消散
   *
   * 1. 计算 absentDuration = Date.now() - snapshot.savedAt
   * 2. 根据 MEMORY_DECAY 阈值确定预热级别
   * 3. 按级别分发不同的 UI 反馈
   *
   * 三级响应：
   *
   * 【instant（< 2 分钟）】
   * - 直接恢复光标和滚动位置
   * - 最后修改的行微微闪烁一次（200ms 黄色脉冲后淡出）
   * - 不弹任何遮罩或浮层
   * - 用户感知：秒回，无任何阻力
   *
   * 【gentle（2 - 15 分钟）】—— v4.0 Intent-based 消散 / v5.0 信号净化
   * - 恢复光标和滚动位置
   * - 底部显示 60px 半透明浮层（含 ✕ 关闭按钮）：
   *   "离开 X 分 → 最后停在：在 [结构化锚点] [物理动作]"
   * - 【v4.0 变更】不设 setTimeout 自动消散
   *   预热条静静停在底部，直到：
   *   · 用户产生首次内容交互信号（input / compositionstart / scroll deltaY>30px / selectionchange span>0）
   *   · 或用户手动点击预热条上的 ✕
   *   由 IntentDismissalService 统一管理消散时机
   * - 无需点击确认
   *
   * 【full（> 15 分钟）】
   * - 先展示完整预热遮罩：
   *   · 操作轨迹时间线（最近 3 条）
   *   · 变更高亮（最后修改的 3 行，黄底 2s 淡出）
   *   · 离开时长（"你离开了 X 分 Y 秒"）
   *   · 模糊截图（如有 screenshotDataUrl）
   * - 用户必须点击"我想起来了，继续"
   * - 底层同步恢复光标和滚动位置
   *
   * 如果 contentHash 变化，所有级别额外提示"离开期间内容已被修改"
   *
   * @returns 使用的预热级别和快照数据
   */
  restoreWithWarmUp(taskId: string): { tier: WarmUpTier; snapshot: ContextSnapshot | null };

  /**
   * 清除快照
   */
  clearSnapshot(taskId: string): void;

  // ═══════════ 内部机制 ═══════════

  /**
   * 操作轨迹记录器：在 Focus Pod 中持续记录用户操作
   * 使用环形缓冲区，仅保留最近 5 分钟的操作
   */
  private trailRecorder: OperationTrailRecorder;

  /**
   * 截图采集：使用 html2canvas 或 DOM 快照生成模糊缩略图
   * 限制 200KB，超出则降低分辨率或放弃
   * 【v3.0 变更】仅 full 级别遮罩使用，不再用于 Mission Control
   */
  private captureScreenshot(): Promise<string | null>;

  /**
   * 【v3.0 新增】记忆衰减级别计算
   */
  private calculateWarmUpTier(absentDurationMs: number): WarmUpTier;

  /**
   * 【v4.0 重构】结构化锚点签名生成
   * 从内容的结构特征中提取人类天然能理解的定位信息 + 最后物理动作
   * 零 NLP 依赖——所有提取均基于结构正则匹配或 DOM/Model 位置查找
   */
  private generateSemanticSignature(trail: OperationTrailEntry[], task: Task, cursorLine?: number): string;

  /**
   * 【v4.0 新增 / v5.0 增强】结构化锚点提取 + 临近度退级
   * 根据内容类型（Markdown/代码/列表/GoJS/纯文本）提取最近的结构锚点
   *
   * 【v5.0 Proximity Fallback】：
   * 若 cursorLine - anchorLine > PROXIMITY_LINE_THRESHOLD(30)：
   *   → 在返回的 anchor 中追加 proximityText = 当前行前 15 字符
   *   → 签名格式变为"在 [锚点] 内部，修改了『[前15字符]...』"
   * 若当前行内容 < 3 字符 → proximityText = null（不附加）
   */
  private extractStructuralAnchor(
    task: Task,
    cursorLine?: number
  ): { type: string; label: string; line?: number; proximityText?: string | null };

  /**
   * 【v3.0 新增】任务类型图标推断
   */
  private inferTaskTypeIcon(task: Task): ContextSnapshot['taskTypeIcon'];
}

/** 【v3.0 新增】预热响应级别 */
type WarmUpTier = 'instant' | 'gentle' | 'full';
```

#### 6.2.6 `OverlapAttributionService`（Zero-Config 推断引擎 + Correction Toast — 系统核心）

```typescript
/**
 * 【v2.0 升级为系统绝对核心】
 * 【v3.0 增强】新增推断置信度 + Correction Toast 数据生成
 * 【v4.0 变更】Correction Toast 从 Timer-based → Intent-based 消散
 *   废弃 displayDuration，消散时机由 IntentDismissalService 管理
 *
 * 从 v1.0 的"辅助工具"提升为驱动整个 Overlap 系统的核心引擎
 *
 * 解决问题：手动配置 cognitiveLoad/blockingType/estimatedDuration 是反人性的，
 * 80% 的用户会因前置输入成本放弃使用。
 *
 * v3.0 修正：推断不可能 100% 准确。当系统判断错误时，用户需要一个
 * 零成本的即时纠错机制（Correction Toast），而不是事后去侧边栏翻找。
 * v4.0 修正：3 秒倒计时引发注意力反向拉扯。改为 Intent-based 消散——
 * Toast 不设倒计时，待用户在 Focus Pod 执行首次实质性动作后消散。
 *
 * 设计原则：Zero-Config 入舱——拖拽/右键即可送入孵化器，所有属性自动推断。
 * 错误推断可通过 Correction Toast 在 3 秒内一键修正。
 */
@Injectable({ providedIn: 'root' })
class OverlapAttributionService {
  /**
   * 根据任务内容/标签/历史行为推断属性
   * 在 sendToIncubator() 时自动调用，用户无需任何输入
   *
   * 推断规则链（按优先级）：
   * 1. 关键词匹配：标题/内容含"等待/waiting/pending" → async + manual 锚点
   * 2. 高认知动词：含"编写/开发/设计/review" → deep + synchronous
   * 3. URL 检测：内容包含 URL → 创建 manual 锚点"链接内容就绪时"
   * 4. 时间提取：标题含数字+时间单位（"跑 10 分钟"） → timer 锚点 + estimatedDuration
   * 5. 截止日期：dueDate < 24h → urgencyLevel 提升
   * 6. 历史行为：用户过去对类似任务的属性选择（Phase 4 引入）
   * 7. 兜底默认：cognitiveLoad: 'moderate', blockingType: 'semi-async', estimatedDuration: null
   */
  inferMeta(task: Task): Partial<TaskOverlapMeta>;

  /**
   * 提供属性选择的预设模板（一键快捷方式，非必选项）
   */
  readonly templates: OverlapTemplate[];

  /**
   * 【v2.0 新增】推断置信度
   * 让 UI 可以在低置信度时温和提示"你可以调整这些设置"
   */
  getInferenceConfidence(task: Task): 'high' | 'medium' | 'low';

  /**
   * 【v3.0 新增 → v4.0 变更】生成 Correction Toast 数据
   * 包含推断结果摘要、置信度、可供用户快速修正的选项
   * 【v4.0】废弃 displayDuration，消散由 IntentDismissalService 管理
   *
   * @returns CorrectionToastData 用于 UI 层渲染 Correction Toast
   */
  generateCorrectionToast(task: Task, inferredMeta: Partial<TaskOverlapMeta>): CorrectionToastData;
}

/**
 * 【v3.0 新增】Correction Toast 数据模型
 * 供 UI 层渲染推断纠错浮层
 */
interface CorrectionToastData {
  /** 推断结果的用户可读摘要，如 "后台等待" / "深度工作" */
  inferredLabel: string;
  /** 推断的预计时长摘要，如 "~10 分钟" / "无限期" */
  estimatedDurationLabel: string | null;
  /** 推断的锚点摘要，如 "手动触发" / "10 分钟后检查" */
  checkpointLabel: string | null;
  /** 推断置信度——低置信度时 [修改] 按钮高亮 */
  confidence: 'high' | 'medium' | 'low';
  /**
   * 【v4.0 变更 / v5.0 信号净化】废弃 displayDuration——Toast 不再由计时器驱动消散
   * 消散时机由 IntentDismissalService 根据用户在 Focus Pod 中的
   * 首次内容交互信号（input / compositionstart / scroll deltaY>30px / selectionchange span>0）决定
   * 【v5.0 剔除 mousedown / keydown】——盲点动作不再作为消散触发器
   */
  // displayDuration: number; // ← v4.0 废弃
  /** 是否高亮 [修改] 按钮（confidence !== 'high' 时为 true） */
  highlightModifyButton: boolean;
}

interface OverlapTemplate {
  name: string;        // "后台脚本"、"等待回复"、"深度阅读"
  icon: string;
  defaults: Partial<TaskOverlapMeta>;
}
```

#### 6.2.7 `UserActivityService`（活跃度检测 — v6.0 极简模型）

```typescript
/**
 * 【v3.0 重构】从简单的键鼠事件检测升级为三层推断模型
 * 【v4.0 增强】新增 Companion Mode 支持——多屏工作者的 blur 信号降权
 * 【v6.0 极简化】废弃贝叶斯式评分模型，接受软件局限性
 * 
 * v6.0 核心变更：
 * 1. 废弃 absenceConfidence 评分（0-100）→ 简化为二元 idle/active
 * 2. 判定规则仅保留两条：
 *    · visibilityState === 'hidden' → 立即 idle
 *    · 动态阈值内无任何键鼠事件 → idle（按 cognitiveLoad 动态调整阈值）
 * 3. Companion Mode 自动化——系统内部检测多屏行为并自适应，不再暴露给用户
 * 4. 废弃微操作信号区分（鼠标微移 distance>5px 等复杂判定）→ 有任何事件就 active
 *
 * 设计哲学：如果推断错了（用户在看屏幕但被判为 idle），提醒弹出时
 * 动一下鼠标提醒就消失了——成本 < 0.5 秒。这比维护一套复杂推断模型的工程成本低得多。
 */
@Injectable({ providedIn: 'root' })
class UserActivityService {
  private focusPod = inject(FocusPodService);

  /** 当前用户状态（v6.0 简化为二元判定） */
  readonly state: Signal<'active' | 'idle'>;

  /** 最后一次任意活动时间 */
  readonly lastActivityAt: Signal<string>;

  /**
   * 当前生效的 idle 阈值（ms）
   * 根据 Focus Pod 任务的 cognitiveLoad 动态计算
   * 【v6.0 保留】这是 v3.0 中合理的部分
   */
  readonly effectiveIdleThreshold: Signal<number>;

  /**
   * 【v6.0 内部状态】多屏自动检测
   * 系统自动检测并适配，不暴露给用户
   * 2 分钟内 blur→focus 切换 ≥5 次 → blur 的 idle 延长为 30s
   */
  private multiScreenDetected = signal<boolean>(false);

  /**
   * 开始活跃度监听
   * 
   * 【v6.0 简化】监听事件清单：
   * - keydown / keyup / mousedown / click / mousemove / scroll / selectionchange
   *   / touchstart / touchmove → 统一重置 idle 计时（全部 passive + 节流 200ms）
   * - visibilitychange → hidden 时**立即判定** idle
   * - blur / focus → 多屏自动检测计数（内部逻辑，无用户概念）
   *
   * 【v6.0 废弃的复杂度】：
   * - ~~鼠标微移 distance>5px 阈值判定~~ → 有 mousemove 就 active
   * - ~~极微滚动 deltaY<50px 区分~~ → 有 scroll 就 active
   * - ~~absenceConfidence 0-100 评分~~ → 简单超时二元判定
   * - ~~多层权重叠加~~ → 有事件就 active，超时就 idle
   */
  startTracking(): void;

  /** 停止监听，清理所有事件绑定 */
  stopTracking(): void;

  // ═══════════ 内部机制 ═══════════

  /**
   * 【v6.0 简化】idle 判定逻辑
   * 仅两条规则：
   * 1. visibilityState === 'hidden' → 立即 idle
   * 2. 动态阈值内无任何事件 → idle
   *    （多屏场景下 blur 不算"无事件"，延长 30 秒窗口）
   */
  private checkIdleState(): void;

  /**
   * 【保留】根据 Focus Pod 任务的认知属性动态计算 idle 阈值
   * deep: 5min / moderate: 2min / shallow: 30s
   */
  private getDynamicIdleThreshold(): number;

  /**
   * 【v6.0 自动化】多屏行为检测——替代手动 Companion Mode
   * 2 分钟内 blur→focus 切换 ≥5 次 → multiScreenDetected = true
   * → blur 时的 idle 判定延长为 30 秒窗口（而非立即判定）
   * 不弹窗、不通知、不需要用户理解任何概念
   */
  private detectMultiScreenBehavior(): void;
}
```

### 6.3 服务交互流（v4.0）

```
用户操作                      服务层                        状态层
───────                     ──────                       ──────
"送入孵化器"            →  OverlapService
  （拖拽/右键，零配置）       .sendToIncubator()
                            ├─ OverlapAttribution        TaskStore
                            │   .inferMeta()   ← 核心    .tasksMap
                            │   （自动推断全部属性）        ↳ overlapMeta 写入
                            │
                            │  【v3.0→v4.0】推断完成后：
                            ├─ OverlapAttribution
                            │   .generateCorrectionToast()
                            │   → CorrectionToastData
                            │   → UI 渲染底部微型纠错浮层
                            │   →【v4.0】注册到 IntentDismissalService
                            │     不设倒计时，等待用户首次内容交互信号后消散
                            │     （v5.0 净化：input/compositionstart/scroll/selectionchange）
                            │
                            ├─ IncubatorService
                            │   .addTask()               incubatingTaskIds.update()
                            └─ MetronomeService
                                .startMonitoring()

"锚点触发"              →  MetronomeService
  （用户若 active          .checkCycle()
   则抑制提醒）             ├─ 检测到 timer 到达
                            ├─ UserActivity.state == 'active'?
                            │   →【v4.0 三层推断 + Companion Mode】
                            │     absenceConfidence < 80%
                            │     （Companion Mode 下 blur 权重 = 0%）
                            │     → urgency 锁定 'suppressed'（视觉零变化）
                            │     → 升级计时暂停
                            └─ UserActivity.state == 'idle'?
                                →【v4.0 三层推断】
                                  absenceConfidence >= 80%
                                  且满足以下之一：
                                  · visibilityState === 'hidden'
                                  · 无微操作 > 动态阈值（按 cognitiveLoad 调整）
                                  · 非 Companion Mode 下 blur > 10s（权重 60%）
                                → metronomeAlerts.update() → 静态铃铛图标

"切换焦点"              →  OverlapService
         .switchFocus()
                            ├─ ContextWarmUp
                            │   .saveSnapshot()          → 操作轨迹 + 结构化锚点签名 + 截图
                            │    （全自动，零用户交互）      （v4.0：结构锚点提取替代 NLP）
                            ├─ FocusPodService
                            │   .suspendCurrent()        → suspendedSlices.update()
                            │                              （含结构化锚点签名快捷缓存）
                            │   .setFocusTask(target)    → focusPodTaskId
                            └─ IncubatorService
                                .removeTask(target)      → incubatingTaskIds

"回弹"                  →  OverlapService
         .bounceBack()
                            ├─ suspendedSlices.length == 1?
                            │   → 直接恢复
                            │   → ContextWarmUp.restoreWithWarmUp()
                            │     【v4.0 三级响应 + Intent-driven】：
                            │     · < 2 分钟 → instant（闪烁最后编辑行）
                            │     · 2-15 分钟 → gentle（底部轻量条，Intent-based 消散）
                            │       注册到 IntentDismissalService，
                            │       等待 input/compositionstart/scroll/selectionchange 后淡出
                            │     · > 15 分钟 → full（【v6.0】右侧 Memory Aid Panel 侧栏，非全屏遮罩）
                            │
                            └─ suspendedSlices.length >= 2?
                                → 弹出 Mission Control 全景面板
                                →【v4.0】显示结构化锚点签名 + 任务图标
                                →【v6.0】卡片左侧 60×80px 模糊缩略图 + 右侧结构化锚点文字
                                → 用户自由选择恢复哪个切片
                                → ContextWarmUp.restoreWithWarmUp()
```

---

## 7. UI 交互设计

### 7.0 v7.0 简化 UI 设计

> **v7.0 核心变更**：从 ~20 个组件削减到 ~5 个。删除 Context Warm-up Bar、Memory Aid Panel、Correction Toast、Archival Notification、模糊缩略图、编辑行闪烁指令（内联到恢复逻辑中）等。
>
> **v7.1 修正**：停泊列表改为常驻侧边栏（§2.8.5），卡片增加查看/切换分离（§2.8.1），废弃弹窗式 Mission Control。

**v7.0 视觉布局**：

```
┌────────────────────────────────────────────────────────────────┐
│  顶部栏：[← 退出]    当前任务    [⚙]                           │
├────────────────────────────────────────────────┬───────────────┤
│                                                │               │
│                                                │  稍后 (3)     │  ← 常驻可见
│                                                │  ──────────   │
│              主舞台                             │               │
│          (Focus Arena)                         │  ┌─────────┐  │
│                                                │  │ ⏸ 修 bug │  │
│    ┌──────────────────────────────┐             │  │ connectDB│  │
│    │                              │             │  │ 8 分钟   │  │
│    │   当前任务内容                │             │  │ [查看]   │  │  ← 单击=预览
│    │   （编辑器 / GoJS）           │             │  │ [开始做▶]│  │  ← 双击/按钮=切换
│    │                              │             │  │ [×]      │  │  ← 手动移除
│    │                              │             │  └─────────┘  │
│    │                              │             │  ┌─────────┐  │
│    │                              │             │  │ ⏸ 写文档 │  │
│    │                              │             │  │ 第 3 章   │  │
│    │   切回时：                    │             │  │ 23 分钟  │  │
│    │   最后编辑行三段式闪烁         │             │  │ ⏰ 7 分钟 │  │
│    │   (200ms亮起+500ms保持+300ms淡出) │         │  │ [查看]   │  │
│    │                              │             │  │ [开始做▶]│  │
│    └──────────────────────────────┘             │  │ [×]      │  │
│                                                │  └─────────┘  │
│                                                │               │
├────────────────────────────────────────────────┴───────────────┤
│  底部 Snackbar：（Intent-based 消散，非自动计时消失）             │
└────────────────────────────────────────────────────────────────┘
```

**与 v6.0 的关键视觉差异**：
- 侧边栏标题从"Peripheral Monitor"改为**"稍后 (N)"**——日常用语
- **侧边栏常驻可见**（v7.1）——从 1 个停泊任务开始就显示，不需要 ≥2 才触发
- **无预热条、无 Memory Aid Panel、无 Correction Toast**——切回即恢复，零中间层 UI
- 底部通知改为 **Snackbar**（v7.1），使用 **Intent-based 消散**——用户下次交互后消失
- 卡片信息：任务标题 + 结构化锚点（一行） + 停泊时长 + 可选提醒倒计时 + **[查看]/[开始做]/[×]**

**v7.0 → v7.1 卡片设计**：

```
默认状态（v7.1 双操作模型）：
┌──────────────────────────────────┐
│ ⏸  修复登录 bug                   │  ← 静态暂停图标 + 标题
│    connectDB() · 8 分钟           │  ← 结构化锚点 + 停泊时长
│ [查看详情]  [开始做 ▶]       [×]  │  ← 查看=预览 / 开始做=切换 / ×=移除
└──────────────────────────────────┘

有提醒的卡片：
┌──────────────────────────────────┐
│ ⏸  写需求文档                      │
│    第 3 章 · 23 分钟               │
│    ⏰ 提醒：还剩 7 分钟            │  ← 仅在设置了提醒时显示
│ [查看详情]  [开始做 ▶]       [×]  │
└──────────────────────────────────┘

提醒到达后（v7.1 含 Snooze）：
┌──────────────────────────────────┐
│ 🔔 写需求文档                      │  ← 图标变为铃铛
│    提醒时间到了                     │
│ [切换过去] [5分钟后再提醒] [忽略]  │  ← v7.1：增加 Snooze
└──────────────────────────────────┘
```

**~~Mission Control~~（v7.1 废弃弹窗式，改为常驻侧边栏 §2.8.5）**：

> v7.0 原设计：≥2 个停泊任务时弹出选择面板。v7.1 废弃此设计——停泊列表始终在侧边栏可见，用户随时双击任何停泊任务即可切换，无需等待系统弹窗。
>
> 如果侧边栏被折叠（48px 图标模式），点击展开按钮时以列表形式展开。

```
v7.0 旧行为（已废弃）：
┌──────────────────────────────────────────────────┐
│  切换到哪个任务？                                 │
│  ┌────────────────┐  ┌────────────────┐          │
│  │ ⏸ 修复登录 bug  │  │ ⏸ 写需求文档   │          │
│  │   [切换]        │  │   [切换]        │          │
│  └────────────────┘  └────────────────┘          │
│                    [取消]                         │
└──────────────────────────────────────────────────┘

v7.1 新行为：
  → 侧边栏始终显示停泊任务列表，用户随时双击/[开始做] 即可切换
  → 完成当前任务后留在无 Focus 状态——不强制选择
```

**切换动画（v7.1 修正）**：

```
切换到停泊任务的动画（~1300ms 总计）：
1. [0-100ms]  当前内容淡出
2. [100-250ms] 新内容淡入 + 光标恢复 + 内容锚点滚动恢复
3. [250-1250ms] 最后编辑行三段式闪烁：
   - 200ms 亮起（黄色背景渐显 → opacity: 0.6）
   - 500ms 保持（黄色背景驻留）
   - 300ms 淡出（黄色背景渐隐 → opacity: 0）
```

**底部 Snackbar 通知（v7.1 — Intent-based 消散）**：

```
提醒到达（v7.1 含 Snooze）：
┌──────────────────────────────────────────────────────────────┐
│  ⏰ 「写需求文档」的提醒时间到了                                │
│  [切换过去]  [5 分钟后再提醒]  [忽略]                          │  ← 44×44px 按钮
│                          （下次操作后自动消失 / 15s fallback）   │
└──────────────────────────────────────────────────────────────┘

超限移出（v7.1 48h 衰老清理）：
┌──────────────────────────────────────────────────────────────┐
│  📋 「旧任务名」已移回任务列表                                  │
│  [撤回 ↩]                                                    │  ← 44×44px 按钮
│                          （下次操作后自动消失 / 15s fallback）   │
└──────────────────────────────────────────────────────────────┘
```

**v7.0 → v7.1 组件清单**：

```
src/app/features/overlap/
├── overlap-mode.component.ts           # 容器组件
├── components/
│   ├── focus-arena.component.ts        # 主舞台
│   ├── parking-sidebar.component.ts    # "稍后"侧边栏（v7.1：常驻可见）
│   ├── parked-task-card.component.ts   # 停泊任务卡片（v7.1：查看/切换/移除）
│   ├── ~~mission-control.component.ts~~  # v7.1 废弃（弹窗式 → 侧边栏常驻）
│   └── snackbar-notice.component.ts    # 底部 Snackbar（v7.1：Intent-based 消散）
├── directives/
│   └── edit-line-flash.directive.ts    # 最后编辑行闪烁（v7.1：1000ms 三段式）
├── services/
│   ├── parking.service.ts              # 停泊管理（v7.1：查看/切换分离 + 时间衰老）
│   ├── context-restore.service.ts      # 上下文恢复
│   └── simple-reminder.service.ts      # 简单提醒
```

> 注：以下 7.1-7.6 为 v1.0-v6.0 的历史 UI 设计，保留供参考和回退。v7.0 实现应使用上述简化设计。

### 7.1 视觉布局总览（v2.0 — 视觉静默设计）

```
┌────────────────────────────────────────────────────────────────┐
│  顶部栏：[← 退出 Overlap]    State Overlap    [⚙]              │
├────────────────────────────────────────────────┬───────────────┤
│                                                │               │
│                                                │  侧边观察窗    │
│                                                │  (Peripheral  │
│              主舞台                             │   Monitor)    │
│           (Focus Arena)                        │  【绝对静态】   │
│                                                │               │
│    ┌──────────────────────────────┐             │  ┌─────────┐  │
│    │                              │             │  │ ⏳ 编译   │  │
│    │   当前 Focus Pod 任务         │             │  │          │  │
│    │   的完整内容区域               │             │  │ [切换]   │  │
│    │                              │             │  └─────────┘  │
│    │   （编辑器 / 阅读器 /         │             │  ┌─────────┐  │
│    │     GoJS 视图）              │             │  │ ⏳ 等回复 │  │
│    │                              │             │  │          │  │
│    │   ┌─────────────────────┐    │             │  │ [切换]   │  │
│    │   │ 🔙 Context Warm-up  │    │             │  └─────────┘  │
│    │   │ "你离开 3分22秒"    │    │             │  ┌─────────┐  │
│    │   │ 最后编辑：第42-45行 │    │             │  │ ✅ 数据   │  │
│    │   │ [任意操作消散]      │    │             │  │          │  │
│    │   └─────────────────────┘    │             │  │ [移出]   │  │
│    │                              │             │  └─────────┘  │
│    └──────────────────────────────┘             │               │
│                                                │               │
├────────────────────────────────────────────────┴───────────────┤
│  底部状态栏：（仅在锚点触发 + 用户 idle 时显示文字提示）          │
└────────────────────────────────────────────────────────────────┘
```

**与 v1.0 的关键视觉差异**：
- 侧边卡片**无进度条、无百分比、无动画**——仅静态图标 + 标题
- 底部状态栏**默认空白**——仅在锚点触发且用户 idle 时才显示文字
- 主舞台回弹时出现 Context Warm-up 预热覆盖层（可被任意操作消散）

### 7.2 主舞台（Focus Arena）

**设计原则：** 保持绝对纯净，与现有 Text View / Flow View 无缝集成。

| 特性 | 说明 |
|------|------|
| 全宽展示 | 当侧边观察窗折叠时，占据 100% 宽度 |
| 沉浸保护 | 不显示任何后台任务的细节内容 |
| 上下文感知 | 顶部微型面包屑显示"你正在处理：[任务名]" |
| 回弹入口 | 右上角「↩ 回到之前」按钮（仅在切换后显示） |

复用逻辑：
- 如果 Focus 任务是文本任务 → 渲染 Text View 的编辑组件
- 如果 Focus 任务是流程任务 → `@defer` 加载 Flow View

### 7.3 侧边观察窗（Peripheral Monitor）— v2.0 视觉静默设计

**设计原则：** 绝对静态——未触发锚点前，侧边栏不产生任何动态变化。

> **v2.0 核心变更**：废弃进度条 + 废弃自动触发的呼吸灯动画。
> 人类周边视觉（Peripheral Vision）对运动极其敏感——即使不弹窗，一个流动的进度条也会持续分散注意力。

```
侧边观察窗宽度策略：
- 桌面端：固定 200px（缩窄），可折叠为 48px 图标条
- 移动端：完全折叠，底部浮动小圆点仅显示数量
- 折叠态：仅显示孵化数量徽标（静态数字）
```

**v2.0 卡片设计（静态优先）**：

```
默认状态（绝对静态）：
┌─────────────────────────┐
│ ⏳  后台编译              │  ← 静态沙漏图标 + 精简标题（最多 12 字）
│                          │  ← 无进度条、无百分比、无动画
│ [切换]                   │  ← 微型操作按钮
└─────────────────────────┘

hover 时展开详情（仅鼠标悬停时可见）：
┌─────────────────────────┐
│ ⏳  后台编译              │
│ 已孵化 12 分钟            │  ← hover 才显示时间信息
│ 📌 下一锚点：部署到测试   │  ← hover 才显示锚点
│ [切换过来]               │
└─────────────────────────┘

锚点触发后（用户 idle 时）：
┌─────────────────────────┐
│ 🔔 后台编译              │  ← 图标变为铃铛（静态图标变更，非动画）
│ 锚点已到达               │  ← 一行文字提示
│ [切换处理] [稍后]        │  ← 操作按钮
└─────────────────────────┘
```

**v2.0 卡片状态映射：**

| OverlapState | 卡片样式 | v2.0 与 v1.0 差异 |
|-------------|---------|-------------------|
| `incubating` | 静态沙漏图标 ⏳，无动画 | **废弃**进度条流动动画 |
| `checkpoint` | 静态铃铛图标 🔔（用户 idle 时才显示） | **废弃**呼吸灯闪烁，改为静态图标变更 |
| `paused` | 灰色暂停图标 ⏸ | 不变 |
| `hibernated` | 冰冻图标 🧊 + hover 提示"系统自动归档" + 【v6.0】归档时 1.5s 微提示 | **v5.0 新增**：Silent Hibernation → **v6.0**：Transparent Archival |
| `hatched` | 绿色对勾 ✅ | 不变 |

### 7.4 节拍器视觉反馈（Metronome Feedback）— v2.0 焦点抑制设计

**核心原则：永远不弹窗、永远不夺焦点、用户操作时零视觉变化。**

> **v2.0 核心变更**：引入焦点抑制（Focus Suppression）—— 用户在键盘/鼠标操作时，所有提醒冻结在 `suppressed` 状态，升级计时暂停。

**四级提醒机制（含新增 suppressed 级别）：**

| urgencyLevel | 视觉表现 | 触发条件 |
|-------------|---------|---------|
| `suppressed` | **零视觉变化**——侧边栏完全不动 | 用户在操作中（键盘/鼠标活跃） |
| `calm` | 卡片图标静态变更为 🔔 | 锚点触发 + 用户 idle |
| `notice` | 底部状态栏出现一行文字提示 | 用户 **idle 累计** 5 分钟未处理 |
| `alert` | Focus Arena 右上角半透明气泡 | 用户 **idle 累计** 15 分钟未处理 |

**抑制规则详解**：
- 升级计时器在 `suppressed` 状态下**完全暂停**——不累计时间
- calm→notice 的"5 分钟"是 5 分钟的**空闲时间**，不是 5 分钟的**墙上时间**
- 用户任何键盘/鼠标操作立即将所有提醒压回 `suppressed`
- 底部文字提示被任意操作立即消散
- **永远不打断心流**——只要用户在敲键盘，系统完全静默

### 7.5 切换动画设计 — v2.0 Context Warm-up 增强

```
Focus Pod 切换到孵化器任务的动画流程（~400ms）：

1. [0-100ms]  当前 Focus 内容开始向左淡出 + 轻微缩小
2. [100-150ms] 思维快照保存指示器闪现（📌 图标在内容中心一闪）
3. [150-300ms] 侧边孵化器目标卡片"飞入"中央 + 放大为全尺寸
4. [300-400ms] 新任务内容淡入 + 侧边观察窗更新
```

**v2.0 新增 → v3.0 重构 → v4.0 Intent-driven：Context Warm-up 回弹 — 三级动态响应**

```
回弹到之前的 Focus 任务时，根据离开时长动态选择预热级别：

═══ instant 级别（离开 < 2 分钟）═══
1. [0-150ms]  当前内容向右淡出
2. [150-350ms] 新内容直接淡入（无遮罩）
3. [350-550ms] 最后编辑行微微闪烁一次（200ms 黄色脉冲后淡出）
              → 用户秒回，零打断

═══ gentle 级别（离开 2 - 15 分钟）═══ 【v4.0 Intent-driven 消散 / v5.0 信号净化】
1. [0-150ms]  当前内容向右淡出
2. [150-350ms] 新内容淡入 + 底部浮出 60px 半透明预热条（含 ✕ 关闭按钮）：
               ┌───────────────────────────────────────────────┐
               │ ⏱ 离开 8 分 → 最后停在：在『认证流程设计』一节阅读  ✕ │
               └───────────────────────────────────────────────┘
3. 【v4.0 变更】预热条不设 setTimeout
   · 静静停在底部，不产生任何时间压迫感
   · 用户产生首次内容交互信号后安静淡出（200ms fade-out）：
     - input / compositionstart（真实输入——非 Shift/Ctrl 等修饰键）
     - scroll deltaY > 30px（实质性滚动，非微抖动）
     - selectionchange 且 selection.toString().length > 0（划选文本）
   · 或用户手动点击预热条上的 ✕
   · 由 IntentDismissalService 统一管理消散时机
   → 轻推用户找回方向，阅读速度因人而异，不用秒表催促
   【v5.0 Blind Click 修正】不再响应 mousedown / keydown——
   用户切窗回来随手点一下窗口（Blind Click）不应让预热信息消失

═══ full 级别（离开 > 15 分钟）═══ 【v6.0 修正：侧栏记忆辅助面板，不遮挡主内容】
1. [0-150ms]  当前内容（孵化器任务）向右淡出
2. [150-400ms] 主内容淡入 + 光标恢复 + 变更高亮（黄底 2s 淡出）
              【v6.0 变更】主内容直接可见——用户可以立即操作
3. [400-600ms] 右侧滑出 300px 记忆辅助面板（Memory Aid Panel）：
               ┌──────────────────────────────┐
               │  🧠 回忆辅助                   │
               │                                │
               │  ⏱ 你离开了 23 分 12 秒         │
               │                                │
               │  📸 离开时的样子                 │
               │  ┌────────────────────┐        │
               │  │ (模糊缩略图，如有)   │        │
               │  └────────────────────┘        │
               │                                │
               │  📝 离开前你在做：               │
               │    · 14:30 编辑了"用户故事 3"     │
               │    · 14:28 移动了"性能优化"      │
               │    · 14:25 新增了"API 联调"      │
               │                                │
               │  ✏️ 变化高亮：2 处新增、1 处修改   │
               │                                │
               │       [知道了，关闭面板]          │
               └──────────────────────────────┘
4. 面板消散规则（Soft Dismissal）：
   · Esc / 点击面板外 / 点击[关闭] → 立即消散
   · 任意内容交互信号 → 立即消散
   · 10 秒无操作 → 自动淡出
   → **用户不必点击"我想起来了"才能看到内容——内容始终可见**
```

> **v4.0→v5.0→v6.0 设计要点**：
> - instant 级别完全无遮罩——用户切走不到 2 分钟时脑子是热的，任何打断都是多余阻力
> - **gentle 级别 Soft Dismissal**——中度遗忘只需要一个轻推（Nudge），
>   v6.0 新增 Escape 键关闭 + 点击空白关闭 + 10 秒无操作自动淡出，
>   消除"UI 粘手"的强迫症体验，不再强迫用户制造无意义的滚动或输入
> - **full 级别侧栏面板**（v6.0 核心修正）——不遮挡主内容，用户可直接操作。
>   记忆辅助面板从右侧滑出，看不看、什么时候看由用户自己决定
> - **核心范式转换**：所有 UI 消散均由 `IntentDismissalService` 统一管理，
>   v6.0 三通道消散：内容交互信号 + 主动关闭（Esc/空白点击）+ 无操作淡出（10s）

### 7.6 移动端适配 — v4.0 结构化锚点 + Intent-driven 消散

| 场景 | 桌面端 | 移动端 |
|------|-------|-------|
| Focus Arena | 左侧 ~80% | 全屏 |
| Peripheral Monitor | 右侧 ~200px（静态卡片） | 底部浮动小圆点（静态数字），上滑半屏抽屉 |
| 切换操作 | 点击侧边卡片 | 上滑抽屉 → 点击卡片 |
| 回弹操作 | Mission Control 任选一个 slice | 右滑手势 or 底部浮动「↩」按钮 |
| 锚点提醒 | 卡片图标静态变更（须 idle） | 浮动圆点变色（须 idle）+ 可选震动 |
| Mission Control | 结构化锚点签名卡片全景面板 | 底部抽屉内横向结构化锚点卡片滑动 |
| Context Warm-up | instant/gentle/full 三级（gentle: Intent-driven） | instant: 闪烁 / gentle: 全宽条（触摸后消散） / full: 全屏遮罩（轨迹精简为 2 条） |
| Correction Toast | 底部右侧微型浮层（Intent-based 消散） | 底部全宽 Snackbar（首次触摸内容区后消散），[修改] 改为 [⬆ 上滑修改] |
| Companion Mode | 设置中开关 | 移动端默认禁用（单屏设备无多屏场景） |

**移动端 Mission Control 交互（v3.0 更新）：**
- 当 `suspendedSlices.length >= 2` 时，底部浮动按钮从 `↩` 变为 `🗂 (n)` 显示数量
- 点击后展开底部抽屉，显示所有 slice 的**语义签名卡片**（非模糊截图）
- 每个卡片显示：任务图标 + 任务名 + "最后停在：{signature}" + 挂起时长
- 点击任意卡片直接跳转（Free Slices，非固定顺序）

---

## 8. 核心流程时序 — v6.0

### 8.1 场景一：开发者的典型 State Overlap 流程（v4.0）

```
时间线  用户操作                     系统行为                     UI 表现
─────  ────────                    ──────                      ──────
T+0    将"跑测试脚本"              OverlapAttributionService    卡片出现在侧边观察窗
       一键送入孵化器               自动推断全部属性：             静态沙漏图标 ⏳
                                    cognitive: passive           无配置弹窗
                                    blocking: async
                                    checkpoint: [10min:检查首轮]
                                    confidence: high

                                   【v4.0】生成 Correction      底部右侧出现微型浮层：
                                    Toast（无 displayDuration）    "✅ 已送入 → [后台脚本]
                                    IntentDismissalService         ⏱ ~10 分钟 [修改]"
                                    .register('toast-xxx', {       浮层驻留——等待用户
                                     dismissOnSignals:              在 Focus Pod 内的
                                      [input,compositionstart,     首个内容交互信号后消散
                                       scroll,selectionchange]     （v5.0：剔除 mousedown/
                                    })                              keydown 盲点动作）
                                    highlightModify: false

T+0    将"阅读技术文档"设为 Focus   设为 Focus Pod 任务            文档在主舞台全屏展示
       用户开始阅读文档               IntentDismissalService       Correction Toast 消散
                                    检测到首次 scroll（>30px）      （被用户阅读行为触发）
                                    → 触发 toast-xxx 消散

                                   【v3.0】cognitiveLoad         effectiveIdleThreshold
                                    推断为 'deep'                 自动设为 300_000ms（5 分钟）
                                    （标题含"阅读"关键词）

T+10   -（用户在阅读文档，           MetronomeService 检测到       用户窗口在前台 +
       双手离开键盘思考 2 分钟）     "检查首轮"锚点到达             absenceConfidence = 20%
                                    UserActivityService 报告：     （有微操作：鼠标微移）
                                    · visibilityState: visible    → urgency = suppressed
                                    · 有鼠标微移信号               侧边栏：零变化
                                    · cognitiveLoad: deep
                                    · 动态阈值：5 分钟
                                    → absenceConfidence < 80%
                                    → 维持 active 状态
                                   （Focus Suppression 生效）

T+14   用户继续盯着文档思考          UserActivityService 持续：     侧边栏：完全静默
       已 4 分钟无键盘操作           · 窗口仍在前台                 无呼吸灯、无颜色变化
       但偶尔微滚动                  · 有微滚动信号（阅读行为）      （deep 任务 5 分钟阈值
                                    · absenceConfidence = 30%       保护了用户的心流）
                                    → 维持 active

T+16   用户读完章节，                UserActivityService 检测：     —
       最小化浏览器去倒水             visibilityState → 'hidden'
                                    → absenceConfidence = 100%
                                    →【立即判定为 idle】
                                    → suppressed → calm

T+16.5 -（idle 30 秒）             —                              侧边卡片图标变为 🔔
                                                                   （静态图标变更，无动画）

T+21   -（idle 累计 5 分钟）        calm → notice                   底部状态栏出现一行文字：
                                                                   "测试脚本已到检查点"

T+21.5 用户回来了                   注意到底部文字                   —
       恢复浏览器窗口                 visibilityState → 'visible'
       触碰键盘                     → absenceConfidence = 0%
                                    notice → suppressed              底部文字立即消散

T+22   用户主动点击侧边             saveSnapshot()：                📌 闪现
       "切换过来" 按钮               自动抓取操作轨迹
                                   【v4.0】提取结构化锚点：
                                     "在『第 3 章 认证流程』一节阅读"
                                     structuralAnchor: {
                                       type: 'heading',
                                       label: '第 3 章 认证流程'
                                     }
                                    自动推断 taskTypeIcon: 'document'
                                  Focus 切换到"测试脚本"            切换动画播放
                                  "文档"存入 suspendedSlices
                                    （含结构化锚点 + 图标缓存）

T+23   用户查看测试结果              -                              测试结果在主舞台展示
       发现 2 个失败用例
       修复后重启脚本
       标记锚点为 handled

T+24   点击「↩ 回弹」              restoreFromSlice(docTaskId)
                                   【v4.0 三级响应 + Intent】
                                    absentDuration = 2 分钟
                                    → gentle 级别                   底部出现 60px 预热条：
                                    IntentDismissalService           "⏱ 离开 2 分 → 在
                                    .register('gentle-bar', {         『第 3 章 认证流程』
                                     dismissOnSignals:                 一节阅读"   [✕]
                                      [input,compositionstart,        光标自动恢复到快照位置
                                       scroll,selectionchange]
                                    })

T+24.5 用户开始滚动页面              IntentDismissalService 检测    预热条消散——恢复完成
       （继续阅读文档）               到 scroll（>30px）             "测试脚本"回到孵化器
                                    → 触发 gentle-bar 消散          侧边卡片恢复 ⏳

T+35   -                          测试完成                         侧边卡片图标变 ✅
                                  overlapState → hatched

T+36   用户注意到绿色对勾            -                              -
       点击移出孵化器
       标记任务完成
```

### 8.2 场景二：等待他人回复（v4.0 Intent-based Toast + Companion Mode）

```
时间线  用户操作                     系统行为                     UI 表现
─────  ────────                    ──────                      ──────
T+0    将"等待设计稿确认"           OverlapAttributionService     卡片出现：⏸ 静态图标
       一键送入孵化器                自动推断：                     无配置弹窗
       （不选模板、不设时间）         cognitive: passive
                                    blocking: async
                                    estimatedDuration: null
                                    checkpoint: [manual]
                                    confidence: high（关键词
                                     "等待"高精度匹配）

                                   【v4.0】Correction Toast       底部右侧微型浮层：
                                    IntentDismissalService          "✅ 已送入 → [后台等待]
                                    .register('toast-xxx')           📌 手动触发 [修改]"
                                    highlightModify: false           驻留等待实质性动作

T+0    Focus 在"写前端代码"         cognitiveLoad → 推断为         effectiveIdleThreshold
       用户开始写代码                 'moderate'（含"写"关键词）      设为 120_000ms（2 分钟）
                                    IntentDismissalService           Correction Toast 消散
                                    检测到 input（写代码）            （被首次真实输入触发）
                                    → 触发 toast-xxx 消散

       ...（数小时过去，用户持续操作中，所有提醒被 suppressed）
       ...（UserActivityService 持续检测：窗口在前台 + 有键盘活动
       ...  → absenceConfidence ≈ 0% → 维持 active）

       【v4.0 Companion Mode 场景】
       用户在双屏工作：NanoFlow 在副屏，
       主屏在写邮件和看文档。
       UserActivityService 检测到频繁
       blur→focus 交替 → 弹出建议：
       "检测到频繁窗口切换，是否启用伴随模式？"
       用户确认 → companionMode = true
       → blur 权重降为 0%，仅
       visibilityState='hidden' 判定离开

T+180  用户收到外部邮件通知          -                            -
       回到 NanoFlow
       手动触发"等待回复"的锚点

       -                           MetronomeAlert 生成            用户若在操作
                                                                   → absenceConfidence < 80%
                                                                   → suppressed
                                                                 用户若 idle
                                                                   → absenceConfidence >= 80%
                                                                   → 🔔 calm

T+181  用户主动点击切换             saveSnapshot() +               切换动画
                                  【v4.0】提取结构化锚点：
                                    "在『userId 权限验证』函数编辑"
                                    structuralAnchor: {
                                      type: 'function',
                                      label: 'userId 权限验证',
                                      line: 42
                                    }
                                   taskTypeIcon: 'code'

T+185  审阅完设计稿                 -                             -
       标记为 hatched
       点击回弹

       -                           restoreWithWarmUp()
                                   【v4.0】absentDuration = 4 分钟
                                    → gentle 级别                  底部预热条：
                                    IntentDismissalService           "⏱ 离开 4 分 → 在
                                    .register('gentle-bar', {         『userId 权限验证』
                                     dismissOnSignals:                 函数编辑"  [✕]
                                      [input,compositionstart,
                                       scroll,selectionchange]
                                    })

       用户开始滚动浏览代码          IntentDismissalService 检测    预热条消散 → 编辑器
                                    到 scroll（>30px）              恢复到之前的代码行
                                    → gentle-bar 消散               完成
```

### 8.3 场景三：多任务 Free Slices（v4.0 结构化锚点导航 + Intent 消散）

```
状态快照（v4.0 扁平切片 + 结构化锚点模型）：

Focus Pod:           📝 写需求文档
Suspended Slices:    (空)

Incubator:
  [1] ⏳ 跑 E2E 测试         已孵化 8 分钟
  [2] ⏸ 等待 PM 确认         无时限    📌 manual
  [3] ⏳ 数据导出             已孵化 18 分钟

─── 数据导出到达锚点 ───
用户最小化窗口去看邮件（visibilityState → hidden → 立即 idle）
→ suppressed → calm → 🔔

用户回来切换到数据导出：
  saveSnapshot() 提取结构化锚点：
    structuralAnchor: {
      type: 'heading',
      label: '用户故事 3 · 验收标准',
    }
    → "在『用户故事 3 · 验收标准』一节编辑"
    taskTypeIcon: 'document'

Focus Pod:           📊 数据导出（从孵化器切入）
Suspended Slices:
  [slice-1] 📝 写需求文档
            锚点："在『用户故事 3 · 验收标准』一节编辑"

Incubator:
  [1] ⏳ 跑 E2E 测试         已孵化 10 分钟
  [2] ⏸ 等待 PM 确认         无时限    📌 manual

─── E2E 测试也到锚点（用户 idle 后 → calm）───

用户看到两个 🔔，选择切到 E2E 测试：
  saveSnapshot() 提取结构化锚点：
    structuralAnchor: {
      type: 'function',
      label: 'validateExportResult',
      line: 42
    }
    → "在『validateExportResult』函数编辑（L42）"
    taskTypeIcon: 'data'

Focus Pod:           🧪 跑 E2E 测试
Suspended Slices:（≥2 个，触发 Mission Control 面板）
  [slice-1] 📝 写需求文档
            锚点："在『用户故事 3 · 验收标准』一节编辑"
  [slice-2] 📊 数据导出
            锚点："在『validateExportResult』函数编辑（L42）"

─── 处理完 E2E 测试 ───

用户打开 Mission Control，看到两个结构化锚点卡片（v4.0）：
  ┌──────────────────┐  ┌──────────────────┐
  │ 📝 写需求文档     │  │ 📊 数据导出       │
  │ "在『用户故事 3 · │  │ "在               │
  │  验收标准』       │  │  『validateExport  │
  │  一节编辑"        │  │   Result』函数     │
  │ 挂起 5 分钟      │  │  编辑（L42）"      │
  │ [恢复]           │  │ 挂起 2 分钟      │
  └──────────────────┘  │ [恢复]           │
                        └──────────────────┘

用户选择直接跳到"写需求文档"（Free Slices，跳过数据导出）：
  【v4.0 Intent-driven 三级响应】absentDuration = 5 分钟
  → gentle 级别
  → 底部预热条：
    "⏱ 离开 5 分 → 在『用户故事 3 · 验收标准』一节编辑"  [✕]
  → IntentDismissalService.register('gentle-bar', {
      dismissOnSignals: [input, compositionstart, scroll, selectionchange]
    })
  → 用户开始输入或滚动 → gentle-bar 消散 → 恢复

Focus Pod:           📝 写需求文档
                     → gentle 预热条 → 用户内容交互信号触发消散 → 恢复
Suspended Slices:
  [slice-2] 📊 数据导出
            锚点："在『validateExportResult』函数编辑（L42）"

Incubator:
  [2] ⏸ 等待 PM 确认         无时限    📌 manual

注意："数据导出" 留在 Slices 中而非被强制弹出——用户可以稍后回到它，
也可以标记为 hatched 移出。没有 LIFO 限制。

对比 v3.0：Mission Control 中不再使用 NLP 自由生成的语义签名
（如"最后停在：用户故事 3 的验收标准"），而是基于结构化锚点的确定性描述
（如"在『用户故事 3 · 验收标准』一节编辑"）——消除了 NLP 幻觉风险。
gentle 预热条不再 2 秒自动消散，而是等待用户首个内容交互信号后消散
（v5.0：仅 input/compositionstart/scroll/selectionchange，而非任意 mousedown/keydown）。
```

---

## 9. 配置常量

### 9.0 v7.0 → v7.1 简化配置

```typescript
// src/config/overlap.config.ts

export const PARKING_CONFIG = {
  /**
   * 【v7.1 废弃】停泊任务数量硬限制
   * v7.0 原值：MAX_PARKED_TASKS: 5（基于 Miller's Law，但 Miller's Law 不适用于外部化列表）
   * v7.1：改为基于时间的衰老策略（§2.8.4）
   */
  // MAX_PARKED_TASKS: 5,  // ← v7.1 废弃

  /** 【v7.1 新增】停泊任务衰老阈值：超过此时间未访问 → 自动移回普通列表 */
  PARKED_TASK_STALE_THRESHOLD: 48 * 60 * 60 * 1000,  // 48 小时

  /** 【v7.1 新增】停泊任务软上限：显示"任务较多"提示，不强制删除 */
  PARKED_TASK_SOFT_LIMIT: 15,

  /**
   * 【v7.1 修正】超限/衰老通知采用 Intent-based 消散（§2.8.2）
   * 通知持续显示直到用户下次交互，15s 无操作后自动淡出
   * v7.0 原值：OVERFLOW_NOTICE_DURATION: 3_000（3 秒，Fitts 定律下不可用）
   */
  OVERFLOW_NOTICE_FALLBACK_TIMEOUT: 15_000,  // 15s 无操作兜底淡出

  /**
   * 【v7.1 修正】提醒通知也采用 Intent-based 消散（§2.8.6）
   * v7.0 原值：REMINDER_NOTICE_DURATION: 5_000（5 秒自动消失）
   */
  REMINDER_NOTICE_FALLBACK_TIMEOUT: 15_000,  // 15s 无操作兜底淡出

  /**
   * 【v7.1 修正】最后编辑行闪烁时长（§2.8.3）
   * v7.0 原值：200（200ms 脉冲，眼跳落地时已消失）
   * v7.1：1000ms 三段式动画（200ms 亮起 + 500ms 保持 + 300ms 淡出）
   */
  EDIT_LINE_FLASH_DURATION: 1_000,

  /** 切换动画时长（ms） */
  SWITCH_ANIMATION_DURATION: 300,

  /** 侧边栏宽度（px） */
  SIDEBAR_WIDTH: 200,
  SIDEBAR_COLLAPSED_WIDTH: 48,

  /**
   * 【v7.1 废弃】Mission Control 面板触发阈值
   * v7.0 原值：MISSION_CONTROL_THRESHOLD: 2
   * v7.1：停泊列表常驻侧边栏，无需触发阈值（§2.8.5）
   */
  // MISSION_CONTROL_THRESHOLD: 2,  // ← v7.1 废弃

  /** 【v7.1 新增】Snooze 间隔（ms） */
  SNOOZE_INTERVAL: 5 * 60 * 1000,  // 5 分钟

  /** 【v7.1 新增】每个提醒最大 Snooze 次数 */
  MAX_SNOOZE_COUNT: 3,

  /** 【v7.1 新增】通知按钮最小可点击区域（px，Apple HIG） */
  MIN_TOUCH_TARGET: 44,
} as const;
```

**v7.1 vs v7.0 配置对比**：

| 配置项 | v7.0 | v7.1 | 变更原因 |
|-------|------|------|---------|
| `MAX_PARKED_TASKS` | 5 | **废弃** | Miller's Law 不适用于外部化列表 |
| `PARKED_TASK_STALE_THRESHOLD` | — | **48h** | 基于时间的衰老替代数量硬限 |
| `PARKED_TASK_SOFT_LIMIT` | — | **15** | 软上限仅提示，不强制 |
| `OVERFLOW_NOTICE_DURATION` | 3000ms | **Intent-based + 15s fallback** | 3s 在 Fitts 定律下不可用 |
| `REMINDER_NOTICE_DURATION` | 5000ms | **Intent-based + 15s fallback** | 统一消散策略 |
| `EDIT_LINE_FLASH_DURATION` | 200ms | **1000ms** | 200ms 短于眼跳落地时间 |
| `MISSION_CONTROL_THRESHOLD` | 2 | **废弃** | 改为常驻侧边栏 |
| `SNOOZE_INTERVAL` | — | **5min** | v7.1 新增 Snooze |
| `MAX_SNOOZE_COUNT` | — | **3** | 防止无限 Snooze |
| `MIN_TOUCH_TARGET` | — | **44px** | Apple HIG 最小可点击区域 |

> 注：以下为 v1.0-v6.0 的历史配置，保留供参考和回退。

### 9.1 v6.0 配置常量（历史设计）

```typescript
// src/config/overlap.config.ts

export const OVERLAP_CONFIG = {
  /** 孵化器最大容量：防止注意力过载 */
  MAX_INCUBATING_TASKS: 5,

  /** Focus Pod 挂起切片最大数量（v5.0：超出时静默冷冻最久闲置切片，不弹窗） */
  MAX_SUSPENDED_SLICES: 5,

  /** 节拍器检查周期（ms） */
  METRONOME_CHECK_INTERVAL: 30_000,  // 30 秒

  /** 提醒升级时间阈值（分钟）——v2.0：基于 idle 累计时间，非墙上时间 */
  ALERT_ESCALATION: {
    /** 用户 idle 累计 5 分钟未处理 → notice（操作时暂停计时） */
    CALM_TO_NOTICE: 5,
    /** 用户 idle 累计 15 分钟未处理 → alert（操作时暂停计时） */
    NOTICE_TO_ALERT: 15,
  },

  /**
   * 【v3.0 重构】用户空闲判定——多维活跃度检测参数
   * 替代 v2.0 的单一 USER_IDLE_THRESHOLD
   */
  USER_ACTIVITY: {
    /**
     * 基础 idle 阈值（ms）——仅在无法推断 cognitiveLoad 时使用
     * 【v3.0 变更】从 30s 提升为 60s 作为兜底默认值
     */
    BASE_IDLE_THRESHOLD: 60_000,

    /** 按认知负载动态调整的 idle 阈值（ms） */
    COGNITIVE_IDLE_THRESHOLDS: {
      deep: 300_000,      // 5 分钟——深度阅读/设计/构思
      moderate: 120_000,  // 2 分钟——中度认知任务
      shallow: 30_000,    // 30 秒——浅度操作
      passive: 30_000,    // 30 秒——纯被动等待
    },

    /** 微操作事件节流间隔（ms） */
    MICRO_INTERACTION_THROTTLE: 200,

    /**
     * 窗口失焦判定为 idle 的延迟（ms）——blur > 此时长才判 idle
     * 【v4.0 注意】Companion Mode 下此值无效（blur 权重 = 0%）
     */
    WINDOW_BLUR_IDLE_DELAY: 10_000,  // 10 秒

    /** 离席置信度判定阈值：>= 此值判定为 idle */
    ABSENCE_CONFIDENCE_THRESHOLD: 80,

    /** 深度认知关键词（命中时自动提升 idle 阈值到 deep 级别） */
    DEEP_COGNITIVE_KEYWORDS: ['阅读', '设计', '构思', 'review', '分析', '研究', '推演', '思考'],
  },

  /**
   * 【v4.0 新增】伴随模式（Companion Mode）——多屏工作者配置
   */
  COMPANION_MODE: {
    /** blur 权重——Companion Mode 下为 0%（不参与离席判定） */
    BLUR_WEIGHT_COMPANION: 0,
    /** 非 Companion Mode 下 blur 权重——v4.0 从 90% 降为 60% */
    BLUR_WEIGHT_NORMAL: 60,
    /** 智能检测：N 秒内 blur→focus 循环超过此次数则建议开启 Companion Mode */
    SMART_DETECT_WINDOW: 120_000,  // 2 分钟观察窗口
    SMART_DETECT_THRESHOLD: 5,     // 5 次 blur→focus 切换
    /** mouseenter 作为 Gaze Surrogate 的前台确认权重 */
    MOUSEENTER_GAZE_WEIGHT: 40,    // 40%
  },

  /**
   * 【v3.0 新增 / v4.0 修正】记忆衰减曲线——Context Warm-up 三级响应阈值
   */
  MEMORY_DECAY: {
    /** 短时切换阈值（ms）：< 此时长 → instant 级别（不弹遮罩） */
    INSTANT_THRESHOLD: 120_000,  // 2 分钟
    /** 中度遗忘阈值（ms）：< 此时长 → gentle 级别（轻量预热条） */
    GENTLE_THRESHOLD: 900_000,   // 15 分钟
    /** > GENTLE_THRESHOLD → full 级别（【v6.0】右侧 Memory Aid Panel 侧栏，非全屏遮罩） */

    /**
     * 【v4.0 移除】gentle 级别不再使用 GENTLE_AUTO_DISMISS 定时消散。
     * 改由 IntentDismissalService 管理——用户执行恢复动作后消散。
     * 原 GENTLE_AUTO_DISMISS: 2_000 已删除。
     */

    /** instant 级别最后编辑行闪烁时长（ms） */
    INSTANT_FLASH_DURATION: 200,
  },

  /**
   * 【v6.0 新增】记忆辅助面板（Memory Aid Panel）配置——替代 full 级别全屏遮罩
   */
  MEMORY_AID: {
    /** 面板宽度（px）——桌面端 */
    PANEL_WIDTH: 300,
    /** 面板滑出动画时长（ms） */
    SLIDE_DURATION: 200,
    /** 是否强制确认（默认 false——用户可直接操作主内容） */
    FORCE_CONFIRM: false,
    /** 操作轨迹展示条数 */
    TRAIL_DISPLAY_COUNT: 3,
  },

  /**
   * 【v6.0 新增】纠错入口持久化配置
   */
  CORRECTION_PERSISTENT_ENTRY: {
    /** 纠错 ✏️ 图标在孵化器卡片上的显示时长（ms）——Toast 消散后 */
    ICON_DURATION: 180_000,  // 3 分钟
  },

  /**
   * 【v3.0 新增 / v4.0 修正】推断纠错 Toast 配置
   * v4.0 移除了 HIGH_CONFIDENCE_DURATION / LOW_CONFIDENCE_DURATION——
   * Toast 不再基于定时器消散，由 IntentDismissalService 管理。
   */
  CORRECTION_TOAST: {
    /** hover 时暂停 Intent 判定（鼠标在 Toast 上方时不触发消散） */
    PAUSE_ON_HOVER: true,
  },

  /**
   * 【v4.0 新增 / v5.0 信号净化】Intent-based 消散配置——IntentDismissalService 参数
   */
  INTENT_DISMISSAL: {
    /** 【v6.0 缩短】安全兜底最大生存时间（ms）——从 60s 缩短为 15s */
    MAX_LIFETIME: 15_000,  // 15 秒
    /** scroll 判定为"实质性"的最小距离（px） */
    SCROLL_THRESHOLD: 30,
    /**
     * 【v5.0 变更】消散信号默认列表——Blind Click 净化后
     * 剔除 keydown（修饰键/Caps/Esc 假阳性）和 mousedown（盲点击假阳性）
     * 保留的信号全部属于"内容交互边界"——用户确实在操作内容
     */
    DEFAULT_SIGNALS: ['input', 'compositionstart', 'scroll', 'selectionchange'] as const,
    /** selectionchange 判定为"实质性"的最小选区长度 */
    SELECTION_MIN_LENGTH: 1,
    /** 【v6.0 新增】无操作自动淡出时间（ms）——用户看完信息后不操作，UI 自行退场 */
    IDLE_FADEOUT: 10_000,  // 10 秒
    /** 【v6.0 新增】是否默认允许 Escape 键关闭 */
    ALLOW_ESC_CLOSE: true,
    /** 【v6.0 新增】是否默认允许点击空白区域关闭 */
    ALLOW_BLANK_AREA_CLOSE: true,
  },

  /**
   * 【v5.0 新增】锚点临近度退级（Proximity Fallback）配置
   */
  PROXIMITY_FALLBACK: {
    /** 光标距最近结构锚点的最大行数——超过此值触发退级 */
    LINE_THRESHOLD: 30,
    /** 微观纹理采样长度（字符数）——当前行前 N 个非空字符 */
    TEXTURE_LENGTH: 15,
    /** 微观纹理最小有效长度——行内容 < 此值时不附加纹理 */
    TEXTURE_MIN_LENGTH: 3,
  },

  /**
   * 【v5.0 新增 → v6.0 更名】透明归档（Transparent Archival，原 Silent Hibernation）
   * v6.0 变更：冻结时底部状态栏闪现 1.5 秒微提示 + [撤回] 按钮，消除"任务失踪"恐慌
   */
  TRANSPARENT_ARCHIVAL: {
    /** 是否启用透明归档（关闭后退化为 v4.0 的软限制提示行为） */
    ENABLED: true,
    /** 归档目标：挂起切片超限时，最久闲置的切片被平移到孵化器底部 */
    TARGET: 'oldest-idle',
    /** 归档后的 overlapState 值 */
    STATE: 'hibernated' as const,
    /** 【v6.0 新增】微提示显示时长（ms）——冻结时底部状态栏提示 */
    NOTIFICATION_DURATION: 1_500,
  },

  /** 操作轨迹缓冲时长（ms）：保存切换前最近 N 毫秒的操作历史 */
  OPERATION_TRAIL_BUFFER_DURATION: 300_000,  // 5 分钟

  /** 模糊截图最大尺寸（bytes）——v3.0 仅 full 级别使用 */
  SCREENSHOT_MAX_SIZE: 200_000,  // ~200KB

  /** Context Warm-up 遮罩中显示的最近操作条数 */
  WARMUP_TRAIL_DISPLAY_COUNT: 3,

  /** 切换动画时长（ms） */
  SWITCH_ANIMATION_DURATION: 400,
  /** 回弹动画时长（含 warm-up 遮罩展开，仅 full 级别）*/
  BOUNCE_BACK_ANIMATION_DURATION: 800,

  /** 侧边观察窗宽度（px）——v2.0 缩窄 */
  PERIPHERAL_MONITOR_WIDTH: 200,
  PERIPHERAL_MONITOR_COLLAPSED_WIDTH: 48,

  /** 思维快照最大保留数量（LRU 淘汰） */
  MAX_CONTEXT_SNAPSHOTS: 10,

  /** 默认孵化器任务估时（分钟），未设置时的 fallback */
  DEFAULT_ESTIMATED_DURATION: null,  // null = 不显示时间信息

  /** Mission Control 面板触发阈值：suspendedSlices 数量 ≥ 此值时显示全景面板 */
  MISSION_CONTROL_THRESHOLD: 2,
} as const;
```

---

## 10. 实施路线图

### 10.0 v7.0 简化路线图（2 周 + MVP 验证门禁）

> **核心原则**：先验证再建设。用最小实现跑通核心体验，5 名真实用户确认价值后再扩展。

#### 前置：MVP 验证门禁（第 0 天）

在写任何代码之前，先用静态 Figma/纸面原型验证核心假设：

| 验证项 | 方法 | 通过标准 |
|--------|------|---------|
| "切走自动停泊" 是否符合用户直觉 | 5 名用户走查任务切换流程 | ≥4/5 认为"符合预期" |
| "闪烁最后编辑行" 是否足够回忆 | 给用户看停泊 → 恢复的动图 | ≥3/5 认为"够用" |
| 两态模型（当前/稍后）是否够用 | 对比当前切换任务的方式 | ≥3/5 愿意使用 |

**如果未通过：停止开发，重新审视需求。**

#### Phase 0：最小内核（1 周）

| 任务 | 输出 | 说明 |
|------|------|------|
| `TaskParkingMeta` 类型定义 | `src/models/parking.ts` | 4 个字段：`parkedAt`、`lastEditLine`、`lastEditContent`、`reminderAt` |
| 扩展 Task 模型 | `parkingMeta?: TaskParkingMeta` | 可选 JSONB 字段 |
| 数据库迁移 | `parking_meta` JSONB 列 | Supabase 迁移 |
| 同步适配 | `parkingMeta` 纳入增量同步 | 不改变 SimpleSyncService 核心逻辑 |
| `PARKING_CONFIG` 常量 | `src/config/parking.config.ts` | ~8 个常量 |
| `ParkingService` | `parking.service.ts` | `park()` / `restore()` / `evictOldest()` |
| `ContextRestoreService` | `context-restore.service.ts` | 恢复时闪烁最后编辑行 |
| `SimpleReminderService` | `simple-reminder.service.ts` | `setTimeout` + `Notification API` |
| 停泊侧边栏 | `parking-sidebar.component.ts` | 停泊任务列表卡片 |
| Mission Control 面板 | `mission-control.component.ts` | 停泊数 ≥2 时显示 |
| 状态栏通知 | `parking-notification.component.ts` | 超限/提醒/停泊确认 |

**验收门禁**：现有全部测试通过；`parkingMeta` 为 `null` 时零影响；切换任务 → 自动停泊 → 恢复 → 闪烁最后编辑行完整闪回。

#### Phase 1：打磨 + 移动端基础（1 周）

| 任务 | 输出 | 说明 |
|------|------|------|
| 切换/恢复动画 | CSS transitions | 300ms 过渡 |
| 提醒通知交互 | 点击通知 → 切换到对应任务 | 浏览器 Notification API |
| 超限处理 | 最久停泊任务移回普通列表 + 底部提示 | `evictOldest()` |
| 移动端停泊提示 | 浮动圆点 / 简单底部抽屉 | 可选，视初期反馈决定 |
| 离线兼容 | `parkingMeta` IndexedDB 持久化 | 复用现有 idb-keyval 管道 |
| 单元 + 集成测试 | 核心路径覆盖 | `ParkingService` + `ContextRestoreService` |
| E2E 关键路径 | 停泊 → 恢复 → 提醒 → 超限 | Playwright |

**验收门禁**：桌面端完整可用；离线可写可恢复；E2E 通过。

#### Phase 2+：基于用户反馈迭代（后续）

根据 Phase 0-1 上线后的真实使用数据决定是否引入：
- 更丰富的上下文快照（如结构化锚点）
- 智能提醒（基于任务类型）
- 注意力分析报告
- GoJS 视图集成

> 注：以下为 v1.0-v6.0 的历史路线图，保留供参考和回退。

### 10.1 v6.0 实施路线图（历史设计）

#### Phase 0：基础建设（1 周）

| 任务 | 输出 | 依赖 |
|------|------|------|
| 定义 `TaskOverlapMeta` 类型（全字段可选） | `src/models/overlap.ts` | 无 |
| 扩展 Task 模型 | `overlapMeta` 可选字段 | 无 |
| 数据库迁移 | `overlap_meta` JSONB 列 | Supabase |
| 同步适配 | `overlapMeta` 纳入增量同步 | SimpleSyncService |
| 配置常量（v4.0 含 COMPANION_MODE + INTENT_DISMISSAL + MEMORY_DECAY + USER_ACTIVITY） | `overlap.config.ts` | 无 |
| 【v5.0】配置追加 PROXIMITY_FALLBACK + SILENT_HIBERNATION + 信号净化 DEFAULT_SIGNALS | `overlap.config.ts` | 无 |
| 【v6.0】配置追加 TRANSPARENT_ARCHIVAL + MEMORY_AID + CORRECTION_PERSISTENT_ENTRY + 三通道消散 | `overlap.config.ts` | 无 |
| Signal Store（含 `absenceConfidence`（deprecated）+ `multiScreenDetected`） | `overlap-stores.ts` | 无 |
| `OverlapAttributionService` 推断引擎 + `CorrectionToastData` 生成 | 属性自动推断 + 纠错数据 | Task 模型 |
| `ContextSnapshot` 扩展（`structuralAnchor` + `taskTypeIcon` + 【v6.0】`blurredThumbnail`） | 数据模型更新 | 无 |
| **【v4.0】`IntentDismissalService`**——全局消散管理器（**v5.0 信号净化 → v6.0 三通道消散**） | `intent-dismissal.service.ts` | 无 |

**验收门禁：** 现有全部测试通过；新字段 `null` 时零影响；送入孵化器时零配置弹窗；`IntentDismissalService` 单元测试覆盖 register/unregister/maxLifetime/Esc 关闭/空白点击/idle 淡出；v6.0 三通道消散全覆盖。

### Phase 1：核心引擎（2 周）

| 任务 | 输出 | 依赖 |
|------|------|------|
| FocusPodService（Free Slices + 结构化锚点缓存） | `suspendedSlices` + 自由跳转 | Signal Store |
| IncubatorService | 入/出/暂停 | Signal Store |
| MetronomeService（Focus Suppression） | 锚点检测 + **idle 时间**升级 | IncubatorService, UserActivityService |
| `UserActivityService`（**v6.0 二元 idle/active + 多屏自动检测**） | 简化活跃度判定 + `multiScreenDetected` 自动适配 + `visibilityState` 触发 | 无 |
| `ContextWarmUpService`（**v4.0 三级预热 + v5.0 Proximity Fallback + v6.0 Memory Aid Panel + 三通道消散**） | 记忆衰减分级 + `extractStructuralAnchor()` + Memory Aid Panel 侧栏 + 三通道消散 | FocusPodService, IntentDismissalService |
| OverlapService | 总协调：切换/回弹/Mission Control + 【v6.0】透明归档通知 | 以上全部 |

**验收门禁：** 纯逻辑层单元测试全通过；Focus Suppression 测试覆盖；v6.0 二元 idle/active 断言（无贝叶斯评分）；多屏自动检测断言（频繁 blur/focus 切换 → 自动降权）；结构化锚点各内容类型提取测试；gentle 级别三通道消散测试覆盖（内容交互 / Esc / 空白点击 / 10s idle 淡出）；v5.0 Proximity Fallback：距离 > 30 行时附加微观纹理断言；v6.0 Transparent Archival：超限时自动冷冻 + 1.5s 微提示断言；不含 UI。

### Phase 2：桌面端 UI（2 周）

| 任务 | 输出 | 依赖 |
|------|------|------|
| Focus Arena 容器组件 | `overlap-arena.component.ts` | FocusPodService |
| Peripheral Monitor 组件（静态卡片） | `peripheral-monitor.component.ts` | IncubatorService |
| Incubator Card 组件（静态图标 + 置信度 + 【v6.0】✏️ 持久纠错入口） | `incubator-card.component.ts` | 视图模型 |
| 【v6.0】Memory Aid Panel 侧栏（替代 full 级别全屏遮罩） | `memory-aid-panel.component.ts` | ContextWarmUpService |
| 轻量预热条（**v4.0 gentle 级别 + ✕ 按钮 + v6.0 三通道消散**） | `context-warmup-bar.component.ts` | ContextWarmUpService, IntentDismissalService |
| 最后编辑行闪烁指令（**instant 级别**） | `edit-line-flash.directive.ts` | ContextWarmUpService |
| Mission Control 结构化锚点面板 + 【v6.0】模糊缩略图 | `mission-control.component.ts` + `slice-anchor-card.component.ts` | FocusPodService |
| **Correction Toast 纠错浮层（v6.0 三通道消散 + 持久 ✏️ 入口）** | `correction-toast.component.ts` + `correction-panel.component.ts` | OverlapAttributionService, IntentDismissalService |
| 【v6.0】透明归档微提示组件 | `archival-notification.component.ts` | FocusPodService |
| Metronome 视觉反馈（suppressed 级别） | 状态栏文字 / 气泡 | MetronomeService |
| 切换/回弹动画（含三级 Warm-up） | Angular Animations | OverlapService |
| 入口集成 | 任务卡片右键菜单"送入孵化器" | 现有 Text View |

**验收门禁：** 桌面端完整可用；三通道消散（Esc/空白点击/10s idle）+ Memory Aid Panel 侧栏 + 透明归档微提示 + Mission Control 缩略图用户体验验证；E2E 核心路径通过。

### Phase 3：移动端适配 + 打磨（1 周）

| 任务 | 输出 | 依赖 |
|------|------|------|
| 浮动圆点指示器（静态数字） | `overlap-fab.component.ts` | Phase 2 |
| 半屏抽屉（静态卡片 + Mission Control 结构化锚点 + 【v6.0】缩略图） | `incubator-drawer.component.ts` | Phase 2 |
| 手势支持 | 右滑回弹 | Phase 2 |
| Mobile Context Warm-up（三级响应适配 + 触摸三通道消散） | instant: 闪烁 / gentle: 全宽条（触摸消散 + 10s 淡出） / full: 紧凑 Memory Aid Panel | Phase 2 |
| Mobile Correction Toast（触摸三通道消散） | 底部全宽 Snackbar，首次触摸内容区消散 + 10s 淡出，[⬆ 上滑修改] | Phase 2 |
| 移动端多屏自动适配 | 自动检测（移动端通常为单屏，自动禁用多屏适配逻辑） | Phase 2 |
| 性能优化 | 惰性渲染、动画降级 | Phase 2 |
| 离线兼容 | overlapMeta + snapshots IndexedDB 持久化 | Phase 0 |

**验收门禁：** 移动端完整可用；离线场景验证通过。

### Phase 4：智能化（后续迭代）

| 任务 | 说明 |
|------|------|
| 推断准确度优化 | 基于用户历史行为训练 `OverlapAttributionService` 规则权重；Correction Toast 的修正记录作为训练数据 |
| 锚点自动检测 | 集成外部事件源（如 GitHub webhook → PR 审通过） |
| 注意力分析报告 | 统计每日 overlap 效率（前台/后台时间分布） |
| Context Warm-up 个性化 | 学习用户恢复模式：调优记忆衰减阈值，自适应遮罩内容 |
| idle 阈值个性化 | 基于用户历史操作模式，为每个用户学习最佳的 idle 阈值曲线 |
| 协作感知 | 多人场景下，他人的操作触发锚点 |
| **【v4.0 预留】结构化锚点智能分层** | 当简单规则提取失败率较高时，加入轻量 ML 分类器辅助判断锚点类型（但仍以结构信号为主） |
| **【v5.0 预留】Blind Click 学习** | 基于用户行为模式学习窗口激活后"盲点击"的时间窗口（通常 < 500ms），未来可动态调整信号过滤策略 |
| **【v5.0 预留】Proximity Fallback 智能化** | 当微观纹理命中率较高时（用户确实靠它找回方向），自动降低 LINE_THRESHOLD；反之提高 |
| **【v5.0 预留】Silent Hibernation 预测** | 学习用户的切片冷冻/恢复模式——如果某类任务被冷冻后从未恢复，未来自动建议归档 |
| **【v6.0 预留】Memory Aid Panel 个性化** | 学习用户实际使用 Memory Aid Panel 的时长和交互模式——如果用户总是 < 3s 关闭，自动降级为 gentle |
| **【v6.0 预留】纠错模式学习** | 统计 ✏️ 持久入口的使用频率和时机——如果纠错集中在特定任务类型，优化该类任务的推断规则 |
| **【v6.0 预留】用户面向术语 A/B 测试** | 对比"当前任务/后台任务/暂停的任务/已归档" vs 原始术语的用户理解度与操作准确度 |

---

## 11. 风险评估与规避

### 11.0 v7.0 简化风险评估

#### 技术风险

| 风险 | 影响 | 概率 | 规避 |
|------|------|------|------|
| `parkingMeta` 增大同步体积 | 增量同步略慢 | 低 | 4 字段 JSONB，体积极小（< 200 bytes） |
| 最后编辑行闪烁位置偏移 | 内容变更后行号不准 | 中 | `contentHash` 校验 + 不匹配时 fallback 到文档开头 |
| GoJS 切换开销 | 停泊/恢复时卡顿 | 高 | 遵守现有规则：彻底销毁/重建；优先 Text View |
| 浏览器 Notification 权限 | 用户拒绝通知 | 中 | 降级为页面内 Snackbar 提示 |

#### 产品风险

| 风险 | 影响 | 规避 |
|------|------|------|
| 两态模型过于简单 | 用户需要更多状态 | MVP 验证后按需扩展；框架预留扩展点 |
| 停泊功能与普通任务列表混淆 | 用户不理解差异 | 停泊 = "待会儿回来"；任务列表 = "所有事"，通过 UI 引导区分 |
| 最后编辑行闪烁不够回忆 | 用户需要更多上下文 | Phase 2 按反馈判断是否增加结构化锚点 |

#### 回滚策略

- **数据层**：`parkingMeta` 为可选字段，回滚只需前端忽略读取
- **UI 层**：停泊侧边栏独立组件，移除不影响主流程
- **服务层**：3 个 service 无侵入式注入，不修改现有核心逻辑

> 注：以下为 v1.0-v6.0 的历史风险评估，保留供参考和回退。

### 11.1 v6.0 风险评估（历史设计）

#### 11.1.1 技术风险

| 风险 | 影响 | 概率 | 规避措施 |
|------|------|------|---------|
| `overlapMeta` 增大同步体积 | 增量同步变慢 | 中 | JSONB 仅在变更时同步；压缩 checkpoint 历史 |
| 挂起切片过多导致内存占用 | 页面性能退化 | 低 | 软限制 `MAX_SUSPENDED_SLICES = 5`；超出时 v5.0 静默冷冻最久闲置切片到孵化器（不弹窗） |
| 操作轨迹缓冲区内存占用 | 长时间使用后内存增长 | 中 | 固定 5 分钟滑动窗口 + LRU 淘汰；截图限 200KB |
| MetronomeService 定时器内存泄漏 | 页面性能退化 | 低 | 退出 Overlap 模式时清理所有 `setInterval`；`DestroyRef` 守护 |
| 思维快照与内容不同步 | 恢复后光标位置错误 | 中 | `contentHash` 校验 + 不匹配时 fallback 到文档开头 + Warm-up 遮罩兜底 |
| GoJS Flow View 在 Focus Pod 中的销毁/重建开销 | 切换卡顿 | 高 | 遵守现有 GoJS 规则：彻底销毁/重建，不缓存；切换时优先 Text View |
| `UserActivityService` 多维事件监听性能 | 不必要的 CPU 消耗 | 低 | 全部 passive listeners + 节流（throttle 200ms）；`visibilitychange` 和 `blur` 无需节流 |
| 【v3.0】动态 idle 阈值误判 | 深度阅读被误判为 idle，或真离开被误判为 active | 中 | `visibilityState === 'hidden'` 作为硬信号兜底（100% 置信度）；阈值可通过配置调整；Phase 4 引入个性化学习 |
| 【v3.0】语义签名生成失败 | Mission Control 无法有效区分切片 | 低 | 兜底策略：无操作轨迹时使用 `task.title` 前 30 字符作为签名 |
| 【v3.0】Correction Toast 与页面布局冲突 | Toast 被遮挡或覆盖重要内容 | 低 | Toast 固定在底部右侧，z-index 高于侧边栏但低于 modal；移动端改为全宽 Snackbar |
| 【v4.0 新增】IntentDismissalService 事件丢失 | Toast/预热条永不消散 | 低 | `maxLifetimeMs = 60_000` 安全兜底；组件 `onDestroy` 自动 unregister |
| 【v4.0 新增】Companion Mode 误开启 | 用户真的离开了但 blur 信号被忽略 | 中 | `visibilityState === 'hidden'` 仍为 100% 硬信号，不受 Companion Mode 影响；仅 blur 权重降为 0 |
| 【v4.0 新增】结构化锚点提取失败 | 非标准内容（纯图片/空白任务）无法提取有意义锚点 | 中 | Fallback 到 `task.title` 前 30 字符 + `action: 'edit'`；GoJS 节点使用 `node.text` |
| 【v4.0 新增】频繁 register/unregister 性能 | IntentDismissalService 注册表膨胀 | 低 | register 前先 unregister 同 ID；maxLifetime 到期自动清理；最大注册数限制 |
| 【v5.0 新增】Blind Click 信号净化过严 | 用户用鼠标点击编辑区域开始工作，但 `mousedown` 已被剔除，Toast/预热条不消散 | 中 | 【v6.0 缓解】新增 Esc 关闭 + 点击空白关闭 + 10 秒无操作淡出三通道；`maxLifetimeMs` 缩短至 15s；`✕` 按钮始终可用 |
| 【v5.0 新增】Proximity Fallback 微观纹理泄露敏感信息 | 当前行前 15 字符可能包含 API Key / 密码等敏感内容 | 低 | 微观纹理仅存储在本地 `ContextSnapshot` 中，不参与云同步；若 overlapMeta 同步时可剥离 `proximityText` 字段 |
| 【v5.0→v6.0 修正】透明归档用户困惑 | 用户发现切片被移动 | 低 | 【v6.0】冻结时底部状态栏闪现 1.5 秒微提示 + [撤回] 按钮；孵化器卡片 `🧊` 图标 + hover 提示 |
| 【v5.0 新增】短文件（< 30 行）的 Proximity Fallback 永远不退级 | 小文件中结构锚点和光标距离永远 ≤ 30 行，微观纹理从不出现 | 低 | 这是正确行为——短文件中结构锚点本身已足够精准，无需额外纹理 |
| 【v6.0 新增】10 秒淡出导致用户还在读时 UI 消失 | 用户阅读速度慢于 10 秒 | 低 | 淡出只影响 gentle 级别的轻量预热条（一行文字），正常阅读 < 5 秒；且用户任意微操作（鼠标动一下）即重置淡出计时器 |
| 【v6.0 新增】Mission Control 截图增加存储 | 每张 ≤ 30KB，5 张共 150KB | 低 | 在 LRU 淘汰策略下总量可控；截图失败时优雅降级为纯文字 |
| 【v6.0 新增】记忆辅助面板遮挡侧边栏 | 300px 面板可能与 200px 侧边观察窗重叠 | 中 | 面板打开时侧边栏自动折叠为 48px 图标条；面板关闭后恢复 |

#### 11.1.2 产品风险

| 风险 | 影响 | 规避措施 |
|------|------|---------|
| 用户不理解"孵化器"概念 | 功能弃用率高 | 【v6.0】UI 标签改为日常直觉命名"后台任务"；Zero-Config 入口 + Correction Toast |
| 过度孵化：用户把所有任务都丢孵化器 | 失去 overlap 意义 | 容量限制 + 提示"孵化器不是待办列表" |
| Context Warm-up 遮罩被视为打扰 | 用户跳过不看 | 【v3.0 修正】三级响应——短时切走不弹遮罩，中度仅轻量条，仅长时间离开才弹完整遮罩 |
| Zero-Config 推断不准确 | 用户不信任系统 | 【v4.0 修正】Correction Toast 驻留至用户首个实质性动作——用户有充裕时间审视推断；低置信度时高亮 [修改]；推断结果始终可手动覆盖 |
| Focus Suppression 导致重要提醒被延迟 | 紧急锚点被淹没 | 【v3.0 修正】`visibilityState === 'hidden'` 立即触发 idle（人离开时提醒不被压制）；deep 认知任务有 5 分钟宽限期而非无限压制 |
| 【v3.0】记忆衰减阈值设置不当 | 2 分钟/15 分钟的分界点不适合所有人 | 阈值可配置化（`MEMORY_DECAY.INSTANT_THRESHOLD` / `GENTLE_THRESHOLD`）；Phase 4 学习用户的实际恢复模式 |
| 【v3.0→v6.0 修正】Correction Toast 被忽视 | 推断错误无法被及时纠正 | 【v6.0】Toast 消散后孵化器卡片右上角保留 ✏️ 图标 3 分钟，点击可展开纠错面板；`maxLifetimeMs` 缩短至 15s + 10 秒淡出双保险 |
| 【v4.0→v6.0 修正】gentle 预热条驻留过长 | 用户觉得条"粘住了" | 【v6.0】新增 Esc/空白点击/10 秒无操作三通道关闭；`maxLifetimeMs` 从 60s 缩短至 15s |
| 【v4.0→v6.0 修正】Companion Mode 概念增加认知负担 | 用户不理解何时启用 | 【v6.0】废弃用户面向概念；系统自动检测多屏行为并适配；设置中降级为"多窗口工作优化"仅高级用户可见 |
| 【v5.0→v6.0 修正】透明归档导致"任务失踪"恐慌 | 用户不知道切片去了哪里 | 【v6.0】冻结时底部状态栏闪现 1.5 秒微提示 + [撤回] 按钮；孵化器 🧊 图标 + hover 提示 |
| 【v5.0→v6.0 缓解】信号净化后 Toast 驻留时间变长 | mousedown/keydown 被剔除后需内容交互才消散 | 【v6.0】新增 10 秒无操作淡出 + Esc 关闭两个额外通道，实际驻留时间大幅缩短 |

#### 11.1.3 回滚策略

- **数据层**：`overlapMeta` 为可选字段，回滚只需前端忽略读取
- **UI 层**：Overlap 视图独立于现有 Text/Flow View，移除不影响主流程
- **服务层**：所有 overlap services 无侵入式注入（不修改 `TaskOperationAdapterService` 核心逻辑）
- **v2.0 新增**：`UserActivityService` 和 `ContextWarmUpService` 可独立禁用，回退到 v1.0 行为

---

## 12. 验收标准

### 12.0 v7.0 → v7.1 简化验收标准

#### 12.0.1 功能验收（22 项，含 v7.1 新增 7 项）

| 编号 | 场景 | 预期结果 |
|------|------|---------|
| P-01 | ~~切换到另一个任务~~ **双击/[开始做] 切换任务** | 当前任务自动停泊，`parkingMeta` 写入 `parkedAt` + `lastEditLine` + `lastEditContent` |
| P-02 | 从停泊列表恢复任务 | 任务回到主舞台，最后编辑行 **1000ms 三段式闪烁**（200ms 亮起 + 500ms 保持 + 300ms 淡出） |
| P-03 | 停泊列表显示 | 侧边栏**常驻显示**所有停泊任务（≥1 即可见），每张卡片：标题 + 停泊时长 + 上下文摘要 + [查看]/[开始做]/[×] |
| P-04 | ~~Mission Control 触发~~ | **v7.1 废弃**——停泊列表常驻侧边栏，无需弹窗触发 |
| P-05 | 设置提醒 | 停泊任务可设置"X 分钟后提醒"，到期触发 Intent-based Snackbar + 浏览器 Notification |
| P-06 | 提醒通知交互 | 点击 [切换过去] → 自动切换到对应任务 |
| P-07 | ~~超限自动驱逐~~ **48h 衰老清理** | 停泊任务连续 48 小时未被访问 → 自动移回普通列表 + Intent-based 通知含 [撤回] |
| P-08 | 退出时清理 | 关闭功能 / 切换模式时，所有提醒定时器清理 |
| P-09 | 离线停泊 | 断网时停泊/恢复正常工作，联网后 `parkingMeta` 同步 |
| P-10 | `contentHash` 校验 | 恢复时内容已变（hash 不匹配）→ **放弃滚动恢复，仅恢复光标位置** |
| P-11 | 空任务停泊 | 空内容任务停泊 → `lastEditLine = null`，恢复时不闪烁 |
| P-12 | 通知权限拒绝降级 | 浏览器通知被拒 → 降级为页面内 Snackbar |
| P-13 | 未启用停泊的用户 | 无感知、无性能影响（`parkingMeta` 为 `null`） |
| P-14 | 同步兼容 | `parkingMeta` 正确参与增量同步 + LWW |
| P-15 | 数据迁移可逆 | 迁移脚本可逆，回滚后 `parking_meta` 列可安全忽略 |
| **P-16** | **【v7.1】单击=预览** | 单击停泊卡片 → 打开详情面板，**不切换 Focus，不停泊当前任务** |
| **P-17** | **【v7.1】双击=切换** | 双击停泊卡片 / 点击 [开始做] → 执行完整 Focus 切换 |
| **P-18** | **【v7.1】Snooze 提醒** | 点击 [5 分钟后再提醒] → 通知消散，5 分钟后再次触发；最多 Snooze 3 次 |
| **P-19** | **【v7.1】手动移除停泊** | 点击卡片 [×] / 左滑 → 任务从停泊列表移回普通列表 |
| **P-20** | **【v7.1】内容锚点滚动恢复** | 恢复时通过 anchorType+anchorIndex 定位 → `scrollIntoView()`；跨设备一致 |
| **P-21** | **【v7.1】Intent-based 消散** | 所有通知（驱逐/提醒）显示至用户下次交互后消失，15s 无操作兜底淡出 |
| **P-22** | **【v7.1】[撤回] 按钮可用性** | [撤回] 按钮最小 44×44px，位于通知右侧最易够到位置 |

#### 12.0.2 性能验收

| 指标 | 阈值 |
|------|------|
| 停泊操作（写入 `parkingMeta`） | < 50ms |
| 恢复操作（读取 + 闪烁） | < 100ms |
| 切换动画帧率 | ≥ 60fps（桌面） |
| 停泊侧边栏渲染 | < 16ms（单帧内） |
| 停泊功能激活时额外内存 | < 2MB |

#### 12.0.3 兼容性验收

| 维度 | 要求 |
|------|------|
| 现有测试 | 全部通过，零回归 |
| Hard Rules | 全部 5 条仍成立 |
| 同步 | `parkingMeta` 参与增量同步 + LWW |
| 回退 | 前端忽略 `parkingMeta` 即可回退到无停泊状态 |

> 注：以下为 v1.0-v6.0 的历史验收标准（51 项测试用例），保留供参考和回退。

### 12.1 v6.0 功能验收（历史设计）

| 编号 | 场景 | 预期结果 |
|------|------|---------|
| F-01 | 将任务一键送入孵化器 | 任务出现在侧边观察窗（静态图标），**零配置弹窗** |
| F-02 | 设置 Focus Pod 任务 | 主舞台仅显示该任务内容，无干扰元素 |
| F-03 | 锚点触发（用户操作中） | **侧边栏零变化**（Focus Suppression：suppressed） |
| F-04 | 锚点触发（用户 idle） | 卡片图标静态变更为 🔔，**无呼吸灯动画** |
| F-05 | 切换到孵化器任务 | 当前任务快照保存（含操作轨迹 + **结构化锚点**），目标任务在主舞台展示 |
| F-06 | 回弹（离开 < 2 分钟） | **instant 级别**：直接恢复 + 最后编辑行闪烁，**不弹任何遮罩** |
| F-07 | 回弹（离开 2-15 分钟） | **v4.0 gentle 级别**：底部轻量预热条（含 ✕ 按钮），**用户首个实质性动作后消散**（非定时器）；**v6.0**：额外支持 Esc / 空白点击 / 10s 无操作淡出 |
| F-08 | 回弹（离开 > 15 分钟） | **full 级别**：【v6.0】右侧 300px Memory Aid Panel 侧栏，显示操作轨迹 + 截图，不阻塞主内容；交互或 10s 无操作后自动收起 |
| F-09 | Free Slices 自由跳转 | 从 Mission Control 选择任意挂起切片直接跳转（非 LIFO 顺序） |
| F-10 | Mission Control 结构化锚点 | `suspendedSlices ≥ 2` 时显示**结构化锚点卡片**（如"在『XXX』函数编辑"）+ 【v6.0】60×80px 模糊缩略图，一眼区分各切片 |
| F-11 | 孵化完成 | 卡片状态变更为 ✅，可移出/标记完成 |
| F-12 | 退出 Overlap 模式 | 所有定时器清理，IntentDismissalService 清空注册，回到普通视图 |
| F-13 | 离线状态下操作 | 本地正常运作，联网后 overlapMeta 同步 |
| F-14 | 移动端完整流程 | 浮动圆点/抽屉/Mission Control/手势可用 |
| F-15 | Focus Suppression 验证 | 用户持续操作时，所有提醒冻结在 suppressed，**零视觉变化** |
| F-16 | Zero-Config 验证 | 送入孵化器后立即可用，`OverlapAttributionService` 自动推断属性 |
| F-17 | 【v3.0】深度阅读保护 | Focus Pod 任务 cognitiveLoad='deep' 时，沉默 4 分钟仍维持 active（idle 阈值 5 分钟） |
| F-18 | 【v3.0】标签页切走立即 idle | 用户切走标签页（`visibilityState=hidden`），即使动态阈值未到也立即判定 idle |
| F-19 | 【v4.0→v5.0 修正】Correction Toast 内容交互消散 | 送入孵化器后底部出现微型纠错浮层，**驻留至用户在 Focus Pod 执行首个内容交互信号**（input/compositionstart/scroll>30px/selectionchange），mousedown/keydown **不触发**消散 |
| F-20 | 【v3.0】Correction Toast 纠错 | 点击 [修改] 可展开紧凑面板修正推断；点击 [撤回入舱] 可将任务从孵化器取回 |
| F-21 | 【v3.0】微操作重置 idle | 深度阅读中的微滚动/鼠标微移重置 idle 计时器 |
| F-22 | 【v4.0 新增】Companion Mode blur 忽略 | 启用 Companion Mode 后，窗口 blur **不影响** absenceConfidence；仅 `visibilityState='hidden'` 判定离开 |
| F-23 | 【v4.0 新增】Companion Mode 智能检测 | 2 分钟内 blur→focus 切换 ≥5 次 → 系统建议启用 Companion Mode |
| F-24 | 【v4.0 新增】结构化锚点 Markdown | Markdown 内容 → 提取最近的 H2/H3 标题作为锚点（如"在『API 设计』一节编辑"） |
| F-25 | 【v4.0 新增】结构化锚点 Code | 代码内容 → 提取最近的函数/类名作为锚点（如"在『handleSubmit』函数编辑"） |
| F-26 | 【v4.0 新增】结构化锚点 Fallback | 无法提取结构锚点 → 使用 `task.title` 前 30 字符 + `action: 'edit'` |
| F-27 | 【v4.0 新增】gentle 预热条 ✕ 按钮 | gentle 级别预热条右侧有 ✕ 按钮，点击可立即关闭预热条 |
| F-28 | 【v4.0 新增】IntentDismissalService maxLifetime | Toast/预热条注册后 60 秒无 Intent 信号 → 安全兜底强制消散 |
| F-29 | 【v4.0 新增】mouseenter Gaze Surrogate | Companion Mode 下，鼠标从外部进入窗口 → 确认用户在看此窗口（`mouseenter` 权重 40%） |
| F-30 | 【v5.0 新增】Blind Click 不触发消散 | 用户切窗回来后 mousedown（盲点击窗口激活） → Toast/预热条**不消散**；用户随后开始打字（input 事件） → 消散 |
| F-31 | 【v5.0 新增】修饰键不触发消散 | 用户按下 Shift/Ctrl/Alt/Meta/CapsLock → Toast/预热条**不消散**；用户随后输入真实字符（input 事件） → 消散 |
| F-32 | 【v5.0 新增】selectionchange 消散 | 用户在 Focus Pod 中拖拽选中一段文本（`selectionchange` 且 `selection.toString().length > 0`） → 消散 |
| F-33 | 【v5.0 新增】compositionstart 消散 | 用户使用中文输入法开始输入（`compositionstart` 事件）→ 消散（无需等待 `compositionend`） |
| F-34 | 【v5.0 新增】Proximity Fallback 激活 | 光标在距最近结构锚点 > 30 行处切走 → 快照签名包含微观纹理"修改了『[前15字符]...』" |
| F-35 | 【v5.0 新增】Proximity Fallback 不激活 | 光标在距最近结构锚点 ≤ 30 行处切走 → 快照签名仅含结构锚点，无微观纹理附加 |
| F-36 | 【v5.0 新增】Proximity Fallback 空行跳过 | 光标所在行内容 < 3 字符 → `proximityText = null`，签名退化为纯结构锚点 |
| F-37 | 【v5.0→v6.0 修正】透明归档自动冻结 | 挂起切片达到 6 个（> MAX_SUSPENDED_SLICES） → 最久闲置的切片自动平移到孵化器底部，`overlapState = 'hibernated'`，**底部状态栏闪现 1.5 秒微提示 + [撤回] 按钮** |
| F-38 | 【v5.0 新增】透明归档孵化器可见性 | 被冷冻的切片在孵化器底部以 `🧊` 图标显示，hover 提示"由系统自动归档" |
| F-39 | 【v5.0 新增】透明归档恢复 | 用户从孵化器中选择被冷冻的任务"恢复到 Focus Pod" → 正常恢复，含 Context Warm-up 三级响应 |
| F-40 | 【v6.0 新增】Escape 键关闭 | gentle 级别预热条 / Correction Toast 均可通过 Escape 键立即关闭 |
| F-41 | 【v6.0 新增】点击空白区域关闭 | gentle 级别预热条 / Correction Toast 可通过点击编辑区外空白处关闭 |
| F-42 | 【v6.0 新增】10 秒无操作淡出 | gentle 级别预热条 / Correction Toast 在用户 10 秒无任何键鼠操作后自动 200ms 淡出 |
| F-43 | 【v6.0 新增】full 级别侧栏面板 | 离开 > 15 分钟回弹时，右侧滑出 300px 记忆辅助面板，**主内容不被遮挡**，用户可直接操作 |
| F-44 | 【v6.0 新增】full 级别面板 Soft Dismissal | 记忆辅助面板可通过 Esc / 点击面板外 / 内容交互 / 10 秒无操作 关闭 |
| F-45 | 【v6.0 新增】Mission Control 图文并茂 | 挂起切片卡片同时显示 60×80px 模糊缩略图（左侧）+ 结构化锚点文字（右侧） |
| F-46 | 【v6.0 新增】截图缺失优雅降级 | 截图保存失败时，Mission Control 卡片仅显示任务类型色块占位 + 结构化锚点文字 |
| F-47 | 【v6.0 新增】纠错持久入口 | Correction Toast 消散后，孵化器卡片右上角显示 ✏️ 图标（3 分钟内可见），点击展开纠错面板 |
| F-48 | 【v6.0 新增】活跃度二元判定 | 废弃 absenceConfidence 评分，简化为：有键鼠事件 → active，超时无事件 → idle |
| F-49 | 【v6.0 新增】多屏自动适配 | 2 分钟内 blur→focus ≥5 次 → 系统自动延长 blur 时 idle 判定至 30 秒，**无弹窗、无开关、无用户概念** |
| F-50 | 【v6.0 新增】透明归档撤回 | 用户在 1.5 秒微提示中点击 [撤回] → 切片恢复到挂起列表 |
| F-51 | 【v6.0 新增】UI 标签直觉化 | 用户可见标签使用日常命名（当前任务/后台任务/暂停的任务/已归档），代码层保持原术语 |

### 12.2 v6.0 性能验收（历史设计）

| 指标 | 阈值 |
|------|------|
| 切换动画帧率 | >= 60fps（桌面），>= 30fps（移动端） |
| 快照保存耗时（含操作轨迹 + 截图） | < 100ms |
| 快照恢复耗时 | < 100ms |
| Context Warm-up 遮罩渲染 | < 50ms |
| Metronome 定时器精度 | ±2 秒偏差内 |
| Overlap 模式激活时的额外内存占用 | < 8MB（含操作轨迹缓冲） |
| 侧边观察窗渲染时间 | < 16ms（单帧内） |
| UserActivityService 事件处理 | < 1ms（节流后） |

### 12.3 v6.0 兼容性验收（历史设计）

| 维度 | 要求 |
|------|------|
| 现有测试 | 全部通过，零回归 |
| 未启用 Overlap 的用户 | 无感知、无性能影响 |
| 同步 | `overlapMeta` 正确参与增量同步 + LWW |
| 数据库 | 迁移脚本可逆 |
| Hard Rules | 全部 5 条 Hard Rules 仍成立 |
| v1.0 回退 | 禁用 `UserActivityService` + `ContextWarmUpService` 后可回退到 v1.0 行为 |
| v3.0 回退 | 禁用三层推断模型后可回退到 v2.0 的 30 秒单一阈值行为；禁用 Correction Toast 后回退到无纠错窗口；禁用语义签名后回退到截图 |
| v4.0 回退 | 禁用 `IntentDismissalService` → Toast/gentle 回退到 v3.0 定时消散；禁用 `companionMode` → blur 权重回退到 v3.0 的 90%；禁用结构化锚点 → 回退到 v3.0 NLP 语义签名 |
| v5.0 回退 | 将 `DEFAULT_SIGNALS` 改回 `['keydown', 'scroll', 'mousedown']` → 回退到 v4.0 的意图信号集合；禁用 `SILENT_HIBERNATION.ENABLED` → 回退到 v4.0 软限制提示；禁用 `PROXIMITY_FALLBACK` → 回退到 v4.0 纯结构锚点（无微观纹理） |
| v6.0 回退 | 禁用 `IDLE_FADEOUT` + `ALLOW_ESC_CLOSE` + `ALLOW_BLANK_AREA_CLOSE` → 回退到 v5.0 纯内容交互消散；将 `MEMORY_AID.PANEL_WIDTH` 设为 `0` + `FORCE_CONFIRM: true` → 回退到 v5.0 全屏遮罩；禁用 `TRANSPARENT_ARCHIVAL.NOTIFICATION_DURATION` → 回退到 v5.0 静默冷冻；禁用 `CORRECTION_PERSISTENT_ENTRY` → 回退到 v5.0 无持久入口；将 `USER_ACTIVITY` 恢复三层推断 → 回退到 v5.0 的贝叶斯活跃度模型 |

---

## 附录 A：术语表

### v7.0 核心术语

| 术语 | 定义 |
|------|------|
| **Parking（停泊）** | v7.0 核心概念——将当前任务暂时搁置，标记为"稍后回来"的简单操作 |
| **Parked Task（停泊任务）** | 被停泊的任务，保存了 `lastEditLine` 和 `lastEditContent` 用于恢复上下文 |
| **Active Task（活跃任务）** | 当前正在编辑的唯一任务 |
| **Auto-park（自动停泊）** | v7.0 替代"送入孵化器"仪式——切换任务时自动停泊当前任务，无需用户主动操作 |
| **Edit Line Flash（编辑行闪烁）** | v7.0 唯一的上下文恢复方式——恢复任务时闪烁高亮最后编辑行，帮助用户快速回忆 |
| **Simple Reminder（简单提醒）** | v7.0 替代 Metronome 节拍器——基于 `setTimeout` + 浏览器 `Notification API` 的可选定时提醒 |
| **Mission Control（任务管制）** | 保留——停泊数 ≥ 2 时显示的面板，帮助用户在多个停泊任务间导航 |
| **Overflow Eviction（超限驱逐）** | v7.0 简化超限处理——停泊数超过 `MAX_PARKED_TASKS` 时，最久停泊的任务自动移回普通列表 |

### v1.0-v6.0 历史术语

| 术语 | 定义 |
|------|------|
| **State Overlap（状态重叠）** | 利用一件事的等待/被动时间窗口推进另一件事的工作范式 |
| **Focus Pod（专注舱）** | 承载当前唯一需要心智介入的任务的 UI 区域 |
| **Incubator（孵化器）** | 承载正在"后台运行"（等待、处理中）的任务集合 |
| **Suspended Slice（挂起切片）** | v2.0 替代 PauseStack 的扁平数据结构——保存了快照的暂离任务，可自由跳转 |
| **Mission Control（任务管制）** | v2.0 新增——当挂起切片 ≥2 时出现的全景缩略图面板，支持自由导航 |
| **Metronome（节拍器）** | 监控孵化器任务状态并在恰当时机发出非侵入式提醒的协调模块 |
| **Focus Suppression（焦点抑制）** | v2.0 新增——用户操作时冻结所有视觉提醒，idle 后才展示 |
| **Checkpoint（锚点）** | 后台任务中预设的"需要人介入"的时间点或条件 |
| **Context Warm-up（上下文预热）** | v2.0 替代 Context Snapshot 直接恢复——回弹时先展示操作轨迹和模糊截图，帮助大脑"热身" |
| **Operation Trail（操作轨迹）** | v2.0 新增——自动记录的最近 5 分钟用户操作历史，用于 Context Warm-up |
| **Bounce Back（回弹）** | 从临时处理的孵化器任务返回之前的 Focus 任务 |
| **Cognitive Load（心智负载）** | 任务对用户认知资源的需求等级 |
| **Immersion Protection（沉浸保护）** | 系统避免在用户深度专注时主动打断的机制 |
| **Zero-Config（零配置入口）** | v2.0 新增——送入孵化器时系统自动推断所有属性，无需用户手动配置 |
| **Correction Toast（推断纠错浮层）** | v3.0 新增——入舱后展示的微型浮层，3 秒内可一键修正推断结果 |
| **Memory Decay Function（记忆衰减曲线）** | v3.0 新增——基于离开时长的三级预热响应，短时秒回、中度轻推、长时完整重建 |
| **Warm-up Tier（预热级别）** | v3.0 新增——instant（< 2 分钟）/ gentle（2-15 分钟）/ full（> 15 分钟） |
| **Absence Confidence Score（离席置信度）** | v3.0 新增——多维信号叠加的综合评分（0-100），≥ 80 判定为 idle |
| **Three-Layer Inference Model（三层推断模型）** | v3.0 新增——微操作信号 + 认知上下文 + 离席置信度的多维活跃度判定 |
| **Semantic Signature（语义签名）** | v3.0 新增——切片的文字化身份标识（"最后停在：XXX"），替代模糊截图用于 Mission Control 导航。**v4.0 被结构化锚点取代** |
| **Micro-Interaction Signals（微操作信号）** | v3.0 新增——微滚动、鼠标微移、文本选中等细粒度用户行为信号 |
| **Structural Anchor（结构化锚点）** | v4.0 新增——基于内容结构（Heading/Function/ListItem/Paragraph/GoJS-node）提取的确定性"你在哪"标识，替代 v3.0 的 NLP 语义签名 |
| **Intent-based Dismissal（意图驱动消散）** | v4.0 新增——UI 元素（Toast、预热条）不再基于定时器自动消散，而是等待用户的下一个实质性动作（键盘/滚动/点击）后消散 |
| **IntentDismissalService** | v4.0 新增——全局 Intent-based 消散管理服务，统一管理所有需"等待用户动作后消散"的 UI 元素的注册、监听和触发 |
| **Companion Mode（伴随模式）** | v4.0 新增——为多屏工作者设计的模式：关闭 `window.blur` 的离席权重（0%），仅依赖 `visibilityState === 'hidden'` 判定离开 |
| **Gaze Surrogate（注视代理）** | v4.0 新增——`mouseenter` 事件作为用户"正在看这个窗口"的代理信号，Companion Mode 下用于确认前台状态 |
| **maxLifetimeMs（最大生存时间）** | v4.0 新增——IntentDismissalService 的安全兜底参数（默认 60 秒），防止 UI 元素因事件路径异常而永驻 |
| **Blind Click（盲点击）** | v5.0 新增——用户切窗回来后无意识地 mousedown 一次以激活窗口的行为，不代表用户已读完 Toast/预热条内容。v5.0 将其从意图信号中剔除 |
| **Content Interaction Signal（内容交互信号）** | v5.0 新增——`input` / `compositionstart` / `scroll(>30px)` / `selectionchange(span>0)`——只有产生了内容副作用的动作才算"用户已进入下一状态"的证据，替代 v4.0 的 keydown/mousedown |
| **Proximity Fallback（锚点临近度退级）** | v5.0 新增——当光标距最近结构锚点 > 30 行时，在签名后附加当前行前 15 字符的微观纹理，增强位置记忆唤醒精度 |
| **Micro-texture（微观纹理）** | v5.0 新增——Proximity Fallback 中附加的当前行前 15 字符片段，以 `『...』` 包裹显示。不依赖 NLP，只依赖视觉记忆 |
| **Silent Hibernation（静默冷冻）** | v5.0 新增——当挂起切片数超过 MAX_SUSPENDED_SLICES 时，系统自动将最久闲置的切片平移到孵化器底部，标记为 `hibernated`。**v6.0 更名为 Transparent Archival**（透明归档） |
| **Transparent Archival（透明归档）** | v6.0 新增——替代 v5.0 Silent Hibernation。归档时底部状态栏闪现 1.5s 微提示 + [撤回] 按钮，不阻塞但可感知 |
| **Soft Dismissal（柔性消散）** | v6.0 新增——三通道关闭机制：内容交互信号 + Esc/空白点击手动关闭 + 10s 无操作自动淡出。替代 v5.0 纯内容交互单通道 |
| **Memory Aid Panel（记忆辅助面板）** | v6.0 新增——替代 v5.0 full 级别全屏遮罩。右侧 300px 侧栏，显示操作轨迹 + 截图，不阻塞主内容区 |
| **Three-Channel Dismissal（三通道消散）** | v6.0 新增——Soft Dismissal 的具体实现：(1) 内容交互 (2) 手动关闭（Esc/空白点击）(3) 10s idle 自动淡出 |
| **Multi-screen Auto-detection（多屏自动检测）** | v6.0 新增——替代 v4.0 Companion Mode 用户面向概念。系统自动检测频繁 blur/focus 切换行为并适配，无需用户手动开启 |

## 附录 B：组件清单（v6.0 预估）

```
src/app/features/overlap/
├── overlap-mode.component.ts              # 容器组件（类似 focus-mode.component.ts）
├── components/
│   ├── focus-arena/
│   │   ├── focus-arena.component.ts       # 主舞台容器
│   │   ├── focus-breadcrumb.component.ts  # 顶部面包屑
│   │   ├── bounce-back-button.component.ts # 回弹按钮
│   │   ├── memory-aid-panel.component.ts  # 【v6.0】Memory Aid Panel 侧栏（替代 full 级别全屏遮罩）
│   │   ├── context-warmup-bar.component.ts    # v3.0→v4.0→v6.0: 轻量预热条（gentle 级别，三通道消散）
│   │   └── edit-line-flash.directive.ts       # v3.0: 最后编辑行闪烁（instant 级别）
│   ├── peripheral-monitor/
│   │   ├── peripheral-monitor.component.ts # 侧边观察窗容器
│   │   ├── incubator-card.component.ts    # 孵化器任务卡片（静态图标）+ 【v6.0】✏️ 持久纠错入口
│   │   └── monitor-collapse-toggle.component.ts # 折叠开关
│   ├── mission-control/
│   │   ├── mission-control.component.ts   # v2.0→v4.0→v6.0: 结构化锚点 + 模糊缩略图全景面板
│   │   └── slice-anchor-card.component.ts # v4.0→v6.0: 左侧缩略图 + 右侧结构化锚点切片卡片
│   ├── correction-toast/
│   │   ├── correction-toast.component.ts  # v3.0→v4.0→v6.0: 推断纠错浮层（三通道消散）+ 持久入口
│   │   └── correction-panel.component.ts  # v3.0: 纠错展开面板
│   ├── archival-notification/
│   │   └── archival-notification.component.ts # 【v6.0】透明归档微提示（1.5s + [撤回]）
│   ├── metronome/
│   │   ├── metronome-indicator.component.ts # 状态指示（静态图标）
│   │   ├── alert-bubble.component.ts      # 半透明提示气泡
│   │   └── status-bar-alert.component.ts  # 底部状态栏提醒
│   └── mobile/
│       ├── overlap-fab.component.ts       # 移动端浮动按钮
│       └── incubator-drawer.component.ts  # 移动端抽屉（含 Mission Control 结构化锚点 + 缩略图）
├── services/
│   ├── intent-dismissal.service.ts        # v4.0→v6.0: 三通道消散管理（内容交互 + 手动关闭 + idle 淡出）
│   ├── user-activity.service.ts           # v2.0→v6.0: 二元 idle/active 检测 + 多屏自动适配
│   └── context-warm-up.service.ts         # v2.0→v6.0: 三级预热 + Memory Aid Panel + 三通道消散
```

> **v2.0 移除**：`overlap-meta-editor/`（属性编辑面板）——Zero-Config 设计下不再需要独立的配置 UI。
> 属性查看/微调功能内嵌在 `incubator-card` 的 hover 详情中。
> **v3.0 新增**：`correction-toast/`（推断纠错浮层）、`slice-signature-card`（语义签名切片卡片）、
> `context-warmup-bar`（gentle 级别预热条）、`edit-line-flash`（instant 级别闪烁指令）
> **v4.0 变更**：`slice-signature-card` → `slice-anchor-card`（结构化锚点替代语义签名）；
> 新增 `companion-mode/`（伴随模式组件）、`intent-dismissal.service.ts`（Intent 消散管理）；
> `correction-toast` 和 `context-warmup-bar` 改为 Intent-based 消散（集成 IntentDismissalService）
> **v5.0 变更**：Intent 消散信号从 `keydown/mousedown` 净化为 `input/compositionstart/scroll/selectionchange`；
> `extractStructuralAnchor()` 增加 Proximity Fallback 逻辑；
> `FocusPodService` 增加 Silent Hibernation 自动冷冻逻辑（超限时平移最久闲置切片到孵化器）
> **v6.0 变更**：`context-warmup-overlay.component.ts` → `memory-aid-panel.component.ts`（全屏遮罩 → 右侧侧栏）；
> `companion-mode/` 目录移除（用户面向概念废弃，多屏检测内化到 `user-activity.service.ts`）；
> 新增 `archival-notification/`（透明归档微提示组件）；
> `incubator-card` 新增 ✏️ 持久纠错入口；`slice-anchor-card` 新增 60×80px 模糊缩略图；
> `intent-dismissal.service.ts` 扩展三通道消散（Esc / 空白点击 / 10s idle 自动淡出）

## 附录 C：与现有 Focus Mode 的迁移兼容

| 现有 Signal / Store | 迁移策略 |
|---------------------|---------|
| `spotlightTask` | 保留，`focusPodTaskId` 新增并行存在；Phase 3 后可考虑统一 |
| `spotlightMode` | 保留，`overlapMode` 新增；两者互斥激活 |
| `spotlightQueue` | 保留，Overlap 模式下不使用队列（改用 Incubator） |
| `gateState` | 不变，Gate 阶段完成后可进入 Overlap 或 Spotlight |
| `strataLayers` | 不变，`hatched` 任务完成后自然沉积 |
| `focusPreferences` | 扩展新增 overlap 子配置 |

**互斥规则**：`spotlightMode` 和 `overlapMode` 不能同时为 `true`。用户在设置中选择偏好的聚焦模式，或在入口处选择本次使用哪种。

## 附录 D：v1.0 → v7.0 变更摘要

### v7.0 对比总览

| 维度 | v6.0（历史） | v7.0（当前） | 变更理由 |
|------|-------------|-------------|---------|
| 任务状态 | 7 种（active/incubating/hibernated/hatched 等） | 2 种（active/parked） | 用户心智模型只有"当前做的"和"待会儿回来" |
| 服务数 | 8 个（IncubatorService/MetronomeService/FocusPodService 等） | 3 个（ParkingService/ContextRestoreService/SimpleReminderService） | 减少 60% 复杂度 |
| 组件数 | ~20 个 | ~5 个 | 聚焦核心交互 |
| 配置常量 | ~40 个 | ~8 个 | 去掉所有删除子系统的配置 |
| 验收用例 | 51 项（F-01 ~ F-51） | 15 项（P-01 ~ P-15） | 匹配简化后的功能范围 |
| 实施周期 | 4 阶段 / 6 周 | 2 阶段 / 2 周 + MVP 门禁 | 先验证再建设 |
| 入口方式 | "送入孵化器"仪式 | 切换任务时自动停泊 | 零心智负担 |
| 上下文恢复 | 三级预热（instant/gentle/full）+ 截图 + Memory Aid Panel | 统一闪烁最后编辑行 | 简单到不需要学习 |
| 提醒系统 | Metronome 节拍器 + Focus Suppression + 4 级升级 | `setTimeout` + 浏览器 Notification | 够用就好 |
| 截图 | html2canvas 模糊缩略图 | 删除 | ROI 极低 |
| 关键字推断 | OverlapAttributionService + Correction Toast | 删除 | NLP 在小文本上不可靠 |
| 多屏检测 | blur/focus 频率分析 + 自动适配 | 仅 `visibilityState === 'hidden'` | 唯一可靠信号 |

### v1.0 → v6.0 历史变更摘要

| 维度 | v1.0 | v2.0 | v3.0 | v4.0 | v5.0 | v6.0 | 解决的问题 |
|------|------|------|------|------|------|------|-----------|
| 入口 | 需手动配置 4 项属性 | Zero-Config 一键送入 | Zero-Config + Correction Toast 即时纠错 | **Toast Intent-based 消散**（驻留至用户首个实质性动作） | **Toast 信号净化**（剔除 mousedown/keydown 盲点动作） | **Toast 三通道消散** + 持久 ✏️ 纠错入口（3 分钟） | 配置项过载 → 推断不可纠错 → 3 秒倒计时焦虑 → 盲点击 → Toast 窗口期太短 |
| 快照恢复 | 直接恢复光标位置 | Context Warm-up 遮罩（轨迹+截图） | 三级记忆衰减响应（instant/gentle/full） | **gentle Intent-driven 消散** | **gentle 信号净化** + **Proximity Fallback** | **gentle 三通道消散**（Esc/空白/10s 淡出）+ **full → Memory Aid Panel 侧栏**（非全屏遮罩） | 脑快照 ≠ 机器快照 → 一刀切 → gentle 2 秒太快 → 盲点击 → "UI 粘手" + 全屏遮罩"爹味" |
| 侧边栏卡片 | 进度条动画 + 呼吸灯 | 静态图标，hover 才展细节 | 不变 | 不变 | 不变 | 不变 | 注意力劫持 |
| 提醒升级 | 墙上时间计时 3 级 | idle 时间计时 4 级（含 suppressed） | 多维活跃度检测（三层推断模型） | 不变 | 不变 | 不变 | 注意力劫持 → 深度阅读被误判为 idle |
| idle 判定 | 无 | 30 秒无键鼠 = idle | 微操作信号 + 认知上下文 + 离席置信度 | **Companion Mode**（多屏：blur 权重 0%） | 不变 | **二元 idle/active**（简化三层推断）+ **多屏自动检测**（废弃 Companion Mode 用户概念） | 单一信号精度不足 → 多屏 blur 误判 → 过度工程 → 概念负担 |
| 任务栈 | PauseStack（LIFO，硬限 3） | Suspended Slices（扁平，自由跳，软限 5） | 不变 | 不变 | **Silent Hibernation**（超限时静默冷冻，不弹窗） | **Transparent Archival**（冷冻时 1.5s 微提示 + [撤回]） | 暂存栈死锁 → 弹窗打断 → 任务失踪恐慌 |
| 导航 | 固定入栈/出栈顺序 | Mission Control 全景面板自由导航 | 语义签名卡片替代模糊截图 | **结构化锚点**替代 NLP 语义签名 | **Proximity Fallback** | **模糊缩略图**（60×80px）+ 结构化锚点文字双信息源 | 暂存栈死锁 → 截图区分度低 → NLP 幻觉 → 纯文字扫描慢 |
| 推断纠错 | 无 | hover 二层菜单修改 | 3 秒 Correction Toast | **Intent-based Toast** | **信号净化 Toast** | **三通道消散 Toast** + 孵化器卡片 ✏️ 持久入口（3 分钟） | 推断错误无法快速修正 → 3 秒焦虑 → 盲点击误消散 → 窗口期太短 |
| 消散范式 | — | 无独立机制 | 定时器驱动（setTimeout） | **IntentDismissalService**（Event-driven） | **Content Interaction 信号** | **三通道消散**（内容交互 + Esc/空白手动 + 10s idle 淡出） | — → 定时器焦虑 → mousedown 假阳性 → "UI 粘手" |
| 多屏支持 | 无 | 无 | blur > 10s = 90% 置信度 | **Companion Mode**（blur 权重 0%） | 不变 | **自动检测**（废弃用户面向概念，系统内部适配） | — → 多屏 blur 致命误判 → 概念认知负担 |
| 切片超限 | — | "超出提示" | 不变 | 不变 | **Silent Hibernation**（自动冷冻） | **Transparent Archival**（冷冻 + 1.5s 微提示 + [撤回]） | — → 弹窗打断超载用户 → 任务失踪恐慌 |
| 用户概念数 | 少 | 中（Focus Pod/Incubator/Suspended Slices） | 多（Memory Decay/Absence Confidence/Three-Layer） | 更多（Companion Mode/Gaze Surrogate/Intent Dismissal） | 不变 | **精简**（用户面向：当前任务/后台任务/暂停的任务/已归档；内部术语不外露） | 概念过载 → 用户失去掌控感 |

---

*End of Document*

</details>
