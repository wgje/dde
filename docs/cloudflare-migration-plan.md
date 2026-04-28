# NanoFlow 迁移 Cloudflare Pages 策划案

> 版本：2026-04-28  
> 适用项目：NanoFlow / Angular 19 重客户端 PWA  
> 目标：剥离 Vercel 托管与构建链路，将前端静态产物迁移到 Cloudflare Pages，并把构建、测试、Sentry Source Map 上传放到 GitHub Actions。  
> 约束：这是个人项目。迁移方案以可落地、低维护、可回滚为准，不引入面向团队/企业审计的重流程。

## 1. 执行结论

NanoFlow 适合迁移到 Cloudflare Pages，但审查报告中的部分建议需要修正后再落地。

最终建议：

- **Cloudflare Pages** 只负责静态资源托管、边缘分发、预览环境、正式域名和生产部署回滚。
- **GitHub Actions** 负责 `npm ci`、测试、Angular production build、no-JIT 产物扫描、可选的 Sentry Source Map 上传、Wrangler Direct Upload。
- **Supabase 保持不迁移**，继续承载 Auth、PostgreSQL、Storage、Edge Functions。
- **Sentry 保持不迁移**，但首版迁移默认不上传 Source Map；迁移稳定后再启用 sourcemap 流程。
- **Vercel 保留 24-72 小时作为 DNS 回滚后备**，稳定后关闭自动部署或断开 Git integration。

迁移动因不是“Vercel 不能托管 Angular”，而是当前项目的计算和风险边界不适合继续绑在 Vercel Git 构建上：

- NanoFlow 是 Angular SPA + PWA + Supabase BaaS，不使用 Vercel 的 SSR、ISR、Route Handlers 或 Serverless 主路径。
- 构建成本主要来自 Angular AOT、PWA 产物、no-JIT 扫描、Sentry sourcemap、GoJS 相关 chunk 和测试门禁。
- 这些工作更适合 GitHub Actions 这类 CI 执行；托管平台只接收静态产物并做 CDN 分发。

本计划把迁移视为既定方向。Vercel 构建分钟数耗尽不是“是否迁移”的判断条件，而是迁移前必须修复的发布链路弊病：在正式切换前，先把 Vercel 的无效构建、构建额度和应急发布能力收敛好，确保迁移窗口内仍能发布、验证和回滚。

必须修正的审查点：

- Cloudflare Pages + Wrangler Direct Upload 在当前官方 CI 文档中仍以 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 作为非交互认证方式。不要把 GitHub OIDC 写成当前可执行门禁。可以作为未来升级方向，但本次落地使用最小权限、可轮换的 Cloudflare Account API Token。
- Cloudflare Pages 的生产回滚应使用 Pages Dashboard 或 Pages Deployments Rollback API。`wrangler rollback` 是 Workers 版本回滚命令，不应写成 Pages 的主回滚路径。
- WAF、GDPR、SOC 2 审计包不是这个个人项目迁移的必要路径。可以保留“不要误开 Under Attack Mode / 全局 Challenge”的安全提醒，但不需要建立企业合规流程。
- Sentry `sourcemaps inject` 会修改部署用 JS。Angular Service Worker 的 `ngsw.json` 在 build 时记录文件内容 hash；如果 inject 后不重建 `ngsw.json`，PWA 缓存完整性会失配。这是上线阻断项。
- 如果从旧 Vercel 默认域迁到新 custom domain，IndexedDB/localStorage/Service Worker/PWA 安装状态不会跨 origin 自动迁移。迁移前必须确认云端同步队列清空，或先导出本地数据。

## 2. 当前仓库事实

| 项 | 当前状态 | 迁移含义 |
| --- | --- | --- |
| Angular builder | `@angular/build:application` | 浏览器产物位于 `dist/browser` |
| 生产输出 | `angular.json` 的 `outputPath` 为 `dist` | Wrangler 部署目录必须是 `dist/browser`，不是 `dist` |
| 静态资源目录 | `public/**` 会复制到输出根目录 | `_headers` 应放在 `public/`；`_redirects` 仅在需要显式 fallback 时放在 `public/` |
| PWA | `serviceWorker: ngsw-config.json` | 必须控制 `ngsw.json`、SW 脚本和 HTML 缓存 |
| SW 入口 | `main.ts` 注册 `sw-composed.js`，其内部加载 `ngsw-worker.js` | `sw-composed.js`、`ngsw-worker.js` 都不能长期缓存 |
| Chunk 自愈 | `GlobalErrorHandler` 已处理 `ChunkLoadError`、动态 import 失败、JIT/DI version skew | 文档写“保持并验证现有机制”，不重复造一套 |
| 版本提示 | `workspace-shell.component.ts` 已监听 `SwUpdate.VERSION_READY` 并提示刷新 | 迁移验收要覆盖新版本提示和强制清缓存刷新 |
| Source Map | 生产配置当前没有开启 source map | 首版迁移默认关闭上传；启用时必须在 Sentry inject 后重建 `ngsw.json` 并删除 `.map` |
| CORS | 多个 Supabase Edge Function 有 CORS/origin 判断 | 迁移时要全量审查 `supabase/functions/**`，不只改 `transcribe`。`widget-black-box-action` 是独立实现，不等同于 `_shared/widget-common.ts` |
| Vercel 忽略构建 | `vercel.json` 已配置 `ignoreCommand` 指向 `scripts/vercel-ignore-step.sh` | 文档/非关键文件变更已能跳过 Vercel 构建；若分钟仍耗尽，说明主要消耗来自真实代码构建 |
| 环境变量注入 | `scripts/set-env.cjs` 在 `npm run config` 阶段写入 `src/environments/*` 和 `index.html` | Direct Upload 时 Cloudflare Dashboard 变量不会自动进入已构建 JS，必须在 GitHub Actions 构建阶段注入 `NG_APP_*` |
| Node 版本 | 现有 GitHub workflows 使用 Node 22，`netlify.toml` 仍是 Node 20，`package.json` engines 为 `>=18.19.0` | 首版迁移 workflow 固定 Node 22；是否收紧 `package.json` engines 作为独立基线决策 |
| Android TWA origin | `android/app/build.gradle.kts` 默认 `webOrigin` 仍指向 `https://dde-eight.vercel.app` | 阶段 1 必须纳入旧域名 inventory，按是否沿用 custom domain 决定更新 `NANOFLOW_WEB_ORIGIN` |

## 3. 目标架构

```text
Browser / PWA / TWA
  ├─ Angular Signals + OnPush UI
  ├─ IndexedDB local-first cache
  ├─ RetryQueue / ActionQueue / LWW sync
  ├─ GoJS lazy flow rendering
  └─ Sentry lazy monitoring

Supabase
  ├─ Auth
  ├─ PostgreSQL + RLS
  ├─ Storage
  └─ Edge Functions

GitHub Actions
  ├─ npm ci
  ├─ tests / contracts
  ├─ Angular production build
  ├─ no-JIT / PWA artifact guards
  ├─ optional Sentry source maps
  └─ wrangler pages deploy dist/browser

Cloudflare Pages
  ├─ Static assets CDN
  ├─ SPA fallback / custom domain / TLS
  ├─ Preview branch deployments
  └─ Production deployment rollback
```

这次迁移不改变 NanoFlow 的 Local-First 主路径。读路径仍是 IndexedDB 优先，后台增量拉取；写路径仍是本地落盘、UI 即时更新、3s 防抖推送、失败进入 RetryQueue/ActionQueue，冲突继续使用 LWW。

### 3.1 Vercel 弊病修复与 Cloudflare 目标态

| 维度 | Vercel 现状/过渡修复 | Cloudflare Pages 目标态 |
| --- | --- | --- |
| 架构匹配 | 更适合 Next.js SSR/ISR、Route Handlers、Serverless Functions | 更适合静态 SPA/PWA、全球 CDN、Direct Upload |
| 构建分钟数 | Git 集成构建会持续消耗 Vercel build minutes；可用 `vercel build` + `deploy --prebuilt` 绕开 | GitHub Actions 承担构建，Pages 只接收静态产物 |
| 预览体验 | Vercel Preview DX 很成熟，PR 体验简单 | Wrangler preview branch 也可用，但要自己组织 Actions 输出和注释 |
| 环境变量 | Vercel 构建时注入较顺手 | Direct Upload 下 Cloudflare 变量不参与 GitHub Actions 构建；要用 GitHub Secrets |
| SSR/Node 兼容 | 完整 Node/Serverless 生态更自然 | Pages Functions/Workers 是边缘运行时，不等于完整 Node；本项目不使用它作为主路径 |
| 流量与静态分发 | 能用，但不是本项目的差异化收益 | 静态资源分发、缓存、DDoS 防护和全球边缘网络是强项 |
| 迁移窗口价值 | 保留为回滚后备，并修复构建额度耗尽导致的发布阻塞 | 承接正式生产流量，成为长期托管目标 |

对 NanoFlow 的判断：

- Vercel 的止血修复是迁移前置任务，不是替代路线。
- 如果迁移窗口内需要恢复发布，可以临时让 Vercel 使用 GitHub Actions + `vercel deploy --prebuilt`，但这只保留到 Cloudflare production 稳定。
- 长期目标仍是 Cloudflare Pages Direct Upload + GitHub Actions，降低构建和托管平台耦合。
- 不建议把 Cloudflare Workers/Pages Functions 当成 Supabase Edge Functions 的替代品。迁移范围限定为前端静态托管和发布链路。

## 4. Cloudflare Pages 方案

### 4.1 Direct Upload + GitHub Actions

采用 Cloudflare Pages Direct Upload，由 GitHub Actions 构建完成后调用 Wrangler 上传 `dist/browser`。

理由：

- 避免 Cloudflare Pages 内置构建的 20 分钟 Free plan 超时和每月构建次数限制。
- 保留 GitHub Actions 的白盒流水线，方便插入测试、Source Map、no-JIT 扫描和部署后 smoke。
- NanoFlow 是静态 SPA，不需要 Vercel SSR/ISR/Serverless，也不需要 Cloudflare Pages Functions 承载主业务。

约束：

- Direct Upload 项目创建后不能直接切换成 Git integration；未来如果要改 Cloudflare 自动拉 Git，需要新建 Pages 项目。
- Direct Upload 项目没有常规 production branch controls。创建后应确认 production branch 是 `main`；必要时用 Cloudflare Pages API 更新一次。
- Wrangler Direct Upload 单次项目限制按 Pages 官方限制执行：Free plan 站点最多 20,000 文件，单文件 25 MiB。NanoFlow 当前静态产物满足此限制；Source Map 不应公开部署。

### 4.1.1 为什么不优先选 Connect to Git

Cloudflare Pages 的 Git integration 也能部署 Angular，但本项目不优先使用它：

- 它会把“构建”和“托管”重新耦合到 Cloudflare，和本次迁移目标相反。
- Pages Free plan 内置构建有构建时长和次数限制，重型 Angular AOT + 测试门禁仍可能撞上平台边界。
- Direct Upload 项目创建后不能切 Git integration；Git integration 项目也不能切 Direct Upload。选型应一次选对。
- 本项目需要在同一条流水线里插入 `npm run test:run:ci`、`npm run build:stats`、`npm run perf:guard:nojit`、可选 Sentry sourcemap 和部署后 smoke，这些更适合 GitHub Actions。

如果只是想快速验证 Cloudflare Pages 能否分发静态产物，可以先用 dashboard drag-and-drop 创建 Direct Upload 项目的首个空部署，再让 GitHub Actions 接管后续部署。

### 4.2 输出目录

必须部署：

```text
dist/browser
```

不要部署 `dist` 根目录。Cloudflare Angular 官方指南也提示部分 Angular 版本实际 build directory 是 `dist/<app>/browser`；本仓库 `angular.json` 对应的是 `dist/browser`。

### 4.3 SPA 路由回退

Cloudflare Pages 对没有顶层 `404.html` 的项目有默认 SPA fallback 行为，会把未命中文件的路径交给根入口处理。因此本迁移的首选策略是：

- 不新增顶层 `404.html`。
- 先依赖 Cloudflare Pages 默认 SPA fallback。
- Preview 中验证 `/projects`、`/projects/<id>` 这类 path route 刷新是否返回应用入口。

只有当默认 fallback 在实际 Pages preview 中不满足需求时，再显式添加 `public/_redirects`：

`public/_redirects`：

```text
/* /index.html 200
```

添加后必须验证 JS/CSS/SW 静态文件没有被错误代理成 HTML。验收时至少检查：

```bash
curl -I https://<preview-or-domain>/projects
curl -I https://<preview-or-domain>/main-<hash>.js
curl -I https://<preview-or-domain>/ngsw-worker.js
```

