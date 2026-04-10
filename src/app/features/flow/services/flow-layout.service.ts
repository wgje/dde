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

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { GOJS_CONFIG, LAYOUT_CONFIG } from '../../../../config';
import * as go from 'gojs';

/**
 * 节点位置信息
 */
export interface NodePosition {
  key: string;
  x: number;
  y: number;
}

/**
 * 布局选项
 */
export interface LayoutOptions {
  /** 布局方向 (0=从左到右, 90=从上到下, 180=从右到左, 270=从下到上) */
  direction?: number;
  /** 层间距 */
  layerSpacing?: number;
  /** 列间距 */
  columnSpacing?: number;
}

/**
 * 自动布局输入节点
 */
export interface AutoLayoutNodeData {
  key: string;
  stage: number | null;
  rank?: number;
}

/**
 * 自动布局输入连线
 */
export interface AutoLayoutLinkData {
  from: string;
  to: string;
  isCrossTree?: boolean;
}

interface ResolvedAutoLayoutOptions {
  layerSpacing: number;
  columnSpacing: number;
  familyGapRows: number;
  minFamilyBlockRows: number;
}

interface FamilyLayoutBlock {
  rootKey: string;
  nodes: AutoLayoutNodeData[];
  stageGroups: Map<number, AutoLayoutNodeData[]>;
  blockRows: number;
  pathMap: Map<string, readonly number[]>;
}

function isAssignedLayoutNode(node: AutoLayoutNodeData): node is AutoLayoutNodeData & { stage: number } {
  return node.stage != null && node.stage > 0;
}

function compareLayoutNodes(a: AutoLayoutNodeData, b: AutoLayoutNodeData): number {
  return (a.rank ?? 0) - (b.rank ?? 0) || a.key.localeCompare(b.key);
}

function compareRootNodes(a: AutoLayoutNodeData, b: AutoLayoutNodeData): number {
  return (a.stage ?? Number.MAX_SAFE_INTEGER) - (b.stage ?? Number.MAX_SAFE_INTEGER)
    || compareLayoutNodes(a, b);
}

function comparePath(pathA: readonly number[], pathB: readonly number[]): number {
  const maxLength = Math.max(pathA.length, pathB.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left = pathA[index];
    const right = pathB[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left !== right) return left - right;
  }
  return 0;
}

function buildParentAndChildrenMaps(
  assignedNodeMap: Map<string, AutoLayoutNodeData>,
  links: readonly AutoLayoutLinkData[],
): {
  parentMap: Map<string, string>;
  childrenMap: Map<string, AutoLayoutNodeData[]>;
} {
  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, AutoLayoutNodeData[]>();

  for (const link of links) {
    if (link.isCrossTree) {
      continue;
    }

    const parent = assignedNodeMap.get(link.from);
    const child = assignedNodeMap.get(link.to);
    if (!parent || !child || parentMap.has(child.key)) {
      continue;
    }

    parentMap.set(child.key, parent.key);
    const siblings = childrenMap.get(parent.key) ?? [];
    siblings.push(child);
    childrenMap.set(parent.key, siblings);
  }

  for (const siblings of childrenMap.values()) {
    siblings.sort(compareLayoutNodes);
  }

  return { parentMap, childrenMap };
}

function buildFamilyPathMap(
  root: AutoLayoutNodeData,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  allowedNodeKeys: ReadonlySet<string>,
): Map<string, readonly number[]> {
  const pathMap = new Map<string, readonly number[]>([[root.key, []]]);
  const queue: AutoLayoutNodeData[] = [root];
  const seen = new Set<string>([root.key]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const parentPath = pathMap.get(current.key) ?? [];
    const children = (childrenMap.get(current.key) ?? []).filter(child => allowedNodeKeys.has(child.key));

    children.forEach((child, childIndex) => {
      if (seen.has(child.key)) {
        return;
      }

      pathMap.set(child.key, [...parentPath, childIndex]);
      seen.add(child.key);
      queue.push(child);
    });
  }

  return pathMap;
}

function buildFamilyBlocks(
  assignedNodes: readonly AutoLayoutNodeData[],
  parentMap: Map<string, string>,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  minFamilyBlockRows: number,
): FamilyLayoutBlock[] {
  const naturalRoots = assignedNodes
    .filter(node => {
      const parentKey = parentMap.get(node.key);
      return !parentKey;
    })
    .sort(compareRootNodes);

  const visited = new Set<string>();
  const blocks: FamilyLayoutBlock[] = [];

  const collectFamily = (root: AutoLayoutNodeData) => {
    const familyNodes: AutoLayoutNodeData[] = [];
    const stack: AutoLayoutNodeData[] = [root];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current.key)) {
        continue;
      }

      visited.add(current.key);
      familyNodes.push(current);

      const children = childrenMap.get(current.key) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (!visited.has(child.key)) {
          stack.push(child);
        }
      }
    }

    const familyNodeKeys = new Set(familyNodes.map(node => node.key));
    const pathMap = buildFamilyPathMap(root, childrenMap, familyNodeKeys);
    const stageGroups = new Map<number, AutoLayoutNodeData[]>();

    familyNodes.forEach(node => {
      if (!isAssignedLayoutNode(node)) {
        return;
      }

      const group = stageGroups.get(node.stage) ?? [];
      group.push(node);
      stageGroups.set(node.stage, group);
    });

    for (const stageNodes of stageGroups.values()) {
      stageNodes.sort((left, right) => {
        const pathCompare = comparePath(pathMap.get(left.key) ?? [], pathMap.get(right.key) ?? []);
        return pathCompare || compareLayoutNodes(left, right);
      });
    }

    const blockRows = Math.max(
      minFamilyBlockRows,
      ...Array.from(stageGroups.values(), nodes => nodes.length),
      1,
    );

    blocks.push({
      rootKey: root.key,
      nodes: familyNodes,
      stageGroups,
      blockRows,
      pathMap,
    });
  };

  naturalRoots.forEach(collectFamily);

  assignedNodes
    .filter(node => !visited.has(node.key))
    .sort(compareRootNodes)
    .forEach(collectFamily);

  return blocks;
}

