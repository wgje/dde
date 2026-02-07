<!-- markdownlint-disable-file -->

# Changes: sync-chain-layer2-deep-audit-2026-02-07

更新时间：2026-02-07 07:43:19 UTC
负责人：Codex

## 1) 总体结论

- `SYNC-CROSS-001 ~ SYNC-CROSS-012` 对应优化已完成落地（代码 + 测试 + 文档追踪）。
- 本次改造将同步核心收敛到 **Durability-First** 语义：
  - 同步成功口径=远端确认成功
  - 队列压力下拒绝新写，不主动删除历史写入
  - Delta/Realtime/脏记录/tombstone 语义一致化
- 全量基线门禁复跑后，仍存在仓库既有失败簇（`dompurify` 依赖缺失、`focus-preference` 测试注入问题、历史 lint 负债）。

## 2) 问题 ID 追踪矩阵

| 问题 ID | 状态 | 核心代码改动 | 测试/验证改动 | 验证结论 |
|---|---|---|---|---|
| SYNC-CROSS-001 | ✅ 完成 | `src/app/core/services/sync/batch-sync.service.ts`, `src/app/core/services/simple-sync.service.ts` | `src/app/core/services/simple-sync.service.spec.ts` | 批量同步改为严格成功判定，失败明细可追踪 |
| SYNC-CROSS-002 | ✅ 完成 | `src/services/sync-coordinator.service.ts`, `src/models/index.ts` | `npm run test:run:services -- src/services/remote-change-handler.service.spec.ts` | download merge 保留 local-only 项目并打 pending 标记 |
| SYNC-CROSS-003 | ✅ 完成 | `src/app/core/services/sync/retry-queue.service.ts`, `src/services/action-queue.service.ts`, `src/services/action-queue-storage.service.ts` | `src/services/action-queue-storage.service.spec.ts` | 队列压力下不再主动淘汰历史写入 |
| SYNC-CROSS-004 | ✅ 完成 | `src/services/change-tracker.service.ts`, `src/services/sync-coordinator.service.ts`, `src/services/remote-change-handler.service.ts` | `src/services/remote-change-handler.service.spec.ts` | 成功路径补齐项目级脏记录清理闭环 |
| SYNC-CROSS-005 | ✅ 完成 | `src/app/core/services/sync/realtime-polling.service.ts`, `src/app/core/services/simple-sync.service.ts` | `src/services/remote-change-handler.service.spec.ts` | task-level 回调链路已接通，不再“只赋值不调用” |
| SYNC-CROSS-006 | ✅ 完成 | `src/services/sync-coordinator.service.ts` | `npm run test:run:services -- src/app/core/services/simple-sync.service.spec.ts` | pending 标记仅在远端确认成功后清理 |
| SYNC-CROSS-007 | ✅ 完成 | `src/app/core/services/sync/realtime-polling.service.ts` | `src/services/remote-change-handler.service.spec.ts` | Realtime 重订阅保持真实 userId 上下文 |
| SYNC-CROSS-008 | ✅ 完成 | `src/app/core/services/simple-sync.service.ts`, `src/services/delta-sync-coordinator.service.ts`, `src/config/sync.config.ts` | `npm run test:run:services -- src/app/core/services/simple-sync.service.spec.ts` | Delta 统一 row 映射 + 服务端最大时间戳推进 |
| SYNC-CROSS-009 | ✅ 完成 | `src/app/core/services/sync/task-sync-operations.service.ts`, `src/config/layout.config.ts` | `npm run test:run:services -- src/app/core/services/simple-sync.service.spec.ts` | 拓扑排序改迭代并受深度限制保护 |
| SYNC-CROSS-010 | ✅ 完成 | `src/app/core/services/sync/tombstone.service.ts`, `src/app/core/services/sync/project-data.service.ts`, `src/app/core/services/sync/task-sync-operations.service.ts`, `src/services/migration.service.ts` | `npm run test:run:services -- src/app/core/services/simple-sync.service.spec.ts` | tombstone 本地实现收敛为单点入口 |
| SYNC-CROSS-011 | ✅ 完成 | `src/utils/supabase-error.ts` + 同步链路 6 个 `getSupabaseClient()` | `src/app/core/services/simple-sync.service.spec.ts` | 吞错改分类可观测（离线/未配置/运行时异常） |
| SYNC-CROSS-012 | ✅ 完成 | `src/services/sync-coordinator.service.ts`, `src/services/action-queue.service.ts`, `src/app/core/services/sync/retry-queue.service.ts`, `src/app/shared/components/sync-status.component.ts` | `src/services/action-queue-storage.service.spec.ts` | 双队列口径收敛到一致耐久策略与统一状态统计 |

