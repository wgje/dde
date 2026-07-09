import { LAYOUT_CONFIG } from '../../../../config';

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
 *
 * 【补丁 B 2026-04-23】为后续拆分 rank 语义预留字段：
 *  - `rank`        兼顾现有行为（tie-break）
 *  - `preferredOrder` 同 stage 内希望的软约束顺序，未传时 fallback 到 rank
 *  - `priority`    仅用于最后的稳定 tie-break，未传时视为 0
 * compareLayoutNodes 使用 preferredOrder -> rank -> priority -> key 的稳定顺序，
 * 让约束系统可以覆盖同 stage 内的软排序，同时保留旧 rank fallback。
 */
export interface AutoLayoutNodeData {
  key: string;
  stage: number | null;
  rank?: number;
  /** 软约束：同 stage 内的偏好顺序，未传时 fallback 到 rank。 */
  preferredOrder?: number;
  /** 可选优先级，用于多目标 tie-break。 */
  priority?: number;
}

/**
 * 自动布局输入连线
 */
export interface AutoLayoutLinkData {
  from: string;
  to: string;
  isCrossTree?: boolean;
}

export interface ResolvedAutoLayoutOptions {
  layerSpacing: number;
  columnSpacing: number;
  familyGapRows: number;
  siblingGapRows: number;
  crossTreeLabelGapRows: number;
  relatedSiblingGapRows: number;
  denseFamilyGapRows: number;
  multiParentSiblingGapRows: number;
  maxExtraGapRows: number;
  maxSiblingGapRows: number;
  stageDensityGapFactor: number;
  stageLinkGapFactor: number;
  stageCrossTreeGapFactor: number;
  stageMultiParentGapFactor: number;
  maxStageExtraFactor: number;
  twoOptMaxPasses: number;
  twoOptImprovementEpsilon: number;
}

export interface FamilyLayoutBlock {
  rootKey: string;
  nodes: AutoLayoutNodeData[];
  nodeKeys: ReadonlySet<string>;
  localRowMap: Map<string, number>;
  minRow: number;
  maxRow: number;
  maxStageDensity: number;
  leafCount: number;
}

export interface NodeRelationHints {
  relationTargetsByNode: Map<string, RelationTargetHint[]>;
}

export interface SubtreeLayoutMetrics {
  leafCount: number;
  relationCount: number;
  relationCenter: number | null;
  multiParentLoad: number;
  /**
   * 【关系网优化 2026-04-22】子树中跨树链接"阶段对拥挤度"累计：
   * 对子树内每条跨树链接，把它所在阶段对的总跨树链接数求和得到。
   * 用于在 computeSiblingGapRows 中识别"关联块会堆叠"的子树对，
   * 给它们之间加额外纵向留白。
   */
  congestedRelationLoad: number;
}

export interface LocalRowRange {
  min: number;
  max: number;
}

export interface FamilyAffinityPair {
  a: number;
  b: number;
  weight: number;
}

export interface FamilyBlockLayoutContext {
  resolvedOptions: ResolvedAutoLayoutOptions;
  assignedNodes: Array<AutoLayoutNodeData & { stage: number }>;
  unassignedNodes: AutoLayoutNodeData[];
  allNodeMap: Map<string, AutoLayoutNodeData>;
  assignedNodeMap: Map<string, AutoLayoutNodeData>;
  stageNums: number[];
  relationHints: NodeRelationHints;
  parentMap: Map<string, string>;
  childrenMap: Map<string, AutoLayoutNodeData[]>;
  parentCandidateCountMap: Map<string, number>;
  stageXMap: Map<number, number>;
}

export interface FamilyCongestionMaps {
  stagePairCrossTreeCount: Map<string, number>;
  nodeCongestionLoad: Map<string, number>;
}

export interface FamilyBlockPlacementContext {
  stageXMap: ReadonlyMap<number, number>;
  familyGapPressures: readonly number[];
  resolvedOptions: ResolvedAutoLayoutOptions;
  positionMap: Map<string, NodePosition>;
}

