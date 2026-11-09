import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const helperPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(helperPath), '../../..');
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
)) as {
  coverageTargets: string[];
  graphOrdering: {
    locale: string;
    options: Intl.CollatorOptions;
    nodes: { keys: string[] };
    edges: { keys: string[] };
  };
};
const graphDescriptor = require(path.join(
  repoRoot,
  'scripts',
  'lib',
  'codegraph-nanoflow-overlay-v1-schema-graph.cjs',
)) as {
  nodeOrdersByKind: Array<[string, string[][]]>;
  edgeOrdersByKind: Array<[string, string[][]]>;
  nodeMetadataOrders: Array<[string, string[][]]>;
  edgeMetadataOrders: Array<[string, string[][]]>;
  nodeRelationsByKind: Array<[string, string[]]>;
  edgeRelationsByKind: Array<[string, string[]]>;
  scalarTypeGroups: Array<[string[], string[]]>;
  arrayPaths: string[];
};

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export type PublishedOverlayFixture = ReturnType<typeof publishOverlayFixture>;

const leaseEvidence = {
  workspaceEpoch: 42,
  barrier: { state: 'HELD', owner: 'publisher-owner', fence: 7, heldEpoch: 41 },
  resource: {
    state: 'ACTIVE', kind: 'build', resourceId: 'codegraph-overlay-generation',
    owner: 'publisher-owner', fence: 7, heldEpoch: 41,
  },
};

export function createOverlay(projectRoot: string, name = 'example') {
  const file = `src/${name}.ts`;
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
      files: [{ file, language: 'typescript' }],
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
        id: `file:${file}:${file}`,
        kind: 'file',
        name: file,
        qualifiedName: file,
        filePath: file,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        metadata: { relation: 'source-file' },
        updatedAt: Date.parse('2026-08-03T00:00:00.000Z'),
      }],
      edges: [],
    },
  };
}

const defaultEdgeRelationByKind: Record<string, string> = {
  calls: 'call', contains: 'file-symbol', decorates: 'decorator', exports: 'export',
  extends: 'extends', implements: 'implements', imports: 'import', instantiates: 'new',
  overrides: 'override', references: 'initializer-reference', returns: 'return-type', type_of: 'type-reference',
};
const defaultNodeRelationByKind: Record<string, string> = {
  component: 'source-file', export: 'export', file: 'export-file', import: 'import', route: 'edge-function-route',
};
const nodeOrdersByKind = new Map(graphDescriptor.nodeOrdersByKind);
const edgeOrdersByKind = new Map(graphDescriptor.edgeOrdersByKind);
const nodeMetadataOrders = new Map(graphDescriptor.nodeMetadataOrders);
const edgeMetadataOrders = new Map(graphDescriptor.edgeMetadataOrders);
const nodeRelationsByKind = new Map(graphDescriptor.nodeRelationsByKind.map(([kind, relations]) => [kind, new Set(relations)]));
const edgeRelationsByKind = new Map(graphDescriptor.edgeRelationsByKind.map(([kind, relations]) => [kind, new Set(relations)]));
const graphLanguages = new Set(['javascript', 'jsx', 'kotlin', 'tsx', 'typescript', 'unknown', 'xml']);
const metadataArrayPaths = new Set(graphDescriptor.arrayPaths.filter(schemaPath => schemaPath.includes('.metadata.')));
const metadataScalarTypes = new Map<string, Set<string>>();
for (const [types, schemaPaths] of graphDescriptor.scalarTypeGroups) {
  for (const schemaPath of schemaPaths) {
    if (schemaPath.includes('.metadata.')) metadataScalarTypes.set(schemaPath, new Set(types));
  }
}
const graphCollator = new Intl.Collator(overlayContract.graphOrdering.locale, overlayContract.graphOrdering.options);

function compareFixtureRecords(keys: string[]) {
  return (left: Record<string, unknown>, right: Record<string, unknown>) => {
    for (const key of keys) {
      const compared = graphCollator.compare(String(left[key]), String(right[key]));
      if (compared) return compared;
    }
    return 0;
  };
}

