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

// ============================================================
// 常量
// ============================================================

/** 与 FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH 对齐的硬上限，防止异常深树导致栈或时间爆炸 */
export const LOGIC_EXPORT_MAX_DEPTH = 100;

/** 超过该节点数时发出规模警告（不阻断导出） */
export const LOGIC_EXPORT_LARGE_NODE_THRESHOLD = 200;

/** Mermaid label 最大字符数（超过截断 + …） */
const MERMAID_LABEL_MAX = 40;

/** YAML 中字符串如包含这些字符则用 block scalar；否则用 JSON-style flow scalar */
const YAML_BLOCK_SCALAR_TRIGGERS = /\n|\r/;

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
  const mode = options.mode ?? 'full';
  const includeCompleted = options.includeCompleted ?? true;
  const includeParking = options.includeParking ?? true;
  const includePlanning = options.includePlanning ?? true;
  const redactPII = options.redactPII ?? false;
  const maxDepth = options.maxDepth ?? LOGIC_EXPORT_MAX_DEPTH;

  // 1) 过滤 archived / deletedAt / completed（可选）
  const retainedTasks = canonicalizeTasks(filterTasks(project.tasks, { includeCompleted: true }));
  const visibleTasks = canonicalizeTasks(filterTasks(project.tasks, { includeCompleted }));

  // 2) 过滤软删除连接 + 端点缺失
  const retainedTaskIds = new Set(retainedTasks.map(t => t.id));
  const taskIds = new Set(visibleTasks.map(t => t.id));
  const allConnections = canonicalizeConnections(project.connections.filter(c => !c.deletedAt));

  const orphanConnections = allConnections.filter(
    c => !retainedTaskIds.has(c.source) || !retainedTaskIds.has(c.target),
  );

  // 3) 分离父子连接与跨树连接
  const parentChildEdgeSet = new Set<string>();
  for (const t of visibleTasks) {
    if (t.parentId && taskIds.has(t.parentId)) {
      parentChildEdgeSet.add(edgeKey(t.parentId, t.id));
    }
  }

  const crossTreeConnections = allConnections.filter(
    c =>
      taskIds.has(c.source) &&
      taskIds.has(c.target) &&
      !parentChildEdgeSet.has(edgeKey(c.source, c.target)),
  );

  // 存在于 connections 中但与 parentId 重复的边（历史污染数据）
  const duplicateParentChildConnections = allConnections.filter(
    c =>
      taskIds.has(c.source) &&
      taskIds.has(c.target) &&
      parentChildEdgeSet.has(edgeKey(c.source, c.target)),
  );

  // 4) 计算派生量
  const derived = computeDerived(visibleTasks, crossTreeConnections, maxDepth);

  // 5) 阶段/骨架过滤
  const { filteredTasks, filteredConnections } = applyModeFilter(
    visibleTasks,
    crossTreeConnections,
    options,
  );
  const exportDerived = computeDerived(filteredTasks, filteredConnections, maxDepth);
  const invariantTasks = mode === 'full' ? visibleTasks : filteredTasks;
  const invariantConnections = mode === 'full' ? crossTreeConnections : filteredConnections;
  const invariantDerived = mode === 'full' ? derived : exportDerived;
  const invariantOrphans = mode === 'full' ? orphanConnections : [];
  const invariantDuplicateParentChildConnections =
    mode === 'full' ? duplicateParentChildConnections : [];

  // 6) 检查不变式
  const invariants = checkInvariants({
    tasks: invariantTasks,
    crossTreeConnections: invariantConnections,
    orphanConnections: invariantOrphans,
    duplicateParentChildConnections: invariantDuplicateParentChildConnections,
    cycles: invariantDerived.cycles,
    maxDepth,
    actualMaxDepth: invariantDerived.maxTreeDepth,
    depthExceeded: invariantDerived.depthExceeded,
  });

  // 7) 规模警告
  const warnings: string[] = [];
  if (filteredTasks.length > LOGIC_EXPORT_LARGE_NODE_THRESHOLD) {
    warnings.push(
      `节点数(${filteredTasks.length})超过 ${LOGIC_EXPORT_LARGE_NODE_THRESHOLD}，建议继续缩小导出范围`,
    );
  }
  if (exportDerived.depthExceeded) {
    warnings.push(
      `任务树深度至少为 ${maxDepth + 1}，超过上限(${maxDepth})，已截断渲染，请检查是否存在异常嵌套`,
    );
  }
  if (invariantOrphans.length > 0) {
    warnings.push(`发现 ${invariantOrphans.length} 条孤儿连接（端点缺失）`);
  }
  if (invariantDuplicateParentChildConnections.length > 0) {
    warnings.push(
      `发现 ${invariantDuplicateParentChildConnections.length} 条与 parentId 重复的历史父子边（数据污染，建议清理）`,
    );
  }

  // 8) 生成输出
  const ctx: SerializeContext = {
    redactPII,
    includeParking,
    includePlanning,
    maxDepth,
    mode,
  };

  const mermaid =
    options.format !== 'yaml'
      ? buildMermaid(filteredTasks, filteredConnections, ctx)
      : undefined;

  const yaml =
    options.format !== 'mermaid'
      ? buildYaml({
          project,
          tasks: filteredTasks,
          connections: filteredConnections,
          derived: exportDerived,
          invariants,
          ctx,
        })
      : undefined;

  return {
    mermaid,
    yaml,
    invariants,
    warnings,
    stats: {
      totalTasks: filteredTasks.length,
      totalConnections: filteredConnections.length,
      roots: exportDerived.roots.length,
      floatingRoots: exportDerived.floatingRoots.length,
      maxTreeDepth: exportDerived.maxTreeDepth,
    },
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

interface DerivedMetrics {
  readonly roots: string[];
  readonly floatingRoots: string[];
  readonly maxTreeDepth: number;
  readonly depthExceeded: boolean;
  readonly cycles: readonly (readonly string[])[];
}

/**
 * 迭代 BFS 计算 roots / 浮动 roots / 深度；DFS 检测跨树连接环。
 */
function computeDerived(
  tasks: readonly Task[],
  crossTreeConnections: readonly Connection[],
  maxDepth: number,
): DerivedMetrics {
  const taskMap = new Map(tasks.map(t => [t.id, t] as const));
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  const floatingRoots: string[] = [];

  for (const t of tasks) {
    if (t.parentId && taskMap.has(t.parentId)) {
      const arr = childrenOf.get(t.parentId) ?? [];
      arr.push(t.id);
      childrenOf.set(t.parentId, arr);
    } else {
      (t.stage === null ? floatingRoots : roots).push(t.id);
    }
  }

  // 迭代 BFS 计算最大深度
  let maxTreeDepth = 0;
  let depthExceeded = false;
  const stack: Array<{ id: string; depth: number }> = [];
  for (const r of [...roots, ...floatingRoots]) {
    stack.push({ id: r, depth: 1 });
  }
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (depth > maxTreeDepth) maxTreeDepth = depth;
    const kids = childrenOf.get(id);
    if (!kids || kids.length === 0) continue;
    if (depth >= maxDepth) {
      depthExceeded = true;
      continue; // 截断防爆
    }
    for (const k of kids) stack.push({ id: k, depth: depth + 1 });
  }

  const graphEdges: Array<Pick<Connection, 'source' | 'target'>> = [];
  for (const t of tasks) {
    if (t.parentId && taskMap.has(t.parentId)) {
      graphEdges.push({ source: t.parentId, target: t.id });
    }
  }
  for (const connection of crossTreeConnections) {
    graphEdges.push({ source: connection.source, target: connection.target });
  }

  // 环检测覆盖导出图中的全部有向边，避免 parentId + 跨树边的混合环漏报。
  const cycles = detectCycles(tasks.map(t => t.id), graphEdges);

  return {
    roots,
    floatingRoots,
    maxTreeDepth,
    depthExceeded,
    cycles,
  };
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

// ============================================================
// Invariant 检查
// ============================================================

interface InvariantInput {
  readonly tasks: readonly Task[];
  readonly crossTreeConnections: readonly Connection[];
  readonly orphanConnections: readonly Connection[];
  readonly duplicateParentChildConnections: readonly Connection[];
  readonly cycles: readonly (readonly string[])[];
  readonly maxDepth: number;
  readonly actualMaxDepth: number;
  readonly depthExceeded: boolean;
}

function checkInvariants(input: InvariantInput): InvariantCheckResult[] {
  const { tasks, crossTreeConnections, orphanConnections, duplicateParentChildConnections, cycles, maxDepth, actualMaxDepth, depthExceeded } = input;
  const taskMap = new Map(tasks.map(t => [t.id, t] as const));
  const results: InvariantCheckResult[] = [];

  // 1. stage 递增约束
  const stageOffenders: string[] = [];
  for (const t of tasks) {
    if (!t.parentId) continue;
    const parent = taskMap.get(t.parentId);
    if (!parent) continue;
    const parentStage = parent.stage;
    const childStage = t.stage;
    if (parentStage === null && childStage !== null) {
      stageOffenders.push(t.id);
      continue;
    }
    if (parentStage !== null && childStage === null) {
      stageOffenders.push(t.id);
      continue;
    }
    if (parentStage !== null && childStage !== null && childStage !== parentStage + 1) {
      stageOffenders.push(t.id);
    }
  }
  if (stageOffenders.length > 0) {
    results.push({
      code: 'STAGE_CONTINUITY',
      severity: 'error',
      message: 'child.stage 必须等于 parent.stage + 1，或两者同为 null',
      offenders: stageOffenders,
    });
  }

  // 2. 待分配不能做已分配的父
  const floatingParentOffenders: string[] = [];
  for (const t of tasks) {
    if (!t.parentId) continue;
    const p = taskMap.get(t.parentId);
    if (!p) continue;
    if (p.stage === null && t.stage !== null) {
      floatingParentOffenders.push(t.id);
    }
  }
  if (floatingParentOffenders.length > 0) {
    results.push({
      code: 'FLOATING_AS_ASSIGNED_PARENT',
      severity: 'error',
      message: '待分配任务不能作为已分配任务的父节点',
      offenders: floatingParentOffenders,
    });
  }

  // 3. parkingMeta 要求 active
  const parkingOffenders: string[] = [];
  for (const t of tasks) {
    if (t.parkingMeta && t.status !== 'active') {
      parkingOffenders.push(t.id);
    }
  }
  if (parkingOffenders.length > 0) {
    results.push({
      code: 'PARKING_STATUS',
      severity: 'warning',
      message: 'parkingMeta 非空时要求 status === "active"',
      offenders: parkingOffenders,
    });
  }

  // 4. 孤儿连接
  if (orphanConnections.length > 0) {
    results.push({
      code: 'ORPHAN_CONNECTIONS',
      severity: 'error',
      message: 'connection.source/target 指向的 task 不存在（已归档/软删/脏数据）',
      offenders: orphanConnections.map(c => c.id),
    });
  }

  // 5. 父子重复边
  if (duplicateParentChildConnections.length > 0) {
    results.push({
      code: 'DUPLICATE_PARENT_CHILD_EDGE',
      severity: 'warning',
      message: 'connections 含与 parentId 重复的历史父子边，建议清理',
      offenders: duplicateParentChildConnections.map(c => c.id),
    });
  }

  // 6. 跨树环
  if (cycles.length > 0) {
    results.push({
      code: 'CROSS_TREE_CYCLE',
      severity: 'error',
      message: '任务图存在有向环，可能导致依赖推理死锁',
      offenders: cycles.map(c => c.join('->')),
    });
  }

  // 7. 深度溢出
  if (depthExceeded) {
    results.push({
      code: 'TREE_DEPTH_EXCEEDED',
      severity: 'error',
      message: `任务树深度至少为 ${maxDepth + 1}，超过上限 ${maxDepth}`,
      offenders: [],
    });
  }

  // 8. 跨树连接端点均未 archived（隐含在 orphan 检查里，单独显式一条）
  const crossTreeSelfLoop: string[] = [];
  for (const c of crossTreeConnections) {
    if (c.source === c.target) crossTreeSelfLoop.push(c.id);
  }
  if (crossTreeSelfLoop.length > 0) {
    results.push({
      code: 'SELF_LOOP_CONNECTION',
      severity: 'error',
      message: 'connection.source === connection.target（自环）',
      offenders: crossTreeSelfLoop,
    });
  }

  return results;
}

// ============================================================
// Mermaid 序列化
// ============================================================

interface SerializeContext {
  readonly redactPII: boolean;
  readonly includeParking: boolean;
  readonly includePlanning: boolean;
  readonly maxDepth: number;
  readonly mode: 'full' | 'skeleton' | 'stage';
}

function buildMermaid(
  tasks: readonly Task[],
  connections: readonly Connection[],
  ctx: SerializeContext,
): string {
  // 按 stage 分组（null → floating）
  const buckets = new Map<number | 'floating', Task[]>();
  for (const t of tasks) {
    const key: number | 'floating' = t.stage ?? 'floating';
    const arr = buckets.get(key) ?? [];
    arr.push(t);
    buckets.set(key, arr);
  }

  const sortedStageKeys = Array.from(buckets.keys()).sort((a, b) => {
    if (a === 'floating') return -1;
    if (b === 'floating') return 1;
    return (a as number) - (b as number);
  });

  const lines: string[] = [];
  lines.push('flowchart TD');
  lines.push('  %% NanoFlow 逻辑网骨架');
  lines.push('  %% 节点: [[..]]=待分配  ((..))=已分配  {{..}}=已完成  /..\\=停泊中');
  lines.push('  %% 边:   ==>  父子    -. "标签" .->  跨树关联');
  lines.push('');

  for (const key of sortedStageKeys) {
    const stageLabel = key === 'floating' ? '阶段0·待分配' : `阶段${key}`;
    const bucket = buckets.get(key)!;
    lines.push(`  subgraph SG_${key === 'floating' ? 'F' : key}["${mermaidEscape(stageLabel)}"]`);
    for (const t of bucket) {
      lines.push(`    ${renderMermaidNode(t, ctx)}`);
    }
    lines.push('  end');
  }

  // 父子边
  const parentEdges: string[] = [];
  const visibleTaskIds = new Set(tasks.map(t => t.id));
  for (const t of tasks) {
    if (t.parentId && visibleTaskIds.has(t.parentId)) {
      parentEdges.push(`  ${mermaidNodeId(t.parentId)} ==> ${mermaidNodeId(t.id)}`);
    }
  }
  if (parentEdges.length > 0) {
    lines.push('');
    lines.push('  %% ---- 父子关系 ----');
    lines.push(...parentEdges);
  }

  // 跨树边
  if (connections.length > 0) {
    lines.push('');
    lines.push('  %% ---- 跨树关联 ----');
    for (const c of connections) {
      const rawLabel = c.title || '';
      const label = mermaidEscape(truncate(rawLabel, MERMAID_LABEL_MAX));
      if (label) {
        lines.push(`  ${mermaidNodeId(c.source)} -. "${label}" .-> ${mermaidNodeId(c.target)}`);
      } else {
        lines.push(`  ${mermaidNodeId(c.source)} -.-> ${mermaidNodeId(c.target)}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

function renderMermaidNode(t: Task, ctx: SerializeContext): string {
  const id = mermaidNodeId(t.id);
  const title = ctx.redactPII ? redact(t.title) : t.title;
  // 仅 displayId + title：displayId 已承担身份识别作用，UUID 放到 YAML 里
  const displayId = t.displayId || '?';
  const inner = mermaidEscape(
    `${displayId} · ${truncate(title || '(无标题)', MERMAID_LABEL_MAX)}`,
  );

  const isFloating = t.stage === null;
  const isCompleted = t.status === 'completed';
  const isParked = !!t.parkingMeta;

  if (isParked) {
    return `${id}[/"${inner}"/]`;
  }
  if (isCompleted) {
    return `${id}{{"${inner}"}}`;
  }
  if (isFloating) {
    return `${id}[["${inner}"]]`;
  }
  return `${id}(("${inner}"))`;
}

// ============================================================
// YAML 序列化
// ============================================================

interface YamlInput {
  readonly project: Project;
  readonly tasks: readonly Task[];
  readonly connections: readonly Connection[];
  readonly derived: DerivedMetrics;
  readonly invariants: readonly InvariantCheckResult[];
  readonly ctx: SerializeContext;
}

function buildYaml(input: YamlInput): string {
  const { project, tasks, connections, derived, invariants, ctx } = input;
  const w = new YamlWriter();

  // ---- 项目元数据（只保留关系审查必要项） ----
  w.key('project');
  w.indent(() => {
    w.kv('id', project.id);
    w.kv('name', ctx.redactPII ? redact(project.name) : project.name);
    w.kv('mode', ctx.mode);
    w.kv('redacted', ctx.redactPII);
  });

  // ---- 规模聚合（原 derived 的 roots/floating/depth 合并到这里） ----
  w.key('counts');
  w.indent(() => {
    w.kv('tasks', tasks.length);
    w.kv('connections', connections.length);
    w.kv('roots', derived.roots.length);
    w.kv('floating_roots', derived.floatingRoots.length);
    w.kv('max_tree_depth', derived.maxTreeDepth);
  });

  // 建立 id -> task 映射，供关系字段附标题用
  const taskById = new Map(tasks.map(t => [t.id, t] as const));

  // ---- 任务清单（精简：只保留身份 + 关系 + 偏离常态的状态） ----
  // 客观属性（rank / priority / dueDate / tags / updatedAt）
  // 与主观规划（expected_minutes / cognitive_load / wait_minutes）一律不输出。
  w.key('tasks');
  if (tasks.length === 0) {
    w.inlineEmptyList();
  } else {
    w.indent(() => {
      for (const t of tasks) {
        w.listItem(() => renderTask(w, t, taskById, ctx));
      }
    });
  }

  // ---- 跨树关联（每条附双端 displayId + title，避免 AI 回查） ----
  w.key('cross_links');
  if (connections.length === 0) {
    w.inlineEmptyList();
  } else {
    w.indent(() => {
      for (const c of connections) {
        w.listItem(() => renderConnection(w, c, taskById, ctx));
      }
    });
  }

  // ---- 违反的不变式（未违反不输出整块，降低噪声） ----
  if (invariants.length > 0) {
    w.key('invariants_violated');
    w.indent(() => {
      for (const v of invariants) {
        w.listItem(() => {
          w.kv('code', v.code);
          w.kv('severity', v.severity);
          w.kv('count', v.offenders.length);
          w.kv('message', v.message);
          w.kvList('offenders', v.offenders);
        });
      }
    });
  }

  // ---- 环（仅有环时输出） ----
  if (derived.cycles.length > 0) {
    w.key('cycles');
    w.indent(() => {
      for (const c of derived.cycles) {
        w.listItem(() => w.scalar(c.join(' -> ')));
      }
    });
  }

  // ---- 审查规范（静态规则，放末尾给 AI 对照） ----
  w.key('rules');
  w.indent(() => {
    w.listItem(() => w.scalar('parentId 非空：child.stage == parent.stage + 1，或两者同为 null'));
    w.listItem(() => w.scalar('stage == null 的任务不能作为已分配任务的父节点'));
    w.listItem(() => w.scalar('connection.from ≠ connection.to（禁止自环）'));
    w.listItem(() => w.scalar('connection (from,to) 不能与 (parentId,child) 对重复'));
    w.listItem(() => w.scalar(`任务树深度 <= ${ctx.maxDepth}`));
    w.listItem(() => w.scalar('archived / 软删除 / 端点缺失的连接已在导出前剔除'));
  });

  return w.toString();
}

function renderTask(
  w: YamlWriter,
  t: Task,
  taskById: ReadonlyMap<string, Task>,
  ctx: SerializeContext,
): void {
  w.kv('id', t.id);
  w.kv('displayId', t.displayId || '?');
  w.kv('title', ctx.redactPII ? redact(t.title || '') : t.title || '');
  w.kvNullable('stage', t.stage);

  // parent 用父的 displayId 呈现（更易阅读）；若父丢失则回退为父 id
  if (t.parentId) {
    const parent = taskById.get(t.parentId);
    if (parent) {
      w.kv('parent', parent.displayId || parent.id);
    } else {
      w.kv('parent_id_missing', t.parentId);
    }
  }

  // status 仅在偏离常规的 active 时输出（completed/parked 等）
  if (t.status && t.status !== 'active') {
    w.kv('status', t.status);
  }

  if (ctx.includePlanning) {
    const hasPlanning =
      t.expected_minutes != null ||
      t.cognitive_load != null ||
      t.wait_minutes != null;
    if (hasPlanning) {
      w.key('planning');
      w.indent(() => {
        if (t.expected_minutes != null) {
          w.kv('expected_minutes', t.expected_minutes);
        }
        if (t.cognitive_load != null) {
          w.kv('cognitive_load', t.cognitive_load);
        }
        if (t.wait_minutes != null) {
          w.kv('wait_minutes', t.wait_minutes);
        }
      });
    }
  }

  if (ctx.includeParking && t.parkingMeta) {
    w.key('parking_meta');
    w.indent(() => {
      w.kv('state', t.parkingMeta.state);
      w.kvNullable('parked_at', t.parkingMeta.parkedAt);
      w.kvNullable('last_visited_at', t.parkingMeta.lastVisitedAt);
      if (t.parkingMeta.pinned) {
        w.kv('pinned', true);
      }
    });
  }
}

function renderConnection(
  w: YamlWriter,
  c: Connection,
  taskById: ReadonlyMap<string, Task>,
  ctx: SerializeContext,
): void {
  const src = taskById.get(c.source);
  const tgt = taskById.get(c.target);
  const rawLabel = c.title ?? '';
  const label = ctx.redactPII ? redact(rawLabel) : rawLabel;
  w.kv('label', label);
  w.kv('from_displayId', src?.displayId || src?.id || c.source);
  if (src) {
    w.kv('from_title', ctx.redactPII ? redact(src.title || '') : src.title || '');
  }
  w.kv('to_displayId', tgt?.displayId || tgt?.id || c.target);
  if (tgt) {
    w.kv('to_title', ctx.redactPII ? redact(tgt.title || '') : tgt.title || '');
  }
}

// ============================================================
// YamlWriter（手写简易安全输出器）
// ============================================================

/**
 * 最小 YAML 输出器：
 *  - 标量：使用 JSON.stringify(双引号 flow scalar)，对所有特殊字符安全
 *  - 块标量：多行字符串用 `|` 保留换行
 *  - 列表：每项前缀 `- ` + 嵌套缩进
 *
 * 不支持锚点/引用/tag，刻意保持简单。
 */
class YamlWriter {
  private readonly buf: string[] = [];
  private depth = 0;
  private pendingListItem = false;

  toString(): string {
    return this.buf.join('\n') + '\n';
  }

  private prefix(): string {
    return '  '.repeat(this.depth);
  }

  line(text: string): void {
    if (this.pendingListItem) {
      // 首行：用“上一级”前缀 + "- "，让 "-" 之后的字段与后续子字段的列对齐
      //   e.g.  depth=2 时：首行前缀 "  "（1 级）+ "- "，后续子字段前缀 "    "（2 级）
      const outerPrefix = '  '.repeat(Math.max(0, this.depth - 1));
      this.buf.push(outerPrefix + '- ' + text);
      this.pendingListItem = false;
    } else {
      this.buf.push(this.prefix() + text);
    }
  }

  /** 裸键（值在下一层） */
  key(name: string): void {
    this.line(`${safeYamlKey(name)}:`);
  }

  /** 键值对（标量值，自动选择 flow/block） */
  kv(name: string, value: string | number | boolean | null): void {
    this.line(`${safeYamlKey(name)}: ${yamlScalar(value)}`);
  }

  /** 允许 null 的键值对 */
  kvNullable(name: string, value: string | number | boolean | null | undefined): void {
    this.kv(name, value ?? null);
  }

  /** 键值对（强制用 block scalar，用于多行文本） */
  kvBlock(name: string, value: string): void {
    if (value === '') {
      this.line(`${safeYamlKey(name)}: ""`);
      return;
    }
    if (YAML_BLOCK_SCALAR_TRIGGERS.test(value)) {
      this.line(`${safeYamlKey(name)}: |-`);
      this.depth++;
      for (const l of value.split(/\r?\n/)) {
        this.buf.push(this.prefix() + l);
      }
      this.depth--;
    } else {
      this.line(`${safeYamlKey(name)}: ${yamlScalar(value)}`);
    }
  }

  /** 字符串/数字/布尔数组 */
  kvList(name: string, arr: readonly (string | number | boolean)[]): void {
    if (arr.length === 0) {
      this.line(`${safeYamlKey(name)}: []`);
      return;
    }
    this.key(name);
    this.depth++;
    for (const v of arr) {
      this.line(`- ${yamlScalar(v)}`);
    }
    this.depth--;
  }

  listItem(fn: () => void): void {
    this.pendingListItem = true;
    this.depth++;
    try {
      fn();
      if (this.pendingListItem) {
        // 空 item 兜底
        this.line('~');
      }
    } finally {
      this.depth--;
    }
  }

  indent(fn: () => void): void {
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
    }
  }

  inlineEmptyList(): void {
    const last = this.buf.pop();
    if (last !== undefined) {
      this.buf.push(last + ' []');
    } else {
      this.buf.push('[]');
    }
  }

  scalar(value: string | number | boolean | null): void {
    this.line(yamlScalar(value));
  }
}

// ============================================================
// 小工具
// ============================================================

function edgeKey(source: string, target: string): string {
  return `${source}->${target}`;
}

function mermaidNodeId(taskId: string): string {
  // 将 UUID 转换为 Mermaid 合法 id（仅字母数字与下划线）
  return 'N_' + taskId.replace(/[^A-Za-z0-9]/g, '_');
}

function mermaidEscape(value: string): string {
  // 转义 Mermaid label 中会破坏语法的字符
  // 注意：`<` / `>` / `#` 在双引号包裹下本是安全的，但启用 htmlLabels 时
  // `<>` 会被当 HTML 解析；这里统一转为 HTML 实体以保留字面含义。
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '／');
}

function truncate(value: string, max: number): string {
  if (!value) return '';
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

function redact(value: string): string {
  if (!value) return '';
  // 非可逆轻量脱敏：保留首尾各 1 字符 + 长度摘要
  const len = value.length;
  if (len <= 2) return '*'.repeat(len);
  return `${value[0]}***${value[len - 1]}(len=${len})`;
}

function safeYamlKey(key: string): string {
  // 键名只允许 ASCII 字母/数字/下划线；否则用 JSON 字符串包裹
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return String(value);
    return 'null';
  }
  // 字符串一律用 JSON 双引号（是合法的 YAML flow scalar，且对所有字符安全）
  return JSON.stringify(value);
}
