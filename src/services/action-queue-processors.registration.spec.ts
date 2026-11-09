import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionQueueProcessorsService } from './action-queue-processors.service';
import {
  mockActionQueueService,
  mockSyncService,
  setupActionQueueProcessorsHarness,
} from './action-queue-processors.spec-helpers';

type QueueSettlementSummary = {
  processed: number;
  failed: number;
  movedToDeadLetter: number;
  remaining: number;
  remoteSuccessCount: number;
  resolvedNoOpCount: number;
};

function getSettledCallback(): (summary: QueueSettlementSummary) => void {
  const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
    | ((summary: QueueSettlementSummary) => void)
    | undefined;

  expect(settledCallback).toBeTypeOf('function');
  if (!settledCallback) {
    throw new Error('Expected queue settled callback to be registered');
  }

  return settledCallback;
}

describe('ActionQueueProcessorsService registration', () => {
  let service: ActionQueueProcessorsService;

  beforeEach(() => {
    service = setupActionQueueProcessorsHarness().service;
  });

  it('should register 17 processors', () => {
    expect(mockActionQueueService.registerProcessor).toHaveBeenCalledTimes(17);
  });

  it('setupProcessors should stay idempotent after eager bootstrap', () => {
    mockActionQueueService.registerProcessor.mockClear();

    service.setupProcessors();

    expect(mockActionQueueService.registerProcessor).not.toHaveBeenCalled();
  });

  it('should set queue sync callbacks', () => {
    expect(mockActionQueueService.setQueueProcessCallbacks).toHaveBeenCalledOnce();
  });

  it('should mark sync recovered only when queue settles with pure remote success', () => {
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 2,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should not mark sync recovered when queue settlement includes local-only completion', () => {
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 1,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).not.toHaveBeenCalled();
  });

  it('should mark sync recovered when ActionQueue only settles a tombstone no-op after RetryQueue already recovered', () => {
    mockSyncService.hasPendingRetryRecovery.mockReturnValueOnce(true);
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 1,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should mark sync recovered when RetryQueue already recovered and ActionQueue only drains local-only completions', () => {
    mockSyncService.hasPendingRetryRecovery.mockReturnValueOnce(true);
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should not mark sync recovered for pure authoritative no-op without retry recovery signal', () => {
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 1,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).not.toHaveBeenCalled();
  });
});
