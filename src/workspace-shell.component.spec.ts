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

  it('signalWorkspaceHandoffReady 应只通知一次 boot stage handoff', () => {
    const markWorkspaceHandoffReady = vi.fn();
    const markLayoutStable = vi.fn();
    const context = {
      bootStage: { markWorkspaceHandoffReady },
      handoffCoordinator: { markLayoutStable },
      workspaceHandoffSignaled: false,
    } as unknown as WorkspaceShellComponent;

    (WorkspaceShellComponent.prototype as unknown as {
      signalWorkspaceHandoffReady: (this: WorkspaceShellComponent) => void;
    }).signalWorkspaceHandoffReady.call(context);
    (WorkspaceShellComponent.prototype as unknown as {
      signalWorkspaceHandoffReady: (this: WorkspaceShellComponent) => void;
    }).signalWorkspaceHandoffReady.call(context);

    if (FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2) {
      expect(markLayoutStable).toHaveBeenCalledTimes(1);
      expect(markWorkspaceHandoffReady).not.toHaveBeenCalled();
    } else {
      expect(markWorkspaceHandoffReady).toHaveBeenCalledTimes(1);
      expect(markLayoutStable).not.toHaveBeenCalled();
    }
  });

});
