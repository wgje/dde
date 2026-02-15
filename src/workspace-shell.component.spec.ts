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
});
