---
title: Feature Workflows
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/shell/workspace-sidebar-panel.component.ts
  - src/app/core/shell/workspace-sidebar-focus-tools-load-state.controller.ts
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

## 候选：移动侧栏工具按可见意图加载

状态：本地候选实现与组件测试，未据此证明生产发布。`WorkspaceSidebarPanelComponent` 在 mobile + sidebar-open 的 after-render write 阶段，以 untracked 调用现有 onToolsIntent；录音仍受 isBlackBoxEnabled 偏好控制。无 hover 触屏打开侧栏即可准备动态组件，不把 Focus/录音模块改为首屏静态依赖，也不等待模块后才显示 Text。

`WorkspaceSidebarFocusToolsLoadStateController` 每次尝试保留 idle/loading/ready/failed 状态。模块未返回时约15秒截止到 failed，显示现有中文重试入口；重新显式激活建立新 attempt，晚到旧结果不改变已失败状态。deadline 不删除缓存、队列或用户数据；后台 timer throttling 不等于严格15秒墙钟保证。组件准备不自动切换专注、不自动录音、不触发麦克风许可。

组件回归覆盖关闭不预载、打开无 hover 自动准备两工具、不抢焦点、loading/failure/retry可见、失败无渲染重试循环。控制器测试覆盖超时、晚到结果、重试与销毁。它们不证明真实网络、麦克风或生产功能已恢复。来源：`src/app/core/shell/workspace-sidebar-panel.component.ts`、`src/app/core/shell/workspace-sidebar-focus-tools-load-state.controller.ts`；用户说明见 handbook/02-use-nanoflow/04-focus-mode.md 与 05-black-box.md。


## Mobile sidebar viewport resize safety

The shell normalizes its window provider once at the viewport-resize host boundary and passes the same provider to listener registration and the lazy resize controller. A browser default uses window; an explicit no-window provider remains a no-op. Cleanup and generation fencing discard late callbacks. Import failures remain visible as warnings, while a missing provider cannot be misreported as a chunk failure. This boundary is independent of Flow viewport persistence: Flow pan/zoom is local owner-scoped snapshot state and does not initiate task cloud writes.

## Black Box SVG action semantics

Entry, panel, mobile drawer and Strata restore icons use inline 24-unit SVGs with
`currentColor`, rounded strokes and hidden decorative semantics. Visible labels
remain the primary meaning: read, complete, delete, pending sync and restore.
Actions are visible without hover; rows wrap rather than overflow on narrow screens.
This changes presentation only: durable methods, sync decisions, confirmation,
keyboard shortcuts and local-first persistence are unchanged.

## Mobile Dock transparent entry

The collapsed mobile Dock uses a transparent label/count and upward chevron with a 44px touch target. Focus is a secondary text action; the existing drawer and confirmation logic are unchanged. Isolated development previews: `/#/dev-preview/dock/mobile-entry` (tap to open), `/#/dev-preview/dock/mobile-open` (expanded result). Fixture data stays in page memory only.

## Archived task visibility boundary

`ProjectStateService.visibleTasks` is the shared main-view projection for stage tasks, unassigned tasks, root options, unfinished items and todo counts. It excludes soft-deleted and `status === 'archived'` entities while `tasks()` and validated whole-project snapshots retain the complete entities so unarchive and export can restore the original ID/content. Do not apply this view projection to synchronization serializers, metadata shells, or backup payloads.