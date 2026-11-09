import { Injectable } from '@angular/core';
import { clear, createStore, del, entries, get, set } from 'idb-keyval';
import type { AttachmentUploadPayload } from './action-queue.types';
import { buildAttachmentReplayPayloadSignature } from './action-queue-durable-removal.controller';
import { trackLocalBackupUiRestoreWriterPromise } from './local-backup-ui-restore-writer-quiescence-tracker';

export interface PendingAttachmentUploadRecovery {
  operationId: string;
  payload: AttachmentUploadPayload;
}

export interface PendingAttachmentUploadIdentity {
  ownerUserId: string;
  blobKey: string;
  operationId: string;
}

export interface PendingAttachmentUploadRecord extends PendingAttachmentUploadIdentity {
  attachmentId: string;
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

interface AttachmentUploadMutationOptions {
  restoreWriterContinuation?: boolean;
}

interface AttachmentUploadReadOptions {
  restoreSnapshot?: boolean;
}

export interface PendingAttachmentUploadRemovalFence {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export type PendingAttachmentUploadRemovalResult = {
  status: 'removed' | 'missing' | 'mismatch' | 'aborted' | 'storage-failed';
};

export type PendingAttachmentUploadReadbackResult =
  | { status: 'found'; record: PendingAttachmentUploadRecord }
  | { status: 'missing' | 'mismatch' | 'storage-failed' };

interface StoredPendingAttachmentUploadRecord extends PendingAttachmentUploadIdentity {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  size: number;
  blobBytes: ArrayBuffer;
  createdAt: string;
  recovery?: PendingAttachmentUploadRecovery;
}

interface FallbackPendingAttachmentUploadRecord
  extends Omit<StoredPendingAttachmentUploadRecord, 'blobBytes'> {
  blobBase64: string;
}

type StoredPendingAttachmentUploadReadbackResult =
  | { status: 'found'; record: StoredPendingAttachmentUploadRecord }
  | { status: 'missing' | 'mismatch' | 'storage-failed' };

const OUTBOX_DB_NAME = 'nanoflow-attachment-upload-outbox';
const OUTBOX_STORE_NAME = 'pending-uploads';
const attachmentUploadStore = createStore(OUTBOX_DB_NAME, OUTBOX_STORE_NAME);
const STORE_KEY_VERSION = 'v2';
const LEGACY_FALLBACK_KEY_PREFIX = 'nanoflow.attachment-upload-outbox.';
const FALLBACK_KEY_PREFIX = `${LEGACY_FALLBACK_KEY_PREFIX}${STORE_KEY_VERSION}.`;

@Injectable({ providedIn: 'root' })
export class AttachmentUploadOutboxService {
  async savePendingUpload(
    input: SavePendingAttachmentUploadInput,
    options: AttachmentUploadMutationOptions = {},
  ): Promise<void> {
    this.requireIdentity(input);
    if (input.recovery && input.recovery.operationId !== input.operationId) {
      throw new Error('Attachment upload recovery operationId does not match the stored operation');
    }

    return trackLocalBackupUiRestoreWriterPromise(
      input.ownerUserId,
      'attachment-outbox',
      async () => {
        const record = await this.buildStoredRecord(input);
        const storageKey = this.getStorageKey(record);
        try {
          await set(storageKey, record, attachmentUploadStore);
          this.removeFallbackRecord(record);
        } catch {
          this.saveFallbackRecord(record);
        }
        if (!options.restoreWriterContinuation) {
          await this.clearLegacyRecordForBlob(record.blobKey);
        }
      },
      { continuation: options.restoreWriterContinuation === true },
    );
  }

  async readPendingUpload(
    identity: PendingAttachmentUploadIdentity,
  ): Promise<PendingAttachmentUploadRecord | null> {
    if (!this.hasIdentity(identity)) {
      return null;
    }

    return trackLocalBackupUiRestoreWriterPromise(identity.ownerUserId, 'attachment-outbox', async () => {
      await this.clearLegacyRecordForBlob(identity.blobKey);
      const record = await this.readStoredRecord(identity);
      return record ? this.hydratePendingUploadRecord(record) : null;
    });
  }

