import { Injector } from '@angular/core';
import { createStore, get, set } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import {
  AttachmentCleanupOutboxService,
  type AttachmentCleanupStorageClient,
} from './attachment-cleanup-outbox.service';

const cleanupStore = createStore(
  'nanoflow-attachment-cleanup-outbox',
  'pending-cleanups',
);
const legacyFallbackPrefix = 'nanoflow.attachment-cleanup-outbox.';

type ResetReason = 'owner-change' | 'clear-local-data';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createClient(
  remove: ReturnType<typeof vi.fn>,
): AttachmentCleanupStorageClient {
  return {
    storage: {
      from: vi.fn(() => ({ remove })),
    },
  } as unknown as AttachmentCleanupStorageClient;
}

function createServiceHarness() {
  let resetRuntime: ((reason: ResetReason) => void) | undefined;
  const injector = Injector.create({
    providers: [
      { provide: AttachmentCleanupOutboxService, useClass: AttachmentCleanupOutboxService },
      {
        provide: SessionRuntimeResetRegistry,
        useValue: {
          register: vi.fn((_owner: string, reset: (reason: ResetReason) => void) => {
            resetRuntime = reset;
            return vi.fn();
          }),
        },
      },
    ],
  });
  return {
    service: injector.get(AttachmentCleanupOutboxService),
    getResetRuntime: () => resetRuntime,
  };
}

