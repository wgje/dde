---
agent: agent
description: 总结本次会话，提取可复用模式
---

# 会话总结

> 映射自 everything-claude-code 的 Stop hook

## 总结内容

请总结本次会话的以下内容：

### 1. 完成的任务
- 列出本次会话完成的主要任务
- 标注每个任务的完成状态

### 2. 代码变更
- 主要修改了哪些文件
- 新增了哪些功能

### 3. 学习到的模式

检查是否有以下可复用模式：

| 类型 | 检查点 | 记录位置 |
|------|--------|----------|
| 错误解决 | 解决了新的错误类型？ | `errors.md` |
| 用户偏好 | 用户有特殊要求？ | `preferences.md` |
| 变通方案 | 发现了框架限制？ | `workarounds.md` |
| 调试技巧 | 使用了有效的调试方法？ | `debugging.md` |
| 项目约定 | 确立了新的规则？ | `conventions.md` |

### 4. 待办事项

列出未完成的工作，供下次继续：

```markdown
## 待继续
- [ ] 任务 1
- [ ] 任务 2

## 可选改进
- [ ] 优化项 1
```

## 更新 context 文件

如果有重要信息需要保留，请更新：

1. `.github/context/current-focus.md` - 当前任务状态
2. `.github/context/recent-decisions.md` - 重要决策
3. `.github/context/blockers.md` - 阻塞问题

## 输出格式

```
📋 会话总结

✅ 已完成：
• 任务 1
• 任务 2

📝 代码变更：
• 修改 file1.ts: 功能描述
• 新增 file2.ts: 功能描述

💡 学习模式：
• 发现 [模式名]，已记录到 [文件]

⏳ 待继续：
• 任务 A
• 任务 B

📊 context 已更新 ✓
```
