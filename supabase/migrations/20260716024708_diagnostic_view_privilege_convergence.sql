-- CREATE OR REPLACE VIEW preserves existing ACLs. Explicitly clear any
-- historical/manual grants before restoring the authenticated read boundary.
SET LOCAL lock_timeout = '2s';

REVOKE ALL ON TABLE
  public.project_structure_audit,
  public.stage_null_recovery_diagnostics
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.project_structure_audit,
  public.stage_null_recovery_diagnostics
TO authenticated;

SET LOCAL lock_timeout = DEFAULT;
