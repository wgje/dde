import type { DeadLetterItem, QueuedAction } from './action-queue.types';

export interface ActionQueueEscapeExportInput {
  pendingActions: readonly QueuedAction[];
  deadLetterQueue: readonly DeadLetterItem[];
  frozenState: boolean;
  freezeReason: string | null;
  exportedAt?: string;
}

export function buildActionQueueEscapeExportJson(input: ActionQueueEscapeExportInput): string {
  return JSON.stringify({
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    pendingActions: input.pendingActions,
    deadLetterQueue: input.deadLetterQueue,
    frozenState: input.frozenState,
    freezeReason: input.freezeReason,
    metadata: { version: 1, source: 'action-queue-escape' },
  }, null, 2);
}

export function buildActionQueueEscapeExportFilename(exportedAt = new Date().toISOString()): string {
  return `nanoflow-pending-sync-${exportedAt.slice(0, 19).replace(/:/g, '-')}.json`;
}

export function downloadActionQueueEscapeExport(json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildActionQueueEscapeExportFilename();
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
