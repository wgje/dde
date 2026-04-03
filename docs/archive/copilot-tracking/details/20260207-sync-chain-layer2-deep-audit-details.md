<!-- markdownlint-disable-file -->

# Task Details: NanoFlow 同步链路二层深度审计执行方案（Durability-First Sync Core）

## Research Reference

- `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md`
- `docs/sync-chain-layer2-deep-audit-2026-02-07.md`

## Scope and Design Guardrails

- 必须满足离线优先与不丢写目标，禁止以“容量淘汰”换取可用性。
- 必须把同步成功语义改为“远端已确认”，禁止“部分失败但整体成功”。
- 必须收敛同步链路单一真相源：单队列语义、单脏记录清理闭环、单 tombstone 入口。
- 必须满足项目硬规则：树遍历迭代化并受 `MAX_SUBTREE_DEPTH = 100` 保护。
- 必须把同步关键路径吞错改为分类可观测错误（离线/未配置/运行时异常）。

## Execution Status (2026-02-07)

- 全部 Phase（0~6）已按方案完成落地，任务勾选状态以 `.copilot-tracking/plans/20260207-sync-chain-layer2-deep-audit-plan.instructions.md` 为准。
- 问题 ID `SYNC-CROSS-001~012` 已形成“代码改动点 + 测试改动点 + 验证命令”闭环，详见 `.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md`。
- 关键链路回归通过：
  - `src/app/core/services/simple-sync.service.spec.ts`
  - `src/services/action-queue-storage.service.spec.ts`
  - `src/services/remote-change-handler.service.spec.ts`
- 全量基线门禁已复跑并归档：
  - `npm run test:run:services` 仍存在既有失败簇（`focus-preference` 注入 mock 问题 + `dompurify` 依赖缺失）。
  - `npm run lint` 仍存在仓库级历史 lint 负债（非本次审计新增）。
  - `npm run build` 仍被 `dompurify` 依赖缺失阻断。

## Phase 0: 基线冻结与变更治理

### Task 0.1: 建立问题 ID 到代码变更的追踪矩阵

将 `SYNC-CROSS-001~012`、`SYNC-P0-001~005`、`SYNC-P1-001~005` 映射到具体文件、函数、测试用例、验收项，形成单一治理基线，避免修复过程中遗漏或重复。

- **Files**:
  - `.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md` - 创建变更追踪总表（Added/Modified/Removed/Verification）。
  - `.copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md` - 固化问题到任务映射关系。
- **Success**:
  - 12 个问题均有唯一“代码改动点 + 测试改动点 + 验收命令”。
  - 任何提交可通过问题 ID 反查到受影响文件。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 90-101, 203-217)
- **Dependencies**:
  - 无

### Task 0.2: 固化运行时基线与回归门禁

将当前失败基线（services test/lint/build）记录为“改造前状态”，并建立每阶段最小回归集，确保同步修复不扩大已有风险面。

- **Files**:
  - `.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md` - 记录基线执行结果与时间戳。
  - `tests/integration/` - 新增同步链路集成测试用例文件（按阶段增量补齐）。
- **Success**:
  - 基线含 `npm run test:run:services`、`npm run lint`、`npm run build` 三项结果与失败簇分类。
  - 每个 Phase 结束后至少运行 1 组同步关键回归测试并记录结果。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 103-109)
- **Dependencies**:
  - Task 0.1

### Task 0.3: 设计灰度开关与回滚策略

引入 Durability-First 配置开关，确保“高风险语义变更”可分阶段启用与快速回滚，不影响线上可控性。

- **Files**:
  - `src/config/sync.config.ts` - 新增 durability/cursor/queue pressure 配置项。
  - `src/config/feature-flags.config.ts` - 增加同步链路灰度开关映射。
- **Success**:
  - 每个核心改动（成功语义、队列策略、Delta 游标、Realtime 路由）均有独立 flag。
  - 支持按项目/按用户分批打开并可一键回退到旧行为。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 174-181, 193-201)
- **Dependencies**:
  - Task 0.1

