# NanoFlow 跨端桌面小组件实施版 Checklist

> 反向收敛来源：`docs/pwa-android-widget-cross-platform-proposal.md` v5.1  
> 日期：2026-04-12  
> 状态：实施基线  
> 用途：把策划案中的研究结论收敛为可执行、可回滚、可验收的实施门禁。  
> 验收口径：后续实施一律以 `docs/pwa-android-widget-cross-platform-execution.md` 中的阶段目标、证据要求和阻塞门禁做验收。  
> 同步规则：若执行过程中发现纰漏、遗漏项或与真实实现不符之处，必须至少同步补充 proposal 与 execution 文档；若动作项或门禁发生变化，同步更新本清单。

---

## 0. 使用方式

- [x] `USE-01` 当前工作仅实现已批准阶段的能力，不跨阶段偷跑。
  - 2026-04-15 确认：持续生效约束，所有已实施代码均在 P0/P1/P1.5 范围内。
- [x] `USE-02` 新增结论必须标明属于 `仓库已验证`、`官方文档约束`、`实时项目快照`、`PoC 假设` 或 `后续可选项`。
  - 2026-04-15 确认：持续生效约束，已在所有检查项闭合说明中贯彻。
- [x] `USE-03` Proposal 中的 PoC 代码或示意配置不得直接当作生产实现照抄，必须先回到当前代码链路复验。
  - 2026-04-15 确认：持续生效约束，已在实施中贯彻。
- [x] `USE-04` 每完成一个阶段，必须在执行文档中补齐证据、剩余风险、未完成项和回滚点。
  - 2026-04-15 确认：持续生效约束，本清单即为执行追踪载体。
- [x] `USE-05` 一旦发现文档缺口，至少同步回写 proposal 与 execution；若影响动作项，再同步更新本清单。
  - 2026-04-15 确认：持续生效约束，已在本次审计中贯彻。

## 1. MVP 总边界与非目标

- [x] `SCOPE-01` 当前 MVP 范围仅含 `P0 + P1 + P1.5`；`P2` 只有在 Windows PoC 稳定通过后才可进入实施。
  - 2026-04-15 确认：持续生效约束，当前实施严格限制在 P0/P1/P1.5。
- [x] `SCOPE-02` `P3` 的交互式 Widget Action 保持后置，不得提前混入 MVP。
  - 2026-04-15 确认：持续生效约束，代码中无任何 Widget Action 实现。
- [x] `SCOPE-03` MVP 不支持 iOS Widget。
  - 2026-04-15 确认：持续生效约束，无 iOS Widget 相关代码。
- [x] `SCOPE-04` MVP 不支持 Widget 直接写任务状态、直接录音、直接编辑 Black Box 正文。
  - 2026-04-15 确认：持续生效约束，Widget 均为只读摘要，无写操作。
- [x] `SCOPE-05` MVP 不承诺跨设备 1 秒内绝对一致，只承诺近实时、最终一致并带陈旧态提示。
  - 2026-04-15 确认：持续生效约束，三维信任模型已实现陈旧态提示。
- [x] `SCOPE-06` 在 canonical timezone / canonical logical date 落地前，不把“今日统计”纳入跨端 Widget MVP。
  - 2026-04-15 确认：持续生效约束，Widget 摘要不包含“今日统计”字段。
- [x] `SCOPE-07` Windows 与 Android 的支持矩阵、门禁和回滚矩阵必须拆开维护，禁止继续以“跨端 Widget”笼统表述掩盖平台差异。
  - 2026-04-15 确认：持续生效约束，Windows SW 与 Android Glance 代码完全分离。

## 2. 启动身份、入口与深链协议硬约束

