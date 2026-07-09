---
title: Source Map
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-11
source_paths:
  - src/
  - supabase/
  - scripts/
  - docs/context7/
---

# Source Map

This page routes common implementation questions to the canonical documentation page and the most relevant source paths.

## Retrieval Routing

| Question | Read this doc first | Then inspect these paths |
| --- | --- | --- |
| What is NanoFlow? | [overview.md](overview.md) | `README.md` |
| How is application state stored? | [architecture.md](architecture.md) | `src/app/core/state/stores.ts` |
| How are projects persisted locally? | [sync-offline.md](sync-offline.md) | `src/app/core/state/store-persistence.service.ts` |
| How does Supabase sync work? | [sync-offline.md](sync-offline.md) | `src/app/core/services/sync/`, `src/services/sync-coordinator-project-refresh.service.ts` |
| How are task rows mapped? | [data-model.md](data-model.md) | `src/app/core/services/sync/task-row.mapper.ts`, `src/models/core-types.ts` |
| Which fields must task sync include? | [data-model.md](data-model.md), [sync-offline.md](sync-offline.md) | `src/config/sync.config.ts` |
| How do task operations work? | [architecture.md](architecture.md) | `src/services/task-operation*.ts`, `src/services/task-*.ts` |
| How does Flow view render? | [feature-workflows.md](feature-workflows.md) | `src/app/features/flow/`, `src/config/layout.config.ts` |
| How is GoJS lifecycle constrained? | [agent-rules.md](agent-rules.md) | `src/app/features/flow/components/flow-view.component.ts`, `src/app/features/flow/services/` |
| How does Parking Dock work? | [feature-workflows.md](feature-workflows.md), [data-model.md](data-model.md) | `src/models/parking-dock.ts`, `src/services/dock-*.ts`, `src/app/features/parking/` |
| How does Focus Mode work? | [feature-workflows.md](feature-workflows.md), [data-model.md](data-model.md) | `src/models/focus.ts`, `src/app/features/focus/`, `src/services/gate.service.ts`, `src/services/black-box*.ts` |
| How does speech transcription work? | [api-edge-functions.md](api-edge-functions.md) | `src/services/speech-to-text*.ts`, `supabase/functions/transcribe/`, `src/config/focus.config.ts` |
| How does the Android widget work? | [feature-workflows.md](feature-workflows.md), [api-edge-functions.md](api-edge-functions.md) | `android/`, `supabase/functions/widget-*`, `docs/android-widget-host-scaffold.md` |
| How are errors reported? | [api-edge-functions.md](api-edge-functions.md), [operations-security.md](operations-security.md) | `src/services/global-error-handler.service.ts`, `src/services/sentry-lazy-loader.service.ts`, `src/services/logger.service.ts` |
| How should an AI agent modify the repo? | [agent-rules.md](agent-rules.md) | `AGENTS.md`, `.github/instructions/*.instructions.md` |
| How are docs kept Context7-ready? | [context7-maintenance.md](context7-maintenance.md) | `context7.json`, `llms.txt`, `scripts/validate-context7-docs.cjs`, `scripts/contracts/check-context7-coupled-changes.cjs`, `.github/workflows/context7-refresh.yml` |

## Source Ownership Boundaries

| Boundary | Primary owner paths | Do not bypass |
| --- | --- | --- |
| State stores | `src/app/core/state/stores.ts` | No facade store aggregation |
| Local persistence | `src/app/core/state/store-persistence.service.ts`, `src/app/core/state/persistence/` | Do not write unrelated caches as the source of truth |
| Cloud sync | `src/app/core/services/sync/`, `src/services/sync-coordinator*.ts` | Do not perform ad hoc Supabase writes from UI components |
| Task operations | `src/services/task-*`, `src/services/*operation*.ts` | Do not mutate task graphs directly from rendering code |
| Flow rendering | `src/app/features/flow/` | Do not mix GoJS lifecycle with sync ownership |
| Text workflow | `src/app/features/text/` | Preserve mobile-first behavior |
| Focus workflow | `src/app/features/focus/`, `src/services/gate.service.ts`, `src/services/black-box*.ts` | Preserve quota, Gate, Strata, and offline capture behavior |
| Parking Dock | `src/app/features/parking/`, `src/services/dock-*.ts`, `src/models/parking-dock.ts` | Preserve dock snapshot compatibility |
| Supabase functions | `supabase/functions/` | Keep secrets server-side |
| Validation scripts | `scripts/` | Prefer adding focused validators over broad manual checks |

## High-Risk Change Areas

Use broader verification for these paths:

- `src/config/sync.config.ts`
- `src/app/core/services/sync/`
- `src/app/core/state/store-persistence.service.ts`
- `src/models/core-types.ts`
- `src/models/focus.ts`
- `src/models/parking-dock.ts`
- `supabase/migrations/`
- `supabase/functions/`
- `src/app/features/flow/`
- `src/app/features/parking/`
- `src/app/features/focus/`

High-risk changes usually require targeted tests plus one wider verification lane from [development.md](development.md).
