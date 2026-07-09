---
title: Android 小组件
status: canonical
audience: user, operator
last_verified: 2026-06-13
category: use-nanoflow
source_paths:
  - README.md
  - android/
  - docs/android-widget-host-scaffold.md
  - docs/pwa-android-widget-cross-platform-implementation-checklist.md
  - supabase/functions/widget-summary/
---

# Android 小组件

NanoFlow 当前保留的是 Android 手机端小组件路径。它适合在桌面快速看 Gate、Focus 或 Parking Dock 摘要，但不用于完整编辑任务。

## 本文内容

- [小组件能做什么](#小组件能做什么)
- [完整能力需要哪些组件](#完整能力需要哪些组件)
- [刷新是怎么发生的](#刷新是怎么发生的)
- [缺少 FCM 时如何退化](#缺少-fcm-时如何退化)
- [使用和排障建议](#使用和排障建议)
- [下一步](#下一步)

## 小组件能做什么

小组件适合显示：

- Gate 待处理摘要；
- 当前 Focus 摘要；
- Parking Dock 摘要；
- 是否有需要刷新的 dirty 状态；
- 点击后进入 PWA 或 Android 宿主路径。

它不适合：

- 大量编辑任务；
- 调整复杂层级；
- 查看流程图；
- 执行导入导出；
- 做数据恢复。

## 完整能力需要哪些组件

完整 Android 小组件路径通常需要：

1. Android TWA 宿主，包名为 `app.nanoflow.twa`。
2. `widget-register` Edge Function，用于注册小组件实例。
3. `widget-summary` Edge Function，用于返回摘要。
4. `widget-notify` Edge Function，用于触发 dirty push。
5. Android 侧 Firebase 配置。
6. Supabase Secrets 中的 FCM 服务账号信息。

如果只是本地测试，没有 FCM，也可以先使用退化刷新方式。

## 刷新是怎么发生的

理想刷新路径：

1. NanoFlow 状态发生变化。
2. 后端或 Edge Function 标记对应小组件数据变脏。
3. `widget-notify` 触发 FCM。
4. Android 宿主收到刷新信号。
5. 小组件调用 `widget-summary` 获取最新摘要。
6. 桌面小组件更新显示。

这条路径里任意一段缺配置，都可能退化。

## 缺少 FCM 时如何退化

没有 `google-services.json` 或 FCM Secrets 时，小组件不应该直接失效，而是退化为：

- 手动刷新；
- 解锁手机后刷新；
- WorkManager 周期刷新；
- 打开应用时刷新。

退化模式适合早期使用，但它不保证状态实时。

## 使用和排障建议

| 问题 | 先检查 |
| --- | --- |
| 小组件没有数据 | 是否登录、`widget-summary` 是否部署、RLS 是否允许读取 |
| 不能自动刷新 | FCM 配置、`widget-notify`、Android 权限 |
| 摘要过旧 | 手动刷新一次，再看后台函数日志 |
| 点击没有打开正确位置 | Android TWA deep link 和启动 intent |

不要把小组件当成唯一入口。关键任务编辑仍然回到 PWA。

## 下一步

- 配置云端函数：[Edge Functions](../04-deploy-operate/03-edge-functions.md)。
- 运维 Supabase：[Supabase 运维](../04-deploy-operate/02-supabase-operations.md)。