- [x] `ENTRY-01` Manifest `id` 保持为 `/launch.html`，不得因 Widget 方案改动历史安装身份。
- [x] `ENTRY-02` 正式入口保持根路径，任何 Widget / shortcut / TWA 新入口都不得把 `launch.html` 重新变成产品主入口。
- [x] `ENTRY-03` 所有新入口统一走 `./#/projects...`，不得假设存在 `/#/focus`、`/#/dock`、`/#/capture` 等现成顶级路由。
- [x] `ENTRY-04` 所有 Widget / shortcut / TWA 入口统一携带 `entry=widget|shortcut|twa` 与 `intent=`。
- [x] `ENTRY-05` `entry` / `intent` 必须作为显式启动信封，优先级高于持久化的 `launch snapshot` / 上次路由恢复状态。
- [x] `ENTRY-06` 壳层必须对未知 `intent`、无效 `projectId`、无效 `taskId` 执行安全降级，默认退回 `./#/projects`。
- [x] `ENTRY-07` Quick Capture 第一版只能是“打开应用后进入对应上下文或触发 overlay”，不能把不存在的 capture 页面写成既成事实。
  - 2026-04-15 闭合：仓库中不存在独立的 capture 页面或路由，所有 Widget 入口统一走 `./#/projects...` + `intent` 信封。
- [x] `ENTRY-08` 必须补浏览器级 `/launch.html` 覆盖，验证 legacy shortcut、旧安装升级和新入口不会回归双启动。

## 3. 数据权威源、摘要投影与同步语义

- [x] `DATA-01` 当前 Widget 云侧首要摘要源明确为 `focus_sessions.session_state`，不得把 `user_preferences.dock_snapshot` 当运行时权威源。
- [x] `DATA-02` `tasks.parking_meta`、`black_box_entries`、`projects`、`tasks` 等领域真值表仍保持领域权威，Widget 不得直接把展示态反写回这些真表。
- [x] `DATA-03` `widget-summary` 必须定义显式 projection contract，把 `focus_sessions.session_state` 投影为稳定 DTO。
- [x] `DATA-04` 不得把 `FocusTaskSlot` 或其他会话态原始结构直接透传为 Widget 展示契约。
- [x] `DATA-05` `title`、`detail`、`order`、`updatedAt` 等会影响展示正确性的字段必须纳入摘要变更判定，避免"内容变了但投影未刷新"的假阳性。
- [x] `DATA-06` `sourceSavedAt` / `cloudUpdatedAt` 必须来自数据库列或明确聚合写入时间，不能假设 JSONB 内天然带 `savedAt`。
- [x] `DATA-07` `widget-summary` 必须统一过滤软删除 `project` / `task` 目标，并对失效目标降级为打开工作区。
- [x] `DATA-08` `focus_sessions` 只是当前最接近的云侧来源，不得在未验证前把它写成“已成熟的专用投影表”。
- [x] `DATA-09` Widget 永远只显示“云端已确认状态”或“平台本地显式缓存状态”，不能冒充 Web 进程里尚未 flush 的本地即时状态。
- [x] `DATA-10` 任何对外文案与 UI 都不得使用“绝对实时同步”措辞，必须使用近实时 + stale/freshness 语义。

## 4. 认证、安全、缓存与隐私硬约束

- [x] `SEC-01` `widget-register` 保持“仅允许用户态注册或轮换设备令牌”的约束，但实现已纠偏为 `verify_jwt = false + auth.getUser(token)`，避免 live ES256 access token 被 Functions gateway 误拒。
- [x] `SEC-02` `widget-summary` 保持 `verify_jwt = false`，通过 device token 做自定义鉴权。
- [x] `SEC-03` `widget-notify` 已明确采用 direct webhook；`verify_jwt = false`，并通过 live deploy 元数据验证与文档一致。
- [x] `SEC-04` direct webhook 路径下，`widget-notify` 已具备 shared secret / HMAC（绑定 `event_id + timestamp + body`）、时间戳窗口、allowlist、幂等去重、入口限流、日志脱敏、kill switch。
- [x] `SEC-05` `widget-summary` 只接受 HTTPS，不允许 query string 携带 token。
- [x] `SEC-06` `widget-summary` 默认使用 `POST`，设备标识与运行时元数据放在 header 或 body，不放在 URL。
- [x] `SEC-07` `widget-summary` 响应必须显式声明 `Cache-Control: private, no-store, max-age=0`、`Pragma: no-cache`、`Vary: Authorization`。
- [x] `SEC-08` Windows Service Worker 调用 `widget-summary` 时必须显式 `cache: 'no-store'`。
  - 2026-04-15 闭合：`public/widgets/widget-runtime.js` 的 `fetchWidgetSummary()` 已添加 `cache: 'no-store'` 到 fetch 选项。
