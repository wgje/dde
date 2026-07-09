---
title: 数据、同步与安全
status: canonical
audience: user, operator
last_verified: 2026-06-13
category: data-sync-safety
source_paths:
  - README.md
  - src/app/core/services/simple-sync.service.ts
  - src/app/core/services/sync/
  - src/services/
  - supabase/migrations/
---

# 数据、同步与安全

这一组文档解释 NanoFlow 如何保存数据、怎样同步、多设备冲突如何理解、什么时候备份、哪些隐私和密钥边界不能碰。正式使用前，至少要读懂“本地已保存”和“云端已同步”不是同一件事。

## 本文内容

- [推荐阅读顺序](#推荐阅读顺序)
- [必须先记住的原则](#必须先记住的原则)
- [什么时候最容易出问题](#什么时候最容易出问题)
- [高风险操作前检查表](#高风险操作前检查表)
- [下一步](#下一步)

## 推荐阅读顺序

1. [离线优先模型](01-offline-first-model.md)：先理解本地先写、后台同步。
2. [同步与冲突处理](02-sync-and-conflicts.md)：再理解多设备和 LWW。
3. [备份与恢复](03-backup-and-restore.md)：最后建立导出、附件、桌面备份习惯。
4. [安全与隐私](04-security-and-privacy.md)：部署或上传附件前必须读。

## 必须先记住的原则

| 原则 | 含义 |
| --- | --- |
| 本地先写 | 操作先更新本机状态和界面 |
| 后台同步 | 有云端配置时再把变更推送出去 |
| 同步可能排队 | 网络、权限或云端错误会让写入进入重试 |
| LWW 不是智能合并 | 同一实体多端修改可能按时间戳覆盖 |
| 备份不是多余的 | 导出和恢复是防止误操作的最后保护 |
| 密钥不能进前端 | 第三方 API key 和 service role key 必须留在服务端 |

## 什么时候最容易出问题

常见风险场景：

- 在两台设备离线编辑同一个任务；
- 浏览器里有待同步内容时清理站点数据；
- 批量删除任务前没有导出；
- 导入旧数据后立刻让云同步覆盖；
- 上传附件但 Storage 或 RLS 配错；
- Edge Function 缺 Secret，却反复重试语音转写；
- 把服务端密钥误放进前端环境变量；
- 以为 Black Box 语音一定已经转写成功，提前删除原记录。

## 高风险操作前检查表

在做下面操作前，请先检查：

| 操作 | 先做什么 |
| --- | --- |
| 批量删除 | 导出 JSON，确认恢复入口可用 |
| 导入项目 | 先导出现有项目，避免覆盖后无回退 |
| 清浏览器数据 | 确认本地数据已导出或云端已同步 |
| 换设备 | 在旧设备导出，在新设备确认同步或导入 |
| 改 Supabase schema | 备份数据库，确认迁移和类型生成 |
| 开启附件 | 确认私有 bucket 和权限 |
| 开启语音转写 | 确认 Edge Function、Secret、额度 |

## 下一步

- 先理解保存机制：[离线优先模型](01-offline-first-model.md)。
- 需要多设备：读 [同步与冲突处理](02-sync-and-conflicts.md)。
- 准备正式使用：读 [备份与恢复](03-backup-and-restore.md)。
