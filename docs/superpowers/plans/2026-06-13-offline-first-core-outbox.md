# Offline-first Core Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `ActionQueue` a durable Outbox contract with stable `operationId` values that survive merge, reload, retry, owner handoff, and processor-to-RPC replay.

**Architecture:** Keep `id` as the local queue-record identity and add `operationId` as the remote idempotency identity. The queue creates `operationId` at first local commit, preserves it through compaction, and processors pass it into task/connection/project sync paths instead of allowing lower layers to generate unrelated RPC operation IDs.

**Tech Stack:** Angular 19 services, Signals, Supabase JS v2 RPC calls, Vitest service tests, existing `ActionQueueService`, `TaskSyncOperationsService`, `ConnectionSyncOperationsService`, and project sync services.

---

## File Structure

- Modify: `src/services/action-queue.types.ts`
  - Add `OutboxSyncState`, optional operation metadata, and `operationId` to `QueuedAction`.
  - Allow `EnqueueParams` callers to provide `operationId` for migration/replay, while normal UI writes omit it.
- Modify: `src/services/action-queue-enqueue-mutation.service.ts`
  - Create `operationId` once per new queue record.
  - Preserve the existing queued action's `operationId` when merge compacts consecutive operations.
  - Add initial `syncState: 'pending_sync'` and `localCommittedAt`.
- Modify: `src/services/action-queue.service.spec.ts`
  - Test new queued actions have distinct `id` and `operationId`.
  - Test merged updates preserve the first queued action's `operationId`.
  - Test persisted/reloaded queue keeps the same `operationId`.
- Modify: `src/app/core/services/sync/task-sync-operations.types.ts`
  - Add optional `operationId` to task push/delete request types.
- Modify: `src/app/core/services/sync/task-sync-operations.service.ts`
  - Thread optional `operationId` through public `pushTask()` and `deleteTask()` to implementation services.
- Modify: `src/app/core/services/sync/task-sync-push.service.ts`
  - Use provided request `operationId` for `sync_upsert_task`; generate only as fallback for legacy direct calls.
- Modify: `src/app/core/services/sync/task-sync-delete.service.ts`
  - Use provided request `operationId` for single delete / purge RPC; generate only as fallback for legacy direct calls.
- Modify: `src/services/action-queue-task-focus-processors.service.ts`
  - Pass `action.operationId` into task upsert/delete sync calls.
- Modify: `src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts`
  - Add a regression test proving a caller-supplied operationId reaches `SyncRpcClientService.upsertTask()`.
- Modify: `src/services/action-queue-processors.service.spec.ts`
  - Add processor-level tests proving queued task upsert/delete pass `action.operationId` into `TaskSyncOperationsService`.
- Later task files:
  - `src/app/core/services/sync/connection-sync-operations.service.ts`
  - `src/services/action-queue-connection-processors...` once the connection queue processor boundary is located.
  - `src/app/core/services/sync/project-push.service.ts`, `project-delete-coordinator.service.ts`, and save-flight coordinator after the task path is green.

## Task 1: OperationId On Queue Records

**Files:**
- Modify: `src/services/action-queue.types.ts`
- Modify: `src/services/action-queue-enqueue-mutation.service.ts`
- Test: `src/services/action-queue.service.spec.ts`

- [ ] **Step 1: Write the failing queue identity tests**

Add tests under `describe('队列持久化')` or a new `describe('Outbox operationId')` block:

