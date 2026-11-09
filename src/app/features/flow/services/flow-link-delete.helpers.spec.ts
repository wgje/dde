import { describe, expect, it } from 'vitest';
import {
  resolveCrossTreeDeleteRequests,
  resolveFlowLinkDeleteRequest,
} from './flow-link-delete.helpers';

describe('flow-link-delete.helpers', () => {
  it('normalizes valid link data into a delete request', () => {
    expect(resolveFlowLinkDeleteRequest({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
    })).toEqual({
      fromKey: 'source-task',
      toKey: 'target-task',
      isCrossTree: true,
    });

    expect(resolveFlowLinkDeleteRequest({
      from: 'parent-task',
      to: 'child-task',
      isCrossTree: false,
    })).toEqual({
      fromKey: 'parent-task',
      toKey: 'child-task',
      isCrossTree: false,
    });
  });

  it('rejects missing or non-string endpoints', () => {
    expect(resolveFlowLinkDeleteRequest(null)).toBeNull();
    expect(resolveFlowLinkDeleteRequest({ from: 'source-task' })).toBeNull();
    expect(resolveFlowLinkDeleteRequest({ from: 1, to: 'target-task' })).toBeNull();
    expect(resolveFlowLinkDeleteRequest({ from: '', to: 'target-task' })).toBeNull();
  });

  it('filters selected links down to cross-tree delete requests', () => {
    expect(resolveCrossTreeDeleteRequests([
      { from: 'source-a', to: 'target-a', isCrossTree: true },
      { from: 'parent', to: 'child', isCrossTree: false },
      { from: 'source-b', to: 'target-b', isCrossTree: true },
      { from: 'broken' },
    ])).toEqual([
      { fromKey: 'source-a', toKey: 'target-a', isCrossTree: true },
      { fromKey: 'source-b', toKey: 'target-b', isCrossTree: true },
    ]);
  });
});
