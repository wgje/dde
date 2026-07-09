#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildBaseline } = require('./lib/codegraph-overlay-baseline.cjs');

const args = process.argv.slice(2);
const rootArgIndex = args.indexOf('--root');
const root = rootArgIndex >= 0 && args[rootArgIndex + 1]
  ? path.resolve(args[rootArgIndex + 1])
  : process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function writeText(relativePath, text) {
  fs.writeFileSync(path.join(root, relativePath), text);
}

function replaceOne(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    return text;
  }
  return text.replace(pattern, replacement);
}

function syncAgents(text, baseline) {
  let updated = text;
  updated = replaceOne(
    updated,
    /Android 语义计数为\s+`androidKotlinClasses=\d+`、(?:`androidKotlinDataClasses=\d+`、`androidKotlinSealedClasses=\d+`、)?(?:`androidKotlinInterfaces=\d+`、`androidKotlinInterfaceEdges=\d+`、`androidKotlinExtendsEdges=\d+`、`androidKotlinImplementsEdges=\d+`、)?(?:`androidKotlinObjects=\d+`、`androidKotlinObjectEdges=\d+`、`androidKotlinCompanionObjects=\d+`、`androidKotlinCompanionObjectEdges=\d+`、)?`androidKotlinEnums=\d+`、`androidKotlinEnumMembers=\d+`、`androidKotlinEnumMemberEdges=\d+`、(?:`androidKotlinImports=\d+`、`androidKotlinImportEdges=\d+`、)?`androidKotlinConstructors=\d+`、`androidKotlinConstructorEdges=\d+`、`androidKotlinProperties=\d+`、`androidKotlinPropertyEdges=\d+`、`androidKotlinMethods=\d+`、`androidKotlinMethodEdges=\d+`、(?:`androidKotlinFunctions=\d+`、`androidKotlinFunctionEdges=\d+`、)?(?:`androidKotlinOverrideEdges=\d+`、`androidKotlinTypeReferenceEdges=\d+`、)?`androidKotlinCalls=\d+`、`androidKotlinCallEdges=\d+`、(?:`androidKotlinAnnotations=\d+`、`androidKotlinAnnotationEdges=\d+`、)?`androidManifestComponents=\d+`、`androidWidgetProviders=\d+`、`androidResourceReferences=\d+`/,
    `Android 语义计数为 \`androidKotlinClasses=${baseline.androidKotlinClasses}\`、\`androidKotlinDataClasses=${baseline.androidKotlinDataClasses}\`、\`androidKotlinSealedClasses=${baseline.androidKotlinSealedClasses}\`、\`androidKotlinInterfaces=${baseline.androidKotlinInterfaces}\`、\`androidKotlinInterfaceEdges=${baseline.androidKotlinInterfaceEdges}\`、\`androidKotlinExtendsEdges=${baseline.androidKotlinExtendsEdges}\`、\`androidKotlinImplementsEdges=${baseline.androidKotlinImplementsEdges}\`、\`androidKotlinObjects=${baseline.androidKotlinObjects}\`、\`androidKotlinObjectEdges=${baseline.androidKotlinObjectEdges}\`、\`androidKotlinCompanionObjects=${baseline.androidKotlinCompanionObjects}\`、\`androidKotlinCompanionObjectEdges=${baseline.androidKotlinCompanionObjectEdges}\`、\`androidKotlinEnums=${baseline.androidKotlinEnums}\`、\`androidKotlinEnumMembers=${baseline.androidKotlinEnumMembers}\`、\`androidKotlinEnumMemberEdges=${baseline.androidKotlinEnumMemberEdges}\`、\`androidKotlinImports=${baseline.androidKotlinImports}\`、\`androidKotlinImportEdges=${baseline.androidKotlinImportEdges}\`、\`androidKotlinConstructors=${baseline.androidKotlinConstructors}\`、\`androidKotlinConstructorEdges=${baseline.androidKotlinConstructorEdges}\`、\`androidKotlinProperties=${baseline.androidKotlinProperties}\`、\`androidKotlinPropertyEdges=${baseline.androidKotlinPropertyEdges}\`、\`androidKotlinMethods=${baseline.androidKotlinMethods}\`、\`androidKotlinMethodEdges=${baseline.androidKotlinMethodEdges}\`、\`androidKotlinFunctions=${baseline.androidKotlinFunctions}\`、\`androidKotlinFunctionEdges=${baseline.androidKotlinFunctionEdges}\`、\`androidKotlinOverrideEdges=${baseline.androidKotlinOverrideEdges}\`、\`androidKotlinTypeReferenceEdges=${baseline.androidKotlinTypeReferenceEdges}\`、\`androidKotlinCalls=${baseline.androidKotlinCalls}\`、\`androidKotlinCallEdges=${baseline.androidKotlinCallEdges}\`、\`androidKotlinAnnotations=${baseline.androidKotlinAnnotations}\`、\`androidKotlinAnnotationEdges=${baseline.androidKotlinAnnotationEdges}\`、\`androidManifestComponents=${baseline.androidManifestComponents}\`、\`androidWidgetProviders=${baseline.androidWidgetProviders}\`、\`androidResourceReferences=${baseline.androidResourceReferences}\``,
    'AGENTS Android semantic count summary',
  );
  for (const [label, value] of Object.entries(baseline)) {
    if (label === 'graphNodes' || label === 'graphEdges') {
      continue;
    }
    updated = replaceOne(
      updated,
      new RegExp(`${escapeRegex(label)}=\\d+`),
      `${label}=${value}`,
      `AGENTS.md ${label}`,
    );
  }
  return updated;
}

