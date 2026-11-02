import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as projectCloudListModule from '../../app/core/services/sync/project-cloud-list.service';
import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const sourcePath = 'src/app/core/services/sync/project-cloud-list.service.ts';
const migrationPath = 'supabase/migrations/20260716000700_projects_owner_id_active_index.sql';
const initPath = 'scripts/init-supabase.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

type SortProjectRowsNewestFirst = <Row extends { id?: unknown; updated_at?: unknown }>(rows: Row[]) => Row[];

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('project list keyset and index performance', () => {
  it('uses immutable id keyset pages for full lists and preserves newest-first output', () => {
    const source = read(sourcePath);
    const normalized = normalize(source);

    expect(source).toContain('fetchAllSupabaseKeysetPagesByCursor');
    expect(source).not.toMatch(/\bfetchAllSupabasePages\s*[<(]/);
    expect(normalized).toContain(".gt('id', cursor)");
    expect(normalized).toContain(".order('id', { ascending: true })");
    expect(source).toContain('sortProjectRowsNewestFirst(data ?? [])');

    const sortRows = (projectCloudListModule as unknown as {
      sortProjectRowsNewestFirst?: SortProjectRowsNewestFirst;
    }).sortProjectRowsNewestFirst;
    expect(sortRows).toBeTypeOf('function');
    if (!sortRows) return;

    const rows = [
      { id: 'b', updated_at: '2026-07-16T00:00:00.000Z' },
      { id: 'c', updated_at: '2026-07-17T00:00:00.000Z' },
      { id: 'a', updated_at: '2026-07-16T00:00:00.000Z' },
    ];
    expect(sortRows(rows).map(row => row.id)).toEqual(['c', 'a', 'b']);
    expect(rows.map(row => row.id)).toEqual(['b', 'c', 'a']);
  });

  it('uses updated-at/id keyset pages for incremental project pulls', () => {
    const source = normalize(read(sourcePath));

    expect(source).toContain('fetchallsupabasekeysetpages<projectrow>');
    expect(source).toContain('query = query.or(buildsupabasekeysetorfilter(cursor))');
    expect(source).toContain(".order('updated_at', { ascending: true })");
    expect(source).toContain(".order('id', { ascending: true })");
  });

  it('creates the active owner/id index concurrently', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain(
      'create index concurrently if not exists idx_projects_owner_id_active on public.projects (owner_id, id) where deleted_at is null;',
    );
    expect(migration).not.toContain('include (');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('keeps fresh-init and rollback metadata aligned', () => {
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

    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(init).toContain(
      'create index if not exists idx_projects_owner_id_active on public.projects (owner_id, id) where deleted_at is null;',
    );
    expect(entry).toEqual(expect.objectContaining({
      path: migrationPath,
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
    expect(entry?.reason).toContain('CREATE INDEX CONCURRENTLY');
    expect(entry?.rollbackStrategy).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx_projects_owner_id_active',
    );
  });
});
