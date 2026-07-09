---
title: 安全与隐私
status: canonical
audience: user, operator
last_verified: 2026-06-13
category: data-sync-safety
source_paths:
  - AGENTS.md
  - README.md
  - docs/context7/contracts/security-contract.md
  - scripts/contracts/check-secrets.cjs
  - supabase/migrations/
---

# 安全与隐私

NanoFlow 面向个人使用，但它仍然会处理任务内容、附件、语音、外部链接、本地路径和可能的知识库锚点。个人项目也需要清晰的安全边界。

## 本文内容

- [哪些密钥不能进前端](#哪些密钥不能进前端)
- [数据隔离靠什么](#数据隔离靠什么)
- [Markdown 和链接安全](#markdown-和链接安全)
- [附件上传安全](#附件上传安全)
- [哪些数据只应留在本机](#哪些数据只应留在本机)
- [部署前检查表](#部署前检查表)
- [下一步](#下一步)

## 哪些密钥不能进前端

前端可以配置：

- Supabase URL；
- Supabase anon key；
- 明确设计为公开的前端开关。

前端绝对不应该配置：

- Supabase service role key；
- Groq API Key；
- FCM private key；
- Sentry auth token；
- 任何第三方服务的服务端密钥。

这些密钥应放在 Supabase Secrets 或部署平台的服务端 Secret 里。

## 数据隔离靠什么

云端数据隔离主要靠 RLS 和 user scope。部署前请确认：

1. 用户数据表已经启用 RLS。
2. policy 使用 `user_id` 或等价身份字段隔离数据。
3. Storage bucket 是私有的。
4. RPC 或 Edge Function 没有绕过用户隔离。
5. 如果多个账号会使用同一实例，用两个账号测试能否互相看到数据。

不要通过“隐藏 UI 按钮”来当安全策略。安全必须在服务端生效。

## Markdown 和链接安全

任务正文支持 Markdown 和链接，因此必须注意：

- 渲染用户内容时要消毒，防止 XSS。
- 本地路径和 `file:` 链接应走受控处理。
- 网络共享路径和可执行文件不应被误触直接启动。
- 外部链接应该保持清晰，不要伪装成内部任务链接。

如果你只是普通使用者，最重要的是：不要在任务正文里粘贴不可信 HTML，也不要随便打开陌生路径。

## 附件上传安全

附件属于高风险输入。完整路径应包含：

- 私有 bucket；
- 用户鉴权；
- 文件类型检查；
- 大小和超时限制；
- 病毒扫描或隔离策略；
- 上传失败后的明确提示。

不要为了“方便预览”把附件 bucket 改成公开。

## 哪些数据只应留在本机

这些数据通常不应该进入 Supabase：

- 思源本机 token；
- 本地 Relay 配置；
- 桌面备份目录句柄；
- 浏览器本地缓存预览；
- 尚未同步的离线语音原始缓存；
- 只对当前设备有意义的临时状态。

同步越多不一定越安全。该本地隔离的凭证就应该留在本地。

## 部署前检查表

上线前检查：

1. 前端没有服务端密钥。
2. Supabase RLS 已启用。
3. Storage bucket 是私有的。
4. Edge Function Secret 已配置在服务端。
5. Markdown 渲染没有绕过消毒逻辑。
6. 附件上传有限制和失败提示。
7. 至少做过一次备份和恢复演练。

## 下一步

- 配置云端：[Supabase 运维](../04-deploy-operate/02-supabase-operations.md)。
- 保护数据：[备份与恢复](03-backup-and-restore.md)。
