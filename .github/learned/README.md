# 学习模式记录

> 此目录记录从 AI 会话中学习到的模式和偏好。
> 
> **来源**: [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) 的 Continuous Learning 功能

## 目录结构

```
learned/
├── README.md           # 此文件
├── preferences.md      # 用户偏好和代码风格
├── errors.md           # 常见错误及解决方案
├── workarounds.md      # 框架/库的特殊处理
├── conventions.md      # 项目特定约定
└── debugging.md        # 有效的调试方法
```

## 使用方式

### 1. 记录新模式

在完成重要工作后，使用 `/session-summary` 提取模式：

```
/session-summary

请分析本次会话，提取值得记录的模式
```

### 2. 查看已有模式

```
请查看 .github/learned/ 目录，告诉我目前学到的模式
```

### 3. 应用模式

AI 会自动参考此目录中的模式进行代码审查和实现。

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

## 与 everything-claude-code 的对应

| 原始功能 | 本目录实现 |
|----------|------------|
| `~/.claude/homunculus/instincts/personal/` | `.github/learned/` |
| `/instinct-status` | 直接查看此目录 |
| `/instinct-export` | Git push |
| `/instinct-import` | Git pull |
