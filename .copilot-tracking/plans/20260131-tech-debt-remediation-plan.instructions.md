---
applyTo: ".copilot-tracking/changes/20260131-tech-debt-remediation-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: 技术债务清理计划审查与更新

## Overview

对 NanoFlow 技术债务清理计划进行深度审查，验证数据准确性，补充遗漏项，并更新时间估算。

## Objectives

- 验证计划中所有定量数据的准确性
- 发现并记录遗漏的技术债务问题
- 更新工作量估算使其更接近实际
- 确保计划可执行且可追踪

## Research Summary

### Project Files

- [docs/tech-debt-remediation-plan.md](../../docs/tech-debt-remediation-plan.md) - 技术债务清理主计划文档

### External References

- #file:../research/20260131-tech-debt-remediation-research.md - 深度研究报告，包含所有验证数据

### Standards References

- #file:../../.github/copilot-instructions.md - NanoFlow 编码指南
- #file:../../AGENTS.md - Agent 指令和架构规则

## Implementation Checklist

### [x] Phase 1: 数据验证

- [x] Task 1.1: 验证 console.* 调用数量
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 1-30)
  - 结果: 344 处（计划声称 343，偏差 +0.3%）✅

- [x] Task 1.2: 验证 setTimeout 使用数量
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 31-50)
  - 结果: 191 处 ✅ 准确

- [x] Task 1.3: 验证 @deprecated 方法数量
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 51-70)
  - 结果: 27 处 ✅ 准确

- [x] Task 1.4: 验证 any 类型数量
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 71-90)
  - 结果: 36 处 ✅ 准确

- [x] Task 1.5: 验证超 800 行文件数量
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 91-150)
  - 结果: 27 个文件 ✅ 准确

### [x] Phase 2: 遗漏项发现

- [x] Task 2.1: 发现额外的超大文件
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 151-200)
  - 发现: 14 个 800-1200 行文件未在计划中

- [x] Task 2.2: 验证 ESLint 禁用注释统计
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 201-220)
  - 发现: 生产代码 4 处（计划声称 31 处，可能包含 spec 文件）

- [x] Task 2.3: 验证 prompt 文件问题数量
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 221-250)
  - 发现: 8 个文件包含 tools: 语法（计划声称 5 个）

- [x] Task 2.4: 验证 injector hack 位置
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 251-280)
  - 结果: 6 处（与计划一致）

### [x] Phase 3: 计划更新建议

- [x] Task 3.1: 补充遗漏的超大文件到拆分计划
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 281-320)
  - 结果: 已将 14 个 800-1200 行文件加入附录 A ✅

- [x] Task 3.2: 更新 prompt 文件数量统计
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 321-340)
  - 结果: 已将 5 个更新为 8 个，工作量从 0.5d 调整为 1d ✅

- [x] Task 3.3: 澄清 ESLint 禁用注释统计口径
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 341-360)
  - 结果: 已澄清为"4处生产代码+27处测试代码" ✅

- [x] Task 3.4: 更新工作量估算（+20% 缓冲）
  - Details: .copilot-tracking/details/20260131-tech-debt-remediation-details.md (Lines 361-400)
  - 结果: 总工作量从 73-97 人天更新为 100-130 人天 ✅

## Dependencies

- grep/find 命令行工具
- VS Code 工作区访问
- 研究文件已创建

## Success Criteria

- [x] 所有定量数据经过实际验证
- [x] 遗漏项被发现并记录
- [x] 计划更新建议已执行
- [x] 研究报告已创建并保存
- [x] 技术债务计划文档已更新
