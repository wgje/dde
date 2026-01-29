# NanoFlow AI 工作流配置完整映射指南

> 本文档完整映射 `everything-claude-code` 工作流体系到 VS Code + GitHub Copilot 环境，专为 NanoFlow 项目定制。
>
> **原始仓库**: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
> **版本**: 2.1（包含 Continuous Learning v2、Strategic Compact、Memory Persistence）

## 目录

1. [概念映射总览](#1-概念映射总览)
2. [VS Code 设置配置](#2-vs-code-设置配置)
3. [规则层 (Instructions)](#3-规则层-instructions)
4. [代理层 (Agents)](#4-代理层-agents)
5. [指令层 (Prompts)](#5-指令层-prompts)
6. [技能层 (Skills)](#6-技能层-skills)
7. [检查点与回滚](#7-检查点与回滚)
8. [MCP 工具扩展](#8-mcp-工具扩展)
9. [Hooks 机制](#9-hooks-机制)
10. [工作流实战](#10-工作流实战)
11. [持续学习系统](#11-持续学习系统)
12. [内存持久化](#12-内存持久化)
13. [Token 优化策略](#13-token-优化策略)
14. [常见问题解答](#14-常见问题解答)

---

## 1. 概念映射总览

### 1.1 核心概念对应表

| everything-claude-code | VS Code + Copilot | 项目位置 | 触发方式 |
|------------------------|-------------------|----------|----------|
| `rules/` | Custom Instructions | `.github/copilot-instructions.md` + `.github/instructions/` | 自动注入 |
| `CLAUDE.md` (user-level) | 用户级 Copilot Instructions | `~/.config/github-copilot/instructions.md` | 全局自动注入 |
| `AGENTS.md` | AGENTS.md | `AGENTS.md` | 自动注入 |
| `agents/` | Custom Agents | `.github/agents/` | `@agent-name` 或下拉框选择 |
| `commands/` | Prompt Files | `.github/prompts/` | `/command` |
| `skills/` | Agent Skills | `.github/skills/` | 被 agent/prompt 引用 |
| `hooks/` | Copilot Hooks + Git Hooks | `.github/hooks/` | coding agent 自动执行 |
| `mcp-configs/` | MCP Servers | `.vscode/mcp.json` | tool picker 或 `#tool` |
| `contexts/` | 动态上下文注入 | `.github/contexts/` | CLI 参数或 Add Context |
| checkpoint | Chat Checkpoints | VS Code 内置 | 历史面板 → Restore |
| `/compact` | 上下文压缩 | VS Code 内置 | 手动或 Strategic Compact |
| `continuous-learning/` | 持续学习技能 | `.github/skills/continuous-learning/` | Stop Hook |
| `strategic-compact/` | 战略压缩技能 | `.github/skills/strategic-compact/` | PreToolUse Hook |
| `memory-persistence/` | 内存持久化 | `.github/hooks/scripts/` | Session Lifecycle Hooks |

### 1.1.1 工具别名关键映射 ⚠️ 重要

**注意**：VS Code Copilot 使用的工具名称与 Claude Code 不同。以下是正确的映射关系：

| VS Code 工具名 | Claude Code 等效 | 用途 |
|----------------|-----------------|------|
| `readFile` | `Read` | 读取文件内容 |
| `editFiles` | `Edit`, `Write` | 编辑现有文件 |
| `createFile` | `Write` | 创建新文件 |
| `textSearch` | `Grep` | 文本/正则搜索 |
| `fileSearch` | `Glob` | 按文件名模式搜索 |
| `codebase` | `semantic_search` | 代码库语义搜索 |
| `runInTerminal` | `Bash` | 终端执行命令 |
| `listDirectory` | `LS` | 目录列表 |
| `changes` | `git diff` | 源代码控制变更 |
| `problems` | `get_errors` | 编译/lint 问题 |
| `usages` | N/A | 引用/定义查找 |
| `runTests` | N/A | 运行单元测试 |
| `testFailure` | N/A | 获取测试失败信息 |
| `fetch` | `WebFetch` | 获取网页内容 |
| `githubRepo` | N/A | GitHub 仓库代码搜索 |
| `mcp-name/*` | MCP 工具 | MCP 服务器工具（如 `supabase/*`） |

### 1.2 everything-claude-code 核心理念

**来自原仓库作者 (@affaanmustafa) 的经验**:

> "Been using Claude Code since the experimental rollout in Feb, and won the Anthropic x Forum Ventures hackathon - completely using Claude Code."

核心原则:
1. **Agent-First**: 使用专门的 agent 处理复杂任务
2. **Parallel Execution**: 独立任务并行执行
3. **Plan Before Execute**: 先规划再实现
4. **Test-Driven**: 先写测试再实现
5. **Security-First**: 安全永不妥协

### 1.2 项目当前配置文件一览

```
.github/
├── copilot-instructions.md          # 全局规则（432 行）
├── instructions/                    # 分域规则（7 个文件）
│   ├── general.instructions.md      # 通用编码标准 → **/*
│   ├── frontend.instructions.md     # Angular 19 规范 → src/**/*.ts,html,css
│   ├── backend.instructions.md      # Supabase 规范 → supabase/**,**/api/**
│   ├── testing.instructions.md      # 测试规范 → **/*.spec.ts,e2e/**
│   ├── security.instructions.md     # 安全规范 → **/auth/**,supabase/**
│   ├── git.instructions.md          # Git 工作流 → .git/**
│   └── docs.instructions.md         # 文档规范 → **/*.md,docs/**
├── agents/                          # 自定义代理（11 个）
│   ├── planner.agent.md             # 规划师
│   ├── architect.agent.md           # 架构师
│   ├── implementation.agent.md      # 实现者
│   ├── tdd-guide.agent.md           # TDD 引导
│   ├── code-reviewer.agent.md       # 代码审查员
│   ├── security-reviewer.agent.md   # 安全专家
│   ├── e2e-runner.agent.md          # E2E 测试专家
│   ├── refactor-cleaner.agent.md    # 重构清理器
│   ├── doc-updater.agent.md         # 文档专家
│   ├── build-error-resolver.agent.md# 构建修复专家
│   └── database-reviewer.agent.md   # 数据库专家
├── prompts/                         # 斜杠命令（13 个）
│   ├── plan.prompt.md               # /plan
│   ├── design.prompt.md             # /design
│   ├── implement.prompt.md          # /implement
│   ├── tdd.prompt.md                # /tdd
│   ├── code-review.prompt.md        # /code-review
│   ├── security.prompt.md           # /security
│   ├── build-fix.prompt.md          # /build-fix
│   ├── e2e.prompt.md                # /e2e
│   ├── refactor-clean.prompt.md     # /refactor-clean
│   ├── docs.prompt.md               # /docs
│   ├── verify.prompt.md             # /verify
│   ├── checkpoint.prompt.md         # /checkpoint
│   └── orchestrate.prompt.md        # /orchestrate
├── skills/                          # 技能包
│   ├── skill.md                     # 技能索引
│   ├── tdd/                         # TDD 技能包
│   │   ├── skill.md
│   │   ├── examples/
│   │   └── scripts/
│   └── docs/                        # 文档技能包
│       └── skill.md
└── hooks/                           # Copilot Hooks

AGENTS.md                            # Agent 协作规则（根目录）

.vscode/
├── settings.json                    # 编辑器和 Copilot 设置
├── mcp.json                         # MCP Server 配置
├── tasks.json                       # 任务定义
└── extensions.json                  # 推荐扩展
```

---

## 2. VS Code 设置配置

### 2.1 当前 settings.json 配置

`.vscode/settings.json` 中的关键设置：

```jsonc
{
  // === Copilot Instructions ===
  // 启用 .github/copilot-instructions.md 和 *.instructions.md
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,

  // === AGENTS.md ===
  // 启用根目录的 AGENTS.md
  "chat.useAgentsMdFile": true,

  // === Chat Checkpoints ===
  // 启用检查点功能，便于回滚
  "chat.checkpoints.enabled": true,
  "chat.checkpoints.showFileChanges": true,

  // === Agent Skills ===
  // 启用技能包功能
  "chat.useAgentSkills": true,

  // === MCP Servers ===
  // 启用 MCP Gallery 和自动启动
  "chat.mcp.gallery.enabled": true,
  "chat.mcp.autostart": "newAndOutdated"
}
```

### 2.2 建议补充的设置

```jsonc
{
  // 启用子目录 AGENTS.md（用于大型单仓库）
  "chat.useNestedAgentsMdFiles": true,

  // 扩展 instructions 文件搜索位置
  "chat.instructionsFilesLocations": [
    ".github/instructions"
  ],

  // 扩展 prompt 文件搜索位置
  "chat.promptFilesLocations": [
    ".github/prompts"
  ]
}
```

### 2.3 版本要求

| 功能 | VS Code 最低版本 | 说明 |
|------|------------------|------|
| Custom Instructions | 1.96+ | instructions 文件 |
| Chat Checkpoints | 1.103+ | 检查点回滚 |
| Custom Agents | 1.106+ | .agent.md 文件 |
| Agent Skills | 1.107+ | SKILL.md 文件 |
| MCP Servers | 1.102+ | mcp.json 配置 |

---

## 3. 规则层 (Instructions)

### 3.1 规则层级结构

```
优先级（高→低）:
┌─────────────────────────────────────────┐
│ copilot-instructions.md（全局宪法）      │
├─────────────────────────────────────────┤
│ AGENTS.md（Agent 协作流程）              │
├─────────────────────────────────────────┤
│ instructions/*.instructions.md          │
│ （分域规则，按 applyTo 匹配）            │
└─────────────────────────────────────────┘
```

### 3.2 copilot-instructions.md vs AGENTS.md

| 维度 | copilot-instructions.md | AGENTS.md |
|------|-------------------------|-----------|
| 定位 | 项目技术规范和约束 | Agent 协作规则和流程 |
| 内容 | 技术栈、架构、编码规范 | Agent 列表、触发方式、工作流规则 |
| 应用 | 自动注入所有 chat | 自动注入所有 chat |
| 适合 | 编码标准、禁止规则 | 多 Agent 协调、handoffs 规则 |

### 3.3 instructions 文件 applyTo 规则

每个 `.instructions.md` 文件使用 YAML frontmatter 的 `applyTo` 字段定义生效范围：

| 文件 | applyTo | 说明 |
|------|---------|------|
| `general.instructions.md` | `**/*` | 全部文件 |
| `frontend.instructions.md` | `src/**/*.ts,src/**/*.html,src/**/*.css` | 前端代码 |
| `backend.instructions.md` | `supabase/**,**/api/**,**/functions/**` | 后端代码 |
| `testing.instructions.md` | `**/*.spec.ts,**/*.test.ts,e2e/**` | 测试文件 |
| `security.instructions.md` | `**/auth/**,**/api/**,supabase/**,**/*.env*` | 安全相关 |
| `git.instructions.md` | `.git/**,**/.gitignore` | Git 相关 |
| `docs.instructions.md` | `**/*.md,docs/**` | 文档文件 |

**关键规则**：
- 没有 `applyTo` 的文件**不会自动应用**
- instructions 主要在**创建/修改文件**时应用
- 可通过 Add Context → Instructions 手动附加

---

## 4. 代理层 (Agents)

### 4.1 Agent 架构图

```
                    ┌─────────────┐
                    │  @planner   │ 规划/拆解
                    └──────┬──────┘
                           │ handoff
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌────────────────┐ ┌──────────────┐ ┌────────────────┐
│  @architect    │ │  @tdd-guide  │ │  @doc-updater  │
│   架构设计      │ │   TDD 引导    │ │   文档更新      │
└───────┬────────┘ └──────┬───────┘ └────────────────┘
        │                 │
        ▼                 ▼
┌────────────────────────────────────┐
│         @implementation            │
│          功能实现                    │
└───────────────┬────────────────────┘
                │ handoff
    ┌───────────┼───────────┬───────────┐
    ▼           ▼           ▼           ▼
┌────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│@code-  │ │@security-│ │@refactor-│ │@e2e-     │
│reviewer│ │reviewer  │ │cleaner   │ │runner    │
└────────┘ └──────────┘ └──────────┘ └──────────┘
```

### 4.2 Agent 职责与 Handoffs

#### @planner - 规划师

**职责**：需求分析、方案设计、任务拆分

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 设计架构 | @architect | 需要架构方案 |
| 开始 TDD | @tdd-guide | 直接 TDD 实现 |
| 更新文档 | @doc-updater | 补充文档 |
| 开始实现 | @implementation | 按计划编码 |

#### @architect - 架构师

**职责**：系统设计、技术决策、接口定义

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 生成失败测试 | @tdd-guide | 先写测试 |
| 实现设计 | @implementation | 编码实现 |
| 安全审查设计 | @security-reviewer | 威胁建模 |

#### @implementation - 实现者

**职责**：按计划编码、TDD 实现、小步提交

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 代码审查 | @code-reviewer | 质量审查 |
| 安全审查 | @security-reviewer | 安全检查 |
| 重构/清理 | @refactor-cleaner | 结构优化 |
| 运行 E2E | @e2e-runner | 端到端验证 |
| 更新文档 | @doc-updater | 同步文档 |

#### @tdd-guide - TDD 引导

**职责**：先写失败测试、最小实现、重构

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 让测试通过 | @implementation | 实现代码 |
| 审查测试 | @code-reviewer | 审查测试质量 |
| 添加 E2E 覆盖 | @e2e-runner | 端到端测试 |

#### @code-reviewer - 代码审查员

**职责**：代码质量、安全检查、可维护性

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 应用重构 | @refactor-cleaner | 落实建议 |
| 安全审查 | @security-reviewer | 深度安全检查 |
| 更新文档 | @doc-updater | 同步文档 |

#### @security-reviewer - 安全专家

**职责**：漏洞检测、OWASP Top 10、密钥扫描

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 修复安全问题 | @implementation | 实施修复 |
| 安全重构 | @refactor-cleaner | 结构性安全优化 |
| 添加安全回归 E2E | @e2e-runner | 安全回归测试 |

#### @refactor-cleaner - 重构清理器

**职责**：死代码清理、重复消除、依赖清理

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 再次审查 | @code-reviewer | 确认重构正确 |
| 回归 E2E | @e2e-runner | 验证无回归 |
| 同步文档 | @doc-updater | 更新文档 |

#### @e2e-runner - E2E 测试专家

**职责**：Playwright 测试、用户旅程、失败排查

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 修复失败 | @implementation | 修复失败用例 |
| 审查测试策略 | @code-reviewer | 优化测试结构 |

#### @doc-updater - 文档专家

**职责**：README、代码地图、API 文档

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 审查文档 | @code-reviewer | 准确性审查 |
| 规划下一步 | @planner | 发现待办事项 |

#### @build-error-resolver - 构建修复专家

**职责**：TypeScript 错误、构建失败、最小修复

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 代码审查 | @code-reviewer | 审查修复 |
| 运行测试 | @e2e-runner | 回归验证 |

#### @database-reviewer - 数据库专家

**职责**：查询优化、模式设计、RLS 策略

**Handoffs**：
| 按钮标签 | 目标 Agent | 场景 |
|----------|-----------|------|
| 应用迁移 | @implementation | 执行迁移 |
| 安全审查 | @security-reviewer | RLS 审查 |
| 更新文档 | @doc-updater | 模式文档 |

### 4.3 如何使用 Agents

**方式 1：下拉框选择**
1. 打开 Chat 面板
2. 点击 Agent 下拉框
3. 选择自定义 Agent

**方式 2：@ 提及**
```
@planner 帮我规划用户认证功能
@tdd-guide 为 TaskService.create 编写测试
```

**方式 3：通过 Handoff 按钮**
- Agent 响应后，点击底部的 handoff 按钮
- 自动切换 Agent 并预填 prompt

---

## 5. 指令层 (Prompts)

### 5.1 可用命令一览

| 命令 | 描述 | 关联 Agent |
|------|------|-----------|
| `/plan` | 需求澄清 + 任务拆分 | @planner |
| `/design` | 系统设计和架构决策 | @architect |
| `/implement` | 按计划实现功能 | @implementation |
| `/tdd` | 严格 TDD 循环 | @tdd-guide |
| `/code-review` | 代码质量审查 | @code-reviewer |
| `/security` | 安全漏洞审计 | @security-reviewer |
| `/build-fix` | 修复构建错误 | @build-error-resolver |
| `/e2e` | E2E 测试生成和运行 | @e2e-runner |
| `/refactor-clean` | 死代码清理 | @refactor-cleaner |
| `/docs` | 文档更新 | @doc-updater |
| `/verify` | 完整验证循环 | agent (默认) |
| `/checkpoint` | 保存检查点 | agent (默认) |
| `/orchestrate` | 多 Agent 编排 | agent (默认) |

### 5.2 Prompt 文件格式

```markdown
---
name: command-name          # 触发命令（不含 /）
description: 命令描述        # 显示在命令列表
argument-hint: "参数提示"    # 输入提示
agent: "agent-name"         # 关联的 Agent
tools: ["tool1", "tool2"]   # 可选：限制工具
---

Prompt 正文...

${input:varName:提示文本}    # 输入变量
```

### 5.3 Prompt 与 Agent 的关系

```
Prompt                Agent              职责分离
┌─────────┐         ┌─────────┐
│ /plan   │ ──────► │ @planner│         Prompt = 任务脚本
└─────────┘         └─────────┘         Agent = 角色人格
     │
     │ 指定 agent:
     ▼
Prompt 定义：        Agent 定义：
- 任务流程          - 角色描述
- 输出格式          - tools 权限
- 参数变量          - handoffs 链接
```

**工具优先级**：
1. Prompt 指定的 tools（最高）
2. Agent 指定的 tools
3. 默认 tools（最低）

---

## 6. 技能层 (Skills)

### 6.1 Skills 与 Instructions 的区别

| 维度 | Skills | Instructions |
|------|--------|--------------|
| 定位 | 可复用工作流程 + 资源 | 编码规范约束 |
| 结构 | 文件夹 + SKILL.md + 资源 | 单个 .instructions.md |
| 内容 | 步骤、脚本、示例、模板 | 规则、约束、禁止事项 |
| 加载 | 按需（被引用时） | 自动（按 applyTo） |
| 适合 | TDD 流程、发布流程 | 命名规范、安全规则 |

### 6.2 当前 Skills 结构

```
.github/skills/
├── skill.md           # 技能索引
├── tdd/               # TDD 技能包
│   ├── skill.md       # 技能定义
│   ├── examples/      # 示例代码
│   └── scripts/       # 自动化脚本
└── docs/              # 文档技能包
    └── skill.md
```

### 6.3 Skill 文件格式

```markdown
---
name: skill-name
description: 技能描述
triggers:
  - "@agent-name"
  - "/command"
---

# Skill Name

## 概述
[技能描述]

## 使用方法
[如何触发]

## 流程
[详细步骤]

## 示例
[代码示例]
```

### 6.4 如何引用 Skills

**在 Agent 中引用**：
```markdown
# agent.md 正文

请遵循 [TDD Skill](../skills/tdd/skill.md) 的步骤。
```

**在 Prompt 中引用**：
```markdown
# prompt.md 正文

按照 [TDD 流程](../skills/tdd/skill.md) 执行。
```

---

## 7. 检查点与回滚

### 7.1 VS Code Chat Checkpoints

**启用**：
```jsonc
{
  "chat.checkpoints.enabled": true,
  "chat.checkpoints.showFileChanges": true
}
```

**使用**：
1. VS Code 自动在关键交互点创建检查点
2. 在 Chat 历史找到要恢复的请求
3. 悬停并点击 **Restore Checkpoint**
4. 确认恢复

### 7.2 Git 检查点

**创建检查点**：
```bash
git add .
git commit -m "checkpoint: 完成用户认证模块"
```

**恢复检查点**：
```bash
# 查看检查点
git log --oneline | grep checkpoint

# 软恢复（保留工作区）
git revert HEAD --no-commit

# 硬恢复（丢失之后更改）
git reset --hard <checkpoint-hash>
```

### 7.3 `/checkpoint` 命令

使用 `/checkpoint` 快速创建检查点：
```
/checkpoint "完成专注模式大门组件"
```

---

## 8. MCP 工具扩展

### 8.1 当前 MCP 配置

`.vscode/mcp.json`：

```jsonc
{
  "servers": {
    // Chrome DevTools MCP - 浏览器调试
    "io.github.ChromeDevTools/chrome-devtools-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--headless=true",
        "--no-sandbox"
      ]
    },
    
    // Supabase MCP - 数据库操作
    "com.supabase/mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@supabase/mcp-server-supabase@0.5.9"
      ],
      "env": {
        "SUPABASE_URL": "https://${input:project-ref}.supabase.co",
        "SUPABASE_ACCESS_TOKEN": "${input:SUPABASE_ACCESS_TOKEN}"
      }
    }
  },
  "inputs": [
    {
      "id": "project-ref",
      "type": "promptString",
      "description": "Supabase project reference ID",
      "password": false
    },
    {
      "id": "SUPABASE_ACCESS_TOKEN",
      "type": "promptString",
      "description": "Personal access token",
      "password": true
    }
  ]
}
```

### 8.2 MCP 选择策略

#### ✅ 推荐添加

| MCP Server | 用途 | 适用场景 |
|------------|------|----------|
| Chrome DevTools | 浏览器调试 | E2E 测试、性能分析 |
| Supabase | 数据库操作 | 查询、迁移、RLS |
| GitHub | PR/Issue 操作 | 代码审查、项目管理 |
| Playwright | 浏览器自动化 | E2E 测试 |

#### ⚠️ 按需添加

| MCP Server | 用途 | 添加条件 |
|------------|------|----------|
| Filesystem | 文件操作 | VS Code 内置通常足够 |
| Git | Git 操作 | Source Control 通常足够 |

#### ❌ 不建议添加

- 重复 VS Code 内置功能的 MCP
- 来源不可信的 MCP

### 8.3 MCP 使用方式

**Tool Picker**：
- 在 Chat 中点击工具图标
- 选择要启用的 MCP 工具

**显式调用**：
```
#supabase 查询 tasks 表的所有记录
```

**Agent 配置**：
```yaml
# agent.md frontmatter
tools: ["supabase/*", "github/*"]
```

---

## 9. Hooks 机制

### 9.1 everything-claude-code Hook 类型

everything-claude-code 定义了完整的 hooks 系统：

| Hook 类型 | 触发时机 | 典型用途 |
|-----------|----------|----------|
| `PreToolUse` | 工具执行前 | 验证、参数修改、提醒 |
| `PostToolUse` | 工具执行后 | 自动格式化、检查、反馈 |
| `UserPromptSubmit` | 用户发送消息时 | 预处理、扩展 |
| `Stop` | Claude 完成响应 | 最终验证、保存 |
| `PreCompact` | 上下文压缩前 | 保存关键信息 |
| `Notification` | 权限请求时 | 自定义批准逻辑 |
| `SessionStart` | 会话开始 | 恢复上下文 |

**示例配置**（~/.claude/settings.json）：
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "tool == \"Bash\" && tool_input.command matches \"(npm|pnpm|yarn)\"",
      "hooks": [{
        "type": "command",
        "command": "if [ -z \"$TMUX\" ]; then echo '[Hook] Consider tmux' >&2; fi"
      }]
    }],
    "PostToolUse": [{
      "matcher": "tool == \"Edit\" && tool_input.file_path matches \"\\.ts$\"",
      "hooks": [{
        "type": "command",
        "command": "npx prettier --write ${tool_input.file_path}"
      }]
    }],
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/scripts/final-check.sh"
      }]
    }]
  }
}
```

### 9.2 GitHub Copilot Coding Agent Hooks

**重要**：Copilot Hooks **不是** VS Code Chat 的自动钩子，它们只对 **Copilot coding agent**（#github-pull-request_copilot-coding-agent）和 **Copilot CLI** 生效。

**配置位置**：`.github/hooks/hooks.json`

**官方 Schema**：https://json.schemastore.org/github-copilot-hooks.json

**当前支持的触发点（Events）**：
| 事件 | 触发时机 | 典型用途 |
|------|----------|----------|
| `sessionStart` | 会话开始 | 恢复上下文、通知 |
| `sessionEnd` | 会话结束 | 保存状态、清理 |
| `preToolUse` | 工具调用前 | 安全检查、阻止危险命令 |
| `postToolUse` | 工具调用后 | 审计日志、格式化 |
| `errorOccurred` | 错误发生 | 错误日志、通知 |

**当前项目配置**（.github/hooks/hooks.json）：
```json
{
  "$schema": "https://json.schemastore.org/github-copilot-hooks.json",
  "version": 1,
  "description": "NanoFlow Copilot Hooks - 映射自 everything-claude-code",
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "echo '🚀 NanoFlow session started'",
        "timeoutSec": 5
      },
      {
        "type": "command",
        "bash": "cat .github/context/current-focus.md 2>/dev/null || echo 'No context'",
        "comment": "恢复上次会话上下文"
      }
    ],
    "preToolUse": [
      {
        "type": "command",
        "bash": ".github/hooks/scripts/pre-tool-check.sh",
        "powershell": ".github/hooks/scripts/pre-tool-check.ps1",
        "comment": "安全检查（阻止 rm -rf、DROP DATABASE 等危险命令）",
        "timeoutSec": 10
      }
    ],
    "postToolUse": [
      {
        "type": "command",
        "bash": "echo \"[$(date)] Tool: ${TOOL_NAME}\" >> .github/hooks/logs/audit.log",
        "comment": "审计日志"
      }
    ],
    "errorOccurred": [
      {
        "type": "command",
        "bash": "echo '❌ Error: ${ERROR_MESSAGE}' >> .github/hooks/logs/errors.log"
      }
    ]
  }
}
```

**关键特性**：
- `type: "command"` - 执行 shell 命令
- `bash` / `powershell` - 跨平台支持
- `timeoutSec` - 超时设置（可选）
- `comment` - 注释说明（可选）
- **输出 `{"permissionDecision": "deny"}`** 可阻止工具执行

### 9.3 Hooks 映射对照表

| everything-claude-code | GitHub Copilot Hooks | 支持状态 |
|------------------------|----------------------|----------|
| `PreToolUse` | `preToolUse` | ✅ 完全支持 |
| `PostToolUse` | `postToolUse` | ✅ 完全支持 |
| `SessionStart` | `sessionStart` | ✅ 完全支持 |
| `Stop` / `SessionEnd` | `sessionEnd` | ✅ 完全支持 |
| `Notification` (error) | `errorOccurred` | ✅ 完全支持 |
| `UserPromptSubmit` | 无直接等价物 | ❌ 不支持 |
| `PreCompact` | 无直接等价物 | ❌ 不支持 |

**注意事项**：
- Copilot Hooks 仅对 **Coding Agent** 和 **CLI** 生效
- VS Code Chat（@workspace、Copilot Chat）**不触发** hooks
- 使用 `{"permissionDecision": "deny"}` JSON 输出可阻止工具执行

### 9.4 Git Hooks（推荐替代）

对于 VS Code Chat 场景，使用 Git Hooks 更可靠：

**安装 Husky**：
```bash
npm install -D husky lint-staged
npx husky init
```

**pre-commit hook**：
```bash
# .husky/pre-commit
npm run lint
npm run test:run
```

**commit-msg hook**：
```bash
# .husky/commit-msg
# 验证 commit message 格式
npx commitlint --edit $1
```

**pre-push hook**：
```bash
# .husky/pre-push
npm run build
npm run test:e2e
```

### 9.5 VS Code Tasks

`.vscode/tasks.json` 定义构建/测试任务，可被 Copilot 调用：

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "lint",
      "type": "shell",
      "command": "npm run lint"
    },
    {
      "label": "test",
      "type": "shell",
      "command": "npm run test:run"
    },
    {
      "label": "build",
      "type": "shell",
      "command": "npm run build"
    },
    {
      "label": "format",
      "type": "shell",
      "command": "npx prettier --write ."
    }
  ]
}
```

### 9.6 完整 Hooks 工作流示例

**everything-claude-code 工作流**：
```
1. UserPromptSubmit → 扩展/预处理提示
2. PreToolUse (Bash) → tmux 提醒
3. PreToolUse (Edit) → 记录观察
4. PostToolUse (Edit) → 自动格式化
5. Stop → 最终验证 + 会话摘要
```

**VS Code 等效工作流**：
```
1. 使用 prompt template 预处理
2. 依赖 Copilot 内置检查
3. 使用 onSave formatOnSave 设置
4. 使用 Git pre-commit hook 验证
5. 手动使用 /session-summary
```

---

## 10. 工作流实战

### 10.1 功能开发工作流

```
1. /plan "实现黑匣子语音转写功能"
   └─► @planner 输出实现计划

2. [点击 Handoff: 设计架构]
   └─► @architect 设计 Edge Function + 前端架构

3. [点击 Handoff: 开始 TDD]
   └─► @tdd-guide 先写测试

4. [点击 Handoff: 让测试通过]
   └─► @implementation 实现代码

5. [点击 Handoff: 代码审查]
   └─► @code-reviewer 审查

6. [点击 Handoff: 安全审查]
   └─► @security-reviewer 安全检查

7. /verify
   └─► 完整验证循环
```

### 10.2 Bug 修复工作流

```
1. @tdd-guide 先写复现 bug 的测试

2. [点击 Handoff: 让测试通过]
   └─► @implementation 最小修复

3. [点击 Handoff: 代码审查]
   └─► @code-reviewer 确认修复

4. /verify
```

### 10.3 重构工作流

```
1. /refactor-clean "清理 Flow 组件死代码"
   └─► @refactor-cleaner 分析并安全删除

2. [点击 Handoff: 回归 E2E]
   └─► @e2e-runner 验证无回归

3. [点击 Handoff: 再次审查]
   └─► @code-reviewer 最终审查
```

### 10.4 安全审计工作流

```
1. /security "审查认证模块"
   └─► @security-reviewer 全面审计

2. [点击 Handoff: 修复安全问题]
   └─► @implementation 实施修复

3. [点击 Handoff: 添加安全回归 E2E]
   └─► @e2e-runner 安全回归测试
```

### 10.5 多 Agent 编排

```
/orchestrate feature "添加用户认证"

执行链：
planner → tdd-guide → code-reviewer → security-reviewer
```

---

## 11. 持续学习系统

### 11.1 概述

everything-claude-code 提供了两个版本的持续学习系统，帮助 AI 从会话中学习用户模式。

| 特性 | v1 (Stop Hook) | v2 (Instinct-Based) |
|------|----------------|---------------------|
| 观察方式 | Stop hook（会话结束时） | PreToolUse/PostToolUse hooks（100% 可靠） |
| 分析方式 | 主上下文中分析 | 后台 agent（Haiku 模型，成本低） |
| 学习粒度 | 完整技能 | 原子化 "instincts" |
| 置信度 | 无 | 0.3-0.9 加权 |
| 进化路径 | 直接生成技能 | instincts → 聚类 → skill/command/agent |
| 分享能力 | 无 | 导出/导入 instincts |

### 11.2 v1：Stop Hook 学习

在会话结束时分析整个会话，提取可复用模式。

**配置**：
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/skills/continuous-learning/evaluate-session.sh"
      }]
    }]
  }
}
```

**模式检测类型**：

| 模式 | 说明 |
|------|------|
| `error_resolution` | 如何解决特定错误 |
| `user_corrections` | 用户纠正后形成的模式 |
| `workarounds` | 框架/库怪癖的解决方案 |
| `debugging_techniques` | 有效的调试方法 |
| `project_specific` | 项目特定约定 |

### 11.3 v2：Instinct-Based 学习

基于 "instinct"（直觉/本能）的学习系统，更精细且可持续进化。

**Instinct 模型**：
```yaml
---
id: prefer-functional-style
trigger: "when writing new functions"
confidence: 0.7
domain: "code-style"
source: "session-observation"
---

