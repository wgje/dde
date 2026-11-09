import { Injectable, OnDestroy, inject } from '@angular/core';
import { clear, createStore, del, entries, get, set } from 'idb-keyval';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';

export interface PendingAttachmentCleanupIdentity {
  ownerUserId: string;
  path: string;
  operationId: string;
}

export interface PendingAttachmentCleanupRecord extends PendingAttachmentCleanupIdentity {
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError?: string;
}

export interface AttachmentCleanupEnqueueOptions {
  ownerUserId: string;
  operationId?: string;
  createdAt?: string;
}

export interface AttachmentCleanupFlushOptions {
  ownerUserId: string;
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

interface AttachmentCleanupFlushContext {
  ownerUserId: string;
  generation: number;
}

const ATTACHMENT_CLEANUP_DB_NAME = 'nanoflow-attachment-cleanup-outbox';
const ATTACHMENT_CLEANUP_STORE_NAME = 'pending-cleanups';
const STORE_KEY_VERSION = 'v2';
const LEGACY_FALLBACK_KEY_PREFIX = 'nanoflow.attachment-cleanup-outbox.';
const FALLBACK_KEY_PREFIX = `${LEGACY_FALLBACK_KEY_PREFIX}${STORE_KEY_VERSION}.`;
const DEFAULT_BUCKET_NAME = 'attachments';
const DEFAULT_BATCH_SIZE = 100;

const attachmentCleanupStore = createStore(
  ATTACHMENT_CLEANUP_DB_NAME,
  ATTACHMENT_CLEANUP_STORE_NAME,
);

@Injectable({ providedIn: 'root' })
export class AttachmentCleanupOutboxService implements OnDestroy {
  private readonly flushPendingCleanupsByOwner = new Map<
    string,
    Promise<AttachmentCleanupFlushResult>
  >();
  private runtimeGeneration = 0;
  private destroyed = false;
  private readonly unregisterSessionRuntimeReset = inject(
    SessionRuntimeResetRegistry,
    { optional: true },
  )?.register(
    'AttachmentCleanupOutboxService',
    () => this.invalidateRuntime(),
  ) ?? (() => undefined);

  ngOnDestroy(): void {
    this.destroyed = true;
    this.invalidateRuntime();
    this.unregisterSessionRuntimeReset();
  }

  async enqueuePaths(
    paths: string[],
    options: AttachmentCleanupEnqueueOptions,
  ): Promise<PendingAttachmentCleanupRecord[]> {
    this.requireOwnerUserId(options.ownerUserId);
    if (options.operationId !== undefined) {
      this.requireOperationId(options.operationId);
    }

    const created: PendingAttachmentCleanupRecord[] = [];
    const now = options.createdAt ?? new Date().toISOString();
    const normalizedPaths = this.normalizePaths(paths);
    this.requireOwnedPaths(normalizedPaths, options.ownerUserId);
    for (const path of normalizedPaths) {
      const identity: PendingAttachmentCleanupIdentity = {
        ownerUserId: options.ownerUserId,
        path,
        operationId: options.operationId ?? crypto.randomUUID(),
      };
      const existing = await this.readStoredRecord(identity);
      if (existing) {
        created.push(existing);
        continue;
      }

      const record: PendingAttachmentCleanupRecord = {
        ...identity,
        createdAt: now,
        updatedAt: now,
        attemptCount: 0,
      };
      await this.writeRecord(record);
      await this.clearLegacyRecordForPath(path);
      created.push(record);
    }
    return created;
  }

  async listPendingCleanups(ownerUserId: string): Promise<PendingAttachmentCleanupRecord[]> {
    if (!this.isNonEmptyString(ownerUserId)) return [];

    const recordsByStorageKey = new Map<string, PendingAttachmentCleanupRecord>();
    for (const [storageKey, candidate] of await this.loadStoredEntries()) {
      if (!this.isOwnerScopedRecord(candidate)) {
        await this.removeStorageKeySafely(storageKey);
        continue;
      }
      if (typeof storageKey !== 'string' || storageKey !== this.getStorageKey(candidate)) {
        await this.removeStorageKeySafely(storageKey);
        continue;
      }
      if (candidate.ownerUserId === ownerUserId) {
        recordsByStorageKey.set(storageKey, candidate);
      }
    }

    for (const record of this.loadAllFallbackRecords()) {
      if (record.ownerUserId !== ownerUserId) continue;
      const storageKey = this.getStorageKey(record);
      if (!recordsByStorageKey.has(storageKey)) {
        recordsByStorageKey.set(storageKey, record);
      }
    }

    return Array.from(recordsByStorageKey.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.path.localeCompare(right.path)
      || left.operationId.localeCompare(right.operationId));
  }

