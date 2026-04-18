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
  crossTreeLabelGapRows: number;
  denseFamilyGapRows: number;
  maxExtraGapRows: number;
}

interface FamilyLayoutBlock {
  rootKey: string;
  nodes: AutoLayoutNodeData[];
  nodeKeys: ReadonlySet<string>;
  localRowMap: Map<string, number>;
  minRow: number;
  maxRow: number;
  maxStageDensity: number;
  leafCount: number;
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

function buildParentAndChildrenMaps(
  assignedNodeMap: Map<string, AutoLayoutNodeData>,
  links: readonly AutoLayoutLinkData[],
): {
  parentMap: Map<string, string>;
  childrenMap: Map<string, AutoLayoutNodeData[]>;
} {
  // 【鲁棒性 2026-04-16】多父场景下先收集所有候选父，再按"阶段差最小 + rank 最大"
  // 择优，而非原先的"先到先得"，避免链路顺序扰动布局。单父场景行为保持不变。
  const candidateParents = new Map<string, AutoLayoutNodeData[]>();
  for (const link of links) {
    if (link.isCrossTree) {
      continue;
    }
    const parent = assignedNodeMap.get(link.from);
    const child = assignedNodeMap.get(link.to);
    if (!parent || !child) {
      continue;
    }
    const list = candidateParents.get(child.key) ?? [];
    list.push(parent);
    candidateParents.set(child.key, list);
  }

  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, AutoLayoutNodeData[]>();

  for (const [childKey, parents] of candidateParents) {
    const child = assignedNodeMap.get(childKey);
    if (!child || !isAssignedLayoutNode(child) || parents.length === 0) {
      continue;
    }

    let bestParent: AutoLayoutNodeData = parents[0];
    let bestStageDiff = isAssignedLayoutNode(bestParent)
      ? Math.abs(child.stage - bestParent.stage)
      : Number.MAX_SAFE_INTEGER;

    for (let i = 1; i < parents.length; i += 1) {
      const candidate = parents[i];
      if (!isAssignedLayoutNode(candidate)) {
        continue;
      }
      const diff = Math.abs(child.stage - candidate.stage);
      if (
        diff < bestStageDiff ||
        (diff === bestStageDiff && (candidate.rank ?? 0) > (bestParent.rank ?? 0))
      ) {
        bestParent = candidate;
        bestStageDiff = diff;
      }
    }

    parentMap.set(child.key, bestParent.key);
    const siblings = childrenMap.get(bestParent.key) ?? [];
    siblings.push(child);
    childrenMap.set(bestParent.key, siblings);
  }

  for (const siblings of childrenMap.values()) {
    siblings.sort(compareLayoutNodes);
  }

  return { parentMap, childrenMap };
}

function buildFamilyLocalRows(
  root: AutoLayoutNodeData,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  allowedNodeKeys: ReadonlySet<string>,
): { rowMap: Map<string, number>; leafCount: number } {
  const rowMap = new Map<string, number>();
  const active = new Set<string>();
  const stack: Array<{ node: AutoLayoutNodeData; nextChildIndex: number }> = [
    { node: root, nextChildIndex: 0 },
  ];
  let nextLeafRow = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const current = frame.node;
    const currentKey = current.key;
    active.add(currentKey);

    const children = (childrenMap.get(currentKey) ?? []).filter(child => allowedNodeKeys.has(child.key));

    if (children.length === 0) {
      if (!rowMap.has(currentKey)) {
        rowMap.set(currentKey, nextLeafRow);
        nextLeafRow += 1;
      }
      active.delete(currentKey);
      stack.pop();
      continue;
    }

    if (frame.nextChildIndex < children.length) {
      const child = children[frame.nextChildIndex];
      frame.nextChildIndex += 1;

      if (rowMap.has(child.key) || active.has(child.key)) {
        continue;
      }

      stack.push({ node: child, nextChildIndex: 0 });
      continue;
    }

    const childRows = children
      .map(child => rowMap.get(child.key))
      .filter((row): row is number => row !== undefined);

    if (childRows.length === 0) {
      rowMap.set(currentKey, nextLeafRow);
      nextLeafRow += 1;
    } else {
      const averageRow = childRows.reduce((sum, row) => sum + row, 0) / childRows.length;
      rowMap.set(currentKey, averageRow);
    }

    active.delete(currentKey);
    stack.pop();
  }

