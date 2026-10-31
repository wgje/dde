import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOverlay,
  publishOverlayAtRoot,
} from './codegraph-overlay-generation-test-helpers';

const projectRoot = process.cwd();
const sidecarScriptPath = path.join(
  projectRoot,
  'scripts',
  'lib',
  'codegraph-native-graph-sidecar.cjs',
);
const generatorScriptPath = path.join(
  projectRoot,
  'scripts',
  'generate-codegraph-nanoflow-overlay.mjs',
);
const androidImportSourceDefaultEnv = 'NANOFLOW_CODEGRAPH_ANDROID_IMPORT_SOURCE_DEFAULT';
const nativeDatabaseAccessEnv = 'NANOFLOW_CODEGRAPH_NATIVE_DB_ACCESS';
const nativeDatabasePathEnv = 'NANOFLOW_CODEGRAPH_NATIVE_DB_PATH';
const require = createRequire(import.meta.url);
const tempRoots: string[] = [];

interface NativeImportFixtureRow {
  id: string;
  startLine: number;
  target: string;
}

interface NativeFunctionFixtureRow {
  id: string;
  file: string;
  startLine: number;
  name: string;
}

interface NativeFunctionEndpoint {
  nativeNodeId: string;
  file: string;
  startLine: number;
  nativeName: string;
  contentHash: string;
  size: number;
}

interface ExcludedNativeFunctionEndpoint extends NativeFunctionEndpoint {
  reason: 'class-owned' | 'enum-owned' | 'gradle-kts' | 'non-kt-file';
}

interface NativeFunctionOwnerFixtureRow {
  id: string;
  kind: 'class' | 'enum';
  name: string;
  startLine: number;
  endLine: number;
}

interface FixtureOptions {
  androidImports?: Array<{
    file: string;
    startLine: number;
    target: string;
  }>;
  createDatabase?: boolean;
  nativeImports?: NativeImportFixtureRow[];
  nativeImportTarget?: string;
  source?: string;
}

interface FunctionFixtureOptions {
  createDatabase?: boolean;
  extraSources?: Array<{
    file: string;
    source: string;
  }>;
  gradleSource?: string;
  kotlinSource?: string;
  nativeFunctions?: NativeFunctionFixtureRow[];
  nativeOwners?: NativeFunctionOwnerFixtureRow[];
  nodeIdPrimaryKey?: boolean;
}

const kotlinRelativePath = 'android/app/src/main/java/app/nanoflow/MainActivity.kt';
const functionKotlinRelativePath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt';
const gradleKotlinRelativePath = 'android/app/build.gradle.kts';
const nonKotlinFunctionRelativePath = 'android/native-functions.fixture';

function makeFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-native-sidecar-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, '.codegraph'), { recursive: true });

  const nativeImports = options.nativeImports ?? [{
    id: 'import:fixture-context',
    startLine: 3,
    target: options.nativeImportTarget ?? 'android.content.Context',
  }];
  const source = options.source ?? [
    'package app.nanoflow',
    '',
    `import ${nativeImports[0].target}`,
    '',
    'class MainActivity',
    '',
  ].join('\n');
  const sourcePath = path.join(root, kotlinRelativePath);
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, source);

  if (options.createDatabase !== false) {
    createNativeDatabase(root, nativeImports, source);
  }
  writeOverlay(root, options.androidImports ?? [{
    file: kotlinRelativePath,
    startLine: 3,
    target: 'android.content.Context',
  }]);
  return root;
}

function createNativeDatabase(
  root: string,
  nativeImports: NativeImportFixtureRow[],
  source: string,
): void {
  const databasePath = path.join(root, '.codegraph', 'codegraph.db');
  const contentHash = createHash('sha256').update(Buffer.from(source)).digest('hex');
  runSqliteFixtureScript(`
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    db.exec(\`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      language TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      docstring TEXT,
      signature TEXT,
      visibility TEXT,
      is_exported INTEGER DEFAULT 0,
      is_async INTEGER DEFAULT 0,
      is_static INTEGER DEFAULT 0,
      is_abstract INTEGER DEFAULT 0,
      decorators TEXT,
      type_parameters TEXT,
      updated_at INTEGER NOT NULL,
      return_type TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT,
      line INTEGER,
      col INTEGER,
      provenance TEXT DEFAULT NULL
    );
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    );
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      node_count INTEGER DEFAULT 0,
      errors TEXT
    );
    \`);
    const insertNode = db.prepare(\`
      INSERT INTO nodes (
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, signature, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`);
    for (const entry of ${JSON.stringify(nativeImports)}) {
      insertNode.run(
        entry.id,
        'import',
        entry.target,
        'app.nanoflow::' + entry.target,
        ${JSON.stringify(kotlinRelativePath)},
        'kotlin',
        entry.startLine,
        entry.startLine,
        0,
        30,
        'import ' + entry.target,
        1,
      );
      db.prepare(
        'INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)',
      ).run(entry.id, entry.id, 'references');
    }
    db.prepare(\`
      INSERT INTO files (
        path, content_hash, language, size, modified_at, indexed_at, node_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    \`).run(
      ${JSON.stringify(kotlinRelativePath)},
      ${JSON.stringify(contentHash)},
      'kotlin',
      ${Buffer.byteLength(source)},
      1,
      1,
      ${nativeImports.length},
    );
    db.prepare(
      'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
    ).run(8, 1, 'fixture schema');
    db.close();
  `);
}

function makeThreeImportFixture(): string {
  return makeFixture({
    nativeImports: [
      { id: 'import:fixture-context', startLine: 3, target: 'android.content.Context' },
      { id: 'import:fixture-intent', startLine: 4, target: 'android.content.Intent' },
      { id: 'import:fixture-wildcard', startLine: 5, target: 'app.nanoflow.widgets' },
    ],
    source: [
      'package app.nanoflow',
      '',
      'import android.content.Context',
      'import android.content.Intent as AndroidIntent',
      'import app.nanoflow.widgets.*',
      '',
      'class MainActivity',
      '',
    ].join('\n'),
  });
}

function makeImportCompletenessFixture(eol: '\n' | '\r\n'): string {
  return makeFixture({
    nativeImports: [
      { id: 'import:fixture-context', startLine: 3, target: 'android.content.Context' },
      { id: 'import:fixture-intent', startLine: 4, target: 'android.content.Intent' },
      { id: 'import:fixture-wildcard', startLine: 5, target: 'app.nanoflow.widgets' },
    ],
    source: [
      'package app.nanoflow',
      '',
      'import android.content.Context',
      'import android.content.Intent as AndroidIntent',
      'import app.nanoflow.widgets.*',
      '',
      '// import fake.LineComment',
      '/*',
      'import fake.BlockComment',
      '*/',
      'val ordinary = "import fake.String"',
      'val raw = """',
      'import fake.TripleString',
      '"""',
      '',
      'class MainActivity',
      '',
    ].join(eol),
  });
}

