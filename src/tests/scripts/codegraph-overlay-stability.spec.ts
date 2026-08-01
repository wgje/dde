import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupCodegraphOverlayDocsFixtures,
  makeFixture as makeDocsFixture,
  runValidator,
} from './validate-codegraph-overlay-docs.spec-helpers';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const generatorPath = path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs');
const helperPath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-stability.cjs');
const runnerPath = path.join(repoRoot, 'scripts', 'run-codegraph-overlay-stability.cjs');
const syncPath = path.join(repoRoot, 'scripts', 'sync-codegraph-overlay-docs.cjs');
const tempRoots: string[] = [];

interface StabilityHelper {
  assertNumericTokenOnlyChange(before: string, after: string, label: string): void;
  assertParticipantPlan(plan: unknown, env: NodeJS.ProcessEnv): void;
  assertSourceManifestEqual(left: unknown, right: unknown): void;
  createParticipantToken(plan: unknown): string;
  fingerprintOverlay(overlay: unknown): { bytes: number; sha256: string };
  inspectDocsTransaction(root: string): { pending: boolean };
  normalizeOverlayForStability(overlay: unknown): unknown;
  planDigest(plan: unknown): string;
}

interface StabilityRunner {
  buildStableGenerationPlan(options: {
    root: string;
    outputPath: string;
  }): unknown;
  runStableGenerator(options: {
    generatorPath: string;
    outputPath: string;
    root: string;
    timeoutMs: number;
  }): Promise<{ output: { bytes: number; sha256: string }; participantToken: string; planDigest: string }>;
}

interface DocsSyncModule {
  LEGACY_PARTIAL_FIXTURE_PARTICIPANT_POLICY: unknown;
  syncDocs(root: string, options?: {
    beforeCas?: () => void;
    participantPolicy?: unknown;
  }): unknown;
}

function loadHelper(): StabilityHelper {
  return require(helperPath) as StabilityHelper;
}

function loadRunner(): StabilityRunner {
  return require(runnerPath) as StabilityRunner;
}

function loadSync(): DocsSyncModule {
  return require(syncPath) as DocsSyncModule;
}

