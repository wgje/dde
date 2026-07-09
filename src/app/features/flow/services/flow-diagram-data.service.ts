import { Injectable, Injector, inject } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { FlowDiagramConfigService, type FlowRelationDisplayMode, type GoJSDiagramData } from './flow-diagram-config.service';
import { FlowZoomService } from './flow-zoom.service';
import { Project, Task } from '../../../../models';
import * as go from 'gojs';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { applyDiagramData, collectCurrentDiagramMaps } from './flow-diagram-data-merge.helpers';
import { FlowDiagramExportController } from './flow-diagram-export.controller';
import { FlowDiagramSidecarExpansionController } from './flow-diagram-sidecar-expansion.controller';

interface DiagramUpdateContext {
  diagram: go.Diagram;
  model: go.GraphLinksModel;
  project: Project;
  activeTasks: Task[];
  searchQuery: string;
  lastUpdateType: string;
  taskFingerprint: string;
  taskVisualFingerprint: string;
  dockFingerprint: string;
  connSig: string;
  relationDisplaySignature: string;
  hasTaskDataChange: boolean;
  hasTaskVisualChange: boolean;
}

/**
 * FlowDiagramDataService - 图表数据同步、导出与视图状态管理
 *
 * 职责：
 * - 图表数据更新（updateDiagram）
 * - 导出 PNG/SVG
 * - 视图状态保存/恢复
 * - Flow 视图激活时的自动适配
 *
 * 从 FlowDiagramService 拆分而来，降低单文件复杂度
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramDataService {
  private readonly injector = inject(Injector);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagramData');
  private readonly toast = inject(ToastService);
  private readonly dockEngine = inject(DockEngineService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly zoomService = inject(FlowZoomService);
  private readonly sidecarExpansion = new FlowDiagramSidecarExpansionController();
  private readonly exportController = new FlowDiagramExportController({
    projectName: () => this.projectState.activeProject()?.name ?? '未命名项目',
    toast: this.toast,
    logger: this.logger,
    sentry: this.sentryLazyLoader,
    downloadBlob: (blob, filename) => this.downloadBlob(blob, filename),
  });

  private get taskOps(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  // ========== GoJS Diagram 引用 ==========
  private diagram: go.Diagram | null = null;

  // ========== 定时器 ==========
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreViewStateTimer: ReturnType<typeof setTimeout> | null = null;
  private autoFitTimer: ReturnType<typeof setTimeout> | null = null;
  private initialFitTimer: ReturnType<typeof setTimeout> | null = null;
  private flowActivationFitRafIds: number[] = [];
  private lifecycleGeneration = 0;

  // ========== 标志 ==========
  private isFirstLoad = true;
  private _familyColorLogged = false;
  private pendingAutoFitToContents = false;

  // ========== 【2026-02-25 性能优化】增量更新缓存 ==========
  /**
    * 上一次成功更新图表时的任务指纹（key: updatedAt + title + displayId + parentId + stage + status + parkingMeta）
   * 用于跳过无变化的 buildDiagramData 全量重建
   */
  private lastTaskFingerprint = '';
  private lastTaskVisualFingerprint = '';
  private lastConnectionSignatureForData = '';
  private lastSearchQuery = '';
  private lastDockFingerprint = '';
  private lastRelationDisplaySignature = '';
  private relationDisplayMode: FlowRelationDisplayMode = 'all';
  private relationFocusedTaskId: string | null = null;

  // ========== 外部设置 ==========

  /**
   * 由 FlowDiagramService 在初始化后调用，传入 diagram 实例
   */
  setDiagram(diagram: go.Diagram | null): void {
    if (this.diagram !== diagram) {
      this.lifecycleGeneration += 1;
    }
    const wasDetached = this.diagram === null;
    this.diagram = diagram;
    if (diagram && wasDetached) {
      this.isFirstLoad = true;
      this._familyColorLogged = false;
      this.pendingAutoFitToContents = false;
    }
  }

  // ========== 导出功能 ==========

  async exportToPng(): Promise<Blob | null> {
    return this.exportController.exportToPng(this.diagram);
  }

  async exportToSvg(): Promise<Blob | null> {
    return this.exportController.exportToSvg(this.diagram);
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // ========== 图表数据更新 ==========

  private detectStructuralChange(currentNodeMap: Map<string, go.ObjectData>, newTasks: Task[]): boolean {
    if (currentNodeMap.size !== newTasks.length) {
      return true;
    }

    for (const task of newTasks) {
      const existing = currentNodeMap.get(task.id);
      if (!existing) {
        return true;
      }

      if (existing.stage !== task.stage ||
          existing.status !== task.status ||
          existing.parentId !== task.parentId) {
        return true;
      }
    }

    const newTaskIds = new Set(newTasks.map(t => t.id));
    for (const key of currentNodeMap.keys()) {
      if (!newTaskIds.has(key)) {
        return true;
      }
    }

    const project = this.projectState.activeProject();
    if (project) {
      const model = this.diagram?.model as go.GraphLinksModel;
      if (model) {
        const currentLinkCount = (model.linkDataArray || []).length;
        const parentChildCount = newTasks.filter(t => t.parentId).length;
        const crossTreeCount = this.computeVisibleCrossTreeLinkCount(project, newTasks);
        const expectedLinkCount = parentChildCount + crossTreeCount;
        if (currentLinkCount !== expectedLinkCount) {
          return true;
        }
      }
    }

    return false;
  }

  private computeVisibleCrossTreeLinkCount(project: Project, tasks: Task[]): number {
    if (this.relationDisplayMode === 'hidden') return 0;

    const taskIdSet = new Set(tasks.map(task => task.id));
    const parentChildPairs = new Set(
      tasks
        .filter(task => task.parentId)
        .map(task => `${task.parentId}->${task.id}`),
    );
    let count = 0;
    for (const connection of project.connections ?? []) {
      if (connection.deletedAt) continue;
      if (!taskIdSet.has(connection.source) || !taskIdSet.has(connection.target)) continue;
      if (parentChildPairs.has(`${connection.source}->${connection.target}`)) continue;
      if (this.relationDisplayMode === 'focused') {
        const focusedTaskId = this.relationFocusedTaskId;
        if (!focusedTaskId || (connection.source !== focusedTaskId && connection.target !== focusedTaskId)) {
          continue;
        }
      }
      count += 1;
    }
    return count;
  }

  /**
   * 更新图表数据
   */
  updateDiagram(tasks: Task[], forceRefresh: boolean = false): void {
    try {
      const context = this.createDiagramUpdateContext(tasks);
      if (!context) return;

      // 【2026-04-24 性能优化】先做最便宜的指纹短路，避免 30+ 任务场景下
      // 每次 signal emission 都执行 O(n) 的 currentNodeMap 构建 + detectStructuralChange。
      // 指纹已覆盖 title/updatedAt/displayId/parentId/stage/status/parkingMeta，再叠加连接与
      // docks/search 指纹，足以判断“任何影响图表显示的字段是否变化”。
      if (this.canSkipByFingerprint(context, forceRefresh)) return;

      // 仅在可能需要重建时才构建 node 映射，并复用为 existingNodeMap（避免两次 O(n) 扫描）
      const maps = collectCurrentDiagramMaps(context.model);
      const hasStructuralChange = this.detectStructuralChange(maps.currentNodeMap, context.activeTasks);

      if (this.canSkipPositionOnlyUpdate(context, forceRefresh, hasStructuralChange)) return;

      const diagramData = this.buildUpdatedDiagramData(context, maps.currentNodeMap);
      this.pruneSidecarExpandedTaskIds(diagramData.nodeDataArray);
      applyDiagramData(context.diagram, context.model, diagramData, maps);
      this.updateDiagramFingerprints(context);
      this.restoreSelectionAfterDataMerge(context.diagram, this.collectSelectedKeys(context.diagram));

      this.logFirstFamilyColorLink(context.model);
      this.scheduleInitialFitIfNeeded(diagramData);
    } catch (error) {
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'updateDiagram' } });
      this.logger.error('❌ 更新流程图失败', error);
      this.toast.error('流程图错误', '更新流程图失败。请刷新页面重试。');
    }
  }

  private createDiagramUpdateContext(tasks: Task[]): DiagramUpdateContext | null {
    if (!this.diagram) return null;

    const project = this.projectState.activeProject();
    if (!project) return null;

    this.sidecarExpansion.ensureLoaded(project.id);

    const activeTasks = tasks.filter(t => !t.deletedAt);
    const searchQuery = this.uiState.searchQuery();
    const taskFingerprint = this.computeTaskFingerprint(activeTasks);
    const taskVisualFingerprint = this.computeTaskVisualFingerprint(activeTasks, searchQuery.trim().length > 0);
    const dockFingerprint = this.computeDockFingerprint();
    const activeConns = project.connections?.filter(c => !c.deletedAt) ?? [];
    const connSig = this.computeConnectionSignature(activeConns);
    const relationDisplaySignature = this.computeRelationDisplaySignature();

    return {
      diagram: this.diagram,
      model: this.diagram.model as go.GraphLinksModel,
      project,
      activeTasks,
      searchQuery,
      lastUpdateType: this.taskOps.getLastUpdateType(),
      taskFingerprint,
      taskVisualFingerprint,
      dockFingerprint,
      connSig,
      relationDisplaySignature,
      hasTaskDataChange: taskFingerprint !== this.lastTaskFingerprint,
      hasTaskVisualChange: taskVisualFingerprint !== this.lastTaskVisualFingerprint,
    };
  }

  private canSkipByFingerprint(context: DiagramUpdateContext, forceRefresh: boolean): boolean {
    return !forceRefresh
      && !context.hasTaskDataChange
      && context.connSig === this.lastConnectionSignatureForData
      && context.searchQuery === this.lastSearchQuery
      && context.dockFingerprint === this.lastDockFingerprint
      && context.relationDisplaySignature === this.lastRelationDisplaySignature;
  }

  private canSkipPositionOnlyUpdate(
    context: DiagramUpdateContext,
    forceRefresh: boolean,
    hasStructuralChange: boolean,
  ): boolean {
    return context.lastUpdateType === 'position'
      && !forceRefresh
      && !hasStructuralChange
      && !context.hasTaskVisualChange;
  }

  private buildUpdatedDiagramData(
    context: DiagramUpdateContext,
    existingNodeMap: Map<string, go.ObjectData>,
  ): GoJSDiagramData {
    return this.configService.buildDiagramData(
      context.activeTasks,
      context.project,
      context.searchQuery,
      existingNodeMap,
      {
        dockedTaskIds: this.dockEngine.dockedTaskIds(),
        focusedTaskId: this.dockEngine.focusingEntry()?.taskId ?? null,
      },
      {
        relationDisplayMode: this.relationDisplayMode,
        focusedTaskId: this.relationFocusedTaskId,
      },
      this.sidecarExpansion.taskIds,
    );
  }

  private collectSelectedKeys(diagram: go.Diagram): Set<string> {
    const selectedKeys = new Set<string>();
    diagram.selection.each((part: go.Part) => {
      if (part.data?.key) {
        selectedKeys.add(part.data.key);
      }
    });
    return selectedKeys;
  }

  private updateDiagramFingerprints(context: DiagramUpdateContext): void {
    // 【2026-02-25 性能优化】更新指纹缓存，下次无变化时可快速跳过
    this.lastTaskFingerprint = context.taskFingerprint;
    this.lastTaskVisualFingerprint = context.taskVisualFingerprint;
    this.lastConnectionSignatureForData = context.connSig;
    this.lastSearchQuery = context.searchQuery;
    this.lastDockFingerprint = context.dockFingerprint;
    this.lastRelationDisplaySignature = context.relationDisplaySignature;
  }

  private restoreSelectionAfterDataMerge(diagram: go.Diagram, selectedKeys: ReadonlySet<string>): void {
    if (selectedKeys.size === 0) return;

    // 先清除选中再恢复，确保 selectionChanged 回调触发（数据合并后 binding 可能覆盖了选中态边框）
    diagram.clearSelection();
    diagram.nodes.each((node: go.Node) => {
      if (selectedKeys.has(node.data?.key)) {
        node.isSelected = true;
      }
    });
  }

  private logFirstFamilyColorLink(model: go.GraphLinksModel): void {
    const linkData = model.linkDataArray;
    if (linkData?.length > 0 && !this._familyColorLogged) {
      this._familyColorLogged = true;
      this.logger.info(`[LineageColor] 首条连线数据: ${JSON.stringify(linkData[0])}`);
    }
  }

  private scheduleInitialFitIfNeeded(diagramData: GoJSDiagramData): void {
    if (!this.isFirstLoad || diagramData.nodeDataArray.length === 0) return;
    if (!this.diagram) return;

    this.isFirstLoad = false;
    const scheduledDiagram = this.diagram;
    const scheduledGeneration = this.lifecycleGeneration;
    if (this.initialFitTimer !== null) {
      clearTimeout(this.initialFitTimer);
      this.initialFitTimer = null;
    }
    const initialFitTimer = setTimeout(() => {
      if (this.initialFitTimer === initialFitTimer) {
        this.initialFitTimer = null;
      }
      if (this.diagram !== scheduledDiagram || this.lifecycleGeneration !== scheduledGeneration) return;
      const viewState = this.projectState.getViewState();
      if (!viewState) {
        if (this.uiState.activeView() !== 'flow') {
          this.pendingAutoFitToContents = true;
          return;
        }
        if (this.diagram === scheduledDiagram && this.lifecycleGeneration === scheduledGeneration) {
          this.zoomService.fitToContents();
        }
      }
    }, 100);
    this.initialFitTimer = initialFitTimer;
  }

  setRelationDisplayMode(mode: FlowRelationDisplayMode, focusedTaskId: string | null): boolean {
    const previousSignature = this.computeRelationDisplaySignature();
    this.relationDisplayMode = mode;
    this.relationFocusedTaskId = focusedTaskId;
    return this.computeRelationDisplaySignature() !== previousSignature;
  }

  toggleSidecarExpanded(taskId: string): boolean {
    if (!taskId) return false;
    const project = this.projectState.activeProject();
    if (!project) return false;

    this.sidecarExpansion.ensureLoaded(project.id);
    const nodeData = this.findNodeData(taskId);
    const hasSignals = Boolean(nodeData?.sidecarHasSignals);
    if (!hasSignals) return false;

    const nextExpanded = this.sidecarExpansion.toggle(project.id, taskId);
    this.setNodeSidecarExpanded(taskId, nextExpanded);
    return nextExpanded;
  }

  private findNodeData(taskId: string): go.ObjectData | null {
    const model = this.diagram?.model as go.GraphLinksModel | undefined;
    if (!model) return null;
    return model.nodeDataArray.find(node => node.key === taskId) ?? null;
  }

  private setNodeSidecarExpanded(taskId: string, expanded: boolean): void {
    const model = this.diagram?.model as go.GraphLinksModel | undefined;
    const nodeData = this.findNodeData(taskId);
    if (!model || !nodeData) return;

    model.setDataProperty(nodeData, 'sidecarExpanded', expanded);
    model.setDataProperty(nodeData, 'sidecarTopVisible', expanded && this.hasNodeSidecarItems(nodeData, 'sidecarTopBadgeItems'));
    model.setDataProperty(nodeData, 'sidecarRightVisible', expanded && this.hasNodeSidecarItems(nodeData, 'sidecarRightBadgeItems'));
    model.setDataProperty(nodeData, 'sidecarBottomVisible', expanded && this.hasNodeSidecarItems(nodeData, 'sidecarBottomBadgeItems'));
    model.setDataProperty(nodeData, 'sidecarLeftVisible', expanded && this.hasNodeSidecarItems(nodeData, 'sidecarLeftBadgeItems'));
    const node = this.diagram?.findNodeForKey(taskId);
    node?.updateTargetBindings();
  }

  private hasNodeSidecarItems(nodeData: go.ObjectData, property: string): boolean {
    const value = nodeData[property];
    return Array.isArray(value) && value.length > 0;
  }

  private pruneSidecarExpandedTaskIds(nodes: readonly { key: string; sidecarHasSignals?: boolean }[]): void {
    this.sidecarExpansion.prune(nodes);
  }

  // ========== 视图状态 ==========

  /**
   * 保存当前视图状态（缩放/位置），防抖 1s
   */
  saveViewState(): void {
    if (!this.diagram) return;

    if (this.viewStateSaveTimer !== null) {
      clearTimeout(this.viewStateSaveTimer);
    }

    const viewStateSaveTimer = setTimeout(() => {
      if (this.viewStateSaveTimer !== viewStateSaveTimer) return;
      try {
        if (!this.diagram) return;

        const projectId = this.projectState.activeProjectId();
        if (!projectId) return;

        const scale = this.diagram.scale;
        const pos = this.diagram.position;

        this.projectState.updateViewState(projectId, {
          scale,
          positionX: pos.x,
          positionY: pos.y
        });
        this.syncCoordinator.markLocalChanges('position');
        this.syncCoordinator.schedulePersist();
      } finally {
        if (this.viewStateSaveTimer === viewStateSaveTimer) {
          this.viewStateSaveTimer = null;
        }
      }
    }, 1000);
    this.viewStateSaveTimer = viewStateSaveTimer;
  }

  cancelPendingViewStateSave(): void {
    if (this.viewStateSaveTimer !== null) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
  }

  /**
   * 恢复上次保存的视图状态
   */
  restoreViewState(): void {
    if (!this.diagram) return;

    const immediateViewState = this.projectState.getViewState();
    if (immediateViewState) {
      this.applyViewState(immediateViewState);
      return;
    }

    if (this.restoreViewStateTimer !== null) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }

    const restoreViewStateTimer = setTimeout(() => {
      if (this.restoreViewStateTimer !== restoreViewStateTimer) return;
      try {
        if (!this.diagram) return;

        const viewState = this.projectState.getViewState();

        if (viewState) {
          this.applyViewState(viewState);
          return;
        }

        if (this.uiState.activeView() !== 'flow') {
          this.pendingAutoFitToContents = true;
          return;
        }

        this.scheduleAutoFitToContents();
      } finally {
        if (this.restoreViewStateTimer === restoreViewStateTimer) {
          this.restoreViewStateTimer = null;
        }
      }
    }, 200);
    this.restoreViewStateTimer = restoreViewStateTimer;
  }

  private applyViewState(viewState: { scale: number; positionX: number; positionY: number }): void {
    this.pendingAutoFitToContents = false;
    if (!this.diagram) return;
    this.diagram.scale = viewState.scale;
    this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
  }

  private scheduleAutoFitToContents(): void {
    if (this.autoFitTimer !== null) {
      clearTimeout(this.autoFitTimer);
      this.autoFitTimer = null;
    }

    const autoFitTimer = setTimeout(() => {
      if (this.autoFitTimer !== autoFitTimer) return;
      try {
        if (!this.diagram) return;
        this.zoomService.fitToContents();
      } finally {
        if (this.autoFitTimer === autoFitTimer) {
          this.autoFitTimer = null;
        }
      }
    }, 300);
    this.autoFitTimer = autoFitTimer;
  }

  // ========== Flow 视图激活 ==========

  /**
   * 由外部在 Flow 视图激活时调用
   */
  onFlowActivated(): void {
    if (!this.diagram) return;
    if (this.uiState.activeView() !== 'flow') return;
    if (!this.pendingAutoFitToContents) return;

    const viewState = this.projectState.getViewState();
    if (viewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = viewState.scale;
      this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      return;
    }

    this.pendingAutoFitToContents = false;
    const scheduledDiagram = this.diagram;
    const scheduledGeneration = this.lifecycleGeneration;
    const firstRafId = requestAnimationFrame(() => {
      this.flowActivationFitRafIds = this.flowActivationFitRafIds.filter(id => id !== firstRafId);
      if (this.diagram !== scheduledDiagram || this.lifecycleGeneration !== scheduledGeneration) return;
      const secondRafId = requestAnimationFrame(() => {
        this.flowActivationFitRafIds = this.flowActivationFitRafIds.filter(id => id !== secondRafId);
        if (this.diagram !== scheduledDiagram || this.lifecycleGeneration !== scheduledGeneration) return;
        this.zoomService.fitToContents();
      });
      this.flowActivationFitRafIds.push(secondRafId);
    });
    this.flowActivationFitRafIds.push(firstRafId);
  }

  // ========== 清理 ==========

  /**
   * 清理所有内部定时器
   */
  clearTimers(): void {
    if (this.viewStateSaveTimer !== null) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
    if (this.restoreViewStateTimer !== null) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }
    if (this.autoFitTimer !== null) {
      clearTimeout(this.autoFitTimer);
      this.autoFitTimer = null;
    }
    if (this.initialFitTimer !== null) {
      clearTimeout(this.initialFitTimer);
      this.initialFitTimer = null;
    }
    for (const rafId of this.flowActivationFitRafIds) {
      cancelAnimationFrame(rafId);
    }
    this.flowActivationFitRafIds = [];
  }

  /**
   * 销毁时重置状态
   */
  dispose(): void {
    this.lifecycleGeneration += 1;
    this.clearTimers();
    this.diagram = null;
    this.isFirstLoad = true;
    this._familyColorLogged = false;
    this.pendingAutoFitToContents = false;
    this.lastTaskFingerprint = '';
    this.lastTaskVisualFingerprint = '';
    this.lastConnectionSignatureForData = '';
    this.lastSearchQuery = '';
    this.lastDockFingerprint = '';
    this.lastRelationDisplaySignature = '';
    this.relationDisplayMode = 'all';
    this.relationFocusedTaskId = null;
    this.sidecarExpansion.reset();
  }

  // ========== 【2026-02-25 性能优化】增量更新辅助 ==========

  /**
   * 计算任务列表的快速指纹
   * 包含影响图表显示的所有关键属性，用于跳过无变化的全量重建
   * O(n) 字符串拼接，但远比 buildDiagramData + merge + GC 开销小
   */
  private computeTaskFingerprint(tasks: Task[]): string {
    // 使用数组 join 代替字符串拼接，减少中间字符串分配
    const parts: string[] = [];
    for (const t of tasks) {
      parts.push(
        t.id, '|',
        t.title, '|',
        t.displayId || '', '|',
        t.updatedAt || '', '|',
        t.parentId || '', '|',
        String(t.stage), '|',
        t.status || '', '|',
        t.parkingMeta?.state || '', ';'
      );
    }
    return parts.join('');
  }

  private computeTaskVisualFingerprint(tasks: Task[], includeSearchFields: boolean): string {
    const parts: string[] = [];
    for (const t of tasks) {
      parts.push(
        t.id, '|',
        t.title, '|',
        t.displayId || '', '|',
        t.parentId || '', '|',
        String(t.stage), '|',
        String(t.rank ?? ''), '|',
        t.status || '', '|',
        t.parkingMeta?.state || '', ';'
      );
      if (includeSearchFields) {
        parts.push(
          t.content || '', '|',
          (t.attachments ?? []).map(attachment => attachment.name).join(','), '|',
          (t.tags ?? []).join(','), ';'
        );
      }
    }
    return parts.join('');
  }

  private computeDockFingerprint(): string {
    const dockedIds = Array.from(this.dockEngine.dockedTaskIds()).sort();
    const focusedTaskId = this.dockEngine.focusingEntry()?.taskId ?? '';
    return `${focusedTaskId}|${dockedIds.join(',')}`;
  }

  private computeConnectionSignature(
    connections: Array<{
      source: string;
      target: string;
      title?: string;
      description?: string;
      updatedAt?: string;
    }>
  ): string {
    return connections
      .map(c => `${c.source}->${c.target}|${c.title ?? ''}|${c.description ?? ''}|${c.updatedAt ?? ''}`)
      .sort()
      .join('|');
  }

  private computeRelationDisplaySignature(): string {
    return `${this.relationDisplayMode}|${this.relationFocusedTaskId ?? ''}`;
  }
}
