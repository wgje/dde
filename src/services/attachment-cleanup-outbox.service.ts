import { Injectable } from '@angular/core';
import { clear, createStore, del, get, set, values } from 'idb-keyval';

export interface PendingAttachmentCleanupRecord {
  path: string;
  operationId: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError?: string;
}

export interface AttachmentCleanupEnqueueOptions {
  createdAt?: string;
}

export interface AttachmentCleanupFlushOptions {
  batchSize?: number;
  bucketName?: string;
}

export interface AttachmentCleanupFlushResult {
  ok: boolean;
  deletedCount: number;
  remainingCount: number;
  errors: string[];
}

export interface AttachmentCleanupStorageClient {
  storage: {
    from(bucketName: string): {
      remove(paths: string[]): Promise<{ data: unknown; error: { message?: string } | null }>;
    };
  };
}

type AttachmentCleanupStorageBucket = ReturnType<AttachmentCleanupStorageClient['storage']['from']>;

interface AttachmentCleanupBatchResult {
  deletedCount: number;
  error?: string;
}

const ATTACHMENT_CLEANUP_DB_NAME = 'nanoflow-attachment-cleanup-outbox';
const ATTACHMENT_CLEANUP_STORE_NAME = 'pending-cleanups';
const ATTACHMENT_CLEANUP_FALLBACK_KEY_PREFIX = 'nanoflow.attachment-cleanup-outbox.';
const DEFAULT_BUCKET_NAME = 'attachments';
const DEFAULT_BATCH_SIZE = 100;

const attachmentCleanupStore = createStore(
  ATTACHMENT_CLEANUP_DB_NAME,
  ATTACHMENT_CLEANUP_STORE_NAME,
);

@Injectable({ providedIn: 'root' })
export class AttachmentCleanupOutboxService {
  /**
   * flush 单飞：flappy 网络下两次 restore 扇出可能重叠，
   * 读-发-删无锁并发会对同一批 pending 路径重复发送 storage remove。
   */
  private flushPendingCleanupsPromise: Promise<AttachmentCleanupFlushResult> | null = null;

  async enqueuePaths(
    paths: string[],
    options: AttachmentCleanupEnqueueOptions = {},
  ): Promise<PendingAttachmentCleanupRecord[]> {
    const created: PendingAttachmentCleanupRecord[] = [];
    const now = options.createdAt ?? new Date().toISOString();

    for (const path of this.normalizePaths(paths)) {
      const existing = await this.readStoredRecord(path);
      if (existing) {
        created.push(existing);
        continue;
      }

      const record: PendingAttachmentCleanupRecord = {
        path,
        operationId: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        attemptCount: 0,
      };
      await this.writeRecord(record);
      created.push(record);
    }

    return created;
  }

