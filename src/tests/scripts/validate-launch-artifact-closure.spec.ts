import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];

function writeFile(filepath: string, content: string): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
}

describe('validate-launch-artifact-closure', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires launch assets to exist in both ngsw urls and hashTable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-launch-closure-'));
    const distDir = path.join(root, 'browser');
    tempRoots.push(root);

    writeFile(path.join(distDir, 'launch.html'), `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="/styles-AAA.css">
  <link rel="modulepreload" href="/polyfills-BBB.js">
</head>
<body>
  <script type="module" src="/main-CCC.js"></script>
</body>
</html>`);

    writeFile(path.join(distDir, 'ngsw.json'), JSON.stringify({
      assetGroups: [
        {
          name: 'app-core',
          urls: ['/styles-AAA.css', '/polyfills-BBB.js', '/main-CCC.js'],
        },
      ],
      hashTable: {
        '/styles-AAA.css': 'hash-a',
        '/polyfills-BBB.js': 'hash-b',
        '/main-CCC.js': 'hash-c',
      },
    }));

    const { validateLaunchArtifactClosure } = require('../../../scripts/validate-launch-artifact-closure.cjs');
    const result = validateLaunchArtifactClosure({ distDir });

    expect(result.assets).toEqual(['/styles-AAA.css', '/polyfills-BBB.js', '/main-CCC.js']);
    expect(result.missing).toEqual([]);
  });
});
