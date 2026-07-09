import { LOCAL_BACKUP_CONFIG } from '../config/local-backup.config';

export interface LocalBackupFileEntry {
  name: string;
  timestamp: number;
}

export function buildLocalBackupFilename(timestamp: string): string {
  return `${LOCAL_BACKUP_CONFIG.FILENAME_PREFIX}-${timestamp}${LOCAL_BACKUP_CONFIG.FILE_EXTENSION}`;
}

export function createLocalBackupTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
}

export function parseLocalBackupTimestampFromFilename(filename: string): number | null {
  if (
    !filename.startsWith(LOCAL_BACKUP_CONFIG.FILENAME_PREFIX) ||
    !filename.endsWith(LOCAL_BACKUP_CONFIG.FILE_EXTENSION)
  ) {
    return null;
  }

  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    parseInt(hour, 10),
    parseInt(minute, 10),
    parseInt(second, 10)
  );

  return date.getTime();
}

export function getOldLocalBackupFilesToDelete<T extends LocalBackupFileEntry>(
  files: T[],
  maxBackupFiles: number = LOCAL_BACKUP_CONFIG.MAX_BACKUP_FILES
): T[] {
  return [...files]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(maxBackupFiles);
}