/**
 * 计算“主任务家族区块”自动布局。
 * 同一阶段仍在同一列，但每个主任务家族会保留独立纵向区块，
 * 防止前一个主任务的子孙任务侵入下一个主任务的视觉领地。
 */
export function computeFamilyBlockAutoLayout(
  nodes: readonly AutoLayoutNodeData[],
  links: readonly AutoLayoutLinkData[],
  options: LayoutOptions = {},
): NodePosition[] {
  const resolvedOptions: ResolvedAutoLayoutOptions = {
    layerSpacing: options.layerSpacing ?? LAYOUT_CONFIG.STAGE_SPACING,
    columnSpacing: options.columnSpacing ?? LAYOUT_CONFIG.ROW_SPACING,
    familyGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_FAMILY_GAP_ROWS,
    minFamilyBlockRows: LAYOUT_CONFIG.AUTO_LAYOUT_MIN_FAMILY_BLOCK_ROWS,
  };

  const assignedNodes = nodes.filter(isAssignedLayoutNode);
  const unassignedNodes = nodes.filter(node => !isAssignedLayoutNode(node));
  const assignedNodeMap = new Map(assignedNodes.map(node => [node.key, node]));
  const { parentMap, childrenMap } = buildParentAndChildrenMaps(assignedNodeMap, links);
  const stageNums = Array.from(new Set(assignedNodes.map(node => node.stage!))).sort((a, b) => a - b);
  const stageIndexMap = new Map(stageNums.map((stage, index) => [stage, index]));
  const familyBlocks = buildFamilyBlocks(
    assignedNodes,
    parentMap,
    childrenMap,
    resolvedOptions.minFamilyBlockRows,
  );

  const positionMap = new Map<string, NodePosition>();
  let currentFamilyStartRow = 0;

  familyBlocks.forEach(block => {
    const stages = Array.from(block.stageGroups.keys()).sort((left, right) => left - right);

    stages.forEach(stage => {
      const stageNodes = block.stageGroups.get(stage) ?? [];
      const stageIndex = stageIndexMap.get(stage);
      if (stageIndex === undefined || stageNodes.length === 0) {
        return;
      }

      const topPaddingRows = (block.blockRows - stageNodes.length) / 2;
      const x = stageIndex * resolvedOptions.layerSpacing;

      stageNodes.forEach((node, nodeIndex) => {
        const y = (currentFamilyStartRow + topPaddingRows + nodeIndex) * resolvedOptions.columnSpacing;
        positionMap.set(node.key, {
          key: node.key,
          x,
          y,
        });
      });
    });

    currentFamilyStartRow += block.blockRows + resolvedOptions.familyGapRows;
  });

  const unassignedX = stageNums.length > 0
    ? stageNums.length * resolvedOptions.layerSpacing
    : 0;

  unassignedNodes
    .slice()
    .sort(compareLayoutNodes)
    .forEach((node, nodeIndex) => {
      positionMap.set(node.key, {
        key: node.key,
        x: unassignedX,
        y: nodeIndex * resolvedOptions.columnSpacing,
      });
    });

  return nodes
    .map(node => positionMap.get(node.key))
    .filter((position): position is NodePosition => position !== undefined);
}

@Injectable({
  providedIn: 'root'
})
export class FlowLayoutService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLayout');
  private readonly taskOps = inject(TaskOperationAdapterService);
  
  /** 外部注入的 Diagram 引用 */
  private diagram: go.Diagram | null = null;
  
  /** 位置保存定时器 */
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  /**
   * 设置 Diagram 引用
   * 由 FlowDiagramService 在初始化时调用
   */
  setDiagram(diagram: go.Diagram | null): void {
    this.diagram = diagram;
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
    
    this.diagram.nodes.each((node: go.Node) => {
      const data = node.data as { key?: string };
      const loc = node.location;
      if (data?.key && loc.isReal()) {
        this.taskOps.updateTaskPosition(data.key, loc.x, loc.y);
      }
    });
    
    this.logger.debug('所有节点位置已保存');
  }
  
  /**
   * 延迟保存所有节点位置（防抖）
   * 用于拖动操作结束后保存
   */
  scheduleSaveAllPositions(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
    }
    
    this.positionSaveTimer = setTimeout(() => {
      this.saveAllNodePositions();
      this.positionSaveTimer = null;
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
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.diagram = null;
  }
}
