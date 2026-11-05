import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const rlsMigrationPath =
  'supabase/migrations/20260715017600_project_members_rls_owner_initplan.sql';
const indexMigrationPath =
  'supabase/migrations/20260715017700_project_members_redundant_index_cleanup.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function lastPolicyBlock(sql: string, policyName: string): string {
  const normalized = normalize(sql);
  const start = normalized.lastIndexOf(`create policy "${policyName.toLowerCase()}"`);
  expect(start, `${policyName} should exist`).toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf(';', start);
  expect(end, `${policyName} should terminate`).toBeGreaterThan(start);
  return normalized.slice(start, end + 1);
}

function expectOwnerOnlyPolicies(sql: string): void {
  const ownerCheck = [
    'exists ( select 1 from public.projects p',
    'where p.id = project_members.project_id',
    'and p.owner_id = (select auth.uid())',
    'and p.deleted_at is null )',
  ].join(' ');
  const selectPolicy = lastPolicyBlock(sql, 'project_members select');
  const insertPolicy = lastPolicyBlock(sql, 'project_members insert');
  const updatePolicy = lastPolicyBlock(sql, 'project_members update');
  const deletePolicy = lastPolicyBlock(sql, 'project_members delete');

  expect(selectPolicy).toContain('for select to authenticated using');
  expect(selectPolicy).toContain(ownerCheck);
  expect(insertPolicy).toContain('for insert to authenticated with check');
  expect(insertPolicy).toContain(ownerCheck);
  expect(updatePolicy).toContain('for update to authenticated using');
  expect(updatePolicy).toContain('with check');
  expect(updatePolicy.split(ownerCheck)).toHaveLength(3);
  expect(deletePolicy).toContain('for delete to authenticated using');
  expect(deletePolicy).toContain(ownerCheck);

  for (const policy of [selectPolicy, insertPolicy, updatePolicy, deletePolicy]) {
    expect(policy).not.toContain('public.user_has_project_access(project_id)');
    expect(policy).not.toContain('(select public.user_has_project_access(project_id))');
  }
}

describe('project_members RLS and index performance contract', () => {
  it('keeps row-dependent owner checks correlated while caching only auth.uid in fresh init', () => {
    const initSql = read(initPath);

    expectOwnerOnlyPolicies(initSql);
    const normalized = normalize(initSql);
    expect(normalized).toContain(
      'revoke all on table public.project_members from anon, authenticated;',
    );
    expect(normalized).toContain(
      'grant select, insert, update, delete on table public.project_members to authenticated;',
    );
    expect(normalized).toContain(
      'grant all on table public.project_members to service_role;',
    );
  });

  it('repairs existing project_members policies without assuming the compatibility table exists', () => {
    const migration = read(rlsMigrationPath);

    expect(normalize(migration)).toContain("to_regclass('public.project_members')");
    expectOwnerOnlyPolicies(migration);
    expect(normalize(migration)).toContain(
      'revoke all on table public.project_members from anon, authenticated',
    );
    expect(normalize(migration)).toContain(
      'grant select, insert, update, delete on table public.project_members to authenticated',
    );
    expect(normalize(migration)).toContain(
      'grant all on table public.project_members to service_role',
    );
  });

  it('uses covering indexes instead of duplicate project_id and user_id indexes in fresh init', () => {
    const initSql = normalize(read(initPath));

    expect(initSql).toMatch(/unique\s*\(\s*project_id\s*,\s*user_id\s*\)/);
    expect(initSql).toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+idx_project_members_user_project\s+on\s+public\.project_members\s*\(\s*user_id\s*,\s*project_id\s*\)/,
    );
    expect(initSql).not.toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+idx_project_members_project_id\b/,
    );
    expect(initSql).not.toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+idx_project_members_user_id\b/,
    );
  });

  it('drops both redundant indexes with a fail-fast lock budget and rollback evidence', () => {
    const migration = normalize(read(indexMigrationPath));

    expect(migration).toContain("to_regclass('public.project_members')");
    expect(migration).toContain('from pg_constraint as constraint_row');
    expect(migration).toContain('constraint_index.indisvalid');
    expect(migration).toContain("index_relation.relname = 'idx_project_members_user_project'");
    expect(migration).toContain('covering_index.indisvalid');
    expect(migration).toContain(
      "raise exception 'project_members covering indexes are missing or invalid'",
    );
    expect(migration).toContain(
      "set local lock_timeout = '2s';",
    );
    expect(migration).toContain(
      'drop index if exists public.idx_project_members_project_id;',
    );
    expect(migration).toContain(
      'drop index if exists public.idx_project_members_user_id;',
    );
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('drop index concurrently');

    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        reason: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const entry = manifest.entries.find(item => item.path === indexMigrationPath);

    expect(entry).toBeUndefined();
    expect(migration).toContain(
      'rollback: create index concurrently idx_project_members_project_id on public.project_members(project_id);',
    );
    expect(migration).toContain(
      'rollback: create index concurrently idx_project_members_user_id on public.project_members(user_id);',
    );
  });
});