```typescript
it('新入队操作应同时拥有本地 id 和远端 operationId', () => {
  setNetworkStatus(false);
  const actionId = service.enqueue(createTestTaskAction());
  const [queued] = service.pendingActions();

  expect(actionId).toBe(queued.id);
  expect(queued.id).toEqual(expect.any(String));
  expect(queued.operationId).toEqual(expect.any(String));
  expect(queued.operationId).not.toBe(queued.id);
  expect(queued.syncState).toBe('pending_sync');
  expect(queued.localCommittedAt).toEqual(expect.any(Number));
});

it('连续 update 合并时应保留原 operationId 作为幂等键', () => {
  setNetworkStatus(false);
  service.enqueue({
    type: 'update',
    entityType: 'task',
    entityId: 'task-op-merge',
    payload: { task: createMockTask({ id: 'task-op-merge', title: 'first' }), projectId: 'proj-1' },
  });
  const original = service.pendingActions()[0];

  service.enqueue({
    type: 'update',
    entityType: 'task',
    entityId: 'task-op-merge',
    payload: { task: createMockTask({ id: 'task-op-merge', title: 'second' }), projectId: 'proj-1' },
  });

  const [merged] = service.pendingActions();
  expect(merged.id).toBe(original.id);
  expect(merged.operationId).toBe(original.operationId);
  expect((merged.payload as TaskPayload).task.title).toBe('second');
});
```

- [ ] **Step 2: Run red test**

Run:

```bash
npx vitest run --config vitest.config.mts src/services/action-queue.service.spec.ts
```

Expected: FAIL because `QueuedAction` has no `operationId`, `syncState`, or `localCommittedAt`.

- [ ] **Step 3: Implement queue metadata**

Add:

```typescript
export type OutboxSyncState =
  | 'local_committed'
  | 'pending_sync'
  | 'syncing'
  | 'retry_scheduled'
  | 'synced'
  | 'conflict_detected'
  | 'conflict_saved'
  | 'dead_letter'
  | 'blocked_by_auth'
  | 'blocked_by_protocol'
  | 'storage_frozen';
```

Then add fields to `QueuedAction`:

```typescript
operationId: string;
syncState?: OutboxSyncState;
localCommittedAt?: number;
```

Allow every `EnqueueParams` variant to include:

```typescript
operationId?: string;
```

In `createQueuedAction()`:

```typescript
const now = Date.now();
return {
  ...action,
  id: crypto.randomUUID(),
  operationId: action.operationId ?? crypto.randomUUID(),
  timestamp: now,
  localCommittedAt: now,
  syncState: 'pending_sync',
  retryCount: 0,
  priority: action.priority ?? defaultPriority,
};
```

In merge paths, use:

```typescript
operationId: existing.operationId,
localCommittedAt: existing.localCommittedAt ?? existing.timestamp,
```

- [ ] **Step 4: Run green test**

Run the same Vitest command. Expected: PASS for new tests, no regressions in existing action queue specs.

## Task 2: Task RPC OperationId Propagation

**Files:**
- Modify: `src/app/core/services/sync/task-sync-operations.types.ts`
- Modify: `src/app/core/services/sync/task-sync-operations.service.ts`
- Modify: `src/app/core/services/sync/task-sync-push.service.ts`
- Modify: `src/app/core/services/sync/task-sync-delete.service.ts`
- Modify: `src/services/action-queue-task-focus-processors.service.ts`
- Test: `src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts`
- Test: `src/services/action-queue-processors.service.spec.ts`

- [ ] **Step 1: Write failing RPC upsert propagation test**

Add to `registerTaskSyncOperationsRpcUpsertSpecs()`:

```typescript
it('pushTask 应优先使用调用方传入的 operationId', async () => {
  const { service, mockSyncRpcClient } = getContext();
  mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
  const task = createTask({
    id: 'task-rpc-operation-id',
    updatedAt: '2026-06-13T00:00:00.000Z',
  });

  await service.pushTask(task, 'project-1', false, false, 'user-1', false, undefined, 'queued-op-task-1');

  expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
    operationId: 'queued-op-task-1',
  }));
});
```

Expected red: TypeScript signature and implementation do not accept the eighth argument.

- [ ] **Step 2: Write failing processor propagation tests**

In `src/services/action-queue-processors.service.spec.ts`, register task processors and invoke captured callbacks:

```typescript
expect(mockTaskSyncOps.pushTask).toHaveBeenCalledWith(
  task,
  'project-1',
  false,
  false,
  'user-1',
  true,
  undefined,
  'op-from-action',
);
```

For delete:

```typescript
expect(mockTaskSyncOps.deleteTask).toHaveBeenCalledWith(
  'task-delete-1',
  'project-1',
  'user-1',
  false,
  '2026-06-13T00:00:00.000Z',
  'op-delete-from-action',
);
```

- [ ] **Step 3: Run red tests**

Run:

```bash
npx vitest run --config vitest.config.mts src/app/core/services/sync/task-sync-operations.service.spec.ts src/services/action-queue-processors.service.spec.ts
```

Expected: FAIL because operationId is not threaded.

- [ ] **Step 4: Implement task operationId threading**

Add `operationId?: string` to `TaskPushRequest` and `TaskDeleteRequest`.

Append `operationId?: string` to `TaskSyncOperationsService.pushTask()`, `TaskSyncPushService.pushTask()`, and `TaskSyncPushService.doTaskPush()` call chain. In `pushTaskViaSyncRpc()`:

```typescript
operationId: request.operationId ?? this.createSyncRpcOperationId(),
```

Append `operationId?: string` to `TaskSyncOperationsService.deleteTask()` and `TaskSyncDeleteService.deleteTask()`. In single task purge path, pass it to `purgeTasksFromCloudDetailed()` and `purgeTasksViaSyncRpc()`. For batched project-level deletes without an action-level operation id, continue generating a fallback id.

In `ActionQueueTaskFocusProcessorsService`:

```typescript
payload.sourceUserId,
true,
payload.writeIntent,
action.operationId,
```

and:

```typescript
payload.baseUpdatedAt,
action.operationId,
```

- [ ] **Step 5: Run green tests**

Run the same Vitest command. Expected: PASS.

## Task 3: Durable Reload Contract

**Files:**
- Modify: `src/services/action-queue.service.spec.ts`
- Modify: `src/services/action-queue-storage.service.spec.ts` only if existing storage helpers strip unknown fields.

- [ ] **Step 1: Write failing reload test**

```typescript
it('从持久化恢复队列时应保留 operationId', () => {
  setNetworkStatus(false);
  service.enqueue(createTestTaskAction());
  const originalOperationId = service.pendingActions()[0].operationId;

  service.clearCurrentView();
  service.reloadFromStorageForCurrentOwner();

  expect(service.pendingActions()[0].operationId).toBe(originalOperationId);
});
```

- [ ] **Step 2: Run red/green**

Run:

```bash
npx vitest run --config vitest.config.mts src/services/action-queue.service.spec.ts
```

Expected after Task 1: PASS. If it fails, patch the storage restore normalizer to preserve unknown queue fields.

## Task 4: Verification And Handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-06-13-offline-first-local-first-design.md` only if implementation reveals design correction.

- [ ] **Step 1: Run targeted tests**

```bash
npx vitest run --config vitest.config.mts src/services/action-queue.service.spec.ts
npx vitest run --config vitest.config.mts src/app/core/services/sync/task-sync-operations.service.spec.ts
npx vitest run --config vitest.config.mts src/services/action-queue-processors.service.spec.ts
```

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit --pretty false --incremental false
```

- [ ] **Step 3: Record remaining Phase 1 gaps**

At minimum, report whether project and connection RPC operationId propagation is done. If not done, list the exact next files:

```text
src/app/core/services/sync/connection-sync-operations.service.ts
src/app/core/services/sync/project-push.service.ts
src/app/core/services/sync/project-delete-coordinator.service.ts
src/app/core/services/sync/project-save-flight-coordinator.service.ts
```

## Self-Review

- Spec coverage: This plan implements the first architectural prerequisite from the design: explicit, durable Outbox operation identity. It does not claim completion of local repositories, conflict center expansion, RetryQueue retirement, or full domain coverage.
- Placeholder scan: No TBD/TODO placeholders; each task names files, tests, implementation points, and commands.
- Type consistency: The plan uses `operationId`, `OutboxSyncState`, `TaskPushRequest`, `TaskDeleteRequest`, and existing service method names exactly as found in the current code.