# Prefer Functional Style

## Action
Use functional patterns over classes when appropriate.

## Evidence
- Observed 5 instances of functional pattern preference
- User corrected class-based approach to functional on 2025-01-15
```

**置信度进化**：

| 分数 | 含义 | 行为 |
|------|------|------|
| 0.3 | 试探性 | 建议但不强制 |
| 0.5 | 中等 | 相关时应用 |
| 0.7 | 强 | 自动批准应用 |
| 0.9 | 近乎确定 | 核心行为 |

**置信度增加**条件：
- 模式重复被观察到
- 用户未纠正建议的行为
- 来自其他来源的相似 instincts 验证

**置信度降低**条件：
- 用户明确纠正行为
- 长时间未观察到该模式
- 出现矛盾证据

### 11.4 VS Code 适配

由于 VS Code Copilot 不支持 Claude Code 的 hooks 系统，我们采用替代方案：

**适配策略**：

| everything-claude-code | VS Code 替代方案 | 实现位置 |
|------------------------|------------------|----------|
| PreToolUse/PostToolUse | Git pre-commit hooks | `.husky/pre-commit` |
| Stop hook | 会话总结 prompt | `.github/prompts/session-summary.prompt.md` |
| 后台 Observer agent | 手动触发审查 | `/analyze-patterns` prompt |
| Instinct 存储 | 项目级知识库 | `.github/learned/` |

**创建 VS Code 学习工作流**：

1. **会话结束总结**：
```yaml
# .github/prompts/session-summary.prompt.md
---
name: session-summary
description: 总结本次会话学到的模式
---

