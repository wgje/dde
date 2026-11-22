import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261114030826_sync_offline_command_domain_apply.sql';
const read = () => fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');

describe('offline command domain apply migration', () => {
  it('is capability-gated and auditable', () => {
    const sql = read();
    expect(sql).toContain('domain-apply-v1');
    expect(sql).toContain('sync_command_domain_apply_log');
    expect(sql).toContain('sync_apply_command_domain_tables');
    expect(sql).toContain('zzz_sync_command_domain_apply');
    expect(sql).toContain('sync_upsert_task');
    expect(sql).toContain('sync_upsert_project');
    expect(sql).toContain('sync_upsert_connection');
    expect(sql).toContain('sync_upsert_blackbox_entry');
    expect(sql).toContain('sync_upsert_user_preferences');
    expect(sql).toContain('sync_upsert_focus_session');
    expect(sql).toContain('sync_upsert_routine_task');
    expect(sql).toContain('sync_increment_routine_completion');
    expect(sql).toContain('sync_delete_project');
    expect(sql).toContain('sync_delete_tasks');
  });

  it('keeps domain apply disabled until an operator advertises the capability', () => {
    const finalSql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261115165939_sync_offline_command_final_domain_apply_fence.sql'), 'utf8');
    const sql = finalSql;
    expect(sql).toContain("IF NOT (COALESCE(v_capabilities, '[]'::jsonb) @> '[\"domain-apply-v1\"]'::jsonb)");
    expect(sql).toContain("'skipped-capability-disabled'");
  });
});
