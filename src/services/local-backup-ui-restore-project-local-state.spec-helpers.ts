import { TestBed } from '@angular/core/testing';
import { del as deleteKeyvalValue, set as setKeyvalValue } from 'idb-keyval';
import { expect, it, vi } from 'vitest';

import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { deleteRawIndexedDbDatabase } from '../app/core/state/persistence/backup-transaction.helpers';
import { FOCUS_CONFIG } from '../config/focus.config';
import { PARKING_CONFIG } from '../config/parking.config';
import { ProjectDataService, RetryQueueService } from '../core-bridge';
import type { Project } from '../models';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { BackupDataSafetyMetadataRestoreService } from './backup-data-safety-metadata-restore.service';
import { ConflictStorageService } from './conflict-storage.service';
import {
  readLocalStateRestoreSnapshot,
  restoreOfflineProjectRestoreSnapshot,
} from './data-safety-indexeddb-local-state';
import { ImportService } from './import.service';
import { LocalBackupUiBlackBoxRestoreService } from './local-backup-ui-black-box-restore.service';
import type { LocalBackupUiRestoreStageOperationContext } from './local-backup-ui-restore-stage-protocol';
import { LocalBackupUiRestoreStageService } from './local-backup-ui-restore-stage.service';
import type { LocalBackupUiRestoreMarker } from './local-backup-ui-restore-types';
import { ProjectStateService } from './project-state.service';
import { QueueBackupService } from './queue-backup.service';

const OWNER_USER_ID = 'restore-owner';
const DOCK_SNAPSHOT_IDB_KEY = `nanoflow.focus-session.v5.${OWNER_USER_ID}`;
const DOCK_LOCAL_STORAGE_KEY = `${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.${OWNER_USER_ID}`;
const LAUNCH_SNAPSHOT_STORAGE_KEY_V1 = 'nanoflow.launch-snapshot.v1';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V2 = 'nanoflow.launch-snapshot.v2';
const PARKED_CURSOR_KEY = `parking_last_sync_time:${encodeURIComponent(OWNER_USER_ID)}`;

export interface LocalBackupUiRestoreProjectLocalStateSpecContext {
  makeContext(
    marker?: LocalBackupUiRestoreMarker,
  ): LocalBackupUiRestoreStageOperationContext;
}

export function registerLocalBackupUiRestoreProjectLocalStateSpecs(
  context: LocalBackupUiRestoreProjectLocalStateSpecContext,
): void {
  it('applies and rolls back dock, launch, and parked-task local state through the existing projects stage', async () => {
    await cleanupProjectsStageLocalState();
    const previousProject = makeProjectGraph('project-1', 'Previous', 'previous content');
    const restoredProject = makeProjectGraph('project-1', 'Restored', 'restored content');
    const previousDock = makeDockSnapshotRaw('2026-07-27T00:01:00.000Z', 'dock-old');
    const restoredDock = makeDockSnapshotRaw('2026-07-27T00:02:00.000Z', 'dock-new');
    const previousLaunch = makeLaunchSnapshotRaw('2026-07-27T00:01:00.000Z', 'project-1');
    const restoredLaunch = makeLaunchSnapshotRaw('2026-07-27T00:02:00.000Z', 'project-1');
    const previousParked = makeParkedTaskCacheSnapshot('parked-old');
    const restoredParked = makeParkedTaskCacheSnapshot('parked-new');
    const previousOfflineSnapshot = makeOfflineSnapshotValue('offline-before');
    const restoredOfflineSnapshot = makeOfflineSnapshotValue('offline-after');
    await seedProjectsStageLocalState({
      dock: previousDock,
      launch: previousLaunch,
      parked: previousParked,
      offlineSnapshot: previousOfflineSnapshot,
    });

    const projectState = createMutableProjectState(previousProject);
    const externalSourceCache = createMutableExternalSourceCache();
    const service = makeProjectStageService({
      importService: {
        prepareLocalBackupRestorePlan: vi.fn(async () => ({
          importedCount: 1,
          projects: [restoredProject],
          externalSourceLinks: [],
        })),
      },
      projectState,
      projectData: {
        saveOfflineSnapshotAndWait: vi.fn(async () => {
          await restoreOfflineProjectRestoreSnapshot(OWNER_USER_ID, {
            scopedLocalStorageValue: restoredOfflineSnapshot,
            scopedIndexedDbRecord: null,
          });
        }),
      },
      externalSourceCache,
    });
    const marker = makeProjectsMarker(
      previousProject,
      previousDock,
      previousLaunch,
      previousParked,
      previousOfflineSnapshot,
    );
    const actionQueueRestore = {
      confirmPrepared: vi.fn(async () => 0),
      rollback: vi.fn(async () => undefined),
    };
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup: {
        localState: {
          offlineSnapshot: { localStorage: restoredOfflineSnapshot, indexedDb: null },
          dockSnapshot: {
            localStorage: restoredDock.localStorage,
            indexedDb: restoredDock.indexedDb,
          },
          launchSnapshot: {
            v1: restoredLaunch.v1,
            v2: restoredLaunch.v2,
          },
          parkedTaskCache: {
            entries: restoredParked.entries,
            syncMetadata: restoredParked.syncMetadata,
          },
        },
      } as never,
      existingProjects: [previousProject],
      actionQueueRestore,
    });
    const operationContext = context.makeContext(marker);
    operations.decodePreImage(marker);

    try {
      await operations.apply('projects', operationContext);

      await expect(readLocalStateRestoreSnapshot(OWNER_USER_ID)).resolves.toMatchObject({
        dockSnapshotRestoreSnapshot: {
          present: true,
          localStorage: restoredDock.localStorage,
          indexedDb: restoredDock.indexedDb,
        },
        launchSnapshotRestoreSnapshot: {
          present: true,
          v1: restoredLaunch.v1,
          v2: restoredLaunch.v2,
        },
        parkedTaskCacheRestoreSnapshot: {
          present: true,
          entries: restoredParked.entries,
          syncMetadata: restoredParked.syncMetadata,
        },
      });

      await operations.rollback('projects', operationContext);

      await expect(readLocalStateRestoreSnapshot(OWNER_USER_ID)).resolves.toMatchObject({
        dockSnapshotRestoreSnapshot: {
          present: true,
          localStorage: previousDock.localStorage,
          indexedDb: previousDock.indexedDb,
        },
        launchSnapshotRestoreSnapshot: {
          present: true,
          v1: previousLaunch.v1,
          v2: previousLaunch.v2,
        },
        parkedTaskCacheRestoreSnapshot: {
          present: true,
          entries: previousParked.entries,
          syncMetadata: previousParked.syncMetadata,
        },
      });
    } finally {
      await cleanupProjectsStageLocalState();
      TestBed.resetTestingModule();
    }
  });
}

