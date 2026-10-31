import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupCodegraphOverlayDocsFixtures,
  makeFixture,
  repoRoot,
  runValidator,
} from './validate-codegraph-overlay-docs.spec-helpers';

const require = createRequire(import.meta.url);
const rootManifestName = 'codegraph-nanoflow-dedup-contract.json';
const androidPartName = 'codegraph-nanoflow-dedup-contract-android-kotlin.json';
const androidHotspotNames = [
  'collectAndroid()',
  'readAndroidKotlinFileSymbols()',
  'readAndroidKotlinMethodCalls()',
  'resolveAndroidKotlinCallTarget()',
  'resolveAndroidKotlinTypeTarget()',
  'addAndroidKotlinTypeReferenceEdges()',
  'addAndroidKotlinOverrideEdges()',
  'addAndroidKotlinAnnotationEdges()',
] as const;
const androidHotspotHashes = [
  'fe4ec36b770ed248943032c849227c7ca4c04b78bd1d3e3f7b3a0e881befc112',
  'ffcc42ce2cf1a693b210ed9b279254b3087597a91db126da7c39571531aff6ac',
  '6c3a20c49d59b53344d02e2288c5b3b6840f48344fd961be844c93ae89100d7e',
  '5cfe32d49cb2f1056abed44776f60150d8e6c66a5fa123129d9170ff6d492632',
  'a224ccc3da96825e122b5dbae28606d6e95d78dc5580b82a9c49234ecb433afb',
  '03ecb536e343bff99f9f9f5ee0f468e39a9d57373b781cabbf8b472863ad9ea9',
  '8d2a9fd335d0a22adc4348417bc6a1d05cfc63e6b91d0a6779874a716de874ba',
  '5adb2cf5e357811de110e8fd566b01eb0e40c0eaab2efdbd0cf1e7d6ff10415b',
] as const;
const validatorChildren = [
  'scripts/lib/codegraph-overlay-doc-contract-validator.cjs',
  'scripts/lib/codegraph-overlay-dedup-contract-validator.cjs',
  'scripts/lib/codegraph-overlay-issue-contract-validator.cjs',
] as const;

type Hotspot = { name: string; [key: string]: unknown };
type DedupManifest = {
  schemaVersion: number;
  hotspots: Hotspot[];
  hotspotParts?: string[];
  [key: string]: unknown;
};

function manifestPath(root: string): string {
  return path.join(root, 'docs', rootManifestName);
}

function readManifest(root: string): DedupManifest {
  return JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')) as DedupManifest;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function wireFixtureCoveredChildren(root: string, hotspots: Hotspot[]): void {
  for (const hotspot of hotspots) {
    const children = Array.isArray(hotspot.coveredChildSymbols)
      ? hotspot.coveredChildSymbols.filter((value): value is string => typeof value === 'string')
      : [];
    if (children.length === 0 || typeof hotspot.sourcePath !== 'string') continue;
    const owners = Array.isArray(hotspot.sourceSymbols)
      ? hotspot.sourceSymbols.filter((value): value is string => typeof value === 'string')
      : [];
    const owner = owners[0] ?? hotspot.name.replace(/\(\)$/, '');
    const sourcePath = path.join(root, hotspot.sourcePath);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const declaration = `function ${owner}() {}`;
    const wired = `function ${owner}() { ${children.map(child => `${child}();`).join(' ')} }`;
    expect(source, `fixture owner ${owner}`).toContain(declaration);
    fs.writeFileSync(sourcePath, source.replace(declaration, `${wired}\n${owner}();`));
  }
}

function convertFixtureToSchemaV2(root: string): { rootManifest: DedupManifest; androidHotspots: Hotspot[] } {
  const rootManifest = readManifest(root);
  const androidNames = new Set<string>(androidHotspotNames);
  const androidHotspots = rootManifest.hotspots.filter(entry => androidNames.has(entry.name));
  rootManifest.schemaVersion = 2;
  rootManifest.hotspotParts = [androidPartName];
  rootManifest.dependencyLeafSources = [
    'scripts/lib/codegraph-overlay-baseline.cjs',
    'scripts/lib/codegraph-source-policy.cjs',
  ];
  rootManifest.hotspots = rootManifest.hotspots.filter(entry => !androidNames.has(entry.name));
  wireFixtureCoveredChildren(root, [...rootManifest.hotspots, ...androidHotspots]);
  writeJson(manifestPath(root), rootManifest);
  writeJson(path.join(root, 'docs', androidPartName), { schemaVersion: 1, hotspots: androidHotspots });
  return { rootManifest, androidHotspots };
}

