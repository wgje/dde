---
agent: agent
model: Claude Sonnet 4
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: NanoFlow Code Quality Issues 修复

## Task Overview

系统性修复 NanoFlow 项目中的代码质量问题，包括：
- **P0**: 55+ 处错误吞噬模式 → Result 模式
- **P1**: 37 处 console.* → LoggerService
- **P1**: StoreService 956 行 → <200 行
- **P2**: 测试 any 类型 149 处 → <50 处
- **P2**: 18 个超过 800 行的文件 → 全部拆分

## Implementation Instructions

### Step 1: Create Changes Tracking File

创建变更追踪文件：`.copilot-tracking/changes/20260201-code-quality-issues-changes.md`

使用以下模板：

```markdown
<!-- markdownlint-disable-file -->
# Release Changes: NanoFlow Code Quality Issues 修复

**Related Plan**: 20260201-code-quality-issues-plan.instructions.md
**Implementation Date**: 2026-02-01

## Summary

系统性修复代码质量问题，消除错误吞噬模式，统一日志处理，精简 StoreService，提高测试类型安全。

## Changes

### Added

### Modified

### Removed
```

### Step 2: Execute Implementation

**执行计划文件**: `.copilot-tracking/plans/20260201-code-quality-issues-plan.instructions.md`
**详情文件**: `.copilot-tracking/details/20260201-code-quality-issues-details.md`
**研究文件**: `.copilot-tracking/research/20260201-code-quality-issues-research.md`

You WILL follow #file:../../.github/instructions/task-implementation.instructions.md
You WILL systematically implement task-by-task
You WILL follow ALL project standards and conventions

**CRITICAL**: If ${input:phaseStop:true} is true, you WILL stop after each Phase for user review.
**CRITICAL**: If ${input:taskStop:false} is true, you WILL stop after each Task for user review.

### Implementation Priority Order

1. **Phase 1-2 (P0)**: Error Swallowing 修复 - 最优先，影响调试能力
2. **Phase 3 (P1)**: console.* 替换 - 快速完成，可并行
3. **Phase 4 (P1)**: StoreService 精简 - 架构改进
4. **Phase 5 (P2)**: 测试类型安全 - 持续改进
5. **Phase 6 (P2)**: 大文件拆分 - 最后处理

### Key Commands for Verification

```bash
# 检查错误吞噬模式
grep -rn "catch.*{" --include="*.ts" src/ | grep -v ".spec.ts" | grep "return null" | wc -l

# 检查 console.* 使用
grep -rn "console\.\(log\|warn\|error\)" --include="*.ts" src/ | grep -v ".spec.ts" | wc -l

# 检查 StoreService 行数
wc -l src/services/store.service.ts

# 检查测试中 any 使用
grep -rn ": any" --include="*.spec.ts" src/ | wc -l

# 检查超过 800 行的文件
find src/ -name "*.ts" -exec wc -l {} \; | awk '$1 > 800 {print}'

# 运行测试
npm run test:run

# 运行 ESLint
npm run lint
```

### Step 3: Cleanup

When ALL Phases are checked off (`[x]`) and completed you WILL do the following:

1. You WILL provide a markdown style link and a summary of all changes from to the user:

   - You WILL keep the overall summary brief
   - You WILL add spacing around any lists
   - You MUST wrap any reference to a file in a markdown style link

2. You WILL provide markdown style links to:
   - [.copilot-tracking/plans/20260201-code-quality-issues-plan.instructions.md](.copilot-tracking/plans/20260201-code-quality-issues-plan.instructions.md)
   - [.copilot-tracking/details/20260201-code-quality-issues-details.md](.copilot-tracking/details/20260201-code-quality-issues-details.md)
   - [.copilot-tracking/research/20260201-code-quality-issues-research.md](.copilot-tracking/research/20260201-code-quality-issues-research.md)
   
   You WILL recommend cleaning these files up as well.

3. **MANDATORY**: You WILL attempt to delete `.copilot-tracking/prompts/implement-code-quality-issues.prompt.md`

## Success Criteria

- [ ] Changes tracking file created
- [ ] All plan items implemented with working code
- [ ] All detailed specifications satisfied
- [ ] Project conventions followed
- [ ] Changes file updated continuously
- [ ] 零 `catch { return null }` 模式
- [ ] 零 `console.*` 在非测试代码
- [ ] StoreService < 200 行
- [ ] 测试 `any` 使用 < 50 处
- [ ] 所有文件 < 800 行
- [ ] 所有测试通过
- [ ] ESLint 检查通过

## Metrics Dashboard

| 指标 | 当前值 | 目标值 | 状态 |
|------|--------|--------|------|
| `return null` in catch | 55+ | 0 | ⏳ |
| console.* (非测试) | 37 | 0 | ⏳ |
| `any` in tests | 149 | <50 | ⏳ |
| StoreService 行数 | 956 | <200 | ⏳ |
| 超过 800 行的文件 | 18 | 0 | ⏳ |
| LoggerService 采用率 | 74% | 100% | ⏳ |
