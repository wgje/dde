/**
 * FlowLayoutService - 流程图布局计算服务
 * 
 * 职责：
 * - 自动布局计算
 * - 节点位置更新
 * - Rank 更新
 * - 布局算法应用
 * 
 * 从 FlowDiagramService 拆分
 */

import { Injectable, Injector, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { GOJS_CONFIG, LAYOUT_CONFIG } from '../../../../config';
import * as go from 'gojs';
import {
  computeFamilyBlockAutoLayout,
  type AutoLayoutLinkData,
  type AutoLayoutNodeData,
  type LayoutOptions,
  type NodePosition,
} from './flow-layout-auto-layout.helpers';

export { computeFamilyBlockAutoLayout } from './flow-layout-auto-layout.helpers';
export type { AutoLayoutLinkData, AutoLayoutNodeData, LayoutOptions, NodePosition } from './flow-layout-auto-layout.helpers';

type PersistedNodePosition = { taskId: string; x: number; y: number };

@Injectable({
  providedIn: 'root'
})
export class FlowLayoutService {
  private readonly injector = inject(Injector);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLayout');

  private get taskOps(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }
  
  /** 外部注入的 Diagram 引用 */
  private diagram: go.Diagram | null = null;
  
  /** 位置保存定时器 */
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** 位置保存失败后的重试定时器 */
  private positionRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 上次持久化失败但仍属于当前 layout generation 的坐标批次。 */
  private pendingPositionRetry: PersistedNodePosition[] | null = null;

  /** 重试批次所属 generation；generation 变化时必须丢弃旧坐标。 */
  private pendingPositionRetryGeneration: number | null = null;

  /** 坐标保存请求序号；同 generation 内只允许最新请求清理待重试批次。 */
  private positionPersistSequence = 0;

  /** 当前待重试批次对应的保存请求序号。 */
  private pendingPositionRetrySequence: number | null = null;

  private readonly POSITION_RETRY_DELAY_MS = 1000;

  /**
   * 布局代际（layout generation）
   *
   * 计划 §8.4：用户在布局/拖拽期间继续编辑、切换项目或销毁 Flow 时，
   * 旧 generation 的延迟保存必须丢弃，不能晚到覆盖新坐标。
   *
   * 当前布局算法在事务内同步完成（无 Worker / 分片），
   * 因此 generation 主要保护以下场景：
   * 1. `scheduleSaveAllPositions` 防抖窗口内 diagram 被销毁 / 替换；
   * 2. 防抖窗口内调用方主动调用 `requestLayoutGeneration()` 表明
   *    后续布局需重算（例如切换项目、批量数据变化）。
   */
  private layoutGeneration = 0;

  /** 计划上次防抖保存所属的 generation；timer fire 时与当前 generation 对比。 */
  private pendingSaveGeneration: number | null = null;

  /**
   * 设置 Diagram 引用
   * 由 FlowDiagramService 在初始化时调用
   *
   * Diagram 更换或置空时递增 generation，丢弃任何 in-flight 的延迟保存，
   * 保证旧 diagram 的坐标不会晚到写回新 diagram 的 store。
   */
  setDiagram(diagram: go.Diagram | null): void {
    if (this.diagram !== diagram) {
      this.layoutGeneration += 1;
      // 清理任何 in-flight 防抖保存：它们绑定的是旧 diagram。
      if (this.positionSaveTimer !== null) {
        clearTimeout(this.positionSaveTimer);
        this.positionSaveTimer = null;
      }
      this.pendingSaveGeneration = null;
      this.clearPositionRetry();
    }
    this.diagram = diagram;
  }

  /**
   * 显式递进布局代际。
   *
   * 调用方场景：项目切换、数据批量变化、外部触发的布局重算。
   * 任何在此之前 schedule 的 `scheduleSaveAllPositions` 都将被丢弃。
   *
   * 计划 §8.4 「布局任务实现层面要有可观察的取消语义」。
   */
  requestLayoutGeneration(): number {
    this.layoutGeneration += 1;
    if (this.positionSaveTimer !== null) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.pendingSaveGeneration = null;
    this.clearPositionRetry();
    return this.layoutGeneration;
  }

  /**
   * 当前布局代际。供 spec / 调用方诊断。
   */
  getLayoutGeneration(): number {
    return this.layoutGeneration;
  }
  
  /**
   * 应用自动布局（按阶段对齐）
   * 同阶段的节点排列在同一列，保证任务按阶段数上下对应
   * @param options 布局选项
   */
  applyAutoLayout(options: LayoutOptions = {}): void {
    if (!this.diagram) return;
    
    const {
      layerSpacing = LAYOUT_CONFIG.STAGE_SPACING,
      columnSpacing = LAYOUT_CONFIG.ROW_SPACING
    } = options;
    
    // 【P1-12 根治】事务内同步完成布局 + 位置保存，不跨 setTimeout
    this.diagram.startTransaction('auto-layout');
    
    const layoutNodes: AutoLayoutNodeData[] = [];
    const nodeMap = new Map<string, go.Node>();

    this.diagram.nodes.each((node: go.Node) => {
      const data = node.data as { key?: string; stage?: number | null; rank?: number } | undefined;
      if (!data?.key) {
        return;
      }

      layoutNodes.push({
        key: data.key,
        stage: data.stage ?? null,
        rank: data.rank,
      });
      nodeMap.set(data.key, node);
    });

    const layoutLinks: AutoLayoutLinkData[] = [];
    this.diagram.links.each((link: go.Link) => {
      const fromData = link.fromNode?.data as { key?: string } | undefined;
      const toData = link.toNode?.data as { key?: string } | undefined;
      if (!fromData?.key || !toData?.key) {
        return;
      }

      layoutLinks.push({
        from: fromData.key,
        to: toData.key,
        isCrossTree: Boolean(link.data?.isCrossTree),
      });
    });

    const positions = computeFamilyBlockAutoLayout(layoutNodes, layoutLinks, {
      layerSpacing,
      columnSpacing,
    });

    positions.forEach(position => {
      const node = nodeMap.get(position.key);
      if (!node) {
        return;
      }

      node.location = new go.Point(position.x, position.y);
    });
    
    this.saveAllNodePositions();
    this.diagram.commitTransaction('auto-layout');
    
    this.logger.info('自动布局已应用（主任务分区式阶段对齐）');
  }
  
  /**
   * 应用树形布局
   * @param options 布局选项
   */
  applyTreeLayout(options: LayoutOptions = {}): void {
    if (!this.diagram) return;
    
    const $ = go.GraphObject.make;
    const {
      layerSpacing = GOJS_CONFIG.LAYER_SPACING
    } = options;
    
    // 【P1-12 根治】事务内同步完成布局 + 位置保存，不跨 setTimeout
    this.diagram.startTransaction('tree-layout');
    this.diagram.layout = $(go.TreeLayout, {
      angle: 0,
      layerSpacing,
      nodeSpacing: 20
    });
    this.diagram.layoutDiagram(true);
    this.saveAllNodePositions();
    this.diagram.layout = $(go.Layout);
    this.diagram.commitTransaction('tree-layout');
    
    this.logger.info('树形布局已应用');
  }
  
  /**
   * 保存所有节点位置到 Store
   */
  saveAllNodePositions(): void {
    if (!this.diagram) return;

    const positions: PersistedNodePosition[] = [];
    this.diagram.nodes.each((node: go.Node) => {
      const data = node.data as { key?: string };
      const loc = node.location;
      if (data?.key && loc.isReal()) {
        positions.push({ taskId: data.key, x: loc.x, y: loc.y });
      }
    });

    if (positions.length > 0) {
      void this.persistNodePositions(
        positions,
        this.layoutGeneration,
        this.createPositionPersistSequence(),
      );
    }

    this.logger.debug('所有节点位置已保存');
  }

  private async persistNodePositions(
    positions: PersistedNodePosition[],
    generation: number,
    sequence: number,
  ): Promise<void> {
    const positionsSnapshot = positions.map(position => ({ ...position }));

    try {
      const saved = await this.taskOps.updateTaskPositionsDurably(positionsSnapshot);
      if (saved) {
        if (
          this.pendingPositionRetryGeneration === generation
          && this.pendingPositionRetrySequence === sequence
        ) {
          this.clearPositionRetry();
        }
        return;
      }

      this.handleNodePositionPersistFailure(positionsSnapshot, generation, sequence);
    } catch (error) {
      this.handleNodePositionPersistFailure(positionsSnapshot, generation, sequence, error);
    }
  }

  private handleNodePositionPersistFailure(
    positions: PersistedNodePosition[],
    generation: number,
    sequence: number,
    error?: unknown,
  ): void {
    if (generation !== this.layoutGeneration || !this.diagram) {
      return;
    }

    this.pendingPositionRetry = positions.map(position => ({ ...position }));
    this.pendingPositionRetryGeneration = generation;
    this.pendingPositionRetrySequence = sequence;
    this.logger.warn('流程图节点位置批量持久化失败，已安排重试', {
      count: positions.length,
      error,
    });
    this.schedulePositionRetry();
  }

  private schedulePositionRetry(): void {
    if (this.positionRetryTimer !== null || !this.pendingPositionRetry) {
      return;
    }

    this.positionRetryTimer = setTimeout(() => {
      this.positionRetryTimer = null;
      const positions = this.pendingPositionRetry;
      const generation = this.pendingPositionRetryGeneration;
      const sequence = this.pendingPositionRetrySequence;
      if (!positions || generation === null || sequence === null) {
        return;
      }
      if (generation !== this.layoutGeneration || !this.diagram) {
        this.clearPositionRetry();
        return;
      }

      void this.persistNodePositions(positions, generation, sequence);
    }, this.POSITION_RETRY_DELAY_MS);
  }

  private clearPositionRetry(): void {
    if (this.positionRetryTimer !== null) {
      clearTimeout(this.positionRetryTimer);
      this.positionRetryTimer = null;
    }
    this.pendingPositionRetry = null;
    this.pendingPositionRetryGeneration = null;
    this.pendingPositionRetrySequence = null;
  }

  private createPositionPersistSequence(): number {
    this.positionPersistSequence += 1;
    return this.positionPersistSequence;
  }
  
  /**
   * 延迟保存所有节点位置（防抖）
   * 用于拖动操作结束后保存
   *
   * 计划 §8.4：timer fire 时必须二次校验 diagram 仍存在 + generation 未递进，
   * 避免布局期间组件销毁、项目切换或外部 `requestLayoutGeneration()`
   * 调用之后旧坐标仍写回 store 造成 stale_layout_dropped 数据污染。
   */
  scheduleSaveAllPositions(): void {
    if (this.positionSaveTimer !== null) {
      clearTimeout(this.positionSaveTimer);
    }

    const scheduledGeneration = this.layoutGeneration;
    const scheduledDiagram = this.diagram;
    this.pendingSaveGeneration = scheduledGeneration;

    this.positionSaveTimer = setTimeout(() => {
      this.positionSaveTimer = null;
      this.pendingSaveGeneration = null;

      // 二次校验：generation 未递进 + diagram 引用仍是同一个。
      if (scheduledGeneration !== this.layoutGeneration) {
        this.logger.debug('stale_layout_dropped: 布局代际已递进，丢弃旧坐标保存');
        return;
      }
      if (this.diagram === null || this.diagram !== scheduledDiagram) {
        this.logger.debug('stale_layout_dropped: diagram 已释放或更换，丢弃旧坐标保存');
        return;
      }

      this.saveAllNodePositions();
    }, 300);
  }
  
  /**
   * 获取节点位置
   * @param nodeKey 节点 key
   */
  getNodePosition(nodeKey: string): NodePosition | null {
    if (!this.diagram) return null;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (!node || !node.location.isReal()) return null;
    
    return {
      key: nodeKey,
      x: node.location.x,
      y: node.location.y
    };
  }
  
  /**
   * 设置节点位置
   * @param nodeKey 节点 key
   * @param x X 坐标
   * @param y Y 坐标
   */
  setNodePosition(nodeKey: string, x: number, y: number): void {
    if (!this.diagram) return;
    
    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      this.diagram.startTransaction('move-node');
      node.location = new go.Point(x, y);
      this.diagram.commitTransaction('move-node');
    }
  }
  
  /**
   * 批量设置节点位置
   * @param positions 节点位置列表
   */
  setNodePositions(positions: NodePosition[]): void {
    if (!this.diagram || positions.length === 0) return;
    
    this.diagram.startTransaction('move-nodes');
    for (const pos of positions) {
      const node = this.diagram.findNodeForKey(pos.key);
      if (node) {
        node.location = new go.Point(pos.x, pos.y);
      }
    }
    this.diagram.commitTransaction('move-nodes');
  }
  
  /**
   * 获取所有节点位置
   */
  getAllNodePositions(): NodePosition[] {
    const positions: NodePosition[] = [];
    if (!this.diagram) return positions;
    
    this.diagram.nodes.each((node: go.Node) => {
      const data = node.data as { key?: string };
      const loc = node.location;
      if (data?.key && loc.isReal()) {
        positions.push({
          key: data.key,
          x: loc.x,
          y: loc.y
        });
      }
    });
    
    return positions;
  }
  
  /**
   * 使连接线失效（需要重新计算路由）
   */
  invalidateAllLinkRoutes(): void {
    if (!this.diagram) return;
    
    this.diagram.links.each((link: go.Link) => {
      link.invalidateRoute();
    });
  }
  
  /**
   * 使所有节点布局失效
   */
  invalidateAllNodeLayouts(): void {
    if (!this.diagram) return;
    
    this.diagram.nodes.each((node: go.Node) => {
      node.invalidateLayout();
    });
  }
  
  /**
   * 清理资源
   */
  dispose(): void {
    if (this.positionSaveTimer !== null) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.clearPositionRetry();
    this.diagram = null;
  }
}
