import { vi, describe, it, expect } from 'vitest';
import { WorkspaceShellComponent } from './workspace-shell.component';
import { FEATURE_FLAGS } from './config/feature-flags.config';

describe('WorkspaceShellComponent 输入事件处理', () => {
  it('onUnifiedSearchInput 应转发输入值到 onUnifiedSearchChange', () => {
    const onUnifiedSearchChange = vi.fn();
    const context = { onUnifiedSearchChange } as unknown as WorkspaceShellComponent;
    const event = { target: { value: 'roadmap' } } as Event;

    WorkspaceShellComponent.prototype.onUnifiedSearchInput.call(context, event);

    expect(onUnifiedSearchChange).toHaveBeenCalledWith('roadmap');
  });

  it('onRenameProjectNameInput 应更新 renameProjectName signal', () => {
    const set = vi.fn();
    const context = {
      projectCoord: {
        renameProjectName: { set },
      },
    } as unknown as WorkspaceShellComponent;
    const event = { target: { value: 'New Name' } } as Event;

    WorkspaceShellComponent.prototype.onRenameProjectNameInput.call(context, event);

    expect(set).toHaveBeenCalledWith('New Name');
  });

  it('onProjectDescriptionInput 应调用 updateProjectDraft 写入 description', () => {
    const updateProjectDraft = vi.fn();
    const context = { updateProjectDraft } as unknown as WorkspaceShellComponent;
    const event = { target: { value: 'Project intro' } } as Event;

    WorkspaceShellComponent.prototype.onProjectDescriptionInput.call(context, 'proj-1', event);

    expect(updateProjectDraft).toHaveBeenCalledWith('proj-1', 'description', 'Project intro');
  });

  it('onSearchTaskClick 命中停泊任务时应直接展开停泊坞并预览任务', () => {
    const setActiveProjectId = vi.fn();
    const setDockExpanded = vi.fn();
    const previewTask = vi.fn();
    const context = {
      taskStore: {
        getTaskProjectId: () => 'project-1',
      },
      projectState: {
        activeProjectId: () => 'project-2',
        setActiveProjectId,
      },
      dockEngine: {
        setDockExpanded,
      },
      parkingService: {
        previewTask,
      },
    } as unknown as WorkspaceShellComponent;

    WorkspaceShellComponent.prototype.onSearchTaskClick.call(context, 'task-1', true);

    expect(setActiveProjectId).toHaveBeenCalledWith('project-1');
    expect(setDockExpanded).toHaveBeenCalledWith(true, { persistPreference: false });
    expect(previewTask).toHaveBeenCalledWith('task-1');
  });

  it('focus workspace takeover 应覆盖进入与退出过渡', () => {
    const enteringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'entering',
    } as unknown as WorkspaceShellComponent;
    const exitingContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'exiting',
    } as unknown as WorkspaceShellComponent;
    const idleContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
    } as unknown as WorkspaceShellComponent;
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(enteringContext),
    ).toBe(true);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(exitingContext),
    ).toBe(true);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(idleContext),
    ).toBe(false);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveFocusWorkspaceTakeoverActive: (this: WorkspaceShellComponent) => boolean;
      }).resolveFocusWorkspaceTakeoverActive.call(restoringContext),
    ).toBe(true);
  });

  it('resolveWorkspaceSidebarWidth 应在专注切换全程保持桌面侧栏宽度稳定', () => {
    const enteringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'entering',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const focusedContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'focused',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const exitingContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'exiting',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const desktopContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const mobileContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => true,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(enteringContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(focusedContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(exitingContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(desktopContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(restoringContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(mobileContext),
    ).toBe(240);
  });

  it('restore 期应延后项目栏内容显现，避免宽度恢复时内容挤压', () => {
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
      uiState: {
        isMobile: () => false,
      },
    } as unknown as WorkspaceShellComponent;
    const focusedContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'focused',
      uiState: {
        isMobile: () => false,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentOpacity.call(restoringContext),
    ).toBe('1');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentOpacity.call(focusedContext),
    ).toBe('0');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentTransition: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentTransition.call(restoringContext),
    ).toContain('var(--pk-shell-smooth-restore)');
  });

  it('桌面端退出专注时项目栏应直接回到完整视觉态，而不是先缩成 ghost 再恢复', () => {
    const exitingContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'exiting',
      uiState: {
        isMobile: () => false,
        sidebarOpen: () => true,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarOpacity.call(exitingContext),
    ).toBe('1');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(exitingContext),
    ).toBe('translateX(0) scale(1)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentOpacity: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentOpacity.call(exitingContext),
    ).toBe('1');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarContentTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarContentTransform.call(exitingContext),
    ).toBe('translateX(0)');
  });

  it('移动端侧栏应改为 overlay transform 开合，而不是依赖主布局挤压', () => {
    const openContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;
    const closedContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => false,
      },
    } as unknown as WorkspaceShellComponent;
    const takeoverContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'entering',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(openContext),
    ).toBe('translateX(0)');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(closedContext),
    ).toBe('translateX(calc(-100% - 12px))');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarTransform: (this: WorkspaceShellComponent) => string;
      }).resolveWorkspaceSidebarTransform.call(takeoverContext),
    ).toBe('translateX(calc(-100% - 12px))');
  });

  it('移动端侧栏关闭时应禁用命中，避免隐藏 overlay 挡住主内容', () => {
    const hiddenOverlayContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => false,
      },
    } as unknown as WorkspaceShellComponent;
    const visibleOverlayContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'idle',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;
    const restoringContext = {
      resolveFocusWorkspaceTakeoverPhase: () => 'restoring',
      uiState: {
        isMobile: () => true,
        sidebarOpen: () => true,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarPointerEvents: (this: WorkspaceShellComponent) => 'none' | 'auto';
      }).resolveWorkspaceSidebarPointerEvents.call(hiddenOverlayContext),
    ).toBe('none');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarPointerEvents: (this: WorkspaceShellComponent) => 'none' | 'auto';
      }).resolveWorkspaceSidebarPointerEvents.call(visibleOverlayContext),
    ).toBe('auto');
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarPointerEvents: (this: WorkspaceShellComponent) => 'none' | 'auto';
      }).resolveWorkspaceSidebarPointerEvents.call(restoringContext),
    ).toBe('none');
  });

  it('signalWorkspaceHandoffReady 应只通知一次布局稳定，真正 handoff 交给协调器触发', () => {
    const markWorkspaceHandoffReady = vi.fn();
    const markApplicationReady = vi.fn();
    const markLayoutStable = vi.fn();
    const context = {
      bootStage: { markWorkspaceHandoffReady, markApplicationReady },
      handoffCoordinator: { markLayoutStable },
      workspaceHandoffSignaled: false,
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      signalWorkspaceHandoffReady: (this: WorkspaceShellComponent) => void;
    }).signalWorkspaceHandoffReady.call(context);
    (WorkspaceShellComponent.prototype as unknown as {
      signalWorkspaceHandoffReady: (this: WorkspaceShellComponent) => void;
    }).signalWorkspaceHandoffReady.call(context);

    expect(markWorkspaceHandoffReady).not.toHaveBeenCalled();
    expect(markApplicationReady).not.toHaveBeenCalled();
    expect(markLayoutStable).toHaveBeenCalledTimes(1);
  });

  it('commitWorkspaceHandoff 应在 handoff 后隐藏 loader、记录指标并推进 ready', () => {
    const loader = document.createElement('div');
    loader.id = 'initial-loader';
    loader.style.display = 'flex';
    document.body.appendChild(loader);

    const noteLoaderHidden = vi.fn();
    const markApplicationReady = vi.fn();
    const markHandoffReady = vi.fn();
    const context = {
      bootStage: {
        isWorkspaceHandoffReady: () => true,
        noteLoaderHidden,
        markApplicationReady,
      },
      startupTier: { markHandoffReady },
      workspaceReadyCommitted: false,
    } as unknown as WorkspaceShellComponent;

    try {
      (WorkspaceShellComponent.prototype as unknown as {
        commitWorkspaceHandoff: (this: WorkspaceShellComponent) => void;
      }).commitWorkspaceHandoff.call(context);
      (WorkspaceShellComponent.prototype as unknown as {
        commitWorkspaceHandoff: (this: WorkspaceShellComponent) => void;
      }).commitWorkspaceHandoff.call(context);

      expect(loader.style.display).toBe('none');
      expect(noteLoaderHidden).toHaveBeenCalledTimes(1);
      expect(markHandoffReady).toHaveBeenCalledTimes(1);
      expect(markApplicationReady).toHaveBeenCalledTimes(1);
    } finally {
      loader.remove();
    }
  });

  it('resolveLaunchSnapshotUserId 应在认证仍未完成时沿用启动快照 owner', () => {
    const context = {
      currentUserId: () => null,
      authService: {
        sessionInitialized: () => false,
      },
      authCoord: {
        isCheckingSession: () => false,
      },
      startupLaunchSnapshot: {
        userId: 'snapshot-user',
      },
    } as unknown as WorkspaceShellComponent;

    const result = (WorkspaceShellComponent.prototype as unknown as {
      resolveLaunchSnapshotUserId: (this: WorkspaceShellComponent) => string | null;
    }).resolveLaunchSnapshotUserId.call(context);

    expect(result).toBe('snapshot-user');
  });

  it('resolveLaunchSnapshotUserId 应在认证已稳定且无用户时返回 null', () => {
    const context = {
      currentUserId: () => null,
      authService: {
        sessionInitialized: () => true,
      },
      authCoord: {
        isCheckingSession: () => false,
      },
      startupLaunchSnapshot: {
        userId: 'snapshot-user',
      },
    } as unknown as WorkspaceShellComponent;

    const result = (WorkspaceShellComponent.prototype as unknown as {
      resolveLaunchSnapshotUserId: (this: WorkspaceShellComponent) => string | null;
    }).resolveLaunchSnapshotUserId.call(context);

    expect(result).toBeNull();
  });

  it('syncStateFromRoute 应在 /projects 根路由回填启动项目，避免主内容空壳', () => {
    const setActiveProjectId = vi.fn();
    const context = {
      route: {
        snapshot: { params: {} },
        firstChild: null,
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }, { id: 'project-2' }],
        setActiveProjectId,
      },
      userSession: {
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: {
        activeProjectId: 'project-2',
        currentProject: { id: 'project-2' },
      },
      router: {
        navigate: vi.fn(),
      },
      resolveStartupProjectFallbackId: (projects: Array<{ id: string }>) =>
        (WorkspaceShellComponent.prototype as unknown as {
          resolveStartupProjectFallbackId: (
            this: WorkspaceShellComponent,
            projects: Array<{ id: string }>
          ) => string | null;
        }).resolveStartupProjectFallbackId.call(context as unknown as WorkspaceShellComponent, projects as never),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(setActiveProjectId).toHaveBeenCalledWith('project-2');
  });

  it('syncStateFromRoute 应在项目异步到达后补上深链接项目选择', () => {
    const setActiveProjectId = vi.fn();
    const navigate = vi.fn();
    const context = {
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-1' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }],
        setActiveProjectId,
      },
      userSession: {
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(setActiveProjectId).toHaveBeenCalledWith('project-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('syncStateFromRoute 不应把 partial 启动目录误当成完整真相并提前吃掉 deep-link', () => {
    const setActiveProjectId = vi.fn();
    const navigate = vi.fn();
    const context = {
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-9' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }],
        setActiveProjectId,
      },
      userSession: {
        startupProjectCatalogStage: () => 'partial',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(setActiveProjectId).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('syncStateFromRoute 应在项目目录已 resolved 且目标不存在时回退到 /projects', () => {
    const navigate = vi.fn();
    const context = {
      route: {
        snapshot: { params: {} },
        firstChild: {
          snapshot: { params: { projectId: 'project-9' } },
          firstChild: null,
        },
      },
      projectState: {
        activeProjectId: () => null,
        projects: () => [{ id: 'project-1' }],
        setActiveProjectId: vi.fn(),
      },
      userSession: {
        startupProjectCatalogStage: () => 'resolved',
      },
      startupLaunchSnapshot: null,
      router: { navigate },
      resolveStartupProjectFallbackId: vi.fn(),
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      syncStateFromRoute: (this: WorkspaceShellComponent) => void;
    }).syncStateFromRoute.call(context);

    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

});