请分析本次会话中的模式，提取：
1. 用户的代码风格偏好
2. 解决的错误及方法
3. 重复使用的工作流

输出到 .github/learned/patterns.md
```

2. **模式应用 skill**：
```yaml
# .github/skills/learned-patterns/skill.md
---
name: learned-patterns
description: 应用项目学习到的模式
triggers:
  - "@code-reviewer"
  - "@implementation"
---

参考 `.github/learned/patterns.md` 中的模式...
```

### 11.5 相关命令

| 原始命令 | VS Code 映射 | 说明 |
|----------|--------------|------|
| `/instinct-status` | `/patterns` | 显示学到的模式 |
| `/evolve` | `/evolve-patterns` | 聚类 instincts 生成技能 |
| `/instinct-export` | Git push patterns | 导出模式 |
| `/instinct-import <file>` | Git pull patterns | 导入模式 |

---

## 12. 内存持久化

### 12.1 概述

everything-claude-code 通过 session lifecycle hooks 实现内存持久化，让 AI 在会话间保持上下文。

### 12.2 Session Lifecycle Hooks

```
SessionStart → PreCompact → ... → Stop
     │              │               │
     │              │               └── 保存会话摘要
     │              └── 压缩前保存关键信息
     └── 恢复上次会话上下文
```

**Hook 类型**：

| Hook | 触发时机 | 用途 |
|------|----------|------|
| `SessionStart` | 会话开始 | 加载上次会话的关键上下文 |
| `PreCompact` | 上下文压缩前 | 保存即将丢失的重要信息 |
| `Stop` | 会话结束 | 保存完整会话摘要 |

### 12.3 上下文管理策略

**1. SessionStart：恢复上下文**
```bash
# 恢复上次会话的关键信息
cat ~/.claude/session-memory/last-context.md
```

**2. PreCompact：保存关键信息**
```json
{
  "hooks": {
    "PreCompact": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/scripts/save-context.sh"
      }]
    }]
  }
}
```

**3. Stop：保存摘要**
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command", 
        "command": "~/.claude/scripts/summarize-session.sh"
      }]
    }]
  }
}
```

