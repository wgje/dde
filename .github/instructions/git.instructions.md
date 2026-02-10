---
description: "Git 提交、分支和 PR 规范"
applyTo: ".git/**,**/.gitignore,.github/**"
---

# Git Workflow Standards (NanoFlow)

## 提交信息
- 使用 Conventional Commits：`type(scope): subject`。
- 常用 type：`feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`chore`。
- `subject` 使用祈使句，描述具体变更，不写空话。

## 分支与合并
- 分支命名：`feature/*`、`fix/*`、`refactor/*`、`docs/*`。
- 小步提交，避免超大混合提交。
- PR 前与 `main` 同步并解决冲突。

## PR 描述最小模板
- 变更内容
- 风险点
- 测试结果
- 回滚方案（如适用）

## 忽略规则
- 必须忽略：`node_modules/`、`dist/`、`.env*`、日志和系统垃圾文件。
- 禁止忽略：锁文件、`.github/`、必要配置文件。
