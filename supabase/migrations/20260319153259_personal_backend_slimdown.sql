-- Personal backend slim-down for NanoFlow single-user deployment.
-- Goals:
-- 1. Remove collaboration and virus-scan database surfaces.
-- 2. Rebuild backup cron scheduling around Vault-backed secrets.
-- 3. Add retention cleanup so small personal datasets stay small.

-- Keep backup scheduling configurable, but reset defaults to the
-- lower-frequency cadence chosen for this personal project.
DELETE FROM public.app_config
WHERE key IN (
  'backup.schedule.attachments_cleanup',
  'backup.schedule.health_report'
);

INSERT INTO public.app_config (key, value, description)
VALUES
  (
    'backup.schedule.full',
    to_jsonb('10 19 * * *'::text),
    'Full backup cron (UTC). Asia/Shanghai: daily 03:10.'
  ),
  (
    'backup.schedule.incremental',
    to_jsonb('10 1,7,13 * * *'::text),
    'Incremental backup cron (UTC). Asia/Shanghai: 09:10 / 15:10 / 21:10.'
  ),
  (
    'backup.schedule.cleanup',
    to_jsonb('10 20 * * *'::text),
    'Backup cleanup cron (UTC). Asia/Shanghai: daily 04:10.'
  )
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT id
  FROM public.projects
  WHERE owner_id = public.current_user_id()
$$;

CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = public.current_user_id()
  )
$$;

DROP POLICY IF EXISTS "owner select" ON public.projects;
CREATE POLICY "owner select" ON public.projects
FOR SELECT
USING ((SELECT auth.uid() AS uid) = owner_id);

DROP POLICY IF EXISTS "owner update" ON public.projects;
CREATE POLICY "owner update" ON public.projects
FOR UPDATE
USING ((SELECT auth.uid() AS uid) = owner_id);