  async removePendingCleanups(
    identities: PendingAttachmentCleanupIdentity[],
  ): Promise<void> {
    const uniqueIdentities = new Map<string, PendingAttachmentCleanupIdentity>();
    for (const identity of identities) {
      if (!this.hasIdentity(identity)) continue;
      uniqueIdentities.set(this.getStorageKey(identity), identity);
    }

    for (const identity of uniqueIdentities.values()) {
      try {
        await del(this.getStorageKey(identity), attachmentCleanupStore);
      } finally {
        this.removeFallbackRecord(identity);
      }
    }
  }

  async flushPendingCleanups(
    client: AttachmentCleanupStorageClient | null,
    options: AttachmentCleanupFlushOptions,
  ): Promise<AttachmentCleanupFlushResult> {
    if (!this.isNonEmptyString(options.ownerUserId)) {
      return this.buildUnavailableOwnerResult();
    }
    if (this.destroyed) {
      return this.buildCancelledResult(0);
    }

    const existing = this.flushPendingCleanupsByOwner.get(options.ownerUserId);
    if (existing) return existing;

    const context: AttachmentCleanupFlushContext = {
      ownerUserId: options.ownerUserId,
      generation: this.runtimeGeneration,
    };
    const flushPromise = this.flushPendingCleanupsInternal(client, options, context)
      .finally(() => {
        if (this.flushPendingCleanupsByOwner.get(options.ownerUserId) === flushPromise) {
          this.flushPendingCleanupsByOwner.delete(options.ownerUserId);
        }
      });
    this.flushPendingCleanupsByOwner.set(options.ownerUserId, flushPromise);
    return flushPromise;
  }

  async clearPendingCleanupsForTests(): Promise<void> {
    this.invalidateRuntime();
    try {
      await clear(attachmentCleanupStore);
    } finally {
      this.clearFallbackRecords();
    }
  }

  private async flushPendingCleanupsInternal(
    client: AttachmentCleanupStorageClient | null,
    options: AttachmentCleanupFlushOptions,
    context: AttachmentCleanupFlushContext,
  ): Promise<AttachmentCleanupFlushResult> {
    const pending = await this.listPendingCleanups(context.ownerUserId);
    if (!this.isFlushCurrent(context)) return this.buildCancelledResult(pending.length);
    if (pending.length === 0) return this.buildSuccessResult(0, 0);

    if (!client) {
      const message = 'Supabase client unavailable';
      await this.markRecordsFailed(pending, message, context);
      return {
        ok: false,
        deletedCount: 0,
        remainingCount: (await this.listPendingCleanups(context.ownerUserId)).length,
        errors: [message],
      };
    }

    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const bucket = client.storage.from(options.bucketName ?? DEFAULT_BUCKET_NAME);
    const errors: string[] = [];
    let deletedCount = 0;
    for (let index = 0; index < pending.length; index += batchSize) {
      if (!this.isFlushCurrent(context)) break;
      const result = await this.flushCleanupBatch(
        bucket,
        pending.slice(index, index + batchSize),
        context,
      );
      deletedCount += result.deletedCount;
      if (result.error) errors.push(result.error);
    }

    return {
      ok: errors.length === 0,
      deletedCount,
      remainingCount: (await this.listPendingCleanups(context.ownerUserId)).length,
      errors,
    };
  }

  private async flushCleanupBatch(
    bucket: AttachmentCleanupStorageBucket,
    batch: PendingAttachmentCleanupRecord[],
    context: AttachmentCleanupFlushContext,
  ): Promise<AttachmentCleanupBatchResult> {
    const batchPaths = batch.map(record => record.path);
    try {
      const { error } = await bucket.remove(batchPaths);
      if (!this.isFlushCurrent(context)) return { deletedCount: 0 };
      if (error) {
        const message = error.message ?? 'Storage cleanup failed';
        await this.markRecordsFailed(batch, message, context);
        return { deletedCount: 0, error: message };
      }

      await this.removePendingCleanupsIfCurrent(batch, context);
      return { deletedCount: batchPaths.length };
    } catch (error) {
      if (!this.isFlushCurrent(context)) return { deletedCount: 0 };
      const message = error instanceof Error ? error.message : 'Storage cleanup failed';
      await this.markRecordsFailed(batch, message, context);
      return { deletedCount: 0, error: message };
    }
  }

