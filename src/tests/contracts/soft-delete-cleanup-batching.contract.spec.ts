import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716001800_soft_delete_cleanup_batched.sql';
const initPath = 'scripts/init-supabase.sql';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function functionDefinition(sql: string, signature: string): string {
  const normalized = normalize(sql);
  const start = normalized.lastIndexOf(signature);
  expect(start, `${signature} should exist`).toBeGreaterThanOrEqual(0);
  if (start < 0) return '';
  const end = normalized.indexOf('$$;', start);
  expect(end, `${signature} should terminate`).toBeGreaterThan(start);
  return end > start ? normalized.slice(start, end + 3) : '';
}

function expectTombstoneBeforeDelete(section: string, tombstoneTable: string, sourceTable: string): void {
  const tombstoneIndex = section.indexOf(`insert into public.${tombstoneTable}`);
  const deleteIndex = section.indexOf(`delete from public.${sourceTable}`);
  expect(tombstoneIndex).toBeGreaterThanOrEqual(0);
  expect(deleteIndex).toBeGreaterThan(tombstoneIndex);
  expect(section).toContain('on conflict');
  expect(section).toContain('do update set');
}

function expectBoundedSoftDeleteCleanup(sql: string): void {
  const normalized = normalize(sql);
  const taskCleanup = functionDefinition(
    sql,
    'create or replace function public.cleanup_old_deleted_tasks()',
  );
  const connectionCleanup = functionDefinition(
    sql,
    'create or replace function public.cleanup_old_deleted_connections()',
  );

  expect(taskCleanup).toContain("security definer set search_path = ''");
  expect(taskCleanup).toContain('v_batch_size constant integer := 5000;');
  expect(taskCleanup).toContain(
    "from public.tasks as tasks where tasks.deleted_at is not null and tasks.deleted_at < now() - interval '30 days' order by tasks.deleted_at asc, tasks.id asc limit v_batch_size for update of tasks skip locked",
  );
  expect(taskCleanup).toContain(
    'select candidates.task_id, candidates.project_id, now(), null from expired_tasks as candidates',
  );
  expect(taskCleanup).toContain(
    'join task_tombstone_rows as tombstones on tombstones.project_id = connections.project_id where connections.source_id = tombstones.task_id or connections.target_id = tombstones.task_id',
  );
  expectTombstoneBeforeDelete(taskCleanup, 'task_tombstones', 'tasks');
  expectTombstoneBeforeDelete(taskCleanup, 'connection_tombstones', 'connections');
  expect(taskCleanup.indexOf('delete from public.connections')).toBeLessThan(
    taskCleanup.indexOf('delete from public.tasks'),
  );

  expect(connectionCleanup).toContain("security definer set search_path = ''");
  expect(connectionCleanup).toContain('v_batch_size constant integer := 5000;');
  expect(connectionCleanup).toContain(
    "from public.connections as connections where connections.deleted_at is not null and connections.deleted_at < now() - interval '30 days' order by connections.deleted_at asc, connections.id asc limit v_batch_size for update of connections skip locked",
  );
  expectTombstoneBeforeDelete(connectionCleanup, 'connection_tombstones', 'connections');

  expect(normalized).toContain(
    'revoke all on function public.cleanup_old_deleted_tasks() from public, anon, authenticated, service_role;',
  );
  expect(normalized).toContain(
    'grant execute on function public.cleanup_old_deleted_tasks() to service_role;',
  );
  expect(normalized).toContain(
    'revoke all on function public.cleanup_old_deleted_connections() from public, anon, authenticated, service_role;',
  );
  expect(normalized).toContain(
    'grant execute on function public.cleanup_old_deleted_connections() to service_role;',
  );
}

describe('soft-delete physical cleanup batching', () => {
  it('ships bounded tombstone-first task and connection cleanup functions', () => {
    expectBoundedSoftDeleteCleanup(read(migrationPath));
  });

  it('keeps fresh-init aligned with the stable retention indexes', () => {
    const sql = read(initPath);
    expectBoundedSoftDeleteCleanup(sql);

    const normalized = normalize(sql);
    expect(normalized).toContain(
      'create index if not exists idx_tasks_deleted_cleanup on public.tasks (deleted_at) where deleted_at is not null;',
    );
    expect(normalized).toContain(
      'create index if not exists idx_connections_deleted_at_cleanup on public.connections (deleted_at) where deleted_at is not null;',
    );
  });
});
