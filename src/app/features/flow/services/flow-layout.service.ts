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
 *
 * 【补丁 B 2026-04-23】为后续拆分 rank 语义预留字段：
 *  - `rank`        兼顾现有行为（tie-break）
 *  - `preferredOrder` 同 stage 内希望的软约束顺序，未传时 fallback 到 rank
 *  - `priority`    仅用于最后的稳定 tie-break，未传时视为 0
 * 目前 compareLayoutNodes 仍仅使用 rank，这些字段预留给后续交叉最小化 / 约束系统使用。
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

interface ResolvedAutoLayoutOptions {
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

interface NodeRelationHints {
  relationTargetsByNode: Map<string, RelationTargetHint[]>;
}

interface SubtreeLayoutMetrics {
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

interface LocalRowRange {
  min: number;
  max: number;
}

interface RelationTargetHint {
  targetKey: string;
  score: number;
}

const MIN_RELATION_STAGE_SCORE_MULTIPLIER = 100_000;

/**
 * 【关系网优化 2026-04-22】生成 (fromStage, toStage) 无向阶段对键，用于
 * 统计同一列跨树链接的密度。null/相同 stage 的链接没有阶段列，返回 null。
 */
function getStagePairKey(fromStage: number | null, toStage: number | null): string | null {
  if (fromStage == null || toStage == null || fromStage === toStage) {
    return null;
  }
  return fromStage < toStage ? `${fromStage}->${toStage}` : `${toStage}->${fromStage}`;
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

function computeRelationStageScoreMultiplier(nodes: Iterable<AutoLayoutNodeData>): number {
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

function buildCrossTreeRelationHints(
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

function buildParentAndChildrenMaps(
  assignedNodeMap: Map<string, AutoLayoutNodeData>,
  links: readonly AutoLayoutLinkData[],
): {
  parentMap: Map<string, string>;
  childrenMap: Map<string, AutoLayoutNodeData[]>;
  parentCandidateCountMap: Map<string, number>;
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
  const parentCandidateCountMap = new Map<string, number>();

  for (const [childKey, parents] of candidateParents) {
    const child = assignedNodeMap.get(childKey);
    if (!child || !isAssignedLayoutNode(child) || parents.length === 0) {
      continue;
    }

    parentCandidateCountMap.set(childKey, parents.length);

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

  return { parentMap, childrenMap, parentCandidateCountMap };
}

function buildSubtreeLayoutMetrics(
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

    const directRelationTargets = (relationHints.relationTargetsByNode.get(frame.node.key) ?? [])
      .filter(target => !allowedNodeKeys.has(target.targetKey));
    const directRelationCount = directRelationTargets.length;
    const directRelationCenter = directRelationCount > 0
      ? directRelationTargets.reduce((sum, target) => sum + target.score, 0) / directRelationCount
      : null;
    let leafCount = children.length === 0 ? 1 : 0;
    let relationCount = directRelationCount;
    let relationWeightedCenterSum = directRelationCount > 0 && directRelationCenter != null
      ? directRelationCenter * directRelationCount
      : 0;
    let multiParentLoad = Math.max(0, (parentCandidateCountMap.get(frame.node.key) ?? 1) - 1);
    let congestedRelationLoad = nodeCongestionLoad.get(frame.node.key) ?? 0;

    for (const child of children) {
      const childMetrics = metrics.get(child.key);
      if (!childMetrics) {
        continue;
      }

      leafCount += childMetrics.leafCount;
      relationCount += childMetrics.relationCount;
      if (childMetrics.relationCenter != null && childMetrics.relationCount > 0) {
        relationWeightedCenterSum += childMetrics.relationCenter * childMetrics.relationCount;
      }
      multiParentLoad += childMetrics.multiParentLoad;
      congestedRelationLoad += childMetrics.congestedRelationLoad;
    }

    metrics.set(frame.node.key, {
      leafCount: Math.max(leafCount, 1),
      relationCount,
      relationCenter: relationCount > 0 ? relationWeightedCenterSum / relationCount : null,
      multiParentLoad,
      congestedRelationLoad,
    });
  }

  return metrics;
}

function optimizeSiblingOrder(
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
function refineSiblingOrderWithTwoOpt(
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

function computeSiblingGapRows(
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

function shiftLocalRowsAfterThreshold(
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

function buildAdaptiveStageXMap(
  assignedNodes: readonly AutoLayoutNodeData[],
  links: readonly AutoLayoutLinkData[],
  stageNums: readonly number[],
  stageIndexMap: Map<number, number>,
  resolvedOptions: ResolvedAutoLayoutOptions,
  parentCandidateCountMap: ReadonlyMap<string, number>,
): Map<number, number> {
  const stageNodeCounts = new Array(stageNums.length).fill(0);
  const stageBoundaryLinkCounts = new Array(Math.max(0, stageNums.length - 1)).fill(0);
  const stageBoundaryCrossTreeCounts = new Array(Math.max(0, stageNums.length - 1)).fill(0);
  // 【关系网优化 2026-04-21】跟踪穿越每个阶段边界的"多父扇入"计数：
  //   某子节点在 parentCandidateCountMap 中 >= 2 时，视其为合流节点，
  //   本条 parent->child 链接按多父扇入计入对应边界压力。
  const stageBoundaryMultiParentCounts = new Array(Math.max(0, stageNums.length - 1)).fill(0);
  const assignedNodeMap = new Map(assignedNodes.map(node => [node.key, node]));

  assignedNodes.forEach(node => {
    const stageIndex = stageIndexMap.get(node.stage!);
    if (stageIndex !== undefined) {
      stageNodeCounts[stageIndex] += 1;
    }
  });

  links.forEach(link => {
    const fromNode = assignedNodeMap.get(link.from);
    const toNode = assignedNodeMap.get(link.to);
    if (!fromNode || !toNode || !isAssignedLayoutNode(fromNode) || !isAssignedLayoutNode(toNode)) {
      return;
    }

    const fromStageIndex = stageIndexMap.get(fromNode.stage);
    const toStageIndex = stageIndexMap.get(toNode.stage);
    if (fromStageIndex === undefined || toStageIndex === undefined || fromStageIndex === toStageIndex) {
      return;
    }

    const startIndex = Math.min(fromStageIndex, toStageIndex);
    const endIndex = Math.max(fromStageIndex, toStageIndex);
    // 只有父子方向（非跨树）的链接，且目标端有 >=2 个候选父时，才算合流。
    // 跨树链接已经单独计入 stageBoundaryCrossTreeCounts，避免重复加压。
    const toCandidateCount = parentCandidateCountMap.get(toNode.key) ?? 0;
    const isMultiParentMerge = !link.isCrossTree && toCandidateCount >= 2;
    for (let boundaryIndex = startIndex; boundaryIndex < endIndex; boundaryIndex += 1) {
      if (link.isCrossTree) {
        stageBoundaryCrossTreeCounts[boundaryIndex] += 1;
      } else {
        stageBoundaryLinkCounts[boundaryIndex] += 1;
      }
      if (isMultiParentMerge) {
        stageBoundaryMultiParentCounts[boundaryIndex] += 1;
      }
    }
  });

  const stageXMap = new Map<number, number>();
  let currentX = 0;

  stageNums.forEach((stage, stageIndex) => {
    stageXMap.set(stage, currentX);
    if (stageIndex === stageNums.length - 1) {
      return;
    }

    const densityPressure = Math.max(
      0,
      Math.max(stageNodeCounts[stageIndex], stageNodeCounts[stageIndex + 1]) - 3,
    ) * resolvedOptions.stageDensityGapFactor;
    const linkPressure = Math.max(0, stageBoundaryLinkCounts[stageIndex] - 2)
      * resolvedOptions.stageLinkGapFactor;
    const crossTreePressure = stageBoundaryCrossTreeCounts[stageIndex]
      * resolvedOptions.stageCrossTreeGapFactor;
    // 多父扇入压力：合流次数 >= 2 才认为有视觉挤压（单条合流天然有呼吸感）。
    const multiParentPressure = Math.max(0, stageBoundaryMultiParentCounts[stageIndex] - 1)
      * resolvedOptions.stageMultiParentGapFactor;
    const extraSpacingFactor = Math.min(
      resolvedOptions.maxStageExtraFactor,
      densityPressure + linkPressure + crossTreePressure + multiParentPressure,
    );

    // 【补丁 D 2026-04-23】按跨树 label 密度的绝对像素加宽：
    // 当某 stage 边界横跨 N 条跨树链接（N>=2），关联块会沿该 gap 错开
    // 排布（补丁 C），若 gap 本身太窄，错开后 label 会溢出到节点上方。
    // 按 sqrt(N-1) 放大避免 O(N) 爆炸；2 条 → ~1 * step、5 条 → 2 * step。
    const crossTreeCount = stageBoundaryCrossTreeCounts[stageIndex];
    const labelDensityExtraPx = crossTreeCount >= 2
      ? LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSITY_WIDEN_PX
        * Math.sqrt(crossTreeCount - 1)
      : 0;

    currentX += resolvedOptions.layerSpacing * (1 + extraSpacingFactor) + labelDensityExtraPx;
  });

  return stageXMap;
}

function computeUnassignedColumnX(
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
      if (!rowMap.has(currentKey)) {
        rowMap.set(currentKey, nextLeafRow);
        subtreeRangeMap.set(currentKey, { min: nextLeafRow, max: nextLeafRow });
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

    // 中文注释：为复杂兄弟子树插入额外留白，让跨树关联和多父节点不要挤在同一条视觉带里。
    for (let childIndex = 0; childIndex < children.length - 1; childIndex += 1) {
      const leftChild = children[childIndex];
      const rightChild = children[childIndex + 1];
      const leftRange = subtreeRangeMap.get(leftChild.key);
      if (!leftRange) {
        continue;
      }

      const siblingGapRows = computeSiblingGapRows(
        subtreeMetrics.get(leftChild.key),
        subtreeMetrics.get(rightChild.key),
        resolvedOptions,
      );
      if (siblingGapRows <= 0) {
        continue;
      }

      shiftLocalRowsAfterThreshold(rowMap, subtreeRangeMap, leftRange.max, siblingGapRows);
      nextLeafRow += siblingGapRows;
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

    const firstChildRange = subtreeRangeMap.get(children[0].key);
    const lastChildRange = subtreeRangeMap.get(children[children.length - 1].key);
    const currentRow = rowMap.get(currentKey) ?? nextLeafRow;
    subtreeRangeMap.set(currentKey, {
      min: firstChildRange?.min ?? currentRow,
      max: lastChildRange?.max ?? currentRow,
    });

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
 * 【关系网优化 2026-04-21】贪心只能保证局部最优，当 3 个以上家族互相
 * 关联时容易卡在次优排列。追加一轮 2-opt（segment-reverse）迭代，以
 * "加权跨距总和 = Σ affinity(a,b) * |pos(a) - pos(b)|" 为目标函数全局
 * 细化；pass 次数和最小改进量都受配置上限约束，保证大项目下布局时间可控。
 *
 * 输入不变性：
 * - 不修改家族内部节点顺序与本地行号
 * - 家族数 ≤ 2 或无跨树连接时直接返回原顺序的浅拷贝
 * - 2-opt 保留首家族为锚点（索引 0 不参与反转），维持与原 rank 顺序的最近亲
 *
 * @param familyBlocks 原始家族块（按根 rank 升序）
 * @param links 全部连线（含 cross-tree 标记）
 * @param resolvedOptions 配置（含 2-opt pass 上限与改进阈值）
 * @returns 重排后的家族块数组（新数组，不修改入参）
 */
function optimizeFamilyOrder(
  familyBlocks: readonly FamilyLayoutBlock[],
  links: readonly AutoLayoutLinkData[],
  resolvedOptions: ResolvedAutoLayoutOptions,
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

  // 【关系网优化 2026-04-21】2-opt segment reverse：在贪心基础上以
  // "加权跨距总和" 为目标全局细化。
  //  - 成本函数 cost(order) = Σ_{(a,b) ∈ affinity} w_ab * |pos(a) - pos(b)|
  //  - pos(x) 为家族 x 在排列中的索引（0 为首家族锚点）
  //  - 每次 pass 扫描所有 (i, j)，i ≥ 1 保留锚点；若 reverse [i..j] 能减少
  //    cost 至少 epsilon，则接受并继续。
  //  - pass 次数受 twoOptMaxPasses 限制，防止退化链路 O(n⁴) 卡顿。
  const refined = refineOrderWithTwoOpt(order, affinity, resolvedOptions);

  return refined.map(index => familyBlocks[index]);
}

/**
 * 基于加权跨距总和对家族排列做 2-opt segment-reverse 细化。
 * 返回新数组，保留锚点（索引 0）。无改进时返回与输入等价的新数组。
 */
function refineOrderWithTwoOpt(
  initialOrder: readonly number[],
  affinity: ReadonlyMap<string, number>,
  resolvedOptions: ResolvedAutoLayoutOptions,
): number[] {
  if (initialOrder.length < 4 || affinity.size === 0) {
    return initialOrder.slice();
  }

  const parsePairKey = (key: string): readonly [number, number] => {
    const dashIndex = key.indexOf('-');
    return [Number(key.slice(0, dashIndex)), Number(key.slice(dashIndex + 1))] as const;
  };

  const affinityPairs = Array.from(affinity, ([key, weight]) => {
    const [a, b] = parsePairKey(key);
    return { a, b, weight };
  });

  const computeCost = (order: readonly number[]): number => {
    const positions = new Map<number, number>();
    order.forEach((familyIndex, position) => positions.set(familyIndex, position));
    let total = 0;
    for (const pair of affinityPairs) {
      const posA = positions.get(pair.a);
      const posB = positions.get(pair.b);
      if (posA === undefined || posB === undefined) {
        continue;
      }
      total += pair.weight * Math.abs(posA - posB);
    }
    return total;
  };

  let best = initialOrder.slice();
  let bestCost = computeCost(best);
  const maxPasses = Math.max(1, Math.trunc(resolvedOptions.twoOptMaxPasses));
  const epsilon = Math.max(0, resolvedOptions.twoOptImprovementEpsilon);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improvedInPass = false;

    // i 从 1 开始：锚点（原始第一家族）不参与反转，维持与 rank 顺序的最近亲和度。
    for (let i = 1; i < best.length - 1; i += 1) {
      for (let j = i + 1; j < best.length; j += 1) {
        const candidate = best.slice(0, i)
          .concat(best.slice(i, j + 1).reverse())
          .concat(best.slice(j + 1));
        const candidateCost = computeCost(candidate);
        if (candidateCost + epsilon < bestCost) {
          best = candidate;
          bestCost = candidateCost;
          improvedInPass = true;
        }
      }
    }

    if (!improvedInPass) {
      break;
    }
  }

  return best;
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

  const assignedNodes = nodes.filter(isAssignedLayoutNode);
  const unassignedNodes = nodes.filter(node => !isAssignedLayoutNode(node));
  const allNodeMap = new Map(nodes.map(node => [node.key, node]));
  const assignedNodeMap = new Map(assignedNodes.map(node => [node.key, node]));
  const stageNums = Array.from(new Set(assignedNodes.map(node => node.stage!))).sort((a, b) => a - b);
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

  // 【关系网优化 2026-04-22】"关联块重叠"根因：自动排序从未考虑同一
  // 阶段列上多条跨树链接中点标签（关联块）会在 Y 轴堆叠。这里先统计每
  // 个 (fromStage <-> toStage) 阶段对上的跨树链接密度，后面把这个密度用
  // sqrt 衰减后加权回家族间距与兄弟间距压力，让拥挤列上的关联块获得
  // 真正能分离的纵向呼吸空间。
  const stagePairCrossTreeCount = new Map<string, number>();
  links.forEach(link => {
    if (!link.isCrossTree) {
      return;
    }
    const fromNode = allNodeMap.get(link.from);
    const toNode = allNodeMap.get(link.to);
    if (!fromNode || !toNode) {
      return;
    }
    const pairKey = getStagePairKey(fromNode.stage, toNode.stage);
    if (!pairKey) {
      return;
    }
    stagePairCrossTreeCount.set(pairKey, (stagePairCrossTreeCount.get(pairKey) ?? 0) + 1);
  });

  // 每个节点自身承担的"阶段对拥挤度"：它的每条跨树链接所在阶段对的
  // 总链接数求和。参与兄弟子树纵向留白的主要信号来自这个累计值，让
  // "关联块会堆叠在同一列"的兄弟子树在自动布局里自然分开。
  const nodeCongestionLoad = new Map<string, number>();
  links.forEach(link => {
    if (!link.isCrossTree) {
      return;
    }
    const fromNode = allNodeMap.get(link.from);
    const toNode = allNodeMap.get(link.to);
    if (!fromNode || !toNode) {
      return;
    }
    const pairKey = getStagePairKey(fromNode.stage, toNode.stage);
    if (!pairKey) {
      return;
    }
    const congestion = stagePairCrossTreeCount.get(pairKey) ?? 1;
    nodeCongestionLoad.set(link.from, (nodeCongestionLoad.get(link.from) ?? 0) + congestion);
    nodeCongestionLoad.set(link.to, (nodeCongestionLoad.get(link.to) ?? 0) + congestion);
  });

  const naturalFamilyBlocks = buildFamilyBlocks(
    assignedNodes,
    parentMap,
    childrenMap,
    relationHints,
    parentCandidateCountMap,
    resolvedOptions,
    nodeCongestionLoad,
  );
  // 【商用级优化】按跨树连接亲和度重排家族，使关联家族尽量相邻，
  // 减少跨树连线视觉跨距、提升可读性
  const familyBlocks = optimizeFamilyOrder(naturalFamilyBlocks, links, resolvedOptions);

  const positionMap = new Map<string, NodePosition>();
  const familyIndexMap = new Map<string, number>();
  familyBlocks.forEach((block, familyIndex) => {
    block.nodes.forEach(node => familyIndexMap.set(node.key, familyIndex));
  });

  // 【关系网优化 2026-04-22】"关联块重叠"根因：自动排序从未考虑同一
  // 阶段列上多条跨树链接中点标签（关联块）会在 Y 轴堆叠。这里先统计每
  // 个 (fromStage <-> toStage) 阶段对上的跨树链接密度，后面把这个密度用
  // sqrt 衰减后加权回家族间距与兄弟间距压力，让拥挤列上的关联块获得
  // 真正能分离的纵向呼吸空间。
  // （stagePairCrossTreeCount 已在 buildFamilyBlocks 之前构建。）

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

    // 关联块拥挤度加权：若本链接所在的阶段列上还挤着其他跨树链接，
    // 放大本链接对家族间距的贡献，让堆叠的标签获得分离空间。
    const fromNode = allNodeMap.get(link.from);
    const toNode = allNodeMap.get(link.to);
    const pairKey = fromNode && toNode ? getStagePairKey(fromNode.stage, toNode.stage) : null;
    const congestion = pairKey ? (stagePairCrossTreeCount.get(pairKey) ?? 1) : 1;
    const congestionWeight = Math.sqrt(Math.max(1, congestion));

    const pressurePerGap = (resolvedOptions.crossTreeLabelGapRows * congestionWeight) / span;

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

      const localRow = block.localRowMap.get(node.key);
      const stageX = stageXMap.get(node.stage);
      if (stageX === undefined || localRow === undefined) {
        return;
      }

      positionMap.set(node.key, {
        key: node.key,
        x: stageX,
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
    // 【2026-04-22】与上面的 stage-pair 拥挤度加权配合：
    //  - 拥挤度已经在 pressurePerGap 环节把重要性放大
    //  - 这里抬高上限到 0.55 行，允许真正起效的分离距离
    //  - 系数同步从 0.30 -> 0.45，让中等链接数家族也能拿到明显呼吸感
    const rawCrossTree = familyGapPressures[familyIndex] ?? 0;
    const crossTreePressure = rawCrossTree > 0
      ? Math.min(0.55, Math.sqrt(rawCrossTree) * 0.45)
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
    ? computeUnassignedColumnX(allNodeMap, nodes, links, stageNums, stageXMap, resolvedOptions)
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
      if (this.positionSaveTimer) {
        clearTimeout(this.positionSaveTimer);
        this.positionSaveTimer = null;
      }
      this.pendingSaveGeneration = null;
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
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.pendingSaveGeneration = null;
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
   *
   * 计划 §8.4：timer fire 时必须二次校验 diagram 仍存在 + generation 未递进，
   * 避免布局期间组件销毁、项目切换或外部 `requestLayoutGeneration()`
   * 调用之后旧坐标仍写回 store 造成 stale_layout_dropped 数据污染。
   */
  scheduleSaveAllPositions(): void {
    if (this.positionSaveTimer) {
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
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.diagram = null;
  }
}
