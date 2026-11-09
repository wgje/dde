import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'code-health-baseline.cjs');
const tempRoots: string[] = [];

function makeFixture(options: { broken?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-code-health-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', options.broken ? 'broken.ts' : 'ok.ts'),
    options.broken ? 'const unused = 1;\n' : 'export const ok = 1;\n',
  );
  fs.writeFileSync(
    path.join(root, 'eslint.config.js'),
    [
      'export default [',
      '  {',
      "    files: ['src/**/*.ts'],",
      "    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },",
      "    rules: { 'no-unused-vars': 'error' },",
      '  },',
      '];',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  return root;
}

function runCodeHealth(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf-8',
  });
}

function writeLineFixture(root: string, relativePath: string, lineCount: number): void {
  const lines = Array.from(
    { length: lineCount },
    (_value, index) => `// fixture line ${index + 1}`,
  );
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'));
}

describe('code-health-baseline', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the ratchet when ESLint reports errors', () => {
    const root = makeFixture({ broken: true });

    const result = runCodeHealth(root, ['--max-warnings=999']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Code health lint errors found');
  }, 15_000);

  it('fails the ratchet when over800 file count exceeds the ceiling', () => {
    const root = makeFixture();
    writeLineFixture(root, 'src/large.ts', 801);

    const result = runCodeHealth(root, ['--max-over800=0', '--max-warnings=999']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Code health over800 ceiling exceeded: 1 > 0');
  }, 15_000);

  it('fails the ratchet when over1500 file count exceeds the ceiling', () => {
    const root = makeFixture();
    writeLineFixture(root, 'src/huge.ts', 1501);

    const result = runCodeHealth(root, ['--max-over1500=0', '--max-warnings=999']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Code health over1500 ceiling exceeded: 1 > 0');
  }, 15_000);

  it('excludes Supabase CLI generated database types from line-count ratchets', () => {
    const root = makeFixture();
    writeLineFixture(root, 'src/types/supabase.ts', 1501);

    const result = runCodeHealth(root, [
      '--max-over800=0',
      '--max-over1500=0',
      '--max-warnings=999',
    ]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.totals.over800).toBe(0);
    expect(report.totals.over1500).toBe(0);
    expect(report.largestFiles).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/types/supabase.ts' }),
      ]),
    );
  }, 15_000);
});
