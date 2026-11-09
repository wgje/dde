-- Keep widget notification fanout bounded and perform binding validation in Postgres.

CREATE OR REPLACE FUNCTION public.list_widget_notify_devices(
  p_user_id UUID,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  binding_generation INTEGER,
  installation_id TEXT,
  capabilities JSONB,
  push_token TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    device.id,
    device.binding_generation,
    device.installation_id,
    device.capabilities,
    device.push_token,
    device.expires_at
  FROM public.widget_devices AS device
  WHERE p_user_id IS NOT NULL
    AND device.user_id = p_user_id
    AND device.platform = 'android-widget'
    AND device.revoked_at IS NULL
    AND device.expires_at > NOW()
    AND NULLIF(BTRIM(device.push_token), '') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.widget_instances AS instance
      WHERE instance.user_id = p_user_id
        AND instance.platform = 'android-widget'
        AND instance.device_id = device.id
        AND instance.binding_generation = device.binding_generation
        AND instance.uninstalled_at IS NULL
    )
  ORDER BY device.last_seen_at DESC, device.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
$$;

REVOKE ALL ON FUNCTION public.list_widget_notify_devices(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_widget_notify_devices(UUID, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.list_widget_notify_devices(UUID, INTEGER) IS
  'Returns at most 100 recently active Android widget devices with a current instance binding.';
