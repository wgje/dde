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
description = EXCLUDED.description;