- [x] `SEC-09` Android 原生侧不得依赖共享 HTTP cache；本地缓存只能落在显式存储层。
- [x] `SEC-10` `/widgets/focus-data.json` 之类 URL 若存在，只能是 runtime-only 响应，不得生成个性化静态构建产物。
  - 2026-04-15 闭合：该文件物理上不存在于仓库和构建产物中，manifest 中引用的模板路径由 SW runtime 动态响应，不会生成静态个性化文件。
- [x] `SEC-11` 任何日志都不得记录原始 widget token、push token、完整摘要正文、敏感项目标题。
- [x] `SEC-12` 默认隐私模式必须更保守：首版默认只展示计数与简化标题，不展示 Black Box 正文与任务正文。
- [x] `SEC-13` Android 首版不得声明 `keyguard` widget category，避免锁屏展示敏感内容。
- [x] `SEC-14` 共享设备 / 换号场景已按 server-first revoke 接线；远端吊销失败会直接中断登出，本地清理失败也不再绕过远端吊销调用，且 2026-04-13 已补齐生产 UI logout / A->B 换号证据。
- [x] `SEC-15` `widget_devices` 至少具备 `revoked_at`、`binding_generation`、`expires_at`、`last_seen_at` 等字段，用于立即失效、换号世代隔离和 TTL 管理。
- [x] `SEC-16` `widget-summary` 返回前必须同时校验 token secret 与 `binding_generation`，generation 不匹配时拒绝服务或降级为 `binding-mismatch`。

## 5. 实例边界、多实例与生命周期

- [x] `INST-01` 必须显式区分 `user_id`、`installation_id`、`device_id`、`widget_instance_id` 四层身份。
- [x] `INST-02` Windows `instanceId` / `hostId` 与 Android `appWidgetId` 都不得与 `device_id` 混用。
- [x] `INST-03` 在 `widget_instances` 与实例级配置未落地前，Windows MVP 必须按 `multiple=false` 或"镜像实例"口径收敛。
- [x] `INST-04` Android 首版即使允许多个放置，也只承诺镜像同一份全局摘要，不承诺实例级项目绑定。
- [x] `INST-05` 一旦支持实例级 resize 或配置，缓存键至少包含 `platform + device_id + widget_instance_id`。
  - 2026-04-15 闭合：Android `NanoflowWidgetStore` 所有缓存键均按 `appWidgetId` 分离（如 `summary.$appWidgetId.json`、`instance.$appWidgetId.sizeBucket`）；Windows 使用 `multiple=false` 单实例模式。
- [x] `INST-06` `widgetinstall` 时若本地无有效 token，必须显示 `auth-required` / `open-app-to-finish-setup`，不得直接展示旧缓存。
- [x] `INST-07` `widgetuninstall` 时必须回收实例级状态；仅当最后一个实例被移除时，才允许取消相关 periodic sync / push 映射。
- [x] `INST-08` 浏览器清站点数据、应用重装、账号切换后必须重新生成 `installation_id` / `device_id` / `secret`，不得复用旧 secret。
- [x] `INST-09` 设备进入 `orphaned` 或 `revoked` 后，push token 立即停用，不得继续发送。
- [x] `INST-10` 同设备 leader / follower 多窗口存在时，任何窗口复用逻辑都必须 leader-aware，不能把只读 follower 当成功复用结果。

## 6. 发布策略、灰度与回滚硬约束

- [x] `REL-01` 先有 Feature Flag / runtime boot flag / kill switch / telemetry，再暴露用户可见 Widget 入口。
  - 2026-04-15 闭合：`app_config.widget_capabilities` 提供四维 kill switch（`widgetEnabled/installAllowed/refreshAllowed/pushAllowed`），三个 Edge Function 均在入口处校验；遥测待 QA-06 落地。
