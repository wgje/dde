-- NanoFlow 备份系统定时任务配置
-- 版本: 1.1.0
-- 日期: 2026-02-10
-- 描述: 配置 Supabase pg_cron 定时触发备份 Edge Functions
--        支持通过 app_config 表动态调整备份频率

-- ===========================================
-- 前置要求
-- ===========================================
-- 1. 需要在 Supabase Dashboard 中启用 pg_cron 扩展
-- 2. 需要启用 pg_net 扩展用于 HTTP 调用
-- 3. Edge Functions 需要已部署
-- 4. app_config 表需要存在（scripts/init-supabase.sql）

-- 启用扩展（如果尚未启用）
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ===========================================
-- 0. 初始化可配置的备份调度参数（app_config）
-- ===========================================
-- 通过 app_config 表管理备份频率，支持在线调整

INSERT INTO public.app_config (key, value, description)
VALUES
  ('backup.schedule.full', '"0 0 * * *"'::jsonb, '全量备份 Cron 表达式（默认每天 00:00 UTC）'),
  ('backup.schedule.incremental', '"*/15 * * * *"'::jsonb, '增量备份 Cron 表达式（默认每 15 分钟）'),
  ('backup.schedule.cleanup', '"0 1 * * *"'::jsonb, '备份清理 Cron 表达式（默认每天 01:00 UTC）'),
  ('backup.schedule.attachments_cleanup', '"0 2 * * *"'::jsonb, '附件清理 Cron 表达式（默认每天 02:00 UTC）'),
  ('backup.schedule.health_report', '"0 8 * * *"'::jsonb, '健康报告 Cron 表达式（默认每天 08:00 UTC / 北京 16:00）')
ON CONFLICT (key) DO NOTHING;

-- ===========================================
-- 1. 辅助函数：从 app_config 读取调度配置
-- ===========================================
CREATE OR REPLACE FUNCTION get_backup_schedule(p_key TEXT, p_default TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_value TEXT;
BEGIN
  SELECT value #>> '{}' INTO v_value
  FROM public.app_config
  WHERE key = p_key;
  
  RETURN COALESCE(v_value, p_default);
END;
$$;

-- ===========================================
-- 2. 核心函数：应用备份调度配置
-- ===========================================
-- 此函数读取 app_config 中的配置，重新创建所有 cron 任务
-- 调用方式：SELECT apply_backup_schedules();

CREATE OR REPLACE FUNCTION apply_backup_schedules()
RETURNS TABLE(job_name TEXT, schedule TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public', 'cron'
AS $$
DECLARE
  v_full_schedule TEXT;
  v_incremental_schedule TEXT;
  v_cleanup_schedule TEXT;
  v_attachment_cleanup_schedule TEXT;
  v_health_report_schedule TEXT;
  v_supabase_url TEXT;
  v_service_key TEXT;
BEGIN
  -- 读取配置
  v_full_schedule := get_backup_schedule('backup.schedule.full', '0 0 * * *');
  v_incremental_schedule := get_backup_schedule('backup.schedule.incremental', '*/15 * * * *');
  v_cleanup_schedule := get_backup_schedule('backup.schedule.cleanup', '0 1 * * *');
  v_attachment_cleanup_schedule := get_backup_schedule('backup.schedule.attachments_cleanup', '0 2 * * *');
  v_health_report_schedule := get_backup_schedule('backup.schedule.health_report', '0 8 * * *');

  -- 先移除所有旧的备份 cron 任务
  PERFORM cron.unschedule(j.jobid)
  FROM cron.job j
  WHERE j.jobname IN (
    'nanoflow-backup-full',
    'nanoflow-backup-incremental',
    'nanoflow-backup-cleanup',
    'nanoflow-cleanup-attachments',
    'nanoflow-backup-health-report'
  );

  -- 重新创建任务
  -- 1) 全量备份
  PERFORM cron.schedule(
    'nanoflow-backup-full',
    v_full_schedule,
    format($cmd$
    SELECT net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-full',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    )
    $cmd$)
  );

  -- 2) 增量备份
  PERFORM cron.schedule(
    'nanoflow-backup-incremental',
    v_incremental_schedule,
    format($cmd$
    SELECT net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-incremental',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    )
    $cmd$)
  );

  -- 3) 备份清理
  PERFORM cron.schedule(
    'nanoflow-backup-cleanup',
    v_cleanup_schedule,
    format($cmd$
    SELECT net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-cleanup',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    )
    $cmd$)
  );

  -- 4) 附件清理
  PERFORM cron.schedule(
    'nanoflow-cleanup-attachments',
    v_attachment_cleanup_schedule,
    format($cmd$
    SELECT net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/cleanup-attachments',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    )
    $cmd$)
  );

  -- 5) 健康报告
  PERFORM cron.schedule(
    'nanoflow-backup-health-report',
    v_health_report_schedule,
    format($cmd$
    SELECT net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/backup-alert',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{"action": "health_report"}'::jsonb
    )
    $cmd$)
  );

  -- 返回所有已配置的任务
  RETURN QUERY
  SELECT
    j.jobname::TEXT AS job_name,
    j.schedule::TEXT AS schedule,
    CASE WHEN j.active THEN 'active' ELSE 'paused' END AS status
  FROM cron.job j
  WHERE j.jobname LIKE 'nanoflow-backup-%'
     OR j.jobname LIKE 'nanoflow-cleanup-%'
  ORDER BY j.jobname;
