---
mode: agent
model: Claude Sonnet 4
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: NanoFlow 同步链路二层深度审计执行

## Implementation Instructions

### Step 1: Create Changes Tracking File

创建 `.copilot-tracking/changes/20260207-sync-chain-layer2-deep-audit-changes.md`，并初始化以下结构：

```markdown
# Changes: NanoFlow 同步链路二层深度审计执行

## Added

## Modified

## Removed

## Verification

## Release Summary
```

要求在 `Verification` 中建立问题 ID（SYNC-CROSS-001~012）到“代码变更 + 测试用例 + 验收命令”的映射表。

### Step 2: Execute Implementation

You WILL follow #file:../../.github/instructions/task-implementation.instructions.md
You WILL systematically implement task-by-task following #file:../plans/20260207-sync-chain-layer2-deep-audit-plan.instructions.md
You WILL reference detailed specifications from #file:../details/20260207-sync-chain-layer2-deep-audit-details.md
You WILL reference research findings from #file:../research/20260207-sync-chain-layer2-deep-audit-research.md
You WILL follow ALL project standards and conventions from #file:../../AGENTS.md

**Phase 执行顺序（必须按依赖顺序执行）**：

1. **Phase 0**: 基线冻结与变更治理
   - 固化基线失败簇与当前行为证据
   - 加入灰度开关与回滚入口

2. **Phase 1**: 成功语义闭合与下载合并安全化
   - 先修复 `BatchSyncService` 成功口径
   - 再修复 `downloadAndMerge` 与 `hasPendingLocalChanges` 清理时机

3. **Phase 2**: 队列耐久优先与单队列语义收敛
   - 停用 RetryQueue 与 ActionQueueStorage 的淘汰删除策略
   - 收敛双队列为单一待同步真相源

4. **Phase 3**: 脏记录清理闭环与错误可观测化
   - 补齐 `clearProjectChanges()` 生产闭环
   - 替换同步关键路径 `catch { return null }`

5. **Phase 4**: Realtime 与 Delta 链路收敛
   - 对 task-level 回调链路做“接通或删除”单向决策
   - Delta 统一字段映射与服务端时间戳游标推进

6. **Phase 5**: 算法硬规则与 Tombstone 单点化
   - 拓扑排序递归改迭代 + 深度限制
   - tombstone 三套实现收敛到 `TombstoneService`

7. **Phase 6**: 验证矩阵、灰度发布与最终验收
   - 每个问题 ID 至少 1 条自动化回归
   - 输出发布计划、回滚手册与最终验收报告

**每个 Phase 结束后的最低验证命令**：

```bash
npm run test:run:services
npm run lint
npm run build
```

**同步专项验证（建议增量执行）**：

```bash
npm run test:run:services -- sync
npm run test:e2e -- sync-integrity
```

**CRITICAL**: If ${input:phaseStop:true} is true, you WILL stop after each Phase for user review.
**CRITICAL**: If ${input:taskStop:false} is true, you WILL stop after each Task for user review.

### Step 3: Cleanup

When ALL Phases are checked off (`[x]`) and completed you WILL do the following:

1. You WILL provide a markdown style link and a summary of all changes from to the user:

   - You WILL keep the overall summary brief
   - You WILL add spacing around any lists
   - You MUST wrap any reference to a file in a markdown style link

2. You WILL provide markdown style links to .copilot-tracking/plans/20260207-sync-chain-layer2-deep-audit-plan.instructions.md, .copilot-tracking/details/20260207-sync-chain-layer2-deep-audit-details.md, and .copilot-tracking/research/20260207-sync-chain-layer2-deep-audit-research.md documents. You WILL recommend cleaning these files up as well.
3. **MANDATORY**: You WILL attempt to delete .copilot-tracking/prompts/implement-sync-chain-layer2-deep-audit.prompt.md

## Success Criteria

- [ ] Changes tracking file created and continuously updated
- [ ] All Phase checklist items completed with implementation evidence
- [ ] 12 个问题 ID 均有可追溯修复与测试覆盖
- [ ] 同步状态成功语义与远端确认一致
- [ ] 队列压力下无主动丢写行为
- [ ] Delta 游标推进与字段映射通过边界验证
- [ ] Tombstone 单点化完成且删除防复活通过验证
- [ ] Gray release and rollback strategy documented