function makeFunctionFixture(
  eol: '\n' | '\r\n' = '\n',
  options: FunctionFixtureOptions = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-native-function-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  const kotlinSource = options.kotlinSource ?? [
    'package app.nanoflow.host',
    '',
    'fun topLevelAction(): String {',
    '  fun nestedHelper(): String {',
    '    return "nested"',
    '  }',
    '  return nestedHelper()',
    '}',
    '',
    '/*',
    'fun blockCommentHelper(): String = "block"',
    '*/',
    '// fun commentHelper(): String = "comment"',
    'val fakeString = "fun stringHelper(): String = \\"string\\""',
    'val fakeRaw = """',
    'fun rawHelper(): String = "raw"',
    '"""',
    '',
    'class WidgetOwner {',
    '  fun memberAction(): String {',
    '    fun memberNestedHelper(): String {',
    '      return "member"',
    '    }',
    '    return memberNestedHelper()',
    '  }',
    '}',
    '',
  ].join(eol);
  const gradleSource = options.gradleSource ?? [
    'fun gradleHelper(): String = "gradle"',
    '',
  ].join(eol);
  const kotlinSourcePath = path.join(root, functionKotlinRelativePath);
  const gradleSourcePath = path.join(root, gradleKotlinRelativePath);
  const nonKotlinSource = 'fun nonKotlinHelper(): String = "non-kotlin"\n';
  const nonKotlinSourcePath = path.join(root, nonKotlinFunctionRelativePath);
  mkdirSync(path.dirname(kotlinSourcePath), { recursive: true });
  mkdirSync(path.dirname(gradleSourcePath), { recursive: true });
  writeFileSync(kotlinSourcePath, kotlinSource);
  writeFileSync(gradleSourcePath, gradleSource);
  writeFileSync(nonKotlinSourcePath, nonKotlinSource);
  for (const extraSource of options.extraSources ?? []) {
    const extraSourcePath = path.join(root, ...extraSource.file.split('/'));
    mkdirSync(path.dirname(extraSourcePath), { recursive: true });
    writeFileSync(extraSourcePath, extraSource.source);
  }
  if (options.createDatabase !== false) {
    createNativeFunctionDatabase(root, kotlinSource, gradleSource, nonKotlinSource, options);
  }
  return root;
}

function makeAstralFunctionFixture(eol: '\n' | '\r\n'): string {
  return makeFunctionFixture(eol, {
    kotlinSource: [
      'package app.nanoflow.host',
      '',
      'val leadingEmoji = "🚪 gate"',
      '',
      'fun topLevelAction(): String {',
      '  fun nestedHelper(): String {',
      '    return "nested"',
      '  }',
      '  return nestedHelper()',
      '}',
      '',
      '/*',
      'fun blockCommentHelper(): String = "block"',
      '*/',
      '// fun commentHelper(): String = "comment"',
      'val fakeString = "fun stringHelper(): String = \\"string\\""',
      'val fakeRaw = """',
      'fun rawHelper(): String = "raw"',
      '"""',
      '',
      'class WidgetOwner {',
      '  fun memberAction(): String {',
      '    fun memberNestedHelper(): String {',
      '      return "member"',
      '    }',
      '    return memberNestedHelper()',
      '  }',
      '}',
      '',
    ].join(eol),
    nativeFunctions: [
      { id: 'function:top-level-action', file: functionKotlinRelativePath, startLine: 5, name: 'topLevelAction' },
      { id: 'function:nested-helper', file: functionKotlinRelativePath, startLine: 6, name: 'nestedHelper' },
      { id: 'function:member-nested-helper', file: functionKotlinRelativePath, startLine: 23, name: 'memberNestedHelper' },
      { id: 'function:gradle-helper', file: gradleKotlinRelativePath, startLine: 1, name: 'gradleHelper' },
    ],
  });
}

function makeGenericCallableOwnerFixture(eol: '\n' | '\r\n'): string {
  return makeFunctionFixture(eol, {
    createDatabase: false,
    kotlinSource: [
      'package app.nanoflow.fixture',
      '',
      'val astral = "🚀"',
      '',
      'internal class First internal constructor(',
      '  private val seed: String,',
      ') {',
      '  fun isCurrent(): String = "first"',
      '}',
      '',
      'internal class Second<Request : Map<String, List<(String) -> Unit>>>(',
      '  private val transform: (Request) -> String = { request -> request.toString() },',
      ') {',
      '  fun secondAction(request: Request): String = transform(request)',
      '',
      '  private data class PendingRequest<Request>(',
      '    val request: Request,',
      '  )',
      '}',
      '',
      'inline fun <reified T> topGeneric(value: T): T = value',
      '',
      'fun isCurrent(): String = "post"',
      '',
      'class Broken<T',
      'fun afterMalformedPlain(): String = "plain"',
      'private fun afterMalformedPrivate(): String = "private"',
      'internal fun afterMalformedInternal(): String = "internal"',
      '',
    ].join(eol),
  });
}

function createNativeFunctionDatabase(
  root: string,
  kotlinSource: string,
  gradleSource: string,
  nonKotlinSource: string,
  options: FunctionFixtureOptions,
): void {
  const databasePath = path.join(root, '.codegraph', 'codegraph.db');
  const functionRows: NativeFunctionFixtureRow[] = options.nativeFunctions ?? [
    { id: 'function:top-level-action', file: functionKotlinRelativePath, startLine: 3, name: 'topLevelAction' },
    { id: 'function:nested-helper', file: functionKotlinRelativePath, startLine: 4, name: 'nestedHelper' },
    { id: 'function:member-nested-helper', file: functionKotlinRelativePath, startLine: 21, name: 'memberNestedHelper' },
    { id: 'function:gradle-helper', file: gradleKotlinRelativePath, startLine: 1, name: 'gradleHelper' },
  ];
  const ownerRows: NativeFunctionOwnerFixtureRow[] = options.nativeOwners ?? [
    { id: 'class:widget-owner', kind: 'class', name: 'WidgetOwner', startLine: 19, endLine: 26 },
  ];
  const files = [
    { file: functionKotlinRelativePath, source: kotlinSource },
    { file: gradleKotlinRelativePath, source: gradleSource },
    { file: nonKotlinFunctionRelativePath, source: nonKotlinSource },
    ...(options.extraSources ?? []),
  ].map(entry => ({
    ...entry,
    contentHash: createHash('sha256').update(Buffer.from(entry.source)).digest('hex'),
    size: Buffer.byteLength(entry.source),
  }));
  runSqliteFixtureScript(`
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    db.exec(\`
    CREATE TABLE nodes (
      id TEXT${options.nodeIdPrimaryKey === false ? '' : ' PRIMARY KEY'},
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      language TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      docstring TEXT,
      signature TEXT,
      visibility TEXT,
      is_exported INTEGER DEFAULT 0,
      is_async INTEGER DEFAULT 0,
      is_static INTEGER DEFAULT 0,
      is_abstract INTEGER DEFAULT 0,
      decorators TEXT,
      type_parameters TEXT,
      updated_at INTEGER NOT NULL,
      return_type TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT,
      line INTEGER,
      col INTEGER,
      provenance TEXT DEFAULT NULL
    );
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    );
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      node_count INTEGER DEFAULT 0,
      errors TEXT
    );
    \`);
    const insertNode = db.prepare(\`
      INSERT INTO nodes (
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, signature, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`);
    for (const entry of ${JSON.stringify(functionRows)}) {
      insertNode.run(
        entry.id,
        'function',
        entry.name,
        'app.nanoflow.host::' + entry.name,
        entry.file,
        'kotlin',
        entry.startLine,
        entry.startLine,
        0,
        24,
        'fun ' + entry.name + '()',
        1,
      );
    }
    for (const owner of ${JSON.stringify(ownerRows)}) {
      insertNode.run(
        owner.id,
        owner.kind,
        owner.name,
        'app.nanoflow.host::' + owner.name,
        ${JSON.stringify(functionKotlinRelativePath)},
        'kotlin',
        owner.startLine,
        owner.endLine,
        0,
        18,
        owner.kind + ' ' + owner.name,
        1,
      );
    }
    const insertFile = db.prepare(\`
      INSERT INTO files (
        path, content_hash, language, size, modified_at, indexed_at, node_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    \`);
    for (const entry of ${JSON.stringify(files)}) {
      insertFile.run(entry.file, entry.contentHash, 'kotlin', entry.size, 1, 1, 1);
    }
    db.prepare(
      'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
    ).run(8, 1, 'fixture schema');
    db.close();
  `);
}

