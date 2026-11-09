import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellProjectSubscriptionController,
  type WorkspaceShellProjectSubscriptionControllerOptions,
} from './workspace-shell-project-subscription.controller';

type RejectHandler = (error: unknown) => unknown;

function createCatchControlledPromise() {
  let reject: RejectHandler | null = null;
  const promise = {
    catch: vi.fn((handler: RejectHandler) => {
      reject = handler;
      return Promise.resolve();
    }),
  } as unknown as Promise<unknown>;

  return {
    promise,
    reject: (error: unknown) => reject?.(error),
  };
}

function createController(
  overrides: Partial<WorkspaceShellProjectSubscriptionControllerOptions> = {},
) {
  let enabled = true;
  let ready = true;
  let currentUserId: string | null = 'user-1';
  let activeProjectId: string | null = 'project-1';
  const subscribeToProject = vi.fn<(projectId: string, userId: string) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  const unsubscribeFromProject = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  const warn = vi.fn();
  const controllerOptions = {
    isEnabled: () => enabled,
    isReady: () => ready,
    currentUserId: () => currentUserId,
    activeProjectId: () => activeProjectId,
    subscribeToProject,
    unsubscribeFromProject,
    warn,
    ...overrides,
  } as WorkspaceShellProjectSubscriptionControllerOptions & {
    warn: (message: string, context?: unknown) => void;
  };
  const controller = new WorkspaceShellProjectSubscriptionController(controllerOptions);

  return {
    controller,
    setActiveProjectId: (projectId: string | null) => {
      activeProjectId = projectId;
    },
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    subscribeToProject,
    unsubscribeFromProject,
    warn,
  };
}