  private async removePendingCleanupsIfCurrent(
    records: PendingAttachmentCleanupRecord[],
    context: AttachmentCleanupFlushContext,
  ): Promise<void> {
    for (const record of records) {
      if (!this.isFlushCurrent(context)) return;
      await this.removePendingCleanups([record]);
    }
  }

  private async markRecordsFailed(
    records: PendingAttachmentCleanupRecord[],
    error: string,
    context: AttachmentCleanupFlushContext,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    for (const record of records) {
      if (!this.isFlushCurrent(context)) return;
      const current = await this.readStoredRecord(record);
      if (!this.isFlushCurrent(context) || !current) continue;
      await this.writeRecord({
        ...current,
        updatedAt,
        attemptCount: current.attemptCount + 1,
        lastError: error,
      });
    }
  }

  private async writeRecord(record: PendingAttachmentCleanupRecord): Promise<void> {
    const storageKey = this.getStorageKey(record);
    try {
      await set(storageKey, record, attachmentCleanupStore);
      this.removeFallbackRecord(record);
    } catch {
      this.saveFallbackRecord(record);
    }
  }

  private async readStoredRecord(
    identity: PendingAttachmentCleanupIdentity,
  ): Promise<PendingAttachmentCleanupRecord | null> {
    const storageKey = this.getStorageKey(identity);
    let candidate: unknown;
    try {
      candidate = await get<unknown>(storageKey, attachmentCleanupStore);
    } catch {
      candidate = undefined;
    }

    if (this.isOwnerScopedRecord(candidate) && this.matches(candidate, identity)) {
      return candidate;
    }
    if (candidate !== undefined) await this.removeStorageKeySafely(storageKey);
    return this.loadFallbackRecord(identity);
  }

  private async loadStoredEntries(): Promise<Array<[IDBValidKey, unknown]>> {
    try {
      return await entries<IDBValidKey, unknown>(attachmentCleanupStore);
    } catch {
      return [];
    }
  }

  private saveFallbackRecord(record: PendingAttachmentCleanupRecord): void {
    if (typeof localStorage === 'undefined') {
      throw new Error('Attachment cleanup fallback storage is unavailable');
    }
    localStorage.setItem(this.getFallbackKey(record), JSON.stringify(record));
  }

  private loadFallbackRecord(
    identity: PendingAttachmentCleanupIdentity,
  ): PendingAttachmentCleanupRecord | null {
    if (typeof localStorage === 'undefined') return null;
    return this.loadFallbackRecordAtKey(this.getFallbackKey(identity), identity);
  }

  private loadFallbackRecordAtKey(
    storageKey: string,
    identity?: PendingAttachmentCleanupIdentity,
  ): PendingAttachmentCleanupRecord | null {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const candidate = JSON.parse(raw) as unknown;
      if (!this.isOwnerScopedRecord(candidate)) {
        localStorage.removeItem(storageKey);
        return null;
      }
      if (storageKey !== this.getFallbackKey(candidate) || (identity && !this.matches(candidate, identity))) {
        localStorage.removeItem(storageKey);
        return null;
      }
      return candidate;
    } catch {
      this.removeFallbackKey(storageKey);
      return null; // eslint-disable-line no-restricted-syntax -- malformed fallback data is quarantined
    }
  }

  private loadAllFallbackRecords(): PendingAttachmentCleanupRecord[] {
    if (typeof localStorage === 'undefined') return [];
    const records: PendingAttachmentCleanupRecord[] = [];
    for (const storageKey of this.listFallbackKeys()) {
      if (!storageKey.startsWith(FALLBACK_KEY_PREFIX)) {
        this.removeFallbackKey(storageKey);
        continue;
      }
      const record = this.loadFallbackRecordAtKey(storageKey);
      if (record) records.push(record);
    }
    return records;
  }

  private removeFallbackRecord(identity: PendingAttachmentCleanupIdentity): void {
    this.removeFallbackKey(this.getFallbackKey(identity));
  }

