import { vi } from 'vitest';

export { Injector } from '@angular/core';
export { afterEach, beforeEach, describe, expect, it } from 'vitest';
export { vi };
export { ProjectDataService, PROJECT_BATCH_RPC_PROBE_GRACE_MS } from './project-data.service';
export { ProjectOfflineSnapshotService } from './project-offline-snapshot.service';
export { ProjectParkedTasksDataService } from './project-parked-tasks-data.service';
export { ProjectSyncProbeService } from './project-sync-probe.service';
export { ProjectCloudListService } from './project-cloud-list.service';
export { ProjectDetailLoaderService } from './project-detail-loader.service';
export { ProjectTaskDataService } from './project-task-data.service';
export { SupabaseClientService } from '../../../../services/supabase-client.service';
export { AuthService } from '../../../../services/auth.service';
export { LoggerService } from '../../../../services/logger.service';
export { RequestThrottleService } from '../../../../services/request-throttle.service';
export { SyncStateService } from './sync-state.service';
export { TombstoneService } from './tombstone.service';
export { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
export { StartupPlaceholderStateService } from '../../../../services/startup-placeholder-state.service';
export { AUTH_CONFIG } from '../../../../config/auth.config';
export { TIMEOUT_CONFIG } from '../../../../config/timeout.config';
export { FIELD_SELECT_CONFIG } from '../../../../config/sync.config';
export { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
export { hasTaskContentMissingFromSource } from '../../../../utils/task-content-guard';
export { resetTaskSchemaCompatibilityForTests } from '../../../../utils/task-schema-compat';
export type { Project, Task } from '../../../../models';

export const OFFLINE_SNAPSHOT_DB_NAME = 'nanoflow-offline-snapshots';
export const OFFLINE_SNAPSHOT_STORE_NAME = 'snapshots';
export const OFFLINE_SNAPSHOT_RECORD_ID = 'offline-snapshot';
export const OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY = 'nanoflow.offline-cache-v2';

export function getOfflineSnapshotRecordId(ownerUserId?: string | null): string {
  return typeof ownerUserId === 'string' && ownerUserId.length > 0
    ? `${OFFLINE_SNAPSHOT_RECORD_ID}:${ownerUserId}`
    : OFFLINE_SNAPSHOT_RECORD_ID;
}

export function getOfflineSnapshotStorageKey(ownerUserId?: string | null): string {
  return typeof ownerUserId === 'string' && ownerUserId.length > 0
    ? `${OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY}.${ownerUserId}`
    : OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY;
}

export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

export function createProjectDataPagedQuery<Row>(responses: Array<{ data: Row[] | null; error: unknown }>) {
  const readPage = vi.fn(async () => responses.shift() ?? { data: [], error: null });
  const range = vi.fn(async () => readPage());
  const limit = vi.fn(async () => readPage());
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    gt: vi.fn(),
    or: vi.fn(),
    not: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    range,
    limit,
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.gt.mockReturnValue(query);
  query.or.mockReturnValue(query);
  query.not.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.order.mockReturnValue(query);

  return query;
}

export function createProjectDataRangeQuery<Row>(
  rows: Row[],
  ranges: Array<[number, number]> = [],
) {
  const resolveDefaultPage = () => Promise.resolve({ data: rows.slice(0, 1000), error: null });
  let limitFrom = 0;
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    gt: vi.fn(),
    or: vi.fn(),
    not: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(async (count: number) => {
      const from = limitFrom;
      const to = from + count - 1;
      ranges.push([from, to]);
      const data = rows.slice(from, to + 1);
      limitFrom += data.length;
      return { data, error: null };
    }),
    range: vi.fn(async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    }),
    then: (
      onfulfilled?: ((value: { data: Row[]; error: null }) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) => resolveDefaultPage().then(onfulfilled, onrejected),
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.gt.mockReturnValue(query);
  query.or.mockReturnValue(query);
  query.not.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.order.mockReturnValue(query);

  return query;
}

export async function writeOfflineSnapshotToIdb(payload: string, ownerUserId?: string | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).put({
        id: getOfflineSnapshotRecordId(ownerUserId),
        data: payload,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export async function readOfflineSnapshotFromIdb(ownerUserId?: string | null): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    try {
      const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
          db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readonly');
        const req = tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).get(getOfflineSnapshotRecordId(ownerUserId));
        req.onsuccess = () => {
          db.close();
          resolve(req.result?.data ?? null);
        };
        req.onerror = () => {
          db.close();
          resolve(null);
        };
        tx.onerror = () => {
          db.close();
          resolve(null);
        };
      };
    } catch {
      resolve(null);
    }
  });
}

export async function clearOfflineSnapshotIdb(ownerUserId?: string | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).delete(getOfflineSnapshotRecordId(ownerUserId));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export async function clearAllOfflineSnapshotsIdb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
