---
applyTo: ".copilot-tracking/changes/20260209-data-loss-ui-truthfulness-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: NanoFlow 数据丢失与 UI 真逻辑一致性治理

## Overview

修复 UI 占位逻辑、同步队列耐久性、离线状态可见性等数据丢失风险，并补充研究中发现的跨用户数据泄露、sessionStorage 残留等新风险。

## Objectives

- 消除所有"可点击但无业务动作"的 UI 摆件
- 同步队列在极端存储压力下不静默丢操作
- 用户可持续感知在线/离线/同步安全性状态
- 修复跨用户数据泄露安全漏洞（onUserLogout 未调用）
- 新增自动化测试覆盖本轮所有发现风险

## Research Summary

### Project Files

- `src/app/features/flow/components/flow-view.component.ts` — saveToCloud 占位逻辑（:422-425）
- `src/app/features/flow/components/flow-toolbar.component.ts` — isUploading 永久卡死（:337-341）
- `src/services/action-queue.service.ts` — 队列冻结内存兜底（:155-164）
- `src/services/action-queue-storage.service.ts` — 存储压力处理与逃生模式（:414-550）
- `src/app/core/services/sync/retry-queue.service.ts` — 绝对上限拒绝入队（:238-243, :984-992）
- `src/app/shared/components/offline-banner.component.ts` — toast-only 无 banner（:19-63）
- `src/app/shared/components/sync-status.component.ts` — 已有部分状态面板（:43-450）
- `src/services/optimistic-state.service.ts` — onUserLogout 未被调用（:257-259）
- `src/services/undo.service.ts` — onUserLogout 未被调用 + sessionStorage 残留（:585-603, :757）
- `src/services/attachment.service.ts` — onUserLogout 未被调用（:158）

### External References

- `docs/data-loss-and-ui-truthfulness-master-plan-2026-02-09.md` — 原始策划案（全部声明已验证）

### Standards References

- `AGENTS.md` — 核心规则：Result 模式、Signals 状态管理、Offline-first 架构
- `.github/instructions/general.instructions.md` — 代码规范：中文注释、函数 ≤50 行、嵌套 ≤4 层

## Implementation Checklist

### [ ] Phase 1: 快速止血 — UI 真逻辑 + 安全漏洞（M1: D1-D3）

- [ ] Task 1.1: 修复 `onUserLogout()` 调用缺失 — 消除跨用户数据泄露 [NEW-1, P0]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 12-33)

- [ ] Task 1.2: 修复 sessionStorage 撤销历史登出后残留 [NEW-2, P0]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 35-55)

- [ ] Task 1.3: 实装 `saveToCloud` 真实业务链路 [A1, P1]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 57-96)

- [ ] Task 1.4: 修复 flow-toolbar `上传中` 永久卡死状态 [A2, P1]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 98-149)

- [ ] Task 1.5: 统一离线提示语义 — offline-banner 行为治理 [C1, P1]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 151-187)

### [ ] Phase 2: 耐久加固 — 同步队列韧性提升（M2: D4-D8）

- [ ] Task 2.1: ActionQueue 冻结期落盘恢复与逃生导出 [B1, P1]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 191-237)

- [ ] Task 2.2: RetryQueue 上限前预警与降载 [B2, P1]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 239-286)

- [ ] Task 2.3: 撤销 version-mismatch 用户感知 [NEW-4, P2]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 288-315)

### [ ] Phase 3: 收敛与守护 — 可观测性 + 测试 + 门禁（M3: D9-D14）

- [ ] Task 3.1: 增加"数据安全状态面板"增强 [C2, P2]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 319-353)

- [ ] Task 3.2: 离线快照存储升级评估（localStorage → IDB）[B3, P2]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 355-384)

- [ ] Task 3.3: 首次离线加载通知 + Feature Flags 安全性校验 [NEW-7/NEW-8, P3]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 386-424)

- [ ] Task 3.4: 建立"摆件扫描"机制 [A3, P3]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 426-452)

- [ ] Task 3.5: 自动化测试覆盖与发布门禁 [D1+D2, P2]

  - Details: .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md (Lines 454-527)

## Dependencies

- Angular 19.x Signals + 独立组件 + OnPush
- Supabase 客户端 SDK（认证 + 同步）
- Vitest 4.0.x（单元测试）
- Playwright 1.48+（E2E 测试）
- IndexedDB（idb-keyval）

## Success Criteria

- `saveToCloud` 点击后存在真实网络请求，成功/失败/超时均有明确 UI 反馈
- `isUploading` 在任何路径下都能正确复位
- 用户登出后所有内存/sessionStorage 中的历史数据完全清理
- 队列冻结时用户可一键导出待同步数据，存储恢复后自动解冻
- RetryQueue 接近上限时有分层预警提示
- 用户可持续感知在线/离线/队列冻结/同步安全状态
- 新增自动化测试覆盖所有发现的风险路径，CI 稳定通过
