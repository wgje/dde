# TWA Instant Flow Prewarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile TWA startup immediately editable in Text while aggressively prewarming Flow after local readiness so Text -> Flow switching is near-instant and network-independent.

**Architecture:** Add a small shell-owned Flow prewarm boundary that dynamically imports a Flow prewarm target after local editable readiness. The prewarm target warms Flow/GoJS code and safe local graph dependencies without mounting a hidden diagram or adding Flow to the initial static bundle. Verification combines focused Vitest coverage, mobile E2E readiness checks, and `perf:guard`.

**Tech Stack:** Angular 19 standalone components, Signals, TypeScript 5.8, Vitest 4, Playwright 1.48, GoJS 3.1, existing NanoFlow shell lifecycle controllers.

---

## File Structure

- Create `src/app/core/shell/workspace-shell-flow-prewarm.controller.ts`
  - Owns coalescing, scheduling, failure reset, status, and teardown for Flow prewarm.
  - Does not import Flow modules statically.
- Create `src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts`
  - Verifies coalescing, retry after failure, teardown cancellation, and no duplicate prewarm imports.
- Create `src/app/features/flow/flow-prewarm.ts`
  - Exports a side-effect-controlled `prewarmFlowFeature()` function.
  - Dynamically imports `FlowViewComponent` and safe Flow services to fetch/warm chunks.
  - Does not create `go.Diagram`, mount DOM, or call network/cloud paths.
- Create `src/app/features/flow/flow-prewarm.spec.ts`
  - Verifies the prewarm target returns a result and only resolves side-effect-safe services.
- Modify `src/workspace-shell.component.ts`
  - Add a `WorkspaceShellFlowPrewarmController` field.
  - Schedule aggressive Flow prewarm after `ngAfterViewInit()` and local Text shell readiness.
  - Teardown prewarm controller from `ngOnDestroy()`.
- Modify `e2e/mobile-startup-shell.spec.ts`
  - Add observable instrumentation for startup Flow prewarm.
  - Prove Text readiness still happens before Flow prewarm completion.
  - Prove Text -> Flow can use a prewarmed path.
- Optionally modify `scripts/perf-startup-guard.cjs` and `src/tests/scripts/perf-startup-guard.spec.ts`
  - Only if the implementation introduces a new Flow prewarm chunk name that needs explicit guard coverage.

## Implementation Constraints

- Do not statically import `FlowViewComponent`, GoJS, or Flow services from `src/workspace-shell.component.ts`.
- Do not create a hidden `go.Diagram`.
- Do not use `visibility:hidden` to keep Flow alive.
- Do not wait for online status, Supabase, Sentry, diagnostics, or sync before Text editing is usable.
- Keep all new shell code small and controller-shaped, matching existing `src/app/core/shell/*controller.ts` patterns.
- Keep all tests path-scoped so they can run independently inside the dirty worktree.

---

### Task 1: Add Shell Flow Prewarm Controller

**Files:**
- Create: `src/app/core/shell/workspace-shell-flow-prewarm.controller.ts`
- Create: `src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts`

- [ ] **Step 1: Write the failing controller tests**

Create `src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFlowPrewarmController,
  type FlowPrewarmStatus,
} from './workspace-shell-flow-prewarm.controller';

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellFlowPrewarmController', () => {
  it('coalesces repeated aggressive prewarm requests into one load', async () => {
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    controller.scheduleAggressivePrewarm('duplicate');
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledTimes(1);
    expect(controller.status()).toBe('ready');
  });

  it('resets to failed and allows retry after prewarm load failure', async () => {
    const error = new Error('chunk failed');
    const prewarmFlow = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ warmed: true });
    const warn = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      warn,
    });

    controller.scheduleAggressivePrewarm('text-ready');
    await flushMicrotasks();
    expect(controller.status()).toBe('failed');

    controller.scheduleAggressivePrewarm('retry');
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledTimes(2);
    expect(controller.status()).toBe('ready');
    expect(warn).toHaveBeenCalledWith('Flow 预热失败，已允许稍后重试', error);
  });

  it('cancels scheduled work on teardown', async () => {
    let scheduled: (() => void) | null = null;
    const clearScheduled = vi.fn();
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        scheduled = callback;
        return 7;
      },
      clearScheduled,
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    controller.teardown();
    scheduled?.();
    await flushMicrotasks();

    expect(clearScheduled).toHaveBeenCalledWith(7);
    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(controller.status()).toBe('idle');
  });

  it('does not start prewarm when destroyed before the scheduled callback runs', async () => {
    let destroyed = false;
    let scheduled: (() => void) | null = null;
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => destroyed,
      prewarmFlow,
      schedule: callback => {
        scheduled = callback;
        return 1;
      },
      clearScheduled: vi.fn(),
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    destroyed = true;
    scheduled?.();
    await flushMicrotasks();

    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(controller.status()).toBe('idle' satisfies FlowPrewarmStatus);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npx vitest run --config vitest.config.mts src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts
```

