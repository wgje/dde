import { LAYOUT_CONFIG } from '../../../../config';
import {
  buildAdaptiveStageXMap,
  buildCrossTreeRelationHints,
  buildParentAndChildrenMaps,
  buildSubtreeLayoutMetrics,
  compareLayoutNodes,
  compareRootNodes,
  computeSiblingGapRows,
  computeUnassignedColumnX,
  getStagePairKey,
  isAssignedLayoutNode,
  optimizeSiblingOrder,
  shiftLocalRowsAfterThreshold,
  type AutoLayoutLinkData,
  type AutoLayoutNodeData,
  type FamilyBlockLayoutContext,
  type FamilyBlockPlacementContext,
  type FamilyCongestionMaps,
  type FamilyGapPressureContext,
  type FamilyLayoutBlock,
  type LayoutOptions,
  type LocalRowRange,
  type NodeRelationHints,
  type NodePosition,
  type ResolvedAutoLayoutOptions,
  type SubtreeLayoutMetrics,
} from './flow-layout-auto-layout-core.helpers';
import { optimizeFamilyOrder } from './flow-layout-family-order.helpers';

export type { AutoLayoutLinkData, AutoLayoutNodeData, LayoutOptions, NodePosition } from './flow-layout-auto-layout-core.helpers';
function buildFamilyLocalRows(
  root: AutoLayoutNodeData,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  allowedNodeKeys: ReadonlySet<string>,
  subtreeMetrics: Map<string, SubtreeLayoutMetrics>,
  resolvedOptions: ResolvedAutoLayoutOptions,
): { rowMap: Map<string, number>; leafCount: number } {
  const rowMap = new Map<string, number>();
  const subtreeRangeMap = new Map<string, LocalRowRange>();
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
      nextLeafRow = assignLeafLocalRow(currentKey, rowMap, subtreeRangeMap, nextLeafRow);
      active.delete(currentKey);
      stack.pop();
      continue;
    }

    if (frame.nextChildIndex < children.length) {
      pushNextFamilyChild(frame, children, rowMap, active, stack);
      continue;
    }

    // 中文注释：为复杂兄弟子树插入额外留白，让跨树关联和多父节点不要挤在同一条视觉带里。
    nextLeafRow += applySiblingLocalRowGaps(children, rowMap, subtreeRangeMap, subtreeMetrics, resolvedOptions);
    nextLeafRow = assignInternalLocalRow(currentKey, children, rowMap, subtreeRangeMap, nextLeafRow);

    active.delete(currentKey);
    stack.pop();
  }

  return {
    rowMap,
    leafCount: Math.max(nextLeafRow, 1),
  };
}

function assignLeafLocalRow(
  key: string,
  rowMap: Map<string, number>,
  subtreeRangeMap: Map<string, LocalRowRange>,
  nextLeafRow: number,
): number {
  if (rowMap.has(key)) return nextLeafRow;
  rowMap.set(key, nextLeafRow);
  subtreeRangeMap.set(key, { min: nextLeafRow, max: nextLeafRow });
  return nextLeafRow + 1;
}

function pushNextFamilyChild(
  frame: { node: AutoLayoutNodeData; nextChildIndex: number },
  children: AutoLayoutNodeData[],
  rowMap: Map<string, number>,
  active: Set<string>,
  stack: Array<{ node: AutoLayoutNodeData; nextChildIndex: number }>,
): void {
  const child = children[frame.nextChildIndex];
  frame.nextChildIndex += 1;
  if (rowMap.has(child.key) || active.has(child.key)) return;
  stack.push({ node: child, nextChildIndex: 0 });
}

function applySiblingLocalRowGaps(
  children: AutoLayoutNodeData[],
  rowMap: Map<string, number>,
  subtreeRangeMap: Map<string, LocalRowRange>,
  subtreeMetrics: Map<string, SubtreeLayoutMetrics>,
  resolvedOptions: ResolvedAutoLayoutOptions,
): number {
  let insertedRows = 0;
  for (let childIndex = 0; childIndex < children.length - 1; childIndex += 1) {
    const leftChild = children[childIndex];
    const rightChild = children[childIndex + 1];
    const leftRange = subtreeRangeMap.get(leftChild.key);
    if (!leftRange) continue;

    const siblingGapRows = computeSiblingGapRows(
      subtreeMetrics.get(leftChild.key),
      subtreeMetrics.get(rightChild.key),
      resolvedOptions,
    );
    if (siblingGapRows <= 0) continue;

    shiftLocalRowsAfterThreshold(rowMap, subtreeRangeMap, leftRange.max, siblingGapRows);
    insertedRows += siblingGapRows;
  }
  return insertedRows;
}

