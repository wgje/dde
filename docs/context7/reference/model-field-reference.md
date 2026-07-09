---
title: Model Field Reference
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/models/index.ts
  - src/models/core-types.ts
  - src/models/focus.ts
  - src/models/parking-dock.ts
  - src/models/parking.ts
  - src/models/supabase-types.ts
---

# Model Field Reference

This page is a field-level reference for the domain models that AI agents most often need to modify.

## Universal Persistence Rules

| Rule | Applies to |
| --- | --- |
| IDs are strings generated on the client. | projects, tasks, connections, Black Box entries, dock slots, attention items |
| New entities use `crypto.randomUUID()`. | all new persisted records |
| LWW revision uses `updatedAt` in TypeScript and `updated_at` in Supabase. | projects, tasks, connections, Black Box, preferences |
| Soft delete uses `deletedAt` in TypeScript and `deleted_at` in Supabase. | projects, tasks, connections, Black Box |
| Sync reads must include all fields needed to avoid destructive merge defaults. | task and connection reads |

## Task

Sources: `src/models/index.ts`, `src/models/core-types.ts`.

| Field | Type | Persistence | Notes |
| --- | --- | --- | --- |
| `id` | `string` | local + cloud | client-generated |
| `title` | `string` | local + cloud | short label |
| `content` | `string` | local + cloud | Markdown body; mandatory in sync reads |
| `stage` | `number | null` | local + cloud | workflow stage |
| `parentId` | `string | null` | local + cloud | tree parent |
| `order` | `number` | local + cloud | display/order field |
| `rank` | `number` | local + cloud | stable rank ordering |
| `status` | `TaskStatus` | local + cloud | `active`, `completed`, `archived` |
| `x` | `number` | local + cloud | Flow x coordinate |
| `y` | `number` | local + cloud | Flow y coordinate |
| `createdDate` | `string` | local + cloud | creation timestamp |
| `updatedAt` | `string | undefined` | local + cloud | LWW field |
| `completedAt` | `string | null | undefined` | local + cloud | stable completion timestamp |
| `displayId` | `string` | local | user-facing ID |
| `shortId` | `string | undefined` | local + cloud | compact ID |
| `hasIncompleteTask` | `boolean | undefined` | derived/local | task content helper |
| `deletedAt` | `string | null | undefined` | local + cloud | soft delete |
| `deletedConnections` | `Connection[] | undefined` | client-only | restore metadata |
| `deletedMeta` | object | client-only | restore metadata |
| `attachments` | `Attachment[] | undefined` | local + cloud | private storage metadata |
| `tags` | `string[] | undefined` | local + cloud | labels |
| `priority` | `low | medium | high | urgent` | local + cloud | task priority |
| `dueDate` | `string | null | undefined` | local + cloud | due date |
| `expected_minutes` | `number | null | undefined` | local + cloud | planning duration |
| `cognitive_load` | `high | low | null | undefined` | local + cloud | planning load |
| `wait_minutes` | `number | null | undefined` | local + cloud | wait duration |
| `parkingMeta` | `TaskParkingMeta | null | undefined` | local + cloud | Parking Dock metadata |
| `attentionMeta` | `TaskAttentionMeta | null | undefined` | local + cloud | sidecar notes |

## Task Attention

| Type | Fields |
| --- | --- |
| `TaskAttentionItem` | `id`, `text`, `level`, `done`, `createdAt`, `updatedAt` |
| `TaskAttentionLevel` | `info`, `warning`, `blocker` |
| `TaskAttentionMeta` | `items`, optional `pinned`, optional `updatedAt` |

Attention metadata is not graph topology. It must not create Flow nodes or links.

## Connection

Sources: `src/models/index.ts`, `src/models/core-types.ts`.

| Field | Type | Persistence | Notes |
| --- | --- | --- | --- |
| `id` | `string` | local + cloud | client-generated |
| `source` | `string` | local + cloud | source task ID |
| `target` | `string` | local + cloud | target task ID |
| `title` | `string | undefined` | local + cloud | label |
| `description` | `string | undefined` | local + cloud | detail |
| `deletedAt` | `string | null | undefined` | local + cloud | soft delete |
| `updatedAt` | `string | undefined` | local + cloud | LWW revision |

Connection tombstones prevent deleted links from resurrecting.

## Project

Source: `src/models/index.ts`.

