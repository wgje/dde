---
description: "基于 .copilot-tracking 的任务执行与变更记录规范"
applyTo: ".copilot-tracking/**"
---

# Task Plan Implementation Instructions (NanoFlow)

## 适用范围
- 适用于 `.copilot-tracking/plans/**`、`.copilot-tracking/details/**`、`.copilot-tracking/changes/**`。
- 目标：按计划逐项实现，并持续更新变更记录。

## 必做流程

1. 实施前
- 通读 plan 文件（目标、阶段、清单）。
- 通读 details 文件对应任务段落。
- 通读 changes 文件，确认当前进度与历史偏差。

2. 实施中
- 严格按计划顺序完成任务。
- 每次只处理一个可验证任务单元。
- 代码实现后立即进行本地验证（至少执行对应层级测试）。

3. 每完成一个任务后
- 在 plan 中把对应 `[ ]` 改为 `[x]`。
- 在 changes 中追加到 `Added/Modified/Removed`，写清文件路径和一句话摘要。
- 如与计划有偏差，必须记录“偏差 + 原因 + 影响”。

4. 全部完成后
- 确认所有阶段均为完成状态。
- 在 changes 中补充最终发布摘要（范围、风险、验证结果）。

## 质量门禁
- 不得跳过未完成任务直接标记完成。
- 不得只改计划不改代码，或只改代码不更新追踪文件。
- 任何无法完成项必须显式记录阻塞原因和建议后续动作。
