/**
 * 流程图「项目脉络」导出纯函数模块
 *
 * 目的：把 Project（tasks + connections）重构成一份**面向主观思路审阅**的 Markdown 大纲，
 *      以主任务为核心，保留标题、内容摘要、父子层级、关联块的语义。
 *      这份 Markdown 是**通用大纲**：既能自我复盘、存档、分享，也可以粘给 AI 做战略分析
 *      （文末附带可选的 AI 战略顾问 system prompt，按需裁剪）。
 *
 * 与 flow-logic-export（已废弃）不同，本模块刻意忽略 stage / parentId / priority /
 * dueDate / tags / estimate / displayId / UUID 等客观与实现属性，让读者（人或 AI）
 * 围绕「完整性 / 合理性 / 主任务支撑度」发挥。
 *
 * 设计原则：
 *   1. 权威源：只读 Project
 *   2. 过滤：archived / deletedAt 整体剔除；默认包含 completed（需要看全貌）
 *   3. 主任务识别：
 *        - 候选 = 所有无 parentId 的任务
 *        - 评分 = 后代数×2 + 关联块进出度×1（降序）
 *        - Tie-breaker: stage === null 的根降权（浮动根通常是草稿），再按 title 非空
 *   4. 不输出 displayId / UUID / stage / parentId / priority / dueDate / tags /
 *      expected_minutes / cognitive_load / wait_minutes / updatedAt / createdDate
 *   5. completed 任务以 ✓ 前缀提示「已推进到哪」
 *   6. 关联块（connection.title + description）以自然语言句式呈现
 *   7. AI 战略顾问 system prompt 放在**文末的可选附录**，不影响普通阅读
 *   8. 纯函数、无 DI、可测试
 *
 * @see AGENTS.md Hard Rules（树深上限 100，仅迭代不递归）
 */

import type { Project, Task, Connection } from '../models';

// ============================================================
// 常量
// ============================================================

/** 与 FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH 对齐 */
const STRATEGIC_MAX_DEPTH = 100;

/** 单个任务内容摘要的最大字符数（首行 + 截断，避免 AI 输入过长） */
const CONTENT_EXCERPT_MAX = 120;

/** 跨树关联块描述摘要的最大字符数 */
const LINK_DESC_EXCERPT_MAX = 160;

/** 超过该节点数发出规模提示（不阻断） */
const STRATEGIC_LARGE_NODE_THRESHOLD = 200;

// ============================================================
// 对外类型
// ============================================================

export interface StrategicReviewOptions {
  /** 是否包含 completed 任务（默认 true：让 AI 看见推进轨迹） */
  readonly includeCompleted?: boolean;
  /** 是否对 title / content 做轻量脱敏（默认 false） */
  readonly redactPII?: boolean;
  /** 深度上限（默认 STRATEGIC_MAX_DEPTH） */
  readonly maxDepth?: number;
}

export interface StrategicReviewResult {
  readonly markdown: string;
  readonly stats: {
    readonly totalTasks: number;
    readonly totalConnections: number;
    readonly mainTaskTitle: string;
    readonly roots: number;
    readonly maxTreeDepth: number;
  };
  readonly warnings: readonly string[];
}

// ============================================================
// 主入口
// ============================================================

