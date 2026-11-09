import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const scriptPath = path.join(
  projectRoot,
  'scripts',
  'contracts',
  'check-actionqueue-durable-enqueue.cjs',
);
const tempRoots: string[] = [];

function createFixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-actionqueue-guard-'));
  tempRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, source: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function runGuard(root: string) {
  return spawnSync(process.execPath, [scriptPath, `--root=${root}`], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('check-actionqueue-durable-enqueue', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks production code that calls synchronous ActionQueue enqueue directly', () => {
    const root = createFixtureRoot();
    writeFixtureFile(
      root,
      'src/app/features/tasks/task-save.service.ts',
      `
export class TaskSaveService {
  constructor(private readonly actionQueue: ActionQueueService) {}

  saveTask() {
    this.actionQueue.enqueue({
      type: 'create',
      entityType: 'task',
      entityId: 'task-1',
    });
  }
}
`,
    );

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task-save.service.ts');
    expect(result.stderr).toContain('enqueueDurably');
  });

  it('allows durable enqueue APIs and ignores test-only compatibility calls', () => {
    const root = createFixtureRoot();
    writeFixtureFile(
      root,
      'src/app/features/tasks/task-save.service.ts',
      `
export class TaskSaveService {
  async saveTask() {
    await this.actionQueue.enqueueDurably({ type: 'create' });
    await this.actionQueue.enqueueManyDurably([{ type: 'update' }]);
  }
}
`,
    );
    writeFixtureFile(
      root,
      'src/services/action-queue.service.ts',
      `
export class ActionQueueService {
  enqueue(action: EnqueueParams): string {
    return this.enqueueInternal(action, true, true);
  }
}
`,
    );
    writeFixtureFile(
      root,
      'src/services/action-queue.service.spec.ts',
      `
it('keeps the compatibility API covered', () => {
  service.enqueue({ type: 'create' });
});
`,
    );
    writeFixtureFile(
      root,
      'src/services/action-queue-service-test-harness.spec-helpers.ts',
      `
export function enqueueForHarness(service: ActionQueueService) {
  service.enqueue({ type: 'create' });
}
`,
    );

    const result = runGuard(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed');
  });
});
