-- Future public-schema functions are private until a migration explicitly
-- grants EXECUTE to the intended Supabase role.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
