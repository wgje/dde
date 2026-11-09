# TWA Instant Flow Prewarm Design

## Goal

Make the Android TWA feel usable immediately after tapping the app icon:

- The first usable screen restores local workspace state and Text editing without waiting for network, Supabase sync, Sentry, diagnostics, or GoJS.
- Text edits commit locally and update the UI immediately.
- On mobile, switching from Text to Flow should feel near-instant after launch.
- Heavy functionality is not part of the first-screen static path, but Flow is aggressively prewarmed after the local editable core is visible.
- Slow, unavailable, or expired network state must not block the main editing path.

The approved priority is **Flow seconds-open priority**: after Text becomes usable, Flow prewarm should start as early and aggressively as possible, accepting some post-first-screen CPU/network cost to make Text -> Flow switching fast.

## Current Evidence

Current repository context already has the right pieces to build on:

- `scripts/perf-startup-guard.cjs` blocks `TextViewComponent`, `FlowViewComponent`, `WorkspaceShellComponent`, and `ProjectShellComponent` from forbidden modulepreload paths and caps the workspace shell chunk.
- `WorkspaceShellStartupLazyServicesController` already isolates startup diagnostics, storage quota, IndexedDB health, and font scheduler behind lazy startup work.
- `WorkspaceShellStartupLazyServicesHostController` already provides a host boundary for lazy startup services.
- `UiStateService.activeView` is the mobile Text/Flow view source of truth and persists the last active view.
- `TextViewComponent` already owns mobile Text editing lifecycle and resets editing state on mobile view switches.
- `FlowViewComponent` owns GoJS-backed Flow rendering, mobile drawer behavior, diagram lifecycle, selection, layout, and related services.
- `FlowViewMobileInteractionController` already reacts to mobile Text/Flow switches and requests diagram updates after Flow becomes active.
- `e2e/mobile-startup-shell.spec.ts` exists as the natural E2E home for mobile startup readiness.

Angular 19 `@defer` supports separate render triggers and prefetch triggers. That lets the app keep Flow out of the initial render while still prefetching Flow code before the user switches to Flow.

## Requirements

### R1. Startup Must Reach Editable Text First

The launch path must restore enough local workspace state for Text editing before any optional cloud or heavy visual work can block the user.

Required behavior:

- Mobile TWA opens to the local editable Text core.
- Existing local project/task data is usable from IndexedDB or already-hydrated local state.
- Text editing controls respond before cloud sync finishes.
- Remote auth/session refresh, Supabase load, Sentry import, diagnostics, storage quota checks, and Flow initialization are background work.

### R2. Text Editing Must Be Zero-wait From The User's Perspective

When the user edits a task title/content in Text:

- UI updates immediately.
- The local/offline write path owns the foreground success condition.
- Cloud sync is scheduled after the foreground edit and cannot make editing wait.
- Failure to contact the network produces sync/retry state, not a blocked editor.

This design does not redefine durable local-first writes; it depends on the offline-first/local-first architecture already being implemented and verified by the broader repo work.

### R3. Flow Must Be Aggressively Prewarmed After Text Is Usable

Flow is not allowed to be first-screen static work, but it should start prewarming as soon as the editable core is ready.

Prewarm should include:

- Fetching the Flow route/component chunk.
- Fetching GoJS and Flow service chunks pulled by `FlowViewComponent`.
- Preparing current-project graph inputs from local state where possible.
- Warming lightweight diagram-adjacent services that can be safely resolved without creating a hidden GoJS diagram.

Prewarm must not:

- Mount a hidden GoJS diagram with `visibility:hidden`.
- Force Flow into the initial static import closure.
- Depend on online status.
- Delay Text edit readiness.

### R4. Text -> Flow Switch Should Only Do Final Mount Work

When the mobile user taps or swipes to Flow after prewarm:

- The code and data should already be warm.
- The switch should mount the Flow view and create the real visible diagram.
- The app should avoid a full "download + initialize + compute from zero" path at switch time.
- If prewarm is still in flight, the Flow view may show a short preparation state, but Text state and local edits remain intact.

### R5. Network Must Be Non-blocking For Main Operations

Network state can affect background sync and freshness indicators. It must not block:

- App shell usability.
- Text editing.
- Current local project browsing.
- Viewing Flow for already-local project data.

Online-only failures are represented as background sync/retry/auth states.

## Architecture Decision

Add a dedicated **Flow prewarm boundary** triggered from the shell after local editable readiness, not from `FlowViewComponent` construction.

The boundary should be small and testable:

- `WorkspaceShellFlowPrewarmController` or equivalent controller in `src/app/core/shell/`.
- It receives only stable dependencies: logger/warn, injector, `UiStateService`, local readiness signal or callback, and a scheduler abstraction.
- It exposes `scheduleAggressivePrewarm(reason)` and `teardown()`.
- It coalesces duplicate requests and records status: `idle`, `scheduled`, `loading`, `ready`, `failed`.
- It dynamically imports the Flow prewarm target instead of statically importing Flow modules.

