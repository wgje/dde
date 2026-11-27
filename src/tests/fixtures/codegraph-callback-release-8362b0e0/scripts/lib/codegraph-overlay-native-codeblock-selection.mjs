let buildNativeCodeBlocksDelegate;
let installed = false;
function installedDelegate(value, delegateName, installerName) {
  if (!value) throw new Error(`${delegateName} requires ${installerName}() before use`);
  return value;
}
export function buildNativeCodeBlocksImpl(...values) { return installedDelegate(buildNativeCodeBlocksDelegate, 'buildNativeCodeBlocksImpl', 'installNativeCodeblockSelection')(...values); }

export function installNativeCodeblockSelection(runtime) {
  if (installed) throw new Error('installNativeCodeblockSelection() may only be called once');
  installed = true;
  const {
    path, NATIVE_CONTEXT_CODE_BLOCK_LIMIT
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    isStrongSingleTermNodeMatch = call('isStrongSingleTermNodeMatch'), readQualifiedNameLeaf = call('readQualifiedNameLeaf'), nodeSearchText = call('nodeSearchText'),
    edgeMatchesExactMetadataQuery = call('edgeMatchesExactMetadataQuery'), exactMetadataQueriesFromTerms = call('exactMetadataQueriesFromTerms'), queryTokens = call('queryTokens'),
    scorePathTermMatch = call('scorePathTermMatch'), queryScoringContext = call('queryScoringContext'), scoreNodeRelevanceForQuery = call('scoreNodeRelevanceForQuery'),
    lowInformationNodePenalty = call('lowInformationNodePenalty'), isExplicitPathTerm = call('isExplicitPathTerm'), compareNodeSpecificity = call('compareNodeSpecificity'),
    hardRuleEvidenceTargetExactRelationEntryPointIds = call('hardRuleEvidenceTargetExactRelationEntryPointIds'), highValueRank = call('highValueRank'), isSupabaseEdgeFunctionSourceNode = call('isSupabaseEdgeFunctionSourceNode'),
    edgeFunctionSourceExplicitlyRequested = call('edgeFunctionSourceExplicitlyRequested'), preferredAngularResourceEndpointIds = call('preferredAngularResourceEndpointIds'), suppressedExactRelationCodeBlockEndpointIds = call('suppressedExactRelationCodeBlockEndpointIds'),
    codeBlockSourceFirstRelationQueries = call('codeBlockSourceFirstRelationQueries'), hardRuleEvidenceTargetEntryPointRelationQueries = call('hardRuleEvidenceTargetEntryPointRelationQueries'), isTestMappingQuery = call('isTestMappingQuery'),
    relationPolicySet = call('relationPolicySet'), normalizeExactRelationQuery = call('normalizeExactRelationQuery'), normalizeExactRelationQueries = call('normalizeExactRelationQueries'),
    interleaveUniqueBuckets = call('interleaveUniqueBuckets'), resolveNativeCodeBlockNode = call('resolveNativeCodeBlockNode'), readNodeCodeBlock = call('readNodeCodeBlock'),
    readEdgeLineCodeBlock = call('readEdgeLineCodeBlock'), pushNativeCodeBlock = call('pushNativeCodeBlock'), isUsableNativeCodeBlock = call('isUsableNativeCodeBlock'),
    nativeCodeBlockSourceRangeKey = call('nativeCodeBlockSourceRangeKey'), queryMentionsTests = call('queryMentionsTests'), isLowValueSourcePath = call('isLowValueSourcePath'),
    unique = call('unique'), uniqueBy = call('uniqueBy'), isTestFile = call('isTestFile');

  function buildNativeCodeBlocks(projectRoot, nodes, entryPoints, rawQuery = '', edges = []) {
    const query = String(rawQuery ?? '').toLowerCase();
    const queryTerms = queryTokens(query);
    const exactRelationQueries = exactMetadataQueriesFromEdges(edges, query);
    const activeExactRelationQueries = exactRelationQueries.length > 0 ? exactRelationQueries : [query];
    const exactLineCodeBlockQueries = edgeLineCodeBlockRelationQueries();
    const provenanceEdgeLineBlocks = buildProvenanceEdgeLineCodeBlocks(projectRoot, nodes, edges, activeExactRelationQueries);
    const includeFileEndpoints = activeExactRelationQueries.some(relationQuery => (
      relationCodeBlockFileEndpointQueries().has(relationQuery)
      || (isTestMappingQuery(relationQuery) && !exactLineCodeBlockQueries.has(relationQuery))
    ));
    const includeEntryPointFileBlocks = includeEntryPointFileCodeBlocksForNativeQuery(
      activeExactRelationQueries,
      exactLineCodeBlockQueries,
    );
    const suppressedCodeBlockNodeIds = suppressedNativeCodeBlockNodeIds(nodes, edges, activeExactRelationQueries);
    const broadCodeBlockSuppressionFilePaths = focusedExplicitPathCodeBlockFilePaths(nodes, queryTerms);
    const entryPointOnly = queryTerms.length === 1
      && entryPoints.some(node => isStrongSingleTermNodeMatch(node, query, queryTerms[0]));
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const leadingExplicitEdgeFunctionSourceNodes = unique(activeExactRelationQueries
      .flatMap(relationQuery => preferredExplicitEdgeFunctionSourceEndpointIds(
        nodesById,
        edges,
        edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery)),
        relationQuery,
        rawQuery,
      )))
        .map(id => nodesById.get(id))
        .filter(Boolean)
        .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
    const exactEndpointNodes = exactRelationEndpointCodeBlockNodes(nodes, edges, activeExactRelationQueries, {
      includeFiles: includeFileEndpoints,
      rawQuery,
    });
    const exactEndpointOriginalIds = new Set(exactEndpointNodes.map(node => node.id));
    const resolvedExactEndpointNodes = exactEndpointNodes.map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
    const exactRelationEdgeBlocks = buildExactRelationEdgeCodeBlocks(projectRoot, nodes, edges, activeExactRelationQueries);
    const exactRelationCodeBlockFilePaths = new Set(exactRelationEdgeBlocks.map(block => block.filePath).filter(Boolean));
    const explicitPathSourceNodes = explicitPathNativeCodeBlockNodes(
      nodes,
      entryPoints,
      queryTerms,
      exactRelationCodeBlockFilePaths,
      rawQuery,
    ).map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
    const context7PrimarySourceNodes = context7RetrievalPrimaryCodeBlockNodes(nodes, entryPoints, edges, queryTerms)
      .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes));
    const priorityNodes = uniqueBy([
      ...resolvedExactEndpointNodes,
      ...context7PrimarySourceNodes,
      ...entryPoints
        .filter(node => (
          (includeEntryPointFileBlocks || node.kind !== 'file')
          && !suppressedCodeBlockNodeIds.has(node.id)
          && !shouldSuppressBroadNativeCodeBlock(node, broadCodeBlockSuppressionFilePaths, queryTerms)
          && !exactEndpointOriginalIds.has(node.id)
        ))
        .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes)),
      ...(includeFileEndpoints
        ? nodes.filter(node => node.kind === 'file' && !suppressedCodeBlockNodeIds.has(node.id))
        : []),
      ...(entryPointOnly ? [] : nodes.filter(node => (
        (node.kind === 'function' || node.kind === 'method')
        && !exactEndpointOriginalIds.has(node.id)
      ))),
      ...(entryPointOnly ? [] : nodes
        .filter(node => (
          (node.kind === 'class' || node.kind === 'component')
          && !shouldSuppressBroadNativeCodeBlock(node, broadCodeBlockSuppressionFilePaths, queryTerms)
          && !exactEndpointOriginalIds.has(node.id)
        ))
        .map(node => resolveNativeCodeBlockNode(projectRoot, node, nodes))),
    ], node => node.id);
    const blocks = [];
    for (const node of leadingExplicitEdgeFunctionSourceNodes) {
      pushNativeCodeBlockWithinNativeBudget(blocks, readNodeCodeBlock(projectRoot, node));
    }
    for (const block of provenanceEdgeLineBlocks) {
      pushNativeCodeBlockWithinNativeBudget(blocks, block);
    }
    for (const node of explicitPathSourceNodes) {
      pushNativeCodeBlockWithinNativeBudget(blocks, readNodeCodeBlock(projectRoot, node));
    }
    for (const block of exactRelationEdgeBlocks) {
      pushNativeCodeBlockWithinNativeBudget(blocks, block);
    }
    if (edgeLineCodeBlocksAreAuthoritative(activeExactRelationQueries) && blocks.length > 0) {
      return blocks;
    }

    for (const node of priorityNodes) {
      if (blocks.length >= NATIVE_CONTEXT_CODE_BLOCK_LIMIT) break;
      const block = readNodeCodeBlock(projectRoot, node);
      pushNativeCodeBlock(blocks, block);
    }

    return blocks;
  }

  function pushNativeCodeBlockWithinNativeBudget(blocks, block, options = {}) {
    if (blocks.length >= NATIVE_CONTEXT_CODE_BLOCK_LIMIT) return;
    pushNativeCodeBlock(blocks, block, options);
  }

  function context7RetrievalPrimaryCodeBlockNodes(nodes, entryPoints, edges, queryTerms) {
    if (!context7RetrievalSourceQueryApplies(queryTerms)) return [];

    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const entryPointIds = new Set(entryPoints.map(node => node.id));
    const selectedRouteIds = selectedContext7RetrievalRouteIds(nodes, queryTerms, entryPointIds);

    if (selectedRouteIds.size === 0) return [];

    return uniqueBy(edges
      .filter(edge => (
        edge.metadata?.relation === 'context7-retrieval-primary'
        && selectedRouteIds.has(edge.source)
      ))
      .map(edge => nodesById.get(edge.target))
      .filter(Boolean), node => node.id);
  }

  function prioritizeContext7RetrievalNodes(nodes, edges, rawQuery) {
    const queryTerms = queryTokens(rawQuery);
    if (!context7RetrievalSourceQueryApplies(queryTerms)) return nodes;
    const selectedRouteIds = selectedContext7RetrievalRouteIds(nodes, queryTerms);
    if (selectedRouteIds.size === 0) return nodes;
    const primaryDocIds = new Set(edges
      .filter(edge => (
        edge.metadata?.relation === 'context7-retrieval-primary'
        && selectedRouteIds.has(edge.source)
      ))
      .map(edge => edge.target));
    if (primaryDocIds.size === 0) return nodes;
    return [
      ...nodes.filter(node => primaryDocIds.has(node.id)),
      ...nodes.filter(node => selectedRouteIds.has(node.id)),
      ...nodes.filter(node => !primaryDocIds.has(node.id) && !selectedRouteIds.has(node.id)),
    ];
  }

  function context7RetrievalSourceQueryApplies(queryTerms) {
    return queryTerms.some(term => (
      term === 'context7'
      || term === 'retrieval'
      || term === 'sync'
      || term === 'offline'
      || term === 'lww'
    ));
  }

  function selectedContext7RetrievalRouteIds(nodes, queryTerms, seedIds = new Set()) {
    return new Set(nodes
      .filter(node => (
        node?.metadata?.relation === 'context7-retrieval-route'
        && (
          seedIds.has(node.id)
          || queryTerms.some(term => nodeSearchText(node).includes(term))
        )
      ))
      .map(node => node.id));
  }

  function exactMetadataQueryFromEdges(edges, query) {
    return exactMetadataQueriesFromEdges(edges, query)[0] ?? null;
  }

  function exactMetadataQueriesFromEdges(edges, query) {
    const normalizedQuery = String(query ?? '').toLowerCase();
    if (edges.some(edge => edgeMatchesExactMetadataQuery(edge, normalizedQuery))) {
      return [normalizedQuery];
    }
    return exactMetadataQueriesFromTerms(edges, queryTokens(normalizedQuery));
  }

  function focusedExplicitPathCodeBlockFilePaths(nodes, queryTerms) {
    if (!queryTerms.some(isExplicitPathTerm)) return new Set();
    return new Set(nodes
      .filter(node => node.kind !== 'file' && hasExactNonPathQueryTermMatch(node, queryTerms))
      .map(node => node.filePath)
      .filter(Boolean));
  }

  function explicitPathNativeCodeBlockNodes(nodes, entryPoints, queryTerms, alreadyCoveredFilePaths = new Set(), rawQuery = '') {
    const explicitPathTerms = queryTerms.filter(isExplicitPathTerm);
    if (explicitPathTerms.length === 0) return [];

    const entryPointIds = new Set(entryPoints.map(node => node.id));
    const bestByFilePath = new Map();
    const candidates = uniqueBy([
      ...entryPoints,
      ...nodes,
    ], node => node.id).filter(node => (
      node?.filePath
      && !alreadyCoveredFilePaths.has(node.filePath)
      && scorePathTermMatch(node.filePath, explicitPathTerms) > 0
    ));

    for (const [index, node] of candidates.entries()) {
      const filePath = node.filePath;
      const candidate = {
        node,
        index,
        pathScore: scorePathTermMatch(filePath, explicitPathTerms),
        entryPoint: entryPointIds.has(node.id),
        fileNode: node.kind === 'file',
        lowInformationPenalty: lowInformationNodePenalty(node, rawQuery),
        highValueRank: highValueRank(node),
        specificity: compareNodeSpecificity(node, { kind: 'file', filePath }),
      };
      const existing = bestByFilePath.get(filePath);
      if (!existing || compareExplicitPathCodeBlockCandidate(candidate, existing) < 0) {
        bestByFilePath.set(filePath, candidate);
      }
    }

    return [...bestByFilePath.values()]
      .sort(compareExplicitPathCodeBlockCandidate)
      .map(candidate => candidate.node);
  }

  function compareExplicitPathCodeBlockCandidate(a, b) {
    return b.pathScore - a.pathScore
      || Number(b.entryPoint) - Number(a.entryPoint)
      || Number(a.fileNode) - Number(b.fileNode)
      || a.lowInformationPenalty - b.lowInformationPenalty
      || b.highValueRank - a.highValueRank
      || b.specificity - a.specificity
      || a.index - b.index;
  }

  function shouldSuppressBroadNativeCodeBlock(node, focusedFilePaths, queryTerms) {
    if (!focusedFilePaths.has(node?.filePath)) return false;
    if (node.kind === 'file') return true;
    return (node.kind === 'class' || node.kind === 'component')
      && !hasExactNonPathQueryTermMatch(node, queryTerms);
  }

  function hasExactNonPathQueryTermMatch(node, queryTerms) {
    const name = String(node?.name ?? '').toLowerCase();
    const qualifiedName = String(node?.qualifiedName ?? '').toLowerCase();
    const qualifiedNameLeaf = readQualifiedNameLeaf(qualifiedName);
    return queryTerms
      .filter(term => !isExplicitPathTerm(term))
      .some(term => term === name || term === qualifiedName || term === qualifiedNameLeaf);
  }

  function suppressedNativeCodeBlockNodeIds(nodes, edges, query) {
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const suppressed = new Set();
    for (const relationQuery of normalizeExactRelationQueries(query)) {
      const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery));
      if (exactEdges.length === 0) continue;
      for (const id of suppressedExactRelationCodeBlockEndpointIds(nodesById, exactEdges, relationQuery)) {
        suppressed.add(id);
      }
    }
    return suppressed;
  }

  function buildExactRelationEdgeCodeBlocks(projectRoot, nodes, edges, query) {
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const buckets = normalizeExactRelationQueries(query).map(relationQuery => {
      if (!edgeLineCodeBlockRelationQueries().has(relationQuery)) return [];
      const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery));
      const blocks = [];
      for (const edge of exactEdges.sort((a, b) => compareExactRelationEdgeCodeBlockOrder(nodesById, a, b, relationQuery))) {
        pushNativeCodeBlock(
          blocks,
          readEdgeLineCodeBlock(projectRoot, edgeLineCodeBlockNode(nodesById, edge, relationQuery), edge),
          { coalesceContainedRanges: true },
        );
      }
      return blocks;
    });
    return interleaveUniqueBuckets(buckets, nativeCodeBlockSourceRangeKey).slice(0, NATIVE_CONTEXT_CODE_BLOCK_LIMIT);
  }

  function compareExactRelationEdgeCodeBlockOrder(nodesById, a, b, query) {
    if (normalizeExactRelationQuery(query) === 'host-listener') {
      const hostPriority = hostListenerCodeBlockPriority(a) - hostListenerCodeBlockPriority(b);
      if (hostPriority !== 0) return hostPriority;
    }
    if (isTestMappingQuery(query) || queryMentionsTests(query)) return 0;
    return compareNativeCodeBlockNodeOrder(
      edgeLineCodeBlockNode(nodesById, a, query),
      edgeLineCodeBlockNode(nodesById, b, query),
      query,
    );
  }

  function hostListenerCodeBlockPriority(edge) {
    return edge?.metadata?.api === 'host' ? 0 : 1;
  }

  function buildProvenanceEdgeLineCodeBlocks(projectRoot, nodes, edges, query) {
    const buckets = normalizeExactRelationQueries(query).map(relationQuery => (
      buildProvenanceEdgeLineCodeBlocksForQuery(projectRoot, nodes, edges, relationQuery)
    ));
    return interleaveUniqueBuckets(buckets, nativeCodeBlockSourceRangeKey).slice(0, NATIVE_CONTEXT_CODE_BLOCK_LIMIT);
  }

  function buildProvenanceEdgeLineCodeBlocksForQuery(projectRoot, nodes, edges, query) {
    const provenanceRelation = provenanceEdgeLineRelationByQuery()[normalizeExactRelationQuery(query)];
    if (!provenanceRelation) return [];
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const exactTargetIds = new Set(edges
      .filter(edge => edgeMatchesExactMetadataQuery(edge, query))
      .map(edge => edge.target));
    if (exactTargetIds.size === 0) return [];
    const provenanceEdges = edges.filter(edge => (
      exactTargetIds.has(edge.target)
      && edge.metadata?.relation === provenanceRelation
    ));
    return uniqueBy(provenanceEdges
      .sort((a, b) => compareProvenanceEdgeLineCodeBlockOrder(nodesById, a, b, query))
      .map(edge => readEdgeLineCodeBlock(projectRoot, nodesById.get(edge.source), edge))
      .filter(isUsableNativeCodeBlock), nativeCodeBlockSourceRangeKey)
      .slice(0, NATIVE_CONTEXT_CODE_BLOCK_LIMIT);
  }

  function compareProvenanceEdgeLineCodeBlockOrder(nodesById, a, b, query) {
    if (isTestMappingQuery(query) || queryMentionsTests(query)) return 0;
    return compareNativeCodeBlockNodeOrder(nodesById.get(a.source), nodesById.get(b.source), query);
  }

  function provenanceEdgeLineRelationByQuery() {
    return {
      'sync-required-field': 'supabase-select-field',
      'sync-required-predicate': 'supabase-incremental-predicate',
    };
  }

  function edgeLineCodeBlockRelationQueries() {
    return relationPolicySet([
      'filename-reference',
      'path-reference',
      'route-reference',
      'invoke-reference',
      'template-binding',
      'template-component',
      'template-directive',
      'template-pipe',
      'standalone-import',
      'provider',
      'dependency',
      'angular-app-provider',
      'host-directive',
      'host-attribute',
      'host-binding',
      'host-listener',
      'edge-function-header',
      'context7-source-map-source',
      'hard-rule-keyword',
      'hard-rule-implementation',
      'hard-rule-test-evidence',
      'migration-constraint-validation',
    ]);
  }

  function edgeLineCodeBlocksAreAuthoritative(query) {
    const authoritativeQueries = relationPolicySet([
      'standalone-import',
      'provider',
      'dependency',
      'angular-app-provider',
      'host-directive',
      'host-attribute',
      'host-binding',
      'host-listener',
      'edge-function-header',
    ]);
    const relationQueries = normalizeExactRelationQueries(query);
    return relationQueries.length > 0 && relationQueries.every(relationQuery => authoritativeQueries.has(relationQuery));
  }

  function relationCodeBlockFileEndpointQueries() {
    return relationPolicySet([
      'android-widget-provider',
      'context7-retrieval-primary',
      'style-url',
      'template-url',
    ]);
  }

  function includeEntryPointFileCodeBlocksForNativeQuery(query, exactLineCodeBlockQueries) {
    return normalizeExactRelationQueries(query).every(relationQuery => {
      if (exactLineCodeBlockQueries.has(relationQuery)) return false;
      if (sourceFirstFileEntrypointSuppressionRelationQueries().has(relationQuery)) return false;
      return true;
    });
  }

  function sourceFirstFileEntrypointSuppressionRelationQueries() {
    return relationPolicySet([
      'edge-function-source',
    ]);
  }

  function sourceOwnerEntryPointRelationQueries() {
    return relationPolicySet([
      'edge-function-route',
      'edge-function-method',
      'edge-function-header',
      'edge-function-invoke',
    ]);
  }

  function edgeLineCodeBlockNode(nodesById, edge, query) {
    if (normalizeExactRelationQuery(query) === 'edge-function-header') {
      return edgeFunctionHeaderCodeBlockNode(nodesById, edge);
    }
    if (
      isTestMappingQuery(query)
      || hardRuleEvidenceTargetEntryPointRelationQueries().has(normalizeExactRelationQuery(query))
    ) {
      return nodesById.get(edge.target);
    }
    return nodesById.get(edge.source);
  }

  function edgeFunctionHeaderCodeBlockNode(nodesById, edge) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode) return targetNode;
    const evidenceFilePath = edge?.metadata?.sourceFile ?? targetNode?.filePath;
    if (!evidenceFilePath || evidenceFilePath === sourceNode.filePath) return sourceNode;
    return {
      ...sourceNode,
      filePath: evidenceFilePath,
      language: targetNode?.language ?? sourceNode.language,
      startLine: targetNode?.startLine ?? edge?.line ?? sourceNode.startLine,
      endLine: targetNode?.endLine ?? targetNode?.startLine ?? edge?.line ?? sourceNode.endLine,
    };
  }

  function exactRelationEndpointCodeBlockNodes(nodes, edges, query, options = {}) {
    const relationQueries = normalizeExactRelationQueries(query);
    const includeAndroidImportEndpoints = relationQueries.includes('android-kotlin-import');
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const suppressedEndpointIds = new Set();
    const preferredEndpointBuckets = [];
    const primaryEndpointBuckets = [];
    const secondaryEndpointBuckets = [];

    for (const relationQuery of relationQueries) {
      const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, relationQuery));
      if (exactEdges.length === 0) continue;
      const sourceFirst = codeBlockSourceFirstRelationQueries().has(normalizeExactRelationQuery(relationQuery));
      const orderedExactEdges = prioritizeExactRelationCodeBlockEdges(
        nodesById,
        exactEdges,
        relationQuery,
        sourceFirst,
        options.rawQuery,
      );
      for (const id of suppressedExactRelationCodeBlockEndpointIds(nodesById, exactEdges, relationQuery)) {
        suppressedEndpointIds.add(id);
      }
      preferredEndpointBuckets.push(preferredExactRelationCodeBlockEndpointIds(nodesById, edges, exactEdges, relationQuery));
      primaryEndpointBuckets.push(orderedExactEdges.map(edge => sourceFirst ? edge.source : edge.target));
      secondaryEndpointBuckets.push(orderedExactEdges.map(edge => sourceFirst ? edge.target : edge.source));
    }

    if (preferredEndpointBuckets.length === 0 && primaryEndpointBuckets.length === 0) return [];

    const orderedEndpointIds = [
      ...interleaveUniqueBuckets(preferredEndpointBuckets, value => value),
      ...interleaveUniqueBuckets(primaryEndpointBuckets, value => value),
      ...interleaveUniqueBuckets(secondaryEndpointBuckets, value => value),
      ...edges.flatMap(edge => [edge.target, edge.source]),
    ];
    return uniqueBy(orderedEndpointIds
      .map(id => nodesById.get(id))
      .filter(node => (
        node
      && (options.includeFiles || node.kind !== 'file')
      && !suppressedEndpointIds.has(node.id)
      && (node.kind !== 'import' || includeAndroidImportEndpoints)
      && node.kind !== 'export'
      && node.kind !== 'parameter'
      )), node => node.id);
  }

  function prioritizeExactRelationCodeBlockEdges(nodesById, exactEdges, query, sourceFirst, rawQuery = '') {
    if (isTestMappingQuery(query) || queryMentionsTests(query)) return exactEdges;
    const context = queryScoringContext(rawQuery || query);
    const relationQuery = normalizeExactRelationQuery(query);
    const shouldUseEndpointRelevance = relationQuery === 'android-kotlin-annotation'
      || relationQuery === 'android-kotlin-constructor'
      || relationQuery === 'android-kotlin-import'
      || relationQuery === 'android-kotlin-property';
    return exactEdges
      .map((edge, index) => ({
        edge,
        index,
        priority: exactRelationCodeBlockEndpointPriority(nodesById, edge, sourceFirst),
        relevance: shouldUseEndpointRelevance
          ? exactRelationCodeBlockEndpointRelevance(nodesById, edge, sourceFirst, context)
          : 0,
      }))
      .sort((a, b) => (
        a.priority - b.priority
        || b.relevance - a.relevance
        || compareExactRelationEdgeSourceOrder(nodesById, a.edge, b.edge, sourceFirst)
        || a.index - b.index
      ))
      .map(entry => entry.edge);
  }

  function exactRelationCodeBlockEndpointRelevance(nodesById, edge, sourceFirst, context) {
    const primary = nodesById.get(sourceFirst ? edge.source : edge.target);
    const secondary = nodesById.get(sourceFirst ? edge.target : edge.source);
    return Math.max(
      nodeCodeBlockEndpointRelevance(primary, context),
      nodeCodeBlockEndpointRelevance(secondary, context),
    );
  }

  function nodeCodeBlockEndpointRelevance(node, context) {
    if (!node) return 0;
    const scores = scoreNodeRelevanceForQuery(node, context);
    return scores.explicitScore * 10 + scores.coreScore + scores.fullScore;
  }

  function compareExactRelationEdgeSourceOrder(nodesById, a, b, sourceFirst) {
    const aPrimary = nodesById.get(sourceFirst ? a.source : a.target);
    const bPrimary = nodesById.get(sourceFirst ? b.source : b.target);
    const aSecondary = nodesById.get(sourceFirst ? a.target : a.source);
    const bSecondary = nodesById.get(sourceFirst ? b.target : b.source);
    return compareNodeSourceOrder(aPrimary, bPrimary)
      || compareNodeSourceOrder(aSecondary, bSecondary);
  }

  function compareNodeSourceOrder(a, b) {
    return String(a?.filePath ?? '').localeCompare(String(b?.filePath ?? ''))
      || normalizedLineNumber(a?.startLine) - normalizedLineNumber(b?.startLine)
      || normalizedLineNumber(a?.endLine) - normalizedLineNumber(b?.endLine)
      || String(a?.kind ?? '').localeCompare(String(b?.kind ?? ''))
      || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  }

  function compareNativeCodeBlockNodeOrder(a, b, rawQuery = '') {
    return nativeCodeBlockNodePriority(a) - nativeCodeBlockNodePriority(b)
      || lowInformationNodePenalty(a, rawQuery) - lowInformationNodePenalty(b, rawQuery)
      || compareNodeSourceOrder(a, b);
  }

  function nativeCodeBlockNodePriority(node) {
    if (!node) return 100;
    if (node.kind === 'method' || node.kind === 'function') return 0;
    if (node.kind === 'class' || node.kind === 'component') return 1;
    if (node.kind === 'interface' || node.kind === 'type_alias') return 2;
    if (node.kind === 'property' || node.kind === 'constant') return 3;
    if (node.kind === 'variable') return 5;
    if (node.kind === 'file') return 6;
    if (node.kind === 'import' || node.kind === 'export' || node.kind === 'parameter') return 8;
    return 4;
  }

  function normalizedLineNumber(value) {
    return Number.isInteger(value) ? value : Number.MAX_SAFE_INTEGER;
  }

  function exactRelationCodeBlockEndpointPriority(nodesById, edge, sourceFirst) {
    const primary = nodesById.get(sourceFirst ? edge.source : edge.target);
    const secondary = nodesById.get(sourceFirst ? edge.target : edge.source);
    return codeBlockEndpointPathPriority(primary) || codeBlockEndpointPathPriority(secondary);
  }

  function codeBlockEndpointPathPriority(node) {
    return isTestFile(node?.filePath) || isLowValueSourcePath(node?.filePath) ? 10 : 0;
  }

  function preferredExactRelationCodeBlockEndpointIds(nodesById, edges, exactEdges, query, rawQuery = query) {
    const explicitEdgeFunctionSourceEndpointIds = preferredExplicitEdgeFunctionSourceEndpointIds(
      nodesById,
      edges,
      exactEdges,
      query,
      rawQuery,
    );
    if (explicitEdgeFunctionSourceEndpointIds.length > 0) {
      return explicitEdgeFunctionSourceEndpointIds;
    }

    if (query === 'android-widget-provider') {
      return unique(exactEdges
        .map(edge => edge.source)
        .filter(id => {
          const node = nodesById.get(id);
          return node?.kind === 'class' || node?.kind === 'component';
        }));
    }

    if (query === 'template-url' || query === 'style-url') {
      return preferredAngularResourceEndpointIds(edges, exactEdges, query);
    }

    if (normalizeExactRelationQuery(query) === 'context7-source-map-source') {
      return unique(exactEdges
        .map(edge => nodesById.get(edge.source))
        .filter(node => node?.metadata?.relation === 'context7-source-map-route')
        .map(node => node.id));
    }

    if (hardRuleEvidenceTargetEntryPointRelationQueries().has(normalizeExactRelationQuery(query))) {
      return hardRuleEvidenceTargetExactRelationEntryPointIds(nodesById, exactEdges, query);
    }

    if (query === 'sync-config-source') {
      const exactSourceIds = new Set(exactEdges.map(edge => edge.source));
      return unique(edges
        .filter(edge => (
          exactSourceIds.has(edge.source)
          && edge.metadata?.relation === 'config-source'
          && edge.kind === 'references'
        ))
        .map(edge => nodesById.get(edge.target))
        .filter(node => node?.kind === 'property')
        .map(node => node.id));
    }

    const provenanceRelationByQuery = {
      'sync-required-field': 'supabase-select-field',
      'sync-required-predicate': 'supabase-incremental-predicate',
    };
    const provenanceRelation = provenanceRelationByQuery[query];
    if (!provenanceRelation) return [];
    const exactTargetIds = new Set(exactEdges.map(edge => edge.target));
    return unique(edges
      .filter(edge => (
        exactTargetIds.has(edge.target)
        && edge.metadata?.relation === provenanceRelation
      ))
      .map(edge => nodesById.get(edge.source))
      .filter(node => node?.kind === 'method' || node?.kind === 'function')
      .map(node => node.id));
  }

  function preferredExplicitEdgeFunctionSourceEndpointIds(nodesById, edges, exactEdges, query, rawQuery = query) {
    const relationQuery = normalizeExactRelationQuery(query);
    const context = queryScoringContext(rawQuery);
    if (isTestMappingQuery(relationQuery)) {
      return unique(exactEdges
        .map((edge, index) => {
          const sourceNode = nodesById.get(edge.source);
          return {
            id: edge.source,
            index,
            sourceNode,
            relevance: nodeCodeBlockEndpointRelevance(sourceNode, context),
          };
        })
        .filter(entry => (
          isSupabaseEdgeFunctionSourceNode(entry.sourceNode)
          && edgeFunctionSourceExplicitlyRequested(entry.sourceNode, null, context.queryTerms)
        ))
        .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
        .map(entry => entry.id));
    }

    if (relationQuery !== 'edge-function-invoke') return [];
    const invokedRouteIds = new Set(exactEdges.map(edge => edge.target));
    return unique(edges
      .filter(edge => (
        invokedRouteIds.has(edge.target)
        && edge.metadata?.relation === 'edge-function-route'
        && edge.kind === 'references'
      ))
      .map((edge, index) => {
        const sourceNode = nodesById.get(edge.source);
        const routeNode = nodesById.get(edge.target);
        return {
          id: edge.source,
          index,
          sourceNode,
          routeNode,
          relevance: nodeCodeBlockEndpointRelevance(sourceNode, context),
        };
      })
      .filter(entry => (
        (entry.sourceNode?.kind === 'method' || entry.sourceNode?.kind === 'function')
        && edgeFunctionSourceExplicitlyRequested(entry.sourceNode, entry.routeNode, context.queryTerms)
      ))
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
      .map(entry => entry.id));
  }


  buildNativeCodeBlocksDelegate = buildNativeCodeBlocks;
  Object.assign(runtime, {
    buildNativeCodeBlocks, pushNativeCodeBlockWithinNativeBudget, context7RetrievalPrimaryCodeBlockNodes, prioritizeContext7RetrievalNodes, context7RetrievalSourceQueryApplies,
    selectedContext7RetrievalRouteIds, exactMetadataQueryFromEdges, exactMetadataQueriesFromEdges, focusedExplicitPathCodeBlockFilePaths, explicitPathNativeCodeBlockNodes,
    compareExplicitPathCodeBlockCandidate, shouldSuppressBroadNativeCodeBlock, hasExactNonPathQueryTermMatch, suppressedNativeCodeBlockNodeIds, buildExactRelationEdgeCodeBlocks,
    compareExactRelationEdgeCodeBlockOrder, hostListenerCodeBlockPriority, buildProvenanceEdgeLineCodeBlocks, buildProvenanceEdgeLineCodeBlocksForQuery, compareProvenanceEdgeLineCodeBlockOrder,
    provenanceEdgeLineRelationByQuery, edgeLineCodeBlockRelationQueries, edgeLineCodeBlocksAreAuthoritative, relationCodeBlockFileEndpointQueries, includeEntryPointFileCodeBlocksForNativeQuery,
    sourceFirstFileEntrypointSuppressionRelationQueries, sourceOwnerEntryPointRelationQueries, edgeLineCodeBlockNode, edgeFunctionHeaderCodeBlockNode, exactRelationEndpointCodeBlockNodes,
    prioritizeExactRelationCodeBlockEdges, exactRelationCodeBlockEndpointRelevance, nodeCodeBlockEndpointRelevance, compareExactRelationEdgeSourceOrder, compareNodeSourceOrder,
    compareNativeCodeBlockNodeOrder, nativeCodeBlockNodePriority, normalizedLineNumber, exactRelationCodeBlockEndpointPriority, codeBlockEndpointPathPriority,
    preferredExactRelationCodeBlockEndpointIds, preferredExplicitEdgeFunctionSourceEndpointIds,
  });
}
