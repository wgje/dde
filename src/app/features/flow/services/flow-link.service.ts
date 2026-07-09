import { Injectable, Injector, inject, signal, NgZone, DestroyRef, effect } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { FlowLinkRelinkService } from './flow-link-relink.service';
import {
  handleLinkGesture as handleLinkGestureWithDependencies,
  LinkGestureResult,
} from './flow-link-gesture.helpers';
import {
  resolveCrossTreeDeleteRequests,
  resolveFlowLinkDeleteRequest,
  type FlowLinkDeleteRequest,
} from './flow-link-delete.helpers';
import { FlowLinkTransientUiController } from './flow-link-transient-ui.controller';
import { FlowLinkEditorDragController } from './flow-link-editor-drag.controller';
import { FlowLinkConnectionEditorController } from './flow-link-connection-editor.controller';
import { Task } from '../../../../models';
import { 
  LinkTypeDialogData, 
  ConnectionEditorData,
  ConnectionEditorMode,
  LinkDeleteHint,
  LinkActionMenu,
  PanelPosition,
} from '../../../../models/flow-view-state';

interface OpenConnectionEditorOptions {
  isCrossTree: boolean;
  mode: ConnectionEditorMode;
}

/**
 * FlowLinkService - 连接线管理服务
 * 
 * 职责：
 * - 连接模式状态管理
 * - 连接类型选择对话框
 * - 连接线CRUD操作
 * - 联系块编辑器管理
 * 
 * 设计原则：
 * - 封装所有连接相关逻辑
 * - 管理连接相关的UI状态
 * - 与 store 交互进行数据操作
 */