## Phase 1: 成功语义闭合与下载合并安全化

### Task 1.1: 重构 BatchSyncService 的整体成功判定

将批量同步结果改为结构化聚合（project/task/connection 分项结果 + 重试入队结果），禁止固定 `success: true`。

- **Files**:
  - `src/app/core/services/sync/batch-sync.service.ts` - 改为严格成功判定与失败明细返回。
  - `src/app/core/services/simple-sync.service.ts` - 适配新的批量结果协议。
  - `src/utils/result.ts` - 如需扩展 Result 类型，保持兼容 existing API。
- **Success**:
  - 任一 task/connection push 失败时，整体结果必须 `success: false`。
  - 返回体包含 `failedTaskIds/failedConnectionIds/retryEnqueued`。
  - UI 状态与日志不再出现“部分失败但展示成功”。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 11-13, 90-93, 113-151, 206-207)
- **Dependencies**:
  - Task 0.3

### Task 1.2: 统一同步成功状态上浮与用户提示语义

将 `SyncCoordinatorService`、`SimpleSyncService`、`SyncStatus` 的成功判定口径统一为“远端确认成功”；失败必须携带可追踪原因并触发对应级别提示。

- **Files**:
  - `src/services/sync-coordinator.service.ts` - 消费严格结果并设置状态。
  - `src/app/core/services/simple-sync.service.ts` - 同步状态流转与回调出参统一。
  - `src/shared/components/sync-status.component.ts` - 状态文案/颜色与错误态适配。
- **Success**:
  - 不再存在“状态成功但 RetryQueue 仍有失败项”。
  - 错误提示区分“可重试失败”和“配置/权限失败”。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 84-85, 185-189, 220-223)
- **Dependencies**:
  - Task 1.1

### Task 1.3: 修复 downloadAndMerge 覆盖本地全集问题

下载合并改为“三路集合并”：`remote` + `local-synced` + `local-only`。对 local-only 项目保留并打上 pending sync 标记，不允许被下载覆盖删除。

- **Files**:
  - `src/services/sync-coordinator.service.ts` - 重写下载合并算法与冲突分支。
  - `src/services/project-state.service.ts` - 增补本地项目来源标记（local-only/synced）。
  - `src/models/index.ts` 或相关 view-state 类型 - 如需新增元数据字段。
- **Success**:
  - 执行 `download`/`both` 同步后，本地未上云项目 100% 保留。
  - 冲突项目进入显式策略分支（LWW + 字段保护），无静默覆盖。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 13-15, 48-50, 91-93, 207-208)
- **Dependencies**:
  - Task 1.2

### Task 1.4: 修复 finally 无条件清理 hasPendingLocalChanges

移除 `finally` 中“固定清空待同步标记”逻辑，改为仅在远端写入确认成功后清理；失败保留脏标记并进入可重试链路。

- **Files**:
  - `src/services/sync-coordinator.service.ts` - 调整 pending 标记清理时机。
  - `src/services/change-tracker.service.ts` - 与项目级清理闭环联动。
- **Success**:
  - 云端失败后，`hasPendingLocalChanges` 必须保持 `true`。
  - 成功路径清理与 ChangeTracker 清理保持原子一致。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 14-15, 95-96, 210-212)
- **Dependencies**:
  - Task 1.2

## Phase 2: 队列耐久优先与单队列语义收敛

### Task 2.1: 停用 RetryQueue 的默认淘汰策略

移除 `MAX_SIZE` 满队列 `shift()` 与 `shrinkQueue()` 删半策略；改为“拒绝新入队 + 强告警 + 引导释放空间”，保证历史写操作不被主动删除。

- **Files**:
  - `src/app/core/services/sync/retry-queue.service.ts` - 去除主动淘汰，改为 pressure mode。
  - `src/config/sync.config.ts` - 增加 DROP_POLICY 与压力策略配置。
  - `src/services/toast.service.ts` - 增加存储压力提示文案。
