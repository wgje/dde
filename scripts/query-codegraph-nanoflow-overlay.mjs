#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import overlayBaseline from './lib/codegraph-overlay-baseline.cjs';
import currentReceiptReader from './lib/codegraph-overlay-current-receipt.cjs';
import { installQueryTerms, queryTokensImpl } from './lib/codegraph-overlay-query-terms.mjs';
import { installNativeCodeblockEvidence, resolveNativeCodeBlockNodeImpl } from './lib/codegraph-overlay-native-codeblock-evidence.mjs';
import { installCandidateIndex, queryOverlayImpl, scoreCandidateImpl } from './lib/codegraph-overlay-candidate-index.mjs';
import { installSemanticSelection, selectGraphResultsImpl } from './lib/codegraph-overlay-semantic-selection.mjs';
import { installContextAssembly, buildSourceBlocksImpl } from './lib/codegraph-overlay-context-assembly.mjs';
import { installNativeCodeblockSelection, buildNativeCodeBlocksImpl } from './lib/codegraph-overlay-native-codeblock-selection.mjs';
import {
  installOutputProjection,
  formatNativeMarkdownImpl,
  formatStrictNativeMarkdownImpl,
  toNativeJsonFormatterResponseImpl,
} from './lib/codegraph-overlay-output-projection.mjs';

const { buildBaseline } = overlayBaseline;
const { readOverlayCurrentReceipt } = currentReceiptReader;

