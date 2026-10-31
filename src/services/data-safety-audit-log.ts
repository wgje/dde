import {
  buildLastWriteExplain,
  type BuildLastWriteExplainInput,
  type DataSafetyLastWriteExplain,
  type DataSafetyReplayEntry,
} from './data-safety-package';

export interface DataSafetyAuditLogOptions {
  maxEntries: number;
}

export interface DataSafetyAuditLogSnapshot {
  replayLog: DataSafetyReplayEntry[];
  lastWriteExplain: DataSafetyLastWriteExplain | null;
}

export class DataSafetyAuditLog {
  private readonly maxEntries: number;
  private entries: DataSafetyReplayEntry[] = [];
  private latestExplain: DataSafetyLastWriteExplain | null = null;

  constructor(options: DataSafetyAuditLogOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
  }

  get replayLog(): DataSafetyReplayEntry[] {
    return [...this.entries];
  }

  get lastWriteExplain(): DataSafetyLastWriteExplain | null {
    return this.latestExplain;
  }

  recordWrite(input: BuildLastWriteExplainInput): DataSafetyLastWriteExplain {
    const explain = buildLastWriteExplain(input);
    const replayEntry: DataSafetyReplayEntry = {
      operationId: explain.operationId,
      entityType: explain.entity.type,
      entityId: explain.entity.id,
      operation: explain.operation,
      writeIntent: explain.writeIntent,
      sourceUserId: explain.actor.sourceUserId,
      localCommittedAt: explain.localTimestamp,
      baseUpdatedAt: explain.updatedAtBaseline,
      queue: explain.queueResult,
      rpc: explain.rpcResult,
      lww: explain.lwwDecision,
      lastSyncTime: explain.lastSyncTime,
      conflict: explain.conflict,
    };

    this.entries = [...this.entries, replayEntry].slice(-this.maxEntries);
    this.latestExplain = explain;
    return explain;
  }

  hydrate(snapshot: DataSafetyAuditLogSnapshot): void {
    this.entries = snapshot.replayLog.slice(-this.maxEntries);
    this.latestExplain = snapshot.lastWriteExplain;
  }

  snapshot(): DataSafetyAuditLogSnapshot {
    return {
      replayLog: this.replayLog,
      lastWriteExplain: this.latestExplain,
    };
  }
}
