import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const querySourcePath = 'src/services/black-box-sync-pull.helpers.ts';
const createMigrationPath =
  'supabase/migrations/20260715018600_black_box_keyset_covering_index.sql';
const cleanupMigrationPath =
  'supabase/migrations/20260715018700_black_box_redundant_index_cleanup.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('Black Box keyset index performance contract', () => {
  it('keeps user equality before the updated_at/id cursor order', () => {
    const source = normalize(read(querySourcePath));
    const userScopeIndex = source.indexOf("basequery = eqquery('user_id', options.expecteduserid)");
    const updatedAtOrderIndex = source.indexOf(".order('updated_at', { ascending: true })");
    const idOrderIndex = source.indexOf(".order('id', { ascending: true })", updatedAtOrderIndex);

    expect(source).toContain(".from('black_box_entries')");
    expect(source).toContain('createsafeblackboxkeysetfilter(cursor)');
    expect(userScopeIndex).toBeGreaterThanOrEqual(0);
    expect(updatedAtOrderIndex).toBeGreaterThan(userScopeIndex);
    expect(idOrderIndex).toBeGreaterThan(updatedAtOrderIndex);
  });

  it('uses one three-column keyset index in fresh init', () => {
    const init = normalize(read(initPath));

    expect(init).toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+idx_black_box_entries_user_updated_id\s+on\s+public\.black_box_entries\s*\(\s*user_id\s*,\s*updated_at\s*,\s*id\s*\)/,
    );
    expect(init).not.toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+idx_black_box_updated_at\b/,
    );
    expect(init).not.toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+idx_black_box_entries_user_updated(?:_desc)?\b/,
    );
  });

  it('builds the replacement index concurrently before cleanup', () => {
    const migration = normalize(read(createMigrationPath));

    expect(migration).toContain(
      'create index concurrently if not exists idx_black_box_entries_user_updated_id on public.black_box_entries (user_id, updated_at, id);',
    );
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('validates the replacement before fail-fast redundant-index cleanup', () => {
    const migration = normalize(read(cleanupMigrationPath));

    expect(migration).toContain("to_regclass('public.idx_black_box_entries_user_updated_id')");
    expect(migration).toContain('index_row.indisvalid');
    expect(migration).toContain('index_row.indisready');
    expect(migration).toContain("access_method.amname = 'btree'");
    expect(migration).toContain('index_row.indpred is null');
    expect(migration).toContain(
      "replacement_columns is distinct from array['user_id', 'updated_at', 'id']::name[]",
    );
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain('drop index if exists public.idx_black_box_updated_at;');
    expect(migration).toContain('drop index if exists public.idx_black_box_entries_user_updated;');
    expect(migration).toContain('drop index if exists public.idx_black_box_entries_user_updated_desc;');
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('drop index concurrently');
  });

  it('keeps only concurrent creation in the manifest and records rollback SQL', () => {
    const cleanupMigration = normalize(read(cleanupMigrationPath));
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        reason: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const createEntry = manifest.entries.find(item => item.path === createMigrationPath);
    const cleanupEntry = manifest.entries.find(item => item.path === cleanupMigrationPath);

    expect(createEntry).toEqual(expect.objectContaining({
      path: createMigrationPath,
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
    expect(createEntry?.reason).toContain('CREATE INDEX CONCURRENTLY');
    expect(createEntry?.rollbackStrategy).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx_black_box_entries_user_updated_id',
    );

    expect(cleanupEntry).toBeUndefined();
    expect(cleanupMigration).toContain(
      'rollback: create index concurrently idx_black_box_updated_at on public.black_box_entries(updated_at);',
    );
    expect(cleanupMigration).toContain(
      'rollback: create index concurrently idx_black_box_entries_user_updated on public.black_box_entries(user_id, updated_at desc);',
    );
    expect(cleanupMigration).toContain(
      'rollback: create index concurrently idx_black_box_entries_user_updated_desc on public.black_box_entries(user_id, updated_at desc);',
    );
  });
});
