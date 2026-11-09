import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const migrationPath =
  'supabase/migrations/20260716001100_foreign_key_index_coverage.sql';
const initPath = 'scripts/init-supabase.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('foreign key index coverage contract', () => {
  it('adds narrow concurrent indexes and keeps fresh-init plus rollback metadata aligned', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const init = normalize(initSource);
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

    const migrationStatements = [
      'create index concurrently if not exists idx_task_tombstones_deleted_by on public.task_tombstones (deleted_by) where deleted_by is not null;',
      'create index concurrently if not exists idx_connection_tombstones_deleted_by on public.connection_tombstones (deleted_by) where deleted_by is not null;',
      'create index concurrently if not exists idx_routine_completions_routine_id on public.routine_completions (routine_id);',
      'create index concurrently if not exists idx_routine_completion_events_routine_id on public.routine_completion_events (routine_id);',
    ];
    const initStatements = migrationStatements.map(statement => statement.replace(' concurrently', ''));

    for (const statement of migrationStatements) {
      expect(migration).toContain(statement);
    }
    for (const statement of initStatements) {
      expect(init).toContain(statement);
    }
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);

    expect(entry).toEqual(expect.objectContaining({
      path: migrationPath,
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
    expect(entry?.reason).toContain('CREATE INDEX CONCURRENTLY');
    for (const indexName of [
      'idx_task_tombstones_deleted_by',
      'idx_connection_tombstones_deleted_by',
      'idx_routine_completions_routine_id',
      'idx_routine_completion_events_routine_id',
    ]) {
      expect(entry?.rollbackStrategy).toContain(
        `DROP INDEX CONCURRENTLY IF EXISTS public.${indexName}`,
      );
    }
  });
});
