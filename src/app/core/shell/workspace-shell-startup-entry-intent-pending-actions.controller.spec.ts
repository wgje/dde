import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupEntryIntentPendingActionsController,
} from './workspace-shell-startup-entry-intent-pending-actions.controller';

function createDelegate() {
  return {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    sync: vi.fn(),
  };
}

describe('WorkspaceShellStartupEntryIntentPendingActionsController', () => {
  it('flushes queued sync before widget gate recheck and clears both actions', () => {
    const pendingActions = createWorkspaceShellStartupEntryIntentPendingActionsController();
    const delegate = createDelegate();
    const events: string[] = [];

    delegate.sync.mockImplementation(() => events.push('sync'));
    delegate.flushWidgetWorkspaceGateRecheck.mockImplementation(() => events.push('flush'));

    pendingActions.markFlushPending();
    pendingActions.markSyncPending();

    pendingActions.flush(delegate);
    pendingActions.flush(delegate);

    expect(events).toEqual(['sync', 'flush']);
    expect(delegate.sync).toHaveBeenCalledOnce();
    expect(delegate.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
  });

  it('clears queued actions without invoking the delegate', () => {
    const pendingActions = createWorkspaceShellStartupEntryIntentPendingActionsController();
    const delegate = createDelegate();

    pendingActions.markSyncPending();
    pendingActions.markFlushPending();
    pendingActions.clear();
    pendingActions.flush(delegate);

    expect(delegate.sync).not.toHaveBeenCalled();
    expect(delegate.flushWidgetWorkspaceGateRecheck).not.toHaveBeenCalled();
  });

  it('keeps pending actions when sync flush throws before widget gate recheck runs', () => {
    const pendingActions = createWorkspaceShellStartupEntryIntentPendingActionsController();
    const delegate = createDelegate();
    const events: string[] = [];
    const error = new Error('sync failed');

    delegate.sync
      .mockImplementationOnce(() => {
        events.push('sync-failed');
        throw error;
      })
      .mockImplementationOnce(() => {
        events.push('sync-retried');
      });
    delegate.flushWidgetWorkspaceGateRecheck.mockImplementation(() => events.push('flush'));

    pendingActions.markSyncPending();
    pendingActions.markFlushPending();

    expect(() => pendingActions.flush(delegate)).toThrow(error);
    pendingActions.flush(delegate);
    pendingActions.flush(delegate);

    expect(events).toEqual(['sync-failed', 'sync-retried', 'flush']);
    expect(delegate.sync).toHaveBeenCalledTimes(2);
    expect(delegate.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
  });
});
