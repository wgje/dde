import { describe, expect, it } from 'vitest';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import type { Task } from '../../../../models';
import {
  buildProjectSiyuanBadgeContext,
  compareProjectSiyuanLinkOrder,
  createFlowNodeSidecarBadgeItems,
  createFlowNodeSidecarBadgeSlots,
} from './flow-diagram-sidecar-data.helpers';

function task(id: string): Pick<Task, 'id'> {
  return { id };
}

function link(
  overrides: Pick<ExternalSourceLink, 'id' | 'taskId' | 'sourceType' | 'createdAt'>
    & Partial<Omit<ExternalSourceLink, 'id' | 'taskId' | 'sourceType' | 'createdAt'>>,
): ExternalSourceLink {
  return {
    id: overrides.id,
    taskId: overrides.taskId,
    sourceType: overrides.sourceType,
    targetId: overrides.targetId ?? `${overrides.id}-target`,
    uri: overrides.uri ?? `siyuan://blocks/${overrides.id}-target?focus=1`,
    label: overrides.label ?? overrides.id,
    role: overrides.role,
    sortOrder: overrides.sortOrder ?? 0,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? overrides.createdAt,
  };
}

describe('flow diagram sidecar data helpers', () => {
  it('creates readable badge items with attention cues and tooltip fallbacks', () => {
    expect(createFlowNodeSidecarBadgeItems([
      { id: 'attention-risk', label: '风险1', tone: 'attention' },
      { id: 'tag-1', label: '需联调', tone: 'tag' },
      { id: 'empty-label', label: '', tone: 'state' },
      { id: 'custom-tooltip', label: '资料1', tone: 'resource', tooltipText: '打开资料' },
    ])).toEqual([
      { id: 'attention-risk', label: '风险1', cue: '1', tone: 'attention', tooltipText: '风险1' },
      { id: 'tag-1', label: '需联调', cue: '需联调', tone: 'tag', tooltipText: '需联调' },
      { id: 'empty-label', label: '', cue: '', tone: 'state', tooltipText: '僚机 3' },
      { id: 'custom-tooltip', label: '资料1', cue: '资料1', tone: 'resource', tooltipText: '打开资料' },
    ]);
  });

  it('assigns sidecar badges to stable natural slots around the node', () => {
    const badges = createFlowNodeSidecarBadgeItems(Array.from({ length: 9 }, (_, index) => ({
      id: `badge-${index + 1}`,
      label: `B${index + 1}`,
      tone: 'tag',
    })));

    const slots = createFlowNodeSidecarBadgeSlots(badges);

    expect(slots.right.map(badge => badge.id)).toEqual(['badge-1', 'badge-2', 'badge-6']);
    expect(slots.top.map(badge => badge.id)).toEqual(['badge-3', 'badge-7']);
    expect(slots.left.map(badge => badge.id)).toEqual(['badge-4', 'badge-8']);
    expect(slots.bottom.map(badge => badge.id)).toEqual(['badge-5', 'badge-9']);
  });

  it('orders SiYuan links by normalized creation time before deterministic tie breakers', () => {
    const unordered = [
      link({ id: 'task-b-late', taskId: 'task-b', sourceType: 'siyuan-block', createdAt: '2026-05-28T05:00:00.000Z' }),
      link({ id: 'task-a-first-sort-2', taskId: 'task-a', sourceType: 'siyuan-block', sortOrder: 2, createdAt: '2026-05-28T12:00:00.000+08:00' }),
      link({ id: 'task-a-first-sort-1', taskId: 'task-a', sourceType: 'siyuan-block', sortOrder: 1, createdAt: '2026-05-28T04:00:00.000Z' }),
      link({ id: 'task-c-invalid', taskId: 'task-c', sourceType: 'siyuan-block', createdAt: 'not-a-date' }),
    ];

    expect([...unordered].sort(compareProjectSiyuanLinkOrder).map(item => item.id)).toEqual([
      'task-a-first-sort-1',
      'task-a-first-sort-2',
      'task-b-late',
      'task-c-invalid',
    ]);
  });

  it('builds project-level SiYuan badge indexes from the first visible active link per visible task', () => {
    const linksByTask = new Map<string, ExternalSourceLink[]>([
      ['task-b', [
        link({ id: 'visible-b', taskId: 'task-b', sourceType: 'siyuan-block', createdAt: '2026-05-28T12:02:00.000Z' }),
        link({ id: 'hidden-b-second', taskId: 'task-b', sourceType: 'siyuan-block', createdAt: '2026-05-28T12:03:00.000Z' }),
      ]],
      ['task-a', [
        link({ id: 'visible-a', taskId: 'task-a', sourceType: 'siyuan-block', createdAt: '2026-05-28T12:01:00.000Z' }),
      ]],
      ['hidden-task', [
        link({ id: 'hidden-task-link', taskId: 'hidden-task', sourceType: 'siyuan-block', createdAt: '2026-05-28T11:59:00.000Z' }),
      ]],
    ]);

    const context = buildProjectSiyuanBadgeContext(
      [task('task-b'), task('task-a')],
      taskId => linksByTask.get(taskId) ?? [],
    );

    expect(context.linksByTask.get('task-a')?.map(item => item.id)).toEqual(['visible-a']);
    expect(context.linksByTask.get('task-b')?.map(item => item.id)).toEqual(['visible-b', 'hidden-b-second']);
    expect([...context.badgeIndexByLinkId.entries()]).toEqual([
      ['visible-a', 1],
      ['visible-b', 2],
    ]);
    expect(context.badgeIndexByLinkId.has('hidden-b-second')).toBe(false);
    expect(context.badgeIndexByLinkId.has('hidden-task-link')).toBe(false);
  });
});
