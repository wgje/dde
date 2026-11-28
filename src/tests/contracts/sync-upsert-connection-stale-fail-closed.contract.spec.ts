import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261128170000_sync_upsert_connection_stale_fail_closed.sql';
const initPath = 'scripts/init-supabase.sql';
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('connection stale payload fail-closed migration', () => {
  it('uses a reviewed live-body hash and inserts a guard before the connection write', () => {
    const sql = read(migrationPath);
    expect(sql).toContain("'ff9617ce61f6354a9f50fd80c3f57260'");
    expect(sql).toContain("v_marker text := '  INSERT INTO public.connections AS c ('");
    expect(sql).toContain("'reason', 'stale_connection_payload'");
    expect(sql).toContain("'status', 'remote-newer'");
    expect(sql).toContain('RETURN v_result;');
    expect(sql).toContain('pg_get_functiondef(v_oid)');
  });

  it('keeps fresh-init connection upsert fail-closed for stale payloads', () => {
    const sql = read(initPath);
    expect(sql).toContain('stale_connection_payload');
    expect(sql).toContain('IF v_is_stale THEN');
    expect(sql).toContain('status\', \'remote-newer');
  });
});