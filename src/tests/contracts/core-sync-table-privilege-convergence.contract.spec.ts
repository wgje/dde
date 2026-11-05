import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715018000_core_sync_table_privilege_convergence.sql';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const expectedStatements = [
  'alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated;',
  'revoke all on table public.tasks, public.connections from public, anon, authenticated;',
  'grant select, insert, update, delete on table public.tasks, public.connections to authenticated;',
  'grant all on table public.tasks, public.connections to service_role;',
  'revoke all on table public.task_tombstones, public.connection_tombstones from public, anon, authenticated;',
  'grant select, insert on table public.task_tombstones, public.connection_tombstones to authenticated;',
  'grant all on table public.task_tombstones, public.connection_tombstones to service_role;',
  'revoke all on table public.active_tasks, public.active_connections from public, anon, authenticated;',
  'grant select on table public.active_tasks, public.active_connections to authenticated;',
] as const;

function expectPrivilegeConvergence(sql: string): void {
  const normalized = normalize(sql);
  for (const statement of expectedStatements) {
    expect(normalized).toContain(statement);
  }
}

describe('core sync table privilege convergence contract', () => {
  it('adds a transaction-safe least-privilege forward migration', () => {
    const migration = read(migrationPath);
    const normalized = normalize(migration);

    expectPrivilegeConvergence(migration);
    expect(normalized).not.toContain('begin;');
    expect(normalized).not.toContain('commit;');
    expect(normalized).not.toContain('concurrently');
  });

  it('keeps the fresh initializer final grants aligned with the migration', () => {
    const init = read(initPath);
    expectPrivilegeConvergence(init);

    const normalized = normalize(init);
    const marker = normalized.lastIndexOf(
      '-- final convergence: 20260715018000 core sync table privileges',
    );
    expect(marker).toBeGreaterThanOrEqual(0);
    for (const statement of expectedStatements) {
      expect(normalized.lastIndexOf(statement)).toBeGreaterThan(marker);
    }
  });

  it('removes authenticated truncate, references, and trigger privileges from the target tables', () => {
    const migration = normalize(read(migrationPath));
    const init = normalize(read(initPath));
    const marker = init.lastIndexOf(
      '-- final convergence: 20260715018000 core sync table privileges',
    );
    expect(marker).toBeGreaterThanOrEqual(0);
    const finalInit = init.slice(marker);
    const targetTables = [
      'tasks',
      'connections',
      'task_tombstones',
      'connection_tombstones',
      'active_tasks',
      'active_connections',
    ];

    for (const sql of [migration, finalInit]) {
      for (const table of targetTables) {
        expect(sql).not.toMatch(
          new RegExp(
            `grant\\s+[^;]*\\b(?:truncate|references|trigger)\\b[^;]*\\bon\\s+table\\s+public\\.${table}\\b[^;]*\\bto\\s+authenticated\\b`,
          ),
        );
      }
      expect(sql).not.toMatch(/grant all on table public\.(?:tasks|task_tombstones|active_tasks)\b[^;]*to authenticated/);
    }
  });
});
