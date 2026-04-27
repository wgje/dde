BEGIN;

ALTER TABLE public.connection_tombstones
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS target_id uuid;

UPDATE public.connection_tombstones ct
SET
  source_id = c.source_id,
  target_id = c.target_id
FROM public.connections c
WHERE ct.connection_id = c.id
  AND (ct.source_id IS NULL OR ct.target_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_source_target_deleted
  ON public.connection_tombstones (project_id, source_id, target_id, deleted_at DESC)
  WHERE source_id IS NOT NULL AND target_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_connection_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  INSERT INTO public.connection_tombstones (
    connection_id,
    project_id,
    source_id,
    target_id,
    deleted_at,
    deleted_by
  )
  VALUES (
    OLD.id,
    OLD.project_id,
    OLD.source_id,
    OLD.target_id,
    now(),
    auth.uid()
  )
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    source_id = COALESCE(EXCLUDED.source_id, public.connection_tombstones.source_id),
    target_id = COALESCE(EXCLUDED.target_id, public.connection_tombstones.target_id),
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  RETURN OLD;
END;
$$;

COMMIT;;