export function buildStrategicReviewMarkdown(
  project: Project,
  options: StrategicReviewOptions = {},
): StrategicReviewResult {
  const includeCompleted = options.includeCompleted ?? true;
  const redactPII = options.redactPII ?? false;
  const maxDepth = options.maxDepth ?? STRATEGIC_MAX_DEPTH;

  const visibleTasks = filterTasks(project.tasks, includeCompleted);
  const taskIds = new Set(visibleTasks.map(t => t.id));
  const taskById = new Map(visibleTasks.map(t => [t.id, t] as const));

  const childrenOf = buildChildrenMap(visibleTasks, taskIds);
  const rootIds = visibleTasks.filter(t => !t.parentId || !taskIds.has(t.parentId)).map(t => t.id);

  const crossLinks = project.connections.filter(
    c => !c.deletedAt && taskIds.has(c.source) && taskIds.has(c.target),
  );

  const descendantCount = computeDescendantCounts(rootIds, childrenOf, maxDepth);
  const linkDegree = computeLinkDegree(crossLinks);
  const mainTaskId = pickMainTask(rootIds, taskById, descendantCount, linkDegree);
  const maxTreeDepth = computeMaxDepth(rootIds, childrenOf, maxDepth);

  const ctx: RenderCtx = { redactPII, taskById, childrenOf, maxDepth };
  const markdown = renderMarkdown({
    project,
    visibleTasks,
    rootIds,
    mainTaskId,
    crossLinks,
    ctx,
  });

  const warnings: string[] = [];
  if (visibleTasks.length > STRATEGIC_LARGE_NODE_THRESHOLD) {
    warnings.push(
      `节点数 ${visibleTasks.length} 超过 ${STRATEGIC_LARGE_NODE_THRESHOLD}，AI 输入较长，必要时可按子树分批审阅`,
    );
  }
  if (maxTreeDepth >= maxDepth) {
    warnings.push(`任务树深度达到上限 ${maxDepth}，已截断；如非预期请检查数据`);
  }

  const mainTitle = mainTaskId
    ? (taskById.get(mainTaskId)?.title || '(未命名主任务)')
    : '(无主任务)';

  return {
    markdown,
    stats: {
      totalTasks: visibleTasks.length,
      totalConnections: crossLinks.length,
      mainTaskTitle: mainTitle,
      roots: rootIds.length,
      maxTreeDepth,
    },
    warnings,
  };
}

// ============================================================
// 过滤 / 派生
// ============================================================

function filterTasks(tasks: readonly Task[], includeCompleted: boolean): Task[] {
  return tasks.filter(t => {
    if (t.deletedAt) return false;
    if (t.status === 'archived') return false;
    if (!includeCompleted && t.status === 'completed') return false;
    return true;
  });
}

function buildChildrenMap(
  tasks: readonly Task[],
  validIds: ReadonlySet<string>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const t of tasks) {
    if (!t.parentId || !validIds.has(t.parentId)) continue;
    const arr = map.get(t.parentId) ?? [];
    arr.push(t.id);
    map.set(t.parentId, arr);
  }
  // 子节点按 order、再按 rank 稳定排序，保证输出确定性
  for (const [, arr] of map) {
    const byId = new Map(tasks.map(t => [t.id, t] as const));
    arr.sort((a, b) => {
      const ta = byId.get(a);
      const tb = byId.get(b);
      if (!ta || !tb) return 0;
      if (ta.order !== tb.order) return ta.order - tb.order;
      return ta.rank - tb.rank;
    });
  }
  return map;
}

function computeDescendantCounts(
  rootIds: readonly string[],
  childrenOf: ReadonlyMap<string, readonly string[]>,
  maxDepth: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  // 迭代 DFS：后序填 counts
  for (const root of rootIds) {
    const stack: Array<{ id: string; iter: number; depth: number }> = [
      { id: root, iter: 0, depth: 1 },
    ];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const kids = childrenOf.get(top.id) ?? [];
      if (top.iter < kids.length && top.depth < maxDepth) {
        stack.push({ id: kids[top.iter++], iter: 0, depth: top.depth + 1 });
      } else {
        let total = 0;
        for (const k of kids) total += (counts.get(k) ?? 0) + 1;
        counts.set(top.id, total);
        stack.pop();
      }
    }
  }
  return counts;
}

function computeMaxDepth(
  rootIds: readonly string[],
  childrenOf: ReadonlyMap<string, readonly string[]>,
  maxDepth: number,
): number {
  let deepest = 0;
  const stack: Array<{ id: string; depth: number }> = rootIds.map(id => ({ id, depth: 1 }));
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    if (depth >= maxDepth) continue;
    const kids = childrenOf.get(id);
    if (!kids) continue;
    for (const k of kids) stack.push({ id: k, depth: depth + 1 });
  }
  return deepest;
}

function computeLinkDegree(links: readonly Connection[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const c of links) {
    degree.set(c.source, (degree.get(c.source) ?? 0) + 1);
    degree.set(c.target, (degree.get(c.target) ?? 0) + 1);
  }
  return degree;
}

