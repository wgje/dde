import { signal, type Type } from '@angular/core';
import { vi } from 'vitest';

import type { WorkspaceShellTemplateSurface } from './workspace-shell-template-surface.factory';

/**
 * 现有 shell/component spec 统一用「信号替换」方式设置 input()（见 sync-status spec 说明），
 * 避免 required input 在测试环境下的 NG0950 时序问题。
 */
export function setShellViewTemplateInput(
  componentInstance: unknown,
  surface: WorkspaceShellTemplateSurface,
): void {
  (componentInstance as { template: unknown }).template = signal(surface);
}

/**
 * 壳层视图子组件（session-status / startup-hint / sidebar-panel / login-required）
 * 的最小 template surface 假件：只提供模板渲染路径实际读取的信号与回调，
 * 事件回调统一用 vi.fn() 以便断言交互转发。
 */
export function createWorkspaceShellViewTemplateSurfaceFake() {
  const isSidebarOpen = signal(true);
  const focusSessionTriggerComponent = signal<Type<unknown> | null>(null);
  const blackBoxRecorderComponent = signal<Type<unknown> | null>(null);
  const panelToolsIntent = {
    register: vi.fn(() => ({ unregister: vi.fn() })),
    emit: vi.fn(),
  };
  const surface = {
    state: {
      authCoord: {
        bootstrapFailed: signal(false),
        isCheckingSession: signal(false),
        sessionEmail: signal<string | null>('user@example.com'),
      },
      floatingNoticeChrome: {
        blockingStartupHintOverlayVisible: signal(false),
        compactStartupHintBannerVisible: signal(false),
        compactStartupHintBannerTop: signal('12px'),
        installPromptTop: signal('0px'),
        pwaPromptVisible: signal(false),
      },
      focusChrome: {
        mobileSidebarBackdropVisible: signal(false),
        workspaceSidebarOpacity: signal('1'),
        workspaceSidebarTransform: signal('none'),
        workspaceSidebarPointerEvents: signal('auto'),
        workspaceSidebarTransition: signal('none'),
        workspaceSidebarWidthPx: signal(280),
        workspaceSidebarContentOpacity: signal('1'),
        workspaceSidebarContentTransform: signal('none'),
        workspaceSidebarContentTransition: signal('none'),
        focusWorkspaceTakeoverActive: signal(false),
      },
      focusPrefs: { isBlackBoxEnabled: signal(false) },
      focusSyncControllers: {
        mountState: {
          shouldMountFocusMode: signal(false),
          shouldMountDeferredSyncStatus: signal(false),
        },
      },
      derivedUiState: { showLoginRequired: signal(true) },
      projectCoord: {
        renamingProjectId: signal<string | null>(null),
        renameProjectName: signal(''),
        expandedProjectId: signal<string | null>(null),
        isEditingDescription: signal(false),
        isDeleting: signal(false),
      },
      searchLazyLoad: {
        searchResults: signal<Array<{ id: string; title: string; _isParked?: boolean }>>([]),
        filteredProjects: signal<Array<{ id: string; name: string; createdDate: string }>>([
          { id: 'p-1', name: '示例项目', createdDate: new Date('2026-01-01').toISOString() },
        ]),
      },
      supabaseClient: { configurationError: signal<string | null>(null) },
      activeProjectId: signal<string | null>('p-1'),
      currentUserId: signal<string | null>('user-1'),
      deletedTasks: signal<unknown[]>([]),
      isMobile: signal(false),
      isSidebarOpen,
      offlineMode: signal(false),
      projects: signal([{ id: 'p-1', name: '示例项目' }]),
      sessionExpired: signal(false),
      unifiedSearchQuery: signal(''),
    },
    interaction: {
      actions: {
        createNewProject: vi.fn(),
        clearUnifiedSearch: vi.fn(),
        confirmDeleteProject: vi.fn(),
        enterProject: vi.fn(),
        executeRenameProject: vi.fn(),
        handleProjectDoubleClick: vi.fn(),
        onProjectCardClick: vi.fn(),
        onProjectDescriptionInput: vi.fn(),
        onRenameKeydown: vi.fn(),
        onRenameProjectNameInput: vi.fn(),
        onSearchTaskClick: vi.fn(),
        onUnifiedSearchInput: vi.fn(),
        openConfigHelpModal: vi.fn(),
        openDashboardAtConflicts: vi.fn(),
        openLoginModal: vi.fn(),
        openSettings: vi.fn(),
        openTrashModal: vi.fn(),
        projectDraft: vi.fn(() => ({ description: '' })),
        saveProjectDetails: vi.fn(),
        selectProject: vi.fn(),
        startProjectDescriptionEdit: vi.fn(),
        startRelogin: vi.fn(),
        startRenameProject: vi.fn(),
      },
      sidebarResize: {
        isResizingAny: signal(false),
        startSidebarResize: vi.fn(),
      },
      touchGestures: {
        onMainTouchStart: vi.fn(),
        onMainTouchMove: vi.fn(),
        onMainTouchEnd: vi.fn(),
        onSidebarTouchStart: vi.fn(),
        onSidebarTouchMove: vi.fn(),
        onSidebarTouchEnd: vi.fn(),
      },
    },
    modal: {
      actions: { isLoading: vi.fn(() => false) },
    },
    startup: {
      androidWidgetLazyLoad: {
        continueManualCallback: vi.fn(),
        useIntentFallback: vi.fn(),
        dismissManualCallback: vi.fn(),
      },
      pendingAndroidWidgetManualCallback: signal(false),
    },
    tools: {
      bindings: {
        focusSessionTriggerComponent,
        blackBoxRecorderComponent,
        blackBoxRecorderOutletInputs: {},
      },
      sidebar: {
        onToolsIntent: vi.fn(),
        loadFocusSessionTriggerComponent: vi.fn(
          async () => focusSessionTriggerComponent(),
        ),
        loadBlackBoxRecorderComponent: vi.fn(
          async () => blackBoxRecorderComponent(),
        ),
      },
      panelToolsIntent,
    },
  };

  return {
    surface: surface as unknown as WorkspaceShellTemplateSurface,
    raw: surface,
    panelToolsIntent,
  };
}
