---
title: Sync Errors
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - src/app/core/services/sync/
  - src/services/conflict-*.ts
  - src/config/sync.config.ts
---

# Sync Errors

| Symptom | Likely cause | Fix route |
| --- | --- | --- |
| task content missing | `content` omitted from selector or mapper defaulted empty | check `FIELD_SELECT_CONFIG` and mapper |
| deleted connection reappears | tombstone not loaded/applied | check tombstone service |
| push conflict | remote newer or tombstone exists | inspect project/task freshness |
| repeated retry items | remote failure or terminal rejection missing | inspect RetryQueue runner/storage |
| empty cloud project list | auth mismatch or RLS denial | inspect Supabase user and policies |
| clock conflict | local/remote timestamp uncertain | inspect clock sync and conflict handling |

Runbook: [../runbooks/sync-debugging.md](../runbooks/sync-debugging.md).
