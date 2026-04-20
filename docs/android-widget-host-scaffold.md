# Android Widget Host Scaffold

> 目标：定义 Android 手机端 widget 宿主的最小职责边界，确保原生宿主、TWA 与后端之间分工清晰。
> 日期：2026-04-20

## 背景与目标

Android Widget Host 是 NanoFlow 手机端小组件的真正宿主。它负责展示、刷新、缓存与实例生命周期；TWA 只负责打开 Web 并协助完成 bootstrap。

本文件只保留 Android 宿主相关内容，不再包含桌面端 widget runtime、共享 IndexedDB 或组合 Service Worker 的设计。

## 关键约束

1. Android 宿主持有的仅是 widget 只读 token，不是 Web 用户会话。
2. Web 侧 bootstrap consumer 只负责调用 `widget-register` 并构造回调 URL，不再写入任何桌面端本地运行时存储。
3. 每个 widget 实例都要以 `appWidgetId` 为本地缓存分区键。
4. Push 只推 dirty signal，不推正文。
5. 无有效 token 时必须退回 setup/auth-required 状态，不展示旧缓存冒充当前状态。

## 模块分层

```text
Android Widget Host
  -> AppWidgetProvider / Glance receiver
  -> Refresh Worker
  -> Firebase Messaging Service
  -> Bootstrap Callback Activity
  -> Local Cache Store

TWA Shell
  -> 打开 NanoFlow Web
  -> 已登录会话触发 widget-register
  -> 回传 nanoflow-widget://bootstrap

Backend
  -> widget-register
  -> widget-summary
  -> widget-notify
```

## 实施步骤

### 宿主入口

- `AppWidgetProvider` 或等价入口负责实例创建、删除和点击事件分发。
- `Bootstrap Callback Activity` 负责接收 `nanoflow-widget://bootstrap`。
- `Refresh Worker` 负责定时和兜底刷新。
- `Firebase Messaging Service` 负责 dirty push 唤醒。

### 本地缓存

- 缓存键按 `appWidgetId` 分离。
- 缓存内容仅保留摘要 DTO 与 freshness 元数据。
- 不缓存正文敏感字段，除非隐私策略明确允许。
- 最后一个 widget 删除时清理 binding、cache、pending bootstrap 与 pending push。

### 渲染状态

宿主至少需要区分以下 UI 状态：

1. `loading`
2. `ready`
3. `auth-required`
4. `setup-required`
5. `rate-limited`
6. `refresh-disabled`
7. `error`

### 打开应用

- `widget-summary.entryUrl` 是唯一权威打开目标。
- 宿主不自行拼接业务路径，只消费后端给出的 `entryUrl`。
- 目标失效或软删除时，后端负责回退到安全工作区路径。

### 刷新模型

- 用户显式交互可触发立即刷新。
- FCM 只发送 dirty signal，由宿主自行重新拉取 `widget-summary`。
- WorkManager 提供兜底刷新，避免完全依赖 push。
- 限流或 kill switch 命中时，保留最近一次有效上下文并展示降级状态。

## 数据契约

宿主至少要消费以下字段：

1. `entryUrl`
2. `freshnessState`
3. `trustState`
4. `sourceState`
5. `degradedReasons`
6. Focus / Dock / Gate 的摘要字段

## 验证方式

1. 真机验证创建、删除、点击、刷新与回调。
2. 验证多实例镜像同一全局摘要时不会串缓存。
3. 验证退出登录、换号、token 失效后的清理行为。
4. 验证弱网、Doze、OEM 后台限制下的兜底刷新。

## 回滚或故障处理

1. 停止 Android 宿主发布。
2. 关闭 FCM 刷新入口，仅保留手动刷新或 WorkManager。
3. 通过后端 revoke 让旧 token 全部失效。
4. 保持主应用入口与普通 Android 打开路径不受影响。
