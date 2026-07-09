---
title: Glossary
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - docs/context7/
  - src/models/
  - src/config/
---

# Glossary

This glossary normalizes NanoFlow terminology for AI retrieval and maintainer communication.

| Term | Meaning | Related docs |
| --- | --- | --- |
| Action Queue | Durable queue for local mutations and deferred processing. | [reference/service-catalog.md](reference/service-catalog.md) |
| Black Box | Capture inbox for unstructured thoughts, text, and speech-derived entries. | [feature-workflows.md](feature-workflows.md), [reference/model-field-reference.md](reference/model-field-reference.md) |
| Context7 corpus | Curated docs under `docs/context7` exposed to Context7. | [adr/0001-context7-canonical-corpus.md](adr/0001-context7-canonical-corpus.md) |
| Connection | Task-to-task relationship edge. | [reference/model-field-reference.md](reference/model-field-reference.md) |
| Delta Sync | Incremental sync using `updated_at` cursor semantics. | [contracts/sync-contract.md](contracts/sync-contract.md) |
| Dock Entry | Parking Dock execution record linked to a task or inline-created item. | [reference/model-field-reference.md](reference/model-field-reference.md) |
| Focus Console | Execution surface for focused work. | [feature-workflows.md](feature-workflows.md) |
| Gate | Focus Mode review step for pending Black Box entries. | [feature-workflows.md](feature-workflows.md) |
| GoJS | Graph rendering library used by Flow view. | [contracts/ui-lifecycle-contract.md](contracts/ui-lifecycle-contract.md) |
| IndexedDB snapshot | Local project data persisted for offline-first reads and recovery. | [sync-offline.md](sync-offline.md) |
| LWW | Last-Write-Wins conflict resolution using `updatedAt` / `updated_at`. | [adr/0002-offline-first-lww-sync.md](adr/0002-offline-first-lww-sync.md) |
| Parking Dock | Workflow for pausing, waiting, focusing, and resuming tasks. | [feature-workflows.md](feature-workflows.md) |
| RLS | Supabase Row Level Security for user data isolation. | [contracts/security-contract.md](contracts/security-contract.md) |
| Strata | Focus Mode history layer that resurfaces completed or older items. | [feature-workflows.md](feature-workflows.md) |
| Task Sidecar | Attention metadata on tasks, stored in `attentionMeta`. | [reference/model-field-reference.md](reference/model-field-reference.md) |
| Tombstone | Deletion marker used to prevent deleted records from resurrecting during sync. | [contracts/sync-contract.md](contracts/sync-contract.md) |

## Naming Rules

- TypeScript model fields use camelCase except persisted planning fields that intentionally mirror snake_case cloud columns.
- Supabase row fields use snake_case.
- Dock domain status uses snake_case.
- Focus UI status can use kebab-case where the existing model defines it.
