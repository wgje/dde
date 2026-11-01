#!/usr/bin/env node

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const {
  readOverlayCurrentReceipt,
} = require('./codegraph-overlay-current-receipt.cjs');

const EXPECTED_SCHEMA_VERSION = 11;
const NATIVE_DB_ACCESS_ENV = 'NANOFLOW_CODEGRAPH_NATIVE_DB_ACCESS';
const NATIVE_DB_PATH_ENV = 'NANOFLOW_CODEGRAPH_NATIVE_DB_PATH';
const COORDINATED_NATIVE_DB_ACCESS = 'coordinated';
const IMMUTABLE_STATIC_NATIVE_DB_ACCESS = 'immutable-static';
const MAX_NATIVE_ANDROID_IMPORT_ENDPOINTS = 10_000;
const MAX_NATIVE_ANDROID_FUNCTION_ENDPOINTS = 10_000;
const REQUIRED_COLUMNS = new Map([
  ['nodes', new Map([
    ['id', 'TEXT'],
    ['kind', 'TEXT'],
    ['name', 'TEXT'],
    ['qualified_name', 'TEXT'],
    ['file_path', 'TEXT'],
    ['language', 'TEXT'],
    ['start_line', 'INTEGER'],
    ['end_line', 'INTEGER'],
    ['start_column', 'INTEGER'],
    ['end_column', 'INTEGER'],
    ['signature', 'TEXT'],
    ['updated_at', 'INTEGER'],
  ])],
  ['edges', new Map([
    ['id', 'INTEGER'],
    ['source', 'TEXT'],
    ['target', 'TEXT'],
    ['kind', 'TEXT'],
  ])],
  ['schema_versions', new Map([
    ['version', 'INTEGER'],
    ['applied_at', 'INTEGER'],
    ['description', 'TEXT'],
  ])],
]);
const NATIVE_SOURCE_FILE_COLUMNS = new Map([
  ['files', new Map([
    ['path', 'TEXT'],
    ['content_hash', 'TEXT'],
    ['language', 'TEXT'],
    ['size', 'INTEGER'],
    ['generated', 'INTEGER'],
  ])],
]);
const ANDROID_IMPORT_ENDPOINT_COLUMNS = NATIVE_SOURCE_FILE_COLUMNS;
const ANDROID_FUNCTION_ENDPOINT_COLUMNS = NATIVE_SOURCE_FILE_COLUMNS;

class NativeGraphSidecarError extends Error {
  constructor(code, message, details = null, audit = null) {
    super(message);
    this.name = 'NativeGraphSidecarError';
    this.code = code;
    this.details = details;
    this.audit = audit;
  }
}

function fail(code, message, details = null, audit = null) {
  throw new NativeGraphSidecarError(code, message, details, audit);
}

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root' && index + 1 < argv.length) {
      args.root = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--json') {
      args.json = true;
      continue;
    }
    fail('invalid-argument', `Unknown or incomplete argument: ${value}`, { argument: value });
  }
  return args;
}

function resolveProjectPaths(rootInput, options = {}) {
  return resolveNativeProjectPaths(rootInput, options);
}

function resolveNativeProjectPaths(rootInput, options = {}) {
  const requestedRoot = path.resolve(rootInput);
  if (!fs.existsSync(requestedRoot)) {
    fail('project-root-missing', `Project root does not exist: ${requestedRoot}`, {
      path: requestedRoot,
    });
  }
  if (!fs.statSync(requestedRoot).isDirectory()) {
    fail('project-root-not-directory', `Project root is not a directory: ${requestedRoot}`, {
      path: requestedRoot,
    });
  }

  const root = fs.realpathSync(requestedRoot);
  const codegraphRoot = path.join(root, '.codegraph');
  const databasePath = resolveNativeDatabasePath(codegraphRoot, options);
  return { root, databasePath };
}

