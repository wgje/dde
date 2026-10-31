import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector, signal } from '@angular/core';
import { buildLocalBackupFilename, LocalBackupService } from './local-backup.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { ExportService } from './export.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { DisasterBackupService } from './disaster-backup.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import { AuthService } from './auth.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { del, get, set } from 'idb-keyval';

vi.mock('idb-keyval', async (importOriginal) => ({
  ...await importOriginal<typeof import('idb-keyval')>(),
  del: vi.fn(async () => undefined),
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
}));

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

const disasterBackupServiceMock = {
  buildLocalBlob: vi.fn(),
};

const exportServiceMock = {
  recordLocalBackupSuccess: vi.fn(),
};

describe('LocalBackupService', () => {
  let service: LocalBackupService;
  let currentUserIdSignal = signal<string | null>('user-1');
  let sessionRuntimeReset: SessionRuntimeResetRegistry;
  let idbStore: Map<string, unknown>;

  beforeEach(() => {
    localStorage.clear();
    mockLoggerCategory.info.mockReset();
    mockLoggerCategory.warn.mockReset();
    mockLoggerCategory.error.mockReset();
    mockLoggerCategory.debug.mockReset();
    exportServiceMock.recordLocalBackupSuccess.mockReset();
    idbStore = new Map<string, unknown>();
    vi.mocked(get).mockReset().mockImplementation(async key => idbStore.get(String(key)));
    vi.mocked(set).mockReset().mockImplementation(async (key, value) => { idbStore.set(String(key), value); });
    vi.mocked(del).mockReset().mockImplementation(async key => { idbStore.delete(String(key)); });
    service = createService();
    disasterBackupServiceMock.buildLocalBlob.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'showDirectoryPicker');
  });

  describe('初始状态', () => {
    it('初始未授权', () => {
      expect(service.isAuthorized()).toBe(false);
    });

    it('初始目录名为 null', () => {
      expect(service.directoryName()).toBeNull();
    });

    it('初始无上次备份时间', () => {
      expect(service.lastBackupTime()).toBeNull();
    });

    it('初始未在备份中', () => {
      expect(service.isBackingUp()).toBe(false);
    });

    it('自动备份默认关闭', () => {
      expect(service.autoBackupEnabled()).toBe(false);
    });
  });

  describe('compatibility', () => {
    it('返回兼容性信息', () => {
      const compat = service.compatibility();
      expect(compat).toBeDefined();
      expect(compat).toHaveProperty('isSupported');
    });
  });

  describe('revokeDirectoryAccess', () => {
    it('撤销后状态为未授权', async () => {
      await service.revokeDirectoryAccess();
      expect(service.isAuthorized()).toBe(false);
      expect(service.directoryName()).toBeNull();
    });
  });

  describe('stopAutoBackup', () => {
    it('停止定时器', () => {
      service.stopAutoBackup();
      expect(service.autoBackupEnabled()).toBe(false);
    });

    it('停止时即使 interval handle 为 0 也应清理，避免重启后残留双备份周期', () => {
      const zeroInterval = 0 as unknown as ReturnType<typeof setInterval>;
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
      (service as unknown as { autoBackupTimer: ReturnType<typeof setInterval> | null }).autoBackupTimer = zeroInterval;

      try {
        service.stopAutoBackup(false);

        expect(clearIntervalSpy).toHaveBeenCalledWith(zeroInterval);
        expect(
          (service as unknown as { autoBackupTimer: ReturnType<typeof setInterval> | null }).autoBackupTimer
        ).toBeNull();
      } finally {
        clearIntervalSpy.mockRestore();
      }
    });

    it('interval 清理失败时仍应失效本地句柄并完成停止状态同步', () => {
      const intervalTimer = 1 as unknown as ReturnType<typeof setInterval>;
      const timerCleanupError = new Error('auto backup interval cleanup failed');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {
        throw timerCleanupError;
      });
      const deferredRetryScheduler = (
        service as unknown as { deferredRetryScheduler: { clear: () => void } }
      ).deferredRetryScheduler;
      const deferredRetryClearSpy = vi.spyOn(deferredRetryScheduler, 'clear');
      (service as unknown as { autoBackupTimer: ReturnType<typeof setInterval> | null }).autoBackupTimer = intervalTimer;
      setPrivateSignal(service, '_autoBackupEnabled', true);

      try {
        expect(() => service.stopAutoBackup()).not.toThrow();

        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalTimer);
        expect(deferredRetryClearSpy).toHaveBeenCalledOnce();
        expect(
          (service as unknown as { autoBackupTimer: ReturnType<typeof setInterval> | null }).autoBackupTimer
        ).toBeNull();
        expect(service.autoBackupEnabled()).toBe(false);
        expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
          '自动备份定时器清理失败，继续停止自动备份',
          timerCleanupError,
        );
      } finally {
        clearIntervalSpy.mockRestore();
        deferredRetryClearSpy.mockRestore();
      }
    });
  });

  describe('setAutoBackupInterval', () => {
    it('设置备份间隔', () => {
      service.setAutoBackupInterval(60000);
      expect(service.autoBackupIntervalMs()).toBe(60000);
    });
  });

  describe('startAutoBackup', () => {
    it('interval 安装失败时应保持关闭状态并隔离平台异常', () => {
      const timerScheduleError = new Error('auto backup interval scheduling failed');
      setPrivateSignal(service, '_isAuthorized', true);
      setPrivateSignal(service, '_autoBackupEnabled', true);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
        throw timerScheduleError;
      });

      try {
        expect(() => service.startAutoBackup(
          () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
          1000,
          { silent: true },
        )).not.toThrow();

        expect(setIntervalSpy).toHaveBeenCalledOnce();
        expect(
          (service as unknown as { autoBackupTimer: ReturnType<typeof setInterval> | null }).autoBackupTimer
        ).toBeNull();
        expect(service.autoBackupEnabled()).toBe(false);
        expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
          '自动备份定时器启动失败，已保持关闭状态',
          timerScheduleError,
        );
      } finally {
        setIntervalSpy.mockRestore();
      }
    });
  });

  describe('会话运行时重置', () => {
    it('登出时立即分离目录授权、owner 状态和自动备份', async () => {
      vi.useFakeTimers();
      currentUserIdSignal.set('old-user');
      setPrivateSignal(service, '_isAuthorized', true);
      service.startAutoBackup(
        () => [{ id: 'old-project', name: 'Old', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      expect((service as unknown as { autoBackupTimer: unknown }).autoBackupTimer).not.toBeNull();

      sessionRuntimeReset.resetAll('owner-change');
      expect(service.isAuthorized()).toBe(false);
      expect(service.directoryName()).toBeNull();
      expect(service.hasSavedHandle()).toBe(false);
      expect(service.permissionState()).toBeNull();
      expect(service.autoBackupEnabled()).toBe(false);
      expect((service as unknown as { directoryHandle: unknown }).directoryHandle).toBeNull();
      expect((service as unknown as { restoreHandlePromise: unknown }).restoreHandlePromise).toBeNull();
      currentUserIdSignal.set(null);
      await Promise.resolve();

      expect((service as unknown as { autoBackupTimer: unknown }).autoBackupTimer).toBeNull();
      expect(service.autoBackupEnabled()).toBe(false);
    });

    it('切换到新 owner 后不会沿用旧 owner 授权或自动备份 timer', async () => {
      vi.useFakeTimers();
      currentUserIdSignal.set('old-user');
      setPrivateSignal(service, '_isAuthorized', true);
      const getProjects = () => [{ id: 'current-project', name: 'Current', tasks: [], connections: [] }];
      service.startAutoBackup(getProjects, 1000, { silent: true });
      const oldTimer = (service as unknown as { autoBackupTimer: unknown }).autoBackupTimer;

      sessionRuntimeReset.resetAll('owner-change');
      currentUserIdSignal.set('new-user');
      await Promise.resolve();

      const newTimer = (service as unknown as { autoBackupTimer: unknown }).autoBackupTimer;
      expect(newTimer).toBeNull();
      expect(oldTimer).not.toBeNull();
      expect(service.isAuthorized()).toBe(false);
      expect(service.autoBackupEnabled()).toBe(false);
    });

    it('旧会话 Blob 晚到时不得写入备份文件或记录成功', async () => {
      const backupBlob = new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' });
      const fileHandle = {
        createWritable: vi.fn(),
        getFile: vi.fn(),
      };
      (service as unknown as { directoryHandle: unknown }).directoryHandle = {
        name: 'backups',
        getFileHandle: vi.fn(async () => fileHandle),
        removeEntry: vi.fn(async () => undefined),
      };
      (service as unknown as { checkAndRestorePermission: () => Promise<boolean> }).checkAndRestorePermission =
        vi.fn(async () => true);
      let resolveBlob!: (value: { payload: object; blob: Blob }) => void;
      disasterBackupServiceMock.buildLocalBlob.mockReturnValueOnce(
        new Promise(resolve => { resolveBlob = resolve; }),
      );

      const pending = service.performBackup([
        { id: 'old-project', name: 'Old', tasks: [], connections: [] },
      ]);
      sessionRuntimeReset.resetAll('owner-change');
      currentUserIdSignal.set('new-user');
      resolveBlob({ payload: { payloadVersion: '2.0.0' }, blob: backupBlob });

      await expect(pending).resolves.toEqual({ success: false, error: '会话已切换' });
      expect(fileHandle.createWritable).not.toHaveBeenCalled();
      expect(exportServiceMock.recordLocalBackupSuccess).not.toHaveBeenCalled();
    });
  });

  describe('目录 owner 绑定', () => {
    it('隔离 authenticated A/B，拒绝 B 的 permission/write/list/read 并可恢复 fresh A', async () => {
      const handleA = createDirectoryHandleMock('a-backups', 'granted');
      window.showDirectoryPicker = vi.fn(async () => handleA);
      service.ngOnDestroy();
      service = createService('user-a');

      await expect(service.requestDirectoryAccess()).resolves.toEqual({
        success: true,
        directoryName: 'a-backups',
      });

      sessionRuntimeReset.resetAll('owner-change');
      expect(service.directoryName()).toBeNull();
      expect(service.isAuthorized()).toBe(false);
      currentUserIdSignal.set('user-b');
      await flushOwnerRebind();

      await expect(service.checkAndRestorePermission()).resolves.toBe(false);
      await expect(service.performBackup([
        { id: 'b-project', name: 'B', tasks: [], connections: [] },
      ])).resolves.toEqual(expect.objectContaining({ success: false }));
      await expect(service.listBackupFiles()).resolves.toEqual([]);
      await expect(service.readBackupFile('nanoflow-backup-a.json')).resolves.toBeNull();
      expect(handleA.queryPermission).not.toHaveBeenCalled();
      expect(handleA.requestPermission).not.toHaveBeenCalled();
      expect(handleA.getFileHandle).not.toHaveBeenCalled();
      expect(handleA.values).not.toHaveBeenCalled();

      await switchOwner('user-a');
      await expect(service.checkAndRestorePermission({ request: false })).resolves.toBe(true);
      expect(service.directoryName()).toBe('a-backups');
      expect(service.isAuthorized()).toBe(true);
      expect(handleA.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('isolates local and authenticated scopes and restores the local scope after restart', async () => {
      const localHandle = createDirectoryHandleMock('local-backups', 'granted');
      window.showDirectoryPicker = vi.fn(async () => localHandle);
      service.ngOnDestroy();
      service = createService(null);
      await expect(service.requestDirectoryAccess()).resolves.toEqual({
        success: true,
        directoryName: 'local-backups',
      });

      await switchOwner('user-a');
      await expect(service.checkAndRestorePermission()).resolves.toBe(false);
      expect(service.directoryName()).toBeNull();
      expect(localHandle.queryPermission).not.toHaveBeenCalled();

      service.ngOnDestroy();
      service = createService(null);
      await expect(service.checkAndRestorePermission({ request: false })).resolves.toBe(true);
      expect(service.directoryName()).toBe('local-backups');
      expect(localHandle.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('rejects a late A picker continuation after A to B to A', async () => {
      const lateHandle = createDirectoryHandleMock('late-a', 'granted');
      let resolvePicker!: (handle: FileSystemDirectoryHandle) => void;
      window.showDirectoryPicker = vi.fn(() => new Promise<FileSystemDirectoryHandle>(resolve => {
        resolvePicker = resolve;
      }));
      service.ngOnDestroy();
      service = createService('user-a');

      const pending = service.requestDirectoryAccess();
      await Promise.resolve();
      await switchOwner('user-b');
      await switchOwner('user-a');
      resolvePicker(lateHandle);

      await expect(pending).resolves.toEqual({ success: false, error: '会话已切换' });
      expect(service.directoryName()).toBeNull();
      expect(service.isAuthorized()).toBe(false);
      expect(lateHandle.queryPermission).not.toHaveBeenCalled();
      expect(lateHandle.requestPermission).not.toHaveBeenCalled();
      expect(lateHandle.getFileHandle).not.toHaveBeenCalled();
      expect(idbStore.size).toBe(0);
    });

    it('drops a deferred A directory listing after A to B to A and returns fresh A once', async () => {
      const filename = buildLocalBackupFilename('2026-06-09_12-30-45');
      const file = new File(['backup'], filename, { type: 'application/json' });
      const fileHandle = { getFile: vi.fn(async () => file) } as unknown as FileSystemFileHandle;
      let markStarted!: () => void;
      let releaseListing!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const listingGate = new Promise<void>(resolve => { releaseListing = resolve; });
      const handle = createDirectoryHandleMock('a-backups', 'granted');
      handle.values = vi.fn()
        .mockImplementationOnce(async function* () {
          markStarted();
          await listingGate;
          yield { kind: 'file', name: filename };
        })
        .mockImplementation(async function* () { yield { kind: 'file', name: filename }; });
      handle.getFileHandle = vi.fn(async () => fileHandle) as FileSystemDirectoryHandle['getFileHandle'];
      await authorizeOwnerHandle(handle);
      const staleListing = service.listBackupFiles();
      await started;
      await switchOwner('user-b');
      await switchOwner('user-a');
      releaseListing();

      await expect(staleListing).resolves.toEqual([]);
      await expect(service.listBackupFiles()).resolves.toEqual([
        expect.objectContaining({ name: filename, size: file.size }),
      ]);
    });

    it('drops a deferred A file read after A to B to A and returns fresh A once', async () => {
      const filename = buildLocalBackupFilename('2026-06-09_12-30-45');
      const file = new File(['backup'], filename, { type: 'application/json' });
      let markStarted!: () => void;
      let releaseRead!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
      const getFile = vi.fn(async () => {
        if (getFile.mock.calls.length === 1) {
          markStarted();
          await readGate;
        }
        return file;
      });
      const handle = createDirectoryHandleMock('a-backups', 'granted');
      handle.getFileHandle = vi.fn(async (_name: string): Promise<FileSystemFileHandle> => ({
        getFile,
      } as unknown as FileSystemFileHandle));
      await authorizeOwnerHandle(handle);
      const staleRead = service.readBackupFile(filename);
      await started;
      await switchOwner('user-b');
      await switchOwner('user-a');
      releaseRead();

      await expect(staleRead).resolves.toBeNull();
      await expect(service.readBackupFile(filename)).resolves.toBe(file);
      expect(getFile).toHaveBeenCalledTimes(2);
    });

    it('ignores legacy unowned state and handle without deleting directory files', async () => {
      const legacyHandle = createDirectoryHandleMock('legacy-backups', 'granted');
      localStorage.setItem('nanoflow.local-backup.directory-name', 'legacy-backups');
      localStorage.setItem('nanoflow.local-backup.auto-enabled', 'true');
      idbStore.set('nanoflow.local-backup.directory-handle', legacyHandle);
      service.ngOnDestroy();
      service = createService('user-a');

      await expect(service.checkAndRestorePermission({ request: false })).resolves.toBe(false);
      expect(service.directoryName()).toBeNull();
      expect(service.autoBackupEnabled()).toBe(false);
      expect(legacyHandle.removeEntry).not.toHaveBeenCalled();
      expect(idbStore.get('nanoflow.local-backup.directory-handle')).toBe(legacyHandle);
    });
  });

  describe('ngOnDestroy', () => {
    it('清理时不出错', () => {
      expect(() => service.ngOnDestroy()).not.toThrow();
    });

    it('销毁后晚到的自动备份启动不应重新创建定时器', () => {
      vi.useFakeTimers();
      setPrivateSignal(service, '_isAuthorized', true);
      service.ngOnDestroy();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect((service as unknown as { autoBackupTimer: ReturnType<typeof setInterval> | null }).autoBackupTimer).toBeNull();
      expect(service.autoBackupEnabled()).toBe(false);
    });
  });

  describe('requestDirectoryAccess', () => {
    it('不支持 File System Access API 时返回不可用', async () => {
      // In Node/test environment, showDirectoryPicker doesn't exist
      const result = await service.requestDirectoryAccess();
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });

    it('选择目录时使用稳定 picker 配置，便于浏览器记住上次目录', async () => {
      const handle = { name: 'backups', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
      window.showDirectoryPicker = vi.fn(async () => handle);
      service = createService();

      const result = await service.requestDirectoryAccess();

      expect(result.success).toBe(true);
      expect(window.showDirectoryPicker).toHaveBeenCalledWith(expect.objectContaining({
        id: 'nanoflow-local-backup',
        mode: 'readwrite',
        startIn: 'documents',
      }));
      expect(service.directoryName()).toBe('backups');
      expect(service.hasSavedHandle()).toBe(true);
    });
  });

  describe('自动备份恢复', () => {
    it('项目提供者接入时应恢复刷新前已开启的自动备份', () => {
      vi.useFakeTimers();
      const getProjects = () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }];
      const startSpy = vi.spyOn(service, 'startAutoBackup');
      setPrivateSignal(service, '_isAuthorized', true);
      setPrivateSignal(service, '_autoBackupEnabled', true);

      service.setProjectsProvider(getProjects);

      expect(startSpy).toHaveBeenCalledWith(getProjects, undefined, { silent: true });
      service.stopAutoBackup();
    });

    it('自动备份定时器不应在无用户手势时请求目录权限', async () => {
      vi.useFakeTimers();
      const handle = createDirectoryHandleMock('backups', 'prompt');
      (service as unknown as { directoryHandle: FileSystemDirectoryHandle }).directoryHandle = handle;
      setPrivateSignal(service, '_isAuthorized', true);

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
      expect(handle.requestPermission).not.toHaveBeenCalled();
      expect(disasterBackupServiceMock.buildLocalBlob).not.toHaveBeenCalled();
      service.stopAutoBackup();
    });

    it('目录句柄状态失效时应暂停自动备份并清理授权状态', async () => {
      vi.useFakeTimers();
      const handle = createDirectoryHandleMock('backups', 'granted');
      handle.getFileHandle = vi.fn(async () => {
        throw createStaleDirectoryHandleError();
      }) as FileSystemDirectoryHandle['getFileHandle'];

      (service as unknown as { directoryHandle: FileSystemDirectoryHandle }).directoryHandle = handle;
      setPrivateSignal(service, '_isAuthorized', true);
      setPrivateSignal(service, '_hasSavedHandle', true);
      setPrivateSignal(service, '_directoryName', 'backups');
      disasterBackupServiceMock.buildLocalBlob.mockResolvedValue({
        payload: { payloadVersion: '2.0.0' },
        blob: new Blob(['{}'], { type: 'application/json' }),
      });

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(service.autoBackupEnabled()).toBe(true);
      expect(service.isAuthorized()).toBe(false);
      expect(service.hasSavedHandle()).toBe(false);
      expect(service.directoryName()).toBeNull();
    });

    it('浏览器网络挂起时应静默跳过本轮自动备份', async () => {
      vi.useFakeTimers();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      setPrivateSignal(service, '_isAuthorized', true);

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(disasterBackupServiceMock.buildLocalBlob).not.toHaveBeenCalled();
      expect(mockLoggerCategory.warn).not.toHaveBeenCalledWith('自动备份失败', expect.anything());
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        '浏览器网络恢复窗口内跳过本轮自动备份',
        expect.objectContaining({ resumeDelayMs: expect.any(Number) }),
      );
      service.stopAutoBackup();
    });

    it('浏览器网络挂起结束后应补跑刚刚跳过的自动备份', async () => {
      vi.useFakeTimers();
      const performBackupSpy = vi.spyOn(service, 'performBackup').mockResolvedValue({ success: true, filename: 'backup.json' });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      setPrivateSignal(service, '_isAuthorized', true);

      service.startAutoBackup(
        () => [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        1000,
        { silent: true },
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(performBackupSpy).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1600);

      expect(performBackupSpy).toHaveBeenCalledTimes(1);
      performBackupSpy.mockRestore();
      service.stopAutoBackup();
    });

    it('自动备份周期遇到项目提供者异常时应记录并继续运行', async () => {
      setPrivateSignal(service, '_autoBackupEnabled', true);
      (service as unknown as {
        getProjectsFn: () => Array<{ id: string; name: string; tasks: []; connections: [] }>;
        runAutoBackupCycle: () => Promise<void>;
      }).getProjectsFn = () => {
        throw new Error('projects provider failed');
      };

      await expect(
        (service as unknown as { runAutoBackupCycle: () => Promise<void> }).runAutoBackupCycle()
      ).resolves.toBeUndefined();

      expect(mockLoggerCategory.error).toHaveBeenCalledWith(
        '自动备份周期异常',
        expect.objectContaining({ error: 'projects provider failed' }),
      );
    });
  });

  describe('performBackup', () => {
    it('未授权时返回失败', async () => {
      const result = await service.performBackup([{
        id: 'p1', name: 'Test', tasks: [], connections: [],
      }]);
      expect(result.success).toBe(false);
    });

    it('并发 performBackup 只能允许一个备份进入写入阶段', async () => {
      const backupBlob = new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' });
      const writable = {
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
      const fileHandle = {
        createWritable: vi.fn(async () => writable),
        getFile: vi.fn(async () => new File([backupBlob], 'backup.json', { type: 'application/json' })),
      };

      (service as unknown as { directoryHandle: unknown }).directoryHandle = {
        name: 'backups',
        getFileHandle: vi.fn(async () => fileHandle),
        removeEntry: vi.fn(async () => undefined),
      };

      let releasePermission!: () => void;
      const permissionGate = new Promise<boolean>(resolve => {
        releasePermission = () => resolve(true);
      });
      (service as unknown as { checkAndRestorePermission: () => Promise<boolean> }).checkAndRestorePermission =
        vi.fn(() => permissionGate);

      disasterBackupServiceMock.buildLocalBlob.mockResolvedValue({
        payload: { payloadVersion: '2.0.0' },
        blob: backupBlob,
      });

      const projects = [{ id: 'p1', name: 'Test', tasks: [], connections: [] }];
      const first = service.performBackup(projects);
      const second = service.performBackup(projects);

      await Promise.resolve();
      await Promise.resolve();
      releasePermission();

      const results = await Promise.all([first, second]);

      expect(disasterBackupServiceMock.buildLocalBlob).toHaveBeenCalledTimes(1);
      expect(results).toContainEqual(expect.objectContaining({
        success: false,
        error: '备份正在进行中',
      }));
    });

    it('授权目录后应通过 DisasterBackupService 生成灾备文件', async () => {
      const writes: Blob[] = [];
      const backupBlob = new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' });
      const writable = {
        write: vi.fn(async (blob: Blob) => { writes.push(blob); }),
        close: vi.fn(async () => undefined),
      };
      const fileHandle = {
        createWritable: vi.fn(async () => writable),
        getFile: vi.fn(async () => new File([backupBlob], 'backup.json', { type: 'application/json' })),
      };

      (service as unknown as { directoryHandle: unknown }).directoryHandle = {
        name: 'backups',
        getFileHandle: vi.fn(async () => fileHandle),
        removeEntry: vi.fn(async () => undefined),
      };
      (service as unknown as { checkAndRestorePermission: () => Promise<boolean> }).checkAndRestorePermission = vi.fn(async () => true);
      service.setAutoBackupInterval(900000);

      disasterBackupServiceMock.buildLocalBlob.mockResolvedValue({
        payload: { payloadVersion: '2.0.0' },
        blob: backupBlob,
      });

      const result = await service.performBackup([{
        id: 'p1', name: 'Test', tasks: [], connections: [],
      }]);

      expect(result.success).toBe(true);
      expect(disasterBackupServiceMock.buildLocalBlob).toHaveBeenCalledWith(
        [{ id: 'p1', name: 'Test', tasks: [], connections: [] }],
        { autoBackupEnabled: false, autoBackupIntervalMs: 900000 },
      );
      expect(exportServiceMock.recordLocalBackupSuccess).toHaveBeenCalledWith(result.timestamp);
      expect(writes).toHaveLength(1);
    });

    it('云端用户态延后时不应写入部分备份文件', async () => {
      const writable = {
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
      const fileHandle = {
        createWritable: vi.fn(async () => writable),
        getFile: vi.fn(),
      };

      (service as unknown as { directoryHandle: unknown }).directoryHandle = {
        name: 'backups',
        getFileHandle: vi.fn(async () => fileHandle),
        removeEntry: vi.fn(async () => undefined),
      };
      (service as unknown as { checkAndRestorePermission: () => Promise<boolean> }).checkAndRestorePermission = vi.fn(async () => true);

      disasterBackupServiceMock.buildLocalBlob.mockResolvedValue({
        payload: { payloadVersion: '2.0.0', coverage: { includesCloudUserState: false } },
        blob: new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' }),
        deferredCloudUserState: true,
      });

      const result = await service.performBackup([{
        id: 'p1', name: 'Test', tasks: [], connections: [],
      }]);

      expect(result).toEqual(expect.objectContaining({
        success: false,
        deferred: true,
      }));
      expect(fileHandle.createWritable).not.toHaveBeenCalled();
      expect(exportServiceMock.recordLocalBackupSuccess).not.toHaveBeenCalled();
    });
  });

  function setPrivateSignal<T>(target: LocalBackupService, key: string, value: T): void {
    (target as unknown as Record<string, { set(next: T): void }>)[key].set(value);
  }

  function createDirectoryHandleMock(name: string, permission: PermissionState): FileSystemDirectoryHandle {
    return {
      name,
      kind: 'directory',
      queryPermission: vi.fn(async () => permission),
      requestPermission: vi.fn(async () => permission),
      getFileHandle: vi.fn(),
      removeEntry: vi.fn(),
      values: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;
  }

  function createStaleDirectoryHandleError(): DOMException {
    return new DOMException(
      'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.',
      'InvalidStateError',
    );
  }

  async function switchOwner(userId: string | null): Promise<void> {
    sessionRuntimeReset.resetAll('owner-change');
    currentUserIdSignal.set(userId);
    await flushOwnerRebind();
  }

  async function authorizeOwnerHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    window.showDirectoryPicker = vi.fn(async () => handle);
    service.ngOnDestroy();
    service = createService('user-a');
    await service.requestDirectoryAccess();
  }

  async function flushOwnerRebind(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function createService(initialUserId: string | null = 'user-1'): LocalBackupService {
    currentUserIdSignal = signal<string | null>(initialUserId);
    const injector = Injector.create({
      providers: [
        { provide: LocalBackupService, useClass: LocalBackupService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } },
        { provide: ExportService, useValue: exportServiceMock },
        { provide: UiStateService, useValue: { isMobile: vi.fn(() => false) } },
        { provide: PreferenceService, useValue: { get: vi.fn(), set: vi.fn(), syncLocalBackupSettings: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
        { provide: DisasterBackupService, useValue: disasterBackupServiceMock },
        { provide: AuthService, useValue: { currentUserId: currentUserIdSignal } },
        SessionRuntimeResetRegistry,
      ],
    });
    sessionRuntimeReset = injector.get(SessionRuntimeResetRegistry);
    return injector.get(LocalBackupService);
  }
});

describe('buildLocalBackupFilename', () => {
  it('使用固定前缀、时间戳和 JSON 后缀生成备份文件名', () => {
    expect(buildLocalBackupFilename('2026-06-09_12-30-45'))
      .toBe('nanoflow-backup-2026-06-09_12-30-45.json');
  });
});