## 3) 变更清单

### Added

- `.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md`（本文件）
- `src/config/sync.config.ts`：`SYNC_DURABILITY_CONFIG`、durability/cursor/tombstone 配置扩展
- `src/config/feature-flags.config.ts`：同步链路灰度开关
- `src/tests/integration/sync-integrity.spec.ts`：耐久不变量集成测试（队列不丢写/冻结拒绝新写/脏窗口过期）

### Modified（核心）

- 同步核心：
  - `src/app/core/services/simple-sync.service.ts`
  - `src/app/core/services/sync/batch-sync.service.ts`
  - `src/app/core/services/sync/task-sync-operations.service.ts`
  - `src/app/core/services/sync/connection-sync-operations.service.ts`
  - `src/app/core/services/sync/project-data.service.ts`
  - `src/app/core/services/sync/realtime-polling.service.ts`
  - `src/app/core/services/sync/retry-queue.service.ts`
  - `src/app/core/services/sync/tombstone.service.ts`
- 协调与队列：
  - `src/services/sync-coordinator.service.ts`
  - `src/services/action-queue.service.ts`
  - `src/services/action-queue-storage.service.ts`
  - `src/services/network-awareness.service.ts`
  - `src/services/change-tracker.service.ts`
  - `src/services/remote-change-handler.service.ts`
  - `src/services/delta-sync-coordinator.service.ts`
  - `src/services/migration.service.ts`
- 配置/模型/错误：
  - `src/config/index.ts`
  - `src/models/index.ts`
  - `src/utils/supabase-error.ts`
- 可观测与 UI：
  - `src/services/sentry-alert.service.ts`
  - `src/app/shared/components/sync-status.component.ts`
- 测试修复：
  - `src/app/core/services/simple-sync.service.spec.ts`
  - `src/services/action-queue-storage.service.spec.ts`
  - `src/services/action-queue.service.spec.ts`
  - `src/services/remote-change-handler.service.spec.ts`

### Removed（语义移除）

- 移除 RetryQueue 压力下 `shift()/shrinkQueue()` 主动淘汰策略。
- 移除 ActionQueueStorage 配额不足时“保留最新 50%”策略。
- 移除 task/project-data 内部私有 tombstone 存储实现（统一委托 TombstoneService）。

## 4) 验证记录

### 4.1 关键回归（通过）

- 命令：
  - `npm run test:run:services -- src/app/core/services/simple-sync.service.spec.ts src/services/action-queue-storage.service.spec.ts src/services/remote-change-handler.service.spec.ts`
  - `npm run test:run -- src/tests/integration/sync-integrity.spec.ts`
- 结果：
  - 3 files passed
  - 57 passed, 63 skipped
  - integration: 1 file passed, 3 passed

### 4.2 全量 services 回归（基线失败簇）

- 命令：`npm run test:run:services`
- 结果：
  - 37 files passed, 2 files failed
  - 599 passed, 13 failed, 63 skipped
- 失败簇：
  - `src/services/focus-preference.service.spec.ts`（`LoggerService.category` 注入 mock 既有问题）
  - `src/utils/markdown.security.spec.ts`（`dompurify` 依赖无法解析）

### 4.3 Lint（基线失败簇）

- 命令：`npm run lint`
- 结果：`73 problems (62 errors, 11 warnings)`
- 结论：历史 lint 负债仍在；本轮新增/改动文件已做定向 lint 收敛（通过 `npx eslint` 文件级验证）。

### 4.4 Build（基线失败簇）

- 命令：`npm run build`
- 结果：失败
- 原因：`Could not resolve "dompurify"`（`src/utils/markdown.ts`）

## 5) 灰度发布与回滚

- 灰度顺序：`internal -> beta -> all`
- 开关载体：`src/config/feature-flags.config.ts`
  - `SYNC_STRICT_SUCCESS_ENABLED`
  - `SYNC_DURABILITY_FIRST_ENABLED`
  - `SYNC_SERVER_CURSOR_ENABLED`
  - `SYNC_TASK_LEVEL_CALLBACK_ENABLED`
  - `SYNC_UNIFIED_QUEUE_SEMANTICS_ENABLED`
- 回滚策略：
  - 任一阶段若 `sync_success_rate` 下滑、`queue_pressure_events` 异常抬升、`cursor_lag_ms` 长时间恶化，立即关闭对应 flag 回退旧行为。

## 6) 结项判定

- 功能目标：✅ 达成（误报成功、丢写策略、下载覆盖、脏记录闭环、Delta/Realtime/Tombstone 关键问题已落地修复）。
- 质量门禁：⚠️ 全仓仍有既有基线失败簇（与本审计改动无直接耦合），已记录并可独立治理。
