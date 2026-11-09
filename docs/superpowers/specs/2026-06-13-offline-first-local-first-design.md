# Offline-first / Local-first Architecture Design

## Goal

Make offline and weak-network operation a first-class supported mode in NanoFlow. User edits must commit to durable local storage first, update the UI immediately, and synchronize silently in the background without data loss under refresh, browser close, app restart, network loss, request timeout, server 5xx, rate limiting, auth expiry, or interrupted sync.

This design covers the full target architecture and defines a staged implementation. Phase 1 focuses on the highest-risk core domain: `Project`, `Task`, and `Connection`. Later phases bring `Focus`, `BlackBox`, attachments, external sources, widgets, speech-to-text, preferences, and local backup under the same contracts.

## Current Data-flow Audit

Current implementation already has several useful offline pieces:

- `ProjectDataService` persists offline snapshots and startup snapshots for project recovery.
- `SyncCoordinatorPersistService` saves project snapshots locally and debounces remote project persistence.
- `ActionQueueService` provides owner-scoped durable queueing, processors, dead letters, queue freeze, retry scheduling, and escape export.
- `RetryQueueService` persists retryable task/project/connection/blackbox push failures in IndexedDB with localStorage fallback.
- `SyncRpcClientService` passes `operationId` to Supabase RPCs such as task/project/connection upsert and delete.
- Supabase sync RPC migrations document idempotency, protocol fencing, ownership checks, and server-arrival LWW.
- `ConflictStorageService`, conflict modals, and project conflict services already preserve some local/remote conflict data.
- E2E tests already cover offline-mode and weak-network budgets.

Important gaps remain:

- Core task and connection edits primarily flow through `TaskRecordTrackingService.recordAndUpdate()` / `recordAndUpdateDebounced()`: update in-memory project state, track changes, schedule local snapshot save, then debounce cloud persistence.
- `ChangeTrackerService` is an in-memory pending-change map. It is not a durable operation log and cannot alone prove recovery after refresh or crash.
- `RetryQueueService` is a failure recovery queue. It receives work after remote push fails, not before the foreground operation is considered locally committed.
- `QueuedAction` has `id`, but no explicit stable `operationId` contract that all processors must pass to RPC and logs.
- `ActionQueueEnqueueMutationService.mergeQueuedAction()` only merges project payloads. Task and connection consecutive updates do not yet have first-class merge rules.
- `TaskRecordTrackingService.setupSyncResultHandler()` currently rolls back optimistic snapshots when `syncError()` is set. Network errors, 5xx, timeouts, rate limits, and auth-pending conditions must not roll back locally committed user work.

## Offline And Weak-network Risk List

- Local operation loss: successful UI mutation may only be represented by in-memory state and a scheduled snapshot until persistence completes.
- Refresh recovery gap: pending changes can be restored as a project snapshot, but not always as replayable operation intent with original ordering.
- Duplicate writes: retrying create/update/delete without a stable operation id can duplicate or reorder effects.
- Old request overwrite: delayed remote responses can arrive after newer local edits and incorrectly clear dirty state or overwrite fields.
- Rollback on transient failure: global sync errors can rollback optimistic snapshots even when the correct behavior is pending retry.
- Queue split-brain: `ActionQueue` and `RetryQueue` can express related pending work differently.
- Conflict loss: some conflicts are preserved, but automatic LWW paths can still hide field-level or delete-vs-update ambiguity.
- Auth and protocol blocking: expired auth or rejected protocol should pause sync, not reject local editing or drop operations.
- Storage pressure: if local durable write fails, pretending success creates data-loss risk.
- Long offline sessions: queue size, compaction, and merge behavior must avoid unbounded growth while preserving semantic operations.

## Architecture Decision

Use the existing `ActionQueue` as the unified durable Outbox, not a new parallel queue.

The current code already has owner-scoped storage, processors, dead letters, network listeners, frozen queue state, and dashboard visibility. Reusing it avoids a second queue UI and reduces migration risk. `RetryQueue` will be gradually narrowed into an Outbox retry/dead-letter compatibility layer, then retired for operations covered by Outbox.

Rejected alternatives:

- Keep current snapshot + RetryQueue model and add more try/catch: insufficient because it does not make every write a durable operation before UI commit.
- Build a brand-new queue beside `ActionQueue`: creates duplicate state, duplicate dashboards, and higher migration risk.
- Move all logic into service worker background sync: Angular service worker is suitable for resource caching, not domain conflict resolution and durable business operation replay.

## Target Module Boundaries

### Local Mutation Boundary

New domain-facing entry points must follow this sequence:

1. Build an operation record with `operationId`, entity identity, base revision, payload diff, and merge policy.
2. Persist the operation to the local Outbox.
3. Persist the affected local entity/snapshot atomically or in a verified two-step sequence with recovery metadata.
4. Update Signals/UI state.
5. Schedule background sync.

If durable local persistence fails, the user operation must not be reported as successful. UI should show a storage-pressure or local-write-failed state and keep existing data unchanged.

### Outbox

`ActionQueue` becomes the canonical Outbox:

- `operationId`: stable across retries and processor handoff.
- `id`: local queue record id, retained for UI and storage identity.
- `entityType`: project, task, connection, preference, focus-session, routine-task, routine-completion, blackbox, attachment, external-source-link, widget, speech-transcription.
- `operationType`: create, update, delete, restore, reorder, move, attach, detach, upsert.
- `baseUpdatedAt` / `baseVersion`: remote baseline used to prevent stale overwrites.
- `localRevision`: monotonic local revision for ordering.
- `createdAt`, `localCommittedAt`, `lastAttemptAt`, `nextAttemptAt`.
- `syncState`: local_committed, pending_sync, syncing, retry_scheduled, synced, conflict_detected, conflict_saved, dead_letter, blocked_by_auth, blocked_by_protocol, storage_frozen.
- `mergeKey`: entity-level key used for compaction.
- `idempotencyKey`: derived from `operationId` unless a server API needs a different key.
- `conflictPolicy`: auto-merge, field-level, preserve-both, user-review.

### Repository Layer

Add a small set of repositories around current state services:

- `ProjectLocalRepository`: project metadata, active project snapshot, project-level operation creation.
- `TaskLocalRepository`: task create/update/delete/move/reorder/status/attachment metadata writes.
- `ConnectionLocalRepository`: connection create/update/delete/relink writes.
- `OutboxRepository`: durable queue append, merge, state transitions, and owner scoping.
- `LocalReadRepository`: startup hydration from IndexedDB snapshots plus pending outbox replay.

Repositories should not replace all existing services in one step. They become the contract used by `TaskRecordTrackingService`, `ProjectOperationService`, and sync processors.

### Sync Engine

Background sync consumes Outbox entries. It does not participate in foreground editing.

Responsibilities:

- Drain pending operations by owner and project with a sync writer lease.
- Preserve per-entity operation ordering.
- Apply compaction before sync when safe.
- Pass `operationId` to `SyncRpcClientService`.
- Classify failures as retryable, blocked, conflict, permanent, or dead-letter.
- Update Outbox state and dashboard counts.
- Never mutate UI state directly except through repository-confirmed remote metadata updates.

### Network Monitor And Retry Scheduler

Use existing `NetworkAwarenessService`, browser online/offline events, and sync state, but formalize retry scheduling:

- Offline: pause remote attempts, keep editing enabled.
- Weak network / timeout / 5xx / 429: exponential backoff with jitter and per-error ceiling.
- Auth expired: pause sync as `blocked_by_auth`, keep local writes enabled if local owner context is safe.
- Protocol rejected: pause cloud writes and surface update-required state; keep local data durable and exportable.
- Storage frozen: block new local commits that cannot be persisted, show dashboard recovery path.

### Conflict Resolver

Conflict resolver consumes remote RPC statuses and pull deltas:

- Same field changed locally and remotely: preserve both versions unless a domain rule is safe.
- Different fields changed: field-level merge if task identity and base revision match.
- Delete vs update: keep tombstone and conflict copy; do not silently resurrect or drop.
- Remote newer than local base: save conflict with local operation, local entity snapshot, remote snapshot, base revision, and operationId.
- Unresolved conflicts stay visible in conflict storage and dashboard until resolved.

