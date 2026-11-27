let queryTokensDelegate;
let installed = false;
function installedDelegate(value, delegateName, installerName) {
  if (!value) throw new Error(`${delegateName} requires ${installerName}() before use`);
  return value;
}
export function queryTokensImpl(...values) { return installedDelegate(queryTokensDelegate, 'queryTokensImpl', 'installQueryTerms')(...values); }

export function installQueryTerms(runtime) {
  if (installed) throw new Error('installQueryTerms() may only be called once');
  installed = true;
  const {
    path
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    readQualifiedNameLeaf = call('readQualifiedNameLeaf'), scoreGraphNode = call('scoreGraphNode'), nodeSearchText = call('nodeSearchText'),
    nodeCoreSearchText = call('nodeCoreSearchText'), joinSearchText = call('joinSearchText'), edgeMatchesAnyQueryTermWithEndpoints = call('edgeMatchesAnyQueryTermWithEndpoints'),
    isMarkdownSymbolNode = call('isMarkdownSymbolNode'), displaySymbolKey = call('displaySymbolKey'), compareEdge = call('compareEdge'),
    isExternalReferencePlaceholder = call('isExternalReferencePlaceholder'), queryMentionsTests = call('queryMentionsTests'), isGeneratedFilePath = call('isGeneratedFilePath'),
    unique = call('unique'), uniqueBy = call('uniqueBy'), isTestFile = call('isTestFile');

  function queryTokens(query) {
    return unique(query
      .split(/[^a-z0-9_$:.@/\\-]+/i)
      .map(term => term.trim().toLowerCase())
      .filter(term => term.length >= 2));
  }

  function explicitQueryTerms(rawQuery = '') {
    return unique(String(rawQuery ?? '')
      .split(/[^a-z0-9_$:.@/\\-]+/i)
      .map(term => term.trim())
      .filter(term => term.length >= 2)
      .filter(term => isExplicitPathTerm(term) || isLikelyExplicitSymbolTerm(term))
      .map(term => term.toLowerCase()));
  }

  function focusedExplicitQueryTerms(rawQuery = '', explicitTerms = explicitQueryTerms(rawQuery)) {
    const query = String(rawQuery ?? '').toLowerCase();
    return explicitTerms.filter(term => {
      const index = query.indexOf(term);
      if (index < 0) return false;
      const prefix = query.slice(Math.max(0, index - 24), index);
      return /(直接看|查看|看|定位|打开|源码|定义|inspect|show|source)\s*$/.test(prefix);
    });
  }

  function isLikelyExplicitSymbolTerm(term) {
    const value = String(term ?? '');
    if (value.length < 6) return false;
    if (value.includes('::')) return true;
    return /[a-z0-9][A-Z]/.test(value) || /[A-Z]{2,}[a-z]/.test(value);
  }

  function scoreExplicitQueryTermText(text, focusedTerms = [], explicitTerms = [], focusedScore = 5000, explicitScore = 400) {
    const normalizedText = String(text ?? '').toLowerCase();
    if (!normalizedText) return 0;

    let score = 0;
    const focusedSet = new Set(focusedTerms);
    for (const term of focusedTerms) {
      if (normalizedText.includes(term)) {
        score += focusedScore + term.length;
      }
    }
    for (const term of explicitTerms) {
      if (focusedSet.has(term)) continue;
      if (normalizedText.includes(term)) {
        score += explicitScore + term.length;
      }
    }
    return score;
  }

  function scorePathTermMatch(filePath, queryTerms) {
    const normalizedPath = normalizeSearchPath(filePath);
    if (!normalizedPath) return 0;

    const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;
    const querySegmentSet = new Set(queryTerms.flatMap(searchPathSignalSegments));
    let score = 0;
    for (const term of queryTerms.filter(isExplicitPathTerm)) {
      const normalizedTerm = normalizeSearchPath(term);
      if (!normalizedTerm) continue;
      if (normalizedPath === normalizedTerm || fileName === normalizedTerm) {
        score += 250;
        continue;
      }
      if (normalizedPath.endsWith(`/${normalizedTerm}`)) {
        score += 220;
        continue;
      }
      if (normalizedTerm.endsWith(`/${normalizedPath}`) || normalizedTerm.endsWith(`/${fileName}`)) {
        score += 220;
        continue;
      }
      if (normalizedPath.includes(normalizedTerm)) {
        score += 120;
      }
    }
    score += scorePathSegmentCoverage(fileName, querySegmentSet, 90);
    score += scorePathSegmentCoverage(normalizedPath, querySegmentSet, 45);
    return score;
  }

  function queryScoringContext(rawQuery = '') {
    const query = String(rawQuery ?? '').toLowerCase();
    const queryTerms = queryTokens(query);
    const explicitTerms = explicitQueryTerms(rawQuery);
    const focusedTerms = focusedExplicitQueryTerms(rawQuery, explicitTerms);
    return {
      query,
      queryTerms,
      explicitTerms,
      focusedTerms,
    };
  }

  function scoreNodeRelevanceForQuery(node, context) {
    return {
      explicitScore: scoreExplicitQueryTermText(
        joinSearchText([node?.name, node?.qualifiedName, node?.filePath, node?.kind]),
        context.focusedTerms,
        context.explicitTerms,
        5000,
        400,
      ),
      coreScore: scoreGraphNode(
        node,
        context.query,
        context.queryTerms,
        nodeCoreSearchText(node),
        context.focusedTerms,
        context.explicitTerms,
      ),
      fullScore: scoreGraphNode(
        node,
        context.query,
        context.queryTerms,
        nodeSearchText(node),
        context.focusedTerms,
        context.explicitTerms,
      ),
    };
  }

  function fillGraphNodeBudgetWithRelevantEndpoints(nodes, edges, graphNodes, rawQuery, limit) {
    if (nodes.length === 0) return nodes;
    const queryTerms = queryTokens(rawQuery);
    if (queryTargetsExactMemberNode(nodes, queryTerms)) return nodes;
    const nodesById = new Map(graphNodes.map(node => [node.id, node]));
    if (nodes.length >= limit) {
      return retainEssentialAngularResourceEndpoints(nodes, edges, nodesById, rawQuery, limit);
    }
    const selected = [...nodes];
    const selectedIds = new Set(nodes.map(node => node.id));
    const selectedDisplayKeys = new Set(nodes.map(displaySymbolKey));
    const includeTestEdges = queryAllowsTestFiles(rawQuery);
    const structuralEdgeKinds = new Set(['imports', 'exports']);
    const addNode = node => {
      if (!node || selected.length >= limit || !isMarkdownSymbolNode(node)) return false;
      const displayKey = displaySymbolKey(node);
      if (selectedIds.has(node.id) || selectedDisplayKeys.has(displayKey)) return false;
      selected.push(node);
      selectedIds.add(node.id);
      selectedDisplayKeys.add(displayKey);
      return true;
    };
    const isSelected = id => {
      if (selectedIds.has(id)) return true;
      const node = nodesById.get(id);
      return Boolean(node && selectedDisplayKeys.has(displaySymbolKey(node)));
    };

    let changed = true;
    while (changed && selected.length < limit) {
      changed = false;
      for (const edge of edges) {
        const sourceSelected = isSelected(edge.source);
        const targetSelected = isSelected(edge.target);
        if (!sourceSelected && !targetSelected) continue;
        if (edge.metadata?.relation === 'test' && !includeTestEdges) continue;
        if (!structuralEdgeKinds.has(edge.kind)
          && !edgeMatchesAnyQueryTermWithEndpoints(edge, nodesById, queryTerms)) {
          continue;
        }
        changed = addNode(nodesById.get(edge.source)) || changed;
        changed = addNode(nodesById.get(edge.target)) || changed;
        if (selected.length >= limit) break;
      }
    }
    return retainEssentialAngularResourceEndpoints(selected, edges, nodesById, rawQuery, limit);
  }

  function queryTargetsExactMemberNode(nodes, queryTerms) {
    if (queryTerms.length !== 1) return false;
    const [term] = queryTerms;
    const hasExactOwnerNode = nodes.some(node => (
      node?.kind !== 'method'
      && node?.kind !== 'property'
      && [node.name, node.qualifiedName]
        .some(value => String(value ?? '').toLowerCase() === term)
    ));
    if (hasExactOwnerNode) return false;
    return nodes.some(node => (
      (node?.kind === 'method' || node?.kind === 'property')
      && [node.name, readQualifiedNameLeaf(node.qualifiedName)]
        .some(value => String(value ?? '').toLowerCase() === term)
    ));
  }

  function retainEssentialAngularResourceEndpoints(nodes, edges, nodesById, rawQuery, limit) {
    const selected = [...nodes];
    const selectedIds = new Set(selected.map(node => node.id));
    const selectedComponentKeys = new Set(selected
      .filter(node => node.kind === 'component')
      .map(node => joinSearchText([node.name, node.filePath, node.startLine])));
    const protectedIds = new Set();
    if (selectedComponentKeys.size === 0) {
      retainQuerySemanticEndpoints(selected, selectedIds, protectedIds, edges, nodesById, rawQuery, limit);
      return selected;
    }
    const selectedComponentIds = new Set(selected
      .filter(node => selectedComponentKeys.has(joinSearchText([node.name, node.filePath, node.startLine])))
      .map(node => node.id));
    for (const id of selectedComponentIds) protectedIds.add(id);
    const candidates = edges
      .filter(edge => (
        selectedComponentIds.has(edge.source)
        && !selectedIds.has(edge.target)
        && (edge.metadata?.relation === 'template-url' || edge.metadata?.relation === 'template-binding')
      ))
      .sort((a, b) => (
        Number(a.metadata?.relation !== 'template-url') - Number(b.metadata?.relation !== 'template-url')
        || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
        || (a.column ?? Number.MAX_SAFE_INTEGER) - (b.column ?? Number.MAX_SAFE_INTEGER)
        || compareEdge(a, b)
      ));
    for (const edge of candidates.slice(0, 2)) {
      const endpoint = nodesById.get(edge.target);
      if (!endpoint || !isMarkdownSymbolNode(endpoint)) continue;
      while (selected.length >= limit) {
        const removableIndex = selected.findLastIndex(node => !protectedIds.has(node.id));
        if (removableIndex < 0) return selected;
        selectedIds.delete(selected[removableIndex].id);
        selected.splice(removableIndex, 1);
      }
      selected.push(endpoint);
      selectedIds.add(endpoint.id);
      protectedIds.add(endpoint.id);
    }
    retainQuerySemanticEndpoints(selected, selectedIds, protectedIds, edges, nodesById, rawQuery, limit);
    return selected;
  }

  function retainQuerySemanticEndpoints(
    selected,
    selectedIds,
    protectedIds,
    edges,
    nodesById,
    rawQuery,
    limit,
  ) {
    const queryTerms = queryTokens(rawQuery);
    const ownerNames = querySemanticOwnerNames(selected, queryTerms);
    if (ownerNames.length === 0) return;

    const selectedOwnerNodes = selected
      .filter(node => ownerNames.some(owner => (
        node.qualifiedName === owner || String(node.qualifiedName ?? '').startsWith(`${owner}::`)
      )));
    const ownerDisplayKeys = new Set(selectedOwnerNodes.map(displaySymbolKey));
    const ownerSourceIds = new Set([...nodesById.values()]
      .filter(node => ownerDisplayKeys.has(displaySymbolKey(node)))
      .map(node => node.id));
    const selectedOwnerRootNodes = selected
      .filter(node => ownerNames.includes(String(node.qualifiedName ?? node.name ?? '')))
    const ownerRootDisplayKeys = new Set(selectedOwnerRootNodes.map(displaySymbolKey));
    const ownerRootIds = new Set([...nodesById.values()]
      .filter(node => ownerRootDisplayKeys.has(displaySymbolKey(node)))
      .map(node => node.id));
    for (const id of ownerRootIds) protectedIds.add(id);
    for (const node of selected) {
      if (!ownerSourceIds.has(node.id)) continue;
      const nodeTerms = [node.name, readQualifiedNameLeaf(node.qualifiedName)]
        .map(value => String(value ?? '').toLowerCase());
      if (queryTerms.some(term => nodeTerms.includes(term))) {
        protectedIds.add(node.id);
      }
    }

    const selectedDisplayKeys = new Set(selected.map(displaySymbolKey));
    const candidateTargets = querySemanticEndpointCandidates(
      edges,
      ownerSourceIds,
      ownerRootIds,
      selectedIds,
      nodesById,
      queryTerms.length === 1 ? queryTerms[0] : null,
    );
    let addedEndpointCount = 0;
    for (const targetId of candidateTargets) {
      if (addedEndpointCount >= 6) break;
      const endpoint = nodesById.get(targetId);
      if (!endpoint || !isMarkdownSymbolNode(endpoint) || selectedDisplayKeys.has(displaySymbolKey(endpoint))) continue;
      while (selected.length >= limit) {
        const removableIndex = selected.findLastIndex(node => !protectedIds.has(node.id));
        if (removableIndex < 0) return;
        selectedDisplayKeys.delete(displaySymbolKey(selected[removableIndex]));
        selectedIds.delete(selected[removableIndex].id);
        selected.splice(removableIndex, 1);
      }
      selected.push(endpoint);
      selectedIds.add(endpoint.id);
      selectedDisplayKeys.add(displaySymbolKey(endpoint));
      protectedIds.add(endpoint.id);
      addedEndpointCount += 1;
    }
  }

  function querySemanticOwnerNames(selected, queryTerms) {
    const terms = new Set(queryTerms);
    const hasSingleTerm = queryTerms.length === 1;
    return unique(selected
      .filter(node => {
        const name = String(node.qualifiedName ?? node.name ?? '').toLowerCase();
        if (!terms.has(name)) return false;
        if (node.kind === 'type_alias' || node.kind === 'interface') return true;
        return hasSingleTerm && !['file', 'import', 'method', 'parameter', 'property'].includes(node.kind);
      })
      .map(node => String(node.qualifiedName ?? node.name ?? '')));
  }

  function querySemanticEndpointCandidates(edges, ownerSourceIds, ownerRootIds, selectedIds, nodesById, exactTerm) {
    const candidates = edges.flatMap(edge => {
      const relation = String(edge.metadata?.relation ?? '');
      const exportNameMatches = exactTerm && String(edge.metadata?.exportName ?? '').toLowerCase() === exactTerm;
      const sourceOwned = ownerSourceIds.has(edge.source);
      const targetOwned = ownerSourceIds.has(edge.target);
      if (!exportNameMatches && !sourceOwned && !targetOwned) return [];
      if (!querySemanticEndpointRelationApplies(relation, exportNameMatches)) return [];
      const endpointIds = exportNameMatches
        ? [edge.source, edge.target]
        : [sourceOwned ? edge.target : edge.source];
      const directRank = exportNameMatches || ownerRootIds.has(edge.source) || ownerRootIds.has(edge.target) ? 0 : 1;
      return endpointIds
        .filter(id => !selectedIds.has(id))
        .map(id => ({ directRank, edge, id, node: nodesById.get(id), relation }));
    });
    return uniqueBy(candidates
      .filter(candidate => candidate.node)
      .sort((a, b) => a.directRank - b.directRank
        || querySemanticEndpointRelationPriority(a.relation)
        - querySemanticEndpointRelationPriority(b.relation)
        || querySemanticEndpointNodePriority(a.node) - querySemanticEndpointNodePriority(b.node)
        || compareEdge(a.edge, b.edge)), candidate => candidate.id)
      .map(candidate => candidate.id);
  }

  function querySemanticEndpointRelationApplies(relation, exportNameMatches) {
    if (exportNameMatches) return relation === 're-export' || relation === 'export-equals';
    return [
      'call', 'class-member', 'enum-member', 'extends', 'implements', 'interface-member',
      'file-symbol', 'initializer-reference', 'new', 'parameter-type', 'return-type',
      'type-literal-member', 'type-reference',
    ].includes(relation);
  }

  function querySemanticEndpointRelationPriority(relation) {
    if (relation === 're-export' || relation === 'export-equals') return 0;
    if (relation === 'file-symbol') return 0;
    if (relation === 'new' || relation === 'extends' || relation === 'implements') return 1;
    if (relation.endsWith('-member')) return 2;
    return 3;
  }

  function querySemanticEndpointNodePriority(node) {
    const priorities = { interface: 0, property: 1, type_alias: 2, enum: 2, class: 3, method: 4, function: 4 };
    return priorities[node?.kind] ?? 5;
  }

  function closeGraphEdgesOverSelectedNodes(edges, selectedNodes, graphNodes) {
    const selectedById = new Map(selectedNodes.map(node => [node.id, node]));
    const selectedIdByDisplayKey = new Map(selectedNodes
      .map(node => [displaySymbolKey(node), node.id]));
    const graphNodesById = new Map(graphNodes.map(node => [node.id, node]));
    const resolveSelectedId = id => {
      if (selectedById.has(id)) return id;
      const node = graphNodesById.get(id);
      return node ? selectedIdByDisplayKey.get(displaySymbolKey(node)) : undefined;
    };
    return uniqueBy(edges.flatMap(edge => {
      const source = resolveSelectedId(edge.source);
      const target = resolveSelectedId(edge.target);
      if (!source || !target) return [];
      return [{
        ...edge,
        source,
        target,
        sourceName: selectedById.get(source)?.name ?? edge.sourceName,
        targetName: selectedById.get(target)?.name ?? edge.targetName,
      }];
    }), edge => joinSearchText([
      edge.source,
      edge.target,
      edge.kind,
      edge.line,
      edge.column,
      edge.metadata,
    ]));
  }

  function orderRelatedFilesForQuery(filePaths, rawQuery = '') {
    const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
    if (queryTerms.length === 0) return filePaths;
    const scored = filePaths.map((filePath, index) => ({
      filePath,
      index,
      pathScore: scorePathTermMatch(filePath, queryTerms),
      lowInformationPenalty: lowInformationFilePenalty(filePath, rawQuery),
    }));
    if (!scored.some(entry => entry.pathScore > 0 || entry.lowInformationPenalty > 0)) return filePaths;
    return scored
      .sort((a, b) => b.pathScore - a.pathScore
        || a.lowInformationPenalty - b.lowInformationPenalty
        || String(a.filePath ?? '').localeCompare(String(b.filePath ?? ''))
        || a.index - b.index)
      .map(entry => entry.filePath);
  }

  function lowInformationNodePenalty(node, rawQuery = '') {
    return lowInformationFilePenalty(node?.filePath, rawQuery)
      + lowInformationNodeKindPenalty(node, rawQuery);
  }

  function lowInformationNodeKindPenalty(node, rawQuery = '') {
    const kind = String(node?.kind ?? '');
    if (kind === 'file') {
      const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
      if (queryTerms.some(isExplicitPathTerm) && scorePathTermMatch(node?.filePath, queryTerms) > 0) {
        return 0;
      }
      return 300;
    }
    if (kind === 'import' || kind === 'export' || kind === 'parameter') return 700;
    if (isExternalReferencePlaceholder(node)) return 1000;
    return 0;
  }

  function lowInformationFilePenalty(filePath, rawQuery = '') {
    const normalized = normalizeSearchPath(filePath);
    if (!normalized) return 0;
    const query = String(rawQuery ?? '').toLowerCase();

    if (!queryAllowsTestFiles(query) && isLowInformationTestFilePath(normalized)) return 6000;
    if (!/\bicons?\b/i.test(query) && /(?:^|\/)icons?\//.test(normalized)) return 5000;
    if (!/\bi18n\b/i.test(query) && /(?:^|\/)i18n\//.test(normalized)) return 5000;
    if (!/\b(?:generated|gen|proto|protobuf|pb)\b/i.test(query) && isGeneratedFilePath(normalized)) return 1000;
    return 0;
  }

  function queryAllowsTestFiles(query) {
    const normalizedQuery = String(query ?? '').toLowerCase();
    return queryMentionsTests(normalizedQuery)
      || queryTokens(normalizedQuery).some(isTestMappingQuery)
      || normalizeExactRelationQueries(normalizedQuery).some(isTestMappingQuery);
  }

  function isLowInformationTestFilePath(filePath) {
    const normalized = normalizeSearchPath(filePath);
    return isTestFile(normalized)
      || /(?:^|\/)[^/]+[.-](?:test|spec)[.-][^/]+\.[cm]?[jt]sx?$/.test(normalized)
      || /(?:^|\/)[^/]+[-.]helpers?\.[cm]?[jt]sx?$/.test(normalized);
  }

  function isExplicitPathTerm(term) {
    const normalized = normalizeSearchPath(term);
    return /[/.\\]/.test(String(term ?? ''))
      && /\.(?:[cm]?[tj]sx?|kt|json|md|html|xml|css|scss|sql|cjs|mjs|mts|cts)$/i.test(normalized);
  }

  function normalizeSearchPath(value) {
    return String(value ?? '')
      .trim()
      .replace(/^['"`]+|['"`]+$/g, '')
      .toLowerCase()
      .replace(/\\/g, '/')
      .replace(/(\.(?:[cm]?[tj]sx?|kt|json|md|html|xml|css|scss|sql|cjs|mjs|mts|cts))(?::\d+(?::\d+)?)$/i, '$1');
  }

  function scorePathSegmentCoverage(pathLike, querySegmentSet, fullCoverageScore) {
    const segments = searchPathSignalSegments(pathLike);
    if (segments.length < 2) return 0;
    const matched = segments.filter(segment => querySegmentSet.has(segment));
    if (matched.length === segments.length) return fullCoverageScore + (matched.length * 12);
    if (matched.length >= 2) return Math.floor((matched.length / segments.length) * (fullCoverageScore / 3)) + (matched.length * 4);
    return 0;
  }

  function searchPathSignalSegments(value) {
    const normalized = normalizeSearchPath(value);
    const fileName = normalized.split('/').at(-1) ?? normalized;
    const withoutExtension = fileName.replace(/\.(?:[cm]?[tj]sx?|kt|json|md|html|xml|css|scss|sql|cjs|mjs|mts|cts)$/i, '');
    return unique(withoutExtension
      .split(/[^a-z0-9$]+/i)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2)
      .filter(segment => !['src', 'app', 'lib', 'test', 'spec'].includes(segment)));
  }


  function codeBlockSourceFirstRelationQueries() {
    return relationPolicySet([
      'standalone-import',
      'provider',
      'dependency',
      'host-attribute',
      'host-binding',
      'host-listener',
      'android-kotlin-annotation',
      'android-kotlin-extends',
      'android-kotlin-implements',
      'android-kotlin-import',
      'android-kotlin-override',
      'android-kotlin-type-reference',
      'android-widget-provider',
      'providedIn',
      'angular-app-provider',
      'angular-route-guard',
      'angular-route-resolver',
      'angular-route-redirect',
      'angular-route-provider',
      'edge-function-route',
      'edge-function-source',
      'edge-function-method',
      'edge-function-header',
      'edge-function-invoke',
      'context7-source-map-source',
      'supabase-storage-bucket',
      'supabase-incremental-predicate',
      'supabase-rpc',
      'supabase-table-write',
      'supabase-realtime-channel',
      'supabase-realtime-postgres-change',
      'supabase-realtime-status',
      'supabase-realtime-unsubscribe',
      'supabase-realtime-remove-channel',
      'supabase-realtime-remove-all-channels',
    ]);
  }

  function sourceFirstSyntheticTargetSuppressionRelationQueries() {
    return relationPolicySet([
      'edge-function-method',
      'edge-function-header',
      'android-kotlin-annotation',
      'android-kotlin-extends',
      'android-kotlin-implements',
      'android-kotlin-import',
      'android-kotlin-override',
      'android-kotlin-type-reference',
    ]);
  }

  function hardRuleEvidenceTargetEntryPointRelationQueries() {
    return relationPolicySet([
      'hard-rule-implementation',
      'hard-rule-test-evidence',
    ]);
  }

  function ownerPreferredSyntheticVariableRelationQueries() {
    return relationPolicySet([
      'supabase-storage-bucket',
      'supabase-incremental-predicate',
      'supabase-rpc',
      'supabase-table-write',
      'supabase-realtime-channel',
      'supabase-realtime-postgres-change',
      'supabase-realtime-status',
      'supabase-realtime-unsubscribe',
      'supabase-realtime-remove-channel',
      'supabase-realtime-remove-all-channels',
    ]);
  }

  function isTestMappingQuery(query) {
    return relationPolicySet([
      'test',
      'same-basename',
      'class-reference',
      'path-reference',
      'route-reference',
      'invoke-reference',
      'filename-reference',
    ]).has(normalizeExactRelationQuery(query));
  }

  function relationPolicySet(values) {
    return new Set(values.map(value => normalizeExactRelationQuery(value)));
  }

  function normalizeExactRelationQuery(value) {
    return String(value ?? '').toLowerCase();
  }

  function normalizeExactRelationQueries(value) {
    if (Array.isArray(value)) {
      return unique(value.flatMap(item => normalizeExactRelationQueries(item)));
    }
    return unique(String(value ?? '')
      .split('/')
      .map(item => normalizeExactRelationQuery(item))
      .filter(Boolean));
  }

  function interleaveUniqueBuckets(buckets, keyFn) {
    const results = [];
    const seen = new Set();
    const maxLength = Math.max(0, ...buckets.map(bucket => bucket.length));
    for (let index = 0; index < maxLength; index += 1) {
      for (const bucket of buckets) {
        const item = bucket[index];
        if (item === undefined || item === null) continue;
        const key = keyFn(item);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(item);
      }
    }
    return results;
  }


  queryTokensDelegate = queryTokens;
  Object.assign(runtime, {
    queryTokens, explicitQueryTerms, focusedExplicitQueryTerms, isLikelyExplicitSymbolTerm, scoreExplicitQueryTermText,
    scorePathTermMatch, queryScoringContext, scoreNodeRelevanceForQuery, fillGraphNodeBudgetWithRelevantEndpoints, queryTargetsExactMemberNode,
    retainEssentialAngularResourceEndpoints, retainQuerySemanticEndpoints, querySemanticOwnerNames, querySemanticEndpointCandidates, querySemanticEndpointRelationApplies,
    querySemanticEndpointRelationPriority, querySemanticEndpointNodePriority, closeGraphEdgesOverSelectedNodes,
    orderRelatedFilesForQuery, lowInformationNodePenalty, lowInformationNodeKindPenalty, lowInformationFilePenalty,
    queryAllowsTestFiles, isLowInformationTestFilePath, isExplicitPathTerm, normalizeSearchPath, scorePathSegmentCoverage,
    searchPathSignalSegments, codeBlockSourceFirstRelationQueries, sourceFirstSyntheticTargetSuppressionRelationQueries, hardRuleEvidenceTargetEntryPointRelationQueries, ownerPreferredSyntheticVariableRelationQueries,
    isTestMappingQuery, relationPolicySet, normalizeExactRelationQuery, normalizeExactRelationQueries, interleaveUniqueBuckets,
  });
}