function pickMainTask(
  rootIds: readonly string[],
  taskById: ReadonlyMap<string, Task>,
  descendantCount: ReadonlyMap<string, number>,
  linkDegree: ReadonlyMap<string, number>,
): string | null {
  if (rootIds.length === 0) return null;
  if (rootIds.length === 1) return rootIds[0];

  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const id of rootIds) {
    const t = taskById.get(id);
    if (!t) continue;
    const desc = descendantCount.get(id) ?? 0;
    const deg = linkDegree.get(id) ?? 0;
    // 浮动根（stage === null）作为草稿池，降权
    const floatingPenalty = t.stage === null ? -5 : 0;
    // 无标题的根几乎不可能是主任务
    const titlePenalty = (t.title || '').trim() === '' ? -3 : 0;
    const score = desc * 2 + deg + floatingPenalty + titlePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

// ============================================================
// Markdown 渲染
// ============================================================

interface RenderCtx {
  readonly redactPII: boolean;
  readonly taskById: ReadonlyMap<string, Task>;
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly maxDepth: number;
}

interface RenderInput {
  readonly project: Project;
  readonly visibleTasks: readonly Task[];
  readonly rootIds: readonly string[];
  readonly mainTaskId: string | null;
  readonly crossLinks: readonly Connection[];
  readonly ctx: RenderCtx;
}

function renderMarkdown(input: RenderInput): string {
  const { project, visibleTasks, rootIds, mainTaskId, crossLinks, ctx } = input;
  const parts: string[] = [];

  // 主体：面向人+AI 的通用项目大纲（标题 / 主任务 / 层级 / 关联）
  parts.push(renderProjectHeader(project, ctx));
  parts.push('');
  parts.push(renderMainTaskSection(mainTaskId, ctx));
  parts.push('');
  parts.push(renderTaskTreeSection(rootIds, mainTaskId, ctx));
  parts.push('');
  parts.push(renderRelationBlocksSection(crossLinks, ctx));
  parts.push('');
  // 可选附录：交给 AI 做战略评估时使用，普通阅读可以忽略
  parts.push('---');
  parts.push('');
  parts.push(renderAdvisorAppendix(visibleTasks.length, crossLinks.length));
  return parts.join('\n');
}

/**
 * 可选附录：如果要把本文件粘给 AI 做战略分析，请把 system prompt 段落
 * 拷贝到 AI 的系统提示词里，然后把上面的主体作为用户输入。
 */
function renderAdvisorAppendix(taskCount: number, linkCount: number): string {
  const lines: string[] = [];
  lines.push('## 附录：交给 AI 做战略分析（可选）');
  lines.push('');
  lines.push(`本文件描述的关系网包含 **${taskCount}** 个任务 与 **${linkCount}** 个关联块。`);
  lines.push('如果你希望让 AI 基于上面的大纲给出**主观思路层面的建议与批判**，');
  lines.push('可以把下面这段粘贴为 AI 的 system prompt，再把本文件前半部分作为用户消息发送。');
  lines.push('（如果只是存档或分享给人，附录可以直接删除。）');
  lines.push('');
  lines.push('```');
  lines.push(renderAdvisorSystemPrompt());
  lines.push('```');
  return lines.join('\n');
}

function renderAdvisorSystemPrompt(): string {
  return [
    '你是「项目关系战略洞察师」，一位极具洞察力和创造力的 AI 顾问。',
    '',
    '你的核心使命是：把用户导出的流程图/任务关系网，转化为**对用户主观思路的深刻评价 + 建设性建议**，而不是任何技术规则或错误列表。',
    '',
    '【严格遵守以下原则】',
    '1. **只谈主观思路与逻辑合理性**，完全忽略：优先级、到期日、标签、估算、代码实现、数据库字段、parentId/stage 等一切客观属性和技术细节。',
    '2. **必须识别「主任务」**（通常是根节点、无父任务、或用户最核心的目标）。所有分析都必须围绕「这个主任务是否能被当前关系网很好地支撑」展开。',
    '3. **聚焦三个核心维度**（必须在输出中体现）：',
    '   - **完整性（缺漏检测）**：根据主任务的主题和目标，判断当前任务块/标题所关联的任务是否完整？有没有明显应该存在但缺失的子任务、依赖或步骤？',
    '   - **合理性（关联逻辑）**：各个任务块之间的连接是否符合常理？逻辑流是否顺畅？跨块关联是否真正服务于主任务，还是显得突兀或多余？',
    '   - **关系强度与主任务一致性**：强调「这个关系对实现主任务的战略价值」，而不是「是否符合某种规则」。',
    '4. **输出风格要求**（必须严格执行）：',
    '   - 用自然、温暖、专业且富有洞察力的语言，像一位资深产品/项目战略顾问在和用户深度对话。',
    '   - 结构清晰但不死板：可用小标题分段，但避免任何表格、代码块、违规列表、warning/error 格式。',
    '   - **建议必须高度随机应变、多样化**：根据导出内容的「主题大任务」实时变化风格（产品类偏策略+体验；营销类偏增长+渠道；学习类偏知识体系+里程碑）。每一次导出都要有新鲜感，避免重复句式。',
    '   - 建议数量控制在 6-9 条，兼顾「战略层、战术层、创新层、风险层、落地层」。',
    '5. **美好期待**：这个导出功能存在的意义，是成为用户「思路的放大镜和催化剂」——帮用户看见没意识到的缺漏、理清模糊的关系、激发更好的执行路径。',
    '',
    '【输出结构模板】（请严格按此顺序，语言自然流畅）：',
    '1. **整体印象**（1-2 段）：先肯定关系网在体现用户主观思路上的亮点，再自然过渡到可优化的空间。',
    '2. **主任务支撑度评估**：关系网对主任务的逻辑支撑如何？强在哪里？弱在哪里？',
    '3. **完整性洞察**：是否存在明显缺漏？哪些任务块/标题下应该再补充什么内容才能让主任务更圆满？',
    '4. **关联合理性分析**：各个任务块之间的连接是否顺畅？有没有可以优化或重新归类的关系？',
    '5. **核心关系亮点**：挑出 2-4 个你认为最有价值的关系，说明它对主任务的战略意义。',
    '6. **创意建议**（最重要部分）：给出 6-9 条主题自适应、多变且可执行的建议。每条建议都要具体到主任务的语境，说明「为什么这样改会让项目更强」。',
    '7. **结语**：用鼓励且富有远见的语言结束，激发用户继续优化的热情。',
    '',
    '下面是用户提供的关系网大纲，请基于这些内容开始分析。',
  ].join('\n');
}

function renderProjectHeader(project: Project, ctx: RenderCtx): string {
  const name = ctx.redactPII ? redact(project.name) : (project.name || '(未命名项目)');
  const desc = project.description
    ? (ctx.redactPII ? redact(project.description) : project.description).trim()
    : '';
  const lines: string[] = [];
  lines.push(`## 项目：${escapeInline(name)}`);
  if (desc) {
    lines.push('');
    lines.push('**项目说明（用户的自述目标）**：');
    lines.push('');
    lines.push(blockquote(desc));
  }
  return lines.join('\n');
}

function renderMainTaskSection(mainTaskId: string | null, ctx: RenderCtx): string {
  const lines: string[] = [];
  lines.push('## 主任务');
  lines.push('');
  if (!mainTaskId) {
    lines.push('_当前关系网尚无明确主任务。可以把所有根节点视为并列主题，思考是否应指定一个核心目标。_');
    return lines.join('\n');
  }
  const t = ctx.taskById.get(mainTaskId);
  if (!t) {
    lines.push('_主任务识别失败，请以关系网中信息量最大的根节点为起点阅读。_');
    return lines.join('\n');
  }
  const title = renderText(t.title || '(未命名任务)', ctx.redactPII);
  const excerpt = contentExcerpt(t.content, ctx.redactPII);
  lines.push(`**${escapeInline(title)}**`);
  if (excerpt) {
    lines.push('');
    lines.push(blockquote(excerpt));
  }
  return lines.join('\n');
}

function renderTaskTreeSection(
  rootIds: readonly string[],
  mainTaskId: string | null,
  ctx: RenderCtx,
): string {
  const lines: string[] = [];
  lines.push('## 任务层级（父子即「子任务是主任务的组成部分」）');
  lines.push('');
  if (rootIds.length === 0) {
    lines.push('_（当前没有任务）_');
    return lines.join('\n');
  }
  // 主任务优先呈现
  const ordered = mainTaskId
    ? [mainTaskId, ...rootIds.filter(id => id !== mainTaskId)]
    : [...rootIds];
  for (const rootId of ordered) {
    appendTreeLines(lines, rootId, 0, ctx);
  }
  return lines.join('\n');
}

function appendTreeLines(out: string[], taskId: string, depth: number, ctx: RenderCtx): void {
  // 迭代 DFS（避免递归），深度上限保护
  const stack: Array<{ id: string; depth: number }> = [{ id: taskId, depth }];
  while (stack.length > 0) {
    const { id, depth: d } = stack.pop()!;
    if (d >= ctx.maxDepth) continue;
    const t = ctx.taskById.get(id);
    if (!t) continue;
    const indent = '  '.repeat(d);
    const mark = t.status === 'completed' ? '✓ ' : '';
    const title = renderText(t.title || '(未命名)', ctx.redactPII);
    const excerpt = contentExcerpt(t.content, ctx.redactPII);
    const inlineExcerpt = excerpt ? ` — ${escapeInline(excerpt)}` : '';
    out.push(`${indent}- ${mark}${escapeInline(title)}${inlineExcerpt}`);
    const kids = ctx.childrenOf.get(id) ?? [];
    // 反向压栈保证输出顺序与 kids 一致
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ id: kids[i], depth: d + 1 });
    }
  }
}