function loadSidecar() {
  return require(sidecarScriptPath) as {
    auditNativeGraph: (options: { root: string; databaseAccess?: string; databasePath?: string }) => Record<string, unknown>;
    readNativeAndroidKotlinImportEndpoints: (options: { root: string; databaseAccess?: string; databasePath?: string }) => {
      projectRoot: string;
      database: Record<string, unknown>;
      endpoints: Array<Record<string, unknown>>;
    };
    readNativeAndroidKotlinFunctionEndpoints: (options: { root: string; databaseAccess?: string; databasePath?: string }) => {
      projectRoot: string;
      database: Record<string, unknown>;
      endpoints: NativeFunctionEndpoint[];
      excludedEndpoints: ExcludedNativeFunctionEndpoint[];
    };
  };
}

function runGenerator(
  root: string,
  androidImportSource?: 'local' | 'native',
  defaultAndroidImportSource?: string,
  androidFunctionSource: string | null = 'local',
) {
  const args = [generatorScriptPath, '--root', root, '--stdout'];
  if (androidImportSource) args.push('--android-import-source', androidImportSource);
  if (androidFunctionSource) args.push('--android-function-source', androidFunctionSource);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if ([androidImportSourceDefaultEnv, 'NANOFLOW_CODEGRAPH_ANDROID_FUNCTION_SOURCE_DEFAULT'].some(name => name.toLowerCase() === key.toLowerCase())) delete env[key];
  if (defaultAndroidImportSource !== undefined) {
    env[androidImportSourceDefaultEnv] = defaultAndroidImportSource;
  }
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runFunctionGenerator(root: string, source?: string) {
  return runGenerator(root, undefined, undefined, source);
}

function normalizedOverlayOutput(result: ReturnType<typeof runGenerator>): string {
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const overlay = JSON.parse(result.stdout);
  overlay.generatedAt = '<normalized-generated-at>';
  for (const node of overlay.graph.nodes) node.updatedAt = '<normalized-updated-at>';
  return `${JSON.stringify(overlay, null, 2)}\n`;
}

function runSqliteFixtureScript(body: string): void {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '-e', `const { DatabaseSync } = require('node:sqlite');\n${body}`],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'SQLite fixture process failed');
  }
}

