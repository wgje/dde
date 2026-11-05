import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const servicePath = 'src/app/core/external-sources/external-source-link.service.ts';
const createMigrationPath =
  'supabase/migrations/20260715018800_external_source_links_id_cursor_index.sql';
const cleanupMigrationPath =
  'supabase/migrations/20260715018900_external_source_links_final_convergence.sql';
const manifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('external_source_links keyset and fresh-init contract', () => {
  it('uses immutable id keyset pagination instead of mutable updated_at offsets', () => {
    const source = normalize(read(servicePath));

    expect(source).toContain('fetchallsupabasekeysetpagesbycursor');
    expect(source).toContain('.eq("user_id", userid)');
    expect(source).toContain('.gt("id", cursor)');
    expect(source).toContain('.order("id", { ascending: true })');
    expect(source).not.toContain('fetchallsupabasepages<externalsourcelinkrow>');
    expect(source).not.toContain('.order("updated_at", { ascending: true })');
  });

  it('defines the complete final table, security, and indexes in fresh init', () => {
    const init = normalize(read(initPath));

    expect(init).toContain('create table if not exists public.external_source_links');
    expect(init).toContain('operation_id uuid');
    expect(init).toContain("check (target_id ~ '^\\d{14}-[a-z0-9]{7}$')");
    expect(init).toContain(
      'create index if not exists external_source_links_user_id_cursor_idx on public.external_source_links (user_id, id);',
    );
    expect(init).toContain(
      'create index if not exists external_source_links_task_idx on public.external_source_links (task_id, sort_order);',
    );
    expect(init).toContain(
      'create unique index if not exists external_source_links_unique_active_target on public.external_source_links (user_id, task_id, source_type, target_id) where deleted_at is null;',
    );
    expect(init).toContain(
      'create unique index if not exists external_source_links_operation_id_unique_idx on public.external_source_links (operation_id) where operation_id is not null;',
    );
    expect(init).toContain('alter table public.external_source_links force row level security;');
    expect(init).toContain('create policy external_source_links_owner_update');
    expect(init).toContain('with check ( user_id = (select auth.uid()) and exists');
    expect(init).toContain('create or replace function public.prevent_external_source_links_stale_write()');
    expect(init).toContain('set search_path = pg_catalog, public');
    expect(init).toContain(
      'revoke all on function public.prevent_external_source_links_stale_write() from public, anon, authenticated;',
    );
    expect(init).not.toMatch(
      /create\s+index(?:\s+if\s+not\s+exists)?\s+external_source_links_user_updated_idx\b/,
    );
  });

  it('creates the id cursor index concurrently before final convergence', () => {
    const migration = normalize(read(createMigrationPath));

    expect(migration).toContain(
      'create index concurrently if not exists external_source_links_user_id_cursor_idx on public.external_source_links (user_id, id);',
    );
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('validates the replacement and converges cleanup plus trigger security', () => {
    const migration = normalize(read(cleanupMigrationPath));

    expect(migration).toContain("to_regclass('public.external_source_links_user_id_cursor_idx')");
    expect(migration).toContain("access_method.amname = 'btree'");
    expect(migration).toContain("replacement_columns is distinct from array['user_id', 'id']::name[]");
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain('drop index if exists public.external_source_links_user_updated_idx;');
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).toContain(
      'alter function public.prevent_external_source_links_stale_write() set search_path = pg_catalog, public;',
    );
    expect(migration).toContain(
      'revoke all on function public.prevent_external_source_links_stale_write() from public, anon, authenticated;',
    );
    expect(migration).not.toContain('drop index concurrently');
  });

  it('keeps only concurrent creation in the manifest and records rollback SQL', () => {
    const cleanup = normalize(read(cleanupMigrationPath));
    const manifest = JSON.parse(read(manifestPath)) as {
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
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
    expect(createEntry?.rollbackStrategy).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.external_source_links_user_id_cursor_idx',
    );
    expect(cleanupEntry).toBeUndefined();
    expect(cleanup).toContain(
      'rollback: create index concurrently external_source_links_user_updated_idx on public.external_source_links(user_id, updated_at desc);',
    );
  });
});
