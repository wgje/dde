import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

const OVERLAY_OUTPUT_MODES = [
  { label: 'Markdown', args: [] },
  { label: 'JSON', args: ['--json'] },
  { label: 'context JSON', args: ['--context-json'] },
  { label: 'native JSON', args: ['--native-json'] },
  { label: 'native Markdown', args: ['--native-markdown'] },
] as const;

function overlayQueryEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NANOFLOW_OVERLAY_SKIP_REFRESH') delete env[key];
  }
  return { ...env, ...overrides };
}

export function registerCodegraphOverlayQueryLatencySpecs(context: CodegraphOverlaySpecContext): void {
  const {
    makeFixture,
    writeFile,
    expectSpawnSuccess,
    queryOverlay,
    repoRoot,
    parseJsonLinesFromText,
  } = context;
  const currentQueryScriptPath = path.join(repoRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');

  it('keeps skip-refresh as a CURRENT-only compatibility no-op without regenerating', () => {
    const root = makeFixture();
    expectSpawnSuccess(queryOverlay(root, 'SampleService'));
    const generationRoot = path.join(root, '.codegraph', 'nanoflow-generations');
    const currentPath = path.join(generationRoot, 'CURRENT.json');
    const currentBytes = fs.readFileSync(currentPath);
    const generationEntries = fs.readdirSync(generationRoot).sort();
    writeFile(
      root,
      'src/app/features/sample/stale-overlay-skipped.ts',
      [
        'export class StaleOverlaySkippedClass {}',
        '',
      ].join('\n'),
    );

    const cases = [
      ...OVERLAY_OUTPUT_MODES.map(mode => ({ ...mode, args: [...mode.args, '--skip-refresh'] })),
      { label: 'implicit context JSON', args: ['--context-json'] },
      { label: 'environment skip', args: ['--json'], env: { NANOFLOW_OVERLAY_SKIP_REFRESH: '1' } },
    ];
    for (const testCase of cases) {
      const result = spawnSync(process.execPath, [
        currentQueryScriptPath,
        '--root', root,
        '--query', 'StaleOverlaySkippedClass',
        ...testCase.args,
      ], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: overlayQueryEnv({ NANOFLOW_OVERLAY_QUERY_PROFILE: '1', ...testCase.env }),
        maxBuffer: 32 * 1024 * 1024,
      });

      expectSpawnSuccess(result);
      const phases = parseJsonLinesFromText(result.stderr)
        .filter(entry => entry.event === 'nanoflow.overlay.profile')
        .map(entry => entry.phase);
      expect(phases.filter(phase => phase === 'readOverlayCurrentReceipt'), testCase.label).toHaveLength(1);
      expect(phases, testCase.label).not.toContain('checkOverlayFreshness');
      expect(phases.some(phase => String(phase).startsWith('ensureOverlay:')), testCase.label).toBe(false);
      expect(phases).toContain('queryOverlay');
    }
    expect(fs.readFileSync(currentPath)).toEqual(currentBytes);
    expect(fs.readdirSync(generationRoot).sort()).toEqual(generationEntries);
    expect(fs.existsSync(path.join(root, '.codegraph', 'nanoflow-overlay.json'))).toBe(false);
  }, 30_000);

  it('keeps fresh skip and non-skip projections byte-identical with one bounded CURRENT read', () => {
    const root = makeFixture();
    expectSpawnSuccess(queryOverlay(root, 'SampleService'));
    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    const currentBytes = fs.readFileSync(currentPath);

    for (const mode of OVERLAY_OUTPUT_MODES) {
      const results = [false, true].map(skipRefresh => spawnSync(process.execPath, [
        currentQueryScriptPath,
        '--root', root,
        '--query', 'SampleService',
        ...mode.args,
        ...(skipRefresh ? ['--skip-refresh'] : []),
      ], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: overlayQueryEnv({ NANOFLOW_OVERLAY_QUERY_PROFILE: '1' }),
        maxBuffer: 32 * 1024 * 1024,
      }));
      results.forEach(expectSpawnSuccess);
      expect(results[1].stdout, mode.label).toBe(results[0].stdout);
      for (const result of results) {
        const phases = parseJsonLinesFromText(result.stderr)
          .filter(entry => entry.event === 'nanoflow.overlay.profile')
          .map(entry => entry.phase);
        expect(phases.filter(phase => phase === 'readOverlayCurrentReceipt'), mode.label).toHaveLength(1);
        expect(phases, mode.label).not.toContain('checkOverlayFreshness');
        expect(phases.at(-1), mode.label).toEqual(expect.stringMatching(/^write(?:ContextJson|Json|Markdown)$/));
        expect(phases.filter(phase => String(phase).startsWith('write'))).toHaveLength(1);
        expect(phases.some(phase => String(phase).startsWith('ensureOverlay:'))).toBe(false);
      }
    }
    expect(fs.readFileSync(currentPath)).toEqual(currentBytes);
  }, 30_000);

  it('requires explicit publication before newly added source symbols become queryable', () => {
    const root = makeFixture();
    expectSpawnSuccess(queryOverlay(root, 'SampleService'));
    const generationRoot = path.join(root, '.codegraph', 'nanoflow-generations');
    const currentPath = path.join(generationRoot, 'CURRENT.json');
    const firstCurrentBytes = fs.readFileSync(currentPath);
    const firstCurrent = JSON.parse(firstCurrentBytes.toString('utf8')) as { sequence: string };
    const firstGenerationEntries = fs.readdirSync(generationRoot).sort();
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

    const beforePublication = spawnSync(process.execPath, [
      currentQueryScriptPath,
      '--root',
      root,
      '--query',
      'StaleOverlayFreshClass',
      '--json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(beforePublication);
    expect(JSON.parse(beforePublication.stdout).nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'StaleOverlayFreshClass',
        filePath: 'src/app/features/sample/stale-overlay-fresh.ts',
      }),
    ]));
    expect(fs.readFileSync(currentPath)).toEqual(firstCurrentBytes);
    expect(fs.readdirSync(generationRoot).sort()).toEqual(firstGenerationEntries);

    const afterPublication = queryOverlay(root, 'StaleOverlayFreshClass');
    expectSpawnSuccess(afterPublication);
    expect(JSON.parse(afterPublication.stdout).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'StaleOverlayFreshClass',
        filePath: 'src/app/features/sample/stale-overlay-fresh.ts',
      }),
    ]));
    const secondCurrent = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as { sequence: string };
    expect(BigInt(secondCurrent.sequence)).toBeGreaterThan(BigInt(firstCurrent.sequence));
  }, 10_000);
}
