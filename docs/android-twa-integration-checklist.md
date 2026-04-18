# NanoFlow Android TWA 集成清单

> 日期：2026-04-13  
> 适用范围：Android TWA 壳、Glance Widget 宿主、Vercel / Netlify 部署链  
> 目标：把当前仓库已经具备的 Web / Supabase 基础设施，转换成 Android 团队可以直接接入和验真的清单。

## 背景与目标

当前仓库已经具备：

- `widget-register` / `widget-summary` / `widget-notify` 的平台无关后端基础设施。
- `entry=shortcut|widget|twa` 与 `intent=` 的统一启动信封。
- `assetlinks.json` 的 build-time 生成链与静态部署头。
- Android / TWA 运行时识别与 startup trace 打点。

本清单只处理 Android 宿主接入需要的落地项，不改变 `P2` 仍受 `P1.5` 门禁约束这一事实。

## 关键约束

- `TWA` 只负责“打开 NanoFlow Web 应用”，不是 Widget 数据源。
- Android Widget 必须继续使用 `platform='android-widget'` 读取 `widget-summary`；`widget-register` 只能由已登录 Web 会话完成，不能把 TWA 壳与 Widget 实例身份混成一个 token。
- 所有 Android 深链继续使用 `./#/projects?...`，不得发明新的 `/focus`、`/dock`、`/capture` 顶级路径。
- `TWA PostMessage` 仍是 optional fast path，不属于 correctness path。
- `assetlinks.json` 必须使用真实 release `package_name + sha256_cert_fingerprints`；debug 指纹或占位值不能当生产证据。
- Android 首版本地缓存只能保留最小摘要字段，不保存完整任务正文或 Black Box 正文。

## 实施步骤

1. 配置 Digital Asset Links 生成参数。
   在部署环境或 `.env.local` 中设置：

   - `ANDROID_TWA_PACKAGE_NAME`
   - `ANDROID_TWA_SHA256_CERT_FINGERPRINTS`
   - 可选：`ANDROID_TWA_RELATIONS`

2. 生成并检查 `assetlinks.json`。

   运行：

   ```bash
   npm run assetlinks:generate
   ```

   说明：`npm run config` 也会自动执行同一生成链。若配置缺失，脚本会删除旧的 `public/.well-known/assetlinks.json`，避免 stale DAL 关系被继续部署。

3. Android TWA 壳统一使用显式启动信封。

   推荐入口：

   - `./#/projects?entry=twa&intent=open-workspace`
   - `./#/projects?entry=twa&intent=open-focus-tools`
   - `./#/projects?entry=twa&intent=open-blackbox-recorder`
   - 若 `widget-summary` 已返回 `entryUrl`，宿主应保留其中的 `/#/projects/...` 路径，只复用统一的 `entry` / `intent` 启动信封语义；不要把普通打开动作重新硬编码回 `./#/projects`。

4. Android Widget 安装后先走 authenticated Web bootstrap，而不是原生侧直接注册。

   关键约束：原生宿主拿不到 Web 的 Supabase 登录态，因此不得由原生宿主直接无凭证调用 `widget-register`。

   正确顺序是：

   - 原生宿主生成 `installationId`、`deviceId`、`deviceSecret`、`widgetClientVersion`、`instanceId`、`hostInstanceId`、`widgetBootstrapNonce`。
   - 只有在本地尚未绑定、绑定已失效、实例上下文失配或存在待上报 `pushToken` 时，宿主才会把这些值放进 `/#/projects?...` 的 hash 查询参数，并以 `entry=twa` 打开 TWA。
   - 正常 widget 按钮跳转不再重复携带 bootstrap 参数，仍直接走 `entry=widget` 的普通打开路径。
   - 已绑定状态下，“打开应用”应优先复用最近一次 `widget-summary.entryUrl` 指向的 `project/task` 上下文；Web 侧清理一次性 startup query 时也必须保留这条深链接路径。
   - 若强制 rebootstrap 发生在已有合法缓存摘要的实例上，宿主仍应把最近一次 `entryUrl` 的 `/#/projects/...` 路径一并带进 `entry=twa + widgetBootstrap=1` URL；只有完全没有可信上下文时才允许回退到 `./#/projects`。
   - bootstrap 期间为 same-tab reload 暂存到 `sessionStorage` 的 startup intent 只允许服务当前这一次 bootstrap；一旦 bootstrap 成功或失败，必须立刻清掉，避免后续普通启动重放旧的 `open-focus-tools` / `open-blackbox-recorder` 意图。
   - 已登录的 Web 会话消费这些 hash 参数，立即 `replaceUrl` 清掉敏感 query，并把 pending bootstrap 请求暂存到 `sessionStorage` 后调用 `widget-register`；其中 `widgetClientVersion` 必须继续带入注册请求，确保后端 install kill switch 看到真实 Android host 版本。
   - Web 会话通过 `nanoflow-widget://bootstrap` 回调 URI 把 `widgetToken`、`widgetInstallationId`、`widgetDeviceId`、`bindingGeneration`、`expiresAt`、`widgetInstanceId`、`widgetHostInstanceId`、`widgetBootstrapNonce` 交回原生宿主。

   宿主验收规则：回调只有在 `installationId/deviceId/hostInstanceId/instanceId/bootstrapNonce` 同时匹配本地 pending bootstrap，且未超过 15 分钟 TTL 时才允许写入绑定；若 widget 已被删除或 instanceId 已轮换，则必须直接拒绝该回调。

   Web 侧附加约束：Android bootstrap 虽然复用 `widget-register`，但不得把返回的 Android token 写进 Web widget runtime 共享 IndexedDB；Windows/PWA 的 `widget-runtime.js` token 必须继续由各自平台注册链路维护。

   当前仓库内的原生骨架已经固定了这个 callback URI 与参数命名，详见 `docs/android-widget-host-scaffold.md`。

