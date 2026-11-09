---
title: Service Catalog
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/state/stores.ts
  - src/app/core/services/sync/
  - src/services/
  - src/app/features/flow/
  - src/app/features/focus/
  - src/app/features/parking/
---

# Service Catalog

This catalog maps NanoFlow service responsibilities to source paths. Use it before changing behavior so implementation work lands in the owner layer instead of bypassing architecture.

## State and Persistence

| Service / module | Path | Responsibility | Must preserve |
| --- | --- | --- | --- |
| `TaskStore` | `src/app/core/state/stores.ts` | task map, project index, parked task index | flat Signals state, O(1) lookup |
| `ProjectStore` | `src/app/core/state/stores.ts` | project map and active project | `updatedAt`/`deletedAt` revision checks |
| `ConnectionStore` | `src/app/core/state/stores.ts` | connection map and project index | no direct UI ownership |
| `StorePersistenceService` | `src/app/core/state/store-persistence.service.ts` | IndexedDB project snapshots, verification, fallback | integrity check before success |
| persistence helpers | `src/app/core/state/persistence/` | backup and data integrity subroutines | recoverability |

## Sync Services

| Service / module | Path | Responsibility |
| --- | --- | --- |
| `SimpleSyncService` | `src/app/core/services/simple-sync.service.ts` | high-level sync orchestration |
| project cloud list | `src/app/core/services/sync/project-cloud-list.service.ts` | cloud project listing and metadata |
| project detail loader | `src/app/core/services/sync/project-detail-loader.service.ts` | full project load through RPC or fallback |
| project push | `src/app/core/services/sync/project-push.service.ts` | direct project upsert, freshness checks |
| project data | `src/app/core/services/sync/project-data.service.ts` | project-level cloud data API |
| task sync operations | `src/app/core/services/sync/task-sync-*.ts` | task push, query, delete, position, row mapping |
| connection sync operations | `src/app/core/services/sync/connection-sync-*.ts` | connection sync and tombstone handling |
| retry queue | `src/app/core/services/sync/retry-queue*.ts` | durable retry queue capacity, storage, runner, processing |
| tombstone service | `src/app/core/services/sync/tombstone.service.ts` | task/connection tombstone lookup and retention |
| realtime polling | `src/app/core/services/sync/realtime-polling.service.ts` | polling/realtime fallback behavior |
| sync coordinator | `src/services/sync-coordinator*.ts` | application-level sync orchestration and refresh |

## Task and Project Operations

| Service / module | Path | Responsibility |
| --- | --- | --- |
| task operation services | `src/services/task-operation*.ts` | task mutation orchestration and undo coordination |
| task creation/move/repository | `src/services/task-*.ts` | focused task operations |
| project operation | `src/services/project-operation*.ts` | project create/update/delete operations |
| change tracker | `src/services/change-tracker*.ts` | dirty state and change metadata |
| action queue | `src/services/action-queue*.ts` | queued user mutations and processors |

## Conflict and Recovery

| Service / module | Path | Responsibility |
| --- | --- | --- |
| `ConflictDetectionService` | `src/services/conflict-detection.service.ts` | detect divergent local/remote state |
| `ConflictResolutionService` | `src/services/conflict-resolution.service.ts` | user/manual conflict resolution |
| `ConflictAutoResolverService` | `src/services/conflict-auto-resolver.service.ts` | LWW auto resolution |
| `ConflictStorageService` | `src/services/conflict-storage.service.ts` | persist conflict records |
| disaster backup | `src/services/disaster-backup*.ts` | backup payloads and recovery |
| import/export | `src/services/import*.ts`, `src/services/export*.ts` | backup conversion, validation, execution |
| IndexedDB health | `src/services/indexeddb-health*.ts` | local DB record checks and recovery |

## Focus, Black Box, and Parking

| Service / module | Path | Responsibility |
| --- | --- | --- |
| Black Box sync | `src/services/black-box-sync*.ts` | Black Box local/cloud sync |
| Black Box service | `src/services/black-box.service.ts` | entry lifecycle operations |
| speech-to-text | `src/services/speech-to-text*.ts` | recording, offline replay, Edge Function transcription |
| Gate service | `src/services/gate.service.ts` | Gate review workflow |
| Focus preferences | `src/services/focus-preference.service.ts` | Focus user preferences |
| Dock engine | `src/services/dock-engine*.ts` | dock state machine and lifecycle |
| Dock scheduler | `src/services/dock-scheduler.rules.ts` | task recommendation scoring |
| Dock cloud sync | `src/services/dock-cloud-sync.service.ts` | Dock snapshot sync |
| Dock snapshot persistence | `src/services/dock-snapshot-persistence.service.ts` | dock snapshot storage |
| Parking feature | `src/app/features/parking/` | Parking Dock UI |
| Focus feature | `src/app/features/focus/` | Focus UI and Gate components |

## Flow Services

| Service / module | Path | Responsibility |
| --- | --- | --- |
| Flow diagram service | `src/app/features/flow/services/flow-diagram.service.ts` | GoJS diagram orchestration |
| Flow data service | `src/app/features/flow/services/flow-diagram-data.service.ts` | diagram data composition |
| Flow layout service | `src/app/features/flow/services/flow-layout.service.ts` | layout calculation |
| Flow template service | `src/app/features/flow/services/flow-template.service.ts` | GoJS templates |
| Flow events | `src/app/features/flow/services/flow-template-events.ts`, `flow-event.service.ts` | event boundary |
| Flow overview/minimap | `src/app/features/flow/services/flow-overview*.ts`, `flow-minimap.component.ts` | overview UI |
| Flow touch/drag/link | `src/app/features/flow/services/flow-*-service.ts` | interaction tools |

## Platform and Shell

| Service / module | Path | Responsibility |
| --- | --- | --- |
| auth | `src/services/auth*.ts`, `src/app/core/services/app-auth-coordinator.service.ts` | Supabase auth and app auth coordination |
| shell | `src/app/core/shell/` | app shell composition, project shell |
| modal loader | `src/app/core/services/modal-loader.service.ts` | lazy modal loading |
| logger | `src/services/logger.service.ts` | categorized logs |
| Sentry lazy loader | `src/services/sentry-lazy-loader.service.ts` | lazy monitoring |
| global error handler | `src/services/global-error-handler.service.ts` | severity handling |

## Placement Rules

- UI components should call services, not Supabase directly.
- Sync services should use mappers and centralized error conversion.
- Rendering services should not own persistence semantics.
- New feature state should prefer existing stores or focused services; do not add a global facade store.
- Cross-cutting behavior must be documented in [../contracts/sync-contract.md](../contracts/sync-contract.md), [../contracts/security-contract.md](../contracts/security-contract.md), or [../contracts/ui-lifecycle-contract.md](../contracts/ui-lifecycle-contract.md).
