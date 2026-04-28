import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import type { ProjectShellComponent } from './project-shell.component';

vi.mock('gojs', () => ({
  Router: class Router {},
}));

let ProjectShell: typeof ProjectShellComponent;

beforeAll(async () => {
  ({ ProjectShellComponent: ProjectShell } = await import('./project-shell.component'));
}, 5000);

type ProjectShellDeepLinkContext = {
  isDestroyed: boolean;
  projectState: {
    tasks: () => unknown[];
    getTask: () => unknown;
  };
  syncCoordinator: {
    isLoadingRemote: () => boolean;
  };
  toast: {
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  navigateToProjectList: ReturnType<typeof vi.fn>;
  activateFlowIntent: ReturnType<typeof vi.fn>;
  setActiveView: ReturnType<typeof vi.fn>;
  taskOpsAdapter: {
    addFloatingTask: ReturnType<typeof vi.fn>;
  };
  deepLinkRetryTimer: ReturnType<typeof setTimeout> | null;
};

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
    const context: ProjectShellDeepLinkContext = {
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
    };

    const result = (ProjectShell.prototype as unknown as {
      handleTaskDeepLink: (
        this: ProjectShellComponent,
        taskId: string,
        options?: { degradeToWorkspaceOnMissing?: boolean }
      ) => 'flow' | 'workspace' | 'pending';
    }).handleTaskDeepLink.call(context as unknown as ProjectShellComponent, 'task-missing', { degradeToWorkspaceOnMissing: true });

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
    const context: ProjectShellDeepLinkContext = {
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
    };

    const result = (ProjectShell.prototype as unknown as {
      handleTaskDeepLink: (
        this: ProjectShellComponent,
        taskId: string,
        options?: { degradeToWorkspaceOnMissing?: boolean }
      ) => 'flow' | 'workspace' | 'pending';
    }).handleTaskDeepLink.call(context as unknown as ProjectShellComponent, 'task-loading', { degradeToWorkspaceOnMissing: true });

    expect(result).toBe('pending');
    expect(context.deepLinkRetryTimer).not.toBeNull();
    expect(warning).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(navigateToProjectList).not.toHaveBeenCalled();
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
  });
});

describe('ProjectShellComponent flow lazy-load recovery', () => {
  it('activateFlowIntent 应在新版本待刷新且 FlowView 未就绪时阻止懒加载', () => {
    const reloadForPendingVersionBeforeFlow = vi.fn();
    const context = {
      flowIntentLazyLoadEnabled: true,
      flowIntentActivated: signal(false),
      flowPrefetchOnlyActivated: signal(true),
      flowCommand: {
        isViewReady: () => false,
      },
      appLifecycle: {
        hasPendingVersionUpdate: () => true,
      },
      reloadForPendingVersionBeforeFlow,
      logger: {
        debug: vi.fn(),
      },
    };

    const result = (ProjectShell.prototype as unknown as {
      activateFlowIntent: (this: ProjectShellComponent, source: 'click') => boolean;
    }).activateFlowIntent.call(context as unknown as ProjectShellComponent, 'click');

    expect(result).toBe(false);
    expect(context.flowIntentActivated()).toBe(false);
    expect(reloadForPendingVersionBeforeFlow).toHaveBeenCalledWith('click');
  });

  it('switchToFlow 应在新版本刷新拦截时不切换到 flow', () => {
    const context = {
      cancelFlowStateAwareTimers: vi.fn(),
      activateFlowIntent: vi.fn().mockReturnValue(false),
      setActiveView: vi.fn(),
    };

    (ProjectShell.prototype as unknown as {
      switchToFlow: (this: ProjectShellComponent) => void;
    }).switchToFlow.call(context as unknown as ProjectShellComponent);

    expect(context.cancelFlowStateAwareTimers).toHaveBeenCalledTimes(1);
    expect(context.activateFlowIntent).toHaveBeenCalledWith('click');
    expect(context.setActiveView).not.toHaveBeenCalled();
  });
});
