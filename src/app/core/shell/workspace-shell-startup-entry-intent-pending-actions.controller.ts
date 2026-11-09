export interface WorkspaceShellStartupEntryIntentPendingActionsController {
  markSyncPending(): void;
  markFlushPending(): void;
  flush(delegate: WorkspaceShellStartupEntryIntentPendingActionsDelegate): void;
  clear(): void;
}

export interface WorkspaceShellStartupEntryIntentPendingActionsDelegate {
  sync(): void;
  flushWidgetWorkspaceGateRecheck(): void;
}

export function createWorkspaceShellStartupEntryIntentPendingActionsController():
  WorkspaceShellStartupEntryIntentPendingActionsController {
  let syncPending = false;
  let flushPending = false;

  return {
    markSyncPending(): void {
      syncPending = true;
    },

    markFlushPending(): void {
      flushPending = true;
    },

    flush(delegate: WorkspaceShellStartupEntryIntentPendingActionsDelegate): void {
      const shouldSync = syncPending;
      const shouldFlush = flushPending;

      if (shouldSync) {
        delegate.sync();
        syncPending = false;
      }
      if (shouldFlush) {
        delegate.flushWidgetWorkspaceGateRecheck();
        flushPending = false;
      }
    },

    clear(): void {
      syncPending = false;
      flushPending = false;
    },
  };
}
