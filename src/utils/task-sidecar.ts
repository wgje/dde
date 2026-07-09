import { Task, TaskAttentionDraftItem, TaskAttentionMeta } from '../models';

export type TaskSidecarTone = 'attention' | 'risk' | 'wait' | 'load' | 'time' | 'resource' | 'state' | 'tag';

export interface TaskSidecarBadge {
  id: string;
  label: string;
  tone: TaskSidecarTone;
  tooltipText?: string;
}

export interface TaskSidecarSummary {
  badges: TaskSidecarBadge[];
  tooltipLines: string[];
  hasSignals: boolean;
  riskCount: number;
}

export interface BuildTaskSidecarSummaryOptions {
  knowledgeAnchorCount?: number;
  isDocked?: boolean;
  isDockFocused?: boolean;
  now?: Date;
}

const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TAG_BADGES = 2;

export function taskAttentionMetaToText(meta: TaskAttentionMeta | null | undefined): string {
  return (meta?.items ?? [])
    .filter(item => !item.done && item.text.trim().length > 0)
    .map(item => item.text.trim())
    .join('\n');
}

export function taskAttentionMetaToDraftItems(meta: TaskAttentionMeta | null | undefined): TaskAttentionDraftItem[] {
  return (meta?.items ?? [])
    .filter(item => !item.done && item.text.trim().length > 0)
    .map(item => ({
      id: item.id,
      text: item.text.trim(),
      level: item.level,
      done: item.done,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
}

export function taskAttentionDraftItemsToText(items: readonly TaskAttentionDraftItem[]): string {
  return items.map(item => item.text).join('\n');
}

export function taskAttentionTextToDraftItems(
  text: string,
  existingMeta?: TaskAttentionMeta | null,
): TaskAttentionDraftItem[] {
  const existingActiveItems = (existingMeta?.items ?? []).filter(item => !item.done);
  const existingItemsByText = new Map<string, typeof existingActiveItems>();
  for (const item of existingActiveItems) {
    const key = item.text.trim();
    if (!key) continue;
    const items = existingItemsByText.get(key) ?? [];
    items.push(item);
    existingItemsByText.set(key, items);
  }

  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const matchingItems = existingItemsByText.get(line);
      const existing = matchingItems?.shift();
      return {
        id: existing?.id,
        text: line,
        level: existing?.level ?? 'info',
        done: existing?.done ?? false,
        createdAt: existing?.createdAt,
      };
    });
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function readRiskReasons(task: Task, now: Date): string[] {
  if (task.status === 'archived') return [];

  const reasons: string[] = [];
  if (task.priority === 'urgent') {
    reasons.push('紧急优先级');
  } else if (task.priority === 'high') {
    reasons.push('高优先级');
  }

  const dueMs = parseDateMs(task.dueDate);
  if (dueMs !== null) {
    const nowMs = now.getTime();
    if (dueMs < nowMs) {
      reasons.push('已过期');
    } else if (dueMs - nowMs <= DUE_SOON_WINDOW_MS) {
      reasons.push('临近截止');
    }
  }

  return reasons;
}

function pushBadge(badges: TaskSidecarBadge[], id: string, label: string, tone: TaskSidecarTone, tooltipText?: string): void {
  if (!label) return;
  badges.push({ id, label, tone, tooltipText });
}

function appendAttentionBadges(
  badges: TaskSidecarBadge[],
  tooltipLines: string[],
  activeAttentionItems: readonly { text: string }[],
): void {
  activeAttentionItems.forEach((item, index) => {
    const attentionIndex = index + 1;
    pushBadge(badges, `attention-${attentionIndex}`, `注意${attentionIndex}`, 'attention', item.text);
    tooltipLines.push(`注意${attentionIndex}：${item.text}`);
  });
}

function appendRiskBadge(badges: TaskSidecarBadge[], tooltipLines: string[], riskReasons: readonly string[]): void {
  if (riskReasons.length === 0) return;
  pushBadge(badges, 'risk', `风险${riskReasons.length}`, 'risk');
  tooltipLines.push(`风险：${riskReasons.join('、')}`);
}

function appendPlanningBadges(badges: TaskSidecarBadge[], tooltipLines: string[], task: Task): void {
  if (typeof task.wait_minutes === 'number' && Number.isFinite(task.wait_minutes) && task.wait_minutes > 0) {
    const waitMinutes = Math.floor(task.wait_minutes);
    pushBadge(badges, 'wait', `等待${waitMinutes}m`, 'wait');
    tooltipLines.push(`等待：${waitMinutes} 分钟`);
  }

  if (task.cognitive_load === 'high') {
    pushBadge(badges, 'load', '高负荷', 'load');
    tooltipLines.push('认知负荷：高');
  }

  if (typeof task.expected_minutes === 'number' && Number.isFinite(task.expected_minutes) && task.expected_minutes > 0) {
    const expectedMinutes = Math.floor(task.expected_minutes);
    pushBadge(badges, 'expected', `预计${expectedMinutes}m`, 'time');
    tooltipLines.push(`预计：${expectedMinutes} 分钟`);
  }
}

function appendResourceBadge(
  badges: TaskSidecarBadge[],
  tooltipLines: string[],
  task: Task,
  knowledgeAnchorCount: number,
): void {
  const attachmentCount = task.attachments?.filter(attachment => !attachment.deletedAt).length ?? 0;
  const resourceCount = attachmentCount + Math.max(0, knowledgeAnchorCount);
  if (resourceCount > 0) {
    pushBadge(badges, 'resource', `资料${resourceCount}`, 'resource');
    tooltipLines.push(`资料：${resourceCount} 个`);
  }
}

function appendStateBadges(
  badges: TaskSidecarBadge[],
  tooltipLines: string[],
  task: Task,
  options: BuildTaskSidecarSummaryOptions,
): void {
  const stateLabels: string[] = [];
  if (task.parkingMeta?.state === 'parked') {
    stateLabels.push('已停泊');
    pushBadge(badges, 'parked', '已停泊', 'state');
  }
  if (options.isDockFocused) {
    stateLabels.push('专注中');
    pushBadge(badges, 'focused', '专注中', 'state');
  } else if (options.isDocked) {
    stateLabels.push('已入坞');
  }
  if (stateLabels.length > 0) {
    tooltipLines.push(`状态：${stateLabels.join('、')}`);
  }
}

function appendTagBadges(badges: TaskSidecarBadge[], tooltipLines: string[], task: Task): void {
  const visibleTags = (task.tags ?? [])
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0)
    .slice(0, MAX_TAG_BADGES);
  visibleTags.forEach((tag, index) => pushBadge(badges, `tag-${index}`, tag, 'tag'));
  if (visibleTags.length > 0) {
    tooltipLines.push(`标签：${visibleTags.join('、')}`);
  }
}

export function buildTaskSidecarSummary(
  task: Task,
  options: BuildTaskSidecarSummaryOptions = {},
): TaskSidecarSummary {
  const now = options.now ?? new Date();
  const badges: TaskSidecarBadge[] = [];
  const tooltipLines: string[] = [];
  const activeAttentionItems = (task.attentionMeta?.items ?? [])
    .map(item => ({ ...item, text: item.text.trim() }))
    .filter(item => !item.done && item.text.length > 0);
  const riskReasons = readRiskReasons(task, now);

  appendAttentionBadges(badges, tooltipLines, activeAttentionItems);
  appendRiskBadge(badges, tooltipLines, riskReasons);
  appendPlanningBadges(badges, tooltipLines, task);
  appendResourceBadge(badges, tooltipLines, task, options.knowledgeAnchorCount ?? 0);
  appendStateBadges(badges, tooltipLines, task, options);
  appendTagBadges(badges, tooltipLines, task);

  return {
    badges,
    tooltipLines,
    hasSignals: badges.length > 0 || tooltipLines.length > 0,
    riskCount: riskReasons.length,
  };
}
