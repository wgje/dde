-- ============================================================================
-- Re-add missing FK covering indexes for backup tables
-- Date: 2026-03-18
-- Reason:
--   Supabase advisor reported unindexed foreign keys on:
--   - public.backup_metadata(user_id)
--   - public.backup_restore_history(backup_id)
--
-- Notes:
--   These indexes are required to avoid FK check full scans for maintenance deletes.
--   Keep this migration idempotent for existing environments.
-- ============================================================================

DO $retired_cloud_backup_fk_indexes$
BEGIN
  IF to_regclass('public.backup_metadata') IS NULL
    OR to_regclass('public.backup_restore_history') IS NULL THEN
    RAISE NOTICE 'Skipping retired cloud backup FK covering indexes; backup tables are absent.';
  ELSE
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_metadata_user_id
        ON public.backup_metadata(user_id)
    $sql$;
    EXECUTE $sql$
      COMMENT ON INDEX public.idx_backup_metadata_user_id IS
        'FK enforcement: user_id references auth.users(id). ON DELETE SET NULL.'
    $sql$;
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_restore_history_backup_id
        ON public.backup_restore_history(backup_id)
    $sql$;
    EXECUTE $sql$
      COMMENT ON INDEX public.idx_backup_restore_history_backup_id IS
        'FK enforcement: backup_id references backup_metadata(id). ON DELETE CASCADE.'
    $sql$;
  END IF;
END
$retired_cloud_backup_fk_indexes$;