  return {
    rowMap,
    leafCount: Math.max(nextLeafRow, 1),
  };
}

function buildFamilyBlocks(
  assignedNodes: readonly AutoLayoutNodeData[],
  parentMap: Map<string, string>,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
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
    const { rowMap: localRowMap, leafCount } = buildFamilyLocalRows(root, childrenMap, familyNodeKeys);
    const localRows = familyNodes
      .map(node => localRowMap.get(node.key))
      .filter((row): row is number => row !== undefined);

    const stageDensityMap = new Map<number, number>();
    familyNodes.forEach(node => {
      if (!isAssignedLayoutNode(node)) {
        return;
      }

      stageDensityMap.set(node.stage, (stageDensityMap.get(node.stage) ?? 0) + 1);
    });

    const minRow = localRows.length > 0 ? Math.min(...localRows) : 0;
    const maxRow = localRows.length > 0 ? Math.max(...localRows) : 0;

    blocks.push({
      rootKey: root.key,
      nodes: familyNodes,
      nodeKeys: familyNodeKeys,
      localRowMap,
      minRow,
      maxRow,
      maxStageDensity: Math.max(...Array.from(stageDensityMap.values()), 1),
      leafCount,
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
 * 家族块按跨树连接贪心重排，将强关联家族放置到相邻位置。
 *
 * 【商用级优化 2026-04-16】原实现按根 rank 静态排序，若两个家族之间存在
 * 跨树连接，图上会表现为长跨距连接线，视觉上难以追踪。本函数采用贪心
 * 最近邻策略：以"原始第一家族"（最低 rank 根）为锚点，每一步选择与
 * *当前家族* 跨树连接最强的未访问家族接续；无跨树亲和度时回退到原始
 * 家族顺序，保证无跨树场景下行为与旧版完全一致。
 *
 * 输入不变性：
 * - 不修改家族内部节点顺序与本地行号
 * - 家族数 ≤ 2 或无跨树连接时直接返回原顺序的浅拷贝
 *
 * @param familyBlocks 原始家族块（按根 rank 升序）
 * @param links 全部连线（含 cross-tree 标记）
 * @returns 重排后的家族块数组（新数组，不修改入参）
 */
function optimizeFamilyOrder(
  familyBlocks: readonly FamilyLayoutBlock[],
  links: readonly AutoLayoutLinkData[],
): FamilyLayoutBlock[] {
  if (familyBlocks.length <= 2) {
    return familyBlocks.slice();
  }

  const keyToFamily = new Map<string, number>();
  familyBlocks.forEach((block, index) => {
    block.nodes.forEach(node => keyToFamily.set(node.key, index));
  });

  const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const affinity = new Map<string, number>();
  let hasAnyAffinity = false;

  for (const link of links) {
    if (!link.isCrossTree) {
      continue;
    }
    const a = keyToFamily.get(link.from);
    const b = keyToFamily.get(link.to);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    const key = pairKey(a, b);
    affinity.set(key, (affinity.get(key) ?? 0) + 1);
    hasAnyAffinity = true;
  }

  if (!hasAnyAffinity) {
    return familyBlocks.slice();
  }

  const visited = new Set<number>([0]);
  const order: number[] = [0];

  while (order.length < familyBlocks.length) {
    const current = order[order.length - 1];
    let bestIndex = -1;
    let bestAffinity = 0;

    for (let i = 0; i < familyBlocks.length; i += 1) {
      if (visited.has(i)) {
        continue;
      }
      const aff = affinity.get(pairKey(current, i)) ?? 0;
      if (aff > bestAffinity) {
        bestAffinity = aff;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      // 无跨树关联，按原始顺序接续下一个家族
      for (let i = 0; i < familyBlocks.length; i += 1) {
        if (!visited.has(i)) {
          bestIndex = i;
          break;
        }
      }
    }

    if (bestIndex === -1) {
      // 理论不可达（while 条件已保证有未访问家族）
      break;
    }

    visited.add(bestIndex);
    order.push(bestIndex);
  }

  return order.map(index => familyBlocks[index]);
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
    crossTreeLabelGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_GAP_ROWS,
    denseFamilyGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_DENSE_FAMILY_GAP_ROWS,
    maxExtraGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_MAX_EXTRA_GAP_ROWS,
  };

  const assignedNodes = nodes.filter(isAssignedLayoutNode);
  const unassignedNodes = nodes.filter(node => !isAssignedLayoutNode(node));
  const assignedNodeMap = new Map(assignedNodes.map(node => [node.key, node]));
  const { parentMap, childrenMap } = buildParentAndChildrenMaps(assignedNodeMap, links);
  const stageNums = Array.from(new Set(assignedNodes.map(node => node.stage!))).sort((a, b) => a - b);
  const stageIndexMap = new Map(stageNums.map((stage, index) => [stage, index]));
  const naturalFamilyBlocks = buildFamilyBlocks(assignedNodes, parentMap, childrenMap);
  // 【商用级优化】按跨树连接亲和度重排家族，使关联家族尽量相邻，
  // 减少跨树连线视觉跨距、提升可读性
  const familyBlocks = optimizeFamilyOrder(naturalFamilyBlocks, links);

  const positionMap = new Map<string, NodePosition>();
  const familyIndexMap = new Map<string, number>();
  familyBlocks.forEach((block, familyIndex) => {
    block.nodes.forEach(node => familyIndexMap.set(node.key, familyIndex));
  });

  const familyGapPressures = new Array(Math.max(0, familyBlocks.length - 1)).fill(0);
  links.forEach(link => {
    if (!link.isCrossTree) {
      return;
    }

    const fromFamilyIndex = familyIndexMap.get(link.from);
    const toFamilyIndex = familyIndexMap.get(link.to);
    if (fromFamilyIndex === undefined || toFamilyIndex === undefined || fromFamilyIndex === toFamilyIndex) {
      return;
    }

    const startIndex = Math.min(fromFamilyIndex, toFamilyIndex);
    const endIndex = Math.max(fromFamilyIndex, toFamilyIndex);
    const span = endIndex - startIndex;
    const pressurePerGap = resolvedOptions.crossTreeLabelGapRows / span;

    for (let gapIndex = startIndex; gapIndex < endIndex; gapIndex += 1) {
      familyGapPressures[gapIndex] += pressurePerGap;
    }
  });

  let currentFamilyStartRow = 0;

  familyBlocks.forEach((block, familyIndex) => {
    const offsetRow = currentFamilyStartRow - block.minRow;

    block.nodes.forEach(node => {
      if (!isAssignedLayoutNode(node)) {
        return;
      }

      const stageIndex = stageIndexMap.get(node.stage);
      const localRow = block.localRowMap.get(node.key);
      if (stageIndex === undefined || localRow === undefined) {
        return;
      }

      positionMap.set(node.key, {
        key: node.key,
        x: stageIndex * resolvedOptions.layerSpacing,
        y: (offsetRow + localRow) * resolvedOptions.columnSpacing,
      });
    });

    const blockMaxRow = offsetRow + block.maxRow;
    const nextBlock = familyBlocks[familyIndex + 1];
    if (!nextBlock) {
      return;
    }

    const densityPressure = Math.min(
      0.10,
      (Math.max(block.maxStageDensity, nextBlock.maxStageDensity) - 1) * resolvedOptions.denseFamilyGapRows,
    );
    // 跨树链接压力使用 sqrt 衰减，多条链接边际递减，避免间距暴涨
    const rawCrossTree = familyGapPressures[familyIndex] ?? 0;
    const crossTreePressure = rawCrossTree > 0
      ? Math.min(0.20, Math.sqrt(rawCrossTree) * 0.30)
      : 0;
    const leafPressure = Math.min(
      0.08,
      Math.max(block.leafCount, nextBlock.leafCount, 1) > 2
        ? (Math.max(block.leafCount, nextBlock.leafCount) - 2) * 0.02
        : 0,
    );

    // 总额外间距受硬上限约束，保持视觉节奏一致
    const totalExtraGap = Math.min(
      resolvedOptions.maxExtraGapRows,
      resolvedOptions.familyGapRows + densityPressure + crossTreePressure + leafPressure,
    );

    currentFamilyStartRow = blockMaxRow + 1 + totalExtraGap;
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
