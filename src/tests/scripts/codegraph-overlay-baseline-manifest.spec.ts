import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const manifestScriptPath = path.join(projectRoot, 'scripts', 'generate-codegraph-overlay-baseline-manifest.cjs');
const tempRoots: string[] = [];
const require = createRequire(import.meta.url);
const { ZERO_REASON_COUNTERS } = require('../../../scripts/lib/codegraph-overlay-contract-manifest.cjs') as {
  ZERO_REASON_COUNTERS: Map<string, string>;
};

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-baseline-manifest-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  writeFileSync(
    path.join(root, '.codegraph', 'nanoflow-overlay.json'),
    JSON.stringify({
      graph: {
        nodes: [
          { id: 'hard-rule-keyword', metadata: { relation: 'hard-rule-keyword' } },
        ],
        edges: [
          { kind: 'references', target: 'hard-rule-keyword', metadata: { relation: 'hard-rule-keyword', keywordMapping: 'hard-rule-keyword' } },
          { kind: 'references', metadata: { relation: 'dynamic-import' } },
        ],
      },
      angular: { dynamicImports: [{}], routes: [], components: [] },
      supabase: { edgeFunctions: [], migrations: [] },
      agentRules: { syncRules: [] },
    }),
  );
  return root;
}

function runManifest(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [manifestScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
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
      generatedFrom: '.codegraph/nanoflow-overlay.json',
      counters: expect.objectContaining({
        graphNodes: expect.objectContaining({ value: 1, volatility: 'diagnostic' }),
        hardRuleKeywordEdges: expect.objectContaining({ value: 1, volatility: 'stable' }),
        angularRouteResolverEdges: expect.objectContaining({
          value: 0,
          volatility: 'stable',
          zeroReason: expect.stringContaining('route resolvers'),
        }),
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
});
