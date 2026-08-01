#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import overlayBaseline from './lib/codegraph-overlay-baseline.cjs';
import sourcePolicy from './lib/codegraph-source-policy.cjs';

const { buildBaseline } = overlayBaseline;
const { classifySourcePath, isSourceDirectoryExcluded } = sourcePolicy;

const DEFAULT_OVERLAY = path.join('.codegraph', 'nanoflow-overlay.json');
const OVERLAY_STALE_SKIP_REFRESH = 'overlay-stale-skip-refresh';
const ANDROID_IMPORT_SOURCES = new Set(['local', 'native']);
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
const PROFILE_OVERLAY_QUERY = process.env.NANOFLOW_OVERLAY_QUERY_PROFILE === '1';
ignoreBrokenStdoutPipe();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = profilePhase('parseArgs', () => parseArgs(process.argv.slice(2)));
const root = path.resolve(args.root ?? process.cwd());
const overlayPath = path.resolve(root, args.overlay ?? DEFAULT_OVERLAY);
writeProfileMeta(root, overlayPath, args);
const overlay = profilePhase('loadOverlay', () => loadOverlay(root, overlayPath, args.androidImportSource));
const matches = profilePhase('queryOverlay', () => queryOverlay(overlay, args.query, args.limit));
const graphSelection = profilePhase('selectGraphResults', () => selectGraphResults(overlay, args.query, matches, args.limit));
const rankedGraphNodes = prioritizeContext7RetrievalNodes(
  rankNodesForQuery(graphSelection.nodes, args.query),
  graphSelection.edges,
  args.query,
);
const graphNodes = fillGraphNodeBudgetWithRelevantEndpoints(
  rankedGraphNodes.slice(0, args.limit),
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
  : rankGraphEdgesForQuery(closedGraphEdges, graphNodes, args.query).slice(0, args.limit);
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
    overlay: toPosix(path.relative(root, overlayPath)),
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
  writeFreshOverlayOutput(root, overlayPath, 'writeContextJson', `${JSON.stringify(response, null, 2)}\n`);
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
  overlay: toPosix(path.relative(root, overlayPath)),
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
  writeFreshOverlayOutput(root, overlayPath, args.json ? 'writeJson' : 'writeMarkdown', outputText);
}

