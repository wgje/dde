import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayQueryLatencySpecs(context: CodegraphOverlaySpecContext): void {
  const {
    makeFixture,
    writeFile,
    expectSpawnSuccess,
    repoRoot,
    scriptPath,
    queryScriptPath,
    parseJsonLinesFromText,
  } = context;

  it('can skip synchronous stale overlay refreshes for latency-sensitive MCP queries', () => {
    const root = makeFixture();
    const generateResult = spawnSync(process.execPath, [scriptPath, '--root', root], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expectSpawnSuccess(generateResult);

    writeFile(
      root,
      'src/app/features/sample/stale-overlay-skipped.ts',
      [
        'export class StaleOverlaySkippedClass {}',
        '',
      ].join('\n'),
    );

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'StaleOverlaySkippedClass',
      '--context-json',
      '--skip-refresh',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual([]);
    expect(response.nodes).toEqual([]);
  });

  it('treats compact context JSON queries as latency-sensitive even without an explicit skip flag', () => {
    const root = makeFixture();
    const generateResult = spawnSync(process.execPath, [scriptPath, '--root', root], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expectSpawnSuccess(generateResult);

    const newSourcePath = path.join(root, 'src/app/features/sample/context-json-stale.ts');
    writeFile(
      root,
      'src/app/features/sample/context-json-stale.ts',
      [
        'export class ContextJsonStaleClass {}',
        '',
      ].join('\n'),
    );
    const futureMtime = new Date(Date.now() + 2000);
    fs.utimesSync(newSourcePath, futureMtime, futureMtime);

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'ContextJsonStaleClass',
      '--context-json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual([]);
    expect(response.nodes).toEqual([]);
  });

  it('profiles overlay file reads and JSON parse separately for timeout diagnosis', () => {
    const root = makeFixture();
    const generateResult = spawnSync(process.execPath, [scriptPath, '--root', root], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expectSpawnSuccess(generateResult);

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleService',
      '--context-json',
      '--skip-refresh',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        NANOFLOW_OVERLAY_QUERY_PROFILE: '1',
      },
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    const profiles = parseJsonLinesFromText(result.stderr);
    expect(profiles).toContainEqual(expect.objectContaining({
      event: 'nanoflow.overlay.profile.meta',
      pid: expect.any(Number),
      root,
      overlayPath: path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      query: 'SampleService',
      limit: 20,
      skipRefresh: true,
      contextJson: true,
      json: true,
      nativeJson: false,
      nativeMarkdown: false,
    }));
    expect(profiles).toContainEqual(expect.objectContaining({
      event: 'nanoflow.overlay.profile',
      phase: 'readOverlayFile',
      elapsedMs: expect.any(Number),
    }));
    expect(profiles).toContainEqual(expect.objectContaining({
      event: 'nanoflow.overlay.profile',
      phase: 'parseOverlayJson',
      elapsedMs: expect.any(Number),
    }));
  });

  it('refreshes stale overlay files before querying newly added source symbols', () => {
    const root = makeFixture();
    const generateResult = spawnSync(process.execPath, [scriptPath, '--root', root], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expectSpawnSuccess(generateResult);

    const newSourcePath = path.join(root, 'src/app/features/sample/stale-overlay-fresh.ts');
    writeFile(
      root,
      'src/app/features/sample/stale-overlay-fresh.ts',
      [
        'export class StaleOverlayFreshClass {',
        '  run(): string { return "fresh"; }',
        '}',
        '',
      ].join('\n'),
    );
    const futureMtime = new Date(Date.now() + 2000);
    fs.utimesSync(newSourcePath, futureMtime, futureMtime);

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'StaleOverlayFreshClass',
      '--json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'StaleOverlayFreshClass',
        filePath: 'src/app/features/sample/stale-overlay-fresh.ts',
      }),
    ]));
  }, 10_000);
}
