BEGIN;

-- 跟进 20260427163000_reconcile_remote_migration_drift.sql：
-- 上一个迁移用 `CREATE TABLE ... AS TABLE ... WITH NO DATA` 创建了
-- public.widget_devices_legacy_retired / public.widget_instances_legacy_retired，
-- 但 `AS TABLE` 只复制列结构，不复制 RLS 与 GRANT。
-- 这两张表承载 secret_hash / token_hash 等敏感字段，必须显式：
--   1) 启用 RLS 并默认拒绝
--   2) 撤销 anon / authenticated 的访问权限
--   3) 仅授予 service_role 必要权限
-- 同时附加注释，说明仅供退役归档使用，不能从客户端直接查询。

ALTER TABLE public.widget_devices_legacy_retired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_devices_legacy_retired FORCE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances_legacy_retired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances_legacy_retired FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS widget_devices_legacy_retired_no_select
  ON public.widget_devices_legacy_retired;
DROP POLICY IF EXISTS widget_instances_legacy_retired_no_select
  ON public.widget_instances_legacy_retired;

-- 默认拒绝所有 PostgREST 角色访问；仅允许 service_role 通过 Edge Functions / 后台任务读写。
CREATE POLICY widget_devices_legacy_retired_no_select
  ON public.widget_devices_legacy_retired
  FOR SELECT
  TO authenticated, anon
  USING (false);

CREATE POLICY widget_instances_legacy_retired_no_select
  ON public.widget_instances_legacy_retired
  FOR SELECT
  TO authenticated, anon
  USING (false);

REVOKE ALL ON TABLE public.widget_devices_legacy_retired FROM PUBLIC;
REVOKE ALL ON TABLE public.widget_devices_legacy_retired FROM anon;
REVOKE ALL ON TABLE public.widget_devices_legacy_retired FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.widget_devices_legacy_retired
  TO service_role;

REVOKE ALL ON TABLE public.widget_instances_legacy_retired FROM PUBLIC;
REVOKE ALL ON TABLE public.widget_instances_legacy_retired FROM anon;
REVOKE ALL ON TABLE public.widget_instances_legacy_retired FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.widget_instances_legacy_retired
  TO service_role;

COMMENT ON TABLE public.widget_devices_legacy_retired IS
  '已退役的非 android-widget 设备归档（含 secret_hash/token_hash），仅供 service_role 审计与回溯。客户端不得直接访问。';
COMMENT ON TABLE public.widget_instances_legacy_retired IS
  '已退役的非 android-widget 实例归档，仅供 service_role 审计与回溯。客户端不得直接访问。';

COMMIT;
