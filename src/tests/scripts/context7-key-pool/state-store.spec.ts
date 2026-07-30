import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

interface Identity {
  slot: number;
  fingerprintSha256: string;
}

interface PoolRecord {
  fingerprintSha256: string;
  attemptedCalls: number;
  successfulCalls: number;
  status: string;
  cooldownUntil: string | null;
  lastErrorClass: string | null;
  lastErrorAt: string | null;
  settledAttempts: Array<{ periodId: string; attemptOrdinal: number }>;
}

interface PoolState {
  periodId: string;
  timeZone: string;
  records: Record<string, PoolRecord>;
  activeSlots: Identity[];
  anonymousMode: { active: boolean; reason: string | null; since: string | null };
  updatedAt: string;
}

interface KeyedRoute {
  kind: 'keyed';
  periodId: string;
  slot: number;
  fingerprintSha256: string;
}

interface AnonymousRoute {
  kind: 'anonymous';
  reason: string;
}

type Route = KeyedRoute | AnonymousRoute;

interface ReservationToken extends KeyedRoute {
  attemptOrdinal: number;
  stateRevision: number;
}

interface StoreSnapshot {
  state: PoolState;
  health: { status: string; reason?: string };
  stateRevision: number | null;
}

interface StateStore {
  preview(context: StoreContext, options?: { excludeFingerprints?: string[] }): Promise<StoreSnapshot & { route: Route }>;
  reserveExpected(
    context: StoreContext,
    expectedRoute: Route,
    options?: { excludeFingerprints?: string[] },
  ): Promise<StoreSnapshot & {
    kind: 'retry' | 'keyed' | 'anonymous';
    route: Route;
    token: ReservationToken | null;
  }>;
  recordOutcome(context: StoreContext, token: ReservationToken, outcome: { kind: string }): Promise<StoreSnapshot>;
  read(context: StoreContext): Promise<StoreSnapshot>;
  inspectStored(): Promise<{
    state: PoolState | null;
    health: { status: string; reason?: string };
    stateRevision: number | null;
    reconciliation: 'not-applied';
  }>;
  appendEvent(event: Record<string, unknown>): Promise<void>;
}

interface StoreContext {
  identities: Identity[];
  timeZone: string;
}

interface Envelope {
  schemaVersion: 1;
  revision: number;
  checksumSha256: string;
  payload: PoolState;
}

const require = createRequire(import.meta.url);
const stateStorePath = join(process.cwd(), 'scripts/context7-key-pool/state-store.cjs');
const policyPath = join(process.cwd(), 'scripts/context7-key-pool/policy.cjs');
const workerPath = join(process.cwd(), 'src/tests/fixtures/context7-key-pool/state-reserve-worker.cjs');
const { createStateStore } = require(stateStorePath) as {
  createStateStore(options: {
    stateDir: string;
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
    lockWaitMs?: number;
    staleLockMs?: number;
    processExists?: (pid: number) => boolean | Promise<boolean>;
    maxEventBytes?: number;
    redact?: (value: unknown) => unknown;
  }): StateStore;
};
const policy = require(policyPath) as {
  validateStatePayload(state: PoolState): true;
  reconcileState(args: { state: PoolState | null; identities: Identity[]; timeZone: string; now: Date }): PoolState;
  markAnonymous(args: { state: PoolState; reason: string; now: Date }): PoolState;
};
const fsPromisesModule = require('node:fs/promises') as typeof import('node:fs/promises');

const NOW_ISO = '2026-07-30T12:00:00.000Z';
const identities: Identity[] = [1, 2, 3, 4].map(slot => ({
  slot,
  fingerprintSha256: String(slot).repeat(64),
}));
const context: StoreContext = { identities, timeZone: 'UTC' };
const temporaryRoots: string[] = [];

