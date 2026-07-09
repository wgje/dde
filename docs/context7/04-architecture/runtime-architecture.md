---
title: Runtime Architecture
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/
  - src/services/
  - src/app/features/
---

# Runtime Architecture

NanoFlow runtime is layered:

```text
Angular shell
  -> feature components
  -> business services
  -> concrete Signal stores
  -> local persistence and cloud sync
```

## Boundaries

- Components do not own sync semantics.
- Services coordinate domain changes.
- Stores hold concrete state.
- Persistence and sync are separate owner layers.
- Heavy services are lazy or idle-loaded where startup performance matters.

See [../architecture.md](../architecture.md) for the full architecture guide.
