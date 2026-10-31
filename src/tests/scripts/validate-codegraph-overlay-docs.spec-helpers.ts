import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureFixtureCurrentReceipt,
  installFixtureCurrentReceiptModuleLoader,
  restoreFixtureCurrentReceiptEnvironment,
  restoreFixtureCurrentReceiptModuleLoader,
  runSyncWithFixtureCurrentReceipt,
  runValidatorWithFixtureCurrentReceipt,
} from './codegraph-overlay-current-receipt-fixture.spec-helpers';
import { writeDedupContractFixture } from './validate-codegraph-overlay-docs-fixtures.spec-helpers';
import { buildValidateCodegraphOverlayDocsOverlayGraph } from './validate-codegraph-overlay-docs-overlay-graph.spec-helpers';

type BaseOverlayFixture = ReturnType<typeof buildValidateCodegraphOverlayDocsOverlayGraph>;
type OverlayFixtureRecord = Record<string, unknown>;

interface AndroidOverlayFixture {
  kotlinClasses: OverlayFixtureRecord[];
  kotlinEnums: OverlayFixtureRecord[];
  kotlinImports: OverlayFixtureRecord[];
  kotlinConstructors: OverlayFixtureRecord[];
  kotlinProperties: OverlayFixtureRecord[];
  kotlinMethods: OverlayFixtureRecord[];
  kotlinFunctions: OverlayFixtureRecord[];
  kotlinCalls: OverlayFixtureRecord[];
  kotlinResourceReferences: OverlayFixtureRecord[];
  manifestPermissions: OverlayFixtureRecord[];
  manifestQueries: OverlayFixtureRecord[];
  manifestComponents: OverlayFixtureRecord[];
  widgetProviders: OverlayFixtureRecord[];
  resourceReferences: OverlayFixtureRecord[];
}

interface Context7OverlayFixture {
  documents: OverlayFixtureRecord[];
  categories: OverlayFixtureRecord[];
  retrievalRoutes: OverlayFixtureRecord[];
  sourceMapRoutes: OverlayFixtureRecord[];
}

type ValidateDocsOverlayFixture = Omit<BaseOverlayFixture, 'angular'> & {
  angular: BaseOverlayFixture['angular'] & {
    directives?: OverlayFixtureRecord[];
    pipes?: OverlayFixtureRecord[];
    injectables?: OverlayFixtureRecord[];
    injectors?: OverlayFixtureRecord[];
    applicationProviders?: OverlayFixtureRecord[];
  };
  android?: AndroidOverlayFixture;
  context7?: Context7OverlayFixture;
};

export const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'validate-codegraph-overlay-docs.cjs');
const syncScriptPath = path.join(repoRoot, 'scripts', 'sync-codegraph-overlay-docs.cjs');
installFixtureCurrentReceiptModuleLoader();
export const packageJsonPath = path.join(repoRoot, 'package.json');
export const agentsDocPath = path.join(repoRoot, 'docs', 'codegraph-nanoflow-agent-contract.md');
export const adaptationDocPath = path.join(repoRoot, 'docs', 'codegraph-nanoflow-adaptation.md');
export const testFullSuiteWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'test-full-suite.yml');
export const overlayBaselineModulePath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-baseline.cjs');
export const validatorScriptPath = scriptPath;
export const syncDocsScriptPath = syncScriptPath;
const tempRoots: string[] = [];

