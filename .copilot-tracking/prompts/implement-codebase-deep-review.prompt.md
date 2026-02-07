---
mode: agent
model: Claude Sonnet 4
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: NanoFlow 代码库深度审查修复

## Implementation Instructions

### Step 1: Create Changes Tracking File

创建变更追踪文件 `.copilot-tracking/changes/20260206-codebase-deep-review-changes.md`，包含以下初始结构：

```markdown
# Changes: NanoFlow 代码库深度审查修复

## Added

## Modified

## Removed

## Release Summary
```

### Step 2: Execute Implementation

You WILL follow #file:../../.github/instructions/task-implementation.instructions.md
You WILL systematically implement task-by-task following #file:../plans/20260206-codebase-deep-review-plan.instructions.md
You WILL reference detailed specifications from #file:../details/20260206-codebase-deep-review-details.md
You WILL reference research findings from #file:../research/20260206-codebase-deep-review-research.md
You WILL follow ALL project standards and conventions from #file:../../AGENTS.md

**Phase 执行顺序**：

1. **Phase 1**: 低风险快赢 — 清理 22 处 @deprecated 死代码 + 修复 34 处错误吞噬
   - 每个 Task 完成后运行 `npm run test:run` 验证无回归
   - 使用 `npx knip` 确认死代码已清除

2. **Phase 2**: O(n) 线性搜索优化 + 构建配置修复
   - 先确认 TaskStore.getTask(id) O(1) 查找 API 存在
   - 批量替换 .find(t => t.id) 模式
   - 尝试 NG_BUILD_TYPE_CHECK=1 构建，记录并修复类型错误

3. **Phase 3**: 大文件拆分（22 个文件降至 800 行以内）
   - 从最大文件开始：app.component.ts → task-operation-adapter → action-queue
   - 每个拆分后运行 `npm run test:run` + `npm run lint`
   - 确保新建服务遵循 `@Injectable({ providedIn: 'root' })` + `standalone: true`

4. **Phase 4**: 测试覆盖率提升（15 个服务补齐测试）
   - 使用 Vitest 框架
   - 测试同目录放置：`*.service.ts` → `*.service.spec.ts`
   - 使用 `TestBed` 并 mock 依赖

5. **Phase 5**: 架构级优化 — 回调模式消除 + 安全修复
   - 检查循环依赖风险后再执行 setCallbacks 消除
   - Navigator Lock 修复需要浏览器兼容性降级
   - Map 克隆优化需性能基准验证

**验证命令**：
```bash
npm run test:run         # 单元测试
npm run lint             # ESLint 检查
npm run build            # 构建验证
npx knip                 # 死代码检测
```

**CRITICAL**: If ${input:phaseStop:true} is true, you WILL stop after each Phase for user review.
**CRITICAL**: If ${input:taskStop:false} is true, you WILL stop after each Task for user review.

### Step 3: Cleanup

When ALL Phases are checked off (`[x]`) and completed you WILL do the following:

1. You WILL provide a markdown style link and a summary of all changes from to the user:

   - You WILL keep the overall summary brief
   - You WILL add spacing around any lists
   - You MUST wrap any reference to a file in a markdown style link

2. You WILL provide markdown style links to .copilot-tracking/plans/20260206-codebase-deep-review-plan.instructions.md, .copilot-tracking/details/20260206-codebase-deep-review-details.md, and .copilot-tracking/research/20260206-codebase-deep-review-research.md documents. You WILL recommend cleaning these files up as well.
3. **MANDATORY**: You WILL attempt to delete .copilot-tracking/prompts/implement-codebase-deep-review.prompt.md

## Success Criteria

- [ ] Changes tracking file created
- [ ] All plan items implemented with working code
- [ ] All detailed specifications satisfied
- [ ] Project conventions followed (AGENTS.md, angular.instructions.md, general.instructions.md)
- [ ] Changes file updated continuously
- [ ] 0 个非自动生成文件超过 800 行
- [ ] 0 处 catch 错误吞噬
- [ ] 0 个 @deprecated 标记
- [ ] CI 构建 NG_BUILD_TYPE_CHECK=1 通过
- [ ] 服务测试覆盖率 ≥ 70%
- [ ] 0 处 setCallbacks
- [ ] Navigator Lock 安全修复
