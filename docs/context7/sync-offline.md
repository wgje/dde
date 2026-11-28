---
title: Sync and Offline Behavior
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - src/config/sync.config.ts
  - src/app/core/services/sync/
  - src/app/core/state/store-persistence.service.ts
  - src/services/sync-coordinator*.ts
---

# Sync and Offline Behavior

NanoFlow is offline-first. The application should feel saved immediately after local user actions, then synchronize cloud state in the background.

## Golden Path

Read path:

```text
IndexedDB -> UI state -> background cloud refresh -> merge -> persist locally
```

Write path:

```text
user action -> local stores -> UI update -> IndexedDB save -> debounced cloud push -> RetryQueue on failure
```

Core rule: user data is never intentionally discarded to make cloud state look clean.

## Local Persistence

`StorePersistenceService` writes project snapshots to IndexedDB:

- projects
- tasks
- connections
- meta

The service verifies write integrity after saving by checking project existence and task/connection counts. On failure it retries once. If the retry fails, it can write an emergency fallback snapshot to localStorage.

Relevant config:

- `SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL = 3000`
- `SYNC_CONFIG.DEBOUNCE_DELAY = 3000`
- `INDEXEDDB_HEALTH_CONFIG.CHECK_ON_INIT = true`
- `INDEXEDDB_HEALTH_CONFIG.ON_CORRUPTION = 'prompt-recovery'`

## Cloud Sync

Supabase sync is split into focused services under `src/app/core/services/sync/` and coordinator services under `src/services/`.

Important concepts:

- Project list and detail loading
- Batched RPC when available
- Sequential fallback when RPC is missing or transiently broken
- direct project upsert with remote freshness checks
- tombstone loading and retention
- RetryQueue for failed writes
- polling instead of default Realtime

Relevant config:

| Config | Value |
| --- | --- |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | `30000` |
| `SYNC_CONFIG.POLLING_INTERVAL` | `600000` |
| `SYNC_CONFIG.POLLING_ACTIVE_INTERVAL` | `120000` |
| `SYNC_CONFIG.REALTIME_ENABLED` | from `FEATURE_FLAGS.REALTIME_ENABLED`, default false in project rules |
| `SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS` | `30000` |
| `SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS` | `600000` |
| `SYNC_CONFIG.TOMBSTONE_RETENTION_MS` | 30 days |
| `SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE` | `100` for localStorage queue |
| `SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE_INDEXEDDB` | `1000` |

## Last-Write-Wins

LWW uses timestamps:

- TypeScript models: `updatedAt`
- Supabase rows: `updated_at`

Stores use `updatedAt` plus `deletedAt` as revision equality. This means callers must update `updatedAt` whenever business fields change.

Remote freshness checks compare local and remote timestamps. If timestamp comparison is uncertain because clocks differ, the sync layer can reject direct push and surface a conflict-style error rather than silently overwrite remote state.

## Soft Deletes and Tombstones

Soft deletes use:

- TypeScript models: `deletedAt`
- Supabase rows: `deleted_at`

Tombstones protect deletion propagation. Do not remove tombstone logic unless replacing it with an equivalent recoverable sync strategy.

Trash retention is 30 days in product behavior. Tombstone retention config is also 30 days.

## Retry and Durability

Retry behavior is durability-first.

`SYNC_DURABILITY_CONFIG`:

- `DROP_POLICY = 'soft-overflow'`
- `STORAGE_PRESSURE_MODE = 'memory-fallback'`
- `CURSOR_STRATEGY = 'max-server-updated-at'`

RetryQueue overflow should not silently drop user writes. If storage pressure prevents normal queueing, use the established isolation, notification, or emergency export paths.

## Permission Denied Handling

`PERMISSION_DENIED_CONFIG.ON_PERMISSION_DENIED = 'isolate-and-notify'`.

When RLS or auth changes reject pending writes, do not simply discard local data. The intended behavior is:

1. isolate rejected data
2. notify or offer recovery/export
3. keep enough context for user-controlled resolution

## Network Strategy

The app is conservative with realtime traffic:

- default path uses polling
- active polling interval is shorter than idle polling
- connectivity probe recovers after VPN or network changes
- mobile sync config can pause or reduce sync on background, low battery, cellular, or weak network

