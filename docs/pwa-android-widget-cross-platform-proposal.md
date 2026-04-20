# NanoFlow Android 手机端小组件策划案

> 说明：文件路径沿用历史命名，内容已收缩为 Android 手机端方案。桌面端小组件、桌面端宿主路线、组合 Service Worker、桌面端运行时与相关设想均已移除，不再作为候选路线。
> 日期：2026-04-20
> 状态：Android-only 基线
> 适用范围：Android Home Widget、Android TWA 壳、Android 宿主与后端摘要链路

## 背景与目标

NanoFlow 当前要解决的不是“跨端都做一遍 Widget”，而是先把手机端的小组件链路做成一条可验证、可回滚、不会制造假阳性的产品路径。

本案只保留 Android 手机端相关内容，目标是：

1. 让用户在手机桌面直接看到可信的 Focus / Dock / Gate 摘要。
2. 让用户从手机桌面小组件稳定打开 NanoFlow 的正确上下文。
3. 保持当前 offline-first 主链路不被 widget 旁路写操作破坏。

## 已剔除范围

以下内容不再属于本方案，也不再继续投入实现：

1. 桌面端小组件宿主路线。
2. PWA manifest `widgets` 声明。
3. 桌面端组合 Service Worker 与 Web 端 widget 运行时。
4. 桌面端 widget 专属窗口复用、宿主生命周期与卡片模板。
5. 任何以“先做电脑端 PoC 再放行 Android”为前提的门禁。

## 当前事实基线

### 启动与路由

- Manifest `id` 继续保持 `/launch.html`，历史安装身份不动。
- 正式入口继续是 `./`，不是 `launch.html`。
- 路由继续统一走 `./#/projects...`。
- `entry=widget|twa|shortcut` 与 `intent=` 仍保留，因为 Android Widget 与 TWA 需要它们承接启动信封。

### 数据权威源

- 云侧摘要主源是 `focus_sessions.session_state`。
- `tasks`、`projects`、`black_box_entries` 仍是领域真值表。
- `widget-summary` 负责把领域数据投影成稳定 DTO，Android 宿主只读 DTO，不直接拼业务表。

### 同步现实

- 当前同步语义仍是本地先写、3 秒防抖、后台重试、最终一致。
- Android Widget 不能冒充 Web 进程里尚未 flush 的本地状态。
- 对外只能承诺近实时和陈旧态提示，不能承诺绝对实时。

### Android 宿主角色分层

- TWA 只负责打开 NanoFlow Web 应用。
- Glance / 原生宿主负责 widget UI、实例生命周期、后台刷新与本地缓存。
- FCM + WorkManager 负责刷新触发。
- `widget-register` 仍只能由已登录 Web 会话完成，原生宿主不能直接裸调。

## 产品边界

### 本期范围

1. 手机桌面只读摘要。
2. 点击打开工作区、Focus 工具或已有上下文深链。
3. 摘要 freshness / trust / source 三维状态。
4. 账号切换、撤销、绑定失效与隐私模式。

### 明确非目标

1. Widget 内直接写任务状态。
2. Widget 内直接录音或编辑 Black Box 正文。
3. iOS Widget。
4. 无 GMS / HarmonyOS 设备支持。
5. “今日统计”默认输出。

## 推荐架构

```text
Android Widget (Glance / RemoteViews)
  -> widget-summary
  -> widget-register
  -> widget-notify

TWA Shell
  -> 打开 Web 应用
  -> 已登录会话完成 bootstrap
  -> nanoflow-widget://bootstrap 回传 widgetToken

Widget 后端
  -> focus_sessions.session_state 投影
  -> tasks / projects / black_box_entries 过滤与校验
  -> binding_generation / token_hash / instance 校验
```

关键原则：

1. Android 宿主不持有 Supabase 用户会话，只持有 widget 只读 token。
2. Push 只推 dirty signal，不推正文。
3. 本地缓存只保留最小摘要字段。
4. 所有实例边界按 `device_id + instance_id` 分离。

## 实施分期

### P0：Web 启动基础

目标：让 Android TWA / Widget 打开路径有稳定启动信封。

范围：

1. `entry` / `intent` 协议。
2. `./#/projects...` 路由降级。
3. `launch.html` 历史身份兼容。

### P1：后端基础设施

目标：让 Android Widget 有受控读模型与设备令牌。

范围：

1. `widget-register`。
2. `widget-summary`。
3. `widget-notify`。
4. `widget_devices` / `widget_instances` / 限流 / kill switch。

### P2：Android Widget + TWA 壳

目标：打通原生宿主、bootstrap、实例刷新、隐私与降级语义。

范围：

1. Android 原生宿主骨架。
2. TWA bootstrap。
3. Glance / RemoteViews 渲染。
4. WorkManager 兜底刷新。
5. FCM dirty push。

### P3：Widget Action

保持后置。只有 Android 只读链路稳定一段时间后，才讨论 Action Queue。

## 核心约束

### 安全

1. `widget-register` 仅允许用户态注册或轮换。
2. `widget-summary` 只接受 device token，不走 query string token。
3. `binding_generation`、`revoked_at`、`expires_at`、`token_hash` 必须进入验证链路。
4. 日志不得记录原始 token、push token 或完整正文。

### 隐私

1. 首版默认隐私模式更保守。
2. 默认不展示 Black Box 正文和任务正文。
3. Android Widget 不声明 `keyguard` category。

### 正确性

1. `summaryVersion` 必须覆盖所有影响展示的字段。
2. `soft-delete-target` 必须回退工作区。
3. `RATE_LIMITED` / `WIDGET_REFRESH_DISABLED` 必须保留最近一次有效上下文，不能直接抹平成空白。

## 当前主要风险

1. `assetlinks.json` 仍需 release 包名与证书指纹的线上验真。
2. FCM provider 尚未闭合 live push 链。
3. OEM 后台限制仍需在真实设备上长期观察。
4. bootstrap callback 的真人登录链路仍需补完整设备证据。

## 验证方式

必须有四类证据：

1. Web/TWA 启动契约证据。
2. `widget-register` / `widget-summary` / `widget-notify` 后端合同证据。
3. Android 宿主实例级证据。
4. 账号切换、绑定失效、隐私降级和 kill switch 的反假阳性证据。

## 回滚策略

1. 可单独停用 Android 宿主发布。
2. 可单独关闭 `widget-register` / `widget-summary` / `widget-notify`。
3. 可批量吊销 `widget_devices` / `widget_instances` 凭证。
4. 可移除 `assetlinks.json` 与 TWA 发布配置，而不影响主应用入口。

## 当前结论

当前 NanoFlow 的手机端小组件路线是可做的，并且仓库里已经有足够多的 Android 基础设施可以继续推进。

真正还需要闭合的，不再是电脑端 PoC，而是 Android 自己的三类问题：

1. release 级 `assetlinks.json` 验真。
2. FCM live push 链路。
3. 真机长期行为与 OEM 后台限制。
