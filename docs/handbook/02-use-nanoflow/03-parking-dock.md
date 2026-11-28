---
title: Parking Dock 停泊坞
status: canonical
audience: user
last_verified: 2026-11-28
category: use-nanoflow
source_paths:
  - README.md
  - docs/parking-dock-modular-design.md
  - src/app/features/parking/
  - src/services/parking-meta-writer.controller.ts
  - src/app/features/parking/components/dock-daily-slot.component.ts
  - src/services/dock-engine.service.ts
  - src/services/dock-task-flow.service.ts
  - src/services/dock-entry-field.service.ts
  - src/services/dock-inline-creation.service.ts
  - src/services/dock-daily-slot.service.ts
  - src/services/focus-preference.service.ts
  - src/app/dev-preview/demo-dock-entry-preview.component.ts
---

# Parking Dock 停泊坞

Parking Dock is the quiet holding space for work that still matters but should not occupy the active task surface right now. Parking preserves the task; it is not deletion or archival.

On mobile, the collapsed trigger is deliberately low-emphasis and transparent so it does not compete with the workspace. Tap the small Dock label and count to open the usual current, actionable and standby task drawer. A task preview does not switch the current task; use the explicit confirmation in the preview when you intend to promote it. Focus remains available as a secondary text action.

The isolated development previews show the real collapsed trigger at `/#/dev-preview/dock/mobile-entry` and the open drawer at `/#/dev-preview/dock/mobile-open`. Their sample tasks are generated in memory for each visit, and fixture actions do not call workspace persistence or cloud services.
