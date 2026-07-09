import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';

function buildDeterministicBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function findFirstByteMismatch(left: Uint8Array, right: Uint8Array): number {
  const limit = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.byteLength === right.byteLength ? -1 : limit;
}

describe('AttachmentUploadOutboxService', () => {
  let service: AttachmentUploadOutboxService;

  beforeEach(() => {
    service = Injector.create({
      providers: [
        { provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService },
      ],
    }).get(AttachmentUploadOutboxService);
  });

  afterEach(async () => {
    await service.clearPendingUploadsForTests();
  });

  it('persists and restores a pending attachment Blob by blobKey', async () => {
    const blob = new Blob(['offline attachment'], { type: 'text/plain' });

    await service.savePendingUpload({
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
    });

    const restored = await service.readPendingUpload('attachment-1');

    expect(restored).toEqual(expect.objectContaining({
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: blob.size,
    }));
    expect(await restored?.blob.text()).toBe('offline attachment');
  });

  it('removes a pending attachment Blob after upload succeeds', async () => {
    const blob = new Blob(['uploaded'], { type: 'text/plain' });
    await service.savePendingUpload({
      attachmentId: 'attachment-2',
      blobKey: 'attachment-2',
      fileName: 'done.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
    });

    await service.removePendingUpload('attachment-2');

    expect(await service.readPendingUpload('attachment-2')).toBeNull();
  });

  it('lists all pending attachment Blobs after a new service instance is created', async () => {
    await service.savePendingUpload({
      attachmentId: 'attachment-a',
      blobKey: 'attachment-a',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      blob: new Blob(['a'], { type: 'text/plain' }),
      createdAt: '2026-06-15T00:00:01.000Z',
    });
    await service.savePendingUpload({
      attachmentId: 'attachment-b',
      blobKey: 'attachment-b',
      fileName: 'b.txt',
      mimeType: 'text/plain',
      size: 1,
      blob: new Blob(['b'], { type: 'text/plain' }),
      createdAt: '2026-06-15T00:00:02.000Z',
    });

    const restoredService = Injector.create({
      providers: [
        { provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService },
      ],
    }).get(AttachmentUploadOutboxService);

    const pendingUploads = await restoredService.listPendingUploads();

    expect(pendingUploads.map(upload => upload.blobKey)).toEqual([
      'attachment-a',
      'attachment-b',
    ]);
    expect(await pendingUploads[0]?.blob.text()).toBe('a');
    expect(await pendingUploads[1]?.blob.text()).toBe('b');
  });

  it('persists recovery metadata for pending attachment uploads after service recreation', async () => {
    const blob = new Blob(['recoverable'], { type: 'text/plain' });
    const attachment = {
      id: 'attachment-recoverable',
      type: 'document' as const,
      name: 'recoverable.txt',
      url: 'nanoflow-local-attachment://attachment-recoverable',
      mimeType: 'text/plain',
      size: blob.size,
      createdAt: '2026-06-15T00:00:04.000Z',
    };
    const recovery = {
      operationId: 'attachment:create:attachment-recoverable',
      payload: {
        attachment,
        blobKey: 'attachment-recoverable',
        fileName: 'recoverable.txt',
        mimeType: 'text/plain',
        projectId: 'project-1',
        taskId: 'task-1',
        userId: 'user-1',
        sourceUserId: 'user-1',
      },
    };

    await service.savePendingUpload({
      attachmentId: 'attachment-recoverable',
      blobKey: 'attachment-recoverable',
      fileName: 'recoverable.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
      createdAt: '2026-06-15T00:00:04.000Z',
      recovery,
    } as Parameters<AttachmentUploadOutboxService['savePendingUpload']>[0] & { recovery: typeof recovery });

    const restoredService = Injector.create({
      providers: [
        { provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService },
      ],
    }).get(AttachmentUploadOutboxService);
    const restored = await restoredService.readPendingUpload('attachment-recoverable');
    const listed = await restoredService.listPendingUploads();

    expect((restored as typeof restored & { recovery?: typeof recovery })?.recovery).toEqual(recovery);
    expect((listed[0] as typeof listed[number] & { recovery?: typeof recovery })?.recovery).toEqual(recovery);
  });

  it('restores a large pending attachment with byte-for-byte integrity after service recreation', async () => {
    const bytes = buildDeterministicBytes(1024 * 1024);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });

    await service.savePendingUpload({
      attachmentId: 'attachment-large',
      blobKey: 'attachment-large',
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
      blob,
      createdAt: '2026-06-15T00:00:03.000Z',
    });

    const restoredService = Injector.create({
      providers: [
        { provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService },
      ],
    }).get(AttachmentUploadOutboxService);
    const restored = await restoredService.readPendingUpload('attachment-large');

    expect(restored).toEqual(expect.objectContaining({
      attachmentId: 'attachment-large',
      blobKey: 'attachment-large',
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
      createdAt: '2026-06-15T00:00:03.000Z',
    }));
    expect(restored?.blob.size).toBe(bytes.byteLength);
    expect(restored?.blob.type).toBe('application/octet-stream');
    const restoredBytes = await readBlobBytes(restored?.blob ?? new Blob());
    expect(restoredBytes.byteLength).toBe(bytes.byteLength);
    expect(findFirstByteMismatch(restoredBytes, bytes)).toBe(-1);
  });
});