function resolveNativeDatabasePath(codegraphRoot, options) {
  const optionPath = options.databasePath;
  const databasePath = optionPath !== undefined ? optionPath : process.env[NATIVE_DB_PATH_ENV];
  if (databasePath === undefined) {
    return resolveRequiredFile(codegraphRoot, 'codegraph.db', 'native-db-missing', 'Native CodeGraph database');
  }
  const accessMode = resolveNativeDatabaseAccess(options);
  if (accessMode !== IMMUTABLE_STATIC_NATIVE_DB_ACCESS) {
    fail('native-db-path-requires-immutable-static', 'Custom native database paths require immutable-static access', {
      accessMode,
      option: 'databasePath',
      environment: NATIVE_DB_PATH_ENV,
    });
  }
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
    fail('native-db-path-invalid', 'Custom native database path must be absolute', {
      reason: 'not-absolute',
      path: typeof databasePath === 'string' ? databasePath : null,
    });
  }
  if (!fs.existsSync(databasePath)) {
    fail('native-db-path-invalid', `Custom native database does not exist: ${databasePath}`, {
      reason: 'missing',
      path: databasePath,
    });
  }
  if (!fs.statSync(databasePath).isFile()) {
    fail('native-db-path-invalid', `Custom native database is not a file: ${databasePath}`, {
      reason: 'not-file',
      path: databasePath,
    });
  }
  return fs.realpathSync(databasePath);
}

function resolveRequiredFile(parent, basename, missingCode, label) {
  const candidate = path.join(parent, basename);
  if (!fs.existsSync(candidate)) {
    fail(missingCode, `${label} does not exist: ${candidate}`, { path: candidate });
  }
  if (!fs.statSync(candidate).isFile()) {
    fail('invalid-project-path', `${label} is not a file: ${candidate}`, { path: candidate });
  }

  const realParent = fs.realpathSync(parent);
  const realFile = fs.realpathSync(candidate);
  const relative = path.relative(realParent, realFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('invalid-project-path', `${label} resolves outside .codegraph`, {
      path: candidate,
      resolvedPath: realFile,
    });
  }
  return realFile;
}

function readOverlay(root) {
  const currentReceipt = readOverlayCurrentReceipt(root);
  if (!currentReceipt.ok) {
    fail('overlay-current-invalid', 'Unable to authenticate NanoFlow overlay CURRENT receipt', {
      errorCode: currentReceipt.errorCode,
    });
  }
  const overlay = currentReceipt.overlay;

  const graphNodes = overlay?.graph?.nodes;
  const graphEdges = overlay?.graph?.edges;
  const androidImports = overlay?.android?.kotlinImports;
  if (!Array.isArray(graphNodes) || !Array.isArray(graphEdges)) {
    fail('overlay-schema-drift', 'NanoFlow overlay graph nodes/edges must be arrays', {
      generationId: currentReceipt.current.generationId,
    });
  }
  if (!Array.isArray(androidImports)) {
    fail('overlay-schema-drift', 'NanoFlow overlay android.kotlinImports must be an array', {
      generationId: currentReceipt.current.generationId,
    });
  }
  if (androidImports.length === 0) {
    fail('android-imports-empty', 'NanoFlow overlay contains no Android Kotlin imports', {
      generationId: currentReceipt.current.generationId,
    });
  }

  const identities = androidImports.map((entry, index) => normalizeOverlayImport(entry, index));
  return {
    counts: { nodes: graphNodes.length, edges: graphEdges.length },
    identities,
  };
}

function normalizeOverlayImport(entry, index) {
  const file = normalizeGraphPath(entry?.file);
  const target = typeof entry?.target === 'string' ? entry.target.trim() : '';
  const startLine = entry?.startLine;
  if (!file || !target || !Number.isInteger(startLine) || startLine < 1) {
    fail('overlay-android-import-invalid', `Invalid Android Kotlin import at index ${index}`, {
      index,
      file: entry?.file ?? null,
      startLine: entry?.startLine ?? null,
      target: entry?.target ?? null,
    });
  }
  return { file, startLine, target };
}

function normalizeGraphPath(value) {
  return typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
}

function resolveNativeDatabaseAccess(options) {
  const accessMode = options.databaseAccess
    ?? process.env[NATIVE_DB_ACCESS_ENV]
    ?? COORDINATED_NATIVE_DB_ACCESS;
  if (accessMode !== COORDINATED_NATIVE_DB_ACCESS && accessMode !== IMMUTABLE_STATIC_NATIVE_DB_ACCESS) {
    fail('native-db-access-mode-invalid', `Invalid native database access mode: ${accessMode}`, {
      accessMode,
      option: 'databaseAccess',
      environment: NATIVE_DB_ACCESS_ENV,
    });
  }
  return accessMode;
}