要求：

- `/projects` 返回 `200` 且由 Angular 接管。
- JS 文件返回 `Content-Type: application/javascript`，不能返回 `text/html`。
- 不要新增顶层 `404.html`，否则会改变 Pages 的默认 SPA 行为。

### 4.4 缓存头

`public/_headers` 应避免“一刀切 `/*.js` 长缓存”，因为 `ngsw-worker.js` 和 `sw-composed.js` 也在输出根目录，错误长缓存会放大 PWA version skew。

推荐配置：

```text
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin

/index.html
  Cache-Control: no-cache, no-store, must-revalidate

/index.csr.html
  Cache-Control: no-cache, no-store, must-revalidate

/launch.html
  Cache-Control: no-cache, no-store, must-revalidate

/ngsw.json
  Cache-Control: no-cache, no-store, must-revalidate

/manifest.webmanifest
  Cache-Control: no-cache, no-store, must-revalidate

/ngsw-worker.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: no-cache, no-store, must-revalidate

/sw-composed.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: no-cache, no-store, must-revalidate

/safety-worker.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: no-cache, no-store, must-revalidate

/widgets/templates/*
  Cache-Control: no-cache, no-store, must-revalidate

/.well-known/assetlinks.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=0, must-revalidate

/main*.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/polyfills*.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/chunk*.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/worker*.js
  Content-Type: application/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/*.css
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/icons/*
  Cache-Control: public, max-age=31536000, immutable

/fonts/*
  Cache-Control: public, max-age=31536000, immutable
```

注意：

- Cloudflare `_headers` 的多个匹配规则会继承并合并同名 header。不要同时给 `/*.js` 和 `/ngsw-worker.js` 设置不同 `Cache-Control`，否则可能合并成不可预测的缓存语义。
- `ngsw.json`、`index.html`、`launch.html`、`sw-composed.js` 是 PWA 更新链路的关键文件，宁可少缓存，也不能被长期缓存。
- Hashed application chunks 才允许 `immutable`。

### 4.5 Vercel 构建分钟弊病修复

Vercel 构建分钟数达到上限后，处理目标不是延续旧平台，而是先解除迁移前的发布阻塞，并把 Vercel 保留为短期回滚后备。按风险从低到高执行：

**动作 A：确认并收紧现有 Ignored Build Step。**

本仓库已经在 `vercel.json` 配置：

```json
"ignoreCommand": "bash scripts/vercel-ignore-step.sh"
```

`scripts/vercel-ignore-step.sh` 只在 `src/`、`main.ts`、`index.html`、`angular.json`、`package*.json`、`vercel.json`、`ngsw-config.json`、`public/` 等构建相关路径变化时触发构建。文档、README、归档材料变更会跳过构建。

适用场景：

- 本月还有少量 Vercel build minutes。
- 最近大量提交只是文档、计划、说明变更。

局限：

- 真实代码改动仍会触发 Vercel 构建。
- 如果多数提交都改 `src/`、`public/` 或构建配置，节省有限。

**动作 B：迁移窗口内保留 Vercel 托管，但把构建挪到 GitHub Actions。**

这是迁移期间的应急发布通道，不是目标架构。GitHub Actions 执行 Vercel build，再上传预构建产物：

```bash
npx vercel pull --yes --environment=production --token "$VERCEL_TOKEN"
npx vercel build --prod --token "$VERCEL_TOKEN"
npx vercel deploy --prebuilt --prod --token "$VERCEL_TOKEN"
```

需要 GitHub Secrets：

```text
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID
```

适用场景：

- 需要今天恢复生产发布。
- DNS、Supabase redirect、TWA origin 还没准备好，不想立刻切 Cloudflare。
- Cloudflare preview 正在验证，但 production DNS 还没到割接窗口。

局限：

- 仍然保留 Vercel 托管和项目配置复杂度。
- 仍需要维护 Vercel token、`.vercel/project.json` 或通过 `vercel pull` 获取项目设置。
- 只能作为过渡方案；Cloudflare production 稳定后应删除该临时 workflow 或手动禁用。

**动作 C：临时升级 Vercel 计划或购买构建额度。**

适用场景：

- 时间成本高于迁移成本。
- 当前迁移窗口不能被构建额度阻塞，且不想临时改 CI。

局限：

- 如果构建链路本身没有优化，升级只是把问题变成持续账单。
- 即使临时升级，也不改变迁移目标；Cloudflare production 稳定后应停止依赖 Vercel 构建额度。

本项目推荐顺序：

```text
迁移前修复：A 已启用，先确认是否仍有效。
迁移窗口应急发布：必要时临时做 B。
最后手段：短期使用 C，但不改变迁移计划。
最终目标：Cloudflare Pages Direct Upload + GitHub Actions。
```

门禁规则：A/B/C 任一动作完成后，都必须继续进入阶段 0。Vercel 修复只解决“迁移期间不要被旧平台卡住”，不作为取消或延后 Cloudflare 迁移的依据。

### 4.6 Cloudflare Dashboard 具体路径

本项目推荐创建 **Direct Upload** Pages 项目，不推荐从 `Connect to Git` 起步。

**创建 Direct Upload 项目：**

```text
Cloudflare Dashboard
-> Workers & Pages
-> Create application
-> Pages
-> Get started
-> Drag and drop your files
```

操作：

- 填项目名，例如 `nanoflow`。
- 首次可上传一个最小 `index.html` 或本地构建后的 `dist/browser`，完成项目创建。
- 之后由 GitHub Actions 使用 `wrangler pages deploy dist/browser --project-name=<name>` 接管部署。

也可以完全用 Wrangler 创建项目：

```bash
npx wrangler pages project create
npx wrangler pages deploy dist/browser --project-name=nanoflow --branch=main
```

建议使用 `npx wrangler`，不要依赖全局安装的 Wrangler 版本。

**如果已经误选 Connect to Git：**

```text
Workers & Pages
-> 选择 Pages 项目
-> Settings
-> Builds
-> Branch control
```

操作：

- 关闭 automatic production branch deployments。
- Preview branch 可设为 None，避免 Cloudflare 自己构建 PR。
- 后续仍可用 Wrangler 对这个 Pages 项目做直接部署，但不能使用 dashboard drag-and-drop；如果想要纯 Direct Upload 项目，重新建项目更干净。

**查看 Account ID：**

```text
Cloudflare Dashboard
-> Workers & Pages
-> Overview 或项目详情页右侧栏
-> Account ID
```

**创建 API Token：**

```text
右上角头像
-> My Profile
-> API Tokens
-> Create Token
```

操作：

