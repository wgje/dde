-- Attachment-internal tables are operated only through service-role workers.
-- Revoke historical/default owner-like grants before restoring ordinary DML.

ALTER TABLE public.attachment_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quarantined_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quarantined_files FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_jobs FORCE ROW LEVEL SECURITY;

REVOKE ALL
  ON TABLE public.attachment_scans,
           public.quarantined_files,
           public.attachment_cleanup_jobs
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.attachment_scans,
           public.quarantined_files,
           public.attachment_cleanup_jobs
  TO service_role;
