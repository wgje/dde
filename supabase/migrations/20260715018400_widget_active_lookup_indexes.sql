-- Build compact active-row indexes before removing the write-amplifying legacy indexes.
-- These predicates match the widget-notify fanout lookups.

CREATE INDEX IF NOT EXISTS idx_widget_devices_active_owner_platform
  ON public.widget_devices (user_id, platform)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_widget_instances_active_owner_platform
  ON public.widget_instances (user_id, platform)
  INCLUDE (device_id, binding_generation)
  WHERE uninstalled_at IS NULL;
