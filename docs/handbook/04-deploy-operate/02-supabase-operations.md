---
title: Supabase 运维
status: canonical
audience: operator
last_verified: 2026-06-13
category: deploy-operate
source_paths:
  - README.md
  - package.json
  - scripts/init-supabase.sql
  - scripts/supabase-cli.cjs
  - supabase/migrations/
  - src/types/supabase.ts
---

# Supabase 运维

Supabase 为 NanoFlow 提供登录、PostgreSQL、私有 Storage、Edge Functions 和数据库类型。只要开启云同步，就必须把 Supabase 当成正式数据系统维护。

## 本文内容

- [Supabase 负责哪些能力](#supabase-负责哪些能力)
- [数据库和迁移](#数据库和迁移)
- [Storage 附件桶](#storage-附件桶)
- [Auth 和 RLS](#auth-和-rls)
- [生成数据库类型](#生成数据库类型)
- [日常运维建议](#日常运维建议)
- [下一步](#下一步)

## Supabase 负责哪些能力

| 能力 | Supabase 组件 |
| --- | --- |
| 登录 | Auth |
| 项目和任务同步 | PostgreSQL tables、RLS、RPC |
| 附件 | Storage 私有 bucket |
| 语音转写代理 | Edge Function |
| Android 小组件摘要 | Edge Functions |
| 服务端密钥 | Supabase Secrets |

如果其中一块没配置，对应功能就不应该被视为可用。

## 数据库和迁移

常用命令：

```bash
npm run supabase:link
npm run supabase:db:push
```

本地 Supabase：

```bash
npm run supabase:start
npm run supabase:status
```

注意：

- schema 改动应该走迁移，不要只在控制台手动改。
- 生产数据迁移前先备份。
- 改字段后要检查同步查询是否包含必要字段。
- `content` 这类用户可见字段不能在同步中漏掉。

## Storage 附件桶

NanoFlow 期望存在私有 bucket：

```text
attachments
```

检查项：

1. bucket 不是 public。
2. 登录用户只能访问自己的附件。
3. 上传有类型和大小限制。
4. 有失败提示。
5. 如果启用病毒扫描，扫描失败时有隔离或拒绝策略。

不要为了快速预览把 bucket 改公开。

## Auth 和 RLS

RLS 是云同步安全的核心。请确认：

- 所有用户数据表启用 RLS；
- policy 通过 `user_id` 或等价身份隔离；
- RPC 没有绕过用户权限；
- Edge Function 调用也校验当前用户；
- 两个不同测试账户不能互相看到数据。

如果 RLS 配错，前端 UI 再谨慎也不能保证数据安全。

## 生成数据库类型

schema 变化后运行：

```bash
npm run db:types
```

然后检查：

- `src/types/supabase.ts` 是否变化；
- 领域模型是否需要同步字段；
- 同步服务是否读写了新字段；
- 文档是否说明了新字段含义。

## 日常运维建议

- 定期导出或备份 Supabase 数据。
- Edge Function Secret 轮换后做一次功能验收。
- 迁移和前端发布尽量成对规划。
- 生产排障前先确认当前环境指向哪个 Supabase project。

## 下一步

- 部署函数：[Edge Functions](03-edge-functions.md)。
- 排查线上问题：[生产排障](04-production-troubleshooting.md)。
