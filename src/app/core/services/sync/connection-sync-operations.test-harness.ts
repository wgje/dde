import { expect, vi } from 'vitest';
import type { SyncRpcClientService, SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { Connection } from '../../../../models';

export type ConnectionTombstoneResult = { data: { connection_id: string; deleted_at?: string | null } | null; error: unknown | null };
export type ConnectionEndpointTombstoneResult = { data: { deleted_at: string } | null; error: unknown | null };
export type LegacyConnectionTombstoneResult = {
  data: { deleted_at: string } | null;
  error: unknown | null;
};
export type TaskExistenceResult = { data: Array<{ id: string }>; error: unknown | null };
export type EndpointDedupResponse = {
  data: Array<{ id: string; deleted_at: string | null; updated_at?: string | null; title?: string | null; description?: string | null }>;
  error: unknown | null;
};
export type ConnectionFreshnessResult = { data: { id: string; updated_at: string | null; deleted_at: string | null } | null; error: unknown | null };
export type ConnectionWriteResult = { data: { updated_at: string } | null; error: unknown | null };
export type ProjectConnectionState = { id: string; connections: Connection[]; tasks: unknown[] };
type BooleanSignalMock = ReturnType<typeof vi.fn<() => boolean>>;
type RetryQueueAddMock = ReturnType<typeof vi.fn>;
export type MockSyncRpcClient = {
  isFeatureEnabled: BooleanSignalMock;
  isClientRejected: BooleanSignalMock;
  upsertConnection: ReturnType<typeof vi.fn<SyncRpcClientService['upsertConnection']>>;
};

export function expectConnectionRetryEnqueued(
  retryQueue: { addDurably: RetryQueueAddMock },
  connection: Connection,
  projectId = 'project-1',
  sourceUserId = 'user-1',
  operationId: string | ReturnType<typeof expect.any> | undefined = undefined,
): void {
  expect(retryQueue.addDurably).toHaveBeenCalledWith(
    'connection',
    'upsert',
    connection,
    projectId,
    sourceUserId,
    undefined,
    undefined,
    undefined,
    operationId,
  );
}

export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

export function createSyncRpcResult(overrides: Partial<SyncRpcResult> = {}): SyncRpcResult {
  return {
    status: 'applied',
    raw: {},
    ...overrides,
  };
}

export function createMockSyncRpcClient(): MockSyncRpcClient {
  return {
    isFeatureEnabled: vi.fn<() => boolean>().mockReturnValue(false),
    isClientRejected: vi.fn<() => boolean>().mockReturnValue(false),
    upsertConnection: vi.fn<SyncRpcClientService['upsertConnection']>(),
  };
}

export function resetMockSyncRpcClient(client: MockSyncRpcClient): void {
  client.isFeatureEnabled.mockReturnValue(false);
  client.isClientRejected.mockReturnValue(false);
  const defaultResult = createSyncRpcResult({ entityId: 'connection-1' });
  client.upsertConnection.mockImplementation(async () => defaultResult);
}

export function buildConnectionUpsertQuery(
  rawResult: unknown,
): { select: ReturnType<typeof vi.fn> } {
  if (
    rawResult
    && typeof rawResult === 'object'
    && 'select' in rawResult
    && typeof (rawResult as { select?: unknown }).select === 'function'
  ) {
    return rawResult as { select: ReturnType<typeof vi.fn> };
  }

  return {
    select: vi.fn(() => ({
      maybeSingle: vi.fn(async () => {
        const resolved = await Promise.resolve(rawResult);
        return (resolved ?? { data: null, error: null }) as ConnectionWriteResult;
      }),
    })),
  };
}
