BEGIN;

-- 迁移历史整理：
-- 远端已经记录了若干 db pull 时间戳版本；旧的本地时间戳会被 Supabase CLI
-- 判定为“插入到远端最后迁移之前”。本迁移只承接仍符合当前 schema 的前进差异。
-- 云备份基础设施已在 20260322143921 移除，因此不再恢复旧 backup_metadata/app_config 差异。

CREATE TABLE IF NOT EXISTS public.widget_devices_legacy_retired
AS TABLE public.widget_devices WITH NO DATA;

ALTER TABLE public.widget_devices_legacy_retired
  ADD COLUMN IF NOT EXISTS retired_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.widget_devices_legacy_retired
  ADD COLUMN IF NOT EXISTS retirement_reason text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_devices_legacy_retired_id
  ON public.widget_devices_legacy_retired (id);

ALTER TABLE public.widget_devices_legacy_retired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_devices_legacy_retired FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.widget_devices_legacy_retired FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.widget_devices_legacy_retired TO service_role;

CREATE TABLE IF NOT EXISTS public.widget_instances_legacy_retired
AS TABLE public.widget_instances WITH NO DATA;

ALTER TABLE public.widget_instances_legacy_retired
  ADD COLUMN IF NOT EXISTS retired_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.widget_instances_legacy_retired
  ADD COLUMN IF NOT EXISTS retirement_reason text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_instances_legacy_retired_id
  ON public.widget_instances_legacy_retired (id);

ALTER TABLE public.widget_instances_legacy_retired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances_legacy_retired FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.widget_instances_legacy_retired FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.widget_instances_legacy_retired TO service_role;

INSERT INTO public.widget_instances_legacy_retired
SELECT wi.*, now(), 'desktop-widget-retired'
FROM public.widget_instances wi
WHERE wi.platform <> 'android-widget'
  AND NOT EXISTS (
    SELECT 1
    FROM public.widget_instances_legacy_retired archived
    WHERE archived.id = wi.id
  );

INSERT INTO public.widget_devices_legacy_retired
SELECT wd.*, now(), 'desktop-widget-retired'
FROM public.widget_devices wd
WHERE wd.platform <> 'android-widget'
  AND NOT EXISTS (
    SELECT 1
    FROM public.widget_devices_legacy_retired archived
    WHERE archived.id = wd.id
  );

DELETE FROM public.widget_instances
WHERE platform <> 'android-widget';

DELETE FROM public.widget_devices
WHERE platform <> 'android-widget';

ALTER TABLE public.widget_instances
  DROP CONSTRAINT IF EXISTS widget_instances_platform_check;

ALTER TABLE public.widget_instances
  ADD CONSTRAINT widget_instances_platform_check
  CHECK (platform IN ('android-widget'));

ALTER TABLE public.widget_devices
  DROP CONSTRAINT IF EXISTS widget_devices_platform_check;

ALTER TABLE public.widget_devices
  ADD CONSTRAINT widget_devices_platform_check
  CHECK (platform IN ('android-widget'));

ALTER TABLE public.widget_devices
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_devices_token_hash
  ON public.widget_devices (token_hash)
  WHERE token_hash IS NOT NULL;

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_capabilities',
  jsonb_build_object(
    'widgetEnabled', true,
    'installAllowed', true,
    'refreshAllowed', true,
    'pushAllowed', false,
    'reason', NULL,
    'rules', jsonb_build_array()
  ),
  'Widget backend capability gates and kill switch defaults'
)
ON CONFLICT (key) DO UPDATE
SET value = CASE
  WHEN jsonb_typeof(public.app_config.value) = 'object'
    THEN public.app_config.value || jsonb_build_object(
      'rules', COALESCE(public.app_config.value -> 'rules', '[]'::jsonb)
    )
  ELSE EXCLUDED.value
END,
description = EXCLUDED.description,
updated_at = now();

DROP TRIGGER IF EXISTS widget_notify_task_change ON public.tasks;
CREATE TRIGGER widget_notify_task_change
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_project_change ON public.projects;
CREATE TRIGGER widget_notify_project_change
  AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

CREATE OR REPLACE FUNCTION public.batch_get_tombstones(
  p_project_ids uuid[]
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_result json;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  SELECT json_build_object(
    'task_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object(
        'project_id', tt.project_id,
        'task_id', tt.task_id,
        'deleted_at', tt.deleted_at
      ))
       FROM public.task_tombstones tt
       INNER JOIN public.projects p ON p.id = tt.project_id
       WHERE tt.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    ),
    'connection_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object('project_id', ct.project_id, 'connection_id', ct.connection_id))
       FROM public.connection_tombstones ct
       INNER JOIN public.projects p ON p.id = ct.project_id
       WHERE ct.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.batch_get_tombstones(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_get_tombstones(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.batch_get_tombstones IS
  '批量获取多项目 tombstone：返回 task deleted_at 水位，允许客户端正确判断恢复是否晚于删除。';

CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_tasks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH expired_tasks AS (
    SELECT t.id AS task_id, t.project_id
    FROM public.tasks t
    WHERE t.deleted_at IS NOT NULL
      AND t.deleted_at < now() - interval '30 days'
  ),
  task_tombstone_rows AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT et.task_id, et.project_id, now(), NULL
    FROM expired_tasks et
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id, project_id
  ),
  expired_connections AS (
    SELECT DISTINCT c.id AS connection_id, c.project_id
    FROM public.connections c
    JOIN task_tombstone_rows tt ON tt.project_id = c.project_id
    WHERE c.source_id = tt.task_id OR c.target_id = tt.task_id
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT ec.connection_id, ec.project_id, now(), NULL
    FROM expired_connections ec
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections c
    USING connection_tombstone_rows ct
    WHERE c.id = ct.connection_id
    RETURNING c.id
  ),
  deleted_tasks AS (
    DELETE FROM public.tasks t
    USING task_tombstone_rows tt
    WHERE t.id = tt.task_id
    RETURNING t.id
  )
  SELECT count(*) INTO deleted_count FROM deleted_tasks;

  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'deleted_tasks_cleanup',
      jsonb_build_object(
        'deleted_count', deleted_count,
        'cleanup_time', now(),
        'mode', 'tombstone_then_delete'
      )
    );
  END IF;

  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_connections()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH expired_connections AS (
    SELECT c.id AS connection_id, c.project_id
    FROM public.connections c
    WHERE c.deleted_at IS NOT NULL
      AND c.deleted_at < now() - interval '30 days'
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT ec.connection_id, ec.project_id, now(), NULL
    FROM expired_connections ec
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections c
    USING connection_tombstone_rows ct
    WHERE c.id = ct.connection_id
    RETURNING c.id
  )
  SELECT count(*) INTO deleted_count FROM deleted_connections;

  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'deleted_connections_cleanup',
      jsonb_build_object(
        'deleted_count', deleted_count,
        'cleanup_time', now(),
        'mode', 'tombstone_then_delete'
      )
    );
  END IF;

  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_old_deleted_tasks() IS
  '硬删除超过 30 天的软删除任务前先写 task/connection tombstone，避免离线端把过期回收站数据误当作仍可恢复。';

COMMENT ON FUNCTION public.cleanup_old_deleted_connections() IS
  '硬删除超过 30 天的软删除连接前先写 connection tombstone，确保客户端能通过水位收敛。';

COMMIT;
