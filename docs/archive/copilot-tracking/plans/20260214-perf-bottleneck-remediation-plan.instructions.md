---
applyTo: ".copilot-tracking/changes/20260214-perf-bottleneck-remediation-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: 2026-02-14 线上性能瓶颈修复

## Overview

基于 2026-02-14 线上性能审计报告，系统性修复 3 个 P0 高优先级瓶颈（重复拉取、RPC 400 回退、GoJS 过早加载）+ 2 个 P1 中优先级优化（字体策略、初始化解耦）+ 2 个 P2 治理项（弱网门禁、告警监控），目标将弱网 LCP 从 ~26s 降至 <6s，消除冗余同步请求。

## Objectives

- 消除 `black_box_entries` 重复拉取（从 2 次降至 ≤ 1 次）
- 消除 `get_full_project_data` RPC 400 Access Denied 及其无效回退链路
- 阻断桌面端登录后自动执行 GoJS chunk（364 KB 传输量的主线程负载）
- 首屏字体请求从 3 个收敛到 1 个，延后其余子集加载
- FocusMode 初始化与核心数据加载分离，降低登录后并发请求峰值
- 建立弱网性能预算 CI 门禁和同步异常告警

## Research Summary

### Project Files

- `src/services/black-box-sync.service.ts` L511 — `lastSyncTime || '1970-01-01'` 全量回退 + 无 single-flight 机制
- `src/app/features/focus/focus-mode.component.ts` L139 — 无条件调用 `pullChanges()` 触发重复拉取
- `src/app/core/services/sync/project-data.service.ts` L85-L89 — RPC 400 Access Denied 命中 fallback
- `src/services/user-session.service.ts` L366-L401 — 三阶段同步链路，无效 projectId 导致 RPC 400
- `src/app/core/shell/project-shell.component.ts` L248 — `@defer (on idle; prefetch on idle)` GoJS 过早触发
- `src/app.component.html` L98-L101 — FocusMode `@defer (on idle)` 过早初始化
- `index.html` L65-L128 — 字体 preload/prefetch 策略

### External References

- `docs/deep-performance-audit-2026-02-14.md` — 完整审计报告（322 行），含三场景基线数据与代码级根因分析
- `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` — 全量研究文件

### Standards References

- `AGENTS.md` 5.2 — Offline-first 数据流：本地先写 + 后台同步
- `AGENTS.md` 5.3 — GoJS 必须 @defer 懒加载，禁止 visibility:hidden 保活
- `.github/copilot-instructions.md` — 增量同步替代全量拉取、按需懒加载

## Implementation Checklist

### [x] Phase 1: 阻断 black_box_entries 重复拉取（P0-3）

- [x] Task 1.1: BlackBoxSyncService 增加 single-flight + freshness window
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 14-38)

- [x] Task 1.2: FocusMode 初始化优先使用本地缓存
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 40-60)

- [x] Task 1.3: 验证重复拉取已消除
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 62-76)

### [x] Phase 2: 消除 RPC 400 + 无效回退链路（P0-2）

- [x] Task 2.1: ProjectDataService RPC 错误分类处理
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 80-103)

- [x] Task 2.2: UserSessionService 清理无效 activeProjectId
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 105-125)

- [x] Task 2.3: 验证 RPC 400 消除
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 127-141)

### [x] Phase 3: 桌面 Flow chunk 延迟加载（P0-1）

- [x] Task 3.1: 将 Flow @defer 改为用户意图触发
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 145-181)

- [x] Task 3.2: 验证桌面端首屏不执行 GoJS chunk
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 183-198)

### [x] Phase 4: 字体加载策略优化（P1-1）

- [x] Task 4.1: 收敛首屏字体预加载
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 202-223)

- [x] Task 4.2: 验证字体加载行为
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 225-241)

### [x] Phase 5: FocusMode/BlackBox 初始化解耦（P1-2）

- [x] Task 5.1: FocusMode @defer 添加条件守卫
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 245-271)

- [x] Task 5.2: 验证初始化时序
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 273-286)

### [x] Phase 6: 监控与回归门禁（P2）

- [x] Task 6.1: 增加弱网性能预算 CI 检查
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 290-311)

- [x] Task 6.2: 增加同步链路异常告警
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 313-330)

### [x] Phase 7: 全量验证与回归测试

- [x] Task 7.1: 三场景性能复测
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 334-349)

- [x] Task 7.2: 执行现有测试套件
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 351-362)

- [x] Task 7.3: E2E 关键路径验证
  - Details: .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md (Lines 364-380)

## Dependencies

- Angular 19.2.x（@defer / Signals / OnPush）
- Supabase 2.84+（RPC / black_box_entries / RLS）
- GoJS 3.1.x（Flow 图渲染）
- Vitest 4.0.x（单元测试）
- Playwright 1.48+（E2E 测试 + 性能采样）
- Sentry 10.32+（告警配置）

## Success Criteria

- 弱网+4xCPU LCP 从 ~26,172ms 降至 < 6,000ms
- 桌面常规 LCP 保持 < 1,200ms
- 登录后 `black_box_entries` 重复拉取消除（≤ 1 次/30s）
- `get_full_project_data` RPC 400 消除（0 次）
- 桌面首屏不执行 GoJS chunk（仅预取）
- 首屏字体请求 ≤ 1 个
- FocusMode 初始化延后到核心数据加载完成后
- 弱网性能预算接入 CI 门禁
- 所有测试（Unit / Service / Component / E2E）通过，无功能回归
