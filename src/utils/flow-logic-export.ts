/**
 * 流程图「逻辑网」导出纯函数模块
 *
 * 用途：将 NanoFlow 的 Project（tasks + connections）导出为两种纯净文本格式，
 *      供 AI 进行逻辑漏洞审查：
 *   - Mermaid flowchart TD：用于整体骨架审查
 *   - 精简 YAML（含 invariants + derived 派生字段）：用于数据流审查
 *
 * 设计原则：
 *   1. 权威源：只读 Project，不读 GoJS runtime 或派生 store
 *   2. 过滤：archived / deletedAt != null 的实体整体剔除
 *   3. 去重：父子关系只通过 tasks[].parentId 表达，connections 只含 cross_tree
 *   4. 预警：orphan_connections / cycle_detection / duplicate_parent_child 主动暴露脏数据
 *   5. 可测试：纯函数，不依赖 DI
 *
 * 不引入新的 YAML 依赖；手写安全输出器（JSON-style flow scalar + block scalar）
 *
 * @see AGENTS.md Hard Rules（ID/LWW/树深上限 100）
 */

import type { Project, Task, Connection } from '../models';
import { checkInvariants, type InvariantInput } from './flow-logic-invariants';
import { buildMermaid, buildYaml, type SerializeContext } from './flow-logic-serialization';

// ============================================================
// 常量
// ============================================================

/** 与 FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH 对齐的硬上限，防止异常深树导致栈或时间爆炸 */
export const LOGIC_EXPORT_MAX_DEPTH = 100;

/** 超过该节点数时发出规模警告（不阻断导出） */
export const LOGIC_EXPORT_LARGE_NODE_THRESHOLD = 200;

// ============================================================
// 对外类型
// ============================================================

export interface LogicExportOptions {
  /** 导出格式 */
  readonly format: 'mermaid' | 'yaml' | 'both';
  /** 导出模式：full=完整，skeleton=仅阶段骨架，stage=按阶段筛选（由 stageFilter 指定；为空时导出空切片） */
  readonly mode?: 'full' | 'skeleton' | 'stage';
  /** 是否包含 status=completed 的任务，默认 true */
  readonly includeCompleted?: boolean;
  /** 是否包含 parkingMeta 字段，默认 true */
  readonly includeParking?: boolean;
  /** 是否包含 Dock planning 字段，默认 true */
  readonly includePlanning?: boolean;
  /** 是否对 title/description 做 PII 脱敏，默认 false */
  readonly redactPII?: boolean;
  /** stage 模式下指定导出的阶段（null 代表待分配） */
  readonly stageFilter?: readonly (number | null)[];
  /** 深度上限，默认 LOGIC_EXPORT_MAX_DEPTH */
  readonly maxDepth?: number;
}

export type InvariantSeverity = 'error' | 'warning';

export interface InvariantCheckResult {
  readonly code: string;
  readonly severity: InvariantSeverity;
  readonly message: string;
  readonly offenders: readonly string[];
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ?? '';
  const right = b ?? '';
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareOptionalNumber(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a - b;
}

function canonicalizeTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const stageDiff = compareOptionalNumber(a.stage, b.stage);
    if (stageDiff !== 0) return stageDiff;
    const parentDiff = compareText(a.parentId, b.parentId);
    if (parentDiff !== 0) return parentDiff;
    if (a.order !== b.order) return a.order - b.order;
    if (a.rank !== b.rank) return a.rank - b.rank;
    const displayDiff = compareText(a.displayId, b.displayId);
    if (displayDiff !== 0) return displayDiff;
    const titleDiff = compareText(a.title, b.title);
    if (titleDiff !== 0) return titleDiff;
    return compareText(a.id, b.id);
  });
}

function canonicalizeConnections(connections: readonly Connection[]): Connection[] {
  return [...connections].sort((a, b) => {
    const sourceDiff = compareText(a.source, b.source);
    if (sourceDiff !== 0) return sourceDiff;
    const targetDiff = compareText(a.target, b.target);
    if (targetDiff !== 0) return targetDiff;
    const titleDiff = compareText(a.title, b.title);
    if (titleDiff !== 0) return titleDiff;
    return compareText(a.id, b.id);
  });
}

export interface LogicExportResult {
  readonly mermaid?: string;
  readonly yaml?: string;
  readonly invariants: readonly InvariantCheckResult[];
  readonly warnings: readonly string[];
  readonly stats: {
    readonly totalTasks: number;
    readonly totalConnections: number;
    readonly roots: number;
    readonly floatingRoots: number;
    readonly maxTreeDepth: number;
  };
}

