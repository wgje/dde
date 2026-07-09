# Codebase Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn NanoFlow from a working but high-complexity Angular/Supabase application into a healthier, measurable, lower-risk engineering project.

**Architecture:** Start with objective health telemetry, then refactor one hot path at a time behind existing public APIs. The first pass targets sync mappers, RetryQueue processing, and BatchSync orchestration because codegraph and lint both show high blast radius and high complexity there.

**Tech Stack:** Angular 19.2, TypeScript 5.8, Vitest 4, Supabase JS 2.84, GoJS 3.1, ESLint 9.

---

## Scope Check

This goal spans multiple subsystems and should not be executed as a single rewrite. Split the long-term goal into these independent workstreams:

1. Sync pipeline health: `src/app/core/services/sync/**`, `src/services/sync-*.ts`, Supabase RPC contracts.
2. Shell and startup health: `src/workspace-shell.component.*`, `src/app/core/shell/**`, session bootstrap.
3. Flow and GoJS health: `src/app/features/flow/**`, mobile text fallback, diagram lifecycle.
4. Validation and type health: `src/utils/validation.ts`, `src/utils/supabase-error.ts`, generated Supabase types.
5. Tooling and governance: health baseline scripts, ESLint ratchets, test matrix tracking.

This plan is Phase 1 only: create a measurable baseline, then make small behavior-preserving cuts in sync code. Do not touch unrelated user changes in the current dirty worktree.

## Current Baseline

Observed on 2026-06-08:

- codegraph index: 900 files, including 754 TypeScript files.
- `npm run lint`: exit 0, with 509 warnings and 0 errors.
- `npm run test:run:minimal`: exit 0.
- Largest production files include:
  - `src/services/black-box-sync.service.ts`: 2839 lines.
  - `src/services/user-session.service.ts`: 2788 lines.
  - `src/workspace-shell.component.ts`: 2514 lines.
  - `src/app/core/services/sync/retry-queue.service.ts`: 2348 lines.
  - `src/app/core/services/sync/project-data.service.ts`: 2006 lines.
  - `src/app/features/flow/services/flow-overview.service.ts`: 1842 lines.
  - `src/app/core/services/sync/task-sync-operations.service.ts`: 1837 lines.
  - `src/app/core/services/sync/connection-sync-operations.service.ts`: 1552 lines.
- codegraph hot spots with missing direct coverage signals:
  - `ProjectDataService.rowToTask`
  - `RetryQueueService.processQueueSlice`
  - `BatchSyncService.saveProjectToCloud`

## Guardrails

- Preserve client-generated IDs via `crypto.randomUUID()`.
- Preserve offline-first flow: local write and optimistic UI before debounced cloud push.
- Preserve LWW semantics based on `updatedAt` / `updated_at`.
- Preserve RetryQueue owner isolation and hidden queue item behavior.
- Preserve mobile GoJS lifecycle rules: text view default, flow lazy loading, destroy/rebuild diagrams.
- Do not introduce NgRx or a facade Store.
- Use tests before implementation for every behavior change.

## File Structure

Expected Phase 1 files:

- Create: `scripts/code-health-baseline.cjs`
  - Produces a stable JSON and console health snapshot from current source file sizes and ESLint JSON.
- Modify: `package.json`
  - Adds `quality:baseline` script only.
- Create: `src/app/core/services/sync/task-row.mapper.ts`
  - Pure mapper for Supabase task rows to `Task`.
- Create: `src/app/core/services/sync/task-row.mapper.spec.ts`
  - Tests mapper edge cases without Angular TestBed.
- Modify: `src/app/core/services/sync/project-data.service.ts`
  - Delegates `rowToTask` to the pure mapper while keeping the existing public method.
- Create: `src/app/core/services/sync/retry-queue-processing.ts`
  - Pure decision helpers for RetryQueue item classification.
- Create: `src/app/core/services/sync/retry-queue-processing.spec.ts`
  - Tests retry classification without IndexedDB or Angular injection.
- Modify: `src/app/core/services/sync/retry-queue.service.ts`
  - Uses pure helpers inside `processQueueSlice`; public behavior remains unchanged.
