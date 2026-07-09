import { describe, expect, it } from 'vitest';
import type { Task } from '../models';
import type { DockEntry } from '../models/parking-dock';
import { prepareDockTaskEntry } from './dock-entry-docking.helpers';

describe('prepareDockTaskEntry', () => {
  it('builds manual combo-select entries with planner overrides', () => {
    const result = prepareDockTaskEntry({
      taskId: 'task-1',
      task: task({
        expected_minutes: 20,
        wait_minutes: 5,
        cognitive_load: 'low',
      }),
      lane: 'combo-select',
      sourceProjectId: 'project-1',
      currentEntryCount: 3,
      muteWaitTone: true,
      options: {
        expectedMinutes: 60,
        waitMinutes: 15,
        load: 'high',
        detail: 'manual detail',
        sourceSection: 'text',
        zoneSource: 'manual',
      },
      inferAutoLane: () => {
        throw new Error('manual lane should not infer auto lane');
      },
    });

    expect(result.plannerFields.adjusted).toBe(false);
    expect(result.entry).toMatchObject({
      taskId: 'task-1',
      title: 'Task 1',
      detail: 'manual detail',
      sourceProjectId: 'project-1',
      lane: 'combo-select',
      zoneSource: 'manual',
      relationScore: 100,
      relationReason: 'manual:combo-select',
      expectedMinutes: 60,
      waitMinutes: 15,
      load: 'high',
      dockedOrder: 3,
      sourceSection: 'text',
      snoozeRingMuted: true,
    } satisfies Partial<DockEntry>);
  });

  it('uses auto inference and raises expected minutes when wait is longer', () => {
    const result = prepareDockTaskEntry({
      taskId: 'task-2',
      task: task({
        title: '',
        content: '',
        expected_minutes: 10,
        wait_minutes: 45,
        cognitive_load: 'high',
      }),
      sourceProjectId: null,
      currentEntryCount: 0,
      muteWaitTone: false,
      options: {},
      inferAutoLane: () => ({
        lane: 'backup',
        relationScore: 12,
        relationReason: 'auto:cross-project',
      }),
    });

    expect(result.plannerFields.adjusted).toBe(true);
    expect(result.entry).toMatchObject({
      taskId: 'task-2',
      title: 'Untitled task',
      detail: '',
      lane: 'backup',
      zoneSource: 'auto',
      relationScore: 12,
      relationReason: 'auto:cross-project',
      expectedMinutes: 45,
      waitMinutes: 45,
      load: 'high',
    } satisfies Partial<DockEntry>);
  });
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task 1',
    content: 'body',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    displayId: '1',
    attachments: [],
    ...overrides,
  };
}