- 如果有 Cloudflare Pages 模板，优先使用模板。
- 如果使用 Custom token，权限限定为目标 Account 的 `Cloudflare Pages: Edit`。
- DNS 自动化需要单独 token，不和 Pages deploy token 混用。
- 生成后写入 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Repository secrets`。

**Cloudflare Pages 变量与机密路径：**

```text
Workers & Pages
-> 选择 Pages 项目
-> Settings
-> Variables and Secrets
-> Add
```

重要边界：

- Direct Upload + GitHub Actions 模式下，Angular bundle 已经在 GitHub Actions 中构建完成；Cloudflare Dashboard 的变量不会自动进入 `dist/browser/*.js`。
- NanoFlow 的 `NG_APP_SUPABASE_URL`、`NG_APP_SUPABASE_ANON_KEY`、`NG_APP_SENTRY_DSN`、`NG_APP_GOJS_LICENSE_KEY` 必须放在 GitHub Actions Secrets，在 `npm run config` / `npm run build:stats` 之前注入。
- Cloudflare 的 Variables and Secrets 主要用于 Pages Functions 运行时，或 Cloudflare Git integration 的构建时变量。本项目首版不使用 Pages Functions，也不使用 Cloudflare Git 构建。

**GitHub Secrets 路径：**

```text
GitHub repository
-> Settings
-> Secrets and variables
-> Actions
-> Repository secrets
```

至少写入：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_PAGES_PROJECT_NAME
NG_APP_SUPABASE_URL
NG_APP_SUPABASE_ANON_KEY
NG_APP_SENTRY_DSN
NG_APP_GOJS_LICENSE_KEY
```

## 5. CI/CD 设计

### 5.1 认证模型

当前可落地方案使用 Cloudflare Account API Token。

必做：

- 使用 Account API Token，不使用 Global API Key。
- 权限限定为目标 Account 下的 `Cloudflare Pages: Edit`。
- GitHub 中只放入 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` secret，不把 token 写入仓库。
- DNS 修改如需自动化，使用单独 token，不和 Pages deploy token 混用。
- 个人项目也建议设置 token 过期时间或定期轮换，例如 90 天。

不写入当前执行项：

- GitHub OIDC 到 Cloudflare Pages Direct Upload。官方 Wrangler CI/CD 文档当前仍要求 API Token；待 Cloudflare 明确支持 Wrangler/Pages 的 OIDC 或 Workload Identity 后再升级。

### 5.2 GitHub Secrets

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署 Pages，最小权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `CLOUDFLARE_PAGES_PROJECT_NAME` | Pages 项目名，例如 `nanoflow` |
| `NG_APP_SUPABASE_URL` | Angular build-time Supabase URL |
| `NG_APP_SUPABASE_ANON_KEY` | Angular build-time Supabase anon key |
| `PREVIEW_NG_APP_SUPABASE_URL` | 可选：PR preview 专用 Supabase URL |
| `PREVIEW_NG_APP_SUPABASE_ANON_KEY` | 可选：PR preview 专用 anon key |
| `NG_APP_SENTRY_DSN` | 前端 Sentry DSN |
| `NG_APP_GOJS_LICENSE_KEY` | GoJS license key，没有则保留水印 |
| `SENTRY_AUTH_TOKEN` | 可选：上传 Source Map |
| `SENTRY_ORG` | 可选：Sentry org slug |
| `SENTRY_PROJECT` | 可选：Sentry project slug |

Supabase anon key 不是 service role key，但仍通过 CI secret 注入，避免模板文件被真实值污染。

PR preview 不建议直接写入生产 Supabase。优先使用 preview Supabase 项目或测试账号；如果暂时只能使用生产 Supabase，PR smoke 必须只读，或写入可自动清理的隔离测试数据。

### 5.3 Workflow 草案

新增 `.github/workflows/deploy-cloudflare-pages.yml`。核心原则：**测试 job 不依赖生产 secret；构建/部署 job 只在 secret 可用且事件安全时运行**。这样 fork PR 在 `validate-env:prod` 阶段不会因为拿不到 repository secrets 而失败。

```yaml
name: Deploy Cloudflare Pages

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  workflow_dispatch:
    inputs:
      deploy:
        description: "Deploy after build/test. Only works on main."
        type: boolean
        default: false

permissions:
  contents: read
  deployments: write
  pull-requests: write

concurrency:
  group: cloudflare-pages-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 40

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run CI tests
        run: npm run test:run:ci

  build-deploy:
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 40
    if: >
      github.event_name == 'push' ||
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)

    env:
      NG_APP_SUPABASE_URL: ${{ github.event_name == 'pull_request' && secrets.PREVIEW_NG_APP_SUPABASE_URL || secrets.NG_APP_SUPABASE_URL }}
      NG_APP_SUPABASE_ANON_KEY: ${{ github.event_name == 'pull_request' && secrets.PREVIEW_NG_APP_SUPABASE_ANON_KEY || secrets.NG_APP_SUPABASE_ANON_KEY }}
      NG_APP_SENTRY_DSN: ${{ secrets.NG_APP_SENTRY_DSN }}
      NG_APP_GOJS_LICENSE_KEY: ${{ secrets.NG_APP_GOJS_LICENSE_KEY }}
      SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
      SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
      SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
      ENABLE_SENTRY_SOURCEMAPS: ${{ vars.ENABLE_SENTRY_SOURCEMAPS || 'false' }}
      CLOUDFLARE_PAGES_PROJECT_NAME: ${{ secrets.CLOUDFLARE_PAGES_PROJECT_NAME }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Validate production env
        run: npm run validate-env:prod

      - name: Build production with stats
        run: npm run build:stats

      - name: No-JIT artifact guard
        run: npm run perf:guard:nojit

      - name: Font artifact contract
        run: npm run quality:guard:font-contract

      - name: Supabase-ready artifact contract
        run: npm run quality:guard:supabase-ready

      - name: Verify public deploy metadata
        run: |
          test -f dist/browser/index.html
          test -f dist/browser/ngsw.json
          test -f dist/browser/ngsw-worker.js
          test -f dist/browser/sw-composed.js
          test -f dist/browser/manifest.webmanifest
          test -f dist/browser/.well-known/assetlinks.json
          test -f dist/browser/_headers
          test ! -d dist/browser/functions
          test ! -f dist/browser/_worker.js
          grep -q "app.nanoflow.twa" dist/browser/.well-known/assetlinks.json
          ! grep "vercel.app" dist/browser/manifest.webmanifest
          if [ -f public/launch.html ]; then
            test -f dist/browser/launch.html
          fi
          if [ -f public/safety-worker.js ]; then
            test -f dist/browser/safety-worker.js
          fi
          if [ -f dist/browser/_redirects ]; then
            echo "_redirects found; preview smoke must verify static assets are not proxied to HTML."
          fi
          unmatched_js=$(find dist/browser -maxdepth 1 -name '*.js' -printf '%f\n' | grep -Ev '^(main|polyfills|chunk|worker|runtime)-|^(sw-composed|ngsw-worker|safety-worker)\.js$' || true)
          if [ -n "$unmatched_js" ]; then
            echo "Root JS files without _headers cache rule:"
            echo "$unmatched_js"
            exit 1
          fi

      - name: Sentry source maps (disabled by default)
        if: ${{ env.ENABLE_SENTRY_SOURCEMAPS == 'true' && env.SENTRY_AUTH_TOKEN != '' && env.SENTRY_ORG != '' && env.SENTRY_PROJECT != '' }}
        run: |
          if find dist/browser -name '*.map' -type f | grep -q .; then
            npx @sentry/cli@2.58.2 sourcemaps inject dist/browser
            npx @sentry/cli@2.58.2 sourcemaps upload dist/browser \
              --org "$SENTRY_ORG" \
              --project "$SENTRY_PROJECT" \
              --release "$GITHUB_SHA"
            find dist/browser -name '*.map' -type f -delete

            # Sentry inject 修改了 JS 内容。必须重建 Angular Service Worker manifest，
            # 并重新计算 HTML hash，确保 ngsw.json 与最终部署产物完全一致。
            npx ngsw-config dist/browser ngsw-config.json /
            node scripts/patch-ngsw-html-hashes.cjs
          else
            echo "No source maps found; skip Sentry sourcemap upload."
          fi

      - name: Final no-source-map guard
        run: |
          if find dist/browser -name '*.map' -type f | grep -q .; then
            echo "Source maps must not be deployed to Cloudflare Pages."
            exit 1
          fi

      - name: Deploy preview to Cloudflare Pages
        if: github.event_name == 'pull_request'
        uses: nick-fields/retry@v3
        with:
          timeout_minutes: 8
          max_attempts: 3
          retry_wait_seconds: 30
          command: |
            npx wrangler@3.114.0 pages deploy dist/browser \
              --project-name="$CLOUDFLARE_PAGES_PROJECT_NAME" \
              --branch=pr-${{ github.event.pull_request.number }}
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy production to Cloudflare Pages
        if: >
          (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
          (github.event_name == 'workflow_dispatch' && inputs.deploy == true && github.ref == 'refs/heads/main')
        uses: nick-fields/retry@v3
        with:
          timeout_minutes: 8
          max_attempts: 3
          retry_wait_seconds: 30
          command: |
            npx wrangler@3.114.0 pages deploy dist/browser \
              --project-name="$CLOUDFLARE_PAGES_PROJECT_NAME" \
              --branch=main
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

手动触发说明：`workflow_dispatch` 默认只执行 test/build/guards，不部署。只有在 `main` 分支手动运行并设置 `deploy=true` 时才部署 production。

Fork PR 行为：只运行 `test` job；不执行 `validate-env:prod`、不读取部署 secret、不部署 preview。若需要外部贡献者预览，先由维护者把分支同步到同仓分支再触发 preview。

如果 Direct Upload 项目的 production branch 不是 `main`，创建项目后执行一次：

```bash
curl --request PATCH \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$CLOUDFLARE_PAGES_PROJECT_NAME" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"production_branch":"main"}'
```

### 5.4 Source Map 安全门禁

当前生产 build 不生成 Source Map。迁移首版默认不上传 Sentry Source Map，先把 Cloudflare Pages、DNS、PWA 更新和 Supabase 回调跑稳。

如果迁移首版就要启用，必须满足以下顺序：

```text
npm run build:stats 生成 dist/browser、ngsw.json、modulepreload 和 launch 产物
Sentry CLI inject 修改最终部署 JS
Sentry CLI upload 上传 JS/map Debug ID 关系
删除 dist/browser/**/*.map
重新运行 ngsw-config，生成匹配最终 JS 内容的 ngsw.json
重新运行 scripts/patch-ngsw-html-hashes.cjs，确保 HTML hash 也匹配最终产物
最终检查 dist/browser 中没有 .map
部署 Cloudflare Pages
```

原因：

- Angular Service Worker 的 `ngsw.json` 记录缓存资源内容 hash。
- `@sentry/cli sourcemaps inject` 会向 JS 注入 Debug ID，修改 JS 内容。
- 如果 inject 后不重建 `ngsw.json`，Service Worker 看到的 hash 和最终部署文件不一致，容易触发安装失败、缓存不一致或 version skew。

建议策略：

- 使用 GitHub variable `ENABLE_SENTRY_SOURCEMAPS=false` 作为默认值。
- Angular production source map 使用 hidden 模式，避免 JS 文件带公开 `sourceMappingURL`。
- Hidden source map 只是不暴露引用，不等于安全；部署前仍必须删除 `.map`。
- `@sentry/cli sourcemaps inject` 必须在 upload 前、deploy 前执行。
- 上传到 Sentry 后，部署 Cloudflare 前必须删除 `dist/browser/**/*.map`。
- 删除 `.map` 且 inject 完成后，必须执行 `npx ngsw-config dist/browser ngsw-config.json /`。
- `ngsw-config` 后必须再执行 `node scripts/patch-ngsw-html-hashes.cjs`，避免 `index.html` / `launch.html` hash 与最终产物失配。
- CI 必须用 `find dist/browser -name '*.map'` 做最终门禁，发现 `.map` 立即失败。

不建议：

- 为了“方便调试”把 `.map` 公开发布到 Cloudflare。
- 把 Sentry Source Map 上传和 Cloudflare 部署拆成两个不同构建产物。Sentry 看到的 JS 必须和最终部署的 JS 是同一份。

### 5.5 Sentry Release 对齐

当前 `SentryLazyLoaderService` 的 release 由运行时入口 chunk 路径推导，不等于 GitHub Actions 中的 `$GITHUB_SHA`。因此，如果 workflow 使用 `--release "$GITHUB_SHA"` 上传 sourcemap，但前端运行时没有把同一个 release 写入 `Sentry.init({ release })`，Sentry release 维度会不一致。

两种可选策略：

- 首版迁移只验收 Debug ID sourcemap 能还原堆栈，不把“看到 `$GITHUB_SHA` release”作为门禁。
- 后续如果要以 Git SHA 作为 release，先改 `scripts/set-env.cjs`、`scripts/ensure-env-files.cjs` 和 `SentryLazyLoaderService`，让 `NG_APP_SENTRY_RELEASE=${{ github.sha }}` 进入 `environment` 并被 `Sentry.init` 使用。

## 6. Supabase 配套改动

### 6.1 Auth Redirect URLs

Supabase Auth 的生产 Site URL 设为最终正式域名。这里先做域名选择：

- 如果选择最小 DNS 改动，生产域名建议用子域名，例如 `https://app.nanoflow.app` 或 `https://www.nanoflow.app`。
- 如果坚持使用 apex/root domain `https://nanoflow.app`，DNS 割接必须走 Cloudflare full DNS setup，不能只在外部 DNS 加普通 CNAME。

生产 Site URL 示例：

```text
https://app.nanoflow.app
# 或者 full DNS setup 后使用：
https://nanoflow.app
```

Additional Redirect URLs 建议：

```text
http://localhost:4200/**
http://localhost:5173/**
https://nanoflow.pages.dev/**
https://*.nanoflow.pages.dev/**
https://app.nanoflow.app/**
https://nanoflow.app/**
```

若保留旧 Vercel 回滚窗口，临时加入：

```text
https://dde-eight.vercel.app/**
https://dde-*.vercel.app/**
```

稳定 72 小时后移除旧 Vercel redirect，避免多个生产 origin 长期并存导致 PWA、OAuth、Sentry release 和 TWA 排障复杂化。

注意：

- Supabase 官方建议 production 使用精确 URL，preview/local 才使用 `**` globstar。个人项目可以接受 preview 通配，但生产域名仍应尽量写精确路径。
- 如果当前登录回调有固定路径，例如 `/auth/callback`，生产 allow-list 应补充精确路径。

### 6.2 Edge Functions CORS

Cloudflare Pages 不作为 Supabase API 代理，浏览器仍直连 Supabase REST/Auth/Storage/Edge Functions。迁移要改的是手写 CORS allow-list，而且不同函数的实现不一致，不能只改 `transcribe`。

当前仓库至少分为四类：

| Edge Function | CORS 实现 | 迁移路径 |
| --- | --- | --- |
| `supabase/functions/transcribe/index.ts` | 硬编码 `ALLOWED_ORIGINS` + Vercel preview 前缀判断 | 必须改源码，更新 `src/tests/contracts/transcribe-cors.contract.spec.ts`，重新部署 |
| `supabase/functions/virus-scan/index.ts` | `Deno.env.get('ALLOWED_ORIGINS')` exact match + Vercel preview hostname 判断 | 固定 production/pages.dev 可用 secret 覆盖；若要支持 `pr-*.pages.dev`，必须改源码或新增 contract test |
| `supabase/functions/_shared/widget-common.ts` | `Deno.env.get('ALLOWED_ORIGINS')` exact match + Vercel preview hostname 判断 | 固定 production/pages.dev 可用 secret 覆盖；若要支持 widget PR preview，必须改源码 |
| `supabase/functions/widget-black-box-action/index.ts` | 独立内联 CORS，不复用 `_shared/widget-common.ts` | 必须单独审查；不能写成“由 `_shared/widget-common.ts` 统一覆盖” |

复用 `_shared/widget-common.ts` 的 widget 函数包括 `widget-register`、`widget-summary`、`widget-notify`、`widget-focus-action`。`widget-black-box-action` 当前是独立实现，迁移时必须单列。

执行方式：

```bash
rg -n "Access-Control-Allow-Origin|allowedOrigins|ALLOWED_ORIGINS|origin|cors|getCorsHeaders|CORS" supabase/functions src/tests/contracts
```

迁移任务包括：

- 所有相关 allow-list 加入最终生产 origin，例如 `https://app.nanoflow.app` 或 `https://nanoflow.app`。
- 加入固定 Pages production/preview origin，例如 `https://nanoflow.pages.dev`。
- 保留 `https://dde-eight.vercel.app` 作为 24-72 小时回滚窗口。
- 如果要允许 PR preview 调用 Edge Functions，必须用 hostname 解析或正则支持 `pr-<number>.<project>.pages.dev`；仅写 `https://pr-*.nanoflow.pages.dev` 到 `ALLOWED_ORIGINS` 不会匹配。
- 同步更新所有相关 contract tests，不只更新 `src/tests/contracts/transcribe-cors.contract.spec.ts`。

阶段 0 必须做一个明确决策：

1. **支持 PR preview 调用 Edge Functions**：改 `transcribe`、`virus-scan`、`_shared/widget-common`、`widget-black-box-action` 的 CORS 判断，统一使用 `URL.hostname` + 正则；补 contract tests。
2. **不支持 PR preview 调用 Edge Functions**：preview smoke 只覆盖静态启动、路由、PWA、只读页面，不跑语音转写、病毒扫描、widget action 等链路。

推荐的判断函数形态：

```ts
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    return (
      origin === 'https://app.nanoflow.app' ||
      origin === 'https://nanoflow.app' ||
      origin === 'https://nanoflow.pages.dev' ||
      /^pr-\d+\.nanoflow\.pages\.dev$/.test(url.hostname) ||
      origin === 'https://dde-eight.vercel.app'
    );
  } catch {
    return false;
  }
}
```

### 6.3 同步握手不改

迁移 Cloudflare 不应修改本地优先同步流程：

1. `UserSessionService.loadProjects()` 判断用户。
2. `loadStartupSnapshotResult()` 读取 IndexedDB 启动快照。
3. `projectState.setProjects(validProjects)` 先渲染本地 UI。
4. `runIdleTask()` 在空闲期启动后台同步。
5. `SimpleSyncService` 按 `updated_at/updatedAt` 做增量拉取与 LWW 合并。
6. 云端写失败进入 RetryQueue/ActionQueue。
7. 只有 RetryQueue 和 ActionQueue 都空时才推进 lastSyncTime。

