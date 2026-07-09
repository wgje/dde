---
title: 生产排障
status: canonical
audience: operator
last_verified: 2026-06-13
category: deploy-operate
source_paths:
  - README.md
  - package.json
  - docs/perf-gate-runbook.md
  - docs/transcribe-troubleshooting.md
  - supabase/functions/
---

# 生产排障

生产问题不要靠猜。先判断问题属于前端部署、浏览器缓存、登录权限、同步、Storage、Edge Function 还是第三方服务，然后按顺序缩小范围。

## 本文内容

- [排障总顺序](#排障总顺序)
- [页面打不开或白屏](#页面打不开或白屏)
- [同步看起来不对](#同步看起来不对)
- [附件上传失败](#附件上传失败)
- [Edge Function 功能失败](#edge-function-功能失败)
- [排障时不要做什么](#排障时不要做什么)
- [下一步](#下一步)

## 排障总顺序

1. 确认访问的是正确域名和最新部署。
2. 确认前端环境变量指向正确 Supabase 项目。
3. 打开浏览器控制台，看是否有 chunk、路由、网络或权限错误。
4. 登录测试账号，确认 Auth 正常。
5. 看 Supabase logs 和 Edge Function logs。
6. 出现数据问题时，先导出再修。
7. 如果最近有迁移，核对前端版本和 schema 是否匹配。

## 页面打不开或白屏

先检查：

- 静态资源是否 404；
- 刷新应用内路由是否 404；
- Service Worker 是否缓存了旧版本；
- 构建是否执行了环境生成；
- 浏览器控制台是否有 JS chunk 加载失败；
- 部署平台是否把所有路由 fallback 到 `index.html`。

如果只是启动慢，不要立刻删功能。先用性能门禁定位是 bundle、字体、启动 shell 还是 Supabase readiness 问题。

## 同步看起来不对

按顺序检查：

1. 当前是否登录正确用户。
2. 当前设备是否在线。
3. 另一台设备是否已经完成上传。
4. 本机是否存在待同步或重试项。
5. Supabase RLS 是否允许当前用户读取。
6. 相关记录的 `updated_at` 是否变化。
7. 同步查询是否包含用户可见字段，例如 `content`。

不要先清浏览器数据。先导出当前本地状态。

## 附件上传失败

检查：

- `attachments` bucket 是否存在；
- bucket 是否私有；
- policy 是否允许当前用户上传和读取；
- 文件类型是否允许；
- 文件大小是否超过限制；
- 上传是否超时；
- 病毒扫描路径是否可用。

如果只是某个文件失败，先换一个很小的 `.txt` 文件测试基础上传路径。

## Edge Function 功能失败

检查：

- 函数是否部署到正确 Supabase 项目；
- 请求路径是否是 `/functions/v1/<name>`；
- CORS 是否正确；
- Secret 是否配置在线上；
- function logs 是否收到请求；
- 前端是否把错误显示给用户；
- 响应是否被 RLS 或身份校验拒绝。

语音转写额外检查 Groq Secret、额度、音频格式和网络。

## 排障时不要做什么

- 不要还没导出就清浏览器数据。
- 不要为了调试关闭 RLS 后忘记恢复。
- 不要把 service role key 放进前端。
- 不要在生产库直接手改大量数据。
- 不要同时让多台设备做恢复操作。
- 不要只看前端日志，忽略 Supabase 和函数日志。

## 下一步

- 修 Supabase：读 [Supabase 运维](02-supabase-operations.md)。
- 修函数：读 [Edge Functions](03-edge-functions.md)。
- 保护数据：读 [备份与恢复](../03-data-sync-safety/03-backup-and-restore.md)。
