---
title: Focus and Parking Workflow Guide
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/features/focus/
  - src/app/features/parking/
  - src/services/dock-*.ts
  - src/models/parking-dock.ts
  - src/models/focus.ts
---

# Focus and Parking Workflow Guide

Focus and Parking are execution workflows layered on top of tasks.

## Ownership

| Area | Owner paths |
| --- | --- |
| Focus UI | `src/app/features/focus/` |
| Parking UI | `src/app/features/parking/` |
| Dock state machine | `src/services/dock-engine*.ts` |
| Dock scheduling | `src/services/dock-scheduler.rules.ts` |
| Dock snapshot | `src/services/dock-snapshot-persistence.service.ts` |
| Black Box | `src/services/black-box*.ts` |

## Rules

- Preserve `CURRENT_DOCK_SNAPSHOT_VERSION` compatibility.
- Preserve Focus Gate snooze limits.
- Preserve Black Box offline capture behavior.
- Do not turn attention metadata into graph topology.
- Update model references when changing snapshot or entry fields.

## Verification

```bash
npm run docs:context7:validate
npm run test:run:services
npm run test:run:components
```
