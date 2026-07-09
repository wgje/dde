'use strict';

function countRelation(edges, relation) {
  return edges.filter(edge => edge?.metadata?.relation === relation).length;
}

function countNodeRelation(nodes, relation) {
  return nodes.filter(node => node?.metadata?.relation === relation).length;
}

function countRelationTargets(edges, relation) {
  return new Set(edges
    .filter(edge => edge?.metadata?.relation === relation)
    .map(edge => edge.target)
    .filter(Boolean)).size;
}

function countKeywordMapping(edges, keywordMapping) {
  return edges.filter(edge => edge?.metadata?.keywordMapping === keywordMapping).length;
}

function countKeywordMappings(edges, keywordMappings) {
  const allowed = new Set(keywordMappings);
  return edges.filter(edge => allowed.has(edge?.metadata?.keywordMapping)).length;
}

function countTestMapping(edges, testMapping) {
  return edges.filter(edge => edge?.metadata?.testMapping === testMapping).length;
}

function countAndroidKotlinAnnotations(android) {
  return [
    ...(android?.kotlinClasses ?? []),
    ...(android?.kotlinEnums ?? []),
    ...(android?.kotlinConstructors ?? []),
    ...(android?.kotlinProperties ?? []),
    ...(android?.kotlinMethods ?? []),
    ...(android?.kotlinFunctions ?? []),
  ].flatMap(item => item?.annotations ?? []).length;
}

