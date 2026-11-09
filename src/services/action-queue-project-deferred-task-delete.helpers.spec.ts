import { describe, expect, it } from 'vitest';

import {
  collectDeferredTaskDeleteIds,
  pickTaskDeleteBaseUpdatedAtMap,
  resolveDeferredTaskDeleteReplayAction,
} from './action-queue-project-deferred-task-delete.helpers';

describe('action-queue project deferred task delete helpers', () => {
  it('collectDeferredTaskDeleteIds 应去重并过滤非法 ID', () => {
    expect(collectDeferredTaskDeleteIds([
      'task-a',
      '',
      'task-b',
      'task-a',
      null,
      undefined,
      123,
    ])).toEqual(['task-a', 'task-b']);
  });

  it('resolveDeferredTaskDeleteReplayAction 应按 mutation staleness 优先决策', () => {
    expect(resolveDeferredTaskDeleteReplayAction({
      staleness: 'queue-view-stale',
      currentUserId: 'user-1',
      replayOwnerUserId: 'user-1',
      remainingTaskIds: ['task-a'],
    })).toBe('handoff');

    expect(resolveDeferredTaskDeleteReplayAction({
      staleness: 'project-view-stale',
      currentUserId: 'user-1',
      replayOwnerUserId: 'user-1',
      remainingTaskIds: ['task-a'],
    })).toBe('handoff');
  });

  it('resolveDeferredTaskDeleteReplayAction 应在 owner 缺失或不匹配时转交剩余删除', () => {
    expect(resolveDeferredTaskDeleteReplayAction({
      staleness: 'none',
      currentUserId: null,
      replayOwnerUserId: 'user-1',
      remainingTaskIds: ['task-a'],
    })).toBe('handoff');

    expect(resolveDeferredTaskDeleteReplayAction({
      staleness: 'none',
      currentUserId: 'user-2',
      replayOwnerUserId: 'user-1',
      remainingTaskIds: ['task-a'],
    })).toBe('handoff');
  });

  it('resolveDeferredTaskDeleteReplayAction owner 匹配时应继续回放', () => {
    expect(resolveDeferredTaskDeleteReplayAction({
      staleness: 'none',
      currentUserId: 'user-1',
      replayOwnerUserId: 'user-1',
      remainingTaskIds: ['task-a'],
    })).toBe('continue');
  });

  it('pickTaskDeleteBaseUpdatedAtMap 应只保留剩余任务基线并规范化 null', () => {
    expect(pickTaskDeleteBaseUpdatedAtMap({
      'task-a': '2026-06-12T00:00:00.000Z',
      'task-b': undefined,
      'task-c': '2026-06-12T00:02:00.000Z',
    }, ['task-b', 'task-c', 'missing'])).toEqual({
      'task-b': null,
      'task-c': '2026-06-12T00:02:00.000Z',
    });
  });
});
