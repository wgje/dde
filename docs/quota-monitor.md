# 独立本地额度监控

这是一套**独立本地只读监控**，观察 Cloudflare 与 Supabase 的免费额度变化并生成突变调查包。UI/API 由本地 Node 进程提供，绑定 `127.0.0.1`；不嵌入 NanoFlow、不经过 Cloudflare Pages。

## 浏览器 OAuth

浏览器已有平台登录会话时，授权弹窗会复用它。平台账号登录和 OAuth App 是两件事：本地监控器还需要已注册 OAuth App 的 Client ID、匹配的本地回调和权限 scope。

### 首次设置

在 UI 展开“一次性设置：OAuth App 客户端信息”。Client ID、Cloudflare Account ID 和 Cloudflare Scope ID 会存入被 `.gitignore` 忽略的 `.quota-monitor/oauth-clients.json`；不会保存 Client Secret。

- **Cloudflare OAuth Client**：在账户的 **Manage Account → OAuth clients → Create client** 注册。选择 Authorization Code、响应类型 `code`，按浏览器/桌面客户端启用 PKCE（S256）并将 Token authentication 设为 `none`；此公共 PKCE 客户端无需 Client Secret。将 UI 显示的 Cloudflare 回调地址逐字添加到 Redirect URLs。只选择 GraphQL Analytics 所需的账户分析只读权限；Scope 输入框必须填与客户端已选 scopes 完全一致的精确 ID（空格分隔），以 [OAuth Scopes API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/) 的 `id` 为准。需要后台刷新时，只有在官方列表与客户端配置都支持的情况下才加 `offline_access`。不要把页面的预填 scope 当作有效性证明。Client ID、Scope ID 与非敏感 Account ID 可通过 UI 保存。
- **Supabase OAuth App**：在组织设置的 **OAuth Apps → Add application** 创建或选择应用。将 UI 显示的 Supabase 回调地址逐字添加为 Redirect URL（本机使用页面显示的 `http://localhost:<端口>/oauth/supabase/callback`；Supabase 官方 OAuth 集成示例也使用 `http://localhost` 作为本机回调，勿替换为 `127.0.0.1`），并只选择 `Projects: Read` 与 `Secrets: Read`。前者用于列出项目，后者用于读取 Metrics API 所需的项目 Secret API Key。保存后将 Client ID 与 Client Secret 填回 UI。Supabase OAuth App 创建流程见[官方指南](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration)。
- **Supabase 权限警告**：`Secrets: Read` 不只是读取 Metrics Key；它也允许读取项目其他 API Keys 和 Secrets。如果不接受这项较宽权限，请不要使用 Supabase OAuth，改用折叠区里的手动备用方式，提供单独创建的 Metrics Secret Key。

Client Secret 只保存在本次监控进程内存，监控器重启后需要再次输入；如希望跨重启保留，可放入未提交的 `.env.local`。OAuth access/refresh token 与 Metrics Secret Key 只保存在进程内存，不写入 JSONL 或 AI 导出包。

可选环境变量：

```dotenv
# Cloudflare 私有客户端才需要 Client Secret；PKCE public client 可留空
CLOUDFLARE_OAUTH_CLIENT_SECRET=
# 可选：覆盖 UI 中保存的 scope IDs
CLOUDFLARE_OAUTH_SCOPE=

# Supabase OAuth Client Secret（放入此处可跨监控器重启使用）
SUPABASE_OAUTH_CLIENT_SECRET=
# 可选手动备用：不授予 OAuth Secrets:Read 时使用单独的 Metrics Secret Key
SUPABASE_PROJECT_REF=
SUPABASE_METRICS_SECRET=sb_secret_...

# 可选：采集频率，默认 300000（5 分钟）
QUOTA_MONITOR_INTERVAL_MS=300000
```

启动并打开独立网页：

```bash
npm run quota-monitor
# 浏览器打开 http://127.0.0.1:4180/
```

OAuth 窗口通过 PKCE `state` 和 `code_verifier` 绑定本次授权。OAuth 回调与 code/token exchange 都由本地进程完成。Supabase 已授权后可选择项目；OAuth grant 只在用户同意后生效。监控器退出或点击“清除本机授权”会清除内存中的 token/key；如需完全撤销授权，还应到 Cloudflare / Supabase 控制台撤销 OAuth App grant。仅本机同源请求可访问本地 API。

