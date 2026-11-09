---
title: Project Structure
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/
  - supabase/
  - scripts/
  - e2e/
  - docs/context7/source-map.md
---

# Project Structure

NanoFlow is organized by ownership boundaries rather than by generic technical labels only.

## Top-Level Layout

| Path | Purpose |
| --- | --- |
| `src/app/core/` | core app state, sync, shell, external sources |
| `src/app/features/text/` | mobile-first Text view |
| `src/app/features/flow/` | GoJS Flow view |
| `src/app/features/focus/` | Focus Mode UI |
| `src/app/features/parking/` | Parking Dock UI |
| `src/services/` | business services and orchestration |
| `src/config/` | constants, feature flags, timeouts |
| `src/models/` | TypeScript domain models |
| `supabase/functions/` | Edge Functions |
| `supabase/migrations/` | database migrations |
| `scripts/` | build, validation, testing, deployment helpers |
| `e2e/` | Playwright tests |
| `docs/context7/` | canonical machine-readable docs |

## Where To Start

| Task | Start with |
| --- | --- |
| Change sync | `src/app/core/services/sync/` and [../contracts/sync-contract.md](../contracts/sync-contract.md) |
| Change model fields | `src/models/` and [../reference/model-field-reference.md](../reference/model-field-reference.md) |
| Change Flow | `src/app/features/flow/` and [../contracts/ui-lifecycle-contract.md](../contracts/ui-lifecycle-contract.md) |
| Change Focus/Parking | `src/app/features/focus/`, `src/app/features/parking/`, `src/services/dock-*.ts` |
| Change Supabase schema | `supabase/migrations/` and [../reference/supabase-schema-reference.md](../reference/supabase-schema-reference.md) |
| Change docs | `docs/context7/` and [../documentation-contribution.md](../documentation-contribution.md) |
