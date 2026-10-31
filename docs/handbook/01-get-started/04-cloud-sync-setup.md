---
title: 云同步配置
status: canonical
audience: user, operator
last_verified: 2026-07-15
category: get-started
source_paths:
  - README.md
  - .env.template
  - src/app/shared/modals/config-help-modal.component.ts
  - src/services/supabase-client-configuration.ts
  - src/services/supabase-client.service.ts
  - scripts/set-env.cjs
  - scripts/init-supabase.sql
  - supabase/functions/
  - supabase/migrations/
---

# 云同步配置

云同步让 NanoFlow 支持登录、多设备同步、附件、语音转写、小组件和服务端安全策略。它不是第一次试用的必需项，但如果你要长期跨设备使用，就必须认真配置。

## 本文内容

- [什么时候需要云同步](#什么时候需要云同步)
- [出现“配置帮助”时先判断角色](#出现配置帮助时先判断角色)
- [准备 Supabase 项目](#准备-supabase-项目)
- [配置前端环境变量](#配置前端环境变量)
- [配置附件和 Edge Functions](#配置附件和-edge-functions)
- [第一次同步验收](#第一次同步验收)
- [常见误解](#常见误解)
- [下一步](#下一步)

## 什么时候需要云同步

你需要云同步，如果你想使用：

- 多台设备看到同一批项目和任务；
- 登录账户；
- Supabase Storage 私有附件；
- 语音转写；
- Android 小组件；
- 服务端病毒扫描；
- 更完整的数据恢复和审计路径。

如果你只在一台电脑上用，而且已经有稳定本地备份，可以先不配置云同步。

## 出现“配置帮助”时先判断角色

侧边栏的“查看配置指南”只会在应用同时进入本地离线回退并确认 Supabase 配置不安全或不一致时出现。它不是普通的网络中断提示，也不是让每位使用者把密钥粘进浏览器的入口。

目前这类配置校验重点覆盖两种风险：

- 前端拿到了非匿名的敏感密钥，例如 `service_role`、`secret`、`private` 或 `admin` 类型的密钥；
- `NG_APP_SUPABASE_URL` 指向的项目与传统 anon JWT 中的项目引用不一致。

缺少或仍使用 `YOUR_SUPABASE_URL`、`YOUR_SUPABASE_ANON_KEY` 占位值也会阻止云端客户端初始化：开发环境会回退到本地模式，生产环境应视为部署配置错误。不同状态不一定都会显示同一个按钮，因此不要以“有没有看到配置帮助”作为唯一诊断依据。

### 我只是使用这个实例

不要向任何人索要 service role key，也不要在已部署的网站里尝试创建 `.env.local` 来修复问题。你无法通过修改自己电脑上的文件改变已经发布的静态网站。

先做下面三件事：

1. 确认当前任务是否只存在于此浏览器；重要内容先导出 JSON，附件另行导出 ZIP。
2. 记录提示文字、访问地址和发生时间，然后联系该实例的部署者或管理员。
3. 在管理员确认云同步恢复前，不要把同一项目的另一台设备当作同步成功的副本，也不要清除浏览器数据。

本地模式仍可以继续处理当前浏览器中的工作，但它不提供跨设备同步保证。详情见 [离线、PWA 与错误恢复](06-pwa-offline-and-error-recovery.md)。

### 我维护这个实例

你需要有仓库或托管平台的环境变量权限。先停止把任何敏感 key 放入前端构建，再按下一节配置成同一个 Supabase 项目的 URL 和 anon key，重新构建部署，最后用两个独立浏览器资料完成首次同步验收。完整的托管发布顺序见 [私有部署](../04-deploy-operate/01-private-deployment.md)。

## 准备 Supabase 项目

你需要一个 Supabase 项目，并完成下面几件事：

1. 创建项目。
2. 执行仓库里的数据库初始化 SQL 和迁移。
3. 确认用户数据表启用 RLS。
4. 创建私有 Storage bucket，名称必须是 `attachments`。
5. 准备 Auth 登录方式。
6. 如果修改了数据库结构，生成 TypeScript 类型：

```bash
npm run db:types
```

不要为了调试方便关闭 RLS。RLS 是多设备和多账户数据隔离的底线。

## 配置前端环境变量

前端只应该拿到同一个 Supabase 项目的公开连接值：

```bash
NG_APP_SUPABASE_URL=https://your-project.supabase.co
NG_APP_SUPABASE_ANON_KEY=your-anon-key
```

### 在本地开发时配置

在仓库根目录创建或更新 `.env.local`，填入上面的两项，再运行：

```bash
npm run config
npm start
```

`npm run config && npm start` 与依次执行这两个命令等价。重新启动开发服务器后，再观察侧边栏状态和登录流程；浏览器中已有的旧 JavaScript 不会自动读取你刚修改的文件。

### 在托管平台发布时配置

`.env.local` 只影响你的本地构建。部署到 Cloudflare Pages、Vercel、Netlify 或 Railway 时，要在该平台的项目环境变量中配置同名值，然后触发一次新的构建和发布。只修改平台变量、不重新构建，已经发布的静态前端仍可能带着旧配置。

不要把 `.env.local` 提交到版本库，即使其中的 anon key 本身是公开 client key。环境文件常常会在之后加入其他值，版本库也不应成为环境配置的分发渠道。

### 公开 key 与秘密的边界

| 值 | 能否进入浏览器构建 | 为什么 |
| --- | --- | --- |
| Supabase Project URL | 可以 | 它是客户端连接地址 |
| Supabase anon key | 可以 | 它是公开 client key；数据隔离依赖 RLS 和 Storage policy，而不是隐藏这个值 |
| service role / secret key | 绝对不可以 | 它会绕过 RLS，只能留在受控服务端或 Supabase Secrets 中 |
| Groq、FCM、Sentry 上传 token 等服务端凭据 | 不可以 | 这些值属于服务器能力，不应被浏览器用户取得 |

因此，发现 service role 或其他敏感 key 被放进 `NG_APP_SUPABASE_ANON_KEY` 时，不要只把变量名改掉。应立即从前端环境中移除该值、撤销或轮换已经暴露的密钥、配置正确的 anon key，再重新部署。anon key 公开并不表示 RLS 可以关闭；用户数据表和私有附件仍必须由 RLS 与 Storage policy 隔离。

## 配置附件和 Edge Functions

不同能力需要不同云端路径：

| 能力 | 需要配置什么 | 不配置时表现 |
| --- | --- | --- |
| 附件上传 | 私有 bucket `attachments`、Storage policy | 附件上传或跨设备读取失败 |
| 语音转写 | `transcribe` Edge Function、Groq Secret | 文字记录可用，语音不能转文字 |
| Android 小组件 | `widget-register`、`widget-summary`、`widget-notify` | 小组件摘要或刷新不可用 |
| FCM dirty push | Android `google-services.json`、FCM Secrets | 退化为手动、解锁或周期刷新 |
| 病毒扫描 | 对应扫描函数或服务端检查路径 | 高风险上传能力不完整 |

转写问题可以继续看 [transcribe-troubleshooting.md](../../transcribe-troubleshooting.md)。

## 第一次同步验收

配置后不要直接导入大量真实数据。请用小项目验收：

1. 在设备 A 登录。
2. 创建一个测试项目和两个测试任务。
3. 等待同步状态稳定。
4. 在设备 B 或另一个浏览器用户资料里登录同一账户。
5. 确认测试项目出现。
6. 在设备 B 修改一个任务标题。
7. 回到设备 A，确认修改能被看到。
8. 如果配置了附件，上传一个小文本文件并在另一端打开。
9. 如果配置了语音转写，录一条很短的测试语音。

只有这些检查通过，才说明云端基础路径可以承载真实数据。

## 常见误解

| 误解 | 正确认知 |
| --- | --- |
| 页面变了就说明已经云同步 | 页面变化只说明本地状态更新，同步状态要另外确认 |
| anon key 是秘密，不能放前端 | anon key 是公开 key，安全靠 RLS 和策略 |
| 关闭 RLS 可以省事 | 关闭 RLS 会破坏用户隔离，不应作为正式方案 |
| 在浏览器本地写 `.env.local` 能修复已部署网站 | 本地环境文件只影响本地构建；已部署实例必须由拥有托管权限的人修改变量并重新发布 |
| 只要不再显示配置帮助就说明数据安全 | 配置帮助只覆盖一部分校验；还要完成登录、双设备同步、RLS 和附件访问验证 |
| 上传附件只要前端能选文件就行 | 还需要私有 bucket、权限、类型校验和可选病毒扫描 |
| 两台设备离线改同一任务一定能自动合并 | NanoFlow 使用 LWW 思路，可能发生覆盖或冲突 |

## 下一步

- 理解同步规则：[同步与冲突处理](../03-data-sync-safety/02-sync-and-conflicts.md)。
- 部署私有实例：[私有部署](../04-deploy-operate/01-private-deployment.md)。
- 运维 Supabase：[Supabase 运维](../04-deploy-operate/02-supabase-operations.md)。
