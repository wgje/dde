---
title: 私有部署
status: canonical
audience: operator
last_verified: 2026-11-09
category: deploy-operate
source_paths:
  - README.md
  - docs/deploy-private-instance.md
  - docs/cloudflare-migration-plan.md
  - .env.template
  - scripts/set-env.cjs
  - scripts/validate-env.cjs
  - src/app/shared/modals/config-help-modal.component.ts
  - src/services/supabase-client-configuration.ts
  - vercel.json
  - .github/workflows/vercel-prebuilt-recovery.yml
  - netlify.toml
  - railway.json
---

# 私有部署

NanoFlow 当前主线适合部署成私人使用的 PWA。前端可以部署到静态托管平台，云端数据和函数能力由 Supabase 提供。

## 本文内容

- [选择部署平台](#选择部署平台)
- [暂停 Vercel Git 自动部署](#暂停-vercel-git-自动部署)
- [先确认谁该修复配置](#先确认谁该修复配置)
- [配置前端环境](#配置前端环境)
- [配置错误的排查顺序](#配置错误的排查顺序)
- [构建前检查](#构建前检查)
- [文档随功能更新的门禁](#文档随功能更新的门禁)
- [部署后验收](#部署后验收)
- [回滚时注意什么](#回滚时注意什么)
- [下一步](#下一步)

## 选择部署平台

| 平台 | 当前定位 | 适合情况 |
| --- | --- | --- |
| Cloudflare Pages | 推荐主路径 | 想用稳定静态托管和现有迁移方案 |
| Vercel | 回滚或备选 | 已经有 Vercel 项目或需要快速恢复 |
| Netlify | 备选静态托管 | 已熟悉 Netlify 配置 |
| Railway | 特定部署备选 | 需要沿用已有 Railway 配置 |

建议只选一个主平台长期维护。多个平台同时跑会让环境变量、缓存、域名和回滚排查更复杂。

## 暂停 Vercel Git 自动部署

当前仓库在 `vercel.json` 中设置 `git.deploymentEnabled: false`，暂停
Vercel Git integration 对所有分支的自动部署。这个开关不会删除 Vercel
项目，也不会阻止手动 CLI 发布或 Dashboard 发布。

需要恢复 Vercel 时，优先使用 `.github/workflows/vercel-prebuilt-recovery.yml`
的手动运行入口：选择 `deploy=true`，并将确认值设为
`DEPLOY_VERCEL_PREBUILT`。workflow 会先构建和校验 prebuilt artifact，随后
执行 `vercel deploy --prebuilt --prod`。不要把
`scripts/vercel-ignore-step.sh` 当成关闭 Git 自动部署的开关；它只决定一次
构建是否可以被 Vercel 忽略。

## 先确认谁该修复配置

应用里的“Supabase 配置指南”是给实例操作者的诊断入口，不是普通使用者的自助密钥配置工具。它在前端发现敏感密钥或 URL/key 项目不一致，并进入本地离线回退时出现。使用者只能保护当前浏览器中的本地数据并联系你；真正的修复必须在仓库或托管平台的环境变量边界完成。

处理这类报告时，先向使用者确认三件事：访问的是哪个域名、提示何时出现、当前浏览器是否有未导出的本地工作。不要让使用者粘贴密钥或清除浏览器缓存来“试试”。对使用者的安全操作说明见 [云同步配置](../01-get-started/04-cloud-sync-setup.md#出现配置帮助时先判断角色)。

## 配置前端环境

前端部署环境只需要同一个 Supabase 项目的两项公开连接值：

```bash
NG_APP_SUPABASE_URL=https://your-project.supabase.co
NG_APP_SUPABASE_ANON_KEY=your-anon-key
```

本地验证时，把它们放进 `.env.local`，然后运行：

```bash
npm run config
npm start
```

发布到托管平台时，在平台项目的构建环境中设置同名变量，并触发新的构建和部署。NanoFlow 是静态前端，发布完成的 JavaScript 不会读取你之后才修改的本地 `.env.local`；部署面板里更新变量后也需要重新构建。

前端环境中不要配置：

- service role key；
- Groq API Key；
- FCM private key；
- Sentry auth token；
- 其他服务端密钥。

这些值必须进入 Supabase Secrets 或平台服务端 Secret。

Supabase anon key 可以公开给浏览器，但不是安全边界。它必须与 URL 来自同一个 Supabase 项目，数据库和 Storage bucket 必须保持 RLS/policy 隔离。任何能绕过 RLS 的 service role 或 secret key 一旦进入前端构建，都应视为已暴露：移除、撤销或轮换、重新发布，然后检查访问日志和策略。

## 配置错误的排查顺序

不要只替换一项变量就立即让真实用户重试。按下面顺序处理，能避免把本地离线状态误认为云端数据问题。

1. 在 Supabase 项目设置中复制 Project URL 和 anon public key，确认两者来自同一个项目。
2. 检查值不是 `YOUR_SUPABASE_URL`、`YOUR_SUPABASE_ANON_KEY` 之类的占位符，也不是 service role、secret、private 或 admin 类型的敏感 key。
3. 在本地 `.env.local` 中运行 `npm run config` 和 `npm start`；确认应用不再进入配置错误的离线回退。
4. 将同一对公开值写入目标托管平台的构建环境，触发新构建，记录部署版本和时间。
5. 用无缓存窗口或新的浏览器资料打开该部署；不要用仍持有旧资源的单一标签页作为唯一证据。
6. 完成 [云同步配置](../01-get-started/04-cloud-sync-setup.md#第一次同步验收) 中的双设备验收，再通知使用者恢复正常编辑。

| 现象 | 首先检查什么 | 不要怎么做 |
| --- | --- | --- |
| 本地开发进入离线模式 | `.env.local` 是否缺失、仍为占位符；开发服务器是否已重启 | 不要把 service role key 当作“更有效的 key”粘进去 |
| 应用提示 URL 与 anon key 不一致 | 两项是否来自同一 Supabase 项目 | 不要混用测试项目 URL 和生产项目 key |
| 应用提示敏感密钥 | 立即移除前端中的 service/secret key，轮换已暴露凭据 | 不要仅把变量重命名为 `ANON_KEY` |
| 托管变量已改但页面仍异常 | 是否真的触发了新构建、是否仍加载旧部署或缓存资源 | 不要要求使用者清浏览器数据作为部署修复 |

## 构建前检查

本地先跑：

```bash
npm run build
```

如果你维护的是生产环境配置，并且本地有完整生产变量，可进一步跑：

```bash
npm run build:strict
```

构建前确认：

1. 环境变量指向正确 Supabase 项目。
2. 当前分支没有不确定的实验改动。
3. `context7` 和使用手册文档门禁已通过。
4. 如果本次包含 schema 变化，迁移和类型也已处理。

## 文档随功能更新的门禁

部署前应运行：

```bash
npm run docs:validate
```

这个命令现在同时检查三件事：

1. Context7 机器文档是否仍然完整。
2. 中文使用手册的目录、链接、标题和正文质量是否合格。
3. 当前代码改动是否同步更新了覆盖表中绑定的用户文章。

如果最后一项失败，不要只改命令或跳过检查。根据错误输出找到对应的 handbook 页面，补充用户能观察到的行为、限制、恢复方法和验收步骤。

## 部署后验收

部署完成后，不要只看首页能打开。按顺序验收：

1. 打开根路径。
2. 刷新任意应用内路由，确认不会 404。
3. 登录测试用户。
4. 创建测试项目和任务。
5. 刷新浏览器确认仍能看到。
6. 在另一台设备或浏览器资料里登录同一账户。
7. 确认同步出现。
8. 测试附件和 Edge Function 功能。
9. 检查浏览器控制台和平台日志。

## 回滚时注意什么

回滚不只是重新部署旧前端。你还要确认：

- 数据库迁移是否已经执行；
- 新前端是否写入了旧版本不认识的字段；
- Edge Function 是否也需要回滚；
- Storage policy 是否变化；
- 用户是否已经创建了新格式数据。

如果只是前端样式或小功能问题，回滚前端通常够用。如果涉及 schema 或同步，先导出数据再做回滚决策。

## 下一步

- 准备 Supabase：[Supabase 运维](02-supabase-operations.md)。
- 部署函数：[Edge Functions](03-edge-functions.md)。
