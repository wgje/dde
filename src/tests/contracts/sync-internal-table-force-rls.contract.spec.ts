import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const migrationPath = path.join(
  projectRoot,
  'supabase',
  'migrations',
  '20260716001300_sync_internal_table_force_rls.sql',
);
const initPath = path.join(projectRoot, 'scripts', 'init-supabase.sql');

const forceStatements = [
  'ALTER TABLE public.sync_operation_log FORCE ROW LEVEL SECURITY;',
  'ALTER TABLE public.sync_protocol_state FORCE ROW LEVEL SECURITY;',
] as const;

describe('sync internal table FORCE RLS convergence', () => {
  it('ships a forward migration that forces RLS on both sync support tables', () => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const sql = readFileSync(migrationPath, 'utf8');
    for (const statement of forceStatements) {
      expect(sql).toContain(statement);
    }
  });

  it('keeps fresh-init aligned with the forward migration', () => {
    const sql = readFileSync(initPath, 'utf8');
    for (const statement of forceStatements) {
      expect(sql).toContain(statement);
    }
  });
});
