# NanoFlow Android 原生宿主骨架说明

> 日期：2026-04-14  
> 适用范围：仓库内 `android/` 原生模块、TWA 宿主、Glance Widget、bootstrap 回调约定  
> 状态：仓库级骨架、contract 与 `assembleDebug` 编译验证已完成；未完成 Android 实机链路验证

## 背景与目标

当前仓库已经具备：

- `widget-register` / `widget-summary` / `widget-notify` 的后端基础设施。
- Web 侧统一的 `entry=shortcut|widget|twa` 启动信封。
- `assetlinks.json` 生成链、运行时平台识别和 startup trace 打点。

本次新增的 `android/` 目录当前解决三件事：

1. 给 Android 团队一个可继续接线的原生宿主骨架。
2. 把 Android 认证 bootstrap 的正确边界固定下来，避免后续把 native host 误写成可以直接裸调 `widget-register`。
3. 先把 bootstrap 回调的最小可信度门槛落下来，避免 exported deep link 被重放或伪造后直接覆盖本地绑定。

## 关键约束

- 原生宿主不能直接访问 Web 的 Supabase 登录态，因此不得由原生宿主直接无凭证调用 `widget-register`。
- Android correctness path 仍然是：TWA 打开 Web 应用 -> 已登录的 Web 会话完成 `widget-register` -> 通过回调 URI 把 `widgetToken` 等绑定结果交回原生宿主。
- Bootstrap 参数必须留在 `/#/projects?...` 的 hash 查询参数里，避免进入服务端访问日志。
- TWA PostMessage 仍然只是 optional fast path；当前骨架没有把它写成必需链路。
- 原生宿主当前只直接调用 `widget-summary`；`pushToken` 的上报由宿主先本地安全暂存，等下一次已登录 TWA bootstrap 时再一并交给 Web 会话完成注册。
- 原生宿主不会在每次 widget 按钮点击时都重复附带 bootstrap 参数；只有本地尚未绑定、绑定已失效、实例上下文失配或存在待上报 `pushToken` 时，才会以 `entry=twa + widgetBootstrap=1` 打开 TWA。正常的 widget 打开动作继续走 `entry=widget`，避免把 Android bootstrap 退化成“每次打开应用都重新注册一次”。
- 已绑定状态下，宿主应优先使用 `widget-summary.entryUrl` 打开当前 `project/task` 上下文；Web 壳清理一次性 `entry` / `intent` query 时只能移除启动信封，不能把已有深链接路径抹平成 `/projects`。
- 若强制 rebootstrap 发生在已有合法缓存摘要的实例上，宿主仍应把最近一次 `entryUrl` 的 `/#/projects/...` 路径带进新的 `entry=twa + widgetBootstrap=1` URL；只有完全没有可信上下文时才允许退回 `/#/projects`。
- `nanoflow-widget://bootstrap` 是 exported browsable deep link，因此宿主必须校验 `widgetInstallationId + widgetDeviceId + widgetHostInstanceId + widgetInstanceId + widgetBootstrapNonce` 与本地 pending bootstrap 状态一致，并拒绝超过 15 分钟的旧回调。
- Web 侧 bootstrap consumer 必须和 Windows/PWA widget runtime token 存储隔离；Android `widget-register` 结果只用于构造 native callback，不能写进 Web 端共享 IndexedDB 覆盖 `widget-runtime.js` 的现有 token。
- Web 侧在消费 bootstrap hash 参数后会立即 `replaceUrl` 清掉敏感 query，但 pending bootstrap 请求会暂存在 `sessionStorage`，保证同标签页刷新或登录后继续处理时不会丢失 Android 绑定上下文。
- 同一轮 bootstrap 为 same-tab reload 暂存到 `sessionStorage` 的 startup intent 必须在 bootstrap 成功或失败后立刻清掉，避免旧的 `open-focus-tools` / `open-blackbox-recorder` 意图污染后续普通启动。
- 当 `widget-summary` 明确返回 `DEVICE_REVOKED` / `BINDING_MISMATCH` / `TOKEN_EXPIRED` / `TOKEN_INVALID` 等绑定失效语义，宿主会清掉本地绑定；当最后一个 widget 被移除时，宿主还会清掉本地缓存、pending bootstrap 与 pending push token，避免重装后继续沿用陈旧状态。
- Android 宿主请求 `widget-summary` 时必须显式禁用共享 HTTP cache，并按 `freshnessState + trustState + sourceState + degradedReasons` 组合渲染状态文案；`soft-delete-target`、`cache-only` 这类受控降级不能继续显示成“云端同步中”。
- 对 `RATE_LIMITED` / `WIDGET_REFRESH_DISABLED` 这类瞬时降级，宿主还必须保留最近一次有效摘要的 focus / dock / `entryUrl` 上下文，只下调 `trustState/sourceState/statusLine`，不能把“打开应用”退回成无上下文的默认工作区。

