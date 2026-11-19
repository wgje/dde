import { describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_SYNC_COMMAND_SCHEMA_VERSION,
  compareHybridLogicalClock,
  compareOfflineSyncCommandOrder,
  createHybridLogicalClock,
  observeHybridLogicalClock,
  createOfflineSyncCommand,
  createQuarantineRecord,
  parseOfflineSyncCommand,
  serializeOfflineSyncCommand,
} from './offline-sync-command-envelope';

describe('offline sync command envelope', () => {
  it('creates a versioned idempotent command with a monotonic HLC', () => {
    const command = createOfflineSyncCommand({
      ownerUserId: 'owner-1',
      installationId: 'installation-1',
      deviceId: 'device-1',
      entityType: 'task',
      entityId: 'task-1',
      command: 'task.update',
      intent: { fields: ['content'] },
      normalizedResultPatch: { content: 'offline edit' },
      baseVersion: 2,
      baseUpdatedAt: '2026-11-13T00:00:00.000Z',
      nowMs: 1_000,
      operationId: 'operation-1',
    });

    expect(command.schemaVersion).toBe(OFFLINE_SYNC_COMMAND_SCHEMA_VERSION);
    expect(command.idempotencyKey).toBe('operation-1');
    expect(command.logicalClock).toEqual({ physicalMs: 1_000, logical: 0 });
    expect(command.status).toBe('pending');

    const nextClock = createHybridLogicalClock(command.logicalClock, 1_000);
    expect(nextClock).toEqual({ physicalMs: 1_000, logical: 1 });
    expect(compareHybridLogicalClock(nextClock, command.logicalClock)).toBeGreaterThan(0);
  });

  it('observes remote HLC values without moving backwards', () => {
    expect(observeHybridLogicalClock(
      { physicalMs: 100, logical: 2 },
      { physicalMs: 100, logical: 5 },
      100,
    )).toEqual({ physicalMs: 100, logical: 6 });
    expect(observeHybridLogicalClock(
      { physicalMs: 100, logical: 2 },
      { physicalMs: 200, logical: 1 },
      150,
    )).toEqual({ physicalMs: 200, logical: 2 });
  });

  it('preserves explicit operation and idempotency identities', () => {
    const command = createOfflineSyncCommand({
      ownerUserId: 'owner-1',
      installationId: 'installation-1',
      deviceId: 'device-1',
      entityType: 'project',
      entityId: 'project-1',
      command: 'project.update',
      intent: {},
      normalizedResultPatch: { name: 'Project' },
      operationId: 'operation-1',
      idempotencyKey: 'idempotency-1',
      logicalClock: { physicalMs: 10, logical: 2 },
      createdAtIso: '2026-11-13T00:00:00.000Z',
    });

    expect(command.operationId).toBe('operation-1');
    expect(command.idempotencyKey).toBe('idempotency-1');
    expect(command.logicalClock).toEqual({ physicalMs: 10, logical: 2 });
  });

  it('orders commands deterministically after HLC equality', () => {
    const first = {
      logicalClock: { physicalMs: 10, logical: 1 },
      deviceId: 'device-a',
      operationId: 'operation-z',
    } as const;
    const second = {
      logicalClock: { physicalMs: 10, logical: 1 },
      deviceId: 'device-b',
      operationId: 'operation-a',
    } as const;

    expect(compareOfflineSyncCommandOrder(first, second)).toBeLessThan(0);
    expect(compareOfflineSyncCommandOrder(second, first)).toBeGreaterThan(0);
  });

  it('round-trips a valid command through JSON', () => {
    const command = createOfflineSyncCommand({
      ownerUserId: 'owner-1',
      installationId: 'installation-1',
      deviceId: 'device-1',
      entityType: 'connection',
      entityId: 'connection-1',
      projectId: 'project-1',
      command: 'connection.update',
      intent: { fields: ['targetId'] },
      normalizedResultPatch: { targetId: 'task-2' },
      dependencyOperationIds: ['operation-0'],
      nowMs: 2_000,
      operationId: 'operation-1',
    });
    const parsed = parseOfflineSyncCommand(serializeOfflineSyncCommand(command));

    expect(parsed).toEqual({ kind: 'valid', value: command });
  });

  it('quarantines malformed JSON without throwing', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'quarantine-1' });
    const parsed = parseOfflineSyncCommand('{not-json', {
      source: 'command-envelope',
      ownerUserId: 'owner-1',
      nowMs: 3_000,
    });

    expect(parsed.kind).toBe('quarantined');
    if (parsed.kind === 'quarantined') {
      expect(parsed.quarantine.reason).toBe('invalid-json');
      expect(parsed.quarantine.quarantineId).toBe('quarantine-1');
      expect(parsed.quarantine.raw).toBe('{not-json');
    }
  });

  it('quarantines a valid JSON value with an invalid envelope shape', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'quarantine-2' });
    const parsed = parseOfflineSyncCommand(JSON.stringify({ schemaVersion: 99 }), {
      source: 'legacy-queue',
      nowMs: 4_000,
    });

    expect(parsed.kind).toBe('quarantined');
    if (parsed.kind === 'quarantined') {
      expect(parsed.quarantine.reason).toBe('invalid-command-envelope');
      expect(parsed.quarantine.source).toBe('legacy-queue');
      expect(parsed.quarantine.capturedAtIso).toBe('1970-01-01T00:00:04.000Z');
    }
  });

  it('creates an exportable quarantine record with a stable timestamp', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'quarantine-3' });
    const record = createQuarantineRecord(
      { operationId: 'operation-1' },
      'unsupported-schema',
      { source: 'snapshot', ownerUserId: 'owner-1', nowMs: 5_000 },
    );

    expect(record).toEqual({
      schemaVersion: 1,
      quarantineId: 'quarantine-3',
      ownerUserId: 'owner-1',
      source: 'snapshot',
      reason: 'unsupported-schema',
      raw: { operationId: 'operation-1' },
      capturedAtIso: '1970-01-01T00:00:05.000Z',
    });
  });
});
