import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const publisher = require(path.join(
  repoRoot,
  'scripts',
  'lib',
  'codegraph-overlay-generation-publisher.cjs',
)) as {
  acquireOverlayPublicationLease(options: {
    projectRoot: string;
    owner: string;
    ttlMs: number;
  }): {
    readLeaseEvidence(): unknown;
    release(): void;
  };
  createOverlayGenerationPublisher(dependencies: {
    readLeaseEvidence(): unknown;
    transactionId(): string;
  }): {
    publish(options: Record<string, unknown>): {
      current: Record<string, unknown>;
      generationPath: string;
      manifest: Record<string, unknown>;
      receipt: Record<string, unknown>;
    };
  };
};
const overlayContract = require(path.join(
  repoRoot,
  'scripts',
  'contracts',
  'codegraph-nanoflow-overlay-v1.json',
)) as { coverageTargets: string[] };
const generationContract = require(path.join(
  repoRoot,
  'scripts',
  'contracts',
  'codegraph-overlay-generation-v1.json',
)) as Record<string, string[]>;
const roots: string[] = [];
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [
    key,
    canonical((value as Record<string, unknown>)[key]),
  ]));
};
const fixedDigests = {
  configDigest: digest('config'),
  setupDigest: digest('setup'),
  sourceManifestDigest: digest('source-manifest'),
  toolchainDigest: digest('toolchain'),
};

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-overlay-publisher-'));
  roots.push(root);
  return root;
}

function heldLeaseEvidence() {
  return {
    workspaceEpoch: 42,
    barrier: {
      state: 'HELD',
      owner: 'publisher-owner',
      fence: 7,
      heldEpoch: 41,
    },
    resource: {
      state: 'ACTIVE',
      kind: 'build',
      resourceId: 'codegraph-overlay-generation',
      owner: 'publisher-owner',
      fence: 7,
      heldEpoch: 41,
    },
  };
}

