import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const requireCjs = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const libRoot = path.join(repoRoot, 'scripts', 'lib');
const schemaPath = path.join(libRoot, 'codegraph-nanoflow-overlay-v1-schema.cjs');
const contractPath = path.join(repoRoot, 'scripts', 'contracts', 'codegraph-nanoflow-overlay-v1.json');
const currentOverlayPath = path.join(repoRoot, '.codegraph', 'nanoflow-overlay.json');
const SOURCE_POLICY_DIGEST = 'ca78ea5e17d32399faac676bcab26fc1d7f48186a89792774d37a6b8549d0ca3';
const SCHEMA_DIGEST = '3d4c1049024c8895f5e2fe5504bf2814b87d66211d93a9ff22bc901be8db9031';
const DESCRIPTOR_MANIFEST_DIGEST = 'a236349b6620e636a59263585ff532e7788c9706ea5de59774be233137edc5a6';
const GENERATED_AT = '2026-08-03T00:00:00.000Z';
const EXPECTED_DESCRIPTOR_DIGESTS = Object.freeze({
  typescript: 'cd2538e77f1abbe5aabe750e0a4ecda1807e006cecc2fc6acc03296dd7f2eabf',
  'angular-support': 'a68c9feed371bb4d107b7e458559431df0197a013e0434350f63285b38027bbc',
  'supabase-android': '7deba66271dd9253c05ff74b2000a3a6124a793da35c2c490d0e7bb03ae16e9d',
  graph: 'd351740e73e31bca9cb065ca104c5840275b7ed00d19bca5aa5c4088812f316a',
});
const EXPECTED_PRODUCER_NODE_ORDERS = Object.freeze([
  Object.freeze({
    kind: 'method',
    keys: Object.freeze([
      'id', 'kind', 'name', 'qualifiedName', 'filePath', 'language', 'startLine', 'endLine',
      'startColumn', 'endColumn', 'signature', 'decorators', 'returnType', 'isAsync', 'isStatic',
      'metadata', 'updatedAt',
    ]),
  }),
  Object.freeze({
    kind: 'property',
    keys: Object.freeze([
      'id', 'kind', 'name', 'qualifiedName', 'filePath', 'language', 'startLine', 'endLine',
      'startColumn', 'endColumn', 'signature', 'visibility', 'decorators', 'isStatic',
      'metadata', 'updatedAt',
    ]),
  }),
  Object.freeze({
    kind: 'method',
    keys: Object.freeze([
      'id', 'kind', 'name', 'qualifiedName', 'filePath', 'language', 'startLine', 'endLine',
      'startColumn', 'endColumn', 'signature', 'visibility', 'decorators', 'isAsync', 'isStatic',
      'metadata', 'updatedAt',
    ]),
  }),
  Object.freeze({
    kind: 'method',
    keys: Object.freeze([
      'id', 'kind', 'name', 'qualifiedName', 'filePath', 'language', 'startLine', 'endLine',
      'startColumn', 'endColumn', 'signature', 'visibility', 'decorators', 'isAsync', 'isStatic',
      'isAbstract', 'updatedAt',
    ]),
  }),
]);
const EXPECTED_PRODUCER_METADATA_ORDERS = Object.freeze([
  Object.freeze({
    relation: 'android-kotlin-property',
    keys: Object.freeze([
      'platform', 'relation', 'packageName', 'ownerName', 'ownerQualifiedName', 'isConst',
      'isMutable', 'isOverride', 'typeName', 'annotationNames',
    ]),
  }),
  Object.freeze({
    relation: 'android-kotlin-extends',
    keys: Object.freeze(['relation', 'typeName', 'targetName']),
  }),
]);
type ValidationResult = Readonly<{
  schemaVersion: number;
  schemaDigest: string;
  sourcePolicyDigest: string;
  artifact: Readonly<{ bytes: number; sha256: string }>;
  counts: Readonly<Record<string, number>>;
}>;
type ValidatorOptions = {
  expectedProjectRoot: string;
  expectedSourcePolicyDigest: string;
  expectedArtifact?: Readonly<{
    bytes: number;
    sha256: string;
    counts: Readonly<Record<string, number>>;
  }>;
};
type SchemaModule = {
  OVERLAY_V1_SCHEMA_VERSION: number;
  OVERLAY_V1_SCHEMA_DIGEST: string;
  OVERLAY_V1_LIMITS: Readonly<Record<string, number>>;
  OverlayV1SchemaError: new (...args: unknown[]) => Error & { code: string; schemaPath: string };
  createOverlayV1Validator(options: ValidatorOptions): {
    write(chunk: Uint8Array): void;
    finish(): ValidationResult;
  };
};
type Descriptor = Readonly<{
  name: string;
  descriptorDigest: string;
  objectRules: ReadonlyArray<readonly [string, readonly string[], ReadonlyArray<readonly string[]>]>;
  arrayPaths: readonly string[];
  scalarTypeGroups: ReadonlyArray<readonly [readonly string[], readonly string[]]>;
  nodeKinds?: readonly string[];
  edgeKinds?: readonly string[];
  nodeOrdersByKind?: ReadonlyArray<readonly [string, ReadonlyArray<readonly string[]>]>;
  edgeOrdersByKind?: ReadonlyArray<readonly [string, ReadonlyArray<readonly string[]>]>;
  nodeMetadataOrders?: ReadonlyArray<readonly [string, ReadonlyArray<readonly string[]>]>;
  edgeMetadataOrders?: ReadonlyArray<readonly [string, ReadonlyArray<readonly string[]>]>;
  nodeRelationsByKind?: ReadonlyArray<readonly [string, readonly string[]]>;
  edgeRelationsByKind?: ReadonlyArray<readonly [string, readonly string[]]>;
  createRuntime?: (options: unknown) => Record<string, unknown>;
}>;
function loadSchema(): SchemaModule {
  delete requireCjs.cache?.[requireCjs.resolve(schemaPath)];
  return requireCjs(schemaPath) as SchemaModule;
}
function loadDescriptor(fileName: string): Descriptor {
  const filePath = path.join(libRoot, fileName);
  delete requireCjs.cache?.[requireCjs.resolve(filePath)];
  return requireCjs(filePath) as Descriptor;
}
function contract(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(contractPath, 'utf8')) as Record<string, unknown>;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function descriptorDigest(descriptor: Descriptor): string {
  const { descriptorDigest: _literal, ...projection } = descriptor;
  const runtimeSource = descriptor.createRuntime
    ? Function.prototype.toString.call(descriptor.createRuntime) : '';
  const runtimeFrame = runtimeSource ? `\0${digestFrame('runtime-source', runtimeSource)}` : '';
  return sha256(`nanoflow-overlay-v1-descriptor\0${descriptor.name}\0${stableJson(projection)}${runtimeFrame}`);
}
function digestFrame(label: string, payload: string): string {
  return `${Buffer.byteLength(label)}:${label}${Buffer.byteLength(payload)}:${payload}`;
}
function schemaDigest(definition: Record<string, unknown>): string {
  const projection = { ...definition };
  delete projection.schemaDigest;
  const descriptorDigests = definition.descriptorDigests as Record<string, string>;
  const frames: ReadonlyArray<readonly [string, string]> = [
    ['contract', stableJson(projection)],
    ['source-policy', String(definition.sourcePolicyDigest)],
    ...Object.entries(descriptorDigests),
  ];
  return sha256(
    `nanoflow-overlay-schema-v1\0schema-digest-v1\0${frames.map(([label, payload]) => (
      digestFrame(label, payload)
    )).join('\0')}\0`,
  );
}
function deepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deepFrozen);
}
function emptyOverlay(projectRoot = 'D:/fixture'): Record<string, unknown> {
  const definition = contract() as { coverageTargets: string[] };
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    project: {
      root: projectRoot,
      name: 'fixture',
      codegraphOverlay: 'NanoFlow project semantics that complement the base AST graph',
    },
    coverageTargets: definition.coverageTargets,
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
function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function createValidator(schema = loadSchema(), options: Partial<ValidatorOptions> = {}) {
  return schema.createOverlayV1Validator({
    expectedProjectRoot: 'D:/fixture',
    expectedSourcePolicyDigest: SOURCE_POLICY_DIGEST,
    ...options,
  });
}
function validateBytes(
  bytes: Uint8Array,
  chunkSizes: readonly number[] = [bytes.byteLength],
  schema = loadSchema(),
  options: Partial<ValidatorOptions> = {},
): ValidationResult {
  const validator = createValidator(schema, options);
  let offset = 0;
  for (const requested of chunkSizes) {
    if (offset >= bytes.byteLength) break;
    const size = Math.max(0, requested);
    validator.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)));
    offset += size;
  }
  if (offset < bytes.byteLength) validator.write(bytes.subarray(offset));
  return validator.finish();
}
function caughtError(action: () => unknown): Error & { code?: string; schemaPath?: string } {
  try {
    action();
  } catch (error) {
    return error as Error & { code?: string; schemaPath?: string };
  }
  throw new Error('expected action to fail');
}
function expectCode(action: () => unknown, code: string, schemaPath?: string): void {
  const error = caughtError(action);
  expect(error.code).toBe(code);
  if (schemaPath !== undefined) expect(error.schemaPath).toBe(schemaPath);
  expect(error.message).toBe(code);
}
function expectVmDigestMismatch(overrides: Map<string, unknown>): void {
  expectCode(() => createValidator(loadSchemaVm('', overrides) as SchemaModule), 'OVERLAY_SCHEMA_DIGEST_MISMATCH');
}
function graphFileNode(filePath: string, name = filePath, idSuffix = name): Record<string, unknown> {
  return {
    id: `file:${filePath}:${idSuffix}`,
    kind: 'file',
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    metadata: { relation: 'source-file' },
    updatedAt: Date.parse(GENERATED_AT),
  };
}
function graphContextRouteNode(index: number): Record<string, unknown> {
  const name = 'same route';
  return {
    id: `variable:docs/context7/catalog.json:context7-retrieval-route:${index}`,
    kind: 'variable', name, qualifiedName: name, filePath: 'docs/context7/catalog.json',
    language: 'unknown', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
    metadata: {
      source: 'docs/context7/catalog.json', relation: 'context7-retrieval-route',
      query: name, primary: 'docs/context7/index.md', secondary: [],
    },
    updatedAt: Date.parse(GENERATED_AT),
  };
}
function overlayWithFiles(paths: readonly string[]): Record<string, unknown> {
  const overlay = emptyOverlay();
  (overlay.typescript as { files: unknown[] }).files = paths.map(file => ({ file, language: 'typescript' }));
  (overlay.graph as { nodes: unknown[] }).nodes = paths.map(file => graphFileNode(file));
  return overlay;
}
function overlayWithReference(metadata: Record<string, unknown>, kind = 'references'): Record<string, unknown> {
  const overlay = overlayWithFiles(['src/a.ts', 'src/b.ts']);
  (overlay.graph as { edges: unknown[] }).edges.push({
    kind,
    source: 'file:src/a.ts:src/a.ts',
    target: 'file:src/b.ts:src/b.ts',
    metadata,
  });
  return overlay;
}
function loadSchemaVm(
  suffix = '',
  overrides = new Map<string, unknown>(),
  globals: Record<string, unknown> = {},
): Record<string, unknown> {
  const baseRequire = createRequire(schemaPath);
  const module = { exports: {} as Record<string, unknown> };
  const source = `${fs.readFileSync(schemaPath, 'utf8')}\n${suffix}`;
  vm.runInNewContext(source, {
    Buffer, Intl, Map, Object, Set, Symbol, TextDecoder, Uint8Array, process,
    module, exports: module.exports,
    require: (request: string) => overrides.has(request) ? overrides.get(request) : baseRequire(request),
    ...globals,
  }, { filename: schemaPath });
  return module.exports;
}
function loadPrivateLimitFactory(): (
  options: ValidatorOptions,
  limits: Readonly<Record<string, number>>,
) => ReturnType<SchemaModule['createOverlayV1Validator']> {
  return loadSchemaVm('module.exports.__testCreate = createOverlayV1ValidatorWithLimits;')
    .__testCreate as ReturnType<typeof loadPrivateLimitFactory>;
}
describe('CodeGraph NanoFlow Overlay v1 schema authority predecessor', () => {
  it('pins independently framed descriptor and aggregate known-answer digests', () => {
    const descriptors = [
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-typescript.cjs'),
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-angular-support.cjs'),
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs'),
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-graph.cjs'),
    ];
    const definition = contract();
    for (const descriptor of descriptors) {
      const expected = EXPECTED_DESCRIPTOR_DIGESTS[descriptor.name as keyof typeof EXPECTED_DESCRIPTOR_DIGESTS];
      expect(descriptor.descriptorDigest).toBe(expected);
      expect(descriptorDigest(descriptor)).toBe(expected);
      expect(deepFrozen(descriptor)).toBe(true);
    }
    const manifestEntries = Object.entries(EXPECTED_DESCRIPTOR_DIGESTS).map(([name, digest]) => ({ name, digest }));
    expect(sha256(`nanoflow-overlay-schema-v1\0descriptor-manifest-v1\0${stableJson(manifestEntries)}`))
      .toBe(DESCRIPTOR_MANIFEST_DIGEST);
    expect(definition.descriptorManifestDigest).toBe(DESCRIPTOR_MANIFEST_DIGEST);
    expect(definition.schemaDigest).toBe(SCHEMA_DIGEST);
    expect(schemaDigest(definition)).toBe(SCHEMA_DIGEST);
  });
  it('freezes the full descriptor denominator, kinds, relation shapes, and order variants', () => {
    const descriptors = [
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-typescript.cjs'),
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-angular-support.cjs'),
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs'),
      loadDescriptor('codegraph-nanoflow-overlay-v1-schema-graph.cjs'),
    ];
    const graph = descriptors.at(-1) as Descriptor;
    const objectPaths = new Set(descriptors.flatMap(item => item.objectRules.map(([schemaPath]) => schemaPath)));
    const arrayPaths = new Set(descriptors.flatMap(item => item.arrayPaths));
    const scalarPaths = new Set(descriptors.flatMap(item => item.scalarTypeGroups.flatMap(([, paths]) => paths)));
    const relationValues = new Set([
      ...(graph.nodeRelationsByKind ?? []).flatMap(([, values]) => values),
      ...(graph.edgeRelationsByKind ?? []).flatMap(([, values]) => values),
    ]);
    const nodeMetadataShapes = new Set((graph.nodeMetadataOrders ?? []).flatMap(([, orders]) => (
      orders.map(order => stableJson([...order]))
    )));
    const edgeMetadataShapes = new Set((graph.edgeMetadataOrders ?? []).flatMap(([, orders]) => (
      orders.map(order => stableJson([...order]))
    )));
    expect([objectPaths.size, arrayPaths.size, scalarPaths.size]).toEqual([240, 636, 1_897]);
    expect(graph.nodeKinds).toEqual([
      'class', 'component', 'constant', 'enum', 'enum_member', 'export', 'file', 'function',
      'import', 'interface', 'method', 'namespace', 'parameter', 'property', 'route', 'type_alias', 'variable',
    ]);
    expect(graph.edgeKinds).toEqual([
      'calls', 'contains', 'decorates', 'exports', 'extends', 'implements', 'imports',
      'instantiates', 'overrides', 'references', 'returns', 'type_of',
    ]);
    expect(relationValues.size).toBe(160);
    expect(nodeMetadataShapes.size).toBe(124);
    expect(edgeMetadataShapes.size).toBe(147);
    const globalOrders = (schemaPath: string) => new Set(graph.objectRules.find(([path]) => path === schemaPath)?.[2]
      .map(order => stableJson(order)) ?? []);
    for (const [schemaPath, groups] of [['graph.nodes[]', graph.nodeOrdersByKind], ['graph.edges[]', graph.edgeOrdersByKind],
      ['graph.nodes[].metadata', graph.nodeMetadataOrders], ['graph.edges[].metadata', graph.edgeMetadataOrders]] as const) {
      const allowed = globalOrders(schemaPath);
      for (const order of (groups ?? []).flatMap(([, orders]) => orders)) expect(allowed.has(stableJson(order))).toBe(true);
    }
    expect(descriptors.some(item => item.objectRules.some(([, , orders]) => orders.length > 1))).toBe(true);
    for (const fileName of [
      'codegraph-nanoflow-overlay-v1-schema-typescript.cjs',
      'codegraph-nanoflow-overlay-v1-schema-angular-support.cjs',
      'codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs',
      'codegraph-nanoflow-overlay-v1-schema-graph.cjs',
    ]) expect(fs.readFileSync(path.join(libRoot, fileName), 'utf8')).not.toContain('tokens truncated');
  });

  it('pins every observed producer node order without accepting crossed variants', () => {
    const graph = loadDescriptor('codegraph-nanoflow-overlay-v1-schema-graph.cjs');
    const byKind = new Map(graph.nodeOrdersByKind ?? []);
    for (const { kind, keys } of EXPECTED_PRODUCER_NODE_ORDERS) {
      const orders = byKind.get(kind) ?? [];
      expect(orders.some(order => stableJson(order) === stableJson(keys))).toBe(true);
      const crossed = [...keys];
      const penultimate = crossed.length - 2;
      [crossed[penultimate], crossed[penultimate + 1]] = [crossed[penultimate + 1], crossed[penultimate]];
      expect(orders.some(order => stableJson(order) === stableJson(crossed))).toBe(false);
    }
  });

  it('pins every observed producer metadata order without relation-wide widening', () => {
    const graph = loadDescriptor('codegraph-nanoflow-overlay-v1-schema-graph.cjs');
    const byRelation = new Map(graph.nodeMetadataOrders ?? []);
    for (const { relation, keys } of EXPECTED_PRODUCER_METADATA_ORDERS) {
      const orders = byRelation.get(relation) ?? [];
      expect(orders.some(order => stableJson(order) === stableJson(keys))).toBe(true);
      const crossed = [...keys];
      const penultimate = crossed.length - 2;
      [crossed[penultimate], crossed[penultimate + 1]] = [crossed[penultimate + 1], crossed[penultimate]];
      expect(orders.some(order => stableJson(order) === stableJson(crossed))).toBe(false);
    }
  });

  it('binds android-kotlin-extends to the producer-emitted variable node kind only', () => {
    const graph = loadDescriptor('codegraph-nanoflow-overlay-v1-schema-graph.cjs');
    const relationsByKind = new Map(graph.nodeRelationsByKind ?? []);
    expect(relationsByKind.get('variable')).toContain('android-kotlin-extends');
    expect([...relationsByKind.entries()].filter(([, relations]) => (
      relations.includes('android-kotlin-extends')
    )).map(([kind]) => kind)).toEqual(['variable']);
  });

  it('declares string type references for deeply nested function parameters', () => {
    const descriptor = loadDescriptor('codegraph-nanoflow-overlay-v1-schema-typescript.cjs');
    const scalarStringPaths = descriptor.scalarTypeGroups
      .filter(([types]) => types.length === 1 && types[0] === 'string')
      .flatMap(([, paths]) => paths);
    expect(scalarStringPaths).toContain(
      'typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].typeReferences[]',
    );
  });

  it('declares Kotlin enum modifier values as strings', () => {
    const descriptor = loadDescriptor('codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs');
    const scalarStringPaths = descriptor.scalarTypeGroups
      .filter(([types]) => types.length === 1 && types[0] === 'string')
      .flatMap(([, paths]) => paths);
    expect(scalarStringPaths).toContain('android.kotlinEnums[].modifiers[]');
  });

  it('declares Kotlin constructor visibility in the exact constructor shape', () => {
    const descriptor = loadDescriptor('codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs');
    const rule = descriptor.objectRules.find(([path]) => path === 'android.kotlinConstructors[]');
    expect(rule?.[1]).toContain('visibility');
    expect(rule?.[2].some(order => order.includes('visibility'))).toBe(true);
  });
  it('exports a stable recursively frozen predecessor contract with explicit denominators', () => {
    const schema = loadSchema();
    const definition = contract() as Record<string, unknown>;
    expect(schema.OVERLAY_V1_SCHEMA_VERSION).toBe(1);
    expect(schema.OVERLAY_V1_SCHEMA_DIGEST).toBe(SCHEMA_DIGEST);
    expect(schema.OVERLAY_V1_LIMITS).toEqual(expect.objectContaining({
      artifactBytes: 335_544_320,
      inputWindowBytes: 65_536,
      decodedStringBytes: 201_326_592,
      valueTokens: 8_000_000,
      stringTokens: 10_000_000,
      endpointIdBytes: 33_554_432,
      pathWitnessBytes: 16_777_216,
      graphNodes: 200_000,
      graphEdges: 400_000,
      typescriptVariables: 10_000,
    }));
    expect(deepFrozen(schema.OVERLAY_V1_LIMITS)).toBe(true);
    expect(definition.role).toBe('schema-authority-predecessor');
    expect(definition.deferredAdoption).toEqual(expect.objectContaining({
      runtime: expect.objectContaining({ status: 'deferred' }),
      requiredGate: expect.objectContaining({ status: 'deferred' }),
    }));
    expect(definition.pathPolicy).toEqual(expect.objectContaining({
      repositoryFieldNames: [
        'configPath', 'docPath', 'file', 'filePath', 'kotlinFile', 'manifestFile',
        'parentConfigPath', 'resourcePath', 'sourceFile', 'sourceFiles', 'sourcePath',
        'sourcePaths', 'styleUrls', 'targetFile', 'templateFile', 'templateUrl', 'tests',
      ],
      directoryFieldNames: ['sourcePath', 'sourcePaths'],
      graphWitnessField: 'graph.nodes[].filePath',
      externalGraphFilePathFormats: ['https-url', 'node-builtin', 'bare-package-specifier'],
      projectRootComparison: 'slash-normalized, trailing-slash-insensitive, ordinal case-sensitive',
    }));
  });
  it('accepts canonical bytes in one caller chunk and one-byte adversarial chunks with fixed windows', () => {
    const schema = loadSchema();
    const bytes = canonicalBytes(emptyOverlay());
    expect(bytes.length + 1).toBe(3_664);
    const oneChunk = validateBytes(bytes, [bytes.length], schema);
    const byteChunks = validateBytes(bytes, Array.from({ length: bytes.length }, () => 1), schema);
    expect(oneChunk).toEqual(byteChunks);
    expect(oneChunk.artifact).toEqual({ bytes: bytes.length, sha256: sha256(bytes) });
    expect(oneChunk.counts).toEqual(expect.objectContaining({
      maxInputWindowBytes: expect.any(Number),
      maxBufferedTokenBytes: expect.any(Number),
      graphNodes: 0,
      graphEdges: 0,
    }));
    expect(oneChunk.counts.maxInputWindowBytes).toBeLessThanOrEqual(65_536);
    for (let split = 0; split <= bytes.length; split += 1) {
      expect(validateBytes(bytes, [split], schema)).toEqual(oneChunk);
    }
    expect(Object.keys(oneChunk)).toEqual([
      'schemaVersion', 'schemaDigest', 'sourcePolicyDigest', 'artifact', 'counts',
    ]);
    expect(deepFrozen(oneChunk)).toBe(true);
    const longValue = emptyOverlay();
    (longValue.project as Record<string, unknown>).name = 'x'.repeat(8_192);
    const longBytes = canonicalBytes(longValue);
    const longResult = validateBytes(longBytes, Array.from({ length: longBytes.length }, () => 1), schema);
    expect(longResult.counts.stringScanCodeUnits).toBeLessThanOrEqual(longBytes.length);
  }, 15_000);
  it('counts key and scalar string tokens as decoded UTF-8 bytes and uses root depth one', () => {
    const result = validateBytes(canonicalBytes(emptyOverlay()));
    expect(result.counts.stringTokens).toBe(result.counts.keyTokens + result.counts.stringValues);
    expect(result.counts.decodedStringBytes).toBeGreaterThan(0);
    expect(result.counts.maxDepth).toBe(3);
  });
  it('rejects BOM and invalid UTF-8 across every split boundary', () => {
    const valid = canonicalBytes(emptyOverlay());
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]);
    for (const split of [1, 2, 3]) expectCode(() => validateBytes(bom, [split]), 'OVERLAY_SCHEMA_BOM');
    const malformed = [[0x80], [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80],
      [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff],
      [0xc2], [0xe2, 0x82], [0xf0, 0x9f, 0x92], [0xe2, 0x28, 0xa1], [0xf0, 0x28, 0x8c, 0xbc], [0xe2, 0x82, 0x41]];
    for (const vector of malformed) for (let split = 1; split <= vector.length + 1; split += 1) {
      const invalid = Buffer.concat([valid.subarray(0, 1), Buffer.from(vector), valid.subarray(1)]);
      expectCode(() => validateBytes(invalid, [split]), 'OVERLAY_SCHEMA_INVALID_UTF8');
    }
  });
  it('rejects unpaired surrogate escapes, duplicate keys, and every truncated parser prefix', () => {
    const valid = canonicalBytes(emptyOverlay());
    const duplicate = Buffer.from(valid.toString('utf8').replace(
      '"schemaVersion": 1,',
      '"schemaVersion": 1,\n  "schemaVersion": 1,',
    ));
    const surrogate = Buffer.from(valid.toString('utf8').replace('"fixture"', '"\\ud800"'));
    expectCode(() => validateBytes(duplicate), 'OVERLAY_SCHEMA_DUPLICATE_KEY');
    expectCode(() => validateBytes(surrogate), 'OVERLAY_SCHEMA_NON_CANONICAL_JSON');
    const schema = loadSchema();
    for (let length = 0; length < valid.length; length += 1) {
      expectCode(() => validateBytes(valid.subarray(0, length), [length || 1], schema), 'OVERLAY_SCHEMA_TRUNCATED');
    }
  });
  it.each(['-0', '01', '1.0', '1e0', '1E+0', '9007199254740992', '1e309'])(
    'rejects non-canonical or unsafe numeric token %s',
    raw => {
      const mutated = canonicalBytes(emptyOverlay()).toString('utf8').replace('"schemaVersion": 1', `"schemaVersion": ${raw}`);
      const error = caughtError(() => validateBytes(Buffer.from(mutated)));
      expect(['OVERLAY_SCHEMA_NON_CANONICAL_JSON', 'OVERLAY_SCHEMA_TOKEN_LIMIT', 'OVERLAY_SCHEMA_VALUE'])
        .toContain(error.code);
    },
  );

  it('enforces unfinished numeric tokens and array cardinality during write at every split', () => {
    const createWithLimits = loadPrivateLimitFactory();
    const schema = loadSchema();
    const options = { expectedProjectRoot: 'D:/fixture', expectedSourcePolicyDigest: SOURCE_POLICY_DIGEST };
    const head = Buffer.from('{\n  "schemaVersion": ');
    const numeric = Buffer.from('1'.repeat(65));
    const exactNumeric = createWithLimits(options, schema.OVERLAY_V1_LIMITS);
    exactNumeric.write(Buffer.concat([head, numeric.subarray(0, 64)]));
    expectCode(() => exactNumeric.write(numeric.subarray(64)), 'OVERLAY_SCHEMA_TOKEN_LIMIT');
    for (let split = 0; split <= numeric.length; split += 1) {
      const validator = createWithLimits(options, schema.OVERLAY_V1_LIMITS);
      expectCode(() => {
        validator.write(Buffer.concat([head, numeric.subarray(0, split)]));
        validator.write(numeric.subarray(split));
      }, 'OVERLAY_SCHEMA_TOKEN_LIMIT');
    }
    const adversarial = createWithLimits(options, schema.OVERLAY_V1_LIMITS);
    adversarial.write(head);
    expectCode(() => adversarial.write(Buffer.alloc(1_048_576, 0x31)), 'OVERLAY_SCHEMA_TOKEN_LIMIT');
    const value = overlayWithFiles(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const bytes = canonicalBytes(value);
    const close = bytes.indexOf(Buffer.from('\n    ],'), bytes.indexOf(Buffer.from('"nodes"')));
    const prefix = bytes.subarray(0, close);
    const exactArray = createWithLimits(options, { ...schema.OVERLAY_V1_LIMITS, graphNodes: 2 });
    exactArray.write(canonicalBytes(overlayWithFiles(['src/a.ts', 'src/b.ts'])));
    expect(() => exactArray.finish()).not.toThrow();
    for (let split = 0; split <= prefix.length; split += 1) {
      const validator = createWithLimits(options, { ...schema.OVERLAY_V1_LIMITS, graphNodes: 2 });
      expectCode(() => {
        validator.write(prefix.subarray(0, split));
        validator.write(prefix.subarray(split));
      }, 'OVERLAY_SCHEMA_ARRAY_LIMIT', 'graph.nodes');
    }
  }, 15_000);

  it('preserves relation-specific key orders and binds realtime lifecycle IDs to the declared channel scope', () => {
    expectCode(() => validateBytes(canonicalBytes(overlayWithReference({
      relation: 'edge-function-invoke', path: 'src/a.ts', invokeName: 'invoke',
    }))), 'OVERLAY_SCHEMA_UNKNOWN_KEY', 'graph.edges[].metadata');
    expectCode(() => validateBytes(canonicalBytes(overlayWithReference({
      relation: 'edge-function-route', invokeName: 'invoke', path: 'src/a.ts',
    }))), 'OVERLAY_SCHEMA_UNKNOWN_KEY', 'graph.edges[].metadata');
    const lifecycle = overlayWithFiles(['src/realtime.ts']);
    const { metadata: _metadata, updatedAt, ...identity } = graphFileNode('src/realtime.ts', 'removeChannel channel',
      'supabase-realtime-remove-channel:fixtureOwner:channel');
    const node = { ...identity, id: String(identity.id).replace(/^file:/, 'variable:'), kind: 'variable',
      qualifiedName: 'fixtureOwner', signature: 'realtime removeChannel channel',
      metadata: { relation: 'supabase-realtime-remove-channel', action: 'removeChannel',
        owner: 'fixtureOwner', channelVariable: 'channel' }, updatedAt };
    (lifecycle.graph as { nodes: unknown[] }).nodes = [node];
    expect(() => validateBytes(canonicalBytes(lifecycle))).not.toThrow();
    node.id = 'variable:src/realtime.ts:supabase-realtime-remove-channel:fixtureOwner:other';
    expectCode(() => validateBytes(canonicalBytes(lifecycle)), 'OVERLAY_SCHEMA_INVALID_ID', 'graph.nodes[].id');
  });

  it('binds the schema digest to frozen loaded descriptor and contract contents', () => {
    const originalGraph = loadDescriptor('codegraph-nanoflow-overlay-v1-schema-graph.cjs') as Descriptor & {
      createRuntime: (options: unknown) => Record<string, unknown>;
    };
    const graph = JSON.parse(JSON.stringify(originalGraph)) as Descriptor;
    const graphRule = graph.objectRules.find(([schemaPath]) => schemaPath === 'graph') as [string, string[], string[][]];
    graphRule[1].push('canary');
    graphRule[2][0].push('canary');
    expectVmDigestMismatch(new Map([['./codegraph-nanoflow-overlay-v1-schema-graph.cjs', graph]]));
    const runtimeBypass = { ...originalGraph };
    Object.defineProperty(runtimeBypass, 'createRuntime', { value: (options: unknown) => Object.freeze({
      ...originalGraph.createRuntime(options), validateNode: () => undefined, validateEdge: () => undefined,
    }) });
    expectVmDigestMismatch(new Map([['./codegraph-nanoflow-overlay-v1-schema-graph.cjs', runtimeBypass]]));
    const widenedContract = contract() as { coverageTargets: string[] };
    widenedContract.coverageTargets.push('runtime widening');
    expectVmDigestMismatch(new Map([['../contracts/codegraph-nanoflow-overlay-v1.json', widenedContract]]));
    const frozenContract = contract() as { coverageTargets: string[] };
    loadSchemaVm('', new Map([['../contracts/codegraph-nanoflow-overlay-v1.json', frozenContract]]));
    expect(deepFrozen(frozenContract)).toBe(true);
    expect(() => frozenContract.coverageTargets.push('runtime widening')).toThrow();
  });

  it('rejects unknown keys at every authority level without reflecting values', () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      value => { value.canary = 'root-secret'; },
      value => { (value.project as Record<string, unknown>).canary = 'project-secret'; },
      value => { (value.typescript as Record<string, unknown>).canary = 'typescript-secret'; },
      value => { (value.graph as Record<string, unknown>).preservedGraphField = 'graph-secret'; },
      value => {
        const graph = (overlayWithFiles(['src/example.ts']).graph as { nodes: Array<Record<string, unknown>> });
        (graph.nodes[0].metadata as Record<string, unknown>).canary = 'metadata-secret';
        value.typescript = overlayWithFiles(['src/example.ts']).typescript;
        value.graph = graph;
      },
    ];
    for (const mutate of mutations) {
      const value = emptyOverlay();
      mutate(value);
      const error = caughtError(() => validateBytes(canonicalBytes(value)));
      expect(error.code).toBe('OVERLAY_SCHEMA_UNKNOWN_KEY');
      expect(error.message).not.toMatch(/secret|canary|preservedGraphField/i);
    }
  });

  it('distinguishes missing keys, wrong types, and invalid exact order variants', () => {
    const missing = emptyOverlay();
    delete (missing.project as Record<string, unknown>).name;
    expectCode(() => validateBytes(canonicalBytes(missing)), 'OVERLAY_SCHEMA_MISSING_KEY', 'project');
    const wrongType = emptyOverlay();
    wrongType.schemaVersion = '1';
    expectCode(() => validateBytes(canonicalBytes(wrongType)), 'OVERLAY_SCHEMA_TYPE', 'schemaVersion');
    const nullableBooleans = emptyOverlay();
    (nullableBooleans.angular as { pipes: unknown[] }).pipes = [{ className: 'P', file: 'src/p.ts', name: 'p', standalone: null, pure: null, line: 1, tests: [], testMappings: [] }];
    expect(() => validateBytes(canonicalBytes(nullableBooleans))).not.toThrow();
    const reordered = canonicalBytes(emptyOverlay()).toString('utf8').replace(
      '"root": "D:/fixture",\n    "name": "fixture"',
      '"name": "fixture",\n    "root": "D:/fixture"',
    );
    expectCode(() => validateBytes(Buffer.from(reordered)), 'OVERLAY_SCHEMA_NON_CANONICAL_JSON', 'project');
  });

  it('accepts the producer order for partial indexes with an explicit method', () => {
    const value = emptyOverlay();
    (value.supabase as { migrations: unknown[] }).migrations = [{
      name: '20260809000100_partial_gin_index.sql',
      file: 'supabase/migrations/20260809000100_partial_gin_index.sql',
      tests: [],
      testMappings: [],
      riskTags: [],
      affectedTables: [],
      rlsDetails: [],
      realtimePublicationDetails: [],
      viewDetails: [],
      policies: [],
      policyDetails: [],
      privilegeDetails: [],
      functionDetails: [],
      triggerDetails: [],
      indexDetails: [{
        name: 'idx_example_payload',
        table: 'public.example',
        columns: ['payload'],
        method: 'gin',
        unique: false,
        concurrently: false,
        predicate: 'deleted_at is null',
        line: 1,
      }],
      constraintDetails: [],
      constraintValidationDetails: [],
    }];

    expect(() => validateBytes(canonicalBytes(value))).not.toThrow();
  });

  it('enforces path fields, case witnesses, node ID prefixes, timestamps, and selected sources', () => {
    const invalidPath = emptyOverlay();
    (invalidPath.typescript as { files: unknown[] }).files = [{ file: '../escape.ts', language: 'typescript' }];
    expectCode(() => validateBytes(canonicalBytes(invalidPath)), 'OVERLAY_SCHEMA_INVALID_PATH');
    const externalTraversal = emptyOverlay();
    (externalTraversal.graph as { nodes: unknown[] }).nodes.push(graphFileNode('pkg/../escape'));
    expectCode(() => validateBytes(canonicalBytes(externalTraversal)), 'OVERLAY_SCHEMA_INVALID_PATH');
    const collision = overlayWithFiles(['src/A.ts', 'src/a.ts']);
    expectCode(() => validateBytes(canonicalBytes(collision)), 'OVERLAY_SCHEMA_CASE_COLLISION');
    for (const [suffix, qualifiedName, name] of [
      ['wrong', null, null], ['wrong:src/example.ts', null, null], ['', '', ''],
    ] as const) {
      const invalidId = overlayWithFiles(['src/example.ts']);
      const node = (invalidId.graph as { nodes: Array<Record<string, unknown>> }).nodes[0];
      Object.assign(node, { id: `file:src/example.ts:${suffix}` }, name === null ? {} : { name },
        qualifiedName === null ? {} : { qualifiedName });
      expectCode(() => validateBytes(canonicalBytes(invalidId)), 'OVERLAY_SCHEMA_INVALID_ID', 'graph.nodes[].id');
    }
    for (const [sourcePath, code] of [
      ['../escape.ts', 'OVERLAY_SCHEMA_INVALID_PATH'], ['C:/escape.ts', 'OVERLAY_SCHEMA_INVALID_PATH'],
      ['src//escape.ts', 'OVERLAY_SCHEMA_INVALID_PATH'], ['Src/example.ts', 'OVERLAY_SCHEMA_CASE_COLLISION'],
    ]) {
      const invalidNodeMetadata = overlayWithFiles(['src/example.ts']);
      const graphNode = (invalidNodeMetadata.graph as { nodes: Array<Record<string, unknown>> }).nodes[0];
      graphNode.metadata = { relation: 'context7-source-path', source: 'fixture', sourcePath };
      expectCode(() => validateBytes(canonicalBytes(invalidNodeMetadata)), code);

      const edgeSourcePath = code === 'OVERLAY_SCHEMA_CASE_COLLISION' ? 'Src/A.ts' : sourcePath;
      const invalidEdgeMetadata = overlayWithReference({ relation: 'edge-function-source', sourceFile: edgeSourcePath }, 'imports');
      expectCode(() => validateBytes(canonicalBytes(invalidEdgeMetadata)), code);
    }
    const directorySourcePath = overlayWithFiles(['src/example.ts']);
    const directoryNode = (directorySourcePath.graph as { nodes: Array<Record<string, unknown>> }).nodes[0];
    directoryNode.metadata = { relation: 'context7-source-path', source: 'fixture', sourcePath: 'android/' };
    expect(() => validateBytes(canonicalBytes(directorySourcePath))).not.toThrow();
    const wrongTimestamp = overlayWithFiles(['src/example.ts']);
    ((wrongTimestamp.graph as { nodes: Array<Record<string, unknown>> }).nodes[0]).updatedAt = 1;
    expectCode(() => validateBytes(canonicalBytes(wrongTimestamp)), 'OVERLAY_SCHEMA_VALUE', 'graph.nodes[].updatedAt');
    const impossibleDate = emptyOverlay();
    impossibleDate.generatedAt = '2026-02-30T00:00:00.000Z';
    expectCode(() => validateBytes(canonicalBytes(impossibleDate)), 'OVERLAY_SCHEMA_VALUE', 'generatedAt');
    for (const [field, value] of [['startLine', 0], ['endLine', -1], ['startColumn', -1], ['endColumn', -1]] as const) {
      const invalidCoordinate = overlayWithFiles(['src/example.ts']);
      ((invalidCoordinate.graph as { nodes: Array<Record<string, unknown>> }).nodes[0])[field] = value;
      expectCode(() => validateBytes(canonicalBytes(invalidCoordinate)), 'OVERLAY_SCHEMA_VALUE');
    }
    const invalidBootstrap = overlayWithReference({ relation: 'angular-app-provider', provider: 'P',
      providerKind: 'value', bootstrapComponent: 'App', bootstrapLine: 0, arguments: [], endLine: 1 });
    expectCode(() => validateBytes(canonicalBytes(invalidBootstrap)), 'OVERLAY_SCHEMA_VALUE',
      'graph.edges[].metadata.bootstrapLine');
    const unselected = overlayWithFiles(['src/example.ts']);
    ((unselected.graph as { nodes: Array<Record<string, unknown>> }).nodes[0]).filePath = 'src/other.ts';
    ((unselected.graph as { nodes: Array<Record<string, unknown>> }).nodes[0]).id = 'file:src/other.ts:src/example.ts';
    expectCode(() => validateBytes(canonicalBytes(unselected)), 'OVERLAY_SCHEMA_INVALID_PATH', 'graph.nodes[].filePath');
  });
  it('enforces graph array order while treating producer-stable primary-key ties deterministically', () => {
    const unsorted = overlayWithFiles(['src/b.ts', 'src/a.ts']);
    expectCode(() => validateBytes(canonicalBytes(unsorted)), 'OVERLAY_SCHEMA_ARRAY_ORDER', 'graph.nodes');

    const tied = emptyOverlay();
    const nodes = (tied.graph as { nodes: Array<Record<string, unknown>> }).nodes;
    nodes.push(graphContextRouteNode(0), graphContextRouteNode(1));
    const result = validateBytes(canonicalBytes(tied));
    expect(result.counts).toEqual(expect.objectContaining({ nodeTieGroups: 1, nodeTieExtraItems: 1 }));

    expectCode(() => loadSchemaVm('', new Map(), {
      Intl: { Collator: class { resolvedOptions(): object { return { locale: 'en-US' }; } } },
    }), 'OVERLAY_SCHEMA_ORDERING_RUNTIME_MISMATCH');
  });

  it('rejects duplicate nodes, dangling endpoints, and relation/metadata mutations', () => {
    const duplicate = overlayWithFiles(['src/example.ts']);
    (duplicate.graph as { nodes: unknown[] }).nodes.push(graphFileNode('src/example.ts'));
    expectCode(() => validateBytes(canonicalBytes(duplicate)), 'OVERLAY_SCHEMA_DUPLICATE_ID', 'graph.nodes[]');

    const dangling = overlayWithFiles(['src/example.ts']);
    (dangling.graph as { edges: unknown[] }).edges.push({
      kind: 'calls',
      source: 'file:src/example.ts:src/example.ts',
      target: 'missing',
      metadata: { relation: 'source-file' },
    });
    expectCode(() => validateBytes(canonicalBytes(dangling)), 'OVERLAY_SCHEMA_DANGLING_EDGE', 'graph.edges[]');
    const wrongRelation = overlayWithFiles(['src/example.ts']);
    const node = (wrongRelation.graph as { nodes: Array<Record<string, unknown>> }).nodes[0];
    node.metadata = { relation: 'template-binding' };
    expectCode(() => validateBytes(canonicalBytes(wrongRelation)), 'OVERLAY_SCHEMA_RELATION_KIND');
  });
  it('accepts equality limits and rejects limit plus one through a private test-only seam', () => {
    const createWithLimits = loadPrivateLimitFactory();
    const schema = loadSchema();
    const bytes = canonicalBytes(emptyOverlay());
    const options = { expectedProjectRoot: 'D:/fixture', expectedSourcePolicyDigest: SOURCE_POLICY_DIGEST };
    const equal = createWithLimits(options, { ...schema.OVERLAY_V1_LIMITS, artifactBytes: bytes.length });
    equal.write(bytes);
    expect(equal.finish().artifact.bytes).toBe(bytes.length);
    const plusOne = createWithLimits(options, { ...schema.OVERLAY_V1_LIMITS, artifactBytes: bytes.length - 1 });
    expectCode(() => plusOne.write(bytes), 'OVERLAY_SCHEMA_ARTIFACT_LIMIT');
    const atStringLimit = emptyOverlay();
    (atStringLimit.project as Record<string, unknown>).name = 'a'.repeat(128);
    const stringEqual = createWithLimits(options, { ...schema.OVERLAY_V1_LIMITS, singleStringBytes: 128 });
    stringEqual.write(canonicalBytes(atStringLimit));
    expect(stringEqual.finish().counts.maxStringBytes).toBeGreaterThanOrEqual(128);
    const overStringLimit = emptyOverlay();
    (overStringLimit.project as Record<string, unknown>).name = 'a'.repeat(129);
    const stringPlusOne = createWithLimits(options, { ...schema.OVERLAY_V1_LIMITS, singleStringBytes: 128 });
    expectCode(() => stringPlusOne.write(canonicalBytes(overStringLimit)), 'OVERLAY_SCHEMA_STRING_LIMIT');
  });

  it('poisons both write and finish after an error and closes both after successful finish', () => {
    const valid = canonicalBytes(emptyOverlay());
    const failed = createValidator();
    expectCode(() => failed.write(Buffer.from('{x')), 'OVERLAY_SCHEMA_NON_CANONICAL_JSON');
    expectCode(() => failed.write(valid), 'OVERLAY_SCHEMA_POISONED');
    expectCode(() => failed.finish(), 'OVERLAY_SCHEMA_POISONED');

    const completed = createValidator();
    completed.write(valid);
    completed.finish();
    expectCode(() => completed.write(valid), 'OVERLAY_SCHEMA_ALREADY_FINISHED');
    expectCode(() => completed.finish(), 'OVERLAY_SCHEMA_ALREADY_FINISHED');
  });
  it('fails SourcePolicy and expected-artifact mismatches without widening runtime authority', () => {
    expectCode(() => loadSchema().createOverlayV1Validator({
      expectedProjectRoot: 'D:/fixture',
      expectedSourcePolicyDigest: '0'.repeat(64),
    }), 'OVERLAY_SCHEMA_SOURCE_POLICY_MISMATCH');
    const bytes = canonicalBytes(emptyOverlay());
    expectCode(() => validateBytes(bytes, [bytes.length], loadSchema(), {
      expectedArtifact: { bytes: bytes.length, sha256: '0'.repeat(64), counts: {} },
    }), 'OVERLAY_SCHEMA_PROFILE_MISMATCH');
  });
  it('keeps the leaf import DAG parser-local and records gate/runtime adoption as deferred', () => {
    const sources = [
      'codegraph-nanoflow-overlay-v1-schema-typescript.cjs',
      'codegraph-nanoflow-overlay-v1-schema-angular-support.cjs',
      'codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs',
      'codegraph-nanoflow-overlay-v1-schema-graph.cjs',
      'codegraph-nanoflow-overlay-v1-schema.cjs',
    ].map(fileName => fs.readFileSync(path.join(libRoot, fileName), 'utf8')).join('\n');
    expect(sources).not.toMatch(/jsonparse|Publisher|current-receipt|query-codegraph|mcp-stdio/);
    expect(sources).not.toMatch(/readFile|createReadStream|require\(['"]node:fs/);
    const sourcePolicySource = fs.readFileSync(path.join(libRoot, 'codegraph-source-policy.cjs'), 'utf8');
    expect(sourcePolicySource).toMatch(/node:fs/);
    expect([sha256(fs.readFileSync(path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs'))),
      sha256(sourcePolicySource)]).toEqual(['f61fc7da733f529cd75ee892b2a879709cfd88056bdbb0cc58b5a79fb20a5cf2',
      '892d9aa9178db3196627d66f6d44d26665df2d8fb8dcc8bb0b5ce3d9bd2c3cfc']);
    const trace = spawnSync(process.execPath, ['-e', `
      const Module = require('node:module'); const seen = new Set(); const load = Module._load;
      Module._load = function(request, parent, main) { seen.add(request); return load.call(this, request, parent, main); };
      require(${JSON.stringify(schemaPath)}); process.stdout.write(JSON.stringify([...seen].sort()));
    `], { cwd: repoRoot, encoding: 'utf8' });
    expect(trace.status, trace.stderr).toBe(0);
    expect(JSON.parse(trace.stdout)).toContain('node:fs');
    const definition = contract() as { authority: { generator: { sha256: string }; sourcePolicy: { sha256: string } };
      deferredAdoption: Record<string, { status: string; ownerPaths: string[] }> };
    expect([definition.authority.generator.sha256, definition.authority.sourcePolicy.sha256])
      .toEqual(['e0a4b589a60f68b9ab5c9dd10cc0ff5d95c678ad1f46599fb5bb2936b197a25b',
        '892d9aa9178db3196627d66f6d44d26665df2d8fb8dcc8bb0b5ce3d9bd2c3cfc']);
    expect(definition.deferredAdoption.runtime).toEqual({
      status: 'deferred',
      ownerPaths: ['scripts/lib/codegraph-overlay-current-receipt.cjs',
        'scripts/query-codegraph-nanoflow-overlay.mjs', 'scripts/codegraph-nanoflow-mcp-stdio.cjs'],
    });
    expect(definition.deferredAdoption.requiredGate).toEqual({
      status: 'deferred',
      ownerPaths: ['package.json', 'scripts/run-codegraph-adapter-gate.cjs'],
    });
  });
  it('single-pass validates the exact 250,558,329-byte artifact with bounded heap and RSS', () => {
    const definition = contract() as {
      authority: { compatibilityArtifact: { bytes: number; sha256: string } };
      compatibilityProfile: Record<string, number>;
    };
    expect(definition.compatibilityProfile.stringScanCodeUnits).toBe(154_120_993);
    const expectedArtifact = {
      ...definition.authority.compatibilityArtifact,
      counts: definition.compatibilityProfile,
    };
    const childSource = `
      const fs = require('node:fs'); const artifactPath = ${JSON.stringify(currentOverlayPath)};
      const originalStream = fs.createReadStream.bind(fs); const originalRead = fs.readFileSync.bind(fs);
      let artifactOpenAttempts = 0, artifactOpens = 0, artifactStreamBytes = 0, secondReadRejected = false;
      fs.createReadStream = (target, options) => { if (require('node:path').resolve(target) === artifactPath) {
        artifactOpenAttempts += 1; if (artifactOpenAttempts > 1) throw new Error('second artifact read'); artifactOpens += 1;
      } const stream = originalStream(target, options); stream.on('data', chunk => { artifactStreamBytes += chunk.length; }); return stream; };
      fs.readFileSync = (target, ...args) => { if (typeof target === 'string' && require('node:path').resolve(target) === artifactPath) {
        throw new Error('artifact readFileSync forbidden'); } return originalRead(target, ...args); };
      const schema = require(${JSON.stringify(schemaPath)});
      const validator = schema.createOverlayV1Validator(${JSON.stringify({
        expectedProjectRoot: repoRoot.replace(/\\/g, '/'),
        expectedSourcePolicyDigest: SOURCE_POLICY_DIGEST,
        expectedArtifact,
      })});
      const before = process.memoryUsage(); let peakHeap = before.heapUsed; let peakRss = before.rss;
      const started = Date.now();
      (async () => { for await (const chunk of fs.createReadStream(artifactPath, { highWaterMark: 1048576 })) {
        validator.write(chunk); const usage = process.memoryUsage();
        peakHeap = Math.max(peakHeap, usage.heapUsed); peakRss = Math.max(peakRss, usage.rss);
      } const result = validator.finish(); try { fs.createReadStream(artifactPath); } catch { secondReadRejected = true; }
        process.stdout.write(JSON.stringify({ artifactOpenAttempts, artifactOpens, artifactStreamBytes, secondReadRejected, result,
        heapDelta: peakHeap - before.heapUsed, rssDelta: peakRss - before.rss, elapsedMs: Date.now() - started }));
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const child = spawnSync(process.execPath, ['-e', childSource], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 55_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const { artifactOpenAttempts, artifactOpens, artifactStreamBytes, secondReadRejected, result, heapDelta, rssDelta, elapsedMs } = JSON.parse(child.stdout) as {
      artifactOpenAttempts: number; artifactOpens: number; artifactStreamBytes: number; secondReadRejected: boolean;
      result: ValidationResult; heapDelta: number; rssDelta: number; elapsedMs: number;
    };

    expect({ artifactOpenAttempts, artifactOpens, artifactStreamBytes, secondReadRejected }).toEqual({
      artifactOpenAttempts: 2, artifactOpens: 1,
      artifactStreamBytes: 250_558_329, secondReadRejected: true,
    });
    expect(result.artifact).toEqual({
      bytes: 250_558_329,
      sha256: '2508259e81e9c55b0e0e1058be219c0678564ceac685a72faf42c76d19abf420',
    });
    expect(result.counts).toEqual(expect.objectContaining({
      objectPaths: 240, arrayPaths: 636, scalarPaths: 1_897, relations: 160,
      nodeMetadataShapes: 124, edgeMetadataShapes: 147,
      valueTokens: 5_648_158,
      stringValues: 2_598_502,
      keyTokens: 4_982_808,
      stringTokens: 7_581_310,
      decodedStringBytes: 146_989_907,
      stringScanCodeUnits: 154_120_993,
      maxDepth: 13,
      maxStringBytes: 59_769,
      graphNodes: 124_072,
      graphEdges: 232_845,
      nodeTieGroups: 8_695,
      edgeTieGroups: 4_861,
      endpointIdBytes: 13_706_255,
      pathWitnessBytes: 207_662,
      pathWitnesses: 3_560,
    }));
    expect(heapDelta).toBeLessThan(192 * 1024 * 1024);
    expect(rssDelta).toBeLessThan(384 * 1024 * 1024);
    expect(elapsedMs).toBeLessThan(60_000);
    expect('overlay' in result).toBe(false);
  }, 60_000);
});