## 模块结构

`android/` 当前包含：

- `app/build.gradle.kts`：应用模块与 TWA / Glance / WorkManager / FCM / DataStore / `EncryptedSharedPreferences` 依赖。
- `NanoflowTwaLauncherActivity`：统一打开 NanoFlow Web 应用的 TWA 入口。
- `NanoflowWidgetBootstrapActivity`：接收 `nanoflow-widget://bootstrap` 回调并写入本地绑定。
- `NanoflowBootstrapContract`：TWA hash 查询参数与回调 URI 的协议定义。
- `NanoflowWidgetRepository`：只读摘要拉取、bootstrap 消费、本地渲染模型构造。
- `NanoflowGlanceWidget` / `NanoflowWidgetReceiver`：Glance 小组件 UI 与接收器。
- `NanoflowWidgetRefreshWorker`：后台刷新与 widget 统一重绘。
- `NanoflowFirebaseMessagingService`：接收 `widget_dirty` 推送并触发刷新。

## Bootstrap 协议

### TWA 打开 URL

TWA 打开时，原生宿主会拼出类似下面的 URL：

```text
https://<web-origin>/#/projects?entry=twa&intent=open-workspace&widgetBootstrap=1&widgetInstallationId=...&widgetDeviceId=...&widgetDeviceSecret=...&widgetClientVersion=android-widget/0.1.0&widgetInstanceId=...&widgetHostInstanceId=...&widgetBootstrapNonce=...&widgetSizeBucket=...&widgetBootstrapReturnUri=nanoflow-widget://bootstrap
```

说明：

- 这些参数位于 hash 查询参数中，不会进入服务端路由日志。
- `widgetDeviceSecret` 仍属于敏感 bootstrap 数据，Web 侧必须在消费后立刻 `replaceUrl` 清掉，不能长期停留在地址栏历史里。
- `widgetClientVersion` 表示 Android 原生宿主版本标识，Web 会话会把它继续带进 authenticated `widget-register`，供后端做按版本 install / refresh / push 熔断。
- `widgetBootstrapNonce` 由宿主在每次打开 TWA 前重新生成，并写入本地 pending bootstrap 状态。

### 回调 URI

已约定的回调 URI：

```text
nanoflow-widget://bootstrap#widgetToken=...&widgetInstallationId=...&widgetDeviceId=...&bindingGeneration=...&expiresAt=...&widgetInstanceId=...&widgetHostInstanceId=...&widgetBootstrapNonce=...
```

原生宿主收到后不会立刻盲信写入，而是先做以下校验：

- `widgetInstallationId` 必须匹配当前宿主安装标识。
- `widgetDeviceId` 必须匹配当前宿主设备标识。
- `widgetHostInstanceId` 必须能在本地找到对应 widget 的 pending bootstrap。
- `widgetInstanceId` 必须匹配该 widget 当前仍在使用的本地实例标识，且该 host widget 仍然处于已安装状态。
- `widgetBootstrapNonce` 必须与本地 pending nonce 一致，且未超过 15 分钟 TTL。

只有全部通过后，宿主才会把绑定结果持久化；否则直接丢弃回调，不再额外访问 `widget-register`。

## 构建配置

当前 `android/app/build.gradle.kts` 会优先从以下来源读取配置：

- `nanoflow.android.applicationId` 或环境变量 `ANDROID_TWA_PACKAGE_NAME`
- `nanoflow.webOrigin` 或环境变量 `NANOFLOW_WEB_ORIGIN`
- `nanoflow.supabaseUrl` 或环境变量 `NG_APP_SUPABASE_URL`

这保证原生宿主不会把包名、Web origin 或 Supabase URL 写死到仓库里。

绑定敏感数据当前写入 `EncryptedSharedPreferences`，摘要缓存、实例映射和 pending bootstrap 状态仍保留在 DataStore，避免把 `widgetToken` / `deviceSecret` 明文落盘。

## 当前验证边界

已经完成：

