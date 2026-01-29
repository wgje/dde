---
name: orchestrate
description: 编排多个 agent 执行复杂工作流
argument-hint: "workflow-type task-description"
agent: "agent"
---

编排工作流：${input:workflow:workflow-type task-description}

## 工作流类型

### feature（功能开发）
```
planner → tdd-guide → code-reviewer → security-reviewer
```

### bugfix（Bug 修复）
```
explorer → tdd-guide → code-reviewer
```

### refactor（重构）
```
architect → code-reviewer → tdd-guide
```

### security（安全审查）
```
security-reviewer → code-reviewer → architect
```

## 执行模式

对工作流中的每个 agent：

1. **调用 agent** - 带上前一个 agent 的上下文
2. **收集输出** - 作为结构化交接文档
3. **传递给下一个** - 链式执行
4. **汇总结果** - 生成最终报告

## 交接格式

```markdown
# HANDOFF: [from-agent] → [to-agent]

## 上一步完成
[已完成的工作]

## 传递上下文
[下一步需要的信息]

## 下一步任务
[具体指令]
```

## 示例：Feature 工作流

```
/orchestrate feature "Add user authentication"
```

执行：

1. **Planner Agent**
   - 分析需求
   - 创建实现计划
   - 识别依赖
   - 输出: `HANDOFF: planner → tdd-guide`

2. **TDD Guide Agent**
   - 读取 planner 交接
   - 先写测试
   - 实现通过测试
   - 输出: `HANDOFF: tdd-guide → code-reviewer`

3. **Code Reviewer Agent**
   - 审查实现
   - 检查问题
   - 建议改进
   - 输出: `HANDOFF: code-reviewer → security-reviewer`

4. **Security Reviewer Agent**
   - 安全审计
   - 漏洞检查
   - 最终批准
   - 输出: Final Report

## 自定义工作流

```
/orchestrate custom "architect,tdd-guide,code-reviewer" "Redesign caching layer"
```

## 输出格式

```markdown
# Orchestration Report

**工作流**: [类型]
**任务**: [描述]
**状态**: ✅ 完成 / ⚠️ 需要处理 / ❌ 阻塞

## Agent 执行记录

### 1. [Agent Name]
**状态**: ✅
**产出**: [简述]
**耗时**: Xm Ys

### 2. [Agent Name]
**状态**: ✅
**产出**: [简述]
**耗时**: Xm Ys

## 最终结果
[汇总]

## 下一步
1. [ ] [行动1]
2. [ ] [行动2]
```

## 提示

1. **从 planner 开始** - 复杂功能
2. **始终包含 code-reviewer** - 合并前
3. **使用 security-reviewer** - 认证/支付/PII
4. **保持交接简洁** - 聚焦下一 agent 需要的信息
5. **在 agents 之间运行验证** - 如需要
