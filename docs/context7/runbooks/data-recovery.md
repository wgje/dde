---
title: Data Recovery Runbook
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - src/app/core/state/store-persistence.service.ts
  - src/services/disaster-backup*.ts
  - src/services/import*.ts
  - src/services/export*.ts
  - src/services/indexeddb-health*.ts
  - src/config/sync.config.ts
---

# Data Recovery Runbook

Use this runbook when a user reports missing tasks, failed imports, corrupted local storage, rejected cloud writes, or attachment drift.

## Recovery Priority

Preserve user data before cleaning state.

Priority order:

1. stop destructive retries
2. identify current local snapshot
3. identify cloud state
4. identify exported backups or local fallback
5. isolate rejected data
6. recover into a project copy where possible
7. only then clean stale state

## Recovery Sources

| Source | Location | Use when |
| --- | --- | --- |
| IndexedDB project snapshot | browser storage | normal local recovery |
| localStorage fallback | `nanoflow.idb-fallback.<projectId>` | IndexedDB write verification failed |
| JSON export | user file | project structure recovery |
| attachment ZIP | user file | file recovery |
| rejected-data isolation | IndexedDB key from permission-denied config | RLS/auth rejected offline edits |
| Supabase cloud | projects/tasks/connections rows | remote source of truth |
| tombstones | task/connection tombstone tables | deletion reconciliation |
| disaster backup | disaster backup services | emergency recovery |

## Missing Task Triage

Ask:

- Was the task deleted, archived, or completed?
- Is it in trash or archived recovery UI?
- Was the device offline?
- Did the user switch accounts?
- Was there an import, migration, or sync conflict?
- Does cloud have a tombstone?
- Does local IndexedDB have the task?

## IndexedDB Corruption

Relevant config:

- `INDEXEDDB_HEALTH_CONFIG.CHECK_ON_INIT = true`
- `INDEXEDDB_HEALTH_CONFIG.ON_CORRUPTION = 'prompt-recovery'`

Expected behavior:

- detect corrupted records
- avoid crashing runtime with invalid cached data
- prompt or recover through cloud where possible
- preserve fallback snapshots when available

## Permission Denied Recovery

Relevant config:

- `PERMISSION_DENIED_CONFIG.ON_PERMISSION_DENIED = 'isolate-and-notify'`
- retention: 7 days
- max isolate size: 10 MB
- emergency export: enabled

If RLS rejects offline edits:

1. isolate rejected payload
2. notify user
3. offer export/copy/retry where supported
4. do not silently drop data

## Attachment Recovery

Check:

- task attachment metadata
- storage object path
- signed URL freshness
- scan metadata
- deleted attachment state
- attachment ZIP export/import availability

Do not treat missing signed URL as missing file; signed URLs expire.

## Import Recovery

Relevant services:

- `import.service.ts`
- `import-file-validation.helpers.ts`
- `import-preview.helpers.ts`
- `import-execution.helpers.ts`
- `import-backup-conversion.helpers.ts`

Checklist:

1. validate file format
2. preview imported structure
3. preserve client IDs
4. avoid destructive merge by default
5. verify task and connection counts
6. save recovered project locally before cloud push

## Recovery Verification

Minimum:

```bash
npm run docs:context7:validate
npm run test:run:services
```

If import/export changed:

```bash
npm run test:run:services -- --runInBand
```

If UI recovery changed:

```bash
npm run test:run:components
```

## Recovery Change Checklist

1. Prove no data path silently discards local user edits.
2. Prove deleted/archived state remains recoverable within retention.
3. Prove imports preserve IDs.
4. Prove cloud rejection has an isolation/export path.
5. Update [../contracts/sync-contract.md](../contracts/sync-contract.md) and [../contracts/security-contract.md](../contracts/security-contract.md) if semantics change.
