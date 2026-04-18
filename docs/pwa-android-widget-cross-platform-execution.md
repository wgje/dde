# NanoFlow 跨端桌面小组件执行与验收文档

> 来源：`docs/pwa-android-widget-cross-platform-proposal.md` v5.1 + `docs/pwa-android-widget-cross-platform-implementation-checklist.md`  
> 日期：2026-04-12  
> 状态：执行基线  
> 作用：后续所有 Widget 相关实施、阶段验收、风险关闭和回滚判断，一律以本文件为准。  
> 强制规则：未在本文件中完成目标、证据与阻塞门禁闭合的能力，不得宣称“已完成”或“可上线”。

---

## 0. 执行原则

1. 后续实施按阶段推进，只能在上一阶段 exit criteria 满足后进入下一阶段。
2. 每个阶段必须同时满足：交付物完成、证据齐全、阻塞门禁关闭、回滚路径明确。
3. 任何发现的纰漏、遗漏项、假阳性风险或与真实实现不符之处，必须至少同步补充 proposal 与本执行文档。
4. 若纰漏改变动作项、门禁或阶段边界，必须同步更新实施版 checklist。
5. `PoC 假设` 只有在当前仓库、当前部署链、当前目标环境里复验通过后，才允许升级为“已验证”。

## 1. 当前验收总目标

### 1.1 当前阶段性总目标

1. 先完成 `P0`，把启动身份、入口协议、legacy alias 和深链降级规则压平。
2. 再完成 `P1`，建立统一的设备认证、摘要投影、缓存语义、换号回收和公网接口防护。
3. 再完成 `P1.5`，以最小 Windows PoC 验证组合 SW、Adaptive Cards、只读摘要和单窗口复用。
4. `P2` 只在 `P1.5` 稳定通过且阻塞门禁关闭后才可立项执行。
5. `P3` 保持后置，不纳入当前验收范围。

### 1.2 当前明确非目标

- 不把 iOS Widget 纳入当前执行范围。
- 不把 Widget 直接写任务状态、直接录音、直接编辑 Black Box 正文纳入当前范围。
- 不把“今日统计”纳入当前跨端 Widget MVP。
- 不把 TWA PostMessage 当成 Android correctness path。

## 2. 阶段状态总览

| 阶段 | 当前范围 | 进入前提 | 退出条件 | 当前状态 | 证据位置 |
| --- | --- | --- | --- | --- | --- |
| `P0` | Web 入口与契约准备 | 已确认 MVP 边界与入口规则 | 启动身份、shortcuts、`entry/intent`、legacy alias 全部通过 | `completed` | `§3.1`、`§10` |
| `P1` | 云侧摘要与设备认证基础设施 | `P0` 验收通过 | register/summary/notify、server-first revoke、缓存契约、防滥用、隐藏今日统计 全部通过 | `completed` | `§3.2`、`§10` |
| `P1.5` | Windows PWA Widget PoC | `P1` 验收通过 | 组合 SW、Widget runtime、单窗口复用、首次可用性降级 全部通过 | `in-progress` | `§3.3`、`§10` |
| `P2` | Android 原生 Widget + TWA 壳 | `P1.5` 稳定通过并获继续立项批准 | Android 实机、FCM/WorkManager、隐私与 ROM 限制 全部通过 | `blocked` | 待填 |
| `P3` | Widget Action | `P2` 长时间稳定 | Action Queue、细粒度 scope、正确性语义 独立通过 | `blocked` | 待填 |

## 3. 阶段执行与验收矩阵

### 3.1 `P0`：Web 入口与契约准备

#### 目标

- 把 Widget 所需入口协议、启动身份兼容、深链降级和 legacy alias 风险先在 Web 侧打平。

#### 必需交付物

- [x] `P0-D01` `manifest.webmanifest` 新增静态全局 shortcuts。
- [x] `P0-D02` 壳层支持 `entry` / `intent` 解析与安全降级。
- [x] `P0-D03` Query `entry` / `intent` 优先于持久化 `launch snapshot` 路由恢复。
- [x] `P0-D04` `launch.html` 继续作为 legacy install identity alias，不被重新变成产品主入口。
- [x] `P0-D05` 启动契约与 `/launch.html` 浏览器级回归测试补齐。

#### 必需证据

- [x] `P0-E01` 浏览器直接访问 shortcut URL 的结果记录。
- [x] `P0-E02` 已安装 PWA 点击 shortcut 的结果记录。
- [x] `P0-E03` `/launch.html` 旧入口升级与不双开的测试记录。
- [x] `P0-E04` 无效 `intent`、失效 `taskId/projectId` 的降级结果记录。

#### 阻塞级失败

- [ ] `P0-B01` 出现双启动、白屏或 `launch.html` 回归为第二入口。
- [ ] `P0-B02` Widget / shortcut 意图被旧 `launch snapshot` 覆盖。
- [ ] `P0-B03` 新入口仍假设存在 `/#/focus`、`/#/dock`、`/#/capture` 等不存在路由。

#### Exit Criteria

- [x] `P0-X01` 所有 `P0-D*` 与 `P0-E*` 完成。
- [x] `P0-X02` 无 `P0-B*` 残留。
- [x] `P0-X03` 已在执行记录中写明回滚方式与未做项。

#### 当前实施记录（2026-04-12）

- 已完成代码交付：
	- `public/manifest.webmanifest` 新增 3 个静态 shortcuts，统一走 `./#/projects?entry=shortcut&intent=...`。
	- `src/utils/startup-entry-intent.ts` 新增显式启动信封解析；`entry` / `intent` 只作为一次性启动信封消费，不持久化进 `launch snapshot`。
	- `src/services/handoff-coordinator.service.ts`、`src/workspace-shell.component.ts`、`src/app/core/shell/project-shell.component.ts` 已改为显式 `entry` / `intent` 优先，避免旧 `launch snapshot` 覆盖当前 shortcut 意图。
	- focus tools / black box shortcut 复用现有侧边栏懒加载链路，不新增 `/#/focus`、`/#/dock`、`/#/capture` 等不存在路由。
- 已完成自动化证据：
	- `P0-E01`：`npx playwright test e2e/startup-shell-fallback.spec.ts --project=chromium` 已验证浏览器直接访问 `open-workspace`、`open-focus-tools`、`open-blackbox-recorder` 与未知 `intent` 的行为。
	- 同一条 Playwright 用例现已额外验证 startup trace 会在一次性 shortcut query 被消费前保留脱敏后的启动信封摘要（`pathname`、`hashPath`、`entry`、`intent` 等），并覆盖 opaque hash 场景，确认不会把 `access_token` / `refresh_token` 之类 URL token 值复制进全局 trace。
	- `P0-E02`：已在真实 Edge 安装态 profile 上完成 shortcut 点击链闭环。先通过浏览器原生安装 UI 完成 PWA 安装，再用同一 profile 的真实 `app-id=opoefficneiohaipcekpfiofdbkndfgj` 重启 installed app，并通过 `--app-launch-url-for-shortcuts-menu-item=http://localhost:3020/#/projects?entry=shortcut&intent=open-workspace` 复现 OS shortcut 启动路径。CDP target 首次即命中 `http://localhost:3020/#/projects?entry=shortcut&intent=open-workspace`；页面运行态 `display-mode: standalone = true`；startup trace 的 `loader.initial_visible` / `app.start` 均记录 `entry='shortcut'`、`intent='open-workspace'`，随后一次性消费回 `#/projects`。同时 profile `Preferences` 中 `web_apps.daily_metrics['http://localhost:3020/'].installed = true`、`web_app_install_metrics` 含该 `app-id`，且 `lastShortcutLaunchTime` 为非零值，说明 Chromium 已把本次启动记作已安装 PWA 的 shortcut launch。
	- `P0-E03`：同一 Playwright 用例已验证 `/launch.html` legacy alias 启动、入口消费后不回退成第二入口、shortcut query 被消费后可再次触发。
	- `P0-E04`：Playwright 已覆盖未知 `intent` 回退到 `./#/projects`；Vitest `src/app/core/shell/project-shell.component.spec.ts` 已覆盖失效 `taskId` 在 shortcut 语义下立即回退工作区，不再等待完整重试梯度。
	- 启动契约回归：`npm exec vitest run src/utils/startup-entry-intent.spec.ts src/services/handoff-coordinator.service.spec.ts src/workspace-shell.component.spec.ts src/app/core/shell/project-shell.component.spec.ts src/tests/startup-contract.spec.ts` 全部通过。
- 当前闭合状态：
	- `P0-D*`、`P0-E*`、`P0-X*` 已全部闭合，`P0` 允许进入 `P1-D01` live check。
	- 先前的 Chromium `--app=http://localhost:3020/` + `--app-launch-url-for-shortcuts-menu-item=...` surrogate 仍保留为反例：该路径在当前环境不会把 shortcut hash 送进 app shell，因此不能替代真实安装态 `app-id` 验收链。
- 当前自动化范围内未复现阻塞项：
	- `P0-B01` 未见双启动、白屏或 `launch.html` 回归为第二入口。
	- `P0-B02` 未见显式 shortcut/query 意图被旧 `launch snapshot` 覆盖。
	- `P0-B03` 新入口全部复用现有工作区 / 侧边栏能力，未引入不存在的顶级路由假设。
- 回滚方式：
	- 删除 `manifest.webmanifest` 中新增 shortcuts。
	- 回退 `src/utils/startup-entry-intent.ts` 与三处壳层消费逻辑，恢复原有只依赖 `launch snapshot` 的启动链。
	- 回退 `src/tests/startup-contract.spec.ts`、`src/workspace-shell.component.spec.ts`、`src/app/core/shell/project-shell.component.spec.ts` 与 `e2e/startup-shell-fallback.spec.ts` 中新增的 P0 回归测试。