function nativeDatabaseTrioSnapshot(root: string) {
  const databasePath = path.join(root, '.codegraph', 'codegraph.db');
  return Object.fromEntries([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(file => {
    if (!existsSync(file)) return [path.basename(file), { exists: false }];
    const stats = statSync(file, { bigint: true });
    return [path.basename(file), {
      exists: true,
      length: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    }];
  }));
}

function prepareImmutableStaticDatabase(root: string): void {
  const databasePath = path.join(root, '.codegraph', 'codegraph.db');
  runSqliteFixtureScript(`
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  `);
  writeFileSync(`${databasePath}-wal`, Buffer.alloc(0));
  writeFileSync(`${databasePath}-shm`, Buffer.alloc(32 * 1024));
}
function externalizeNativeDatabase(root: string): { databasePath: string; snapshotRoot: string } {
  const snapshotRoot = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-native-snapshot-')); const databasePath = path.join(snapshotRoot, '.codegraph', 'codegraph.db');
  tempRoots.push(snapshotRoot); mkdirSync(path.dirname(databasePath), { recursive: true }); writeFileSync(databasePath, readFileSync(path.join(root, '.codegraph', 'codegraph.db'))); rmSync(path.join(root, '.codegraph', 'codegraph.db'));
  return { databasePath, snapshotRoot };
}
function withNativeDatabaseEnvironment<T>(databasePath: string, read: () => T): T {
  const previous = [[nativeDatabaseAccessEnv, process.env[nativeDatabaseAccessEnv]], [nativeDatabasePathEnv, process.env[nativeDatabasePathEnv]]] as const;
  process.env[nativeDatabaseAccessEnv] = 'immutable-static'; process.env[nativeDatabasePathEnv] = databasePath;
  try { return read(); } finally { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
function writeOverlay(
  root: string,
  androidImports: NonNullable<FixtureOptions['androidImports']>,
): void {
  const overlay = createOverlay(root, 'native-sidecar') as any;
  overlay.android.kotlinImports = androidImports.map(entry => {
    const importedName = entry.target.split('.').at(-1);
    return {
      name: importedName,
      qualifiedName: entry.target,
      importedName,
      target: entry.target,
      packageName: entry.target.split('.').slice(0, -1).join('.'),
      wildcard: entry.target.endsWith('.*'),
      file: entry.file,
      line: entry.startLine,
      startLine: entry.startLine,
      endLine: entry.startLine,
      startColumn: 0,
      endColumn: `import ${entry.target}`.length,
      signature: `import ${entry.target}`,
    };
  });
  publishOverlayAtRoot(root, overlay);
}

function runSidecar(root: string) {
  return spawnSync(
    process.execPath,
    [sidecarScriptPath, '--root', root, '--json'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
}

function parseFailure(result: ReturnType<typeof runSidecar>) {
  expect(result.status, result.stdout || result.stderr).not.toBe(0);
  return JSON.parse(result.stderr);
}

describe('CodeGraph native graph sidecar', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads every native view from one external immutable database without changing the source root', () => {
    const sidecar = loadSidecar();
    const cases: Array<{ root: string; read: (options: { root: string; databaseAccess?: string; databasePath?: string }) => any; viaEnvironment?: boolean }> = [{ root: makeFixture(), read: options => sidecar.auditNativeGraph(options), viaEnvironment: true }, { root: makeFixture(), read: options => sidecar.readNativeAndroidKotlinImportEndpoints(options) }, { root: makeFunctionFixture(), read: options => sidecar.readNativeAndroidKotlinFunctionEndpoints(options) }];
    for (const testCase of cases) {
      const expected = testCase.read({ root: testCase.root });
      const snapshot = externalizeNativeDatabase(testCase.root); const before = nativeDatabaseTrioSnapshot(snapshot.snapshotRoot);
      const actual = testCase.viaEnvironment ? withNativeDatabaseEnvironment(snapshot.databasePath, () => testCase.read({ root: testCase.root })) : testCase.read({ root: testCase.root, databaseAccess: 'immutable-static', databasePath: snapshot.databasePath });
      expect({ ...actual, database: { ...actual.database, path: expected.database.path } }).toEqual(expected);
      expect(actual.projectRoot).toBe(realpathSync(testCase.root)); expect(path.resolve(testCase.root, actual.database.path)).toBe(realpathSync(snapshot.databasePath)); expect(nativeDatabaseTrioSnapshot(snapshot.snapshotRoot)).toEqual(before);
    }
  });
  it('inherits an external immutable database in native generator children and keeps source freshness rooted', () => {
    const root = makeFunctionFixture(); const expected = normalizedOverlayOutput(runFunctionGenerator(root, 'native')); const snapshot = externalizeNativeDatabase(root);
    expect(normalizedOverlayOutput(withNativeDatabaseEnvironment(snapshot.databasePath, () => runFunctionGenerator(root, 'native')))).toBe(expected);
    appendFileSync(path.join(root, functionKotlinRelativePath), '\n// source drift');
    expect(() => loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root, databaseAccess: 'immutable-static', databasePath: snapshot.databasePath })).toThrow(expect.objectContaining({ code: 'native-source-stale' }));
  }, 10_000);
  it('validates custom database paths without falling back and gives options precedence over the environment', () => {
    const root = makeFunctionFixture(); const databasePath = path.join(root, '.codegraph', 'codegraph.db');
    const read = (customPath: any, databaseAccess = 'immutable-static') => () => loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root, databaseAccess, databasePath: customPath });
    for (const [customPath, reason] of [['relative/codegraph.db', 'not-absolute'], [42, 'not-absolute'], [path.join(root, 'missing-codegraph.db'), 'missing'], [root, 'not-file']]) expect(read(customPath)).toThrow(expect.objectContaining({ code: 'native-db-path-invalid', details: expect.objectContaining({ reason }) }));
    expect(read(databasePath, 'coordinated')).toThrow(expect.objectContaining({ code: 'native-db-path-requires-immutable-static' }));
    expect(withNativeDatabaseEnvironment(path.join(root, 'missing-env.db'), () => read(databasePath)())).toEqual(loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root, databaseAccess: 'immutable-static', databasePath }));
  });
  it('rejects immutable-static before opening a nonempty WAL', () => {
    const root = makeFunctionFixture();
    prepareImmutableStaticDatabase(root);
    appendFileSync(path.join(root, '.codegraph', 'codegraph.db-wal'), 'pending');
    const before = nativeDatabaseTrioSnapshot(root);

    expect(() => loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root, databaseAccess: 'immutable-static' }))
      .toThrow(expect.objectContaining({
        code: 'native-db-immutable-static-precondition',
        details: expect.objectContaining({ reason: 'wal-nonempty' }),
      }));
    expect(nativeDatabaseTrioSnapshot(root)).toEqual(before);
  });

  it('rejects immutable-static while a daemon pid exists', () => {
    const root = makeFunctionFixture();
    writeFileSync(path.join(root, '.codegraph', 'daemon.pid'), '{"pid":123}');
    const before = nativeDatabaseTrioSnapshot(root);

    expect(() => loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root, databaseAccess: 'immutable-static' }))
      .toThrow(expect.objectContaining({
        code: 'native-db-immutable-static-precondition',
        details: expect.objectContaining({ reason: 'daemon-present' }),
      }));
    expect(nativeDatabaseTrioSnapshot(root)).toEqual(before);
  });

  it('rejects an invalid native database mode without changing the default result shape', () => {
    const root = makeFunctionFixture();
    const sidecar = loadSidecar();

    expect(Object.keys(sidecar.readNativeAndroidKotlinFunctionEndpoints({ root }).database))
      .toEqual(['path', 'readOnly', 'queryOnly', 'schemaVersion']);
    expect(() => sidecar.readNativeAndroidKotlinFunctionEndpoints({ root, databaseAccess: 'invalid' }))
      .toThrow(expect.objectContaining({ code: 'native-db-access-mode-invalid' }));
  });

  it('matches Android imports by native identity without mutating the database', () => {
    const root = makeFixture();
    const dbPath = path.join(root, '.codegraph', 'codegraph.db');
    const databaseBefore = readFileSync(dbPath);

    const result = runSidecar(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true,
      database: expect.objectContaining({
        readOnly: true,
        queryOnly: 1,
        schemaVersion: 8,
      }),
      nativeGraph: { nodes: 1, edges: 1 },
      overlayGraph: { nodes: 1, edges: 0 },
      androidImports: expect.objectContaining({
        total: 1,
        matched: 1,
        unmatched: [],
        ambiguous: [],
      }),
    }));
    expect(readFileSync(dbPath)).toEqual(databaseBefore);
  });

  it('fails closed when the project root or native database is missing', () => {
    const root = makeFixture({ createDatabase: false });
    const missingRoot = path.join(root, 'missing-root');

    const missingRootFailure = parseFailure(runSidecar(missingRoot));
    const missingDatabaseFailure = parseFailure(runSidecar(root));

    expect(missingRootFailure).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'project-root-missing' }),
    }));
    expect(missingDatabaseFailure).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'native-db-missing' }),
    }));
  });

  it('fails closed when the native schema drifts from the identity contract', () => {
    const root = makeFixture();
    const databasePath = path.join(root, '.codegraph', 'codegraph.db');
    runSqliteFixtureScript(`
      const db = new DatabaseSync(${JSON.stringify(databasePath)});
      db.exec('ALTER TABLE nodes RENAME COLUMN start_line TO begin_line');
      db.close();
    `);

    const failure = parseFailure(runSidecar(root));

    expect(failure).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'native-schema-drift',
        details: expect.objectContaining({ table: 'nodes' }),
      }),
    }));
  });

  it('fails closed when the overlay has no Android imports', () => {
    const root = makeFixture({ androidImports: [] });

    const failure = parseFailure(runSidecar(root));

    expect(failure).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'android-imports-empty' }),
    }));
  });

  it('fails closed when an Android import has no unique native identity match', () => {
    const root = makeFixture({ nativeImportTarget: 'android.content.Intent' });

    const failure = parseFailure(runSidecar(root));

    expect(failure).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'android-import-identity-mismatch' }),
      audit: expect.objectContaining({
        total: 1,
        matched: 0,
        unmatched: [expect.objectContaining({ target: 'android.content.Context' })],
      }),
    }));
  });

  it('reads ordinary, alias, and wildcard Android import endpoints without the overlay', () => {
    const root = makeThreeImportFixture();
    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    const dbPath = path.join(root, '.codegraph', 'codegraph.db');
    const databaseBefore = readFileSync(dbPath);
    rmSync(currentPath);
    const codegraphFilesBefore = readdirSync(path.dirname(dbPath)).sort();

    const result = loadSidecar().readNativeAndroidKotlinImportEndpoints({ root });

    const source = readFileSync(path.join(root, kotlinRelativePath));
    const contentHash = createHash('sha256').update(source).digest('hex');
    expect(result).toEqual({
      projectRoot: realpathSync(root),
      database: {
        path: '.codegraph/codegraph.db',
        readOnly: true,
        queryOnly: 1,
        schemaVersion: 8,
      },
      endpoints: [
        {
          nativeNodeId: 'import:fixture-context',
          file: kotlinRelativePath,
          startLine: 3,
          nativeTarget: 'android.content.Context',
          contentHash,
          size: source.length,
        },
        {
          nativeNodeId: 'import:fixture-intent',
          file: kotlinRelativePath,
          startLine: 4,
          nativeTarget: 'android.content.Intent',
          contentHash,
          size: source.length,
        },
        {
          nativeNodeId: 'import:fixture-wildcard',
          file: kotlinRelativePath,
          startLine: 5,
          nativeTarget: 'app.nanoflow.widgets',
          contentHash,
          size: source.length,
        },
      ],
    });
    expect(readFileSync(dbPath)).toEqual(databaseBefore);
    expect(readdirSync(path.dirname(dbPath)).sort()).toEqual(codegraphFilesBefore);
  });

  it('fails closed when native import source freshness or identity is invalid', () => {
    const staleRoot = makeFixture();
    appendFileSync(path.join(staleRoot, kotlinRelativePath), '// stale after native index\n');

    expect(() => loadSidecar().readNativeAndroidKotlinImportEndpoints({ root: staleRoot }))
      .toThrow(expect.objectContaining({ code: 'native-source-stale' }));

    const ambiguousRoot = makeFixture({
      nativeImports: [
        { id: 'import:fixture-context-a', startLine: 3, target: 'android.content.Context' },
        { id: 'import:fixture-context-b', startLine: 3, target: 'android.content.Context' },
      ],
    });
    expect(() => loadSidecar().readNativeAndroidKotlinImportEndpoints({ root: ambiguousRoot }))
      .toThrow(expect.objectContaining({ code: 'native-import-identity-ambiguous' }));
    expect(runGenerator(ambiguousRoot, 'native').status).not.toBe(0);
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const)(
    'keeps %s real imports exact while ignoring comment and string pseudo imports',
    { timeout: 20_000 },
    (_label, eol) => {
      const root = makeImportCompletenessFixture(eol);

      const defaultResult = runGenerator(root);
      const localResult = runGenerator(root, 'local');
      const nativeResult = runGenerator(root, 'native');
      const defaultOverlay = JSON.parse(defaultResult.stdout);

      expect(defaultResult.status, defaultResult.stderr).toBe(0);
      expect(localResult.status, localResult.stderr).toBe(0);
      expect(nativeResult.status, nativeResult.stderr).toBe(0);
      expect(defaultOverlay.android.kotlinImports.map((item: { target: string }) => item.target)).toEqual([
        'android.content.Context',
        'android.content.Intent',
        'app.nanoflow.widgets.*',
      ]);
      expect(normalizedOverlayOutput(localResult)).toBe(normalizedOverlayOutput(defaultResult));
      expect(normalizedOverlayOutput(nativeResult)).toBe(normalizedOverlayOutput(defaultResult));
    },
  );

  it('accepts same-name native function identities on different source lines', () => {
    const root = makeFunctionFixture('\n', {
      kotlinSource: [
        'package app.nanoflow.host',
        '',
        'fun repeatedAction(): String = "first"',
        'fun repeatedAction(value: Int): String = value.toString()',
        '',
      ].join('\n'),
      nativeFunctions: [
        { id: 'function:repeated-first', file: functionKotlinRelativePath, startLine: 3, name: 'repeatedAction' },
        { id: 'function:repeated-second', file: functionKotlinRelativePath, startLine: 4, name: 'repeatedAction' },
      ],
      nativeOwners: [],
    });

    const result = loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root });

    expect(result.endpoints.map(endpoint => ({
      nativeNodeId: endpoint.nativeNodeId,
      file: endpoint.file,
      startLine: endpoint.startLine,
      nativeName: endpoint.nativeName,
    }))).toEqual([
      {
        nativeNodeId: 'function:repeated-first',
        file: functionKotlinRelativePath,
        startLine: 3,
        nativeName: 'repeatedAction',
      },
      {
        nativeNodeId: 'function:repeated-second',
        file: functionKotlinRelativePath,
        startLine: 4,
        nativeName: 'repeatedAction',
      },
    ]);
  });

  it('fails closed for duplicate native function node and source identities', () => {
    const duplicateNodeRoot = makeFunctionFixture('\n', {
      kotlinSource: [
        'package app.nanoflow.host',
        '',
        'fun firstAction(): String = "first"',
        'fun secondAction(): String = "second"',
        '',
      ].join('\n'),
      nativeFunctions: [
        { id: 'function:duplicate', file: functionKotlinRelativePath, startLine: 3, name: 'firstAction' },
        { id: 'function:duplicate', file: functionKotlinRelativePath, startLine: 4, name: 'secondAction' },
      ],
      nativeOwners: [],
      nodeIdPrimaryKey: false,
    });
    const duplicateSourceRoot = makeFunctionFixture('\n', {
      nativeFunctions: [
        { id: 'function:top-level-action-a', file: functionKotlinRelativePath, startLine: 3, name: 'topLevelAction' },
        { id: 'function:top-level-action-b', file: functionKotlinRelativePath, startLine: 3, name: 'topLevelAction' },
      ],
      nativeOwners: [],
    });

    expect(() => loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root: duplicateNodeRoot }))
      .toThrow(expect.objectContaining({ code: 'native-function-identity-ambiguous' }));
    expect(() => loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root: duplicateSourceRoot }))
      .toThrow(expect.objectContaining({ code: 'native-function-identity-ambiguous' }));
  });

  it('classifies class, enum, Gradle KTS, and non-Kotlin native-only functions explicitly', () => {
    const kotlinSource = [
      'package app.nanoflow.host',
      '',
      'fun topLevelAction(): String = "top"',
      '',
      'class WidgetOwner {',
      '  fun memberAction(): String = "member"',
      '}',
      '',
      'enum class WidgetMode {',
      '  ACTIVE;',
      '  fun enumAction(): String = "enum"',
      '}',
      '',
    ].join('\n');
    const root = makeFunctionFixture('\n', {
      kotlinSource,
      nativeFunctions: [
        { id: 'function:top-level-action', file: functionKotlinRelativePath, startLine: 3, name: 'topLevelAction' },
        { id: 'function:member-action', file: functionKotlinRelativePath, startLine: 6, name: 'memberAction' },
        { id: 'function:enum-action', file: functionKotlinRelativePath, startLine: 11, name: 'enumAction' },
        { id: 'function:gradle-helper', file: gradleKotlinRelativePath, startLine: 1, name: 'gradleHelper' },
        { id: 'function:non-kotlin-helper', file: nonKotlinFunctionRelativePath, startLine: 1, name: 'nonKotlinHelper' },
      ],
      nativeOwners: [
        { id: 'class:widget-owner', kind: 'class', name: 'WidgetOwner', startLine: 5, endLine: 7 },
        { id: 'enum:widget-mode', kind: 'enum', name: 'WidgetMode', startLine: 9, endLine: 12 },
      ],
    });
    const sourceBytes = Buffer.from(kotlinSource);
    const contentHash = createHash('sha256').update(sourceBytes).digest('hex');

    const result = loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root });

    expect(result.endpoints).toEqual([{
      nativeNodeId: 'function:top-level-action',
      file: functionKotlinRelativePath,
      startLine: 3,
      nativeName: 'topLevelAction',
      contentHash,
      size: sourceBytes.length,
    }]);
    expect(result.excludedEndpoints.map(endpoint => ({
      nativeNodeId: endpoint.nativeNodeId,
      reason: endpoint.reason,
    }))).toEqual([
      { nativeNodeId: 'function:member-action', reason: 'class-owned' },
      { nativeNodeId: 'function:enum-action', reason: 'enum-owned' },
      { nativeNodeId: 'function:gradle-helper', reason: 'gradle-kts' },
      { nativeNodeId: 'function:non-kotlin-helper', reason: 'non-kt-file' },
    ]);
  });

  it('fails native generation when a real source import is missing from native endpoints', () => {
    const root = makeFixture({
      nativeImports: [
        { id: 'import:fixture-context', startLine: 3, target: 'android.content.Context' },
        { id: 'import:fixture-intent', startLine: 4, target: 'android.content.Intent' },
      ],
      source: [
        'package app.nanoflow',
        '',
        'import android.content.Context',
        'import android.content.Intent',
        'import app.nanoflow.widgets.*',
        '',
        'class MainActivity',
        '',
      ].join('\n'),
    });

    const result = runGenerator(root, 'native');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Native Android import completeness mismatch');
    expect(result.stderr).toContain('missing');
  });

  it('fails native generation when a native endpoint points at a non-code pseudo import', () => {
    const root = makeFixture({
      nativeImports: [
        { id: 'import:fixture-context', startLine: 3, target: 'android.content.Context' },
        { id: 'import:fixture-block-comment', startLine: 6, target: 'fake.BlockComment' },
      ],
      source: [
        'package app.nanoflow',
        '',
        'import android.content.Context',
        '',
        '/*',
        'import fake.BlockComment',
        '*/',
        '',
        'class MainActivity',
        '',
      ].join('\n'),
    });

    const result = runGenerator(root, 'native');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Native Android import completeness mismatch');
    expect(result.stderr).toContain('extra');
  });

  it('uses Android function discovery native by default and never falls back to local', { timeout: 20_000 }, () => {
    const root = makeFunctionFixture('\n', { createDatabase: false });

    const defaultResult = runGenerator(root, undefined, undefined, null);
    const localResult = runFunctionGenerator(root, 'local');
    const nativeResult = runFunctionGenerator(root, 'native');
    const invalidResult = runFunctionGenerator(root, 'unsupported');

    expect(defaultResult.status).not.toBe(0);
    expect(defaultResult.stderr).toContain('native-db-missing');
    expect(localResult.status, localResult.stderr).toBe(0);
    expect(nativeResult.status).not.toBe(0);
    expect(nativeResult.stderr).toContain('native-db-missing');
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stderr).toContain('Invalid value for --android-function-source: unsupported');
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const)(
    'keeps %s real Android Kotlin functions while excluding comment and string pseudo functions',
    { timeout: 20_000 },
    (_label, eol) => {
      const root = makeFunctionFixture(eol);

      const defaultResult = runGenerator(root);
      const expectedFunctions = [
        {
          name: 'topLevelAction',
          qualifiedName: 'app.nanoflow.host.topLevelAction',
          packageName: 'app.nanoflow.host',
          file: functionKotlinRelativePath,
          line: 3,
          startLine: 3,
          endLine: 8,
          signature: 'fun topLevelAction(): String',
          isAsync: false,
          isStatic: false,
          typeReferences: [],
          annotations: [],
        },
        {
          name: 'nestedHelper',
          qualifiedName: 'app.nanoflow.host.nestedHelper',
          packageName: 'app.nanoflow.host',
          file: functionKotlinRelativePath,
          line: 4,
          startLine: 4,
          endLine: 6,
          signature: 'fun nestedHelper(): String',
          isAsync: false,
          isStatic: false,
          typeReferences: [],
          annotations: [],
        },
      ];

      expect(defaultResult.status, defaultResult.stderr).toBe(0);
      const kotlinFunctions = JSON.parse(defaultResult.stdout).android.kotlinFunctions;

      expect(kotlinFunctions).toEqual(expectedFunctions);
      expect(JSON.stringify(kotlinFunctions)).toBe(JSON.stringify(expectedFunctions));
      expect(kotlinFunctions.map((item: Record<string, unknown>) => Object.keys(item))).toEqual(
        expectedFunctions.map(item => Object.keys(item)),
      );
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).toEqual([
        'topLevelAction',
        'nestedHelper',
      ]);
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('memberNestedHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('gradleHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('blockCommentHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('commentHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('stringHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('rawHelper');
      expect(normalizedOverlayOutput(runGenerator(root))).toBe(normalizedOverlayOutput(defaultResult));
      expect(normalizedOverlayOutput(runFunctionGenerator(root, 'local'))).toBe(
        normalizedOverlayOutput(defaultResult),
      );
      expect(normalizedOverlayOutput(runFunctionGenerator(root, 'native'))).toBe(
        normalizedOverlayOutput(defaultResult),
      );
    },
  );

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const)(
    'uses callable-only constructor and generic owner ranges for %s without changing class metadata',
    { timeout: 20_000 },
    (_label, eol) => {
      const root = makeGenericCallableOwnerFixture(eol);
      const result = runGenerator(root);

      expect(result.status, result.stderr).toBe(0);
      const android = JSON.parse(result.stdout).android;
      const file = functionKotlinRelativePath;
      const expectedFunctions = [
        {
          name: 'topGeneric', qualifiedName: 'app.nanoflow.fixture.topGeneric', packageName: 'app.nanoflow.fixture',
          file, line: 21, startLine: 21, endLine: 21, signature: 'inline fun <reified T> topGeneric(value: T): T',
          isAsync: false, isStatic: false, returnType: 'T',
          typeReferences: [
            { typeName: 'T', typeRole: 'parameter', parameterName: 'value', line: 21, column: 41 },
            { typeName: 'T', typeRole: 'return', line: 21, column: 45 },
          ], annotations: [],
        },
        {
          name: 'isCurrent', qualifiedName: 'app.nanoflow.fixture.isCurrent', packageName: 'app.nanoflow.fixture',
          file, line: 23, startLine: 23, endLine: 23, signature: 'fun isCurrent(): String',
          isAsync: false, isStatic: false, typeReferences: [], annotations: [],
        },
        {
          name: 'afterMalformedPlain', qualifiedName: 'app.nanoflow.fixture.afterMalformedPlain', packageName: 'app.nanoflow.fixture',
          file, line: 26, startLine: 26, endLine: 26, signature: 'fun afterMalformedPlain(): String',
          isAsync: false, isStatic: false, typeReferences: [], annotations: [],
        },
        {
          name: 'afterMalformedPrivate', qualifiedName: 'app.nanoflow.fixture.afterMalformedPrivate', packageName: 'app.nanoflow.fixture',
          file, line: 27, startLine: 27, endLine: 27, signature: 'private fun afterMalformedPrivate(): String',
          visibility: 'private', isAsync: false, isStatic: false, typeReferences: [], annotations: [],
        },
        {
          name: 'afterMalformedInternal', qualifiedName: 'app.nanoflow.fixture.afterMalformedInternal', packageName: 'app.nanoflow.fixture',
          file, line: 28, startLine: 28, endLine: 28, signature: 'internal fun afterMalformedInternal(): String',
          visibility: 'internal', isAsync: false, isStatic: false, typeReferences: [], annotations: [],
        },
      ];
      const expectedMethods = [
        {
          name: 'isCurrent', qualifiedName: 'app.nanoflow.fixture.First::isCurrent',
          ownerName: 'First', ownerQualifiedName: 'app.nanoflow.fixture.First', ownerKind: 'class',
          packageName: 'app.nanoflow.fixture', file, line: 8, startLine: 8, endLine: 8,
          signature: 'fun isCurrent(): String', isAsync: false, isStatic: false, isOverride: false,
          typeReferences: [], annotations: [],
        },
        {
          name: 'secondAction', qualifiedName: 'app.nanoflow.fixture.Second::secondAction',
          ownerName: 'Second', ownerQualifiedName: 'app.nanoflow.fixture.Second', ownerKind: 'class',
          packageName: 'app.nanoflow.fixture', file, line: 14, startLine: 14, endLine: 14,
          signature: 'fun secondAction(request: Request): String', isAsync: false, isStatic: false, isOverride: false,
          typeReferences: [{
            typeName: 'Request', typeRole: 'parameter', parameterName: 'request', line: 14, column: 28,
          }], annotations: [],
        },
      ];
      const expectedNonCallable = {
        classes: [
          {
            name: 'First', qualifiedName: 'app.nanoflow.fixture.First', packageName: 'app.nanoflow.fixture',
            classKind: 'class', declarationKind: 'class', modifiers: ['internal'], annotations: [], heritage: [], heritageTypes: [],
            file, line: 5, startLine: 5, endLine: 5, signature: 'internal class First', isAbstract: false,
          },
          {
            name: 'Second', qualifiedName: 'app.nanoflow.fixture.Second', packageName: 'app.nanoflow.fixture',
            classKind: 'class', declarationKind: 'class', modifiers: ['internal'], annotations: [], heritage: [], heritageTypes: [],
            file, line: 11, startLine: 11, endLine: 11, signature: 'internal class Second', isAbstract: false,
          },
          {
            name: 'PendingRequest', qualifiedName: 'app.nanoflow.fixture.PendingRequest', packageName: 'app.nanoflow.fixture',
            classKind: 'class', declarationKind: 'class', modifiers: ['private', 'data'], annotations: [], heritage: [], heritageTypes: [],
            file, line: 16, startLine: 16, endLine: 16, signature: 'private data class PendingRequest', isAbstract: false,
          },
          {
            name: 'Broken', qualifiedName: 'app.nanoflow.fixture.Broken', packageName: 'app.nanoflow.fixture',
            classKind: 'class', declarationKind: 'class', modifiers: [], annotations: [], heritage: [], heritageTypes: [],
            file, line: 25, startLine: 25, endLine: 25, signature: 'class Broken', isAbstract: false,
          },
        ],
        enums: [], constructors: [{ name: 'constructor', qualifiedName: 'app.nanoflow.fixture.First::constructor', ownerName: 'First', ownerQualifiedName: 'app.nanoflow.fixture.First', ownerKind: 'class', packageName: 'app.nanoflow.fixture', file, line: 5, startLine: 5, endLine: 7, signature: 'internal constructor( private val seed: String, )', visibility: 'internal', isAsync: false, isStatic: false }], properties: eol === '\r\n' ? [
          {
            name: 'seed', qualifiedName: 'app.nanoflow.fixture.First::seed', ownerName: 'First',
            ownerQualifiedName: 'app.nanoflow.fixture.First', ownerKind: 'class', packageName: 'app.nanoflow.fixture',
            file, line: 5, startLine: 5, endLine: 5, signature: 'private val seed: String,', visibility: 'private',
            isMutable: false, isConst: false, isOverride: false, isStatic: false, annotations: [],
            typeReferences: [],
          },
          {
            name: 'transform', qualifiedName: 'app.nanoflow.fixture.Second::transform', ownerName: 'Second',
            ownerQualifiedName: 'app.nanoflow.fixture.Second', ownerKind: 'class', packageName: 'app.nanoflow.fixture',
            file, line: 11, startLine: 11, endLine: 11,
            signature: 'private val transform: (Request) -> String = { request -> request.toString() },', visibility: 'private',
            isMutable: false, isConst: false, isOverride: false, isStatic: false, annotations: [], typeName: 'Request',
            typeReferences: [{ typeName: 'Request', typeRole: 'property', line: 11 }],
          },
          {
            name: 'request', qualifiedName: 'app.nanoflow.fixture.PendingRequest::request', ownerName: 'PendingRequest',
            ownerQualifiedName: 'app.nanoflow.fixture.PendingRequest', ownerKind: 'class', packageName: 'app.nanoflow.fixture',
            file, line: 16, startLine: 16, endLine: 16, signature: 'val request: Request,',
            isMutable: false, isConst: false, isOverride: false, isStatic: false, annotations: [], typeName: 'Request',
            typeReferences: [{ typeName: 'Request', typeRole: 'property', line: 16 }],
          },
        ] : [],
        heritage: [
          { file, name: 'First', heritage: [], heritageTypes: [] },
          { file, name: 'Second', heritage: [], heritageTypes: [] },
          { file, name: 'PendingRequest', heritage: [], heritageTypes: [] },
          { file, name: 'Broken', heritage: [], heritageTypes: [] },
        ],
      };
      const nonCallable = {
        classes: android.kotlinClasses,
        enums: android.kotlinEnums,
        constructors: android.kotlinConstructors,
        properties: android.kotlinProperties,
        heritage: android.kotlinClasses.map((item: {
          file: string; name: string; heritage: unknown[]; heritageTypes: string[];
        }) => ({ file: item.file, name: item.name, heritage: item.heritage, heritageTypes: item.heritageTypes })),
      };

      expect(JSON.stringify(android.kotlinFunctions)).toBe(JSON.stringify(expectedFunctions));
      expect(JSON.stringify(android.kotlinMethods)).toBe(JSON.stringify(expectedMethods));
      expect(JSON.stringify(nonCallable)).toBe(JSON.stringify(expectedNonCallable));
    },
  );

  it('does not classify methods in a multiline-heritage class as top-level native functions', { timeout: 20_000 }, () => {
    const root = makeFunctionFixture('\n', {
      kotlinSource: [
        'package app.nanoflow.host',
        '',
        'class Worker(appContext: Context, params: WorkerParameters) :',
        '  CoroutineWorker(appContext, params) {',
        '  fun doWork(): String = "done"',
        '}',
        '',
        'fun ExternalPayload<*>.toDisplay(): String = "extension"',
        '',
        'fun topLevel(): String = "top"',
        '',
      ].join('\n'),
      nativeFunctions: [
        { id: 'function:top-level', file: functionKotlinRelativePath, startLine: 10, name: 'topLevel' },
      ],
      nativeOwners: [
        { id: 'class:worker', kind: 'class', name: 'Worker', startLine: 3, endLine: 6 },
      ],
    });

    const result = runFunctionGenerator(root, 'native');

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).android.kotlinFunctions.map((item: { name: string }) => item.name))
      .toEqual(['topLevel']);
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const)(
    'restores %s real Android Kotlin functions after astral text before the declaration',
    { timeout: 20_000 },
    (_label, eol) => {
      const root = makeAstralFunctionFixture(eol);

      const result = runGenerator(root);
      const expectedFunctions = [
        {
          name: 'topLevelAction',
          qualifiedName: 'app.nanoflow.host.topLevelAction',
          packageName: 'app.nanoflow.host',
          file: functionKotlinRelativePath,
          line: 5,
          startLine: 5,
          endLine: 10,
          signature: 'fun topLevelAction(): String',
          isAsync: false,
          isStatic: false,
          typeReferences: [],
          annotations: [],
        },
        {
          name: 'nestedHelper',
          qualifiedName: 'app.nanoflow.host.nestedHelper',
          packageName: 'app.nanoflow.host',
          file: functionKotlinRelativePath,
          line: 6,
          startLine: 6,
          endLine: 8,
          signature: 'fun nestedHelper(): String',
          isAsync: false,
          isStatic: false,
          typeReferences: [],
          annotations: [],
        },
      ];

      expect(result.status, result.stderr).toBe(0);
      const kotlinFunctions = JSON.parse(result.stdout).android.kotlinFunctions;

      expect(kotlinFunctions).toEqual(expectedFunctions);
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('memberNestedHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('gradleHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('blockCommentHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('commentHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('stringHelper');
      expect(kotlinFunctions.map((item: { name: string }) => item.name)).not.toContain('rawHelper');
      expect(normalizedOverlayOutput(runFunctionGenerator(root, 'local'))).toBe(
        normalizedOverlayOutput(result),
      );
      expect(normalizedOverlayOutput(runFunctionGenerator(root, 'native'))).toBe(
        normalizedOverlayOutput(result),
      );
    },
  );

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const)(
    'publishes %s native function endpoints aligned after astral text',
    (_label, eol) => {
      const root = makeAstralFunctionFixture(eol);

      const result = loadSidecar().readNativeAndroidKotlinFunctionEndpoints({ root });

      expect(result.projectRoot).toBe(realpathSync(root));
      expect(result.database).toEqual({
        path: '.codegraph/codegraph.db',
        readOnly: true,
        queryOnly: 1,
        schemaVersion: 8,
      });
      expect(result.endpoints.map(item => ({
        file: item.file,
        startLine: item.startLine,
        nativeName: item.nativeName,
      }))).toEqual([
        {
          file: functionKotlinRelativePath,
          startLine: 5,
          nativeName: 'topLevelAction',
        },
        {
          file: functionKotlinRelativePath,
          startLine: 6,
          nativeName: 'nestedHelper',
        },
      ]);
      expect(result.excludedEndpoints.map(item => ({
        file: item.file,
        startLine: item.startLine,
        nativeName: item.nativeName,
        reason: item.reason,
      }))).toEqual([
        {
          file: functionKotlinRelativePath,
          startLine: 23,
          nativeName: 'memberNestedHelper',
          reason: 'class-owned',
        },
        {
          file: gradleKotlinRelativePath,
          startLine: 1,
          nativeName: 'gradleHelper',
          reason: 'gradle-kts',
        },
      ]);
    },
  );

  it('fails native function generation on missing, extra, and stale endpoint inventories', { timeout: 20_000 }, () => {
    const missingRoot = makeFunctionFixture('\n', {
      nativeFunctions: [
        { id: 'function:top-level-action', file: functionKotlinRelativePath, startLine: 3, name: 'topLevelAction' },
      ],
      nativeOwners: [],
    });
    const extraFile = 'android/build/generated/NativeOnly.kt';
    const extraRoot = makeFunctionFixture('\n', {
      extraSources: [{ file: extraFile, source: 'fun nativeOnlyAction(): String = "native"\n' }],
      nativeFunctions: [
        { id: 'function:top-level-action', file: functionKotlinRelativePath, startLine: 3, name: 'topLevelAction' },
        { id: 'function:nested-helper', file: functionKotlinRelativePath, startLine: 4, name: 'nestedHelper' },
        { id: 'function:native-only', file: extraFile, startLine: 1, name: 'nativeOnlyAction' },
      ],
      nativeOwners: [],
    });
    const staleRoot = makeFunctionFixture();
    appendFileSync(path.join(staleRoot, functionKotlinRelativePath), '\n// stale source');

    const missingResult = runFunctionGenerator(missingRoot, 'native');
    const extraResult = runFunctionGenerator(extraRoot, 'native');
    const staleResult = runFunctionGenerator(staleRoot, 'native');

    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toContain('Native Android function completeness mismatch');
    expect(missingResult.stderr).toContain('missing');
    expect(extraResult.status).not.toBe(0);
    expect(extraResult.stderr).toContain('Native Android function completeness mismatch');
    expect(extraResult.stderr).toContain('extra');
    expect(staleResult.status).not.toBe(0);
    expect(staleResult.stderr).toContain('native-source-stale');
  });
});
