CREATE OR REPLACE FUNCTION public.sync_apply_command_projection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_capabilities JSONB;
  current_row public.sync_command_projection%ROWTYPE;
  next_fields JSONB;
  next_versions JSONB;
  incoming_version JSONB;
  existing_version JSONB;
  field_key TEXT;
  field_value JSONB;
  is_delete BOOLEAN := NEW.command LIKE '%.delete' OR NEW.command LIKE '%.permanently_delete';
  is_restore BOOLEAN := NEW.command LIKE '%.restore';
BEGIN
  SELECT s.capabilities INTO v_capabilities FROM public.sync_protocol_state AS s WHERE s.scope = 'global';
  IF NOT (COALESCE(v_capabilities, '[]'::jsonb) @> '["field-lww-v1"]'::jsonb) THEN RETURN NEW; END IF;
  SELECT * INTO current_row FROM public.sync_command_projection WHERE user_id = NEW.user_id AND entity_type = NEW.entity_type AND entity_id = NEW.entity_id FOR UPDATE;
  next_fields := COALESCE(current_row.fields, '{}'::jsonb);
  next_versions := COALESCE(current_row.field_versions, '{}'::jsonb);
  incoming_version := jsonb_build_object('physicalMs', NEW.logical_clock_physical_ms, 'logical', NEW.logical_clock_logical, 'deviceId', NEW.device_id, 'operationId', NEW.operation_id);
  IF current_row.tombstone IS NOT NULL AND NOT is_restore THEN
    IF public.sync_compare_command_version(current_row.tombstone, incoming_version) >= 0 THEN RETURN NEW; END IF;
  END IF;
  IF is_delete OR is_restore THEN
    IF current_row.tombstone IS NULL OR public.sync_compare_command_version(current_row.tombstone, incoming_version) > 0 THEN
      INSERT INTO public.sync_command_projection(user_id, entity_type, entity_id, fields, field_versions, tombstone, updated_at)
      VALUES (NEW.user_id, NEW.entity_type, NEW.entity_id, next_fields, next_versions, CASE WHEN is_delete THEN incoming_version ELSE NULL END, now())
      ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET fields = EXCLUDED.fields, field_versions = EXCLUDED.field_versions, tombstone = EXCLUDED.tombstone, updated_at = EXCLUDED.updated_at;
    END IF;
    RETURN NEW;
  END IF;
  FOR field_key, field_value IN SELECT key, value FROM jsonb_each(NEW.normalized_result_patch) LOOP
    incoming_version := COALESCE(NEW.field_versions->field_key, jsonb_build_object('physicalMs', NEW.logical_clock_physical_ms, 'logical', NEW.logical_clock_logical, 'deviceId', NEW.device_id, 'operationId', NEW.operation_id));
    existing_version := next_versions->field_key;
    IF public.sync_compare_command_version(existing_version, incoming_version) > 0 THEN
      next_fields := jsonb_set(next_fields, ARRAY[field_key], field_value, true);
      next_versions := jsonb_set(next_versions, ARRAY[field_key], incoming_version, true);
    END IF;
  END LOOP;
  INSERT INTO public.sync_command_projection(user_id, entity_type, entity_id, fields, field_versions, tombstone, updated_at)
  VALUES (NEW.user_id, NEW.entity_type, NEW.entity_id, next_fields, next_versions, current_row.tombstone, now())
  ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET fields = EXCLUDED.fields, field_versions = EXCLUDED.field_versions, tombstone = EXCLUDED.tombstone, updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_apply_command_projection() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_apply_command_projection() TO service_role;