验收重点是 Cloudflare 缓存策略不能让旧 HTML、旧 `ngsw.json` 和新 chunk 混用。

## 7. Origin 迁移数据保护

NanoFlow 是 Local-First 应用，核心数据先落 IndexedDB。浏览器存储按 origin 隔离；从 `https://dde-eight.vercel.app` 切到 `https://app.nanoflow.app` 或 `https://nanoflow.app` 时，旧 origin 下的 IndexedDB、localStorage、Service Worker、PWA 安装状态不会自动搬到新 origin。

这意味着：

```text
用户打开新域名
浏览器看到一个全新的 IndexedDB 空间
首屏可能像“数据没了”
实际数据仍在旧 origin 的 IndexedDB 或 Supabase 中
```

如果所有设备都已登录，且 RetryQueue/ActionQueue 已清空，新域名首次登录后可以通过 Supabase 重新拉取缓解。以下场景不能依赖自动恢复：

- 未登录访客或本地-only 数据。
- 设备长期离线，存在未同步写入。
- 附件或大文件还没有上传完成。
- 用户只在旧 Vercel 默认域安装 PWA，从未使用 custom domain。

迁移前数据保护门禁：

- 所有活跃设备打开旧站，确认 RetryQueue / ActionQueue 为空。
- 至少完成一次“新增任务 -> 等待同步 -> 另一设备或隐身窗口登录后可见”的验证。
- 未登录或本地-only 用户必须先导出 JSON。
- 如果有附件、语音或大文件，额外导出 ZIP 或确认 Supabase Storage 已有远端副本。
- 切域名前保留旧 Vercel origin 至少 72 小时，作为找回本地数据的窗口。
- 切域名后首次打开需要重新登录，这是预期行为。
- 不承诺 IndexedDB 从旧 Vercel 默认域自动迁移到新 custom domain。

验收时需要明确区分：

- **同一 custom domain 换托管商**：origin 不变，IndexedDB 仍可见，主要风险是 DNS/PWA 缓存。
- **从 Vercel 默认域换到新 custom domain**：origin 变化，浏览器本地数据天然隔离，必须依赖云端同步或手动导出恢复。

## 8. PWA 与 version skew 防御

### 8.1 已有应用层防御

本仓库已经具备三层防御：

- `GlobalErrorHandler` 捕获 `ChunkLoadError`、`Failed to fetch dynamically imported module`、`Loading chunk failed` 后清缓存并 reload。
- 同一错误 30 秒内有 reload loop protection，避免无限刷新。
- `SwUpdate.VERSION_READY` 会提示用户刷新，并调用 `reloadViaForceClearCache()`。

迁移任务不是新增重复逻辑，而是验证这些路径在 Cloudflare 域名下仍工作。

### 8.2 必测升级演练

上线前执行一次旧版本到新版本的 PWA 演练：

1. 在旧站打开并安装/注册 PWA。
2. 保持页面后台挂起或关闭后重开。
3. 部署新版本到 Cloudflare preview/production。
4. 重新打开应用。
5. 进入 Text 视图和 Flow 视图。
6. 验证不出现 `JIT compiler unavailable`、`ChunkLoadError`、`Loading chunk failed`。
7. 验证新版本 toast 可触发强制刷新。
8. 验证 IndexedDB 首屏恢复，后台同步后队列归零。

### 8.3 Cloudflare 优化开关

不要为了性能盲目开启会改写前端产物的功能：

- 不启用 Rocket Loader。
- 不启用会改写 JS/CSS 的 Auto Minify，Angular build 已经压缩。
- 不对 `index.html`、`ngsw.json`、SW 脚本设置 Cache Rules 长缓存。

可使用的平台优化：

- Cloudflare 默认内容压缩。官方支持 Gzip、Brotli、Zstandard，按浏览器 `Accept-Encoding` 和计划配置投递；CI 不需要预压缩 JS/CSS。
- Early Hints。Pages 对 `pages.dev` 和 custom domains 自动启用，并可从 HTML 中的 `preload`、`preconnect`、`modulepreload` 生成 Link header。NanoFlow 已有 `scripts/inject-modulepreload.cjs`，先验证自动行为，不要在 `_headers` 中手写脆弱的 hash chunk preload。

## 9. DNS、域名与回滚

### 9.1 两种割接路径

**路径 A：只把子域名 CNAME 指向 Cloudflare Pages，不迁移权威 DNS。**

这是最小改动路径，但只适用于子域名，例如 `app.nanoflow.app` 或 `www.nanoflow.app`。只需要在现有 DNS 提供商处修改对应 CNAME，通常不涉及 Nameserver 切换，也不需要移除 DNSSEC DS 记录。

执行：

- 割接前 48-72 小时把目标记录 TTL 降到 300 秒。
- 在 Cloudflare Pages 绑定 custom domain，等待 TLS 状态正常。
- 修改子域名 CNAME 到 Cloudflare Pages 要求的 `<project>.pages.dev` 目标。
- 用全球 DNS 检查工具确认解析收敛。
- 保留 Vercel 旧部署 24-72 小时。

**路径 B：把域名权威 DNS 迁到 Cloudflare full setup。**

只有在决定让 Cloudflare 接管 DNS zone 时使用。若生产域名坚持使用 apex/root domain `nanoflow.app`，应走这条路径；Cloudflare Pages 的 apex domain 需要该域名作为 Cloudflare zone 并配置 nameserver。此时需要处理 DNSSEC。

执行：

- 割接前 48-72 小时降低 TTL。
- 如果旧 DNSSEC 已启用，先在注册商处移除旧 DS 记录，并等待缓存过期；Cloudflare 官方提示旧 DS 记录会导致 Nameserver 迁移后解析失败。
- 添加 Cloudflare zone，核对 DNS 记录。
- 在注册商处把 Nameserver 改为 Cloudflare 分配的 NS。
- 等待 zone active 和全球解析收敛。
- 稳定 72 小时后，在 Cloudflare 启用 DNSSEC，并把 Cloudflare 生成的新 DS 记录写回注册商。

不要在仅修改子域名 CNAME 的路径 A 中误删 DS 记录；那是 Nameserver 迁移路径 B 才需要处理的问题。

### 9.2 回滚策略

应用层回滚：

- 如果是新版本代码问题，优先使用 Cloudflare Pages Dashboard 的 Rollback to this deployment。
- 也可以使用 Pages Deployments Rollback API 自动化。
- 不使用 `wrangler rollback` 作为 Pages 回滚命令。

基础设施回滚：

- 如果是 custom domain、TLS、DNS、Cloudflare 边缘配置问题，把 DNS 记录切回 Vercel。
- 因为 TTL 已降到 300 秒，理论上几分钟内可恢复主流递归解析器。
- Vercel 旧部署至少保留 24-72 小时，且不要在稳定前删除 Vercel 环境变量。

触发回滚的条件：

- 生产首屏白屏或 JS/CSS 被错误返回为 HTML。
- 任意 Angular route 刷新 404。
- 登录/OAuth 回调无法完成。
- 新增任务、离线写入、恢复联网同步失败。
- Sentry 出现持续的 `ChunkLoadError`、`JIT compiler unavailable`、`DI-version-skew`。
- `ngsw.json`、`sw-composed.js`、`ngsw-worker.js` 被长期缓存。

## 10. Android TWA 影响

如果沿用原自定义域名：

- TWA origin 不变。
- 只需确认 `/.well-known/assetlinks.json` 在 Cloudflare Pages 下返回 `200`、`application/json`、正确 SHA256 指纹。
- 确认 `manifest.webmanifest` 的 `id` 和 `start_url` 不被迁移改动。

如果改用新的 Cloudflare 域名：

- Android TWA origin 需要更新。
- `assetlinks.json` 必须发布在新域名的 `/.well-known/assetlinks.json`。
- Android 包名和 SHA256 证书指纹保持一致。
- 安装包或 Play Store 配置需要同步新 URL。

建议优先沿用正式自定义域名，减少 TWA 和 PWA origin 变化。

## 11. 个人项目裁剪项

本迁移不需要执行以下企业级动作：

- 不建立 SOC 2、GDPR、PCI 审计包。
- 不配置多用户审批链路。
- 不做复杂的 WAF/Rate Limiting 分层。NanoFlow 静态站主路径没有 Cloudflare API 代理；Supabase 请求直连 Supabase，Cloudflare WAF 不会保护这些请求。
- 不开启 Cloudflare Under Attack Mode 或全站 Challenge。它可能干扰 PWA、OAuth callback、Service Worker 更新和 preview smoke。
- 不为了“边缘计算”引入 Pages Functions。当前没有业务收益，还会让 `_headers`、`_redirects` 行为复杂化。

保留的轻量安全项：

- 最小权限 Cloudflare API Token。
- Source Map 不公开部署。
- `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`。
- 旧 Vercel redirect/CORS 只保留回滚窗口，不长期开放。

## 12. 实施路线图

### 阶段 -1：Vercel 弊病修复与迁移窗口保底