function assignInternalLocalRow(
  key: string,
  children: AutoLayoutNodeData[],
  rowMap: Map<string, number>,
  subtreeRangeMap: Map<string, LocalRowRange>,
  nextLeafRow: number,
): number {
  const childRows = children
    .map(child => rowMap.get(child.key))
    .filter((row): row is number => row !== undefined);

  if (childRows.length === 0) {
    rowMap.set(key, nextLeafRow);
    nextLeafRow += 1;
  } else {
    rowMap.set(key, childRows.reduce((sum, row) => sum + row, 0) / childRows.length);
  }

  updateSubtreeLocalRowRange(key, children, rowMap, subtreeRangeMap, nextLeafRow);
  return nextLeafRow;
}

function updateSubtreeLocalRowRange(
  key: string,
  children: AutoLayoutNodeData[],
  rowMap: Map<string, number>,
  subtreeRangeMap: Map<string, LocalRowRange>,
  fallbackRow: number,
): void {
  const firstChildRange = subtreeRangeMap.get(children[0].key);
  const lastChildRange = subtreeRangeMap.get(children[children.length - 1].key);
  const currentRow = rowMap.get(key) ?? fallbackRow;
  subtreeRangeMap.set(key, {
    min: firstChildRange?.min ?? currentRow,
    max: lastChildRange?.max ?? currentRow,
  });
}

function buildFamilyBlocks(
  assignedNodes: readonly AutoLayoutNodeData[],
  parentMap: Map<string, string>,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  relationHints: NodeRelationHints,
  parentCandidateCountMap: Map<string, number>,
  resolvedOptions: ResolvedAutoLayoutOptions,
  /** 【2026-04-22】每个节点承担的阶段对拥挤度（所有出/入跨树链接所在
   *  阶段对总链接数之和），用于把关联块堆叠风险从节点一路累积到兄弟子树。 */
  nodeCongestionLoad: ReadonlyMap<string, number>,
): FamilyLayoutBlock[] {
  const naturalRoots = assignedNodes
    .filter(node => {
      const parentKey = parentMap.get(node.key);
      return !parentKey;
    })
    .sort(compareRootNodes);

  const visited = new Set<string>();
  const blocks: FamilyLayoutBlock[] = [];

  naturalRoots.forEach(root => {
    blocks.push(buildFamilyBlock(
      root,
      childrenMap,
      relationHints,
      parentCandidateCountMap,
      resolvedOptions,
      nodeCongestionLoad,
      visited,
    ));
  });

  assignedNodes
    .filter(node => !visited.has(node.key))
    .sort(compareRootNodes)
    .forEach(root => {
      blocks.push(buildFamilyBlock(
        root,
        childrenMap,
        relationHints,
        parentCandidateCountMap,
        resolvedOptions,
        nodeCongestionLoad,
        visited,
      ));
    });

  return blocks;
}

function buildFamilyBlock(
  root: AutoLayoutNodeData,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  relationHints: NodeRelationHints,
  parentCandidateCountMap: Map<string, number>,
  resolvedOptions: ResolvedAutoLayoutOptions,
  nodeCongestionLoad: ReadonlyMap<string, number>,
  visited: Set<string>,
): FamilyLayoutBlock {
  const familyNodes = collectFamilyNodes(root, childrenMap, visited);
  const familyNodeKeys = new Set(familyNodes.map(node => node.key));
  const subtreeMetrics = buildSubtreeLayoutMetrics(
    root,
    childrenMap,
    familyNodeKeys,
    relationHints,
    parentCandidateCountMap,
    nodeCongestionLoad,
  );
  optimizeSiblingOrder(root, childrenMap, familyNodeKeys, subtreeMetrics);
  const { rowMap: localRowMap, leafCount } = buildFamilyLocalRows(
    root,
    childrenMap,
    familyNodeKeys,
    subtreeMetrics,
    resolvedOptions,
  );
  const localRows = familyNodes
    .map(node => localRowMap.get(node.key))
    .filter((row): row is number => row !== undefined);
  const stageDensityMap = buildFamilyStageDensityMap(familyNodes);

  return {
    rootKey: root.key,
    nodes: familyNodes,
    nodeKeys: familyNodeKeys,
    localRowMap,
    minRow: localRows.length > 0 ? Math.min(...localRows) : 0,
    maxRow: localRows.length > 0 ? Math.max(...localRows) : 0,
    maxStageDensity: Math.max(...Array.from(stageDensityMap.values()), 1),
    leafCount,
  };
}

