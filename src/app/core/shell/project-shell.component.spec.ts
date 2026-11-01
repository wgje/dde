import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { UiStateService } from '../../../services/ui-state.service';
import { ProjectShellContentResizeController } from './project-shell-content-resize.controller';
import { ProjectShellComponent } from './project-shell.component';
import { ProjectShellRouteController, type ProjectShellRouteControllerOptions } from './project-shell-route.controller';

function createRouteControllerOptions(
  overrides: Partial<ProjectShellRouteControllerOptions> = {},
): ProjectShellRouteControllerOptions {
  const activeViewSet = vi.fn();
  return {
    route: {
      snapshot: {
        params: {},
        firstChild: { params: {} },
      },
    } as unknown as ProjectShellRouteControllerOptions['route'],
    router: {
      url: '/projects/project-1',
      navigate: vi.fn(),
    } as unknown as ProjectShellRouteControllerOptions['router'],
    handoffCoordinator: {
      result: () => ({ kind: 'full' }),
    } as unknown as ProjectShellRouteControllerOptions['handoffCoordinator'],
    startupLaunchSnapshot: null,
    flowStateAwareRestoreEnabled: true,
    flowIntentActivated: () => false,
    flowPrefetchOnlyActivated: {
      set: vi.fn(),
    },
    uiState: {
      isMobile: () => false,
      activeView: {
        set: activeViewSet,
      },
      getLastActiveView: () => null,
      persistActiveView: vi.fn(),
    },
    projectState: {
      activeProjectId: () => 'project-1',
      getProject: () => null,
      projects: () => [],
      tasks: () => [],
      getTask: () => null,
      captureActiveProjectOwner: () => ({ projectId: 'project-1', generation: 1 }),
      isActiveProjectOwnerCurrent: owner => (
        owner.projectId === 'project-1' && owner.generation === 1
      ),
    },
    syncCoordinator: {
      isLoadingRemote: () => false,
    },
    userSession: {
      switchActiveProject: vi.fn(),
    },
    tabSync: {
      notifyProjectOpen: vi.fn(),
    },
    toast: {
      warning: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    },
    taskOpsAdapter: {
      addFloatingTask: vi.fn(),
    } as unknown as ProjectShellRouteControllerOptions['taskOpsAdapter'],
    flowCommand: {
      centerOnNode: vi.fn(),
    },
    activateFlowIntent: vi.fn(),
    ...overrides,
  };
}

