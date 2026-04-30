-- Compatibility placeholder for migration version 20260126000000.
-- This optimization migration was generated against an already-populated remote
-- schema, but it sorts before the baseline remote_commit migration that creates
-- the referenced tables. Keep the version for remote history compatibility and
-- leave schema changes to the later forward migrations.
SELECT 1;