function snapshotNativeDatabaseTrio(databasePath) {
  return Object.fromEntries([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(filePath => {
    try {
      const stats = fs.statSync(filePath, { bigint: true });
      return [path.basename(filePath), {
        exists: true,
        length: Number(stats.size),
        mtimeNs: stats.mtimeNs.toString(),
      }];
    } catch (error) {
      if (error?.code === 'ENOENT') return [path.basename(filePath), { exists: false }];
      throw error;
    }
  }));
}

function prepareImmutableStaticDatabase(databasePath) {
  const daemonPath = path.join(path.dirname(databasePath), 'daemon.pid');
  if (fs.existsSync(daemonPath)) {
    fail('native-db-immutable-static-precondition', 'Immutable-static access requires no active daemon', {
      reason: 'daemon-present',
      path: daemonPath,
    });
  }
  const before = snapshotNativeDatabaseTrio(databasePath);
  if (!before[path.basename(databasePath)]?.exists) {
    fail('native-db-immutable-static-precondition', 'Immutable-static database does not exist', {
      reason: 'database-missing',
      path: databasePath,
    });
  }
  const walPath = `${databasePath}-wal`;
  const wal = before[path.basename(walPath)];
  if (wal?.exists && wal.length !== 0) {
    fail('native-db-immutable-static-precondition', 'Immutable-static access requires an empty WAL', {
      reason: 'wal-nonempty',
      path: walPath,
      length: wal.length,
    });
  }
  return { before, daemonPath };
}

function assertImmutableStaticDatabaseUnchanged(databasePath, state) {
  if (fs.existsSync(state.daemonPath)) {
    fail('native-db-immutable-static-drift', 'CodeGraph daemon appeared during immutable-static access', {
      reason: 'daemon-appeared',
      path: state.daemonPath,
    });
  }
  const after = snapshotNativeDatabaseTrio(databasePath);
  if (JSON.stringify(after) !== JSON.stringify(state.before)) {
    fail('native-db-immutable-static-drift', 'Native database metadata changed during immutable-static access', {
      reason: 'database-trio-changed',
      before: state.before,
      after,
    });
  }
}

function withNativeDatabase(databasePath, options, read) {
  const accessMode = resolveNativeDatabaseAccess(options);
  const immutableState = accessMode === IMMUTABLE_STATIC_NATIVE_DB_ACCESS
    ? prepareImmutableStaticDatabase(databasePath)
    : null;
  let databaseTarget = databasePath;
  if (immutableState) {
    databaseTarget = pathToFileURL(databasePath);
    databaseTarget.searchParams.set('immutable', '1');
  }
  let database;
  try {
    database = new DatabaseSync(databaseTarget, { readOnly: true });
  } catch (error) {
    if (immutableState) assertImmutableStaticDatabaseUnchanged(databasePath, immutableState);
    fail('native-db-open-failed', `Unable to open native CodeGraph database read-only: ${error.message}`, {
      path: databasePath,
    });
  }

  let result;
  let readError;
  try {
    database.exec('PRAGMA query_only = ON');
    const queryOnly = Number(database.prepare('PRAGMA query_only').get()?.query_only);
    if (queryOnly !== 1) {
      fail('native-db-not-query-only', 'Native CodeGraph database did not enter query-only mode', {
        path: databasePath,
        queryOnly,
      });
    }
    result = read(database, queryOnly);
  } catch (error) {
    readError = error;
  } finally {
    database.close();
    if (immutableState) assertImmutableStaticDatabaseUnchanged(databasePath, immutableState);
  }
  if (readError) throw readError;
  return result;
}

function inspectNativeGraph(databasePath, overlayIdentities, options) {
  return withNativeDatabase(databasePath, options, (database, queryOnly) => {
    const schemaVersion = validateNativeSchema(database);
    const snapshot = readNativeSnapshot(database, overlayIdentities);
    return { database: { readOnly: true, queryOnly, schemaVersion }, ...snapshot };
  });
}

function validateNativeSchema(database, additionalColumns = new Map()) {
  for (const [table, requiredColumns] of new Map([...REQUIRED_COLUMNS, ...additionalColumns])) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.length === 0) {
      fail('native-schema-drift', `Native CodeGraph table is missing: ${table}`, { table });
    }
    const actualColumns = new Map(columns.map(column => [column.name, String(column.type).toUpperCase()]));
    const missing = [];
    const incompatible = [];
    for (const [name, expectedType] of requiredColumns) {
      if (!actualColumns.has(name)) {
        missing.push(name);
      } else if (actualColumns.get(name) !== expectedType) {
        incompatible.push({ name, expectedType, actualType: actualColumns.get(name) });
      }
    }
    if (missing.length > 0 || incompatible.length > 0) {
      fail('native-schema-drift', `Native CodeGraph table schema is incompatible: ${table}`, {
        table,
        missing,
        incompatible,
      });
    }
  }

  const row = database.prepare('SELECT MAX(version) AS version FROM schema_versions').get();
  const schemaVersion = Number(row?.version);
  if (schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    fail('native-schema-drift', 'Native CodeGraph schema version does not match the pinned contract', {
      table: 'schema_versions',
      expectedVersion: EXPECTED_SCHEMA_VERSION,
      actualVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
    });
  }
  return schemaVersion;
}