END;
$$;

-- ===========================================
-- 3. 便捷函数：更新单个备份调度配置
-- ===========================================
-- 用法: SELECT update_backup_schedule('backup.schedule.full', '0 3 * * *');
-- 会同时更新 app_config 并重新应用 cron 任务

CREATE OR REPLACE FUNCTION update_backup_schedule(p_config_key TEXT, p_cron_expression TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_valid_keys TEXT[] := ARRAY[
    'backup.schedule.full',
    'backup.schedule.incremental',
    'backup.schedule.cleanup',
    'backup.schedule.attachments_cleanup',
    'backup.schedule.health_report'
  ];
BEGIN
  -- 校验 key 是否合法
  IF NOT (p_config_key = ANY(v_valid_keys)) THEN
    RAISE EXCEPTION '无效的配置键: %。允许值: %', p_config_key, array_to_string(v_valid_keys, ', ');
  END IF;
  
  -- 基本 cron 表达式格式校验（5 段）
  IF array_length(string_to_array(trim(p_cron_expression), ' '), 1) != 5 THEN
    RAISE EXCEPTION '无效的 Cron 表达式: "%"。需要 5 个时间段（分 时 日 月 周）', p_cron_expression;
  END IF;
  
  -- 更新 app_config
  INSERT INTO public.app_config (key, value, description)
  VALUES (p_config_key, to_jsonb(p_cron_expression), '备份调度配置')
  ON CONFLICT (key) DO UPDATE SET
    value = to_jsonb(p_cron_expression),
    updated_at = now();
  
  -- 重新应用所有调度
  PERFORM apply_backup_schedules();
  
  RETURN format('已更新 %s 为 "%s"，cron 任务已重新加载', p_config_key, p_cron_expression);
END;
$$;

-- ===========================================
-- 4. 首次初始化：应用默认调度
-- ===========================================
SELECT apply_backup_schedules();

-- ===========================================
-- 辅助查询
-- ===========================================

-- 查看所有已配置的定时任务
-- SELECT * FROM cron.job WHERE jobname LIKE 'nanoflow-%';

-- 查看定时任务执行历史
-- SELECT * FROM cron.job_run_details 
-- WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'nanoflow-%')
-- ORDER BY start_time DESC
-- LIMIT 20;

-- 查看当前备份调度配置
-- SELECT key, value #>> '{}' AS schedule, description
-- FROM app_config
-- WHERE key LIKE 'backup.schedule.%';

-- 修改备份调度（示例）
-- SELECT update_backup_schedule('backup.schedule.full', '0 3 * * *');           -- 改为每天 03:00 UTC
-- SELECT update_backup_schedule('backup.schedule.incremental', '*/30 * * * *'); -- 改为每 30 分钟
-- SELECT update_backup_schedule('backup.schedule.health_report', '0 9 * * 1');  -- 改为每周一 09:00

-- 手动重新加载所有调度（修改 app_config 后）
-- SELECT * FROM apply_backup_schedules();

-- 手动运行任务（用于测试）
-- SELECT cron.run_job('nanoflow-backup-full');

-- 暂停任务
-- UPDATE cron.job SET active = false WHERE jobname = 'nanoflow-backup-full';

-- 恢复任务
-- UPDATE cron.job SET active = true WHERE jobname = 'nanoflow-backup-full';

-- 删除任务
-- SELECT cron.unschedule('nanoflow-backup-full');

-- ===========================================
-- 注意事项
-- ===========================================

-- 1. 上述 SQL 使用了 current_setting('app.settings.xxx') 来获取配置
--    需要在 Supabase Dashboard → Settings → Database 中配置这些值
--    或者使用 ALTER SYSTEM SET 命令设置

-- 2. 如果使用硬编码的 URL 和密钥，替换为：
/*
SELECT cron.schedule(
  'nanoflow-backup-full',
  '0 0 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/backup-full',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);
*/

-- 3. 建议在生产环境中使用 Vault 存储敏感配置：
/*
SELECT cron.schedule(
  'nanoflow-backup-full',
  '0 0 * * *',
  $$
  SELECT net.http_post(
    url := vault.decrypted_secrets(secret_name := 'supabase_url') || '/functions/v1/backup-full',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || vault.decrypted_secrets(secret_name := 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);
*/

COMMENT ON EXTENSION pg_cron IS 'NanoFlow 使用 pg_cron 调度备份和清理任务';
