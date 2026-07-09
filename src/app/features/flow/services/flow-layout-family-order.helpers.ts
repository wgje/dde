import type {
  AutoLayoutLinkData,
  FamilyAffinityPair,
  FamilyLayoutBlock,
  ResolvedAutoLayoutOptions,
} from './flow-layout-auto-layout-core.helpers';

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
 */
export function optimizeFamilyOrder(
  familyBlocks: readonly FamilyLayoutBlock[],
  links: readonly AutoLayoutLinkData[],
  resolvedOptions: ResolvedAutoLayoutOptions,
): FamilyLayoutBlock[] {
  if (familyBlocks.length <= 2) {
    return familyBlocks.slice();
  }

  const affinity = buildFamilyAffinityMap(familyBlocks, links);
  if (affinity.size === 0) {
    return familyBlocks.slice();
  }

  const order = buildGreedyFamilyOrder(familyBlocks.length, affinity);
  const refined = refineOrderWithTwoOpt(order, affinity, resolvedOptions);

  return refined.map(index => familyBlocks[index]);
}

function buildFamilyAffinityMap(
  familyBlocks: readonly FamilyLayoutBlock[],
  links: readonly AutoLayoutLinkData[],
): Map<string, number> {
  const keyToFamily = new Map<string, number>();
  familyBlocks.forEach((block, index) => {
    block.nodes.forEach(node => keyToFamily.set(node.key, index));
  });

  const affinity = new Map<string, number>();
  for (const link of links) {
    if (!link.isCrossTree) continue;
    const a = keyToFamily.get(link.from);
    const b = keyToFamily.get(link.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = familyPairKey(a, b);
    affinity.set(key, (affinity.get(key) ?? 0) + 1);
  }
  return affinity;
}

function buildGreedyFamilyOrder(familyCount: number, affinity: ReadonlyMap<string, number>): number[] {
  const visited = new Set<number>([0]);
  const order: number[] = [0];

  while (order.length < familyCount) {
    const bestIndex = findNextGreedyFamilyIndex(order[order.length - 1], familyCount, visited, affinity);
    if (bestIndex === -1) break;
    visited.add(bestIndex);
    order.push(bestIndex);
  }

  return order;
}

function findNextGreedyFamilyIndex(
  current: number,
  familyCount: number,
  visited: ReadonlySet<number>,
  affinity: ReadonlyMap<string, number>,
): number {
  let bestIndex = -1;
  let bestAffinity = 0;
  for (let i = 0; i < familyCount; i += 1) {
    if (visited.has(i)) continue;
    const aff = affinity.get(familyPairKey(current, i)) ?? 0;
    if (aff > bestAffinity) {
      bestAffinity = aff;
      bestIndex = i;
    }
  }

  return bestIndex === -1 ? findFirstUnvisitedFamilyIndex(familyCount, visited) : bestIndex;
}

function findFirstUnvisitedFamilyIndex(familyCount: number, visited: ReadonlySet<number>): number {
  for (let i = 0; i < familyCount; i += 1) {
    if (!visited.has(i)) return i;
  }
  return -1;
}

function familyPairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function refineOrderWithTwoOpt(
  initialOrder: readonly number[],
  affinity: ReadonlyMap<string, number>,
  resolvedOptions: ResolvedAutoLayoutOptions,
): number[] {
  if (initialOrder.length < 4 || affinity.size === 0) {
    return initialOrder.slice();
  }

  const affinityPairs = parseFamilyAffinityPairs(affinity);
  let best = initialOrder.slice();
  let bestCost = computeFamilyOrderCost(best, affinityPairs);
  const maxPasses = Math.max(1, Math.trunc(resolvedOptions.twoOptMaxPasses));
  const epsilon = Math.max(0, resolvedOptions.twoOptImprovementEpsilon);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improvedInPass = false;

    for (let i = 1; i < best.length - 1; i += 1) {
      for (let j = i + 1; j < best.length; j += 1) {
        const candidate = reverseFamilyOrderSegment(best, i, j);
        const candidateCost = computeFamilyOrderCost(candidate, affinityPairs);
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

function parseFamilyAffinityPairs(affinity: ReadonlyMap<string, number>): FamilyAffinityPair[] {
  return Array.from(affinity, ([key, weight]) => {
    const dashIndex = key.indexOf('-');
    return {
      a: Number(key.slice(0, dashIndex)),
      b: Number(key.slice(dashIndex + 1)),
      weight,
    };
  });
}

function computeFamilyOrderCost(order: readonly number[], affinityPairs: readonly FamilyAffinityPair[]): number {
  const positions = new Map<number, number>();
  order.forEach((familyIndex, position) => positions.set(familyIndex, position));
  let total = 0;
  for (const pair of affinityPairs) {
    const posA = positions.get(pair.a);
    const posB = positions.get(pair.b);
    if (posA === undefined || posB === undefined) continue;
    total += pair.weight * Math.abs(posA - posB);
  }
  return total;
}

function reverseFamilyOrderSegment(order: readonly number[], start: number, end: number): number[] {
  return order.slice(0, start)
    .concat(order.slice(start, end + 1).reverse())
    .concat(order.slice(end + 1));
}
