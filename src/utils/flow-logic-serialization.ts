import type { Project, Task, Connection } from '../models';
import type { InvariantCheckResult } from './flow-logic-export';
import { YamlWriter } from './yaml-writer';

/** Mermaid label 最大字符数（超过截断 + …） */
const MERMAID_LABEL_MAX = 40;

export interface SerializeContext {
  readonly redactPII: boolean;
  readonly includeParking: boolean;
  readonly includePlanning: boolean;
  readonly maxDepth: number;
  readonly mode: 'full' | 'skeleton' | 'stage';
}

interface DerivedMetricsLike {
  readonly roots: readonly string[];
  readonly floatingRoots: readonly string[];
  readonly maxTreeDepth: number;
  readonly cycles: readonly (readonly string[])[];
}

// ============================================================
// Mermaid 序列化
// ============================================================

export function buildMermaid(
  tasks: readonly Task[],
  connections: readonly Connection[],
  ctx: SerializeContext,
): string {
  const lines: string[] = [];
  appendMermaidHeader(lines);
  appendMermaidStageGroups(lines, groupTasksByStage(tasks), ctx);
  appendMermaidParentEdges(lines, tasks);
  appendMermaidCrossTreeEdges(lines, connections);

  return lines.join('\n') + '\n';
}

type MermaidStageKey = number | 'floating';

function groupTasksByStage(tasks: readonly Task[]): Map<MermaidStageKey, Task[]> {
  const buckets = new Map<MermaidStageKey, Task[]>();
  for (const task of tasks) {
    const key: MermaidStageKey = task.stage ?? 'floating';
    const bucket = buckets.get(key) ?? [];
    bucket.push(task);
    buckets.set(key, bucket);
  }
  return buckets;
}

function sortedMermaidStageKeys(buckets: ReadonlyMap<MermaidStageKey, readonly Task[]>): MermaidStageKey[] {
  return Array.from(buckets.keys()).sort((a, b) => {
    if (a === 'floating') return -1;
    if (b === 'floating') return 1;
    return a - b;
  });
}

function appendMermaidHeader(lines: string[]): void {
  lines.push('flowchart TD');
  lines.push('  %% NanoFlow 逻辑网骨架');
  lines.push('  %% 节点: [[..]]=待分配  ((..))=已分配  {{..}}=已完成  /..\\=停泊中');
  lines.push('  %% 边:   ==>  父子    -. "标签" .->  跨树关联');
  lines.push('');
}

function appendMermaidStageGroups(
  lines: string[],
  buckets: ReadonlyMap<MermaidStageKey, readonly Task[]>,
  ctx: SerializeContext,
): void {
  for (const key of sortedMermaidStageKeys(buckets)) {
    const stageLabel = key === 'floating' ? '阶段0·待分配' : `阶段${key}`;
    const bucket = buckets.get(key) ?? [];
    lines.push(`  subgraph SG_${key === 'floating' ? 'F' : key}["${mermaidEscape(stageLabel)}"]`);
    for (const task of bucket) {
      lines.push(`    ${renderMermaidNode(task, ctx)}`);
    }
    lines.push('  end');
  }
}

function appendMermaidParentEdges(lines: string[], tasks: readonly Task[]): void {
  const parentEdges: string[] = [];
  const visibleTaskIds = new Set(tasks.map(task => task.id));
  for (const task of tasks) {
    if (task.parentId && visibleTaskIds.has(task.parentId)) {
      parentEdges.push(`  ${mermaidNodeId(task.parentId)} ==> ${mermaidNodeId(task.id)}`);
    }
  }
  if (parentEdges.length > 0) {
    lines.push('');
    lines.push('  %% ---- 父子关系 ----');
    lines.push(...parentEdges);
  }
}

function appendMermaidCrossTreeEdges(lines: string[], connections: readonly Connection[]): void {
  if (connections.length > 0) {
    lines.push('');
    lines.push('  %% ---- 跨树关联 ----');
    for (const connection of connections) {
      const rawLabel = connection.title || '';
      const label = mermaidEscape(truncate(rawLabel, MERMAID_LABEL_MAX));
      if (label) {
        lines.push(`  ${mermaidNodeId(connection.source)} -. "${label}" .-> ${mermaidNodeId(connection.target)}`);
      } else {
        lines.push(`  ${mermaidNodeId(connection.source)} -.-> ${mermaidNodeId(connection.target)}`);
      }
    }
  }
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
  readonly derived: DerivedMetricsLike;
  readonly invariants: readonly InvariantCheckResult[];
  readonly ctx: SerializeContext;
}