## Data Synchronization State Machine

```text
local_committed
  -> pending_sync
  -> syncing
  -> synced

syncing
  -> retry_scheduled
  -> pending_sync

syncing
  -> blocked_by_auth
  -> pending_sync

syncing
  -> blocked_by_protocol

syncing
  -> conflict_detected
  -> conflict_saved

syncing
  -> dead_letter

any durable state
  -> storage_frozen
```

State rules:

- `local_committed` proves local persistence succeeded.
- Only `synced` can clear the Outbox entry and related ChangeTracker dirty marker.
- Retryable sync failures must not rollback UI or delete local operations.
- Permanent business rejection can roll back only the rejected operation scope and must preserve an audit/dead-letter record.
- Conflict states must preserve local and remote data.

## Idempotency Strategy

- Every operation gets `operationId = crypto.randomUUID()` at first durable local commit.
- Retried and replayed operations reuse the same `operationId`.
- RPC payloads must use `operation_id: operation.operationId`.
- Create operations rely on client-generated entity UUID plus operationId.
- Update operations carry `baseUpdatedAt` / `baseVersion` and local revision.
- Delete operations carry tombstone timestamp and baseUpdatedAt.
- Batch operations carry one batch operationId and per-entity operation members when partial retry is possible.
- Duplicate server acknowledgement for the same operationId is treated as success.
- Delayed responses cannot clear newer local work unless their acknowledged local revision is still current.

## Operation Ordering And Compaction

Ordering:

- Per entity: process by `localRevision` and `localCommittedAt`.
- Parent-child task creation: parent create must sync before child create or move.
- Connection create requires endpoint task create/update dependencies to be satisfied.
- Delete is a barrier: do not merge updates across delete.

Compaction:

- Multiple title/content updates on the same task can merge into the newest payload while preserving the earliest base revision.
- Multiple position/rank updates can merge into the latest position and rank if no parent/stage change crosses the sequence.
- Move/reparent operations can merge only when no connection or child dependency would be hidden.
- Create followed by update can fold update into create.
- Create followed by delete before sync can become a local-only tombstone cleanup if no external dependency exists.
- Delete followed by restore becomes a conflict-prone pair and must not be silently collapsed until server state is known.

## Implementation Phases

### Phase 1: Core Outbox Contract

Files likely touched:

- `src/services/action-queue.types.ts`
- `src/services/action-queue-enqueue-mutation.service.ts`
- `src/services/action-queue-storage.service.ts`
- `src/services/action-queue-processing.controller.ts`
- `src/services/action-queue-project-processors.service.ts`
- `src/services/action-queue-task-focus-processors.service.ts`
- `src/services/sync-rpc-client.service.ts`

Deliverables:

- Add explicit `operationId` and sync-state metadata to `QueuedAction`.
- Ensure durable enqueue resolves only after storage confirmation.
- Preserve operationId through processors and RPC calls.
- Add tests for operationId stability across retry, reload, and owner handoff.

### Phase 2: Task And Connection Local Repositories

Files likely touched or created:

- `src/services/task-record-tracking.service.ts`
- `src/services/task-operation-adapter.service.ts`
- `src/services/task-operation.service.ts`
- `src/services/task-connection.service.ts`
- `src/services/change-tracker.service.ts`
- `src/services/local-first/task-local-repository.service.ts`
- `src/services/local-first/connection-local-repository.service.ts`

Deliverables:

- Introduce durable local operation creation before UI commit for task and connection mutations.
- Stop rolling back on transient sync errors.
- Keep undo/redo as explicit local operations.
- Add tests for refresh recovery, transient failure persistence, and ordering.

### Phase 3: Project Snapshot And Startup Hydration

Files likely touched:

- `src/app/core/services/sync/project-data.service.ts`
- `src/app/core/services/sync/project-offline-snapshot.service.ts`
- `src/services/sync-coordinator-persist.service.ts`
- `src/services/user-session-layer-*.service.ts`

Deliverables:

- Hydrate from local project snapshot plus Outbox replay.
- Prevent stale cloud pulls from overwriting local pending changes.
- Tie project dirty clearing to acknowledged operation revisions.