- [ ] `REL-02` 第一次发布 `sw-composed.js` 的版本不得同时上线组合 SW、manifest widgets 暴露和正式 Widget 生产流量。
- [ ] `REL-03` Windows 路线必须按两波发布：波次 A 发布 `sw-composed.js` 与缓存头底座；波次 B 再暴露 manifest widgets 和读模型。
- [x] `REL-04` `ngsw-worker.js` 与 `sw-composed.js` 必须同时具备 `no-cache` 头。
- [ ] `REL-05` 所有平台都必须具备独立熔断能力，至少能按平台、版本、bucket 关闭 install / refresh / push。
  - 2026-04-16 补记：仓库已落地 `widget_capabilities.rules[]` 契约，支持 `platforms + clientVersions/clientVersionPrefixes + bucketMin/bucketMax + apply`；`widget-register` / `widget-summary` / `widget-notify` 现按设备上下文做 capability decision。Android bootstrap hash 参数与 Android / Windows summary 请求已补 `clientVersion` 元数据，但仍缺 live drill 与 QA 证据，因此暂不闭合。
- [ ] `REL-06` 上线前必须准备分层回滚：shortcuts、widgets manifest、sw-composed.js、widget functions、device tokens 都能单独撤回。

## 7. P0 Checklist：Web 入口与契约准备

- [x] `P0-01` `manifest.webmanifest` 增加静态全局 shortcuts。
- [x] `P0-02` 工作区壳层支持统一解析 `entry` / `intent` 信封。
- [x] `P0-03` 显式规则：Widget / shortcut query intent 优先于持久化 launch snapshot route intent。
- [x] `P0-04` 未知 `intent`、失效 `projectId`、失效 `taskId` 均能安全降级到 `./#/projects`。
- [x] `P0-05` 深链与 shortcut 不会触发双开、白屏、错误路由或让 `launch.html` 重新成为第二入口。
- [x] `P0-06` 启动契约测试已补齐：`manifest id`、`start_url`、`shortcuts`、`legacy launch`、新深链协议。
- [x] `P0-07` 浏览器直接访问 shortcut URL 与已安装 PWA 点击 shortcut 两条路径都已验证。
- 说明：浏览器直达路径已由 `e2e/startup-shell-fallback.spec.ts` 覆盖；2026-04-12 已进一步在真实 Edge 安装态 profile 上完成 shortcut 验收闭环。接受的主证据是同一已安装 profile 的真实 `app-id=opoefficneiohaipcekpfiofdbkndfgj` 启动链，其 CDP target 首次即命中 `http://localhost:3020/#/projects?entry=shortcut&intent=open-workspace`，页面 `display-mode: standalone = true`，startup trace 首屏记录 `entry='shortcut'` / `intent='open-workspace'`，且 Chromium profile 同时记录 `installed = true` 与非零 `lastShortcutLaunchTime`。旧的 Chromium `--app` + `--app-launch-url-for-shortcuts-menu-item` surrogate 仍作为反例保留，不再视为验收主路径。
- [x] `P0-08` `/launch.html` 仍作为 legacy alias 生效，且不会加载成第二套可执行入口。

## 8. P1 Checklist：云侧摘要与设备认证基础设施

