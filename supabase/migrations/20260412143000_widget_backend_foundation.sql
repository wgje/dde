-- Widget backend foundation: device auth, instance boundaries, rate limiting, kill switch defaults

CREATE TABLE IF NOT EXISTS public.widget_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('windows-pwa', 'windows-widget', 'android-widget')),
  installation_id TEXT NOT NULL,
  push_token TEXT NULL,
  push_token_updated_at TIMESTAMPTZ NULL,
  secret_hash TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_bound_user_hash TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoke_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_devices_user_platform_active
  ON public.widget_devices (user_id, platform, updated_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_widget_devices_expires_at
  ON public.widget_devices (expires_at);

DROP TRIGGER IF EXISTS trg_widget_devices_updated_at ON public.widget_devices;
CREATE TRIGGER trg_widget_devices_updated_at
  BEFORE UPDATE ON public.widget_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_devices FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_instances (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES public.widget_devices(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('windows-pwa', 'windows-widget', 'android-widget')),
  host_instance_id TEXT NOT NULL,
  size_bucket TEXT NOT NULL,
  config_scope TEXT NOT NULL DEFAULT 'global-summary' CHECK (config_scope IN ('global-summary')),
  privacy_mode TEXT NOT NULL DEFAULT 'minimal' CHECK (privacy_mode IN ('minimal')),
  binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uninstalled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, host_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_instances_device_active
  ON public.widget_instances (device_id, updated_at DESC)
  WHERE uninstalled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_widget_instances_user_platform
  ON public.widget_instances (user_id, platform, updated_at DESC);

DROP TRIGGER IF EXISTS trg_widget_instances_updated_at ON public.widget_instances;
CREATE TRIGGER trg_widget_instances_updated_at
  BEFORE UPDATE ON public.widget_instances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_request_rate_limits (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('device', 'user', 'ip')),
  scope_key TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ NULL,
  last_decision TEXT NOT NULL DEFAULT 'allow' CHECK (last_decision IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_widget_request_rate_limits_blocked_until
  ON public.widget_request_rate_limits (blocked_until)
  WHERE blocked_until IS NOT NULL;

DROP TRIGGER IF EXISTS trg_widget_request_rate_limits_updated_at ON public.widget_request_rate_limits;
CREATE TRIGGER trg_widget_request_rate_limits_updated_at
  BEFORE UPDATE ON public.widget_request_rate_limits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_request_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_request_rate_limits FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_notify_events (
  webhook_id TEXT PRIMARY KEY,
  user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('focus_sessions', 'black_box_entries', 'tasks', 'projects')),
  event_type TEXT NOT NULL CHECK (event_type IN ('INSERT', 'UPDATE', 'DELETE')),
  summary_cursor TEXT NULL,
  last_status TEXT NOT NULL DEFAULT 'processing',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widget_notify_events_user_processed
  ON public.widget_notify_events (user_id, processed_at DESC);

DROP TRIGGER IF EXISTS trg_widget_notify_events_updated_at ON public.widget_notify_events;
CREATE TRIGGER trg_widget_notify_events_updated_at
  BEFORE UPDATE ON public.widget_notify_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_notify_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_notify_events FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_notify_throttle (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_summary_version TEXT NULL,
  last_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_widget_notify_throttle_updated_at ON public.widget_notify_throttle;
CREATE TRIGGER trg_widget_notify_throttle_updated_at
  BEFORE UPDATE ON public.widget_notify_throttle
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_notify_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_notify_throttle FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_widget_rate_limit(
  p_scope_type TEXT,
  p_scope_key TEXT,
  p_max_calls INTEGER,
  p_window_seconds INTEGER DEFAULT 60,
  p_block_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after_seconds INTEGER,
  remaining_calls INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_record public.widget_request_rate_limits%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_next_count INTEGER;
  v_retry_after INTEGER := 0;
BEGIN
  IF p_scope_type NOT IN ('device', 'user', 'ip') THEN
    RAISE EXCEPTION 'Invalid widget rate limit scope';
  END IF;
  IF COALESCE(length(trim(p_scope_key)), 0) = 0 THEN
    RAISE EXCEPTION 'Invalid widget rate limit scope key';
  END IF;
  IF p_max_calls < 1 THEN
    RAISE EXCEPTION 'Invalid widget rate limit max calls';
  END IF;

  INSERT INTO public.widget_request_rate_limits (
    scope_type,
    scope_key,
    call_count,
    window_start,
    blocked_until,
    last_decision,
    created_at,
    updated_at
  )
  VALUES (
    p_scope_type,
    p_scope_key,
    0,
    v_now,
    NULL,
    'allow',
    v_now,
    v_now
  )
  ON CONFLICT (scope_type, scope_key) DO NOTHING;

  SELECT *
  INTO v_record
  FROM public.widget_request_rate_limits
  WHERE scope_type = p_scope_type
    AND scope_key = p_scope_key
  FOR UPDATE;

  IF v_record.blocked_until IS NOT NULL AND v_record.blocked_until > v_now THEN
    v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_record.blocked_until - v_now)))::INTEGER);
    UPDATE public.widget_request_rate_limits
    SET last_decision = 'deny', updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT FALSE, v_retry_after, 0;
    RETURN;
  END IF;

  IF v_record.window_start <= v_now - make_interval(secs => GREATEST(p_window_seconds, 1)) THEN
    v_next_count := 1;
    UPDATE public.widget_request_rate_limits
    SET call_count = v_next_count,
        window_start = v_now,
        blocked_until = NULL,
        last_decision = 'allow',
        updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT TRUE, 0, GREATEST(p_max_calls - v_next_count, 0);
    RETURN;
  END IF;

  v_next_count := v_record.call_count + 1;
  IF v_next_count > p_max_calls THEN
    UPDATE public.widget_request_rate_limits
    SET call_count = v_next_count,
        blocked_until = v_now + make_interval(secs => GREATEST(p_block_seconds, 1)),
        last_decision = 'deny',
        updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT FALSE, GREATEST(p_block_seconds, 1), 0;
    RETURN;
  END IF;

  UPDATE public.widget_request_rate_limits
  SET call_count = v_next_count,
      last_decision = 'allow',
      updated_at = v_now
  WHERE scope_type = p_scope_type AND scope_key = p_scope_key;

  RETURN QUERY SELECT TRUE, 0, GREATEST(p_max_calls - v_next_count, 0);
END;
$$;

REVOKE ALL ON TABLE public.widget_devices FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_instances FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_request_rate_limits FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_notify_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_notify_throttle FROM anon, authenticated;
GRANT ALL ON TABLE public.widget_devices TO service_role;
GRANT ALL ON TABLE public.widget_instances TO service_role;
GRANT ALL ON TABLE public.widget_request_rate_limits TO service_role;
GRANT ALL ON TABLE public.widget_notify_events TO service_role;
GRANT ALL ON TABLE public.widget_notify_throttle TO service_role;

REVOKE ALL ON FUNCTION public.consume_widget_rate_limit(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_widget_rate_limit(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role;

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
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_limits',
  jsonb_build_object(
    'registerUserPerMinute', 10,
    'registerIpPerMinute', 20,
    'summaryDevicePerMinute', 30,
    'summaryUserPerMinute', 60,
    'summaryIpPerMinute', 120,
    'blockSeconds', 300,
    'tokenTtlDays', 30,
    'freshThresholdMinutes', 5,
    'agingThresholdMinutes', 60
  ),
  'Widget backend rate limits and freshness thresholds'
)
ON CONFLICT (key) DO NOTHING;