- Create: `src/app/core/services/sync/project-save-plan.ts`
  - Pure planning helpers for save-project batching and partial handoff classification.
- Create: `src/app/core/services/sync/project-save-plan.spec.ts`
  - Tests plan construction and terminal/nonterminal classification.
- Modify: `src/app/core/services/sync/batch-sync.service.ts`
  - Moves simple branching into helpers while preserving `saveProjectToCloud`.

---

### Task 1: Add Code Health Baseline

**Files:**
- Create: `scripts/code-health-baseline.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write the baseline script**

Create `scripts/code-health-baseline.cjs`:

```javascript
#!/usr/bin/env node

const { execSync } = require('node:child_process');
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const ROOT = process.cwd();
const SOURCE_ROOTS = ['src'];
const EXTENSIONS = new Set(['.ts', '.html', '.scss', '.css']);
const DEFAULT_LIMIT = 25;
const ESLINT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function parseLimit() {
  const arg = process.argv.find(value => value.startsWith('--limit='));
  if (!arg) return DEFAULT_LIMIT;
  const value = Number(arg.slice('--limit='.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LIMIT;
}

function walkFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.angular', 'test-results', 'playwright-report'].includes(entry.name)) {
        walkFiles(fullPath, files);
      }
      continue;
    }

    if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function countLines(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/).length;
}

function collectFiles() {
  return SOURCE_ROOTS
    .filter(root => existsSync(path.join(ROOT, root)))
    .flatMap(root => walkFiles(path.join(ROOT, root)))
    .map(filePath => ({
      path: path.relative(ROOT, filePath).replaceAll(path.sep, '/'),
      lines: countLines(filePath),
      bytes: statSync(filePath).size,
    }))
    .sort((a, b) => b.lines - a.lines);
}

function collectLintSummary() {
  try {
    const output = execSync('npx eslint src --format json --no-warn-ignored', {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: ESLINT_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const reports = JSON.parse(output);
    return reports.reduce(
      (summary, report) => ({
        files: summary.files + 1,
        errors: summary.errors + report.errorCount,
        warnings: summary.warnings + report.warningCount,
        fixableErrors: summary.fixableErrors + report.fixableErrorCount,
        fixableWarnings: summary.fixableWarnings + report.fixableWarningCount,
      }),
      { files: 0, errors: 0, warnings: 0, fixableErrors: 0, fixableWarnings: 0 },
    );
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    if (!stdout.trim()) {
      return { files: 0, errors: -1, warnings: -1, fixableErrors: 0, fixableWarnings: 0 };
    }

    const reports = JSON.parse(stdout);
    return reports.reduce(
      (summary, report) => ({
        files: summary.files + 1,
        errors: summary.errors + report.errorCount,
        warnings: summary.warnings + report.warningCount,
        fixableErrors: summary.fixableErrors + report.fixableErrorCount,
        fixableWarnings: summary.fixableWarnings + report.fixableWarningCount,
      }),
      { files: 0, errors: 0, warnings: 0, fixableErrors: 0, fixableWarnings: 0 },
    );
  }
}

const limit = parseLimit();
const files = collectFiles();
const lint = collectLintSummary();
const over800 = files.filter(file => file.lines > 800).length;
const over1500 = files.filter(file => file.lines > 1500).length;

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    files: files.length,
    over800,
    over1500,
  },
  lint,
  largestFiles: files.slice(0, limit),
};

console.log(JSON.stringify(report, null, 2));
```

- [ ] **Step 2: Add the package script**

Modify `package.json` scripts:

```json
{
  "quality:baseline": "node scripts/code-health-baseline.cjs"
}
```

Keep all existing scripts unchanged.

- [ ] **Step 3: Run the baseline command**

Run:

```bash
npm run quality:baseline -- --limit=25
```

Expected:

```text
exit 0
JSON output includes totals.files, totals.over800, lint.errors, lint.warnings, largestFiles
```

- [ ] **Step 4: Verify existing quality gates still run**

Run:

```bash
npm run lint
npm run test:run:minimal
```

Expected:

```text
npm run lint exits 0
npm run test:run:minimal exits 0
```

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/code-health-baseline.cjs
git commit -m "chore: add code health baseline"
```

