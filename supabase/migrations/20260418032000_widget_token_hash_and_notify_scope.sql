ALTER TABLE public.widget_devices
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_devices_token_hash
  ON public.widget_devices (token_hash)
  WHERE token_hash IS NOT NULL;

DROP TRIGGER IF EXISTS widget_notify_task_change ON public.tasks;
CREATE TRIGGER widget_notify_task_change
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_project_change ON public.projects;
CREATE TRIGGER widget_notify_project_change
  AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();
