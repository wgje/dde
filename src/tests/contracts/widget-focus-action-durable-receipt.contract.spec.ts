import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261121060000_widget_focus_action_durable_receipt.sql';
const edgePath = 'supabase/functions/widget-focus-action/index.ts';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function expectOrder(source: string, fragments: string[]): void {
  let previous = -1;
  for (const fragment of fragments) {
    const current = source.indexOf(fragment);
    expect(current, `missing ordered fragment: ${fragment}`).toBeGreaterThan(previous);
    previous = current;
  }
}

describe('widget focus action durable receipt candidate', () => {
  it('defines an owner/device/binding/action/payload identity receipt with fail-closed replay states', () => {
    const migration = read(migrationPath);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.widget_focus_action_receipts');
    expect(migration).toContain('PRIMARY KEY (device_id, operation_id)');
    expect(migration).toContain('UNIQUE (operation_id)');
    expect(migration).toContain('binding_generation INTEGER NOT NULL');
    expect(migration).toContain('payload_digest TEXT NOT NULL');
    expect(migration).toContain("extensions.digest");
    expect(migration).toContain("'action', p_action");
    expect(migration).toContain("'waitMinutes', p_wait_minutes");
    expect(migration).toContain("status TEXT NOT NULL DEFAULT 'completed'");
    expect(migration).toContain('canonical_response JSONB NOT NULL');
    expect(migration).toContain('WHERE expires_at <= pg_catalog.clock_timestamp()');
    expect(migration).not.toContain('expires_at < pg_catalog.clock_timestamp() - p_retention');
    expect(migration).toContain('operation_id UUID NOT NULL');
    expect(migration).toContain('canonical_response JSONB NOT NULL');
    expect(migration).toContain('WHERE expires_at <= pg_catalog.clock_timestamp()');
    expect(migration).not.toContain('expires_at < pg_catalog.clock_timestamp() - p_retention');
    expect(migration).toContain("expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')");
    expect(migration).toContain('ALTER TABLE public.widget_focus_action_receipts FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.widget_focus_action_receipts');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.apply_widget_focus_action(');
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock');
    expect(migration).toContain("'OPERATION_ID_CONFLICT'");
    expect(migration).toContain("'TASK_PATCH_OUTCOME_UNKNOWN'");
    expect(migration).toContain("'unknown'");
    expect(migration).toContain("'completed'");
    expect(migration).toContain("'FOCUS_SESSION_CHANGED'");
    expect(migration).toContain("'RECEIPT_NOT_FOUND'");
    expectOrder(migration, [
      'FROM public.widget_devices',
      'FROM public.widget_focus_action_receipts',
      'RETURN v_receipt.canonical_response',
      'UPDATE public.focus_sessions',
      'INSERT INTO public.widget_focus_action_receipts',
    ]);
  });

  it('preserves owner/device authentication and focus/task CAS inputs', () => {
    const edge = read(edgePath);
    const migration = read(migrationPath);
    expect(edge).toContain('operationId?: string;');
    expect(edge).toContain("code: 'INVALID_OPERATION_ID'");
    expect(edge).toContain("client.rpc('apply_widget_focus_action'");
    expect(edge).toContain('p_apply: false');
    expect(edge).toContain('p_apply: true');
    expect(edge).toContain('p_device_id: device.id');
    expect(edge).toContain('p_binding_generation: device.binding_generation');
    expect(edge).toContain('p_expected_updated_at: session.updated_at');
    expect(edge).toContain('p_next_session_state: actionResult.snapshot');
    expect(edge).toContain('operationId');
    expect(edge).toContain('if (operationId)');
    expect(edge).toContain('loadDevice(client, token)');
    expect(edge).toContain('loadLatestActiveFocusSession(client, device.user_id)');
    expect(migration).toContain("focus.updated_at = p_expected_updated_at");
    expect(migration).toContain("task.updated_at = v_task_base_updated_at");
    expect(migration).toContain("project.owner_id = p_user_id");
  });

  it('keeps legacy callers on the existing response-compatible CAS path', () => {
    const edge = read(edgePath);
    expect(edge).toContain('if (operationId) {');
    expect(edge).toContain(".from('focus_sessions')");
    expect(edge).toContain(".eq('updated_at', session.updated_at)");
    expect(edge).toContain("code: 'FOCUS_SESSION_CHANGED'");
    expect(edge).toContain('return jsonResponse(');
  });
});