  async listPendingCleanups(): Promise<PendingAttachmentCleanupRecord[]> {
    let records: PendingAttachmentCleanupRecord[] = [];
    try {
      records = await values<PendingAttachmentCleanupRecord>(attachmentCleanupStore);
    } catch {
      records = [];
    }

    const byPath = new Map(records.map(record => [record.path, record]));
    this.loadAllFallbackRecords().forEach(record => {
      if (!byPath.has(record.path)) {
        byPath.set(record.path, record);
      }
    });

    return Array.from(byPath.values())
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.path.localeCompare(right.path)
      );
  }

  async removePaths(paths: string[]): Promise<void> {
    for (const path of this.normalizePaths(paths)) {
      try {
        await del(path, attachmentCleanupStore);
      } finally {
        this.removeFallbackRecord(path);
      }
    }
  }

  async flushPendingCleanups(
    client: AttachmentCleanupStorageClient | null,
    options: AttachmentCleanupFlushOptions = {},
  ): Promise<AttachmentCleanupFlushResult> {
    if (this.flushPendingCleanupsPromise) {
      return this.flushPendingCleanupsPromise;
    }

    this.flushPendingCleanupsPromise = this.flushPendingCleanupsInternal(client, options)
      .finally(() => {
        this.flushPendingCleanupsPromise = null;
      });
    return this.flushPendingCleanupsPromise;
  }

  private async flushPendingCleanupsInternal(
    client: AttachmentCleanupStorageClient | null,
    options: AttachmentCleanupFlushOptions,
  ): Promise<AttachmentCleanupFlushResult> {
    const pending = await this.listPendingCleanups();
    if (pending.length === 0) {
      return {
        ok: true,
        deletedCount: 0,
        remainingCount: 0,
        errors: [],
      };
    }

    if (!client) {
      const message = 'Supabase client unavailable';
      await this.markRecordsFailed(pending, message);
      return {
        ok: false,
        deletedCount: 0,
        remainingCount: pending.length,
        errors: [message],
      };
    }

    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const bucketName = options.bucketName ?? DEFAULT_BUCKET_NAME;
    const bucket = client.storage.from(bucketName);
    const errors: string[] = [];
    let deletedCount = 0;

    for (let index = 0; index < pending.length; index += batchSize) {
      const batch = pending.slice(index, index + batchSize);
      const result = await this.flushCleanupBatch(bucket, batch);
      deletedCount += result.deletedCount;
      if (result.error) {
        errors.push(result.error);
      }
    }

    return {
      ok: errors.length === 0,
      deletedCount,
      remainingCount: (await this.listPendingCleanups()).length,
      errors,
    };
  }

  async clearPendingCleanupsForTests(): Promise<void> {
    try {
      await clear(attachmentCleanupStore);
    } finally {
      this.clearFallbackRecords();
    }
  }

  private async readStoredRecord(path: string): Promise<PendingAttachmentCleanupRecord | null> {
    try {
      const record = await get<PendingAttachmentCleanupRecord>(path, attachmentCleanupStore);
      if (record) {
        return record;
      }
    } catch {
      // Fall through to localStorage fallback.
    }

    return this.loadFallbackRecord(path);
  }

  private async flushCleanupBatch(
    bucket: AttachmentCleanupStorageBucket,
    batch: PendingAttachmentCleanupRecord[],
  ): Promise<AttachmentCleanupBatchResult> {
    const batchPaths = batch.map(record => record.path);
    try {
      const { error } = await bucket.remove(batchPaths);
      if (error) {
        const message = error.message ?? 'Storage cleanup failed';
        await this.markRecordsFailed(batch, message);
        return { deletedCount: 0, error: message };
      }

      await this.removePaths(batchPaths);
      return { deletedCount: batchPaths.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Storage cleanup failed';
      await this.markRecordsFailed(batch, message);
      return { deletedCount: 0, error: message };
    }
  }

  private async writeRecord(record: PendingAttachmentCleanupRecord): Promise<void> {
    try {
      await set(record.path, record, attachmentCleanupStore);
      this.removeFallbackRecord(record.path);
    } catch {
      this.saveFallbackRecord(record);
    }
  }

  private async markRecordsFailed(
    records: PendingAttachmentCleanupRecord[],
    error: string,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    for (const record of records) {
      await this.writeRecord({
        ...record,
        updatedAt,
        attemptCount: record.attemptCount + 1,
        lastError: error,
      });
    }
  }

  private normalizePaths(paths: string[]): string[] {
    return Array.from(new Set(
      paths
        .map(path => path.trim())
        .filter(path => path.length > 0),
    ));
  }

  private saveFallbackRecord(record: PendingAttachmentCleanupRecord): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(this.getFallbackKey(record.path), JSON.stringify(record));
  }

  private loadFallbackRecord(path: string): PendingAttachmentCleanupRecord | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    let raw: string | null = null;
    let shouldRemoveFallback = false;
    try {
      raw = localStorage.getItem(this.getFallbackKey(path));
    } catch {
      shouldRemoveFallback = true;
    }

    if (!raw) {
      if (shouldRemoveFallback) {
        this.removeFallbackRecord(path);
      }
      return null;
    }

    try {
      return JSON.parse(raw) as PendingAttachmentCleanupRecord;
    } catch {
      this.removeFallbackRecord(path);
    }

    return null;
  }

  private loadAllFallbackRecords(): PendingAttachmentCleanupRecord[] {
    return this.listFallbackKeys()
      .map(key => this.loadFallbackRecord(key.slice(ATTACHMENT_CLEANUP_FALLBACK_KEY_PREFIX.length)))
      .filter((record): record is PendingAttachmentCleanupRecord => record !== null);
  }

  private removeFallbackRecord(path: string): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.removeItem(this.getFallbackKey(path));
  }

  private clearFallbackRecords(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    this.listFallbackKeys().forEach(key => localStorage.removeItem(key));
  }

  private listFallbackKeys(): string[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(ATTACHMENT_CLEANUP_FALLBACK_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    return keys;
  }

  private getFallbackKey(path: string): string {
    return `${ATTACHMENT_CLEANUP_FALLBACK_KEY_PREFIX}${path}`;
  }
}
