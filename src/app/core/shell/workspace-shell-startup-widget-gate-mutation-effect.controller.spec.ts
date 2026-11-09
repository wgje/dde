import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellStartupWidgetGateMutationEffectController } from './workspace-shell-startup-widget-gate-mutation-effect.controller';

const mutation = {
  intent: 'mark-gate-read' as const,
  widgetGateEntryId: 'entry-1',
};

function createController() {
  const applyMutation = vi.fn();
  const clearDeferredStartupEntryIntent = vi.fn();
  const warn = vi.fn();
  const controller = new WorkspaceShellStartupWidgetGateMutationEffectController({
    applyMutation,
    clearDeferredStartupEntryIntent,
    warn,
  });

  return {
    applyMutation,
    clearDeferredStartupEntryIntent,
    controller,
    warn,
  };
}

describe('WorkspaceShellStartupWidgetGateMutationEffectController', () => {
  it('forwards the widget gate mutation input', () => {
    const { applyMutation, controller } = createController();

    controller.apply(mutation, null);

    expect(applyMutation).toHaveBeenCalledWith(mutation);
  });

  it('clears the deferred intent only after the mutation succeeds', async () => {
    const {
      applyMutation,
      clearDeferredStartupEntryIntent,
      controller,
    } = createController();
    let resolveMutation!: () => void;
    applyMutation.mockImplementation(() => new Promise<void>(resolve => {
      resolveMutation = resolve;
    }));

    controller.apply(mutation, {
      clearDeferredAfterSuccess: true,
      onFailure: vi.fn(),
    });

    expect(clearDeferredStartupEntryIntent).not.toHaveBeenCalled();

    resolveMutation();

    await vi.waitFor(() => expect(clearDeferredStartupEntryIntent).toHaveBeenCalledTimes(1));
  });

  it('does not clear the deferred intent when the sync context does not own it', async () => {
    const {
      applyMutation,
      clearDeferredStartupEntryIntent,
      controller,
    } = createController();
    applyMutation.mockResolvedValue(undefined);

    controller.apply(mutation, {
      clearDeferredAfterSuccess: false,
      onFailure: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(clearDeferredStartupEntryIntent).not.toHaveBeenCalled();
  });

  it('warns and releases the caller retry boundary when the mutation rejects', async () => {
    const { applyMutation, controller, warn } = createController();
    const error = new Error('mutation rejected');
    const onFailure = vi.fn();
    applyMutation.mockRejectedValue(error);

    controller.apply(mutation, {
      clearDeferredAfterSuccess: true,
      onFailure,
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry widget gate mutation failed',
      error,
    ));
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('isolates synchronously thrown mutation failures', () => {
    const { applyMutation, controller, warn } = createController();
    const error = new Error('mutation threw');
    const onFailure = vi.fn();
    applyMutation.mockImplementation(() => {
      throw error;
    });

    expect(() => controller.apply(mutation, {
      clearDeferredAfterSuccess: true,
      onFailure,
    })).not.toThrow();

    expect(warn).toHaveBeenCalledWith('Startup entry widget gate mutation failed', error);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('does not require a retry callback for direct apply calls', async () => {
    const { applyMutation, controller, warn } = createController();
    const error = new Error('direct mutation rejected');
    applyMutation.mockRejectedValue(error);

    controller.apply(mutation, null);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry widget gate mutation failed',
      error,
    ));
  });

  it('isolates warning sink failures', async () => {
    const { applyMutation, controller, warn } = createController();
    const onFailure = vi.fn();
    applyMutation.mockRejectedValue(new Error('mutation rejected'));
    warn.mockImplementation(() => {
      throw new Error('warning sink failed');
    });

    controller.apply(mutation, {
      clearDeferredAfterSuccess: true,
      onFailure,
    });

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
  });

  it('suppresses late mutation settlement after teardown', async () => {
    const {
      applyMutation,
      clearDeferredStartupEntryIntent,
      controller,
      warn,
    } = createController();
    let rejectMutation!: (reason?: unknown) => void;
    applyMutation.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectMutation = reject;
    }));
    const error = new Error('late mutation rejection');
    const onFailure = vi.fn();

    controller.apply(mutation, {
      clearDeferredAfterSuccess: true,
      onFailure,
    });
    controller.teardown();
    rejectMutation(error);
    await Promise.resolve();
    await Promise.resolve();

    expect(clearDeferredStartupEntryIntent).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
