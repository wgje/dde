---
mode: agent
model: Claude Sonnet 4
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: NanoFlow 深度性能审计修复

## Implementation Instructions

### Step 1: Create Changes Tracking File

在 `.copilot-tracking/changes/20260207-deep-performance-audit-changes.md` 创建变更追踪文件。

### Step 2: Execute Implementation

You WILL follow #file:../../.github/instructions/task-implementation.instructions.md
You WILL systematically implement task-by-task following the plan in #file:../plans/20260207-deep-performance-audit-plan.instructions.md
You WILL reference detailed specifications in #file:../details/20260207-deep-performance-audit-details.md
You WILL follow ALL project standards and conventions defined in #file:../../AGENTS.md

**Implementation Order（严格按此顺序）**：

1. **Phase 1**: GoJS Bundle 泄漏修复 — 这是 ROI 最高的修复，一行代码变更预期减少 200-400KB
2. **Phase 2**: @defer 触发器修复 — 依赖 Phase 1（GoJS 不在 main bundle 后 defer 才有意义）
3. **Phase 3**: Service Worker 矛盾清理 — 独立修复，可与 Phase 2 并行
4. **Phase 4**: FocusModeComponent 懒加载 — 进一步减小 main bundle
5. **Phase 5**: 同步服务优化 — 减少首屏 CPU 占用
6. **Phase 6**: 构建配置优化 — 防止性能回归
7. **Phase 7**: 验证与回归测试 — 确认所有修复效果

**每个 Phase 完成后必须**：
- 执行 `ng build --configuration production` 验证构建成功
- 记录 main.js 体积变化
- 更新 changes 文件

**CRITICAL**: If ${input:phaseStop:true} is true, you WILL stop after each Phase for user review.
**CRITICAL**: If ${input:taskStop:false} is true, you WILL stop after each Task for user review.

### Step 3: Cleanup

When ALL Phases are checked off (`[x]`) and completed you WILL do the following:

1. You WILL provide a markdown style link and a summary of all changes from to the user:

   - You WILL keep the overall summary brief
   - You WILL add spacing around any lists
   - You MUST wrap any reference to a file in a markdown style link

2. You WILL provide markdown style links to .copilot-tracking/plans/20260207-deep-performance-audit-plan.instructions.md, .copilot-tracking/details/20260207-deep-performance-audit-details.md, and .copilot-tracking/research/20260207-deep-performance-audit-research.md documents. You WILL recommend cleaning these files up as well.
3. **MANDATORY**: You WILL attempt to delete .copilot-tracking/prompts/implement-deep-performance-audit.prompt.md

## Success Criteria

- [ ] Changes tracking file created
- [ ] All plan items implemented with working code
- [ ] All detailed specifications satisfied
- [ ] Project conventions followed (AGENTS.md, angular.instructions.md)
- [ ] Changes file updated continuously
- [ ] main.js brotli < 100KB
- [ ] 首屏不加载 GoJS
- [ ] E2E 测试全部通过
- [ ] LCP < 2.5s, INP < 200ms
