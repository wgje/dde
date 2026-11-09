import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import type { Task } from '../../../../models';
import type { TaskSidecarTone } from '../../../../utils/task-sidecar';

export interface FlowNodeSidecarBadgeInput {
  id: string;
  label: string;
  tone: TaskSidecarTone;
  tooltipText?: string;
}

export interface FlowNodeSidecarBadgeItem {
  id: string;
  label: string;
  cue: string;
  tone: TaskSidecarTone;
  tooltipText?: string;
}

export interface FlowNodeSidecarBadgeSlots {
  top: FlowNodeSidecarBadgeItem[];
  right: FlowNodeSidecarBadgeItem[];
  bottom: FlowNodeSidecarBadgeItem[];
  left: FlowNodeSidecarBadgeItem[];
}

export interface ProjectSiyuanBadgeContext {
  linksByTask: ReadonlyMap<string, readonly ExternalSourceLink[]>;
  badgeIndexByLinkId: ReadonlyMap<string, number>;
}

const NATURAL_SIDECAR_SLOT_SEQUENCE = [
  'right',
  'right',
  'top',
  'left',
  'bottom',
  'right',
  'top',
  'left',
  'bottom',
] as const;

export function createFlowNodeSidecarBadgeItems(
  badges: readonly FlowNodeSidecarBadgeInput[],
): FlowNodeSidecarBadgeItem[] {
  return badges.map((badge, index) => ({
    id: badge.id,
    label: badge.label,
    cue: createFlowNodeSidecarBadgeCue(badge, index),
    tone: badge.tone,
    tooltipText: badge.tooltipText ?? createFlowNodeSidecarBadgeTooltip(badge, index),
  }));
}

function createFlowNodeSidecarBadgeCue(
  badge: Pick<FlowNodeSidecarBadgeInput, 'label' | 'tone'>,
  index: number,
): string {
  if (badge.tone === 'attention') {
    return String(index + 1);
  }
  return badge.label;
}

function createFlowNodeSidecarBadgeTooltip(
  badge: Pick<FlowNodeSidecarBadgeInput, 'id' | 'label' | 'tone'>,
  index: number,
): string {
  if (badge.id.startsWith('attention-')) {
    return badge.label;
  }
  return badge.label || `僚机 ${index + 1}`;
}

export function createFlowNodeSidecarBadgeSlots(
  badges: readonly FlowNodeSidecarBadgeItem[],
): FlowNodeSidecarBadgeSlots {
  const slots: FlowNodeSidecarBadgeSlots = { top: [], right: [], bottom: [], left: [] };
  badges.forEach((badge, index) => {
    const slot = NATURAL_SIDECAR_SLOT_SEQUENCE[index % NATURAL_SIDECAR_SLOT_SEQUENCE.length];
    slots[slot].push(badge);
  });
  return slots;
}

export function buildProjectSiyuanBadgeContext(
  tasksToShow: readonly Pick<Task, 'id'>[],
  activeLinksForTask?: (taskId: string) => readonly ExternalSourceLink[],
): ProjectSiyuanBadgeContext {
  const linksByTask = new Map<string, ExternalSourceLink[]>();
  const badgeIndexByLinkId = new Map<string, number>();
  const projectLinks: ExternalSourceLink[] = [];

  if (!activeLinksForTask) {
    return { linksByTask, badgeIndexByLinkId };
  }

  tasksToShow.forEach((task) => {
    const links = activeLinksForTask(task.id).filter(link => link.sourceType === 'siyuan-block');
    linksByTask.set(task.id, links);
    const flowVisibleLink = links[0];
    if (flowVisibleLink) projectLinks.push(flowVisibleLink);
  });

  projectLinks
    .slice()
    .sort(compareProjectSiyuanLinkOrder)
    .forEach((link) => {
      if (!badgeIndexByLinkId.has(link.id)) {
        badgeIndexByLinkId.set(link.id, badgeIndexByLinkId.size + 1);
      }
    });

  return { linksByTask, badgeIndexByLinkId };
}

export function compareProjectSiyuanLinkOrder(
  a: ExternalSourceLink,
  b: ExternalSourceLink,
): number {
  const createdAtCompare = compareExternalSourceLinkCreatedAt(a.createdAt, b.createdAt);
  if (createdAtCompare !== 0) return createdAtCompare;

  if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;

  const sortOrderCompare = a.sortOrder - b.sortOrder;
  if (sortOrderCompare !== 0) return sortOrderCompare;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareExternalSourceLinkCreatedAt(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  const aValid = Number.isFinite(aMs);
  const bValid = Number.isFinite(bMs);

  if (aValid && bValid && aMs !== bMs) return aMs - bMs;
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}
