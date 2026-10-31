import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const indexPath = path.join(process.cwd(), 'supabase/functions/widget-notify/index.ts');
const helperPath = path.join(process.cwd(), 'supabase/functions/widget-notify/focus-hint-payload.ts');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

async function loadHelper() {
  expect(fs.existsSync(helperPath), 'focus hint helper should exist').toBe(true);
  return import(pathToFileURL(helperPath).href);
}

function focusPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'UPDATE',
    table: 'focus_sessions',
    record: {
      id: 'session-1',
      updated_at: '2026-07-30T10:11:12.123456+08:00',
      ended_at: null,
    },
    old_record: null,
    ...overrides,
  };
}

function committedInput(payload = focusPayload()) {
  return {
    source: 'committed-db-webhook' as const,
    eventId: 'event-1',
    deviceId: 'device-1',
    bindingGeneration: 7,
    payload,
  };
}

describe('widget notify committed focus hint binding', () => {
  it('classifies verified request source before payload normalization without payload inference', () => {
    const source = read(indexPath);
    const standardVerify = source.indexOf('verifiedPayload = webhook.verify');
    const directFlag = source.indexOf("parsedBody['directNotify'] !== true");
    const customVerify = source.indexOf('verifiedPayload = customWebhook.payload');
    const normalize = source.indexOf('const payload = normalizeDatabaseWebhookPayload');
    const classification = source.slice(standardVerify, normalize);

    expect(source).toContain("from './focus-hint-payload.ts'");
    expect(standardVerify).toBeGreaterThan(-1);
    expect(directFlag).toBeGreaterThan(standardVerify);
    expect(customVerify).toBeGreaterThan(directFlag);
    expect(normalize).toBeGreaterThan(customVerify);
    expect(source.indexOf("notifySource = 'committed-db-webhook'", standardVerify)).toBeLessThan(directFlag);
    expect(source.indexOf("notifySource = 'direct-notify'", directFlag)).toBeLessThan(customVerify);
    expect(source.indexOf("notifySource = 'committed-db-webhook'", customVerify)).toBeLessThan(normalize);
    expect(classification.match(/notifySource = /g)).toHaveLength(3);
    expect(classification).not.toContain('summaryCursor');
  });

  it('suppresses every focus hint for authenticated direct notify', async () => {
    const { buildFocusHintPayload } = await loadHelper();
    expect(buildFocusHintPayload({ ...committedInput(), source: 'direct-notify' })).toBeNull();
  });

  it('emits all six committed evidence fields for each current device binding', async () => {
    const { buildFocusHintPayload } = await loadHelper();
    expect(buildFocusHintPayload(committedInput())).toEqual({
      focusActiveHint: 'true',
      focusSessionHint: 'session-1',
      focusRevisionMicrosHint: '1785377472123456',
      focusEventIdHint: 'event-1',
      focusDeviceIdHint: 'device-1',
      focusBindingGenerationHint: '7',
    });
    expect(buildFocusHintPayload(committedInput(focusPayload({
      record: {
        id: 'session-1',
        updated_at: '2026-07-30T10:11:12.123456+08:00',
        ended_at: '2026-07-30T10:12:00+08:00',
      },
    })))?.focusActiveHint).toBe('false');
  });

  it('normalizes timezone-aware fractional instants and rejects unsafe timestamp forms', async () => {
    const { buildFocusHintPayload } = await loadHelper();
    const committedParser = vi.fn((value: string | null | undefined) => {
      const parsed = value ? Date.parse(value) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : null;
    });
    expect(buildFocusHintPayload(committedInput(), committedParser)).not.toBeNull();
    for (const updatedAt of [
      '2026-07-30T10:11:12.123456',
      '2026-07-30T10:11:12.123456+08:00|tail',
      'not-a-timestamp',
      '',
    ]) {
      expect(buildFocusHintPayload(committedInput(focusPayload({
        record: { id: 'session-1', updated_at: updatedAt, ended_at: null },
      })), committedParser)).toBeNull();
    }
    expect(committedParser).toHaveBeenCalledOnce();
  });

  it('preserves microsecond ordering with the committed millisecond parser contract', async () => {
    const { buildFocusHintPayload } = await loadHelper();
    const committedParser = vi.fn((value: string | null | undefined): number | null => {
      if (!value) return null;
      const timestamp = value.split('|', 1)[0];
      const parsed = Date.parse(timestamp);
      return Number.isFinite(parsed) ? parsed : null;
    });
    const revisionFor = (updatedAt: string) => buildFocusHintPayload(
      committedInput(focusPayload({
        record: { id: 'session-1', updated_at: updatedAt, ended_at: null },
      })),
      committedParser,
    )?.focusRevisionMicrosHint;

    const earlier = revisionFor('2026-07-30T10:11:12.123456+08:00');
    const later = revisionFor('2026-07-30T10:11:12.123457+08:00');
    const equivalent = revisionFor('2026-07-30T02:11:12.123456Z');

    expect(committedParser).toHaveBeenCalledTimes(3);
    expect(earlier).toBe('1785377472123456');
    expect(later).toBe('1785377472123457');
    expect(BigInt(later as string)).toBeGreaterThan(BigInt(earlier as string));
    expect(equivalent).toBe(earlier);
  });

  it('accepts the characterized bigint microsecond parser contract', async () => {
    const { buildFocusHintPayload } = await loadHelper();
    const bigintParser = vi.fn(() => 1785377472123456n);
    const result = buildFocusHintPayload(committedInput(), bigintParser);

    expect(bigintParser).toHaveBeenCalledOnce();
    expect(result?.focusRevisionMicrosHint).toBe('1785377472123456');
  });

  it('uses old_record evidence for DELETE and forces inactive', async () => {
    const { buildFocusHintPayload } = await loadHelper();
    expect(buildFocusHintPayload(committedInput(focusPayload({
      type: 'DELETE',
      record: null,
      old_record: {
        id: 'deleted-session',
        updated_at: '2026-07-30T02:11:12.000001Z',
        ended_at: null,
      },
    })))).toMatchObject({
      focusActiveHint: 'false',
      focusSessionHint: 'deleted-session',
      focusRevisionMicrosHint: '1785377472000001',
    });
  });

  it('suppresses only the hint for missing or invalid focus evidence', async () => {
    const { buildFocusHintPayload } = await loadHelper();
    for (const payload of [
      focusPayload({ record: { id: 'session-1', ended_at: null } }),
      focusPayload({ record: { id: 1, updated_at: '2026-07-30T02:11:12Z', ended_at: null } }),
      focusPayload({ record: { id: 'session-1', updated_at: '2026-07-30T02:11:12Z' } }),
      focusPayload({ record: { id: 'session-1', updated_at: '2026-07-30T02:11:12Z', ended_at: 42 } }),
      focusPayload({ record: { id: 'session-1', updated_at: '2026-07-30T02:11:12Z', ended_at: 'invalid' } }),
      focusPayload({ table: 'tasks' }),
    ]) {
      expect(buildFocusHintPayload(committedInput(payload))).toBeNull();
    }

    const source = read(indexPath);
    const fanoutStart = source.indexOf('const fanoutResults = await mapWithConcurrency');
    const dataStart = source.indexOf('data: {', fanoutStart);
    const dataEnd = source.indexOf('          },\n        });', dataStart);
    const dataPayload = source.slice(dataStart, dataEnd);
    expect(dataPayload).toContain("type: 'widget_dirty'");
    expect(dataPayload).toContain('table: payload.table');
    expect(dataPayload).toContain('eventType: payload.type');
    expect(dataPayload).toContain("action: 'widget-refresh'");
    expect(dataPayload).toContain('...(focusHintForDevice ? focusHintForDevice : {})');
  });

  it('binds evidence to the eligible device inside the bounded fanout callback', () => {
    const source = read(indexPath);
    const fanout = source.slice(source.indexOf('const fanoutResults = await mapWithConcurrency'));

    expect(fanout).toContain('const focusHintForDevice = buildFocusHintPayload({');
    expect(fanout).toContain('eventId: webhookId');
    expect(fanout).toContain('deviceId: device.id');
    expect(fanout).toContain('bindingGeneration: device.binding_generation');
    expect(fanout.indexOf('const focusHintForDevice')).toBeLessThan(fanout.indexOf('sendFcmDataPush'));
  });

  it('does not add focus evidence or raw identifiers to telemetry', () => {
    const indexSource = read(indexPath);
    const helperSource = fs.existsSync(helperPath) ? read(helperPath) : '';

    expect(helperSource).not.toMatch(/console\.|logWidgetEvent|\bextra\b|\buserId\b|\btoken\b|\bsecret\b/);
    expect(indexSource).not.toMatch(/extra\s*:\s*\{[^}]*focus(?:Active|Session|RevisionMicros|EventId|DeviceId|BindingGeneration)Hint/s);
  });
});