### 12.4 VS Code 适配

**替代方案**：

| everything-claude-code | VS Code 替代方案 |
|------------------------|------------------|
| SessionStart hook | workspace 打开时加载 `.github/context/` |
| PreCompact hook | 手动使用 `/checkpoint` 保存 |
| Stop hook | 会话结束前使用 `/session-summary` |

**实现方式**：

1. **使用 Chat Checkpoints**：
   - VS Code 内置检查点功能
   - 每次重要操作后自动保存
   - 可随时恢复到任意检查点

2. **项目上下文文件**：
```
.github/
├── context/
│   ├── current-focus.md     # 当前工作焦点
│   ├── recent-decisions.md  # 近期决策
│   └── blockers.md          # 阻塞问题
```

3. **创建恢复 Prompt**：
```yaml
# .github/prompts/resume.prompt.md
---
name: resume
description: 恢复上次工作上下文
---

请阅读以下文件恢复上下文：
- .github/context/current-focus.md
- .github/context/recent-decisions.md

继续上次的工作...
```

---

## 13. Token 优化策略

### 13.1 Strategic Compact

everything-claude-code 的战略压缩技能，帮助在正确时机压缩上下文。

**核心理念**：
- 自动压缩发生在任意点，往往是任务中途
- 战略压缩在逻辑阶段切换时进行，保留必要上下文

