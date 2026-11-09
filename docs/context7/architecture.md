---
title: NanoFlow Architecture
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/state/stores.ts
  - src/app/core/state/store-persistence.service.ts
  - src/app/core/services/sync/
  - src/services/
  - src/app/features/
---

# NanoFlow Architecture

NanoFlow is an Angular 19 standalone-component application using Angular Signals for state, IndexedDB for local persistence, Supabase for cloud services, and GoJS for graph rendering.

Production builds use AOT explicitly. Standalone signal inputs are declared with `input()` and should not be layered with the legacy `@Input` decorator; this keeps lazy-loaded components free of runtime decorator metadata.

## Stack Baseline

| Layer | Technology |
| --- | --- |
| Frontend | Angular 19.2, standalone components, OnPush change detection |
| State | Angular Signals, `signal()`, `computed()`, `effect()` |
| Local persistence | IndexedDB, `idb-keyval`, localStorage fallback for emergency paths |
| Cloud backend | Supabase Auth, PostgreSQL, Storage, Edge Functions |
| Graph rendering | GoJS 3.1 |
| Error monitoring | Sentry 10, lazy-loaded |
| Tests | Vitest 4, Playwright 1.48 |
| Language | TypeScript 5.8 strict mode |

## State Stores

The canonical stores live in `src/app/core/state/stores.ts`.

| Store | Responsibility |
| --- | --- |
| `TaskStore` | `tasksMap`, task lookup, project task index, parked task index |
| `ProjectStore` | `projectsMap`, active project ID, active project |
| `ConnectionStore` | `connectionsMap`, project connection index |

Store rules:

- Store structure is flat.
- Use `Map` and `Set` for O(1) lookup where appropriate.
- Signals can use `{ equal: () => false }` for mutable Map/Set updates.
- Do not add a facade store or aggregate store.
- Services inject concrete stores directly.
- Revision equality is based on `updatedAt` plus `deletedAt`.

## Core Service Areas

| Area | Key paths | Responsibility |
| --- | --- | --- |
| Sync | `src/app/core/services/sync/`, `src/services/sync-coordinator-project-refresh.service.ts` | cloud load, push, retry queues, tombstones, polling, project refresh |
| Persistence | `src/app/core/state/store-persistence.service.ts` | IndexedDB project snapshots, integrity verification, fallback backup |
| Task operations | `src/services/task-operation*.ts`, `src/services/task-*` | create, update, move, delete, undo/redo |
| Focus and Black Box | `src/services/black-box*.ts`, `src/app/features/focus/` | capture, Gate, Strata, Focus preferences, offline audio cache |
| Parking Dock | `src/services/dock-*.ts`, `src/app/features/parking/` | dock entries, scheduling, focus console, reminders |
| Flow | `src/app/features/flow/` | GoJS templates, layout, events, diagram lifecycle |
| Observability | `src/services/sentry-lazy-loader.service.ts`, `src/services/logger.service.ts` | lazy Sentry capture, categorized logging |

## Rendering Model

Angular components should be standalone and use `ChangeDetectionStrategy.OnPush`. Angular 19 function APIs such as `input()`, `output()`, and `viewChild()` are preferred for new code.

Mobile behavior is a hard architectural boundary:

- Text view is the default mobile view.
- Flow view must be loaded on demand.
- GoJS diagrams must be destroyed and recreated across view transitions.
- A hidden live diagram under `visibility:hidden` is not allowed.

## Flow Graph Architecture

GoJS rendering is isolated in the Flow feature. The event path is:

```text
FlowTemplateService -> flow-template-events.ts -> FlowEventService
```

Flow view must not mutate sync or persistence behavior directly. It should emit domain-level events that services handle.

Tree traversal must be iterative and capped by `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH = 100`.

## Persistence Architecture

Local persistence stores per-project snapshots:

```text
ProjectStore / TaskStore / ConnectionStore
  -> StorePersistenceService
  -> IndexedDB projects/tasks/connections/meta stores
```

`StorePersistenceService` verifies written task and connection counts after IndexedDB writes. If IndexedDB write verification fails, it retries once and can fall back to a localStorage emergency backup.

## Cloud Architecture

Supabase provides:

- Auth and user identity
- PostgreSQL tables with RLS
- private Storage bucket named `attachments`
- Edge Functions for transcription, widget APIs, cleanup, virus scan, backup alerts

Cloud data access should use typed mappers and centralized error conversion through `supabaseErrorToError()`.

## Dependency Rules

- Services may inject concrete stores and focused sub-services.
- Do not create new global state libraries.
- Do not introduce reverse imports from `services/` into forbidden app layers.
- Keep sync, persistence, UI rendering, and feature workflow responsibilities separate.
- Reuse existing config constants instead of duplicating timing, quota, or threshold values.
