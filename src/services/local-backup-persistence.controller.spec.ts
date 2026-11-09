import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_BACKUP_CONFIG } from '../config/local-backup.config';
import {
  LocalBackupPersistenceController,
  type LocalBackupOwnerContext,
  type LocalBackupPersistenceLogger,
} from './local-backup-persistence.controller';

const AUTH_A = { kind: 'authenticated', userId: 'user-a' } as const;
const AUTH_B = { kind: 'authenticated', userId: 'user-b' } as const;
const LOCAL = { kind: 'local' } as const;

const stubLocalStorage = (overrides: Partial<Storage>): void => {
  vi.stubGlobal('localStorage', {
    length: 0,
    clear: vi.fn(),
    getItem: vi.fn(() => null),
    key: vi.fn(() => null),
    removeItem: vi.fn(),
    setItem: vi.fn(),
    ...overrides,
  } as Storage);
};

describe('LocalBackupPersistenceController', () => {
  let logger: LocalBackupPersistenceLogger;
  let idbStore: Map<string, unknown>;
  let controller: LocalBackupPersistenceController;
  let context: LocalBackupOwnerContext;

  beforeEach(() => {
    localStorage.clear();
    logger = { debug: vi.fn(), warn: vi.fn() };
    idbStore = new Map<string, unknown>();
    controller = new LocalBackupPersistenceController({
      logger,
      idbGet: async <T = unknown>(key: string) => idbStore.get(String(key)) as T | undefined,
      idbSet: async (key, value) => { idbStore.set(String(key), value); },
      idbDel: async key => { idbStore.delete(String(key)); },
    });
    context = controller.activateOwnerScope(AUTH_A);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads local backup state from localStorage', () => {
    controller.saveState(context, {
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
      directoryName: 'backups',
    });

    expect(controller.loadState(context)).toEqual({
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
      directoryName: 'backups',
      hasSavedHandle: true,
    });
  });

  it('saves local backup state without persisting an empty directory name', () => {
    controller.saveState(context, {
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: false,
      autoBackupIntervalMs: 600000,
      directoryName: null,
    });

    expect(controller.loadState(context)).toEqual({
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: false,
      autoBackupIntervalMs: 600000,
      directoryName: null,
      hasSavedHandle: false,
    });
  });

  it('clears all persisted local backup state and can clear only the directory name', () => {
    controller.saveState(context, {
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: true,
      autoBackupIntervalMs: 600000,
      directoryName: 'backups',
    });

    controller.clearDirectoryHandleName(context);

    expect(controller.loadState(context)).toEqual(expect.objectContaining({
      autoBackupEnabled: true,
      directoryName: null,
      hasSavedHandle: false,
    }));

    controller.clearState(context);

    expect(controller.loadState(context)).toEqual({
      lastBackupTime: null,
      autoBackupEnabled: false,
      autoBackupIntervalMs: LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS,
      directoryName: null,
      hasSavedHandle: false,
    });
  });

  it('persists, restores, and clears the directory handle through IndexedDB adapters', async () => {
    const handle = { name: 'backups', kind: 'directory' } as FileSystemDirectoryHandle;

    await controller.saveDirectoryHandle(context, handle);
    await expect(controller.restoreDirectoryHandle(context)).resolves.toBe(handle);

    await controller.clearDirectoryHandle(context);
    await expect(controller.restoreDirectoryHandle(context)).resolves.toBeNull();
  });

  it('isolates authenticated owners and local mode across state and directory handles', async () => {
    const handleA = { name: 'a-backups', kind: 'directory' } as FileSystemDirectoryHandle;
    const handleB = { name: 'b-backups', kind: 'directory' } as FileSystemDirectoryHandle;
    saveOwnerState(context, 'a-backups');
    await controller.saveDirectoryHandle(context, handleA);

    const contextB = controller.activateOwnerScope(AUTH_B);
    expect(controller.loadState(contextB)).toEqual(emptyState());
    await expect(controller.restoreDirectoryHandle(contextB)).resolves.toBeNull();
    saveOwnerState(contextB, 'b-backups');
    await controller.saveDirectoryHandle(contextB, handleB);

    const localContext = controller.activateOwnerScope(LOCAL);
    expect(controller.loadState(localContext)).toEqual(emptyState());
    await expect(controller.restoreDirectoryHandle(localContext)).resolves.toBeNull();

    const freshA = controller.activateOwnerScope(AUTH_A);
    expect(controller.loadState(freshA)).toEqual(expect.objectContaining({ directoryName: 'a-backups' }));
    await expect(controller.restoreDirectoryHandle(freshA)).resolves.toBe(handleA);

    const freshB = controller.activateOwnerScope(AUTH_B);
    expect(controller.loadState(freshB)).toEqual(expect.objectContaining({ directoryName: 'b-backups' }));
    await expect(controller.restoreDirectoryHandle(freshB)).resolves.toBe(handleB);
  });

  it('restores the exact owner after controller restart', async () => {
    const handle = { name: 'a-backups', kind: 'directory' } as FileSystemDirectoryHandle;
    saveOwnerState(context, 'a-backups');
    await controller.saveDirectoryHandle(context, handle);

    const restarted = new LocalBackupPersistenceController({
      logger,
      idbGet: async <T = unknown>(key: string) => idbStore.get(String(key)) as T | undefined,
      idbSet: async (key, value) => { idbStore.set(String(key), value); },
      idbDel: async key => { idbStore.delete(String(key)); },
    });
    const restartedContext = restarted.activateOwnerScope(AUTH_A);

    expect(restarted.loadState(restartedContext)).toEqual(expect.objectContaining({ directoryName: 'a-backups' }));
    await expect(restarted.restoreDirectoryHandle(restartedContext)).resolves.toBe(handle);
  });

  it('rejects a handle envelope whose persisted owner does not match the exact key owner', async () => {
    const handle = { name: 'a-backups', kind: 'directory' } as FileSystemDirectoryHandle;
    await controller.saveDirectoryHandle(context, handle);
    const [key, envelope] = [...idbStore.entries()][0];
    idbStore.set(key, { ...(envelope as object), ownerScope: AUTH_B });

    await expect(controller.restoreDirectoryHandle(context)).resolves.toBeNull();
  });

  it('rejects stale A context after A to B to A without touching fresh A state', async () => {
    const staleA = context;
    controller.activateOwnerScope(AUTH_B);
    const freshA = controller.activateOwnerScope(AUTH_A);
    saveOwnerState(freshA, 'fresh-a');

    expect(controller.isOwnerContextCurrent(staleA)).toBe(false);
    controller.saveState(staleA, {
      lastBackupTime: null,
      autoBackupEnabled: true,
      autoBackupIntervalMs: 1,
      directoryName: 'late-a',
    });
    await controller.saveDirectoryHandle(
      staleA,
      { name: 'late-a', kind: 'directory' } as FileSystemDirectoryHandle,
    );

    expect(controller.loadState(freshA)).toEqual(expect.objectContaining({ directoryName: 'fresh-a' }));
    await expect(controller.restoreDirectoryHandle(freshA)).resolves.toBeNull();
  });

  it('ignores legacy unowned settings and handles without deleting directory files', async () => {
    const legacyHandle = {
      name: 'legacy-backups',
      kind: 'directory',
      removeEntry: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;
    Object.values(LOCAL_BACKUP_CONFIG.STORAGE_KEYS)
      .forEach(key => localStorage.setItem(key, 'legacy'));
    idbStore.set('nanoflow.local-backup.directory-handle', legacyHandle);

    expect(controller.loadState(context)).toEqual(emptyState());
    await expect(controller.restoreDirectoryHandle(context)).resolves.toBeNull();
    expect(legacyHandle.removeEntry).not.toHaveBeenCalled();
    expect(idbStore.get('nanoflow.local-backup.directory-handle')).toBe(legacyHandle);
  });

  it('returns the default state when localStorage read and warning logging both fail', () => {
    const storageError = new Error('localStorage unavailable');
    stubLocalStorage({
      getItem: vi.fn(() => { throw storageError; }),
    });
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger unavailable');
    });

    expect(controller.loadState(context)).toEqual({
      lastBackupTime: null,
      autoBackupEnabled: false,
      autoBackupIntervalMs: LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS,
      directoryName: null,
      hasSavedHandle: false,
    });
    expect(logger.warn).toHaveBeenCalledWith('加载本地备份持久化状态失败', storageError);
  });

  it('keeps localStorage write cleanup failures swallowed when warning logging fails', () => {
    const storageError = new Error('localStorage write unavailable');
    stubLocalStorage({
      setItem: vi.fn(() => { throw storageError; }),
    });
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger unavailable');
    });

    expect(() => controller.saveState(context, {
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
      directoryName: 'backups',
    })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith('保存本地备份持久化状态失败', storageError);
  });

  it.each([
    ['clearState', () => controller.clearState(context), '清除本地备份持久化状态失败'],
    ['clearDirectoryHandleName', () => controller.clearDirectoryHandleName(context), '清除本地备份目录名称失败'],
  ] as const)('keeps %s localStorage failures swallowed when warning logging fails', (
    _name,
    action,
    message,
  ) => {
    const storageError = new Error('localStorage remove unavailable');
    stubLocalStorage({
      removeItem: vi.fn(() => { throw storageError; }),
    });
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger unavailable');
    });

    expect(action).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(message, storageError);
  });

  it('keeps IndexedDB failures swallowed when warning logging fails', async () => {
    const idbError = new Error('IndexedDB unavailable');
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    controller = new LocalBackupPersistenceController({
      logger,
      idbGet: async () => { throw idbError; },
      idbSet: async () => { throw idbError; },
      idbDel: async () => { throw idbError; },
    });

    context = controller.activateOwnerScope(AUTH_A);
    await expect(controller.restoreDirectoryHandle(context)).resolves.toBeNull();
    await expect(controller.saveDirectoryHandle(
      context,
      { name: 'backups', kind: 'directory' } as FileSystemDirectoryHandle,
    ))
      .resolves.toBeUndefined();
    await expect(controller.clearDirectoryHandle(context)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('从 IndexedDB 恢复 DirectoryHandle 失败', idbError);
    expect(logger.warn).toHaveBeenCalledWith('保存 DirectoryHandle 到 IndexedDB 失败', idbError);
    expect(logger.warn).toHaveBeenCalledWith('清除 IndexedDB 中的 DirectoryHandle 失败', idbError);
  });

  function saveOwnerState(ownerContext: LocalBackupOwnerContext, directoryName: string): void {
    controller.saveState(ownerContext, {
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
      directoryName,
    });
  }

  function emptyState(): ReturnType<LocalBackupPersistenceController['loadState']> {
    return {
      lastBackupTime: null,
      autoBackupEnabled: false,
      autoBackupIntervalMs: LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS,
      directoryName: null,
      hasSavedHandle: false,
    };
  }
});
