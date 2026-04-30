/**
 * Sync cursor persistence.
 *
 * Data cursors are distinct from the UI "last sync" timestamp. They are only
 * committed after remote rows have been merged and the local snapshot has been
 * durably written.
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { nowISO } from '../../../../utils/date';
import { DB_CONFIG, IndexedDBService } from './indexeddb.service';

export type ProjectSyncCursorEntityType = 'project' | 'task' | 'connection';

export interface ProjectSyncCursor {
  updatedAt: string;
  entityType: ProjectSyncCursorEntityType;
  id: string;
}

interface ProjectSyncCursorRecord {
  key: string;
  scope: 'project';
  userId: string | null;
  projectId: string;
  cursor: ProjectSyncCursor;
  committedAt: string;
}

const UNKNOWN_USER_SCOPE = 'anonymous';

export function compareProjectSyncCursor(left: ProjectSyncCursor, right: ProjectSyncCursor): number {
  const leftTime = new Date(left.updatedAt).getTime();
  const rightTime = new Date(right.updatedAt).getTime();
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const entityRank = (type: ProjectSyncCursorEntityType): number => {
    if (type === 'project') return 0;
    if (type === 'task') return 1;
    return 2;
  };
  const rankDelta = entityRank(left.entityType) - entityRank(right.entityType);
  if (rankDelta !== 0) return rankDelta;
  return left.id.localeCompare(right.id);
}

export function isProjectSyncCursor(value: unknown): value is ProjectSyncCursor {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['updatedAt'] === 'string'
    && typeof record['id'] === 'string'
    && (record['entityType'] === 'project' || record['entityType'] === 'task' || record['entityType'] === 'connection');
}

export function projectCursorFromLegacyTimestamp(timestamp: string): ProjectSyncCursor | null {
  const timestampMs = new Date(timestamp).getTime();
  if (!Number.isFinite(timestampMs)) return null;
  return {
    updatedAt: timestamp,
    entityType: 'project',
    id: '',
  };
}

@Injectable({ providedIn: 'root' })
export class SyncCursorPersistenceService {
  private readonly indexedDB = inject(IndexedDBService);
  private readonly logger = inject(LoggerService).category('SyncCursorPersistence');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  async loadProjectCursor(projectId: string, userId: string | null): Promise<ProjectSyncCursor | null> {
    try {
      const db = await this.indexedDB.initDatabase();
      const record = await this.indexedDB.getFromStore<ProjectSyncCursorRecord>(
        db,
        DB_CONFIG.stores.syncCursors,
        this.projectKey(projectId, userId),
      );
      return record?.cursor && isProjectSyncCursor(record.cursor) ? record.cursor : null;
    } catch (error) {
      this.logger.warn('读取项目同步游标失败，降级为内存游标', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sentryLazyLoader.captureException(error, {
        tags: { operation: 'loadProjectCursor', projectId },
      });
      // eslint-disable-next-line no-restricted-syntax -- IndexedDB cursor read failure falls back to the in-memory cursor path.
      return null;
    }
  }

  async commitProjectCursor(
    projectId: string,
    userId: string | null,
    cursor: ProjectSyncCursor,
  ): Promise<ProjectSyncCursor> {
    const cursorMs = new Date(cursor.updatedAt).getTime();
    if (!Number.isFinite(cursorMs)) {
      throw new Error(`Invalid project sync cursor timestamp: ${cursor.updatedAt}`);
    }

    const db = await this.indexedDB.initDatabase();
    const key = this.projectKey(projectId, userId);

    return new Promise<ProjectSyncCursor>((resolve, reject) => {
      const transaction = db.transaction(DB_CONFIG.stores.syncCursors, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.syncCursors);
      let committedCursor: ProjectSyncCursor = cursor;

      transaction.oncomplete = () => resolve(committedCursor);
      transaction.onerror = () => reject(transaction.error ?? new Error('Failed to commit project sync cursor'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Project sync cursor commit aborted'));

      const getRequest = store.get(key) as IDBRequest<ProjectSyncCursorRecord | undefined>;
      getRequest.onsuccess = () => {
        const existing = getRequest.result?.cursor;
        if (existing && isProjectSyncCursor(existing) && compareProjectSyncCursor(cursor, existing) < 0) {
          this.logger.debug('忽略旧项目同步游标', { projectId, existing, candidate: cursor });
          committedCursor = existing;
          return;
        }

        const record: ProjectSyncCursorRecord = {
          key,
          scope: 'project',
          userId,
          projectId,
          cursor,
          committedAt: nowISO(),
        };

        store.put(record);
      };
      getRequest.onerror = () => reject(getRequest.error ?? new Error('Failed to read project sync cursor'));
    });
  }

  async clearProjectCursor(projectId: string, userId: string | null): Promise<void> {
    try {
      const db = await this.indexedDB.initDatabase();
      await this.indexedDB.deleteFromStore(db, DB_CONFIG.stores.syncCursors, this.projectKey(projectId, userId));
    } catch (error) {
      this.logger.warn('清理项目同步游标失败', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private projectKey(projectId: string, userId: string | null): string {
    return `project:${userId || UNKNOWN_USER_SCOPE}:${projectId}`;
  }
}
