-- Widget notify rollout alignment: backfill notify-specific rate limits into app_config for existing projects.

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_limits',
  jsonb_build_object(
    'registerUserPerMinute', 10,
    'registerIpPerMinute', 20,
    'summaryDevicePerMinute', 30,
    'summaryUserPerMinute', 60,
    'summaryIpPerMinute', 120,
    'notifyUserPerMinute', 120,
    'notifyIpPerMinute', 600,
    'blockSeconds', 300,
    'tokenTtlDays', 30,
    'freshThresholdMinutes', 5,
    'agingThresholdMinutes', 60
  ),
  'Widget backend rate limits and freshness thresholds'
)
ON CONFLICT (key) DO UPDATE
SET value = COALESCE(public.app_config.value, '{}'::jsonb) || jsonb_build_object(
      'notifyUserPerMinute', COALESCE((public.app_config.value ->> 'notifyUserPerMinute')::INTEGER, 120),
      'notifyIpPerMinute', COALESCE((public.app_config.value ->> 'notifyIpPerMinute')::INTEGER, 600)
    ),
    description = EXCLUDED.description,
    updated_at = NOW();
