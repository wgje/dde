import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const querySourcePath = 'src/app/core/services/sync/connection-tombstone-lookup.service.ts';
const migrationPath =
  'supabase/migrations/20260716000600_connection_tombstone_legacy_lookup_index.sql';
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

function legacyLookupSection(source: string): string {
  const start = source.indexOf('private async queryLegacyEndpointlessConnectionTombstone(');
  const end = source.indexOf('private recordRetryableConnectionFailure(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return normalize(source.slice(start, end));
}

describe('connection tombstone legacy lookup index performance', () => {
  it('keeps the endpointless fallback narrow and aligned with the partial predicate', () => {
    const lookup = legacyLookupSection(read(querySourcePath));

    expect(lookup).toContain(".from('connection_tombstones')");
    expect(lookup).toContain(".select('deleted_at')");
    expect(lookup).not.toContain(".select('deleted_at,source_id,target_id')");
    expect(lookup).toContain(".eq('project_id', projectid)");
    expect(lookup).toContain(".is('source_id', null)");
    expect(lookup).toContain(".is('target_id', null)");
    expect(lookup).toContain(".order('deleted_at', { ascending: false })");
    expect(lookup).toContain('.limit(1)');
  });

  it('creates a tiny concurrent index only for endpointless legacy rows', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain(
      'create index concurrently if not exists idx_connection_tombstones_legacy_project_deleted on public.connection_tombstones (project_id, deleted_at desc) where source_id is null and target_id is null;',
    );
    expect(migration).not.toContain('include (');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('keeps fresh-init aligned with both modern and legacy endpoint lookup paths', () => {
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(init).toContain(
      'create index if not exists idx_connection_tombstones_project_source_target_deleted on public.connection_tombstones (project_id, source_id, target_id, deleted_at desc) where source_id is not null and target_id is not null;',
    );
    expect(init).toContain(
      'create index if not exists idx_connection_tombstones_legacy_project_deleted on public.connection_tombstones (project_id, deleted_at desc) where source_id is null and target_id is null;',
    );
  });

  it('registers the concurrent migration with an explicit rollback', () => {
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

    expect(entry).toEqual(expect.objectContaining({
      path: migrationPath,
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
    expect(entry?.reason).toContain('CREATE INDEX CONCURRENTLY');
    expect(entry?.rollbackStrategy).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx_connection_tombstones_legacy_project_deleted',
    );
  });
});
