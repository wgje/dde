import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({
  clear: vi.fn().mockResolvedValue(undefined),
  createStore: vi.fn(() => ({})),
  del: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  values: vi.fn().mockResolvedValue([]),
}));

describe('AttachmentUploadOutboxService fallback storage', () => {
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

    const restored = await restoredService.readPendingUpload('attachment-fallback');

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

  it('clears a stale fallback record after IndexedDB save succeeds for the same blobKey', async () => {
    const service = Injector.create({
      providers: [
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
    mockSet.mockRejectedValueOnce(new Error('idb unavailable'));

    await service.savePendingUpload({
      attachmentId: 'attachment-replaced',
      blobKey: 'attachment-replaced',
      fileName: 'old.txt',
      mimeType: 'text/plain',
      size: 3,
      blob: new Blob(['old'], { type: 'text/plain' }),
      createdAt: '2026-06-15T01:00:00.000Z',
    });

    await service.savePendingUpload({
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

    await expect(restoredService.readPendingUpload('attachment-replaced')).resolves.toBeNull();
  });
});
