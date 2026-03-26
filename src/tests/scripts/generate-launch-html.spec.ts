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

function createFixture(): { root: string; distDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-launch-html-'));
  const distDir = path.join(root, 'browser');
  tempRoots.push(root);

  writeFile(
    path.join(distDir, 'index.html'),
    `<!doctype html>
<html>
<head>
  <!-- LAUNCH_SHARED_HEAD_START -->
  <meta charset="utf-8">
  <!-- LAUNCH_SHARED_HEAD_END -->
  <!-- LAUNCH_SHARED_BOOT_FLAGS_START -->
  <script>window.__NANOFLOW_BOOT_FLAGS__ = { STRICT_MODULEPRELOAD_V2: false };</script>
  <!-- LAUNCH_SHARED_BOOT_FLAGS_END -->
</head>
<body>
  <!-- LAUNCH_SHARED_SHELL_START -->
  <div id="initial-loader"><div id="snapshot-shell"></div></div>
  <!-- LAUNCH_SHARED_SHELL_END -->
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_START -->
  <script>window.__SNAPSHOT_RENDERER__ = true;</script>
  <!-- LAUNCH_SHARED_SNAPSHOT_RENDERER_END -->
  <!-- LAUNCH_SHARED_PREWARM_START -->
  <script>window.__NANOFLOW_SESSION_PREWARM__ = { status: 'idle' };</script>
  <!-- LAUNCH_SHARED_PREWARM_END -->
  <app-root></app-root>
  <!-- LAUNCH_SHARED_LOADER_DISMISS_START -->
  <script>window.__LOADER_DISMISS__ = true;</script>
  <!-- LAUNCH_SHARED_LOADER_DISMISS_END -->
  <script src="polyfills-XYZ999.js" type="module"></script>
  <script src="main-ABC123.js" type="module"></script>
</body>
</html>`,
  );
  writeFile(path.join(root, 'public', 'launch.html'), '<!doctype html><html><head></head><body></body></html>');

  return { root, distDir };
}

describe('generate-launch-html', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('generates a narrow launch shell from shared index.html blocks', () => {
    const { root, distDir } = createFixture();
    const { generateLaunchHtml } = require('../../../scripts/generate-launch-html.cjs');

    generateLaunchHtml({
      distDir,
      templatePath: path.join(root, 'public', 'launch.html'),
    });

    const launchHtml = fs.readFileSync(path.join(distDir, 'launch.html'), 'utf8');

    expect(launchHtml).toContain('<meta charset="utf-8">');
    expect(launchHtml).toContain('__NANOFLOW_BOOT_FLAGS__');
    expect(launchHtml).toContain('snapshot-shell');
    expect(launchHtml).toContain('__SNAPSHOT_RENDERER__');
    expect(launchHtml).toContain('__LOADER_DISMISS__');
    expect(launchHtml).toContain('polyfills-XYZ999.js');
    expect(launchHtml).toContain('main-ABC123.js');
    expect(launchHtml).not.toContain('__NANOFLOW_SESSION_PREWARM__');
  });
});