function canonicalFixtureRecord(
  value: Record<string, unknown>,
  orders: string[][],
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const recognizedKeys = new Set(orders.flat());
  const keys = Object.keys(value).filter(key => recognizedKeys.has(key));
  const candidates = orders
    .filter(candidate => candidate.every(key => Object.hasOwn(value, key) || Object.hasOwn(defaults, key)));
  const order = candidates
    .filter(candidate => keys.every(key => candidate.includes(key)))
    .sort((left, right) => left.length - right.length)[0]
    ?? candidates.sort((left, right) => {
      const leftMatches = left.filter(key => keys.includes(key)).length;
      const rightMatches = right.filter(key => keys.includes(key)).length;
      return rightMatches - leftMatches || left.length - right.length;
    })[0];
  if (!order) throw new Error(`legacy-overlay-fixture-shape-unsupported:${String(value.kind ?? 'unknown')}`);
  return Object.fromEntries(order.map(key => [key, Object.hasOwn(value, key) ? value[key] : defaults[key]]));
}

function canonicalFixtureMetadata(
  value: Record<string, unknown> | undefined,
  ordersByRelation: Map<string, string[][]>,
  relationKey: string,
  schemaPath: 'graph.nodes[].metadata' | 'graph.edges[].metadata',
  defaults: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!relationKey) return undefined;
  const source = { ...defaults, ...(value ?? {}) };
  const orders = ordersByRelation.get(relationKey) ?? [];
  const recognizedKeys = new Set(orders.flat());
  const presentKeys = Object.keys(value ?? {}).filter(key => recognizedKeys.has(key));
  const exactOrders = orders.filter(candidate => presentKeys.every(key => candidate.includes(key)));
  const order = [...(exactOrders.length > 0 ? exactOrders : orders)]
    .sort((left, right) => {
      const leftMatches = left.filter(key => presentKeys.includes(key)).length;
      const rightMatches = right.filter(key => presentKeys.includes(key)).length;
      return rightMatches - leftMatches || left.length - right.length;
    })[0];
  if (!order) throw new Error(`legacy-overlay-fixture-metadata-unsupported:${relationKey}`);
  return Object.fromEntries(order.map(key => [
    key,
    source[key] === undefined
      ? fixtureMetadataDefault(schemaPath, key, source, context, relationKey)
      : source[key],
  ]));
}

function fixtureMetadataDefault(
  schemaPath: 'graph.nodes[].metadata' | 'graph.edges[].metadata',
  key: string,
  source: Record<string, unknown>,
  context: Record<string, unknown>,
  relationKey: string,
): unknown {
  const aliases: Record<string, string[]> = {
    api: ['attribute', 'propertyName'],
    call: ['matchedNeedle', 'keyword'],
    channelName: ['channelVariable'],
    constraintName: ['name'],
    expression: ['using', 'withCheck', 'predicate'],
    indexName: ['name'],
    method: ['indexMethod'],
    owner: ['qualifiedName', 'name'],
    policy: ['name'],
  };
  for (const alias of aliases[key] ?? []) {
    if (source[alias] !== undefined) return source[alias];
    if (context[alias] !== undefined) return context[alias];
  }
  const fieldPath = `${schemaPath}.${key}`;
  if (metadataArrayPaths.has(fieldPath)) return [];
  const types = metadataScalarTypes.get(fieldPath) ?? new Set(['string']);
  if (types.has('boolean')) return false;
  if (types.has('number')) return 0;
  if (types.has('string')) {
    if (['sourceFile', 'sourcePath', 'templateFile', 'manifestFile'].includes(key)) {
      return String(context.filePath ?? 'src/fixture.ts');
    }
    if (key === 'platform') {
      if (relationKey.startsWith('android-')) return 'android';
      if (relationKey.startsWith('edge-function-')) return 'supabase-edge-function';
      return 'fixture';
    }
    if (key === 'framework') return 'angular';
    if (key === 'constraintType') return 'check';
    if (key === 'constraintSource') return 'fixture';
    if (key === 'kind') return 'attribute';
    if (key === 'action') return relationKey;
    if (key === 'source') return String(context.filePath ?? 'fixture');
    const fallback = context[key] ?? context.name ?? relationKey.replace(/^@none:/, '');
    return String(fallback || 'fixture');
  }
  return null;
}

function fixtureNodeRelation(node: Record<string, unknown>): string {
  const kind = String(node.kind ?? '');
  const allowedRelations = nodeRelationsByKind.get(kind);
  const declaredRelation = String((node.metadata as Record<string, unknown> | undefined)?.relation ?? '');
  if (declaredRelation && allowedRelations?.has(declaredRelation)) return declaredRelation;
  const prefix = `${kind}:${String(node.filePath ?? '')}:`;
  const originalId = String(node.id ?? '');
  const idRelation = originalId.startsWith(prefix)
    ? originalId.slice(prefix.length).split(':')[0]
    : '';
  if (idRelation && allowedRelations?.has(idRelation)) return idRelation;
  const defaultRelation = defaultNodeRelationByKind[kind];
  return defaultRelation && allowedRelations?.has(defaultRelation) ? defaultRelation : '';
}