function collectFamilyNodes(
  root: AutoLayoutNodeData,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  visited: Set<string>,
): AutoLayoutNodeData[] {
  const familyNodes: AutoLayoutNodeData[] = [];
  const stack: AutoLayoutNodeData[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.key)) continue;

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

  return familyNodes;
}

function buildFamilyStageDensityMap(familyNodes: readonly AutoLayoutNodeData[]): Map<number, number> {
  const stageDensityMap = new Map<number, number>();
  familyNodes.forEach(node => {
    if (isAssignedLayoutNode(node)) {
      stageDensityMap.set(node.stage, (stageDensityMap.get(node.stage) ?? 0) + 1);
    }
  });
  return stageDensityMap;
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
  const context = buildFamilyBlockLayoutContext(nodes, links, options);
  const stagePairCrossTreeCount = buildStagePairCrossTreeCount(links, context.allNodeMap);
  const congestionMaps: FamilyCongestionMaps = {
    stagePairCrossTreeCount,
    nodeCongestionLoad: buildNodeCongestionLoad(links, context.allNodeMap, stagePairCrossTreeCount),
  };
  const naturalFamilyBlocks = buildFamilyBlocks(
    context.assignedNodes,
    context.parentMap,
    context.childrenMap,
    context.relationHints,
    context.parentCandidateCountMap,
    context.resolvedOptions,
    congestionMaps.nodeCongestionLoad,
  );
  // 【商用级优化】按跨树连接亲和度重排家族，使关联家族尽量相邻，
  // 减少跨树连线视觉跨距、提升可读性
  const familyBlocks = optimizeFamilyOrder(naturalFamilyBlocks, links, context.resolvedOptions);

  const positionMap = new Map<string, NodePosition>();
  placeAssignedFamilyBlocks(positionMap, familyBlocks, links, context, congestionMaps.stagePairCrossTreeCount);
  placeUnassignedNodes(positionMap, nodes, links, context);

  return nodes
    .map(node => positionMap.get(node.key))
    .filter((position): position is NodePosition => position !== undefined);
}

function buildFamilyBlockLayoutContext(
  nodes: readonly AutoLayoutNodeData[],
  links: readonly AutoLayoutLinkData[],
  options: LayoutOptions,
): FamilyBlockLayoutContext {
  const resolvedOptions = resolveAutoLayoutOptions(options);
  const assignedNodes = nodes.filter(isAssignedLayoutNode);
  const unassignedNodes = nodes.filter(node => !isAssignedLayoutNode(node));
  const allNodeMap = new Map(nodes.map(node => [node.key, node]));
  const assignedNodeMap = new Map(assignedNodes.map(node => [node.key, node]));
  const stageNums = Array.from(new Set(assignedNodes.map(node => node.stage))).sort((a, b) => a - b);
  const relationHints = buildCrossTreeRelationHints(
    allNodeMap,
    links,
    stageNums.length > 0 ? stageNums[stageNums.length - 1] + 1 : 1,
  );
  const { parentMap, childrenMap, parentCandidateCountMap } = buildParentAndChildrenMaps(assignedNodeMap, links);
  const stageIndexMap = new Map(stageNums.map((stage, index) => [stage, index]));
  const stageXMap = buildAdaptiveStageXMap(
    assignedNodes,
    links,
    stageNums,
    stageIndexMap,
    resolvedOptions,
    parentCandidateCountMap,
  );

  return {
    resolvedOptions,
    assignedNodes,
    unassignedNodes,
    allNodeMap,
    assignedNodeMap,
    stageNums,
    relationHints,
    parentMap,
    childrenMap,
    parentCandidateCountMap,
    stageXMap,
  };
}

