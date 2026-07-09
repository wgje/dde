---
title: 云同步配置
status: canonical
audience: user, operator
last_verified: 2026-06-13
category: get-started
source_paths:
  - README.md
  - .env.template
  - scripts/init-supabase.sql
  - supabase/functions/
  - supabase/migrations/
---

# 云同步配置

云同步让 NanoFlow 支持登录、多设备同步、附件、语音转写、小组件和服务端安全策略。它不是第一次试用的必需项，但如果你要长期跨设备使用，就必须认真配置。

## 本文内容

- [什么时候需要云同步](#什么时候需要云同步)
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

前端只应该拿到公开值：

```bash
NG_APP_SUPABASE_URL=https://your-project.supabase.co
NG_APP_SUPABASE_ANON_KEY=your-anon-key
```

配置后运行：

```bash
npm run config
npm start
```

注意：

- Supabase anon key 是前端公开 key，不等于服务端密钥。
- service role key 绝对不能放进前端环境变量。
- Groq、FCM、Sentry 上传 token 等服务端密钥也不能进前端。

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
| 上传附件只要前端能选文件就行 | 还需要私有 bucket、权限、类型校验和可选病毒扫描 |
| 两台设备离线改同一任务一定能自动合并 | NanoFlow 使用 LWW 思路，可能发生覆盖或冲突 |

## 下一步

- 理解同步规则：[同步与冲突处理](../03-data-sync-safety/02-sync-and-conflicts.md)。
- 部署私有实例：[私有部署](../04-deploy-operate/01-private-deployment.md)。
- 运维 Supabase：[Supabase 运维](../04-deploy-operate/02-supabase-operations.md)。
