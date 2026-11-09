import { describe, expect, it } from 'vitest';
import type { DockEntry } from '../models/parking-dock';
import {
  applyRecommendationEntries,
  applyPendingDecisionEntryFlags,
  buildDockPendingDecision,
  sortConsoleEntriesForDisplay,
} from './dock-completion.utils';

function makeEntry(overrides: Partial<DockEntry> & { taskId: string }): DockEntry {
  const { taskId, ...rest } = overrides;

  return {
    taskId,
    title: taskId,
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low',
    expectedMinutes: null,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'combo-select',
    zoneSource: 'auto',
    isMain: false,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'project-task',
    systemSelected: false,
    recommendedScore: null,
    ...rest,
  };
}

describe('dock-completion utils', () => {
  it('marks suspended task, recommended candidates, and clears non-candidates', () => {
    const entries = [
      makeEntry({
        taskId: 'suspended',
        status: 'focusing',
        systemSelected: true,
        recommendationLocked: true,
        recommendedScore: 10,
      }),
      makeEntry({ taskId: 'candidate', recommendedScore: null }),
      makeEntry({
        taskId: 'other',
        systemSelected: true,
        recommendationLocked: true,
        recommendedScore: 3,
      }),
    ];

    const next = applyRecommendationEntries(entries, {
      suspendedTaskId: 'suspended',
      recommendationIds: ['candidate'],
      scoreByTaskId: new Map([
        ['candidate', 42],
        ['other', 7],
      ]),
    });

    expect(next.find(entry => entry.taskId === 'suspended')).toMatchObject({
      status: 'suspended_waiting',
      systemSelected: false,
      recommendationLocked: false,
      recommendedScore: null,
    });
    expect(next.find(entry => entry.taskId === 'candidate')).toMatchObject({
      status: 'pending_start',
      systemSelected: true,
      recommendationLocked: true,
      recommendedScore: 42,
    });
    expect(next.find(entry => entry.taskId === 'other')).toMatchObject({
      systemSelected: false,
      recommendationLocked: false,
      recommendedScore: 7,
    });
  });

  it('marks pending decision candidates and clears non-candidate recommendation flags', () => {
    const entries = [
      makeEntry({ taskId: 'candidate' }),
      makeEntry({
        taskId: 'other',
        systemSelected: true,
        recommendationLocked: true,
        recommendedScore: 8,
      }),
    ];

    const next = applyPendingDecisionEntryFlags(entries, {
      candidateIds: ['candidate'],
      scoreByTaskId: new Map([['candidate', 12]]),
    });

    expect(next.find(entry => entry.taskId === 'candidate')).toMatchObject({
      systemSelected: true,
      recommendationLocked: true,
      recommendedScore: 12,
    });
    expect(next.find(entry => entry.taskId === 'other')).toMatchObject({
      systemSelected: false,
      recommendationLocked: false,
      recommendedScore: 8,
    });
  });

  it('places focusing entries before hinted and stalled entries', () => {
    const sorted = sortConsoleEntriesForDisplay([
      makeEntry({ taskId: 'hinted', dockedOrder: 1 }),
      makeEntry({ taskId: 'focus', status: 'focusing', dockedOrder: 2 }),
      makeEntry({ taskId: 'stalled', status: 'stalled', dockedOrder: 0 }),
    ], null, ['hinted']);

    expect(sorted.map(entry => entry.taskId)).toEqual(['focus', 'hinted', 'stalled']);
  });

  it('uses order hints before demotion and status fallbacks', () => {
    const sorted = sortConsoleEntriesForDisplay([
      makeEntry({ taskId: 'demoted', status: 'stalled', dockedOrder: 0 }),
      makeEntry({ taskId: 'hinted-b', dockedOrder: 1 }),
      makeEntry({ taskId: 'hinted-a', dockedOrder: 2 }),
    ], 'demoted', ['hinted-a', 'hinted-b']);

    expect(sorted.map(entry => entry.taskId)).toEqual(['hinted-a', 'hinted-b', 'demoted']);
  });

  it('pushes waiting-like entries behind runnable entries before stable ordering', () => {
    const sorted = sortConsoleEntriesForDisplay([
      makeEntry({ taskId: 'waiting', status: 'suspended_waiting', dockedOrder: 0 }),
      makeEntry({ taskId: 'runnable', status: 'pending_start', dockedOrder: 1 }),
      makeEntry({ taskId: 'later', status: 'pending_start', dockedOrder: 2 }),
    ], null, []);

    expect(sorted.map(entry => entry.taskId)).toEqual(['runnable', 'later', 'waiting']);
  });

  it('builds pending decisions with flattened candidate ids and clamped auto promote delay', () => {
    const now = new Date('2026-04-01T00:00:00.000Z');
    const result = buildDockPendingDecision({
      rootTaskId: 'root',
      rootRemainingMinutes: 15,
      candidateGroups: [
        { type: 'homologous-advancement', taskIds: ['a', 'b'] },
        { type: 'cognitive-downgrade', taskIds: ['c'] },
      ],
      reason: 'wait for manual choice',
      now,
      minAutoPromoteMs: 1_000,
      autoPromoteAfterMs: 250,
    });

    expect(result.candidateIds).toEqual(['a', 'b', 'c']);
    expect(result.pendingDecision).toEqual({
      rootTaskId: 'root',
      rootRemainingMinutes: 15,
      candidateGroups: [
        { type: 'homologous-advancement', taskIds: ['a', 'b'] },
        { type: 'cognitive-downgrade', taskIds: ['c'] },
      ],
      reason: 'wait for manual choice',
      expiresAt: '2026-04-01T00:00:01.000Z',
      autoPromoteAfterMs: 1_000,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('omits auto promote fields when no delay is provided', () => {
    const result = buildDockPendingDecision({
      rootTaskId: 'root',
      rootRemainingMinutes: 5,
      candidateGroups: [{ type: 'homologous-advancement', taskIds: ['a'] }],
      reason: 'manual only',
      now: new Date('2026-04-01T00:00:00.000Z'),
      minAutoPromoteMs: 1_000,
    });

    expect(result.candidateIds).toEqual(['a']);
    expect(result.pendingDecision.expiresAt).toBeUndefined();
    expect(result.pendingDecision.autoPromoteAfterMs).toBeUndefined();
  });
});
