import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const prefix = 'src/tests/fixtures/codegraph-callback-release-8362b0e0';
const policy = require('../../../scripts/lib/codegraph-source-policy.cjs') as {
  classifySourcePath(path: string): string | null;
  listSourcePolicyFiles(root: string): Array<{ path: string; role: string }>;
};
const fixture = JSON.parse(fs.readFileSync(path.join(root, prefix, 'manifest.json'), 'utf8')) as {
  files: Array<{ sourcePath: string; file: string }>;
};
describe('frozen callback oracle source boundary', () => {
  it('stores historical sources as non-source artifacts while keeping logical analyzer identities', () => {
    expect(fixture.files).toHaveLength(9);
    for (const entry of fixture.files) {
      expect(entry.file).toBe(entry.sourcePath + '.fixture');
      expect(fs.existsSync(path.join(root, prefix, entry.sourcePath))).toBe(false);
      expect(fs.existsSync(path.join(root, prefix, entry.file))).toBe(true);
      expect(policy.classifySourcePath(prefix + '/' + entry.file)).toBeNull();
      expect(policy.classifySourcePath(entry.sourcePath)).toBe('javascript');
    }
  });
  it('excludes only frozen artifacts from the actual source enumeration, not current execution or worker fixtures', () => {
    const paths = new Set(policy.listSourcePolicyFiles(root).map(entry => entry.path));
    expect([...paths].filter(source => source.startsWith(prefix + '/'))).toEqual([]);
    for (const entry of fixture.files) expect(paths.has(entry.sourcePath)).toBe(true);
    expect(paths.has('src/tests/fixtures/agent-file-lease-worker.cjs')).toBe(true);
  });
});