---

### Task 2: Extract Task Row Mapping

**Files:**
- Create: `src/app/core/services/sync/task-row.mapper.ts`
- Create: `src/app/core/services/sync/task-row.mapper.spec.ts`
- Modify: `src/app/core/services/sync/project-data.service.ts`

- [ ] **Step 1: Write mapper tests first**

Create `src/app/core/services/sync/task-row.mapper.spec.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { mapTaskRowToTask, type TaskRowMappingReporter } from './task-row.mapper';

describe('mapTaskRowToTask', () => {
  const reporter: TaskRowMappingReporter = {
    warnContentMissing: vi.fn(),
    captureContentMissing: vi.fn(),
  };

  it('maps persisted task fields without dropping content or planning metadata', () => {
    const task = mapTaskRowToTask({
      id: 'task-1',
      title: 'Title',
      content: 'Body',
      stage: 'today',
      parent_id: 'parent-1',
      order: 3,
      rank: 9,
      status: 'completed',
      x: 11,
      y: 22,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-02T00:00:00.000Z',
      completed_at: '2026-06-03T00:00:00.000Z',
      short_id: 'NF-1',
      deleted_at: null,
      attachments: [{ id: 'att-1' }],
      tags: ['deep-work'],
      priority: 'high',
      due_date: '2026-06-04',
      expected_minutes: 45,
      cognitive_load: 'high',
      wait_minutes: 5,
      parking_meta: { state: 'parked' },
      attention_meta: { version: 1 },
    }, reporter);

    expect(task).toMatchObject({
      id: 'task-1',
      title: 'Title',
      content: 'Body',
      stage: 'today',
      parentId: 'parent-1',
      order: 3,
      rank: 9,
      status: 'completed',
      x: 11,
      y: 22,
      createdDate: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
      completedAt: '2026-06-03T00:00:00.000Z',
      shortId: 'NF-1',
      expected_minutes: 45,
      cognitive_load: 'high',
      wait_minutes: 5,
    });
    expect(task.attachments).toHaveLength(1);
    expect(task.tags).toEqual(['deep-work']);
    expect(task.parkingMeta).toEqual({ state: 'parked' });
    expect(task.attentionMeta).toEqual({ version: 1 });
  });

  it('marks task content as source-missing when the row omits content', () => {
    const localReporter: TaskRowMappingReporter = {
      warnContentMissing: vi.fn(),
      captureContentMissing: vi.fn(),
    };

    const task = mapTaskRowToTask({
      id: 'task-missing-content',
      title: 'Title',
      updated_at: '2026-06-02T00:00:00.000Z',
    }, localReporter);

    expect(task.content).toBe('');
    expect(localReporter.warnContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-missing-content' }),
    );
    expect(localReporter.captureContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-missing-content' }),
    );
  });

  it('preserves numeric zero values instead of replacing them with defaults', () => {
    const task = mapTaskRowToTask({
      id: 'task-zero',
      content: '',
      order: 0,
      rank: 0,
      x: 0,
      y: 0,
      updated_at: '2026-06-02T00:00:00.000Z',
    }, reporter);

    expect(task.order).toBe(0);
    expect(task.rank).toBe(0);
    expect(task.x).toBe(0);
    expect(task.y).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npm run test:prepare-env
npx vitest run --config vitest.services.config.mts src/app/core/services/sync/task-row.mapper.spec.ts
```

Expected:

```text
FAIL because task-row.mapper.ts does not exist
```

- [ ] **Step 3: Implement the pure mapper**

Create `src/app/core/services/sync/task-row.mapper.ts`:

```typescript
import type { Attachment, Task, TaskAttentionMeta } from '../../../../models';
import type { TaskParkingMeta } from '../../../../models/parking';
import { markTaskContentMissingFromSource } from '../../../../utils/task-schema-compat';

export interface TaskRowLike {
  id?: string | null;
  title?: string | null;
  content?: string | null;
  stage?: string | null;
  parent_id?: string | null;
  order?: number | null;
  rank?: number | null;
  status?: string | null;
  x?: number | null;
  y?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  short_id?: string | null;
  deleted_at?: string | null;
  attachments?: unknown;
  tags?: unknown;
  priority?: string | null;
  due_date?: string | null;
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  parking_meta?: unknown;
  attention_meta?: unknown;
}

export interface TaskRowMappingReporter {
  warnContentMissing(details: { taskId: string | null | undefined; hasTitle: boolean; hasStage: boolean }): void;
  captureContentMissing(details: { taskId: string | null | undefined; rowKeys: string[] }): void;
}

function mapStatus(status: string | null | undefined): Task['status'] {
  return status === 'completed' || status === 'archived' ? status : 'active';
}

function mapPriority(priority: string | null | undefined): Task['priority'] {
  return priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'urgent'
    ? priority
    : undefined;
}

export function mapTaskRowToTask(row: TaskRowLike, reporter: TaskRowMappingReporter): Task {
  const contentMissingFromSource = !Object.prototype.hasOwnProperty.call(row, 'content')
    || row.content === undefined;

  if (contentMissingFromSource) {
    reporter.warnContentMissing({
      taskId: row.id,
      hasTitle: Object.prototype.hasOwnProperty.call(row, 'title'),
      hasStage: Object.prototype.hasOwnProperty.call(row, 'stage'),
    });
    reporter.captureContentMissing({ taskId: row.id, rowKeys: Object.keys(row) });
  }

  const task: Task = {
    id: row.id ?? '',
    title: row.title ?? '',
    content: row.content ?? '',
    stage: row.stage ?? null,
    parentId: row.parent_id ?? null,
    order: row.order ?? 0,
    rank: row.rank ?? 0,
    status: mapStatus(row.status),
    x: row.x ?? 0,
    y: row.y ?? 0,
    createdDate: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    completedAt: row.completed_at ?? null,
    displayId: '',
    shortId: row.short_id ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    attachments: (row.attachments as Attachment[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    priority: mapPriority(row.priority),
    dueDate: row.due_date ?? undefined,
    expected_minutes: row.expected_minutes ?? null,
    cognitive_load: row.cognitive_load ?? null,
    wait_minutes: row.wait_minutes ?? null,
    parkingMeta: row.parking_meta as TaskParkingMeta | undefined,
    attentionMeta: row.attention_meta as TaskAttentionMeta | undefined,
  };

  if (contentMissingFromSource) {
    markTaskContentMissingFromSource(task);
  }

  return task;
}
```

- [ ] **Step 4: Delegate `ProjectDataService.rowToTask`**

Modify `src/app/core/services/sync/project-data.service.ts`:

```typescript
import { mapTaskRowToTask } from './task-row.mapper';
```

Replace the method body with:

```typescript
rowToTask(row: TaskRow | Partial<TaskRow>): Task {
  return mapTaskRowToTask(row, {
    warnContentMissing: details => {
      this.logger.warn('rowToTask: content 字段缺失，可能导致数据丢失！', {
        taskId: details.taskId,
        hasTitle: details.hasTitle,
        hasStage: details.hasStage,
      });
    },
    captureContentMissing: details => {
      const isDev = typeof window !== 'undefined' && window.location?.hostname === 'localhost';
      if (isDev || Math.random() < 0.1) {
        this.sentryLazyLoader.captureMessage('Sync Warning: Task content field missing', {
          level: 'warning',
          tags: { operation: 'rowToTask', taskId: details.taskId || 'unknown' },
          extra: { rowKeys: details.rowKeys },
        });
      }
    },
  });
}
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npx vitest run --config vitest.services.config.mts src/app/core/services/sync/task-row.mapper.spec.ts src/app/core/services/sync/project-data.service.spec.ts
```

Expected:

```text
All selected test files pass
```

- [ ] **Step 6: Run minimal matrix**

Run:

```bash
npm run test:run:minimal
```

Expected:

```text
exit 0
```

