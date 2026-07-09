import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readWorkspaceFile(filePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), filePath), 'utf8');
}

describe('run-test-matrix Vitest segment timeout contract', () => {
  it('bounds each spawned Vitest segment and cleans up timed-out child processes', () => {
    const source = readWorkspaceFile('scripts/run-test-matrix.cjs');

    expect(source).toContain('DEFAULT_VITEST_SEGMENT_TIMEOUT_MS');
    expect(source).toContain('NANOFLOW_TEST_MATRIX_VITEST_TIMEOUT_MS');
    expect(source).toContain('[test:run] vitest segment timed out after');
    expect(source).toContain("status: result.timedOut ? 'timed_out' : 'executed'");
    expect(source).toContain("child.kill('SIGTERM')");
    expect(source).toContain("child.kill('SIGKILL')");
  });
});
