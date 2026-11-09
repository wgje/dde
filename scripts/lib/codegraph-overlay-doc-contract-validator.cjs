'use strict';

function installDocContractValidator(runtime) {
  const {
    path, errors, MAX_GRAPH_ERRORS_PER_CATEGORY, PROJECT_SEMANTIC_DOC_COUNTERS,
    OFFICIAL_CODEGRAPH_LANGUAGES, OFFICIAL_CODEGRAPH_NODE_KINDS, OFFICIAL_CODEGRAPH_EDGE_KINDS, OVERLAY_EXCLUDED_DIRS,
    MIGRATION_FILE_SOURCE_RELATIONS, REGISTERED_RELATIONS, REGISTERED_TEST_MAPPINGS, TEST_MAPPINGS_REQUIRING_MATCHED_NEEDLE,
    REGISTERED_KEYWORD_MAPPINGS, PROJECT_SEMANTIC_COVERAGE_CONTRACTS, RELATION_METADATA_CONTRACTS, ZERO_REASON_COUNTERS
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    readFirstNumber = call('readFirstNumber'), readInlineCounters = call('readInlineCounters'), expectNumber = call('expectNumber'),
    expectEveryNumber = call('expectEveryNumber'), validateSourceOrderingDiagnostics = call('validateSourceOrderingDiagnostics'), validateMcpLogGuardDiagnostics = call('validateMcpLogGuardDiagnostics'),
    validateQueryPathRelevanceContract = call('validateQueryPathRelevanceContract'), validateCodexMcpConfigContract = call('validateCodexMcpConfigContract'), validateStrictNativeSourceEvidenceContract = call('validateStrictNativeSourceEvidenceContract'),
    validateStrictNativeOutputOrderContract = call('validateStrictNativeOutputOrderContract'), validateStrictNativeObjectProjectionContract = call('validateStrictNativeObjectProjectionContract'), validateAdapterGateContract = call('validateAdapterGateContract'),
    validateAdapterFirstFallbackContract = call('validateAdapterFirstFallbackContract'), validateUpstreamCodeGraphBoundaryContract = call('validateUpstreamCodeGraphBoundaryContract'), validateSingleSharedTreeFreshnessContract = call('validateSingleSharedTreeFreshnessContract'),
    validateLocalCodeGraphSourceSetup = call('validateLocalCodeGraphSourceSetup'), escapeRegex = call('escapeRegex');

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

  function validateImmutableGenerationAuthorityContract(text, file) {
    const requirements = [
      ['immutable generation selector', '.codegraph/nanoflow-generations/CURRENT.json'],
      ['immutable generation directory contract', '.codegraph/nanoflow-generations/<generation-id>/'],
      ['generation compatibility copy contract', 'compatibility/nanoflow-overlay.json'],
      ['shared CURRENT reader module', 'scripts/lib/codegraph-overlay-current-receipt.cjs'],
      ['shared CURRENT reader API', 'readOverlayCurrentReceipt(projectRoot)'],
    ];
    for (const [label, token] of requirements) {
      if (!text.includes(token)) errors.push(`${file} missing ${label} ${token}`);
    }
    if (text.includes('.codegraph/nanoflow-overlay.json')) {
      errors.push(`${file} must not describe .codegraph/nanoflow-overlay.json as production authority`);
    }
  }

  function validateAdaptationDoc(text, baseline) {
    const file = 'docs/codegraph-nanoflow-adaptation.md';
    validateImmutableGenerationAuthorityContract(text, file);
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


  Object.assign(runtime, {
    recordGraphError, validateOverlayGraphShape, validateOverlayNodeShape, validateOverlayNodeLocation, validateOverlayNodePath,
    validateOverlayEdgeShape, validateMigrationTableTarget, validateRegisteredRelation, validateOverlayEdgeMetadata, validateProjectSemanticCoverageContract,
    normalizeOverlayFilePath, isAbsoluteOverlayPath, validateImmutableGenerationAuthorityContract, validateAdaptationDoc,
  });
}

module.exports = { installDocContractValidator };