export interface FamilyGapPressureContext {
  allNodeMap: ReadonlyMap<string, AutoLayoutNodeData>;
  familyIndexMap: ReadonlyMap<string, number>;
  stagePairCrossTreeCount: ReadonlyMap<string, number>;
  resolvedOptions: ResolvedAutoLayoutOptions;
}

export interface StageBoundaryPressureMaps {
  stageNodeCounts: number[];
  stageBoundaryLinkCounts: number[];
  stageBoundaryCrossTreeCounts: number[];
  stageBoundaryMultiParentCounts: number[];
}

export interface RelationTargetHint {
  targetKey: string;
  score: number;
}

export const MIN_RELATION_STAGE_SCORE_MULTIPLIER = 100_000;

/**
 * 【关系网优化 2026-04-22】生成 (fromStage, toStage) 无向阶段对键，用于
 * 统计同一列跨树链接的密度。null/相同 stage 的链接没有阶段列，返回 null。
 */
export function getStagePairKey(fromStage: number | null, toStage: number | null): string | null {
  if (fromStage == null || toStage == null || fromStage === toStage) {
    return null;
  }
  return fromStage < toStage ? `${fromStage}->${toStage}` : `${toStage}->${fromStage}`;
}

export function isAssignedLayoutNode(node: AutoLayoutNodeData): node is AutoLayoutNodeData & { stage: number } {
  return node.stage != null && node.stage > 0;
}

export function compareLayoutNodes(a: AutoLayoutNodeData, b: AutoLayoutNodeData): number {
  return (a.preferredOrder ?? a.rank ?? 0) - (b.preferredOrder ?? b.rank ?? 0)
    || (a.priority ?? 0) - (b.priority ?? 0)
    || a.key.localeCompare(b.key);
}

export function compareRootNodes(a: AutoLayoutNodeData, b: AutoLayoutNodeData): number {
  return (a.stage ?? Number.MAX_SAFE_INTEGER) - (b.stage ?? Number.MAX_SAFE_INTEGER)
    || compareLayoutNodes(a, b);
}

export function computeRelationStageScoreMultiplier(nodes: Iterable<AutoLayoutNodeData>): number {
  let minRank = 0;
  let maxRank = 0;

  for (const node of nodes) {
    const rank = node.rank ?? 0;
    if (rank < minRank) {
      minRank = rank;
    }
    if (rank > maxRank) {
      maxRank = rank;
    }
  }

  return Math.max(MIN_RELATION_STAGE_SCORE_MULTIPLIER, (maxRank - minRank) + 1);
}

export function buildCrossTreeRelationHints(
  nodeMap: Map<string, AutoLayoutNodeData>,
  links: readonly AutoLayoutLinkData[],
  fallbackExternalStage: number,
): NodeRelationHints {
  const relationTargetsByNode = new Map<string, RelationTargetHint[]>();
  const relationStageScoreMultiplier = computeRelationStageScoreMultiplier(nodeMap.values());

  const addRelationHint = (sourceKey: string, target: AutoLayoutNodeData): void => {
    const targetStage = isAssignedLayoutNode(target)
      ? target.stage
      : fallbackExternalStage;
    const targets = relationTargetsByNode.get(sourceKey) ?? [];
    targets.push({
      targetKey: target.key,
      score: targetStage * relationStageScoreMultiplier + (target.rank ?? 0),
    });
    relationTargetsByNode.set(sourceKey, targets);
  };

  for (const link of links) {
    if (!link.isCrossTree) {
      continue;
    }

    const fromNode = nodeMap.get(link.from);
    const toNode = nodeMap.get(link.to);
    if (!fromNode || !toNode) {
      continue;
    }

    addRelationHint(fromNode.key, toNode);
    addRelationHint(toNode.key, fromNode);
  }
  return {
    relationTargetsByNode,
  };
}

