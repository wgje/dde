import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];
const scriptPath = path.resolve(process.cwd(), 'scripts/update-test-quarantine.cjs');

interface QuarantinePayload {
  files: string[];
  entries: Array<{ file: string; reason: string; p95Ms?: number }>;
  sources?: { seedFilesPinned?: string[] };
}

function writeJson(filepath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(value, null, 2));
}

function createFixtureRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function readQuarantine(root: string): QuarantinePayload {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'scripts', 'test-quarantine.json'), 'utf8'),
  ) as QuarantinePayload;
}

function runQuarantineUpdate(root: string): void {
  execFileSync(
    process.execPath,
    [
      scriptPath,
      '--quarantine',
      'scripts/test-quarantine.json',
      '--vitest-report',
      'test-results/vitest-reports/vitest-report-current.json',
      '--recovery-days',
      '1',
    ],
    {
      cwd: root,
      stdio: 'pipe',
    },
  );
}

describe('update-test-quarantine', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('does not pin historical quarantine files without current slow or failed evidence', () => {
    const root = createFixtureRoot('nanoflow-quarantine-clean-');

    writeJson(path.join(root, 'scripts', 'test-quarantine.json'), { files: [], entries: [] });
    writeJson(path.join(root, 'test-results', 'vitest-reports', 'vitest-report-current.json'), {
      testResults: [
        {
          name: path.join(root, 'src/services/user-session.service.spec.ts'),
          duration: 500,
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
      ],
    });

    runQuarantineUpdate(root);
    const quarantine = readQuarantine(root);

    expect(quarantine.files).toEqual([]);
    expect(quarantine.entries).toEqual([]);
    expect(quarantine.sources?.seedFilesPinned).toEqual([]);
  });

  it('does not quarantine a file from a single slow sample', () => {
    const root = createFixtureRoot('nanoflow-quarantine-slow-');

    writeJson(path.join(root, 'scripts', 'test-quarantine.json'), { files: [], entries: [] });
    writeJson(path.join(root, 'test-results', 'vitest-reports', 'vitest-report-current.json'), {
      testResults: [
        {
          name: path.join(root, 'src/services/slow.service.spec.ts'),
          duration: 1300,
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
      ],
    });

    runQuarantineUpdate(root);
    const quarantine = readQuarantine(root);

    expect(quarantine.files).toEqual([]);
    expect(quarantine.entries).toEqual([]);
  });

  it('still flags files whose repeated p95 exceeds the quarantine threshold', () => {
    const root = createFixtureRoot('nanoflow-quarantine-repeated-slow-');

    writeJson(path.join(root, 'scripts', 'test-quarantine.json'), { files: [], entries: [] });
    writeJson(path.join(root, 'test-results', 'vitest-reports', 'vitest-report-current.json'), {
      testResults: [
        {
          name: path.join(root, 'src/services/slow.service.spec.ts'),
          duration: 1300,
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
        {
          name: path.join(root, 'src/services/slow.service.spec.ts'),
          duration: 1400,
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
        {
          name: path.join(root, 'src/services/slow.service.spec.ts'),
          duration: 1500,
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
      ],
    });

    runQuarantineUpdate(root);
    const quarantine = readQuarantine(root);

    expect(quarantine.files).toEqual(['src/services/slow.service.spec.ts']);
    expect(quarantine.entries).toEqual([
      expect.objectContaining({
        file: 'src/services/slow.service.spec.ts',
        reason: 'p95>1200ms',
        p95Ms: 1490,
      }),
    ]);
  });
});
