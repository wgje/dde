-- Match Black Box user-scoped keyset pagination and watermark lookups.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_black_box_entries_user_updated_id
  ON public.black_box_entries (user_id, updated_at, id);
