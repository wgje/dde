# NanoFlow Android 手机端小组件执行与验收文档

> 说明：文件路径沿用历史命名，内容已收缩为 Android-only 执行文档。桌面端小组件、桌面端宿主路线、组合 SW 与桌面端运行时不再属于验收范围。
> 来源：`docs/pwa-android-widget-cross-platform-proposal.md`、`docs/pwa-android-widget-cross-platform-implementation-checklist.md`
> 日期：2026-04-20
> 状态：执行基线

## 执行原则

1. 只围绕 Android 手机端小组件推进。
2. 阶段验收必须同时满足交付物、证据、阻塞项与回滚路径。
3. 任何边界变化都必须同步 proposal、checklist 与本执行文档。

## 当前阶段总览

| 阶段 | 范围 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| `P0` | Web 启动契约与入口信封 | `completed` | Android TWA / Widget 所需的启动协议已闭合 |
| `P1` | 后端基础设施 | `completed` | register / summary / notify / revoke / 限流 / kill switch 已闭合 |
| `P2` | Android Widget + TWA 壳 | `in-progress` | Android 宿主与真机基础证据已具备，release/FCM 仍待闭合 |
| `P3` | Widget Action | `blocked` | 后置，不在当前验收范围 |

## P0：Web 入口与契约准备

### 目标

- 稳定 Android TWA / Widget 的启动信封与深链降级。

### 当前结论

- `manifest id=/launch.html` 保持不变。
- 正式入口保持 `./`。
- `entry` / `intent` 已可被工作区壳层消费。
- 无效 `intent`、失效 `projectId/taskId` 已能安全回退工作区。

### 当前状态

- `completed`。

## P1：后端基础设施

### 目标

- 为 Android Widget 提供受控读模型、设备令牌与推脏链路。

### 已闭合内容

1. `widget-register`：注册、轮换、吊销、server-first revoke。
2. `widget-summary`：稳定 DTO、三维状态、`entryUrl`、软删降级、实例校验。
3. `widget-notify`：direct webhook、HMAC、幂等、限流、kill switch。
4. `widget_devices` / `widget_instances` / rate-limit / capability rules。
5. logout / account switch 后旧 token 失效。

### 当前状态

- `completed`。

## P2：Android 原生 Widget + TWA 壳

### 目标

- 打通 Android 宿主、bootstrap、摘要读取、隐私模式、实例生命周期与真机链路。

### 已交付内容

- Android 原生宿主骨架已落地：TWA launcher、widget receiver、refresh worker、Firebase messaging、bootstrap callback。
- Web 侧已消费 Android bootstrap 参数，并能通过 `nanoflow-widget://bootstrap` 回传 `widgetToken`。
- Android 宿主已消费 `entryUrl`、三维状态与降级原因。
- 隐私模式默认开启，已能隐藏正文与项目标题。
- 最后一个 widget 删除时会清理 binding、cache、pending bootstrap 与 pending push 状态。

### 已有证据

- 真机设备 `2410DPN6CC` 与 `24018RPACC` 已完成安装、provider 注册与 TWA 启动验证。
- `OPEN_WORKSPACE` 与 `OPEN_FOCUS_TOOLS` 的 TWA 前台链路已取证。
- `widget-summary` 的 `soft-delete-target`、换号清理、Doze 下 WorkManager RUNNABLE 已有验证记录。

### 当前未闭合项

- [ ] release 包名与证书指纹对应的 `assetlinks.json` 线上验真。
- [ ] FCM provider 与 live dirty push fanout。
- [ ] bootstrap callback 的完整真人登录链路证据。
- [ ] Android-only 回滚 SOP。

### 当前状态

- `in-progress`。

## 横向阻塞门禁

| 编号 | 门禁 | 状态 |
| --- | --- | --- |
| `G-A01` | `assetlinks.json` 已按 release 包名与证书指纹线上验真 | `open` |
| `G-A02` | FCM provider 与 dirty push 已完成端到端验证 | `open` |
| `G-A03` | bootstrap callback 已完成真人登录链路证据 | `open` |
| `G-A04` | server-first revoke、换号与失效清理继续成立 | `closed` |
| `G-A05` | 隐私模式默认保守且真机可见 | `closed` |

## 反假阳性要求

以下场景任意一项失守，都视为阻塞级失败：

1. 旧 token 在退出登录或换号后仍能读取摘要。
2. `soft-delete-target` 仍打开失效目标。
3. `RATE_LIMITED` / `WIDGET_REFRESH_DISABLED` 把上下文直接抹空，制造“像是没有任务”的假象。
4. 本地草稿被误显示成云端已确认状态。

## 遥测要求

当前至少需要继续保留并消费以下事件：

1. `widget_register_success` / `widget_register_failure`
2. `widget_summary_fetch_success` / `widget_summary_fetch_failure`
3. `widget_killswitch_applied`
4. `widget_account_switch_cleanup`
5. `widget_push_dirty_sent` / `widget_push_dirty_dropped`

## 回滚与故障处理

1. 停止 Android 原生宿主发布。
2. 停用 `widget-register`、`widget-summary`、`widget-notify`。
3. 批量吊销 `widget_devices` / `widget_instances`。
4. 移除 `assetlinks.json` 生成与部署变量。

## 执行记录

| 日期 | 阶段 | 动作 | 结果 |
| --- | --- | --- | --- |
| 2026-04-12 | `P0` | 完成 `entry` / `intent` 启动契约与 shortcuts 验证 | `completed` |
| 2026-04-13 | `P1` | 完成 live schema / functions / revoke / summary / notify 基础闭环 | `completed` |
| 2026-04-14 | `P2` | 打通 Android bootstrap producer 与宿主骨架 | `in-progress` |
| 2026-04-15 | `P2` | 完成隐私模式与真机启动/面板点击基础证据 | `in-progress` |

## 当前结论

NanoFlow 当前的手机端小组件已经不再受电脑端方案约束。

下一步真正需要关闭的是 Android 自身的发布前门禁，而不是继续维护任何桌面端小组件路径：

1. release `assetlinks.json`
2. FCM live push
3. bootstrap callback 完整真人链路
