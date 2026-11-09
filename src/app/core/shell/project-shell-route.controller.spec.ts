import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivatedRoute, Router } from '@angular/router';

import type { HandoffResult } from '../../../services/handoff-coordinator.service';
import {
  ProjectShellRouteController,
  type ProjectShellRouteControllerOptions,
} from './project-shell-route.controller';

interface RouteControllerHarnessInput {
  currentUrl?: string;
  projectId?: string;
  taskId?: string;
  handoffResult?: HandoffResult;
  startupLaunchSnapshot?: ProjectShellRouteControllerOptions['startupLaunchSnapshot'];
  isMobile?: boolean;
  activeProjectId?: string | null;
  getTask?: (taskId: string) => unknown;
  isLoadingRemote?: () => boolean;
}

function createHarness(input: RouteControllerHarnessInput = {}) {
  let activeProjectId = input.activeProjectId ?? null;
  const activeView = { set: vi.fn() };
  const flowPrefetchOnlyActivated = { set: vi.fn() };
  const persistActiveView = vi.fn();
  const activateFlowIntent = vi.fn();
  const switchActiveProject = vi.fn((projectId: string) => {
    activeProjectId = projectId;
  });
  const notifyProjectOpen = vi.fn();
  const toast = { info: vi.fn(), warning: vi.fn(), success: vi.fn() };
  const centerOnNode = vi.fn();
  const clearAllCommands = vi.fn();
  const getTask = vi.fn((taskId: string) =>
    input.getTask ? input.getTask(taskId) : { id: 'task-1' });
  const routeSnapshot = {
    params: { projectId: input.projectId },
    firstChild: input.taskId ? { params: { taskId: input.taskId } } : null,
  };
  const route = {
    snapshot: routeSnapshot,
  } as unknown as ActivatedRoute;
  const routerState = {
    url: input.currentUrl ?? '/projects/project-1',
    navigate: vi.fn().mockResolvedValue(true),
  };
  const router = routerState as unknown as Router & { navigate: ReturnType<typeof vi.fn> };
  const options: ProjectShellRouteControllerOptions = {
    route,
    router,
    handoffCoordinator: {
      result: () => input.handoffResult ?? { kind: 'full', degradeReason: null },
    } as never,
    startupLaunchSnapshot: input.startupLaunchSnapshot ?? null,
    // 关闭状态感知恢复，让 route 分支直接落到 activateFlowIntent + setActiveView
    flowStateAwareRestoreEnabled: false,
    flowIntentActivated: () => false,
    flowPrefetchOnlyActivated,
    uiState: {
      isMobile: () => input.isMobile ?? false,
      activeView,
      getLastActiveView: () => null,
      persistActiveView,
    },
    projectState: {
      activeProjectId: () => activeProjectId,
      getProject: (projectId: string) => ({ name: `Project ${projectId}` }),
      projects: () => [{ id: 'fallback-project' }],
      tasks: () => ['task'],
      getTask,
      captureActiveProjectOwner: () => ({ projectId: activeProjectId, generation: 1 }),
      isActiveProjectOwnerCurrent: owner => (
        owner.projectId === activeProjectId && owner.generation === 1
      ),
    },
    syncCoordinator: { isLoadingRemote: input.isLoadingRemote ?? (() => false) },
    userSession: { switchActiveProject },
    tabSync: { notifyProjectOpen },
    toast,
    taskOpsAdapter: { addFloatingTask: vi.fn() },
    flowCommand: { centerOnNode, clearAllCommands },
    activateFlowIntent,
  };
  const controller = new ProjectShellRouteController(options);

  const setRoute = (next: {
    currentUrl: string;
    projectId: string;
    taskId?: string;
  }): void => {
    routeSnapshot.params.projectId = next.projectId;
    routeSnapshot.firstChild = next.taskId
      ? { params: { taskId: next.taskId } }
      : null;
    routerState.url = next.currentUrl;
  };

  return {
    activateFlowIntent,
    activeView,
    centerOnNode,
    clearAllCommands,
    controller,
    getTask,
    notifyProjectOpen,
    persistActiveView,
    setRoute,
    switchActiveProject,
    toast,
  };
}

