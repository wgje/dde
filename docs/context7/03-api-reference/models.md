---
title: Models API Reference
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/models/index.ts
  - src/models/core-types.ts
  - src/models/focus.ts
  - src/models/parking-dock.ts
---

# Models API Reference

Use [../reference/model-field-reference.md](../reference/model-field-reference.md) for field tables. This page names the main exported model API surface.

## Core Models

- `Task`
- `Project`
- `Connection`
- `Attachment`
- `UserPreferences`
- `SyncState`
- `UndoAction`

## Focus Models

- `BlackBoxEntry`
- `FocusPreferences`
- `StrataItem`
- `StrataLayer`
- `OfflineAudioCacheEntry`
- `FocusSessionStateV2`
- `RoutineTask`
- `FocusSessionRecord`

## Parking Dock Models

- `DockTaskStatus`
- `DockEntry`
- `DockSnapshot`
- `DockSessionState`
- `FocusTaskSlot`
- `RecommendationGroup`
- `DockPendingDecision`
- `StatusMachineEntry`

## Model API Rules

- Persisted model changes require mapper and sync selector updates.
- Snapshot model changes require compatibility logic.
- Cloud model changes require migrations and RLS review.
