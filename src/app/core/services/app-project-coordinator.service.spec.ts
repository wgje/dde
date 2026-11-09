import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ModalService } from '../../../services/modal.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ProjectStateService, type ActiveProjectOwner } from '../../../services/project-state.service';
import { ToastService } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';
import { ProjectSwitchGuardService } from '../../../services/guards/unsaved-changes.guard';
import { ModalLoaderService } from './modal-loader.service';
import { AppProjectCoordinatorService } from './app-project-coordinator.service';

function currentRenameState(projectId = 'proj-1') {
  const projectOwner = { projectId, generation: 0 };
  return {
    projectState: { captureActiveProjectOwner: () => projectOwner, isActiveProjectOwnerCurrent: () => true },
    renameSessionToken: 1, activeRenameOwner: { projectOwner, sessionToken: 1 }, renameSessionFlights: new Map(),
    isRenameOwnerCurrent: () => true,
    retireRenameSession: vi.fn(),
  };
}

function createRenameHarness() {
  let projectId = 'project-a';
  let generation = 0;
  const listeners = new Set<(previous: string | null, next: string | null) => void>();
  const pending: Array<{ projectId: string; resolve: (result: boolean) => void }> = [];
  const renameProject = vi.fn((id: string) => new Promise<boolean>(resolve => pending.push({ projectId: id, resolve })));
  const toast = { success: vi.fn(), error: vi.fn() };
  const projectState = {
    activeProjectId: () => projectId,
    captureActiveProjectOwner: () => ({ projectId, generation }),
    isActiveProjectOwnerCurrent: (owner: { projectId: string | null; generation: number }) =>
      owner.projectId === projectId && owner.generation === generation,
    registerBeforeActiveProjectChange: (listener: (previous: string | null, next: string | null) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  TestBed.configureTestingModule({ providers: [
    AppProjectCoordinatorService,
    { provide: ProjectStateService, useValue: projectState },
    { provide: ProjectOperationService, useValue: { renameProject } },
    { provide: UiStateService, useValue: {} }, { provide: ModalService, useValue: {} },
    { provide: ModalLoaderService, useValue: {} }, { provide: ToastService, useValue: toast },
    { provide: ProjectSwitchGuardService, useValue: {} }, { provide: Router, useValue: {} },
  ] });
  const service = TestBed.inject(AppProjectCoordinatorService);
  const open = (id: string, name: string) => service.startRenameProject(id, name, { stopPropagation() {} } as Event);
  const switchTo = (next: string) => {
    if (next === projectId) return;
    const previous = projectId;
    generation += 1;
    for (const listener of listeners) listener(previous, next);
    projectId = next;
  };
  return { service, open, switchTo, renameProject, pending, toast };
}

function createDeleteHarness() {
  let projectId = 'project-a';
  let generation = 1;
  let modalGate: { promise: Promise<void>; resolve: () => void } | null = null;
  const listeners = new Set<(previous: string | null, next: string | null) => void>();
  const modals: Array<{
    close: ReturnType<typeof vi.fn>;
    result: Promise<{ confirmed: boolean } | undefined>;
    resolve: (result: { confirmed: boolean } | undefined) => void;
  }> = [];
  const pendingDeletes: Array<{
    options?: { canPublishUi: () => boolean };
    resolve: (result: { success: boolean; error?: string }) => void;
  }> = [];
  const deleteProject = vi.fn((
    _id: string,
    options?: { canPublishUi: () => boolean },
  ) => new Promise<{ success: boolean; error?: string }>(resolve => {
    pendingDeletes.push({ options, resolve });
  }));
  const toast = { success: vi.fn(), error: vi.fn() };
  const projectState = {
    activeProjectId: () => projectId,
    getProject: (id: string) => ({ id, name: id }),
    captureActiveProjectOwner: () => ({ projectId, generation }),
    isActiveProjectOwnerCurrent: (owner: ActiveProjectOwner) =>
      owner.projectId === projectId && owner.generation === generation,
    registerBeforeActiveProjectChange: (listener: (previous: string | null, next: string | null) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const openDeleteConfirmModal = vi.fn(async (
    _data: unknown,
    canOpen: () => boolean = () => true,
  ) => {
    const gate = modalGate;
    modalGate = null;
    if (gate) await gate.promise;
    if (!canOpen()) return null;
    let resolve!: (result: { confirmed: boolean } | undefined) => void;
    const result = new Promise<{ confirmed: boolean } | undefined>(done => { resolve = done; });
    const modal = { close: vi.fn(), result, resolve };
    modals.push(modal);
    return modal;
  });
  TestBed.configureTestingModule({ providers: [
    AppProjectCoordinatorService,
    { provide: ProjectStateService, useValue: projectState },
    { provide: ProjectOperationService, useValue: { deleteProject, renameProject: vi.fn() } },
    { provide: UiStateService, useValue: {} }, { provide: ModalService, useValue: {} },
    { provide: ModalLoaderService, useValue: { openDeleteConfirmModal } },
    { provide: ToastService, useValue: toast },
    { provide: ProjectSwitchGuardService, useValue: {} }, { provide: Router, useValue: {} },
  ] });
  const service = TestBed.inject(AppProjectCoordinatorService);
  const owner = (): ActiveProjectOwner => ({ projectId, generation });
  const switchTo = (next: string) => {
    if (next === projectId) return;
    const previous = projectId;
    generation += 1;
    for (const listener of listeners) listener(previous, next);
    projectId = next;
  };
  const deferModalLoad = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    modalGate = { promise, resolve };
    return modalGate;
  };
  return {
    service, owner, switchTo, deferModalLoad, openDeleteConfirmModal,
    deleteProject, pendingDeletes, modals, toast,
  };
}

describe('AppProjectCoordinatorService rename guard', () => {
  it('startRenameProject should coerce null-ish runtime name to empty string', () => {
    const renamingProjectId = { set: vi.fn() };
    const renameProjectName = { set: vi.fn() };
    const stopPropagation = vi.fn();
    const context = {
      ...currentRenameState(),
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
      ...currentRenameState(),
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
      ...currentRenameState(),
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
      ...currentRenameState(),
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

  it('retires rename synchronously on project change but preserves duplicate project emission', () => {
    const { service, open, switchTo } = createRenameHarness();
    open('project-a', 'A');
    switchTo('project-a');
    expect(service.renamingProjectId()).toBe('project-a');
    switchTo('project-b');
    expect(service.renamingProjectId()).toBeNull();
    open('project-a', 'stale A');
    expect(service.renamingProjectId()).toBeNull();
  });

  it('dispatches B independently and prevents late A UI publication', async () => {
    const { service, open, switchTo, renameProject, pending, toast } = createRenameHarness();
    open('project-a', 'A'); service.renameProjectName.set('A1');
    const a = service.executeRenameProject();
    switchTo('project-b'); open('project-b', 'B'); service.renameProjectName.set('B1');
    const b = service.executeRenameProject();
    expect(renameProject.mock.calls.map(call => call[0])).toEqual(['project-a', 'project-b']);
    pending[0].resolve(true); await a;
    expect(toast.success).not.toHaveBeenCalled();
    expect(service.renamingProjectId()).toBe('project-b');
    pending[1].resolve(true); await b;
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(service.renamingProjectId()).toBeNull();
  });

  it('rejects A-B-A and same-project replacement stale completions', async () => {
    const { service, open, switchTo, pending, toast } = createRenameHarness();
    open('project-a', 'A'); service.renameProjectName.set('A1');
    const first = service.executeRenameProject();
    switchTo('project-b'); switchTo('project-a'); open('project-a', 'A replacement');
    pending[0].resolve(true); await first;
    expect(service.renameProjectName()).toBe('A replacement');
    open('project-a', 'A2'); service.renameProjectName.set('A2 saved');
    const second = service.executeRenameProject();
    open('project-a', 'A3 replacement');
    pending[1].resolve(true); await second;
    expect(service.renameProjectName()).toBe('A3 replacement');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('deduplicates Enter and blur only within the same rename session', async () => {
    const { service, open, renameProject, pending } = createRenameHarness();
    open('project-a', 'A'); service.renameProjectName.set('A1');
    const enter = service.executeRenameProject();
    const blur = service.executeRenameProject();
    expect(renameProject).toHaveBeenCalledTimes(1);
    pending[0].resolve(true);
    await Promise.all([enter, blur]);
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

  it('handleImportComplete should reject when updating an imported project is not durable', async () => {
    const failure = { success: false, error: '离线同步队列未能写入' };
    const error = vi.fn();
    const context = {
      projectState: {
        getProject: vi.fn().mockReturnValue({ id: 'proj-1' }),
      },
      projectOps: {
        upsertImportedProject: vi.fn().mockResolvedValue(failure),
      },
      toast: { success: vi.fn(), error },
    } as unknown as AppProjectCoordinatorService;

    const importedProject = {
      id: 'proj-1',
      name: 'Imported',
      description: '',
      createdDate: '2026-03-30T00:00:00.000Z',
      tasks: [],
      connections: [],
    };

    await expect(
      AppProjectCoordinatorService.prototype.handleImportComplete.call(context, importedProject),
    ).rejects.toThrow('离线同步队列未能写入');
    expect(error).toHaveBeenCalledWith('导入失败', '无法更新项目 "Imported"');
  });

  it('handleImportComplete should reject when creating an imported project is not durable', async () => {
    const failure = { success: false, error: '本地快照写入失败' };
    const error = vi.fn();
    const context = {
      projectState: {
        getProject: vi.fn().mockReturnValue(undefined),
      },
      projectOps: {
        addProject: vi.fn().mockResolvedValue(failure),
      },
      toast: { success: vi.fn(), error },
    } as unknown as AppProjectCoordinatorService;

    const importedProject = {
      id: 'proj-new',
      name: 'Imported',
      description: '',
      createdDate: '2026-03-30T00:00:00.000Z',
      tasks: [],
      connections: [],
    };

    await expect(
      AppProjectCoordinatorService.prototype.handleImportComplete.call(context, importedProject),
    ).rejects.toThrow('本地快照写入失败');
    expect(error).toHaveBeenCalledWith('导入失败', '无法导入项目 "Imported"');
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
  it.each([
    ['A -> B', ['project-b']],
    ['A -> B -> A', ['project-b', 'project-a']],
  ])('rejects a deferred A modal before DOM creation after %s', async (_label, projects) => {
    const harness = createDeleteHarness();
    const gate = harness.deferModalLoad();
    const completion = harness.service.confirmDeleteProject(
      'project-a', 'Project A', { stopPropagation() {} } as Event, harness.owner(),
    );
    for (const project of projects) harness.switchTo(project);

    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.modals).toHaveLength(0);
    expect(harness.deleteProject).not.toHaveBeenCalled();
    await completion;
  });

  it('preserves duplicate A but synchronously closes its modal on a real project change', async () => {
    const harness = createDeleteHarness();
    const completion = harness.service.confirmDeleteProject(
      'project-a', 'Project A', { stopPropagation() {} } as Event, harness.owner(),
    );
    await vi.waitFor(() => expect(harness.modals).toHaveLength(1));

    harness.switchTo('project-a');
    expect(harness.modals[0].close).not.toHaveBeenCalled();
    harness.switchTo('project-b');
    expect(harness.modals[0].close).toHaveBeenCalledOnce();

    harness.modals[0].resolve(undefined);
    await completion;
    expect(harness.deleteProject).not.toHaveBeenCalled();
  });

  it('replaces a same-project delete session and rejects late confirmation from the old modal', async () => {
    const harness = createDeleteHarness();
    const projectOwner = harness.owner();
    const first = harness.service.confirmDeleteProject(
      'project-a', 'Project A', { stopPropagation() {} } as Event, projectOwner,
    );
    await vi.waitFor(() => expect(harness.modals).toHaveLength(1));
    const second = harness.service.confirmDeleteProject(
      'project-a', 'Project A', { stopPropagation() {} } as Event, projectOwner,
    );
    await vi.waitFor(() => expect(harness.modals).toHaveLength(2));

    expect(harness.modals[0].close).toHaveBeenCalledOnce();
    harness.modals[0].resolve({ confirmed: true });
    await first;
    expect(harness.deleteProject).not.toHaveBeenCalled();
    harness.modals[1].resolve(undefined);
    await second;
  });

  it('keeps the global durable flight while suppressing stale A UI publication', async () => {
    const harness = createDeleteHarness();
    const completion = harness.service.confirmDeleteProject(
      'project-a', 'Project A', { stopPropagation() {} } as Event, harness.owner(),
    );
    await vi.waitFor(() => expect(harness.modals).toHaveLength(1));
    harness.modals[0].resolve({ confirmed: true });
    await vi.waitFor(() => expect(harness.pendingDeletes).toHaveLength(1));

    expect(harness.service.isDeleting()).toBe(true);
    harness.switchTo('project-b');
    harness.service.expandedProjectId.set('project-b');
    expect(harness.pendingDeletes[0].options?.canPublishUi()).toBe(false);
    expect(harness.service.isDeleting()).toBe(true);

    harness.pendingDeletes[0].resolve({ success: true });
    await completion;
    expect(harness.deleteProject).toHaveBeenCalledWith('project-a', expect.any(Object));
    expect(harness.service.expandedProjectId()).toBe('project-b');
    expect(harness.toast.success).not.toHaveBeenCalled();
    expect(harness.service.isDeleting()).toBe(false);
  });
});

describe('AppProjectCoordinatorService project switch ordering', () => {
  const flushAsyncWork = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  };

  const createContext = (overrides: Record<string, unknown> = {}) => {
    const context = Object.create(AppProjectCoordinatorService.prototype) as Record<string, unknown>;
    Object.assign(context, {
      projectSelectionRequestId: 0,
      projectSwitchGuardInFlight: null,
      expandedProjectId: Object.assign(vi.fn(() => null), { set: vi.fn() }),
      isEditingDescription: Object.assign(vi.fn(() => false), { set: vi.fn() }),
      ensureProjectDraft: vi.fn(),
      saveProjectDetails: vi.fn().mockResolvedValue(undefined),
      projectState: { activeProjectId: vi.fn(() => 'old-project') },
      projectSwitchGuard: { canSwitchProject: vi.fn().mockResolvedValue('proceed') },
      uiState: {
        activeView: vi.fn(() => 'text'),
        isMobile: vi.fn(() => false),
      },
      router: { navigate: vi.fn().mockResolvedValue(true) },
      toast: { error: vi.fn() },
      ...overrides,
    });
    Object.defineProperty(context, 'userSession', {
      configurable: true,
      value: { switchActiveProject: vi.fn() },
    });
    return context as unknown as AppProjectCoordinatorService;
  };

  it('enterProject 在导航成功前不得切换 active project', async () => {
    let resolveNavigation!: (value: boolean) => void;
    const navigate = vi.fn().mockReturnValue(new Promise<boolean>(resolve => {
      resolveNavigation = resolve;
    }));
    const context = createContext({
      router: { navigate },
      uiState: {
        activeView: vi.fn(() => 'flow'),
        isMobile: vi.fn(() => true),
      },
    });
    const userSession = (context as unknown as { userSession: { switchActiveProject: ReturnType<typeof vi.fn> } }).userSession;
    const sidebarOpen = { set: vi.fn() };

    AppProjectCoordinatorService.prototype.enterProject.call(context, 'new-project', sidebarOpen);

    expect(navigate).toHaveBeenCalledWith(['/projects', 'new-project', 'flow']);
    expect(userSession.switchActiveProject).not.toHaveBeenCalled();
    expect(sidebarOpen.set).not.toHaveBeenCalled();

    resolveNavigation(true);
    await flushAsyncWork();

    expect(userSession.switchActiveProject).toHaveBeenCalledWith('new-project');
    expect(sidebarOpen.set).toHaveBeenCalledWith(false);
  });

  it('导航被 guard 取消时不改变 active project 或展开状态', async () => {
    const context = createContext({
      router: { navigate: vi.fn().mockResolvedValue(false) },
      uiState: {
        activeView: vi.fn(() => 'text'),
        isMobile: vi.fn(() => true),
      },
    });
    const userSession = (context as unknown as { userSession: { switchActiveProject: ReturnType<typeof vi.fn> } }).userSession;
    const expandedProjectId = (context as unknown as { expandedProjectId: { set: ReturnType<typeof vi.fn> } }).expandedProjectId;
    const sidebarOpen = { set: vi.fn() };

    AppProjectCoordinatorService.prototype.enterProject.call(context, 'cancelled-project', sidebarOpen);
    await flushAsyncWork();

    expect(userSession.switchActiveProject).not.toHaveBeenCalled();
    expect(expandedProjectId.set).not.toHaveBeenCalled();
    expect(sidebarOpen.set).not.toHaveBeenCalled();
  });

  it('桌面 selectProject 被项目切换 guard 取消时保持旧项目', async () => {
    const canSwitchProject = vi.fn().mockResolvedValue('cancel');
    const context = createContext({
      projectSwitchGuard: { canSwitchProject },
    });
    const userSession = (context as unknown as { userSession: { switchActiveProject: ReturnType<typeof vi.fn> } }).userSession;
    const expandedProjectId = (context as unknown as { expandedProjectId: { set: ReturnType<typeof vi.fn> } }).expandedProjectId;

    AppProjectCoordinatorService.prototype.selectProject.call(context, 'new-project', { set: vi.fn() });
    await flushAsyncWork();

    expect(canSwitchProject).toHaveBeenCalledOnce();
    expect(userSession.switchActiveProject).not.toHaveBeenCalled();
    expect(expandedProjectId.set).not.toHaveBeenCalled();
  });

  it('快速连续选择时只让最后一个请求在共享 guard 结算后生效', async () => {
    let resolveGuard!: (value: 'proceed' | 'cancel') => void;
    const canSwitchProject = vi.fn().mockReturnValue(new Promise<'proceed' | 'cancel'>(resolve => {
      resolveGuard = resolve;
    }));
    const context = createContext({
      projectSwitchGuard: { canSwitchProject },
    });
    const userSession = (context as unknown as { userSession: { switchActiveProject: ReturnType<typeof vi.fn> } }).userSession;

    AppProjectCoordinatorService.prototype.selectProject.call(context, 'project-a', { set: vi.fn() });
    AppProjectCoordinatorService.prototype.selectProject.call(context, 'project-b', { set: vi.fn() });

    await vi.waitFor(() => {
      expect(canSwitchProject).toHaveBeenCalledTimes(1);
    });
    resolveGuard('proceed');

    await vi.waitFor(() => {
      expect(userSession.switchActiveProject).toHaveBeenCalledTimes(1);
    });

    expect(canSwitchProject).toHaveBeenCalledTimes(1);
    expect(userSession.switchActiveProject).toHaveBeenCalledTimes(1);
    expect(userSession.switchActiveProject).toHaveBeenCalledWith('project-b');
  });
});
