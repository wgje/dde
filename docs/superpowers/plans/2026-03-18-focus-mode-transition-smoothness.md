# Focus Mode Transition Smoothness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make focus-mode enter/exit transitions feel consistently smooth on desktop and mobile, eliminate abrupt component pop-in/pop-out, and remove the sidebar shrink artifact when exiting focus mode with "save dock" while preserving all existing behavior.

**Architecture:** Keep the current Focus/Dock feature set and state model, but add one shared transition choreography contract across workspace shell, project shell, and parking dock surfaces. The key change is to separate layout geometry from visual presence: sidebar width stays stable, projected focus UI stays mounted long enough to animate, and save/clear exit paths share one ordered teardown instead of each layer restoring independently.

**Tech Stack:** Angular 19 standalone components + Signals, Vitest component/pure tests, existing parking/focus motion config in `src/config/parking.config.ts`

---

> Worktree note: execute this plan in a dedicated worktree from a clean baseline. The current workspace already has unrelated and overlapping local edits.

> Spec basis: approved conversation constraints on 2026-03-18
> - Desktop sidebar must keep its width during focus enter/exit; no layout squeeze/shrink.
> - Desktop and mobile are both in scope.
> - Motion direction is "more restrained and smoother", not more theatrical.
> - Functionality must remain intact.

## File Map

- Modify: `src/utils/dock-focus-phase.ts`
  - Extend the shared phase helpers so shell and dock can reason about "layout stable", "visual present", and "interactive" separately.
- Modify: `src/utils/dock-focus-phase.spec.ts`
  - Lock the new phase contract with pure tests before touching UI code.
- Modify: `src/workspace-shell.component.ts`
  - Keep sidebar shell geometry stable across focus phases and expose a single visual policy for desktop/mobile sidebar chrome.
- Modify: `src/workspace-shell.component.html`
  - Add stable phase attrs/hooks only if needed for CSS/test targeting; avoid behavioral churn.
- Modify: `src/workspace-shell.component.spec.ts`
  - Replace the current "release width to 0 during focus" expectations with fixed-width takeover expectations.
- Modify: `src/app/core/shell/project-shell.component.ts`
  - Simplify project content dim/blur/transform choreography so it follows one gentle recovery lane instead of separate restore jitter.
- Create: `src/app/core/shell/project-shell.component.spec.ts`
  - Add focused tests for entering/focused/exiting/restoring visuals and non-interactive rules.
- Modify: `src/app/features/parking/parking-dock.component.ts`
  - Rework dock-centered geometry and floating-surface presence rules using the shared phase contract.
- Modify: `src/app/features/parking/parking-dock.component.html`
  - Replace abrupt `@if` mount points for transient focus UI with presence-aware conditions/attrs.
- Modify: `src/app/features/parking/parking-dock.component.scss`
  - Normalize the timing/easing for focus floating surfaces, exit confirm, restore hints, FAB, and dock shell transitions.
- Modify: `src/app/features/parking/services/dock-focus-transition.service.ts`
  - Hold visual presence long enough for exit animations, unify save/clear exit teardown ordering, and keep chrome restore on the same clock.
- Create: `src/app/features/parking/services/dock-focus-transition.service.spec.ts`
  - Test transition ordering and teardown timing directly.
- Modify: `src/app/features/parking/components/dock-focus-scene.component.ts`
  - Keep stage content mounted/hidden during conservative transitions without pointer-event leaks.
- Modify: `src/app/features/parking/components/dock-focus-scene.component.spec.ts`
  - Cover stage presence across transparent focus, exit, and reduced-motion/T2 paths.
- Modify: `src/app/features/parking/components/parking-dock.component.spec.ts`
  - Cover save-exit, clear-exit, FAB/HUD/help/restore-hint presence, and dock centering.
- Modify: `src/config/parking.config.ts`
  - Tune motion constants only after tests capture the intended choreography.

## Task 1: Lock the Shared Phase Contract and Sidebar Geometry

**Files:**
- Modify: `src/utils/dock-focus-phase.ts`
- Test: `src/utils/dock-focus-phase.spec.ts`
- Modify: `src/workspace-shell.component.ts`
- Modify: `src/workspace-shell.component.html`
- Test: `src/workspace-shell.component.spec.ts`

- [ ] **Step 1: Write the failing pure phase test**

```ts
it('treats desktop chrome as layout-stable during entering/focused/exiting/restoring', () => {
  expect(resolveDockFocusChromePhase(true, { phase: 'entering' }, true, false)).toBe('entering');
  expect(resolveDockFocusChromeLayoutLocked('entering')).toBe(true);
  expect(resolveDockFocusChromeLayoutLocked('focused')).toBe(true);
  expect(resolveDockFocusChromeLayoutLocked('exiting')).toBe(true);
  expect(resolveDockFocusChromeLayoutLocked('restoring')).toBe(true);
});
```

