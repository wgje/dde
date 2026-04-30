-- Guard BlackBox content from stale/partial sync payloads.
--
-- A blank retry payload must never replace an existing non-empty transcript.
-- The client also hydrates blank payloads before push, but this trigger protects
-- the database from old clients, fallback PostgREST upserts, and manual replay.
-- Existing rows keep their content so status flags can still converge.

CREATE OR REPLACE FUNCTION public.prevent_black_box_content_loss()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.content IS NULL OR btrim(NEW.content) = '' THEN
    IF TG_OP = 'UPDATE'
      AND OLD.content IS NOT NULL
      AND btrim(OLD.content) <> ''
    THEN
      NEW.content := OLD.content;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'black_box_content_required',
      DETAIL = 'black_box_entries.content cannot be empty for new entries.',
      HINT = 'Hydrate the outgoing BlackBox payload from IndexedDB or pull the current server row before retrying.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_black_box_content_loss ON public.black_box_entries;

CREATE TRIGGER protect_black_box_content_loss
BEFORE INSERT OR UPDATE ON public.black_box_entries
FOR EACH ROW
EXECUTE FUNCTION public.prevent_black_box_content_loss();

COMMENT ON FUNCTION public.prevent_black_box_content_loss() IS
  'Preserves existing non-empty black_box_entries.content when stale or partial sync payloads carry blank content.';

COMMENT ON TRIGGER protect_black_box_content_loss ON public.black_box_entries IS
  'Database safety net against BlackBox content loss from stale or partial sync payloads.';