- [ ] **Step 7: Commit**

```bash
git add src/app/core/services/sync/task-row.mapper.ts src/app/core/services/sync/task-row.mapper.spec.ts src/app/core/services/sync/project-data.service.ts
git commit -m "refactor(sync): extract task row mapper"
```

---

### Task 3: Extract RetryQueue Decision Helpers

**Files:**
- Create: `src/app/core/services/sync/retry-queue-processing.ts`
- Create: `src/app/core/services/sync/retry-queue-processing.spec.ts`
- Modify: `src/app/core/services/sync/retry-queue.service.ts`

- [ ] **Step 1: Write decision-helper tests first**

Create `src/app/core/services/sync/retry-queue-processing.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { classifyRetryAttempt, shouldProcessRetryQueue } from './retry-queue-processing';

describe('retry queue processing helpers', () => {
  it('blocks processing when the session is expired', () => {
    expect(shouldProcessRetryQueue({
      isProcessing: false,
      isOnline: true,
      sessionExpired: true,
      writeAllowed: true,
      hasHandler: true,
    })).toEqual({ allowed: false, reason: 'session-expired' });
  });

  it('blocks processing when the app is offline', () => {
    expect(shouldProcessRetryQueue({
      isProcessing: false,
      isOnline: false,
      sessionExpired: false,
      writeAllowed: true,
      hasHandler: true,
    })).toEqual({ allowed: false, reason: 'offline' });
  });

  it('allows processing only when queue dependencies are ready', () => {
    expect(shouldProcessRetryQueue({
      isProcessing: false,
      isOnline: true,
      sessionExpired: false,
      writeAllowed: true,
      hasHandler: true,
    })).toEqual({ allowed: true });
  });

  it('classifies browser network suspension as transient', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 1,
      maxRetries: 5,
      isPermanentFailure: false,
      isNetworkSuspended: true,
    })).toEqual({ kind: 'transient', nextRetryCount: 2 });
  });

  it('classifies permanent failures as terminal', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 1,
      maxRetries: 5,
      isPermanentFailure: true,
      isNetworkSuspended: false,
    })).toEqual({ kind: 'terminal' });
  });

  it('classifies exhausted retries as terminal', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 5,
      maxRetries: 5,
      isPermanentFailure: false,
      isNetworkSuspended: false,
    })).toEqual({ kind: 'terminal' });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run --config vitest.services.config.mts src/app/core/services/sync/retry-queue-processing.spec.ts
```

Expected:

```text
FAIL because retry-queue-processing.ts does not exist
```

- [ ] **Step 3: Implement pure helper module**

Create `src/app/core/services/sync/retry-queue-processing.ts`:

```typescript
export type RetryQueueBlockReason =
  | 'already-processing'
  | 'missing-handler'
  | 'offline'
  | 'session-expired'
  | 'write-blocked';

export interface RetryQueueProcessGate {
  isProcessing: boolean;
  isOnline: boolean;
  sessionExpired: boolean;
  writeAllowed: boolean;
  hasHandler: boolean;
}

export type RetryQueueProcessDecision =
  | { allowed: true }
  | { allowed: false; reason: RetryQueueBlockReason };

export function shouldProcessRetryQueue(gate: RetryQueueProcessGate): RetryQueueProcessDecision {
  if (gate.isProcessing) return { allowed: false, reason: 'already-processing' };
  if (!gate.hasHandler) return { allowed: false, reason: 'missing-handler' };
  if (!gate.isOnline) return { allowed: false, reason: 'offline' };
  if (gate.sessionExpired) return { allowed: false, reason: 'session-expired' };
  if (!gate.writeAllowed) return { allowed: false, reason: 'write-blocked' };
  return { allowed: true };
}

export interface RetryAttemptInput {
  success: boolean;
  retryCount: number;
  maxRetries: number;
  isPermanentFailure: boolean;
  isNetworkSuspended: boolean;
}

export type RetryAttemptClassification =
  | { kind: 'success' }
  | { kind: 'transient'; nextRetryCount: number }
  | { kind: 'terminal' };

export function classifyRetryAttempt(input: RetryAttemptInput): RetryAttemptClassification {
  if (input.success) return { kind: 'success' };
  if (input.isPermanentFailure) return { kind: 'terminal' };

  const nextRetryCount = input.retryCount + 1;
  if (nextRetryCount > input.maxRetries) return { kind: 'terminal' };

  return {
    kind: input.isNetworkSuspended ? 'transient' : 'transient',
    nextRetryCount,
  };
}
```