function readNativeAndroidKotlinImportEndpoints(options = {}) {
  const paths = resolveNativeProjectPaths(options.root ?? process.cwd(), options);
  const native = inspectNativeAndroidKotlinImportEndpoints(paths.databasePath, paths.root, options);
  return {
    projectRoot: paths.root,
    database: {
      path: normalizeGraphPath(path.relative(paths.root, paths.databasePath)),
      ...native.database,
    },
    endpoints: native.endpoints,
  };
}

function readNativeAndroidKotlinFunctionEndpoints(options = {}) {
  const paths = resolveNativeProjectPaths(options.root ?? process.cwd(), options);
  const native = inspectNativeAndroidKotlinFunctionEndpoints(paths.databasePath, paths.root, options);
  return {
    projectRoot: paths.root,
    database: {
      path: normalizeGraphPath(path.relative(paths.root, paths.databasePath)),
      ...native.database,
    },
    endpoints: native.endpoints,
    excludedEndpoints: native.excludedEndpoints,
  };
}

function inspectNativeAndroidKotlinImportEndpoints(databasePath, root, options) {
  return withNativeDatabase(databasePath, options, (database, queryOnly) => {
    const schemaVersion = validateNativeSchema(database, ANDROID_IMPORT_ENDPOINT_COLUMNS);
    const rows = readNativeAndroidImportSnapshot(database);
    return {
      database: { readOnly: true, queryOnly, schemaVersion },
      endpoints: validateNativeAndroidImportEndpoints(root, rows),
    };
  });
}

function inspectNativeAndroidKotlinFunctionEndpoints(databasePath, root, options) {
  return withNativeDatabase(databasePath, options, (database, queryOnly) => {
    const schemaVersion = validateNativeSchema(database, ANDROID_FUNCTION_ENDPOINT_COLUMNS);
    const snapshot = readNativeAndroidFunctionSnapshot(database);
    return {
      database: { readOnly: true, queryOnly, schemaVersion },
      ...validateNativeAndroidFunctionEndpoints(root, snapshot),
    };
  });
}

function readNativeAndroidImportSnapshot(database) {
  database.exec('BEGIN');
  try {
    const total = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes
      WHERE kind = 'import' AND language = 'kotlin' AND file_path LIKE 'android/%'
    `).get().count);
    if (total === 0) {
      fail('native-android-imports-empty', 'Native CodeGraph contains no Android Kotlin imports');
    }
    if (total > MAX_NATIVE_ANDROID_IMPORT_ENDPOINTS) {
      fail('native-android-import-cap-exceeded', 'Native Android Kotlin import endpoint cap exceeded', {
        total,
        cap: MAX_NATIVE_ANDROID_IMPORT_ENDPOINTS,
      });
    }
    const rows = database.prepare(`
      SELECT
        nodes.id,
        nodes.name,
        nodes.file_path,
        nodes.start_line,
        files.path AS indexed_file_path,
        files.content_hash,
        files.size
      FROM nodes
      LEFT JOIN files ON files.path = nodes.file_path
      WHERE nodes.kind = 'import'
        AND nodes.language = 'kotlin'
        AND nodes.file_path LIKE 'android/%'
      ORDER BY nodes.file_path, nodes.start_line, nodes.name, nodes.id
      LIMIT ?
    `).all(MAX_NATIVE_ANDROID_IMPORT_ENDPOINTS + 1);
    if (rows.length !== total) {
      fail('native-import-snapshot-incomplete', 'Native Android import snapshot count changed or was truncated', {
        expected: total,
        actual: rows.length,
      });
    }
    database.exec('COMMIT');
    return rows;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original read or contract failure.
    }
    throw error;
  }
}

function readNativeAndroidFunctionSnapshot(database) {
  database.exec('BEGIN');
  try {
    const total = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes
      WHERE kind = 'function' AND language = 'kotlin' AND file_path LIKE 'android/%'
    `).get().count);
    if (total === 0) {
      fail('native-android-functions-empty', 'Native CodeGraph contains no Android Kotlin functions');
    }
    if (total > MAX_NATIVE_ANDROID_FUNCTION_ENDPOINTS) {
      fail('native-android-function-cap-exceeded', 'Native Android Kotlin function endpoint cap exceeded', {
        total,
        cap: MAX_NATIVE_ANDROID_FUNCTION_ENDPOINTS,
      });
    }
    const rows = database.prepare(`
      SELECT
        nodes.id,
        nodes.name,
        nodes.file_path,
        nodes.start_line,
        files.path AS indexed_file_path,
        files.content_hash,
        files.size
      FROM nodes
      LEFT JOIN files ON files.path = nodes.file_path
      WHERE nodes.kind = 'function'
        AND nodes.language = 'kotlin'
        AND nodes.file_path LIKE 'android/%'
      ORDER BY nodes.file_path, nodes.start_line, nodes.name, nodes.id
      LIMIT ?
    `).all(MAX_NATIVE_ANDROID_FUNCTION_ENDPOINTS + 1);
    if (rows.length !== total) {
      fail('native-function-snapshot-incomplete', 'Native Android function snapshot count changed or was truncated', {
        expected: total,
        actual: rows.length,
      });
    }
    const ownerRows = database.prepare(`
      SELECT
        id,
        kind,
        name,
        qualified_name,
        file_path,
        start_line,
        end_line
      FROM nodes
      WHERE kind IN ('class', 'enum')
        AND language = 'kotlin'
        AND file_path LIKE 'android/%'
      ORDER BY file_path, start_line, end_line, name, id
    `).all();
    database.exec('COMMIT');
    return { rows, ownerRows };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original read or contract failure.
    }
    throw error;
  }
}

