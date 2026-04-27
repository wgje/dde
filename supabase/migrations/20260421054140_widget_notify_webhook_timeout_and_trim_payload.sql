-- 修复 widget-notify webhook 在 focus_sessions 更新时 pg_net 超时丢失事件的问题。
-- 症状：pg_net 默认 5s 超时，而 focus_sessions.session_state 这个大 JSONB 会把
-- webhook body 膨胀到若干 KB，叠加 Edge Function 冷启动经常超时，事件被静默丢弃，
-- 小组件无法收到 FCM 推送，只能等轮询。
--
-- 修复：
-- 1) timeout_milliseconds 从默认 5000 提升到 30000；
-- 2) record / old_record 使用投影而非 to_jsonb(NEW/OLD)：只保留 widget-notify 真正读取的列
--    （id, user_id/owner_id/project_id, updated_at, deleted_at, created_at, ended_at），
--    避免把 session_state 等大字段推送过去。
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

  -- 构造最小化 record 投影：只保留 widget-notify 实际读取的字段，防止 session_state 等
  -- 大 JSONB 导致 webhook body 膨胀 → pg_net 超时。
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
        'deleted_at', NEW.deleted_at,
        'created_at', NEW.created_at
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
        'deleted_at', OLD.deleted_at,
        'created_at', OLD.created_at
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

  -- timeout_milliseconds 必须传入，默认 5000ms 在 Edge Function 冷启动 + TLS 握手叠加下
  -- 偶发击穿，导致事件静默丢失。30000ms 留足冷启动缓冲。
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
