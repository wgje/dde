---
title: Android 小组件
status: canonical
audience: user, operator
last_verified: 2026-11-01
category: use-nanoflow
source_paths:
  - README.md
  - android/app/src/main/AndroidManifest.xml
  - android/app/src/main/res/xml/nanoflow_focus_widget_info.xml
  - android/app/src/main/res/values/strings.xml
  - android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt
  - android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRefreshWorker.kt
  - android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt
  - android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionActivity.kt
  - android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionService.kt
  - docs/android-widget-host-scaffold.md
  - src/services/widget-binding.service.ts
  - src/app/core/shell/workspace-shell-android-widget-bootstrap-completion.controller.ts
---

# Android 小组件

NanoFlow 当前只保留 Android 手机端小组件路径。它适合在桌面上快速看 Gate、Focus 和 Parking Dock 摘要，并完成少量快捷操作；真正的登录恢复、绑定修复和完整任务编辑仍在 NanoFlow 应用里完成。

## 本文内容

- [先知道边界](#先知道边界)
- [首次添加和绑定](#首次添加和绑定)
- [权限和前置条件](#权限和前置条件)
- [刷新和同步你该期待什么](#刷新和同步你该期待什么)
- [点按后会去哪里](#点按后会去哪里)
- [常见状态和恢复步骤](#常见状态和恢复步骤)
- [解绑重绑和账号切换](#解绑重绑和账号切换)
- [隐私和本地缓存](#隐私和本地缓存)
- [仅运维支持需要处理的边界](#仅运维支持需要处理的边界)
- [下一步](#下一步)

## 先知道边界

| 项目 | 当前行为 |
| --- | --- |
| 放置位置 | 只支持 Android 主屏，不支持锁屏或桌面端 runtime |
| 默认尺寸 | provider 目标尺寸是 `4 x 2`，最小约 `180dp x 110dp`，支持横向和纵向拉伸 |
| 适合做的事 | 看 Gate / Focus / Dock 摘要，点按打开工作区或专注工具，执行 Gate `已读 / 完成`，以及少量 Focus 快捷操作 |
| 不适合做的事 | 批量编辑任务、复杂层级整理、Flow 查看、手工管理绑定 token、做数据恢复 |
| 自动刷新预期 | 不是 launcher 自己按分钟轮询；刷新主要靠 WorkManager、解锁事件、应用打开后的补刷和可选的 FCM dirty push |

非空 Gate 还有一个容易误解的边界：整张 Gate 卡不会直接把你送进项目，而是要求你先用 `已读` 或 `完成` 按钮处理当前条目。只有 Gate 已经空了时，整卡点击才会回到工作区。

## 首次添加和绑定

1. 把 NanoFlow 小组件加到 Android 主屏。第一次显示 loading 或 setup 状态是正常的。
2. 如果你看到 `Widget 尚未连接`、`请先打开 NanoFlow 完成初始化` 或 `打开 NanoFlow 后会自动完成绑定并刷新摘要`，点按组件或直接打开 NanoFlow。
3. 宿主会把你带到 NanoFlow 的 Android/TWA 打开链路。Web 侧会在当前登录会话下完成 widget register，然后回跳到宿主的 `nanoflow-widget://bootstrap` 回调。

绑定完成期间如果登录会话发生变化，NanoFlow 会丢弃陈旧回调，不会把旧账号的结果写回当前会话；绑定失败会保留可重试状态，并提示重新打开 NanoFlow 小组件。

用户可以这样确认绑定已经完成：

- 小组件不再停留在 `等待绑定` / `准备摘要`；
- 状态徽标进入 `已连接`，或者直接出现 Gate / Focus / Dock 摘要；
- 再点一次刷新按钮后，状态行不再回到初始化提示。

## 权限和前置条件

| 项目 | 当前源码行为 | 用户要知道什么 |
| --- | --- | --- |
| 网络权限 | Manifest 声明了 `INTERNET` 和 `ACCESS_NETWORK_STATE` | 没有网络时仍可显示缓存，但不会拿到最新摘要 |
| RemoteViews 绑定 | `NanoflowWidgetActionService` 用 `android.permission.BIND_REMOTEVIEWS` 供系统绑定 | 这是系统侧权限，不需要你手工授权 |
| 小组件 provider | `updatePeriodMillis="0"` | 系统不会自己定时轮询刷新 |
| FCM 刷新 | 代码里有可选 FCM 路径；未启用 FCM 构建时 worker 会跳过 push token 持久化 | 没有 FCM 也能用，只是刷新退化成手动/解锁/周期/打开应用补刷 |
| OEM 后台限制 | 代码已经用 Activity-backed PendingIntent 和集合视图绕开一部分 MIUI / HyperOS 限制 | 如果 ROM 仍然拦后台，自启动/省电策略仍可能影响点击和推送，这不是小组件内能单独授予的权限 |

如果你要的是“桌面一改、手机立刻变”，除了 Android 宿主本身，还要有可用的服务端摘要接口和可用的 push 刷新链路。当前手册只承诺宿主端和 Web bootstrap 端的行为，不把 live push 是否已完全打通写成必然结果。

## 刷新和同步你该期待什么

不要把 Android 小组件理解成“永远秒级自动同步”。当前宿主的刷新触发点是明确分层的：

| 触发点 | 宿主会做什么 | 你该期待什么 |
| --- | --- | --- |
| 新增组件 | `onUpdate()` 立即渲染，并排队一轮刷新 | 新组件很快会有初始界面，但首次摘要通常要等绑定完成 |
| 调整尺寸 | `onAppWidgetOptionsChanged()` 立即重绘，并排队一轮刷新 | 拉伸后布局会变，摘要随后跟上 |
| 手动点刷新 | 只排队一个 WorkManager 刷新任务 | 不一定在点击瞬间重绘；真正更新发生在 worker 拉完摘要以后 |
| 手机解锁 | `USER_PRESENT` 最多每 2 分钟触发一次自动补刷 | 没有 FCM 时，这是最重要的追平路径之一 |
| 从小组件或 Android 启动 NanoFlow | 若主屏还有组件，宿主会安排一组 8 / 20 / 45 / 90 / 180 / 300 秒的补刷 burst | 回到桌面后的几分钟内，摘要可能逐步追平，而不是一次完成 |
| 周期兜底 | 只要至少有一个组件安装着，就保留 15 分钟一次的 WorkManager 周期刷新 | 这是保底，不是实时刷新 |
| Gate `已读` | 先做本地乐观更新，再向远端提交，并额外安排 30 分钟后的冷却补刷 | `已读` 不是 `完成`；如果 30 分钟后还没完成，这条内容可以再次出现 |
| 成功 bootstrap | 最多尝试 10 秒 inline refresh，随后再排一轮 follow-up | 刚绑定完成时，桌面可能先显示“已连接，摘要稍后会自动刷新” |

没有 FCM 或 push 不可用时，小组件不会直接失效，而是退化到上面这些兜底路径。你应该把 `手动刷新`、`解锁补刷`、`打开应用后的 burst` 和 `15 分钟周期刷新` 当成正常预期。

## 点按后会去哪里

| 入口 | 当前行为 |
| --- | --- |
| `打开 NanoFlow` | 通过 `NanoflowTwaLauncherActivity` 打开工作区路径 |
| `打开专注工具` | 通过同一 TWA launcher 打开 Focus 工具路径 |
| Gate 非空时点整张主卡 | 不会直接进项目，只会提示你先用 `已读 / 完成` |
| Gate 已空时点整张主卡 | 直接回到工作区 |
| Gate `已读 / 完成` | 先在 widget 内执行透明 Activity -> Receiver -> 远端提交，不需要先打开 TWA |
| Focus 的次级槽位 | 能在 widget 内直改就直改；不能安全直改时会退回到打开应用 |
| 当前任务 / 项目上下文 | 宿主会优先复用当前摘要里的安全入口；上下文失效时回退到工作区路径 |

对普通用户来说，不需要也不应该手工拼接 deep link。`nanoflow-widget://bootstrap` 以及回调用的 `intent://...#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end` 属于宿主和 Web 之间的回调协议，不是日常使用入口。

## 常见状态和恢复步骤

| 你看到的文案 | 这通常代表什么 | 安全做法 |
| --- | --- | --- |
| `Widget 尚未连接` / `请先打开 NanoFlow 完成初始化` / `打开 NanoFlow 后会自动完成绑定并刷新摘要` | 首次绑定还没完成，或者实例上下文需要重建 | 先打开 NanoFlow 一次，等登录和启动恢复完成后回到桌面；仍不恢复再重加组件 |
| `请重新登录 NanoFlow` / `登录会话已失效，重新登录后组件会自动恢复` | 当前登录会话已失效，widget token 需要跟随当前账号重新走恢复链路 | 在这台手机上重新登录 NanoFlow，再手动刷新或重开应用 |
| `摘要待验证，请打开 NanoFlow` | 当前摘要被降级为 untrusted，或解析/校验链路没有给出可直接信任的结果 | 打开 NanoFlow 让会话和同步稳定，再回到桌面刷新 |
| `当前显示的是本地缓存摘要` | 这次没拿到新摘要，宿主回退到了 cache-only | 先确认网络，再手动刷新；缓存不是“最新保证” |
| `数据较旧，点按可打开 NanoFlow` | 摘要已 stale，或云端更新时间不可用 | 先手动刷新；仍旧如此就打开应用确认当前任务和同步 |
| `摘要刷新已暂停，请打开 NanoFlow` | 服务端返回了 refresh-disabled，宿主会进入退避窗口 | 打开应用确认服务可用性；短时间内连续猛刷不会绕过这个窗口 |
| `关联目标已变化，请打开 NanoFlow` | 原来的任务/项目上下文已经变化、软删或实例关联失效 | 打开应用确认目标是否还存在；必要时删掉组件后重新添加 |
| `Widget 连接未完成，请回到桌面重新点按组件` | bootstrap 回调被拒绝、过期，或者桌面上的实例已经变了 | 回桌面重新点组件；如果已经换号或删过组件，优先重新登录或重加组件 |
| Toast `网络繁忙，请稍后重试` | Gate / Focus 的乐观更新被远端失败回滚 | 等网络恢复后重试，不要假定刚才那次本地动画已经真正提交成功 |

恢复顺序建议固定为：先确认当前账号和网络，再打开 NanoFlow 一次，接着回桌面手动刷新，最后才是删除并重新添加组件。这样最不容易把“暂时未追平”误判成“数据没了”。

## 解绑重绑和账号切换

源码里的解绑和重绑边界是这样的：

- 删除单个组件时，会清掉这个 `appWidgetId` 的本地实例状态、页码、选中项、缓存摘要、pending bootstrap 和 layout 签名。
- 删除最后一个组件时，还会额外清掉共享 binding 和 pending push token。下一次再添加组件，就一定会重新走 bootstrap。
- 如果服务端返回的是 `WIDGET_TOKEN_REQUIRED`、`DEVICE_NOT_FOUND`、`DEVICE_REVOKED`、`BINDING_MISMATCH`、`TOKEN_EXPIRED` 或 `TOKEN_INVALID`，宿主会主动清掉本地 binding；你看到的结果通常就是重新回到 setup/auth-required。
- 如果返回的是 `INSTANCE_CONTEXT_REQUIRED`、`INSTANCE_CONTEXT_INVALID`、`INSTANCE_NOT_ACTIVE` 或 `INSTANCE_BINDING_MISMATCH`，宿主会清掉这个组件实例的上下文；最安全的用户恢复就是先打开应用，必要时把这个组件删掉再重加。

账号切换时，不要把 widget 绑定理解成“浏览器登录态的镜像”。源码里确实有批量 revoke-all 的运维清理路径，但那不是普通用户在 widget 里手工处理的步骤。对日常使用来说，正确顺序仍然是：切到目标账号、让 NanoFlow 完成登录恢复、回桌面刷新，必要时重加组件。

## 隐私和本地缓存

当前源码的隐私边界是明确的：

- widget 宿主持有的是只读 widget token，不是你的完整 Web 用户会话；
- 如果你没有显式开启小组件隐私模式，本地缓存会优先保留摘要正文，方便桌面直接显示；
- 如果你已经开启隐私模式，本地缓存会主动抹掉 Focus 标题、项目标题、Black Box 正文、Dock 任务标题等敏感明文，只保留计数和状态；
- widget 遥测日志会对 instanceId、taskId、entryId 一类标识做脱敏显示，而不是原样输出。

对共享桌面、会议投屏或容易被旁人看到的手机，用户可以这样验证隐私模式是否生效：刷新后，小组件应更偏向显示计数、状态和简化标题，而不是完整任务正文或 Black Box 文本。

## 仅运维支持需要处理的边界

下面这些属于支持或运维边界，不建议普通用户自行操作：

| 边界 | 说明 |
| --- | --- |
| 强制刷新广播 | `app.nanoflow.twa.widget.ACTION_FORCE_REFRESH` 是 ADB / FCM / 支持排障路径，普通用户用组件上的刷新按钮即可 |
| bootstrap 回调协议 | `nanoflow-widget://bootstrap` 和对应的 `intent://...;package=app.nanoflow.twa;end` 只用于宿主和 Web 之间的回跳 |
| 批量吊销绑定 | Web 侧 `WidgetBindingService` 有 revoke-all 清理路径，适合账号切换或支持排障，不是日常用户操作 |
| live push 能力 | 宿主端已经有 FCM 相关代码和退化路径，但“线上 dirty push 一定已打通”需要单独验服务端和构建配置 |
| 系统级后台限制 | MIUI / HyperOS 一类 ROM 的自启动、后台冻结和省电策略属于系统层行为，应用无法直接替用户修改 |

## 下一步

- 继续看 Focus 行为：[Focus 专注模式](04-focus-mode.md)。
- 继续看同步与冲突：[同步与冲突处理](../03-data-sync-safety/02-sync-and-conflicts.md)。
- 需要运维云端路径时，再看 [Edge Functions](../04-deploy-operate/03-edge-functions.md) 和 [Supabase 运维](../04-deploy-operate/02-supabase-operations.md)。