CREATE OR REPLACE FUNCTION public.get_vault_secret(p_name text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'vault'
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = p_name
  ORDER BY updated_at DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.invoke_internal_edge_function(
  p_slug text,
  p_body jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public', 'vault'
AS $$
DECLARE
  v_base_url text;
  v_service_role_key text;
  v_request_id bigint;
BEGIN
  IF p_slug NOT IN ('backup-full', 'backup-incremental', 'backup-cleanup') THEN
    RAISE EXCEPTION 'Unsupported internal Edge Function slug: %', p_slug;
  END IF;

  v_base_url := public.get_vault_secret('backup_supabase_url');
  v_service_role_key := public.get_vault_secret('backup_service_role_key');

  IF v_base_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE EXCEPTION 'Missing Vault secret(s) backup_supabase_url / backup_service_role_key';
  END IF;

  SELECT net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/' || p_slug,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_role_key,
      'Content-Type', 'application/json'
    ),
    body := coalesce(p_body, '{}'::jsonb)
  )
  INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_internal_edge_function(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_internal_edge_function(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_internal_edge_function(text, jsonb) FROM authenticated;

CREATE OR REPLACE FUNCTION public.apply_backup_schedules()
RETURNS TABLE(job_name text, schedule text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public', 'cron'
AS $$
DECLARE
  v_full_schedule text;
  v_incremental_schedule text;
  v_cleanup_schedule text;
  v_job record;
BEGIN
  v_full_schedule := public.get_backup_schedule('backup.schedule.full', '10 19 * * *');
  v_incremental_schedule := public.get_backup_schedule('backup.schedule.incremental', '10 1,7,13 * * *');
  v_cleanup_schedule := public.get_backup_schedule('backup.schedule.cleanup', '10 20 * * *');

  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
      'nanoflow-backup-full',
      'nanoflow-backup-incremental',
      'nanoflow-backup-cleanup',
      'nanoflow-cleanup-attachments',
      'nanoflow-backup-health-report'
    )
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'nanoflow-backup-full',
    v_full_schedule,
    $cmd$SELECT public.invoke_internal_edge_function('backup-full', '{}'::jsonb);$cmd$
  );

  PERFORM cron.schedule(
    'nanoflow-backup-incremental',
    v_incremental_schedule,
    $cmd$SELECT public.invoke_internal_edge_function('backup-incremental', '{}'::jsonb);$cmd$
  );

  PERFORM cron.schedule(
    'nanoflow-backup-cleanup',
    v_cleanup_schedule,
    $cmd$SELECT public.invoke_internal_edge_function('backup-cleanup', '{}'::jsonb);$cmd$
  );

  RETURN QUERY
  SELECT
    j.jobname::text,
    j.schedule::text,
    CASE WHEN j.active THEN 'active' ELSE 'paused' END::text
  FROM cron.job j
  WHERE j.jobname IN (
    'nanoflow-backup-full',
    'nanoflow-backup-incremental',
    'nanoflow-backup-cleanup'
  )
  ORDER BY j.jobname;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_backup_schedule(p_config_key text, p_cron_expression text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_valid_keys text[] := ARRAY[
    'backup.schedule.full',
    'backup.schedule.incremental',
    'backup.schedule.cleanup'
  ];
BEGIN
  IF NOT (p_config_key = ANY(v_valid_keys)) THEN
    RAISE EXCEPTION 'Invalid backup schedule key: %', p_config_key;
  END IF;

  IF array_length(string_to_array(trim(p_cron_expression), ' '), 1) != 5 THEN
    RAISE EXCEPTION 'Invalid cron expression: %', p_cron_expression;
  END IF;

  INSERT INTO public.app_config (key, value, description)
  VALUES (p_config_key, to_jsonb(p_cron_expression), 'Backup schedule configuration')
  ON CONFLICT (key) DO UPDATE SET
    value = to_jsonb(p_cron_expression),
    updated_at = now();

  PERFORM public.apply_backup_schedules();

  RETURN format('Updated %s to "%s"', p_config_key, p_cron_expression);
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_cron_job_run_details(
  p_max_age interval DEFAULT interval '7 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'cron'
AS $$
DECLARE
  v_deleted_count integer := 0;
BEGIN
  WITH deleted AS (
    DELETE FROM cron.job_run_details
    WHERE end_time < now() - p_max_age
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted_count FROM deleted;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_cron_job_run_details(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_cron_job_run_details(interval) TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_personal_retention_artifacts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_focus_sessions_deleted integer := 0;
  v_transcription_usage_deleted integer := 0;
  v_task_tombstones_deleted integer := 0;
  v_connection_tombstones_deleted integer := 0;
BEGIN
  WITH deleted AS (
    DELETE FROM public.focus_sessions
    WHERE ended_at IS NOT NULL
      AND updated_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_focus_sessions_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.transcription_usage
    WHERE created_at < now() - interval '90 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_transcription_usage_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.task_tombstones
    WHERE deleted_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_task_tombstones_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.connection_tombstones
    WHERE deleted_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_connection_tombstones_deleted FROM deleted;

  IF (v_focus_sessions_deleted + v_transcription_usage_deleted + v_task_tombstones_deleted + v_connection_tombstones_deleted) > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'personal_retention_cleanup',
      jsonb_build_object(
        'focus_sessions_deleted', v_focus_sessions_deleted,
        'transcription_usage_deleted', v_transcription_usage_deleted,
        'task_tombstones_deleted', v_task_tombstones_deleted,
        'connection_tombstones_deleted', v_connection_tombstones_deleted,
        'cleanup_time', now()
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'focus_sessions_deleted', v_focus_sessions_deleted,
    'transcription_usage_deleted', v_transcription_usage_deleted,
    'task_tombstones_deleted', v_task_tombstones_deleted,
    'connection_tombstones_deleted', v_connection_tombstones_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_personal_retention_artifacts() TO service_role;

DELETE FROM cron.job_run_details;
SELECT public.apply_backup_schedules();

DO $$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN ('nanoflow-personal-retention', 'nanoflow-cron-log-retention')
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'nanoflow-personal-retention',
    '40 20 * * *',
    $cmd$SELECT public.cleanup_personal_retention_artifacts();$cmd$
  );

  PERFORM cron.schedule(
    'nanoflow-cron-log-retention',
    '55 20 * * *',
    $cmd$SELECT public.cleanup_cron_job_run_details(interval '7 days');$cmd$
  );
END $$;

-- 运行时代码仍依赖这些表；在对应服务/函数完全下线前保留 schema，避免 fresh bootstrap 后失配。

ALTER TABLE public.user_preferences
DROP COLUMN IF EXISTS dock_snapshot;;
