import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const manifestScriptPath = path.join(projectRoot, 'scripts', 'generate-codegraph-overlay-baseline-manifest.cjs');
const tempRoots: string[] = [];
const fixtureGenerationId = `g-${'1'.repeat(64)}`;
const fixtureRelativePath = 'compatibility/overlay-fixture.json';
const require = createRequire(import.meta.url);
const { ZERO_REASON_COUNTERS } = require('../../../scripts/lib/codegraph-overlay-contract-manifest.cjs') as {
  ZERO_REASON_COUNTERS: Map<string, string>;
};

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-baseline-manifest-'));
  tempRoots.push(root);
  const overlayPath = fixtureOverlayPath(root);
  mkdirSync(path.dirname(overlayPath), { recursive: true });
  writeFileSync(
    overlayPath,
    JSON.stringify({
      graph: {
        nodes: [
          { id: 'hard-rule-keyword', metadata: { relation: 'hard-rule-keyword' } },
          { id: 'edge-function-env-var', metadata: { relation: 'env-var' } },
          { id: 'supabase-risk-tag', metadata: { relation: 'risk-tag' } },
        ],
        edges: [
          { kind: 'references', target: 'hard-rule-keyword', metadata: { relation: 'hard-rule-keyword', keywordMapping: 'hard-rule-keyword' } },
          { kind: 'references', metadata: { relation: 'dynamic-import' } },
          { kind: 'references', metadata: { relation: 'android-manifest-uses-permission' } },
          { kind: 'references', metadata: { relation: 'android-manifest-query' } },
          { kind: 'references', metadata: { relation: 'android-manifest-component-permission' } },
          { kind: 'references', metadata: { relation: 'android-manifest-intent-filter-action' } },
          { kind: 'references', metadata: { relation: 'android-manifest-intent-filter-category' } },
          { kind: 'references', metadata: { relation: 'android-manifest-intent-filter-data' } },
          { kind: 'references', metadata: { relation: 'android-kotlin-resource-reference' } },
          { kind: 'references', metadata: { relation: 'env-var', envVar: 'SUPABASE_URL' } },
          { kind: 'decorates', metadata: { relation: 'risk-tag', riskTag: 'security-sensitive', riskSource: 'migration' } },
        ],
      },
      angular: { dynamicImports: [{}], routes: [], components: [] },
      android: {
        manifestPermissions: [{}],
        manifestQueries: [{}],
        manifestComponents: [{ permission: 'android.permission.BIND_APPWIDGET', intentFilters: [{ actions: [{}], categories: [{}], data: [{}] }] }],
        kotlinResourceReferences: [{}],
      },
      supabase: { edgeFunctions: [], migrations: [] },
      agentRules: { syncRules: [] },
    }),
  );
  return root;
}