const SOURCE_BLOCK_FILE_LIMIT = 6;
const MAX_MARKDOWN_OUTPUT_CHARS = 25_000;
const NATIVE_CONTEXT_CODE_BLOCK_LIMIT = 5;
const NATIVE_CONTEXT_CODE_BLOCK_SIZE = 1_500;
const CONTEXT7_RELATION_CLOSURE = new Set([
  'context7-category-doc',
  'context7-retrieval-primary',
  'context7-retrieval-secondary',
  'context7-source-map-doc',
  'context7-source-map-source',
]);
const ANGULAR_SEMANTIC_API_QUERY_TERMS = new Set([
  'computed',
  'contentchild',
  'contentchildren',
  'effect',
  'input',
  'input.required',
  'model',
  'output',
  'signal',
  'viewchild',
  'viewchildren',
  'android-manifest-component',
  'android-kotlin-companion-object',
  'android-kotlin-call',
  'android-kotlin-annotation',
  'android-kotlin-constructor',
  'android-kotlin-extends',
  'android-kotlin-function',
  'android-kotlin-implements',
  'android-kotlin-import',
  'android-kotlin-interface',
  'android-kotlin-method',
  'android-kotlin-object',
  'android-kotlin-override',
  'android-kotlin-property',
  'android-kotlin-type-reference',
  'android-resource-reference',
  'android-widget-provider',
]);
const EDGE_QUERY_TERMS = new Set([
  'calls',
  'contains',
  'control-flow',
  'decorates',
  'exports',
  'extends',
  'implements',
  'imports',
  'instantiates',
  'overrides',
  'references',
  'returns',
  'structural',
  'type_of',
  'type-of',
  'angular-app-provider',
  'android-kotlin-companion-object',
  'android-kotlin-call',
  'android-kotlin-annotation',
  'android-kotlin-constructor',
  'android-kotlin-extends',
  'android-kotlin-function',
  'android-kotlin-implements',
  'android-kotlin-import',
  'android-kotlin-interface',
  'android-kotlin-method',
  'android-kotlin-object',
  'android-kotlin-override',
  'android-kotlin-property',
  'android-kotlin-type-reference',
  'commonjs-export',
  'constructor-di',
  'decorator-argument',
  'default-export',
  'dynamic-import',
  'file-symbol',
  'computed',
  'contentchild',
  'contentchildren',
  'effect',
  'initializer-reference',
  'interface-call-signature',
  'interface-construct-signature',
  'interface-index-signature',
  'interface-member',
  'interface-method-signature',
  'local-declaration',
  'local-variable-type',
  'namespace-import',
  'nested-function',
  'object-function',
  'parameter-type',
  're-export',
  'template-binding',
  'query',
  'signal',
  'type-literal-call-signature',
  'type-literal-construct-signature',
  'type-literal-index-signature',
  'type-literal-member',
  'type-literal-method-signature',
  'type-parameter-constraint',
  'type-parameter-default',
  'type-reference',
  'viewchild',
  'viewchildren',
]);
const SQL_STATEMENT_NODE_RELATIONS = new Set([
  'migration-index',
  'migration-constraint',
  'migration-realtime-publication',
  'migration-rls',
  'migration-view',
  'policy',
  'privilege',
  'sql-function',
  'supabase-storage-bucket',
]);
const SQL_STATEMENT_EDGE_RELATIONS = new Set([
  'migration-constraint-validation',
]);
const HIGH_VALUE_NODE_KINDS = new Set([
  'file',
  'function',
  'method',
  'class',
  'interface',
  'type_alias',
  'struct',
  'trait',
  'component',
  'route',
  'variable',
  'constant',
  'enum',
  'module',
  'namespace',
]);
const OFFICIAL_CODEGRAPH_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'razor',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'yaml',
  'twig',
  'xml',
  'html',
  'css',
  'scss',
  'sass',
  'less',
  'sql',
  'markdown',
  'json',
  'properties',
  'unknown',
]);
const OFFICIAL_GENERATED_FILE_PATTERNS = [
  /\.pb\.go$/,
  /\.pulsar\.go$/,
  /_grpc\.pb\.go$/,
  /_mock\.go$/,
  /_mocks\.go$/,
  /^mock_[^/]+\.go$/,
  /\.generated\.[jt]sx?$/,
  /\.gen\.[jt]sx?$/,
  /\.pb\.[jt]s$/,
  /_pb\.[jt]s$/,
  /_grpc_pb\.[jt]s$/,
  /_pb2(_grpc)?\.py$/,
  /_pb2\.pyi$/,
  /\.pb\.(cc|h)$/,
  /\.g\.cs$/,
  /Grpc\.cs$/,
  /OuterClass\.java$/,
  /Grpc\.java$/,
  /\.pb\.swift$/,
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.pb\.dart$/,
  /\.pbgrpc\.dart$/,
  /\.chopper\.dart$/,
  /\.generated\.rs$/,
];
const overlayQueryRuntime = {
  fs, path, buildBaseline, SOURCE_BLOCK_FILE_LIMIT,
  MAX_MARKDOWN_OUTPUT_CHARS, NATIVE_CONTEXT_CODE_BLOCK_LIMIT, NATIVE_CONTEXT_CODE_BLOCK_SIZE, CONTEXT7_RELATION_CLOSURE,
  ANGULAR_SEMANTIC_API_QUERY_TERMS, EDGE_QUERY_TERMS, SQL_STATEMENT_NODE_RELATIONS, SQL_STATEMENT_EDGE_RELATIONS,
  HIGH_VALUE_NODE_KINDS, OFFICIAL_CODEGRAPH_LANGUAGES, OFFICIAL_GENERATED_FILE_PATTERNS,
};
installQueryTerms(overlayQueryRuntime);
installNativeCodeblockEvidence(overlayQueryRuntime);
installCandidateIndex(overlayQueryRuntime);
installSemanticSelection(overlayQueryRuntime);
installContextAssembly(overlayQueryRuntime);
installNativeCodeblockSelection(overlayQueryRuntime);
installOutputProjection(overlayQueryRuntime);
const {
  toNativeEdge, fillGraphNodeBudgetWithRelevantEndpoints, closeGraphEdgesOverSelectedNodes, orderRelatedFilesForQuery,
  buildRelationshipGroups, capRelationshipGroups, buildBlastRadiusEntries, buildNotShownEntries,
  formatSummary, selectEntryPoints, prioritizeContext7RetrievalNodes, exactMetadataQueriesFromEdges,
  getExploreOutputBudget, summarizeOverlayCoverage, toPosix, unique,
} = overlayQueryRuntime;
function queryTokens(...values) { return queryTokensImpl(...values); }
function resolveNativeCodeBlockNode(...values) { return resolveNativeCodeBlockNodeImpl(...values); }
function queryOverlay(...values) { return queryOverlayImpl(...values); }
function scoreCandidate(...values) { return scoreCandidateImpl(...values); }
function selectGraphResults(...values) { return selectGraphResultsImpl(...values); }
function buildSourceBlocks(...values) { return buildSourceBlocksImpl(...values); }
function buildNativeCodeBlocks(...values) { return buildNativeCodeBlocksImpl(...values); }
function formatNativeMarkdown(...values) { return formatNativeMarkdownImpl(...values); }
function formatStrictNativeMarkdown(...values) { return formatStrictNativeMarkdownImpl(...values); }
function toNativeJsonFormatterResponse(...values) { return toNativeJsonFormatterResponseImpl(...values); }

