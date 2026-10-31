import { Injectable } from '@angular/core';
import { clear, createStore, get, set } from 'idb-keyval';

interface UserPreferencesBaselineRecord {
  userId: string;
  updatedAt: string;
}

const baselineStore = createStore(
  'nanoflow-user-preferences-sync',
  'confirmed-row-baselines',
);
const LOCAL_STORAGE_BASELINE_PREFIX = 'nanoflow.userPreferencesBaseline.';

@Injectable({ providedIn: 'root' })
export class UserPreferencesBaselineStore {
  async read(userId: string): Promise<string | null> {
    let indexedBaseline: string | null = null;
    try {
      indexedBaseline = this.readRecordUpdatedAt(
        await get<UserPreferencesBaselineRecord>(userId, baselineStore),
        userId,
      );
    } catch {
      // localStorage mirror remains the fallback when IndexedDB is unavailable.
    }

    return this.selectLatestBaseline(indexedBaseline, this.readLocalMirror(userId));
  }

  async save(userId: string, updatedAt: string): Promise<string> {
    const normalized = this.normalizeTimestamp(updatedAt);
    if (!normalized) {
      throw new Error('Invalid user preferences updated_at baseline');
    }

    const confirmedBaseline = this.selectLatestBaseline(await this.read(userId), normalized) ?? normalized;
    const record: UserPreferencesBaselineRecord = { userId, updatedAt: confirmedBaseline };
    try {
      await set(userId, record, baselineStore);
      this.tryWriteLocalMirror(record);
      return confirmedBaseline;
    } catch (error) {
      if (this.tryWriteLocalMirror(record)) {
        return confirmedBaseline;
      }
      throw error;
    }
  }

  async clearForTests(): Promise<void> {
    try {
      await clear(baselineStore);
    } finally {
      if (typeof localStorage === 'undefined') {
        return;
      }
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(LOCAL_STORAGE_BASELINE_PREFIX)) {
          localStorage.removeItem(key);
        }
      }
    }
  }

  private getLocalMirrorKey(userId: string): string {
    return `${LOCAL_STORAGE_BASELINE_PREFIX}${userId}`;
  }

  private tryWriteLocalMirror(record: UserPreferencesBaselineRecord): boolean {
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

  private readLocalMirror(userId: string): string | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const raw = localStorage.getItem(this.getLocalMirrorKey(userId));
      if (!raw) {
        return null;
      }
      return this.readRecordUpdatedAt(JSON.parse(raw) as unknown, userId);
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 损坏的镜像必须降级为空，IndexedDB 仍是主来源。
      return null;
    }
  }

  private readRecordUpdatedAt(value: unknown, expectedUserId: string): string | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const record = value as Partial<UserPreferencesBaselineRecord>;
    if (record.userId !== expectedUserId || typeof record.updatedAt !== 'string') {
      return null;
    }
    return this.normalizeTimestamp(record.updatedAt);
  }

  private selectLatestBaseline(...baselines: Array<string | null>): string | null {
    let latest: string | null = null;
    let latestTime = -Infinity;
    for (const baseline of baselines) {
      const normalized = this.normalizeTimestamp(baseline);
      if (!normalized) {
        continue;
      }
      const time = new Date(normalized).getTime();
      if (time > latestTime) {
        latest = normalized;
        latestTime = time;
      }
    }
    return latest;
  }

  private normalizeTimestamp(value: string | null): string | null {
    if (!value) {
      return null;
    }
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
}