function parseArgs(rawArgs) {
  const parsed = {
    root: undefined,
    overlay: undefined,
    query: undefined,
    limit: 20,
    json: false,
    contextJson: false,
    nativeJson: false,
    nativeMarkdown: false,
    androidImportSource: undefined,
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
      parsed.overlay = requireValue(rawArgs, index, arg);
      index += 1;
      continue;
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
      const source = requireValue(rawArgs, index, arg);
      if (!ANDROID_IMPORT_SOURCES.has(source)) {
        throw new Error(`Invalid value for ${arg}: ${source}`);
      }
      parsed.androidImportSource = source;
      index += 1;
      continue;
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
  process.stdout.write(`  --overlay <path>    Overlay path relative to root. Defaults to ${DEFAULT_OVERLAY}.\n`);
  process.stdout.write(`  --limit <number>    Maximum matches. Defaults to 20.\n`);
  process.stdout.write(`  --android-import-source <local|native>  Forward an explicit source when regenerating the overlay.\n`);
  process.stdout.write(`  --json              Print machine-readable JSON.\n`);
  process.stdout.write(`  --context-json      Print compact internal JSON for MCP context packs; mutually exclusive with --native-json.\n`);
  process.stdout.write(`  --native-json       Print the strict native CodeGraph JSON formatter projection; mutually exclusive with --context-json.\n`);
  process.stdout.write(`  --native-markdown   Print the strict native CodeGraph Markdown formatter projection; mutually exclusive with JSON output modes.\n`);
  process.stdout.write(`  --skip-refresh      Do not synchronously regenerate stale overlays before querying.\n`);
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

function writeProfileMeta(projectRoot, filePath, parsedArgs) {
  if (!PROFILE_OVERLAY_QUERY) {
    return;
  }

  process.stderr.write(`${JSON.stringify({
    event: 'nanoflow.overlay.profile.meta',
    pid: process.pid,
    root: projectRoot,
    overlayPath: filePath,
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

function loadOverlay(projectRoot, filePath, androidImportSource) {
  const fileExists = profilePhase('checkOverlayFile', () => fs.existsSync(filePath));
  if (!fileExists) {
    ensureOverlay(projectRoot, 'missing-file', androidImportSource);
  }

  const stale = checkOverlayFreshness(projectRoot, filePath);
  if (stale && args.skipRefresh) {
    failOverlayStaleSkipRefresh();
  }
  if (stale) {
    ensureOverlay(projectRoot, 'stale-source', androidImportSource);
  }

  let overlay = readOverlayJson(filePath);
  if (!Array.isArray(overlay.graph?.nodes)) {
    ensureOverlay(projectRoot, 'missing-graph', androidImportSource);
    overlay = readOverlayJson(filePath);
  }

  return overlay;
}

function readOverlayJson(filePath) {
  const content = profilePhase('readOverlayFile', () => fs.readFileSync(filePath, 'utf8'));
  return profilePhase('parseOverlayJson', () => JSON.parse(content));
}

function isOverlayStale(projectRoot, filePath) {
  let overlayMtimeMs = 0;
  try {
    overlayMtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return true;
  }

  return hasNewerOverlayRelevantFile(projectRoot, overlayMtimeMs);
}

function checkOverlayFreshness(projectRoot, filePath) {
  return profilePhase('checkOverlayFreshness', () => isOverlayStale(projectRoot, filePath));
}

function writeFreshOverlayOutput(projectRoot, filePath, phase, outputText) {
  if (checkOverlayFreshness(projectRoot, filePath)) {
    failOverlayStaleSkipRefresh();
  }
  profilePhase(phase, () => process.stdout.write(outputText));
}

function failOverlayStaleSkipRefresh() {
  fs.writeSync(process.stderr.fd, `${OVERLAY_STALE_SKIP_REFRESH}\n`);
  process.exit(2);
}

function hasNewerOverlayRelevantFile(projectRoot, overlayMtimeMs, directory = projectRoot) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.relative(projectRoot, entryPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!isSourceDirectoryExcluded(relativePath)
        && hasNewerOverlayRelevantFile(projectRoot, overlayMtimeMs, entryPath)) {
        return true;
      }
      continue;
    }

    if (!entry.isFile() || classifySourcePath(relativePath) === null) {
      continue;
    }

    try {
      if (fs.statSync(entryPath).mtimeMs > overlayMtimeMs) {
        return true;
      }
    } catch {
      // Files can disappear while the workspace is changing; the next query can refresh.
    }
  }

  return false;
}

function ensureOverlay(projectRoot, reason, androidImportSource) {
  const generator = path.join(scriptDir, 'generate-codegraph-nanoflow-overlay.mjs');
  const generatorArgs = [generator, '--root', projectRoot];
  if (androidImportSource !== undefined) {
    generatorArgs.push('--android-import-source', androidImportSource);
  }
  const result = profilePhase(`ensureOverlay:${reason}`, () => spawnSync(process.execPath, generatorArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  }));
  if (result.status !== 0) {
    throw new Error(`Unable to generate overlay (${reason}): ${result.stderr || result.stdout}`);
  }
}

function queryOverlay(overlay, rawQuery, limit) {
  const query = rawQuery.toLowerCase();
  const queryTerms = queryTokens(query);
  const explicitTerms = explicitQueryTerms(rawQuery);
  const focusedTerms = focusedExplicitQueryTerms(rawQuery, explicitTerms);
  const hasExplicitPathTerm = queryTerms.some(isExplicitPathTerm);
  const candidates = buildNanoFlowOverlayCandidates(overlay);
  const scoredByDisplayKey = new Map();

  for (const candidate of candidates) {
    const pathScore = scorePathTermMatch(candidate.file, queryTerms);
    const focusedScore = scoreFocusedCandidateMatch(candidate, focusedTerms);
    const explicitScore = scoreExplicitCandidateMatch(candidate, focusedTerms, explicitTerms);
    const scored = {
      ...candidate,
      score: scoreNanoFlowSemanticCandidate(candidate, query, queryTerms, explicitScore, pathScore),
      explicitRank: hasExplicitPathTerm && pathScore > 0 ? 3 : focusedScore > 0 ? 2 : explicitScore > 0 ? 1 : 0,
      highValueRank: candidateHighValueRank(candidate),
    };
    if (scored.score <= 0) continue;
    const key = `${String(scored.name ?? '')}\0${String(scored.file ?? '')}`;
    const previous = scoredByDisplayKey.get(key);
    if (!previous || compareCandidateRank(scored, previous) < 0) {
      scoredByDisplayKey.set(key, scored);
    }
  }

  const rankedCandidates = [...scoredByDisplayKey.values()].sort(compareCandidateRank);
  return seedContext7RetrievalRouteCandidate(rankedCandidates, queryTerms)
    .slice(0, limit)
    .map(({ highValueRank: _highValueRank, explicitRank: _explicitRank, ...candidate }) => candidate);
}

function seedContext7RetrievalRouteCandidate(candidates, queryTerms) {
  if (queryTerms.length <= 1
    || !context7RetrievalSourceQueryApplies(queryTerms)
    || queryTerms.some(isExplicitPathTerm)) {
    return candidates;
  }
  const route = candidates.find(candidate => (
    candidate.item?.metadata?.relation === 'context7-retrieval-route'
    && queryTerms.some(term => candidateSearchText(candidate).includes(term))
  ));
  if (!route || candidates[0] === route) return candidates;
  return [route, ...candidates.filter(candidate => candidate !== route)];
}

function buildNanoFlowOverlayCandidates(overlay) {
  const componentFiles = new Set(overlay.angular.components.map(item => item.file));
  return [
    ...(overlay.graph?.nodes ?? [])
      .filter(isMarkdownSymbolNode)
      .map(node => ({
        kind: graphNodeCandidateKind(node),
        name: node.name,
        file: node.filePath,
        item: node,
      })),
    ...(overlay.typescript?.exports ?? []).map(item => ({
      kind: 'export',
      name: item.exportName ?? item.name,
      file: item.file,
      item,
    })),
    ...(overlay.typescript?.imports ?? []).map(item => ({
      kind: 'import',
      name: item.name ?? item.importedName,
      file: item.file,
      item,
    })),
    ...overlay.angular.components.map(item => ({ kind: 'angular-component', name: item.className, file: item.file, item })),
    ...overlay.angular.injectors
      .filter(item => !componentFiles.has(item.file))
      .map(item => ({ kind: 'angular-injector', name: item.file, file: item.file, item })),
    ...overlay.angular.dynamicImports.map(item => ({ kind: 'angular-dynamic-import', name: item.target, file: item.file, item })),
    ...(overlay.angular.routes ?? []).map(item => ({ kind: 'angular-route', name: item.path ?? item.component ?? item.loadComponent ?? item.loadChildren, file: item.file, item })),
    ...overlay.supabase.edgeFunctions.map(item => ({ kind: 'supabase-edge-function', name: item.name, file: item.entry, item })),
    ...overlay.supabase.migrations.map(item => ({ kind: 'supabase-migration', name: item.name, file: item.file, item })),
    ...overlay.agentRules.hardRules.map(item => ({ kind: 'agent-hard-rule', name: item.heading, file: item.file, item })),
    ...(overlay.agentRules.syncRules ?? []).map(item => ({ kind: 'agent-sync-rule', name: item.name, file: item.file, item })),
  ];
}

function compareCandidateRank(a, b) {
  return b.explicitRank - a.explicitRank
    || b.highValueRank - a.highValueRank
    || b.score - a.score
    || candidateKindPriority(a.kind) - candidateKindPriority(b.kind)
    || String(a.file ?? '').localeCompare(String(b.file ?? ''))
    || String(a.kind ?? '').localeCompare(String(b.kind ?? ''));
}

function scoreCandidate(candidate, query, queryTerms = queryTokens(query), explicitScore = 0, pathScore = undefined) {
  return scoreNanoFlowSemanticCandidate(candidate, query, queryTerms, explicitScore, pathScore);
}

function scoreNanoFlowSemanticCandidate(candidate, query, queryTerms = queryTokens(query), explicitScore = 0, pathScore = undefined) {
  const haystack = candidateSearchText(candidate);
  const matchedTerms = queryTerms.filter(term => haystack.includes(term));
  const resolvedPathScore = pathScore ?? scorePathTermMatch(candidate.file, queryTerms);
  if (!haystack.includes(query) && matchedTerms.length === 0 && resolvedPathScore <= 0 && explicitScore <= 0) return 0;

  let score = 1;
  const name = String(candidate.name ?? '').toLowerCase();
  if (haystack.includes(query)) score += 3;
  score += matchedTerms.length;
  score += resolvedPathScore;
  if (name === query) score += 8;
  if (name.includes(query)) score += 5;
  for (const term of matchedTerms) {
    if (name === term) score += 6;
    if (name.includes(term)) score += 3;
  }
  score += explicitScore;
  if (String(candidate.file ?? '').toLowerCase().includes(query)) score += 3;
  if (String(candidate.kind ?? '').toLowerCase().includes(query)) score += 2;
  return score;
}

function scoreExplicitCandidateMatch(candidate, focusedTerms, explicitTerms) {
  return scoreExplicitQueryTermText(
    joinSearchText([candidate.name, candidate.file, candidate.kind]),
    focusedTerms,
    explicitTerms,
    5000,
    400,
  );
}

function scoreFocusedCandidateMatch(candidate, focusedTerms) {
  return scoreExplicitQueryTermText(
    joinSearchText([candidate.name, candidate.file, candidate.kind]),
    focusedTerms,
    [],
    5000,
    400,
  );
}

function candidateSearchText(candidate) {
  return joinSearchText([
    candidate.kind,
    candidate.name,
    candidate.file,
    candidate.item?.name,
    candidate.item?.qualifiedName,
    candidate.item?.className,
    candidate.item?.selector,
    candidate.item?.path,
    candidate.item?.component,
    candidate.item?.loadComponent,
    candidate.item?.loadChildren,
    candidate.item?.exportName,
    candidate.item?.entry,
    candidate.item?.target,
    candidate.item?.heading,
    candidate.item?.ownerHeading,
    candidate.item?.body,
    candidate.item?.keywords,
    candidate.item?.signature,
    candidate.item?.decorators,
    candidate.item?.docstring,
    candidate.item?.returnType,
    candidate.item?.metadata,
    candidate.item?.dependencies,
    candidate.item?.imports,
    candidate.item?.providers,
    candidate.item?.tests,
    candidate.item?.riskTags,
  ]);
}

function selectGraphResults(overlay, rawQuery, matches, limit) {
  const graph = overlay.graph ?? { nodes: [], edges: [] };
  const query = rawQuery.toLowerCase();
  const queryTerms = queryTokens(query);
  const explicitTerms = explicitQueryTerms(rawQuery);
  const focusedTerms = focusedExplicitQueryTerms(rawQuery, explicitTerms);
  const graphIndexes = buildGraphIndexes(graph);
  const { nodesById, nodesByName, exportEdgesByName, equivalentIdsByDisplayKey, edgesByNodeId } = graphIndexes;
  const nodeSearchTextById = new Map();
  const getNodeSearchText = node => {
    if (!node) return '';
    const cacheKey = node.id ?? node;
    const cached = nodeSearchTextById.get(cacheKey);
    if (cached !== undefined) return cached;
    const text = nodeSearchText(node);
    nodeSearchTextById.set(cacheKey, text);
    return text;
  };
  const explicitPathScope = explicitPathScopeFilePaths(graph.nodes, queryTerms);
  const matchedNodeIds = new Set();
  const primaryIds = new Set();
  const relationResults = selectNanoFlowRelationGraphResults(graph, nodesById, query, queryTerms, limit);
  if (relationResults) {
    return augmentRelationResultsWithExplicitPathMatches(
      relationResults,
      matches,
      nodesById,
      nodesByName,
      edgesByNodeId,
      explicitPathScope,
    );
  }

  for (const id of seedExplicitPathScopedGraphNodeIds(
    graph.nodes,
    explicitPathScope,
    query,
    queryTerms,
    getNodeSearchText,
    focusedTerms,
    explicitTerms,
  )) {
    matchedNodeIds.add(id);
    primaryIds.add(id);
  }

  for (const match of matches) {
    if (!isInExplicitPathScope(match.file ?? match.item?.file ?? match.item?.entry, explicitPathScope)) {
      continue;
    }
    const directNode = match.item?.id ? nodesById.get(match.item.id) : null;
    const matchingNodes = directNode
      ? [directNode].filter(node => isInExplicitPathScope(node.filePath, explicitPathScope))
      : (nodesByName.get(match.name) ?? [])
        .filter(node => isInExplicitPathScope(node.filePath, explicitPathScope));
    const node = selectNodeForCandidateMatch(match, matchingNodes);
    if (node) {
      matchedNodeIds.add(node.id);
      primaryIds.add(node.id);
    }

    if (match.kind === 'export') {
      for (const edge of exportEdgesByName.get(match.name) ?? []) {
        if (
          !isInExplicitPathScope(nodesById.get(edge.source)?.filePath, explicitPathScope)
          && !isInExplicitPathScope(nodesById.get(edge.target)?.filePath, explicitPathScope)
        ) {
          continue;
        }
        matchedNodeIds.add(edge.source);
        primaryIds.add(edge.source);
        matchedNodeIds.add(edge.target);
      }
    }
  }

  const scoredMatches = [...matchedNodeIds]
    .map(id => {
      const node = nodesById.get(id);
      return {
        id,
        node,
        score: scoreGraphNode(node, query, queryTerms, getNodeSearchText(node), focusedTerms, explicitTerms),
      };
    })
    .filter(entry => entry.node)
    .sort((a, b) => highValueRank(b.node) - highValueRank(a.node)
      || b.score - a.score
      || compareNodeSpecificity(a.node, b.node))
    .filter(dedupeScoredEntryByDisplay())
    .slice(0, limit);

  const selectedIds = new Set(scoredMatches.map(entry => entry.id));
  for (const entry of scoredMatches) {
    for (const equivalentId of equivalentIdsByDisplayKey.get(displaySymbolKey(entry.node)) ?? []) {
      selectedIds.add(equivalentId);
    }
  }
  const selectedEdges = collectIncidentEdges(selectedIds, edgesByNodeId);
  const relatedSymbolIds = new Set(selectedIds);

  for (const edge of selectedEdges) {
    if (edge.kind === 'contains' && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (edge.kind === 'contains' && selectedIds.has(edge.source)) {
      relatedSymbolIds.add(edge.target);
    }
    if (primaryIds.has(edge.target) && edge.kind === 'type_of') {
      relatedSymbolIds.add(edge.source);
    }
    if (selectedIds.has(edge.source) && (edge.kind === 'returns' || edge.kind === 'instantiates' || edge.kind === 'type_of')) {
      relatedSymbolIds.add(edge.target);
    }
    if (edge.metadata?.relation === 'sync-rule' && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (edge.metadata?.relation === 'hard-rule-keyword' && selectedIds.has(edge.source)) {
      relatedSymbolIds.add(edge.target);
    }
    if (edge.metadata?.relation === 'hard-rule-keyword' && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (isHardRuleEvidenceRelation(edge.metadata?.relation) && selectedIds.has(edge.source)) {
      relatedSymbolIds.add(edge.target);
    }
    if (isHardRuleEvidenceRelation(edge.metadata?.relation) && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (edge.metadata?.relation === 'sync-rule-keyword' && selectedIds.has(edge.source)) {
      relatedSymbolIds.add(edge.target);
    }
    if (edge.metadata?.relation === 'sync-rule-keyword' && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (edge.metadata?.relation === 'sync-config-source' && selectedIds.has(edge.source)) {
      relatedSymbolIds.add(edge.target);
    }
    if (edge.metadata?.relation === 'sync-config-source' && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (edge.metadata?.relation === 'sync-required-predicate' && selectedIds.has(edge.source)) {
      relatedSymbolIds.add(edge.target);
    }
    if (edge.metadata?.relation === 'sync-required-predicate' && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (edge.metadata?.relation === 'config-source' && selectedIds.has(edge.source)) {
      relatedSymbolIds.add(edge.target);
    }
    if (edge.metadata?.relation === 'config-source' && selectedIds.has(edge.target)) {
      relatedSymbolIds.add(edge.source);
    }
    if (CONTEXT7_RELATION_CLOSURE.has(edge.metadata?.relation)
      && (selectedIds.has(edge.source) || selectedIds.has(edge.target))) {
      relatedSymbolIds.add(edge.source);
      relatedSymbolIds.add(edge.target);
    }
  }
  addQualifiedOwnerSymbols(relatedSymbolIds, nodesById);
  addSelectedImportExportStructureNodes(relatedSymbolIds, nodesById, edgesByNodeId, queryTerms);

  if (explicitPathScope.size > 0) {
    for (const id of [...relatedSymbolIds]) {
      if (!isInExplicitPathScope(nodesById.get(id)?.filePath, explicitPathScope)) {
        relatedSymbolIds.delete(id);
      }
    }
  }

  const incidentRelatedEdges = collectIncidentEdges(relatedSymbolIds, edgesByNodeId);
  const relatedEdges = explicitPathScope.size > 0
    ? incidentRelatedEdges.filter(edge => relatedSymbolIds.has(edge.source) && relatedSymbolIds.has(edge.target))
    : incidentRelatedEdges;

  const nodes = [...relatedSymbolIds]
    .map(id => nodesById.get(id))
    .filter(Boolean)
    .filter(isMarkdownSymbolNode)
    .sort(compareNodeSpecificity)
    .filter(dedupeNodeByDisplay())
    .sort(compareNode);

  const edges = relatedEdges
    .filter(edge => nodesById.has(edge.source) && nodesById.has(edge.target))
    .map(edge => ({
      ...edge,
      sourceName: nodesById.get(edge.source)?.name ?? edge.source,
      targetName: nodesById.get(edge.target)?.name ?? edge.target,
    }))
    .sort(compareEdge);

  return { nodes, edges };
}

function augmentRelationResultsWithExplicitPathMatches(
  relationResults,
  matches,
  nodesById,
  nodesByName,
  edgesByNodeId,
  explicitPathScope,
) {
  if (explicitPathScope.size === 0) return relationResults;

  const selectedIds = new Set(relationResults.nodes.map(node => node.id));
  for (const match of matches) {
    if (!isInExplicitPathScope(match.file ?? match.item?.file ?? match.item?.entry, explicitPathScope)) {
      continue;
    }
    const directNode = match.item?.id ? nodesById.get(match.item.id) : null;
    const matchingNodes = directNode
      ? [directNode].filter(node => isInExplicitPathScope(node.filePath, explicitPathScope))
      : (nodesByName.get(match.name) ?? [])
        .filter(node => isInExplicitPathScope(node.filePath, explicitPathScope));
    const node = selectNodeForCandidateMatch(match, matchingNodes);
    if (node && (isMarkdownSymbolNode(node) || node.kind === 'file')) {
      selectedIds.add(node.id);
    }
  }

  const nodes = [...selectedIds]
    .map(id => nodesById.get(id))
    .filter(Boolean)
    .filter(node => isMarkdownSymbolNode(node) || node.kind === 'file')
    .sort(compareNodeSpecificity)
    .filter(dedupeNodeByDisplay())
    .sort(compareNode);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = uniqueBy([
    ...relationResults.edges,
    ...collectIncidentEdges(nodeIds, edgesByNodeId)
      .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map(edge => ({
        ...edge,
        sourceName: nodesById.get(edge.source)?.name ?? edge.source,
        targetName: nodesById.get(edge.target)?.name ?? edge.target,
      })),
  ], edge => JSON.stringify({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    column: edge.column,
    metadata: edge.metadata,
  })).sort(compareEdge);

  return { nodes, edges };
}

function seedExplicitPathScopedGraphNodeIds(nodes, explicitPathScope, query, queryTerms, getNodeSearchText, focusedTerms, explicitTerms) {
  if (explicitPathScope.size === 0) return [];
  const ids = [];
  for (const node of nodes) {
    if (!isInExplicitPathScope(node.filePath, explicitPathScope)) continue;
    const score = scoreGraphNode(node, query, queryTerms, getNodeSearchText(node), focusedTerms, explicitTerms);
    if (score > 0) {
      ids.push(node.id);
    }
  }
  return ids;
}

function selectNanoFlowRelationGraphResults(graph, nodesById, query, queryTerms, limit) {
  const exactRelationEdges = sortExactRelationEdgesForSelection(
    nodesById,
    graph.edges.filter(edge => edgeMatchesExactMetadataQuery(edge, query)),
    query,
  );

  if (exactRelationEdges.length > 0) {
    return selectExactRelationResults(graph, nodesById, exactRelationEdges, limit, query);
  }

  const angularSemanticApiEdges = selectAngularSemanticApiEdges(graph.edges, queryTerms);
  if (angularSemanticApiEdges.length > 0) {
    return selectExactRelationResults(
      graph,
      nodesById,
      sortAngularSemanticApiEdgesForSelection(nodesById, angularSemanticApiEdges),
      limit,
      query,
    );
  }

  const exactRelationQueries = exactMetadataQueriesFromTerms(graph.edges, queryTerms);
  if (exactRelationQueries.length > 1) {
    const remainingTerms = queryTerms.filter(term => (
      !exactRelationQueries.includes(term)
      && !isCombinedExactRelationQueryTerm(term, exactRelationQueries)
    ));
    const endpointConstraintTerms = specificEndpointConstraintTerms(remainingTerms);
    const relationEdges = graph.edges
      .filter(edge => exactRelationQueries.some(relation => edgeMatchesExactMetadataQuery(edge, relation)));
    const constrainedEdges = endpointConstraintTerms.length > 0
      ? relationEdges.filter(edge => edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, endpointConstraintTerms))
      : relationEdges;
    if (constrainedEdges.length > 0 || remainingTerms.length > 0) {
      return selectExactRelationResults(
        graph,
        nodesById,
        sortExactRelationEdgesForSelection(nodesById, constrainedEdges, exactRelationQueries[0]),
        limit,
        exactRelationQueries[0],
      );
    }
  }
  if (
    exactRelationQueries.length > 1
    && queryTerms.every(term => exactRelationQueries.includes(term) || term.includes('/'))
  ) {
    const relationEdges = graph.edges
      .filter(edge => exactRelationQueries.some(relation => edgeMatchesExactMetadataQuery(edge, relation)));
    return selectExactRelationResults(
      graph,
      nodesById,
      sortExactRelationEdgesForSelection(nodesById, relationEdges, exactRelationQueries[0]),
      limit,
      exactRelationQueries[0],
    );
  }

  const exactRelationQuery = exactMetadataQueryFromTerms(graph.edges, queryTerms);
  if (exactRelationQuery) {
    const remainingTerms = queryTerms.filter(term => term !== exactRelationQuery);
    const endpointConstraintTerms = specificEndpointConstraintTerms(remainingTerms);
    const relationEdges = graph.edges
      .filter(edge => edgeMatchesExactMetadataQuery(edge, exactRelationQuery));
    const constrainedEdges = endpointConstraintTerms.length > 0
      ? relationEdges.filter(edge => edgeMatchesQueryTermsWithEndpoints(edge, nodesById, endpointConstraintTerms)
        || (usesAnyEndpointTermConstraint(exactRelationQuery)
          && edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, endpointConstraintTerms)))
      : relationEdges;
    const relaxedEdges = constrainedEdges.length > 0 || endpointConstraintTerms.length === 0
      ? constrainedEdges
      : relationEdges.filter(edge => edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, endpointConstraintTerms));
    if (relaxedEdges.length > 0 || remainingTerms.length > 0) {
      return selectExactRelationResults(
        graph,
        nodesById,
        sortExactRelationEdgesForSelection(nodesById, relaxedEdges, exactRelationQuery),
        limit,
        exactRelationQuery,
      );
    }
  }

  return null;
}

function sortExactRelationEdgesForSelection(nodesById, edges, query) {
  const sourceFirst = codeBlockSourceFirstRelationQueries().has(normalizeExactRelationQuery(query));
  if (!sourceFirst) return [...edges].sort(compareEdge);
  return [...edges].sort((a, b) => (
    compareExactRelationEdgeSourceOrder(nodesById, a, b, sourceFirst)
    || compareEdge(a, b)
  ));
}

function selectAngularSemanticApiEdges(edges, queryTerms) {
  const requestedApis = new Set(queryTerms.filter(term => ANGULAR_SEMANTIC_API_QUERY_TERMS.has(term)));
  if (requestedApis.size === 0) return [];
  return edges.filter(edge => requestedApis.has(normalizeAngularSemanticApi(edge?.metadata?.api)));
}

function sortAngularSemanticApiEdgesForSelection(nodesById, edges) {
  return [...edges].sort((a, b) => (
    compareNodeSourceOrder(nodesById.get(a.source), nodesById.get(b.source))
    || String(a?.metadata?.api ?? '').localeCompare(String(b?.metadata?.api ?? ''))
    || compareNodeSourceOrder(nodesById.get(a.target), nodesById.get(b.target))
    || compareEdge(a, b)
  ));
}

function normalizeAngularSemanticApi(api) {
  return String(api ?? '').toLowerCase();
}

function isStrongSingleTermNodeMatch(node, query, term) {
  if (!node) return false;
  const names = [
    node.name,
    node.qualifiedName,
    readQualifiedNameLeaf(node.qualifiedName),
  ].map(value => String(value ?? '').toLowerCase()).filter(Boolean);
  return names.some(name => name === query || name === term || name.startsWith(query) || name.startsWith(term));
}

function addQualifiedOwnerSymbols(symbolIds, nodesById) {
  const ownerKinds = new Set([
    'class',
    'interface',
    'type_alias',
    'constant',
    'variable',
    'namespace',
    'enum',
  ]);
  const nodes = [...nodesById.values()];
  for (const id of [...symbolIds]) {
    const node = nodesById.get(id);
    const ownerName = readQualifiedOwnerName(node?.qualifiedName);
    if (!ownerName) continue;
    const owner = nodes.find(candidate => (
      ownerKinds.has(candidate.kind)
      && candidate.filePath === node.filePath
      && (candidate.qualifiedName === ownerName || candidate.name === ownerName)
    ));
    if (owner) {
      symbolIds.add(owner.id);
    }
  }
}

function addSelectedImportExportStructureNodes(symbolIds, nodesById, edgesByNodeId, queryTerms = []) {
  const selectedNames = new Set([...symbolIds]
    .map(id => nodesById.get(id))
    .filter(Boolean)
    .flatMap(node => [
      node.name,
      node.qualifiedName,
      node.metadata?.exportName,
      node.metadata?.importedName,
    ])
    .map(value => String(value ?? '').trim())
    .filter(Boolean));
  const selectedFiles = new Set([...symbolIds]
    .map(id => nodesById.get(id)?.id)
    .filter(Boolean)
    .filter(id => nodesById.get(id)?.kind === 'file'));
  if (selectedNames.size === 0 || selectedFiles.size === 0) {
    return;
  }

  for (const fileId of selectedFiles) {
    for (const edge of edgesByNodeId.get(fileId) ?? []) {
      if (edge.kind !== 'contains' || edge.source !== fileId) {
        continue;
      }
      const targetNode = nodesById.get(edge.target);
      if (!targetNode || (targetNode.kind !== 'import' && targetNode.kind !== 'export')) {
        continue;
      }
      if (selectedImportExportStructureNodeMatches(targetNode, selectedNames, queryTerms)) {
        symbolIds.add(targetNode.id);
      }
    }
  }
}

function selectedImportExportStructureNodeMatches(node, selectedNames, queryTerms = []) {
  const names = [
    node.name,
    node.qualifiedName,
    node.metadata?.exportName,
    node.metadata?.importedName,
  ].map(value => String(value ?? '').trim()).filter(Boolean);
  if (names.some(name => selectedNames.has(name))) {
    return true;
  }
  const searchText = joinSearchText(names);
  return queryTerms.some(term => searchText.includes(term));
}

function readQualifiedOwnerName(qualifiedName) {
  const parts = String(qualifiedName ?? '').split('::').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('::') : null;
}

function readQualifiedNameLeaf(qualifiedName) {
  return String(qualifiedName ?? '').split('::').filter(Boolean).at(-1) ?? '';
}

function buildGraphIndexes(graph) {
  const nodesById = new Map();
  const nodesByName = new Map();
  const exportEdgesByName = new Map();
  const equivalentIdsByDisplayKey = new Map();
  const edgesByNodeId = new Map();

  for (const node of graph.nodes) {
    nodesById.set(node.id, node);
    appendMapValue(nodesByName, node.name, node);
    appendMapValue(equivalentIdsByDisplayKey, displaySymbolKey(node), node.id);
  }

  for (const group of nodesByName.values()) {
    group.sort(compareNodeSpecificity);
  }

  for (const edge of graph.edges) {
    appendMapValue(edgesByNodeId, edge.source, edge);
    appendMapValue(edgesByNodeId, edge.target, edge);
    if (edge.kind === 'exports' && edge.metadata?.exportName) {
      appendMapValue(exportEdgesByName, edge.metadata.exportName, edge);
    }
  }

  return { nodesById, nodesByName, exportEdgesByName, equivalentIdsByDisplayKey, edgesByNodeId };
}

function collectIncidentEdges(nodeIds, edgesByNodeId) {
  const seen = new Set();
  const edges = [];
  for (const id of nodeIds) {
    for (const edge of edgesByNodeId.get(id) ?? []) {
      if (seen.has(edge)) continue;
      seen.add(edge);
      edges.push(edge);
    }
  }
  return edges;
}

function explicitPathScopeFilePaths(nodes, queryTerms) {
  const explicitTerms = queryTerms.filter(isExplicitPathTerm);
  if (explicitTerms.length === 0) return new Set();
  const scopedPaths = new Set();
  for (const node of nodes) {
    if (!node?.filePath) continue;
    if (explicitTerms.some(term => explicitPathTermMatchesFilePath(term, node.filePath))) {
      scopedPaths.add(node.filePath);
    }
  }
  return scopedPaths;
}

function explicitPathTermMatchesFilePath(term, filePath) {
  const normalizedTerm = normalizeSearchPath(term);
  const normalizedPath = normalizeSearchPath(filePath);
  if (!normalizedTerm || !normalizedPath) return false;
  const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;
  return normalizedPath === normalizedTerm
    || fileName === normalizedTerm
    || normalizedPath.endsWith(`/${normalizedTerm}`)
    || normalizedTerm.endsWith(`/${normalizedPath}`);
}

function isInExplicitPathScope(filePath, explicitPathScope) {
  return explicitPathScope.size === 0 || explicitPathScope.has(filePath);
}

function appendMapValue(map, key, value) {
  if (key === undefined || key === null) return;
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function dedupeScoredEntryByDisplay() {
  const seen = new Set();
  return entry => {
    const key = displaySymbolKey(entry.node);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function dedupeNodeByDisplay() {
  const seen = new Set();
  return node => {
    const key = displaySymbolKey(node);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function selectExactRelationResults(graph, nodesById, exactRelationEdges, limit, query) {
  const selectedEdges = expandExactRelationEdges(graph, exactRelationEdges.slice(0, limit), query);
  const sourceFirst = codeBlockSourceFirstRelationQueries().has(normalizeExactRelationQuery(query));
  const selectedIds = new Set();
  for (const edge of selectedEdges) {
    selectedIds.add(edge.source);
    selectedIds.add(edge.target);
  }

  const nodes = [...selectedIds]
    .map(id => nodesById.get(id))
    .filter(Boolean)
    .filter(node => isMarkdownSymbolNode(node) || node.kind === 'file')
    .sort(compareNodeSpecificity)
    .sort(compareNode);

  const edges = selectedEdges
    .filter(edge => nodesById.has(edge.source) && nodesById.has(edge.target))
    .map(edge => ({
      ...edge,
      sourceName: nodesById.get(edge.source)?.name ?? edge.source,
      targetName: nodesById.get(edge.target)?.name ?? edge.target,
    }))
    .sort((a, b) => (
      compareExactRelationEdgeDisplayOrder(nodesById, a, b, query, sourceFirst)
      || compareEdge(a, b)
    ));

  return { nodes, edges };
}

function exactRelationDisplayPriority(edge, query) {
  return edgeMatchesExactMetadataQuery(edge, normalizeExactRelationQuery(query)) ? 0 : 1;
}

function compareExactRelationEdgeDisplayOrder(nodesById, a, b, query, sourceFirst) {
  if (usesTargetGroupedProvenanceDisplay(query)) {
    return compareNodeSourceOrder(nodesById.get(a.target), nodesById.get(b.target))
      || exactRelationDisplayPriority(a, query) - exactRelationDisplayPriority(b, query)
      || compareNodeSourceOrder(nodesById.get(a.source), nodesById.get(b.source));
  }
  return exactRelationDisplayPriority(a, query) - exactRelationDisplayPriority(b, query)
    || compareExactRelationEdgeSourceOrder(nodesById, a, b, sourceFirst);
}

function usesTargetGroupedProvenanceDisplay(query) {
  return new Set([
    'supabase-incremental-predicate',
    'sync-required-predicate',
  ]).has(normalizeExactRelationQuery(query));
}

function expandExactRelationEdges(graph, selectedEdges, query) {
  if (query === 'edge-function-invoke') {
    const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
    const routeOwnerEdges = graph.edges.filter(edge => (
      selectedTargets.has(edge.target)
      && edge.metadata?.relation === 'edge-function-route'
      && edge.kind === 'references'
    ));
    return uniqueBy([...selectedEdges, ...routeOwnerEdges], edge => JSON.stringify(edge));
  }

  if (query === 'android-widget-provider') {
    const selectedSources = new Set(selectedEdges.map(edge => edge.source));
    const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
    const manifestEdges = graph.edges.filter(edge => (
      selectedSources.has(edge.target)
      && edge.metadata?.relation === 'android-manifest-component'
      && edge.kind === 'references'
    ));
    const resourceReferenceEdges = graph.edges.filter(edge => (
      selectedTargets.has(edge.source)
      && edge.metadata?.relation === 'android-resource-reference'
      && edge.kind === 'imports'
    ));
    return uniqueBy([...manifestEdges, ...selectedEdges, ...resourceReferenceEdges], edge => JSON.stringify(edge));
  }

  if (query === 'android-kotlin-method') {
    const selectedMethods = new Set(selectedEdges.flatMap(edge => [edge.source, edge.target]));
    const callEdges = graph.edges.filter(edge => (
      edge.kind === 'calls'
      && edge.metadata?.relation === 'android-kotlin-call'
      && (selectedMethods.has(edge.source) || selectedMethods.has(edge.target))
    ));
    return uniqueBy([...selectedEdges, ...callEdges], edge => JSON.stringify(edge));
  }

  if (query === 'supabase-incremental-predicate') {
    const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
    const requiredPredicateEdges = graph.edges.filter(edge => (
      selectedTargets.has(edge.target)
      && edge.metadata?.relation === 'sync-required-predicate'
      && edge.kind === 'references'
    ));
    return uniqueBy([...selectedEdges, ...requiredPredicateEdges], edge => JSON.stringify(edge));
  }

  if (query === 'sync-required-predicate') {
    const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
    const provenanceEdges = graph.edges.filter(edge => (
      selectedTargets.has(edge.target)
      && edge.metadata?.relation === 'supabase-incremental-predicate'
      && edge.kind === 'references'
    ));
    return uniqueBy([...selectedEdges, ...provenanceEdges], edge => JSON.stringify(edge));
  }

  if (query === 'sync-config-source') {
    const selectedSources = new Set(selectedEdges.map(edge => edge.source));
    const provenanceEdges = graph.edges.filter(edge => (
      selectedSources.has(edge.source)
      && edge.metadata?.relation === 'config-source'
      && edge.kind === 'references'
    ));
    return uniqueBy([...selectedEdges, ...provenanceEdges], edge => JSON.stringify(edge));
  }

  if (query !== 'sync-required-field') return selectedEdges;
  const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
  const provenanceEdges = graph.edges.filter(edge => (
    selectedTargets.has(edge.target)
    && edge.metadata?.relation === 'supabase-select-field'
    && edge.kind === 'references'
  ));
  return uniqueBy([...selectedEdges, ...provenanceEdges], edge => JSON.stringify(edge));
}

function selectNodeForCandidateMatch(match, matchingNodes) {
  if (match?.kind === 'agent-sync-rule') {
    return matchingNodes.find(node => node.metadata?.relation === 'sync-rule') ?? matchingNodes[0];
  }
  if (match?.kind === 'agent-hard-rule') {
    return matchingNodes.find(node => node.metadata?.relation === 'hard-rule') ?? matchingNodes[0];
  }
  return matchingNodes[0];
}

function candidateKindPriority(kind) {
  if (kind === 'angular-component' || kind === 'component') return 0;
  if (kind === 'angular-route' || kind === 'route') return 1;
  if (kind === 'angular-injector') return 2;
  if (kind === 'agent-sync-rule') return 3;
  if (kind === 'agent-hard-rule') return 3;
  if (kind === 'export') return 9;
  return nodeKindPriority(kind);
}

function graphNodeCandidateKind(node) {
  if (node?.metadata?.relation === 'sync-rule') return 'agent-sync-rule';
  if (node?.metadata?.relation === 'hard-rule') return 'agent-hard-rule';
  if (node?.metadata?.relation === 'hard-rule-keyword') return 'agent-hard-rule-keyword';
  return node.kind;
}

function candidateHighValueRank(candidate) {
  if (candidate.kind === 'angular-component' || candidate.kind === 'angular-route' || candidate.kind === 'angular-injector') {
    return 1;
  }
  if (candidate.kind === 'supabase-migration') {
    return 1;
  }
  if (candidate.kind === 'agent-sync-rule' || candidate.kind === 'agent-hard-rule') {
    return 1;
  }
  return isHighValueEntryPoint(candidate.item) ? 1 : 0;
}

function scoreGraphNode(
  node,
  query,
  queryTerms = queryTokens(query),
  searchText = undefined,
  focusedTerms = focusedExplicitQueryTerms(query),
  explicitTerms = explicitQueryTerms(query),
) {
  if (!node) return 0;
  const haystack = searchText ?? nodeSearchText(node);
  const matchedTerms = queryTerms.filter(term => haystack.includes(term));
  const pathScore = scorePathTermMatch(node.filePath, queryTerms);
  const explicitScore = scoreExplicitQueryTermText(
    joinSearchText([node.name, node.qualifiedName, node.filePath, node.kind]),
    focusedTerms,
    explicitTerms,
    5000,
    400,
  );
  if (!haystack.includes(query) && matchedTerms.length === 0 && pathScore <= 0 && explicitScore <= 0) return 0;

  let score = 1;
  const name = String(node.name ?? '').toLowerCase();
  if (haystack.includes(query)) score += 4;
  score += matchedTerms.length;
  score += pathScore;
  if (name === query) score += 20;
  if (name.includes(query)) score += 10;
  for (const term of matchedTerms) {
    if (name === term) score += 12;
    if (name.includes(term)) score += 5;
  }
  score += explicitScore;
  if (String(node.filePath ?? '').toLowerCase().includes(query)) score += 5;
  if (String(node.kind ?? '').toLowerCase().includes(query)) score += 2;
  return score;
}

function nodeSearchText(node) {
  return joinSearchText([
    node.kind,
    node.name,
    node.qualifiedName,
    node.filePath,
    node.language,
    node.signature,
    node.decorators,
    node.docstring,
    node.returnType,
    node.metadata,
  ]);
}

function nodeCoreSearchText(node) {
  return joinSearchText([
    node?.kind,
    node?.name,
    node?.qualifiedName,
    node?.filePath,
    node?.language,
  ]);
}

function edgeSearchText(edge) {
  return joinSearchText([
    edge.kind,
    edge.source,
    edge.target,
    edge.sourceName,
    edge.targetName,
    edge.provenance,
    edge.metadata?.bindingKind,
    edge.metadata,
  ]);
}

function joinSearchText(values) {
  return values
    .flatMap(value => searchableTextParts(value))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function searchableTextParts(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => searchableTextParts(item));
  }
  if (typeof value === 'object') {
    return Object.values(value).flatMap(item => searchableTextParts(item));
  }
  return [String(value)];
}

function edgeMatchesExactMetadataQuery(edge, query) {
  if (!edge?.metadata) return false;
  return ['relation', 'synthesizedBy', 'bindingKind', 'testMapping', 'keywordMapping'].some(key => (
    String(edge.metadata[key] ?? '').toLowerCase() === query
  ));
}

function exactMetadataQueryFromTerms(edges, queryTerms) {
  return exactMetadataQueriesFromTerms(edges, queryTerms)[0] ?? null;
}

function exactMetadataQueriesFromTerms(edges, queryTerms) {
  return unique(queryTerms
    .flatMap(term => [term, ...String(term ?? '').split('/')])
    .map(term => String(term ?? '').trim().toLowerCase())
    .filter(Boolean)
    .filter(isMixedExactMetadataQueryTerm))
    .filter(term => edges.some(edge => edgeMatchesExactMetadataQuery(edge, term)));
}

function isCombinedExactRelationQueryTerm(term, exactRelationQueries) {
  const parts = String(term ?? '')
    .split('/')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 1 && parts.every(part => exactRelationQueries.includes(part));
}

function isMixedExactMetadataQueryTerm(term) {
  const normalized = String(term ?? '').toLowerCase();
  return normalized.includes('-') || relationPolicySet([
    'dependency',
    'provider',
  ]).has(normalized);
}

function edgeMatchesQueryTermsWithEndpoints(edge, nodesById, queryTerms) {
  if (queryTerms.length === 0) return true;
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const haystack = joinSearchText([
    edgeSearchText(edge),
    sourceNode ? nodeSearchText(sourceNode) : '',
    targetNode ? nodeSearchText(targetNode) : '',
  ]);
  return queryTerms.every(term => haystack.includes(term));
}

function edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, queryTerms) {
  if (queryTerms.length === 0) return true;
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const haystack = joinSearchText([
    edgeSearchText(edge),
    sourceNode ? nodeSearchText(sourceNode) : '',
    targetNode ? nodeSearchText(targetNode) : '',
  ]);
  return queryTerms.some(term => haystack.includes(term));
}

function specificEndpointConstraintTerms(queryTerms) {
  const genericTerms = new Set([
    'block',
    'blocks',
    'code',
    'context',
    'edge',
    'entries',
    'entry',
    'function',
    'functions',
    'implementation',
    'implementations',
    'invoke',
    'invokes',
    'order',
    'ordering',
    'point',
    'points',
    'quality',
    'reference',
    'references',
    'route',
    'routes',
    'source',
    'sources',
    'supabase',
    'test',
    'tests',
    'mapping',
    'mappings',
  ]);
  return queryTerms.filter(term => !genericTerms.has(String(term ?? '').toLowerCase()));
}

function usesAnyEndpointTermConstraint(query) {
  return anyEndpointTermRelationQueries().has(normalizeExactRelationQuery(query));
}

function anyEndpointTermRelationQueries() {
  return relationPolicySet([
    'android-kotlin-annotation',
    'android-kotlin-constructor',
    'android-kotlin-import',
    'android-kotlin-method',
    'android-kotlin-property',
    'android-kotlin-type-reference',
    'edge-function-header',
    'edge-function-invoke',
    'edge-function-method',
    'supabase-realtime-channel',
    'supabase-realtime-postgres-change',
    'supabase-realtime-status',
    'supabase-realtime-unsubscribe',
    'supabase-realtime-remove-channel',
    'supabase-realtime-remove-all-channels',
  ]);
}

function toNativeEdge(edge) {
  return omitUndefined({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    metadata: edge.metadata,
    line: edge.line,
    column: edge.column,
    provenance: edge.provenance,
  });
}

function omitUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function queryTokens(query) {
  return unique(query
    .split(/[^a-z0-9_$:.@/\\-]+/i)
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length >= 2));
}

function explicitQueryTerms(rawQuery = '') {
  return unique(String(rawQuery ?? '')
    .split(/[^a-z0-9_$:.@/\\-]+/i)
    .map(term => term.trim())
    .filter(term => term.length >= 2)
    .filter(term => isExplicitPathTerm(term) || isLikelyExplicitSymbolTerm(term))
    .map(term => term.toLowerCase()));
}

function focusedExplicitQueryTerms(rawQuery = '', explicitTerms = explicitQueryTerms(rawQuery)) {
  const query = String(rawQuery ?? '').toLowerCase();
  return explicitTerms.filter(term => {
    const index = query.indexOf(term);
    if (index < 0) return false;
    const prefix = query.slice(Math.max(0, index - 24), index);
    return /(直接看|查看|看|定位|打开|源码|定义|inspect|show|source)\s*$/.test(prefix);
  });
}

function isLikelyExplicitSymbolTerm(term) {
  const value = String(term ?? '');
  if (value.length < 6) return false;
  if (value.includes('::')) return true;
  return /[a-z0-9][A-Z]/.test(value) || /[A-Z]{2,}[a-z]/.test(value);
}

function scoreExplicitQueryTermText(text, focusedTerms = [], explicitTerms = [], focusedScore = 5000, explicitScore = 400) {
  const normalizedText = String(text ?? '').toLowerCase();
  if (!normalizedText) return 0;

  let score = 0;
  const focusedSet = new Set(focusedTerms);
  for (const term of focusedTerms) {
    if (normalizedText.includes(term)) {
      score += focusedScore + term.length;
    }
  }
  for (const term of explicitTerms) {
    if (focusedSet.has(term)) continue;
    if (normalizedText.includes(term)) {
      score += explicitScore + term.length;
    }
  }
  return score;
}

function scorePathTermMatch(filePath, queryTerms) {
  const normalizedPath = normalizeSearchPath(filePath);
  if (!normalizedPath) return 0;

  const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;
  const querySegmentSet = new Set(queryTerms.flatMap(searchPathSignalSegments));
  let score = 0;
  for (const term of queryTerms.filter(isExplicitPathTerm)) {
    const normalizedTerm = normalizeSearchPath(term);
    if (!normalizedTerm) continue;
    if (normalizedPath === normalizedTerm || fileName === normalizedTerm) {
      score += 250;
      continue;
    }
    if (normalizedPath.endsWith(`/${normalizedTerm}`)) {
      score += 220;
      continue;
    }
    if (normalizedTerm.endsWith(`/${normalizedPath}`) || normalizedTerm.endsWith(`/${fileName}`)) {
      score += 220;
      continue;
    }
    if (normalizedPath.includes(normalizedTerm)) {
      score += 120;
    }
  }
  score += scorePathSegmentCoverage(fileName, querySegmentSet, 90);
  score += scorePathSegmentCoverage(normalizedPath, querySegmentSet, 45);
  return score;
}

function queryScoringContext(rawQuery = '') {
  const query = String(rawQuery ?? '').toLowerCase();
  const queryTerms = queryTokens(query);
  const explicitTerms = explicitQueryTerms(rawQuery);
  const focusedTerms = focusedExplicitQueryTerms(rawQuery, explicitTerms);
  return {
    query,
    queryTerms,
    explicitTerms,
    focusedTerms,
  };
}

function scoreNodeRelevanceForQuery(node, context) {
  return {
    explicitScore: scoreExplicitQueryTermText(
      joinSearchText([node?.name, node?.qualifiedName, node?.filePath, node?.kind]),
      context.focusedTerms,
      context.explicitTerms,
      5000,
      400,
    ),
    coreScore: scoreGraphNode(
      node,
      context.query,
      context.queryTerms,
      nodeCoreSearchText(node),
      context.focusedTerms,
      context.explicitTerms,
    ),
    fullScore: scoreGraphNode(
      node,
      context.query,
      context.queryTerms,
      nodeSearchText(node),
      context.focusedTerms,
      context.explicitTerms,
    ),
  };
}

function fillGraphNodeBudgetWithRelevantEndpoints(nodes, edges, graphNodes, rawQuery, limit) {
  if (nodes.length === 0) return nodes;
  const queryTerms = queryTokens(rawQuery);
  if (queryTargetsExactMemberNode(nodes, queryTerms)) return nodes;
  const nodesById = new Map(graphNodes.map(node => [node.id, node]));
  if (nodes.length >= limit) {
    return retainEssentialAngularResourceEndpoints(nodes, edges, nodesById, rawQuery, limit);
  }
  const selected = [...nodes];
  const selectedIds = new Set(nodes.map(node => node.id));
  const selectedDisplayKeys = new Set(nodes.map(displaySymbolKey));
  const includeTestEdges = queryAllowsTestFiles(rawQuery);
  const structuralEdgeKinds = new Set(['imports', 'exports']);
  const addNode = node => {
    if (!node || selected.length >= limit || !isMarkdownSymbolNode(node)) return false;
    const displayKey = displaySymbolKey(node);
    if (selectedIds.has(node.id) || selectedDisplayKeys.has(displayKey)) return false;
    selected.push(node);
    selectedIds.add(node.id);
    selectedDisplayKeys.add(displayKey);
    return true;
  };
  const isSelected = id => {
    if (selectedIds.has(id)) return true;
    const node = nodesById.get(id);
    return Boolean(node && selectedDisplayKeys.has(displaySymbolKey(node)));
  };

  let changed = true;
  while (changed && selected.length < limit) {
    changed = false;
    for (const edge of edges) {
      const sourceSelected = isSelected(edge.source);
      const targetSelected = isSelected(edge.target);
      if (!sourceSelected && !targetSelected) continue;
      if (edge.metadata?.relation === 'test' && !includeTestEdges) continue;
      if (!structuralEdgeKinds.has(edge.kind)
        && !edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, queryTerms)) {
        continue;
      }
      changed = addNode(nodesById.get(edge.source)) || changed;
      changed = addNode(nodesById.get(edge.target)) || changed;
      if (selected.length >= limit) break;
    }
  }
  return retainEssentialAngularResourceEndpoints(selected, edges, nodesById, rawQuery, limit);
}

function queryTargetsExactMemberNode(nodes, queryTerms) {
  if (queryTerms.length !== 1) return false;
  const [term] = queryTerms;
  const hasExactOwnerNode = nodes.some(node => (
    node?.kind !== 'method'
    && node?.kind !== 'property'
    && [node.name, node.qualifiedName]
      .some(value => String(value ?? '').toLowerCase() === term)
  ));
  if (hasExactOwnerNode) return false;
  return nodes.some(node => (
    (node?.kind === 'method' || node?.kind === 'property')
    && [node.name, readQualifiedNameLeaf(node.qualifiedName)]
      .some(value => String(value ?? '').toLowerCase() === term)
  ));
}

function retainEssentialAngularResourceEndpoints(nodes, edges, nodesById, rawQuery, limit) {
  const selected = [...nodes];
  const selectedIds = new Set(selected.map(node => node.id));
  const selectedComponentKeys = new Set(selected
    .filter(node => node.kind === 'component')
    .map(node => joinSearchText([node.name, node.filePath, node.startLine])));
  const protectedIds = new Set();
  if (selectedComponentKeys.size === 0) {
    retainQuerySemanticEndpoints(selected, selectedIds, protectedIds, edges, nodesById, rawQuery, limit);
    return selected;
  }
  const selectedComponentIds = new Set(selected
    .filter(node => selectedComponentKeys.has(joinSearchText([node.name, node.filePath, node.startLine])))
    .map(node => node.id));
  for (const id of selectedComponentIds) protectedIds.add(id);
  const candidates = edges
    .filter(edge => (
      selectedComponentIds.has(edge.source)
      && !selectedIds.has(edge.target)
      && (edge.metadata?.relation === 'template-url' || edge.metadata?.relation === 'template-binding')
    ))
    .sort((a, b) => (
      Number(a.metadata?.relation !== 'template-url') - Number(b.metadata?.relation !== 'template-url')
      || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
      || (a.column ?? Number.MAX_SAFE_INTEGER) - (b.column ?? Number.MAX_SAFE_INTEGER)
      || compareEdge(a, b)
    ));
  for (const edge of candidates.slice(0, 2)) {
    const endpoint = nodesById.get(edge.target);
    if (!endpoint || !isMarkdownSymbolNode(endpoint)) continue;
    while (selected.length >= limit) {
      const removableIndex = selected.findLastIndex(node => !protectedIds.has(node.id));
      if (removableIndex < 0) return selected;
      selectedIds.delete(selected[removableIndex].id);
      selected.splice(removableIndex, 1);
    }
    selected.push(endpoint);
    selectedIds.add(endpoint.id);
    protectedIds.add(endpoint.id);
  }
  retainQuerySemanticEndpoints(selected, selectedIds, protectedIds, edges, nodesById, rawQuery, limit);
  return selected;
}

function retainQuerySemanticEndpoints(
  selected,
  selectedIds,
  protectedIds,
  edges,
  nodesById,
  rawQuery,
  limit,
) {
  const queryTerms = queryTokens(rawQuery);
  const ownerNames = querySemanticOwnerNames(selected, queryTerms);
  if (ownerNames.length === 0) return;

  const selectedOwnerNodes = selected
    .filter(node => ownerNames.some(owner => (
      node.qualifiedName === owner || String(node.qualifiedName ?? '').startsWith(`${owner}::`)
    )));
  const ownerDisplayKeys = new Set(selectedOwnerNodes.map(displaySymbolKey));
  const ownerSourceIds = new Set([...nodesById.values()]
    .filter(node => ownerDisplayKeys.has(displaySymbolKey(node)))
    .map(node => node.id));
  const selectedOwnerRootNodes = selected
    .filter(node => ownerNames.includes(String(node.qualifiedName ?? node.name ?? '')))
  const ownerRootDisplayKeys = new Set(selectedOwnerRootNodes.map(displaySymbolKey));
  const ownerRootIds = new Set([...nodesById.values()]
    .filter(node => ownerRootDisplayKeys.has(displaySymbolKey(node)))
    .map(node => node.id));
  for (const id of ownerRootIds) protectedIds.add(id);
  for (const node of selected) {
    if (!ownerSourceIds.has(node.id)) continue;
    const nodeTerms = [node.name, readQualifiedNameLeaf(node.qualifiedName)]
      .map(value => String(value ?? '').toLowerCase());
    if (queryTerms.some(term => nodeTerms.includes(term))) {
      protectedIds.add(node.id);
    }
  }

  const selectedDisplayKeys = new Set(selected.map(displaySymbolKey));
  const candidateTargets = querySemanticEndpointCandidates(
    edges,
    ownerSourceIds,
    ownerRootIds,
    selectedIds,
    nodesById,
    queryTerms.length === 1 ? queryTerms[0] : null,
  );
  let addedEndpointCount = 0;
  for (const targetId of candidateTargets) {
    if (addedEndpointCount >= 6) break;
    const endpoint = nodesById.get(targetId);
    if (!endpoint || !isMarkdownSymbolNode(endpoint) || selectedDisplayKeys.has(displaySymbolKey(endpoint))) continue;
    while (selected.length >= limit) {
      const removableIndex = selected.findLastIndex(node => !protectedIds.has(node.id));
      if (removableIndex < 0) return;
      selectedDisplayKeys.delete(displaySymbolKey(selected[removableIndex]));
      selectedIds.delete(selected[removableIndex].id);
      selected.splice(removableIndex, 1);
    }
    selected.push(endpoint);
    selectedIds.add(endpoint.id);
    selectedDisplayKeys.add(displaySymbolKey(endpoint));
    protectedIds.add(endpoint.id);
    addedEndpointCount += 1;
  }
}

function querySemanticOwnerNames(selected, queryTerms) {
  const terms = new Set(queryTerms);
  const hasSingleTerm = queryTerms.length === 1;
  return unique(selected
    .filter(node => {
      const name = String(node.qualifiedName ?? node.name ?? '').toLowerCase();
      if (!terms.has(name)) return false;
      if (node.kind === 'type_alias' || node.kind === 'interface') return true;
      return hasSingleTerm && !['file', 'import', 'method', 'parameter', 'property'].includes(node.kind);
    })
    .map(node => String(node.qualifiedName ?? node.name ?? '')));
}

function querySemanticEndpointCandidates(edges, ownerSourceIds, ownerRootIds, selectedIds, nodesById, exactTerm) {
  const candidates = edges.flatMap(edge => {
    const relation = String(edge.metadata?.relation ?? '');
    const exportNameMatches = exactTerm && String(edge.metadata?.exportName ?? '').toLowerCase() === exactTerm;
    const sourceOwned = ownerSourceIds.has(edge.source);
    const targetOwned = ownerSourceIds.has(edge.target);
    if (!exportNameMatches && !sourceOwned && !targetOwned) return [];
    if (!querySemanticEndpointRelationApplies(relation, exportNameMatches)) return [];
    const endpointIds = exportNameMatches
      ? [edge.source, edge.target]
      : [sourceOwned ? edge.target : edge.source];
    const directRank = exportNameMatches || ownerRootIds.has(edge.source) || ownerRootIds.has(edge.target) ? 0 : 1;
    return endpointIds
      .filter(id => !selectedIds.has(id))
      .map(id => ({ directRank, edge, id, node: nodesById.get(id), relation }));
  });
  return uniqueBy(candidates
    .filter(candidate => candidate.node)
    .sort((a, b) => a.directRank - b.directRank
      || querySemanticEndpointRelationPriority(a.relation)
      - querySemanticEndpointRelationPriority(b.relation)
      || querySemanticEndpointNodePriority(a.node) - querySemanticEndpointNodePriority(b.node)
      || compareEdge(a.edge, b.edge)), candidate => candidate.id)
    .map(candidate => candidate.id);
}

function querySemanticEndpointRelationApplies(relation, exportNameMatches) {
  if (exportNameMatches) return relation === 're-export' || relation === 'export-equals';
  return [
    'call', 'class-member', 'enum-member', 'extends', 'implements', 'interface-member',
    'file-symbol', 'initializer-reference', 'new', 'parameter-type', 'return-type',
    'type-literal-member', 'type-reference',
  ].includes(relation);
}

function querySemanticEndpointRelationPriority(relation) {
  if (relation === 're-export' || relation === 'export-equals') return 0;
  if (relation === 'file-symbol') return 0;
  if (relation === 'new' || relation === 'extends' || relation === 'implements') return 1;
  if (relation.endsWith('-member')) return 2;
  return 3;
}

function querySemanticEndpointNodePriority(node) {
  const priorities = { interface: 0, property: 1, type_alias: 2, enum: 2, class: 3, method: 4, function: 4 };
  return priorities[node?.kind] ?? 5;
}

function closeGraphEdgesOverSelectedNodes(edges, selectedNodes, graphNodes) {
  const selectedById = new Map(selectedNodes.map(node => [node.id, node]));
  const selectedIdByDisplayKey = new Map(selectedNodes
    .map(node => [displaySymbolKey(node), node.id]));
  const graphNodesById = new Map(graphNodes.map(node => [node.id, node]));
  const resolveSelectedId = id => {
    if (selectedById.has(id)) return id;
    const node = graphNodesById.get(id);
    return node ? selectedIdByDisplayKey.get(displaySymbolKey(node)) : undefined;
  };
  return uniqueBy(edges.flatMap(edge => {
    const source = resolveSelectedId(edge.source);
    const target = resolveSelectedId(edge.target);
    if (!source || !target) return [];
    return [{
      ...edge,
      source,
      target,
      sourceName: selectedById.get(source)?.name ?? edge.sourceName,
      targetName: selectedById.get(target)?.name ?? edge.targetName,
    }];
  }), edge => joinSearchText([
    edge.source,
    edge.target,
    edge.kind,
    edge.line,
    edge.column,
    edge.metadata,
  ]));
}

function rankNodesForQuery(nodes, rawQuery = '') {
  const context = queryScoringContext(rawQuery);
  if (context.queryTerms.length === 0) return nodes;
  const scored = nodes.map((node, index) => ({
    node,
    index,
    pathScore: scorePathTermMatch(node?.filePath, context.queryTerms),
    lowInformationPenalty: lowInformationNodePenalty(node, rawQuery),
    ...scoreNodeRelevanceForQuery(node, context),
  }));
  if (!scored.some(entry => (
    entry.pathScore > 0
    || entry.explicitScore > 0
    || entry.coreScore > 0
    || entry.lowInformationPenalty > 0
  ))) return nodes;
  return scored
    .sort((a, b) => b.explicitScore - a.explicitScore
      || b.pathScore - a.pathScore
      || b.coreScore - a.coreScore
      || highValueRank(b.node) - highValueRank(a.node)
      || a.lowInformationPenalty - b.lowInformationPenalty
      || b.fullScore - a.fullScore
      || compareNodeSpecificity(a.node, b.node)
      || a.index - b.index)
    .map(entry => entry.node);
}

function rankGraphEdgesForQuery(edges, nodes, rawQuery = '') {
  const context = queryScoringContext(rawQuery);
  if (context.queryTerms.length === 0) return edges;
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const exactOwnerContext = exactQueryOwnerContext(nodes, context.queryTerms);
  const nodeRankById = new Map(rankNodesForQuery(nodes, rawQuery)
    .map((node, index) => [node.id, index]));
  return edges
    .map((edge, index) => {
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      const searchText = joinSearchText([
        edgeSearchText(edge),
        sourceNode ? nodeSearchText(sourceNode) : '',
        targetNode ? nodeSearchText(targetNode) : '',
      ]);
      const sourceRank = nodeRankById.get(edge.source) ?? Number.MAX_SAFE_INTEGER;
      const targetRank = nodeRankById.get(edge.target) ?? Number.MAX_SAFE_INTEGER;
      return {
        edge,
        index,
        exactRelationRank: context.queryTerms.some(term => edgeMatchesExactMetadataQuery(edge, term)) ? 1 : 0,
        exactOwnerPriority: exactQueryEdgeBudgetPriority(
          edge,
          sourceNode,
          targetNode,
          exactOwnerContext,
        ),
        semanticPriority: semanticGraphEdgeBudgetPriority(edge, rawQuery),
        explicitScore: scoreExplicitQueryTermText(
          searchText,
          context.focusedTerms,
          context.explicitTerms,
          5000,
          400,
        ),
        matchedTermCount: context.queryTerms.reduce(
          (count, term) => count + (searchText.includes(term) ? 1 : 0),
          0,
        ),
        bestEndpointRank: Math.min(sourceRank, targetRank),
        worstEndpointRank: Math.max(sourceRank, targetRank),
      };
    })
    .sort((a, b) => b.exactRelationRank - a.exactRelationRank
      || (a.exactRelationRank > 0 && b.exactRelationRank > 0 ? a.index - b.index : 0)
      || a.exactOwnerPriority - b.exactOwnerPriority
      || a.semanticPriority - b.semanticPriority
      || b.explicitScore - a.explicitScore
      || b.matchedTermCount - a.matchedTermCount
      || a.bestEndpointRank - b.bestEndpointRank
      || a.worstEndpointRank - b.worstEndpointRank
      || a.index - b.index)
    .map(entry => entry.edge);
}

function exactQueryOwnerContext(nodes, queryTerms) {
  if (queryTerms.length !== 1) return null;
  const [term] = queryTerms;
  const ownerNames = unique(nodes
    .filter(node => {
      if (['file', 'import', 'method', 'parameter', 'property'].includes(node.kind)) return false;
      return [node.name, node.qualifiedName]
        .some(value => String(value ?? '').toLowerCase() === term);
    })
    .map(node => String(node.qualifiedName ?? node.name ?? '')));
  if (ownerNames.length === 0) return null;
  const rootIds = new Set(nodes
    .filter(node => ownerNames.includes(String(node.qualifiedName ?? node.name ?? '')))
    .map(node => node.id));
  return {
    term,
    rootIds,
    ownerIds: new Set(nodes
      .filter(node => ownerNames.some(owner => (
        node.qualifiedName === owner || String(node.qualifiedName ?? '').startsWith(`${owner}::`)
      )))
      .map(node => node.id)),
  };
}

function exactQueryEdgeBudgetPriority(edge, sourceNode, targetNode, context) {
  if (!context) return 10;
  const relation = String(edge.metadata?.relation ?? '').toLowerCase();
  if (String(edge.metadata?.exportName ?? '').toLowerCase() === context.term) return 0;
  const sourceOwned = context.ownerIds.has(edge.source);
  const targetOwned = context.ownerIds.has(edge.target);
  if (!sourceOwned && !targetOwned) return 10;
  const directRank = context.rootIds.has(edge.source) || context.rootIds.has(edge.target) ? 0 : 1;
  if (relation.endsWith('-member') || relation === 'file-symbol') return directRank;
  if (relation === 'new' || relation === 'extends' || relation === 'implements' || relation === 'call') {
    return 1 + directRank;
  }
  if (relation === 'type-reference' || relation === 'parameter-type'
    || relation === 'return-type' || relation === 'initializer-reference') {
    if (context.rootIds.has(edge.source) && edge.source !== edge.target) return 0;
    const endpoint = sourceOwned ? targetNode : sourceNode;
    return 2 + directRank + querySemanticEndpointNodePriority(endpoint);
  }
  return 9;
}

function semanticGraphEdgeBudgetPriority(edge, rawQuery) {
  const relation = String(edge.metadata?.relation ?? '').toLowerCase();
  if (relation === 'test') return queryAllowsTestFiles(rawQuery) ? 2 : 5;
  if ([
    'android-kotlin-annotation',
    'hard-rule-keyword',
    'jsx-component',
    'local-declaration',
    'sync-rule-keyword',
    'template-binding',
    'template-url',
    'type-literal-member',
  ].includes(relation)) {
    return 0;
  }
  if (edge.metadata?.isTypeOnly || relation === 're-export' || relation === 'export-equals') return 1;
  return 2;
}

function orderRelatedFilesForQuery(filePaths, rawQuery = '') {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  if (queryTerms.length === 0) return filePaths;
  const scored = filePaths.map((filePath, index) => ({
    filePath,
    index,
    pathScore: scorePathTermMatch(filePath, queryTerms),
    lowInformationPenalty: lowInformationFilePenalty(filePath, rawQuery),
  }));
  if (!scored.some(entry => entry.pathScore > 0 || entry.lowInformationPenalty > 0)) return filePaths;
  return scored
    .sort((a, b) => b.pathScore - a.pathScore
      || a.lowInformationPenalty - b.lowInformationPenalty
      || String(a.filePath ?? '').localeCompare(String(b.filePath ?? ''))
      || a.index - b.index)
    .map(entry => entry.filePath);
}

function lowInformationNodePenalty(node, rawQuery = '') {
  return lowInformationFilePenalty(node?.filePath, rawQuery)
    + lowInformationNodeKindPenalty(node, rawQuery);
}

function lowInformationNodeKindPenalty(node, rawQuery = '') {
  const kind = String(node?.kind ?? '');
  if (kind === 'file') {
    const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
    if (queryTerms.some(isExplicitPathTerm) && scorePathTermMatch(node?.filePath, queryTerms) > 0) {
      return 0;
    }
    return 300;
  }
  if (kind === 'import' || kind === 'export' || kind === 'parameter') return 700;
  if (isExternalReferencePlaceholder(node)) return 1000;
  return 0;
}

function lowInformationFilePenalty(filePath, rawQuery = '') {
  const normalized = normalizeSearchPath(filePath);
  if (!normalized) return 0;
  const query = String(rawQuery ?? '').toLowerCase();

  if (!queryAllowsTestFiles(query) && isLowInformationTestFilePath(normalized)) return 6000;
  if (!/\bicons?\b/i.test(query) && /(?:^|\/)icons?\//.test(normalized)) return 5000;
  if (!/\bi18n\b/i.test(query) && /(?:^|\/)i18n\//.test(normalized)) return 5000;
  if (!/\b(?:generated|gen|proto|protobuf|pb)\b/i.test(query) && isGeneratedFilePath(normalized)) return 1000;
  return 0;
}

function queryAllowsTestFiles(query) {
  const normalizedQuery = String(query ?? '').toLowerCase();
  return queryMentionsTests(normalizedQuery)
    || queryTokens(normalizedQuery).some(isTestMappingQuery)
    || normalizeExactRelationQueries(normalizedQuery).some(isTestMappingQuery);
}

function isLowInformationTestFilePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return isTestFile(normalized)
    || /(?:^|\/)[^/]+[.-](?:test|spec)[.-][^/]+\.[cm]?[jt]sx?$/.test(normalized)
    || /(?:^|\/)[^/]+[-.]helpers?\.[cm]?[jt]sx?$/.test(normalized);
}

function isExplicitPathTerm(term) {
  const normalized = normalizeSearchPath(term);
  return /[/.\\]/.test(String(term ?? ''))
    && /\.(?:[cm]?[tj]sx?|kt|json|md|html|xml|css|scss|sql|cjs|mjs|mts|cts)$/i.test(normalized);
}

function normalizeSearchPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/(\.(?:[cm]?[tj]sx?|kt|json|md|html|xml|css|scss|sql|cjs|mjs|mts|cts))(?::\d+(?::\d+)?)$/i, '$1');
}

function scorePathSegmentCoverage(pathLike, querySegmentSet, fullCoverageScore) {
  const segments = searchPathSignalSegments(pathLike);
  if (segments.length < 2) return 0;
  const matched = segments.filter(segment => querySegmentSet.has(segment));
  if (matched.length === segments.length) return fullCoverageScore + (matched.length * 12);
  if (matched.length >= 2) return Math.floor((matched.length / segments.length) * (fullCoverageScore / 3)) + (matched.length * 4);
  return 0;
}

function searchPathSignalSegments(value) {
  const normalized = normalizeSearchPath(value);
  const fileName = normalized.split('/').at(-1) ?? normalized;
  const withoutExtension = fileName.replace(/\.(?:[cm]?[tj]sx?|kt|json|md|html|xml|css|scss|sql|cjs|mjs|mts|cts)$/i, '');
  return unique(withoutExtension
    .split(/[^a-z0-9$]+/i)
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2)
    .filter(segment => !['src', 'app', 'lib', 'test', 'spec'].includes(segment)));
}

function buildRelationshipGroups(edges) {
  const groups = {};
  const seenKeysByKind = new Map();
  for (const edge of edges) {
    const group = groups[edge.kind] ?? [];
    let seenKeys = seenKeysByKind.get(edge.kind);
    if (!seenKeys) {
      seenKeys = new Set();
      seenKeysByKind.set(edge.kind, seenKeys);
    }
    const displayEdge = {
      source: formatEdgeSource(edge),
      target: edge.targetName ?? edge.target,
      ...(edge.metadata ?? {}),
    };
    const key = JSON.stringify(displayEdge);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      group.push(displayEdge);
    }
    groups[edge.kind] = group;
  }

  return Object.fromEntries(
    Object.entries(groups).filter(([, groupedEdges]) => groupedEdges.length > 0),
  );
}

function capRelationshipGroups(groups, limit) {
  const capped = {};
  for (const [kind, edges] of Object.entries(groups ?? {})) {
    capped[kind] = Array.isArray(edges) ? edges.slice(0, limit) : [];
  }
  return capped;
}

function formatEdgeSource(edge) {
  if (edge.metadata?.relation === 'template-binding') {
    return `${edge.sourceName ?? edge.source} template`;
  }
  return edge.sourceName ?? edge.source;
}

function filterRelationshipGroupsForMarkdown(groups, rawQuery) {
  const query = String(rawQuery ?? '').toLowerCase();
  return Object.fromEntries(
    Object.entries(groups)
      .map(([kind, edges]) => {
        if (kind !== 'contains') return [kind, edges];
        return [kind, edges.filter(edge => String(edge.relation ?? '').toLowerCase() === query)];
      })
      .filter(([, edges]) => edges.length > 0),
  );
}

function buildBlastRadiusEntries(nodes, edges, dependencyNodes = nodes) {
  const meaningfulKinds = new Set([
    'function',
    'method',
    'class',
    'interface',
    'enum',
    'type_alias',
    'component',
    'constant',
    'variable',
    'property',
  ]);
  const dependencyEdgeKinds = new Set([
    'calls',
    'references',
    'extends',
    'implements',
    'overrides',
    'instantiates',
    'returns',
    'type_of',
    'imports',
    'decorates',
  ]);
  const nodesById = new Map(dependencyNodes.map(node => [node.id, node]));
  const roots = nodes
    .filter(node => meaningfulKinds.has(node.kind))
    .sort(compareNodeSourceOrder)
    .slice(0, 5);
  const entries = [];

  for (const root of roots) {
    const incoming = edges
      .filter(edge => edge.target === root.id && edge.source !== root.id)
      .filter(edge => dependencyEdgeKinds.has(edge.kind))
      .filter(edge => edge.metadata?.relation !== 'file-symbol')
      .map(edge => nodesById.get(edge.source))
      .filter(Boolean);
    const uniqueCallers = uniqueBy(incoming, node => node.id);
    const callerFiles = unique(uniqueCallers
      .map(node => node.filePath)
      .filter(filePath => filePath && !isTestFile(filePath)));
    const testFiles = unique([
      ...uniqueCallers.map(node => node.filePath).filter(isTestFile),
      ...edges
        .filter(edge => edge.source === root.id && edge.metadata?.relation === 'test')
        .map(edge => edge.targetName ?? edge.target)
        .filter(isTestFile),
    ]);

    if (uniqueCallers.length === 0 && testFiles.length === 0) continue;
    entries.push({
      name: root.name,
      filePath: root.filePath,
      line: root.startLine,
      callerCount: uniqueCallers.length,
      callerFiles,
      testFiles,
    });
  }

  return entries;
}

function buildNotShownEntries(nodes, shownSourceFiles) {
  return groupNodesByFile(nodes)
    .filter(([filePath]) => filePath !== '(unknown)' && !shownSourceFiles.has(filePath))
    .map(([filePath, groupedNodes]) => ({
      filePath,
      symbols: groupedNodes
        .filter(node => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
        .map(node => `${node.name}:${node.startLine ?? '?'}`)
        .slice(0, 12),
    }))
    .filter(entry => entry.symbols.length > 0)
    .slice(0, 10);
}

function isMarkdownSymbolNode(node) {
  return [
    'file',
    'component',
    'class',
    'function',
    'method',
    'property',
    'interface',
    'type_alias',
    'constant',
    'variable',
    'enum',
    'enum_member',
    'namespace',
    'parameter',
    'import',
    'export',
    'route',
  ].includes(node.kind);
}

function isSameDisplaySymbol(a, b) {
  return a.kind === b.kind
    && a.name === b.name
    && a.filePath === b.filePath
    && (a.startLine ?? null) === (b.startLine ?? null);
}

function displaySymbolKey(node) {
  return [
    node?.kind ?? '',
    node?.name ?? '',
    node?.filePath ?? '',
    node?.startLine ?? '',
    agentRuleRelationDiscriminator(node),
  ].join('\0');
}

function agentRuleRelationDiscriminator(node) {
  if (node?.filePath !== 'AGENTS.md') return '';
  const relation = node?.metadata?.relation;
  return relation === 'hard-rule' || relation === 'hard-rule-keyword' || relation === 'sync-rule' || relation === 'sync-rule-keyword'
    ? relation
    : '';
}

function compareNodeSpecificity(a, b) {
  return nodeRelationPriority(a) - nodeRelationPriority(b)
    || nodeKindPriority(a.kind) - nodeKindPriority(b.kind)
    || compareNode(a, b);
}

function nodeRelationPriority(node) {
  const relation = node?.metadata?.relation;
  if (relation === 'hard-rule' || relation === 'sync-rule') return 0;
  if (relation === 'hard-rule-keyword' || relation === 'sync-rule-keyword') return 5;
  if (relation === 'external-reference') return 9;
  return 3;
}

function nodeKindPriority(kind) {
  const priorities = {
    file: 0,
    component: 1,
    route: 2,
    class: 3,
    method: 4,
    property: 5,
    function: 6,
    interface: 7,
    type_alias: 8,
    enum: 9,
    enum_member: 10,
    parameter: 11,
    import: 12,
    export: 13,
    constant: 14,
    variable: 15,
    namespace: 16,
  };
  return priorities[kind] ?? 20;
}

function compareNode(a, b) {
  return String(a.filePath ?? '').localeCompare(String(b.filePath ?? ''))
    || String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
    || String(a.name ?? '').localeCompare(String(b.name ?? ''));
}

function compareEdge(a, b) {
  return String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
    || edgeRelationPriority(a) - edgeRelationPriority(b)
    || String(a.sourceName ?? a.source ?? '').localeCompare(String(b.sourceName ?? b.source ?? ''))
    || String(a.targetName ?? a.target ?? '').localeCompare(String(b.targetName ?? b.target ?? ''));
}

function edgeRelationPriority(edge) {
  const relation = edge?.metadata?.relation ?? edge?.relation;
  if (relation === 'hard-rule-keyword') return 0;
  if (relation === 'hard-rule-implementation') return 1;
  if (relation === 'hard-rule-test-evidence') return 2;
  return 5;
}

function formatSummary(nodes, relatedFiles) {
  return `Found ${nodes.length} relevant code symbols across ${relatedFiles.length} files.`;
}

function selectEntryPoints(nodes, matches, limit, rawQuery = '', edges = []) {
  const selected = [];
  const seen = new Set();
  const query = String(rawQuery ?? '').toLowerCase();
  const queryTerms = queryTokens(query);
  const strongEntryPointIds = new Set();
  const relationEntryPoints = preferredExactRelationEntryPoints(nodes, edges, query);
  const suppressedEntryPointIds = relationEntryPoints.length > 0
    ? suppressedExactRelationEntryPointIds(nodes, edges, query)
    : new Set();
  for (const node of relationEntryPoints) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    selected.push(node);
  }

  if (queryTerms.length === 1) {
    for (const match of matches) {
      const matchName = match.name ?? match.item?.className ?? match.item?.name;
      const matchFile = match.file ?? match.item?.file ?? match.item?.entry;
      for (const node of nodes) {
        if (
          (node.name === matchName || node.qualifiedName === matchName)
          && (!matchFile || node.filePath === matchFile)
          && isHighValueEntryPoint(node)
          && isStrongSingleTermNodeMatch(node, query, queryTerms[0])
        ) {
          strongEntryPointIds.add(node.id);
        }
      }
    }
  }
  const useStrongEntryPointsOnly = strongEntryPointIds.size > 0;

  for (const match of matches) {
    const matchName = match.name ?? match.item?.className ?? match.item?.name;
    const matchFile = match.file ?? match.item?.file ?? match.item?.entry;
    const candidates = nodes
      .filter(node => (
        (node.name === matchName || node.qualifiedName === matchName)
        && (!matchFile || node.filePath === matchFile)
        && isHighValueEntryPoint(node)
        && !suppressedEntryPointIds.has(node.id)
      ))
      .filter(node => !useStrongEntryPointsOnly || strongEntryPointIds.has(node.id))
      .sort(compareNodeSpecificity);

    for (const node of candidates) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      selected.push(node);
      break;
    }
  }

  if (selected.every(node => node.kind === 'file')) {
    const hasExplicitPathTerm = queryTerms.some(isExplicitPathTerm);
    if (hasExplicitPathTerm) {
      const cap = Math.max(1, Math.min(limit ?? 5, 8));
      return rankNodesForQuery(selected, rawQuery).slice(0, cap);
    }
    const specificNode = nodes.find(node => (
      node.kind !== 'file'
      && isHighValueEntryPoint(node)
      && !suppressedEntryPointIds.has(node.id)
    ));
    if (specificNode && !seen.has(specificNode.id)) {
      seen.add(specificNode.id);
      selected.unshift(specificNode);
    }
  }

  if (selected.length === 0 && nodes.length > 0) {
    selected.push(
      nodes.find(node => node.kind !== 'file' && isHighValueEntryPoint(node) && !suppressedEntryPointIds.has(node.id))
      ?? nodes.find(node => isHighValueEntryPoint(node) && !suppressedEntryPointIds.has(node.id))
      ?? nodes[0],
    );
  }

  const cap = Math.max(1, Math.min(limit ?? 5, 8));
  if (relationEntryPoints.length > 0) {
    return selected.slice(0, cap);
  }
  return rankNodesForQuery(selected, rawQuery).slice(0, cap);
}

function preferredExactRelationEntryPoints(nodes, edges, query) {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const angularSemanticApiEndpointIds = angularSemanticApiEntryPointIds(nodesById, edges, query);
  const exactRelationQuery = exactMetadataQueryFromEdges(edges, query) ?? query;
  const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, exactRelationQuery));
  if (exactEdges.length === 0) {
    return angularSemanticApiEndpointIds
      .map(id => nodesById.get(id))
      .filter(node => node && isHighValueEntryPoint(node));
  }
  const sourceOwnerEndpointIds = sourceOwnerExactRelationEntryPointIds(nodesById, exactEdges, exactRelationQuery);
  const ownerEndpointIds = ownerPreferredExactRelationEntryPointIds(nodesById, exactEdges, exactRelationQuery);
  const hardRuleEvidenceEndpointIds = hardRuleEvidenceTargetExactRelationEntryPointIds(
    nodesById,
    exactEdges,
    exactRelationQuery,
  );
  const syncBodyKeywordEndpointIds = syncBodyKeywordExactRelationEntryPointIds(
    nodesById,
    exactEdges,
    exactRelationQuery,
  );
  const syncConfigKeywordEndpointIds = syncConfigKeywordExactRelationEntryPointIds(
    nodesById,
    exactEdges,
    exactRelationQuery,
  );
  const explicitEdgeFunctionSourceEndpointIds = preferredExplicitEdgeFunctionSourceEndpointIds(
    nodesById,
    edges,
    exactEdges,
    exactRelationQuery,
    query,
  );
  return unique([
    ...angularSemanticApiEndpointIds,
    ...explicitEdgeFunctionSourceEndpointIds,
    ...sourceOwnerEndpointIds,
    ...ownerEndpointIds,
    ...hardRuleEvidenceEndpointIds,
    ...syncBodyKeywordEndpointIds,
    ...syncConfigKeywordEndpointIds,
    ...preferredExactRelationCodeBlockEndpointIds(nodesById, edges, exactEdges, exactRelationQuery, query),
  ])
    .map(id => nodesById.get(id))
    .filter(node => node && isHighValueEntryPoint(node));
}

function sourceOwnerExactRelationEntryPointIds(nodesById, exactEdges, query) {
  if (!sourceOwnerEntryPointRelationQueries().has(normalizeExactRelationQuery(query))) return [];
  return unique(exactEdges
    .map(edge => nodesById.get(edge.source))
    .filter(node => node && isHighValueEntryPoint(node))
    .map(node => node.id));
}

function angularSemanticApiEntryPointIds(nodesById, edges, query) {
  const requestedApis = new Set(queryTokens(String(query ?? '').toLowerCase())
    .filter(term => ANGULAR_SEMANTIC_API_QUERY_TERMS.has(term)));
  if (requestedApis.size === 0) return [];
  return unique(edges
    .filter(edge => requestedApis.has(normalizeAngularSemanticApi(edge?.metadata?.api)))
    .map(edge => nodesById.get(edge.source))
    .filter(node => node && isHighValueEntryPoint(node))
    .map(node => node.id));
}

function ownerPreferredExactRelationEntryPointIds(nodesById, exactEdges, query) {
  if (!ownerPreferredSyntheticVariableRelationQueries().has(normalizeExactRelationQuery(query))) return [];
  return unique(exactEdges
    .map(edge => {
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      const sourceIsOwner = sourceNode?.kind === 'method' || sourceNode?.kind === 'function';
      return sourceIsOwner
        && targetNode?.kind === 'variable'
        && sourceNode.filePath
        && sourceNode.filePath === targetNode.filePath
        ? sourceNode.id
        : null;
    })
    .filter(Boolean));
}

function hardRuleEvidenceTargetExactRelationEntryPointIds(nodesById, exactEdges, query) {
  if (!hardRuleEvidenceTargetEntryPointRelationQueries().has(normalizeExactRelationQuery(query))) return [];
  return unique(exactEdges
    .map(edge => nodesById.get(edge.target))
    .filter(node => node?.kind === 'method' || node?.kind === 'function')
    .map(node => node.id));
}

function syncBodyKeywordExactRelationEntryPointIds(nodesById, exactEdges, query) {
  if (normalizeExactRelationQuery(query) !== 'sync-body-keyword') return [];
  return unique(exactEdges
    .map(edge => nodesById.get(edge.target))
    .filter(node => node?.metadata?.relation === 'sync-rule-keyword')
    .sort(compareSyncBodyKeywordEndpointPriority)
    .map(node => node.id));
}

function syncConfigKeywordExactRelationEntryPointIds(nodesById, exactEdges, query) {
  if (normalizeExactRelationQuery(query) !== 'sync-config-keyword') return [];
  return unique(exactEdges
    .map(edge => nodesById.get(edge.target))
    .filter(node => node?.metadata?.relation === 'sync-rule-keyword')
    .sort(compareSyncConfigKeywordEndpointPriority)
    .map(node => node.id));
}

function compareSyncBodyKeywordEndpointPriority(a, b) {
  return syncBodyKeywordEndpointRank(a) - syncBodyKeywordEndpointRank(b)
    || (a?.startLine ?? 0) - (b?.startLine ?? 0)
    || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

function syncBodyKeywordEndpointRank(node) {
  return /^[A-Z0-9_]+_CONFIG\./.test(String(node?.name ?? '')) ? 1 : 0;
}

function compareSyncConfigKeywordEndpointPriority(a, b) {
  return (a?.startLine ?? 0) - (b?.startLine ?? 0)
    || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

function suppressedExactRelationEntryPointIds(nodes, edges, query) {
  const exactRelationQuery = exactMetadataQueryFromEdges(edges, query) ?? query;
  const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, exactRelationQuery));
  if (exactEdges.length === 0) return new Set();
  return suppressedExactRelationCodeBlockEndpointIds(
    new Map(nodes.map(node => [node.id, node])),
    exactEdges,
    exactRelationQuery,
  );
}

function isHighValueEntryPoint(node) {
  return HIGH_VALUE_NODE_KINDS.has(node?.kind) && !isExternalReferencePlaceholder(node);
}

function highValueRank(node) {
  return isHighValueEntryPoint(node) ? 1 : 0;
}

function isExternalReferencePlaceholder(node) {
  return node?.metadata?.relation === 'external-reference'
    || (node?.kind === 'variable' && !node.signature && Boolean(node?.metadata?.relation));
}

function formatNativeMarkdown(response, sourceBlocks = buildSourceBlocks(response.root, response.nodes, getExploreOutputBudget(response.coverage?.typescriptFiles ?? response.nodes.length), response.query)) {
  return formatNanoFlowAugmentedMarkdown(response, sourceBlocks);
}

function formatNanoFlowAugmentedMarkdown(response, sourceBlocks = buildSourceBlocks(response.root, response.nodes, getExploreOutputBudget(response.coverage?.typescriptFiles ?? response.nodes.length), response.query)) {
  const files = new Set(response.nodes.map(node => node.filePath).filter(Boolean));
  const fileCount = response.coverage?.typescriptFiles ?? files.size;
  const outputBudget = getExploreOutputBudget(fileCount);
  const lines = [
    `## Exploration: ${response.query}`,
    '',
    `Found ${response.nodes.length} symbols across ${files.size} files.`,
    '',
  ];

  if (response.blastRadius?.length) {
    lines.push('### Blast radius — what depends on these (update/verify before editing)', '');
    for (const entry of response.blastRadius) {
      const shownFiles = formatInlineFileList(entry.callerFiles, 4);
      const where = entry.callerFiles.length > 0 ? ` in ${shownFiles}` : '';
      const tests = entry.testFiles.length > 0
        ? `; tests: ${formatInlineFileList(entry.testFiles, 4)}`
        : '; ⚠️ no covering tests found';
      lines.push(`- \`${entry.name}\` (${entry.filePath}:${entry.line ?? '?'}) — ${entry.callerCount} caller${entry.callerCount === 1 ? '' : 's'}${where}${tests}`);
    }
    lines.push('');
  }

  const relationshipEntries = Object.entries(filterRelationshipGroupsForMarkdown(response.relationshipGroups, response.query));
  const showRelationships = outputBudget.includeRelationships || isExactRelationshipQuery(response.relationshipGroups, response.query);
  if (showRelationships && relationshipEntries.length > 0) {
    lines.push('### Relationships', '');
    for (const [kind, edges] of relationshipEntries) {
      lines.push(`**${kind}:**`);
      const cap = outputBudget.maxEdgesPerRelationshipKind;
      for (const edge of edges.slice(0, cap)) {
        const suffix = formatEdgeMetadata(edge);
        lines.push(`- ${edge.source} → ${edge.target}${suffix}`);
      }
      if (edges.length > cap) {
        lines.push(`- ... and ${edges.length - cap} more`);
      }
      lines.push('');
    }
  }

  if (sourceBlocks.length > 0) {
    lines.push('### Source Code');
    lines.push('');
    lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
    lines.push('');
    for (const block of sourceBlocks) {
      const headerSuffix = block.symbols ? ` — ${block.symbols}` : '';
      lines.push(`#### ${block.filePath}${headerSuffix}`);
      lines.push('');
      lines.push(`\`\`\`${block.language}`);
      lines.push(block.source);
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('### Related Symbols', '');
  for (const [filePath, nodes] of groupMarkdownRelatedNodesByFile(response.nodes)) {
    const symbols = nodes
      .map(node => `${node.name}${node.startLine ? `:${node.startLine}` : ''}`)
      .join(', ');
    lines.push(`- ${filePath}: ${symbols}`);
  }

  if (outputBudget.includeAdditionalFiles && response.notShown?.length) {
    lines.push('### Not shown above — explore these names for their source');
    lines.push('');
    for (const entry of response.notShown) {
      lines.push(`- ${entry.filePath}: ${entry.symbols.join(', ')}`);
    }
    lines.push('');
  }

  if (outputBudget.includeCompletenessSignal && sourceBlocks.length > 0) {
    lines.push('---');
    lines.push(`> **Complete source for ${sourceBlocks.length} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`);
    lines.push('');
  }

  if (outputBudget.includeBudgetNote) {
    lines.push(`> **Explore budget: ${getExploreBudget(fileCount)} calls for this project (${fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${getExploreBudget(fileCount)}.`);
    lines.push('');
  }

  lines.push('');
  lines.push('### NanoFlow Coverage', '');
  for (const [name, count] of Object.entries(response.coverage)) {
    lines.push(`- ${name}: ${count}`);
  }

  return truncateMarkdownOutput(lines.join('\n'), outputBudget.maxOutputChars);
}

function formatStrictNativeMarkdown(context) {
  const lines = [];
  lines.push('## Code Context\n');
  lines.push(`**Query:** ${context.query}\n`);

  const orderedEntries = orderNativeProjectionItems(context.entryPoints, context.query);
  lines.push('### Entry Points\n');
  if (orderedEntries.length === 0) {
    lines.push('- No entry points found.');
  } else {
    for (const node of orderedEntries) {
      const location = formatStrictNativeLocation(node.filePath, node.startLine);
      lines.push(`- **${node.name}** (${node.kind}) - ${location}`);
      if (node.signature) {
        lines.push(`  \`${node.signature}\``);
      }
    }
  }
  lines.push('');

  const relationshipGroups = buildStrictNativeMarkdownRelationshipGroups(context.nodes, context.edges);
  lines.push('### Relationships\n');
  if (relationshipGroups.length === 0) {
    lines.push('- No relationships found.');
    lines.push('');
  } else {
    for (const [kind, edges] of relationshipGroups) {
      lines.push(`**${kind}:**`);
      for (const edge of edges) {
        lines.push(`- ${edge.source} -> ${edge.target}${formatStrictNativeEdgeLocation(edge)}`);
      }
      lines.push('');
    }
  }

  const entryIds = new Set(context.entryPoints.map(node => node.id));
  const allOtherSymbols = orderNativeProjectionItems(context.nodes
    .filter(node => !entryIds.has(node.id))
    .filter(node => node.kind !== 'file')
    .filter(node => !isGeneratedFilePath(node.filePath))
    .filter(dedupeNodeByDisplay()), context.query);
  const otherSymbols = allOtherSymbols.slice(0, 10);
  const omittedRelatedSymbolCount = Math.max(0, allOtherSymbols.length - otherSymbols.length);

  lines.push('### Related Symbols\n');
  const byFile = new Map();
  for (const node of otherSymbols) {
    const existing = byFile.get(node.filePath) ?? [];
    existing.push(node);
    byFile.set(node.filePath, existing);
  }

  if (otherSymbols.length === 0) {
    lines.push('- No related symbols found.');
  } else {
    for (const [file, nodes] of byFile) {
      const nodeList = [...nodes]
        .sort(compareStrictNativeRelatedNodeOrder)
        .map(formatStrictNativeRelatedSymbol)
        .join(', ');
      lines.push(`- ${formatStrictNativeFilePath(file)}: ${nodeList}`);
    }
    if (omittedRelatedSymbolCount > 0) {
      lines.push(`- +${omittedRelatedSymbolCount} more related symbols omitted by native Markdown budget.`);
    }
  }
  lines.push('');

  const orderedBlocks = orderNativeProjectionItems(context.codeBlocks, context.query, {
    preserveExactRelationEvidence: true,
  });
  lines.push('### Code\n');
  if (orderedBlocks.length === 0) {
    lines.push('- No code blocks found.');
  } else {
    for (const block of orderedBlocks) {
      const nodeName = block.nodeName ?? 'Unknown';
      lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})\n`);
      lines.push(`\`\`\`${block.language}`);
      lines.push(block.content);
      lines.push('```\n');
    }
    if (strictNativeCodeBlockBudgetReached(context, orderedBlocks)) {
      lines.push('- Code block budget reached; additional matching nodes may have omitted source.');
    }
  }

  return lines.join('\n');
}

function strictNativeCodeBlockBudgetReached(context, orderedBlocks) {
  return orderedBlocks.length >= NATIVE_CONTEXT_CODE_BLOCK_LIMIT
    && context.nodes.length > orderedBlocks.length;
}

function buildStrictNativeMarkdownRelationshipGroups(nodes, edges) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const selectedIds = new Set(nodeById.keys());
  const seen = new Set();
  const grouped = new Map();
  for (const edge of edges) {
    if (!selectedIds.has(edge.source) || !selectedIds.has(edge.target)) {
      continue;
    }
    const nativeEdge = {
      kind: String(edge.kind ?? 'related'),
      source: strictNativeEdgeEndpointName(nodeById.get(edge.source), edge.source),
      target: strictNativeEdgeEndpointName(nodeById.get(edge.target), edge.target),
      line: nativeJsonEdgeLine(edge),
      column: nativeJsonEdgeColumn(edge),
    };
    const key = JSON.stringify(nativeEdge);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const group = grouped.get(nativeEdge.kind) ?? [];
    group.push(nativeEdge);
    grouped.set(nativeEdge.kind, group);
  }

  return [...grouped.entries()]
    .sort(([leftKind], [rightKind]) => leftKind.localeCompare(rightKind))
    .map(([kind, group]) => [
      kind,
      group.sort(compareStrictNativeMarkdownEdges).slice(0, 20),
    ]);
}