- **Success**:
  - 队列压力下不再执行任何“删除旧操作”逻辑。
  - 所有被拒绝的新操作有明确 UI 提示与日志记录。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 15-17, 50-52, 92-93, 175-179, 208-209)
- **Dependencies**:
  - Task 0.3

### Task 2.2: 停用 ActionQueueStorage 的 quota 清理行为

把配额不足时“保留最新 50%”替换为“冻结队列写入 + 可观测错误 + 用户恢复路径”，与 RetryQueue 保持一致的耐久语义。

- **Files**:
  - `src/services/action-queue-storage.service.ts` - 移除 `slice(-50%)` 语义。
  - `src/services/action-queue.service.ts` - 配额异常的上抛/分类处理。
  - `src/services/network-awareness.service.ts` - 离线/低网状态联动提示。
- **Success**:
  - 配额错误不再导致历史操作被删除。
  - queue freeze 状态在 UI 与日志中可见。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 19-21, 50-52, 66-67, 92-93)
- **Dependencies**:
  - Task 2.1

### Task 2.3: 收敛 ActionQueue 与 RetryQueue 为单一真相源

定义唯一“写操作待同步队列”协议，明确优先级、去重、重试、死信规则，避免双队列并存造成状态口径分叉。

- **Files**:
  - `src/services/sync-coordinator.service.ts` - 只依赖统一队列接口。
  - `src/services/action-queue.service.ts` - 作为统一队列或被降级为适配层。
  - `src/app/core/services/sync/retry-queue.service.ts` - 与统一协议合并或保留单一实现。
  - `src/services/action-queue-processors.service.ts` - 统一处理器注册策略。
- **Success**:
  - 同步状态统计仅来自一个队列源。
  - 不再出现同一实体在两队列重复排队或去重规则冲突。
  - 文档与代码均明确“唯一队列入口”。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 17-21, 81-85, 100-101, 187-188, 198-199)
- **Dependencies**:
  - Task 2.1
  - Task 2.2

### Task 2.4: 定义队列耐久不变量与故障注入测试

为“崩溃重启、断网重连、配额不足、跨 tab 并发”场景建立队列不变量测试，验证“不丢写 + 可恢复 + 可重放”。

- **Files**:
  - `src/app/core/services/sync/retry-queue.service.spec.ts`
  - `src/services/action-queue.service.spec.ts`
  - `tests/integration/sync-integrity.spec.ts`（新增或扩展）
- **Success**:
  - 至少覆盖 4 类压力场景且断言写操作不丢失。
  - 重启后队列可恢复并继续处理。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 66-67, 92-93, 185-187, 221-223)
- **Dependencies**:
  - Task 2.3

## Phase 3: 脏记录清理闭环与错误可观测化

### Task 3.1: 补齐 ChangeTracker 项目级成功清理闭环

在“远端确认成功”后调用 `clearProjectChanges()` 清理 `tasksToUpdate/connectionsToUpdate`，禁止长期脏标记影响后续 merge。

- **Files**:
  - `src/services/change-tracker.service.ts` - 暴露可审计的项目级清理 API 与统计。
  - `src/services/remote-change-handler.service.ts` - 清理后再进入下一轮 merge。
  - `src/services/sync-coordinator.service.ts` - 成功路径触发项目级清理。
- **Success**:
  - `clearProjectChanges()` 在生产路径中有明确调用点。
  - 同步成功后，项目脏记录计数下降到 0（或仅保留新变更）。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 21-25, 42-44, 93-95, 209-211)
- **Dependencies**:
  - Task 1.4

### Task 3.2: 约束 RemoteChangeHandler 的字段保护窗口

在合并流程中保留 `content` 保护策略，但要求脏标记“只在有效窗口内生效”；清理完成后必须允许远端合法更新进入本地。

- **Files**:
  - `src/services/remote-change-handler.service.ts` - 字段保护策略增加生命周期控制。
  - `src/services/change-tracker.service.ts` - 增加变更时间戳/版本信息支持过期判断。