**配置**：
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "tool == \"Edit\" || tool == \"Write\"",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/skills/strategic-compact/suggest-compact.sh"
      }]
    }]
  }
}
```

**最佳实践**：

| 时机 | 建议 |
|------|------|
| 规划完成后 | ✅ 压缩，开始全新实现 |
| 调试完成后 | ✅ 清除错误解决上下文 |
| 实现中途 | ❌ 不压缩，保留相关变更上下文 |
| 重大里程碑完成 | ✅ 压缩，准备下一阶段 |

### 13.2 模型选择策略

everything-claude-code 建议根据任务类型选择模型：

| 任务类型 | 推荐模型 | 原因 |
|----------|----------|------|
| 复杂编码/架构 | Opus | 最强推理能力 |
| 常规编码 | Sonnet | 性价比最优 |
| 后台观察/分析 | Haiku | 成本低，延迟低 |
| 代码审查 | Sonnet | 足够的分析能力 |
| 快速原型 | Haiku | 快速迭代 |

**VS Code Copilot 模型选择**：
- 默认使用 Claude 3.5 Sonnet / GPT-4
- 复杂任务可在 Chat 中选择不同模型
- Agent 模式自动使用更强模型

### 13.3 Subagent 架构

使用较小模型处理子任务，节省 token 同时保持质量：

```
Main Agent (Opus/Sonnet)
    ├── Research Subagent (Haiku) → 搜索文档
    ├── Validator Subagent (Haiku) → 验证语法
    └── Observer Agent (Haiku) → 后台分析
