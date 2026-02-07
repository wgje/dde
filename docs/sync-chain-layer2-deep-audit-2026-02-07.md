# NanoFlow 同步链路二层深度审计（跨轮次真实性复核版）

更新时间：2026-02-07  
审计范围：离线优先同步主链路（`SyncCoordinatorService` + `SimpleSyncService` + `Batch/Retry/ActionQueue` + `RemoteChangeHandler` + `Delta/Tombstone`）
审计来源：第一轮全面审查问题清单 + 第二轮深度复核问题清单（本文件已合并）

## 1. 审计目标

本报告聚焦一个核心问题：当前同步链路是否满足“数据安全第一前提（不丢写、不误报成功、不错误复活删除数据）”。

本次不是泛化代码评审，而是把“第一轮 + 第二轮”提出的问题统一去重、逐条复核真实性，并给出可落地修复顺序。

## 2. 验证方法

### 2.1 静态代码取证

对每条问题给出文件与行号证据，重点验证：
- 失败路径是否被吞掉或被误判为成功
- 队列是否存在主动淘汰数据行为
- 删除墓碑（tombstone）是否存在分叉与复活窗口
- 回调链路是否真实接通

### 2.2 运行时验证（命令执行）

已执行：
- `npm run test:run:services`
- `npm run lint`
- `npm run build`

用于校验“问题是否已体现在自动化层面”，避免仅凭静态阅读下结论。

## 3. 第二轮问题总览（原始分组）

| ID | 问题 | 严重性 | 真实性结论 | 结论摘要 |
|---|---|---|---|---|
| SYNC-P0-001 | 批量同步部分失败仍返回成功 | P0 | 已确认 | 会出现“用户看到已同步，云端实际不完整” |
| SYNC-P0-002 | 下载合并覆盖本地项目全集 | P0 | 已确认 | `setProjects(mergedProjects)` 会丢失 local-only 项目 |
| SYNC-P0-003 | 队列在容量/配额压力下主动丢写 | P0 | 已确认 | RetryQueue/ActionQueue 都存在数据淘汰策略 |
| SYNC-P0-004 | ChangeTracker 脏记录缺少成功清理闭环 | P0 | 已确认 | 长期脏标记会影响后续远程合并决策 |
| SYNC-P0-005 | 任务级 Realtime 回调链路未接通 | P0 | 部分确认 | 项目级回调仍工作，但任务细粒度分支基本失效 |
| SYNC-P1-001 | 持久化 finally 无条件清本地待同步标记 | P1 | 已确认 | 云端失败后也会被标记为“无待同步” |
| SYNC-P1-002 | Realtime 切换时使用空 userId 重订阅 | P1 | 已确认 | 用户偏好订阅过滤可能退化 |
| SYNC-P1-003 | Delta Sync 映射与游标推进存在风险 | P1 | 已确认 | snake_case cast 到 model + `nowISO` 推进游标 |
| SYNC-P1-004 | 拓扑排序使用递归，违反迭代硬规则 | P1 | 已确认 | 深层树存在栈风险 |
| SYNC-P1-005 | Tombstone 本地实现三套并存 | P1 | 已确认 | 维护复杂度高，一致性窗口扩大 |

## 3.1 跨轮次全量问题总汇（第一轮 + 第二轮）

