import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { processModulePreload } = require('../../../scripts/inject-modulepreload.cjs');

const tempRoots: string[] = [];

function writeFile(filepath: string, content: string): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
}

function createDistFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-modulepreload-'));
  const distDir = path.join(root, 'browser');
  tempRoots.push(root);

  writeFile(
    path.join(distDir, 'index.html'),
    `<!doctype html>
<html>
<head>
  <script>window.__NANOFLOW_BOOT_FLAGS__ = { STRICT_MODULEPRELOAD_V2: false };</script>
  <link rel="modulepreload" href="/old-preload.js">
</head>
<body>
  <script type="module" src="main-ABC123.js"></script>
</body>
</html>`,
  );

  writeFile(
    path.join(distDir, 'main-ABC123.js'),
    [
      'import("./chunk-shared.js");',
      'import("./chunk-text-view.js");',
      'import("./chunk-workspace.js");',
      'import("./chunk-flow-view.js");',
      '',
    ].join('\n'),
  );
  writeFile(path.join(distDir, 'chunk-shared.js'), 'export const SharedStartupDependency = true;');
  writeFile(path.join(distDir, 'chunk-text-view.js'), 'export const TextViewComponent = true;');
  writeFile(path.join(distDir, 'chunk-workspace.js'), 'export const WorkspaceShellComponent = true;');
  writeFile(path.join(distDir, 'chunk-flow-view.js'), 'export const FlowViewComponent = true;');

  return distDir;
}

describe('inject-modulepreload', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('omits route component chunks from injected critical preloads', () => {
    const distDir = createDistFixture();

    const result = processModulePreload({ distDir, maxCriticalPreloads: 10 });
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

    expect(result.selected).toEqual(['chunk-shared.js']);
    expect(html).toContain('/chunk-shared.js');
    expect(html).not.toContain('/chunk-text-view.js');
    expect(html).not.toContain('/chunk-workspace.js');
    expect(html).not.toContain('/chunk-flow-view.js');
    expect(html).not.toContain('/old-preload.js');
  });
});