- [ ] 确认 `vercel.json` 的 `ignoreCommand` 仍指向 `bash scripts/vercel-ignore-step.sh`。
- [ ] 检查近期触发构建的提交是否主要改了 `src/`、`public/`、`package*.json`、`angular.json`、`ngsw-config.json` 等真实构建路径。
- [ ] 如果只是文档提交仍触发 Vercel 构建，先修 `scripts/vercel-ignore-step.sh` 的 watched paths。
- [ ] 如果真实代码构建导致分钟耗尽，但 Cloudflare production 还没完成割接，临时新增一个 GitHub Actions workflow 使用 `vercel pull`、`vercel build`、`vercel deploy --prebuilt`。
- [ ] 确认 Vercel 即使全失能，也有备份的 GitHub Secrets 与 Supabase secrets 可读；Cloudflare 与 Supabase 凭据不要只存在 Vercel 中。
- [ ] 临时 Vercel 预构建方案需要 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`，只用于迁移窗口内的应急发布和回滚后备。
- [ ] 如果临时升级 Vercel，只把它当作迁移窗口的时间缓冲；不要以此延后 Cloudflare 迁移。
- [ ] Cloudflare production 稳定后，删除或禁用临时 Vercel 预构建 workflow，并关闭 Vercel 自动部署。

### 阶段 0：准备

- [ ] 创建 Cloudflare Pages 项目，选择 Direct Upload。
- [ ] 按 §4.6 路径创建 Direct Upload 项目，避免误选 Git integration。
- [ ] 确认项目名，例如 `nanoflow`，记录 `nanoflow.pages.dev`。
- [ ] 创建最小权限 `CLOUDFLARE_API_TOKEN`。
- [ ] 在 GitHub Secrets 写入 Cloudflare、Supabase、GoJS、Sentry 变量；PR preview 优先使用 `PREVIEW_NG_APP_SUPABASE_URL` / `PREVIEW_NG_APP_SUPABASE_ANON_KEY`。
- [ ] 设置 `ENABLE_SENTRY_SOURCEMAPS=false`，首版迁移默认关闭 sourcemap 上传。
- [ ] 确认 Direct Upload production branch 为 `main`；必要时用 API 设置。
- [ ] 在 Supabase Auth redirect allow-list 加入 custom domain、Pages preview、本地开发域名。
- [ ] 明确生产域名：子域名可走路径 A；apex/root domain 必须走路径 B。
- [ ] 若走 DNS 路径 A，提前降低子域名 CNAME 记录 TTL。
- [ ] 若走 DNS 路径 B，提前降低 TTL，并处理旧 DNSSEC DS 记录。
- [ ] 所有活跃设备打开旧站，确认 RetryQueue / ActionQueue 为空；本地-only 数据先导出。
- [ ] 盘点未发布 Supabase migration 是否保持向后兼容，确保前端 rollback 时旧代码仍能读取新数据。
- [ ] 决定 PR preview 数据隔离方案，默认使用独立 Supabase Preview Project，而不是生产 Supabase。
- [ ] 决定 PR preview 是否允许调用 Edge Functions；若允许，阶段 1 必须改 CORS 代码支持 `pr-*.pages.dev` hostname。
- [ ] 从 Vercel Dashboard 导出当前生产环境变量全集，对照 `scripts/set-env.cjs` 的 `NG_APP_*` 默认值。

### 阶段 1：仓库改造

- [ ] 新增 `public/_headers`。
- [ ] 先不新增顶层 `404.html`，验证 Cloudflare Pages 默认 SPA fallback。
- [ ] 如果默认 fallback 不满足深链刷新，再新增 `public/_redirects`，并在 preview 中验证不会把静态资源代理成 HTML。
- [ ] 新增 `.github/workflows/deploy-cloudflare-pages.yml`，拆分不依赖 secret 的 `test` job 与只在安全事件运行的 `build-deploy` job。
- [ ] 明确 `workflow_dispatch` 行为：默认只 test/build/guards；只有 `deploy=true` 且分支为 `main` 才生产部署。
- [ ] PR preview deploy 条件限制为同仓库 PR，不使用 `pull_request_target`；fork PR 只跑 test job，不执行 `validate-env:prod`。
- [ ] 固定 `wrangler` 和 Sentry CLI 版本，并为 Direct Upload 增加最多 3 次 retry。
- [ ] 全量审查 `supabase/functions/**` 的 CORS/origin 判断，不只更新 `transcribe`；单独处理 `widget-black-box-action`。
- [ ] 根据阶段 0 决策，改 `transcribe`、`virus-scan`、`_shared/widget-common`、`widget-black-box-action` 的 Cloudflare preview CORS 支持，或明确 preview smoke 不覆盖这些链路。
- [ ] 更新所有相关 contract tests。
- [ ] 更新 `SentryLazyLoaderService` 的 `tracePropagationTargets`，纳入新 custom domain 和 Pages preview 域。
- [ ] 全仓 inventory `dde-eight.vercel.app` / `dde[-\w]*.vercel.app`，把运行时常量、TWA 配置、测试 fixture、文档分别归类；结果写入迁移 PR 描述。
- [ ] 更新或显式覆盖 `android/app/build.gradle.kts` 的 `NANOFLOW_WEB_ORIGIN`，避免 TWA 默认 origin 继续指向旧 Vercel 域。
- [ ] 决定保留/删除旧 `vercel.json`、`netlify.toml`，并同步更新 `src/tests/startup-contract.spec.ts`。
- [ ] CI artifact guard 补齐 `ngsw-worker.js`、`sw-composed.js`、`manifest.webmanifest`、`.well-known/assetlinks.json`、TWA package name、`manifest.webmanifest` 不含 `vercel.app`、`dist/browser/functions` 不存在、`dist/browser/_worker.js` 不存在、`.map` 最终门禁。
- [ ] 如启用 Sentry Source Map，新增 hidden source map 构建配置，并确保 inject 后执行 `npx ngsw-config dist/browser ngsw-config.json /` 和 `node scripts/patch-ngsw-html-hashes.cjs`。
- [ ] 保留 `npm run perf:guard:nojit`，并加入 `npm run quality:guard:font-contract`、`npm run quality:guard:supabase-ready` 作为部署前门禁。
- [ ] 本地执行 `npx wrangler pages dev dist/browser --port 8788` dry-run，验证 SPA fallback、`_headers`、PWA install、SW update。
- [ ] Node 22 作为 Cloudflare deploy workflow 基线；是否收紧 `package.json engines` 到 `>=22 <23` 另立决策，不在首版迁移中隐式完成。

### 阶段 2：Preview 验证

- [ ] 同仓库 PR 创建后 GitHub Actions 部署 `pr-<number>.<project>.pages.dev`；fork PR 只跑 build/test，不拿部署 secret。
- [ ] 确认 PR preview 使用测试 Supabase；如果暂时使用生产 Supabase，smoke 只读或写入隔离数据。
- [ ] 对 preview 执行 Playwright smoke。
- [ ] 手动或自动检查 `_headers`：
  - `index.html` no-store。
  - `ngsw.json` no-store。
  - `sw-composed.js` no-store。
  - hashed chunks immutable。
- [ ] 移动端浏览器打开 preview，验证默认 Text 视图。
- [ ] 桌面端进入 Flow 视图，验证 GoJS lazy chunk。
- [ ] 验证 Supabase Auth redirect、Storage、Edge Functions。
- [ ] 若 sourcemap 关闭，确认 Cloudflare public URL 下没有 `.map`。
- [ ] 若 sourcemap 开启，确认 `ngsw.json` 是 inject 后重建版本，且已重新执行 `patch-ngsw-html-hashes.cjs`，并确认 Debug ID sourcemap 可还原堆栈。
- [ ] 验证 Sentry 错误事件和 Session Replay 仍能上报；如果启用 tracing，确认新域名进入 trace propagation 范围。
- [ ] 若 GoJS license 与域名绑定，先在 GoJS 授权后台加入新 custom domain。

### 阶段 3：Production 部署

- [ ] 合并到 `main`。
- [ ] GitHub Actions 部署 `main` 到 Cloudflare Pages production。
- [ ] 在 `*.pages.dev` production URL 上完成 smoke。
- [ ] 绑定 custom domain，等待 TLS active。
- [ ] 子域名走路径 A；apex/root domain 走路径 B。
- [ ] 执行生产 smoke test。
- [ ] 保留 Vercel 旧部署 24-72 小时。

### 阶段 4：稳定观察

- [ ] 观察 Sentry 24 小时，重点看 chunk load、JIT、DI version skew、Supabase 400/401/403。
- [ ] 验证离线新增任务、恢复联网同步、RetryQueue/ActionQueue 清空。
- [ ] 如果 origin 发生变化，验证新域名首次登录后能从 Supabase 恢复数据；旧域名仍可打开用于导出本地残留数据。
- [ ] 验证 PWA 旧版本到新版本升级路径。
- [ ] 验证 Android TWA assetlinks。
- [ ] 稳定后移除 Supabase/Vercel 临时回滚 allow-list。
- [ ] 关闭 Vercel 自动部署或断开 Git integration。
- [ ] 稳定满 `HSTS_STABILIZATION_WINDOW` 后再单独评估启用 HSTS；首版迁移不在 `_headers` 中启用 HSTS。
- [ ] 如需要 SEO 收敛，稳定 72 小时后给旧 Vercel 域加入 `X-Robots-Tag: noindex` 或友好跳转说明。
- [ ] 更新 README、部署文档和性能基线 URL。

## 13. 验收标准

迁移完成必须满足：

- Cloudflare production 首屏可打开。
- 刷新任意 Angular path route 不返回 404。
- JS/CSS/SW 请求不会被 SPA fallback 或 `_redirects` 代理成 HTML。
- `index.html`、`index.csr.html`、`launch.html`、`ngsw.json`、`manifest.webmanifest`、`sw-composed.js`、`ngsw-worker.js` 不是长期强缓存。
- `main*.js`、`polyfills*.js`、`chunk*.js`、`worker*.js`、CSS、assets、fonts、icons 使用长期缓存。
- CI artifact guard 确认 `ngsw-worker.js`、`sw-composed.js`、`manifest.webmanifest`、`.well-known/assetlinks.json` 存在。
- `assetlinks.json` 包含 `app.nanoflow.twa`。
- `manifest.webmanifest` 不包含 `vercel.app` 字符串，`id`、`scope`、`start_url` 不硬编码旧 origin。
- `dist/browser/functions/` 和 `dist/browser/_worker.js` 不存在，避免误启用 Pages Functions。
- `dist/browser` 中没有公开 `.map` 文件。
- 如果启用 Sentry sourcemap，必须先执行 `sourcemaps inject`，再删除 `.map`，随后重建 `ngsw.json` 并重新执行 `node scripts/patch-ngsw-html-hashes.cjs`。
- `npm run test:run:ci` 通过。
- `npm run build:stats` 通过。
- `npm run perf:guard:nojit` 通过。
- `npm run quality:guard:font-contract` 通过。
- `npm run quality:guard:supabase-ready` 通过。
- Playwright smoke 中 console error/pageerror/requestfailed/badResponse 为 0。
- Supabase 登录、项目加载、任务新增、离线写入、恢复联网同步可用。
- Fork PR 不读取生产/部署 secrets；同仓 PR preview 不污染生产 Supabase，或只执行只读/隔离写入。
- 如果 origin 变化，新域名能从 Supabase 恢复已同步数据；旧域名保留 72 小时用于导出本地残留数据。
- 若启用 Source Map，Debug ID sourcemap 可还原堆栈；除非运行时代码已注入同一个 release，否则不把 `$GITHUB_SHA` release 作为验收门禁。
- Sentry 错误事件和 Session Replay 在新域名下仍能上报；`tracePropagationTargets` 不再只覆盖 Vercel 域名。
- GoJS 在新域名下不出现 license 水印或授权相关 console error。
- 移动端默认 Text 视图；Flow 图按需加载，没有 `visibility:hidden` 持有 GoJS 实例。
- Android TWA 的 `assetlinks.json` 返回正确，`NANOFLOW_WEB_ORIGIN` / `android/app/build.gradle.kts` 不再默认指向不符合最终方案的旧 Vercel origin。

## 14. Smoke Test 建议

新增 `e2e/cloudflare-smoke.spec.ts` 或在现有 e2e 中参数化 `BASE_URL`，覆盖：

- 打开 `/`。
- 打开 `/projects` 并刷新。
- 打开 `/#/projects?entry=shortcut&intent=open-workspace`，兼容 manifest shortcut。
- 验证页面出现 NanoFlow 主 UI。
- 新增一个本地任务，刷新后仍能从 IndexedDB 恢复。
- 模拟离线写入，再恢复联网，等待队列归零。
- 捕获 console，禁止：
  - `JIT compiler unavailable`
  - `JIT-version-skew`
  - `DI-version-skew`
  - `ChunkLoadError`
  - `Loading chunk failed`
  - Supabase schema/400 error

部署后手动 header 检查：

```bash
ORIGIN=https://app.nanoflow.app
curl -I "$ORIGIN/"
curl -I "$ORIGIN/index.html"
curl -I "$ORIGIN/ngsw.json"
curl -I "$ORIGIN/sw-composed.js"
curl -I "$ORIGIN/ngsw-worker.js"
curl -I "$ORIGIN/manifest.webmanifest"
curl -I "$ORIGIN/.well-known/assetlinks.json"
curl -I "$ORIGIN/projects"
curl -fsS "$ORIGIN/.well-known/assetlinks.json" | grep -q "app.nanoflow.twa"
```

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Direct Upload 不能切 Git integration | 后续想用 Cloudflare 自动构建需新建项目 | 当前目标就是 GitHub Actions 构建，接受约束 |
| Cloudflare API Token 泄漏 | 部署通道被滥用 | Account token、Pages Edit 最小权限、GitHub Secrets、定期轮换 |
| OIDC 被误写成当前方案 | CI 无法部署 | 明确标注为未来升级项，当前使用官方支持的 API Token |
| Vercel 止血被误解为迁移替代 | 修复构建分钟后继续留在旧架构，后续再次被构建/额度/平台耦合卡住 | 明确 A/B/C 都只是迁移前置和迁移窗口保底，完成后仍进入 Cloudflare 阶段 0 |
| Sentry inject 后未重建 `ngsw.json` 和 HTML hash | Angular Service Worker hash 失配，PWA 安装/更新失败或 version skew | 首版默认关闭 sourcemap；启用时 inject、upload、删 `.map` 后执行 `npx ngsw-config dist/browser ngsw-config.json /` 和 `node scripts/patch-ngsw-html-hashes.cjs` |
| Source Map 公开部署 | 源码和注释泄露 | 上传 Sentry 后删除 `.map`，CI 最终门禁 |
| `_headers` 多规则合并 Cache-Control | SW 或 HTML 被错误长期缓存 | 不用 `/*.js` 覆盖全部 JS，单独列 hashed chunk 和 SW |
| `_redirects` 错误代理静态资源 | JS/CSS 变成 HTML，白屏 | 首选 Pages 默认 SPA fallback；如加 `_redirects`，preview 中用 curl/Playwright 验证 content-type |
| Service Worker version skew | Chunk/JIT/DI 错误 | no-store 核心清单，保留 GlobalErrorHandler 和 SwUpdate 验证 |
| Origin 变化导致 IndexedDB 不可见 | 用户误以为本地数据丢失 | 切域名前清空同步队列，本地-only 数据导出，旧 Vercel origin 保留 72 小时 |
| Supabase Auth redirect 漏配 | 登录后跳转失败 | 上线前配置 custom domain、Pages preview、本地域名 |
| Edge Function CORS 漏配 | 语音转写、病毒扫描、widget 等功能失败 | 全量 grep `supabase/functions/**`，用 hostname/regex 支持受控 preview 域，更新所有 contract tests |
| PR preview 污染生产 Supabase | 测试数据进入真实项目 | 使用 preview Supabase 或只读/隔离写入 smoke |
| apex 域名误走 CNAME 路径 | custom domain 无法正确接入 Pages | 子域名才走路径 A；`nanoflow.app` apex 走 Cloudflare full DNS setup |
| DNSSEC 旧 DS 残留 | Nameserver 迁移后 SERVFAIL | 仅 full DNS 迁移时提前移除旧 DS，稳定后启用 Cloudflare DNSSEC |
| `workflow_dispatch` 行为不清 | 手动运行只 build/test 却误以为已部署，或误部署 | 增加 `deploy` input；默认不部署，只有 main + `deploy=true` 才生产部署 |
| Cloudflare Dashboard 变量被误当成 Angular 运行时变量 | 新部署仍使用旧 Supabase/Sentry/GoJS 配置 | Direct Upload 下以 GitHub Actions Secrets 为准，Cloudflare Variables 只用于 Pages Functions 或 Git integration 构建 |
| Sentry trace/replay 域名未更新 | 新域名下可观测性缺口 | 更新 `tracePropagationTargets`，上线后手动制造一次测试错误和 replay |
| GoJS license 域名未覆盖 | 新域名出现水印或授权错误 | 切换 custom domain 前确认 GoJS license key 覆盖新域名 |
| Cloudflare Pages Rollback 命令写错 | 回滚慢或失败 | Pages 用 Dashboard/API rollback，不写 `wrangler rollback` |
| TWA origin 变化 | Android App 无法验证 Web origin | 优先沿用 custom domain；改域名则同步 assetlinks、`android/app/build.gradle.kts` 和 TWA 配置 |
| `widget-black-box-action` 被误认为复用 `_shared/widget-common.ts` | CORS 漏改，黑匣子 widget action 在新域名失败 | 单独列入 CORS inventory，必要时独立改源码和测试 |
| Fork PR 因缺少 secrets 执行 `validate-env:prod` 失败 | 外部 PR 无法通过基础 CI | workflow 拆分 test 与 build-deploy；fork PR 只跑不依赖 secrets 的 test job |
| Sentry CLI latest 漂移 | sourcemap inject/upload 行为变化 | 固定 `@sentry/cli` 版本或加入 devDependency 由 lockfile 管理 |

## 16. 项目级审查增补项

本节补充策划案 §1-§16 未覆盖、但落地阶段必须处理的项。每条标注归属阶段，避免和已有路线图冲突。

### 16.1 既有部署基础设施清单（补 §2）

仓库当前不止 Vercel 一份托管配置，迁移和清理必须三套同步处理：

| 文件 | 用途 | 迁移动作 |
| --- | --- | --- |
| `vercel.json` | Vercel rewrites/headers/`ignoreCommand` | 阶段 4 决策保留作为回滚锚还是删除；删除前确认 startup-contract 已重写 |
| `netlify.toml` | Netlify build/redirects/headers | 同上；当前 `NODE_VERSION = "20"`，与本计划 GitHub Actions 选用版本必须对齐 |
| `public/_headers`（新增） | Cloudflare Pages 头规则 | 阶段 1 新增 |
| `public/_redirects`（可选） | Cloudflare Pages SPA fallback | 仅在默认 fallback 不满足深链刷新时新增 |
| `src/tests/startup-contract.spec.ts` | 同时校验 `vercel.json` 和 `netlify.toml` 中 `sw-composed.js`、`ngsw-worker.js`、`widgets/templates/(.*)` 的 `no-cache` | 阶段 1 必须随头规则改造同步更新；不更新会让 CI 红 |
| `android/app/build.gradle.kts` | Android TWA 默认 `webOrigin` | 阶段 1 纳入旧域名 inventory；按最终域名更新默认值或要求 release 构建显式传 `NANOFLOW_WEB_ORIGIN` |

执行方式：在阶段 1 增加一条任务"决定保留/删除旧托管配置文件，并同步更新 `startup-contract.spec.ts`"。仅删除 `vercel.json` / `netlify.toml` 而不动 spec 会立即破坏 `npm run test:run:ci`。

### 16.2 Edge Function CORS 边界细化（替换 §6.2 的全量审查描述）

仓库实际至少有四类 CORS 实现：`transcribe` 硬编码、`virus-scan` env 驱动、`_shared/widget-common.ts` env 驱动、`widget-black-box-action` 独立内联。迁移成本不同，不能把所有 widget 函数都视为 `_shared/widget-common.ts` 统一覆盖；表中另列复用 `_shared/widget-common.ts` 的 widget 函数，便于执行时归类：

| Edge Function | CORS 实现 | 迁移路径 |
| --- | --- | --- |
| `supabase/functions/transcribe/index.ts` | **硬编码** `ALLOWED_ORIGINS` 数组 + `*.vercel.app` 前缀判断 | 必须改源码，更新 `src/tests/contracts/transcribe-cors.contract.spec.ts`，重新部署 |
| `supabase/functions/virus-scan/index.ts` | 读 `Deno.env.get('ALLOWED_ORIGINS')` exact match，缺省回退到内置默认；另有 Vercel preview hostname 判断 | 固定 origin 可用 `supabase secrets set ALLOWED_ORIGINS=...`；PR preview wildcard 需要改源码 |
| `supabase/functions/_shared/widget-common.ts` | 读 `Deno.env.get('ALLOWED_ORIGINS')` exact match，缺省回退到内置默认；另有 Vercel preview hostname 判断 | 固定 origin 可用 secret；`pr-*.pages.dev` 需要改源码 |
| `widget-register` / `widget-summary` / `widget-notify` / `widget-focus-action` | 复用 `_shared/widget-common.ts` | 跟随 `_shared/widget-common.ts` 的修复路径 |
| `supabase/functions/widget-black-box-action/index.ts` | **独立内联** `ALLOWED_ORIGINS` + Vercel preview hostname 判断 | 必须单独改源码或明确 preview 不覆盖此链路 |

阶段 0 行动：

```bash
# 固定 production/pages.dev origin 可先写入 Supabase secrets
supabase secrets set ALLOWED_ORIGINS="https://app.nanoflow.app,https://nanoflow.app,https://nanoflow.pages.dev"
# PR preview wildcard 不会被普通字符串 exact match 命中，必须走代码改动或不测相关链路。
```

PR preview 通配（`https://pr-*.nanoflow.pages.dev`）目前不会被 `ALLOWED_ORIGINS` 的字符串相等比较匹配。要么扩展 `transcribe`、`virus-scan`、`_shared/widget-common`、`widget-black-box-action` 增加 hostname regex 支持，要么**preview 不走需要这些 Edge Function 的链路**。两条路二选一，必须在阶段 0 决策。

### 16.3 旧 Vercel 域名引用全量清单（补 §5/§9）

策划案多处提"更新 contract tests"但只点名 `transcribe-cors.contract.spec.ts`。实际仓库引用 `dde-eight.vercel.app` / `dde[-\w]*\.vercel\.app` 的位置：

| 文件 | 性质 | 处理方式 |
| --- | --- | --- |
| `src/services/sentry-lazy-loader.service.ts:250` | 运行时 `tracePropagationTargets` 正则 | 阶段 1 改为同时包含新域名与旧域名（迁移窗口期），稳定后移除旧 |
| `src/tests/contracts/transcribe-cors.contract.spec.ts` | 整套契约围绕 vercel 项目前缀 | 阶段 1 改写，与 transcribe Edge Function 同步 |
| `src/services/global-error-handler.service.spec.ts:240-290` | 堆栈解析 fixture | 阶段 1 改为新域名 fixture，或保留旧 fixture 验证向后兼容 |
| `src/workspace-shell.component.spec.ts:624` | 路由 fixture | 同上 |
| `src/utils/runtime-platform.spec.ts:56` | host package 解析负样例 | 同上 |
| `scripts/contracts/check-secrets.cjs` 中 `.vercel` 目录排除 | 与 vercel.json 共存 | 删除 vercel.json 时一并审查 |
| `android/app/build.gradle.kts` | TWA 默认 `webOrigin` | 阶段 1 按最终域名更新默认值，或要求 release 构建显式传 `NANOFLOW_WEB_ORIGIN` |
| `supabase/functions/transcribe/index.ts` / `virus-scan/index.ts` / `_shared/widget-common.ts` / `widget-black-box-action/index.ts` | Edge Function CORS allow-list | 阶段 1 按 §6.2/§16.2 处理，回滚窗口后移除旧域 |

切换前先全仓 inventory：

```bash
rg "dde-eight\.vercel\.app|dde[-\w]*\.vercel\.app|vercel\.app" --hidden -g '!node_modules' -g '!dist'
```

逐项归类（运行时常量 / Edge Function CORS / TWA 配置 / 测试 fixture / 文档归档），再决定替换或保留。迁移 PR 描述必须贴出 inventory 摘要，避免静态清单漏项。

### 16.4 构建产物后处理顺序（补 §5.4）

NanoFlow `npm run build` 在 `ng build` 之后还有四个后处理步骤，迁移到 GitHub Actions 后必须**完整复刻**，否则产物缺件：

```text
1. node scripts/run-ng.cjs build           # Angular AOT
2. node scripts/generate-launch-html.cjs   # 生成 launch.html（PWA 启动占位页）
3. node scripts/inject-modulepreload.cjs   # 向 index.html 注入 modulepreload Link
4. node scripts/patch-ngsw-html-hashes.cjs # 修正 ngsw.json 中 HTML 文件 hash
5. node scripts/validate-launch-shared-markers.cjs   # 校验 launch.html 共享标记
6. node scripts/validate-launch-artifact-closure.cjs # 校验 launch.html 闭包资源
```

`npm run build:stats` 已经包含完整链路，因此 §5.3 workflow 调用 `build:stats` 是对的。但有两个**容易踩坑**的点：

**陷阱 A：Sentry sourcemap inject 后必须重新跑 step 3-4，不止 step 4。**

策划案 §5.4 只写了 `npx ngsw-config dist/browser ngsw-config.json /` 重建 ngsw。问题是：

- `inject-modulepreload.cjs` 把 hashed chunk 名写进了 `index.html` 的 `<link rel="modulepreload">`。如果 inject 改了 chunk 内容但没改文件名（Debug ID 是 inline 注入），文件名不变，modulepreload Link 无需重写——OK。
- `patch-ngsw-html-hashes.cjs` 修正的是 `ngsw.json` 中 HTML 内容 hash。`inject-modulepreload` 修改了 `index.html`，`patch-ngsw-html-hashes` 必须**在 sourcemap 流程之外**已经跑过。
- 如果 sourcemap inject 修改了 `index.html`（Sentry 通常不改 HTML），还需要再次跑 `patch-ngsw-html-hashes.cjs`。

正确顺序：

```text
1-6. 标准 build:stats 完成
7.  Sentry sourcemaps inject dist/browser
8.  Sentry sourcemaps upload
9.  rm dist/browser/**/*.map
10. npx ngsw-config dist/browser ngsw-config.json /
11. node scripts/patch-ngsw-html-hashes.cjs   # 重新对齐 HTML hash
12. find dist/browser -name '*.map' 必须为空
```

**陷阱 B：Cloudflare Early Hints 与 modulepreload 冲突。**

§8.3 提到 Cloudflare Pages 自动从 HTML 中的 `preload`/`preconnect`/`modulepreload` 生成 Link header。`scripts/inject-modulepreload.cjs` 的目的就是 modulepreload。两者会**叠加生成 Link header**，结果相同，但要确认：

- Cloudflare Early Hints 不会丢失 modulepreload 中的 `crossorigin` 属性；
- 不要在 `_headers` 中再手写 hashed chunk preload，让 Early Hints 自动派生即可。

阶段 2 验收增加一条：preview 上 `curl -I /` 检查响应头是否包含 `103 Early Hints` 或 `Link: </main-XXXX.js>; rel=modulepreload`。

### 16.5 Service Worker dataGroups 跨域资源（补 §8）

`ngsw-config.json` 的 `dataGroups` 缓存以下浏览器直连的外部 URL：

```text
https://*.supabase.co/storage/v1/object/*    # Storage
https://fonts.googleapis.com/**              # Google Fonts
https://fonts.gstatic.com/**                 # Google Fonts CSS/woff2
https://cdn.jsdelivr.net/npm/lxgw-wenkai*/** # LXGW 字体
https://cdn.jsdelivr.net/**                  # 其他 jsdelivr 资源
https://unpkg.com/**                         # unpkg
```

迁移到 Cloudflare Pages**不影响**这些请求（仍由浏览器直连），但有两点需要在 §16.6 的 CSP 中收齐：

- `connect-src` 必须包含 `https://*.supabase.co` 和 Sentry DSN 的 host；
- `font-src` / `style-src` 必须包含 `https://fonts.gstatic.com`、`https://fonts.googleapis.com`、`https://cdn.jsdelivr.net`；
- 如果未来想精简 CDN（例如把 LXGW 字体自托管到 Cloudflare），先在 ngsw `dataGroups` 中替换 URL 模式，再做 CSP 收紧。

