---
title: UI Lifecycle Architecture
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/features/text/
  - src/app/features/flow/
  - src/app/features/focus/
  - src/app/features/parking/
---

# UI Lifecycle Architecture

UI lifecycle constraints:

- Text view is mobile default.
- Flow view lazy-loads GoJS.
- GoJS diagrams are destroyed/recreated instead of hidden alive.
- Focus/Parking snapshots remain compatible.
- Startup shell avoids eager heavy dependencies.

Read [../contracts/ui-lifecycle-contract.md](../contracts/ui-lifecycle-contract.md) before changing lifecycle behavior.
