import { LOCAL_BACKUP_CONFIG } from '../config/local-backup.config';
import {
  getOldLocalBackupFilesToDelete,
  parseLocalBackupTimestampFromFilename,
} from './local-backup-file.helpers';

export interface LocalBackupFileInfo {
  name: string;
  timestamp: number;
  size: number;
}

interface LocalBackupDirectoryFilesLogger {
  debug(message: string, context?: unknown): void;
  info?(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

interface LocalBackupDirectoryFilesControllerOptions {
  logger: LocalBackupDirectoryFilesLogger;
  isStaleDirectoryHandleError: (error: unknown) => boolean;
  invalidateDirectoryHandle: (notifyUser: boolean) => Promise<void>;
}

export class LocalBackupDirectoryFilesController {
  constructor(private readonly options: LocalBackupDirectoryFilesControllerOptions) {}

  async writeBackupFile(
    directoryHandle: FileSystemDirectoryHandle,
    filename: string,
    blob: Blob
  ): Promise<void> {
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    if (LOCAL_BACKUP_CONFIG.VALIDATION.VERIFY_WRITE) {
      const verified = await this.verifyBackupFile(fileHandle, blob.size);
      if (!verified) {
        throw new Error('备份文件写入验证失败');
      }
    }

    await this.cleanupOldBackups(directoryHandle);
  }

  async cleanupOldBackups(
    directoryHandle: FileSystemDirectoryHandle,
    maxBackupFiles: number = LOCAL_BACKUP_CONFIG.MAX_BACKUP_FILES
  ): Promise<void> {
    try {
      const backupFiles: { name: string; timestamp: number }[] = [];

      for await (const entry of directoryHandle.values()) {
        if (entry.kind === 'file' && entry.name.startsWith(LOCAL_BACKUP_CONFIG.FILENAME_PREFIX)) {
          const timestamp = parseLocalBackupTimestampFromFilename(entry.name);
          if (timestamp) {
            backupFiles.push({ name: entry.name, timestamp });
          }
        }
      }

      const toDelete = getOldLocalBackupFilesToDelete(backupFiles, maxBackupFiles);

      for (const file of toDelete) {
        try {
          await directoryHandle.removeEntry(file.name);
          this.options.logger.debug('已删除旧备份', { filename: file.name });
        } catch (error) {
          if (this.options.isStaleDirectoryHandleError(error)) {
            throw error;
          }

          this.options.logger.warn('删除旧备份失败', { filename: file.name, error });
        }
      }

      if (toDelete.length > 0) {
        this.options.logger.info?.(`清理了 ${toDelete.length} 个旧备份文件`);
      }
    } catch (error) {
      if (this.options.isStaleDirectoryHandleError(error)) {
        throw error;
      }

      this.options.logger.warn('清理旧备份时出错', error);
    }
  }

  async listBackupFiles(
    directoryHandle: FileSystemDirectoryHandle,
    checkPermission: () => Promise<boolean>
  ): Promise<LocalBackupFileInfo[]> {
    const hasPermission = await checkPermission();
    if (!hasPermission) {
      return [];
    }

    try {
      const files: LocalBackupFileInfo[] = [];

      for await (const entry of directoryHandle.values()) {
        if (entry.kind === 'file' && entry.name.startsWith(LOCAL_BACKUP_CONFIG.FILENAME_PREFIX)) {
          const timestamp = parseLocalBackupTimestampFromFilename(entry.name);
          if (timestamp) {
            const fileHandle = await directoryHandle.getFileHandle(entry.name);
            const file = await fileHandle.getFile();
            files.push({ name: entry.name, timestamp, size: file.size });
          }
        }
      }

      return files.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      if (this.options.isStaleDirectoryHandleError(error)) {
        await this.options.invalidateDirectoryHandle(true);
        return [];
      }

      this.options.logger.error('列出备份文件失败', error);
      return [];
    }
  }

  async readBackupFile(
    directoryHandle: FileSystemDirectoryHandle,
    filename: string,
    checkPermission: () => Promise<boolean>
  ): Promise<File | null> {
    const hasPermission = await checkPermission();
    if (!hasPermission) {
      return null;
    }

    try {
      const fileHandle = await directoryHandle.getFileHandle(filename);
      return await fileHandle.getFile();
    } catch (error) {
      if (this.options.isStaleDirectoryHandleError(error)) {
        await this.options.invalidateDirectoryHandle(true);
        return null;
      }

      this.options.logger.error('读取备份文件失败', { filename, error });
      return null; // eslint-disable-line no-restricted-syntax -- 文件读取失败时"无法获取"语义正确，null 触发调用方错误提示
    }
  }

  private async verifyBackupFile(
    fileHandle: FileSystemFileHandle,
    expectedSize: number
  ): Promise<boolean> {
    try {
      const file = await fileHandle.getFile();
      return file.size === expectedSize;
    } catch (e) {
      this.options.logger.debug('验证备份文件失败', { error: e, expectedSize });
      return false;
    }
  }
}
