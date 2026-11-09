import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_SUPABASE_INIT_VERSION,
  isSupabaseInitVersionAtLeast,
} from './supabase-init-version.spec-helpers';

const tombstoneServicePath = 'src/app/core/services/sync/tombstone.service.ts';
const taskRepositoryPath = 'src/services/task-repository.service.ts';
const migrationPath =
  'supabase/migrations/20260718003100_task_tombstone_keyset_pagination.sql';
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

describe('task tombstone keyset pagination contract', () => {
  it('moves both full readers from offset ranges to the same fail-closed keyset', () => {
    const tombstoneSection = extractSection(
      read(tombstoneServicePath),
      'async getTombstonesWithCache(',
      'private normalizeTombstoneError(',
    );
    const repositorySection = extractSection(
      read(taskRepositoryPath),
      'private async loadTaskTombstoneIds(',
      'private collectRemovedTaskIds(',
    );

    for (const section of [tombstoneSection, repositorySection]) {
      expect(section).toContain('fetchallsupabasekeysetpagesbycursor');
      expect(section).toContain('buildtasktombstonekeysetorfilter(cursor)');
      expect(section).toContain(".order('deleted_at', { ascending: true })");
      expect(section).toContain(".order('task_id', { ascending: true })");
      expect(section).toContain('readcursor: readtasktombstonepagecursor');
      expect(section).not.toContain('fetchallsupabasepages');
    }

    expect(tombstoneSection).toContain('.select(field_select_config.tombstone_fields)');
    expect(repositorySection).toContain(".select('task_id,deleted_at')");
  });

  it('atomically validates the canonical project/deleted_at/task_id index before cleanup', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain("set local statement_timeout = '30s';");
    expect(migration).toContain(
      'create index if not exists idx_task_tombstones_project_deleted_task on public.task_tombstones (project_id, deleted_at, task_id);',
    );
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
    expect(migration).toContain("attribute_row.attname = 'project_id'");
    expect(migration).toContain("attribute_row.attname = 'deleted_at'");
    expect(migration).toContain("attribute_row.attname = 'task_id'");
    expect(migration).toContain(
      "raise exception 'task tombstone keyset index is missing or invalid'",
    );
    expect(migration).toContain(
      'drop index if exists public.idx_task_tombstones_project_deleted_desc;',
    );
    expect(migration).toContain('drop index if exists public.idx_task_tombstones_project_id;');
    expect(migration).toContain('set local statement_timeout = default;');
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('create index concurrently');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('converges fresh init without removing the global retention index', () => {
    expect(isSupabaseInitVersionAtLeast(CURRENT_SUPABASE_INIT_VERSION, '7.54.0')).toBe(true);
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(init).toContain(
      'create index if not exists idx_task_tombstones_project_deleted_task on public.task_tombstones (project_id, deleted_at, task_id);',
    );
    expect(init).not.toMatch(
      /create index(?: if not exists)? idx_task_tombstones_project_id\b/,
    );
    expect(init).not.toMatch(
      /create index(?: if not exists)? idx_task_tombstones_project_deleted_desc\b/,
    );
    expect(init).toContain(
      'create index if not exists idx_task_tombstones_deleted_at on public.task_tombstones (deleted_at);',
    );
    expect(initSource).toContain(
      '-- FINAL CONVERGENCE: 20260718003100 task tombstone keyset pagination',
    );
  });

  it('keeps the transaction-safe migration out of the special manifest', () => {
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{ path: string }>;
    };

    expect(manifest.entries.find(entry => entry.path === migrationPath)).toBeUndefined();
  });
});