function canonicalFixtureFilePath(node: Record<string, unknown>): string {
  const rawFilePath = String(node.filePath ?? '');
  return rawFilePath
    && !path.isAbsolute(rawFilePath)
    && !rawFilePath.includes('..')
    && !/[<>:"|?*\\]/.test(rawFilePath)
    ? rawFilePath.replaceAll('\\', '/')
    : 'src/fixture.ts';
}

function canonicalFixtureNode(node: Record<string, unknown>, updatedAt: number): Record<string, unknown> {
  const kind = String(node.kind ?? '');
  const filePath = canonicalFixtureFilePath(node);
  const inferredRelation = fixtureNodeRelation(node);
  const rawMetadata = node.metadata as Record<string, unknown> | undefined;
  const relationKey = inferredRelation || (nodeMetadataOrders.has(`@none:${kind}`) ? `@none:${kind}` : '');
  const routeMetadata = relationKey === 'edge-function-route'
    ? {
      platform: 'supabase-edge-function',
      relation: relationKey,
      invokeName: String(rawMetadata?.invokeName ?? node.name ?? '').replace(/^\/functions\/v1\//, ''),
    }
    : undefined;
  const normalizedMetadata = routeMetadata
    ? { ...routeMetadata, ...rawMetadata }
    : inferredRelation ? { relation: inferredRelation, ...rawMetadata } : rawMetadata;
  const normalizedNode = {
    ...node,
    filePath,
    language: graphLanguages.has(String(node.language)) ? node.language : 'unknown',
    updatedAt,
    ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
  };
  const metadata = canonicalFixtureMetadata(
    normalizedMetadata,
    nodeMetadataOrders,
    relationKey,
    'graph.nodes[].metadata',
    routeMetadata ?? (relationKey && !relationKey.startsWith('@none:') ? { relation: relationKey } : {}),
    normalizedNode,
  );
  return canonicalFixtureRecord({ ...normalizedNode, ...(metadata ? { metadata } : {}) }, nodeOrdersByKind.get(kind) ?? [], {
    name: String(node.name ?? (kind || 'fixture')),
    qualifiedName: String(node.qualifiedName ?? node.name ?? (kind || 'fixture')),
    filePath,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    signature: `${kind} ${String(node.name ?? '')}`,
    decorators: [],
    typeParameters: [],
    isExported: false,
    isAbstract: false,
    isAsync: false,
    isStatic: false,
    updatedAt,
    ...(metadata ? { metadata } : {}),
  });
}

function canonicalFixtureEdge(edge: Record<string, unknown>, filePath: string): Record<string, unknown> {
  const kind = String(edge.kind ?? '');
  const metadata = edge.metadata as Record<string, unknown> | undefined;
  const relation = String(metadata?.relation ?? '');
  const normalizedMetadata = relation === 'edge-function-method'
    ? {
      relation,
      method: metadata?.method ?? '',
      methodSource: metadata?.methodSource ?? 'method-equality',
      sourceFile: metadata?.sourceFile ?? '',
    }
    : metadata;
  const normalizedEdge = edgeRelationsByKind.get(kind)?.has(relation)
    ? { ...edge, ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}) }
    : { ...edge, metadata: { ...(normalizedMetadata ?? {}), relation: defaultEdgeRelationByKind[kind] } };
  const canonicalMetadata = canonicalFixtureMetadata(
    normalizedEdge.metadata as Record<string, unknown> | undefined,
    edgeMetadataOrders,
    String((normalizedEdge.metadata as Record<string, unknown> | undefined)?.relation ?? ''),
    'graph.edges[].metadata',
    { relation: defaultEdgeRelationByKind[kind] },
    { ...normalizedEdge, filePath },
  );
  return canonicalFixtureRecord({ ...normalizedEdge, ...(canonicalMetadata ? { metadata: canonicalMetadata } : {}) }, edgeOrdersByKind.get(kind) ?? [], {
    metadata: canonicalMetadata,
  });
}