- [ ] **Step 2: Run the pure test to verify it fails**

Run: `npm run test:run:pure -- src/utils/dock-focus-phase.spec.ts`
Expected: FAIL because `resolveDockFocusChromeLayoutLocked` (or equivalent helper) does not exist yet.

- [ ] **Step 3: Write the failing workspace shell test**

```ts
it('keeps desktop sidebar width fixed while focus takeover is active', () => {
  const ctx = {
    resolveFocusWorkspaceTakeoverPhase: () => 'entering',
    uiState: { sidebarOpen: () => true, isMobile: () => false, sidebarWidth: () => 320 },
  } as unknown as WorkspaceShellComponent;

  expect(
    (WorkspaceShellComponent.prototype as unknown as {
      resolveWorkspaceSidebarWidth: (this: WorkspaceShellComponent) => number;
    }).resolveWorkspaceSidebarWidth.call(ctx),
  ).toBe(320);
});
```

- [ ] **Step 4: Run the component test to verify it fails**

Run: `npm run test:run:components -- src/workspace-shell.component.spec.ts`
Expected: FAIL because current logic still returns `0` during active focus takeover.

- [ ] **Step 5: Implement the shared phase helpers and stable sidebar geometry**

```ts
export function resolveDockFocusChromeLayoutLocked(phase: DockFocusChromePhase): boolean {
  return phase === 'entering' || phase === 'focused' || phase === 'exiting' || phase === 'restoring';
}

private resolveWorkspaceSidebarWidth(): number {
  if (this.uiState.isMobile()) return 240;
  if (!this.uiState.sidebarOpen()) return 0;
  return this.uiState.sidebarWidth();
}
```

Implementation notes:
- Keep desktop width stable whenever the sidebar is open.
- Move focus takeover behavior to opacity/transform/pointer-events, not width collapse.
- Reuse the helper in both shell and dock instead of duplicating phase checks.

- [ ] **Step 6: Run the targeted tests to verify they pass**

Run: `npm run test:run:pure -- src/utils/dock-focus-phase.spec.ts`
Expected: PASS

Run: `npm run test:run:components -- src/workspace-shell.component.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/utils/dock-focus-phase.ts src/utils/dock-focus-phase.spec.ts src/workspace-shell.component.ts src/workspace-shell.component.html src/workspace-shell.component.spec.ts
git commit -m "fix: stabilize focus chrome sidebar geometry"
```

## Task 2: Simplify Project Shell Recovery Motion

**Files:**
- Modify: `src/app/core/shell/project-shell.component.ts`
- Create: `src/app/core/shell/project-shell.component.spec.ts`

- [ ] **Step 1: Write the failing project shell test**

```ts
it('uses one restrained recovery lane during exiting and restoring', () => {
  const exiting = makeContext('exiting');
  const restoring = makeContext('restoring');

  expect(readOpacity(exiting)).toBeCloseTo(0.86, 2);
  expect(readTransform(restoring)).toBe('translateY(0) scale(1)');
  expect(readFilter(restoring)).toBe('none');
});
```

- [ ] **Step 2: Run the component test to verify it fails**

Run: `npm run test:run:components -- src/app/core/shell/project-shell.component.spec.ts`
Expected: FAIL because the file does not exist yet and the current implementation still applies restore blur/scale jitter.

- [ ] **Step 3: Implement the gentler project-shell choreography**

```ts
readonly dockTakeoverMainOpacity = computed(() => {
  const phase = this.dockTakeoverPhase();
  if (phase === 'focused') return 0.56;
  if (phase === 'entering') return 0.82;
  if (phase === 'exiting') return 0.9;
  return 1;
});
```

Implementation notes:
- Remove the extra restoring blur/scale shim unless tests prove it is still needed.
- Keep project content visible enough to feel continuous, but non-interactive whenever takeover is active.
- Do not introduce a second animation clock in this component.

- [ ] **Step 4: Run the component test to verify it passes**

Run: `npm run test:run:components -- src/app/core/shell/project-shell.component.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/core/shell/project-shell.component.ts src/app/core/shell/project-shell.component.spec.ts
git commit -m "fix: smooth project shell focus recovery"
```

## Task 3: Add Presence-Driven Focus Surface Mounting

