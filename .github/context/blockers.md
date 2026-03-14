# Blockers & Known Issues

> 当前阻塞问题和已知问题追踪
> 上次更新：2026-02-27
> 来源：[everything-claude-code Memory Persistence](https://github.com/affaan-m/everything-claude-code)

## 🚨 Critical Blockers

_目前无 Critical 阻塞_

---

## ⚠️ High Priority Issues

### ISSUE-010: 停泊坞组件测试失败

**状态**：调查中 🔍

**描述**：`npx vitest run --config vitest.components.config.mts -- parking-dock` 退出码 1

**可能原因**：
- 组件拆分后测试用例未同步更新
- TestBed 配置缺少新增子组件声明

**临时处理**：已加入 quarantine 列表待修复

---

## ⚠️ Medium Priority Issues

### ISSUE-002: Playwright E2E 在 CI 中偶发超时

**状态**：进行中 🔍

**描述**：约 5% 的 CI 运行中 E2E 测试超时（60s 阈值）

**可能原因**：
- Chrome 无头模式启动慢
- 网络请求在 CI 弱网环境超时
- 资源竞争（并发分片过多）

**缓解措施**：
- 增加 Playwright 超时至 60s
- 减少 CI 并发分片数

### ISSUE-003: GoJS 长时间使用内存增长

**状态**：监控中 👀

**描述**：长时间使用后 DevTools 显示 GoJS 相关对象未释放

**缓解措施**：确保视图切换时 `diagram.clear()` + 解绑全部监听

---

## 📝 Low Priority Issues

### ISSUE-004: 手机端缺少自动本地备份

**状态**：已知限制 📋

**描述**：iOS/Android 浏览器不支持 File System Access API，无法实现自动本地备份

**替代方案**：优先使用云端同步（E层），定期手动导出

### ISSUE-005: Realtime 订阅默认禁用

**状态**：已知限制（可配置）📋

**描述**：`FEATURE_FLAGS.REALTIME_ENABLED = false`，多设备实时同步依赖轮询（5 分钟间隔）

**配置方法**：修改 `src/config/feature-flags.config.ts` 中 `REALTIME_ENABLED: true`

---

## 已解决的问题

| 编号 | 描述 | 解决日期 |
|------|------|----------|
| ISSUE-001 | iOS Safari 录音格式（webm 不支持） | 2025-01 |
| ISSUE-000 | Supabase 401 JWT 过期 | 2025-01 |
| ISSUE-006 | 启动阻塞 LCP（AUTH_CONFIG 超时 10s → 3s） | 2026-02-08 |
| ISSUE-007 | localStorage RetryQueue 溢出（500 → 100 + IDB 1000） | 2025-Q4 |
| ISSUE-008 | 轮询流量过高（30s → 5 分钟） | 2026-01 |
| ISSUE-009 | GoJS 视图 visibility:hidden 持有实例内存泄漏 | 2025 |

---

## 如何添加新问题

```markdown
### ISSUE-XXX: 简短标题

**状态**：待处理 📋 / 调查中 🔍 / 已解决 ✅

**描述**：详细描述问题

**复现步骤**：
1. 步骤一

**可能原因**：
- 原因一

**临时解决**：（如有）
```