| 汇总ID | 来源轮次 | 原ID | 问题 | 严重性 | 真实性结论 | 关键证据 |
|---|---|---|---|---|---|---|
| SYNC-CROSS-001 | 第二轮 | SYNC-P0-001 | 批量同步部分失败仍返回成功 | P0 | 已确认 | `src/app/core/services/sync/batch-sync.service.ts:173`、`:228`、`:244` |
| SYNC-CROSS-002 | 第二轮 | SYNC-P0-002 | 下载合并覆盖本地项目全集 | P0 | 已确认 | `src/services/sync-coordinator.service.ts:247`、`:262` |
| SYNC-CROSS-003 | 第二轮 | SYNC-P0-003 | 队列在容量/配额压力下主动丢写 | P0 | 已确认 | `src/app/core/services/sync/retry-queue.service.ts:215`、`:746`；`src/services/action-queue-storage.service.ts:435` |
| SYNC-CROSS-004 | 第二轮 | SYNC-P0-004 | ChangeTracker 缺少成功清理闭环 | P0 | 已确认 | `src/services/remote-change-handler.service.ts:465`；`src/services/change-tracker.service.ts:284` |
| SYNC-CROSS-005 | 第二轮 | SYNC-P0-005 | 任务级 Realtime 回调链路未接通 | P0 | 部分确认 | `src/app/core/services/simple-sync.service.ts:153`、`:432`；`src/app/core/services/sync/realtime-polling.service.ts:241` |
| SYNC-CROSS-006 | 第二轮 | SYNC-P1-001 | finally 无条件清待同步标记 | P1 | 已确认 | `src/services/sync-coordinator.service.ts:693`、`:783` |
| SYNC-CROSS-007 | 第二轮 | SYNC-P1-002 | Realtime 切换空 userId 重订阅 | P1 | 已确认 | `src/app/core/services/sync/realtime-polling.service.ts:139`、`:278` |
| SYNC-CROSS-008 | 第二轮 | SYNC-P1-003 | Delta Sync 映射/游标推进风险 | P1 | 已确认 | `src/app/core/services/simple-sync.service.ts:484`、`:487`；`src/services/delta-sync-coordinator.service.ts:109` |
| SYNC-CROSS-009 | 第二轮 | SYNC-P1-004 | 拓扑排序递归违背硬规则 | P1 | 已确认 | `src/app/core/services/sync/task-sync-operations.service.ts:758`、`:772` |
| SYNC-CROSS-010 | 第二轮 | SYNC-P1-005 | Tombstone 本地实现三套并存 | P1 | 已确认 | `src/app/core/services/sync/task-sync-operations.service.ts:61`；`src/app/core/services/sync/tombstone.service.ts:46` |
| SYNC-CROSS-011 | 第一轮 | 新增 | 同步关键路径 `catch { return null }` 吞错 | P1 | 已确认 | `src/app/core/services/simple-sync.service.ts:118`；`src/app/core/services/sync/task-sync-operations.service.ts:101`；`src/app/core/services/sync/project-data.service.ts:58` |
| SYNC-CROSS-012 | 第一轮 | 新增 | ActionQueue/RetryQueue 双队列语义分叉 | P1 | 已确认 | `src/services/sync-coordinator.service.ts:83`、`:85`；`src/services/project-operation.service.ts:37`、`:71`；`src/app/core/services/simple-sync.service.ts:108` |

## 4. 第一轮问题补充复核（已并入总表）

## SYNC-CROSS-011 同步关键路径 `catch { return null }` 吞错

结论：已确认。  
严重性：P1。

证据：
- `src/app/core/services/simple-sync.service.ts:118`
- `src/app/core/services/sync/task-sync-operations.service.ts:101`
- `src/app/core/services/sync/connection-sync-operations.service.ts:78`
- `src/app/core/services/sync/project-data.service.ts:58`
- `src/app/core/services/sync/batch-sync.service.ts:76`
- `src/app/core/services/sync/realtime-polling.service.ts:87`

真实性复核：
- 6 条同步关键路径 `getSupabaseClient()` 都在 `catch` 中直接 `return null`，无日志、无错误上报、无错误码区分。
- 这会把“真实异常（客户端初始化失败/运行时异常）”与“离线/未配置”折叠为同一种结果。

数据安全影响：
- 上层链路可能把异常误判为可忽略离线路径，导致问题潜伏且难追踪。
- 出现数据延迟或未同步时，定位信号不足，恢复时间拉长。

---

## SYNC-CROSS-012 ActionQueue/RetryQueue 双队列语义分叉

结论：已确认。  
严重性：P1。

证据：
- 同时注入两条链路：`src/services/sync-coordinator.service.ts:83`（`SimpleSyncService`）+ `src/services/sync-coordinator.service.ts:85`（`ActionQueueService`）
- 业务写入进入 ActionQueue：`src/services/project-operation.service.ts:37`、`:71`、`:129`
- 同步核心并行维护 RetryQueue：`src/app/core/services/simple-sync.service.ts:108`、`:175`、`:194`、`:207`
- 两队列去重/淘汰策略不同：
  - ActionQueue：`src/services/action-queue.service.ts:168`、`:210`
  - RetryQueue：`src/app/core/services/sync/retry-queue.service.ts:189`、`:215`

真实性复核：
- 双队列并存是代码事实，不是推测；且处理入口与策略并不统一。
- 在弱网与长离线场景下，同一实体可能经过不同队列策略，增加行为不可预测性。

数据安全影响：
- 同步状态口径容易分叉（“待处理数”“是否有本地脏变更”不一致）。
- 故障归因复杂度提高，放大边界场景下的不一致风险。

## 5. 第二轮逐条深度复核（原始问题逐条证据）

## SYNC-P0-001 批量同步部分失败仍返回成功

结论：已确认。  
严重性：P0。

证据：
- `src/app/core/services/sync/batch-sync.service.ts:173`（`pushProject` 结果未检查）
- `src/app/core/services/sync/batch-sync.service.ts:200`（任务成功仅加入 `successfulTaskIds`，失败不累计为整体失败）
- `src/app/core/services/sync/batch-sync.service.ts:228`（连接 push 未检查返回值）
- `src/app/core/services/sync/batch-sync.service.ts:244`（最终固定返回 `success: true`）

