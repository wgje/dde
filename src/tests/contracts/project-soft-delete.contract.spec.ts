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

function getLastSection(sql: string, startMarker: string, endMarker: string): string {
  const startIndex = sql.lastIndexOf(startMarker);
  expect(startIndex).toBeGreaterThanOrEqual(0);

  const endIndex = sql.indexOf(endMarker, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);

  return sql.slice(startIndex, endIndex);
}

describe('项目软删除契约', () => {
  it('init script 必须把 soft-deleted projects 视为不可访问且不可见', () => {
    const sql = readSql('scripts/init-supabase.sql');

    expect(sql).toContain('deleted_at TIMESTAMP WITH TIME ZONE');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)');

    const accessHelperSection = getLastSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_has_project_access(',
      'DROP POLICY IF EXISTS "owner select" ON public.projects;'
    );
    const ownerHelperSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_is_project_owner(',
      'CREATE OR REPLACE FUNCTION public.user_has_project_access('
    );
    const accessibleProjectIdsSection = getLastSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()',
      'CREATE OR REPLACE FUNCTION public.user_has_project_access('
    );
    const finalProjectsPolicySection = getLastSection(
      sql,
      'DROP POLICY IF EXISTS "owner select" ON public.projects;',
      'CREATE OR REPLACE FUNCTION public.cleanup_cron_job_run_details('
    );
    const fullProjectSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_full_project_data(',
      'COMMENT ON FUNCTION public.get_full_project_data(UUID) IS'
    );
    const userProjectsMetaSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_user_projects_meta(',
      'COMMENT ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) IS'
    );
    const projectSyncWatermarkSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_project_sync_watermark(',
      'REVOKE ALL ON FUNCTION public.get_project_sync_watermark(UUID) FROM PUBLIC;'
    );
    const accessibleProjectProbeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_accessible_project_probe(',
      'REVOKE ALL ON FUNCTION public.get_accessible_project_probe(UUID) FROM PUBLIC;'
    );
    const userProjectsWatermarkSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()',
      'REVOKE ALL ON FUNCTION public.get_user_projects_watermark() FROM PUBLIC;'
    );
    const resumeProbeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe(',
      'REVOKE ALL ON FUNCTION public.get_resume_recovery_probe(UUID) FROM PUBLIC;'
    );
    const softDeleteRpcSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)',
      'REVOKE EXECUTE ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon;'
    );

  expect(accessibleProjectIdsSection).toContain('AND deleted_at IS NULL');
    expect(accessHelperSection).toContain('AND p.deleted_at IS NULL');
    expect(ownerHelperSection).toContain('AND p.deleted_at IS NULL');
    expect(finalProjectsPolicySection).toContain('deleted_at IS NULL');
    expect(fullProjectSection).toContain('public.user_has_project_access(p_project_id)');
    expect(fullProjectSection).toContain('SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version');
    expect(userProjectsMetaSection).toContain('AND deleted_at IS NULL');
  expect(projectSyncWatermarkSection).toContain('AND p.deleted_at IS NULL');
  expect(accessibleProjectProbeSection).toContain('AND p.deleted_at IS NULL');
  expect(accessibleProjectProbeSection).toContain('SELECT p_project_id, FALSE, NULL::TIMESTAMPTZ');
    expect(userProjectsWatermarkSection).toContain('SELECT MAX(GREATEST(');
    expect(userProjectsWatermarkSection).toContain("COALESCE(p.deleted_at, '-infinity'::timestamptz)");
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('SELECT MAX(GREATEST(');
    expect(resumeProbeSection).toContain("COALESCE(p.deleted_at, '-infinity'::timestamptz)");
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(softDeleteRpcSection).toContain('FROM public.projects');
    expect(softDeleteRpcSection).toContain('FOR UPDATE');
    expect(softDeleteRpcSection).toContain('UPDATE public.tasks');
    expect(softDeleteRpcSection).toContain('WHERE project_id = p_project_id');
    expect(softDeleteRpcSection).toContain('AND deleted_at IS NULL');
    expect(softDeleteRpcSection).toContain('UPDATE public.connections');
    expect(softDeleteRpcSection).toContain('INSERT INTO public.task_tombstones');
    expect(softDeleteRpcSection).toContain('INSERT INTO public.connection_tombstones');
    expect(softDeleteRpcSection).toContain('SET deleted_at = v_operation_ts');
  });

  it('前向修复 migrations 必须补 deleted_at 列并收口项目删除一致性', () => {
    const sql = readSql('supabase/migrations/20260404103000_projects_soft_delete_alignment.sql');
    const softDeleteRpcSql = readSql('supabase/migrations/20260406143000_project_soft_delete_rpc.sql');
    const softDeleteConsistencySql = readSql('supabase/migrations/20260408050338_project_soft_delete_children_consistency.sql');
    const accessibleProjectIdsSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()',
      'CREATE OR REPLACE FUNCTION public.user_is_project_owner('
    );
    const projectSyncWatermarkSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_project_sync_watermark(',
      'CREATE OR REPLACE FUNCTION public.list_project_heads_since('
    );
    const accessibleProjectProbeSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_accessible_project_probe(',
      'CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()'
    );
    const userProjectsWatermarkSection = getSection(
      sql,
      'CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()',
      'CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe('
    );
    const resumeProbeStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe(');
    expect(resumeProbeStart).toBeGreaterThanOrEqual(0);
    const resumeProbeSection = sql.slice(resumeProbeStart);
    const softDeleteConsistencySection = getSection(
      softDeleteConsistencySql,
      'CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)',
      'REVOKE ALL ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon;'
    );

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id uuid)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id uuid)');
    expect(softDeleteRpcSql).toContain('CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)');
    expect(softDeleteConsistencySql).toContain('CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)');
    expect(sql).toContain('CREATE POLICY "owner select" ON public.projects');
    expect(sql).toContain('CREATE POLICY "tasks owner select" ON public.tasks');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.purge_tasks_v3(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.append_task_attachment(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.remove_task_attachment(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_accessible_project_probe(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe(');
    expect(sql).toContain('CREATE POLICY "project_members select" ON public.project_members\n      FOR SELECT\n      TO public\n      USING (public.user_has_project_access(project_id))');
    expect(sql).toContain('CREATE POLICY "project_members insert" ON public.project_members\n      FOR INSERT\n      TO public\n      WITH CHECK (public.user_has_project_access(project_id))');
    expect(sql).toContain('CREATE POLICY "project_members update" ON public.project_members\n      FOR UPDATE\n      TO public\n      USING (public.user_has_project_access(project_id))');
    expect(sql).toContain('CREATE POLICY "project_members delete" ON public.project_members\n      FOR DELETE\n      TO public\n      USING (public.user_has_project_access(project_id))');
    expect(sql).toContain('CREATE POLICY "tasks owner select" ON public.tasks\n  FOR SELECT\n  TO public\n  USING (public.user_has_project_access(project_id));');
    expect(sql).toContain('CREATE POLICY "tasks owner insert" ON public.tasks\n  FOR INSERT\n  TO public\n  WITH CHECK (public.user_has_project_access(project_id));');
    expect(sql).toContain('CREATE POLICY "tasks owner update" ON public.tasks\n  FOR UPDATE\n  TO public\n  USING (public.user_has_project_access(project_id));');
    expect(sql).toContain('CREATE POLICY "tasks owner delete" ON public.tasks\n  FOR DELETE\n  TO public\n  USING (public.user_has_project_access(project_id));');
    expect(sql).toContain('CREATE POLICY "connections owner select" ON public.connections\n  FOR SELECT\n  TO public\n  USING (public.user_has_project_access(project_id));');
    expect(sql).toContain('CREATE POLICY "connections owner insert" ON public.connections\n  FOR INSERT\n  TO public\n  WITH CHECK (public.user_has_project_access(project_id));');
    expect(sql).toContain('CREATE POLICY "connections owner update" ON public.connections\n  FOR UPDATE\n  TO public\n  USING (public.user_has_project_access(project_id));');
    expect(sql).toContain('CREATE POLICY "connections owner delete" ON public.connections\n  FOR DELETE\n  TO public\n  USING (public.user_has_project_access(project_id));');
    expect(accessibleProjectIdsSection).toContain('AND deleted_at IS NULL');
    expect(projectSyncWatermarkSection).toContain('AND p.deleted_at IS NULL');
    expect(accessibleProjectProbeSection).toContain('AND p.deleted_at IS NULL');
    expect(accessibleProjectProbeSection).toContain('SELECT p_project_id, FALSE, NULL::TIMESTAMPTZ');
    expect(userProjectsWatermarkSection).toContain('SELECT MAX(GREATEST(');
    expect(userProjectsWatermarkSection).toContain("COALESCE(p.deleted_at, '-infinity'::timestamptz)");
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(userProjectsWatermarkSection).toContain('JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('SELECT MAX(GREATEST(');
    expect(resumeProbeSection).toContain("COALESCE(p.deleted_at, '-infinity'::timestamptz)");
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(resumeProbeSection).toContain('JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL');
    expect(softDeleteConsistencySection).toContain('FOR UPDATE');
    expect(softDeleteConsistencySection).toContain('UPDATE public.tasks');
    expect(softDeleteConsistencySection).toContain('UPDATE public.connections');
    expect(softDeleteConsistencySection).toContain('INSERT INTO public.task_tombstones');
    expect(softDeleteConsistencySection).toContain('INSERT INTO public.connection_tombstones');
    expect(softDeleteConsistencySection).toContain('ON CONFLICT (task_id) DO UPDATE');
    expect(softDeleteConsistencySection).toContain('ON CONFLICT (connection_id) DO UPDATE');
    expect(softDeleteConsistencySql).toContain('p.deleted_at IS NOT NULL');
    expect(softDeleteConsistencySql).toContain('UPDATE public.tasks t');
    expect(softDeleteConsistencySql).toContain('UPDATE public.connections c');
    expect(softDeleteConsistencySql).toContain('JOIN public.projects p ON p.id = t.project_id');
    expect(softDeleteConsistencySql).toContain('JOIN public.projects p ON p.id = c.project_id');
  });

  it('客户端 Database 类型必须与项目相关 RPC 的可空返回保持一致', () => {
    const databaseTypes = readSql('src/types/supabase.ts');
    const modelTypes = readSql('src/models/supabase-types.ts');

    expect(databaseTypes).toContain('get_project_sync_watermark: {');
    expect(databaseTypes).toContain('Returns: string | null');
    expect(databaseTypes).toContain('watermark: string | null');
    expect(databaseTypes).toContain('active_project_id: string | null');
    expect(databaseTypes).toContain('active_watermark: string | null');
    expect(databaseTypes).toContain('projects_watermark: string | null');
    expect(databaseTypes).toContain('blackbox_watermark: string | null');
    expect(databaseTypes).toContain('get_user_projects_watermark: { Args: never; Returns: string | null }');

    expect(modelTypes).toContain('get_project_sync_watermark: {');
    expect(modelTypes).toContain('Returns: string | null;');
    expect(modelTypes).toContain('watermark: string | null;');
    expect(modelTypes).toContain('active_project_id: string | null;');
    expect(modelTypes).toContain('active_watermark: string | null;');
    expect(modelTypes).toContain('projects_watermark: string | null;');
    expect(modelTypes).toContain('blackbox_watermark: string | null;');
    expect(modelTypes).toContain('get_user_projects_watermark: {');
  });
});