- 仓库内 Android 原生宿主骨架落地。
- TWA / bootstrap / callback / widget-summary 的 contract test 落地。
- Web 侧已消费 Android bootstrap hash 参数，并会在已登录会话中调用 `widget-register` 后发放 `nanoflow-widget://bootstrap` 回调。
- Web 侧在清掉敏感 query 后会把 pending bootstrap 请求短暂保存在 `sessionStorage`，保证 same-tab reload 不会直接丢失绑定流程。
- Android 宿主现在只会在确实需要重绑时才附带 bootstrap 参数打开 TWA；正常 widget 跳转保留 `entry=widget`，首次绑定不再因为错误的 `entry` 值而被 Web 侧忽略。
- `widget-summary` 现在会按 current focus / valid dock 生成上下文 `entryUrl`；Android 宿主在非 bootstrap 的工作区打开路径会先做同源 + `#/projects` 校验后消费该 URL，Web startup shell 在清理一次性 startup query 时也会保留对应的 `project/task` 深链接。
- `widget-summary` 现已补齐 `focus.projectTitle` 与 `blackBox.gatePreview`；Android Widget 渲染合同明确为：专注模式未开启时优先展示 Gate（大门）待处理内容，专注模式开启时展示停泊坞中的主任务，并用模式标签、边框卡片和状态栏区分 Gate / Focus 两种主态。
- 当宿主因 `auth-required` / `pendingPushToken` 等原因被迫 rebootstrap 时，只要本地仍有合法缓存摘要，上述上下文路径也会继续带入 `entry=twa + widgetBootstrap=1` 的 URL；`soft-delete-target` 则会强制把 `entryUrl` 回退到工作区，避免误跳到其他 dock 项。
- bootstrap 回调已增加 pending nonce + TTL 校验，宿主不再接受任意 deep link 覆盖绑定。
- bootstrap 回调还要求 live widget instance 仍存在且 `widgetInstanceId` 匹配，删除后的 widget 不会再接受陈旧回调。
- 周期性 WorkManager fallback 已补齐，安装中的 widget 会保持唯一 periodic refresh 调度。
- 最后一个 widget 删除后，本地 binding / summary / pending push token 也会被一并清理，避免旧状态在真机重装后残留。
- `assetlinks.json` 生成链可以利用当前环境变量生成实际文件。
- 已完成仓库级 Android 构建验证：`npx vitest run src/tests/contracts/widget-backend.contract.spec.ts src/tests/contracts/android-host.contract.spec.ts --config vitest.config.mts` 与 `./android/gradlew -p ./android :app:assembleDebug` 在当前仓库版本通过，说明后端摘要合同、Android 宿主合同和最新 Glance UI 改动可以一起编译通过。
- 已完成一轮真机安装级验证：连接设备 `2410DPN6CC`（Android `16` / SDK `36`）上执行 `./android/gradlew -p ./android installDebug` 成功，`adb shell am start -W -n app.nanoflow.twa/app.nanoflow.host.NanoflowTwaLauncherActivity` 返回 `Status: ok`，且 `adb shell dumpsys appwidget` 已能看到 `app.nanoflow.twa/app.nanoflow.host.NanoflowWidgetReceiver` provider 注册到系统。

尚未完成：

- 当前 Android Widget 在专注模式未开启时会展示 `gatePreview.content`，这已经突破“默认只显示计数/简化标题”的更保守隐私假设；发布前仍需结合 `SEC-12` / `P2-05` 决定是否保留正文展示、引入 privacy mode，或仅在用户显式允许后开启。
- 上述真机验证发生时设备处于 `Dozing + SCREEN_STATE_OFF + keyguard showing`，因此当前只拿到了“已安装 / 可启动 / provider 已注册”的设备级证据，尚未拿到可视前台界面、widget 面板点击或 bootstrap 回调链路录屏。
- FCM provider 仍未打到 live push-enabled 阶段。

## 验证方式

运行：

```bash
npm run assetlinks:generate
npm run test:android:host
npx vitest run src/tests/contracts/widget-backend.contract.spec.ts src/tests/contracts/android-host.contract.spec.ts --config vitest.config.mts
npx vitest run src/utils/startup-entry-intent.spec.ts src/services/widget-binding.service.spec.ts src/workspace-shell.component.spec.ts --config vitest.config.mts
./android/gradlew -p ./android :app:assembleDebug
```

预期：

- `public/.well-known/assetlinks.json` 成功生成。
- Android host contract test 通过，且继续约束 native host 不得直接写 `widget-register`。
- Widget backend / Android host contract test 通过，且继续锁定 `gatePreview` + `focus.projectTitle` + Glance 卡片样式合同。
- Web 侧 bootstrap 解析与 callback 构造测试通过，且 Android 路径不会写入 Web widget runtime 的共享 IndexedDB token。
- Android 宿主 `assembleDebug` 通过，证明最新 Widget 渲染模型、字符串资源与 Glance UI 没有编译回归。

## 回滚方式

- 若决定暂停 Android 原生宿主路线，可整体删除 `android/` 模块。
- 同步删除 `docs/android-widget-host-scaffold.md` 与执行文档中的宿主骨架记录。
- 保留现有 Web / Supabase Android 前置准备，不影响 `assetlinks.json` 生成链和运行时平台探测。