5. Android Widget 刷新时执行实例级摘要读取。

   调 `widget-summary` 时必须带：

   - `Authorization: Bearer <widget token>`
   - `platform='android-widget'`
   - `instanceId=<appWidgetId 对应的实例 ID>`

   原生 HTTP 请求还必须显式 `no-store / no-cache`，避免共享 HTTP cache 参与摘要复用；展示层要按 `freshnessState + trustState + sourceState + degradedReasons` 区分“同步中”“缓存回退”“目标已失效”等不同状态，不能把所有 `provisional` 都渲染成同一句“云端同步中”。`RATE_LIMITED` / `WIDGET_REFRESH_DISABLED` 这类瞬时降级还必须继续保留最近一次有效摘要的 focus / dock / entryUrl 上下文，不能把“打开应用”回退成无上下文的工作区；而 `soft-delete-target` 必须明确回退工作区，不能悄悄跳去别的 dock 项。

6. FCM push token 先本地暂存，等下一次 authenticated bootstrap 再回写。

   当前骨架里 `FirebaseMessagingService` 只会把新的 `pushToken` 暂存到本地安全存储，并触发刷新；真正把它带进 `widget-register` 仍需要下一次已登录 TWA bootstrap。

7. 最后一个 widget 删除时清空本地绑定残留。

   当前宿主在最后一个 widget 被移除时，会同步清掉本地 binding、summary cache、pending bootstrap 与 pending push token；重新添加 widget 时必须重新走 bootstrap，不能继续复用陈旧本地状态。

8. 把 TWA / Android 宿主联调结果接入 startup trace。

   当前 Web 侧会记录：

   - `runtimePlatform`
   - `runtimeOs`
   - `runtimeDisplayModes`
   - `runtimeAndroidHostPackage`

   Android 真机联调时，应检查这些字段是否已从 `browser-tab` 切到 `twa-shell`，并确认 `runtimeAndroidHostPackage` 为真实宿主包名。

## 验证方式

1. 运行本地契约测试：

   ```bash
   npm run test:prepare-env
   npx vitest run src/tests/assetlinks-contract.spec.ts src/utils/runtime-platform.spec.ts src/utils/startup-entry-intent.spec.ts src/services/widget-binding.service.spec.ts src/workspace-shell.component.spec.ts src/tests/contracts/android-host.contract.spec.ts --config vitest.config.mts
   ```

2. 部署后访问：

   - `https://<your-domain>/.well-known/assetlinks.json`

   预期：返回合法 JSON 数组，且 `target.namespace='android_app'`、`target.package_name` 与 release 包名一致。

3. Android 实机打开 TWA 壳后，检查 startup trace。

   预期：`runtimePlatform='twa-shell'`，并出现正确的 `runtimeAndroidHostPackage`。

4. Android Widget 首次安装后验证 bootstrap / summary。

   预期：已登录 Web 会话完成 `widget-register` 后，通过 `nanoflow-widget://bootstrap` 回调把 `widgetToken` 与匹配的 `widgetBootstrapNonce` 带回原生宿主；随后 `widget-summary` 在 `platform='android-widget' + instanceId` 条件下返回 200 或受控降级，而不是 `INSTANCE_CONTEXT_REQUIRED`。

## 回滚或故障处理

- 若 Android TWA rollout 暂停：移除 `ANDROID_TWA_PACKAGE_NAME` / `ANDROID_TWA_SHA256_CERT_FINGERPRINTS`，重新运行 `npm run config`，脚本会删除旧的 `assetlinks.json`。
- 若出现错误包名或错误证书指纹：先修正环境变量，再重新生成与部署，禁止手工改线上静态文件后不回写仓库流程。
- 若 startup trace 仍显示 `browser-tab`：优先排查 Android 宿主是否真的以 TWA 打开、DAL 是否可验证、Chrome 版本是否满足要求。
- 若 Android Widget 仍报 `auth-required` 或 `instance-context-required`：优先检查 bootstrap 回调是否成功把最新 `widgetToken` 写回宿主，以及原生侧是否正确传入 `platform='android-widget'`、`instanceId`。
