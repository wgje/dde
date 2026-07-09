import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function readRetryQueueRunnerSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/services/sync/retry-queue-runner.service.ts'),
    'utf8',
  );
}

function readMethod(source: string, name: string): string {
  const methodStart = [
    `protected async ${name}(`,
    `protected ${name}(`,
    `private async ${name}(`,
    `private ${name}(`,
  ]
    .map(signature => source.indexOf(signature))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  expect(methodStart).toBeGreaterThanOrEqual(0);

  const bodyStart = source.indexOf('{', methodStart);
  expect(bodyStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return source.slice(methodStart, index + 1);
    }
  }

  throw new Error(`Unable to read method ${name}`);
}

describe('RetryQueueRunnerLayer source boundaries', () => {
  it('keeps retry queue runner under the file-size ratchet ceiling', () => {
    const source = readRetryQueueRunnerSource();
    const lineCount = source.split(/\r?\n/).length;

    expect(lineCount).toBeLessThanOrEqual(800);
  });

  it('keeps prepareQueueSlice below the max-lines-per-function lint budget', () => {
    const source = readRetryQueueRunnerSource();
    const method = readMethod(source, 'prepareQueueSlice');
    const lineCount = method.split(/\r?\n/).length;

    expect(lineCount).toBeLessThanOrEqual(50);
    expect(method).toContain('createPreparedQueueSliceRuntime(');
  });

  it('routes processing-state callback failures through a logger-safe warn boundary', () => {
    const source = readRetryQueueRunnerSource();
    const syncStartMethod = readMethod(source, 'notifyQueueSliceSyncStart');
    const warnMethod = readMethod(source, 'warn');

    expect(syncStartMethod).toContain(
      "this.warn('onProcessingStateChange(true) 回调失败', error);",
    );
    expect(warnMethod).toContain('this.logger.warn(message, data);');
    expect(warnMethod).toContain('catch {');
  });
});
