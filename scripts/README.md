# scripts/ 目录说明

本目录包含 NanoFlow 的 Supabase / 数据维护相关脚本。

## 一键初始化（推荐）

- `init-supabase.sql`
  - 用途：统一的「一次性初始化脚本」，包含当前 NanoFlow 所需的全部数据库对象（表 / RPC / 触发器 / RLS / Realtime / Storage 策略）。
  - 执行时机：新建 Supabase 项目后，在 Dashboard → SQL Editor 中一次性执行。

## 迁移 / 清理 / 维护

- `migrate-to-v2.sql`
  - 旧版项目数据结构迁移到 v2（用于历史数据库升级）。
- `cleanup-v1-data.sql`
  - 清理 v1 遗留数据。
- `purge-deleted-tasks.sql`
  - 回收站/软删除任务的清理相关。
- `cleanup-cron-setup.sql`
  - 为软删除任务/连接与清理日志配置 `pg_cron` 定时任务（运维接线脚本，幂等可重跑）。

## 备份

- `backup-setup.sql`
  - 备份相关表/函数/策略（如有）。
- `backup-cron-setup.sql`
  - 备份相关的 pg_cron 任务配置（需要先启用 `pg_cron` 扩展）。

## 辅助脚本

- `seed-supabase.js`
  - 初始化/填充测试数据（开发用）。
- `set-env.cjs`
  - 环境变量辅助脚本。
- `validate-env.cjs`
  - 环境变量校验。
- `setup-storage-bucket.cjs`
  - Storage 桶初始化辅助（如果使用脚本方式创建桶）。

## legacy/ 目录

旧版/历史脚本（保留用于参考，新项目无需使用）：

- `init-database.sql` - 旧版一次性初始化脚本
- `supabase-setup.sql` - 核心表结构 + RLS（早期版本）
- `storage-setup.sql` - Storage bucket RLS 策略（早期版本）
- `attachment-rpc.sql` - 附件相关 RPC
- `attachment-soft-delete.sql` - 附件软删除
- `add-connection-title.sql` - connections 标题字段补丁

> 说明：如果你只是想让新项目"能跑起来"，优先执行 `init-supabase.sql` 即可。
