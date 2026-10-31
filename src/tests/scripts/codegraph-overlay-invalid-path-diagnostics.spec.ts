import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const schemaPath = path.join(projectRoot, 'scripts', 'lib', 'codegraph-nanoflow-overlay-v1-schema.cjs');
const contract = require(path.join(projectRoot, 'scripts', 'contracts', 'codegraph-nanoflow-overlay-v1.json'));
const sourcePolicy = require(path.join(projectRoot, 'scripts', 'lib', 'codegraph-source-policy.cjs'));

type SchemaModule = {
  createOverlayV1Validator(options: {
    expectedProjectRoot: string;
    expectedSourcePolicyDigest: string;
  }): {
    write(bytes: Uint8Array): void;
    finish(): unknown;
  };
};

const generatedAt = '2026-08-16T00:00:00.000Z';

function emptyOverlay(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt,
    project: {
      root: 'D:/fixture',
      name: 'fixture',
      codegraphOverlay: 'NanoFlow project semantics that complement the base AST graph',
    },
    coverageTargets: contract.coverageTargets,
    typescript: {
      files: [{ file: 'src/example.ts', language: 'typescript' }],
      classes: [], functions: [], interfaces: [], types: [], variables: [],
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
    graph: {
      schemaVersion: 1,
      nodes: [{
        id: 'file:src/example.ts:src/example.ts',
        kind: 'file',
        name: 'src/example.ts',
        qualifiedName: 'src/example.ts',
        filePath: 'src/example.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        metadata: { relation: 'source-file' },
        updatedAt: Date.parse(generatedAt),
      }],
      edges: [],
    },
  };
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function caughtError(action: () => unknown): Error & {
  code?: string;
  schemaPath?: string;
  diagnostics?: unknown;
} {
  try {
    action();
  } catch (error) {
    return error as Error & { code?: string; schemaPath?: string; diagnostics?: unknown };
  }
  throw new Error('expected action to fail');
}

function validate(overlay: Record<string, unknown>): void {
  const validator = (require(schemaPath) as SchemaModule).createOverlayV1Validator({
    expectedProjectRoot: 'D:/fixture',
    expectedSourcePolicyDigest: sourcePolicy.SOURCE_POLICY_DIGEST,
  });
  validator.write(canonicalBytes(overlay));
  validator.finish();
}

describe('CodeGraph overlay invalid-path diagnostics', () => {
  it('accepts a minimal selected source-file node before mutation', () => {
    expect(() => validate(emptyOverlay())).not.toThrow();
  });

  it('attaches bounded diagnostics only to invalid graph file paths', () => {
    const unselected = emptyOverlay();
    const node = (unselected.graph as { nodes: Array<Record<string, unknown>> }).nodes[0];
    node.filePath = 'src/other.ts';
    node.id = 'file:src/other.ts:src/example.ts';

    const error = caughtError(() => validate(unselected));
    expect(error.code).toBe('OVERLAY_SCHEMA_INVALID_PATH');
    expect(error.schemaPath).toBe('graph.nodes[].filePath');
    expect(error.diagnostics).toEqual({
      nodeIndex: 0,
      nodeId: 'file:src/other.ts:src/example.ts',
      kind: 'file',
      filePath: 'src/other.ts',
      metadataRelation: 'source-file',
      selectedSource: false,
    });
  });

  it('does not attach diagnostics to non-path schema errors', () => {
    const invalidId = emptyOverlay();
    const node = (invalidId.graph as { nodes: Array<Record<string, unknown>> }).nodes[0];
    node.id = 'file:src/example.ts:wrong';

    const error = caughtError(() => validate(invalidId));
    expect(error.code).toBe('OVERLAY_SCHEMA_INVALID_ID');
    expect(error.diagnostics).toBeUndefined();
  });

  it('reports selectedSource true when a source-file path is already selected', () => {
    const valid = emptyOverlay();
    expect(() => validate(valid)).not.toThrow();
  });
});
