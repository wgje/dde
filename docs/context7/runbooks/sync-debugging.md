---
title: Sync Debugging Runbook
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - src/app/core/services/sync/
  - src/services/sync-coordinator*.ts
  - src/services/conflict-*.ts
  - src/config/sync.config.ts
---

# Sync Debugging Runbook

Use this runbook when NanoFlow shows stale data, missing cloud changes, repeated retry items, conflicts, or unexpected offline behavior.

## First Principles

Do not start by changing merge logic. Establish which layer is failing:

1. local store state
2. IndexedDB persistence
3. retry queue
4. Supabase auth/session
5. cloud query field selection
6. LWW timestamp comparison
7. tombstone handling
8. UI status rendering

## Fast Triage

| Symptom | Likely layer | First evidence |
| --- | --- | --- |
| UI changed but cloud did not | RetryQueue or push failure | retry queue contents, sync logs |
| Cloud changed but UI did not | pull/merge/cursor | project cursor, cloud query result |
| Task content disappeared | task field selector or mapper | `FIELD_SELECT_CONFIG`, row mapper |
| Deleted connection reappeared | tombstone handling | connection tombstone query |
| Project push rejects | remote freshness or clock uncertainty | project push conflict error |
| Repeated "Failed to fetch" | connectivity or circuit breaker | network probes, circuit breaker state |
| User loses access after offline edits | RLS permission denied path | rejected-data isolation |

## Evidence Collection

Collect:

- active user ID
- active project ID
- online/offline state
- local task count and connection count
- last project sync cursor
- pending retry queue item count
- latest Sentry breadcrumbs for `sync`
- failing Supabase error code after `supabaseErrorToError()`
- whether `content` appears in task select fields

## Local Store Check

Inspect owner stores:

- `TaskStore.getTasksByProject(projectId)`
- `ProjectStore.getProject(projectId)`
- `ConnectionStore.getConnectionsByProject(projectId)`

If local stores are correct but UI is wrong, inspect component or computed state.

If local stores are wrong but IndexedDB is correct, inspect restore/merge path.

If IndexedDB is wrong, inspect persistence and local write path.

## IndexedDB Check

Relevant service:

- `src/app/core/state/store-persistence.service.ts`

Check:

- project exists
- task count matches expected
- connection count matches expected
- data validation warnings/errors
- localStorage fallback key `nanoflow.idb-fallback.<projectId>`

## Cloud Pull Check

Relevant services:

- `project-cloud-list.service.ts`
- `project-detail-loader.service.ts`
- `project-data.service.ts`
- `task-sync-query.service.ts`
- `connection-sync-*.ts`

Check:

- expected user ID passed to Supabase client provider
- RLS result is not silently empty because of auth mismatch
- task select includes `content`
- cursor has safety lookback
- tombstones are queried and applied

## Cloud Push Check

Relevant services:

- `project-push.service.ts`
- `project-save-*.ts`
- `task-sync-push.service.ts`
- `connection-sync-*.ts`

Check:

- remote freshness query result
- local and remote `updated_at`
- conflict error type
- retry queue enqueue result
- terminal rejection state

## Conflict Check

Relevant services:

- `conflict-detection.service.ts`
- `conflict-resolution.service.ts`
- `conflict-auto-resolver.service.ts`
- `conflict-storage.service.ts`

Check:

- local timestamp
- remote timestamp
- clock sync reliability
- soft delete state
- dirty field protection window

## Required Commands

For a code change touching sync:

```bash
npm run docs:context7:validate
npm run test:run:services
```

For broader verification:

```bash
npm run test:run:verify
```

For E2E-critical paths:

```bash
npm run test:e2e
```

## Fix Pattern

1. Reproduce with a targeted test or existing failing lane.
2. Identify the failing layer.
3. Fix the owner service, not the symptom UI.
4. Add a regression test for the invariant.
5. Update [../contracts/sync-contract.md](../contracts/sync-contract.md) if the invariant changes.