- **Success**:
  - 避免“长期偏向本地”导致的慢性一致性偏移。
  - 仍满足“同步查询必须包含 content 字段”项目陷阱规避。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 23-25, 43-44, 156-159, 188-189)
- **Dependencies**:
  - Task 3.1

### Task 3.3: 改造 getSupabaseClient 吞错为分类错误

替换同步主链路中的 `catch { return null }`，建立统一错误分类：`offline`、`not_configured`、`runtime_failure`，并注入日志与 Sentry 标签。

- **Files**:
  - `src/app/core/services/simple-sync.service.ts`
  - `src/app/core/services/sync/task-sync-operations.service.ts`
  - `src/app/core/services/sync/project-data.service.ts`
  - `src/app/core/services/sync/connection-sync-operations.service.ts`
  - `src/app/core/services/sync/batch-sync.service.ts`
  - `src/app/core/services/sync/realtime-polling.service.ts`
  - `src/utils/supabase-error.ts`（扩展错误映射）
- **Success**:
  - 同步关键路径不再出现裸 `return null` 吞错。
  - 日志中可区分离线降级与真实异常。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 46-48, 100-101, 189-190)
- **Dependencies**:
  - Task 0.2

### Task 3.4: 建立同步可观测指标与告警分级

围绕“成功口径、队列压力、脏标记年龄、游标延迟”建立指标，并按 SILENT/NOTIFY/RECOVERABLE/FATAL 进行分级处理。

- **Files**:
  - `src/services/global-error-handler.service.ts` - 同步错误分级接入。
  - `src/services/sentry-alert.service.ts` - 同步告警分类与聚合。
  - `src/shared/components/toast-container.component.ts` - 用户可感知告警。
- **Success**:
  - 关键指标可视：`sync_success_rate`、`queue_pressure_events`、`dirty_age_ms`、`cursor_lag_ms`。
  - 同类错误不会重复刷屏，支持采样与聚合。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 72-74, 84-85, 220-223)
- **Dependencies**:
  - Task 3.3

## Phase 4: Realtime 与 Delta 链路收敛

### Task 4.1: 决策并落地 task-level 回调模型（接通或删除）

对 `taskChangeCallback` 分支做单向决策：
- 方案 A：完整接通 task/connection 级处理链路；
- 方案 B：删除死分支，统一走项目级增量处理。
禁止继续保持半接线状态。

- **Files**:
  - `src/app/core/services/simple-sync.service.ts` - 回调注册与派发统一。
  - `src/app/core/services/sync/realtime-polling.service.ts` - 事件到回调的路由一致化。
  - `src/services/remote-change-handler.service.ts` - 与回调契约对齐。
- **Success**:
  - 全局仅存在一种清晰事件路由策略。
  - 相关代码搜索不再出现“仅赋值未调用”的死路径。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 26-29, 44-46, 94-95, 200-201, 213-214)
- **Dependencies**:
  - Task 1.2

### Task 4.2: 修复 Realtime 重订阅上下文与 DELETE 事件处理边界

切换 Realtime 配置时必须传递真实 `userId`。同时对 `DELETE` 事件采用“触发增量拉取 + tombstone 校验”模式，不直接信任 payload 过滤。

- **Files**:
  - `src/app/core/services/sync/realtime-polling.service.ts` - 订阅上下文修复。
  - `src/app/core/services/sync/project-data.service.ts` - 事件触发增量拉取入口。
  - `src/app/core/services/sync/tombstone.service.ts` - DELETE 事件后防复活校验。
- **Success**:
  - Realtime 重订阅全路径无空 `userId`。
  - DELETE 事件不会因过滤限制导致误判或漏处理。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 27-29, 57-60, 96-97, 157-158)
- **Dependencies**:
  - Task 4.1

### Task 4.3: Delta 路径统一字段映射与服务端游标推进

Delta 同步禁止直接 cast snake_case 行为；统一走 `rowToTask/rowToConnection` 映射。游标推进使用“本次响应中 `max(updated_at)`”而非客户端 `nowISO()`。

