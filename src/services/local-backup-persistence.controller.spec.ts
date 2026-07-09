import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_BACKUP_CONFIG } from '../config/local-backup.config';
import {
  LocalBackupPersistenceController,
  type LocalBackupPersistenceLogger,
} from './local-backup-persistence.controller';

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads local backup state from localStorage', () => {
    localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME, '2026-06-09T12:00:00.000Z');
    localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_ENABLED, 'true');
    localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_INTERVAL, '900000');
    localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE, 'backups');

    expect(controller.loadState()).toEqual({
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
      directoryName: 'backups',
      hasSavedHandle: true,
    });
  });

  it('saves local backup state without persisting an empty directory name', () => {
    controller.saveState({
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: false,
      autoBackupIntervalMs: 600000,
      directoryName: null,
    });

    expect(localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME))
      .toBe('2026-06-09T12:00:00.000Z');
    expect(localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_ENABLED))
      .toBe('false');
    expect(localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_INTERVAL))
      .toBe('600000');
    expect(localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE))
      .toBeNull();
  });

  it('clears all persisted local backup state and can clear only the directory name', () => {
    Object.values(LOCAL_BACKUP_CONFIG.STORAGE_KEYS)
      .forEach(key => localStorage.setItem(key, 'value'));

    controller.clearDirectoryHandleName();

    expect(localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE)).toBeNull();
    expect(localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_ENABLED)).toBe('value');

    controller.clearState();

    Object.values(LOCAL_BACKUP_CONFIG.STORAGE_KEYS)
      .forEach(key => expect(localStorage.getItem(key)).toBeNull());
  });

  it('persists, restores, and clears the directory handle through IndexedDB adapters', async () => {
    const handle = { name: 'backups', kind: 'directory' } as FileSystemDirectoryHandle;

    await controller.saveDirectoryHandle(handle);
    await expect(controller.restoreDirectoryHandle()).resolves.toBe(handle);

    await controller.clearDirectoryHandle();
    await expect(controller.restoreDirectoryHandle()).resolves.toBeNull();
  });

  it('returns the default state when localStorage read and warning logging both fail', () => {
    const storageError = new Error('localStorage unavailable');
    stubLocalStorage({
      getItem: vi.fn(() => { throw storageError; }),
    });
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger unavailable');
    });

    expect(controller.loadState()).toEqual({
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

    expect(() => controller.saveState({
      lastBackupTime: '2026-06-09T12:00:00.000Z',
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
      directoryName: 'backups',
    })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith('保存本地备份持久化状态失败', storageError);
  });

  it.each([
    ['clearState', () => controller.clearState(), '清除本地备份持久化状态失败'],
    ['clearDirectoryHandleName', () => controller.clearDirectoryHandleName(), '清除本地备份目录名称失败'],
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

    await expect(controller.restoreDirectoryHandle()).resolves.toBeNull();
    await expect(controller.saveDirectoryHandle({ name: 'backups', kind: 'directory' } as FileSystemDirectoryHandle))
      .resolves.toBeUndefined();
    await expect(controller.clearDirectoryHandle()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('从 IndexedDB 恢复 DirectoryHandle 失败', idbError);
    expect(logger.warn).toHaveBeenCalledWith('保存 DirectoryHandle 到 IndexedDB 失败', idbError);
    expect(logger.warn).toHaveBeenCalledWith('清除 IndexedDB 中的 DirectoryHandle 失败', idbError);
  });
});
