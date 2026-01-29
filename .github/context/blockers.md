# Blockers & Known Issues

> 当前阻塞问题和已知问题追踪
> 来源：[everything-claude-code Memory Persistence](https://github.com/affaan-m/everything-claude-code)

## 🚨 Critical Blockers

_目前无 Critical 阻塞_

---

## ⚠️ High Priority Issues

### ISSUE-001: iOS Safari 录音格式

**状态**：已解决 ✅

**描述**：iOS Safari 不支持 webm 音频格式

**解决方案**：动态检测 mimeType，回退到 mp4

---

## 📋 Medium Priority Issues

### ISSUE-002: Playwright E2E 在 CI 中偶发超时

**状态**：调查中 🔍

**描述**：约 5% 的 CI 运行中 E2E 测试超时

**可能原因**：
- Chrome 启动慢
- 网络请求超时
- 资源竞争

**临时解决**：增加超时时间到 60s

---

## 📝 Low Priority Issues

### ISSUE-003: GoJS 内存泄漏警告

**状态**：监控中 👀

**描述**：长时间使用后 DevTools 显示 GoJS 相关对象未释放

**缓解措施**：确保 `diagram.clear()` 和移除监听器

---

## 已解决的问题

| 编号 | 描述 | 解决日期 |
|------|------|----------|
| ISSUE-000 | Supabase 401 JWT 过期 | 2025-01-25 |

---

## 如何添加新问题

```markdown
### ISSUE-XXX: 简短标题

**状态**：待处理 📋 / 调查中 🔍 / 已解决 ✅

**描述**：详细描述问题

**复现步骤**：
1. 步骤一
2. 步骤二

**可能原因**：
- 原因一
- 原因二

**临时解决**：（如有）
```
