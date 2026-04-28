-- 修正：projects 表没有 created_at 列，上一版投影里对 projects 引用 NEW.created_at
-- 会导致触发器在 projects INSERT/UPDATE/DELETE 时直接报错，整个事件被吞掉。
-- 这里重新发布函数，去掉 projects 分支里的 created_at 字段，其它逻辑不变。
CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault', 'extensions'
AS $function$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
  v_new_record JSONB;
  v_old_record JSONB;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := regexp_replace(trim(public.get_vault_secret('widget_notify_webhook_secret')), '^v1,whsec_', '');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(v_secret, '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;

  IF TG_OP = 'DELETE' THEN
    v_new_record := NULL;
  ELSE
    v_new_record := CASE TG_TABLE_NAME
      WHEN 'focus_sessions' THEN jsonb_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'started_at', NEW.started_at,
        'ended_at', NEW.ended_at,
        'updated_at', NEW.updated_at
      )
      WHEN 'black_box_entries' THEN jsonb_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'updated_at', NEW.updated_at,
        'created_at', NEW.created_at
      )
      WHEN 'tasks' THEN jsonb_build_object(
        'id', NEW.id,
        'project_id', NEW.project_id,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at,
        'created_at', NEW.created_at
      )
      WHEN 'projects' THEN jsonb_build_object(
        'id', NEW.id,
        'owner_id', NEW.owner_id,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at
      )
      ELSE to_jsonb(NEW)
    END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_old_record := NULL;
  ELSE
    v_old_record := CASE TG_TABLE_NAME
      WHEN 'focus_sessions' THEN jsonb_build_object(
        'id', OLD.id,
        'user_id', OLD.user_id,
        'started_at', OLD.started_at,
        'ended_at', OLD.ended_at,
        'updated_at', OLD.updated_at
      )
      WHEN 'black_box_entries' THEN jsonb_build_object(
        'id', OLD.id,
        'user_id', OLD.user_id,
        'updated_at', OLD.updated_at,
        'created_at', OLD.created_at
      )
      WHEN 'tasks' THEN jsonb_build_object(
        'id', OLD.id,
        'project_id', OLD.project_id,
        'updated_at', OLD.updated_at,
        'deleted_at', OLD.deleted_at,
        'created_at', OLD.created_at
      )
      WHEN 'projects' THEN jsonb_build_object(
        'id', OLD.id,
        'owner_id', OLD.owner_id,
        'updated_at', OLD.updated_at,
        'deleted_at', OLD.deleted_at
      )
      ELSE to_jsonb(OLD)
    END;
  END IF;

  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', v_new_record,
    'old_record', v_old_record
  );

  v_signature := encode(
    extensions.hmac(
      convert_to(v_event_id || '.' || v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload,
    timeout_milliseconds := 30000
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;;
