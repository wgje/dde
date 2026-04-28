-- PL/pgSQL 在 CASE 表达式里对 NEW 的所有分支都做字段绑定，即使分支不匹配也会因
-- "record NEW has no field user_id" 而失败（tasks 表的 NEW 没有 user_id）。
-- 改为 IF/ELSIF 按表分发，只有命中分支才绑定字段，避免跨表字段引用失败。
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
  v_new_record JSONB := NULL;
  v_old_record JSONB := NULL;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := regexp_replace(trim(public.get_vault_secret('widget_notify_webhook_secret')), '^v1,whsec_', '');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(v_secret, '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;

  -- 按表分发构造最小化 record / old_record，避免 to_jsonb(NEW) 把 session_state 等
  -- 大字段夹带进去（曾导致 pg_net 5s 超时丢事件）。
  IF TG_TABLE_NAME = 'focus_sessions' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'started_at', NEW.started_at,
        'ended_at', NEW.ended_at,
        'updated_at', NEW.updated_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'user_id', OLD.user_id,
        'started_at', OLD.started_at,
        'ended_at', OLD.ended_at,
        'updated_at', OLD.updated_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'black_box_entries' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'updated_at', NEW.updated_at,
        'created_at', NEW.created_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'user_id', OLD.user_id,
        'updated_at', OLD.updated_at,
        'created_at', OLD.created_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'project_id', NEW.project_id,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at,
        'created_at', NEW.created_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'project_id', OLD.project_id,
        'updated_at', OLD.updated_at,
        'deleted_at', OLD.deleted_at,
        'created_at', OLD.created_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'projects' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'owner_id', NEW.owner_id,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'owner_id', OLD.owner_id,
        'updated_at', OLD.updated_at,
        'deleted_at', OLD.deleted_at
      );
    END IF;
  ELSE
    -- 兜底：未识别的表使用全量 to_jsonb（不会走到这里，因为触发器只绑定上述四张表）。
    IF TG_OP <> 'DELETE' THEN v_new_record := to_jsonb(NEW); END IF;
    IF TG_OP <> 'INSERT' THEN v_old_record := to_jsonb(OLD); END IF;
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
