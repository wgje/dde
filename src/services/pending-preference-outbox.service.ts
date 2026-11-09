import { Injectable } from '@angular/core';
import { clear, createStore, del, get, update } from 'idb-keyval';
import type { UserPreferences } from '../models';

export interface PendingPreferenceRecord {
  userId: string;
  preferences: Partial<UserPreferences>;
  operationId: string;
  baseUpdatedAt?: string | null;
  updatedAt: string;
}

export type SavePendingPreferenceInput = Omit<PendingPreferenceRecord, 'updatedAt'> & {
  updatedAt?: string;
};

const pendingPreferenceStore = createStore(
  'nanoflow-pending-preference-outbox',
  'pending-preferences',
);

const LOCAL_STORAGE_PENDING_PREFIX = 'nanoflow.pendingPreferenceOutbox.';

@Injectable({ providedIn: 'root' })
export class PendingPreferenceOutboxService {
  async savePendingPreference(input: SavePendingPreferenceInput): Promise<PendingPreferenceRecord> {
    let record = this.buildPendingPreferenceRecord(input, null);

    try {
      await update<PendingPreferenceRecord | undefined>(
        input.userId,
        existing => {
          record = this.buildPendingPreferenceRecord(input, existing ?? null);
          return record;
        },
        pendingPreferenceStore,
      );
      this.tryWriteLocalMirror(record);
      return record;
    } catch (error) {
      record = this.buildPendingPreferenceRecord(input, this.readLocalMirror(input.userId));
      if (this.tryWriteLocalMirror(record)) {
        return record;
      }
      throw error;
    }
  }

  private buildPendingPreferenceRecord(
    input: SavePendingPreferenceInput,
    existing: PendingPreferenceRecord | null,
  ): PendingPreferenceRecord {
    return {
      userId: input.userId,
      preferences: {
        ...(existing?.preferences ?? {}),
        ...input.preferences,
      },
      operationId: input.operationId,
      baseUpdatedAt: input.baseUpdatedAt === undefined
        ? existing?.baseUpdatedAt
        : input.baseUpdatedAt,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    };
  }

  async readPendingPreference(userId: string): Promise<PendingPreferenceRecord | null> {
    let indexedRecord: PendingPreferenceRecord | null = null;
    try {
      const record = await get<PendingPreferenceRecord>(userId, pendingPreferenceStore);
      if (this.isPendingPreferenceRecord(record, userId)) {
        indexedRecord = record;
      }
    } catch {
      // localStorage mirror below is the recovery fallback when IndexedDB is unavailable.
    }

    return this.selectPreferredRecord(indexedRecord, this.readLocalMirror(userId));
  }

  async removePendingPreference(userId: string): Promise<void> {
    await del(userId, pendingPreferenceStore);
    this.removeLocalMirror(userId);
  }

  async clearPendingPreferencesForTests(): Promise<void> {
    try {
      await clear(pendingPreferenceStore);
    } finally {
      this.clearLocalMirrors();
    }
  }

  private getLocalMirrorKey(userId: string): string {
    return `${LOCAL_STORAGE_PENDING_PREFIX}${userId}`;
  }

  private tryWriteLocalMirror(record: PendingPreferenceRecord): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    try {
      localStorage.setItem(this.getLocalMirrorKey(record.userId), JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  private readLocalMirror(userId: string): PendingPreferenceRecord | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    try {
      const raw = localStorage.getItem(this.getLocalMirrorKey(userId));
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as unknown;
      return this.isPendingPreferenceRecord(parsed, userId) ? parsed : null;
    } catch {
      // Invalid localStorage mirrors are ignored; IndexedDB remains the source of truth.
    }

    return null;
  }

  private selectPreferredRecord(
    indexedRecord: PendingPreferenceRecord | null,
    localMirrorRecord: PendingPreferenceRecord | null,
  ): PendingPreferenceRecord | null {
    if (!indexedRecord) {
      return localMirrorRecord;
    }
    if (!localMirrorRecord) {
      return indexedRecord;
    }

    const indexedTime = new Date(indexedRecord.updatedAt).getTime();
    const mirrorTime = new Date(localMirrorRecord.updatedAt).getTime();
    if (Number.isFinite(indexedTime) && Number.isFinite(mirrorTime)) {
      return mirrorTime > indexedTime
        ? this.preserveFallbackBaseline(localMirrorRecord, indexedRecord)
        : this.preserveFallbackBaseline(indexedRecord, localMirrorRecord);
    }

    return this.preserveFallbackBaseline(indexedRecord, localMirrorRecord);
  }

  private preserveFallbackBaseline(
    preferred: PendingPreferenceRecord,
    fallback: PendingPreferenceRecord,
  ): PendingPreferenceRecord {
    if (preferred.baseUpdatedAt !== undefined) {
      return preferred;
    }
    return {
      ...preferred,
      baseUpdatedAt: fallback.baseUpdatedAt,
    };
  }

  private removeLocalMirror(userId: string): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    this.removeLocalMirrorKey(this.getLocalMirrorKey(userId));
  }

  private clearLocalMirrors(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LOCAL_STORAGE_PENDING_PREFIX)) {
        this.removeLocalMirrorKey(key);
      }
    }
  }

  private removeLocalMirrorKey(key: string): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        localStorage.removeItem(key);
        return;
      } catch {
        // IndexedDB remains the durable source of truth; local mirror cleanup is best-effort.
      }
    }
  }

  private isPendingPreferenceRecord(
    value: unknown,
    expectedUserId: string,
  ): value is PendingPreferenceRecord {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const record = value as Partial<PendingPreferenceRecord>;
    return record.userId === expectedUserId
      && typeof record.operationId === 'string'
      && record.operationId.length > 0
      && (
        record.baseUpdatedAt === undefined
        || record.baseUpdatedAt === null
        || typeof record.baseUpdatedAt === 'string'
      )
      && typeof record.updatedAt === 'string'
      && !!record.preferences
      && typeof record.preferences === 'object';
  }
}
