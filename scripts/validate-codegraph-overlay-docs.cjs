#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildBaseline } = require('./lib/codegraph-overlay-baseline.cjs');
const { readOverlayCurrentReceipt } = require('./lib/codegraph-overlay-current-receipt.cjs');
const {
  PROJECT_SEMANTIC_COVERAGE_CONTRACTS,
  RELATION_METADATA_CONTRACTS,
  ZERO_REASON_COUNTERS,
} = require('./lib/codegraph-overlay-contract-manifest.cjs');
const { assertDocsTransactionClean } = require('./lib/codegraph-overlay-stability.cjs');
const { installDocContractValidator } = require('./lib/codegraph-overlay-doc-contract-validator.cjs');
const { installDedupContractValidator } = require('./lib/codegraph-overlay-dedup-contract-validator.cjs');
const { installIssueContractValidator } = require('./lib/codegraph-overlay-issue-contract-validator.cjs');
const args = process.argv.slice(2);
const rootArgIndex = args.indexOf('--root');
const root = path.resolve(rootArgIndex >= 0 ? args[rootArgIndex + 1] : process.cwd());
const agentContractRelativePath = fs.existsSync(path.join(root, 'docs', 'codegraph-nanoflow-agent-contract.md'))
  ? 'docs/codegraph-nanoflow-agent-contract.md'
  : 'AGENTS.md';
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
  /\b(?:function|const|let|var)\s+((?:queryOverlay|queryScoringContext|scoreCandidate|scoreNanoFlowSemanticCandidate|scoreGraphNode|scoreNodeRelevanceForQuery|scorePathSegmentCoverage|scoreNativeProjection[A-Za-z0-9_$]*|scorePreferredSourceFileGroupForQuery|scoreSourceFileGroupForQuery|rankNodesForQuery|rankGraphEdgesForQuery|orderRelatedFilesForQuery|compareCandidateRank|compareExactRelationEdgeDisplayOrder|compareNodeSpecificity|compareNode|compareEdge|compareSyncBodyKeywordEndpointPriority|compareSyncConfigKeywordEndpointPriority|compareExplicitPathCodeBlockCandidate|compareExactRelationEdgeSourceOrder|compareNodeSourceOrder|compareGeneratedFileOrder|selectEntryPoints|selectAngularSemanticApiEdges|selectNodeForCandidateMatch|selectedContext7RetrievalRouteIds|sortAngularSemanticApiEdgesForSelection|sortExactRelationEdgesForSelection|orderNativeProjectionItems|compareNativeProjectionRelevance|lowInformation(?:Node|File)Penalty|queryAllowsTestFiles|isLowInformationTestFilePath|focusedExplicitPathCodeBlockFilePaths|explicitPathNativeCodeBlockNodes|exactRelationEndpointCodeBlockNodes|prioritizeExactRelationCodeBlockEdges|resolveNativeCodeBlockNode|format(?:NativeMarkdown|NanoFlowAugmentedMarkdown|StrictNative(?:Markdown|RelatedSymbol|Location|FilePath|EdgeLocation)|EdgeSource|Summary|InlineFileList|EdgeMetadata|MatchSummary)|build(?:GraphIndexes|BlastRadiusEntries|NotShownEntries|RelationshipGroups|StrictNativeMarkdownRelationshipGroups|NativeCodeBlocks|ExactRelationEdgeCodeBlocks|ProvenanceEdgeLineCodeBlocks(?:ForQuery)?|SourceBlocks)|capRelationshipGroups|filterRelationshipGroupsForMarkdown|exactMetadataQuer(?:y|ies)From(?:Terms|Edges)|edgeMatches(?:ExactMetadataQuery|QueryTermsWithEndpoints|AnyQueryTermWithEndpoints)|suppressed(?:ExactRelationEntryPointIds|NativeCodeBlockNodeIds|ExactRelationCodeBlockEndpointIds)|strictNative(?:CodeBlockBudgetReached|EdgeEndpointName)|shouldSuppress(?:BroadNativeCodeBlock|LocalEvidenceEndpointForOwnerPreferredRelation)|compare(?:StrictNativeMarkdownEdges|StrictNativeRelatedNodeOrder|ExactRelationEdgeCodeBlockOrder|ProvenanceEdgeLineCodeBlockOrder|NativeCodeBlockNodeOrder|NullableSourceLine)|toNativeJsonFormatterResponse|serializeNativeJson(?:Node|Edge|CodeBlock)|nativeJsonEdge(?:Line|Column)|pushNativeCodeBlock(?:WithinNativeBudget)?|read(?:NodeCodeBlock|EdgeLineCodeBlock|SourceBlock)[A-Za-z0-9_$]*|formatSourceBlockSymbols|truncateMarkdownOutput|groupMarkdownRelatedNodesByFile|formatSourceWindows|selectNanoFlowRelationGraphResults|expandExactRelationEdges|markdownRelatedSymbolKey))\b/g;
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