function runManifest(root: string, args: string[] = []) {
  const preloadPath = path.join(root, 'baseline-current-reader-preload.cjs');
  writeFileSync(preloadPath, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const Module = require('node:module');",
    `const fixturePath = ${JSON.stringify(fixtureOverlayPath(root))};`,
    `const generationId = ${JSON.stringify(fixtureGenerationId)};`,
    `const compatibilityPath = ${JSON.stringify(fixtureRelativePath)};`,
    'const load = Module._load;',
    'Module._load = function(request, parent, isMain) {',
    "  if (request === './lib/codegraph-overlay-current-receipt.cjs') {",
    '    return { readOverlayCurrentReceipt() {',
    '      try {',
    "        const overlay = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));",
    '        return { ok: true, current: { generationId }, manifest: { compatibility: { path: compatibilityPath } }, overlay };',
    '      } catch (error) {',
    "        return { ok: false, errorCode: error && error.code === 'ENOENT' ? 'CURRENT_MISSING' : 'PAYLOAD_INVALID' };",
    '      }',
    '    } };',
    '  }',
    '  return load.call(this, request, parent, isMain);',
    '};',
    '',
  ].join('\n'));
  return spawnSync(process.execPath, ['--require', preloadPath, manifestScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

function fixtureOverlayPath(root: string): string {
  return path.join(root, '.codegraph', 'nanoflow-generations', fixtureGenerationId, ...fixtureRelativePath.split('/'));
}

function fileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

describe('CodeGraph overlay baseline manifest', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a schema-like machine-readable baseline manifest', () => {
    const root = makeRoot();

    const result = runManifest(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const outputPath = path.join(root, '.codegraph', 'nanoflow-overlay-baseline-manifest.json');
    expect(existsSync(outputPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect(manifest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      generatedFrom: `.codegraph/nanoflow-generations/${fixtureGenerationId}/${fixtureRelativePath}`,
      counters: expect.objectContaining({
        graphNodes: expect.objectContaining({ value: 3, volatility: 'diagnostic' }),
        hardRuleKeywordEdges: expect.objectContaining({ value: 1, volatility: 'stable' }),
        edgeFunctionEnvVarNodes: expect.objectContaining({ value: 1, volatility: 'stable' }),
        edgeFunctionEnvVarEdges: expect.objectContaining({ value: 1, volatility: 'stable' }),
        supabaseRiskTagNodes: expect.objectContaining({ value: 1, volatility: 'stable' }),
        supabaseRiskTagEdges: expect.objectContaining({ value: 1, volatility: 'stable' }),
        angularRouteResolverEdges: expect.objectContaining({
          value: 0,
          volatility: 'stable',
          zeroReason: expect.stringContaining('route resolvers'),
        }),
        androidManifestPermissions: expect.objectContaining({ value: 1, volatility: 'stable' }),
        androidManifestIntentFilterDataEdges: expect.objectContaining({ value: 1, volatility: 'stable' }),
        androidKotlinResourceReferenceEdges: expect.objectContaining({ value: 1, volatility: 'stable' }),
      }),
    }));
    for (const [counterName, zeroReason] of ZERO_REASON_COUNTERS) {
      expect(manifest.counters[counterName], counterName).toEqual(expect.objectContaining({
        value: 0,
        volatility: 'stable',
        zeroReason,
      }));
    }
  });

  it('keeps counter volatility in the shared contract manifest', () => {
    const script = readFileSync(manifestScriptPath, 'utf8');

    expect(script).toContain("require('./lib/codegraph-overlay-contract-manifest.cjs')");
    expect(script).toContain('counterContract');
    expect(script).not.toContain('const DIAGNOSTIC_COUNTERS');
  });

  it('does not retain a zero reason after a counter becomes non-zero', () => {
    const root = makeRoot();
    const overlayPath = fixtureOverlayPath(root);
    const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
    overlay.graph.edges.push({
      kind: 'references',
      metadata: { relation: 'angular-route-resolver' },
    });
    writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runManifest(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const manifest = JSON.parse(readFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay-baseline-manifest.json'),
      'utf8',
    ));
    expect(manifest.counters.angularRouteResolverEdges).toEqual({
      value: 1,
      volatility: 'stable',
    });
  });

  it('does not allow zero reasons for relations present in the real project overlay', () => {
    expect([...ZERO_REASON_COUNTERS.keys()]).not.toContain('templateDirectiveEdges');
    expect([...ZERO_REASON_COUNTERS.keys()]).not.toContain('supabaseRealtimeUnsubscribeNodes');
    expect([...ZERO_REASON_COUNTERS.keys()]).not.toContain('supabaseRealtimeUnsubscribeEdges');
  });

  it.each([
    { label: 'relative', output: () => path.join('.codegraph', 'nanoflow-generations', fixtureGenerationId, '.', ...fixtureRelativePath.split('/')) },
    { label: 'absolute normalized', output: (root: string) => path.join(root, '.codegraph', 'nanoflow-generations', fixtureGenerationId, '..', fixtureGenerationId, ...fixtureRelativePath.split('/')) },
    { label: 'hardlink', output: (root: string, overlayPath: string) => { const alias = path.join(root, '.codegraph', 'hardlink.json'); linkSync(overlayPath, alias); return alias; } },
    { label: 'parent symlink', output: (root: string, overlayPath: string) => { const alias = path.join(root, 'overlay-link'); symlinkSync(path.dirname(overlayPath), alias, process.platform === 'win32' ? 'junction' : 'dir'); return path.join(alias, path.basename(overlayPath)); } },
  ])('rejects a $label output alias before changing the overlay', ({ output }) => {
    const root = makeRoot();
    const overlayPath = fixtureOverlayPath(root);
    const beforeSha = fileSha256(overlayPath);
    let outputPath: string;
    try {
      outputPath = output(root, overlayPath);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }

    const result = runManifest(root, ['--output', outputPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baseline-output-collides-overlay');
    expect(result.stdout).toBe('');
    expect(fileSha256(overlayPath)).toBe(beforeSha);
  });

  it('preserves distinct output and missing or malformed overlay behavior', () => {
    const root = makeRoot();
    const overlayPath = fixtureOverlayPath(root);
    const beforeSha = fileSha256(overlayPath);
    const distinct = runManifest(root, ['--output', '.codegraph/custom-baseline.json']);
    expect(distinct.status, distinct.stderr).toBe(0);
    expect(fileSha256(overlayPath)).toBe(beforeSha);
    expect(existsSync(path.join(root, '.codegraph', 'custom-baseline.json'))).toBe(true);

    const missingRoot = makeRoot();
    rmSync(fixtureOverlayPath(missingRoot));
    const missing = runManifest(missingRoot);
    expect(missing.status).toBe(1);
    expect(missing.stderr).not.toContain('baseline-output-collides-overlay');

    const malformedRoot = makeRoot();
    writeFileSync(fixtureOverlayPath(malformedRoot), '{');
    const malformed = runManifest(malformedRoot);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).not.toContain('baseline-output-collides-overlay');
  });
});
