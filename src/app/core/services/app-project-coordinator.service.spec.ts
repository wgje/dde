import { describe, expect, it, vi } from 'vitest';
import { AppProjectCoordinatorService } from './app-project-coordinator.service';

describe('AppProjectCoordinatorService rename guard', () => {
  it('startRenameProject should coerce null-ish runtime name to empty string', () => {
    const renamingProjectId = { set: vi.fn() };
    const renameProjectName = { set: vi.fn() };
    const stopPropagation = vi.fn();
    const context = {
      renamingProjectId,
      renameProjectName,
      originalProjectName: '',
    } as unknown as AppProjectCoordinatorService & { originalProjectName: string };

    AppProjectCoordinatorService.prototype.startRenameProject.call(
      context,
      'proj-1',
      null as unknown as string,
      { stopPropagation } as unknown as Event
    );

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(renamingProjectId.set).toHaveBeenCalledWith('proj-1');
    expect(renameProjectName.set).toHaveBeenCalledWith('');
    expect(context.originalProjectName).toBe('');
  });

  it('executeRenameProject should not throw when renameProjectName is null at runtime', () => {
    const renameProject = vi.fn();
    const success = vi.fn();
    const cancelRenameProject = vi.fn();
    const context = {
      renamingProjectId: () => 'proj-1',
      renameProjectName: () => null,
      originalProjectName: '',
      projectState: { renameProject },
      toast: { success },
      cancelRenameProject,
    } as unknown as AppProjectCoordinatorService;

    expect(() => AppProjectCoordinatorService.prototype.executeRenameProject.call(context)).not.toThrow();
    expect(renameProject).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(cancelRenameProject).toHaveBeenCalledOnce();
  });
});