describe('ProjectShellRouteController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('switches the active project and notifies other tabs when the route project changes', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1',
      projectId: 'project-1',
      activeProjectId: null,
    });

    harness.controller.handleRouteChange();

    expect(harness.switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(harness.notifyProjectOpen).toHaveBeenCalledWith('project-1', 'Project project-1');
  });

  it('does not switch projects when the route project is already active', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1',
      projectId: 'project-1',
      activeProjectId: 'project-1',
    });

    harness.controller.handleRouteChange();

    expect(harness.switchActiveProject).not.toHaveBeenCalled();
    expect(harness.notifyProjectOpen).not.toHaveBeenCalled();
  });

  it('applies the text view when the route ends with /text', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1/text',
      projectId: 'project-1',
      activeProjectId: 'project-1',
    });

    harness.controller.handleRouteChange();

    expect(harness.activeView.set).toHaveBeenCalledWith('text');
    expect(harness.persistActiveView).toHaveBeenCalledWith('text');
    expect(harness.activateFlowIntent).not.toHaveBeenCalled();
  });

  it('activates flow intent with route source when the route ends with /flow', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1/flow',
      projectId: 'project-1',
      activeProjectId: 'project-1',
    });

    harness.controller.handleRouteChange();

    expect(harness.activateFlowIntent).toHaveBeenCalledWith('route');
    expect(harness.activeView.set).toHaveBeenCalledWith('flow');
    expect(harness.persistActiveView).toHaveBeenCalledWith('flow');
  });

  it('opens the flow view via deeplink when the route carries an existing task deep link', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1/task/task-1',
      projectId: 'project-1',
      taskId: 'task-1',
      activeProjectId: 'project-1',
      getTask: () => ({ id: 'task-1' }),
    });

    harness.controller.handleRouteChange();

    expect(harness.activateFlowIntent).toHaveBeenCalledWith('deeplink');
    expect(harness.activeView.set).toHaveBeenCalledWith('flow');

    // 深链定位在 100ms 延迟后居中目标节点
    vi.advanceTimersByTime(100);
    expect(harness.centerOnNode).toHaveBeenCalledWith('task-1', true);
  });

  it('retires a pending project A deep link when routing to project B without a task', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-a/task/task-a',
      projectId: 'project-a',
      taskId: 'task-a',
      activeProjectId: 'project-a',
      getTask: () => null,
      isLoadingRemote: () => true,
    });

    harness.controller.handleRouteChange();
    harness.setRoute({
      currentUrl: '/projects/project-b',
      projectId: 'project-b',
    });
    harness.controller.handleRouteChange();
    vi.advanceTimersByTime(100);

    expect(harness.centerOnNode).not.toHaveBeenCalled();
    expect(harness.clearAllCommands).toHaveBeenCalledOnce();
    expect(harness.switchActiveProject).toHaveBeenCalledWith('project-b');
  });

  it('retires A before clearing commands and switching projects, then publishes B once', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-a/task/task-a',
      projectId: 'project-a',
      taskId: 'task-a',
      activeProjectId: 'project-a',
      getTask: taskId => taskId === 'task-b' ? { id: taskId } : null,
      isLoadingRemote: () => true,
    });

    harness.controller.handleRouteChange();
    harness.getTask.mockClear();
    harness.clearAllCommands.mockImplementationOnce(() => {
      vi.advanceTimersByTime(100);
    });
    harness.setRoute({
      currentUrl: '/projects/project-b/task/task-b',
      projectId: 'project-b',
      taskId: 'task-b',
    });

    harness.controller.handleRouteChange();

    expect(harness.centerOnNode).not.toHaveBeenCalled();
    expect(harness.clearAllCommands.mock.invocationCallOrder[0])
      .toBeLessThan(harness.switchActiveProject.mock.invocationCallOrder[0]);
    expect(harness.switchActiveProject.mock.invocationCallOrder[0])
      .toBeLessThan(harness.getTask.mock.invocationCallOrder[0]);

    vi.advanceTimersByTime(99);
    expect(harness.centerOnNode).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.centerOnNode).toHaveBeenCalledOnce();
    expect(harness.centerOnNode).toHaveBeenCalledWith('task-b', true);
    vi.advanceTimersByTime(1000);
    expect(harness.centerOnNode).toHaveBeenCalledOnce();
  });

  it('lets a same-project task B supersede pending task A without clearing flow commands', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-a/task/task-a',
      projectId: 'project-a',
      taskId: 'task-a',
      activeProjectId: 'project-a',
      getTask: taskId => taskId === 'task-b' ? { id: taskId } : null,
      isLoadingRemote: () => true,
    });

    harness.controller.handleRouteChange();
    harness.setRoute({
      currentUrl: '/projects/project-a/task/task-b',
      projectId: 'project-a',
      taskId: 'task-b',
    });
    harness.controller.handleRouteChange();
    vi.advanceTimersByTime(100);

    expect(harness.clearAllCommands).not.toHaveBeenCalled();
    expect(harness.centerOnNode).toHaveBeenCalledOnce();
    expect(harness.centerOnNode).toHaveBeenCalledWith('task-b', true);
  });

  it('retires a same-project pending task when the route no longer targets a task', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-a/task/task-a',
      projectId: 'project-a',
      taskId: 'task-a',
      activeProjectId: 'project-a',
      getTask: () => null,
      isLoadingRemote: () => true,
    });

    harness.controller.handleRouteChange();
    harness.setRoute({
      currentUrl: '/projects/project-a',
      projectId: 'project-a',
    });
    harness.controller.handleRouteChange();
    vi.advanceTimersByTime(100);

    expect(harness.centerOnNode).not.toHaveBeenCalled();
    expect(harness.clearAllCommands).not.toHaveBeenCalled();
    expect(harness.switchActiveProject).not.toHaveBeenCalled();
  });

  it('applies the same retirement rules across forward and back project routes', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-a/task/task-a',
      projectId: 'project-a',
      taskId: 'task-a',
      activeProjectId: 'project-a',
      getTask: () => null,
      isLoadingRemote: () => true,
    });

    harness.controller.handleRouteChange();
    harness.setRoute({
      currentUrl: '/projects/project-b/task/task-b',
      projectId: 'project-b',
      taskId: 'task-b',
    });
    harness.controller.handleRouteChange();
    harness.setRoute({
      currentUrl: '/projects/project-a',
      projectId: 'project-a',
    });
    harness.controller.handleRouteChange();
    vi.advanceTimersByTime(1000);

    expect(harness.centerOnNode).not.toHaveBeenCalled();
    expect(harness.clearAllCommands).toHaveBeenCalledTimes(2);
    expect(harness.switchActiveProject.mock.calls).toEqual([
      ['project-b'],
      ['project-a'],
    ]);
  });

  it('degrades the startup route to text once when handoff resolved degraded-to-text', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1/flow',
      projectId: 'project-1',
      activeProjectId: 'project-1',
      handoffResult: { kind: 'degraded-to-text', degradeReason: 'mobile' },
    });

    harness.controller.handleRouteChange();

    expect(harness.activeView.set).toHaveBeenCalledWith('text');
    expect(harness.toast.info).toHaveBeenCalledWith(
      '已切换到文本视图',
      '启动阶段已回退到更稳定的文本视图',
    );
    expect(harness.activateFlowIntent).not.toHaveBeenCalled();

    harness.activeView.set.mockClear();
    harness.activateFlowIntent.mockClear();

    // 启动降级决策只允许消费一次：后续同样的 handoff 结果不再降级
    harness.controller.handleRouteChange();

    expect(harness.activateFlowIntent).toHaveBeenCalledWith('route');
    expect(harness.activeView.set).toHaveBeenCalledWith('flow');
  });

  it('uses the mobile default-text message when the launch snapshot degraded the startup route', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1/flow',
      projectId: 'project-1',
      activeProjectId: 'project-1',
      isMobile: true,
      startupLaunchSnapshot: {
        routeIntent: { kind: 'flow', projectId: 'project-1' } as never,
        mobileDegraded: true,
        degradeReason: 'mobile-default-text',
      },
    });

    harness.controller.handleRouteChange();

    expect(harness.toast.info).toHaveBeenCalledWith(
      '已切换到文本视图',
      '手机端启动默认进入文本视图，可稍后手动切换流程图',
    );
    expect(harness.activeView.set).toHaveBeenCalledWith('text');
  });

  it('cancels pending deep link retries on destroy', () => {
    const harness = createHarness({
      currentUrl: '/projects/project-1/task/task-1',
      projectId: 'project-1',
      taskId: 'task-1',
      activeProjectId: 'project-1',
      getTask: () => null,
      isLoadingRemote: () => true,
    });

    harness.controller.handleRouteChange();
    harness.controller.destroy();
    vi.advanceTimersByTime(5000);

    // 竞态守卫：destroy 后延迟的深链定位不得再触发流程图命令
    expect(harness.centerOnNode).not.toHaveBeenCalled();
  });
});