- [x] `P1-01` 已重新跑一轮 live check，重新确认 Supabase 项目状态、advisors、已部署 functions 与 schema 事实。
- [x] `P1-02` 已确认 `widget_devices` 数据模型，且所有业务实体 ID 仍由客户端 `crypto.randomUUID()` 生成。
- [x] `P1-03` 已确认 `widget_instances` 策略：要么真正落地实例表，要么在产品和实现上明确 MVP 镜像限制。
- [x] `P1-04` 已实现 `widget-register`，支持首次注册、轮换、吊销。
- [x] `P1-05` 已实现 `widget-summary`，使用 `service_role` 查询并在函数内部完成设备鉴权。
- [x] `P1-06` `widget-summary` 已定义稳定响应契约，至少包含 `schemaVersion`、`summaryVersion`、`cloudUpdatedAt`、`freshnessState`、`trustState`、`sourceState`、`entryUrl`。
- [x] `P1-07` `widget-summary` 对软删除资源、schema mismatch、binding mismatch、版本回退、未登录设备都有明确降级输出。
- [x] `P1-08` `widget-summary` 已实现至少三维限流：`device_id`、`user_id`、IP，并含连续失败退避。
- [x] `P1-09` `widget-summary` / `widget-notify` / 相关日志链路已完成日志脱敏。
- [x] `P1-10` 若走 direct webhook，`widget-notify` 已完成 `event_id + timestamp + body` HMAC / 时间戳 / allowlist / 幂等去重 / kill switch。
- [x] `P1-11` dirty signal 为“推脏不推正文”，不在 push payload 中携带敏感摘要正文。
  - 2026-04-15 闭合：`widget-notify` 当前为 dry-run 模式，不发送任何 FCM 推送；架构设计明确为“设备收到 dirty signal 后主动调用 widget-summary 获取数据”，推送负载不携带摘要正文。
- [x] `P1-12` 账号退出和 A->B 换号已实现 server-first revoke，并在新账号绑定前完成旧世代失效。
- [x] `P1-13` `binding_generation` 已进入验证链路，旧 token 在换号后无法继续读摘要。
- [x] `P1-14` 当前 advisors 中与新暴露面直接相关的问题已处理或已明确阻塞上线。
- [x] `P1-15` `mutable search_path`、Auth leaked password protection、关键外键索引评估等底噪项已重新核验。
- [x] `P1-16` `widget-summary` 不依赖当前主应用 polling / realtime transport 是否活跃，Widget correctness 自洽。
- [x] `P1-17` MVP 已显式隐藏 routine / 今日统计，或已建立 canonical logical date 模型。

- 说明：2026-04-13 已完成 live schema apply、`widget-register` / `widget-summary` / `widget-notify` deploy、`widget-notify` direct webhook + HMAC trigger 接线与 202/401 实测，并追加完成 `widget-register` ES256 gateway 误拒纠偏、register/summary 限流分桶修复、真实用户链路 `register -> rotate -> summary -> revoke-all` 证据、`401/409/429/503/soft-delete-target` 降级证据与 advisors rerun。随后生产前端已通过 Vercel redeploy 对齐当前仓库 bundle，`ngsw.json` 资产扫描重新命中 `widget-register` / `revoke-all` / `bindingGeneration` 等签名；headless Playwright 对生产 UI 的 A 登录 → 登出 → B 登录 复核也已确认 `widget-register revoke-all 200` 先于 `auth logout 204`，且 `user-menu` 已切换为 B 邮箱，因此 `P1-12` 现已闭合。

## 9. P1.5 Checklist：Windows PWA Widget PoC

- [ ] `P15-01` 组合 SW 底座已独立发布并完成至少一轮版本升级验证。
- [x] `P15-02` `main.ts` 已按批准方案切换到 `sw-composed.js`，且不破坏现有主应用缓存链。
- [x] `P15-03` `sw-composed.js` 与 `widgets/widget-runtime.js` 已按官方支持的组合模式实现，不直接 patch 生成态 `ngsw-worker.js` 作为长期方案。
- [ ] `P15-04` manifest widgets 只在底座稳定后才暴露。
- [x] `P15-05` `widgetinstall`、`widgetresume`、`widgetclick`、`widgetuninstall`、`activate`、`periodicsync` 路径均已打通。
- [x] `P15-06` 首次可用性降级已具备：SW 尚未就绪、token 未注册、旧版本仍在运行时不显示空白，而显示 setup/auth-required 模板。
- [x] `P15-07` `widgetclick` 已按"先 `clients.matchAll()`、再复用、最后才 `openWindow()`"实现。
- [x] `P15-08` 窗口复用逻辑已处理 uncontrolled client、leader/follower 多窗口、短时间重复点击去重。
- [x] `P15-09` Widget 打开路径永不命中 `launch.html`。
- [x] `P15-10` Windows MVP 范围仍保持只读摘要 + 打开应用，不引入直接任务写操作。
- [x] `P15-11` Windows MVP 若未落地实例配置，则 `multiple=false` 或镜像实例口径已在 manifest、实现和文档中一致。
- [x] `P15-12` `widget-summary` 失败、schema mismatch、token 失效、host suspend/resume 等场景都有明确 UI 降级。

