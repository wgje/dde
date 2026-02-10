---
description: "全局通用编码规则（默认生效）"
applyTo: "**/*"
---

# General Coding Standards (NanoFlow)

## 核心哲学
- 不造轮子，先复用现有实现。
- 最小改动优先，保证可回滚。
- 正确性优先于炫技。

## 硬约束（跨层一致）
- 实体 ID：客户端 `crypto.randomUUID()`。
- 同步：增量拉取 + LWW。
- 离线：本地先写 + 后台同步 + 失败重试。
- 状态：Angular Signals。
- 禁止 `inject(StoreService)`。

## 编码质量
- 中文注释解释业务意图，英文标识符。
- 严格类型，避免 `any`。
- 函数短小、层级可控，避免深层嵌套。
- 修改代码时同步更新相关测试与文档。

## 冲突处理
- 若与 `AGENTS.md` 或 `.github/copilot-instructions.md` 冲突，以后二者为准。
