-- Make repeated external-source operations exact replays, not stale overwrites.
CREATE OR REPLACE FUNCTION public.prevent_external_source_links_stale_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.operation_id IS NOT NULL
    AND NEW.operation_id = OLD.operation_id
  THEN
    IF ROW(
      OLD.id, OLD.user_id, OLD.task_id, OLD.source_type, OLD.target_id,
      OLD.uri, OLD.label, OLD.hpath, OLD.role, OLD.sort_order,
      OLD.deleted_at, OLD.created_at, OLD.updated_at
    ) IS DISTINCT FROM ROW(
      NEW.id, NEW.user_id, NEW.task_id, NEW.source_type, NEW.target_id,
      NEW.uri, NEW.label, NEW.hpath, NEW.role, NEW.sort_order,
      NEW.deleted_at, NEW.created_at, NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'external_source_links operation replay payload mismatch'
        USING ERRCODE = '22023';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at > NEW.updated_at + interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at >= NEW.updated_at - interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_external_source_links_stale_write()
  FROM PUBLIC, anon, authenticated;
