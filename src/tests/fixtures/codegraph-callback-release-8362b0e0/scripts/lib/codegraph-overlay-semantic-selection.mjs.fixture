let selectGraphResultsDelegate;
let installed = false;
function installedDelegate(value, delegateName, installerName) {
  if (!value) throw new Error(`${delegateName} requires ${installerName}() before use`);
  return value;
}
export function selectGraphResultsImpl(...values) { return installedDelegate(selectGraphResultsDelegate, 'selectGraphResultsImpl', 'installSemanticSelection')(...values); }

export function installSemanticSelection(runtime) {
  if (installed) throw new Error('installSemanticSelection() may only be called once');
  installed = true;
  const {
    path, CONTEXT7_RELATION_CLOSURE, ANGULAR_SEMANTIC_API_QUERY_TERMS
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    buildGraphIndexes = call('buildGraphIndexes'), collectIncidentEdges = call('collectIncidentEdges'), explicitPathScopeFilePaths = call('explicitPathScopeFilePaths'),
    explicitPathTermMatchesFilePath = call('explicitPathTermMatchesFilePath'), isInExplicitPathScope = call('isInExplicitPathScope'), dedupeScoredEntryByDisplay = call('dedupeScoredEntryByDisplay'),
    dedupeNodeByDisplay = call('dedupeNodeByDisplay'), selectNodeForCandidateMatch = call('selectNodeForCandidateMatch'),
    scoreNodeRelevanceForQuery = call('scoreNodeRelevanceForQuery'), scorePathTermMatch = call('scorePathTermMatch'), lowInformationNodePenalty = call('lowInformationNodePenalty'),
    nodeSearchText = call('nodeSearchText'), joinSearchText = call('joinSearchText'), edgeMatchesExactMetadataQuery = call('edgeMatchesExactMetadataQuery'),
    exactMetadataQueryFromTerms = call('exactMetadataQueryFromTerms'), exactMetadataQueriesFromTerms = call('exactMetadataQueriesFromTerms'), isCombinedExactRelationQueryTerm = call('isCombinedExactRelationQueryTerm'),
    edgeMatchesQueryTermsWithEndpoints = call('edgeMatchesQueryTermsWithEndpoints'), edgeMatchesAnyQueryTermWithEndpoints = call('edgeMatchesAnyQueryTermWithEndpoints'), specificEndpointConstraintTerms = call('specificEndpointConstraintTerms'),
    usesAnyEndpointTermConstraint = call('usesAnyEndpointTermConstraint'), queryTokens = call('queryTokens'), explicitQueryTerms = call('explicitQueryTerms'),
    focusedExplicitQueryTerms = call('focusedExplicitQueryTerms'), isExplicitPathTerm = call('isExplicitPathTerm'), normalizeSearchPath = call('normalizeSearchPath'),
    isMarkdownSymbolNode = call('isMarkdownSymbolNode'), displaySymbolKey = call('displaySymbolKey'), compareNodeSpecificity = call('compareNodeSpecificity'),
    compareNode = call('compareNode'), compareEdge = call('compareEdge'), compareGraphSelectionRelevance = call('compareGraphSelectionRelevance'),
    seedExplicitPathScopedGraphNodeIds = call('seedExplicitPathScopedGraphNodeIds'), orderGeneralQueryEdges = call('orderGeneralQueryEdges'),
    compareExactRelationEdgeSourceOrder = call('compareExactRelationEdgeSourceOrder'), compareNodeSourceOrder = call('compareNodeSourceOrder'), codeBlockSourceFirstRelationQueries = call('codeBlockSourceFirstRelationQueries'),
    sourceFirstSyntheticTargetSuppressionRelationQueries = call('sourceFirstSyntheticTargetSuppressionRelationQueries'), hardRuleEvidenceTargetEntryPointRelationQueries = call('hardRuleEvidenceTargetEntryPointRelationQueries'), ownerPreferredSyntheticVariableRelationQueries = call('ownerPreferredSyntheticVariableRelationQueries'),
    normalizeExactRelationQuery = call('normalizeExactRelationQuery'), isHardRuleEvidenceRelation = call('isHardRuleEvidenceRelation'), unique = call('unique'),
    uniqueBy = call('uniqueBy');

  function selectGraphResults(overlay, rawQuery, matches, limit) {
    const graph = overlay.graph ?? { nodes: [], edges: [] };
    const graphEdges = Array.isArray(graph.edges) ? graph.edges : [];
    const query = rawQuery.toLowerCase();
    const queryTerms = queryTokens(query);
    const explicitTerms = explicitQueryTerms(rawQuery);
    const focusedTerms = focusedExplicitQueryTerms(rawQuery, explicitTerms);
    const scoringContext = { query, queryTerms, explicitTerms, focusedTerms };
    const graphIndexes = buildGraphIndexes({ ...graph, edges: graphEdges });
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
    const relationResults = selectNanoFlowRelationGraphResults(graph, graphEdges, nodesById, query, queryTerms, limit);
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
          pathScore: scorePathTermMatch(node?.filePath, queryTerms),
          lowInformationPenalty: lowInformationNodePenalty(node, rawQuery),
          ...scoreNodeRelevanceForQuery(node, scoringContext),
        };
      })
      .filter(entry => entry.node)
      .sort(compareGraphSelectionRelevance)
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
      .map(node => ({
        node,
        pathScore: scorePathTermMatch(node.filePath, queryTerms),
        lowInformationPenalty: lowInformationNodePenalty(node, rawQuery),
        ...scoreNodeRelevanceForQuery(node, scoringContext),
      }))
      .sort(compareGraphSelectionRelevance)
      .map(entry => entry.node);

    const edges = orderGeneralQueryEdges(
      relatedEdges
        .filter(edge => nodesById.has(edge.source) && nodesById.has(edge.target))
        .map(edge => ({
          ...edge,
          sourceName: nodesById.get(edge.source)?.name ?? edge.source,
          targetName: nodesById.get(edge.target)?.name ?? edge.target,
        })),
      { nodesById, queryTerms, scoringContext, primaryIds, selectedIds },
    );

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

  function selectNanoFlowRelationGraphResults(graph, graphEdges, nodesById, query, queryTerms, limit) {
    const exactRelationEdges = sortExactRelationEdgesForSelection(
      nodesById,
      graphEdges.filter(edge => edgeMatchesExactMetadataQuery(edge, query)),
      query,
    );

    if (exactRelationEdges.length > 0) {
      return selectExactRelationResults(graph, graphEdges, nodesById, exactRelationEdges, limit, query);
    }

    const angularSemanticApiEdges = selectAngularSemanticApiEdges(graphEdges, queryTerms);
    if (angularSemanticApiEdges.length > 0) {
      return selectExactRelationResults(
        graph,
        graphEdges,
        nodesById,
        sortAngularSemanticApiEdgesForSelection(nodesById, angularSemanticApiEdges),
        limit,
        query,
      );
    }

    const exactRelationQueries = exactMetadataQueriesFromTerms(graphEdges, queryTerms);
    if (exactRelationQueries.length > 1) {
      const remainingTerms = queryTerms.filter(term => (
        !exactRelationQueries.includes(term)
        && !isCombinedExactRelationQueryTerm(term, exactRelationQueries)
      ));
      const endpointConstraintTerms = specificEndpointConstraintTerms(remainingTerms);
      const relationEdges = graphEdges
        .filter(edge => exactRelationQueries.some(relation => edgeMatchesExactMetadataQuery(edge, relation)));
      const constrainedEdges = endpointConstraintTerms.length > 0
        ? relationEdges.filter(edge => edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, endpointConstraintTerms))
        : relationEdges;
      if (constrainedEdges.length > 0 || remainingTerms.length > 0) {
        return selectExactRelationResults(
          graph,
          graphEdges,
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
      const relationEdges = graphEdges
        .filter(edge => exactRelationQueries.some(relation => edgeMatchesExactMetadataQuery(edge, relation)));
      return selectExactRelationResults(
        graph,
        graphEdges,
        nodesById,
        sortExactRelationEdgesForSelection(nodesById, relationEdges, exactRelationQueries[0]),
        limit,
        exactRelationQueries[0],
      );
    }

    const exactRelationQuery = exactMetadataQueryFromTerms(graphEdges, queryTerms);
    if (exactRelationQuery) {
      const remainingTerms = queryTerms.filter(term => term !== exactRelationQuery);
      const endpointConstraintTerms = specificEndpointConstraintTerms(remainingTerms);
      const relationEdges = graphEdges
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
          graphEdges,
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


  function selectExactRelationResults(graph, graphEdges, nodesById, exactRelationEdges, limit, query) {
    const selectedEdges = expandExactRelationEdges(graphEdges, exactRelationEdges.slice(0, limit), query);
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

  function expandExactRelationEdges(graphEdges, selectedEdges, query) {
    if (query === 'edge-function-invoke') {
      const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
      const routeOwnerEdges = graphEdges.filter(edge => (
        selectedTargets.has(edge.target)
        && edge.metadata?.relation === 'edge-function-route'
        && edge.kind === 'references'
      ));
      return uniqueBy([...selectedEdges, ...routeOwnerEdges], edge => JSON.stringify(edge));
    }

    if (query === 'android-widget-provider') {
      const selectedSources = new Set(selectedEdges.map(edge => edge.source));
      const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
      const manifestEdges = graphEdges.filter(edge => (
        selectedSources.has(edge.target)
        && edge.metadata?.relation === 'android-manifest-component'
        && edge.kind === 'references'
      ));
      const resourceReferenceEdges = graphEdges.filter(edge => (
        selectedTargets.has(edge.source)
        && edge.metadata?.relation === 'android-resource-reference'
        && edge.kind === 'imports'
      ));
      return uniqueBy([...manifestEdges, ...selectedEdges, ...resourceReferenceEdges], edge => JSON.stringify(edge));
    }

    if (query === 'android-kotlin-method') {
      const selectedMethods = new Set(selectedEdges.flatMap(edge => [edge.source, edge.target]));
      const callEdges = graphEdges.filter(edge => (
        edge.kind === 'calls'
        && edge.metadata?.relation === 'android-kotlin-call'
        && (selectedMethods.has(edge.source) || selectedMethods.has(edge.target))
      ));
      return uniqueBy([...selectedEdges, ...callEdges], edge => JSON.stringify(edge));
    }

    if (query === 'supabase-incremental-predicate') {
      const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
      const requiredPredicateEdges = graphEdges.filter(edge => (
        selectedTargets.has(edge.target)
        && edge.metadata?.relation === 'sync-required-predicate'
        && edge.kind === 'references'
      ));
      return uniqueBy([...selectedEdges, ...requiredPredicateEdges], edge => JSON.stringify(edge));
    }

    if (query === 'sync-required-predicate') {
      const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
      const provenanceEdges = graphEdges.filter(edge => (
        selectedTargets.has(edge.target)
        && edge.metadata?.relation === 'supabase-incremental-predicate'
        && edge.kind === 'references'
      ));
      return uniqueBy([...selectedEdges, ...provenanceEdges], edge => JSON.stringify(edge));
    }

    if (query === 'sync-config-source') {
      const selectedSources = new Set(selectedEdges.map(edge => edge.source));
      const provenanceEdges = graphEdges.filter(edge => (
        selectedSources.has(edge.source)
        && edge.metadata?.relation === 'config-source'
        && edge.kind === 'references'
      ));
      return uniqueBy([...selectedEdges, ...provenanceEdges], edge => JSON.stringify(edge));
    }

    if (query !== 'sync-required-field') return selectedEdges;
    const selectedTargets = new Set(selectedEdges.map(edge => edge.target));
    const provenanceEdges = graphEdges.filter(edge => (
      selectedTargets.has(edge.target)
      && edge.metadata?.relation === 'supabase-select-field'
      && edge.kind === 'references'
    ));
    return uniqueBy([...selectedEdges, ...provenanceEdges], edge => JSON.stringify(edge));
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


  selectGraphResultsDelegate = selectGraphResults;
  Object.assign(runtime, {
    selectGraphResults, augmentRelationResultsWithExplicitPathMatches, selectNanoFlowRelationGraphResults, sortExactRelationEdgesForSelection,
    selectAngularSemanticApiEdges, sortAngularSemanticApiEdgesForSelection, normalizeAngularSemanticApi, isStrongSingleTermNodeMatch, addQualifiedOwnerSymbols,
    addSelectedImportExportStructureNodes, selectedImportExportStructureNodeMatches, readQualifiedOwnerName, readQualifiedNameLeaf, selectExactRelationResults,
    exactRelationDisplayPriority, compareExactRelationEdgeDisplayOrder, usesTargetGroupedProvenanceDisplay, expandExactRelationEdges, isSupabaseEdgeFunctionSourceNode,
    edgeFunctionSourceExplicitlyRequested, preferredAngularResourceEndpointIds, angularResourceEndpointScore, suppressedExactRelationCodeBlockEndpointIds, shouldSuppressLocalEvidenceEndpointForOwnerPreferredRelation,
    isContext7SourcePathNode, isLocalEvidenceNodeKind, hasIncomingOwnerPreferredExactRelationEdge, hasSameRangeSyntheticOperationTarget,
  });
}