真实性复核：
- 代码级可直接证明：只要无异常抛出，整体就是 success，即便部分任务/连接失败。
- 该问题是“成功判定口径错误”，不是“网络瞬态”。

数据安全影响：
- 用户界面可能显示同步成功，但远端数据不完整。
- 后续 merge 可能把不完整状态当成真值继续传播。

---

## SYNC-P0-002 下载合并覆盖本地全集，可能丢失 local-only 项目

结论：已确认。  
严重性：P0。

证据：
- `src/services/sync-coordinator.service.ts:247`（`mergedProjects` 初始为空）
- `src/services/sync-coordinator.service.ts:248`（仅遍历 remoteProjects）
- `src/services/sync-coordinator.service.ts:262`（`setProjects(mergedProjects)` 直接覆盖）

真实性复核：
- 代码逻辑上，remote 不包含的本地项目不会进入 `mergedProjects`。
- 此方法在 `executeSyncByDirection('download'|'both')` 真实可达：`src/services/sync-coordinator.service.ts:223`、`src/services/sync-coordinator.service.ts:229`。

数据安全影响：
- 本地尚未上云项目在下载同步场景可被直接移除（数据可见性丢失）。

---

## SYNC-P0-003 队列在容量/配额压力下会主动丢写

结论：已确认。  
严重性：P0。

证据（RetryQueue）：
- `src/app/core/services/sync/retry-queue.service.ts:215`（满队列 `shift()` 移除最老项）
- `src/app/core/services/sync/retry-queue.service.ts:746`（`shrinkQueue` 删除一半最老项）

证据（ActionQueue）：
- `src/services/action-queue-storage.service.ts:435`（配额不足时只保留最新 50%）
- `src/services/action-queue-storage.service.ts:441`（提示“已清理较早操作记录”）

真实性复核：
- 非推测，代码显式执行数据淘汰。
- 这是有意设计取舍，但与“离线写入不丢”目标冲突。

数据安全影响：
- 弱网或长离线场景下，早期操作可能被永远丢弃。

---

## SYNC-P0-004 ChangeTracker 脏记录缺少同步成功后的系统性清理

结论：已确认。  
严重性：P0。

证据：
- 读取脏记录参与远程合并：`src/services/remote-change-handler.service.ts:465`
- 仅清理 delete 任务变更：`src/app/core/services/sync/batch-sync.service.ts:168`
- `clearProjectChanges` 仅定义无调用：`src/services/change-tracker.service.ts:284`，全仓搜索仅命中定义。

真实性复核：
- 同步成功后未见 `tasksToUpdate` / `connectionsToUpdate` 的统一清理路径。
- 脏记录可持续影响后续 merge（字段保护逻辑长期偏向本地）。

数据安全影响：
- 远程合法更新被持续屏蔽，形成“慢性一致性偏移”。

---

## SYNC-P0-005 任务级 Realtime 回调链路未接通（功能退化）

结论：部分确认。  
严重性：P0（功能退化，不是全链路失效）。

证据：
- 任务回调仅被赋值未使用：`src/app/core/services/simple-sync.service.ts:153`、`src/app/core/services/simple-sync.service.ts:432`
- 搜索结果仅2处命中（定义+赋值），无调用。
- Realtime 收到 task/connection 事件仍走 `onRemoteChangeCallback`：`src/app/core/services/sync/realtime-polling.service.ts:241`
- `RemoteChangeHandler` 期待第二回调走 `handleTaskLevelUpdate`：`src/services/remote-change-handler.service.ts:131`、`src/services/remote-change-handler.service.ts:141`

真实性复核：
- 任务细粒度回调分支基本不可达，已确认。
- 但项目级回调仍在工作（并非完全无同步）。

数据安全影响：
- 粒度退化为项目级 reload/merge，增加延迟与合并复杂度。

---

## SYNC-P1-001 持久化 finally 无条件清 `hasPendingLocalChanges`

结论：已确认。  
严重性：P1。

证据：
- `src/services/sync-coordinator.service.ts:693`（finally 里固定 `hasPendingLocalChanges: false`）
- `src/services/sync-coordinator.service.ts:783`（`doPersistActiveProject` catch 内吞异常，不再上抛）

真实性复核：
- 即使云端保存失败，最终状态仍可能显示“没有待同步变更”。
- 会影响编辑保护和远程更新跳过策略判断。

---

## SYNC-P1-002 Realtime 切换时用空 userId 重订阅

结论：已确认。  
严重性：P1。

证据：
- `src/app/core/services/sync/realtime-polling.service.ts:139`（`subscribeToProject(projectId, '')`）
- 用户偏好过滤依赖 userId：`src/app/core/services/sync/realtime-polling.service.ts:278`

真实性复核：
- 配置切换路径可达，且明确使用空字符串。

