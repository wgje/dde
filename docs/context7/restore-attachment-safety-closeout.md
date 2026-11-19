---
title: Restore and Attachment Safety Closeout
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-11-18
source_paths:
  - src/app/core/services/sync/retry-queue-unknown-outcome-fence.controller.ts
  - src/app/core/services/sync/retry-queue-pending-unknown-outcome-fence.ts
  - src/services/local-backup-ui-restore-*.ts
  - src/services/attachment-storage-path.helpers.ts
  - src/services/attachment-import.service.ts
  - src/services/task-operation-adapter.service.ts
---

# Restore and Attachment Safety Closeout

## RetryQueue unknown outcome fences

A pending unknown-outcome fence is durable diagnostic state. It is owner-scoped and includes queue identity, entity identity, source owner, operation, and `operationId`. Malformed records or identity mismatches fail closed and perform zero cleanup writes.

Fence cleanup is confirmed before pressure is cleared. If local or session storage removal fails, `storage_unknown_outcome` pressure and the diagnostic fence remain. The same rule applies during normal state persistence, restore-after-load, storage-pressure recovery, and processed-fence cleanup. A later retry may clear the fence only after a successful read-back.

## Local backup UI restore

The UI restore path is coordinated by `LocalBackupUiRestoreJournal` and its transaction/stage protocol. The fixed stage order is projects, attachment outbox, ActionQueue, RetryQueue, dead letters, conflicts, and metadata. Each stage captures a pre-image, checkpoints progress, applies writes, and performs a read-back. Rollback uses the current stage plus completed stages in reverse order. Rollback failure retains the marker, journal, and diagnostics and blocks finalization or cleanup.

Startup recovery accepts only owner, run, source, queue, marker, and quiescence evidence that agree and whose lease is expired. Mismatched or active evidence produces a blocked result with zero data writes. Entity IDs and `operationId` values remain unchanged; cursors and tombstones remain monotonic.

Settings restore and session startup already route through the journal transaction and writer-quiescence/ActionQueue fences. Published C258 keeps the dynamic settings inputs compatible with `ComponentRef.setInput`; when `BackupData.localState.dataSafety.offlineCommandStore` is present, the UI opts into owner-scoped capture and the B248 transaction/pre-image/stage path performs owner/read-back validation. This describes local behavior and focused tests; it is not production proof. Focused settings, startup, transaction, quiescence, and user-session coverage must remain green before release.

## Attachment identity and owner fences

`buildAttachmentStoragePath` rejects unsafe owner, project, task, attachment, and extension segments before constructing a storage path. This is client-side path safety; it does not prove server authenticity or encryption.

Attachment import captures an immutable owner/session fence and passes it into the task-operation adapter. The adapter revalidates that fence before writer entry, queue enqueue, state mutation, and after awaited state work. A failed fence must produce no queue or ProjectState write. `operationId` and retained receipts remain stable across replay.

## Verification boundary

These rules describe local code and focused tests. They are not production migration, Supabase schema, Edge deployment, Cloudflare deployment, or server authenticity proof. Production gates require their own receipts and owner authorization.
