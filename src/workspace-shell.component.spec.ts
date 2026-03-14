import { vi, describe, it, expect } from 'vitest';
import { WorkspaceShellComponent } from './workspace-shell.component';

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
      focusBlurActive: () => false,
      dockEngine: {
        focusTransition: () => ({ phase: 'entering' }),
      },
    } as unknown as WorkspaceShellComponent;
    const exitingContext = {
      focusBlurActive: () => false,
      dockEngine: {
        focusTransition: () => ({ phase: 'exiting' }),
      },
    } as unknown as WorkspaceShellComponent;
    const idleContext = {
      focusBlurActive: () => false,
      dockEngine: {
        focusTransition: () => null,
      },
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
  });

  it('resolveWorkspaceSidebarWidth 应在专注接管期收起侧边栏', () => {
    const collapsedContext = {
      resolveFocusWorkspaceTakeoverActive: () => true,
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const desktopContext = {
      resolveFocusWorkspaceTakeoverActive: () => false,
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => false,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;
    const mobileContext = {
      resolveFocusWorkspaceTakeoverActive: () => false,
      uiState: {
        sidebarOpen: () => true,
        isMobile: () => true,
        sidebarWidth: () => 320,
      },
    } as unknown as WorkspaceShellComponent;

    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(collapsedContext),
    ).toBe(0);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(desktopContext),
    ).toBe(320);
    expect(
      (WorkspaceShellComponent.prototype as unknown as {
        resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
      }).resolveWorkspaceSidebarWidth.call(mobileContext),
    ).toBe(240);
  });
});