function prioritizeQueryRelevantGraphNodes(nodes, edges, matches, rawQuery) {
  const query = String(rawQuery ?? '').trim().toLowerCase();
  const exactIds = new Set(nodes
    .filter(node => HIGH_VALUE_NODE_KINDS.has(node.kind))
    .filter(node => [node.name, node.qualifiedName].some(value => String(value ?? '').toLowerCase() === query))
    .map(node => node.id));
  if (exactIds.size === 0) return nodes;
  const relatedIds = new Set();
  for (const edge of edges) {
    if (exactIds.has(edge.source)) relatedIds.add(edge.target);
    if (exactIds.has(edge.target)) relatedIds.add(edge.source);
  }
  const matchRanks = new Map(matches.map((match, index) => [`${match.name}\0${match.file}`, index]));
  const rank = node => exactIds.has(node.id) ? 0 : relatedIds.has(node.id) ? 1
    : matchRanks.has(`${node.name}\0${node.filePath}`) ? 2 : 3;
  return [...nodes].sort((left, right) => rank(left) - rank(right)
    || (matchRanks.get(`${left.name}\0${left.filePath}`) ?? Number.MAX_SAFE_INTEGER)
      - (matchRanks.get(`${right.name}\0${right.filePath}`) ?? Number.MAX_SAFE_INTEGER));
}
Object.assign(overlayQueryRuntime, {
  queryTokens, resolveNativeCodeBlockNode, queryOverlay, scoreCandidate, selectGraphResults,
  buildSourceBlocks, buildNativeCodeBlocks, formatNativeMarkdown, formatStrictNativeMarkdown,
  toNativeJsonFormatterResponse,
});

const PROFILE_OVERLAY_QUERY = process.env.NANOFLOW_OVERLAY_QUERY_PROFILE === '1';
ignoreBrokenStdoutPipe();
const args = profilePhase('parseArgs', () => parseArgs(process.argv.slice(2)));
const root = path.resolve(args.root ?? process.cwd());
const currentReceipt = profilePhase(
  'readOverlayCurrentReceipt',
  () => readOverlayCurrentReceipt(root),
);
if (!currentReceipt.ok) {
  fs.writeSync(process.stderr.fd, `overlay-current-${currentReceipt.errorCode.toLowerCase().replaceAll('_', '-')}\n`);
  process.exit(2);
}
const overlay = currentReceipt.overlay;
const overlaySource = toPosix(path.join(
  '.codegraph',
  'nanoflow-generations',
  currentReceipt.current.generationId,
));
writeProfileMeta(root, currentReceipt, args);
const matches = profilePhase('queryOverlay', () => queryOverlay(overlay, args.query, args.limit));
const graphSelection = profilePhase('selectGraphResults', () => selectGraphResults(overlay, args.query, matches, args.limit));
const prioritizedGraphNodes = prioritizeQueryRelevantGraphNodes(
  prioritizeContext7RetrievalNodes(graphSelection.nodes, graphSelection.edges, args.query),
  graphSelection.edges,
  matches,
  args.query,
);
const graphNodes = fillGraphNodeBudgetWithRelevantEndpoints(
  prioritizedGraphNodes.slice(0, args.limit),
  graphSelection.edges,
  overlay.graph?.nodes ?? [],
  args.query,
  args.limit,
);
const graphNodeIds = new Set(graphNodes.map(node => node.id));
const preserveExactRelationSelection = exactMetadataQueriesFromEdges(
  graphSelection.edges,
  args.query,
).length > 0;
const closedGraphEdges = closeGraphEdgesOverSelectedNodes(
  graphSelection.edges,
  graphNodes,
  overlay.graph?.nodes ?? [],
);
const graphEdges = preserveExactRelationSelection
  ? graphSelection.edges
    .filter(edge => graphNodeIds.has(edge.source) && graphNodeIds.has(edge.target))
    .slice(0, args.limit)
  : closedGraphEdges.slice(0, args.limit);
