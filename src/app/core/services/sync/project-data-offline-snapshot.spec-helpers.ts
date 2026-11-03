import {
  AUTH_CONFIG,
  OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY,
  clearOfflineSnapshotIdb,
  describe,
  expect,
  getOfflineSnapshotStorageKey,
  it,
  ProjectDataService,
  ProjectOfflineSnapshotService,
  readOfflineSnapshotFromIdb,
  vi,
  writeOfflineSnapshotToIdb,
} from './project-data.service.spec-context';
import {
  createProjectDataOfflineSnapshotInjector,
  createProjectDataOfflineSnapshotService,
  createStartupOfflineSnapshotProjectDataService,
} from './project-data-offline-snapshot.spec-harness';
import { registerProjectDataOfflineSnapshotLoadSpecs } from './project-data-offline-snapshot-load.spec-helpers';
import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import {
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  readActiveLocalBackupUiRestoreWriters,
} from '../../../../services/local-backup-ui-restore-writer-quiescence-tracker';
import { localBackupUiRestoreWriterQuiescence } from '../../../../services/local-backup-ui-restore-writer-quiescence.service';

type SnapshotSaveOutcome =
  | { status: 'resolved' }
  | { status: 'rejected'; error: unknown }
  | { status: 'pending' };

type FakeOpenRequest = {
  result: IDBDatabase;
  error: DOMException | null;
  onerror: (() => void) | null;
  onsuccess: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
};

async function observeSnapshotSave(
  promise: Promise<void>,
  waitMs: number,
): Promise<SnapshotSaveOutcome> {
  return await Promise.race<SnapshotSaveOutcome>([
    promise.then(
      () => ({ status: 'resolved' }),
      error => ({ status: 'rejected', error }),
    ),
    new Promise(resolve => {
      setTimeout(() => resolve({ status: 'pending' }), waitMs);
    }),
  ]);
}

function createSnapshotProject(id: string): any[] {
  return [{
    id,
    name: `Project ${id}`,
    description: '',
    createdDate: '2026-03-31T00:00:00.000Z',
    tasks: [],
    connections: [],
  }];
}

function readDataSafetyAudit(ownerUserId: string) {
  return new DataSafetyAuditPersistence().load(ownerUserId);
}

function expectNoDataSafetyAudit(ownerUserId: string): void {
  const audit = readDataSafetyAudit(ownerUserId);
  expect(audit.replayLog).toHaveLength(0);
  expect(audit.lastWriteExplain).toBeNull();
}

function mockOfflineSnapshotStorageQuota(ownerUserId: string) {
  const snapshotStorageKey = getOfflineSnapshotStorageKey(ownerUserId);
  const originalSetItem = localStorage.setItem.bind(localStorage);
  return vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === snapshotStorageKey) {
      throw new DOMException('localStorage unavailable', 'QuotaExceededError');
    }
    originalSetItem(key, value);
  });
}