describe('AttachmentCleanupOutboxService', () => {
  let service: AttachmentCleanupOutboxService;

  beforeEach(() => {
    localStorage.clear();
    service = createServiceHarness().service;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.clearPendingCleanupsForTests();
    localStorage.clear();
  });

  it('persists owner-scoped cleanup identities and restores only the requested owner', async () => {
    await service.enqueuePaths([
      'user-a/project-1/task-1/attachment-a.png',
      'user-a/project-1/task-1/attachment-a.png',
      '',
    ], {
      ownerUserId: 'user-a',
      operationId: 'cleanup-operation-a',
      createdAt: '2026-06-29T00:00:00.000Z',
    });
    await service.enqueuePaths([
      'user-b/project-1/task-1/attachment-b.png',
    ], {
      ownerUserId: 'user-b',
      operationId: 'cleanup-operation-b',
      createdAt: '2026-06-29T00:00:01.000Z',
    });

    const restoredService = createServiceHarness().service;

    expect(await restoredService.listPendingCleanups('user-a')).toEqual([
      expect.objectContaining({
        ownerUserId: 'user-a',
        path: 'user-a/project-1/task-1/attachment-a.png',
        operationId: 'cleanup-operation-a',
        attemptCount: 0,
      }),
    ]);
    expect(await restoredService.listPendingCleanups('user-b')).toEqual([
      expect.objectContaining({
        ownerUserId: 'user-b',
        path: 'user-b/project-1/task-1/attachment-b.png',
        operationId: 'cleanup-operation-b',
        attemptCount: 0,
      }),
    ]);
  });

  it('does not flush owner A records through owner B client', async () => {
    await service.enqueuePaths(['user-a/project/task/a.png'], {
      ownerUserId: 'user-a',
      operationId: 'operation-a',
    });
    await service.enqueuePaths(['user-b/project/task/b.png'], {
      ownerUserId: 'user-b',
      operationId: 'operation-b',
    });
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });

    const result = await service.flushPendingCleanups(createClient(remove), {
      ownerUserId: 'user-b',
    });

    expect(remove).toHaveBeenCalledWith(['user-b/project/task/b.png']);
    expect(result.deletedCount).toBe(1);
    expect(await service.listPendingCleanups('user-a')).toHaveLength(1);
    expect(await service.listPendingCleanups('user-b')).toEqual([]);
  });

  it('keeps single-flight isolated per owner', async () => {
    await service.enqueuePaths(['user-a/project/task/a.png'], {
      ownerUserId: 'user-a',
      operationId: 'operation-a',
    });
    await service.enqueuePaths(['user-b/project/task/b.png'], {
      ownerUserId: 'user-b',
      operationId: 'operation-b',
    });
    const ownerARemove = deferred<{ data: unknown[]; error: null }>();
    const ownerBRemove = deferred<{ data: unknown[]; error: null }>();
    const removeA = vi.fn(() => ownerARemove.promise);
    const removeB = vi.fn(() => ownerBRemove.promise);

    const flushA = service.flushPendingCleanups(createClient(removeA), {
      ownerUserId: 'user-a',
    });
    const flushB = service.flushPendingCleanups(createClient(removeB), {
      ownerUserId: 'user-b',
    });
    await vi.waitFor(() => {
      expect(removeA).toHaveBeenCalledOnce();
      expect(removeB).toHaveBeenCalledOnce();
    });

    ownerARemove.resolve({ data: [], error: null });
    ownerBRemove.resolve({ data: [], error: null });
    await Promise.all([flushA, flushB]);
  });

  it('fails closed and removes ownerless legacy and malformed records', async () => {
    const legacyPath = 'user-a/project/task/legacy.png';
    await set(legacyPath, {
      path: legacyPath,
      operationId: 'legacy-operation',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
      attemptCount: 0,
    }, cleanupStore);
    localStorage.setItem(`${legacyFallbackPrefix}${legacyPath}`, JSON.stringify({
      path: legacyPath,
      operationId: 'legacy-fallback-operation',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
      attemptCount: 0,
    }));
    localStorage.setItem(`${legacyFallbackPrefix}v2.malformed`, JSON.stringify({
      ownerUserId: 'user-a',
      path: 42,
    }));

    expect(await service.listPendingCleanups('user-a')).toEqual([]);
    expect(await get(legacyPath, cleanupStore)).toBeUndefined();
    expect(localStorage.getItem(`${legacyFallbackPrefix}${legacyPath}`)).toBeNull();
    expect(localStorage.getItem(`${legacyFallbackPrefix}v2.malformed`)).toBeNull();
  });

  it('rejects mismatched owner paths before persisting any cleanup record', async () => {
    await expect(service.enqueuePaths([
      'user-b/project/task/valid.png',
      'user-a/project/task/cross-owner.png',
    ], {
      ownerUserId: 'user-b',
      operationId: 'operation-mixed-owner',
    })).rejects.toThrow('Attachment cleanup path owner does not match ownerUserId');

    expect(await service.listPendingCleanups('user-a')).toEqual([]);
    expect(await service.listPendingCleanups('user-b')).toEqual([]);
  });

  it('does not remove a newer same-path operation when an older flush succeeds late', async () => {
    const path = 'user-a/project/task/attachment.png';
    await service.enqueuePaths([path], {
      ownerUserId: 'user-a',
      operationId: 'operation-old',
    });
    const pendingRemove = deferred<{ data: unknown[]; error: null }>();
    const remove = vi.fn(() => pendingRemove.promise);
    const flush = service.flushPendingCleanups(createClient(remove), {
      ownerUserId: 'user-a',
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

    await service.enqueuePaths([path], {
      ownerUserId: 'user-a',
      operationId: 'operation-new',
    });
    pendingRemove.resolve({ data: [], error: null });
    await flush;

    expect(await service.listPendingCleanups('user-a')).toEqual([
      expect.objectContaining({ operationId: 'operation-new', path }),
    ]);
  });

  it('does not overwrite a newer same-path operation when an older flush fails late', async () => {
    const path = 'user-a/project/task/attachment.png';
    await service.enqueuePaths([path], {
      ownerUserId: 'user-a',
      operationId: 'operation-old',
    });
    const pendingRemove = deferred<{ data: null; error: { message: string } }>();
    const remove = vi.fn(() => pendingRemove.promise);
    const flush = service.flushPendingCleanups(createClient(remove), {
      ownerUserId: 'user-a',
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

    await service.enqueuePaths([path], {
      ownerUserId: 'user-a',
      operationId: 'operation-new',
    });
    pendingRemove.resolve({ data: null, error: { message: 'storage timeout' } });
    await flush;

    expect(await service.listPendingCleanups('user-a')).toEqual([
      expect.objectContaining({
        operationId: 'operation-old',
        path,
        attemptCount: 1,
        lastError: 'storage timeout',
      }),
      expect.objectContaining({
        operationId: 'operation-new',
        path,
        attemptCount: 0,
      }),
    ]);
  });

  it('invalidates late flush completion after an owner reset', async () => {
    const harness = createServiceHarness();
    service = harness.service;
    const path = 'user-a/project/task/reset.png';
    await service.enqueuePaths([path], {
      ownerUserId: 'user-a',
      operationId: 'operation-reset',
    });
    const pendingRemove = deferred<{ data: unknown[]; error: null }>();
    const remove = vi.fn(() => pendingRemove.promise);
    const flush = service.flushPendingCleanups(createClient(remove), {
      ownerUserId: 'user-a',
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

    expect(harness.getResetRuntime()).toBeTypeOf('function');
    harness.getResetRuntime()?.('owner-change');
    pendingRemove.resolve({ data: [], error: null });
    await flush;

    expect(await service.listPendingCleanups('user-a')).toHaveLength(1);
  });

  it('invalidates late flush completion after dispose', async () => {
    const path = 'user-a/project/task/dispose.png';
    await service.enqueuePaths([path], {
      ownerUserId: 'user-a',
      operationId: 'operation-dispose',
    });
    const pendingRemove = deferred<{ data: unknown[]; error: null }>();
    const remove = vi.fn(() => pendingRemove.promise);
    const flush = service.flushPendingCleanups(createClient(remove), {
      ownerUserId: 'user-a',
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

    service.ngOnDestroy();
    pendingRemove.resolve({ data: [], error: null });
    await flush;

    expect(await service.listPendingCleanups('user-a')).toHaveLength(1);
  });

  it('records failures only for the captured owner and preserves retry metadata', async () => {
    await service.enqueuePaths(['user-a/project/task/a.png'], {
      ownerUserId: 'user-a',
      operationId: 'operation-a',
    });
    await service.enqueuePaths(['user-b/project/task/b.png'], {
      ownerUserId: 'user-b',
      operationId: 'operation-b',
    });
    const remove = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'storage timeout' },
    });

    const result = await service.flushPendingCleanups(createClient(remove), {
      ownerUserId: 'user-a',
    });

    expect(result).toEqual({
      ok: false,
      deletedCount: 0,
      remainingCount: 1,
      errors: ['storage timeout'],
    });
    expect(await service.listPendingCleanups('user-a')).toEqual([
      expect.objectContaining({ attemptCount: 1, lastError: 'storage timeout' }),
    ]);
    const ownerBPending = await service.listPendingCleanups('user-b');
    expect(ownerBPending).toEqual([expect.objectContaining({ attemptCount: 0 })]);
    expect(ownerBPending[0]).not.toHaveProperty('lastError');

    const removeB = vi.fn().mockResolvedValue({ data: [], error: null });
    await service.flushPendingCleanups(createClient(removeB), { ownerUserId: 'user-b' });
    expect(removeB).toHaveBeenCalledWith(['user-b/project/task/b.png']);
    expect(await service.listPendingCleanups('user-b')).toEqual([]);
  });
});