export function buildParentAndChildrenMaps(
  assignedNodeMap: Map<string, AutoLayoutNodeData>,
  links: readonly AutoLayoutLinkData[],
): {
  parentMap: Map<string, string>;
  childrenMap: Map<string, AutoLayoutNodeData[]>;
  parentCandidateCountMap: Map<string, number>;
} {
  // 【鲁棒性 2026-04-16】多父场景下先收集所有候选父，再按"阶段差最小 + rank 最大"
  // 择优，而非原先的"先到先得"，避免链路顺序扰动布局。单父场景行为保持不变。
  const candidateParents = collectParentCandidates(assignedNodeMap, links);
  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, AutoLayoutNodeData[]>();
  const parentCandidateCountMap = new Map<string, number>();

  for (const [childKey, parents] of candidateParents) {
    const child = assignedNodeMap.get(childKey);
    if (!child || !isAssignedLayoutNode(child) || parents.length === 0) {
      continue;
    }

    parentCandidateCountMap.set(childKey, parents.length);

    const bestParent = selectBestParentForChild(child, parents);
    parentMap.set(child.key, bestParent.key);
    const siblings = childrenMap.get(bestParent.key) ?? [];
    siblings.push(child);
    childrenMap.set(bestParent.key, siblings);
  }

  for (const siblings of childrenMap.values()) {
    siblings.sort(compareLayoutNodes);
  }

  return { parentMap, childrenMap, parentCandidateCountMap };
}

export function collectParentCandidates(
  assignedNodeMap: Map<string, AutoLayoutNodeData>,
  links: readonly AutoLayoutLinkData[],
): Map<string, AutoLayoutNodeData[]> {
  const candidateParents = new Map<string, AutoLayoutNodeData[]>();
  for (const link of links) {
    if (link.isCrossTree) continue;
    const parent = assignedNodeMap.get(link.from);
    const child = assignedNodeMap.get(link.to);
    if (!parent || !child) continue;
    const list = candidateParents.get(child.key) ?? [];
    list.push(parent);
    candidateParents.set(child.key, list);
  }
  return candidateParents;
}

export function selectBestParentForChild(
  child: AutoLayoutNodeData & { stage: number },
  parents: AutoLayoutNodeData[],
): AutoLayoutNodeData {
  let bestParent = parents[0];
  let bestStageDiff = isAssignedLayoutNode(bestParent)
    ? Math.abs(child.stage - bestParent.stage)
    : Number.MAX_SAFE_INTEGER;

  for (let i = 1; i < parents.length; i += 1) {
    const candidate = parents[i];
    if (!isAssignedLayoutNode(candidate)) continue;
    const diff = Math.abs(child.stage - candidate.stage);
    if (diff < bestStageDiff || (diff === bestStageDiff && (candidate.rank ?? 0) > (bestParent.rank ?? 0))) {
      bestParent = candidate;
      bestStageDiff = diff;
    }
  }

  return bestParent;
}

export function buildSubtreeLayoutMetrics(
  root: AutoLayoutNodeData,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  allowedNodeKeys: ReadonlySet<string>,
  relationHints: NodeRelationHints,
  parentCandidateCountMap: Map<string, number>,
  /** 【2026-04-22】节点自身跨树链接承担的阶段对拥挤度（由调用方预先按
   *  "该节点每条跨树链接所在阶段对的总链接数"求和后传入）。无则视为 0。 */
  nodeCongestionLoad: ReadonlyMap<string, number>,
): Map<string, SubtreeLayoutMetrics> {
  const metrics = new Map<string, SubtreeLayoutMetrics>();
  const stack: Array<{ node: AutoLayoutNodeData; visited: boolean }> = [{
    node: root,
    visited: false,
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = (childrenMap.get(frame.node.key) ?? []).filter(child => allowedNodeKeys.has(child.key));

    if (!frame.visited) {
      stack.push({ node: frame.node, visited: true });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index], visited: false });
      }
      continue;
    }

    metrics.set(frame.node.key, buildNodeSubtreeMetrics(
      frame.node,
      children,
      allowedNodeKeys,
      relationHints,
      parentCandidateCountMap,
      nodeCongestionLoad,
      metrics,
    ));
  }

  return metrics;
}