- [ ] **Step 4: Use helper in `RetryQueueService.processQueue` gate**

Modify `src/app/core/services/sync/retry-queue.service.ts`:

```typescript
import { classifyRetryAttempt, shouldProcessRetryQueue } from './retry-queue-processing';
```

At the beginning of the processing entry point, replace scattered guard returns with:

```typescript
const gateDecision = shouldProcessRetryQueue({
  isProcessing: this.processing,
  isOnline: this.operationHandler?.isOnline() ?? false,
  sessionExpired: this.operationHandler?.isSessionExpired() ?? false,
  writeAllowed: this.writeGuard?.canWriteCloud?.() ?? true,
  hasHandler: this.operationHandler !== null,
});

if (!gateDecision.allowed) {
  this.logger.debug('RetryQueue processing skipped', { reason: gateDecision.reason });
  return;
}
```

Keep existing log messages if tests assert exact output. If the class uses different property names, adapt only the property reads, not the helper API.

- [ ] **Step 5: Use helper for attempt classification inside `processQueueSlice`**

Around `src/app/core/services/sync/retry-queue.service.ts:1722`, after each operation result is known, use:

```typescript
const attempt = classifyRetryAttempt({
  success: operationSucceeded,
  retryCount: item.retryCount,
  maxRetries: this.MAX_RETRIES,
  isPermanentFailure: isPermanentFailureError(error),
  isNetworkSuspended: isBrowserNetworkSuspendedError(error),
});
```

Then map the existing behavior to the classification:

```typescript
if (attempt.kind === 'success') {
  // keep existing success removal and drain-flag behavior
} else if (attempt.kind === 'terminal') {
  // keep existing permanent failure cleanup, toast, Sentry, and dirty-marker cleanup behavior
} else {
  item.retryCount = attempt.nextRetryCount;
  // keep existing transient retry scheduling behavior
}
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npx vitest run --config vitest.services.config.mts src/app/core/services/sync/retry-queue-processing.spec.ts src/app/core/services/sync/retry-queue.service.spec.ts
```

Expected:

```text
All selected test files pass
```

- [ ] **Step 7: Run minimal matrix**

Run:

```bash
npm run test:run:minimal
```

Expected:

```text
exit 0
```

- [ ] **Step 8: Commit**

```bash
git add src/app/core/services/sync/retry-queue-processing.ts src/app/core/services/sync/retry-queue-processing.spec.ts src/app/core/services/sync/retry-queue.service.ts
git commit -m "refactor(sync): extract retry queue decisions"
```

---

### Task 4: Extract Save-Project Planning Helpers

**Files:**
- Create: `src/app/core/services/sync/project-save-plan.ts`
- Create: `src/app/core/services/sync/project-save-plan.spec.ts`
- Modify: `src/app/core/services/sync/batch-sync.service.ts`

- [ ] **Step 1: Write planning tests first**

