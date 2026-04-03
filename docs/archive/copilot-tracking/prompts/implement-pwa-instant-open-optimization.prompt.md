---
agent: agent
model: Claude Sonnet 4
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: PWA "Instant Open" 性能优化

## Task Overview

实现 PWA 应用的 LCP 优化，将 LCP 从 1,943ms 降至 <1,500ms。主要通过 Sentry SDK 懒加载消除 320ms 强制重排，并通过 JS Bundle 分析和字体渲染优化进一步提升性能。

## Plan Reference

- 计划文件: [20260201-pwa-instant-open-optimization-plan.instructions.md](.copilot-tracking/plans/20260201-pwa-instant-open-optimization-plan.instructions.md)
- 详情文件: [20260201-pwa-instant-open-optimization-details.md](.copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md)
- 研究文件: [20260201-pwa-instant-open-optimization-research.md](.copilot-tracking/research/20260201-pwa-instant-open-optimization-research.md)

## Implementation Instructions

### Step 1: Create Changes Tracking File

创建变更跟踪文件: `.copilot-tracking/changes/20260201-pwa-instant-open-optimization-changes.md`

使用以下模板:

```markdown
<!-- markdownlint-disable-file -->
# Release Changes: PWA "Instant Open" 性能优化

**Related Plan**: 20260201-pwa-instant-open-optimization-plan.instructions.md
**Implementation Date**: 2026-02-01

## Summary

实现 PWA 应用 LCP 优化，目标从 1,943ms 降至 <1,500ms。

## Changes

### Added

### Modified

### Removed

## Release Summary

（完成所有 Phase 后填写）
```

### Step 2: Execute Implementation

You WILL follow #file:../../.github/instructions/task-implementation.instructions.md
You WILL systematically implement task-by-task
You WILL follow ALL project standards and conventions

**Implementation Phases**:

1. **Phase 1: Sentry SDK 懒加载 (P0)**
   - 创建 `SentryLazyLoaderService`
   - 修改 `main.ts` 移除同步初始化
   - 配置 `app.config.ts` 异步初始化
   - 更新 `GlobalErrorHandler` 集成

2. **Phase 2: JS Bundle 分析与优化 (P1)**
   - 安装 source-map-explorer
   - 分析当前 Bundle 组成
   - 调整构建 Budgets
   - 优化大型依赖懒加载

3. **Phase 3: 字体渲染优化 (P2)**
   - 添加 size-adjust 属性
   - 验证预加载策略

4. **Phase 4: 性能验证与监控 (P3)**
   - 创建性能基准测试脚本
   - 配置 Lighthouse CI
   - 生成优化对比报告

**CRITICAL**: If ${input:phaseStop:true} is true, you WILL stop after each Phase for user review.
**CRITICAL**: If ${input:taskStop:false} is true, you WILL stop after each Task for user review.

### Step 3: Cleanup

When ALL Phases are checked off (`[x]`) and completed you WILL do the following:

1. You WILL provide a markdown style link and a summary of all changes from to the user:

   - You WILL keep the overall summary brief
   - You WILL add spacing around any lists
   - You MUST wrap any reference to a file in a markdown style link

2. You WILL provide markdown style links to:
   - [Plan File](.copilot-tracking/plans/20260201-pwa-instant-open-optimization-plan.instructions.md)
   - [Details File](.copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md)
   - [Research File](.copilot-tracking/research/20260201-pwa-instant-open-optimization-research.md)
   
   You WILL recommend cleaning these files up as well.

3. **MANDATORY**: You WILL attempt to delete `.copilot-tracking/prompts/implement-pwa-instant-open-optimization.prompt.md`

## Success Criteria

- [ ] Changes tracking file created
- [ ] All plan items implemented with working code
- [ ] All detailed specifications satisfied
- [ ] Project conventions followed
- [ ] Changes file updated continuously
- [ ] LCP < 1,500ms verified
- [ ] CLS = 0 maintained
- [ ] Sentry error capture functional
- [ ] All existing features working