Mobile sync highlights:

- `MOBILE_SYNC_CONFIG.PAUSE_WHEN_BACKGROUND = true`
- `MOBILE_SYNC_CONFIG.DISABLE_ATTACHMENT_SYNC_ON_CELLULAR = true`
- `MOBILE_SYNC_CONFIG.DISABLE_AUTO_SYNC_ON_LOW_QUALITY = true`

## Field Selection Rule

Supabase task reads must include `content`. Current task field selectors also include attachments, tags, priority, due dates, planning fields, `parking_meta`, and `attention_meta`.

Never optimize task reads by dropping `content`; that can overwrite local task bodies with empty content during merge.

## Conflict Handling Services

Conflict-related services live in `src/services/`:

- `conflict-detection.service.ts`
- `conflict-resolution.service.ts`
- `conflict-auto-resolver.service.ts`
- `conflict-storage.service.ts`

Use the existing Result Pattern and error conversion. Supabase errors should go through `supabaseErrorToError()`.


## Focus console protocol priming

Focus-session, routine-task and routine-completion replay with a durable operation
ID must prime the existing Sync RPC protocol check when the capability starts
disabled. The protocol client remains responsible for accepted-version/epoch
auto-enable; callers must not force the feature flag or use legacy table writes.
After the await, recheck the captured owner, session runtime generation and
replay lease before invoking a mutation RPC. A missing operation ID, unavailable
probe or rejected protocol retains the operation locally without remote success.
Protocol priming runs in background replay, never as a prerequisite for rendering
the workspace or editing local text.

After protocol priming, recheck the browser suspension window immediately before
selecting the write RPC. A hidden page or newly armed reconnect grace period during
the probe must return SYNC_OFFLINE with retryable/deferred evidence and must not
dispatch any focus, routine-task or completion mutation.

Capture the session runtime generation in the mutation caller before awaiting
capability priming, then revalidate that generation and owner after the await.
Even an already-enabled capability returns through a microtask; a boolean checked
inside the helper before return is not a sufficient post-await identity fence.

When `sync_upsert_focus_session` reports `stale_payload=true`, the remote snapshot
is newer and remains authoritative; retain the rejected local snapshot as a
terminal, owner-scoped dead letter rather than retrying the same LWW write. The
sync-status warning must call this a remote-newer conflict, not data loss, and its
download action must export complete pending actions and dead-letter payloads.
Do not dismiss the dead letter or clear browser storage automatically.

Full and compact-expanded sync panels must provide the same retained-focus conflict explanation and ActionQueue export as the embedded panel. The export includes complete queued operations, not account-wide project entities, sync cursors or attachments.

Queue recovery is a prerequisite for claiming cloud-save status, not a prerequisite for editing. Sync status subscribes to the current-owner ActionQueue storage load state and retains neutral/unknown status until loaded; an empty in-memory queue during hydration does not prove there are no dead letters. Unsubscribe on component teardown and re-evaluate when the auth owner changes.

Focus pull freshness uses the snapshot's valid ISO savedAt business timestamp, not the trigger-managed row.updated_at server cursor. Missing/invalid business or supplied local baseline evidence rejects the remote candidate without clearing local state. A non-null ended_at also requires a coherent terminal snapshot (focusMode false, no active nested session, savedAt not before the end). A legacy ended-only mutation with an old active snapshot is unknown, not an empty or auto-reopened session. This safe-read guard does not provide a complete cross-device end-state reconciliation channel; preserve original bytes for inspection and export.


## Focus snapshots: unknown version evidence

Focus snapshot business time and database arrival/cursor time are distinct. Automatic pull uses explicit valid session_state.savedAt and consistent ended_at evidence; missing or contradictory evidence is not permission to replace local state. Do not manufacture savedAt from server updated_at.

The RPC status reconciliation-pending represents insufficient/conflicting logical-version evidence, not applied, unauthorized or a confirmed newer remote business snapshot. FocusConsoleSyncService returns a retryable deferred failure with reason focus-snapshot-reconciliation-pending and the original operation ID. Keep the original payload and queue entry, audit the unknown decision, and retain export/replay capability. Never add a fresh timestamp or current server CAS to an old queued payload automatically.

