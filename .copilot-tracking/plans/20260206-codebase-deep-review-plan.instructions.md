---
applyTo: ".copilot-tracking/changes/20260206-codebase-deep-review-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: NanoFlow 代码库深度审查修复

## Overview

基于代码库深度审查，系统性修复 22 个超 800 行文件、34 处错误吞噬、22 处 @deprecated 死代码、132 处 O(n) 线性搜索、35 处 setCallbacks 回调模式、15 个无测试关键服务等问题，将代码库从过度工程状态收敛到项目自身规范的可维护水平。

## Objectives

- 将 22 个超 800 行文件全部降至 800 行以内（自动生成文件 supabase.ts 除外）
- 消除全部 34 处 `catch { return null/undefined/[]/{}` 错误吞噬模式，统一采用 Result 模式
- 清理全部 22 处 `@deprecated` 标记及其对应的死代码
- 将 132 处 `.find(t => t.id)` 热路径替换为 Store 的 O(1) 查找
- 在 CI 构建中恢复类型检查 (`NG_BUILD_TYPE_CHECK=1`)
- 为 15 个无测试关键服务补齐单元测试，将服务测试覆盖率从 49% 提升至 70%+
- 消除 TaskOperationService/SimpleSyncService 的 setCallbacks 回调模式，改用直接 DI
- 修复 Navigator Lock 被禁用的安全隐患

## Research Summary

### Project Files

- `.copilot-tracking/research/20260206-codebase-deep-review-research.md` - 代码库深度审查完整研究报告
- `src/utils/result.ts` - 已有的 Result 模式定义（360 行，包含 success/failure/wrapWithResult/tryCatchAsync）
- `src/services/logger.service.ts` - 已完善的 LoggerService（299 行）
- `src/app/core/state/stores.ts` - Signals 状态管理（Map<id, Entity> 模式）
- `AGENTS.md` - 核心规则和项目规范

### External References

- Angular Signals 文档 - 状态管理最佳实践
- Supabase Auth Lock 文档 - Navigator Lock 兼容方案

### Standards References

- `.github/instructions/general.instructions.md` - 文件行数上限 800 行，函数不超过 50 行
- `.github/instructions/angular.instructions.md` - OnPush 变更检测, Signal 状态管理
- `.github/instructions/frontend.instructions.md` - 前端开发标准
- `.github/instructions/testing.instructions.md` - 测试规范

## Implementation Checklist

### [ ] Phase 1: 低风险快赢 — 死代码清理与错误处理统一（预计 1-2 周）

- [ ] Task 1.1: 清理 task-operation.service.ts 中 8 处 @deprecated 标记及死代码
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 11-41)

- [ ] Task 1.2: 清理 task-operation-adapter.service.ts 中 8 处 @deprecated 代理方法
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 42-74)

- [ ] Task 1.3: 清理 sync-coordinator.service.ts、auth.guard.ts、flow-view-state.ts、supabase-types.ts 中 6 处 @deprecated
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 75-104)

- [ ] Task 1.4: 修复 data-preloader.service.ts 中 3 处错误吞噬（空 .catch() + { /* 忽略 */ }）
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 105-137)

- [ ] Task 1.5: 修复 preference.service.ts、theme.service.ts、conflict-storage.service.ts 中 3 处 return null 吞噬
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 138-182)

- [ ] Task 1.6: 修复 export.service.ts、attachment.service.ts 中 4 处错误吞噬
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 183-217)

- [ ] Task 1.7: 修复 migration.service.ts、store-persistence.service.ts、project-data.service.ts、batch-sync.service.ts、action-queue.service.ts 中 6 处 return null 吞噬
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 218-261)

- [ ] Task 1.8: 修复 clock-sync.service.ts、realtime-polling.service.ts、user-preferences-sync.service.ts 中 3 处错误吞噬
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 262-295)

- [ ] Task 1.9: 修复 flow-overview.service.ts、flow-event.service.ts、flow-touch.service.ts 中 GoJS 相关错误吞噬（评估后保留合理的或替换）
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 296-334)

- [ ] Task 1.10: 修复 text-task-editor.component.ts、sentry-alert.service.ts 中 2 处错误吞噬
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 335-365)

### [ ] Phase 2: O(n) 线性搜索优化与构建配置修复（预计 1 周）

- [ ] Task 2.1: 替换 flow-view.component.ts 中 `.find(t => t.id)` 为 Store O(1) 查找
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 368-399)

- [ ] Task 2.2: 替换 text-view.component.ts 中 8+ 处 `.find(t => t.id)` 为 Store O(1) 查找
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 400-421)

- [ ] Task 2.3: 替换 task-operation.service.ts 中 `.find(t => t.id)` 为 Store O(1) 查找
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 422-445)

- [ ] Task 2.4: 替换 conflict-resolution.service.ts 中多处线性搜索
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 446-473)

- [ ] Task 2.5: 批量扫描并替换其余高频 `.find(t => t.id)` 路径（按文件逐一处理）
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 474-500)

- [ ] Task 2.6: 移除 4 处 JSON.stringify 深比较，替换为字段级比较
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 501-538)

