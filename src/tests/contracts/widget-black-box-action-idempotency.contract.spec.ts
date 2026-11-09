import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260729000000_widget_black_box_action_idempotency.sql';
const initPath = 'scripts/init-supabase.sql';
const edgePath = 'supabase/functions/widget-black-box-action/index.ts';
const typesPath = 'src/types/supabase.ts';
const finalMarker = '-- FINAL CONVERGENCE: 20260729000000 widget black box action idempotency';
const finalAnchor = "NOTIFY pgrst, 'reload schema';";

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalized(sql: string): string {
  return sql.replace(/\r\n/g, '\n').trim();
}

function expectOrder(source: string, fragments: string[]): void {
  let previous = -1;
  for (const fragment of fragments) {
    const current = source.indexOf(fragment);
    expect(current, `missing ordered fragment: ${fragment}`).toBeGreaterThan(previous);
    previous = current;
  }
}

function finalInitBody(init: string): string {
  const marker = init.indexOf(finalMarker);
  const anchor = init.indexOf(finalAnchor, marker + finalMarker.length);
  expect(marker, 'final init marker').toBeGreaterThanOrEqual(0);
  expect(init.indexOf(finalMarker, marker + 1), 'unique final init marker').toBe(-1);
  expect(anchor, 'final init anchor').toBeGreaterThan(marker);
  return init.slice(marker + finalMarker.length, anchor);
}

function applyActionFunction(sql: string): string {
  const signature = 'CREATE OR REPLACE FUNCTION public.apply_widget_black_box_action(';
  const delimiter = '$widget_black_box_action$';
  const start = sql.indexOf(signature);
  const bodyStart = sql.indexOf(`AS ${delimiter}`, start);
  const end = sql.indexOf(`${delimiter};`, bodyStart + delimiter.length);
  expect(start, 'apply action function').toBeGreaterThanOrEqual(0);
  expect(bodyStart, 'apply action function body').toBeGreaterThan(start);
  expect(end, 'apply action function terminator').toBeGreaterThan(bodyStart);
  return sql.slice(start, end + delimiter.length + 1);
}