function renderRelationBlocksSection(links: readonly Connection[], ctx: RenderCtx): string {
  const lines: string[] = [];
  lines.push('## 关联块（跨越父子层级的关系网）');
  lines.push('');
  if (links.length === 0) {
    lines.push('_当前没有跨层级关联块。如果主任务依赖大量横向协作，可能说明关系网还不够丰富。_');
    return lines.join('\n');
  }
  lines.push('下面每一条代表一个「关联块」——用户主观认为两个任务之间存在超越父子层级的联系：');
  lines.push('');
  for (const c of links) {
    const src = ctx.taskById.get(c.source);
    const tgt = ctx.taskById.get(c.target);
    const srcTitle = escapeInline(renderText(src?.title || '?', ctx.redactPII));
    const tgtTitle = escapeInline(renderText(tgt?.title || '?', ctx.redactPII));
    const label = c.title ? renderText(c.title, ctx.redactPII).trim() : '';
    const desc = c.description
      ? truncate(renderText(c.description, ctx.redactPII).trim(), LINK_DESC_EXCERPT_MAX)
      : '';
    const labelPart = label ? `「${escapeInline(label)}」` : '（未命名关联块）';
    const descPart = desc ? `　说明：${escapeInline(desc)}` : '';
    lines.push(`- **${srcTitle}** ↔ **${tgtTitle}**：${labelPart}${descPart}`);
  }
  return lines.join('\n');
}

// ============================================================
// 文本工具
// ============================================================

function renderText(s: string, redactPII: boolean): string {
  if (!s) return '';
  return redactPII ? redact(s) : s;
}

function redact(s: string): string {
  if (!s) return '';
  // 保留首尾各 1 字符，中间折叠为 ***，便于 AI 仍能感受到标题密度但无法识别具体内容
  const trimmed = s.trim();
  if (trimmed.length <= 2) return trimmed;
  return `${trimmed[0]}***${trimmed[trimmed.length - 1]}`;
}

function contentExcerpt(content: string | undefined, redactPII: boolean): string {
  if (!content) return '';
  // 取首个非空行；Markdown 符号保留即可，上游会转义关键字符
  const firstLine = content.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0);
  if (!firstLine) return '';
  const text = redactPII ? redact(firstLine) : firstLine;
  return truncate(text, CONTENT_EXCERPT_MAX);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function escapeInline(s: string): string {
  // 仅转义可能破坏 Markdown 行结构的字符；保持可读
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function blockquote(s: string): string {
  return s
    .split(/\r?\n/)
    .map(line => `> ${line}`)
    .join('\n');
}
