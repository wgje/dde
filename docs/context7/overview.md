---
title: NanoFlow Overview
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - README.md
  - package.json
  - src/app/features/
  - src/services/
---

# NanoFlow Overview

NanoFlow is an offline-first personal task workflow app. It combines a text task tree, a GoJS flow graph, Parking Dock, Focus Mode, Black Box capture, recovery tools, import/export, Android widget support, and Supabase cloud sync in one Angular PWA.

## Product Positioning

NanoFlow is built for **single-user, multi-device personal workflow**. It is not a team collaboration platform, shared project manager, or chat product.

The application optimizes for:

- immediate local editing
- offline availability
- recoverability after sync or storage failures
- mobile usability through a default Text view
- optional cloud capabilities through Supabase

## Core Capabilities

| Capability | Offline | Requires Supabase | Notes |
| --- | --- | --- | --- |
| Text task tree | Yes | No | hierarchical editing, ordering, filtering, search |
| Flow view | Yes | No | GoJS graph for structure, relationships, export |
| Parking Dock | Yes | No | temporarily park tasks, reminders, focus takeover |
| Focus Mode | Yes | No | Gate, Strata, Focus Console, task scheduling |
| Black Box text capture | Yes | No | quick capture and later processing |
| Black Box speech transcription | Partial | Yes | local audio cache, cloud transcription through Edge Function |
| Attachments | Partial | Yes | local metadata plus Supabase Storage upload |
| Trash and archive recovery | Yes | No | soft-delete and restoration workflows |
| JSON import/export | Yes | No | structured backup and restore |
| Android widget | No | Yes | Android TWA host and Supabase Edge Functions |
| Multi-device sync | No | Yes | Supabase Auth, PostgreSQL, Storage, Edge Functions |

## Primary Workflows

1. Use **Text view** for daily task editing.
2. Use **Flow view** for structure and relationship inspection.
3. Use **Parking Dock** for tasks that should wait without being forgotten.
4. Use **Focus Mode** to select and execute near-term work.
5. Use **Black Box** to capture unstructured thoughts and process them through Gate.
6. Use export, trash, archive, and disaster backup paths for recovery.

## Current Boundaries

- The project targets personal workflow, not multi-user collaboration.
- Cloud sync, login, attachments, speech transcription, and Android widget flows depend on Supabase.
- Mobile defaults to Text view; Flow view is not a persistent mobile surface.
- The Android widget path is retained; the desktop widget runtime has been retired.
- Groq `whisper-large-v3` transcription has a daily quota of 50 entries per user.
- Trash retention is 30 days.
- All sensitive credentials must remain outside frontend source.

## Key Repository Paths

| Path | Purpose |
| --- | --- |
| `src/app/core/state/stores.ts` | Angular Signal stores for tasks, projects, and connections |
| `src/app/core/services/sync/` | sync sub-services for cloud load, push, retry, tombstones, polling |
| `src/services/` | business services for task operations, auth, focus, dock, backup, conflicts |
| `src/app/features/text/` | mobile-first text task experience |
| `src/app/features/flow/` | GoJS flow graph feature |
| `src/app/features/focus/` | Focus Mode UI and workflows |
| `src/app/features/parking/` | Parking Dock UI |
| `src/config/` | constants and feature flags |
| `src/models/` | TypeScript domain models |
| `supabase/functions/` | Edge Functions |
| `e2e/` | Playwright tests |
| `scripts/` | build, validation, test, deployment helper scripts |
