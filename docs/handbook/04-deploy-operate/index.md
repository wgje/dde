---
title: 部署与运维
status: canonical
audience: operator
last_verified: 2026-06-13
category: deploy-operate
source_paths:
  - README.md
  - docs/deploy-private-instance.md
  - docs/cloudflare-migration-plan.md
  - supabase/functions/
  - supabase/migrations/
---

# 部署与运维

这一组文档面向自己部署 NanoFlow 私有实例的人。你需要同时关心前端托管、Supabase、Storage、Edge Functions、密钥、RLS、备份和生产问题排查。

## 本文内容

- [推荐部署顺序](#推荐部署顺序)
- [每篇文档解决什么](#每篇文档解决什么)
- [部署前必须确认](#部署前必须确认)
- [上线后的验收顺序](#上线后的验收顺序)
- [下一步](#下一步)

## 推荐部署顺序

1. 先读 [私有部署](01-private-deployment.md)，选择前端托管平台。
2. 再读 [Supabase 运维](02-supabase-operations.md)，准备数据库、RLS、Storage 和类型。
3. 需要语音、附件扫描或小组件时，继续读 [Edge Functions](03-edge-functions.md)。
4. 第一次上线后，把 [生产排障](04-production-troubleshooting.md) 放在旁边。

## 每篇文档解决什么

| 文档 | 适合什么时候读 |
| --- | --- |
| [私有部署](01-private-deployment.md) | 选择 Cloudflare Pages、Vercel、Netlify、Railway，并做上线验收 |
| [Supabase 运维](02-supabase-operations.md) | 处理数据库、RLS、Auth、Storage、类型生成 |
| [Edge Functions](03-edge-functions.md) | 部署语音转写、小组件、病毒扫描和共享 helper |
| [生产排障](04-production-troubleshooting.md) | 线上打不开、同步异常、上传失败、函数报错时按顺序排查 |

## 部署前必须确认

部署不是只把前端静态文件传上去。正式使用前至少确认：

- 前端环境变量指向正确 Supabase 项目；
- Supabase schema 已执行；
- RLS 已启用；
- `attachments` bucket 是私有的；
- Edge Function Secret 不在前端；
- 生产环境能登录；
- 至少创建过一个测试项目；
- 备份和恢复路径可用。

## 上线后的验收顺序

上线后按这个顺序检查：

1. 打开站点首页，确认没有白屏。
2. 刷新页面，确认路由 fallback 正常。
3. 登录测试账户。
4. 创建测试项目和任务。
5. 刷新浏览器，确认本地状态和云端状态一致。
6. 在第二个浏览器资料或设备登录，确认同步。
7. 上传一个小附件，确认另一端能看到。
8. 调用一个 Edge Function-backed 功能，例如语音转写或小组件摘要。
9. 检查日志里没有密钥泄露。

## 下一步

- 先部署前端：读 [私有部署](01-private-deployment.md)。
- 准备后端：读 [Supabase 运维](02-supabase-operations.md)。
- 出现线上问题：读 [生产排障](04-production-troubleshooting.md)。