function canonicalFixtureNodeId(node: Record<string, unknown>): string {
  const kind = String(node.kind ?? '');
  const filePath = canonicalFixtureFilePath(node);
  const qualifiedName = String(node.qualifiedName ?? node.name ?? '');
  const prefix = `${kind}:${filePath}:`;
  const suffix = kind === 'file'
    ? String(node.name ?? filePath)
    : qualifiedName.replaceAll('::', '.') || String(node.name ?? '');
  return `${prefix}${suffix}`;
}

export function upgradeLegacyOverlayFixture(
  generatedOverlay: ReturnType<typeof createOverlay>,
  legacyOverlay: Record<string, unknown>,
) {
  const legacyGraph = legacyOverlay.graph as Record<string, unknown> | undefined;
  if (!legacyGraph) return generatedOverlay;
  const updatedAt = Date.parse(generatedOverlay.generatedAt);
  const endpointIds = new Map<string, string>();
  const endpointFiles = new Map<string, string>();
  const legacyNodes = Array.isArray(legacyGraph.nodes)
    ? legacyGraph.nodes
      .map(rawNode => {
        const node = rawNode as Record<string, unknown>;
        const id = canonicalFixtureNodeId(node);
        endpointIds.set(String(node.id), id);
        endpointFiles.set(String(node.id), String(node.filePath ?? 'src/fixture.ts'));
        return canonicalFixtureNode({ ...node, id }, updatedAt);
      })
      .filter((node, index, all) => all.findIndex(candidate => candidate.id === node.id) === index)
    : generatedOverlay.graph.nodes;
  const generatedFileNodes = generatedOverlay.graph.nodes.filter(node => node.kind === 'file');
  for (const node of generatedFileNodes) {
    endpointIds.set(String(node.id), String(node.id));
    endpointIds.set(String(node.filePath), String(node.id));
  }
  const nodes = [...legacyNodes, ...generatedFileNodes]
    .filter((node, index, all) => all.findIndex(candidate => candidate.id === node.id) === index)
    .sort(compareFixtureRecords(overlayContract.graphOrdering.nodes.keys));
  const edges = Array.isArray(legacyGraph.edges)
    ? legacyGraph.edges
      .map(rawEdge => {
        const edge = rawEdge as Record<string, unknown>;
        const sourceFile = endpointFiles.get(String(edge.source)) ?? 'src/fixture.ts';
        return canonicalFixtureEdge({
          ...edge,
          source: endpointIds.get(String(edge.source)) ?? edge.source,
          target: endpointIds.get(String(edge.target)) ?? edge.target,
        }, sourceFile);
      })
      .sort(compareFixtureRecords(overlayContract.graphOrdering.edges.keys))
    : generatedOverlay.graph.edges;
  const legacyTypescript = legacyOverlay.typescript as Record<string, unknown> | undefined;
  const legacyFiles = Array.isArray(legacyTypescript?.files)
    ? legacyTypescript.files.map(value => {
      const file = typeof value === 'string'
        ? value
        : String((value as Record<string, unknown>).file ?? '');
      const declaredLanguage = typeof value === 'string'
        ? ''
        : String((value as Record<string, unknown>).language ?? '');
      const language = graphLanguages.has(declaredLanguage)
        ? declaredLanguage
        : /\.tsx$/i.test(file) ? 'tsx'
          : /\.jsx$/i.test(file) ? 'jsx'
            : /\.[cm]?js$/i.test(file) ? 'javascript'
              : /\.[cm]?ts$/i.test(file) ? 'typescript'
                : 'unknown';
      return { file: file.replaceAll('\\', '/'), language };
    }).filter(selection => selection.file)
    : [];
  const files = [...generatedOverlay.typescript.files, ...legacyFiles]
    .filter((selection, index, all) => all.findIndex(candidate => candidate.file === selection.file) === index)
    .sort((left, right) => graphCollator.compare(left.file, right.file));
  return {
    ...generatedOverlay,
    typescript: { ...generatedOverlay.typescript, files },
    graph: { ...generatedOverlay.graph, nodes, edges },
  };
}