  async readPendingUploadStrictly(
    identity: PendingAttachmentUploadIdentity,
  ): Promise<PendingAttachmentUploadReadbackResult> {
    if (!this.hasIdentity(identity)) return { status: 'mismatch' };
    const stored = await this.readStoredRecordStrictly(identity);
    if (stored.status === 'found') {
      return { status: 'found', record: this.hydratePendingUploadRecord(stored.record) };
    }
    if (stored.status === 'mismatch') return stored;
    const fallback = this.readFallbackRecordStrictly(identity);
    if (fallback.status === 'found') {
      return { status: 'found', record: this.hydratePendingUploadRecord(fallback.record) };
    }
    return stored.status === 'storage-failed' && fallback.status === 'missing'
      ? stored
      : fallback;
  }

  matchesPendingUploadForReplay(
    record: PendingAttachmentUploadRecord,
    operationId: string,
    payload: AttachmentUploadPayload,
  ): boolean {
    return record.ownerUserId === (payload.sourceUserId || payload.userId)
      && record.operationId === operationId
      && record.attachmentId === payload.attachment.id
      && record.blobKey === payload.blobKey
      && record.fileName === payload.fileName
      && record.mimeType === payload.mimeType
      && record.size === payload.attachment.size
      && record.blob.size === record.size
      && record.blob.type === record.mimeType
      && record.recovery?.operationId === operationId
      && buildAttachmentReplayPayloadSignature(record.recovery.payload)
        === buildAttachmentReplayPayloadSignature(payload);
  }

  async listPendingUploads(
    ownerUserId: string,
    options: AttachmentUploadReadOptions = {},
  ): Promise<PendingAttachmentUploadRecord[]> {
    if (!this.isNonEmptyString(ownerUserId)) {
      return [];
    }

    const read = async (cleanupInvalid: boolean): Promise<PendingAttachmentUploadRecord[]> => {
      const recordsByStorageKey = new Map<string, StoredPendingAttachmentUploadRecord>();
      for (const [storageKey, candidate] of await this.loadStoredEntries()) {
        if (!this.isOwnerScopedStoredRecord(candidate)) {
          if (cleanupInvalid) await this.removeStorageKeySafely(storageKey);
          continue;
        }
        if (typeof storageKey !== 'string' || storageKey !== this.getStorageKey(candidate)) {
          if (cleanupInvalid) await this.removeStorageKeySafely(storageKey);
          continue;
        }
        if (candidate.ownerUserId === ownerUserId) {
          recordsByStorageKey.set(storageKey, candidate);
        }
      }

      for (const record of this.loadAllFallbackRecords(cleanupInvalid)) {
        if (record.ownerUserId !== ownerUserId) continue;
        const storageKey = this.getStorageKey(record);
        if (!recordsByStorageKey.has(storageKey)) {
          recordsByStorageKey.set(storageKey, record);
        }
      }

      return Array.from(recordsByStorageKey.values())
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt)
          || left.blobKey.localeCompare(right.blobKey)
          || left.operationId.localeCompare(right.operationId)
        )
        .map(record => this.hydratePendingUploadRecord(record));
    };

    if (options.restoreSnapshot) return read(false);
    return trackLocalBackupUiRestoreWriterPromise(ownerUserId, 'attachment-outbox', () => read(true));
  }

  async removePendingUpload(
    identity: PendingAttachmentUploadIdentity,
    options: AttachmentUploadMutationOptions = {},
  ): Promise<void> {
    if (!this.hasIdentity(identity)) {
      return;
    }

    return trackLocalBackupUiRestoreWriterPromise(
      identity.ownerUserId,
      'attachment-outbox',
      async () => {
        try {
          await del(this.getStorageKey(identity), attachmentUploadStore);
        } finally {
          this.removeFallbackRecord(identity);
        }
      },
      { continuation: options.restoreWriterContinuation === true },
    );
  }

