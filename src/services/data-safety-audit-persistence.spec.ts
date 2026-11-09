import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSafetyAuditLogSnapshot } from './data-safety-audit-log';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import { buildDisasterBackupDataSafetySnapshot } from './disaster-backup-data-safety.helpers';
import { DisasterBackupService } from './disaster-backup.service';
type ReplayEntry = DataSafetyAuditLogSnapshot['replayLog'][number];
const VALID_RPC: ReplayEntry['rpc'] = {
  status: 'applied', reason: 'applied', decision: 'local-applied', operationId: 'op-export',
  changedFields: ['content'], quarantineId: null, auditId: null, originUnverified: false,
  payloadDigest: null, existingPayloadDigest: null, replayPayloadDigest: null,
  remoteUpdatedAt: '2026-06-16T00:00:00.000Z', serverUpdatedAt: '2026-06-16T00:00:01.000Z',
  minProtocolVersion: 1, entityId: 'task-1', stalePayload: false, affectedCount: 1,
  attachmentPaths: ['user-1/task-1/file.txt'], skippedIds: [], raw: null,
};
const VALID_CONFLICT: NonNullable<ReplayEntry['conflict']> = { status: 'conflict-detected', reason: 'remote-newer', localSnapshot: {}, remoteSnapshot: null };
const VALID_REPLAY_ENTRY: DataSafetyAuditLogSnapshot['replayLog'][number] = {
  operationId: 'op-export', entityType: 'task', entityId: 'task-1', operation: 'upsert',
  writeIntent: 'task_text_update', sourceUserId: 'user-1', localCommittedAt: 1781539200000,
  baseUpdatedAt: '2026-06-16T00:00:00.000Z',
  queue: { enteredRetryQueue: false, retryCount: 0, deadLettered: false }, rpc: VALID_RPC,
  lww: { decision: 'local-applied', reason: 'applied' },
  lastSyncTime: { before: null, after: '2026-06-16T00:00:01.000Z', advanced: true },
  conflict: VALID_CONFLICT,
};
const VALID_EXPLAIN: NonNullable<DataSafetyAuditLogSnapshot['lastWriteExplain']> = {
  operationId: 'op-export', actor: { sourceUserId: 'user-1' },
  entity: { type: 'task', id: 'task-1' }, operation: 'upsert', writeIntent: 'task_text_update',
  localTimestamp: 1781539200000, updatedAtBaseline: null, beforeVersion: null, afterVersion: null,
  queueResult: { enteredRetryQueue: false, retryCount: 0, deadLettered: false },
  rpcResult: VALID_RPC, lwwDecision: { decision: 'local-applied', reason: 'applied' },
  lastSyncTime: { before: null, after: '2026-06-16T00:00:01.000Z', advanced: true },
  conflict: VALID_CONFLICT,
};
function createSnapshot(operationId = 'op-export'): DataSafetyAuditLogSnapshot {
  return {
    replayLog: [{ ...VALID_REPLAY_ENTRY, operationId }],
    lastWriteExplain: { ...VALID_EXPLAIN, operationId },
  };
}
function setPath(root: object, path: PropertyKey[], value: unknown): void {
  const parent = path.slice(0, -1).reduce((current, key) => Reflect.get(current, key), root);
  Reflect.set(parent, path[path.length - 1], value);
}
function expectDurableRejection(raw: string): void {
  const key = 'nanoflow.data-safety-audit.user-1';
  localStorage.setItem(key, raw);
  expect(() => buildAuditSnapshot(new DataSafetyAuditPersistence({ maxEntries: 1 })))
    .toThrow(/audit/i);
  expect(localStorage.getItem(key)).toBe(raw);
}
function buildAuditSnapshot(persistence: DataSafetyAuditPersistence, ownerUserId = 'user-1') {
  return buildDisasterBackupDataSafetySnapshot({
    ownerUserId, retryQueue: [], actionQueue: [], deadLetters: [],
    dataSafetyAuditPersistence: persistence,
  });
}
function createStorage() {
  return {
    getItem: vi.fn((_key: string): string | null => null),
    setItem: vi.fn((_key: string, _value: string): void => undefined),
    removeItem: vi.fn((_key: string): void => undefined), clear: vi.fn((): void => undefined),
    key: vi.fn((_index: number): string | null => null), length: 0,
  } satisfies Storage;
}
describe('DataSafetyAuditPersistence', () => {
  beforeEach(() => localStorage.clear());
  it('persists and restores bounded replay log plus latest write explanation by owner', () => {
    const persistence = new DataSafetyAuditPersistence();
    persistence.save('user-1', createSnapshot('op-1'));
    const restored = persistence.load('user-1');
    expect(restored).toEqual(createSnapshot('op-1'));
    expect(persistence.load('user-2')).toEqual({ replayLog: [], lastWriteExplain: null });
    expect(buildAuditSnapshot(persistence)?.replayLog.map(entry => entry.operationId)).toEqual(['op-1']);
  });
  it('keeps missing optional replay and RPC fields compatible', () => {
    const snapshot = createSnapshot();
    Reflect.deleteProperty(snapshot.replayLog[0], 'sourceUserId');
    Reflect.deleteProperty(snapshot.replayLog[0].rpc, 'reason');
    localStorage.setItem('nanoflow.data-safety-audit.user-1', JSON.stringify(snapshot));
    expect(buildAuditSnapshot(new DataSafetyAuditPersistence())?.replayLog[0].sourceUserId).toBeUndefined();
  });
  it('returns an empty snapshot for malformed persisted data', () => {
    localStorage.setItem('nanoflow.data-safety-audit.user-1', '{bad-json');
    expect(new DataSafetyAuditPersistence().load('user-1')).toEqual({ replayLog: [], lastWriteExplain: null });
  });
  it('trims replay log on save to the configured maximum', () => {
    const persistence = new DataSafetyAuditPersistence({ maxEntries: 1 });
    const snapshot = createSnapshot();
    snapshot.replayLog = ['op-1', 'op-2'].map(operationId => ({ ...VALID_REPLAY_ENTRY, operationId }));
    persistence.save('user-1', snapshot);
    expect(persistence.load('user-1').replayLog.map(entry => entry.operationId)).toEqual(['op-2']);
  });
  it('keeps an in-memory owner snapshot when durable storage rejects the write', () => {
    const storage = createStorage();
    storage.setItem.mockImplementation(() => { throw new Error('quota exceeded'); });
    const persistence = new DataSafetyAuditPersistence({ storage });
    const snapshot = createSnapshot('op-memory-fallback');
    expect(persistence.save('user-memory-fallback', snapshot)).toBe(false);
    expect(persistence.load('user-memory-fallback')).toEqual(snapshot);
    expect(new DataSafetyAuditPersistence({ storage }).load('user-memory-fallback')).toEqual(snapshot);
  });
  it.each([
    ['empty', ''],
    ['invalid JSON', '{bad-json'],
    ['wrong root', '[]'],
    ['mixed replay rows', JSON.stringify({
      replayLog: [{ operationId: 'invalid' }, VALID_REPLAY_ENTRY], lastWriteExplain: null,
    })],
    ['invalid explanation', JSON.stringify({
      replayLog: [VALID_REPLAY_ENTRY], lastWriteExplain: { operationId: 'invalid' },
    })],
  ])('rejects %s durable audit evidence without changing its bytes', (_label, raw) => {
    expectDurableRejection(raw);
  });
  it.each([
    ['source owner', ['replayLog', 0, 'sourceUserId'], 7],
    ['base version', ['replayLog', 0, 'baseUpdatedAt'], 7],
    ['write intent', ['replayLog', 0, 'writeIntent'], 'invalid'],
    ['queue dead-letter status', ['replayLog', 0, 'queue', 'deadLettered'], 'yes'],
    ['conflict evidence', ['replayLog', 0, 'conflict'], { status: 'conflict-detected', reason: 'x' }],
    ['explanation actor', ['lastWriteExplain', 'actor', 'sourceUserId'], 7],
    ['explanation version', ['lastWriteExplain', 'beforeVersion'], 7],
    ['RPC string', ['replayLog', 0, 'rpc', 'reason'], 7],
    ['RPC nullable string', ['replayLog', 0, 'rpc', 'operationId'], 7],
    ['RPC string array', ['replayLog', 0, 'rpc', 'changedFields'], [7]],
    ['RPC boolean', ['replayLog', 0, 'rpc', 'originUnverified'], 'yes'],
    ['RPC number', ['replayLog', 0, 'rpc', 'minProtocolVersion'], 'one'],
    ['explanation RPC', ['lastWriteExplain', 'rpcResult', 'affectedCount'], 'one'],
    ['replay LWW decision', ['replayLog', 0, 'lww', 'decision'], 'corrupt'],
    ['explanation LWW decision', ['lastWriteExplain', 'lwwDecision', 'decision'], 'corrupt'],
  ])('rejects malformed optional %s evidence', (_label, path, value) => {
    const snapshot = structuredClone(createSnapshot());
    setPath(snapshot, path, value);
    expectDurableRejection(JSON.stringify(snapshot));
  });
  it('rejects unavailable or unreadable storage without repair writes', () => {
    const storage = createStorage();
    storage.getItem.mockImplementation(() => { throw new Error('storage denied'); });
    expect(() => buildAuditSnapshot(new DataSafetyAuditPersistence({ storage }))).toThrow(/storage denied/);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(() => buildAuditSnapshot(new DataSafetyAuditPersistence())).toThrow(/unavailable/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('validates exact-owner volatile evidence when the durable key is missing', () => {
    const ownerUserId = 'user-volatile';
    const storage = createStorage();
    storage.setItem.mockImplementation(() => { throw new Error('quota'); });
    const persistence = new DataSafetyAuditPersistence({ storage });
    expect(persistence.save(ownerUserId, createSnapshot())).toBe(false);
    vi.mocked(storage.setItem).mockClear();
    expect(buildAuditSnapshot(persistence, ownerUserId)?.replayLog.map(entry => entry.operationId))
      .toEqual(['op-export']);
    expect(storage.getItem).toHaveBeenCalledWith(`nanoflow.data-safety-audit.${ownerUserId}`);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    const volatileSnapshots = Reflect.get(DataSafetyAuditPersistence, 'volatileSnapshots');
    volatileSnapshots.set(`nanoflow.data-safety-audit.${ownerUserId}`, {
      replayLog: [{ operationId: 'invalid' }], lastWriteExplain: null,
    });
    try {
      expect(() => buildAuditSnapshot(persistence, ownerUserId)).toThrow(/audit/i);
    } finally {
      volatileSnapshots.delete(`nanoflow.data-safety-audit.${ownerUserId}`);
    }
  });
  it('rejects malformed durable evidence instead of falling back to valid volatile evidence', () => {
    let raw: string | null = null;
    const storage = createStorage();
    storage.getItem.mockImplementation(() => raw);
    storage.setItem.mockImplementation(() => { throw new Error('quota'); });
    const persistence = new DataSafetyAuditPersistence({ storage });
    expect(persistence.save('user-1', createSnapshot())).toBe(false);
    raw = '{bad-json';
    expect(() => buildAuditSnapshot(persistence)).toThrow(/audit/i);
  });
  it('fails buildLocalBlob before checksum digest or Blob construction', async () => {
    localStorage.setItem('nanoflow.data-safety-audit.user-1', '{bad-json');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const blobConstructor = vi.fn();
    vi.stubGlobal('Blob', blobConstructor);
    try {
      const context = {
        buildLocalPayload: DisasterBackupService.prototype.buildLocalPayload,
        resolveEffectiveUserId: () => 'user-1', externalSourceLinks: { ensureLoaded: vi.fn() },
        buildProjectPayload: () => ({ projects: [], tasks: [], connections: [] }),
        collectUserPreferences: async () => [], collectBlackBoxEntries: () => [],
        collectRemoteUserState: async () => ({
          focusSessions: [], transcriptionUsage: [], routineTasks: [], routineCompletions: [],
        }),
        localStateReader: { readLocalState: async () =>
          buildAuditSnapshot(new DataSafetyAuditPersistence()) },
        supabase: { isConfigured: false },
        shouldDeferLocalBackupWrite: () => false,
      };
      await expect(Reflect.apply(DisasterBackupService.prototype.buildLocalBlob, context,
        [[], { autoBackupEnabled: false, autoBackupIntervalMs: 900_000 }])).rejects.toThrow(/audit/i);
      expect(digest).not.toHaveBeenCalled();
      expect(blobConstructor).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