### 3.2 `P1`：云侧摘要与设备认证基础设施

#### 目标

- 建立平台无关的 Widget 读模型、设备认证、缓存契约、防滥用与换号回收基础设施。

#### 必需交付物

- [x] `P1-D01` 重新执行 live check，刷新项目状态、advisors、已部署 functions、schema 快照。
- [x] `P1-D02` 落定 `widget_devices` / `widget_instances` 策略与字段设计。
- [x] `P1-D03` 实现 `widget-register`，支持首次注册、轮换、吊销。
- [x] `P1-D04` 实现 `widget-summary`，用稳定 projection contract 输出只读摘要。
- [x] `P1-D05` 明确 `widget-notify` 的部署路径与鉴权模型。
- [x] `P1-D06` 落定 `freshnessState + trustState + sourceState` 三维状态契约。
- [x] `P1-D07` 实现 server-first revoke、`binding_generation`、换号与重装世代隔离。
- [x] `P1-D08` 落定 HTTP 缓存契约、日志脱敏、rate limit、kill switch。
- [x] `P1-D09` 当前 MVP 明确隐藏 routine / 今日统计。

#### 必需证据

- [x] `P1-E01` 设备首次注册、轮换、吊销全链路记录。
- [x] `P1-E02` `widget-summary` 在无 JWT 但有 device token 条件下成功返回摘要的记录。
- [x] `P1-E03` 旧 token 在 revoke 或换号后被拒绝的记录。
- [x] `P1-E04` `binding_generation` mismatch 时的拒绝或降级记录。
- [x] `P1-E05` `widget-summary` 返回 `no-store/private/vary` 缓存头的记录。
- [x] `P1-E06` 429 / 503 / schema mismatch / soft-delete target / auth-required 的降级记录。
- [x] `P1-E07` live advisor 复核结果与 remediation 记录。

#### 阻塞级失败

- [ ] `P1-B01` 旧 token 在退出登录或换号后仍可读取摘要。
- [ ] `P1-B02` `widget-summary` 结果可能通过共享 HTTP cache 复用到另一账号或另一实例。
- [ ] `P1-B03` `widget-notify` 的实际部署方式与文档中的鉴权模型不一致。
- [ ] `P1-B04` 今日统计仍作为默认 MVP 输出对外承诺。
- [ ] `P1-B05` `widget-summary` 仍把 `FocusTaskSlot` 等原始会话结构当成最终展示 DTO。

#### Exit Criteria

- [x] `P1-X01` 所有 `P1-D*` 与 `P1-E*` 完成。
- [x] `P1-X02` 阻塞门禁 `G-41`、`G-42`、`G-43`、`G-44` 已关闭。
- [x] `P1-X03` 已在执行记录中写清 direct webhook / trusted gateway 的实际决策与理由。

#### 当前实施记录（2026-04-13）

- 已完成代码交付：
	- `supabase/migrations/20260412143000_widget_backend_foundation.sql` 与 `scripts/init-supabase.sql` 已落地 `widget_devices`、`widget_instances`、`widget_request_rate_limits`、`consume_widget_rate_limit()` 以及 `widget_capabilities` / `widget_limits` 配置种子。
	- `supabase/migrations/20260413102000_widget_notify_webhook_hmac.sql` 已补齐 `focus_sessions` / `black_box_entries` -> `widget-notify` 的首版 `pg_net` 触发链路，采用 Vault-backed HMAC 头、时间戳窗口与事件 ID。
	- `supabase/migrations/20260413113000_widget_notify_hmac_replay_fix.sql` 以前向迁移方式继续硬化 live trigger signer：自定义签名绑定 `event_id + timestamp + body`，并将 `SECURITY DEFINER` 的 `search_path` 收紧到 `pg_catalog, vault, extensions`，同时显式使用 `extensions.gen_random_uuid()` / `extensions.hmac()`；已避免直接改写已上线 migration 历史。
	- `supabase/migrations/20260413120000_widget_notify_secret_normalization.sql` 继续以前向迁移方式补齐 SQL signer 与 Edge verifier 的 secret 归一化语义，兼容 `v1,whsec_` 前缀 secret，并避免后续运维配置把合法内部 webhook 变成系统性 401。
	- `supabase/migrations/20260413121000_widget_notify_limits_backfill.sql` 继续以前向迁移方式把 `notifyUserPerMinute` / `notifyIpPerMinute` 回填进既有 live `app_config.widget_limits`，避免仓库默认值与已升级环境配置脱节；同时 `widget-notify` 运行时代码已移除 notify 限流的隐式 floor clamp，并将 secret trim 顺序与 SQL signer 保持一致。
	- `src/models/supabase-types.ts`、`src/types/supabase.ts` 已同步 Widget 相关表与 RPC 类型。
	- `supabase/functions/widget-register/index.ts` 已实现 `register / rotate / revoke / revoke-all`，并补齐 `device_id / installation_id / widget_instance_id` 边界、`binding_generation` 世代隔离、同账号跨安装冲突拒绝、device secret 最短长度校验、revoke 清空 push token、未显式上传 `pushToken` 时保留既有 push token。
	- `supabase/functions/widget-summary/index.ts` 已实现 `POST` + device token 自定义鉴权、预鉴权 IP 限流、device/user 限流、实例校验、owner-scoped 任务/项目查询、`DockSnapshot.focusSessionState` 与 legacy `entries + session` 兼容投影、软删除降级、unread-only black box 计数、`summaryVersion` 聚合游标与签名、`freshnessState + trustState + sourceState` 三维状态、`Cache-Control: private, no-store, max-age=0` / `Pragma: no-cache` / `Vary: Origin, Authorization`。
	- 2026-04-13 追加纠偏：生产 Auth 当前签发 ES256 用户 session token，`widget-register.verify_jwt = true` 会被 Supabase Functions gateway 误判为 `401 Invalid JWT`；因此 `widget-register` 已改为 `verify_jwt = false + verifyJwtUser(req) / auth.getUser(token)` 的函数内显式认证，与 `transcribe` 的线上绕行模式保持一致。
	- 2026-04-13 追加修复：live evidence 暴露 `widget-register` 与 `widget-summary` 先前共享 `user:` / `ip:` 限流桶，会让 summary 流量误伤 revoke/register。当前 `widget-register` 已改用 `widget-register-user:` / `widget-register-ip:`，`widget-summary` 已改用 `widget-summary-device:` / `widget-summary-user:` / `widget-summary-ip:`，将设备注册与摘要刷新预算彻底隔离。
	- `supabase/functions/widget-notify/index.ts` 已落定 direct webhook 路径：`verify_jwt = false`，同时支持 `standardwebhooks` 与自定义 `x-widget-webhook-*` HMAC 头；自定义签名现绑定 `event_id + timestamp + body`，并叠加时间戳窗口、payload schema/table 校验、幂等去重、notify 专属限流、kill switch、日志脱敏与 push-disabled 快速拒绝。当前顺序已调整为 capability check / 10s dedupe / active-instance fanout gating 先于 notify user 限流执行；`standardwebhooks` 的 IP 限流仅在签名通过后参与决策，而当前 direct `pg_net` 自定义 HMAC 路径不消耗 `notifyIpPerMinute`，避免共享基础设施 sender IP 造成误杀，当前依赖 `webhook_id` 幂等 + notify user 限流作为主防线。notify fanout 现要求 device 至少存在一个未卸载且 `binding_generation` 匹配的 active `widget_instances` 记录，避免仅凭 device push token 向已经失活的实例边界继续投递；notify 限流现严格尊重 live `widget_limits` 配置值，不再被运行时代码的最低阈值覆盖，且当 live notify 配额显式设为 `0` 时会直接短路拒绝而不是回退到默认值；provider-unavailable 路径现保留 `widget_notify_events.last_status='provider-unavailable'` 审计记录，并以 non-retryable skip 返回，而不是删除事件行后再回 `503`；其余未预期异常会保留 `last_status='internal-error'`。若同一 `webhook_id` 的旧记录停留在 `processing` 超过 60s 或上次落在 `internal-error`，重试会 CAS 重领该事件；若旧记录仍处于新鲜 `processing`，函数会返回带 `Retry-After` 的 retryable `409 event-in-progress`，而不是错误地回 `200 duplicate`。
	- `supabase/functions/_shared/widget-common.ts` 已补齐结构化 JSON base64url widget token、可信 IP 头优先级、`localhost:3020` 开发源白名单与统一私有 no-store 头。
	- `src/tests/contracts/widget-backend.contract.spec.ts` 已新增 Widget 后端 contract test，并通过 TypeScript parse 检查防止 Edge Function 源文件语法损坏漏检。
- 已完成自动化证据：
	- `npm run test:prepare-env && npx vitest run src/tests/contracts/widget-backend.contract.spec.ts --config vitest.config.mts` 通过，当前覆盖 schema/init/types/config 与 Widget 函数关键合同字符串、TypeScript 语法解析。
	- `npx vitest run src/services/widget-binding.service.spec.ts src/app/core/services/app-auth-coordinator.service.spec.ts src/tests/contracts/widget-backend.contract.spec.ts --config vitest.config.mts` 通过，确认 server-first revoke 已改为失败即中断登出，且 `widget-notify` HMAC 合同未回归。
	- `npx vitest run src/workspace-shell.component.spec.ts src/app/core/services/app-auth-coordinator.service.spec.ts src/tests/contracts/widget-backend.contract.spec.ts --config vitest.config.mts` 通过（85/85），确认 shell logout fail-closed 行为、Widget webhook 合同字符串、纯 helper 层的 secret normalization / `event_id + timestamp + body` 拼接语义、以及 live notify 配额显式设为 `0` 时的运行时归一化语义未回归。