**Files:**
- Modify: `src/app/features/parking/services/dock-focus-transition.service.ts`
- Create: `src/app/features/parking/services/dock-focus-transition.service.spec.ts`
- Modify: `src/app/features/parking/parking-dock.component.ts`
- Modify: `src/app/features/parking/parking-dock.component.html`
- Modify: `src/app/features/parking/parking-dock.component.scss`
- Modify: `src/app/features/parking/components/dock-focus-scene.component.ts`
- Modify: `src/app/features/parking/components/dock-focus-scene.component.spec.ts`
- Modify: `src/app/features/parking/components/parking-dock.component.spec.ts`

- [ ] **Step 1: Write the failing transition service test**

```ts
it('keeps floating focus surfaces mounted until exit animation finishes', () => {
  service.runExitFocusTransition();

  expect(service.isFloatingUiPresent()).toBe(true);
  vi.advanceTimersByTime(motion.focus.exitMs - 1);
  expect(service.isFloatingUiPresent()).toBe(true);
});
```

- [ ] **Step 2: Run the service test to verify it fails**

Run: `npm run test:run:components -- src/app/features/parking/services/dock-focus-transition.service.spec.ts`
Expected: FAIL because the spec file and presence state do not exist yet.

- [ ] **Step 3: Write the failing parking dock / scene tests**

```ts
it('does not unmount help nudge, FAB, HUD, restore hint, or exit confirm before their exit animation window closes', () => {
  focusMode.set(false);
  focusTransition.set({ phase: 'exiting', direction: 'exit', durationMs: 280, startedAt: '', fromRect: {}, toRect: {} } as DockFocusTransitionState);
  fixture.detectChanges();

  expect(query('[data-testid="dock-v3-backup-fab"]')).toBeTruthy();
  expect(query('[data-testid="dock-v3-status-machine-container"]')).toBeTruthy();
});
```

- [ ] **Step 4: Run the component tests to verify they fail**

Run: `npm run test:run:components -- src/app/features/parking/components/dock-focus-scene.component.spec.ts src/app/features/parking/components/parking-dock.component.spec.ts`
Expected: FAIL because the current `@if (focusSessionMounted())` logic unmounts several surfaces too aggressively.

- [ ] **Step 5: Implement the presence contract in service/component/template**

```ts
readonly floatingUiPresent = signal(false);

runEnterFocusTransition(): void {
  this.floatingUiPresent.set(true);
  // existing enter flow...
}

finalizeExitFocusTransition(): void {
  // keep floatingUiPresent true through exit CSS window
  this.exitUnmount.schedule(() => {
    this.floatingUiPresent.set(false);
    this.engine.endFocusTransition();
  }, this.motion.focus.exitMs);
}
```

Implementation notes:
- Replace raw `focusSessionMounted()` gates for transient surfaces with a dedicated presence signal or equivalent derived helper.
- Keep pointer-events off during non-interactive phases even when surfaces remain mounted.
- Cover: HUD, help nudge, help overlay, backup FAB, fragment countdown, fragment overlay, exit confirm, restore hint, dock feedback, and any other focus-floating UI under the parking dock template.

- [ ] **Step 6: Run the targeted tests to verify they pass**

Run: `npm run test:run:components -- src/app/features/parking/services/dock-focus-transition.service.spec.ts src/app/features/parking/components/dock-focus-scene.component.spec.ts src/app/features/parking/components/parking-dock.component.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/features/parking/services/dock-focus-transition.service.ts src/app/features/parking/services/dock-focus-transition.service.spec.ts src/app/features/parking/parking-dock.component.ts src/app/features/parking/parking-dock.component.html src/app/features/parking/parking-dock.component.scss src/app/features/parking/components/dock-focus-scene.component.ts src/app/features/parking/components/dock-focus-scene.component.spec.ts src/app/features/parking/components/parking-dock.component.spec.ts
git commit -m "fix: preserve focus surface presence through transitions"
```

## Task 4: Reorder Save-Exit / Clear-Exit Choreography and Dock Anchoring

**Files:**
- Modify: `src/app/features/parking/parking-dock.component.ts`
- Modify: `src/app/features/parking/services/dock-focus-transition.service.ts`
- Modify: `src/config/parking.config.ts`
- Modify: `src/app/features/parking/components/parking-dock.component.spec.ts`
- Modify: `src/workspace-shell.component.spec.ts`

- [ ] **Step 1: Write the failing save-exit regression test**

```ts
it('save-exit keeps dock anchoring and does not trigger sidebar collapse side effects', () => {
  component.confirmExitFocus('save-exit');

  expect(mockEngine.markExitAction).toHaveBeenCalledWith('save_exit');
  expect(component.sidebarEffectiveWidth()).toBe(320);
});
```

- [ ] **Step 2: Run the targeted component tests to verify they fail**