function runPartialFixtureSync(root: string): unknown {
  const sync = loadSync();
  return sync.syncDocs(root, {
    participantPolicy: sync.LEGACY_PARTIAL_FIXTURE_PARTICIPANT_POLICY,
  });
}

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function runSync(root: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [syncPath, '--root', root, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

function nonNumericProjection(value: string): string {
  return value.replace(/[0-9]+(?:,[0-9]{3})*/g, '<number>');
}

function makeFixture(options: Parameters<typeof makeDocsFixture>[0] = {}): string {
  const root = makeDocsFixture(options);
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(packagePath, `${JSON.stringify({ name: 'canonical-doc-sync-fixture', ...packageJson }, null, 2)}\n`);
  const sourceAgents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const androidCountAnchor = sourceAgents.match(/Android \u8bed\u4e49\u8ba1\u6570\u4e3a\s+[^\u3002\n]+/)?.[0];
  if (!androidCountAnchor) throw new Error('fixture AGENTS Android semantic count anchor missing');
  const agentsPath = path.join(root, 'AGENTS.md');
  fs.writeFileSync(
    agentsPath,
    `# NanoFlow - Global Agent Instructions\n${fs.readFileSync(agentsPath, 'utf8')}\n${androidCountAnchor}\u3002\n`,
  );

  const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
  const sourceAdaptation = fs.readFileSync(path.join(repoRoot, 'docs', 'codegraph-nanoflow-adaptation.md'), 'utf8');
  const sourceAnchor = (pattern: RegExp, label: string) => {
    const match = sourceAdaptation.match(pattern)?.[0];
    if (!match) throw new Error(`fixture source anchor missing: ${label}`);
    return match;
  };
  let adaptation = fs.readFileSync(adaptationPath, 'utf8')
    .replace(/^records (\d+ template bindings:)/m, 'Current Angular template extraction records $1')
    .replace(
      /adds (\d+) edge-function-header native-shaped variable nodes and (\d+) native references edges/,
      'adds $1 `edge-function-header` native-shaped `variable` nodes and $2 native `references` edges',
    )
    .replace(
      /^(\d+ Supabase RPC nodes and \d+ Supabase RPC edges; \d+ Supabase table-write nodes and \d+ Supabase table-write edges)$/m,
      'The operation node summary is $1',
    )
    .replace(/^(\d+ Supabase RPC edges and \d+ Supabase table-write edges)$/m, 'The operation graph summary is $1')
    .replace(
      /^(\d+ SQL function edges, \d+ trigger-function edges, \d+ migration-index edges, \d+ migration-constraint edges, \d+ migration-constraint-validation edges, and \d+ migration-rls edges)$/m,
      'The migration graph summary is $1',
    )
    .replace(
      /^(\d+ hard-rule keyword nodes, \d+ hard-rule keyword edges, \d+ hard-rule keyword mapping edges, \d+ hard-rule implementation edges, and \d+ hard-rule implementation targets)$/m,
      'The AGENTS hard-rule node/provenance summary is $1',
    )
    .replace(/^(\d+ hard-rule keyword edges and \d+ hard-rule implementation edges)$/m, 'The AGENTS hard-rule graph summary is $1')
    .replace(
      /^(\d+ sync-rule anchors, \d+ sync-body keyword edges, \d+ sync-config keyword edges, and \d+ config-source edges)$/m,
      'The AGENTS sync-rule graph summary is $1',
    )
    .replace(
      /^(\d+ sync-rule anchors, \d+ config-rule anchors,[^\r\n]+sync-config-source edges)$/m,
      'The AGENTS sync-rule node/provenance summary is $1',
    );
  const supplementalAnchors = [
    sourceAnchor(/The Supabase select-field layer adds[\s\S]*?The Storage bucket\s+layer adds[\s\S]*?native\s+`?references`?\s+edges/, 'Supabase select/storage prose summary'),
    sourceAnchor(/The Supabase RPC\/table-write layer adds\s+\d+\s+`supabase-rpc` nodes and\s+\d+\s+native\s+`references` edges for static `rpc\(\.\.\.\)` calls,\s+plus\s+\d+\s+`supabase-table-write` nodes and\s+\d+\s+native\s+`references` edges for static/, 'operation prose summary'),
    sourceAnchor(/`?privilegeDetails`?\s+array contains\s+[\d,]+\s+parsed PostgreSQL\s+`?GRANT`?\s+\/\s+`?REVOKE`?\s+statements/, 'Supabase privilege detail narrative'),
    sourceAnchor(/[\d,]+\s+scoped hard-rule keyword nodes and\s+[\d,]+\s+hard-rule keyword reference edges/, 'AGENTS hard-rule keyword narrative'),
    sourceAnchor(/All\s+[\d,]+\s+hard-rule keyword edges carry/, 'AGENTS hard-rule keyword mapping narrative'),
    sourceAnchor(/adds\s+[\d,]+\s+`?hard-rule-implementation`?\s+native\s+`?references`?\s+edges/, 'AGENTS hard-rule implementation narrative'),
    sourceAnchor(/to\s+[\d,]+\s+callable symbols that/, 'AGENTS hard-rule implementation target narrative'),
    sourceAnchor(/structured `policyDetails` array currently contains[\s\S]*?`constraintDetails` contains [\d,]+ parsed SQL constraints\./, 'Supabase migration structured detail narrative'),
    sourceAnchor(/`constraintValidationDetails` contains [\d,]+ parsed SQL constraint validation\s+statements/, 'Supabase constraint validation detail narrative'),
  ];
  adaptation += `\n${supplementalAnchors.join('\n')}\n`;
  fs.writeFileSync(adaptationPath, `# CodeGraph NanoFlow Adaptation\n${adaptation}`);
  return root;
}

function removeDynamicImportAnchor(root: string, renameHeading = false): void {
  const targetPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
  let target = fs.readFileSync(targetPath, 'utf8');
  if (renameHeading) {
    target = target.replace('# CodeGraph NanoFlow Adaptation', '# Renamed CodeGraph Adaptation');
  }
  target = target.replace(
    /\d+\s+dynamic import entries,\s+\d+\s+dynamic import graph edges,\s+and\s+\d+\s+Angular route/,
    'dynamic import route anchor omitted',
  );
  fs.writeFileSync(targetPath, target);
}

function docSyncResidue(root: string): string[] {
  const residue: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');
      if (/codegraph-overlay-doc-sync|nanoflow-doc-sync|\.bak$/i.test(entry.name)) {
        residue.push(relativePath);
      }
      if (entry.isDirectory()) visit(absolutePath);
    }
  };
  visit(root);
  return residue.sort();
}

