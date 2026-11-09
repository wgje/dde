---
title: Core Concepts
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/models/
  - src/config/sync.config.ts
  - src/app/core/state/stores.ts
---

# Core Concepts

## Offline-First

NanoFlow writes locally before cloud confirmation. Cloud sync is background durability, not the source of immediate UI truth.

## Client IDs

New persisted entities use client-generated string IDs. Use `crypto.randomUUID()` for new entities.

## LWW

Last-Write-Wins uses:

- `updatedAt` in TypeScript
- `updated_at` in Supabase

## Soft Deletes

Soft deletes use:

- `deletedAt` in TypeScript
- `deleted_at` in Supabase

Tombstones prevent deleted entities from reappearing.

## Stores

The concrete stores are:

- `TaskStore`
- `ProjectStore`
- `ConnectionStore`

Do not add a facade store aggregator.

## Views

- Text view is the mobile default.
- Flow view is GoJS-based and lazy-loaded.
- Parking Dock and Focus Mode are execution workflows.
- Black Box is capture and review input.

## Recovery

Data protection paths include IndexedDB snapshots, localStorage fallback, RetryQueue, rejected-data isolation, import/export, and trash/archive restore.
