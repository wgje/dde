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
