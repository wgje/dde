import { Injector, runInInjectionContext } from '@angular/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../models';
import type { SupabaseError } from '../utils/supabase-error';
import { LoggerService } from './logger.service';
import { ModalService } from './modal.service';
import {
  PermissionDeniedHandlerService,
  type RejectedDataStore,
} from './permission-denied-handler.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';

const DB_NAME = 'NanoFlow';
const STORE_NAME = 'rejectedData';

const loggerCategory = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};
const logger = { category: vi.fn(() => loggerCategory) };
const toastError = vi.fn();
const toastSuccess = vi.fn();
const toast = { error: toastError, success: toastSuccess };
const sentryLazyLoader = { captureMessage: vi.fn() };

describe('PermissionDeniedHandlerService owner isolation', () => {
  let service: PermissionDeniedHandlerService;
  let anchorClick: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rejected-data');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: logger },
        { provide: ModalService, useValue: {} },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
        { provide: ToastService, useValue: toast },
      ],
    });
    service = runInInjectionContext(injector, () => new PermissionDeniedHandlerService());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps rejected data in separate owner buckets and uses UUID record ids', async () => {
    const taskA = createTask('same-task', 'owner-a');
    const taskB = createTask('same-task', 'owner-b');

    await service.handlePermissionDenied(permissionDeniedError(), [taskA], 'project-1', context('owner-a'));
    await service.handlePermissionDenied(permissionDeniedError(), [taskB], 'project-1', context('owner-b'));

    const ownerA = await service.getAllRejectedData('owner-a');
    const ownerB = await service.getAllRejectedData('owner-b');
    expect(ownerA).toHaveLength(1);
    expect(ownerB).toHaveLength(1);
    expect(ownerA[0]?.ownerUserId).toBe('owner-a');
    expect(ownerB[0]?.ownerUserId).toBe('owner-b');
    expect(ownerA[0]?.id).toMatch(/^rejected-[0-9a-f-]{36}$/);
    expect(ownerB[0]?.id).toMatch(/^rejected-[0-9a-f-]{36}$/);
    expect(ownerA[0]?.id).not.toBe(ownerB[0]?.id);
  });

  it('clears only the requested owner and project', async () => {
    await service.handlePermissionDenied(permissionDeniedError(), [createTask('task-a', 'a')], 'project-1', context('owner-a'));
    await service.handlePermissionDenied(permissionDeniedError(), [createTask('task-b', 'b')], 'project-1', context('owner-b'));

    await expect(service.clearRejectedDataForProject('owner-a', 'project-1')).resolves.toBe(1);
    await expect(service.getAllRejectedData('owner-a')).resolves.toEqual([]);
    await expect(service.getAllRejectedData('owner-b')).resolves.toHaveLength(1);
  });

  it('exports the ownerless legacy main bucket separately', async () => {
    await putRaw('main', {
      records: [{
        id: 'legacy-record',
        type: 'task',
        projectId: 'legacy-project',
        data: createTask('legacy-task', 'legacy'),
        rejectedAt: new Date().toISOString(),
        reason: 'legacy',
        errorCode: '403',
        attemptCount: 1,
      }],
      totalSize: 1,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    });

    let exportedBlob: Blob | undefined;
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      exportedBlob = value as Blob;
      return 'blob:legacy';
    });
    await service.exportLegacyRejectedData();

    const exported = JSON.parse(await exportedBlob!.text()) as { ownerUserId: string | null; records: Array<{ ownerUserId?: string | null }> };
    expect(exported.ownerUserId).toBeNull();
    expect(exported.records[0]?.ownerUserId).toBeNull();
    expect(anchorClick).toHaveBeenCalledOnce();
  });

  it('does not notify a replacement session after durable owner-scoped persistence', async () => {
    await service.handlePermissionDenied(
      permissionDeniedError(),
      [createTask('task-silent', 'silent')],
      'project-1',
      context('owner-a', false),
    );

    expect(toastError).not.toHaveBeenCalled();
    await expect(service.getAllRejectedData('owner-a')).resolves.toHaveLength(1);
  });

  it('preserves the previous bucket when the read transaction fails', async () => {
    await service.handlePermissionDenied(permissionDeniedError(), [createTask('task-existing', 'existing')], 'project-1', context('owner-a'));
    const open = vi.spyOn(service as unknown as { openIndexedDB: () => Promise<IDBDatabase> }, 'openIndexedDB');
    open.mockRejectedValueOnce(new Error('temporary IndexedDB read failure'));

    await expect(service.handlePermissionDenied(
      permissionDeniedError(),
      [createTask('task-new', 'new')],
      'project-1',
      context('owner-a'),
    )).rejects.toThrow('Unable to isolate rejected data');
    expect(await service.getAllRejectedData('owner-a')).toHaveLength(1);
  });

  it('retains the previous bucket when a readwrite transaction aborts', async () => {
    await service.handlePermissionDenied(permissionDeniedError(), [createTask('task-existing', 'existing')], 'project-1', context('owner-a'));
    const mutate = (service as unknown as {
      mutateRejectedDataStore: (ownerUserId: string, updater: (store: RejectedDataStore) => RejectedDataStore) => Promise<RejectedDataStore>;
    }).mutateRejectedDataStore.bind(service);

    await expect(mutate('owner-a', () => {
      throw new Error('forced updater failure');
    })).rejects.toThrow('forced updater failure');
    expect(await service.getAllRejectedData('owner-a')).toHaveLength(1);
  });

  it('serializes concurrent owner writes without dropping records', async () => {
    await Promise.all([
      service.handlePermissionDenied(permissionDeniedError(), [createTask('task-1', 'one')], 'project-1', context('owner-a')),
      service.handlePermissionDenied(permissionDeniedError(), [createTask('task-2', 'two')], 'project-1', context('owner-a')),
    ]);

    const records = await service.getAllRejectedData('owner-a');
    expect(records.map(record => record.data.id).sort()).toEqual(['task-1', 'task-2']);
  });
});

function context(ownerUserId: string, notify = true) {
  return { ownerUserId, shouldNotify: () => notify };
}

function createTask(id: string, title: string): Task {
  return {
    id,
    title,
    content: `${title} content`,
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    displayId: '?',
  };
}

function permissionDeniedError(): SupabaseError {
  return Object.assign(new Error('permission denied'), { code: '403' }) as SupabaseError;
}

async function putRaw(key: string, value: RejectedDataStore): Promise<void> {
  const db = await openRawDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('raw transaction aborted'));
  });
  db.close();
}

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open NanoFlow'));
  });
}
