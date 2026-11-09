import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({
  clear: vi.fn().mockResolvedValue(undefined),
  createStore: vi.fn(() => ({})),
  del: vi.fn().mockResolvedValue(undefined),
  entries: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
}));

function ensureNativeOutboxStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = (version?: number) => {
      const request = version === undefined
        ? indexedDB.open('nanoflow-attachment-upload-outbox')
        : indexedDB.open('nanoflow-attachment-upload-outbox', version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('pending-uploads')) {
          request.result.createObjectStore('pending-uploads');
        }
      };
      request.onerror = () => reject(request.error ?? new Error('failed to open outbox DB'));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pending-uploads')) {
          const nextVersion = db.version + 1;
          db.close();
          open(nextVersion);
          return;
        }
        db.close();
        resolve();
      };
    };
    open();
  });
}

describe('AttachmentUploadOutboxService fallback storage', () => {
  const ownerUserId = 'user-1';
  let serviceClass: typeof import('./attachment-upload-outbox.service').AttachmentUploadOutboxService;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockSet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();

    const idbKeyval = await import('idb-keyval');
    const module = await import('./attachment-upload-outbox.service');
    serviceClass = module.AttachmentUploadOutboxService;
    mockGet = vi.mocked(idbKeyval.get);
    mockSet = vi.mocked(idbKeyval.set);
    mockGet.mockReset();
    mockSet.mockReset();
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue(undefined);
  });

  it('falls back to localStorage when IndexedDB save fails and restores the pending Blob', async () => {
    const service = Injector.create({
      providers: [
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
    const blob = new Blob(['fallback attachment'], { type: 'text/plain' });
    mockSet.mockRejectedValueOnce(new Error('idb unavailable'));

    await expect(service.savePendingUpload({
      ownerUserId,
      operationId: 'attachment:create:attachment-fallback',
      attachmentId: 'attachment-fallback',
      blobKey: 'attachment-fallback',
      fileName: 'fallback.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
      createdAt: '2026-06-15T01:00:00.000Z',
    })).resolves.toBeUndefined();

    const restoredService = Injector.create({
      providers: [
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
    mockGet.mockRejectedValueOnce(new Error('idb still unavailable'));

    const restored = await restoredService.readPendingUpload({
      ownerUserId,
      operationId: 'attachment:create:attachment-fallback',
      blobKey: 'attachment-fallback',
    });

    expect(restored).toEqual(expect.objectContaining({
      attachmentId: 'attachment-fallback',
      blobKey: 'attachment-fallback',
      fileName: 'fallback.txt',
      mimeType: 'text/plain',
      size: blob.size,
      createdAt: '2026-06-15T01:00:00.000Z',
    }));
    expect(await restored?.blob.text()).toBe('fallback attachment');
  });

  it('keeps fallback uploads isolated by owner for list and read operations', async () => {
    const service = Injector.create({
      providers: [
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
    const blob = new Blob(['owner-a fallback'], { type: 'text/plain' });
    mockSet.mockRejectedValueOnce(new Error('idb unavailable'));
    await service.savePendingUpload({
      ownerUserId: 'owner-a',
      operationId: 'operation-a',
      attachmentId: 'shared-attachment',
      blobKey: 'shared-blob',
      fileName: 'owner-a.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
    });

    await expect(service.listPendingUploads('owner-b')).resolves.toEqual([]);
    await expect(service.readPendingUpload({
      ownerUserId: 'owner-b',
      operationId: 'operation-a',
      blobKey: 'shared-blob',
    })).resolves.toBeNull();
    await expect(service.listPendingUploads('owner-a')).resolves.toHaveLength(1);
  });

  it('clears a stale fallback record after IndexedDB save succeeds for the same blobKey', async () => {
    const service = Injector.create({
      providers: [
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
    mockSet.mockRejectedValueOnce(new Error('idb unavailable'));

    await service.savePendingUpload({
      ownerUserId,
      operationId: 'attachment:create:attachment-replaced',
      attachmentId: 'attachment-replaced',
      blobKey: 'attachment-replaced',
      fileName: 'old.txt',
      mimeType: 'text/plain',
      size: 3,
      blob: new Blob(['old'], { type: 'text/plain' }),
      createdAt: '2026-06-15T01:00:00.000Z',
    });

    await service.savePendingUpload({
      ownerUserId,
      operationId: 'attachment:create:attachment-replaced',
      attachmentId: 'attachment-replaced',
      blobKey: 'attachment-replaced',
      fileName: 'new.txt',
      mimeType: 'text/plain',
      size: 3,
      blob: new Blob(['new'], { type: 'text/plain' }),
      createdAt: '2026-06-15T01:01:00.000Z',
    });

    const restoredService = Injector.create({
      providers: [
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
    mockGet.mockRejectedValueOnce(new Error('idb temporarily unavailable'));

    await expect(restoredService.readPendingUpload({
      ownerUserId,
      operationId: 'attachment:create:attachment-replaced',
      blobKey: 'attachment-replaced',
    })).resolves.toBeNull();
  });

  it('does not remove a fallback successor when the complete staged record changed', async () => {
    await ensureNativeOutboxStore();
    const service = Injector.create({
      providers: [
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
    const identity = {
      ownerUserId,
      operationId: 'attachment:create:attachment-successor',
      blobKey: 'attachment-successor',
    };
    mockSet.mockRejectedValue(new Error('idb unavailable during staged writes'));
    await service.savePendingUpload({
      ...identity,
      attachmentId: 'attachment-successor',
      fileName: 'old.txt',
      mimeType: 'text/plain',
      size: 3,
      blob: new Blob(['old'], { type: 'text/plain' }),
      createdAt: '2026-06-15T01:00:00.000Z',
      recovery: {
        operationId: identity.operationId,
        payload: {
          attachment: {
            id: 'attachment-successor',
            type: 'document',
            name: 'old.txt',
            url: 'nanoflow-local-attachment://attachment-successor',
            createdAt: '2026-06-15T01:00:00.000Z',
          },
          blobKey: identity.blobKey,
          fileName: 'old.txt',
          mimeType: 'text/plain',
          projectId: 'project-1',
          taskId: 'task-1',
          userId: ownerUserId,
          sourceUserId: ownerUserId,
        },
      },
    });
    mockGet.mockRejectedValueOnce(new Error('read fallback predecessor'));
    const predecessor = await service.readPendingUpload(identity);
    if (!predecessor) throw new Error('expected fallback predecessor');
    if (!predecessor.recovery) throw new Error('expected fallback recovery metadata');

    await service.savePendingUpload({
      ...predecessor,
      fileName: 'new.txt',
      size: 9,
      blob: new Blob(['successor'], { type: 'text/plain' }),
      createdAt: '2026-06-15T01:01:00.000Z',
      recovery: {
        operationId: identity.operationId,
        payload: {
          ...predecessor.recovery.payload,
          fileName: 'new.txt',
        },
      },
    });

    const removed = await service.removePendingUploadIfCurrent(predecessor, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    mockGet.mockRejectedValueOnce(new Error('read fallback successor'));
    const successor = await service.readPendingUpload(identity);

    expect(removed).toEqual({ status: 'mismatch' });
    expect(successor).toEqual(expect.objectContaining({
      fileName: 'new.txt',
      size: 9,
      createdAt: '2026-06-15T01:01:00.000Z',
    }));
    expect(await successor?.blob.text()).toBe('successor');
    expect(successor?.recovery?.payload.fileName).toBe('new.txt');
  });
});