function strictNativeEdgeEndpointName(node, fallback) {
  return String(node?.qualifiedName ?? node?.name ?? fallback ?? '(unknown)');
}

function compareStrictNativeMarkdownEdges(a, b) {
  return a.source.localeCompare(b.source)
    || a.target.localeCompare(b.target)
    || compareNullableSourceLine(a.line, b.line)
    || compareNullableSourceLine(a.column, b.column);
}

function formatStrictNativeEdgeLocation(edge) {
  const parts = [];
  if (displayLineNumber(edge.line)) {
    parts.push(`line ${edge.line}`);
  }
  if (displayLineNumber(edge.column)) {
    parts.push(`column ${edge.column}`);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function orderNativeProjectionItems(items, rawQuery = '', options = {}) {
  const context = queryScoringContext(rawQuery);
  if (options.preserveExactRelationEvidence && isPureExactRelationProjectionQuery(context)) {
    return items;
  }
  const scored = items.map((item, index) => ({
    item,
    index,
    ...scoreNativeProjectionItemForQuery(item, context),
  }));
  const hasRelevanceScore = !isPureExactRelationProjectionQuery(context)
    && scored.some(entry => (
    entry.explicitScore > 0
    || entry.pathScore > 0
    || entry.coreScore > 0
    || entry.fullScore > 0
  ));
  return scored
    .sort((a, b) => (
      (hasRelevanceScore ? compareNativeProjectionRelevance(a, b) : 0)
      || a.lowInformationPenalty - b.lowInformationPenalty
      || compareGeneratedFileOrder(a.item, b.item)
      || a.index - b.index
    ))
    .map(entry => entry.item);
}

function isPureExactRelationProjectionQuery(context) {
  return context.queryTerms.length === 1
    && context.explicitTerms.length === 0
    && isMixedExactMetadataQueryTerm(context.queryTerms[0]);
}

function scoreNativeProjectionItemForQuery(item, context) {
  const node = nativeProjectionItemNode(item);
  return {
    node,
    pathScore: scorePathTermMatch(node?.filePath, context.queryTerms),
    lowInformationPenalty: lowInformationNodePenalty(node, context.query),
    ...scoreNodeRelevanceForQuery(node, context),
  };
}

function compareNativeProjectionRelevance(a, b) {
  return b.explicitScore - a.explicitScore
    || b.pathScore - a.pathScore
    || b.coreScore - a.coreScore
    || highValueRank(b.node) - highValueRank(a.node)
    || a.lowInformationPenalty - b.lowInformationPenalty
    || b.fullScore - a.fullScore;
}

function nativeProjectionItemNode(item) {
  if (
    item?.name !== undefined
    || item?.qualifiedName !== undefined
    || item?.kind !== undefined
  ) {
    return item;
  }
  return {
    id: item?.id,
    kind: item?.nodeKind,
    name: item?.nodeName,
    qualifiedName: item?.nodeName,
    filePath: item?.filePath,
    language: item?.language,
    startLine: item?.startLine,
    endLine: item?.endLine,
  };
}

function formatStrictNativeRelatedSymbol(node) {
  const line = displayLineNumber(node.startLine);
  return line ? `${node.name}:${line}` : String(node.name);
}

function compareStrictNativeRelatedNodeOrder(a, b) {
  return compareNullableSourceLine(a?.startLine, b?.startLine)
    || compareNullableSourceLine(a?.endLine, b?.endLine)
    || String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
    || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function compareNullableSourceLine(a, b) {
  const aLine = displayLineNumber(a) ?? Number.MAX_SAFE_INTEGER;
  const bLine = displayLineNumber(b) ?? Number.MAX_SAFE_INTEGER;
  return aLine - bLine;
}

function formatStrictNativeLocation(filePath, lineNumber) {
  const line = displayLineNumber(lineNumber);
  const file = formatStrictNativeFilePath(filePath);
  return line ? `${file}:${line}` : file;
}

function formatStrictNativeFilePath(filePath) {
  return String(filePath ?? '').trim() || '(unknown)';
}

function displayLineNumber(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function buildNativeCodeBlocks(projectRoot, nodes, entryPoints, rawQuery = '', edges = []) {
  const query = String(rawQuery ?? '').toLowerCase();
  const queryTerms = queryTokens(query);
  const exactRelationQueries = exactMetadataQueriesFromEdges(edges, query);
  const activeExactRelationQueries = exactRelationQueries.length > 0 ? exactRelationQueries : [query];
  const exactLineCodeBlockQueries = edgeLineCodeBlockRelationQueries();
  const provenanceEdgeLineBlocks = buildProvenanceEdgeLineCodeBlocks(projectRoot, nodes, edges, activeExactRelationQueries);
  const includeFileEndpoints = activeExactRelationQueries.some(relationQuery => (
    relationCodeBlockFileEndpointQueries().has(relationQuery)
    || (isTestMappingQuery(relationQuery) && !exactLineCodeBlockQueries.has(relationQuery))
  ));
  const includeEntryPointFileBlocks = includeEntryPointFileCodeBlocksForNativeQuery(
    activeExactRelationQueries,
    exactLineCodeBlockQueries,
  );
  const suppressedCodeBlockNodeIds = suppressedNativeCodeBlockNodeIds(nodes, edges, activeExactRelationQueries);
  const broadCodeBlockSuppressionFilePaths = focusedExplicitPathCodeBlockFilePaths(nodes, queryTerms);
  const entryPointOnly = queryTerms.length === 1
    && entryPoints.some(node => isStrongSingleTermNodeMatch(node, query, queryTerms[0]));
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const leadingExplicitEdgeFunctionSourceNodes = unique(activeExactRelationQueries
    .flatMap(relationQuery => preferredExplicitEdgeFunctionSourceEndpointIds(
      nodesById,
      edges,
      edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery)),
      relationQuery,
      rawQuery,
    )))
      .map(id => nodesById.get(id))
      .filter(Boolean)
      .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
  const exactEndpointNodes = exactRelationEndpointCodeBlockNodes(nodes, edges, activeExactRelationQueries, {
    includeFiles: includeFileEndpoints,
    rawQuery,
  });
  const exactEndpointOriginalIds = new Set(exactEndpointNodes.map(node => node.id));
  const resolvedExactEndpointNodes = exactEndpointNodes.map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
  const exactRelationEdgeBlocks = buildExactRelationEdgeCodeBlocks(projectRoot, nodes, edges, activeExactRelationQueries);
  const exactRelationCodeBlockFilePaths = new Set(exactRelationEdgeBlocks.map(block => block.filePath).filter(Boolean));
  const explicitPathSourceNodes = explicitPathNativeCodeBlockNodes(
    nodes,
    entryPoints,
    queryTerms,
    exactRelationCodeBlockFilePaths,
    rawQuery,
  ).map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
  const context7PrimarySourceNodes = context7RetrievalPrimaryCodeBlockNodes(nodes, entryPoints, edges, queryTerms)
    .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
  const priorityNodes = uniqueBy([
    ...resolvedExactEndpointNodes,
    ...context7PrimarySourceNodes,
    ...entryPoints
      .filter(node => (
        (includeEntryPointFileBlocks || node.kind !== 'file')
        && !suppressedCodeBlockNodeIds.has(node.id)
        && !shouldSuppressBroadNativeCodeBlock(node, broadCodeBlockSuppressionFilePaths, queryTerms)
        && !exactEndpointOriginalIds.has(node.id)
      ))
      .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes)),
    ...(includeFileEndpoints
      ? nodes.filter(node => node.kind === 'file' && !suppressedCodeBlockNodeIds.has(node.id))
      : []),
    ...(entryPointOnly ? [] : nodes.filter(node => (
      (node.kind === 'function' || node.kind === 'method')
      && !exactEndpointOriginalIds.has(node.id)
    ))),
    ...(entryPointOnly ? [] : nodes
      .filter(node => (
        (node.kind === 'class' || node.kind === 'component')
        && !shouldSuppressBroadNativeCodeBlock(node, broadCodeBlockSuppressionFilePaths, queryTerms)
        && !exactEndpointOriginalIds.has(node.id)
      ))
      .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes))),
  ], node => node.id);
  const blocks = [];
  for (const node of leadingExplicitEdgeFunctionSourceNodes) {
    pushNativeCodeBlockWithinNativeBudget(blocks, readNodeCodeBlock(projectRoot, node));
  }
  for (const block of provenanceEdgeLineBlocks) {
    pushNativeCodeBlockWithinNativeBudget(blocks, block);
  }
  for (const node of explicitPathSourceNodes) {
    pushNativeCodeBlockWithinNativeBudget(blocks, readNodeCodeBlock(projectRoot, node));
  }
  for (const block of exactRelationEdgeBlocks) {
    pushNativeCodeBlockWithinNativeBudget(blocks, block);
  }
  if (edgeLineCodeBlocksAreAuthoritative(activeExactRelationQueries) && blocks.length > 0) {
    return blocks;
  }

  for (const node of priorityNodes) {
    if (blocks.length >= NATIVE_CONTEXT_CODE_BLOCK_LIMIT) break;
    const block = readNodeCodeBlock(projectRoot, node);
    pushNativeCodeBlock(blocks, block);
  }

  return blocks;
}

