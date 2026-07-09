import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { writeTextFileIfChanged } = require('../../../scripts/write-file-if-changed.cjs') as {
  writeTextFileIfChanged: (filePath: string, content: string) => boolean;
};

describe('writeTextFileIfChanged', () => {
  it('does not refresh mtime when content is already identical', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-write-if-changed-'));
    const target = path.join(tempDir, 'nested', 'env.ts');

    try {
      expect(writeTextFileIfChanged(target, 'stable content\n')).toBe(true);

      const pinnedTime = new Date(Date.now() - 60_000);
      fs.utimesSync(target, pinnedTime, pinnedTime);
      const before = fs.statSync(target).mtimeMs;

      expect(writeTextFileIfChanged(target, 'stable content\n')).toBe(false);
      expect(fs.statSync(target).mtimeMs).toBe(before);

      expect(writeTextFileIfChanged(target, 'next content\n')).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('next content\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
