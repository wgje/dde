---
title: Edge Functions
status: canonical
audience: operator
last_verified: 2026-06-13
category: deploy-operate
source_paths:
  - README.md
  - supabase/functions/
  - supabase/functions/_shared/
  - docs/transcribe-troubleshooting.md
  - scripts/supabase-cli.cjs
---

# Edge Functions

Edge Functions 用来承载不能放在浏览器里的逻辑，例如第三方 API 代理、语音转写、小组件摘要、服务端校验和上传安全。

## 本文内容

- [哪些功能依赖 Edge Functions](#哪些功能依赖-edge-functions)
- [部署函数](#部署函数)
- [配置 Secrets](#配置-secrets)
- [共享 helper](#共享-helper)
- [部署后怎么验收](#部署后怎么验收)
- [常见问题](#常见问题)
- [下一步](#下一步)

## 哪些功能依赖 Edge Functions

| 功能 | 函数或函数组 | 为什么不能只放前端 |
| --- | --- | --- |
| 语音转写 | `transcribe` | Groq API Key 不能暴露给浏览器 |
| 小组件注册 | `widget-register` | 需要服务端记录设备/实例状态 |
| 小组件摘要 | `widget-summary` | 需要按用户权限读取摘要数据 |
| 小组件通知 | `widget-notify` | FCM private key 必须服务端保存 |
| 病毒扫描 | 上传扫描相关函数 | 文件安全检查需要服务端路径 |

## 部署函数

常用部署入口：

```bash
npm run supabase:functions:deploy
```

本地调试：

```bash
npm run supabase:functions:serve
```

如果只部署单个函数，请沿用仓库里的 Supabase CLI 包装方式，避免本地 CLI 版本和项目脚本不一致。

## 配置 Secrets

通过 Supabase 设置服务端密钥：

```bash
npm run supabase:secrets:set
```

常见 Secret：

- Groq API Key；
- FCM project ID；
- FCM client email；
- FCM private key；
- 其他服务端 provider key。

Secret 设置后，至少调用一次对应功能，确认函数真的能读到。

## 共享 helper

共享函数代码应放在：

```text
supabase/functions/_shared/
```

适合放这里的逻辑：

- CORS；
- 认证；
- 用户身份校验；
- 错误响应；
- 输入校验；
- 日志格式。

如果改了 shared helper，要测试所有引用它的函数。

## 部署后怎么验收

1. 在应用里触发对应功能。
2. 看浏览器网络请求是否打到 `/functions/v1/<name>`。
3. 看 Supabase function logs。
4. 确认响应里没有泄露 Secret。
5. 故意缺少可选配置时，确认前端有合理降级。
6. 用另一个用户确认不能读到不属于自己的数据。

## 常见问题

| 问题 | 先检查 |
| --- | --- |
| 语音转写失败 | `transcribe` 是否部署、Groq Secret 是否存在 |
| 小组件无摘要 | `widget-summary`、登录态、RLS |
| CORS 报错 | 函数是否返回正确 headers |
| 本地能用线上不能用 | Secret 是否只配在本地，没有配到线上 Supabase |

## 下一步

- 转写排障：[transcribe-troubleshooting.md](../../transcribe-troubleshooting.md)。
- 生产问题：[生产排障](04-production-troubleshooting.md)。