### 16.6 安全响应头补全（补 §4.4）

策划案 `_headers` 草案首版只启用低风险基础头：

```text
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
```

以下头不要混入首版迁移，稳定后单独 PR 评估：

```text
/*
  Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Cross-Origin-Resource-Policy: same-site
```

注意：

- `microphone=(self)` 因为 NanoFlow 有 Focus 模式语音转写。
- **首版不启用 `Strict-Transport-Security`**。本文统一把 `HSTS_STABILIZATION_WINDOW` 定义为 7 天。HSTS 一旦被浏览器记录，回滚到 HTTP 或错误子域配置会变困难；仅在 Cloudflare TLS 和所有相关子域稳定满 `HSTS_STABILIZATION_WINDOW` 后，作为独立变更启用。
- **不开启 `Cross-Origin-Embedder-Policy: require-corp`**：会导致 Supabase Storage 跨域图片、jsdelivr CDN 字体被拒绝。GoJS chunk 通过 same-origin 加载不受影响，但外部资源会断。
- **`Content-Security-Policy` 暂不开启**：NanoFlow 当前没有运行时 CSP，盲开会触发大面积告警。CSP 收紧应作为**迁移后独立任务**，先 `Content-Security-Policy-Report-Only` 观察一周再切硬模式。

### 16.7 Boot Flag / Feature Flag 注入清单（补 §5.2）

