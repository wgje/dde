-- ============================================================================
-- Remove duplicate permissive policies after owner-only forward repairs.
-- Root cause: some live databases already carried optimized owner-only policies,
-- and the forward repair migration reintroduced equivalent legacy policy names.
-- This migration keeps the optimized policies and drops redundant duplicates to
-- reduce RLS evaluation overhead.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'black_box_entries'
      AND policyname = 'black_box_select_optimized'
  ) THEN
    DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'connection_tombstones'
      AND policyname = 'connection_tombstones_select_optimized'
  ) THEN
    DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'connection_tombstones'
      AND policyname = 'connection_tombstones_insert_optimized'
  ) THEN
    DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Users can view own attachments'
  ) THEN
    DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;
  END IF;
END $$;;