  async removePendingUploadIfCurrent(
    expected: PendingAttachmentUploadRecord,
    fence: PendingAttachmentUploadRemovalFence,
    options: AttachmentUploadMutationOptions = {},
  ): Promise<PendingAttachmentUploadRemovalResult> {
    if (!this.hasIdentity(expected) || !this.isRemovalFenceCurrent(fence)) {
      return { status: 'aborted' };
    }
    return trackLocalBackupUiRestoreWriterPromise(
      expected.ownerUserId,
      'attachment-outbox',
      async () => {
        let storedExpected: StoredPendingAttachmentUploadRecord;
        try {
          storedExpected = await this.buildStoredRecord(expected);
        } catch {
          return { status: 'storage-failed' };
        }
        if (!this.isRemovalFenceCurrent(fence)) return { status: 'aborted' };
        const idbStatus = await this.removeStoredRecordIfCurrent(storedExpected, fence);
        if (idbStatus === 'aborted' || idbStatus === 'mismatch') {
          return { status: idbStatus };
        }
        const fallbackStatus = this.removeFallbackRecordIfCurrent(storedExpected, fence);
        if (fallbackStatus === 'aborted' || fallbackStatus === 'mismatch' || fallbackStatus === 'storage-failed') {
          return { status: fallbackStatus };
        }
        if (idbStatus === 'storage-failed' && fallbackStatus !== 'removed') {
          return { status: 'storage-failed' };
        }
        return {
          status: idbStatus === 'removed' || fallbackStatus === 'removed' ? 'removed' : 'missing',
        };
      },
      { continuation: options.restoreWriterContinuation === true },
    );
  }

  async clearPendingUploadsForTests(): Promise<void> {
    try {
      await clear(attachmentUploadStore);
    } finally {
      this.clearFallbackRecords();
    }
  }

