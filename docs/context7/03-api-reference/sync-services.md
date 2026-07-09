---
title: Sync Services API Reference
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/services/sync/
  - src/services/sync-coordinator*.ts
---

# Sync Services API Reference

## Service Groups

| Group | API responsibility |
| --- | --- |
| project list/detail | load project metadata and full project payloads |
| project push/save | push project rows and child entities |
| task sync | query, map, push, delete, position, stale result handling |
| connection sync | query, push, delete, tombstone handling |
| retry queue | enqueue, store, process, retry, capacity, circuit state |
| cursor | persist and advance sync watermarks |
| polling/realtime | active/idle cloud refresh |
| coordinator | application-level sync orchestration |

## Required Behaviors

- Use `supabaseErrorToError()` for Supabase errors.
- Preserve `content` in task queries.
- Use tombstones for deletes.
- Keep failed writes recoverable.
- Keep local-first UI behavior.

## Where To Look

| Need | Path |
| --- | --- |
| project freshness | `project-push.service.ts` |
| full project load | `project-detail-loader.service.ts` |
| cloud project list | `project-cloud-list.service.ts` |
| task mapper | `task-row.mapper.ts` |
| retry storage | `retry-queue-storage.service.ts` |
| retry runner | `retry-queue-runner.service.ts` |
| sync cursor | `project-sync-cursor.service.ts` |
| active project refresh | `sync-coordinator-project-refresh.service.ts` |
