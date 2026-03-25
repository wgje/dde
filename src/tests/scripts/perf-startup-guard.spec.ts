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
  <link rel="modulepreload" href="/chunk-text-view.js">
  <link rel="modulepreload" href="/chunk-shared.js">
</head>
<body></body>
</html>`,
  );
  writeFile(path.join(distDir, 'chunk-text-view.js'), 'export const TextViewComponent = true;');
  writeFile(path.join(distDir, 'chunk-shared.js'), 'export const SharedStartupDependency = true;');

  return distDir;
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
    const distDir = createDistFixture();
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

    expect(findForbiddenModulepreloadFiles({ indexHtml: html, distDir })).toEqual(['chunk-text-view.js']);
  });
});