- 已完成 live 证据：
	- 生产 Supabase `fkhihclpghmmtbbywvoj` 已成功 apply `widget_backend_foundation`、`widget_notify_webhook_hmac`、`widget_notify_hmac_replay_fix`、`widget_notify_secret_normalization` 与 `widget_notify_limits_backfill` 五条迁移；其中后三条 hardening/backfill migration 均通过定向 `db query` 执行 SQL 并补记 `migration repair` 落地，避免误推本地/远端漂移的其他 migration；`widget_devices`、`widget_instances`、`widget_request_rate_limits`、`widget_notify_events`、`widget_notify_throttle` 与 `consume_widget_rate_limit()` 已在 live schema 中存在，且 live `app_config.widget_limits` 已显式包含 `notifyUserPerMinute=120`、`notifyIpPerMinute=600`。
	- `widget-register`、`widget-summary`、`widget-notify` 已通过 `npx supabase functions deploy ... --project-ref fkhihclpghmmtbbywvoj` 部署到生产；当前仓库配置已纠偏为 `widget-register.verify_jwt = false`、`widget-summary.verify_jwt = false`、`widget-notify.verify_jwt = false`，其中 `widget-register` 继续在函数内通过 `verifyJwtUser(req)` / `auth.getUser(token)` 执行显式用户认证，避免 live ES256 access token 被 Functions gateway 误判为 `Invalid JWT`。
	- `widget_notify_focus_session_change` 与 `widget_notify_black_box_change` triggers 已存在于生产数据库。
	- 使用 live HMAC 合成请求验证 `widget-notify`：在 `20260413120000`、`20260413121000` rollout 之后以及最后一次 runtime redeploy 后均复验通过；合法签名返回 `202 { status: 'skipped', reason: 'push-disabled' }`，伪造签名返回 `401 { code: 'INVALID_SIGNATURE' }`。该探针证明最终 signer/verifier 语义与当前 `push-disabled` 快速拒绝分支正常；与此同时，`widget_limits` 的 `notifyUserPerMinute=120`、`notifyIpPerMinute=600` 已通过定向 `db query` 单独确认存在于 live `app_config`。当前证据尚未把 `pushAllowed=true` 时的 live notify quota 路径一并闭合，这仍属于后续 `P1-E*` 范围。
	- 2026-04-13 已用临时确认邮箱 + 真实 Auth session 完成 `widget-register` / `widget-summary` live probe：首次 register 返回 `200` + `bindingGeneration=1` + `summaryPath=/functions/v1/widget-summary`；rotate 返回 `200` + `bindingGeneration=2`；使用 device token 调 `widget-summary` 返回 `200 verified/cloud-confirmed/aligned`；旧 token 在 rotate 后返回 `401 BINDING_MISMATCH`；在限流分桶修复后，`revoke-all` 返回 `200 revokedCount=1`，同一旧 token 随后返回 `401 DEVICE_REVOKED`。
	- 2026-04-13 已完成 `widget-summary` live 缓存/降级 drill：正常摘要响应头为 `Cache-Control: private, no-store, max-age=0`、`Pragma: no-cache`、`Vary: Accept-Encoding, Origin, Authorization`；无 token 请求返回 `401 WIDGET_TOKEN_REQUIRED`；`clientSchemaVersion=999` 返回 `409 SCHEMA_MISMATCH`；将 `summaryIpPerMinute` 临时压到 `1` 后，连续两次无 token 请求复现 `401 -> 429 RATE_LIMITED`；将 `refreshAllowed` 临时切到 `false` 后复现 `503 WIDGET_REFRESH_DISABLED`；为临时用户注入“活项目 + 软删任务 + 指向该任务的最新 focus session”后，`widget-summary` 返回 `200 provisional` 且 `degradedReasons=['soft-delete-target']`、`focus.valid=false`。
	- 2026-04-13 已重新跑 live advisors。与 Widget 新暴露面直接相关的结果仅剩 `widget_devices` / `widget_instances` / `widget_notify_events` / `widget_notify_throttle` / `widget_request_rate_limits` 的 `RLS enabled no policy` 信息项；这些表当前仅允许 `service_role` 访问，因此无 policy 是有意保持“默认拒绝”的 service-role-only 设计。其余 `mutable search_path`、Auth leaked password protection、未索引外键与 unused index 仍为项目级既有底噪，已重新核验但不构成本轮 Widget 新增阻塞。
- 当前遗留风险（不阻塞 `P1`）：
	- `widget-notify` 当前 live 配置仍处于 `pushAllowed = false`，因此生产请求目前会稳定落在 `push-disabled` 快速拒绝分支；`deliveryMode = dry-run` 代码路径仅在未来打开 `pushAllowed` 且 provider 就绪后才会进入，当前尚未做 live 端到端验证。
- G-43 live 端到端验证证据（2026-04-13）：
	- 使用 admin API 创建临时确认用户 A，登录获取 ES256 access token，注册 widget 设备（`register` → `200 bg=1`），widget-summary 可正常访问（`200 trust=verified fresh=stale`，`Cache-Control: private, no-store, max-age=0`）。
	- 执行 `revoke-all`（模拟 `AppAuthCoordinatorService.signOut()` 的 server-first revoke 步骤）→ `200 revokedCount=1`。
	- 执行 `auth.signOut` → `204`。
	- 使用旧 widget token 请求 summary → `401 DEVICE_REVOKED`，证明 revoke-all 确实使旧 token 立即失效。
	- 模拟 A→B 换号：创建用户 B，同一 `deviceId` / `installationId` 注册新设备（`200 bg=2`），B 的 summary 正常（`200 trust=verified`），A 的旧 token 返回 `401 BINDING_MISMATCH`，证明换号世代隔离有效。
	- 生产前端已通过 Vercel redeploy 到 `https://dde-eight.vercel.app`；重新扫描 `ngsw.json` 列出的 110 个 JS 资产后，已在 `/chunk-HZMSDGMX.js` 命中 `widget-register` / `WIDGET_REFRESH` / `nanoflow-widget` / `revoke-all` / `bindingGeneration` 签名，确认线上 bundle 已对齐当前仓库 logout 路径。
	- 随后对 `https://dde-eight.vercel.app` 执行 headless Playwright 生产 UI 复核：用户 A 登录后从设置面板点击“退出”，真实网络顺序为 `POST /functions/v1/widget-register {"action":"revoke-all"}` → `200`，随后 `POST /auth/v1/logout?scope=global` → `204`；A 登出后用户 B 再登录，`user-menu` 已切换为 B 邮箱，证明真实 logout / account-switch 链路与 server-first revoke 一致。
	- 测试用户在验证完成后已删除。
- 当前闭合状态：
	- `P1-D01`～`P1-D09`、`P1-E01`～`P1-E07` 已全部闭合。
	- `P1-X01` 闭合（所有 `P1-D*` / `P1-E*` 完成）。
	- `P1-X02` 已闭合：`G-41` / `G-42` / `G-43` / `G-44` 均已关闭。
	- `P1-X03` 已在上方执行记录中写清 direct webhook 实际决策。
	- `P1` 当前已转为 `completed`；仓库、后端 live probe 与生产前端 UI 证据均已闭合。
- 当前回滚点：
	- 回退 `supabase/functions/widget-register`、`supabase/functions/widget-summary` 与 `supabase/functions/_shared/widget-common.ts` 的 Widget 专属逻辑。
	- 回退 `supabase/functions/widget-notify` 与 `supabase/migrations/20260413102000_widget_notify_webhook_hmac.sql`、`supabase/migrations/20260413113000_widget_notify_hmac_replay_fix.sql`、`supabase/migrations/20260413120000_widget_notify_secret_normalization.sql`、`supabase/migrations/20260413121000_widget_notify_limits_backfill.sql` 的 HMAC webhook / trigger / live config backfill 链路。
	- 回退 `supabase/migrations/20260412143000_widget_backend_foundation.sql` 与 `scripts/init-supabase.sql` 中的 Widget 表、RPC 与配置种子。
	- 回退 `src/models/supabase-types.ts`、`src/types/supabase.ts`、`src/tests/contracts/widget-backend.contract.spec.ts` 与 `scripts/test-duration-baseline.json` 的同步改动。

### 3.3 `P1.5`：Windows PWA Widget PoC

#### 目标

- 以最小 Windows PoC 验证组合 SW、只读摘要、Adaptive Cards、首次可用性降级和单窗口复用，而不是直接追求完整上线。

#### 必需交付物

- [x] `P15-D01` `sw-composed.js` 底座已在独立波次上线。
- [x] `P15-D02` `widgets/widget-runtime.js` 已接通 `widgetinstall`、`widgetresume`、`widgetclick`、`widgetuninstall`、`activate`、`periodicsync`。
- [x] `P15-D03` 最小 Adaptive Cards 模板与 runtime-only data path 已落地。
- [x] `P15-D04` 首次可用性降级模板已落地，不显示空白 Widget。
- [x] `P15-D05` `widgetclick` 已按"先复用窗口、必要时再 `openWindow()`"实现。
- [x] `P15-D06` 复用逻辑已 leader-aware，能区分可接管意图的主窗口与 follower / 只读窗口。
- [x] `P15-D07` Windows MVP 仍保持只读摘要 + 打开主应用范围。

#### 必需证据

- [ ] `P15-E01` 已安装 Edge PWA 在 Windows 11 Widgets Board 中添加 Widget 的记录。
- [ ] `P15-E02` 旧安装从 `ngsw-worker.js` 升级到 `sw-composed.js` 后不白屏的记录。
- [ ] `P15-E03` token 失效时 Widget 进入 `auth-required` 的记录。
- [ ] `P15-E04` `widgetresume` / `activate` / `periodicsync` 的刷新记录。
- [ ] `P15-E05` 已有窗口存在时，连续点击 Widget 不新开第二窗口的记录。
- [ ] `P15-E06` leader / follower 多窗口场景下，意图不落入只读 follower 的记录。

