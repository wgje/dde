---
title: Feature Workflows
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/features/text/
  - src/app/features/flow/
  - src/app/features/focus/
  - src/app/features/parking/
  - src/services/dock-*.ts
  - src/services/black-box*.ts
---

# Feature Workflows

This page summarizes the major user-facing workflows and the architecture boundaries that protect them.

## Text View

Text view is the default daily workflow and the default mobile surface.

Use it for:

- fast task creation and editing
- hierarchical organization
- filtering and search
- Markdown content editing
- mobile-first task management

Architectural expectations:

- Text operations go through task services and stores.
- Edits persist locally first.
- UI should not wait for cloud sync before reflecting user input.

## Flow View

Flow view uses GoJS to visualize task structure and relationships.

Use it for:

- graph inspection
- spatial task organization
- relationship lines and labels
- PNG, SVG, or Markdown context export

Rules:

- Flow view is not the mobile default.
- Flow should be lazy-loaded.
- Do not keep GoJS diagram instances alive under `visibility:hidden`.
- Destroy and recreate diagrams when view lifecycle requires it.
- Flow events are decoupled through `FlowTemplateService -> flow-template-events.ts -> FlowEventService`.

## Parking Dock

Parking Dock is for tasks that should be paused without being lost.

Key concepts:

- parked tasks are still tasks
- parking metadata lives on tasks through `parkingMeta`
- dock entries can point to project tasks or dock-created inline tasks
- wait timers, reminders, main-task state, and focus transitions are part of dock state

Important status values:

- `pending_start`
- `focusing`
- `suspended_waiting`
- `wait_finished`
- `stalled`
- `completed`

User-facing dock behavior:

1. Park a task from Text or Flow.
2. Optionally set reminder, wait, load, or expected time.
3. Let Dock or Focus Console promote work when appropriate.
4. Complete, suspend, resume, or return task context.

## Focus Mode

Focus Mode is a higher-level execution workflow. It includes:

- Gate: review pending Black Box entries
- Strata: resurface completed or historical items
- Focus Console: execute docked or selected tasks
- fragment phase: small interlude tasks and breaks

Core limits:

- `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY = 3`
- speech transcription quota is 50 per day
- Strata displays up to 30 days

Focus session state uses versioned snapshots. `FocusSessionStateV2` includes command center tasks, combo-select tasks, backup tasks, routine slots, high-load counters, and burnout state.

## Black Box

Black Box is for quick capture before organization.

Text capture:

- offline capable
- creates `BlackBoxEntry`
- processed later through Gate or Focus flows

Speech capture:

- records audio locally
- caches offline audio when needed
- sends audio to Supabase Edge Function `transcribe`
- uses Groq `whisper-large-v3`
- deletes or stops retaining audio after transcription workflow as implemented by capture services

## Task Sidecar / Attention Metadata

Task sidecar information is stored in `attentionMeta`.

It is an attention summary layer, not a graph topology layer. It should not create new Flow nodes or links.

Use it for:

- risks
- blockers
- waiting notes
- user-written attention items
- compact badges in Text and Flow surfaces

## Android Widget

The Android widget path uses:

- Android TWA host package `app.nanoflow.twa`
- Supabase Edge Functions for registration, summary, notifications, and actions
- optional FCM dirty push
- fallback refresh paths when FCM is unavailable

Widget-related Edge Functions:

- `widget-register`
- `widget-summary`
- `widget-notify`
- `widget-black-box-action`
- `widget-focus-action`

If `android/app/google-services.json` or FCM secrets are missing, the widget path should degrade to manual refresh, unlock-triggered refresh, or WorkManager periodic refresh.

## Import, Export, Trash, and Recovery

Recovery tools are part of the core product, not auxiliary features.

Supported paths:

- JSON export/import for structured project data
- attachment ZIP export/import for files
- trash restoration for deleted and archived tasks
- local desktop auto-backup where supported
- disaster backup and rejected-data isolation paths

High-risk changes must preserve recoverability and avoid irreversible deletion.
