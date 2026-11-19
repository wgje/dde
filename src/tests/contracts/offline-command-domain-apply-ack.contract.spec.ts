import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261114094736_sync_offline_command_domain_apply_ack.sql';
const read = () => fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');

describe('offline command domain apply acknowledgement', () => {
  it('exposes owner-scoped apply status and permits only explicit successful domain commands', () => {
    const sql = read();
    expect(sql).toContain("'status', CASE WHEN v_domain_status IN ('applied', 'idempotent-replay')");
    expect(sql).toContain("'appliedToDomainTables', v_domain_status IN ('applied', 'idempotent-replay')");
    expect(sql).toContain('WHERE c.operation_id = v_operation_id AND c.user_id = v_user');
    expect(sql).toContain("WHEN 'connection' THEN NEW.command IN ('connection.create', 'connection.update', 'connection.restore', 'connection.reorder')");
    expect(sql).toContain("domain_status := 'unsupported-domain-command'");
    expect(sql).toContain("NEW.envelope->>'projectId'");
  });

  it('rejects commands without a verified entity-operation translation instead of falling through to upsert', () => {
    const sql = read();
    expect(sql).toContain('v_supported := CASE NEW.entity_type');
    expect(sql).toContain("WHEN 'connection' THEN NEW.command IN ('connection.create', 'connection.update', 'connection.restore', 'connection.reorder')");
    expect(sql).toContain("domain_result := jsonb_build_object('status', 'unsupported-domain-command'");
    expect(sql).toContain("NEW.command = 'routine_completion.create'");
  });

  it('keeps the status RPC authenticated and excludes untrusted roles', () => {
    const sql = read();
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_get_offline_command_status(JSONB) FROM PUBLIC, anon');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_get_offline_command_status(JSONB) TO authenticated');
  });
});