Create `src/app/core/services/sync/project-save-plan.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildProjectSavePlan, classifyProjectSaveFailures } from './project-save-plan';

describe('project save planning', () => {
  it('keeps task and connection deletes separate from upserts', () => {
    const plan = buildProjectSavePlan({
      taskIds: ['t1', 't2'],
      connectionIds: ['c1'],
      taskIdsToDelete: ['t2', 't3'],
      connectionIdsToDelete: ['c2'],
    });

    expect(plan.taskUpsertIds).toEqual(['t1']);
    expect(plan.taskDeleteIds).toEqual(['t2', 't3']);
    expect(plan.connectionUpsertIds).toEqual(['c1']);
    expect(plan.connectionDeleteIds).toEqual(['c2']);
  });

  it('classifies all transient failures as retry handoff', () => {
    expect(classifyProjectSaveFailures({
      failedTaskIds: ['t1'],
      failedConnectionIds: [],
      terminalTaskIds: [],
      terminalConnectionIds: [],
    })).toEqual({
      terminal: false,
      partialRetryHandoff: true,
      failedTaskIds: ['t1'],
      failedConnectionIds: [],
    });
  });

  it('classifies terminal failures as terminal even when transient failures also exist', () => {
    expect(classifyProjectSaveFailures({
      failedTaskIds: ['t1'],
      failedConnectionIds: ['c1'],
      terminalTaskIds: ['t2'],
      terminalConnectionIds: [],
    })).toEqual({
      terminal: true,
      partialRetryHandoff: true,
      failedTaskIds: ['t1', 't2'],
      failedConnectionIds: ['c1'],
    });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run --config vitest.services.config.mts src/app/core/services/sync/project-save-plan.spec.ts
```

Expected:

```text
FAIL because project-save-plan.ts does not exist
```

- [ ] **Step 3: Implement planning helpers**

Create `src/app/core/services/sync/project-save-plan.ts`:

```typescript
export interface ProjectSavePlanInput {
  taskIds: string[];
  connectionIds: string[];
  taskIdsToDelete: string[];
  connectionIdsToDelete: string[];
}

export interface ProjectSavePlan {
  taskUpsertIds: string[];
  taskDeleteIds: string[];
  connectionUpsertIds: string[];
  connectionDeleteIds: string[];
}

export function buildProjectSavePlan(input: ProjectSavePlanInput): ProjectSavePlan {
  const taskDeleteIds = new Set(input.taskIdsToDelete);
  const connectionDeleteIds = new Set(input.connectionIdsToDelete);

  return {
    taskUpsertIds: input.taskIds.filter(id => !taskDeleteIds.has(id)),
    taskDeleteIds: [...taskDeleteIds],
    connectionUpsertIds: input.connectionIds.filter(id => !connectionDeleteIds.has(id)),
    connectionDeleteIds: [...connectionDeleteIds],
  };
}

export interface ProjectSaveFailureInput {
  failedTaskIds: string[];
  failedConnectionIds: string[];
  terminalTaskIds: string[];
  terminalConnectionIds: string[];
}

export interface ProjectSaveFailureClassification {
  terminal: boolean;
  partialRetryHandoff: boolean;
  failedTaskIds: string[];
  failedConnectionIds: string[];
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function classifyProjectSaveFailures(input: ProjectSaveFailureInput): ProjectSaveFailureClassification {
  const failedTaskIds = unique([...input.failedTaskIds, ...input.terminalTaskIds]);
  const failedConnectionIds = unique([...input.failedConnectionIds, ...input.terminalConnectionIds]);
  const terminal = input.terminalTaskIds.length > 0 || input.terminalConnectionIds.length > 0;

  return {
    terminal,
    partialRetryHandoff: failedTaskIds.length > 0 || failedConnectionIds.length > 0,
    failedTaskIds,
    failedConnectionIds,
  };
}
```

- [ ] **Step 4: Use helper inside `BatchSyncService.saveProjectToCloud`**

Modify `src/app/core/services/sync/batch-sync.service.ts`:

```typescript
import { buildProjectSavePlan, classifyProjectSaveFailures } from './project-save-plan';
```

Inside `saveProjectToCloud`, replace local array derivation for task and connection upserts/deletes with:

```typescript
const savePlan = buildProjectSavePlan({
  taskIds: project.tasks.map(task => task.id),
  connectionIds: project.connections.map(connection => connection.id),
  taskIdsToDelete: taskIdsToDelete ?? [],
  connectionIdsToDelete,
});
```

Use `savePlan.taskUpsertIds`, `savePlan.taskDeleteIds`, `savePlan.connectionUpsertIds`, and `savePlan.connectionDeleteIds` in the existing logic. Keep Supabase calls, RetryQueue enqueue behavior, and LWW conflict handling in the service.

For final result assembly, replace ad hoc terminal/partial flags with:

