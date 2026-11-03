import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const migrationPath = 'supabase/migrations/20260728000000_drop_personal_backup_snapshot_rpc.sql';
const initPath = 'scripts/init-supabase.sql';
const functionSignature = 'public.get_personal_backup_snapshot()';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function normalizeExecutableSql(sql: string): string {
  return normalize(sql.replace(/--.*$/gm, ''));
}

describe('personal backup snapshot RPC retirement contract', () => {
  it('revokes and drops the unbounded RPC in the forward migration', () => {
    expect(fs.existsSync(path.join(process.cwd(), migrationPath))).toBe(true);
    if (!fs.existsSync(path.join(process.cwd(), migrationPath))) return;
    const migrationSql = normalize(read(migrationPath));
    const executableSql = normalizeExecutableSql(read(migrationPath));
    expect(migrationSql).toContain(
      `IF to_regprocedure('${functionSignature}') IS NOT NULL THEN`,
    );
    expect(migrationSql).toContain(
      `EXECUTE 'REVOKE ALL ON FUNCTION ${functionSignature} FROM PUBLIC, anon, authenticated, service_role'`,
    );
    expect(migrationSql).toContain(`DROP FUNCTION IF EXISTS ${functionSignature}`);
    expect(executableSql).not.toMatch(/^BEGIN\s*;/i);
    expect(executableSql).not.toMatch(/\bCOMMIT\s*;$/i);
    expect(executableSql).not.toMatch(/\bCREATE\b/i);
    expect(executableSql).not.toMatch(/\bGRANT\b/i);
  });

  it('does not define or grant the retired RPC in the fresh-init script', () => {
    const initSql = read(initPath);
    expect(initSql).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(normalize(initSql)).not.toContain(functionSignature);
  });
});