interface LogicExportPrepared {
  readonly mode: 'full' | 'skeleton' | 'stage';
  readonly maxDepth: number;
  readonly retainedTasks: readonly Task[];
  readonly visibleTasks: readonly Task[];
  readonly orphanConnections: readonly Connection[];
  readonly duplicateParentChildConnections: readonly Connection[];
  readonly crossTreeConnections: readonly Connection[];
  readonly derived: DerivedMetrics;
  readonly filteredTasks: readonly Task[];
  readonly filteredConnections: readonly Connection[];
  readonly exportDerived: DerivedMetrics;
}

interface ExportOutputInput {
  readonly project: Project;
  readonly options: LogicExportOptions;
  readonly prepared: LogicExportPrepared;
  readonly invariants: readonly InvariantCheckResult[];
  readonly ctx: SerializeContext;
}

// ============================================================
// 主入口
// ============================================================

/**
 * 从 Project 派生出可供 AI 审查的 Mermaid + YAML 文本对。
 * 永远返回成功结果（空项目/无活动项目由调用方判断）。
 */
export function exportProjectLogic(
  project: Project,
  options: LogicExportOptions,
): LogicExportResult {
  const includeParking = options.includeParking ?? true;
  const includePlanning = options.includePlanning ?? true;
  const redactPII = options.redactPII ?? false;
  const prepared = prepareLogicExport(project, options);
  const invariants = checkInvariants(buildInvariantInput(prepared));
  const warnings = buildExportWarnings(prepared);
  const ctx: SerializeContext = {
    redactPII,
    includeParking,
    includePlanning,
    maxDepth: prepared.maxDepth,
    mode: prepared.mode,
  };
  const output = buildExportOutputs({ project, options, prepared, invariants, ctx });

  return {
    ...output,
    invariants,
    warnings,
    stats: buildExportStats(prepared),
  };
}

function prepareLogicExport(project: Project, options: LogicExportOptions): LogicExportPrepared {
  const mode = options.mode ?? 'full';
  const includeCompleted = options.includeCompleted ?? true;
  const maxDepth = options.maxDepth ?? LOGIC_EXPORT_MAX_DEPTH;
  const retainedTasks = canonicalizeTasks(filterTasks(project.tasks, { includeCompleted: true }));
  const visibleTasks = canonicalizeTasks(filterTasks(project.tasks, { includeCompleted }));
  const retainedTaskIds = new Set(retainedTasks.map(t => t.id));
  const taskIds = new Set(visibleTasks.map(t => t.id));
  const allConnections = canonicalizeConnections(project.connections.filter(c => !c.deletedAt));
  const orphanConnections = allConnections.filter(c => !retainedTaskIds.has(c.source) || !retainedTaskIds.has(c.target));
  const parentChildEdgeSet = buildParentChildEdgeSet(visibleTasks, taskIds);
  const crossTreeConnections = filterCrossTreeConnections(allConnections, taskIds, parentChildEdgeSet);
  const duplicateParentChildConnections = filterDuplicateParentChildConnections(allConnections, taskIds, parentChildEdgeSet);
  const derived = computeDerived(visibleTasks, crossTreeConnections, maxDepth);
  const { filteredTasks, filteredConnections } = applyModeFilter(visibleTasks, crossTreeConnections, options);

  return {
    mode,
    maxDepth,
    retainedTasks,
    visibleTasks,
    orphanConnections,
    duplicateParentChildConnections,
    crossTreeConnections,
    derived,
    filteredTasks,
    filteredConnections,
    exportDerived: computeDerived(filteredTasks, filteredConnections, maxDepth),
  };
}

function buildInvariantInput(prepared: LogicExportPrepared): InvariantInput {
  const fullMode = prepared.mode === 'full';
  const derived = fullMode ? prepared.derived : prepared.exportDerived;

  return {
    tasks: fullMode ? prepared.visibleTasks : prepared.filteredTasks,
    crossTreeConnections: fullMode ? prepared.crossTreeConnections : prepared.filteredConnections,
    orphanConnections: fullMode ? prepared.orphanConnections : [],
    duplicateParentChildConnections: fullMode ? prepared.duplicateParentChildConnections : [],
    cycles: derived.cycles,
    maxDepth: prepared.maxDepth,
    actualMaxDepth: derived.maxTreeDepth,
    depthExceeded: derived.depthExceeded,
  };
}

function buildExportWarnings(prepared: LogicExportPrepared): string[] {
  const warnings: string[] = [];
  if (prepared.filteredTasks.length > LOGIC_EXPORT_LARGE_NODE_THRESHOLD) {
    warnings.push(`节点数(${prepared.filteredTasks.length})超过 ${LOGIC_EXPORT_LARGE_NODE_THRESHOLD}，建议继续缩小导出范围`);
  }
  if (prepared.exportDerived.depthExceeded) {
    warnings.push(`任务树深度至少为 ${prepared.maxDepth + 1}，超过上限(${prepared.maxDepth})，已截断渲染，请检查是否存在异常嵌套`);
  }
  if (prepared.mode === 'full' && prepared.orphanConnections.length > 0) {
    warnings.push(`发现 ${prepared.orphanConnections.length} 条孤儿连接（端点缺失）`);
  }
  if (prepared.mode === 'full' && prepared.duplicateParentChildConnections.length > 0) {
    warnings.push(`发现 ${prepared.duplicateParentChildConnections.length} 条与 parentId 重复的历史父子边（数据污染，建议清理）`);
  }
  return warnings;
}