describe('ProjectShellRouteController route project selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('handleRouteChange 应通过 UserSession 切换项目以触发空壳补水', () => {
    const switchActiveProject = vi.fn();
    const notifyProjectOpen = vi.fn();
    const activeViewSet = vi.fn();
    const controller = new ProjectShellRouteController(createRouteControllerOptions({
      route: {
        snapshot: {
          params: { projectId: 'project-1' },
          firstChild: {
            params: {},
          },
        },
      } as unknown as ProjectShellRouteControllerOptions['route'],
      router: {
        url: '/projects/project-1/text',
        navigate: vi.fn(),
      } as unknown as ProjectShellRouteControllerOptions['router'],
      uiState: {
        isMobile: () => true,
        activeView: {
          set: activeViewSet,
        },
        getLastActiveView: () => null,
        persistActiveView: vi.fn(),
      },
      projectState: {
        activeProjectId: () => null,
        getProject: () => ({ id: 'project-1', name: 'Real Project' }),
        projects: () => [{ id: 'project-1', name: 'Real Project' }],
        tasks: () => [],
        getTask: () => null,
        captureActiveProjectOwner: () => ({ projectId: 'project-1', generation: 1 }),
        isActiveProjectOwnerCurrent: owner => (
          owner.projectId === 'project-1' && owner.generation === 1
        ),
      },
      userSession: {
        switchActiveProject,
      },
      tabSync: {
        notifyProjectOpen,
      },
    }));

    controller.handleRouteChange();

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(notifyProjectOpen).toHaveBeenCalledWith('project-1', 'Real Project');
    expect(activeViewSet).toHaveBeenCalledWith('text');
  });

  it('handleRouteChange 在非降级路径遇到仍在加载的任务深链接时不应提前切换到 Flow', () => {
    const activateFlowIntent = vi.fn();
    const activeViewSet = vi.fn();
    const controller = new ProjectShellRouteController(createRouteControllerOptions({
      route: {
        snapshot: {
          params: { projectId: 'project-1' },
          firstChild: {
            params: { taskId: 'task-loading' },
          },
        },
      } as unknown as ProjectShellRouteControllerOptions['route'],
      router: {
        url: '/projects/project-1/task/task-loading',
        navigate: vi.fn(),
      } as unknown as ProjectShellRouteControllerOptions['router'],
      syncCoordinator: {
        isLoadingRemote: () => true,
      },
      uiState: {
        isMobile: () => false,
        activeView: {
          set: activeViewSet,
        },
        getLastActiveView: () => null,
        persistActiveView: vi.fn(),
      },
      projectState: {
        activeProjectId: () => 'project-1',
        getProject: () => ({ id: 'project-1', name: 'Real Project' }),
        projects: () => [{ id: 'project-1', name: 'Real Project' }],
        tasks: () => [],
        getTask: () => null,
        captureActiveProjectOwner: () => ({ projectId: 'project-1', generation: 1 }),
        isActiveProjectOwnerCurrent: owner => (
          owner.projectId === 'project-1' && owner.generation === 1
        ),
      },
      activateFlowIntent,
    }));

    controller.handleRouteChange();

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(activeViewSet).not.toHaveBeenCalled();
  });
});

describe('ProjectShellComponent content resize lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    vi.useRealTimers();
  });

  it('ProjectShellContentResizeController 应清理进行中的内容列拖拽和折叠动画资源', () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.fn(() => 42);
    const cancelAnimationFrameSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameSpy);

    const isResizing = signal(false);
    const textColumnRatio = signal(25);
    const isTextColumnCollapsed = signal(false);
    const controller = new ProjectShellContentResizeController({
      isResizing,
      textColumnRatio,
      isTextColumnCollapsed,
    } as unknown as UiStateService);

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    controller.start({ preventDefault: vi.fn(), clientX: 100 } as unknown as MouseEvent);
    controller.move({ preventDefault: vi.fn(), clientX: 50 } as unknown as MouseEvent);
    controller.cleanup();

    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(42);
    expect(isResizing()).toBe(false);
    expect(controller.collapseAnimating()).toBe(false);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    vi.advanceTimersByTime(320);
    expect(controller.collapseAnimating()).toBe(false);
  });

  it('ProjectShellContentResizeController cleanup 在 SSR 缺少 document 时不应抛出', () => {
    const isResizing = signal(false);
    const textColumnRatio = signal(25);
    const isTextColumnCollapsed = signal(false);
    const controller = new ProjectShellContentResizeController({
      isResizing,
      textColumnRatio,
      isTextColumnCollapsed,
    } as unknown as UiStateService);

    vi.stubGlobal('document', undefined);

    expect(() => controller.cleanup()).not.toThrow();
    expect(isResizing()).toBe(false);
    expect(controller.collapseAnimating()).toBe(false);
  });
});

