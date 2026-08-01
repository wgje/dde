#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildBaseline } = require('./lib/codegraph-overlay-baseline.cjs');
const {
  PROJECT_SEMANTIC_COVERAGE_CONTRACTS,
  RELATION_METADATA_CONTRACTS,
  ZERO_REASON_COUNTERS,
} = require('./lib/codegraph-overlay-contract-manifest.cjs');
const { assertDocsTransactionClean } = require('./lib/codegraph-overlay-stability.cjs');
const args = process.argv.slice(2);
const rootArgIndex = args.indexOf('--root');
const root = path.resolve(rootArgIndex >= 0 ? args[rootArgIndex + 1] : process.cwd());
const errors = [];
const MAX_GRAPH_ERRORS_PER_CATEGORY = 10;
const ISSUE_REGISTRY_ALLOWED_STATUSES = new Set([
  'open',
  'needs-repro',
  'implementation-fix',
  'doc-fix',
  'fixed',
  'doc-updated',
  'wont-fix',
]);
const ISSUE_REGISTRY_OPEN_STATUSES = new Set([
  'open',
  'needs-repro',
  'implementation-fix',
  'doc-fix',
]);
const ISSUE_REGISTRY_CLOSED_STATUSES = new Set([
  'fixed',
  'doc-updated',
  'wont-fix',
]);
const ISSUE_REGISTRY_REQUIRED_FIELDS = [
  'status',
  'reported_at',
  'reporter',
  'feature_scope',
  'query_surface',
  'query',
  'expected',
  'actual',
  'evidence',
  'freshness_checks',
  'likely_root_cause',
  'repair_target',
  'doc_update_needed',
  'verification_gate',
];
const ISSUE_REGISTRY_ALLOWED_FIELDS = new Set([
  ...ISSUE_REGISTRY_REQUIRED_FIELDS,
  'resolution_notes',
]);
const ISSUE_REGISTRY_REQUIRED_NESTED_FIELDS = {
  evidence: ['docs_contract', 'output_summary', 'log_guard'],
  freshness_checks: ['mcp_result', 'adapter_fallback_result', 'wrapper_stale', 'overlay_stale', 'transport_failure'],
};
const ISSUE_REGISTRY_ALLOWED_QUERY_SURFACES = new Set([
  'nanoflow_context_pack',
  'nanoflow_overlay_query',
  'adapter-context-cli',
  'adapter-doctor',
  'overlay-query-cli',
  'docs-validator',
  'log-guard',
  'mcp-smoke',
  'tool-discovery',
]);
const ISSUE_REGISTRY_ALLOWED_ROOT_CAUSES = new Set([
  'implementation-gap',
  'query-ranking',
  'source-ordering',
  'stale-wrapper',
  'stale-overlay',
  'transport',
  'tool-discovery',
  'docs-overpromise',
  'unknown',
]);
const ISSUE_REGISTRY_ALLOWED_REPAIR_TARGETS = new Set([
  'generator',
  'query-selection',
  'native-json',
  'native-markdown',
  'context-pack-wrapper',
  'log-guard',
  'docs',
  'tests',
]);
const ISSUE_REGISTRY_ALLOWED_DOC_UPDATE_VALUES = new Set(['yes', 'no', 'unknown']);
const ISSUE_REGISTRY_ALLOWED_FRESHNESS_VALUES = {
  mcp_result: new Set(['success', 'failed', 'not-available', 'not-run']),
  adapter_fallback_result: new Set(['success', 'failed', 'not-available', 'not-run']),
  wrapper_stale: new Set(['yes', 'no', 'unknown']),
  overlay_stale: new Set(['yes', 'no', 'unknown']),
  transport_failure: new Set(['yes', 'no', 'unknown']),
};
const VERIFICATION_GATE_COMMAND_PATTERN = /\b(?:npm|npx|node|pnpm|yarn|vitest|tsc|ng|powershell|pwsh)\b/;
const NON_CONCRETE_VERIFICATION_GATE_PATTERN = /^(?:`?)(?:todo|tbd|none|n\/a|na|manual|later|fixme)(?:`?)$/i;
const DEDUP_CONTRACT_MANIFEST_PATH = 'docs/codegraph-nanoflow-dedup-contract.json';
const DEDUP_CONTRACT_REQUIRED_GATES = [
  'npm run codegraph:overlay:docs:validate',
  'npm run codegraph:adapter:gate',
];
const DEDUP_CONTRACT_CONTEXT_PACK_SOURCE_PATH = 'scripts/codegraph-nanoflow-mcp-stdio.cjs';
const DEDUP_CONTRACT_REQUIRED_COVERED_CHILD_OWNERS = [
  ['TypeScript', 'collectTypeScript()', null, ['readTypeScriptStandardLibraryReferences', 'collectTypeScriptStandardLibraryDeclarations']],
  ['context-pack', 'contextPackSourceRankingQueryFor()', DEDUP_CONTRACT_CONTEXT_PACK_SOURCE_PATH,
    ['queryTokens', 'localizedContextPackQueryAliases']],
];
const DEDUP_CONTRACT_REQUIRED_HOTSPOTS = [
  ['collectTypeScript()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['buildNativeGraph()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['buildImportAliasIndex()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['buildExportTargetIndex()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['resolveReferenceNodeId()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['addTypeScriptCallableEdges()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['collectAndroid()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['readAndroidKotlinFileSymbols()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['readAndroidKotlinMethodCalls()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['resolveAndroidKotlinCallTarget()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['resolveAndroidKotlinTypeTarget()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['addAndroidKotlinTypeReferenceEdges()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['addAndroidKotlinOverrideEdges()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['addAndroidKotlinAnnotationEdges()', 'scripts/generate-codegraph-nanoflow-overlay.mjs'],
  ['queryOverlay()', 'scripts/query-codegraph-nanoflow-overlay.mjs'],
  ['scoreCandidate()', 'scripts/query-codegraph-nanoflow-overlay.mjs'],
  ['selectGraphResults()', 'scripts/query-codegraph-nanoflow-overlay.mjs'],
  ['formatStrictNativeMarkdown()', 'scripts/query-codegraph-nanoflow-overlay.mjs'],
  ['formatNativeMarkdown()', 'scripts/query-codegraph-nanoflow-overlay.mjs'],
  ['contextPackSourceRankingQueryFor()', 'scripts/codegraph-nanoflow-mcp-stdio.cjs'],
  ['sanitizeContextPackBaseMarkdownSections()', 'scripts/codegraph-nanoflow-mcp-stdio.cjs'],
];
const DEDUP_CONTRACT_SOURCE_CONDITIONAL_HOTSPOTS = [
  ['toNativeJsonFormatterResponse()', 'scripts/query-codegraph-nanoflow-overlay.mjs', 'toNativeJsonFormatterResponse'],
];
const DEDUP_CONTRACT_REQUIRED_HOTSPOT_FIELDS = [
  'status',
  'delegatedUpstreamOwner',
  'allowedPurpose',
  'forbiddenScope',
  'removalTrigger',
  'verificationGate',
  'capabilityCategory',
  'language',
  'sourceSymbols',
  'coveredChildSymbols',
  'nativeOwnedCapability',
  'nanoFlowOwnedCapability',
  'allowedRelations',
  'forbiddenGenericBehavior',
  'upstreamHookNeeded',
  'removalCandidateWhen',
  'lastVerifiedGate',
];
const DEDUP_CONTRACT_BOUNDARY_REQUIRED_FIELDS = [
  'duplicateBoundaryRole',
  'outputSurface',
  'extensionFieldPolicy',
];
const DEDUP_CONTRACT_ALLOWED_BOUNDARY_ROLES = new Set([
  'query-parsing',
  'candidate-ranking',
  'result-selection',
  'native-json-formatter',
  'native-markdown-formatter',
  'source-codeblock-selection',
  'context-pack-source-ordering',
  'context-pack-filter',
]);
const DEDUP_CONTRACT_ALLOWED_OUTPUT_SURFACES = new Set([
  'json',
  'contextJson',
  'nativeJson',
  'nativeMarkdown',
  'augmentedMarkdown',
]);
const DEDUP_CONTRACT_ALLOWED_EXTENSION_FIELD_POLICIES = new Set([
  'strict-native',
  'nanoflow-augmented',
]);
const DEDUP_CONTRACT_AUGMENTED_MARKDOWN_FORBIDDEN_SOURCE_TOKENS = [
  { token: 'formatStrictNativeMarkdown', kind: 'strict-native formatter token' },
  { token: 'strictNative', kind: 'strict-native formatter token' },
  { token: '## Code Context', kind: 'strict-native heading' },
  { token: '### Entry Points', kind: 'strict-native heading' },
  { token: '### Code', kind: 'strict-native heading' },
];
const DEDUP_CONTRACT_STRICT_NATIVE_MARKDOWN_FORBIDDEN_SOURCE_TOKENS = [
  ...['formatEdgeMetadata', 'formatNativeMarkdown', 'formatNanoFlowAugmentedMarkdown'].map(token => ({ token, kind: 'augmented formatter token' })),
  { token: '→', kind: 'augmented relationship separator' },
  { token: 'relation:', kind: 'NanoFlow metadata token' },
  { token: 'table:', kind: 'NanoFlow metadata token' },
  { token: 'writeOperation', kind: 'NanoFlow metadata token' },
];
const DEDUP_CONTRACT_ANDROID_KOTLIN_SOURCE_PATH = 'scripts/generate-codegraph-nanoflow-overlay.mjs';
const DEDUP_CONTRACT_TYPESCRIPT_SOURCE_PATH = 'scripts/generate-codegraph-nanoflow-overlay.mjs';
const DEDUP_CONTRACT_TYPESCRIPT_DISCOVERY_PATTERN =
  /\b(?:function|const|let|var)\s+((?:collectTypeScript(?:StandardLibrary[A-Za-z0-9_$]*)?|readTypeScriptStandardLibrary[A-Za-z0-9_$]*|buildNativeGraph|buildImportAliasIndex|buildExportTargetIndex|resolveReferenceNodeId|add(?:TypeScript|Import|TypeReference|LocalDeclaration|Parameter|ValueReference|JsxReference|InterfaceImplementation|MemberSemantic)[A-Za-z0-9_$]*|readImport[A-Za-z0-9_$]*|readExport[A-Za-z0-9_$]*|readCall[A-Za-z0-9_$]*|resolveImported[A-Za-z0-9_$]*|resolveNamespaceImport[A-Za-z0-9_$]*))\b/g;
const PROJECT_SEMANTIC_DOC_COUNTERS = [
  'angularComponents',
  'angularDirectives',
  'angularPipes',
  'angularInjectables',
  'angularInjectorFiles',
  'angularInjectorDependencyReferences',
  'angularApplicationProviders',
  'standaloneImportEdges',
  'angularInputEdges',
  'angularOutputEdges',
  'angularModelEdges',
  'angularQueryEdges',
  'angularSignalEdges',
  'context7Documents',
  'context7Categories',
  'context7CategoryDocEdges',
  'context7RetrievalRoutes',
  'context7RetrievalPrimaryEdges',
  'context7RetrievalSecondaryEdges',
  'context7SourceMapRoutes',
  'context7SourceMapDocEdges',
  'context7SourceMapSourceEdges',
];
const DEDUP_CONTRACT_ANDROID_KOTLIN_DISCOVERY_PATTERN =
  /\b(?:function|const|let|var)\s+(collectAndroid|readAndroidKotlin[A-Za-z0-9_$]*|resolveAndroidKotlin[A-Za-z0-9_$]*|addAndroidKotlin[A-Za-z0-9_$]*)\b/g;
const DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH = 'scripts/query-codegraph-nanoflow-overlay.mjs';
const DEDUP_CONTRACT_QUERY_FORMATTER_DISCOVERY_PATTERN =
  /\b(?:function|const|let|var)\s+((?:queryOverlay|queryScoringContext|scoreCandidate|scoreNanoFlowSemanticCandidate|scoreGraphNode|scoreNodeRelevanceForQuery|scorePathSegmentCoverage|scoreNativeProjection[A-Za-z0-9_$]*|scorePreferredSourceFileGroupForQuery|scoreSourceFileGroupForQuery|rankNodesForQuery|orderRelatedFilesForQuery|compareCandidateRank|compareExactRelationEdgeDisplayOrder|compareNodeSpecificity|compareNode|compareEdge|compareSyncBodyKeywordEndpointPriority|compareSyncConfigKeywordEndpointPriority|compareExplicitPathCodeBlockCandidate|compareExactRelationEdgeSourceOrder|compareNodeSourceOrder|compareGeneratedFileOrder|selectEntryPoints|selectAngularSemanticApiEdges|selectNodeForCandidateMatch|selectedContext7RetrievalRouteIds|sortAngularSemanticApiEdgesForSelection|sortExactRelationEdgesForSelection|orderNativeProjectionItems|compareNativeProjectionRelevance|lowInformation(?:Node|File)Penalty|queryAllowsTestFiles|isLowInformationTestFilePath|focusedExplicitPathCodeBlockFilePaths|explicitPathNativeCodeBlockNodes|exactRelationEndpointCodeBlockNodes|prioritizeExactRelationCodeBlockEdges|resolveNativeCodeBlockNode|format(?:NativeMarkdown|NanoFlowAugmentedMarkdown|StrictNative(?:Markdown|RelatedSymbol|Location|FilePath|EdgeLocation)|EdgeSource|Summary|InlineFileList|EdgeMetadata|MatchSummary)|build(?:GraphIndexes|BlastRadiusEntries|NotShownEntries|RelationshipGroups|StrictNativeMarkdownRelationshipGroups|NativeCodeBlocks|ExactRelationEdgeCodeBlocks|ProvenanceEdgeLineCodeBlocks(?:ForQuery)?|SourceBlocks)|capRelationshipGroups|filterRelationshipGroupsForMarkdown|exactMetadataQuer(?:y|ies)From(?:Terms|Edges)|edgeMatches(?:ExactMetadataQuery|QueryTermsWithEndpoints|AnyQueryTermWithEndpoints)|suppressed(?:ExactRelationEntryPointIds|NativeCodeBlockNodeIds|ExactRelationCodeBlockEndpointIds)|strictNative(?:CodeBlockBudgetReached|EdgeEndpointName)|shouldSuppress(?:BroadNativeCodeBlock|LocalEvidenceEndpointForOwnerPreferredRelation)|compare(?:StrictNativeMarkdownEdges|StrictNativeRelatedNodeOrder|ExactRelationEdgeCodeBlockOrder|ProvenanceEdgeLineCodeBlockOrder|NativeCodeBlockNodeOrder|NullableSourceLine)|toNativeJsonFormatterResponse|serializeNativeJson(?:Node|Edge|CodeBlock)|nativeJsonEdge(?:Line|Column)|pushNativeCodeBlock(?:WithinNativeBudget)?|read(?:NodeCodeBlock|EdgeLineCodeBlock|SourceBlock)[A-Za-z0-9_$]*|formatSourceBlockSymbols|truncateMarkdownOutput|groupMarkdownRelatedNodesByFile|formatSourceWindows|selectNanoFlowRelationGraphResults|expandExactRelationEdges|markdownRelatedSymbolKey))\b/g;
const DEDUP_CONTRACT_CONTEXT_PACK_DISCOVERY_PATTERN =
  /\b(?:function|const|let|var)\s+((?:rankContextPack[A-Za-z0-9_$]*|scoreContextPack[A-Za-z0-9_$]*|prioritizeContextPack[A-Za-z0-9_$]*Source[A-Za-z0-9_$]*|filterContextPack[A-Za-z0-9_$]*Source[A-Za-z0-9_$]*|shouldFilterContextPack[A-Za-z0-9_$]*Source[A-Za-z0-9_$]*|hasAvoidableLowValueContextPack[A-Za-z0-9_$]*Source[A-Za-z0-9_$]*|buildContextPack(?:OverlaySourceBlocks|SourceBlock|RelationshipLines[A-Za-z0-9_$]*|RelatedSymbolLines|NodesByName|QueryPlan)|injectContextPackOverlaySourceBlocks|removeContextPackSourceBlockChunks|(?:split|join|find|append|select|merge)ContextPack[A-Za-z0-9_$]*SourceBlock[A-Za-z0-9_$]*|selectContextPackDiagnostic[A-Za-z0-9_$]*|shouldIncludeContextPackOverlaySourceBlock|formatNanoFlowContextPackAsMarkdown|escapeContextPackRegExp|matchesContextPackMarkdownSectionHeading|isContextPackMajorMarkdownHeading|normalizeContextPackInsertedSectionLines|insertContextPack(?:SectionContent|RelationshipContent|Text)|contextPack(?:RelationshipSubsectionKind|SectionEndIndex|ContentEndBeforeTrailingBlanks|RelationshipSubsectionEnd|RequestedRelationEndpointPaths|QueryRequestsOverlayRelation)|countContextPack(?:RelationshipKindSections|SourceSections|MarkdownSectionHeadings)|duplicateContextPackRelationshipKindSectionCount|trimContextPackBlankLines|splitContextPackRelationshipLineGroups|findContextPackRelationshipSubsection|normalizeContextPackFileBudget|limitContextPack(?:OverlayEvidence|MarkdownSourceFiles)|is(?:Pure|WeakExplicit)NoHitContextPack|isOpaqueNoHitProbeTerm|groupContextPackSourceEvidenceByFile|isSameContextPackSourceEvidence|classifyContextPackBaseMarkdownHeading|recordContextPackBaseSectionFilteredLine|contextPack(?:ExploreQueryFor|RawQueryTerms|Diagnostic[A-Za-z0-9_$]*|TopRanked[A-Za-z0-9_$]*|NodeMatchesQueryTerms|BaseSourceFilterRelationQueries|BaseMetadata[A-Za-z0-9_$]*|BaseTextContains(?:Lifecycle|FocusedNode)Evidence|SourceBlockPriority|SourceBlockHas[A-Za-z0-9_$]*Evidence|SourceChunkContains(?:Line|FocusedLine)|SourceEntryHas[A-Za-z0-9_$]*SymbolEvidence|SourceEvidenceNodesForOverlay|SourceSelection[A-Za-z0-9_$]*|SourceFileRank|SourceOrdering[A-Za-z0-9_$]*|RelationshipNode(?:QueryScore|Penalty)|RelatedNodeLowValuePenalty|SourceFileLowValuePenalty)|isExactRelationQueryTerm|summarizeContextPack(?:SourceOrdering|SourceSelection|MarkdownText|QueryClassification|TopRanked[A-Za-z0-9_$]*)|classifyCodegraphDedupMaintenanceQuery|extractContextPack(?:BaseRelationshipSymbols|SourceBlockFiles?|SourceBlockFile)|sortRelationshipEdgesForMarkdown|filterRelationshipEdgesForMarkdown|shouldShowContextPackRelationshipEdge|groupMarkdownRelatedNodesByFile|buildRelationshipGroupsFromMatches|markdownRelatedSymbolKey|compareRelatedGraphNodeOrder|compareGraphNode(?:SourceOrder)?|relationshipEdgeSourceOrder|mergeContextPack(?:FileScore|LineWindows|WindowRanges)|appendContextPackSourceEvidence|expandQueryTokenAliases|queryTokens|localizedContextPackQueryAliases|scorePath(?:TermMatch|SegmentCoverage)|format(?:EdgeMetadata|MatchSummary)|queryMentionsCodegraph(?:ToolingSourcePollution|DedupMaintenance)|queryExplicitlyRequestsContextPackSourcePath|isRenderableContextPackSourcePath|isLowValueContextPackSourcePath|isCodegraphDedupMaintenanceSourcePath))\b/g;
const STRICT_NATIVE_SOURCE_EVIDENCE_REQUIRED_TERMS = [
  'strict native source evidence contract',
  'relation-only codeBlocks',
  'migration-index',
  'migration-constraint',
  'migration-constraint-validation',
  'complete SQL statement',
  'policy-using',
  'policy-with-check',
  'CREATE POLICY',
  'owner method',
  'matchedNeedle',
  'source-first',
  'synthetic endpoints',
  'code block budget',
  'host-attribute',
  'host-binding',
  'host-listener',
  'edge-line',
  'nodeName',
  'edge-function-header',
  'req.headers.get(...)',
  'helper function',
  'template-url',
  'style-url',
  'resource',
  'supabase-realtime-remove-channel',
  'supabase-realtime-unsubscribe',
  'supabase-realtime-remove-all-channels',
];
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
  'properties',
  'unknown',
]);
const OFFICIAL_CODEGRAPH_NODE_KINDS = new Set([
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
]);
const OFFICIAL_CODEGRAPH_EDGE_KINDS = new Set([
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
]);
const OVERLAY_EXCLUDED_DIRS = new Set([
  '.angular',
  '.cache',
  '.codegraph',
  '.git',
  '.tmp',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'dist-ssr',
  'node_modules',
  'playwright-report',
  'test-results',
  'tmp',
]);
const MIGRATION_FILE_SOURCE_RELATIONS = new Set([
  'table',
  'migration-constraint',
  'migration-constraint-validation',
  'migration-index',
  'migration-realtime-publication',
  'migration-rls',
  'migration-view',
  'policy-command',
  'policy-role',
  'policy-type',
  'policy-using',
  'policy-with-check',
  'privilege-grant',
  'privilege-object',
  'privilege-revoke',
  'privilege-role',
  'sql-function',
  'trigger-function',
]);
const REGISTERED_RELATIONS = new Set([
  'agent-instruction',
  'android-kotlin-annotation',
  'android-kotlin-class',
  'android-kotlin-call',
  'android-kotlin-companion-object',
  'android-kotlin-constructor',
  'android-kotlin-enum',
  'android-kotlin-enum-member',
  'android-kotlin-extends',
  'android-kotlin-function',
  'android-kotlin-implements',
  'android-kotlin-import',
  'android-kotlin-interface',
  'android-kotlin-method',
  'android-kotlin-object',
  'android-kotlin-override',
  'android-kotlin-property',
  'android-kotlin-resource-reference',
  'android-kotlin-source',
  'android-kotlin-type-reference',
  'android-manifest',
  'android-manifest-component',
  'android-manifest-component-permission',
  'android-manifest-intent-filter-action',
  'android-manifest-intent-filter-category',
  'android-manifest-intent-filter-data',
  'android-manifest-intent-filter-value',
  'android-manifest-permission',
  'android-manifest-query',
  'android-manifest-uses-permission',
  'android-resource-file',
  'android-resource-reference',
  'android-widget-provider',
  'angular-app-config',
  'angular-app-provider',
  'angular-route-guard',
  'angular-route-provider',
  'angular-route-redirect',
  'angular-route-resolver',
  'call',
  'class-member',
  'commonjs-export',
  'commonjs-require',
  'config-property',
  'config-source',
  'context7-category',
  'context7-category-doc',
  'context7-doc',
  'context7-retrieval-primary',
  'context7-retrieval-route',
  'context7-retrieval-secondary',
  'context7-source-map-doc',
  'context7-source-map-route',
  'context7-source-map-source',
  'context7-source-path',
  'decorator',
  'decorator-argument',
  'dependency',
  'dynamic-import',
  'dynamic-import-file',
  'dynamic-import-target',
  'edge-function-header',
  'edge-function-invoke',
  'edge-function-method',
  'edge-function-route',
  'edge-function-source',
  'enum-member',
  'env-var',
  'export',
  'export-file',
  'extends',
  'external-reference',
  'file-symbol',
  'hard-rule',
  'hard-rule-implementation',
  'hard-rule-keyword',
  'hard-rule-test-evidence',
  'host-attribute',
  'host-binding',
  'host-listener',
  'implements',
  'import',
  'initializer-reference',
  'injector-file',
  'input',
  'interface-member',
  'local-declaration',
  'local-variable-type',
  'migration-constraint',
  'migration-constraint-validation',
  'migration-index',
  'migration-realtime-publication',
  'migration-rls',
  'migration-view',
  'namespace-member',
  'nested-function',
  'new',
  'object-function',
  'output',
  'override',
  'parameter',
  'parameter-type',
  'pipe-name',
  'policy',
  'policy-command',
  'policy-role',
  'policy-type',
  'policy-using',
  'policy-with-check',
  'privilege',
  'privilege-grant',
  'privilege-object',
  'privilege-revoke',
  'privilege-role',
  'providedIn',
  'provider',
  'query',
  're-export',
  're-export-file',
  'return-type',
  'risk-tag',
  'route',
  'signal',
  'source-file',
  'sql-function',
  'standalone-import',
  'style-url',
  'supabase-incremental-predicate',
  'supabase-realtime-channel',
  'supabase-realtime-postgres-change',
  'supabase-realtime-remove-all-channels',
  'supabase-realtime-remove-channel',
  'supabase-realtime-status',
  'supabase-realtime-unsubscribe',
  'supabase-rpc',
  'supabase-select-field',
  'supabase-storage-bucket',
  'supabase-table-write',
  'sync-config-source',
  'sync-required-field',
  'sync-required-predicate',
  'sync-rule',
  'sync-rule-keyword',
  'table',
  'template-binding',
  'template-component',
  'template-directive',
  'template-pipe',
  'template-url',
  'test',
  'trigger',
  'trigger-function',
  'type-literal-member',
  'type-parameter-constraint',
  'type-parameter-default',
  'type-reference',
]);
const REGISTERED_TEST_MAPPINGS = new Set([
  'class-reference',
  'filename-reference',
  'invoke-reference',
  'path-reference',
  'route-reference',
  'same-basename',
]);
const TEST_MAPPINGS_REQUIRING_MATCHED_NEEDLE = new Set([
  'filename-reference',
  'invoke-reference',
  'path-reference',
  'route-reference',
]);
const REGISTERED_KEYWORD_MAPPINGS = new Set([
  'hard-rule-keyword',
  'sync-body-keyword',
  'sync-config-keyword',
]);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

let packageScriptsCache;
function getPackageScripts() {
  if (packageScriptsCache !== undefined) return packageScriptsCache;
  try {
    packageScriptsCache = readJson('package.json').scripts ?? {};
  } catch {
    packageScriptsCache = {};
  }
  return packageScriptsCache;
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

function readFirstNumber(text, pattern, label, file) {
  const match = pattern.exec(text);
  if (!match) {
    errors.push(`${file} missing ${label}`);
    return null;
  }
  return Number(match[1].replace(/,/g, ''));
}

function readInlineCounter(text, label) {
  const match = new RegExp(`${escapeRegex(label)}=([\\d,]+)`).exec(text);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function readInlineCounters(text, labels) {
  const values = {};
  for (const label of labels) {
    const value = readInlineCounter(text, label);
    if (value === null) return null;
    values[label] = value;
  }
  return values;
}

function expectNumber(file, label, expected, actual) {
  if (actual === null) return;
  if (actual !== expected) {
    errors.push(`${file} ${label} expected ${expected}, found ${actual}`);
  }
}

function expectEveryNumber(file, label, expected, text, pattern) {
  for (const match of text.matchAll(pattern)) {
    expectNumber(file, label, expected, Number(match[1].replace(/,/g, '')));
  }
}

function recordGraphError(counts, category, message) {
  const count = counts.get(category) ?? 0;
  if (count < MAX_GRAPH_ERRORS_PER_CATEGORY) {
    errors.push(`overlay graph ${message}`);
  } else if (count === MAX_GRAPH_ERRORS_PER_CATEGORY) {
    errors.push(`overlay graph ${category} has more errors; further entries omitted`);
  }
  counts.set(category, count + 1);
}

function validateOverlayGraphShape(overlay) {
  const graph = overlay.graph ?? {};
  const graphNodes = graph.nodes;
  const graphEdges = graph.edges;
  if (!Array.isArray(graphNodes)) {
    errors.push('overlay graph nodes must be an array');
    return;
  }
  if (!Array.isArray(graphEdges)) {
    errors.push('overlay graph edges must be an array');
    return;
  }

  const graphErrorCounts = new Map();
  const nodesById = new Map();
  for (let index = 0; index < graphNodes.length; index += 1) {
    const node = graphNodes[index];
    const nodeId = typeof node?.id === 'string' && node.id.length > 0 ? node.id : null;
    const label = nodeId ?? `node[${index}]`;
    if (!nodeId) {
      recordGraphError(graphErrorCounts, 'node-id', `${label} is missing a non-empty id`);
    } else if (nodesById.has(nodeId)) {
      recordGraphError(graphErrorCounts, 'node-id', `has duplicate node id ${nodeId}`);
    } else {
      nodesById.set(nodeId, node);
    }

    validateOverlayNodeShape(node, label, graphErrorCounts);
  }

  for (let index = 0; index < graphEdges.length; index += 1) {
    validateOverlayEdgeShape(graphEdges[index], index, nodesById, graphErrorCounts);
  }
}

function validateOverlayNodeShape(node, label, graphErrorCounts) {
  if (!OFFICIAL_CODEGRAPH_NODE_KINDS.has(node?.kind)) {
    recordGraphError(graphErrorCounts, 'node-kind', `${label} has non-native node kind ${String(node?.kind)}`);
  }
  if (typeof node?.name !== 'string' || node.name.length === 0) {
    recordGraphError(graphErrorCounts, 'node-name', `${label} is missing a non-empty name`);
  }
  if (typeof node?.qualifiedName !== 'string' || node.qualifiedName.length === 0) {
    recordGraphError(graphErrorCounts, 'node-qualified-name', `${label} is missing a non-empty qualifiedName`);
  }
  if (node?.language !== undefined && !OFFICIAL_CODEGRAPH_LANGUAGES.has(node.language)) {
    recordGraphError(graphErrorCounts, 'node-language', `${label} has non-native language ${String(node.language)}`);
  }
  validateOverlayNodeLocation(node, label, graphErrorCounts);
  validateOverlayNodePath(node, label, graphErrorCounts);
  validateRegisteredRelation(node?.metadata?.relation);
}

function validateOverlayNodeLocation(node, label, graphErrorCounts) {
  const startLine = node?.startLine;
  const endLine = node?.endLine;
  const startColumn = node?.startColumn;
  const endColumn = node?.endColumn;
  if (!Number.isInteger(startLine) || startLine < 1) {
    recordGraphError(graphErrorCounts, 'node-location', `${label} has invalid startLine ${String(startLine)}`);
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    recordGraphError(graphErrorCounts, 'node-location', `${label} has invalid endLine ${String(endLine)}`);
  }
  if (!Number.isInteger(startColumn) || startColumn < 0) {
    recordGraphError(graphErrorCounts, 'node-location', `${label} has invalid startColumn ${String(startColumn)}`);
  }
  if (!Number.isInteger(endColumn) || endColumn < 0) {
    recordGraphError(graphErrorCounts, 'node-location', `${label} has invalid endColumn ${String(endColumn)}`);
  }
}

function validateOverlayNodePath(node, label, graphErrorCounts) {
  const filePath = node?.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    recordGraphError(graphErrorCounts, 'node-file-path', `${label} is missing a non-empty filePath`);
    return;
  }

  const normalized = normalizeOverlayFilePath(filePath);
  if (isAbsoluteOverlayPath(filePath) || normalized.startsWith('../') || normalized.includes('/../')) {
    recordGraphError(graphErrorCounts, 'node-file-path', `${label} has non-project filePath ${filePath}`);
    return;
  }

  const pathSegments = normalized.split('/').filter(Boolean);
  const excludedSegment = pathSegments.find(segment => OVERLAY_EXCLUDED_DIRS.has(segment));
  if (excludedSegment) {
    recordGraphError(graphErrorCounts, 'node-file-path', `${label} points into excluded directory ${excludedSegment}: ${filePath}`);
  }
}

function validateOverlayEdgeShape(edge, index, nodesById, graphErrorCounts) {
  const label = `edge[${index}]`;
  if (!OFFICIAL_CODEGRAPH_EDGE_KINDS.has(edge?.kind)) {
    recordGraphError(graphErrorCounts, 'edge-kind', `${label} has non-native edge kind ${String(edge?.kind)}`);
  }
  if (!nodesById.has(edge?.source)) {
    recordGraphError(graphErrorCounts, 'edge-endpoint', `${label} has missing source endpoint ${String(edge?.source)}`);
  }
  if (!nodesById.has(edge?.target)) {
    recordGraphError(graphErrorCounts, 'edge-endpoint', `${label} has missing target endpoint ${String(edge?.target)}`);
  }

  const relation = edge?.metadata?.relation;
  validateRegisteredRelation(relation);
  validateOverlayEdgeMetadata(edge);
  if (MIGRATION_FILE_SOURCE_RELATIONS.has(relation)) {
    const source = nodesById.get(edge.source);
    if (source?.kind !== 'file') {
      recordGraphError(
        graphErrorCounts,
        'migration-source',
        `${label} relation ${relation} must start from a migration file node, found ${String(source?.kind)}`,
      );
    }
  }
  if (relation === 'table') {
    validateMigrationTableTarget(edge, label, nodesById, graphErrorCounts);
  }
}

function validateMigrationTableTarget(edge, label, nodesById, graphErrorCounts) {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  const sourceFilePath = normalizeOverlayFilePath(source?.filePath);
  const targetIsMigrationTable = (
    source?.kind === 'file'
    && sourceFilePath.startsWith('supabase/migrations/')
    && sourceFilePath.endsWith('.sql')
    && target?.kind === 'variable'
    && target?.metadata?.relation === 'table'
    && normalizeOverlayFilePath(target?.filePath) === sourceFilePath
  );
  if (!targetIsMigrationTable) {
    recordGraphError(
      graphErrorCounts,
      'migration-table-target',
      `${label} relation table from ${sourceFilePath || String(edge.source)} must target a SQL table node in the same migration`,
    );
  }
}

function validateRegisteredRelation(relation) {
  if (relation === undefined) return;
  if (!REGISTERED_RELATIONS.has(relation)) {
    errors.push(`relation ${String(relation)} is not registered`);
  }
}

function validateOverlayEdgeMetadata(edge) {
  const metadata = edge?.metadata ?? {};
  for (const contract of RELATION_METADATA_CONTRACTS) {
    if (metadata.relation !== contract.relation) continue;
    for (const field of contract.requiredMetadata) {
      if (metadata[field] === undefined || metadata[field] === null || metadata[field] === '') {
        errors.push(`relation ${contract.relation} missing metadata.${field}`);
      }
    }
    if (Array.isArray(contract.requiredAnyMetadata) && !contract.requiredAnyMetadata.some(field => (
      metadata[field] !== undefined && metadata[field] !== null && metadata[field] !== ''
    ))) {
      errors.push(
        `relation ${contract.relation} missing one of ${contract.requiredAnyMetadata.map(field => `metadata.${field}`).join(', ')}`,
      );
    }
  }

  const testMapping = metadata.testMapping;
  if (testMapping !== undefined) {
    if (!REGISTERED_TEST_MAPPINGS.has(testMapping)) {
      errors.push(`testMapping ${String(testMapping)} is not registered`);
    } else if (TEST_MAPPINGS_REQUIRING_MATCHED_NEEDLE.has(testMapping) && !metadata.matchedNeedle) {
      errors.push(`testMapping ${testMapping} missing metadata.matchedNeedle`);
    }
  }

  const keywordMapping = metadata.keywordMapping;
  if (keywordMapping !== undefined && !REGISTERED_KEYWORD_MAPPINGS.has(keywordMapping)) {
    errors.push(`keywordMapping ${String(keywordMapping)} is not registered`);
  }
}

function validateProjectSemanticCoverageContract(baseline) {
  if (!Array.isArray(PROJECT_SEMANTIC_COVERAGE_CONTRACTS)) {
    errors.push('project semantic coverage contract must be an array');
    return;
  }

  for (const [index, contract] of PROJECT_SEMANTIC_COVERAGE_CONTRACTS.entries()) {
    const domain = String(contract?.domain ?? '').trim();
    if (!domain) {
      errors.push(`project semantic coverage contract[${index}] missing domain`);
    }

    if (!Array.isArray(contract?.counters) || contract.counters.length === 0) {
      errors.push(`project semantic coverage ${domain || `contract[${index}]`} missing counters`);
      continue;
    }

    for (const counter of contract.counters) {
      const label = String(counter ?? '').trim();
      if (!label) {
        errors.push(`project semantic coverage ${domain || `contract[${index}]`} has an empty counter`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(baseline, label)) {
        errors.push(`project semantic coverage ${domain || `contract[${index}]`} references missing baseline counter ${label}`);
        continue;
      }

      const value = baseline[label];
      if (!Number.isFinite(value)) {
        errors.push(`project semantic coverage ${domain || `contract[${index}]`} counter ${label} is not numeric`);
      } else if (value === 0 && !ZERO_REASON_COUNTERS.has(label)) {
        errors.push(`project semantic coverage ${domain || `contract[${index}]`} requires ${label} > 0`);
      }
    }
  }
}

function normalizeOverlayFilePath(filePath) {
  return String(filePath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

function isAbsoluteOverlayPath(filePath) {
  const normalized = normalizeOverlayFilePath(filePath);
  return path.isAbsolute(filePath) || path.posix.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized);
}
function validateAgents(text, baseline) {
  const file = 'AGENTS.md';
  for (const [label, expected] of Object.entries(baseline)) {
    if (label === 'graphNodes' || label === 'graphEdges') {
      continue;
    }
    const actual = readFirstNumber(text, new RegExp(`${escapeRegex(label)}=(\\d+)`), label, file);
    expectNumber(file, label, expected, actual);
  }
  validateSourceOrderingDiagnostics(text, file);
  validateMcpLogGuardDiagnostics(text, file);
  validateQueryPathRelevanceContract(text, file);
  validateStrictNativeOutputOrderContract(text, file);
  validateStrictNativeObjectProjectionContract(text, file);
  validateStrictNativeSourceEvidenceContract(text, file);
  validateAdapterGateContract(text, file);
  validateAdapterFirstFallbackContract(text, file);
  validateUpstreamCodeGraphBoundaryContract(text, file);
  validateCodexMcpConfigContract(text, file);
  validateSingleSharedTreeFreshnessContract(text, file);
}

function validateAdaptationDoc(text, baseline) {
  const file = 'docs/codegraph-nanoflow-adaptation.md';
  validateSourceOrderingDiagnostics(text, file);
  validateMcpLogGuardDiagnostics(text, file);
  validateQueryPathRelevanceContract(text, file);
  validateStrictNativeOutputOrderContract(text, file);
  validateStrictNativeObjectProjectionContract(text, file);
  validateStrictNativeSourceEvidenceContract(text, file);
  validateAdapterGateContract(text, file);
  validateAdapterFirstFallbackContract(text, file);
  validateUpstreamCodeGraphBoundaryContract(text, file);
  validateCodexMcpConfigContract(text, file);
  validateSingleSharedTreeFreshnessContract(text, file);
  validateLocalCodeGraphSourceSetup(text, file);
  for (const label of PROJECT_SEMANTIC_DOC_COUNTERS) {
    const actual = readFirstNumber(text, new RegExp(`${escapeRegex(label)}=(\\d+)`), label, file);
    expectNumber(file, label, baseline[label], actual);
  }
  const graphMatch = /([\d,]+)\s+graph nodes and\s+([\d,]+)\s+graph edges/.exec(text);
  if (!graphMatch) {
    errors.push(`${file} missing graph projection summary`);
  }

  const routeMatch = /(\d+)\s+dynamic import entries,\s+(\d+)\s+dynamic import graph edges, and\s+(\d+)\s+Angular route/.exec(text);
  if (!routeMatch) {
    errors.push(`${file} missing Angular dynamic import/route summary`);
  } else {
    expectNumber(file, 'dynamicImports', baseline.dynamicImports, Number(routeMatch[1]));
    expectNumber(file, 'dynamicImportEdges', baseline.dynamicImportEdges, Number(routeMatch[2]));
    expectNumber(file, 'angularRoutes', baseline.angularRoutes, Number(routeMatch[3]));
  }

  const routeSemanticMatch = /([\d,]+)\s+`?angular-route-guard`?\s+edges[\s\S]*?([\d,]+)\s+`?angular-route-resolver`?\s+edges[\s\S]*?([\d,]+)\s+`?angular-route-redirect`?\s+edges[\s\S]*?([\d,]+)\s+`?angular-route-provider`?\s+edges/.exec(text);
  if (!routeSemanticMatch) {
    errors.push(`${file} missing Angular route semantic summary`);
  } else {
    expectNumber(file, 'angularRouteGuardEdges', baseline.angularRouteGuardEdges, Number(routeSemanticMatch[1].replace(/,/g, '')));
    expectNumber(file, 'angularRouteResolverEdges', baseline.angularRouteResolverEdges, Number(routeSemanticMatch[2].replace(/,/g, '')));
    expectNumber(file, 'angularRouteRedirectEdges', baseline.angularRouteRedirectEdges, Number(routeSemanticMatch[3].replace(/,/g, '')));
    expectNumber(file, 'angularRouteProviderEdges', baseline.angularRouteProviderEdges, Number(routeSemanticMatch[4].replace(/,/g, '')));
  }

  const hostMatch = /([\d,]+)\s+host-directive edges[\s\S]*?([\d,]+)\s+host-attribute edges,\s+([\d,]+)\s+host-binding edges,\s+and\s+([\d,]+)\s+host-listener edges/.exec(text);
  if (!hostMatch) {
    errors.push(`${file} missing Angular host semantic summary`);
  } else {
    expectNumber(file, 'hostDirectiveEdges', baseline.hostDirectiveEdges, Number(hostMatch[1].replace(/,/g, '')));
    expectNumber(file, 'hostAttributeEdges', baseline.hostAttributeEdges, Number(hostMatch[2].replace(/,/g, '')));
    expectNumber(file, 'hostBindingEdges', baseline.hostBindingEdges, Number(hostMatch[3].replace(/,/g, '')));
    expectNumber(file, 'hostListenerEdges', baseline.hostListenerEdges, Number(hostMatch[4].replace(/,/g, '')));
  }

  const edgeFunctionMatch = /([\d,]+)\s+Supabase Edge Functions[\s\S]*?([\d,]+)\s+followed source\/helper files[\s\S]*?([\d,]+)\s+recorded source import\s+relations,\s+([\d,]+)\s+native\s+`?edge-function-source`?\s+import edges,\s+([\d,]+)\s+generated[\s\S]*?route nodes\/edges,\s+([\d,]+)\s+explicit\s+`?req\.method`?\s+method[\s\S]*?([\d,]+)\s+implementation-side\s+`?edge-function-invoke`?\s+edges,\s+and\s+([\d,]+)\s+native test-reference edges/.exec(text);
  if (!edgeFunctionMatch) {
    errors.push(`${file} missing Supabase Edge Function summary`);
  } else {
    expectNumber(file, 'edgeFunctions', baseline.edgeFunctions, Number(edgeFunctionMatch[1].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionSourceFiles', baseline.edgeFunctionSourceFiles, Number(edgeFunctionMatch[2].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionImports', baseline.edgeFunctionImports, Number(edgeFunctionMatch[3].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionSourceEdges', baseline.edgeFunctionSourceEdges, Number(edgeFunctionMatch[4].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionRouteEdges', baseline.edgeFunctionRouteEdges, Number(edgeFunctionMatch[5].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionMethodEdges', baseline.edgeFunctionMethodEdges, Number(edgeFunctionMatch[6].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionInvokeEdges', baseline.edgeFunctionInvokeEdges, Number(edgeFunctionMatch[7].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionTestEdges', baseline.edgeFunctionTestEdges, Number(edgeFunctionMatch[8].replace(/,/g, '')));
  }

  const edgeFunctionHeaderMatch = /adds\s+([\d,]+)\s+`?edge-function-header`?[\s\S]*?nodes and\s+([\d,]+)\s+native\s+`?references`?\s+edges/.exec(text);
  if (!edgeFunctionHeaderMatch) {
    errors.push(`${file} missing Supabase Edge Function header summary`);
  } else {
    expectNumber(file, 'edgeFunctionHeaderNodes', baseline.edgeFunctionHeaderNodes, Number(edgeFunctionHeaderMatch[1].replace(/,/g, '')));
    expectNumber(file, 'edgeFunctionHeaderEdges', baseline.edgeFunctionHeaderEdges, Number(edgeFunctionHeaderMatch[2].replace(/,/g, '')));
  }

  const androidKotlinMatch = /Android Kotlin member graph summary:\s+([\d,]+)\s+androidKotlinClasses,\s+([\d,]+)\s+androidKotlinDataClasses,\s+([\d,]+)\s+androidKotlinSealedClasses,\s+([\d,]+)\s+androidKotlinInterfaces,\s+([\d,]+)\s+androidKotlinInterfaceEdges,\s+([\d,]+)\s+androidKotlinExtendsEdges,\s+([\d,]+)\s+androidKotlinImplementsEdges,\s+([\d,]+)\s+androidKotlinObjects,\s+([\d,]+)\s+androidKotlinObjectEdges,\s+([\d,]+)\s+androidKotlinCompanionObjects,\s+([\d,]+)\s+androidKotlinCompanionObjectEdges,\s+([\d,]+)\s+androidKotlinEnums,\s+([\d,]+)\s+androidKotlinEnumMembers,\s+([\d,]+)\s+androidKotlinEnumMemberEdges,\s+([\d,]+)\s+androidKotlinImports,\s+([\d,]+)\s+androidKotlinImportEdges,\s+([\d,]+)\s+androidKotlinConstructors,\s+([\d,]+)\s+androidKotlinConstructorEdges,\s+([\d,]+)\s+androidKotlinProperties,\s+([\d,]+)\s+androidKotlinPropertyEdges,\s+([\d,]+)\s+androidKotlinMethods,\s+([\d,]+)\s+androidKotlinMethodEdges,\s+([\d,]+)\s+androidKotlinFunctions,\s+([\d,]+)\s+androidKotlinFunctionEdges,\s+([\d,]+)\s+androidKotlinOverrideEdges,\s+([\d,]+)\s+androidKotlinTypeReferenceEdges,\s+([\d,]+)\s+androidKotlinCalls,\s+([\d,]+)\s+androidKotlinCallEdges,\s+([\d,]+)\s+androidKotlinAnnotations,\s+and\s+([\d,]+)\s+androidKotlinAnnotationEdges/.exec(text);
  if (!androidKotlinMatch) {
    errors.push(`${file} missing Android Kotlin member graph summary`);
  } else {
    expectNumber(file, 'androidKotlinClasses', baseline.androidKotlinClasses, Number(androidKotlinMatch[1].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinDataClasses', baseline.androidKotlinDataClasses, Number(androidKotlinMatch[2].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinSealedClasses', baseline.androidKotlinSealedClasses, Number(androidKotlinMatch[3].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinInterfaces', baseline.androidKotlinInterfaces, Number(androidKotlinMatch[4].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinInterfaceEdges', baseline.androidKotlinInterfaceEdges, Number(androidKotlinMatch[5].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinExtendsEdges', baseline.androidKotlinExtendsEdges, Number(androidKotlinMatch[6].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinImplementsEdges', baseline.androidKotlinImplementsEdges, Number(androidKotlinMatch[7].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinObjects', baseline.androidKotlinObjects, Number(androidKotlinMatch[8].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinObjectEdges', baseline.androidKotlinObjectEdges, Number(androidKotlinMatch[9].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinCompanionObjects', baseline.androidKotlinCompanionObjects, Number(androidKotlinMatch[10].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinCompanionObjectEdges', baseline.androidKotlinCompanionObjectEdges, Number(androidKotlinMatch[11].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinEnums', baseline.androidKotlinEnums, Number(androidKotlinMatch[12].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinEnumMembers', baseline.androidKotlinEnumMembers, Number(androidKotlinMatch[13].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinEnumMemberEdges', baseline.androidKotlinEnumMemberEdges, Number(androidKotlinMatch[14].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinImports', baseline.androidKotlinImports, Number(androidKotlinMatch[15].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinImportEdges', baseline.androidKotlinImportEdges, Number(androidKotlinMatch[16].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinConstructors', baseline.androidKotlinConstructors, Number(androidKotlinMatch[17].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinConstructorEdges', baseline.androidKotlinConstructorEdges, Number(androidKotlinMatch[18].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinProperties', baseline.androidKotlinProperties, Number(androidKotlinMatch[19].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinPropertyEdges', baseline.androidKotlinPropertyEdges, Number(androidKotlinMatch[20].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinMethods', baseline.androidKotlinMethods, Number(androidKotlinMatch[21].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinMethodEdges', baseline.androidKotlinMethodEdges, Number(androidKotlinMatch[22].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinFunctions', baseline.androidKotlinFunctions, Number(androidKotlinMatch[23].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinFunctionEdges', baseline.androidKotlinFunctionEdges, Number(androidKotlinMatch[24].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinOverrideEdges', baseline.androidKotlinOverrideEdges, Number(androidKotlinMatch[25].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinTypeReferenceEdges', baseline.androidKotlinTypeReferenceEdges, Number(androidKotlinMatch[26].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinCalls', baseline.androidKotlinCalls, Number(androidKotlinMatch[27].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinCallEdges', baseline.androidKotlinCallEdges, Number(androidKotlinMatch[28].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinAnnotations', baseline.androidKotlinAnnotations, Number(androidKotlinMatch[29].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinAnnotationEdges', baseline.androidKotlinAnnotationEdges, Number(androidKotlinMatch[30].replace(/,/g, '')));
  }

  const androidPackagingMatch = /Android packaging\/resource graph summary:\s+([\d,]+)\s+androidManifestComponents,\s+([\d,]+)\s+androidManifestPermissions,\s+([\d,]+)\s+androidManifestUsesPermissionEdges,\s+([\d,]+)\s+androidManifestQueries,\s+([\d,]+)\s+androidManifestQueryEdges,\s+([\d,]+)\s+androidManifestComponentPermissions,\s+([\d,]+)\s+androidManifestComponentPermissionEdges,\s+([\d,]+)\s+androidManifestIntentFilters,\s+([\d,]+)\s+androidManifestIntentFilterActions,\s+([\d,]+)\s+androidManifestIntentFilterActionEdges,\s+([\d,]+)\s+androidManifestIntentFilterCategories,\s+([\d,]+)\s+androidManifestIntentFilterCategoryEdges,\s+([\d,]+)\s+androidManifestIntentFilterData,\s+([\d,]+)\s+androidManifestIntentFilterDataEdges,\s+([\d,]+)\s+androidWidgetProviders,\s+([\d,]+)\s+androidResourceReferences,\s+([\d,]+)\s+androidKotlinResourceReferences,\s+and\s+([\d,]+)\s+androidKotlinResourceReferenceEdges/.exec(text);
  if (!androidPackagingMatch) {
    errors.push(`${file} missing Android packaging/resource graph summary`);
  } else {
    expectNumber(file, 'androidManifestComponents', baseline.androidManifestComponents, Number(androidPackagingMatch[1].replace(/,/g, '')));
    expectNumber(file, 'androidManifestPermissions', baseline.androidManifestPermissions, Number(androidPackagingMatch[2].replace(/,/g, '')));
    expectNumber(file, 'androidManifestUsesPermissionEdges', baseline.androidManifestUsesPermissionEdges, Number(androidPackagingMatch[3].replace(/,/g, '')));
    expectNumber(file, 'androidManifestQueries', baseline.androidManifestQueries, Number(androidPackagingMatch[4].replace(/,/g, '')));
    expectNumber(file, 'androidManifestQueryEdges', baseline.androidManifestQueryEdges, Number(androidPackagingMatch[5].replace(/,/g, '')));
    expectNumber(file, 'androidManifestComponentPermissions', baseline.androidManifestComponentPermissions, Number(androidPackagingMatch[6].replace(/,/g, '')));
    expectNumber(file, 'androidManifestComponentPermissionEdges', baseline.androidManifestComponentPermissionEdges, Number(androidPackagingMatch[7].replace(/,/g, '')));
    expectNumber(file, 'androidManifestIntentFilters', baseline.androidManifestIntentFilters, Number(androidPackagingMatch[8].replace(/,/g, '')));
    expectNumber(file, 'androidManifestIntentFilterActions', baseline.androidManifestIntentFilterActions, Number(androidPackagingMatch[9].replace(/,/g, '')));
    expectNumber(file, 'androidManifestIntentFilterActionEdges', baseline.androidManifestIntentFilterActionEdges, Number(androidPackagingMatch[10].replace(/,/g, '')));
    expectNumber(file, 'androidManifestIntentFilterCategories', baseline.androidManifestIntentFilterCategories, Number(androidPackagingMatch[11].replace(/,/g, '')));
    expectNumber(file, 'androidManifestIntentFilterCategoryEdges', baseline.androidManifestIntentFilterCategoryEdges, Number(androidPackagingMatch[12].replace(/,/g, '')));
    expectNumber(file, 'androidManifestIntentFilterData', baseline.androidManifestIntentFilterData, Number(androidPackagingMatch[13].replace(/,/g, '')));
    expectNumber(file, 'androidManifestIntentFilterDataEdges', baseline.androidManifestIntentFilterDataEdges, Number(androidPackagingMatch[14].replace(/,/g, '')));
    expectNumber(file, 'androidWidgetProviders', baseline.androidWidgetProviders, Number(androidPackagingMatch[15].replace(/,/g, '')));
    expectNumber(file, 'androidResourceReferences', baseline.androidResourceReferences, Number(androidPackagingMatch[16].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinResourceReferences', baseline.androidKotlinResourceReferences, Number(androidPackagingMatch[17].replace(/,/g, '')));
    expectNumber(file, 'androidKotlinResourceReferenceEdges', baseline.androidKotlinResourceReferenceEdges, Number(androidPackagingMatch[18].replace(/,/g, '')));
  }

  const bindingMatch = /records\s+([\d,]+)\s+template\s+bindings:\s+([\d,]+)\s+property,\s+([\d,]+)\s+event,\s+([\d,]+)\s+interpolation,\s+([\d,]+)\s+model,\s+([\d,]+)\s+control-flow,\s+and\s+([\d,]+)\s+structural directive bindings/.exec(text);
  if (!bindingMatch) {
    errors.push(`${file} missing template binding summary`);
  } else {
    expectNumber(file, 'templateBindings', baseline.templateBindings, Number(bindingMatch[1].replace(/,/g, '')));
    expectNumber(file, 'property', baseline.property, Number(bindingMatch[2].replace(/,/g, '')));
    expectNumber(file, 'event', baseline.event, Number(bindingMatch[3].replace(/,/g, '')));
    expectNumber(file, 'interpolation', baseline.interpolation, Number(bindingMatch[4].replace(/,/g, '')));
    expectNumber(file, 'model', baseline.model, Number(bindingMatch[5].replace(/,/g, '')));
    expectNumber(file, 'control-flow', baseline['control-flow'], Number(bindingMatch[6].replace(/,/g, '')));
    expectNumber(file, 'structural', baseline.structural, Number(bindingMatch[7].replace(/,/g, '')));
  }

  const usageMatch = /adds\s+(\d+)\s+`template-component`\s+edges,\s+(\d+)\s+`template-directive`\s+edges[\s\S]*?and\s+(\d+)\s+`template-pipe`\s+edges/.exec(text);
  if (!usageMatch) {
    errors.push(`${file} missing template declaration usage summary`);
  } else {
    expectNumber(file, 'templateComponentEdges', baseline.templateComponentEdges, Number(usageMatch[1]));
    expectNumber(file, 'templateDirectiveEdges', baseline.templateDirectiveEdges, Number(usageMatch[2]));
    expectNumber(file, 'templatePipeEdges', baseline.templatePipeEdges, Number(usageMatch[3]));
  }

  const resourceMatch = /Angular external resource graph summary:\s+([\d,]+)\s+template-url edges and\s+([\d,]+)\s+style-url edges/.exec(text);
  if (!resourceMatch) {
    errors.push(`${file} missing Angular external resource summary`);
  } else {
    expectNumber(file, 'templateUrlEdges', baseline.templateUrlEdges, Number(resourceMatch[1].replace(/,/g, '')));
    expectNumber(file, 'styleUrlEdges', baseline.styleUrlEdges, Number(resourceMatch[2].replace(/,/g, '')));
  }

  const hardRuleAnchorMatch = /([\d,]+)\s+AGENTS hard-rule anchors/.exec(text);
  if (!hardRuleAnchorMatch) {
    errors.push(`${file} missing AGENTS hard-rule anchor summary`);
  } else {
    expectNumber(file, 'hardRules', baseline.hardRules, Number(hardRuleAnchorMatch[1].replace(/,/g, '')));
  }

  const agentMatch = /([\d,]+)\s+hard-rule keyword edges and\s+([\d,]+)\s+hard-rule implementation edges/.exec(text);
  if (!agentMatch) {
    errors.push(`${file} missing AGENTS hard-rule summary`);
  } else {
    expectNumber(file, 'hardRuleKeywordEdges', baseline.hardRuleKeywordEdges, Number(agentMatch[1].replace(/,/g, '')));
    expectNumber(file, 'hardRuleImplementationEdges', baseline.hardRuleImplementationEdges, Number(agentMatch[2].replace(/,/g, '')));
  }

  const agentNodeMatch = /([\d,]+)\s+hard-rule keyword nodes[\s\S]*?([\d,]+)\s+hard-rule keyword reference edges[\s\S]*?All\s+([\d,]+)\s+hard-rule keyword edges carry[\s\S]*?adds\s+([\d,]+)\s+`?hard-rule-implementation`?[\s\S]*?edges[\s\S]*?to\s+([\d,]+)\s+callable symbols/.exec(text)
    ?? /([\d,]+)\s+hard-rule keyword nodes,\s+([\d,]+)\s+hard-rule keyword edges,\s+([\d,]+)\s+hard-rule keyword mapping edges,\s+([\d,]+)\s+hard-rule implementation edges,\s+and\s+([\d,]+)\s+hard-rule implementation targets/.exec(text);
  if (!agentNodeMatch) {
    errors.push(`${file} missing AGENTS hard-rule node/provenance summary`);
  } else {
    expectNumber(file, 'hardRuleKeywordNodes', baseline.hardRuleKeywordNodes, Number(agentNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'hardRuleKeywordEdges', baseline.hardRuleKeywordEdges, Number(agentNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'hardRuleKeywordMappingEdges', baseline.hardRuleKeywordMappingEdges, Number(agentNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'hardRuleImplementationEdges', baseline.hardRuleImplementationEdges, Number(agentNodeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'hardRuleImplementationTargets', baseline.hardRuleImplementationTargets, Number(agentNodeMatch[5].replace(/,/g, '')));
  }

  expectEveryNumber(file, 'hardRuleKeywordNodes', baseline.hardRuleKeywordNodes, text, /([\d,]+)\s+hard-rule keyword nodes/g);
  expectEveryNumber(file, 'hardRuleKeywordEdges', baseline.hardRuleKeywordEdges, text, /([\d,]+)\s+hard-rule keyword(?: reference)? edges/g);
  expectEveryNumber(file, 'hardRuleKeywordMappingEdges', baseline.hardRuleKeywordMappingEdges, text, /([\d,]+)\s+hard-rule keyword mapping edges/g);
  expectEveryNumber(file, 'hardRuleImplementationEdges', baseline.hardRuleImplementationEdges, text, /([\d,]+)\s+hard-rule implementation edges/g);
  expectEveryNumber(file, 'hardRuleImplementationTargets', baseline.hardRuleImplementationTargets, text, /([\d,]+)\s+hard-rule implementation targets/g);
  expectEveryNumber(file, 'hardRuleImplementationTargets', baseline.hardRuleImplementationTargets, text, /([\d,]+)\s+callable symbols/g);

  const syncMatch = /([\d,]+)\s+sync-rule anchors,\s+([\d,]+)\s+sync-body keyword edges,\s+([\d,]+)\s+sync-config keyword edges,\s+and\s+([\d,]+)\s+config-source edges/.exec(text);
  if (!syncMatch) {
    errors.push(`${file} missing AGENTS sync-rule summary`);
  } else {
    expectNumber(file, 'syncRules', baseline.syncRules, Number(syncMatch[1].replace(/,/g, '')));
    expectNumber(file, 'syncBodyKeywordEdges', baseline.syncBodyKeywordEdges, Number(syncMatch[2].replace(/,/g, '')));
    expectNumber(file, 'syncConfigKeywordEdges', baseline.syncConfigKeywordEdges, Number(syncMatch[3].replace(/,/g, '')));
    expectNumber(file, 'configSourceEdges', baseline.configSourceEdges, Number(syncMatch[4].replace(/,/g, '')));
  }

  const syncNodeMatch = /([\d,]+)\s+AGENTS-derived\s+`?sync-rule`?\s+anchors,\s+including\s+([\d,]+)\s+`?\*_CONFIG\.\*`?\s+baseline rows[\s\S]*?with\s+([\d,]+)\s+explicit AGENTS keyword nodes and\s+([\d,]+)\s+keyword reference edges[\s\S]*?adds\s+([\d,]+)\s+native\s+`?config-property`?\s+nodes,\s+([\d,]+)\s+`?config-property`?\s+containment edges,\s+and\s+([\d,]+)\s+`?config-source`?\s+references[\s\S]*?([\d,]+)\s+nested config properties keep parent-property\s+`?contains`?\s+edges[\s\S]*?the\s+([\d,]+)\s+`?SYNC_CONFIG\.\*`?\s+rows also keep the compatibility\s+`?sync-config-source`?\s+relation/.exec(text)
    ?? /([\d,]+)\s+sync-rule anchors,\s+([\d,]+)\s+config-rule anchors,\s+([\d,]+)\s+sync-rule nodes,\s+([\d,]+)\s+sync-rule keyword nodes,\s+([\d,]+)\s+sync-rule keyword edges,\s+([\d,]+)\s+sync-body keyword edges,\s+([\d,]+)\s+sync-config keyword edges,\s+([\d,]+)\s+config-property nodes,\s+([\d,]+)\s+config-property edges,\s+([\d,]+)\s+config-property parent edges,\s+([\d,]+)\s+config-source edges,\s+([\d,]+)\s+config-source property edges,\s+and\s+([\d,]+)\s+sync-config-source edges/.exec(text);
  if (!syncNodeMatch) {
    errors.push(`${file} missing AGENTS sync-rule node/provenance summary`);
  } else if (syncNodeMatch.length === 10) {
    expectNumber(file, 'syncRules', baseline.syncRules, Number(syncNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'configRules', baseline.configRules, Number(syncNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'syncRuleNodes', baseline.syncRuleNodes, Number(syncNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'syncRuleKeywordNodes', baseline.syncRuleKeywordNodes, Number(syncNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'syncRuleKeywordEdges', baseline.syncRuleKeywordEdges, Number(syncNodeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'configPropertyNodes', baseline.configPropertyNodes, Number(syncNodeMatch[5].replace(/,/g, '')));
    expectNumber(file, 'configPropertyEdges', baseline.configPropertyEdges, Number(syncNodeMatch[6].replace(/,/g, '')));
    expectNumber(file, 'configSourceEdges', baseline.configSourceEdges, Number(syncNodeMatch[7].replace(/,/g, '')));
    expectNumber(file, 'configSourcePropertyEdges', baseline.configSourcePropertyEdges, Number(syncNodeMatch[7].replace(/,/g, '')));
    expectNumber(file, 'configPropertyParentEdges', baseline.configPropertyParentEdges, Number(syncNodeMatch[8].replace(/,/g, '')));
    expectNumber(file, 'syncConfigSourceEdges', baseline.syncConfigSourceEdges, Number(syncNodeMatch[9].replace(/,/g, '')));
  } else {
    expectNumber(file, 'syncRules', baseline.syncRules, Number(syncNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'configRules', baseline.configRules, Number(syncNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'syncRuleNodes', baseline.syncRuleNodes, Number(syncNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'syncRuleKeywordNodes', baseline.syncRuleKeywordNodes, Number(syncNodeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'syncRuleKeywordEdges', baseline.syncRuleKeywordEdges, Number(syncNodeMatch[5].replace(/,/g, '')));
    expectNumber(file, 'syncBodyKeywordEdges', baseline.syncBodyKeywordEdges, Number(syncNodeMatch[6].replace(/,/g, '')));
    expectNumber(file, 'syncConfigKeywordEdges', baseline.syncConfigKeywordEdges, Number(syncNodeMatch[7].replace(/,/g, '')));
    expectNumber(file, 'configPropertyNodes', baseline.configPropertyNodes, Number(syncNodeMatch[8].replace(/,/g, '')));
    expectNumber(file, 'configPropertyEdges', baseline.configPropertyEdges, Number(syncNodeMatch[9].replace(/,/g, '')));
    expectNumber(file, 'configPropertyParentEdges', baseline.configPropertyParentEdges, Number(syncNodeMatch[10].replace(/,/g, '')));
    expectNumber(file, 'configSourceEdges', baseline.configSourceEdges, Number(syncNodeMatch[11].replace(/,/g, '')));
    expectNumber(file, 'configSourcePropertyEdges', baseline.configSourcePropertyEdges, Number(syncNodeMatch[12].replace(/,/g, '')));
    expectNumber(file, 'syncConfigSourceEdges', baseline.syncConfigSourceEdges, Number(syncNodeMatch[13].replace(/,/g, '')));
  }

  const migrationMatch = /([\d,]+)\s+SQL function edges,\s+([\d,]+)\s+trigger-function edges,\s+([\d,]+)\s+migration-index edges,\s+([\d,]+)\s+migration-constraint edges,\s+([\d,]+)\s+migration-constraint-validation edges,\s+and\s+([\d,]+)\s+migration-rls edges/.exec(text);
  if (!migrationMatch) {
    errors.push(`${file} missing Supabase migration graph summary`);
  } else {
    expectNumber(file, 'migrationSqlFunctionEdges', baseline.migrationSqlFunctionEdges, Number(migrationMatch[1].replace(/,/g, '')));
    expectNumber(file, 'migrationTriggerFunctionEdges', baseline.migrationTriggerFunctionEdges, Number(migrationMatch[2].replace(/,/g, '')));
    expectNumber(file, 'migrationIndexEdges', baseline.migrationIndexEdges, Number(migrationMatch[3].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintEdges', baseline.migrationConstraintEdges, Number(migrationMatch[4].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintValidationEdges', baseline.migrationConstraintValidationEdges, Number(migrationMatch[5].replace(/,/g, '')));
    expectNumber(file, 'migrationRlsEdges', baseline.migrationRlsEdges, Number(migrationMatch[6].replace(/,/g, '')));
  }

  const publicationViewMatch = /([\d,]+)\s+migration-realtime-publication edges backed by\s+([\d,]+)\s+publication nodes from\s+([\d,]+)\s+parsed publication details,\s+and\s+([\d,]+)\s+migration-view edges backed by\s+([\d,]+)\s+view nodes from\s+([\d,]+)\s+parsed view details/.exec(text);
  if (!publicationViewMatch) {
    errors.push(`${file} missing Supabase migration publication/view summary`);
  } else {
    expectNumber(file, 'migrationRealtimePublicationEdges', baseline.migrationRealtimePublicationEdges, Number(publicationViewMatch[1].replace(/,/g, '')));
    expectNumber(file, 'migrationRealtimePublicationNodes', baseline.migrationRealtimePublicationNodes, Number(publicationViewMatch[2].replace(/,/g, '')));
    expectNumber(file, 'migrationRealtimePublicationDetails', baseline.migrationRealtimePublicationDetails, Number(publicationViewMatch[3].replace(/,/g, '')));
    expectNumber(file, 'migrationViewEdges', baseline.migrationViewEdges, Number(publicationViewMatch[4].replace(/,/g, '')));
    expectNumber(file, 'migrationViewNodes', baseline.migrationViewNodes, Number(publicationViewMatch[5].replace(/,/g, '')));
    expectNumber(file, 'migrationViewDetails', baseline.migrationViewDetails, Number(publicationViewMatch[6].replace(/,/g, '')));
  }

  const supabaseStructuredDetailMatch = /Supabase structured detail summary:\s+([\d,]+)\s+edgeFunctionTests,\s+([\d,]+)\s+migrationFunctionDetails,\s+([\d,]+)\s+migrationTriggers,\s+([\d,]+)\s+migrationRlsDetails,\s+([\d,]+)\s+migrationTests,\s+and\s+([\d,]+)\s+policyDetails/.exec(text);
  if (!supabaseStructuredDetailMatch) {
    errors.push(`${file} missing Supabase structured detail summary`);
  } else {
    expectNumber(file, 'edgeFunctionTests', baseline.edgeFunctionTests, Number(supabaseStructuredDetailMatch[1].replace(/,/g, '')));
    expectNumber(file, 'migrationFunctionDetails', baseline.migrationFunctionDetails, Number(supabaseStructuredDetailMatch[2].replace(/,/g, '')));
    expectNumber(file, 'migrationTriggers', baseline.migrationTriggers, Number(supabaseStructuredDetailMatch[3].replace(/,/g, '')));
    expectNumber(file, 'migrationRlsDetails', baseline.migrationRlsDetails, Number(supabaseStructuredDetailMatch[4].replace(/,/g, '')));
    expectNumber(file, 'migrationTests', baseline.migrationTests, Number(supabaseStructuredDetailMatch[5].replace(/,/g, '')));
    expectNumber(file, 'policyDetails', baseline.policyDetails, Number(supabaseStructuredDetailMatch[6].replace(/,/g, '')));
  }

  const migrationNodeMatch = /([\d,]+)\s+sql-function edges backed by\s+([\d,]+)\s+native\s+`?function`?\s+nodes[\s\S]*?([\d,]+)\s+policy nodes[\s\S]*?([\d,]+)\s+trigger edges[\s\S]*?([\d,]+)\s+trigger-function[\s\S]*?edges,\s+`?([\d,]+)`?\s+migration-index edges,\s+`?([\d,]+)`?\s+migration-constraint edges[\s\S]*?`?([\d,]+)`?\s+migration-constraint-validation edges[\s\S]*?`?([\d,]+)`?\s+migration test[\s\S]*?edges[\s\S]*?The structured\s+`?indexDetails`?\s+array has\s+([\d,]+)\s+entries backed by\s+([\d,]+)\s+index nodes[\s\S]*?`?constraintDetails`?\s+has\s+([\d,]+)\s+entries backed by\s+([\d,]+)\s+constraint nodes[\s\S]*?`?constraintValidationDetails`?\s+has\s+([\d,]+)\s+entries and\s+([\d,]+)\s+validation-only graph nodes[\s\S]*?`?privilegeDetails`?\s+array contains\s+([\d,]+)[\s\S]*?backed by\s+([\d,]+)\s+privilege nodes,\s+([\d,]+)\s+privilege-object nodes,\s+and\s+([\d,]+)\s+privilege-role nodes/.exec(text)
    ?? /([\d,]+)\s+SQL function nodes,\s+([\d,]+)\s+SQL function edges,\s+([\d,]+)\s+trigger edges,\s+([\d,]+)\s+trigger-function edges,\s+([\d,]+)\s+migration-index nodes,\s+([\d,]+)\s+migration-index edges,\s+([\d,]+)\s+migration-constraint nodes,\s+([\d,]+)\s+migration-constraint edges,\s+([\d,]+)\s+migration-constraint-validation nodes,\s+([\d,]+)\s+migration-constraint-validation edges,\s+and\s+([\d,]+)\s+migration-rls edges/.exec(text);
  if (!migrationNodeMatch) {
    errors.push(`${file} missing Supabase migration node summary`);
  } else if (migrationNodeMatch.length === 20) {
    expectNumber(file, 'migrationSqlFunctionEdges', baseline.migrationSqlFunctionEdges, Number(migrationNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'migrationSqlFunctionFunctionNodes', baseline.migrationSqlFunctionFunctionNodes, Number(migrationNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'policyNodes', baseline.policyNodes, Number(migrationNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'migrationTriggerEdges', baseline.migrationTriggerEdges, Number(migrationNodeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'migrationTriggerFunctionEdges', baseline.migrationTriggerFunctionEdges, Number(migrationNodeMatch[5].replace(/,/g, '')));
    expectNumber(file, 'migrationIndexEdges', baseline.migrationIndexEdges, Number(migrationNodeMatch[6].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintEdges', baseline.migrationConstraintEdges, Number(migrationNodeMatch[7].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintValidationEdges', baseline.migrationConstraintValidationEdges, Number(migrationNodeMatch[8].replace(/,/g, '')));
    expectNumber(file, 'migrationTestEdges', baseline.migrationTestEdges, Number(migrationNodeMatch[9].replace(/,/g, '')));
    expectNumber(file, 'migrationIndexDetails', baseline.migrationIndexDetails, Number(migrationNodeMatch[10].replace(/,/g, '')));
    expectNumber(file, 'migrationIndexNodes', baseline.migrationIndexNodes, Number(migrationNodeMatch[11].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintDetails', baseline.migrationConstraintDetails, Number(migrationNodeMatch[12].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintNodes', baseline.migrationConstraintNodes, Number(migrationNodeMatch[13].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintValidationDetails', baseline.migrationConstraintValidationDetails, Number(migrationNodeMatch[14].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintValidationNodes', baseline.migrationConstraintValidationNodes, Number(migrationNodeMatch[15].replace(/,/g, '')));
    expectNumber(file, 'privilegeDetails', baseline.privilegeDetails, Number(migrationNodeMatch[16].replace(/,/g, '')));
    expectNumber(file, 'privilegeNodes', baseline.privilegeNodes, Number(migrationNodeMatch[17].replace(/,/g, '')));
    expectNumber(file, 'privilegeObjectNodes', baseline.privilegeObjectNodes, Number(migrationNodeMatch[18].replace(/,/g, '')));
    expectNumber(file, 'privilegeRoleNodes', baseline.privilegeRoleNodes, Number(migrationNodeMatch[19].replace(/,/g, '')));
  } else {
    expectNumber(file, 'migrationSqlFunctionFunctionNodes', baseline.migrationSqlFunctionFunctionNodes, Number(migrationNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'migrationSqlFunctionEdges', baseline.migrationSqlFunctionEdges, Number(migrationNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'migrationTriggerEdges', baseline.migrationTriggerEdges, Number(migrationNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'migrationTriggerFunctionEdges', baseline.migrationTriggerFunctionEdges, Number(migrationNodeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'migrationIndexNodes', baseline.migrationIndexNodes, Number(migrationNodeMatch[5].replace(/,/g, '')));
    expectNumber(file, 'migrationIndexEdges', baseline.migrationIndexEdges, Number(migrationNodeMatch[6].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintNodes', baseline.migrationConstraintNodes, Number(migrationNodeMatch[7].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintEdges', baseline.migrationConstraintEdges, Number(migrationNodeMatch[8].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintValidationNodes', baseline.migrationConstraintValidationNodes, Number(migrationNodeMatch[9].replace(/,/g, '')));
    expectNumber(file, 'migrationConstraintValidationEdges', baseline.migrationConstraintValidationEdges, Number(migrationNodeMatch[10].replace(/,/g, '')));
    expectNumber(file, 'migrationRlsEdges', baseline.migrationRlsEdges, Number(migrationNodeMatch[11].replace(/,/g, '')));
  }

  const policyMatch = /([\d,]+)\s+policy-command edges,\s+([\d,]+)\s+policy-type edges,\s+([\d,]+)\s+policy-role edges,\s+([\d,]+)\s+policy-using edges,\s+([\d,]+)\s+policy-with-check edges,\s+([\d,]+)\s+privilege-grant edges,\s+([\d,]+)\s+privilege-revoke edges,\s+([\d,]+)\s+privilege-object edges,\s+and\s+([\d,]+)\s+privilege-role edges/.exec(text);
  if (!policyMatch) {
    errors.push(`${file} missing Supabase policy\/privilege summary`);
  } else {
    expectNumber(file, 'policyCommandEdges', baseline.policyCommandEdges, Number(policyMatch[1].replace(/,/g, '')));
    expectNumber(file, 'policyTypeEdges', baseline.policyTypeEdges, Number(policyMatch[2].replace(/,/g, '')));
    expectNumber(file, 'policyRoleEdges', baseline.policyRoleEdges, Number(policyMatch[3].replace(/,/g, '')));
    expectNumber(file, 'policyUsingEdges', baseline.policyUsingEdges, Number(policyMatch[4].replace(/,/g, '')));
    expectNumber(file, 'policyWithCheckEdges', baseline.policyWithCheckEdges, Number(policyMatch[5].replace(/,/g, '')));
    expectNumber(file, 'privilegeGrantEdges', baseline.privilegeGrantEdges, Number(policyMatch[6].replace(/,/g, '')));
    expectNumber(file, 'privilegeRevokeEdges', baseline.privilegeRevokeEdges, Number(policyMatch[7].replace(/,/g, '')));
    expectNumber(file, 'privilegeObjectEdges', baseline.privilegeObjectEdges, Number(policyMatch[8].replace(/,/g, '')));
    expectNumber(file, 'privilegeRoleEdges', baseline.privilegeRoleEdges, Number(policyMatch[9].replace(/,/g, '')));
  }

  const policyNodeMatch = /([\d,]+)\s+policy nodes[\s\S]*?backed by\s+([\d,]+)\s+privilege nodes,\s+([\d,]+)\s+privilege-object nodes,\s+and\s+([\d,]+)\s+privilege-role nodes/.exec(text)
    ?? /([\d,]+)\s+policy nodes,\s+[\d,]+\s+policy-command edges[\s\S]*?([\d,]+)\s+privilege nodes,\s+([\d,]+)\s+privilege-object nodes[\s\S]*?([\d,]+)\s+privilege-role nodes/.exec(text);
  if (!policyNodeMatch) {
    errors.push(`${file} missing Supabase policy\/privilege node summary`);
  } else {
    expectNumber(file, 'policyNodes', baseline.policyNodes, Number(policyNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'privilegeNodes', baseline.privilegeNodes, Number(policyNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'privilegeObjectNodes', baseline.privilegeObjectNodes, Number(policyNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'privilegeRoleNodes', baseline.privilegeRoleNodes, Number(policyNodeMatch[4].replace(/,/g, '')));
  }

  const supabaseOperationMatch = /([\d,]+)\s+Supabase RPC edges and\s+([\d,]+)\s+Supabase table-write edges/.exec(text);
  if (!supabaseOperationMatch) {
    errors.push(`${file} missing Supabase RPC\/table-write summary`);
  } else {
    expectNumber(file, 'supabaseRpcEdges', baseline.supabaseRpcEdges, Number(supabaseOperationMatch[1].replace(/,/g, '')));
    expectNumber(file, 'supabaseTableWriteEdges', baseline.supabaseTableWriteEdges, Number(supabaseOperationMatch[2].replace(/,/g, '')));
  }

  const supabaseOperationNodeMatch = /adds\s+([\d,]+)\s+`?supabase-rpc`?\s+nodes and\s+([\d,]+)\s+native[\s\S]*?edges[\s\S]*?plus\s+([\d,]+)\s+`?supabase-table-write`?\s+nodes and\s+([\d,]+)\s+native[\s\S]*?edges/.exec(text)
    ?? /([\d,]+)\s+Supabase RPC nodes and\s+([\d,]+)\s+Supabase RPC edges;\s+([\d,]+)\s+Supabase table-write nodes and\s+([\d,]+)\s+Supabase table-write edges/.exec(text);
  if (!supabaseOperationNodeMatch) {
    errors.push(`${file} missing Supabase RPC\/table-write node summary`);
  } else {
    expectNumber(file, 'supabaseRpcNodes', baseline.supabaseRpcNodes, Number(supabaseOperationNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'supabaseRpcEdges', baseline.supabaseRpcEdges, Number(supabaseOperationNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'supabaseTableWriteNodes', baseline.supabaseTableWriteNodes, Number(supabaseOperationNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'supabaseTableWriteEdges', baseline.supabaseTableWriteEdges, Number(supabaseOperationNodeMatch[4].replace(/,/g, '')));
  }

  const realtimeMatch = /Realtime graph summary:\s+([\d,]+)\s+supabase-realtime-channel edges,\s+([\d,]+)\s+supabase-realtime-postgres-change edges,\s+([\d,]+)\s+supabase-realtime-status edges,\s+([\d,]+)\s+supabase-realtime-remove-channel edges,\s+([\d,]+)\s+supabase-realtime-unsubscribe edges,\s+and\s+([\d,]+)\s+supabase-realtime-remove-all-channels edges/.exec(text);
  const realtimeStatusLayerMatch = /Realtime status layer adds\s+([\d,]+)\s+native\s+`?supabase-realtime-status`?\s+nodes\/edges/.exec(text);
  const realtimeNodeMatch = /adds\s+([\d,]+)\s+native\s+`?supabase-realtime-channel`?\s+nodes\/edges and\s+([\d,]+)\s+native\s+`?supabase-realtime-postgres-change`?\s+node\/edge[\s\S]*?Realtime lifecycle layer adds\s+([\d,]+)\s+native\s+`?supabase-realtime-remove-channel`?\s+nodes\/edges[\s\S]*?real tree has\s+([\d,]+)\s+`?supabase-realtime-unsubscribe`?\s+and\s+([\d,]+)\s+`?supabase-realtime-remove-all-channels`?\s+edges/.exec(text)
    ?? /Realtime node summary:\s+([\d,]+)\s+supabase-realtime-channel nodes,\s+([\d,]+)\s+supabase-realtime-postgres-change nodes,\s+[\d,]+\s+supabase-realtime-status nodes,\s+([\d,]+)\s+supabase-realtime-remove-channel nodes,\s+([\d,]+)\s+supabase-realtime-unsubscribe nodes,\s+and\s+([\d,]+)\s+supabase-realtime-remove-all-channels nodes/.exec(text);
  if (!realtimeStatusLayerMatch) {
    errors.push(`${file} missing Supabase Realtime status layer summary`);
  } else {
    expectNumber(file, 'supabaseRealtimeStatusNodes', baseline.supabaseRealtimeStatusNodes, Number(realtimeStatusLayerMatch[1].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeStatusEdges', baseline.supabaseRealtimeStatusEdges, Number(realtimeStatusLayerMatch[1].replace(/,/g, '')));
  }

  if (!realtimeNodeMatch) {
    errors.push(`${file} missing Supabase Realtime node summary`);
  } else {
    expectNumber(file, 'supabaseRealtimeChannelNodes', baseline.supabaseRealtimeChannelNodes, Number(realtimeNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimePostgresChangeNodes', baseline.supabaseRealtimePostgresChangeNodes, Number(realtimeNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeRemoveChannelNodes', baseline.supabaseRealtimeRemoveChannelNodes, Number(realtimeNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeUnsubscribeNodes', baseline.supabaseRealtimeUnsubscribeNodes, Number(realtimeNodeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeRemoveAllChannelsNodes', baseline.supabaseRealtimeRemoveAllChannelsNodes, Number(realtimeNodeMatch[5].replace(/,/g, '')));
  }

  if (!realtimeMatch) {
    errors.push(`${file} missing Supabase Realtime summary`);
  } else {
    expectNumber(file, 'supabaseRealtimeChannelEdges', baseline.supabaseRealtimeChannelEdges, Number(realtimeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimePostgresChangeEdges', baseline.supabaseRealtimePostgresChangeEdges, Number(realtimeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeStatusEdges', baseline.supabaseRealtimeStatusEdges, Number(realtimeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeRemoveChannelEdges', baseline.supabaseRealtimeRemoveChannelEdges, Number(realtimeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeUnsubscribeEdges', baseline.supabaseRealtimeUnsubscribeEdges, Number(realtimeMatch[5].replace(/,/g, '')));
    expectNumber(file, 'supabaseRealtimeRemoveAllChannelsEdges', baseline.supabaseRealtimeRemoveAllChannelsEdges, Number(realtimeMatch[6].replace(/,/g, '')));
  }

  const selectStorageMatch = /Select and storage graph summary:\s+([\d,]+)\s+supabase-select-field edges,\s+([\d,]+)\s+supabase-select-field reference edges,\s+([\d,]+)\s+inline select provenance edges,\s+([\d,]+)\s+sync-required-field edges,\s+([\d,]+)\s+supabase-incremental-predicate edges,\s+([\d,]+)\s+sync-required-predicate edges,\s+and\s+([\d,]+)\s+supabase-storage-bucket edges/.exec(text);
  if (!selectStorageMatch) {
    errors.push(`${file} missing Supabase select/storage summary`);
  } else {
    expectNumber(file, 'supabaseSelectFieldEdges', baseline.supabaseSelectFieldEdges, Number(selectStorageMatch[1].replace(/,/g, '')));
    expectNumber(file, 'supabaseSelectFieldReferenceEdges', baseline.supabaseSelectFieldReferenceEdges, Number(selectStorageMatch[2].replace(/,/g, '')));
    expectNumber(file, 'inlineSelectFieldEdges', baseline.inlineSelectFieldEdges, Number(selectStorageMatch[3].replace(/,/g, '')));
    expectNumber(file, 'syncRequiredFieldEdges', baseline.syncRequiredFieldEdges, Number(selectStorageMatch[4].replace(/,/g, '')));
    expectNumber(file, 'supabaseIncrementalPredicateEdges', baseline.supabaseIncrementalPredicateEdges, Number(selectStorageMatch[5].replace(/,/g, '')));
    expectNumber(file, 'syncRequiredPredicateEdges', baseline.syncRequiredPredicateEdges, Number(selectStorageMatch[6].replace(/,/g, '')));
    expectNumber(file, 'supabaseStorageBucketEdges', baseline.supabaseStorageBucketEdges, Number(selectStorageMatch[7].replace(/,/g, '')));
  }

  const selectStorageNodeMatch = /adds\s+([\d,]+)\s+native\s+`?supabase-select-field`?[\s\S]*?property nodes[\s\S]*?([\d,]+)\s+`?supabase-select-field`?\s+edges[\s\S]*?([\d,]+)\s+method\/function[\s\S]*?`?references`?\s+edges[\s\S]*?([\d,]+)\s+inline select field nodes,\s+([\d,]+)\s+inline select provenance edges[\s\S]*?adds\s+([\d,]+)\s+`?supabase-incremental-predicate`?\s+nodes,\s+([\d,]+)\s+method\/function[\s\S]*?predicate\s+`?references`?\s+edges[\s\S]*?and\s+([\d,]+)\s+`?sync-required-predicate`?\s+edges[\s\S]*?adds\s+([\d,]+)\s+`?supabase-storage-bucket`?\s+nodes and\s+([\d,]+)\s+native\s+`?references`?\s+edges/.exec(text)
    ?? /Select and storage node summary:\s+([\d,]+)\s+supabase-select-field nodes,\s+([\d,]+)\s+inline select field nodes,\s+([\d,]+)\s+supabase-incremental-predicate nodes,\s+and\s+([\d,]+)\s+supabase-storage-bucket nodes/.exec(text);
  if (!selectStorageNodeMatch) {
    errors.push(`${file} missing Supabase select/storage node summary`);
  } else if (selectStorageNodeMatch.length === 11) {
    expectNumber(file, 'supabaseSelectFieldNodes', baseline.supabaseSelectFieldNodes, Number(selectStorageNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'supabaseSelectFieldEdges', baseline.supabaseSelectFieldEdges, Number(selectStorageNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'supabaseSelectFieldReferenceEdges', baseline.supabaseSelectFieldReferenceEdges, Number(selectStorageNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'inlineSelectFieldNodes', baseline.inlineSelectFieldNodes, Number(selectStorageNodeMatch[4].replace(/,/g, '')));
    expectNumber(file, 'inlineSelectFieldEdges', baseline.inlineSelectFieldEdges, Number(selectStorageNodeMatch[5].replace(/,/g, '')));
    expectNumber(file, 'supabaseIncrementalPredicateNodes', baseline.supabaseIncrementalPredicateNodes, Number(selectStorageNodeMatch[6].replace(/,/g, '')));
    expectNumber(file, 'supabaseIncrementalPredicateEdges', baseline.supabaseIncrementalPredicateEdges, Number(selectStorageNodeMatch[7].replace(/,/g, '')));
    expectNumber(file, 'syncRequiredPredicateEdges', baseline.syncRequiredPredicateEdges, Number(selectStorageNodeMatch[8].replace(/,/g, '')));
    expectNumber(file, 'supabaseStorageBucketNodes', baseline.supabaseStorageBucketNodes, Number(selectStorageNodeMatch[9].replace(/,/g, '')));
    expectNumber(file, 'supabaseStorageBucketEdges', baseline.supabaseStorageBucketEdges, Number(selectStorageNodeMatch[10].replace(/,/g, '')));
  } else {
    expectNumber(file, 'supabaseSelectFieldNodes', baseline.supabaseSelectFieldNodes, Number(selectStorageNodeMatch[1].replace(/,/g, '')));
    expectNumber(file, 'inlineSelectFieldNodes', baseline.inlineSelectFieldNodes, Number(selectStorageNodeMatch[2].replace(/,/g, '')));
    expectNumber(file, 'supabaseIncrementalPredicateNodes', baseline.supabaseIncrementalPredicateNodes, Number(selectStorageNodeMatch[3].replace(/,/g, '')));
    expectNumber(file, 'supabaseStorageBucketNodes', baseline.supabaseStorageBucketNodes, Number(selectStorageNodeMatch[4].replace(/,/g, '')));
  }

  const inlineTestMappingCounts = readInlineCounters(text, [
    'totalTestEdges',
    'testEdgesWithTestMapping',
    'sameBasenameTestEdges',
    'classReferenceTestEdges',
    'pathReferenceTestEdges',
    'routeReferenceTestEdges',
    'invokeReferenceTestEdges',
    'filenameReferenceTestEdges',
    'testEdgesWithMatchedNeedle',
  ]);
  const testMappingMatch = inlineTestMappingCounts ? null : /([\d,]+)\s+total test-reference edges;\s+all\s+([\d,]+)\s+carry provenance in\s+`?metadata\.testMapping`?\.\s+Angular contributes\s+([\d,]+)\s+`?same-basename`?\s+edges and\s+([\d,]+)\s+`?class-reference`?\s+edges\.\s+Supabase contributes\s+([\d,]+)\s+`?path-reference`?\s+edges,\s+([\d,]+)\s+`?route-reference`?\s+edge[s]?,\s+([\d,]+)\s+`?invoke-reference`?\s+edges,\s+and\s+([\d,]+)\s+`?filename-reference`?\s+edges\.[\s\S]*?([\d,]+)\s+(?:template\/)?path\/route\/filename-derived edges also render\s+`?matchedNeedle`?/.exec(text);
  if (inlineTestMappingCounts) {
    expectNumber(file, 'totalTestEdges', baseline.totalTestEdges, inlineTestMappingCounts.totalTestEdges);
    expectNumber(file, 'testEdgesWithTestMapping', baseline.testEdgesWithTestMapping, inlineTestMappingCounts.testEdgesWithTestMapping);
    expectNumber(file, 'sameBasenameTestEdges', baseline.sameBasenameTestEdges, inlineTestMappingCounts.sameBasenameTestEdges);
    expectNumber(file, 'classReferenceTestEdges', baseline.classReferenceTestEdges, inlineTestMappingCounts.classReferenceTestEdges);
    expectNumber(file, 'pathReferenceTestEdges', baseline.pathReferenceTestEdges, inlineTestMappingCounts.pathReferenceTestEdges);
    expectNumber(file, 'routeReferenceTestEdges', baseline.routeReferenceTestEdges, inlineTestMappingCounts.routeReferenceTestEdges);
    expectNumber(file, 'invokeReferenceTestEdges', baseline.invokeReferenceTestEdges, inlineTestMappingCounts.invokeReferenceTestEdges);
    expectNumber(file, 'filenameReferenceTestEdges', baseline.filenameReferenceTestEdges, inlineTestMappingCounts.filenameReferenceTestEdges);
    expectNumber(file, 'testEdgesWithMatchedNeedle', baseline.testEdgesWithMatchedNeedle, inlineTestMappingCounts.testEdgesWithMatchedNeedle);
  } else if (!testMappingMatch) {
    errors.push(`${file} missing test mapping summary`);
  } else {
    expectNumber(file, 'totalTestEdges', baseline.totalTestEdges, Number(testMappingMatch[1].replace(/,/g, '')));
    expectNumber(file, 'testEdgesWithTestMapping', baseline.testEdgesWithTestMapping, Number(testMappingMatch[2].replace(/,/g, '')));
    expectNumber(file, 'sameBasenameTestEdges', baseline.sameBasenameTestEdges, Number(testMappingMatch[3].replace(/,/g, '')));
    expectNumber(file, 'classReferenceTestEdges', baseline.classReferenceTestEdges, Number(testMappingMatch[4].replace(/,/g, '')));
    expectNumber(file, 'pathReferenceTestEdges', baseline.pathReferenceTestEdges, Number(testMappingMatch[5].replace(/,/g, '')));
    expectNumber(file, 'routeReferenceTestEdges', baseline.routeReferenceTestEdges, Number(testMappingMatch[6].replace(/,/g, '')));
    expectNumber(file, 'invokeReferenceTestEdges', baseline.invokeReferenceTestEdges, Number(testMappingMatch[7].replace(/,/g, '')));
    expectNumber(file, 'filenameReferenceTestEdges', baseline.filenameReferenceTestEdges, Number(testMappingMatch[8].replace(/,/g, '')));
    expectNumber(file, 'testEdgesWithMatchedNeedle', baseline.testEdgesWithMatchedNeedle, Number(testMappingMatch[9].replace(/,/g, '')));
  }
}

function validateSourceOrderingDiagnostics(text, file) {
  const required = [
    'sourceOrdering',
    'queryClassification',
    'sourceOrdering.queryClassification',
    'sourceSectionCount',
    'duplicateSourceSectionCount',
    'relationshipsSectionCount',
    'duplicateRelationshipsSectionCount',
    'relationshipKindSectionCounts',
    'duplicateRelationshipKindSectionCount',
    'relatedSymbolsSectionCount',
    'duplicateRelatedSymbolsSectionCount',
    'firstSourceFiles',
    'visibleSourceFileDetails',
    'rankedOverlayFiles',
    'rankedOverlayFileDetails',
    'visibleIndex',
    'rankedIndex',
    'matchRank',
    'nodeRank',
    'matchScore',
    'nodeScore',
    'pathScore',
    'symbolScore',
    'sourceBlockScore',
    'lowValuePenalty',
    'rawLowValuePenalty',
    'pathClassLowValue',
    'codegraphToolingSource',
    'dedupMaintenanceSource',
    'explicitSymbolEvidence',
    'preferredSymbolEvidence',
    'explicitFileRequested',
    'explicitPathRequested',
    'explicitSourcePathRequested',
    'rawTopRankedOverlayFile',
    'topRankedOverlayFile',
    'topRankedOverlayFileSelectionReason',
    'topRankedOverlayFileSkippedLowValue',
    'topRankedOverlayFileVisibleIndex',
    'firstSourceBlockIsTopRankedOverlayFile',
    'topRankedOverlayFileMissing',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing context-pack sourceOrdering diagnostics: ${missing.join(', ')}`);
  }
}

function validateMcpLogGuardDiagnostics(text, file) {
  const required = [
    'wrapperStarts',
    'wrapperStarts.versions',
    'wrapperStarts.latest.scriptSha256',
    'currentWrapper',
    'currentWrapper.diskScriptSha256',
    'currentWrapper.matchesDisk',
    'currentWrapper.staleAgainstDisk',
    'currentDiskWrapper',
    'currentDiskWrapper.latestRequestKind',
    'currentContextWrapper',
    'currentContextWrapper.diskScriptSha256',
    'currentContextWrapper.matchesDisk',
    'currentContextWrapper.staleAgainstDisk',
    'currentContextWrapper.latestTs',
    'currentContextWrapper.latestRequestId',
    'currentDiskContextWrapper',
    'currentDiskContextWrapper.latestRequestKind',
    'activeWrappers',
	    'activeWrappers.total',
    'activeWrappers.staleAgainstDisk',
	    'activeWrappers.distinctScriptSha256',
	    'activeWrappers.activeWindowMs',
	    'currentContextSourceOrdering',
	    'currentContextSourceOrdering.baseSectionFilteredLines',
	    'currentContextSourceOrdering.latestBaseSectionFiltering',
	    'currentDiskContextSourceOrdering',
	    'currentDiskContextSourceOrdering.baseSectionFilteredLines',
	    'currentDiskContextSourceOrdering.latestBaseSectionFiltering',
	    'contextSourceOrdering',
	    'contextSourceOrdering.baseSectionFilteredLines',
	    'contextSourceOrdering.latestBaseSectionFiltering',
    'queryClassification',
    'sourceOrdering.queryClassification',
    'codegraphToolingSource',
    'dedupMaintenanceSource',
    'missingDiagnostics',
    'duplicateSourceSections',
    'duplicateRelationshipsSections',
    'duplicateRelationshipKindSections',
    'duplicateRelatedSymbolsSections',
    'topRankedNotFirst',
    'topRankedMissing',
    'lowValueVisibleSourceBlocks',
    'lowValueSourcePollution',
    'latestIssue',
    'latestMissingDiagnostics',
    'wrapper.script.stale',
    'wrapper.script.stale.continue',
    'wrapper.script.stale.recycle.skipped',
    'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
    'wrapper.script.stale.recycle.request',
    'wrapper.shutdown.stale-wrapper-script',
    'wrapper.start.codexConfigAlignment',
    'wrapper.config.mismatch',
    'wrapper.config.match',
    'wrapper.config.unavailable',
    'wrapper.config.override',
    'mcp-host-config-mismatch',
    'codegraphAutoSyncDisabled',
    'currentCodegraphAutoSyncDisabled',
    'activeCodegraphAutoSyncDisabled',
    'activeCodegraphAutoSyncDisabledRuns',
    'diagnosticTriage',
    'diagnosticTriage.status',
    'diagnosticTriage.failureBoundary',
    'diagnosticTriage.adapterFailureLikely',
    'diagnosticTriage.directMcpTrust',
    'diagnosticTriage.failureClasses',
    'diagnosticTriage.doNotMisdiagnoseAs',
    'diagnosticTriage.primaryEvidence',
    'diagnosticTriage.primaryEvidence.directMcpError',
    'diagnosticTriage.nextAction',
    'observedDirectMcpError',
    'observedDirectMcpFailureClass',
    'hostMcp.rootCauseSummary',
    'rootCauseSummary.status',
    'rootCauseSummary.failureBoundary',
    'rootCauseSummary.adapterFailureLikely',
    'rootCauseSummary.failureClasses',
    'rootCauseSummary.directMcpTrust',
    'rootCauseSummary.fallback',
    'rootCauseSummary.recovery',
    'host-mcp:observed-direct-mcp-error',
    '--direct-mcp-error',
    'direct-mcp-host-transport-closed',
    'observed-direct-mcp-transport-closed',
    'fresh-config-mismatch',
    'stale-config-mismatch',
    'failureClasses',
    'observed.directMcpError',
    'observed.liveWrapperProcessCount',
    'observed.autoSyncDisabled',
    'observed.activeAutoSyncDisabledCount',
    'observed.activeAutoSyncDisabledRuns',
    'observed.liveProcessMismatches',
    'baseResponseWarnings',
    'responseWarnings',
    'nanoflow_context_pack',
    'nanoflow_overlay_query',
    'isError',
    'native CodeGraph CLI',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing MCP log guard diagnostics: ${missing.join(', ')}`);
  }
}

function validateQueryPathRelevanceContract(text, file) {
  const required = [
    'query-path relevance',
    'context-json nodes',
    'strict native Markdown',
    'relatedFiles',
    'entryPoints',
    'codeBlocks',
    'vitest services config mts',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing query-path relevance contract: ${missing.join(', ')}`);
  }
}

function validateCodexMcpConfigContract(text, file) {
  const required = [
    'Codex',
    'C:\\Users\\MI\\.codex\\config.toml',
    'D:\\Code\\dde\\.codex\\config.toml',
    'overrides',
    'codegraph:adapter:doctor',
    'adapter-first',
    'do not read or fall back',
    'not the active CodeGraph MCP',
    'must not be edited, repaired, or diagnosed',
    'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
    'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
  ];
  if (file === 'docs/codegraph-nanoflow-adaptation.md') {
    required.push(
      'mcpConfig: source=codex',
      'NANOFLOW_CODEGRAPH_CODEX_CONFIG',
    );
  }
  const staleUserPrimaryPatterns = [
    /Codex sessions use C:\\Users\\MI\\\.codex\\config\.toml as the current MCP source/i,
    /Active wrapper, CodeGraph target, and MCP environment changes belong in C:\\Users\\MI\\\.codex\\config\.toml/i,
  ];
  if (staleUserPrimaryPatterns.some(pattern => pattern.test(text))) {
    errors.push(`${file} conflicting Codex MCP config scope: D:\\Code\\dde\\.codex\\config.toml overrides C:\\Users\\MI\\.codex\\config.toml for this repository`);
  }
  const missing = required.filter(term => !text.includes(term));
  const forbidden = [];
  if (text.includes('may the adapter fall back to .vscode/mcp.json')) {
    forbidden.push('adapter may fall back to .vscode/mcp.json');
  }
  if (text.includes('only fall back to `.vscode/mcp.json`')) {
    forbidden.push('adapter only falls back to .vscode/mcp.json');
  }
  if (text.includes('falling back to `.vscode/mcp.json`')) {
    forbidden.push('adapter falls back to .vscode/mcp.json');
  }
  if (file === 'docs/codegraph-nanoflow-adaptation.md') {
    if (text.includes('The doctor reports `.vscode/mcp.json` under `mcpConfig`')) {
      forbidden.push('doctor reports .vscode/mcp.json as current mcpConfig source');
    }
    if (text.includes('The smoke starts the configured\n`.vscode/mcp.json` CodeGraph target')) {
      forbidden.push('smoke starts .vscode/mcp.json as current target');
    }
  }
  if (missing.length > 0 || forbidden.length > 0) {
    errors.push(`${file} missing Codex MCP config contract: ${[...missing, ...forbidden].join(', ')}`);
  }
}

function validateStrictNativeSourceEvidenceContract(text, file) {
  const missing = STRICT_NATIVE_SOURCE_EVIDENCE_REQUIRED_TERMS.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing strict native source evidence contract: ${missing.join(', ')}`);
  }
}
function validateStrictNativeOutputOrderContract(text, file) {
  const required = [
    'strict native output order',
    'query/summary/entryPoints/nodes/edges/codeBlocks/relatedFiles/stats',
    'Code Context -> Entry Points -> Relationships -> Related Symbols -> Code',
    'field order',
    'section order',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing strict native output order contract: ${missing.join(', ')}`);
  }
}
function validateStrictNativeObjectProjectionContract(text, file) {
  const required = [
    'strict native object projection',
    'id/kind/name/qualifiedName/filePath/language/startLine/endLine/signature/docstring/visibility/isExported/isAsync/isStatic/isAbstract',
    'source/target/kind/line/column',
    'filePath/startLine/endLine/language/content/nodeName/nodeKind',
    'metadata/provenance/sourceName/targetName',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing strict native object projection contract: ${missing.join(', ')}`);
  }
}
function validateAdapterGateContract(text, file) {
  const required = [
    'codegraph:adapter:gate',
    'codegraph:adapter:context',
    'codegraph:overlay:validate',
    'codegraph:overlay:sync',
    'codegraph:adapter:infra:test',
    'codegraph:adapter:preflight',
    'codegraph:adapter:quick-gate',
    'codegraph:adapter:context:packaged-artifacts',
    'codegraph:overlay:baseline:manifest',
    'codegraph:overlay:test',
    'codegraph:mcp:smoke',
    'codegraph:mcp:stale-smoke',
    'codegraph:mcp:log:guard',
    'codegraph-adapter-gate-mcp-wrapper.log',
    'codegraph-adapter-gate-stale-mcp-wrapper.log',
    '--fail-on-current-autosync-disabled',
    '--fail-on-stale-current-wrapper',
    '--fail-on-active-stale-wrappers',
    '--fail-on-untrusted-direct-mcp',
    'strict native JSON',
    'strict native Markdown',
    'NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS',
    'bounded captured output',
    'descendant',
  ];
  if (getPackageScripts()['codegraph:overlay:stable']) required.push(
    'codegraph:overlay:stable', 'codegraph:overlay:docs:assert-clean', 'codegraph:overlay:docs:recover', 'stable overlay transaction',
    'exactly two builds', 'source manifest path/size/SHA-256', 'generatedAt', 'node.updatedAt',
    'numeric-token-only', 'overlay publication is atomic separately', 'recoverable two-document transaction',
  );
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing adapter gate contract: ${missing.join(', ')}`);
  }
}
function validateAdapterFirstFallbackContract(text, file) {
  const required = [
    'adapter-first',
    'NanoFlow adapter CLI fallback',
    'codegraph:adapter:context',
    'nanoflow_context_pack',
    'nanoflow_overlay_query',
    'codegraph:overlay:query',
    '--skip-refresh',
    'final native CodeGraph CLI',
    '@colbymchenry/codegraph@1.5.0',
    'only a locator',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing adapter-first fallback contract: ${missing.join(', ')}`);
  }
}

function validateUpstreamCodeGraphBoundaryContract(text, file) {
  const required = [
    'upstream CodeGraph fixed version',
    '@colbymchenry/codegraph@1.5.0',
    '--codegraph-target @colbymchenry/codegraph@<new-version>',
    'delegates generic TypeScript symbol/import/export/call/impact',
    'native Markdown/JSON formatter section order',
    'strict native output projection',
    'context exploration source ordering',
    'must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact',
    'NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing upstream CodeGraph boundary contract: ${missing.join(', ')}`);
  }

  const dedupAuditRequired = [
    'De-duplication hotspot audit backlog',
    'collectTypeScript()',
    'buildNativeGraph()',
    'buildImportAliasIndex()',
    'buildExportTargetIndex()',
    'resolveReferenceNodeId()',
    'addTypeScriptCallableEdges()',
    'collectAndroid()',
    'readAndroidKotlinFileSymbols()',
    'readAndroidKotlinMethodCalls()',
    'resolveAndroidKotlinCallTarget()',
    'resolveAndroidKotlinTypeTarget()',
    'addAndroidKotlinTypeReferenceEdges()',
    'addAndroidKotlinOverrideEdges()',
    'addAndroidKotlinAnnotationEdges()',
    'queryOverlay()',
    'scoreCandidate()',
    'selectGraphResults()',
    'formatStrictNativeMarkdown()',
    'formatNativeMarkdown()',
    'contextPackSourceRankingQueryFor()',
    'sanitizeContextPackBaseMarkdownSections()',
    'temporary allowed',
    'attach NanoFlow metadata.relation',
    'delegated upstream owner',
    'formatter duplicate hotspot',
    'source-ordering duplicate hotspot',
    'docs/codegraph-nanoflow-dedup-contract.json',
    'removal trigger',
    'verification gate',
    'codegraph:overlay:docs:validate',
    'codegraph:adapter:gate',
  ];
  const missingDedupAudit = dedupAuditRequired.filter(term => !text.includes(term));
  if (missingDedupAudit.length > 0) {
    errors.push(`${file} missing upstream CodeGraph de-duplication audit contract: ${missingDedupAudit.join(', ')}`);
  }
}

function validateStructuredDedupContract() {
  let manifest;
  try {
    manifest = readJson(DEDUP_CONTRACT_MANIFEST_PATH);
  } catch (error) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} missing structured de-duplication contract manifest`);
    return;
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} must be a JSON object`);
    return;
  }

  if (manifest.schemaVersion !== 1) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} schemaVersion must be 1`);
  }
  if (manifest.upstreamCodeGraphVersion !== '@colbymchenry/codegraph@1.5.0') {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} upstreamCodeGraphVersion must be @colbymchenry/codegraph@1.5.0`);
  }
  if (manifest.fixedVersionUpgradeProbe !== '--codegraph-target @colbymchenry/codegraph@<new-version>') {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} fixedVersionUpgradeProbe must use --codegraph-target @colbymchenry/codegraph@<new-version>`);
  }

  validateDedupManifestCapabilities(manifest);
  validateDedupManifestGateList(`${DEDUP_CONTRACT_MANIFEST_PATH} verificationGates`, manifest.verificationGates);

  const hotspots = Array.isArray(manifest.hotspots) ? manifest.hotspots : [];
  if (!Array.isArray(manifest.hotspots)) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspots must be an array`);
    return;
  }

  const requiredHotspots = [
    ...DEDUP_CONTRACT_REQUIRED_HOTSPOTS,
    ...DEDUP_CONTRACT_SOURCE_CONDITIONAL_HOTSPOTS
      .filter(([, sourcePath, sourceSymbol]) => dedupSourceDeclaresSymbol(sourcePath, sourceSymbol))
      .map(([name, sourcePath]) => [name, sourcePath]),
  ];
  const requiredSourcePathsByName = new Map(requiredHotspots);
  const hotspotNameCounts = new Map();
  for (let index = 0; index < hotspots.length; index += 1) {
    const entry = hotspots[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspot[${index}] must be an object`);
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!name.trim()) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspot[${index}] name must be a non-empty string`);
      continue;
    }
    hotspotNameCounts.set(name, (hotspotNameCounts.get(name) ?? 0) + 1);
    const sourcePath = typeof entry.sourcePath === 'string' ? entry.sourcePath : '';
    if (!sourcePath.trim()) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspot ${name} sourcePath must be a non-empty string`);
      continue;
    }
    validateDedupManifestHotspot(entry, name, requiredSourcePathsByName.get(name) ?? sourcePath);
  }
  for (const name of [...hotspotNameCounts.keys()].sort()) {
    if (hotspotNameCounts.get(name) > 1) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} duplicate hotspot name ${name}`);
    }
  }
  for (const [name] of requiredHotspots) {
    if (!hotspotNameCounts.has(name)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} missing de-duplication hotspot ${name}`);
    }
  }
  validateRequiredDedupManifestChildOwnership(hotspots);
  validateDiscoveredDedupManifestCoverage(
    'Android/Kotlin',
    DEDUP_CONTRACT_ANDROID_KOTLIN_SOURCE_PATH,
    DEDUP_CONTRACT_ANDROID_KOTLIN_DISCOVERY_PATTERN,
    hotspots,
  );
  validateDiscoveredDedupManifestCoverage(
    'TypeScript',
    DEDUP_CONTRACT_TYPESCRIPT_SOURCE_PATH,
    DEDUP_CONTRACT_TYPESCRIPT_DISCOVERY_PATTERN,
    hotspots,
  );
  validateDiscoveredDedupManifestCoverage(
    'query/formatter',
    DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH,
    DEDUP_CONTRACT_QUERY_FORMATTER_DISCOVERY_PATTERN,
    hotspots,
  );
  validateDiscoveredDedupManifestCoverage(
    'context-pack source-ordering',
    DEDUP_CONTRACT_CONTEXT_PACK_SOURCE_PATH,
    DEDUP_CONTRACT_CONTEXT_PACK_DISCOVERY_PATTERN,
    hotspots,
  );
}

function dedupSourceDeclaresSymbol(sourcePath, symbol) {
  try {
    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(?:function|const|let|var)\\s+${escapedSymbol}\\b`).test(readText(sourcePath));
  } catch {
    return false;
  }
}

function validateDedupManifestCapabilities(manifest) {
  const contract = manifest.nativeDelegationContract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} nativeDelegationContract must be an object`);
    return;
  }
  validateDedupManifestIncludesAll(
    'nativeDelegationContract.delegatedGenericCapabilities',
    contract.delegatedGenericCapabilities,
    ['TypeScript', 'symbol', 'import', 'export', 'call', 'impact', 'auto-sync', 'indexing', 'generic search ranking', 'callers/callees/impact'],
  );
  validateDedupManifestIncludesAll(
    'nativeDelegationContract.delegatedGenericCapabilities',
    contract.delegatedGenericCapabilities,
    ['native Markdown/JSON formatter section order', 'strict native output projection', 'context exploration source ordering'],
  );
  validateDedupManifestIncludesAll(
    'nativeDelegationContract.nanoFlowOwnedCapabilities',
    contract.nanoFlowOwnedCapabilities,
    ['project-specific semantics', 'output-quality policy', 'Codex host reliability', 'repository hard-rule anchors'],
  );
}

function validateDedupManifestIncludesAll(label, values, requiredTerms) {
  if (!Array.isArray(values)) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} ${label} must be an array`);
    return;
  }
  const joined = values.join('\n');
  for (const term of requiredTerms) {
    if (!joined.includes(term)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} ${label} missing ${term}`);
    }
  }
}

function validateDedupManifestGateList(label, values) {
  if (!Array.isArray(values)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (const gate of DEDUP_CONTRACT_REQUIRED_GATES) {
    if (!values.includes(gate)) {
      errors.push(`${label} missing ${gate}`);
    }
  }
}

function validateDedupManifestHotspot(entry, expectedName, expectedSourcePath) {
  const prefix = `${DEDUP_CONTRACT_MANIFEST_PATH} hotspot ${expectedName}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (entry.sourcePath !== expectedSourcePath) {
    errors.push(`${prefix} sourcePath must be ${expectedSourcePath}`);
  }
  if (entry.status !== 'temporary-allowed') {
    errors.push(`${prefix} status must be temporary-allowed`);
  }
  for (const field of DEDUP_CONTRACT_REQUIRED_HOTSPOT_FIELDS) {
    if (!(field in entry)) {
      errors.push(`${prefix} missing required field ${field}`);
    }
  }
  if (dedupManifestHotspotRequiresBoundaryFields(entry)) {
    for (const field of DEDUP_CONTRACT_BOUNDARY_REQUIRED_FIELDS) {
      if (!(field in entry)) {
        errors.push(`${prefix} missing required field ${field}`);
      }
    }
  }
  validateDedupManifestTextField(prefix, 'capabilityCategory', entry.capabilityCategory, ['duplicate hotspot']);
  validateDedupManifestTextField(prefix, 'language', entry.language, []);
  validateDedupManifestTextField(prefix, 'delegatedUpstreamOwner', entry.delegatedUpstreamOwner, ['native CodeGraph']);
  validateDedupManifestTextField(prefix, 'allowedPurpose', entry.allowedPurpose, ['NanoFlow', 'metadata.relation']);
  validateDedupManifestTextField(prefix, 'nativeOwnedCapability', entry.nativeOwnedCapability, ['native CodeGraph']);
  validateDedupManifestTextField(prefix, 'nanoFlowOwnedCapability', entry.nanoFlowOwnedCapability, ['NanoFlow']);
  validateDedupManifestTextField(prefix, 'forbiddenScope', entry.forbiddenScope, [
    'must not reimplement',
    'native auto-sync',
    'indexing',
    'generic search ranking',
    'callers/callees/impact',
  ]);
  validateDedupManifestTextField(prefix, 'forbiddenGenericBehavior', entry.forbiddenGenericBehavior, [
    'must not reimplement',
    'native auto-sync',
    'indexing',
    'generic search ranking',
    'callers/callees/impact',
  ]);
  validateDedupManifestTextField(prefix, 'removalTrigger', entry.removalTrigger, [
    'upstream',
    'extension point',
    'native projection hook',
  ]);
  validateDedupManifestTextField(prefix, 'upstreamHookNeeded', entry.upstreamHookNeeded, [
    'upstream',
    'hook',
  ]);
  validateDedupManifestTextField(prefix, 'removalCandidateWhen', entry.removalCandidateWhen, [
    'upstream',
  ]);
  validateDedupManifestBoundaryFields(prefix, entry);
  validateDedupManifestSymbolList(prefix, 'sourceSymbols', entry.sourceSymbols, { requireNonEmpty: true });
  validateDedupManifestSymbolList(prefix, 'coveredChildSymbols', entry.coveredChildSymbols, { requireNonEmpty: false });
  validateDedupManifestSymbolList(prefix, 'allowedRelations', entry.allowedRelations, { requireNonEmpty: true });
  if (!DEDUP_CONTRACT_REQUIRED_GATES.includes(entry.lastVerifiedGate)) {
    errors.push(`${prefix} lastVerifiedGate must be one of ${DEDUP_CONTRACT_REQUIRED_GATES.join(', ')}`);
  }
  validateDedupManifestGateList(`${prefix} verificationGate`, entry.verificationGate);
  validateDedupManifestHotspotSource(prefix, expectedName, expectedSourcePath, entry);
}

function dedupManifestHotspotRequiresBoundaryFields(entry) {
  const category = String(entry?.capabilityCategory ?? '');
  return category.includes('query/formatter')
    || category.includes('context-pack source-ordering');
}

function validateDedupManifestBoundaryFields(prefix, entry) {
  if (!dedupManifestHotspotRequiresBoundaryFields(entry)) return;
  if (!DEDUP_CONTRACT_ALLOWED_BOUNDARY_ROLES.has(entry.duplicateBoundaryRole)) {
    errors.push(`${prefix} duplicateBoundaryRole must be one of ${[...DEDUP_CONTRACT_ALLOWED_BOUNDARY_ROLES].join(', ')}`);
  }
  validateDedupManifestSymbolList(prefix, 'outputSurface', entry.outputSurface, { requireNonEmpty: true });
  for (const surface of arrayOfStrings(entry.outputSurface)) {
    if (!DEDUP_CONTRACT_ALLOWED_OUTPUT_SURFACES.has(surface)) {
      errors.push(`${prefix} outputSurface has unsupported value ${surface}`);
    }
  }
  if (!DEDUP_CONTRACT_ALLOWED_EXTENSION_FIELD_POLICIES.has(entry.extensionFieldPolicy)) {
    errors.push(`${prefix} extensionFieldPolicy must be one of ${[...DEDUP_CONTRACT_ALLOWED_EXTENSION_FIELD_POLICIES].join(', ')}`);
  }
  validateStrictNativeJsonFormatterBoundary(prefix, entry);
  validateStrictNativeMarkdownFormatterBoundary(prefix, entry);
  validateAugmentedMarkdownFormatterBoundary(prefix, entry);
  validateQueryRankingAndResultSelectionBoundary(prefix, entry);
}

function validateStrictNativeJsonFormatterBoundary(prefix, entry) {
  const outputSurface = arrayOfStrings(entry.outputSurface);
  if (entry.name !== 'toNativeJsonFormatterResponse()'
    && (entry.extensionFieldPolicy !== 'strict-native' || !outputSurface.includes('nativeJson'))) {
    return;
  }

  const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
  const coveredChildSymbols = new Set(arrayOfStrings(entry.coveredChildSymbols).map(normalizeDedupSymbolName));
  if (entry.duplicateBoundaryRole !== 'native-json-formatter') {
    errors.push(`${prefix} strict-native nativeJson hotspot must use duplicateBoundaryRole native-json-formatter`);
  }
  if (entry.name !== 'toNativeJsonFormatterResponse()') {
    errors.push(`${prefix} strict-native nativeJson hotspot must be named toNativeJsonFormatterResponse()`);
  }
  if (!sourceSymbols.has('toNativeJsonFormatterResponse')) {
    errors.push(`${prefix} strict-native nativeJson sourceSymbols must include toNativeJsonFormatterResponse`);
  }
  if (outputSurface.length !== 1 || outputSurface[0] !== 'nativeJson') {
    errors.push(`${prefix} strict-native nativeJson outputSurface must include only nativeJson`);
  }
  for (const symbol of [...sourceSymbols, ...coveredChildSymbols]) {
    if (isStrictNativeMarkdownSourceSymbol(symbol) || symbol === 'formatNativeMarkdown') {
      errors.push(`${prefix} strict-native nativeJson formatter must not include Markdown helper ${symbol}`);
    }
  }
}

function validateStrictNativeMarkdownFormatterBoundary(prefix, entry) {
  const outputSurface = arrayOfStrings(entry.outputSurface);
  if (entry.extensionFieldPolicy !== 'strict-native' || !outputSurface.includes('nativeMarkdown')) {
    return;
  }

  const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
  const coveredChildSymbols = new Set(arrayOfStrings(entry.coveredChildSymbols).map(normalizeDedupSymbolName));
  if (entry.name !== 'formatStrictNativeMarkdown()') {
    errors.push(`${prefix} strict-native nativeMarkdown hotspot must be named formatStrictNativeMarkdown()`);
  }
  if (!sourceSymbols.has('formatStrictNativeMarkdown')) {
    errors.push(`${prefix} strict-native nativeMarkdown sourceSymbols must include formatStrictNativeMarkdown`);
  }
  for (const symbol of ['formatNativeMarkdown', 'formatNanoFlowAugmentedMarkdown']) {
    if (sourceSymbols.has(symbol)) {
      errors.push(`${prefix} strict-native nativeMarkdown sourceSymbols must not include augmented formatter ${symbol}`);
    }
    if (coveredChildSymbols.has(symbol)) {
      errors.push(`${prefix} strict-native nativeMarkdown coveredChildSymbols must not include augmented formatter ${symbol}`);
    }
  }
  for (const symbol of [...sourceSymbols, ...coveredChildSymbols]) {
    if (isNativeJsonFormatterSourceSymbol(symbol)) {
      errors.push(`${prefix} strict-native nativeMarkdown formatter must not include native JSON helper ${symbol}`);
    }
  }
  if (outputSurface.includes('augmentedMarkdown')) {
    errors.push(`${prefix} strict-native nativeMarkdown outputSurface must not include augmentedMarkdown`);
  }
  validateStrictNativeMarkdownFormatterSourceBody(prefix, entry);
}

function validateAugmentedMarkdownFormatterBoundary(prefix, entry) {
  if (
    entry.duplicateBoundaryRole !== 'native-markdown-formatter'
    || entry.extensionFieldPolicy !== 'nanoflow-augmented'
  ) {
    return;
  }

  const outputSurface = arrayOfStrings(entry.outputSurface);
  const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
  const coveredChildSymbols = new Set(arrayOfStrings(entry.coveredChildSymbols).map(normalizeDedupSymbolName));
  if (outputSurface.includes('nativeMarkdown')) {
    errors.push(`${prefix} nanoflow-augmented native-markdown formatter outputSurface must not include nativeMarkdown`);
  }
  for (const symbol of [...sourceSymbols, ...coveredChildSymbols]) {
    if (symbol === 'formatStrictNativeMarkdown' || symbol.startsWith('strictNative')) {
      errors.push(`${prefix} nanoflow-augmented native-markdown formatter must not include strict-native helper ${symbol}`);
    }
  }
  validateAugmentedMarkdownFormatterSourceBody(prefix, entry);
}

function validateAugmentedMarkdownFormatterSourceBody(prefix, entry) {
  const sourcePath = String(entry?.sourcePath ?? '');
  if (!sourcePath) {
    return;
  }
  const absolutePath = path.join(root, sourcePath);
  if (!fs.existsSync(absolutePath)) {
    return;
  }
  const sourceText = fs.readFileSync(absolutePath, 'utf8');
  const sourceSymbols = arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName);
  const formatterSymbols = sourceSymbols.length > 0
    ? sourceSymbols
    : [normalizeDedupSymbolName(entry.name)];
  for (const symbol of formatterSymbols) {
    if (!symbol) continue;
    const body = extractFunctionBody(sourceText, symbol);
    if (body === null) {
      continue;
    }
    for (const { token, kind } of DEDUP_CONTRACT_AUGMENTED_MARKDOWN_FORBIDDEN_SOURCE_TOKENS) {
      if (body.includes(token)) {
        const action = kind === 'strict-native heading' ? 'render' : 'reference';
        errors.push(`${prefix} nanoflow-augmented native-markdown formatter source body must not ${action} ${kind} ${token}`);
      }
    }
  }
}

function validateStrictNativeMarkdownFormatterSourceBody(prefix, entry) {
  const sourcePath = String(entry?.sourcePath ?? '');
  if (!sourcePath) {
    return;
  }
  const absolutePath = path.join(root, sourcePath);
  if (!fs.existsSync(absolutePath)) {
    return;
  }
  const sourceText = fs.readFileSync(absolutePath, 'utf8');
  const formatterSymbols = [
    ...arrayOfStrings(entry.sourceSymbols),
    ...arrayOfStrings(entry.coveredChildSymbols),
    normalizeDedupSymbolName(entry.name),
  ]
    .map(normalizeDedupSymbolName)
    .filter(isStrictNativeMarkdownSourceSymbol);
  for (const symbol of [...new Set(formatterSymbols)]) {
    if (!symbol) continue;
    for (const body of extractFunctionBodies(sourceText, symbol)) {
      for (const { token, kind } of DEDUP_CONTRACT_STRICT_NATIVE_MARKDOWN_FORBIDDEN_SOURCE_TOKENS) {
        if (body.includes(token)) {
          errors.push(`${prefix} strict-native nativeMarkdown formatter source body must not reference ${kind} ${token}`);
        }
      }
    }
  }
}

function isStrictNativeMarkdownSourceSymbol(symbol) {
  return symbol === 'formatStrictNativeMarkdown'
    || symbol.startsWith('buildStrictNativeMarkdown')
    || symbol.startsWith('formatStrictNative')
    || symbol.startsWith('compareStrictNative')
    || symbol.startsWith('orderNativeProjection')
    || symbol.startsWith('strictNative');
}

function isNativeJsonFormatterSourceSymbol(symbol) {
  return symbol === 'toNativeJsonFormatterResponse'
    || symbol.startsWith('serializeNativeJson')
    || symbol.startsWith('nativeJsonEdge');
}

function validateQueryRankingAndResultSelectionBoundary(prefix, entry) {
  const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
  const outputSurface = arrayOfStrings(entry.outputSurface);
  const allowedPurpose = String(entry.allowedPurpose ?? '');
  const claimedOwnershipText = [
    entry.allowedPurpose,
    entry.nanoFlowOwnedCapability,
  ].map(value => String(value ?? '')).join('\n');

  if (entry.name === 'scoreCandidate()' || sourceSymbols.has('scoreCandidate')) {
    if (entry.duplicateBoundaryRole !== 'candidate-ranking') {
      errors.push(`${prefix} query ranking hotspot must use duplicateBoundaryRole candidate-ranking`);
    }
    if (!sourceSymbols.has('scoreCandidate')) {
      errors.push(`${prefix} candidate-ranking sourceSymbols must include scoreCandidate`);
    }
    validateDedupManifestTextField(prefix, 'allowedPurpose', entry.allowedPurpose, [
      'NanoFlow',
      'metadata.relation',
      'semantic',
      'boost',
    ]);
    if (!/\bproject[- ]semantic\b/i.test(allowedPurpose) && !/\bproject[- ]specific\b/i.test(allowedPurpose)) {
      errors.push(`${prefix} candidate-ranking allowedPurpose must stay project-semantic/project-specific`);
    }
    if (textClaimsGenericRankingAuthority(claimedOwnershipText)) {
      errors.push(`${prefix} candidate-ranking allowedPurpose must not claim generic native ranking/reordering authority`);
    }
    for (const surface of ['nativeJson', 'nativeMarkdown']) {
      if (outputSurface.includes(surface)) {
        errors.push(`${prefix} candidate-ranking outputSurface must not include ${surface}`);
      }
    }
  }

  if (entry.name === 'selectGraphResults()' || sourceSymbols.has('selectGraphResults')) {
    if (entry.duplicateBoundaryRole !== 'result-selection') {
      errors.push(`${prefix} result-selection hotspot must use duplicateBoundaryRole result-selection`);
    }
    if (!sourceSymbols.has('selectGraphResults')) {
      errors.push(`${prefix} result-selection sourceSymbols must include selectGraphResults`);
    }
    validateDedupManifestTextField(prefix, 'allowedPurpose', entry.allowedPurpose, [
      'NanoFlow',
      'metadata.relation',
      'exact filtering',
      'source-evidence',
    ]);
    if (textClaimsGenericSelectionAuthority(claimedOwnershipText)) {
      errors.push(`${prefix} result-selection allowedPurpose must not claim generic impact/search selection authority`);
    }
    if (entry.extensionFieldPolicy !== 'nanoflow-augmented') {
      errors.push(`${prefix} result-selection extensionFieldPolicy must be nanoflow-augmented`);
    }
  }
}

function textClaimsGenericRankingAuthority(text) {
  const normalized = String(text ?? '').toLowerCase();
  return /\breorder(?:ing)?\s+generic\b/.test(normalized)
    || /\bgeneric\s+(?:native\s+)?(?:search\s+)?ranking\b/.test(normalized)
    || /\bgeneric\s+lexical\s+ranking\b/.test(normalized)
    || /\bnative\s+ranking\b/.test(normalized);
}

function textClaimsGenericSelectionAuthority(text) {
  const normalized = String(text ?? '').toLowerCase();
  return /\bgeneric\s+(?:result\s+)?selection\b/.test(normalized)
    || /\bgeneric\s+search\s+selection\b/.test(normalized)
    || /\bgeneric\s+impact\s+traversal\b/.test(normalized)
    || /\bparallel\s+impact\s+traversal\b/.test(normalized);
}

function validateDedupManifestTextField(prefix, field, value, requiredTerms) {
  const text = String(value ?? '');
  if (!text.trim()) {
    errors.push(`${prefix} ${field} must be non-empty`);
    return;
  }
  for (const term of requiredTerms) {
    if (!text.includes(term)) {
      errors.push(`${prefix} ${field} missing ${term}`);
    }
  }
}

function validateDedupManifestSymbolList(prefix, field, values, options = {}) {
  if (!Array.isArray(values)) {
    errors.push(`${prefix} ${field} must be an array`);
    return;
  }
  if (options.requireNonEmpty && values.length === 0) {
    errors.push(`${prefix} ${field} must not be empty`);
  }
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`${prefix} ${field} entries must be non-empty strings`);
    }
  }
}

function validateDedupManifestHotspotSource(prefix, name, sourcePath, entry) {
  const absolutePath = path.join(root, sourcePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`${prefix} sourcePath does not exist: ${sourcePath}`);
    return;
  }
  const sourceText = fs.readFileSync(absolutePath, 'utf8');
  const requiredSymbols = new Set([
    name,
    ...arrayOfStrings(entry?.sourceSymbols),
    ...arrayOfStrings(entry?.coveredChildSymbols),
  ]);
  for (const symbol of requiredSymbols) {
    const symbolName = normalizeDedupSymbolName(symbol);
    if (!symbolName) continue;
    const symbolPattern = new RegExp(`\\b(?:function|const|let|var)\\s+${escapeRegex(symbolName)}\\b`);
    if (!symbolPattern.test(sourceText)) {
      errors.push(`${prefix} sourcePath ${sourcePath} does not define ${symbolName}()`);
    }
  }
}

function extractFunctionBody(sourceText, symbolName) {
  return extractFunctionBodies(sourceText, symbolName)[0] ?? null;
}

function extractFunctionBodies(sourceText, symbolName) {
  const declarationPattern = new RegExp(`\\bfunction\\s+${escapeRegex(symbolName)}\\s*\\(`, 'g');
  const bodies = [];
  for (const declaration of sourceText.matchAll(declarationPattern)) {
    const body = extractFunctionBodyAtDeclaration(sourceText, declaration);
    if (body !== null) {
      bodies.push(body);
    }
  }
  return bodies;
}

function extractFunctionBodyAtDeclaration(sourceText, declaration) {
  if (!declaration) {
    return null;
  }
  const openBrace = sourceText.indexOf('{', declaration.index + declaration[0].length);
  if (openBrace === -1) {
    return null;
  }

  let depth = 0;
  let state = 'code';
  for (let index = openBrace; index < sourceText.length; index++) {
    const char = sourceText[index];
    const next = sourceText[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        index++;
      }
      continue;
    }
    if (state === 'single-quote') {
      if (char === '\\') {
        index++;
      } else if (char === "'") {
        state = 'code';
      }
      continue;
    }
    if (state === 'double-quote') {
      if (char === '\\') {
        index++;
      } else if (char === '"') {
        state = 'code';
      }
      continue;
    }
    if (state === 'template') {
      if (char === '\\') {
        index++;
      } else if (char === '`') {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      state = 'line-comment';
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      index++;
      continue;
    }
    if (char === "'") {
      state = 'single-quote';
      continue;
    }
    if (char === '"') {
      state = 'double-quote';
      continue;
    }
    if (char === '`') {
      state = 'template';
      continue;
    }
    if (char === '{') {
      depth++;
      continue;
    }
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return sourceText.slice(openBrace + 1, index);
      }
    }
  }

  return null;
}

function validateDiscoveredDedupManifestCoverage(label, sourcePath, discoveryPattern, hotspots) {
  const absolutePath = path.join(root, sourcePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} ${label} de-dup sourcePath does not exist: ${sourcePath}`);
    return;
  }
  const sourceText = fs.readFileSync(absolutePath, 'utf8');
  const discovered = new Set(
    [...sourceText.matchAll(discoveryPattern)]
      .map(match => match[1])
      .filter(Boolean),
  );
  const registered = new Set(
    hotspots
      .filter(entry => entry?.sourcePath === sourcePath)
      .flatMap(dedupManifestSymbols)
      .filter(Boolean),
  );
  const missing = [...discovered].filter(symbol => !registered.has(symbol)).sort();
  if (missing.length > 0) {
    errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} missing ${label} de-duplication sourceSymbols or coveredChildSymbols: ${missing.join(', ')}`);
  }
}

function validateRequiredDedupManifestChildOwnership(hotspots) {
  for (const [label, owner, sourcePath, requiredChildren] of DEDUP_CONTRACT_REQUIRED_COVERED_CHILD_OWNERS) {
    const allSymbols = hotspots
      .filter(entry => sourcePath === null || entry?.sourcePath === sourcePath)
      .flatMap(dedupManifestSymbols);
    const ownerCoveredSymbols = hotspots
      .filter(entry => entry?.name === owner && (sourcePath === null || entry?.sourcePath === sourcePath))
      .flatMap(entry => arrayOfStrings(entry?.coveredChildSymbols).map(normalizeDedupSymbolName));
    const ownershipScope = sourcePath === null ? 'and nowhere else' : `for ${sourcePath} and nowhere else in that sourcePath`;
    for (const symbol of requiredChildren) {
      const ownerCount = ownerCoveredSymbols.filter(candidate => candidate === symbol).length;
      const totalCount = allSymbols.filter(candidate => candidate === symbol).length;
      if (ownerCount !== 1 || totalCount !== 1) {
        errors.push(`required ${label} covered child ${symbol} must occur exactly once in ${owner}.coveredChildSymbols ${ownershipScope} (owner=${ownerCount}, total=${totalCount})`);
      }
    }
  }
}

function dedupManifestSymbols(entry) {
  return [
    entry?.name,
    ...arrayOfStrings(entry?.sourceSymbols),
    ...arrayOfStrings(entry?.coveredChildSymbols),
  ].map(normalizeDedupSymbolName);
}

function arrayOfStrings(values) {
  return Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
}

function normalizeDedupSymbolName(value) {
  return String(value ?? '').trim().replace(/\(\)$/, '');
}

function validateSingleSharedTreeFreshnessContract(text, file) {
  const required = [
    'single shared tree',
    'freshness and multi-agent conflict handling',
    'pending index sync',
    'latest changed files',
    'current disk contents',
    'git status --short',
    'git diff --name-only',
    'claim file set',
    'file lease',
    'skipRefresh=true',
    'NANOFLOW_OVERLAY_SKIP_REFRESH=1',
    'codegraph:overlay:validate',
  ];
  const missing = required.filter(term => !text.includes(term));
  if (missing.length > 0) {
    errors.push(`${file} missing single shared tree freshness contract: ${missing.join(', ')}`);
  }
}

function validateLocalCodeGraphSourceSetup(text, file) {
  const sectionMatch = /## Local CodeGraph Source Setup[\s\S]*?(?=\n## |\s*$)/.exec(text);
  if (!sectionMatch) return;
  const section = sectionMatch[0];
  if (!/cd\s+D:\\Code\\tools\\codegraph/i.test(section)) return;
  const rawNanoFlowOverlayScript = /(?:^|\n)\s*npm\s+run\s+codegraph:overlay\b/i.test(section);
  const explicitNanoFlowOverlayScript = /npm\s+--prefix\s+D:\\Code\\dde\s+run\s+codegraph:overlay\b/i.test(section)
    || /(?:Push-Location|Set-Location|cd)\s+D:\\Code\\dde[\s\S]*?npm\s+run\s+codegraph:overlay\b/i.test(section);
  if (rawNanoFlowOverlayScript && !explicitNanoFlowOverlayScript) {
    errors.push(`${file} Local CodeGraph Source Setup must run NanoFlow npm scripts with D:\\Code\\dde cwd or --prefix`);
  }
}

function validateIssueRegistry(text) {
  const file = 'docs/codegraph-nanoflow-adaptation-issues.md';
  const openStart = text.indexOf('## Open Issues');
  const fixedStart = text.indexOf('## Fixed Issues');
  if (openStart < 0) {
    errors.push(`${file} missing ## Open Issues section`);
  }
  if (fixedStart < 0) {
    errors.push(`${file} missing ## Fixed Issues section`);
  }
  if (openStart >= 0 && fixedStart >= 0 && openStart > fixedStart) {
    errors.push(`${file} must list ## Open Issues before ## Fixed Issues`);
  }

  const issues = parseIssueRegistryEntries(text);
  const openIssueIds = [];
  const seenIssueIds = new Map();
  for (const issue of issues) {
    if (seenIssueIds.has(issue.id)) {
      errors.push(`${file} duplicate issue id ${issue.id}`);
    } else {
      seenIssueIds.set(issue.id, issue.start);
    }
    validateIssueRegistryEntry(file, issue, openStart, fixedStart);
    if (ISSUE_REGISTRY_OPEN_STATUSES.has(issue.fields.status)) {
      openIssueIds.push(issue.id);
    }
  }

  const openSection = openStart >= 0
    ? text.slice(openStart, fixedStart >= 0 ? fixedStart : undefined)
    : '';
  const openSectionSaysEmpty = /No active issues are recorded yet\./.test(openSection);
  if (openIssueIds.length > 0 && openSectionSaysEmpty) {
    errors.push(`${file} Open Issues says no active issues but contains open issue ids: ${openIssueIds.join(', ')}`);
  }
  if (openIssueIds.length === 0 && !openSectionSaysEmpty) {
    errors.push(`${file} Open Issues must say "No active issues are recorded yet." when no open issues exist`);
  }
}

function parseIssueRegistryEntries(text) {
  const headers = [...text.matchAll(/^##\s+(.+)$/gm)];
  return headers
    .map((match, index) => {
      const issueMatch = /^(CG-NF-\d{8}-\d{3}):\s+(.+)$/.exec(match[1]);
      if (!issueMatch) return null;
      const start = match.index ?? 0;
      const end = index + 1 < headers.length ? headers[index + 1].index ?? text.length : text.length;
      return {
        id: issueMatch[1],
        title: issueMatch[2],
        start,
        block: text.slice(start, end),
      };
    })
    .filter(Boolean)
    .map(issue => ({
      ...issue,
      fields: parseIssueRegistryFields(issue.block),
      fieldDiagnostics: parseIssueRegistryFieldDiagnostics(issue.block),
      nestedFields: {
        evidence: parseIssueRegistryNestedFields(issue.block, 'evidence'),
        freshness_checks: parseIssueRegistryNestedFields(issue.block, 'freshness_checks'),
      },
      nestedFieldDiagnostics: {
        evidence: parseIssueRegistryNestedFieldDiagnostics(issue.block, 'evidence'),
        freshness_checks: parseIssueRegistryNestedFieldDiagnostics(issue.block, 'freshness_checks'),
      },
    }));
}

function parseIssueRegistryFields(block) {
  const fields = {};
  for (const match of block.matchAll(/^- ([a-z_]+):\s*(.*)$/gm)) {
    fields[match[1]] = match[2].trim();
  }
  return fields;
}

function parseIssueRegistryFieldDiagnostics(block) {
  const counts = new Map();
  const duplicateFields = new Set();
  const unknownFields = new Set();
  for (const match of block.matchAll(/^- ([a-z_]+):\s*(.*)$/gm)) {
    const field = match[1];
    const count = counts.get(field) ?? 0;
    counts.set(field, count + 1);
    if (count > 0) {
      duplicateFields.add(field);
    }
    if (!ISSUE_REGISTRY_ALLOWED_FIELDS.has(field)) {
      unknownFields.add(field);
    }
  }
  return {
    duplicateFields: [...duplicateFields],
    unknownFields: [...unknownFields],
  };
}

function parseIssueRegistryNestedFields(block, parentField) {
  const lines = String(block ?? '').split(/\r?\n/);
  const fields = {};
  let inSection = false;
  for (const line of lines) {
    if (new RegExp(`^- ${escapeRegex(parentField)}:\\s*$`).test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^- [a-z_]+:/.test(line) || /^##\s+/.test(line)) {
      break;
    }
    const nestedMatch = /^  - ([a-z_]+):\s*(.*)$/.exec(line);
    if (nestedMatch) {
      fields[nestedMatch[1]] = nestedMatch[2].trim();
    }
  }
  return fields;
}

function parseIssueRegistryNestedFieldDiagnostics(block, parentField) {
  const lines = String(block ?? '').split(/\r?\n/);
  const counts = new Map();
  const duplicateFields = new Set();
  const unknownFields = new Set();
  const allowedFields = new Set(ISSUE_REGISTRY_REQUIRED_NESTED_FIELDS[parentField] ?? []);
  let inSection = false;
  for (const line of lines) {
    if (new RegExp(`^- ${escapeRegex(parentField)}:\\s*$`).test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^- [a-z_]+:/.test(line) || /^##\s+/.test(line)) {
      break;
    }
    const nestedMatch = /^  - ([a-z_]+):\s*(.*)$/.exec(line);
    if (!nestedMatch) continue;
    const field = nestedMatch[1];
    const count = counts.get(field) ?? 0;
    counts.set(field, count + 1);
    if (count > 0) {
      duplicateFields.add(field);
    }
    if (!allowedFields.has(field)) {
      unknownFields.add(field);
    }
  }
  return {
    duplicateFields: [...duplicateFields],
    unknownFields: [...unknownFields],
  };
}

function validateIssueRegistryEntry(file, issue, openStart, fixedStart) {
  for (const field of issue.fieldDiagnostics?.duplicateFields ?? []) {
    errors.push(`${file} ${issue.id} duplicate field ${field}`);
  }
  for (const field of issue.fieldDiagnostics?.unknownFields ?? []) {
    errors.push(`${file} ${issue.id} unknown field ${field}`);
  }
  for (const field of ISSUE_REGISTRY_REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(issue.fields, field)) {
      errors.push(`${file} ${issue.id} missing required field ${field}`);
    }
  }
  const status = issue.fields.status;
  if (!ISSUE_REGISTRY_ALLOWED_STATUSES.has(status)) {
    errors.push(`${file} ${issue.id} has invalid status ${status || '(missing)'}`);
  }
  if (
    Object.prototype.hasOwnProperty.call(issue.fields, 'reported_at')
    && !isValidIsoDate(issue.fields.reported_at)
  ) {
    errors.push(`${file} ${issue.id} reported_at must be an ISO YYYY-MM-DD date`);
  }
  if (Object.prototype.hasOwnProperty.call(issue.fields, 'verification_gate') && !issue.fields.verification_gate) {
    errors.push(`${file} ${issue.id} verification_gate must not be empty`);
  }
  if (
    Object.prototype.hasOwnProperty.call(issue.fields, 'verification_gate')
    && issue.fields.verification_gate
    && !isConcreteVerificationGate(issue.fields.verification_gate)
  ) {
    errors.push(`${file} ${issue.id} verification_gate must be a concrete command`);
  }
  validateIssueRegistryVerificationGate(file, issue);
  validateIssueRegistryEnumList(file, issue.id, 'query_surface', issue.fields.query_surface, ISSUE_REGISTRY_ALLOWED_QUERY_SURFACES);
  validateIssueRegistryEnumList(file, issue.id, 'likely_root_cause', issue.fields.likely_root_cause, ISSUE_REGISTRY_ALLOWED_ROOT_CAUSES);
  validateIssueRegistryEnumList(file, issue.id, 'repair_target', issue.fields.repair_target, ISSUE_REGISTRY_ALLOWED_REPAIR_TARGETS);
  validateIssueRegistryEnumValue(file, issue.id, 'doc_update_needed', issue.fields.doc_update_needed, ISSUE_REGISTRY_ALLOWED_DOC_UPDATE_VALUES);
  validateIssueRegistryNestedFields(file, issue);
  validateIssueRegistryFreshnessConsistency(file, issue);
  for (const field of ISSUE_REGISTRY_REQUIRED_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(issue.fields, field)
      && hasIssueRegistryPlaceholder(issue.fields[field])
    ) {
      errors.push(`${file} ${issue.id} field ${field} contains template placeholder`);
    }
  }
  if (ISSUE_REGISTRY_OPEN_STATUSES.has(status) && fixedStart >= 0 && issue.start > fixedStart) {
    errors.push(`${file} ${issue.id} has open status ${status} but is listed under Fixed Issues`);
  }
  if (ISSUE_REGISTRY_CLOSED_STATUSES.has(status) && openStart >= 0 && fixedStart >= 0 && issue.start > openStart && issue.start < fixedStart) {
    errors.push(`${file} ${issue.id} has closed status ${status} but is listed under Open Issues`);
  }
}

function validateIssueRegistryNestedFields(file, issue) {
  for (const [parentField, requiredFields] of Object.entries(ISSUE_REGISTRY_REQUIRED_NESTED_FIELDS)) {
    const nestedFields = issue.nestedFields?.[parentField] ?? {};
    const diagnostics = issue.nestedFieldDiagnostics?.[parentField] ?? {};
    for (const nestedField of diagnostics.duplicateFields ?? []) {
      errors.push(`${file} ${issue.id} duplicate nested field ${parentField}.${nestedField}`);
    }
    for (const nestedField of diagnostics.unknownFields ?? []) {
      errors.push(`${file} ${issue.id} unknown nested field ${parentField}.${nestedField}`);
    }
    for (const nestedField of requiredFields) {
      if (!Object.prototype.hasOwnProperty.call(nestedFields, nestedField)) {
        errors.push(`${file} ${issue.id} missing required nested field ${parentField}.${nestedField}`);
        continue;
      }
      if (hasIssueRegistryPlaceholder(nestedFields[nestedField])) {
        errors.push(`${file} ${issue.id} field ${parentField}.${nestedField} contains template placeholder`);
      }
      if (parentField === 'freshness_checks') {
        validateIssueRegistryEnumValue(
          file,
          issue.id,
          `${parentField}.${nestedField}`,
          nestedFields[nestedField],
          ISSUE_REGISTRY_ALLOWED_FRESHNESS_VALUES[nestedField],
        );
      }
    }
  }
}

function validateIssueRegistryVerificationGate(file, issue) {
  const value = issue.fields.verification_gate;
  if (!value) return;
  const command = unwrapBacktickValue(value);
  const scripts = getPackageScripts();
  for (const scriptName of extractNpmRunScripts(command)) {
    if (!Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
      errors.push(`${file} ${issue.id} verification_gate references missing npm script ${scriptName}`);
    }
  }
}

function extractNpmRunScripts(command) {
  const scripts = [];
  const pattern = /\bnpm\b(?:\s+(?:--[^\s;`]+|-[^\s;`]+))*\s+run\s+([^\s;`]+)/g;
  for (const match of command.matchAll(pattern)) {
    const scriptName = String(match[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
    if (scriptName) {
      scripts.push(scriptName);
    }
  }
  return scripts;
}

function validateIssueRegistryFreshnessConsistency(file, issue) {
  const surfaces = splitIssueRegistryList(issue.fields.query_surface);
  const freshness = issue.nestedFields?.freshness_checks ?? {};
  const usesMcp = surfaces.some(surface => surface === 'nanoflow_context_pack' || surface === 'nanoflow_overlay_query');
  const usesAdapterFallback = surfaces.some(surface => surface === 'adapter-context-cli' || surface === 'overlay-query-cli');
  if (usesMcp && freshness.mcp_result === 'not-run') {
    errors.push(`${file} ${issue.id} freshness_checks.mcp_result cannot be not-run for MCP query surfaces`);
  }
  if (usesAdapterFallback && freshness.adapter_fallback_result === 'not-run') {
    errors.push(`${file} ${issue.id} freshness_checks.adapter_fallback_result cannot be not-run for adapter fallback query surfaces`);
  }
  if (
    (freshness.mcp_result === 'failed' || freshness.mcp_result === 'not-available')
    && freshness.adapter_fallback_result === 'not-run'
  ) {
    errors.push(`${file} ${issue.id} freshness_checks.adapter_fallback_result cannot be not-run when MCP failed or was unavailable`);
  }
  if (
    freshness.transport_failure === 'yes'
    && !splitIssueRegistryList(issue.fields.likely_root_cause).includes('transport')
  ) {
    errors.push(`${file} ${issue.id} transport_failure=yes requires likely_root_cause to include transport`);
  }
}

function splitIssueRegistryList(value) {
  return String(value ?? '')
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);
}

function validateIssueRegistryEnumList(file, issueId, field, value, allowedValues) {
  if (value === undefined) return;
  const values = String(value)
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);
  if (values.length === 0) {
    errors.push(`${file} ${issueId} field ${field} must list at least one value`);
    return;
  }
  for (const item of values) {
    validateIssueRegistryEnumValue(file, issueId, field, item, allowedValues);
  }
}

function validateIssueRegistryEnumValue(file, issueId, field, value, allowedValues) {
  if (value === undefined || !allowedValues) return;
  const normalizedValue = String(value ?? '').trim();
  if (!allowedValues.has(normalizedValue)) {
    errors.push(`${file} ${issueId} field ${field} has invalid value ${normalizedValue || '(empty)'}`);
  }
}

function hasIssueRegistryPlaceholder(value) {
  const text = String(value ?? '');
  return /<[^>]+>|\bYYYY-MM-DD\b|\bYYYYMMDD\b/.test(text);
}

function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isConcreteVerificationGate(value) {
  const command = unwrapBacktickValue(value);
  if (!command || NON_CONCRETE_VERIFICATION_GATE_PATTERN.test(command)) {
    return false;
  }
  return VERIFICATION_GATE_COMMAND_PATTERN.test(command);
}

function unwrapBacktickValue(value) {
  const raw = String(value ?? '').trim();
  return raw.startsWith('`') && raw.endsWith('`')
    ? raw.slice(1, -1).trim()
    : raw;
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

try { assertDocsTransactionClean(root); } catch (error) { errors.push(error.message); }
const overlay = readJson('.codegraph/nanoflow-overlay.json');
const baseline = buildBaseline(overlay);
validateOverlayGraphShape(overlay);
validateProjectSemanticCoverageContract(baseline);
validateAgents(readText('AGENTS.md'), baseline);
validateAdaptationDoc(readText('docs/codegraph-nanoflow-adaptation.md'), baseline);
validateStructuredDedupContract();
validateIssueRegistry(readText('docs/codegraph-nanoflow-adaptation-issues.md'));

if (errors.length > 0) {
  console.error('CodeGraph overlay documentation validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `CodeGraph overlay documentation validation passed (${formatNumber(baseline.graphNodes)} nodes, ${formatNumber(baseline.graphEdges)} edges; graph shape passed).`,
);
