import type { BlackBoxEntry } from '../models/focus';

export interface LocalBackupUiBlackBoxPersistedEntry extends BlackBoxEntry {
  _localVersion?: number | string;
}

export interface LocalBackupUiBlackBoxRestoreSnapshot {
  schemaVersion: 1;
  ownerUserId: string;
  sourceDigest: string;
  before: LocalBackupUiBlackBoxPersistedEntry[];
  target: LocalBackupUiBlackBoxPersistedEntry[];
}

export interface LocalBackupUiBlackBoxRestoreDependencies {
  createGeneration(): string;
  withDatabase<T>(
    operation: (db: IDBDatabase, storeName: string) => Promise<T>,
  ): Promise<T>;
  publish(entries: BlackBoxEntry[]): void;
}