```typescript
const failureClassification = classifyProjectSaveFailures({
  failedTaskIds,
  failedConnectionIds,
  terminalTaskIds,
  terminalConnectionIds,
});
```

Use the classification fields in the existing returned `ProjectSaveResult`.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npx vitest run --config vitest.services.config.mts src/app/core/services/sync/project-save-plan.spec.ts src/app/core/services/sync/batch-sync.service.spec.ts
```

Expected:

```text
All selected test files pass
```

- [ ] **Step 6: Run minimal matrix**

Run:

```bash
npm run test:run:minimal
```

Expected:

```text
exit 0
```

- [ ] **Step 7: Commit**

```bash
git add src/app/core/services/sync/project-save-plan.ts src/app/core/services/sync/project-save-plan.spec.ts src/app/core/services/sync/batch-sync.service.ts
git commit -m "refactor(sync): extract project save planning"
```

---

### Task 5: Ratchet Health Targets

**Files:**
- Modify: `eslint.config.js`
- Modify: `scripts/code-health-baseline.cjs`

- [ ] **Step 1: Record current warning baseline**

Run:

```bash
npm run quality:baseline -- --limit=50 > tmp/code-health-baseline.json
```

Expected:

```text
exit 0
tmp/code-health-baseline.json exists and includes lint.warnings
```

- [ ] **Step 2: Add a warning ceiling option**

Modify `scripts/code-health-baseline.cjs`:

```javascript
function parseNumericOption(name) {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`));
  if (!arg) return null;
  const value = Number(arg.slice(name.length + 3));
  return Number.isFinite(value) ? value : null;
}
```

After `report` is created:

```javascript
const maxWarnings = parseNumericOption('max-warnings');
if (maxWarnings !== null && report.lint.warnings > maxWarnings) {
  console.error(`Code health warning ceiling exceeded: ${report.lint.warnings} > ${maxWarnings}`);
  process.exitCode = 1;
}
```

- [ ] **Step 3: Add a non-blocking script alias**

Modify `package.json`:

```json
{
  "quality:baseline:ratchet": "node scripts/code-health-baseline.cjs --max-warnings=509"
}
```

The starting value must match the latest measured warning count from Step 1, not a guessed number.

- [ ] **Step 4: Run the ratchet**

Run:

```bash
npm run quality:baseline:ratchet
```

Expected:

```text
exit 0 when warnings are at or below the recorded baseline
```

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/code-health-baseline.cjs
git commit -m "chore: add code health warning ratchet"
```

---

## Verification Matrix

Run after each task:

```bash
npm run lint
npm run test:run:minimal
```

Run before any PR or merge:

```bash
npm run test:run:verify
npm run build:dev
```

Run when sync behavior changes:

```bash
npx vitest run --config vitest.services.config.mts src/app/core/services/sync src/services/sync-rpc-client.service.spec.ts src/tests/contracts/*sync*.spec.ts
```

Run when Supabase migrations or RPC contracts change:

```bash
npm run test:contracts
npm run db:types
```

## Phase 1 Definition Of Done

- `quality:baseline` exists and reports file size plus lint health.
- `rowToTask` behavior is covered by pure mapper tests.
- RetryQueue processing has pure decision-helper tests.
- Project save planning has pure helper tests.
- `npm run lint` exits 0.
- `npm run test:run:minimal` exits 0.
- No public sync API names are removed.
- No user-owned dirty worktree changes are reverted.

## Follow-Up Plans

Create separate plans after Phase 1:

- `2026-06-08-shell-startup-health.md`: split `workspace-shell.component.ts` and `user-session.service.ts`.
- `2026-06-08-flow-gojs-health.md`: isolate GoJS lifecycle services and mobile fallback contracts.
- `2026-06-08-validation-type-health.md`: split `validation.ts`, `supabase-error.ts`, and generated type usage.
- `2026-06-08-sync-service-decomposition.md`: continue `retry-queue.service.ts`, `project-data.service.ts`, `task-sync-operations.service.ts`, and `connection-sync-operations.service.ts`.
