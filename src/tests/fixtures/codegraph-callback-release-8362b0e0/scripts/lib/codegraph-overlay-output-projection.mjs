let formatNativeMarkdownDelegate;
let formatStrictNativeMarkdownDelegate;
let toNativeJsonFormatterResponseDelegate;
let installed = false;
function installedDelegate(value, delegateName, installerName) {
  if (!value) throw new Error(`${delegateName} requires ${installerName}() before use`);
  return value;
}
export function formatNativeMarkdownImpl(...values) { return installedDelegate(formatNativeMarkdownDelegate, 'formatNativeMarkdownImpl', 'installOutputProjection')(...values); }
export function formatStrictNativeMarkdownImpl(...values) { return installedDelegate(formatStrictNativeMarkdownDelegate, 'formatStrictNativeMarkdownImpl', 'installOutputProjection')(...values); }
export function toNativeJsonFormatterResponseImpl(...values) { return installedDelegate(toNativeJsonFormatterResponseDelegate, 'toNativeJsonFormatterResponseImpl', 'installOutputProjection')(...values); }

export function installOutputProjection(runtime) {
  if (installed) throw new Error('installOutputProjection() may only be called once');
  installed = true;
  const {
    path, buildBaseline, MAX_MARKDOWN_OUTPUT_CHARS, NATIVE_CONTEXT_CODE_BLOCK_LIMIT
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    dedupeNodeByDisplay = call('dedupeNodeByDisplay'), isMixedExactMetadataQueryTerm = call('isMixedExactMetadataQueryTerm'), omitUndefined = call('omitUndefined'),
    queryTokens = call('queryTokens'), scorePathTermMatch = call('scorePathTermMatch'), queryScoringContext = call('queryScoringContext'),
    scoreNodeRelevanceForQuery = call('scoreNodeRelevanceForQuery'), orderRelatedFilesForQuery = call('orderRelatedFilesForQuery'), lowInformationNodePenalty = call('lowInformationNodePenalty'),
    filterRelationshipGroupsForMarkdown = call('filterRelationshipGroupsForMarkdown'), compareNode = call('compareNode'), formatSummary = call('formatSummary'),
    highValueRank = call('highValueRank'), compareNodeSourceOrder = call('compareNodeSourceOrder'), buildSourceBlocks = call('buildSourceBlocks'),
    compareGeneratedFileOrder = call('compareGeneratedFileOrder'), isGeneratedFilePath = call('isGeneratedFilePath');

  function formatNativeMarkdown(response, sourceBlocks = buildSourceBlocks(response.root, response.nodes, getExploreOutputBudget(response.coverage?.typescriptFiles ?? response.nodes.length), response.query)) {
    return formatNanoFlowAugmentedMarkdown(response, sourceBlocks);
  }

  function formatNanoFlowAugmentedMarkdown(response, sourceBlocks = buildSourceBlocks(response.root, response.nodes, getExploreOutputBudget(response.coverage?.typescriptFiles ?? response.nodes.length), response.query)) {
    const files = new Set(response.nodes.map(node => node.filePath).filter(Boolean));
    const fileCount = response.coverage?.typescriptFiles ?? files.size;
    const outputBudget = getExploreOutputBudget(fileCount);
    const lines = [
      `## Exploration: ${response.query}`,
      '',
      `Found ${response.nodes.length} symbols across ${files.size} files.`,
      '',
    ];

    if (response.blastRadius?.length) {
      lines.push('### Blast radius — what depends on these (update/verify before editing)', '');
      for (const entry of response.blastRadius) {
        const shownFiles = formatInlineFileList(entry.callerFiles, 4);
        const where = entry.callerFiles.length > 0 ? ` in ${shownFiles}` : '';
        const tests = entry.testFiles.length > 0
          ? `; tests: ${formatInlineFileList(entry.testFiles, 4)}`
          : '; ⚠️ no covering tests found';
        lines.push(`- \`${entry.name}\` (${entry.filePath}:${entry.line ?? '?'}) — ${entry.callerCount} caller${entry.callerCount === 1 ? '' : 's'}${where}${tests}`);
      }
      lines.push('');
    }

    const relationshipEntries = Object.entries(filterRelationshipGroupsForMarkdown(response.relationshipGroups, response.query));
    const showRelationships = outputBudget.includeRelationships || isExactRelationshipQuery(response.relationshipGroups, response.query);
    if (showRelationships && relationshipEntries.length > 0) {
      lines.push('### Relationships', '');
      for (const [kind, edges] of relationshipEntries) {
        lines.push(`**${kind}:**`);
        const cap = outputBudget.maxEdgesPerRelationshipKind;
        for (const edge of edges.slice(0, cap)) {
          const suffix = formatEdgeMetadata(edge);
          lines.push(`- ${edge.source} → ${edge.target}${suffix}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    if (sourceBlocks.length > 0) {
      lines.push('### Source Code');
      lines.push('');
      lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
      lines.push('');
      for (const block of sourceBlocks) {
        const headerSuffix = block.symbols ? ` — ${block.symbols}` : '';
        lines.push(`#### ${block.filePath}${headerSuffix}`);
        lines.push('');
        lines.push(`\`\`\`${block.language}`);
        lines.push(block.source);
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('### Related Symbols', '');
    for (const [filePath, nodes] of groupMarkdownRelatedNodesByFile(response.nodes)) {
      const symbols = nodes
        .map(node => `${node.name}${node.startLine ? `:${node.startLine}` : ''}`)
        .join(', ');
      lines.push(`- ${filePath}: ${symbols}`);
    }

    if (outputBudget.includeAdditionalFiles && response.notShown?.length) {
      lines.push('### Not shown above — explore these names for their source');
      lines.push('');
      for (const entry of response.notShown) {
        lines.push(`- ${entry.filePath}: ${entry.symbols.join(', ')}`);
      }
      lines.push('');
    }

    if (outputBudget.includeCompletenessSignal && sourceBlocks.length > 0) {
      lines.push('---');
      lines.push(`> **Complete source for ${sourceBlocks.length} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`);
      lines.push('');
    }

    if (outputBudget.includeBudgetNote) {
      lines.push(`> **Explore budget: ${getExploreBudget(fileCount)} calls for this project (${fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${getExploreBudget(fileCount)}.`);
      lines.push('');
    }

    lines.push('');
    lines.push('### NanoFlow Coverage', '');
    for (const [name, count] of Object.entries(response.coverage)) {
      lines.push(`- ${name}: ${count}`);
    }

    return truncateMarkdownOutput(lines.join('\n'), outputBudget.maxOutputChars);
  }

  function formatStrictNativeMarkdown(context) {
    const lines = [];
    lines.push('## Code Context\n');
    lines.push(`**Query:** ${context.query}\n`);

    const orderedEntries = orderNativeProjectionItems(context.entryPoints, context.query);
    lines.push('### Entry Points\n');
    if (orderedEntries.length === 0) {
      lines.push('- No entry points found.');
    } else {
      for (const node of orderedEntries) {
        const location = formatStrictNativeLocation(node.filePath, node.startLine);
        lines.push(`- **${node.name}** (${node.kind}) - ${location}`);
        if (node.signature) {
          lines.push(`  \`${node.signature}\``);
        }
      }
    }
    lines.push('');

    const relationshipGroups = buildStrictNativeMarkdownRelationshipGroups(context.nodes, context.edges);
    lines.push('### Relationships\n');
    if (relationshipGroups.length === 0) {
      lines.push('- No relationships found.');
      lines.push('');
    } else {
      for (const [kind, edges] of relationshipGroups) {
        lines.push(`**${kind}:**`);
        for (const edge of edges) {
          lines.push(`- ${edge.source} -> ${edge.target}${formatStrictNativeEdgeLocation(edge)}`);
        }
        lines.push('');
      }
    }

    const entryIds = new Set(context.entryPoints.map(node => node.id));
    const allOtherSymbols = orderNativeProjectionItems(context.nodes
      .filter(node => !entryIds.has(node.id))
      .filter(node => node.kind !== 'file')
      .filter(node => !isGeneratedFilePath(node.filePath))
      .filter(dedupeNodeByDisplay()), context.query);
    const otherSymbols = allOtherSymbols.slice(0, 10);
    const omittedRelatedSymbolCount = Math.max(0, allOtherSymbols.length - otherSymbols.length);

    lines.push('### Related Symbols\n');
    const byFile = new Map();
    for (const node of otherSymbols) {
      const existing = byFile.get(node.filePath) ?? [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    if (otherSymbols.length === 0) {
      lines.push('- No related symbols found.');
    } else {
      for (const [file, nodes] of byFile) {
        const nodeList = [...nodes]
          .sort(compareStrictNativeRelatedNodeOrder)
          .map(formatStrictNativeRelatedSymbol)
          .join(', ');
        lines.push(`- ${formatStrictNativeFilePath(file)}: ${nodeList}`);
      }
      if (omittedRelatedSymbolCount > 0) {
        lines.push(`- +${omittedRelatedSymbolCount} more related symbols omitted by native Markdown budget.`);
      }
    }
    lines.push('');

    const orderedBlocks = orderNativeProjectionItems(context.codeBlocks, context.query, {
      preserveExactRelationEvidence: true,
    });
    lines.push('### Code\n');
    if (orderedBlocks.length === 0) {
      lines.push('- No code blocks found.');
    } else {
      for (const block of orderedBlocks) {
        const nodeName = block.nodeName ?? 'Unknown';
        lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})\n`);
        lines.push(`\`\`\`${block.language}`);
        lines.push(block.content);
        lines.push('```\n');
      }
      if (strictNativeCodeBlockBudgetReached(context, orderedBlocks)) {
        lines.push('- Code block budget reached; additional matching nodes may have omitted source.');
      }
    }

    return lines.join('\n');
  }

  function strictNativeCodeBlockBudgetReached(context, orderedBlocks) {
    return orderedBlocks.length >= NATIVE_CONTEXT_CODE_BLOCK_LIMIT
      && context.nodes.length > orderedBlocks.length;
  }

  function buildStrictNativeMarkdownRelationshipGroups(nodes, edges) {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const selectedIds = new Set(nodeById.keys());
    const seen = new Set();
    const grouped = new Map();
    for (const edge of edges) {
      if (!selectedIds.has(edge.source) || !selectedIds.has(edge.target)) {
        continue;
      }
      const nativeEdge = {
        kind: String(edge.kind ?? 'related'),
        source: strictNativeEdgeEndpointName(nodeById.get(edge.source), edge.source),
        target: strictNativeEdgeEndpointName(nodeById.get(edge.target), edge.target),
        line: nativeJsonEdgeLine(edge),
        column: nativeJsonEdgeColumn(edge),
      };
      const key = JSON.stringify(nativeEdge);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const group = grouped.get(nativeEdge.kind) ?? [];
      group.push(nativeEdge);
      grouped.set(nativeEdge.kind, group);
    }

    return [...grouped.entries()]
      .sort(([leftKind], [rightKind]) => leftKind.localeCompare(rightKind))
      .map(([kind, group]) => [
        kind,
        group.sort(compareStrictNativeMarkdownEdges).slice(0, 20),
      ]);
  }

  function strictNativeEdgeEndpointName(node, fallback) {
    return String(node?.qualifiedName ?? node?.name ?? fallback ?? '(unknown)');
  }

  function compareStrictNativeMarkdownEdges(a, b) {
    return a.source.localeCompare(b.source)
      || a.target.localeCompare(b.target)
      || compareNullableSourceLine(a.line, b.line)
      || compareNullableSourceLine(a.column, b.column);
  }

  function formatStrictNativeEdgeLocation(edge) {
    const parts = [];
    if (displayLineNumber(edge.line)) {
      parts.push(`line ${edge.line}`);
    }
    if (displayLineNumber(edge.column)) {
      parts.push(`column ${edge.column}`);
    }
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  }

  function orderNativeProjectionItems(items, rawQuery = '', options = {}) {
    const context = queryScoringContext(rawQuery);
    if (options.preserveExactRelationEvidence && isPureExactRelationProjectionQuery(context)) {
      return items;
    }
    const scored = items.map((item, index) => ({
      item,
      index,
      ...scoreNativeProjectionItemForQuery(item, context),
    }));
    const hasRelevanceScore = !isPureExactRelationProjectionQuery(context)
      && scored.some(entry => (
      entry.explicitScore > 0
      || entry.pathScore > 0
      || entry.coreScore > 0
      || entry.fullScore > 0
    ));
    return scored
      .sort((a, b) => (
        (hasRelevanceScore ? compareNativeProjectionRelevance(a, b) : 0)
        || a.lowInformationPenalty - b.lowInformationPenalty
        || compareGeneratedFileOrder(a.item, b.item)
        || a.index - b.index
      ))
      .map(entry => entry.item);
  }

  function isPureExactRelationProjectionQuery(context) {
    return context.queryTerms.length === 1
      && context.explicitTerms.length === 0
      && isMixedExactMetadataQueryTerm(context.queryTerms[0]);
  }

  function scoreNativeProjectionItemForQuery(item, context) {
    const node = nativeProjectionItemNode(item);
    return {
      node,
      pathScore: scorePathTermMatch(node?.filePath, context.queryTerms),
      lowInformationPenalty: lowInformationNodePenalty(node, context.query),
      ...scoreNodeRelevanceForQuery(node, context),
    };
  }

  function compareNativeProjectionRelevance(a, b) {
    return b.explicitScore - a.explicitScore
      || b.pathScore - a.pathScore
      || b.coreScore - a.coreScore
      || highValueRank(b.node) - highValueRank(a.node)
      || a.lowInformationPenalty - b.lowInformationPenalty
      || b.fullScore - a.fullScore;
  }

  function nativeProjectionItemNode(item) {
    if (
      item?.name !== undefined
      || item?.qualifiedName !== undefined
      || item?.kind !== undefined
    ) {
      return item;
    }
    return {
      id: item?.id,
      kind: item?.nodeKind,
      name: item?.nodeName,
      qualifiedName: item?.nodeName,
      filePath: item?.filePath,
      language: item?.language,
      startLine: item?.startLine,
      endLine: item?.endLine,
    };
  }

  function formatStrictNativeRelatedSymbol(node) {
    const line = displayLineNumber(node.startLine);
    return line ? `${node.name}:${line}` : String(node.name);
  }

  function compareStrictNativeRelatedNodeOrder(a, b) {
    return compareNullableSourceLine(a?.startLine, b?.startLine)
      || compareNullableSourceLine(a?.endLine, b?.endLine)
      || String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
      || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  }

  function compareNullableSourceLine(a, b) {
    const aLine = displayLineNumber(a) ?? Number.MAX_SAFE_INTEGER;
    const bLine = displayLineNumber(b) ?? Number.MAX_SAFE_INTEGER;
    return aLine - bLine;
  }

  function formatStrictNativeLocation(filePath, lineNumber) {
    const line = displayLineNumber(lineNumber);
    const file = formatStrictNativeFilePath(filePath);
    return line ? `${file}:${line}` : file;
  }

  function formatStrictNativeFilePath(filePath) {
    return String(filePath ?? '').trim() || '(unknown)';
  }

  function displayLineNumber(value) {
    return Number.isInteger(value) && value >= 1 ? value : null;
  }


  function toNativeJsonFormatterResponse(context) {
    const orderedEntryPoints = orderNativeProjectionItems(context.entryPoints, context.query);
    const nodes = orderNativeProjectionItems(context.nodes, context.query);
    const nodeIds = new Set(nodes.map(node => node.id));
    const closedEdges = context.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    const orderedCodeBlocks = orderNativeProjectionItems(context.codeBlocks, context.query, {
      preserveExactRelationEvidence: true,
    });
    const relatedFiles = orderRelatedFilesForQuery(unique([
      ...orderedCodeBlocks.map(block => block.filePath).filter(Boolean),
      ...context.relatedFiles,
    ]), context.query);
    const codeBlocks = orderedCodeBlocks.map(serializeNativeJsonCodeBlock);
    return {
      query: context.query,
      summary: formatSummary(nodes, relatedFiles),
      entryPoints: orderedEntryPoints.map(serializeNativeJsonNode),
      nodes: nodes.map(serializeNativeJsonNode),
      edges: closedEdges.map(serializeNativeJsonEdge),
      codeBlocks,
      relatedFiles,
      stats: {
        ...context.stats,
        nodeCount: nodes.length,
        edgeCount: closedEdges.length,
        fileCount: relatedFiles.length,
        codeBlockCount: codeBlocks.length,
        totalCodeSize: codeBlocks.reduce((total, block) => total + block.content.length, 0),
      },
    };
  }

  function serializeNativeJsonNode(node) {
    return omitUndefined({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine,
      endLine: node.endLine,
      startColumn: node.startColumn,
      endColumn: node.endColumn,
      signature: node.signature,
      docstring: node.docstring,
      visibility: node.visibility,
      isExported: node.isExported,
      isAsync: node.isAsync,
      isStatic: node.isStatic,
      isAbstract: node.isAbstract,
    });
  }

  function serializeNativeJsonEdge(edge) {
    return omitUndefined({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      line: nativeJsonEdgeLine(edge),
      column: nativeJsonEdgeColumn(edge),
    });
  }

  function nativeJsonEdgeLine(edge) {
    if (Number.isInteger(edge?.line)) return edge.line;
    return undefined;
  }

  function nativeJsonEdgeColumn(edge) {
    if (Number.isInteger(edge?.column)) return edge.column;
    return undefined;
  }

  function serializeNativeJsonCodeBlock(block) {
    return omitUndefined({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      language: block.language,
      content: block.content,
      nodeName: block.nodeName,
      nodeKind: block.nodeKind,
    });
  }

  function getExploreOutputBudget(fileCount) {
    if (fileCount < 150) {
      return {
        maxOutputChars: 13_000,
        defaultMaxFiles: 4,
        maxCharsPerFile: 3_800,
        gapThreshold: 7,
        maxSymbolsInFileHeader: 5,
        maxEdgesPerRelationshipKind: 4,
        includeRelationships: false,
        includeAdditionalFiles: false,
        includeCompletenessSignal: false,
        includeBudgetNote: false,
        excludeLowValueFiles: true,
      };
    }
    if (fileCount < 500) {
      return {
        maxOutputChars: 18_000,
        defaultMaxFiles: 5,
        maxCharsPerFile: 3_800,
        gapThreshold: 8,
        maxSymbolsInFileHeader: 6,
        maxEdgesPerRelationshipKind: 6,
        includeRelationships: false,
        includeAdditionalFiles: false,
        includeCompletenessSignal: false,
        includeBudgetNote: false,
        excludeLowValueFiles: true,
      };
    }
    if (fileCount < 5000) {
      return {
        maxOutputChars: 24_000,
        defaultMaxFiles: 8,
        maxCharsPerFile: 6_500,
        gapThreshold: 12,
        maxSymbolsInFileHeader: 10,
        maxEdgesPerRelationshipKind: 10,
        includeRelationships: true,
        includeAdditionalFiles: true,
        includeCompletenessSignal: true,
        includeBudgetNote: true,
        excludeLowValueFiles: false,
      };
    }
    if (fileCount < 15000) {
      return {
        maxOutputChars: 24_000,
        defaultMaxFiles: 8,
        maxCharsPerFile: 7_000,
        gapThreshold: 15,
        maxSymbolsInFileHeader: 15,
        maxEdgesPerRelationshipKind: 15,
        includeRelationships: true,
        includeAdditionalFiles: true,
        includeCompletenessSignal: true,
        includeBudgetNote: true,
        excludeLowValueFiles: false,
      };
    }
    return {
      maxOutputChars: 24_000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 7_000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }

  function formatInlineFileList(filePaths, cap) {
    const shown = filePaths.slice(0, cap).map(filePath => `\`${filePath}\``).join(', ');
    const omitted = filePaths.length - cap;
    return omitted > 0 ? `${shown} +${omitted} more` : shown;
  }

  function isExactRelationshipQuery(groups, rawQuery) {
    const query = String(rawQuery ?? '').toLowerCase();
    if (!query) return false;
    const exactQueries = new Set([
      query,
      ...queryTokens(query).filter(isMixedExactMetadataQueryTerm),
    ]);
    return Object.values(groups ?? {}).some(edges => (edges ?? []).some(edge => (
      exactQueries.has(String(edge.relation ?? '').toLowerCase())
      || exactQueries.has(String(edge.synthesizedBy ?? '').toLowerCase())
      || exactQueries.has(String(edge.bindingKind ?? '').toLowerCase())
      || exactQueries.has(String(edge.testMapping ?? '').toLowerCase())
      || exactQueries.has(String(edge.keywordMapping ?? '').toLowerCase())
      || [...exactQueries].some(exactQuery => isQueriedRelationshipEvidence(edge, exactQuery))
    )));
  }

  function isQueriedRelationshipEvidence(edge, query) {
    if (!isHardRuleEvidenceRelation(edge?.relation)) return false;
    const normalizedQuery = normalizeRelationshipEvidenceValue(query);
    return [
      edge.keyword,
      edge.matchedNeedle,
      edge.call,
    ].some(value => normalizeRelationshipEvidenceValue(value) === normalizedQuery);
  }

  function normalizeRelationshipEvidenceValue(value) {
    return String(value ?? '').toLowerCase().replace(/\(\)$/, '');
  }

  function isHardRuleEvidenceRelation(relation) {
    return relation === 'hard-rule-implementation' || relation === 'hard-rule-test-evidence';
  }

  function getExploreBudget(fileCount) {
    if (fileCount < 500) return 1;
    if (fileCount < 5000) return 2;
    if (fileCount < 15000) return 3;
    if (fileCount < 25000) return 4;
    return 5;
  }

  function truncateMarkdownOutput(markdown, maxChars = MAX_MARKDOWN_OUTPUT_CHARS) {
    if (markdown.length <= maxChars) return markdown;
    const cut = markdown.slice(0, maxChars);
    const lastSection = cut.lastIndexOf('\n#### ');
    const boundary = lastSection > maxChars * 0.5 ? lastSection : cut.lastIndexOf('\n');
    const safe = boundary > 0 ? cut.slice(0, boundary) : cut;
    return `${safe}\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another codegraph_explore with the specific names — do NOT Read these files.)`;
  }

  function formatEdgeMetadata(edge) {
    const ignored = new Set(['source', 'target']);
    const entries = Object.entries(edge).filter(([key, value]) => !ignored.has(key) && value !== undefined);
    if (entries.length === 0) return '';
    return ` (${entries.map(([key, value]) => `${key}: ${value}`).join(', ')})`;
  }

  function groupNodesByFile(nodes) {
    const groups = new Map();
    for (const node of nodes) {
      const filePath = node.filePath || '(unknown)';
      const group = groups.get(filePath) ?? [];
      group.push(node);
      groups.set(filePath, group);
    }
    return [...groups.entries()]
      .map(([filePath, group]) => [filePath, group.sort(compareNode)]);
  }

  function groupMarkdownRelatedNodesByFile(nodes) {
    const groups = new Map();
    const seenDisplayKeys = new Set();
    const sortedNodes = nodes
      .filter(node => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
      .filter(node => {
        const key = markdownRelatedSymbolKey(node);
        if (seenDisplayKeys.has(key)) return false;
        seenDisplayKeys.add(key);
        return true;
      });
    for (const node of sortedNodes) {
      const filePath = node.filePath || '(unknown)';
      const group = groups.get(filePath) ?? [];
      group.push(node);
      groups.set(filePath, group);
    }
    return [...groups.entries()]
      .map(([filePath, group]) => [filePath, group.sort(compareNodeSourceOrder)]);
  }

  function markdownRelatedSymbolKey(node) {
    return [
      node?.filePath ?? '',
      node?.name ?? '',
      node?.startLine ?? '',
    ].join('\0');
  }


  function summarizeOverlayCoverage(overlay) {
    const baseline = buildBaseline(overlay);
    return {
      typescriptFiles: overlay.typescript?.files?.length ?? 0,
      typescriptClasses: overlay.typescript?.classes?.length ?? 0,
      typescriptFunctions: overlay.typescript?.functions?.length ?? 0,
      typescriptInterfaces: overlay.typescript?.interfaces?.length ?? 0,
      typescriptTypeAliases: overlay.typescript?.types?.length ?? 0,
      typescriptConstants: overlay.typescript?.variables?.filter(variable => variable.isConst).length ?? 0,
      typescriptVariables: overlay.typescript?.variables?.filter(variable => !variable.isConst).length ?? 0,
      typescriptEnums: overlay.typescript?.enums?.length ?? 0,
      typescriptNamespaces: overlay.typescript?.namespaces?.length ?? 0,
      typescriptImports: overlay.typescript?.imports?.length ?? 0,
      typescriptExports: overlay.typescript?.exports?.length ?? 0,
      typescriptParameters: overlay.graph?.nodes?.filter(node => node.kind === 'parameter').length ?? 0,
      components: overlay.angular?.components?.length ?? 0,
      directives: overlay.angular?.directives?.length ?? 0,
      pipes: overlay.angular?.pipes?.length ?? 0,
      injectables: overlay.angular?.injectables?.length ?? 0,
      injectors: overlay.angular?.injectors?.length ?? 0,
      dynamicImports: overlay.angular?.dynamicImports?.length ?? 0,
      routes: overlay.angular?.routes?.length ?? 0,
      edgeFunctions: overlay.supabase?.edgeFunctions?.length ?? 0,
      migrations: overlay.supabase?.migrations?.length ?? 0,
      androidFiles: overlay.android?.files?.length ?? 0,
      androidKotlinClasses: overlay.android?.kotlinClasses?.length ?? 0,
      androidKotlinDataClasses: (overlay.android?.kotlinClasses ?? [])
        .filter(kotlinClass => kotlinClass.modifiers?.includes('data')).length,
      androidKotlinSealedClasses: (overlay.android?.kotlinClasses ?? [])
        .filter(kotlinClass => kotlinClass.modifiers?.includes('sealed')).length,
      androidKotlinInterfaces: (overlay.android?.kotlinClasses ?? [])
        .filter(kotlinClass => kotlinClass.classKind === 'interface').length,
      androidKotlinObjects: (overlay.android?.kotlinClasses ?? [])
        .filter(kotlinClass => kotlinClass.classKind === 'object' && !kotlinClass.isCompanionObject).length,
      androidKotlinCompanionObjects: (overlay.android?.kotlinClasses ?? [])
        .filter(kotlinClass => kotlinClass.isCompanionObject).length,
      androidKotlinEnums: overlay.android?.kotlinEnums?.length ?? 0,
      androidKotlinEnumMembers: (overlay.android?.kotlinEnums ?? [])
        .flatMap(kotlinEnum => kotlinEnum.members ?? []).length,
      androidKotlinImports: overlay.android?.kotlinImports?.length ?? 0,
      androidKotlinConstructors: overlay.android?.kotlinConstructors?.length ?? 0,
      androidKotlinProperties: overlay.android?.kotlinProperties?.length ?? 0,
      androidKotlinMethods: overlay.android?.kotlinMethods?.length ?? 0,
      androidKotlinFunctions: overlay.android?.kotlinFunctions?.length ?? 0,
      androidKotlinFunctionEdges: countGraphEdgesByRelation(overlay, 'android-kotlin-function'),
      androidKotlinCalls: overlay.android?.kotlinCalls?.length ?? 0,
      androidKotlinAnnotations: countAndroidKotlinAnnotations(overlay.android),
      androidManifestComponents: overlay.android?.manifestComponents?.length ?? 0,
      androidManifestPermissions: baseline.androidManifestPermissions,
      androidManifestUsesPermissionEdges: baseline.androidManifestUsesPermissionEdges,
      androidManifestQueries: baseline.androidManifestQueries,
      androidManifestQueryEdges: baseline.androidManifestQueryEdges,
      androidManifestComponentPermissions: baseline.androidManifestComponentPermissions,
      androidManifestComponentPermissionEdges: baseline.androidManifestComponentPermissionEdges,
      androidManifestIntentFilters: baseline.androidManifestIntentFilters,
      androidManifestIntentFilterActions: baseline.androidManifestIntentFilterActions,
      androidManifestIntentFilterActionEdges: baseline.androidManifestIntentFilterActionEdges,
      androidManifestIntentFilterCategories: baseline.androidManifestIntentFilterCategories,
      androidManifestIntentFilterCategoryEdges: baseline.androidManifestIntentFilterCategoryEdges,
      androidManifestIntentFilterData: baseline.androidManifestIntentFilterData,
      androidManifestIntentFilterDataEdges: baseline.androidManifestIntentFilterDataEdges,
      androidWidgetProviders: overlay.android?.widgetProviders?.length ?? 0,
      androidResourceReferences: overlay.android?.resourceReferences?.length ?? 0,
      androidKotlinResourceReferences: baseline.androidKotlinResourceReferences,
      androidKotlinResourceReferenceEdges: baseline.androidKotlinResourceReferenceEdges,
      hardRules: overlay.agentRules?.hardRules?.length ?? 0,
      context7Docs: overlay.context7?.documents?.length ?? 0,
      context7Categories: overlay.context7?.categories?.length ?? 0,
      context7CategoryDocEdges: baseline.context7CategoryDocEdges,
      context7RetrievalRoutes: overlay.context7?.retrievalRoutes?.length ?? 0,
      context7RetrievalPrimaryEdges: baseline.context7RetrievalPrimaryEdges,
      context7RetrievalSecondaryEdges: baseline.context7RetrievalSecondaryEdges,
      context7SourceMapRoutes: overlay.context7?.sourceMapRoutes?.length ?? 0,
      context7SourceMapDocEdges: baseline.context7SourceMapDocEdges,
      context7SourceMapSourceEdges: baseline.context7SourceMapSourceEdges,
      graphNodes: overlay.graph?.nodes?.length ?? 0,
      graphEdges: overlay.graph?.edges?.length ?? 0,
    };
  }

  function countGraphEdgesByRelation(overlay, relation) {
    return overlay.graph?.edges?.filter(edge => edge.metadata?.relation === relation).length ?? 0;
  }

  function countAndroidKotlinAnnotations(android) {
    return [
      ...(android?.kotlinClasses ?? []),
      ...(android?.kotlinEnums ?? []),
      ...(android?.kotlinConstructors ?? []),
      ...(android?.kotlinProperties ?? []),
      ...(android?.kotlinMethods ?? []),
    ].flatMap(item => item?.annotations ?? []).length;
  }

  function toPosix(value) {
    return value.split(path.sep).join('/');
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function uniqueBy(values, keyFn) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const key = keyFn(value);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
    return result;
  }

  function isTestFile(filePath) {
    return typeof filePath === 'string'
      && (/(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(filePath)
        || /\.(test|spec)\.[a-z]+$/i.test(filePath));
  }

  formatNativeMarkdownDelegate = formatNativeMarkdown;
  formatStrictNativeMarkdownDelegate = formatStrictNativeMarkdown;
  toNativeJsonFormatterResponseDelegate = toNativeJsonFormatterResponse;
  Object.assign(runtime, {
    formatNativeMarkdown, formatNanoFlowAugmentedMarkdown, formatStrictNativeMarkdown, strictNativeCodeBlockBudgetReached, buildStrictNativeMarkdownRelationshipGroups,
    strictNativeEdgeEndpointName, compareStrictNativeMarkdownEdges, formatStrictNativeEdgeLocation, orderNativeProjectionItems, isPureExactRelationProjectionQuery,
    scoreNativeProjectionItemForQuery, compareNativeProjectionRelevance, nativeProjectionItemNode, formatStrictNativeRelatedSymbol, compareStrictNativeRelatedNodeOrder,
    compareNullableSourceLine, formatStrictNativeLocation, formatStrictNativeFilePath, displayLineNumber, toNativeJsonFormatterResponse,
    serializeNativeJsonNode, serializeNativeJsonEdge, nativeJsonEdgeLine, nativeJsonEdgeColumn, serializeNativeJsonCodeBlock,
    getExploreOutputBudget, formatInlineFileList, isExactRelationshipQuery, isQueriedRelationshipEvidence, normalizeRelationshipEvidenceValue,
    isHardRuleEvidenceRelation, getExploreBudget, truncateMarkdownOutput, formatEdgeMetadata,
    groupNodesByFile, groupMarkdownRelatedNodesByFile, markdownRelatedSymbolKey, summarizeOverlayCoverage, countGraphEdgesByRelation,
    countAndroidKotlinAnnotations, toPosix, unique, uniqueBy, isTestFile,
  });
}
