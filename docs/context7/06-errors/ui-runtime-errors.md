---
title: UI Runtime Errors
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/features/flow/
  - src/app/features/focus/
  - src/app/features/parking/
  - src/app/core/shell/
---

# UI Runtime Errors

| Symptom | Likely cause | Fix route |
| --- | --- | --- |
| mobile opens heavy Flow by default | mobile default violated | inspect shell/view selection |
| Flow memory grows after switching views | GoJS diagram not disposed | inspect Flow lifecycle |
| Flow labels overlap after layout | layout constants or link label staggering | inspect Flow layout services |
| Focus snapshot fails to restore | snapshot version or migration issue | inspect Dock/Focus snapshot |
| Dock state disappears | persistence or cloud snapshot issue | inspect Dock snapshot persistence |

Read [../contracts/ui-lifecycle-contract.md](../contracts/ui-lifecycle-contract.md).
