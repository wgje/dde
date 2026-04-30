
-- ============================================================
-- Migration: remove_cloud_backup_infrastructure
-- 目的：移除 Supabase 云端备份全部基础设施
-- 原因：项目未使用 Supabase Pro，云端存储不可用
-- 保留：本地备份(File System API) + 手动导出导入
-- 注意：storage.objects 中的遗留文件需通过 Supabase Dashboard 手动清理
-- ============================================================

-- 1. 移除 cron 定时任务
DO $retired_cloud_backup_cron$
DECLARE
  v_job record;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping retired cloud backup cron cleanup; pg_cron is absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'nanoflow-backup-full',
        'nanoflow-backup-incremental',
        'nanoflow-backup-cleanup'
      )
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;
  END IF;
END
$retired_cloud_backup_cron$;

-- 2. 移除 storage policy（bucket 内的文件需要通过 Dashboard 手动清空）
DROP POLICY IF EXISTS "backups_service_role_all" ON storage.objects;

-- 3/4. 移除 triggers 与 RLS policies。干净库中这些退役表可能从未创建。
DO $retired_cloud_backup_objects$
BEGIN
  IF to_regclass('public.backup_metadata') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS backup_metadata_updated_at ON public.backup_metadata';
    EXECUTE 'DROP POLICY IF EXISTS backup_metadata_delete ON public.backup_metadata';
    EXECUTE 'DROP POLICY IF EXISTS backup_metadata_insert ON public.backup_metadata';
    EXECUTE 'DROP POLICY IF EXISTS backup_metadata_select ON public.backup_metadata';
    EXECUTE 'DROP POLICY IF EXISTS backup_metadata_update ON public.backup_metadata';
  END IF;

  IF to_regclass('public.backup_restore_history') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_backup_restore_history_updated_at ON public.backup_restore_history';
    EXECUTE 'DROP POLICY IF EXISTS backup_restore_history_delete ON public.backup_restore_history';
    EXECUTE 'DROP POLICY IF EXISTS backup_restore_history_insert ON public.backup_restore_history';
    EXECUTE 'DROP POLICY IF EXISTS backup_restore_history_select ON public.backup_restore_history';
    EXECUTE 'DROP POLICY IF EXISTS backup_restore_history_update ON public.backup_restore_history';
  END IF;

  IF to_regclass('public.backup_encryption_keys') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS backup_encryption_keys_service_role_all ON public.backup_encryption_keys';
  END IF;
END
$retired_cloud_backup_objects$;

-- 5. 移除表（按 FK 依赖顺序，CASCADE 也处理隐含引用）
DROP TABLE IF EXISTS public.backup_restore_history CASCADE;
DROP TABLE IF EXISTS public.backup_metadata CASCADE;
DROP TABLE IF EXISTS public.backup_encryption_keys CASCADE;

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
DO $retired_cloud_backup_app_config$
BEGIN
  IF to_regclass('public.app_config') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.app_config WHERE key LIKE ''backup.%''';
  END IF;
END
$retired_cloud_backup_app_config$;
;
