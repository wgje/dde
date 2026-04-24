# NanoFlow Chat Customization Map

> 用途：为 AI coding agents 和维护者提供一张“先看哪里、哪里权威、哪里只补充”的定制索引。

## 维护原则

- Hard Rules 只在 [AGENTS.md](../AGENTS.md) 的 §5 定义为权威来源。
- 若聊天定制文件之间出现冲突，优先级按 `AGENTS.md -> .github/copilot-instructions.md -> 本文件 -> 其他 instructions / skills / agents` 处理。
- `.github/copilot-instructions.md` 只保留 quick reference，不再复制完整背景。
- `.github/instructions/*.instructions.md` 只写文件类型增量约束，不重复全局规则。
- 新增 skill / agent / instruction 前，先确认现有文件是否能承载目标，避免并行创建第二份权威说明。
- 能链接现有文档时，不把 README 或 `docs/` 的长段说明再嵌入到聊天定制文件。

## 定制层级

| 层级 | 文件 | 作用 | 权威级别 | 何时更新 |
|------|------|------|----------|----------|
| 全局执行手册 | [AGENTS.md](../AGENTS.md) | Agent 生命周期、Hard Rules、架构边界、测试门禁 | 最高 | 全局规则或执行流程变化时 |
| 全局默认指令 | [copilot-instructions.md](copilot-instructions.md) | Copilot 快速约束、默认输出风格、实现偏好 | 次高 | 需要调整默认行为但不改 Hard Rules 时 |
| 定制索引 | [CUSTOMIZATION_MAP.md](CUSTOMIZATION_MAP.md) | 告诉代理“该先看哪里”和“不要重复写哪里” | 索引/导航 | 定制体系新增层级、入口或链接时 |
| 文件类型指令 | [instructions/](instructions/) | 针对 Angular、backend、testing、security 等文件类型补充规则 | 中 | 某一类文件的约束变化时 |
| 专项技能 | [skills/](skills/skill.md) | 把常见工作流或领域知识封装为可复用技能 | 中 | 需要复用一套固定方法时 |
| 专项代理 | [agents/](agents/) | 给不同子代理定义角色边界和交付契约 | 中 | 新增或调整代理职责时 |
| 会话上下文 | [context/README.md](context/README.md) | 当前焦点、阻塞、近期决策的入口 | 运行时上下文 | 任务焦点或阻塞变化时 |
| 已学习模式 | [learned/README.md](learned/README.md) | 记录长期偏好、调试经验、项目惯例 | 经验沉淀 | 有稳定模式值得复用时 |

## 任务入口

### 代码实现 / Bug 修复

1. 先读 [AGENTS.md](../AGENTS.md) 和 [.github/copilot-instructions.md](copilot-instructions.md)。
2. 再读匹配文件类型的 [instructions/](instructions/) 指令。
3. 需要额外工作流时，从 [skills/](skills/skill.md) 选择技能。

### 维护聊天定制文件

1. 先读本文件，再读 [AGENTS.md](../AGENTS.md) 和 [.github/copilot-instructions.md](copilot-instructions.md)。
2. 优先更新已有文件，不并行创建第二份“总入口”或“硬规则”。
3. 若新增 skill / agent，顺手更新 [skills/skill.md](skills/skill.md) 或对应索引。

### 恢复会话背景

1. 先读 [context/README.md](context/README.md)。
2. 再看 `current-focus.md`、`recent-decisions.md`、`blockers.md`。
3. 如需长期偏好或已知坑，补读 [learned/README.md](learned/README.md)。

## 优先链接的现有文档

这些主题已经有现成文档，聊天定制文件里应只给入口，不再重复大段内容：

| 主题 | 优先链接 |
|------|----------|
| 私有部署 / Supabase 初始化 | [docs/deploy-private-instance.md](../docs/deploy-private-instance.md) |
| Android widget 宿主架构 | [docs/android-widget-host-scaffold.md](../docs/android-widget-host-scaffold.md) |
| Android widget 验收清单 | [docs/pwa-android-widget-cross-platform-implementation-checklist.md](../docs/pwa-android-widget-cross-platform-implementation-checklist.md) |
| Focus / Gate / Strata 设计 | [docs/focus-mode-design.md](../docs/focus-mode-design.md) |
| Parking Dock 设计 | [docs/parking-dock-modular-design.md](../docs/parking-dock-modular-design.md) |
| 数据保护 / 回收站 / 备份 | [docs/data-protection-plan.md](../docs/data-protection-plan.md) |
| 语音转写排障 | [docs/transcribe-troubleshooting.md](../docs/transcribe-troubleshooting.md) |

## 新增定制文件前的检查

- 这条规则是否已经能放进现有文件，而不是新建一个并行入口？
- 它是全局 Hard Rule，还是某个文件类型 / 工作流 / 代理的局部约束？
- 现有 README 或 `docs/` 是否已经讲清楚，只需要链接？
- 如果新增的是 skill 或 agent，索引文件是否同步更新？