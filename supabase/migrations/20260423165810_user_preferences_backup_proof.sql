ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS last_backup_proof_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

CREATE OR REPLACE FUNCTION public.user_preferences_keep_latest_backup_proof()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.last_backup_proof_at IS NOT NULL
     AND (
       NEW.last_backup_proof_at IS NULL
       OR NEW.last_backup_proof_at < OLD.last_backup_proof_at
     ) THEN
    NEW.last_backup_proof_at := OLD.last_backup_proof_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS keep_latest_backup_proof_on_user_preferences ON public.user_preferences;
CREATE TRIGGER keep_latest_backup_proof_on_user_preferences
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.user_preferences_keep_latest_backup_proof();;
