# Skills Overview

此目录包含 Copilot 可学习的技能包。每个技能是独立的、可组合的能力单元。

> **映射来源**: [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)

## 目录结构

```
skills/
├── skill.md                # 此文件（索引）
├── api-design/             # API 设计技能包
│   └── skill.md
├── backend-patterns/       # 后端模式技能包 ✨
│   └── skill.md
├── coding-standards/       # 编码标准技能包 ✨
│   └── skill.md
├── continuous-learning/    # 持续学习技能包 ✨
│   └── skill.md
├── docs/                   # 文档技能包
│   └── skill.md
├── security-review/        # 安全审查技能包
│   └── skill.md
├── strategic-compact/      # 战略压缩技能包 ✨
│   └── skill.md
├── tdd/                    # TDD 技能包
│   ├── skill.md
│   ├── examples/           # 示例代码
│   └── scripts/            # 自动化脚本
└── verification-loop/      # 验证循环技能包 ✨
    └── skill.md
```

## 可用技能

### 核心开发技能

| 技能 | 描述 | 触发方式 |
|------|------|----------|
| tdd | 测试驱动开发 | `/tdd`, `@tdd-guide` |
| docs | 文档生成和更新 | `/docs`, `@doc-updater` |
| api-design | API 设计规范 | `/design`, `@architect` |
| security-review | 安全审查和漏洞检测 | `/security`, `@security-reviewer` |

### 项目规范技能

| 技能 | 描述 | 触发方式 |
|------|------|----------|
| coding-standards | NanoFlow 编码标准 | `@implementation`, `@code-reviewer` |
| backend-patterns | Supabase 后端模式 | `@architect`, `@database-reviewer` |

### 工作流优化技能（来自 everything-claude-code）

| 技能 | 描述 | 触发方式 | 原始功能 |
|------|------|----------|----------|
| continuous-learning | 从会话学习模式 | `/session-summary` | Continuous Learning v1/v2 |
| strategic-compact | 智能上下文压缩 | 阶段切换时 | Strategic Compact |
| verification-loop | 自动验证循环 | `/verify`, `@implementation` | Verification Hooks |

## 技能分类

```
┌────────────────────────────────────────────────────────────┐
│                      核心开发技能                          │
│  ┌─────────┐  ┌─────────┐  ┌──────────────┐  ┌──────────┐ │
│  │   TDD   │  │  Docs   │  │  API Design  │  │ Security │ │
│  └─────────┘  └─────────┘  └──────────────┘  └──────────┘ │
├────────────────────────────────────────────────────────────┤
│                      项目规范技能                          │
│  ┌──────────────────┐  ┌────────────────────┐             │
│  │ Coding Standards │  │  Backend Patterns  │             │
│  └──────────────────┘  └────────────────────┘             │
├────────────────────────────────────────────────────────────┤
│                     工作流优化技能                         │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Continuous      │  │  Strategic   │  │ Verification  │ │
│  │ Learning        │  │  Compact     │  │ Loop          │ │
│  └─────────────────┘  └──────────────┘  └───────────────┘ │
└────────────────────────────────────────────────────────────┘
```

## 如何添加新技能

1. 创建 `skills/<name>/skill.md`
2. 添加 `examples/` 目录（可选）
3. 添加 `scripts/` 目录（可选）
4. 在此文件添加索引

## 技能包格式

```markdown
---
name: skill-name
description: 简短描述
version: 1.0.0
triggers:
  - "@agent-name"
  - "/command"
---

# Skill Name

## 概述
[技能描述]

## 使用方法
[如何触发和使用]

## 示例
[代码示例]
```

## 与 everything-claude-code 的映射

| 原始 Skill | 本项目实现 | 状态 |
|------------|------------|------|
| continuous-learning/ | continuous-learning/skill.md | ✅ |
| continuous-learning-v2/ | continuous-learning/skill.md | ✅ 合并 |
| strategic-compact/ | strategic-compact/skill.md | ✅ |
| verification-loop (implicit) | verification-loop/skill.md | ✅ |