Expected: FAIL because `workspace-shell-flow-prewarm.controller.ts` does not exist.

- [ ] **Step 3: Implement the controller**

Create `src/app/core/shell/workspace-shell-flow-prewarm.controller.ts`:

```typescript
export type FlowPrewarmStatus = 'idle' | 'scheduled' | 'loading' | 'ready' | 'failed';

export interface WorkspaceShellFlowPrewarmResult {
  warmed: boolean;
  warmedServices?: string[];
}

export interface WorkspaceShellFlowPrewarmControllerOptions {
  isDestroyed: () => boolean;
  prewarmFlow?: () => Promise<WorkspaceShellFlowPrewarmResult>;
  schedule?: (callback: () => void) => ReturnType<typeof setTimeout> | number;
  clearScheduled?: (handle: ReturnType<typeof setTimeout> | number) => void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellFlowPrewarmController {
  private currentStatus: FlowPrewarmStatus = 'idle';
  private scheduledHandle: ReturnType<typeof setTimeout> | number | null = null;
  private prewarmPromise: Promise<WorkspaceShellFlowPrewarmResult> | null = null;

  constructor(private readonly options: WorkspaceShellFlowPrewarmControllerOptions) {}

  status(): FlowPrewarmStatus {
    return this.currentStatus;
  }

  scheduleAggressivePrewarm(_reason: string): void {
    if (
      this.options.isDestroyed() ||
      this.currentStatus === 'scheduled' ||
      this.currentStatus === 'loading' ||
      this.currentStatus === 'ready'
    ) {
      return;
    }

    this.currentStatus = 'scheduled';
    this.scheduledHandle = this.schedule(() => {
      this.scheduledHandle = null;
      this.startPrewarm();
    });
  }

  teardown(): void {
    if (this.scheduledHandle !== null) {
      this.clearScheduled(this.scheduledHandle);
      this.scheduledHandle = null;
    }
    this.currentStatus = 'idle';
  }

  private startPrewarm(): void {
    if (this.options.isDestroyed()) {
      this.currentStatus = 'idle';
      return;
    }

    this.currentStatus = 'loading';
    this.prewarmPromise = this.prewarmFlow()
      .then(result => {
        if (!this.options.isDestroyed()) {
          this.currentStatus = result.warmed ? 'ready' : 'failed';
        }
        return result;
      })
      .catch(error => {
        this.prewarmPromise = null;
        if (!this.options.isDestroyed()) {
          this.currentStatus = 'failed';
          this.options.warn('Flow 预热失败，已允许稍后重试', error);
        }
        throw error;
      });

    void this.prewarmPromise.catch(() => undefined);
  }

  private prewarmFlow(): Promise<WorkspaceShellFlowPrewarmResult> {
    if (this.options.prewarmFlow) {
      return this.options.prewarmFlow();
    }

    return import('../../features/flow/flow-prewarm')
      .then(({ prewarmFlowFeature }) => prewarmFlowFeature());
  }

  private schedule(callback: () => void): ReturnType<typeof setTimeout> | number {
    if (this.options.schedule) {
      return this.options.schedule(callback);
    }

    const requestIdle = globalThis.requestIdleCallback;
    if (typeof requestIdle === 'function') {
      return requestIdle(callback, { timeout: 750 });
    }

    return setTimeout(callback, 0);
  }

  private clearScheduled(handle: ReturnType<typeof setTimeout> | number): void {
    if (this.options.clearScheduled) {
      this.options.clearScheduled(handle);
      return;
    }

    const cancelIdle = globalThis.cancelIdleCallback;
    if (typeof cancelIdle === 'function' && typeof handle === 'number') {
      cancelIdle(handle);
      return;
    }

    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
```