function buildExportOutputs(input: ExportOutputInput): Pick<LogicExportResult, 'mermaid' | 'yaml'> {
  const { project, options, prepared, invariants, ctx } = input;
  return {
    mermaid: options.format !== 'yaml'
      ? buildMermaid(prepared.filteredTasks, prepared.filteredConnections, ctx)
      : undefined,
    yaml: options.format !== 'mermaid'
      ? buildYaml({
          project,
          tasks: prepared.filteredTasks,
          connections: prepared.filteredConnections,
          derived: prepared.exportDerived,
          invariants,
          ctx,
        })
      : undefined,
  };
}

function buildExportStats(prepared: LogicExportPrepared): LogicExportResult['stats'] {
  return {
    totalTasks: prepared.filteredTasks.length,
    totalConnections: prepared.filteredConnections.length,
    roots: prepared.exportDerived.roots.length,
    floatingRoots: prepared.exportDerived.floatingRoots.length,
    maxTreeDepth: prepared.exportDerived.maxTreeDepth,
  };
}

// ============================================================
// 过滤与派生
// ============================================================

function filterTasks(
  tasks: readonly Task[],
  opt: { includeCompleted: boolean },
): Task[] {
  return tasks.filter(t => {
    if (t.deletedAt) return false;
    if (t.status === 'archived') return false;
    if (!opt.includeCompleted && t.status === 'completed') return false;
    return true;
  });
}

function applyModeFilter(
  tasks: readonly Task[],
  connections: readonly Connection[],
  options: LogicExportOptions,
): { filteredTasks: Task[]; filteredConnections: Connection[] } {
  const mode = options.mode ?? 'full';

  if (mode === 'full') {
    return {
      filteredTasks: [...tasks],
      filteredConnections: [...connections],
    };
  }

  if (mode === 'skeleton') {
    // 仅保留 root 节点 + 每阶段首节点，连接全部保留但只显示跨阶段
    const visibleTaskIds = new Set(tasks.map(t => t.id));
    const stageFirst = new Map<number | 'floating', Task>();
    for (const t of tasks) {
      const key: number | 'floating' = t.stage ?? 'floating';
      if (!stageFirst.has(key)) stageFirst.set(key, t);
    }
    const keptTaskIds = new Set(
      tasks
        .filter(t => !t.parentId || !visibleTaskIds.has(t.parentId))
        .map(t => t.id),
    );
    Array.from(stageFirst.values(), t => t.id).forEach(id => keptTaskIds.add(id));
    return {
      filteredTasks: tasks.filter(t => keptTaskIds.has(t.id)),
      filteredConnections: connections.filter(
        c => keptTaskIds.has(c.source) && keptTaskIds.has(c.target),
      ),
    };
  }

  // stage 模式
  const stageSet = new Set<number | null>(
    (options.stageFilter ?? []).map(s => (s === undefined ? null : s)),
  );
  const keptTasks = tasks.filter(t => stageSet.has(t.stage));
  const keptIds = new Set(keptTasks.map(t => t.id));
  return {
    filteredTasks: keptTasks,
    filteredConnections: connections.filter(
      c => keptIds.has(c.source) && keptIds.has(c.target),
    ),
  };
}

function buildParentChildEdgeSet(tasks: readonly Task[], taskIds: ReadonlySet<string>): Set<string> {
  const parentChildEdgeSet = new Set<string>();
  for (const task of tasks) {
    if (task.parentId && taskIds.has(task.parentId)) {
      parentChildEdgeSet.add(edgeKey(task.parentId, task.id));
    }
  }
  return parentChildEdgeSet;
}

function filterCrossTreeConnections(
  connections: readonly Connection[],
  taskIds: ReadonlySet<string>,
  parentChildEdgeSet: ReadonlySet<string>,
): Connection[] {
  return connections.filter(
    connection =>
      taskIds.has(connection.source) &&
      taskIds.has(connection.target) &&
      !parentChildEdgeSet.has(edgeKey(connection.source, connection.target)),
  );
}

function filterDuplicateParentChildConnections(
  connections: readonly Connection[],
  taskIds: ReadonlySet<string>,
  parentChildEdgeSet: ReadonlySet<string>,
): Connection[] {
  return connections.filter(
    connection =>
      taskIds.has(connection.source) &&
      taskIds.has(connection.target) &&
      parentChildEdgeSet.has(edgeKey(connection.source, connection.target)),
  );
}

