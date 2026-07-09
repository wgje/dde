import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

describe('check-build-deterministic guard', () => {
  it('runs child builds with CI cache semantics', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'ci', 'check-build-deterministic.cjs'),
      'utf8',
    );

    expect(source).toContain('const DETERMINISTIC_BUILD_ENV = {');
    expect(source).toContain("CI: 'true'");
    expect(source).toContain('env: DETERMINISTIC_BUILD_ENV');
  });
});