export function buildNodeSubtreeMetrics(
  node: AutoLayoutNodeData,
  children: AutoLayoutNodeData[],
  allowedNodeKeys: ReadonlySet<string>,
  relationHints: NodeRelationHints,
  parentCandidateCountMap: Map<string, number>,
  nodeCongestionLoad: ReadonlyMap<string, number>,
  metrics: Map<string, SubtreeLayoutMetrics>,
): SubtreeLayoutMetrics {
  const directRelationTargets = (relationHints.relationTargetsByNode.get(node.key) ?? [])
    .filter(target => !allowedNodeKeys.has(target.targetKey));
  const directRelationCount = directRelationTargets.length;
  const directRelationCenter = directRelationCount > 0
    ? directRelationTargets.reduce((sum, target) => sum + target.score, 0) / directRelationCount
    : null;
  const accumulator = {
    leafCount: children.length === 0 ? 1 : 0,
    relationCount: directRelationCount,
    relationWeightedCenterSum: directRelationCount > 0 && directRelationCenter != null
      ? directRelationCenter * directRelationCount
      : 0,
    multiParentLoad: Math.max(0, (parentCandidateCountMap.get(node.key) ?? 1) - 1),
    congestedRelationLoad: nodeCongestionLoad.get(node.key) ?? 0,
  };

  for (const child of children) {
    accumulateChildSubtreeMetrics(accumulator, metrics.get(child.key));
  }

  return {
    leafCount: Math.max(accumulator.leafCount, 1),
    relationCount: accumulator.relationCount,
    relationCenter: accumulator.relationCount > 0
      ? accumulator.relationWeightedCenterSum / accumulator.relationCount
      : null,
    multiParentLoad: accumulator.multiParentLoad,
    congestedRelationLoad: accumulator.congestedRelationLoad,
  };
}

export function accumulateChildSubtreeMetrics(
  accumulator: {
    leafCount: number;
    relationCount: number;
    relationWeightedCenterSum: number;
    multiParentLoad: number;
    congestedRelationLoad: number;
  },
  childMetrics: SubtreeLayoutMetrics | undefined,
): void {
  if (!childMetrics) return;
  accumulator.leafCount += childMetrics.leafCount;
  accumulator.relationCount += childMetrics.relationCount;
  if (childMetrics.relationCenter != null && childMetrics.relationCount > 0) {
    accumulator.relationWeightedCenterSum += childMetrics.relationCenter * childMetrics.relationCount;
  }
  accumulator.multiParentLoad += childMetrics.multiParentLoad;
  accumulator.congestedRelationLoad += childMetrics.congestedRelationLoad;
}

export function optimizeSiblingOrder(
  root: AutoLayoutNodeData,
  childrenMap: Map<string, AutoLayoutNodeData[]>,
  allowedNodeKeys: ReadonlySet<string>,
  subtreeMetrics: Map<string, SubtreeLayoutMetrics>,
): void {
  const stack: AutoLayoutNodeData[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = (childrenMap.get(current.key) ?? []).filter(child => allowedNodeKeys.has(child.key));
    let orderedChildren = children;

    if (children.length > 1) {
      const hasSignal = children.some(child => {
        const metrics = subtreeMetrics.get(child.key);
        return (metrics?.relationCount ?? 0) > 0 || (metrics?.multiParentLoad ?? 0) > 0;
      });

      if (hasSignal) {
        orderedChildren = children.slice().sort((left, right) => {
          const leftMetrics = subtreeMetrics.get(left.key);
          const rightMetrics = subtreeMetrics.get(right.key);
          const leftCenter = leftMetrics?.relationCenter;
          const rightCenter = rightMetrics?.relationCenter;
          const bothHaveRelationCenter = leftCenter != null && rightCenter != null;

          if (bothHaveRelationCenter && Math.abs(leftCenter - rightCenter) > 1) {
            return leftCenter - rightCenter;
          }

          return compareLayoutNodes(left, right);
        });

        // 【补丁 B 2026-04-23】兼容式局部 2-opt：在 barycenter sort 之后再跑一
        // 轮相邻交换。稳定排序在 signal-less 兄弟夹在中间时可能产生满足适发比较器
        // 但全局非最优的排列。这里只接受“严格降交叉”的交换：两个兄弟子树都拥有
        // relationCenter 且 leftCenter > rightCenter + 1 时互换，不会破坏 rank 顺序
        // 下的业务语义（signal-less 兄弟从不参与交换）。
        if (LAYOUT_CONFIG.AUTO_LAYOUT_ENABLE_SIBLING_TWO_OPT && orderedChildren.length >= 2) {
          orderedChildren = refineSiblingOrderWithTwoOpt(orderedChildren, subtreeMetrics);
        }

        childrenMap.set(current.key, orderedChildren);
      }
    }

    for (let index = orderedChildren.length - 1; index >= 0; index -= 1) {
      stack.push(orderedChildren[index]);
    }
  }
}

