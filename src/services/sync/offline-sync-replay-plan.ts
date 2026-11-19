import {
  compareOfflineSyncCommandOrder,
  type OfflineSyncCommandEnvelope,
  type OfflineSyncCommandStatus,
} from './offline-sync-command-envelope';
import type { OfflineCommandRecord } from './offline-command-store';
import { OfflineSyncDependencyBuffer } from './offline-sync-dependency-buffer';

export interface OfflineSyncReplayPlan {
  readonly ready: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[];
  readonly requiresReconciliation: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[];
  readonly terminal: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[];
  readonly deferredByDependency: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[];
}

const REPLAYABLE_STATUSES: readonly OfflineSyncCommandStatus[] = ['pending', 'sent'];
const TERMINAL_STATUSES: readonly OfflineSyncCommandStatus[] = ['acked', 'rejected', 'superseded'];

export function buildOfflineSyncReplayPlan(
  commands: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[],
): OfflineSyncReplayPlan {
  const ordered = [...commands].sort((left, right) => compareOfflineSyncCommandOrder(left.command, right.command));
  const terminal = ordered.filter(command => TERMINAL_STATUSES.includes(command.status));
  const buffer = new OfflineSyncDependencyBuffer(terminal.map(command => command.operationId));
  const ready: OfflineCommandRecord<OfflineSyncCommandEnvelope>[] = [];
  for (const command of ordered.filter(item => REPLAYABLE_STATUSES.includes(item.status))) {
    ready.push(...buffer.add(command).ready);
  }
  return {
    ready,
    requiresReconciliation: ordered.filter(command => command.status === 'unknown'),
    terminal,
    deferredByDependency: buffer.pendingRecords(),
  };
}