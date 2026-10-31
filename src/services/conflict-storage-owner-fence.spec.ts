import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../models';
import { AuthService } from './auth.service';
import {
  ConflictStorageService,
  createProjectConflictRecordFingerprint,
  type ConflictRecord,
  type StoredConflictRecord,
  toStoredConflictRecord,
} from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { LocalBackupUiRestoreWriterQuiescenceService } from './local-backup-ui-restore-writer-quiescence.service';
import { LocalBackupUiRestoreWriterPausedError } from './local-backup-ui-restore-writer-quiescence-tracker';

type ControlledTransaction = {
  abort(): void;
  complete(): void;
};

function createProject(id: string): Project {
  return {
    id,
    name: 'Resolved project',
    description: '',
    createdDate: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    version: 4,
    tasks: [],
    connections: [],
  };
}

function createConflict(overrides: Partial<ConflictRecord> = {}): StoredConflictRecord {
  const projectId = overrides.projectId ?? 'project-a';
  return toStoredConflictRecord({
    projectId,
    ownerUserId: 'owner-a',
    localProject: createProject(projectId),
    conflictedAt: '2026-07-29T00:01:00.000Z',
    localVersion: 4,
    reason: 'version_mismatch',
    localHandoff: {
      kind: 'resolved-project-conflict',
      state: 'required',
      ownerUserId: 'owner-a',
      projectId,
      actionId: 'action-a',
      operationId: 'operation-a',
      payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a',
    },
    ...overrides,
  });
}

function createRequest<T>(): IDBRequest<T> {
  return {} as IDBRequest<T>;
}

function createControlledDb(initialRecord: StoredConflictRecord): {
  db: IDBDatabase;
  records: Map<string, StoredConflictRecord>;
  transactions: ControlledTransaction[];
  put: ReturnType<typeof vi.fn>;
  deleteRecord: ReturnType<typeof vi.fn>;
} {
  const records = new Map([[initialRecord.scopedId, initialRecord]]);
  const transactions: ControlledTransaction[] = [];
  const put = vi.fn();
  const deleteRecord = vi.fn();

  const db = {
    transaction: () => {
      const transaction: Partial<IDBTransaction> = {};
      let pendingRecord: StoredConflictRecord | undefined;
      let pendingDelete: string | undefined;
      const store = {
        get: (scopedId: string) => {
          const request = createRequest<StoredConflictRecord | undefined>();
          queueMicrotask(() => {
            (request as { result: StoredConflictRecord | undefined }).result = records.get(scopedId);
            request.onsuccess?.call(request, { target: request } as unknown as Event);
          });
          return request;
        },
        put: (record: StoredConflictRecord) => {
          put(record);
          pendingRecord = structuredClone(record);
          const request = createRequest<IDBValidKey>();
          queueMicrotask(() => {
            (request as { result: IDBValidKey }).result = record.scopedId;
            request.onsuccess?.call(request, { target: request } as unknown as Event);
          });
          return request;
        },
        delete: (scopedId: string) => {
          deleteRecord(scopedId);
          pendingDelete = scopedId;
          const request = createRequest<undefined>();
          queueMicrotask(() => request.onsuccess?.call(request, { target: request } as unknown as Event));
          return request;
        },
      };
      transaction.objectStore = () => store as unknown as IDBObjectStore;
      transactions.push({
        abort: () => transaction.onabort?.call(transaction as IDBTransaction, { target: transaction } as Event),
        complete: () => {
          if (pendingRecord) {
            records.set(pendingRecord.scopedId, pendingRecord);
          }
          if (pendingDelete) records.delete(pendingDelete);
          transaction.oncomplete?.call(transaction as IDBTransaction, { target: transaction } as Event);
        },
      });
      return transaction as IDBTransaction;
    },
  } as unknown as IDBDatabase;

  return { db, records, transactions, put, deleteRecord };
}