function validateNativeAndroidImportEndpoints(root, rows) {
  const nativeNodeIds = new Set();
  const sourceIdentities = new Set();
  const sourcesByFile = new Map();
  const endpoints = [];

  for (const row of rows) {
    const nativeNodeId = typeof row.id === 'string' ? row.id.trim() : '';
    const file = normalizeGraphPath(row.file_path);
    const nativeTarget = typeof row.name === 'string' ? row.name.trim() : '';
    const startLine = Number(row.start_line);
    if (!nativeNodeId || !file || !nativeTarget || !Number.isInteger(startLine) || startLine < 1) {
      fail('native-import-endpoint-invalid', 'Native Android import endpoint is incomplete', {
        nativeNodeId: nativeNodeId || null,
        file: file || null,
        startLine: Number.isFinite(startLine) ? startLine : null,
        nativeTarget: nativeTarget || null,
      });
    }
    if (nativeNodeIds.has(nativeNodeId)) {
      fail('native-import-identity-ambiguous', 'Native Android import node id is duplicated', {
        nativeNodeId,
      });
    }
    const sourceIdentity = `${file}\0${startLine}`;
    if (sourceIdentities.has(sourceIdentity)) {
      fail('native-import-identity-ambiguous', 'Multiple native Android imports map to one source line', {
        file,
        startLine,
      });
    }
    nativeNodeIds.add(nativeNodeId);
    sourceIdentities.add(sourceIdentity);

    const contentHash = typeof row.content_hash === 'string' ? row.content_hash.trim().toLowerCase() : '';
    const size = Number(row.size);
    if (!row.indexed_file_path || !/^[a-f0-9]{64}$/.test(contentHash) || !Number.isInteger(size) || size < 0) {
      fail('native-import-file-metadata-invalid', 'Native Android import file metadata is missing or invalid', {
        file,
        contentHash: contentHash || null,
        size: Number.isFinite(size) ? size : null,
      });
    }

    let source = sourcesByFile.get(file);
    if (!source) {
      source = readFreshNativeSource(root, file, contentHash, size);
      sourcesByFile.set(file, source);
    } else if (source.contentHash !== contentHash || source.size !== size) {
      fail('native-import-file-metadata-ambiguous', 'Native Android import rows disagree on file identity', {
        file,
      });
    }
    assertNativeImportSourceIdentity(source.text, file, startLine, nativeTarget);
    endpoints.push({ nativeNodeId, file, startLine, nativeTarget, contentHash, size });
  }
  return endpoints;
}

