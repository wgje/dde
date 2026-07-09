import type { DataSafetyAuditLogSnapshot } from './data-safety-audit-log';
import type { DataSafetyLastWriteExplain, DataSafetyReplayEntry } from './data-safety-package';

const DEFAULT_MAX_ENTRIES = 100;
const STORAGE_KEY_PREFIX = 'nanoflow.data-safety-audit';

export interface DataSafetyAuditPersistenceOptions {
  maxEntries?: number;
  storage?: Storage;
}

export class DataSafetyAuditPersistence {
  private readonly maxEntries: number;
  private readonly storage: Storage | null;

  constructor(options: DataSafetyAuditPersistenceOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.storage = options.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  }

  load(ownerUserId: string | null | undefined): DataSafetyAuditLogSnapshot {
    const key = this.resolveKey(ownerUserId);
    if (!key || !this.storage) {
      return this.emptySnapshot();
    }

    try {
      const raw = this.storage.getItem(key);
      if (!raw) return this.emptySnapshot();
      const parsed = JSON.parse(raw);
      return this.normalizeSnapshot(parsed);
    } catch {
      return this.emptySnapshot();
    }
  }

  save(ownerUserId: string | null | undefined, snapshot: DataSafetyAuditLogSnapshot): boolean {
    const key = this.resolveKey(ownerUserId);
    if (!key || !this.storage) {
      return false;
    }

    const normalized = this.normalizeSnapshot(snapshot);
    try {
      this.storage.setItem(key, JSON.stringify(normalized));
      return true;
    } catch {
      return false;
    }
  }

  private normalizeSnapshot(value: unknown): DataSafetyAuditLogSnapshot {
    if (!value || typeof value !== 'object') {
      return this.emptySnapshot();
    }
    const record = value as Record<string, unknown>;
    const replayLog = Array.isArray(record['replayLog'])
      ? record['replayLog'].filter(isReplayEntry).slice(-this.maxEntries)
      : [];
    const lastWriteExplain = isLastWriteExplain(record['lastWriteExplain'])
      ? record['lastWriteExplain']
      : null;

    return { replayLog, lastWriteExplain };
  }

  private emptySnapshot(): DataSafetyAuditLogSnapshot {
    return { replayLog: [], lastWriteExplain: null };
  }

  private resolveKey(ownerUserId: string | null | undefined): string | null {
    if (!ownerUserId) return null;
    return `${STORAGE_KEY_PREFIX}.${ownerUserId}`;
  }
}

function isReplayEntry(value: unknown): value is DataSafetyReplayEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['operationId'] === 'string'
    && typeof record['entityType'] === 'string'
    && typeof record['entityId'] === 'string'
    && typeof record['operation'] === 'string'
    && typeof record['localCommittedAt'] === 'number'
    && !!record['queue']
    && !!record['rpc']
    && !!record['lww']
    && !!record['lastSyncTime'];
}

function isLastWriteExplain(value: unknown): value is DataSafetyLastWriteExplain {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['operationId'] === 'string'
    && typeof record['operation'] === 'string'
    && typeof record['localTimestamp'] === 'number'
    && !!record['actor']
    && !!record['entity']
    && !!record['queueResult']
    && !!record['rpcResult']
    && !!record['lwwDecision']
    && !!record['lastSyncTime'];
}
