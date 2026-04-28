---
name: agent-customization
description: 维护 AGENTS、instructions、skills、agents 等聊天定制文件的工作流技能
version: 1.0.0
triggers:
  - "/init"
  - "/create-instruction"
  - "/create-skill"
  - "/create-agent"
---

# Agent Customization Skill

## 目标

只创建或修改聊天定制文件，让 AI coding agents 更快进入正确上下文；不要顺手开始实现业务需求。

## 先读什么

1. [`.github/CUSTOMIZATION_MAP.md`](../../CUSTOMIZATION_MAP.md)
2. [`AGENTS.md`](../../../AGENTS.md)
3. [`.github/copilot-instructions.md`](../../copilot-instructions.md)
4. 与目标最接近的现有 instruction / skill / agent 文件

## 工作流

1. 先盘点现有定制层级，确认“谁权威、谁补充”。
2. 优先更新已有文件；只有现有层级明显不适合时才新建文件。
3. 使用“link, don't embed”：README、`docs/`、`.github/context/`、`.github/learned/` 已有内容时只给入口链接。
4. Hard Rules 只在 [`AGENTS.md`](../../../AGENTS.md) 的 §5 维护；其他文件只能做摘要或指向。
5. 新增 skill 时同步更新 [`skills/skill.md`](../skill.md)；新增 agent 时同步确认其职责不与现有 agent 重叠。

## 选择落点

| 变更类型 | 首选文件 |
|----------|----------|
| 全局执行流程 / 门禁 / Hard Rules | [`AGENTS.md`](../../../AGENTS.md) |
| Copilot 默认行为 / 输出偏好 | [`.github/copilot-instructions.md`](../../copilot-instructions.md) |
| 某类文件的局部规则 | [`.github/instructions/`](../../instructions/) |
| 可复用工作流或领域方法 | [`.github/skills/`](../skill.md) |
| 子代理角色分工 | [`.github/agents/`](../../agents/) |
| 会话恢复或长期经验入口 | [`.github/context/README.md`](../../context/README.md)、[`.github/learned/README.md`](../../learned/README.md) |

## 质量检查

- 是否避免了第二份 Hard Rules？
- 是否复用了现有文档链接，而不是复制长段内容？
- 是否把新增 skill / agent / instruction 的入口索引同步更新？
- 是否只改聊天定制文件，没有越界去改业务实现？