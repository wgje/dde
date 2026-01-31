---
agent: edit
model: Claude Opus 4.5 (copilot)
---

<!-- markdownlint-disable-file -->

# Implementation Prompt: 技术债务清理计划更新

## Implementation Instructions

### Step 1: Create Changes Tracking File

你需要在 #file:../changes/ 目录下创建 `20260131-tech-debt-remediation-changes.md` 文件（如果不存在）。

### Step 2: Execute Implementation

你需要按照以下步骤更新技术债务清理计划：

1. **更新 prompt 文件数量统计**
   - 文件: docs/tech-debt-remediation-plan.md
   - 将 M-05 任务描述从 "5个" 更新为 "8个"
   - 参考: #file:../details/20260131-tech-debt-remediation-details.md (Lines 221-250)

2. **补充遗漏的超大文件**
   - 在问题清单中添加 14 个 800-1200 行的文件
   - 参考: #file:../details/20260131-tech-debt-remediation-details.md (Lines 151-200)

3. **澄清 ESLint 禁用注释统计**
   - 添加说明：生产代码 4 处 / 测试代码 27 处
   - 参考: #file:../details/20260131-tech-debt-remediation-details.md (Lines 201-220)

4. **更新工作量估算**
   - 将总估算更新为 100-130 人天（含 20% 缓冲）
   - 参考: #file:../details/20260131-tech-debt-remediation-details.md (Lines 361-400)

**CRITICAL**: 遵循 #file:../../.github/instructions/docs.instructions.md 中的文档规范

### Step 3: Cleanup

当所有更新完成后：

1. 提供变更摘要和文件链接
2. 提供清理建议链接:
   - [.copilot-tracking/plans/20260131-tech-debt-remediation-plan.instructions.md]
   - [.copilot-tracking/details/20260131-tech-debt-remediation-details.md]
   - [.copilot-tracking/research/20260131-tech-debt-remediation-research.md]

## Success Criteria

- [ ] Changes tracking file created
- [ ] M-05 任务更新为 8 个文件
- [ ] 遗漏的超大文件已补充到计划
- [ ] ESLint 统计口径已澄清
- [ ] 工作量估算已更新
- [ ] Changes file updated continuously
