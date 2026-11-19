import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const { OverlayQueryWorkerPool } = requireCjs('../../../scripts/lib/codegraph-overlay-worker-pool.cjs') as WorkerPoolApi;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface WorkerResult {
  ok: boolean;
  outputText?: string;
  pid: number | null;
  elapsedMs: number;
  cacheHit?: boolean;
  failureClass?: string;
}
interface WorkerPool {
  request(args: string[], timeoutMs: number, metadata?: Record<string, unknown>): Promise<WorkerResult>;
  close(): void;
}
interface WorkerPoolApi {
  OverlayQueryWorkerPool: new (options: {
    root: string;
    scriptPath: string;
    size: number;
    maxBufferBytes: number;
    maxQueueSize?: number;
    env?: NodeJS.ProcessEnv;
    onEvent?: (event: string, data: Record<string, unknown>) => void;
  }) => WorkerPool;
}

function createFakeWorker(delayMs: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'overlay-worker-pool-'));
  roots.push(root);
  const scriptPath = path.join(root, 'worker.cjs');
  const startLog = path.join(root, 'starts.log');
  const crashMarker = path.join(root, 'crash-once.marker');
  writeFileSync(scriptPath, `
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.OVERLAY_WORKER_START_LOG, 'start\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
void (async () => {
  for await (const line of rl) {
    const request = JSON.parse(line);
    const args = request.args || [];
    if (args.includes('--crash-once') && !fs.existsSync(process.env.OVERLAY_WORKER_CRASH_MARKER)) {
      fs.writeFileSync(process.env.OVERLAY_WORKER_CRASH_MARKER, 'crashed');
      process.stderr.write('fixture worker crash\\n');
      process.exit(17);
    }
    if (args.includes('--hold')) continue;
    if (args.includes('--malformed')) {
      process.stdout.write('not-json\\n');
      continue;
    }
    const delay = args.includes('--slow') ? 500 : ${delayMs};
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, outputText: JSON.stringify({ query: args.join(' ') }), cacheHit: true, generationId: 'g-test', profileEvents: [] }) + '\\n');
    }, delay);
  }
})();
`, 'utf8');
  return {
    root,
    scriptPath,
    startLog,
    env: { ...process.env, OVERLAY_WORKER_START_LOG: startLog, OVERLAY_WORKER_CRASH_MARKER: crashMarker },
  };
}

async function waitForFileLines(filePath: string, expectedLines: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
      if (lines.length >= expectedLines) return;
    } catch {
      // The worker creates the file after spawn.
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`worker did not start ${expectedLines} times`);
}

