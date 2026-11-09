---
title: Sync Workflow Guide
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/services/sync/
  - src/services/sync-coordinator*.ts
  - src/config/sync.config.ts
---

# Sync Workflow Guide

Use this guide when adding or changing sync behavior.

## Workflow

1. Identify affected invariant in [../contracts/sync-contract.md](../contracts/sync-contract.md).
2. Locate owner service in [../reference/service-catalog.md](../reference/service-catalog.md).
3. Check required fields in [../reference/model-field-reference.md](../reference/model-field-reference.md).
4. Check config in [../reference/configuration-reference.md](../reference/configuration-reference.md).
5. Add tests.
6. Update docs.
7. Run validation.

## Common Changes

| Change | Must inspect |
| --- | --- |
| new task field | field selectors, mapper, import/export, model reference |
| retry behavior | RetryQueue services and sync contract |
| project refresh | project detail loader, cloud list, cursor service |
| tombstone behavior | tombstone service and deletion tests |
| conflict behavior | conflict services and LWW docs |

## Verification

```bash
npm run docs:context7:validate
npm run test:run:services
```
