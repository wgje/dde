import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { publishOverlayFixture } from './codegraph-overlay-generation-test-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(__filename);
type CallbackReachabilityModule = {
  analyzeCallbackReachability(input: {
    sources: Array<{ sourcePath: string; text: string }>;
    entrySourcePath: string;
    rootCallables?: Array<{ sourcePath: string; name: string }>;
    instrumentation?: { onProgramBuild?(): void; onFixedPointRun?(event?: { ownerIds: string[] }): void; onRootResolution?(): void };
  }): { reachableCallableNames: string[]; diagnostics: string[] };
  analyzeCallbackReachabilityBatch(input: {
    sources: Array<{ sourcePath: string; text: string }>;
    entrySourcePath: string;
    ownerRequests: Array<{ ownerId: string; rootCallables: Array<{ sourcePath: string; name: string }> }>;
    instrumentation?: {
      onProgramBuild?(): void;
      onRootResolution?(): void;
      onFixedPointRun?(event?: { ownerIds: string[] }): void;
    };
  }): { ownerResults: Array<{ ownerId: string; resolvedRoots: Array<{ identity: number }>; reachableCallableNames: string[];
    diagnostics: string[]; provenancePaths: Array<{ identity: number; path: Array<{ kind: string; targetIdentity: number }> }> }> };
};
type CallbackReachabilityInput = Parameters<CallbackReachabilityModule['analyzeCallbackReachability']>[0];
type DedupCallbackProbeRuntime = {
  errors: string[];
  flushDedupCallbackReachability?(): void;
  validateDedupCallbackReachability(
    prefix: string,
    ownerName: string,
    children: string[],
    input: CallbackReachabilityInput,
  ): void;
  validateDedupManifestHotspotSource(prefix: string, name: string, sourcePath: string, entry: Record<string, unknown>): void;
};
type DedupValidatorModule = {
  installDedupContractValidator(runtime: Record<string, unknown>): void;
};
const { analyzeCallbackReachability, analyzeCallbackReachabilityBatch } = require(
  path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-callback-reachability.cjs'),
) as CallbackReachabilityModule;
const dedupValidatorPath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-dedup-contract-validator.cjs');
const { installDedupContractValidator } = require(dedupValidatorPath) as DedupValidatorModule;
const facadePath = path.join(repoRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
const childContracts = [
  ['lib/codegraph-overlay-query-terms.mjs', 'queryTokens', 'queryTokensImpl'],
  ['lib/codegraph-overlay-native-codeblock-evidence.mjs', 'resolveNativeCodeBlockNode', 'resolveNativeCodeBlockNodeImpl'],
  ['lib/codegraph-overlay-candidate-index.mjs', 'queryOverlay', 'queryOverlayImpl'],
  ['lib/codegraph-overlay-candidate-index.mjs', 'scoreCandidate', 'scoreCandidateImpl'],
  ['lib/codegraph-overlay-semantic-selection.mjs', 'selectGraphResults', 'selectGraphResultsImpl'],
  ['lib/codegraph-overlay-context-assembly.mjs', 'buildSourceBlocks', 'buildSourceBlocksImpl'],
  ['lib/codegraph-overlay-native-codeblock-selection.mjs', 'buildNativeCodeBlocks', 'buildNativeCodeBlocksImpl'],
  ['lib/codegraph-overlay-output-projection.mjs', 'formatNativeMarkdown', 'formatNativeMarkdownImpl'],
  ['lib/codegraph-overlay-output-projection.mjs', 'formatStrictNativeMarkdown', 'formatStrictNativeMarkdownImpl'],
  ['lib/codegraph-overlay-output-projection.mjs', 'toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponseImpl'],
] as const;
const childPaths = [...new Set(childContracts.map(([relativePath]) => relativePath))];
const installerContracts = [
  ['lib/codegraph-overlay-query-terms.mjs', 'installQueryTerms', ['queryTokensImpl']],
  ['lib/codegraph-overlay-native-codeblock-evidence.mjs', 'installNativeCodeblockEvidence', ['resolveNativeCodeBlockNodeImpl']],
  ['lib/codegraph-overlay-candidate-index.mjs', 'installCandidateIndex', ['queryOverlayImpl', 'scoreCandidateImpl']],
  ['lib/codegraph-overlay-semantic-selection.mjs', 'installSemanticSelection', ['selectGraphResultsImpl']],
  ['lib/codegraph-overlay-context-assembly.mjs', 'installContextAssembly', ['buildSourceBlocksImpl']],
  ['lib/codegraph-overlay-native-codeblock-selection.mjs', 'installNativeCodeblockSelection', ['buildNativeCodeBlocksImpl']],
  ['lib/codegraph-overlay-output-projection.mjs', 'installOutputProjection', [
    'formatNativeMarkdownImpl',
    'formatStrictNativeMarkdownImpl',
    'toNativeJsonFormatterResponseImpl',
  ]],
] as const;
const dependencyLeafSources = [
  'scripts/lib/codegraph-overlay-baseline.cjs',
  'scripts/lib/codegraph-source-policy.cjs',
];
const currentReaderFixtureDependencies = [
  'lib/codegraph-overlay-current-receipt.cjs',
  'lib/codegraph-overlay-generation-format.cjs',
  'lib/codegraph-nanoflow-overlay-v1-schema.cjs',
  'lib/codegraph-nanoflow-overlay-v1-schema-typescript.cjs',
  'lib/codegraph-nanoflow-overlay-v1-schema-angular-support.cjs',
  'lib/codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs',
  'lib/codegraph-nanoflow-overlay-v1-schema-graph.cjs',
  'contracts/codegraph-overlay-generation-v1.json',
  'contracts/codegraph-nanoflow-overlay-v1.json',
] as const;
const exactOwnerChildren = [
  ['selectGraphResults', [
    'selectEntryPoints', 'compareSyncBodyKeywordEndpointPriority', 'compareSyncConfigKeywordEndpointPriority',
  ]],
  ['formatStrictNativeMarkdown', [
    'buildRelationshipGroups', 'capRelationshipGroups', 'scoreNativeProjectionItemForQuery',
    'compareNativeProjectionRelevance',
    'compareExactRelationEdgeCodeBlockOrder', 'compareNativeCodeBlockNodeOrder', 'formatEdgeSource',
    'buildBlastRadiusEntries', 'buildNotShownEntries',
    'suppressedExactRelationEntryPointIds', 'shouldSuppressBroadNativeCodeBlock', 'markdownRelatedSymbolKey',
    'compareProvenanceEdgeLineCodeBlockOrder',
  ]],
  ['toNativeJsonFormatterResponse', [
    'serializeNativeJsonNode', 'serializeNativeJsonEdge', 'serializeNativeJsonCodeBlock',
  ]],
] as const;
const tempRoots: string[] = [];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadInstrumentedDedupValidator(
  reachability: CallbackReachabilityModule,
): DedupValidatorModule {
  const source = fs.readFileSync(dedupValidatorPath, 'utf8');
  const schemaNeedle = '  let dependencyLeafSources = [], manifestSchemaVersion = 1;';
  const schemaTwo = source.replace(schemaNeedle, '  let dependencyLeafSources = [], manifestSchemaVersion = 2;');
  if (schemaTwo === source) throw new Error('unable to instrument schema-v2 callback reachability validation');
  const module = { exports: {} as DedupValidatorModule };
  const execute = compileFunction(
    schemaTwo,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename: dedupValidatorPath },
  );
  const localRequire = createRequire(dedupValidatorPath);
  const instrumentedRequire = (specifier: string): unknown => specifier === './codegraph-overlay-callback-reachability.cjs'
    ? reachability
    : localRequire(specifier);
  execute(module.exports, instrumentedRequire, module, dedupValidatorPath, path.dirname(dedupValidatorPath));
  return module.exports;
}

