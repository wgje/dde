import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayQuerySourceFilteringSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, runOverlay, expectSpawnSuccess, tempRoots } = context;

  it('excludes local worktree mirrors from overlay relationships', () => {
    const root = makeFixture();
    writeFile(
      root,
      '.worktrees/merge-main-2/src/app/mirror.component.ts',
      [
        "import { Component } from '@angular/core';",
        '@Component({',
        "  selector: 'app-mirror',",
        "  template: 'mirror',",
        '})',
        'export class MirrorComponent {}',
        '',
      ].join('\n'),
    );
    const result = runOverlay(root);
    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    expect(overlay.angular.components.map((component: { file: string }) => component.file))
      .not.toContain('.worktrees/merge-main-2/src/app/mirror.component.ts');
  });

  it('excludes build output directories from JavaScript-family source indexing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-build-output-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/real-source.js',
      [
        'export function realSource() {',
        '  return "source";',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'android/app/build/reports/tests/report.js',
      [
        'export function buildReportArtifact() {',
        '  return "generated report";',
        '}',
        '',
      ].join('\n'),
    );
    const result = runOverlay(root);
    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    const files = overlay.typescript.files.map((file: { file: string }) => file.file);
    expect(files).toContain('src/real-source.js');
    expect(files).not.toContain('android/app/build/reports/tests/report.js');
    expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'realSource',
        filePath: 'src/real-source.js',
        language: 'javascript',
      }),
    ]));
    expect(overlay.graph.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'buildReportArtifact',
        filePath: 'android/app/build/reports/tests/report.js',
      }),
    ]));
  });
}
