import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715017800_project_graph_rls_set_membership_initplan.sql';

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
  const start = normalized.lastIndexOf(`create policy ${policyName.toLowerCase()} `);
  expect(start, `${policyName} should exist`).toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf(';', start);
  expect(end, `${policyName} should terminate`).toBeGreaterThan(start);
  return normalized.slice(start, end + 1);
}

function expectSetMembershipPolicy(
  sql: string,
  policyName: string,
  command: 'select' | 'insert' | 'update' | 'delete',
): void {
  const policy = lastPolicyBlock(sql, policyName);
  const ownerSet = [
    'project_id in ( select project_row.id',
    'from public.projects as project_row',
    'where project_row.owner_id = (select auth.uid())',
    'and project_row.deleted_at is null )',
  ].join(' ');

  expect(policy).toContain(`for ${command} to authenticated`);
  expect(policy).not.toContain('public.user_is_project_owner(project_id)');
  expect(policy).not.toContain('(select public.user_is_project_owner(project_id))');

  if (command === 'insert') {
    expect(policy).toContain('with check');
    expect(policy).toContain(ownerSet);
    return;
  }

  expect(policy).toContain('using');
  expect(policy).toContain(ownerSet);
  if (command === 'update') {
    expect(policy).toContain('with check');
    expect(policy.split(ownerSet)).toHaveLength(3);
  }
}

function expectCanonicalProjectGraphPolicies(sql: string): void {
  for (const [policyName, command] of [
    ['tasks_owner_select', 'select'],
    ['tasks_owner_insert', 'insert'],
    ['tasks_owner_update', 'update'],
    ['tasks_owner_delete', 'delete'],
    ['connections_owner_select', 'select'],
    ['connections_owner_insert', 'insert'],
    ['connections_owner_update', 'update'],
    ['connections_owner_delete', 'delete'],
    ['task_tombstones_owner_select', 'select'],
    ['task_tombstones_owner_insert', 'insert'],
    ['connection_tombstones_owner_select', 'select'],
    ['connection_tombstones_owner_insert', 'insert'],
  ] as const) {
    expectSetMembershipPolicy(sql, policyName, command);
  }
}

describe('project graph RLS initPlan performance contract', () => {
  it('uses statement-cached project membership in fresh initialization', () => {
    const initSql = read(initPath);

    expectCanonicalProjectGraphPolicies(initSql);
    expect(normalize(initSql)).toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+idx_projects_owner_updated_id\s+on\s+public\.projects\s*\(\s*owner_id\s*,\s*updated_at\s*,\s*id\s*\)/,
    );
  });

  it('repairs existing project graph policies with a transaction-safe forward migration', () => {
    const migration = read(migrationPath);

    expectCanonicalProjectGraphPolicies(migration);
    expect(normalize(migration)).not.toContain('index concurrently');
  });
});
