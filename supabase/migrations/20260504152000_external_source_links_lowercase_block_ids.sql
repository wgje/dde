-- Align SiYuan block id constraints with the frontend parser: uppercase letters are invalid.
-- Existing uppercase rows are rejected instead of silently rewritten, because target_id is an external pointer.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.external_source_links
    WHERE target_id !~ '^\d{14}-[a-z0-9]{7}$'
      OR uri !~ '^siyuan://blocks/\d{14}-[a-z0-9]{7}\?focus=1$'
  ) THEN
    RAISE EXCEPTION 'external_source_links contains non-lowercase SiYuan block ids; clean data before applying constraint';
  END IF;
END $$;

ALTER TABLE public.external_source_links
  DROP CONSTRAINT IF EXISTS external_source_links_target_id_check;

ALTER TABLE public.external_source_links
  ADD CONSTRAINT external_source_links_target_id_check
  CHECK (target_id ~ '^\d{14}-[a-z0-9]{7}$');

ALTER TABLE public.external_source_links
  DROP CONSTRAINT IF EXISTS external_source_links_uri_check;

ALTER TABLE public.external_source_links
  ADD CONSTRAINT external_source_links_uri_check
  CHECK (uri ~ '^siyuan://blocks/\d{14}-[a-z0-9]{7}\?focus=1$');