export function makeFixture(options: {
  graphNodesInDocs?: number;
  graphEdgesInDocs?: number;
  dynamicImportEdgesInDocs?: number;
  angularRouteGuardEdgesInDocs?: number;
  edgeFunctionTestsInDocs?: number;
  edgeFunctionHeaderEdgesInDocs?: number;
  hardRulesInDocs?: number;
  hardRuleKeywordNodesInDocs?: number;
  hardRuleKeywordEdgesInDocs?: number;
  hardRuleKeywordMappingEdgesInDocs?: number;
  hardRuleImplementationTargetsInDocs?: number;
  configRulesInDocs?: number;
  syncRuleNodesInDocs?: number;
  syncRuleKeywordNodesInDocs?: number;
  syncRuleKeywordEdgesInDocs?: number;
  configPropertyNodesInDocs?: number;
  configPropertyEdgesInDocs?: number;
  configPropertyParentEdgesInDocs?: number;
  configSourcePropertyEdgesInDocs?: number;
  syncConfigSourceEdgesInDocs?: number;
  migrationFunctionDetailsInDocs?: number;
  migrationSqlFunctionFunctionNodesInDocs?: number;
  migrationTriggersInDocs?: number;
  migrationTriggerEdgesInDocs?: number;
  migrationIndexNodesInDocs?: number;
  migrationConstraintNodesInDocs?: number;
  migrationConstraintValidationNodesInDocs?: number;
  migrationRlsDetailsInDocs?: number;
  migrationTestsInDocs?: number;
  migrationTestEdgesInDocs?: number;
  policyDetailsInDocs?: number;
  policyNodesInDocs?: number;
  policyRoleEdgesInDocs?: number;
  policyUsingEdgesInDocs?: number;
  policyWithCheckEdgesInDocs?: number;
  privilegeNodesInDocs?: number;
  privilegeObjectNodesInDocs?: number;
  privilegeObjectEdgesInDocs?: number;
  privilegeRoleNodesInDocs?: number;
  privilegeRoleEdgesInDocs?: number;
  supabaseRealtimeChannelNodesInDocs?: number;
  supabaseRealtimePostgresChangeNodesInDocs?: number;
  supabaseRealtimeRemoveChannelNodesInDocs?: number;
  supabaseRealtimeUnsubscribeNodesInDocs?: number;
  supabaseRealtimeRemoveAllChannelsNodesInDocs?: number;
  supabaseSelectFieldNodesInDocs?: number;
  inlineSelectFieldNodesInDocs?: number;
  supabaseIncrementalPredicateNodesInDocs?: number;
  supabaseStorageBucketNodesInDocs?: number;
  supabaseRpcNodesInDocs?: number;
  supabaseTableWriteNodesInDocs?: number;
  realtimeStatusLayerCountInDocs?: number;
  templateUrlEdgesInDocs?: number;
  styleUrlEdgesInDocs?: number;
  totalTestEdgesInDocs?: number;
  testEdgesWithMatchedNeedleInDocs?: number;
  androidKotlinClassesInDocs?: number;
  androidKotlinDataClassesInDocs?: number;
  androidKotlinSealedClassesInDocs?: number;
  androidKotlinInterfacesInDocs?: number;
  androidKotlinInterfaceEdgesInDocs?: number;
  androidKotlinExtendsEdgesInDocs?: number;
  androidKotlinImplementsEdgesInDocs?: number;
  androidKotlinEnumsInDocs?: number;
  androidKotlinObjectsInDocs?: number;
  androidKotlinObjectEdgesInDocs?: number;
  androidKotlinCompanionObjectsInDocs?: number;
  androidKotlinCompanionObjectEdgesInDocs?: number;
  androidKotlinEnumMembersInDocs?: number;
  androidKotlinEnumMemberEdgesInDocs?: number;
  androidKotlinImportsInDocs?: number;
  androidKotlinImportEdgesInDocs?: number;
  androidKotlinConstructorsInDocs?: number;
  androidKotlinConstructorEdgesInDocs?: number;
  androidKotlinPropertiesInDocs?: number;
  androidKotlinPropertyEdgesInDocs?: number;
  androidKotlinMethodsInDocs?: number;
  androidKotlinMethodEdgesInDocs?: number;
  androidKotlinFunctionsInDocs?: number;
  androidKotlinFunctionEdgesInDocs?: number;
  androidKotlinOverrideEdgesInDocs?: number;
  androidKotlinTypeReferenceEdgesInDocs?: number;
  androidKotlinCallsInDocs?: number;
  androidKotlinCallEdgesInDocs?: number;
  androidKotlinAnnotationsInDocs?: number;
  androidKotlinAnnotationEdgesInDocs?: number;
  androidManifestComponentsInDocs?: number;
  androidWidgetProvidersInDocs?: number;
  androidResourceReferencesInDocs?: number;
} = {}): string {
  installFixtureCurrentReceiptModuleLoader();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-docs-'));
	  tempRoots.push(root);
	  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
	  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
	  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
	  configureFixtureCurrentReceipt(root);
	  fs.writeFileSync(
	    path.join(root, 'package.json'),
	    JSON.stringify({
	      scripts: {
	        'codegraph:overlay:test': 'vitest run src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
	      },
	    }, null, 2),
	  );
  writeDedupContractFixture(root);
  const overlay: ValidateDocsOverlayFixture = buildValidateCodegraphOverlayDocsOverlayGraph();
  const hasFixtureOption = (name: string): boolean => Object.prototype.hasOwnProperty.call(options, name);
  const androidConstructorPropertyDrift = [
    'androidKotlinConstructorsInDocs',
    'androidKotlinConstructorEdgesInDocs',
    'androidKotlinPropertiesInDocs',
    'androidKotlinPropertyEdgesInDocs',
  ].some(hasFixtureOption);
  const androidImportDrift = [
    'androidKotlinImportsInDocs',
    'androidKotlinImportEdgesInDocs',
  ].some(hasFixtureOption);
  const androidOverrideTypeDrift = [
    'androidKotlinOverrideEdgesInDocs',
    'androidKotlinTypeReferenceEdgesInDocs',
  ].some(hasFixtureOption);
  const androidFunctionDrift = [
    'androidKotlinFunctionsInDocs',
    'androidKotlinFunctionEdgesInDocs',
  ].some(hasFixtureOption);
  const androidPlatformDrift = [
    'androidManifestComponentsInDocs',
    'androidWidgetProvidersInDocs',
    'androidResourceReferencesInDocs',
  ].some(hasFixtureOption);
  const graphSource = overlay.graph.nodes[0].id;
  const graphTarget = overlay.graph.nodes[1].id;
  const addFixtureEdge = (
    kind: string,
    relation: string,
    metadata: Record<string, unknown> = {},
  ): void => {
    overlay.graph.edges.push({
      source: graphSource,
      target: graphTarget,
      kind,
      metadata: { relation, ...metadata },
    });
  };
  overlay.angular = {
    ...overlay.angular,
    directives: [{}],
    pipes: [{}],
    injectables: [{}],
    injectors: [{ dependencies: ['SampleDependency'] }],
    applicationProviders: [{}],
  };
  for (const [kind, relation] of [
    ['imports', 'standalone-import'],
    ['references', 'input'],
    ['calls', 'output'],
    ['references', 'query'],
    ['calls', 'signal'],
  ]) {
    addFixtureEdge(kind, relation);
  }
  overlay.android = {
    kotlinClasses: [
      { modifiers: ['data'], annotations: [{ name: 'Serializable' }] },
      { classKind: 'object', isCompanionObject: false },
      { classKind: 'object', isCompanionObject: true },
    ],
    kotlinEnums: [{ members: [{}] }],
    kotlinImports: androidImportDrift ? [] : [{}],
    kotlinConstructors: androidConstructorPropertyDrift ? [] : [{}],
    kotlinProperties: androidConstructorPropertyDrift ? [] : [{}],
    kotlinMethods: [{}],
    kotlinFunctions: androidFunctionDrift ? [] : [{}],
    kotlinCalls: [{}],
    kotlinResourceReferences: androidPlatformDrift ? [] : [{}],
    manifestPermissions: androidPlatformDrift ? [] : [{}],
    manifestQueries: androidPlatformDrift ? [] : [{}],
    manifestComponents: androidPlatformDrift ? [] : [{
      permission: 'android.permission.BIND_APPWIDGET',
      intentFilters: [{ actions: [{}], categories: [{}], data: [{}] }],
    }],
    widgetProviders: androidPlatformDrift ? [] : [{}],
    resourceReferences: androidPlatformDrift ? [] : [{}],
  };
  const androidFixtureEdges = [
    ['extends', 'android-kotlin-extends'],
    ['implements', 'android-kotlin-implements'],
    ['contains', 'android-kotlin-object'],
    ['contains', 'android-kotlin-companion-object'],
    ['contains', 'android-kotlin-enum-member'],
    ['contains', 'android-kotlin-method'],
    ['calls', 'android-kotlin-call'],
    ['decorates', 'android-kotlin-annotation'],
    ...(!androidImportDrift ? [['imports', 'android-kotlin-import']] : []),
    ...(!androidConstructorPropertyDrift ? [
      ['contains', 'android-kotlin-constructor'],
      ['contains', 'android-kotlin-property'],
    ] : []),
  ];
  for (const [kind, relation] of androidFixtureEdges) {
    addFixtureEdge(kind, relation);
  }
  if (!androidPlatformDrift) {
    addFixtureEdge('references', 'android-manifest-uses-permission', {
      permission: 'android.permission.POST_NOTIFICATIONS',
      declarationType: 'uses-permission',
    });
    addFixtureEdge('references', 'android-manifest-query', {
      queryType: 'package',
      queryValue: 'com.example.calendar',
    });
    addFixtureEdge('references', 'android-manifest-component-permission', {
      componentType: 'receiver',
      className: 'SampleReceiver',
      permission: 'android.permission.BIND_APPWIDGET',
    });
    addFixtureEdge('references', 'android-manifest-intent-filter-action', { action: 'android.intent.action.VIEW' });
    addFixtureEdge('references', 'android-manifest-intent-filter-category', { category: 'android.intent.category.DEFAULT' });
    addFixtureEdge('references', 'android-manifest-intent-filter-data', { scheme: 'nanoflow' });
    addFixtureEdge('references', 'android-kotlin-resource-reference', {
      resourceType: 'string',
      resourceName: 'app_name',
    });
  }
  if (!androidFunctionDrift) {
    addFixtureEdge('contains', 'android-kotlin-function', {
      functionName: 'sampleFunction',
    });
  }
  if (!androidOverrideTypeDrift) {
    addFixtureEdge('overrides', 'android-kotlin-override', {
      memberName: 'sampleMember',
      targetName: 'Base::sampleMember',
    });
    addFixtureEdge('type_of', 'android-kotlin-type-reference', {
      typeName: 'SampleType',
      targetName: 'SampleType',
      typeRole: 'return',
    });
  }
  overlay.context7 = {
    documents: [{}],
    categories: [{ docs: ['docs/context7/index.md'] }],
    retrievalRoutes: [{
      query: 'sample',
      primary: 'docs/context7/index.md',
      secondary: ['docs/context7/source-map.md'],
    }],
    sourceMapRoutes: [{
      question: 'sample question',
      doc: 'docs/context7/index.md',
      sourcePaths: ['src/a.ts'],
    }],
  };

  fs.writeFileSync(
    path.join(root, '.codegraph', 'nanoflow-overlay.json'),
    JSON.stringify(overlay, null, 2),
  );

  const graphNodesInDocs = options.graphNodesInDocs ?? overlay.graph.nodes.length;
  const graphEdgesInDocs = options.graphEdgesInDocs ?? overlay.graph.edges.length;
  const dynamicImportEdgesInDocs = options.dynamicImportEdgesInDocs ?? 2;
  const angularRouteGuardEdgesInDocs = options.angularRouteGuardEdgesInDocs ?? 1;
  const edgeFunctionTestsInDocs = options.edgeFunctionTestsInDocs ?? 1;
  const edgeFunctionHeaderEdgesInDocs = options.edgeFunctionHeaderEdgesInDocs ?? 1;
  const hardRulesInDocs = options.hardRulesInDocs ?? 1;
  const hardRuleKeywordNodesInDocs = options.hardRuleKeywordNodesInDocs ?? 1;
  const hardRuleKeywordEdgesInDocs = options.hardRuleKeywordEdgesInDocs ?? 1;
  const hardRuleKeywordMappingEdgesInDocs = options.hardRuleKeywordMappingEdgesInDocs ?? 1;
  const hardRuleImplementationTargetsInDocs = options.hardRuleImplementationTargetsInDocs ?? 1;
  const configRulesInDocs = options.configRulesInDocs ?? 1;
  const syncRuleNodesInDocs = options.syncRuleNodesInDocs ?? 1;
  const syncRuleKeywordNodesInDocs = options.syncRuleKeywordNodesInDocs ?? 1;
  const syncRuleKeywordEdgesInDocs = options.syncRuleKeywordEdgesInDocs ?? 2;
  const configPropertyNodesInDocs = options.configPropertyNodesInDocs ?? 1;
  const configPropertyEdgesInDocs = options.configPropertyEdgesInDocs ?? 1;
  const configPropertyParentEdgesInDocs = options.configPropertyParentEdgesInDocs ?? 1;
  const configSourcePropertyEdgesInDocs = options.configSourcePropertyEdgesInDocs ?? 1;
  const syncConfigSourceEdgesInDocs = options.syncConfigSourceEdgesInDocs ?? 1;
  const migrationFunctionDetailsInDocs = options.migrationFunctionDetailsInDocs ?? 1;
  const migrationSqlFunctionFunctionNodesInDocs = options.migrationSqlFunctionFunctionNodesInDocs ?? 1;
  const migrationTriggersInDocs = options.migrationTriggersInDocs ?? 1;
  const migrationTriggerEdgesInDocs = options.migrationTriggerEdgesInDocs ?? 1;
  const migrationIndexNodesInDocs = options.migrationIndexNodesInDocs ?? 1;
  const migrationConstraintNodesInDocs = options.migrationConstraintNodesInDocs ?? 1;
  const migrationConstraintValidationNodesInDocs = options.migrationConstraintValidationNodesInDocs ?? 0;
  const migrationRlsDetailsInDocs = options.migrationRlsDetailsInDocs ?? 1;
  const migrationTestsInDocs = options.migrationTestsInDocs ?? 1;
  const migrationTestEdgesInDocs = options.migrationTestEdgesInDocs ?? 1;
  const policyDetailsInDocs = options.policyDetailsInDocs ?? 1;
  const policyNodesInDocs = options.policyNodesInDocs ?? 1;
  const policyRoleEdgesInDocs = options.policyRoleEdgesInDocs ?? 1;
  const policyUsingEdgesInDocs = options.policyUsingEdgesInDocs ?? 1;
  const policyWithCheckEdgesInDocs = options.policyWithCheckEdgesInDocs ?? 1;
  const privilegeNodesInDocs = options.privilegeNodesInDocs ?? 1;
  const privilegeObjectNodesInDocs = options.privilegeObjectNodesInDocs ?? 1;
  const privilegeObjectEdgesInDocs = options.privilegeObjectEdgesInDocs ?? 1;
  const privilegeRoleNodesInDocs = options.privilegeRoleNodesInDocs ?? 1;
  const privilegeRoleEdgesInDocs = options.privilegeRoleEdgesInDocs ?? 1;
  const supabaseRealtimeChannelNodesInDocs = options.supabaseRealtimeChannelNodesInDocs ?? 1;
  const supabaseRealtimePostgresChangeNodesInDocs = options.supabaseRealtimePostgresChangeNodesInDocs ?? 1;
  const supabaseRealtimeRemoveChannelNodesInDocs = options.supabaseRealtimeRemoveChannelNodesInDocs ?? 1;
  const supabaseRealtimeUnsubscribeNodesInDocs = options.supabaseRealtimeUnsubscribeNodesInDocs ?? 1;
  const supabaseRealtimeRemoveAllChannelsNodesInDocs = options.supabaseRealtimeRemoveAllChannelsNodesInDocs ?? 1;
  const supabaseSelectFieldNodesInDocs = options.supabaseSelectFieldNodesInDocs ?? 2;
  const inlineSelectFieldNodesInDocs = options.inlineSelectFieldNodesInDocs ?? 1;
  const supabaseIncrementalPredicateNodesInDocs = options.supabaseIncrementalPredicateNodesInDocs ?? 1;
  const supabaseStorageBucketNodesInDocs = options.supabaseStorageBucketNodesInDocs ?? 1;
  const supabaseRpcNodesInDocs = options.supabaseRpcNodesInDocs ?? 1;
  const supabaseTableWriteNodesInDocs = options.supabaseTableWriteNodesInDocs ?? 1;
  const realtimeStatusLayerCountInDocs = options.realtimeStatusLayerCountInDocs ?? 1;
  const templateUrlEdgesInDocs = options.templateUrlEdgesInDocs ?? 1;
  const styleUrlEdgesInDocs = options.styleUrlEdgesInDocs ?? 1;
  const totalTestEdgesInDocs = options.totalTestEdgesInDocs ?? 5;
  const testEdgesWithMatchedNeedleInDocs = options.testEdgesWithMatchedNeedleInDocs ?? 3;
  const androidKotlinClassesInDocs = options.androidKotlinClassesInDocs ?? 3;
  const androidKotlinDataClassesInDocs = options.androidKotlinDataClassesInDocs ?? 1;
  const androidKotlinSealedClassesInDocs = options.androidKotlinSealedClassesInDocs ?? 0;
  const androidKotlinInterfacesInDocs = options.androidKotlinInterfacesInDocs ?? 0;
  const androidKotlinInterfaceEdgesInDocs = options.androidKotlinInterfaceEdgesInDocs ?? 0;
  const androidKotlinExtendsEdgesInDocs = options.androidKotlinExtendsEdgesInDocs ?? 1;
  const androidKotlinImplementsEdgesInDocs = options.androidKotlinImplementsEdgesInDocs ?? 1;
  const androidKotlinEnumsInDocs = options.androidKotlinEnumsInDocs ?? 1;
  const androidKotlinObjectsInDocs = options.androidKotlinObjectsInDocs ?? 1;
  const androidKotlinObjectEdgesInDocs = options.androidKotlinObjectEdgesInDocs ?? 1;
  const androidKotlinCompanionObjectsInDocs = options.androidKotlinCompanionObjectsInDocs ?? 1;
  const androidKotlinCompanionObjectEdgesInDocs = options.androidKotlinCompanionObjectEdgesInDocs ?? 1;
  const androidKotlinEnumMembersInDocs = options.androidKotlinEnumMembersInDocs ?? 1;
  const androidKotlinEnumMemberEdgesInDocs = options.androidKotlinEnumMemberEdgesInDocs ?? 1;
  const androidKotlinImportsInDocs = options.androidKotlinImportsInDocs ?? 1;
  const androidKotlinImportEdgesInDocs = options.androidKotlinImportEdgesInDocs ?? 1;
  const androidKotlinConstructorsInDocs = options.androidKotlinConstructorsInDocs ?? 1;
  const androidKotlinConstructorEdgesInDocs = options.androidKotlinConstructorEdgesInDocs ?? 1;
  const androidKotlinPropertiesInDocs = options.androidKotlinPropertiesInDocs ?? 1;
  const androidKotlinPropertyEdgesInDocs = options.androidKotlinPropertyEdgesInDocs ?? 1;
  const androidKotlinMethodsInDocs = options.androidKotlinMethodsInDocs ?? 1;
  const androidKotlinMethodEdgesInDocs = options.androidKotlinMethodEdgesInDocs ?? 1;
  const androidKotlinFunctionsInDocs = options.androidKotlinFunctionsInDocs ?? 1;
  const androidKotlinFunctionEdgesInDocs = options.androidKotlinFunctionEdgesInDocs ?? 1;
  const androidKotlinOverrideEdgesInDocs = options.androidKotlinOverrideEdgesInDocs ?? 1;
  const androidKotlinTypeReferenceEdgesInDocs = options.androidKotlinTypeReferenceEdgesInDocs ?? 1;
  const androidKotlinCallsInDocs = options.androidKotlinCallsInDocs ?? 1;
  const androidKotlinCallEdgesInDocs = options.androidKotlinCallEdgesInDocs ?? 1;
  const androidKotlinAnnotationsInDocs = options.androidKotlinAnnotationsInDocs ?? 1;
  const androidKotlinAnnotationEdgesInDocs = options.androidKotlinAnnotationEdgesInDocs ?? 1;
  const androidManifestComponentsInDocs = options.androidManifestComponentsInDocs ?? 1;
  const androidWidgetProvidersInDocs = options.androidWidgetProvidersInDocs ?? 1;
  const androidResourceReferencesInDocs = options.androidResourceReferencesInDocs ?? 1;
  const androidManifestPermissionsInDocs = 1;
  const androidManifestQueriesInDocs = 1;
  const androidManifestComponentPermissionsInDocs = 1;
  const androidManifestIntentFiltersInDocs = 1;
  const androidManifestIntentFilterActionsInDocs = 1;
  const androidManifestIntentFilterCategoriesInDocs = 1;
  const androidManifestIntentFilterDataInDocs = 1;
  const androidKotlinResourceReferencesInDocs = 1;
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    [
      'Production overlay authority: `.codegraph/nanoflow-generations/CURRENT.json` selects one immutable `.codegraph/nanoflow-generations/<generation-id>/`; its `compatibility/nanoflow-overlay.json` is validated by `scripts/lib/codegraph-overlay-current-receipt.cjs` through `readOverlayCurrentReceipt(projectRoot)`.',
      'graphNodes=2',
      `graphEdges=${graphEdgesInDocs}`,
      'angularComponents=1',
      'angularDirectives=1',
      'angularPipes=1',
      'angularInjectables=1',
      'angularInjectorFiles=1',
      'angularInjectorDependencyReferences=1',
      'angularApplicationProviders=1',
      'standaloneImportEdges=1',
      'angularInputEdges=1',
      'angularOutputEdges=1',
      'angularModelEdges=0',
      'angularQueryEdges=1',
      'angularSignalEdges=1',
      'context7Documents=1',
      'context7Categories=1',
      'context7CategoryDocEdges=1',
      'context7RetrievalRoutes=1',
      'context7RetrievalPrimaryEdges=1',
      'context7RetrievalSecondaryEdges=1',
      'context7SourceMapRoutes=1',
      'context7SourceMapDocEdges=1',
      'context7SourceMapSourceEdges=1',
      'context-pack diagnostics include sourceOrdering, queryClassification, sourceOrdering.queryClassification, sourceSectionCount, duplicateSourceSectionCount, relationshipsSectionCount, duplicateRelationshipsSectionCount, relationshipKindSectionCounts, duplicateRelationshipKindSectionCount, relatedSymbolsSectionCount, duplicateRelatedSymbolsSectionCount, baseSourceReorderAllowed, firstSourceFiles, visibleSourceFileDetails, visibleIndex, rankedIndex, rankedOverlayFiles, rankedOverlayFileDetails, matchRank, nodeRank, matchScore, nodeScore, pathScore, symbolScore, sourceBlockScore, lowValuePenalty, rawLowValuePenalty, pathClassLowValue, codegraphToolingSource, dedupMaintenanceSource, explicitSymbolEvidence, preferredSymbolEvidence, explicitFileRequested, explicitPathRequested, explicitSourcePathRequested, rawTopRankedOverlayFile, topRankedOverlayFile, topRankedOverlayFileSelectionReason, topRankedOverlayFileSkippedLowValue, topRankedOverlayFileVisibleIndex, firstSourceBlockIsTopRankedOverlayFile, and topRankedOverlayFileMissing',
      'MCP log guard diagnostics include wrapperStarts, wrapperStarts.versions, wrapperStarts.latest.scriptSha256, currentWrapper, currentWrapper.runtimeTopology, currentWrapper.diskScriptSha256, currentWrapper.matchesDisk, currentWrapper.staleAgainstDisk, currentDiskWrapper, currentDiskWrapper.latestRequestKind, currentConfiguredWrapper, currentConfiguredWrapper.codegraphTarget, currentContextWrapper, currentContextWrapper.diskScriptSha256, currentContextWrapper.matchesDisk, currentContextWrapper.staleAgainstDisk, currentContextWrapper.latestTs, currentContextWrapper.latestRequestId, currentDiskContextWrapper, currentDiskContextWrapper.latestRequestKind, currentConfiguredContextWrapper, currentConfiguredContextWrapper.codegraphTarget, activeWrappers, activeWrappers.total, activeWrappers.runtimeTopologyModes, activeWrappers.directWatcherContentionRisk, activeWrappers.sharedDaemonProxyCount, activeWrappers.staleAgainstDisk, activeWrappers.distinctScriptSha256, activeWrappers.activeWindowMs, currentContextSourceOrdering, currentContextSourceOrdering.baseSectionFilteredLines, currentContextSourceOrdering.latestBaseSectionFiltering, currentDiskContextSourceOrdering, currentDiskContextSourceOrdering.baseSectionFilteredLines, currentDiskContextSourceOrdering.latestBaseSectionFiltering, contextSourceOrdering, contextSourceOrdering.baseSectionFilteredLines, contextSourceOrdering.latestBaseSectionFiltering, queryClassification, sourceOrdering.queryClassification, codegraphToolingSource, dedupMaintenanceSource, wrapperRuntimeDiagnostics, currentWrapperRuntimeDiagnostics, codegraphAutoSyncDisabled, currentCodegraphAutoSyncDisabled, activeCodegraphAutoSyncDisabled, activeCodegraphAutoSyncDisabledRuns, activeDirectWatcherRuns, host-mcp:active-direct-watchers, diagnosticTriage, diagnosticTriage.status, diagnosticTriage.failureBoundary, diagnosticTriage.adapterFailureLikely, diagnosticTriage.directMcpTrust, diagnosticTriage.failureClasses, diagnosticTriage.doNotMisdiagnoseAs, diagnosticTriage.primaryEvidence, diagnosticTriage.primaryEvidence.directMcpError, diagnosticTriage.primaryEvidence.hostConfigAlignmentOverrides, diagnosticTriage.nextAction, codexMcpConfig.hostConfigAlignmentOverrides, observedDirectMcpError, observedDirectMcpFailureClass, hostMcp.rootCauseSummary, rootCauseSummary.status, rootCauseSummary.failureBoundary, rootCauseSummary.adapterFailureLikely, rootCauseSummary.failureClasses, rootCauseSummary.directMcpTrust, rootCauseSummary.fallback, rootCauseSummary.recovery, host-mcp:observed-direct-mcp-error, --direct-mcp-error, direct-mcp-host-transport-closed, observed-direct-mcp-transport-closed, fresh-config-mismatch, stale-config-mismatch, failureClasses, observed.directMcpError, observed.liveWrapperProcessCount, observed.autoSyncDisabled, observed.activeAutoSyncDisabledCount, observed.activeAutoSyncDisabledRuns, observed.activeDirectWatcherCount, observed.activeDirectWatcherRuns, observed.liveProcessMismatches, baseResponseWarnings, responseWarnings, missingDiagnostics, duplicateSourceSections, duplicateRelationshipsSections, duplicateRelationshipKindSections, duplicateRelatedSymbolsSections, topRankedNotFirst, topRankedMissing, lowValueVisibleSourceBlocks, lowValueSourcePollution, latestIssue, latestMissingDiagnostics, wrapper.fatal, and wrapper.runtime.diagnostic',
      'Wrapper Codex config alignment logs wrapper.start.codexConfigAlignment, wrapper.config.mismatch, wrapper.config.match, wrapper.config.override, and wrapper.config.unavailable; config drift uses mcp-host-config-mismatch and carries expected, actual, mismatches, and investigation.failureBoundary=codex-mcp-host. adapter-fallback and smoke overrides are reported through hostConfigAlignmentOverrides with ignored=true, ignoredReason=wrapper-config-alignment-intentional-override, and alignmentMode, and must not trigger --fail-on-host-config-mismatch.',
      'Stale wrapper handling logs wrapper.script.stale and wrapper.script.stale.continue while completing the current nanoflow_context_pack or nanoflow_overlay_query response; the Codex default NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0 logs wrapper.script.stale.recycle.skipped while keeping the stale transport alive until the host/session is restarted. Only explicit stale-smoke or recycle diagnostic runs set NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=1 and log wrapper.script.stale.recycle.request plus wrapper.shutdown.stale-wrapper-script after the current response succeeds. stale must not become a client-visible isError that pushes agents to the native CodeGraph CLI.',
      'adapter-first NanoFlow adapter CLI fallback runs codegraph:adapter:context with nanoflow_context_pack and nanoflow_overlay_query, or codegraph:overlay:query --skip-refresh for focused relations; @colbymchenry/codegraph@1.5.0 is final native CodeGraph CLI degradation and only a locator.',
      'upstream CodeGraph fixed version is @colbymchenry/codegraph@1.5.0; upgrade probes must use --codegraph-target @colbymchenry/codegraph@<new-version> before changing the pin. The adapter delegates generic TypeScript symbol/import/export/call/impact discovery to native CodeGraph. native Markdown/JSON formatter section order, strict native output projection, and context exploration source ordering are upstream delegation boundaries. The adapter must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact. NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors.',
      'De-duplication hotspot audit backlog: collectTypeScript(), buildNativeGraph(), buildImportAliasIndex(), buildExportTargetIndex(), resolveReferenceNodeId(), addTypeScriptCallableEdges(), collectAndroid(), readAndroidKotlinFileSymbols(), readAndroidKotlinMethodCalls(), resolveAndroidKotlinCallTarget(), resolveAndroidKotlinTypeTarget(), addAndroidKotlinTypeReferenceEdges(), addAndroidKotlinOverrideEdges(), addAndroidKotlinAnnotationEdges(), queryOverlay(), scoreCandidate(), selectGraphResults(), formatStrictNativeMarkdown(), formatNativeMarkdown(), contextPackSourceRankingQueryFor(), and sanitizeContextPackBaseMarkdownSections() are temporary allowed duplicates only to attach NanoFlow metadata.relation to native-shaped endpoints; Android/Kotlin duplicate hotspots attach Android Manifest/widget/resource/project semantics to native-shaped Kotlin/XML endpoints; queryOverlay(), scoreCandidate(), and selectGraphResults() are query/ranking duplicate hotspots; formatStrictNativeMarkdown() is a formatter duplicate hotspot for strict native Markdown; formatNativeMarkdown() is a formatter duplicate hotspot for augmented/default Markdown projection; contextPackSourceRankingQueryFor() and sanitizeContextPackBaseMarkdownSections() are source-ordering duplicate hotspot entries; delegated upstream owner is native CodeGraph; docs/codegraph-nanoflow-dedup-contract.json is the machine-readable contract; removal trigger is an upstream extension point or native projection hook; verification gate is codegraph:overlay:docs:validate plus codegraph:adapter:gate.',
      'Codex MCP config contract: NANOFLOW_CODEGRAPH_CODEX_CONFIG overrides D:\\Code\\dde\\.codex\\config.toml, which overrides C:\\Users\\MI\\.codex\\config.toml for this repository; codegraph:adapter:doctor reports the active scope/path; Codex MCP env must set CODEGRAPH_NO_DAEMON=0, CODEGRAPH_NO_WATCH=0, CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=300000, CODEGRAPH_DAEMON_MAX_IDLE_MS=1800000, NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS=30000, and NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0; codegraph:adapter:context intentionally overrides direct/no-watch; codegraph:adapter:context, codegraph:mcp:smoke, and codegraph:adapter:doctor do not read or fall back to .vscode/mcp.json.',
      'For current Codex usage, .vscode/mcp.json is not the active CodeGraph MCP configuration and must not be edited, repaired, or diagnosed as the fix target for Codex MCP failures; active wrapper, CodeGraph target, and MCP environment changes belong in D:\\Code\\dde\\.codex\\config.toml, its user-level fallback C:\\Users\\MI\\.codex\\config.toml, or a NANOFLOW_CODEGRAPH_CODEX_CONFIG temporary Codex config.',
      'query-path relevance keeps context-json nodes, relatedFiles, entryPoints, codeBlocks, and strict native Markdown ordered by segmented file-name matches such as vitest services config mts',
      'strict native output order keeps native JSON field order query/summary/entryPoints/nodes/edges/codeBlocks/relatedFiles/stats and native Markdown section order Code Context -> Entry Points -> Relationships -> Related Symbols -> Code stable',
      'strict native object projection keeps node fields ordered as id/kind/name/qualifiedName/filePath/language/startLine/endLine/signature/docstring/visibility/isExported/isAsync/isStatic/isAbstract, edge fields ordered as source/target/kind/line/column, and codeBlock fields ordered as filePath/startLine/endLine/language/content/nodeName/nodeKind while stripping metadata/provenance/sourceName/targetName extension fields',
      'strict native source evidence contract keeps relation-only codeBlocks complete and focused: migration-index, migration-constraint, and migration-constraint-validation expand to complete SQL statement ranges; policy-using and policy-with-check keep full CREATE POLICY statements; owner method, matchedNeedle, and source-first relation queries prevent synthetic endpoints from filling the code block budget. host-attribute, host-binding, and host-listener require edge-line source with real owner nodeName. edge-function-header requires req.headers.get(...) evidence in the serve(...) handler or helper function. template-url and style-url require resource-endpoint budgeting. supabase-realtime-remove-channel, supabase-realtime-unsubscribe, and supabase-realtime-remove-all-channels require Realtime owner source.',
      'codegraph:adapter:gate composes codegraph:adapter:preflight, codegraph:overlay:validate, codegraph:overlay:sync, codegraph:overlay:baseline:manifest, codegraph:adapter:infra:test, codegraph:adapter:context, codegraph:adapter:quick-gate, codegraph:adapter:context:packaged-artifacts, codegraph:overlay:test, codegraph:mcp:smoke, codegraph:mcp:stale-smoke, and codegraph:mcp:log:guard so strict native JSON, strict native Markdown, source block, query, gate infrastructure, and wrapper regressions are verified together using the gate-owned codegraph-adapter-gate-mcp-wrapper.log plus codegraph-adapter-gate-stale-mcp-wrapper.log, --fail-on-current-autosync-disabled, --fail-on-stale-current-wrapper, --fail-on-active-stale-wrappers, and --fail-on-untrusted-direct-mcp',
      'NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS bounded captured output descendant',
      'single shared tree freshness and multi-agent conflict handling treats CodeGraph as the first locator while current disk contents remain authoritative for latest changed files; pending index sync requires a targeted reread, shared agents run git status --short and git diff --name-only before edits, claim file set through a file lease, keep skipRefresh=true / NANOFLOW_OVERLAY_SKIP_REFRESH=1 on query paths, and finish semantic changes with codegraph:overlay:validate',
      'dynamicImports=2',
      `dynamicImportEdges=${dynamicImportEdgesInDocs}`,
      'angularRoutes=1',
      `angularRouteGuardEdges=${angularRouteGuardEdgesInDocs}`,
      'angularRouteResolverEdges=1',
      'angularRouteRedirectEdges=1',
      'angularRouteProviderEdges=1',
      'hostDirectiveEdges=0',
      'hostAttributeEdges=1',
      'hostBindingEdges=1',
      'hostListenerEdges=1',
      'edgeFunctions=1',
      'edgeFunctionSourceFiles=2',
      'edgeFunctionImports=1',
      'edgeFunctionSourceEdges=1',
      'edgeFunctionRouteEdges=1',
      'edgeFunctionMethodEdges=1',
      'edgeFunctionHeaderNodes=1',
      `edgeFunctionHeaderEdges=${edgeFunctionHeaderEdgesInDocs}`,
      'edgeFunctionEnvVarNodes=1',
      'edgeFunctionEnvVarEdges=1',
      'edgeFunctionInvokeEdges=1',
      'edgeFunctionTests=1',
      'edgeFunctionTestEdges=1',
      `androidKotlinClasses=${androidKotlinClassesInDocs}`,
      `androidKotlinDataClasses=${androidKotlinDataClassesInDocs}`,
      `androidKotlinSealedClasses=${androidKotlinSealedClassesInDocs}`,
      `androidKotlinInterfaces=${androidKotlinInterfacesInDocs}`,
      `androidKotlinInterfaceEdges=${androidKotlinInterfaceEdgesInDocs}`,
      `androidKotlinExtendsEdges=${androidKotlinExtendsEdgesInDocs}`,
      `androidKotlinImplementsEdges=${androidKotlinImplementsEdgesInDocs}`,
      `androidKotlinObjects=${androidKotlinObjectsInDocs}`,
      `androidKotlinObjectEdges=${androidKotlinObjectEdgesInDocs}`,
      `androidKotlinCompanionObjects=${androidKotlinCompanionObjectsInDocs}`,
      `androidKotlinCompanionObjectEdges=${androidKotlinCompanionObjectEdgesInDocs}`,
      `androidKotlinEnums=${androidKotlinEnumsInDocs}`,
      `androidKotlinEnumMembers=${androidKotlinEnumMembersInDocs}`,
      `androidKotlinEnumMemberEdges=${androidKotlinEnumMemberEdgesInDocs}`,
      `androidKotlinImports=${androidKotlinImportsInDocs}`,
      `androidKotlinImportEdges=${androidKotlinImportEdgesInDocs}`,
      `androidKotlinConstructors=${androidKotlinConstructorsInDocs}`,
      `androidKotlinConstructorEdges=${androidKotlinConstructorEdgesInDocs}`,
      `androidKotlinProperties=${androidKotlinPropertiesInDocs}`,
      `androidKotlinPropertyEdges=${androidKotlinPropertyEdgesInDocs}`,
      `androidKotlinMethods=${androidKotlinMethodsInDocs}`,
      `androidKotlinMethodEdges=${androidKotlinMethodEdgesInDocs}`,
      `androidKotlinFunctions=${androidKotlinFunctionsInDocs}`,
      `androidKotlinFunctionEdges=${androidKotlinFunctionEdgesInDocs}`,
      `androidKotlinOverrideEdges=${androidKotlinOverrideEdgesInDocs}`,
      `androidKotlinTypeReferenceEdges=${androidKotlinTypeReferenceEdgesInDocs}`,
      `androidKotlinCalls=${androidKotlinCallsInDocs}`,
      `androidKotlinCallEdges=${androidKotlinCallEdgesInDocs}`,
      `androidKotlinAnnotations=${androidKotlinAnnotationsInDocs}`,
      `androidKotlinAnnotationEdges=${androidKotlinAnnotationEdgesInDocs}`,
      `androidManifestComponents=${androidManifestComponentsInDocs}`,
      `androidManifestPermissions=${androidManifestPermissionsInDocs}`,
      'androidManifestUsesPermissionEdges=1',
      `androidManifestQueries=${androidManifestQueriesInDocs}`,
      'androidManifestQueryEdges=1',
      `androidManifestComponentPermissions=${androidManifestComponentPermissionsInDocs}`,
      'androidManifestComponentPermissionEdges=1',
      `androidManifestIntentFilters=${androidManifestIntentFiltersInDocs}`,
      `androidManifestIntentFilterActions=${androidManifestIntentFilterActionsInDocs}`,
      'androidManifestIntentFilterActionEdges=1',
      `androidManifestIntentFilterCategories=${androidManifestIntentFilterCategoriesInDocs}`,
      'androidManifestIntentFilterCategoryEdges=1',
      `androidManifestIntentFilterData=${androidManifestIntentFilterDataInDocs}`,
      'androidManifestIntentFilterDataEdges=1',
      `androidWidgetProviders=${androidWidgetProvidersInDocs}`,
      `androidResourceReferences=${androidResourceReferencesInDocs}`,
      `androidKotlinResourceReferences=${androidKotlinResourceReferencesInDocs}`,
      'androidKotlinResourceReferenceEdges=1',
      'templateBindings=3',
      'property=1',
      'event=1',
      'interpolation=1',
      'model=0',
      'control-flow=0',
      'structural=0',
      'templateComponentEdges=1',
      'templateDirectiveEdges=1',
      'templatePipeEdges=1',
      `templateUrlEdges=${templateUrlEdgesInDocs}`,
      `styleUrlEdges=${styleUrlEdgesInDocs}`,
      `totalTestEdges=${totalTestEdgesInDocs}`,
      'testEdgesWithTestMapping=5',
      `testEdgesWithMatchedNeedle=${testEdgesWithMatchedNeedleInDocs}`,
      'sameBasenameTestEdges=1',
      'classReferenceTestEdges=1',
      'pathReferenceTestEdges=1',
      'routeReferenceTestEdges=1',
      'invokeReferenceTestEdges=0',
      'filenameReferenceTestEdges=1',
      `hardRules=${hardRulesInDocs}`,
      `hardRuleKeywordNodes=${hardRuleKeywordNodesInDocs}`,
      `hardRuleKeywordEdges=${hardRuleKeywordEdgesInDocs}`,
      `hardRuleKeywordMappingEdges=${hardRuleKeywordMappingEdgesInDocs}`,
      'hardRuleImplementationEdges=1',
      `hardRuleImplementationTargets=${hardRuleImplementationTargetsInDocs}`,
      'syncRules=1',
      `configRules=${configRulesInDocs}`,
      `syncRuleNodes=${syncRuleNodesInDocs}`,
      `syncRuleKeywordNodes=${syncRuleKeywordNodesInDocs}`,
      `syncRuleKeywordEdges=${syncRuleKeywordEdgesInDocs}`,
      'syncBodyKeywordEdges=1',
      'syncConfigKeywordEdges=1',
      `configPropertyNodes=${configPropertyNodesInDocs}`,
      `configPropertyEdges=${configPropertyEdgesInDocs}`,
      `configPropertyParentEdges=${configPropertyParentEdgesInDocs}`,
      'configSourceEdges=1',
      `configSourcePropertyEdges=${configSourcePropertyEdgesInDocs}`,
      `syncConfigSourceEdges=${syncConfigSourceEdgesInDocs}`,
      'migrationFunctionDetails=1',
      'migrationSqlFunctionEdges=1',
      `migrationSqlFunctionFunctionNodes=${migrationSqlFunctionFunctionNodesInDocs}`,
      'migrationTriggers=1',
      `migrationTriggerEdges=${migrationTriggerEdgesInDocs}`,
      'migrationTriggerFunctionEdges=1',
      'migrationIndexDetails=1',
      `migrationIndexNodes=${migrationIndexNodesInDocs}`,
      'migrationIndexEdges=1',
      'migrationConstraintDetails=1',
      `migrationConstraintNodes=${migrationConstraintNodesInDocs}`,
      'migrationConstraintEdges=1',
      'migrationConstraintValidationDetails=1',
      `migrationConstraintValidationNodes=${migrationConstraintValidationNodesInDocs}`,
      'migrationConstraintValidationEdges=1',
      'migrationRlsDetails=1',
      'migrationRlsEdges=1',
      'migrationRealtimePublicationDetails=1',
      'migrationRealtimePublicationNodes=1',
      'migrationRealtimePublicationEdges=1',
      'migrationViewDetails=1',
      'migrationViewNodes=1',
      'migrationViewEdges=1',
      `migrationTests=${migrationTestsInDocs}`,
      `migrationTestEdges=${migrationTestEdgesInDocs}`,
      'policyDetails=1',
      `policyNodes=${policyNodesInDocs}`,
      'policyCommandEdges=1',
      'policyTypeEdges=1',
      `policyRoleEdges=${policyRoleEdgesInDocs}`,
      `policyUsingEdges=${policyUsingEdgesInDocs}`,
      `policyWithCheckEdges=${policyWithCheckEdgesInDocs}`,
      'privilegeDetails=1',
      `privilegeNodes=${privilegeNodesInDocs}`,
      `privilegeObjectNodes=${privilegeObjectNodesInDocs}`,
      'privilegeGrantEdges=1',
      'privilegeRevokeEdges=1',
      `privilegeObjectEdges=${privilegeObjectEdgesInDocs}`,
      `privilegeRoleNodes=${privilegeRoleNodesInDocs}`,
      `privilegeRoleEdges=${privilegeRoleEdgesInDocs}`,
      `supabaseRealtimeChannelNodes=${supabaseRealtimeChannelNodesInDocs}`,
      'supabaseRpcEdges=1',
      'supabaseTableWriteEdges=1',
      'supabaseRealtimeChannelEdges=1',
      `supabaseRealtimePostgresChangeNodes=${supabaseRealtimePostgresChangeNodesInDocs}`,
      'supabaseRealtimePostgresChangeEdges=1',
      'supabaseRealtimeStatusNodes=1',
      'supabaseRealtimeStatusEdges=1',
      `supabaseRealtimeRemoveChannelNodes=${supabaseRealtimeRemoveChannelNodesInDocs}`,
      'supabaseRealtimeRemoveChannelEdges=1',
      `supabaseRealtimeUnsubscribeNodes=${supabaseRealtimeUnsubscribeNodesInDocs}`,
      'supabaseRealtimeUnsubscribeEdges=1',
      `supabaseRealtimeRemoveAllChannelsNodes=${supabaseRealtimeRemoveAllChannelsNodesInDocs}`,
      'supabaseRealtimeRemoveAllChannelsEdges=1',
      `supabaseStorageBucketNodes=${supabaseStorageBucketNodesInDocs}`,
      'supabaseStorageBucketEdges=1',
      `supabaseSelectFieldNodes=${supabaseSelectFieldNodesInDocs}`,
      'supabaseSelectFieldEdges=3',
      'supabaseSelectFieldReferenceEdges=2',
      `inlineSelectFieldNodes=${inlineSelectFieldNodesInDocs}`,
      'inlineSelectFieldEdges=1',
      'syncRequiredFieldEdges=1',
      `supabaseIncrementalPredicateNodes=${supabaseIncrementalPredicateNodesInDocs}`,
      'supabaseIncrementalPredicateEdges=1',
      'syncRequiredPredicateEdges=1',
      `supabaseRpcNodes=${supabaseRpcNodesInDocs}`,
      `supabaseTableWriteNodes=${supabaseTableWriteNodesInDocs}`,
      'supabaseRiskTagNodes=1',
      'supabaseRiskTagEdges=1',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md'),
    [
      'Production overlay authority: `.codegraph/nanoflow-generations/CURRENT.json` selects one immutable `.codegraph/nanoflow-generations/<generation-id>/`; its `compatibility/nanoflow-overlay.json` is validated by `scripts/lib/codegraph-overlay-current-receipt.cjs` through `readOverlayCurrentReceipt(projectRoot)`.',
      `${graphNodesInDocs} graph nodes and ${graphEdgesInDocs} graph edges in the native-shaped projection;`,
      'Project semantic coverage counters: angularComponents=1, angularDirectives=1, angularPipes=1, angularInjectables=1, angularInjectorFiles=1, angularInjectorDependencyReferences=1, angularApplicationProviders=1, standaloneImportEdges=1, angularInputEdges=1, angularOutputEdges=1, angularModelEdges=0, angularQueryEdges=1, angularSignalEdges=1, context7Documents=1, context7Categories=1, context7CategoryDocEdges=1, context7RetrievalRoutes=1, context7RetrievalPrimaryEdges=1, context7RetrievalSecondaryEdges=1, context7SourceMapRoutes=1, context7SourceMapDocEdges=1, and context7SourceMapSourceEdges=1.',
      `2 dynamic import entries, ${dynamicImportEdgesInDocs} dynamic import graph edges, and 1 Angular route`,
      `${angularRouteGuardEdgesInDocs} angular-route-guard edges and 1 angular-route-resolver edges`,
      '1 angular-route-redirect edges and 1 angular-route-provider edges',
      '0 host-directive edges, 1 host-attribute edges, 1 host-binding edges, and 1 host-listener edges',
      `1 Supabase Edge Functions with 0 env-var references after following relative helper imports under supabase/functions, 2 followed source/helper files counted per Edge Function, 1 recorded source import relations, 1 native edge-function-source import edges, 1 generated /functions/v1/<name> route nodes/edges, 1 explicit req.method method references currently found in the real tree, 1 implementation-side edge-function-invoke edges, and 1 native test-reference edges`,
      `The Supabase Edge Function header layer adds 1 edge-function-header native-shaped variable nodes and ${edgeFunctionHeaderEdgesInDocs} native references edges across request headers.`,
      `Android Kotlin member graph summary: ${androidKotlinClassesInDocs} androidKotlinClasses, ${androidKotlinDataClassesInDocs} androidKotlinDataClasses, ${androidKotlinSealedClassesInDocs} androidKotlinSealedClasses, ${androidKotlinInterfacesInDocs} androidKotlinInterfaces, ${androidKotlinInterfaceEdgesInDocs} androidKotlinInterfaceEdges, ${androidKotlinExtendsEdgesInDocs} androidKotlinExtendsEdges, ${androidKotlinImplementsEdgesInDocs} androidKotlinImplementsEdges, ${androidKotlinObjectsInDocs} androidKotlinObjects, ${androidKotlinObjectEdgesInDocs} androidKotlinObjectEdges, ${androidKotlinCompanionObjectsInDocs} androidKotlinCompanionObjects, ${androidKotlinCompanionObjectEdgesInDocs} androidKotlinCompanionObjectEdges, ${androidKotlinEnumsInDocs} androidKotlinEnums, ${androidKotlinEnumMembersInDocs} androidKotlinEnumMembers, ${androidKotlinEnumMemberEdgesInDocs} androidKotlinEnumMemberEdges, ${androidKotlinImportsInDocs} androidKotlinImports, ${androidKotlinImportEdgesInDocs} androidKotlinImportEdges, ${androidKotlinConstructorsInDocs} androidKotlinConstructors, ${androidKotlinConstructorEdgesInDocs} androidKotlinConstructorEdges, ${androidKotlinPropertiesInDocs} androidKotlinProperties, ${androidKotlinPropertyEdgesInDocs} androidKotlinPropertyEdges, ${androidKotlinMethodsInDocs} androidKotlinMethods, ${androidKotlinMethodEdgesInDocs} androidKotlinMethodEdges, ${androidKotlinFunctionsInDocs} androidKotlinFunctions, ${androidKotlinFunctionEdgesInDocs} androidKotlinFunctionEdges, ${androidKotlinOverrideEdgesInDocs} androidKotlinOverrideEdges, ${androidKotlinTypeReferenceEdgesInDocs} androidKotlinTypeReferenceEdges, ${androidKotlinCallsInDocs} androidKotlinCalls, ${androidKotlinCallEdgesInDocs} androidKotlinCallEdges, ${androidKotlinAnnotationsInDocs} androidKotlinAnnotations, and ${androidKotlinAnnotationEdgesInDocs} androidKotlinAnnotationEdges.`,
      `Android packaging/resource graph summary: ${androidManifestComponentsInDocs} androidManifestComponents, ${androidManifestPermissionsInDocs} androidManifestPermissions, 1 androidManifestUsesPermissionEdges, ${androidManifestQueriesInDocs} androidManifestQueries, 1 androidManifestQueryEdges, ${androidManifestComponentPermissionsInDocs} androidManifestComponentPermissions, 1 androidManifestComponentPermissionEdges, ${androidManifestIntentFiltersInDocs} androidManifestIntentFilters, ${androidManifestIntentFilterActionsInDocs} androidManifestIntentFilterActions, 1 androidManifestIntentFilterActionEdges, ${androidManifestIntentFilterCategoriesInDocs} androidManifestIntentFilterCategories, 1 androidManifestIntentFilterCategoryEdges, ${androidManifestIntentFilterDataInDocs} androidManifestIntentFilterData, 1 androidManifestIntentFilterDataEdges, ${androidWidgetProvidersInDocs} androidWidgetProviders, ${androidResourceReferencesInDocs} androidResourceReferences, ${androidKotlinResourceReferencesInDocs} androidKotlinResourceReferences, and 1 androidKotlinResourceReferenceEdges.`,
      'records 3 template bindings: 1 property, 1 event, 1 interpolation, 0 model, 0 control-flow, and 0 structural directive bindings',
      'adds 1 `template-component` edges, 1 `template-directive` edges in the current fixture, and 1 `template-pipe` edges',
      `Angular external resource graph summary: ${templateUrlEdgesInDocs} template-url edges and ${styleUrlEdgesInDocs} style-url edges`,
      `Realtime node summary: ${supabaseRealtimeChannelNodesInDocs} supabase-realtime-channel nodes, ${supabaseRealtimePostgresChangeNodesInDocs} supabase-realtime-postgres-change nodes, ${realtimeStatusLayerCountInDocs} supabase-realtime-status nodes, ${supabaseRealtimeRemoveChannelNodesInDocs} supabase-realtime-remove-channel nodes, ${supabaseRealtimeUnsubscribeNodesInDocs} supabase-realtime-unsubscribe nodes, and ${supabaseRealtimeRemoveAllChannelsNodesInDocs} supabase-realtime-remove-all-channels nodes.`,
      `The Realtime status layer adds ${realtimeStatusLayerCountInDocs} native supabase-realtime-status nodes/edges across runtime services.`,
      'Realtime graph summary: 1 supabase-realtime-channel edges, 1 supabase-realtime-postgres-change edges, 1 supabase-realtime-status edges, 1 supabase-realtime-remove-channel edges, 1 supabase-realtime-unsubscribe edges, and 1 supabase-realtime-remove-all-channels edges',
      `Select and storage node summary: ${supabaseSelectFieldNodesInDocs} supabase-select-field nodes, ${inlineSelectFieldNodesInDocs} inline select field nodes, ${supabaseIncrementalPredicateNodesInDocs} supabase-incremental-predicate nodes, and ${supabaseStorageBucketNodesInDocs} supabase-storage-bucket nodes.`,
      `Select and storage graph summary: 3 supabase-select-field edges, 2 supabase-select-field reference edges, 1 inline select provenance edges, 1 sync-required-field edges, 1 supabase-incremental-predicate edges, 1 sync-required-predicate edges, and 1 supabase-storage-bucket edges`,
      `${hardRulesInDocs} AGENTS hard-rule anchors`,
      `${hardRuleKeywordNodesInDocs} hard-rule keyword nodes, ${hardRuleKeywordEdgesInDocs} hard-rule keyword edges, ${hardRuleKeywordMappingEdgesInDocs} hard-rule keyword mapping edges, 1 hard-rule implementation edges, and ${hardRuleImplementationTargetsInDocs} hard-rule implementation targets`,
      `${hardRuleKeywordEdgesInDocs} hard-rule keyword edges and 1 hard-rule implementation edges`,
      `1 sync-rule anchors, ${configRulesInDocs} config-rule anchors, ${syncRuleNodesInDocs} sync-rule nodes, ${syncRuleKeywordNodesInDocs} sync-rule keyword nodes, ${syncRuleKeywordEdgesInDocs} sync-rule keyword edges, 1 sync-body keyword edges, 1 sync-config keyword edges, ${configPropertyNodesInDocs} config-property nodes, ${configPropertyEdgesInDocs} config-property edges, ${configPropertyParentEdgesInDocs} config-property parent edges, 1 config-source edges, ${configSourcePropertyEdgesInDocs} config-source property edges, and ${syncConfigSourceEdgesInDocs} sync-config-source edges`,
      `Supabase structured detail summary: ${edgeFunctionTestsInDocs} edgeFunctionTests, ${migrationFunctionDetailsInDocs} migrationFunctionDetails, ${migrationTriggersInDocs} migrationTriggers, ${migrationRlsDetailsInDocs} migrationRlsDetails, ${migrationTestsInDocs} migrationTests, and ${policyDetailsInDocs} policyDetails.`,
      '1 sync-rule anchors, 1 sync-body keyword edges, 1 sync-config keyword edges, and 1 config-source edges',
      `${migrationSqlFunctionFunctionNodesInDocs} SQL function nodes, 1 SQL function edges, ${migrationTriggerEdgesInDocs} trigger edges, 1 trigger-function edges, ${migrationIndexNodesInDocs} migration-index nodes, 1 migration-index edges, ${migrationConstraintNodesInDocs} migration-constraint nodes, 1 migration-constraint edges, ${migrationConstraintValidationNodesInDocs} migration-constraint-validation nodes, 1 migration-constraint-validation edges, and 1 migration-rls edges`,
      '1 SQL function edges, 1 trigger-function edges, 1 migration-index edges, 1 migration-constraint edges, 1 migration-constraint-validation edges, and 1 migration-rls edges',
      'The migration publication/view layer adds 1 migration-realtime-publication edges backed by 1 publication nodes from 1 parsed publication details, and 1 migration-view edges backed by 1 view nodes from 1 parsed view details.',
      `${policyNodesInDocs} policy nodes, 1 policy-command edges, 1 policy-type edges, ${policyRoleEdgesInDocs} policy-role edges, ${policyUsingEdgesInDocs} policy-using edges, ${policyWithCheckEdgesInDocs} policy-with-check edges, ${privilegeNodesInDocs} privilege nodes, ${privilegeObjectNodesInDocs} privilege-object nodes, 1 privilege-grant edges, 1 privilege-revoke edges, ${privilegeObjectEdgesInDocs} privilege-object edges, ${privilegeRoleNodesInDocs} privilege-role nodes, and ${privilegeRoleEdgesInDocs} privilege-role edges`,
      `1 policy-command edges, 1 policy-type edges, ${policyRoleEdgesInDocs} policy-role edges, ${policyUsingEdgesInDocs} policy-using edges, ${policyWithCheckEdgesInDocs} policy-with-check edges, 1 privilege-grant edges, 1 privilege-revoke edges, ${privilegeObjectEdgesInDocs} privilege-object edges, and ${privilegeRoleEdgesInDocs} privilege-role edges`,
      `${migrationTestsInDocs} migration tests and ${migrationTestEdgesInDocs} migration test edges`,
      `${supabaseRpcNodesInDocs} Supabase RPC nodes and 1 Supabase RPC edges; ${supabaseTableWriteNodesInDocs} Supabase table-write nodes and 1 Supabase table-write edges`,
      '1 Supabase RPC edges and 1 Supabase table-write edges',
      `${totalTestEdgesInDocs} total test-reference edges; all 5 carry provenance in metadata.testMapping. Angular contributes 1 same-basename edges and 1 class-reference edges. Supabase contributes 1 path-reference edges, 1 route-reference edge, 0 invoke-reference edges, and 1 filename-reference edges. ${testEdgesWithMatchedNeedleInDocs} path/route/filename-derived edges also render matchedNeedle`,
      'Context-pack diagnostics include sourceOrdering, queryClassification, sourceOrdering.queryClassification, sourceSectionCount, duplicateSourceSectionCount, relationshipsSectionCount, duplicateRelationshipsSectionCount, relationshipKindSectionCounts, duplicateRelationshipKindSectionCount, relatedSymbolsSectionCount, duplicateRelatedSymbolsSectionCount, baseSourceReorderAllowed, firstSourceFiles, visibleSourceFileDetails, visibleIndex, rankedIndex, rankedOverlayFiles, rankedOverlayFileDetails, matchRank, nodeRank, matchScore, nodeScore, pathScore, symbolScore, sourceBlockScore, lowValuePenalty, rawLowValuePenalty, pathClassLowValue, codegraphToolingSource, dedupMaintenanceSource, explicitSymbolEvidence, preferredSymbolEvidence, explicitFileRequested, explicitPathRequested, explicitSourcePathRequested, rawTopRankedOverlayFile, topRankedOverlayFile, topRankedOverlayFileSelectionReason, topRankedOverlayFileSkippedLowValue, topRankedOverlayFileVisibleIndex, firstSourceBlockIsTopRankedOverlayFile, and topRankedOverlayFileMissing.',
      'MCP log guard diagnostics include wrapperStarts, wrapperStarts.versions, wrapperStarts.latest.scriptSha256, currentWrapper, currentWrapper.diskScriptSha256, currentWrapper.matchesDisk, currentWrapper.staleAgainstDisk, currentDiskWrapper, currentDiskWrapper.latestRequestKind, currentConfiguredWrapper, currentConfiguredWrapper.codegraphTarget, currentContextWrapper, currentContextWrapper.diskScriptSha256, currentContextWrapper.matchesDisk, currentContextWrapper.staleAgainstDisk, currentContextWrapper.latestTs, currentContextWrapper.latestRequestId, currentDiskContextWrapper, currentDiskContextWrapper.latestRequestKind, currentConfiguredContextWrapper, currentConfiguredContextWrapper.codegraphTarget, activeWrappers, activeWrappers.total, activeWrappers.staleAgainstDisk, activeWrappers.distinctScriptSha256, activeWrappers.activeWindowMs, currentContextSourceOrdering, currentContextSourceOrdering.baseSectionFilteredLines, currentContextSourceOrdering.latestBaseSectionFiltering, currentDiskContextSourceOrdering, currentDiskContextSourceOrdering.baseSectionFilteredLines, currentDiskContextSourceOrdering.latestBaseSectionFiltering, contextSourceOrdering, contextSourceOrdering.baseSectionFilteredLines, contextSourceOrdering.latestBaseSectionFiltering, queryClassification, sourceOrdering.queryClassification, codegraphToolingSource, dedupMaintenanceSource, wrapperRuntimeDiagnostics, currentWrapperRuntimeDiagnostics, codegraphAutoSyncDisabled, currentCodegraphAutoSyncDisabled, activeCodegraphAutoSyncDisabled, activeCodegraphAutoSyncDisabledRuns, diagnosticTriage, diagnosticTriage.status, diagnosticTriage.failureBoundary, diagnosticTriage.adapterFailureLikely, diagnosticTriage.directMcpTrust, diagnosticTriage.failureClasses, diagnosticTriage.doNotMisdiagnoseAs, diagnosticTriage.primaryEvidence, diagnosticTriage.primaryEvidence.directMcpError, diagnosticTriage.primaryEvidence.hostConfigAlignmentOverrides, diagnosticTriage.nextAction, codexMcpConfig.hostConfigAlignmentOverrides, observedDirectMcpError, observedDirectMcpFailureClass, hostMcp.rootCauseSummary, rootCauseSummary.status, rootCauseSummary.failureBoundary, rootCauseSummary.adapterFailureLikely, rootCauseSummary.failureClasses, rootCauseSummary.directMcpTrust, rootCauseSummary.fallback, rootCauseSummary.recovery, host-mcp:observed-direct-mcp-error, --direct-mcp-error, direct-mcp-host-transport-closed, observed-direct-mcp-transport-closed, fresh-config-mismatch, stale-config-mismatch, failureClasses, observed.directMcpError, observed.liveWrapperProcessCount, observed.autoSyncDisabled, observed.activeAutoSyncDisabledCount, observed.activeAutoSyncDisabledRuns, observed.liveProcessMismatches, baseResponseWarnings, responseWarnings, missingDiagnostics, duplicateSourceSections, duplicateRelationshipsSections, duplicateRelationshipKindSections, duplicateRelatedSymbolsSections, topRankedNotFirst, topRankedMissing, lowValueVisibleSourceBlocks, lowValueSourcePollution, latestIssue, latestMissingDiagnostics, wrapper.fatal, and wrapper.runtime.diagnostic.',
      'Wrapper Codex config alignment logs wrapper.start.codexConfigAlignment, wrapper.config.mismatch, wrapper.config.match, wrapper.config.override, and wrapper.config.unavailable; config drift uses mcp-host-config-mismatch and carries expected, actual, mismatches, and investigation.failureBoundary=codex-mcp-host. adapter-fallback and smoke overrides are reported through hostConfigAlignmentOverrides with ignored=true, ignoredReason=wrapper-config-alignment-intentional-override, and alignmentMode, and must not trigger --fail-on-host-config-mismatch.',
      'Stale wrapper handling logs wrapper.script.stale and wrapper.script.stale.continue while completing the current nanoflow_context_pack or nanoflow_overlay_query response; the Codex default NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0 logs wrapper.script.stale.recycle.skipped while keeping the stale transport alive until the host/session is restarted. Only explicit stale-smoke or recycle diagnostic runs set NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=1 and log wrapper.script.stale.recycle.request plus wrapper.shutdown.stale-wrapper-script after the current response succeeds. stale must not become a client-visible isError that pushes agents to the native CodeGraph CLI.',
      'The adapter-first NanoFlow adapter CLI fallback runs codegraph:adapter:context with nanoflow_context_pack and nanoflow_overlay_query, or codegraph:overlay:query --skip-refresh for focused relations; @colbymchenry/codegraph@1.5.0 is final native CodeGraph CLI degradation and only a locator.',
      'The upstream CodeGraph fixed version is @colbymchenry/codegraph@1.5.0; upgrade probes must use --codegraph-target @colbymchenry/codegraph@<new-version> before changing the pin. The adapter delegates generic TypeScript symbol/import/export/call/impact discovery to native CodeGraph. native Markdown/JSON formatter section order, strict native output projection, and context exploration source ordering are upstream delegation boundaries. The adapter must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact. NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors.',
      'De-duplication hotspot audit backlog: collectTypeScript(), buildNativeGraph(), buildImportAliasIndex(), buildExportTargetIndex(), resolveReferenceNodeId(), addTypeScriptCallableEdges(), collectAndroid(), readAndroidKotlinFileSymbols(), readAndroidKotlinMethodCalls(), resolveAndroidKotlinCallTarget(), resolveAndroidKotlinTypeTarget(), addAndroidKotlinTypeReferenceEdges(), addAndroidKotlinOverrideEdges(), addAndroidKotlinAnnotationEdges(), queryOverlay(), scoreCandidate(), selectGraphResults(), formatStrictNativeMarkdown(), formatNativeMarkdown(), contextPackSourceRankingQueryFor(), and sanitizeContextPackBaseMarkdownSections() are temporary allowed duplicates only to attach NanoFlow metadata.relation to native-shaped endpoints; Android/Kotlin duplicate hotspots attach Android Manifest/widget/resource/project semantics to native-shaped Kotlin/XML endpoints; queryOverlay(), scoreCandidate(), and selectGraphResults() are query/ranking duplicate hotspots; formatStrictNativeMarkdown() is a formatter duplicate hotspot for strict native Markdown; formatNativeMarkdown() is a formatter duplicate hotspot for augmented/default Markdown projection; contextPackSourceRankingQueryFor() and sanitizeContextPackBaseMarkdownSections() are source-ordering duplicate hotspot entries; delegated upstream owner is native CodeGraph; docs/codegraph-nanoflow-dedup-contract.json is the machine-readable contract; removal trigger is an upstream extension point or native projection hook; verification gate is codegraph:overlay:docs:validate plus codegraph:adapter:gate.',
      'Codex MCP config contract: NANOFLOW_CODEGRAPH_CODEX_CONFIG overrides D:\\Code\\dde\\.codex\\config.toml, which overrides C:\\Users\\MI\\.codex\\config.toml for this repository; codegraph:adapter:doctor reports mcpConfig: source=codex and the active scope/path; Codex MCP env must set NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS=30000 and NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0; codegraph:adapter:context, codegraph:mcp:smoke, and codegraph:adapter:doctor do not read or fall back to .vscode/mcp.json.',
      'For current Codex usage, .vscode/mcp.json is not the active CodeGraph MCP configuration and must not be edited, repaired, or diagnosed as the fix target for Codex MCP failures; active wrapper, CodeGraph target, and MCP environment changes belong in D:\\Code\\dde\\.codex\\config.toml, its user-level fallback C:\\Users\\MI\\.codex\\config.toml, or a NANOFLOW_CODEGRAPH_CODEX_CONFIG temporary Codex config.',
      '## Local CodeGraph Source Setup',
      '```powershell',
      'cd D:\\Code\\tools\\codegraph',
      'node D:\\Code\\tools\\codegraph\\dist\\bin\\codegraph.js init -i D:\\Code\\dde',
      'npm --prefix D:\\Code\\dde run codegraph:overlay',
      '```',
      'The query-path relevance contract keeps context-json nodes, relatedFiles, entryPoints, codeBlocks, and strict native Markdown ordered by segmented file-name matches such as vitest services config mts.',
      'The strict native output order contract keeps native JSON field order query/summary/entryPoints/nodes/edges/codeBlocks/relatedFiles/stats and native Markdown section order Code Context -> Entry Points -> Relationships -> Related Symbols -> Code stable.',
      'The strict native object projection contract keeps node fields ordered as id/kind/name/qualifiedName/filePath/language/startLine/endLine/signature/docstring/visibility/isExported/isAsync/isStatic/isAbstract, edge fields ordered as source/target/kind/line/column, and codeBlock fields ordered as filePath/startLine/endLine/language/content/nodeName/nodeKind while stripping metadata/provenance/sourceName/targetName extension fields.',
      'The strict native source evidence contract keeps relation-only codeBlocks complete and focused: migration-index, migration-constraint, and migration-constraint-validation expand to complete SQL statement ranges; policy-using and policy-with-check keep full CREATE POLICY statements; owner method, matchedNeedle, and source-first relation queries prevent synthetic endpoints from filling the code block budget. host-attribute, host-binding, and host-listener require edge-line source with real owner nodeName. edge-function-header requires req.headers.get(...) evidence in the serve(...) handler or helper function. template-url and style-url require resource-endpoint budgeting. supabase-realtime-remove-channel, supabase-realtime-unsubscribe, and supabase-realtime-remove-all-channels require Realtime owner source.',
      'The codegraph:adapter:gate contract composes codegraph:adapter:preflight, codegraph:overlay:validate, codegraph:overlay:sync, codegraph:overlay:baseline:manifest, codegraph:adapter:infra:test, codegraph:adapter:context, codegraph:adapter:quick-gate, codegraph:adapter:context:packaged-artifacts, codegraph:overlay:test, codegraph:mcp:smoke, codegraph:mcp:stale-smoke, and codegraph:mcp:log:guard so strict native JSON, strict native Markdown, source block, query, gate infrastructure, and wrapper regressions are verified together using the gate-owned codegraph-adapter-gate-mcp-wrapper.log plus codegraph-adapter-gate-stale-mcp-wrapper.log, --fail-on-current-autosync-disabled, --fail-on-stale-current-wrapper, --fail-on-active-stale-wrappers, and --fail-on-untrusted-direct-mcp.',
      'The adapter gate runner enforces NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS per-step timeouts, reports bounded captured output tails, and cleans up matching CodeGraph descendant processes when a step hangs.',
      'The single shared tree freshness and multi-agent conflict handling contract treats CodeGraph as the first locator while current disk contents remain authoritative for latest changed files; pending index sync requires a targeted reread, shared agents run git status --short and git diff --name-only before edits, claim file set through a file lease, keep skipRefresh=true / NANOFLOW_OVERLAY_SKIP_REFRESH=1 on query paths, and finish semantic changes with codegraph:overlay:validate.',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md'),
    [
      '# NanoFlow CodeGraph Adaptation Issue Registry',
      '',
      '## Open Issues',
      '',
      'No active issues are recorded yet.',
      '',
      '## Fixed Issues',
      '',
      '## CG-NF-20260626-001: Fixture issue with complete machine fields',
      '',
      '- status: fixed',
      '- reported_at: 2026-06-26',
      '- reporter: codex-agent',
      '- feature_scope: documented fixture source ordering',
      '- query_surface: nanoflow_context_pack | adapter-context-cli',
      '- query: `fixture query`',
      '- expected: fixture expected result',
      '- actual: fixture actual result before repair',
      '- evidence:',
      '  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:1`',
      '  - output_summary: fixture output summary',
      '  - log_guard: no transport evidence',
      '- freshness_checks:',
      '  - mcp_result: success',
      '  - adapter_fallback_result: success',
      '  - wrapper_stale: no',
      '  - overlay_stale: no',
      '  - transport_failure: no',
      '- likely_root_cause: query-ranking',
      '- repair_target: query-selection | context-pack-wrapper | tests',
      '- doc_update_needed: no',
      '- verification_gate: `npm run codegraph:overlay:test`',
      '- resolution_notes: fixture issue is complete',
      '',
    ].join('\n'),
  );

  return root;
}

export function runValidator(root: string) {
  return runValidatorWithFixtureCurrentReceipt(root, repoRoot, scriptPath);
}

export function runSync(root: string) {
  return runSyncWithFixtureCurrentReceipt(root, repoRoot, syncScriptPath);
}


export function cleanupCodegraphOverlayDocsFixtures(): void {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
  restoreFixtureCurrentReceiptModuleLoader();
  restoreFixtureCurrentReceiptEnvironment();
}
