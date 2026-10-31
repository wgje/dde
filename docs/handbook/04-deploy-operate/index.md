---
title: 部署与运维
status: canonical
audience: operator
last_verified: 2026-07-15
category: deploy-operate
source_paths:
  - README.md
  - package.json
  - docs/deploy-private-instance.md
  - docs/cloudflare-migration-plan.md
  - supabase/functions/
  - supabase/migrations/
  - scripts/validate-env.cjs
---

# 部署与运维

这一组文档面向自己部署 NanoFlow 私有实例的人。你需要同时关心前端托管、Supabase、Storage、Edge Functions、密钥、RLS、备份和生产问题排查。

部署的目标不是让站点“能打开”就结束，而是让正确的账号能安全读写自己的数据、附件不公开、服务端秘密不出现在浏览器、失败时仍能保留恢复证据。把上线当作一条有顺序的验证链，而不是把环境变量填完后的一次性发布。

## 本文内容

- [推荐部署顺序](#推荐部署顺序)
- [先分清谁能做什么](#先分清谁能做什么)
- [每篇文档解决什么](#每篇文档解决什么)
- [部署前必须确认](#部署前必须确认)
- [按任务选择正确的运行册](#按任务选择正确的运行册)
- [上线后的验收顺序](#上线后的验收顺序)
- [发生生产问题时先保护什么](#发生生产问题时先保护什么)
- [变更、回滚与证据](#变更回滚与证据)
- [下一步](#下一步)

## 推荐部署顺序

1. 先读 [私有部署](01-private-deployment.md)，选择前端托管平台。
2. 再读 [Supabase 运维](02-supabase-operations.md)，准备数据库、RLS、Storage 和类型。
3. 需要语音、附件扫描或小组件时，继续读 [Edge Functions](03-edge-functions.md)。
4. 第一次上线后，把 [生产排障](04-production-troubleshooting.md) 放在旁边。

每完成一层，再开始下一层。前端部署成功并不能证明 RLS、Storage、函数、附件或跨设备同步已经安全；Supabase schema 已更新也不能证明浏览器还在使用匹配的环境配置。

## 先分清谁能做什么

| 角色 | 可以安全做的事 | 不应自行做的事 |
| --- | --- | --- |
| 普通使用者 | 使用应用、导出自己的数据、报告状态和复现步骤 | 修改 RLS、部署函数、输入服务端秘密、清理生产数据 |
| 私有实例操作者 | 管理托管环境、Supabase 项目、迁移、Storage、函数和生产验证 | 把生产权限当作调试捷径，绕过备份或隐私边界 |
| 持有秘密/基础设施权限的人 | 设置服务端 Secret、调整托管或云端权限、执行受控回滚 | 把秘密写进 `NG_APP_*`、源码、截图、日志或浏览器构建产物 |
| 维护者 | 修改代码、脚本、文档与验证门禁 | 在不确认 active project 的情况下执行破坏性云端命令 |

一个问题有时既是使用者问题又是操作者问题。比如附件上传失败，使用者可以保留文件和错误提示；bucket、RLS、函数 Secret 或部署日志的修改则应由正确权限的操作者完成。

## 每篇文档解决什么

| 文档 | 适合什么时候读 |
| --- | --- |
| [私有部署](01-private-deployment.md) | 选择 Cloudflare Pages、Vercel、Netlify、Railway，并做上线验收 |
| [Supabase 运维](02-supabase-operations.md) | 处理数据库、RLS、Auth、Storage、类型生成 |
| [Edge Functions](03-edge-functions.md) | 部署语音转写、小组件、病毒扫描和共享 helper |
| [生产排障](04-production-troubleshooting.md) | 线上打不开、同步异常、上传失败、函数报错时按顺序排查 |

## 按任务选择正确的运行册

| 你准备做什么 | 先读 | 开始前必须确认 | 做完后要看到的证据 |
| --- | --- | --- | --- |
| 第一次发布 Web 应用 | [私有部署](01-private-deployment.md) | 托管平台、环境变量、生产 Supabase 项目、路由与 PWA 资源 | 正确 URL 能打开、刷新不丢路由、测试账户可登录 |
| 创建或接入 Supabase 项目 | [Supabase 运维](02-supabase-operations.md) | 项目身份、数据库、RLS、Auth、私有 Storage 和备份边界 | 测试账户仅能读写自己的数据，生成类型与 schema 匹配 |
| 修改数据库、RLS、RPC、bucket 或数据保留策略 | [Supabase 运维](02-supabase-operations.md) | 当前 linked project、迁移影响面、备份和回滚方案 | 迁移/权限验证完成，调用方与类型、文档同步更新 |
| 部署语音、附件扫描、小组件或其他函数能力 | [Edge Functions](03-edge-functions.md) | 函数是否处在当前运行册、所需 Secret、鉴权/CORS/调用方 | 有权限的冒烟请求成功，秘密未暴露，失败日志可定位 |
| 做前端环境、构建或发布产物检查 | [私有部署](01-private-deployment.md) | 浏览器配置与服务端秘密的边界 | `npm run validate-env:prod` 与适用构建路径均通过 |
| 线上出现白屏、登录、同步、附件、函数或 Android 问题 | [生产排障](04-production-troubleshooting.md) | 当前影响范围、账号、时间、部署版本和是否有未同步数据 | 先完成分流和证据保全，再执行最小恢复动作 |

不要把“我有权限”理解为“这条命令现在适合执行”。对未知项目运行 `reset`、迁移推送、函数部署或 Secret 更新可能比故障本身造成更大影响；先确认项目身份和备份，再继续。

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

在把真实用户数据写入新实例前，再做一次生产边界检查：匿名浏览器不应获得私有数据；普通用户不应看到其他用户的记录或附件；浏览器配置中不应包含 service role、第三方私钥或部署令牌；错误日志和截图也不应携带这些内容。

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

验收时使用专门的测试账户和小附件，不要在刚上线的实例里以真实数据试验恢复、删除、导入或 RLS 边界。每一项通过后记录 URL、账户类型、时间和结果；当后续问题只在特定设备或版本出现时，这些记录能缩小排查范围。

## 发生生产问题时先保护什么

生产问题的第一步通常不是“重启一切”。先确认是否有数据继续写入、是否存在待同步本地状态、影响是否限于一个账户或一个部署版本。

| 现象 | 先保护 | 先读 | 暂时不要做 |
| --- | --- | --- |
| 首屏白屏、路由刷新失败或版本更新异常 | 当前部署版本、浏览器控制台/网络证据、受影响 URL | [生产排障](04-production-troubleshooting.md) | 立刻删除旧部署、清空所有缓存或替换环境变量 |
| 登录、权限或看到不该出现的数据 | 账号、角色、项目身份、时间和最小复现 | [Supabase 运维](02-supabase-operations.md) 与 [生产排障](04-production-troubleshooting.md) | 临时关闭 RLS、把 service role 放进前端或用别人的账号覆盖数据 |
| 同步堆积、stale 冲突或另一端不一致 | 有待同步的浏览器、当前账号、导出和队列状态 | [同步诊断与冲突中心](../03-data-sync-safety/05-sync-diagnostics-and-conflict-center.md) | 清站点数据、两端同时补写或手工删除队列证据 |
| 附件上传、下载、扫描或可见性异常 | 原始文件、附件状态、Storage 路径和请求错误 | [生产排障](04-production-troubleshooting.md) | 公开 bucket、跳过扫描、批量删文件或改为前端高权限访问 |
| Edge Function 调用失败 | 函数名称、请求时间、响应状态、调用账户和部署版本 | [Edge Functions](03-edge-functions.md) | 在客户端打印/复制 Secret，或部署未审查的临时函数 |
| Android 小组件或宿主跳转异常 | 设备版本、登录状态、小组件内容和 Web 端状态 | [生产排障](04-production-troubleshooting.md) | 假定 Web 已通过就直接覆盖原生发布物 |

## 变更、回滚与证据

上线、迁移、函数部署和回滚都应该有可复查的最小记录：

1. **变更是什么。** 记录代码/迁移/函数/环境的版本，以及它影响的用户流程。
2. **执行目标是谁。** 记录托管环境、Supabase 项目或函数部署目标；不要只写“线上”。
3. **前置保护是什么。** 对数据和迁移类变化，记录备份、导出、回滚策略或明确不适用的原因。
4. **验证了什么。** 保留实际运行的校验命令、测试账户、验收路径和退出结果。常见生产前入口是 `npm run validate-env:prod`、适用的构建命令以及 `npm run docs:validate`；具体组合以改动类型为准。
5. **若需要回滚，回到哪个已知状态。** 优先使用已经验证的发布物、迁移策略或文档中的恢复路径，不要在事故现场临时拼凑破坏性命令。

回滚不是“撤销一条命令”这么简单。数据库迁移、附件、浏览器本地状态和后台函数可能已经产生新数据；先读 [生产排障](04-production-troubleshooting.md) 的回滚与保护边界，再决定是否需要更高权限或停写窗口。

## 下一步

- 先部署前端：读 [私有部署](01-private-deployment.md)。
- 准备后端：读 [Supabase 运维](02-supabase-operations.md)。
- 出现线上问题：读 [生产排障](04-production-troubleshooting.md)。
