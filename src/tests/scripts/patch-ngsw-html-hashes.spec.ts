import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const tempRoots: string[] = [];

function writeFile(filepath: string, content: string): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
}

function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-ngsw-hashes-'));
  const distDir = path.join(root, 'browser');
  tempRoots.push(root);

  writeFile(path.join(distDir, 'index.html'), '<!doctype html><html><body>index</body></html>');
  writeFile(path.join(distDir, 'launch.html'), '<!doctype html><html><body>launch</body></html>');
  writeFile(
    path.join(distDir, 'ngsw.json'),
    JSON.stringify({
      hashTable: {
        '/index.html': 'stale-index',
      },
      assetGroups: [
        {
          name: 'app-core',
          urls: ['/index.html', '/launch.html'],
        },
      ],
    }),
  );

  return distDir;
}

describe('patch-ngsw-html-hashes', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('recomputes ngsw.json hashes for index.html and launch.html', () => {
    const distDir = createFixture();
    const { patchNgswHtmlHashes } = require('../../../scripts/patch-ngsw-html-hashes.cjs');

    patchNgswHtmlHashes({ distDir, htmlFiles: ['index.html', 'launch.html'] });

    const ngsw = JSON.parse(fs.readFileSync(path.join(distDir, 'ngsw.json'), 'utf8'));
    expect(ngsw.hashTable['/index.html']).toBe(sha1('<!doctype html><html><body>index</body></html>'));
    expect(ngsw.hashTable['/launch.html']).toBe(sha1('<!doctype html><html><body>launch</body></html>'));
  });
});
