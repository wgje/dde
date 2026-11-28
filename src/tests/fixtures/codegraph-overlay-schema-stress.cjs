'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

// Independent test producer: it deliberately imports no schema, graph descriptor or
// application generator. Canonical formatting and identities are specified here.
const STRESS_PROJECT_ROOT = 'D:/overlay-schema-stress';
const STRESS_FILES = 4000;
const NODES_PER_FILE = 40;
const EDGES_PER_NODE = 2;
const LARGE_NODE_TIE = 160;
const LARGE_EDGE_TIE = 128;
const EXTRA_PATHS = 96;
const GENERATED_AT = '2026-08-03T00:00:00.000Z';
const QUALIFIED_PADDING = 'independent-canonical-stress-owner';
const SIGNATURE = 'independent canonical signature '.repeat(5);

function filePath(index) {
  return `src/schema-stress/group-${String(index).padStart(4, '0')}.ts`;
}
function witnessPath(index) {
  return `src/schema-stress/witness-${String(index).padStart(4, '0')}/${'portable-path-segment/'.repeat(46)}witness.ts`;
}
function nodeAt(index) {
  // One full 160-node sorting tie exercises stable producer order without
  // changing the overall node denominator or borrowing ID remapping logic.
  const tied = index < LARGE_NODE_TIE;
  const file = filePath(tied ? 0 : Math.floor(index / NODES_PER_FILE));
  const local = index % NODES_PER_FILE;
  const name = tied ? 'node-00' : `node-${String(Math.floor(local / 2)).padStart(2, '0')}`;
  const instance = tied ? String(index).padStart(3, '0') : String(local % 2);
  const qualifiedName = `${name}::${QUALIFIED_PADDING}::instance-${instance}`;
  return {
    id: `file:${file}:${qualifiedName}`,
    kind: 'file', name, qualifiedName, filePath: file, language: 'typescript',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
    metadata: { relation: 'source-file' }, updatedAt: Date.parse(GENERATED_AT),
    signature: SIGNATURE,
  };
}
function edgeAt(index) {
  const node = nodeAt(index < LARGE_EDGE_TIE ? 0 : Math.floor(index / EDGES_PER_NODE));
  return {
    kind: 'references', source: node.id, target: node.id, line: index % EDGES_PER_NODE + 1,
    metadata: {
      relation: 'config-source', configKey: 'schema-stress-key', configObject: 'SchemaStressConfig',
      configProperty: 'independent-property',
      configPath: index < EXTRA_PATHS ? witnessPath(index) : node.filePath,
    },
  };
}
function deepFunction() {
  // This legal nested declaration reaches parser depth 13. Keep the concrete
  // keys/order independent of the validator and production generator.
  const type = {
    name: 'StressLocalType', qualifiedName: 'stress::Nested::method::StressLocalType', file: filePath(0),
    line: 1, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, docstring: null,
    signature: 'type StressLocalType = {}', isExported: false, isDefaultExport: false,
    typeParameters: [], typeParameterReferences: [], methods: [], properties: [], typeReferences: [],
    localDeclarationOwnerQualifiedName: 'stress::Nested::method', localDeclarationOwnerKind: 'method',
  };
  const method = {
    name: 'method', line: 1, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
    docstring: null, signature: 'method(): void', isAsync: false, isStatic: false, isAbstract: false,
    isOverride: false, visibility: null, decorators: [], returns: 'void', typeParameters: [],
    typeParameterReferences: [], parameters: [], typeReferences: [], valueReferences: [], calls: [],
    hardRuleImplementationCalls: [], supabaseSelects: [], supabaseIncrementalPredicates: [],
    supabaseStorageBuckets: [], supabaseFunctionInvokes: [], supabaseRpcCalls: [], supabaseTableWrites: [],
    supabaseRealtimeChannels: [], supabaseRealtimePostgresChanges: [], supabaseRealtimeLifecycleActions: [],
    supabaseRealtimeStatuses: [], instantiates: [], jsxReferences: [], hasBody: true,
    localDeclarations: {classes: [], interfaces: [], types: [type], enums: []},
  };
  const nested = {
    className: 'Nested', qualifiedName: 'stress::Nested', file: filePath(0), line: 1,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, docstring: null,
    signature: 'class Nested', isExported: false, isDefaultExport: false, isAbstract: false,
    decorators: [], typeParameters: [], typeParameterReferences: [], methods: [method], properties: [],
    extends: [], implements: [], instantiates: [], typeReferences: [], valueReferences: [], jsxReferences: [],
    localDeclarationOwnerQualifiedName: 'stress', localDeclarationOwnerKind: 'function',
  };
  return {
    name: 'stress', file: filePath(0), qualifiedName: 'stress', line: 1,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, docstring: '', signature: 'function stress()',
    isExported: false, isAsync: false, hasBody: true, decorators: [], typeParameters: [],
    typeParameterReferences: [], parameters: [], valueReferences: [], calls: [], hardRuleImplementationCalls: [],
    supabaseSelects: [], supabaseIncrementalPredicates: [], supabaseStorageBuckets: [],
    supabaseFunctionInvokes: [], supabaseRpcCalls: [], supabaseTableWrites: [], supabaseRealtimeChannels: [],
    supabaseRealtimePostgresChanges: [], supabaseRealtimeLifecycleActions: [], supabaseRealtimeStatuses: [],
    instantiates: [], jsxReferences: [], nestedFunctions: [],
    localDeclarations: {classes: [nested], interfaces: [], types: [], enums: []},
    localTypeReferences: [], typeReferences: [], isConst: false, configProperties: [],
    supabaseSelectFields: [], overloadSignatures: [],
  };
}
function writeLargeOverlayFixture(target, base) {
  const state = structuredClone(base);
  state.project.root = STRESS_PROJECT_ROOT;
  state.project.name = 'portable-stress-' + 's'.repeat(59769 - 'portable-stress-'.length);
  const nodes = STRESS_FILES * NODES_PER_FILE;
  const edges = nodes * EDGES_PER_NODE;
  state.typescript.files = [
    ...Array.from({ length: STRESS_FILES }, (_, i) => ({file: filePath(i), language: 'typescript'})),
    ...Array.from({ length: EXTRA_PATHS }, (_, i) => ({file: witnessPath(i), language: 'typescript'})),
  ];
  state.typescript.functions = [deepFunction()];
  const markerNodes = '__INDEPENDENT_STRESS_NODES__';
  const markerEdges = '__INDEPENDENT_STRESS_EDGES__';
  state.graph.nodes = markerNodes; state.graph.edges = markerEdges;
  const skeleton = JSON.stringify(state, null, 2) + '\n';
  const nodeMarker = JSON.stringify(markerNodes); const edgeMarker = JSON.stringify(markerEdges);
  const [head, tail] = skeleton.split(nodeMarker);
  const [middle, foot] = tail.split(edgeMarker);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const fd = fs.openSync(target, 'wx');
  const write = text => { const buffer = Buffer.from(text); fs.writeSync(fd, buffer); hash.update(buffer); bytes += buffer.length; };
  const writeArray = (length, make) => {
    write('[\n');
    for (let i = 0; i < length; i += 1) {
      write(JSON.stringify(make(i), null, 2).split('\n').map(line => '      ' + line).join('\n'));
      write(i + 1 === length ? '\n' : ',\n');
    }
    write('    ]');
  };
  try {
    write(head); writeArray(nodes, nodeAt); write(middle); writeArray(edges, edgeAt); write(foot);
  } finally { fs.closeSync(fd); }
  return Object.freeze({bytes, sha256: hash.digest('hex'), nodes, edges, files: STRESS_FILES + EXTRA_PATHS});
}
module.exports = {writeLargeOverlayFixture, STRESS_PROJECT_ROOT};
