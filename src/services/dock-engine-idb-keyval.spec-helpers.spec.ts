import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('dock engine idb-keyval spec helpers', () => {
  it('keeps idb-keyval reset plumbing outside the dock engine spec body', () => {
    const source = readFileSync(
      join(__dirname, 'dock-engine.service.spec.ts'),
      'utf8',
    );

    expect(source).toContain('resetDockEngineIdbKeyvalMocks');
    expect(source).not.toContain('vi.mocked(idbKeyval.clear).mockReset()');
    expect(source).not.toContain('vi.mocked(idbKeyval.update).mockImplementation');
  });
});
