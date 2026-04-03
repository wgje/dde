---
applyTo: ".copilot-tracking/changes/20260201-code-quality-issues-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: NanoFlow Code Quality Issues 修复

## Overview

系统性修复 NanoFlow 项目中的代码质量问题，包括错误吞噬模式、console.* 遗留使用、StoreService 精简、测试类型安全和大文件拆分。

## Objectives

- 消除 55+ 处 `catch { return null }` 错误吞噬模式，统一采用 Result 模式
- 替换 37 处 `console.*` 调用为 LoggerService
- 精简 StoreService 从 956 行至 200 行以下
- 降低测试文件中 `any` 类型使用从 149 处至 50 处以下
- 拆分 18 个超过 800 行的文件

## Research Summary

### Project Files

- `.copilot-tracking/research/20260201-code-quality-issues-research.md` - 完整的代码质量问题分析
- `src/utils/result.ts` - 已有的 Result 模式定义
- `src/services/logger.service.ts` - 已完善的 LoggerService

### Standards References

- `.github/instructions/frontend.instructions.md` - 前端开发标准
- `.github/instructions/testing.instructions.md` - 测试规范
- `AGENTS.md` - 核心规则和目录结构

## Implementation Checklist

### [ ] Phase 1: P0 - Error Swallowing 关键路径修复

- [ ] Task 1.1: 创建 wrapWithResult 辅助函数和 ESLint 规则
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 12-58)

- [ ] Task 1.2: 修复 migration.service.ts 中 8 处错误吞噬
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 60-105)

- [ ] Task 1.3: 修复 recovery.service.ts 中 7 处错误吞噬
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 107-148)

- [ ] Task 1.4: 修复 auth.service.ts 中 5 处错误吞噬
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 150-190)

### [ ] Phase 2: P0 - Error Swallowing 次要路径修复

- [ ] Task 2.1: 修复 attachment.service.ts 中 5 处错误吞噬
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 194-235)

- [ ] Task 2.2: 修复 circuit-breaker.service.ts 中 5 处错误吞噬
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 237-278)

- [ ] Task 2.3: 修复 storage-adapter.service.ts 中 5 处错误吞噬
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 280-321)

- [ ] Task 2.4: 修复剩余服务中的错误吞噬模式 (约 20 处)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 323-380)

### [ ] Phase 3: P1 - console.* 统一替换

- [ ] Task 3.1: 替换组件中的 console.* 调用 (5 个文件)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 384-430)

- [ ] Task 3.2: 替换服务和工具中的 console.* 调用 (4 个文件)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 432-478)

- [ ] Task 3.3: 添加 ESLint no-console 规则
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 480-510)

### [ ] Phase 4: P1 - StoreService 精简

- [ ] Task 4.1: 分析 StoreService 透传方法和依赖关系
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 514-560)

- [ ] Task 4.2: 更新调用点直接注入子服务 (批次 1)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 562-620)

- [ ] Task 4.3: 更新调用点直接注入子服务 (批次 2)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 622-680)

- [ ] Task 4.4: 移除 StoreService 透传方法，仅保留初始化协调
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 682-730)

### [ ] Phase 5: P2 - 测试类型安全改进

- [ ] Task 5.1: 创建类型安全的 createMock<T> 工具函数
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 734-790)

- [ ] Task 5.2: 替换高优先级测试文件中的 any 类型
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 792-850)

- [ ] Task 5.3: 替换中等优先级测试文件中的 any 类型
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 852-910)

### [ ] Phase 6: P2 - 大文件拆分

- [ ] Task 6.1: 拆分 critical-paths.spec.ts (1683 行)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 914-970)

- [ ] Task 6.2: 拆分 app.component.ts (1494 行)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 972-1030)

- [ ] Task 6.3: 拆分 action-queue.service.ts (1429 行)
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 1032-1090)

- [ ] Task 6.4: 拆分其他超过 800 行的大文件
  - Details: .copilot-tracking/details/20260201-code-quality-issues-details.md (Lines 1092-1160)

## Dependencies

- `src/utils/result.ts` - Result 模式已定义
- `src/services/logger.service.ts` - LoggerService 已完善
- `eslint.config.js` - ESLint 配置可扩展
- Angular 19.x Signals 状态管理
- Vitest 测试框架

## Success Criteria

- [ ] 零 `catch { return null }` 模式 (当前 55+)
- [ ] 零 `console.*` 在非测试代码 (当前 37)
- [ ] StoreService < 200 行 (当前 956)
- [ ] 测试 `any` 使用 < 50 处 (当前 149)
- [ ] 所有文件 < 800 行 (当前 18 个违规)
- [ ] LoggerService 采用率 100% (当前 74%)
- [ ] 所有测试通过
- [ ] ESLint 检查通过
