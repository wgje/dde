// validate-codegraph-overlay-docs fixture 的 native-shaped overlay graph 构造，从 makeFixture 拆出以控制文件规模。
export function buildValidateCodegraphOverlayDocsOverlayGraph() {
	  const sourceNodeId = 'class:src/a.ts:A';
  const targetNodeId = 'class:src/b.ts:B';
  const migrationFileNodeId = 'file:supabase/migrations/20260601000000_sample.sql';
  const hardRuleKeywordNodeId = 'variable:AGENTS.md:hard-rule-keyword:crypto.randomUUID';
  const syncRuleNodeId = 'variable:AGENTS.md:sync-rule:SYNC_CONFIG.DEBOUNCE_DELAY';
  const syncRuleKeywordNodeId = 'variable:AGENTS.md:sync-rule-keyword:SYNC_CONFIG.DEBOUNCE_DELAY';
  const configPropertyNodeId = 'property:src/config/sync.config.ts:SYNC_CONFIG.DEBOUNCE_DELAY';
  const selectFieldNodeId = 'property:src/config/sync.config.ts:FIELD_SELECT_CONFIG.TASK_FIELDS.content';
  const inlineSelectFieldNodeId = 'property:src/services/sample.service.ts:SampleService.load.tasks.content';
  const incrementalPredicateNodeId = 'variable:src/services/sample.service.ts:supabase-incremental-predicate:tasks.updated_at';
  const storageBucketNodeId = 'variable:src/services/sample.service.ts:supabase-storage-bucket:attachments';
  const rpcNodeId = 'variable:src/services/sample.service.ts:supabase-rpc:sample_rpc';
  const tableWriteNodeId = 'variable:src/services/sample.service.ts:supabase-table-write:tasks.upsert';
  const envVarNodeId = 'variable:supabase/functions/sample/index.ts:SUPABASE_URL';
  const riskTagNodeId = 'variable:supabase/migrations/20260601000000_sample.sql:security-sensitive';
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
    { metadata: { relation: 'env-var', envVar: 'SUPABASE_URL' } },
    { metadata: { relation: 'risk-tag', riskTag: 'security-sensitive', riskSource: 'migration' } },
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
    ['env-var', envVarNodeId],
    ['risk-tag', riskTagNodeId],
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
      hardRules: [{ title: '5.1 ID Strategy' }],
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
        graphNode(envVarNodeId, 'variable', 'SUPABASE_URL', 'supabase/functions/sample/index.ts', { relation: 'env-var', envVar: 'SUPABASE_URL' }),
        graphNode(riskTagNodeId, 'variable', 'security-sensitive', 'supabase/migrations/20260601000000_sample.sql', { relation: 'risk-tag', riskTag: 'security-sensitive', riskSource: 'migration' }),
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

  return overlay;
}