function validateNativeAndroidFunctionEndpoints(root, snapshot) {
  const nativeNodeIds = new Set();
  const sourceIdentities = new Set();
  const sourcesByFile = new Map();
  const ownerRangesByFile = indexNativeKotlinOwnerRanges(snapshot.ownerRows);
  const endpoints = [];
  const excludedEndpoints = [];

  for (const row of snapshot.rows) {
    const nativeNodeId = typeof row.id === 'string' ? row.id.trim() : '';
    const file = normalizeGraphPath(row.file_path);
    const nativeName = typeof row.name === 'string' ? row.name.trim() : '';
    const startLine = Number(row.start_line);
    if (!nativeNodeId || !file || !nativeName || !Number.isInteger(startLine) || startLine < 1) {
      fail('native-function-endpoint-invalid', 'Native Android function endpoint is incomplete', {
        nativeNodeId: nativeNodeId || null,
        file: file || null,
        startLine: Number.isFinite(startLine) ? startLine : null,
        nativeName: nativeName || null,
      });
    }
    if (nativeNodeIds.has(nativeNodeId)) {
      fail('native-function-identity-ambiguous', 'Native Android function node id is duplicated', {
        nativeNodeId,
      });
    }
    const sourceIdentity = `${file}\0${startLine}\0${nativeName}`;
    if (sourceIdentities.has(sourceIdentity)) {
      fail('native-function-identity-ambiguous', 'Multiple native Android functions map to one source identity', {
        file,
        startLine,
        nativeName,
      });
    }
    nativeNodeIds.add(nativeNodeId);
    sourceIdentities.add(sourceIdentity);

    const contentHash = typeof row.content_hash === 'string' ? row.content_hash.trim().toLowerCase() : '';
    const size = Number(row.size);
    if (!row.indexed_file_path || !/^[a-f0-9]{64}$/.test(contentHash) || !Number.isInteger(size) || size < 0) {
      fail('native-function-file-metadata-invalid', 'Native Android function file metadata is missing or invalid', {
        file,
        contentHash: contentHash || null,
        size: Number.isFinite(size) ? size : null,
      });
    }

    let source = sourcesByFile.get(file);
    if (!source) {
      source = readFreshNativeSource(root, file, contentHash, size);
      sourcesByFile.set(file, source);
    } else if (source.contentHash !== contentHash || source.size !== size) {
      fail('native-function-file-metadata-ambiguous', 'Native Android function rows disagree on file identity', {
        file,
      });
    }

    assertNativeFunctionSourceIdentity(source.text, file, startLine, nativeName);
    const endpoint = {
      nativeNodeId,
      file,
      startLine,
      nativeName,
      contentHash,
      size,
    };
    const classification = classifyNativeAndroidFunctionEndpoint(
      file,
      startLine,
      ownerRangesByFile.get(file) ?? [],
    );
    if (classification === null) {
      endpoints.push(endpoint);
    } else {
      excludedEndpoints.push({ ...endpoint, reason: classification });
    }
  }

  excludedEndpoints.sort(compareExcludedNativeFunctionEndpoints);
  return { endpoints, excludedEndpoints };
}

function readFreshNativeSource(root, file, contentHash, size) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) {
    fail('native-source-path-invalid', 'Native Android import path is not project-relative', { file });
  }
  const candidate = path.resolve(root, ...file.split('/'));
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    fail('native-source-missing', 'Native Android import source file is missing', { file });
  }
  const realSource = fs.realpathSync(candidate);
  const relativeSource = normalizeGraphPath(path.relative(root, realSource));
  if (relativeSource.startsWith('../') || path.isAbsolute(relativeSource) || !sameGraphPath(relativeSource, file)) {
    fail('native-source-path-invalid', 'Native Android import source resolves outside its indexed identity', {
      file,
      resolvedFile: relativeSource,
    });
  }
  const content = fs.readFileSync(realSource);
  const actualHash = createHash('sha256').update(content).digest('hex');
  if (content.length !== size || actualHash !== contentHash) {
    fail('native-source-stale', 'Native Android import source differs from the indexed file snapshot', {
      file,
      expectedHash: contentHash,
      actualHash,
      expectedSize: size,
      actualSize: content.length,
    });
  }
  return { text: content.toString('utf8'), contentHash, size };
}