#### 阻塞级失败

- [ ] `P15-B01` 组合 SW 在升级链中持续不稳定或导致主应用缓存链异常。
- [ ] `P15-B02` Widget 仍可能无条件 `openWindow()` 导致双开或 legacy alias 回归。
- [ ] `P15-B03` 删除一个实例会误影响其他实例刷新。
- [ ] `P15-B04` 首次可用性场景仍可能显示空白 Widget。

#### Exit Criteria

- [ ] `P15-X01` 所有 `P15-D*` 与 `P15-E*` 完成。
- [ ] `P15-X02` 阻塞门禁 `G-45`、`G-46` 已关闭。
- [ ] `P15-X03` 已根据真实结果判定是否允许继续进入 `P2`。

#### 当前实施记录（2026-04-13）

- 已新增生产安装取证脚本：`scripts/edge-pwa-cdp-install-proof.cjs`，并通过 `npm run pwa:edge-prod-install-proof` 固化为 fresh-profile 验证命令；该脚本会在全新 Edge profile 中完成 `Page.getAppManifest` / `Page.getInstallabilityErrors` / `PWA.install` 探针，并输出 `tmp/pwa-widget-prod-cdp-report.json` 与 `tmp/pwa-widget-prod-cdp-page.png`。
- 已完成生产站点浏览器侧安装产物取证：`https://dde-eight.vercel.app/` 在 fresh Edge profile 中 `installabilityErrors=[]`、`serviceWorkerReady=true`、manifest `id=https://dde-eight.vercel.app/launch.html`；profile 中已出现 `app_shims.bcipeljkmaebbnfdpkghnmgjpbbmgmko.installed_profiles=['Default']`、`web_app_install_metrics.bcipeljkmaebbnfdpkghnmgjpbbmgmko.install_source=6`、`web_apps.daily_metrics['https://dde-eight.vercel.app/'].installed=true`，并且 `Default/Sync Data/LevelDB/000003.log` 已包含 `nanoflow-focus-summary`、`focus-summary.json`、`focus-data.json` 与 `web_apps-dt-bcipeljkmaebbnfdpkghnmgjpbbmgmko`，说明生产 manifest 中的 widget 定义已被 Edge 识别并写入当前安装态 profile。
- 当前仍未闭合的宿主侧证据：
	- `self.widgets` API 在生产 Service Worker 中可用，但 `matchAll({ installable: true })`、`matchAll({ installed: true })` 与 `getByTag('nanoflow-focus-summary')` 均返回空，说明当前环境尚未拿到可安装或已安装的 Widgets Board 实例。
	- `PWA.launch` 仍失败，`PWA.openCurrentPageInApp` 当前返回 `Invalid parameters`；profile 中尚未出现 `browser.app_window_placement._crx__...`，`lastShortcutLaunchTime` 仍为 `0`，因此当前证据只能证明“浏览器侧安装产物存在”，不能冒充“standalone/shortcut/host instance 已闭合”。
	- 直接启动 `WidgetBoard.exe` 后，`MicrosoftWindows.Client.WebExperience` 的 `LocalState` 在最近 10 分钟内没有新的 NanoFlow 相关写入；当前主机 `Get-ComputerInfo` 结果仍标识为 `Windows 10 Home China / WindowsVersion=2009 / OsBuildNumber=26200`。结合 Microsoft 文档仍将目标宿主写明为 Windows 11 Widgets Board，当前环境不足以关闭 `P15-E01`，`G-48` 继续保持 `open`。
- 当前结论：生产 PWA 已具备“可安装 + widget 定义被 Edge 接收”的浏览器侧前提，`P15-E01` 的剩余阻塞已从“生产站点无法真实安装”收敛为“需要在真实 Windows 11 Widgets Board 可交互宿主中完成 Add widgets / 实例安装证据”。

### 3.4 `P2`：Android 原生 Widget + TWA 壳

#### 当前状态

- `blocked`。只有在 `P1.5` 稳定通过并获得继续立项批准后，才可从阻塞状态转为执行状态。

#### 当前仓库准备情况（2026-04-14）

- 已新增 `scripts/generate-assetlinks.cjs`，并接入 `npm run config` / `npm run assetlinks:generate`。当环境中存在 `ANDROID_TWA_PACKAGE_NAME` 与 `ANDROID_TWA_SHA256_CERT_FINGERPRINTS` 时，构建前会生成 `public/.well-known/assetlinks.json`；若配置不完整，则会主动删除旧的生成文件，避免把过期 DAL 关系误带进部署。
- `vercel.json` 与 `netlify.toml` 已新增 `/.well-known/assetlinks.json` 的静态响应头，仓库层面不再停留在“没有发布位”的状态。
- 已新增 `src/utils/runtime-platform.ts`，当前 startup trace 会记录 `runtimePlatform`、`runtimeOs`、`runtimeDisplayModes` 与 `runtimeAndroidHostPackage`，后续 Android TWA 实机联调可以直接用它确认当前 Web 壳究竟运行在浏览器 tab、已安装 PWA，还是 `android-app://` 来源的 TWA 宿主里。
- 已新增 `docs/android-twa-integration-checklist.md`，把 Android 壳必须遵守的入口协议、令牌注册、实例上下文和验真步骤单独拆出，避免继续把 Android 要求埋在跨端总案里。
- 已新增 Android 原生宿主骨架：`android/` 目录现在包含 TWA 启动 Activity、Glance Widget、WorkManager 刷新、FCM data-message 接收和 `nanoflow-widget://bootstrap` 回调入口；当前 contract 明确要求 Android 原生宿主不得直接无凭证调用 `widget-register`，而是通过已登录 Web 会话完成 bootstrap 后回传 `widgetToken`。2026-04-13 最新收口还补上了 bootstrap pending nonce 校验、15 分钟回调 TTL、唯一 periodic WorkManager fallback、Web 侧 hash bootstrap consumer，以及 `widgetToken/deviceSecret/pushToken` 的本地加密存储；其中 Android 路径已明确不再写入 Web widget-runtime 的共享 IndexedDB token，且 pending bootstrap 请求会在清掉 URL 后短暂落在 `sessionStorage` 以避免 same-tab reload 丢失流程。详见 `docs/android-widget-host-scaffold.md`。
- 2026-04-14 继续收口：`widget-summary` 已按 current focus / valid dock 输出上下文 `entryUrl`，其中 `soft-delete-target` 会明确回退到工作区；Android 宿主在非 bootstrap 的“打开应用”路径，以及“已有合法缓存摘要时的强制 rebootstrap”路径，都会先校验同源且 fragment 仍落在 `#/projects...` 后消费该 URL；Web startup shell 清理一次性 `entry/intent` query 时也不再把 `project/task` 深链接抹平成 `/projects`。
- 2026-04-14 继续收口：`widget-summary` 已补齐 `focus.projectTitle` 与 `blackBox.gatePreview`，Android 宿主渲染合同明确为“专注模式未开启时展示 Gate（大门）待处理内容，专注模式开启时展示停泊坞中的主任务”；`NanoflowGlanceWidget` 同步改为带模式标签、边框卡片和状态栏的新版布局，避免继续把两种主态混成单一 focus 标题卡片。
- 当前仓库已完成仓库级 Android 构建验证：`npx vitest run src/tests/contracts/widget-backend.contract.spec.ts src/tests/contracts/android-host.contract.spec.ts --config vitest.config.mts` 与 `./android/gradlew -p ./android :app:assembleDebug` 已通过；因此当前可以确认的是“仓库内 contract + 编译闭合”，而不是“Android Studio / 实机链路已经闭合”。
- 上述 Gate 渲染合同同时意味着 Android Widget 现在会缓存并展示 pending `black_box_entries.content` 预览，这与更保守的 `SEC-12` / `P2-05` 默认隐私假设存在张力；因此该能力当前只能记为“仓库实现已具备”，不能自动视为“Android 发布门禁已关闭”。- 2026-04-15 收口：`SEC-12` / `P2-05` 已实现并通过真机验证。`NanoflowWidgetStore` 新增 `privacyModeKey`（默认 `true`），`saveSummary()` 在隐私模式下通过 `stripSensitiveFields()` 擦除 Black Box 正文、任务正文和项目标题，只保留计数与状态字段（满足 `P2-05`）；`NanoflowWidgetRepository.buildRenderModel()` 在隐私模式下用 `nanoflow_widget_privacy_gate_title`（"%d 条待处理沉积"）替代 `gatePreview.content`，用 `nanoflow_widget_privacy_focus_title`（"专注任务进行中"）替代完整任务标题，且隐私模式下不展示 `supportingLine`（满足 `SEC-12`）。contract test 已新增 `defaults to privacy mode that hides sensitive content from widget (SEC-12 / P2-05)` 并通过。
- 2026-04-15 真机补证：设备 `2410DPN6CC`（Android 16 / SDK 36）解锁后已完成 widget 面板点击、TWA 前台界面和 OPEN_FOCUS_TOOLS 操作取证。`adb shell am start -W -n app.nanoflow.twa/...NanoflowTwaLauncherActivity --es extra.LAUNCH_INTENT OPEN_WORKSPACE --es extra.ENTRY_SOURCE WIDGET` 返回 `Status: ok, LaunchState: COLD, TotalTime: 222`，前台活动确认为 `com.android.chrome/...CustomTabActivity`（TWA 预期行为）；`OPEN_FOCUS_TOOLS` 同样成功（201ms）。`dumpsys appwidget` 确认 widget instance id=6211 已放置在 MIUI home screen 上。隐私模式 APK 已安装并截图。- 当前这些改动只闭合了“仓库内可准备”的前置条件，没有关闭 `P2-G01` / `P2-G02`：release 包名与证书指纹仍未完成线上验真，FCM 凭证链与 Android 实机矩阵也未闭合，`P2` 继续保持 `blocked`。
- 2026-04-15 设备矩阵扩展：第二台设备 Xiaomi `24018RPACC`（sheng），Android 16 / SDK 36，screen 2032x3048，density 400，MIUI V816，已安装 debug APK 并确认 TWA 启动成功（370ms COLD）、widget provider 已注册。当前验证矩阵：两台 Xiaomi MIUI Android 16 设备（`2410DPN6CC` haotian 1440x3200 + `24018RPACC` sheng 2032x3048）。WorkManager 在 `2410DPN6CC` 上确认 `RUNNABLE`，Doze 环境下 job 仍保持调度。
- 2026-04-15 checklist 系统性闭合：TRUST-01/02/03（Android + Windows 均完整消费 `freshnessState + trustState + sourceState` 三维状态）、DATA-05（`summaryVersion` SHA 聚合覆盖 title/content/updatedAt 等展示字段）、DRILL-06（Xiaomi Doze 下 WorkManager RUNNABLE）、DRILL-08（live soft-delete-target 已验证 `200 provisional + degradedReasons=['soft-delete-target']`）、DRILL-09（A→B 换号无旧用户标题残留已验证）、REL-CHK-03（三维状态在 Android UI 中具备清晰降级文案）、REL-CHK-04（支持矩阵与隐私边界已建立）。

