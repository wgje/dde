-- Support stable, user-scoped full pulls ordered by immutable link id.

CREATE INDEX CONCURRENTLY IF NOT EXISTS external_source_links_user_id_cursor_idx
  ON public.external_source_links (user_id, id);
