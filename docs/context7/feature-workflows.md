---
title: Feature Workflows
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-11-28
source_paths:
  - src/app/features/text/
  - src/app/features/flow/
  - src/app/features/focus/
  - src/app/features/parking/
  - src/app/dev-preview/demo-dock-entry-preview.component.ts
  - src/services/dock-*.ts
  - src/services/black-box*.ts
---

# Feature Workflows

This page summarizes the major user-facing workflows and the architecture boundaries that protect them.

## Text View

Text view is the default daily workflow and the default mobile surface.

Use it for fast task creation and editing, hierarchical organization, filtering, search, Markdown content editing, and mobile-first task management. Text operations go through task services and stores; edits persist locally first, and UI must not wait for cloud sync before reflecting input.

## Flow View

Flow uses GoJS to inspect structure, arrange tasks spatially, edit relationships and export context. It is not the mobile default and must remain lazy-loaded; never keep instances under `visibility:hidden`. Flow events remain decoupled through `FlowTemplateService -> flow-template-events.ts -> FlowEventService`.

## Parking Dock

Parking Dock temporarily holds work without deleting or archiving it. Entries remain project tasks or dock-created inline tasks. Wait timers, reminders, current-task state and Focus transitions belong to the existing Dock state machine.

The mobile Text view presents a low-emphasis transparent Dock trigger at the bottom edge so the workspace remains the visual focus. It shows only Dock name/count and a chevron; its background, border and shadow remain transparent. Hover, touch feedback and keyboard focus reveal a subtle surface, while the target remains at least 44px high. Focus remains a quiet secondary action. Opening the trigger presents the normal current/candidate/standby drawer. Previewing an entry never switches the current task; only explicit confirmation follows the parent Dock task-selection path. The real component is directly previewable at `/#/dev-preview/dock/mobile-entry` and `/#/dev-preview/dock/mobile-open` using isolated in-memory entries.

Desktop Dock layout, entry classification, task persistence and sync remain unchanged by this collapsed-trigger treatment.

## Focus Mode

Focus includes Gate, Strata, Focus Console, and fragment interludes. Gate snooze remains limited to three per day; speech transcription quota remains 50 per day; Strata shows up to 30 days. Focus snapshots remain versioned; V2 covers command center, combo-select, backup, routine, high-load and burnout fields.

## Black Box

Black Box provides offline text capture to `BlackBoxEntry`, later processed through Gate or Focus. Speech capture stays local until the existing Supabase `transcribe` workflow uses Groq `whisper-large-v3`; retention follows capture services.

## Task Sidecar / Attention Metadata

Sidecar data uses `attentionMeta` and describes risks, blockers, waiting notes and attention items; it must not create Flow graph topology.

## Android Widget

Android TWA `app.nanoflow.twa` uses existing registration, summary, notification and action Edge Functions with FCM and WorkManager fallback. Missing Firebase configuration degrades to manual/unlock/periodic refresh.

## Import, Export, Trash, and Recovery

Core recovery includes project JSON, attachment ZIP, trash restore, local desktop backup, disaster backup and rejected-data isolation. High-risk work must preserve recoverability and avoid irreversible deletion.

## Black Box SVG action semantics

Entry, panel, mobile drawer and Strata actions use inline 24-unit SVGs with `currentColor`, rounded strokes and hidden decorative semantics. Labels retain the action meaning; rows wrap on narrow screens. This changes presentation only, not durable methods, sync decisions, confirmations, shortcuts or local-first persistence.
