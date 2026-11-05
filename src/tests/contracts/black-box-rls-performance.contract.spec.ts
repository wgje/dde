import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const policyMigrationPath =
  'supabase/migrations/20260715017200_black_box_rls_initplan_optimization.sql';
const indexMigrationPath =
  'supabase/migrations/20260715017300_black_box_project_fk_index.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function blackBoxPolicySection(sql: string): string {
  const normalized = normalize(sql);
  const start = normalized.indexOf(
    'drop policy if exists "black_box_select_optimized" on public.black_box_entries;',
  );
  expect(start, 'black_box policy section should start').toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf(
    'revoke all on table public.black_box_entries from anon, authenticated;',
    start,
  );
  expect(end, 'black_box policy section should end').toBeGreaterThan(start);
  return normalized.slice(start, end);
}

function expectInitPlanOwnerChecks(sql: string): void {
  const section = blackBoxPolicySection(sql);
  const initPlanChecks = section.match(
    /\(select public\.current_user_id\(\)\)\s*=\s*user_id/g,
  ) ?? [];

  expect(initPlanChecks).toHaveLength(5);
  expect(section).not.toMatch(/public\.current_user_id\(\)\s*=\s*user_id/);
}

describe('black_box_entries RLS performance contract', () => {
  it('uses initPlan-cached ownership checks in fresh initialization', () => {
    const initSql = read(initPath);

    expectInitPlanOwnerChecks(initSql);
    expect(normalize(initSql)).toMatch(
      /create index if not exists idx_black_box_entries_project_id on public\.black_box_entries\s*\(project_id\);/,
    );
  });

  it('repairs existing policy definitions with a transaction-safe forward migration', () => {
    const migration = read(policyMigrationPath);

    expectInitPlanOwnerChecks(migration);
    expect(normalize(migration)).not.toContain('begin;');
    expect(normalize(migration)).not.toContain('commit;');
  });

  it('restores the cascading foreign-key index concurrently with rollback evidence', () => {
    const migration = normalize(read(indexMigrationPath));
    expect(migration).toMatch(
      /create index concurrently if not exists idx_black_box_entries_project_id on public\.black_box_entries\s*\(project_id\);/,
    );

    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    expect(manifest.entries).toContainEqual(expect.objectContaining({
      path: indexMigrationPath,
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
  });
});