const relationshipGroups = profilePhase('buildRelationshipGroups', () => buildRelationshipGroups(graphEdges));
const coverage = profilePhase('summarizeOverlayCoverage', () => summarizeOverlayCoverage(overlay));
const nativeEdges = profilePhase('toNativeEdges', () => graphEdges.map(toNativeEdge));
const blastRadius = buildBlastRadiusEntries(
  graphNodes,
  graphSelection.edges,
  overlay.graph?.nodes ?? graphSelection.nodes,
);
const relatedFiles = orderRelatedFilesForQuery(unique(graphNodes
  .map(node => node.filePath)
  .filter(Boolean)), args.query).slice(0, args.limit);

if (args.contextJson) {
  const contextRelationshipGroups = capRelationshipGroups(relationshipGroups, 20);
  const response = {
    query: args.query,
    summary: formatSummary(graphNodes, relatedFiles),
    root,
    overlay: overlaySource, generationId: currentReceipt.current.generationId,
    count: graphNodes.length,
    matches,
    nodes: graphNodes,
    relatedFiles,
    stats: {
      nodeCount: graphNodes.length,
      edgeCount: graphEdges.length,
      fileCount: relatedFiles.length,
    },
    relationshipGroups: contextRelationshipGroups,
    blastRadius,
    coverage,
  };
  profilePhase('writeContextJson', () => process.stdout.write(`${JSON.stringify(response, null, 2)}\n`));
} else {
  const outputBudget = getExploreOutputBudget(coverage.typescriptFiles ?? graphNodes.length);
  const sourceBlocks = profilePhase('buildSourceBlocks', () => buildSourceBlocks(
    root,
    graphNodes,
    outputBudget,
    args.query,
    graphEdges,
  )).slice(0, args.limit);
  const shownSourceFiles = new Set(sourceBlocks.map(block => block.filePath));
  const entryPoints = selectEntryPoints(graphNodes, matches, args.limit, args.query, graphEdges);
  const codeBlocks = profilePhase('buildNativeCodeBlocks', () => buildNativeCodeBlocks(
    root,
    graphNodes,
    entryPoints,
    args.query,
    graphEdges,
  )).slice(0, args.limit);
  const response = {
  query: args.query,
  summary: formatSummary(graphNodes, relatedFiles),
  entryPoints,
  root,
  overlay: overlaySource, generationId: currentReceipt.current.generationId,
  count: graphNodes.length,
  matches,
  nodes: graphNodes,
  edges: nativeEdges,
  codeBlocks,
  relatedFiles,
  stats: {
    nodeCount: graphNodes.length,
    edgeCount: nativeEdges.length,
    fileCount: relatedFiles.length,
    codeBlockCount: codeBlocks.length,
    totalCodeSize: codeBlocks.reduce((total, block) => total + block.content.length, 0),
  },
  displayEdges: graphEdges,
  relationshipGroups,
  blastRadius,
  notShown: buildNotShownEntries(graphNodes, shownSourceFiles),
  coverage,
  };
  if (!args.nativeJson) {
    response.markdown = profilePhase('formatNativeMarkdown', () => formatNativeMarkdown(response, sourceBlocks));
  }
  const nativeMarkdown = args.nativeMarkdown
    ? profilePhase('formatStrictNativeMarkdown', () => formatStrictNativeMarkdown(response))
    : '';
  const outputResponse = args.nativeJson ? toNativeJsonFormatterResponse(response) : response;

  const outputText = args.json
    ? `${JSON.stringify(outputResponse, null, 2)}\n`
    : `${args.nativeMarkdown ? nativeMarkdown : response.markdown}\n`;
  profilePhase(args.json ? 'writeJson' : 'writeMarkdown', () => process.stdout.write(outputText));
}

