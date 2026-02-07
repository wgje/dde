import { Injectable, inject } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowZoomService } from './flow-zoom.service';
import { Task } from '../../../../models';
import * as go from 'gojs';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

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
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagramData');
  private readonly toast = inject(ToastService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly zoomService = inject(FlowZoomService);

  // ========== GoJS Diagram 引用 ==========
  private diagram: go.Diagram | null = null;

  // ========== 定时器 ==========
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreViewStateTimer: ReturnType<typeof setTimeout> | null = null;
  private autoFitTimer: ReturnType<typeof setTimeout> | null = null;

  // ========== 标志 ==========
  private isFirstLoad = true;
  private _familyColorLogged = false;
  private pendingAutoFitToContents = false;

  // ========== 外部设置 ==========

  /**
   * 由 FlowDiagramService 在初始化后调用，传入 diagram 实例
   */
  setDiagram(diagram: go.Diagram | null): void {
    this.diagram = diagram;
    if (diagram) {
      this.isFirstLoad = true;
      this._familyColorLogged = false;
      this.pendingAutoFitToContents = false;
    }
  }

  // ========== 导出功能 ==========

  async exportToPng(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }

    try {
      const imgData = this.diagram.makeImageData({
        scale: 2,
        background: '#F5F2E9',
        type: 'image/png',
        maxSize: new go.Size(4096, 4096)
      }) as string;

      if (!imgData) {
        this.toast.error('导出失败', '无法生成图片');
        return null;
      }

      const response = await fetch(imgData);
      const blob = await response.blob();

      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.png`);
      this.toast.success('导出成功', 'PNG 图片已下载');

      return blob;
    } catch (error) {
      this.logger.error('导出 PNG 失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'exportToPng' } });
      this.toast.error('导出失败', '生成图片时发生错误');
      return null;
    }
  }

  async exportToSvg(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }

    try {
      const svg = this.diagram.makeSvg({
        scale: 1,
        background: '#F5F2E9',
        maxSize: new go.Size(4096, 4096)
      });

      if (!svg) {
        this.toast.error('导出失败', '无法生成 SVG');
        return null;
      }

      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });

      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.svg`);
      this.toast.success('导出成功', 'SVG 图片已下载');

      return blob;
    } catch (error) {
      this.logger.error('导出 SVG 失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'exportToSvg' } });
      this.toast.error('导出失败', '生成 SVG 时发生错误');
      return null;
    }
  }

  private getExportFileName(): string {
    const project = this.projectState.activeProject();
    const projectName = project?.name || '未命名项目';
    const date = new Date().toISOString().slice(0, 10);
    return `${projectName}_${date}`;
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
        const crossTreeCount = project.connections?.length || 0;
        const expectedLinkCount = parentChildCount + crossTreeCount;
        if (currentLinkCount !== expectedLinkCount) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 更新图表数据
   */
  updateDiagram(tasks: Task[], forceRefresh: boolean = false): void {
    if (!this.diagram) {
      return;
    }

    const project = this.projectState.activeProject();
    if (!project) {
      return;
    }

    try {
      const lastUpdateType = this.taskOps.getLastUpdateType();

      const model = this.diagram.model as go.GraphLinksModel;
      const currentNodeMap = new Map<string, go.ObjectData>();
      (model.nodeDataArray || []).forEach((n: go.ObjectData) => {
        if (n.key) currentNodeMap.set(n.key as string, n);
      });

      const activeTasks = tasks.filter(t => !t.deletedAt);
      const hasStructuralChange = this.detectStructuralChange(currentNodeMap, activeTasks);

      if (lastUpdateType === 'position' && !forceRefresh && !hasStructuralChange) {
        return;
      }

      const existingNodeMap = new Map<string, go.ObjectData>();
      (this.diagram.model as go.GraphLinksModel).nodeDataArray.forEach((n: go.ObjectData) => {
        if (n.key) {
          existingNodeMap.set(n.key as string, n);
        }
      });

      const searchQuery = this.uiState.searchQuery();
      const diagramData = this.configService.buildDiagramData(
        tasks.filter(t => !t.deletedAt),
        project,
        searchQuery,
        existingNodeMap
      );

      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: go.Part) => {
        if (part.data?.key) {
          selectedKeys.add(part.data.key);
        }
      });

      this.diagram.startTransaction('update');
      this.diagram.skipsUndoManager = true;

      model.mergeNodeDataArray(diagramData.nodeDataArray);

      const linkDataWithPorts = diagramData.linkDataArray.map(link => ({
        ...link,
        fromPortId: "",
        toPortId: ""
      }));

      model.mergeLinkDataArray(linkDataWithPorts);

      const nodeKeys = new Set(diagramData.nodeDataArray.map(n => n.key));
      const linkKeys = new Set(diagramData.linkDataArray.map(l => l.key));

      const nodesToRemove = model.nodeDataArray.filter((n: go.ObjectData) => !nodeKeys.has(n.key as string));
      nodesToRemove.forEach((n: go.ObjectData) => model.removeNodeData(n));

      const linksToRemove = model.linkDataArray.filter((l: go.ObjectData) => !linkKeys.has(l.key as string));
      linksToRemove.forEach((l: go.ObjectData) => model.removeLinkData(l));

      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');

      if (selectedKeys.size > 0) {
        this.diagram.nodes.each((node: go.Node) => {
          if (selectedKeys.has(node.data?.key)) {
            node.isSelected = true;
          }
        });
      }

      this.diagram.links.each((link: go.Link) => {
        link.invalidateRoute();
      });

      // Debug 日志
      const linkData = model.linkDataArray;
      if (linkData?.length > 0 && !this._familyColorLogged) {
        this._familyColorLogged = true;
        this.logger.info(`[LineageColor] 首条连线数据: ${JSON.stringify(linkData[0])}`);
      }

      if (this.isFirstLoad && diagramData.nodeDataArray.length > 0) {
        this.isFirstLoad = false;
        setTimeout(() => {
          if (!this.diagram) return;
          const viewState = this.projectState.getViewState();
          if (!viewState) {
            if (this.uiState.activeView() !== 'flow') {
              this.pendingAutoFitToContents = true;
              return;
            }
            this.zoomService.fitToContents();
          }
        }, 100);
      }

    } catch (error) {
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'updateDiagram' } });
      this.logger.error('❌ 更新流程图失败', error);
      this.toast.error('流程图错误', '更新流程图失败。请刷新页面重试。');
    }
  }

  // ========== 视图状态 ==========

  /**
   * 保存当前视图状态（缩放/位置），防抖 1s
   */
  saveViewState(): void {
    if (!this.diagram) return;

    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
    }

    this.viewStateSaveTimer = setTimeout(() => {
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
      this.syncCoordinator.schedulePersist();

      this.viewStateSaveTimer = null;
    }, 1000);
  }

  /**
   * 恢复上次保存的视图状态
   */
  restoreViewState(): void {
    if (!this.diagram) return;

    const immediateViewState = this.projectState.getViewState();
    if (immediateViewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = immediateViewState.scale;
      this.diagram.position = new go.Point(immediateViewState.positionX, immediateViewState.positionY);
      return;
    }

    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }

    this.restoreViewStateTimer = setTimeout(() => {
      if (!this.diagram) return;

      const viewState = this.projectState.getViewState();

      if (viewState) {
        this.pendingAutoFitToContents = false;
        this.diagram.scale = viewState.scale;
        this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      } else {
        if (this.uiState.activeView() !== 'flow') {
          this.pendingAutoFitToContents = true;
          return;
        }

        if (this.autoFitTimer) {
          clearTimeout(this.autoFitTimer);
          this.autoFitTimer = null;
        }

        this.autoFitTimer = setTimeout(() => {
          if (!this.diagram) return;
          this.zoomService.fitToContents();
          this.autoFitTimer = null;
        }, 300);
      }
      this.restoreViewStateTimer = null;
    }, 200);
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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.diagram) return;
        this.zoomService.fitToContents();
      });
    });
  }

  // ========== 清理 ==========

  /**
   * 清理所有内部定时器
   */
  clearTimers(): void {
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }
    if (this.autoFitTimer) {
      clearTimeout(this.autoFitTimer);
      this.autoFitTimer = null;
    }
  }

  /**
   * 销毁时重置状态
   */
  dispose(): void {
    this.clearTimers();
    this.diagram = null;
    this.isFirstLoad = true;
    this._familyColorLogged = false;
    this.pendingAutoFitToContents = false;
  }
}