function resolveAutoLayoutOptions(options: LayoutOptions): ResolvedAutoLayoutOptions {
  return {
    layerSpacing: options.layerSpacing ?? LAYOUT_CONFIG.STAGE_SPACING,
    columnSpacing: options.columnSpacing ?? LAYOUT_CONFIG.ROW_SPACING,
    familyGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_FAMILY_GAP_ROWS,
    siblingGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_SIBLING_GAP_ROWS,
    crossTreeLabelGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_GAP_ROWS,
    relatedSiblingGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_RELATED_SIBLING_GAP_ROWS,
    denseFamilyGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_DENSE_FAMILY_GAP_ROWS,
    multiParentSiblingGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_MULTI_PARENT_SIBLING_GAP_ROWS,
    maxExtraGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_MAX_EXTRA_GAP_ROWS,
    maxSiblingGapRows: LAYOUT_CONFIG.AUTO_LAYOUT_MAX_SIBLING_GAP_ROWS,
    stageDensityGapFactor: LAYOUT_CONFIG.AUTO_LAYOUT_STAGE_DENSITY_GAP_FACTOR,
    stageLinkGapFactor: LAYOUT_CONFIG.AUTO_LAYOUT_STAGE_LINK_GAP_FACTOR,
    stageCrossTreeGapFactor: LAYOUT_CONFIG.AUTO_LAYOUT_STAGE_CROSS_TREE_GAP_FACTOR,
    stageMultiParentGapFactor: LAYOUT_CONFIG.AUTO_LAYOUT_STAGE_MULTI_PARENT_GAP_FACTOR,
    maxStageExtraFactor: LAYOUT_CONFIG.AUTO_LAYOUT_MAX_STAGE_EXTRA_FACTOR,
    twoOptMaxPasses: LAYOUT_CONFIG.AUTO_LAYOUT_TWO_OPT_MAX_PASSES,
    twoOptImprovementEpsilon: LAYOUT_CONFIG.AUTO_LAYOUT_TWO_OPT_IMPROVEMENT_EPSILON,
  };
}

function buildStagePairCrossTreeCount(
  links: readonly AutoLayoutLinkData[],
  allNodeMap: ReadonlyMap<string, AutoLayoutNodeData>,
): Map<string, number> {
  const stagePairCrossTreeCount = new Map<string, number>();
  links.forEach(link => {
    if (!link.isCrossTree) return;
    const fromNode = allNodeMap.get(link.from);
    const toNode = allNodeMap.get(link.to);
    if (!fromNode || !toNode) return;
    const pairKey = getStagePairKey(fromNode.stage, toNode.stage);
    if (!pairKey) return;
    stagePairCrossTreeCount.set(pairKey, (stagePairCrossTreeCount.get(pairKey) ?? 0) + 1);
  });
  return stagePairCrossTreeCount;
}

function buildNodeCongestionLoad(
  links: readonly AutoLayoutLinkData[],
  allNodeMap: ReadonlyMap<string, AutoLayoutNodeData>,
  stagePairCrossTreeCount: ReadonlyMap<string, number>,
): Map<string, number> {
  const nodeCongestionLoad = new Map<string, number>();
  links.forEach(link => {
    if (!link.isCrossTree) return;
    const fromNode = allNodeMap.get(link.from);
    const toNode = allNodeMap.get(link.to);
    if (!fromNode || !toNode) return;
    const pairKey = getStagePairKey(fromNode.stage, toNode.stage);
    if (!pairKey) return;
    const congestion = stagePairCrossTreeCount.get(pairKey) ?? 1;
    nodeCongestionLoad.set(link.from, (nodeCongestionLoad.get(link.from) ?? 0) + congestion);
    nodeCongestionLoad.set(link.to, (nodeCongestionLoad.get(link.to) ?? 0) + congestion);
  });
  return nodeCongestionLoad;
}

function placeAssignedFamilyBlocks(
  positionMap: Map<string, NodePosition>,
  familyBlocks: readonly FamilyLayoutBlock[],
  links: readonly AutoLayoutLinkData[],
  context: FamilyBlockLayoutContext,
  stagePairCrossTreeCount: ReadonlyMap<string, number>,
): void {
  const familyGapPressures = buildFamilyGapPressures(familyBlocks, links, context, stagePairCrossTreeCount);
  const placementContext: FamilyBlockPlacementContext = {
    stageXMap: context.stageXMap,
    familyGapPressures,
    resolvedOptions: context.resolvedOptions,
    positionMap,
  };
  let currentFamilyStartRow = 0;

  familyBlocks.forEach((block, familyIndex) => {
    const offsetRow = currentFamilyStartRow - block.minRow;
    placeFamilyBlockNodes(block, offsetRow, placementContext);
    const nextBlock = familyBlocks[familyIndex + 1];
    if (!nextBlock) return;
    currentFamilyStartRow = offsetRow + block.maxRow + 1 + computeFamilyExtraGap(
      block,
      nextBlock,
      placementContext.familyGapPressures[familyIndex] ?? 0,
      placementContext.resolvedOptions,
    );
  });
}

