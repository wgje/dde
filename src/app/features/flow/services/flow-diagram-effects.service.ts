import { Injectable, inject, effect, untracked, Injector, Signal, WritableSignal } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { PreferenceService } from '../../../../services/preference.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowCommandService } from './flow-command.service';
import { LoggerService } from '../../../../services/logger.service';
import { Task } from '../../../../models';

/**
 * 图表响应式效果服务
 * 
 * 统一管理流程图视图的 effect 逻辑：
 * - 任务数据变化时更新图表
 * - 跨树连接变化时更新图表
 * - 搜索查询变化时更新图表高亮
 * - 主题变化时更新节点颜色
 * - 选中状态同步
 * - 命令服务订阅
 */
@Injectable({ providedIn: 'root' })
export class FlowDiagramEffectsService {
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly preference = inject(PreferenceService);
  private readonly diagram = inject(FlowDiagramService);
  private readonly flowCommand = inject(FlowCommandService);
  private readonly logger = inject(LoggerService);

  /**
   * 创建任务数据变化 effect
   * 监听任务数据变化，使用 rAF 对齐渲染帧更新图表
   */
  createTasksEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): void {
    effect(() => {
      const tasks = this.projectState.tasks();
      if (this.diagram.isInitialized) {
        scheduleRafDiagramUpdate(tasks, false);
      }
    }, { injector });
  }

  /**
   * 创建跨树连接变化 effect
   * 监听 connections 变化（软删除和恢复）
   */
  createConnectionsEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): void {
    effect(() => {
      const project = this.projectState.activeProject();
      // 构建有效连接的签名（过滤掉 deletedAt，只统计活跃连接）
      const activeConnections = project?.connections?.filter((c: { deletedAt?: string | null }) => !c.deletedAt) ?? [];
      // 使用连接的 source-target 对作为签名，检测任何变化
      const connectionSignature = activeConnections
        .map((c: { source: string; target: string }) => `${c.source}->${c.target}`)
        .sort()
        .join('|');
      // 读取 connectionSignature 来建立依赖关系
      if (connectionSignature !== undefined && this.diagram.isInitialized) {
        scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector });
  }

  /**
   * 创建搜索查询变化 effect
   */
  createSearchEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): void {
    effect(() => {
      const _query = this.uiState.searchQuery();
      if (this.diagram.isInitialized) {
        scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector });
  }

  /**
   * 创建主题变化 effect
   */
  createThemeEffect(
    injector: Injector,
    scheduleRafDiagramUpdate: (tasks: Task[], forceRefresh: boolean) => void
  ): void {
    effect(() => {
      const _theme = this.preference.theme();
      if (this.diagram.isInitialized) {
        scheduleRafDiagramUpdate(this.projectState.tasks(), true);
      }
    }, { injector });
  }

  /**
   * 创建选中状态同步 effect
   * 当新任务创建后，GoJS 图表可能还未更新，需要延迟重试
   */
  createSelectionSyncEffect(
    injector: Injector,
    selectedTaskId: Signal<string | null>,
    selectNodeWithRetry: (taskId: string) => void
  ): void {
    effect(() => {
      const selectedId = selectedTaskId();
      if (selectedId && this.diagram.isInitialized) {
        selectNodeWithRetry(selectedId);
      }
    }, { injector });
  }

  /**
   * 创建居中命令订阅 effect
   */
  createCenterCommandEffect(
    injector: Injector,
    executeCenterOnNode: (taskId: string, openDetail: boolean) => void
  ): void {
    effect(() => {
      const cmd = this.flowCommand.centerNodeCommand();
      if (cmd) {
        untracked(() => {
          if (this.diagram.isInitialized) {
            executeCenterOnNode(cmd.taskId, cmd.openDetail);
            this.flowCommand.clearCenterCommand();
          }
        });
      }
    }, { injector });
  }

  /**
   * 创建重试初始化命令订阅 effect
   */
  createRetryCommandEffect(
    injector: Injector,
    retryInitDiagram: () => void
  ): void {
    effect(() => {
      const count = this.flowCommand.retryDiagramCommand();
      if (count > 0) {
        untracked(() => {
          retryInitDiagram();
        });
      }
    }, { injector });
  }
}
