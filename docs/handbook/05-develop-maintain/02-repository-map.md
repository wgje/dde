---
title: Repository Map
status: canonical
audience: contributor, maintainer, ai-agent
last_verified: 2026-06-11
category: develop-maintain
source_paths:
  - README.md
  - AGENTS.md
  - src/
  - src/services/
  - supabase/
  - docs/context7/source-map.md
---

# Repository Map

Use this page to find the right ownership boundary before changing NanoFlow.

## In This Article

- [Top-level areas](#top-level-areas)
- [Frontend source](#frontend-source)
- [Business services](#business-services)
- [Supabase source](#supabase-source)
- [Documentation source](#documentation-source)
- [Next steps](#next-steps)

## Top-Level Areas

| Path | Purpose |
| --- | --- |
| `src/app/core` | core shell, state, sync, persistence, app-level services |
| `src/app/features/text` | text task view |
| `src/app/features/flow` | GoJS Flow view and diagram services |
| `src/app/features/focus` | Focus, Gate, Black Box, Strata UI |
| `src/app/features/parking` | Parking Dock UI |
| `src/app/shared` | shared components, modals, pipes, UI utilities |
| `src/services` | business service layer |
| `src/models` | domain model types |
| `src/config` | configuration constants |
| `src/utils` | low-level utilities |
| `supabase/functions` | Edge Functions |
| `supabase/migrations` | database migrations |
| `docs/handbook` | human-readable docs |
| `docs/context7` | machine-readable docs |

## Frontend Source

Angular code uses standalone components, signals, and OnPush expectations. Prefer existing feature boundaries over new cross-cutting abstractions.

When changing UI:

1. identify the feature directory;
2. inspect adjacent service and test files;
3. preserve mobile behavior;
4. keep Flow lazy-loaded and disposable.

## Business Services

Services in `src/services` and `src/app/core/services` coordinate task operations, sync, auth, persistence, and app lifecycle.

Use direct dependencies on concrete stores and services. Do not add a new facade Store that aggregates `TaskStore`, `ProjectStore`, and `ConnectionStore`.

## Supabase Source

Use `supabase/migrations` for schema and policy changes. Use `supabase/functions` for server-only behavior. After schema changes, regenerate database types and update documentation.

## Documentation Source

Use:

- `docs/handbook` for human reading;
- `docs/context7` for AI retrieval and source contracts;
- `docs/superpowers/plans` for agent implementation plans;
- `docs/archive` for historical material.

## Next Steps

- Choose a gate in [Testing and Quality](03-testing-and-quality.md).
- Keep docs synchronized with [Documentation Maintenance](04-documentation-maintenance.md).
