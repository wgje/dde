-- Archive and retire obsolete desktop widget records before converging the live schema to Android only.

CREATE TABLE IF NOT EXISTS public.widget_devices_legacy_retired
AS TABLE public.widget_devices WITH NO DATA;

ALTER TABLE public.widget_devices_legacy_retired
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.widget_devices_legacy_retired
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_devices_legacy_retired_id
  ON public.widget_devices_legacy_retired (id);

CREATE TABLE IF NOT EXISTS public.widget_instances_legacy_retired
AS TABLE public.widget_instances WITH NO DATA;

ALTER TABLE public.widget_instances_legacy_retired
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.widget_instances_legacy_retired
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_instances_legacy_retired_id
  ON public.widget_instances_legacy_retired (id);

INSERT INTO public.widget_instances_legacy_retired
SELECT wi.*, NOW(), 'desktop-widget-retired'
FROM public.widget_instances wi
WHERE wi.platform <> 'android-widget'
  AND NOT EXISTS (
    SELECT 1
    FROM public.widget_instances_legacy_retired archived
    WHERE archived.id = wi.id
  );

INSERT INTO public.widget_devices_legacy_retired
SELECT wd.*, NOW(), 'desktop-widget-retired'
FROM public.widget_devices wd
WHERE wd.platform <> 'android-widget'
  AND NOT EXISTS (
    SELECT 1
    FROM public.widget_devices_legacy_retired archived
    WHERE archived.id = wd.id
  );

DELETE FROM public.widget_instances
WHERE platform <> 'android-widget';

DELETE FROM public.widget_devices
WHERE platform <> 'android-widget';

ALTER TABLE public.widget_instances
  DROP CONSTRAINT IF EXISTS widget_instances_platform_check;

ALTER TABLE public.widget_instances
  ADD CONSTRAINT widget_instances_platform_check
  CHECK (platform IN ('android-widget'));

ALTER TABLE public.widget_devices
  DROP CONSTRAINT IF EXISTS widget_devices_platform_check;

ALTER TABLE public.widget_devices
  ADD CONSTRAINT widget_devices_platform_check
  CHECK (platform IN ('android-widget'));
