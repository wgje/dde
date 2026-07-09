import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBackupDirectoryFilesController } from './local-backup-directory-files.controller';

describe('LocalBackupDirectoryFilesController', () => {
  let logger: {
    debug: ReturnType<typeof vi.fn<(message: string, context?: unknown) => void>>;
    warn: ReturnType<typeof vi.fn<(message: string, context?: unknown) => void>>;
    error: ReturnType<typeof vi.fn<(message: string, context?: unknown) => void>>;
  };
  let stale: ReturnType<typeof vi.fn<(error: unknown) => boolean>>;
  let invalidate: ReturnType<typeof vi.fn<(notifyUser: boolean) => Promise<void>>>;
  let controller: LocalBackupDirectoryFilesController;

  beforeEach(() => {
    logger = {
      debug: vi.fn<(message: string, context?: unknown) => void>(),
      warn: vi.fn<(message: string, context?: unknown) => void>(),
      error: vi.fn<(message: string, context?: unknown) => void>(),
    };
    stale = vi.fn<(error: unknown) => boolean>(() => false);
    invalidate = vi.fn<(notifyUser: boolean) => Promise<void>>(async () => undefined);
    controller = new LocalBackupDirectoryFilesController({
      logger,
      isStaleDirectoryHandleError: stale,
      invalidateDirectoryHandle: invalidate,
    });
  });

  it('writes a backup file and verifies the written size', async () => {
    const blob = new Blob(['backup']);
    const written: Blob[] = [];
    const fileHandle = {
      createWritable: vi.fn(async () => ({
        write: vi.fn(async (nextBlob: Blob) => { written.push(nextBlob); }),
        close: vi.fn(async () => undefined),
      })),
      getFile: vi.fn(async () => new File(['backup'], 'backup.json')),
    } as unknown as FileSystemFileHandle;
    const directory = directoryHandle({
      getFileHandle: vi.fn(async () => fileHandle),
      values: async function* () {},
    });

    await controller.writeBackupFile(directory, 'backup.json', blob);

    expect(directory.getFileHandle).toHaveBeenCalledWith('backup.json', { create: true });
    expect(written).toEqual([blob]);
    expect(logger.warn).not.toHaveBeenCalledWith('备份文件验证失败，但文件已写入');
  });

  it('fails the write before retention cleanup when size verification fails', async () => {
    const blob = new Blob(['backup']);
    const fileHandle = {
      createWritable: vi.fn(async () => ({
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      })),
      getFile: vi.fn(async () => new File(['truncated'], 'backup.json')),
    } as unknown as FileSystemFileHandle;
    const directory = directoryHandle({
      getFileHandle: vi.fn(async () => fileHandle),
      values: vi.fn(async function* () {}),
      removeEntry: vi.fn(),
    });

    await expect(controller.writeBackupFile(directory, 'backup.json', blob))
      .rejects.toThrow('备份文件写入验证失败');

    expect(directory.removeEntry).not.toHaveBeenCalled();
  });

  it('lists backup files newest first and ignores non-backup files', async () => {
    const directory = directoryHandle({
      values: async function* (): AsyncIterableIterator<FileSystemHandle> {
        yield fileSystemHandle('nanoflow-backup-2026-06-09_12-30-45.json');
        yield fileSystemHandle('notes.json');
        yield fileSystemHandle('nanoflow-backup-2026-06-10_12-30-45.json');
      },
      getFileHandle: vi.fn(async (name: string) => fileSystemFileHandle(name, new File(['x'], name))),
    });

    await expect(controller.listBackupFiles(directory, async () => true)).resolves.toEqual([
      {
        name: 'nanoflow-backup-2026-06-10_12-30-45.json',
        timestamp: new Date(2026, 5, 10, 12, 30, 45).getTime(),
        size: 1,
      },
      {
        name: 'nanoflow-backup-2026-06-09_12-30-45.json',
        timestamp: new Date(2026, 5, 9, 12, 30, 45).getTime(),
        size: 1,
      },
    ]);
  });

  it('cleans up old backup files beyond the retention limit', async () => {
    const removed: string[] = [];
    const directory = directoryHandle({
      values: async function* (): AsyncIterableIterator<FileSystemHandle> {
        yield fileSystemHandle('nanoflow-backup-2026-06-09_12-30-45.json');
        yield fileSystemHandle('nanoflow-backup-2026-06-10_12-30-45.json');
      },
      removeEntry: vi.fn(async (name: string) => { removed.push(name); }),
    });

    await controller.cleanupOldBackups(directory, 1);

    expect(removed).toEqual(['nanoflow-backup-2026-06-09_12-30-45.json']);
  });

  it('invalidates stale handles when listing or reading fails with stale state', async () => {
    stale.mockReturnValue(true);
    const error = new DOMException('state changed', 'InvalidStateError');
    const directory = directoryHandle({
      values: async function* (): AsyncIterableIterator<FileSystemHandle> {
        throw error;
      },
      getFileHandle: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(controller.listBackupFiles(directory, async () => true)).resolves.toEqual([]);
    await expect(controller.readBackupFile(directory, 'backup.json', async () => true)).resolves.toBeNull();
    expect(invalidate).toHaveBeenCalledWith(true);
  });
});

function directoryHandle(overrides: Partial<FileSystemDirectoryHandle>): FileSystemDirectoryHandle {
  return {
    name: 'backups',
    kind: 'directory',
    getFileHandle: vi.fn(),
    removeEntry: vi.fn(),
    values: vi.fn(),
    ...overrides,
  } as unknown as FileSystemDirectoryHandle;
}

function fileSystemHandle(name: string): FileSystemHandle {
  return {
    kind: 'file',
    name,
    isSameEntry: vi.fn(async () => false),
    queryPermission: vi.fn(async () => 'granted' as PermissionState),
    requestPermission: vi.fn(async () => 'granted' as PermissionState),
  };
}

function fileSystemFileHandle(name: string, file: File): FileSystemFileHandle {
  return {
    ...fileSystemHandle(name),
    kind: 'file',
    createWritable: vi.fn(),
    getFile: vi.fn(async () => file),
  } as unknown as FileSystemFileHandle;
}