export function registerProjectDataOfflineSnapshotSpecs(): void {
  describe('offline snapshot owner isolation', () => {
      it('startup snapshot 应优先读取 IndexedDB 并返回元数据', async () => {
        const idbPayload = JSON.stringify({
          projects: [
            {
              id: 'idb-project',
              name: 'IDB Project',
              description: 'from idb',
              createdDate: '2026-03-26T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 7,
          savedAt: '2026-04-11T00:00:00.000Z',
          ownerUserId: 'user-1',
        });
        const localStoragePayload = JSON.stringify({
          projects: [
            {
              id: 'legacy-project',
              name: 'Legacy Project',
              description: 'from localStorage',
              createdDate: '2026-03-25T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 6,
          savedAt: '2026-04-10T00:00:00.000Z',
          ownerUserId: 'user-1',
        });

        localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), localStoragePayload);
        await writeOfflineSnapshotToIdb(idbPayload, 'user-1');

        const service = createStartupOfflineSnapshotProjectDataService();

        const snapshot = await service.loadStartupOfflineSnapshot();

        expect(snapshot.source).toBe('idb');
        expect(snapshot.projectCount).toBe(1);
        expect(snapshot.migratedLegacy).toBe(false);
        expect(snapshot.ownerUserId).toBe('user-1');
        expect(snapshot.bytes).toBeGreaterThan(0);
        expect(snapshot.projects).toHaveLength(1);
        expect((snapshot.projects[0] as { id?: string }).id).toBe('idb-project');
      }, 10000);

      it('startup snapshot 在 localStorage 更新时应优先恢复较新的 localStorage 快照', async () => {
        const idbPayload = JSON.stringify({
          projects: [
            {
              id: 'idb-project-old',
              name: 'IDB Project Old',
              description: 'older idb snapshot',
              createdDate: '2026-03-26T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 7,
          savedAt: '2026-04-10T00:00:00.000Z',
          ownerUserId: 'user-1',
        });
        const localStoragePayload = JSON.stringify({
          projects: [
            {
              id: 'local-storage-project-new',
              name: 'LocalStorage Project New',
              description: 'newer localStorage snapshot',
              createdDate: '2026-03-27T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 7,
          savedAt: '2026-04-11T00:00:00.000Z',
          ownerUserId: 'user-1',
        });

        localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), localStoragePayload);
        await writeOfflineSnapshotToIdb(idbPayload, 'user-1');

        const service = createStartupOfflineSnapshotProjectDataService();

        const snapshot = await service.loadStartupOfflineSnapshot();
        const migratedPayload = await readOfflineSnapshotFromIdb('user-1');

        expect(snapshot.source).toBe('localStorage');
        expect(snapshot.projectCount).toBe(1);
        expect((snapshot.projects[0] as { id?: string }).id).toBe('local-storage-project-new');
        expect(migratedPayload).toBe(localStoragePayload);
      }, 10000);

      it('startup snapshot 不应让较新但畸形的 localStorage mirror 遮蔽有效 IDB 快照', async () => {
        const idbPayload = JSON.stringify({
          projects: [
            {
              id: 'idb-valid-fallback',
              name: 'IDB Valid Fallback',
              description: '',
              createdDate: '2026-07-15T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 7,
          savedAt: '2026-07-15T01:00:00.000Z',
          ownerUserId: 'user-1',
        });
        const malformedNewerPayload = JSON.stringify({
          projects: [
            {
              id: 'local-storage-malformed-newer',
              name: 'Malformed Newer',
              description: '',
              createdDate: '2026-07-15T00:00:00.000Z',
              tasks: [{ id: 'partial-task', content: 'partial' }],
              connections: [],
            },
          ],
          version: 7,
          savedAt: '2026-07-15T02:00:00.000Z',
          ownerUserId: 'user-1',
        });

        localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), malformedNewerPayload);
        await writeOfflineSnapshotToIdb(idbPayload, 'user-1');

        const service = createStartupOfflineSnapshotProjectDataService();
        const snapshot = await service.loadStartupOfflineSnapshot();
        const persistedPayload = await readOfflineSnapshotFromIdb('user-1');

        expect(snapshot.source).toBe('idb');
        expect((snapshot.projects[0] as { id?: string }).id).toBe('idb-valid-fallback');
        expect(persistedPayload).toBe(idbPayload);
      }, 10000);

      it('startup snapshot 选择较新 localStorage 时若 owner 不匹配应回退到可见的 IndexedDB 快照', async () => {
        const idbPayload = JSON.stringify({
          projects: [
            {
              id: 'idb-visible-project',
              name: 'IDB Visible Project',
              description: 'visible idb snapshot',
              createdDate: '2026-03-26T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 7,
          savedAt: '2026-04-10T00:00:00.000Z',
          ownerUserId: 'user-1',
        });
        const localStoragePayload = JSON.stringify({
          projects: [
            {
              id: 'local-storage-foreign-project',
              name: 'LocalStorage Foreign Project',
              description: 'should not overwrite idb',
              createdDate: '2026-03-27T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 7,
          savedAt: '2026-04-11T00:00:00.000Z',
          ownerUserId: 'user-2',
        });

        localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), localStoragePayload);
        await writeOfflineSnapshotToIdb(idbPayload, 'user-1');

        const service = createStartupOfflineSnapshotProjectDataService({
          authService: {
            currentUserId: vi.fn(() => 'user-1'),
            peekPersistedSessionIdentity: vi.fn(() => null),
            peekPersistedOwnerHint: vi.fn(() => 'user-1'),
          },
        });

        const snapshot = await service.loadStartupOfflineSnapshot();
        const persistedPayload = await readOfflineSnapshotFromIdb('user-1');

        expect(snapshot.source).toBe('idb');
        expect((snapshot.projects[0] as { id?: string }).id).toBe('idb-visible-project');
        expect(persistedPayload).toBe(idbPayload);
      }, 10000);

      it('startup snapshot 仅有 legacy localStorage 时应回迁到 IndexedDB', async () => {
        const legacyPayload = JSON.stringify({
          projects: [
            {
              id: 'legacy-project',
              name: 'Legacy Project',
              description: 'from localStorage',
              createdDate: '2026-03-25T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ],
          version: 6,
        });

        localStorage.setItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY, legacyPayload);

        const service = createStartupOfflineSnapshotProjectDataService({
          authService: {
            currentUserId: vi.fn(() => null),
          },
        });

        const snapshot = await service.loadStartupOfflineSnapshot();
        const migratedPayload = await readOfflineSnapshotFromIdb(AUTH_CONFIG.LOCAL_MODE_USER_ID);

        expect(snapshot.source).toBe('localStorage');
        expect(snapshot.projectCount).toBe(1);
        expect(snapshot.migratedLegacy).toBe(true);
        expect(snapshot.ownerUserId).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
        expect(snapshot.bytes).toBeGreaterThan(0);
        expect(snapshot.projects).toHaveLength(1);
        expect((snapshot.projects[0] as { id?: string }).id).toBe('legacy-project');
        expect(migratedPayload).toBe(legacyPayload);
      }, 10000);

      it('saveOfflineSnapshot 应写入 ownerUserId，并在启动恢复时返回该元数据', async () => {
        localStorage.removeItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY);
        await clearOfflineSnapshotIdb();

        const service = createProjectDataOfflineSnapshotService({
          authService: {
            currentUserId: vi.fn(() => 'owner-user'),
          },
        });
        service.saveOfflineSnapshot([
          {
            id: 'owner-project',
            name: 'Owner Project',
            description: '',
            createdDate: '2026-03-31T00:00:00.000Z',
            tasks: [],
            connections: [],
          },
        ] as any);
        await new Promise(resolve => setTimeout(resolve, 0));

        const snapshot = await service.loadStartupOfflineSnapshot();

        expect(snapshot.ownerUserId).toBe('owner-user');
        expect(snapshot.projects).toHaveLength(1);
      }, 10000);

      it('saveOfflineSnapshot 在 currentUserId 为空但 confirmed session 已知时应写入真实 owner', async () => {
        localStorage.removeItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY);
        await clearOfflineSnapshotIdb();

        const service = createProjectDataOfflineSnapshotService({
          authService: {
            currentUserId: vi.fn(() => null),
            peekPersistedSessionIdentity: vi.fn(() => ({
              userId: 'confirmed-owner',
              email: 'confirmed@example.com',
            })),
          },
        });
        service.saveOfflineSnapshot([
          {
            id: 'confirmed-session-project',
            name: 'Confirmed Session Project',
            description: '',
            createdDate: '2026-03-31T00:00:00.000Z',
            tasks: [],
            connections: [],
          },
        ] as any);
        await new Promise(resolve => setTimeout(resolve, 0));

        const snapshot = await service.loadStartupOfflineSnapshot();
        expect(snapshot.ownerUserId).toBe('confirmed-owner');
      }, 10000);

      it('离线快照 writer 在 IndexedDB settle 前保持活动，prepare 会等待它完成', async () => {
        const ownerUserId = `snapshot-fence-${Date.now()}-${Math.random()}`;
        await clearOfflineSnapshotIdb(ownerUserId);
        localStorage.removeItem(getOfflineSnapshotStorageKey(ownerUserId));
        localStorage.removeItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId));

        const injector = createProjectDataOfflineSnapshotInjector({
          authService: { currentUserId: vi.fn(() => ownerUserId) },
        });
        const service = injector.get(ProjectDataService);
        const snapshotService = injector.get(ProjectOfflineSnapshotService) as unknown as {
          saveSnapshotToIDB(payload: string, owner: string): Promise<void>;
        };
        let releaseIdbWrite = (): void => undefined;
        let markIdbWriteStarted = (): void => undefined;
        const idbWriteStarted = new Promise<void>(resolve => {
          markIdbWriteStarted = resolve;
        });
        const heldIdbWrite = new Promise<void>(resolve => {
          releaseIdbWrite = resolve;
        });
        const saveSpy = vi.spyOn(snapshotService, 'saveSnapshotToIDB').mockImplementation(async () => {
          markIdbWriteStarted();
          await heldIdbWrite;
        });

        let prepareResolved = false;
        const save = service.saveOfflineSnapshotAndWait(createSnapshotProject('held-snapshot'), ownerUserId);
        const prepare = localBackupUiRestoreWriterQuiescence.prepare(ownerUserId).then(handle => {
          prepareResolved = true;
          return handle;
        });

        try {
          await idbWriteStarted;
          expect(readActiveLocalBackupUiRestoreWriters(ownerUserId)).toEqual(
            expect.arrayContaining([expect.objectContaining({ source: 'offline-snapshot' })]),
          );
          await new Promise(resolve => setTimeout(resolve, 30));
          expect(prepareResolved).toBe(false);

          releaseIdbWrite();
          await save;
          await prepare;
          expect(prepareResolved).toBe(true);
        } finally {
          releaseIdbWrite();
          await save.catch(() => undefined);
          const prepared = await prepare.catch(() => null);
          saveSpy.mockRestore();
          if (prepared) await prepared.abortBeforeMutation();
          else localStorage.removeItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId));
        }
      }, 10000);

      it('saveOfflineSnapshot retains a paused request and retries after quiescence clears', async () => {
        const ownerUserId = `snapshot-resume-${Date.now()}-${Math.random()}`;
        await clearOfflineSnapshotIdb(ownerUserId);
        localStorage.removeItem(getOfflineSnapshotStorageKey(ownerUserId));
        localStorage.removeItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId));
        const service = createProjectDataOfflineSnapshotService({
          authService: { currentUserId: vi.fn(() => ownerUserId) },
        });
        const prepared = await localBackupUiRestoreWriterQuiescence.prepare(ownerUserId);

        try {
          service.saveOfflineSnapshot(createSnapshotProject('deferred-snapshot'), ownerUserId);
          await new Promise(resolve => setTimeout(resolve, 20));
          expect(localStorage.getItem(getOfflineSnapshotStorageKey(ownerUserId))).toBeNull();
          expect(await readOfflineSnapshotFromIdb(ownerUserId)).toBeNull();

          await prepared.abortBeforeMutation();
          const deadline = Date.now() + 3000;
          let payload: string | null = null;
          while (Date.now() < deadline && payload === null) {
            payload = await readOfflineSnapshotFromIdb(ownerUserId);
            if (payload === null) await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect(payload).not.toBeNull();
          expect(JSON.parse(payload ?? '{}')).toEqual(expect.objectContaining({
            ownerUserId,
            projects: expect.arrayContaining([expect.objectContaining({ id: 'deferred-snapshot' })]),
          }));
        } finally {
          if (localStorage.getItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId)) !== null) {
            await prepared.abortBeforeMutation();
          }
        }
      }, 10000);

      it('does not replay a paused pre-restore snapshot over a newer restore snapshot', async () => {
        const ownerUserId = `snapshot-superseded-${Date.now()}-${Math.random()}`;
        await clearOfflineSnapshotIdb(ownerUserId);
        localStorage.removeItem(getOfflineSnapshotStorageKey(ownerUserId));
        localStorage.removeItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId));
        const service = createProjectDataOfflineSnapshotService({
          authService: { currentUserId: vi.fn(() => ownerUserId) },
        });
        const prepared = await localBackupUiRestoreWriterQuiescence.prepare(ownerUserId);

        try {
          service.saveOfflineSnapshot(createSnapshotProject('stale-snapshot'), ownerUserId);
          await new Promise(resolve => setTimeout(resolve, 20));
          await prepared.runMutationAsync('offline-snapshot', () => service.saveOfflineSnapshotAndWait(
            createSnapshotProject('restored-snapshot'),
            ownerUserId,
          ));
          await prepared.prepareFinalization('completed');
          await prepared.releaseFinalized();

          await new Promise(resolve => setTimeout(resolve, 180));
          const payload = await readOfflineSnapshotFromIdb(ownerUserId);
          expect(payload).not.toBeNull();
          expect(JSON.parse(payload ?? '{}')).toEqual(expect.objectContaining({
            ownerUserId,
            projects: expect.arrayContaining([expect.objectContaining({ id: 'restored-snapshot' })]),
          }));
          expect(JSON.parse(payload ?? '{}')).not.toEqual(expect.objectContaining({
            projects: expect.arrayContaining([expect.objectContaining({ id: 'stale-snapshot' })]),
          }));
        } finally {
          if (localStorage.getItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId)) !== null) {
            await prepared.abortBeforeMutation();
          }
        }
      }, 10000);

      it('saveOfflineSnapshotAndWait uses IndexedDB when only the snapshot storage key is over quota', async () => {
        const ownerUserId = `snapshot-quota-${Date.now()}-${Math.random()}`;
        await clearOfflineSnapshotIdb(ownerUserId);
        localStorage.removeItem(getOfflineSnapshotStorageKey(ownerUserId));
        const localStorageSetItemSpy = mockOfflineSnapshotStorageQuota(ownerUserId);
        const service = createProjectDataOfflineSnapshotService({
          authService: { currentUserId: vi.fn(() => ownerUserId) },
        });

        try {
          await service.saveOfflineSnapshotAndWait(createSnapshotProject('idb-quota-fallback'), ownerUserId);

          expect(localStorage.getItem(getOfflineSnapshotStorageKey(ownerUserId))).toBeNull();
          const payload = await readOfflineSnapshotFromIdb(ownerUserId);
          expect(payload).not.toBeNull();
          expect(JSON.parse(payload ?? '{}')).toEqual(expect.objectContaining({
            ownerUserId,
            projects: expect.arrayContaining([expect.objectContaining({ id: 'idb-quota-fallback' })]),
          }));
          expect(readDataSafetyAudit(ownerUserId).lastWriteExplain?.rpcResult).toEqual(
            expect.objectContaining({
              raw: expect.objectContaining({
                settlement: { localStorage: 'failed', indexedDB: 'saved' },
              }),
            }),
          );
        } finally {
          localStorageSetItemSpy.mockRestore();
          localStorage.removeItem(getOfflineSnapshotStorageKey(ownerUserId));
          await clearOfflineSnapshotIdb(ownerUserId);
        }
      }, 10000);

      it('saveOfflineSnapshot retains a request after writer lease quota failure and retries it', async () => {
        const ownerUserId = `snapshot-lease-retry-${Date.now()}-${Math.random()}`;
        const storageKey = getOfflineSnapshotStorageKey(ownerUserId);
        await clearOfflineSnapshotIdb(ownerUserId);
        localStorage.removeItem(storageKey);
        localStorage.removeItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId));
        const originalSetItem = localStorage.setItem.bind(localStorage);
        let failNextWrite = true;
        const localStorageSetItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
          if (failNextWrite) {
            failNextWrite = false;
            throw new DOMException('localStorage unavailable', 'QuotaExceededError');
          }
          originalSetItem(key, value);
        });
        const service = createProjectDataOfflineSnapshotService({
          authService: { currentUserId: vi.fn(() => ownerUserId) },
        });

        try {
          service.saveOfflineSnapshot(createSnapshotProject('lease-retry-snapshot'), ownerUserId);
          await new Promise(resolve => setTimeout(resolve, 0));
          expect(localStorage.getItem(storageKey)).toBeNull();
          expect(await readOfflineSnapshotFromIdb(ownerUserId)).toBeNull();

          localStorageSetItemSpy.mockRestore();
          const deadline = Date.now() + 3000;
          let payload: string | null = null;
          while (Date.now() < deadline && payload === null) {
            payload = await readOfflineSnapshotFromIdb(ownerUserId);
            if (payload === null) await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect(payload).not.toBeNull();
          expect(JSON.parse(payload ?? '{}')).toEqual(expect.objectContaining({
            ownerUserId,
            projects: expect.arrayContaining([expect.objectContaining({ id: 'lease-retry-snapshot' })]),
          }));
        } finally {
          localStorageSetItemSpy.mockRestore();
          localStorage.removeItem(storageKey);
          localStorage.removeItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId));
          await clearOfflineSnapshotIdb(ownerUserId);
        }
      }, 10000);

      it('saveOfflineSnapshotAndWait 成功替换 authoritative snapshot 时应记录 DataSafetyWriteAudit', async () => {
        localStorage.removeItem(getOfflineSnapshotStorageKey('audit-owner'));
        await clearOfflineSnapshotIdb('audit-owner');

        const service = createProjectDataOfflineSnapshotService({
          authService: {
            currentUserId: vi.fn(() => 'audit-owner'),
          },
        });

        await service.saveOfflineSnapshotAndWait(createSnapshotProject('audit-success'));

        const audit = readDataSafetyAudit('audit-owner');
        expect(audit.replayLog).toHaveLength(1);
        expect(audit.lastWriteExplain).toEqual(expect.objectContaining({
          operationId: expect.any(String),
          actor: { sourceUserId: 'audit-owner' },
          entity: {
            type: 'offline-snapshot',
            id: 'offline-snapshot:audit-owner',
          },
          operation: 'replace',
          queueResult: {
            enteredRetryQueue: false,
            retryCount: 0,
          },
          rpcResult: expect.objectContaining({
            status: 'applied',
            reason: 'offline-snapshot-settled',
            raw: expect.objectContaining({
              settlement: {
                localStorage: 'saved',
                indexedDB: 'saved',
              },
            }),
          }),
          lwwDecision: {
            decision: 'local-applied',
            reason: 'applied',
          },
          lastSyncTime: {
            before: null,
            after: null,
            advanced: false,
          },
        }));
        expect(audit.replayLog[0]).toEqual(expect.objectContaining({
          operationId: audit.lastWriteExplain?.operationId,
          entityType: 'offline-snapshot',
          entityId: 'offline-snapshot:audit-owner',
          operation: 'replace',
          sourceUserId: 'audit-owner',
          rpc: expect.objectContaining({
            status: 'applied',
            reason: 'offline-snapshot-settled',
          }),
        }));
        expectNoDataSafetyAudit('other-owner');
      }, 10000);

      it('hint-only 启动占位态下不应覆盖真实离线快照', async () => {
        const service = createProjectDataOfflineSnapshotService({
          authService: {
            currentUserId: vi.fn(() => null),
          },
          startupPlaceholderState: {
            isHintOnlyActive: vi.fn(() => true),
          },
        });
        service.saveOfflineSnapshot([
          {
            id: 'placeholder-project',
            name: 'Project 1',
            description: '',
            createdDate: '2026-03-31T00:00:00.000Z',
            tasks: [],
            connections: [],
          },
        ] as any);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(localStorage.getItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY)).toBeNull();
        expect(localStorage.getItem(getOfflineSnapshotStorageKey(AUTH_CONFIG.LOCAL_MODE_USER_ID))).toBeNull();
        expectNoDataSafetyAudit(AUTH_CONFIG.LOCAL_MODE_USER_ID);
        const snapshot = await service.loadStartupOfflineSnapshot();
        expect(snapshot.projectCount).toBe(0);
      }, 10000);

      it('saveOfflineSnapshotAndWait 在 localStorage 已写入但 IndexedDB 失败时不应拒绝本地提交', async () => {
        localStorage.removeItem(getOfflineSnapshotStorageKey('owner-user'));
        await clearOfflineSnapshotIdb();

        const failingIndexedDb = {
          open: vi.fn(() => {
            const request: {
              error: DOMException;
              onerror: ((event: Event) => void) | null;
              onsuccess: ((event: Event) => void) | null;
              onupgradeneeded: ((event: Event) => void) | null;
            } = {
              error: new DOMException('IndexedDB open failed', 'AbortError'),
              onerror: null,
              onsuccess: null,
              onupgradeneeded: null,
            };
            queueMicrotask(() => request.onerror?.(new Event('error', { cancelable: true })));
            return request as unknown as IDBOpenDBRequest;
          }),
        } as unknown as IDBFactory;

        vi.stubGlobal('indexedDB', failingIndexedDb);
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const service = createStartupOfflineSnapshotProjectDataService({
          authService: {
            currentUserId: vi.fn(() => 'owner-user'),
          },
        });

        try {
          await expect(service.saveOfflineSnapshotAndWait([
            {
              id: 'local-first-project',
              name: 'Local First Project',
              description: '',
              createdDate: '2026-03-31T00:00:00.000Z',
              tasks: [],
              connections: [],
            },
          ] as any)).resolves.toBeUndefined();

          const localPayload = localStorage.getItem(getOfflineSnapshotStorageKey('owner-user'));
          expect(localPayload).not.toBeNull();
          expect(JSON.parse(localPayload ?? '{}').projects[0].id).toBe('local-first-project');

          const snapshot = await service.loadStartupOfflineSnapshot();
          const audit = readDataSafetyAudit('owner-user');

          expect(snapshot.source).toBe('localStorage');
          expect(snapshot.projectCount).toBe(1);
          expect((snapshot.projects[0] as { id?: string }).id).toBe('local-first-project');
          expect(audit.replayLog).toHaveLength(1);
          expect(audit.lastWriteExplain).toEqual(expect.objectContaining({
            actor: { sourceUserId: 'owner-user' },
            entity: {
              type: 'offline-snapshot',
              id: 'offline-snapshot:owner-user',
            },
            operation: 'replace',
            rpcResult: expect.objectContaining({
              status: 'applied',
              reason: 'offline-snapshot-settled',
              raw: expect.objectContaining({
                settlement: {
                  localStorage: 'saved',
                  indexedDB: 'failed',
                },
              }),
            }),
          }));
        } finally {
          consoleErrorSpy.mockRestore();
          consoleWarnSpy.mockRestore();
          vi.unstubAllGlobals();
        }
      }, 10000);

      it('saveOfflineSnapshotAndWait 在 IndexedDB transaction abort 且 localStorage 失败时应拒绝提交', async () => {
        const localStorageSetItemSpy = mockOfflineSnapshotStorageQuota('user-1');
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const close = vi.fn();
        const transaction = {
          error: new DOMException('snapshot transaction aborted', 'AbortError'),
          onabort: null as (() => void) | null,
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          objectStore: vi.fn(() => ({ put: vi.fn() })),
        };
        const database = {
          close,
          transaction: vi.fn(() => {
            queueMicrotask(() => transaction.onabort?.());
            return transaction as unknown as IDBTransaction;
          }),
        } as unknown as IDBDatabase;
        const request: FakeOpenRequest = {
          result: database,
          error: null,
          onerror: null,
          onsuccess: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        vi.stubGlobal('indexedDB', {
          open: vi.fn(() => {
            queueMicrotask(() => request.onsuccess?.());
            return request as unknown as IDBOpenDBRequest;
          }),
        } as unknown as IDBFactory);

        try {
          const service = createProjectDataOfflineSnapshotService();
          const outcome = await observeSnapshotSave(
            service.saveOfflineSnapshotAndWait(createSnapshotProject('abort-boundary')),
            50,
          );

          expect(outcome.status).toBe('rejected');
          if (outcome.status === 'rejected') {
            expect(outcome.error).toMatchObject({ name: 'AbortError' });
          }
          expect(close).toHaveBeenCalledTimes(1);
          expectNoDataSafetyAudit(AUTH_CONFIG.LOCAL_MODE_USER_ID);
        } finally {
          consoleErrorSpy.mockRestore();
          consoleWarnSpy.mockRestore();
          vi.unstubAllGlobals();
          localStorageSetItemSpy.mockRestore();
        }
      }, 10000);

      it('saveOfflineSnapshotAndWait 在 IndexedDB open blocked 且 localStorage 失败时应拒绝提交', async () => {
        const localStorageSetItemSpy = mockOfflineSnapshotStorageQuota('user-1');
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const request: FakeOpenRequest = {
          result: {} as IDBDatabase,
          error: null,
          onerror: null,
          onsuccess: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        vi.stubGlobal('indexedDB', {
          open: vi.fn(() => {
            queueMicrotask(() => request.onblocked?.());
            return request as unknown as IDBOpenDBRequest;
          }),
        } as unknown as IDBFactory);

        try {
          const service = createProjectDataOfflineSnapshotService();
          const outcome = await observeSnapshotSave(
            service.saveOfflineSnapshotAndWait(createSnapshotProject('blocked-open')),
            50,
          );

          expect(outcome.status).toBe('rejected');
          if (outcome.status === 'rejected') {
            expect(outcome.error).toMatchObject({ name: 'InvalidStateError' });
          }
        } finally {
          consoleErrorSpy.mockRestore();
          consoleWarnSpy.mockRestore();
          vi.unstubAllGlobals();
          localStorageSetItemSpy.mockRestore();
        }
      }, 10000);

      it('saveOfflineSnapshotAndWait 在 IndexedDB open 无事件且 localStorage 失败时应超时拒绝', async () => {
        vi.useFakeTimers();
        const localStorageSetItemSpy = mockOfflineSnapshotStorageQuota('user-1');
        const request: FakeOpenRequest = {
          result: {} as IDBDatabase,
          error: null,
          onerror: null,
          onsuccess: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        vi.stubGlobal('indexedDB', {
          open: vi.fn(() => request as unknown as IDBOpenDBRequest),
        } as unknown as IDBFactory);

        try {
          const service = createProjectDataOfflineSnapshotService();
          const outcomePromise = observeSnapshotSave(
            service.saveOfflineSnapshotAndWait(createSnapshotProject('open-timeout')),
            6000,
          );
          const pendingOutcomePromise = observeSnapshotSave(
            service.saveOfflineSnapshotAndWait(createSnapshotProject('open-pending')),
            50,
          );
          await vi.advanceTimersByTimeAsync(50);
          const pendingOutcome = await pendingOutcomePromise;

          expect(pendingOutcome.status).toBe('pending');
          expectNoDataSafetyAudit(AUTH_CONFIG.LOCAL_MODE_USER_ID);

          await vi.advanceTimersByTimeAsync(6000);
          const outcome = await outcomePromise;

          expect(outcome.status).toBe('rejected');
          if (outcome.status === 'rejected') {
            expect(outcome.error).toMatchObject({ name: 'TimeoutError' });
          }
          expectNoDataSafetyAudit(AUTH_CONFIG.LOCAL_MODE_USER_ID);
        } finally {
          vi.useRealTimers();
          vi.unstubAllGlobals();
          localStorageSetItemSpy.mockRestore();
        }
      }, 10000);

      registerProjectDataOfflineSnapshotLoadSpecs();
  });
}
