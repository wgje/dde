
-- ============================================================
-- Migration: remove_cloud_backup_infrastructure
-- 目的：移除 Supabase 云端备份全部基础设施
-- 原因：项目未使用 Supabase Pro，云端存储不可用
-- 保留：本地备份(File System API) + 手动导出导入
-- 注意：storage.objects 中的遗留文件需通过 Supabase Dashboard 手动清理
-- ============================================================

-- 1. 移除 cron 定时任务
SELECT cron.unschedule('nanoflow-backup-full');
SELECT cron.unschedule('nanoflow-backup-incremental');
SELECT cron.unschedule('nanoflow-backup-cleanup');

-- 2. 移除 storage policy（bucket 内的文件需要通过 Dashboard 手动清空）
DROP POLICY IF EXISTS "backups_service_role_all" ON storage.objects;

-- 3. 移除 triggers
DROP TRIGGER IF EXISTS backup_metadata_updated_at ON backup_metadata;
DROP TRIGGER IF EXISTS trg_backup_restore_history_updated_at ON backup_restore_history;

-- 4. 移除 RLS policies
DROP POLICY IF EXISTS backup_metadata_delete ON backup_metadata;
DROP POLICY IF EXISTS backup_metadata_insert ON backup_metadata;
DROP POLICY IF EXISTS backup_metadata_select ON backup_metadata;
DROP POLICY IF EXISTS backup_metadata_update ON backup_metadata;
DROP POLICY IF EXISTS backup_restore_history_delete ON backup_restore_history;
DROP POLICY IF EXISTS backup_restore_history_insert ON backup_restore_history;
DROP POLICY IF EXISTS backup_restore_history_select ON backup_restore_history;
DROP POLICY IF EXISTS backup_restore_history_update ON backup_restore_history;
DROP POLICY IF EXISTS backup_encryption_keys_service_role_all ON backup_encryption_keys;

-- 5. 移除表（按 FK 依赖顺序，CASCADE 也处理隐含引用）
DROP TABLE IF EXISTS backup_restore_history CASCADE;
DROP TABLE IF EXISTS backup_metadata CASCADE;
DROP TABLE IF EXISTS backup_encryption_keys CASCADE;

-- 6. 移除备份相关函数
DROP FUNCTION IF EXISTS apply_backup_schedules();
DROP FUNCTION IF EXISTS cleanup_expired_backups();
DROP FUNCTION IF EXISTS get_backup_schedule();
DROP FUNCTION IF EXISTS get_backup_stats();
DROP FUNCTION IF EXISTS get_latest_completed_backup();
DROP FUNCTION IF EXISTS invoke_internal_edge_function(text, jsonb);
DROP FUNCTION IF EXISTS mark_expired_backups();
DROP FUNCTION IF EXISTS update_backup_metadata_updated_at();
DROP FUNCTION IF EXISTS update_backup_schedule(text, text, text);

-- 7. 清理 app_config 中的备份配置
DELETE FROM app_config WHERE key LIKE 'backup.%';
;