- **Files**:
  - `src/app/core/services/simple-sync.service.ts` - Delta 数据映射与游标更新。
  - `src/services/delta-sync-coordinator.service.ts` - 时间比较字段统一。
  - `src/models/supabase-types.ts` - row 类型对齐与辅助类型扩展。
- **Success**:
  - Delta 启用时不再出现 snake_case/camelCase 错配。
  - 游标单调推进且无“边界漏数”回归。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 35-37, 61-64, 97-99, 156-159, 199-200, 214-215)
- **Dependencies**:
  - Task 4.2

### Task 4.4: 加入时钟漂移与幂等补偿机制

在 Delta/Realtme 交汇处加入“安全回看窗口”与幂等去重策略，抵御 Read Committed 快照边界与客户端时钟漂移。

- **Files**:
  - `src/services/clock-sync.service.ts` - 提供 drift 估计。
  - `src/app/core/services/simple-sync.service.ts` - 回看窗口与幂等去重。
  - `src/services/change-tracker.service.ts` - 幂等 key 支持。
- **Success**:
  - 在网络抖动场景下无新增漏同步记录。
  - 重复事件不会造成重复写入与状态抖动。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 61-63, 158-159, 179-180)
- **Dependencies**:
  - Task 4.3

## Phase 5: 算法硬规则与 Tombstone 单点化

### Task 5.1: 将拓扑排序递归改为迭代并加深度限制

把 `visit()` 递归 DFS 改为显式栈迭代算法，超出 `MAX_SUBTREE_DEPTH` 时进入可恢复错误分支并记录。

- **Files**:
  - `src/app/core/services/sync/task-sync-operations.service.ts` - 迭代拓扑排序实现。
  - `src/config/layout.config.ts` - 复用 `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH`。
- **Success**:
  - 代码中不再存在拓扑排序递归调用。
  - 深树场景不会触发 `Maximum call stack size exceeded`。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 29-31, 67-69, 98-99, 186-187, 215-216)
- **Dependencies**:
  - Task 3.3

### Task 5.2: 收敛 Tombstone 到 TombstoneService 单点实现

移除 `task-sync-operations` 与 `project-data` 私有 tombstone 缓存和持久化逻辑，统一委托 `TombstoneService`。

- **Files**:
  - `src/app/core/services/sync/task-sync-operations.service.ts` - 删除私有 tombstone 存储。
  - `src/app/core/services/sync/project-data.service.ts` - 删除私有 tombstone 存储。
  - `src/app/core/services/sync/tombstone.service.ts` - 作为唯一实现入口。
- **Success**:
  - 全仓仅一套 `LOCAL_TOMBSTONES_KEY` 和 tombstone 内存缓存。
  - 删除判定逻辑统一，不再出现多实现漂移。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 30-35, 99-100, 201-202, 216-217)
- **Dependencies**:
  - Task 4.2

### Task 5.3: 设计 Tombstone 生命周期与防复活不变量

为 tombstone 定义保留时长、清理策略、版本比较规则，确保“删除优先于旧更新”且不会因本地缓存清理造成复活。

- **Files**:
  - `src/app/core/services/sync/tombstone.service.ts` - 生命周期策略与比较函数。
  - `src/config/sync.config.ts` - tombstone retention 相关配置。
  - `tests/integration/sync-integrity.spec.ts` - 删除/恢复边界测试。
- **Success**:
  - 旧更新时间的 upsert 不会覆盖已删除实体。
  - tombstone 清理后仍可通过服务端状态防止误复活。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 157-159, 188-189, 201-202)
- **Dependencies**:
  - Task 5.2

### Task 5.4: 迁移历史本地 tombstone 存储键与数据

设计一次性本地迁移，将旧路径（多服务私有键）合并到统一键，支持幂等执行与失败回滚。

- **Files**:
  - `src/services/migration.service.ts` - tombstone local schema migration。
  - `src/app/core/state/persistence/indexeddb.service.ts` - 迁移事务支持。
  - `src/shared/modals/migration-modal.component.ts` - 迁移失败恢复提示。