describe('WorkspaceShellProjectSubscriptionController', () => {
  it('does not subscribe while project subscription is disabled', () => {
    const { controller, setEnabled, subscribeToProject, unsubscribeFromProject } = createController();
    setEnabled(false);

    controller.sync();

    expect(subscribeToProject).not.toHaveBeenCalled();
    expect(unsubscribeFromProject).not.toHaveBeenCalled();
  });

  it('subscribes to the active project once when ready', () => {
    const { controller, subscribeToProject } = createController();

    controller.sync();
    controller.sync();

    expect(subscribeToProject).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledWith('project-1', 'user-1');
  });

  it('subscribes to a new project when the active project changes', () => {
    const { controller, setActiveProjectId, subscribeToProject, unsubscribeFromProject } = createController();

    controller.sync();
    setActiveProjectId('project-2');
    controller.sync();

    expect(subscribeToProject).toHaveBeenCalledTimes(2);
    expect(subscribeToProject).toHaveBeenLastCalledWith('project-2', 'user-1');
    expect(unsubscribeFromProject).not.toHaveBeenCalled();
  });

  it('resubscribes when the current user changes for the same active project', () => {
    const { controller, setCurrentUserId, subscribeToProject } = createController();

    controller.sync();
    setCurrentUserId('user-2');
    controller.sync();

    expect(subscribeToProject).toHaveBeenCalledTimes(2);
    expect(subscribeToProject).toHaveBeenNthCalledWith(1, 'project-1', 'user-1');
    expect(subscribeToProject).toHaveBeenNthCalledWith(2, 'project-1', 'user-2');
  });

  it('unsubscribes when project subscription becomes disabled after subscribing', () => {
    const { controller, setEnabled, unsubscribeFromProject } = createController();

    controller.sync();
    setEnabled(false);
    controller.sync();
    controller.sync();

    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes once when readiness is lost after a subscription', () => {
    const { controller, setReady, unsubscribeFromProject } = createController();

    controller.sync();
    setReady(false);
    controller.sync();
    controller.sync();

    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when the active project is cleared', () => {
    const { controller, setActiveProjectId, unsubscribeFromProject } = createController();

    controller.sync();
    setActiveProjectId(null);
    controller.sync();

    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
  });

  it('clears the current subscription once and allows a later resubscribe', () => {
    const { controller, subscribeToProject, unsubscribeFromProject } = createController();

    controller.sync();
    controller.clear();
    controller.clear();
    controller.sync();

    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledTimes(2);
  });

  it('waits for both a confirmed user and readiness before subscribing', () => {
    const { controller, setCurrentUserId, setReady, subscribeToProject } = createController();
    setCurrentUserId(null);
    setReady(false);

    controller.sync();
    setReady(true);
    controller.sync();
    expect(subscribeToProject).not.toHaveBeenCalled();

    setCurrentUserId('user-1');
    controller.sync();
    expect(subscribeToProject).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying the same project when subscription fails', () => {
    const failedSubscribe = createCatchControlledPromise();
    const error = new Error('subscribe failed');
    const {
      controller,
      subscribeToProject,
      warn,
    } = createController();
    subscribeToProject
      .mockReturnValueOnce(failedSubscribe.promise)
      .mockResolvedValue(undefined);

    controller.sync();
    failedSubscribe.reject(error);
    controller.sync();

    expect(failedSubscribe.promise.catch).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('项目订阅失败，已允许下次同步重试', {
      error,
      projectId: 'project-1',
      userId: 'user-1',
    });
  });

  it('catches synchronous subscribe failures and allows retrying the same project', () => {
    const error = new Error('subscribe threw');
    const {
      controller,
      subscribeToProject,
      warn,
    } = createController();
    subscribeToProject
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValue(undefined);

    expect(() => controller.sync()).not.toThrow();
    controller.sync();

    expect(subscribeToProject).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('项目订阅失败，已允许下次同步重试', {
      error,
      projectId: 'project-1',
      userId: 'user-1',
    });
  });

  it('warns when project unsubscribe fails without blocking a later resubscribe', () => {
    const failedUnsubscribe = createCatchControlledPromise();
    const error = new Error('unsubscribe failed');
    const {
      controller,
      setActiveProjectId,
      subscribeToProject,
      unsubscribeFromProject,
      warn,
    } = createController();
    unsubscribeFromProject
      .mockReturnValueOnce(failedUnsubscribe.promise)
      .mockResolvedValue(undefined);

    controller.sync();
    setActiveProjectId(null);
    controller.sync();
    failedUnsubscribe.reject(error);
    setActiveProjectId('project-1');
    controller.sync();

    expect(failedUnsubscribe.promise.catch).toHaveBeenCalledTimes(1);
    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('项目订阅取消失败，已继续后续同步流程', {
      error,
      projectId: 'project-1',
    });
  });

  it('catches synchronous unsubscribe failures without blocking a later resubscribe', () => {
    const error = new Error('unsubscribe threw');
    const {
      controller,
      setActiveProjectId,
      subscribeToProject,
      unsubscribeFromProject,
      warn,
    } = createController();
    unsubscribeFromProject
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValue(undefined);

    controller.sync();
    setActiveProjectId(null);
    expect(() => controller.sync()).not.toThrow();
    setActiveProjectId('project-1');
    controller.sync();

    expect(unsubscribeFromProject).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('项目订阅取消失败，已继续后续同步流程', {
      error,
      projectId: 'project-1',
    });
  });

  it('isolates warn failures after subscribe rejection and still allows retry', () => {
    const failedSubscribe = createCatchControlledPromise();
    const subscribeError = new Error('subscribe failed');
    const warnError = new Error('warn failed');
    const {
      controller,
      subscribeToProject,
      warn,
    } = createController();
    subscribeToProject
      .mockReturnValueOnce(failedSubscribe.promise)
      .mockResolvedValue(undefined);
    warn.mockImplementationOnce(() => {
      throw warnError;
    });

    controller.sync();
    expect(() => failedSubscribe.reject(subscribeError)).not.toThrow();
    controller.sync();

    expect(subscribeToProject).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('项目订阅失败，已允许下次同步重试', {
      error: subscribeError,
      projectId: 'project-1',
      userId: 'user-1',
    });
  });
});
