-- NanoFlow 软删除与日志清理定时任务配置
-- 版本: 1.1.0
-- 日期: 2026-02-09
-- 描述:
--   为已存在的清理函数配置 pg_cron 定时任务（幂等可重跑）：
--   - cleanup_old_deleted_tasks()
--   - cleanup_old_deleted_connections()
--   - cleanup_old_logs()

-- ===========================================
-- 前置要求
-- ===========================================
-- 1. 已执行 scripts/init-supabase.sql（确保清理函数存在）
-- 2. 当前 Supabase 实例支持 pg_cron 扩展

DO $$
BEGIN
  -- 1) 启用 pg_cron（失败时给出明确错误）
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION '无法启用 pg_cron：%。请先在 Supabase Dashboard 启用该扩展后重试。', SQLERRM;
  END;

  IF to_regnamespace('cron') IS NULL THEN
    RAISE EXCEPTION 'pg_cron 扩展未生效：找不到 schema "cron"';
  END IF;

  -- 2) 校验关键清理函数存在性（避免静默失败）
  IF to_regprocedure('public.cleanup_old_deleted_tasks()') IS NULL THEN
    RAISE EXCEPTION '缺少函数: public.cleanup_old_deleted_tasks()';
  END IF;
  IF to_regprocedure('public.cleanup_old_deleted_connections()') IS NULL THEN
    RAISE EXCEPTION '缺少函数: public.cleanup_old_deleted_connections()';
  END IF;
  IF to_regprocedure('public.cleanup_old_logs()') IS NULL THEN
    RAISE EXCEPTION '缺少函数: public.cleanup_old_logs()';
  END IF;

  -- 3) 幂等处理：先删除旧任务（如果存在）
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN (
    'nanoflow-cleanup-deleted-tasks',
    'nanoflow-cleanup-deleted-connections',
    'nanoflow-cleanup-logs'
  );

  -- 4) 重建任务（UTC）
  -- 每天 03:10 UTC：软删除任务清理
  PERFORM cron.schedule(
    'nanoflow-cleanup-deleted-tasks',
    '10 3 * * *',
    $job$SELECT public.cleanup_old_deleted_tasks();$job$
  );

  -- 每天 03:20 UTC：软删除连接清理
  PERFORM cron.schedule(
    'nanoflow-cleanup-deleted-connections',
    '20 3 * * *',
    $job$SELECT public.cleanup_old_deleted_connections();$job$
  );

  -- 每天 03:30 UTC：旧日志清理
  PERFORM cron.schedule(
    'nanoflow-cleanup-logs',
    '30 3 * * *',
    $job$SELECT public.cleanup_old_logs();$job$
  );
END $$;

-- ===========================================
-- 验证查询（执行后可手动运行）
-- ===========================================
-- 查看任务
-- SELECT jobid, jobname, schedule, active, command
-- FROM cron.job
-- WHERE jobname LIKE 'nanoflow-cleanup-%'
-- ORDER BY jobname;

-- 查看最近执行历史
-- SELECT *
-- FROM cron.job_run_details
-- WHERE jobid IN (
--   SELECT jobid FROM cron.job WHERE jobname LIKE 'nanoflow-cleanup-%'
-- )
-- ORDER BY start_time DESC
-- LIMIT 20;

-- 手动执行（用于验证）
-- SELECT public.cleanup_old_deleted_tasks();
-- SELECT public.cleanup_old_deleted_connections();
-- SELECT public.cleanup_old_logs();
