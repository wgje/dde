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

  it('executeRenameProject should not throw when renameProjectName is null at runtime', async () => {
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

    await expect(AppProjectCoordinatorService.prototype.executeRenameProject.call(context)).resolves.toBeUndefined();
    expect(renameProject).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(cancelRenameProject).toHaveBeenCalledOnce();
  });

  it('executeRenameProject should delegate to ProjectOperationService on valid rename', async () => {
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

    await AppProjectCoordinatorService.prototype.executeRenameProject.call(context);

    expect(renameProject).toHaveBeenCalledWith('proj-1', 'New Name');
    expect(success).toHaveBeenCalledOnce();
    expect(cancelRenameProject).toHaveBeenCalledOnce();
  });

  it('executeRenameProject should single-flight duplicate Enter and blur submissions', async () => {
    let resolveRename!: (value: boolean) => void;
    const renamePromise = new Promise<boolean>(resolve => {
      resolveRename = resolve;
    });
    const renameProject = vi.fn().mockReturnValue(renamePromise);
    const success = vi.fn();
    const renamingProjectId = Object.assign(vi.fn(() => 'proj-1'), { set: vi.fn() });
    const renameProjectName = Object.assign(vi.fn(() => 'New Name'), { set: vi.fn() });
    const context = {
      renamingProjectId,
      renameProjectName,
      originalProjectName: 'Old Name',
      projectOps: { renameProject },
      toast: { success },
      cancelRenameProject: AppProjectCoordinatorService.prototype.cancelRenameProject,
    } as unknown as AppProjectCoordinatorService;

    const first = AppProjectCoordinatorService.prototype.executeRenameProject.call(context);
    const second = AppProjectCoordinatorService.prototype.executeRenameProject.call(context);
    resolveRename(true);
    await Promise.all([first, second]);

    expect(renameProject).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
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

  it('saveProjectDetails should serialize description saves and keep editing on failed stale save', async () => {
    let resolveFirst!: (value: { success: boolean; error?: string }) => void;
    const firstSave = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveFirst = resolve;
    });
    const updateProjectMetadata = vi
      .fn()
      .mockReturnValueOnce(firstSave)
      .mockResolvedValueOnce({ success: true });
    const editingValues: boolean[] = [];
    let editing = true;
    const drafts: Record<string, { description: string; createdDate: string }> = {
      'proj-1': { description: 'first draft', createdDate: '' },
    };
    const context = {
      projectDraft: AppProjectCoordinatorService.prototype.projectDraft,
      runProjectDetailsSave: (
        AppProjectCoordinatorService.prototype as unknown as {
          runProjectDetailsSave: (projectId: string, description: string) => Promise<void>;
        }
      ).runProjectDetailsSave,
      projectDrafts: () => drafts,
      isEditingDescription: {
        set: vi.fn((value: boolean) => {
          editing = value;
          editingValues.push(value);
        }),
      },
      projectDetailsSaveFlights: new Map<string, Promise<void>>(),
      projectOps: { updateProjectMetadata },
    } as unknown as AppProjectCoordinatorService;

    const first = AppProjectCoordinatorService.prototype.saveProjectDetails.call(context, 'proj-1');
    drafts['proj-1'] = { description: 'second draft', createdDate: '' };
    const second = AppProjectCoordinatorService.prototype.saveProjectDetails.call(context, 'proj-1');

    await vi.waitFor(() => {
      expect(updateProjectMetadata).toHaveBeenCalledTimes(1);
    });

    resolveFirst({ success: false, error: 'network' });
    await Promise.all([first, second]);

    expect(updateProjectMetadata).toHaveBeenNthCalledWith(1, 'proj-1', { description: 'first draft' });
    expect(updateProjectMetadata).toHaveBeenNthCalledWith(2, 'proj-1', { description: 'second draft' });
    expect(editing).toBe(false);
    expect(editingValues).toEqual([true, false]);
  });
});
