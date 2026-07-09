import { Injectable } from '@angular/core';
import { clear, createStore, del, get, set, values } from 'idb-keyval';
import type { AttachmentUploadPayload } from './action-queue.types';

export interface PendingAttachmentUploadRecovery {
  operationId: string;
  payload: AttachmentUploadPayload;
}

export interface PendingAttachmentUploadRecord {
  attachmentId: string;
  blobKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  blob: Blob;
  createdAt: string;
  recovery?: PendingAttachmentUploadRecovery;
}

export type SavePendingAttachmentUploadInput = Omit<PendingAttachmentUploadRecord, 'createdAt'> & {
  createdAt?: string;
};

interface StoredPendingAttachmentUploadRecord {
  attachmentId: string;
  blobKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  blobBytes: ArrayBuffer;
  createdAt: string;
  recovery?: PendingAttachmentUploadRecovery;
}

const attachmentUploadStore = createStore(
  'nanoflow-attachment-upload-outbox',
  'pending-uploads',
);
const FALLBACK_KEY_PREFIX = 'nanoflow.attachment-upload-outbox.';

interface FallbackPendingAttachmentUploadRecord extends Omit<StoredPendingAttachmentUploadRecord, 'blobBytes'> {
  blobBase64: string;
}

@Injectable({ providedIn: 'root' })
export class AttachmentUploadOutboxService {
  async savePendingUpload(input: SavePendingAttachmentUploadInput): Promise<void> {
    const record: StoredPendingAttachmentUploadRecord = {
      attachmentId: input.attachmentId,
      blobKey: input.blobKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      blobBytes: await input.blob.arrayBuffer(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      recovery: input.recovery,
    };
    try {
      await set(record.blobKey, record, attachmentUploadStore);
      this.removeFallbackRecord(record.blobKey);
    } catch {
      this.saveFallbackRecord(record);
    }
  }

  async readPendingUpload(blobKey: string): Promise<PendingAttachmentUploadRecord | null> {
    let record: StoredPendingAttachmentUploadRecord | undefined;
    try {
      record = await get<StoredPendingAttachmentUploadRecord>(blobKey, attachmentUploadStore);
    } catch {
      record = undefined;
    }
    if (!record) {
      const fallbackRecord = this.loadFallbackRecord(blobKey);
      return fallbackRecord ? this.hydratePendingUploadRecord(fallbackRecord) : null;
    }

    return this.hydratePendingUploadRecord(record);
  }

  async listPendingUploads(): Promise<PendingAttachmentUploadRecord[]> {
    let records: StoredPendingAttachmentUploadRecord[] = [];
    try {
      records = await values<StoredPendingAttachmentUploadRecord>(attachmentUploadStore);
    } catch {
      records = [];
    }

    const recordsByBlobKey = new Map(records.map(record => [record.blobKey, record]));
    this.loadAllFallbackRecords().forEach(record => {
      if (!recordsByBlobKey.has(record.blobKey)) {
        recordsByBlobKey.set(record.blobKey, record);
      }
    });

    return Array.from(recordsByBlobKey.values())
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.blobKey.localeCompare(right.blobKey)
      )
      .map(record => this.hydratePendingUploadRecord(record));
  }

  private hydratePendingUploadRecord(
    record: StoredPendingAttachmentUploadRecord,
  ): PendingAttachmentUploadRecord {
    return {
      attachmentId: record.attachmentId,
      blobKey: record.blobKey,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
      createdAt: record.createdAt,
      blob: new Blob([record.blobBytes], { type: record.mimeType }),
      recovery: record.recovery,
    };
  }

  async removePendingUpload(blobKey: string): Promise<void> {
    try {
      await del(blobKey, attachmentUploadStore);
    } finally {
      this.removeFallbackRecord(blobKey);
    }
  }

  async clearPendingUploadsForTests(): Promise<void> {
    try {
      await clear(attachmentUploadStore);
    } finally {
      this.clearFallbackRecords();
    }
  }

  private saveFallbackRecord(record: StoredPendingAttachmentUploadRecord): void {
    const fallbackRecord: FallbackPendingAttachmentUploadRecord = {
      attachmentId: record.attachmentId,
      blobKey: record.blobKey,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
      createdAt: record.createdAt,
      blobBase64: this.arrayBufferToBase64(record.blobBytes),
      recovery: record.recovery,
    };
    localStorage.setItem(this.getFallbackKey(record.blobKey), JSON.stringify(fallbackRecord));
  }

  private loadFallbackRecord(blobKey: string): StoredPendingAttachmentUploadRecord | null {
    let storedRecord: StoredPendingAttachmentUploadRecord | null = null;

    try {
      const raw = localStorage.getItem(this.getFallbackKey(blobKey));
      if (!raw) {
        return null;
      }

      const record = JSON.parse(raw) as FallbackPendingAttachmentUploadRecord;
      storedRecord = this.hydrateFallbackRecord(record);
    } catch {
      this.removeFallbackRecord(blobKey);
    }

    return storedRecord;
  }

  private loadAllFallbackRecords(): StoredPendingAttachmentUploadRecord[] {
    return this.listFallbackKeys()
      .map(key => this.loadFallbackRecord(key.slice(FALLBACK_KEY_PREFIX.length)))
      .filter((record): record is StoredPendingAttachmentUploadRecord => record !== null);
  }

  private hydrateFallbackRecord(
    record: FallbackPendingAttachmentUploadRecord,
  ): StoredPendingAttachmentUploadRecord {
    return {
      attachmentId: record.attachmentId,
      blobKey: record.blobKey,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
      createdAt: record.createdAt,
      blobBytes: this.base64ToArrayBuffer(record.blobBase64),
      recovery: record.recovery,
    };
  }

  private removeFallbackRecord(blobKey: string): void {
    localStorage.removeItem(this.getFallbackKey(blobKey));
  }

  private clearFallbackRecords(): void {
    this.listFallbackKeys().forEach(key => localStorage.removeItem(key));
  }

  private listFallbackKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(FALLBACK_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    return keys;
  }

  private getFallbackKey(blobKey: string): string {
    return `${FALLBACK_KEY_PREFIX}${blobKey}`;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }
}