function canonicalTree(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-canonical-number');
    return value;
  }
  if (typeof value !== 'object') throw new Error('non-canonical-value');
  if (seen.has(value)) throw new Error('non-canonical-cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonicalTree(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('non-canonical-prototype');
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalTree((value as Record<string, unknown>)[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalTree(value));
}

function envelopeFor(payload: PoolState, revision: number): Envelope {
  const checksumSha256 = createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, revision, payload }))
    .digest('hex');
  return { schemaVersion: 1, revision, checksumSha256, payload };
}

async function makeStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), 'nanoflow-context7-state-'));
  temporaryRoots.push(stateDir);
  return stateDir;
}

function fixedStore(stateDir: string, overrides: Parameters<typeof createStateStore>[0] = { stateDir }): StateStore {
  return createStateStore({
    stateDir,
    now: () => new Date(NOW_ISO),
    ...overrides,
  });
}

async function readEnvelope(filePath: string): Promise<Envelope> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Envelope;
}

async function writePair(stateDir: string, envelope: Envelope): Promise<void> {
  const serialized = JSON.stringify(envelope);
  await writeFile(join(stateDir, 'state.json'), serialized, 'utf8');
  await writeFile(join(stateDir, 'state.backup.json'), serialized, 'utf8');
}

async function worker(stateDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, stateDir, NOW_ISO], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function stateWithoutUnexpectedKeys(state: PoolState): void {
  const forbidden = new Set(['transactionResult', 'result', 'reservation', 'token', 'stateRevision']);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      expect(forbidden.has(key)).toBe(false);
      visit(child);
    }
  };
  visit(state);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Context7 key-pool state store', () => {
  it('persists both replicas before returning a reservation', async () => {
    const stateDir = await makeStateDir();
    const store = fixedStore(stateDir);

    const preview = await store.preview(context);
    expect(preview.route.kind).toBe('keyed');
    const reserved = await store.reserveExpected(context, preview.route);

    expect(reserved.kind).toBe('keyed');
    expect(reserved.token?.stateRevision).toBe(reserved.stateRevision);
    const primary = await readEnvelope(join(stateDir, 'state.json'));
    const backup = await readEnvelope(join(stateDir, 'state.backup.json'));
    expect(primary).toEqual(backup);
    expect(primary.revision).toBe(reserved.stateRevision);
    expect(primary.payload.records[identities[0].fingerprintSha256].attemptedCalls).toBe(1);
  });

  it('selects the highest valid revision and repairs the other replica', async () => {
    const stateDir = await makeStateDir();
    const store = fixedStore(stateDir);
    await store.read(context);
    const older = await readEnvelope(join(stateDir, 'state.json'));
    const preview = await store.preview(context);
    const reserved = await store.reserveExpected(context, preview.route);
    expect(reserved.kind).toBe('keyed');
    const newer = await readEnvelope(join(stateDir, 'state.backup.json'));
    await writeFile(join(stateDir, 'state.json'), JSON.stringify(older), 'utf8');

    const recovered = await store.read(context);

    expect(recovered.health.status).toBe('recovered-replica');
    expect(recovered.stateRevision).toBe(newer.revision);
    expect(await readEnvelope(join(stateDir, 'state.json'))).toEqual(newer);
    expect(await readEnvelope(join(stateDir, 'state.backup.json'))).toEqual(newer);
  });

  it('rejects revision-only tampering and accepts reordered record keys with the same canonical checksum', async () => {
    const stateDir = await makeStateDir();
    const store = fixedStore(stateDir);
    await store.read(context);
    const original = await readEnvelope(join(stateDir, 'state.json'));
    await unlink(join(stateDir, 'state.backup.json'));
    await writeFile(join(stateDir, 'state.json'), JSON.stringify({
      ...original,
      revision: original.revision + 1,
    }), 'utf8');

    const tampered = await store.inspectStored();
    expect(tampered.state).toBeNull();
    expect(tampered.health.status).toBe('fail-closed');

    const reversedRecords = Object.fromEntries(Object.entries(original.payload.records).reverse());
    const reordered: Envelope = {
      payload: { ...original.payload, records: reversedRecords },
      checksumSha256: original.checksumSha256,
      revision: original.revision,
      schemaVersion: 1,
    };
    await writePair(stateDir, reordered);

    const accepted = await store.inspectStored();
    expect(accepted.health.status).toBe('healthy');
    expect(accepted.stateRevision).toBe(original.revision);
    expect(accepted.state).toEqual(original.payload);
  });

  it('fails closed on equal revisions with different checksums', async () => {
    const stateDir = await makeStateDir();
    const initial = policy.reconcileState({ state: null, identities, timeZone: 'UTC', now: new Date(NOW_ISO) });
    const anonymous = policy.markAnonymous({
      state: initial,
      reason: 'all-keyed-slots-unavailable',
      now: new Date(NOW_ISO),
    });
    await writeFile(join(stateDir, 'state.json'), JSON.stringify(envelopeFor(initial, 4)), 'utf8');
    await writeFile(join(stateDir, 'state.backup.json'), JSON.stringify(envelopeFor(anonymous, 4)), 'utf8');

    const inspected = await fixedStore(stateDir).inspectStored();

    expect(inspected.state).toBeNull();
    expect(inspected.stateRevision).toBeNull();
    expect(inspected.health.status).toBe('fail-closed');
  });

  it('archives dual corruption and persists a fail-closed mirrored revision', async () => {
    const stateDir = await makeStateDir();
    const invalid = {
      schemaVersion: 1,
      revision: 7,
      checksumSha256: '0'.repeat(64),
      payload: { deliberately: 'corrupt' },
    };
    await writeFile(join(stateDir, 'state.json'), JSON.stringify(invalid), 'utf8');
    await writeFile(join(stateDir, 'state.backup.json'), JSON.stringify(invalid), 'utf8');

    const recovered = await fixedStore(stateDir).read(context);

    expect(recovered.health.status).toBe('fail-closed');
    expect(recovered.stateRevision).toBe(8);
    expect(recovered.state.anonymousMode).toMatchObject({
      active: true,
      reason: 'state-unavailable-fail-closed',
    });
    const primary = await readEnvelope(join(stateDir, 'state.json'));
    const backup = await readEnvelope(join(stateDir, 'state.backup.json'));
    expect(primary).toEqual(backup);
    expect(primary.revision).toBe(8);
    const files = await readdir(stateDir);
    expect(files.filter(file => /^(state|state\.backup)\.json\.corrupt\./.test(file))).toHaveLength(2);

    const interruptedDir = await makeStateDir();
    await writeFile(join(interruptedDir, 'state.json'), JSON.stringify(invalid), 'utf8');
    await writeFile(
      join(interruptedDir, 'state.backup.json'),
      JSON.stringify({ ...invalid, revision: 9 }),
      'utf8',
    );
    const interruptedBackup = join(interruptedDir, 'state.backup.json');
    const originalRename = fsPromisesModule.rename.bind(fsPromisesModule);
    const renameSpy = vi.spyOn(fsPromisesModule, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.state.backup.tmp-') && String(to) === interruptedBackup) {
        throw Object.assign(new Error('injected-recovery-install-failure'), { code: 'EPERM' });
      }
      return originalRename(from, to);
    });
    await fixedStore(interruptedDir).read(context);
    renameSpy.mockRestore();

    const interrupted = await fixedStore(interruptedDir).inspectStored();
    expect(interrupted.health.status).toBe('fail-closed');

    await writeFile(
      join(interruptedDir, 'state.json.corrupt.rev-9007199254740992.at-0-00000000-0000-4000-8000-000000000000'),
      '{}',
      'utf8',
    );
    await writeFile(
      join(interruptedDir, 'unrelated.json.corrupt.rev-99.at-0-00000000-0000-4000-8000-000000000000'),
      '{}',
      'utf8',
    );
    await writeFile(
      join(interruptedDir, 'state.json.corrupt.rev-99.at-0-not-a-uuid'),
      '{}',
      'utf8',
    );

    const retried = await fixedStore(interruptedDir).read(context);
    expect(retried.stateRevision).toBe(10);
  });

  it('treats non-ENOENT read errors as storage failure, not first run', async () => {
    const stateDir = await makeStateDir();
    await mkdir(join(stateDir, 'state.json'));

    const preview = await fixedStore(stateDir).preview(context);

    expect(preview.health.status).toBe('fail-closed');
    expect(preview.route).toEqual({ kind: 'anonymous', reason: 'state-unavailable-fail-closed' });
    expect((await stat(join(stateDir, 'state.json'))).isDirectory()).toBe(true);
    await expect(stat(join(stateDir, 'state.backup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns only a synthetic fail-closed anonymous route when storage is unavailable', async () => {
    const parentDir = await makeStateDir();
    const unavailablePath = join(parentDir, 'not-a-directory');
    await writeFile(unavailablePath, 'occupied', 'utf8');
    const store = fixedStore(unavailablePath);

    const preview = await store.preview(context);
    const reserved = await store.reserveExpected(context, {
      kind: 'keyed',
      periodId: '2026-07',
      slot: 1,
      fingerprintSha256: identities[0].fingerprintSha256,
    });

    expect(preview).toMatchObject({
      route: { kind: 'anonymous', reason: 'state-unavailable-fail-closed' },
      health: { status: 'fail-closed' },
      stateRevision: null,
    });
    expect(preview.state.activeSlots).toEqual(identities);
    expect(Object.values(preview.state.records).every(record => record.status === 'cooldown')).toBe(true);
    expect(reserved).toMatchObject({
      kind: 'anonymous',
      route: { kind: 'anonymous', reason: 'state-unavailable-fail-closed' },
      token: null,
      health: { status: 'fail-closed' },
      stateRevision: null,
    });
    expect(await readFile(unavailablePath, 'utf8')).toBe('occupied');

    const invalidClockDir = await makeStateDir();
    let clockSamples = 0;
    const invalidClock = createStateStore({
      stateDir: invalidClockDir,
      now: () => {
        clockSamples += 1;
        return new Date(Number.NaN);
      },
    });
    await expect(invalidClock.preview(context)).rejects.toThrow('state-time-invalid');
    expect(clockSamples).toBe(1);
  });

  it('never steals an old lock owned by a live pid', async () => {
    const stateDir = await makeStateDir();
    const lockDir = join(stateDir, 'state.lock');
    const ownerPath = join(lockDir, 'owner.json');
    await mkdir(lockDir);
    const owner = {
      ownerId: '11111111-1111-4111-8111-111111111111',
      pid: process.pid,
      claimedAt: '2000-01-01T00:00:00.000Z',
    };
    await writeFile(ownerPath, JSON.stringify(owner), 'utf8');
    const old = new Date('2000-01-01T00:00:00.000Z');
    await utimes(ownerPath, old, old);
    await utimes(lockDir, old, old);
    const store = fixedStore(stateDir, {
      stateDir,
      lockWaitMs: 30,
      staleLockMs: 1,
      processExists: () => true,
      sleep: milliseconds => new Promise(resolve => setTimeout(resolve, Math.min(milliseconds, 5))),
    });

    const preview = await store.preview(context);

    expect(preview.health.status).toBe('fail-closed');
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual(owner);
  });

  it('quarantines a proven-dead stale lock and token-checks release', async () => {
    const stateDir = await makeStateDir();
    const lockDir = join(stateDir, 'state.lock');
    const ownerPath = join(lockDir, 'owner.json');
    await mkdir(lockDir);
    await writeFile(ownerPath, JSON.stringify({
      ownerId: '22222222-2222-4222-8222-222222222222',
      pid: 424_242,
      claimedAt: '2000-01-01T00:00:00.000Z',
    }), 'utf8');
    await writeFile(join(lockDir, 'dead-owner-sentinel'), 'stale', 'utf8');
    const old = new Date('2000-01-01T00:00:00.000Z');
    await utimes(ownerPath, old, old);
    await utimes(lockDir, old, old);
    const originalReconcile = policy.reconcileState;
    policy.reconcileState = args => {
      const state = originalReconcile(args);
      writeFileSync(ownerPath, JSON.stringify({
        ownerId: '33333333-3333-4333-8333-333333333333',
        pid: process.pid,
        claimedAt: NOW_ISO,
      }), 'utf8');
      return state;
    };
    try {
      const store = fixedStore(stateDir, {
        stateDir,
        staleLockMs: 1,
        processExists: pid => pid !== 424_242,
      });

      const snapshot = await store.read(context);

      expect(snapshot.health.status).toBe('healthy');
      expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toMatchObject({
        ownerId: '33333333-3333-4333-8333-333333333333',
      });
      await expect(stat(join(lockDir, 'dead-owner-sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(stateDir)).some(file => file.includes('dead-owner') && file.includes('quarantine'))).toBe(false);
    } finally {
      policy.reconcileState = originalReconcile;
    }
  });

  it('fails closed on malformed published lock ownership instead of stealing it', async () => {
    const stateDir = await makeStateDir();
    const lockDir = join(stateDir, 'state.lock');
    const ownerPath = join(lockDir, 'owner.json');
    await mkdir(lockDir);
    await writeFile(ownerPath, '{malformed', 'utf8');
    const old = new Date('2000-01-01T00:00:00.000Z');
    await utimes(ownerPath, old, old);
    await utimes(lockDir, old, old);
    const store = fixedStore(stateDir, {
      stateDir,
      lockWaitMs: 30,
      staleLockMs: 1,
      processExists: () => false,
      sleep: milliseconds => new Promise(resolve => setTimeout(resolve, Math.min(milliseconds, 5))),
    });

    const preview = await store.preview(context);

    expect(preview.health.status).toBe('fail-closed');
    expect(await readFile(ownerPath, 'utf8')).toBe('{malformed');
  });

  it('rejects keyed dispatch when either mirrored replace cannot complete', async () => {
    for (const destinationName of ['state.backup.json', 'state.json']) {
      const stateDir = await makeStateDir();
      const store = fixedStore(stateDir);
      const preview = await store.preview(context);
      expect(preview.route.kind).toBe('keyed');
      const destination = join(stateDir, destinationName);
      const originalRename = fsPromisesModule.rename.bind(fsPromisesModule);
      const renameSpy = vi.spyOn(fsPromisesModule, 'rename').mockImplementation(async (from, to) => {
        if (String(from).includes('.tmp-') && String(to) === destination) {
          const error = Object.assign(new Error('injected-replace-failure'), { code: 'EPERM' });
          throw error;
        }
        return originalRename(from, to);
      });

      const reserved = await store.reserveExpected(context, preview.route);

      expect(reserved).toMatchObject({
        kind: 'anonymous',
        token: null,
        health: { status: 'fail-closed' },
      });
      renameSpy.mockRestore();
    }
  });

  it('serializes 40 reservation worker processes with an exact total of 40', async () => {
    const stateDir = await makeStateDir();

    const results = await Promise.all(Array.from({ length: 40 }, () => worker(stateDir)));

    expect(results.every(result => result.code === 0 && result.stdout === '' && result.stderr === '')).toBe(true);
    const inspected = await fixedStore(stateDir).inspectStored();
    expect(inspected.health.status).toBe('healthy');
    expect(Object.values(inspected.state!.records)
      .reduce((total, record) => total + record.attemptedCalls, 0)).toBe(40);
  }, 60_000);

  it('allows exactly one ordinal 950 when workers race from 949', async () => {
    const stateDir = await makeStateDir();
    const seeded = policy.reconcileState({ state: null, identities, timeZone: 'UTC', now: new Date(NOW_ISO) });
    seeded.records[identities[0].fingerprintSha256].attemptedCalls = 949;
    policy.validateStatePayload(seeded);
    await writePair(stateDir, envelopeFor(seeded, 12));

    const results = await Promise.all(Array.from({ length: 16 }, () => worker(stateDir)));

    expect(results.every(result => result.code === 0 && result.stdout === '' && result.stderr === '')).toBe(true);
    const inspected = await fixedStore(stateDir).inspectStored();
    const first = inspected.state!.records[identities[0].fingerprintSha256];
    expect(first.attemptedCalls).toBe(950);
    expect(first.status).toBe('soft-exhausted');
  }, 60_000);

  it('never persists transaction result or reservation token in the payload', async () => {
    const stateDir = await makeStateDir();
    const store = fixedStore(stateDir);
    const preview = await store.preview(context);
    const reserved = await store.reserveExpected(context, preview.route);
    expect(reserved.kind).toBe('keyed');
    await store.recordOutcome(context, reserved.token!, { kind: 'success' });

    const envelope = await readEnvelope(join(stateDir, 'state.json'));

    stateWithoutUnexpectedKeys(envelope.payload);
  });

  it('rejects same-period count, record, settlement and auth-invalid rollback', async () => {
    const stateDir = await makeStateDir();
    const store = fixedStore(stateDir);
    const firstPreview = await store.preview(context);
    const first = await store.reserveExpected(context, firstPreview.route);
    const secondPreview = await store.preview(context);
    const second = await store.reserveExpected(context, secondPreview.route);
    expect(first.kind).toBe('keyed');
    expect(second.kind).toBe('keyed');
    await store.recordOutcome(context, first.token!, { kind: 'auth-invalid' });
    const baseline = await store.inspectStored();
    expect(baseline.state!.records[identities[0].fingerprintSha256]).toMatchObject({
      attemptedCalls: 2,
      status: 'auth-invalid',
    });

    const originalReconcile = policy.reconcileState;
    const mutations: Array<(state: PoolState) => void> = [
      state => { state.records[identities[0].fingerprintSha256].attemptedCalls = 1; },
      state => {
        delete state.records[identities[1].fingerprintSha256];
        state.activeSlots = state.activeSlots.filter(identity => identity.slot !== 2);
      },
      state => { state.records[identities[0].fingerprintSha256].settledAttempts = []; },
      state => {
        const record = state.records[identities[0].fingerprintSha256];
        record.status = 'healthy';
        record.lastErrorClass = null;
        record.lastErrorAt = null;
      },
    ];
    try {
      for (const mutate of mutations) {
        policy.reconcileState = args => {
          const next = structuredClone(originalReconcile(args));
          mutate(next);
          policy.validateStatePayload(next);
          return next;
        };

        const rejected = await store.read(context);
        const after = await store.inspectStored();

        expect(rejected.health.status).toBe('fail-closed');
        expect(after.stateRevision).toBe(baseline.stateRevision);
        expect(after.state).toEqual(baseline.state);
      }

      policy.reconcileState = args => {
        const next = args.state!;
        next.records[identities[0].fingerprintSha256].attemptedCalls = 1;
        policy.validateStatePayload(next);
        return next;
      };
      const inPlaceRejected = await store.read(context);
      const afterInPlace = await store.inspectStored();
      expect(inPlaceRejected.health.status).toBe('fail-closed');
      expect(afterInPlace.stateRevision).toBe(baseline.stateRevision);
      expect(afterInPlace.state).toEqual(baseline.state);
    } finally {
      policy.reconcileState = originalReconcile;
    }
  });

  it('does not increment revision for a no-op, duplicate outcome or replica-only repair', async () => {
    const stateDir = await makeStateDir();
    const store = fixedStore(stateDir);
    const initialized = await store.read(context);
    const noOp = await store.read(context);
    expect(noOp.stateRevision).toBe(initialized.stateRevision);

    const preview = await store.preview(context);
    const reserved = await store.reserveExpected(context, preview.route);
    expect(reserved.kind).toBe('keyed');
    const settled = await store.recordOutcome(context, reserved.token!, { kind: 'success' });
    const duplicate = await store.recordOutcome(context, reserved.token!, { kind: 'success' });
    expect(duplicate.stateRevision).toBe(settled.stateRevision);

    await unlink(join(stateDir, 'state.backup.json'));
    const repaired = await store.read(context);
    expect(repaired.health.status).toBe('recovered-replica');
    expect(repaired.stateRevision).toBe(settled.stateRevision);
    expect(await readEnvelope(join(stateDir, 'state.backup.json')))
      .toEqual(await readEnvelope(join(stateDir, 'state.json')));
  });

  it('rotates events.jsonl and redacts secrets without recording query text', async () => {
    const stateDir = await makeStateDir();
    const syntheticSecret = 'SYNTHETIC_SECRET_DO_NOT_RECORD';
    const rawFingerprint = 'f'.repeat(64);
    const queryText = `private query ${syntheticSecret}`;
    const noRedactorDir = await makeStateDir();
    await expect(fixedStore(noRedactorDir).appendEvent({
      event: 'request-settled',
      reason: 'ctx7sk-synthetic-credential-token',
    })).rejects.toThrow();
    await expect(stat(join(noRedactorDir, 'events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    let redactCalls = 0;
    const store = fixedStore(stateDir, {
      stateDir,
      maxEventBytes: 220,
      redact: value => {
        redactCalls += 1;
        return JSON.parse(JSON.stringify(value).replaceAll(syntheticSecret, '[redacted]'));
      },
    });

    for (let attemptOrdinal = 1; attemptOrdinal <= 8; attemptOrdinal += 1) {
      await store.appendEvent({
        event: 'request-settled',
        slot: 1,
        fingerprintSha256_12: rawFingerprint.slice(0, 12),
        fingerprintSha256: rawFingerprint,
        attemptOrdinal,
        failureClass: 'transient',
        query: queryText,
        result: syntheticSecret,
      });
    }

    const eventFiles = (await readdir(stateDir)).filter(file => file.startsWith('events') && file.endsWith('.jsonl'));
    expect(eventFiles.length).toBeGreaterThan(1);
    const persisted = (await Promise.all(eventFiles.map(file => readFile(join(stateDir, file), 'utf8')))).join('\n');
    expect(persisted).not.toContain(syntheticSecret);
    expect(persisted).not.toContain(queryText);
    expect(persisted).not.toContain(rawFingerprint);
    expect(persisted).not.toContain('"query"');
    expect(persisted).toContain(rawFingerprint.slice(0, 12));
    expect(redactCalls).toBe(8);
  });

  it('inspectStored is non-mutating and reports reconciliation not applied', async () => {
    const stateDir = await makeStateDir();
    let sampledNow = '2026-01-15T12:00:00.000Z';
    const store = createStateStore({ stateDir, now: () => new Date(sampledNow) });
    const initialized = await store.read(context);
    const primaryPath = join(stateDir, 'state.json');
    const backupPath = join(stateDir, 'state.backup.json');
    const beforePrimary = await stat(primaryPath, { bigint: true });
    const beforeBackup = await stat(backupPath, { bigint: true });
    const beforeFiles = await readdir(stateDir);
    sampledNow = '2026-02-15T12:00:00.000Z';

    const inspected = await store.inspectStored();

    const afterPrimary = await stat(primaryPath, { bigint: true });
    const afterBackup = await stat(backupPath, { bigint: true });
    expect(inspected).toMatchObject({
      reconciliation: 'not-applied',
      stateRevision: initialized.stateRevision,
      health: { status: 'healthy' },
    });
    expect(inspected.state?.periodId).toBe('2026-01');
    expect(afterPrimary.mtimeNs).toBe(beforePrimary.mtimeNs);
    expect(afterBackup.mtimeNs).toBe(beforeBackup.mtimeNs);
    expect(await readdir(stateDir)).toEqual(beforeFiles);
  });
});
