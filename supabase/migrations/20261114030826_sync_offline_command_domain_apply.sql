CREATE TABLE IF NOT EXISTS public.sync_command_domain_apply_log (
  operation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sync_command_domain_apply_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_command_domain_apply_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_command_domain_apply_log FROM PUBLIC, anon;
GRANT SELECT ON public.sync_command_domain_apply_log TO authenticated;
GRANT ALL ON public.sync_command_domain_apply_log TO service_role;
DROP POLICY IF EXISTS sync_command_domain_apply_log_owner_select ON public.sync_command_domain_apply_log;
CREATE POLICY sync_command_domain_apply_log_owner_select ON public.sync_command_domain_apply_log FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE OR REPLACE FUNCTION public.sync_apply_command_domain_tables()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  capabilities JSONB;
  domain_result JSONB;
  domain_status TEXT := 'skipped-capability-disabled';
BEGIN
  SELECT capabilities INTO capabilities FROM public.sync_protocol_state WHERE scope = 'global';
  IF NOT (COALESCE(capabilities, '[]'::jsonb) @> '["domain-apply-v1"]'::jsonb) THEN RETURN NEW; END IF;
  BEGIN
    IF NEW.entity_type = 'project' AND NEW.command LIKE '%.delete' THEN
      domain_result := public.sync_delete_project(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'base_updated_at', NEW.base_updated_at, 'project_id', NEW.entity_id, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'task' AND (NEW.command LIKE '%.delete' OR NEW.command LIKE '%.permanently_delete') THEN
      domain_result := public.sync_delete_tasks(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'base_updated_at', NEW.base_updated_at, 'project_id', COALESCE(NEW.normalized_result_patch->>'project_id', NEW.normalized_result_patch->>'projectId'), 'task_ids', jsonb_build_array(NEW.entity_id), 'delete_mode', CASE WHEN NEW.command LIKE '%.permanently_delete' THEN 'purge' ELSE 'soft' END, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'task' THEN
      domain_result := public.sync_upsert_task(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'base_updated_at', NEW.base_updated_at, 'task', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'project' THEN
      domain_result := public.sync_upsert_project(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'base_updated_at', NEW.base_updated_at, 'project', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'connection' THEN
      domain_result := public.sync_upsert_connection(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'base_updated_at', NEW.base_updated_at, 'connection', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'black_box_entry' THEN
      domain_result := public.sync_upsert_blackbox_entry(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'base_updated_at', NEW.base_updated_at, 'entry', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'preference' THEN
      domain_result := public.sync_upsert_user_preferences(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'base_updated_at', NEW.base_updated_at, 'user_id', NEW.user_id, 'preferences', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'focus_session' THEN
      domain_result := public.sync_upsert_focus_session(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'focus_session', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'routine_task' THEN
      domain_result := public.sync_upsert_routine_task(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'user_id', NEW.user_id, 'routine_task', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSIF NEW.entity_type = 'routine_completion' THEN
      domain_result := public.sync_increment_routine_completion(jsonb_build_object('operation_id', NEW.operation_id, 'protocol_version', 1, 'user_id', NEW.user_id, 'routine_completion', NEW.normalized_result_patch, 'client_origin', 'offline-command-domain-apply'));
    ELSE
      domain_result := jsonb_build_object('status', 'unsupported-domain-entity');
    END IF;
    domain_status := COALESCE(domain_result->>'status', 'unknown');
  EXCEPTION WHEN OTHERS THEN
    domain_result := jsonb_build_object('status', 'domain-apply-error', 'message', SQLERRM);
    domain_status := 'domain-apply-error';
  END;
  INSERT INTO public.sync_command_domain_apply_log(operation_id, user_id, entity_type, entity_id, status, result)
  VALUES (NEW.operation_id, NEW.user_id, NEW.entity_type, NEW.entity_id, domain_status, domain_result)
  ON CONFLICT (operation_id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zzz_sync_command_domain_apply ON public.sync_command_log;
CREATE TRIGGER zzz_sync_command_domain_apply AFTER INSERT ON public.sync_command_log FOR EACH ROW EXECUTE FUNCTION public.sync_apply_command_domain_tables();
REVOKE ALL ON FUNCTION public.sync_apply_command_domain_tables() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_apply_command_domain_tables() TO service_role;