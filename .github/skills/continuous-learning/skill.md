---
name: continuous-learning
description: 从会话中学习用户模式，记录有效的解决方案和偏好
version: 1.0.0
triggers:
  - "@code-reviewer"
  - "/session-summary"
---

# 持续学习技能

从 AI 会话中提取可复用的模式，帮助 AI 更好地理解项目和用户偏好。

## 模式检测类型

| 模式类型 | 说明 | 记录位置 |
|----------|------|----------|
| `error_resolution` | 如何解决特定错误 | `.github/learned/errors.md` |
| `user_corrections` | 用户纠正后形成的偏好 | `.github/learned/preferences.md` |
| `workarounds` | 框架/库特殊处理方案 | `.github/learned/workarounds.md` |
| `debugging_techniques` | 有效的调试方法 | `.github/learned/debugging.md` |
| `project_specific` | 项目特定约定 | `.github/learned/conventions.md` |

## 学习流程

```
会话活动
    │
    │ 检测模式
    ▼
┌─────────────────────────────────────────┐
│         模式识别                         │
│   • 用户纠正 → 偏好记录                  │
│   • 错误解决 → 解决方案记录               │
│   • 重复工作流 → 工作流记录               │
└─────────────────────────────────────────┘
    │
    │ 保存到项目
    ▼
┌─────────────────────────────────────────┐
│         .github/learned/                │
│   • preferences.md                      │
│   • errors.md                           │
│   • conventions.md                      │
└─────────────────────────────────────────┘
```

## 使用方式

### 1. 会话结束时总结

在完成重要工作后，使用 `/session-summary` 命令提取模式：

```
/session-summary

今天解决了什么问题？学到了什么模式？
```

### 2. 查看已学习模式

```
请查看 .github/learned/ 目录，告诉我目前学到的模式
```

### 3. 应用已学习模式

在代码审查或实现时，AI 会自动参考 `.github/learned/` 中的模式。

## 模式记录格式

```markdown
## [模式名称]

**触发条件**: 当 [描述触发场景]
**行为**: [描述应该采取的行为]
**置信度**: 高/中/低
**来源**: 会话观察 / 用户纠正 / 错误解决
**日期**: YYYY-MM-DD

### 证据
- [具体观察 1]
- [具体观察 2]
```

## 与 everything-claude-code 的映射

| everything-claude-code | 本项目实现 |
|------------------------|------------|
| Instinct 文件 | `.github/learned/*.md` |
| 置信度评分 | 高/中/低 文本标注 |
| Observer agent | 手动 `/session-summary` |
| `/instinct-status` | 直接查看 learned 目录 |
| `/evolve` | 手动整理为 skill 文件 |

## 注意事项

1. **隐私**: 只记录模式，不记录实际代码内容
2. **定期清理**: 过时的模式应该删除
3. **团队共享**: learned 目录可以提交到 Git 共享给团队
4. **持续更新**: 每次重要会话后更新模式记录