function placeFamilyBlockNodes(
  block: FamilyLayoutBlock,
  offsetRow: number,
  context: FamilyBlockPlacementContext,
): void {
  block.nodes.forEach(node => {
    if (!isAssignedLayoutNode(node)) return;
    const localRow = block.localRowMap.get(node.key);
    const stageX = context.stageXMap.get(node.stage);
    if (stageX === undefined || localRow === undefined) return;
    context.positionMap.set(node.key, {
      key: node.key,
      x: stageX,
      y: (offsetRow + localRow) * context.resolvedOptions.columnSpacing,
    });
  });
}

function buildFamilyGapPressures(
  familyBlocks: readonly FamilyLayoutBlock[],
  links: readonly AutoLayoutLinkData[],
  context: FamilyBlockLayoutContext,
  stagePairCrossTreeCount: ReadonlyMap<string, number>,
): number[] {
  const familyIndexMap = new Map<string, number>();
  familyBlocks.forEach((block, familyIndex) => {
    block.nodes.forEach(node => familyIndexMap.set(node.key, familyIndex));
  });
  const pressureContext: FamilyGapPressureContext = {
    allNodeMap: context.allNodeMap,
    familyIndexMap,
    stagePairCrossTreeCount,
    resolvedOptions: context.resolvedOptions,
  };
  const familyGapPressures = new Array(Math.max(0, familyBlocks.length - 1)).fill(0);

  links.forEach(link => {
    if (!link.isCrossTree) return;
    const fromFamilyIndex = pressureContext.familyIndexMap.get(link.from);
    const toFamilyIndex = pressureContext.familyIndexMap.get(link.to);
    if (fromFamilyIndex === undefined || toFamilyIndex === undefined || fromFamilyIndex === toFamilyIndex) return;
    accumulateFamilyGapPressure(
      familyGapPressures,
      link,
      fromFamilyIndex,
      toFamilyIndex,
      pressureContext,
    );
  });

  return familyGapPressures;
}

function accumulateFamilyGapPressure(
  familyGapPressures: number[],
  link: AutoLayoutLinkData,
  fromFamilyIndex: number,
  toFamilyIndex: number,
  context: FamilyGapPressureContext,
): void {
  const startIndex = Math.min(fromFamilyIndex, toFamilyIndex);
  const endIndex = Math.max(fromFamilyIndex, toFamilyIndex);
  const fromNode = context.allNodeMap.get(link.from);
  const toNode = context.allNodeMap.get(link.to);
  const pairKey = fromNode && toNode ? getStagePairKey(fromNode.stage, toNode.stage) : null;
  const congestion = pairKey ? (context.stagePairCrossTreeCount.get(pairKey) ?? 1) : 1;
  const pressurePerGap = (context.resolvedOptions.crossTreeLabelGapRows * Math.sqrt(Math.max(1, congestion)))
    / (endIndex - startIndex);

  for (let gapIndex = startIndex; gapIndex < endIndex; gapIndex += 1) {
    familyGapPressures[gapIndex] += pressurePerGap;
  }
}

function computeFamilyExtraGap(
  block: FamilyLayoutBlock,
  nextBlock: FamilyLayoutBlock,
  rawCrossTree: number,
  resolvedOptions: ResolvedAutoLayoutOptions,
): number {
  const densityPressure = Math.min(
    0.10,
    (Math.max(block.maxStageDensity, nextBlock.maxStageDensity) - 1) * resolvedOptions.denseFamilyGapRows,
  );
  const crossTreePressure = rawCrossTree > 0 ? Math.min(0.55, Math.sqrt(rawCrossTree) * 0.45) : 0;
  const leafPressure = Math.min(
    0.08,
    Math.max(block.leafCount, nextBlock.leafCount, 1) > 2
      ? (Math.max(block.leafCount, nextBlock.leafCount) - 2) * 0.02
      : 0,
  );
  return Math.min(
    resolvedOptions.maxExtraGapRows,
    resolvedOptions.familyGapRows + densityPressure + crossTreePressure + leafPressure,
  );
}

function placeUnassignedNodes(
  positionMap: Map<string, NodePosition>,
  nodes: readonly AutoLayoutNodeData[],
  links: readonly AutoLayoutLinkData[],
  context: FamilyBlockLayoutContext,
): void {
  const unassignedX = context.stageNums.length > 0
    ? computeUnassignedColumnX(
        context.allNodeMap,
        nodes,
        links,
        context.stageNums,
        context.stageXMap,
        context.resolvedOptions,
      )
    : 0;

  context.unassignedNodes
    .slice()
    .sort(compareLayoutNodes)
    .forEach((node, nodeIndex) => {
      positionMap.set(node.key, {
        key: node.key,
        x: unassignedX,
        y: nodeIndex * context.resolvedOptions.columnSpacing,
      });
    });
}