@Injectable({
  providedIn: 'root'
})
export class FlowLinkService {
  private readonly injector = inject(Injector);
  private readonly projectState = inject(ProjectStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLink');
  private readonly toast = inject(ToastService);
  private readonly uiState = inject(UiStateService);
  private readonly userSession = inject(UserSessionService);
  private readonly relinkService = inject(FlowLinkRelinkService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private get taskOps(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }
  
  // ========== 连接模式状态 ==========
  
  /** 是否处于连接模式 */
  readonly isLinkMode = signal(false);
  
  /** 连接模式下选中的源任务 */
  readonly linkSourceTask = signal<Task | null>(null);

  private readonly hintOnlyUiEffect = effect(() => {
    if (!this.isHintOnlyStartupReadOnly()) {
      return;
    }

    if (this.isLinkMode()) {
      this.cancelLinkMode();
    }

    if (this.linkTypeDialog()) {
      this.linkTypeDialog.set(null);
    }

    if (this.linkDeleteHint()) {
      this.cancelLinkDelete();
    }

    if (this.linkActionMenu()) {
      this.cancelActionMenu();
    }

    const currentEditor = this.connectionEditorData();
    if (currentEditor?.mode === 'edit') {
      this.connectionEditorData.set({
        ...currentEditor,
        mode: 'preview',
      });
    }
  });
  
  constructor() {
    // 注册自动清理
    this.destroyRef.onDestroy(() => this.dispose());
  }
  
  // ========== 连接类型对话框状态 ==========
  
  /** 连接类型选择对话框数据 */
  readonly linkTypeDialog = signal<LinkTypeDialogData | null>(null);
  
  // ========== 联系块编辑器状态 ==========
  
  /** 联系块编辑器数据 */
  readonly connectionEditorData = signal<ConnectionEditorData | null>(null);
  
  /** 联系块编辑器位置 */
  readonly connectionEditorPos = signal<PanelPosition>({ x: 0, y: 0 });
  
  // ========== 移动端连接线删除提示 ==========
  
  /** 连接线删除提示数据 */
  readonly linkDeleteHint = signal<LinkDeleteHint | null>(null);
  
  // ========== 移动端连接线操作菜单 ==========
  
  /** 移动端连接线操作菜单数据 */
  readonly linkActionMenu = signal<LinkActionMenu | null>(null);
  private isDeletingFromActionMenu = false;

  private readonly transientUi = new FlowLinkTransientUiController({
    isDestroyed: () => this.isDestroyed,
    linkDeleteHint: this.linkDeleteHint,
    linkActionMenu: this.linkActionMenu,
  });
  private readonly connectionEditorDrag = new FlowLinkEditorDragController({
    connectionEditorPos: this.connectionEditorPos,
    zone: this.zone,
  });
  private readonly connectionEditor = new FlowLinkConnectionEditorController({
    connectionEditorData: this.connectionEditorData,
    connectionEditorPos: this.connectionEditorPos,
    drag: this.connectionEditorDrag,
    isMobile: () => this.uiState.isMobile(),
    guardMutation: actionLabel => this.guardHintOnlyLinkMutation(actionLabel),
    getTask: taskId => this.projectState.getTask(taskId),
    updateConnectionContent: (sourceId, targetId, title, description) =>
      this.taskOps.connectionAdapter.updateConnectionContent(sourceId, targetId, title, description),
    removeConnection: (sourceId, targetId) =>
      this.taskOps.connectionAdapter.removeConnection(sourceId, targetId),
    detachTask: taskId => this.taskOps.detachTask(taskId),
    logger: this.logger,
    isDestroyed: () => this.isDestroyed,
  });
  
  // ========== 销毁标志 ==========
  private isDestroyed = false;
  
  // ========== 连接模式方法 ==========

  private guardHintOnlyLinkMutation(actionLabel: string): boolean {
    if (!this.taskOps.isHintOnlyStartupReadOnly()) {
      return false;
    }

    this.toast.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }
  
  /**
   * 切换连接模式
   */
  toggleLinkMode(): void {
    if (!this.isLinkMode() && this.guardHintOnlyLinkMutation('创建连接')) {
      return;
    }

    this.isLinkMode.update(v => !v);
    this.linkSourceTask.set(null);
  }
  
  /**
   * 取消连接模式
   */
  cancelLinkMode(): void {
    this.isLinkMode.set(false);
    this.linkSourceTask.set(null);
  }
  
  /**
   * 处理连接模式下的节点点击
   * @param taskId 被点击的任务ID
   * @returns 是否已创建连接
   */
  async handleLinkModeClick(taskId: string): Promise<boolean> {
    const task = this.projectState.getTask(taskId);
    if (!task) return false;

    if (this.guardHintOnlyLinkMutation('创建连接')) {
      this.linkSourceTask.set(null);
      this.isLinkMode.set(false);
      return false;
    }

    const source = this.linkSourceTask();
    if (!source) {
      // 选择源节点
      this.linkSourceTask.set(task);
      return false;
    } else if (source.id === taskId) {
      // 点击的是同一个任务，显示提示并取消选择
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkSourceTask.set(null);
      return false;
    } else {
      // 选择目标节点，创建连接
      if (this.guardHintOnlyLinkMutation('创建关联')) {
        this.linkSourceTask.set(null);
        this.isLinkMode.set(false);
        return false;
      }

      // 场景二：若目标是“待分配块”，先将其任务化（赋予阶段/序号），再创建连接
      if (task.stage === null) {
        const inferredStage = source.stage ?? 1;
        const result = await this.taskOps.moveTaskToStage(taskId, inferredStage, undefined, null);
        if (!result.ok) {
          this.toast.error('创建关联失败', result.error?.message || '未知错误');
          this.linkSourceTask.set(null);
          this.isLinkMode.set(false);
          return false;
        }
      }
      const saved = await this.taskOps.connectionAdapter.addCrossTreeConnection(source.id, taskId);
      if (!saved) {
        this.toast.error('创建关联失败', '关联变更未能写入本地队列');
        return false;
      }
      this.linkSourceTask.set(null);
      this.isLinkMode.set(false);
      return true;
    }
    
    return false;
  }
  
  // ========== 连接类型对话框方法 ==========
  
  /**
   * 显示连接类型选择对话框
   */
  showLinkTypeDialog(
    sourceId: string,
    targetId: string,
    x: number,
    y: number
  ): void {
    if (this.guardHintOnlyLinkMutation('创建连接')) {
      return;
    }

    // 防止自连接
    if (sourceId === targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return;
    }
    
    const sourceTask = this.projectState.getTask(sourceId) || null;
    const targetTask = this.projectState.getTask(targetId) || null;
    
    this.linkTypeDialog.set({
      show: true,
      sourceId,
      targetId,
      sourceTask,
      targetTask,
      x,
      y
    });
  }
  
  /**
   * 确认创建父子关系连接
   */
  async confirmParentChildLink(): Promise<boolean> {
    const dialog = this.linkTypeDialog();
    if (!dialog) return false;

    if (this.guardHintOnlyLinkMutation('创建连接')) {
      return false;
    }
    
    // 最后一道防线：再次检查自连接
    if (dialog.sourceId === dialog.targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkTypeDialog.set(null);
      return false;
    }
    
    // 🔴 严格规则：禁止待分配块成为已分配任务的父节点
    if (dialog.sourceTask && dialog.sourceTask.stage === null && 
        dialog.targetTask && dialog.targetTask.stage !== null) {
      this.toast.warning('无法连接', '待分配块无法成为任务块的父节点');
      this.linkTypeDialog.set(null);
      return false;
    }
    
    const parentTask = dialog.sourceTask;
    const parentStage = parentTask?.stage ?? null;

    // 待分配 → 待分配：仅调整层级，不进入阶段分配
    if (parentStage === null && dialog.targetTask?.stage === null) {
      const result = await this.taskOps.moveTaskToStage(dialog.targetId, null, undefined, dialog.sourceId);
      if (!result.ok) {
        this.toast.error('连接失败', result.error?.message || '未知错误');
        this.linkTypeDialog.set(null);
        return false;
      }
      this.linkTypeDialog.set(null);
      return true;
    }

    const nextStage = parentStage !== null ? parentStage + 1 : 1;

    const result = await this.taskOps.moveTaskToStage(dialog.targetId, nextStage, undefined, dialog.sourceId);
    if (!result.ok) {
      this.toast.error('连接失败', result.error?.message || '未知错误');
      this.linkTypeDialog.set(null);
      return false;
    }
    this.linkTypeDialog.set(null);
    return true;
  }
  
  /**
   * 确认创建关联连接（跨树）
   */
  async confirmCrossTreeLink(): Promise<boolean> {
    const dialog = this.linkTypeDialog();
    if (!dialog) return false;
    if (this.guardHintOnlyLinkMutation('创建关联')) {
      return false;
    }
    // 最后一道防线：再次检查自连接
    if (dialog.sourceId === dialog.targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkTypeDialog.set(null);
      return false;
    }
    // 场景二：若目标是“待分配块”，在创建关联连接前先任务化（否则不会从待分配区消失）
    if (dialog.targetTask?.stage === null) {
      const inferredStage = dialog.sourceTask?.stage ?? 1;
      const result = await this.taskOps.moveTaskToStage(dialog.targetId, inferredStage, undefined, null);
      if (!result.ok) {
        this.toast.error('创建关联失败', result.error?.message || '未知错误');
        this.linkTypeDialog.set(null);
        return false;
      }
    }

    const saved = await this.taskOps.connectionAdapter.addCrossTreeConnection(dialog.sourceId, dialog.targetId);
    if (!saved) {
      this.toast.error('创建关联失败', '关联变更未能写入本地队列');
      return false;
    }

    this.linkTypeDialog.set(null);
    return true;
  }
  
  /**
   * 取消连接创建
   */
  cancelLinkCreate(): void {
    this.linkTypeDialog.set(null);
  }
  
  // ========== 连接手势处理 ==========
  
  /**
   * 处理连接手势（绘制/重连连接线）
   * @param sourceId 源节点ID
   * @param targetId 目标节点ID
   * @param x 对话框X位置
   * @param y 对话框Y位置
   * @returns 需要执行的动作
   */
  async handleLinkGesture(
    sourceId: string,
    targetId: string,
    x: number,
    y: number
  ): Promise<LinkGestureResult> {
    const childTask = this.projectState.getTask(targetId);
    const sourceTask = this.projectState.getTask(sourceId);

    return handleLinkGestureWithDependencies({
      sourceId,
      targetId,
      x,
      y,
      sourceTask,
      childTask,
      logGesture: (source, child) => this.logLinkGesture(sourceId, targetId, source, child),
      warnCannotSelfConnect: () => this.toast.warning('无法连接', '节点不能连接到自身'),
      warnInvalidUnassignedParent: () => {
        this.toast.warning('无法连接', '待分配块无法成为任务块的父节点');
      },
      guardMutation: action => this.guardHintOnlyLinkMutation(action),
      handleTaskToUnassignedLink: child => {
        this.logger.info('进入场景1：任务块 → 待分配块（添加模式，保留原有子任务）');
        return this.relinkService.handleTaskToUnassignedLink(sourceId, targetId, child, false);
      },
      moveTaskToStage: (taskId, stage, parentId) =>
        this.taskOps.moveTaskToStage(taskId, stage, undefined, parentId),
      toastError: (title, message) => this.toast.error(title, message),
      toastSuccess: (title, message) => this.toast.success(title, message),
      addCrossTreeConnection: () => this.taskOps.connectionAdapter.addCrossTreeConnection(sourceId, targetId),
      showLinkTypeDialog: () => this.showLinkTypeDialog(sourceId, targetId, x, y),
    });
  }

  isHintOnlyStartupReadOnly(): boolean {
    return this.userSession.isHintOnlyStartupPlaceholderVisible?.() ?? false;
  }

  // ========== 联系块编辑器方法 ==========
  
  /**
   * 打开联系块编辑器
   * 移动端：优先显示在点击位置上方，空间不足时回退到下方
   * 桌面端：在点击位置附近显示
   */
  openConnectionEditor(
    sourceId: string,
    targetId: string,
    description: string,
    x: number,
    y: number,
    title: string = '',
    options: OpenConnectionEditorOptions = {
      isCrossTree: true,
      mode: 'preview',
    }
  ): void {
    this.connectionEditor.open(
      sourceId,
      targetId,
      description,
      x,
      y,
      title,
      options
    );
  }

  private logLinkGesture(
    sourceId: string,
    targetId: string,
    sourceTask: Task | undefined,
    childTask: Task | undefined
  ): void {
    this.logger.info('handleLinkGesture 调用', {
      sourceId,
      targetId,
      sourceStage: sourceTask?.stage,
      targetStage: childTask?.stage,
      sourceHasChildren: this.taskOps.getDirectChildren(sourceId).length > 0,
      targetHasParent: !!childTask?.parentId
    });
  }

  /**
   * 关闭联系块编辑器
   */
  closeConnectionEditor(): void {
    this.connectionEditor.close();
  }

  setConnectionEditorMode(mode: ConnectionEditorMode): void {
    this.connectionEditor.setMode(mode);
  }

  shouldIgnoreConnectionEditorBackgroundClose(): boolean {
    return this.connectionEditor.shouldIgnoreBackgroundClose();
  }
  
  /**
   * 保存联系块内容（标题和描述）
   * @param title 标题（外显内容）
   * @param description 描述（悬停显示）
   */
  saveConnectionContent(sourceId: string, targetId: string, title: string, description: string): Promise<boolean> {
    return this.connectionEditor.saveContent(sourceId, targetId, title, description);
  }
  
  /**
   * 删除当前编辑的连接
   * @returns 是否成功删除
   */
  deleteCurrentConnection(): Promise<boolean> {
    return this.connectionEditor.deleteCurrent();
  }
  
  /**
   * 获取连接的源任务和目标任务
   */
  getConnectionTasks(): { source: Task | null; target: Task | null } {
    return this.connectionEditor.getTasks();
  }
  
  /**
   * 开始拖动联系块编辑器
   */
  startDragConnEditor(event: MouseEvent | TouchEvent): void {
    this.connectionEditor.startDrag(event);
  }
  
  /**
   * 更新流程图容器边界
   * 关联块编辑器只能在流程图区域内拖动
   */
  updateDiagramBounds(): void {
    this.connectionEditor.updateDiagramBounds();
  }
  
  // ========== 连接线删除方法 ==========
  
  /**
   * 显示连接线删除提示（移动端）
   * @param linkData GoJS 连接线数据对象（包含 from, to, isCrossTree 等属性）
   * @param x 显示位置 X
   * @param y 显示位置 Y
   */
  showLinkDeleteHint(linkData: go.ObjectData, x: number, y: number): void {
    this.transientUi.showDeleteHint(linkData, x, y);
  }
  
  /**
   * 确认删除连接线
   * @returns 删除的连接线数据，如果没有则返回 null
   */
  async confirmLinkDelete(): Promise<{ fromKey: string; toKey: string; isCrossTree: boolean } | null> {
    const hint = this.linkDeleteHint();
    this.logger.info('confirmLinkDelete 被调用', { hint });
    
    if (!hint?.link) {
      this.logger.warn('confirmLinkDelete: 没有删除提示数据');
      return null;
    }
    
    const result = await this.deleteLinkInternal(hint.link);
    this.logger.info('删除连接线完成', result);
    if (result) {
      this.transientUi.cancelDeleteHint();
    }
    return result;
  }
  
  /**
   * 取消删除提示
   */
  cancelLinkDelete(): void {
    this.transientUi.cancelDeleteHint();
  }
  
  // ========== 移动端操作菜单方法 ==========
  
  /**
   * 显示连接线操作菜单（移动端）
   * 长按连接线时调用，提供编辑和删除两个选项
   * @param linkData GoJS 连接线数据对象
   * @param x 显示位置 X
   * @param y 显示位置 Y
   */
  showLinkActionMenu(linkData: go.ObjectData, x: number, y: number): void {
    this.logger.debug('showLinkActionMenu', { linkData, x, y });

    if (this.guardHintOnlyLinkMutation('管理连接')) {
      return;
    }
    
    this.transientUi.showActionMenu(linkData, x, y);
  }
  
  /**
   * 从操作菜单打开编辑器
   */
  openEditorFromActionMenu(): void {
    const menu = this.linkActionMenu();
    if (!menu?.link?.data) {
      this.logger.warn('openEditorFromActionMenu: 没有操作菜单数据');
      return;
    }

    if (this.guardHintOnlyLinkMutation('编辑关联')) {
      return;
    }
    
    const linkData = menu.link.data;
    const fromId = linkData.from as string;
    const toId = linkData.to as string;
    const title = (linkData.title as string) || '';
    const description = (linkData.description as string) || '';
    
    this.transientUi.cancelActionMenu();
    this.openConnectionEditor(fromId, toId, description, menu.x, menu.y, title, {
      isCrossTree: true,
      mode: 'edit',
    });
  }
  
  /**
   * 从操作菜单查看父子关系（打开编辑器的只读模式）
   */
  viewFromActionMenu(): void {
    const menu = this.linkActionMenu();
    if (!menu?.link?.data) {
      this.logger.warn('viewFromActionMenu: 没有操作菜单数据');
      return;
    }
    
    const linkData = menu.link.data;
    const fromId = linkData.from as string;
    const toId = linkData.to as string;
    
    this.transientUi.cancelActionMenu();
    this.openConnectionEditor(fromId, toId, '', menu.x, menu.y, '', {
      isCrossTree: false,
      mode: 'preview',
    });
  }
  
  /**
   * 从操作菜单删除连接
   */
  async deleteFromActionMenu(): Promise<{ fromKey: string; toKey: string; isCrossTree: boolean } | null> {
    if (this.isDeletingFromActionMenu) {
      this.logger.debug('deleteFromActionMenu: 删除正在进行，忽略重复触发');
      return null;
    }

    const menu = this.linkActionMenu();
    this.logger.info('deleteFromActionMenu 被调用', { menu });
    
    if (!menu?.link) {
      this.logger.warn('deleteFromActionMenu: 没有操作菜单数据');
      return null;
    }
    
    this.isDeletingFromActionMenu = true;
    try {
      const result = await this.deleteLinkInternal(menu.link);
      this.logger.info('从操作菜单删除连接完成', result);
      if (result) {
        this.transientUi.cancelActionMenu();
      }
      return result;
    } finally {
      this.isDeletingFromActionMenu = false;
    }
  }
  
  /**
   * 取消操作菜单
   */
  cancelActionMenu(): void {
    this.transientUi.cancelActionMenu();
  }
  
  /**
   * 从右键菜单删除连接
   */
  async deleteLink(linkData: go.ObjectData): Promise<{ fromKey: string; toKey: string; isCrossTree: boolean } | null> {
    const request = resolveFlowLinkDeleteRequest(linkData);
    if (!request) return null;

    if (this.guardHintOnlyLinkMutation('删除关联')) {
      return null;
    }

    return this.applyLinkDeleteRequest(request);
  }
  
  // ========== 快捷键处理 ==========
  
  /**
   * 处理 Alt+X 快捷键删除选中的跨树连接
   * @param selectedLinks 选中的连接线数据列表
   */
  async handleDeleteCrossTreeLinks(selectedLinks: go.ObjectData[]): Promise<void> {
    if (this.guardHintOnlyLinkMutation('删除关联')) {
      return;
    }

    for (const request of resolveCrossTreeDeleteRequests(selectedLinks)) {
      await this.taskOps.connectionAdapter.removeConnection(request.fromKey, request.toKey);
    }
  }
  
  // ========== 清理方法 ==========
  
  /**
   * 清理资源
   */
  dispose(): void {
    this.isDestroyed = true;
    this.resetTransientUiState();
  }
  
  /**
   * 重置状态（重新激活）
   */
  activate(): void {
    this.isDestroyed = false;
  }
  
  // ========== 私有方法 ==========

  private resetTransientUiState(): void {
    this.cancelLinkMode();
    this.linkTypeDialog.set(null);
    this.connectionEditor.dispose();
    this.transientUi.clearAll();
  }
  
  /**
   * 内部删除连接线方法
   */
  private async deleteLinkInternal(link: { data: go.ObjectData }): Promise<{ fromKey: string; toKey: string; isCrossTree: boolean } | null> {
    const request = resolveFlowLinkDeleteRequest(link.data);
    this.logger.info('deleteLinkInternal', { request, link });

    if (!request) {
      this.logger.warn('deleteLinkInternal: 缺少 fromKey 或 toKey');
      return null;
    }

    if (this.guardHintOnlyLinkMutation('删除关联')) {
      return null;
    }
    
    return this.applyLinkDeleteRequest(request);
  }

  private async applyLinkDeleteRequest(request: FlowLinkDeleteRequest): Promise<FlowLinkDeleteRequest | null> {
    if (request.isCrossTree) {
      this.logger.info('删除跨树连接', { fromKey: request.fromKey, toKey: request.toKey });
      const saved = await this.taskOps.connectionAdapter.removeConnection(request.fromKey, request.toKey);
      return saved ? request : null;
    }

    this.logger.info('解除父子关系', { toKey: request.toKey });
    const saved = await this.taskOps.detachTask(request.toKey);
    return saved ? request : null;
  }
}