The shell triggers prewarm when the local editable core is ready:

1. Startup bootstrap restores or resolves local project state.
2. Text is mountable and the mobile app is interactive.
3. The shell schedules aggressive Flow prewarm on the next microtask/short timer or `requestIdleCallback` with a short timeout.
4. Additional user-intent signals can call `scheduleAggressivePrewarm()` again, but the controller coalesces them.

The Flow view still owns actual diagram creation. Prewarm prepares code/data, but it does not keep a hidden diagram alive.

## Prewarm Target

The prewarm target should be a narrow dynamically imported module, for example:

`src/app/features/flow/flow-prewarm.ts`

Responsibilities:

- Import the Flow component route dependencies enough for the browser/module graph to fetch the heavy chunks.
- Optionally resolve injectable Flow services through the shell injector only when doing so is side-effect safe.
- Prime current-project graph data through existing local stores/services without network calls.
- Return a small result object for diagnostics and tests.

It must avoid:

- Creating `go.Diagram` without a visible container.
- Running layout that requires DOM measurement.
- Calling cloud save/load paths.
- Registering long-lived global listeners that only the real Flow view should own.

## Alternatives Considered

### A. Keep Flow Lazy Until User Opens It

This gives the smallest startup work but creates the exact failure mode the user rejected: on mobile, Text -> Flow can become a visible loading path because the app starts downloading and initializing Flow only after the tap.

Rejected.

### B. Put Flow Back Into The First-screen Bundle

This maximizes Flow readiness but violates the startup-health direction and risks making the TWA icon tap feel slow. It also fights `perf-startup-guard` and can regress weaker devices.

Rejected.

### C. Keep Flow Deferred But Aggressively Prefetch/Prewarm After Text Is Ready

This preserves immediate Text usability while making Flow likely ready by the time the user switches. It matches Angular defer prefetch semantics and the existing shell lazy-service pattern.

Chosen.

## User Experience States

### Launch

The user sees the local workspace/Text surface first. Startup indicators may show sync freshness or cloud state, but the editor is usable.

### Background Flow Prewarm

No visible modal or blocking spinner. At most, internal diagnostics or development logs record prewarm status.

### Flow Switch Ready

The user taps Flow. The Flow route/view appears and diagram creation begins immediately from warm code/data.

### Flow Switch Still Warming

The user taps Flow before prewarm completes. The app shows the shortest possible preparation state in the Flow area. Text state is preserved and no local edit is rolled back.

### Flow Prewarm Failure

Failure is non-fatal. The app logs/warns, resets the prewarm controller to retryable state, and lets the normal Flow activation path try again when the user opens Flow.

## Implementation Plan Shape

This design should be implemented in small verified slices:

1. Add the shell Flow prewarm controller with coalescing, failure reset, teardown, and tests.
2. Add the dynamic Flow prewarm target with no hidden diagram creation.
3. Wire shell local-readiness to aggressive prewarm scheduling.
4. Add mobile startup/Flow switch tests or contracts proving prewarm is requested after Text readiness and does not block editing.
5. Run bundle/perf gates to ensure Flow remains outside the initial static closure.

## Verification Requirements

A change is not complete until evidence covers all of these:

- Unit tests for prewarm coalescing, retry after failure, teardown, and no duplicate imports.
- A shell/controller test proving Flow prewarm is scheduled only after local editable readiness.
- A mobile startup E2E or equivalent contract proving Text is visible/editable before network-dependent work completes.
- A Flow switch E2E or browser check proving Text -> Flow does not perform the cold path when prewarm has completed.
- `npm run perf:guard` proves Flow did not re-enter forbidden initial preload/static paths.
- Targeted TypeScript/Vitest checks cover the touched controllers and Flow prewarm target.

## Non-goals

- This design does not introduce a hidden persistent GoJS diagram.
- This design does not make network freshness a prerequisite for editing.
- This design does not move all Flow services into the shell static import graph.
- This design does not replace the existing offline-first/local-first Outbox design.
- This design does not require the first ever install on an uncached slow network to show Flow instantly before its code has downloaded.

## Open Implementation Details

These details should be decided during the implementation plan from current source:

- The exact local-readiness signal to use from `WorkspaceShellComponent` / startup delegates.
- Whether the prewarm target imports `FlowViewComponent` directly or imports a narrower route/prewarm module that pulls the same chunk.
- Which Flow services are safe to resolve during prewarm without DOM, diagram, or network side effects.
- The exact E2E measurement budget for Text ready and Text -> Flow switch on mobile preview.

## Approval

Approved direction from the user:

- Prefer Flow near-instant switching after startup.
- Aggressively prewarm Flow after launch, accepting some post-first-screen resource cost.
- Preserve the hard line that Text local editing and startup usability cannot wait for network or heavy Flow initialization.
