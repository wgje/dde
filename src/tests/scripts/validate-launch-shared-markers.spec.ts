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

describe('validate-launch-shared-markers', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts well-formed marker pairs and generated shell ordering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-launch-markers-'));
    const distDir = path.join(root, 'dist', 'browser');
    tempRoots.push(root);

    const sourceHtml = `<!doctype html>
<html>
<head>
  <!-- LAUNCH_SHARED_HEAD_START --><meta charset="utf-8"><!-- LAUNCH_SHARED_HEAD_END -->
  <!-- LAUNCH_SHARED_STYLES_START --><style></style><!-- LAUNCH_SHARED_STYLES_END -->
</head>
<body>
  <!-- LAUNCH_SHARED_SHELL_START --><div id="snapshot-shell"></div><!-- LAUNCH_SHARED_SHELL_END -->
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_START --><script>window.__NANOFLOW_LAUNCH_SNAPSHOT__ = {};</script><!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_END -->
  <!-- LAUNCH_SHARED_BOOT_FLAGS_START --><script>window.__NANOFLOW_BOOT_FLAGS__ = {};</script><!-- LAUNCH_SHARED_BOOT_FLAGS_END -->
  <!-- LAUNCH_SHARED_LOADER_DISMISS_START --><script>window.addEventListener('nanoflow:boot-stage', function() {});</script><!-- LAUNCH_SHARED_LOADER_DISMISS_END -->
</body>
</html>`;

    const distHtml = `<!doctype html>
<html>
<head>
  <script>window.__NANOFLOW_BOOT_FLAGS__ = {};</script>
</head>
<body>
  <div id="snapshot-shell"></div>
  <script>window.addEventListener('nanoflow:boot-stage', function() {});</script>
  <script type="module" src="polyfills-AAA.js"></script>
  <script type="module" src="main-BBB.js"></script>
</body>
</html>`;

    writeFile(path.join(root, 'index.html'), sourceHtml);
    writeFile(path.join(distDir, 'index.html'), distHtml);
    writeFile(path.join(distDir, 'launch.html'), distHtml);

    const { validateLaunchSharedMarkers } = require('../../../scripts/validate-launch-shared-markers.cjs');
    const result = validateLaunchSharedMarkers({
      indexHtmlPath: path.join(root, 'index.html'),
      distIndexHtmlPath: path.join(distDir, 'index.html'),
      distLaunchHtmlPath: path.join(distDir, 'launch.html'),
    });

    expect(result.violations).toEqual([]);
  });
});
