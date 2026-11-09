import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { LocalBackupUiRestoreWriterQuiescenceService } from './local-backup-ui-restore-writer-quiescence.service';
import { LocalBackupUiRestoreWriterPausedError } from './local-backup-ui-restore-writer-quiescence-tracker';

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
  const ownerUserId = 'user-1';
  let service: AttachmentUploadOutboxService;

  const identity = (blobKey: string, operationId = `attachment:create:${blobKey}`) => ({
    ownerUserId,
    blobKey,
    operationId,
  });

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
      ...identity('attachment-1'),
      attachmentId: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
    });

    const restored = await service.readPendingUpload(identity('attachment-1'));

    expect(restored).toEqual(expect.objectContaining({
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: blob.size,
    }));
    expect(await restored?.blob.text()).toBe('offline attachment');
  });

  it('does not expose owner A pending uploads to owner B list or reads', async () => {
    const blob = new Blob(['owner-a'], { type: 'text/plain' });
    await service.savePendingUpload({
      ownerUserId: 'owner-a',
      operationId: 'operation-a',
      attachmentId: 'shared-attachment',
      blobKey: 'shared-blob',
      fileName: 'owner-a.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
    } as Parameters<AttachmentUploadOutboxService['savePendingUpload']>[0] & {
      ownerUserId: string;
      operationId: string;
    });

    const listForOwner = service.listPendingUploads as unknown as (
      ownerUserId: string,
    ) => ReturnType<AttachmentUploadOutboxService['listPendingUploads']>;
    const readForOperation = service.readPendingUpload as unknown as (
      key: { ownerUserId: string; blobKey: string; operationId: string },
    ) => ReturnType<AttachmentUploadOutboxService['readPendingUpload']>;

    await expect(listForOwner.call(service, 'owner-b')).resolves.toEqual([]);
    await expect(readForOperation.call(service, {
      ownerUserId: 'owner-b',
      blobKey: 'shared-blob',
      operationId: 'operation-a',
    })).resolves.toBeNull();
    await expect(listForOwner.call(service, 'owner-a')).resolves.toHaveLength(1);
  });

  it('fails closed and clears a legacy fallback record without owner metadata', async () => {
    localStorage.setItem('nanoflow.attachment-upload-outbox.legacy-blob', JSON.stringify({
      attachmentId: 'legacy-attachment',
      blobKey: 'legacy-blob',
      fileName: 'legacy.txt',
      mimeType: 'text/plain',
      size: 6,
      createdAt: '2026-06-15T00:00:00.000Z',
      blobBase64: 'bGVnYWN5',
    }));
    const listForOwner = service.listPendingUploads as unknown as (
      ownerUserId: string,
    ) => ReturnType<AttachmentUploadOutboxService['listPendingUploads']>;

    await expect(listForOwner.call(service, 'owner-b')).resolves.toEqual([]);
    expect(localStorage.getItem('nanoflow.attachment-upload-outbox.legacy-blob')).toBeNull();
  });

  it('keeps legacy attachment data untouched while capturing a restore pre-image', async () => {
    const key = 'nanoflow.attachment-upload-outbox.legacy-blob';
    localStorage.setItem(key, JSON.stringify({
      attachmentId: 'legacy-attachment',
      blobKey: 'legacy-blob',
      fileName: 'legacy.txt',
      mimeType: 'text/plain',
      size: 6,
      createdAt: '2026-06-15T00:00:00.000Z',
      blobBase64: 'bGVnYWN5',
    }));

    await expect(service.listPendingUploads(ownerUserId, { restoreSnapshot: true })).resolves.toEqual([]);
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('blocks ordinary attachment writes while a restore owns the writer fence', async () => {
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await quiescence.prepare(ownerUserId);

    try {
      await expect(service.savePendingUpload({
        ...identity('blocked-attachment'),
        attachmentId: 'blocked-attachment',
        fileName: 'blocked.txt',
        mimeType: 'text/plain',
        size: 0,
        blob: new Blob(),
      })).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
      await expect(service.listPendingUploads(ownerUserId, { restoreSnapshot: true })).resolves.toEqual([]);
    } finally {
      await handle.abortBeforeMutation();
    }
  });

  it('removes a pending attachment Blob after upload succeeds', async () => {
    const blob = new Blob(['uploaded'], { type: 'text/plain' });
    await service.savePendingUpload({
      ...identity('attachment-2'),
      attachmentId: 'attachment-2',
      fileName: 'done.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
    });

    await service.removePendingUpload(identity('attachment-2'));

    expect(await service.readPendingUpload(identity('attachment-2'))).toBeNull();
  });

  it('does not let an old operation remove a newer record with the same owner and blobKey', async () => {
    const save = async (operationId: string, contents: string) => {
      const blob = new Blob([contents], { type: 'text/plain' });
      await service.savePendingUpload({
        ownerUserId: 'owner-a',
        operationId,
        attachmentId: 'shared-attachment',
        blobKey: 'shared-blob',
        fileName: `${operationId}.txt`,
        mimeType: 'text/plain',
        size: blob.size,
        blob,
      } as Parameters<AttachmentUploadOutboxService['savePendingUpload']>[0] & {
        ownerUserId: string;
        operationId: string;
      });
    };
    const removeForOperation = service.removePendingUpload as unknown as (
      key: { ownerUserId: string; blobKey: string; operationId: string },
    ) => ReturnType<AttachmentUploadOutboxService['removePendingUpload']>;
    const readForOperation = service.readPendingUpload as unknown as (
      key: { ownerUserId: string; blobKey: string; operationId: string },
    ) => ReturnType<AttachmentUploadOutboxService['readPendingUpload']>;

    await save('operation-old', 'old');
    await save('operation-new', 'new');
    await removeForOperation.call(service, {
      ownerUserId: 'owner-a',
      blobKey: 'shared-blob',
      operationId: 'operation-old',
    });

    const newer = await readForOperation.call(service, {
      ownerUserId: 'owner-a',
      blobKey: 'shared-blob',
      operationId: 'operation-new',
    });
    expect(await newer?.blob.text()).toBe('new');
  });

  it('guarded removal deletes only the complete immutable record it previously read', async () => {
    const blob = new Blob(['expected-bytes'], { type: 'text/plain' });
    const uploadIdentity = identity('attachment-guarded');
    await service.savePendingUpload({
      ...uploadIdentity,
      attachmentId: 'attachment-guarded',
      fileName: 'guarded.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const expected = await service.readPendingUpload(uploadIdentity);
    expect(expected).not.toBeNull();
    if (!expected) throw new Error('expected pending upload fixture');

    const result = await service.removePendingUploadIfCurrent(expected, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result).toEqual({ status: 'removed' });
    await expect(service.readPendingUpload(uploadIdentity)).resolves.toBeNull();
  });

  it('keeps a same-key successor byte-identical when any immutable record field drifts', async () => {
    const uploadIdentity = identity('attachment-successor');
    const firstBlob = new Blob(['first-bytes'], { type: 'text/plain' });
    await service.savePendingUpload({
      ...uploadIdentity,
      attachmentId: 'attachment-successor',
      fileName: 'first.txt',
      mimeType: 'text/plain',
      size: firstBlob.size,
      blob: firstBlob,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const expected = await service.readPendingUpload(uploadIdentity);
    expect(expected).not.toBeNull();
    if (!expected) throw new Error('expected original pending upload fixture');
    const successorBlob = new Blob(['successor-bytes'], { type: 'text/plain' });
    const successorRecovery = {
      operationId: uploadIdentity.operationId,
      payload: {
        attachment: {
          id: 'attachment-successor',
          type: 'file' as const,
          name: 'successor.txt',
          url: 'nanoflow-local-attachment://attachment-successor',
          mimeType: 'text/plain',
          size: successorBlob.size,
          createdAt: '2026-06-15T00:01:00.000Z',
        },
        blobKey: uploadIdentity.blobKey,
        fileName: 'successor.txt',
        mimeType: 'text/plain',
        projectId: 'project-1',
        taskId: 'task-1',
        userId: ownerUserId,
        sourceUserId: ownerUserId,
      },
    };
    await service.savePendingUpload({
      ...uploadIdentity,
      attachmentId: 'attachment-successor',
      fileName: 'successor.txt',
      mimeType: 'text/plain',
      size: successorBlob.size,
      blob: successorBlob,
      createdAt: '2026-06-15T00:01:00.000Z',
      recovery: successorRecovery,
    });

    const result = await service.removePendingUploadIfCurrent(expected, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    const successor = await service.readPendingUpload(uploadIdentity);

    expect(result).toEqual({ status: 'mismatch' });
    expect(successor).toEqual(expect.objectContaining({
      fileName: 'successor.txt',
      createdAt: '2026-06-15T00:01:00.000Z',
      recovery: successorRecovery,
    }));
    expect(await successor?.blob.text()).toBe('successor-bytes');
  });

  it('does not remove the expected record after its replay fence aborts', async () => {
    const uploadIdentity = identity('attachment-aborted');
    const blob = new Blob(['retained'], { type: 'text/plain' });
    await service.savePendingUpload({
      ...uploadIdentity,
      attachmentId: 'attachment-aborted',
      fileName: 'retained.txt',
      mimeType: 'text/plain',
      size: blob.size,
      blob,
    });
    const expected = await service.readPendingUpload(uploadIdentity);
    expect(expected).not.toBeNull();
    if (!expected) throw new Error('expected retained pending upload fixture');
    const controller = new AbortController();
    controller.abort();

    const result = await service.removePendingUploadIfCurrent(expected, {
      signal: controller.signal,
      isCurrent: () => true,
    });

    expect(result).toEqual({ status: 'aborted' });
    expect(await service.readPendingUpload(uploadIdentity)).toEqual(expected);
  });

  it('lists all pending attachment Blobs after a new service instance is created', async () => {
    await service.savePendingUpload({
      ...identity('attachment-a'),
      attachmentId: 'attachment-a',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      blob: new Blob(['a'], { type: 'text/plain' }),
      createdAt: '2026-06-15T00:00:01.000Z',
    });
    await service.savePendingUpload({
      ...identity('attachment-b'),
      attachmentId: 'attachment-b',
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

    const pendingUploads = await restoredService.listPendingUploads(ownerUserId);

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
      ownerUserId,
      operationId: recovery.operationId,
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
    const restored = await restoredService.readPendingUpload(identity(
      'attachment-recoverable',
      recovery.operationId,
    ));
    const listed = await restoredService.listPendingUploads(ownerUserId);

    expect((restored as typeof restored & { recovery?: typeof recovery })?.recovery).toEqual(recovery);
    expect((listed[0] as typeof listed[number] & { recovery?: typeof recovery })?.recovery).toEqual(recovery);
  });

  it('restores a large pending attachment with byte-for-byte integrity after service recreation', async () => {
    const bytes = buildDeterministicBytes(1024 * 1024);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });

    await service.savePendingUpload({
      ...identity('attachment-large'),
      attachmentId: 'attachment-large',
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
    const restored = await restoredService.readPendingUpload(identity('attachment-large'));

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
