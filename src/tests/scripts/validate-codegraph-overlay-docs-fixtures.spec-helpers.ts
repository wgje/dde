import fs from 'node:fs';
import path from 'node:path';

const dedupContractVerificationGates = [
  'npm run codegraph:overlay:docs:validate',
  'npm run codegraph:adapter:gate',
];

type DedupContractHotspotFixture = {
  name: string;
  sourcePath: string;
  language: string;
  sourceSymbols?: string[];
  coveredChildSymbols?: string[];
  allowedRelations?: string[];
  capabilityCategory?: string;
  duplicateBoundaryRole?: string;
  outputSurface?: string[];
  extensionFieldPolicy?: string;
};

const dedupContractHotspots: DedupContractHotspotFixture[] = [
  {
    name: 'collectTypeScript()',
    sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
    language: 'typescript',
    coveredChildSymbols: [
      'readTypeScriptStandardLibraryReferences',
      'collectTypeScriptStandardLibraryDeclarations',
    ],
  },
  { name: 'buildNativeGraph()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'typescript' },
  { name: 'buildImportAliasIndex()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'typescript' },
  { name: 'buildExportTargetIndex()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'typescript' },
  { name: 'resolveReferenceNodeId()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'typescript' },
  { name: 'addTypeScriptCallableEdges()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'typescript' },
  {
    name: 'collectAndroid()',
    sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
    language: 'kotlin/xml',
    coveredChildSymbols: ['readAndroidKotlinClasses', 'readAndroidKotlinFunctions'],
    allowedRelations: [
      'android-kotlin-class',
      'android-kotlin-resource-reference',
      'android-kotlin-source',
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
    ],
  },
  {
    name: 'readAndroidKotlinFileSymbols()',
    sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
    language: 'kotlin/xml',
    coveredChildSymbols: [
      'readAndroidKotlinImportsFromSource',
      'readAndroidKotlinHeritage',
      'readAndroidKotlinHeritageTypes',
      'readAndroidKotlinDeclarationEndLine',
      'readAndroidKotlinHeritageTypeName',
      'readAndroidKotlinHeritageType',
      'readAndroidKotlinCompanionObjectsFromSource',
      'readAndroidKotlinEnumMembersFromSource',
      'readAndroidKotlinEnumMemberSegment',
      'readAndroidKotlinConstructorsFromSource',
      'readAndroidKotlinPropertiesFromSource',
      'readAndroidKotlinPrimaryConstructorRanges',
      'readAndroidKotlinCompanionObjectRanges',
      'readAndroidKotlinPropertyDeclaration',
      'readAndroidKotlinLeadingAnnotations',
      'readAndroidKotlinInlineAnnotations',
      'readAndroidKotlinAnnotationLine',
      'readAndroidKotlinTypeReferencesFromTypeText',
      'readAndroidKotlinCallableOwnerClasses',
      'readAndroidKotlinClassTypeParametersEnd',
      'readAndroidKotlinMethodsFromSource',
      'readAndroidKotlinFunctionsFromSource',
      'readAndroidKotlinFunctionsFromNativeEndpoints',
      'readAndroidKotlinCallableTypeReferences',
      'readAndroidKotlinParameterTypeReferences',
      'readAndroidKotlinVisibility',
      'readAndroidKotlinSignatureBounds',
      'readAndroidKotlinCallableBodyBoundary',
    ],
    allowedRelations: ['android-kotlin-class', 'android-kotlin-function', 'android-kotlin-import', 'android-kotlin-annotation', 'android-kotlin-type-reference'],
  },
  { name: 'readAndroidKotlinMethodCalls()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'kotlin/xml', allowedRelations: ['android-kotlin-call'] },
  { name: 'resolveAndroidKotlinCallTarget()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'kotlin/xml', allowedRelations: ['android-kotlin-call'] },
  {
    name: 'resolveAndroidKotlinTypeTarget()',
    sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
    language: 'kotlin/xml',
    coveredChildSymbols: ['resolveAndroidKotlinHeritageDeclaration', 'resolveAndroidKotlinExternalHeritageTarget'],
    allowedRelations: ['android-kotlin-type-reference', 'android-kotlin-override'],
  },
  { name: 'addAndroidKotlinTypeReferenceEdges()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'kotlin/xml', allowedRelations: ['android-kotlin-type-reference'] },
  { name: 'addAndroidKotlinOverrideEdges()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'kotlin/xml', allowedRelations: ['android-kotlin-override'] },
  { name: 'addAndroidKotlinAnnotationEdges()', sourcePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs', language: 'kotlin/xml', allowedRelations: ['android-kotlin-annotation'] },
  {
    name: 'queryOverlay()',
    sourcePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
    language: 'overlay-json-markdown',
    capabilityCategory: 'query/formatter duplicate hotspot',
    duplicateBoundaryRole: 'query-parsing',
    outputSurface: ['contextJson', 'augmentedMarkdown'],
    extensionFieldPolicy: 'nanoflow-augmented',
    coveredChildSymbols: ['scoreNanoFlowSemanticCandidate', 'compareCandidateRank'],
  },
  {
    name: 'scoreCandidate()',
    sourcePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
    language: 'overlay-json-markdown',
    capabilityCategory: 'query/formatter duplicate hotspot',
    duplicateBoundaryRole: 'candidate-ranking',
    outputSurface: ['contextJson', 'augmentedMarkdown'],
    extensionFieldPolicy: 'nanoflow-augmented',
  },
  {
    name: 'selectGraphResults()',
    sourcePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
    language: 'overlay-json-markdown',
    capabilityCategory: 'query/formatter duplicate hotspot',
    duplicateBoundaryRole: 'result-selection',
    outputSurface: ['contextJson', 'nativeJson', 'nativeMarkdown', 'augmentedMarkdown'],
    extensionFieldPolicy: 'nanoflow-augmented',
    coveredChildSymbols: [
      'selectAngularSemanticApiEdges',
      'scoreNodeRelevanceForQuery',
      'sortAngularSemanticApiEdgesForSelection',
      'queryScoringContext',
      'lowInformationNodePenalty',
      'lowInformationFilePenalty',
      'queryAllowsTestFiles',
      'isLowInformationTestFilePath',
    ],
  },
  {
    name: 'formatStrictNativeMarkdown()',
    sourcePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
    language: 'overlay-json-markdown',
    capabilityCategory: 'query/formatter duplicate hotspot',
    duplicateBoundaryRole: 'native-markdown-formatter',
    outputSurface: ['nativeMarkdown'],
    extensionFieldPolicy: 'strict-native',
    coveredChildSymbols: [
      'strictNativeCodeBlockBudgetReached',
      'suppressedNativeCodeBlockNodeIds',
      'focusedExplicitPathCodeBlockFilePaths',
      'explicitPathNativeCodeBlockNodes',
      'exactRelationEndpointCodeBlockNodes',
      'prioritizeExactRelationCodeBlockEdges',
      'resolveNativeCodeBlockNode',
    ],
  },
  {
    name: 'formatNativeMarkdown()',
    sourcePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
    language: 'overlay-json-markdown',
    capabilityCategory: 'query/formatter duplicate hotspot',
    duplicateBoundaryRole: 'native-markdown-formatter',
    outputSurface: ['augmentedMarkdown'],
    extensionFieldPolicy: 'nanoflow-augmented',
    coveredChildSymbols: ['formatNanoFlowAugmentedMarkdown'],
  },
  {
    name: 'contextPackSourceRankingQueryFor()',
    sourcePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
    language: 'mcp-markdown',
    capabilityCategory: 'context-pack source-ordering duplicate hotspot',
    duplicateBoundaryRole: 'context-pack-source-ordering',
    outputSurface: ['nativeMarkdown', 'augmentedMarkdown'],
    extensionFieldPolicy: 'nanoflow-augmented',
    allowedRelations: ['metadata.relation', 'sourceSelection diagnostics'],
    coveredChildSymbols: [
      'contextPackExploreQueryFor',
      'queryTokens',
      'localizedContextPackQueryAliases',
      'summarizeContextPackQueryClassification',
      'classifyCodegraphDedupMaintenanceQuery',
      'queryMentionsCodegraphDedupMaintenance',
      'contextPackNodeMatchesQueryTerms',
      'isRenderableContextPackSourcePath',
      'contextPackSourceOrderingCanReorderBaseSourceBlocks',
      'contextPackSourceOrderingHasNanoFlowRelationEvidence',
      'queryMentionsCodegraphToolingSourcePollution',
      'queryExplicitlyRequestsContextPackSourcePath',
    ],
  },
  {
    name: 'sanitizeContextPackBaseMarkdownSections()',
    sourcePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
    language: 'mcp-markdown',
    capabilityCategory: 'context-pack source-ordering duplicate hotspot',
    duplicateBoundaryRole: 'context-pack-filter',
    outputSurface: ['nativeMarkdown', 'augmentedMarkdown'],
    extensionFieldPolicy: 'nanoflow-augmented',
    allowedRelations: ['metadata.relation', 'sourceSelection diagnostics'],
    coveredChildSymbols: [
      'summarizeContextPackSourceOrdering',
      'compareRelatedGraphNodeOrder',
      'relationshipEdgeSourceOrder',
      'contextPackRelationshipNodeQueryScore',
      'contextPackRelationshipNodePenalty',
    ],
  },
];

export function writeDedupContractFixture(root: string): void {
  for (const hotspot of dedupContractHotspots) {
    const { name, sourcePath } = hotspot;
    const absolutePath = path.join(root, sourcePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const symbols = new Set([
      name.replace(/\(\)$/, ''),
      ...(hotspot.sourceSymbols ?? []),
      ...(hotspot.coveredChildSymbols ?? []),
    ]);
    for (const symbol of symbols) {
      fs.appendFileSync(absolutePath, `function ${symbol.replace(/\(\)$/, '')}() {}\n`);
    }
  }
  fs.writeFileSync(
    path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json'),
    JSON.stringify({
      schemaVersion: 1,
      upstreamCodeGraphVersion: '@colbymchenry/codegraph@1.5.0',
      fixedVersionUpgradeProbe: '--codegraph-target @colbymchenry/codegraph@<new-version>',
      nativeDelegationContract: {
        delegatedGenericCapabilities: [
          'TypeScript symbol/import/export/call/impact discovery',
          'auto-sync',
          'indexing',
          'generic search ranking',
          'callers/callees/impact',
          'native Markdown/JSON formatter section order',
          'strict native output projection',
          'context exploration source ordering',
        ],
        nanoFlowOwnedCapabilities: [
          'project-specific semantics',
          'output-quality policy',
          'Codex host reliability',
          'repository hard-rule anchors',
        ],
      },
      verificationGates: dedupContractVerificationGates,
      hotspots: dedupContractHotspots.map(hotspot => ({
        name: hotspot.name,
        sourcePath: hotspot.sourcePath,
        status: 'temporary-allowed',
        delegatedUpstreamOwner: 'native CodeGraph',
        allowedPurpose: dedupFixtureAllowedPurpose(hotspot),
        forbiddenScope: 'must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact',
        removalTrigger: 'upstream extension point or native projection hook can carry NanoFlow relation metadata and source-evidence policy',
        capabilityCategory: hotspot.capabilityCategory ?? (hotspot.name.includes('Android') || hotspot.name.includes('Kotlin') || hotspot.name === 'collectAndroid()'
          ? 'Android/Kotlin duplicate hotspot'
          : 'duplicate hotspot'),
        language: hotspot.language,
        ...(hotspot.duplicateBoundaryRole ? { duplicateBoundaryRole: hotspot.duplicateBoundaryRole } : {}),
        ...(hotspot.outputSurface ? { outputSurface: hotspot.outputSurface } : {}),
        ...(hotspot.extensionFieldPolicy ? { extensionFieldPolicy: hotspot.extensionFieldPolicy } : {}),
        sourceSymbols: hotspot.sourceSymbols ?? [hotspot.name.replace(/\(\)$/, '')],
        coveredChildSymbols: hotspot.coveredChildSymbols ?? [],
        nativeOwnedCapability: 'native CodeGraph owns generic TypeScript/Kotlin symbols, calls, imports, auto-sync, indexing, generic search ranking, and callers/callees/impact',
        nanoFlowOwnedCapability: dedupFixtureNanoFlowOwnedCapability(hotspot),
        allowedRelations: hotspot.allowedRelations ?? ['metadata.relation'],
        forbiddenGenericBehavior: 'must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact',
        upstreamHookNeeded: 'upstream CodeGraph hook for NanoFlow metadata.relation and source evidence policy',
        removalCandidateWhen: 'upstream CodeGraph exposes a native projection hook for NanoFlow metadata.relation',
        lastVerifiedGate: 'npm run codegraph:overlay:docs:validate',
        verificationGate: dedupContractVerificationGates,
      })),
    }, null, 2),
  );
}

function dedupFixtureAllowedPurpose(hotspot: DedupContractHotspotFixture): string {
  if (hotspot.name === 'scoreCandidate()') {
    return 'attach NanoFlow metadata.relation semantic boosts and project-semantic source-evidence policy to native-shaped candidates';
  }
  if (hotspot.name === 'selectGraphResults()') {
    return 'attach NanoFlow metadata.relation exact filtering and source-evidence policy to native-shaped query results';
  }
  return 'attach NanoFlow metadata.relation to native-shaped endpoints';
}

function dedupFixtureNanoFlowOwnedCapability(hotspot: DedupContractHotspotFixture): string {
  if (hotspot.name === 'scoreCandidate()') {
    return 'NanoFlow owns project-specific metadata.relation semantic boosts and source evidence policy';
  }
  if (hotspot.name === 'selectGraphResults()') {
    return 'NanoFlow owns project-specific metadata.relation exact filtering and source evidence policy';
  }
  return 'NanoFlow owns project-specific semantics and metadata.relation attachment';
}
