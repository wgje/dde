import { compareOfflineSyncCommandOrder, type OfflineSyncCommandEnvelope } from './offline-sync-command-envelope';
import type { OfflineCommandRecord } from './offline-command-store';

export interface OfflineSyncDependencyDrain {
  readonly ready: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[];
  readonly deferred: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[];
}

/**
 * Holds commands whose declared dependencies have not arrived yet. Once a
 * dependency is added, the buffer drains all newly-ready commands in the
 * deterministic command order.
 */
export class OfflineSyncDependencyBuffer {
  private readonly pending = new Map<string, OfflineCommandRecord<OfflineSyncCommandEnvelope>>();
  private readonly appliedOperationIds = new Set<string>();

  constructor(appliedOperationIds: readonly string[] = []) {
    appliedOperationIds.forEach(operationId => this.appliedOperationIds.add(operationId));
  }

  add(record: OfflineCommandRecord<OfflineSyncCommandEnvelope>): OfflineSyncDependencyDrain {
    if (this.appliedOperationIds.has(record.operationId)) return this.snapshot([]);
    this.pending.set(record.operationId, record);
    return this.drain();
  }

  markApplied(operationId: string): OfflineSyncDependencyDrain {
    this.appliedOperationIds.add(operationId);
    return this.drain();
  }

  pendingRecords(): readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[] {
    return [...this.pending.values()].sort((left, right) => compareOfflineSyncCommandOrder(left.command, right.command));
  }

  private drain(): OfflineSyncDependencyDrain {
    const ready: OfflineCommandRecord<OfflineSyncCommandEnvelope>[] = [];
    while (true) {
      const candidates = [...this.pending.values()]
        .filter(record => record.command.dependencyOperationIds.every(id => this.appliedOperationIds.has(id)))
        .sort((left, right) => compareOfflineSyncCommandOrder(left.command, right.command));
      const next = candidates[0];
      if (!next) break;
      this.pending.delete(next.operationId);
      this.appliedOperationIds.add(next.operationId);
      ready.push(next);
    }
    return this.snapshot(ready);
  }

  private snapshot(ready: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[]): OfflineSyncDependencyDrain {
    return { ready, deferred: this.pendingRecords() };
  }
}