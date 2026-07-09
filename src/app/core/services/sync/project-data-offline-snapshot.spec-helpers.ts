import {
  AUTH_CONFIG,
  OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY,
  clearOfflineSnapshotIdb,
  describe,
  expect,
  getOfflineSnapshotStorageKey,
  it,
  readOfflineSnapshotFromIdb,
  vi,
  writeOfflineSnapshotToIdb,
} from './project-data.service.spec-context';
import {
  createProjectDataOfflineSnapshotService,
  createStartupOfflineSnapshotProjectDataService,
} from './project-data-offline-snapshot.spec-harness';
import { registerProjectDataOfflineSnapshotLoadSpecs } from './project-data-offline-snapshot-load.spec-helpers';

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

          expect(snapshot.source).toBe('localStorage');
          expect(snapshot.projectCount).toBe(1);
          expect((snapshot.projects[0] as { id?: string }).id).toBe('local-first-project');
        } finally {
          consoleErrorSpy.mockRestore();
          consoleWarnSpy.mockRestore();
          vi.unstubAllGlobals();
        }
      }, 10000);

      registerProjectDataOfflineSnapshotLoadSpecs();
  });
}
