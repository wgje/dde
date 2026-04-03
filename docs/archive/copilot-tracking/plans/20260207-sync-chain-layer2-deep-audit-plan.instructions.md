---
applyTo: ".copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: NanoFlow 同步链路二层深度审计执行方案

## Overview

基于 2026-02-07 同步链路深度审计研究，按 Durability-First Sync Core 方案分阶段落地修复 12 个已确认高风险问题，建立“成功语义真实、离线写入不丢、删除不复活、链路可观测”的同步系统。

## Objectives

- 修复批量同步“部分失败仍成功”口径，确保成功状态仅代表远端确认完成。
- 修复下载合并覆盖本地全集问题，保证 local-only 项目不丢失。
- 停用所有默认队列淘汰策略，确保配额/容量压力下不主动丢弃历史写操作。
- 补齐 ChangeTracker 成功清理闭环，消除长期脏标记导致的远程合并偏置。
- 收敛 Realtime/Delta/Tombstone/Queue 四条子链路到一致语义与单一真相源。
- 满足 AGENTS 硬规则（迭代遍历 + 深度限制 + 离线优先 + 不丢写）并完成可观测与灰度回滚设计。

## Research Summary

### Project Files

- `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md` - 本次任务的完整证据链、外部依据与推荐修复路径。
- `docs/sync-chain-layer2-deep-audit-2026-02-07.md` - 跨轮次问题真实性复核与优先级结论。
- `src/app/core/services/sync/batch-sync.service.ts` - 成功口径错误的核心位置。
- `src/services/sync-coordinator.service.ts` - 下载合并覆盖与 pending 标记语义问题核心位置。
- `src/app/core/services/sync/retry-queue.service.ts` - 队列主动淘汰策略核心位置。
- `src/services/action-queue-storage.service.ts` - 配额压力清理旧操作核心位置。
- `src/services/change-tracker.service.ts` - 项目级脏记录清理闭环缺失核心位置。
- `src/app/core/services/simple-sync.service.ts` - task 回调链、Delta cast 与游标推进风险核心位置。
- `src/app/core/services/sync/realtime-polling.service.ts` - Realtime 重订阅 userId 与事件路由核心位置。
- `src/app/core/services/sync/tombstone.service.ts` - tombstone 收敛目标服务。

### External References

- #githubRepo:"supabase/realtime-js postgres_changes channel pattern" - Realtime 事件订阅与路由模式基线。
- #fetch:https://supabase.com/docs/guides/realtime/postgres-changes - DELETE 事件过滤边界、RLS 与 payload 约束。
- #fetch:https://www.postgresql.org/docs/current/sql-altertable.html#SQL-CREATETABLE-REPLICA-IDENTITY - 复制标识对 old row 可见性的影响。
- #fetch:https://www.postgresql.org/docs/current/transaction-iso.html - Read Committed 快照语义与游标边界漏数风险依据。
- #fetch:https://supabase.com/docs/reference/javascript/db-modifiers-select - Supabase JS 写操作返回行为与 `.select()` 要求。
- #fetch:https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria - 浏览器配额行为与存储压力处理依据。
- #fetch:https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Too_much_recursion - 递归栈溢出风险依据。

### Standards References

- `AGENTS.md` - 离线优先、LWW、树遍历迭代+深度限制、禁止主动丢写、禁止 StoreService 回流。
- `.github/instructions/general.instructions.md` - 通用工程规范。
- `.github/instructions/angular.instructions.md` - Angular 19 + Signals + OnPush 约束。
- `.github/instructions/testing.instructions.md` - 测试分层与质量门禁。

## Implementation Checklist

### [x] Phase 0: 基线冻结与变更治理

- [x] Task 0.1: 建立问题 ID 到代码变更的追踪矩阵
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 20-33)

- [x] Task 0.2: 固化运行时基线与回归门禁
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 35-48)

- [x] Task 0.3: 设计灰度开关与回滚策略
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 50-63)

### [x] Phase 1: 成功语义闭合与下载合并安全化

- [x] Task 1.1: 重构 BatchSyncService 的整体成功判定
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 67-82)

- [x] Task 1.2: 统一同步成功状态上浮与用户提示语义
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 84-98)

- [x] Task 1.3: 修复 downloadAndMerge 覆盖本地全集问题
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 100-114)