```

**VS Code 实现**：
```yaml
# .github/agents/research.agent.md
---
name: research
description: 快速搜索和研究（低成本）
model: claude-3-haiku  # 指定模型（如果支持）
---

专注于快速搜索和信息收集...
```

### 13.4 mgrep 模式

高效的上下文收集策略：

```bash
# 避免读取整个文件
# 使用 grep 定位后再精确读取
grep -n "functionName" **/*.ts
read_file specific_file.ts lines 100-150
```

**VS Code 最佳实践**：
1. 先使用语义搜索定位
2. 精确读取目标区域
3. 避免读取整个大文件

### 13.5 上下文压缩时机

**建议压缩时机**：
- 50+ 工具调用后
- 阶段切换时（探索 → 实现）
- 明确的里程碑完成
- 错误调试完成

**VS Code Chat 压缩**：
- 开始新的 Chat 会话
- 使用 `/new` 创建新对话
- 关键信息通过 `/checkpoint` 保存

---

## 14. 常见问题解答

### Q1: Instructions 文件没有生效？

**检查清单**：
- [ ] `github.copilot.chat.codeGeneration.useInstructionFiles` 设为 `true`
- [ ] 文件扩展名是 `.instructions.md`
- [ ] 文件在 `.github/instructions/` 目录
- [ ] YAML frontmatter 中有 `applyTo` 字段
- [ ] VS Code 版本 >= 1.96

### Q2: Agent 看不到自定义 Agent？

**检查清单**：
- [ ] 文件扩展名是 `.agent.md`
- [ ] 文件在 `.github/agents/` 目录
- [ ] VS Code 版本 >= 1.106
- [ ] YAML frontmatter 有 `name` 字段

### Q3: Handoff 按钮没出现？

**检查清单**：
- [ ] Agent 文件有 `handoffs` 配置
- [ ] Agent 响应已完成（不是流式中）
- [ ] handoffs 格式正确：label, agent, prompt

### Q4: MCP 工具无法使用？

**检查清单**：
- [ ] `chat.mcp.gallery.enabled` 设为 `true`
- [ ] mcp.json 语法正确（无尾随逗号）
- [ ] 首次使用时点击 Trust 信任 MCP
- [ ] 输入变量（如 API key）已正确填写

### Q5: Skills 没有加载？

**检查清单**：
- [ ] `chat.useAgentSkills` 设为 `true`
- [ ] 技能文件名是 `skill.md`（小写）
- [ ] 技能文件夹在 `.github/skills/` 下
- [ ] 在 Agent/Prompt 中正确引用了技能

### Q6: AGENTS.md 没生效？

**检查清单**：
- [ ] `chat.useAgentsMdFile` 设为 `true`
- [ ] AGENTS.md 在工作区根目录
- [ ] 文件名大小写正确

### Q7: 如何回滚到之前状态？

**方式 1：Chat Checkpoints**
1. 在 Chat 历史找到请求
2. 点击 Restore Checkpoint

**方式 2：Git**
```bash
git log --oneline | grep checkpoint
git reset --hard <hash>
```

### Q8: Agent 和 Prompt 该用哪个？

| 场景 | 使用 |
|------|------|
| 快速执行标准任务 | `/command` Prompt |
| 需要特定角色人格 | `@agent` |
| 复杂多步工作流 | Agent + Handoffs |
| 一次性任务脚本 | Prompt |

### Q9: 如何实现 everything-claude-code 的持续学习？

**替代方案**：
1. 使用 `/session-summary` prompt 在会话结束时总结模式
2. 将学习到的模式保存到 `.github/learned/` 目录
3. 在 Agent/Skill 中引用 learned 目录

### Q10: VS Code 没有 PreToolUse/PostToolUse 怎么办？

**替代方案**：
1. **PreToolUse**: 使用 Git pre-commit hooks + lint-staged
2. **PostToolUse**: 使用 VS Code formatOnSave + ESLint autofix
3. **Stop**: 手动使用 `/session-summary` 或 `/checkpoint`

### Q11: 如何处理上下文过长？

**策略**：
1. 开始新的 Chat 会话
2. 使用 `/checkpoint` 保存关键信息
3. 在新对话中引用 `.github/context/` 中的文件
4. 遵循战略压缩时机建议

### Q12: everything-claude-code 的 instinct 在 VS Code 怎么实现？

**映射方案**：
```
Instinct 文件 → .github/learned/*.md
置信度评分 → 高/中/低 文本标注
/instinct-status → 直接查看 .github/learned/
/evolve → 手动整理为 skill 文件
```

---

## 附录 A：配置文件快速参考

### 设置项速查

```jsonc
// .vscode/settings.json
{
  // Instructions
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "chat.instructionsFilesLocations": [".github/instructions"],
  
  // AGENTS.md
  "chat.useAgentsMdFile": true,
  "chat.useNestedAgentsMdFiles": true,
  
  // Checkpoints
  "chat.checkpoints.enabled": true,
  "chat.checkpoints.showFileChanges": true,
  
  // Skills
  "chat.useAgentSkills": true,
  
  // Prompts
  "chat.promptFilesLocations": [".github/prompts"],
  
  // MCP
  "chat.mcp.gallery.enabled": true,
  "chat.mcp.autostart": "newAndOutdated"
}
```

### 文件格式速查

**Agent**: `.github/agents/name.agent.md`
```yaml
---
name: agent-name
description: 描述
tools: ["tool1", "tool2"]
handoffs:
  - label: 按钮文本
    agent: target-agent
    prompt: 传递的提示
    send: false
---
正文...
```

**Prompt**: `.github/prompts/name.prompt.md`
```yaml
---
name: command-name
description: 描述
argument-hint: "参数提示"
agent: "agent-name"
---
正文...
${input:varName:提示}
```

**Instructions**: `.github/instructions/name.instructions.md`
```yaml
---
applyTo: "glob/pattern/**"
---
规则正文...
```

**Skill**: `.github/skills/name/skill.md`
```yaml
---
name: skill-name
description: 描述
triggers:
  - "@agent"
  - "/command"
---
技能内容...
```

---

## 附录 B：NanoFlow 项目专用配置

### 项目特定规则

本项目遵循以下核心规则（详见 `copilot-instructions.md` 和 `AGENTS.md`）：

1. **ID 策略**：所有实体使用 `crypto.randomUUID()` 客户端生成
2. **Offline-first**：IndexedDB 优先，后台增量同步
3. **LWW 冲突解决**：Last-Write-Wins 策略
4. **树遍历**：迭代算法 + `MAX_SUBTREE_DEPTH: 100`

### 技术栈

| 技术 | 用途 |
|------|------|
| Angular 19.x | Signals + 独立组件 + OnPush |
| Supabase | 认证 + PostgreSQL + Storage + Edge Functions |
| GoJS | 流程图渲染 |
| Groq | whisper-large-v3 语音转写 |
| Vitest / Playwright | 单元 / E2E 测试 |

### 常用命令

```bash
npm start               # 开发服务器
npm run test:run        # 单次测试
npm run test            # 测试 watch 模式
npm run test:e2e        # Playwright E2E
npm run lint:fix        # ESLint 修复
npm run build           # 生产构建
npm run update-types    # 更新 Supabase 类型
```

---

## 附录 C：迁移检查清单

从 `everything-claude-code` 迁移到 VS Code + Copilot 的完整检查清单：

### 已完成 ✅

**规则层（Instructions）**
- [x] `copilot-instructions.md` - 全局规则（432 行）
- [x] `AGENTS.md` - Agent 协作规则
- [x] 7 个 instructions 文件 - 分域规则
  - [x] general.instructions.md
  - [x] frontend.instructions.md
  - [x] backend.instructions.md
  - [x] testing.instructions.md
  - [x] security.instructions.md
  - [x] git.instructions.md
  - [x] docs.instructions.md

**Agent 层（11 个）**
- [x] planner.agent.md - 规划师
- [x] architect.agent.md - 架构师
- [x] implementation.agent.md - 实现者
- [x] tdd-guide.agent.md - TDD 引导
- [x] code-reviewer.agent.md - 代码审查员
- [x] security-reviewer.agent.md - 安全专家
- [x] e2e-runner.agent.md - E2E 测试专家
- [x] refactor-cleaner.agent.md - 重构清理器
- [x] doc-updater.agent.md - 文档专家
- [x] build-error-resolver.agent.md - 构建修复专家
- [x] database-reviewer.agent.md - 数据库专家

**Prompt 层（13 个）**
- [x] plan.prompt.md - /plan
- [x] design.prompt.md - /design
- [x] implement.prompt.md - /implement
- [x] tdd.prompt.md - /tdd
- [x] code-review.prompt.md - /code-review
- [x] security.prompt.md - /security
- [x] build-fix.prompt.md - /build-fix
- [x] e2e.prompt.md - /e2e
- [x] refactor-clean.prompt.md - /refactor-clean
- [x] docs.prompt.md - /docs
- [x] verify.prompt.md - /verify
- [x] checkpoint.prompt.md - /checkpoint
- [x] orchestrate.prompt.md - /orchestrate
- [x] resume.prompt.md - /resume ✨ 新增（映射自 SessionStart hook）
- [x] session-summary.prompt.md - /session-summary ✨ 新增（映射自 Stop hook）
- [x] patterns.prompt.md - /patterns ✨ 新增（映射自 /instinct-status）
- [x] evolve-patterns.prompt.md - /evolve-patterns ✨ 新增（映射自 /evolve）

**Skill 层（9 个）**
- [x] skill.md - 技能索引
- [x] tdd/skill.md - TDD 技能包
- [x] docs/skill.md - 文档技能包
- [x] security-review/skill.md - 安全审查技能包
- [x] api-design/skill.md - API 设计技能包
- [x] continuous-learning/skill.md - 持续学习技能包 ✨ 新增
- [x] strategic-compact/skill.md - 战略压缩技能包 ✨ 新增
- [x] verification-loop/skill.md - 验证循环技能包 ✨ 新增
- [x] backend-patterns/skill.md - 后端模式技能包 ✨ 新增
- [x] coding-standards/skill.md - 编码标准技能包 ✨ 新增

**Context 目录（会话状态持久化）** ✨ 新增
- [x] .github/context/current-focus.md - 当前焦点任务
- [x] .github/context/recent-decisions.md - 最近决策记录
- [x] .github/context/blockers.md - 阻塞问题追踪

**Learned 目录（持续学习记录）** ✨ 新增
- [x] .github/learned/patterns.md - 代码模式（带置信度）
- [x] .github/learned/errors.md - 错误解决方案
- [x] .github/learned/workarounds.md - 变通方案
- [x] .github/learned/preferences.md - 用户偏好
- [x] .github/learned/conventions.md - 项目约定
- [x] .github/learned/debugging.md - 调试技巧

**基础设施**
- [x] mcp.json - Supabase + Chrome DevTools
- [x] settings.json - 所有必要设置（含完整注释）
- [x] copilot.hooks.json - 完整 hooks 配置（含映射说明）

### 功能映射完成度

| everything-claude-code 功能 | 映射状态 | 说明 |
|----------------------------|----------|------|
| rules/ | ✅ 完成 | instructions 文件 |
| agents/ | ✅ 完成 | 11 个 agent 文件（含 tools 配置）|
| commands/ | ✅ 完成 | 17 个 prompt 文件 |
| skills/ | ✅ 完成 | 9 个 skill 目录 |
| hooks/ | ✅ 完成 | hooks.json + prompts 替代方案 |
| mcp-configs/ | ✅ 完成 | mcp.json |
| continuous-learning/ | ✅ 完成 | skill + learned 目录 |
| strategic-compact/ | ✅ 完成 | skill + 替代方案 |
| memory-persistence/ | ✅ 完成 | context 目录 + prompts |

### Agent Tools 配置 ✨ 新增

每个 agent 现在都有明确的 `tools` 配置（**使用 VS Code Copilot 官方工具名**）：

#### VS Code 工具别名对照表

| VS Code 工具名 | Claude Code 等效 | 描述 |
|----------------|-----------------|------|
| `readFile` | `Read` | 读取文件内容 |
| `editFiles` | `Edit`, `Write` | 编辑文件 |
| `createFile` | `Write` | 创建新文件 |
| `textSearch` | `Grep` | 文本搜索 |
| `fileSearch` | `Glob` | 文件名搜索 |
| `codebase` | `semantic_search` | 代码库语义搜索 |
| `runInTerminal` | `Bash` | 终端执行命令 |
| `listDirectory` | `LS` | 目录列表 |
| `fetch` | `WebFetch` | 网页获取 |
| `usages` | N/A | 引用/定义查找 |
| `changes` | `git diff` | 源代码控制变更 |
| `problems` | `get_errors` | 编译/lint 问题 |
| `runTests` | N/A | 运行单元测试 |
| `testFailure` | N/A | 测试失败信息 |
| `githubRepo` | N/A | GitHub 仓库搜索 |

#### Agent 工具配置

| Agent | Tools |
|-------|-------|
| @planner | readFile, codebase, textSearch, fileSearch, listDirectory, usages, fetch, githubRepo |
| @architect | readFile, codebase, textSearch, fileSearch, listDirectory, usages, fetch |
| @implementation | readFile, createFile, editFiles, runInTerminal, textSearch, codebase, listDirectory, runTests, problems |
| @tdd-guide | readFile, createFile, editFiles, runInTerminal, textSearch, codebase, runTests, testFailure |
| @code-reviewer | readFile, textSearch, codebase, listDirectory, runInTerminal, changes, usages, problems |
| @security-reviewer | readFile, textSearch, runInTerminal, codebase, listDirectory, changes, fileSearch |
| @e2e-runner | readFile, createFile, editFiles, runInTerminal, textSearch, listDirectory, playwright/* |
| @build-error-resolver | readFile, createFile, editFiles, runInTerminal, textSearch, listDirectory, problems, runTests |
| @refactor-cleaner | readFile, createFile, editFiles, runInTerminal, textSearch, codebase, listDirectory, usages |
| @database-reviewer | readFile, createFile, editFiles, runInTerminal, textSearch, listDirectory, supabase/* |
| @doc-updater | readFile, createFile, editFiles, runInTerminal, textSearch, codebase, listDirectory |

### Hooks 映射 ✨ 新增

| everything-claude-code Hook | VS Code 映射 | 实现方式 |
|----------------------------|--------------|----------|
| SessionStart | `/resume` prompt | 手动执行，读取 context 目录 |
| PreToolUse | agent tools + instructions | frontmatter 配置 |
| PostToolUse | `/verify` prompt | 手动执行验证 |
| Stop | `/session-summary` prompt | 手动执行，保存到 context |
| PreCompact | `/checkpoint` prompt | 手动执行，新建会话前 |

---

## 附录 D：everything-claude-code 核心命令速查

| 原始命令 | VS Code 映射 | 说明 |
|----------|--------------|------|
| `/compact` | 新建 Chat 会话 | 压缩上下文 |
| `/instinct-status` | `/patterns` | 查看学习模式 |
| `/instinct-export` | Git push | 导出模式 |
| `/instinct-import` | Git pull | 导入模式 |
| `/evolve` | `/evolve-patterns` | 进化 instincts |
| `/hookify` | 编辑 hooks JSON | 创建 hook |
| SessionStart | `/resume` | 恢复会话 |
| Stop | `/session-summary` | 总结会话 |

---

**文档版本**: 2.2
**最后更新**: 2025-01-28
**适用项目**: NanoFlow
**映射源**: [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