interface DerivedMetrics {
  readonly roots: string[];
  readonly floatingRoots: string[];
  readonly maxTreeDepth: number;
  readonly depthExceeded: boolean;
  readonly cycles: readonly (readonly string[])[];
}

interface TreeIndex {
  readonly taskMap: ReadonlyMap<string, Task>;
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly roots: string[];
  readonly floatingRoots: string[];
}

/**
 * 迭代 BFS 计算 roots / 浮动 roots / 深度；DFS 检测跨树连接环。
 */
function computeDerived(
  tasks: readonly Task[],
  crossTreeConnections: readonly Connection[],
  maxDepth: number,
): DerivedMetrics {
  const tree = buildTreeIndex(tasks);
  const depth = computeTreeDepth(tree, maxDepth);
  const graphEdges = buildGraphEdges(tasks, crossTreeConnections, tree.taskMap);
  // 环检测覆盖导出图中的全部有向边，避免 parentId + 跨树边的混合环漏报。
  const cycles = detectCycles(tasks.map(t => t.id), graphEdges);

  return {
    roots: tree.roots,
    floatingRoots: tree.floatingRoots,
    maxTreeDepth: depth.maxTreeDepth,
    depthExceeded: depth.depthExceeded,
    cycles,
  };
}

function buildTreeIndex(tasks: readonly Task[]): TreeIndex {
  const taskMap = new Map(tasks.map(t => [t.id, t] as const));
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  const floatingRoots: string[] = [];

  for (const task of tasks) {
    if (task.parentId && taskMap.has(task.parentId)) {
      const children = childrenOf.get(task.parentId) ?? [];
      children.push(task.id);
      childrenOf.set(task.parentId, children);
    } else {
      (task.stage === null ? floatingRoots : roots).push(task.id);
    }
  }

  return { taskMap, childrenOf, roots, floatingRoots };
}

function computeTreeDepth(
  tree: Pick<TreeIndex, 'childrenOf' | 'roots' | 'floatingRoots'>,
  maxDepth: number,
): Pick<DerivedMetrics, 'maxTreeDepth' | 'depthExceeded'> {
  let maxTreeDepth = 0;
  let depthExceeded = false;
  const stack: Array<{ id: string; depth: number }> = [];
  for (const root of [...tree.roots, ...tree.floatingRoots]) {
    stack.push({ id: root, depth: 1 });
  }

  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (depth > maxTreeDepth) maxTreeDepth = depth;
    const children = tree.childrenOf.get(id);
    if (!children || children.length === 0) continue;
    if (depth >= maxDepth) {
      depthExceeded = true;
      continue; // 截断防爆
    }
    for (const childId of children) stack.push({ id: childId, depth: depth + 1 });
  }

  return { maxTreeDepth, depthExceeded };
}

function buildGraphEdges(
  tasks: readonly Task[],
  crossTreeConnections: readonly Connection[],
  taskMap: ReadonlyMap<string, Task>,
): Array<Pick<Connection, 'source' | 'target'>> {
  const graphEdges: Array<Pick<Connection, 'source' | 'target'>> = [];
  for (const task of tasks) {
    if (task.parentId && taskMap.has(task.parentId)) {
      graphEdges.push({ source: task.parentId, target: task.id });
    }
  }
  for (const connection of crossTreeConnections) {
    graphEdges.push({ source: connection.source, target: connection.target });
  }
  return graphEdges;
}

function detectCycles(
  nodeIds: readonly string[],
  edges: readonly Pick<Connection, 'source' | 'target'>[],
): string[][] {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    const arr = adj.get(e.source);
    if (arr) arr.push(e.target);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);

  const cycles: string[][] = [];

  for (const start of nodeIds) {
    if (color.get(start) !== WHITE) continue;
    // 迭代 DFS with path tracking
    const stack: Array<{ id: string; iter: number }> = [{ id: start, iter: 0 }];
    const path: string[] = [];
    const pathIdx = new Map<string, number>();

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.iter === 0) {
        color.set(top.id, GRAY);
        pathIdx.set(top.id, path.length);
        path.push(top.id);
      }
      const neighbors = adj.get(top.id) ?? [];
      if (top.iter < neighbors.length) {
        const next = neighbors[top.iter++];
        const nc = color.get(next);
        if (nc === GRAY) {
          // 回边 → 环
          const startIdx = pathIdx.get(next) ?? 0;
          cycles.push(path.slice(startIdx));
        } else if (nc === WHITE) {
          stack.push({ id: next, iter: 0 });
        }
      } else {
        color.set(top.id, BLACK);
        pathIdx.delete(top.id);
        path.pop();
        stack.pop();
      }
    }
  }

  return cycles;
}

function edgeKey(source: string, target: string): string {
  return `${source}->${target}`;
}