async function flushRequests(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConflictStorageService durable local handoff reservation', () => {
  let service: ConflictStorageService;

  beforeEach(() => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const injector = Injector.create({
      providers: [
        { provide: ConflictStorageService, useClass: ConflictStorageService },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: AuthService, useValue: { currentUserId: () => 'owner-a' } },
      ],
    });
    service = runInInjectionContext(injector, () => injector.get(ConflictStorageService));
  });

  afterEach(async () => {
    await service.closeStorageConnections();
  });

  it('blocks conflict writes while a local backup restore owns the writer fence', async () => {
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await quiescence.prepare('owner-a');

    try {
      await expect(service.saveConflict(createConflict()))
        .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    } finally {
      await handle.abortBeforeMutation();
    }
  });

  it('attaches required handoff only after matching conflict CAS commits', async () => {
    const conflict = createConflict({ localHandoff: undefined });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);
    let settled = false;

    const requirement = service.persistProjectConflictLocalHandoffRequirement({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: createProjectConflictRecordFingerprint(conflict),
      conflictRecord: conflict,
    }).then(result => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(controlled.put).toHaveBeenCalledOnce());

    expect(settled).toBe(false);
    controlled.transactions.at(-1)?.complete();

    await expect(requirement).resolves.toEqual({ status: 'committed' });
    expect(controlled.records.get('owner-a::project-a')?.localHandoff).toEqual(expect.objectContaining({
      state: 'required', actionId: 'action-a', operationId: 'operation-a',
    }));
  });

  it('commits a matching supplied handoff when the conflict record is absent', async () => {
    const fingerprint = createProjectConflictRecordFingerprint(createConflict({ localHandoff: undefined }));
    const conflict = createConflict({
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'owner-a',
        projectId: 'project-a', actionId: 'action-a', operationId: 'operation-a',
        payloadDigest: 'payload-a', conflictFingerprint: fingerprint,
      },
    });
    const controlled = createControlledDb(conflict);
    controlled.records.clear();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);
    let settled = false;

    const requirement = service.persistProjectConflictLocalHandoffRequirement({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: fingerprint,
      conflictRecord: conflict,
    }).then(result => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(controlled.put).toHaveBeenCalledOnce());

    expect(settled).toBe(false);
    expect(controlled.records.has('owner-a::project-a')).toBe(false);
    controlled.transactions.at(-1)?.complete();

    await expect(requirement).resolves.toEqual({ status: 'committed' });
    expect(controlled.records.get('owner-a::project-a')?.localHandoff?.actionId).toBe('action-a');
  });

  it('rejects changed conflict content before attaching or publishing handoff evidence', async () => {
    const expectedConflict = createConflict({ localHandoff: undefined });
    const currentConflict = createConflict({ localHandoff: undefined, localVersion: 5 });
    const controlled = createControlledDb(currentConflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const requirement = service.persistProjectConflictLocalHandoffRequirement({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: createProjectConflictRecordFingerprint(expectedConflict),
      conflictRecord: expectedConflict,
    });
    await flushRequests();
    controlled.transactions.at(-1)?.complete();

    await expect(requirement).resolves.toEqual({ status: 'identity-mismatch' });
    expect(controlled.put).not.toHaveBeenCalled();
    expect(controlled.records.get('owner-a::project-a')?.localHandoff).toBeUndefined();
  });

  it('acknowledges a reservation only after the IndexedDB transaction commits', async () => {
    const controlled = createControlledDb(createConflict());
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    let settled = false;
    const reservation = service.reserveProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-a',
      reservedAt: '2026-07-29T00:02:00.000Z',
    }).then(result => {
      settled = true;
      return result;
    });

    await flushRequests();
    expect(controlled.put).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    controlled.transactions.at(-1)?.complete();

    await expect(reservation).resolves.toEqual(expect.objectContaining({
      status: 'committed',
      reservationId: 'reservation-a',
    }));
    expect(controlled.records.get('owner-a::project-a')?.localHandoff?.state).toBe('reserved');
  });

  it('fails closed when the reservation transaction aborts after put success', async () => {
    const controlled = createControlledDb(createConflict());
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const reservation = service.reserveProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-a',
      reservedAt: '2026-07-29T00:02:00.000Z',
    });
    await flushRequests();
    controlled.transactions.at(-1)?.abort();

    await expect(reservation).resolves.toEqual({ status: 'storage-failed' });
    expect(controlled.records.get('owner-a::project-a')?.localHandoff?.state).toBe('required');
  });

  it('rejects a competing identity without changing the durable conflict', async () => {
    const controlled = createControlledDb(createConflict());
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const reservation = service.reserveProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-b',
      operationId: 'operation-b', payloadDigest: 'payload-b',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-b',
      reservedAt: '2026-07-29T00:02:00.000Z',
    });
    await flushRequests();
    controlled.transactions.at(-1)?.complete();

    await expect(reservation).resolves.toEqual({ status: 'contended' });
    expect(controlled.put).not.toHaveBeenCalled();
    expect(controlled.records.get('owner-a::project-a')?.localHandoff?.state).toBe('required');
  });

  it('resumes a matching reservation with its persisted token', async () => {
    const conflict = createConflict({
      localHandoff: {
        ...createConflict().localHandoff!,
        state: 'reserved',
        reservationId: 'persisted-reservation',
        reservedAt: '2026-07-29T00:02:00.000Z',
      },
    });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const reservation = service.reserveProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'new-attempt-token',
      reservedAt: '2026-07-29T00:03:00.000Z',
    });
    await flushRequests();
    controlled.transactions.at(-1)?.complete();

    await expect(reservation).resolves.toEqual(expect.objectContaining({
      status: 'committed',
      reservationId: 'persisted-reservation',
    }));
    expect(controlled.put).not.toHaveBeenCalled();
  });

  it('revalidates the exact durable reservation before public effects', async () => {
    const conflict = createConflict({
      localHandoff: {
        ...createConflict().localHandoff!, state: 'reserved',
        reservationId: 'reservation-a', reservedAt: '2026-07-29T00:02:00.000Z',
      },
    });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const verification = service.verifyProjectConflictLocalHandoffReservation({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-a',
    });
    await flushRequests();
    controlled.transactions.at(-1)?.complete();

    await expect(verification).resolves.toEqual({ status: 'committed' });
    expect(controlled.put).not.toHaveBeenCalled();
  });

  it('rejects a stale reservation token without writing', async () => {
    const conflict = createConflict({
      localHandoff: {
        ...createConflict().localHandoff!, state: 'reserved',
        reservationId: 'reservation-a', reservedAt: '2026-07-29T00:02:00.000Z',
      },
    });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const verification = service.verifyProjectConflictLocalHandoffReservation({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'stale-token',
    });
    await flushRequests();
    controlled.transactions.at(-1)?.complete();

    await expect(verification).resolves.toEqual({ status: 'contended' });
    expect(controlled.put).not.toHaveBeenCalled();
  });

  it('advances reserved evidence only when the CAS transaction commits', async () => {
    const conflict = createConflict({
      localHandoff: {
        ...createConflict().localHandoff!, state: 'reserved',
        reservationId: 'reservation-a', reservedAt: '2026-07-29T00:02:00.000Z',
      },
    });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    let settled = false;
    const advancement = service.advanceProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-a',
      expectedState: 'reserved', nextState: 'effects-applied',
      transitionedAt: '2026-07-29T00:04:00.000Z',
    }).then(result => {
      settled = true;
      return result;
    });
    await flushRequests();

    expect(controlled.put).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    controlled.transactions.at(-1)?.complete();

    await expect(advancement).resolves.toEqual({ status: 'committed' });
    expect(controlled.records.get('owner-a::project-a')?.localHandoff?.state).toBe('effects-applied');
  });

  it('accepts an already-reached conflict phase without rewriting it', async () => {
    const conflict = createConflict({
      localHandoff: {
        ...createConflict().localHandoff!, state: 'effects-applied',
        reservationId: 'reservation-a', reservedAt: '2026-07-29T00:02:00.000Z',
        effectsAppliedAt: '2026-07-29T00:04:00.000Z',
      },
    });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const advancement = service.advanceProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-a',
      expectedState: 'reserved', nextState: 'effects-applied',
      transitionedAt: '2026-07-29T00:05:00.000Z',
    });
    await flushRequests();
    controlled.transactions.at(-1)?.complete();

    await expect(advancement).resolves.toEqual({ status: 'committed' });
    expect(controlled.put).not.toHaveBeenCalled();
  });

  it('deletes completed matching conflict evidence only after transaction commit', async () => {
    const conflict = createConflict({
      localHandoff: {
        ...createConflict().localHandoff!, state: 'complete',
        reservationId: 'reservation-a', completedAt: '2026-07-29T00:06:00.000Z',
      },
    });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    let settled = false;
    const deletion = service.deleteCompletedProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-a',
    }).then(result => {
      settled = true;
      return result;
    });
    await flushRequests();

    expect(controlled.deleteRecord).toHaveBeenCalledWith('owner-a::project-a');
    expect(settled).toBe(false);
    controlled.transactions.at(-1)?.complete();

    await expect(deletion).resolves.toEqual({ status: 'committed' });
    expect(controlled.records.has('owner-a::project-a')).toBe(false);
  });

  it('does not delete conflict evidence before handoff completion', async () => {
    const conflict = createConflict({
      localHandoff: {
        ...createConflict().localHandoff!, state: 'effects-applied',
        reservationId: 'reservation-a', effectsAppliedAt: '2026-07-29T00:05:00.000Z',
      },
    });
    const controlled = createControlledDb(conflict);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(controlled.db);

    const deletion = service.deleteCompletedProjectConflictLocalHandoff({
      ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
      operationId: 'operation-a', payloadDigest: 'payload-a',
      conflictFingerprint: 'fingerprint-a', reservationId: 'reservation-a',
    });
    await flushRequests();
    controlled.transactions.at(-1)?.complete();

    await expect(deletion).resolves.toEqual({ status: 'state-mismatch' });
    expect(controlled.deleteRecord).not.toHaveBeenCalled();
    expect(controlled.records.has('owner-a::project-a')).toBe(true);
  });
});
