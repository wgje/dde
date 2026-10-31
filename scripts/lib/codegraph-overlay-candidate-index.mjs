let queryOverlayDelegate;
let scoreCandidateDelegate;
let installed = false;
function installedDelegate(value, delegateName, installerName) {
  if (!value) throw new Error(`${delegateName} requires ${installerName}() before use`);
  return value;
}
export function queryOverlayImpl(...values) { return installedDelegate(queryOverlayDelegate, 'queryOverlayImpl', 'installCandidateIndex')(...values); }
export function scoreCandidateImpl(...values) { return installedDelegate(scoreCandidateDelegate, 'scoreCandidateImpl', 'installCandidateIndex')(...values); }

export function installCandidateIndex(runtime) {
  if (installed) throw new Error('installCandidateIndex() may only be called once');
  installed = true;
  const call = name => (...values) => runtime[name](...values);
  const
    queryTokens = call('queryTokens'), explicitQueryTerms = call('explicitQueryTerms'), focusedExplicitQueryTerms = call('focusedExplicitQueryTerms'),
    scoreExplicitQueryTermText = call('scoreExplicitQueryTermText'), scorePathTermMatch = call('scorePathTermMatch'), isExplicitPathTerm = call('isExplicitPathTerm'),
    normalizeSearchPath = call('normalizeSearchPath'), isMarkdownSymbolNode = call('isMarkdownSymbolNode'), displaySymbolKey = call('displaySymbolKey'),
    compareNodeSpecificity = call('compareNodeSpecificity'), compareNode = call('compareNode'), compareEdge = call('compareEdge'),
    nodeKindPriority = call('nodeKindPriority'), isHighValueEntryPoint = call('isHighValueEntryPoint'),
    highValueRank = call('highValueRank'), context7RetrievalSourceQueryApplies = call('context7RetrievalSourceQueryApplies'),
    scoreNodeRelevanceForQuery = call('scoreNodeRelevanceForQuery'),
    relationPolicySet = call('relationPolicySet'), normalizeExactRelationQuery = call('normalizeExactRelationQuery'),
    unique = call('unique');

  function queryOverlay(overlay, rawQuery, limit) {
    const query = rawQuery.toLowerCase();
    const queryTerms = queryTokens(query);
    const explicitTerms = explicitQueryTerms(rawQuery);
    const focusedTerms = focusedExplicitQueryTerms(rawQuery, explicitTerms);
    const hasExplicitPathTerm = queryTerms.some(isExplicitPathTerm);
    const candidates = buildNanoFlowOverlayCandidates(overlay);
    const scoredByDisplayKey = new Map();

    for (const candidate of candidates) {
      const pathScore = scorePathTermMatch(candidate.file, queryTerms);
      const focusedScore = scoreFocusedCandidateMatch(candidate, focusedTerms);
      const explicitScore = scoreExplicitCandidateMatch(candidate, focusedTerms, explicitTerms);
      const scored = {
        ...candidate,
        score: runtime.scoreCandidate(candidate, query, queryTerms, explicitScore, pathScore),
        explicitRank: hasExplicitPathTerm && pathScore > 0 ? 3 : focusedScore > 0 ? 2 : explicitScore > 0 ? 1 : 0,
        highValueRank: candidateHighValueRank(candidate),
      };
      if (scored.score <= 0) continue;
      const key = `${String(scored.name ?? '')}\0${String(scored.file ?? '')}`;
      const previous = scoredByDisplayKey.get(key);
      if (!previous || compareCandidateRank(scored, previous) < 0) {
        scoredByDisplayKey.set(key, scored);
      }
    }

    const rankedCandidates = [...scoredByDisplayKey.values()].sort(compareCandidateRank);
    return seedContext7RetrievalRouteCandidate(rankedCandidates, queryTerms)
      .slice(0, limit)
      .map(({ highValueRank: _highValueRank, explicitRank: _explicitRank, ...candidate }) => candidate);
  }

  function seedContext7RetrievalRouteCandidate(candidates, queryTerms) {
    if (queryTerms.length <= 1
      || !context7RetrievalSourceQueryApplies(queryTerms)
      || queryTerms.some(isExplicitPathTerm)) {
      return candidates;
    }
    const route = candidates.find(candidate => (
      candidate.item?.metadata?.relation === 'context7-retrieval-route'
      && queryTerms.some(term => candidateSearchText(candidate).includes(term))
    ));
    if (!route || candidates[0] === route) return candidates;
    return [route, ...candidates.filter(candidate => candidate !== route)];
  }

  function buildNanoFlowOverlayCandidates(overlay) {
    const componentFiles = new Set(overlay.angular.components.map(item => item.file));
    return [
      ...(overlay.graph?.nodes ?? [])
        .filter(isMarkdownSymbolNode)
        .map(node => ({
          kind: graphNodeCandidateKind(node),
          name: node.name,
          file: node.filePath,
          item: node,
        })),
      ...(overlay.typescript?.exports ?? []).map(item => ({
        kind: 'export',
        name: item.exportName ?? item.name,
        file: item.file,
        item,
      })),
      ...(overlay.typescript?.imports ?? []).map(item => ({
        kind: 'import',
        name: item.name ?? item.importedName,
        file: item.file,
        item,
      })),
      ...overlay.angular.components.map(item => ({ kind: 'angular-component', name: item.className, file: item.file, item })),
      ...overlay.angular.injectors
        .filter(item => !componentFiles.has(item.file))
        .map(item => ({ kind: 'angular-injector', name: item.file, file: item.file, item })),
      ...overlay.angular.dynamicImports.map(item => ({ kind: 'angular-dynamic-import', name: item.target, file: item.file, item })),
      ...(overlay.angular.routes ?? []).map(item => ({ kind: 'angular-route', name: item.path ?? item.component ?? item.loadComponent ?? item.loadChildren, file: item.file, item })),
      ...overlay.supabase.edgeFunctions.map(item => ({ kind: 'supabase-edge-function', name: item.name, file: item.entry, item })),
      ...overlay.supabase.migrations.map(item => ({ kind: 'supabase-migration', name: item.name, file: item.file, item })),
      ...overlay.agentRules.hardRules.map(item => ({ kind: 'agent-hard-rule', name: item.heading, file: item.file, item })),
      ...(overlay.agentRules.syncRules ?? []).map(item => ({ kind: 'agent-sync-rule', name: item.name, file: item.file, item })),
    ];
  }

  function compareCandidateRank(a, b) {
    return b.explicitRank - a.explicitRank
      || b.highValueRank - a.highValueRank
      || b.score - a.score
      || candidateKindPriority(a.kind) - candidateKindPriority(b.kind)
      || String(a.file ?? '').localeCompare(String(b.file ?? ''))
      || String(a.kind ?? '').localeCompare(String(b.kind ?? ''));
  }

  function scoreCandidate(candidate, query, queryTerms = queryTokens(query), explicitScore = 0, pathScore = undefined) {
    return scoreNanoFlowSemanticCandidate(candidate, query, queryTerms, explicitScore, pathScore);
  }

  function scoreNanoFlowSemanticCandidate(candidate, query, queryTerms = queryTokens(query), explicitScore = 0, pathScore = undefined) {
    const haystack = candidateSearchText(candidate);
    const matchedTerms = queryTerms.filter(term => haystack.includes(term));
    const resolvedPathScore = pathScore ?? scorePathTermMatch(candidate.file, queryTerms);
    if (!haystack.includes(query) && matchedTerms.length === 0 && resolvedPathScore <= 0 && explicitScore <= 0) return 0;

    let score = 1;
    const name = String(candidate.name ?? '').toLowerCase();
    if (haystack.includes(query)) score += 3;
    score += matchedTerms.length;
    score += resolvedPathScore;
    if (name === query) score += 8;
    if (name.includes(query)) score += 5;
    for (const term of matchedTerms) {
      if (name === term) score += 6;
      if (name.includes(term)) score += 3;
    }
    score += explicitScore;
    if (String(candidate.file ?? '').toLowerCase().includes(query)) score += 3;
    if (String(candidate.kind ?? '').toLowerCase().includes(query)) score += 2;
    return score;
  }

  function scoreExplicitCandidateMatch(candidate, focusedTerms, explicitTerms) {
    return scoreExplicitQueryTermText(
      joinSearchText([candidate.name, candidate.file, candidate.kind]),
      focusedTerms,
      explicitTerms,
      5000,
      400,
    );
  }

  function scoreFocusedCandidateMatch(candidate, focusedTerms) {
    return scoreExplicitQueryTermText(
      joinSearchText([candidate.name, candidate.file, candidate.kind]),
      focusedTerms,
      [],
      5000,
      400,
    );
  }

  function candidateSearchText(candidate) {
    return joinSearchText([
      candidate.kind,
      candidate.name,
      candidate.file,
      candidate.item?.name,
      candidate.item?.qualifiedName,
      candidate.item?.className,
      candidate.item?.selector,
      candidate.item?.path,
      candidate.item?.component,
      candidate.item?.loadComponent,
      candidate.item?.loadChildren,
      candidate.item?.exportName,
      candidate.item?.entry,
      candidate.item?.target,
      candidate.item?.heading,
      candidate.item?.ownerHeading,
      candidate.item?.body,
      candidate.item?.keywords,
      candidate.item?.signature,
      candidate.item?.decorators,
      candidate.item?.docstring,
      candidate.item?.returnType,
      candidate.item?.metadata,
      candidate.item?.dependencies,
      candidate.item?.imports,
      candidate.item?.providers,
      candidate.item?.tests,
      candidate.item?.riskTags,
    ]);
  }


  function buildGraphIndexes(graph) {
    const nodesById = new Map();
    const nodesByName = new Map();
    const exportEdgesByName = new Map();
    const equivalentIdsByDisplayKey = new Map();
    const edgesByNodeId = new Map();

    for (const node of graph.nodes) {
      nodesById.set(node.id, node);
      appendMapValue(nodesByName, node.name, node);
      appendMapValue(equivalentIdsByDisplayKey, displaySymbolKey(node), node.id);
    }

    for (const group of nodesByName.values()) {
      group.sort(compareNodeSpecificity);
    }

    for (const edge of graph.edges) {
      appendMapValue(edgesByNodeId, edge.source, edge);
      appendMapValue(edgesByNodeId, edge.target, edge);
      if (edge.kind === 'exports' && edge.metadata?.exportName) {
        appendMapValue(exportEdgesByName, edge.metadata.exportName, edge);
      }
    }

    return { nodesById, nodesByName, exportEdgesByName, equivalentIdsByDisplayKey, edgesByNodeId };
  }

  function collectIncidentEdges(nodeIds, edgesByNodeId) {
    const seen = new Set();
    const edges = [];
    for (const id of nodeIds) {
      for (const edge of edgesByNodeId.get(id) ?? []) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        edges.push(edge);
      }
    }
    return edges;
  }

  function explicitPathScopeFilePaths(nodes, queryTerms) {
    const explicitTerms = queryTerms.filter(isExplicitPathTerm);
    if (explicitTerms.length === 0) return new Set();
    const scopedPaths = new Set();
    for (const node of nodes) {
      if (!node?.filePath) continue;
      if (explicitTerms.some(term => explicitPathTermMatchesFilePath(term, node.filePath))) {
        scopedPaths.add(node.filePath);
      }
    }
    return scopedPaths;
  }

  function explicitPathTermMatchesFilePath(term, filePath) {
    const normalizedTerm = normalizeSearchPath(term);
    const normalizedPath = normalizeSearchPath(filePath);
    if (!normalizedTerm || !normalizedPath) return false;
    const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;
    return normalizedPath === normalizedTerm
      || fileName === normalizedTerm
      || normalizedPath.endsWith(`/${normalizedTerm}`)
      || normalizedTerm.endsWith(`/${normalizedPath}`);
  }

  function isInExplicitPathScope(filePath, explicitPathScope) {
    return explicitPathScope.size === 0 || explicitPathScope.has(filePath);
  }

  function appendMapValue(map, key, value) {
    if (key === undefined || key === null) return;
    const values = map.get(key) ?? [];
    values.push(value);
    map.set(key, values);
  }

  function dedupeScoredEntryByDisplay() {
    const seen = new Set();
    return entry => {
      const key = displaySymbolKey(entry.node);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
  }

  function dedupeNodeByDisplay() {
    const seen = new Set();
    return node => {
      const key = displaySymbolKey(node);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
  }


  function selectNodeForCandidateMatch(match, matchingNodes) {
    if (match?.kind === 'agent-sync-rule') {
      return matchingNodes.find(node => node.metadata?.relation === 'sync-rule') ?? matchingNodes[0];
    }
    if (match?.kind === 'agent-hard-rule') {
      return matchingNodes.find(node => node.metadata?.relation === 'hard-rule') ?? matchingNodes[0];
    }
    return matchingNodes[0];
  }

  function candidateKindPriority(kind) {
    if (kind === 'angular-component' || kind === 'component') return 0;
    if (kind === 'angular-route' || kind === 'route') return 1;
    if (kind === 'angular-injector') return 2;
    if (kind === 'agent-sync-rule') return 3;
    if (kind === 'agent-hard-rule') return 3;
    if (kind === 'export') return 9;
    return nodeKindPriority(kind);
  }

  function graphNodeCandidateKind(node) {
    if (node?.metadata?.relation === 'sync-rule') return 'agent-sync-rule';
    if (node?.metadata?.relation === 'hard-rule') return 'agent-hard-rule';
    if (node?.metadata?.relation === 'hard-rule-keyword') return 'agent-hard-rule-keyword';
    return node.kind;
  }

  function candidateHighValueRank(candidate) {
    if (candidate.kind === 'angular-component' || candidate.kind === 'angular-route' || candidate.kind === 'angular-injector') {
      return 1;
    }
    if (candidate.kind === 'supabase-migration') {
      return 1;
    }
    if (candidate.kind === 'agent-sync-rule' || candidate.kind === 'agent-hard-rule') {
      return 1;
    }
    return isHighValueEntryPoint(candidate.item) ? 1 : 0;
  }

  function scoreGraphNode(
    node,
    query,
    queryTerms = queryTokens(query),
    searchText = undefined,
    focusedTerms = focusedExplicitQueryTerms(query),
    explicitTerms = explicitQueryTerms(query),
  ) {
    if (!node) return 0;
    const haystack = searchText ?? nodeSearchText(node);
    const matchedTerms = queryTerms.filter(term => haystack.includes(term));
    const pathScore = scorePathTermMatch(node.filePath, queryTerms);
    const explicitScore = scoreExplicitQueryTermText(
      joinSearchText([node.name, node.qualifiedName, node.filePath, node.kind]),
      focusedTerms,
      explicitTerms,
      5000,
      400,
    );
    if (!haystack.includes(query) && matchedTerms.length === 0 && pathScore <= 0 && explicitScore <= 0) return 0;

    let score = 1;
    const name = String(node.name ?? '').toLowerCase();
    if (haystack.includes(query)) score += 4;
    score += matchedTerms.length;
    score += pathScore;
    if (name === query) score += 20;
    if (name.includes(query)) score += 10;
    for (const term of matchedTerms) {
      if (name === term) score += 12;
      if (name.includes(term)) score += 5;
    }
    score += explicitScore;
    if (String(node.filePath ?? '').toLowerCase().includes(query)) score += 5;
    if (String(node.kind ?? '').toLowerCase().includes(query)) score += 2;
    return score;
  }

  function nodeSearchText(node) {
    return joinSearchText([
      node.kind,
      node.name,
      node.qualifiedName,
      node.filePath,
      node.language,
      node.signature,
      node.decorators,
      node.docstring,
      node.returnType,
      node.metadata,
    ]);
  }

  function nodeCoreSearchText(node) {
    return joinSearchText([
      node?.kind,
      node?.name,
      node?.qualifiedName,
      node?.filePath,
      node?.language,
    ]);
  }

  function edgeSearchText(edge) {
    return joinSearchText([
      edge.kind,
      edge.source,
      edge.target,
      edge.sourceName,
      edge.targetName,
      edge.provenance,
      edge.metadata?.bindingKind,
      edge.metadata,
    ]);
  }

  function joinSearchText(values) {
    return values
      .flatMap(value => searchableTextParts(value))
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function searchableTextParts(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) {
      return value.flatMap(item => searchableTextParts(item));
    }
    if (typeof value === 'object') {
      return Object.values(value).flatMap(item => searchableTextParts(item));
    }
    return [String(value)];
  }

  function edgeMatchesExactMetadataQuery(edge, query) {
    if (!edge?.metadata) return false;
    return ['relation', 'synthesizedBy', 'bindingKind', 'testMapping', 'keywordMapping'].some(key => (
      String(edge.metadata[key] ?? '').toLowerCase() === query
    ));
  }

  function exactMetadataQueryFromTerms(edges, queryTerms) {
    return exactMetadataQueriesFromTerms(edges, queryTerms)[0] ?? null;
  }

  function exactMetadataQueriesFromTerms(edges, queryTerms) {
    return unique(queryTerms
      .flatMap(term => [term, ...String(term ?? '').split('/')])
      .map(term => String(term ?? '').trim().toLowerCase())
      .filter(Boolean)
      .filter(isMixedExactMetadataQueryTerm))
      .filter(term => edges.some(edge => edgeMatchesExactMetadataQuery(edge, term)));
  }

  function isCombinedExactRelationQueryTerm(term, exactRelationQueries) {
    const parts = String(term ?? '')
      .split('/')
      .map(part => part.trim().toLowerCase())
      .filter(Boolean);
    return parts.length > 1 && parts.every(part => exactRelationQueries.includes(part));
  }

  function isMixedExactMetadataQueryTerm(term) {
    const normalized = String(term ?? '').toLowerCase();
    return normalized.includes('-') || relationPolicySet([
      'dependency',
      'provider',
    ]).has(normalized);
  }

  function edgeMatchesQueryTermsWithEndpoints(edge, nodesById, queryTerms) {
    if (queryTerms.length === 0) return true;
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    const haystack = joinSearchText([
      edgeSearchText(edge),
      sourceNode ? nodeSearchText(sourceNode) : '',
      targetNode ? nodeSearchText(targetNode) : '',
    ]);
    return queryTerms.every(term => haystack.includes(term));
  }

  function edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, queryTerms) {
    if (queryTerms.length === 0) return true;
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    const haystack = joinSearchText([
      edgeSearchText(edge),
      sourceNode ? nodeSearchText(sourceNode) : '',
      targetNode ? nodeSearchText(targetNode) : '',
    ]);
    return queryTerms.some(term => haystack.includes(term));
  }

  function specificEndpointConstraintTerms(queryTerms) {
    const genericTerms = new Set([
      'block',
      'blocks',
      'code',
      'context',
      'edge',
      'entries',
      'entry',
      'function',
      'functions',
      'implementation',
      'implementations',
      'invoke',
      'invokes',
      'order',
      'ordering',
      'point',
      'points',
      'quality',
      'reference',
      'references',
      'route',
      'routes',
      'source',
      'sources',
      'supabase',
      'test',
      'tests',
      'mapping',
      'mappings',
    ]);
    return queryTerms.filter(term => !genericTerms.has(String(term ?? '').toLowerCase()));
  }

  function usesAnyEndpointTermConstraint(query) {
    return anyEndpointTermRelationQueries().has(normalizeExactRelationQuery(query));
  }

  function anyEndpointTermRelationQueries() {
    return relationPolicySet([
      'android-kotlin-annotation',
      'android-kotlin-constructor',
      'android-kotlin-import',
      'android-kotlin-method',
      'android-kotlin-property',
      'android-kotlin-type-reference',
      'edge-function-header',
      'edge-function-invoke',
      'edge-function-method',
      'supabase-realtime-channel',
      'supabase-realtime-postgres-change',
      'supabase-realtime-status',
      'supabase-realtime-unsubscribe',
      'supabase-realtime-remove-channel',
      'supabase-realtime-remove-all-channels',
    ]);
  }

  function compareGraphSelectionRelevance(a, b) {
    return b.explicitScore - a.explicitScore
      || b.pathScore - a.pathScore
      || b.coreScore - a.coreScore
      || highValueRank(b.node) - highValueRank(a.node)
      || a.lowInformationPenalty - b.lowInformationPenalty
      || b.fullScore - a.fullScore
      || compareNodeSpecificity(a.node, b.node)
      || compareNode(a.node, b.node);
  }

  function seedExplicitPathScopedGraphNodeIds(
    nodes,
    explicitPathScope,
    query,
    queryTerms,
    getNodeSearchText,
    focusedTerms,
    explicitTerms,
  ) {
    if (explicitPathScope.size === 0) return [];
    const ids = [];
    for (const node of nodes) {
      if (!isInExplicitPathScope(node.filePath, explicitPathScope)) continue;
      const score = scoreGraphNode(
        node,
        query,
        queryTerms,
        getNodeSearchText(node),
        focusedTerms,
        explicitTerms,
      );
      if (score > 0) ids.push(node.id);
    }
    return ids;
  }

  function generalQueryEdgePriority(edge) {
    return {
      exports: 0,
      returns: 1,
      instantiates: 2,
      contains: 3,
      type_of: 4,
      imports: 5,
      extends: 6,
      implements: 7,
      calls: 8,
      references: 9,
      decorates: 10,
      overrides: 11,
    }[edge.kind] ?? 12;
  }

  function orderGeneralQueryEdges(edges, context) {
    const { nodesById, queryTerms, scoringContext, primaryIds, selectedIds } = context;
    const nodeRelevance = new Map();
    const relevanceForNodeId = id => {
      if (nodeRelevance.has(id)) return nodeRelevance.get(id);
      const node = nodesById.get(id);
      const relevance = {
        pathScore: scorePathTermMatch(node?.filePath, queryTerms),
        ...scoreNodeRelevanceForQuery(node, scoringContext),
      };
      nodeRelevance.set(id, relevance);
      return relevance;
    };
    const relevanceForEdge = edge => {
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      const source = relevanceForNodeId(edge.source);
      const target = relevanceForNodeId(edge.target);
      const metadataText = joinSearchText([edge.metadata]);
      const primaryEndpoints = new Set([edge.source, edge.target].filter(id => primaryIds.has(id)));
      const selectedEndpoints = new Set([edge.source, edge.target].filter(id => selectedIds.has(id)));
      const semanticPriority = {
        'template-binding': 3,
        'template-url': 2,
        dependency: 1,
      }[edge.metadata?.relation] ?? 0;
      return {
        primaryScore: primaryEndpoints.size,
        selectedScore: selectedEndpoints.size,
        selfEdgePenalty: Number(edge.source === edge.target),
        crossFileScore: Number(
          sourceNode?.filePath
          && targetNode?.filePath
          && sourceNode.filePath !== targetNode.filePath
        ),
        crossFileDependencyScore: edge.kind === 'instantiates'
          ? Number(sourceNode?.filePath && targetNode?.filePath && sourceNode.filePath !== targetNode.filePath)
          : 0,
        semanticPriority,
        sourceExplicitScore: source.explicitScore,
        explicitScore: source.explicitScore + target.explicitScore,
        pathScore: source.pathScore + target.pathScore,
        coreScore: source.coreScore + target.coreScore,
        metadataScore: queryTerms.reduce((score, term) => (
          metadataText.includes(term) ? score + 100 + term.length : score
        ), 0),
        fullScore: source.fullScore + target.fullScore,
      };
    };
    const compareEdgeRelevance = (a, b) => {
      const left = relevanceForEdge(a);
      const right = relevanceForEdge(b);
      return right.crossFileDependencyScore - left.crossFileDependencyScore
        || right.primaryScore - left.primaryScore
        || right.selectedScore - left.selectedScore
        || left.selfEdgePenalty - right.selfEdgePenalty
        || right.semanticPriority - left.semanticPriority
        || right.metadataScore - left.metadataScore
        || right.sourceExplicitScore - left.sourceExplicitScore
        || right.explicitScore - left.explicitScore
        || right.crossFileScore - left.crossFileScore
        || right.pathScore - left.pathScore
        || right.coreScore - left.coreScore
        || right.fullScore - left.fullScore
        || compareEdge(a, b);
    };
    const groups = new Map();
    for (const edge of [...edges].sort(compareEdgeRelevance)) {
      const group = groups.get(edge.kind) ?? [];
      group.push(edge);
      groups.set(edge.kind, group);
    }
    const kinds = [...groups.keys()].sort((a, b) => (
      generalQueryEdgePriority({ kind: a }) - generalQueryEdgePriority({ kind: b })
      || String(a).localeCompare(String(b))
    ));
    const selected = new Set();
    const ordered = [];
    const groupHeads = kinds
      .map(kind => groups.get(kind)?.[0])
      .filter(Boolean)
      .sort(compareEdgeRelevance);
    for (const edge of groupHeads) {
      if (!edge) continue;
      selected.add(edge);
      ordered.push(edge);
    }
    for (const edge of [...edges].sort(compareEdgeRelevance)) {
      if (selected.has(edge)) continue;
      selected.add(edge);
      ordered.push(edge);
    }
    return ordered;
  }

  function toNativeEdge(edge) {
    return omitUndefined({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata,
      line: edge.line,
      column: edge.column,
      provenance: edge.provenance,
    });
  }

  function omitUndefined(record) {
    return Object.fromEntries(
      Object.entries(record).filter(([, value]) => value !== undefined),
    );
  }


  queryOverlayDelegate = queryOverlay;
  scoreCandidateDelegate = scoreCandidate;
  Object.assign(runtime, {
    queryOverlay, seedContext7RetrievalRouteCandidate, buildNanoFlowOverlayCandidates, compareCandidateRank, scoreCandidate,
    scoreNanoFlowSemanticCandidate, scoreExplicitCandidateMatch, scoreFocusedCandidateMatch, candidateSearchText, buildGraphIndexes,
    collectIncidentEdges, explicitPathScopeFilePaths, explicitPathTermMatchesFilePath, isInExplicitPathScope, appendMapValue,
    dedupeScoredEntryByDisplay, dedupeNodeByDisplay, selectNodeForCandidateMatch, candidateKindPriority, graphNodeCandidateKind,
    candidateHighValueRank, scoreGraphNode, nodeSearchText, nodeCoreSearchText, edgeSearchText,
    joinSearchText, searchableTextParts, edgeMatchesExactMetadataQuery, exactMetadataQueryFromTerms, exactMetadataQueriesFromTerms,
    isCombinedExactRelationQueryTerm, isMixedExactMetadataQueryTerm, edgeMatchesQueryTermsWithEndpoints, edgeMatchesAnyQueryTermWithEndpoints, specificEndpointConstraintTerms,
    usesAnyEndpointTermConstraint, anyEndpointTermRelationQueries, compareGraphSelectionRelevance,
    seedExplicitPathScopedGraphNodeIds, orderGeneralQueryEdges, toNativeEdge, omitUndefined,
  });
}
