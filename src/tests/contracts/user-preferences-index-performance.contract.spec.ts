import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715017500_user_preferences_redundant_index_cleanup.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('user_preferences index performance contract', () => {
  it('uses the UNIQUE(user_id) constraint index without a duplicate fresh-init index', () => {
    const initSql = normalize(read(initPath));

    expect(initSql).toMatch(/unique\s*\(\s*user_id\s*\)/);
    expect(initSql).not.toMatch(
      /create\s+(?:unique\s+)?index(?:\s+if\s+not\s+exists)?\s+idx_user_preferences_user_id\b/,
    );
  });

  it('drops the redundant index with a fail-fast transactional lock budget', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain("to_regclass('public.user_preferences')");
    expect(migration).toContain('from pg_constraint as constraint_row');
    expect(migration).toContain('constraint_index.indisvalid');
    expect(migration).toContain('constraint_index.indisready');
    expect(migration).toContain(
      "raise exception 'user_preferences unique(user_id) covering index is missing or invalid'",
    );
    expect(migration).toContain(
      "set local lock_timeout = '2s';",
    );
    expect(migration).toContain('drop index if exists public.idx_user_preferences_user_id;');
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('drop index concurrently');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('keeps concurrent rollback evidence without an out-of-transaction manifest entry', () => {
    const migration = normalize(read(migrationPath));
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        reason: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const entry = manifest.entries.find(item => item.path === migrationPath);

    expect(entry).toBeUndefined();
    expect(migration).toContain(
      'rollback: create index concurrently idx_user_preferences_user_id on public.user_preferences(user_id);',
    );
  });
});