async function cleanupProjectsStageLocalState(): Promise<void> {
  localStorage.removeItem(DOCK_LOCAL_STORAGE_KEY);
  localStorage.removeItem(LAUNCH_SNAPSHOT_STORAGE_KEY_V1);
  localStorage.removeItem(LAUNCH_SNAPSHOT_STORAGE_KEY_V2);
  await deleteKeyvalValue(DOCK_SNAPSHOT_IDB_KEY).catch(() => undefined);
  await clearProjectsStageFocusModeDb().catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-offline-snapshots').catch(() => undefined);
}

function makeProjectGraph(id: string, name: string, content: string): Project {
  return {
    id,
    name,
    description: '',
    createdDate: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:01:00.000Z',
    version: 1,
    tasks: [{
      id: `${id}-task-1`,
      title: `${name} task`,
      content,
      stage: 1,
      parentId: null,
      order: 0,
      rank: 100,
      status: 'active',
      displayId: 'task-1',
      x: 0,
      y: 0,
      createdDate: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:01:00.000Z',
    }],
    connections: [],
  } as Project;
}

function makeDockSnapshotRaw(savedAt: string, taskId: string): {
  localStorage: string;
  indexedDb: Record<string, unknown>;
} {
  const indexedDb = {
    version: 7,
    savedAt,
    entries: [{ taskId }],
  };
  return {
    localStorage: JSON.stringify(indexedDb),
    indexedDb,
  };
}

function makeLaunchSnapshotRaw(savedAt: string, activeProjectId: string): {
  v1: string;
  v2: string;
} {
  return {
    v1: JSON.stringify({
      version: 1,
      userId: OWNER_USER_ID,
      savedAt,
      activeProjectId,
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'light',
      projects: [],
    }),
    v2: JSON.stringify({
      version: 2,
      userId: OWNER_USER_ID,
      savedAt,
      activeProjectId,
      lastActiveView: 'text',
      preferredView: 'text',
      resolvedLaunchView: 'text',
      routeIntent: { kind: 'project', projectId: activeProjectId, taskId: null },
      mobileDegraded: false,
      degradeReason: null,
      theme: 'default',
      colorMode: 'light',
      projects: [],
      currentProject: null,
    }),
  };
}

