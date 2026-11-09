import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceShellStartupQueryCleanupController } from './workspace-shell-startup-query-cleanup.controller';

function createController() {
  const navigate = vi.fn();
  const resolveNavigation = vi.fn().mockReturnValue([
    '/projects',
    'project-1',
    'task',
    'task-1',
  ]);
  const warn = vi.fn();
  const controller = new WorkspaceShellStartupQueryCleanupController({
    resolveNavigation,
    navigate,
    warn,
  });

  return {
    controller,
    navigate,
    resolveNavigation,
    warn,
  };
}

describe('WorkspaceShellStartupQueryCleanupController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('navigates to the resolved route and clears the pending cleanup after success', async () => {
    const { controller, navigate, resolveNavigation } = createController();
    navigate.mockResolvedValue(true);

    controller.consume('entry-key');

    expect(controller.isPending('entry-key')).toBe(true);
    expect(resolveNavigation).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      ['/projects', 'project-1', 'task', 'task-1'],
      { replaceUrl: true },
    );
    await vi.waitFor(() => expect(controller.isPending('entry-key')).toBe(false));
  });

  it('does not start duplicate cleanup navigation while the same key is in flight', () => {
    const { controller, navigate } = createController();
    navigate.mockReturnValue(new Promise<void>(() => {}));

    controller.consume('entry-key');
    controller.consume('entry-key');

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('keeps rejected cleanup pending and automatically retries it', async () => {
    vi.useFakeTimers();
    const { controller, navigate, warn } = createController();
    const error = new Error('router rejected cleanup');
    navigate.mockRejectedValueOnce(error).mockResolvedValueOnce(true);

    controller.consume('entry-key');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      error,
    ));
    expect(controller.isPending('entry-key')).toBe(true);

    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.isPending('entry-key')).toBe(false));
  });

  it('treats an unsuccessful router result as retryable', async () => {
    const { controller, navigate, warn } = createController();
    navigate.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    controller.consume('entry-key');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      expect.any(Error),
    ));
    expect(controller.isPending('entry-key')).toBe(true);

    controller.consume('entry-key');

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
  });

  it('keeps synchronously thrown navigation failures retryable', () => {
    const { controller, navigate, warn } = createController();
    const error = new Error('router threw during cleanup');
    navigate.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => controller.consume('entry-key')).not.toThrow();

    expect(warn).toHaveBeenCalledWith('Startup entry query cleanup navigation failed', error);
    expect(controller.isPending('entry-key')).toBe(true);
  });

  it('isolates warning sink failures from the retry boundary', async () => {
    const { controller, navigate, warn } = createController();
    navigate.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    warn.mockImplementation(() => {
      throw new Error('warning sink failed');
    });

    controller.consume('entry-key');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(controller.isPending('entry-key')).toBe(true);
    expect(() => controller.consume('entry-key')).not.toThrow();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
  });

  it('suppresses late failures and clears state after teardown', async () => {
    const { controller, navigate, warn } = createController();
    const error = new Error('late cleanup failure');
    let rejectNavigation!: (reason?: unknown) => void;
    navigate.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectNavigation = reject;
    }));

    controller.consume('entry-key');
    controller.teardown();
    rejectNavigation(error);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.isPending('entry-key')).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      error,
    );
  });
});
