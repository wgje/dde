---
mode: agent
model: Claude Sonnet 4
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: NanoFlow 数据丢失与 UI 真逻辑一致性治理

## Implementation Instructions

### Step 1: Create Changes Tracking File

创建变更跟踪文件 `.copilot-tracking/changes/20260209-data-loss-ui-truthfulness-changes.md`，格式：

```markdown
# Changes: NanoFlow 数据丢失与 UI 真逻辑一致性治理

## Added

## Modified

## Removed
```

### Step 2: Execute Implementation

You WILL follow #file:../../.github/instructions/task-implementation.instructions.md
You WILL systematically implement task-by-task following:
- Plan: #file:../../.copilot-tracking/plans/20260209-data-loss-ui-truthfulness-plan.instructions.md
- Details: #file:../../.copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md
- Research: #file:../../.copilot-tracking/research/20260209-data-loss-ui-truthfulness-research.md

You WILL follow ALL project standards and conventions:
- `AGENTS.md` — 核心规则（Result 模式、Signals、Offline-first、直接注入具体子服务）
- `.github/instructions/general.instructions.md` — 代码规范
- `.github/instructions/angular.instructions.md` — Angular 开发规范

**Implementation Priority Order:**
1. Phase 1 (P0/P1): 安全漏洞 + UI 真逻辑（Task 1.1 → 1.5）
2. Phase 2 (P1/P2): 同步队列韧性（Task 2.1 → 2.3）
3. Phase 3 (P2/P3): 可观测性 + 测试 + 门禁（Task 3.1 → 3.5）

**CRITICAL**: If ${input:phaseStop:true} is true, you WILL stop after each Phase for user review.
**CRITICAL**: If ${input:taskStop:false} is true, you WILL stop after each Task for user review.

### Step 3: Cleanup

When ALL Phases are checked off (`[x]`) and completed you WILL do the following:

1. You WILL provide a markdown style link and a summary of all changes from to the user:

   - You WILL keep the overall summary brief
   - You WILL add spacing around any lists
   - You MUST wrap any reference to a file in a markdown style link

2. You WILL provide markdown style links to .copilot-tracking/plans/20260209-data-loss-ui-truthfulness-plan.instructions.md, .copilot-tracking/details/20260209-data-loss-ui-truthfulness-details.md, and .copilot-tracking/research/20260209-data-loss-ui-truthfulness-research.md documents. You WILL recommend cleaning these files up as well.
3. **MANDATORY**: You WILL attempt to delete .copilot-tracking/prompts/implement-data-loss-ui-truthfulness.prompt.md

## Success Criteria

- [ ] Changes tracking file created
- [ ] All plan items implemented with working code
- [ ] All detailed specifications satisfied
- [ ] Project conventions followed (Result pattern, Signals, OnPush, 直接注入子服务)
- [ ] Changes file updated continuously