- [ ] **Step 4: Run the controller test**

Run:

```powershell
npx vitest run --config vitest.config.mts src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/app/core/shell/workspace-shell-flow-prewarm.controller.ts src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts
git commit -m "feat: add workspace flow prewarm controller"
```

---

### Task 2: Add Flow Prewarm Target

**Files:**
- Create: `src/app/features/flow/flow-prewarm.ts`
- Create: `src/app/features/flow/flow-prewarm.spec.ts`

- [ ] **Step 1: Write the failing Flow prewarm target test**

Create `src/app/features/flow/flow-prewarm.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { prewarmFlowFeature } from './flow-prewarm';

describe('prewarmFlowFeature', () => {
  it('loads Flow feature modules without creating a hidden diagram', async () => {
    const result = await prewarmFlowFeature();

    expect(result.warmed).toBe(true);
    expect(result.warmedServices).toContain('FlowViewComponent');
    expect(result.warmedServices).toContain('FlowDiagramService');
    expect(result.createdDiagram).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npx vitest run --config vitest.config.mts src/app/features/flow/flow-prewarm.spec.ts
```

Expected: FAIL because `flow-prewarm.ts` does not exist.

- [ ] **Step 3: Implement the prewarm target**

Create `src/app/features/flow/flow-prewarm.ts`:

```typescript
export interface FlowFeaturePrewarmResult {
  warmed: boolean;
  warmedServices: string[];
  createdDiagram: false;
}

export async function prewarmFlowFeature(): Promise<FlowFeaturePrewarmResult> {
  await Promise.all([
    import('./components/flow-view.component'),
    import('./services/flow-diagram.service'),
    import('./services/flow-diagram-data.service'),
    import('./services/flow-layout.service'),
    import('./services/flow-template.service'),
    import('./services/flow-link-template.service'),
    import('./services/flow-overview.service'),
  ]);

  return {
    warmed: true,
    warmedServices: [
      'FlowViewComponent',
      'FlowDiagramService',
      'FlowDiagramDataService',
      'FlowLayoutService',
      'FlowTemplateService',
      'FlowLinkTemplateService',
      'FlowOverviewService',
    ],
    createdDiagram: false,
  };
}
```

- [ ] **Step 4: Run the Flow prewarm target test**

Run:

```powershell
npx vitest run --config vitest.config.mts src/app/features/flow/flow-prewarm.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run the controller test again**

Run:

```powershell
npx vitest run --config vitest.config.mts src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts
```

Expected: PASS, proving the default dynamic import path resolves.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- src/app/features/flow/flow-prewarm.ts src/app/features/flow/flow-prewarm.spec.ts
git commit -m "feat: add flow feature prewarm target"
```

---

### Task 3: Wire Flow Prewarm Into Shell Startup

**Files:**
- Modify: `src/workspace-shell.component.ts`
- Test: `src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts`

- [ ] **Step 1: Add shell field and lifecycle calls**

Modify `src/workspace-shell.component.ts`:

1. Add this import with other shell controller imports:

```typescript
import { WorkspaceShellFlowPrewarmController } from './app/core/shell/workspace-shell-flow-prewarm.controller';
```

2. Add this private field near the other startup/lifecycle controller fields:

```typescript
  private readonly flowPrewarm = new WorkspaceShellFlowPrewarmController({
    isDestroyed: () => this.destroyed,
    warn: this.warn,
  });
```

3. Update `ngAfterViewInit()`:

```typescript
  ngAfterViewInit(): void {
    this.afterViewInit.initialize();
    this.flowPrewarm.scheduleAggressivePrewarm('workspace-after-view-init');
  }
```

4. Update `ngOnDestroy()`:

```typescript
  ngOnDestroy() {
    this.flowPrewarm.teardown();
    this.destroyController.destroy();
  }
```

