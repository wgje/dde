import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { OfflineSyncOwnerCaptureCoordinatorService } from './offline-sync-owner-capture-coordinator.service';
import { bindAuthOwnerTransition } from '../../../../services/auth-owner-transition.controller';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import { AuthService } from '../../../../services/auth.service';
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { RetryQueueService } from './retry-queue.service';
import { ActionQueueService } from '../../../../services/action-queue.service';
import type { OfflineSyncCommandEnvelope } from '../../../../services/sync/offline-sync-command-envelope';

describe('offline-sync-owner-capture-coordinator.service', () => {
  it('can be constructed without enabling capture in test environments', () => {
    expect(OfflineSyncOwnerCaptureCoordinatorService).toBeDefined();
    expect(vi.fn()).toBeDefined();
  });

  it.each([
    { binding: 'matching', unknown: false },
    { binding: 'matching', unknown: true },
    { binding: 'different-command', unknown: true },
    { binding: 'legacy', unknown: true },
    { binding: 'legacy', unknown: false },
  ] as const)('drains after online without falsely settling $binding receipt (unknown=$unknown)', async ({ binding, unknown }) => {
    const ownerUserId = `owner-connectivity-${binding}-${unknown}`;
    const receipts = new Map<string, OfflineSyncCommandEnvelope>();
    const flagDescriptor = Object.getOwnPropertyDescriptor(FEATURE_FLAGS, 'OFFLINE_COMMAND_CAPTURE_V1');
    Object.defineProperty(FEATURE_FLAGS, 'OFFLINE_COMMAND_CAPTURE_V1', {
      configurable: true, enumerable: true, writable: true, value: true,
    });
    const authOwner = { value: null as string | null };
    const auth = { currentUserId: () => authOwner.value } as unknown as AuthService;
    let onCommitted!: (ownerUserId: string | null) => void;
    const transition = {
      onCommitted: vi.fn((listener: (ownerUserId: string | null) => void) => {
        onCommitted = listener;
        return () => undefined;
      }),
    };
    bindAuthOwnerTransition(auth, transition as never);
    const protocolProbe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        minProtocolVersion: 1,
        deploymentEpoch: 1,
        capabilities: ['command-envelope-v1', 'field-lww-v1', 'domain-apply-v1'],
      });
    const pullOfflineProjections = vi.fn().mockResolvedValue([]);
    const applyOfflineCommand = vi.fn(async ({ operationId }: { operationId: string }) => ({
      status: 'accepted-shadow', operationId, raw: { status: 'accepted-shadow', operationId },
    }));
    const getOfflineCommandStatus = vi.fn(async ({ operationId }: { operationId: string }) => ({
      status: 'applied', operationId, domainApplyStatus: 'applied', appliedToDomainTables: true,
      raw: { status: 'applied', operationId, domainApplyStatus: 'applied', appliedToDomainTables: true,
        ...(binding === 'legacy' && operationId === '22222222-2222-4222-8222-222222222222' ? {} : {
          commandDigest: 'c9a6ea7db738d8cb5fc354f55fd74805f0b1308183ce1b7cdaffb05d5502c619',
          commandIdentity: receiptIdentity(receipts.get(operationId)!, binding === 'different-command' && operationId === '22222222-2222-4222-8222-222222222222'),
        }),
      },
    }));
    const retryHandler = {
      pushTask: vi.fn(), deleteTask: vi.fn(), pushProject: vi.fn(), pushConnection: vi.fn(),
      isSessionExpired: () => false, isOnline: () => true, onProcessingStateChange: () => undefined,
    };
    const retryItem = {
      id: '11111111-1111-4111-8111-111111111111', operationId: '22222222-2222-4222-8222-222222222222',
      type: 'task', operation: 'upsert',
      data: { id: '33333333-3333-4333-8333-333333333333', title: 'Retry task', content: 'from durable RetryQueue' },
      projectId: '44444444-4444-4444-8444-444444444444', retryCount: 0, createdAt: Date.now(), sourceUserId: ownerUserId,
      ...(unknown ? { lastFailure: { remoteOutcome: 'unknown' } } : {}),
    } as never;
    const queuedAction = {
      id: '55555555-5555-4555-8555-555555555555', operationId: '66666666-6666-4666-8666-666666666666',
      type: 'update', entityType: 'task', entityId: '77777777-7777-4777-8777-777777777777',
      payload: { task: { id: '77777777-7777-4777-8777-777777777777', title: 'Action task', content: 'from durable ActionQueue' }, projectId: '44444444-4444-4444-8444-444444444444', sourceUserId: ownerUserId },
      timestamp: Date.now(), retryCount: 0,
    } as never;
    const logger = { category: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
    const injector = Injector.create({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: SyncRpcClientService, useValue: {
        checkProtocol: protocolProbe, pullOfflineProjections, applyOfflineCommand, getOfflineCommandStatus,
      } },
      { provide: RetryQueueService, useValue: {
        getOperationHandler: () => retryHandler,
        getOwnerItemsSnapshot: () => ({ status: 'ready', items: [retryItem] }),
      } },
      { provide: ActionQueueService, useValue: {
        getCurrentOwnerStorageLoadState: () => 'loaded',
        pendingActions: () => [queuedAction],
      } },
      { provide: LoggerService, useValue: logger },
      OfflineSyncOwnerCaptureCoordinatorService,
    ] });
    const service = runInInjectionContext(injector, () => injector.get(OfflineSyncOwnerCaptureCoordinatorService));
    try {
      service.bind();
      authOwner.value = ownerUserId;
      onCommitted(ownerUserId);
      await vi.waitFor(() => expect(protocolProbe).toHaveBeenCalledTimes(1));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const runtimeCoordinator = (service as unknown as { coordinator: {
        currentOwnerUserId(): string | null;
        isActive(): boolean;
        activeStore: { exportOwner<TCommand, TProjection>(owner: string): Promise<{ commands: Array<{ operationId: string; status: string; command: OfflineSyncCommandEnvelope }> }> };
      } }).coordinator;
      expect(runtimeCoordinator.currentOwnerUserId()).toBe(ownerUserId);
      expect(runtimeCoordinator.isActive()).toBe(true);
      expect(pullOfflineProjections).not.toHaveBeenCalled();
      const offlineSnapshot = await runtimeCoordinator.activeStore.exportOwner(ownerUserId);
      expect(offlineSnapshot.commands.map(item => item.operationId).sort()).toEqual([
        '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666',
      ]);
      expect(offlineSnapshot.commands.find(item => item.operationId === '22222222-2222-4222-8222-222222222222')?.status).toBe(unknown ? 'unknown' : 'pending');
      for (const item of offlineSnapshot.commands) receipts.set(item.operationId, item.command);

      expect((service as unknown as { browserEventsWindow: Window }).browserEventsWindow).toBe(window);
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(protocolProbe).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(pullOfflineProjections).toHaveBeenCalledTimes(2));
      expect(applyOfflineCommand).toHaveBeenCalledTimes(unknown ? 1 : 2);
      expect(getOfflineCommandStatus).toHaveBeenCalledTimes(2);
      const onlineSnapshot = await runtimeCoordinator.activeStore.exportOwner(ownerUserId);
      const retry = onlineSnapshot.commands.find(item => item.operationId === '22222222-2222-4222-8222-222222222222');
      expect(retry?.status).toBe(binding === 'legacy' || (unknown && binding !== 'matching') ? 'unknown' : 'acked');
      expect(retry?.command.normalizedResultPatch['content']).toBe('from durable RetryQueue');
      expect(onlineSnapshot.commands.find(item => item.operationId === '66666666-6666-4666-8666-666666666666')?.status).toBe('acked');
    } finally {
      service.dispose();
      if (flagDescriptor) Object.defineProperty(FEATURE_FLAGS, 'OFFLINE_COMMAND_CAPTURE_V1', flagDescriptor);
    }
  });
});
function receiptIdentity(value: OfflineSyncCommandEnvelope, differentPatch: boolean): Record<string, unknown> {
  return {
    identityVersion: 1, schemaVersion: value.schemaVersion, operationId: value.operationId,
    ownerUserId: value.ownerUserId, installationId: value.installationId, deviceId: value.deviceId,
    logicalClock: value.logicalClock, entityType: value.entityType, entityId: value.entityId,
    projectId: value.projectId ?? null, command: value.command, intent: value.intent,
    baseVersion: value.baseVersion ?? null, baseUpdatedAt: value.baseUpdatedAt ?? null,
    normalizedResultPatch: differentPatch ? { content: 'another write' } : value.normalizedResultPatch,
    dependencyOperationIds: value.dependencyOperationIds, fieldVersions: {},
  };
}