#### 进入前必须确认

- [ ] `P2-G01` `P1.5` 通过，且没有未关闭的阻塞级假阳性问题。
- [ ] `P2-G02` `assetlinks.json`、TWA 运行条件、FCM 凭证链已逐条验真。
- [ ] `P2-G03` TWA PostMessage 已被明确写成 optional fast path，而不是 correctness path。
- [ ] `P2-G04` 至少准备一台后台限制明显的设备和一台接近 AOSP 的设备。

### 3.5 `P3`：Widget Action

#### 当前状态

- `blocked`。不属于当前验收范围。

#### 进入前必须确认

- [ ] `P3-G01` `P0`、`P1`、`P1.5`、`P2` 均已稳定。
- [ ] `P3-G02` 已设计专用 Action Queue，而不是直接写业务真表。
- [ ] `P3-G03` 已设计只读 token 与 Action token 的 scope 分离。

## 4. 横向阻塞门禁

| 编号 | 门禁 | 当前要求 | 状态 |
| --- | --- | --- | --- |
| `G-41` | `widget-notify` 鉴权模型与部署方式一致 | `P1` 必闭合 | `closed` |
| `G-42` | `widget-summary` HTTP 缓存契约已落地 | `P1` 必闭合 | `closed` |
| `G-43` | logout / account switch 的 server-first revoke 已验证 | `P1` 必闭合 | `closed` |
| `G-44` | 今日统计要么隐藏，要么已 canonicalize | `P1` 必闭合 | `closed` |
| `G-45` | Windows `widgetclick` 单窗口复用测试通过 | `P1.5` 必闭合 | `open` |
| `G-46` | Windows `multiple=false` / instance boundary 稳定 | `P1.5` 必闭合 | `open` |
| `G-47` | TWA PostMessage 已明确降级为 optional fast path | `P2` 必闭合 | `closed` |
| `G-48` | PoC 环境前提已逐条验真 | 全阶段必闭合 | `open` |

## 5. 反假阳性验收

以下场景任意一项复现，都视为阻塞级失败，不允许继续宣称阶段完成：

- [x] `FP-01` 旧 token 在账号退出后仍可拉到摘要。——`supabase/functions/widget-summary/index.ts` 在 device 查询后依次校验 `revoked_at`（L610 → `DEVICE_REVOKED`）、`binding_generation`（L623 → `BINDING_MISMATCH`）、`expires_at`（L634 → `TOKEN_EXPIRED`）、`secret_hash`（L645 → `TOKEN_INVALID`）；`src/services/widget-binding.service.ts` `revokeAllBindings` 在账号切换时 `UPDATE widget_devices SET revoked_at=now()` 并触发 `widget_account_switch_cleanup` 遥测。
- [x] `FP-02` Widget 显示 `fresh`，但目标 `task/project` 已软删除。——`widget-summary/index.ts` 所有聚合查询（tasks / projects / focus_sessions / black_box_entries）均链式 `.is('deleted_at', null)`（L747 / L776 / L800 / L847 / L866 / L889 / L908 / L938），软删记录不会进入摘要；`freshnessState` 以 `updated_at` 与 `freshThresholdMinutes` 计算，无法把空结果误标为 `fresh`。
- [x] `FP-03` 小尺寸实例覆盖大尺寸实例的缓存、布局或隐私配置。——`widget-summary` 以 `instanceId` 为键匹配 `widget_instances` 行（L675-681 链式 `.eq('id', body.instanceId).eq('device_id', device.id).eq('user_id',...).eq('platform',...)`）；Android `NanoflowWidgetReceiver.kt` 为每个 `appWidgetId` 独立持久化 `instanceId` 与 `sizeBucket`（L14-33 `ensureInstanceId` + `persistSizeBucket`），不共享缓存。
- [x] `FP-04` 卸载一个实例导致另一个实例停止刷新。——`NanoflowWidgetReceiver.kt` `onDeleted` 仅对传入的 `appWidgetIds` 做 `clearWidgetState`，并 `syncPeriodicRefresh(context, hasWidgetsRemaining)`（有其他实例时保持周期刷新）；`onDisabled` 才整体清空。Edge 端按 `instanceId` 取消绑定，不会级联其他实例。
- [x] `FP-05` 同设备 `local-pending` 被错误标为 `cloud-confirmed`。——widget 渲染链路只读取 `widget-summary` 返回（服务端 Supabase 查询），本地离线草稿不会注入 widget 摘要；`trustState` 为 `verified` 需 widget-summary 通过全部 token/binding/instance 校验，无本地旁路。
- [x] `FP-06` 服务端 kill switch 生效后，客户端仍持续高频请求。——Phase D 真机演练已取证 `503 WIDGET_REFRESH_DISABLED`；Android `NanoflowWidgetRepository.kt` `WIDGET_REFRESH_DISABLED` 分支既 `applyBackoff` 又 `widget_killswitch_applied` 遥测；Web SW `public/widgets/widget-runtime.js` `WIDGET_REFRESH_DISABLED/WIDGET_DISABLED` 命中时 `widget_killswitch_applied + widget_summary_fetch_failure reason='killswitch'` 并停止当轮 refresh。
- [x] `FP-07` 组合 SW 升级后 Widget 空白，但缺少观测信号。——`public/widgets/widget-runtime.js` `activate` 事件固定发 `widget_sw_activate_refresh`（OBS-08）；`widget_summary_fetch_failure` 涵盖 refresh 失败全路径；`widget_stale_render`/`widget_untrusted_render`（OBS-09/10）覆盖成功响应但状态非 fresh / verified 的情况。
- [x] `FP-08` Windows / Android 不支持环境下仍对用户显示"Widget 已可用"。——`src/utils/runtime-platform.ts` `resolveRuntimePlatformSnapshot` 仅在 `isAndroid && isStandalone && androidHostPackage !== null` 时返回 `surface='twa-shell'`；`pwa-install-prompt.service.ts` `canShowInstallPrompt` 在非 PWA/TWA 环境下关闭安装提示；widget 绑定路径以 `platform='android-widget'` 作为 `normalizeWidgetPlatform` 白名单硬约束（非 Android 设备无法构造 bootstrap URI）。

## 6. 故障演练清单

- [ ] `DRILL-01` 浏览器清缓存后重启应用。
- [x] `DRILL-02` 用户从账号 A 切换到账号 B。
- [ ] `DRILL-03` 手工注入旧 `summaryVersion` 响应。
- [ ] `DRILL-04` `widget-summary` 连续返回 429 / 503。
- [ ] `DRILL-05` Windows host suspend -> resume。
- [x] `DRILL-06` Android Doze / 后台受限。
- [ ] `DRILL-07` 远端 kill switch 关闭某个平台或某 bucket。
- [x] `DRILL-08` `focus_sessions` 指向已软删除任务或项目。
- [x] `DRILL-09` 共享设备或换号后检查是否残留上一用户标题。

## 7. 遥测与发布门禁

### 7.1 必须落地的最小遥测

- [x] `OBS-01` `widget_register_success`
- [x] `OBS-02` `widget_register_failure`
- [x] `OBS-03` `widget_instance_install`
- [x] `OBS-04` `widget_instance_uninstall`
- [x] `OBS-05` `widget_summary_fetch_success`
- [x] `OBS-06` `widget_summary_fetch_failure`
- [x] `OBS-07` `widget_summary_schema_mismatch`
- [x] `OBS-08` `widget_stale_render`
- [x] `OBS-09` `widget_untrusted_render`
- [x] `OBS-10` `widget_killswitch_applied`
- [x] `OBS-11` `widget_account_switch_cleanup`
- [x] `OBS-12` `widget_sw_activate_refresh`
- [x] `OBS-13` `widget_push_dirty_sent`
- [x] `OBS-14` `widget_push_dirty_dropped`

> 实现方式：共享 `logWidgetEvent()` helper（Edge）、`logWidgetTelemetry()`（Web SW）、`NanoflowWidgetTelemetry.info()`（Android），全部输出结构化 JSON 并统一经 `redactId()` 脱敏。消费侧可通过 `supabase functions logs`、浏览器 DevTools、`adb logcat` 抓取；若未来接入集中遥测 sink，仅需在各 surface 层做转发即可，不改业务代码。

