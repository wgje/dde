---
title: Sync Architecture
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/services/sync/
  - src/config/sync.config.ts
---

# Sync Architecture

NanoFlow sync is local-first and durability-first.

```text
local stores -> IndexedDB -> cloud push -> RetryQueue/isolation
cloud pull -> mapper -> LWW merge -> stores -> IndexedDB
```

Key architecture pages:

- [../sync-offline.md](../sync-offline.md)
- [../contracts/sync-contract.md](../contracts/sync-contract.md)
- [../adr/0002-offline-first-lww-sync.md](../adr/0002-offline-first-lww-sync.md)
