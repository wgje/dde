-- Widget notify hardening: bind event_id into HMAC and tighten SECURITY DEFINER search_path.

CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vault, extensions
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := public.get_vault_secret('widget_notify_webhook_secret');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(trim(v_secret), '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;
  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
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
    body := v_payload
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;
