import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectShellTaskDeepLinkController,
  type ProjectShellTaskDeepLinkControllerOptions,
} from './project-shell-task-deep-link.controller';

function createControllerOptions(
  overrides: Partial<ProjectShellTaskDeepLinkControllerOptions> = {},
): ProjectShellTaskDeepLinkControllerOptions {
  return {
    projectState: {
      tasks: () => [],
      getTask: () => null,
    },
    syncCoordinator: {
      isLoadingRemote: () => false,
    },
    router: {
      navigate: vi.fn(),
    },
    toast: {
      warning: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    },
    taskOpsAdapter: {
      addFloatingTask: vi.fn(),
    },
    flowCommand: {
      centerOnNode: vi.fn(),
    },
    activateFlowIntent: vi.fn(),
    setActiveView: vi.fn(),
    ...overrides,
  };
}

describe('ProjectShellTaskDeepLinkController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns workspace and navigates back when startup shortcut targets a missing task', () => {
    const warning = vi.fn();
    const navigate = vi.fn();
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      router: { navigate },
      toast: {
        warning,
        info: vi.fn(),
        success: vi.fn(),
      },
      activateFlowIntent,
      setActiveView,
    }));

    const result = controller.handleTaskDeepLink('task-missing', {
      degradeToWorkspaceOnMissing: true,
    });

    expect(result).toBe('workspace');
    expect(warning).toHaveBeenCalledWith('任务不存在', '请求的任务已失效，已返回工作区');
    expect(navigate).toHaveBeenCalledWith(['/projects']);
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
  });

  it('contains rejected workspace fallback navigation from missing startup shortcuts', async () => {
    const error = new Error('navigation rejected');
    const warning = vi.fn();
    const navigate = vi.fn().mockRejectedValueOnce(error);
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      router: { navigate },
      toast: {
        warning,
        info: vi.fn(),
        success: vi.fn(),
      },
    }));

    const result = controller.handleTaskDeepLink('task-missing', {
      degradeToWorkspaceOnMissing: true,
    });
    await Promise.resolve();

    expect(result).toBe('workspace');
    expect(navigate).toHaveBeenCalledWith(['/projects']);
    expect(warning).toHaveBeenCalledWith('任务不存在', '请求的任务已失效，已返回工作区');
    expect(warning).toHaveBeenCalledWith('返回工作区失败', '请稍后重试或手动返回项目列表');
  });

  it('contains synchronous workspace fallback navigation failures from missing startup shortcuts', async () => {
    const error = new Error('navigation failed synchronously');
    const warning = vi.fn();
    const navigate = vi.fn(() => {
      throw error;
    });
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      router: { navigate },
      toast: {
        warning,
        info: vi.fn(),
        success: vi.fn(),
      },
    }));

    let result: ReturnType<ProjectShellTaskDeepLinkController['handleTaskDeepLink']>;
    expect(() => {
      result = controller.handleTaskDeepLink('task-missing', {
        degradeToWorkspaceOnMissing: true,
      });
    }).not.toThrow();
    await Promise.resolve();

    expect(result!).toBe('workspace');
    expect(navigate).toHaveBeenCalledWith(['/projects']);
    expect(warning).toHaveBeenCalledWith('任务不存在', '请求的任务已失效，已返回工作区');
    expect(warning).toHaveBeenCalledWith('返回工作区失败', '请稍后重试或手动返回项目列表');
  });

  it('returns pending while remote data is loading and defers flow activation', () => {
    const warning = vi.fn();
    const info = vi.fn();
    const navigate = vi.fn();
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      router: { navigate },
      syncCoordinator: {
        isLoadingRemote: () => true,
      },
      toast: {
        warning,
        info,
        success: vi.fn(),
      },
      activateFlowIntent,
      setActiveView,
    }));

    const result = controller.handleTaskDeepLink('task-loading', {
      degradeToWorkspaceOnMissing: true,
    });

    expect(result).toBe('pending');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(warning).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
  });

  it('destroy clears a pending retry timer even when the timer handle is 0', () => {
    const retryTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => retryTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      syncCoordinator: {
        isLoadingRemote: () => true,
      },
    }));

    controller.handleTaskDeepLink('task-loading');
    controller.destroy();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('supersedes a pending retry when a newer deep link is handled', () => {
    let isLoadingRemote = true;
    const warning = vi.fn();
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      syncCoordinator: {
        isLoadingRemote: () => isLoadingRemote,
      },
      toast: {
        warning,
        info: vi.fn(),
        success: vi.fn(),
      },
    }));

    controller.handleTaskDeepLink('task-old');
    controller.handleTaskDeepLink('task-new');
    isLoadingRemote = false;

    vi.advanceTimersByTime(100);

    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('focuses an existing task through the Flow command buffer', () => {
    const centerOnNode = vi.fn();
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      projectState: {
        tasks: () => [{ id: 'task-1' }],
        getTask: () => ({ id: 'task-1' }),
      },
      flowCommand: {
        centerOnNode,
      },
      activateFlowIntent,
      setActiveView,
    }));

    const result = controller.handleTaskDeepLink('task-1');

    expect(result).toBe('flow');
    expect(activateFlowIntent).toHaveBeenCalledWith('deeplink');
    expect(setActiveView).toHaveBeenCalledWith('flow');

    vi.advanceTimersByTime(100);

    expect(centerOnNode).toHaveBeenCalledWith('task-1', true);
  });

  it('creates the fallback task durably before showing success from the missing-task action', async () => {
    const warning = vi.fn();
    const success = vi.fn();
    const addFloatingTask = vi.fn().mockResolvedValue(true);
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      projectState: {
        tasks: () => [{ id: 'other-task' }],
        getTask: () => null,
      },
      toast: {
        warning,
        info: vi.fn(),
        success,
      },
      taskOpsAdapter: {
        addFloatingTask,
      },
    }));

    controller.handleTaskDeepLink('missing-task');

    const toastOptions = warning.mock.calls[0]?.[2] as
      | { action?: { onClick?: () => void } }
      | undefined;
    toastOptions?.action?.onClick?.();
    await Promise.resolve();

    expect(addFloatingTask).toHaveBeenCalledWith('新任务', '', 100, 100);
    expect(success).toHaveBeenCalledWith('已创建新任务');
  });

  it('shows a failure toast when the missing-task fallback action rejects', async () => {
    const warning = vi.fn();
    const addFloatingTask = vi.fn().mockRejectedValueOnce(new Error('persist failed'));
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      projectState: {
        tasks: () => [{ id: 'other-task' }],
        getTask: () => null,
      },
      toast: {
        warning,
        info: vi.fn(),
        success: vi.fn(),
      },
      taskOpsAdapter: {
        addFloatingTask,
      },
    }));

    controller.handleTaskDeepLink('missing-task');

    const toastOptions = warning.mock.calls[0]?.[2] as
      | { action?: { onClick?: () => void } }
      | undefined;
    toastOptions?.action?.onClick?.();
    await Promise.resolve();

    expect(addFloatingTask).toHaveBeenCalledWith('新任务', '', 100, 100);
    expect(warning).toHaveBeenCalledWith(
      '创建任务失败',
      '本地持久化暂不可用，请稍后重试',
    );
  });

  it('ignores missing-task fallback action after the controller is destroyed', async () => {
    const warning = vi.fn();
    const success = vi.fn();
    const addFloatingTask = vi.fn().mockResolvedValue(true);
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      projectState: {
        tasks: () => [{ id: 'other-task' }],
        getTask: () => null,
      },
      toast: {
        warning,
        info: vi.fn(),
        success,
      },
      taskOpsAdapter: {
        addFloatingTask,
      },
    }));

    controller.handleTaskDeepLink('missing-task');
    const toastOptions = warning.mock.calls[0]?.[2] as
      | { action?: { onClick?: () => void } }
      | undefined;

    controller.destroy();
    toastOptions?.action?.onClick?.();
    await Promise.resolve();

    expect(addFloatingTask).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('ignores late missing-task fallback results after the controller is destroyed', async () => {
    const warning = vi.fn();
    const success = vi.fn();
    let resolveAddTask: (value: boolean) => void = () => undefined;
    const addFloatingTask = vi.fn(() => new Promise<boolean>(resolve => {
      resolveAddTask = resolve;
    }));
    const controller = new ProjectShellTaskDeepLinkController(createControllerOptions({
      projectState: {
        tasks: () => [{ id: 'other-task' }],
        getTask: () => null,
      },
      toast: {
        warning,
        info: vi.fn(),
        success,
      },
      taskOpsAdapter: {
        addFloatingTask,
      },
    }));

    controller.handleTaskDeepLink('missing-task');
    const toastOptions = warning.mock.calls[0]?.[2] as
      | { action?: { onClick?: () => void } }
      | undefined;

    toastOptions?.action?.onClick?.();
    controller.destroy();
    resolveAddTask(true);
    await Promise.resolve();

    expect(addFloatingTask).toHaveBeenCalledOnce();
    expect(success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