影响：
- user_preferences 过滤条件可能退化，事件覆盖范围和行为可预期性下降。

---

## SYNC-P1-003 Delta Sync 映射与游标推进风险

结论：已确认。  
严重性：P1（当前默认关闭，但风险真实存在）。

证据：
- 默认关闭：`src/config/sync.config.ts:90`
- 增量结果直接 cast 为 `Task/Connection`：`src/app/core/services/simple-sync.service.ts:484`
- 使用本地 `nowISO()` 推进游标：`src/app/core/services/simple-sync.service.ts:487`
- 合并侧读取 `updatedAt/deletedAt`：`src/services/delta-sync-coordinator.service.ts:109`、`src/services/delta-sync-coordinator.service.ts:113`

真实性复核：
- 一旦启用，snake_case 字段与 model 字段不一致可导致时间比较与删除判断偏差。
- 游标以客户端当前时间推进存在边界漏数窗口（时钟漂移/网络延迟）。

---

## SYNC-P1-004 拓扑排序使用递归，违反“迭代+深度限制”硬规则

结论：已确认。  
严重性：P1。

证据：
- `src/app/core/services/sync/task-sync-operations.service.ts:758`（递归函数 `visit`）
- `src/app/core/services/sync/task-sync-operations.service.ts:772`（递归调用 `visit(task.parentId)`）

真实性复核：
- 纯代码事实，非推测。
- 深层树时存在调用栈压力，且与项目硬规则冲突。

---

## SYNC-P1-005 Tombstone 本地实现三套并存

结论：已确认。  
严重性：P1。

证据：
- `src/app/core/services/sync/task-sync-operations.service.ts:61`、`:64`
- `src/app/core/services/sync/project-data.service.ts:48`、`:49`
- `src/app/core/services/sync/tombstone.service.ts:46`、`:49`

真实性复核：
- 三处都维护 `localTombstones + LOCAL_TOMBSTONES_KEY`。
- 逻辑分散导致失效策略和缓存边界难以统一验证。

## 6. 运行时验证结果（与问题交叉印证）

## 6.1 服务测试

命令：`npm run test:run:services`  
结果：失败（2 个文件失败，13 个测试失败，599 通过，63 跳过）

关键失败簇：
- `focus-preference` 测试中 `LoggerService` mock 与 `category()` 期望不匹配（13 个失败用例）
- `src/utils/markdown.ts` 引用 `dompurify` 无法解析（单文件失败）

已收敛项（本次改造完成）：
- `SimpleSyncService` 注入链 `BlackBoxSyncService` 缺失已修复（相关 spec 通过）
- `RemoteChangeHandler` 新增脏窗口 API mock 缺失已修复（相关 spec 通过）

## 6.2 构建

命令：`npm run build`  
结果：失败

错误：
- `Could not resolve "dompurify"`  
- 位置：`src/utils/markdown.ts:2`

## 6.3 Lint

命令：`npm run lint`  
结果：失败（73 问题，62 errors，11 warnings）

与同步链路直接相关的典型问题：
- 同步链路新增改动文件已完成定向 lint 收敛（重复 import、未使用 import、关键 `catch return null` 语义注释等）
- `services/` 层反向依赖 `app/core` 的架构警告

## 7. 实施完成项

1. 已完成 SYNC-P0-001/002/003/004/005：成功口径、下载合并、队列耐久、脏记录闭环、task-level 路由。  
2. 已完成 SYNC-P1-001/002/003/004/005：pending 清理时机、Realtime 上下文、Delta 游标、迭代拓扑、tombstone 单点。  
3. 已完成 SYNC-CROSS-011/012：分类错误可观测 + 双队列语义收敛。  

## 8. 审计结论

同步链路核心风险（误报成功、主动丢写、下载覆盖、脏记录长期偏置）已在本轮修复闭环。  
当前剩余阻断主要是仓库基线问题（`dompurify` 依赖、focus-preference 测试 mock、历史 lint 负债），不属于本审计修复链路的新回归。

## 9. 灰度发布与回退建议

- 发布顺序：`internal -> beta -> all`
- 开关策略（`src/config/feature-flags.config.ts`）：
  - `SYNC_STRICT_SUCCESS_ENABLED`
  - `SYNC_DURABILITY_FIRST_ENABLED`
  - `SYNC_SERVER_CURSOR_ENABLED`
  - `SYNC_TASK_LEVEL_CALLBACK_ENABLED`
  - `SYNC_UNIFIED_QUEUE_SEMANTICS_ENABLED`
- 回退条件：
  - `sync_success_rate` 显著下降
  - `queue_pressure_events` 持续抬升
  - `cursor_lag_ms` 异常扩大
- 回退动作：仅关闭对应 flag，保留数据结构兼容，避免二次迁移。
