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
    } as unknown as AppProjectCoordinatorService;

    AppProjectCoordinatorService.prototype.startRenameProject.call(
      context,
      'proj-1',
      null as unknown as string,
      { stopPropagation } as unknown as Event
    );

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(renamingProjectId.set).toHaveBeenCalledWith('proj-1');
    expect(renameProjectName.set).toHaveBeenCalledWith('');
    // originalProjectName 是私有属性，测试通过 context 对象直接验证
    expect((context as unknown as Record<string, unknown>)['originalProjectName']).toBe('');
  });

  it('executeRenameProject should not throw when renameProjectName is null at runtime', () => {
    const renameProject = vi.fn();
    const success = vi.fn();
    const cancelRenameProject = vi.fn();
    const context = {
      renamingProjectId: () => 'proj-1',
      renameProjectName: () => null,
      originalProjectName: '',
      projectOps: { renameProject },
      toast: { success },
      cancelRenameProject,
    } as unknown as AppProjectCoordinatorService;

    expect(() => AppProjectCoordinatorService.prototype.executeRenameProject.call(context)).not.toThrow();
    expect(renameProject).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(cancelRenameProject).toHaveBeenCalledOnce();
  });

  it('executeRenameProject should delegate to ProjectOperationService on valid rename', () => {
    const renameProject = vi.fn().mockReturnValue(true);
    const success = vi.fn();
    const cancelRenameProject = vi.fn();
    const context = {
      renamingProjectId: () => 'proj-1',
      renameProjectName: () => '  New Name  ',
      originalProjectName: 'Old Name',
      projectOps: { renameProject },
      toast: { success },
      cancelRenameProject,
    } as unknown as AppProjectCoordinatorService;

    AppProjectCoordinatorService.prototype.executeRenameProject.call(context);

    expect(renameProject).toHaveBeenCalledWith('proj-1', 'New Name');
    expect(success).toHaveBeenCalledOnce();
    expect(cancelRenameProject).toHaveBeenCalledOnce();
  });

  it('handleImportComplete should delegate existing project import to ProjectOperationService', async () => {
    const upsertImportedProject = vi.fn().mockResolvedValue({ success: true });
    const success = vi.fn();
    const context = {
      projectState: {
        getProject: vi.fn().mockReturnValue({ id: 'proj-1' }),
      },
      projectOps: { upsertImportedProject },
      toast: { success, error: vi.fn() },
    } as unknown as AppProjectCoordinatorService;

    await AppProjectCoordinatorService.prototype.handleImportComplete.call(context, {
      id: 'proj-1',
      name: 'Imported',
      description: '',
      createdDate: '2026-03-30T00:00:00.000Z',
      tasks: [],
      connections: [],
    });

    expect(upsertImportedProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'proj-1' }));
    expect(success).toHaveBeenCalledWith('导入成功', '项目 "Imported" 已更新');
  });
});