- [x] Task 1.4: 修复 finally 无条件清理 hasPendingLocalChanges
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 116-129)

### [x] Phase 2: 队列耐久优先与单队列语义收敛

- [x] Task 2.1: 停用 RetryQueue 的默认淘汰策略
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 133-147)

- [x] Task 2.2: 停用 ActionQueueStorage 的 quota 清理行为
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 149-163)

- [x] Task 2.3: 收敛 ActionQueue 与 RetryQueue 为单一真相源
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 165-182)

- [x] Task 2.4: 定义队列耐久不变量与故障注入测试
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 184-198)

### [x] Phase 3: 脏记录清理闭环与错误可观测化

- [x] Task 3.1: 补齐 ChangeTracker 项目级成功清理闭环
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 202-216)

- [x] Task 3.2: 约束 RemoteChangeHandler 的字段保护窗口
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 218-231)

- [x] Task 3.3: 改造 getSupabaseClient 吞错为分类错误
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 233-251)

- [x] Task 3.4: 建立同步可观测指标与告警分级
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 253-267)

### [x] Phase 4: Realtime 与 Delta 链路收敛

- [x] Task 4.1: 决策并落地 task-level 回调模型（接通或删除）
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 271-288)

- [x] Task 4.2: 修复 Realtime 重订阅上下文与 DELETE 事件处理边界
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 290-304)

- [x] Task 4.3: Delta 路径统一字段映射与服务端游标推进
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 306-320)

- [x] Task 4.4: 加入时钟漂移与幂等补偿机制
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 322-336)

### [x] Phase 5: 算法硬规则与 Tombstone 单点化

- [x] Task 5.1: 将拓扑排序递归改为迭代并加深度限制
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 340-353)

- [x] Task 5.2: 收敛 Tombstone 到 TombstoneService 单点实现
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 355-369)

- [x] Task 5.3: 设计 Tombstone 生命周期与防复活不变量
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 371-385)

- [x] Task 5.4: 迁移历史本地 tombstone 存储键与数据
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 387-401)

### [x] Phase 6: 验证矩阵、灰度发布与最终验收

- [x] Task 6.1: 构建问题 ID 对应的测试矩阵
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 405-424)

- [x] Task 6.2: 增加容量/断网/时钟偏移故障注入验证
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 426-439)

- [x] Task 6.3: 制定灰度发布计划与回退手册
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 441-456)

- [x] Task 6.4: 完成最终验收与文档收敛
  - Details: .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md (Lines 458-478)

## Dependencies

- Angular 19.2.x（Signals + standalone + OnPush）
- Supabase 2.84+（Postgres Changes / RLS / Edge Functions）
- Vitest 4.x + Playwright 1.48+
- `src/utils/result.ts` 与 `src/utils/supabase-error.ts`
- `src/config/sync.config.ts`、`src/config/feature-flags.config.ts`
- `.copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md`

## Success Criteria

- 12 个问题 ID 均完成修复并有对应自动化回归测试。
- 同步失败路径不再返回成功状态，且失败原因可分类观测。
- 下载同步不会丢失 local-only 项目。
- 队列在容量/配额压力下不主动淘汰历史关键写操作。
- ChangeTracker 项目级清理闭环在生产路径可验证。
- Realtime 与 Delta 路径语义一致，游标推进无边界漏数。
- 拓扑排序已迭代化并受 `MAX_SUBTREE_DEPTH=100` 约束。
- Tombstone 本地实现收敛为单服务入口并通过防复活测试。

## Execution Notes (2026-02-07)

- 关键回归已通过：
  - `npm run test:run:services -- src/app/core/services/simple-sync.service.spec.ts src/services/action-queue-storage.service.spec.ts src/services/remote-change-handler.service.spec.ts`
  - `npm run test:run -- src/tests/integration/sync-integrity.spec.ts`
- 全量门禁已复跑并归档：
  - `npm run test:run:services` 失败簇：`focus-preference` 注入 mock、`dompurify` 依赖缺失。
  - `npm run lint`：`73 problems (62 errors, 11 warnings)`（历史负债）。
  - `npm run build`：`Could not resolve \"dompurify\"`（历史依赖缺失）。
- 变更总表：`.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md`。
