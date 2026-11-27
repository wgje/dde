let resolveNativeCodeBlockNodeDelegate;
let installed = false;
function installedDelegate(value, delegateName, installerName) {
  if (!value) throw new Error(`${delegateName} requires ${installerName}() before use`);
  return value;
}
export function resolveNativeCodeBlockNodeImpl(...values) { return installedDelegate(resolveNativeCodeBlockNodeDelegate, 'resolveNativeCodeBlockNodeImpl', 'installNativeCodeblockEvidence')(...values); }

export function installNativeCodeblockEvidence(runtime) {
  if (installed) throw new Error('installNativeCodeblockEvidence() may only be called once');
  installed = true;
  const {
    fs, NATIVE_CONTEXT_CODE_BLOCK_SIZE, SQL_STATEMENT_NODE_RELATIONS, SQL_STATEMENT_EDGE_RELATIONS
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    provenanceEdgeLineRelationByQuery = call('provenanceEdgeLineRelationByQuery'), relationPolicySet = call('relationPolicySet'), normalizeExactRelationQuery = call('normalizeExactRelationQuery'),
    isHardRuleEvidenceRelation = call('isHardRuleEvidenceRelation'), resolveProjectSourcePath = call('resolveProjectSourcePath'), languageForFile = call('languageForFile');

  function resolveNativeCodeBlockNode(projectRoot, node, nodes) {
    const edgeFunctionNode = resolveSupabaseEdgeFunctionCodeBlockNode(projectRoot, node);
    if (edgeFunctionNode) {
      return edgeFunctionNode;
    }

    if (node?.kind !== 'component' || !node.filePath || !node.name) {
      return node;
    }
    const selectedClassNode = nodes.find(candidate => (
      candidate.kind === 'class'
      && candidate.filePath === node.filePath
      && candidate.name === node.name
      && (candidate.endLine ?? candidate.startLine ?? 0) > (node.endLine ?? node.startLine ?? 0)
    ));
    return selectedClassNode ?? resolveSameFileClassCodeBlockNode(projectRoot, node) ?? node;
  }

  function resolveSupabaseEdgeFunctionCodeBlockNode(projectRoot, node) {
    if (
      node?.kind !== 'function'
      || !node.filePath
      || !node.filePath.startsWith('supabase/functions/')
      || !node.filePath.endsWith('/index.ts')
    ) {
      return null;
    }
    const absolutePath = resolveProjectSourcePath(projectRoot, node.filePath);
    if (!absolutePath) return null;

    const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    const serveIndex = sourceLines.findIndex(line => /\b(?:Deno\.)?serve\s*\(/.test(line));
    if (serveIndex < 0) return null;
    const serveEndLine = findBlockEndLine(sourceLines, serveIndex);
    const delegatedHandlerIndex = findDelegatedEdgeFunctionHandlerIndex(sourceLines, serveIndex, serveEndLine);
    if (delegatedHandlerIndex >= 0) {
      return {
        ...node,
        id: `${node.id}:edge-function-handler-code-block`,
        startLine: delegatedHandlerIndex + 1,
        endLine: findBlockEndLine(sourceLines, delegatedHandlerIndex),
      };
    }
    return {
      ...node,
      id: `${node.id}:edge-function-code-block`,
      startLine: serveIndex + 1,
      endLine: serveEndLine,
    };
  }

  function findDelegatedEdgeFunctionHandlerIndex(sourceLines, serveIndex, serveEndLine) {
    const delegatedFunctionName = findDelegatedEdgeFunctionHandlerName(sourceLines, serveIndex, serveEndLine);
    if (!delegatedFunctionName) return -1;
    const declarationPattern = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(delegatedFunctionName)}\\s*\\(`);
    const constFunctionPattern = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(delegatedFunctionName)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`);
    return sourceLines.findIndex(line => declarationPattern.test(line) || constFunctionPattern.test(line));
  }

  function findDelegatedEdgeFunctionHandlerName(sourceLines, serveIndex, serveEndLine) {
    const startIndex = Math.max(0, serveIndex);
    const endIndex = Math.min(sourceLines.length, Math.max(serveIndex + 1, serveEndLine));
    for (let index = startIndex; index < endIndex; index += 1) {
      const match = /\breturn\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\b/.exec(sourceLines[index]);
      if (match?.[1]) return match[1];
    }
    return '';
  }

  function resolveSameFileClassCodeBlockNode(projectRoot, componentNode) {
    const absolutePath = resolveProjectSourcePath(projectRoot, componentNode.filePath);
    if (!absolutePath) return null;

    const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    const classPattern = new RegExp(`\\bclass\\s+${escapeRegExp(componentNode.name)}\\b`);
    const classIndex = sourceLines.findIndex((line, index) =>
      index + 1 >= (componentNode.startLine ?? 1) && classPattern.test(line));
    if (classIndex < 0) return null;

    return {
      ...componentNode,
      id: `${componentNode.id}:class-code-block`,
      kind: 'class',
      startLine: classIndex + 1,
      endLine: findBlockEndLine(sourceLines, classIndex),
    };
  }

  function findBlockEndLine(sourceLines, startIndex) {
    let depth = 0;
    let hasOpened = false;
    for (let index = startIndex; index < sourceLines.length; index++) {
      const line = sourceLines[index];
      for (const char of line) {
        if (char === '{') {
          depth++;
          hasOpened = true;
        } else if (char === '}' && hasOpened) {
          depth--;
          if (depth <= 0) return index + 1;
        }
      }
    }
    return startIndex + 1;
  }

  function findAngularArrayMetadataStartLine(sourceLines, edgeLine, propertyName) {
    const propertyPattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`);
    for (let index = Math.max(0, edgeLine - 1); index >= 0; index -= 1) {
      const line = sourceLines[index];
      if (propertyPattern.test(line)) return index + 1;
      if (/^\s*@(?:Component|Directive)\s*\(\s*\{/.test(line)) break;
    }
    return null;
  }

  function findAngularArrayMetadataEndLine(sourceLines, startLine, propertyName) {
    const startIndex = Math.max(0, startLine - 1);
    const propertyPattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`);
    let bracketDepth = 0;
    let hasOpened = false;

    for (let index = startIndex; index < sourceLines.length; index += 1) {
      const line = sourceLines[index];
      if (!hasOpened && !propertyPattern.test(line)) continue;
      for (const char of line) {
        if (char === '[') {
          bracketDepth += 1;
          hasOpened = true;
        } else if (char === ']' && hasOpened) {
          bracketDepth -= 1;
          if (bracketDepth <= 0) return index + 1;
        }
      }
      if (hasOpened && bracketDepth <= 0) return index + 1;
    }

    return startLine;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function readNodeCodeBlock(projectRoot, node) {
    if (!node?.filePath || node.filePath === '(unknown)') return null;
    const absolutePath = resolveProjectSourcePath(projectRoot, node.filePath);
    if (!absolutePath) return null;

    const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    const declaredStartLine = Math.max(1, node.startLine ?? 1);
    const startLine = resolveNodeCodeBlockStartLine(sourceLines, node, declaredStartLine);
    const defaultEndLine = node.kind === 'file' ? sourceLines.length : startLine;
    const nodeEndLine = resolveNodeCodeBlockEndLine(sourceLines, node, startLine, defaultEndLine);
    const endLine = Math.max(startLine, Math.min(sourceLines.length, nodeEndLine ?? defaultEndLine));
    const content = sourceLines.slice(startLine - 1, endLine).join('\n');
    if (!content.trim()) return null;
    const codeBlockContent = shouldKeepCompleteNativeCodeBlock(node)
      ? content
      : truncateNativeCodeBlockContent(content);

    return {
      filePath: node.filePath,
      startLine,
      endLine,
      language: languageForFile(node.filePath, node),
      content: codeBlockContent,
      nodeName: node.name,
      nodeKind: node.kind,
    };
  }

  function shouldKeepCompleteNativeCodeBlock(node) {
    return isSqlStatementNode(node);
  }

  function truncateNativeCodeBlockContent(content) {
    return content.length > NATIVE_CONTEXT_CODE_BLOCK_SIZE
      ? `${content.slice(0, NATIVE_CONTEXT_CODE_BLOCK_SIZE)}\n... (truncated) ...`
      : content;
  }

  function resolveNodeCodeBlockStartLine(sourceLines, node, defaultStartLine) {
    if (isSqlStatementNode(node)) {
      return findSqlStatementStartLine(sourceLines, defaultStartLine);
    }
    if (node?.metadata?.relation !== 'hard-rule-keyword') {
      return defaultStartLine;
    }

    const matchedNeedle = String(
      node.metadata.matchedNeedle
        ?? node.metadata.keyword
        ?? node.name
        ?? node.qualifiedName
        ?? '',
    ).trim();
    if (!matchedNeedle) {
      return defaultStartLine;
    }

    return findHardRuleKeywordNeedleLine(sourceLines, matchedNeedle, defaultStartLine)
      ?? defaultStartLine;
  }

  function resolveNodeCodeBlockEndLine(sourceLines, node, startLine, defaultEndLine) {
    if (node.kind === 'file') return defaultEndLine;
    if (node.kind === 'route' && (!Number.isInteger(node.endLine) || node.endLine <= startLine)) {
      return findBlockEndLine(sourceLines, startLine - 1);
    }
    if (isSqlStatementNode(node)) {
      return findSqlStatementEndLine(sourceLines, startLine);
    }
    if (Number.isInteger(node.endLine) && node.endLine >= startLine) return node.endLine;
    return node.endLine;
  }

  function isSqlStatementNode(node) {
    if (!String(node?.filePath ?? '').toLowerCase().endsWith('.sql')) return false;
    const relation = node?.metadata?.relation;
    if (relation === 'policy') return true;
    if (SQL_STATEMENT_NODE_RELATIONS.has(relation)) return true;
    const signature = String(node?.signature ?? '').toLowerCase();
    return signature.startsWith('policy ')
      || signature.startsWith('index ')
      || signature.startsWith('constraint ')
      || signature.startsWith('rls ')
      || signature.startsWith('privilege ');
  }

  function findSqlStatementEndLine(sourceLines, startLine) {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let dollarQuoteTag = '';

    for (let lineIndex = Math.max(0, startLine - 1); lineIndex < sourceLines.length; lineIndex += 1) {
      const line = sourceLines[lineIndex] ?? '';
      for (let index = 0; index < line.length; index += 1) {
        if (dollarQuoteTag) {
          if (line.startsWith(dollarQuoteTag, index)) {
            index += dollarQuoteTag.length - 1;
            dollarQuoteTag = '';
          }
          continue;
        }

        const char = line[index];
        const next = line[index + 1];
        if (inSingleQuote) {
          if (char === "'" && next === "'") {
            index += 1;
            continue;
          }
          if (char === "'") inSingleQuote = false;
          continue;
        }
        if (inDoubleQuote) {
          if (char === '"' && next === '"') {
            index += 1;
            continue;
          }
          if (char === '"') inDoubleQuote = false;
          continue;
        }

        if (char === '-' && next === '-') break;
        if (char === "'") {
          inSingleQuote = true;
          continue;
        }
        if (char === '"') {
          inDoubleQuote = true;
          continue;
        }
        const dollarTag = readSqlDollarQuoteTag(line, index);
        if (dollarTag) {
          dollarQuoteTag = dollarTag;
          index += dollarTag.length - 1;
          continue;
        }
        if (char === ';') return lineIndex + 1;
      }
    }

    return startLine;
  }

  function findSqlStatementStartLine(sourceLines, lineNumber) {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let dollarQuoteTag = '';
    let statementStartLine = 1;
    const targetLineIndex = Math.max(0, Math.min(sourceLines.length - 1, lineNumber - 1));

    for (let lineIndex = 0; lineIndex <= targetLineIndex; lineIndex += 1) {
      const line = sourceLines[lineIndex] ?? '';
      for (let index = 0; index < line.length; index += 1) {
        if (dollarQuoteTag) {
          if (line.startsWith(dollarQuoteTag, index)) {
            index += dollarQuoteTag.length - 1;
            dollarQuoteTag = '';
          }
          continue;
        }

        const char = line[index];
        const next = line[index + 1];
        if (inSingleQuote) {
          if (char === "'" && next === "'") {
            index += 1;
            continue;
          }
          if (char === "'") inSingleQuote = false;
          continue;
        }
        if (inDoubleQuote) {
          if (char === '"' && next === '"') {
            index += 1;
            continue;
          }
          if (char === '"') inDoubleQuote = false;
          continue;
        }

        if (char === '-' && next === '-') break;
        if (char === "'") {
          inSingleQuote = true;
          continue;
        }
        if (char === '"') {
          inDoubleQuote = true;
          continue;
        }
        const dollarTag = readSqlDollarQuoteTag(line, index);
        if (dollarTag) {
          dollarQuoteTag = dollarTag;
          index += dollarTag.length - 1;
          continue;
        }
        if (char === ';' && lineIndex < targetLineIndex) {
          statementStartLine = lineIndex + 2;
        }
      }
    }

    let normalizedStartLine = Math.max(1, Math.min(sourceLines.length, statementStartLine));
    while (
      normalizedStartLine < lineNumber
      && String(sourceLines[normalizedStartLine - 1] ?? '').trim() === ''
    ) {
      normalizedStartLine += 1;
    }
    return normalizedStartLine;
  }

  function readSqlDollarQuoteTag(line, index) {
    if (line[index] !== '$') return '';
    const match = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(line.slice(index));
    return match?.[0] ?? '';
  }

  function readEdgeLineCodeBlock(projectRoot, sourceNode, edge) {
    if (!sourceNode?.filePath || sourceNode.filePath === '(unknown)') return null;
    const blockSourceNode = edgeCodeBlockSourceNode(sourceNode, edge);
    const absolutePath = resolveProjectSourcePath(projectRoot, blockSourceNode.filePath);
    if (!absolutePath) return null;

    const sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    const edgeLine = resolveEdgeCodeBlockLine(edge, sourceLines);
    if (!edgeLine) return null;
    const startLine = Math.min(edgeLine, sourceLines.length);
    const endLine = resolveEdgeCodeBlockEndLine(edge, blockSourceNode, sourceLines, startLine);
    const content = sourceLines.slice(startLine - 1, endLine).join('\n');
    const nodeName = edgeLineCodeBlockNodeName(blockSourceNode, edge, sourceLines, startLine);

    return {
      filePath: blockSourceNode.filePath,
      startLine,
      endLine,
      language: languageForFile(blockSourceNode.filePath, blockSourceNode),
      content,
      nodeName,
      nodeKind: blockSourceNode.kind,
    };
  }

  function resolveEdgeCodeBlockEndLine(edge, sourceNode, sourceLines, startLine) {
    if (edge?.metadata?.relation === 'edge-function-header') {
      const range = findEdgeFunctionHeaderEvidenceRange(edge, sourceLines);
      if (range) return range.endLine;
    }
    if (shouldExpandEdgeCodeBlockAsSqlStatement(edge, sourceNode)) {
      return findSqlStatementEndLine(sourceLines, startLine);
    }
    if (edge?.metadata?.relation === 'host-directive') {
      return findAngularArrayMetadataEndLine(sourceLines, startLine, 'hostDirectives');
    }
    if (
      edge?.metadata?.relation === 'angular-app-provider'
      && Number.isInteger(edge?.metadata?.endLine)
      && edge.metadata.endLine >= startLine
    ) {
      return Math.min(sourceLines.length, edge.metadata.endLine);
    }
    if (shouldExpandEdgeCodeBlockAsChainWindow(edge)) {
      return findChainedCallEvidenceEndLine(sourceLines, startLine);
    }
    return startLine;
  }

  function shouldExpandEdgeCodeBlockAsChainWindow(edge) {
    return provenanceEdgeLineRelationNodeNameQueries().has(normalizeExactRelationQuery(edge?.metadata?.relation));
  }

  function findChainedCallEvidenceEndLine(sourceLines, startLine) {
    const maxEndLine = Math.min(sourceLines.length, startLine + 8);
    for (let lineNumber = startLine; lineNumber <= maxEndLine; lineNumber += 1) {
      const line = sourceLines[lineNumber - 1] ?? '';
      if (line.trim().endsWith(';')) {
        return lineNumber;
      }
    }
    return maxEndLine;
  }

  function edgeLineCodeBlockNodeName(sourceNode, edge, sourceLines = [], startLine = null) {
    const relation = edge?.metadata?.relation;
    if (relation === 'edge-function-header') {
      const functionName = readJavaScriptFunctionBlockName(sourceLines[startLine - 1]);
      if (functionName) return functionName;
    }
    if (
      isHardRuleEvidenceRelation(relation)
      || provenanceEdgeLineRelationNodeNameQueries().has(normalizeExactRelationQuery(relation))
      || sourceOwnerEdgeLineRelationNodeNameQueries().has(normalizeExactRelationQuery(relation))
    ) {
      return sourceNode.name;
    }
    return edge.metadata?.constraintName
      ?? edge.metadata?.matchedNeedle
      ?? edge.metadata?.relation
      ?? sourceNode.name;
  }

  function readJavaScriptFunctionBlockName(line) {
    const text = String(line ?? '').trim();
    return /^(?:export\s+)?(?:async\s+)?function\s+([$A-Z_a-z][$\w]*)\b/.exec(text)?.[1]
      ?? /^(?:export\s+)?(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=/.exec(text)?.[1]
      ?? null;
  }

  function provenanceEdgeLineRelationNodeNameQueries() {
    return relationPolicySet(Object.values(provenanceEdgeLineRelationByQuery()));
  }

  function sourceOwnerEdgeLineRelationNodeNameQueries() {
    return relationPolicySet([
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
  }

  function shouldExpandEdgeCodeBlockAsSqlStatement(edge, sourceNode) {
    if (!String(sourceNode?.filePath ?? '').toLowerCase().endsWith('.sql')) return false;
    return SQL_STATEMENT_EDGE_RELATIONS.has(edge?.metadata?.relation);
  }

  function edgeCodeBlockSourceNode(sourceNode, edge) {
    const templateFile = edge?.metadata?.templateFile;
    if (!templateFile) return sourceNode;
    return {
      ...sourceNode,
      filePath: templateFile,
      name: edge.metadata?.matchedNeedle ?? sourceNode.name,
      kind: 'file',
      language: undefined,
    };
  }

  function resolveEdgeCodeBlockLine(edge, sourceLines) {
    const matchedNeedle = String(edge?.metadata?.matchedNeedle ?? '').trim();
    const relation = String(edge?.metadata?.relation ?? '');
    if (relation === 'edge-function-header') {
      const range = findEdgeFunctionHeaderEvidenceRange(edge, sourceLines);
      if (range) return range.startLine;
    }
    if (relation === 'host-directive' && Number.isInteger(edge?.line) && edge.line >= 1) {
      const metadataLine = findAngularArrayMetadataStartLine(sourceLines, edge.line, 'hostDirectives');
      if (metadataLine) return metadataLine;
    }
    if (
      relation === 'angular-app-provider'
      && Number.isInteger(edge?.metadata?.bootstrapLine)
      && edge.metadata.bootstrapLine >= 1
    ) {
      return edge.metadata.bootstrapLine;
    }
    if (relation.startsWith('template-') && edge?.metadata?.templateFile && Number.isInteger(edge?.line) && edge.line >= 1) {
      return edge.line;
    }
    if (String(edge?.metadata?.relation ?? '') === 'hard-rule-keyword' && matchedNeedle) {
      const scopedLine = findHardRuleKeywordNeedleLine(sourceLines, matchedNeedle, edge?.line);
      if (scopedLine) return scopedLine;
    }
    if (shouldPreferMatchedNeedleCodeBlockLine(edge) && matchedNeedle) {
      const matchedLine = findCodeBlockNeedleLine(sourceLines, matchedNeedle);
      if (matchedLine) return matchedLine;
    }
    if (Number.isInteger(edge?.line) && edge.line >= 1) return edge.line;
    if (!matchedNeedle) return null;
    const lineIndex = sourceLines.findIndex(line => line.includes(matchedNeedle));
    return lineIndex >= 0 ? lineIndex + 1 : null;
  }

  function findEdgeFunctionHeaderEvidenceRange(edge, sourceLines) {
    if (!Number.isInteger(edge?.line) || edge.line < 1) return null;
    const evidenceLineIndex = Math.min(sourceLines.length - 1, edge.line - 1);
    const startIndex = findContainingJavaScriptFunctionStartIndex(sourceLines, evidenceLineIndex);
    if (startIndex < 0) {
      return { startLine: evidenceLineIndex + 1, endLine: evidenceLineIndex + 1 };
    }
    return {
      startLine: startIndex + 1,
      endLine: findJavaScriptFunctionBlockEndLine(sourceLines, startIndex),
    };
  }

  function findContainingJavaScriptFunctionStartIndex(sourceLines, evidenceLineIndex) {
    const minIndex = Math.max(0, evidenceLineIndex - 120);
    for (let index = evidenceLineIndex; index >= minIndex; index -= 1) {
      if (isJavaScriptFunctionBlockStart(sourceLines[index])) {
        return index;
      }
    }
    return -1;
  }

  function isJavaScriptFunctionBlockStart(line) {
    const text = String(line ?? '').trim();
    return /^(?:export\s+)?(?:async\s+)?function\b/.test(text)
      || /^(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>\s*\{/.test(text)
      || /\b(?:Deno\.)?serve\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>\s*\{/.test(text);
  }

  function findJavaScriptFunctionBlockEndLine(sourceLines, startIndex) {
    const startLine = sourceLines[startIndex] ?? '';
    const openingBraceIndex = startLine.lastIndexOf('{');
    if (openingBraceIndex < 0) {
      return findBlockEndLine(sourceLines, startIndex);
    }
    return findBlockEndLineFromPosition(sourceLines, startIndex, openingBraceIndex);
  }

  function findBlockEndLineFromPosition(sourceLines, startIndex, startColumn) {
    let depth = 0;
    let hasOpened = false;
    for (let index = startIndex; index < sourceLines.length; index++) {
      const line = sourceLines[index] ?? '';
      const firstColumn = index === startIndex ? Math.max(0, startColumn) : 0;
      for (let column = firstColumn; column < line.length; column++) {
        const char = line[column];
        if (char === '{') {
          depth++;
          hasOpened = true;
        } else if (char === '}' && hasOpened) {
          depth--;
          if (depth <= 0) return index + 1;
        }
      }
    }
    return startIndex + 1;
  }

  function shouldPreferMatchedNeedleCodeBlockLine(edge) {
    const relation = String(edge?.metadata?.relation ?? '');
    return relation === 'hard-rule-keyword';
  }

  function findCodeBlockNeedleLine(sourceLines, matchedNeedle) {
    const lineIndex = sourceLines.findIndex(line => line.includes(matchedNeedle));
    return lineIndex >= 0 ? lineIndex + 1 : null;
  }

  function findHardRuleKeywordNeedleLine(sourceLines, matchedNeedle, headingLine) {
    if (!Number.isInteger(headingLine) || headingLine < 1) return null;
    const startIndex = Math.min(sourceLines.length, headingLine);
    const evidencePattern = hardRuleKeywordEvidencePattern(matchedNeedle);
    for (let index = startIndex; index < sourceLines.length; index += 1) {
      const line = sourceLines[index] ?? '';
      if (/^#{2,4}\s+/.test(line)) {
        return null;
      }
      if (line.includes(matchedNeedle) || evidencePattern?.test(line)) {
        return index + 1;
      }
    }
    return null;
  }

  function hardRuleKeywordEvidencePattern(keyword) {
    switch (String(keyword ?? '').trim().toLowerCase()) {
      case 'crypto.randomuuid()':
        return /crypto\.randomUUID\s*\(\s*\)/i;
      case 'database autoincrement id':
        return /\bdatabase\s+autoincrement\s+ids?\b|数据库自增\s*ID/i;
      case 'temporary id':
        return /\btemporary\s+ids?\b|临时\s*ID/i;
      case 'id mapping':
        return /\bid\s+mapping\b|ID\s*映射/i;
      case 'indexeddb':
        return /\bIndexedDB\b/i;
      case 'retryqueue':
        return /\bRetryQueue\b/i;
      case 'lww':
        return /\bLWW\b|Last-Write-Wins/i;
      case 'content':
        return /\bcontent\b|不可漏字段|必须包含\s*content|must\s+include\s+content/i;
      case '@defer':
        return /@defer\b/i;
      case 'visibility:hidden':
        return /visibility\s*:\s*hidden/i;
      case 'floating_tree_config.max_subtree_depth':
        return /\bFLOATING_TREE_CONFIG\.MAX_SUBTREE_DEPTH\b/i;
      case 'storeservice':
        return /\bStoreService\b/i;
      case 'facade store':
        return /\bfacade\s+Store\b|门面\s*Store/i;
      case 'ngrx':
        return /\bNgRx\b/i;
      case 'rxjs store':
        return /\bRxJS\s+Store\b/i;
      default:
        return null;
    }
  }

  function pushNativeCodeBlock(blocks, block, options = {}) {
    if (!isUsableNativeCodeBlock(block)) return;
    const key = nativeCodeBlockSourceRangeKey(block);
    if (blocks.some(existing => nativeCodeBlockSourceRangeKey(existing) === key)) return;
    if (options.coalesceContainedRanges) {
      const containingIndex = blocks.findIndex(existing => nativeCodeBlockContains(existing, block));
      if (containingIndex >= 0) return;
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (nativeCodeBlockContains(block, blocks[index])) {
          blocks.splice(index, 1);
        }
      }
    }
    blocks.push(block);
  }

  function isUsableNativeCodeBlock(block) {
    return Boolean(block && String(block.content ?? '').trim());
  }

  function nativeCodeBlockSourceRangeKey(block) {
    return `${block.filePath}:${block.startLine}:${block.endLine}:${block.language}`;
  }

  function nativeCodeBlockContains(outer, inner) {
    return outer?.filePath === inner?.filePath
      && outer?.language === inner?.language
      && Number.isInteger(outer?.startLine)
      && Number.isInteger(outer?.endLine)
      && Number.isInteger(inner?.startLine)
      && Number.isInteger(inner?.endLine)
      && outer.startLine <= inner.startLine
      && outer.endLine >= inner.endLine;
  }


  resolveNativeCodeBlockNodeDelegate = resolveNativeCodeBlockNode;
  Object.assign(runtime, {
    resolveNativeCodeBlockNode, resolveSupabaseEdgeFunctionCodeBlockNode, findDelegatedEdgeFunctionHandlerIndex, findDelegatedEdgeFunctionHandlerName, resolveSameFileClassCodeBlockNode,
    findBlockEndLine, findAngularArrayMetadataStartLine, findAngularArrayMetadataEndLine, escapeRegExp, readNodeCodeBlock,
    shouldKeepCompleteNativeCodeBlock, truncateNativeCodeBlockContent, resolveNodeCodeBlockStartLine, resolveNodeCodeBlockEndLine, isSqlStatementNode,
    findSqlStatementEndLine, findSqlStatementStartLine, readSqlDollarQuoteTag, readEdgeLineCodeBlock, resolveEdgeCodeBlockEndLine,
    shouldExpandEdgeCodeBlockAsChainWindow, findChainedCallEvidenceEndLine, edgeLineCodeBlockNodeName, readJavaScriptFunctionBlockName, provenanceEdgeLineRelationNodeNameQueries,
    sourceOwnerEdgeLineRelationNodeNameQueries, shouldExpandEdgeCodeBlockAsSqlStatement, edgeCodeBlockSourceNode, resolveEdgeCodeBlockLine, findEdgeFunctionHeaderEvidenceRange,
    findContainingJavaScriptFunctionStartIndex, isJavaScriptFunctionBlockStart, findJavaScriptFunctionBlockEndLine, findBlockEndLineFromPosition, shouldPreferMatchedNeedleCodeBlockLine,
    findCodeBlockNeedleLine, findHardRuleKeywordNeedleLine, hardRuleKeywordEvidencePattern, pushNativeCodeBlock, isUsableNativeCodeBlock,
    nativeCodeBlockSourceRangeKey, nativeCodeBlockContains,
  });
}
