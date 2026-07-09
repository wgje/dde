import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('CodeGraph overlay policy data query helper source boundary', () => {
  it('keeps the primary policy-data query helper split into focused files', () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        'src/tests/scripts/codegraph-nanoflow-overlay-query-policies-data.spec-helpers.ts',
      ),
      'utf8',
    );

    expect(source.split(/\r?\n/).length).toBeLessThan(700);
  });
});
