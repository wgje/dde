import { describe, expect, it } from 'vitest';

import {
  buildTaskRetryPayloadSignature,
  resolveDeferredEntityId,
  retryOperationIdMatches,
  wasTaskDeleteTransferredToRetryQueue,
  wasTaskUpsertTransferredToRetryQueue,
} from './action-queue-task-focus-processors.helpers';

describe('action-queue-task-focus-processors helpers', () => {
  it('resolveDeferredEntityId 应优先使用显式候选 id', () => {
    expect(resolveDeferredEntityId(
      { entityId: 'entity-from-action', id: 'action-id' },
      undefined,
      '',
      'candidate-id',
    )).toBe('candidate-id');
  });

  it('resolveDeferredEntityId 应回退到 action entityId 或 action id', () => {
    expect(resolveDeferredEntityId({ entityId: 'entity-from-action', id: 'action-id' }))
      .toBe('entity-from-action');

    expect(resolveDeferredEntityId({ entityId: '', id: 'action-id' }))
      .toBe('action-id');
  });

  it('resolveDeferredEntityId 应为旧 action 构造稳定 fallback id', () => {
    expect(resolveDeferredEntityId({ entityType: 'task', type: 'task:update' }))
      .toBe('task:task:update');

    expect(resolveDeferredEntityId({})).toBe('unknown:unknown');
  });

  it('retryOperationIdMatches 应拒绝缺少 operationId 的旧队列项匹配新 RetryQueue 项', () => {
    expect(retryOperationIdMatches({}, undefined)).toBe(true);
    expect(retryOperationIdMatches({ operationId: undefined }, undefined)).toBe(true);
    expect(retryOperationIdMatches({ operationId: 'retry-op' }, undefined)).toBe(false);
    expect(retryOperationIdMatches({ operationId: 'retry-op' }, 'retry-op')).toBe(true);
    expect(retryOperationIdMatches({ operationId: 'retry-op' }, 'different-op')).toBe(false);
  });

  it('buildTaskRetryPayloadSignature 应只保留字符串 owner 字段', () => {
    expect(buildTaskRetryPayloadSignature(
      { id: 'task-1', title: 'Task' },
      123,
      null,
    )).toBe(JSON.stringify({
      task: { id: 'task-1', title: 'Task' },
      projectId: null,
      sourceUserId: null,
    }));
  });

  it('wasTaskUpsertTransferredToRetryQueue 应匹配 operation、project、operationId 和 payload 签名', () => {
    const payload = {
      task: { id: 'task-1', title: 'Task' },
      projectId: 'project-1',
      sourceUserId: 'user-1',
    };

    expect(wasTaskUpsertTransferredToRetryQueue({
      operation: 'upsert',
      projectId: 'project-1',
      sourceUserId: 'user-1',
      data: { id: 'task-1', title: 'Task' },
      operationId: 'op-1',
    }, payload, 'op-1')).toBe(true);

    expect(wasTaskUpsertTransferredToRetryQueue({
      operation: 'upsert',
      projectId: 'project-1',
      sourceUserId: 'user-1',
      data: { id: 'task-1', title: 'Changed' },
      operationId: 'op-1',
    }, payload, 'op-1')).toBe(false);
  });

  it('wasTaskUpsertTransferredToRetryQueue 应拒绝错误 operation、project 或 operationId', () => {
    const payload = {
      task: { id: 'task-1' },
      projectId: 'project-1',
      sourceUserId: 'user-1',
    };

    expect(wasTaskUpsertTransferredToRetryQueue(undefined, payload)).toBe(false);
    expect(wasTaskUpsertTransferredToRetryQueue({
      operation: 'delete',
      projectId: 'project-1',
      data: { id: 'task-1' },
    }, payload)).toBe(false);
    expect(wasTaskUpsertTransferredToRetryQueue({
      operation: 'upsert',
      projectId: 'project-2',
      data: { id: 'task-1' },
    }, payload)).toBe(false);
    expect(wasTaskUpsertTransferredToRetryQueue({
      operation: 'upsert',
      projectId: 'project-1',
      data: { id: 'task-1' },
      operationId: 'retry-op',
    }, payload, 'different-op')).toBe(false);
  });

  it('wasTaskDeleteTransferredToRetryQueue 应匹配 delete operation、project 和 operationId', () => {
    const payload = {
      taskId: 'task-1',
      projectId: 'project-1',
      sourceUserId: 'user-1',
    };

    expect(wasTaskDeleteTransferredToRetryQueue({
      operation: 'delete',
      projectId: 'project-1',
      operationId: 'op-1',
    }, payload, 'op-1')).toBe(true);

    expect(wasTaskDeleteTransferredToRetryQueue({
      operation: 'upsert',
      projectId: 'project-1',
      operationId: 'op-1',
    }, payload, 'op-1')).toBe(false);

    expect(wasTaskDeleteTransferredToRetryQueue({
      operation: 'delete',
      projectId: 'project-2',
      operationId: 'op-1',
    }, payload, 'op-1')).toBe(false);

    expect(wasTaskDeleteTransferredToRetryQueue({
      operation: 'delete',
      projectId: 'project-1',
      operationId: 'op-1',
    }, payload, 'different-op')).toBe(false);
  });
});