Run: `npm run test:run:components -- src/app/features/parking/components/parking-dock.component.spec.ts src/workspace-shell.component.spec.ts`
Expected: FAIL because dock anchoring and shell takeover are still using conflicting geometry assumptions.

- [ ] **Step 3: Implement ordered teardown and stable dock centering**

```ts
readonly sidebarEffectiveWidth = computed(() => {
  if (this.uiState.isMobile() || !this.uiState.sidebarOpen()) return 0;
  return this.uiState.sidebarWidth();
});
```

Implementation notes:
- Align dock centering with the new fixed-width sidebar geometry so save-exit does not jump horizontally.
- Start chrome restore on the same clock used to release transient focus presence; do not let shell restore race ahead of the dock exit.
- Keep clear-exit behavior functionally identical, but run the same visual ordering before finalizing dock clearing.
- Only tune motion constants after the tests define the ordering.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm run test:run:components -- src/app/features/parking/components/parking-dock.component.spec.ts src/workspace-shell.component.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/features/parking/parking-dock.component.ts src/app/features/parking/services/dock-focus-transition.service.ts src/config/parking.config.ts src/app/features/parking/components/parking-dock.component.spec.ts src/workspace-shell.component.spec.ts
git commit -m "fix: unify save-exit focus teardown timing"
```

## Task 5: Mobile / Reduced-Motion Regression Coverage and Final Verification

**Files:**
- Modify: `src/app/features/parking/components/dock-focus-scene.component.spec.ts`
- Modify: `src/app/features/parking/components/parking-dock.component.spec.ts`
- Modify: `src/workspace-shell.component.spec.ts`

- [ ] **Step 1: Write the failing mobile and reduced-motion regression tests**

```ts
it('uses the same presence contract on mobile with smaller movement and no layout squeeze', () => {
  // assert sidebar remains overlay-based and focus floating UI still uses presence gating
});

it('short-circuits gracefully when prefers-reduced-motion is enabled', () => {
  // assert direct state change still leaves DOM in a consistent non-jittery end state
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm run test:run:components -- src/workspace-shell.component.spec.ts src/app/features/parking/components/dock-focus-scene.component.spec.ts src/app/features/parking/components/parking-dock.component.spec.ts`
Expected: FAIL until the final mobile/reduced-motion assertions are implemented.

- [ ] **Step 3: Implement any remaining mobile/reduced-motion guards**

```ts
if (this.uiState.isMobile()) {
  return 'translateX(calc(-100% - 12px))';
}
```

Implementation notes:
- Mobile should keep the same choreography model but with lighter movement, not a second bespoke state machine.
- Reduced-motion should remain functionally correct and skip decorative delays without reintroducing abrupt unmounts.

- [ ] **Step 4: Run the full targeted verification set**

Run: `npm run test:run:pure -- src/utils/dock-focus-phase.spec.ts`
Expected: PASS

Run: `npm run test:run:components -- src/workspace-shell.component.spec.ts src/app/core/shell/project-shell.component.spec.ts src/app/features/parking/services/dock-focus-transition.service.spec.ts src/app/features/parking/components/dock-focus-scene.component.spec.ts src/app/features/parking/components/parking-dock.component.spec.ts`
Expected: PASS

Run: `npm run lint -- src/workspace-shell.component.ts src/app/core/shell/project-shell.component.ts src/app/features/parking/parking-dock.component.ts src/app/features/parking/services/dock-focus-transition.service.ts src/app/features/parking/components/dock-focus-scene.component.ts src/utils/dock-focus-phase.ts src/config/parking.config.ts`
Expected: PASS with no new lint errors in touched files

- [ ] **Step 5: Commit**

```bash
git add src/workspace-shell.component.spec.ts src/app/core/shell/project-shell.component.spec.ts src/app/features/parking/services/dock-focus-transition.service.spec.ts src/app/features/parking/components/dock-focus-scene.component.spec.ts src/app/features/parking/components/parking-dock.component.spec.ts
git commit -m "test: lock focus transition smoothness regressions"
```

## Manual Review Checklist

- [ ] Confirm no task changes focus-mode business rules, persistence rules, or dock data semantics.
- [ ] Confirm desktop sidebar width never collapses during entering/focused/exiting/restoring when it was already open.
- [ ] Confirm `save_exit` and `clear_exit` share the same visual teardown order before diverging on data cleanup.
- [ ] Confirm every transient focus surface is either mounted-and-hidden or mounted-and-exiting, never hard-cut.
- [ ] Confirm mobile and reduced-motion paths use the same state contract, not a forked implementation.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-03-18-focus-mode-transition-smoothness.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