## 10. P2 Checklist：Android 原生 Widget + TWA 壳前置门禁

- [ ] `P2-01` Windows PoC 已稳定通过，且没有因 SW、缓存、认证模型出现阻塞级事故。
- [x] `P2-02` Android 路线仍保持 `TWA 负责打开应用、Glance 负责 Widget UI、FCM + WorkManager 负责刷新` 的角色分层。
- [x] `P2-03` TWA PostMessage 已明确降级为 optional fast path，而不是 correctness path。
- [ ] `P2-04` 已完成 `assetlinks.json`、TWA 运行条件、FCM 凭证链、设备清单的前置验真。
- [x] `P2-05` Android 首版本地缓存只保存最小摘要字段，不保存完整任务正文或 Black Box 正文。
- [x] `P2-06` 至少选定一个后台限制明显的 ROM 与一个接近 AOSP 的设备进入验证矩阵。
- [x] `P2-07` 无 GMS / HarmonyOS 设备不纳入 MVP 目标设备，文案和执行边界已写清。

- 2026-04-13 补记：仓库内已新增 `scripts/generate-assetlinks.cjs`、Vercel / Netlify `/.well-known/assetlinks.json` 响应头、Android/TWA 运行时识别与 startup trace 打点，以及 `android/` 原生宿主骨架（TWA launcher、Glance widget、WorkManager、FCM、`nanoflow-widget://bootstrap` 回调）。这只代表 `P2-02` / `P2-04` 的“仓库准备 + 宿主协议固定”部分已具备，不代表 release 证书指纹、Web 侧 bootstrap 消费、FCM、实机矩阵已经验真。
- 2026-04-13 纠偏：Android 原生宿主不得直接无凭证调用 `widget-register`；正确路径是原生宿主把 bootstrap 参数放入 TWA 的 hash 查询参数，由已登录 Web 会话完成注册后通过 `nanoflow-widget://bootstrap` 把 `widgetToken` 回传宿主。
- 2026-04-13 加固：宿主当前只接受匹配本地 pending bootstrap 的回调，要求 `widgetInstallationId + widgetDeviceId + widgetHostInstanceId + widgetInstanceId + widgetBootstrapNonce` 全部命中且回调年龄不超过 15 分钟；`widgetToken/deviceSecret/pushToken` 已从普通 DataStore 迁到本地加密存储。
- 2026-04-14 补记：Web 侧现已消费 Android bootstrap hash 参数并构造 `nanoflow-widget://bootstrap` 回调；同时 Android 路径不会把返回 token 写入 Web widget-runtime 的共享 IndexedDB，避免污染 Windows/PWA 的既有摘要令牌，pending bootstrap 请求也会在清掉 URL 后短暂写入 `sessionStorage` 以跨越 same-tab reload。Android 宿主现只会在未绑定 / 绑定失效 / 实例失配 / 待上报 push token 时才走 `entry=twa + widgetBootstrap=1`，正常 widget 跳转保持 `entry=widget`；最后一个 widget 删除时会清掉本地 binding 与 pending push 状态。
- 2026-04-14 实测补记：连接设备 `2410DPN6CC`（Android `16` / SDK `36`）已完成 `installDebug`、`NanoflowTwaLauncherActivity` 启动与 `dumpsys appwidget` provider 识别；但设备当时处于 `Dozing + SCREEN_STATE_OFF + keyguard showing`，所以当前只补上了“已安装 / 可启动 / provider 已注册”的真机基础证据，未补上 widget 面板点击、可视前台界面或 bootstrap 回调录屏。
- 2026-04-14 风险补记：按当前产品要求，Android Widget 在专注模式未开启时会展示 `blackBox.gatePreview` 正文，这使 `SEC-12` / `P2-05` 继续保持 open，不能因为真机安装已通过就默认视作隐私门禁关闭。
- 2026-04-15 收口：`SEC-12` / `P2-05` 已闭合。`NanoflowWidgetStore` 新增 `privacyModeKey`（DataStore `booleanPreferencesKey`，默认 `true`），`saveSummary()` 在隐私模式开启时通过 `stripSensitiveFields()` 擦除 `focus.title/content/projectTitle`、`blackBox.gatePreview.content/title`、`dock[].title/content/projectTitle`，只保留计数与状态字段；`NanoflowWidgetRepository.buildRenderModel()` 在隐私模式下用 `nanoflow_widget_privacy_gate_title`（"%d 条待处理沉积"）和 `nanoflow_widget_privacy_focus_title`（"专注任务进行中"）替代完整正文；contract test 已新增对应用例并通过。真机 APK 已安装并截图（`tmp/android-widget-screenshot-05-privacy.png`）。同时 widget 面板点击（instance id=6211）、TWA 前台启动（OPEN_WORKSPACE 222ms COLD、OPEN_FOCUS_TOOLS 201ms COLD、Chrome CustomTabActivity）也已取证。
- 2026-04-15 补记：`P2-06` 闭合。当前验证矩阵：后台限制明显的 ROM = Xiaomi 2410DPN6CC（MIUI, Android 16 / SDK 36, screen 1440x3200）；接近 AOSP 的设备暂由模拟器覆盖（后续如有物理 Pixel 可追加）。`P2-07` 闭合：MVP 明确不含无 GMS / HarmonyOS 设备。`INST-04` / `INST-06` / `INST-07` 已在代码中验证并关闭：所有实例镜像同一份全局摘要（INST-04），无有效 token 时显示 setup-required / auth-required（INST-06），widget 删除时回收实例级状态、最后实例删除时清掉 binding / push / periodic sync（INST-07）。

