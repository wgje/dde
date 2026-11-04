import { DestroyRef, Injectable, inject, signal, Injector } from '@angular/core';
import { Router } from '@angular/router';
import { ProjectStateService, type ActiveProjectOwner } from '../../../services/project-state.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { UiStateService } from '../../../services/ui-state.service';
import { ModalService } from '../../../services/modal.service';
import { ModalLoaderService } from './modal-loader.service';
import { ToastService } from '../../../services/toast.service';
import { ProjectSwitchGuardService } from '../../../services/guards/unsaved-changes.guard';
import { Project } from '../../../models';
import type { UserSessionService } from '../../../services/user-session.service';

interface ProjectRenameOwner {
  projectOwner: ActiveProjectOwner;
  sessionToken: number;
}

interface ProjectDeleteOwner extends ActiveProjectOwner {
  deleteSessionToken: number;
}

interface ProjectDeleteModalRef {
  close(result?: { confirmed: boolean }): void;
  result: Promise<{ confirmed: boolean } | undefined>;
}

/**
 * 应用项目 UI 协调器
 *
 * 管理项目列表的 UI 状态和操作：
 * - 项目选择/展开/编辑/重命名
 * - 项目创建/删除
 * - 项目草稿管理
 */
@Injectable({ providedIn: 'root' })
export class AppProjectCoordinatorService {
  private readonly projectState = inject(ProjectStateService);
  private readonly projectOps = inject(ProjectOperationService);
  private readonly uiState = inject(UiStateService);
  private readonly modal = inject(ModalService);
  private readonly modalLoader = inject(ModalLoaderService);
  private readonly toast = inject(ToastService);
  private readonly projectSwitchGuard = inject(ProjectSwitchGuardService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  /** 延迟注入避免循环依赖 */
  private userSessionRef: UserSessionService | null = null;
  private get userSession(): UserSessionService {
    if (!this.userSessionRef) {
      const { UserSessionService: Svc } = require('../../../services/user-session.service');
      this.userSessionRef = this.injector.get(Svc);
    }
    return this.userSessionRef!;
  }

  // ========== UI 状态 Signals ==========
  readonly expandedProjectId = signal<string | null>(null);
  readonly isEditingDescription = signal(false);
  readonly projectDrafts = signal<Record<string, { description: string; createdDate: string }>>({});
  readonly renamingProjectId = signal<string | null>(null);
  readonly renameProjectName = signal('');
  readonly isDeleting = signal(false);
  private originalProjectName = '';
  private renameSessionToken = 0;
  private activeRenameOwner: ProjectRenameOwner | null = null;
  private readonly renameSessionFlights = new Map<number, Promise<void>>();
  private deleteSessionToken = 0;
  private activeDeleteOwner: ProjectDeleteOwner | null = null;
  private activeDeleteModal: ProjectDeleteModalRef | null = null;
  private readonly projectDetailsSaveFlights = new Map<string, Promise<void>>();
  private projectSelectionRequestId = 0;
  private projectSwitchGuardInFlight: Promise<'proceed' | 'cancel'> | null = null;

  constructor() {
    const unregister = this.projectState.registerBeforeActiveProjectChange(() => {
      this.retireRenameSession();
      this.retireDeleteSession();
    });
    this.destroyRef.onDestroy(unregister);
  }

  // ========== 项目选择 ==========

  selectProject(id: string, _sidebarOpen: { set: (v: boolean) => void }): void {
    const requestId = ++this.projectSelectionRequestId;
    if (this.expandedProjectId() === id) {
      if (this.isEditingDescription()) {
        void this.saveProjectDetails(id);
      }
      this.expandedProjectId.set(null);
      this.isEditingDescription.set(false);
      return;
    }

    void this.runSelectProject(id, requestId);
  }

  onProjectCardClick(event: MouseEvent, projectId: string): void {
    event.stopPropagation();
    if (this.isEditingDescription()) {
      void this.saveProjectDetails(projectId);
    }
  }

  /** 全局点击处理 — 由 AppComponent @HostListener 调用 */
  handleGlobalClick(event: MouseEvent): void {
    const expandedId = this.expandedProjectId();
    if (!expandedId) return;
    const target = event.target as HTMLElement;
    const isProjectItem = target.closest('[data-testid="project-item"]');
    const isProjectCard = target.closest('[data-testid="project-intro-card"]');
    if (!isProjectItem && !isProjectCard) {
      if (this.isEditingDescription()) {
        void this.saveProjectDetails(expandedId);
      }
      this.expandedProjectId.set(null);
      this.isEditingDescription.set(false);
    }
  }

  enterProject(id: string, sidebarOpen: { set: (v: boolean) => void }): void {
    const requestId = ++this.projectSelectionRequestId;
    void this.runEnterProject(id, sidebarOpen, requestId);
  }

  handleProjectDoubleClick(id: string, event: MouseEvent, sidebarOpen: { set: (v: boolean) => void }): void {
    event.preventDefault();
    event.stopPropagation();
    this.isEditingDescription.set(true);
    this.enterProject(id, sidebarOpen);
  }

  private async runSelectProject(id: string, requestId: number): Promise<void> {
    const expandedProjectId = this.expandedProjectId();
    if (expandedProjectId && this.isEditingDescription()) {
      await this.saveProjectDetails(expandedProjectId);
      if (!this.isProjectSelectionCurrent(requestId)) return;
    }

    const currentView = this.uiState.activeView() || 'text';
    if (this.uiState.isMobile() && currentView === 'flow') {
      const navigated = await this.navigateToProject(id, currentView, requestId);
      if (!navigated || !this.isProjectSelectionCurrent(requestId)) return;
      this.userSession.switchActiveProject(id);
      this.applyProjectSelection(id);
      return;
    }

    if (this.projectState.activeProjectId() !== id) {
      const decision = await this.requestProjectSwitchDecision();
      if (!this.isProjectSelectionCurrent(requestId) || decision === 'cancel') return;
      this.userSession.switchActiveProject(id);
    }

    if (this.isProjectSelectionCurrent(requestId)) {
      this.applyProjectSelection(id);
    }
  }

  private async runEnterProject(
    id: string,
    sidebarOpen: { set: (v: boolean) => void },
    requestId: number,
  ): Promise<void> {
    const currentView = this.uiState.activeView() || 'text';
    const navigated = await this.navigateToProject(id, currentView, requestId);
    if (!navigated || !this.isProjectSelectionCurrent(requestId)) return;

    // 路由 guard 已在旧 active project 上完成 flush；导航成功后再提交项目切换。
    this.userSession.switchActiveProject(id);
    this.applyProjectSelection(id);
    if (this.uiState.isMobile()) {
      sidebarOpen.set(false);
    }
  }

  private async navigateToProject(id: string, view: string, requestId: number): Promise<boolean> {
    try {
      return await this.router.navigate(['/projects', id, view]);
    } catch {
      if (this.isProjectSelectionCurrent(requestId)) {
        this.toast.error('项目切换失败');
      }
      return false;
    }
  }

  private requestProjectSwitchDecision(): Promise<'proceed' | 'cancel'> {
    if (this.projectSwitchGuardInFlight) {
      return this.projectSwitchGuardInFlight;
    }

    const operation = Promise.resolve()
      .then(() => this.projectSwitchGuard.canSwitchProject())
      .catch(() => {
        this.toast.error('项目切换失败');
        return 'cancel' as const;
      })
      .finally(() => {
        if (this.projectSwitchGuardInFlight === operation) {
          this.projectSwitchGuardInFlight = null;
        }
      });
    this.projectSwitchGuardInFlight = operation;
    return operation;
  }

  private applyProjectSelection(id: string): void {
    this.expandedProjectId.set(id);
    this.ensureProjectDraft(id);
    this.isEditingDescription.set(false);
  }

  private isProjectSelectionCurrent(requestId: number): boolean {
    return requestId === this.projectSelectionRequestId;
  }

  // ========== 重命名 ==========

  startRenameProject(projectId: string, currentName: string, event: Event): void {
    event.stopPropagation();
    const projectOwner = this.projectState.captureActiveProjectOwner();
    if (projectOwner.projectId !== projectId) return;
    const normalizedName = typeof currentName === 'string' ? currentName : '';
    this.activeRenameOwner = { projectOwner, sessionToken: ++this.renameSessionToken };
    this.renamingProjectId.set(projectId);
    this.renameProjectName.set(normalizedName);
    this.originalProjectName = normalizedName;
  }

  async executeRenameProject(): Promise<void> {
    const owner = this.activeRenameOwner;
    if (!owner || !this.isRenameOwnerCurrent(owner)) return;
    const existingFlight = this.renameSessionFlights.get(owner.sessionToken);
    if (existingFlight) return existingFlight;

    const renameProjectInFlight = (async () => {
      const projectId = this.renamingProjectId();
      const rawName = this.renameProjectName();
      const newName = (typeof rawName === 'string' ? rawName : '').trim();
      const renamed = !!projectId && newName !== '' && newName !== this.originalProjectName
        && await this.projectOps.renameProject(projectId, newName);
      if (!this.isRenameOwnerCurrent(owner)) return;
      if (renamed) {
        this.toast.success('项目重命名成功');
      }
      this.cancelRenameProject();
    })().finally(() => {
      if (this.renameSessionFlights.get(owner.sessionToken) === renameProjectInFlight) {
        this.renameSessionFlights.delete(owner.sessionToken);
      }
    });
    this.renameSessionFlights.set(owner.sessionToken, renameProjectInFlight);
    return renameProjectInFlight;
  }

  cancelRenameProject(): void {
    this.retireRenameSession();
  }

  private retireRenameSession(): void {
    this.activeRenameOwner = null;
    this.renamingProjectId.set(null);
    this.renameProjectName.set('');
  }

  private isRenameOwnerCurrent(owner: ProjectRenameOwner): boolean {
    const current = this.activeRenameOwner;
    return !!current && current.sessionToken === owner.sessionToken
      && current.projectOwner.projectId === owner.projectOwner.projectId
      && current.projectOwner.generation === owner.projectOwner.generation
      && this.projectState.isActiveProjectOwnerCurrent(owner.projectOwner);
  }

  onRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.executeRenameProject();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelRenameProject();
    }
  }

  // ========== 草稿管理 ==========

  projectDraft(projectId: string) {
    return this.projectDrafts()[projectId] ?? null;
  }

  updateProjectDraft(projectId: string, field: 'description' | 'createdDate', value: string): void {
    const base = this.projectDraft(projectId) ?? { description: '', createdDate: '' };
    const next = { ...base, [field]: value };
    this.projectDrafts.update(drafts => ({ ...drafts, [projectId]: next }));
  }

  async saveProjectDetails(projectId: string): Promise<void> {
    const draft = this.projectDraft(projectId);
    if (!draft) return;

    const description = draft.description;
    const existingFlight = this.projectDetailsSaveFlights.get(projectId) ?? Promise.resolve();
    const saveFlight = existingFlight
      .catch(() => undefined)
      .then(() => this.runProjectDetailsSave(projectId, description))
      .finally(() => {
        if (this.projectDetailsSaveFlights.get(projectId) === saveFlight) {
          this.projectDetailsSaveFlights.delete(projectId);
        }
      });
    this.projectDetailsSaveFlights.set(projectId, saveFlight);
    return saveFlight;
  }

  private async runProjectDetailsSave(projectId: string, description: string): Promise<void> {
    const result = await this.projectOps.updateProjectMetadata(projectId, { description });
    if (!result.success) {
      this.isEditingDescription.set(true);
      return;
    }

    if (this.projectDraft(projectId)?.description === description) {
      this.isEditingDescription.set(false);
    }
  }

  private ensureProjectDraft(projectId: string) {
    const drafts = this.projectDrafts();
    if (drafts[projectId]) return drafts[projectId];
    const project = this.projectState.getProject(projectId);
    if (!project) return null;
    const draft = {
      description: project.description ?? '',
      createdDate: this.formatDateInput(project.createdDate)
    };
    this.projectDrafts.update(curr => ({ ...curr, [projectId]: draft }));
    return draft;
  }

  private formatDateInput(value?: string): string {
    if (!value) return '';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }

  // ========== 项目 CRUD ==========

  createNewProject(): void {
    this.modal.show('newProject');
  }

  onFocusFlowNode(taskId: string): void {
    const task = this.projectState.getTask(taskId);
    if (!task) return;
    const projectId = this.projectState.activeProjectId();
    if (projectId) {
      void this.router.navigate(['/projects', projectId, 'task', taskId]);
    }
  }

  async confirmCreateProject(name: string, desc: string): Promise<void> {
    if (!name) return;
    const result = await this.projectOps.addProject({
      id: crypto.randomUUID(),
      name,
      description: desc,
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: []
    });
    if (result.success) {
      this.modal.closeByType('newProject', { name, description: desc });
    }
  }

  async confirmDeleteProject(
    projectId: string,
    projectName: string,
    event: Event,
    projectOwner: ActiveProjectOwner,
  ): Promise<void> {
    event.stopPropagation();
    if (this.isDeleting() || projectOwner.projectId !== projectId
      || !this.projectState.isActiveProjectOwnerCurrent(projectOwner)) return;
    this.retireDeleteSession();
    const owner: ProjectDeleteOwner = {
      ...projectOwner,
      deleteSessionToken: ++this.deleteSessionToken,
    };
    this.activeDeleteOwner = owner;
    const modalRef = await this.modalLoader.openDeleteConfirmModal<{ confirmed: boolean } | undefined>({
      title: '删除项目',
      message: '确定要删除项目吗？',
      itemName: projectName,
      warning: '此操作将删除项目及其所有任务，且无法撤销！'
    }, () => this.isDeleteOwnerCurrent(owner));
    if (!modalRef || !this.isDeleteOwnerCurrent(owner)) return;
    this.activeDeleteModal = modalRef;
    const result = await modalRef.result;
    if (!this.isDeleteOwnerCurrent(owner)) return;
    this.activeDeleteModal = null;
    if (!result?.confirmed) {
      this.retireDeleteSession(owner);
      return;
    }

    this.isDeleting.set(true);
    try {
      const deleteResult = await this.projectOps.deleteProject(projectId, {
        canPublishUi: () => this.isDeleteOwnerCurrent(owner),
      });
      if (deleteResult.success && this.isDeleteOwnerCurrent(owner)) {
        this.expandedProjectId.set(null);
        this.toast.success('项目已删除', `「${projectName}」已永久删除`);
      }
    } finally {
      this.isDeleting.set(false);
      this.retireDeleteSession(owner);
    }
  }

  private isDeleteOwnerCurrent(owner: ProjectDeleteOwner): boolean {
    return this.activeDeleteOwner === owner && this.projectState.isActiveProjectOwnerCurrent(owner);
  }

  private retireDeleteSession(owner?: ProjectDeleteOwner): void {
    if (owner && this.activeDeleteOwner !== owner) return;
    this.activeDeleteOwner = null;
    const modal = this.activeDeleteModal;
    this.activeDeleteModal = null;
    modal?.close();
  }

  async handleImportComplete(project: Project): Promise<void> {
    const existingProject = this.projectState.getProject(project.id);
    const result = existingProject
      ? await this.projectOps.upsertImportedProject(project)
      : await this.projectOps.addProject(project);
    const action = existingProject ? '更新' : '导入';

    if (!result.success) {
      const message = `无法${action}项目 "${project.name}"`;
      this.toast.error('导入失败', message);
      throw new Error(result.error ?? message);
    }

    const completedAction = existingProject ? '已更新' : '已导入';
    this.toast.success('导入成功', `项目 "${project.name}" ${completedAction}`);
  }

  /** 登出时清除所有项目 UI 状态 */
  clearState(): void {
    this.retireRenameSession();
    this.retireDeleteSession();
    this.expandedProjectId.set(null);
    this.isEditingDescription.set(false);
    this.projectDrafts.set({});
  }
}