## 手动凭证备用方式

不想注册 OAuth App，或不接受 Supabase `Secrets: Read` 时，展开“备用：手动配置 API 凭证”。建议仅输入 Cloudflare Analytics Read Token 和专用 Supabase Metrics Secret Key。凭证只提交到本机回环 API，保存在进程内存，不回显、不写入快照或导出文件。

如只想查看页面、不自动访问平台 API：

```bash
QUOTA_MONITOR_AUTOCOLLECT=0 npm run quota-monitor
```

采集历史和突变事件分别写入 `.quota-monitor/snapshots.jsonl`、`.quota-monitor/events.jsonl`；整个 `.quota-monitor/` 目录已忽略，不会提交到仓库。

## 当前实现的事实边界

- Cloudflare 当前只采集 Workers / Pages Functions 的 GraphQL Analytics：请求数、错误数、子请求数及 Worker 观测点数量，时间窗为当前 UTC 日。它不是完整 Cloudflare 账单，也尚未覆盖 D1、R2、KV、带宽等其他产品。若 GraphQL 返回 0 个观测点，界面会显示“未观测”，不再误记成 0 用量。
- Supabase 使用 Metrics API 的 Prometheus 指标。数据库大小若由指标端点暴露则显示观测值；MAU、Egress、Storage、Edge Functions、Realtime 等未从 Metrics API 直接暴露时保持“未观测”，不会被写成 0。
- 免费额度基线集中在采集器的 `QUOTA_CATALOG` 中；它是帮助排查的版本化参考，不替代平台账单页。
- 任何突变都只是候选事件：阈值为“相对上次至少增加 50%”或“增量达到免费基线的 5%”。导出日志会同时写出前值、后值、增量、代码映射、推断过程和下一步复核建议。

## 当前仓库的真实映射

- Cloudflare 侧当前仓库只有 `cloudflare/workers-static-assets/shell-worker.js`，负责静态资源响应头和缓存策略；静态资源请求本身不等于 Workers Functions 请求。
- Supabase 侧的业务请求主要经过 `src/services/supabase-client.service.ts`；同步、附件和认证路径的变化可能影响数据库大小、出口、MAU 或函数调用。
- `supabase/functions/` 下的函数仍需要在 Supabase Dashboard/Usage 页面核对真实调用量。

## 导出与 AI 分析

独立界面上的“导出 AI 分析日志”会下载 Markdown 调查包，包含：

1. 最新快照和采集时间窗；
2. 每个指标的官方基线、平台观测值、状态和项目代码映射；
3. 突变事件的前值/后值/绝对变化/相对变化；
4. 触发阈值、候选原因、限制条件和复核步骤；
5. 末尾的机器可读 JSON。

导出包不会包含 OAuth access/refresh token、API Token、Supabase key 或应用任务内容。

## GitHub 借鉴项目

没有找到一个同时覆盖 Cloudflare + Supabase 免费额度、突变检测、中文概念解释和 AI 分析导出的成熟高星项目。可以借鉴但不应直接照搬：

- [`supabase/supabase-grafana`](https://github.com/supabase/supabase-grafana)：Supabase 官方 Metrics API / Prometheus 采集和 dashboard 示例；它主要是数据库健康指标，不是完整账单。
- [`cloudflare/cloudflare-prometheus-exporter`](https://github.com/cloudflare/cloudflare-prometheus-exporter)：Cloudflare 官方 exporter 的 GraphQL 采集、缓存和指标命名思路。
- [`lablabs/cloudflare-exporter`](https://github.com/lablabs/cloudflare-exporter)：免费额度过滤、月度累计和预测指标设计。
- [`0xkaz/cloudflare-cost-hub`](https://github.com/0xkaz/cloudflare-cost-hub)：异常 spike、每日快照、实例归因和 CSV 导出的产品思路，但成熟度和成本口径需要自行核对。

本地监控器故意没有把 Grafana、Prometheus、OpenObserve 或 SigNoz 作为运行时依赖，避免为了监控而新增云端消耗。后续如需长期历史，可再把 JSONL 以 Prometheus/CSV 形式导出到外部系统。