export function buildYaml(input: YamlInput): string {
  const { project, tasks, connections, derived, invariants, ctx } = input;
  const w = new YamlWriter();
  const taskById = new Map(tasks.map(t => [t.id, t] as const));

  writeProjectYaml(w, project, ctx);
  writeCountsYaml(w, tasks, connections, derived);
  writeTasksYaml(w, tasks, taskById, ctx);
  writeCrossLinksYaml(w, connections, taskById, ctx);
  writeInvariantsYaml(w, invariants);
  writeCyclesYaml(w, derived.cycles);
  writeRulesYaml(w, ctx);

  return w.toString();
}

function writeProjectYaml(w: YamlWriter, project: Project, ctx: SerializeContext): void {
  w.key('project');
  w.indent(() => {
    w.kv('id', project.id);
    w.kv('name', ctx.redactPII ? redact(project.name) : project.name);
    w.kv('mode', ctx.mode);
    w.kv('redacted', ctx.redactPII);
  });
}

function writeCountsYaml(
  w: YamlWriter,
  tasks: readonly Task[],
  connections: readonly Connection[],
  derived: DerivedMetricsLike,
): void {
  w.key('counts');
  w.indent(() => {
    w.kv('tasks', tasks.length);
    w.kv('connections', connections.length);
    w.kv('roots', derived.roots.length);
    w.kv('floating_roots', derived.floatingRoots.length);
    w.kv('max_tree_depth', derived.maxTreeDepth);
  });
}

function writeTasksYaml(
  w: YamlWriter,
  tasks: readonly Task[],
  taskById: ReadonlyMap<string, Task>,
  ctx: SerializeContext,
): void {
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
}

function writeCrossLinksYaml(
  w: YamlWriter,
  connections: readonly Connection[],
  taskById: ReadonlyMap<string, Task>,
  ctx: SerializeContext,
): void {
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
}

function writeInvariantsYaml(
  w: YamlWriter,
  invariants: readonly InvariantCheckResult[],
): void {
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
}

function writeCyclesYaml(w: YamlWriter, cycles: readonly (readonly string[])[]): void {
  if (cycles.length > 0) {
    w.key('cycles');
    w.indent(() => {
      for (const cycle of cycles) {
        w.listItem(() => w.scalar(cycle.join(' -> ')));
      }
    });
  }
}

function writeRulesYaml(w: YamlWriter, ctx: SerializeContext): void {
  w.key('rules');
  w.indent(() => {
    w.listItem(() => w.scalar('parentId 非空：child.stage == parent.stage + 1，或两者同为 null'));
    w.listItem(() => w.scalar('stage == null 的任务不能作为已分配任务的父节点'));
    w.listItem(() => w.scalar('connection.from ≠ connection.to（禁止自环）'));
    w.listItem(() => w.scalar('connection (from,to) 不能与 (parentId,child) 对重复'));
    w.listItem(() => w.scalar(`任务树深度 <= ${ctx.maxDepth}`));
    w.listItem(() => w.scalar('archived / 软删除 / 端点缺失的连接已在导出前剔除'));
  });
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

  writeTaskParent(w, t, taskById);
  writeTaskStatus(w, t);
  writeTaskPlanning(w, t, ctx);
  writeTaskParkingMeta(w, t, ctx);
}

function writeTaskParent(
  w: YamlWriter,
  t: Task,
  taskById: ReadonlyMap<string, Task>,
): void {
  if (t.parentId) {
    const parent = taskById.get(t.parentId);
    if (parent) {
      w.kv('parent', parent.displayId || parent.id);
    } else {
      w.kv('parent_id_missing', t.parentId);
    }
  }
}

function writeTaskStatus(w: YamlWriter, t: Task): void {
  if (t.status && t.status !== 'active') {
    w.kv('status', t.status);
  }
}

function writeTaskPlanning(w: YamlWriter, t: Task, ctx: SerializeContext): void {
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
}

function writeTaskParkingMeta(w: YamlWriter, t: Task, ctx: SerializeContext): void {
  const parkingMeta = t.parkingMeta;

  if (ctx.includeParking && parkingMeta) {
    w.key('parking_meta');
    w.indent(() => {
      w.kv('state', parkingMeta.state);
      w.kvNullable('parked_at', parkingMeta.parkedAt);
      w.kvNullable('last_visited_at', parkingMeta.lastVisitedAt);
      if (parkingMeta.pinned) {
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