- **Success**:
  - 迁移可重复执行且不重复写入。
  - 迁移失败不会破坏旧数据读取能力。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 33-35, 99-100, 216-217)
- **Dependencies**:
  - Task 5.2

## Phase 6: 验证矩阵、灰度发布与最终验收

### Task 6.1: 构建问题 ID 对应的测试矩阵

为每个问题 ID 至少新增 1 条可自动化验证用例，覆盖单元、集成、E2E 的最小闭环。

- **Files**:
  - `src/app/core/services/sync/*.spec.ts` - 同步核心单测。
  - `src/services/*.spec.ts` - 协调层与队列单测。
  - `tests/integration/sync-integrity.spec.ts` - 跨服务集成。
  - `e2e/sync-integrity.spec.ts`（若存在）- 关键路径端到端校验。
- **Success**:
  - 12 个问题 ID 均可通过自动化用例回归验证。
  - 用例命名可直接追溯问题 ID。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 90-101, 220-223)
- **Dependencies**:
  - Task 1.1
  - Task 2.3
  - Task 3.1
  - Task 4.3
  - Task 5.2

### Task 6.2: 增加容量/断网/时钟偏移故障注入验证

对存储配额、长离线、网络抖动、时间漂移进行脚本化注入，验证“队列不丢写、游标不漏数、删除不复活”。

- **Files**:
  - `tests/integration/local-mode-performance.spec.ts` - 压力与配额场景扩展。
  - `tests/integration/sync-integrity.spec.ts` - 时钟偏移与重复事件扩展。
- **Success**:
  - 至少覆盖 4 类故障注入场景。
  - 核心不变量全部通过（不丢写/不漏数/不复活）。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 62-67, 185-190)
- **Dependencies**:
  - Task 6.1

### Task 6.3: 制定灰度发布计划与回退手册

按 `internal -> beta -> 全量` 三阶段灰度开启同步新语义，设定可观测阈值与自动回退条件。

- **Files**:
  - `.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md` - 发布计划与回滚记录。
  - `src/config/feature-flags.config.ts` - 灰度分组策略。
  - `docs/sync-chain-layer2-deep-audit-2026-02-07.md` - 记录发布策略与风险控制。
- **Success**:
  - 每阶段均有开始/停止条件、指标阈值、回滚触发器。
  - 出现高优先级回归可在 1 个发布窗口内回退。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 193-201, 220-223)
- **Dependencies**:
  - Task 0.3
  - Task 3.4

### Task 6.4: 完成最终验收与文档收敛

输出“功能验收 + 数据安全验收 + 性能验收 + 可观测验收”四类报告，确保同步链路达到可发布标准。

- **Files**:
  - `.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md` - 最终验收结论。
  - `.copilot-tracking/plans/20260207-sync-chain-layer2-deep-audit-plan.instructions.md` - 勾选完成状态。
  - `.copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md` - 补充偏差与决策记录。
- **Success**:
  - 同步失败不再误报成功。
  - 本地项目下载后不丢失。
  - 队列在压力下不主动丢弃关键写。
  - ChangeTracker 清理闭环可验证。
  - Delta 字段映射与游标推进稳定。
  - 递归改造与 tombstone 单点化完成。
- **Research References**:
  - `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` (Lines 185-190, 205-217, 220-223)
- **Dependencies**:
  - Task 6.1
  - Task 6.2
  - Task 6.3

## Dependencies (Global)

- Angular 19.2.x + Signals + OnPush
- Supabase 2.84+（Postgres Changes / RLS）
- Vitest 4.x + Playwright 1.48+
- `src/utils/result.ts` 与 `src/utils/supabase-error.ts`
- `AGENTS.md` 硬规则（离线优先、LWW、迭代遍历、禁止主动丢写）

## Definition of Done

- 12 个问题 ID 全部关闭并有自动化验证。
- 同步主链路不再存在“误报成功、主动丢写、删除复活、长期脏偏置”。
- Realtime/Delta/Queue/Tombstone 四条子链路语义一致且可观测。
- 关键配置有灰度开关与回滚路径。