function validateAgents(text, baseline) {
  const file = 'AGENTS.md';
  validateImmutableGenerationAuthorityContract(text, file);
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

const overlayValidatorRuntime = {
  fs, path, args, rootArgIndex,
  root, errors, MAX_GRAPH_ERRORS_PER_CATEGORY, ISSUE_REGISTRY_ALLOWED_STATUSES,
  ISSUE_REGISTRY_OPEN_STATUSES, ISSUE_REGISTRY_CLOSED_STATUSES, ISSUE_REGISTRY_REQUIRED_FIELDS, ISSUE_REGISTRY_ALLOWED_FIELDS,
  ISSUE_REGISTRY_REQUIRED_NESTED_FIELDS, ISSUE_REGISTRY_ALLOWED_QUERY_SURFACES, ISSUE_REGISTRY_ALLOWED_ROOT_CAUSES, ISSUE_REGISTRY_ALLOWED_REPAIR_TARGETS,
  ISSUE_REGISTRY_ALLOWED_DOC_UPDATE_VALUES, ISSUE_REGISTRY_ALLOWED_FRESHNESS_VALUES, VERIFICATION_GATE_COMMAND_PATTERN, NON_CONCRETE_VERIFICATION_GATE_PATTERN,
  DEDUP_CONTRACT_MANIFEST_PATH, DEDUP_CONTRACT_REQUIRED_GATES, DEDUP_CONTRACT_CONTEXT_PACK_SOURCE_PATH, DEDUP_CONTRACT_REQUIRED_COVERED_CHILD_OWNERS,
  DEDUP_CONTRACT_REQUIRED_HOTSPOTS, DEDUP_CONTRACT_SOURCE_CONDITIONAL_HOTSPOTS, DEDUP_CONTRACT_REQUIRED_HOTSPOT_FIELDS, DEDUP_CONTRACT_BOUNDARY_REQUIRED_FIELDS,
  DEDUP_CONTRACT_ALLOWED_BOUNDARY_ROLES, DEDUP_CONTRACT_ALLOWED_OUTPUT_SURFACES, DEDUP_CONTRACT_ALLOWED_EXTENSION_FIELD_POLICIES, DEDUP_CONTRACT_AUGMENTED_MARKDOWN_FORBIDDEN_SOURCE_TOKENS,
  DEDUP_CONTRACT_STRICT_NATIVE_MARKDOWN_FORBIDDEN_SOURCE_TOKENS, DEDUP_CONTRACT_ANDROID_KOTLIN_SOURCE_PATH, DEDUP_CONTRACT_TYPESCRIPT_SOURCE_PATH, DEDUP_CONTRACT_TYPESCRIPT_DISCOVERY_PATTERN,
  PROJECT_SEMANTIC_DOC_COUNTERS, DEDUP_CONTRACT_ANDROID_KOTLIN_DISCOVERY_PATTERN, DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH, DEDUP_CONTRACT_QUERY_FORMATTER_DISCOVERY_PATTERN,
  DEDUP_CONTRACT_CONTEXT_PACK_DISCOVERY_PATTERN, STRICT_NATIVE_SOURCE_EVIDENCE_REQUIRED_TERMS, OFFICIAL_CODEGRAPH_LANGUAGES, OFFICIAL_CODEGRAPH_NODE_KINDS,
  OFFICIAL_CODEGRAPH_EDGE_KINDS, OVERLAY_EXCLUDED_DIRS, MIGRATION_FILE_SOURCE_RELATIONS, REGISTERED_RELATIONS,
  REGISTERED_TEST_MAPPINGS, TEST_MAPPINGS_REQUIRING_MATCHED_NEEDLE, REGISTERED_KEYWORD_MAPPINGS, buildBaseline,
  PROJECT_SEMANTIC_COVERAGE_CONTRACTS, RELATION_METADATA_CONTRACTS, ZERO_REASON_COUNTERS, assertDocsTransactionClean,
};
Object.assign(overlayValidatorRuntime, {
  validateAgents, validateSourceOrderingDiagnostics, validateMcpLogGuardDiagnostics,
});
installDocContractValidator(overlayValidatorRuntime);
installDedupContractValidator(overlayValidatorRuntime);
installIssueContractValidator(overlayValidatorRuntime);
const {
  readJson, readText, formatNumber, readFirstNumber,
  expectNumber, validateOverlayGraphShape, validateProjectSemanticCoverageContract, validateImmutableGenerationAuthorityContract, validateAdaptationDoc,
  validateQueryPathRelevanceContract, validateCodexMcpConfigContract, validateStrictNativeSourceEvidenceContract, validateStrictNativeOutputOrderContract,
  validateStrictNativeObjectProjectionContract, validateAdapterGateContract, validateAdapterFirstFallbackContract, validateUpstreamCodeGraphBoundaryContract,
  validateStructuredDedupContract, validateSingleSharedTreeFreshnessContract, validateIssueRegistry, escapeRegex,
} = overlayValidatorRuntime;

try { assertDocsTransactionClean(root); } catch (error) { errors.push(error.message); }
const currentReceipt = readOverlayCurrentReceipt(root);
if (!currentReceipt.ok) {
  console.error('CodeGraph overlay documentation validation failed:');
  console.error(`- authenticated CURRENT unavailable: ${currentReceipt.errorCode}`);
  process.exit(1);
}
const overlay = currentReceipt.overlay;
const baseline = buildBaseline(overlay);
validateOverlayGraphShape(overlay);
validateProjectSemanticCoverageContract(baseline);
validateAgents(readText(agentContractRelativePath), baseline);
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
