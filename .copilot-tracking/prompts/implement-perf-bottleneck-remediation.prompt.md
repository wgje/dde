---
agent: agent
model: Claude Sonnet 4
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: 2026-02-14 线上性能瓶颈修复

## Implementation Instructions

### Step 1: Create Changes Tracking File

创建变更记录文件 `.copilot-tracking/changes/20260214-perf-bottleneck-remediation-changes.md`，包含以下初始内容：

```markdown
# Changes: 2026-02-14 线上性能瓶颈修复

## Status: In Progress

## Added
## Modified
## Removed
```

### Step 2: Execute Implementation

You WILL follow #file:../../.github/instructions/task-implementation.instructions.md
You WILL systematically implement task-by-task following #file:../../.copilot-tracking/plans/20260214-perf-bottleneck-remediation-plan.instructions.md
You WILL reference detailed specifications from #file:../../.copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md
You WILL follow ALL project standards and conventions

**实施顺序**: Phase 1 (P0-3) → Phase 2 (P0-2) → Phase 3 (P0-1) → Phase 4 (P1-1) → Phase 5 (P1-2) → Phase 6 (P2) → Phase 7 (验证)

**关键约束**:
- 每个 Phase 独立可回滚，单独提交
- 修改同步相关代码时必须保持 LWW 语义
- 禁止 `inject(StoreService)`，必须注入具体子服务
- GoJS 改动必须遵守 AGENTS.md 5.3（@defer 懒加载、禁止 visibility:hidden）
- 所有实体 ID 只能由 `crypto.randomUUID()` 生成
- 每个 Task 完成后运行相关测试验证

**CRITICAL**: If ${input:phaseStop:true} is true, you WILL stop after each Phase for user review.
**CRITICAL**: If ${input:taskStop:false} is true, you WILL stop after each Task for user review.

### Step 3: Cleanup

When ALL Phases are checked off (`[x]`) and completed you WILL do the following:

1. You WILL provide a markdown style link and a summary of all changes from to the user:

   - You WILL keep the overall summary brief
   - You WILL add spacing around any lists
   - You MUST wrap any reference to a file in a markdown style link

2. You WILL provide markdown style links to .copilot-tracking/plans/20260214-perf-bottleneck-remediation-plan.instructions.md, .copilot-tracking/details/20260214-perf-bottleneck-remediation-details.md, and .copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md documents. You WILL recommend cleaning these files up as well.
3. **MANDATORY**: You WILL attempt to delete .copilot-tracking/prompts/implement-perf-bottleneck-remediation.prompt.md

## Success Criteria

- [ ] Changes tracking file created
- [ ] All plan items implemented with working code
- [ ] All detailed specifications satisfied
- [ ] Project conventions followed (AGENTS.md + copilot-instructions.md)
- [ ] Changes file updated continuously
- [ ] 弱网 LCP < 6,000ms（原 ~26,172ms）
- [ ] black_box_entries 重复拉取消除
- [ ] RPC 400 Access Denied 消除
- [ ] 桌面首屏不执行 GoJS chunk
- [ ] 所有测试通过