  private removeFallbackKey(storageKey: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Unavailable fallback storage is already excluded from replay.
    }
  }

  private clearFallbackRecords(): void {
    for (const storageKey of this.listFallbackKeys()) {
      this.removeFallbackKey(storageKey);
    }
  }

  private listFallbackKeys(): string[] {
    if (typeof localStorage === 'undefined') return [];
    const keys: string[] = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(LEGACY_FALLBACK_KEY_PREFIX)) keys.push(key);
      }
    } catch {
      return [];
    }
    return keys;
  }

  private async clearLegacyRecordForPath(path: string): Promise<void> {
    await this.removeStorageKeySafely(path);
    this.removeFallbackKey(`${LEGACY_FALLBACK_KEY_PREFIX}${path}`);
  }

  private async removeStorageKeySafely(storageKey: IDBValidKey): Promise<void> {
    try {
      await del(storageKey, attachmentCleanupStore);
    } catch {
      // Invalid or unavailable legacy storage is already excluded from reads.
    }
  }

  private getStorageKey(identity: PendingAttachmentCleanupIdentity): string {
    return `${STORE_KEY_VERSION}:${JSON.stringify([
      identity.ownerUserId,
      identity.path,
      identity.operationId,
    ])}`;
  }

  private getFallbackKey(identity: PendingAttachmentCleanupIdentity): string {
    return `${FALLBACK_KEY_PREFIX}${encodeURIComponent(this.getStorageKey(identity))}`;
  }

  private normalizePaths(paths: string[]): string[] {
    return Array.from(new Set(paths.map(path => path.trim()).filter(path => path.length > 0)));
  }

  private isOwnerScopedRecord(candidate: unknown): candidate is PendingAttachmentCleanupRecord {
    if (!candidate || typeof candidate !== 'object') return false;
    const record = candidate as Partial<PendingAttachmentCleanupRecord>;
    return this.hasIdentity(record)
      && this.pathBelongsToOwner(record.path, record.ownerUserId)
      && this.isNonEmptyString(record.createdAt)
      && this.isNonEmptyString(record.updatedAt)
      && typeof record.attemptCount === 'number'
      && Number.isFinite(record.attemptCount)
      && record.attemptCount >= 0
      && (record.lastError === undefined || typeof record.lastError === 'string');
  }

  private matches(
    left: PendingAttachmentCleanupIdentity,
    right: PendingAttachmentCleanupIdentity,
  ): boolean {
    return left.ownerUserId === right.ownerUserId
      && left.path === right.path
      && left.operationId === right.operationId;
  }

  private hasIdentity<T extends Partial<PendingAttachmentCleanupIdentity>>(
    candidate: T,
  ): candidate is T & PendingAttachmentCleanupIdentity {
    return this.isNonEmptyString(candidate.ownerUserId)
      && this.isNonEmptyString(candidate.path)
      && this.isNonEmptyString(candidate.operationId);
  }

  private requireOwnerUserId(ownerUserId: string): void {
    if (!this.isNonEmptyString(ownerUserId)) {
      throw new Error('Attachment cleanup outbox requires ownerUserId');
    }
  }

  private requireOperationId(operationId: string): void {
    if (!this.isNonEmptyString(operationId)) {
      throw new Error('Attachment cleanup outbox requires a non-empty operationId');
    }
  }

  private requireOwnedPaths(paths: string[], ownerUserId: string): void {
    if (paths.some(path => !this.pathBelongsToOwner(path, ownerUserId))) {
      throw new Error('Attachment cleanup path owner does not match ownerUserId');
    }
  }

  private pathBelongsToOwner(path: string, ownerUserId: string): boolean {
    return path.split('/', 1)[0] === ownerUserId;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private isFlushCurrent(context: AttachmentCleanupFlushContext): boolean {
    return !this.destroyed && context.generation === this.runtimeGeneration;
  }

  private invalidateRuntime(): void {
    this.runtimeGeneration += 1;
    this.flushPendingCleanupsByOwner.clear();
  }

  private buildUnavailableOwnerResult(): AttachmentCleanupFlushResult {
    return {
      ok: false,
      deletedCount: 0,
      remainingCount: 0,
      errors: ['Attachment cleanup owner unavailable'],
    };
  }

  private buildCancelledResult(remainingCount: number): AttachmentCleanupFlushResult {
    return this.buildSuccessResult(0, remainingCount);
  }

  private buildSuccessResult(
    deletedCount: number,
    remainingCount: number,
  ): AttachmentCleanupFlushResult {
    return { ok: true, deletedCount, remainingCount, errors: [] };
  }
}
