import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ProjectStateService } from '../../../services/project-state.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { UiStateService } from '../../../services/ui-state.service';
import { ModalService } from '../../../services/modal.service';
import { ModalLoaderService } from './modal-loader.service';
import { ToastService } from '../../../services/toast.service';
import { Project } from '../../../models';

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
  private readonly router = inject(Router);

  // ========== UI 状态 Signals ==========
  readonly expandedProjectId = signal<string | null>(null);
  readonly isEditingDescription = signal(false);
  readonly projectDrafts = signal<Record<string, { description: string; createdDate: string }>>({});
  readonly renamingProjectId = signal<string | null>(null);
  readonly renameProjectName = signal('');
  readonly isDeleting = signal(false);
  private originalProjectName = '';

  // ========== 项目选择 ==========

  selectProject(id: string, _sidebarOpen: { set: (v: boolean) => void }): void {
    if (this.expandedProjectId() === id) {
      if (this.isEditingDescription()) {
        this.saveProjectDetails(id);
      }
      this.expandedProjectId.set(null);
      this.isEditingDescription.set(false);
      return;
    }
    if (this.expandedProjectId() && this.isEditingDescription()) {
      this.saveProjectDetails(this.expandedProjectId()!);
    }
    this.projectState.setActiveProjectId(id);
    this.expandedProjectId.set(id);
    this.ensureProjectDraft(id);
    this.isEditingDescription.set(false);
    const currentView = this.uiState.activeView() || 'text';
    if (this.uiState.isMobile() && currentView === 'flow') {
      void this.router.navigate(['/projects', id, currentView]);
    }
  }

  onProjectCardClick(event: MouseEvent, projectId: string): void {
    event.stopPropagation();
    if (this.isEditingDescription()) {
      this.saveProjectDetails(projectId);
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
        this.saveProjectDetails(expandedId);
      }
      this.expandedProjectId.set(null);
      this.isEditingDescription.set(false);
    }
  }

  enterProject(id: string, sidebarOpen: { set: (v: boolean) => void }): void {
    this.projectState.setActiveProjectId(id);
    this.expandedProjectId.set(id);
    this.ensureProjectDraft(id);
    const currentView = this.uiState.activeView() || 'text';
    void this.router.navigate(['/projects', id, currentView]);
    if (this.uiState.isMobile()) {
      sidebarOpen.set(false);
    }
  }

  handleProjectDoubleClick(id: string, event: MouseEvent, sidebarOpen: { set: (v: boolean) => void }): void {
    event.preventDefault();
    event.stopPropagation();
    this.isEditingDescription.set(true);
    this.enterProject(id, sidebarOpen);
  }

  // ========== 重命名 ==========

  startRenameProject(projectId: string, currentName: string, event: Event): void {
    event.stopPropagation();
    this.renamingProjectId.set(projectId);
    this.renameProjectName.set(currentName);
    this.originalProjectName = currentName;
  }

  executeRenameProject(): void {
    const projectId = this.renamingProjectId();
    const newName = this.renameProjectName().trim();
    if (projectId && newName && newName !== this.originalProjectName) {
      this.projectState.renameProject(projectId, newName);
      this.toast.success('项目重命名成功');
    }
    this.cancelRenameProject();
  }

  cancelRenameProject(): void {
    this.renamingProjectId.set(null);
    this.renameProjectName.set('');
  }

  onRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.executeRenameProject();
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

  saveProjectDetails(projectId: string): void {
    const draft = this.projectDraft(projectId);
    if (!draft) return;
    this.projectOps.updateProjectMetadata(projectId, { description: draft.description });
    this.isEditingDescription.set(false);
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

  async confirmDeleteProject(projectId: string, projectName: string, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.isDeleting()) return;
    const modalRef = await this.modalLoader.openDeleteConfirmModal({
      title: '删除项目',
      message: '确定要删除项目吗？',
      itemName: projectName,
      warning: '此操作将删除项目及其所有任务，且无法撤销！'
    });
    const result = await modalRef.result as { confirmed: boolean } | undefined;
    if (result?.confirmed) {
      this.isDeleting.set(true);
      try {
        const deleteResult = await this.projectOps.deleteProject(projectId);
        if (deleteResult.success) {
          this.expandedProjectId.set(null);
          this.toast.success('项目已删除', `「${projectName}」已永久删除`);
        }
      } finally {
        this.isDeleting.set(false);
      }
    }
  }

  async handleImportComplete(project: Project): Promise<void> {
    const existingProject = this.projectState.getProject(project.id);
    if (existingProject) {
      this.projectState.updateProjects(projects =>
        projects.map(p => p.id === project.id ? project : p)
      );
      this.toast.success('导入成功', `项目 "${project.name}" 已更新`);
    } else {
      const result = await this.projectOps.addProject(project);
      if (result.success) {
        this.toast.success('导入成功', `项目 "${project.name}" 已导入`);
      } else {
        this.toast.error('导入失败', `无法导入项目 "${project.name}"`);
      }
    }
  }

  /** 登出时清除所有项目 UI 状态 */
  clearState(): void {
    this.expandedProjectId.set(null);
    this.isEditingDescription.set(false);
    this.projectDrafts.set({});
  }
}
