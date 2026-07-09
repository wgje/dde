---
title: ADR 0002 - Offline-First LWW Sync
status: accepted
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/config/sync.config.ts
  - src/app/core/services/sync/
  - src/app/core/state/store-persistence.service.ts
  - src/services/conflict-*.ts
---

# ADR 0002 - Offline-First LWW Sync

## Status

Accepted.

## Context

NanoFlow is a personal workflow app where fast local capture matters more than strict immediate cloud consistency. Users must be able to create and edit tasks offline, then sync later across devices.

The app also has graph relationships, attachments, parking metadata, Focus state, and Black Box entries. These features make destructive merge behavior unacceptable.

## Decision

NanoFlow uses an offline-first sync model with Last-Write-Wins conflict handling:

```text
local write -> immediate UI update -> local persistence -> debounced cloud push -> retry/isolation on failure
```

LWW uses:

- `updatedAt` in TypeScript models
- `updated_at` in Supabase rows

Soft deletes use:

- `deletedAt` in TypeScript models
- `deleted_at` in Supabase rows

Tombstones prevent deleted tasks and connections from resurrecting.

## Consequences

Positive:

- UI stays responsive offline.
- Captures and edits do not block on cloud availability.
- Retry queues preserve writes through transient failures.
- Timestamp-based resolution is simple enough for personal multi-device sync.

Risks:

- Clock drift can make timestamp comparison unsafe.
- Missing fields in sync reads can cause destructive defaults.
- Tombstone bugs can resurrect deleted data.
- RLS denial after offline edits requires explicit recovery.

Mitigations:

- clock sync reliability checks
- field selector contracts
- tombstone retention
- rejected-data isolation
- IndexedDB verification and fallback
- sync contract tests

## Alternatives Considered

### Server-authoritative synchronous writes

Rejected because it breaks offline-first UX and makes capture dependent on network.

### CRDT for all entities

Rejected for current scope because NanoFlow is single-user and LWW is sufficient when recoverability is strong.

### Full overwrite sync

Rejected because it risks data loss across devices and offline sessions.

## Verification

Run affected service tests and:

```bash
npm run docs:context7:validate
```

For broad sync changes:

```bash
npm run test:run:services
```
