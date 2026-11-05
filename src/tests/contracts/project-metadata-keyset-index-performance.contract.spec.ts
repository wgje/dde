import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_SUPABASE_INIT_VERSION,
  isSupabaseInitVersionAtLeast,
} from './supabase-init-version.spec-helpers';

const userSessionSourcePath = 'src/services/user-session-layer-2.service.ts';
const projectCloudSourcePath = 'src/app/core/services/sync/project-cloud-list.service.ts';
const migrationPath =
  'supabase/migrations/20260718003000_projects_owner_updated_id_keyset_convergence.sql';
const initPath = 'scripts/init-supabase.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  const exists = fs.existsSync(absolutePath);
  expect(exists, `${relativePath} should exist`).toBe(true);
  return exists ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(source: string): string {
  return source.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} should exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${endMarker} should follow ${startMarker}`).toBeGreaterThan(start);
  return normalize(start >= 0 && end > start ? source.slice(start, end) : '');
}

describe('project metadata keyset index performance contract', () => {
  it('keeps user-session metadata reads on the active owner updated_at/id keyset', () => {
    const section = extractSection(
      read(userSessionSourcePath),
      'protected async fetchProjectListMetadata(',
      'protected createAccessibleProjectIdSet(',
    );

    expect(section).toContain(".from('projects')");
    expect(section).toContain(".eq('owner_id', userid)");
    expect(section).toContain(".is('deleted_at', null)");
    expect(section).toContain('buildsupabasekeysetorfilter(cursor)');
    expect(section).toContain(".order('updated_at', { ascending: true })");
    expect(section).toContain(".order('id', { ascending: true })");
  });

  it('keeps cloud incremental and full-list reads on their distinct keyset orders', () => {
    const source = read(projectCloudSourcePath);
    const incremental = extractSection(source, 'async pullProjects(', 'private async queryProjectListMetadata(');
    const fullList = extractSection(
      source,
      'private async fetchActiveProjectRowsById(',
      'private async loadCloudProjectBatchResults(',
    );

    expect(incremental).toContain(".from('projects')");
    expect(incremental).toContain(".is('deleted_at', null)");
    expect(incremental).toContain("query = query.eq('owner_id', userid)");
    expect(incremental).toContain('buildsupabasekeysetorfilter(cursor)');
    expect(incremental).toContain(".order('updated_at', { ascending: true })");
    expect(incremental).toContain(".order('id', { ascending: true })");

    expect(fullList).toContain(".eq('owner_id', userid)");
    expect(fullList).toContain(".is('deleted_at', null)");
    expect(fullList).toContain("query = query.gt('id', cursor)");
    expect(fullList).toContain("query.order('id', { ascending: true })");
  });

  it('atomically validates the full replacement before dropping the old index', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain("set local statement_timeout = '30s';");
    expect(migration).toContain(
      'create index if not exists idx_projects_owner_updated_id on public.projects (owner_id, updated_at, id);',
    );
    expect(migration).not.toContain('where deleted_at is null');
    expect(migration).toContain("access_method.amname = 'btree'");
    expect(migration).toContain('index_row.indisvalid');
    expect(migration).toContain('index_row.indisready');
    expect(migration).toContain('index_row.indpred is null');
    expect(migration).toContain('index_row.indexprs is null');
    expect(migration).toContain('index_row.indnkeyatts = 3');
    expect(migration).toContain('index_row.indnatts = 3');
    expect(migration).toContain('index_row.indoption[0] = 0');
    expect(migration).toContain('index_row.indoption[1] = 0');
    expect(migration).toContain('index_row.indoption[2] = 0');
    expect(migration).toContain("attribute_row.attname = 'owner_id'");
    expect(migration).toContain("attribute_row.attname = 'updated_at'");
    expect(migration).toContain("attribute_row.attname = 'id'");
    expect(migration).toContain(
      "raise exception 'project metadata keyset index is missing or invalid'",
    );
    expect(migration).toContain('drop index if exists public.idx_projects_owner_id_updated;');
    expect(migration).toContain('set local statement_timeout = default;');
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('create index concurrently');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('converges fresh init while retaining the active owner/id partial index', () => {
    expect(isSupabaseInitVersionAtLeast(CURRENT_SUPABASE_INIT_VERSION, '7.53.0')).toBe(true);
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(init).toContain(
      'create index if not exists idx_projects_owner_updated_id on public.projects (owner_id, updated_at, id);',
    );
    expect(init).not.toMatch(
      /create index(?: if not exists)? idx_projects_owner_id_updated\b/,
    );
    expect(init).toContain(
      'create index if not exists idx_projects_owner_id_active on public.projects (owner_id, id) where deleted_at is null;',
    );
    expect(initSource).toContain(
      '-- FINAL CONVERGENCE: 20260718003000 project metadata keyset index',
    );
  });

  it('keeps the transaction-safe migration out of the special manifest', () => {
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{ path: string }>;
    };

    expect(manifest.entries.find(entry => entry.path === migrationPath)).toBeUndefined();
  });
});
