import { Injectable, inject, signal, NgZone, DestroyRef } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowLinkRelinkService } from './flow-link-relink.service';
import { Task } from '../../../../models';
import { 
  LinkTypeDialogData, 
  ConnectionEditorData,
  ConnectionEditorMode,
  LinkDeleteHint,
  LinkActionMenu,
  PanelPosition,
  DragState,
  createInitialDragState
} from '../../../../models/flow-view-state';
import { UI_CONFIG } from '../../../../config';

/**
 * 连接类型
 */
export type LinkType = 'parent-child' | 'cross-tree';

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
  private static readonly CONNECTION_EDITOR_WIDTH = 208;
  private static readonly CONNECTION_EDITOR_HEIGHT = 180;

  private readonly projectState = inject(ProjectStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLink');
  private readonly toast = inject(ToastService);
  private readonly uiState = inject(UiStateService);
  private readonly relinkService = inject(FlowLinkRelinkService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  
  // ========== 连接模式状态 ==========
  
  /** 是否处于连接模式 */
  readonly isLinkMode = signal(false);
  
  /** 连接模式下选中的源任务 */
  readonly linkSourceTask = signal<Task | null>(null);
  
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
  
  /** 拖动状态 */
  private connEditorDragState: DragState = createInitialDragState();
  /** 忽略背景关闭的保护窗口，避免同一次点击把刚打开/刚切回预览的关联块立刻关掉 */
  private connectionEditorIgnoreCloseUntil = 0;
  
  /** 流程图容器边界（用于限制关联块编辑器拖动范围） */
  private diagramBounds: { left: number; top: number; right: number; bottom: number } | null = null;
  
  // ========== 移动端连接线删除提示 ==========
  
  /** 连接线删除提示数据 */
  readonly linkDeleteHint = signal<LinkDeleteHint | null>(null);
  
  /** 删除提示定时器 */
  private linkDeleteHintTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 移动端连接线操作菜单 ==========
  
  /** 移动端连接线操作菜单数据 */
  readonly linkActionMenu = signal<LinkActionMenu | null>(null);
  
  /** 操作菜单定时器 */
  private linkActionMenuTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 销毁标志 ==========
  private isDestroyed = false;
  
  // ========== 连接模式方法 ==========
  
  /**
   * 切换连接模式
   */
  toggleLinkMode(): void {
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
  handleLinkModeClick(taskId: string): boolean {
    const task = this.projectState.getTask(taskId);
    if (!task) return false;

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
      // 场景二：若目标是“待分配块”，先将其任务化（赋予阶段/序号），再创建连接
      if (task.stage === null) {
        const inferredStage = source.stage ?? 1;
        this.taskOps.moveTaskToStage(taskId, inferredStage, undefined, null);
      }
      this.taskOps.connectionAdapter.addCrossTreeConnection(source.id, taskId);
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
  confirmParentChildLink(): void {
    const dialog = this.linkTypeDialog();
    if (!dialog) return;
    
    // 最后一道防线：再次检查自连接
    if (dialog.sourceId === dialog.targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkTypeDialog.set(null);
      return;
    }
    
    // 🔴 严格规则：禁止待分配块成为已分配任务的父节点
    if (dialog.sourceTask && dialog.sourceTask.stage === null && 
        dialog.targetTask && dialog.targetTask.stage !== null) {
      this.toast.warning('无法连接', '待分配块无法成为任务块的父节点');
      this.linkTypeDialog.set(null);
      return;
    }
    
    const parentTask = dialog.sourceTask;
    const parentStage = parentTask?.stage ?? null;

    // 待分配 → 待分配：仅调整层级，不进入阶段分配
    if (parentStage === null && dialog.targetTask?.stage === null) {
      const result = this.taskOps.moveTaskToStage(dialog.targetId, null, undefined, dialog.sourceId);
      if (!result.ok) {
        this.toast.error('连接失败', result.error?.message || '未知错误');
      }
      this.linkTypeDialog.set(null);
      return;
    }

    const nextStage = parentStage !== null ? parentStage + 1 : 1;

    this.taskOps.moveTaskToStage(dialog.targetId, nextStage, undefined, dialog.sourceId);
    this.linkTypeDialog.set(null);
  }
  
  /**
   * 确认创建关联连接（跨树）
   */
  confirmCrossTreeLink(): void {
    const dialog = this.linkTypeDialog();
    if (!dialog) return;
    // 最后一道防线：再次检查自连接
    if (dialog.sourceId === dialog.targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      this.linkTypeDialog.set(null);
      return;
    }
    // 场景二：若目标是“待分配块”，在创建关联连接前先任务化（否则不会从待分配区消失）
    if (dialog.targetTask?.stage === null) {
      const inferredStage = dialog.sourceTask?.stage ?? 1;
      this.taskOps.moveTaskToStage(dialog.targetId, inferredStage, undefined, null);
    }

    this.taskOps.connectionAdapter.addCrossTreeConnection(dialog.sourceId, dialog.targetId);
    this.linkTypeDialog.set(null);
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
  handleLinkGesture(
    sourceId: string,
    targetId: string,
    x: number,
    y: number
  ): 'show-dialog' | 'create-cross-tree' | 'create-parent-child' | 'replace-subtree' | 'none' {
    // 防止自连接
    if (sourceId === targetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'none';
    }
    
    const childTask = this.projectState.getTask(targetId);
    const sourceTask = this.projectState.getTask(sourceId);
    
    this.logger.info('handleLinkGesture 调用', {
      sourceId,
      targetId,
      sourceStage: sourceTask?.stage,
      targetStage: childTask?.stage,
      sourceHasChildren: this.taskOps.getDirectChildren(sourceId).length > 0,
      targetHasParent: !!childTask?.parentId
    });
    
    // 🔴 严格规则：禁止待分配块成为已分配任务的父节点
    // 待分配块 (stage === null) 可以成为其他待分配块的父节点
    // 但不能成为已分配任务 (stage !== null) 的父节点
    if (sourceTask && sourceTask.stage === null && childTask && childTask.stage !== null) {
      this.toast.warning('无法连接', '待分配块无法成为任务块的父节点');
      return 'none';
    }

    // ========== 场景1：任务块 → 待分配块（从普通端口拖出新线条） ==========
    // 当任务块连接到待分配块时，将待分配块及其子树分配给任务块
    // 使用添加模式（replaceMode = false）：保留源任务原有的子任务
    if (sourceTask && sourceTask.stage !== null && childTask && childTask.stage === null) {
      this.logger.info('进入场景1：任务块 → 待分配块（添加模式，保留原有子任务）');
      return this.relinkService.handleTaskToUnassignedLink(sourceId, targetId, childTask, false);
    }
    
    if (childTask?.parentId) {
      // 待分配 → 待分配：允许在浮动树中重新挂载
      if (childTask.stage === null && sourceTask?.stage === null) {
        const result = this.taskOps.moveTaskToStage(childTask.id, null, undefined, sourceTask.id);
        if (!result.ok) {
          this.toast.error('连接失败', result.error?.message || '未知错误');
          return 'none';
        }
        this.toast.success('已建立待分配层级', '待分配块已挂载到新的父节点');
        return 'create-parent-child';
      }

      // 🔴 浮动任务树特殊处理：待分配子任务可以被“认领”
      // 如果目标是待分配区的子任务，允许将其分配到已分配区成为新父任务的子任务
      if (sourceTask && childTask.stage === null && sourceTask.stage !== null && sourceTask.stage !== undefined) {
        const targetStage = sourceTask.stage + 1;
        // 将待分配子任务及其子树分配到新父任务下
        const result = this.taskOps.moveTaskToStage(targetId, targetStage, undefined, sourceId);
        if (result.ok) {
          this.toast.success('已分配任务', `"${childTask.title}" 已成为新任务的子任务`);
          return 'create-parent-child';
        } else {
          this.toast.error('分配失败', result.error?.message || '未知错误');
          return 'none';
        }
      }
      
      // 目标已有父节点且已分配，只能创建跨树连接
      this.taskOps.connectionAdapter.addCrossTreeConnection(sourceId, targetId);
      this.toast.success('已创建关联', '目标任务已有父级，已创建关联连接');
      return 'create-cross-tree';
    }
    
    // 目标没有父节点，显示选择对话框
    this.showLinkTypeDialog(sourceId, targetId, x, y);
    return 'show-dialog';
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
    this.logger.debug('openConnectionEditor 被调用', {
      sourceId,
      targetId,
      title,
      description,
      x,
      y,
      isMobile: this.uiState.isMobile(),
      options
    });

    const currentEditor = this.connectionEditorData();
    const isSameConnection =
      currentEditor &&
      currentEditor.sourceId === sourceId &&
      currentEditor.targetId === targetId &&
      currentEditor.isCrossTree === options.isCrossTree;

    if (isSameConnection) {
      if (
        this.uiState.isMobile() &&
        currentEditor.isCrossTree &&
        currentEditor.mode === 'preview' &&
        options.mode === 'preview'
      ) {
        this.logger.debug('移动端同一跨树关联二次点击，切换到编辑态');
        this.armConnectionEditorBackgroundCloseGuard();
        this.connectionEditorData.set({
          ...currentEditor,
          mode: 'edit',
        });
        return;
      }

      if (currentEditor.mode === 'edit' && options.mode === 'preview') {
        this.logger.debug('同一关联块已在编辑态，保持当前会话');
        return;
      }

      if (currentEditor.mode !== options.mode) {
        this.logger.debug('同一关联块切换模式', { from: currentEditor.mode, to: options.mode });
        this.armConnectionEditorBackgroundCloseGuard();
        this.connectionEditorData.set({
          ...currentEditor,
          mode: options.mode,
        });
      }
      return;
    }
    
    // 编辑器尺寸
    const editorWidth = FlowLinkService.CONNECTION_EDITOR_WIDTH;  // w-52 = 13rem = 208px
    const editorHeight = FlowLinkService.CONNECTION_EDITOR_HEIGHT; // 估算高度
    const padding = 12;
    const coordinateRoot = this.getConnectionEditorCoordinateRootBounds();
    const gap = 10;
    const anchorX = x - coordinateRoot.left;
    const anchorY = y - coordinateRoot.top;
    
    let adjustedX: number;
    let adjustedY: number;
    
    if (this.uiState.isMobile()) {
      const minX = padding;
      const maxX = coordinateRoot.width - editorWidth - padding;
      const minY = padding;
      const maxY = coordinateRoot.height - editorHeight - padding;
      const preferredAboveY = anchorY - editorHeight - gap;
      const fallbackBelowY = anchorY + gap;

      adjustedX = Math.max(minX, Math.min(maxX, anchorX - editorWidth / 2));
      adjustedY = preferredAboveY >= minY
        ? preferredAboveY
        : fallbackBelowY;
      adjustedY = Math.max(minY, Math.min(maxY, adjustedY));

      this.logger.debug('移动端：锚定定位', {
        adjustedX,
        adjustedY,
        tapX: x,
        tapY: y,
        rootLeft: coordinateRoot.left,
        rootTop: coordinateRoot.top,
        rootWidth: coordinateRoot.width,
        rootHeight: coordinateRoot.height,
      });
    } else {
      // 【桌面端】在点击位置附近显示
      // 将编辑器居中对齐到点击位置，并向上偏移使其显示在关联块正上方
      adjustedX = anchorX - editorWidth / 2;
      adjustedY = anchorY - editorHeight - gap; // 向上偏移，留 10px 间距
      
      // 获取流程图容器边界，限制编辑器在流程图区域内
      this.updateDiagramBounds();
      if (this.diagramBounds) {
        const minX = this.diagramBounds.left + padding;
        const minY = this.diagramBounds.top + padding;
        const maxX = this.diagramBounds.right - editorWidth - padding;
        const maxY = this.diagramBounds.bottom - editorHeight - padding;
        
        adjustedX = Math.max(minX, Math.min(maxX, adjustedX));
        adjustedY = Math.max(minY, Math.min(maxY, adjustedY));
      } else {
        // 兜底：保持在当前壳容器内
        adjustedX = Math.max(padding, Math.min(adjustedX, coordinateRoot.width - editorWidth - padding));
        adjustedY = Math.max(padding, Math.min(adjustedY, coordinateRoot.height - editorHeight - padding));
      }
    }
    
    const editorData = {
      sourceId,
      targetId,
      title,
      description,
      isCrossTree: options.isCrossTree,
      mode: options.mode,
      x: adjustedX,
      y: adjustedY
    };
    this.logger.debug('设置 connectionEditorData', editorData);

    this.armConnectionEditorBackgroundCloseGuard();
    this.connectionEditorData.set(editorData);
    this.connectionEditorPos.set({ x: adjustedX, y: adjustedY });
    
    // 自动调整 textarea 高度
    setTimeout(() => {
      if (this.isDestroyed) return;
      const textarea = document.querySelector('#connectionDescTextarea') as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
      }
    }, UI_CONFIG.SHORT_DELAY);
  }
  
  /**
   * 关闭联系块编辑器
   */
  closeConnectionEditor(): void {
    this.logger.debug('closeConnectionEditor 被调用');
    this.connectionEditorData.set(null);
  }

  setConnectionEditorMode(mode: ConnectionEditorMode): void {
    const data = this.connectionEditorData();
    if (!data || data.mode === mode) {
      return;
    }

    this.armConnectionEditorBackgroundCloseGuard();
    this.connectionEditorData.set({
      ...data,
      mode,
    });
  }

  shouldIgnoreConnectionEditorBackgroundClose(): boolean {
    return Date.now() < this.connectionEditorIgnoreCloseUntil;
  }
  
  /**
   * 保存联系块内容（标题和描述）
   * @param title 标题（外显内容）
   * @param description 描述（悬停显示）
   */
  saveConnectionContent(sourceId: string, targetId: string, title: string, description: string): void {
    this.taskOps.connectionAdapter.updateConnectionContent(sourceId, targetId, title, description);

    const data = this.connectionEditorData();
    if (data && data.sourceId === sourceId && data.targetId === targetId) {
      // 更新本地数据，保持编辑器状态同步
      this.connectionEditorData.set({
        ...data,
        title,
        description
      });
    }
  }
  
  /**
   * 删除当前编辑的连接
   * @returns 是否成功删除
   */
  deleteCurrentConnection(): boolean {
    const data = this.connectionEditorData();
    if (!data) {
      this.logger.warn('deleteCurrentConnection: 没有当前编辑的连接数据');
      return false;
    }
    
    if (data.isCrossTree) {
      this.logger.info('删除跨树连接', { sourceId: data.sourceId, targetId: data.targetId });
      this.taskOps.connectionAdapter.removeConnection(data.sourceId, data.targetId);
    } else {
      // 父子连接：解除父子关系
      this.logger.info('解除父子关系', { parentId: data.sourceId, childId: data.targetId });
      this.taskOps.detachTask(data.targetId);
    }
    
    // 关闭编辑器
    this.closeConnectionEditor();
    return true;
  }
  
  /**
   * 获取连接的源任务和目标任务
   */
  getConnectionTasks(): { source: Task | null; target: Task | null } {
    const data = this.connectionEditorData();
    if (!data) return { source: null, target: null };
    
    return {
      source: this.projectState.getTask(data.sourceId) || null,
      target: this.projectState.getTask(data.targetId) || null
    };
  }
  
  /**
   * 开始拖动联系块编辑器
   */
  startDragConnEditor(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    const pos = this.connectionEditorPos();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    this.connEditorDragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: pos.x,
      offsetY: pos.y
    };
    
    // 获取流程图容器边界
    this.updateDiagramBounds();
    
    document.addEventListener('mousemove', this.onDragConnEditor);
    document.addEventListener('mouseup', this.stopDragConnEditor);
    document.addEventListener('touchmove', this.onDragConnEditor);
    document.addEventListener('touchend', this.stopDragConnEditor);
  }
  
  /**
   * 更新流程图容器边界
   * 关联块编辑器只能在流程图区域内拖动
   */
  updateDiagramBounds(): void {
    const diagramDiv = document.querySelector('[data-testid="flow-diagram"]');
    if (diagramDiv) {
      const coordinateRoot = this.getConnectionEditorCoordinateRootBounds();
      const rect = diagramDiv.getBoundingClientRect();
      this.diagramBounds = {
        left: rect.left - coordinateRoot.left,
        top: rect.top - coordinateRoot.top,
        right: rect.right - coordinateRoot.left,
        bottom: rect.bottom - coordinateRoot.top
      };
    } else {
      this.diagramBounds = null;
    }
  }
  
  /**
   * 拖动中
   */
  private onDragConnEditor = (event: MouseEvent | TouchEvent): void => {
    if (!this.connEditorDragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.connEditorDragState.startX;
    const deltaY = clientY - this.connEditorDragState.startY;
    
    // 编辑器尺寸（用于边界计算）
    const editorWidth = FlowLinkService.CONNECTION_EDITOR_WIDTH;
    const editorHeight = FlowLinkService.CONNECTION_EDITOR_HEIGHT;
    const padding = 8;        // 边缘内边距
    
    let newX = this.connEditorDragState.offsetX + deltaX;
    let newY = this.connEditorDragState.offsetY + deltaY;
    
    // 如果有流程图边界，限制在流程图区域内
    if (this.diagramBounds) {
      const minX = this.diagramBounds.left + padding;
      const minY = this.diagramBounds.top + padding;
      const maxX = this.diagramBounds.right - editorWidth - padding;
      const maxY = this.diagramBounds.bottom - editorHeight - padding;
      
      newX = Math.max(minX, Math.min(maxX, newX));
      newY = Math.max(minY, Math.min(maxY, newY));
    } else {
      // 兜底：至少保持在视口内
      newX = Math.max(0, newX);
      newY = Math.max(0, newY);
    }
    
    this.zone.run(() => {
      this.connectionEditorPos.set({ x: newX, y: newY });
    });
  };
  
  /**
   * 停止拖动
   */
  private stopDragConnEditor = (): void => {
    this.connEditorDragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDragConnEditor);
    document.removeEventListener('mouseup', this.stopDragConnEditor);
    document.removeEventListener('touchmove', this.onDragConnEditor);
    document.removeEventListener('touchend', this.stopDragConnEditor);
  };
  
  // ========== 连接线删除方法 ==========
  
  /**
   * 显示连接线删除提示（移动端）
   * @param linkData GoJS 连接线数据对象（包含 from, to, isCrossTree 等属性）
   * @param x 显示位置 X
   * @param y 显示位置 Y
   */
  showLinkDeleteHint(linkData: go.ObjectData, x: number, y: number): void {
    // 注意：linkData 是连接线的数据对象，直接包含属性
    this.linkDeleteHint.set({
      link: { data: linkData }, // 包装成期望的格式
      x,
      y,
      isCrossTree: !!linkData?.isCrossTree
    });
    
    // 3秒后自动隐藏
    if (this.linkDeleteHintTimer) {
      clearTimeout(this.linkDeleteHintTimer);
    }
    
    const currentLinkData = linkData;
    this.linkDeleteHintTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      const currentHint = this.linkDeleteHint();
      if (currentHint?.link?.data === currentLinkData) {
        this.linkDeleteHint.set(null);
      }
      this.linkDeleteHintTimer = null;
    }, 3000);
  }
  
  /**
   * 确认删除连接线
   * @returns 删除的连接线数据，如果没有则返回 null
   */
  confirmLinkDelete(): { fromKey: string; toKey: string; isCrossTree: boolean } | null {
    const hint = this.linkDeleteHint();
    this.logger.info('confirmLinkDelete 被调用', { hint });
    
    if (!hint?.link) {
      this.logger.warn('confirmLinkDelete: 没有删除提示数据');
      return null;
    }
    
    const result = this.deleteLinkInternal(hint.link);
    this.logger.info('删除连接线完成', result);
    this.linkDeleteHint.set(null);
    return result;
  }
  
  /**
   * 取消删除提示
   */
  cancelLinkDelete(): void {
    this.linkDeleteHint.set(null);
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
    
    // 先关闭可能存在的删除提示
    this.linkDeleteHint.set(null);
    if (this.linkDeleteHintTimer) {
      clearTimeout(this.linkDeleteHintTimer);
      this.linkDeleteHintTimer = null;
    }
    
    this.linkActionMenu.set({
      link: { data: linkData },
      x,
      y,
      isCrossTree: !!linkData?.isCrossTree
    });
    
    // 5秒后自动隐藏（比删除提示更长，给用户更多思考时间）
    if (this.linkActionMenuTimer) {
      clearTimeout(this.linkActionMenuTimer);
    }
    
    const currentLinkData = linkData;
    this.linkActionMenuTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      const currentMenu = this.linkActionMenu();
      if (currentMenu?.link?.data === currentLinkData) {
        this.linkActionMenu.set(null);
      }
      this.linkActionMenuTimer = null;
    }, 5000);
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
    
    const linkData = menu.link.data;
    const fromId = linkData.from as string;
    const toId = linkData.to as string;
    const title = (linkData.title as string) || '';
    const description = (linkData.description as string) || '';
    
    // 关闭菜单并打开编辑器
    this.linkActionMenu.set(null);
    if (this.linkActionMenuTimer) {
      clearTimeout(this.linkActionMenuTimer);
      this.linkActionMenuTimer = null;
    }
    
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
    
    // 关闭菜单并打开编辑器（父子关系会显示只读信息）
    this.linkActionMenu.set(null);
    if (this.linkActionMenuTimer) {
      clearTimeout(this.linkActionMenuTimer);
      this.linkActionMenuTimer = null;
    }
    
    this.openConnectionEditor(fromId, toId, '', menu.x, menu.y, '', {
      isCrossTree: false,
      mode: 'preview',
    });
  }
  
  /**
   * 从操作菜单删除连接
   */
  deleteFromActionMenu(): { fromKey: string; toKey: string; isCrossTree: boolean } | null {
    const menu = this.linkActionMenu();
    this.logger.info('deleteFromActionMenu 被调用', { menu });
    
    if (!menu?.link) {
      this.logger.warn('deleteFromActionMenu: 没有操作菜单数据');
      return null;
    }
    
    const result = this.deleteLinkInternal(menu.link);
    this.logger.info('从操作菜单删除连接完成', result);
    this.linkActionMenu.set(null);
    if (this.linkActionMenuTimer) {
      clearTimeout(this.linkActionMenuTimer);
      this.linkActionMenuTimer = null;
    }
    return result;
  }
  
  /**
   * 取消操作菜单
   */
  cancelActionMenu(): void {
    this.linkActionMenu.set(null);
    if (this.linkActionMenuTimer) {
      clearTimeout(this.linkActionMenuTimer);
      this.linkActionMenuTimer = null;
    }
  }
  
  /**
   * 从右键菜单删除连接
   */
  deleteLink(linkData: go.ObjectData): { fromKey: string; toKey: string; isCrossTree: boolean } | null {
    const fromKey = linkData?.from;
    const toKey = linkData?.to;
    const isCrossTree = linkData?.isCrossTree;
    
    if (!fromKey || !toKey) return null;
    
    if (isCrossTree) {
      this.taskOps.connectionAdapter.removeConnection(fromKey, toKey);
    } else {
      this.taskOps.detachTask(toKey);
    }
    
    return { fromKey, toKey, isCrossTree };
  }
  
  // ========== 快捷键处理 ==========
  
  /**
   * 处理 Alt+X 快捷键删除选中的跨树连接
   * @param selectedLinks 选中的连接线数据列表
   */
  handleDeleteCrossTreeLinks(selectedLinks: go.ObjectData[]): void {
    selectedLinks.forEach(linkData => {
      if (linkData?.isCrossTree) {
        const fromKey = linkData.from;
        const toKey = linkData.to;
        if (fromKey && toKey) {
          this.taskOps.connectionAdapter.removeConnection(fromKey, toKey);
        }
      }
    });
  }
  
  // ========== 清理方法 ==========
  
  /**
   * 清理资源
   */
  dispose(): void {
    this.isDestroyed = true;
    
    if (this.linkDeleteHintTimer) {
      clearTimeout(this.linkDeleteHintTimer);
      this.linkDeleteHintTimer = null;
    }
    
    if (this.linkActionMenuTimer) {
      clearTimeout(this.linkActionMenuTimer);
      this.linkActionMenuTimer = null;
    }
    
    document.removeEventListener('mousemove', this.onDragConnEditor);
    document.removeEventListener('mouseup', this.stopDragConnEditor);
    document.removeEventListener('touchmove', this.onDragConnEditor);
    document.removeEventListener('touchend', this.stopDragConnEditor);
  }
  
  /**
   * 重置状态（重新激活）
   */
  activate(): void {
    this.isDestroyed = false;
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 内部删除连接线方法
   */
  private deleteLinkInternal(link: { data: go.ObjectData }): { fromKey: string; toKey: string; isCrossTree: boolean } | null {
    const fromKey = link.data?.from;
    const toKey = link.data?.to;
    const isCrossTree = link.data?.isCrossTree;
    
    this.logger.info('deleteLinkInternal', { fromKey, toKey, isCrossTree, link });
    
    if (!fromKey || !toKey) {
      this.logger.warn('deleteLinkInternal: 缺少 fromKey 或 toKey');
      return null;
    }
    
    if (isCrossTree) {
      this.logger.info('删除跨树连接', { fromKey, toKey });
      this.taskOps.connectionAdapter.removeConnection(fromKey, toKey);
    } else {
      this.logger.info('解除父子关系', { toKey });
      this.taskOps.detachTask(toKey);
    }
    
    return { fromKey, toKey, isCrossTree };
  }

  /**
   * 获取 connection editor 实际使用的坐标根容器。
   * 在桌面端，project shell 主内容带有 transform/contain，fixed 浮层必须使用该容器坐标系。
   */
  private getConnectionEditorCoordinateRootBounds(): { left: number; top: number; width: number; height: number } {
    const rootEl = document.querySelector('[data-testid="project-shell-main-content"]');
    if (rootEl) {
      const rect = rootEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      }
    }

    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    return {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1000),
      height: viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 800),
    };
  }

  private armConnectionEditorBackgroundCloseGuard(durationMs: number = 300): void {
    this.connectionEditorIgnoreCloseUntil = Date.now() + durationMs;
  }
}