function pushNativeCodeBlockWithinNativeBudget(blocks, block, options = {}) {
  if (blocks.length >= NATIVE_CONTEXT_CODE_BLOCK_LIMIT) return;
  pushNativeCodeBlock(blocks, block, options);
}

function context7RetrievalPrimaryCodeBlockNodes(nodes, entryPoints, edges, queryTerms) {
  if (!context7RetrievalSourceQueryApplies(queryTerms)) return [];

  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const entryPointIds = new Set(entryPoints.map(node => node.id));
  const selectedRouteIds = selectedContext7RetrievalRouteIds(nodes, queryTerms, entryPointIds);

  if (selectedRouteIds.size === 0) return [];

  return uniqueBy(edges
    .filter(edge => (
      edge.metadata?.relation === 'context7-retrieval-primary'
      && selectedRouteIds.has(edge.source)
    ))
    .map(edge => nodesById.get(edge.target))
    .filter(Boolean), node => node.id);
}

function prioritizeContext7RetrievalNodes(nodes, edges, rawQuery) {
  const queryTerms = queryTokens(rawQuery);
  if (!context7RetrievalSourceQueryApplies(queryTerms)) return nodes;
  const selectedRouteIds = selectedContext7RetrievalRouteIds(nodes, queryTerms);
  if (selectedRouteIds.size === 0) return nodes;
  const primaryDocIds = new Set(edges
    .filter(edge => (
      edge.metadata?.relation === 'context7-retrieval-primary'
      && selectedRouteIds.has(edge.source)
    ))
    .map(edge => edge.target));
  if (primaryDocIds.size === 0) return nodes;
  return [
    ...nodes.filter(node => primaryDocIds.has(node.id)),
    ...nodes.filter(node => selectedRouteIds.has(node.id)),
    ...nodes.filter(node => !primaryDocIds.has(node.id) && !selectedRouteIds.has(node.id)),
  ];
}

