---
title: Edge Functions
status: canonical
audience: operator
last_verified: 2026-11-10
category: deploy-operate
source_paths:
  - package.json
  - scripts/supabase-cli.cjs
  - supabase/config.toml
  - supabase/functions/transcribe/index.ts
  - supabase/functions/_shared/widget-common.ts
  - supabase/functions/_shared/widget-fcm.ts
  - supabase/functions/widget-register/index.ts
  - supabase/functions/widget-summary/index.ts
  - supabase/functions/widget-notify/index.ts
  - supabase/functions/widget-focus-action/index.ts
  - supabase/functions/widget-black-box-action/index.ts
  - supabase/functions/virus-scan/index.ts
  - supabase/functions/cleanup-attachments/index.ts
  - src/config/focus.config.ts
  - src/services/speech-to-text-transcriber.ts
---

# Edge Functions

NanoFlow 当前真正需要运维的 Edge Functions 分成四组：语音转写、Android 小组件、附件扫描/清理、以及一个尚未纳入运行合同的占位目录。先确认你面对的是哪一组，再决定是正常操作、密钥变更，还是基础设施变更。

## 本文内容

- [当前实际在运维范围内的函数](#当前实际在运维范围内的函数)
- [鉴权、CORS 与配置边界](#鉴权cors-与配置边界)
- [正常操作和需要 secretsinfra 的边界](#正常操作和需要-secretsinfra-的边界)
- [安全部署流程](#安全部署流程)
- [按函数组做冒烟验收](#按函数组做冒烟验收)
- [常见失败信号与恢复](#常见失败信号与恢复)
- [日志与证据](#日志与证据)
- [回滚与事故安全](#回滚与事故安全)
- [未纳入运行册的目录](#未纳入运行册的目录)

## 当前实际在运维范围内的函数

`supabase/config.toml` 里当前显式配置并启用运行合同的函数是：

| 函数组 | 函数 | 主要调用方 | 主要成功信号 |
| --- | --- | --- | --- |
| 语音转写 | `transcribe` | 登录用户的浏览器/TWA | `200`，返回 `text`、`duration`、`language` |
| 小组件注册 | `widget-register` | 登录用户的浏览器/TWA | `200`，返回 `widgetToken`、`bindingGeneration`、`expiresAt` |
| 小组件摘要 | `widget-summary` | Android widget | `200`，`trustState: verified`，带 `summaryVersion` |
| 小组件通知 | `widget-notify` | 标准 webhook 或登录用户 JWT `directNotify` | `status: accepted` 且 `deliveryMode: fcm-v1`，或幂等重放时 `status: duplicate` |
| 小组件动作 | `widget-focus-action`、`widget-black-box-action` | Android widget | 实际动作生效，后续 `widget-summary` 反映新状态 |
| 附件扫描 | `virus-scan` | 登录用户或内部重扫调用方 | `health` 返回 `healthy/degraded/unhealthy`；`scan/rescan` 返回扫描结果 |
| 附件清理 | `cleanup-attachments` | 维护调用方 | `200`，返回 `deletedCount`、`storageDeletedCount`、`hasMore`、`nextCursor`、`scanWrapped` |

重要事实：

1. `backup-alert` 的零字节占位入口已由 B18 移除，仓库中没有该函数目录。
2. `supabase/config.toml` 里没有 `[functions.backup-alert]`。
3. 因此本页不把该 slug 当成可操作函数写运行步骤。

## 鉴权、CORS 与配置边界

### 网关 JWT 边界

`supabase/config.toml` 里当前配置的活动函数都设置了 `verify_jwt = false`。这不等于“任何请求都能过”，只表示 Supabase 网关不替你做 JWT 拦截，真实的鉴权边界在函数源码里：

| 路径 | 网关层 | 函数内真实边界 |
| --- | --- | --- |
| `transcribe` | `verify_jwt = false` | 必须有 `Authorization: Bearer <user-jwt>`；函数内用 service-role client 调 `auth.getUser()` 校验 |
| `widget-register` | `verify_jwt = false` | 必须有用户 JWT；失败返回 `401 AUTH_REQUIRED` |
| `widget-summary` | `verify_jwt = false` | 必须有 widget bearer token；失败时不仅看 HTTP 状态，还要看 `trustState` 和 `degradedReasons` |
| `widget-focus-action` / `widget-black-box-action` | `verify_jwt = false` | 必须有 widget bearer token，并校验 `token_hash` / `secret_hash` / `binding_generation` / `expires_at` |
| `widget-notify` | `verify_jwt = false` | 二选一：标准 webhook 签名头 + `WIDGET_NOTIFY_WEBHOOK_SECRET`，或用户 JWT + `directNotify: true` 请求体 |
| `virus-scan` 用户动作 | `verify_jwt = false` | `health`、`scan`、`status`、`verify-hash`、`rescan` 都需要用户 JWT |
| `virus-scan` 内部重扫 | `verify_jwt = false` | `action: "rescan-due"` 不用用户 JWT，改用 `x-virus-rescan-secret` 与 `VIRUS_RESCAN_CRON_SECRET` |
| `cleanup-attachments` | `verify_jwt = false` | 只接受维护 bearer secret；源码明确拒绝普通用户 JWT 和 service-role key 作为请求凭据 |

### CORS 边界

不是所有函数都应该接受浏览器跨域请求：

| 路径 | CORS 行为 |
| --- | --- |
| `transcribe` | 只允许白名单 origin；默认包含 `https://dde-eight.vercel.app`、`https://nanoflow.app`、`https://nanoflow.pages.dev`、本地开发地址；`ALLOW_PREVIEW_ORIGINS=true` 时接受受控 preview 域名 |
| `widget-register` / `widget-summary` / `widget-notify` / `widget-focus-action` / `widget-black-box-action` | 共用 `_shared/widget-common.ts` 的白名单和 preview 规则；响应带 `private, no-store` 头 |
| `virus-scan` | 自己维护白名单；允许头额外包含 `x-virus-rescan-secret` |
| `cleanup-attachments` | 没有浏览器 CORS 合同，只是纯 `POST` 维护入口 |

### 共享配置、Secrets 和运行时行为

| 配置或 Secret | 用在什么地方 | 缺失时你会看到什么 | 谁可以改 |
| --- | --- | --- | --- |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | 所有真实运行函数 | `503 SERVICE_NOT_CONFIGURED` 或等价错误 | Secret / Infra owner |
| `ALLOWED_ORIGINS` / `ALLOW_PREVIEW_ORIGINS` | `transcribe`、widget 系列、`virus-scan` | CORS 命中异常、预检失败、错误 origin 回退到默认 origin | Infra owner |
| `GROQ_API_KEY` | `transcribe` | `503 SERVICE_NOT_CONFIGURED`，日志里有 `[Transcribe] GROQ_API_KEY not configured` | Secret owner |
| `WIDGET_NOTIFY_WEBHOOK_SECRET` | `widget-notify` webhook 路径 | `503 WEBHOOK_SECRET_MISSING` 或 `401 INVALID_SIGNATURE` | Secret owner |
| `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY` | `widget-notify` FCM v1 | 不会真正推送；返回 `202 accepted` 但 `deliveryMode: dry-run` | Secret owner |
| `CLAMAV_API_URL` | `virus-scan` | `health` 走 `degraded/unhealthy`，扫描路径失败 | Infra owner |
| `VIRUS_RESCAN_CRON_SECRET` | `virus-scan` 的 `rescan-due` | `401 INTERNAL_AUTH_REQUIRED` | Secret owner |
| `CLEANUP_ATTACHMENTS_SECRET` 或 `MAINTENANCE_CRON_SECRET` | `cleanup-attachments` | 缺失 `503`，错误 secret 得 `401` | Secret owner |

非 secret 但同样重要的运行时行为配置：

- `widget_limits` 从 app config 读取；默认值是注册 `10/20`、摘要 `30/60/120`、通知 `120/600`、封禁 `300s`、token TTL `30d`、新鲜阈值 `5min`、老化阈值 `60min`。
- `widget_capabilities` 也从 app config 读取；它不是 secret，但会直接改变 widget 行为，不能当成普通排障手段随手改。
- `transcribe` 和前端 `FOCUS_CONFIG.SPEECH_TO_TEXT` 约定一致：`EDGE_FUNCTION_NAME='transcribe'`、`MODEL='whisper-large-v3'`、`LANGUAGE='zh'`、`DAILY_QUOTA=50`、`MAX_FILE_SIZE=25MB`。

## 正常操作和需要 secrets/infra 的边界

### 正常 operator 可以做

- 用仓库脚本部署函数代码。
- 用真实 UI 流程做冒烟验收。
- 看 Network、函数响应 JSON、Supabase Edge Function logs。
- 在收到 `Retry-After` 时按函数给出的等待时间重试。
- 在 widget 或扫描路径出错时收集 `code`、`trustState`、`degradedReasons`、`retryAfterSeconds`、`webhookId`、`nextCursor` 之类的证据。

### 需要 Secret / Infra owner 的动作

- 设置或轮换任何 `supabase secrets set ...` 值。
- 修改 `ALLOWED_ORIGINS`、`ALLOW_PREVIEW_ORIGINS`。
- 修 ClamAV 可用性、修 FCM service account、修 webhook secret。
- 调用 `virus-scan` 的 `rescan-due`。
- 调用 `cleanup-attachments`。

这条边界要记清：缺 secret、缺 service-role、FCM 或 ClamAV 不可用时，单纯重发代码不会恢复服务。

## 安全部署流程

### 1. 先确认你连的是正确 Supabase 项目

仓库已经提供统一包装脚本，不要直接依赖系统里另一个版本的 `supabase` CLI。

```bash
npm run supabase:login
npm run supabase:link
npm run supabase:status
```

仓库脚本来源：

- `package.json` 暴露了 `supabase:*` 命令。
- `scripts/supabase-cli.cjs` 会走仓库里的本地 CLI，并读取 `.env.local`，避免全局环境漂移。

### 2. 先判断这是代码变更，还是 secret / infra 变更

- 只改函数源码：先部署代码，再做冒烟。
- 改 secret：设置 secret 后仍要重新部署对应函数，再做冒烟。
- 改 ClamAV、FCM、webhook、allowed origins：这是 infra 变更，不要混在“普通函数发布”里。

### 3. 部署时优先只动受影响的函数

单函数部署：

```bash
node scripts/supabase-cli.cjs functions deploy transcribe
node scripts/supabase-cli.cjs functions deploy widget-register
node scripts/supabase-cli.cjs functions deploy widget-summary
node scripts/supabase-cli.cjs functions deploy widget-notify
node scripts/supabase-cli.cjs functions deploy widget-focus-action
node scripts/supabase-cli.cjs functions deploy widget-black-box-action
node scripts/supabase-cli.cjs functions deploy virus-scan
node scripts/supabase-cli.cjs functions deploy cleanup-attachments
```

仓库也提供了统一入口：

```bash
npm run supabase:functions:deploy
```

本地联调入口：

```bash
npm run supabase:functions:serve
```

### 4. 涉及 secret 时，只在 Supabase 侧设置，不要写进仓库

仓库提供的是包装入口，不是把 secret 放进文档或代码里的许可：

```bash
node scripts/supabase-cli.cjs secrets set GROQ_API_KEY=...
node scripts/supabase-cli.cjs secrets set WIDGET_NOTIFY_WEBHOOK_SECRET=...
node scripts/supabase-cli.cjs secrets set FCM_PROJECT_ID=...
node scripts/supabase-cli.cjs secrets set FCM_CLIENT_EMAIL=...
node scripts/supabase-cli.cjs secrets set FCM_PRIVATE_KEY=...
node scripts/supabase-cli.cjs secrets set VIRUS_RESCAN_CRON_SECRET=...
node scripts/supabase-cli.cjs secrets set CLEANUP_ATTACHMENTS_SECRET=...
```

## 按函数组做冒烟验收

### `transcribe`

安全冒烟路径：

1. 用真实登录用户。
2. 通过应用发起一次很短的小音频转写，或构造一次真实 `multipart/form-data` 请求。
3. 观察 `/functions/v1/transcribe` 的响应。

健康信号：

- `200`。
- 返回体包含 `text`、`duration`、`language`。
- 前端会把 `Retry-After` 读出来做受控退避；所以如果服务标记 `retryable: true`，不要立刻狂点重试。

红灯信号：

- `401 AUTH_REQUIRED`：没带用户 JWT 或会话已失效。
- `503 SERVICE_NOT_CONFIGURED`：`SUPABASE_*` 或 `GROQ_API_KEY` 缺失。
- `503 QUOTA_UNAVAILABLE`：配额 RPC 不可用，且带 `Retry-After: 30`。
- `429 QUOTA_EXCEEDED`：当天配额到顶。
- `503 GROQ_TIMEOUT`：Groq 在 25 秒内没回，带 `Retry-After: 30`。
- `502 GROQ_UNREACHABLE`：上游网络不可达，带 `Retry-After: 30`。
- `429 GROQ_RATE_LIMITED`：Groq 自己限流，`Retry-After` 以 Groq 响应为准。
- `502 SERVICE_UNAVAILABLE`：Groq 返回非 429 的上游失败。
- `413 FILE_TOO_LARGE`：超过 25MB。

### `widget-register`

安全冒烟路径：

1. 用真实登录用户完成 widget 绑定或重新绑定。
2. 看 `/functions/v1/widget-register` 的响应。

健康信号：

- `200`。
- 返回 `deviceId`、`bindingGeneration`、`expiresAt`、`widgetToken`、`summaryPath`。

红灯信号：

- `401 AUTH_REQUIRED`：用户 JWT 无效。
- `429 RATE_LIMITED`：看 `retryAfterSeconds`。
- `413 REQUEST_BODY_TOO_LARGE`。
- `400 INVALID_JSON` / `INVALID_ACTION`。

### `widget-summary`

这是 widget 运行期最关键的真相源，不要只看 HTTP `200`。

安全冒烟路径：

1. 完成一次 `widget-register`。
2. 触发 widget 刷新。
3. 看 `/functions/v1/widget-summary` 响应。

健康信号：

- `200`。
- `trustState: verified`。
- 有 `summaryVersion`。
- `freshnessState` 合理，且没有重要 `degradedReasons`。

重点观察字段：

- `trustState`: `verified` / `provisional` / `untrusted` / `auth-required`
- `degradedReasons`
- `summaryVersion`
- `cloudUpdatedAt`
- `freshnessState`

常见退化信号：

- `WIDGET_TOKEN_REQUIRED`
- `DEVICE_NOT_FOUND`
- `DEVICE_REVOKED`
- `TOKEN_INVALID`
- `BINDING_MISMATCH`
- `TOKEN_EXPIRED`
- `INSTANCE_BINDING_MISMATCH`
- `RATE_LIMITED`
- `push-token-missing`
- `summary-version-regressed`
- `dock-count-drift`

如果 `trustState !== verified`，函数还会记 `widget_untrusted_render` 事件。这个比“前端看起来似乎还能用”更值得信。

### `widget-notify`

这个函数有三种完全不同的输入边界：

1. 标准 webhook 签名头。
2. 登录用户 JWT + `directNotify: true`。
3. FCM fanout 出口。

安全冒烟路径：

1. 正常 operator 优先走真实应用流，而不是自己伪造 webhook。
2. Focus 变化或 Black Box 事件发生后，观察 `/functions/v1/widget-notify`。
3. 只有拥有 secret 的人，才应该验证标准 webhook 或直接改 FCM 凭据。

健康信号：

- `status: accepted` 且 `deliveryMode: fcm-v1`。
- 幂等重放可接受 `status: duplicate`。

需要立刻分流的信号：

- `503 WEBHOOK_SECRET_MISSING`
- `401 INVALID_SIGNATURE`
- `401 INVALID_JWT`
- `400 INVALID_PAYLOAD`
- `409 status: processing`，并带 `Retry-After`
- `202 status: accepted` 但 `deliveryMode: dry-run`
- `202 status: skipped` 且 `reason: push-provider-unavailable`
- `202 status: skipped` 且 `reason: notify-rate-limited`

`deliveryMode: dry-run` 的含义很明确：函数接受了事件，但没有真正把推送送进 FCM。最常见原因是 `FCM_PROJECT_ID`、`FCM_CLIENT_EMAIL`、`FCM_PRIVATE_KEY` 缺失。

### `widget-focus-action` 和 `widget-black-box-action`

这两条路径都不适合用“伪请求”做日常冒烟，最安全的验收方式是直接点真实 widget。

健康信号：

- 交互成功。
- 下一次 `widget-summary` 能反映这次动作。

关键失败码：

- `401 AUTH_REQUIRED`
- `401 TOKEN_INVALID`
- `401 DEVICE_REVOKED`
- `401 TOKEN_EXPIRED`
- `500 DEVICE_LOOKUP_FAILED`

`widget-black-box-action` 的源码合同还明确了两点：

- `read` 不是永久消失，只是短时缄默，后续会在 cooldown 后重新出现。
- `complete` 会把条目标成完成，并在后续摘要里移出大门队列。

### `virus-scan`

最安全的生产冒烟是先做 `health`，再决定要不要碰真实文件。

安全冒烟路径：

1. 用真实用户 JWT 调 `action: "health"`。
2. 如果这次发布改到了真实扫描逻辑，再用一个专门的测试附件做 `scan` / `status` / `rescan`。
3. `rescan-due` 只属于拥有 `VIRUS_RESCAN_CRON_SECRET` 的内部调用方。

健康信号：

- `health` 返回 `status: healthy` 或 `status: degraded`，并带 `clamav` 布尔值。
- `scan` / `rescan` 正常返回扫描结果。
- `rescan-due` 正常返回 `{ scanned, deferred, requested }`。

关键失败信号：

- `401 AUTH_REQUIRED`：用户动作没过 JWT 校验。
- `401 INTERNAL_AUTH_REQUIRED`：`rescan-due` 的 secret 不对。
- `503 SERVICE_NOT_CONFIGURED`
- `413 File too large (max 10MB)`
- `404 Scan record not found`
- `429 Rescan rate limited`
- `409 Rescan already in progress`
- `404 File not found in storage`
- `502 Failed to download file for rescan`
- `409 Storage object changed during rescan`
- `409 Rescan result superseded`
- `500 Failed to claim due rescans`

### `cleanup-attachments`

这不是“顺手点一下”的函数。它没有 dry-run 分支，调用就会真的删除 Storage 文件并更新任务附件状态。

安全冒烟策略：

- 正常 operator 不在生产上做例行冒烟。
- 只有在明确维护窗口和明确目标下，才让 secret owner 调用。

调用后应看这些字段：

- `success`
- `message`
- `deletedCount`
- `storageDeletedCount`
- `dbUpdatedCount`
- `hasMore`
- `tasksProcessed`
- `nextCursor`
- `scanWrapped`

字段解释：

- `hasMore=true`：本轮没扫完，还需要下一次受控调用。
- `nextCursor`：下一轮继续的位置。
- `scanWrapped=true`：扫描游标已经从表尾绕回表头，这不是报错，只是轮转证据。

## 常见失败信号与恢复

### 转写故障

先看函数响应码，再看 logs：

| 信号 | 含义 | 恢复动作 |
| --- | --- | --- |
| `401 AUTH_REQUIRED` | 用户会话没带上 | 让用户重新登录后重试 |
| `503 SERVICE_NOT_CONFIGURED` | `SUPABASE_*` 或 `GROQ_API_KEY` 缺失 | 由 secret owner 修 secret，再重新部署对应函数 |
| `503 QUOTA_UNAVAILABLE` | 配额 RPC 暂时不可用 | 尊重 `Retry-After`，不要立即连点 |
| `429 QUOTA_EXCEEDED` | 用户当日配额用尽 | 不要继续重试 |
| `503 GROQ_TIMEOUT` / `502 GROQ_UNREACHABLE` / `429 GROQ_RATE_LIMITED` / `502 SERVICE_UNAVAILABLE` | Groq 上游问题 | 按 `Retry-After` 等待；代码回滚通常无效，先判定是不是上游或 secret 问题 |

### Widget 故障

先分清是注册、摘要、通知还是动作。

| 路径 | 第一观察点 | 第二观察点 |
| --- | --- | --- |
| `widget-register` | `401/429/413/400` | 是否返回了新的 `widgetToken` / `bindingGeneration` |
| `widget-summary` | `trustState` | `degradedReasons`、`summaryVersion`、`freshnessState` |
| `widget-notify` | `status` / `deliveryMode` | `webhookId`、`Retry-After`、`reason` |
| `widget-focus-action` / `widget-black-box-action` | `401/500` | 下一次 `widget-summary` 是否修正了状态 |

恢复原则：

1. `auth-required`、`token-mismatch`、`binding-mismatch`、`token-expired` 一类问题，优先让 widget 重新注册，不要先手改数据库。
2. `deliveryMode: dry-run`、`PUSH_PROVIDER_UNAVAILABLE` 先查 FCM 凭据，不要先怀疑摘要逻辑。
3. `status: processing` 或 `notify-rate-limited` 必须尊重返回的 `Retry-After`。
4. FCM 返回 `unregistered` / `invalid-token` 时，函数会自动把对应 `push_token` 清空；恢复路径是让设备重新注册，而不是继续盲推。

### 附件扫描和清理故障

| 信号 | 含义 | 恢复动作 |
| --- | --- | --- |
| `health => degraded/unhealthy` | ClamAV 或扫描链路异常 | 先恢复 `CLAMAV_API_URL` 指向的服务，再测 `health` |
| `rescan => 404 File not found in storage` | DB 里有记录，Storage 对象没了 | 先判定对象是否已被删除或路径漂移 |
| `rescan => 409 Storage object changed during rescan` | 对象版本变了 | 不要强推，等对象稳定后再重扫 |
| `rescan => 429/409` | 被最小间隔或并发占用保护住了 | 按返回的 `retryAfterSeconds` 再试 |
| `cleanup-attachments => success=false` 或大量 `storageErrors` / `dbErrors` | 真正的删除或回写失败 | 停止继续调用，先保留证据，再处理 |

## 日志与证据

排障时不要只记“失败了”，要记函数自己的证据。

### `transcribe`

重点搜这些日志前缀：

- `[Transcribe] No Authorization header`
- `[Transcribe] Quota reservation error`
- `[Transcribe] GROQ_API_KEY not configured`
- `[Transcribe] Groq API timed out after`
- `[Transcribe] Groq API fetch failed`
- `Transcribe Error:`

同时保留：

- HTTP 状态码
- `code`
- `retryable`
- `Retry-After`

### Widget 系列

widget 共用 `logWidgetEvent()`，日志前缀是：

```text
[WidgetTelemetry]
```

重点事件：

- `widget_register_failure`
- `widget_register_success`
- `widget_instance_install`
- `widget_untrusted_render`
- `widget_push_dirty_sent`
- `widget_push_dirty_dropped`

采证时至少保留：

- `trustState`
- `degradedReasons`
- `webhookId`
- `deliveryMode`
- `retryAfterSeconds`
- 相关 `userId/deviceId/instanceId` 的脱敏值

### `virus-scan`

重点证据：

- `status: healthy/degraded/unhealthy`
- `Unauthorized request for action`
- `Claimed rescan error`
- `Due rescan claim returned ...`
- `retryAfterSeconds`
- `scanned/deferred/requested`

### `cleanup-attachments`

重点证据：

- 响应里的 `deletedCount`、`storageDeletedCount`、`dbUpdatedCount`、`hasMore`、`nextCursor`、`scanWrapped`
- 运行时 `Cleanup error:`

注意：源码允许 `cleanup_logs` 表不存在；如果表不存在，只会警告，不会阻断清理本身。所以“没看到 `cleanup_logs` 记录”不能单独证明函数没跑。

## 回滚与事故安全

### 什么情况适合直接回滚代码

- 刚部署完代码，马上出现新的 `400/401/500` 行为回归。
- 响应结构变了，调用方立刻解析失败。
- widget 摘要、动作或扫描逻辑只在这次发布后开始坏。

做法：

1. 只回滚受影响函数。
2. 仍然使用同一个仓库包装脚本重新部署已知良好的源码版本。
3. 回滚后立刻做同一条冒烟路径，不要只看“部署成功”。

### 什么情况代码回滚通常没用

- `GROQ_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`WIDGET_NOTIFY_WEBHOOK_SECRET`、`FCM_*`、`VIRUS_RESCAN_CRON_SECRET`、`CLEANUP_ATTACHMENTS_SECRET` 缺失或错误。
- `CLAMAV_API_URL` 指向的服务本身不可用。
- `ALLOW_PREVIEW_ORIGINS` / `ALLOWED_ORIGINS` 配错导致 CORS 不通。

这些都应该先按 secret 或 infra 事故处理。

### 事故时先停哪条路径

- `widget-notify` 故障：先停 webhook 或 `directNotify` 的触发方，不要反复重发同一事件。
- `virus-scan` 的 `rescan-due` 故障：先停发 `x-virus-rescan-secret` 的内部调用方。
- `cleanup-attachments` 故障：先停维护调用方。它没有 dry-run，也不是“多试几次就安全”的函数。

### 事故时不要做什么

- 不要把 service-role key 塞进前端排障。
- 不要为了看 widget 是否恢复，手改 `binding_generation`、`token_hash` 或 `push_token`。
- 不要在 `Retry-After` 还没到时连续重试 `transcribe`、`widget-notify` 或 `virus-scan rescan`。
- 不要把 `cleanup-attachments` 当作普通健康检查。

## 未纳入运行册的目录

`backup-alert` 原先只有零字节占位入口；B18 已移除该文件，仓库中没有该函数目录：

- 仓库没有 `backup-alert` 入口文件。
- `supabase/config.toml` 没有对应 `[functions.backup-alert]`。

因此本运行册不提供该 slug 的部署、验收、回滚或事故步骤。若未来需要告警功能，应先定义真实入口、调用方、鉴权和配置合同，再另行实现与审查。

## 下一步

- Supabase 主体运维：[Supabase 运维](02-supabase-operations.md)。
- 通用线上排障：[生产排障](04-production-troubleshooting.md)。
- 转写专项问题：[transcribe-troubleshooting.md](../../transcribe-troubleshooting.md)。