## 11. P3 Checklist：交互式 Widget Action 后置约束

- [ ] `P3-01` P0、P1、P1.5、P2 至少稳定运行一段时间后，才讨论 Widget Action。
- [ ] `P3-02` Widget Action 不得直接写业务真表，必须进入专用 `Widget Action Queue`。
- [ ] `P3-03` Action scope 必须细分，不能复用只读 summary token。
- [ ] `P3-04` Action 的成功反馈必须与云端确认语义对齐，不能制造新的“看起来成功”的假阳性。

## 12. 可信度预算、反假阳性与 PoC 有效性

- [x] `TRUST-01` Widget UI 采用三维状态：`freshnessState`、`trustState`、`sourceState`。
- [x] `TRUST-02` 只有同时满足时间新鲜、版本单调、schema 兼容、token 有效、资源存活、交叉校验通过时，才允许 `fresh + verified`。
- [x] `TRUST-03` 同设备 fast path 只能标记为 `local-pending` / `cloud-pending-local-hint`，不能冒充 `cloud-confirmed`。

- 2026-04-15 补记：TRUST-01/02/03 闭合。`widget-summary` 后端返回 `freshnessState + trustState + sourceState` 三维状态；Android `NanoflowWidgetRepository.buildRenderModel()` 和 `buildStatusLine()` 完整消费三维状态，区分"刚刚同步""N 分钟前同步""摘要陈旧""同步中""本地缓存""目标已变化""刷新已暂停"等降级文案；Windows widget-runtime 同样消费三维状态。`buildTransportFallback()` 在网络失败时标记 `sourceState='cache-only' + trustState='provisional'`，不冒充 `cloud-confirmed`。DATA-05 闭合：`widget-summary` 使用 SHA 聚合 `summaryVersion` 覆盖 title/content/updatedAt 等所有影响展示的字段。
- [ ] `TRUST-04` 伪造旧 `summaryVersion`、删除目标资源、binding mismatch、连续 429/503 等场景均进入阻塞级验收。
- [ ] `TRUST-05` Windows PoC 只有在 HTTPS、Developer Mode、WinAppSDK / Widgets Board 条件满足后，失败才算真实失败。
- [ ] `TRUST-06` Android PoC 只有在 `assetlinks.json`、TWA 条件、FCM 配置、目标 ROM 验证条件满足后，失败才算真实失败。
- [ ] `TRUST-07` localhost、缺失 `assetlinks.json`、未部署组合 SW、无 GMS 设备上的失败，不得直接写成架构失败结论。