/**
 * 【补丁 B 2026-04-23】兄弟层 2-opt adjacent swap。
 *
 * 设计原则（电球不破业务顺序）：
 *  1. 仅当两个相邻兄弟都拥有 relationCenter 且 relationCount > 0 时才考虑交换
 *  2. 只有当 leftCenter > rightCenter + 1 （严格倒序）时才互换
 *  3. signal-less 兄弟（relationCount === 0 或无 center）永不参与交换，
 *     保证业务 rank 顺序不被破坏
 *  4. 可证 non-worsening（每次交换严格减少 pairwise crossing cost），
 *     以固定通过次数 + 严格改进两道门阱保证收敛
 *
 * 实用值：稳定排序在比较器非全序时（signal 和 signal-less 混杂）可能
 * 遗留的局部倒序，本函数可以在不打破 rank 顺序的前提下修正。
 */
export function refineSiblingOrderWithTwoOpt(
  siblings: readonly AutoLayoutNodeData[],
  subtreeMetrics: Map<string, SubtreeLayoutMetrics>,
): AutoLayoutNodeData[] {
  const best = siblings.slice();
  const maxPasses = Math.max(1, best.length);
  let changed = true;
  let pass = 0;

  while (changed && pass < maxPasses) {
    changed = false;
    for (let i = 0; i < best.length - 1; i += 1) {
      const left = best[i];
      const right = best[i + 1];
      const leftMetrics = subtreeMetrics.get(left.key);
      const rightMetrics = subtreeMetrics.get(right.key);

      const leftCenter = leftMetrics?.relationCenter;
      const rightCenter = rightMetrics?.relationCenter;
      const leftCount = leftMetrics?.relationCount ?? 0;
      const rightCount = rightMetrics?.relationCount ?? 0;

      if (
        leftCenter != null &&
        rightCenter != null &&
        leftCount > 0 &&
        rightCount > 0 &&
        leftCenter > rightCenter + 1
      ) {
        best[i] = right;
        best[i + 1] = left;
        changed = true;
      }
    }
    pass += 1;
  }

  return best;
}

export function computeSiblingGapRows(
  leftMetrics: SubtreeLayoutMetrics | undefined,
  rightMetrics: SubtreeLayoutMetrics | undefined,
  resolvedOptions: ResolvedAutoLayoutOptions,
): number {
  // 【2026-04-22】关联块重叠修复：把各项压力上限同步抬高，并新增
  // "阶段对拥挤度"压力项。原上限（leaf=0.10, rel=0.10, mp=0.08）在实际
  // 项目中几乎立刻饱和，兄弟子树间几乎拿不到差异化空间。
  const maxLeafCount = Math.max(leftMetrics?.leafCount ?? 1, rightMetrics?.leafCount ?? 1);
  const leafPressure = Math.min(0.18, Math.max(0, maxLeafCount - 1) * 0.025);
  const relationLoad = (leftMetrics?.relationCount ?? 0) + (rightMetrics?.relationCount ?? 0);
  const relationPressure = relationLoad > 0
    ? Math.min(0.22, Math.sqrt(relationLoad) * resolvedOptions.relatedSiblingGapRows)
    : 0;
  const multiParentPressure = Math.min(
    0.16,
    ((leftMetrics?.multiParentLoad ?? 0) + (rightMetrics?.multiParentLoad ?? 0))
      * resolvedOptions.multiParentSiblingGapRows,
  );
  // 关联块拥挤度压力：若两兄弟子树各自的跨树链接都落在已经很拥挤的
  // 阶段列上，说明它们的关联块会在同一 Y 带附近堆叠，必须额外拉开。
  const congestionLoad = (leftMetrics?.congestedRelationLoad ?? 0)
    + (rightMetrics?.congestedRelationLoad ?? 0);
  const congestionPressure = congestionLoad > 1
    ? Math.min(0.20, Math.sqrt(congestionLoad - 1) * 0.06)
    : 0;

  return Math.min(
    resolvedOptions.maxSiblingGapRows,
    resolvedOptions.siblingGapRows
      + leafPressure
      + relationPressure
      + multiParentPressure
      + congestionPressure,
  );
}