### 7.2 发布前强制检查

- [ ] `REL-CHK-01` 缓存头、rate limit、日志脱敏、kill switch 均已验证。
- [x] `REL-CHK-02` 账号切换与 server-first revoke 已通过人工故障演练。
- [x] `REL-CHK-03` 三维状态在 UI 中具备清晰降级语义。
- [x] `REL-CHK-04` 支持矩阵、非支持环境降级与共享设备隐私边界均已写清。
- [ ] `REL-CHK-05` 设备清单与吊销能力已有明确产品归属。

## 8. Kill Criteria

出现以下任一情况，应立即停止继续扩容或暂停对应平台路线：

1. SW 升级后空白 Widget 概率超过约定阈值。
2. 账号切换清理失败出现一次且验证属实。
3. `fresh + verified` 被误判的反例复现一次且未能说明为无效实验。
4. Windows 组合 SW、Android 推送链或缓存语义出现无法独立熔断的系统性风险。

## 9. 纰漏与缺口同步机制

### 9.1 触发条件

出现以下任一情况，视为必须同步补文档：

1. Proposal 中的约束与真实实现不一致。
2. Execution 中的阶段目标、exit criteria 或阻塞门禁不完整。
3. 新发现假阳性、共享设备隐私、缓存复用、窗口复用或环境前提问题。
4. 平台官方约束更新，导致原有 PoC 假设失效。

### 9.2 强制动作

1. 同一轮变更中至少同步更新 proposal 与本执行文档。
2. 若变更影响动作项、门禁或阶段边界，同步更新实施版 checklist。
3. 若问题已使某阶段 exit criteria 不再成立，必须把该阶段状态重新打开，不得继续保留“已完成”。

## 10. 执行记录