function context7RetrievalSourceQueryApplies(queryTerms) {
  return queryTerms.some(term => (
    term === 'context7'
    || term === 'retrieval'
    || term === 'sync'
    || term === 'offline'
    || term === 'lww'
  ));
}

function selectedContext7RetrievalRouteIds(nodes, queryTerms, seedIds = new Set()) {
  return new Set(nodes
    .filter(node => (
      node?.metadata?.relation === 'context7-retrieval-route'
      && (
        seedIds.has(node.id)
        || queryTerms.some(term => nodeSearchText(node).includes(term))
      )
    ))
    .map(node => node.id));
}

function exactMetadataQueryFromEdges(edges, query) {
  return exactMetadataQueriesFromEdges(edges, query)[0] ?? null;
}

function exactMetadataQueriesFromEdges(edges, query) {
  const normalizedQuery = String(query ?? '').toLowerCase();
  if (edges.some(edge => edgeMatchesExactMetadataQuery(edge, normalizedQuery))) {
    return [normalizedQuery];
  }
  return exactMetadataQueriesFromTerms(edges, queryTokens(normalizedQuery));
}

function focusedExplicitPathCodeBlockFilePaths(nodes, queryTerms) {
  if (!queryTerms.some(isExplicitPathTerm)) return new Set();
  return new Set(nodes
    .filter(node => node.kind !== 'file' && hasExactNonPathQueryTermMatch(node, queryTerms))
    .map(node => node.filePath)
    .filter(Boolean));
}

function explicitPathNativeCodeBlockNodes(nodes, entryPoints, queryTerms, alreadyCoveredFilePaths = new Set(), rawQuery = '') {
  const explicitPathTerms = queryTerms.filter(isExplicitPathTerm);
  if (explicitPathTerms.length === 0) return [];

  const entryPointIds = new Set(entryPoints.map(node => node.id));
  const bestByFilePath = new Map();
  const candidates = uniqueBy([
    ...entryPoints,
    ...nodes,
  ], node => node.id).filter(node => (
    node?.filePath
    && !alreadyCoveredFilePaths.has(node.filePath)
    && scorePathTermMatch(node.filePath, explicitPathTerms) > 0
  ));

  for (const [index, node] of candidates.entries()) {
    const filePath = node.filePath;
    const candidate = {
      node,
      index,
      pathScore: scorePathTermMatch(filePath, explicitPathTerms),
      entryPoint: entryPointIds.has(node.id),
      fileNode: node.kind === 'file',
      lowInformationPenalty: lowInformationNodePenalty(node, rawQuery),
      highValueRank: highValueRank(node),
      specificity: compareNodeSpecificity(node, { kind: 'file', filePath }),
    };
    const existing = bestByFilePath.get(filePath);
    if (!existing || compareExplicitPathCodeBlockCandidate(candidate, existing) < 0) {
      bestByFilePath.set(filePath, candidate);
    }
  }

  return [...bestByFilePath.values()]
    .sort(compareExplicitPathCodeBlockCandidate)
    .map(candidate => candidate.node);
}

function compareExplicitPathCodeBlockCandidate(a, b) {
  return b.pathScore - a.pathScore
    || Number(b.entryPoint) - Number(a.entryPoint)
    || Number(a.fileNode) - Number(b.fileNode)
    || a.lowInformationPenalty - b.lowInformationPenalty
    || b.highValueRank - a.highValueRank
    || b.specificity - a.specificity
    || a.index - b.index;
}

function shouldSuppressBroadNativeCodeBlock(node, focusedFilePaths, queryTerms) {
  if (!focusedFilePaths.has(node?.filePath)) return false;
  if (node.kind === 'file') return true;
  return (node.kind === 'class' || node.kind === 'component')
    && !hasExactNonPathQueryTermMatch(node, queryTerms);
}

function hasExactNonPathQueryTermMatch(node, queryTerms) {
  const name = String(node?.name ?? '').toLowerCase();
  const qualifiedName = String(node?.qualifiedName ?? '').toLowerCase();
  const qualifiedNameLeaf = readQualifiedNameLeaf(qualifiedName);
  return queryTerms
    .filter(term => !isExplicitPathTerm(term))
    .some(term => term === name || term === qualifiedName || term === qualifiedNameLeaf);
}

function suppressedNativeCodeBlockNodeIds(nodes, edges, query) {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const suppressed = new Set();
  for (const relationQuery of normalizeExactRelationQueries(query)) {
    const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery));
    if (exactEdges.length === 0) continue;
    for (const id of suppressedExactRelationCodeBlockEndpointIds(nodesById, exactEdges, relationQuery)) {
      suppressed.add(id);
    }
  }
  return suppressed;
}

function buildExactRelationEdgeCodeBlocks(projectRoot, nodes, edges, query) {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const buckets = normalizeExactRelationQueries(query).map(relationQuery => {
    if (!edgeLineCodeBlockRelationQueries().has(relationQuery)) return [];
    const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery));
    const blocks = [];
    for (const edge of exactEdges.sort((a, b) => compareExactRelationEdgeCodeBlockOrder(nodesById, a, b, relationQuery))) {
      pushNativeCodeBlock(
        blocks,
        readEdgeLineCodeBlock(projectRoot, edgeLineCodeBlockNode(nodesById, edge, relationQuery), edge),
        { coalesceContainedRanges: true },
      );
    }
    return blocks;
  });
  return interleaveUniqueBuckets(buckets, nativeCodeBlockSourceRangeKey).slice(0, NATIVE_CONTEXT_CODE_BLOCK_LIMIT);
}

function compareExactRelationEdgeCodeBlockOrder(nodesById, a, b, query) {
  if (normalizeExactRelationQuery(query) === 'host-listener') {
    const hostPriority = hostListenerCodeBlockPriority(a) - hostListenerCodeBlockPriority(b);
    if (hostPriority !== 0) return hostPriority;
  }
  if (isTestMappingQuery(query) || queryMentionsTests(query)) return 0;
  return compareNativeCodeBlockNodeOrder(
    edgeLineCodeBlockNode(nodesById, a, query),
    edgeLineCodeBlockNode(nodesById, b, query),
    query,
  );
}

function hostListenerCodeBlockPriority(edge) {
  return edge?.metadata?.api === 'host' ? 0 : 1;
}

function buildProvenanceEdgeLineCodeBlocks(projectRoot, nodes, edges, query) {
  const buckets = normalizeExactRelationQueries(query).map(relationQuery => (
    buildProvenanceEdgeLineCodeBlocksForQuery(projectRoot, nodes, edges, relationQuery)
  ));
  return interleaveUniqueBuckets(buckets, nativeCodeBlockSourceRangeKey).slice(0, NATIVE_CONTEXT_CODE_BLOCK_LIMIT);
}

function buildProvenanceEdgeLineCodeBlocksForQuery(projectRoot, nodes, edges, query) {
  const provenanceRelation = provenanceEdgeLineRelationByQuery()[normalizeExactRelationQuery(query)];
  if (!provenanceRelation) return [];
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const exactTargetIds = new Set(edges
    .filter(edge => edgeMatchesExactMetadataQuery(edge, query))
    .map(edge => edge.target));
  if (exactTargetIds.size === 0) return [];
  const provenanceEdges = edges.filter(edge => (
    exactTargetIds.has(edge.target)
    && edge.metadata?.relation === provenanceRelation
  ));
  return uniqueBy(provenanceEdges
    .sort((a, b) => compareProvenanceEdgeLineCodeBlockOrder(nodesById, a, b, query))
    .map(edge => readEdgeLineCodeBlock(projectRoot, nodesById.get(edge.source), edge))
    .filter(isUsableNativeCodeBlock), nativeCodeBlockSourceRangeKey)
    .slice(0, NATIVE_CONTEXT_CODE_BLOCK_LIMIT);
}

function compareProvenanceEdgeLineCodeBlockOrder(nodesById, a, b, query) {
  if (isTestMappingQuery(query) || queryMentionsTests(query)) return 0;
  return compareNativeCodeBlockNodeOrder(nodesById.get(a.source), nodesById.get(b.source), query);
}

function provenanceEdgeLineRelationByQuery() {
  return {
    'sync-required-field': 'supabase-select-field',
    'sync-required-predicate': 'supabase-incremental-predicate',
  };
}