describe('widget black-box action operation-id foundation', () => {
  it('routes optional operation IDs through one service-role RPC after bearer verification', () => {
    const edge = read(edgePath);
    expect.soft(edge).toContain('operationId?: string;');
    expect.soft(edge).toContain('originBindingGeneration?: number;');
    expect.soft(edge).toContain("client.rpc<WidgetBlackBoxActionRpcResult>('apply_widget_black_box_action'");
    expect.soft(edge).toContain('p_operation_id: operationId');
    expect.soft(edge).toContain('p_origin_binding_generation: originBindingGeneration');
    expect.soft(edge).not.toContain(".from('black_box_entries')");
    expectOrder(edge, ['device = await loadDevice(client, token)', "client.rpc<WidgetBlackBoxActionRpcResult>('apply_widget_black_box_action'"]);
  });

  it('defines a bounded receipt without an entry foreign key and denies direct API access', () => {
    const migration = read(migrationPath);
    expect.soft(migration).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? public\.widget_black_box_action_receipts\s*\(/);
    expect.soft(migration).toContain('PRIMARY KEY (device_id, operation_id)');
    expect.soft(migration).toContain('UNIQUE (operation_id)');
    expect.soft(migration).toMatch(/entry_id UUID NOT NULL[,\s]/);
    expect.soft(migration).not.toMatch(/entry_id[^,]*REFERENCES/i);
    expect.soft(migration).toContain('canonical_response JSONB NOT NULL');
    expect.soft(migration).toContain("expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')");
    expect.soft(migration).toContain('ALTER TABLE public.widget_black_box_action_receipts FORCE ROW LEVEL SECURITY');
    expect.soft(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
  });

  it('linearizes receipt inspection before entry mutation and returns exact canonical replay', () => {
    const migration = read(migrationPath);
    expect.soft(migration).toContain('pg_catalog.pg_advisory_xact_lock');
    expect.soft(migration).toContain('FOR UPDATE');
    expect.soft(migration).toContain("'status', 409");
    expect.soft(migration).toContain('RETURN v_receipt.canonical_response');
    expect.soft(migration).toContain('canonical_response');
    expectOrder(migration, [
      'FROM public.widget_devices',
      'FOR UPDATE',
      'FROM public.widget_black_box_action_receipts',
      'RETURN v_receipt.canonical_response',
      'UPDATE public.black_box_entries',
      'INSERT INTO public.widget_black_box_action_receipts',
    ]);
  });

  it('captures authoritative clocks after serialization and again before receipt-miss mutation', () => {
    const rpc = applyActionFunction(read(migrationPath));
    const clockPattern = /v_now\s*:=\s*pg_catalog\.clock_timestamp\(\);/g;
    const clocks = [...rpc.matchAll(clockPattern)].map(match => match.index);
    expect.soft(rpc).toContain('v_now TIMESTAMPTZ;');
    expect.soft(rpc).not.toMatch(/v_now\s+TIMESTAMPTZ\s*:=/);
    expect.soft(rpc).not.toMatch(/v_now\s*:=\s*(?:pg_catalog\.)?(?:now|transaction_timestamp)\s*\(/);
    expect(clocks).toHaveLength(2);

    const deviceLock = rpc.indexOf('FOR UPDATE OF devices;');
    const operationLock = rpc.indexOf('PERFORM pg_catalog.pg_advisory_xact_lock');
    const receiptPath = rpc.indexOf('DELETE FROM public.widget_black_box_action_receipts');
    const receiptLookup = rpc.indexOf('SELECT receipts.*');
    const replay = rpc.indexOf('RETURN v_receipt.canonical_response');
    const replayOwnerCheck = rpc.indexOf('v_device.user_id IS DISTINCT FROM p_user_id', operationLock);
    const ownerCheck = rpc.indexOf('v_device.user_id IS DISTINCT FROM p_user_id', replay + 1);
    const revokedCheck = rpc.indexOf('v_device.revoked_at IS NOT NULL');
    const expiryCheck = rpc.indexOf('v_device.expires_at <= v_now');
    const generationCheck = rpc.indexOf('v_device.binding_generation IS DISTINCT FROM p_origin_binding_generation');
    const entryMutation = rpc.indexOf('UPDATE public.black_box_entries');
    const receiptInsert = rpc.indexOf('INSERT INTO public.widget_black_box_action_receipts');

    const serializedPath = [deviceLock, operationLock, clocks[0], receiptPath, receiptLookup, replayOwnerCheck, replay];
    const receiptMissPath = [replay, clocks[1], ownerCheck, revokedCheck, expiryCheck, generationCheck, entryMutation, receiptInsert];
    expect.soft(serializedPath).not.toContain(-1);
    expect.soft(receiptMissPath).not.toContain(-1);
    expect(serializedPath).toEqual([...serializedPath].sort((a, b) => a - b));
    expect(receiptMissPath).toEqual([...receiptMissPath].sort((a, b) => a - b));
  });

  it('fences missing receipts by owner, active binding, expiry, and origin generation', () => {
    const migration = read(migrationPath);
    expect.soft(migration).not.toContain('auth.uid()');
    expect.soft(migration).toContain('v_device.user_id IS DISTINCT FROM p_user_id');
    expect.soft(migration).toContain('v_device.revoked_at IS NOT NULL');
    expect.soft(migration).toContain('v_device.expires_at <= v_now');
    expect.soft(migration).toContain('v_device.binding_generation IS DISTINCT FROM p_origin_binding_generation');
    expect.soft(migration).toContain('entries.user_id = p_user_id');
    expect.soft(migration).toContain('entries.deleted_at IS NULL');
  });

  it('preserves canonical read and complete timestamps while legacy no-ID remains available', () => {
    const migration = read(migrationPath);
    expect.soft(migration).toContain('p_operation_id UUID DEFAULT NULL');
    expect.soft(migration).toContain('IF p_operation_id IS NOT NULL THEN');
    expect.soft(migration).toContain('is_read = TRUE');
    expect.soft(migration).toContain('is_completed = TRUE');
    expect.soft(migration).toContain('completed_at = COALESCE(entries.completed_at, v_now)');
    expect.soft(migration).toContain("'updatedAt', v_entry.updated_at");
    expect.soft(migration).toContain("'completedAt', v_entry.completed_at");
  });

  it('extends 30-day retention and locks service-role-only RPC execution', () => {
    const migration = read(migrationPath);
    expect.soft(migration).toContain('idx_widget_black_box_action_receipts_retention');
    expect.soft(migration).toContain('expired_receipts AS MATERIALIZED');
    expect.soft(migration).toContain("'widget_black_box_action_receipts_deleted'");
    expect.soft(migration).toContain('CREATE OR REPLACE FUNCTION public.cleanup_widget_operational_state(');
    expect.soft(migration).toContain('SECURITY DEFINER');
    expect.soft(migration).toContain("SET search_path = ''");
    expect.soft(migration).toContain('GRANT EXECUTE ON FUNCTION public.apply_widget_black_box_action');
    expect.soft(migration).toContain('TO service_role');
  });

  it('keeps migration, fresh init, and generated database types converged', () => {
    const migration = read(migrationPath);
    const init = read(initPath);
    const types = read(typesPath);
    expect(normalized(finalInitBody(init))).toBe(normalized(migration));
    expect.soft(types).toContain('widget_black_box_action_receipts: {');
    expect.soft(types).toContain('apply_widget_black_box_action: {');
    expect.soft(types).toContain('p_origin_binding_generation: number');
    expect.soft(types).toContain('p_operation_id?: string');
    expect.soft(types).toContain('Returns: Json');
  });
});
