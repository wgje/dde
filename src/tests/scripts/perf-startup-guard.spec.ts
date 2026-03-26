import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { findForbiddenModulepreloadFiles } = require('../../../scripts/perf-startup-guard.cjs');

const tempRoots: string[] = [];

function writeFile(filepath: string, content: string): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
}

function createDistFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-startup-guard-'));
  const distDir = path.join(root, 'browser');
  tempRoots.push(root);

  writeFile(
    path.join(distDir, 'index.html'),
    `<!doctype html>
<html>
<head>
  <link rel="modulepreload" href="/main-ABC123.js">
  <link rel="modulepreload" href="/polyfills-XYZ999.js">
  <link rel="modulepreload" href="/chunk-text-view.js">
  <link rel="modulepreload" href="/chunk-shared.js">
</head>
<body></body>
</html>`,
  );
  writeFile(
    path.join(distDir, 'launch.html'),
    `<!doctype html>
<html>
<head>
  <link rel="modulepreload" href="/chunk-shared.js">
</head>
<body>
  <div>${'x'.repeat(4096)}</div>
  <script type="module" src="polyfills-XYZ999.js"></script>
  <script type="module" src="main-ABC123.js"></script>
</body>
</html>`,
  );
  writeFile(
    path.join(root, 'stats.json'),
    JSON.stringify({
      outputs: {
        'main-ABC123.js': {
          bytes: 20480,
          imports: [
            { kind: 'import-statement', path: 'chunk-shared.js' },
            { kind: 'import-statement', path: 'polyfills-XYZ999.js' },
          ],
          inputs: {
            'main.ts': { bytesInOutput: 1024 },
          },
        },
        'polyfills-XYZ999.js': {
          bytes: 8192,
          imports: [],
          inputs: {
            'polyfills.ts': { bytesInOutput: 512 },
          },
        },
        'chunk-shared.js': {
          bytes: 4096,
          imports: [],
          inputs: {
            'src/shared-startup.ts': { bytesInOutput: 256 },
          },
        },
        'chunk-workspace-shell.js': {
          bytes: 1024,
          imports: [],
          inputs: {
            'src/workspace-shell.component.ts': { bytesInOutput: 128 },
          },
        },
      },
    }),
  );
  writeFile(path.join(distDir, 'chunk-text-view.js'), 'export const TextViewComponent = true;');
  writeFile(path.join(distDir, 'chunk-shared.js'), 'export const SharedStartupDependency = true;');
  writeFile(path.join(distDir, 'main-ABC123.js'), 'export const main = true;');
  writeFile(path.join(distDir, 'polyfills-XYZ999.js'), 'export const polyfills = true;');

  return root;
}

describe('perf-startup-guard', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('flags route component chunks inside modulepreload tags', () => {
    const root = createDistFixture();
    const distDir = path.join(root, 'browser');
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

    expect(findForbiddenModulepreloadFiles({ indexHtml: html, distDir })).toEqual(['chunk-text-view.js']);
  });

  it('flags launch shell when main/polyfills preloads are missing', () => {
    const root = createDistFixture();
    const launchHtmlPath = path.join(root, 'browser', 'launch.html');
    const evaluateStartupGuard = require('../../../scripts/perf-startup-guard.cjs').evaluateStartupGuard;

    const result = evaluateStartupGuard({
      projectRoot: root,
      statsPath: path.join(root, 'stats.json'),
      indexHtmlPath: path.join(root, 'browser', 'index.html'),
      launchHtmlPath,
      launchHtmlMaxDiscoveryBytes: 2048,
    });

    expect(result.violations).toContain('launch.html 缺少 main 入口 modulepreload');
    expect(result.violations).toContain('launch.html 缺少 polyfills 入口 modulepreload');
    expect(result.violations.some((violation) => violation.startsWith('launch.html main 发现位置超限:'))).toBe(true);
  });
});