This schedules aggressive Flow prewarm only after Angular has rendered the shell view, preserving the first Text render path.

- [ ] **Step 2: Run TypeScript check for the shell wiring**

Run:

```powershell
npx tsc --noEmit --pretty false --project tsconfig.app.json
```

Expected: PASS. If it fails because `requestIdleCallback` types are missing, update the controller to access idle callbacks through a narrowed local type:

```typescript
type IdleSchedulerGlobal = typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};
```

Then replace `globalThis.requestIdleCallback` and `globalThis.cancelIdleCallback` with `(globalThis as IdleSchedulerGlobal).requestIdleCallback` and `(globalThis as IdleSchedulerGlobal).cancelIdleCallback`.

- [ ] **Step 3: Run targeted tests**

Run:

```powershell
npx vitest run --config vitest.config.mts src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts src/app/features/flow/flow-prewarm.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Task 3**

```powershell
git add -- src/workspace-shell.component.ts src/app/core/shell/workspace-shell-flow-prewarm.controller.ts src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts
git commit -m "feat: prewarm flow after shell startup"
```

---

### Task 4: Add Mobile Startup/Prewarm E2E Evidence

**Files:**
- Modify: `e2e/mobile-startup-shell.spec.ts`

- [ ] **Step 1: Add browser-visible prewarm instrumentation**

Before adding the E2E, modify `WorkspaceShellFlowPrewarmController` from Task 1 to emit test-observable browser events without affecting production behavior:

```typescript
function recordFlowPrewarmEvent(status: FlowPrewarmStatus, reason: string): void {
  const target = globalThis as typeof globalThis & {
    __NANOFLOW_FLOW_PREWARM_TRACE__?: Array<{ status: FlowPrewarmStatus; reason: string; at: number }>;
  };
  target.__NANOFLOW_FLOW_PREWARM_TRACE__ ??= [];
  target.__NANOFLOW_FLOW_PREWARM_TRACE__.push({
    status,
    reason,
    at: Date.now(),
  });
}
```

Call it in `scheduleAggressivePrewarm()` after setting `scheduled`, in `startPrewarm()` after setting `loading`, in the success branch after setting `ready`, and in the failure branch after setting `failed`.

- [ ] **Step 2: Add E2E test for Text readiness before Flow prewarm completion**

Append to `e2e/mobile-startup-shell.spec.ts`:

```typescript
  test('should keep mobile text editable while flow prewarm runs after startup', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        activeProjectId: 'project-1',
        lastActiveView: 'text',
        preferredView: 'text',
        resolvedLaunchView: 'text',
        routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
        mobileDegraded: false,
        degradeReason: null,
        theme: 'default',
        colorMode: 'light',
        projects: [{
          id: 'project-1',
          name: 'Prewarm Project',
          description: 'startup prewarm',
          updatedAt: new Date().toISOString(),
          taskCount: 1,
          openTaskCount: 1,
          recentTasks: [{ id: 'task-1', title: 'Task 1', displayId: '1', status: 'active' }],
        }],
        currentProject: null,
      }));
    });

    await page.goto('/projects/project-1/text', { waitUntil: 'domcontentloaded' });
    await waitForMobileTextReady(page);

    await page.waitForFunction(() => {
      const records = (window as Window & {
        __NANOFLOW_FLOW_PREWARM_TRACE__?: Array<{ status?: string }>;
      }).__NANOFLOW_FLOW_PREWARM_TRACE__ ?? [];
      return records.some(entry => entry.status === 'scheduled')
        && records.some(entry => entry.status === 'loading');
    }, { timeout: 10_000 });

    await expect(page.locator('[data-testid="mobile-text-view-label"]')).toContainText('文本');
  });