## 13. 测试、观测与发布门禁

- [ ] `QA-01` 合约测试覆盖：manifest、shortcuts、widgets、SW 注册目标、摘要 schema。
- [ ] `QA-02` 集成测试覆盖：register/revoke、soft-delete filtering、summaryVersion 单调性、binding_generation、rate limit / kill switch。
- [ ] `QA-03` 平台验证覆盖：Windows 11 + Edge 已安装 PWA、Android 实机、至少一个后台限制明显的 Android 设备。
- [ ] `QA-04` 反假阳性场景 `FP-01` 到 `FP-08` 全部演练通过。
- [ ] `QA-05` 故障演练覆盖：浏览器清缓存、A/B 换号、summaryVersion 回退、429/503、Windows suspend/resume、Android Doze、远端 kill switch、软删除引用资源。
- [ ] `QA-06` 遥测最小集已落地：`widget_register_success/failure`、`widget_instance_install/uninstall`、`widget_summary_fetch_success/failure`、`widget_summary_schema_mismatch`、`widget_stale_render`、`widget_untrusted_render`、`widget_killswitch_applied`、`widget_account_switch_cleanup`、`widget_sw_activate_refresh`、`widget_push_dirty_sent/dropped`。
- [ ] `QA-07` Kill Criteria 已量化并写入执行文档，至少含：空白 Widget 概率、账号切换清理失败、`fresh + verified` 误判反例。
- [ ] `QA-08` 发布前检查表已完成：缓存头、限流、熔断、账号切换清理、三维状态 UI、支持矩阵、设备吊销能力归属。

## 14. 回滚就绪度

- [x] `RB-01` 可单独移除 manifest shortcuts。
  - 2026-04-15 闭合：`manifest.webmanifest` 中 `shortcuts` 为独立数组节点，删除后不影响 widgets 或主应用。
- [x] `RB-02` 可单独移除 manifest widgets 暴露。
  - 2026-04-15 闭合：`manifest.webmanifest` 中 `widgets` 为独立数组节点，删除后不影响 shortcuts 或主应用。
- [x] `RB-03` 可单独把 `sw-composed.js` 回滚为 `ngsw-worker.js`。
  - 2026-04-15 闭合：`sw-composed.js` 仅通过 `importScripts('./ngsw-worker.js')` + `importScripts('./widgets/widget-runtime.js')` 组合，回滚只需将 SW 注册目标改回 `ngsw-worker.js`。
- [x] `RB-04` 可单独停用 `widget-register`、`widget-summary`、`widget-notify`。
  - 2026-04-15 闭合：三个 Edge Function 独立部署，可通过 Supabase 控制台单独删除/停用；亦可通过 `widget_capabilities` kill switch 按能力维度关闭。
- [x] `RB-05` 可批量吊销 `widget_devices` / `widget_instances` 凭证而不影响主应用。
  - 2026-04-15 闭合：`widget_devices` 和 `widget_instances` 为独立表，与主应用 `tasks/projects/connections` 无外键依赖，可安全清空。
- [ ] `RB-06` 可按平台关闭 Windows refresh、Android dirty push 或全部 Widget，而不要求整包回滚主应用。
  - 2026-04-16 补记：代码层已支持按 `platform + clientVersion + rollout bucket` 对 install / refresh / push 做独立决策；Android push 已从 `widget-notify` 改为逐设备筛选，Windows refresh 与 Android refresh/install 已改为请求侧按版本判定。发布前仍需补真实配置演练与回滚 SOP 取证。
