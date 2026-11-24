-- Connection-delete stays in local quarantine until a verified tombstone translation exists.
CREATE INDEX IF NOT EXISTS idx_sync_command_domain_apply_log_user
  ON public.sync_command_domain_apply_log (user_id);

CREATE OR REPLACE FUNCTION public.sync_apply_command_domain_tables()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_capabilities JSONB;
  domain_result JSONB;
  domain_status TEXT := 'skipped-capability-disabled';
  v_supported BOOLEAN := false;
BEGIN
  SELECT s.capabilities INTO v_capabilities FROM public.sync_protocol_state s WHERE s.scope='global';
  IF NOT (COALESCE(v_capabilities,'[]'::jsonb) @> '["domain-apply-v1"]'::jsonb) THEN RETURN NEW; END IF;
  v_supported := CASE NEW.entity_type
    WHEN 'project' THEN NEW.command IN ('project.create','project.update','project.delete','project.restore')
    WHEN 'task' THEN NEW.command IN ('task.create','task.update','task.delete','task.permanently_delete','task.restore','task.move','task.reorder','task.detach','task.assign','task.tags.update','task.parking_meta.update','task.attention_items.update','task.todo.update')
    WHEN 'connection' THEN NEW.command IN ('connection.create','connection.update','connection.restore','connection.reorder')
    WHEN 'black_box_entry' THEN NEW.command IN ('black_box_entry.create','black_box_entry.update')
    WHEN 'preference' THEN NEW.command IN ('preference.create','preference.update')
    WHEN 'focus_session' THEN NEW.command IN ('focus_session.create','focus_session.update')
    WHEN 'routine_task' THEN NEW.command IN ('routine_task.create','routine_task.update')
    WHEN 'routine_completion' THEN NEW.command='routine_completion.create'
    ELSE false END;
  IF NOT v_supported THEN
    domain_result:=jsonb_build_object('status','unsupported-domain-command','command',NEW.command,'entityType',NEW.entity_type);
    domain_status:='unsupported-domain-command';
  ELSE
    BEGIN
      IF NEW.entity_type='project' AND NEW.command='project.delete' THEN
        domain_result:=public.sync_delete_project(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'base_updated_at',NEW.base_updated_at,'project_id',NEW.entity_id,'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='task' AND NEW.command IN ('task.delete','task.permanently_delete') THEN
        domain_result:=public.sync_delete_tasks(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'base_updated_at',NEW.base_updated_at,'project_id',COALESCE(NEW.normalized_result_patch->>'project_id',NEW.normalized_result_patch->>'projectId',NEW.normalized_result_patch->'task'->>'project_id',NEW.normalized_result_patch->'task'->>'projectId',NEW.envelope->>'projectId',NEW.envelope->>'project_id'),'task_ids',jsonb_build_array(NEW.entity_id),'delete_mode',CASE WHEN NEW.command='task.permanently_delete' THEN 'purge' ELSE 'soft' END,'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='task' THEN
        domain_result:=public.sync_upsert_task(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'base_updated_at',NEW.base_updated_at,'task',COALESCE(NEW.normalized_result_patch->'task',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='project' THEN
        domain_result:=public.sync_upsert_project(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'base_updated_at',NEW.base_updated_at,'project',COALESCE(NEW.normalized_result_patch->'project',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='connection' THEN
        domain_result:=public.sync_upsert_connection(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'base_updated_at',NEW.base_updated_at,'connection',COALESCE(NEW.normalized_result_patch->'connection',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='black_box_entry' THEN
        domain_result:=public.sync_upsert_blackbox_entry(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'base_updated_at',NEW.base_updated_at,'entry',COALESCE(NEW.normalized_result_patch->'entry',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='preference' THEN
        domain_result:=public.sync_upsert_user_preferences(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'base_updated_at',NEW.base_updated_at,'user_id',NEW.user_id,'preferences',COALESCE(NEW.normalized_result_patch->'preferences',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='focus_session' THEN
        domain_result:=public.sync_upsert_focus_session(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'focus_session',COALESCE(NEW.normalized_result_patch->'focus_session',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='routine_task' THEN
        domain_result:=public.sync_upsert_routine_task(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'user_id',NEW.user_id,'routine_task',COALESCE(NEW.normalized_result_patch->'routine_task',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      ELSIF NEW.entity_type='routine_completion' THEN
        domain_result:=public.sync_increment_routine_completion(jsonb_build_object('operation_id',NEW.operation_id,'protocol_version',1,'user_id',NEW.user_id,'routine_completion',COALESCE(NEW.normalized_result_patch->'routine_completion',NEW.normalized_result_patch),'client_origin','offline-command-domain-apply'));
      END IF;
      domain_status:=COALESCE(domain_result->>'status','unknown');
      IF NEW.entity_type='connection' AND COALESCE(domain_result->>'stale_payload','false')='true' AND domain_status IN ('applied','idempotent-replay') THEN
        domain_result:=jsonb_build_object('status','stale-payload','reason','legacy-rpc-reported-stale-payload','entityType',NEW.entity_type,'entityId',NEW.entity_id,'rawRpcResult',domain_result);
        domain_status:='stale-payload';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      domain_result:=jsonb_build_object('status','domain-apply-error','message',SQLERRM);
      domain_status:='domain-apply-error';
    END;
  END IF;
  INSERT INTO public.sync_command_domain_apply_log(operation_id,user_id,entity_type,entity_id,status,result)
    VALUES (NEW.operation_id,NEW.user_id,NEW.entity_type,NEW.entity_id,domain_status,domain_result)
    ON CONFLICT (operation_id) DO UPDATE SET status=EXCLUDED.status,result=EXCLUDED.result;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_apply_command_domain_tables() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_apply_command_domain_tables() TO service_role;
COMMENT ON FUNCTION public.sync_apply_command_domain_tables() IS 'Owner-scoped v1 domain apply. Connection deletes remain unsupported until a verified tombstone translation exists.';