export function shiftLocalRowsAfterThreshold(
  rowMap: Map<string, number>,
  subtreeRangeMap: Map<string, LocalRowRange>,
  threshold: number,
  delta: number,
): void {
  if (delta <= 0) {
    return;
  }

  rowMap.forEach((row, key) => {
    if (row > threshold) {
      rowMap.set(key, row + delta);
    }
  });

  subtreeRangeMap.forEach((range, key) => {
    if (range.min > threshold) {
      subtreeRangeMap.set(key, {
        min: range.min + delta,
        max: range.max + delta,
      });
    }
  });
}

export function buildAdaptiveStageXMap(
  assignedNodes: readonly AutoLayoutNodeData[],
  links: readonly AutoLayoutLinkData[],
  stageNums: readonly number[],
  stageIndexMap: Map<number, number>,
  resolvedOptions: ResolvedAutoLayoutOptions,
  parentCandidateCountMap: ReadonlyMap<string, number>,
): Map<number, number> {
  const pressureMaps = buildStageBoundaryPressureMaps(
    assignedNodes,
    links,
    stageNums,
    stageIndexMap,
    parentCandidateCountMap,
  );
  const stageXMap = new Map<number, number>();
  let currentX = 0;

  stageNums.forEach((stage, stageIndex) => {
    stageXMap.set(stage, currentX);
    if (stageIndex === stageNums.length - 1) {
      return;
    }

    currentX += computeStageBoundarySpacing(pressureMaps, stageIndex, resolvedOptions);
  });

  return stageXMap;
}

export function buildStageBoundaryPressureMaps(
  assignedNodes: readonly AutoLayoutNodeData[],
  links: readonly AutoLayoutLinkData[],
  stageNums: readonly number[],
  stageIndexMap: Map<number, number>,
  parentCandidateCountMap: ReadonlyMap<string, number>,
): StageBoundaryPressureMaps {
  const pressureMaps: StageBoundaryPressureMaps = {
    stageNodeCounts: new Array(stageNums.length).fill(0),
    stageBoundaryLinkCounts: new Array(Math.max(0, stageNums.length - 1)).fill(0),
    stageBoundaryCrossTreeCounts: new Array(Math.max(0, stageNums.length - 1)).fill(0),
    stageBoundaryMultiParentCounts: new Array(Math.max(0, stageNums.length - 1)).fill(0),
  };
  const assignedNodeMap = new Map(assignedNodes.map(node => [node.key, node]));

  assignedNodes.forEach(node => {
    const stageIndex = stageIndexMap.get(node.stage!);
    if (stageIndex !== undefined) {
      pressureMaps.stageNodeCounts[stageIndex] += 1;
    }
  });

  links.forEach(link => {
    accumulateStageBoundaryPressure(link, assignedNodeMap, stageIndexMap, parentCandidateCountMap, pressureMaps);
  });

  return pressureMaps;
}

export function accumulateStageBoundaryPressure(
  link: AutoLayoutLinkData,
  assignedNodeMap: ReadonlyMap<string, AutoLayoutNodeData>,
  stageIndexMap: ReadonlyMap<number, number>,
  parentCandidateCountMap: ReadonlyMap<string, number>,
  pressureMaps: StageBoundaryPressureMaps,
): void {
  const fromNode = assignedNodeMap.get(link.from);
  const toNode = assignedNodeMap.get(link.to);
  if (!fromNode || !toNode || !isAssignedLayoutNode(fromNode) || !isAssignedLayoutNode(toNode)) return;

  const fromStageIndex = stageIndexMap.get(fromNode.stage);
  const toStageIndex = stageIndexMap.get(toNode.stage);
  if (fromStageIndex === undefined || toStageIndex === undefined || fromStageIndex === toStageIndex) return;

  const startIndex = Math.min(fromStageIndex, toStageIndex);
  const endIndex = Math.max(fromStageIndex, toStageIndex);
  const isMultiParentMerge = !link.isCrossTree && (parentCandidateCountMap.get(toNode.key) ?? 0) >= 2;

  for (let boundaryIndex = startIndex; boundaryIndex < endIndex; boundaryIndex += 1) {
    if (link.isCrossTree) {
      pressureMaps.stageBoundaryCrossTreeCounts[boundaryIndex] += 1;
    } else {
      pressureMaps.stageBoundaryLinkCounts[boundaryIndex] += 1;
    }
    if (isMultiParentMerge) {
      pressureMaps.stageBoundaryMultiParentCounts[boundaryIndex] += 1;
    }
  }
}