function makeParkedTaskCacheSnapshot(taskId: string): {
  entries: Array<Record<string, unknown>>;
  syncMetadata: Record<string, unknown>;
} {
  return {
    entries: [{
      ownerUserId: OWNER_USER_ID,
      taskId: `${encodeURIComponent(OWNER_USER_ID)}:${taskId}`,
      projectId: 'project-1',
      task: {
        id: taskId,
        title: `Parked ${taskId}`,
        content: `content:${taskId}`,
        stage: 1,
        parentId: null,
        order: 0,
        rank: 100,
        status: 'active',
        displayId: taskId,
        x: 0,
        y: 0,
        createdDate: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:01:00.000Z',
      },
      updatedAt: '2026-07-27T00:01:00.000Z',
    }],
    syncMetadata: {
      [PARKED_CURSOR_KEY]: '2026-07-27T00:01:00.000Z',
    },
  };
}

function makeOfflineSnapshotValue(marker: string): string {
  return JSON.stringify({ ownerUserId: OWNER_USER_ID, marker });
}

async function seedProjectsStageLocalState(input: {
  dock: { localStorage: string; indexedDb: Record<string, unknown> };
  launch: { v1: string; v2: string };
  parked: { entries: Array<Record<string, unknown>>; syncMetadata: Record<string, unknown> };
  offlineSnapshot: string;
}): Promise<void> {
  localStorage.setItem(DOCK_LOCAL_STORAGE_KEY, input.dock.localStorage);
  await setKeyvalValue(DOCK_SNAPSHOT_IDB_KEY, input.dock.indexedDb);
  localStorage.setItem(LAUNCH_SNAPSHOT_STORAGE_KEY_V1, input.launch.v1);
  localStorage.setItem(LAUNCH_SNAPSHOT_STORAGE_KEY_V2, input.launch.v2);
  await seedParkedTaskCacheSnapshot(input.parked.entries, input.parked.syncMetadata);
  await restoreOfflineProjectRestoreSnapshot(OWNER_USER_ID, {
    scopedLocalStorageValue: input.offlineSnapshot,
    scopedIndexedDbRecord: null,
  });
}

async function seedParkedTaskCacheSnapshot(
  entries: Array<Record<string, unknown>>,
  syncMetadata: Record<string, unknown>,
): Promise<void> {
  const db = await openProjectsStageFocusModeDb();
  try {
    const tx = db.transaction([
      FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
      FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
    ], 'readwrite');
    const parkedStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS);
    const metadataStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA);
    parkedStore.clear();
    metadataStore.clear();
    for (const entry of entries) parkedStore.put(entry);
    for (const [key, value] of Object.entries(syncMetadata)) {
      metadataStore.put({ key, value });
    }
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

async function clearProjectsStageFocusModeDb(): Promise<void> {
  const db = await openProjectsStageFocusModeDb();
  try {
    const tx = db.transaction([
      FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
      FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
    ], 'readwrite');
    tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS).clear();
    tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA).clear();
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('focus mode transaction aborted'));
  });
}

function openProjectsStageFocusModeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FOCUS_CONFIG.SYNC.IDB_NAME, FOCUS_CONFIG.SYNC.IDB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
      }
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function createMutableProjectState(initialProject: Project): {
  getProjectsWithCurrentData: () => Project[];
  updateProjects: (updater: () => Project[]) => void;
  replaceProjectsForRestore: (ownerUserId: string, projects: Project[]) => void;
} {
  let projects = [structuredClone(initialProject)];
  return {
    getProjectsWithCurrentData: () => projects,
    updateProjects: updater => {
      projects = updater();
    },
    replaceProjectsForRestore: (_ownerUserId, nextProjects) => {
      projects = nextProjects;
    },
  };
}

function createMutableExternalSourceCache(): {
  loadLinks: ReturnType<typeof vi.fn>;
  loadPendingLinks: ReturnType<typeof vi.fn>;
  saveLinks: ReturnType<typeof vi.fn>;
  replacePendingLinksForOwner: ReturnType<typeof vi.fn>;
} {
  let links: unknown[] = [];
  let pendingLinks: unknown[] = [];
  return {
    loadLinks: vi.fn(async () => links),
    loadPendingLinks: vi.fn(async () => pendingLinks),
    saveLinks: vi.fn(async (next: unknown[]) => {
      links = next;
    }),
    replacePendingLinksForOwner: vi.fn(async (next: unknown[]) => {
      pendingLinks = next;
    }),
  };
}