afterEach(() => {
  cleanupCodegraphOverlayDocsFixtures();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('CodeGraph overlay stability helper', () => {
  it('normalizes only generatedAt and graph node updatedAt while preserving array order', () => {
    const helper = loadHelper();
    const first = {
      generatedAt: 'first',
      metadata: { generatedAt: 'nested-first', updatedAt: 'semantic-first' },
      graph: {
        nodes: [
          { id: 'node:first', updatedAt: 1 },
          { id: 'node:second', updatedAt: 2 },
        ],
        edges: [{ source: 'node:first', target: 'node:second' }],
      },
    };
    const timestampOnly = {
      ...first,
      generatedAt: 'second',
      metadata: { generatedAt: 'nested-second', updatedAt: 'semantic-first' },
      graph: {
        ...first.graph,
        nodes: first.graph.nodes.map((node, index) => ({ ...node, updatedAt: index + 100 })),
      },
    };

    expect(helper.normalizeOverlayForStability(timestampOnly)).toEqual(
      helper.normalizeOverlayForStability(first),
    );
    expect(helper.fingerprintOverlay(timestampOnly)).toEqual(helper.fingerprintOverlay(first));
    expect(helper.fingerprintOverlay({
      ...timestampOnly,
      metadata: { ...timestampOnly.metadata, updatedAt: 'semantic-second' },
    })).not.toEqual(helper.fingerprintOverlay(first));
    expect(helper.fingerprintOverlay({
      ...timestampOnly,
      graph: { ...timestampOnly.graph, nodes: [...timestampOnly.graph.nodes].reverse() },
    })).not.toEqual(helper.fingerprintOverlay(first));
  });

  it('fails closed on path, size, hash, or ordering drift in supplied manifests', () => {
    const helper = loadHelper();
    const baseline = [
      { path: 'a.ts', sha256: 'a'.repeat(64), size: 1 },
      { path: 'b.ts', sha256: 'b'.repeat(64), size: 2 },
    ];

    expect(() => helper.assertSourceManifestEqual(baseline, structuredClone(baseline))).not.toThrow();
    for (const changed of [
      [{ ...baseline[0], path: 'c.ts' }, baseline[1]],
      [{ ...baseline[0], size: 3 }, baseline[1]],
      [{ ...baseline[0], sha256: 'c'.repeat(64) }, baseline[1]],
      [...baseline].reverse(),
    ]) {
      expect(() => helper.assertSourceManifestEqual(baseline, changed)).toThrow(
        'codegraph-overlay-source-manifest-drift',
      );
    }
  });

  it('keeps punctuation outside comma-grouped numeric spans', () => {
    const helper = loadHelper();
    expect(() => helper.assertNumericTokenOnlyChange(
      'Count 1,234, complete.',
      'Count 2,345, complete.',
      'fixture',
    )).not.toThrow();
    expect(() => helper.assertNumericTokenOnlyChange(
      'Count 1,234, complete.',
      'Count 2,345; complete.',
      'fixture',
    )).toThrow('codegraph-overlay-doc-sync-nonnumeric-change');
  });

  it('fails closed on incomplete or mismatched participant plan evidence', () => {
    const helper = loadHelper();
    const plan = { buildCount: 2, participant: 'fixture' };
    const token = helper.createParticipantToken(plan);
    const digest = helper.planDigest(plan);
    expect(() => helper.assertParticipantPlan(plan, {
      NANOFLOW_CODEGRAPH_STABILITY_PARTICIPANT_TOKEN: token,
      NANOFLOW_CODEGRAPH_STABILITY_PLAN_DIGEST: digest,
    })).not.toThrow();
    expect(() => helper.assertParticipantPlan(plan, {
      NANOFLOW_CODEGRAPH_STABILITY_PARTICIPANT_TOKEN: token,
      NANOFLOW_CODEGRAPH_STABILITY_PLAN_DIGEST: '0'.repeat(64),
    })).toThrow('codegraph-overlay-stability-plan-digest-mismatch');
    expect(() => helper.assertParticipantPlan(plan, {
      NANOFLOW_CODEGRAPH_STABILITY_PARTICIPANT_TOKEN: token,
    })).toThrow('codegraph-overlay-stability-participant-invalid');
  });

  it('keeps source walking solely in the generator and exactly two build calls around M0/M1/M2', () => {
    const generator = fs.readFileSync(generatorPath, 'utf8');
    const helper = fs.readFileSync(helperPath, 'utf8');

    expect(generator.match(/function listFiles\(/g)).toHaveLength(1);
    expect(generator.match(/= buildOverlay\(root,/g)).toHaveLength(2);
    expect(generator).toContain('sourceManifest0');
    expect(generator).toContain('sourceManifest1');
    expect(generator).toContain('sourceManifest2');
    expect(generator.indexOf('sourceManifest0')).toBeLessThan(generator.indexOf('overlay1'));
    expect(generator.indexOf('overlay1')).toBeLessThan(generator.indexOf('sourceManifest1'));
    expect(generator.indexOf('sourceManifest1')).toBeLessThan(generator.indexOf('overlay2'));
    expect(generator.indexOf('overlay2')).toBeLessThan(generator.indexOf('sourceManifest2'));
    expect(helper).not.toMatch(/\b(?:listFiles|readdirSync|opendirSync|globSync|walk)\b/);
  });

  it('keeps direct query and MCP refresh paths on the stable generator without package aliases', () => {
    for (const relativePath of [
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).toContain('generate-codegraph-nanoflow-overlay.mjs');
      expect(source).not.toContain('npm run codegraph:overlay:stable');
    }
  });

  it('publishes a disposable project only after the two-build contract succeeds', () => {
    const root = makeTempRoot('nanoflow-overlay-stable-generator-');
    const outputPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"stable-fixture"}\n');
    fs.writeFileSync(path.join(root, 'src', 'fixture.ts'), 'export function stableFixture(): number { return 1; }\n');

    const result = spawnSync(process.execPath, [
      generatorPath,
      '--root', root,
      '--out', outputPath,
      '--android-import-source', 'local',
      '--android-function-source', 'local',
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const overlay = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as {
      graph?: { nodes?: unknown[] };
      project?: { root?: string };
    };
    expect(overlay.project?.root).toBe(root);
    expect(overlay.graph?.nodes?.length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.dirname(outputPath))).toEqual(['nanoflow-overlay.json']);
  });
});

describe('CodeGraph stable generation runner', () => {
  it('runs one bounded generator participant and records plan, token, and output digests', async () => {
    const root = makeTempRoot('nanoflow-overlay-stable-runner-');
    const outputPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const invocationPath = path.join(root, 'invocation.json');
    const stubGenerator = path.join(root, 'stub-generator.cjs');
    fs.writeFileSync(stubGenerator, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const value = name => args[args.indexOf(name) + 1];",
      "const output = value('--out');",
      "fs.mkdirSync(path.dirname(output), { recursive: true });",
      "fs.writeFileSync(output, JSON.stringify({ ok: true }) + '\\n');",
      `fs.writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ args, token: process.env.NANOFLOW_CODEGRAPH_STABILITY_PARTICIPANT_TOKEN, plan: process.env.NANOFLOW_CODEGRAPH_STABILITY_PLAN_DIGEST }));`,
    ].join('\n'));

    const runner = loadRunner();
    const result = await runner.runStableGenerator({
      generatorPath: stubGenerator,
      outputPath,
      root,
      timeoutMs: 5_000,
    });
    const invocation = JSON.parse(fs.readFileSync(invocationPath, 'utf8')) as {
      args: string[];
      plan: string;
      token: string;
    };

    expect(invocation.args).toEqual(['--root', root, '--out', outputPath]);
    expect(invocation.token).toBe(result.participantToken);
    expect(invocation.plan).toBe(result.planDigest);
    expect(result.output.bytes).toBeGreaterThan(0);
    expect(result.output.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runner.buildStableGenerationPlan({ root, outputPath })).toEqual(expect.objectContaining({
      buildCount: 2,
      participant: 'generate-codegraph-nanoflow-overlay',
    }));
    expect(loadHelper().planDigest(runner.buildStableGenerationPlan({ root, outputPath })))
      .toBe(result.planDigest);
  });

  it('terminates and fails closed when its generator participant exceeds the bound', async () => {
    const root = makeTempRoot('nanoflow-overlay-stable-timeout-');
    const stubGenerator = path.join(root, 'stub-generator.cjs');
    fs.writeFileSync(stubGenerator, 'setInterval(() => {}, 1000);\n');

    await expect(loadRunner().runStableGenerator({
      generatorPath: stubGenerator,
      outputPath: path.join(root, 'overlay.json'),
      root,
      timeoutMs: 50,
    })).rejects.toThrow('codegraph-overlay-stability-timeout');
  });
});

describe('CodeGraph documentation count transaction', () => {
  it('classifies the canonical adaptation participant by path when its heading and an anchor change', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    removeDynamicImportAnchor(root, true);
    const paths = ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md'];
    const before = paths.map(docPath => fs.readFileSync(path.join(root, docPath)));

    const result = runSync(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('codegraph-overlay-doc-sync-anchor-missing: dynamic import route summary');
    expect(paths.map(docPath => fs.readFileSync(path.join(root, docPath)))).toEqual(before);
    expect(docSyncResidue(root)).toEqual([]);
  });

  it('does not let forged Vitest markers opt a CLI invocation into partial-fixture compatibility', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    const packagePath = path.join(root, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    fs.writeFileSync(packagePath, `${JSON.stringify({ scripts: packageJson.scripts }, null, 2)}\n`);
    removeDynamicImportAnchor(root, true);
    const paths = ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md'];
    const before = paths.map(docPath => fs.readFileSync(path.join(root, docPath)));

    const result = runSync(root, [], {
      ...process.env,
      VITEST: 'true',
      VITEST_POOL_ID: 'forged-pool',
      VITEST_WORKER_ID: 'forged-worker',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('codegraph-overlay-doc-sync-anchor-missing: dynamic import route summary');
    expect(paths.map(docPath => fs.readFileSync(path.join(root, docPath)))).toEqual(before);
    expect(docSyncResidue(root)).toEqual([]);
  });

  it('retains missing legacy anchors only for an explicit partial test fixture', () => {
    const root = makeDocsFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    removeDynamicImportAnchor(root);

    expect(() => runPartialFixtureSync(root)).not.toThrow();
    expect(docSyncResidue(root)).toEqual([]);
  });

  it('rejects duplicate anchors even for an explicit partial test fixture', () => {
    const root = makeDocsFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    const targetPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    const target = fs.readFileSync(targetPath, 'utf8');
    const anchor = target.match(/\d+\s+dynamic import entries,\s+\d+\s+dynamic import graph edges,\s+and\s+\d+\s+Angular route/)?.[0];
    expect(anchor).toBeDefined();
    fs.appendFileSync(targetPath, `\n${anchor}\n`);
    const paths = ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md'];
    const before = paths.map(docPath => fs.readFileSync(path.join(root, docPath)));

    expect(() => runPartialFixtureSync(root)).toThrow(
      'codegraph-overlay-doc-sync-anchor-multiple: dynamic import route summary',
    );
    expect(paths.map(docPath => fs.readFileSync(path.join(root, docPath)))).toEqual(before);
    expect(docSyncResidue(root)).toEqual([]);
  });

  it.each([
    {
      anchor: /Android \u8bed\u4e49\u8ba1\u6570\u4e3a\s+[^\u3002\n]+/,
      label: 'AGENTS Android semantic count summary',
      relativePath: 'AGENTS.md',
    },
    {
      anchor: /\d+\s+dynamic import entries,\s+\d+\s+dynamic import graph edges,\s+and\s+\d+\s+Angular route/,
      label: 'dynamic import route summary',
      relativePath: 'docs/codegraph-nanoflow-adaptation.md',
    },
  ])('rejects a duplicate numeric anchor in $relativePath before transaction preparation', ({
    anchor,
    label,
    relativePath,
  }) => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    const targetPath = path.join(root, relativePath);
    const target = fs.readFileSync(targetPath, 'utf8');
    const match = target.match(anchor)?.[0];
    expect(match).toBeDefined();
    fs.appendFileSync(targetPath, `\n${match}\n`);
    const paths = ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md'];
    const before = paths.map(docPath => fs.readFileSync(path.join(root, docPath)));

    const result = runSync(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`codegraph-overlay-doc-sync-anchor-multiple: ${label}`);
    expect(paths.map(docPath => fs.readFileSync(path.join(root, docPath)))).toEqual(before);
    expect(docSyncResidue(root)).toEqual([]);
  });

  it('distinguishes a missing numeric anchor before transaction preparation', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    const relativePath = 'docs/codegraph-nanoflow-adaptation.md';
    const targetPath = path.join(root, relativePath);
    const target = fs.readFileSync(targetPath, 'utf8');
    const anchor = /\d+\s+dynamic import entries,\s+\d+\s+dynamic import graph edges,\s+and\s+\d+\s+Angular route/;
    expect(target).toMatch(anchor);
    fs.writeFileSync(targetPath, target.replace(anchor, 'dynamic import route anchor omitted'));
    const paths = ['AGENTS.md', relativePath];
    const before = paths.map(docPath => fs.readFileSync(path.join(root, docPath)));

    const result = runSync(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('codegraph-overlay-doc-sync-anchor-missing: dynamic import route summary');
    expect(paths.map(docPath => fs.readFileSync(path.join(root, docPath)))).toEqual(before);
    expect(docSyncResidue(root)).toEqual([]);
  });

  it('changes numeric spans only and leaves no pending transaction artifacts', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    const paths = ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md'];
    const before = paths.map(relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8'));

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const after = paths.map(relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8'));
    expect(after.map(nonNumericProjection)).toEqual(before.map(nonNumericProjection));
    expect(loadHelper().inspectDocsTransaction(root)).toEqual(expect.objectContaining({ pending: false }));
    expect(runSync(root, ['--assert-clean']).status).toBe(0);
    const validation = runValidator(root);
    expect(validation.status, validation.stderr || validation.stdout).toBe(0);
  });

  it('fails direct validation while interrupted and recovers a recognized one-document publish', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });

    const interrupted = runSync(root, ['--simulate-crash-after-first-publish']);
    expect(interrupted.status).not.toBe(0);
    expect(loadHelper().inspectDocsTransaction(root)).toEqual(expect.objectContaining({ pending: true }));
    expect(runSync(root).stderr).toContain('codegraph-overlay-doc-sync-pending');
    expect(runSync(root, ['--assert-clean']).stderr).toContain('codegraph-overlay-doc-sync-pending');
    const validation = runValidator(root);
    expect(validation.status).toBe(1);
    expect(validation.stderr).toContain('codegraph-overlay-doc-sync-pending');

    const recovered = runSync(root, ['--recover']);
    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(runSync(root, ['--assert-clean']).status).toBe(0);
    const recoveredValidation = runValidator(root);
    expect(recoveredValidation.status, recoveredValidation.stderr || recoveredValidation.stdout).toBe(0);
  });

  it('refuses recovery after an interrupted document changes to an unknown hash', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    expect(runSync(root, ['--simulate-crash-after-first-publish']).status).not.toBe(0);
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nforeign-change\n');

    const recovered = runSync(root, ['--recover']);

    expect(recovered.status).toBe(1);
    expect(recovered.stderr).toContain('codegraph-overlay-doc-sync-unknown-hash');
    expect(loadHelper().inspectDocsTransaction(root).pending).toBe(true);
  });

  it('discards an incomplete pre-publication directory without touching either document', () => {
    const root = makeFixture();
    const before = ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']
      .map(relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8'));
    fs.mkdirSync(path.join(root, '.codegraph', 'codegraph-overlay-doc-sync-transaction.preparing'));

    const recovered = runSync(root, ['--recover']);

    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(loadHelper().inspectDocsTransaction(root).pending).toBe(false);
    expect(['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']
      .map(relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8'))).toEqual(before);
  });

  it('uses preimage CAS and leaves an externally changed preimage pending for explicit recovery', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1, totalTestEdgesInDocs: 4 });
    const sync = loadSync();

    expect(() => sync.syncDocs(root, {
      beforeCas: () => fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nforeign-change\n'),
    })).toThrow('codegraph-overlay-doc-sync-preimage-drift');
    expect(loadHelper().inspectDocsTransaction(root).pending).toBe(true);
  });
});
