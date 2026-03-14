# supabase/migrations/archive

此目录用于归档已整合进「统一初始化脚本」的历史迁移文件。

## 为什么归档

NanoFlow 早期通过大量增量迁移逐步完善数据库对象（RLS、索引、tombstone、防复活、purge、病毒扫描、审计日志等）。

为了降低新用户部署门槛，现在推荐通过以下方式初始化：

- 在 Supabase SQL Editor 一次性执行：`scripts/init-supabase.sql`（当前 v3.9.0）

因此，原 `supabase/migrations/` 中的历史迁移文件被移动到本目录保留，便于：

- 回溯历史变更
- 对比/排查线上数据库对象差异
- 参考单个迁移的设计意图

## 当前 migrations 根目录的文件

`supabase/migrations/` 根目录现包含 2026-01 至今的活跃迁移文件（如 `20260226_add_task_planning_fields.sql`）。
这些文件用于 Supabase CLI 迁移流程（`supabase db push`），与 `init-supabase.sql` 的全量初始化互补：

- **新项目**：直接执行 `scripts/init-supabase.sql`，一次性初始化全部对象
- **已有项目升级**：通过 `supabase db push` 应用增量迁移

## 注意

- 改了表/RLS/RPC/触发器/索引/视图 → 必须同步更新 `scripts/init-supabase.sql` + `npm run db:types`
- 活跃迁移文件请在 `supabase/migrations/` 根目录管理，不要放进 archive
- Archive 内的文件已全部整合进 `init-supabase.sql`，**不要对新项目重新执行**