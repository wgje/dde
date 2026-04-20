# NanoFlow Android 手机端小组件实施版 Checklist

> 说明：文件路径沿用历史命名，内容已收缩为 Android-only。桌面端小组件、桌面端宿主路线、组合 SW 与桌面端 widget runtime 已全部剔除。
> 日期：2026-04-20
> 状态：实施基线

## 使用方式

- [x] 仅围绕 Android 手机端小组件推进，不再跨入桌面端方案。
- [x] 新结论必须标注属于仓库已验证、官方约束、实时项目快照或待验证项。
- [x] 发现边界变化时，同步更新 proposal 与 execution。

## 范围与非目标

- [x] 仅保留 Android Home Widget + TWA 壳。
- [x] iOS Widget 不在范围内。
- [x] Widget 仅做只读摘要与打开应用，不做直接写操作。
- [x] 不承诺绝对实时，只承诺近实时与陈旧态提示。
- [x] 默认不把“今日统计”纳入 MVP。

## 启动与路由

- [x] Manifest `id` 继续保持 `/launch.html`。
- [x] 正式入口继续保持 `./`。
- [x] Android 深链统一走 `./#/projects...`。
- [x] `entry=widget|twa|shortcut` 与 `intent=` 继续作为显式启动信封。
- [x] 未知 `intent`、无效 `projectId/taskId` 必须安全降级到工作区。

## 数据与摘要

- [x] 云侧摘要主源是 `focus_sessions.session_state`。
- [x] `widget-summary` 输出稳定 DTO，不透传原始会话结构。
- [x] `summaryVersion` 覆盖 title/content/order/updatedAt 等展示相关字段。
- [x] 软删除目标统一过滤并回退工作区。
- [x] Widget 不冒充 Web 进程尚未 flush 的本地状态。

## 安全与隐私

- [x] `widget-register` 仅允许用户态注册或轮换。
- [x] `widget-summary` 通过 device token 鉴权，默认 `POST`。
- [x] `widget-summary` 响应声明 `private, no-store, max-age=0`。
- [x] Android 原生侧显式禁用共享 HTTP cache。
- [x] 默认隐私模式更保守，只显示计数与简化标题。
- [x] Android 首版不声明 `keyguard` widget category。
- [x] 账号退出与 A->B 换号已走 server-first revoke。
- [x] `binding_generation` 已进入验证链路。

## 实例边界

- [x] 明确区分 `user_id`、`installation_id`、`device_id`、`widget_instance_id`。
- [x] Android 多实例只承诺镜像同一份全局摘要，不承诺实例级项目绑定。
- [x] 本地缓存键按 `appWidgetId` 分离。
- [x] 无有效 token 时显示 setup/auth-required，不展示旧缓存冒充新状态。
- [x] 最后一个 widget 删除时清理 binding、cache、pending push 状态。

## 发布与熔断

- [x] 先有 kill switch / telemetry，再暴露用户可见入口。
- [x] 能按平台、版本、bucket 做 install / refresh / push 决策。
- [ ] release 级 `assetlinks.json` 仍需线上验真。
- [ ] FCM live provider 仍需闭合。
- [ ] 需要整理 Android-only 回滚 SOP。

## P0 Checklist：Web 入口与契约准备

- [x] `manifest.webmanifest` 已具备 Android 需要的静态 shortcuts。
- [x] 工作区壳层已支持统一解析 `entry` / `intent`。
- [x] 启动契约测试已覆盖 `manifest id`、`start_url`、shortcuts 与 `launch.html`。

## P1 Checklist：后端基础设施

- [x] 已完成 live schema / functions / advisors 基线确认。
- [x] `widget-register` 已支持注册、轮换、吊销。
- [x] `widget-summary` 已完成稳定响应契约与三维状态。
- [x] `widget-notify` 已具备 direct webhook、HMAC、幂等与限流。
- [x] `widget-summary` 与 `widget-notify` 日志链路已脱敏。
- [x] dirty signal 只推脏不推正文。

## P2 Checklist：Android 原生 Widget + TWA 壳

- [x] Android 路线保持 `TWA 打开应用 + Glance/RemoteViews 渲染 + WorkManager/FCM 刷新` 的角色分层。
- [x] TWA PostMessage 明确只是 optional fast path。
- [x] Web 侧已消费 Android bootstrap hash 参数并构造 `nanoflow-widget://bootstrap` 回调。
- [x] Android 宿主不会把 bootstrap 退化成每次打开都重新注册。
- [x] `widget-summary.entryUrl` 已进入 Android 打开应用路径。
- [x] Android 宿主已消费 `freshnessState + trustState + sourceState + degradedReasons`。
- [x] 隐私模式默认开启并已完成真机验证。
- [x] 至少一台后台限制明显的 MIUI 设备已纳入验证矩阵。
- [ ] release 包名与证书指纹的 `assetlinks.json` 线上验真待完成。
- [ ] FCM provider 与 live push fanout 待完成。
- [ ] bootstrap callback 的完整真人链路证据待补。

## P3 Checklist：Widget Action

- [ ] Android 只读链路稳定前，不讨论 Widget Action。
- [ ] 若未来进入 Action，必须走独立 Action Queue。
- [ ] Action token 不得复用只读 summary token。

## 可信度与反假阳性

- [x] `freshnessState` / `trustState` / `sourceState` 三维状态已落地。
- [x] `soft-delete-target`、`binding-mismatch`、`token-expired` 等降级语义已落地。
- [x] `RATE_LIMITED` / `WIDGET_REFRESH_DISABLED` 会保留最近一次有效上下文，不直接变空白。
- [ ] 真机长期观察仍需覆盖 Doze、弱网、后台受限与换号场景。

## QA 与发布门禁

- [ ] `assetlinks.json` release 验真完成。
- [ ] Android 实机 bootstrap 完整录屏或可复验证据完成。
- [ ] FCM dirty push 端到端完成。
- [ ] 账号切换、隐私模式、软删目标、kill switch 真机演练完成。

## 回滚就绪度

- [x] 可单独停用 Android 宿主发布。
- [x] 可单独停用 `widget-register`、`widget-summary`、`widget-notify`。
- [x] 可批量吊销 `widget_devices` / `widget_instances`。
- [x] 可移除 `assetlinks.json` 而不影响主应用入口。
- [ ] Android-only 回滚脚本与操作清单仍需补齐。