function createDedupCallbackProbeRuntime(sourceText = ''): Record<string, unknown> {
  return {
    fs: { ...fs, existsSync: () => true },
    path,
    root: repoRoot,
    errors: [],
    readJson: () => ({}),
    readText: () => sourceText,
    escapeRegex,
    extractFunctionBody: () => null,
    extractFunctionBodies: () => [],
    extractModuleSpecifiers: () => [],
    DEDUP_CONTRACT_QUERY_FORMATTER_SOURCE_PATH: 'entry.mjs',
  };
}

function installDedupCallbackProbe(
  reachability: CallbackReachabilityModule,
  sourceText = '',
): DedupCallbackProbeRuntime {
  const runtime = createDedupCallbackProbeRuntime(sourceText);
  loadInstrumentedDedupValidator(reachability).installDedupContractValidator(runtime);
  return runtime as unknown as DedupCallbackProbeRuntime;
}

function physicalLineCount(text: string): number {
  return text.length === 0 ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function writeMinimalOverlayFixture(): string {
  const fixture = publishOverlayFixture('example');
  tempRoots.push(fixture.root);
  return fixture.root;
}

function runFacade(
  root: string,
  projectionArgs: string[],
  options: { scriptPath?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(process.execPath, [
    options.scriptPath ?? facadePath,
    '--root', root,
    '--query', 'example',
    '--skip-refresh',
    ...projectionArgs,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
}

function declaredFunctionNames(source: string): Set<string> {
  return new Set([...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]));
}

function publishedRuntimeNames(source: string): string[] {
  const publication = source.match(/Object\.assign\(runtime,\s*\{([\s\S]*?)\}\);/);
  return publication?.[1].split(',')
    .map(value => value.trim())
    .filter(value => /^[A-Za-z_$][\w$]*$/.test(value)) ?? [];
}

function analyzeFixtureCallbackReachability(source: string, roots: string[] = ['owner']) {
  const sourcePath = 'fixture.mjs';
  return analyzeCallbackReachability({
    sources: [{ sourcePath, text: source }],
    entrySourcePath: sourcePath,
    rootCallables: roots.map(name => ({ sourcePath, name })),
  });
}

function reachableFixtureCallableNames(source: string, roots: string[]): Set<string> {
  const analysis = analyzeFixtureCallbackReachability(source, roots);
  expect(analysis.diagnostics).toEqual([]);
  return new Set(analysis.reachableCallableNames);
}

function liveFacadeReferenceNames(source: string): Set<string> {
  const parsed = ts.createSourceFile('facade.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
      || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) return;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'assign') return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) references.add(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return references;
}

function liveFacadeReachableChildNames(): Set<string> {
  const entrySourcePath = 'scripts/query-codegraph-nanoflow-overlay.mjs';
  const facadeSource = fs.readFileSync(facadePath, 'utf8');
  const facadeReferences = liveFacadeReferenceNames(facadeSource);
  const facadeRuntimeRoots: Array<{ sourcePath: string; name: string }> = [];
  const sources = [{ sourcePath: entrySourcePath, text: facadeSource }];
  for (const relativePath of childPaths) {
    const sourcePath = `scripts/${relativePath}`;
    const child = fs.readFileSync(path.join(repoRoot, 'scripts', relativePath), 'utf8');
    facadeRuntimeRoots.push(...publishedRuntimeNames(child).filter(name => facadeReferences.has(name))
      .map(name => ({ sourcePath, name })));
    sources.push({ sourcePath, text: child });
  }
  const rootCallables = [
    ...childContracts.map(([relativePath, wrapper]) => ({ sourcePath: `scripts/${relativePath}`, name: wrapper })),
    ...installerContracts.map(([relativePath, installer]) => ({ sourcePath: `scripts/${relativePath}`, name: installer })),
    ...facadeRuntimeRoots,
  ];
  const analysis = analyzeCallbackReachability({
    sources,
    entrySourcePath,
    rootCallables,
  });
  expect(analysis.diagnostics).toEqual([]);
  return new Set(analysis.reachableCallableNames);
}

function writeInstrumentedFacadeFixture(): { scriptPath: string; probePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-query-facade-probe-'));
  tempRoots.push(root);
  const scriptsRoot = path.join(root, 'scripts');
  const copiedPaths = [
    'query-codegraph-nanoflow-overlay.mjs',
    ...childPaths,
    ...dependencyLeafSources.map(relativePath => relativePath.replace(/^scripts\//, '')),
    ...currentReaderFixtureDependencies,
  ];
  for (const relativePath of copiedPaths) {
    const sourcePath = path.join(repoRoot, 'scripts', relativePath);
    const targetPath = path.join(scriptsRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }

  const scriptPath = path.join(scriptsRoot, 'query-codegraph-nanoflow-overlay.mjs');
  const probePath = path.join(root, 'facade-delegates.log');
  let source = fs.readFileSync(scriptPath, 'utf8');
  for (const [, wrapper] of childContracts) {
    const pattern = new RegExp(`(function\\s+${escapeRegex(wrapper)}\\s*\\([^)]*\\)\\s*\\{)`);
    const instrumented = source.replace(
      pattern,
      `$1 fs.appendFileSync(process.env.NANOFLOW_FACADE_PROBE_PATH, '${wrapper}\\n');`,
    );
    if (instrumented === source) throw new Error(`unable to instrument facade wrapper ${wrapper}`);
    source = instrumented;
  }
  fs.writeFileSync(scriptPath, source);
  return { scriptPath, probePath };
}

function runInstallerContractProbe(relativePath: string, installerName: string, delegateNames: readonly string[]) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts', relativePath)).href;
  const probe = [
    `const module = await import(${JSON.stringify(moduleUrl)});`,
    `const delegates = ${JSON.stringify(delegateNames)};`,
    'const preinstall = {};',
    'for (const name of delegates) {',
    '  try { module[name](); } catch (error) { preinstall[name] = error.message; }',
    '}',
    `module[${JSON.stringify(installerName)}]({});`,
    'let duplicate;',
    `try { module[${JSON.stringify(installerName)}]({}); } catch (error) { duplicate = error.message; }`,
    'console.log(JSON.stringify({ preinstall, duplicate }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as { preinstall: Record<string, string>; duplicate?: string };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('CodeGraph overlay query facade delegation', () => {
  it.each([
    ['function', 'function dormant() { coveredChild(); }'],
    ['arrow', 'const dormant = () => coveredChild();'],
    ['method', 'const dormant = { run() { coveredChild(); } };'],
  ])('does not flatten an uncalled nested %s body into its reachable owner', (_kind, nested) => {
    const source = `function owner() { ${nested} } function coveredChild() {}`;

    expect(reachableFixtureCallableNames(source, ['owner'])).not.toContain('coveredChild');
  });

  it('follows explicitly called nested callable scopes and their transitive calls', () => {
    const source = [
      'function owner() {',
      '  function first() {',
      '    const second = () => {',
      '      const helper = { run() { coveredChild(); } };',
      '      helper.run();',
      '    };',
      '    second();',
      '  }',
      '  first();',
      '}',
      'function coveredChild() {}',
    ].join('\n');

    expect(reachableFixtureCallableNames(source, ['owner'])).toContain('coveredChild');
  });

  it.each([
    [
      'an explicitly invoked local callback parameter',
      "function owner() { function profilePhase(label, operation) { return operation(); } profilePhase('x', () => coveredChild()); } function coveredChild() {}",
    ],
    [
      'the eager map callback position through a local Array transform binding',
      'function owner() { const values = [1]; const filtered = values.filter(Boolean); filtered.map(() => coveredChild()); } function coveredChild() {}',
    ],
    [
      'an invoked local parameter with a named nested callback',
      "function owner() { function profilePhase(label, operation) { return operation(); } function callback() { coveredChild(); } profilePhase('x', callback); } function coveredChild() {}",
    ],
    [
      'the eager map position with a named nested callback',
      'function owner() { const callback = () => coveredChild(); [1].map(callback); } function coveredChild() {}',
    ],
  ])('follows a callback through %s', (_label, source) => {
    expect(reachableFixtureCallableNames(source, ['owner'])).toContain('coveredChild');
  });

  it.each([
    ['unknown consumer', 'unknownConsumer(() => coveredChild());'],
    ['unknown consumer with a named nested callback', 'function callback() { coveredChild(); } unknownConsumer(callback);'],
    ['unknown property consumer with a named nested callback', 'function callback() { coveredChild(); } values.consume(callback);'],
    ['unknown map receiver', 'unknown.map(() => coveredChild());'],
    ...(['map', 'filter', 'sort'] as const).flatMap(method => [
      [`local object custom ${method}`, `const values = { ${method}(callback) {} }; values.${method}(() => coveredChild());`] as const,
      [`local class custom ${method}`, `class Values { ${method}(callback) {} } new Values().${method}(() => coveredChild());`] as const,
    ]),
    ['Delegate assignment outside an installer', 'let formatterDelegate; formatterDelegate = coveredChild;'],
    ['assignment', 'const callback = () => coveredChild();'],
    ['return', 'function makeCallback() { return () => coveredChild(); } makeCallback();'],
    ['storage', 'const callbacks = { callback: () => coveredChild() }; void callbacks;'],
    ['publication', 'const callback = () => coveredChild(); Object.assign(runtime, { callback });'],
  ] as Array<[string, string]>)('keeps a callback unreachable when it is only used by %s', (_label, body) => {
    const source = `function owner() { ${body} } function coveredChild() {}`;

    expect(reachableFixtureCallableNames(source, ['owner'])).not.toContain('coveredChild');
  });

  it.each([
    ['unknown consumer', 'unknownConsumer(topLevelCallback);', ''],
    ['assignment', 'const callback = topLevelCallback; void callback;', ''],
    ['return', 'return topLevelCallback;', ''],
    ['storage', 'const callbacks = { topLevelCallback }; void callbacks;', ''],
    ['publication', 'Object.assign(runtime, { topLevelCallback });', ''],
    ['export', '', 'export default topLevelCallback;'],
  ])('keeps a top-level named callback unreachable through %s', (_label, ownerBody, rootSuffix) => {
    const source = `function owner() { ${ownerBody} } function topLevelCallback() { coveredChild(); } function coveredChild() {} ${rootSuffix}`;
    const roots = ['owner', ...liveFacadeReferenceNames(source)];

    expect(reachableFixtureCallableNames(source, roots)).not.toContain('coveredChild');
  });

  it('does not treat literal call(symbol) as a runtime edge outside an installer scope', () => {
    const source = 'function owner() { call(\'coveredChild\'); } function coveredChild() {}';

    expect(reachableFixtureCallableNames(source, ['owner'])).not.toContain('coveredChild');
  });

  it('does not treat an export assignment as a live facade reference', () => {
    const source = 'function coveredChild() {} export default coveredChild;';

    expect(liveFacadeReferenceNames(source)).not.toContain('coveredChild');
  });

  it('keeps installer runtime references restricted to literal call(symbol) edges', () => {
    const sourceFor = (argument: string) => [
      'function installer(runtime) {',
      '  const call = name => (...values) => runtime[name](...values);',
      '  const name = \'coveredChild\';',
      `  call(${argument});`,
      '}',
      'function coveredChild() {}',
    ].join('\n');

    expect(reachableFixtureCallableNames(sourceFor("'coveredChild'"), ['installer'])).toContain('coveredChild');
    expect(reachableFixtureCallableNames(sourceFor('name'), ['installer'])).not.toContain('coveredChild');
    expect(reachableFixtureCallableNames(sourceFor('`coveredChild`'), ['installer'])).not.toContain('coveredChild');
  });

  it('models only installer Delegate assignment wiring as an execution edge', () => {
    const installer = [
      'let formatterDelegate;',
      'function installer(runtime) {',
      '  const call = name => (...values) => runtime[name](...values);',
      '  formatterDelegate = coveredChild;',
      '}',
      'function coveredChild() {}',
    ].join('\n');
    const arbitrary = installer.replace('formatterDelegate = coveredChild;', 'callback = coveredChild;');

    expect(reachableFixtureCallableNames(installer, ['installer'])).toContain('coveredChild');
    expect(reachableFixtureCallableNames(arbitrary, ['installer'])).not.toContain('coveredChild');
  });

  it.each([
    'map', 'sort', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast',
    'findLastIndex', 'flatMap', 'forEach', 'reduce', 'reduceRight',
  ])('models eager Array.%s arg0 named callbacks as execution edges', method => {
    const source = `function owner() { function callback() { coveredChild(); } [1].${method}(callback); } function coveredChild() {}`;

    expect(reachableFixtureCallableNames(source, ['owner'])).toContain('coveredChild');
  });

  it.each([
    [
      'all reachable call arguments prove an Array parameter',
      'function consume(items, callback) { items.map(callback); } function owner() { consume([1], callback); consume([2], callback); } function callback() { coveredChild(); } function coveredChild() {}',
      'function consume(items, callback) { items.map(callback); } function owner() { consume([1], callback); consume(unknown, callback); } function callback() { coveredChild(); } function coveredChild() {}',
    ],
    [
      'all relevant returns prove an Array call result',
      'function values(flag) { if (flag) return [1]; return [2]; } function owner() { values(true).map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
      'function values(flag) { if (flag) return [1]; return unknown; } function owner() { values(true).map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
    ],
    [
      'rest and spread preserve proven call arguments',
      'function consume(items, callback) { items.map(callback); } function forward(...values) { consume(...values); } function owner() { forward([1], callback); } function callback() { coveredChild(); } function coveredChild() {}',
      'function consume(items, callback) { items.map(callback); } function forward(...values) { consume(...values); } function owner() { forward(unknown, callback); } function callback() { coveredChild(); } function coveredChild() {}',
    ],
    [
      'static object properties and tuple destructuring preserve Array values',
      'function owner() { const context = { pair: [0, [1]] }; const { pair } = context; const [, items] = pair; items.map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
      'function owner() { const context = { pair: [0, unknown] }; const { pair } = context; const [, items] = pair; items.map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
    ],
    [
      'native Map entries preserve proven Array tuple values',
      "function owner() { const groups = new Map(); const items = [1]; groups.set('x', items); [...groups.entries()].map(([, group]) => group.map(callback)); } function callback() { coveredChild(); } function coveredChild() {}",
      "function owner() { const groups = new Map(); const items = unknown; groups.set('x', items); [...groups.entries()].map(([, group]) => group.map(callback)); } function callback() { coveredChild(); } function coveredChild() {}",
    ],
    [
      'an exact custom same-name method invokes its callback formal',
      'function owner() { const values = { map(callback) { callback(); } }; values.map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
      'function owner() { const values = { map(callback) { void callback; } }; values.map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
    ],
    [
      'installer delegate argument flow reaches the installed implementation',
      "let renderDelegate; function installedDelegate(value) { return value; } function render(...values) { return installedDelegate(renderDelegate)(...values); } function install(runtime) { const call = name => (...values) => runtime[name](...values); renderDelegate = renderImpl; } function renderImpl(items, callback) { items.map(callback); } function owner() { install({}); render([1], callback); } function callback() { coveredChild(); } function coveredChild() {}",
      "let renderDelegate; function installedDelegate(value) { return value; } function render(...values) { return installedDelegate(renderDelegate)(...values); } function install(runtime) { const call = name => (...values) => runtime[name](...values); renderDelegate = unknownImpl; } function renderImpl(items, callback) { items.map(callback); } function owner() { install({}); render([1], callback); } function callback() { coveredChild(); } function coveredChild() {}",
    ],
    [
      'a seeded callable cycle saturates without losing Array facts',
      'function owner() { loop(); } function loop() { owner(); [1].map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
      'function owner() { loop(); } function loop() { owner(); unknown.map(callback); } function callback() { coveredChild(); } function coveredChild() {}',
    ],
  ])('proves %s and fails closed after its one-edge mutation', (_label, positive, mutation) => {
    expect(reachableFixtureCallableNames(positive, ['owner'])).toContain('coveredChild');
    expect(reachableFixtureCallableNames(mutation, ['owner'])).not.toContain('coveredChild');
  });

  it('keeps unknown receivers, computed properties, and unseeded cycles unreachable', () => {
    const source = 'function owner() { cycle(); } function cycle() { owner(); context[key].map(callback); } function callback() { coveredChild(); } function coveredChild() {}';

    expect(analyzeFixtureCallbackReachability(source, []).reachableCallableNames).not.toContain('coveredChild');
    expect(reachableFixtureCallableNames(source, ['owner'])).not.toContain('coveredChild');
  });

  it('keeps callback reachability roots local to each hotspot owner', () => {
    const batches: Parameters<CallbackReachabilityModule['analyzeCallbackReachabilityBatch']>[0][] = [];
    let singleCallCount = 0;
    const source = [
      'function ownerA() {} function ownerAlias() { childA(); } function childA() {}',
      'function ownerB() {} function ownerC() { childB(); } function childB() {}',
      'function ownerD() { childD(); } function childD() {}',
      'function ownerE() { childE(); } function childE() {}',
      'function ownerF() { childF(); } function childF() {}',
    ].join('\n');
    const runtime = installDedupCallbackProbe({
      analyzeCallbackReachability: input => { singleCallCount += 1; return analyzeCallbackReachability(input); },
      analyzeCallbackReachabilityBatch: input => { batches.push(input); return analyzeCallbackReachabilityBatch(input); },
    }, source);

    runtime.validateDedupManifestHotspotSource('hotspot A', 'ownerA()', 'entry.mjs', {
      sourceSymbols: ['ownerA()', 'ownerAlias()'], coveredChildSymbols: ['childA()'],
    });
    runtime.validateDedupManifestHotspotSource('hotspot B', 'ownerB()', 'entry.mjs', {
      sourceSymbols: ['ownerB()'], coveredChildSymbols: ['childB()'],
    });
    for (const owner of ['C', 'D', 'E', 'F']) runtime.validateDedupManifestHotspotSource(
      `hotspot ${owner}`, `owner${owner}()`, 'entry.mjs', {
        sourceSymbols: [`owner${owner}()`], coveredChildSymbols: [`child${owner === 'C' ? 'B' : owner}()`],
      },
    );

    runtime.flushDedupCallbackReachability?.();
    expect({ singleCallCount, batchCallCount: batches.length }).toEqual({ singleCallCount: 0, batchCallCount: 1 });
    expect(batches[0].ownerRequests.map(request => request.rootCallables)).toEqual([
      [{ sourcePath: 'entry.mjs', name: 'ownerA' }, { sourcePath: 'entry.mjs', name: 'ownerAlias' }],
      [{ sourcePath: 'entry.mjs', name: 'ownerB' }],
      ...['C', 'D', 'E', 'F'].map(owner => [{ sourcePath: 'entry.mjs', name: `owner${owner}` }]),
    ]);
    expect(runtime.errors).not.toContain(
      'hotspot A covered child childA must be transitively reachable from hotspot owner ownerA',
    );
    expect(runtime.errors).toContain(
      'hotspot B covered child childB must be transitively reachable from hotspot owner ownerB',
    );
    expect(runtime.errors).not.toContain(
      'hotspot C covered child childB must be transitively reachable from hotspot owner ownerC',
    );
  });

  it('builds and solves six owner-isolated value flows once', () => {
    const sourcePath = 'fixture.mjs';
    const source = [
      'function invoke(callback) { callback(); } function ownerCall() { invoke(childCall); } function childCall() {}',
      'function ownerUnknown() { unknownConsumer(childUnknown); } function childUnknown() {}',
      'function values() { return [1]; } function ownerReturn() { values().map(childReturn); } function childReturn() {}',
      'function ownerBadReturn() { unknownValues().map(childBadReturn); } function childBadReturn() {}',
      'function ownerArray() { [1].map(childArray); } function childArray() {}',
      'const custom = { map(callback) { void callback; } }; function ownerCustom() { custom.map(childCustom); } function childCustom() {}',
    ].join('\n');
    const ownerIds = ['ownerCall', 'ownerUnknown', 'ownerReturn', 'ownerBadReturn', 'ownerArray', 'ownerCustom'];
    let programBuildCount = 0;
    let fixedPointRunCount = 0;
    const fixedPointOwners: string[][] = [];
    const batch = analyzeCallbackReachabilityBatch({
      sources: [{ sourcePath, text: source }], entrySourcePath: sourcePath,
      ownerRequests: ownerIds.map(ownerId => ({ ownerId, rootCallables: [{ sourcePath, name: ownerId }] })),
      instrumentation: {
        onProgramBuild: () => { programBuildCount += 1; },
        onFixedPointRun: event => { fixedPointRunCount += 1; fixedPointOwners.push(event?.ownerIds ?? []); },
      },
    });
    const reachable = new Map(batch.ownerResults.map(result => [result.ownerId, new Set(result.reachableCallableNames)]));
    expect({ programBuildCount, fixedPointRunCount }).toEqual({ programBuildCount: 1, fixedPointRunCount: 1 });
    expect(fixedPointOwners).toEqual([ownerIds]);
    expect(batch.ownerResults.map(result => result.ownerId)).toEqual(ownerIds);
    expect(batch.ownerResults.every(result => result.resolvedRoots.length === 1 && result.diagnostics.length === 0)).toBe(true);
    expect(reachable.get('ownerCall')).toContain('childCall');
    expect(reachable.get('ownerReturn')).toContain('childReturn');
    expect(reachable.get('ownerArray')).toContain('childArray');
    for (const [owner, child] of [['ownerUnknown', 'childUnknown'], ['ownerBadReturn', 'childBadReturn'], ['ownerCustom', 'childCustom']]) {
      expect(reachable.get(owner)).not.toContain(child);
    }
    expect(reachable.get('ownerCall')).not.toContain('childArray');
  });

  it('resolves each exact root once and fails only invalid owners closed', () => {
    const sourcePath = 'fixture.mjs';
    const source = 'function valid() { child(); } function child() {} function duplicate() {} function duplicate() {}';
    let rootResolutionCount = 0;
    const batch = analyzeCallbackReachabilityBatch({
      sources: [{ sourcePath, text: source }], entrySourcePath: sourcePath,
      ownerRequests: [
        { ownerId: 'missing', rootCallables: [{ sourcePath, name: 'missing' }] },
        { ownerId: 'ambiguous', rootCallables: [{ sourcePath, name: 'duplicate' }] },
        { ownerId: 'valid-a', rootCallables: [{ sourcePath, name: 'valid' }] },
        { ownerId: 'valid-b', rootCallables: [{ sourcePath, name: 'valid' }] },
      ],
      instrumentation: { onRootResolution: () => { rootResolutionCount += 1; } },
    });
    const [missing, ambiguous, validA, validB] = batch.ownerResults;
    expect(rootResolutionCount).toBe(3);
    expect(missing.diagnostics).toEqual(['root not found: fixture.mjs#missing']);
    expect(ambiguous.diagnostics).toEqual(['ambiguous root: fixture.mjs#duplicate (2 matches)']);
    expect(missing.reachableCallableNames).toEqual([]);
    expect(ambiguous.reachableCallableNames).toEqual([]);
    expect(validA.resolvedRoots).toHaveLength(1);
    expect(validA.reachableCallableNames).toContain('child');
    expect(validB.reachableCallableNames).toEqual(validA.reachableCallableNames);
  });

  it('keeps the captured exact 19 helpers reachable only from their declared owner provenance', () => {
    const sourcePath = 'fixture.mjs';
    const source = exactOwnerChildren.flatMap(([owner, children]) => [
      `function make${owner}Items() { return [1]; }`,
      `function ${owner}(items) { ${children.map(child => `items.map(${child});`).join(' ')} }`,
      `${owner}(make${owner}Items());`,
      ...children.map(child => `function ${child}() {}`),
    ]).join('\n');
    const ownerRequests = exactOwnerChildren.map(([ownerId]) => ({ ownerId,
      rootCallables: [{ sourcePath, name: ownerId }] }));
    const batch = analyzeCallbackReachabilityBatch({
      sources: [{ sourcePath, text: source }], entrySourcePath: sourcePath,
      ownerRequests,
    });
    const byOwner = new Map(batch.ownerResults.map(result => [result.ownerId, result]));
    expect(batch.ownerResults.flatMap(result => result.diagnostics)).toEqual([]);
    for (const [owner, children] of exactOwnerChildren) {
      const result = byOwner.get(owner)!;
      expect(result.resolvedRoots).toHaveLength(1);
      expect(result.provenancePaths.every(entry => entry.path.length === 0
        || entry.path[0].targetIdentity === result.resolvedRoots[0].identity)).toBe(true);
      for (const child of children) {
        expect(result.reachableCallableNames, `${owner} -> ${child}`).toContain(child);
        for (const other of batch.ownerResults.filter(candidate => candidate.ownerId !== owner)) {
          expect(other.reachableCallableNames, `${other.ownerId} !-> ${child}`).not.toContain(child);
        }
      }
    }
    for (const [mutatedOwner, children] of exactOwnerChildren) {
      const mutation = source.replace(`function make${mutatedOwner}Items() { return [1]; }`,
        `function make${mutatedOwner}Items() { return unknown; }`);
      const result = analyzeCallbackReachabilityBatch({
        sources: [{ sourcePath, text: mutation }], entrySourcePath: sourcePath, ownerRequests,
      }).ownerResults.find(candidate => candidate.ownerId === mutatedOwner)!;
      expect(result.diagnostics).toEqual([]);
      for (const child of children) expect(result.reachableCallableNames,
        `${mutatedOwner} mutation !-> ${child}`).not.toContain(child);
    }
  });

  it('rejects child helpers that are published but unreachable from live facade delegates', () => {
    const reachable = liveFacadeReachableChildNames();
    const facadeReferences = liveFacadeReferenceNames(fs.readFileSync(facadePath, 'utf8'));
    const unreachable = childPaths.flatMap(relativePath => {
      const source = fs.readFileSync(path.join(repoRoot, 'scripts', relativePath), 'utf8');
      return publishedRuntimeNames(source)
        .filter(name => facadeReferences.has(name))
        .filter(name => !reachable.has(name))
        .map(name => `${relativePath}:${name}`);
    });

    expect(unreachable).toEqual([]);
  });

  it('keeps every owned child reachable through a live facade wrapper', () => {
    const facade = fs.readFileSync(facadePath, 'utf8');

    for (const relativePath of childPaths) {
      const childPath = path.join(repoRoot, 'scripts', relativePath);
      expect(fs.existsSync(childPath), `missing owned child ${relativePath}`).toBe(true);
      expect(facade).toContain(`./${relativePath.replace(/\\/g, '/')}`);
    }

    for (const [, wrapper, delegate] of childContracts) {
      expect(facade).toMatch(new RegExp(
        `function\\s+${escapeRegex(wrapper)}\\s*\\([^)]*\\)\\s*\\{[^}]*\\b${escapeRegex(delegate)}\\s*\\(`,
        's',
      ));
    }
  });

  it('executes every authoritative facade delegate on a real CLI projection path', () => {
    const root = writeMinimalOverlayFixture();
    const probe = writeInstrumentedFacadeFixture();
    const projectionArgs = [
      ['--json'],
      ['--json', '--native-json'],
      ['--native-markdown'],
      [],
    ];

    for (const args of projectionArgs) {
      const result = runFacade(root, args, {
        scriptPath: probe.scriptPath,
        env: { NANOFLOW_FACADE_PROBE_PATH: probe.probePath },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
    }

    const observed = new Set(fs.readFileSync(probe.probePath, 'utf8').trim().split(/\r?\n/));
    expect(observed).toEqual(new Set(childContracts.map(([, wrapper]) => wrapper)));
  });

  it('owns each facade delegate implementation in exactly its declared child', () => {
    const declarationsByChild = new Map(childPaths.map(relativePath => [
      relativePath,
      declaredFunctionNames(fs.readFileSync(path.join(repoRoot, 'scripts', relativePath), 'utf8')),
    ]));

    for (const [expectedOwner, wrapper] of childContracts) {
      const actualOwners = childPaths.filter(relativePath => declarationsByChild.get(relativePath)?.has(wrapper));
      expect(actualOwners, `${wrapper} implementation owner`).toEqual([expectedOwner]);
    }
  });

  it.each(installerContracts)(
    '%s fails clearly before installation and rejects duplicate installation',
    (relativePath, installerName, delegateNames) => {
      const observed = runInstallerContractProbe(relativePath, installerName, delegateNames);

      for (const delegateName of delegateNames) {
        expect(observed.preinstall[delegateName]).toBe(
          `${delegateName} requires ${installerName}() before use`,
        );
      }
      expect(observed.duplicate).toBe(`${installerName}() may only be called once`);
    },
  );

  it('keeps argv, stdout, publication, and CLI lifecycle ownership in the facade', () => {
    const facade = fs.readFileSync(facadePath, 'utf8');
    expect(facade).toContain('process.argv');
    expect(facade).toContain('process.stdout');
    expect(facade).toContain('readOverlayCurrentReceipt(root)');
    expect(facade).toContain("import currentReceiptReader from './lib/codegraph-overlay-current-receipt.cjs';");

    for (const relativePath of childPaths) {
      const childPath = path.join(repoRoot, 'scripts', relativePath);
      expect(fs.existsSync(childPath), `missing owned child ${relativePath}`).toBe(true);
      if (!fs.existsSync(childPath)) continue;
      const child = fs.readFileSync(childPath, 'utf8');
      expect(child, relativePath).not.toMatch(/process\.argv|process\.stdout|function\s+parseArgs\b/);
      expect(physicalLineCount(child), relativePath).toBeLessThan(800);
      expect(child.split(/\r?\n/).length, relativePath).toBeLessThan(800);
    }
    expect(physicalLineCount(facade)).toBeLessThan(800);
    expect(facade.split(/\r?\n/).length).toBeLessThan(800);
  });

  it('attributes baseline and SourcePolicy as dependency leaves rather than owned children', () => {
    const contract = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'docs', 'codegraph-nanoflow-dedup-contract.json'),
      'utf8',
    )) as { dependencyLeafSources?: string[] };

    expect(contract.dependencyLeafSources).toEqual(dependencyLeafSources);
    for (const leaf of dependencyLeafSources) {
      expect(childPaths).not.toContain(leaf.replace(/^scripts\//, ''));
    }
  });

  it('invokes the split facade for augmented, strict native JSON, and strict native Markdown projections', () => {
    const root = writeMinimalOverlayFixture();
    const augmented = runFacade(root, ['--json']);
    const nativeJson = runFacade(root, ['--json', '--native-json']);
    const nativeMarkdown = runFacade(root, ['--native-markdown']);

    for (const result of [augmented, nativeJson, nativeMarkdown]) {
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
    }
    expect(JSON.parse(augmented.stdout)).toMatchObject({ query: 'example', count: 1 });
    expect(JSON.parse(nativeJson.stdout)).toMatchObject({ query: 'example' });
    expect(nativeMarkdown.stdout).toContain('## Code Context');
    expect(nativeMarkdown.stdout).toContain('### Related Symbols');
  });
});
