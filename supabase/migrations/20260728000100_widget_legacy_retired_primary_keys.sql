ALTER TABLE public.widget_devices_legacy_retired
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE public.widget_devices_legacy_retired
  ADD CONSTRAINT widget_devices_legacy_retired_pkey
  PRIMARY KEY USING INDEX idx_widget_devices_legacy_retired_id;

ALTER TABLE public.widget_instances_legacy_retired
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE public.widget_instances_legacy_retired
  ADD CONSTRAINT widget_instances_legacy_retired_pkey
  PRIMARY KEY USING INDEX idx_widget_instances_legacy_retired_id;
