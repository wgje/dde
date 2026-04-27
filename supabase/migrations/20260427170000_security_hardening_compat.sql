BEGIN;

-- Forward hardening for environments that already applied the drift reconciliation migration.
ALTER TABLE public.widget_devices_legacy_retired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_devices_legacy_retired FORCE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances_legacy_retired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances_legacy_retired FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.widget_devices_legacy_retired FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.widget_instances_legacy_retired FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.widget_devices_legacy_retired TO service_role;
GRANT SELECT ON TABLE public.widget_instances_legacy_retired TO service_role;

REVOKE ALL ON FUNCTION public.get_full_project_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_full_project_data(uuid) TO authenticated;
ALTER FUNCTION public.get_full_project_data(uuid) SET search_path TO '';

ALTER FUNCTION public.widget_summary_wave1(uuid, date, int) SET search_path TO pg_catalog, public;
REVOKE ALL ON FUNCTION public.widget_summary_wave1(uuid, date, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_summary_wave1(uuid, date, int) TO service_role;

ALTER FUNCTION public.widget_summary_fetch(uuid, date, int) SET search_path TO pg_catalog, public;
REVOKE ALL ON FUNCTION public.widget_summary_fetch(uuid, date, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_summary_fetch(uuid, date, int) TO service_role;

COMMIT;