function buildBaseline(overlay) {
  const graphNodes = overlay.graph?.nodes ?? [];
  const graphEdges = overlay.graph?.edges ?? [];
  const edgeFunctions = overlay.supabase?.edgeFunctions ?? [];
  const migrations = overlay.supabase?.migrations ?? [];
  const templateBindings = (overlay.angular?.components ?? []).flatMap(component => component.templateBindings ?? []);
  const bindingKinds = {
    property: 0,
    event: 0,
    interpolation: 0,
    model: 0,
    'control-flow': 0,
    structural: 0,
  };
  for (const binding of templateBindings) {
    if (Object.prototype.hasOwnProperty.call(bindingKinds, binding.kind)) {
      bindingKinds[binding.kind] += 1;
    }
  }

  return {
    graphNodes: graphNodes.length,
    graphEdges: graphEdges.length,
    dynamicImports: overlay.angular?.dynamicImports?.length ?? 0,
    dynamicImportEdges: countRelation(graphEdges, 'dynamic-import'),
    angularRoutes: overlay.angular?.routes?.length ?? 0,
    angularRouteGuardEdges: countRelation(graphEdges, 'angular-route-guard'),
    angularRouteResolverEdges: countRelation(graphEdges, 'angular-route-resolver'),
    angularRouteRedirectEdges: countRelation(graphEdges, 'angular-route-redirect'),
    angularRouteProviderEdges: countRelation(graphEdges, 'angular-route-provider'),
    hostDirectiveEdges: countRelation(graphEdges, 'host-directive'),
    hostAttributeEdges: countRelation(graphEdges, 'host-attribute'),
    hostBindingEdges: countRelation(graphEdges, 'host-binding'),
    hostListenerEdges: countRelation(graphEdges, 'host-listener'),
    edgeFunctions: edgeFunctions.length,
    edgeFunctionSourceFiles: edgeFunctions.flatMap(edgeFunction => edgeFunction.sourceFiles ?? []).length,
    edgeFunctionImports: edgeFunctions.flatMap(edgeFunction => edgeFunction.imports ?? []).length,
    edgeFunctionSourceEdges: countRelation(graphEdges, 'edge-function-source'),
    edgeFunctionRouteEdges: countRelation(graphEdges, 'edge-function-route'),
    edgeFunctionMethodEdges: countRelation(graphEdges, 'edge-function-method'),
    edgeFunctionHeaderNodes: graphNodes.filter(node => node?.metadata?.relation === 'edge-function-header').length,
    edgeFunctionHeaderEdges: countRelation(graphEdges, 'edge-function-header'),
    edgeFunctionInvokeEdges: countRelation(graphEdges, 'edge-function-invoke'),
    edgeFunctionTests: edgeFunctions.flatMap(edgeFunction => edgeFunction.tests ?? []).length,
    edgeFunctionTestEdges: edgeFunctions.flatMap(edgeFunction => edgeFunction.testMappings ?? []).length,
    templateBindings: templateBindings.length,
    ...bindingKinds,
    templateComponentEdges: countRelation(graphEdges, 'template-component'),
    templateDirectiveEdges: countRelation(graphEdges, 'template-directive'),
    templatePipeEdges: countRelation(graphEdges, 'template-pipe'),
    templateUrlEdges: countRelation(graphEdges, 'template-url'),
    styleUrlEdges: countRelation(graphEdges, 'style-url'),
    androidKotlinClasses: overlay.android?.kotlinClasses?.length ?? 0,
    androidKotlinDataClasses: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.modifiers?.includes('data')).length,
    androidKotlinSealedClasses: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.modifiers?.includes('sealed')).length,
    androidKotlinInterfaces: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.classKind === 'interface').length,
    androidKotlinInterfaceEdges: countRelation(graphEdges, 'android-kotlin-interface'),
    androidKotlinExtendsEdges: countRelation(graphEdges, 'android-kotlin-extends'),
    androidKotlinImplementsEdges: countRelation(graphEdges, 'android-kotlin-implements'),
    androidKotlinObjects: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.classKind === 'object' && !kotlinClass.isCompanionObject).length,
    androidKotlinObjectEdges: countRelation(graphEdges, 'android-kotlin-object'),
    androidKotlinCompanionObjects: (overlay.android?.kotlinClasses ?? [])
      .filter(kotlinClass => kotlinClass.isCompanionObject).length,
    androidKotlinCompanionObjectEdges: countRelation(graphEdges, 'android-kotlin-companion-object'),
    androidKotlinEnums: overlay.android?.kotlinEnums?.length ?? 0,
    androidKotlinEnumMembers: (overlay.android?.kotlinEnums ?? [])
      .flatMap(kotlinEnum => kotlinEnum.members ?? []).length,
    androidKotlinEnumMemberEdges: countRelation(graphEdges, 'android-kotlin-enum-member'),
    androidKotlinImports: overlay.android?.kotlinImports?.length ?? 0,
    androidKotlinImportEdges: countRelation(graphEdges, 'android-kotlin-import'),
    androidKotlinConstructors: overlay.android?.kotlinConstructors?.length ?? 0,
    androidKotlinConstructorEdges: countRelation(graphEdges, 'android-kotlin-constructor'),
    androidKotlinProperties: overlay.android?.kotlinProperties?.length ?? 0,
    androidKotlinPropertyEdges: countRelation(graphEdges, 'android-kotlin-property'),
    androidKotlinMethods: overlay.android?.kotlinMethods?.length ?? 0,
    androidKotlinMethodEdges: countRelation(graphEdges, 'android-kotlin-method'),
    androidKotlinFunctions: overlay.android?.kotlinFunctions?.length ?? 0,
    androidKotlinFunctionEdges: countRelation(graphEdges, 'android-kotlin-function'),
    androidKotlinOverrideEdges: countRelation(graphEdges, 'android-kotlin-override'),
    androidKotlinTypeReferenceEdges: countRelation(graphEdges, 'android-kotlin-type-reference'),
    androidKotlinCalls: overlay.android?.kotlinCalls?.length ?? 0,
    androidKotlinCallEdges: countRelation(graphEdges, 'android-kotlin-call'),
    androidKotlinAnnotations: countAndroidKotlinAnnotations(overlay.android),
    androidKotlinAnnotationEdges: countRelation(graphEdges, 'android-kotlin-annotation'),
    androidManifestComponents: overlay.android?.manifestComponents?.length ?? 0,
    androidWidgetProviders: overlay.android?.widgetProviders?.length ?? 0,
    androidResourceReferences: overlay.android?.resourceReferences?.length ?? 0,
    totalTestEdges: countRelation(graphEdges, 'test'),
    testEdgesWithTestMapping: graphEdges.filter(edge => edge?.metadata?.testMapping).length,
    testEdgesWithMatchedNeedle: graphEdges.filter(edge => edge?.metadata?.matchedNeedle).length,
    sameBasenameTestEdges: countTestMapping(graphEdges, 'same-basename'),
    classReferenceTestEdges: countTestMapping(graphEdges, 'class-reference'),
    pathReferenceTestEdges: countTestMapping(graphEdges, 'path-reference'),
    routeReferenceTestEdges: countTestMapping(graphEdges, 'route-reference'),
    invokeReferenceTestEdges: countTestMapping(graphEdges, 'invoke-reference'),
    filenameReferenceTestEdges: countTestMapping(graphEdges, 'filename-reference'),
    hardRuleKeywordNodes: countNodeRelation(graphNodes, 'hard-rule-keyword'),
    hardRuleKeywordEdges: countRelation(graphEdges, 'hard-rule-keyword'),
    hardRuleKeywordMappingEdges: countKeywordMapping(graphEdges, 'hard-rule-keyword'),
    hardRuleImplementationEdges: countRelation(graphEdges, 'hard-rule-implementation'),
    hardRuleImplementationTargets: countRelationTargets(graphEdges, 'hard-rule-implementation'),
    syncRules: overlay.agentRules?.syncRules?.length ?? 0,
    configRules: (overlay.agentRules?.syncRules ?? [])
      .filter(rule => /^[A-Z_]+_CONFIG\./.test(String(rule?.name ?? ''))).length,
    syncRuleNodes: countNodeRelation(graphNodes, 'sync-rule'),
    syncRuleKeywordNodes: countNodeRelation(graphNodes, 'sync-rule-keyword'),
    syncRuleKeywordEdges: countKeywordMappings(graphEdges, ['sync-body-keyword', 'sync-config-keyword']),
    syncBodyKeywordEdges: countKeywordMapping(graphEdges, 'sync-body-keyword'),
    syncConfigKeywordEdges: countKeywordMapping(graphEdges, 'sync-config-keyword'),
    configPropertyNodes: countNodeRelation(graphNodes, 'config-property'),
    configPropertyEdges: countRelation(graphEdges, 'config-property'),
    configPropertyParentEdges: graphEdges.filter(edge => (
      edge?.metadata?.relation === 'config-property'
      && edge?.metadata?.parentConfigPath
    )).length,
    configSourceEdges: countRelation(graphEdges, 'config-source'),
    configSourcePropertyEdges: graphEdges.filter(edge => (
      edge?.metadata?.relation === 'config-source'
      && edge?.metadata?.configProperty
    )).length,
    syncConfigSourceEdges: countRelation(graphEdges, 'sync-config-source'),
    migrationFunctionDetails: migrations.flatMap(migration => migration.functionDetails ?? []).length,
    migrationSqlFunctionEdges: countRelation(graphEdges, 'sql-function'),
    migrationSqlFunctionFunctionNodes: countNodeRelation(graphNodes, 'sql-function'),
    migrationTriggers: migrations.flatMap(migration => migration.triggerDetails ?? []).length,
    migrationTriggerEdges: countRelation(graphEdges, 'trigger'),
    migrationTriggerFunctionEdges: countRelation(graphEdges, 'trigger-function'),
    migrationIndexDetails: migrations.flatMap(migration => migration.indexDetails ?? []).length,
    migrationIndexNodes: countNodeRelation(graphNodes, 'migration-index'),
    migrationIndexEdges: countRelation(graphEdges, 'migration-index'),
    migrationConstraintDetails: migrations.flatMap(migration => migration.constraintDetails ?? []).length,
    migrationConstraintNodes: countNodeRelation(graphNodes, 'migration-constraint'),
    migrationConstraintEdges: countRelation(graphEdges, 'migration-constraint'),
    migrationConstraintValidationDetails: migrations.flatMap(migration => migration.constraintValidationDetails ?? []).length,
    migrationConstraintValidationNodes: countNodeRelation(graphNodes, 'migration-constraint-validation'),
    migrationConstraintValidationEdges: countRelation(graphEdges, 'migration-constraint-validation'),
    migrationRlsDetails: migrations.flatMap(migration => migration.rlsDetails ?? []).length,
    migrationRlsEdges: countRelation(graphEdges, 'migration-rls'),
    migrationRealtimePublicationDetails: migrations.flatMap(migration => migration.realtimePublicationDetails ?? []).length,
    migrationRealtimePublicationNodes: countNodeRelation(graphNodes, 'migration-realtime-publication'),
    migrationRealtimePublicationEdges: countRelation(graphEdges, 'migration-realtime-publication'),
    migrationViewDetails: migrations.flatMap(migration => migration.viewDetails ?? []).length,
    migrationViewNodes: countNodeRelation(graphNodes, 'migration-view'),
    migrationViewEdges: countRelation(graphEdges, 'migration-view'),
    migrationTests: migrations.flatMap(migration => migration.tests ?? []).length,
    migrationTestEdges: migrations.flatMap(migration => migration.testMappings ?? []).length,
    policyDetails: migrations.flatMap(migration => migration.policyDetails ?? []).length,
    policyNodes: countNodeRelation(graphNodes, 'policy'),
    policyCommandEdges: countRelation(graphEdges, 'policy-command'),
    policyTypeEdges: countRelation(graphEdges, 'policy-type'),
    policyRoleEdges: countRelation(graphEdges, 'policy-role'),
    policyUsingEdges: countRelation(graphEdges, 'policy-using'),
    policyWithCheckEdges: countRelation(graphEdges, 'policy-with-check'),
    privilegeDetails: migrations.flatMap(migration => migration.privilegeDetails ?? []).length,
    privilegeNodes: countNodeRelation(graphNodes, 'privilege'),
    privilegeObjectNodes: countNodeRelation(graphNodes, 'privilege-object'),
    privilegeRoleNodes: countNodeRelation(graphNodes, 'privilege-role'),
    privilegeGrantEdges: countRelation(graphEdges, 'privilege-grant'),
    privilegeRevokeEdges: countRelation(graphEdges, 'privilege-revoke'),
    privilegeObjectEdges: countRelation(graphEdges, 'privilege-object'),
    privilegeRoleEdges: countRelation(graphEdges, 'privilege-role'),
    supabaseRpcNodes: countNodeRelation(graphNodes, 'supabase-rpc'),
    supabaseRpcEdges: countRelation(graphEdges, 'supabase-rpc'),
    supabaseTableWriteNodes: countNodeRelation(graphNodes, 'supabase-table-write'),
    supabaseTableWriteEdges: countRelation(graphEdges, 'supabase-table-write'),
    supabaseRealtimeChannelNodes: countNodeRelation(graphNodes, 'supabase-realtime-channel'),
    supabaseRealtimeChannelEdges: countRelation(graphEdges, 'supabase-realtime-channel'),
    supabaseRealtimePostgresChangeNodes: countNodeRelation(graphNodes, 'supabase-realtime-postgres-change'),
    supabaseRealtimePostgresChangeEdges: countRelation(graphEdges, 'supabase-realtime-postgres-change'),
    supabaseRealtimeStatusNodes: countRelationTargets(graphEdges, 'supabase-realtime-status'),
    supabaseRealtimeStatusEdges: countRelation(graphEdges, 'supabase-realtime-status'),
    supabaseRealtimeRemoveChannelNodes: countNodeRelation(graphNodes, 'supabase-realtime-remove-channel'),
    supabaseRealtimeRemoveChannelEdges: countRelation(graphEdges, 'supabase-realtime-remove-channel'),
    supabaseRealtimeUnsubscribeNodes: countNodeRelation(graphNodes, 'supabase-realtime-unsubscribe'),
    supabaseRealtimeUnsubscribeEdges: countRelation(graphEdges, 'supabase-realtime-unsubscribe'),
    supabaseRealtimeRemoveAllChannelsNodes: countNodeRelation(graphNodes, 'supabase-realtime-remove-all-channels'),
    supabaseRealtimeRemoveAllChannelsEdges: countRelation(graphEdges, 'supabase-realtime-remove-all-channels'),
    supabaseStorageBucketNodes: countNodeRelation(graphNodes, 'supabase-storage-bucket'),
    supabaseStorageBucketEdges: countRelation(graphEdges, 'supabase-storage-bucket'),
    supabaseSelectFieldNodes: countNodeRelation(graphNodes, 'supabase-select-field'),
    supabaseSelectFieldEdges: countRelation(graphEdges, 'supabase-select-field'),
    supabaseSelectFieldReferenceEdges: graphEdges.filter(edge => (
      edge?.kind === 'references'
      && edge?.metadata?.relation === 'supabase-select-field'
    )).length,
    inlineSelectFieldNodes: graphNodes.filter(node => (
      node?.metadata?.relation === 'supabase-select-field'
      && node?.metadata?.selectSource === 'inline-select'
    )).length,
    inlineSelectFieldEdges: graphEdges.filter(edge => (
      edge?.metadata?.relation === 'supabase-select-field'
      && edge?.metadata?.selectSource === 'inline-select'
    )).length,
    syncRequiredFieldEdges: countRelation(graphEdges, 'sync-required-field'),
    supabaseIncrementalPredicateNodes: countNodeRelation(graphNodes, 'supabase-incremental-predicate'),
    supabaseIncrementalPredicateEdges: countRelation(graphEdges, 'supabase-incremental-predicate'),
    syncRequiredPredicateEdges: countRelation(graphEdges, 'sync-required-predicate'),
  };
}

module.exports = {
  buildBaseline,
};