| 日期 | 阶段 | 动作 | 结果 | 证据 | 剩余风险 | 是否需补文档 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-04-12 | `P0` | 落地 manifest shortcuts、显式 `entry/intent` 启动信封、shortcut 优先级与回归测试 | 交付物与自动化证据完成，阶段仍待 `P0-E02` 手工验收闭合 | `npm exec vitest run src/utils/startup-entry-intent.spec.ts src/services/handoff-coordinator.service.spec.ts src/workspace-shell.component.spec.ts src/app/core/shell/project-shell.component.spec.ts src/tests/startup-contract.spec.ts`；`npx playwright test e2e/startup-shell-fallback.spec.ts --project=chromium` | 已安装 PWA shortcut 的真实 OS 点击路径尚未手工验证 | 是，已同步 proposal / execution / checklist |
| 2026-04-12 | `P0` | 完成真实 Edge 安装态 shortcut 验收闭环 | `P0-E02`、`P0-X01`、`P0-X02` 闭合，`P0` 通过验收并允许进入 `P1-D01` | 同一已安装 profile 的真实 `app-id=opoefficneiohaipcekpfiofdbkndfgj` + `--app-launch-url-for-shortcuts-menu-item=http://localhost:3020/#/projects?entry=shortcut&intent=open-workspace`；CDP target 首次 URL 命中 shortcut；页面 `display-mode: standalone = true`；startup trace 记录 `entry='shortcut'` / `intent='open-workspace'`；profile `installed = true` 且 `lastShortcutLaunchTime != 0` | 仍需进入 `P1` 重新做 live Supabase check；旧 `--app=` surrogate 仍只可作为反例，不能回填成验收主证据 | 是，已同步 proposal / execution / checklist |
| 2026-04-13 | `P1` | 落地 Widget 后端基础设施首轮代码闭环 | `widget_devices` / `widget_instances` / rate-limit RPC / `widget-register` / `widget-summary` / contract test 已在仓库实现，`P1` 转入 `in-progress`，但仍待 live check、`widget-notify` 决策与真实运行证据 | `npm run test:prepare-env && npx vitest run src/tests/contracts/widget-backend.contract.spec.ts --config vitest.config.mts` | 当前仅完成仓库内 contract + 语法验证；尚未做真实 Supabase apply / deploy / advisor rerun / 端到端 register-summary-revoke 验证 | 是，已同步 proposal / execution / checklist |
| 2026-04-13 | `P1` | 完成 live schema / function deploy 与 `widget-notify` HMAC 触发链硬化 | 生产项目已 apply Widget schema、webhook trigger、replay-fix 与 secret-normalization hardening 迁移，`widget-register` / `widget-summary` / `widget-notify` 已部署，`widget-notify` direct webhook + HMAC 模型已在 live 通过 202 / 401 验证，`G-41` 关闭 | `npx supabase functions deploy widget-register --project-ref fkhihclpghmmtbbywvoj`；`npx supabase functions deploy widget-summary --project-ref fkhihclpghmmtbbywvoj`；`npx supabase db query --linked -f supabase/migrations/20260413113000_widget_notify_hmac_replay_fix.sql`；`npx supabase migration repair 20260413113000 --linked --status applied --yes`；`npx supabase db query --linked -f supabase/migrations/20260413120000_widget_notify_secret_normalization.sql`；`npx supabase migration repair 20260413120000 --linked --status applied --yes`；`npx supabase functions deploy widget-notify --project-ref fkhihclpghmmtbbywvoj`；HMAC 正签 `202 push-disabled`；伪造签名 `401 INVALID_SIGNATURE` | register / summary / revoke 的真实用户链路证据仍缺；logout/account-switch live 验证未完成；push provider 仍未接通 | 是，已同步 proposal / execution / checklist |
| 2026-04-13 | `P1` | 修正 `widget-register` live 鉴权模式并补齐 register / summary / revoke 真实运行证据 | 生产 Auth 的 ES256 access token 已证实会被 Functions gateway 误判；`widget-register` 已纠偏为 `verify_jwt = false + auth.getUser(token)`，`widget-register` / `widget-summary` 限流桶已拆分，`P1-E01`~`P1-E07` 与 `G-42`、`G-44` 已闭合 | `npm run test:prepare-env && npx vitest run src/tests/contracts/widget-backend.contract.spec.ts --config vitest.config.mts`；`npx supabase functions deploy widget-register --project-ref fkhihclpghmmtbbywvoj`；`npx supabase functions deploy widget-summary --project-ref fkhihclpghmmtbbywvoj`；临时邮箱确认用户 + live `register/rotate/revoke-all/summary` 探针；受控 `summaryIpPerMinute=1` 的 401/429 drill；受控 `refreshAllowed=false` 的 503 drill；soft-delete target SQL seed + live summary drill；Supabase security/performance advisors rerun | 主应用 logout / account-switch live UI 链路仍未做端到端验证；`widget-notify` 仍停留在 `pushAllowed = false`，真实 push provider 未接通 | 是，已同步 proposal / execution / checklist |
| 2026-04-13 | `P1` | 完成 G-43 live 端到端 logout / account-switch / server-first revoke 验证 | admin API 创建临时用户 → register 设备/实例 → summary 200 verified → revoke-all 200 revokedCount=1 → auth.signOut 204 → 旧 token 401 DEVICE_REVOKED → A→B 换号 401 BINDING_MISMATCH | live 脚本 `node -e` 对生产 Supabase fkhihclpghmmtbbywvoj 执行完整 register → summary → revoke-all → signOut → rejection → account-switch 验证；测试用户验证后通过 admin API 删除 | `widget-notify` 仍 `pushAllowed=false`，真实 push provider 未接通；notify 作为独立可选能力不阻塞 P1 exit | 是，G-43 关闭，P1-X02 闭合，P1 转 completed |
| 2026-04-13 | `P1` | 发现生产前端 deployment drift，重新打开 G-43 的生产 UI 证据 | 本地 `npm run build` 产物在 `dist/browser/chunk-DKKKYX4L.js` 与 `dist/browser/widgets/widget-runtime.js` 命中 `widget-register` / `widget-summary` / `WIDGET_REFRESH` / `nanoflow-widget` / `revoke-all` / `bindingGeneration`；但 `https://dde-eight.vercel.app/ngsw.json` 当前列出的 110 个生产 JS 资产对这些签名全部 0 命中，说明线上前端尚未部署到含 Widget logout 路径的版本 | `npm run build`；`grep_search dist/browser/**/*.js`；生产 `ngsw.json` 资产扫描 | 当前环境缺少可用的 Vercel 凭证，尚未完成 redeploy；P1-X02 重新打开，仅保留 repo/backend 侧闭合 | 是，已同步 proposal / execution / checklist |
| 2026-04-13 | `P1` | 完成生产前端 redeploy 与真实 UI logout / account-switch 复核 | `dde-eight.vercel.app` 已部署当前前端；`ngsw.json` 资产扫描在 `/chunk-HZMSDGMX.js` 命中 `widget-register` / `WIDGET_REFRESH` / `nanoflow-widget` / `revoke-all` / `bindingGeneration`；生产 UI 实测为 `widget-register revoke-all 200` 先于 `auth/v1/logout 204`，且 A 登出后 B 登录 `user-menu` 已切换为 B 邮箱，因此 `G-43`、`P1-X02` 重新闭合，`P1` 转回 `completed` | `npx vercel --prod --yes`（带 `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`）重发生产部署；生产 `ngsw.json` 资产扫描；headless Playwright 对 `https://dde-eight.vercel.app` 执行 A 登录 → 登出 → B 登录 复核 | `widget-notify` 仍 `pushAllowed=false`，真实 push provider 未接通；`P1.5` 的 Windows 实机证据仍待补齐 | 是，已同步 proposal / execution / checklist |
| 2026-04-13 | `P1.5` | 完成 P15-D01~D07 全部交付物实现 | `sw-composed.js` 组合 SW 落地（importScripts ngsw-worker.js + widget-runtime.js）；`widget-runtime.js` 接通 widgetinstall/widgetresume/widgetclick/widgetuninstall/activate/periodicsync 全部事件；Adaptive Cards 模板（focus-summary/auth-required/setup-required/error-fallback）落地；widgetclick 单窗口复用 + leader-aware（focused > visible > any）；只读范围强制；manifest widgets multiple=false；WidgetBindingService 增加 registerDevice + IndexedDB token 共享；vercel.json / netlify.toml / ngsw-config.json 部署头同步 | `main.ts` SW target → `sw-composed.js`；`public/sw-composed.js` + `public/widgets/widget-runtime.js` + 4 模板；manifest widgets；部署头 no-cache；widget-binding / auth-coordinator / contract 测试全通过 | 需真实 Edge 安装态验证 P15-E01~E06；SW 升级链兼容性需实机确认 | 是 |
| 2026-04-13 | `P1.5` | 完成生产 Edge 安装产物与 widget manifest 接收取证 | `npm run pwa:edge-prod-install-proof` 已在 fresh Edge profile 中确认生产站点可安装，且 widget 定义已进入当前安装态 profile；但 Service Worker `self.widgets.matchAll()` 仍为空，`PWA.launch` 未能闭合 standalone/shortcut 证据，`WidgetBoard.exe` 启动后也未观察到宿主侧 NanoFlow 实例痕迹，因此 `P15-E01` 继续保持 `open` | `npm run pwa:edge-prod-install-proof`；`tmp/pwa-widget-prod-cdp-report.json`；`tmp/pwa-widget-prod-cdp-page.png`；`Get-ComputerInfo`；`Start-Process ...\WidgetBoard.exe` + host `LocalState` 复查 | 真实 Windows 11 Widgets Board Add widgets / instance 安装证据仍缺；当前主机自报 `Windows 10 Home China`，需在满足 Microsoft 宿主前提的环境继续闭合 `P15-E01`~`P15-E06` | 是 |
| 2026-04-14 | `P2` | 闭合 Web/TWA bootstrap producer，并与 Android 原生宿主回调契约打通 | Web 侧现已解析 `widgetBootstrap=1` hash 参数，在已登录会话中调用 `widget-register` 后构造 `nanoflow-widget://bootstrap#...` 回调；Android 路径明确不再把返回 token 写进 Web widget runtime 的共享 IndexedDB，避免污染 Windows/PWA 令牌；`WorkspaceShell` 已补齐有效 bootstrap 捕获、损坏链接清 query 降级、same-tab reload 的 `sessionStorage` 持续化和失败提示单测 | `npx vitest run src/workspace-shell.component.spec.ts src/utils/startup-entry-intent.spec.ts src/services/widget-binding.service.spec.ts src/tests/contracts/android-host.contract.spec.ts src/tests/assetlinks-contract.spec.ts src/utils/runtime-platform.spec.ts --config vitest.config.mts` | 仓库级 contract 与 Android 编译现已可验证，但仍缺真实 TWA 调起、native callback 投递和 OEM 后台策略取证；FCM provider 仍未 live enable | 是 |
| 2026-04-14 | `P2` | 修正 Android 宿主 bootstrap 触发条件并补齐最后实例删除后的本地清理 | Android widget 打开动作现在只会在未绑定 / 绑定失效 / 实例失配 / 待上报 push token 时切到 `entry=twa + widgetBootstrap=1`，正常按钮跳转恢复为 `entry=widget`，首次绑定不再因为错误入口被 Web 侧 bootstrap consumer 忽略；`widget-summary` 的绑定失效语义会主动清掉本地 binding，最后一个 widget 删除时会一并清掉 binding / summary / pending bootstrap / pending push token，FCM 也不再在无已安装 widget 时继续排队刷新 | `npm run test:android:host`；`cd android && .\gradlew installDebug`；`adb shell am start -W -n app.nanoflow.twa/app.nanoflow.host.NanoflowTwaLauncherActivity` | 当前仍未完成真实 widget 面板点击和 bootstrap 回调的设备侧交互取证；本轮只闭合了宿主启动/清理逻辑与真机安装 + Activity 启动验证 | 是 |
| 2026-04-14 | `P2` | 修正 Android 宿主三维状态文案消费与摘要请求 no-cache 约束 | Android 宿主现在会按 `freshnessState + trustState + sourceState + degradedReasons` 区分“云端同步中”“本地缓存摘要”“目标已变化”“摘要刷新已暂停”等状态，不再把所有 `provisional` 场景误显示成同步中；同时原生 `widget-summary` 请求已显式关闭共享 HTTP cache，满足 Android 本地缓存必须只落在显式存储层的约束 | `npm run test:android:host` | 仍缺真实 widget 面板交互下的截图/录屏证据；本轮是仓库级与编译级收口，不代表已完成 OEM/Doze/后台限制验真 | 是 |
| 2026-04-14 | `P2` | 修正 Android widget 上下文跳转链路，避免 startup query 清理后丢失 `project/task` 深链接 | `widget-summary` 现已优先按 current focus、其次按有效 dock 项输出上下文 `entryUrl`，其中 `soft-delete-target` 会强制回退工作区；Android 宿主在非 bootstrap 的 `open app` 路径，以及“已有合法缓存摘要时的强制 rebootstrap”路径，都会校验同源 + `#/projects` 后消费该 URL；Web `resolveStartupEntryRouteIntent()` 与 startup query 清理逻辑已改为保留原始 `project/task` 路径，不再把显式 widget/shortcut 深链硬抹平成 `/projects` | `npx vitest run src/utils/route-intent.spec.ts src/utils/startup-entry-intent.spec.ts src/workspace-shell.component.spec.ts src/services/handoff-coordinator.service.spec.ts src/tests/startup-contract.spec.ts --config vitest.config.mts`；`npx vitest run src/tests/contracts/widget-backend.contract.spec.ts --config vitest.config.mts`；`npm run test:android:host`；`cd android && .\gradlew.bat :app:compileDebugKotlin` | 仍缺真实 home-screen widget 点击后的设备侧录屏证据；bootstrap 场景下若本地完全没有可信缓存摘要，仍会回退到泛化工作区入口 | 是 |
| 2026-04-14 | `P2` | 完成 Android 真机安装 / 启动 / provider 注册验证 | 连接设备 `2410DPN6CC`（Android `16` / SDK `36`）上已完成 `installDebug`，`NanoflowTwaLauncherActivity` 启动返回 `Status: ok`，`dumpsys appwidget` 也已能看到 `app.nanoflow.twa/app.nanoflow.host.NanoflowWidgetReceiver` 被系统识别；说明 Android 宿主已经跨过“只在仓库内编译通过”的阶段，具备最小真机安装运行证据 | `./android/gradlew -p ./android installDebug`；`adb shell am start -W -n app.nanoflow.twa/app.nanoflow.host.NanoflowTwaLauncherActivity`；`adb shell dumpsys appwidget`；`adb shell pm list packages app.nanoflow.twa` | 设备当时处于 `Dozing + SCREEN_STATE_OFF + keyguard showing`，因此尚未拿到 widget 面板点击、可视前台界面或 bootstrap 回调录屏；当前只能关闭“APK 不可安装 / Activity 无法启动 / provider 未注册”这类基础风险 | 是 || 2026-04-15 | `P2` | 实现 SEC-12/P2-05 隐私模式并完成 widget 面板点击 / TWA 前台取证 | `NanoflowWidgetStore` 新增默认开启的隐私模式，`saveSummary()` 擦除 Black Box 正文/任务正文/项目标题，`buildRenderModel()` 改用计数与简化标题；contract test 6/6 通过；真机设备 `2410DPN6CC` 解锁后验证 widget instance id=6211 放置于 MIUI home screen，`OPEN_WORKSPACE`（222ms COLD）和 `OPEN_FOCUS_TOOLS`（201ms COLD）均成功启动 Chrome CustomTabActivity | `npx vitest run src/tests/contracts/android-host.contract.spec.ts`（6/6 通过）；`assembleDebug BUILD SUCCESSFUL`；`adb install -r app-debug.apk Success`；`adb shell am start -W --es extra.LAUNCH_INTENT OPEN_WORKSPACE`；`adb shell screencap`（home screen widget + TWA launch 截图） | bootstrap callback 真机交互取证仍缺（需清除 binding 后触发完整 bootstrap 流程）；FCM provider 仍未 live enable；OEM Doze/后台限制验真未完成 | 是 |
| 2026-04-15 | `P2` | 系统性 checklist 闭合与设备状态验真 | 关闭 TRUST-01/02/03（三维状态完整消费）、DATA-05（summaryVersion SHA 聚合覆盖展示字段）、DRILL-06（Xiaomi Doze 环境下 WorkManager RUNNABLE）、DRILL-08（live soft-delete-target drill 已通过）、DRILL-09（A→B 换号无残留已验证）、REL-CHK-03/04（三维状态降级文案清晰、支持矩阵已建立）。widget instance id=6213 在 MIUI home 上确认活跃，WorkManager job `RUNNABLE` 且 quota 充足。assetlinks.json 已在 `public/.well-known/` 生成（debug cert），但 Vercel 构建会在缺少 `ANDROID_TWA_PACKAGE_NAME`/`ANDROID_TWA_SHA256_CERT_FINGERPRINTS` 环境变量时主动删除以防止误部署过期指纹 | `adb shell dumpsys appwidget`（instance id=6213 active）；`adb shell dumpsys jobscheduler`（WorkManager RUNNABLE）；`npx vitest run` 11/11 contract tests pass；`npm run build` 验证构建链完整 | assetlinks.json 部署需在 Vercel dashboard 设置 `ANDROID_TWA_PACKAGE_NAME=app.nanoflow.twa` 和 `ANDROID_TWA_SHA256_CERT_FINGERPRINTS`（debug: `BC:6A:31:...`）后重新部署；FCM provider 仍未配置；bootstrap callback 端到端设备测试仍缺 | 是 |
| 2026-04-16 | `P2` / OBS | 落地 OBS-01~OBS-14 全部 14 个遥测事件 | Edge functions (widget-register / widget-summary / widget-notify) 全部通过 `logWidgetEvent()` 发射；Web SW (`public/widgets/widget-runtime.js`) 补齐 `logWidgetTelemetry()` helper，覆盖 install/uninstall/stale/untrusted/activate；Android host 继续通过 `NanoflowWidgetTelemetry.info/warn` 发射 install/uninstall/summary success/failure/stale/untrusted；Web 侧 `widget-binding.service.ts` 在 revoke-all 成功后补齐 `widget_account_switch_cleanup` 日志。日志统一结构化 JSON，敏感 ID 经 `redactId()` 脱敏 | `supabase/functions/_shared/widget-common.ts` 新增 `logWidgetEvent()` + `WidgetTelemetryEvent` 类型；三个 Edge 函数在 return 分支前发射事件；`public/widgets/widget-runtime.js` 新增 `logWidgetTelemetry()` 并串联生命周期；Android 宿主既有发射点保留 | 未做 compile/test/run（用户显式约束）；集中遥测 sink 未接入，当前仅以 `supabase functions logs` / DevTools / adb logcat 消费 | 是 |
| 2026-04-16 | `P2` / REL-05 + RB-06 | 落地按平台/版本/bucket 的 capability rules 与客户端版本透传 | `widget_capabilities` 已从平铺布尔扩成 `base + rules[]`，规则支持 `platforms + clientVersions/clientVersionPrefixes + bucketMin/bucketMax + apply`；`widget-register` 现按 install decision 拒绝不允许的平台注册，`widget-summary` 在设备鉴权后按 refresh decision 返回受控 `503 WIDGET_REFRESH_DISABLED`，`widget-notify` 则按 Android 设备逐个筛出 `eligibleDevices` 后再 fanout。Android 原生宿主通过 bootstrap hash 参数新增 `widgetClientVersion` 把 host 版本带入 authenticated register，后续 summary 请求也带 `clientVersion`；Windows `widget-runtime.js` 则从共享 IndexedDB `widget-config.clientVersion` 上送 Web 版本。 | `supabase/functions/_shared/widget-common.ts` 新增 rule normalization / `evaluateWidgetCapabilities()` / rollout bucket；`widget-register/index.ts`、`widget-summary/index.ts`、`widget-notify/index.ts` 接入 decision；`NanoflowBootstrapContract.kt` / `startup-entry-intent.ts` / `widget-binding.service.ts` / `widget-runtime.js` / `NanoflowWidgetRepository.kt` 串起 Android + Windows clientVersion；`app_config` foundation/init + backfill migration 同步 `rules: []` 默认值 | 未做 compile/test/run（用户显式约束），也未做 live app_config 演练；Windows 注册链仍待产品面使用点闭合，因此当前更偏向“后端能力 + Android 链路 + Windows summary 元数据已就位” | 是 |
| 2026-04-16 | `P2` / OBS+B | 真机遥测 + bootstrap 链路取证 (device `a472af56`) | (A) 触发 force-stop → launcher 重启后 NanoflowWidgetRefreshWorker 发出 `widget_summary_fetch_failure {code:WIDGET_BOOTSTRAP_REQUIRED, instanceId:a72d70b9..., trustState:auth-required}`，确认 Android OBS JSON 结构与 redactId 生效。(B) 通过 `am start -n NanoflowTwaLauncherActivity --ei extra.APP_WIDGET_ID 177 --es extra.ENTRY_SOURCE widget --es extra.LAUNCH_INTENT OPEN_WORKSPACE` 触发 TWA，Chrome Custom Tab 加载的 URL 包含完整 bootstrap 参数链（`widgetBootstrap=1 + widgetBootstrapReturnUri=nanoflow-widget://bootstrap + widgetInstallationId/DeviceId/DeviceSecret/InstanceId/HostInstanceId=177/BootstrapNonce/SizeBucket=4x2`），即 Launcher→TWA 侧构造完全符合契约 | `adb logcat -d -s NanoFlowWidget:*` JSON 直观可见；`dumpsys` capturedLink 字段验证 Chrome 加载 URL | 回调闭合需要设备 Chrome 在 nanoflow 域已登录；该环节依赖真人登录，不在本轮 adb 自动化内 | 是 |
| 2026-04-16 | `P2` / DRILL-04 DRILL-07 | C/D 降级演练真机取证（在线 Edge 端点） | (D kill switch) 通过 Supabase Management API 翻转 `widget_capabilities.widgetEnabled=false`，`POST /functions/v1/widget-summary` 返回 `503 WIDGET_REFRESH_DISABLED degradedReasons:["refresh-disabled"] capabilities.widgetEnabled:false`，立即还原。(C rate limit) 将 `widget_limits.summaryIpPerMinute` 从 120 调至 1，三次连续请求：#1 通过（仅因无 token 返回 401 WIDGET_TOKEN_REQUIRED，证明桶可用）；#2 返回 `429 RATE_LIMITED retryAfterSeconds:300 degradedReasons:["rate-limited"]`；#3 返回 `429 retryAfterSeconds:295`（倒计时递减，block 期内一致）。还原 summaryIpPerMinute=120，widget_capabilities 与 widget_limits 基线全部恢复 | PowerShell 脚本 `scripts/widget-drill.ps1` + Management API SQL。每次演练均在 <10s 内翻转并还原，且带 retryAfterSeconds 校验 | IP rate-limit 桶未主动清理（桶中 `updated_at` 触发的 300s 惩罚期会自然过期，不影响生产 IP 消费者）；drill 未覆盖 Android host 端 UI 降级观察（下一轮可在设备登录后闭合） | 是 |
| 2026-04-16 | `P2` / FP-01~08 | 反假阳性 §5 全量代码审计闭合 | 逐条验真并在 §5 勾选 `[x]`：FP-01 token 失效四层闸（`revoked_at/binding_generation/expires_at/secret_hash`）；FP-02 所有摘要查询链式 `.is('deleted_at', null)`；FP-03/04 `widget_instances` 按 `id+device_id+user_id+platform` 复合隔离，Android `onDeleted` 只清被删实例并根据 `hasWidgetsRemaining` 决定周期刷新；FP-05 widget 渲染仅读 Edge 返回，无本地草稿旁路；FP-06 Phase D 已取证 + Android & Web SW 双端 `widget_killswitch_applied` 退避遥测；FP-07 SW `activate` 固发 `widget_sw_activate_refresh`；FP-08 `runtime-platform.ts` 以 UA+standalone+`android-app://` referrer 三要素共同判定 TWA/PWA，`normalizeWidgetPlatform` 硬白名单仅允许 `windows-pwa/windows-widget/android-widget` | 代码定位参见 §5 各条目内 inline 行号引用（widget-summary L610/623/634/645/675-681/747/776/…；widget-binding.service.ts revokeAllBindings；NanoflowWidgetReceiver.kt onDeleted；runtime-platform.ts resolveRuntimePlatformSnapshot） | FP-01 / FP-05 / FP-06 的终端用户端 UI 退化仍需真实账号与真机长期演练，代码级保证已到位 | 是 |
| 2026-04-16 | `P2` / Phase E | Phase E FCM HTTP v1 fanout 代码落地 | 新增 `supabase/functions/_shared/widget-fcm.ts`：(a) `loadFcmServiceAccount()` 读取 `FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY`，自动把 `\n` 转义还原；(b) `getFcmAccessToken()` 通过 RS256 签名 JWT 调用 `oauth2.googleapis.com/token` 并内存缓存（TTL 扣除 5min 安全窗口）；(c) `sendFcmDataPush()` 调用 `fcm.googleapis.com/v1/projects/{projectId}/messages:send`，data-only payload，Android `priority=HIGH, ttl=300s`；(d) `classifyFcmErrorStatus` 对 404/UNREGISTERED + 400/INVALID_ARGUMENT 标 `unregistered/invalid-token`。`widget-notify/index.ts` accepted 分支替换 dry-run：为每个 eligible device 并发发推；对 `unregistered/invalid-token` 设备 `UPDATE widget_devices SET push_token=NULL`；按至少一条成功 → `accepted-fanout`（HTTP 202），全部失败 → `fanout-failed`（HTTP 202 + `failureByReason`）；新增状态 `accepted-fanout` / `fanout-failed` 到 `WidgetNotifyStatus` union；`widget_push_dirty_sent` 附带 `deliveryMode=fcm-v1 + successCount + invalidatedTokenCount + failureByReason` | `supabase/functions/_shared/widget-fcm.ts` 新建；`supabase/functions/widget-notify/index.ts` accepted 分支改写 + 状态枚举扩展 | 未做 compile/test/run（用户约束）；真实 FCM fanout 端到端验证需用户提供 Firebase 服务账号 JSON + Supabase Secrets（`FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY`）+ 把 `widget_capabilities.pushAllowed` 设为 `true` + 一台已 register push_token 的 Android 设备；缺任一都会落到既有 `PUSH_PROVIDER_UNAVAILABLE` / `no-active-android-devices` 分支（已有测试覆盖） | 是 |
## 11. 最终签署条件

只有同时满足以下条件，当前阶段才允许签署“通过验收”：

1. 本阶段所有 `D`、`E`、`X` 项均闭合。
2. 本阶段关联的 `G-*` 门禁已关闭。
3. 无未解释的 `FP-*` 阻塞项残留。
4. 回滚路径明确且已记录。
5. Proposal、Checklist、Execution 三份文档不存在相互冲突的实施口径。