`scripts/set-env.cjs` 把以下 `NG_APP_*` 布尔 Flag 注入 build 产物（截至 2026-04-28）：

```text
NG_APP_DISABLE_INDEX_DATA_PRELOAD_V1   default true
NG_APP_FONT_EXTREME_FIRSTPAINT_V1      default true
NG_APP_FLOW_STATE_AWARE_RESTORE_V2     default true
NG_APP_EVENT_DRIVEN_SYNC_PULSE_V1      default true
NG_APP_TAB_SYNC_LOCAL_REFRESH_V1       default true
NG_APP_STRICT_MODULEPRELOAD_V2         default false
NG_APP_ROOT_STARTUP_DEP_PRUNE_V1       default true
NG_APP_TIERED_STARTUP_HYDRATION_V1     default true
NG_APP_SUPABASE_DEFERRED_SDK_V1        default true
NG_APP_CONFIG_BARREL_PRUNE_V1          default true
NG_APP_SIDEBAR_TOOLS_DYNAMIC_LOAD_V1   default true
NG_APP_RESUME_INTERACTION_FIRST_V1     default true
NG_APP_RESUME_WATERMARK_RPC_V1         default true
```

含义：GitHub Actions 环境如果不显式注入这些变量，会落到代码中的默认值——和 Vercel 当前的默认值是否一致**取决于 Vercel Dashboard 是否覆盖过任何 flag**。

阶段 0 必做：

1. 登录 Vercel Dashboard 导出当前生产环境变量全集。
2. 与 `set-env.cjs` 中默认值逐一对照；若有差异，把差异项写进 GitHub Actions Secrets 或 Variables。
3. 在 §5.2 GitHub Secrets 表追加这批 `NG_APP_*` 项作为可选 override。
4. 阶段 2 preview 验收时 `console.log(environment)` 或加一条断言，确认 flag 与生产期望一致。

### 16.8 manifest.webmanifest 与 assetlinks.json 内容审查（补 §10）

迁移前必须确认两份产物中没有硬编码旧 origin：

```bash
cat dist/browser/manifest.webmanifest | jq '{id, scope, start_url, related_applications}'
cat dist/browser/.well-known/assetlinks.json | jq '.[].target.sha256_cert_fingerprints'
```

**`manifest.webmanifest`**：

- `scope` 与 `start_url`：必须是相对路径或当前 origin；如果硬编码 `https://dde-eight.vercel.app/...`，PWA 在新域名下会被识别为另一个 app，离线缓存隔离、shortcut 失效。
- `id`：一旦上线后不要变，否则浏览器把它当新 PWA。`id` 的值如果原本是 `https://dde-eight.vercel.app/`，迁移后无解——只能让用户重新安装。**这是一票否决项**，迁移前必须看清楚。

**`assetlinks.json`**：

- 通过 `scripts/generate-assetlinks.cjs` 生成。Android TWA 同时存在 dev keystore 与 release keystore 时，必须包含**两个 SHA256 fingerprint**，否则 dev 安装包验证失败。
- 如果使用 Google Play App Signing，还需要 Play Store 控制台分发的 fingerprint。

阶段 1 增加任务：在 CI artifact guard 中校验 `dist/browser/manifest.webmanifest` 不包含 `vercel.app` 字符串。

### 16.9 防止误启用 Pages Functions（补 §4）

Cloudflare Pages 看到 `dist/browser/functions/` 目录或 `dist/browser/_worker.js` 文件会**自动启用** Functions runtime，附带：

- 改变响应头处理（`_headers` 仍生效，但 Functions 优先）；
- 静态资源吞吐被 Functions 预算（每天 100k 请求 free plan）限制；
- 增加冷启动与边缘计算开销。

NanoFlow 不需要 Functions。CI artifact guard 增加：

```bash
test ! -d dist/browser/functions
test ! -f dist/browser/_worker.js
```

可选增强：写入 `public/_routes.json` 显式禁用：

```json
{
  "version": 1,
  "include": [],
  "exclude": ["/*"]
}
```

但仅在不写 `functions/` 目录的情况下才需要——如果都没有 functions，`_routes.json` 是冗余的。**不建议加**，留空是更干净的 Direct Upload。

### 16.10 Supabase 配套补充（补 §6）

策划案 §6 已覆盖 Auth Redirect 与 Edge Function CORS。还有三块没写：

**16.10.1 Supabase Storage 跨域**

Storage signed URL 的有效性与 origin 无关，但 bucket CORS allow-list 在 Supabase Dashboard 里。检查路径：

```text
Supabase Dashboard
-> Storage
-> 选择 bucket（attachments / focus-recordings）
-> Configuration / CORS
```

加入 `https://app.nanoflow.app`、`https://nanoflow.pages.dev`、PR preview 模式（如果允许 preview 直传 Storage）。

**16.10.2 Supabase Realtime WebSocket**

NanoFlow 当前 `SYNC_CONFIG.REALTIME_ENABLED = false`，但仓库代码已具备 realtime 能力。如果未来开启：

- WebSocket 走 `wss://<project>.supabase.co/realtime/v1/websocket`，与 Cloudflare Pages 无关；
- 但 CSP `connect-src` 必须包含 `wss://*.supabase.co`；
- Cloudflare 不要对该域名做 proxying。

**16.10.3 Migration ↔ 前端部署顺序**

如果迁移窗口同时有 Supabase migration 待发布：

```text
错误顺序：先合并前端到 main，Cloudflare 部署新版本，但 migration 还没跑
后果：前端期待新 schema，数据库还是旧 schema，新增任务 400/500
```

正确顺序：

```text
1. Supabase 应用 migration（向后兼容；新列允许 NULL，新表不删旧表）
2. 前端 main 合并，Cloudflare 部署
3. 观察 24 小时无回滚需求后，跑后续 migration（删除旧字段、收紧约束）
```

回滚同理：前端能 rollback 到旧版本的前提是数据库 schema 仍向后兼容旧前端代码。

阶段 -1 / 阶段 0 增加任务：盘点未发布 migration 是否破坏向后兼容。

### 16.11 PR Preview 数据隔离落地方案（补 §6.1）

策划案 §5.2 / §6.1 多次提"使用 preview Supabase 项目"，但没给出具体方案。三选一：

**方案 A：Supabase Branching（官方功能）。** 适合中等以上预算项目，PR 自动派生 schema 分支与隔离数据。需要 Supabase Pro 计划。个人项目通常不选。

**方案 B：独立 Supabase Preview Project（推荐）。** 创建一个 `nanoflow-preview` 项目，PR preview 走它的 URL/anon key（即策划案中的 `PREVIEW_NG_APP_SUPABASE_URL`）。

- 优点：完全隔离，不影响生产用户。
- 缺点：需要手动同步 schema。可写一个 `scripts/sync-preview-schema.sh`，在 CI 里 pin 到生产 schema 的某个 commit。

**方案 C：生产 Supabase + 测试用户（不推荐）。** 用一个 `preview-bot@nanoflow.app` 用户登录 PR preview，所有写入都打到该用户的 RLS 隔离区。每次 PR 关闭后用 cron 清理该用户的数据。

```sql
-- 阶段 1 任务：在 supabase/migrations/ 中加入 preview cleanup function
-- 仅当采用方案 C 时
CREATE OR REPLACE FUNCTION cleanup_preview_user_data() ...
```

**默认推荐方案 B**，并在阶段 0 决策后写进 §5.2 secrets 表。

### 16.12 Wrangler 与依赖版本固定（补 §5.3）

策划案 workflow 用 `cloudflare/wrangler-action@v3`，但没说明 wrangler 本体版本。Direct Upload 行为在 wrangler 3.x 不同子版本间有过破坏性改动（`pages deploy` flag 命名）。Sentry CLI 同理，`npx @sentry/cli` 不应隐式跟随 latest。

阶段 1 必做：

```yaml
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ...
    accountId: ...
    wranglerVersion: '3.114.0'   # 固定到一个已验证的版本
    command: pages deploy ...
```

理由：`wrangler-action@v3` 可能跟随 latest wrangler，未来 wrangler 4.x 一旦有 breaking change，部署会突然失败。锁定到具体版本，升级时显式 PR。首版推荐 Sentry sourcemap 步骤使用 `npx @sentry/cli@2.58.2` 显式 pinning，不改 `package.json`；如果后续需要本地复现 sourcemap 流程，再把 `@sentry/cli` 加入 devDependency 并由 lockfile 固定。

### 16.13 Direct Upload 失败重试（补 §5.3）

Cloudflare Direct Upload 偶发 5xx / 401（token 限流）。workflow 加 retry：

```yaml
- name: Deploy production to Cloudflare Pages
  uses: nick-fields/retry@v3
  with:
    timeout_minutes: 8
    max_attempts: 3
    retry_wait_seconds: 30
    command: |
      npx wrangler@3.114.0 pages deploy dist/browser \
        --project-name=$CLOUDFLARE_PAGES_PROJECT_NAME \
        --branch=main
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

或保留 `cloudflare/wrangler-action@v3` 但外层包 `nick-fields/retry`。`Direct Upload` 单次最多 20,000 文件、单文件 25 MiB——是**每次 deployment** 的限制，不是 per-site；NanoFlow 当前产物 1-3k 文件，余量充足，但 Sentry sourcemap 启用后文件数会翻倍，需要确认 `.map` 已删后再上传。

### 16.14 Node 版本统一（补 §5.3）

现状不一致：

- `netlify.toml`：`NODE_VERSION = "20"`
- 策划案 `deploy-cloudflare-pages.yml`：`node-version: 22`
- `.github/workflows/test-full-suite.yml` 与 `perf-and-resume-gates.yml` 已使用 Node 22
- `package.json` engines 当前是 `>=18.19.0`

阶段 1 任务：

```bash
grep -rn "node-version\|NODE_VERSION" .github/workflows netlify.toml package.json
```

首版迁移只要求 Cloudflare deploy workflow 固定 Node 22，并同步任何仍用于过渡部署的平台配置。是否把 `package.json` 收紧到：

```json
"engines": {
  "node": ">=22.0.0 <23.0.0"
}
```

应作为独立基线决策，不在 Cloudflare 迁移 PR 中隐式完成；如果收紧，需要同步 README、开发环境说明、CI 和旧托管平台配置。

### 16.15 部署后 Smoke 自动化（补 §14）

策划案 §14 列出了 curl 头检查清单，但没接进 workflow。建议把 Playwright `PLAYWRIGHT_BASE_URL` 注入能力直接复用：

```yaml
- name: Post-deploy smoke
  if: github.ref == 'refs/heads/main' && success()
  env:
    PLAYWRIGHT_BASE_URL: https://app.nanoflow.app
  run: |
    npx playwright test e2e/critical-paths --reporter=line
