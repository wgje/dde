---
title: Sync Contract
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-11-04
source_paths:
  - src/config/sync.config.ts
  - src/app/core/services/sync/
  - src/app/core/state/store-persistence.service.ts
  - src/services/conflict-*.ts
  - src/services/local-backup-ui-restore-*.ts
  - src/app/shared/modals/settings-modal/local-backup-ui.service.ts
---

# Sync Contract

This contract defines behavior that sync-related code must preserve.

## Invariant Summary

| ID | Invariant | Verification evidence |
| --- | --- | --- |
| SYNC-001 | Local writes update UI before cloud confirmation. | service/component tests for local mutation path |
| SYNC-002 | Failed remote writes enter a retry or isolation path. | retry queue tests, permission denied tests |
| SYNC-003 | LWW uses `updatedAt` / `updated_at`. | model, mapper, conflict tests |
| SYNC-004 | Soft deletes use `deletedAt` / `deleted_at` and tombstones. | tombstone tests |
| SYNC-005 | Task reads include `content`. | field selector tests or config audit |
| SYNC-006 | Project snapshots are verified after IndexedDB writes. | persistence tests |
| SYNC-007 | Retry queue overflow does not silently discard user work. | queue capacity tests |
| SYNC-008 | Permission denial isolates or exports rejected local data. | permission denied flow tests |
| SYNC-009 | Realtime is optional; polling is a valid fallback. | polling/realtime tests |
| SYNC-010 | Delta cursor advances from server-observed timestamps when enabled. | cursor tests |

## Local-First Write Contract

Required flow:

```text
user intent
  -> domain service
  -> concrete Signal store
  -> immediate UI state
  -> local persistence
  -> debounced cloud push
  -> retry/isolation on failure
```

Disallowed flow:

```text
user intent
  -> await cloud write
  -> then update UI
```

Exceptions must be explicit administrative flows and documented.

## Read Contract

Required flow:

```text
IndexedDB or local snapshot
  -> render usable UI
  -> background cloud refresh
  -> merge by revision and tombstones
  -> persist merged local state
```

Cold start should not require successful Supabase access for local-mode work.

## Conflict Contract

Conflict resolution is timestamp-based unless a feature implements a more specific merge.

Rules:

- Local and remote timestamps must be comparable before direct overwrite.
- If remote state is newer, direct push must not overwrite it silently.
- If a remote tombstone exists and local does not reflect deletion, treat it as a conflict or deletion signal.
- Clock uncertainty must not produce silent destructive overwrite.

## Field Selector Contract

Task selectors must include:

- `content`
- `attachments`
- `parking_meta`
- `attention_meta`
- planning fields
- `updated_at`
- `deleted_at`

Dropping fields is a data-loss risk.

## Tombstone Contract

Tombstones exist to prevent deleted entities from resurrecting.

Required behavior:

- deletion creates or observes tombstone state
- pulls process tombstones
- tombstones are retained for the configured retention window
- merge logic respects deleted state

## Retry Queue Contract

RetryQueue behavior:

- accepts failed writes
- deduplicates where appropriate
- preserves enough payload for replay or recovery
- handles capacity using durable-first strategy
- exposes terminal or rejected states when replay cannot proceed

The task-row mapper contract test covers this rejection path.`n`nRemote task rows without a string content field are rejected before tombstone
materialization. They must not be normalized into an empty body, because that
would turn an incomplete response into visible data loss.

Connection replay keeps two retry paths explicit: the unfenced callback is named
`enqueueRetry`, while an ActionQueue replay fence uses
`ConnectionRetryEnqueueService.enqueueConnectionUpsertFromActionQueue()` and
the durable `RetryQueueService.commitConnectionReplay()` path. The callback
name does not change behavior; it prevents the durable ActionQueue contract
guard from confusing a retry callback with the legacy synchronous queue API.

## Local Backup Restore Contract

The settings restore is an owner-scoped transaction across local persistence layers. It must keep writers quiescent while stages run, preserve queue `operationId` values, and compensate in reverse stage order when a stage fails.

Terminal finalization verifies the QueueBackup result digest against a durable queue snapshot, then updates and reads back the current owner's local queue mirror while the restore journal and quiescence evidence remain. If this fails, the completed/finalizing marker is retained so startup recovery can retry after matching owner, journal, queue, and quiescence evidence expires. After finalization, the settings flow reloads ActionQueue and compares in-memory pending and dead-letter queues with durable read-back before reporting success; unknown or mismatched recovery evidence fails closed and remains available for diagnosis.

## Sync Change Checklist

Before merging sync changes:

1. Identify which invariant IDs are touched.
2. Update tests for those invariants.
3. Verify field selectors still include required fields.
4. Verify soft-delete/tombstone behavior.
5. Verify local-first UX path.
6. Update [../sync-offline.md](../sync-offline.md) and this contract when semantics change.
