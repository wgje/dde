import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModalService } from '../../../services/modal.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ProjectStateService, type ActiveProjectOwner } from '../../../services/project-state.service';
import { ProjectSwitchGuardService } from '../../../services/guards/unsaved-changes.guard';
import { ToastService } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';
import { ModalLoaderService } from './modal-loader.service';
import { AppProjectCoordinatorService } from './app-project-coordinator.service';

afterEach(() => TestBed.resetTestingModule());

function createDeleteHarness() {
  let activeProjectId = 'project-a';
  let generation = 1;
  const projectChangeListeners = new Set<(
    previousId: string | null,
    nextId: string | null,
  ) => void>();
  let resolveModal!: (result: { confirmed: boolean } | undefined) => void;
  let modalRef: { close: ReturnType<typeof vi.fn>; result: Promise<{ confirmed: boolean } | undefined> } | null = null;
  const deleteProject = vi.fn().mockResolvedValue({ success: true });
  const openDeleteConfirmModal = vi.fn(async (
    _data: unknown,
    canOpen: () => boolean = () => true,
  ) => {
    if (!canOpen()) return null;
    const result = new Promise<{ confirmed: boolean } | undefined>(resolve => {
      resolveModal = resolve;
    });
    modalRef = { close: vi.fn(), result };
    return modalRef;
  });
  const projectState = {
    activeProjectId: () => activeProjectId,
    isActiveProjectOwnerCurrent: (owner: ActiveProjectOwner) => (
      owner.projectId === activeProjectId && owner.generation === generation
    ),
    registerBeforeActiveProjectChange: (
      listener: (previousId: string | null, nextId: string | null) => void,
    ) => {
      projectChangeListeners.add(listener);
      return () => projectChangeListeners.delete(listener);
    },
  };

  TestBed.configureTestingModule({ providers: [
    AppProjectCoordinatorService,
    { provide: ProjectStateService, useValue: projectState },
    { provide: ProjectOperationService, useValue: { deleteProject } },
    { provide: ProjectSwitchGuardService, useValue: { canSwitchProject: vi.fn().mockResolvedValue('proceed') } },
    { provide: UiStateService, useValue: {} },
    { provide: ModalService, useValue: {} },
    { provide: ModalLoaderService, useValue: { openDeleteConfirmModal } },
    { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
    { provide: Router, useValue: {} },
  ] });

  const service = TestBed.inject(AppProjectCoordinatorService);
  return {
    service,
    deleteProject,
    openDeleteConfirmModal,
    get modalRef() { return modalRef; },
    get resolveModal() { return resolveModal; },
    owner: (): ActiveProjectOwner => ({ projectId: activeProjectId, generation }),
    switchTo(nextProjectId: string) {
      const previousId = activeProjectId;
      generation += 1;
      for (const listener of projectChangeListeners) listener(previousId, nextProjectId);
      activeProjectId = nextProjectId;
    },
  };
}

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

describe('AppProjectCoordinatorService delete ownership', () => {
  it('closes the source-owned modal on project change and ignores its late confirmation', async () => {
    const harness = createDeleteHarness();
    const event = { stopPropagation: vi.fn() } as unknown as Event;
    const confirmation = harness.service.confirmDeleteProject(
      'project-a', 'Project A', event, harness.owner(),
    );
    await vi.waitFor(() => expect(harness.modalRef).not.toBeNull());

    const canOpen = harness.openDeleteConfirmModal.mock.calls[0]?.[1];
    expect(canOpen?.()).toBe(true);
    harness.switchTo('project-b');
    expect(harness.modalRef?.close).toHaveBeenCalledOnce();
    expect(canOpen?.()).toBe(false);

    harness.resolveModal({ confirmed: true });
    await confirmation;

    expect(harness.deleteProject).not.toHaveBeenCalled();
  });
});