```

`playwright.config.ts` 已支持 `PLAYWRIGHT_BASE_URL` 覆盖 dev server，无需新建配置文件。

如果不想跑完整 Playwright，最低限度跑 §14 的 curl 清单作为 shell step。

### 16.16 性能 Guard 接入与 baseline 漂移（补 §5.3）

`npm run perf:guard` 包含 5 项：`build:stats` / `nojit` / `startup` / `font-contract` / `supabase-ready`。策划案 deploy workflow 只跑 `nojit`。

判断：

- `font-contract` 与 `supabase-ready` 是构建产物契约，**不依赖运行环境**，应进入 deploy 链路。
- `startup` 依赖 Lighthouse / 启动时序基线，CI 环境波动大；放在 `perf-and-resume-gates.yml` nightly 跑即可，不进 deploy 阻塞链路。

调整后 deploy workflow 步骤：

```yaml
- run: npm run build:stats
- run: npm run perf:guard:nojit
- run: npm run quality:guard:font-contract
- run: npm run quality:guard:supabase-ready
```

`perf:guard:startup` 与 `perf:guard:no-regression` 保留在 nightly。Cloudflare 边缘 TTFB 与 Vercel 不同，可能让 startup baseline 出现一次性漂移——迁移稳定满 7 天后用 `npm run test:baseline:update` 重置基线。

### 16.17 文件命名与缓存模式（补 §4.4）

`angular.json` production 配置 `outputHashing: "all"`、`namedChunks: false`。含义：

- 入口：`main-<hash>.js`、`polyfills-<hash>.js`、`styles-<hash>.css`；
- 懒加载：`chunk-<hash>.js`；
- Web Worker：`worker-<hash>.js`。

`_headers` 草案中的 `/main*.js` / `/polyfills*.js` / `/chunk*.js` / `/worker*.js` 都能命中。**风险点**：

- 如果未来在 `angular.json` 把 `outputHashing` 改成 `bundles` 或 `media`，`chunk*.js` 模式可能失效；
- 如果引入新的入口 bundle（例如 `runtime-*.js`），需要补规则。

阶段 1 加 CI artifact guard：

```bash
# 防御性检查：除入口/polyfills/chunk/worker 外，不应有未匹配规则的 .js 出现在根目录
ls dist/browser/*.js | grep -vE '(main|polyfills|chunk|worker|runtime|sw-composed|ngsw-worker|safety-worker)' && exit 1 || true
```

### 16.18 Sentry 多环境配置（补 §5.5）

策划案 §5.5 谈了 release 对齐，未涉及 environment 与 sample rate。建议：

| 环境 | environment | tracesSampleRate | replaysSessionSampleRate | replaysOnErrorSampleRate |
| --- | --- | --- | --- | --- |
| local | `development` | 0 | 0 | 0 |
| PR preview (`pr-*.pages.dev`) | `preview` | 0.1 | 0 | 1.0 |
| production (`app.nanoflow.app`) | `production` | 0.05 | 0.01 | 1.0 |

实现路径：

- 在 `set-env.cjs` 增加 `NG_APP_SENTRY_ENVIRONMENT` 注入；
- workflow 中按 `github.event_name` 选值：

```yaml
NG_APP_SENTRY_ENVIRONMENT: ${{ github.event_name == 'pull_request' && 'preview' || 'production' }}
```

- `SentryLazyLoaderService` 中读取该值并传入 `Sentry.init({ environment })`。

首版迁移可暂不实现，把它列入"迁移后第一周内完成"的清单。

### 16.19 Robots / Sitemap / 旧域名收敛（补 §11）

策划案没提 SEO 收敛。现状：NanoFlow 没有官方 robots.txt 或 sitemap.xml（已确认 `public/` 中不存在）。迁移期间：

- **稳定 72 小时后**，在旧 Vercel 部署的 `public/_headers` 注入：

  ```text
  /*
    X-Robots-Tag: noindex
  ```

  防止搜索引擎继续抓取旧域名。

- 不必新增 sitemap/robots 到 Cloudflare 部署，除非有 SEO 需求。
- 如果用户从旧域名 bookmark 进入，提供一个 redirect 友好提示（保留 Vercel 旧部署的同时，加 `vercel.json` rewrite 指向 `https://app.nanoflow.app`）。但 PWA `id` 一旦绑定到旧 origin，redirect 解决不了 PWA 安装迁移问题。

### 16.20 Vercel 完全失能时的最小可发布路径（补 §4.5）

阶段 -1 假设 Vercel 还能用作过渡。极端情况：Vercel 账户被锁、token 失效、构建额度立刻为 0 且无法升级。此时：

1. **立即在 GitHub 仓库 Settings 关闭 Vercel App 集成**，避免 Vercel 持续尝试构建。
2. 跳过阶段 -1 / 阶段 0 中的所有 Vercel 相关步骤，直接进入阶段 1。
3. Cloudflare Direct Upload 项目用 dashboard drag-and-drop 上传一个**本地构建产物**（`npm run build:stats && npm run perf:guard:nojit`），完成首次部署。
4. 自定义域名直接绑定，先牺牲 24-72 小时回滚窗口；老用户在切换前先用 `npm run start` 本地访问数据。
5. 阶段 2 / 阶段 3 在 Cloudflare 上原地推进。

阶段 -1 任务追加一条：**确认 Vercel 即使全失能，也有备份的 GitHub Secrets 与 Supabase secrets 可读。** Cloudflare 与 Supabase 凭据不要只存在 Vercel 中。

### 16.21 Rollback 时数据 schema 兼容（补 §9.2）

策划案 §9.2 把 rollback 当成"切回旧 deployment"。但 Local-First + Supabase 同步链路下，rollback 还要考虑：

- 用户在新版本期间已经写入 IndexedDB 的数据，使用了**新前端**才有的字段（如 `parking_meta` 子字段、`expected_minutes`）。
- 切回旧 Cloudflare deployment 后，旧前端读到这些字段会忽略或 crash。
- 推送到 Supabase 的写入若使用了新列，旧前端在拉取时也可能出现 type guard 失败。

缓解：

- Supabase migration 必须**纯增量**（只加列，不改语义）。
- 前端任何新字段必须有 `field ?? defaultValue` 兜底。
- 前端如果新增 schema validator，必须对未知字段保持宽松（`allowUnknown: true`）。

阶段 0 / 阶段 1 任务：审查近 30 天的前端字段新增 PR，确认旧前端能容忍。

### 16.22 本地预演（新增）

在合并 deploy workflow 之前，在本地完整跑一次 Cloudflare Pages 行为：

```bash
npm ci
npm run build:stats
npm run perf:guard:nojit
npm run quality:guard:font-contract
npm run quality:guard:supabase-ready
npx wrangler pages dev dist/browser --port 8788
# 浏览器打开 http://localhost:8788
# 验证 SPA fallback、_headers、PWA install、SW update
```

`wrangler pages dev` 会模拟 `_headers`、`_redirects`、Functions（如果存在）。这是最便宜的迁移信心来源，应作为阶段 1 的本地 dry-run 步骤。

### 16.23 监控与日志（补 §11）

Cloudflare Pages Free plan 没有持久化的 build 日志或运行时日志。可用的可观测性：

- **GitHub Actions run logs**：deploy workflow 自身的输出，保留 90 天。
- **Cloudflare Dashboard → Pages → Deployments**：每个部署的 build log（仅 Pages Git build 项目；Direct Upload 项目只有上传记录）。
- **Cloudflare Web Analytics**：免费，只看流量；不替代 Sentry。
- **Sentry**：runtime 错误、Session Replay、Performance。**唯一可靠的运行时观测**。

含义：迁移后 Sentry 是 SLO 主要信号源。阶段 4 必做：

- 验证 Sentry 在新域名下能正常上报；
- `tracePropagationTargets` 已包含新域名；
- 设置一个简单的 Sentry alert：`event.count > 50 in 1h && environment == production` → 邮件。

### 16.24 增补风险表（与 §15 保持同步）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `netlify.toml` 与 `vercel.json` 删除导致 startup-contract 红 | CI 阻塞 | 阶段 1 同步重写 spec，或保留旧配置作为只读契约 |
| `manifest.webmanifest` 中 `id` 硬编码旧 origin | PWA 安装态无法迁移，全部用户需重装 | 阶段 0 检查 `id`；如已硬编码旧 origin，迁移前先发版改成相对值并稳定 30 天 |
| `dist/browser/functions/` 误生成 | Cloudflare 自动启用 Functions runtime，影响响应头 | CI artifact guard 校验目录不存在 |
| Wrangler 版本漂移 | 部署突然失败 | 固定 `wrangler-action.wranglerVersion` |
| Direct Upload 偶发 5xx | 部署中断 | retry-action 包裹，max 3 次 |
| Supabase migration 与前端部署顺序错位 | 新前端读旧 schema 报错 | migration 先发布且向后兼容；rollback 前不发破坏性 migration |
| HSTS 混入首版 `_headers` | TLS/DNS 还未稳定时浏览器锁定 HTTPS，回滚复杂 | 首版不启用；仅在 Cloudflare TLS 和所有相关子域稳定满 `HSTS_STABILIZATION_WINDOW` 后单独 PR 启用 |
| `NG_APP_*_V1/V2` Boot Flag 默认值偏离当前生产 | 启动行为意外变化 | 阶段 0 导出 Vercel env 全集对照默认值 |
| Sentry environment 未区分 preview/production | 告警噪声、采样失真 | 阶段 4 内补 `NG_APP_SENTRY_ENVIRONMENT` 注入 |
| `_headers` 与 `inject-modulepreload` Link 重复 | Early Hints 体积膨胀 | 不在 `_headers` 写 chunk preload，依赖 Cloudflare 自动派生 |
| `widget-black-box-action` 被误认为复用 `_shared/widget-common.ts` | CORS 漏改，黑匣子 widget action 在新域名失败 | 单独列入 CORS inventory，必要时独立改源码和测试 |
| Fork PR 因缺少 secrets 执行 `validate-env:prod` 失败 | 外部 PR 无法通过基础 CI | workflow 拆分 test 与 build-deploy；fork PR 只跑不依赖 secrets 的 test job |
| Android TWA 默认 origin 仍指向 Vercel | release 构建或本地验证误连旧站 | 更新 `android/app/build.gradle.kts` 默认值或强制 release 构建传 `NANOFLOW_WEB_ORIGIN` |
| Sentry CLI latest 漂移 | sourcemap inject/upload 行为变化 | 固定 `@sentry/cli` 版本或加入 devDependency 由 lockfile 管理 |

---

## 17. 官方资料

- Vercel Builds：<https://vercel.com/docs/deployments/builds/>
- Vercel Managing Builds：<https://vercel.com/docs/builds/managing-builds>
- Vercel Ignored Build Step：<https://vercel.com/kb/guide/how-do-i-use-the-ignored-build-step-field-on-vercel>
- Vercel CLI `vercel build`：<https://vercel.com/docs/cli/build>
- Vercel Deployments：<https://vercel.com/docs/deployments>
- Cloudflare Pages Direct Upload：<https://developers.cloudflare.com/pages/get-started/direct-upload/>
- Cloudflare Pages Direct Upload with CI：<https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>
- Cloudflare Wrangler Pages commands：<https://developers.cloudflare.com/workers/wrangler/commands/pages/>
- Cloudflare Pages Git integration：<https://developers.cloudflare.com/pages/get-started/git-integration/>
- Cloudflare Pages Git integration configuration：<https://developers.cloudflare.com/pages/configuration/git-integration/>
- Cloudflare Pages Variables and Secrets：<https://developers.cloudflare.com/pages/functions/bindings/>
- Cloudflare Pages Angular 指南：<https://developers.cloudflare.com/pages/framework-guides/deploy-an-angular-site/>
- Cloudflare Pages Headers：<https://developers.cloudflare.com/pages/configuration/headers/>
- Cloudflare Pages Redirects：<https://developers.cloudflare.com/pages/configuration/redirects/>
- Cloudflare Pages Serving Pages / SPA behavior：<https://developers.cloudflare.com/pages/configuration/serving-pages/>
- Cloudflare Pages Custom Domains：<https://developers.cloudflare.com/pages/configuration/custom-domains/>
- Cloudflare Pages Limits：<https://developers.cloudflare.com/pages/platform/limits/>
- Cloudflare Pages Rollbacks：<https://developers.cloudflare.com/pages/configuration/rollbacks/>
- Cloudflare Pages Early Hints：<https://developers.cloudflare.com/pages/configuration/early-hints/>
- Cloudflare Content Compression：<https://developers.cloudflare.com/speed/optimization/content/compression/>
- Cloudflare DNSSEC：<https://developers.cloudflare.com/dns/dnssec/>
- Cloudflare stale DS troubleshooting：<https://developers.cloudflare.com/dns/zone-setups/troubleshooting/pending-nameservers/>
- Supabase Auth Redirect URLs：<https://supabase.com/docs/guides/auth/redirect-urls>
- Angular Service Workers：<https://angular.dev/ecosystem/service-workers>
- Angular Workspace Configuration / Source Maps：<https://angular.dev/reference/configs/workspace-config>
- Sentry Source Maps Uploading with CLI：<https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/>
- Sentry Source Map troubleshooting：<https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/>