function makeProjectStageService(dependencies: {
  importService: { prepareLocalBackupRestorePlan: ReturnType<typeof vi.fn> };
  projectState: {
    getProjectsWithCurrentData: () => Project[];
    updateProjects: (updater: () => Project[]) => void;
    replaceProjectsForRestore: (ownerUserId: string, projects: Project[]) => void;
  };
  projectData: { saveOfflineSnapshotAndWait: ReturnType<typeof vi.fn> };
  externalSourceCache: {
    loadLinks: ReturnType<typeof vi.fn>;
    loadPendingLinks: ReturnType<typeof vi.fn>;
    saveLinks: ReturnType<typeof vi.fn>;
    replacePendingLinksForOwner: ReturnType<typeof vi.fn>;
  };
}): LocalBackupUiRestoreStageService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      LocalBackupUiRestoreStageService,
      { provide: ImportService, useValue: dependencies.importService },
      { provide: ProjectStateService, useValue: dependencies.projectState },
      { provide: ProjectDataService, useValue: dependencies.projectData },
      { provide: ExternalSourceCacheService, useValue: dependencies.externalSourceCache },
      { provide: AttachmentUploadOutboxService, useValue: {} },
      { provide: QueueBackupService, useValue: {} },
      {
        provide: RetryQueueService,
        useValue: {
          MAX_RETRIES: Number.MAX_SAFE_INTEGER,
          restoreFromBackupItems: vi.fn(async () => 0),
        },
      },
      { provide: ActionQueueStorageService, useValue: {} },
      { provide: ConflictStorageService, useValue: {} },
      { provide: BackupDataSafetyMetadataRestoreService, useValue: {} },
      {
        provide: LocalBackupUiBlackBoxRestoreService,
        useValue: {
          decode: (value: unknown) => value,
          apply: vi.fn(async () => 0),
          read: vi.fn(async () => []),
          rollback: vi.fn(async () => undefined),
        },
      },
    ],
  });
  return TestBed.inject(LocalBackupUiRestoreStageService);
}

function makeProjectsMarker(
  project: Project,
  dock: { localStorage: string; indexedDb: Record<string, unknown> },
  launch: { v1: string; v2: string },
  parked: { entries: Array<Record<string, unknown>>; syncMetadata: Record<string, unknown> },
  offlineSnapshot = makeOfflineSnapshotValue('offline-before'),
): LocalBackupUiRestoreMarker {
  const restoreRunId = '11111111-1111-4111-8111-111111111111';
  return {
    schemaVersion: 2,
    ownerUserId: OWNER_USER_ID,
    runId: restoreRunId,
    restoreRunId,
    actionQueueRestoreIdentity: {
      ownerUserId: OWNER_USER_ID,
      restoreRunId,
      participant: 'action-queue' as const,
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      token: '22222222-2222-4222-8222-222222222222',
      recordId: `queue-backup:${OWNER_USER_ID}`,
      identityDigest: `sha256:${'b'.repeat(64)}`,
      receiptId: `queue-backup-personal-restore-receipt:v2:${'b'.repeat(64)}`,
    },
    createdAt: '2026-07-27T00:00:00.000Z',
    leaseExpiresAt: '2099-07-27T00:00:00.000Z',
    state: 'restoring',
    phase: 'projects',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'backup.json', checksum: 'sha256' },
    touchedProjectIds: [project.id],
    preImage: {
      projectState: {
        schemaVersion: 1,
        projects: [{ projectId: project.id, existed: true, project }],
        externalSourceLinks: [],
        externalSourcePendingLinks: [],
        offlineSnapshot: {
          scopedLocalStorageValue: offlineSnapshot,
          scopedIndexedDbRecord: null,
        },
        dockSnapshot: {
          present: true,
          localStorage: dock.localStorage,
          indexedDb: dock.indexedDb,
        },
        launchSnapshot: {
          present: true,
          v1: launch.v1,
          v2: launch.v2,
        },
        parkedTaskCache: {
          present: true,
          entries: parked.entries,
          syncMetadata: parked.syncMetadata,
        },
      } as unknown as LocalBackupUiRestoreMarker['preImage']['projectState'],
      blackBox: {
        schemaVersion: 1,
        ownerUserId: OWNER_USER_ID,
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        before: [],
        target: [],
      },
      attachmentOutbox: [],
      actionQueue: { indexedDb: null, localStorage: null },
      retryQueue: {
        schemaVersion: 2,
        indexedDb: null,
        localStorage: null,
        restoredItems: [],
      },
      deadLetters: { indexedDb: null, localStorage: null },
      conflicts: { indexedDbRecords: null, fallbackLocalStorageEntries: {} },
      metadata: {
        projectCursors: [],
        lastSyncTime: null,
        replayLog: [],
        lastWriteExplain: null,
        taskTombstones: {},
        connectionTombstones: [],
      },
    },
    rollbackErrors: [],
  };
}