```

- [ ] **Step 3: Add E2E test for prewarmed Text -> Flow switch**

Append to `e2e/mobile-startup-shell.spec.ts`:

```typescript
  test('should switch from text to flow after flow prewarm completes', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        activeProjectId: 'project-1',
        lastActiveView: 'text',
        preferredView: 'text',
        resolvedLaunchView: 'text',
        routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
        mobileDegraded: false,
        degradeReason: null,
        theme: 'default',
        colorMode: 'light',
        projects: [{
          id: 'project-1',
          name: 'Flow Switch Project',
          description: 'prewarmed flow switch',
          updatedAt: new Date().toISOString(),
          taskCount: 1,
          openTaskCount: 1,
          recentTasks: [{ id: 'task-1', title: 'Task 1', displayId: '1', status: 'active' }],
        }],
        currentProject: null,
      }));
    });

    await page.goto('/projects/project-1/text', { waitUntil: 'domcontentloaded' });
    await waitForMobileTextReady(page);

    await page.waitForFunction(() => {
      const records = (window as Window & {
        __NANOFLOW_FLOW_PREWARM_TRACE__?: Array<{ status?: string }>;
      }).__NANOFLOW_FLOW_PREWARM_TRACE__ ?? [];
      return records.some(entry => entry.status === 'ready');
    }, { timeout: 30_000 });

    await page.locator('[data-testid="flow-view-tab"]').first().click();
    await page.waitForSelector('[data-testid="flow-diagram"]', { timeout: 10_000 });

    const trace = await page.evaluate(() =>
      (window as Window & {
        __NANOFLOW_FLOW_PREWARM_TRACE__?: Array<{ status?: string }>;
      }).__NANOFLOW_FLOW_PREWARM_TRACE__?.map(entry => entry.status) ?? []
    );

    expect(trace).toContain('ready');
  });
```

- [ ] **Step 4: Run mobile startup E2E**

Run:

```powershell
npx playwright test e2e/mobile-startup-shell.spec.ts --project=chromium
```

Expected: PASS. If the repo uses a different Playwright project name, inspect `playwright.config.ts` and rerun with the configured project.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- src/app/core/shell/workspace-shell-flow-prewarm.controller.ts e2e/mobile-startup-shell.spec.ts
git commit -m "test: cover mobile flow prewarm startup"
```

---

### Task 5: Run Final Performance And Integration Gates

**Files:**
- No planned source edits. Only edit `scripts/perf-startup-guard.cjs` / `src/tests/scripts/perf-startup-guard.spec.ts` if `perf:guard` shows the new prewarm path accidentally entering initial static/modulepreload paths and the guard needs a more precise assertion.

- [ ] **Step 1: Run targeted Vitest suite**

Run:

```powershell
npx vitest run --config vitest.config.mts src/app/core/shell/workspace-shell-flow-prewarm.controller.spec.ts src/app/features/flow/flow-prewarm.spec.ts src/tests/scripts/perf-startup-guard.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run app TypeScript check**

Run:

```powershell
npx tsc --noEmit --pretty false --project tsconfig.app.json
```

Expected: PASS.

- [ ] **Step 3: Run startup performance guard**

Run:

```powershell
npm run perf:guard
```

Expected: PASS. The output must not report `FlowViewComponent`, `flow-view`, `WorkspaceShellComponent`, or `workspace-shell` in forbidden initial modulepreload/static paths.

- [ ] **Step 4: Run mobile E2E startup spec**

Run:

```powershell
npx playwright test e2e/mobile-startup-shell.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 5: Check diff hygiene**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` produces no output and exits 0. `git status --short` may show unrelated pre-existing worktree changes, but the files from this plan should be either committed or intentionally staged for the final commit.

- [ ] **Step 6: Final commit if any guard-only edits were needed**

If Task 5 required guard edits, commit only those files:

```powershell
git add -- scripts/perf-startup-guard.cjs src/tests/scripts/perf-startup-guard.spec.ts
git commit -m "test: guard flow prewarm startup boundaries"
```

---

## Completion Checklist

- [ ] Text startup path still reaches mobile Text without waiting for network or Flow.
- [ ] Flow prewarm is scheduled after shell render/local readiness, not before first usable Text.
- [ ] Flow prewarm uses dynamic imports only.
- [ ] No hidden `go.Diagram` is created.
- [ ] Text -> Flow E2E waits for prewarm ready and then switches to visible diagram.
- [ ] `npm run perf:guard` proves Flow did not re-enter forbidden initial preload/static paths.
- [ ] Targeted Vitest, app TypeScript, and mobile E2E checks pass.