function parseArgs(rawArgs) {
  const parsed = {
    root: undefined,
    query: undefined,
    limit: 20,
    json: false,
    contextJson: false,
    nativeJson: false,
    nativeMarkdown: false,
    skipRefresh: process.env.NANOFLOW_OVERLAY_SKIP_REFRESH === '1',
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--root') {
      parsed.root = requireValue(rawArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--overlay') {
      throw new Error('--overlay is no longer supported; publish and select CURRENT instead.');
    }
    if (arg === '--query' || arg === '-q') {
      parsed.query = requireValue(rawArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      parsed.limit = parsePositiveIntegerArg(requireValue(rawArgs, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--android-import-source') {
      throw new Error('--android-import-source is generation ownership and is unavailable to query.');
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--context-json') {
      parsed.json = true;
      parsed.contextJson = true;
      parsed.skipRefresh = true;
      continue;
    }
    if (arg === '--skip-refresh') {
      parsed.skipRefresh = true;
      continue;
    }
    if (arg === '--native-json') {
      parsed.json = true;
      parsed.nativeJson = true;
      continue;
    }
    if (arg === '--native-markdown') {
      parsed.nativeMarkdown = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (!parsed.query) {
      parsed.query = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.query) {
    throw new Error('Missing query. Use --query <text>.');
  }

  if (!Number.isFinite(parsed.limit) || parsed.limit <= 0) {
    throw new Error('--limit must be a positive integer.');
  }

  if (parsed.nativeMarkdown && parsed.json) {
    throw new Error('--native-markdown cannot be combined with --json, --native-json, or --context-json.');
  }

  if (parsed.contextJson && parsed.nativeJson) {
    throw new Error('--context-json cannot be combined with --native-json.');
  }

  return parsed;
}

function parsePositiveIntegerArg(value, flag) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return Number(value);
}

function ignoreBrokenStdoutPipe() {
  process.stdout.on('error', error => {
    if (error?.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

function requireValue(rawArgs, index, flag) {
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/query-codegraph-nanoflow-overlay.mjs --query <text> [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --root <path>       Project root. Defaults to cwd.\n`);
  process.stdout.write(`  --limit <number>    Maximum matches. Defaults to 20.\n`);
  process.stdout.write(`  --json              Print machine-readable JSON.\n`);
  process.stdout.write(`  --context-json      Print compact internal JSON for MCP context packs; mutually exclusive with --native-json.\n`);
  process.stdout.write(`  --native-json       Print the strict native CodeGraph JSON formatter projection; mutually exclusive with --context-json.\n`);
  process.stdout.write(`  --native-markdown   Print the strict native CodeGraph Markdown formatter projection; mutually exclusive with JSON output modes.\n`);
  process.stdout.write(`  --skip-refresh      Compatibility no-op; queries only read authenticated CURRENT.\n`);
}

function profilePhase(phase, callback) {
  if (!PROFILE_OVERLAY_QUERY) {
    return callback();
  }

  const startedAt = process.hrtime.bigint();
  try {
    return callback();
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    process.stderr.write(`${JSON.stringify({
      event: 'nanoflow.overlay.profile',
      pid: process.pid,
      phase,
      elapsedMs: Number(elapsedMs.toFixed(3)),
    })}\n`);
  }
}

function writeProfileMeta(projectRoot, receipt, parsedArgs) {
  if (!PROFILE_OVERLAY_QUERY) {
    return;
  }

  process.stderr.write(`${JSON.stringify({
    event: 'nanoflow.overlay.profile.meta',
    pid: process.pid,
    root: projectRoot,
    generationId: receipt.current.generationId,
    sequence: receipt.current.sequence,
    query: parsedArgs.query,
    limit: parsedArgs.limit,
    skipRefresh: parsedArgs.skipRefresh,
    contextJson: parsedArgs.contextJson,
    json: parsedArgs.json,
    nativeJson: parsedArgs.nativeJson,
    nativeMarkdown: parsedArgs.nativeMarkdown,
    cwd: process.cwd(),
    node: process.execPath,
  })}\n`);
}
