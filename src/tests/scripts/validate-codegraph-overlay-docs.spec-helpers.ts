import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeDedupContractFixture } from './validate-codegraph-overlay-docs-fixtures.spec-helpers';

export const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'validate-codegraph-overlay-docs.cjs');
const syncScriptPath = path.join(repoRoot, 'scripts', 'sync-codegraph-overlay-docs.cjs');
export const packageJsonPath = path.join(repoRoot, 'package.json');
export const agentsDocPath = path.join(repoRoot, 'AGENTS.md');
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
  androidKotlinFunctionsInDocs?: number;
  androidKotlinFunctionEdgesInDocs?: number;
  androidKotlinOverrideEdgesInDocs?: number;
  androidKotlinTypeReferenceEdgesInDocs?: number;
  androidKotlinAnnotationsInDocs?: number;
  androidKotlinAnnotationEdgesInDocs?: number;
  androidManifestComponentsInDocs?: number;
  androidWidgetProvidersInDocs?: number;
  androidResourceReferencesInDocs?: number;
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-docs-'));
	  tempRoots.push(root);
	  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
	  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
	  fs.writeFileSync(
	    path.join(root, 'package.json'),
	    JSON.stringify({
	      scripts: {
	        'codegraph:overlay:test': 'vitest run src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
	      },
	    }, null, 2),
	  );
	  const sourceNodeId = 'class:src/a.ts:A';
  const targetNodeId = 'class:src/b.ts:B';
  const migrationFileNodeId = 'file:supabase/migrations/20260601000000_sample.sql';
  const hardRuleKeywordNodeId = 'variable:AGENTS.md:hard-rule-keyword:crypto.randomUUID';
  const syncRuleNodeId = 'variable:AGENTS.md:sync-rule:SYNC_CONFIG.DEBOUNCE_DELAY';
  const syncRuleKeywordNodeId = 'variable:AGENTS.md:sync-rule-keyword:SYNC_CONFIG.DEBOUNCE_DELAY';
  const configPropertyNodeId = 'property:src/config/sync.config.ts:SYNC_CONFIG.DEBOUNCE_DELAY';
  writeDedupContractFixture(root);
  const selectFieldNodeId = 'property:src/config/sync.config.ts:FIELD_SELECT_CONFIG.TASK_FIELDS.content';
  const inlineSelectFieldNodeId = 'property:src/services/sample.service.ts:SampleService.load.tasks.content';
  const incrementalPredicateNodeId = 'variable:src/services/sample.service.ts:supabase-incremental-predicate:tasks.updated_at';
  const storageBucketNodeId = 'variable:src/services/sample.service.ts:supabase-storage-bucket:attachments';
  const rpcNodeId = 'variable:src/services/sample.service.ts:supabase-rpc:sample_rpc';
  const tableWriteNodeId = 'variable:src/services/sample.service.ts:supabase-table-write:tasks.upsert';
  const realtimeChannelNodeId = 'variable:src/services/sample.service.ts:supabase-realtime-channel:tasks';
  const realtimePostgresChangeNodeId = 'variable:src/services/sample.service.ts:supabase-realtime-postgres-change:tasks';
  const realtimeStatusNodeId = 'variable:src/services/sample.service.ts:supabase-realtime-status:SUBSCRIBED';
  const realtimeRemoveChannelNodeId = 'variable:src/services/sample.service.ts:supabase-realtime-remove-channel:tasks';
  const realtimeUnsubscribeNodeId = 'variable:src/services/sample.service.ts:supabase-realtime-unsubscribe:tasks';
  const realtimeRemoveAllChannelsNodeId = 'variable:src/services/sample.service.ts:supabase-realtime-remove-all-channels';
  const sqlFunctionNodeId = 'function:supabase/migrations/20260601000000_sample.sql:public.sample_fn';
  const triggerNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:sample_trigger';
  const migrationIndexNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:idx_tasks_project_id';
  const migrationConstraintNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:tasks_project_id_fkey';
  const policyNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:tasks_select_policy';
  const privilegeNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:privilege:grant:usage';
  const privilegeObjectNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:privilege-object:public.tasks';
  const privilegeRoleNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:privilege-role:authenticated';
  const migrationRealtimePublicationNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:migration-realtime-publication:supabase_realtime:add:public.tasks:1';
  const migrationViewNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:migration-view:public.active_tasks:2';
  const migrationFileSourceRelations = new Set([
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
    'trigger',
    'trigger-function',
  ]);
  const graphNode = (
    id: string,
    kind: string,
    name: string,
    filePath: string,
    metadata?: Record<string, unknown>,
  ) => ({
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: filePath.endsWith('.sql') ? 'unknown' : 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    ...(metadata ? { metadata } : {}),
  });
  const rawGraphEdges = [
    { metadata: { relation: 'dynamic-import' } },
    { metadata: { relation: 'dynamic-import' } },
    { metadata: { relation: 'angular-route-guard' } },
    { metadata: { relation: 'angular-route-resolver' } },
    { metadata: { relation: 'angular-route-redirect' } },
    { metadata: { relation: 'angular-route-provider' } },
    { metadata: { relation: 'angular-app-provider', provider: 'provideRouter', providerKind: 'factory-call' } },
    { metadata: { relation: 'android-kotlin-class' } },
    { metadata: { relation: 'android-manifest' } },
    { metadata: { relation: 'android-manifest-component' } },
    { metadata: { relation: 'android-resource-file' } },
    { metadata: { relation: 'android-resource-reference' } },
    { metadata: { relation: 'android-widget-provider' } },
    { metadata: { relation: 'host-attribute' } },
    { metadata: { relation: 'host-binding' } },
    { metadata: { relation: 'host-listener' } },
    { metadata: { relation: 'edge-function-source' } },
    { metadata: { relation: 'edge-function-route' } },
    { metadata: { relation: 'edge-function-method' } },
    { metadata: { relation: 'edge-function-header', header: 'Authorization', normalizedHeader: 'authorization' } },
    { metadata: { relation: 'edge-function-invoke' } },
    { metadata: { relation: 'template-component' } },
    { metadata: { relation: 'template-directive' } },
    { metadata: { relation: 'template-pipe' } },
    { kind: 'imports', metadata: { relation: 'template-url' } },
    { kind: 'imports', metadata: { relation: 'style-url' } },
    { metadata: { relation: 'template-binding' } },
    { metadata: { relation: 'test', testMapping: 'same-basename' } },
    { metadata: { relation: 'test', testMapping: 'class-reference' } },
    { metadata: { relation: 'test', testMapping: 'path-reference', matchedNeedle: 'supabase/functions/sample' } },
    { metadata: { relation: 'test', testMapping: 'route-reference', matchedNeedle: 'functions/v1/sample' } },
    { metadata: { relation: 'test', testMapping: 'filename-reference', matchedNeedle: '20260601000000_sample.sql' } },
    { metadata: { relation: 'hard-rule-keyword', keywordMapping: 'hard-rule-keyword' } },
    { metadata: { relation: 'hard-rule-implementation' } },
    { metadata: { relation: 'sync-rule' } },
    { metadata: { keywordMapping: 'sync-body-keyword' } },
    { metadata: { keywordMapping: 'sync-config-keyword' } },
    { metadata: { relation: 'config-property', parentConfigPath: 'SYNC_CONFIG' } },
    { metadata: { relation: 'config-source', configProperty: 'DEBOUNCE_DELAY' } },
    { metadata: { relation: 'sync-config-source' } },
    { metadata: { relation: 'context7-doc' } },
    { metadata: { relation: 'context7-category' } },
    { metadata: { relation: 'context7-category-doc' } },
    { metadata: { relation: 'context7-retrieval-route' } },
    { metadata: { relation: 'context7-retrieval-primary' } },
    { metadata: { relation: 'context7-retrieval-secondary' } },
    { metadata: { relation: 'context7-source-map-route' } },
    { metadata: { relation: 'context7-source-map-doc' } },
    { metadata: { relation: 'context7-source-map-source' } },
    { metadata: { relation: 'context7-source-path' } },
    { metadata: { relation: 'sql-function' } },
    { metadata: { relation: 'trigger' } },
    { metadata: { relation: 'trigger-function' } },
    { metadata: { relation: 'migration-index' } },
    { metadata: { relation: 'migration-constraint' } },
    { metadata: { relation: 'migration-constraint-validation' } },
    { metadata: { relation: 'migration-rls' } },
    { metadata: { relation: 'migration-realtime-publication', publication: 'supabase_realtime', action: 'add', table: 'public.tasks' } },
    { metadata: { relation: 'migration-view', view: 'public.active_tasks' } },
    { metadata: { relation: 'policy-command' } },
    { metadata: { relation: 'policy-type' } },
    { metadata: { relation: 'policy-role' } },
    { metadata: { relation: 'policy-using' } },
    { metadata: { relation: 'policy-with-check' } },
    { metadata: { relation: 'privilege-grant', action: 'grant' } },
    { metadata: { relation: 'privilege-revoke', action: 'revoke' } },
    { metadata: { relation: 'privilege-object', objectName: 'public.tasks' } },
    { metadata: { relation: 'privilege-role', role: 'authenticated' } },
    { metadata: { relation: 'supabase-rpc', functionName: 'sample_rpc' } },
    { metadata: { relation: 'supabase-table-write', table: 'tasks', writeOperation: 'upsert' } },
    { metadata: { relation: 'supabase-realtime-channel' } },
    { metadata: { relation: 'supabase-realtime-postgres-change' } },
    { metadata: { relation: 'supabase-realtime-status', status: 'SUBSCRIBED', action: 'subscribed', owner: 'SampleService.listen' } },
    { metadata: { relation: 'supabase-realtime-remove-channel' } },
    { metadata: { relation: 'supabase-realtime-unsubscribe' } },
    { metadata: { relation: 'supabase-realtime-remove-all-channels' } },
    { metadata: { relation: 'supabase-storage-bucket', bucket: 'attachments', storageSource: 'typescript' } },
    { kind: 'contains', metadata: { relation: 'supabase-select-field' } },
    { kind: 'references', metadata: { relation: 'supabase-select-field' } },
    { kind: 'references', metadata: { relation: 'supabase-select-field', selectSource: 'inline-select' } },
    { metadata: { relation: 'sync-required-field' } },
    { metadata: { relation: 'supabase-incremental-predicate' } },
    { metadata: { relation: 'sync-required-predicate' } },
  ];
  const targetByRelation = new Map<string, string>([
    ['hard-rule-keyword', hardRuleKeywordNodeId],
    ['hard-rule-implementation', sourceNodeId],
    ['sync-rule', syncRuleNodeId],
    ['config-property', configPropertyNodeId],
    ['config-source', configPropertyNodeId],
    ['sync-config-source', configPropertyNodeId],
    ['sql-function', sqlFunctionNodeId],
    ['trigger', triggerNodeId],
    ['trigger-function', triggerNodeId],
    ['migration-index', migrationIndexNodeId],
    ['migration-constraint', migrationConstraintNodeId],
    ['migration-constraint-validation', migrationConstraintNodeId],
    ['migration-realtime-publication', migrationRealtimePublicationNodeId],
    ['migration-view', migrationViewNodeId],
    ['policy-command', policyNodeId],
    ['policy-type', policyNodeId],
    ['policy-role', policyNodeId],
    ['policy-using', policyNodeId],
    ['policy-with-check', policyNodeId],
    ['privilege-grant', privilegeNodeId],
    ['privilege-revoke', privilegeNodeId],
    ['privilege-object', privilegeObjectNodeId],
    ['privilege-role', privilegeRoleNodeId],
    ['supabase-rpc', rpcNodeId],
    ['supabase-table-write', tableWriteNodeId],
    ['supabase-realtime-channel', realtimeChannelNodeId],
    ['supabase-realtime-postgres-change', realtimePostgresChangeNodeId],
    ['supabase-realtime-status', realtimeStatusNodeId],
    ['supabase-realtime-remove-channel', realtimeRemoveChannelNodeId],
    ['supabase-realtime-unsubscribe', realtimeUnsubscribeNodeId],
    ['supabase-realtime-remove-all-channels', realtimeRemoveAllChannelsNodeId],
    ['supabase-storage-bucket', storageBucketNodeId],
    ['sync-required-field', selectFieldNodeId],
    ['supabase-incremental-predicate', incrementalPredicateNodeId],
    ['sync-required-predicate', incrementalPredicateNodeId],
  ]);
  const graphEdges = rawGraphEdges.map(edge => {
    const relation = edge.metadata?.relation;
    const selectFieldTarget = edge.metadata?.relation === 'supabase-select-field'
      && edge.metadata?.selectSource === 'inline-select'
      ? inlineSelectFieldNodeId
      : selectFieldNodeId;
    const keywordTarget = edge.metadata?.keywordMapping === 'sync-config-keyword'
      ? syncRuleKeywordNodeId
      : targetNodeId;
    return {
      source: relation !== undefined && migrationFileSourceRelations.has(relation)
        ? migrationFileNodeId
        : sourceNodeId,
      target: relation === 'supabase-select-field'
        ? selectFieldTarget
        : (relation !== undefined ? targetByRelation.get(relation) : keywordTarget) ?? targetNodeId,
      kind: edge.kind ?? 'references',
      ...edge,
    };
  });

  const overlay = {
    angular: {
      dynamicImports: [{}, {}],
      routes: [{}],
      components: [
        {
          templateBindings: [
            { kind: 'property' },
            { kind: 'event' },
            { kind: 'interpolation' },
          ],
        },
      ],
    },
    agentRules: {
      syncRules: [{ name: 'SYNC_CONFIG.DEBOUNCE_DELAY' }],
    },
    supabase: {
      edgeFunctions: [
        {
          sourceFiles: ['supabase/functions/sample/index.ts', 'supabase/functions/_shared/cors.ts'],
          imports: [{}],
          tests: ['src/tests/contracts/sample-edge-function.spec.ts'],
          testMappings: [{}],
        },
      ],
      migrations: [
        {
          functionDetails: [{}],
          triggerDetails: [{}],
          indexDetails: [{}],
          constraintDetails: [{}],
          constraintValidationDetails: [{}],
          rlsDetails: [{}],
          realtimePublicationDetails: [{}],
          viewDetails: [{}],
          policyDetails: [{}],
          privilegeDetails: [{}],
          tests: ['src/tests/contracts/sample-migration.spec.ts'],
          testMappings: [{}],
        },
      ],
    },
    graph: {
      nodes: [
        graphNode(sourceNodeId, 'class', 'A', 'src/a.ts'),
        graphNode(targetNodeId, 'class', 'B', 'src/b.ts'),
        graphNode(migrationFileNodeId, 'file', '20260601000000_sample.sql', 'supabase/migrations/20260601000000_sample.sql'),
        graphNode(hardRuleKeywordNodeId, 'variable', 'crypto.randomUUID()', 'AGENTS.md', { relation: 'hard-rule-keyword' }),
        graphNode(syncRuleNodeId, 'variable', 'SYNC_CONFIG.DEBOUNCE_DELAY', 'AGENTS.md', { relation: 'sync-rule' }),
        graphNode(syncRuleKeywordNodeId, 'variable', 'SYNC_CONFIG.DEBOUNCE_DELAY', 'AGENTS.md', { relation: 'sync-rule-keyword' }),
        graphNode(configPropertyNodeId, 'property', 'SYNC_CONFIG.DEBOUNCE_DELAY', 'src/config/sync.config.ts', { relation: 'config-property' }),
        graphNode(selectFieldNodeId, 'property', 'content', 'src/config/sync.config.ts', { relation: 'supabase-select-field' }),
        graphNode(inlineSelectFieldNodeId, 'property', 'content', 'src/services/sample.service.ts', { relation: 'supabase-select-field', selectSource: 'inline-select' }),
        graphNode(incrementalPredicateNodeId, 'variable', 'updated_at > last_sync_time', 'src/services/sample.service.ts', { relation: 'supabase-incremental-predicate' }),
        graphNode(storageBucketNodeId, 'variable', 'attachments', 'src/services/sample.service.ts', { relation: 'supabase-storage-bucket' }),
        graphNode(rpcNodeId, 'variable', 'sample_rpc', 'src/services/sample.service.ts', { relation: 'supabase-rpc' }),
        graphNode(tableWriteNodeId, 'variable', 'tasks.upsert', 'src/services/sample.service.ts', { relation: 'supabase-table-write' }),
        graphNode(realtimeChannelNodeId, 'variable', 'tasks', 'src/services/sample.service.ts', { relation: 'supabase-realtime-channel' }),
        graphNode(realtimePostgresChangeNodeId, 'variable', 'public.tasks *', 'src/services/sample.service.ts', { relation: 'supabase-realtime-postgres-change' }),
        graphNode(realtimeStatusNodeId, 'variable', 'SUBSCRIBED', 'src/services/sample.service.ts', { relation: 'supabase-realtime-status' }),
        graphNode(realtimeRemoveChannelNodeId, 'variable', 'removeChannel tasks', 'src/services/sample.service.ts', { relation: 'supabase-realtime-remove-channel' }),
        graphNode(realtimeUnsubscribeNodeId, 'variable', 'unsubscribe tasks', 'src/services/sample.service.ts', { relation: 'supabase-realtime-unsubscribe' }),
        graphNode(realtimeRemoveAllChannelsNodeId, 'variable', 'removeAllChannels', 'src/services/sample.service.ts', { relation: 'supabase-realtime-remove-all-channels' }),
        graphNode(sqlFunctionNodeId, 'function', 'public.sample_fn', 'supabase/migrations/20260601000000_sample.sql', { relation: 'sql-function' }),
        graphNode(triggerNodeId, 'variable', 'sample_trigger', 'supabase/migrations/20260601000000_sample.sql', { relation: 'trigger' }),
        graphNode(migrationIndexNodeId, 'variable', 'idx_tasks_project_id', 'supabase/migrations/20260601000000_sample.sql', { relation: 'migration-index' }),
        graphNode(migrationConstraintNodeId, 'variable', 'tasks_project_id_fkey', 'supabase/migrations/20260601000000_sample.sql', { relation: 'migration-constraint' }),
        graphNode(migrationRealtimePublicationNodeId, 'variable', 'supabase_realtime add public.tasks', 'supabase/migrations/20260601000000_sample.sql', { relation: 'migration-realtime-publication' }),
        graphNode(migrationViewNodeId, 'variable', 'public.active_tasks', 'supabase/migrations/20260601000000_sample.sql', { relation: 'migration-view' }),
        graphNode(policyNodeId, 'variable', 'tasks_select_policy', 'supabase/migrations/20260601000000_sample.sql', { relation: 'policy' }),
        graphNode(privilegeNodeId, 'variable', 'usage', 'supabase/migrations/20260601000000_sample.sql', { relation: 'privilege' }),
        graphNode(privilegeObjectNodeId, 'variable', 'public.tasks', 'supabase/migrations/20260601000000_sample.sql', { relation: 'privilege-object' }),
        graphNode(privilegeRoleNodeId, 'variable', 'authenticated', 'supabase/migrations/20260601000000_sample.sql', { relation: 'privilege-role' }),
        graphNode('variable:edge-function-header', 'variable', 'Authorization', 'supabase/functions/sample/index.ts', { relation: 'edge-function-header' }),
      ],
      edges: graphEdges,
    },
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
  const androidKotlinDataClassesInDocs = options.androidKotlinDataClassesInDocs ?? 0;
  const androidKotlinSealedClassesInDocs = options.androidKotlinSealedClassesInDocs ?? 0;
  const androidKotlinInterfacesInDocs = options.androidKotlinInterfacesInDocs ?? 0;
  const androidKotlinInterfaceEdgesInDocs = options.androidKotlinInterfaceEdgesInDocs ?? 0;
  const androidKotlinExtendsEdgesInDocs = options.androidKotlinExtendsEdgesInDocs ?? 0;
  const androidKotlinImplementsEdgesInDocs = options.androidKotlinImplementsEdgesInDocs ?? 0;
  const androidKotlinEnumsInDocs = options.androidKotlinEnumsInDocs ?? 0;
  const androidKotlinObjectsInDocs = options.androidKotlinObjectsInDocs ?? 0;
  const androidKotlinObjectEdgesInDocs = options.androidKotlinObjectEdgesInDocs ?? 0;
  const androidKotlinCompanionObjectsInDocs = options.androidKotlinCompanionObjectsInDocs ?? 0;
  const androidKotlinCompanionObjectEdgesInDocs = options.androidKotlinCompanionObjectEdgesInDocs ?? 0;
  const androidKotlinEnumMembersInDocs = options.androidKotlinEnumMembersInDocs ?? 0;
  const androidKotlinEnumMemberEdgesInDocs = options.androidKotlinEnumMemberEdgesInDocs ?? 0;
  const androidKotlinImportsInDocs = options.androidKotlinImportsInDocs ?? 0;
  const androidKotlinImportEdgesInDocs = options.androidKotlinImportEdgesInDocs ?? 0;
  const androidKotlinConstructorsInDocs = options.androidKotlinConstructorsInDocs ?? 0;
  const androidKotlinConstructorEdgesInDocs = options.androidKotlinConstructorEdgesInDocs ?? 0;
  const androidKotlinPropertiesInDocs = options.androidKotlinPropertiesInDocs ?? 0;
  const androidKotlinPropertyEdgesInDocs = options.androidKotlinPropertyEdgesInDocs ?? 0;
  const androidKotlinFunctionsInDocs = options.androidKotlinFunctionsInDocs ?? 0;
  const androidKotlinFunctionEdgesInDocs = options.androidKotlinFunctionEdgesInDocs ?? 0;
  const androidKotlinOverrideEdgesInDocs = options.androidKotlinOverrideEdgesInDocs ?? 0;
  const androidKotlinTypeReferenceEdgesInDocs = options.androidKotlinTypeReferenceEdgesInDocs ?? 0;
  const androidKotlinAnnotationsInDocs = options.androidKotlinAnnotationsInDocs ?? 0;
  const androidKotlinAnnotationEdgesInDocs = options.androidKotlinAnnotationEdgesInDocs ?? 0;
  const androidManifestComponentsInDocs = options.androidManifestComponentsInDocs ?? 0;
  const androidWidgetProvidersInDocs = options.androidWidgetProvidersInDocs ?? 0;
  const androidResourceReferencesInDocs = options.androidResourceReferencesInDocs ?? 0;
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    [
      'graphNodes=2',
      `graphEdges=${graphEdgesInDocs}`,
      'context-pack diagnostics include sourceOrdering, queryClassification, sourceOrdering.queryClassification, sourceSectionCount, duplicateSourceSectionCount, relationshipsSectionCount, duplicateRelationshipsSectionCount, relationshipKindSectionCounts, duplicateRelationshipKindSectionCount, relatedSymbolsSectionCount, duplicateRelatedSymbolsSectionCount, baseSourceReorderAllowed, firstSourceFiles, visibleSourceFileDetails, visibleIndex, rankedIndex, rankedOverlayFiles, rankedOverlayFileDetails, matchRank, nodeRank, matchScore, nodeScore, pathScore, symbolScore, sourceBlockScore, lowValuePenalty, rawLowValuePenalty, pathClassLowValue, codegraphToolingSource, dedupMaintenanceSource, explicitSymbolEvidence, preferredSymbolEvidence, explicitFileRequested, explicitPathRequested, explicitSourcePathRequested, rawTopRankedOverlayFile, topRankedOverlayFile, topRankedOverlayFileSelectionReason, topRankedOverlayFileSkippedLowValue, topRankedOverlayFileVisibleIndex, firstSourceBlockIsTopRankedOverlayFile, and topRankedOverlayFileMissing',
      'MCP log guard diagnostics include wrapperStarts, wrapperStarts.versions, wrapperStarts.latest.scriptSha256, currentWrapper, currentWrapper.diskScriptSha256, currentWrapper.matchesDisk, currentWrapper.staleAgainstDisk, currentDiskWrapper, currentDiskWrapper.latestRequestKind, currentConfiguredWrapper, currentConfiguredWrapper.codegraphTarget, currentContextWrapper, currentContextWrapper.diskScriptSha256, currentContextWrapper.matchesDisk, currentContextWrapper.staleAgainstDisk, currentContextWrapper.latestTs, currentContextWrapper.latestRequestId, currentDiskContextWrapper, currentDiskContextWrapper.latestRequestKind, currentConfiguredContextWrapper, currentConfiguredContextWrapper.codegraphTarget, activeWrappers, activeWrappers.total, activeWrappers.staleAgainstDisk, activeWrappers.distinctScriptSha256, activeWrappers.activeWindowMs, currentContextSourceOrdering, currentContextSourceOrdering.baseSectionFilteredLines, currentContextSourceOrdering.latestBaseSectionFiltering, currentDiskContextSourceOrdering, currentDiskContextSourceOrdering.baseSectionFilteredLines, currentDiskContextSourceOrdering.latestBaseSectionFiltering, contextSourceOrdering, contextSourceOrdering.baseSectionFilteredLines, contextSourceOrdering.latestBaseSectionFiltering, queryClassification, sourceOrdering.queryClassification, codegraphToolingSource, dedupMaintenanceSource, wrapperRuntimeDiagnostics, currentWrapperRuntimeDiagnostics, codegraphAutoSyncDisabled, currentCodegraphAutoSyncDisabled, activeCodegraphAutoSyncDisabled, activeCodegraphAutoSyncDisabledRuns, diagnosticTriage, diagnosticTriage.status, diagnosticTriage.failureBoundary, diagnosticTriage.adapterFailureLikely, diagnosticTriage.directMcpTrust, diagnosticTriage.failureClasses, diagnosticTriage.doNotMisdiagnoseAs, diagnosticTriage.primaryEvidence, diagnosticTriage.primaryEvidence.directMcpError, diagnosticTriage.primaryEvidence.hostConfigAlignmentOverrides, diagnosticTriage.nextAction, codexMcpConfig.hostConfigAlignmentOverrides, observedDirectMcpError, observedDirectMcpFailureClass, hostMcp.rootCauseSummary, rootCauseSummary.status, rootCauseSummary.failureBoundary, rootCauseSummary.adapterFailureLikely, rootCauseSummary.failureClasses, rootCauseSummary.directMcpTrust, rootCauseSummary.fallback, rootCauseSummary.recovery, host-mcp:observed-direct-mcp-error, --direct-mcp-error, direct-mcp-host-transport-closed, observed-direct-mcp-transport-closed, fresh-config-mismatch, stale-config-mismatch, failureClasses, observed.directMcpError, observed.liveWrapperProcessCount, observed.autoSyncDisabled, observed.activeAutoSyncDisabledCount, observed.activeAutoSyncDisabledRuns, observed.liveProcessMismatches, baseResponseWarnings, responseWarnings, missingDiagnostics, duplicateSourceSections, duplicateRelationshipsSections, duplicateRelationshipKindSections, duplicateRelatedSymbolsSections, topRankedNotFirst, topRankedMissing, lowValueVisibleSourceBlocks, lowValueSourcePollution, latestIssue, latestMissingDiagnostics, wrapper.fatal, and wrapper.runtime.diagnostic',
      'Wrapper Codex config alignment logs wrapper.start.codexConfigAlignment, wrapper.config.mismatch, wrapper.config.match, wrapper.config.override, and wrapper.config.unavailable; config drift uses mcp-host-config-mismatch and carries expected, actual, mismatches, and investigation.failureBoundary=codex-mcp-host. adapter-fallback and smoke overrides are reported through hostConfigAlignmentOverrides with ignored=true, ignoredReason=wrapper-config-alignment-intentional-override, and alignmentMode, and must not trigger --fail-on-host-config-mismatch.',
      'Stale wrapper handling logs wrapper.script.stale and wrapper.script.stale.continue while completing the current nanoflow_context_pack or nanoflow_overlay_query response; the Codex default NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0 logs wrapper.script.stale.recycle.skipped while keeping the stale transport alive until the host/session is restarted. Only explicit stale-smoke or recycle diagnostic runs set NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=1 and log wrapper.script.stale.recycle.request plus wrapper.shutdown.stale-wrapper-script after the current response succeeds. stale must not become a client-visible isError that pushes agents to the native CodeGraph CLI.',
      'adapter-first NanoFlow adapter CLI fallback runs codegraph:adapter:context with nanoflow_context_pack and nanoflow_overlay_query, or codegraph:overlay:query --skip-refresh for focused relations; @colbymchenry/codegraph@1.2.0 is final native CodeGraph CLI degradation and only a locator.',
      'upstream CodeGraph fixed version is @colbymchenry/codegraph@1.2.0; upgrade probes must use --codegraph-target @colbymchenry/codegraph@<new-version> before changing the pin. The adapter delegates generic TypeScript symbol/import/export/call/impact discovery to native CodeGraph. native Markdown/JSON formatter section order, strict native output projection, and context exploration source ordering are upstream delegation boundaries. The adapter must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact. NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors.',
      'De-duplication hotspot audit backlog: collectTypeScript(), buildNativeGraph(), buildImportAliasIndex(), buildExportTargetIndex(), resolveReferenceNodeId(), addTypeScriptCallableEdges(), collectAndroid(), readAndroidKotlinFileSymbols(), readAndroidKotlinMethodCalls(), resolveAndroidKotlinCallTarget(), resolveAndroidKotlinTypeTarget(), addAndroidKotlinTypeReferenceEdges(), addAndroidKotlinOverrideEdges(), addAndroidKotlinAnnotationEdges(), queryOverlay(), scoreCandidate(), selectGraphResults(), formatStrictNativeMarkdown(), formatNativeMarkdown(), contextPackSourceRankingQueryFor(), and sanitizeContextPackBaseMarkdownSections() are temporary allowed duplicates only to attach NanoFlow metadata.relation to native-shaped endpoints; Android/Kotlin duplicate hotspots attach Android Manifest/widget/resource/project semantics to native-shaped Kotlin/XML endpoints; queryOverlay(), scoreCandidate(), and selectGraphResults() are query/ranking duplicate hotspots; formatStrictNativeMarkdown() is a formatter duplicate hotspot for strict native Markdown; formatNativeMarkdown() is a formatter duplicate hotspot for augmented/default Markdown projection; contextPackSourceRankingQueryFor() and sanitizeContextPackBaseMarkdownSections() are source-ordering duplicate hotspot entries; delegated upstream owner is native CodeGraph; docs/codegraph-nanoflow-dedup-contract.json is the machine-readable contract; removal trigger is an upstream extension point or native projection hook; verification gate is codegraph:overlay:docs:validate plus codegraph:adapter:gate.',
      'Codex MCP config contract: Codex sessions use C:\\Users\\MI\\.codex\\config.toml as the current MCP source; codegraph:adapter:doctor reports mcpConfig: source=codex for this workspace; NANOFLOW_CODEGRAPH_CODEX_CONFIG can override this path; Codex MCP env must set NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS=30000 and NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0; codegraph:adapter:context, codegraph:mcp:smoke, and codegraph:adapter:doctor do not read or fall back to .vscode/mcp.json.',
      'For current Codex usage, .vscode/mcp.json is not the active CodeGraph MCP configuration and must not be edited, repaired, or diagnosed as the fix target for Codex MCP failures; active wrapper, CodeGraph target, and MCP environment changes belong in C:\\Users\\MI\\.codex\\config.toml or a NANOFLOW_CODEGRAPH_CODEX_CONFIG temporary Codex config.',
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
      'edgeFunctionInvokeEdges=1',
      'edgeFunctionTests=1',
      'edgeFunctionTestEdges=1',
      'androidKotlinClasses=0',
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
      'androidKotlinMethods=0',
      'androidKotlinMethodEdges=0',
      `androidKotlinFunctions=${androidKotlinFunctionsInDocs}`,
      `androidKotlinFunctionEdges=${androidKotlinFunctionEdgesInDocs}`,
      `androidKotlinOverrideEdges=${androidKotlinOverrideEdgesInDocs}`,
      `androidKotlinTypeReferenceEdges=${androidKotlinTypeReferenceEdgesInDocs}`,
      'androidKotlinCalls=0',
      'androidKotlinCallEdges=0',
      `androidKotlinAnnotations=${androidKotlinAnnotationsInDocs}`,
      `androidKotlinAnnotationEdges=${androidKotlinAnnotationEdgesInDocs}`,
      `androidManifestComponents=${androidManifestComponentsInDocs}`,
      `androidWidgetProviders=${androidWidgetProvidersInDocs}`,
      `androidResourceReferences=${androidResourceReferencesInDocs}`,
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
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md'),
    [
      `${graphNodesInDocs} graph nodes and ${graphEdgesInDocs} graph edges in the native-shaped projection;`,
      `2 dynamic import entries, ${dynamicImportEdgesInDocs} dynamic import graph edges, and 1 Angular route`,
      `${angularRouteGuardEdgesInDocs} angular-route-guard edges and 1 angular-route-resolver edges`,
      '1 angular-route-redirect edges and 1 angular-route-provider edges',
      '0 host-directive edges, 1 host-attribute edges, 1 host-binding edges, and 1 host-listener edges',
      `1 Supabase Edge Functions with 0 env-var references after following relative helper imports under supabase/functions, 2 followed source/helper files counted per Edge Function, 1 recorded source import relations, 1 native edge-function-source import edges, 1 generated /functions/v1/<name> route nodes/edges, 1 explicit req.method method references currently found in the real tree, 1 implementation-side edge-function-invoke edges, and 1 native test-reference edges`,
      `The Supabase Edge Function header layer adds 1 edge-function-header native-shaped variable nodes and ${edgeFunctionHeaderEdgesInDocs} native references edges across request headers.`,
      `Android Kotlin member graph summary: 0 androidKotlinClasses, ${androidKotlinDataClassesInDocs} androidKotlinDataClasses, ${androidKotlinSealedClassesInDocs} androidKotlinSealedClasses, ${androidKotlinInterfacesInDocs} androidKotlinInterfaces, ${androidKotlinInterfaceEdgesInDocs} androidKotlinInterfaceEdges, ${androidKotlinExtendsEdgesInDocs} androidKotlinExtendsEdges, ${androidKotlinImplementsEdgesInDocs} androidKotlinImplementsEdges, ${androidKotlinObjectsInDocs} androidKotlinObjects, ${androidKotlinObjectEdgesInDocs} androidKotlinObjectEdges, ${androidKotlinCompanionObjectsInDocs} androidKotlinCompanionObjects, ${androidKotlinCompanionObjectEdgesInDocs} androidKotlinCompanionObjectEdges, ${androidKotlinEnumsInDocs} androidKotlinEnums, ${androidKotlinEnumMembersInDocs} androidKotlinEnumMembers, ${androidKotlinEnumMemberEdgesInDocs} androidKotlinEnumMemberEdges, ${androidKotlinImportsInDocs} androidKotlinImports, ${androidKotlinImportEdgesInDocs} androidKotlinImportEdges, ${androidKotlinConstructorsInDocs} androidKotlinConstructors, ${androidKotlinConstructorEdgesInDocs} androidKotlinConstructorEdges, ${androidKotlinPropertiesInDocs} androidKotlinProperties, ${androidKotlinPropertyEdgesInDocs} androidKotlinPropertyEdges, 0 androidKotlinMethods, 0 androidKotlinMethodEdges, ${androidKotlinFunctionsInDocs} androidKotlinFunctions, ${androidKotlinFunctionEdgesInDocs} androidKotlinFunctionEdges, ${androidKotlinOverrideEdgesInDocs} androidKotlinOverrideEdges, ${androidKotlinTypeReferenceEdgesInDocs} androidKotlinTypeReferenceEdges, 0 androidKotlinCalls, 0 androidKotlinCallEdges, ${androidKotlinAnnotationsInDocs} androidKotlinAnnotations, and ${androidKotlinAnnotationEdgesInDocs} androidKotlinAnnotationEdges.`,
      `Android packaging/resource graph summary: ${androidManifestComponentsInDocs} androidManifestComponents, ${androidWidgetProvidersInDocs} androidWidgetProviders, and ${androidResourceReferencesInDocs} androidResourceReferences.`,
      'records 3 template bindings: 1 property, 1 event, 1 interpolation, 0 model, 0 control-flow, and 0 structural directive bindings',
      'adds 1 `template-component` edges, 1 `template-directive` edges in the current fixture, and 1 `template-pipe` edges',
      `Angular external resource graph summary: ${templateUrlEdgesInDocs} template-url edges and ${styleUrlEdgesInDocs} style-url edges`,
      `Realtime node summary: ${supabaseRealtimeChannelNodesInDocs} supabase-realtime-channel nodes, ${supabaseRealtimePostgresChangeNodesInDocs} supabase-realtime-postgres-change nodes, ${realtimeStatusLayerCountInDocs} supabase-realtime-status nodes, ${supabaseRealtimeRemoveChannelNodesInDocs} supabase-realtime-remove-channel nodes, ${supabaseRealtimeUnsubscribeNodesInDocs} supabase-realtime-unsubscribe nodes, and ${supabaseRealtimeRemoveAllChannelsNodesInDocs} supabase-realtime-remove-all-channels nodes.`,
      `The Realtime status layer adds ${realtimeStatusLayerCountInDocs} native supabase-realtime-status nodes/edges across runtime services.`,
      'Realtime graph summary: 1 supabase-realtime-channel edges, 1 supabase-realtime-postgres-change edges, 1 supabase-realtime-status edges, 1 supabase-realtime-remove-channel edges, 1 supabase-realtime-unsubscribe edges, and 1 supabase-realtime-remove-all-channels edges',
      `Select and storage node summary: ${supabaseSelectFieldNodesInDocs} supabase-select-field nodes, ${inlineSelectFieldNodesInDocs} inline select field nodes, ${supabaseIncrementalPredicateNodesInDocs} supabase-incremental-predicate nodes, and ${supabaseStorageBucketNodesInDocs} supabase-storage-bucket nodes.`,
      `Select and storage graph summary: 3 supabase-select-field edges, 2 supabase-select-field reference edges, 1 inline select provenance edges, 1 sync-required-field edges, 1 supabase-incremental-predicate edges, 1 sync-required-predicate edges, and 1 supabase-storage-bucket edges`,
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
      'The adapter-first NanoFlow adapter CLI fallback runs codegraph:adapter:context with nanoflow_context_pack and nanoflow_overlay_query, or codegraph:overlay:query --skip-refresh for focused relations; @colbymchenry/codegraph@1.2.0 is final native CodeGraph CLI degradation and only a locator.',
      'The upstream CodeGraph fixed version is @colbymchenry/codegraph@1.2.0; upgrade probes must use --codegraph-target @colbymchenry/codegraph@<new-version> before changing the pin. The adapter delegates generic TypeScript symbol/import/export/call/impact discovery to native CodeGraph. native Markdown/JSON formatter section order, strict native output projection, and context exploration source ordering are upstream delegation boundaries. The adapter must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact. NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors.',
      'De-duplication hotspot audit backlog: collectTypeScript(), buildNativeGraph(), buildImportAliasIndex(), buildExportTargetIndex(), resolveReferenceNodeId(), addTypeScriptCallableEdges(), collectAndroid(), readAndroidKotlinFileSymbols(), readAndroidKotlinMethodCalls(), resolveAndroidKotlinCallTarget(), resolveAndroidKotlinTypeTarget(), addAndroidKotlinTypeReferenceEdges(), addAndroidKotlinOverrideEdges(), addAndroidKotlinAnnotationEdges(), queryOverlay(), scoreCandidate(), selectGraphResults(), formatStrictNativeMarkdown(), formatNativeMarkdown(), contextPackSourceRankingQueryFor(), and sanitizeContextPackBaseMarkdownSections() are temporary allowed duplicates only to attach NanoFlow metadata.relation to native-shaped endpoints; Android/Kotlin duplicate hotspots attach Android Manifest/widget/resource/project semantics to native-shaped Kotlin/XML endpoints; queryOverlay(), scoreCandidate(), and selectGraphResults() are query/ranking duplicate hotspots; formatStrictNativeMarkdown() is a formatter duplicate hotspot for strict native Markdown; formatNativeMarkdown() is a formatter duplicate hotspot for augmented/default Markdown projection; contextPackSourceRankingQueryFor() and sanitizeContextPackBaseMarkdownSections() are source-ordering duplicate hotspot entries; delegated upstream owner is native CodeGraph; docs/codegraph-nanoflow-dedup-contract.json is the machine-readable contract; removal trigger is an upstream extension point or native projection hook; verification gate is codegraph:overlay:docs:validate plus codegraph:adapter:gate.',
      'Codex MCP config contract: Codex sessions use C:\\Users\\MI\\.codex\\config.toml as the current MCP source; codegraph:adapter:doctor reports mcpConfig: source=codex for this workspace; NANOFLOW_CODEGRAPH_CODEX_CONFIG can override this path; Codex MCP env must set NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS=30000 and NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0; codegraph:adapter:context, codegraph:mcp:smoke, and codegraph:adapter:doctor do not read or fall back to .vscode/mcp.json.',
      'For current Codex usage, .vscode/mcp.json is not the active CodeGraph MCP configuration and must not be edited, repaired, or diagnosed as the fix target for Codex MCP failures; active wrapper, CodeGraph target, and MCP environment changes belong in C:\\Users\\MI\\.codex\\config.toml or a NANOFLOW_CODEGRAPH_CODEX_CONFIG temporary Codex config.',
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
  return spawnSync(process.execPath, [scriptPath, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}

export function runSync(root: string) {
  return spawnSync(process.execPath, [syncScriptPath, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}


export function cleanupCodegraphOverlayDocsFixtures(): void {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
}