function syncAdaptationDoc(text, baseline) {
  let updated = text;
  updated = replaceOne(
    updated,
    /[\d,]+\s+graph nodes and\s+[\d,]+\s+graph edges\s+in\s+the native-shaped projection/,
    `${baseline.graphNodes.toLocaleString('en-US')} graph nodes and ${baseline.graphEdges.toLocaleString('en-US')} graph edges in the native-shaped projection`,
    'graph projection summary',
  );
  updated = replaceOne(
    updated,
    /\d+\s+dynamic import entries,\s+\d+\s+dynamic import graph edges,\s+and\s+\d+\s+Angular route/,
    `${baseline.dynamicImports} dynamic import entries, ${baseline.dynamicImportEdges} dynamic import graph edges, and ${baseline.angularRoutes} Angular route`,
    'dynamic import route summary',
  );
  updated = replaceOne(
    updated,
    /(\d+\s+`?angular-route-guard`?\s+edges[\s\S]*?)\d+\s+`?angular-route-resolver`?\s+edges/,
    `${baseline.angularRouteGuardEdges} \`angular-route-guard\` edges\n  (\`canActivate\` and \`canDeactivate\`) and ${baseline.angularRouteResolverEdges} \`angular-route-resolver\` edges`,
    'Angular route guard/resolver summary',
  );
  updated = replaceOne(
    updated,
    /\d+\s+`?angular-route-redirect`?\s+edges([\s\S]*?)\d+\s+`?angular-route-provider`?\s+edges/,
    `${baseline.angularRouteRedirectEdges} \`angular-route-redirect\` edges$1${baseline.angularRouteProviderEdges} \`angular-route-provider\` edges`,
    'Angular route redirect/provider summary',
  );
  updated = replaceOne(
    updated,
    /[\d,]+\s+host-directive edges,\s+[\d,]+\s+host-attribute edges,\s+[\d,]+\s+host-binding edges,\s+and\s+[\d,]+\s+host-listener edges/,
    `${baseline.hostDirectiveEdges} host-directive edges, ${baseline.hostAttributeEdges} host-attribute edges, ${baseline.hostBindingEdges} host-binding edges, and ${baseline.hostListenerEdges} host-listener edges`,
    'Angular host semantic summary',
  );
  updated = replaceOne(
    updated,
    /([\d,]+)(\s+Supabase Edge Functions[\s\S]*?)([\d,]+)(\s+followed source\/helper files[\s\S]*?)([\d,]+)(\s+recorded source import\s+relations,\s+)([\d,]+)(\s+native\s+`?edge-function-source`?\s+import edges,\s+)([\d,]+)(\s+generated[\s\S]*?route nodes\/edges,\s+)([\d,]+)(\s+explicit\s+`?req\.method`?\s+method[\s\S]*?)([\d,]+)(\s+implementation-side\s+`?edge-function-invoke`?\s+edges,\s+and\s+)([\d,]+)(\s+native test-reference edges)/,
    (
      _match,
      _edgeFunctions,
      edgeFunctionSuffix,
      _sourceFiles,
      sourceFilesSuffix,
      _imports,
      importsSuffix,
      _sourceEdges,
      sourceEdgesSuffix,
      _routeEdges,
      routeEdgesSuffix,
      _methodEdges,
      methodEdgesSuffix,
      _invokeEdges,
      invokeEdgesSuffix,
      _testEdges,
      testEdgesSuffix,
    ) => `${baseline.edgeFunctions}${edgeFunctionSuffix}${baseline.edgeFunctionSourceFiles}${sourceFilesSuffix}${baseline.edgeFunctionImports}${importsSuffix}${baseline.edgeFunctionSourceEdges}${sourceEdgesSuffix}${baseline.edgeFunctionRouteEdges}${routeEdgesSuffix}${baseline.edgeFunctionMethodEdges}${methodEdgesSuffix}${baseline.edgeFunctionInvokeEdges}${invokeEdgesSuffix}${baseline.edgeFunctionTestEdges}${testEdgesSuffix}`,
    'Supabase Edge Function summary',
  );
  updated = replaceOne(
    updated,
    /Current Angular template extraction records\s+[\d,]+\s+template\s+bindings:\s+[\d,]+\s+property,\s+[\d,]+\s+event,\s+[\d,]+\s+interpolation,\s+[\d,]+\s+model,\s+[\d,]+\s+control-flow,\s+and\s+[\d,]+\s+structural directive bindings/,
    `Current Angular template extraction records ${baseline.templateBindings.toLocaleString('en-US')} template bindings: ${baseline.property.toLocaleString('en-US')} property, ${baseline.event.toLocaleString('en-US')} event, ${baseline.interpolation.toLocaleString('en-US')} interpolation, ${baseline.model} model, ${baseline['control-flow']} control-flow, and ${baseline.structural} structural directive bindings`,
    'template binding summary',
  );
  updated = replaceOne(
    updated,
    /adds\s+\d+\s+`template-component`\s+edges,\s+\d+\s+`template-directive`\s+edges([\s\S]*?)and\s+\d+\s+`template-pipe`\s+edges/,
    `adds ${baseline.templateComponentEdges} \`template-component\` edges, ${baseline.templateDirectiveEdges} \`template-directive\` edges$1and ${baseline.templatePipeEdges} \`template-pipe\` edges`,
    'template declaration usage summary',
  );
  updated = replaceOne(
    updated,
    /Realtime graph summary:\s+\d+\s+supabase-realtime-channel edges,\s+\d+\s+supabase-realtime-postgres-change edges,\s+\d+\s+supabase-realtime-status edges,\s+\d+\s+supabase-realtime-remove-channel edges,\s+\d+\s+supabase-realtime-unsubscribe edges,\s+and\s+\d+\s+supabase-realtime-remove-all-channels edges/,
    `Realtime graph summary: ${baseline.supabaseRealtimeChannelEdges} supabase-realtime-channel edges, ${baseline.supabaseRealtimePostgresChangeEdges} supabase-realtime-postgres-change edges, ${baseline.supabaseRealtimeStatusEdges} supabase-realtime-status edges, ${baseline.supabaseRealtimeRemoveChannelEdges} supabase-realtime-remove-channel edges, ${baseline.supabaseRealtimeUnsubscribeEdges} supabase-realtime-unsubscribe edges, and ${baseline.supabaseRealtimeRemoveAllChannelsEdges} supabase-realtime-remove-all-channels edges`,
    'Realtime graph summary',
  );
  updated = replaceOne(
    updated,
    /Realtime node summary:\s+[\d,]+\s+supabase-realtime-channel nodes,\s+[\d,]+\s+supabase-realtime-postgres-change nodes,\s+[\d,]+\s+supabase-realtime-status nodes,\s+[\d,]+\s+supabase-realtime-remove-channel nodes,\s+[\d,]+\s+supabase-realtime-unsubscribe nodes,\s+and\s+[\d,]+\s+supabase-realtime-remove-all-channels nodes/,
    `Realtime node summary: ${baseline.supabaseRealtimeChannelNodes} supabase-realtime-channel nodes, ${baseline.supabaseRealtimePostgresChangeNodes} supabase-realtime-postgres-change nodes, ${baseline.supabaseRealtimeStatusNodes} supabase-realtime-status nodes, ${baseline.supabaseRealtimeRemoveChannelNodes} supabase-realtime-remove-channel nodes, ${baseline.supabaseRealtimeUnsubscribeNodes} supabase-realtime-unsubscribe nodes, and ${baseline.supabaseRealtimeRemoveAllChannelsNodes} supabase-realtime-remove-all-channels nodes`,
    'Realtime node summary',
  );
  updated = replaceOne(
    updated,
    /Realtime status layer adds\s+[\d,]+\s+native\s+`?supabase-realtime-status`?\s+nodes\/edges/,
    `Realtime status layer adds ${baseline.supabaseRealtimeStatusNodes} native supabase-realtime-status nodes/edges`,
    'Realtime status layer summary',
  );
  updated = replaceOne(
    updated,
    /The Supabase select-field layer adds[\s\S]*?The Storage bucket\s+layer adds[\s\S]*?native\s+`?references`?\s+edges/,
    `The Supabase select-field layer adds ${baseline.supabaseSelectFieldNodes} native \`supabase-select-field\` property nodes, ${baseline.supabaseSelectFieldEdges} \`supabase-select-field\` edges, ${baseline.supabaseSelectFieldReferenceEdges} method/function \`references\` edges from \`.select(...)\` call sites to selected fields, ${baseline.inlineSelectFieldNodes} inline select field nodes, ${baseline.inlineSelectFieldEdges} inline select provenance edges, and ${baseline.syncRequiredFieldEdges} \`sync-required-field\` edges from the AGENTS \`content\` hard-rule keyword to tasks field nodes. The incremental-predicate layer adds ${baseline.supabaseIncrementalPredicateNodes} \`supabase-incremental-predicate\` nodes, ${baseline.supabaseIncrementalPredicateEdges} method/function predicate \`references\` edges, and ${baseline.syncRequiredPredicateEdges} \`sync-required-predicate\` edges from AGENTS keywords to query predicates. The Storage bucket layer adds ${baseline.supabaseStorageBucketNodes} \`supabase-storage-bucket\` nodes and ${baseline.supabaseStorageBucketEdges} native \`references\` edges`,
    'Supabase select/storage prose summary',
  );
  updated = replaceOne(
    updated,
    /Select and storage node summary:\s+[\d,]+\s+supabase-select-field nodes,\s+[\d,]+\s+inline select field nodes,\s+[\d,]+\s+supabase-incremental-predicate nodes,\s+and\s+[\d,]+\s+supabase-storage-bucket nodes/,
    `Select and storage node summary: ${baseline.supabaseSelectFieldNodes} supabase-select-field nodes, ${baseline.inlineSelectFieldNodes} inline select field nodes, ${baseline.supabaseIncrementalPredicateNodes} supabase-incremental-predicate nodes, and ${baseline.supabaseStorageBucketNodes} supabase-storage-bucket nodes`,
    'Select and storage node summary',
  );
  updated = replaceOne(
    updated,
    /Select and storage graph summary:\s+[\d,]+\s+supabase-select-field edges,\s+[\d,]+\s+supabase-select-field reference edges,\s+[\d,]+\s+inline select provenance edges,\s+[\d,]+\s+sync-required-field edges,\s+[\d,]+\s+supabase-incremental-predicate edges,\s+[\d,]+\s+sync-required-predicate edges,\s+and\s+[\d,]+\s+supabase-storage-bucket edges/,
    `Select and storage graph summary: ${baseline.supabaseSelectFieldEdges} supabase-select-field edges, ${baseline.supabaseSelectFieldReferenceEdges} supabase-select-field reference edges, ${baseline.inlineSelectFieldEdges} inline select provenance edges, ${baseline.syncRequiredFieldEdges} sync-required-field edges, ${baseline.supabaseIncrementalPredicateEdges} supabase-incremental-predicate edges, ${baseline.syncRequiredPredicateEdges} sync-required-predicate edges, and ${baseline.supabaseStorageBucketEdges} supabase-storage-bucket edges`,
    'Select and storage graph summary',
  );
  updated = replaceOne(
    updated,
    /The operation node summary is\s+\d+\s+Supabase RPC nodes and\s+\d+\s+Supabase RPC edges;\s+\d+\s+Supabase table-write nodes and\s+\d+\s+Supabase table-write edges/,
    `The operation node summary is ${baseline.supabaseRpcNodes} Supabase RPC nodes and ${baseline.supabaseRpcEdges} Supabase RPC edges; ${baseline.supabaseTableWriteNodes} Supabase table-write nodes and ${baseline.supabaseTableWriteEdges} Supabase table-write edges`,
    'operation node summary',
  );
  updated = replaceOne(
    updated,
    /The Supabase RPC\/table-write layer adds\s+\d+\s+`supabase-rpc` nodes and\s+\d+\s+native\s+`references` edges for static `rpc\(\.\.\.\)` calls,\s+plus\s+\d+\s+`supabase-table-write` nodes and\s+\d+\s+native\s+`references` edges for static/s,
    `The Supabase RPC/table-write layer adds ${baseline.supabaseRpcNodes} \`supabase-rpc\` nodes and ${baseline.supabaseRpcEdges} native\n  \`references\` edges for static \`rpc(...)\` calls, plus ${baseline.supabaseTableWriteNodes}\n  \`supabase-table-write\` nodes and ${baseline.supabaseTableWriteEdges} native \`references\` edges for static`,
    'operation prose summary',
  );
  updated = replaceOne(
    updated,
    /The operation graph summary is\s+\d+\s+Supabase RPC edges and\s+\d+\s+Supabase table-write edges/,
    `The operation graph summary is ${baseline.supabaseRpcEdges} Supabase RPC edges and ${baseline.supabaseTableWriteEdges} Supabase table-write edges`,
    'operation graph summary',
  );
  updated = replaceOne(
    updated,
    /adds\s+\d+\s+`edge-function-header`[\s\S]*?nodes and\s+\d+\s+native\s+`references`\s+edges/,
    `adds ${baseline.edgeFunctionHeaderNodes} \`edge-function-header\`\n  native-shaped \`variable\` nodes and ${baseline.edgeFunctionHeaderEdges} native \`references\` edges`,
    'Edge Function header summary',
  );
  updated = replaceOne(
    updated,
    /Android Kotlin member graph summary:\s+[\d,]+\s+androidKotlinClasses,(?:\s+[\d,]+\s+androidKotlinDataClasses,\s+[\d,]+\s+androidKotlinSealedClasses,)?(?:\s+[\d,]+\s+androidKotlinInterfaces,\s+[\d,]+\s+androidKotlinInterfaceEdges,\s+[\d,]+\s+androidKotlinExtendsEdges,\s+[\d,]+\s+androidKotlinImplementsEdges,)?(?:\s+[\d,]+\s+androidKotlinObjects,\s+[\d,]+\s+androidKotlinObjectEdges,\s+[\d,]+\s+androidKotlinCompanionObjects,\s+[\d,]+\s+androidKotlinCompanionObjectEdges,)?(?:\s+[\d,]+\s+androidKotlinEnums,\s+[\d,]+\s+androidKotlinEnumMembers,\s+[\d,]+\s+androidKotlinEnumMemberEdges,)?(?:\s+[\d,]+\s+androidKotlinImports,\s+[\d,]+\s+androidKotlinImportEdges,)?\s+[\d,]+\s+androidKotlinConstructors,\s+[\d,]+\s+androidKotlinConstructorEdges,\s+[\d,]+\s+androidKotlinProperties,\s+[\d,]+\s+androidKotlinPropertyEdges,\s+[\d,]+\s+androidKotlinMethods,\s+[\d,]+\s+androidKotlinMethodEdges,(?:\s+[\d,]+\s+androidKotlinFunctions,\s+[\d,]+\s+androidKotlinFunctionEdges,)?(?:\s+[\d,]+\s+androidKotlinOverrideEdges,\s+[\d,]+\s+androidKotlinTypeReferenceEdges,)?\s+[\d,]+\s+androidKotlinCalls,(?:\s+and\s+[\d,]+\s+androidKotlinCallEdges|\s+[\d,]+\s+androidKotlinCallEdges,\s+[\d,]+\s+androidKotlinAnnotations,\s+and\s+[\d,]+\s+androidKotlinAnnotationEdges)/,
    `Android Kotlin member graph summary: ${baseline.androidKotlinClasses} androidKotlinClasses, ${baseline.androidKotlinDataClasses} androidKotlinDataClasses, ${baseline.androidKotlinSealedClasses} androidKotlinSealedClasses, ${baseline.androidKotlinInterfaces} androidKotlinInterfaces, ${baseline.androidKotlinInterfaceEdges} androidKotlinInterfaceEdges, ${baseline.androidKotlinExtendsEdges} androidKotlinExtendsEdges, ${baseline.androidKotlinImplementsEdges} androidKotlinImplementsEdges, ${baseline.androidKotlinObjects} androidKotlinObjects, ${baseline.androidKotlinObjectEdges} androidKotlinObjectEdges, ${baseline.androidKotlinCompanionObjects} androidKotlinCompanionObjects, ${baseline.androidKotlinCompanionObjectEdges} androidKotlinCompanionObjectEdges, ${baseline.androidKotlinEnums} androidKotlinEnums, ${baseline.androidKotlinEnumMembers} androidKotlinEnumMembers, ${baseline.androidKotlinEnumMemberEdges} androidKotlinEnumMemberEdges, ${baseline.androidKotlinImports} androidKotlinImports, ${baseline.androidKotlinImportEdges} androidKotlinImportEdges, ${baseline.androidKotlinConstructors} androidKotlinConstructors, ${baseline.androidKotlinConstructorEdges} androidKotlinConstructorEdges, ${baseline.androidKotlinProperties} androidKotlinProperties, ${baseline.androidKotlinPropertyEdges} androidKotlinPropertyEdges, ${baseline.androidKotlinMethods} androidKotlinMethods, ${baseline.androidKotlinMethodEdges} androidKotlinMethodEdges, ${baseline.androidKotlinFunctions} androidKotlinFunctions, ${baseline.androidKotlinFunctionEdges} androidKotlinFunctionEdges, ${baseline.androidKotlinOverrideEdges} androidKotlinOverrideEdges, ${baseline.androidKotlinTypeReferenceEdges} androidKotlinTypeReferenceEdges, ${baseline.androidKotlinCalls} androidKotlinCalls, ${baseline.androidKotlinCallEdges} androidKotlinCallEdges, ${baseline.androidKotlinAnnotations} androidKotlinAnnotations, and ${baseline.androidKotlinAnnotationEdges} androidKotlinAnnotationEdges`,
    'Android Kotlin member graph summary',
  );
  updated = replaceOne(
    updated,
    /Android packaging\/resource graph summary:\s+[\d,]+\s+androidManifestComponents,\s+[\d,]+\s+androidWidgetProviders,\s+and\s+[\d,]+\s+androidResourceReferences/,
    `Android packaging/resource graph summary: ${baseline.androidManifestComponents} androidManifestComponents, ${baseline.androidWidgetProviders} androidWidgetProviders, and ${baseline.androidResourceReferences} androidResourceReferences`,
    'Android packaging/resource graph summary',
  );
  updated = replaceOne(
    updated,
    /The migration graph summary is\s+\d+\s+SQL function edges,\s+\d+\s+trigger-function edges,\s+\d+\s+migration-index edges,\s+\d+\s+migration-constraint edges,\s+\d+\s+migration-constraint-validation edges,\s+and\s+\d+\s+migration-rls edges/,
    `The migration graph summary is ${baseline.migrationSqlFunctionEdges} SQL function edges, ${baseline.migrationTriggerFunctionEdges} trigger-function edges, ${baseline.migrationIndexEdges} migration-index edges, ${baseline.migrationConstraintEdges} migration-constraint edges, ${baseline.migrationConstraintValidationEdges} migration-constraint-validation edges, and ${baseline.migrationRlsEdges} migration-rls edges`,
    'migration graph summary',
  );
  updated = replaceOne(
    updated,
    /[\d,]+\s+migration-realtime-publication edges backed by\s+[\d,]+\s+publication nodes from\s+[\d,]+\s+parsed publication details,\s+and\s+[\d,]+\s+migration-view edges backed by\s+[\d,]+\s+view nodes from\s+[\d,]+\s+parsed view details/,
    `${baseline.migrationRealtimePublicationEdges} migration-realtime-publication edges backed by ${baseline.migrationRealtimePublicationNodes} publication nodes from ${baseline.migrationRealtimePublicationDetails} parsed publication details, and ${baseline.migrationViewEdges} migration-view edges backed by ${baseline.migrationViewNodes} view nodes from ${baseline.migrationViewDetails} parsed view details`,
    'migration publication/view summary',
  );
  updated = replaceOne(
    updated,
    /((?:The Supabase migration node summary is\s+)?)[\d,]+\s+SQL function nodes,\s+[\d,]+\s+SQL function edges,\s+[\d,]+\s+trigger edges,\s+[\d,]+\s+trigger-function edges,\s+[\d,]+\s+migration-index nodes,\s+[\d,]+\s+migration-index edges,\s+[\d,]+\s+migration-constraint nodes,\s+[\d,]+\s+migration-constraint edges,\s+[\d,]+\s+migration-constraint-validation nodes,\s+[\d,]+\s+migration-constraint-validation edges,\s+and\s+[\d,]+\s+migration-rls edges/,
    (_match, prefix) => `${prefix}${baseline.migrationSqlFunctionFunctionNodes} SQL function nodes, ${baseline.migrationSqlFunctionEdges} SQL function edges, ${baseline.migrationTriggerEdges} trigger edges, ${baseline.migrationTriggerFunctionEdges} trigger-function edges, ${baseline.migrationIndexNodes} migration-index nodes, ${baseline.migrationIndexEdges} migration-index edges, ${baseline.migrationConstraintNodes} migration-constraint nodes, ${baseline.migrationConstraintEdges} migration-constraint edges, ${baseline.migrationConstraintValidationNodes} migration-constraint-validation nodes, ${baseline.migrationConstraintValidationEdges} migration-constraint-validation edges, and ${baseline.migrationRlsEdges} migration-rls edges`,
    'Supabase migration node summary',
  );
  updated = replaceOne(
    updated,
    /((?:The Supabase migration test summary is\s+)?)[\d,]+\s+migration tests and\s+[\d,]+\s+migration test edges/,
    (_match, prefix) => `${prefix}${baseline.migrationTests} migration tests and ${baseline.migrationTestEdges} migration test edges`,
    'Supabase migration test summary',
  );
  updated = replaceOne(
    updated,
    /((?:The Supabase policy\/privilege node summary is\s+)?)[\d,]+\s+policy nodes,\s+[\d,]+\s+policy-command edges,\s+[\d,]+\s+policy-type edges,\s+[\d,]+\s+policy-role edges,\s+[\d,]+\s+policy-using edges,\s+[\d,]+\s+policy-with-check edges,\s+[\d,]+\s+privilege nodes,\s+[\d,]+\s+privilege-object nodes,\s+[\d,]+\s+privilege-grant edges,\s+[\d,]+\s+privilege-revoke edges,\s+[\d,]+\s+privilege-object edges,\s+[\d,]+\s+privilege-role nodes,\s+and\s+[\d,]+\s+privilege-role edges/,
    (_match, prefix) => `${prefix}${baseline.policyNodes} policy nodes, ${baseline.policyCommandEdges} policy-command edges, ${baseline.policyTypeEdges} policy-type edges, ${baseline.policyRoleEdges} policy-role edges, ${baseline.policyUsingEdges} policy-using edges, ${baseline.policyWithCheckEdges} policy-with-check edges, ${baseline.privilegeNodes} privilege nodes, ${baseline.privilegeObjectNodes} privilege-object nodes, ${baseline.privilegeGrantEdges} privilege-grant edges, ${baseline.privilegeRevokeEdges} privilege-revoke edges, ${baseline.privilegeObjectEdges} privilege-object edges, ${baseline.privilegeRoleNodes} privilege-role nodes, and ${baseline.privilegeRoleEdges} privilege-role edges`,
    'Supabase policy/privilege node summary',
  );
  updated = replaceOne(
    updated,
    /((?:The policy and privilege graph summary\s+is\s+)?)[\d,]+\s+policy-command edges,\s+[\d,]+\s+policy-type edges,\s+[\d,]+\s+policy-role edges,\s+[\d,]+\s+policy-using edges,\s+[\d,]+\s+policy-with-check edges,\s+[\d,]+\s+privilege-grant edges,\s+[\d,]+\s+privilege-revoke edges,\s+[\d,]+\s+privilege-object edges,\s+and\s+[\d,]+\s+privilege-role edges/,
    (_match, prefix) => `${prefix}${baseline.policyCommandEdges} policy-command edges, ${baseline.policyTypeEdges} policy-type edges, ${baseline.policyRoleEdges} policy-role edges, ${baseline.policyUsingEdges} policy-using edges, ${baseline.policyWithCheckEdges} policy-with-check edges, ${baseline.privilegeGrantEdges} privilege-grant edges, ${baseline.privilegeRevokeEdges} privilege-revoke edges, ${baseline.privilegeObjectEdges} privilege-object edges, and ${baseline.privilegeRoleEdges} privilege-role edges`,
    'policy and privilege graph summary',
  );
  updated = replaceOne(
    updated,
    /(`?policyDetails`?\s+array currently contains\s+)[\d,]+(\s+parsed policy detail records,\s+`?functionDetails`?\s+contains\s+)[\d,]+(\s+parsed SQL function definitions,\s+`?triggerDetails`?\s+contains\s+)[\d,]+(\s+parsed SQL trigger definitions,\s+`?indexDetails`?\s+contains\s+)[\d,]+(\s+parsed SQL index definitions,\s+and\s+`?constraintDetails`?\s+contains\s+)[\d,]+(\s+parsed SQL constraints)/,
    (_match, policyPrefix, functionPrefix, triggerPrefix, indexPrefix, constraintPrefix, suffix) => `${policyPrefix}${baseline.policyDetails}${functionPrefix}${baseline.migrationFunctionDetails}${triggerPrefix}${baseline.migrationTriggers}${indexPrefix}${baseline.migrationIndexDetails}${constraintPrefix}${baseline.migrationConstraintDetails}${suffix}`,
    'Supabase migration structured detail narrative',
  );
  updated = replaceOne(
    updated,
    /(`?constraintValidationDetails`?\s+contains\s+)[\d,]+(\s+parsed SQL constraint validation statements)/,
    (_match, prefix, suffix) => `${prefix}${baseline.migrationConstraintValidationDetails}${suffix}`,
    'Supabase constraint validation detail narrative',
  );
  updated = replaceOne(
    updated,
    /(`?privilegeDetails`?\s+array contains\s+)[\d,]+(\s+parsed PostgreSQL\s+`?GRANT`?\s+\/\s+`?REVOKE`?\s+statements)/,
    (_match, prefix, suffix) => `${prefix}${baseline.privilegeDetails}${suffix}`,
    'Supabase privilege detail narrative',
  );
  updated = replaceOne(
    updated,
    /Supabase structured detail summary:\s+[\d,]+\s+edgeFunctionTests,\s+[\d,]+\s+migrationFunctionDetails,\s+[\d,]+\s+migrationTriggers,\s+[\d,]+\s+migrationRlsDetails,\s+[\d,]+\s+migrationTests,\s+and\s+[\d,]+\s+policyDetails/,
    `Supabase structured detail summary: ${baseline.edgeFunctionTests} edgeFunctionTests, ${baseline.migrationFunctionDetails} migrationFunctionDetails, ${baseline.migrationTriggers} migrationTriggers, ${baseline.migrationRlsDetails} migrationRlsDetails, ${baseline.migrationTests} migrationTests, and ${baseline.policyDetails} policyDetails`,
    'Supabase structured detail summary',
  );
  updated = replaceOne(
    updated,
    /The AGENTS hard-rule node\/provenance summary is\s+\d+\s+hard-rule keyword nodes,\s+\d+\s+hard-rule keyword edges,\s+\d+\s+hard-rule keyword mapping edges,\s+\d+\s+hard-rule implementation edges,\s+and\s+\d+\s+hard-rule implementation targets/,
    `The AGENTS hard-rule node/provenance summary is ${baseline.hardRuleKeywordNodes} hard-rule keyword nodes, ${baseline.hardRuleKeywordEdges} hard-rule keyword edges, ${baseline.hardRuleKeywordMappingEdges} hard-rule keyword mapping edges, ${baseline.hardRuleImplementationEdges} hard-rule implementation edges, and ${baseline.hardRuleImplementationTargets} hard-rule implementation targets`,
    'AGENTS hard-rule node summary',
  );
  updated = replaceOne(
    updated,
    /The AGENTS hard-rule graph summary is\s+\d+\s+hard-rule keyword edges and\s+\d+\s+hard-rule implementation edges/,
    `The AGENTS hard-rule graph summary is ${baseline.hardRuleKeywordEdges} hard-rule keyword edges and ${baseline.hardRuleImplementationEdges} hard-rule implementation edges`,
    'AGENTS hard-rule graph summary',
  );
  updated = replaceOne(
    updated,
    /The AGENTS sync-rule graph summary is\s+\d+\s+sync-rule anchors,\s+\d+\s+sync-body keyword edges,\s+\d+\s+sync-config keyword edges,\s+and\s+\d+\s+config-source edges/,
    `The AGENTS sync-rule graph summary is ${baseline.syncRules} sync-rule anchors, ${baseline.syncBodyKeywordEdges} sync-body keyword edges, ${baseline.syncConfigKeywordEdges} sync-config keyword edges, and ${baseline.configSourceEdges} config-source edges`,
    'AGENTS sync-rule graph summary',
  );
  updated = replaceOne(
    updated,
    /The AGENTS sync-rule node\/provenance summary is\s+\d+\s+sync-rule anchors,\s+\d+\s+config-rule anchors,\s+\d+\s+sync-rule nodes,\s+\d+\s+sync-rule keyword nodes,\s+\d+\s+sync-rule keyword edges,\s+\d+\s+sync-body keyword edges,\s+\d+\s+sync-config keyword edges,\s+\d+\s+config-property nodes,\s+\d+\s+config-property edges,\s+\d+\s+config-property parent edges,\s+\d+\s+config-source edges,\s+\d+\s+config-source property edges,\s+and\s+\d+\s+sync-config-source edges/,
    `The AGENTS sync-rule node/provenance summary is ${baseline.syncRules} sync-rule anchors, ${baseline.configRules} config-rule anchors, ${baseline.syncRuleNodes} sync-rule nodes, ${baseline.syncRuleKeywordNodes} sync-rule keyword nodes, ${baseline.syncRuleKeywordEdges} sync-rule keyword edges, ${baseline.syncBodyKeywordEdges} sync-body keyword edges, ${baseline.syncConfigKeywordEdges} sync-config keyword edges, ${baseline.configPropertyNodes} config-property nodes, ${baseline.configPropertyEdges} config-property edges, ${baseline.configPropertyParentEdges} config-property parent edges, ${baseline.configSourceEdges} config-source edges, ${baseline.configSourcePropertyEdges} config-source property edges, and ${baseline.syncConfigSourceEdges} sync-config-source edges`,
    'AGENTS sync-rule node summary',
  );
  updated = replaceOne(
    updated,
    /([\d,]+)\s+total test-reference edges;\s+all\s+[\d,]+\s+carry provenance in\s+`?metadata\.testMapping`?\.\s+Angular contributes\s+[\d,]+\s+`?same-basename`?\s+edges and\s+[\d,]+\s+`?class-reference`?\s+edges\.\s+Supabase contributes\s+[\d,]+\s+`?path-reference`?\s+edges,\s+[\d,]+\s+`?route-reference`?\s+edge[s]?,\s+[\d,]+\s+`?invoke-reference`?\s+edges,\s+and\s+[\d,]+\s+`?filename-reference`?\s+edges\.[\s\S]*?[\d,]+\s+(?:template\/)?path\/route\/filename-derived edges also render/,
    `${baseline.totalTestEdges} total test-reference edges; all ${baseline.testEdgesWithTestMapping} carry provenance in\n  \`metadata.testMapping\`. Angular contributes ${baseline.sameBasenameTestEdges} \`same-basename\` edges and\n  ${baseline.classReferenceTestEdges} \`class-reference\` edges. Supabase contributes ${baseline.pathReferenceTestEdges} \`path-reference\` edges,\n  ${baseline.routeReferenceTestEdges} \`route-reference\` edge, ${baseline.invokeReferenceTestEdges} \`invoke-reference\` edges, and ${baseline.filenameReferenceTestEdges}\n  \`filename-reference\` edges. Default JSON \`relationshipGroups\` and Markdown\n  render \`testMapping\`; ${baseline.testEdgesWithMatchedNeedle.toLocaleString('en-US')} template/path/route/filename-derived edges also render`,
    'test mapping summary',
  );
  updated = replaceOne(
    updated,
    /Angular external resource graph summary:\s+\d+\s+template-url edges and\s+\d+\s+style-url edges/,
    `Angular external resource graph summary: ${baseline.templateUrlEdges} template-url edges and ${baseline.styleUrlEdges} style-url edges`,
    'Angular external resource graph summary',
  );
  return updated;
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

const overlay = readJson('.codegraph/nanoflow-overlay.json');
const baseline = buildBaseline(overlay);
writeText('AGENTS.md', syncAgents(readText('AGENTS.md'), baseline));
writeText('docs/codegraph-nanoflow-adaptation.md', syncAdaptationDoc(readText('docs/codegraph-nanoflow-adaptation.md'), baseline));
console.log(
  `CodeGraph overlay documentation counts synced (${baseline.graphNodes.toLocaleString('en-US')} nodes, ${baseline.graphEdges.toLocaleString('en-US')} edges).`,
);