A future logical-clock server migration requires compatible clients first and an explicit owner-scoped reconciliation/CAS recovery flow. Parser support alone does not resolve historical conflicts or authorize a production migration. Sidebar/dashboard conflict controls must not clear retained snapshots merely to remove the failure indicator. See the production recovery ledger for candidate-versus-production evidence.


The dashboard dead-letter view consumes DeadLetterItem.action.id, failedAt and reason, not flat item IDs/timestamps/errors. Invalid dates render unknown. Retained remote Focus conflict entries have both view and method-layer retry/dismiss protection; their presence prevents clear-all, while ordinary entries retain individual actions. The complete-queue export uses downloadEscapeExport and never acknowledges or removes operations. Real-template tests cover these controls and the render-to-click race.


Sidebar controls enforce the same retained-Focus restrictions as the dashboard, including method-layer checks of the current matching action and clear-all protection. Template-only retry guards are not sufficient; compact/full dismiss controls are also disabled. Durable pending settlement must recognize the exact structured reason with retryable/deferred flags; processor logging alone is not proof of queue retention.


Durable settlement recognizes focus-snapshot-reconciliation-pending only with both boolean retryable and deferred true, after terminal business-reason precedence. It preserves the retry budget and uses the existing base deferral delay, with a distinct diagnostic reason. Real parser-to-IndexedDB restart/export tests verify retention. This does not implement long-term reconciliation backoff or legacy CAS recovery; do not activate the logical-clock SQL on this evidence alone.


The shared withTimeout helper rejects an already-aborted external signal before allocating a timer, even for an already-resolved input promise. The supplied promise was started by its caller and is still observed for rejection, preventing cancellation from introducing an unhandled rejection; this helper cannot undo side effects already started outside it. Later abort/timeout paths keep their existing listener cleanup.


## Legacy retry evidence retention and manual feedback

Quarantine preserves the first envelope and adds later same-ID operation/payload/reason evidence as flat retainedVersions instead of replacing history. Exact repeated business evidence is idempotent without rewriting timestamps, while conservative local BlackBox repair may retry. Backup validation and merge preserve incoming top-level and retained versions, enforce same owner/queue identity and detect active-queue overlap. Unknown-owner evidence is existence-only and is never claimed by the logged-in account. Manual queue checks report unresolved/pending evidence rather than interpreting void runner completion as all cloud writes succeeding. These controls do not automatically replay legacy payloads or resolve historical Focus conflicts.


### Flow 视口仅本地持久化（2026-11-27）

生产 projects schema 与现有 RPC serializer 都没有 viewState/scale/position 云端字段。流程图平移、缩放及首次 fit 的 viewport 状态是本地项目元数据：只保存 owner-scoped 本地完整快照，不标记实体 dirty、不置 pendingSync、不调度远端全项目保存。真实节点拖动仍是 task position mutation，继续原有 durable outbox/重试同步，不与 viewport 混淆。已有实体 debounce 不取消、不清 dirty，项目/owner 代际变化后旧 viewport 回调拒绝写入。视口随离线快照保留，可导出和按原项目 ID 恢复；本变更不声称新增云端视口同步，也不修复真实实体写缺 operationId 的剩余谱系问题。

## Durable project-save write plans (2026-11-28)

A project save without an existing operation ID first creates a durable owner-scoped ActionQueue project mutation. The payload includes the frozen project snapshot, the task/connection write set, delete set, and explicit task write intent. The first cloud RPC is not dispatched before that durable enqueue succeeds; an enqueue failure is reported as unsynchronized rather than remote success.

The write plan is derived from ChangeTracker evidence. Unchanged snapshot entities are excluded, while existing durable leaf operations with an owner and operation ID are not duplicated by the project plan. Replay keeps the original parent operation and derives child operations through the existing batch path. Historical project actions without a write plan remain frozen and continue fail-closed legacy review. Backup validation checks the plan shape and accepted intent values; it does not invent intent for old payloads.

Viewport fit, pan and zoom are local owner-scoped metadata only. They do not dirty tasks or schedule a project cloud save. A real task position edit remains a task mutation with its own durable identity.