export function computeStageBoundarySpacing(
  pressureMaps: StageBoundaryPressureMaps,
  stageIndex: number,
  resolvedOptions: ResolvedAutoLayoutOptions,
): number {
  const densityPressure = Math.max(
    0,
    Math.max(pressureMaps.stageNodeCounts[stageIndex], pressureMaps.stageNodeCounts[stageIndex + 1]) - 3,
  ) * resolvedOptions.stageDensityGapFactor;
  const linkPressure = Math.max(0, pressureMaps.stageBoundaryLinkCounts[stageIndex] - 2)
    * resolvedOptions.stageLinkGapFactor;
  const crossTreePressure = pressureMaps.stageBoundaryCrossTreeCounts[stageIndex]
    * resolvedOptions.stageCrossTreeGapFactor;
  const multiParentPressure = Math.max(0, pressureMaps.stageBoundaryMultiParentCounts[stageIndex] - 1)
    * resolvedOptions.stageMultiParentGapFactor;
  const extraSpacingFactor = Math.min(
    resolvedOptions.maxStageExtraFactor,
    densityPressure + linkPressure + crossTreePressure + multiParentPressure,
  );
  const crossTreeCount = pressureMaps.stageBoundaryCrossTreeCounts[stageIndex];
  const labelDensityExtraPx = crossTreeCount >= 2
    ? LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSITY_WIDEN_PX * Math.sqrt(crossTreeCount - 1)
    : 0;

  return resolvedOptions.layerSpacing * (1 + extraSpacingFactor) + labelDensityExtraPx;
}

export function computeUnassignedColumnX(
  nodeMap: Map<string, AutoLayoutNodeData>,
  nodes: readonly AutoLayoutNodeData[],
  links: readonly AutoLayoutLinkData[],
  stageNums: readonly number[],
  stageXMap: Map<number, number>,
  resolvedOptions: ResolvedAutoLayoutOptions,
): number {
  if (stageNums.length === 0) {
    return 0;
  }

  const lastAssignedStage = stageNums[stageNums.length - 1];
  const lastAssignedStageX = stageXMap.get(lastAssignedStage) ?? 0;
  const unassignedCount = nodes.filter(node => !isAssignedLayoutNode(node)).length;
  let boundaryLinkCount = 0;
  let boundaryCrossTreeCount = 0;

  links.forEach(link => {
    const fromNode = nodeMap.get(link.from);
    const toNode = nodeMap.get(link.to);
    if (!fromNode || !toNode) {
      return;
    }

    const fromAssigned = isAssignedLayoutNode(fromNode);
    const toAssigned = isAssignedLayoutNode(toNode);
    if (fromAssigned === toAssigned) {
      return;
    }

    if (link.isCrossTree) {
      boundaryCrossTreeCount += 1;
    } else {
      boundaryLinkCount += 1;
    }
  });

  const densityPressure = Math.max(0, unassignedCount - 2) * resolvedOptions.stageDensityGapFactor;
  const linkPressure = Math.max(0, boundaryLinkCount - 1) * resolvedOptions.stageLinkGapFactor;
  const crossTreePressure = boundaryCrossTreeCount * resolvedOptions.stageCrossTreeGapFactor;
  const extraSpacingFactor = Math.min(
    resolvedOptions.maxStageExtraFactor,
    densityPressure + linkPressure + crossTreePressure,
  );

  return lastAssignedStageX + resolvedOptions.layerSpacing * (1 + extraSpacingFactor);
}
