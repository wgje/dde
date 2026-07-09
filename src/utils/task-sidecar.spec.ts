import { describe, expect, it } from 'vitest';
import { Task } from '../models';
import { buildTaskSidecarSummary, taskAttentionMetaToText, taskAttentionTextToDraftItems } from './task-sidecar';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '登录状态管理',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    displayId: '1',
    attachments: [],
    tags: [],
    ...overrides,
  };
}

describe('buildTaskSidecarSummary', () => {
  it('round-trips editable attention text while preserving matching existing item identity by text', () => {
    const meta: Task['attentionMeta'] = {
      items: [
        {
          id: 'attention-1',
          text: 'Token 过期需刷新',
          level: 'warning',
          done: false,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          id: 'attention-2',
          text: '已处理',
          level: 'info',
          done: true,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      updatedAt: '2026-06-05T00:00:00.000Z',
    };

    expect(taskAttentionMetaToText(meta)).toBe('Token 过期需刷新');
    expect(taskAttentionTextToDraftItems('  Token 过期需刷新\n接口字段未冻结  ', meta)).toEqual([
      {
        id: 'attention-1',
        text: 'Token 过期需刷新',
        level: 'warning',
        done: false,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
      {
        id: undefined,
        text: '接口字段未冻结',
        level: 'info',
        done: false,
        createdAt: undefined,
      },
    ]);
  });

  it('does not transfer a deleted attention row identity to the next line', () => {
    const meta: Task['attentionMeta'] = {
      items: [
        {
          id: 'attention-1',
          text: 'Token 过期需刷新',
          level: 'warning',
          done: false,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          id: 'attention-2',
          text: '接口字段未冻结',
          level: 'blocker',
          done: false,
          createdAt: '2026-06-06T00:00:00.000Z',
          updatedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      updatedAt: '2026-06-06T00:00:00.000Z',
    };

    expect(taskAttentionTextToDraftItems('接口字段未冻结', meta)).toEqual([
      {
        id: 'attention-2',
        text: '接口字段未冻结',
        level: 'blocker',
        done: false,
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    ]);
  });

  it('prioritizes editable attention meta items over inferred signals', () => {
    const task = createTask({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
          {
            id: 'attention-2',
            text: '接口字段未冻结',
            level: 'blocker',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
          {
            id: 'attention-3',
            text: '历史提醒已处理',
            level: 'info',
            done: true,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        pinned: true,
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
      wait_minutes: 10,
    });

    const summary = buildTaskSidecarSummary(task, {
      now: new Date('2026-06-05T08:00:00.000Z'),
    });

    expect(summary.badges.map(badge => badge.label).slice(0, 3)).toEqual(['注意1', '注意2', '等待10m']);
    expect(summary.tooltipLines.slice(0, 2)).toEqual([
      '注意1：Token 过期需刷新',
      '注意2：接口字段未冻结',
    ]);
  });

  it('keeps all attention items visible as separate badges', () => {
    const task = createTask({
      attentionMeta: {
        items: Array.from({ length: 5 }, (_, index) => ({
          id: `attention-${index + 1}`,
          text: `注意事项 ${index + 1}`,
          level: 'info' as const,
          done: false,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
        })),
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });

    const summary = buildTaskSidecarSummary(task, {
      now: new Date('2026-06-05T08:00:00.000Z'),
    });

    expect(summary.badges.map(badge => badge.label)).toEqual(['注意1', '注意2', '注意3', '注意4', '注意5']);
    expect(summary.badges.map(badge => badge.tooltipText)).toEqual([
      '注意事项 1',
      '注意事项 2',
      '注意事项 3',
      '注意事项 4',
      '注意事项 5',
    ]);
  });

  it('derives scannable badges from existing task and resource fields without duplicating relation blocks', () => {
    const task = createTask({
      content: '- [ ] 刷新 Token\n- [x] 已处理游客入口\n- [ ] 确认接口字段',
      priority: 'urgent',
      dueDate: '2026-06-04T23:00:00.000Z',
      expected_minutes: 45,
      wait_minutes: 15,
      cognitive_load: 'high',
      tags: ['需联调', '待确认', '后端'],
      attachments: [{
        id: 'attachment-1',
        type: 'document',
        name: '接口说明.md',
        url: 'local://接口说明.md',
        createdAt: '2026-06-05T00:00:00.000Z',
      }],
      parkingMeta: {
        state: 'parked',
        parkedAt: '2026-06-05T00:00:00.000Z',
        lastVisitedAt: null,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
    });

    const summary = buildTaskSidecarSummary(task, {
      knowledgeAnchorCount: 1,
      isDocked: true,
      now: new Date('2026-06-05T08:00:00.000Z'),
    });

    expect(summary.hasSignals).toBe(true);
    expect(summary.riskCount).toBe(2);
    expect(summary.badges.map(badge => badge.label)).toEqual([
      '风险2',
      '等待15m',
      '高负荷',
      '预计45m',
      '资料2',
      '已停泊',
      '需联调',
      '待确认',
    ]);
    expect(summary.tooltipLines).toEqual([
      '风险：紧急优先级、已过期',
      '等待：15 分钟',
      '认知负荷：高',
      '预计：45 分钟',
      '资料：2 个',
      '状态：已停泊、已入坞',
      '标签：需联调、待确认',
    ]);
  });

  it('returns an empty summary when the task has no attention signals', () => {
    const summary = buildTaskSidecarSummary(createTask(), {
      now: new Date('2026-06-05T08:00:00.000Z'),
    });

    expect(summary.hasSignals).toBe(false);
    expect(summary.badges).toEqual([]);
    expect(summary.tooltipLines).toEqual([]);
  });

  it('marks a near due date as a single risk without treating completed tasks as active blockers', () => {
    const summary = buildTaskSidecarSummary(
      createTask({
        status: 'completed',
        dueDate: '2026-06-05T12:00:00.000Z',
        content: '- [ ] 历史遗留待办',
      }),
      { now: new Date('2026-06-05T08:00:00.000Z') },
    );

    expect(summary.riskCount).toBe(1);
    expect(summary.badges.map(badge => badge.label)).toEqual(['风险1']);
    expect(summary.tooltipLines[0]).toBe('风险：临近截止');
  });
});
