-- The composite primary key already covers owner/entity projection lookups.
-- Remove the identical secondary index to avoid duplicated write and storage cost.
DROP INDEX IF EXISTS public.idx_sync_command_projection_owner_entity;