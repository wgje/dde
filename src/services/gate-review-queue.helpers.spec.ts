import { describe, expect, it } from 'vitest';
import {
  buildNextReviewingQueue,
  isSameGateQueue,
  resolveRemoteEmptyQueueState,
} from './gate-review-queue.helpers';

interface QueueItem {
  id: string;
  updatedAt: string;
}

const item = (id: string, updatedAt = `${id}-updated`): QueueItem => ({ id, updatedAt });

describe('gate-review-queue.helpers', () => {
  it('远端首次空队列探针会保留当前队列，避免瞬时清空大门', () => {
    const remoteEmptyState = resolveRemoteEmptyQueueState({
      source: 'remote',
      latestPendingLength: 0,
      safeIndex: 0,
      currentLength: 2,
      hasLocalAction: false,
      remoteEmptyQueueConfirmations: 0,
    });

    expect(remoteEmptyState).toEqual({
      remoteEmptyNeedsConfirmation: true,
      remoteEmptyBlockedByLocalAction: false,
      firstRemoteEmptyProbe: true,
      confirmedRemoteEmpty: false,
      preserveCurrentDuringTransientEmpty: true,
    });

    expect(buildNextReviewingQueue({
      currentItems: [item('a'), item('b')],
      latestPending: [],
      safeIndex: 0,
      remoteEmptyState,
      hasActionInFlight: false,
    })).toEqual([item('a'), item('b')]);
  });

  it('远端空队列已确认时允许清空 reviewing 队列', () => {
    const remoteEmptyState = resolveRemoteEmptyQueueState({
      source: 'remote',
      latestPendingLength: 0,
      safeIndex: 0,
      currentLength: 2,
      hasLocalAction: false,
      remoteEmptyQueueConfirmations: 1,
    });

    expect(remoteEmptyState.confirmedRemoteEmpty).toBe(true);
    expect(buildNextReviewingQueue({
      currentItems: [item('a'), item('b')],
      latestPending: [],
      safeIndex: 0,
      remoteEmptyState,
      hasActionInFlight: false,
    })).toEqual([]);
  });

  it('本地动作进行中时阻止远端空队列覆盖当前条目', () => {
    const remoteEmptyState = resolveRemoteEmptyQueueState({
      source: 'remote',
      latestPendingLength: 0,
      safeIndex: 0,
      currentLength: 1,
      hasLocalAction: true,
      remoteEmptyQueueConfirmations: 0,
    });

    expect(remoteEmptyState.remoteEmptyBlockedByLocalAction).toBe(true);
    expect(buildNextReviewingQueue({
      currentItems: [item('active')],
      latestPending: [],
      safeIndex: 0,
      remoteEmptyState,
      hasActionInFlight: true,
    })).toEqual([item('active')]);
  });

  it('队列相等性同时比较 id 和 updatedAt', () => {
    expect(isSameGateQueue([item('a', 't1')], [item('a', 't1')])).toBe(true);
    expect(isSameGateQueue([item('a', 't1')], [item('a', 't2')])).toBe(false);
    expect(isSameGateQueue([item('a', 't1')], [item('b', 't1')])).toBe(false);
  });
});
