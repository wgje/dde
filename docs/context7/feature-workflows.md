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

## Text View

Text is the default mobile surface. Task operations use task services and stores; edits persist locally first, and cloud sync must not block immediate UI feedback.

## Flow View

Flow uses GoJS to inspect task structure and relationships. It is not the mobile default and remains lazy-loaded. Do not preserve diagram instances under `visibility:hidden`; destroy and recreate them when required by the view lifecycle.

## Parking Dock

Parking Dock holds tasks that should pause without being deleted or archived. Entries may be project tasks or Dock-created tasks; wait timers, reminders, main-task state, and Focus transitions remain owned by existing Dock services.

On mobile, the collapsed entry is a low-emphasis transparent affordance at the bottom edge: no card fill, border or shadow, only a small Dock label/count and chevron. Touch/hover and keyboard focus reveal a faint surface without reducing the 44px touch target. Focus remains a quiet text action. Tapping the Dock entry opens the existing current/candidate/standby drawer. Preview does not switch tasks; explicit confirmation follows the existing parent task-selection path. The development-only real-component examples are `/#/dev-preview/dock/mobile-entry` and `/#/dev-preview/dock/mobile-open`, with in-memory entries only.

This presentation change does not alter desktop Dock layout, task persistence, snapshot format or sync ownership.

## Focus Mode

Focus includes Gate review, Strata, Focus Console and fragment interludes. Daily Gate snooze remains limited to three; speech transcription quota remains 50/day; Strata shows up to 30 days. Focus snapshots remain versioned and contain command-center, combo-select, backup, routine, high-load and burnout fields.

## Black Box

Black Box provides offline text capture and later Gate/Focus processing. Speech retention and remote transcription remain controlled by the existing capture and Supabase workflow.

## Task Sidecar

Sidecar data is attention metadata; it must not create Flow graph topology.

## Android Widget

Android TWA uses existing registration, summary, notification and action functions with FCM/WorkManager fallbacks.

## Recovery

Project JSON, attachment ZIP, trash restoration, desktop backups and disaster recovery are core product paths. High-risk changes must preserve recoverability.