describe('ProjectShellComponent flow view loading contract', () => {
  it('Shell 首屏组件不得在构造期直接注入 TaskOperationAdapterService', () => {
    const startupFiles = [
      'src/workspace-shell.component.ts',
      'src/app/core/shell/project-shell.component.ts',
      'src/services/keyboard-shortcut.service.ts',
      'src/services/parking.service.ts',
      'src/services/simple-reminder.service.ts',
      'src/app/features/text/components/text-view.component.ts',
      'src/app/features/text/components/text-unassigned.component.ts',
      'src/app/features/text/components/text-unfinished.component.ts',
      'src/app/features/text/components/text-task-editor.component.ts',
      'src/app/features/text/services/text-view-task-ops.service.ts',
    ];

    for (const file of startupFiles) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8');
      expect(source, file).not.toMatch(/inject\s*\(\s*TaskOperationAdapterService\s*\)/);
    }
  });

  it('FlowView 应只在 @defer 块内渲染，避免 GoJS 进入初始包', () => {
    const template = readFileSync(
      join(process.cwd(), 'src/app/core/shell/project-shell.component.html'),
      'utf-8'
    );

    const flowColumnStart = template.indexOf('<!-- Flow Column - 移动端条件渲染，桌面端始终显示 -->');
    expect(flowColumnStart).toBeGreaterThanOrEqual(0);

    const flowColumnEnd = template.indexOf('@defer (on timer(300))', flowColumnStart);
    expect(flowColumnEnd).toBeGreaterThan(flowColumnStart);

    const flowColumn = template.slice(flowColumnStart, flowColumnEnd);
    expect(flowColumn).toContain('@defer (when shouldLoadFlowNow(); prefetch when shouldPrefetchFlowChunk())');
    expect(flowColumn).not.toMatch(/@if \(!uiState\.isMobile\(\)\) \{\s*<app-flow-view/s);

    const deferStart = flowColumn.indexOf('@defer (when shouldLoadFlowNow(); prefetch when shouldPrefetchFlowChunk())');
    const appFlowViewStart = flowColumn.indexOf('<app-flow-view', deferStart);
    expect(appFlowViewStart).toBeGreaterThan(deferStart);
  });

  it('移动端 Flow 列必须通过 activeView 条件挂载，避免隐藏保活 GoJS 实例', () => {
    const template = readFileSync(
      join(process.cwd(), 'src/app/core/shell/project-shell.component.html'),
      'utf-8'
    );

    const flowColumnStart = template.indexOf('<!-- Flow Column - 移动端条件渲染，桌面端始终显示 -->');
    const flowColumnEnd = template.indexOf('@defer (on timer(300))', flowColumnStart);
    const flowColumn = template.slice(flowColumnStart, flowColumnEnd);

    expect(flowColumn).toContain("@if (!uiState.isMobile() || uiState.activeView() === 'flow')");
    expect(flowColumn).not.toContain('[style.visibility]');
    expect(flowColumn).not.toContain('visibility:hidden');
    expect(flowColumn).not.toContain('visibility: hidden');
  });

  it('停泊坞 hide 模式不得用 visibility 隐藏主内容，避免保活隐藏的 GoJS 实例', () => {
    const template = readFileSync(
      join(process.cwd(), 'src/app/core/shell/project-shell.component.html'),
      'utf-8'
    );

    const mainContentStart = template.indexOf('data-testid="project-shell-main-content"');
    expect(mainContentStart).toBeGreaterThanOrEqual(0);
    const mainContentEnd = template.indexOf('>', mainContentStart);
    const mainContentTag = template.slice(mainContentStart, mainContentEnd);

    expect(mainContentTag).not.toContain('[style.visibility]');
    expect(template).not.toContain('dockTakeoverMainVisibility');
  });

  it('停泊坞 takeover 非交互态必须用 inert 阻断键盘焦点进入隐藏主内容', () => {
    const template = readFileSync(
      join(process.cwd(), 'src/app/core/shell/project-shell.component.html'),
      'utf-8'
    );

    const mainContentStart = template.indexOf('data-testid="project-shell-main-content"');
    expect(mainContentStart).toBeGreaterThanOrEqual(0);
    const mainContentEnd = template.indexOf('>', mainContentStart);
    const mainContentTag = template.slice(mainContentStart, mainContentEnd);

    expect(mainContentTag).toContain('[class.pointer-events-none]="dockTakeoverMainNonInteractive()"');
    expect(mainContentTag).toContain('[attr.inert]="dockTakeoverMainNonInteractive() ? \'\' : null"');
  });
});