function assertNativeImportSourceIdentity(source, file, startLine, nativeTarget) {
  const line = source.split(/\r?\n/)[startLine - 1] ?? '';
  const match = /^[ \t]*import\s+([A-Za-z_][\w.]*(?:\.\*)?)(?:\s+as\s+[A-Za-z_][\w]*)?[ \t]*$/.exec(line);
  const sourceTarget = match?.[1] ?? '';
  const normalizedTarget = sourceTarget.endsWith('.*') ? sourceTarget.slice(0, -2) : sourceTarget;
  if (!sourceTarget || normalizedTarget !== nativeTarget) {
    fail('native-import-identity-mismatch', 'Native Android import does not map back to its indexed source line', {
      file,
      startLine,
      nativeTarget,
      sourceTarget: sourceTarget || null,
    });
  }
}

function sameGraphPath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function indexNativeKotlinOwnerRanges(rows) {
  const ownerRangesByFile = new Map();
  for (const row of rows) {
    const file = normalizeGraphPath(row.file_path);
    const startLine = Number(row.start_line);
    const endLine = Number(row.end_line);
    const kind = typeof row.kind === 'string' ? row.kind.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!file || !['class', 'enum'].includes(kind) || !name || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      fail('native-function-owner-invalid', 'Native Android owner range is incomplete', {
        file: file || null,
        kind: kind || null,
        name: name || null,
        startLine: Number.isFinite(startLine) ? startLine : null,
        endLine: Number.isFinite(endLine) ? endLine : null,
      });
    }
    const ranges = ownerRangesByFile.get(file) ?? [];
    ranges.push({ kind, name, startLine, endLine });
    ownerRangesByFile.set(file, ranges);
  }
  for (const ranges of ownerRangesByFile.values()) {
    ranges.sort((left, right) => (
      left.startLine - right.startLine
      || left.endLine - right.endLine
      || left.name.localeCompare(right.name)
    ));
  }
  return ownerRangesByFile;
}

function classifyNativeAndroidFunctionEndpoint(file, startLine, ownerRanges) {
  if (/\.kts$/i.test(file)) {
    return 'gradle-kts';
  }
  if (!/\.kt$/i.test(file)) {
    return 'non-kt-file';
  }
  const owner = findNativeKotlinOwnerRange(ownerRanges, startLine);
  return owner ? `${owner.kind}-owned` : null;
}

function findNativeKotlinOwnerRange(ownerRanges, line) {
  return [...ownerRanges]
    .filter(owner => owner.startLine <= line && owner.endLine >= line)
    .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))
    .at(0) ?? null;
}

function compareExcludedNativeFunctionEndpoints(left, right) {
  return String(left.reason).localeCompare(String(right.reason))
    || String(left.file).localeCompare(String(right.file))
    || Number(left.startLine) - Number(right.startLine)
    || String(left.nativeName).localeCompare(String(right.nativeName));
}

function assertNativeFunctionSourceIdentity(source, file, startLine, nativeName) {
  const maskedSource = maskAndroidKotlinNonCode(source);
  const lineOffset = offsetAtLine(maskedSource, startLine);
  const lineText = maskedSource.slice(lineOffset, readLineEndOffset(maskedSource, lineOffset));
  const match = /^[ \t]*(?:(?:suspend|public|private|protected|internal|open|abstract|final|operator|infix|tailrec|inline|external)\s+)*fun\s+(?:<[^>\n]+>\s*)?([A-Za-z_][\w]*)\s*/.exec(lineText);
  const sourceName = match?.[1] ?? '';
  if (!sourceName || sourceName !== nativeName) {
    fail('native-function-identity-mismatch', 'Native Android function does not map back to its indexed source line', {
      file,
      startLine,
      nativeName,
      sourceName: sourceName || null,
    });
  }
}

function offsetAtLine(source, lineNumber) {
  const targetLine = Math.max(1, Number(lineNumber) || 1);
  if (targetLine <= 1) return 0;
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      if (line === targetLine) {
        return index + 1;
      }
    }
  }
  return source.length;
}

function readLineEndOffset(source, offset) {
  const lineEnd = String(source ?? '').indexOf('\n', offset);
  return lineEnd >= 0 ? lineEnd : String(source ?? '').length;
}