- [ ] Task 2.7: 在 CI 构建中恢复 NG_BUILD_TYPE_CHECK=1 并修复发现的类型错误
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 539-571)

### [ ] Phase 3: 大文件拆分 — 核心组件与服务（预计 2-3 周）

- [ ] Task 3.1: 拆分 app.component.ts（1475 行）— 提取模态框协调器、搜索管理器、认证协调器
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 574-618)

- [ ] Task 3.2: 拆分 task-operation-adapter.service.ts（1423 行）— 消除代理方法、提取回调桥接
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 619-651)

- [ ] Task 3.3: 拆分 action-queue.service.ts（1376 行）— 提取 IndexedDB 备份、死信队列、处理器注册
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 652-681)

- [ ] Task 3.4: 拆分 task-repository.service.ts（1198 行）— 按操作类型拆分
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 682-703)

- [ ] Task 3.5: 拆分 text-view.component.ts（1162 行）— 提取阶段管理、拖放逻辑
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 704-725)

- [ ] Task 3.6: 拆分 flow-task-detail.component.ts（1147 行）— 提取附件管理、表单逻辑
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 726-747)

- [ ] Task 3.7: 拆分 GoJS 四大服务（flow-template 1169 行、flow-link 1123 行、flow-diagram 1098 行、flow-view 1037 行）
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 748-778)

- [ ] Task 3.8: 拆分同步层服务（conflict-resolution 1036 行、simple-sync 1032 行、migration 1018 行）
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 779-804)

- [ ] Task 3.9: 拆分边界文件（dashboard-modal 902 行、change-tracker 899 行、user-session 895 行、flow-overview 887 行、task-sync-operations 872 行、minimap-math 869 行、undo 829 行、text-view-drag-drop 829 行、attachment-export 818 行）
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 805-831)

### [ ] Phase 4: 测试覆盖率提升（预计 2-3 周）

- [ ] Task 4.1: 为 task-move.service.ts（734 行）补齐单元测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 834-877)

- [ ] Task 4.2: 为 task-creation.service.ts（268 行）和 subtree-operations.service.ts（430 行）补齐单元测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 878-903)

- [ ] Task 4.3: 为 user-session.service.ts（895 行）补齐单元测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 904-921)

- [ ] Task 4.4: 为 layout.service.ts（784 行）和 local-backup.service.ts（742 行）补齐单元测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 922-944)

- [ ] Task 4.5: 为 migration.service.ts（1018 行）和 attachment.service.ts（705 行）补齐单元测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 945-968)

- [ ] Task 4.6: 为 virus-scan.service.ts（649 行）和 clock-sync.service.ts（520 行）补齐单元测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 969-991)

- [ ] Task 4.7: 为 logger.service.ts、preference.service.ts、event-bus.service.ts、connection-adapter.service.ts、supabase-client.service.ts 补齐单元测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 992-1014)

- [ ] Task 4.8: 消除测试中 116 处 `as any` 访问私有成员，改用公共 API 测试
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 1015-1051)

### [ ] Phase 5: 架构级优化 — 回调模式消除与安全修复（预计 2-4 周）

- [ ] Task 5.1: 消除 TaskOperationService 的 setCallbacks 回调模式 — 改用直接 DI 注入
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 1054-1113)

- [ ] Task 5.2: 消除 SimpleSyncService 的 setCallbacks 回调模式 — 改用直接 DI 注入
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 1114-1142)

- [ ] Task 5.3: 修复 supabase-client.service.ts Navigator Lock 被禁用的安全隐患
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 1143-1185)

- [ ] Task 5.4: 优化 stores.ts 中 Map 克隆策略 — 引入批量更新和惰性克隆
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 1186-1231)

- [x] Task 5.5: 定义 services/ 与 app/core/services/ 层级依赖规则 — 解决 87 处跨层引用
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 1232-1270)

- [x] Task 5.6: 将 11 个 RxJS Subject 迁移到 Angular Signal — 统一状态管理策略
  - Details: .copilot-tracking/details/20260206-codebase-deep-review-details.md (Lines 1271-1325)

## Dependencies

- Angular 19.2.x（Signals + standalone components + OnPush）
- Vitest 4.0.x（单元测试框架）
- ESLint（代码质量规则）
- `src/utils/result.ts`（Result 模式工具函数）
- `src/services/logger.service.ts`（日志服务）
- `src/app/core/state/stores.ts`（Signal 状态管理）
- knip（检测未使用代码）

## Success Criteria

- 0 个非自动生成文件超过 800 行
- 0 处 `catch { return null/undefined/[]/{}` 错误吞噬
- 0 个 `@deprecated` 标记（全部清理或有明确迁移计划）
- 0 处 `.find(t => t.id)` 在已知有 O(1) 替代路径的位置
- CI 构建启用 `NG_BUILD_TYPE_CHECK=1` 且零类型错误
- 服务测试覆盖率 ≥ 70%（当前 49%）
- 测试 `as any` 使用下降至 50 处以下（当前 116 处）
- 0 处 setCallbacks 回调模式
- Navigator Lock 安全修复验证通过
