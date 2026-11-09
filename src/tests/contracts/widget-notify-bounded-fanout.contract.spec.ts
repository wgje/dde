import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260716001000_widget_notify_bounded_fanout_rpc.sql';
const initPath = 'scripts/init-supabase.sql';
const notifyPath = 'supabase/functions/widget-notify/index.ts';
const fanoutPath = 'supabase/functions/widget-notify/fanout.ts';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractFunctionSource(sourceText: string, functionName: string): string {
  const signature = `function ${functionName}(`;
  const start = sourceText.indexOf(signature);
  expect(start, `Function ${functionName} should exist`).toBeGreaterThanOrEqual(0);

  const bodyStart = sourceText.indexOf('{', start);
  expect(bodyStart, `Function ${functionName} should have a body`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return sourceText.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Failed to extract function ${functionName}`);
}

describe('widget notify bounded fanout contract', () => {
  it('filters active device bindings in a service-role-only RPC capped at 100 rows', () => {
    const migration = normalize(read(migrationPath));
    const init = normalize(read(initPath));

    for (const sql of [migration, init]) {
      expect(sql).toContain(
        'create or replace function public.list_widget_notify_devices( p_user_id uuid, p_limit integer default 100 )',
      );
      expect(sql).toContain("device.platform = 'android-widget'");
      expect(sql).toContain('device.revoked_at is null');
      expect(sql).toContain('device.expires_at > now()');
      expect(sql).toContain("nullif(btrim(device.push_token), '') is not null");
      expect(sql).toContain('instance.device_id = device.id');
      expect(sql).toContain('instance.binding_generation = device.binding_generation');
      expect(sql).toContain('instance.uninstalled_at is null');
      expect(sql).toContain('order by device.last_seen_at desc, device.id asc');
      expect(sql).toContain('limit least(greatest(coalesce(p_limit, 100), 1), 100)');
      expect(sql).toContain('security invoker');
      expect(sql).toContain("set search_path = ''");
      expect(sql).toContain(
        'revoke all on function public.list_widget_notify_devices(uuid, integer) from public, anon, authenticated, service_role',
      );
      expect(sql).toContain(
        'grant execute on function public.list_widget_notify_devices(uuid, integer) to service_role',
      );
    }
  });

  it('loads at most 100 devices through the RPC and fans out with at most 8 workers', async () => {
    const notify = read(notifyPath);
    const loadDevices = extractFunctionSource(notify, 'loadActiveAndroidDevices');

    expect(loadDevices).toContain(".rpc<WidgetDeviceRow[]>('list_widget_notify_devices'");
    expect(loadDevices).toContain('p_limit: WIDGET_NOTIFY_DEVICE_LIMIT');
    expect(loadDevices).toContain('.slice(0, WIDGET_NOTIFY_DEVICE_LIMIT)');
    expect(loadDevices).not.toContain(".from('widget_instances')");
    expect(loadDevices).not.toContain(".from('widget_devices')");
    expect(notify).toContain('mapWithConcurrency(');
    expect(notify).toContain('WIDGET_NOTIFY_FCM_CONCURRENCY');
    expect(notify).not.toContain('Promise.all(\n      eligibleDevices.map');

    const absoluteFanoutPath = path.join(process.cwd(), fanoutPath);
    expect(fs.existsSync(absoluteFanoutPath), `${fanoutPath} should exist`).toBe(true);
    if (!fs.existsSync(absoluteFanoutPath)) return;

    const fanoutModule = await import(/* @vite-ignore */ pathToFileURL(absoluteFanoutPath).href);
    expect(fanoutModule.WIDGET_NOTIFY_DEVICE_LIMIT).toBe(100);
    expect(fanoutModule.WIDGET_NOTIFY_FCM_CONCURRENCY).toBe(8);

    const values = Array.from({ length: 24 }, (_, index) => index);
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    let startedWorkers = 0;
    let releaseFirstWave!: () => void;
    const firstWaveGate = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });

    const resultPromise = fanoutModule.mapWithConcurrency(
      values,
      fanoutModule.WIDGET_NOTIFY_FCM_CONCURRENCY,
      async (value: number) => {
        activeWorkers += 1;
        startedWorkers += 1;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
        if (startedWorkers <= fanoutModule.WIDGET_NOTIFY_FCM_CONCURRENCY) {
          await firstWaveGate;
        }
        activeWorkers -= 1;
        return value * 2;
      },
    );

    await Promise.resolve();
    expect(startedWorkers).toBe(8);
    expect(maxActiveWorkers).toBe(8);
    releaseFirstWave();

    await expect(resultPromise).resolves.toEqual(values.map(value => value * 2));
    expect(maxActiveWorkers).toBeLessThanOrEqual(8);
  });
});