function validOverlay(projectRoot: string) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-03T00:00:00.000Z',
    project: {
      root: projectRoot.replace(/\\/g, '/'),
      name: 'fixture',
      codegraphOverlay: 'NanoFlow project semantics that complement the base AST graph',
    },
    coverageTargets: overlayContract.coverageTargets,
    typescript: {
      files: [], classes: [], functions: [], interfaces: [], types: [], variables: [],
      enums: [], namespaces: [], imports: [], exports: [], parameters: [],
    },
    angular: {
      components: [], directives: [], pipes: [], injectables: [], injectors: [],
      dynamicImports: [], routes: [], applicationProviders: [],
    },
    supabase: { edgeFunctions: [], migrations: [] },
    android: {
      files: [], kotlinClasses: [], kotlinEnums: [], kotlinImports: [], kotlinConstructors: [],
      kotlinProperties: [], kotlinMethods: [], kotlinFunctions: [], kotlinCalls: [],
      manifestComponents: [], manifestPermissions: [], manifestQueries: [], widgetProviders: [],
      xmlResources: [], resourceReferences: [], kotlinResourceReferences: [],
    },
    agentRules: { syncRules: [], hardRules: [] },
    context7: { documents: [], categories: [], retrievalRoutes: [], sourceMapRoutes: [] },
    graph: { schemaVersion: 1, nodes: [], edges: [] },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CodeGraph Overlay generation publisher', { timeout: 30_000 }, () => {
  it('publishes one immutable generation and a canonical CURRENT selector', () => {
    const root = makeRoot();
    const api = publisher.createOverlayGenerationPublisher({
      readLeaseEvidence: heldLeaseEvidence,
      transactionId: () => `tx-${'1'.repeat(32)}`,
    });

    const result = api.publish({
      projectRoot: root,
      overlay: validOverlay(root),
      sequence: '1',
      publishedAt: '2026-08-03T00:01:00.000Z',
      ...fixedDigests,
    });

    expect(result.current.generationId).toMatch(/^g-[a-f0-9]{64}$/);
    expect(result.current.sequence).toBe('1');
    expect(result.generationPath).toBe(path.join(
      root,
      '.codegraph',
      'nanoflow-generations',
      String(result.current.generationId),
    ));
    expect(fs.statSync(result.generationPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, '.codegraph', 'nanoflow-overlay.json'))).toBe(false);

    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    const currentBytes = fs.readFileSync(currentPath);
    expect(currentBytes.at(-1)).toBe(10);
    expect(JSON.parse(currentBytes.toString('utf8'))).toEqual(result.current);
    expect(Object.keys(result.current)).toEqual([...Object.keys(result.current)].sort());
    expect(fs.readFileSync(path.join(result.generationPath, 'manifest.json'), 'utf8'))
      .toBe(`${JSON.stringify(canonical(result.manifest))}\n`);
    expect(fs.readFileSync(path.join(result.generationPath, 'receipt.json'), 'utf8'))
      .toContain(String(result.receipt.receiptDigest));

    expect(Object.keys(result.current).sort()).toEqual([...generationContract.currentKeys].sort());
    expect(Object.keys(result.manifest).sort()).toEqual([...generationContract.manifestKeys].sort());
    expect(Object.keys(result.receipt).sort()).toEqual([...generationContract.receiptKeys].sort());
    const array = (result.manifest.arrays as Array<Record<string, unknown>>)[0];
    const shard = (array.shards as Array<Record<string, unknown>>)[0];
    expect(Object.keys(array).sort()).toEqual([...generationContract.arrayDescriptorKeys].sort());
    expect(Object.keys(shard).sort()).toEqual([...generationContract.shardDescriptorKeys].sort());
  });

  it('quarantines the completed generation and withholds CURRENT when the lease drifts', () => {
    const root = makeRoot();
    const tx = `tx-${'7'.repeat(32)}`;
    let reads = 0;
    const api = publisher.createOverlayGenerationPublisher({
      readLeaseEvidence() {
        const evidence = heldLeaseEvidence();
        reads += 1;
        if (reads === 2) {
          evidence.barrier.fence += 1;
          evidence.resource.fence += 1;
        }
        return evidence;
      },
      transactionId: () => tx,
    });

    expect(() => api.publish({
      projectRoot: root,
      overlay: validOverlay(root),
      sequence: '1',
      publishedAt: '2026-08-03T00:07:00.000Z',
      ...fixedDigests,
    })).toThrow('codegraph-overlay-publication-lease-drift');
    const generationRoot = path.join(root, '.codegraph', 'nanoflow-generations');
    expect(fs.existsSync(path.join(generationRoot, 'CURRENT.json'))).toBe(false);
    expect(fs.statSync(path.join(generationRoot, '.quarantine', tx, 'generation')).isDirectory())
      .toBe(true);
  });

  it('refuses the CURRENT compare-and-swap and quarantines on selector drift', () => {
    const root = makeRoot();
    const generationRoot = path.join(root, '.codegraph', 'nanoflow-generations');
    const currentPath = path.join(generationRoot, 'CURRENT.json');
    publisher.createOverlayGenerationPublisher({
      readLeaseEvidence: heldLeaseEvidence,
      transactionId: () => `tx-${'8'.repeat(32)}`,
    }).publish({
      projectRoot: root,
      overlay: validOverlay(root),
      sequence: '1',
      publishedAt: '2026-08-03T00:08:00.000Z',
      ...fixedDigests,
    });
    const tx = `tx-${'9'.repeat(32)}`;
    let reads = 0;
    const api = publisher.createOverlayGenerationPublisher({
      readLeaseEvidence() {
        reads += 1;
        if (reads === 2) fs.writeFileSync(currentPath, '{"drift":true}\n');
        return heldLeaseEvidence();
      },
      transactionId: () => tx,
    });

    expect(() => api.publish({
      projectRoot: root,
      overlay: validOverlay(root),
      sequence: '2',
      publishedAt: '2026-08-03T00:09:00.000Z',
      ...fixedDigests,
    })).toThrow('codegraph-overlay-publication-current-drift');
    expect(fs.readFileSync(currentPath, 'utf8')).toBe('{"drift":true}\n');
    expect(fs.statSync(path.join(generationRoot, '.quarantine', tx, 'generation')).isDirectory())
      .toBe(true);
  });

  it('rejects sequence rollback before replacing the current selector', () => {
    const root = makeRoot();
    const transactionIds = [`tx-${'2'.repeat(32)}`, `tx-${'3'.repeat(32)}`];
    const api = publisher.createOverlayGenerationPublisher({
      readLeaseEvidence: heldLeaseEvidence,
      transactionId: () => transactionIds.shift()!,
    });
    const base = {
      projectRoot: root,
      overlay: validOverlay(root),
      ...fixedDigests,
    };
    api.publish({
      ...base,
      sequence: '2',
      publishedAt: '2026-08-03T00:02:00.000Z',
    });
    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    const before = fs.readFileSync(currentPath);

    expect(() => api.publish({
      ...base,
      sequence: '1',
      publishedAt: '2026-08-03T00:03:00.000Z',
    })).toThrow('codegraph-overlay-publication-sequence-rollback');
    expect(fs.readFileSync(currentPath)).toEqual(before);
  });

  it('assigns the next decimal sequence from authenticated current state', () => {
    const root = makeRoot();
    const transactionIds = [`tx-${'5'.repeat(32)}`, `tx-${'6'.repeat(32)}`];
    const api = publisher.createOverlayGenerationPublisher({
      readLeaseEvidence: heldLeaseEvidence,
      transactionId: () => transactionIds.shift()!,
    });
    const base = {
      projectRoot: root,
      overlay: validOverlay(root),
      ...fixedDigests,
    };
    api.publish({
      ...base,
      sequence: '2',
      publishedAt: '2026-08-03T00:05:00.000Z',
    });

    const next = api.publish({
      ...base,
      publishedAt: '2026-08-03T00:06:00.000Z',
    });

    expect(next.current.sequence).toBe('3');
  });

  it('validates the exact Overlay v1 stream before creating publication evidence', () => {
    const root = makeRoot();
    const api = publisher.createOverlayGenerationPublisher({
      readLeaseEvidence: heldLeaseEvidence,
      transactionId: () => `tx-${'4'.repeat(32)}`,
    });

    expect(() => api.publish({
      projectRoot: root,
      overlay: { schemaVersion: 1, project: { root } },
      sequence: '1',
      publishedAt: '2026-08-03T00:04:00.000Z',
      ...fixedDigests,
    })).toThrow('codegraph-overlay-publication-schema-invalid');
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });

  it('acquires and releases one HELD barrier-bound BUILD resource without file claims', () => {
    const root = makeRoot();

    const session = publisher.acquireOverlayPublicationLease({
      projectRoot: root,
      owner: 'publisher-owner',
      ttlMs: 60_000,
    });
    expect(session.readLeaseEvidence()).toMatchObject({
      barrier: { state: 'HELD', owner: 'publisher-owner' },
      resource: {
        state: 'ACTIVE',
        kind: 'build',
        resourceId: 'codegraph-overlay-generation',
        owner: 'publisher-owner',
      },
    });

    session.release();
    const status = JSON.parse(spawnLease(root, ['status']).stdout) as {
      barrier: { state: string };
      leases: Record<string, unknown>;
      resourceLeases: { active: unknown[] };
    };
    expect(status.barrier.state).toBe('RELEASED');
    expect(status.resourceLeases.active).toEqual([]);
    expect(status.leases).toEqual({});
  });

  it('holds publication coordination across both source snapshots and never writes the legacy root artifact', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs'),
      'utf8',
    );
    const acquireIndex = source.indexOf('acquireOverlayPublicationLease(');
    const firstSnapshotIndex = source.indexOf('captureSourceManifest(root)');
    const publishIndex = source.indexOf('.publish({');

    expect(source).toContain("import overlayGenerationPublisher from './lib/codegraph-overlay-generation-publisher.cjs';");
    expect(acquireIndex).toBeGreaterThanOrEqual(0);
    expect(acquireIndex).toBeLessThan(firstSnapshotIndex);
    expect(publishIndex).toBeGreaterThan(firstSnapshotIndex);
    expect(source).toContain('publicationSession.release();');
    expect(source).not.toContain('writeFileAtomically(outputPath');
  });
});

function spawnLease(root: string, args: string[]) {
  return require('node:child_process').spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'agent-file-lease.cjs'),
    '--root', root,
    ...args,
    '--json',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }) as { stdout: string };
}
