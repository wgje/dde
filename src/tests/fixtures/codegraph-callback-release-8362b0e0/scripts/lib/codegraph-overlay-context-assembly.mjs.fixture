let buildSourceBlocksDelegate;
let installed = false;
function installedDelegate(value, delegateName, installerName) {
  if (!value) throw new Error(`${delegateName} requires ${installerName}() before use`);
  return value;
}
export function buildSourceBlocksImpl(...values) { return installedDelegate(buildSourceBlocksDelegate, 'buildSourceBlocksImpl', 'installContextAssembly')(...values); }

export function installContextAssembly(runtime) {
  if (installed) throw new Error('installContextAssembly() may only be called once');
  installed = true;
  const {
    fs, path, ANGULAR_SEMANTIC_API_QUERY_TERMS, HIGH_VALUE_NODE_KINDS, OFFICIAL_CODEGRAPH_LANGUAGES,
    OFFICIAL_GENERATED_FILE_PATTERNS, SOURCE_BLOCK_FILE_LIMIT
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    normalizeAngularSemanticApi = call('normalizeAngularSemanticApi'), isStrongSingleTermNodeMatch = call('isStrongSingleTermNodeMatch'), edgeMatchesExactMetadataQuery = call('edgeMatchesExactMetadataQuery'),
    queryTokens = call('queryTokens'), isExplicitPathTerm = call('isExplicitPathTerm'), exactMetadataQueryFromEdges = call('exactMetadataQueryFromEdges'),
    sourceOwnerEntryPointRelationQueries = call('sourceOwnerEntryPointRelationQueries'), compareNodeSourceOrder = call('compareNodeSourceOrder'), preferredExactRelationCodeBlockEndpointIds = call('preferredExactRelationCodeBlockEndpointIds'),
    preferredExplicitEdgeFunctionSourceEndpointIds = call('preferredExplicitEdgeFunctionSourceEndpointIds'), suppressedExactRelationCodeBlockEndpointIds = call('suppressedExactRelationCodeBlockEndpointIds'), hardRuleEvidenceTargetEntryPointRelationQueries = call('hardRuleEvidenceTargetEntryPointRelationQueries'),
    ownerPreferredSyntheticVariableRelationQueries = call('ownerPreferredSyntheticVariableRelationQueries'), normalizeExactRelationQuery = call('normalizeExactRelationQuery'), groupNodesByFile = call('groupNodesByFile'),
    getExploreOutputBudget = call('getExploreOutputBudget'), queryScoringContext = call('queryScoringContext'), scoreNodeRelevanceForQuery = call('scoreNodeRelevanceForQuery'),
    scorePathTermMatch = call('scorePathTermMatch'), context7RetrievalSourceQueryApplies = call('context7RetrievalSourceQueryApplies'), selectedContext7RetrievalRouteIds = call('selectedContext7RetrievalRouteIds'),
    toPosix = call('toPosix'), queryAllowsTestFiles = call('queryAllowsTestFiles'),
    unique = call('unique'), uniqueBy = call('uniqueBy'), isTestFile = call('isTestFile');

  function buildRelationshipGroups(edges) {
    const groups = {};
    const seenKeysByKind = new Map();
    for (const edge of edges) {
      const group = groups[edge.kind] ?? [];
      let seenKeys = seenKeysByKind.get(edge.kind);
      if (!seenKeys) {
        seenKeys = new Set();
        seenKeysByKind.set(edge.kind, seenKeys);
      }
      const displayEdge = {
        source: formatEdgeSource(edge),
        target: edge.targetName ?? edge.target,
        ...(edge.metadata ?? {}),
      };
      const key = JSON.stringify(displayEdge);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        group.push(displayEdge);
      }
      groups[edge.kind] = group;
    }

    return Object.fromEntries(
      Object.entries(groups).filter(([, groupedEdges]) => groupedEdges.length > 0),
    );
  }

  function capRelationshipGroups(groups, limit) {
    const capped = {};
    for (const [kind, edges] of Object.entries(groups ?? {})) {
      capped[kind] = Array.isArray(edges) ? edges.slice(0, limit) : [];
    }
    return capped;
  }

  function formatEdgeSource(edge) {
    if (edge.metadata?.relation === 'template-binding') {
      return `${edge.sourceName ?? edge.source} template`;
    }
    return edge.sourceName ?? edge.source;
  }

  function filterRelationshipGroupsForMarkdown(groups, rawQuery) {
    const query = String(rawQuery ?? '').toLowerCase();
    return Object.fromEntries(
      Object.entries(groups)
        .map(([kind, edges]) => {
          if (kind !== 'contains') return [kind, edges];
          return [kind, edges.filter(edge => String(edge.relation ?? '').toLowerCase() === query)];
        })
        .filter(([, edges]) => edges.length > 0),
    );
  }

  function buildBlastRadiusEntries(nodes, edges, dependencyNodes = nodes) {
    const meaningfulKinds = new Set([
      'function',
      'method',
      'class',
      'interface',
      'enum',
      'type_alias',
      'component',
      'constant',
      'variable',
      'property',
    ]);
    const dependencyEdgeKinds = new Set([
      'calls',
      'references',
      'extends',
      'implements',
      'overrides',
      'instantiates',
      'returns',
      'type_of',
      'imports',
      'decorates',
    ]);
    const nodesById = new Map(dependencyNodes.map(node => [node.id, node]));
    const roots = nodes
      .filter(node => meaningfulKinds.has(node.kind))
      .sort(compareNodeSourceOrder)
      .slice(0, 5);
    const entries = [];

    for (const root of roots) {
      const incoming = edges
        .filter(edge => edge.target === root.id && edge.source !== root.id)
        .filter(edge => dependencyEdgeKinds.has(edge.kind))
        .filter(edge => edge.metadata?.relation !== 'file-symbol')
        .map(edge => nodesById.get(edge.source))
        .filter(Boolean);
      const uniqueCallers = uniqueBy(incoming, node => node.id);
      const callerFiles = unique(uniqueCallers
        .map(node => node.filePath)
        .filter(filePath => filePath && !isTestFile(filePath)));
      const testFiles = unique([
        ...uniqueCallers.map(node => node.filePath).filter(isTestFile),
        ...edges
          .filter(edge => edge.source === root.id && edge.metadata?.relation === 'test')
          .map(edge => edge.targetName ?? edge.target)
          .filter(isTestFile),
      ]);

      if (uniqueCallers.length === 0 && testFiles.length === 0) continue;
      entries.push({
        name: root.name,
        filePath: root.filePath,
        line: root.startLine,
        callerCount: uniqueCallers.length,
        callerFiles,
        testFiles,
      });
    }

    return entries;
  }

  function buildNotShownEntries(nodes, shownSourceFiles) {
    return groupNodesByFile(nodes)
      .filter(([filePath]) => filePath !== '(unknown)' && !shownSourceFiles.has(filePath))
      .map(([filePath, groupedNodes]) => ({
        filePath,
        symbols: groupedNodes
          .filter(node => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
          .map(node => `${node.name}:${node.startLine ?? '?'}`)
          .slice(0, 12),
      }))
      .filter(entry => entry.symbols.length > 0)
      .slice(0, 10);
  }

  function isMarkdownSymbolNode(node) {
    return [
      'file',
      'component',
      'class',
      'function',
      'method',
      'property',
      'interface',
      'type_alias',
      'constant',
      'variable',
      'enum',
      'enum_member',
      'namespace',
      'parameter',
      'import',
      'export',
      'route',
    ].includes(node.kind);
  }

  function displaySymbolKey(node) {
    return [
      node?.kind ?? '',
      node?.name ?? '',
      node?.filePath ?? '',
      node?.startLine ?? '',
      agentRuleRelationDiscriminator(node),
    ].join('\0');
  }

  function agentRuleRelationDiscriminator(node) {
    if (node?.filePath !== 'AGENTS.md') return '';
    const relation = node?.metadata?.relation;
    return relation === 'hard-rule' || relation === 'hard-rule-keyword' || relation === 'sync-rule' || relation === 'sync-rule-keyword'
      ? relation
      : '';
  }

  function compareNodeSpecificity(a, b) {
    return nodeRelationPriority(a) - nodeRelationPriority(b)
      || nodeKindPriority(a.kind) - nodeKindPriority(b.kind)
      || compareNode(a, b);
  }

  function nodeRelationPriority(node) {
    const relation = node?.metadata?.relation;
    if (relation === 'hard-rule' || relation === 'sync-rule') return 0;
    if (relation === 'hard-rule-keyword' || relation === 'sync-rule-keyword') return 5;
    if (relation === 'external-reference') return 9;
    return 3;
  }

  function nodeKindPriority(kind) {
    const priorities = {
      file: 0,
      component: 1,
      route: 2,
      class: 3,
      method: 4,
      property: 5,
      function: 6,
      interface: 7,
      type_alias: 8,
      enum: 9,
      enum_member: 10,
      parameter: 11,
      import: 12,
      export: 13,
      constant: 14,
      variable: 15,
      namespace: 16,
    };
    return priorities[kind] ?? 20;
  }

  function compareNode(a, b) {
    return String(a.filePath ?? '').localeCompare(String(b.filePath ?? ''))
      || String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
      || String(a.name ?? '').localeCompare(String(b.name ?? ''));
  }

  function compareEdge(a, b) {
    return structuralEdgePriority(a) - structuralEdgePriority(b)
      || String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
      || edgeRelationPriority(a) - edgeRelationPriority(b)
      || String(a.sourceName ?? a.source ?? '').localeCompare(String(b.sourceName ?? b.source ?? ''))
      || String(a.targetName ?? a.target ?? '').localeCompare(String(b.targetName ?? b.target ?? ''));
  }

  function structuralEdgePriority(edge) {
    return edge?.kind === 'contains' || edge?.kind === 'exports' ? 1 : 0;
  }

  function edgeRelationPriority(edge) {
    const relation = edge?.metadata?.relation ?? edge?.relation;
    if (relation === 'hard-rule-keyword') return 0;
    if (relation === 'hard-rule-implementation') return 1;
    if (relation === 'hard-rule-test-evidence') return 2;
    return 5;
  }

  function formatSummary(nodes, relatedFiles) {
    return `Found ${nodes.length} relevant code symbols across ${relatedFiles.length} files.`;
  }

  function selectEntryPoints(nodes, matches, limit, rawQuery = '', edges = []) {
    const selected = [];
    const seen = new Set();
    const query = String(rawQuery ?? '').toLowerCase();
    const queryTerms = queryTokens(query);
    const strongEntryPointIds = new Set();
    const relationEntryPoints = preferredExactRelationEntryPoints(nodes, edges, query);
    const suppressedEntryPointIds = relationEntryPoints.length > 0
      ? suppressedExactRelationEntryPointIds(nodes, edges, query)
      : new Set();
    for (const node of relationEntryPoints) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      selected.push(node);
    }

    if (queryTerms.length === 1) {
      for (const match of matches) {
        const matchName = match.name ?? match.item?.className ?? match.item?.name;
        const matchFile = match.file ?? match.item?.file ?? match.item?.entry;
        for (const node of nodes) {
          if (
            (node.name === matchName || node.qualifiedName === matchName)
            && (!matchFile || node.filePath === matchFile)
            && isHighValueEntryPoint(node)
            && isStrongSingleTermNodeMatch(node, query, queryTerms[0])
          ) {
            strongEntryPointIds.add(node.id);
          }
        }
      }
    }
    const useStrongEntryPointsOnly = strongEntryPointIds.size > 0;

    for (const match of matches) {
      const matchName = match.name ?? match.item?.className ?? match.item?.name;
      const matchFile = match.file ?? match.item?.file ?? match.item?.entry;
      const candidates = nodes
        .filter(node => (
          (node.name === matchName || node.qualifiedName === matchName)
          && (!matchFile || node.filePath === matchFile)
          && isHighValueEntryPoint(node)
          && !suppressedEntryPointIds.has(node.id)
        ))
        .filter(node => !useStrongEntryPointsOnly || strongEntryPointIds.has(node.id))
        .sort(compareNodeSpecificity);

      for (const node of candidates) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        selected.push(node);
        break;
      }
    }

    if (selected.every(node => node.kind === 'file')) {
      const hasExplicitPathTerm = queryTerms.some(isExplicitPathTerm);
      if (hasExplicitPathTerm) {
        const cap = Math.max(1, Math.min(limit ?? 5, 8));
        return selected.slice(0, cap);
      }
      const specificNode = nodes.find(node => (
        node.kind !== 'file'
        && isHighValueEntryPoint(node)
        && !suppressedEntryPointIds.has(node.id)
      ));
      if (specificNode && !seen.has(specificNode.id)) {
        seen.add(specificNode.id);
        selected.unshift(specificNode);
      }
    }

    if (selected.length === 0 && nodes.length > 0) {
      selected.push(
        nodes.find(node => node.kind !== 'file' && isHighValueEntryPoint(node) && !suppressedEntryPointIds.has(node.id))
        ?? nodes.find(node => isHighValueEntryPoint(node) && !suppressedEntryPointIds.has(node.id))
        ?? nodes[0],
      );
    }

    const cap = Math.max(1, Math.min(limit ?? 5, 8));
    if (relationEntryPoints.length > 0) {
      return selected.slice(0, cap);
    }
    return selected.slice(0, cap);
  }

  function preferredExactRelationEntryPoints(nodes, edges, query) {
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const angularSemanticApiEndpointIds = angularSemanticApiEntryPointIds(nodesById, edges, query);
    const exactRelationQuery = exactMetadataQueryFromEdges(edges, query) ?? query;
    const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, exactRelationQuery));
    if (exactEdges.length === 0) {
      return angularSemanticApiEndpointIds
        .map(id => nodesById.get(id))
        .filter(node => node && isHighValueEntryPoint(node));
    }
    const sourceOwnerEndpointIds = sourceOwnerExactRelationEntryPointIds(nodesById, exactEdges, exactRelationQuery);
    const ownerEndpointIds = ownerPreferredExactRelationEntryPointIds(nodesById, exactEdges, exactRelationQuery);
    const hardRuleEvidenceEndpointIds = hardRuleEvidenceTargetExactRelationEntryPointIds(
      nodesById,
      exactEdges,
      exactRelationQuery,
    );
    const syncBodyKeywordEndpointIds = syncBodyKeywordExactRelationEntryPointIds(
      nodesById,
      exactEdges,
      exactRelationQuery,
    );
    const syncConfigKeywordEndpointIds = syncConfigKeywordExactRelationEntryPointIds(
      nodesById,
      exactEdges,
      exactRelationQuery,
    );
    const explicitEdgeFunctionSourceEndpointIds = preferredExplicitEdgeFunctionSourceEndpointIds(
      nodesById,
      edges,
      exactEdges,
      exactRelationQuery,
      query,
    );
    return unique([
      ...angularSemanticApiEndpointIds,
      ...explicitEdgeFunctionSourceEndpointIds,
      ...sourceOwnerEndpointIds,
      ...ownerEndpointIds,
      ...hardRuleEvidenceEndpointIds,
      ...syncBodyKeywordEndpointIds,
      ...syncConfigKeywordEndpointIds,
      ...preferredExactRelationCodeBlockEndpointIds(nodesById, edges, exactEdges, exactRelationQuery, query),
    ])
      .map(id => nodesById.get(id))
      .filter(node => node && isHighValueEntryPoint(node));
  }

  function sourceOwnerExactRelationEntryPointIds(nodesById, exactEdges, query) {
    if (!sourceOwnerEntryPointRelationQueries().has(normalizeExactRelationQuery(query))) return [];
    return unique(exactEdges
      .map(edge => nodesById.get(edge.source))
      .filter(node => node && isHighValueEntryPoint(node))
      .map(node => node.id));
  }

  function angularSemanticApiEntryPointIds(nodesById, edges, query) {
    const requestedApis = new Set(queryTokens(String(query ?? '').toLowerCase())
      .filter(term => ANGULAR_SEMANTIC_API_QUERY_TERMS.has(term)));
    if (requestedApis.size === 0) return [];
    return unique(edges
      .filter(edge => requestedApis.has(normalizeAngularSemanticApi(edge?.metadata?.api)))
      .map(edge => nodesById.get(edge.source))
      .filter(node => node && isHighValueEntryPoint(node))
      .map(node => node.id));
  }

  function ownerPreferredExactRelationEntryPointIds(nodesById, exactEdges, query) {
    if (!ownerPreferredSyntheticVariableRelationQueries().has(normalizeExactRelationQuery(query))) return [];
    return unique(exactEdges
      .map(edge => {
        const sourceNode = nodesById.get(edge.source);
        const targetNode = nodesById.get(edge.target);
        const sourceIsOwner = sourceNode?.kind === 'method' || sourceNode?.kind === 'function';
        return sourceIsOwner
          && targetNode?.kind === 'variable'
          && sourceNode.filePath
          && sourceNode.filePath === targetNode.filePath
          ? sourceNode.id
          : null;
      })
      .filter(Boolean));
  }

  function hardRuleEvidenceTargetExactRelationEntryPointIds(nodesById, exactEdges, query) {
    if (!hardRuleEvidenceTargetEntryPointRelationQueries().has(normalizeExactRelationQuery(query))) return [];
    return unique(exactEdges
      .map(edge => nodesById.get(edge.target))
      .filter(node => node?.kind === 'method' || node?.kind === 'function')
      .map(node => node.id));
  }

  function syncBodyKeywordExactRelationEntryPointIds(nodesById, exactEdges, query) {
    if (normalizeExactRelationQuery(query) !== 'sync-body-keyword') return [];
    return unique(exactEdges
      .map(edge => nodesById.get(edge.target))
      .filter(node => node?.metadata?.relation === 'sync-rule-keyword')
      .sort(compareSyncBodyKeywordEndpointPriority)
      .map(node => node.id));
  }

  function syncConfigKeywordExactRelationEntryPointIds(nodesById, exactEdges, query) {
    if (normalizeExactRelationQuery(query) !== 'sync-config-keyword') return [];
    return unique(exactEdges
      .map(edge => nodesById.get(edge.target))
      .filter(node => node?.metadata?.relation === 'sync-rule-keyword')
      .sort(compareSyncConfigKeywordEndpointPriority)
      .map(node => node.id));
  }

  function compareSyncBodyKeywordEndpointPriority(a, b) {
    return syncBodyKeywordEndpointRank(a) - syncBodyKeywordEndpointRank(b)
      || (a?.startLine ?? 0) - (b?.startLine ?? 0)
      || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  }

  function syncBodyKeywordEndpointRank(node) {
    return /^[A-Z0-9_]+_CONFIG\./.test(String(node?.name ?? '')) ? 1 : 0;
  }

  function compareSyncConfigKeywordEndpointPriority(a, b) {
    return (a?.startLine ?? 0) - (b?.startLine ?? 0)
      || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  }

  function suppressedExactRelationEntryPointIds(nodes, edges, query) {
    const exactRelationQuery = exactMetadataQueryFromEdges(edges, query) ?? query;
    const exactEdges = edges.filter(edge => edgeMatchesExactMetadataQuery(edge, exactRelationQuery));
    if (exactEdges.length === 0) return new Set();
    return suppressedExactRelationCodeBlockEndpointIds(
      new Map(nodes.map(node => [node.id, node])),
      exactEdges,
      exactRelationQuery,
    );
  }

  function isHighValueEntryPoint(node) {
    return HIGH_VALUE_NODE_KINDS.has(node?.kind) && !isExternalReferencePlaceholder(node);
  }

  function highValueRank(node) {
    return isHighValueEntryPoint(node) ? 1 : 0;
  }

  function isExternalReferencePlaceholder(node) {
    return node?.metadata?.relation === 'external-reference'
      || (node?.kind === 'variable' && !node.signature && Boolean(node?.metadata?.relation));
  }


  function readSourceBlock(projectRoot, filePath, nodes, outputBudget) {
    if (!filePath || filePath === '(unknown)') return null;
    const absolutePath = resolveProjectSourcePath(projectRoot, filePath);
    if (!absolutePath) return null;
    const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    const windows = mergeLineWindows(nodes, sourceLines.length, outputBudget.gapThreshold);
    const sortedNodes = [...nodes].sort(compareNodeSpecificity);
    const primaryNode = sortedNodes.find(node => node.kind !== 'import' && node.kind !== 'export')
      ?? sortedNodes[0]
      ?? null;
    return {
      filePath,
      language: languageForFile(filePath, primaryNode),
      startLine: windows[0]?.start ?? primaryNode?.startLine ?? 1,
      endLine: windows.at(-1)?.end ?? primaryNode?.endLine ?? primaryNode?.startLine ?? 1,
      symbols: formatSourceBlockSymbols(nodes, outputBudget.maxSymbolsInFileHeader),
      content: formatSourceWindows(sourceLines, windows, { lineNumbers: false }),
      source: formatSourceWindows(sourceLines, windows),
      primaryNode,
    };
  }

  function resolveProjectSourcePath(projectRoot, filePath) {
    const rootPath = path.resolve(projectRoot);
    const absolutePath = path.resolve(rootPath, filePath);
    if (!isPathInside(rootPath, absolutePath) || !fs.existsSync(absolutePath)) return null;

    const realRootPath = safeRealpath(rootPath);
    const realAbsolutePath = safeRealpath(absolutePath);
    if (!realRootPath || !realAbsolutePath || !isPathInside(realRootPath, realAbsolutePath)) return null;
    return realAbsolutePath;
  }

  function isPathInside(parentPath, childPath) {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath === '' || (
      !relativePath.startsWith('..')
      && !path.isAbsolute(relativePath)
    );
  }

  function safeRealpath(filePath) {
    try {
      return fs.realpathSync.native(filePath);
    } catch {
      try {
        return fs.realpathSync(filePath);
      } catch {
        return null;
      }
    }
  }

  function formatSourceBlockSymbols(nodes, maxSymbols = 10) {
    const symbols = unique(nodes
      .filter(node => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
      .map(node => `${node.name}(${node.kind})`));
    const headerCap = Math.max(1, Number.isFinite(maxSymbols) ? maxSymbols : 10);
    const shown = symbols.slice(0, headerCap);
    const omitted = symbols.length - shown.length;
    if (shown.length === 0) return '';
    return omitted > 0 ? `${shown.join(', ')}, +${omitted} more` : shown.join(', ');
  }

  function mergeLineWindows(nodes, lineCount, gapThreshold = 3) {
    const windows = nodes
      .map(node => ({
        start: Math.max(1, (node.startLine ?? 1) - 6),
        end: Math.min(lineCount, (node.endLine ?? node.startLine ?? 1) + 6),
      }))
      .filter(window => window.start <= window.end)
      .sort((a, b) => a.start - b.start);

    if (windows.length === 0) return [{ start: 1, end: Math.min(lineCount, 80) }];

    const merged = [];
    for (const window of windows) {
      const previous = merged.at(-1);
      if (previous && window.start <= previous.end + gapThreshold) {
        previous.end = Math.max(previous.end, window.end);
      } else {
        merged.push({ ...window });
      }
    }
    return merged;
  }

  function formatSourceWindows(sourceLines, windows, options = {}) {
    const output = [];
    let previousEnd = 0;
    for (const window of windows) {
      if (previousEnd > 0 && window.start > previousEnd + 1) {
        output.push('');
        output.push('... (gap) ...');
        output.push('');
      }
      for (let lineNumber = window.start; lineNumber <= window.end; lineNumber += 1) {
        const line = sourceLines[lineNumber - 1] ?? '';
        output.push(options.lineNumbers === false ? line : `${lineNumber}\t${line}`);
      }
      previousEnd = window.end;
    }
    return output.join('\n');
  }

  function compareGeneratedFileOrder(a, b) {
    const aGenerated = isGeneratedFilePath(a.filePath) ? 1 : 0;
    const bGenerated = isGeneratedFilePath(b.filePath) ? 1 : 0;
    return aGenerated - bGenerated;
  }

  function isGeneratedFilePath(filePath) {
    if (typeof filePath !== 'string') return false;
    return OFFICIAL_GENERATED_FILE_PATTERNS.some(pattern => pattern.test(filePath));
  }

  function languageForFile(filePath, node = null) {
    if (node?.language && node.language !== 'unknown' && OFFICIAL_CODEGRAPH_LANGUAGES.has(node.language)) {
      return node.language;
    }
    if (/\.(ts|mts|cts)$/i.test(filePath)) return 'typescript';
    if (/\.tsx$/i.test(filePath)) return 'tsx';
    if (/\.(js|mjs|cjs)$/i.test(filePath)) return 'javascript';
    if (/\.jsx$/i.test(filePath)) return 'jsx';
    if (/\.kt$/i.test(filePath)) return 'kotlin';
    if (/\.xml$/i.test(filePath)) return 'xml';
    if (/\.html?$/i.test(filePath)) return 'html';
    if (/\.css$/i.test(filePath)) return 'css';
    if (/\.scss$/i.test(filePath)) return 'scss';
    if (/\.sass$/i.test(filePath)) return 'sass';
    if (/\.less$/i.test(filePath)) return 'less';
    if (/\.sql$/i.test(filePath)) return 'sql';
    if (/\.mdx?$/i.test(filePath)) return 'markdown';
    if (/\.json$/i.test(filePath)) return 'json';
    if (/\.ya?ml$/i.test(filePath)) return 'yaml';
    if (/\.(properties|props)$/i.test(filePath)) return 'properties';
    return 'unknown';
  }

  function buildSourceBlocks(projectRoot, nodes, outputBudget = getExploreOutputBudget(0), rawQuery = '', edges = []) {
    let fileGroups = groupNodesByFile(nodes);
    {
      const nonLowValueGroups = fileGroups.filter(([filePath]) => !isLowValueSourcePath(filePath, rawQuery));
      if (nonLowValueGroups.length >= 2) {
        fileGroups = nonLowValueGroups;
      }
    }
    const context = queryScoringContext(rawQuery);
    fileGroups = fileGroups
      .map(([filePath, fileNodes], index) => ({
        filePath,
        fileNodes,
        index,
        ...scoreSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context),
      }))
      .sort((a, b) => b.preferredScore - a.preferredScore
        || b.explicitScore - a.explicitScore
        || b.coreScore - a.coreScore
        || b.pathScore - a.pathScore
        || b.fullScore - a.fullScore
        || a.index - b.index
        || a.filePath.localeCompare(b.filePath))
      .map(({ filePath, fileNodes }) => [filePath, fileNodes]);
    return fileGroups
      .slice(0, outputBudget.defaultMaxFiles ?? SOURCE_BLOCK_FILE_LIMIT)
      .map(([filePath, fileNodes]) => readSourceBlock(projectRoot, filePath, fileNodes, outputBudget))
      .filter(Boolean);
  }

  function scoreSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context) {
    const nodeScores = fileNodes.map(node => scoreNodeRelevanceForQuery(node, context));
    return {
      preferredScore: scorePreferredSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context),
      pathScore: scorePathTermMatch(filePath, context.queryTerms),
      explicitScore: maxNumericScore(nodeScores, 'explicitScore'),
      coreScore: maxNumericScore(nodeScores, 'coreScore'),
      fullScore: maxNumericScore(nodeScores, 'fullScore'),
    };
  }

  function scorePreferredSourceFileGroupForQuery(filePath, fileNodes, nodes, edges, context) {
    if (!context7RetrievalSourceQueryApplies(context.queryTerms)) return 0;
    const fileNodeIds = new Set(fileNodes.map(node => node.id));
    const selectedRouteIds = selectedContext7RetrievalRouteIds(nodes, context.queryTerms);
    if (selectedRouteIds.size === 0) return 0;
    return edges.some(edge => (
      edge.metadata?.relation === 'context7-retrieval-primary'
      && selectedRouteIds.has(edge.source)
      && fileNodeIds.has(edge.target)
    ))
      ? 1
      : 0;
  }

  function maxNumericScore(scores, key) {
    let maxScore = 0;
    for (const score of scores) {
      const value = Number(score?.[key] ?? 0);
      if (Number.isFinite(value) && value > maxScore) {
        maxScore = value;
      }
    }
    return maxScore;
  }

  function queryMentionsTests(query) {
    return /\b(test|tests|testing|spec|verify|verifies)\b/i.test(String(query ?? ''));
  }

  function isLowValueSourcePath(filePath, rawQuery = '') {
    const normalized = toPosix(String(filePath ?? '')).toLowerCase();
    if (!normalized) return false;
    const query = String(rawQuery ?? '').toLowerCase();
    if (queryMentionsLowValueSourcePathExplicitly(normalized, query)) return false;

    if (isTestLikeLowValueSourcePath(normalized)) {
      return !queryAllowsTestFiles(query)
        && !/\b(e2e|cypress|playwright|fixtures?|mocks?|stubs?|snapshots?|helpers?|harness)\b/i.test(query);
    }
    if (
      /(^|\/)(?:\d+-)?(stories?|storybook|demos?|samples?|examples?|playground)\//.test(normalized)
      || /\.(?:stories?|story|demo|sample|example|playground)\.[cm]?[jt]sx?$/.test(normalized)
    ) {
      return !/\b(story|stories|storybook|demos?|samples?|examples?|playgrounds?)\b/i.test(query);
    }
    if (/\bicons?\b/.test(normalized)) return !/\bicons?\b/i.test(query);
    if (/\bi18n\b/.test(normalized)) return !/\bi18n\b/i.test(query);
    if (/(^|\/)scripts\//.test(normalized)) {
      return !/\b(scripts?|codegraph|nanoflow|wrapper|adapter|mcp|gate|doctor|smoke)\b/i.test(query);
    }
    if (/(^|\/)\.github\//.test(normalized)) {
      return !/\b(github|workflows?|ci|actions?)\b/i.test(query);
    }
    if (/(^|\/)cloudflare\/workers-static-assets\//.test(normalized)) {
      return !/\b(cloudflare|workers?)\b/i.test(query);
    }
    return false;
  }

  function isTestLikeLowValueSourcePath(normalized) {
    return /\/(tests?|__tests?__|spec)\//.test(normalized)
      || /(^|\/)(e2e|cypress|playwright)(\/|$)/.test(normalized)
      || /(^|\/)(__fixtures__|__mocks__|fixtures?|mocks?|stubs?|snapshots?|test-fixtures|testdata|test-data)(\/|$)/.test(normalized)
      || /_test\.go$/.test(normalized)
      || /(?:^|\/)test_[^/]+\.py$/.test(normalized)
      || /_test\.py$/.test(normalized)
      || /_spec\.rb$/.test(normalized)
      || /_test\.rb$/.test(normalized)
      || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
      || /\.(?:cy|e2e)\.[cm]?[jt]sx?$/.test(normalized)
      || /\.(?:test|spec)-helpers?\.[cm]?[jt]sx?$/.test(normalized)
      || /\.helpers?\.[cm]?[jt]sx?$/.test(normalized)
      || /\.(?:fixture|fixtures|mock|mocks|stub|stubs|harness|snapshot|snapshots)\.[cm]?[jt]sx?$/.test(normalized)
      || /(test|spec|tests)\.(java|kt|scala)$/.test(normalized)
      || /(tests?|spec)\.cs$/.test(normalized)
      || /tests?\.swift$/.test(normalized)
      || /_test\.dart$/.test(normalized);
  }

  function queryMentionsLowValueSourcePathExplicitly(normalizedPath, query) {
    if (!query) return false;
    const fileName = normalizedPath.split('/').at(-1) ?? '';
    if (fileName.length >= 5 && query.includes(fileName)) return true;
    const stem = fileName.replace(/\.[a-z0-9]+$/i, '');
    return stem.length >= 6 && query.includes(stem);
  }


  buildSourceBlocksDelegate = buildSourceBlocks;
  Object.assign(runtime, {
    buildRelationshipGroups, capRelationshipGroups, formatEdgeSource, filterRelationshipGroupsForMarkdown, buildBlastRadiusEntries,
    buildNotShownEntries, isMarkdownSymbolNode, displaySymbolKey, agentRuleRelationDiscriminator,
    compareNodeSpecificity, nodeRelationPriority, nodeKindPriority, compareNode, compareEdge,
    edgeRelationPriority, formatSummary, selectEntryPoints, preferredExactRelationEntryPoints, sourceOwnerExactRelationEntryPointIds,
    angularSemanticApiEntryPointIds, ownerPreferredExactRelationEntryPointIds, hardRuleEvidenceTargetExactRelationEntryPointIds, syncBodyKeywordExactRelationEntryPointIds, syncConfigKeywordExactRelationEntryPointIds,
    compareSyncBodyKeywordEndpointPriority, syncBodyKeywordEndpointRank, compareSyncConfigKeywordEndpointPriority, suppressedExactRelationEntryPointIds, isHighValueEntryPoint,
    highValueRank, isExternalReferencePlaceholder, readSourceBlock, resolveProjectSourcePath, isPathInside,
    safeRealpath, formatSourceBlockSymbols, mergeLineWindows, formatSourceWindows, compareGeneratedFileOrder,
    isGeneratedFilePath, languageForFile, buildSourceBlocks, scoreSourceFileGroupForQuery,
    scorePreferredSourceFileGroupForQuery, maxNumericScore, queryMentionsTests, isLowValueSourcePath,
    isTestLikeLowValueSourcePath, queryMentionsLowValueSourcePathExplicitly,
  });
}
