import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectShellComponent } from './project-shell.component';

describe('ProjectShellComponent startup entry fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('handleTaskDeepLink 应在 shortcut 深链接任务失效时立即回退到工作区', () => {
    const warning = vi.fn();
    const info = vi.fn();
    const navigateToProjectList = vi.fn();
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const context = {
      isDestroyed: false,
      projectState: {
        tasks: () => [],
        getTask: () => null,
      },
      syncCoordinator: {
        isLoadingRemote: () => false,
      },
      toast: {
        warning,
        info,
      },
      navigateToProjectList,
      activateFlowIntent,
      setActiveView,
      taskOpsAdapter: {
        addFloatingTask: vi.fn(),
      },
      deepLinkRetryTimer: null,
    } as unknown as ProjectShellComponent;

    const result = (ProjectShellComponent.prototype as unknown as {
      handleTaskDeepLink: (
        this: ProjectShellComponent,
        taskId: string,
        options?: { degradeToWorkspaceOnMissing?: boolean }
      ) => 'flow' | 'workspace' | 'pending';
    }).handleTaskDeepLink.call(context, 'task-missing', { degradeToWorkspaceOnMissing: true });

    expect(result).toBe('workspace');
    expect(warning).toHaveBeenCalledWith('任务不存在', '请求的任务已失效，已返回工作区');
    expect(navigateToProjectList).toHaveBeenCalledTimes(1);
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
    expect(context.deepLinkRetryTimer).toBeNull();
  });

  it('handleTaskDeepLink 应在数据仍在加载时保持 pending 且不提前切换到 flow', () => {
    const warning = vi.fn();
    const info = vi.fn();
    const navigateToProjectList = vi.fn();
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const context = {
      isDestroyed: false,
      projectState: {
        tasks: () => [],
        getTask: () => null,
      },
      syncCoordinator: {
        isLoadingRemote: () => true,
      },
      toast: {
        warning,
        info,
      },
      navigateToProjectList,
      activateFlowIntent,
      setActiveView,
      taskOpsAdapter: {
        addFloatingTask: vi.fn(),
      },
      deepLinkRetryTimer: null,
    } as unknown as ProjectShellComponent;

    const result = (ProjectShellComponent.prototype as unknown as {
      handleTaskDeepLink: (
        this: ProjectShellComponent,
        taskId: string,
        options?: { degradeToWorkspaceOnMissing?: boolean }
      ) => 'flow' | 'workspace' | 'pending';
    }).handleTaskDeepLink.call(context, 'task-loading', { degradeToWorkspaceOnMissing: true });

    expect(result).toBe('pending');
    expect(context.deepLinkRetryTimer).not.toBeNull();
    expect(warning).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(navigateToProjectList).not.toHaveBeenCalled();
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
  });
});
