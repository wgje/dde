-- Knowledge Anchor / SiYuan external source pointers.
-- Only lightweight pointers are stored here. SiYuan token and preview body/cache remain local-only.

CREATE TABLE IF NOT EXISTS public.external_source_links (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  source_type text NOT NULL DEFAULT 'siyuan-block',
  target_id text NOT NULL,
  uri text NOT NULL,
  label text,
  hpath text,
  role text,
  sort_order integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_source_links_source_type_check CHECK (source_type = 'siyuan-block'),
  CONSTRAINT external_source_links_target_id_check CHECK (target_id ~ '^\d{14}-[A-Za-z0-9]{7}$'),
  CONSTRAINT external_source_links_role_check CHECK (role IS NULL OR role IN ('context', 'spec', 'reference', 'evidence', 'next-action')),
  CONSTRAINT external_source_links_uri_check CHECK (uri ~ '^siyuan://blocks/\d{14}-[A-Za-z0-9]{7}\?focus=1$'),
  CONSTRAINT external_source_links_id_length_check CHECK (char_length(id) <= 64),
  CONSTRAINT external_source_links_uri_length_check CHECK (char_length(uri) <= 128),
  CONSTRAINT external_source_links_label_length_check CHECK (label IS NULL OR char_length(label) <= 256),
  CONSTRAINT external_source_links_hpath_length_check CHECK (hpath IS NULL OR char_length(hpath) <= 1024)
);

CREATE INDEX IF NOT EXISTS external_source_links_user_updated_idx
  ON public.external_source_links (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS external_source_links_task_idx
  ON public.external_source_links (task_id, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS external_source_links_unique_active_target
  ON public.external_source_links (user_id, task_id, source_type, target_id)
  WHERE deleted_at IS NULL;

ALTER TABLE public.external_source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_source_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS external_source_links_owner_select ON public.external_source_links;
CREATE POLICY external_source_links_owner_select
  ON public.external_source_links
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS external_source_links_owner_insert ON public.external_source_links;
CREATE POLICY external_source_links_owner_insert
  ON public.external_source_links
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks t
      JOIN public.projects p ON p.id = t.project_id
      WHERE t.id = external_source_links.task_id
        AND p.owner_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS external_source_links_owner_update ON public.external_source_links;
CREATE POLICY external_source_links_owner_update
  ON public.external_source_links
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks t
      JOIN public.projects p ON p.id = t.project_id
      WHERE t.id = external_source_links.task_id
        AND p.owner_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS external_source_links_owner_delete ON public.external_source_links;
CREATE POLICY external_source_links_owner_delete
  ON public.external_source_links
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.external_source_links TO authenticated;
REVOKE ALL ON public.external_source_links FROM anon;