function maskAndroidKotlinNonCode(source) {
  const text = String(source ?? '');
  const output = text.split('');
  let state = 'code';
  let blockDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const triple = text.slice(index, index + 3) === '"""';
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        state = 'line-comment';
      } else if (char === '/' && next === '*') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        blockDepth = 1;
        state = 'block-comment';
      } else if (triple) {
        output[index] = ' ';
        output[index + 1] = ' ';
        output[index + 2] = ' ';
        index += 2;
        state = 'triple-string';
      } else if (char === '"') {
        output[index] = ' ';
        state = 'string';
      } else if (char === "'") {
        output[index] = ' ';
        state = 'char';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
      } else {
        output[index] = ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        blockDepth += 1;
      } else if (char === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        blockDepth -= 1;
        if (blockDepth === 0) state = 'code';
      } else if (char !== '\n') {
        output[index] = ' ';
      }
      continue;
    }

    if (state === 'triple-string') {
      if (triple) {
        output[index] = ' ';
        output[index + 1] = ' ';
        output[index + 2] = ' ';
        index += 2;
        state = 'code';
      } else if (char !== '\n') {
        output[index] = ' ';
      }
      continue;
    }

    if (char === '\\') {
      output[index] = ' ';
      if (index + 1 < output.length && text[index + 1] !== '\n') {
        output[index + 1] = ' ';
        index += 1;
      }
      continue;
    }
    output[index] = char === '\n' ? '\n' : ' ';
    if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) {
      state = 'code';
    }
  }
  return output.join('');
}

function readNativeSnapshot(database, overlayIdentities) {
  database.exec('BEGIN');
  try {
    const nodes = Number(database.prepare('SELECT COUNT(*) AS count FROM nodes').get().count);
    const edges = Number(database.prepare('SELECT COUNT(*) AS count FROM edges').get().count);
    const nativeImports = database.prepare(`
      SELECT id, name, file_path, start_line
      FROM nodes
      WHERE kind = 'import' AND language = 'kotlin' AND file_path LIKE 'android/%'
      ORDER BY file_path, start_line, name, id
    `).all();
    const audit = auditAndroidImports(overlayIdentities, nativeImports);
    database.exec('COMMIT');
    return { nativeGraph: { nodes, edges }, audit };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original read or contract failure.
    }
    throw error;
  }
}

function auditAndroidImports(overlayIdentities, nativeImports) {
  const nativeByIdentity = new Map();
  for (const row of nativeImports) {
    const identity = {
      file: normalizeGraphPath(row.file_path),
      startLine: Number(row.start_line),
      target: row.name,
    };
    const key = identityKey(identity);
    const matches = nativeByIdentity.get(key) ?? [];
    matches.push(row.id);
    nativeByIdentity.set(key, matches);
  }

  const unmatched = [];
  const ambiguous = [];
  let matched = 0;
  for (const identity of overlayIdentities) {
    const nativeIds = nativeByIdentity.get(identityKey(identity)) ?? [];
    if (nativeIds.length === 1) {
      matched += 1;
    } else if (nativeIds.length === 0) {
      unmatched.push(identity);
    } else {
      ambiguous.push({ ...identity, nativeIds });
    }
  }

  const audit = {
    total: overlayIdentities.length,
    matched,
    unmatched,
    ambiguous,
  };
  if (matched !== overlayIdentities.length) {
    fail(
      'android-import-identity-mismatch',
      'Android Kotlin imports do not have one-to-one native CodeGraph identity matches',
      { nativeImportCandidates: nativeImports.length },
      audit,
    );
  }
  return audit;
}

function identityKey(identity) {
  return `${identity.file}\0${identity.startLine}\0${identity.target}`;
}

function auditNativeGraph(options = {}) {
  const paths = resolveProjectPaths(options.root ?? process.cwd(), options);
  const overlay = readOverlay(paths.root);
  const native = inspectNativeGraph(paths.databasePath, overlay.identities, options);
  return {
    ok: true,
    schemaVersion: 1,
    projectRoot: paths.root,
    database: {
      path: normalizeGraphPath(path.relative(paths.root, paths.databasePath)),
      ...native.database,
    },
    nativeGraph: native.nativeGraph,
    overlayGraph: overlay.counts,
    androidImports: native.audit,
  };
}

function formatFailure(error) {
  const known = error instanceof NativeGraphSidecarError;
  return {
    ok: false,
    error: {
      code: known ? error.code : 'native-sidecar-unexpected-error',
      message: error?.message ?? String(error),
      ...(known && error.details ? { details: error.details } : {}),
    },
    ...(known && error.audit ? { audit: error.audit } : {}),
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = auditNativeGraph({ root: args.root });
    process.stdout.write(`${JSON.stringify(result, null, args.json ? 2 : 0)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(formatFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_SCHEMA_VERSION,
  NativeGraphSidecarError,
  auditNativeGraph,
  readNativeAndroidKotlinFunctionEndpoints,
  readNativeAndroidKotlinImportEndpoints,
};

if (require.main === module) {
  main();
}
