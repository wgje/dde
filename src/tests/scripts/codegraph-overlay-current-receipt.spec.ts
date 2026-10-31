import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const reader = require(path.join(
  repoRoot,
  'scripts',
  'lib',
  'codegraph-overlay-current-receipt.cjs',
)) as {
  readOverlayCurrentReceipt(projectRoot: string): Record<string, unknown>;
};
const publisher = require(path.join(
  repoRoot,
  'scripts',
  'lib',
  'codegraph-overlay-generation-publisher.cjs',
)) as {
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

const roots: string[] = [];
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const fixedDigests = {
  configDigest: digest('config'),
  setupDigest: digest('setup'),
  sourceManifestDigest: digest('source-manifest'),
  toolchainDigest: digest('toolchain'),
};

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-current-reader-'));
  roots.push(root);
  return root;
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
      files: [],
      classes: [], functions: [], interfaces: [], types: [], variables: [], enums: [], namespaces: [], imports: [], exports: [], parameters: [],
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

function heldLeaseEvidence() {
  return {
    workspaceEpoch: 42,
    barrier: { state: 'HELD', owner: 'publisher-owner', fence: 7, heldEpoch: 41 },
    resource: {
      state: 'ACTIVE', kind: 'build', resourceId: 'codegraph-overlay-generation',
      owner: 'publisher-owner', fence: 7, heldEpoch: 41,
    },
  };
}

function publish(root: string) {
  return publisher.createOverlayGenerationPublisher({
    readLeaseEvidence: heldLeaseEvidence,
    transactionId: () => `tx-${'1'.repeat(32)}`,
  }).publish({
    projectRoot: root,
    overlay: validOverlay(root),
    sequence: '1',
    publishedAt: '2026-08-03T00:01:00.000Z',
    ...fixedDigests,
  });
}

function recursivelyFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value)
    && Object.values(value).every(child => recursivelyFrozen(child, seen));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CodeGraph Overlay CURRENT receipt reader', () => {
  it('is the exclusive production payload authority for the overlay query entry', () => {
    const source = fs.readFileSync(path.join(
      repoRoot,
      'scripts',
      'query-codegraph-nanoflow-overlay.mjs',
    ), 'utf8');

    expect(source).toContain("import currentReceiptReader from './lib/codegraph-overlay-current-receipt.cjs';");
    expect(source).toContain('readOverlayCurrentReceipt(root)');
    expect(source).not.toContain("path.join('.codegraph', 'nanoflow-overlay.json')");
    expect(source).not.toContain('function readOverlayJson');
    expect(source).not.toContain('function ensureOverlay');
    expect(source).not.toContain('function checkOverlayFreshness');
  });

  it('is the shared payload authority for every remaining production consumer', () => {
    const wrapperPath = 'scripts/codegraph-nanoflow-mcp-stdio.cjs';
    const wrapperSource = fs.readFileSync(path.join(repoRoot, wrapperPath), 'utf8');
    expect(wrapperSource, wrapperPath).toContain('query-codegraph-nanoflow-overlay.mjs');
    expect(wrapperSource, wrapperPath).toContain('runNanoFlowOverlayQuery');
    expect(wrapperSource, wrapperPath).not.toContain(".codegraph/nanoflow-overlay.json");
    expect(wrapperSource, wrapperPath).not.toContain("'nanoflow-overlay.json'");

    for (const relativePath of [
      'scripts/codegraph-adapter-doctor.cjs',
      'scripts/lib/codegraph-native-graph-sidecar.cjs',
      'scripts/generate-codegraph-overlay-baseline-manifest.cjs',
      'scripts/sync-codegraph-overlay-docs.cjs',
      'scripts/validate-codegraph-overlay-docs.cjs',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).toContain('codegraph-overlay-current-receipt.cjs');
      expect(source, relativePath).toContain('readOverlayCurrentReceipt');
      expect(source, relativePath).not.toContain(".codegraph/nanoflow-overlay.json");
      expect(source, relativePath).not.toContain("'nanoflow-overlay.json'");
    }
  });

  it('returns one authenticated immutable payload without reading the compatibility copy', () => {
    const root = makeRoot();
    const published = publish(root);
    const compatibilityPath = path.join(
      published.generationPath,
      'compatibility',
      'nanoflow-overlay.json',
    );
    const originalRead = fs.readFileSync.bind(fs);
    const reads = new Map<string, number>();
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof file === 'string') {
        const resolved = path.resolve(file);
        reads.set(resolved, (reads.get(resolved) ?? 0) + 1);
      }
      return originalRead(file, ...(args as []));
    }) as typeof fs.readFileSync);

    const result = reader.readOverlayCurrentReceipt(root) as {
      ok: boolean;
      current: Record<string, unknown>;
      manifest: Record<string, unknown>;
      receipt: Record<string, unknown>;
      overlay: ReturnType<typeof validOverlay>;
    };

    expect(result.ok).toBe(true);
    expect(result.current).toEqual(published.current);
    expect(result.manifest).toEqual(published.manifest);
    expect(result.receipt).toEqual(published.receipt);
    expect(result.overlay).toEqual(validOverlay(root));
    expect(recursivelyFrozen(result)).toBe(true);
    expect(reads.get(path.resolve(compatibilityPath)) ?? 0).toBe(0);
    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    expect(reads.get(path.resolve(currentPath))).toBe(2);
    for (const [file, count] of reads) {
      if (file !== path.resolve(currentPath)) expect(count, file).toBe(1);
    }
  });

  it('parses each bounded JSONL shard as one batch instead of reparsing every record', () => {
    const root = makeRoot();
    const overlay = validOverlay(root);
    const files = overlay.typescript.files as Array<{ file: string; language: string }>;
    files.push(...Array.from({ length: 2_048 }, (_unused, index) => ({
      file: `src/receipt-batch-${String(index).padStart(4, '0')}.ts`,
      language: 'typescript',
    })));
    publisher.createOverlayGenerationPublisher({
      readLeaseEvidence: heldLeaseEvidence,
      transactionId: () => `tx-${'2'.repeat(32)}`,
    }).publish({
      projectRoot: root,
      overlay,
      sequence: '1',
      publishedAt: '2026-08-03T00:01:00.000Z',
      ...fixedDigests,
    });
    const originalParse = JSON.parse;
    let batchParses = 0;
    let recordParses = 0;
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string) => {
      if (text.includes('receipt-batch-')) {
        if (text.startsWith('[')) batchParses += 1;
        else if (text.startsWith('{')) recordParses += 1;
      }
      return originalParse(text);
    }) as typeof JSON.parse);

    const result = reader.readOverlayCurrentReceipt(root) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(batchParses).toBeGreaterThan(0);
    expect(recordParses).toBe(0);
  });

  it('fails closed with fixed results for missing CURRENT and authenticated payload drift', () => {
    const missingRoot = makeRoot();
    expect(reader.readOverlayCurrentReceipt(missingRoot)).toEqual({
      ok: false,
      errorCode: 'CURRENT_MISSING',
    });

    const manifestRoot = makeRoot();
    const manifestPublication = publish(manifestRoot);
    fs.appendFileSync(path.join(manifestPublication.generationPath, 'manifest.json'), ' ');
    expect(reader.readOverlayCurrentReceipt(manifestRoot)).toEqual({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
    });

    const shardRoot = makeRoot();
    const shardPublication = publish(shardRoot);
    const arrays = shardPublication.manifest.arrays as Array<{
      shards: Array<{ path: string }>;
    }>;
    const shardPath = path.join(shardPublication.generationPath, arrays[0].shards[0].path);
    fs.appendFileSync(shardPath, '{}\n');
    expect(reader.readOverlayCurrentReceipt(shardRoot)).toEqual({
      ok: false,
      errorCode: 'PAYLOAD_INVALID',
    });
  });

  it('detects an observed CURRENT A/B selector drift', () => {
    const root = makeRoot();
    publish(root);
    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    const originalRead = fs.readFileSync.bind(fs);
    let currentReads = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = originalRead(file, ...(args as []));
      if (typeof file !== 'string' || path.resolve(file) !== path.resolve(currentPath)) return bytes;
      currentReads += 1;
      return currentReads === 2 ? Buffer.concat([bytes as Buffer, Buffer.from(' ')]) : bytes;
    }) as typeof fs.readFileSync);

    expect(reader.readOverlayCurrentReceipt(root)).toEqual({
      ok: false,
      errorCode: 'SELECTOR_DRIFT',
    });
  });
});