describe('persistent overlay worker pool', () => {
  it('reuses a warm worker for subsequent requests and correlates result IDs', async () => {
    const fixture = createFakeWorker(5);
    const pool = new OverlayQueryWorkerPool({ ...fixture, size: 1, maxBufferBytes: 1024 * 1024 });
    try {
      const first = await pool.request(['--query', 'first'], 1000, { queryId: 'pair-1' });
      const second = await pool.request(['--query', 'second'], 1000, { queryId: 'pair-2' });
      expect(first.ok).toBe(true);
      expect(JSON.parse(first.outputText ?? '').query).toContain('first');
      expect(second.ok).toBe(true);
      expect(JSON.parse(second.outputText ?? '').query).toContain('second');
      expect(second.pid).toBe(first.pid);
      expect(readFileSync(fixture.startLog, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
    } finally {
      pool.close();
    }
  });

  it('recycles a timed-out worker and serves the next queued request on a fresh worker', async () => {
    const fixture = createFakeWorker(1);
    const pool = new OverlayQueryWorkerPool({ ...fixture, size: 1, maxBufferBytes: 1024 * 1024 });
    try {
      await pool.request(['--query', 'warm-up'], 1000);
      await expect(pool.request(['--slow'], 40, { queryId: 'timeout' })).rejects.toMatchObject({
        failureClass: 'overlay-timeout',
        timedOut: true,
      });
      const recovered = await pool.request(['--query', 'recovered'], 1500, { queryId: 'after-timeout' });
      expect(recovered.ok).toBe(true);
      expect(JSON.parse(recovered.outputText ?? '').query).toContain('recovered');
      expect(readFileSync(fixture.startLog, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
    } finally {
      pool.close();
    }
  });

  it('uses a bounded worker pool to avoid serializing independent overlay queries', async () => {
    const fixture = createFakeWorker(80);
    const pool = new OverlayQueryWorkerPool({ ...fixture, size: 2, maxBufferBytes: 1024 * 1024 });
    try {
      const [left, right] = await Promise.all([
        pool.request(['--query', 'left'], 1500),
        pool.request(['--query', 'right'], 1500),
      ]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      expect(left.pid).not.toBe(right.pid);
      expect(readFileSync(fixture.startLog, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
    } finally {
      pool.close();
    }
  });

  it('bounds the pending queue and rejects overload with a backpressure diagnostic', async () => {
    const fixture = createFakeWorker(120);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const pool = new OverlayQueryWorkerPool({
      ...fixture, size: 1, maxBufferBytes: 1024 * 1024, maxQueueSize: 1,
      onEvent: (event, data) => events.push({ event, data }),
    });
    try {
      const active = pool.request(['--query', 'active'], 1500);
      await waitForFileLines(fixture.startLog, 1);
      const queued = pool.request(['--query', 'queued'], 1500);
      await expect(pool.request(['--query', 'overflow'], 1500)).rejects.toMatchObject({
        failureClass: 'overlay-worker-backpressure',
        queueDepth: 1,
        maxQueueSize: 1,
      });
      await expect(active).resolves.toMatchObject({ ok: true });
      await expect(queued).resolves.toMatchObject({ ok: true });
      expect(events.some(item => item.event === 'overlay-worker.backpressure')).toBe(true);
    } finally {
      pool.close();
    }
  });

  it('reports malformed worker output and restarts a crashed worker for later jobs', async () => {
    const fixture = createFakeWorker(5);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const pool = new OverlayQueryWorkerPool({
      ...fixture, size: 1, maxBufferBytes: 1024 * 1024,
      onEvent: (event, data) => events.push({ event, data }),
    });
    try {
      await expect(pool.request(['--malformed'], 1000)).rejects.toMatchObject({
        failureClass: 'overlay-json-parse',
      });
      const afterMalformed = await pool.request(['--query', 'after-malformed'], 1000);
      expect(afterMalformed.ok).toBe(true);
      await expect(pool.request(['--crash-once'], 1000)).rejects.toMatchObject({
        failureClass: 'overlay-worker-exit',
        exitCode: 17,
      });
      const afterCrash = await pool.request(['--query', 'after-crash'], 1000);
      expect(afterCrash.ok).toBe(true);
      await waitForFileLines(fixture.startLog, 3);
      expect(events.some(item => item.event === 'overlay-worker.response' && item.data.ok === false)).toBe(true);
      expect(readFileSync(fixture.startLog, 'utf8').trim().split(/\r?\n/)).toHaveLength(3);
    } finally {
      pool.close();
    }
  });

  it('rejects active and queued work on close and refuses new requests', async () => {
    const fixture = createFakeWorker(5);
    const pool = new OverlayQueryWorkerPool({ ...fixture, size: 1, maxBufferBytes: 1024 * 1024 });
    const active = pool.request(['--hold'], 5000);
    await waitForFileLines(fixture.startLog, 1);
    const queued = pool.request(['--query', 'queued'], 1500);
    const activeRejected = expect(active).rejects.toMatchObject({ message: 'overlay-worker-pool-closed' });
    const queuedRejected = expect(queued).rejects.toMatchObject({ message: 'overlay-worker-pool-closed' });
    pool.close();
    await activeRejected;
    await queuedRejected;
    await expect(pool.request(['--query', 'after-close'], 1000)).rejects.toMatchObject({
      message: 'overlay-worker-pool-closed',
    });
  });



});
