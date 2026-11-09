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
  'check-retryqueue-durable-add.cjs',
);
const tempRoots: string[] = [];

function createFixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-retryqueue-guard-'));
  tempRoots.push(root);
  writeFixtureFile(
    root,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'CommonJS',
        strict: true,
        target: 'ES2022',
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFixtureFile(
    root,
    'src/app/core/services/sync/retry-queue.service.ts',
    `
export class RetryQueueService {
  add(..._args: unknown[]): boolean { return true; }
  async addDurably(..._args: unknown[]): Promise<boolean> { return true; }
}
`,
  );
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

describe('check-retryqueue-durable-add', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks production code that calls RetryQueueService.add directly without flagging Set.add', () => {
    const root = createFixtureRoot();
    writeFixtureFile(
      root,
      'src/app/features/tasks/task-retry.service.ts',
      `
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';

export class TaskRetryService {
  constructor(private readonly retryQueue: RetryQueueService) {}

  queueTask(): void {
    new Set<string>().add('safe-set-call');
    this.retryQueue.add('task', 'upsert', { id: 'task-1' });
  }
}
`,
    );

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task-retry.service.ts');
    expect(result.stderr).toContain('addDurably');
    expect(result.stderr).not.toContain('safe-set-call');
  });

  it("blocks RetryQueueService.add through a Pick alias without flagging ordinary structural add types", () => {
    const root = createFixtureRoot();
    writeFixtureFile(
      root,
      'src/app/features/tasks/picked-task-retry.service.ts',
      `
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';

type RetryQueueAddOnly = Pick<RetryQueueService, 'add'>;
type LocalAdder = { add(value: string): boolean };

export function queueTask(retryQueue: RetryQueueAddOnly, localAdder: LocalAdder): void {
  new Set<string>().add('safe-set-call');
  localAdder.add('safe-structural-call');
  retryQueue.add('task', 'upsert', { id: 'task-1' });
}
`,
    );

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('picked-task-retry.service.ts');
    expect(result.stderr).toContain("retryQueue.add('task', 'upsert'");
    expect(result.stderr).not.toContain('safe-set-call');
    expect(result.stderr).not.toContain('safe-structural-call');
  });

  it("allows an adapter add property whose signature comes from RetryQueueService.addDurably", () => {
    const root = createFixtureRoot();
    writeFixtureFile(
      root,
      'src/app/features/tasks/durable-task-retry-adapter.ts',
      `
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';

type DurableAdapter = { add: RetryQueueService['addDurably'] };

export async function queueTask(adapter: DurableAdapter): Promise<void> {
  await adapter.add('task', 'upsert', { id: 'task-1' });
}
`,
    );

    const result = runGuard(root);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[quality:guard:retryqueue-durable-add] passed');
  });

  it('allows durable RetryQueue calls and test-only compatibility calls', () => {
    const root = createFixtureRoot();
    writeFixtureFile(
      root,
      'src/app/features/tasks/task-retry.service.ts',
      `
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';

export class TaskRetryService {
  constructor(private readonly retryQueue: RetryQueueService) {}

  async queueTask(): Promise<void> {
    await this.retryQueue.addDurably('task', 'upsert', { id: 'task-1' });
    new Set<string>().add('still-safe');
  }
}
`,
    );
    writeFixtureFile(
      root,
      'src/app/core/services/sync/retry-queue.service.spec.ts',
      `
import { RetryQueueService } from './retry-queue.service';

export function coverCompatibility(service: RetryQueueService): void {
  service.add('task', 'upsert', { id: 'task-1' });
}
`,
    );

    const result = runGuard(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed');
  });
});
