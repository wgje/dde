import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSql(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function getSection(sql: string, startMarker: string, endMarker: string): string {
  const startIndex = sql.indexOf(startMarker);
  expect(startIndex).toBeGreaterThanOrEqual(0);

  const endIndex = sql.indexOf(endMarker, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);

  return sql.slice(startIndex, endIndex);
}

function expectOwnerOnlyBatchUpsert(section: string, ownerMarker: string): void {
  expect(section).toContain(ownerMarker);
  expect(section).not.toContain('FROM public.project_members pm');
  expect(section).toContain('INSERT INTO public.tasks AS existing');
  expect(section).not.toContain("COALESCE(v_task->'attachments', '[]'::jsonb)");
  expect(section).toContain("attachments = COALESCE(existing.attachments, '[]'::jsonb)");
  expect(section).toContain('WHERE existing.project_id = p_project_id');
  expect(section).toContain("RAISE EXCEPTION 'Task project mismatch'");
  expect(section).not.toContain('attachments = EXCLUDED.attachments');
}

function expectOwnerOnlyPurge(section: string): void {
  expect(section).toContain('p.id = p_project_id');
  expect(section).toContain('p.owner_id = auth.uid()');
  expect(section).toContain("RAISE EXCEPTION 'not authorized'");
  expect(section).toContain('WHERE t.project_id = p_project_id');
}

function expectOwnerOnlyAttachmentStorageRead(section: string): void {
  expect(section).toContain("bucket_id = 'attachments'");
  expect(section).toContain('(storage.foldername(name))[1] = auth.uid()::text');
  expect(section).not.toContain('project_members');
}

function expectOwnerOnlyProjectMembersPolicy(section: string): void {
  const normalized = section.replaceAll('"', '').replace(/\s+/g, ' ');

  expect(normalized).toContain('p.owner_id');
  expect(normalized).toContain('auth.uid()');
  expect(normalized).not.toContain('user_id =');
  expect(normalized).not.toContain('FROM public.project_members pm');
  expect(normalized).not.toContain("pm.role = 'admin'");
}

describe('SQL 安全加固契约', () => {
  it('init script 中的附件 RPC 必须校验项目访问权限', () => {
    const sql = readSql('scripts/init-supabase.sql');
    const appendSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION append_task_attachment',
      'CREATE OR REPLACE FUNCTION remove_task_attachment',
    );
    const removeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION remove_task_attachment',
      'GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;',
    );

    for (const section of [appendSection, removeSection]) {
      expect(section).toContain('public.user_is_project_owner');
      expect(section).toContain("RAISE EXCEPTION 'not authorized'");
      expect(section).toContain('FROM public.tasks');
    }
  });

  it('migration 中的附件 RPC 必须收紧为 owner-only', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const appendSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."append_task_attachment"',
      'ALTER FUNCTION "public"."append_task_attachment"',
    );
    const removeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."remove_task_attachment"',
      'ALTER FUNCTION "public"."remove_task_attachment"',
    );

    for (const section of [appendSection, removeSection]) {
      expect(section).toContain('FROM public.projects p');
      expect(section).toContain('owner_id = auth.uid()');
      expect(section).toContain("RAISE EXCEPTION 'not authorized'");
      expect(section).not.toContain('FROM public.project_members pm');
    }
  });

  it('项目读取与附件读取策略必须保持 owner-only', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260401100000_owner_only_batch_upsert_tasks.sql');

    const initProjectsPolicySection = getSection(
      initSql,
      'CREATE POLICY "owner select" ON public.projects FOR SELECT USING (',
      '-- ============================================\n-- 8. RLS 策略 - Project Members',
    );
    const initAttachmentPolicySection = getSection(
      initSql,
      'DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
      '-- ============================================',
    );
    const remoteCommitSelectPolicySection = getSection(
      remoteCommitSql,
      'CREATE POLICY "owner select" ON "public"."projects"',
      'CREATE POLICY "owner update" ON "public"."projects"',
    );
    const remoteCommitUpdatePolicySection = getSection(
      remoteCommitSql,
      'CREATE POLICY "owner update" ON "public"."projects"',
      'ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;',
    );
    const remoteCommitAttachmentPolicySection = getSection(
      remoteCommitSql,
      'create policy "Project members can view attachments"',
      'create policy "Users can delete own attachments"',
    );
    const remoteCommitLowerOwnerUpdateSection = getSection(
      remoteCommitSql,
      'create policy "owner update"',
      'create policy "Project members can view attachments"',
    );
    const ownerOnlyRepairProjectsPolicySection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "owner select" ON public.projects;',
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
    );
    const ownerOnlyRepairAttachmentPolicySection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
      'COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS',
    );

    expect(initProjectsPolicySection).toContain('(select auth.uid()) = owner_id');
    expect(initProjectsPolicySection).not.toContain('project_members');
    expectOwnerOnlyAttachmentStorageRead(initAttachmentPolicySection);

    for (const section of [remoteCommitSelectPolicySection, remoteCommitUpdatePolicySection]) {
      expect(section).toContain('( SELECT "auth"."uid"() AS "uid") = "owner_id"');
      expect(section).not.toContain('project_members');
    }

    expect(remoteCommitLowerOwnerUpdateSection).toContain('( SELECT auth.uid() AS uid) = owner_id');
    expect(remoteCommitLowerOwnerUpdateSection).not.toContain('project_members');

    expectOwnerOnlyAttachmentStorageRead(remoteCommitAttachmentPolicySection.replaceAll('(auth.uid())::text', 'auth.uid()::text'));
    expect(ownerOnlyRepairProjectsPolicySection).toContain('USING ((SELECT auth.uid() AS uid) = owner_id);');
    expectOwnerOnlyAttachmentStorageRead(ownerOnlyRepairAttachmentPolicySection);
  });

  it('project_members 过渡策略也必须收敛到 owner-only', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260401100000_owner_only_batch_upsert_tasks.sql');

    const initEarlyProjectMembersSection = getSection(
      initSql,
      'CREATE POLICY "project_members select" ON public.project_members FOR SELECT USING (',
      '-- ============================================\n-- 9. RLS 策略 - Tasks',
    );
    const initLaterProjectMembersSection = getSection(
      initSql,
      'CREATE POLICY "project_members select" ON public.project_members\n  FOR SELECT\n  TO public\n  USING (',
      'DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;',
    );
    const remoteCommitProjectMembersSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "project_members delete" ON "public"."project_members"',
      'ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;',
    );
    const ownerOnlyRepairProjectMembersSection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  IF to_regclass(\'public.project_members\') IS NOT NULL THEN',
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;',
    );

    for (const section of [
      initEarlyProjectMembersSection,
      initLaterProjectMembersSection,
      remoteCommitProjectMembersSection,
      ownerOnlyRepairProjectMembersSection,
    ]) {
      expectOwnerOnlyProjectMembersPolicy(section);
    }
  });

  it('batch_upsert_tasks 必须保持 owner-only 且不能批量覆盖已有 attachments', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const consolidatedSql = readSql('supabase/migrations/20260315200000_consolidated_focus_console_and_security.sql');
    const syncUnificationSql = readSql('supabase/migrations/20260318073718_security_sync_and_rpc_unification.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260401100000_owner_only_batch_upsert_tasks.sql');

    const initSection = getSection(
      initSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'COMMENT ON FUNCTION public.batch_upsert_tasks',
    );
    const remoteCommitSection = getSection(
      remoteCommitSql,
      'CREATE OR REPLACE FUNCTION "public"."batch_upsert_tasks"',
      'ALTER FUNCTION "public"."batch_upsert_tasks"',
    );
    const consolidatedSection = getSection(
      consolidatedSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS',
    );
    const syncUnificationSection = getSection(
      syncUnificationSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'DO $$ BEGIN\n  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;',
    );
    const ownerOnlyRepairSection = getSection(
      ownerOnlyRepairSql,
      'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(',
      'DO $$ BEGIN',
    );

    expectOwnerOnlyBatchUpsert(initSection, 'public.user_is_project_owner(p_project_id)');
    expectOwnerOnlyBatchUpsert(remoteCommitSection, 'AND p.owner_id = v_user_id');
    expectOwnerOnlyBatchUpsert(consolidatedSection, 'AND p.owner_id = v_user_id');
    expectOwnerOnlyBatchUpsert(syncUnificationSection, 'AND p.owner_id = v_user_id');
    expectOwnerOnlyBatchUpsert(ownerOnlyRepairSection, 'AND p.owner_id = v_user_id');
  });

  it('init script 中的 owner helper 与 purge RPC 必须保持 owner/project-scope 约束', () => {
    const sql = readSql('scripts/init-supabase.sql');
    const ownerHelperSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_is_project_owner(',
      'CREATE OR REPLACE FUNCTION public.user_has_project_access(',
    );
    const accessHelperSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_has_project_access(',
      'CREATE TABLE IF NOT EXISTS public.projects (',
    );
    const purgeV2Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION purge_tasks_v2(',
      'GRANT EXECUTE ON FUNCTION purge_tasks_v2(UUID, UUID[]) TO authenticated;',
    );
    const purgeV3Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.purge_tasks_v3(',
      'GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;',
    );

    expect(ownerHelperSection).toContain('AND p.owner_id = public.current_user_id()');
    expect(ownerHelperSection).not.toContain('project_members');
    expect(accessHelperSection).toContain('AND p.owner_id = public.current_user_id()');
    expect(accessHelperSection).not.toContain('project_members');
    expectOwnerOnlyPurge(purgeV2Section);
    expectOwnerOnlyPurge(purgeV3Section);
  });

  it('get_full_project_data 必须复用 owner-only access helper', () => {
    const sql = readSql('scripts/init-supabase.sql');
    const fullProjectSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_full_project_data(',
      'COMMENT ON FUNCTION public.get_full_project_data(UUID) IS',
    );

    expect(fullProjectSection).toContain('public.user_has_project_access(p_project_id)');
    expect(fullProjectSection).not.toContain('project_members');
  });

  it('remote commit migration 中的 purge RPC 必须保持 owner/project-scope 约束', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const purgeV2Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."purge_tasks_v2"',
      'ALTER FUNCTION "public"."purge_tasks_v2"',
    );
    const purgeV3Section = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION "public"."purge_tasks_v3"',
      'ALTER FUNCTION "public"."purge_tasks_v3"',
    );

    expectOwnerOnlyPurge(purgeV2Section);
    expectOwnerOnlyPurge(purgeV3Section);
  });

  it('黑匣子与 connection tombstone 访问口必须保持 owner-only', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const remoteCommitSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260401100000_owner_only_batch_upsert_tasks.sql');

    const initConnectionPolicySection = getSection(
      initSql,
      '-- 修复 connection_tombstones 表 RLS 策略',
      '-- 更新相关函数的 auth.uid() 调用也使用 initplan',
    );
    const initIsConnectionTombstonedSection = getSection(
      initSql,
      'CREATE OR REPLACE FUNCTION is_connection_tombstoned(',
      'GRANT EXECUTE ON FUNCTION is_connection_tombstoned(UUID) TO authenticated;',
    );
    const remoteCommitBlackBoxSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "black_box_select_policy" ON "public"."black_box_entries"',
      'CREATE POLICY "black_box_update_policy" ON "public"."black_box_entries"',
    );
    const remoteCommitConnectionInsertSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "connection_tombstones_insert" ON "public"."connection_tombstones"',
      'COMMENT ON POLICY "connection_tombstones_insert" ON "public"."connection_tombstones"',
    );
    const remoteCommitConnectionSelectSection = getSection(
      remoteCommitSql,
      'CREATE POLICY "connection_tombstones_select" ON "public"."connection_tombstones"',
      'COMMENT ON POLICY "connection_tombstones_select" ON "public"."connection_tombstones"',
    );
    const remoteCommitIsConnectionTombstonedSection = getSection(
      remoteCommitSql,
      'CREATE OR REPLACE FUNCTION "public"."is_connection_tombstoned"',
      'ALTER FUNCTION "public"."is_connection_tombstoned"',
    );
    const ownerOnlyRepairConnectionPoliciesSection = getSection(
      ownerOnlyRepairSql,
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;',
      'DO $$ BEGIN\n  DROP POLICY IF EXISTS "owner select" ON public.projects;',
    );
    const ownerOnlyRepairIsConnectionTombstonedSection = getSection(
      ownerOnlyRepairSql,
      'CREATE OR REPLACE FUNCTION public.is_connection_tombstoned(',
      'COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS',
    );

    expect(remoteCommitBlackBoxSection).toContain('"projects"."owner_id" = ( SELECT "auth"."uid"() AS "uid")');
    expect(remoteCommitBlackBoxSection).not.toContain('project_members');

    expect(initConnectionPolicySection).toContain('public.user_is_project_owner(project_id)');
    expect(initConnectionPolicySection).not.toContain('project_members');
    expect(initIsConnectionTombstonedSection).toContain('p.owner_id = auth.uid()');
    expect(initIsConnectionTombstonedSection).not.toContain('project_members');

    for (const section of [remoteCommitConnectionInsertSection, remoteCommitConnectionSelectSection]) {
      expect(section).toContain('"projects"."owner_id" = ( SELECT "auth"."uid"() AS "uid")');
      expect(section).not.toContain('project_members');
    }

    expect(remoteCommitIsConnectionTombstonedSection).toContain('p.owner_id = auth.uid()');
    expect(remoteCommitIsConnectionTombstonedSection).not.toContain('project_members');
    expect(ownerOnlyRepairConnectionPoliciesSection).toContain('public.user_is_project_owner(project_id)');
    expect(ownerOnlyRepairConnectionPoliciesSection).toContain('p.owner_id = auth.uid()');
    expect(ownerOnlyRepairConnectionPoliciesSection).not.toContain('project_members');
    expect(ownerOnlyRepairIsConnectionTombstonedSection).toContain('p.owner_id = auth.uid()');
    expect(ownerOnlyRepairIsConnectionTombstonedSection).not.toContain('project_members');
  });

  it('migration 中的迁移工具不应暴露给 authenticated', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');

    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."migrate_all_projects_to_v2"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."migrate_project_data_to_v2"("p_project_id" "uuid") FROM "authenticated";');
  });

  it('migration 中的维护函数不应暴露给 authenticated', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');

    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_deleted_attachments"("retention_days" integer) FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_expired_scan_records"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_old_deleted_connections"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_old_deleted_tasks"() FROM "authenticated";');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."cleanup_old_logs"() FROM "authenticated";');
  });

  it('migration 中的核心业务表不应继续向 anon 暴露', () => {
    const sql = readSql('supabase/migrations/20260126074130_remote_commit.sql');

    expect(sql).toContain('REVOKE ALL ON TABLE "public"."tasks" FROM "anon";');
    expect(sql).toContain('REVOKE ALL ON TABLE "public"."projects" FROM "anon";');
    expect(sql).toContain('REVOKE ALL ON TABLE "public"."connections" FROM "anon";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "authenticated";');
  });

  it('旧 purge_tasks 入口不应继续向 authenticated 暴露', () => {
    const initSql = readSql('scripts/init-supabase.sql');
    const migrationSql = readSql('supabase/migrations/20260126074130_remote_commit.sql');
    const ownerOnlyRepairSql = readSql('supabase/migrations/20260401100000_owner_only_batch_upsert_tasks.sql');

    expect(initSql).toContain('REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;');
    expect(migrationSql).toContain('REVOKE ALL ON FUNCTION "public"."purge_tasks"("p_task_ids" "uuid"[]) FROM "authenticated";');
    expect(ownerOnlyRepairSql).toContain('REVOKE ALL ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;');
  });

  it('前向修复迁移必须覆盖附件 RPC 与 legacy purge 权限最终态', () => {
    const sql = readSql('supabase/migrations/20260401100000_owner_only_batch_upsert_tasks.sql');
    const appendSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.append_task_attachment(',
      'CREATE OR REPLACE FUNCTION public.remove_task_attachment(',
    );
    const removeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.remove_task_attachment(',
      'DO $$ BEGIN\n  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;',
    );

    for (const section of [appendSection, removeSection]) {
      expect(section).toContain('FROM public.projects p');
      expect(section).toContain('owner_id = auth.uid()');
      expect(section).toContain("RAISE EXCEPTION 'not authorized'");
    }

    expect(sql).toContain('REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.purge_rate_limits FROM authenticated;');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;');
  });

  it('重复策略清理迁移必须移除与 optimized policy 重叠的 owner-only 策略', () => {
    const sql = readSql('supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql');

    expect(sql).toContain("policyname = 'black_box_select_optimized'");
    expect(sql).toContain('DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;');
    expect(sql).toContain("policyname = 'connection_tombstones_select_optimized'");
    expect(sql).toContain('DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;');
    expect(sql).toContain("policyname = 'connection_tombstones_insert_optimized'");
    expect(sql).toContain('DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;');
    expect(sql).toContain("policyname = 'Users can view own attachments'");
    expect(sql).toContain('DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;');
  });
});