'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { analyzeCallbackReachabilityBatch } = require('./codegraph-overlay-callback-reachability.cjs');

function resolveRealPath(filePath) {
  return typeof nodeFs.realpathSync.native === 'function'
    ? nodeFs.realpathSync.native(filePath)
    : nodeFs.realpathSync(filePath);
}

function isRealPathInside(rootPath, candidatePath) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = nodePath.relative(normalize(rootPath), normalize(candidatePath));
  return relative === ''
    || (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative));
}
function loadDedupContractManifest(projectRoot, relativePath) {
  const absolutePath = nodePath.join(projectRoot, relativePath);
  if (!nodeFs.existsSync(absolutePath)) {
    throw new Error(`${relativePath} missing structured de-duplication contract manifest`);
  }
  const docsRoot = nodePath.dirname(absolutePath);
  const docsRootRealPath = resolveRealPath(docsRoot);
  const manifestRealPath = resolveRealPath(absolutePath);
  if (!isRealPathInside(docsRootRealPath, manifestRealPath)) {
    throw new Error(`${relativePath} real path must stay within docs`);
  }
  const rootManifest = JSON.parse(nodeFs.readFileSync(manifestRealPath, 'utf8'));
  if (!rootManifest || typeof rootManifest !== 'object' || Array.isArray(rootManifest)) {
    throw new Error(`${relativePath} must be a JSON object`);
  }
  if (!Array.isArray(rootManifest.hotspots)) {
    throw new Error(`${relativePath} hotspots must be an array`);
  }
  if (rootManifest.schemaVersion === 1) {
    return { manifest: rootManifest, hotspots: rootManifest.hotspots, partPaths: [] };
  }
  if (rootManifest.schemaVersion !== 2) {
    throw new Error(`${relativePath} schemaVersion must be 1 or 2`);
  }
  if (!Array.isArray(rootManifest.hotspotParts)) {
    throw new Error(`${relativePath} hotspotParts must be an ordered array`);
  }

  const docsRelative = nodePath.posix.dirname(relativePath.replace(/\\/g, '/'));
  const seenPaths = new Set();
  const seenCaseFoldedPaths = new Map();
  const partPaths = [];
  const hotspots = [...rootManifest.hotspots];
  for (const rawPartPath of rootManifest.hotspotParts) {
    if (typeof rawPartPath !== 'string' || !rawPartPath.trim()) {
      throw new Error(`${relativePath} hotspot part path must be a non-empty string`);
    }
    if (/^[A-Za-z]:/.test(rawPartPath) || nodePath.isAbsolute(rawPartPath) || nodePath.win32.isAbsolute(rawPartPath) || nodePath.posix.isAbsolute(rawPartPath)) {
      throw new Error(`${relativePath} hotspot part path must be relative: ${rawPartPath}`);
    }
    const normalized = rawPartPath.replace(/\\/g, '/');
    const resolved = nodePath.resolve(docsRoot, normalized);
    const fromDocsRoot = nodePath.relative(docsRoot, resolved);
    if (!fromDocsRoot || fromDocsRoot.startsWith(`..${nodePath.sep}`) || fromDocsRoot === '..' || nodePath.isAbsolute(fromDocsRoot)) {
      throw new Error(`${relativePath} hotspot part path must stay within docs: ${rawPartPath}`);
    }
    const normalizedKey = fromDocsRoot.replace(/\\/g, '/');
    const caseFoldedKey = normalizedKey.toLowerCase();
    if (seenPaths.has(normalizedKey)) {
      throw new Error(`${relativePath} duplicate hotspot part path ${rawPartPath}`);
    }
    if (seenCaseFoldedPaths.has(caseFoldedKey)) {
      throw new Error(`${relativePath} case-colliding hotspot part path ${rawPartPath}`);
    }
    seenPaths.add(normalizedKey);
    seenCaseFoldedPaths.set(caseFoldedKey, normalizedKey);
    if (!nodeFs.existsSync(resolved)) {
      throw new Error(`${relativePath} missing hotspot part ${rawPartPath}`);
    }
    const partRealPath = resolveRealPath(resolved);
    if (!isRealPathInside(docsRootRealPath, partRealPath)) {
      throw new Error(`${relativePath} hotspot part real path must stay within docs: ${rawPartPath}`);
    }
    const part = JSON.parse(nodeFs.readFileSync(partRealPath, 'utf8'));
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new Error(`${relativePath} hotspot part ${rawPartPath} must be a JSON object`);
    }
    if (Object.prototype.hasOwnProperty.call(part, 'hotspotParts')) {
      throw new Error(`${relativePath} hotspot part must not declare hotspotParts: ${rawPartPath}`);
    }
    for (const field of Object.keys(part)) {
      if (field !== 'schemaVersion' && field !== 'hotspots') {
        throw new Error(`${relativePath} hotspot part unsupported field ${field}: ${rawPartPath}`);
      }
    }
    if (part.schemaVersion !== 1 || !Array.isArray(part.hotspots)) {
      throw new Error(`${relativePath} hotspot part ${rawPartPath} must use schemaVersion 1 with hotspots array`);
    }
    partPaths.push(`${docsRelative}/${normalizedKey}`);
    hotspots.push(...part.hotspots);
  }
  const seenHotspots = new Set();
  for (const entry of hotspots) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (name && seenHotspots.has(name)) {
      throw new Error(`${relativePath} duplicate hotspot name ${name} across de-duplication contract parts`);
    }
    if (name) seenHotspots.add(name);
  }
  return { manifest: { ...rootManifest, hotspots }, hotspots, partPaths };
}
function installDedupContractValidator(runtime) {
  const {
    fs, path, root, errors,
    DEDUP_CONTRACT_MANIFEST_PATH, DEDUP_CONTRACT_REQUIRED_GATES, DEDUP_CONTRACT_CONTEXT_PACK_SOURCE_PATH, DEDUP_CONTRACT_REQUIRED_COVERED_CHILD_OWNERS,
    DEDUP_CONTRACT_REQUIRED_HOTSPOTS, DEDUP_CONTRACT_SOURCE_CONDITIONAL_HOTSPOTS, DEDUP_CONTRACT_REQUIRED_HOTSPOT_FIELDS, DEDUP_CONTRACT_BOUNDARY_REQUIRED_FIELDS,
    DEDUP_CONTRACT_ALLOWED_BOUNDARY_ROLES, DEDUP_CONTRACT_ALLOWED_OUTPUT_SURFACES, DEDUP_CONTRACT_ALLOWED_EXTENSION_FIELD_POLICIES, DEDUP_CONTRACT_AUGMENTED_MARKDOWN_FORBIDDEN_SOURCE_TOKENS,
    DEDUP_CONTRACT_STRICT_NATIVE_MARKDOWN_FORBIDDEN_SOURCE_TOKENS, DEDUP_CONTRACT_ANDROID_KOTLIN_SOURCE_PATH, DEDUP_CONTRACT_TYPESCRIPT_SOURCE_PATH, DEDUP_CONTRACT_TYPESCRIPT_DISCOVERY_PATTERN,
    DEDUP_CONTRACT_ANDROID_KOTLIN_DISCOVERY_PATTERN, DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH, DEDUP_CONTRACT_QUERY_FORMATTER_DISCOVERY_PATTERN, DEDUP_CONTRACT_CONTEXT_PACK_DISCOVERY_PATTERN
  } = runtime;
  const call = name => (...values) => runtime[name](...values);
  const
    readJson = call('readJson'), readText = call('readText'), escapeRegex = call('escapeRegex'), extractFunctionBody = call('extractFunctionBody'),
    extractFunctionBodies = call('extractFunctionBodies'), extractModuleSpecifiers = call('extractModuleSpecifiers');
  let dependencyLeafSources = [], manifestSchemaVersion = 1;
  const dedupFunctionBodyCache = new Map();
  const pendingCallbackReachability = [];
  function validateDedupCallbackReachability(prefix, ownerName, children, input) {
    pendingCallbackReachability.push({ prefix, ownerName, children, input });
  }
  function flushDedupCallbackReachability() {
    if (pendingCallbackReachability.length === 0) return;
    const pending = pendingCallbackReachability.splice(0);
    const first = pending[0].input;
    const batch = analyzeCallbackReachabilityBatch({
      sources: first.sources, entrySourcePath: first.entrySourcePath,
      ownerRequests: pending.map((entry, ownerId) => ({ ownerId, rootCallables: entry.input.rootCallables ?? [] })),
    });
    for (let index = 0; index < pending.length; index += 1) {
      const { prefix, ownerName, children } = pending[index];
      const analysis = batch.ownerResults[index] ?? { diagnostics: ['missing batch owner result'], reachableCallableNames: [] };
      const reachable = new Set(analysis.reachableCallableNames);
      for (const diagnostic of analysis.diagnostics) {
        errors.push(`${prefix} callback reachability analysis failed: ${diagnostic}`);
      }
      for (const child of children) {
        if (!reachable.has(child)) errors.push(
          `${prefix} covered child ${child} must be transitively reachable from hotspot owner ${normalizeDedupSymbolName(ownerName)}`,
        );
      }
    }
  }

  function readDedupSourceFiles(sourcePath) {
    if (sourcePath !== DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH) {
      return [{ sourcePath, text: readText(sourcePath) }];
    }
    const leaves = new Set(dependencyLeafSources.map(value => value.replace(/\\/g, '/')));
    const queue = [sourcePath];
    const seen = new Set();
    const sourceFiles = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(current) || (current !== sourcePath && leaves.has(current))) continue;
      seen.add(current);
      const text = readText(current);
      sourceFiles.push({ sourcePath: current, text });
      for (const specifier of extractModuleSpecifiers(text)) {
        if (!specifier.startsWith('.')) continue;
        const candidate = path.posix.normalize(path.posix.join(
          path.posix.dirname(current), specifier.replace(/\\/g, '/'),
        ));
        const escapesRoot = candidate === '..' || candidate.startsWith('../') || path.posix.isAbsolute(candidate);
        if (!escapesRoot && fs.existsSync(path.join(root, candidate))) queue.push(candidate);
      }
    }
    return sourceFiles;
  }

  function readDedupSourceText(sourcePath) {
    return readDedupSourceFiles(sourcePath).map(source => source.text).join('\n');
  }
  function readDedupFunctionBodies(sourcePath, symbol) {
    const cacheKey = `${sourcePath}\0${symbol}`;
    if (!dedupFunctionBodyCache.has(cacheKey)) dedupFunctionBodyCache.set(cacheKey, readDedupSourceFiles(sourcePath).flatMap(source => (
      extractFunctionBodies(source.text, symbol).map(body => ({ sourcePath: source.sourcePath, body }))
    )));
    return dedupFunctionBodyCache.get(cacheKey);
  }
  function readRequiredDedupFunctionBodies(prefix, sourcePath, symbol) {
    const declarations = readDedupFunctionBodies(sourcePath, symbol);
    if (declarations.length === 0) {
      errors.push(`${prefix} source symbol ${symbol} has no inspectable function body in import closure of ${sourcePath}`);
    }
    return declarations;
  }
  function formatterContractSymbols(entry) {
    return [...new Set([
      ...arrayOfStrings(entry.sourceSymbols),
      ...arrayOfStrings(entry.coveredChildSymbols),
      entry.name,
    ].map(normalizeDedupSymbolName).filter(Boolean))];
  }

  function validateStructuredDedupContract() {
    let loaded;
    try {
      loaded = loadDedupContractManifest(root, DEDUP_CONTRACT_MANIFEST_PATH);
    } catch (error) {
      errors.push(error instanceof Error
        ? error.message
        : `${DEDUP_CONTRACT_MANIFEST_PATH} missing structured de-duplication contract manifest`);
      return;
    }
    const { manifest, hotspots } = loaded;
    manifestSchemaVersion = manifest.schemaVersion;

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} must be a JSON object`);
      return;
    }

    if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} schemaVersion must be 1 or 2`);
    }
    dependencyLeafSources = Array.isArray(manifest.dependencyLeafSources)
      ? manifest.dependencyLeafSources.filter(value => typeof value === 'string')
      : [];
    if (manifest.schemaVersion === 2) {
      const expectedLeaves = [
        'scripts/lib/codegraph-overlay-baseline.cjs',
        'scripts/lib/codegraph-source-policy.cjs',
      ];
      if (JSON.stringify(dependencyLeafSources) !== JSON.stringify(expectedLeaves)) {
        errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} dependencyLeafSources must explicitly attribute baseline and SourcePolicy leaves`);
      }
    }
    if (manifest.upstreamCodeGraphVersion !== '@colbymchenry/codegraph@1.5.0') {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} upstreamCodeGraphVersion must be @colbymchenry/codegraph@1.5.0`);
    }
    if (manifest.fixedVersionUpgradeProbe !== '--codegraph-target @colbymchenry/codegraph@<new-version>') {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} fixedVersionUpgradeProbe must use --codegraph-target @colbymchenry/codegraph@<new-version>`);
    }

    validateDedupManifestCapabilities(manifest);
    validateDedupManifestGateList(`${DEDUP_CONTRACT_MANIFEST_PATH} verificationGates`, manifest.verificationGates);

    if (!Array.isArray(manifest.hotspots)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspots must be an array`);
      return;
    }

    const requiredHotspots = [
      ...DEDUP_CONTRACT_REQUIRED_HOTSPOTS,
      ...DEDUP_CONTRACT_SOURCE_CONDITIONAL_HOTSPOTS
        .filter(([, sourcePath, sourceSymbol]) => dedupSourceDeclaresSymbol(sourcePath, sourceSymbol))
        .map(([name, sourcePath]) => [name, sourcePath]),
    ];
    const requiredSourcePathsByName = new Map(requiredHotspots);
    const hotspotNameCounts = new Map();
    for (let index = 0; index < hotspots.length; index += 1) {
      const entry = hotspots[index];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspot[${index}] must be an object`);
        continue;
      }
      const name = typeof entry.name === 'string' ? entry.name : '';
      if (!name.trim()) {
        errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspot[${index}] name must be a non-empty string`);
        continue;
      }
      hotspotNameCounts.set(name, (hotspotNameCounts.get(name) ?? 0) + 1);
      const sourcePath = typeof entry.sourcePath === 'string' ? entry.sourcePath : '';
      if (!sourcePath.trim()) {
        errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} hotspot ${name} sourcePath must be a non-empty string`);
        continue;
      }
      validateDedupManifestHotspot(entry, name, requiredSourcePathsByName.get(name) ?? sourcePath);
    }
    flushDedupCallbackReachability();
    for (const name of [...hotspotNameCounts.keys()].sort()) {
      if (hotspotNameCounts.get(name) > 1) {
        errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} duplicate hotspot name ${name}`);
      }
    }
    for (const [name] of requiredHotspots) {
      if (!hotspotNameCounts.has(name)) {
        errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} missing de-duplication hotspot ${name}`);
      }
    }
    validateRequiredDedupManifestChildOwnership(hotspots);
    validateDiscoveredDedupManifestCoverage(
      'Android/Kotlin',
      DEDUP_CONTRACT_ANDROID_KOTLIN_SOURCE_PATH,
      DEDUP_CONTRACT_ANDROID_KOTLIN_DISCOVERY_PATTERN,
      hotspots,
    );
    validateDiscoveredDedupManifestCoverage(
      'TypeScript',
      DEDUP_CONTRACT_TYPESCRIPT_SOURCE_PATH,
      DEDUP_CONTRACT_TYPESCRIPT_DISCOVERY_PATTERN,
      hotspots,
    );
    validateDiscoveredDedupManifestCoverage(
      'query/formatter',
      DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH,
      DEDUP_CONTRACT_QUERY_FORMATTER_DISCOVERY_PATTERN,
      hotspots,
    );
    validateDiscoveredDedupManifestCoverage(
      'context-pack source-ordering',
      DEDUP_CONTRACT_CONTEXT_PACK_SOURCE_PATH,
      DEDUP_CONTRACT_CONTEXT_PACK_DISCOVERY_PATTERN,
      hotspots,
    );
  }
  function dedupSourceDeclaresSymbol(sourcePath, symbol) {
    try {
      const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b(?:function|const|let|var)\\s+${escapedSymbol}\\b`).test(readDedupSourceText(sourcePath));
    } catch {
      return false;
    }
  }
  function validateDedupManifestCapabilities(manifest) {
    const contract = manifest.nativeDelegationContract;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} nativeDelegationContract must be an object`);
      return;
    }
    validateDedupManifestIncludesAll(
      'nativeDelegationContract.delegatedGenericCapabilities',
      contract.delegatedGenericCapabilities,
      ['TypeScript', 'symbol', 'import', 'export', 'call', 'impact', 'auto-sync', 'indexing', 'generic search ranking', 'callers/callees/impact'],
    );
    validateDedupManifestIncludesAll(
      'nativeDelegationContract.delegatedGenericCapabilities',
      contract.delegatedGenericCapabilities,
      ['native Markdown/JSON formatter section order', 'strict native output projection', 'context exploration source ordering'],
    );
    validateDedupManifestIncludesAll(
      'nativeDelegationContract.nanoFlowOwnedCapabilities',
      contract.nanoFlowOwnedCapabilities,
      ['project-specific semantics', 'output-quality policy', 'Codex host reliability', 'repository hard-rule anchors'],
    );
  }
  function validateDedupManifestIncludesAll(label, values, requiredTerms) {
    if (!Array.isArray(values)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} ${label} must be an array`);
      return;
    }
    const joined = values.join('\n');
    for (const term of requiredTerms) {
      if (!joined.includes(term)) {
        errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} ${label} missing ${term}`);
      }
    }
  }
  function validateDedupManifestGateList(label, values) {
    if (!Array.isArray(values)) {
      errors.push(`${label} must be an array`);
      return;
    }
    for (const gate of DEDUP_CONTRACT_REQUIRED_GATES) {
      if (!values.includes(gate)) {
        errors.push(`${label} missing ${gate}`);
      }
    }
  }
  function validateDedupManifestHotspot(entry, expectedName, expectedSourcePath) {
    const prefix = `${DEDUP_CONTRACT_MANIFEST_PATH} hotspot ${expectedName}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (entry.sourcePath !== expectedSourcePath) {
      errors.push(`${prefix} sourcePath must be ${expectedSourcePath}`);
    }
    if (entry.status !== 'temporary-allowed') {
      errors.push(`${prefix} status must be temporary-allowed`);
    }
    for (const field of DEDUP_CONTRACT_REQUIRED_HOTSPOT_FIELDS) {
      if (!(field in entry)) {
        errors.push(`${prefix} missing required field ${field}`);
      }
    }
    if (dedupManifestHotspotRequiresBoundaryFields(entry)) {
      for (const field of DEDUP_CONTRACT_BOUNDARY_REQUIRED_FIELDS) {
        if (!(field in entry)) {
          errors.push(`${prefix} missing required field ${field}`);
        }
      }
    }
    validateDedupManifestTextField(prefix, 'capabilityCategory', entry.capabilityCategory, ['duplicate hotspot']);
    validateDedupManifestTextField(prefix, 'language', entry.language, []);
    validateDedupManifestTextField(prefix, 'delegatedUpstreamOwner', entry.delegatedUpstreamOwner, ['native CodeGraph']);
    validateDedupManifestTextField(prefix, 'allowedPurpose', entry.allowedPurpose, ['NanoFlow', 'metadata.relation']);
    validateDedupManifestTextField(prefix, 'nativeOwnedCapability', entry.nativeOwnedCapability, ['native CodeGraph']);
    validateDedupManifestTextField(prefix, 'nanoFlowOwnedCapability', entry.nanoFlowOwnedCapability, ['NanoFlow']);
    validateDedupManifestTextField(prefix, 'forbiddenScope', entry.forbiddenScope, [
      'must not reimplement',
      'native auto-sync',
      'indexing',
      'generic search ranking',
      'callers/callees/impact',
    ]);
    validateDedupManifestTextField(prefix, 'forbiddenGenericBehavior', entry.forbiddenGenericBehavior, [
      'must not reimplement',
      'native auto-sync',
      'indexing',
      'generic search ranking',
      'callers/callees/impact',
    ]);
    validateDedupManifestTextField(prefix, 'removalTrigger', entry.removalTrigger, [
      'upstream',
      'extension point',
      'native projection hook',
    ]);
    validateDedupManifestTextField(prefix, 'upstreamHookNeeded', entry.upstreamHookNeeded, [
      'upstream',
      'hook',
    ]);
    validateDedupManifestTextField(prefix, 'removalCandidateWhen', entry.removalCandidateWhen, [
      'upstream',
    ]);
    validateDedupManifestBoundaryFields(prefix, entry);
    validateDedupManifestSymbolList(prefix, 'sourceSymbols', entry.sourceSymbols, { requireNonEmpty: true });
    validateDedupManifestSymbolList(prefix, 'coveredChildSymbols', entry.coveredChildSymbols, { requireNonEmpty: false });
    validateDedupManifestSymbolList(prefix, 'allowedRelations', entry.allowedRelations, { requireNonEmpty: true });
    if (!DEDUP_CONTRACT_REQUIRED_GATES.includes(entry.lastVerifiedGate)) {
      errors.push(`${prefix} lastVerifiedGate must be one of ${DEDUP_CONTRACT_REQUIRED_GATES.join(', ')}`);
    }
    validateDedupManifestGateList(`${prefix} verificationGate`, entry.verificationGate);
    validateDedupManifestHotspotSource(prefix, expectedName, expectedSourcePath, entry);
  }
  function dedupManifestHotspotRequiresBoundaryFields(entry) {
    const category = String(entry?.capabilityCategory ?? '');
    return category.includes('query/formatter')
      || category.includes('context-pack source-ordering');
  }
  function validateDedupManifestBoundaryFields(prefix, entry) {
    if (!dedupManifestHotspotRequiresBoundaryFields(entry)) return;
    if (!DEDUP_CONTRACT_ALLOWED_BOUNDARY_ROLES.has(entry.duplicateBoundaryRole)) {
      errors.push(`${prefix} duplicateBoundaryRole must be one of ${[...DEDUP_CONTRACT_ALLOWED_BOUNDARY_ROLES].join(', ')}`);
    }
    validateDedupManifestSymbolList(prefix, 'outputSurface', entry.outputSurface, { requireNonEmpty: true });
    for (const surface of arrayOfStrings(entry.outputSurface)) {
      if (!DEDUP_CONTRACT_ALLOWED_OUTPUT_SURFACES.has(surface)) {
        errors.push(`${prefix} outputSurface has unsupported value ${surface}`);
      }
    }
    if (!DEDUP_CONTRACT_ALLOWED_EXTENSION_FIELD_POLICIES.has(entry.extensionFieldPolicy)) {
      errors.push(`${prefix} extensionFieldPolicy must be one of ${[...DEDUP_CONTRACT_ALLOWED_EXTENSION_FIELD_POLICIES].join(', ')}`);
    }
    validateStrictNativeJsonFormatterBoundary(prefix, entry);
    validateStrictNativeMarkdownFormatterBoundary(prefix, entry);
    validateAugmentedMarkdownFormatterBoundary(prefix, entry);
    validateQueryRankingAndResultSelectionBoundary(prefix, entry);
  }
  function validateStrictNativeJsonFormatterBoundary(prefix, entry) {
    const outputSurface = arrayOfStrings(entry.outputSurface);
    if (entry.name !== 'toNativeJsonFormatterResponse()'
      && (entry.extensionFieldPolicy !== 'strict-native' || !outputSurface.includes('nativeJson'))) {
      return;
    }
    const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
    const coveredChildSymbols = new Set(arrayOfStrings(entry.coveredChildSymbols).map(normalizeDedupSymbolName));
    if (entry.duplicateBoundaryRole !== 'native-json-formatter') {
      errors.push(`${prefix} strict-native nativeJson hotspot must use duplicateBoundaryRole native-json-formatter`);
    }
    if (entry.name !== 'toNativeJsonFormatterResponse()') {
      errors.push(`${prefix} strict-native nativeJson hotspot must be named toNativeJsonFormatterResponse()`);
    }
    if (!sourceSymbols.has('toNativeJsonFormatterResponse')) {
      errors.push(`${prefix} strict-native nativeJson sourceSymbols must include toNativeJsonFormatterResponse`);
    }
    if (outputSurface.length !== 1 || outputSurface[0] !== 'nativeJson') {
      errors.push(`${prefix} strict-native nativeJson outputSurface must include only nativeJson`);
    }
    for (const symbol of [...sourceSymbols, ...coveredChildSymbols]) {
      if (isStrictNativeMarkdownSourceSymbol(symbol) || symbol === 'formatNativeMarkdown') {
        errors.push(`${prefix} strict-native nativeJson formatter must not include Markdown helper ${symbol}`);
      }
    }
  }
  function validateStrictNativeMarkdownFormatterBoundary(prefix, entry) {
    const outputSurface = arrayOfStrings(entry.outputSurface);
    if (entry.extensionFieldPolicy !== 'strict-native' || !outputSurface.includes('nativeMarkdown')) {
      return;
    }
    const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
    const coveredChildSymbols = new Set(arrayOfStrings(entry.coveredChildSymbols).map(normalizeDedupSymbolName));
    if (entry.name !== 'formatStrictNativeMarkdown()') {
      errors.push(`${prefix} strict-native nativeMarkdown hotspot must be named formatStrictNativeMarkdown()`);
    }
    if (!sourceSymbols.has('formatStrictNativeMarkdown')) {
      errors.push(`${prefix} strict-native nativeMarkdown sourceSymbols must include formatStrictNativeMarkdown`);
    }
    for (const symbol of ['formatNativeMarkdown', 'formatNanoFlowAugmentedMarkdown']) {
      if (sourceSymbols.has(symbol)) {
        errors.push(`${prefix} strict-native nativeMarkdown sourceSymbols must not include augmented formatter ${symbol}`);
      }
      if (coveredChildSymbols.has(symbol)) {
        errors.push(`${prefix} strict-native nativeMarkdown coveredChildSymbols must not include augmented formatter ${symbol}`);
      }
    }
    for (const symbol of [...sourceSymbols, ...coveredChildSymbols]) {
      if (isNativeJsonFormatterSourceSymbol(symbol)) {
        errors.push(`${prefix} strict-native nativeMarkdown formatter must not include native JSON helper ${symbol}`);
      }
    }
    if (outputSurface.includes('augmentedMarkdown')) {
      errors.push(`${prefix} strict-native nativeMarkdown outputSurface must not include augmentedMarkdown`);
    }
    validateStrictNativeMarkdownFormatterSourceBody(prefix, entry);
  }
  function validateAugmentedMarkdownFormatterBoundary(prefix, entry) {
    if (
      entry.duplicateBoundaryRole !== 'native-markdown-formatter'
      || entry.extensionFieldPolicy !== 'nanoflow-augmented'
    ) {
      return;
    }

    const outputSurface = arrayOfStrings(entry.outputSurface);
    const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
    const coveredChildSymbols = new Set(arrayOfStrings(entry.coveredChildSymbols).map(normalizeDedupSymbolName));
    if (outputSurface.includes('nativeMarkdown')) {
      errors.push(`${prefix} nanoflow-augmented native-markdown formatter outputSurface must not include nativeMarkdown`);
    }
    for (const symbol of [...sourceSymbols, ...coveredChildSymbols]) {
      if (symbol === 'formatStrictNativeMarkdown' || symbol.startsWith('strictNative')) {
        errors.push(`${prefix} nanoflow-augmented native-markdown formatter must not include strict-native helper ${symbol}`);
      }
    }
    validateAugmentedMarkdownFormatterSourceBody(prefix, entry);
  }

  function validateAugmentedMarkdownFormatterSourceBody(prefix, entry) {
    const sourcePath = String(entry?.sourcePath ?? '');
    if (!sourcePath) {
      return;
    }
    const absolutePath = path.join(root, sourcePath);
    if (!fs.existsSync(absolutePath)) {
      return;
    }
    const formatterSymbols = formatterContractSymbols(entry);
    for (const symbol of formatterSymbols) {
      if (!symbol) continue;
      for (const declaration of readRequiredDedupFunctionBodies(prefix, sourcePath, symbol)) {
        for (const { token, kind } of DEDUP_CONTRACT_AUGMENTED_MARKDOWN_FORBIDDEN_SOURCE_TOKENS) {
          if (declaration.body.includes(token)) {
            const action = kind === 'strict-native heading' ? 'render' : 'reference';
            errors.push(`${prefix} nanoflow-augmented native-markdown formatter source body must not ${action} ${kind} ${token} in source symbol ${symbol} at ${declaration.sourcePath}`);
          }
        }
      }
    }
  }

  function validateStrictNativeMarkdownFormatterSourceBody(prefix, entry) {
    const sourcePath = String(entry?.sourcePath ?? '');
    if (!sourcePath) {
      return;
    }
    const absolutePath = path.join(root, sourcePath);
    if (!fs.existsSync(absolutePath)) {
      return;
    }
    const formatterSymbols = formatterContractSymbols(entry).filter(isStrictNativeMarkdownSourceSymbol);
    for (const symbol of formatterSymbols) {
      if (!symbol) continue;
      for (const declaration of readRequiredDedupFunctionBodies(prefix, sourcePath, symbol)) {
        for (const { token, kind } of DEDUP_CONTRACT_STRICT_NATIVE_MARKDOWN_FORBIDDEN_SOURCE_TOKENS) {
          if (declaration.body.includes(token)) {
            errors.push(`${prefix} strict-native nativeMarkdown formatter source body must not reference ${kind} ${token} in ${declaration.sourcePath}`);
          }
        }
      }
    }
  }

  function isStrictNativeMarkdownSourceSymbol(symbol) {
    return symbol === 'formatStrictNativeMarkdown'
      || symbol.startsWith('buildStrictNativeMarkdown')
      || symbol.startsWith('formatStrictNative')
      || symbol.startsWith('compareStrictNative')
      || symbol.startsWith('orderNativeProjection')
      || symbol.startsWith('strictNative');
  }

  function isNativeJsonFormatterSourceSymbol(symbol) {
    return symbol === 'toNativeJsonFormatterResponse'
      || symbol.startsWith('serializeNativeJson')
      || symbol.startsWith('nativeJsonEdge');
  }

  function validateQueryRankingAndResultSelectionBoundary(prefix, entry) {
    const sourceSymbols = new Set(arrayOfStrings(entry.sourceSymbols).map(normalizeDedupSymbolName));
    const outputSurface = arrayOfStrings(entry.outputSurface);
    const allowedPurpose = String(entry.allowedPurpose ?? '');
    const claimedOwnershipText = [
      entry.allowedPurpose,
      entry.nanoFlowOwnedCapability,
    ].map(value => String(value ?? '')).join('\n');

    if (entry.name === 'scoreCandidate()' || sourceSymbols.has('scoreCandidate')) {
      if (entry.duplicateBoundaryRole !== 'candidate-ranking') {
        errors.push(`${prefix} query ranking hotspot must use duplicateBoundaryRole candidate-ranking`);
      }
      if (!sourceSymbols.has('scoreCandidate')) {
        errors.push(`${prefix} candidate-ranking sourceSymbols must include scoreCandidate`);
      }
      validateDedupManifestTextField(prefix, 'allowedPurpose', entry.allowedPurpose, [
        'NanoFlow',
        'metadata.relation',
        'semantic',
        'boost',
      ]);
      if (!/\bproject[- ]semantic\b/i.test(allowedPurpose) && !/\bproject[- ]specific\b/i.test(allowedPurpose)) {
        errors.push(`${prefix} candidate-ranking allowedPurpose must stay project-semantic/project-specific`);
      }
      if (textClaimsGenericRankingAuthority(claimedOwnershipText)) {
        errors.push(`${prefix} candidate-ranking allowedPurpose must not claim generic native ranking/reordering authority`);
      }
      for (const surface of ['nativeJson', 'nativeMarkdown']) {
        if (outputSurface.includes(surface)) {
          errors.push(`${prefix} candidate-ranking outputSurface must not include ${surface}`);
        }
      }
    }

    if (entry.name === 'selectGraphResults()' || sourceSymbols.has('selectGraphResults')) {
      if (entry.duplicateBoundaryRole !== 'result-selection') {
        errors.push(`${prefix} result-selection hotspot must use duplicateBoundaryRole result-selection`);
      }
      if (!sourceSymbols.has('selectGraphResults')) {
        errors.push(`${prefix} result-selection sourceSymbols must include selectGraphResults`);
      }
      validateDedupManifestTextField(prefix, 'allowedPurpose', entry.allowedPurpose, [
        'NanoFlow',
        'metadata.relation',
        'exact filtering',
        'source-evidence',
      ]);
      if (textClaimsGenericSelectionAuthority(claimedOwnershipText)) {
        errors.push(`${prefix} result-selection allowedPurpose must not claim generic impact/search selection authority`);
      }
      if (entry.extensionFieldPolicy !== 'nanoflow-augmented') {
        errors.push(`${prefix} result-selection extensionFieldPolicy must be nanoflow-augmented`);
      }
    }
  }

  function textClaimsGenericRankingAuthority(text) {
    const normalized = String(text ?? '').toLowerCase();
    return /\breorder(?:ing)?\s+generic\b/.test(normalized)
      || /\bgeneric\s+(?:native\s+)?(?:search\s+)?ranking\b/.test(normalized)
      || /\bgeneric\s+lexical\s+ranking\b/.test(normalized)
      || /\bnative\s+ranking\b/.test(normalized);
  }

  function textClaimsGenericSelectionAuthority(text) {
    const normalized = String(text ?? '').toLowerCase();
    return /\bgeneric\s+(?:result\s+)?selection\b/.test(normalized)
      || /\bgeneric\s+search\s+selection\b/.test(normalized)
      || /\bgeneric\s+impact\s+traversal\b/.test(normalized)
      || /\bparallel\s+impact\s+traversal\b/.test(normalized);
  }

  function validateDedupManifestTextField(prefix, field, value, requiredTerms) {
    const text = String(value ?? '');
    if (!text.trim()) {
      errors.push(`${prefix} ${field} must be non-empty`);
      return;
    }
    for (const term of requiredTerms) {
      if (!text.includes(term)) {
        errors.push(`${prefix} ${field} missing ${term}`);
      }
    }
  }

  function validateDedupManifestSymbolList(prefix, field, values, options = {}) {
    if (!Array.isArray(values)) {
      errors.push(`${prefix} ${field} must be an array`);
      return;
    }
    if (options.requireNonEmpty && values.length === 0) {
      errors.push(`${prefix} ${field} must not be empty`);
    }
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`${prefix} ${field} entries must be non-empty strings`);
      }
    }
  }

  function validateDedupManifestHotspotSource(prefix, name, sourcePath, entry) {
    const absolutePath = path.join(root, sourcePath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`${prefix} sourcePath does not exist: ${sourcePath}`);
      return;
    }
    const sourceText = readDedupSourceText(sourcePath);
    const requiredSymbols = new Set([
      name,
      ...arrayOfStrings(entry?.sourceSymbols),
      ...arrayOfStrings(entry?.coveredChildSymbols),
    ]);
    for (const symbol of requiredSymbols) {
      const symbolName = normalizeDedupSymbolName(symbol);
      if (!symbolName) continue;
      const symbolPattern = new RegExp(`\\b(?:function|const|let|var)\\s+${escapeRegex(symbolName)}\\b`);
      if (!symbolPattern.test(sourceText)) {
        errors.push(`${prefix} sourcePath ${sourcePath} does not define ${symbolName}()`);
      }
    }
    const children = arrayOfStrings(entry?.coveredChildSymbols).map(normalizeDedupSymbolName).filter(Boolean);
    if (manifestSchemaVersion !== 2 || sourcePath !== DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH || children.length === 0) return;
    const sources = readDedupSourceFiles(sourcePath);
    const rootCallables = [...new Set([name, ...arrayOfStrings(entry?.sourceSymbols)].map(normalizeDedupSymbolName).filter(Boolean))].map(rootName => {
      const declarations = readDedupFunctionBodies(sourcePath, rootName);
      const candidates = declarations.some(declaration => declaration.sourcePath === sourcePath) ? declarations.filter(declaration => declaration.sourcePath === sourcePath) : declarations;
      return { sourcePath: candidates.length === 1 ? candidates[0].sourcePath : declarations.length === 0 ? sourcePath : '', name: rootName };
    });
    validateDedupCallbackReachability(prefix, name, children, { sources, entrySourcePath: sourcePath, rootCallables });
  }

  function validateDiscoveredDedupManifestCoverage(label, sourcePath, discoveryPattern, hotspots) {
    const absolutePath = path.join(root, sourcePath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} ${label} de-dup sourcePath does not exist: ${sourcePath}`);
      return;
    }
    const sourceText = readDedupSourceText(sourcePath);
    const discovered = new Set(
      [...sourceText.matchAll(discoveryPattern)]
        .map(match => match[1])
        .filter(Boolean),
    );
    const registered = new Set(
      hotspots
        .filter(entry => entry?.sourcePath === sourcePath)
        .flatMap(dedupManifestSymbols)
        .filter(Boolean),
    );
    const missing = [...discovered].filter(symbol => !registered.has(symbol)).sort();
    if (missing.length > 0) {
      errors.push(`${DEDUP_CONTRACT_MANIFEST_PATH} missing ${label} de-duplication sourceSymbols or coveredChildSymbols: ${missing.join(', ')}`);
    }
  }

  function validateRequiredDedupManifestChildOwnership(hotspots) {
    for (const [label, owner, sourcePath, requiredChildren] of DEDUP_CONTRACT_REQUIRED_COVERED_CHILD_OWNERS) {
      const allSymbols = hotspots
        .filter(entry => sourcePath === null || entry?.sourcePath === sourcePath)
        .flatMap(dedupManifestSymbols);
      const ownerCoveredSymbols = hotspots
        .filter(entry => entry?.name === owner && (sourcePath === null || entry?.sourcePath === sourcePath))
        .flatMap(entry => arrayOfStrings(entry?.coveredChildSymbols).map(normalizeDedupSymbolName));
      const ownershipScope = sourcePath === null ? 'and nowhere else' : `for ${sourcePath} and nowhere else in that sourcePath`;
      for (const symbol of requiredChildren) {
        const ownerCount = ownerCoveredSymbols.filter(candidate => candidate === symbol).length;
        const totalCount = allSymbols.filter(candidate => candidate === symbol).length;
        if (ownerCount !== 1 || totalCount !== 1) {
          errors.push(`required ${label} covered child ${symbol} must occur exactly once in ${owner}.coveredChildSymbols ${ownershipScope} (owner=${ownerCount}, total=${totalCount})`);
        }
      }
    }
  }

  function dedupManifestSymbols(entry) {
    return [
      entry?.name,
      ...arrayOfStrings(entry?.sourceSymbols),
      ...arrayOfStrings(entry?.coveredChildSymbols),
    ].map(normalizeDedupSymbolName);
  }

  function arrayOfStrings(values) {
    return Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
  }

  function normalizeDedupSymbolName(value) {
    return String(value ?? '').trim().replace(/\(\)$/, '');
  }

  Object.assign(runtime, {
    validateStructuredDedupContract, dedupSourceDeclaresSymbol, validateDedupManifestCapabilities, validateDedupManifestIncludesAll, validateDedupManifestGateList,
    validateDedupManifestHotspot, dedupManifestHotspotRequiresBoundaryFields, validateDedupManifestBoundaryFields, validateStrictNativeJsonFormatterBoundary, validateStrictNativeMarkdownFormatterBoundary,
    validateAugmentedMarkdownFormatterBoundary, validateAugmentedMarkdownFormatterSourceBody, validateStrictNativeMarkdownFormatterSourceBody, isStrictNativeMarkdownSourceSymbol, isNativeJsonFormatterSourceSymbol,
    validateQueryRankingAndResultSelectionBoundary, textClaimsGenericRankingAuthority, textClaimsGenericSelectionAuthority, validateDedupManifestTextField, validateDedupManifestSymbolList,
    validateDedupManifestHotspotSource, flushDedupCallbackReachability, validateDiscoveredDedupManifestCoverage,
    validateRequiredDedupManifestChildOwnership, dedupManifestSymbols, arrayOfStrings, normalizeDedupSymbolName,
  });
}

module.exports = { installDedupContractValidator, loadDedupContractManifest };