function edgeLineCodeBlockRelationQueries() {
  return relationPolicySet([
    'filename-reference',
    'path-reference',
    'route-reference',
    'invoke-reference',
    'template-binding',
    'template-component',
    'template-directive',
    'template-pipe',
    'standalone-import',
    'provider',
    'dependency',
    'angular-app-provider',
    'host-directive',
    'host-attribute',
    'host-binding',
    'host-listener',
    'edge-function-header',
    'context7-source-map-source',
    'hard-rule-keyword',
    'hard-rule-implementation',
    'hard-rule-test-evidence',
    'migration-constraint-validation',
  ]);
}

function edgeLineCodeBlocksAreAuthoritative(query) {
  const authoritativeQueries = relationPolicySet([
    'standalone-import',
    'provider',
    'dependency',
    'angular-app-provider',
    'host-directive',
    'host-attribute',
    'host-binding',
    'host-listener',
    'edge-function-header',
  ]);
  const relationQueries = normalizeExactRelationQueries(query);
  return relationQueries.length > 0 && relationQueries.every(relationQuery => authoritativeQueries.has(relationQuery));
}

function relationCodeBlockFileEndpointQueries() {
  return relationPolicySet([
    'android-widget-provider',
    'context7-retrieval-primary',
    'style-url',
    'template-url',
  ]);
}

function includeEntryPointFileCodeBlocksForNativeQuery(query, exactLineCodeBlockQueries) {
  return normalizeExactRelationQueries(query).every(relationQuery => {
    if (exactLineCodeBlockQueries.has(relationQuery)) return false;
    if (sourceFirstFileEntrypointSuppressionRelationQueries().has(relationQuery)) return false;
    return true;
  });
}

function sourceFirstFileEntrypointSuppressionRelationQueries() {
  return relationPolicySet([
    'edge-function-source',
  ]);
}

function sourceOwnerEntryPointRelationQueries() {
  return relationPolicySet([
    'edge-function-route',
    'edge-function-method',
    'edge-function-header',
    'edge-function-invoke',
  ]);
}

function edgeLineCodeBlockNode(nodesById, edge, query) {
  if (normalizeExactRelationQuery(query) === 'edge-function-header') {
    return edgeFunctionHeaderCodeBlockNode(nodesById, edge);
  }
  if (
    isTestMappingQuery(query)
    || hardRuleEvidenceTargetEntryPointRelationQueries().has(normalizeExactRelationQuery(query))
  ) {
    return nodesById.get(edge.target);
  }
  return nodesById.get(edge.source);
}

function edgeFunctionHeaderCodeBlockNode(nodesById, edge) {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  if (!sourceNode) return targetNode;
  const evidenceFilePath = edge?.metadata?.sourceFile ?? targetNode?.filePath;
  if (!evidenceFilePath || evidenceFilePath === sourceNode.filePath) return sourceNode;
  return {
    ...sourceNode,
    filePath: evidenceFilePath,
    language: targetNode?.language ?? sourceNode.language,
    startLine: targetNode?.startLine ?? edge?.line ?? sourceNode.startLine,
    endLine: targetNode?.endLine ?? targetNode?.startLine ?? edge?.line ?? sourceNode.endLine,
  };
}

function exactRelationEndpointCodeBlockNodes(nodes, edges, query, options = {}) {
  const relationQueries = normalizeExactRelationQueries(query);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const suppressedEndpointIds = new Set();
  const preferredEndpointBuckets = [];
  const primaryEndpointBuckets = [];
  const secondaryEndpointBuckets = [];

  for (const relationQuery of relationQueries) {
    const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery));
    if (exactEdges.length === 0) continue;
    const sourceFirst = codeBlockSourceFirstRelationQueries().has(normalizeExactRelationQuery(relationQuery));
    const orderedExactEdges = prioritizeExactRelationCodeBlockEdges(
      nodesById,
      exactEdges,
      relationQuery,
      sourceFirst,
      options.rawQuery,
    );
    for (const id of suppressedExactRelationCodeBlockEndpointIds(nodesById, exactEdges, relationQuery)) {
      suppressedEndpointIds.add(id);
    }
    preferredEndpointBuckets.push(preferredExactRelationCodeBlockEndpointIds(nodesById, edges, exactEdges, relationQuery));
    primaryEndpointBuckets.push(orderedExactEdges.map(edge => sourceFirst ? edge.source : edge.target));
    secondaryEndpointBuckets.push(orderedExactEdges.map(edge => sourceFirst ? edge.target : edge.source));
  }

  if (preferredEndpointBuckets.length === 0 && primaryEndpointBuckets.length === 0) return [];

  const orderedEndpointIds = [
    ...interleaveUniqueBuckets(preferredEndpointBuckets, value => value),
    ...interleaveUniqueBuckets(primaryEndpointBuckets, value => value),
    ...interleaveUniqueBuckets(secondaryEndpointBuckets, value => value),
    ...edges.flatMap(edge => [edge.target, edge.source]),
  ];
  return uniqueBy(orderedEndpointIds
    .map(id => nodesById.get(id))
    .filter(node => (
      node
    && (options.includeFiles || node.kind !== 'file')
    && !suppressedEndpointIds.has(node.id)
    && node.kind !== 'import'
    && node.kind !== 'export'
    && node.kind !== 'parameter'
    )), node => node.id);
}

function prioritizeExactRelationCodeBlockEdges(nodesById, exactEdges, query, sourceFirst, rawQuery = '') {
  if (isTestMappingQuery(query) || queryMentionsTests(query)) return exactEdges;
  const context = queryScoringContext(rawQuery || query);
  const relationQuery = normalizeExactRelationQuery(query);
  const shouldUseEndpointRelevance = relationQuery === 'android-kotlin-annotation'
    || relationQuery === 'android-kotlin-constructor'
    || relationQuery === 'android-kotlin-import'
    || relationQuery === 'android-kotlin-property';
  return exactEdges
    .map((edge, index) => ({
      edge,
      index,
      priority: exactRelationCodeBlockEndpointPriority(nodesById, edge, sourceFirst),
      relevance: shouldUseEndpointRelevance
        ? exactRelationCodeBlockEndpointRelevance(nodesById, edge, sourceFirst, context)
        : 0,
    }))
    .sort((a, b) => (
      a.priority - b.priority
      || b.relevance - a.relevance
      || compareExactRelationEdgeSourceOrder(nodesById, a.edge, b.edge, sourceFirst)
      || a.index - b.index
    ))
    .map(entry => entry.edge);
}

function exactRelationCodeBlockEndpointRelevance(nodesById, edge, sourceFirst, context) {
  const primary = nodesById.get(sourceFirst ? edge.source : edge.target);
  const secondary = nodesById.get(sourceFirst ? edge.target : edge.source);
  return Math.max(
    nodeCodeBlockEndpointRelevance(primary, context),
    nodeCodeBlockEndpointRelevance(secondary, context),
  );
}

function nodeCodeBlockEndpointRelevance(node, context) {
  if (!node) return 0;
  const scores = scoreNodeRelevanceForQuery(node, context);
  return scores.explicitScore * 10 + scores.coreScore + scores.fullScore;
}

function compareExactRelationEdgeSourceOrder(nodesById, a, b, sourceFirst) {
  const aPrimary = nodesById.get(sourceFirst ? a.source : a.target);
  const bPrimary = nodesById.get(sourceFirst ? b.source : b.target);
  const aSecondary = nodesById.get(sourceFirst ? a.target : a.source);
  const bSecondary = nodesById.get(sourceFirst ? b.target : b.source);
  return compareNodeSourceOrder(aPrimary, bPrimary)
    || compareNodeSourceOrder(aSecondary, bSecondary);
}

