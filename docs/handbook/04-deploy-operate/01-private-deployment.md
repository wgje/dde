---
title: 私有部署
status: canonical
audience: operator
last_verified: 2026-06-13
category: deploy-operate
source_paths:
  - README.md
  - docs/deploy-private-instance.md
  - docs/cloudflare-migration-plan.md
  - vercel.json
  - netlify.toml
  - railway.json
---

# 私有部署

NanoFlow 当前主线适合部署成私人使用的 PWA。前端可以部署到静态托管平台，云端数据和函数能力由 Supabase 提供。

## 本文内容

- [选择部署平台](#选择部署平台)
- [配置前端环境](#配置前端环境)
- [构建前检查](#构建前检查)
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

## 配置前端环境

前端部署环境通常需要：

```bash
NG_APP_SUPABASE_URL=https://your-project.supabase.co
NG_APP_SUPABASE_ANON_KEY=your-anon-key
```

不要配置：

- service role key；
- Groq API Key；
- FCM private key；
- Sentry auth token；
- 其他服务端密钥。

这些值必须进入 Supabase Secrets 或平台服务端 Secret。

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
