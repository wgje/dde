-- Keep table owners subject to the same RLS boundary as API callers.
-- Supabase's postgres/service roles retain their explicit BYPASSRLS semantics.

ALTER TABLE public.sync_operation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_operation_log FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sync_protocol_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_protocol_state FORCE ROW LEVEL SECURITY;