  private async buildStoredRecord(
    input: SavePendingAttachmentUploadInput,
  ): Promise<StoredPendingAttachmentUploadRecord> {
    return {
      ownerUserId: input.ownerUserId,
      operationId: input.operationId,
      attachmentId: input.attachmentId,
      blobKey: input.blobKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      blobBytes: await input.blob.arrayBuffer(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      recovery: input.recovery,
    };
  }

  private async readStoredRecord(
    identity: PendingAttachmentUploadIdentity,
  ): Promise<StoredPendingAttachmentUploadRecord | null> {
    const storageKey = this.getStorageKey(identity);
    let candidate: unknown;
    try {
      candidate = await get<unknown>(storageKey, attachmentUploadStore);
    } catch {
      candidate = undefined;
    }

    if (this.isMatchingStoredRecord(candidate, identity)) {
      return candidate;
    }
    if (candidate !== undefined) {
      await this.removeStorageKeySafely(storageKey);
    }
    return this.loadFallbackRecord(identity);
  }

  private readStoredRecordStrictly(
    identity: PendingAttachmentUploadIdentity,
  ): Promise<StoredPendingAttachmentUploadReadbackResult> {
    if (typeof indexedDB === 'undefined') return Promise.resolve({ status: 'storage-failed' });
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: StoredPendingAttachmentUploadReadbackResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let openRequest: IDBOpenDBRequest;
      try {
        openRequest = indexedDB.open(OUTBOX_DB_NAME);
      } catch {
        finish({ status: 'storage-failed' });
        return;
      }
      openRequest.onerror = () => finish({ status: 'storage-failed' });
      openRequest.onupgradeneeded = () => {
        if (!openRequest.result.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
          openRequest.result.createObjectStore(OUTBOX_STORE_NAME);
        }
      };
      openRequest.onsuccess = () => {
        const db = openRequest.result;
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(OUTBOX_STORE_NAME, 'readonly');
        } catch {
          db.close();
          finish({ status: 'storage-failed' });
          return;
        }
        let candidate: unknown;
        let readFailed = false;
        const cleanup = () => db.close();
        transaction.oncomplete = () => {
          cleanup();
          if (readFailed) {
            finish({ status: 'storage-failed' });
          } else if (candidate === undefined) {
            finish({ status: 'missing' });
          } else if (this.isMatchingStoredRecord(candidate, identity)) {
            finish({ status: 'found', record: candidate });
          } else {
            finish({ status: 'mismatch' });
          }
        };
        transaction.onabort = () => {
          cleanup();
          finish({ status: 'storage-failed' });
        };
        transaction.onerror = () => undefined;
        let readRequest: IDBRequest;
        try {
          readRequest = transaction.objectStore(OUTBOX_STORE_NAME).get(this.getStorageKey(identity));
        } catch {
          readFailed = true;
          transaction.abort();
          return;
        }
        readRequest.onerror = () => {
          readFailed = true;
          transaction.abort();
        };
        readRequest.onsuccess = () => {
          candidate = readRequest.result;
        };
      };
    });
  }

  private readFallbackRecordStrictly(
    identity: PendingAttachmentUploadIdentity,
  ): StoredPendingAttachmentUploadReadbackResult {
    if (typeof localStorage === 'undefined') return { status: 'missing' };
    try {
      const raw = localStorage.getItem(this.getFallbackKey(identity));
      if (!raw) return { status: 'missing' };
      const candidate: unknown = JSON.parse(raw);
      if (!this.isOwnerScopedFallbackRecord(candidate) || !this.matches(candidate, identity)) {
        return { status: 'mismatch' };
      }
      return { status: 'found', record: this.hydrateFallbackRecord(candidate) };
    } catch {
      return { status: 'storage-failed' };
    }
  }

  private async loadStoredEntries(): Promise<Array<[IDBValidKey, unknown]>> {
    try {
      return await entries<IDBValidKey, unknown>(attachmentUploadStore);
    } catch {
      return [];
    }
  }

  private removeStoredRecordIfCurrent(
    expected: StoredPendingAttachmentUploadRecord,
    fence: PendingAttachmentUploadRemovalFence,
  ): Promise<PendingAttachmentUploadRemovalResult['status']> {
    if (typeof indexedDB === 'undefined') return Promise.resolve('storage-failed');
    return new Promise(resolve => {
      let settled = false;
      const finish = (status: PendingAttachmentUploadRemovalResult['status']) => {
        if (settled) return;
        settled = true;
        resolve(status);
      };
      let openRequest: IDBOpenDBRequest;
      try {
        openRequest = indexedDB.open(OUTBOX_DB_NAME);
      } catch {
        finish('storage-failed');
        return;
      }
      openRequest.onerror = () => finish('storage-failed');
      openRequest.onsuccess = () => {
        const db = openRequest.result;
        if (!this.isRemovalFenceCurrent(fence)) {
          db.close();
          finish('aborted');
          return;
        }
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
        } catch {
          db.close();
          finish('storage-failed');
          return;
        }
        let decision: PendingAttachmentUploadRemovalResult['status'] = 'storage-failed';
        const abortForFence = () => {
          decision = 'aborted';
          try {
            transaction.abort();
          } catch {
            // The transaction may already have completed.
          }
        };
        fence.signal.addEventListener('abort', abortForFence, { once: true });
        const cleanup = () => {
          fence.signal.removeEventListener('abort', abortForFence);
          db.close();
        };
        transaction.oncomplete = () => {
          cleanup();
          finish(this.isRemovalFenceCurrent(fence) ? decision : 'aborted');
        };
        transaction.onabort = () => {
          cleanup();
          finish(decision === 'aborted' ? 'aborted' : 'storage-failed');
        };
        transaction.onerror = () => undefined;
        const store = transaction.objectStore(OUTBOX_STORE_NAME);
        const readRequest = store.get(this.getStorageKey(expected));
        readRequest.onerror = () => {
          decision = 'storage-failed';
          transaction.abort();
        };
        readRequest.onsuccess = () => {
          if (!this.isRemovalFenceCurrent(fence)) {
            abortForFence();
            return;
          }
          if (readRequest.result === undefined) {
            decision = 'missing';
            return;
          }
          if (!this.isOwnerScopedStoredRecord(readRequest.result)
            || !this.storedRecordsEqual(readRequest.result, expected)) {
            decision = 'mismatch';
            return;
          }
          decision = 'removed';
          const deleteRequest = store.delete(this.getStorageKey(expected));
          deleteRequest.onerror = () => {
            decision = 'storage-failed';
            transaction.abort();
          };
        };
      };
    });
  }

  private removeFallbackRecordIfCurrent(
    expected: StoredPendingAttachmentUploadRecord,
    fence: PendingAttachmentUploadRemovalFence,
  ): PendingAttachmentUploadRemovalResult['status'] {
    if (!this.isRemovalFenceCurrent(fence)) return 'aborted';
    if (typeof localStorage === 'undefined') return 'missing';
    const storageKey = this.getFallbackKey(expected);
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return 'missing';
      const candidate: unknown = JSON.parse(raw);
      if (!this.isOwnerScopedFallbackRecord(candidate)) return 'mismatch';
      if (!this.storedRecordsEqual(this.hydrateFallbackRecord(candidate), expected)) return 'mismatch';
      if (!this.isRemovalFenceCurrent(fence)) return 'aborted';
      localStorage.removeItem(storageKey);
      return 'removed';
    } catch {
      return 'storage-failed';
    }
  }

  private storedRecordsEqual(
    left: StoredPendingAttachmentUploadRecord,
    right: StoredPendingAttachmentUploadRecord,
  ): boolean {
    return left.ownerUserId === right.ownerUserId
      && left.operationId === right.operationId
      && left.attachmentId === right.attachmentId
      && left.blobKey === right.blobKey
      && left.fileName === right.fileName
      && left.mimeType === right.mimeType
      && left.size === right.size
      && left.createdAt === right.createdAt
      && this.stableStringify(left.recovery) === this.stableStringify(right.recovery)
      && this.arrayBuffersEqual(left.blobBytes, right.blobBytes);
  }

  private arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
    if (left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    return leftBytes.every((value, index) => value === rightBytes[index]);
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${this.stableStringify(record[key])}`).join(',')}}`;
  }

  private isRemovalFenceCurrent(fence: PendingAttachmentUploadRemovalFence): boolean {
    return !fence.signal.aborted && fence.isCurrent();
  }

  private hydratePendingUploadRecord(
    record: StoredPendingAttachmentUploadRecord,
  ): PendingAttachmentUploadRecord {
    return {
      ownerUserId: record.ownerUserId,
      operationId: record.operationId,
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

  private saveFallbackRecord(record: StoredPendingAttachmentUploadRecord): void {
    if (typeof localStorage === 'undefined') {
      throw new Error('Attachment upload fallback storage is unavailable');
    }
    const fallbackRecord: FallbackPendingAttachmentUploadRecord = {
      ownerUserId: record.ownerUserId,
      operationId: record.operationId,
      attachmentId: record.attachmentId,
      blobKey: record.blobKey,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
      createdAt: record.createdAt,
      blobBase64: this.arrayBufferToBase64(record.blobBytes),
      recovery: record.recovery,
    };
    localStorage.setItem(this.getFallbackKey(record), JSON.stringify(fallbackRecord));
  }

  private loadFallbackRecord(
    identity: PendingAttachmentUploadIdentity,
  ): StoredPendingAttachmentUploadRecord | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const storageKey = this.getFallbackKey(identity);
    return this.loadFallbackRecordAtKey(storageKey, identity);
  }

  private loadFallbackRecordAtKey(
    storageKey: string,
    identity?: PendingAttachmentUploadIdentity,
    cleanupInvalid = true,
  ): StoredPendingAttachmentUploadRecord | null {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const candidate = JSON.parse(raw) as unknown;
      if (!this.isOwnerScopedFallbackRecord(candidate)) {
        if (cleanupInvalid) localStorage.removeItem(storageKey);
        return null;
      }
      const record = this.hydrateFallbackRecord(candidate);
      if (storageKey !== this.getFallbackKey(record) || (identity && !this.matches(record, identity))) {
        if (cleanupInvalid) localStorage.removeItem(storageKey);
        return null;
      }
      return record;
    } catch {
      if (cleanupInvalid) localStorage.removeItem(storageKey);
      return null; // eslint-disable-line no-restricted-syntax -- malformed fallback data is quarantined and excluded from replay
    }
  }

  private loadAllFallbackRecords(cleanupInvalid = true): StoredPendingAttachmentUploadRecord[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    const records: StoredPendingAttachmentUploadRecord[] = [];
    for (const storageKey of this.listFallbackKeys()) {
      if (!storageKey.startsWith(FALLBACK_KEY_PREFIX)) {
        if (cleanupInvalid) localStorage.removeItem(storageKey);
        continue;
      }
      const record = this.loadFallbackRecordAtKey(storageKey, undefined, cleanupInvalid);
      if (record) records.push(record);
    }
    return records;
  }

  private hydrateFallbackRecord(
    record: FallbackPendingAttachmentUploadRecord,
  ): StoredPendingAttachmentUploadRecord {
    return {
      ownerUserId: record.ownerUserId,
      operationId: record.operationId,
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

  private removeFallbackRecord(identity: PendingAttachmentUploadIdentity): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.getFallbackKey(identity));
  }

  private clearFallbackRecords(): void {
    if (typeof localStorage === 'undefined') return;
    this.listFallbackKeys().forEach(key => localStorage.removeItem(key));
  }

  private listFallbackKeys(): string[] {
    if (typeof localStorage === 'undefined') return [];
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_FALLBACK_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    return keys;
  }

  private async clearLegacyRecordForBlob(blobKey: string): Promise<void> {
    await this.removeStorageKeySafely(blobKey);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`${LEGACY_FALLBACK_KEY_PREFIX}${blobKey}`);
    }
  }

  private async removeStorageKeySafely(storageKey: IDBValidKey): Promise<void> {
    try {
      await del(storageKey, attachmentUploadStore);
    } catch {
      // Invalid or unavailable legacy storage is already excluded from reads.
    }
  }

  private isMatchingStoredRecord(
    candidate: unknown,
    identity: PendingAttachmentUploadIdentity,
  ): candidate is StoredPendingAttachmentUploadRecord {
    return this.isOwnerScopedStoredRecord(candidate) && this.matches(candidate, identity);
  }

  private isOwnerScopedStoredRecord(candidate: unknown): candidate is StoredPendingAttachmentUploadRecord {
    if (!candidate || typeof candidate !== 'object') return false;
    const record = candidate as Partial<StoredPendingAttachmentUploadRecord>;
    return this.hasIdentity(record)
      && this.isNonEmptyString(record.attachmentId)
      && this.isNonEmptyString(record.fileName)
      && typeof record.mimeType === 'string'
      && typeof record.size === 'number'
      && Number.isFinite(record.size)
      && record.blobBytes instanceof ArrayBuffer
      && this.isNonEmptyString(record.createdAt);
  }

  private isOwnerScopedFallbackRecord(
    candidate: unknown,
  ): candidate is FallbackPendingAttachmentUploadRecord {
    if (!candidate || typeof candidate !== 'object') return false;
    const record = candidate as Partial<FallbackPendingAttachmentUploadRecord>;
    return this.hasIdentity(record)
      && this.isNonEmptyString(record.attachmentId)
      && this.isNonEmptyString(record.fileName)
      && typeof record.mimeType === 'string'
      && typeof record.size === 'number'
      && Number.isFinite(record.size)
      && this.isNonEmptyString(record.createdAt)
      && typeof record.blobBase64 === 'string';
  }

  private matches(
    left: PendingAttachmentUploadIdentity,
    right: PendingAttachmentUploadIdentity,
  ): boolean {
    return left.ownerUserId === right.ownerUserId
      && left.blobKey === right.blobKey
      && left.operationId === right.operationId;
  }

  private hasIdentity<T extends Partial<PendingAttachmentUploadIdentity>>(
    candidate: T,
  ): candidate is T & PendingAttachmentUploadIdentity {
    return this.isNonEmptyString(candidate.ownerUserId)
      && this.isNonEmptyString(candidate.blobKey)
      && this.isNonEmptyString(candidate.operationId);
  }

  private requireIdentity(identity: Partial<PendingAttachmentUploadIdentity>): void {
    if (!this.hasIdentity(identity)) {
      throw new Error('Attachment upload outbox requires ownerUserId, blobKey, and operationId');
    }
  }

  private getStorageKey(identity: PendingAttachmentUploadIdentity): string {
    return `${STORE_KEY_VERSION}:${JSON.stringify([
      identity.ownerUserId,
      identity.blobKey,
      identity.operationId,
    ])}`;
  }

  private getFallbackKey(identity: PendingAttachmentUploadIdentity): string {
    return `${FALLBACK_KEY_PREFIX}${encodeURIComponent(this.getStorageKey(identity))}`;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
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
