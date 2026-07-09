import { describe, expect, it } from 'vitest';

import {
  buildDockRecommendationCandidateGroups,
  buildDockTwoStageRecommendationCandidateGroups,
  rankDockRecommendedCandidates,
} from './dock-completion-recommendation.helpers';
import { makeDockCompletionEntry as makeEntry } from './dock-completion-flow.service.spec-helpers';

describe('dock-completion-recommendation.helpers', () => {
  it('builds non-empty strict recommendation groups and stores raw recommendation groups', () => {
    const root = makeEntry({
      taskId: 'root',
      load: 'high',
      expectedMinutes: 60,
      sourceProjectId: 'project-a',
    });
    const entries = [
      root,
      makeEntry({
        taskId: 'same-project',
        expectedMinutes: 20,
        sourceProjectId: 'project-a',
      }),
      makeEntry({
        taskId: 'low-load',
        load: 'low',
        expectedMinutes: 18,
        sourceProjectId: 'project-b',
      }),
      makeEntry({
        taskId: 'waiting',
        expectedMinutes: 24,
        waitMinutes: 5,
        sourceProjectId: 'project-c',
      }),
    ];
    const rawGroups: unknown[] = [];

    const groups = buildDockRecommendationCandidateGroups({
      entries,
      rootEntry: root,
      excludedTaskIds: ['root'],
      remainingMinutes: 25,
      waitFitMode: 'strict',
      resolveSourceProjectId: entry => entry.sourceProjectId,
      onRawGroups: groups => rawGroups.push(...groups),
    });

    expect(groups.some(group => group.taskIds.includes('same-project'))).toBe(true);
    expect(groups.every(group => group.taskIds.length > 0)).toBe(true);
    expect(rawGroups.length).toBeGreaterThan(0);
  });

  it('falls back to ranked candidate ids when strict, relaxed and ignore-wait groups are empty', () => {
    const root = makeEntry({
      taskId: 'root',
      load: 'low',
      expectedMinutes: 60,
      sourceProjectId: 'project-root',
    });
    const entries = [
      root,
      makeEntry({
        taskId: 'fallback-a',
        load: 'high',
        expectedMinutes: 90,
        lane: 'backup',
        sourceProjectId: 'project-a',
        dockedOrder: 1,
      }),
      makeEntry({
        taskId: 'fallback-b',
        load: 'high',
        expectedMinutes: 95,
        lane: 'backup',
        sourceProjectId: 'project-b',
        dockedOrder: 2,
      }),
    ];

    const result = buildDockTwoStageRecommendationCandidateGroups({
      entries,
      rootEntry: root,
      excludedTaskIds: ['root'],
      remainingMinutes: 10,
      resolveSourceProjectId: entry => entry.sourceProjectId,
      candidateLimit: 3,
    });

    expect(result.mode).toBe('ranked-fallback');
    expect(result.groups).toEqual([
      {
        type: 'homologous-advancement',
        taskIds: ['fallback-a', 'fallback-b'],
      },
    ]);
  });

  it('ranks only auto-promotable non-excluded candidates', () => {
    const root = makeEntry({
      taskId: 'root',
      sourceProjectId: 'project-root',
    });
    const entries = [
      root,
      makeEntry({ taskId: 'excluded', status: 'pending_start' }),
      makeEntry({ taskId: 'completed', status: 'completed' }),
      makeEntry({ taskId: 'candidate', status: 'pending_start' }),
    ];

    const ranked = rankDockRecommendedCandidates({
      entries,
      rootEntry: root,
      excludedTaskIds: ['root', 'excluded'],
      remainingMinutes: 20,
      waitFitMode: 'ignore-wait',
      resolveSourceProjectId: entry => entry.sourceProjectId,
    });

    expect(ranked.map(candidate => candidate.taskId)).toEqual(['candidate']);
  });
});
