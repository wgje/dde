---
title: NanoFlow Data Model
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/models/index.ts
  - src/models/core-types.ts
  - src/models/focus.ts
  - src/models/parking-dock.ts
  - src/config/sync.config.ts
---

# NanoFlow Data Model

NanoFlow uses client-generated string IDs and Last-Write-Wins timestamps across persisted entities. This page summarizes the fields AI agents most often need when reading or changing code.

## ID and Revision Rules

- New persisted entities use `crypto.randomUUID()`.
- IDs are stable across local storage, cloud sync, import/export, undo, and retry queues.
- Do not create temporary IDs that later require server-side mapping.
- `updatedAt` in TypeScript models and `updated_at` in Supabase rows are the LWW revision fields.
- `deletedAt` / `deleted_at` represent soft deletes and tombstones.

## Task

Canonical TypeScript source: `src/models/core-types.ts`.

Core fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | client-generated task ID |
| `title` | `string` | short task title |
| `content` | `string` | Markdown task body; sync queries must include it |
| `stage` | `number | null` | workflow stage |
| `parentId` | `string | null` | tree parent |
| `order` | `number` | local ordering |
| `rank` | `number` | rank ordering |
| `status` | `'active' | 'completed' | 'archived'` | task lifecycle |
| `x`, `y` | `number` | Flow view position |
| `createdDate` | `string` | creation timestamp |
| `updatedAt` | `string | undefined` | LWW revision |
| `completedAt` | `string | null | undefined` | stable completion timestamp |
| `deletedAt` | `string | null | undefined` | soft delete timestamp |
| `attachments` | `Attachment[] | undefined` | attachment metadata |
| `tags` | `string[] | undefined` | labels |
| `priority` | `'low' | 'medium' | 'high' | 'urgent' | undefined` | priority |
| `dueDate` | `string | null | undefined` | due date |
| `parkingMeta` | `TaskParkingMeta | null | undefined` | Parking Dock metadata |
| `attentionMeta` | `TaskAttentionMeta | null | undefined` | task sidecar notes |

Planning fields:

| Field | Type |
| --- | --- |
| `expected_minutes` | `number | null | undefined` |
| `cognitive_load` | `'high' | 'low' | null | undefined` |
| `wait_minutes` | `number | null | undefined` |

## Connection

Canonical TypeScript source: `src/models/core-types.ts`.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | client-generated connection ID |
| `source` | `string` | source task ID |
| `target` | `string` | target task ID |
| `title` | `string | undefined` | label |
| `description` | `string | undefined` | detail |
| `deletedAt` | `string | null | undefined` | soft delete timestamp |
| `updatedAt` | `string | undefined` | LWW revision |

## Project

Project fields are mapped from Supabase `projects` rows and stored in `ProjectStore`.

Important fields:

- `id`
- `name` / `title`
- `description`
- `createdDate` / `created_date`
- `updatedAt` / `updated_at`
- `version`
- `deletedAt` / `deleted_at`
- `tasks`
- `connections`

`Project.updatedAt` participates in synchronization and conflict handling.

## Attachment

Canonical TypeScript source: `src/models/core-types.ts`.

| Field | Type |
| --- | --- |
| `id` | `string` |
| `type` | `'image' | 'document' | 'link' | 'file'` |
| `name` | `string` |
| `url` | `string` |
| `thumbnailUrl` | `string | undefined` |
| `mimeType` | `string | undefined` |
| `size` | `number | undefined` |
| `createdAt` | `string` |
| `signedAt` | `string | undefined` |
| `scanMetadata` | `AttachmentScanMetadata | undefined` |
| `deletedAt` | `string | undefined` |

Attachments use a private Supabase Storage bucket named `attachments`.

## Black Box

Canonical TypeScript source: `src/models/focus.ts`.

`BlackBoxEntry` captures unstructured text or speech-derived thoughts.

Important fields:

- `id`: client UUID
- `projectId`: project or `null`
- `userId`: owner
- `content`: captured text
- `date`: `YYYY-MM-DD`
- `createdAt`
- `updatedAt`: LWW revision
- `completedAt`
- `isRead`
- `isCompleted`
- `isArchived`
- `snoozeUntil`
- `snoozeCount`
- `deletedAt`
- `syncStatus`: `'pending' | 'synced' | 'conflict'`
- `localCreatedAt`
- `originalAudioDuration`
- `focusMeta`

## Focus Preferences

Canonical TypeScript source: `src/models/focus.ts`.

Defaults come from `FOCUS_CONFIG`.

| Field | Default / Meaning |
| --- | --- |
| `gateEnabled` | `true` |
| `strataEnabled` | `true` |
| `blackBoxEnabled` | `true` |
| `maxSnoozePerDay` | `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY` = `3` |
| `routineResetHourLocal` | `0` |
| `restReminderHighLoadMinutes` | derived from Parking config, 90 minutes |
| `restReminderLowLoadMinutes` | derived from Parking config, 30 minutes |
| `updatedAt` | LWW preference revision |

## Parking Dock

Canonical TypeScript source: `src/models/parking-dock.ts`.

`DockTaskStatus` values:

- `pending_start`
- `focusing`
- `suspended_waiting`
- `wait_finished`
- `stalled`
- `completed`

`DockEntry` key fields:

- `taskId`
- `title`
- `sourceProjectId`
- `status`
- `load`: `'high' | 'low'`
- `expectedMinutes`
- `waitMinutes`
- `waitStartedAt`
- `lane`: `'combo-select' | 'backup'`
- `zoneSource`: `'auto' | 'manual'`
- `isMain`
- `dockedOrder`
- `manualOrder`
- `sourceKind`: `'project-task' | 'dock-created'`
- `systemSelected`
- `recommendedScore`
- `relationScore`
- `relationReason`

`CURRENT_DOCK_SNAPSHOT_VERSION` is `7`.

## Sync Field Selection

Canonical source: `src/config/sync.config.ts`.

Task cloud queries must include:

- `content`
- `attachments`
- `parking_meta`
- `attention_meta`
- `updated_at`
- `deleted_at`
- planning fields: `expected_minutes`, `cognitive_load`, `wait_minutes`

Dropping `content` from task sync fields is a known data-loss class.