function compareNodeSourceOrder(a, b) {
  return String(a?.filePath ?? '').localeCompare(String(b?.filePath ?? ''))
    || normalizedLineNumber(a?.startLine) - normalizedLineNumber(b?.startLine)
    || normalizedLineNumber(a?.endLine) - normalizedLineNumber(b?.endLine)
    || String(a?.kind ?? '').localeCompare(String(b?.kind ?? ''))
    || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

function compareNativeCodeBlockNodeOrder(a, b, rawQuery = '') {
  return nativeCodeBlockNodePriority(a) - nativeCodeBlockNodePriority(b)
    || lowInformationNodePenalty(a, rawQuery) - lowInformationNodePenalty(b, rawQuery)
    || compareNodeSourceOrder(a, b);
}

function nativeCodeBlockNodePriority(node) {
  if (!node) return 100;
  if (node.kind === 'method' || node.kind === 'function') return 0;
  if (node.kind === 'class' || node.kind === 'component') return 1;
  if (node.kind === 'interface' || node.kind === 'type_alias') return 2;
  if (node.kind === 'property' || node.kind === 'constant') return 3;
  if (node.kind === 'variable') return 5;
  if (node.kind === 'file') return 6;
  if (node.kind === 'import' || node.kind === 'export' || node.kind === 'parameter') return 8;
  return 4;
}

function normalizedLineNumber(value) {
  return Number.isInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function exactRelationCodeBlockEndpointPriority(nodesById, edge, sourceFirst) {
  const primary = nodesById.get(sourceFirst ? edge.source : edge.target);
  const secondary = nodesById.get(sourceFirst ? edge.target : edge.source);
  return codeBlockEndpointPathPriority(primary) || codeBlockEndpointPathPriority(secondary);
}

function codeBlockEndpointPathPriority(node) {
  return isTestFile(node?.filePath) || isLowValueSourcePath(node?.filePath) ? 10 : 0;
}

function preferredExactRelationCodeBlockEndpointIds(nodesById, edges, exactEdges, query, rawQuery = query) {
  const explicitEdgeFunctionSourceEndpointIds = preferredExplicitEdgeFunctionSourceEndpointIds(
    nodesById,
    edges,
    exactEdges,
    query,
    rawQuery,
  );
  if (explicitEdgeFunctionSourceEndpointIds.length > 0) {
    return explicitEdgeFunctionSourceEndpointIds;
  }

  if (query === 'android-widget-provider') {
    return unique(exactEdges
      .map(edge => edge.source)
      .filter(id => {
        const node = nodesById.get(id);
        return node?.kind === 'class' || node?.kind === 'component';
      }));
  }

  if (query === 'template-url' || query === 'style-url') {
    return preferredAngularResourceEndpointIds(edges, exactEdges, query);
  }

  if (normalizeExactRelationQuery(query) === 'context7-source-map-source') {
    return unique(exactEdges
      .map(edge => nodesById.get(edge.source))
      .filter(node => node?.metadata?.relation === 'context7-source-map-route')
      .map(node => node.id));
  }

  if (hardRuleEvidenceTargetEntryPointRelationQueries().has(normalizeExactRelationQuery(query))) {
    return hardRuleEvidenceTargetExactRelationEntryPointIds(nodesById, exactEdges, query);
  }

  if (query === 'sync-config-source') {
    const exactSourceIds = new Set(exactEdges.map(edge => edge.source));
    return unique(edges
      .filter(edge => (
        exactSourceIds.has(edge.source)
        && edge.metadata?.relation === 'config-source'
        && edge.kind === 'references'
      ))
      .map(edge => nodesById.get(edge.target))
      .filter(node => node?.kind === 'property')
      .map(node => node.id));
  }

  const provenanceRelationByQuery = {
    'sync-required-field': 'supabase-select-field',
    'sync-required-predicate': 'supabase-incremental-predicate',
  };
  const provenanceRelation = provenanceRelationByQuery[query];
  if (!provenanceRelation) return [];
  const exactTargetIds = new Set(exactEdges.map(edge => edge.target));
  return unique(edges
    .filter(edge => (
      exactTargetIds.has(edge.target)
      && edge.metadata?.relation === provenanceRelation
    ))
    .map(edge => nodesById.get(edge.source))
    .filter(node => node?.kind === 'method' || node?.kind === 'function')
    .map(node => node.id));
}

function preferredExplicitEdgeFunctionSourceEndpointIds(nodesById, edges, exactEdges, query, rawQuery = query) {
  const relationQuery = normalizeExactRelationQuery(query);
  const context = queryScoringContext(rawQuery);
  if (isTestMappingQuery(relationQuery)) {
    return unique(exactEdges
      .map((edge, index) => {
        const sourceNode = nodesById.get(edge.source);
        return {
          id: edge.source,
          index,
          sourceNode,
          relevance: nodeCodeBlockEndpointRelevance(sourceNode, context),
        };
      })
      .filter(entry => (
        isSupabaseEdgeFunctionSourceNode(entry.sourceNode)
        && edgeFunctionSourceExplicitlyRequested(entry.sourceNode, null, context.queryTerms)
      ))
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
      .map(entry => entry.id));
  }

  if (relationQuery !== 'edge-function-invoke') return [];
  const invokedRouteIds = new Set(exactEdges.map(edge => edge.target));
  return unique(edges
    .filter(edge => (
      invokedRouteIds.has(edge.target)
      && edge.metadata?.relation === 'edge-function-route'
      && edge.kind === 'references'
    ))
    .map((edge, index) => {
      const sourceNode = nodesById.get(edge.source);
      const routeNode = nodesById.get(edge.target);
      return {
        id: edge.source,
        index,
        sourceNode,
        routeNode,
        relevance: nodeCodeBlockEndpointRelevance(sourceNode, context),
      };
    })
    .filter(entry => (
      (entry.sourceNode?.kind === 'method' || entry.sourceNode?.kind === 'function')
      && edgeFunctionSourceExplicitlyRequested(entry.sourceNode, entry.routeNode, context.queryTerms)
    ))
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
    .map(entry => entry.id));
}

function isSupabaseEdgeFunctionSourceNode(node) {
  const filePath = normalizeSearchPath(node?.filePath);
  return (node?.kind === 'method' || node?.kind === 'function')
    && filePath.startsWith('supabase/functions/')
    && filePath.endsWith('/index.ts');
}

function edgeFunctionSourceExplicitlyRequested(sourceNode, routeNode, queryTerms) {
  const sourceName = String(sourceNode?.name ?? '').toLowerCase();
  const invokeName = String(routeNode?.metadata?.invokeName ?? '').toLowerCase();
  const filePath = sourceNode?.filePath;
  return queryTerms.some(term => {
    const normalizedTerm = String(term ?? '').trim().toLowerCase();
    if (!normalizedTerm) return false;
    if (normalizedTerm === sourceName || normalizedTerm === invokeName) return true;
    return isExplicitPathTerm(normalizedTerm) && explicitPathTermMatchesFilePath(normalizedTerm, filePath);
  });
}

function preferredAngularResourceEndpointIds(edges, exactEdges, query) {
  const scored = exactEdges.map((edge, index) => ({
    edge,
    index,
    score: angularResourceEndpointScore(edges, edge, query),
  }));
  if (!scored.some(entry => entry.score > 0)) return [];
  return unique(scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.edge.target));
}

function angularResourceEndpointScore(edges, exactEdge, query) {
  const sourceId = exactEdge.source;
  const targetId = exactEdge.target;
  let score = 0;
  for (const edge of edges) {
    if (edge === exactEdge) continue;
    const relation = String(edge.metadata?.relation ?? '');
    if (!relation || relation === query) continue;
    const touchesResourceOwner = edge.source === sourceId || edge.target === sourceId;
    const touchesResourceFile = edge.source === targetId || edge.target === targetId;
    if (!touchesResourceOwner && !touchesResourceFile) continue;
    score += relation.startsWith('template-') ? 5 : 1;
  }
  return score;
}

function suppressedExactRelationCodeBlockEndpointIds(nodesById, exactEdges, query) {
  if (query === 'sync-required-field') {
    return new Set(exactEdges.map(edge => edge.source));
  }
  if (query === 'sync-required-predicate') {
    const suppressed = new Set();
    for (const edge of exactEdges) {
      suppressed.add(edge.source);
      suppressed.add(edge.target);
    }
    return suppressed;
  }
  if (query === 'host-directive') {
    return new Set(exactEdges.flatMap(edge => [edge.source, edge.target]));
  }
  const normalizedQuery = normalizeExactRelationQuery(query);
  if (normalizedQuery === 'context7-source-map-source') {
    return new Set(exactEdges
      .map(edge => nodesById.get(edge.target))
      .filter(isContext7SourcePathNode)
      .map(node => node.id));
  }
  if (hardRuleEvidenceTargetEntryPointRelationQueries().has(normalizedQuery)) {
    return new Set(exactEdges
      .map(edge => nodesById.get(edge.source))
      .filter(node => node?.kind === 'variable' && node?.filePath === 'AGENTS.md')
      .map(node => node.id));
  }
  if (sourceFirstSyntheticTargetSuppressionRelationQueries().has(normalizedQuery)) {
    return new Set(exactEdges
      .map(edge => nodesById.get(edge.target))
      .filter(node => node?.kind === 'variable')
      .map(node => node.id));
  }
  if (!ownerPreferredSyntheticVariableRelationQueries().has(normalizedQuery)) return new Set();
  const suppressed = new Set();
  for (const edge of exactEdges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    const sourceIsOwner = sourceNode?.kind === 'method' || sourceNode?.kind === 'function';
    if (
      sourceIsOwner
      && targetNode?.kind === 'variable'
      && sourceNode.filePath
      && sourceNode.filePath === targetNode.filePath
    ) {
      suppressed.add(targetNode.id);
    }
    if (shouldSuppressLocalEvidenceEndpointForOwnerPreferredRelation(nodesById, exactEdges, sourceNode, targetNode)) {
      suppressed.add(sourceNode.id);
    }
  }
  return suppressed;
}

function shouldSuppressLocalEvidenceEndpointForOwnerPreferredRelation(nodesById, exactEdges, sourceNode, targetNode) {
  if (
    targetNode?.kind !== 'variable'
    || !isLocalEvidenceNodeKind(sourceNode?.kind)
    || !sourceNode.filePath
    || sourceNode.filePath !== targetNode.filePath
  ) {
    return false;
  }

  return hasIncomingOwnerPreferredExactRelationEdge(nodesById, exactEdges, sourceNode)
    || hasSameRangeSyntheticOperationTarget(sourceNode, targetNode);
}

function isContext7SourcePathNode(node) {
  return node?.kind === 'variable' && node?.metadata?.relation === 'context7-source-path';
}

function isLocalEvidenceNodeKind(kind) {
  return kind === 'variable' || kind === 'constant';
}

function hasIncomingOwnerPreferredExactRelationEdge(nodesById, exactEdges, node) {
  return exactEdges.some(edge => {
    if (edge.target !== node.id) return false;
    const sourceNode = nodesById.get(edge.source);
    return (sourceNode?.kind === 'method' || sourceNode?.kind === 'function')
      && sourceNode.filePath
      && sourceNode.filePath === node.filePath;
  });
}

function hasSameRangeSyntheticOperationTarget(sourceNode, targetNode) {
  return sourceNode.startLine === targetNode.startLine
    && sourceNode.endLine === targetNode.endLine;
}

function codeBlockSourceFirstRelationQueries() {
  return relationPolicySet([
    'standalone-import',
    'provider',
    'dependency',
    'host-attribute',
    'host-binding',
    'host-listener',
    'android-kotlin-annotation',
    'android-kotlin-extends',
    'android-kotlin-implements',
    'android-kotlin-import',
    'android-kotlin-override',
    'android-kotlin-type-reference',
    'android-widget-provider',
    'providedIn',
    'angular-app-provider',
    'angular-route-guard',
    'angular-route-resolver',
    'angular-route-redirect',
    'angular-route-provider',
    'edge-function-route',
    'edge-function-source',
    'edge-function-method',
    'edge-function-header',
    'edge-function-invoke',
    'context7-source-map-source',
    'supabase-storage-bucket',
    'supabase-incremental-predicate',
    'supabase-rpc',
    'supabase-table-write',
    'supabase-realtime-channel',
    'supabase-realtime-postgres-change',
    'supabase-realtime-status',
    'supabase-realtime-unsubscribe',
    'supabase-realtime-remove-channel',
    'supabase-realtime-remove-all-channels',
  ]);
}

function sourceFirstSyntheticTargetSuppressionRelationQueries() {
  return relationPolicySet([
    'edge-function-method',
    'edge-function-header',
    'android-kotlin-annotation',
    'android-kotlin-extends',
    'android-kotlin-implements',
    'android-kotlin-import',
    'android-kotlin-override',
    'android-kotlin-type-reference',
  ]);
}

function hardRuleEvidenceTargetEntryPointRelationQueries() {
  return relationPolicySet([
    'hard-rule-implementation',
    'hard-rule-test-evidence',
  ]);
}

function ownerPreferredSyntheticVariableRelationQueries() {
  return relationPolicySet([
    'supabase-storage-bucket',
    'supabase-incremental-predicate',
    'supabase-rpc',
    'supabase-table-write',
    'supabase-realtime-channel',
    'supabase-realtime-postgres-change',
    'supabase-realtime-status',
    'supabase-realtime-unsubscribe',
    'supabase-realtime-remove-channel',
    'supabase-realtime-remove-all-channels',
  ]);
}

function isTestMappingQuery(query) {
  return relationPolicySet([
    'test',
    'same-basename',
    'class-reference',
    'path-reference',
    'route-reference',
    'invoke-reference',
    'filename-reference',
  ]).has(normalizeExactRelationQuery(query));
}

function relationPolicySet(values) {
  return new Set(values.map(value => normalizeExactRelationQuery(value)));
}

function normalizeExactRelationQuery(value) {
  return String(value ?? '').toLowerCase();
}

function normalizeExactRelationQueries(value) {
  if (Array.isArray(value)) {
    return unique(value.flatMap(item => normalizeExactRelationQueries(item)));
  }
  return unique(String(value ?? '')
    .split('/')
    .map(item => normalizeExactRelationQuery(item))
    .filter(Boolean));
}

function interleaveUniqueBuckets(buckets, keyFn) {
  const results = [];
  const seen = new Set();
  const maxLength = Math.max(0, ...buckets.map(bucket => bucket.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const bucket of buckets) {
      const item = bucket[index];
      if (item === undefined || item === null) continue;
      const key = keyFn(item);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  }
  return results;
}

function resolveNativeCodeBlockNode(projectRoot, node, nodes) {
  const edgeFunctionNode = resolveSupabaseEdgeFunctionCodeBlockNode(projectRoot, node);
  if (edgeFunctionNode) {
    return edgeFunctionNode;
  }

  if (node?.kind !== 'component' || !node.filePath || !node.name) {
    return node;
  }
  const selectedClassNode = nodes.find(candidate => (
    candidate.kind === 'class'
    && candidate.filePath === node.filePath
    && candidate.name === node.name
    && (candidate.endLine ?? candidate.startLine ?? 0) > (node.endLine ?? node.startLine ?? 0)
  ));
  return selectedClassNode ?? resolveSameFileClassCodeBlockNode(projectRoot, node) ?? node;
}

function resolveSupabaseEdgeFunctionCodeBlockNode(projectRoot, node) {
  if (
    node?.kind !== 'function'
    || !node.filePath
    || !node.filePath.startsWith('supabase/functions/')
    || !node.filePath.endsWith('/index.ts')
  ) {
    return null;
  }
  const absolutePath = resolveProjectSourcePath(projectRoot, node.filePath);
  if (!absolutePath) return null;

  const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const serveIndex = sourceLines.findIndex(line => /\b(?:Deno\.)?serve\s*\(/.test(line));
  if (serveIndex < 0) return null;
  const serveEndLine = findBlockEndLine(sourceLines, serveIndex);
  const delegatedHandlerIndex = findDelegatedEdgeFunctionHandlerIndex(sourceLines, serveIndex, serveEndLine);
  if (delegatedHandlerIndex >= 0) {
    return {
      ...node,
      id: `${node.id}:edge-function-handler-code-block`,
      startLine: delegatedHandlerIndex + 1,
      endLine: findBlockEndLine(sourceLines, delegatedHandlerIndex),
    };
  }
  return {
    ...node,
    id: `${node.id}:edge-function-code-block`,
    startLine: serveIndex + 1,
    endLine: serveEndLine,
  };
}

function findDelegatedEdgeFunctionHandlerIndex(sourceLines, serveIndex, serveEndLine) {
  const delegatedFunctionName = findDelegatedEdgeFunctionHandlerName(sourceLines, serveIndex, serveEndLine);
  if (!delegatedFunctionName) return -1;
  const declarationPattern = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(delegatedFunctionName)}\\s*\\(`);
  const constFunctionPattern = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(delegatedFunctionName)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`);
  return sourceLines.findIndex(line => declarationPattern.test(line) || constFunctionPattern.test(line));
}

function findDelegatedEdgeFunctionHandlerName(sourceLines, serveIndex, serveEndLine) {
  const startIndex = Math.max(0, serveIndex);
  const endIndex = Math.min(sourceLines.length, Math.max(serveIndex + 1, serveEndLine));
  for (let index = startIndex; index < endIndex; index += 1) {
    const match = /\breturn\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\b/.exec(sourceLines[index]);
    if (match?.[1]) return match[1];
  }
  return '';
}

function resolveSameFileClassCodeBlockNode(projectRoot, componentNode) {
  const absolutePath = resolveProjectSourcePath(projectRoot, componentNode.filePath);
  if (!absolutePath) return null;

  const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const classPattern = new RegExp(`\\bclass\\s+${escapeRegExp(componentNode.name)}\\b`);
  const classIndex = sourceLines.findIndex((line, index) =>
    index + 1 >= (componentNode.startLine ?? 1) && classPattern.test(line));
  if (classIndex < 0) return null;

  return {
    ...componentNode,
    id: `${componentNode.id}:class-code-block`,
    kind: 'class',
    startLine: classIndex + 1,
    endLine: findBlockEndLine(sourceLines, classIndex),
  };
}

function findBlockEndLine(sourceLines, startIndex) {
  let depth = 0;
  let hasOpened = false;
  for (let index = startIndex; index < sourceLines.length; index++) {
    const line = sourceLines[index];
    for (const char of line) {
      if (char === '{') {
        depth++;
        hasOpened = true;
      } else if (char === '}' && hasOpened) {
        depth--;
        if (depth <= 0) return index + 1;
      }
    }
  }
  return startIndex + 1;
}

function findAngularArrayMetadataStartLine(sourceLines, edgeLine, propertyName) {
  const propertyPattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`);
  for (let index = Math.max(0, edgeLine - 1); index >= 0; index -= 1) {
    const line = sourceLines[index];
    if (propertyPattern.test(line)) return index + 1;
    if (/^\s*@(?:Component|Directive)\s*\(\s*\{/.test(line)) break;
  }
  return null;
}

function findAngularArrayMetadataEndLine(sourceLines, startLine, propertyName) {
  const startIndex = Math.max(0, startLine - 1);
  const propertyPattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`);
  let bracketDepth = 0;
  let hasOpened = false;

  for (let index = startIndex; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    if (!hasOpened && !propertyPattern.test(line)) continue;
    for (const char of line) {
      if (char === '[') {
        bracketDepth += 1;
        hasOpened = true;
      } else if (char === ']' && hasOpened) {
        bracketDepth -= 1;
        if (bracketDepth <= 0) return index + 1;
      }
    }
    if (hasOpened && bracketDepth <= 0) return index + 1;
  }

  return startLine;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readNodeCodeBlock(projectRoot, node) {
  if (!node?.filePath || node.filePath === '(unknown)') return null;
  const absolutePath = resolveProjectSourcePath(projectRoot, node.filePath);
  if (!absolutePath) return null;

  const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const declaredStartLine = Math.max(1, node.startLine ?? 1);
  const startLine = resolveNodeCodeBlockStartLine(sourceLines, node, declaredStartLine);
  const defaultEndLine = node.kind === 'file' ? sourceLines.length : startLine;
  const nodeEndLine = resolveNodeCodeBlockEndLine(sourceLines, node, startLine, defaultEndLine);
  const endLine = Math.max(startLine, Math.min(sourceLines.length, nodeEndLine ?? defaultEndLine));
  const content = sourceLines.slice(startLine - 1, endLine).join('\n');
  if (!content.trim()) return null;
  const codeBlockContent = shouldKeepCompleteNativeCodeBlock(node)
    ? content
    : truncateNativeCodeBlockContent(content);

  return {
    filePath: node.filePath,
    startLine,
    endLine,
    language: languageForFile(node.filePath, node),
    content: codeBlockContent,
    nodeName: node.name,
    nodeKind: node.kind,
  };
}

function shouldKeepCompleteNativeCodeBlock(node) {
  return isSqlStatementNode(node);
}

function truncateNativeCodeBlockContent(content) {
  return content.length > NATIVE_CONTEXT_CODE_BLOCK_SIZE
    ? `${content.slice(0, NATIVE_CONTEXT_CODE_BLOCK_SIZE)}\n... (truncated) ...`
    : content;
}

function resolveNodeCodeBlockStartLine(sourceLines, node, defaultStartLine) {
  if (isSqlStatementNode(node)) {
    return findSqlStatementStartLine(sourceLines, defaultStartLine);
  }
  if (node?.metadata?.relation !== 'hard-rule-keyword') {
    return defaultStartLine;
  }

  const matchedNeedle = String(
    node.metadata.matchedNeedle
      ?? node.metadata.keyword
      ?? node.name
      ?? node.qualifiedName
      ?? '',
  ).trim();
  if (!matchedNeedle) {
    return defaultStartLine;
  }

  return findHardRuleKeywordNeedleLine(sourceLines, matchedNeedle, defaultStartLine)
    ?? defaultStartLine;
}

function resolveNodeCodeBlockEndLine(sourceLines, node, startLine, defaultEndLine) {
  if (node.kind === 'file') return defaultEndLine;
  if (node.kind === 'route' && (!Number.isInteger(node.endLine) || node.endLine <= startLine)) {
    return findBlockEndLine(sourceLines, startLine - 1);
  }
  if (isSqlStatementNode(node)) {
    return findSqlStatementEndLine(sourceLines, startLine);
  }
  if (Number.isInteger(node.endLine) && node.endLine >= startLine) return node.endLine;
  return node.endLine;
}

function isSqlStatementNode(node) {
  if (!String(node?.filePath ?? '').toLowerCase().endsWith('.sql')) return false;
  const relation = node?.metadata?.relation;
  if (relation === 'policy') return true;
  if (SQL_STATEMENT_NODE_RELATIONS.has(relation)) return true;
  const signature = String(node?.signature ?? '').toLowerCase();
  return signature.startsWith('policy ')
    || signature.startsWith('index ')
    || signature.startsWith('constraint ')
    || signature.startsWith('rls ')
    || signature.startsWith('privilege ');
}

function findSqlStatementEndLine(sourceLines, startLine) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarQuoteTag = '';

  for (let lineIndex = Math.max(0, startLine - 1); lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex] ?? '';
    for (let index = 0; index < line.length; index += 1) {
      if (dollarQuoteTag) {
        if (line.startsWith(dollarQuoteTag, index)) {
          index += dollarQuoteTag.length - 1;
          dollarQuoteTag = '';
        }
        continue;
      }

      const char = line[index];
      const next = line[index + 1];
      if (inSingleQuote) {
        if (char === "'" && next === "'") {
          index += 1;
          continue;
        }
        if (char === "'") inSingleQuote = false;
        continue;
      }
      if (inDoubleQuote) {
        if (char === '"' && next === '"') {
          index += 1;
          continue;
        }
        if (char === '"') inDoubleQuote = false;
        continue;
      }

      if (char === '-' && next === '-') break;
      if (char === "'") {
        inSingleQuote = true;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        continue;
      }
      const dollarTag = readSqlDollarQuoteTag(line, index);
      if (dollarTag) {
        dollarQuoteTag = dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
      if (char === ';') return lineIndex + 1;
    }
  }

  return startLine;
}

function findSqlStatementStartLine(sourceLines, lineNumber) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarQuoteTag = '';
  let statementStartLine = 1;
  const targetLineIndex = Math.max(0, Math.min(sourceLines.length - 1, lineNumber - 1));

  for (let lineIndex = 0; lineIndex <= targetLineIndex; lineIndex += 1) {
    const line = sourceLines[lineIndex] ?? '';
    for (let index = 0; index < line.length; index += 1) {
      if (dollarQuoteTag) {
        if (line.startsWith(dollarQuoteTag, index)) {
          index += dollarQuoteTag.length - 1;
          dollarQuoteTag = '';
        }
        continue;
      }

      const char = line[index];
      const next = line[index + 1];
      if (inSingleQuote) {
        if (char === "'" && next === "'") {
          index += 1;
          continue;
        }
        if (char === "'") inSingleQuote = false;
        continue;
      }
      if (inDoubleQuote) {
        if (char === '"' && next === '"') {
          index += 1;
          continue;
        }
        if (char === '"') inDoubleQuote = false;
        continue;
      }

      if (char === '-' && next === '-') break;
      if (char === "'") {
        inSingleQuote = true;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        continue;
      }
      const dollarTag = readSqlDollarQuoteTag(line, index);
      if (dollarTag) {
        dollarQuoteTag = dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
      if (char === ';' && lineIndex < targetLineIndex) {
        statementStartLine = lineIndex + 2;
      }
    }
  }

  let normalizedStartLine = Math.max(1, Math.min(sourceLines.length, statementStartLine));
  while (
    normalizedStartLine < lineNumber
    && String(sourceLines[normalizedStartLine - 1] ?? '').trim() === ''
  ) {
    normalizedStartLine += 1;
  }
  return normalizedStartLine;
}

function readSqlDollarQuoteTag(line, index) {
  if (line[index] !== '$') return '';
  const match = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(line.slice(index));
  return match?.[0] ?? '';
}

function readEdgeLineCodeBlock(projectRoot, sourceNode, edge) {
  if (!sourceNode?.filePath || sourceNode.filePath === '(unknown)') return null;
  const blockSourceNode = edgeCodeBlockSourceNode(sourceNode, edge);
  const absolutePath = resolveProjectSourcePath(projectRoot, blockSourceNode.filePath);
  if (!absolutePath) return null;

  const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const edgeLine = resolveEdgeCodeBlockLine(edge, sourceLines);
  if (!edgeLine) return null;
  const startLine = Math.min(edgeLine, sourceLines.length);
  const endLine = resolveEdgeCodeBlockEndLine(edge, blockSourceNode, sourceLines, startLine);
  const content = sourceLines.slice(startLine - 1, endLine).join('\n');
  const nodeName = edgeLineCodeBlockNodeName(blockSourceNode, edge, sourceLines, startLine);

  return {
    filePath: blockSourceNode.filePath,
    startLine,
    endLine,
    language: languageForFile(blockSourceNode.filePath, blockSourceNode),
    content,
    nodeName,
    nodeKind: blockSourceNode.kind,
  };
}

function resolveEdgeCodeBlockEndLine(edge, sourceNode, sourceLines, startLine) {
  if (edge?.metadata?.relation === 'edge-function-header') {
    const range = findEdgeFunctionHeaderEvidenceRange(edge, sourceLines);
    if (range) return range.endLine;
  }
  if (shouldExpandEdgeCodeBlockAsSqlStatement(edge, sourceNode)) {
    return findSqlStatementEndLine(sourceLines, startLine);
  }
  if (edge?.metadata?.relation === 'host-directive') {
    return findAngularArrayMetadataEndLine(sourceLines, startLine, 'hostDirectives');
  }
  if (
    edge?.metadata?.relation === 'angular-app-provider'
    && Number.isInteger(edge?.metadata?.endLine)
    && edge.metadata.endLine >= startLine
  ) {
    return Math.min(sourceLines.length, edge.metadata.endLine);
  }
  if (shouldExpandEdgeCodeBlockAsChainWindow(edge)) {
    return findChainedCallEvidenceEndLine(sourceLines, startLine);
  }
  return startLine;
}

function shouldExpandEdgeCodeBlockAsChainWindow(edge) {
  return provenanceEdgeLineRelationNodeNameQueries().has(normalizeExactRelationQuery(edge?.metadata?.relation));
}

function findChainedCallEvidenceEndLine(sourceLines, startLine) {
  const maxEndLine = Math.min(sourceLines.length, startLine + 8);
  for (let lineNumber = startLine; lineNumber <= maxEndLine; lineNumber += 1) {
    const line = sourceLines[lineNumber - 1] ?? '';
    if (line.trim().endsWith(';')) {
      return lineNumber;
    }
  }
  return maxEndLine;
}

function edgeLineCodeBlockNodeName(sourceNode, edge, sourceLines = [], startLine = null) {
  const relation = edge?.metadata?.relation;
  if (relation === 'edge-function-header') {
    const functionName = readJavaScriptFunctionBlockName(sourceLines[startLine - 1]);
    if (functionName) return functionName;
  }
  if (
    isHardRuleEvidenceRelation(relation)
    || provenanceEdgeLineRelationNodeNameQueries().has(normalizeExactRelationQuery(relation))
    || sourceOwnerEdgeLineRelationNodeNameQueries().has(normalizeExactRelationQuery(relation))
  ) {
    return sourceNode.name;
  }
  return edge.metadata?.constraintName
    ?? edge.metadata?.matchedNeedle
    ?? edge.metadata?.relation
    ?? sourceNode.name;
}

function readJavaScriptFunctionBlockName(line) {
  const text = String(line ?? '').trim();
  return /^(?:export\s+)?(?:async\s+)?function\s+([$A-Z_a-z][$\w]*)\b/.exec(text)?.[1]
    ?? /^(?:export\s+)?(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=/.exec(text)?.[1]
    ?? null;
}

function provenanceEdgeLineRelationNodeNameQueries() {
  return relationPolicySet(Object.values(provenanceEdgeLineRelationByQuery()));
}

function sourceOwnerEdgeLineRelationNodeNameQueries() {
  return relationPolicySet([
    'standalone-import',
    'provider',
    'dependency',
    'angular-app-provider',
    'host-directive',
    'host-attribute',
    'host-binding',
    'host-listener',
    'edge-function-header',
  ]);
}

function shouldExpandEdgeCodeBlockAsSqlStatement(edge, sourceNode) {
  if (!String(sourceNode?.filePath ?? '').toLowerCase().endsWith('.sql')) return false;
  return SQL_STATEMENT_EDGE_RELATIONS.has(edge?.metadata?.relation);
}

function edgeCodeBlockSourceNode(sourceNode, edge) {
  const templateFile = edge?.metadata?.templateFile;
  if (!templateFile) return sourceNode;
  return {
    ...sourceNode,
    filePath: templateFile,
    name: edge.metadata?.matchedNeedle ?? sourceNode.name,
    kind: 'file',
    language: undefined,
  };
}

function resolveEdgeCodeBlockLine(edge, sourceLines) {
  const matchedNeedle = String(edge?.metadata?.matchedNeedle ?? '').trim();
  const relation = String(edge?.metadata?.relation ?? '');
  if (relation === 'edge-function-header') {
    const range = findEdgeFunctionHeaderEvidenceRange(edge, sourceLines);
    if (range) return range.startLine;
  }
  if (relation === 'host-directive' && Number.isInteger(edge?.line) && edge.line >= 1) {
    const metadataLine = findAngularArrayMetadataStartLine(sourceLines, edge.line, 'hostDirectives');
    if (metadataLine) return metadataLine;
  }
  if (
    relation === 'angular-app-provider'
    && Number.isInteger(edge?.metadata?.bootstrapLine)
    && edge.metadata.bootstrapLine >= 1
  ) {
    return edge.metadata.bootstrapLine;
  }
  if (relation.startsWith('template-') && edge?.metadata?.templateFile && Number.isInteger(edge?.line) && edge.line >= 1) {
    return edge.line;
  }
  if (String(edge?.metadata?.relation ?? '') === 'hard-rule-keyword' && matchedNeedle) {
    const scopedLine = findHardRuleKeywordNeedleLine(sourceLines, matchedNeedle, edge?.line);
    if (scopedLine) return scopedLine;
  }
  if (shouldPreferMatchedNeedleCodeBlockLine(edge) && matchedNeedle) {
    const matchedLine = findCodeBlockNeedleLine(sourceLines, matchedNeedle);
    if (matchedLine) return matchedLine;
  }
  if (Number.isInteger(edge?.line) && edge.line >= 1) return edge.line;
  if (!matchedNeedle) return null;
  const lineIndex = sourceLines.findIndex(line => line.includes(matchedNeedle));
  return lineIndex >= 0 ? lineIndex + 1 : null;
}

function findEdgeFunctionHeaderEvidenceRange(edge, sourceLines) {
  if (!Number.isInteger(edge?.line) || edge.line < 1) return null;
  const evidenceLineIndex = Math.min(sourceLines.length - 1, edge.line - 1);
  const startIndex = findContainingJavaScriptFunctionStartIndex(sourceLines, evidenceLineIndex);
  if (startIndex < 0) {
    return { startLine: evidenceLineIndex + 1, endLine: evidenceLineIndex + 1 };
  }
  return {
    startLine: startIndex + 1,
    endLine: findJavaScriptFunctionBlockEndLine(sourceLines, startIndex),
  };
}

function findContainingJavaScriptFunctionStartIndex(sourceLines, evidenceLineIndex) {
  const minIndex = Math.max(0, evidenceLineIndex - 120);
  for (let index = evidenceLineIndex; index >= minIndex; index -= 1) {
    if (isJavaScriptFunctionBlockStart(sourceLines[index])) {
      return index;
    }
  }
  return -1;
}

function isJavaScriptFunctionBlockStart(line) {
  const text = String(line ?? '').trim();
  return /^(?:export\s+)?(?:async\s+)?function\b/.test(text)
    || /^(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>\s*\{/.test(text)
    || /\b(?:Deno\.)?serve\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>\s*\{/.test(text);
}

function findJavaScriptFunctionBlockEndLine(sourceLines, startIndex) {
  const startLine = sourceLines[startIndex] ?? '';
  const openingBraceIndex = startLine.lastIndexOf('{');
  if (openingBraceIndex < 0) {
    return findBlockEndLine(sourceLines, startIndex);
  }
  return findBlockEndLineFromPosition(sourceLines, startIndex, openingBraceIndex);
}

function findBlockEndLineFromPosition(sourceLines, startIndex, startColumn) {
  let depth = 0;
  let hasOpened = false;
  for (let index = startIndex; index < sourceLines.length; index++) {
    const line = sourceLines[index] ?? '';
    const firstColumn = index === startIndex ? Math.max(0, startColumn) : 0;
    for (let column = firstColumn; column < line.length; column++) {
      const char = line[column];
      if (char === '{') {
        depth++;
        hasOpened = true;
      } else if (char === '}' && hasOpened) {
        depth--;
        if (depth <= 0) return index + 1;
      }
    }
  }
  return startIndex + 1;
}

function shouldPreferMatchedNeedleCodeBlockLine(edge) {
  const relation = String(edge?.metadata?.relation ?? '');
  return relation === 'hard-rule-keyword';
}

function findCodeBlockNeedleLine(sourceLines, matchedNeedle) {
  const lineIndex = sourceLines.findIndex(line => line.includes(matchedNeedle));
  return lineIndex >= 0 ? lineIndex + 1 : null;
}

function findHardRuleKeywordNeedleLine(sourceLines, matchedNeedle, headingLine) {
  if (!Number.isInteger(headingLine) || headingLine < 1) return null;
  const startIndex = Math.min(sourceLines.length, headingLine);
  const evidencePattern = hardRuleKeywordEvidencePattern(matchedNeedle);
  for (let index = startIndex; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? '';
    if (/^#{2,4}\s+/.test(line)) {
      return null;
    }
    if (line.includes(matchedNeedle) || evidencePattern?.test(line)) {
      return index + 1;
    }
  }
  return null;
}

function hardRuleKeywordEvidencePattern(keyword) {
  switch (String(keyword ?? '').trim().toLowerCase()) {
    case 'crypto.randomuuid()':
      return /crypto\.randomUUID\s*\(\s*\)/i;
    case 'database autoincrement id':
      return /\bdatabase\s+autoincrement\s+ids?\b|数据库自增\s*ID/i;
    case 'temporary id':
      return /\btemporary\s+ids?\b|临时\s*ID/i;
    case 'id mapping':
      return /\bid\s+mapping\b|ID\s*映射/i;
    case 'indexeddb':
      return /\bIndexedDB\b/i;
    case 'retryqueue':
      return /\bRetryQueue\b/i;
    case 'lww':
      return /\bLWW\b|Last-Write-Wins/i;
    case 'content':
      return /\bcontent\b|不可漏字段|必须包含\s*content|must\s+include\s+content/i;
    case '@defer':
      return /@defer\b/i;
    case 'visibility:hidden':
      return /visibility\s*:\s*hidden/i;
    case 'floating_tree_config.max_subtree_depth':
      return /\bFLOATING_TREE_CONFIG\.MAX_SUBTREE_DEPTH\b/i;
    case 'storeservice':
      return /\bStoreService\b/i;
    case 'facade store':
      return /\bfacade\s+Store\b|门面\s*Store/i;
    case 'ngrx':
      return /\bNgRx\b/i;
    case 'rxjs store':
      return /\bRxJS\s+Store\b/i;
    default:
      return null;
  }
}

function pushNativeCodeBlock(blocks, block, options = {}) {
  if (!isUsableNativeCodeBlock(block)) return;
  const key = nativeCodeBlockSourceRangeKey(block);
  if (blocks.some(existing => nativeCodeBlockSourceRangeKey(existing) === key)) return;
  if (options.coalesceContainedRanges) {
    const containingIndex = blocks.findIndex(existing => nativeCodeBlockContains(existing, block));
    if (containingIndex >= 0) return;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (nativeCodeBlockContains(block, blocks[index])) {
        blocks.splice(index, 1);
      }
    }
  }
  blocks.push(block);
}

function isUsableNativeCodeBlock(block) {
  return Boolean(block && String(block.content ?? '').trim());
}

function nativeCodeBlockSourceRangeKey(block) {
  return `${block.filePath}:${block.startLine}:${block.endLine}:${block.language}`;
}

function nativeCodeBlockContains(outer, inner) {
  return outer?.filePath === inner?.filePath
    && outer?.language === inner?.language
    && Number.isInteger(outer?.startLine)
    && Number.isInteger(outer?.endLine)
    && Number.isInteger(inner?.startLine)
    && Number.isInteger(inner?.endLine)
    && outer.startLine <= inner.startLine
    && outer.endLine >= inner.endLine;
}

function toNativeJsonFormatterResponse(context) {
  const orderedEntryPoints = orderNativeProjectionItems(context.entryPoints, context.query);
  const nodes = orderNativeProjectionItems(context.nodes, context.query);
  const nodeIds = new Set(nodes.map(node => node.id));
  const closedEdges = context.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const orderedCodeBlocks = orderNativeProjectionItems(context.codeBlocks, context.query, {
    preserveExactRelationEvidence: true,
  });
  const relatedFiles = orderRelatedFilesForQuery(unique([
    ...orderedCodeBlocks.map(block => block.filePath).filter(Boolean),
    ...context.relatedFiles,
  ]), context.query);
  const codeBlocks = orderedCodeBlocks.map(serializeNativeJsonCodeBlock);
  return {
    query: context.query,
    summary: formatSummary(nodes, relatedFiles),
    entryPoints: orderedEntryPoints.map(serializeNativeJsonNode),
    nodes: nodes.map(serializeNativeJsonNode),
    edges: closedEdges.map(serializeNativeJsonEdge),
    codeBlocks,
    relatedFiles,
    stats: {
      ...context.stats,
      nodeCount: nodes.length,
      edgeCount: closedEdges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((total, block) => total + block.content.length, 0),
    },
  };
}

function serializeNativeJsonNode(node) {
  return omitUndefined({
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    signature: node.signature,
    docstring: node.docstring,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
    isAbstract: node.isAbstract,
  });
}

function serializeNativeJsonEdge(edge) {
  return omitUndefined({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: nativeJsonEdgeLine(edge),
    column: nativeJsonEdgeColumn(edge),
  });
}

function nativeJsonEdgeLine(edge) {
  if (Number.isInteger(edge?.line)) return edge.line;
  return undefined;
}

function nativeJsonEdgeColumn(edge) {
  if (Number.isInteger(edge?.column)) return edge.column;
  return undefined;
}

function serializeNativeJsonCodeBlock(block) {
  return omitUndefined({
    filePath: block.filePath,
    startLine: block.startLine,
    endLine: block.endLine,
    language: block.language,
    content: block.content,
    nodeName: block.nodeName,
    nodeKind: block.nodeKind,
  });
}

function getExploreOutputBudget(fileCount) {
  if (fileCount < 150) {
    return {
      maxOutputChars: 13_000,
      defaultMaxFiles: 4,
      maxCharsPerFile: 3_800,
      gapThreshold: 7,
      maxSymbolsInFileHeader: 5,
      maxEdgesPerRelationshipKind: 4,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 500) {
    return {
      maxOutputChars: 18_000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3_800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 5000) {
    return {
      maxOutputChars: 24_000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 6_500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  if (fileCount < 15000) {
    return {
      maxOutputChars: 24_000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 7_000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  return {
    maxOutputChars: 24_000,
    defaultMaxFiles: 8,
    maxCharsPerFile: 7_000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
    excludeLowValueFiles: false,
  };
}

function formatInlineFileList(filePaths, cap) {
  const shown = filePaths.slice(0, cap).map(filePath => `\`${filePath}\``).join(', ');
  const omitted = filePaths.length - cap;
  return omitted > 0 ? `${shown} +${omitted} more` : shown;
}

function isExactRelationshipQuery(groups, rawQuery) {
  const query = String(rawQuery ?? '').toLowerCase();
  if (!query) return false;
  const exactQueries = new Set([
    query,
    ...queryTokens(query).filter(isMixedExactMetadataQueryTerm),
  ]);
  return Object.values(groups ?? {}).some(edges => (edges ?? []).some(edge => (
    exactQueries.has(String(edge.relation ?? '').toLowerCase())
    || exactQueries.has(String(edge.synthesizedBy ?? '').toLowerCase())
    || exactQueries.has(String(edge.bindingKind ?? '').toLowerCase())
    || exactQueries.has(String(edge.testMapping ?? '').toLowerCase())
    || exactQueries.has(String(edge.keywordMapping ?? '').toLowerCase())
    || [...exactQueries].some(exactQuery => isQueriedRelationshipEvidence(edge, exactQuery))
  )));
}

function isQueriedRelationshipEvidence(edge, query) {
  if (!isHardRuleEvidenceRelation(edge?.relation)) return false;
  const normalizedQuery = normalizeRelationshipEvidenceValue(query);
  return [
    edge.keyword,
    edge.matchedNeedle,
    edge.call,
  ].some(value => normalizeRelationshipEvidenceValue(value) === normalizedQuery);
}

function normalizeRelationshipEvidenceValue(value) {
  return String(value ?? '').toLowerCase().replace(/\(\)$/, '');
}

function isHardRuleEvidenceRelation(relation) {
  return relation === 'hard-rule-implementation' || relation === 'hard-rule-test-evidence';
}

function getExploreBudget(fileCount) {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

function truncateMarkdownOutput(markdown, maxChars = MAX_MARKDOWN_OUTPUT_CHARS) {
  if (markdown.length <= maxChars) return markdown;
  const cut = markdown.slice(0, maxChars);
  const lastSection = cut.lastIndexOf('\n#### ');
  const boundary = lastSection > maxChars * 0.5 ? lastSection : cut.lastIndexOf('\n');
  const safe = boundary > 0 ? cut.slice(0, boundary) : cut;
  return `${safe}\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another codegraph_explore with the specific names — do NOT Read these files.)`;
}

function formatEdgeMetadata(edge) {
  const ignored = new Set(['source', 'target']);
  const entries = Object.entries(edge).filter(([key, value]) => !ignored.has(key) && value !== undefined);
  if (entries.length === 0) return '';
  return ` (${entries.map(([key, value]) => `${key}: ${value}`).join(', ')})`;
}

function formatMatchSummary(match) {
  const item = match.item;
  const parts = [];
  if (item.selector) parts.push(`selector: ${item.selector}`);
  if (item.path !== undefined && item.path !== null) parts.push(`path: ${item.path}`);
  if (item.riskTags?.length) parts.push(`risk: ${item.riskTags.join(', ')}`);
  if (item.tests?.length) parts.push(`tests: ${item.tests.join(', ')}`);
  return parts.length > 0 ? ` — ${parts.join('; ')}` : '';
}

function groupNodesByFile(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const filePath = node.filePath || '(unknown)';
    const group = groups.get(filePath) ?? [];
    group.push(node);
    groups.set(filePath, group);
  }
  return [...groups.entries()]
    .map(([filePath, group]) => [filePath, group.sort(compareNode)]);
}

function groupMarkdownRelatedNodesByFile(nodes) {
  const groups = new Map();
  const seenDisplayKeys = new Set();
  const sortedNodes = nodes
    .filter(node => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
    .filter(node => {
      const key = markdownRelatedSymbolKey(node);
      if (seenDisplayKeys.has(key)) return false;
      seenDisplayKeys.add(key);
      return true;
    });
  for (const node of sortedNodes) {
    const filePath = node.filePath || '(unknown)';
    const group = groups.get(filePath) ?? [];
    group.push(node);
    groups.set(filePath, group);
  }
  return [...groups.entries()]
    .map(([filePath, group]) => [filePath, group.sort(compareNodeSourceOrder)]);
}

function markdownRelatedSymbolKey(node) {
  return [
    node?.filePath ?? '',
    node?.name ?? '',
    node?.startLine ?? '',
  ].join('\0');
}

function buildSourceBlocks(projectRoot, nodes, outputBudget = getExploreOutputBudget(0), rawQuery = '', edges = []) {
  let fileGroups = groupNodesByFile(nodes);
  {
    const nonLowValueGroups = fileGroups.filter(([filePath]) => !isLowValueSourcePath(filePath, rawQuery));
    if (nonLowValueGroups.length >= 2) {
      fileGroups = nonLowValueGroups;
    }
  }
  const context = queryScoringContext(rawQuery);
  fileGroups = fileGroups
    .map(([filePath, fileNodes], index) => ({
      filePath,
      fileNodes,
      index,
      ...scoreSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context),
    }))
    .sort((a, b) => b.preferredScore - a.preferredScore
      || b.explicitScore - a.explicitScore
      || b.coreScore - a.coreScore
      || b.pathScore - a.pathScore
      || b.fullScore - a.fullScore
      || a.index - b.index
      || a.filePath.localeCompare(b.filePath))
    .map(({ filePath, fileNodes }) => [filePath, fileNodes]);
  return fileGroups
    .slice(0, outputBudget.defaultMaxFiles ?? SOURCE_BLOCK_FILE_LIMIT)
    .map(([filePath, fileNodes]) => readSourceBlock(projectRoot, filePath, fileNodes, outputBudget))
    .filter(Boolean);
}

function scoreSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context) {
  const nodeScores = fileNodes.map(node => scoreNodeRelevanceForQuery(node, context));
  return {
    preferredScore: scorePreferredSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context),
    pathScore: scorePathTermMatch(filePath, context.queryTerms),
    explicitScore: maxNumericScore(nodeScores, 'explicitScore'),
    coreScore: maxNumericScore(nodeScores, 'coreScore'),
    fullScore: maxNumericScore(nodeScores, 'fullScore'),
  };
}

function scorePreferredSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context) {
  if (!context7RetrievalSourceQueryApplies(context.queryTerms)) return 0;
  const fileNodeIds = new Set(fileNodes.map(node => node.id));
  const selectedRouteIds = selectedContext7RetrievalRouteIds(nodes, context.queryTerms);
  if (selectedRouteIds.size === 0) return 0;
  return edges.some(edge => (
    edge.metadata?.relation === 'context7-retrieval-primary'
    && selectedRouteIds.has(edge.source)
    && fileNodeIds.has(edge.target)
  ))
    ? 1
    : 0;
}

function maxNumericScore(scores, key) {
  let maxScore = 0;
  for (const score of scores) {
    const value = Number(score?.[key] ?? 0);
    if (Number.isFinite(value) && value > maxScore) {
      maxScore = value;
    }
  }
  return maxScore;
}

function queryMentionsTests(query) {
  return /\b(test|tests|testing|spec|verify|verifies)\b/i.test(String(query ?? ''));
}

function isLowValueSourcePath(filePath, rawQuery = '') {
  const normalized = toPosix(String(filePath ?? '')).toLowerCase();
  if (!normalized) return false;
  const query = String(rawQuery ?? '').toLowerCase();
  if (queryMentionsLowValueSourcePathExplicitly(normalized, query)) return false;

  if (isTestLikeLowValueSourcePath(normalized)) {
    return !queryAllowsTestFiles(query)
      && !/\b(e2e|cypress|playwright|fixtures?|mocks?|stubs?|snapshots?|helpers?|harness)\b/i.test(query);
  }
  if (
    /(^|\/)(?:\d+-)?(stories?|storybook|demos?|samples?|examples?|playground)\//.test(normalized)
    || /\.(?:stories?|story|demo|sample|example|playground)\.[cm]?[jt]sx?$/.test(normalized)
  ) {
    return !/\b(story|stories|storybook|demos?|samples?|examples?|playgrounds?)\b/i.test(query);
  }
  if (/\bicons?\b/.test(normalized)) return !/\bicons?\b/i.test(query);
  if (/\bi18n\b/.test(normalized)) return !/\bi18n\b/i.test(query);
  if (/(^|\/)scripts\//.test(normalized)) {
    return !/\b(scripts?|codegraph|nanoflow|wrapper|adapter|mcp|gate|doctor|smoke)\b/i.test(query);
  }
  if (/(^|\/)\.github\//.test(normalized)) {
    return !/\b(github|workflows?|ci|actions?)\b/i.test(query);
  }
  if (/(^|\/)cloudflare\/workers-static-assets\//.test(normalized)) {
    return !/\b(cloudflare|workers?)\b/i.test(query);
  }
  return false;
}

// 官方 low-value 分类中的 test/spec/helper/e2e/fixture/mock/stub/snapshot 路径族。
function isTestLikeLowValueSourcePath(normalized) {
  return /\/(tests?|__tests?__|spec)\//.test(normalized)
    || /(^|\/)(e2e|cypress|playwright)(\/|$)/.test(normalized)
    || /(^|\/)(__fixtures__|__mocks__|fixtures?|mocks?|stubs?|snapshots?|test-fixtures|testdata|test-data)(\/|$)/.test(normalized)
    || /_test\.go$/.test(normalized)
    || /(?:^|\/)test_[^/]+\.py$/.test(normalized)
    || /_test\.py$/.test(normalized)
    || /_spec\.rb$/.test(normalized)
    || /_test\.rb$/.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(?:cy|e2e)\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(?:test|spec)-helpers?\.[cm]?[jt]sx?$/.test(normalized)
    || /\.helpers?\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(?:fixture|fixtures|mock|mocks|stub|stubs|harness|snapshot|snapshots)\.[cm]?[jt]sx?$/.test(normalized)
    || /(test|spec|tests)\.(java|kt|scala)$/.test(normalized)
    || /(tests?|spec)\.cs$/.test(normalized)
    || /tests?\.swift$/.test(normalized)
    || /_test\.dart$/.test(normalized);
}

// 查询点名了具体低价值文件（文件名或去扩展名 stem）时按合同保留该源码块。
function queryMentionsLowValueSourcePathExplicitly(normalizedPath, query) {
  if (!query) return false;
  const fileName = normalizedPath.split('/').at(-1) ?? '';
  if (fileName.length >= 5 && query.includes(fileName)) return true;
  const stem = fileName.replace(/\.[a-z0-9]+$/i, '');
  return stem.length >= 6 && query.includes(stem);
}

function readSourceBlock(projectRoot, filePath, nodes, outputBudget) {
  if (!filePath || filePath === '(unknown)') return null;
  const absolutePath = resolveProjectSourcePath(projectRoot, filePath);
  if (!absolutePath) return null;
  const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const windows = mergeLineWindows(nodes, sourceLines.length, outputBudget.gapThreshold);
  const sortedNodes = [...nodes].sort(compareNodeSpecificity);
  const primaryNode = sortedNodes.find(node => node.kind !== 'import' && node.kind !== 'export')
    ?? sortedNodes[0]
    ?? null;
  return {
    filePath,
    language: languageForFile(filePath, primaryNode),
    startLine: windows[0]?.start ?? primaryNode?.startLine ?? 1,
    endLine: windows.at(-1)?.end ?? primaryNode?.endLine ?? primaryNode?.startLine ?? 1,
    symbols: formatSourceBlockSymbols(nodes, outputBudget.maxSymbolsInFileHeader),
    content: formatSourceWindows(sourceLines, windows, { lineNumbers: false }),
    source: formatSourceWindows(sourceLines, windows),
    primaryNode,
  };
}

function resolveProjectSourcePath(projectRoot, filePath) {
  const rootPath = path.resolve(projectRoot);
  const absolutePath = path.resolve(rootPath, filePath);
  if (!isPathInside(rootPath, absolutePath) || !fs.existsSync(absolutePath)) return null;

  const realRootPath = safeRealpath(rootPath);
  const realAbsolutePath = safeRealpath(absolutePath);
  if (!realRootPath || !realAbsolutePath || !isPathInside(realRootPath, realAbsolutePath)) return null;
  return realAbsolutePath;
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (
    !relativePath.startsWith('..')
    && !path.isAbsolute(relativePath)
  );
}

function safeRealpath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return null;
    }
  }
}

function formatSourceBlockSymbols(nodes, maxSymbols = 10) {
  const symbols = unique(nodes
    .filter(node => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
    .map(node => `${node.name}(${node.kind})`));
  const headerCap = Math.max(1, Number.isFinite(maxSymbols) ? maxSymbols : 10);
  const shown = symbols.slice(0, headerCap);
  const omitted = symbols.length - shown.length;
  if (shown.length === 0) return '';
  return omitted > 0 ? `${shown.join(', ')}, +${omitted} more` : shown.join(', ');
}

function mergeLineWindows(nodes, lineCount, gapThreshold = 3) {
  const windows = nodes
    .map(node => ({
      start: Math.max(1, (node.startLine ?? 1) - 6),
      end: Math.min(lineCount, (node.endLine ?? node.startLine ?? 1) + 6),
    }))
    .filter(window => window.start <= window.end)
    .sort((a, b) => a.start - b.start);

  if (windows.length === 0) return [{ start: 1, end: Math.min(lineCount, 80) }];

  const merged = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + gapThreshold) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function formatSourceWindows(sourceLines, windows, options = {}) {
  const output = [];
  let previousEnd = 0;
  for (const window of windows) {
    if (previousEnd > 0 && window.start > previousEnd + 1) {
      output.push('');
      output.push('... (gap) ...');
      output.push('');
    }
    for (let lineNumber = window.start; lineNumber <= window.end; lineNumber += 1) {
      const line = sourceLines[lineNumber - 1] ?? '';
      output.push(options.lineNumbers === false ? line : `${lineNumber}\t${line}`);
    }
    previousEnd = window.end;
  }
  return output.join('\n');
}

function compareGeneratedFileOrder(a, b) {
  const aGenerated = isGeneratedFilePath(a.filePath) ? 1 : 0;
  const bGenerated = isGeneratedFilePath(b.filePath) ? 1 : 0;
  return aGenerated - bGenerated;
}

function isGeneratedFilePath(filePath) {
  if (typeof filePath !== 'string') return false;
  return OFFICIAL_GENERATED_FILE_PATTERNS.some(pattern => pattern.test(filePath));
}

function languageForFile(filePath, node = null) {
  if (node?.language && node.language !== 'unknown' && OFFICIAL_CODEGRAPH_LANGUAGES.has(node.language)) {
    return node.language;
  }
  if (/\.(ts|mts|cts)$/i.test(filePath)) return 'typescript';
  if (/\.tsx$/i.test(filePath)) return 'tsx';
  if (/\.(js|mjs|cjs)$/i.test(filePath)) return 'javascript';
  if (/\.jsx$/i.test(filePath)) return 'jsx';
  if (/\.kt$/i.test(filePath)) return 'kotlin';
  if (/\.xml$/i.test(filePath)) return 'xml';
  if (/\.html?$/i.test(filePath)) return 'html';
  if (/\.css$/i.test(filePath)) return 'css';
  if (/\.scss$/i.test(filePath)) return 'scss';
  if (/\.sass$/i.test(filePath)) return 'sass';
  if (/\.less$/i.test(filePath)) return 'less';
  if (/\.sql$/i.test(filePath)) return 'sql';
  if (/\.mdx?$/i.test(filePath)) return 'markdown';
  if (/\.json$/i.test(filePath)) return 'json';
  if (/\.ya?ml$/i.test(filePath)) return 'yaml';
  if (/\.(properties|props)$/i.test(filePath)) return 'properties';
  return 'unknown';
}

function summarizeOverlayCoverage(overlay) {
  const baseline = buildBaseline(overlay);
  return {
    typescriptFiles: overlay.typescript?.files?.length ?? 0,
    typescriptClasses: overlay.typescript?.classes?.length ?? 0,
    typescriptFunctions: overlay.typescript?.functions?.length ?? 0,
    typescriptInterfaces: overlay.typescript?.interfaces?.length ?? 0,
    typescriptTypeAliases: overlay.typescript?.types?.length ?? 0,
    typescriptConstants: overlay.typescript?.variables?.filter(variable => variable.isConst).length ?? 0,
    typescriptVariables: overlay.typescript?.variables?.filter(variable => !variable.isConst).length ?? 0,
    typescriptEnums: overlay.typescript?.enums?.length ?? 0,
    typescriptNamespaces: overlay.typescript?.namespaces?.length ?? 0,
    typescriptImports: overlay.typescript?.imports?.length ?? 0,
    typescriptExports: overlay.typescript?.exports?.length ?? 0,
    typescriptParameters: overlay.graph?.nodes?.filter(node => node.kind === 'parameter').length ?? 0,
    components: overlay.angular?.components?.length ?? 0,
    directives: overlay.angular?.directives?.length ?? 0,
    pipes: overlay.angular?.pipes?.length ?? 0,
    injectables: overlay.angular?.injectables?.length ?? 0,
    injectors: overlay.angular?.injectors?.length ?? 0,
    dynamicImports: overlay.angular?.dynamicImports?.length ?? 0,
    routes: overlay.angular?.routes?.length ?? 0,
    edgeFunctions: overlay.supabase?.edgeFunctions?.length ?? 0,
    migrations: overlay.supabase?.migrations?.length ?? 0,
    androidFiles: overlay.android?.files?.length ?? 0,
    androidKotlinClasses: overlay.android?.kotlinClasses?.length ?? 0,
    androidKotlinDataClasses: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.modifiers?.includes('data')).length,
    androidKotlinSealedClasses: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.modifiers?.includes('sealed')).length,
    androidKotlinInterfaces: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.classKind === 'interface').length,
    androidKotlinObjects: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.classKind === 'object' && !kotlinClass.isCompanionObject).length,
    androidKotlinCompanionObjects: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.isCompanionObject).length,
    androidKotlinEnums: overlay.android?.kotlinEnums?.length ?? 0,
    androidKotlinEnumMembers: (overlay.android?.kotlinEnums ?? [])
      .flatMap(kotlinEnum => kotlinEnum.members ?? []).length,
    androidKotlinImports: overlay.android?.kotlinImports?.length ?? 0,
    androidKotlinConstructors: overlay.android?.kotlinConstructors?.length ?? 0,
    androidKotlinProperties: overlay.android?.kotlinProperties?.length ?? 0,
    androidKotlinMethods: overlay.android?.kotlinMethods?.length ?? 0,
    androidKotlinFunctions: overlay.android?.kotlinFunctions?.length ?? 0,
    androidKotlinFunctionEdges: countGraphEdgesByRelation(overlay, 'android-kotlin-function'),
    androidKotlinCalls: overlay.android?.kotlinCalls?.length ?? 0,
    androidKotlinAnnotations: countAndroidKotlinAnnotations(overlay.android),
    androidManifestComponents: overlay.android?.manifestComponents?.length ?? 0,
    androidManifestPermissions: baseline.androidManifestPermissions,
    androidManifestUsesPermissionEdges: baseline.androidManifestUsesPermissionEdges,
    androidManifestQueries: baseline.androidManifestQueries,
    androidManifestQueryEdges: baseline.androidManifestQueryEdges,
    androidManifestComponentPermissions: baseline.androidManifestComponentPermissions,
    androidManifestComponentPermissionEdges: baseline.androidManifestComponentPermissionEdges,
    androidManifestIntentFilters: baseline.androidManifestIntentFilters,
    androidManifestIntentFilterActions: baseline.androidManifestIntentFilterActions,
    androidManifestIntentFilterActionEdges: baseline.androidManifestIntentFilterActionEdges,
    androidManifestIntentFilterCategories: baseline.androidManifestIntentFilterCategories,
    androidManifestIntentFilterCategoryEdges: baseline.androidManifestIntentFilterCategoryEdges,
    androidManifestIntentFilterData: baseline.androidManifestIntentFilterData,
    androidManifestIntentFilterDataEdges: baseline.androidManifestIntentFilterDataEdges,
    androidWidgetProviders: overlay.android?.widgetProviders?.length ?? 0,
    androidResourceReferences: overlay.android?.resourceReferences?.length ?? 0,
    androidKotlinResourceReferences: baseline.androidKotlinResourceReferences,
    androidKotlinResourceReferenceEdges: baseline.androidKotlinResourceReferenceEdges,
    hardRules: overlay.agentRules?.hardRules?.length ?? 0,
    context7Docs: overlay.context7?.documents?.length ?? 0,
    context7Categories: overlay.context7?.categories?.length ?? 0,
    context7CategoryDocEdges: baseline.context7CategoryDocEdges,
    context7RetrievalRoutes: overlay.context7?.retrievalRoutes?.length ?? 0,
    context7RetrievalPrimaryEdges: baseline.context7RetrievalPrimaryEdges,
    context7RetrievalSecondaryEdges: baseline.context7RetrievalSecondaryEdges,
    context7SourceMapRoutes: overlay.context7?.sourceMapRoutes?.length ?? 0,
    context7SourceMapDocEdges: baseline.context7SourceMapDocEdges,
    context7SourceMapSourceEdges: baseline.context7SourceMapSourceEdges,
    graphNodes: overlay.graph?.nodes?.length ?? 0,
    graphEdges: overlay.graph?.edges?.length ?? 0,
  };
}

function countGraphEdgesByRelation(overlay, relation) {
  return overlay.graph?.edges?.filter(edge => edge.metadata?.relation === relation).length ?? 0;
}

function countAndroidKotlinAnnotations(android) {
  return [
    ...(android?.kotlinClasses ?? []),
    ...(android?.kotlinEnums ?? []),
    ...(android?.kotlinConstructors ?? []),
    ...(android?.kotlinProperties ?? []),
    ...(android?.kotlinMethods ?? []),
  ].flatMap(item => item?.annotations ?? []).length;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isTestFile(filePath) {
  return typeof filePath === 'string'
    && (/(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(filePath)
      || /\.(test|spec)\.[a-z]+$/i.test(filePath));
}