| Field | Type | Persistence | Notes |
| --- | --- | --- | --- |
| `id` | `string` | local + cloud | client-generated |
| `name` | `string` | local + cloud | maps to Supabase title |
| `description` | `string` | local + cloud | project description |
| `createdDate` | `string` | local + cloud | creation timestamp |
| `tasks` | `Task[]` | local snapshot | denormalized in client |
| `connections` | `Connection[]` | local snapshot | denormalized in client |
| `updatedAt` | `string | undefined` | local + cloud | LWW revision |
| `deletedAt` | `string | null | undefined` | local + cloud | soft delete |
| `version` | `number | undefined` | local + cloud | project schema/version marker |
| `syncSource` | `local-only | synced` | local | source marker |
| `pendingSync` | `boolean | undefined` | local | unsynced marker |
| `viewState` | `ViewState | undefined` | local | Flow viewport |

## User Preferences

Source: `src/models/index.ts`.

| Field | Type | Notes |
| --- | --- | --- |
| `theme` | `default | ocean | forest | sunset | lavender` | theme hue |
| `colorMode` | `light | dark | system` | display mode |
| `layoutDirection` | `ltr | rtl` | UI direction |
| `floatingWindowPref` | `auto | fixed` | floating window behavior |
| `autoResolveConflicts` | `boolean` | LWW automation |
| `localBackupEnabled` | `boolean` | local backup switch |
| `localBackupIntervalMs` | `number` | local backup interval |
| `lastBackupProofAt` | `string` | proof-of-life timestamp |
| `focusPreferences` | `FocusPreferences` | Focus settings |
| `dockSnapshot` | `DockSnapshot` | Dock state |

## Black Box Entry

Source: `src/models/focus.ts`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | client UUID |
| `projectId` | `string | null` | project scope |
| `userId` | `string` | owner |
| `content` | `string` | captured text |
| `date` | `YYYY-MM-DD string` | grouping key |
| `createdAt` | `string` | created timestamp |
| `updatedAt` | `string` | LWW field |
| `completedAt` | `string | null | undefined` | stable completion timestamp |
| `isRead` | `boolean` | Gate state |
| `isCompleted` | `boolean` | completion state |
| `isArchived` | `boolean` | archive state |
| `snoozeUntil` | `string | undefined` | snooze date |
| `snoozeCount` | `number | undefined` | snooze count |
| `deletedAt` | `string | null` | soft delete |
| `syncStatus` | `pending | synced | conflict` | local sync marker |
| `localCreatedAt` | `string | undefined` | offline ordering |
| `originalAudioDuration` | `number | undefined` | recording metadata |
| `focusMeta` | `BlackBoxFocusMeta | null | undefined` | Focus inline creation metadata |

## Focus Session

Source: `src/models/focus.ts`.

`FocusSessionStateV2` includes:

- `schemaVersion`
- `sessionId`
- `sessionStartedAt`
- `isActive`
- `isFocusOverlayOn`
- `commandCenterOrderIds`
- `commandCenterTasks`
- `comboSelectTasks`
- `backupTasks`
- `hasFirstBatchSelected`
- `routineSlotsShownToday`
- `highLoadCounter`
- `burnoutTriggeredAt`

Use `fromLegacySessionState()` for compatibility with legacy snapshots.

## Parking Dock

Source: `src/models/parking-dock.ts`.

`DockTaskStatus` values:

- `pending_start`
- `focusing`
- `suspended_waiting`
- `wait_finished`
- `stalled`
- `completed`

`DockEntry` important fields:

- `taskId`
- `title`
- `sourceProjectId`
- `status`
- `load`
- `expectedMinutes`
- `waitMinutes`
- `waitStartedAt`
- `lane`
- `zoneSource`
- `isMain`
- `dockedOrder`
- `manualOrder`
- `detail`
- `sourceKind`
- `sourceBlackBoxEntryId`
- `inlineArchiveStatus`
- `inlineArchivedTaskId`
- `systemSelected`
- `recommendedScore`
- `sourceSection`
- `manualMainSelected`
- `recommendationLocked`
- `snoozeRingMuted`
- `relationScore`
- `relationReason`

`CURRENT_DOCK_SNAPSHOT_VERSION = 7`.

## Model Change Checklist

When adding, removing, or renaming a persisted field:

1. Update TypeScript model.
2. Update Supabase migration and generated types if cloud-persisted.
3. Update row mappers and field selectors.
4. Update import/export and backup payloads.
5. Update sync conflict logic if it participates in LWW merge.
6. Add or update tests.
7. Update this page and [../schemas/nanoflow-domain.schema.json](../schemas/nanoflow-domain.schema.json).