export function publishOverlayFixture(
  name = 'example',
  mutate?: (overlay: ReturnType<typeof createOverlay>) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-published-overlay-'));
  const overlay = createOverlay(root, name);
  mutate?.(overlay);
  const publication = publishOverlayAtRoot(root, overlay);
  return {
    root,
    overlay,
    publication,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function publishOverlayAtRoot(
  projectRoot: string,
  overlay: ReturnType<typeof createOverlay>,
) {
  try {
    return publisher.createOverlayGenerationPublisher({
      readLeaseEvidence: () => leaseEvidence,
      transactionId: () => `tx-${crypto.randomBytes(16).toString('hex')}`,
    }).publish({
      projectRoot,
      overlay,
      publishedAt: '2026-08-03T00:01:00.000Z',
      configDigest: digest('config'),
      setupDigest: digest('setup'),
      sourceManifestDigest: digest('source-manifest'),
      toolchainDigest: digest('toolchain'),
    });
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined;
    const detail = cause && typeof cause === 'object'
      ? [
        'code' in cause ? String(cause.code ?? '') : '',
        'schemaPath' in cause ? String(cause.schemaPath ?? '') : '',
      ].filter(Boolean).join(':')
      : '';
    throw new Error(`codegraph-overlay-publication-schema-invalid${detail ? `:${detail}` : ''}`, { cause: error });
  }
}

export function createOverlayQueryTestRunner(options: {
  directory: string;
  generatorScriptPath: string;
  queryScriptPath: string;
}): string {
  const runnerPath = path.join(options.directory, 'codegraph-overlay-query-test-runner.mjs');
  const source = [
    "import crypto from 'node:crypto';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    `import { publishOverlayAtRoot, upgradeLegacyOverlayFixture } from ${JSON.stringify(pathToFileURL(helperPath).href)};`,
    `const generatorScriptPath = ${JSON.stringify(options.generatorScriptPath)};`,
    `const queryScriptPath = ${JSON.stringify(options.queryScriptPath)};`,
    `const repoRoot = ${JSON.stringify(repoRoot)};`,
    'const args = process.argv.slice(2);',
    "const rootIndex = args.indexOf('--root');",
    "if (rootIndex < 0 || !args[rootIndex + 1]) throw new Error('test-query-runner-root-required');",
    'const projectRoot = path.resolve(args[rootIndex + 1]);',
    "const overlayIndex = args.indexOf('--overlay');",
    'const explicitOverlay = overlayIndex >= 0 ? args[overlayIndex + 1] : undefined;',
    "const defaultOverlay = path.join(projectRoot, '.codegraph', 'nanoflow-overlay.json');",
    'const fixturePath = explicitOverlay',
    '  ? path.resolve(projectRoot, explicitOverlay)',
    '  : fs.existsSync(defaultOverlay) ? defaultOverlay : undefined;',
    "const currentPath = path.join(projectRoot, '.codegraph', 'nanoflow-generations', 'CURRENT.json');",
    "const markerPath = path.join(projectRoot, '.codegraph', 'nanoflow-generations', '.test-fixture-source');",
    'const fixtureBytes = fixturePath ? fs.readFileSync(fixturePath) : undefined;',
    "const fixtureDigest = fixtureBytes ? crypto.createHash('sha256').update(fixtureBytes).digest('hex') : '';",
    'const marker = fixtureBytes ? `${path.relative(projectRoot, fixturePath).replaceAll(path.sep, \'/\')}:${fixtureDigest}` : \'\';',
    'const markerMatches = marker && fs.existsSync(markerPath) && fs.readFileSync(markerPath, \'utf8\') === marker;',
    'if (!fs.existsSync(currentPath) || (fixtureBytes && !markerMatches)) {',
    '  const generated = spawnSync(process.execPath, [generatorScriptPath, \'--root\', projectRoot, \'--stdout\'], {',
    "    cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,",
    '  });',
    '  if (generated.status !== 0) {',
    "    if (generated.stdout) process.stdout.write(generated.stdout);",
    "    if (generated.stderr) process.stderr.write(generated.stderr);",
    '    process.exit(generated.status ?? 1);',
    '  }',
    '  let overlay = JSON.parse(generated.stdout);',
    '  if (fixtureBytes) overlay = upgradeLegacyOverlayFixture(overlay, JSON.parse(fixtureBytes.toString(\'utf8\')));',
    '  publishOverlayAtRoot(projectRoot, overlay);',
    '  if (marker) fs.writeFileSync(markerPath, marker);',
    '}',
    'const queryArgs = overlayIndex < 0',
    '  ? args',
    '  : args.filter((_arg, index) => index !== overlayIndex && index !== overlayIndex + 1);',
    'const result = spawnSync(process.execPath, [queryScriptPath, ...queryArgs], {',
    "  cwd: repoRoot, stdio: 'inherit',",
    '});',
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n');
  fs.writeFileSync(runnerPath, source);
  return runnerPath;
}
