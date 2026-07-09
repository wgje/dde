---
title: Service File Conventions
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/services/
  - src/app/core/services/
---

# Service File Conventions

| Service type | Location |
| --- | --- |
| application core services | `src/app/core/services/` |
| sync sub-services | `src/app/core/services/sync/` |
| business services | `src/services/` |
| route guards | `src/services/guards/` |
| feature-local services | `src/app/features/<feature>/services/` |

## Naming

- `*.service.ts` for Angular injectable services.
- `*.helpers.ts` for pure helper modules.
- `*.types.ts` for type-only modules.
- `*.spec.ts` next to tested service/helper when practical.

## Rules

- Services inject concrete stores directly.
- Do not add facade store aggregators.
- Keep sync services focused by entity or responsibility.
