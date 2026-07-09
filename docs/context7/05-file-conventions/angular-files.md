---
title: Angular File Conventions
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/features/
  - src/app/core/
  - src/app/shared/
---

# Angular File Conventions

| Convention | Rule |
| --- | --- |
| Components | standalone components, OnPush change detection |
| Templates | external templates allowed when component grows |
| Styles | component CSS next to component when extracted |
| Inputs/outputs | prefer Angular 19 function APIs for new code |
| Feature code | under `src/app/features/<feature>/` |
| Core shell/state | under `src/app/core/` |
| Shared UI | under `src/app/shared/` |

## Placement

- Text view code belongs in `src/app/features/text/`.
- Flow view code belongs in `src/app/features/flow/`.
- Focus UI belongs in `src/app/features/focus/`.
- Parking UI belongs in `src/app/features/parking/`.

Do not place domain sync logic in component files.
