---
agent: agent
description: 恢复上次会话状态，从检查点继续工作
---

# 恢复会话

> 映射自 everything-claude-code 的 SessionStart hook

## 恢复流程

请按以下顺序恢复上下文：

1. **读取当前焦点**
   ```
   读取 .github/context/current-focus.md
   ```

2. **检查阻塞问题**
   ```
   读取 .github/context/blockers.md
   ```

3. **查看最近决策**
   ```
   读取 .github/context/recent-decisions.md
   ```

4. **恢复学习模式**
   ```
   快速浏览 .github/learned/ 目录
   ```

## 恢复后确认

完成恢复后，请告诉用户：

- 📍 当前任务状态
- ⏸️ 是否有未完成的工作
- 🚧 是否有阻塞问题
- 💡 建议的下一步操作

## 示例响应

```
已恢复会话上下文 ✓

📍 当前任务：实现语音转写功能
⏸️ 上次进度：Edge Function 已完成，前端集成待开始
🚧 阻塞问题：无
💡 建议下一步：实现 SpeechToTextService.transcribe() 方法

需要继续上次的工作吗？
```