### Phase 4: RetryQueue Convergence

Files likely touched:

- `src/app/core/services/sync/retry-queue.service.ts`
- `src/app/core/services/sync/retry-queue.types.ts`
- `src/app/core/services/sync/sync-resume-coordinator.service.ts`
- `src/app/shared/components/sync-status.component.ts`
- `src/app/shared/modals/dashboard-modal.component.ts`

Deliverables:

- Migrate task/project/connection retry records into Outbox-compatible entries.
- Keep legacy retry review for existing users until migration is safe.
- Show a single user-facing pending/dead-letter model.

### Phase 5: Broader Domain Coverage

Domains:

- Focus and BlackBox entries.
- Attachments and virus-scan metadata.
- External source links.
- Widgets and Android callback flows.
- Speech-to-text offline replay.
- Preferences and local backup.

Deliverables:

- Each domain uses repository + Outbox.
- Domain-specific conflict policies documented and tested.

## Testing Strategy

Unit tests:

- `ActionQueue` creates stable operationId and persists before enqueue success.
- Outbox merge rules preserve baseUpdatedAt and delete barriers.
- Retryable errors move to retry_scheduled, not rollback.
- Auth-pending and protocol-rejected states pause sync but preserve local operations.
- Conflict resolver preserves local and remote copies.

Integration tests:

- Task create/edit/delete while offline, refresh, then reconnect and sync.
- Drag/reorder while weak network repeatedly times out.
- Connection create with endpoint task dependency.
- Delete vs remote update conflict.
- Same field local/remote conflict.
- Storage failure blocks write and does not mutate UI.

E2E tests:

- Existing `e2e/critical-paths/offline-mode.spec.ts`.
- Existing weak-network startup/budget specs.
- New local-first flow: offline create/edit/reorder, reload page, confirm pending state and UI continuity, reconnect, confirm remote sync and no duplicates.

Verification commands:

```bash
npx vitest run --config vitest.config.mts src/services/action-queue.service.spec.ts
npx vitest run --config vitest.config.mts src/services/task-record-tracking.service.spec.ts
npx vitest run --config vitest.config.mts src/services/sync-coordinator-persistence.spec-helpers.ts
npx vitest run --config vitest.config.mts src/app/core/services/sync/task-sync-operations.service.spec.ts
npm run test:e2e -- e2e/critical-paths/offline-mode.spec.ts
npm run test:run:services
npx tsc --noEmit --pretty false --incremental false
```

## Manual Acceptance Steps

1. Start app, log in, open an existing project.
2. Go offline in DevTools.
3. Create tasks, edit title/content, toggle status, drag/reorder, create and delete connections.
4. Refresh while still offline.
5. Confirm all local edits remain visible and pending sync count is stable.
6. Close and reopen browser.
7. Confirm local state and Outbox are restored.
8. Reconnect network.
9. Confirm sync starts silently and UI remains usable.
10. Confirm Supabase contains exactly one create/delete per entity and latest updates win only where allowed.
11. Simulate 5xx/timeout/429 and confirm retry scheduling without UI rollback.
12. Simulate auth expiry and confirm local editing continues while sync is blocked.
13. Create a remote conflict and confirm conflict center preserves both versions.

## Completion Criteria

- User operations are visible immediately after local durable commit.
- Full offline mode supports continued work on existing local data.
- Refresh/browser restart recovers local data and unsynced operations.
- Reconnect sync is automatic and silent.
- Retryable remote failures never silently drop local operations.
- Duplicate requests do not create duplicates.
- Old responses do not overwrite newer local data.
- Unresolvable conflicts preserve both local and remote data.
- Storage failure is surfaced and blocks unsafe writes.
- Tests prove local durable commit, replay, idempotency, retry, and conflict preservation.

## Open Edges And Later Optimization

- Cross-device real-time merge can be improved after durable local Outbox is canonical.
- Large attachment binary data may need a separate blob operation store.
- Background sync via service worker can be evaluated later, but should remain a transport optimization, not the source of truth.
- Queue compaction should begin conservative and become more aggressive only after conflict tests cover each operation family.
- Existing user migration from RetryQueue to Outbox should support rollback and dashboard review.