function hashHotspot(entry: Hotspot): string {
  return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

function appendFormatterClosureFixture(root: string, importSyntax: string, childSource: string): void {
  const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  const childPath = path.join(root, 'scripts', 'lib', 'type-edge-output-projection.mjs');
  fs.appendFileSync(facadePath, `${importSyntax}\n`);
  fs.mkdirSync(path.dirname(childPath), { recursive: true });
  fs.writeFileSync(childPath, `${childSource}\n`);
}

afterEach(() => {
  cleanupCodegraphOverlayDocsFixtures();
});

describe('validate-codegraph-overlay-docs import closure and partitioned manifest', { timeout: 30_000 }, () => {
  it('loads the three bounded validator children without giving them CLI publication ownership', () => {
    const facade = fs.readFileSync(path.join(repoRoot, 'scripts', 'validate-codegraph-overlay-docs.cjs'), 'utf8');
    for (const relativePath of validatorChildren) {
      expect(facade).toContain(`./${relativePath.replace(/^scripts\//, '')}`);
      const absolutePath = path.join(repoRoot, relativePath);
      expect(fs.existsSync(absolutePath), `missing validator child ${relativePath}`).toBe(true);
      const child = fs.readFileSync(absolutePath, 'utf8');
      expect(child, relativePath).not.toMatch(/process\.argv|process\.stdout|console\.(?:log|error)|process\.exit/);
      expect(child.replace(/\r?\n$/, '').split(/\r?\n/).length, relativePath).toBeLessThan(800);
      expect(child.split(/\r?\n/).length, relativePath).toBeLessThan(800);
    }
    expect(facade.replace(/\r?\n$/, '').split(/\r?\n/).length).toBeLessThan(800);
    expect(facade.split(/\r?\n/).length).toBeLessThan(800);
  });

  it('preserves schema-v1 fixture compatibility', () => {
    const root = makeFixture();
    const result = runValidator(root);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('loads schema-v2 hotspotParts in declared order and flattens deterministically', () => {
    const root = makeFixture();
    const { rootManifest, androidHotspots } = convertFixtureToSchemaV2(root);
    const secondPartName = 'codegraph-nanoflow-dedup-contract-query.json';
    const movedQueryHotspot = rootManifest.hotspots.pop();
    expect(movedQueryHotspot).toBeDefined();
    rootManifest.hotspotParts = [androidPartName, secondPartName];
    writeJson(manifestPath(root), rootManifest);
    writeJson(path.join(root, 'docs', secondPartName), { schemaVersion: 1, hotspots: [movedQueryHotspot] });

    const modulePath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-dedup-contract-validator.cjs');
    expect(fs.existsSync(modulePath), 'missing partition-aware de-dup validator child').toBe(true);
    const { loadDedupContractManifest } = require(modulePath) as {
      loadDedupContractManifest(root: string, relativePath: string): { hotspots: Hotspot[]; partPaths: string[] };
    };
    const loaded = loadDedupContractManifest(root, `docs/${rootManifestName}`);

    expect(loaded.partPaths).toEqual([
      `docs/${androidPartName}`,
      `docs/${secondPartName}`,
    ]);
    expect(loaded.hotspots.map(entry => entry.name)).toEqual([
      ...rootManifest.hotspots.map(entry => entry.name),
      ...androidHotspots.map(entry => entry.name),
      movedQueryHotspot?.name,
    ]);
    const result = runValidator(root);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects covered children that exist in the import closure but are unreachable from their hotspot owner', () => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    expect(hotspot).toBeDefined();
    hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('publishedOnlyFormatterHelper');
    writeJson(manifestPath(root), rootManifest);
    appendFormatterClosureFixture(root,
      [
        "import { publishedOnlyFormatterHelper } from './lib/type-edge-output-projection.mjs';",
        '// publishedOnlyFormatterHelper',
        "const formatterHelperLabel = 'publishedOnlyFormatterHelper';",
        'const formatterHelperMetadata = { publishedOnlyFormatterHelper: true };',
      ].join('\n'),
      [
        'export function publishedOnlyFormatterHelper() {}',
        'Object.assign(overlayQueryRuntime, { publishedOnlyFormatterHelper });',
      ].join('\n'),
    );
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const reachableDeclaration = 'function strictNativeCodeBlockBudgetReached() {}';
    expect(facade).toContain(reachableDeclaration);
    fs.writeFileSync(facadePath, facade.replace(reachableDeclaration, [
      'function strictNativeCodeBlockBudgetReached() {',
      '  function publishedOnlyFormatterHelper() {}',
      '  return { publishedOnlyFormatterHelper: true };',
      '}',
    ].join('\n')));

    const result = runValidator(root);

    expect(result.stderr).not.toContain('does not define publishedOnlyFormatterHelper()');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'covered child publishedOnlyFormatterHelper must be transitively reachable from hotspot owner formatStrictNativeMarkdown',
    );
  });

  it.each([
    ['function', 'function dormant() { nestedOnlyFormatterHelper(); }'],
    ['arrow', 'const dormant = () => nestedOnlyFormatterHelper();'],
    ['method', 'const dormant = { run() { nestedOnlyFormatterHelper(); } };'],
  ])('rejects a covered child referenced only by an uncalled nested %s', (_kind, nested) => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    expect(hotspot).toBeDefined();
    hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('nestedOnlyFormatterHelper');
    writeJson(manifestPath(root), rootManifest);
    appendFormatterClosureFixture(
      root,
      "import { nestedOnlyFormatterHelper } from './lib/type-edge-output-projection.mjs';",
      'export function nestedOnlyFormatterHelper() {}',
    );
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    fs.writeFileSync(facadePath, facade.replace(
      'function formatStrictNativeMarkdown() {',
      `function formatStrictNativeMarkdown() { ${nested}`,
    ));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'covered child nestedOnlyFormatterHelper must be transitively reachable from hotspot owner formatStrictNativeMarkdown',
    );
  });

  it('accepts an explicitly called nested callable and its transitive nested calls', () => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    expect(hotspot).toBeDefined();
    hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('nestedTransitiveFormatterHelper');
    writeJson(manifestPath(root), rootManifest);
    appendFormatterClosureFixture(
      root,
      "import { nestedTransitiveFormatterHelper } from './lib/type-edge-output-projection.mjs';",
      'export function nestedTransitiveFormatterHelper() {}',
    );
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    fs.writeFileSync(facadePath, facade.replace(
      'function formatStrictNativeMarkdown() {',
      [
        'function formatStrictNativeMarkdown() {',
        '  function first() {',
        '    const second = () => {',
        '      const helper = { run() { nestedTransitiveFormatterHelper(); } };',
        '      helper.run();',
        '    };',
        '    second();',
        '  }',
        '  first();',
      ].join('\n'),
    ));

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.each([
    ['an explicitly invoked local callback parameter', "function profilePhase(label, operation) { return operation(); } profilePhase('x', () => callbackReachabilityHelper());", 0],
    ['the eager map callback position through a local Array transform binding', 'const values = [1]; const filtered = values.filter(Boolean); filtered.map(() => callbackReachabilityHelper());', 0],
    ['an invoked local parameter with a named nested callback', "function profilePhase(label, operation) { return operation(); } function callback() { callbackReachabilityHelper(); } profilePhase('x', callback);", 0],
    ['combined call return object tuple Array flow', 'function wrap(items) { return { pair: [0, items] }; } function consume(context, callback) { const { pair } = context; const [, items] = pair; items.map(callback); } consume(wrap([1]), () => callbackReachabilityHelper());', 0],
    ['combined call return object tuple mutation', 'function wrap(items) { return { pair: [0, items] }; } function consume(context, callback) { const { pair } = context; const [, items] = pair; items.map(callback); } consume(wrap(unknown), () => callbackReachabilityHelper());', 1],
    ['native Map entry Array tuple flow', "const groups = new Map(); groups.set('x', [1]); [...groups.entries()].map(([, items]) => items.map(() => callbackReachabilityHelper()));", 0],
    ['native Map entry unknown tuple mutation', "const groups = new Map(); groups.set('x', unknown); [...groups.entries()].map(([, items]) => items.map(() => callbackReachabilityHelper()));", 1],
    ['installer delegate Array argument flow', 'let renderDelegate; function installedDelegate(value) { return value; } function render(...values) { return installedDelegate(renderDelegate)(...values); } function install(runtime) { const call = name => (...values) => runtime[name](...values); renderDelegate = renderImpl; } function renderImpl(items, callback) { items.map(callback); } install({}); render([1], () => callbackReachabilityHelper());', 0],
    ['installer delegate unresolved mutation', 'let renderDelegate; function installedDelegate(value) { return value; } function render(...values) { return installedDelegate(renderDelegate)(...values); } function install(runtime) { const call = name => (...values) => runtime[name](...values); renderDelegate = unknownImpl; } function renderImpl(items, callback) { items.map(callback); } install({}); render([1], () => callbackReachabilityHelper());', 1],
    ['seeded callable cycle', 'function cycle() { [1].map(() => callbackReachabilityHelper()); cycle(); } cycle();', 0],
    ['unseeded callable cycle mutation', 'function cycle() { [1].map(() => callbackReachabilityHelper()); cycle(); }', 1],
    ...(['map', 'sort', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'forEach', 'reduce', 'reduceRight'] as const).map(method => [
      `the eager ${method} position with a named nested callback`,
      `const callback = () => callbackReachabilityHelper(); [1].${method}(callback);`, 0,
    ] as const),
    ['an unknown consumer', 'unknownConsumer(() => callbackReachabilityHelper());', 1],
    ['an unknown consumer with a named nested callback', 'function callback() { callbackReachabilityHelper(); } unknownConsumer(callback);', 1],
    ['an unknown property consumer with a named nested callback', 'function callback() { callbackReachabilityHelper(); } values.consume(callback);', 1],
    ['an unknown map receiver', 'unknown.map(() => callbackReachabilityHelper());', 1],
    ...(['map', 'filter', 'sort'] as const).flatMap(method => [
      [`a local object custom ${method}`, `const values = { ${method}(callback) {} }; values.${method}(() => callbackReachabilityHelper());`, 1] as const,
      [`a local class custom ${method}`, `class Values { ${method}(callback) {} } new Values().${method}(() => callbackReachabilityHelper());`, 1] as const,
    ]),
    ['a Delegate assignment outside an installer', 'let formatterDelegate; formatterDelegate = callbackReachabilityHelper;', 1],
    ['assignment', 'const callback = () => callbackReachabilityHelper();', 1],
    ['return', 'function makeCallback() { return () => callbackReachabilityHelper(); } makeCallback();', 1],
    ['storage', 'const callbacks = { callback: () => callbackReachabilityHelper() }; void callbacks;', 1],
    ['publication', 'const callback = () => callbackReachabilityHelper(); Object.assign(runtime, { callback });', 1],
  ] as const)('classifies covered-child callback reachability through %s', (_label, ownerBody, expectedStatus) => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    expect(hotspot).toBeDefined();
    hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('callbackReachabilityHelper');
    writeJson(manifestPath(root), rootManifest);
    appendFormatterClosureFixture(
      root,
      "import { callbackReachabilityHelper } from './lib/type-edge-output-projection.mjs';",
      'export function callbackReachabilityHelper() {}',
    );
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    fs.writeFileSync(facadePath, facade.replace(
      'function formatStrictNativeMarkdown() {',
      `function formatStrictNativeMarkdown() { ${ownerBody}`,
    ));

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(expectedStatus);
    if (expectedStatus === 1) expect(result.stderr).toContain(
      'covered child callbackReachabilityHelper must be transitively reachable from hotspot owner formatStrictNativeMarkdown',
    );
  });

  it.each([
    ['unknown consumer', 'unknownConsumer(topLevelCallback);', ''],
    ['assignment', 'const callback = topLevelCallback; void callback;', ''],
    ['return', 'return topLevelCallback;', ''],
    ['storage', 'const callbacks = { topLevelCallback }; void callbacks;', ''],
    ['publication', 'Object.assign(runtime, { topLevelCallback });', ''],
    ['export', '', 'export default topLevelCallback;'],
  ] as const)('keeps a top-level named callback unreachable through %s', (_label, ownerBody, rootSuffix) => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    expect(hotspot).toBeDefined();
    hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('topLevelCallbackReachabilityHelper');
    writeJson(manifestPath(root), rootManifest);
    appendFormatterClosureFixture(
      root,
      "import { topLevelCallbackReachabilityHelper } from './lib/type-edge-output-projection.mjs';",
      'export function topLevelCallbackReachabilityHelper() {}',
    );
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const withOwnerReference = facade.replace(
      'function formatStrictNativeMarkdown() {',
      `function formatStrictNativeMarkdown() { ${ownerBody}`,
    );
    fs.writeFileSync(facadePath, `${withOwnerReference}\nfunction topLevelCallback() { topLevelCallbackReachabilityHelper(); }\n${rootSuffix}\n`);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'covered child topLevelCallbackReachabilityHelper must be transitively reachable from hotspot owner formatStrictNativeMarkdown',
    );
  });

  it('rejects literal call(symbol) reachability outside an installer scope', () => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    expect(hotspot).toBeDefined();
    hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('nonInstallerRuntimeLiteralHelper');
    writeJson(manifestPath(root), rootManifest);
    appendFormatterClosureFixture(
      root,
      "import { nonInstallerRuntimeLiteralHelper } from './lib/type-edge-output-projection.mjs';",
      'export function nonInstallerRuntimeLiteralHelper() {}',
    );
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    fs.writeFileSync(facadePath, facade.replace(
      'function formatStrictNativeMarkdown() {',
      "function formatStrictNativeMarkdown() { call('nonInstallerRuntimeLiteralHelper');",
    ));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'covered child nonInstallerRuntimeLiteralHelper must be transitively reachable from hotspot owner formatStrictNativeMarkdown',
    );
  });

  it('does not treat export assignment as a covered-child reachability root', () => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    expect(hotspot).toBeDefined();
    hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('exportedOnlyFormatterHelper');
    writeJson(manifestPath(root), rootManifest);
    appendFormatterClosureFixture(
      root,
      "import { exportedOnlyFormatterHelper } from './lib/type-edge-output-projection.mjs';\nexport default exportedOnlyFormatterHelper;",
      'export function exportedOnlyFormatterHelper() {}',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'covered child exportedOnlyFormatterHelper must be transitively reachable from hotspot owner formatStrictNativeMarkdown',
    );
  });

  it('keeps installer runtime reachability restricted to literal call(symbol) edges', () => {
    for (const [argument, expectedStatus] of [
      ["'runtimeLiteralFormatterHelper'", 0],
      ['runtimeLiteralFormatterHelperName', 1],
      ['`runtimeLiteralFormatterHelper`', 1],
    ] as const) {
      const root = makeFixture();
      const { rootManifest } = convertFixtureToSchemaV2(root);
      const hotspot = rootManifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
      expect(hotspot).toBeDefined();
      hotspot?.coveredChildSymbols && (hotspot.coveredChildSymbols as string[]).push('runtimeLiteralFormatterHelper', 'delegateAssignmentHelper');
      writeJson(manifestPath(root), rootManifest);
      appendFormatterClosureFixture(
        root,
        "import { runtimeLiteralFormatterHelper, delegateAssignmentHelper } from './lib/type-edge-output-projection.mjs';",
        'export function runtimeLiteralFormatterHelper() {} export function delegateAssignmentHelper() {}',
      );
      const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
      const facade = fs.readFileSync(facadePath, 'utf8');
      fs.writeFileSync(facadePath, facade.replace(
        'function formatStrictNativeMarkdown() {',
        [
          'function formatStrictNativeMarkdown() {',
          '  function installFormatterRuntime(runtime) {',
          '    const call = name => (...values) => runtime[name](...values);',
          '    let formatterDelegate;',
          '    formatterDelegate = delegateAssignmentHelper;',
          "    const runtimeLiteralFormatterHelperName = 'runtimeLiteralFormatterHelper';",
          `    call(${argument});`,
          '  }',
          '  installFormatterRuntime({});',
        ].join('\n'),
      ));

      const result = runValidator(root);

      expect(result.status, result.stderr || result.stdout).toBe(expectedStatus);
      expect(result.stderr).not.toContain('covered child delegateAssignmentHelper must be transitively reachable');
    }
  });

  it('validates forbidden formatter behavior in the real imported child implementation', () => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const childPath = path.join(root, 'scripts', 'lib', 'codegraph-overlay-output-projection.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const wrapper = [
      "import { formatNativeMarkdownImpl } from './lib/codegraph-overlay-output-projection.mjs';",
      'function formatNativeMarkdown(...values) { return formatNativeMarkdownImpl(...values); }',
    ].join('\n');
    const mutatedFacade = facade.replace('function formatNativeMarkdown() {}', wrapper);
    expect(mutatedFacade).not.toBe(facade);
    fs.writeFileSync(facadePath, mutatedFacade);
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.writeFileSync(childPath, [
      'export function formatNativeMarkdownImpl(...values) { return formatNativeMarkdown(...values); }',
      'function formatNativeMarkdown() { return formatStrictNativeMarkdown(); }',
      '',
    ].join('\n'));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'nanoflow-augmented native-markdown formatter source body must not reference strict-native formatter token formatStrictNativeMarkdown',
    );
  });

  it('validates forbidden formatter behavior in an augmented covered child implementation', () => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const childPath = path.join(root, 'scripts', 'lib', 'codegraph-overlay-output-projection.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const wrapper = [
      "import { formatNativeMarkdownImpl } from './lib/codegraph-overlay-output-projection.mjs';",
      'function formatNativeMarkdown(...values) { return formatNativeMarkdownImpl(...values); }',
    ].join('\n');
    const mutatedFacade = facade.replace('function formatNativeMarkdown() {}', wrapper);
    expect(mutatedFacade).not.toBe(facade);
    fs.writeFileSync(facadePath, mutatedFacade);
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.writeFileSync(childPath, [
      'export function formatNativeMarkdownImpl(...values) { return formatNativeMarkdown(...values); }',
      'function formatNativeMarkdown() { return formatNanoFlowAugmentedMarkdown(); }',
      'function formatNanoFlowAugmentedMarkdown() { return formatStrictNativeMarkdown(); }',
      '',
    ].join('\n'));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source symbol formatNanoFlowAugmentedMarkdown');
    expect(result.stderr).toContain('strict-native formatter token formatStrictNativeMarkdown');
  });

  it('fails closed when an augmented covered child has no inspectable body', () => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const mutatedFacade = facade.replace('function formatNanoFlowAugmentedMarkdown() {}\n', '');
    expect(mutatedFacade).not.toBe(facade);
    fs.writeFileSync(facadePath, mutatedFacade);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'source symbol formatNanoFlowAugmentedMarkdown has no inspectable function body in import closure of scripts/query-codegraph-nanoflow-overlay.mjs',
    );
  });

  it.each([
    [
      'const arrow',
      'const formatNativeMarkdown = () => formatStrictNativeMarkdown();',
    ],
    [
      'named function after a regex brace',
      'function formatNativeMarkdown() { const brace = /}/; return formatStrictNativeMarkdown(); }',
    ],
  ])('validates forbidden formatter behavior in a %s body', (_label, replacement) => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const mutatedFacade = facade.replace('function formatNativeMarkdown() {}', replacement);
    expect(mutatedFacade).not.toBe(facade);
    fs.writeFileSync(facadePath, mutatedFacade);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'nanoflow-augmented native-markdown formatter source body must not reference strict-native formatter token formatStrictNativeMarkdown',
    );
  });

  it('fails closed when a registered formatter symbol has no inspectable body in the import closure', () => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const mutatedFacade = facade.replace('function formatNativeMarkdown() {}\n', '');
    expect(mutatedFacade).not.toBe(facade);
    fs.writeFileSync(facadePath, mutatedFacade);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'source symbol formatNativeMarkdown has no inspectable function body in import closure of scripts/query-codegraph-nanoflow-overlay.mjs',
    );
  });

  it('ignores comment, string, and non-literal import decoys', () => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const childPath = path.join(root, 'scripts', 'lib', 'decoy-output-projection.mjs');
    fs.appendFileSync(facadePath, [
      "// import './lib/decoy-output-projection.mjs';",
      "const importDecoy = \"export * from './lib/decoy-output-projection.mjs'\";",
      'const modulePath = \'./lib/decoy-output-projection.mjs\';',
      'require(modulePath);',
      'import(modulePath);',
      '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.writeFileSync(childPath, 'function formatNativeMarkdown() { return formatStrictNativeMarkdown(); }\n');

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.each([
    ['import type declaration', "import type { Formatter } from './lib/type-edge-output-projection.mjs';"],
    ['all type-only named imports', "import { type Formatter, type Options } from './lib/type-edge-output-projection.mjs';"],
    ['export type declaration', "export type { Formatter } from './lib/type-edge-output-projection.mjs';"],
    ['all type-only named exports', "export { type Formatter, type Options } from './lib/type-edge-output-projection.mjs';"],
  ])('does not follow a wholly type-only %s', (_label, importSyntax) => {
    const root = makeFixture();
    appendFormatterClosureFixture(
      root,
      importSyntax,
      'function formatNativeMarkdown() { return formatStrictNativeMarkdown(); }',
    );

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.each([
    ['default value plus named type import', "import Formatter, { type Options } from './lib/type-edge-output-projection.mjs';"],
    ['named value plus named type import', "import { Formatter, type Options } from './lib/type-edge-output-projection.mjs';"],
    ['mixed value and type re-export', "export { Formatter, type Options } from './lib/type-edge-output-projection.mjs';"],
  ])('follows a mixed %s', (_label, importSyntax) => {
    const root = makeFixture();
    appendFormatterClosureFixture(
      root,
      importSyntax,
      'function formatNativeMarkdown() { return formatStrictNativeMarkdown(); }',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'nanoflow-augmented native-markdown formatter source body must not reference strict-native formatter token formatStrictNativeMarkdown',
    );
  });

  it.each([
    ['re-export', "export * from './lib/imported-output-projection.mjs';"],
    ['literal dynamic import', "void import('./lib/imported-output-projection.mjs');"],
    ['literal require', "require('./lib/imported-output-projection.mjs');"],
    ['import-equals external module', "import projection = require('./lib/imported-output-projection.mjs');"],
  ])('follows a real %s edge to formatter implementation source', (_label, importSyntax) => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const childPath = path.join(root, 'scripts', 'lib', 'imported-output-projection.mjs');
    fs.appendFileSync(facadePath, `${importSyntax}\n`);
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.writeFileSync(childPath, [
      'const formatNativeMarkdown = () => formatStrictNativeMarkdown();',
      "export { formatNativeMarkdown };",
      '',
    ].join('\n'));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'nanoflow-augmented native-markdown formatter source body must not reference strict-native formatter token formatStrictNativeMarkdown',
    );
  });

  it('does not follow a type-only ImportEquals edge', () => {
    const root = makeFixture();
    appendFormatterClosureFixture(
      root,
      "import type Formatter = require('./lib/type-edge-output-projection.mjs');",
      'function formatNativeMarkdown() { return formatStrictNativeMarkdown(); }',
    );

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('terminates a cyclic real import closure deterministically', () => {
    const root = makeFixture();
    const facadePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const firstPath = path.join(root, 'scripts', 'lib', 'cycle-a.mjs');
    const secondPath = path.join(root, 'scripts', 'lib', 'cycle-b.mjs');
    fs.appendFileSync(facadePath, "export * from './lib/cycle-a.mjs';\n");
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.writeFileSync(firstPath, "export * from './cycle-b.mjs';\n");
    fs.writeFileSync(secondPath, [
      "export * from './cycle-a.mjs';",
      "export * from '../query-codegraph-nanoflow-overlay.mjs';",
      '',
    ].join('\n'));

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects a hotspot part whose real path escapes docs before reading its contents', ({ skip }) => {
    const root = makeFixture();
    const { rootManifest } = convertFixtureToSchemaV2(root);
    const outsideDirectory = path.join(root, 'outside-hotspot-parts');
    const linkedDirectory = path.join(root, 'docs', 'linked-hotspot-parts');
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.writeFileSync(path.join(outsideDirectory, androidPartName), '{ invalid json that must not be read');
    try {
      fs.symlinkSync(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        skip(`directory links unavailable: ${code}`);
        return;
      }
      throw error;
    }
    rootManifest.hotspotParts = [`linked-hotspot-parts/${androidPartName}`];
    writeJson(manifestPath(root), rootManifest);

    const modulePath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-dedup-contract-validator.cjs');
    const { loadDedupContractManifest } = require(modulePath) as {
      loadDedupContractManifest(root: string, relativePath: string): unknown;
    };

    expect(() => loadDedupContractManifest(root, `docs/${rootManifestName}`))
      .toThrow('hotspot part real path must stay within docs');
  });

  it.each([
    ['missing', (root: string, manifest: DedupManifest) => {
      fs.rmSync(path.join(root, 'docs', androidPartName));
      return 'missing hotspot part';
    }],
    ['duplicate', (_root: string, manifest: DedupManifest) => {
      manifest.hotspotParts = [androidPartName, androidPartName];
      return 'duplicate hotspot part path';
    }],
    ['traversal', (_root: string, manifest: DedupManifest) => {
      manifest.hotspotParts = ['../outside.json'];
      return 'hotspot part path must stay within docs';
    }],
    ['absolute', (_root: string, manifest: DedupManifest) => {
      manifest.hotspotParts = [path.resolve('outside.json')];
      return 'hotspot part path must be relative';
    }],
    ['drive-relative', (_root: string, manifest: DedupManifest) => {
      manifest.hotspotParts = ['D:outside.json'];
      return 'hotspot part path must be relative';
    }],
    ['drive-absolute', (_root: string, manifest: DedupManifest) => {
      manifest.hotspotParts = ['D:\\outside.json'];
      return 'hotspot part path must be relative';
    }],
    ['UNC-absolute', (_root: string, manifest: DedupManifest) => {
      manifest.hotspotParts = ['\\\\server\\share\\outside.json'];
      return 'hotspot part path must be relative';
    }],
    ['case-collision', (_root: string, manifest: DedupManifest) => {
      manifest.hotspotParts = [androidPartName, androidPartName.toUpperCase()];
      return 'case-colliding hotspot part path';
    }],
    ['nested', (root: string) => {
      const partPath = path.join(root, 'docs', androidPartName);
      const part = JSON.parse(fs.readFileSync(partPath, 'utf8')) as Record<string, unknown>;
      part.hotspotParts = ['nested.json'];
      writeJson(partPath, part);
      return 'hotspot part must not declare hotspotParts';
    }],
    ['duplicate-hotspot', (_root: string, manifest: DedupManifest, androidHotspots: Hotspot[]) => {
      manifest.hotspots.push(androidHotspots[0]);
      return 'duplicate hotspot name collectAndroid() across de-duplication contract parts';
    }],
    ['bounded-part-schema', (root: string) => {
      const partPath = path.join(root, 'docs', androidPartName);
      const part = JSON.parse(fs.readFileSync(partPath, 'utf8')) as Record<string, unknown>;
      part.extra = true;
      writeJson(partPath, part);
      return 'hotspot part unsupported field extra';
    }],
  ] as const)('fails closed for %s hotspot part errors', (_label, mutate) => {
    const root = makeFixture();
    const { rootManifest, androidHotspots } = convertFixtureToSchemaV2(root);
    const expected = mutate(root, rootManifest, androidHotspots);
    writeJson(manifestPath(root), rootManifest);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it('migrates the exact eight Android/Kotlin hotspot objects from current worktree bytes', () => {
    const rootPath = path.join(repoRoot, 'docs', rootManifestName);
    const partPath = path.join(repoRoot, 'docs', androidPartName);
    expect(fs.existsSync(partPath), 'missing Android/Kotlin hotspot part').toBe(true);
    const rootManifest = JSON.parse(fs.readFileSync(rootPath, 'utf8')) as DedupManifest;
    const part = JSON.parse(fs.readFileSync(partPath, 'utf8')) as { schemaVersion: number; hotspots: Hotspot[] };

    expect(rootManifest.schemaVersion).toBe(2);
    expect(rootManifest.hotspotParts).toEqual([androidPartName]);
    expect(rootManifest.hotspots.map(entry => entry.name)).not.toEqual(expect.arrayContaining([...androidHotspotNames]));
    expect(part.schemaVersion).toBe(1);
    expect(part.hotspots.map(entry => entry.name)).toEqual(androidHotspotNames);
    expect(part.hotspots.map(hashHotspot)).toEqual(androidHotspotHashes);
    expect(rootManifest.dependencyLeafSources).toEqual([
      'scripts/lib/codegraph-overlay-baseline.cjs',
      'scripts/lib/codegraph-source-policy.cjs',
    ]);
    expect(rootManifest.hotspots).toHaveLength(14);
    expect(rootManifest.hotspots.length + part.hotspots.length).toBe(22);
  });
});
