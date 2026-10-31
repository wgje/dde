#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import nativeGraphSidecar from './lib/codegraph-native-graph-sidecar.cjs';
import overlayGenerationPublisher from './lib/codegraph-overlay-generation-publisher.cjs';
import overlayStability from './lib/codegraph-overlay-stability.cjs';
import sourcePolicy from './lib/codegraph-source-policy.cjs';

const {
  readNativeAndroidKotlinFunctionEndpoints,
  readNativeAndroidKotlinImportEndpoints,
} = nativeGraphSidecar;
const {
  acquireOverlayPublicationLease,
  createOverlayGenerationPublisher,
} = overlayGenerationPublisher;
const {
  assertParticipantPlan,
  assertSourceManifestEqual,
  assertStableOverlay,
} = overlayStability;
const { buildSourceManifest } = sourcePolicy;

const DEFAULT_OUTPUT = path.join('.codegraph', 'nanoflow-overlay.json');
const DEFAULT_ANDROID_IMPORT_SOURCE = 'local';
const ANDROID_IMPORT_SOURCE_DEFAULT_ENV = 'NANOFLOW_CODEGRAPH_ANDROID_IMPORT_SOURCE_DEFAULT';
const ANDROID_IMPORT_SOURCES = new Set(['local', 'native']);
const DEFAULT_ANDROID_FUNCTION_SOURCE = 'native';
const ANDROID_FUNCTION_SOURCE_DEFAULT_ENV = 'NANOFLOW_CODEGRAPH_ANDROID_FUNCTION_SOURCE_DEFAULT';
const ANDROID_FUNCTION_SOURCES = new Set(['local', 'native']);
const MAX_SYNTHETIC_EDGES_PER_CHANNEL = 40;
const AGENTS_CONFIG_SOURCE_FILES = new Map([
  ['SYNC_CONFIG', 'src/config/sync.config.ts'],
  ['TIMEOUT_CONFIG', 'src/config/timeout.config.ts'],
  ['FLOATING_TREE_CONFIG', 'src/config/layout.config.ts'],
  ['AUTH_CONFIG', 'src/config/auth.config.ts'],
  ['GUARD_CONFIG', 'src/config/auth.config.ts'],
  ['FOCUS_CONFIG', 'src/config/focus.config.ts'],
]);
const SUPABASE_REALTIME_STATUSES = new Set(['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);
const SUPABASE_SELECT_CONFIG_OBJECT = 'FIELD_SELECT_CONFIG';
const OFFICIAL_CODEGRAPH_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'razor',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'yaml',
  'twig',
  'xml',
  'properties',
  'unknown',
]);
ignoreBrokenStdoutPipe();

const TYPESCRIPT_STANDARD_LIBRARY_REFERENCES = readTypeScriptStandardLibraryReferences();

const TYPESCRIPT_BUILTIN_TYPE_REFERENCES = new Set([
  // Native CodeGraph does not turn TypeScript primitive/lib names into project symbols.
  'any',
  'bigint',
  'boolean',
  'const',
  'false',
  'never',
  'null',
  'number',
  'object',
  'string',
  'symbol',
  'true',
  'undefined',
  'unknown',
  'void',
  // TypeScript utility types.
  'Awaited',
  'Capitalize',
  'ConstructorParameters',
  'Exclude',
  'Extract',
  'InstanceType',
  'Lowercase',
  'NoInfer',
  'NonNullable',
  'Omit',
  'OmitThisParameter',
  'Parameters',
  'Partial',
  'Pick',
  'Readonly',
  'Record',
  'Required',
  'ReturnType',
  'ThisParameterType',
  'ThisType',
  'Uncapitalize',
  'Uppercase',
  // Common global generic/container types from the TypeScript standard libs.
  'Array',
  'ArrayBuffer',
  'ArrayBufferLike',
  'ArrayLike',
  'AsyncGenerator',
  'AsyncIterable',
  'AsyncIterableIterator',
  'AsyncIterator',
  'Date',
  'Error',
  'Generator',
  'Iterable',
  'IterableIterator',
  'Iterator',
  'Map',
  'Promise',
  'PromiseLike',
  'ReadonlyArray',
  'ReadonlyMap',
  'ReadonlySet',
  'RegExp',
  'Set',
  'WeakMap',
  'WeakSet',
  // High-frequency browser lib types in Angular codebases.
  'AbortController',
  'AbortSignal',
  'Blob',
  'CSSStyleDeclaration',
  'Document',
  'DOMRect',
  'Event',
  'EventTarget',
  'File',
  'FileList',
  'FormData',
  'Headers',
  'HTMLButtonElement',
  'HTMLCanvasElement',
  'HTMLDivElement',
  'HTMLElement',
  'HTMLFormElement',
  'HTMLImageElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'KeyboardEvent',
  'MouseEvent',
  'Request',
  'Response',
  'Storage',
  'SVGElement',
  'TouchEvent',
  'URL',
  'URLSearchParams',
  'Window',
  ...TYPESCRIPT_STANDARD_LIBRARY_REFERENCES.types,
]);

const TYPESCRIPT_GLOBAL_VALUE_REFERENCES = new Set([
  'AbortController',
  'Array',
  'BigInt',
  'Blob',
  'Boolean',
  'Date',
  'document',
  'Error',
  'File',
  'FormData',
  'globalThis',
  'Headers',
  'JSON',
  'localStorage',
  'Map',
  'Math',
  'navigator',
  'Number',
  'Object',
  'performance',
  'Promise',
  'RegExp',
  'Request',
  'Response',
  'sessionStorage',
  'Set',
  'String',
  'Symbol',
  'URL',
  'URLSearchParams',
  'WeakMap',
  'WeakSet',
  'window',
  ...TYPESCRIPT_STANDARD_LIBRARY_REFERENCES.values,
]);

const CALL_RECEIVER_SKIP_NAMES = new Set(['self', 'this', 'cls', 'super']);

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? process.cwd());
const outputPath = path.resolve(root, args.output ?? DEFAULT_OUTPUT);
const overlayOptions = {
  androidFunctionSource: args.androidFunctionSource,
  androidImportSource: args.androidImportSource,
};
const generationPlan = {
  version: 1,
  participant: 'generate-codegraph-nanoflow-overlay',
  buildCount: 2,
  root,
  outputPath,
};
assertParticipantPlan(generationPlan);
const publicationSession = args.stdout ? null : acquireOverlayPublicationLease({
  projectRoot: root,
  owner: `codegraph-overlay-generator:${process.pid}`,
  ttlMs: 60 * 60 * 1000,
});
try {
  const sourceManifest0 = captureSourceManifest(root);
  const overlay1 = buildOverlay(root, overlayOptions, sourceManifest0.files);
  const sourceManifest1 = captureSourceManifest(root);
  assertSourceManifestEqual(sourceManifest0.entries, sourceManifest1.entries);
  const overlay2 = buildOverlay(root, overlayOptions, sourceManifest1.files);
  const sourceManifest2 = captureSourceManifest(root);
  const sourceManifestDigest = assertSourceManifestEqual(
    sourceManifest1.entries,
    sourceManifest2.entries,
  );
  assertStableOverlay(overlay1, overlay2);

  if (args.stdout) {
    process.stdout.write(`${JSON.stringify(overlay2, null, 2)}\n`);
  } else {
    const publisher = createOverlayGenerationPublisher({
      readLeaseEvidence: publicationSession.readLeaseEvidence,
    });
    const publication = publisher.publish({
      configDigest: digestRecord(overlayOptions),
      overlay: overlay2,
      projectRoot: root,
      publishedAt: new Date().toISOString(),
      setupDigest: digestRecord(generationPlan),
      sourceManifestDigest,
      toolchainDigest: digestRecord({ node: process.versions.node, typescript: ts.version }),
    });
    process.stdout.write(`[codegraph-overlay] ${JSON.stringify({
      compatibilityDigest: publication.current.compatibilityDigest,
      generationId: publication.current.generationId,
      sequence: publication.current.sequence,
    })}\n`);
  }
} finally {
  if (publicationSession) publicationSession.release();
}

function digestRecord(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function parseArgs(rawArgs) {
  const parsed = {
    root: undefined,
    output: undefined,
    stdout: false,
    androidFunctionSource: undefined,
    androidImportSource: undefined,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--root') {
      parsed.root = requireValue(rawArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--out' || arg === '--output') {
      parsed.output = requireValue(rawArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--stdout') {
      parsed.stdout = true;
      continue;
    }
    if (arg === '--android-import-source') {
      parsed.androidImportSource = requireValue(rawArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--android-function-source') {
      parsed.androidFunctionSource = requireValue(rawArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.androidImportSource = resolveAndroidImportSource(parsed.androidImportSource);
  parsed.androidFunctionSource = resolveAndroidFunctionSource(parsed.androidFunctionSource);
  return parsed;
}

function resolveAndroidFunctionSource(explicitSource) {
  const source = explicitSource
    ?? process.env[ANDROID_FUNCTION_SOURCE_DEFAULT_ENV]
    ?? DEFAULT_ANDROID_FUNCTION_SOURCE;
  if (!ANDROID_FUNCTION_SOURCES.has(source)) {
    const sourceName = explicitSource === undefined
      ? ANDROID_FUNCTION_SOURCE_DEFAULT_ENV
      : '--android-function-source';
    throw new Error(`Invalid value for ${sourceName}: ${source}`);
  }
  return source;
}

function resolveAndroidImportSource(explicitSource) {
  const source = explicitSource
    ?? process.env[ANDROID_IMPORT_SOURCE_DEFAULT_ENV]
    ?? DEFAULT_ANDROID_IMPORT_SOURCE;
  if (!ANDROID_IMPORT_SOURCES.has(source)) {
    const sourceName = explicitSource === undefined
      ? ANDROID_IMPORT_SOURCE_DEFAULT_ENV
      : '--android-import-source';
    throw new Error(`Invalid value for ${sourceName}: ${source}`);
  }
  return source;
}

function ignoreBrokenStdoutPipe() {
  process.stdout.on('error', error => {
    if (error?.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

function readSnapshotFileUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function requireValue(rawArgs, index, flag) {
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/generate-codegraph-nanoflow-overlay.mjs [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --root <path>       Project root to scan. Defaults to cwd.\n`);
  process.stdout.write(`  --out <path>        Output path relative to root. Defaults to ${DEFAULT_OUTPUT}.\n`);
  process.stdout.write(`  --stdout            Print JSON instead of writing a file.\n`);
  process.stdout.write(`  --android-import-source <local|native>  Android import discovery source. Explicit CLI overrides ${ANDROID_IMPORT_SOURCE_DEFAULT_ENV}; built-in default is local.\n`);
  process.stdout.write(`  --android-function-source <local|native>  Android function discovery source. Explicit CLI overrides ${ANDROID_FUNCTION_SOURCE_DEFAULT_ENV}; built-in default is native.\n`);
}

function readTypeScriptStandardLibraryReferences() {
  const references = {
    types: new Set(),
    values: new Set(),
  };

  try {
    const libDir = path.dirname(ts.getDefaultLibFilePath({
      target: ts.ScriptTarget.Latest,
    }));
    const libFiles = fs.readdirSync(libDir)
      .filter(fileName => /^lib\..*\.d\.ts$/i.test(fileName));

    for (const fileName of libFiles) {
      const filePath = path.join(libDir, fileName);
      const sourceText = fs.readFileSync(filePath, 'utf8');
      const source = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      collectTypeScriptStandardLibraryDeclarations(source, references);
    }
  } catch {
    // Best effort: the static fallback sets above still cover high-frequency libs.
  }

  return references;
}

function collectTypeScriptStandardLibraryDeclarations(node, references, namespaceParts = []) {
  const qualify = name => (namespaceParts.length > 0 ? `${namespaceParts.join('.')}.${name}` : name);

  if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
    references.types.add(qualify(node.name.text));
  } else if ((ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
    const name = qualify(node.name.text);
    references.types.add(name);
    references.values.add(name);
  } else if (ts.isFunctionDeclaration(node) && node.name) {
    references.values.add(qualify(node.name.text));
  } else if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      for (const name of readBindingNames(declaration.name)) {
        references.values.add(qualify(name));
      }
    }
  }

  if (ts.isModuleDeclaration(node)) {
    const moduleName = readReferenceName(node.name);
    const nextNamespaceParts = moduleName && moduleName !== 'global'
      ? [...namespaceParts, moduleName]
      : namespaceParts;
    if (moduleName && moduleName !== 'global') {
      const qualifiedModuleName = nextNamespaceParts.join('.');
      references.types.add(qualifiedModuleName);
      references.values.add(qualifiedModuleName);
    }
    if (node.body) {
      collectTypeScriptStandardLibraryDeclarations(node.body, references, nextNamespaceParts);
    }
    return;
  }

  ts.forEachChild(node, child => collectTypeScriptStandardLibraryDeclarations(child, references, namespaceParts));
}

function buildOverlay(projectRoot, options = {}, allFiles = listFiles(projectRoot)) {
  const sourceFiles = allFiles.filter(file => isJavaScriptFamilySource(file));
  const specBySubject = buildSpecMap(projectRoot, sourceFiles);
  const typescript = collectTypeScript(projectRoot, sourceFiles);
  const angular = collectAngular(projectRoot, sourceFiles, specBySubject);
  const supabase = collectSupabase(projectRoot, allFiles);
  const agentRules = collectAgentRules(projectRoot);
  const context7 = collectContext7Docs(projectRoot, allFiles);
  const android = collectAndroid(
    projectRoot,
    allFiles,
    options.androidImportSource ?? 'local',
    options.androidFunctionSource ?? DEFAULT_ANDROID_FUNCTION_SOURCE,
  );
  const overlay = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: {
      root: projectRoot,
      name: readPackageName(projectRoot),
      codegraphOverlay: 'NanoFlow project semantics that complement the base AST graph',
    },
    coverageTargets: [
      'Angular standalone component metadata',
      'Angular standalone directive and pipe metadata',
      'Angular injectable provider metadata',
      'Angular standalone component imports/providers',
      'Angular hostDirectives metadata',
      'Angular templateUrl/styleUrl/styleUrls references',
      'Angular inject() dependency edges',
      'Angular constructor dependency edges',
      'Angular application bootstrap provider edges',
      'Angular input()/output()/model() and decorator IO edges',
      'Angular viewChild()/viewChildren()/contentChild()/contentChildren()/signal()/computed()/effect() signal edges',
      'Angular host binding/listener edges',
      'Angular host metadata object attribute/binding/listener edges',
      'Angular template binding references',
      'Angular route component/loadComponent/loadChildren edges',
      'Dynamic import() lazy-load edges',
      'Same-directory and same-basename test mapping',
      'Supabase Edge Function entries',
      'Supabase Edge Function environment variable references',
      'Supabase Edge Function source/helper import references',
      'Supabase Edge Function route and HTTP method references',
      'Supabase Edge Function test mappings',
      'Supabase migration risk tags',
      'Supabase migration table and policy anchors',
      'Supabase migration privilege grant/revoke anchors',
      'Supabase migration test references',
      'Android Manifest component declarations',
      'Android App Widget provider XML resources',
      'Android Kotlin host classes',
      'Android XML resource references',
      'AGENTS.md hard-rule anchors',
      'AGENTS.md sync-rule anchors',
      'Context7 canonical docs catalog, retrieval routes, and source-map ownership links',
      'Native JavaScript-family export/default/CommonJS object function members',
      'Native TypeScript type literal members and call/construct/index signatures',
      'Native TypeScript local class/interface/type/enum declarations',
      'Native TypeScript type parameter constraint/default edges',
      'Native TypeScript built-in utility/global type filtering with generic project references preserved',
      'Native TypeScript standard-library global value filtering for initializer references',
    ],
    typescript,
    angular,
    supabase,
    android,
    agentRules,
    context7,
  };

  return {
    ...overlay,
    graph: buildNativeGraph(overlay),
  };
}

function collectAndroid(
  projectRoot,
  allFiles,
  androidImportSource = 'local',
  androidFunctionSource = DEFAULT_ANDROID_FUNCTION_SOURCE,
) {
  const androidFiles = allFiles
    .map(file => relative(projectRoot, file))
    .filter(file => /^android\//.test(file))
    .filter(file => /\.(?:kt|xml)$/i.test(file));
  const androidKotlinFiles = androidFiles.filter(file => /\.kt$/i.test(file));
  const androidFileSet = new Set(androidFiles);
  const androidResourceIndex = buildAndroidResourceIndex(projectRoot, androidFiles);
  const files = androidFiles.map(file => ({
    file,
    language: inferLanguage(file),
    relation: androidFileRelation(file),
  }));
  const nativeImportsByFile = readAndroidKotlinImports(projectRoot, androidImportSource, androidKotlinFiles);
  const nativeFunctionsByFile = readAndroidKotlinFunctions(
    projectRoot,
    androidFunctionSource,
    androidKotlinFiles,
  );
  const kotlinFileSymbols = androidKotlinFiles
    .map(file => readAndroidKotlinFileSymbols(
      projectRoot,
      file,
      nativeImportsByFile,
      nativeFunctionsByFile,
    ));
  const kotlinClasses = kotlinFileSymbols.flatMap(symbols => symbols.classes);
  const kotlinEnums = kotlinFileSymbols.flatMap(symbols => symbols.enums);
  const kotlinImports = kotlinFileSymbols.flatMap(symbols => symbols.imports);
  const kotlinConstructors = kotlinFileSymbols.flatMap(symbols => symbols.constructors);
  const kotlinProperties = kotlinFileSymbols.flatMap(symbols => symbols.properties);
  const kotlinMethodSymbols = kotlinFileSymbols.flatMap(symbols => symbols.methods);
  const kotlinFunctionSymbols = kotlinFileSymbols.flatMap(symbols => symbols.functions);
  const kotlinMethods = kotlinMethodSymbols.map(toAndroidKotlinOverlayMethod);
  const kotlinFunctions = kotlinFunctionSymbols.map(toAndroidKotlinOverlayMethod);
  const kotlinCalls = readAndroidKotlinMethodCalls([...kotlinMethodSymbols, ...kotlinFunctionSymbols]);
  const kotlinClassBySimpleName = new Map();
  const kotlinClassByQualifiedName = new Map();
  for (const kotlinClass of kotlinClasses) {
    if (!kotlinClassBySimpleName.has(kotlinClass.name)) {
      kotlinClassBySimpleName.set(kotlinClass.name, kotlinClass);
    }
    kotlinClassByQualifiedName.set(kotlinClass.qualifiedName, kotlinClass);
  }

  const manifestComponents = [];
  const manifestPermissions = [];
  const manifestQueries = [];
  const widgetProviders = [];
  for (const manifestFile of androidFiles.filter(file => /AndroidManifest\.xml$/i.test(file))) {
    const source = readSnapshotFileUtf8(path.join(projectRoot, manifestFile));
    if (source === null) continue;
    manifestPermissions.push(...readAndroidManifestUsesPermissions(source, manifestFile));
    manifestQueries.push(...readAndroidManifestQueries(source, manifestFile));
    for (const component of readAndroidManifestComponents(source, manifestFile, kotlinClassBySimpleName)) {
      const kotlinClass = kotlinClassByQualifiedName.get(component.className)
        ?? kotlinClassBySimpleName.get(component.simpleName)
        ?? null;
      const resolvedComponent = {
        ...component,
        kotlinFile: kotlinClass?.file ?? null,
      };
      manifestComponents.push(resolvedComponent);
      for (const metadata of component.metadata ?? []) {
        if (metadata.name !== 'android.appwidget.provider') continue;
        const resource = parseAndroidResourceReference(metadata.resource ?? metadata.value);
        if (!resource || resource.type !== 'xml') continue;
        widgetProviders.push({
          componentType: component.componentType,
          className: resolvedComponent.className,
          simpleName: resolvedComponent.simpleName,
          kotlinFile: resolvedComponent.kotlinFile,
          manifestFile,
          line: metadata.line,
          resourceType: resource.type,
          resourceName: resource.name,
          resourcePath: resolveAndroidResourcePath(resource, androidFileSet, androidResourceIndex),
        });
      }
    }
  }

  const xmlResources = [];
  const resourceReferences = [];
  for (const file of androidFiles.filter(file => /^android\/app\/src\/main\/res\/[^/]+\/[^/]+\.xml$/i.test(file))) {
    const source = readSnapshotFileUtf8(path.join(projectRoot, file));
    if (source === null) continue;
    const resource = androidResourceFromPath(file);
    if (!resource) continue;
    const rootTag = readXmlRootTag(source);
    xmlResources.push({
      file,
      resourceType: resource.type,
      resourceName: resource.name,
      rootTag,
      line: 1,
    });
    for (const reference of readAndroidXmlResourceReferences(source)) {
      const targetPath = resolveAndroidResourcePath(reference, androidFileSet, androidResourceIndex);
      if (!targetPath || targetPath === file) continue;
      resourceReferences.push({
        sourceFile: file,
        targetFile: targetPath,
        resourceType: reference.type,
        resourceName: reference.name,
        line: reference.line,
      });
    }
  }

  const kotlinResourceReferences = [];
  for (const file of androidFiles.filter(file => /\.kt$/i.test(file))) {
    const source = readSnapshotFileUtf8(path.join(projectRoot, file));
    if (source === null) continue;
    const searchableSource = maskAndroidKotlinNonCode(source);
    const referencePattern = /(?<![\w.])R\.(string|layout|drawable|id)\.([A-Za-z_][\w]*)\b/g;
    let referenceMatch;
    while ((referenceMatch = referencePattern.exec(searchableSource)) !== null) {
      const reference = {
        type: referenceMatch[1],
        name: referenceMatch[2],
        line: lineNumberAt(source, referenceMatch.index),
      };
      const targetFile = resolveAndroidResourcePath(reference, androidFileSet, androidResourceIndex);
      if (!targetFile || !androidFileSet.has(targetFile)) continue;
      kotlinResourceReferences.push({
        sourceFile: file,
        targetFile,
        resourceType: reference.type,
        resourceName: reference.name,
        line: reference.line,
      });
    }
  }

  return {
    files: uniqueObjects(files),
    kotlinClasses: uniqueObjects(kotlinClasses),
    kotlinEnums: uniqueObjects(kotlinEnums),
    kotlinImports: uniqueObjects(kotlinImports),
    kotlinConstructors: uniqueObjects(kotlinConstructors),
    kotlinProperties: uniqueObjects(kotlinProperties),
    kotlinMethods: uniqueObjects(kotlinMethods),
    kotlinFunctions: uniqueObjects(kotlinFunctions),
    kotlinCalls: uniqueObjects(kotlinCalls),
    manifestComponents: uniqueObjects(manifestComponents),
    manifestPermissions: uniqueObjects(manifestPermissions),
    manifestQueries: uniqueObjects(manifestQueries),
    widgetProviders: uniqueObjects(widgetProviders),
    xmlResources: uniqueObjects(xmlResources),
    resourceReferences: uniqueObjects(resourceReferences),
    kotlinResourceReferences: uniqueObjects(kotlinResourceReferences),
  };
}

function buildAndroidResourceIndex(projectRoot, androidFiles) {
  const resourceIndex = new Map();
  for (const file of androidFiles) {
    const pathResource = androidResourceFromPath(file);
    if (pathResource && pathResource.type !== 'values') {
      registerAndroidResource(resourceIndex, pathResource.type, pathResource.name, file);
    }
    if (!/\.xml$/i.test(file)) {
      continue;
    }
    const source = readSnapshotFileUtf8(path.join(projectRoot, file));
    if (source === null) continue;
    for (const idResource of readAndroidXmlIdResources(source)) {
      registerAndroidResource(resourceIndex, idResource.type, idResource.name, file);
    }
    if (/^android\/app\/src\/main\/res\/values[^/]*\/[^/]+\.xml$/i.test(file)) {
      for (const valueResource of readAndroidValuesResources(source)) {
        registerAndroidResource(resourceIndex, valueResource.type, valueResource.name, file);
      }
    }
  }
  return resourceIndex;
}

function registerAndroidResource(resourceIndex, type, name, file) {
  if (!type || !name || !file) return;
  const key = androidResourceIndexKey(type, name);
  if (!resourceIndex.has(key)) {
    resourceIndex.set(key, file);
  }
}

function androidResourceIndexKey(type, name) {
  return `${String(type ?? '').toLowerCase()}:${String(name ?? '').toLowerCase()}`;
}

function readAndroidValuesResources(source) {
  const resources = [];
  const resourcePattern = /<\s*(string|plurals|string-array|array|integer|bool|color|dimen|style|declare-styleable|attr)\b([^>]*)>/gi;
  let match;
  while ((match = resourcePattern.exec(String(source ?? ''))) !== null) {
    const attributes = readXmlAttributes(match[2]);
    if (!attributes.name) continue;
    resources.push({
      type: match[1],
      name: attributes.name,
    });
  }
  const itemPattern = /<\s*item\b([^>]*)>/gi;
  while ((match = itemPattern.exec(String(source ?? ''))) !== null) {
    const attributes = readXmlAttributes(match[1]);
    if (!attributes.type || !attributes.name) continue;
    resources.push({
      type: attributes.type,
      name: attributes.name,
    });
  }
  return uniqueObjects(resources);
}

function readAndroidXmlIdResources(source) {
  return uniqueObjects([...String(source ?? '').matchAll(/@\+id\/([A-Za-z_][\w.]*)/g)]
    .map(match => ({ type: 'id', name: match[1] })));
}

function androidFileRelation(filePath) {
  if (/AndroidManifest\.xml$/i.test(filePath)) return 'android-manifest';
  if (/\.kt$/i.test(filePath)) return 'android-kotlin-source';
  if (/^android\/app\/src\/main\/res\//i.test(filePath)) return 'android-resource-file';
  return 'android-file';
}

function readAndroidKotlinClasses(projectRoot, relativeFile) {
  return readAndroidKotlinFileSymbols(projectRoot, relativeFile).classes;
}

function readAndroidKotlinImports(projectRoot, androidImportSource, androidKotlinFiles) {
  if (androidImportSource === 'native') {
    const { endpoints } = readNativeAndroidKotlinImportEndpoints({ root: projectRoot });
    const androidKotlinFileSet = new Set(androidKotlinFiles);
    const endpointsByFile = new Map();
    for (const endpoint of endpoints) {
      if (!androidKotlinFileSet.has(endpoint.file)) {
        throw new Error(
          `Native Android import completeness mismatch: extra endpoint file ${endpoint.file}:${endpoint.startLine}`,
        );
      }
      const values = endpointsByFile.get(endpoint.file) ?? [];
      values.push(endpoint);
      endpointsByFile.set(endpoint.file, values);
    }
    return endpointsByFile;
  }
  return null;
}

function readAndroidKotlinFunctions(projectRoot, androidFunctionSource, androidKotlinFiles) {
  if (androidFunctionSource === 'native') {
    const { endpoints } = readNativeAndroidKotlinFunctionEndpoints({ root: projectRoot });
    const androidKotlinFileSet = new Set(androidKotlinFiles);
    const endpointsByFile = new Map();
    for (const endpoint of endpoints) {
      if (!androidKotlinFileSet.has(endpoint.file)) {
        throw new Error(
          `Native Android function completeness mismatch: extra endpoint file ${endpoint.file}:${endpoint.startLine}:${endpoint.nativeName}`,
        );
      }
      const values = endpointsByFile.get(endpoint.file) ?? [];
      values.push(endpoint);
      endpointsByFile.set(endpoint.file, values);
    }
    return endpointsByFile;
  }
  return null;
}

function readAndroidKotlinFileSymbols(
  projectRoot,
  relativeFile,
  nativeImportsByFile = null,
  nativeFunctionsByFile = null,
) {
  const filePath = path.join(projectRoot, relativeFile);
  const source = readSnapshotFileUtf8(filePath);
  if (source === null) return {
    classes: [],
    enums: [],
    imports: [],
    constructors: [],
    properties: [],
    methods: [],
    functions: [],
  };
  const packageName = /^\s*package\s+([A-Za-z_][\w.]*)(?:\s|$)/m.exec(source)?.[1] ?? null;
  const declarations = [];
  const classPattern = /\b((?:(?:data|sealed|open|abstract|internal|public|private|protected)\s+)*)(class|object|interface|enum\s+class)\s+([A-Za-z_][\w]*)/g;
  let match;
  while ((match = classPattern.exec(source)) !== null) {
    const kind = match[2].replace(/\s+/g, ' ');
    if (kind === 'object' && /\bcompanion\s+$/.test(source.slice(Math.max(0, match.index - 32), match.index))) {
      continue;
    }
    const modifiers = splitAndroidKotlinModifiers(match[1]);
    const heritage = readAndroidKotlinHeritage(source, classPattern.lastIndex);
    const name = match[3];
    const line = lineNumberAt(source, match.index);
    const annotations = readAndroidKotlinLeadingAnnotations(source, match.index);
    declarations.push({
      name,
      qualifiedName: packageName ? `${packageName}.${name}` : name,
      packageName,
      classKind: kind,
      declarationKind: kind,
      modifiers,
      annotations,
      heritage,
      heritageTypes: heritage.map(type => type.name).filter(Boolean),
      file: relativeFile,
      line,
      startLine: annotations[0]?.line ?? line,
      endLine: readAndroidKotlinDeclarationEndLine(source, match.index, classPattern.lastIndex, line),
      signature: compactAndroidKotlinSignature([...modifiers, kind, name].join(' ')),
      isAbstract: modifiers.includes('abstract') || modifiers.includes('sealed'),
    });
  }
  const enumDeclarations = declarations.filter(declaration => declaration.classKind === 'enum class');
  const nonEnumDeclarations = declarations.filter(declaration => declaration.classKind !== 'enum class');
  const companionObjects = readAndroidKotlinCompanionObjectsFromSource(source, relativeFile, packageName, nonEnumDeclarations);
  const classes = [...nonEnumDeclarations, ...companionObjects];
  const callableClasses = readAndroidKotlinCallableOwnerClasses(source, classes);
  return {
    classes,
    enums: enumDeclarations.map(enumDeclaration => ({
      ...enumDeclaration,
      members: readAndroidKotlinEnumMembersFromSource(source, relativeFile, enumDeclaration),
    })),
    imports: nativeImportsByFile === null
      ? readAndroidKotlinImportsFromSource(source, relativeFile)
      : readAndroidKotlinImportsFromNativeEndpoints(
          source,
          relativeFile,
          nativeImportsByFile.get(relativeFile) ?? [],
        ),
    constructors: readAndroidKotlinConstructorsFromSource(source, relativeFile, packageName, classes),
    properties: readAndroidKotlinPropertiesFromSource(source, relativeFile, packageName, classes),
    methods: readAndroidKotlinMethodsFromSource(source, relativeFile, packageName, callableClasses),
    functions: nativeFunctionsByFile === null
      ? readAndroidKotlinFunctionsFromSource(source, relativeFile, packageName, callableClasses)
      : readAndroidKotlinFunctionsFromNativeEndpoints(
          source,
          relativeFile,
          packageName,
          callableClasses,
          nativeFunctionsByFile.get(relativeFile) ?? [],
        ),
  };
}

function compactAndroidKotlinSignature(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function readAndroidKotlinImportsFromSource(source, relativeFile) {
  const imports = [];
  const sourceLines = String(source ?? '').split(/\r?\n/);
  const maskedLines = maskAndroidKotlinNonCode(source).split(/\r?\n/);
  for (let index = 0; index < maskedLines.length; index += 1) {
    if (!readAndroidKotlinImportFromLine(maskedLines[index] ?? '', relativeFile, index + 1)) continue;
    const item = readAndroidKotlinImportFromLine(sourceLines[index] ?? '', relativeFile, index + 1);
    if (item) imports.push(item);
  }
  return imports;
}

function readAndroidKotlinImportsFromNativeEndpoints(source, relativeFile, endpoints) {
  const contentHash = createHash('sha256').update(Buffer.from(source)).digest('hex');
  const size = Buffer.byteLength(source);
  const lines = source.split(/\r?\n/);
  const nativeImports = endpoints.map(endpoint => {
    if (endpoint.file !== relativeFile || endpoint.contentHash !== contentHash || endpoint.size !== size) {
      throw new Error(`Native Android import endpoint is stale for ${relativeFile}:${endpoint.startLine}`);
    }
    const item = readAndroidKotlinImportFromLine(
      lines[endpoint.startLine - 1] ?? '',
      relativeFile,
      endpoint.startLine,
    );
    const nativeComparableTarget = item?.target.endsWith('.*')
      ? item.target.slice(0, -2)
      : item?.target;
    if (!item || nativeComparableTarget !== endpoint.nativeTarget) {
      throw new Error(`Native Android import endpoint identity mismatch for ${relativeFile}:${endpoint.startLine}`);
    }
    return item;
  });
  assertNativeAndroidKotlinImportCompleteness(
    readAndroidKotlinImportsFromSource(source, relativeFile),
    nativeImports,
    relativeFile,
  );
  return nativeImports;
}

function assertNativeAndroidKotlinImportCompleteness(sourceImports, nativeImports, relativeFile) {
  const sourceIdentities = countAndroidKotlinImportIdentities(sourceImports);
  const nativeIdentities = countAndroidKotlinImportIdentities(nativeImports);
  const missing = [...sourceIdentities]
    .filter(([identity, count]) => (nativeIdentities.get(identity) ?? 0) !== count)
    .map(([identity]) => identity);
  const extra = [...nativeIdentities]
    .filter(([identity, count]) => (sourceIdentities.get(identity) ?? 0) !== count)
    .map(([identity]) => identity);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Native Android import completeness mismatch for ${relativeFile}: missing=${JSON.stringify(missing)}; extra=${JSON.stringify(extra)}`,
    );
  }
}

function countAndroidKotlinImportIdentities(imports) {
  const counts = new Map();
  for (const item of imports) {
    const identity = `${item.line}\0${item.target}\0${item.alias ?? ''}`;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function readAndroidKotlinImportFromLine(sourceLine, relativeFile, line) {
  const match = /^([ \t]*)import\s+([A-Za-z_][\w.]*(?:\.\*)?)(?:\s+as\s+([A-Za-z_][\w]*))?[ \t]*$/.exec(sourceLine);
  if (!match) return null;
  return toAndroidKotlinImport(match[2], match[3] ?? null, relativeFile, line, match[1].length, match[0]);
}

function toAndroidKotlinImport(target, alias, relativeFile, line, column, sourceText) {
  const wildcard = target.endsWith('.*');
  const importedName = wildcard ? '*' : target.split('.').at(-1);
  const name = alias ?? (wildcard ? target : importedName);
  const packageName = wildcard
    ? target.slice(0, -2)
    : target.split('.').slice(0, -1).join('.');
  return {
    name,
    qualifiedName: target,
    importedName,
    alias,
    target,
    packageName,
    wildcard,
    file: relativeFile,
    line,
    startLine: line,
    endLine: line,
    startColumn: column,
    endColumn: column + sourceText.trim().length,
    signature: wildcard
      ? `import ${target}`
      : `import ${name} from ${target}`,
  };
}

function readAndroidKotlinHeritage(source, afterNameOffset) {
  const value = String(source ?? '');
  let cursor = skipWhitespaceOffset(value, afterNameOffset);
  if (value[cursor] === '(') {
    const closeParenOffset = findMatchingDelimiterOffset(value, cursor, '(', ')');
    if (closeParenOffset >= 0) cursor = closeParenOffset + 1;
    cursor = skipWhitespaceOffset(value, cursor);
  }
  if (value[cursor] !== ':') return [];
  cursor += 1;
  const endOffset = findAndroidKotlinDeclarationHeaderEndOffset(value, cursor);
  return splitKotlinTopLevelComma(value.slice(cursor, endOffset))
    .map(part => readAndroidKotlinHeritageType(part.text))
    .filter(Boolean);
}

function readAndroidKotlinHeritageTypes(source, afterNameOffset) {
  return readAndroidKotlinHeritage(source, afterNameOffset)
    .map(type => type.name)
    .filter(Boolean);
}

function readAndroidKotlinDeclarationEndLine(
  source,
  declarationOffset,
  afterNameOffset,
  fallbackLine,
  allowMultilineHeritage = false,
) {
  const value = String(source ?? '');
  let cursor = skipWhitespaceOffset(value, afterNameOffset);
  let headerEndOffset = Math.max(declarationOffset, afterNameOffset);

  if (value[cursor] === '(') {
    const closeParenOffset = findMatchingDelimiterOffset(value, cursor, '(', ')');
    if (closeParenOffset >= 0) {
      headerEndOffset = closeParenOffset;
      cursor = skipWhitespaceOffset(value, closeParenOffset + 1);
    }
  }

  if (value[cursor] === ':') {
    if (allowMultilineHeritage) {
      const bodyOpenOffset = findAndroidKotlinDeclarationBodyOpenOffset(value, cursor + 1);
      if (bodyOpenOffset >= 0) {
        return lineNumberAt(value, findCurlyBlockEndOffset(value, bodyOpenOffset));
      }
    }
    const heritageEndOffset = findAndroidKotlinDeclarationHeaderEndOffset(value, cursor + 1);
    headerEndOffset = Math.max(headerEndOffset, heritageEndOffset);
    cursor = skipWhitespaceOffset(value, heritageEndOffset);
  }

  if (value[cursor] === '{') {
    return lineNumberAt(value, findCurlyBlockEndOffset(value, cursor));
  }

  return lineNumberAt(value, headerEndOffset) || fallbackLine;
}

function readAndroidKotlinCallableOwnerClasses(source, classes) {
  const searchableSource = maskAndroidKotlinNonCode(source);
  return classes.map(owner => {
    const declarationOffset = findAndroidKotlinClassDeclarationOffset(searchableSource, owner);
    if (declarationOffset < 0) return owner;
    const nameOffset = searchableSource.indexOf(owner.name, declarationOffset);
    if (nameOffset < 0) return owner;
    let callableHeaderOffset = skipWhitespaceOffset(
      searchableSource,
      nameOffset + owner.name.length,
    );
    const hasTypeParameters = searchableSource[callableHeaderOffset] === '<';
    if (hasTypeParameters) {
      callableHeaderOffset = readAndroidKotlinClassTypeParametersEnd(
        searchableSource,
        callableHeaderOffset,
      );
      if (callableHeaderOffset === null) return owner;
    }
    const constructorOffset = skipWhitespaceOffset(searchableSource, callableHeaderOffset);
    const constructorMatch = /^(?:(?:public|private|protected|internal)\s+)?constructor\b/.exec(
      searchableSource.slice(constructorOffset),
    );
    if (constructorMatch) {
      callableHeaderOffset = skipWhitespaceOffset(
        searchableSource,
        constructorOffset + constructorMatch[0].length,
      );
      if (searchableSource[callableHeaderOffset] !== '(') return owner;
    } else if (
      !hasTypeParameters
      && searchableSource[constructorOffset] !== '('
      && searchableSource[constructorOffset] !== '{'
    ) return owner;
    const endLine = readAndroidKotlinDeclarationEndLine(
      searchableSource,
      declarationOffset,
      callableHeaderOffset,
      owner.endLine,
      true,
    );
    return { ...owner, endLine };
  });
}

function findAndroidKotlinDeclarationBodyOpenOffset(source, startOffset) {
  const value = String(source ?? '');
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  for (let index = Math.max(0, startOffset); index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (
      char === '{'
      && parenDepth === 0
      && angleDepth === 0
      && bracketDepth === 0
    ) {
      return index;
    }
  }
  return -1;
}

function readAndroidKotlinClassTypeParametersEnd(source, openOffset) {
  const value = String(source ?? '');
  if (value[openOffset] !== '<') return null;
  let angleDepth = 0;
  let parenDepth = 0;
  let squareDepth = 0;
  for (let index = openOffset; index < value.length; index += 1) {
    const char = value[index];
    if (char === '-' && value[index + 1] === '>') {
      index += 1;
      continue;
    }
    if (char === '\n') {
      let nextOffset = index + 1;
      while (value[nextOffset] === ' ' || value[nextOffset] === '\t') nextOffset += 1;
      if (/^(?:(?:public|private|protected|internal)\s+)*(?:fun|class|object|interface|enum\s+class)\b/.test(
        value.slice(nextOffset),
      )) return null;
      continue;
    }
    if (char === '{' || char === '}' || char === ';' || char === '=') return null;
    if (char === '<') angleDepth += 1;
    else if (char === '>') {
      angleDepth -= 1;
      if (angleDepth < 0) return null;
      if (angleDepth === 0) {
        return parenDepth === 0 && squareDepth === 0 ? index + 1 : null;
      }
    } else if (char === '(') parenDepth += 1;
    else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) return null;
    } else if (char === '[') squareDepth += 1;
    else if (char === ']') {
      squareDepth -= 1;
      if (squareDepth < 0) return null;
    }
  }
  return null;
}

function skipWhitespaceOffset(source, offset) {
  const value = String(source ?? '');
  let cursor = Math.max(0, offset);
  while (/\s/.test(value[cursor] ?? '')) cursor += 1;
  return cursor;
}

function findAndroidKotlinDeclarationHeaderEndOffset(source, startOffset) {
  const value = String(source ?? '');
  let parenDepth = 0;
  let angleDepth = 0;
  for (let index = startOffset; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if ((char === '{' || char === '\n') && parenDepth === 0 && angleDepth === 0) {
      return index;
    }
  }
  return value.length;
}

function readAndroidKotlinHeritageTypeName(rawText) {
  return readAndroidKotlinHeritageType(rawText)?.name ?? null;
}

function readAndroidKotlinHeritageType(rawText) {
  const cleaned = String(rawText ?? '')
    .trim()
    .replace(/\s+where\s+[\s\S]*$/i, '')
    .trim();
  const match = /^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/.exec(cleaned);
  if (!match) return null;
  const afterName = cleaned.slice(match[0].length).trim();
  return {
    name: match[1],
    hasConstructorCall: afterName.startsWith('('),
  };
}

function readAndroidKotlinCompanionObjectsFromSource(source, relativeFile, packageName, classes) {
  const companions = [];
  const companionPattern = /\bcompanion\s+object(?:\s+([A-Za-z_][\w]*))?\s*\{/g;
  let match;
  while ((match = companionPattern.exec(source)) !== null) {
    const line = lineNumberAt(source, match.index);
    const owner = findAndroidKotlinOwnerClass(classes, line);
    if (!owner) continue;
    const name = match[1] ?? 'Companion';
    const ownerQualifiedName = owner.qualifiedName ?? (packageName ? `${packageName}.${owner.name}` : owner.name);
    const braceOffset = source.indexOf('{', match.index);
    const endOffset = findCurlyBlockEndOffset(source, braceOffset);
    companions.push({
      name,
      qualifiedName: `${ownerQualifiedName}::${name}`,
      packageName,
      classKind: 'object',
      declarationKind: 'companion object',
      modifiers: [],
      file: relativeFile,
      line,
      startLine: line,
      endLine: lineNumberAt(source, Math.max(match.index, endOffset)),
      signature: compactAndroidKotlinSignature(`companion object ${match[1] ?? ''}`),
      isCompanionObject: true,
      isAbstract: false,
      ownerName: owner.name,
      ownerQualifiedName,
      ownerKind: owner.classKind,
    });
  }
  return uniqueObjects(companions);
}

function readAndroidKotlinEnumMembersFromSource(source, relativeFile, enumDeclaration) {
  const declarationOffset = findAndroidKotlinClassDeclarationOffset(source, enumDeclaration);
  if (declarationOffset < 0) return [];
  const bodyOpenOffset = source.indexOf('{', declarationOffset);
  if (bodyOpenOffset < 0) return [];
  const bodyEndOffset = findCurlyBlockEndOffset(source, bodyOpenOffset);
  if (bodyEndOffset <= bodyOpenOffset) return [];
  const bodyStartOffset = bodyOpenOffset + 1;
  const bodyText = source.slice(bodyStartOffset, bodyEndOffset - 1);
  const enumQualifiedName = enumDeclaration.qualifiedName ?? enumDeclaration.name;
  const members = [];

  for (const segment of splitKotlinEnumEntrySegments(bodyText)) {
    const member = readAndroidKotlinEnumMemberSegment(segment.text);
    if (!member) continue;
    const nameOffset = source.indexOf(member.name, bodyStartOffset + segment.startOffset);
    const line = lineNumberAt(source, nameOffset >= 0 ? nameOffset : bodyStartOffset + segment.startOffset);
    members.push({
      name: member.name,
      qualifiedName: `${enumQualifiedName}::${member.name}`,
      ownerName: enumDeclaration.name,
      ownerQualifiedName: enumQualifiedName,
      packageName: enumDeclaration.packageName,
      file: relativeFile,
      line,
      startLine: line,
      endLine: line,
      signature: member.signature,
    });
  }

  return uniqueObjects(members);
}

function splitKotlinEnumEntrySegments(bodyText) {
  const value = String(bodyText ?? '');
  const segments = [];
  let startOffset = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === ';' && parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      segments.push({ text: value.slice(startOffset, index), startOffset, endOffset: index });
      return segments.filter(segment => segment.text.trim().length > 0);
    } else if (char === ',' && parenDepth === 0 && angleDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      segments.push({ text: value.slice(startOffset, index), startOffset, endOffset: index });
      startOffset = index + 1;
    }
  }
  segments.push({ text: value.slice(startOffset), startOffset, endOffset: value.length });
  return segments.filter(segment => segment.text.trim().length > 0);
}

function readAndroidKotlinEnumMemberSegment(rawText) {
  const normalized = String(rawText ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*@[\w.]+(?:\([^)]*\))?\s*$/gm, '')
    .trim();
  const match = /^([A-Za-z_][\w]*)\b/.exec(normalized);
  if (!match) return null;
  const signature = (normalized.includes('{') ? normalized.slice(0, normalized.indexOf('{')) : normalized)
    .trim()
    .replace(/,$/, '')
    .replace(/\s+/g, ' ');
  return {
    name: match[1],
    signature: signature || match[1],
  };
}

function readAndroidKotlinConstructorsFromSource(source, relativeFile, packageName, classes) {
  const constructors = [];
  const primaryRanges = readAndroidKotlinPrimaryConstructorRanges(source, classes);
  for (const range of primaryRanges) {
    if (!range.owner || range.owner.classKind === 'object' || range.owner.classKind === 'interface') continue;
    const ownerQualifiedName = range.owner.qualifiedName
      ?? (packageName ? `${packageName}.${range.owner.name}` : range.owner.name);
    constructors.push({
      name: 'constructor',
      qualifiedName: `${ownerQualifiedName}::constructor`,
      ownerName: range.owner.name,
      ownerQualifiedName,
      ownerKind: range.owner.classKind,
      packageName,
      file: relativeFile,
      line: range.startLine,
      startLine: range.startLine,
      endLine: range.endLine,
      signature: source.slice(range.signatureStartOffset, range.endOffset).trim().replace(/\s+/g, ' '),
      visibility: null,
      isAsync: false,
      isStatic: false,
    });
  }

  const secondaryPattern = /\b((?:(?:public|private|protected|internal)\s+)*)constructor\s*\(/g;
  let match;
  while ((match = secondaryPattern.exec(source)) !== null) {
    const line = lineNumberAt(source, match.index);
    const owner = findAndroidKotlinOwnerClass(classes, line);
    if (!owner || owner.classKind === 'object' || owner.classKind === 'interface') continue;
    const closeParenOffset = findMatchingDelimiterOffset(source, source.indexOf('(', match.index), '(', ')');
    if (closeParenOffset < 0) continue;
    const ownerQualifiedName = owner.qualifiedName ?? (packageName ? `${packageName}.${owner.name}` : owner.name);
    constructors.push({
      name: 'constructor',
      qualifiedName: `${ownerQualifiedName}::constructor`,
      ownerName: owner.name,
      ownerQualifiedName,
      ownerKind: owner.classKind,
      packageName,
      file: relativeFile,
      line,
      startLine: line,
      endLine: lineNumberAt(source, closeParenOffset),
      signature: source.slice(match.index, closeParenOffset + 1).trim().replace(/\s+/g, ' '),
      visibility: readAndroidKotlinVisibility(splitAndroidKotlinModifiers(match[1])),
      isAsync: false,
      isStatic: false,
    });
  }
  return uniqueObjects(constructors);
}

function readAndroidKotlinPropertiesFromSource(source, relativeFile, packageName, classes) {
  const properties = [];
  const primaryRanges = readAndroidKotlinPrimaryConstructorRanges(source, classes);
  const companionRanges = readAndroidKotlinCompanionObjectRanges(source);
  for (const range of primaryRanges) {
    const owner = range.owner;
    if (!owner) continue;
    const ownerQualifiedName = owner.qualifiedName ?? (packageName ? `${packageName}.${owner.name}` : owner.name);
    for (const parameter of splitKotlinTopLevelComma(source.slice(range.parametersStartOffset, range.parametersEndOffset))) {
      const property = readAndroidKotlinPropertyDeclaration(parameter.text);
      if (!property) continue;
      const parameterStartOffset = range.parametersStartOffset + parameter.startOffset;
      const parameterEndOffset = range.parametersStartOffset + parameter.endOffset;
      const annotations = readAndroidKotlinInlineAnnotations(parameter.text, source, parameterStartOffset);
      const declarationOffset = findAndroidKotlinPropertyDeclarationOffset(parameter.text, parameterStartOffset);
      const line = annotations[0]?.line ?? lineNumberAt(source, declarationOffset);
      properties.push({
        ...property,
        qualifiedName: `${ownerQualifiedName}::${property.name}`,
        ownerName: owner.name,
        ownerQualifiedName,
        ownerKind: owner.classKind,
        packageName,
        file: relativeFile,
        line,
        startLine: line,
        endLine: lineNumberAt(source, parameterEndOffset),
        signature: parameter.text.trim().replace(/\s+/g, ' '),
        isStatic: false,
        constructorParameter: true,
        annotations,
        typeReferences: (property.typeReferences ?? []).map(reference => ({
          ...reference,
          line: reference.line ?? line,
        })),
      });
    }
  }

  const bodyPropertyPattern = /^\s*((?:(?:override|public|private|protected|internal|open|final|lateinit|const)\s+)*)(val|var)\s+([A-Za-z_][\w]*)\b[^\n]*/gm;
  let match;
  while ((match = bodyPropertyPattern.exec(source)) !== null) {
    const line = lineNumberAt(source, match.index);
    if (primaryRanges.some(range => line >= range.startLine && line <= range.endLine)) continue;
    const owner = findAndroidKotlinOwnerClass(classes, line);
    if (!owner) continue;
    const ownerQualifiedName = owner.qualifiedName ?? (packageName ? `${packageName}.${owner.name}` : owner.name);
    const modifiers = splitAndroidKotlinModifiers(match[1]);
    const name = match[3];
    const annotations = readAndroidKotlinLeadingAnnotations(source, match.index);
    const declaredProperty = readAndroidKotlinPropertyDeclaration(match[0]);
    const property = {
      name,
      qualifiedName: `${ownerQualifiedName}::${name}`,
      ownerName: owner.name,
      ownerQualifiedName,
      ownerKind: owner.classKind,
      packageName,
      file: relativeFile,
      line,
      startLine: annotations[0]?.line ?? line,
      endLine: line,
      signature: match[0].trim().replace(/\s+/g, ' '),
      visibility: readAndroidKotlinVisibility(modifiers),
      isMutable: match[2] === 'var',
      isConst: modifiers.includes('const'),
      isOverride: modifiers.includes('override'),
      isStatic: owner.classKind === 'object'
        || companionRanges.some(range => line >= range.startLine && line <= range.endLine),
      annotations,
      typeName: declaredProperty?.typeName ?? null,
      typeReferences: (declaredProperty?.typeReferences ?? []).map(reference => ({
        ...reference,
        line: reference.line ?? line,
      })),
    };
    properties.push(property);
  }
  return uniqueObjects(properties);
}

function readAndroidKotlinPrimaryConstructorRanges(source, classes) {
  const ranges = [];
  for (const owner of classes) {
    if (owner.classKind === 'object' || owner.classKind === 'interface') continue;
    const declarationOffset = findAndroidKotlinClassDeclarationOffset(source, owner);
    if (declarationOffset < 0) continue;
    const nameOffset = source.indexOf(owner.name, declarationOffset);
    if (nameOffset < 0) continue;
    let cursor = nameOffset + owner.name.length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source.startsWith('constructor', cursor)) {
      cursor += 'constructor'.length;
      while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    }
    if (source[cursor] !== '(') continue;
    const closeParenOffset = findMatchingDelimiterOffset(source, cursor, '(', ')');
    if (closeParenOffset < 0) continue;
    ranges.push({
      owner,
      signatureStartOffset: declarationOffset,
      parametersStartOffset: cursor + 1,
      parametersEndOffset: closeParenOffset,
      endOffset: closeParenOffset + 1,
      startLine: lineNumberAt(source, declarationOffset),
      endLine: lineNumberAt(source, closeParenOffset),
    });
  }
  return ranges;
}

function findAndroidKotlinClassDeclarationOffset(source, owner) {
  const lineStartOffset = offsetAtLine(source, owner.startLine);
  const declarationPattern = new RegExp(
    `\\b(?:class|object|interface|enum\\s+class)\\s+${escapeRegExp(owner.name)}\\b`,
    'g',
  );
  declarationPattern.lastIndex = lineStartOffset;
  const match = declarationPattern.exec(source);
  return match ? match.index : -1;
}

function readAndroidKotlinCompanionObjectRanges(source) {
  const ranges = [];
  const companionPattern = /\bcompanion\s+object(?:\s+[A-Za-z_][\w]*)?\s*\{/g;
  let match;
  while ((match = companionPattern.exec(source)) !== null) {
    const braceOffset = source.indexOf('{', match.index);
    const endOffset = findCurlyBlockEndOffset(source, braceOffset);
    ranges.push({
      startLine: lineNumberAt(source, match.index),
      endLine: lineNumberAt(source, Math.max(match.index, endOffset)),
    });
  }
  return ranges;
}

function readAndroidKotlinPropertyDeclaration(text) {
  const declarationText = stripAndroidKotlinLeadingAnnotationText(text);
  const match = /^\s*((?:(?:override|public|private|protected|internal|open|final|lateinit|const)\s+)*)(val|var)\s+([A-Za-z_][\w]*)\b/.exec(declarationText);
  if (!match) return null;
  const modifiers = splitAndroidKotlinModifiers(match[1]);
  const afterNameText = declarationText.slice(match[0].length);
  const typeMatch = /^\s*:\s*([\s\S]+)$/.exec(afterNameText);
  const rawTypeText = typeMatch?.[1] ?? '';
  const defaultValueOffset = findKotlinTopLevelAssignmentOffset(rawTypeText);
  const typeText = defaultValueOffset >= 0
    ? rawTypeText.slice(0, defaultValueOffset)
    : rawTypeText;
  const typeReferences = readAndroidKotlinTypeReferencesFromTypeText(typeText, {
    typeRole: 'property',
  });
  return {
    name: match[3],
    visibility: readAndroidKotlinVisibility(modifiers),
    isMutable: match[2] === 'var',
    isConst: modifiers.includes('const'),
    isOverride: modifiers.includes('override'),
    typeName: typeReferences[0]?.typeName ?? null,
    typeReferences,
  };
}

function stripAndroidKotlinLeadingAnnotationText(text) {
  let value = String(text ?? '');
  let previous = null;
  while (previous !== value) {
    previous = value;
    value = value.replace(/^\s*@(?:[A-Za-z_][\w]*:)?[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*(?:\([^)]*\))?\s*/s, '');
  }
  return value;
}

function findAndroidKotlinPropertyDeclarationOffset(text, absoluteStartOffset) {
  const match = /\b(?:val|var)\s+[A-Za-z_][\w]*\b/.exec(String(text ?? ''));
  return absoluteStartOffset + (match?.index ?? 0);
}

function readAndroidKotlinLeadingAnnotations(source, declarationOffset) {
  const value = String(source ?? '');
  const lines = value.split(/\r?\n/);
  const declarationLine = lineNumberAt(value, declarationOffset);
  const annotations = [];
  for (let lineIndex = declarationLine - 2; lineIndex >= 0; lineIndex -= 1) {
    const line = lines[lineIndex] ?? '';
    if (line.trim().length === 0) break;
    const annotation = readAndroidKotlinAnnotationLine(line, lineIndex + 1);
    if (!annotation) break;
    annotations.unshift(annotation);
  }
  return annotations;
}

function readAndroidKotlinInlineAnnotations(text, source, absoluteStartOffset) {
  const value = String(text ?? '');
  const declarationMatch = /\b(?:val|var|fun|class|object|interface|enum\s+class)\b/.exec(value);
  const prefix = declarationMatch ? value.slice(0, declarationMatch.index) : value;
  const annotations = [];
  const annotationPattern = /@(?:[A-Za-z_][\w]*:)?([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g;
  let match;
  while ((match = annotationPattern.exec(prefix)) !== null) {
    const absoluteOffset = absoluteStartOffset + match.index;
    annotations.push(androidKotlinAnnotationFromMatch(match[1], source, absoluteOffset));
  }
  return uniqueObjects(annotations);
}

function readAndroidKotlinAnnotationLine(line, lineNumber) {
  const match = /^\s*@(?:[A-Za-z_][\w]*:)?([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/.exec(String(line ?? ''));
  if (!match) return null;
  const column = String(line ?? '').indexOf('@');
  return androidKotlinAnnotation(match[1], lineNumber, Math.max(0, column));
}

function androidKotlinAnnotationFromMatch(rawName, source, absoluteOffset) {
  return androidKotlinAnnotation(
    rawName,
    lineNumberAt(source, absoluteOffset),
    columnNumberAt(source, absoluteOffset),
  );
}

function androidKotlinAnnotation(rawName, line, column) {
  const qualifiedName = String(rawName ?? '').trim();
  if (!qualifiedName) return null;
  return {
    name: qualifiedName.split('.').filter(Boolean).at(-1) ?? qualifiedName,
    qualifiedName,
    line,
    column,
  };
}

function splitKotlinTopLevelComma(text) {
  const value = String(text ?? '');
  const parts = [];
  let startOffset = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === ',' && parenDepth === 0 && angleDepth === 0 && bracketDepth === 0) {
      parts.push({
        text: value.slice(startOffset, index),
        startOffset,
        endOffset: index,
      });
      startOffset = index + 1;
    }
  }
  parts.push({
    text: value.slice(startOffset),
    startOffset,
    endOffset: value.length,
  });
  return parts.filter(part => part.text.trim().length > 0);
}

function findKotlinTopLevelAssignmentOffset(text) {
  const value = String(text ?? '');
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (
      char === '='
      && parenDepth === 0
      && angleDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      return index;
    }
  }
  return -1;
}

function readAndroidKotlinTypeReferencesFromTypeText(typeText, options = {}) {
  const value = normalizeAndroidKotlinTypeText(typeText);
  if (!value) return [];
  const references = [];
  const typePattern = /\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\b/g;
  let match;
  while ((match = typePattern.exec(value)) !== null) {
    const typeName = match[0];
    if (isAndroidKotlinBuiltinType(typeName)) continue;
    references.push(stripNullValues({
      typeName,
      typeRole: options.typeRole ?? 'type',
      parameterName: options.parameterName ?? null,
      line: options.line ?? null,
      column: typeof options.column === 'number'
        ? options.column + match.index
        : null,
    }));
  }
  return uniqueObjects(references);
}

function normalizeAndroidKotlinTypeText(typeText) {
  return String(typeText ?? '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[?]/g, '')
    .replace(/\bout\b|\bin\b|\bwhere\b/g, ' ')
    .trim();
}

function isAndroidKotlinBuiltinType(typeName) {
  const normalized = String(typeName ?? '').split('.').filter(Boolean).at(-1) ?? '';
  return new Set([
    'Any',
    'Array',
    'Boolean',
    'BooleanArray',
    'Byte',
    'ByteArray',
    'Char',
    'CharArray',
    'Collection',
    'Double',
    'DoubleArray',
    'Float',
    'FloatArray',
    'Int',
    'IntArray',
    'Iterable',
    'List',
    'Long',
    'LongArray',
    'Map',
    'MutableList',
    'MutableMap',
    'MutableSet',
    'Nothing',
    'Sequence',
    'Set',
    'Short',
    'ShortArray',
    'String',
    'Unit',
  ]).has(normalized);
}

function findMatchingDelimiterOffset(source, openOffset, openChar, closeChar) {
  if (openOffset < 0 || source[openOffset] !== openChar) return -1;
  let depth = 0;
  for (let index = openOffset; index < source.length; index += 1) {
    const char = source[index];
    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function offsetAtLine(source, lineNumber) {
  const targetLine = Math.max(1, Number(lineNumber) || 1);
  if (targetLine <= 1) return 0;
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      if (line === targetLine) return index + 1;
    }
  }
  return source.length;
}

function columnNumberAt(source, offset) {
  const line = lineNumberAt(source, offset);
  return Math.max(0, offset - offsetAtLine(source, line));
}

function readAndroidKotlinMethodsFromSource(source, relativeFile, packageName, classes) {
  const methods = [];
  const methodPattern = /\b((?:(?:override|suspend|public|private|protected|internal|open|abstract|final|operator|infix|tailrec|inline|external)\s+)*)fun\s+(?:<[^>\n]+>\s*)?([A-Za-z_][\w]*)\s*/g;
  let match;
  while ((match = methodPattern.exec(source)) !== null) {
    const line = lineNumberAt(source, match.index);
    const owner = findAndroidKotlinOwnerClass(classes, line);
    if (!owner) continue;
    const name = match[2];
    const modifiers = splitAndroidKotlinModifiers(match[1]);
    const annotations = readAndroidKotlinLeadingAnnotations(source, match.index);
    const signatureBounds = readAndroidKotlinSignatureBounds(source, match.index, methodPattern.lastIndex);
    const typeReferences = readAndroidKotlinCallableTypeReferences(
      source,
      match.index,
      signatureBounds.signatureEndOffset,
    );
    const endOffset = signatureBounds.bodyOpenBraceOffset >= 0
      ? findCurlyBlockEndOffset(source, signatureBounds.bodyOpenBraceOffset)
      : signatureBounds.endOffset;
    const endLine = lineNumberAt(source, Math.max(match.index, endOffset));
    const ownerQualifiedName = owner.qualifiedName ?? (packageName ? `${packageName}.${owner.name}` : owner.name);
    const qualifiedName = `${ownerQualifiedName}::${name}`;
    methods.push({
      name,
      qualifiedName,
      ownerName: owner.name,
      ownerQualifiedName,
      ownerKind: owner.classKind,
      packageName,
      file: relativeFile,
      line,
      startLine: annotations[0]?.line ?? line,
      endLine,
      signature: source
        .slice(match.index, signatureBounds.signatureEndOffset)
        .trim()
        .replace(/\s+/g, ' '),
      visibility: readAndroidKotlinVisibility(modifiers),
      isAsync: modifiers.includes('suspend'),
      isStatic: owner.classKind === 'object',
      isOverride: modifiers.includes('override'),
      returnType: typeReferences.find(reference => reference.typeRole === 'return')?.typeName ?? null,
      typeReferences,
      annotations,
      bodyText: source.slice(signatureBounds.bodyStartOffset, endOffset),
      bodyStartOffset: signatureBounds.bodyStartOffset,
      source,
    });
  }
  return methods;
}

function readAndroidKotlinFunctionsFromSource(source, relativeFile, packageName, classes) {
  const functions = [];
  const searchableSource = maskAndroidKotlinNonCode(source);
  const functionPattern = /\b((?:(?:suspend|public|private|protected|internal|open|abstract|final|operator|infix|tailrec|inline|external)\s+)*)fun\s+(?:<[^>\n]+>\s*)?([A-Za-z_][\w]*)\s*/g;
  let match;
  while ((match = functionPattern.exec(searchableSource)) !== null) {
    const declarationPrefix = searchableSource.slice(
      Math.max(0, match.index - 160),
      match.index,
    );
    if (/\b[A-Za-z_][\w.]*\s*\.\s*$/.test(declarationPrefix)) continue;
    if (searchableSource[functionPattern.lastIndex] === '.') continue;
    const openParenOffset = searchableSource.indexOf('(', functionPattern.lastIndex);
    if (
      openParenOffset >= 0
      && searchableSource.slice(functionPattern.lastIndex, openParenOffset).includes('.')
    ) continue;
    const line = lineNumberAt(source, match.index);
    if (findAndroidKotlinOwnerClass(classes, line)) continue;
    const name = match[2];
    const modifiers = splitAndroidKotlinModifiers(match[1]);
    const annotations = readAndroidKotlinLeadingAnnotations(source, match.index);
    const signatureBounds = readAndroidKotlinSignatureBounds(source, match.index, functionPattern.lastIndex);
    const typeReferences = readAndroidKotlinCallableTypeReferences(
      source,
      match.index,
      signatureBounds.signatureEndOffset,
    );
    const endOffset = signatureBounds.bodyOpenBraceOffset >= 0
      ? findCurlyBlockEndOffset(source, signatureBounds.bodyOpenBraceOffset)
      : signatureBounds.endOffset;
    const endLine = lineNumberAt(source, Math.max(match.index, endOffset));
    functions.push({
      name,
      qualifiedName: packageName ? `${packageName}.${name}` : name,
      packageName,
      file: relativeFile,
      line,
      startLine: annotations[0]?.line ?? line,
      endLine,
      signature: source
        .slice(match.index, signatureBounds.signatureEndOffset)
        .trim()
        .replace(/\s+/g, ' '),
      visibility: readAndroidKotlinVisibility(modifiers),
      isAsync: modifiers.includes('suspend'),
      isStatic: false,
      returnType: typeReferences.find(reference => reference.typeRole === 'return')?.typeName ?? null,
      typeReferences,
      annotations,
      bodyText: source.slice(signatureBounds.bodyStartOffset, endOffset),
      bodyStartOffset: signatureBounds.bodyStartOffset,
      source,
    });
  }
  return functions;
}

function readAndroidKotlinFunctionsFromNativeEndpoints(
  source,
  relativeFile,
  packageName,
  classes,
  endpoints,
) {
  const contentHash = createHash('sha256').update(Buffer.from(source)).digest('hex');
  const size = Buffer.byteLength(source);
  for (const endpoint of endpoints) {
    if (
      endpoint.file !== relativeFile
      || endpoint.contentHash !== contentHash
      || endpoint.size !== size
    ) {
      throw new Error(
        `Native Android function endpoint is stale for ${relativeFile}:${endpoint.startLine}:${endpoint.nativeName}`,
      );
    }
  }
  const functions = readAndroidKotlinFunctionsFromSource(
    source,
    relativeFile,
    packageName,
    classes,
  );
  assertNativeAndroidKotlinFunctionCompleteness(functions, endpoints, relativeFile);
  return functions;
}

function assertNativeAndroidKotlinFunctionCompleteness(functions, endpoints, relativeFile) {
  const localIdentities = new Map();
  for (const item of functions) {
    const identity = `${relativeFile}\0${item.line}\0${item.name}`;
    if (localIdentities.has(identity)) {
      throw new Error(`Local Android function identity is ambiguous: ${identity}`);
    }
    localIdentities.set(identity, item);
  }

  const nativeIdentities = new Map();
  for (const endpoint of endpoints) {
    const identity = `${endpoint.file}\0${endpoint.startLine}\0${endpoint.nativeName}`;
    if (!endpoint.nativeNodeId || nativeIdentities.has(identity)) {
      throw new Error(`Native Android function identity is ambiguous: ${identity}`);
    }
    nativeIdentities.set(identity, endpoint.nativeNodeId);
  }

  const missing = [...localIdentities.keys()].filter(identity => !nativeIdentities.has(identity));
  const extra = [...nativeIdentities.keys()].filter(identity => !localIdentities.has(identity));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Native Android function completeness mismatch for ${relativeFile}: ${JSON.stringify({ missing, extra })}`,
    );
  }
}

function readAndroidKotlinCallableTypeReferences(source, declarationOffset, signatureEndOffset) {
  const openParenOffset = source.indexOf('(', declarationOffset);
  const closeParenOffset = findMatchingDelimiterOffset(source, openParenOffset, '(', ')');
  if (openParenOffset < 0 || closeParenOffset < 0 || closeParenOffset > signatureEndOffset) {
    return [];
  }
  const references = [];
  for (const parameter of splitKotlinTopLevelComma(source.slice(openParenOffset + 1, closeParenOffset))) {
    const absoluteStart = openParenOffset + 1 + parameter.startOffset;
    const parameterReferences = readAndroidKotlinParameterTypeReferences(parameter.text, source, absoluteStart);
    references.push(...parameterReferences);
  }

  let cursor = skipWhitespaceOffset(source, closeParenOffset + 1);
  if (source[cursor] !== ':') {
    return uniqueObjects(references);
  }
  const typeStartOffset = skipWhitespaceOffset(source, cursor + 1);
  let typeEndOffset = typeStartOffset;
  while (
    typeEndOffset < signatureEndOffset
    && !['{', '='].includes(source[typeEndOffset])
  ) {
    typeEndOffset += 1;
  }
  const returnTypeText = source.slice(typeStartOffset, typeEndOffset);
  references.push(...readAndroidKotlinTypeReferencesFromTypeText(returnTypeText, {
    typeRole: 'return',
    line: lineNumberAt(source, typeStartOffset),
    column: columnNumberAt(source, typeStartOffset),
  }));
  return uniqueObjects(references);
}

function readAndroidKotlinParameterTypeReferences(parameterText, source, absoluteStartOffset) {
  const cleanText = stripAndroidKotlinLeadingAnnotationText(parameterText)
    .replace(/^\s*(?:vararg|crossinline|noinline)\s+/, '');
  const defaultValueOffset = findKotlinTopLevelAssignmentOffset(cleanText);
  const declarationText = defaultValueOffset >= 0
    ? cleanText.slice(0, defaultValueOffset)
    : cleanText;
  const match = /\b([A-Za-z_][\w]*)\s*:\s*([\s\S]+)$/.exec(declarationText.trim());
  if (!match) return [];
  const parameterName = match[1];
  const typeText = match[2].trim();
  if (!typeText) return [];
  const typeOffsetInOriginal = String(parameterText ?? '').indexOf(typeText);
  const typeOffset = typeOffsetInOriginal >= 0
    ? absoluteStartOffset + typeOffsetInOriginal
    : absoluteStartOffset;
  return readAndroidKotlinTypeReferencesFromTypeText(typeText, {
    typeRole: 'parameter',
    parameterName,
    line: lineNumberAt(source, typeOffset),
    column: columnNumberAt(source, typeOffset),
  });
}

function findAndroidKotlinOwnerClass(classes, line) {
  return [...classes]
    .filter(kotlinClass => kotlinClass.startLine <= line && kotlinClass.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))
    .at(0) ?? null;
}

function splitAndroidKotlinModifiers(rawModifiers) {
  return String(rawModifiers ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function readAndroidKotlinVisibility(modifiers) {
  return modifiers.find(modifier => (
    modifier === 'public'
    || modifier === 'private'
    || modifier === 'protected'
    || modifier === 'internal'
  )) ?? null;
}

function readAndroidKotlinSignatureBounds(source, startOffset, afterDeclarationOffset) {
  const value = String(source ?? '');
  const openParenOffset = value.indexOf('(', afterDeclarationOffset);
  const closeParenOffset = findMatchingDelimiterOffset(value, openParenOffset, '(', ')');
  const fallbackEndOffset = closeParenOffset >= 0
    ? closeParenOffset + 1
    : readLineEndOffset(value, afterDeclarationOffset);
  const boundary = readAndroidKotlinCallableBodyBoundary(
    value,
    closeParenOffset >= 0 ? closeParenOffset + 1 : afterDeclarationOffset,
  );
  const signatureEndOffset = boundary.signatureEndOffset >= startOffset
    ? boundary.signatureEndOffset
    : fallbackEndOffset;
  return {
    signatureEndOffset,
    bodyOpenBraceOffset: boundary.bodyOpenBraceOffset,
    bodyStartOffset: boundary.bodyOpenBraceOffset >= 0
      ? boundary.bodyOpenBraceOffset + 1
      : boundary.expressionBodyOffset >= 0
        ? boundary.expressionBodyOffset + 1
        : signatureEndOffset,
    endOffset: boundary.expressionBodyOffset >= 0
      ? readLineEndOffset(value, boundary.expressionBodyOffset)
      : signatureEndOffset,
  };
}

function readAndroidKotlinCallableBodyBoundary(source, startOffset) {
  const value = String(source ?? '');
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let sawReturnTypeColon = false;
  let sawReturnTypeToken = false;
  let lastTopLevelNonWhitespace = '';

  for (let index = Math.max(0, startOffset); index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === '<') {
      angleDepth += 1;
      continue;
    }
    if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (parenDepth > 0 || angleDepth > 0 || bracketDepth > 0) {
      continue;
    }

    if (char === '{') {
      return {
        signatureEndOffset: index,
        bodyOpenBraceOffset: index,
        expressionBodyOffset: -1,
      };
    }
    if (char === '=') {
      return {
        signatureEndOffset: index,
        bodyOpenBraceOffset: -1,
        expressionBodyOffset: index,
      };
    }
    if (char === '\n' || char === '\r') {
      const nextOffset = skipWhitespaceOffset(value, index + 1);
      if (
        value[nextOffset] === '{'
        || value[nextOffset] === '='
        || lastTopLevelNonWhitespace === ':'
        || (sawReturnTypeColon && !sawReturnTypeToken)
      ) {
        continue;
      }
      return {
        signatureEndOffset: index,
        bodyOpenBraceOffset: -1,
        expressionBodyOffset: -1,
      };
    }
    if (char === ':') {
      sawReturnTypeColon = true;
      lastTopLevelNonWhitespace = char;
      continue;
    }
    if (!/\s/.test(char)) {
      if (sawReturnTypeColon) {
        sawReturnTypeToken = true;
      }
      lastTopLevelNonWhitespace = char;
    }
  }

  return {
    signatureEndOffset: value.length,
    bodyOpenBraceOffset: -1,
    expressionBodyOffset: -1,
  };
}

function readLineEndOffset(source, offset) {
  const lineEnd = String(source ?? '').indexOf('\n', offset);
  return lineEnd >= 0 ? lineEnd : String(source ?? '').length;
}

function findCurlyBlockEndOffset(source, openBraceOffset) {
  const value = String(source ?? '');
  let depth = 0;
  for (let index = Math.max(0, openBraceOffset); index < value.length; index += 1) {
    const char = value[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth <= 0) {
        return index + 1;
      }
    }
  }
  return value.length;
}

function toAndroidKotlinOverlayMethod(method) {
  const {
    bodyText: _bodyText,
    bodyStartOffset: _bodyStartOffset,
    source: _source,
    ...overlayMethod
  } = method;
  return overlayMethod;
}

function readAndroidKotlinMethodCalls(methods) {
  const methodsBySimpleName = new Map();
  const methodByOwnerAndName = new Map();
  for (const method of methods) {
    appendMapValue(methodsBySimpleName, method.name, method);
    methodByOwnerAndName.set(androidKotlinOwnerMethodKey(method.ownerQualifiedName, method.name), method);
    methodByOwnerAndName.set(androidKotlinOwnerMethodKey(method.ownerName, method.name), method);
  }

  const calls = [];
  const callPattern = /\b(?:(?<receiver>[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\.)?(?<name>[A-Za-z_][\w]*)\s*\(/g;
  for (const sourceMethod of methods) {
    let match;
    while ((match = callPattern.exec(sourceMethod.bodyText ?? '')) !== null) {
      const callName = match.groups?.name;
      if (!callName || isAndroidKotlinControlCall(callName)) continue;
      const targetMethod = resolveAndroidKotlinCallTarget({
        receiver: match.groups?.receiver ?? null,
        name: callName,
      }, sourceMethod, methodsBySimpleName, methodByOwnerAndName);
      if (!targetMethod) continue;
      calls.push({
        sourceFile: sourceMethod.file,
        sourceQualifiedName: sourceMethod.qualifiedName,
        sourceKind: androidKotlinCallableNodeKind(sourceMethod),
        targetFile: targetMethod.file,
        targetQualifiedName: targetMethod.qualifiedName,
        targetKind: androidKotlinCallableNodeKind(targetMethod),
        callName,
        receiver: match.groups?.receiver ?? null,
        line: lineNumberAt(sourceMethod.source, sourceMethod.bodyStartOffset + match.index),
      });
    }
  }
  return uniqueObjects(calls);
}

function resolveAndroidKotlinCallTarget(call, sourceMethod, methodsBySimpleName, methodByOwnerAndName) {
  if (call.receiver) {
    const receiverLeaf = call.receiver.split('.').filter(Boolean).at(-1);
    return methodByOwnerAndName.get(androidKotlinOwnerMethodKey(call.receiver, call.name))
      ?? methodByOwnerAndName.get(androidKotlinOwnerMethodKey(receiverLeaf, call.name))
      ?? uniqueSingle(methodsBySimpleName.get(call.name));
  }
  return methodByOwnerAndName.get(androidKotlinOwnerMethodKey(sourceMethod.ownerQualifiedName, call.name))
    ?? uniqueSingle(methodsBySimpleName.get(call.name));
}

function androidKotlinOwnerMethodKey(ownerName, methodName) {
  return `${String(ownerName ?? '')}::${String(methodName ?? '')}`;
}

function androidKotlinCallableNodeKind(callable) {
  return callable?.ownerName ? 'method' : 'function';
}

function androidKotlinOwnerNodeKind(ownerKind) {
  if (ownerKind === 'enum class') return 'enum';
  if (ownerKind === 'interface') return 'interface';
  return 'class';
}

function androidKotlinNodeKind(kotlinClass) {
  return androidKotlinOwnerNodeKind(kotlinClass?.classKind);
}

function androidKotlinClassRelation(kotlinClass) {
  if (kotlinClass?.isCompanionObject) return 'android-kotlin-companion-object';
  if (kotlinClass?.classKind === 'object') return 'android-kotlin-object';
  if (kotlinClass?.classKind === 'interface') return 'android-kotlin-interface';
  return 'android-kotlin-class';
}

function androidKotlinAnnotationNames(item) {
  const names = unique((item?.annotations ?? []).map(annotation => annotation.name).filter(Boolean));
  return names.length > 0 ? names : undefined;
}

function resolveAndroidKotlinHeritageDeclaration(sourceClass, typeName, declarations) {
  const normalizedTypeName = String(typeName ?? '').trim();
  if (!normalizedTypeName) return null;
  const typeLeaf = normalizedTypeName.split('.').filter(Boolean).at(-1) ?? normalizedTypeName;
  const samePackageQualifiedName = sourceClass?.packageName
    ? `${sourceClass.packageName}.${normalizedTypeName}`
    : normalizedTypeName;
  const candidates = declarations.filter(declaration => (
    declaration
    && declaration !== sourceClass
    && (
      declaration.qualifiedName === normalizedTypeName
      || declaration.qualifiedName === samePackageQualifiedName
      || declaration.name === typeLeaf
    )
  ));
  return uniqueSingle(candidates) ?? null;
}

function resolveAndroidKotlinExternalHeritageTarget(sourceClass, typeName, kotlinImports) {
  const normalizedTypeName = String(typeName ?? '').trim();
  if (!normalizedTypeName) return null;
  const typeLeaf = normalizedTypeName.split('.').filter(Boolean).at(-1) ?? normalizedTypeName;
  const sameFileImports = (kotlinImports ?? []).filter(kotlinImport => kotlinImport.file === sourceClass?.file);
  const exactImport = sameFileImports.find(kotlinImport => (
    kotlinImport.name === normalizedTypeName
    || kotlinImport.importedName === normalizedTypeName
    || kotlinImport.alias === normalizedTypeName
    || kotlinImport.target === normalizedTypeName
  ));
  if (exactImport?.target) {
    return {
      name: exactImport.target,
      targetName: exactImport.target,
      importedName: exactImport.importedName,
      importAlias: exactImport.alias,
      packageName: exactImport.packageName,
      wildcard: Boolean(exactImport.wildcard),
      imported: true,
    };
  }

  const wildcardImport = sameFileImports.find(kotlinImport => kotlinImport.wildcard && kotlinImport.packageName);
  if (wildcardImport) {
    const targetName = `${wildcardImport.packageName}.${typeLeaf}`;
    return {
      name: targetName,
      targetName,
      importedName: typeLeaf,
      packageName: wildcardImport.packageName,
      wildcard: true,
      imported: true,
    };
  }

  const targetName = normalizedTypeName.includes('.')
    ? normalizedTypeName
    : (sourceClass?.packageName ? `${sourceClass.packageName}.${normalizedTypeName}` : normalizedTypeName);
  return {
    name: targetName,
    targetName,
    importedName: typeLeaf,
    packageName: targetName.includes('.') ? targetName.split('.').slice(0, -1).join('.') : null,
    wildcard: false,
    imported: false,
  };
}

function resolveAndroidKotlinTypeTarget(sourceItem, typeName, declarations, kotlinImports) {
  const targetDeclaration = resolveAndroidKotlinHeritageDeclaration(sourceItem, typeName, declarations);
  if (targetDeclaration) {
    return {
      declaration: targetDeclaration,
      targetName: targetDeclaration.qualifiedName ?? targetDeclaration.name,
    };
  }
  const externalTarget = resolveAndroidKotlinExternalHeritageTarget(sourceItem, typeName, kotlinImports);
  return {
    declaration: null,
    targetName: externalTarget?.targetName ?? typeName,
    importedName: externalTarget?.importedName ?? null,
    importAlias: externalTarget?.importAlias ?? null,
    packageName: externalTarget?.packageName ?? null,
    wildcard: Boolean(externalTarget?.wildcard),
  };
}

function buildAndroidKotlinMemberIndex(members) {
  const index = new Map();
  for (const member of members ?? []) {
    const ownerNames = unique([
      member.ownerQualifiedName,
      member.ownerName,
    ].filter(Boolean));
    for (const ownerName of ownerNames) {
      const key = androidKotlinMemberIndexKey(ownerName, member.name);
      const values = index.get(key) ?? [];
      values.push(member);
      index.set(key, values);
    }
  }
  return index;
}

function androidKotlinMemberIndexKey(ownerName, memberName) {
  return `${ownerName ?? ''}::${memberName ?? ''}`;
}

function findAndroidKotlinOwnerDeclaration(member, declarations) {
  return (declarations ?? []).find(declaration => (
    declaration
    && declaration.file === member?.file
    && (
      declaration.qualifiedName === member?.ownerQualifiedName
      || declaration.name === member?.ownerName
    )
  )) ?? null;
}

function findAndroidKotlinOverrideTargets(member, ownerDeclaration, memberIndex, declarations, kotlinImports) {
  if (!member?.isOverride || !ownerDeclaration) return [];
  const heritageEntries = (ownerDeclaration.heritage?.length ? ownerDeclaration.heritage : null)
    ?? (ownerDeclaration.heritageTypes ?? []).map(typeName => ({ name: typeName, hasConstructorCall: false }));
  const targets = [];
  for (const heritage of heritageEntries) {
    const typeName = typeof heritage === 'string' ? heritage : heritage?.name;
    if (!typeName) continue;
    const resolvedType = resolveAndroidKotlinTypeTarget(ownerDeclaration, typeName, declarations, kotlinImports);
    const ownerName = resolvedType.targetName ?? typeName;
    const targetMembers = memberIndex.get(androidKotlinMemberIndexKey(ownerName, member.name)) ?? [];
    const targetMember = uniqueSingle(targetMembers) ?? null;
    targets.push({
      targetMember,
      typeName,
      targetOwnerName: ownerName,
      targetName: targetMember?.qualifiedName ?? `${ownerName}::${member.name}`,
    });
  }
  return uniqueObjects(targets);
}

function androidKotlinHeritageEdgeKind(sourceClass, targetDeclaration, heritage, heritageIndex) {
  if (sourceClass?.classKind === 'interface') return 'extends';
  if (targetDeclaration) {
    return targetDeclaration.classKind === 'interface' ? 'implements' : 'extends';
  }
  if (heritage?.hasConstructorCall) return 'extends';
  return heritageIndex === 0 ? 'implements' : 'implements';
}

function uniqueSingle(values) {
  return values?.length === 1 ? values[0] : null;
}

function isAndroidKotlinControlCall(name) {
  return new Set(['if', 'for', 'while', 'when', 'catch', 'return']).has(String(name ?? ''));
}

function readAndroidManifestComponents(source, file, kotlinClassBySimpleName) {
  const manifestPackage = readXmlAttributes(/<\s*manifest\b([^>]*)>/i.exec(source)?.[1] ?? '').package ?? null;
  const components = [];
  const componentPattern = /<\s*(activity|activity-alias|service|receiver|provider)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\s*\1\s*>)/gi;
  let match;
  while ((match = componentPattern.exec(source)) !== null) {
    const componentType = match[1];
    const attributes = readXmlAttributes(match[2]);
    const rawName = attributes['android:name'] ?? attributes.name ?? null;
    if (!rawName) continue;
    const simpleName = rawName.split('.').filter(Boolean).at(-1) ?? rawName;
    const knownClass = kotlinClassBySimpleName.get(simpleName);
    const className = knownClass?.qualifiedName ?? resolveAndroidManifestClassName(rawName, manifestPackage);
    const blockText = match[0];
    const intentFilters = readAndroidManifestIntentEntries(source, blockText, match.index, 'intent-filter');
    const metadata = [];
    const metadataPattern = /<\s*meta-data\b([^>]*?)\/?>/gi;
    let metadataMatch;
    while ((metadataMatch = metadataPattern.exec(blockText)) !== null) {
      const metadataAttributes = readXmlAttributes(metadataMatch[1]);
      metadata.push({
        name: metadataAttributes['android:name'] ?? metadataAttributes.name ?? null,
        value: metadataAttributes['android:value'] ?? metadataAttributes.value ?? null,
        resource: metadataAttributes['android:resource'] ?? metadataAttributes.resource ?? null,
        line: lineNumberAt(source, match.index + metadataMatch.index),
      });
    }
    const line = lineNumberAt(source, match.index);
    components.push({
      componentType,
      rawName,
      simpleName,
      className,
      file,
      line,
      startLine: line,
      endLine: lineNumberAt(source, match.index + blockText.length),
      exported: attributes['android:exported'] ?? attributes.exported ?? null,
      permission: attributes['android:permission'] ?? attributes.permission ?? null,
      actions: unique(intentFilters.flatMap(intentFilter => intentFilter.actions.map(action => action.name))),
      intentFilters,
      metadata: metadata.filter(item => item.name || item.value || item.resource),
    });
  }
  return components;
}

function readAndroidManifestUsesPermissions(source, file) {
  const permissions = [];
  const permissionPattern = /<\s*(uses-permission(?:-sdk-23)?)\b([^>]*?)\/?>/gi;
  let match;
  while ((match = permissionPattern.exec(String(source ?? ''))) !== null) {
    const attributes = readXmlAttributes(match[2]);
    const permission = attributes['android:name'] ?? attributes.name;
    if (!permission) continue;
    permissions.push({
      permission,
      declarationType: match[1],
      file,
      line: lineNumberAt(source, match.index),
    });
  }
  return uniqueObjects(permissions);
}

function readAndroidManifestQueries(source, file) {
  const queries = [];
  const queriesPattern = /<\s*queries\b[^>]*>([\s\S]*?)<\/\s*queries\s*>/gi;
  let queriesMatch;
  while ((queriesMatch = queriesPattern.exec(String(source ?? ''))) !== null) {
    const blockText = queriesMatch[1];
    const blockOffset = queriesMatch.index + queriesMatch[0].indexOf(blockText);
    for (const queryType of ['package', 'provider']) {
      const queryPattern = new RegExp(`<\\s*${queryType}\\b([^>]*?)\\/?>`, 'gi');
      let queryMatch;
      while ((queryMatch = queryPattern.exec(blockText)) !== null) {
        const attributes = readXmlAttributes(queryMatch[1]);
        const queryValue = queryType === 'package'
          ? attributes['android:name'] ?? attributes.name
          : attributes['android:authorities'] ?? attributes.authorities;
        if (!queryValue) continue;
        queries.push({
          queryType,
          queryValue,
          attributes,
          file,
          line: lineNumberAt(source, blockOffset + queryMatch.index),
        });
      }
    }
    for (const intent of readAndroidManifestIntentEntries(source, blockText, blockOffset, 'intent')) {
      queries.push({
        queryType: 'intent',
        queryValue: androidManifestIntentQueryValue(intent),
        actions: intent.actions,
        categories: intent.categories,
        data: intent.data,
        file,
        line: intent.line,
      });
    }
  }
  return uniqueObjects(queries);
}

function readAndroidManifestIntentEntries(source, blockText, blockOffset, tagName) {
  const entries = [];
  const intentPattern = new RegExp(`<\\s*${tagName}\\b[^>]*>([\\s\\S]*?)<\\/\\s*${tagName}\\s*>`, 'gi');
  let intentMatch;
  while ((intentMatch = intentPattern.exec(String(blockText ?? ''))) !== null) {
    const intentText = intentMatch[0];
    const intentOffset = blockOffset + intentMatch.index;
    entries.push({
      actions: readAndroidManifestNamedElements(source, intentText, intentOffset, 'action'),
      categories: readAndroidManifestNamedElements(source, intentText, intentOffset, 'category'),
      data: readAndroidManifestDataElements(source, intentText, intentOffset),
      line: lineNumberAt(source, intentOffset),
    });
  }
  return entries;
}

function readAndroidManifestNamedElements(source, blockText, blockOffset, tagName) {
  const items = [];
  const pattern = new RegExp(`<\\s*${tagName}\\b([^>]*?)\\/?>`, 'gi');
  let match;
  while ((match = pattern.exec(String(blockText ?? ''))) !== null) {
    const attributes = readXmlAttributes(match[1]);
    const name = attributes['android:name'] ?? attributes.name;
    if (!name) continue;
    items.push({
      name,
      line: lineNumberAt(source, blockOffset + match.index),
    });
  }
  return uniqueObjects(items);
}

function readAndroidManifestDataElements(source, blockText, blockOffset) {
  const items = [];
  const pattern = /<\s*data\b([^>]*?)\/?>/gi;
  let match;
  while ((match = pattern.exec(String(blockText ?? ''))) !== null) {
    const attributes = readXmlAttributes(match[1]);
    const data = {
      scheme: attributes['android:scheme'] ?? attributes.scheme ?? null,
      host: attributes['android:host'] ?? attributes.host ?? null,
      port: attributes['android:port'] ?? attributes.port ?? null,
      path: attributes['android:path'] ?? attributes.path ?? null,
      pathPrefix: attributes['android:pathPrefix'] ?? attributes.pathPrefix ?? null,
      pathPattern: attributes['android:pathPattern'] ?? attributes.pathPattern ?? null,
      mimeType: attributes['android:mimeType'] ?? attributes.mimeType ?? null,
      line: lineNumberAt(source, blockOffset + match.index),
    };
    if (Object.values(data).some(value => value !== null)) items.push(data);
  }
  return uniqueObjects(items);
}

function androidManifestIntentQueryValue(intent) {
  return intent.actions?.[0]?.name
    ?? intent.categories?.[0]?.name
    ?? androidManifestDataValue(intent.data?.[0])
    ?? `intent@${intent.line}`;
}

function androidManifestDataValue(data) {
  return [
    data?.scheme && `scheme=${data.scheme}`,
    data?.host && `host=${data.host}`,
    data?.port && `port=${data.port}`,
    data?.path && `path=${data.path}`,
    data?.pathPrefix && `pathPrefix=${data.pathPrefix}`,
    data?.pathPattern && `pathPattern=${data.pathPattern}`,
    data?.mimeType && `mimeType=${data.mimeType}`,
  ].filter(Boolean).join(';');
}

function resolveAndroidManifestClassName(rawName, manifestPackage) {
  const value = String(rawName ?? '').trim();
  if (!value) return value;
  if (value.startsWith('.')) {
    return manifestPackage ? `${manifestPackage}${value}` : value.slice(1);
  }
  if (value.includes('.')) return value;
  return manifestPackage ? `${manifestPackage}.${value}` : value;
}

function readXmlAttributes(source) {
  const attributes = {};
  const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*(['"])(.*?)\2/g;
  let match;
  while ((match = attributePattern.exec(String(source ?? ''))) !== null) {
    attributes[match[1]] = decodeXmlAttribute(match[3]);
  }
  return attributes;
}

function decodeXmlAttribute(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAndroidResourceReference(value) {
  const match = /^@([A-Za-z_][\w-]*)\/([A-Za-z0-9_.-]+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    type: match[1],
    name: match[2],
  };
}

function resolveAndroidResourcePath(resource, androidFileSet, resourceIndex = new Map()) {
  if (!resource?.type || !resource?.name) return null;
  const indexedPath = resourceIndex.get(androidResourceIndexKey(resource.type, resource.name));
  if (indexedPath) return indexedPath;
  const xmlPath = `android/app/src/main/res/${resource.type}/${resource.name}.xml`;
  if (androidFileSet.has(xmlPath)) return xmlPath;
  const firstMatch = [...androidFileSet].find(file => (
    file.startsWith(`android/app/src/main/res/${resource.type}/`)
    && file.split('/').at(-1)?.replace(/\.[^.]+$/, '') === resource.name
  ));
  return firstMatch ?? xmlPath;
}

function androidResourceFromPath(file) {
  const match = /^android\/app\/src\/main\/res\/([^/]+)\/([^/]+)\.xml$/i.exec(file);
  if (!match) return null;
  return {
    type: match[1],
    name: match[2],
  };
}

function readXmlRootTag(source) {
  return /<\s*([A-Za-z_][\w:.-]*)\b/.exec(String(source ?? ''))?.[1] ?? null;
}

function readAndroidXmlResourceReferences(source) {
  const references = [];
  const referencePattern = /@([A-Za-z_][\w-]*)\/([A-Za-z0-9_.-]+)/g;
  let match;
  while ((match = referencePattern.exec(String(source ?? ''))) !== null) {
    references.push({
      type: match[1],
      name: match[2],
      line: lineNumberAt(source, match.index),
    });
  }
  return uniqueObjects(references);
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

function findCurlyBlockEndLine(source, startLine) {
  const lines = String(source ?? '').split(/\r?\n/);
  let depth = 0;
  let sawOpenBrace = false;
  for (let index = Math.max(0, startLine - 1); index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const char of line) {
      if (char === '{') {
        depth += 1;
        sawOpenBrace = true;
      } else if (char === '}') {
        depth -= 1;
        if (sawOpenBrace && depth <= 0) {
          return index + 1;
        }
      }
    }
  }
  return startLine;
}

function collectContext7Docs(projectRoot, allFiles) {
  const context7Root = path.join(projectRoot, 'docs', 'context7');
  if (!fs.existsSync(context7Root)) {
    return { documents: [], categories: [], retrievalRoutes: [], sourceMapRoutes: [] };
  }

  const catalogFile = 'docs/context7/catalog.json';
  const sourceMapFile = 'docs/context7/source-map.md';
  const documentPaths = new Set(allFiles
    .map(file => relative(projectRoot, file))
    .filter(file => /^docs\/context7\/.+\.(?:md|json)$/i.test(file)));
  const catalog = readContext7Catalog(projectRoot, catalogFile);
  const catalogLines = readContext7Lines(projectRoot, catalogFile);
  const categories = [];
  const categoryNamesByDoc = new Map();

  for (const [name, docs] of Object.entries(catalog?.categories ?? {})) {
    const categoryDocs = Array.isArray(docs)
      ? docs.map(normalizeContext7Path).filter(Boolean)
      : [];
    for (const doc of categoryDocs) {
      documentPaths.add(doc);
      appendMapValue(categoryNamesByDoc, doc, name);
    }
    categories.push({
      name,
      file: catalogFile,
      line: findJsonPropertyLine(catalogLines, name),
      docs: unique(categoryDocs),
    });
  }

  const retrievalRoutes = [];
  for (const [index, route] of (Array.isArray(catalog?.retrievalRoutes) ? catalog.retrievalRoutes : []).entries()) {
    const primary = normalizeContext7Path(route?.primary);
    const secondary = Array.isArray(route?.secondary)
      ? route.secondary.map(normalizeContext7Path).filter(Boolean)
      : [];
    if (primary) documentPaths.add(primary);
    for (const doc of secondary) documentPaths.add(doc);
    retrievalRoutes.push({
      query: String(route?.query ?? '').trim(),
      primary,
      secondary: unique(secondary),
      file: catalogFile,
      line: findJsonValueLine(catalogLines, route?.query, index),
      index,
    });
  }

  const sourceMapRoutes = collectContext7SourceMapRoutes(projectRoot, sourceMapFile);
  for (const route of sourceMapRoutes) {
    for (const doc of context7SourceMapRouteDocs(route)) documentPaths.add(doc);
  }

  const routeQueriesByDoc = new Map();
  for (const route of retrievalRoutes) {
    if (route.primary) appendMapValue(routeQueriesByDoc, route.primary, route.query);
    for (const doc of route.secondary ?? []) appendMapValue(routeQueriesByDoc, doc, route.query);
  }
  for (const route of sourceMapRoutes) {
    for (const doc of context7SourceMapRouteDocs(route)) {
      appendMapValue(routeQueriesByDoc, doc, route.question);
    }
  }

  const documents = [...documentPaths]
    .filter(file => /^docs\/context7\/.+\.(?:md|json)$/i.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map(file => {
      const title = readContext7DocumentTitle(projectRoot, file);
      return {
        file,
        title: title.title,
        line: title.line,
        categories: unique(categoryNamesByDoc.get(file) ?? []),
        routeQueries: unique(routeQueriesByDoc.get(file) ?? []).filter(Boolean),
      };
    });

  return {
    documents,
    categories,
    retrievalRoutes: retrievalRoutes.filter(route => route.query && route.primary),
    sourceMapRoutes,
  };
}

function readContext7Catalog(projectRoot, catalogFile) {
  const catalogPath = path.join(projectRoot, catalogFile);
  if (!fs.existsSync(catalogPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch {
    return null;
  }
}

function readContext7Lines(projectRoot, relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
}

function collectContext7SourceMapRoutes(projectRoot, sourceMapFile) {
  const lines = readContext7Lines(projectRoot, sourceMapFile);
  if (lines.length === 0) return [];

  const routes = [];
  let insideRetrievalRouting = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+Retrieval Routing\s*$/i.test(line.trim())) {
      insideRetrievalRouting = true;
      continue;
    }
    if (insideRetrievalRouting && /^##\s+/i.test(line.trim())) {
      break;
    }
    if (!insideRetrievalRouting) continue;

    const row = readMarkdownTableRow(line);
    if (!row || row.length < 3 || /^question$/i.test(row[0])) continue;
    const question = row[0];
    const docs = readContext7MarkdownLinkTargets(row[1])
      .map(normalizeContext7Path)
      .filter(Boolean);
    if (docs.length === 0) {
      const fallbackDoc = normalizeContext7Path(row[1]);
      if (fallbackDoc) docs.push(fallbackDoc);
    }
    const sourcePaths = readContext7SourcePathList(row[2]);
    if (!question || docs.length === 0) continue;
    routes.push({
      question,
      doc: docs[0],
      docs: unique(docs),
      sourcePaths,
      file: sourceMapFile,
      line: index + 1,
    });
  }
  return routes;
}

function readContext7DocumentTitle(projectRoot, relativePath) {
  const lines = readContext7Lines(projectRoot, relativePath);
  if (lines.length === 0) {
    return { title: path.basename(relativePath), line: 1 };
  }

  for (let index = 0; index < Math.min(lines.length, 20); index += 1) {
    const frontmatterTitle = /^title:\s*(.+?)\s*$/.exec(lines[index]);
    if (frontmatterTitle) {
      return { title: frontmatterTitle[1].replace(/^["']|["']$/g, '').trim(), line: index + 1 };
    }
  }

  const headingIndex = lines.findIndex(line => /^#\s+/.test(line));
  if (headingIndex >= 0) {
    return { title: lines[headingIndex].replace(/^#\s+/, '').trim(), line: headingIndex + 1 };
  }

  return { title: path.basename(relativePath), line: 1 };
}

function normalizeContext7Path(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!text) return null;
  if (text.startsWith('docs/context7/')) return text;
  if (text.startsWith('/docs/context7/')) return text.slice(1);
  if (/^(?:https?:|mailto:|#)/i.test(text)) return null;
  return `docs/context7/${text.replace(/^\/+/, '')}`;
}

function readContext7MarkdownLinkTargets(value) {
  return [...String(value ?? '').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map(match => match[1]);
}

function context7SourceMapRouteDocs(route) {
  return unique([
    ...(route?.docs ?? []),
    route?.doc,
  ].filter(Boolean));
}

function readContext7SourcePathList(value) {
  const text = String(value ?? '');
  const codeSpans = [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  const rawPaths = codeSpans.length > 0 ? codeSpans : text.split(',');
  return unique(rawPaths
    .flatMap(part => String(part).split(/\s*,\s*/))
    .map(part => part
      .trim()
      .replace(/^\[(.*?)\]\([^)]+\)$/u, '$1')
      .replace(/[.;]+$/u, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, ''))
    .filter(part => part && !/^(?:read this doc first|then inspect these paths)$/i.test(part)));
}

function findJsonPropertyLine(lines, propertyName) {
  const needle = `"${String(propertyName).replace(/"/g, '\\"')}"`;
  const index = lines.findIndex(line => line.includes(needle));
  return index >= 0 ? index + 1 : 1;
}

function findJsonValueLine(lines, value, occurrence = 0) {
  const text = String(value ?? '').trim();
  if (!text) return 1;
  const needle = JSON.stringify(text);
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(needle)) continue;
    if (seen === occurrence) return index + 1;
    seen += 1;
  }
  const index = lines.findIndex(line => line.includes(needle));
  return index >= 0 ? index + 1 : 1;
}

function context7DocumentNodeName(doc) {
  return doc?.title || path.basename(String(doc?.file ?? 'context7-doc'));
}

function context7DocumentNodeId(doc) {
  return graphNodeId('file', doc.file, context7DocumentNodeName(doc));
}

function context7CategoryNodeId(category) {
  return graphNodeId('variable', category.file, `context7-category:${category.name}`);
}

function context7RetrievalRouteNodeId(route) {
  return graphNodeId('variable', route.file, `context7-retrieval-route:${route.index}`);
}

function context7SourceMapRouteNodeId(route) {
  return graphNodeId('variable', route.file, `context7-source-map-route:${route.line}`);
}

function context7SourcePathTarget(projectRoot, routeFile, sourcePath) {
  const absolutePath = projectRoot ? path.join(projectRoot, sourcePath) : null;
  let isFile = false;
  if (absolutePath) {
    try {
      isFile = fs.statSync(absolutePath).isFile();
    } catch {
      isFile = false;
    }
  }
  if (isFile) {
    return {
      kind: 'file',
      filePath: sourcePath,
      id: graphNodeId('file', sourcePath, sourcePath),
      line: 1,
      language: inferLanguage(sourcePath),
    };
  }
  return {
    kind: 'variable',
    filePath: routeFile,
    id: graphNodeId('variable', routeFile, `context7-source-path:${sourcePath}`),
    line: 1,
    language: 'unknown',
  };
}

function collectTypeScript(projectRoot, sourceFiles) {
  const files = [];
  const classes = [];
  const functions = [];
  const interfaces = [];
  const types = [];
  const variables = [];
  const enums = [];
  const namespaces = [];
  const imports = [];
  const exports = [];
  const parameters = [];
  const collectors = { classes, functions, interfaces, types, variables, enums, namespaces, exports };

  for (const file of sourceFiles) {
    const rel = relative(projectRoot, file);
    const sourceText = readSnapshotFileUtf8(file);
    if (sourceText === null) continue;

    files.push({ file: rel, language: inferLanguage(rel) });
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFile(file),
    );

    const objectLiteralDeclarations = new Map();

    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        imports.push(...readImportDeclaration(projectRoot, file, source, statement));
        continue;
      }

      if (ts.isImportEqualsDeclaration(statement)) {
        imports.push(...readImportEqualsDeclaration(projectRoot, file, source, statement));
        continue;
      }

      if (ts.isExportDeclaration(statement)) {
        exports.push(...readExportDeclaration(projectRoot, file, source, statement));
        const exportObjectSymbols = readExportDeclarationObjectSymbols(source, statement, rel, objectLiteralDeclarations);
        functions.push(...exportObjectSymbols.functions);
        continue;
      }

      if (ts.isExportAssignment(statement)) {
        exports.push(readExportAssignment(source, statement, rel));
        const defaultObjectSymbols = readDefaultExportObjectLiteralSymbols(source, statement, rel);
        variables.push(...defaultObjectSymbols.variables);
        functions.push(...defaultObjectSymbols.functions);
        if (defaultObjectSymbols.functions.length === 0) {
          const defaultIdentifierSymbols = readDefaultExportIdentifierObjectSymbols(
            source,
            statement,
            rel,
            objectLiteralDeclarations,
          );
          functions.push(...defaultIdentifierSymbols.functions);
        }
        continue;
      }

      if (ts.isExpressionStatement(statement)) {
        const commonJsSymbols = readCommonJsExportAssignmentSymbols(source, statement, rel);
        exports.push(...commonJsSymbols.exports);
        variables.push(...commonJsSymbols.variables);
        functions.push(...commonJsSymbols.functions);
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name) {
        const exported = isExportedStatement(statement);
        if (exported) exports.push(...readExportedStatementNames(source, statement, rel));
        const classMembers = readClassMembers(source, statement, rel, statement.name.text);
        classes.push({
          className: statement.name.text,
          file: rel,
          ...readNodeLocation(source, statement),
          docstring: readDocstring(source, statement),
          signature: `class ${statement.name.text}`,
          isExported: exported,
          isDefaultExport: isDefaultExportStatement(statement),
          isAbstract: hasModifier(statement, ts.SyntaxKind.AbstractKeyword),
          decorators: readDecorators(source, statement),
          typeParameters: readTypeParameterList(statement.typeParameters),
          typeParameterReferences: readTypeParameterReferences(statement.typeParameters),
          methods: classMembers.methods,
          properties: classMembers.properties,
          extends: readHeritageNames(statement, ts.SyntaxKind.ExtendsKeyword),
          implements: readHeritageNames(statement, ts.SyntaxKind.ImplementsKeyword),
          instantiates: readNewExpressions(statement),
          typeReferences: readClassTypeReferences(statement),
          valueReferences: readValueReferences(statement),
        });
        continue;
      }

      if (ts.isInterfaceDeclaration(statement)) {
        const exported = isExportedStatement(statement);
        if (exported) exports.push(...readExportedStatementNames(source, statement, rel));
        const members = readInterfaceMembers(source, statement);
        interfaces.push({
          name: statement.name.text,
          file: rel,
          ...readNodeLocation(source, statement),
          docstring: readDocstring(source, statement),
          signature: `interface ${statement.name.text}`,
          isExported: exported,
          isDefaultExport: isDefaultExportStatement(statement),
          typeParameters: readTypeParameterList(statement.typeParameters),
          typeParameterReferences: readTypeParameterReferences(statement.typeParameters),
          methods: members.methods,
          properties: members.properties,
          extends: readHeritageNames(statement, ts.SyntaxKind.ExtendsKeyword),
          typeReferences: readInterfaceTypeReferences(statement),
        });
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement)) {
        const exported = isExportedStatement(statement);
        if (exported) exports.push(...readExportedStatementNames(source, statement, rel));
        const typeParameterNames = readTypeParameterNames(statement.typeParameters);
        const members = readTypeAliasMembers(source, statement);
        types.push({
          name: statement.name.text,
          file: rel,
          ...readNodeLocation(source, statement),
          docstring: readDocstring(source, statement),
          signature: `type ${statement.name.text}`,
          isExported: exported,
          isDefaultExport: isDefaultExportStatement(statement),
          typeParameters: readTypeParameterList(statement.typeParameters),
          typeParameterReferences: readTypeParameterReferences(statement.typeParameters),
          methods: members.methods,
          properties: members.properties,
          typeReferences: readTypeReferenceNames(statement.type, typeParameterNames),
        });
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const exported = isExportedStatement(statement);
        if (exported) exports.push(...readExportedStatementNames(source, statement, rel));
        functions.push(readFunctionLikeSymbol(source, statement, statement.name.text, rel, exported, {
          isDefaultExport: isDefaultExportStatement(statement),
        }));
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        const exported = isExportedStatement(statement);
        if (exported) exports.push(...readExportedStatementNames(source, statement, rel));
        for (const declaration of statement.declarationList.declarations) {
          imports.push(...readCommonJsRequireDeclaration(projectRoot, file, source, declaration));
          registerObjectLiteralDeclaration(statement, declaration, exported, objectLiteralDeclarations);
          const symbols = readVariableDeclarationSymbols(source, statement, declaration, rel, exported);
          variables.push(...symbols.variables);
          functions.push(...symbols.functions);
          classes.push(...symbols.classes);
        }
        continue;
      }

      if (ts.isEnumDeclaration(statement)) {
        const exported = isExportedStatement(statement);
        if (exported) exports.push(...readExportedStatementNames(source, statement, rel));
        enums.push({
          name: statement.name.text,
          file: rel,
          ...readNodeLocation(source, statement),
          docstring: readDocstring(source, statement),
          signature: `enum ${statement.name.text}`,
          isExported: exported,
          isDefaultExport: isDefaultExportStatement(statement),
          members: statement.members.map(member => ({
            name: readPropertyName(member.name),
            ...readNodeLocation(source, member),
            docstring: readDocstring(source, member),
            signature: readEnumMemberSignature(source, member),
          })).filter(member => member.name),
        });
        continue;
      }

      if (ts.isModuleDeclaration(statement)) {
        const exported = isExportedStatement(statement);
        if (exported) exports.push(...readExportedStatementNames(source, statement, rel));
        const namespaceName = readReferenceName(statement.name);
        namespaces.push(readNamespace(source, statement, rel, exported, namespaceName));
        collectNamespaceMembers(source, statement, rel, namespaceName, collectors);
      }
    }
  }

  const flattenedFunctions = flattenFunctionSymbols(functions);
  const localDeclarations = collectLocalDeclarations(flattenedFunctions, classes);
  classes.push(...localDeclarations.classes);
  interfaces.push(...localDeclarations.interfaces);
  types.push(...localDeclarations.types);
  enums.push(...localDeclarations.enums);

  return {
    files,
    classes,
    functions: mergeFunctionOverloads(flattenedFunctions),
    interfaces,
    types,
    variables,
    enums,
    namespaces,
    imports,
    exports,
    parameters,
  };
}

function collectNamespaceMembers(source, namespaceNode, file, namespaceName, collectors) {
  if (!namespaceName || !namespaceNode.body || !ts.isModuleBlock(namespaceNode.body)) return;

  for (const statement of namespaceNode.body.statements) {
    if (ts.isExportDeclaration(statement)) {
      collectors.exports.push(...readExportDeclarationFromFile(source, statement, file));
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const exported = isExportedStatement(statement);
      const classMembers = readClassMembers(source, statement, file, `${namespaceName}::${statement.name.text}`);
      collectors.classes.push({
        className: statement.name.text,
        qualifiedName: `${namespaceName}::${statement.name.text}`,
        file,
        ...readNodeLocation(source, statement),
        docstring: readDocstring(source, statement),
        signature: `class ${statement.name.text}`,
        isExported: exported,
        isAbstract: hasModifier(statement, ts.SyntaxKind.AbstractKeyword),
        typeParameters: readTypeParameterList(statement.typeParameters),
        typeParameterReferences: readTypeParameterReferences(statement.typeParameters),
        methods: classMembers.methods,
        properties: classMembers.properties,
        extends: readHeritageNames(statement, ts.SyntaxKind.ExtendsKeyword),
        implements: readHeritageNames(statement, ts.SyntaxKind.ImplementsKeyword),
        instantiates: readNewExpressions(statement),
        typeReferences: readClassTypeReferences(statement),
      });
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      const exported = isExportedStatement(statement);
      const members = readInterfaceMembers(source, statement);
      collectors.interfaces.push({
        name: statement.name.text,
        qualifiedName: `${namespaceName}::${statement.name.text}`,
        file,
        ...readNodeLocation(source, statement),
        docstring: readDocstring(source, statement),
        signature: `interface ${statement.name.text}`,
        isExported: exported,
        isDefaultExport: isDefaultExportStatement(statement),
        typeParameters: readTypeParameterList(statement.typeParameters),
        typeParameterReferences: readTypeParameterReferences(statement.typeParameters),
        methods: members.methods,
        properties: members.properties,
        extends: readHeritageNames(statement, ts.SyntaxKind.ExtendsKeyword),
        typeReferences: readInterfaceTypeReferences(statement),
      });
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      const exported = isExportedStatement(statement);
      const typeParameterNames = readTypeParameterNames(statement.typeParameters);
      const members = readTypeAliasMembers(source, statement);
      collectors.types.push({
        name: statement.name.text,
        qualifiedName: `${namespaceName}::${statement.name.text}`,
        file,
        ...readNodeLocation(source, statement),
        docstring: readDocstring(source, statement),
        signature: `type ${statement.name.text}`,
        isExported: exported,
        isDefaultExport: isDefaultExportStatement(statement),
        typeParameters: readTypeParameterList(statement.typeParameters),
        typeParameterReferences: readTypeParameterReferences(statement.typeParameters),
        methods: members.methods,
        properties: members.properties,
        typeReferences: readTypeReferenceNames(statement.type, typeParameterNames),
      });
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const exported = isExportedStatement(statement);
      collectors.functions.push(readFunctionLikeSymbol(source, statement, statement.name.text, file, exported, {
        qualifiedName: `${namespaceName}::${statement.name.text}`,
      }));
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = isExportedStatement(statement);
      for (const declaration of statement.declarationList.declarations) {
        const symbols = readVariableDeclarationSymbols(source, statement, declaration, file, exported, namespaceName);
        collectors.variables.push(...symbols.variables);
        collectors.functions.push(...symbols.functions);
        collectors.classes.push(...symbols.classes);
      }
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      const exported = isExportedStatement(statement);
      collectors.enums.push({
        name: statement.name.text,
        qualifiedName: `${namespaceName}::${statement.name.text}`,
        file,
        ...readNodeLocation(source, statement),
        docstring: readDocstring(source, statement),
        signature: `enum ${statement.name.text}`,
        isExported: exported,
        isDefaultExport: isDefaultExportStatement(statement),
        members: statement.members.map(member => ({
          name: readPropertyName(member.name),
          ...readNodeLocation(source, member),
          docstring: readDocstring(source, member),
          signature: readEnumMemberSignature(source, member),
        })).filter(member => member.name),
      });
      continue;
    }

    if (ts.isModuleDeclaration(statement)) {
      const exported = isExportedStatement(statement);
      const nestedName = `${namespaceName}.${readReferenceName(statement.name)}`;
      collectors.namespaces.push(readNamespace(source, statement, file, exported, nestedName));
      collectNamespaceMembers(source, statement, file, nestedName, collectors);
    }
  }
}

function readClassMembers(
  source,
  classNode,
  file = null,
  classQualifiedName = readClassName(classNode),
  classTypeParameterNames = readTypeParameterNames(classNode.typeParameters),
) {
  const methods = [];
  const properties = [];
  for (const member of classNode.members) {
    if (ts.isConstructorDeclaration(member)) {
      methods.push({
        name: 'constructor',
        ...readNodeLocation(source, member),
        docstring: readDocstring(source, member),
        signature: readCallableSignature(source, member),
        isAsync: false,
        isStatic: false,
        isAbstract: false,
        isOverride: false,
        visibility: readVisibility(member),
        decorators: readDecorators(source, member),
        typeParameters: readTypeParameterList(member.typeParameters),
        typeParameterReferences: readTypeParameterReferences(member.typeParameters, classTypeParameterNames),
        typeReferences: readCallableTypeReferences(member, classTypeParameterNames),
        parameters: readParameters(source, member, classTypeParameterNames),
        valueReferences: readValueReferences(member),
        calls: readCallExpressions(member),
        hardRuleImplementationCalls: readHardRuleImplementationCalls(member),
        supabaseSelects: readSupabaseSelectCalls(member),
        supabaseIncrementalPredicates: readSupabaseIncrementalPredicateCalls(member),
        supabaseStorageBuckets: readSupabaseStorageBucketCalls(member),
        supabaseFunctionInvokes: readSupabaseFunctionInvokeCalls(member),
        supabaseRpcCalls: readSupabaseRpcCalls(member),
        supabaseTableWrites: readSupabaseTableWriteCalls(member),
        supabaseRealtimeChannels: readSupabaseRealtimeChannelCalls(member),
        supabaseRealtimePostgresChanges: readSupabaseRealtimePostgresChangeCalls(member),
        supabaseRealtimeLifecycleActions: readSupabaseRealtimeLifecycleCalls(member),
        supabaseRealtimeStatuses: readSupabaseRealtimeStatusReferences(member),
        instantiates: readNewExpressions(member),
        jsxReferences: readJsxReferences(member),
        localDeclarations: readLocalDeclarationSymbols(source, member, file, `${classQualifiedName}::constructor`, 'method'),
      });
      for (const parameter of member.parameters) {
        if (!isParameterProperty(parameter)) continue;
        const name = readBindingName(parameter.name);
        if (!name) continue;
        properties.push({
          name,
          ...readNodeLocation(source, parameter),
          docstring: readDocstring(source, parameter),
          signature: readParameterPropertySignature(source, parameter),
          isStatic: false,
          isAbstract: false,
          visibility: readVisibility(parameter),
          returns: readTypeName(parameter.type, classTypeParameterNames),
          typeReferences: readTypeReferenceNames(parameter.type, classTypeParameterNames),
          calls: [],
          instantiates: [],
        });
      }
      continue;
    }

    if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      const name = readMemberName(member);
      if (!name) continue;
      const memberTypeParameterNames = mergeNameSets(classTypeParameterNames, readTypeParameterNames(member.typeParameters));
      methods.push({
        name,
        ...readNodeLocation(source, member),
        docstring: readDocstring(source, member),
        signature: readCallableSignature(source, member),
        isAsync: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
        isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        isAbstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
        isOverride: hasModifier(member, ts.SyntaxKind.OverrideKeyword),
        visibility: readVisibility(member),
        decorators: readDecorators(source, member),
        returns: readTypeName(member.type, memberTypeParameterNames),
        typeParameters: readTypeParameterList(member.typeParameters),
        typeParameterReferences: readTypeParameterReferences(member.typeParameters, classTypeParameterNames),
        typeReferences: readCallableTypeReferences(member, classTypeParameterNames),
        parameters: readParameters(source, member, memberTypeParameterNames),
        valueReferences: readValueReferences(member),
        calls: readCallExpressions(member),
        hardRuleImplementationCalls: readHardRuleImplementationCalls(member),
        supabaseSelects: readSupabaseSelectCalls(member),
        supabaseIncrementalPredicates: readSupabaseIncrementalPredicateCalls(member),
        supabaseStorageBuckets: readSupabaseStorageBucketCalls(member),
        supabaseFunctionInvokes: readSupabaseFunctionInvokeCalls(member),
        supabaseRpcCalls: readSupabaseRpcCalls(member),
        supabaseTableWrites: readSupabaseTableWriteCalls(member),
        supabaseRealtimeChannels: readSupabaseRealtimeChannelCalls(member),
        supabaseRealtimePostgresChanges: readSupabaseRealtimePostgresChangeCalls(member),
        supabaseRealtimeLifecycleActions: readSupabaseRealtimeLifecycleCalls(member),
        supabaseRealtimeStatuses: readSupabaseRealtimeStatusReferences(member),
        instantiates: readNewExpressions(member),
        jsxReferences: readJsxReferences(member),
        localDeclarations: readLocalDeclarationSymbols(source, member, file, `${classQualifiedName}::${name}`, 'method'),
      });
      continue;
    }

    if (ts.isPropertyDeclaration(member)) {
      const name = readMemberName(member);
      if (!name) continue;
      const initializer = member.initializer;
      const functionInitializer = readClassFieldFunctionInitializer(initializer);
      if (functionInitializer) {
        const functionTypeParameterNames = mergeNameSets(classTypeParameterNames, readTypeParameterNames(functionInitializer.typeParameters));
        methods.push({
          name,
          ...readNodeLocation(source, member),
          docstring: readDocstring(source, member),
          signature: readVariableFunctionSignature(source, name, functionInitializer, member.type),
          isAsync: hasModifier(functionInitializer, ts.SyntaxKind.AsyncKeyword),
          isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword),
          isAbstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
          isOverride: hasModifier(member, ts.SyntaxKind.OverrideKeyword),
          visibility: readVisibility(member),
          decorators: readDecorators(source, member),
          returns: readTypeName(member.type, classTypeParameterNames) ?? readCallableReturnTypeName(functionInitializer, functionTypeParameterNames),
          typeParameters: readTypeParameterList(functionInitializer.typeParameters),
          typeParameterReferences: readTypeParameterReferences(functionInitializer.typeParameters, classTypeParameterNames),
          parameters: readParameters(source, functionInitializer, functionTypeParameterNames),
          typeReferences: unique([
            ...readTypeReferenceNames(member.type, classTypeParameterNames),
            ...readCallableTypeReferences(functionInitializer, classTypeParameterNames),
            ...readInitializerTypeReferenceNames(initializer),
          ]),
          valueReferences: readValueReferences(initializer),
          calls: readCallExpressions(initializer),
          hardRuleImplementationCalls: readHardRuleImplementationCalls(initializer),
          supabaseSelects: readSupabaseSelectCalls(initializer),
          supabaseIncrementalPredicates: readSupabaseIncrementalPredicateCalls(initializer),
          supabaseStorageBuckets: readSupabaseStorageBucketCalls(initializer),
          supabaseFunctionInvokes: readSupabaseFunctionInvokeCalls(initializer),
          supabaseRpcCalls: readSupabaseRpcCalls(initializer),
          supabaseTableWrites: readSupabaseTableWriteCalls(initializer),
          supabaseRealtimeChannels: readSupabaseRealtimeChannelCalls(initializer),
          supabaseRealtimePostgresChanges: readSupabaseRealtimePostgresChangeCalls(initializer),
          supabaseRealtimeLifecycleActions: readSupabaseRealtimeLifecycleCalls(initializer),
          supabaseRealtimeStatuses: readSupabaseRealtimeStatusReferences(initializer),
          instantiates: readNewExpressions(initializer),
          jsxReferences: readJsxReferences(initializer),
          hasBody: true,
          localDeclarations: readLocalDeclarationSymbols(source, functionInitializer, file, `${classQualifiedName}::${name}`, 'method'),
        });
        continue;
      }
      properties.push({
        name,
        ...readNodeLocation(source, member),
        docstring: readDocstring(source, member),
        signature: readPropertySignature(source, member),
        isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        isAbstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
        isOverride: hasModifier(member, ts.SyntaxKind.OverrideKeyword),
        visibility: readVisibility(member),
        decorators: readDecorators(source, member),
        returns: readTypeName(member.type, classTypeParameterNames),
        typeReferences: unique([
          ...readTypeReferenceNames(member.type, classTypeParameterNames),
          ...readInitializerTypeReferenceNames(member.initializer),
        ]),
        valueReferences: readValueReferences(member.initializer),
        calls: member.initializer ? readCallExpressions(member.initializer) : [],
        hardRuleImplementationCalls: member.initializer ? readHardRuleImplementationCalls(member.initializer) : [],
        supabaseSelects: member.initializer ? readSupabaseSelectCalls(member.initializer) : [],
        supabaseIncrementalPredicates: member.initializer ? readSupabaseIncrementalPredicateCalls(member.initializer) : [],
        supabaseStorageBuckets: member.initializer ? readSupabaseStorageBucketCalls(member.initializer) : [],
        supabaseFunctionInvokes: member.initializer ? readSupabaseFunctionInvokeCalls(member.initializer) : [],
        supabaseRpcCalls: member.initializer ? readSupabaseRpcCalls(member.initializer) : [],
        supabaseTableWrites: member.initializer ? readSupabaseTableWriteCalls(member.initializer) : [],
        supabaseRealtimeChannels: member.initializer ? readSupabaseRealtimeChannelCalls(member.initializer) : [],
        supabaseRealtimePostgresChanges: member.initializer ? readSupabaseRealtimePostgresChangeCalls(member.initializer) : [],
        supabaseRealtimeLifecycleActions: member.initializer ? readSupabaseRealtimeLifecycleCalls(member.initializer) : [],
        supabaseRealtimeStatuses: member.initializer ? readSupabaseRealtimeStatusReferences(member.initializer) : [],
        instantiates: member.initializer ? readNewExpressions(member.initializer) : [],
        jsxReferences: readJsxReferences(member.initializer),
      });
    }
  }
  return { methods, properties };
}

function readClassFieldFunctionInitializer(initializer) {
  const expression = unwrapParenthesizedExpression(initializer);
  if (!expression) return null;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (!ts.isCallExpression(expression)) return null;

  for (const argument of expression.arguments) {
    const unwrappedArgument = unwrapParenthesizedExpression(argument);
    if (unwrappedArgument && (ts.isArrowFunction(unwrappedArgument) || ts.isFunctionExpression(unwrappedArgument))) {
      return unwrappedArgument;
    }
  }
  return null;
}

function unwrapParenthesizedExpression(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current ?? null;
}

function unwrapParenthesizedType(node) {
  let current = node;
  while (current && ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current ?? null;
}

function readFunctionTypeFromPropertySignature(member) {
  const type = unwrapParenthesizedType(member.type);
  return type && ts.isFunctionTypeNode(type) ? type : null;
}

function readInterfaceMembers(source, interfaceNode) {
  return readTypeElementMembers(source, interfaceNode.members, readTypeParameterNames(interfaceNode.typeParameters));
}

function readTypeAliasMembers(source, typeAliasNode) {
  const ignoredTypeNames = readTypeParameterNames(typeAliasNode.typeParameters);
  const typeLiteralMembers = readTypeLiteralMembers(source, typeAliasNode.type, ignoredTypeNames);
  return mergeMemberGroups([
    typeLiteralMembers,
    {
      methods: readTupleContractMethods(source, typeAliasNode.type),
      properties: [],
    },
  ]);
}

function readTypeLiteralMembers(source, typeNode, ignoredTypeNames = new Set()) {
  const typeLiterals = [];
  collectTopLevelTypeLiterals(typeNode, typeLiterals);
  return mergeMemberGroups(typeLiterals.map(typeLiteral => readTypeElementMembers(source, typeLiteral.members, ignoredTypeNames)));
}

function readTupleContractMethods(source, typeNode) {
  const tupleTypes = [];
  collectTupleTypeNodes(typeNode, tupleTypes);
  const methods = [];
  const seenNames = new Set();

  for (const tupleType of tupleTypes) {
    for (const element of tupleType.elements ?? []) {
      const contractType = unwrapTupleElementType(element);
      if (!contractType || !ts.isTypeReferenceNode(contractType)) continue;
      for (const typeArgument of contractType.typeArguments ?? []) {
        const name = readStringLiteralTypeName(typeArgument);
        if (!name || !isValidTypeScriptIdentifierName(name) || seenNames.has(name)) continue;
        seenNames.add(name);
        methods.push({
          name,
          ...readNodeLocation(source, contractType),
          signature: compactNodeText(source, contractType, 120),
          typeParameterReferences: [],
          typeReferences: [],
          parameters: [],
          calls: [],
          instantiates: [],
        });
      }
    }
  }

  return methods;
}

function collectTupleTypeNodes(typeNode, output, depth = 0) {
  const node = unwrapParenthesizedType(typeNode);
  if (!node || depth > 6) return;
  if (ts.isTupleTypeNode(node)) output.push(node);
  ts.forEachChild(node, child => collectTupleTypeNodes(child, output, depth + 1));
}

function unwrapTupleElementType(typeNode) {
  let node = unwrapParenthesizedType(typeNode);
  while (node && (ts.isNamedTupleMember(node) || ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node))) {
    node = unwrapParenthesizedType(node.type);
  }
  return node;
}

function readStringLiteralTypeName(typeNode) {
  if (!typeNode || !ts.isLiteralTypeNode(typeNode)) return null;
  return ts.isStringLiteral(typeNode.literal) ? typeNode.literal.text : null;
}

function isValidTypeScriptIdentifierName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function compactNodeText(source, node, maxLength) {
  const text = node.getText(source).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function collectTopLevelTypeLiterals(typeNode, output) {
  const node = unwrapParenthesizedType(typeNode);
  if (!node) return;
  if (ts.isTypeLiteralNode(node)) {
    output.push(node);
    return;
  }
  if (ts.isIntersectionTypeNode(node)) {
    for (const childType of node.types) collectTopLevelTypeLiterals(childType, output);
  }
}

function mergeMemberGroups(groups) {
  return {
    methods: groups.flatMap(group => group.methods),
    properties: groups.flatMap(group => group.properties),
  };
}

function readTypeElementMembers(source, membersNodeArray, ignoredTypeNames = new Set()) {
  const methods = [];
  const properties = [];
  for (const member of membersNodeArray ?? []) {
    if (ts.isMethodSignature(member)) {
      const name = readMemberName(member);
      if (!name) continue;
      const memberTypeParameterNames = mergeNameSets(ignoredTypeNames, readTypeParameterNames(member.typeParameters));
      methods.push({
        name,
        ...readNodeLocation(source, member),
        docstring: readDocstring(source, member),
        signature: readCallableSignature(source, member),
        returns: readTypeName(member.type, memberTypeParameterNames),
        typeParameters: readTypeParameterList(member.typeParameters),
        typeParameterReferences: readTypeParameterReferences(member.typeParameters, ignoredTypeNames),
        typeReferences: readCallableTypeReferences(member, memberTypeParameterNames),
        parameters: readParameters(source, member, memberTypeParameterNames),
        calls: [],
        instantiates: [],
      });
      continue;
    }

    if (ts.isCallSignatureDeclaration(member) || ts.isConstructSignatureDeclaration(member)) {
      const name = ts.isConstructSignatureDeclaration(member) ? 'constructor' : 'call';
      const memberTypeParameterNames = mergeNameSets(ignoredTypeNames, readTypeParameterNames(member.typeParameters));
      methods.push({
        name,
        ...readNodeLocation(source, member),
        docstring: readDocstring(source, member),
        signature: readCallableSignature(source, member),
        returns: readTypeName(member.type, memberTypeParameterNames),
        typeParameters: readTypeParameterList(member.typeParameters),
        typeParameterReferences: readTypeParameterReferences(member.typeParameters, ignoredTypeNames),
        typeReferences: readCallableTypeReferences(member, memberTypeParameterNames),
        parameters: readParameters(source, member, memberTypeParameterNames),
        calls: [],
        instantiates: [],
      });
      continue;
    }

    if (ts.isIndexSignatureDeclaration(member)) {
      properties.push({
        name: readIndexSignatureName(source, member),
        ...readNodeLocation(source, member),
        docstring: readDocstring(source, member),
        signature: member.getText(source),
        returns: readTypeName(member.type, ignoredTypeNames),
        typeReferences: unique([
          ...readTypeReferenceNames(member.type, ignoredTypeNames),
          ...member.parameters.flatMap(parameter => readTypeReferenceNames(parameter.type, ignoredTypeNames)),
        ]),
        parameters: readParameters(source, member, ignoredTypeNames),
        calls: [],
        instantiates: [],
      });
      continue;
    }

    if (ts.isPropertySignature(member)) {
      const name = readMemberName(member);
      if (!name) continue;
      const functionType = readFunctionTypeFromPropertySignature(member);
      if (functionType) {
        const memberTypeParameterNames = mergeNameSets(ignoredTypeNames, readTypeParameterNames(functionType.typeParameters));
        methods.push({
          name,
          ...readNodeLocation(source, member),
          docstring: readDocstring(source, member),
          signature: readPropertySignature(source, member),
          returns: readCallableReturnTypeName(functionType, memberTypeParameterNames),
          typeParameters: readTypeParameterList(functionType.typeParameters),
          typeParameterReferences: readTypeParameterReferences(functionType.typeParameters, ignoredTypeNames),
          typeReferences: readCallableTypeReferences(functionType, memberTypeParameterNames),
          parameters: readParameters(source, functionType, memberTypeParameterNames),
          calls: [],
          instantiates: [],
        });
        continue;
      }
      properties.push({
        name,
        ...readNodeLocation(source, member),
        docstring: readDocstring(source, member),
        signature: readPropertySignature(source, member),
        returns: readTypeName(member.type, ignoredTypeNames),
        typeReferences: readTypeReferenceNames(member.type, ignoredTypeNames),
        calls: [],
        instantiates: [],
      });
    }
  }
  return { methods, properties };
}

function readImportDeclaration(projectRoot, file, source, statement) {
  const moduleSpecifier = ts.isStringLiteralLike(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : null;
  if (!moduleSpecifier) return [];

  const target = resolveImportPath(projectRoot, file, moduleSpecifier);
  const imports = [];
  const clause = statement.importClause;
  if (!clause) {
    return [{ file: relative(projectRoot, file), name: moduleSpecifier, target, line: readLine(source, statement) }];
  }

  if (clause.name) {
    imports.push({
      file: relative(projectRoot, file),
      name: clause.name.text,
      importedName: 'default',
      target,
      line: readLine(source, statement),
      isTypeOnly: clause.isTypeOnly || null,
    });
  }

  const namedBindings = clause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    imports.push({
      file: relative(projectRoot, file),
      name: namedBindings.name.text,
      importedName: '*',
      target,
      line: readLine(source, statement),
      isTypeOnly: clause.isTypeOnly || null,
    });
  }

  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      imports.push({
        file: relative(projectRoot, file),
        name: element.name.text,
        importedName: element.propertyName?.text ?? element.name.text,
        target,
        line: readLine(source, element),
        isTypeOnly: (clause.isTypeOnly || element.isTypeOnly) || null,
      });
    }
  }

  return imports;
}

function readImportEqualsDeclaration(projectRoot, file, source, statement) {
  if (!ts.isExternalModuleReference(statement.moduleReference)) return [];
  const expression = statement.moduleReference.expression;
  if (!ts.isStringLiteralLike(expression)) return [];
  return [{
    file: relative(projectRoot, file),
    name: statement.name.text,
    importedName: 'export=',
    target: resolveImportPath(projectRoot, file, expression.text),
    line: readLine(source, statement),
    isTypeOnly: statement.isTypeOnly || null,
  }];
}

function readCommonJsRequireDeclaration(projectRoot, file, source, declaration) {
  const specifier = readCommonJsRequireSpecifier(declaration.initializer);
  if (!specifier) return [];

  const rel = relative(projectRoot, file);
  const target = resolveImportPath(projectRoot, file, specifier);
  const base = {
    file: rel,
    target,
    line: readLine(source, declaration),
    relation: 'commonjs-require',
  };

  if (ts.isIdentifier(declaration.name)) {
    return [{
      ...base,
      name: declaration.name.text,
      importedName: 'module.exports',
    }];
  }

  if (!ts.isObjectBindingPattern(declaration.name)) return [];

  return declaration.name.elements.flatMap(element => {
    if (!ts.isIdentifier(element.name) || element.dotDotDotToken) return [];
    const importedName = element.propertyName
      ? readPropertyName(element.propertyName)
      : element.name.text;
    if (!importedName) return [];

    return [{
      ...base,
      name: element.name.text,
      importedName,
    }];
  });
}

function readCommonJsRequireSpecifier(initializer) {
  if (!initializer || !ts.isCallExpression(initializer)) return null;
  if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require') return null;
  const firstArg = initializer.arguments[0];
  return firstArg && ts.isStringLiteralLike(firstArg) ? firstArg.text : null;
}

function readExportDeclaration(projectRoot, file, source, statement) {
  const rel = relative(projectRoot, file);
  return readExportDeclarationFromFile(source, statement, rel, projectRoot, file);
}

function readExportDeclarationFromFile(source, statement, rel, projectRoot = null, absoluteFile = null) {
  const moduleSpecifier = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : null;
  const target = moduleSpecifier && projectRoot && absoluteFile
    ? resolveImportPath(projectRoot, absoluteFile, moduleSpecifier)
    : rel;
  const base = {
    file: rel,
    target,
    line: readLine(source, statement),
    relation: moduleSpecifier ? 're-export' : 'export',
    isTypeOnly: statement.isTypeOnly || null,
  };
  const exportClause = statement.exportClause;

  if (!exportClause) {
    return [{
      ...base,
      name: moduleSpecifier ? '*' : '(exports)',
      exportName: '*',
    }];
  }

  if (ts.isNamespaceExport(exportClause)) {
    return [{
      ...base,
      name: exportClause.name.text,
      exportName: exportClause.name.text,
    }];
  }

  return exportClause.elements.map(element => ({
    ...base,
    name: element.propertyName?.text ?? element.name.text,
    exportName: element.name.text,
  }));
}

function readExportDeclarationObjectSymbols(source, statement, file, objectLiteralDeclarations) {
  if (statement.moduleSpecifier) return { functions: [] };
  const exportClause = statement.exportClause;
  if (!exportClause || !ts.isNamedExports(exportClause)) return { functions: [] };

  return {
    functions: exportClause.elements.flatMap(element => {
      const localName = element.propertyName?.text ?? element.name.text;
      const declaration = objectLiteralDeclarations.get(localName);
      if (!declaration || declaration.exported) return [];
      return readObjectLiteralFunctionSymbols(
        source,
        localName,
        localName,
        declaration.objectLiteral,
        file,
        true,
        declaration.isConst,
      );
    }),
  };
}

function readExportAssignment(source, statement, file) {
  const name = readReferenceName(statement.expression) ?? 'default';
  return {
    file,
    name,
    exportName: statement.isExportEquals ? 'export=' : 'default',
    target: file,
    line: readLine(source, statement),
    relation: statement.isExportEquals ? 'export-equals' : 'export',
  };
}

function registerObjectLiteralDeclaration(statement, declaration, exported, objectLiteralDeclarations) {
  if (!ts.isIdentifier(declaration.name)) return;
  const objectLiteral = findObjectLiteralFunctionContainer(declaration.initializer);
  if (!objectLiteral) return;
  objectLiteralDeclarations.set(declaration.name.text, {
    initializer: declaration.initializer,
    objectLiteral,
    exported,
    isConst: Boolean(statement.declarationList.flags & ts.NodeFlags.Const),
  });
}

function readDefaultExportObjectLiteralSymbols(source, statement, file) {
  const objectLiteral = readReturnedObjectLiteral(statement.expression);
  if (!objectLiteral) return { variables: [], functions: [] };

  const variable = {
    name: 'default',
    file,
    ...readNodeLocation(source, statement),
    docstring: readDocstring(source, statement),
    signature: 'const default',
    isExported: true,
    isConst: true,
    returns: null,
    typeReferences: readInitializerTypeReferenceNames(statement.expression),
    valueReferences: readValueReferences(statement.expression),
    calls: readCallExpressions(statement.expression),
    instantiates: readNewExpressions(statement.expression),
    jsxReferences: readJsxReferences(statement.expression),
  };

  return {
    variables: [variable],
    functions: readObjectLiteralFunctionSymbols(source, 'default', 'default', objectLiteral, file, true, true),
  };
}

function readDefaultExportIdentifierObjectSymbols(source, statement, file, objectLiteralDeclarations) {
  const name = readReferenceName(statement.expression);
  if (!name) return { functions: [] };
  const declaration = objectLiteralDeclarations.get(name);
  if (!declaration) return { functions: [] };

  return {
    functions: readObjectLiteralFunctionSymbols(
      source,
      name,
      name,
      declaration.objectLiteral,
      file,
      true,
      declaration.isConst,
    ),
  };
}

function readCommonJsExportAssignmentSymbols(source, statement, file) {
  const empty = { exports: [], variables: [], functions: [] };
  const expression = statement.expression;
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return empty;
  }

  if (isModuleExportsAccess(expression.left)) {
    const objectLiteral = readReturnedObjectLiteral(expression.right);
    if (!objectLiteral) return empty;
    const ownerName = 'module.exports';
    const variable = {
      name: ownerName,
      file,
      ...readNodeLocation(source, statement),
      docstring: readDocstring(source, statement),
      signature: `const ${ownerName}`,
      isExported: true,
      isConst: true,
      returns: null,
      typeReferences: readInitializerTypeReferenceNames(expression.right),
      valueReferences: readValueReferences(expression.right),
      calls: readCallExpressions(expression.right),
      instantiates: readNewExpressions(expression.right),
      jsxReferences: readJsxReferences(expression.right),
    };
    const functions = readObjectLiteralFunctionSymbols(source, ownerName, ownerName, objectLiteral, file, true, true);
    const exports = objectLiteral.properties
      .map(property => readCommonJsObjectExport(source, property, file, ownerName))
      .filter(Boolean);
    return { exports, variables: [variable], functions };
  }

  const memberName = readCommonJsMemberExportName(expression.left);
  if (!memberName) return empty;
  const initializer = expression.right;
  const exports = [{
    file,
    name: memberName,
    targetName: memberName,
    exportName: memberName,
    target: file,
    line: readLine(source, statement),
    relation: 'commonjs-export',
  }];
  const functions = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? [readFunctionLikeSymbol(source, initializer, memberName, file, true, {
      ...readNodeLocation(source, statement),
      docstring: readDocstring(source, statement) ?? readDocstring(source, initializer),
      signature: readVariableFunctionSignature(source, memberName, initializer, undefined),
      returns: readCallableReturnTypeName(initializer, readTypeParameterNames(initializer.typeParameters)),
    })]
    : [];
  return { exports, variables: [], functions };
}

function readCommonJsObjectExport(source, property, file, ownerName) {
  const exportName = readCommonJsObjectPropertyName(property);
  const symbolName = readCommonJsObjectExportSymbolName(property, ownerName);
  if (!exportName || !symbolName) return null;
  return {
    file,
    name: symbolName,
    targetName: symbolName,
    exportName,
    target: file,
    line: readLine(source, property),
    relation: 'commonjs-export',
  };
}

function readCommonJsObjectPropertyName(property) {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if ('name' in property && property.name) return readPropertyName(property.name);
  return null;
}

function readCommonJsObjectExportSymbolName(property, ownerName) {
  const exportName = readCommonJsObjectPropertyName(property);
  if (!exportName) return null;
  if (ts.isMethodDeclaration(property)) return `${ownerName}::${exportName}`;
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (ts.isPropertyAssignment(property)) {
    if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) {
      return `${ownerName}::${exportName}`;
    }
    return readReferenceName(property.initializer);
  }
  return null;
}

function readCommonJsMemberExportName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === 'exports') return node.name.text;
    if (isModuleExportsAccess(node.expression)) return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === 'exports') {
      return readStaticElementAccessName(node.argumentExpression);
    }
    if (isModuleExportsAccess(node.expression)) {
      return readStaticElementAccessName(node.argumentExpression);
    }
  }
  return null;
}

function isModuleExportsAccess(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.expression)
      && node.expression.text === 'module'
      && node.name.text === 'exports';
  }
  if (ts.isElementAccessExpression(node)) {
    return ts.isIdentifier(node.expression)
      && node.expression.text === 'module'
      && readStaticElementAccessName(node.argumentExpression) === 'exports';
  }
  return false;
}

function readStaticElementAccessName(argument) {
  if (!argument) return null;
  if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) return argument.text;
  return null;
}

function isExportedStatement(statement) {
  return Boolean(ts.canHaveModifiers(statement)
    && (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function isDefaultExportStatement(statement) {
  return Boolean(ts.canHaveModifiers(statement)
    && (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function readExportedStatementNames(source, statement, file) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .flatMap(declaration => readBindingNames(declaration.name))
      .map(name => ({
        file,
        name,
        exportName: isDefaultExportStatement(statement) ? 'default' : name,
        target: file,
        line: readLine(source, statement),
        relation: 'export',
      }));
  }

  if ('name' in statement && statement.name) {
    const name = readPropertyName(statement.name);
    return name
      ? [{
        file,
        name,
        exportName: isDefaultExportStatement(statement) ? 'default' : name,
        target: file,
        line: readLine(source, statement),
        relation: 'export',
      }]
      : [];
  }

  return [];
}

function readBindingName(name) {
  if (ts.isIdentifier(name)) return name.text;
  return null;
}

function readBindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name)) {
    return name.elements.flatMap(element => readBindingNames(element.name));
  }
  if (ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => {
      if (ts.isOmittedExpression(element)) return [];
      return readBindingNames(element.name);
    });
  }
  return [];
}

function readVariableDeclarationSymbols(source, statement, declaration, file, exported, namespaceName = null) {
  const names = readBindingNames(declaration.name);
  const variables = [];
  const functions = [];
  const classes = [];
  const initializer = declaration.initializer;
  const isFunctionValue = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
  const isClassValue = initializer && ts.isClassExpression(initializer);
  const isConst = Boolean(statement.declarationList.flags & ts.NodeFlags.Const);
  const initializerTypeParameterNames = readTypeParameterNames(initializer?.typeParameters);

  for (const name of names) {
    const qualifiedName = namespaceName ? `${namespaceName}::${name}` : undefined;
    const base = {
      name,
      file,
      ...(qualifiedName ? { qualifiedName } : {}),
      ...readNodeLocation(source, declaration),
      docstring: readDocstring(source, declaration) ?? readDocstring(source, statement),
      signature: readVariableSignature(source, statement, declaration, name),
      isExported: exported,
      isConst,
      returns: readTypeName(declaration.type, initializerTypeParameterNames) ?? readCallableReturnTypeName(initializer, initializerTypeParameterNames),
      typeReferences: unique([
        ...readTypeReferenceNames(declaration.type, initializerTypeParameterNames),
        ...readCallableTypeReferences(initializer),
        ...readInitializerTypeReferenceNames(initializer),
      ]),
      valueReferences: readValueReferences(initializer),
      calls: initializer ? readCallExpressions(initializer) : [],
      supabaseSelects: initializer ? readSupabaseSelectCalls(initializer) : [],
      supabaseIncrementalPredicates: initializer ? readSupabaseIncrementalPredicateCalls(initializer) : [],
      supabaseStorageBuckets: initializer ? readSupabaseStorageBucketCalls(initializer) : [],
      supabaseFunctionInvokes: initializer ? readSupabaseFunctionInvokeCalls(initializer) : [],
      supabaseRpcCalls: initializer ? readSupabaseRpcCalls(initializer) : [],
      supabaseTableWrites: initializer ? readSupabaseTableWriteCalls(initializer) : [],
      supabaseRealtimeChannels: initializer ? readSupabaseRealtimeChannelCalls(initializer) : [],
      supabaseRealtimePostgresChanges: initializer ? readSupabaseRealtimePostgresChangeCalls(initializer) : [],
      supabaseRealtimeLifecycleActions: initializer ? readSupabaseRealtimeLifecycleCalls(initializer) : [],
      supabaseRealtimeStatuses: initializer ? readSupabaseRealtimeStatusReferences(initializer) : [],
      instantiates: initializer ? readNewExpressions(initializer) : [],
      jsxReferences: readJsxReferences(initializer),
      configProperties: readAgentsConfigPropertySymbols(source, initializer, file, name),
      supabaseSelectFields: readSupabaseSelectFieldSymbols(source, initializer, file, name),
    };

    if (isFunctionValue) {
      functions.push(readFunctionLikeSymbol(source, initializer, name, file, exported, {
        ...base,
        signature: readVariableFunctionSignature(source, name, initializer, declaration.type),
        returns: readTypeName(declaration.type, initializerTypeParameterNames) ?? readCallableReturnTypeName(initializer, initializerTypeParameterNames),
        typeReferences: unique([
          ...readTypeReferenceNames(declaration.type, initializerTypeParameterNames),
          ...readCallableTypeReferences(initializer),
          ...readInitializerTypeReferenceNames(initializer),
        ]),
        valueReferences: readValueReferences(initializer.body),
      }));
    } else if (isClassValue) {
      const classMembers = readClassMembers(source, initializer, file, qualifiedName ?? name);
      classes.push({
        className: name,
        file,
        ...(qualifiedName ? { qualifiedName } : {}),
        ...readNodeLocation(source, declaration),
        docstring: readDocstring(source, initializer) ?? base.docstring,
        signature: `class ${name}`,
        isExported: exported,
        isDefaultExport: false,
        isAbstract: hasModifier(initializer, ts.SyntaxKind.AbstractKeyword),
        decorators: readDecorators(source, initializer),
        typeParameters: readTypeParameterList(initializer.typeParameters),
        typeParameterReferences: readTypeParameterReferences(initializer.typeParameters),
        methods: classMembers.methods,
        properties: classMembers.properties,
        extends: readHeritageNames(initializer, ts.SyntaxKind.ExtendsKeyword),
        implements: readHeritageNames(initializer, ts.SyntaxKind.ImplementsKeyword),
        instantiates: readNewExpressions(initializer),
        valueReferences: readValueReferences(initializer),
        jsxReferences: readJsxReferences(initializer),
        typeReferences: unique([
          ...readTypeReferenceNames(declaration.type, readTypeParameterNames(initializer.typeParameters)),
          ...readClassTypeReferences(initializer),
          ...readInitializerTypeReferenceNames(initializer),
        ]),
      });
    } else {
      variables.push(base);
      if (exported) {
        functions.push(...readObjectLiteralFunctionSymbols(source, name, qualifiedName ?? name, initializer, file, exported, isConst));
      }
    }
  }

  return { variables, functions, classes };
}

function readAgentsConfigPropertySymbols(source, initializer, file, configObject) {
  const objectLiteral = readReturnedObjectLiteral(initializer);
  if (!AGENTS_CONFIG_SOURCE_FILES.has(configObject) || !objectLiteral) return [];
  const properties = [];

  const visitConfigObject = (objectLiteral, pathSegments) => {
    for (const property of objectLiteral.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isGetAccessorDeclaration(property)) continue;
      const propertyName = readPropertyName(property.name);
      if (!propertyName) continue;
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : null;
      const nextPath = [...pathSegments, propertyName];
      const configPath = nextPath.join('.');
      const parentConfigPath = pathSegments.length > 0 ? pathSegments.join('.') : null;
      const qualifiedName = `${configObject}.${configPath}`;
      properties.push({
        name: qualifiedName,
        qualifiedName,
        file,
        ...readNodeLocation(source, property),
        docstring: readDocstring(source, property),
        signature: initializer
          ? `${qualifiedName}: ${initializer.getText(source)}`
          : `${qualifiedName}: ${property.getText(source).replace(/\s+/g, ' ')}`,
        configObject,
        configPath,
        parentConfigPath,
        configProperty: propertyName,
      });
      const nestedObjectLiteral = readReturnedObjectLiteral(initializer);
      if (nestedObjectLiteral) {
        visitConfigObject(nestedObjectLiteral, nextPath);
      }
    }
  };

  visitConfigObject(objectLiteral, []);
  return properties;
}

function readSupabaseSelectFieldSymbols(source, initializer, file, configObject) {
  if (configObject !== SUPABASE_SELECT_CONFIG_OBJECT) return [];
  const objectLiteral = readReturnedObjectLiteral(initializer);
  if (!objectLiteral) return [];

  const fields = [];
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = readPropertyName(property.name);
    if (!propertyName || !propertyName.endsWith('_FIELDS')) continue;
    const initializer = property.initializer;
    if (!ts.isStringLiteralLike(initializer)) continue;
    const selectConfig = `${configObject}.${propertyName}`;
    const table = inferSupabaseTableFromSelectConfig(propertyName);
    for (const field of parseSupabaseSelectFields(initializer.text)) {
      const qualifiedName = `${selectConfig}::${field}`;
      fields.push({
        name: field,
        qualifiedName,
        file,
        ...readNodeLocation(source, property),
        docstring: readDocstring(source, property),
        signature: `${qualifiedName}: ${initializer.getText(source)}`,
        selectConfig,
        selectConfigProperty: propertyName,
        table,
        field,
      });
    }
  }

  return fields;
}

function parseSupabaseSelectFields(value) {
  const fields = [];
  for (const segment of splitSupabaseSelectSegments(String(value ?? ''))) {
    const field = segment.trim();
    if (!field) continue;
    const nestedStart = field.indexOf('(');
    const nestedEnd = field.lastIndexOf(')');
    if (nestedStart >= 0 && nestedEnd > nestedStart) {
      fields.push(...parseSupabaseSelectFields(field.slice(nestedStart + 1, nestedEnd)));
      continue;
    }
    const normalized = normalizeSupabaseSelectFieldName(field);
    if (normalized) fields.push(normalized);
  }
  return unique(fields);
}

function splitSupabaseSelectSegments(value) {
  const segments = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 0) {
      segments.push(value.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(value.slice(start));
  return segments;
}

function normalizeSupabaseSelectFieldName(field) {
  let candidate = String(field ?? '').trim();
  if (!candidate || candidate === '*') return null;
  const aliasIndex = candidate.lastIndexOf(':');
  if (aliasIndex >= 0) candidate = candidate.slice(aliasIndex + 1).trim();
  const hintIndex = candidate.indexOf('!');
  if (hintIndex >= 0) candidate = candidate.slice(0, hintIndex).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) ? candidate : null;
}

function inferSupabaseTableFromSelectConfig(propertyName) {
  const prefix = String(propertyName ?? '').split('_')[0]?.toLowerCase();
  const tableNames = {
    task: 'tasks',
    connection: 'connections',
    project: 'projects',
    tombstone: 'task_tombstones',
  };
  return tableNames[prefix] ?? null;
}

function readFunctionLikeSymbol(source, node, name, file, exported, extra = {}) {
  const { typeReferences: extraTypeReferences = [], ignoredTypeNames = new Set(), ...extraOptions } = extra;
  const qualifiedName = extra.qualifiedName ?? name;
  const typeParameterNames = mergeNameSets(ignoredTypeNames, readTypeParameterNames(node.typeParameters));
  const localTypeReferences = readLocalVariableTypeReferences(node, typeParameterNames);
  const typeReferences = unique([
    ...readCallableTypeReferences(node, ignoredTypeNames),
    ...localTypeReferences,
    ...extraTypeReferences,
  ]);
  return stripNullValues({
    name,
    file,
    qualifiedName,
    ...readNodeLocation(source, node),
    docstring: readDocstring(source, node),
    signature: readCallableSignature(source, node),
    isExported: exported,
    isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    hasBody: hasCallableBody(node),
    returns: readCallableReturnTypeName(node, typeParameterNames) ?? readTypeName(node.type, typeParameterNames),
    decorators: readDecorators(source, node),
    typeParameters: readTypeParameterList(node.typeParameters),
    typeParameterReferences: readTypeParameterReferences(node.typeParameters, ignoredTypeNames),
    parameters: readParameters(source, node, typeParameterNames),
    valueReferences: readValueReferences(node),
    calls: readCallExpressions(node),
    hardRuleImplementationCalls: readHardRuleImplementationCalls(node),
    supabaseSelects: readSupabaseSelectCalls(node),
    supabaseIncrementalPredicates: readSupabaseIncrementalPredicateCalls(node),
    supabaseStorageBuckets: readSupabaseStorageBucketCalls(node),
    supabaseFunctionInvokes: readSupabaseFunctionInvokeCalls(node),
    supabaseRpcCalls: readSupabaseRpcCalls(node),
    supabaseTableWrites: readSupabaseTableWriteCalls(node),
    supabaseRealtimeChannels: readSupabaseRealtimeChannelCalls(node),
    supabaseRealtimePostgresChanges: readSupabaseRealtimePostgresChangeCalls(node),
    supabaseRealtimeLifecycleActions: readSupabaseRealtimeLifecycleCalls(node),
    supabaseRealtimeStatuses: readSupabaseRealtimeStatusReferences(node),
    instantiates: readNewExpressions(node),
    jsxReferences: readJsxReferences(node),
    nestedFunctions: readNestedFunctionSymbols(source, node, file, qualifiedName),
    localDeclarations: readLocalDeclarationSymbols(source, node, file, qualifiedName, 'function'),
    localTypeReferences,
    typeReferences,
    ...extraOptions,
  });
}

function flattenFunctionSymbols(functions) {
  return functions.flatMap(functionSymbol => [
    functionSymbol,
    ...flattenFunctionSymbols(functionSymbol.nestedFunctions ?? []),
  ]);
}

function collectLocalDeclarations(functions, classes) {
  const declarations = createEmptyDeclarationGroups();
  for (const functionSymbol of functions) {
    appendDeclarationGroups(declarations, functionSymbol.localDeclarations);
  }
  for (const classSymbol of classes) {
    for (const method of classSymbol.methods ?? []) {
      appendDeclarationGroups(declarations, method.localDeclarations);
    }
  }
  return declarations;
}

function createEmptyDeclarationGroups() {
  return {
    classes: [],
    interfaces: [],
    types: [],
    enums: [],
  };
}

function appendDeclarationGroups(target, source) {
  if (!source) return;
  target.classes.push(...(source.classes ?? []));
  target.interfaces.push(...(source.interfaces ?? []));
  target.types.push(...(source.types ?? []));
  target.enums.push(...(source.enums ?? []));
}

function readNestedFunctionSymbols(source, node, file, ownerQualifiedName) {
  const body = readCallableBody(node);
  if (!body) return [];
  const nestedFunctions = [];

  visitFunctionBodyForOwner(body, child => {
    if (ts.isVariableDeclaration(child)) {
      const initializer = child.initializer;
      const isFunctionValue = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
      if (!isFunctionValue) return false;

      const nestedName = readBindingName(child.name);
      if (nestedName) {
        const initializerTypeParameterNames = readTypeParameterNames(initializer.typeParameters);
        nestedFunctions.push(readFunctionLikeSymbol(source, initializer, nestedName, file, false, {
          qualifiedName: `${ownerQualifiedName}::${nestedName}`,
          ...readNodeLocation(source, child),
          docstring: readDocstring(source, child) ?? readDocstring(source, initializer),
          signature: readVariableFunctionSignature(source, nestedName, initializer, child.type),
          returns: readTypeName(child.type, initializerTypeParameterNames) ?? readCallableReturnTypeName(initializer, initializerTypeParameterNames),
          typeReferences: unique([
            ...readTypeReferenceNames(child.type, initializerTypeParameterNames),
            ...readCallableTypeReferences(initializer),
            ...readInitializerTypeReferenceNames(initializer),
          ]),
          valueReferences: readValueReferences(initializer.body),
          nestedOwnerQualifiedName: ownerQualifiedName,
        }));
      }

      return true;
    }

    if (!isNamedFunctionNode(child)) return false;
    const nestedName = child.name.text;
    nestedFunctions.push(readFunctionLikeSymbol(source, child, nestedName, file, false, {
      qualifiedName: `${ownerQualifiedName}::${nestedName}`,
      nestedOwnerQualifiedName: ownerQualifiedName,
    }));
    return true;
  });

  return nestedFunctions;
}

function readLocalDeclarationSymbols(source, node, file, ownerQualifiedName, ownerKind) {
  const body = readCallableBody(node);
  const declarations = createEmptyDeclarationGroups();
  if (!body || !file || !ownerQualifiedName) return declarations;

  visitFunctionBodyForOwner(body, child => {
    if (child !== body && isNamedFunctionNode(child)) return true;

    if (ts.isClassDeclaration(child) && child.name) {
      const qualifiedName = `${ownerQualifiedName}::${child.name.text}`;
      const classMembers = readClassMembers(source, child, file, qualifiedName);
      declarations.classes.push({
        className: child.name.text,
        qualifiedName,
        file,
        ...readNodeLocation(source, child),
        docstring: readDocstring(source, child),
        signature: `class ${child.name.text}`,
        isExported: false,
        isDefaultExport: false,
        isAbstract: hasModifier(child, ts.SyntaxKind.AbstractKeyword),
        decorators: readDecorators(source, child),
        typeParameters: readTypeParameterList(child.typeParameters),
        typeParameterReferences: readTypeParameterReferences(child.typeParameters),
        methods: classMembers.methods,
        properties: classMembers.properties,
        extends: readHeritageNames(child, ts.SyntaxKind.ExtendsKeyword),
        implements: readHeritageNames(child, ts.SyntaxKind.ImplementsKeyword),
        instantiates: readNewExpressions(child),
        typeReferences: readClassTypeReferences(child),
        valueReferences: readValueReferences(child),
        jsxReferences: readJsxReferences(child),
        localDeclarationOwnerQualifiedName: ownerQualifiedName,
        localDeclarationOwnerKind: ownerKind,
      });
      return true;
    }

    if (ts.isInterfaceDeclaration(child)) {
      const members = readInterfaceMembers(source, child);
      declarations.interfaces.push({
        name: child.name.text,
        qualifiedName: `${ownerQualifiedName}::${child.name.text}`,
        file,
        ...readNodeLocation(source, child),
        docstring: readDocstring(source, child),
        signature: `interface ${child.name.text}`,
        isExported: false,
        isDefaultExport: false,
        typeParameters: readTypeParameterList(child.typeParameters),
        typeParameterReferences: readTypeParameterReferences(child.typeParameters),
        methods: members.methods,
        properties: members.properties,
        extends: readHeritageNames(child, ts.SyntaxKind.ExtendsKeyword),
        typeReferences: readInterfaceTypeReferences(child),
        localDeclarationOwnerQualifiedName: ownerQualifiedName,
        localDeclarationOwnerKind: ownerKind,
      });
      return true;
    }

    if (ts.isTypeAliasDeclaration(child)) {
      const typeParameterNames = readTypeParameterNames(child.typeParameters);
      const members = readTypeAliasMembers(source, child);
      declarations.types.push({
        name: child.name.text,
        qualifiedName: `${ownerQualifiedName}::${child.name.text}`,
        file,
        ...readNodeLocation(source, child),
        docstring: readDocstring(source, child),
        signature: `type ${child.name.text}`,
        isExported: false,
        isDefaultExport: false,
        typeParameters: readTypeParameterList(child.typeParameters),
        typeParameterReferences: readTypeParameterReferences(child.typeParameters),
        methods: members.methods,
        properties: members.properties,
        typeReferences: readTypeReferenceNames(child.type, typeParameterNames),
        localDeclarationOwnerQualifiedName: ownerQualifiedName,
        localDeclarationOwnerKind: ownerKind,
      });
      return true;
    }

    if (ts.isEnumDeclaration(child)) {
      declarations.enums.push({
        name: child.name.text,
        qualifiedName: `${ownerQualifiedName}::${child.name.text}`,
        file,
        ...readNodeLocation(source, child),
        docstring: readDocstring(source, child),
        signature: `enum ${child.name.text}`,
        isExported: false,
        isDefaultExport: false,
        members: child.members.map(member => ({
          name: readPropertyName(member.name),
          ...readNodeLocation(source, member),
          docstring: readDocstring(source, member),
          signature: readEnumMemberSignature(source, member),
        })).filter(member => member.name),
        localDeclarationOwnerQualifiedName: ownerQualifiedName,
        localDeclarationOwnerKind: ownerKind,
      });
      return true;
    }

    return false;
  });

  return declarations;
}

function readLocalVariableTypeReferences(node, ignoredTypeNames = new Set()) {
  const body = readCallableBody(node);
  if (!body) return [];
  const names = [];
  visitFunctionBodyForOwner(body, child => {
    if (child !== body && isNamedFunctionNode(child)) return true;
    if (!ts.isVariableDeclaration(child)) return;
    names.push(...readTypeReferenceNames(child.type, ignoredTypeNames));
  });
  return unique(names);
}

function visitFunctionBodyForOwner(node, visitor) {
  const handled = visitor(node);
  if (handled) return;
  ts.forEachChild(node, child => visitFunctionBodyForOwner(child, visitor));
}

function isNamedFunctionNode(node) {
  return Boolean(
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
    && node.name,
  );
}

function readCallableBody(node) {
  if (!node || !('body' in node)) return null;
  return node.body ?? null;
}

function hasCallableBody(node) {
  return Boolean(readCallableBody(node));
}

function readObjectLiteralFunctionSymbols(source, ownerName, ownerQualifiedName, initializer, file, exported, isConst) {
  const objectLiteral = findObjectLiteralFunctionContainer(initializer);
  if (!objectLiteral) return [];

  return objectLiteral.properties
    .flatMap(property => readObjectLiteralFunctionSymbol(source, property, ownerName, ownerQualifiedName, file, exported, isConst))
    .filter(Boolean);
}

function findObjectLiteralFunctionContainer(initializer) {
  if (!initializer) return null;
  return readReturnedObjectLiteral(initializer);
}

function readReturnedObjectLiteral(node, depth = 0) {
  if (!node) return null;
  if (depth > 4) return null;
  if (ts.isParenthesizedExpression(node)) return readReturnedObjectLiteral(node.expression, depth);
  if (ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    return readReturnedObjectLiteral(node.expression, depth);
  }
  if (ts.isSatisfiesExpression?.(node)) return readReturnedObjectLiteral(node.expression, depth);
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isCallExpression(node)) {
    for (const argument of node.arguments) {
      const returned = readReturnedObjectLiteral(argument, depth + 1);
      if (returned) return returned;
    }
    return null;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isObjectLiteralExpression(node.body)) return node.body;
    if (ts.isParenthesizedExpression(node.body)) return readReturnedObjectLiteral(node.body.expression, depth);
    if (ts.isBlock(node.body)) {
      for (const statement of node.body.statements) {
        if (!ts.isReturnStatement(statement)) continue;
        const returned = readReturnedObjectLiteral(statement.expression, depth + 1);
        if (returned) return returned;
      }
    }
  }
  return null;
}

function readObjectLiteralFunctionSymbol(source, property, ownerName, ownerQualifiedName, file, exported, isConst) {
  if (ts.isMethodDeclaration(property)) {
    const name = readMemberName(property);
    if (!name) return null;
    const typeParameterNames = readTypeParameterNames(property.typeParameters);
    return {
      name,
      qualifiedName: `${ownerQualifiedName}::${name}`,
      file,
      ...readNodeLocation(source, property),
      docstring: readDocstring(source, property),
      signature: readCallableSignature(source, property),
      isExported: exported,
      isAsync: hasModifier(property, ts.SyntaxKind.AsyncKeyword),
      hasBody: Boolean(property.body),
      returns: readTypeName(property.type, typeParameterNames),
      decorators: readDecorators(source, property),
      typeParameters: readTypeParameterList(property.typeParameters),
      typeParameterReferences: readTypeParameterReferences(property.typeParameters),
      parameters: readParameters(source, property, typeParameterNames),
      typeReferences: readCallableTypeReferences(property),
      valueReferences: readValueReferences(property),
      calls: readCallExpressions(property),
      hardRuleImplementationCalls: readHardRuleImplementationCalls(property),
      instantiates: readNewExpressions(property),
      jsxReferences: readJsxReferences(property),
      objectOwnerName: ownerName,
      objectOwnerQualifiedName: ownerQualifiedName,
      objectOwnerKind: isConst ? 'constant' : 'variable',
    };
  }

  if (ts.isPropertyAssignment(property)) {
    const name = readPropertyName(property.name);
    const initializer = property.initializer;
    if (!name || !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return null;
    const typeParameterNames = readTypeParameterNames(initializer.typeParameters);
    return {
      name,
      qualifiedName: `${ownerQualifiedName}::${name}`,
      file,
      ...readNodeLocation(source, property),
      docstring: readDocstring(source, property) ?? readDocstring(source, initializer),
      signature: readVariableFunctionSignature(source, name, initializer, undefined),
      isExported: exported,
      isAsync: hasModifier(initializer, ts.SyntaxKind.AsyncKeyword),
      hasBody: true,
      returns: readCallableReturnTypeName(initializer, typeParameterNames),
      typeParameters: readTypeParameterList(initializer.typeParameters),
      typeParameterReferences: readTypeParameterReferences(initializer.typeParameters),
      parameters: readParameters(source, initializer, typeParameterNames),
      typeReferences: readCallableTypeReferences(initializer),
      valueReferences: readValueReferences(initializer),
      calls: readCallExpressions(initializer),
      hardRuleImplementationCalls: readHardRuleImplementationCalls(initializer),
      instantiates: readNewExpressions(initializer),
      jsxReferences: readJsxReferences(initializer),
      objectOwnerName: ownerName,
      objectOwnerQualifiedName: ownerQualifiedName,
      objectOwnerKind: isConst ? 'constant' : 'variable',
    };
  }

  return null;
}

function readHeritageNames(classNode, token) {
  const clauses = classNode.heritageClauses ?? [];
  return unique(clauses
    .filter(clause => clause.token === token)
    .flatMap(clause => clause.types.map(type => readReferenceName(type.expression)))
    .filter(name => !isIgnoredTypeReferenceName(name))
    .filter(Boolean));
}

function readHeritageTypeReferenceNames(classNode, token, ignoredTypeNames = new Set()) {
  const clauses = classNode.heritageClauses ?? [];
  return unique(clauses
    .filter(clause => clause.token === token)
    .flatMap(clause => clause.types.flatMap(type => {
      const name = readReferenceName(type.expression);
      return [
        ...(name && !isIgnoredTypeReferenceName(name, ignoredTypeNames) ? [name] : []),
        ...(type.typeArguments ?? []).flatMap(argument => readTypeReferenceNames(argument, ignoredTypeNames)),
      ];
    }))
    .filter(Boolean));
}

function readCallExpressions(node) {
  const calls = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    if (child.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    if (isDecoratorCallExpression(child)) return;
    const name = readCallExpressionName(child.expression);
    if (name) calls.push(name);
  });
  return unique(calls);
}

function readHardRuleImplementationCalls(node) {
  const calls = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    const keyword = hardRuleKeywordForCallExpression(child.expression);
    if (!keyword) return;
    calls.push({
      keyword,
      call: keyword.replace(/\(\)$/, ''),
      line: readLine(child.getSourceFile(), child),
      column: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(calls);
}

function hardRuleKeywordForCallExpression(expression) {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'crypto'
    && expression.name.text === 'randomUUID'
    ? 'crypto.randomUUID()'
    : null;
}

function readSupabaseSelectCalls(node) {
  const selects = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    if (!isSupabaseSelectCallExpression(child.expression)) return;
    const selectArgument = child.arguments[0];
    const selectConfig = readSupabaseSelectConfigReference(selectArgument);
    const inlineSelect = selectConfig ? null : readStaticStringExpression(selectArgument);
    const fields = inlineSelect ? parseSupabaseSelectFields(inlineSelect) : [];
    if (!selectConfig && fields.length === 0) return;
    selects.push({
      selectConfig,
      fields,
      table: readSupabaseFromTableName(child.expression),
      line: readLine(child.getSourceFile(), child),
      column: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(selects);
}

function readSupabaseIncrementalPredicateCalls(node) {
  const predicates = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    const expression = child.expression;
    if (!isSupabaseIncrementalFilterExpression(expression)) return;
    const columnArgument = child.arguments[0];
    if (!columnArgument || !ts.isStringLiteralLike(columnArgument)) return;
    if (columnArgument.text !== 'updated_at') return;
    const cursorArgument = child.arguments[1];
    if (!cursorArgument || ts.isStringLiteralLike(cursorArgument)) return;
    const cursor = readReferenceName(cursorArgument);
    const cursorKeyword = readIncrementalCursorKeyword(cursor);
    if (!cursor || !cursorKeyword) return;
    const table = readSupabaseFromTableName(expression);
    if (!table) return;
    predicates.push({
      name: 'updated_at > last_sync_time',
      table,
      column: columnArgument.text,
      operator: expression.name.text,
      cursor,
      cursorKeyword,
      line: readLine(child.getSourceFile(), child),
      columnNumber: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(predicates);
}

function readSupabaseStorageBucketCalls(node) {
  const buckets = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    const expression = child.expression;
    if (!isSupabaseStorageFromExpression(expression)) return;
    const bucketArgument = child.arguments[0];
    if (!bucketArgument || !ts.isStringLiteralLike(bucketArgument)) return;
    buckets.push({
      bucket: bucketArgument.text,
      line: readLine(child.getSourceFile(), child),
      column: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(buckets);
}

function readSupabaseFunctionInvokeCalls(node) {
  const invokes = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    const expression = child.expression;
    if (!isSupabaseFunctionInvokeExpression(expression)) return;
    const invokeArgument = child.arguments[0];
    if (!invokeArgument || !ts.isStringLiteralLike(invokeArgument)) return;
    const invokeName = invokeArgument.text;
    invokes.push({
      invokeName,
      path: `/functions/v1/${invokeName}`,
      line: readLine(child.getSourceFile(), child),
      column: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(invokes);
}

function readSupabaseRpcCalls(node) {
  const calls = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    const expression = child.expression;
    if (!isSupabaseRpcExpression(expression)) return;
    const functionArgument = child.arguments[0];
    const functionName = readStaticStringExpression(functionArgument);
    if (!functionName) return;
    calls.push({
      functionName,
      argNames: readObjectLiteralPropertyNames(child.arguments[1]),
      line: readLine(child.getSourceFile(), child),
      column: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(calls);
}

function readSupabaseTableWriteCalls(node) {
  const writes = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    const expression = child.expression;
    if (!isSupabaseTableWriteExpression(expression)) return;
    const table = readSupabaseFromTableName(expression);
    if (!table) return;
    writes.push({
      table,
      writeOperation: expression.name.text,
      payloadKeys: readObjectLiteralPropertyNames(child.arguments[0]),
      optionKeys: readObjectLiteralPropertyNames(child.arguments[1]),
      line: readLine(child.getSourceFile(), child),
      column: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(writes);
}

function readSupabaseRealtimeChannelCalls(node) {
  return readSupabaseRealtimeReferences(node).channels;
}

function readSupabaseRealtimePostgresChangeCalls(node) {
  return readSupabaseRealtimeReferences(node).postgresChanges;
}

function readSupabaseRealtimeLifecycleCalls(node) {
  return readSupabaseRealtimeReferences(node).lifecycleActions;
}

function readSupabaseRealtimeStatusReferences(node) {
  if (!isSupabaseRealtimeStatusSourceFileEligible(node.getSourceFile())) return [];
  if (!hasSupabaseRealtimeStatusContext(node)) return [];
  const statuses = [];
  visit(node, child => {
    if (!ts.isStringLiteralLike(child)) return;
    const status = child.text;
    if (!SUPABASE_REALTIME_STATUSES.has(status)) return;
    statuses.push({
      status,
      action: readSupabaseRealtimeStatusAction(status),
      line: readLine(child.getSourceFile(), child),
      column: readColumn(child.getSourceFile(), child),
    });
  });
  return uniqueObjects(statuses);
}

function isSupabaseRealtimeStatusSourceFileEligible(sourceFile) {
  const fileName = toPosix(sourceFile?.fileName ?? '');
  return ![
    '/scripts/',
    '/src/tests/',
    '/src/test-setup.',
    '.spec.',
    '.test.',
  ].some(pattern => fileName.includes(pattern));
}

function hasSupabaseRealtimeStatusContext(node) {
  const text = node.getText();
  return /\bRealtime\b|\bsubscribe\b|\bchannel\b|\bstatus\b/.test(text)
    && [...SUPABASE_REALTIME_STATUSES].some(status => text.includes(status));
}

function readSupabaseRealtimeStatusAction(status) {
  return status === 'SUBSCRIBED' ? 'subscribed' : 'fallback';
}

function readSupabaseRealtimeReferences(node) {
  const stringBindings = readLocalStaticStringBindings(node);
  const channelBindings = readLocalSupabaseRealtimeChannelBindings(node, stringBindings);
  const channels = [];
  const postgresChanges = [];
  const lifecycleActions = [];
  visit(node, child => {
    if (!ts.isCallExpression(child)) return;
    const channelName = readSupabaseRealtimeChannelName(child, stringBindings);
    if (channelName) {
      channels.push({
        channelName,
        line: readLine(child.getSourceFile(), child),
        column: readColumn(child.getSourceFile(), child),
      });
    }

    const postgresChange = readSupabaseRealtimePostgresChangeCall(child, stringBindings, channelBindings);
    if (postgresChange) {
      postgresChanges.push(postgresChange);
    }

    const lifecycleAction = readSupabaseRealtimeLifecycleCall(child, stringBindings, channelBindings);
    if (lifecycleAction) {
      lifecycleActions.push(lifecycleAction);
    }
  });
  return {
    channels: uniqueObjects(channels),
    postgresChanges: uniqueObjects(postgresChanges),
    lifecycleActions: uniqueObjects(lifecycleActions),
  };
}

function readLocalStaticStringBindings(node) {
  const bindings = new Map();
  visit(node, child => {
    if (!ts.isVariableDeclaration(child)) return;
    const name = readBindingName(child.name);
    if (!name || !child.initializer) return;
    const value = readStaticStringExpression(child.initializer, bindings);
    if (value) bindings.set(name, value);
  });
  return bindings;
}

function readLocalSupabaseRealtimeChannelBindings(node, stringBindings) {
  const bindings = new Map();
  visit(node, child => {
    if (!ts.isVariableDeclaration(child)) return;
    const name = readBindingName(child.name);
    if (!name || !child.initializer || !ts.isCallExpression(child.initializer)) return;
    const channelName = readSupabaseRealtimeChannelName(child.initializer, stringBindings);
    if (channelName) bindings.set(name, channelName);
  });
  return bindings;
}

function readSupabaseRealtimeChannelName(callExpression, stringBindings) {
  const expression = callExpression.expression;
  if (!isSupabaseRealtimeChannelExpression(expression)) return null;
  return readStaticStringExpression(callExpression.arguments[0], stringBindings);
}

function readSupabaseRealtimePostgresChangeCall(callExpression, stringBindings, channelBindings) {
  const expression = callExpression.expression;
  if (!isSupabaseRealtimeOnExpression(expression)) return null;
  const eventType = readStaticStringExpression(callExpression.arguments[0], stringBindings);
  if (eventType !== 'postgres_changes') return null;
  const channelName = readSupabaseRealtimeChannelReceiverName(expression.expression, stringBindings, channelBindings);
  if (!channelName) return null;
  const config = readSupabaseRealtimePostgresChangeConfig(callExpression.arguments[1], stringBindings);
  if (!config) return null;
  return {
    channelName,
    event: config.event,
    schema: config.schema,
    table: config.table,
    filter: config.filter ?? '',
    line: readLine(callExpression.getSourceFile(), callExpression),
    column: readColumn(callExpression.getSourceFile(), callExpression),
  };
}

function readSupabaseRealtimeChannelReceiverName(receiver, stringBindings, channelBindings) {
  const unwrapped = unwrapParenthesizedExpression(receiver);
  if (ts.isCallExpression(unwrapped)) {
    return readSupabaseRealtimeChannelName(unwrapped, stringBindings);
  }
  if (ts.isIdentifier(unwrapped)) {
    return channelBindings.get(unwrapped.text) ?? null;
  }
  return null;
}

function readSupabaseRealtimePostgresChangeConfig(node, stringBindings) {
  const unwrapped = unwrapParenthesizedExpression(node);
  if (!unwrapped || !ts.isObjectLiteralExpression(unwrapped)) return null;
  const event = readStaticStringExpression(readPropertyInitializer(unwrapped, 'event'), stringBindings);
  const schema = readStaticStringExpression(readPropertyInitializer(unwrapped, 'schema'), stringBindings);
  const table = readStaticStringExpression(readPropertyInitializer(unwrapped, 'table'), stringBindings);
  const filter = readStaticStringExpression(readPropertyInitializer(unwrapped, 'filter'), stringBindings);
  if (!event || !schema) return null;
  return { event, schema, table, filter };
}

function readSupabaseRealtimeLifecycleCall(callExpression, stringBindings, channelBindings) {
  const expression = callExpression.expression;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  const action = expression.name.text;
  if (action === 'unsubscribe') {
    const channelName = readSupabaseRealtimeChannelReceiverName(expression.expression, stringBindings, channelBindings);
    const channelVariable = readReferenceName(expression.expression);
    if (!channelName && !isLikelySupabaseRealtimeChannelVariable(channelVariable, callExpression)) return null;
    return readSupabaseRealtimeLifecycleAction(callExpression, {
      relation: 'supabase-realtime-unsubscribe',
      action,
      channelName,
      channelVariable: channelName ? null : channelVariable,
    });
  }
  if (action === 'removeChannel') {
    const channelName = readSupabaseRealtimeChannelReceiverName(callExpression.arguments[0], stringBindings, channelBindings);
    const channelVariable = readReferenceName(callExpression.arguments[0]);
    if (!channelName && !channelVariable) return null;
    return readSupabaseRealtimeLifecycleAction(callExpression, {
      relation: 'supabase-realtime-remove-channel',
      action,
      channelName,
      channelVariable,
    });
  }
  if (action === 'removeAllChannels') {
    const receiverName = readReferenceName(expression.expression);
    if (channelBindings.size === 0 && !/(supabase|realtime|client)/i.test(receiverName ?? '')) return null;
    return readSupabaseRealtimeLifecycleAction(callExpression, {
      relation: 'supabase-realtime-remove-all-channels',
      action,
    });
  }
  return null;
}

function isLikelySupabaseRealtimeChannelVariable(channelVariable, callExpression) {
  if (!channelVariable || !/channel/i.test(channelVariable)) return false;
  const sourceText = callExpression.getSourceFile()?.text ?? '';
  const contextStart = Math.max(0, callExpression.getStart(callExpression.getSourceFile()) - 4000);
  const contextEnd = Math.min(sourceText.length, callExpression.end + 1000);
  const localContext = sourceText.slice(contextStart, contextEnd);
  return /\bRealtimeChannel\b|supabase|realtime|removeChannel|channel-owned unsubscribe/i.test(localContext);
}

function readSupabaseRealtimeLifecycleAction(callExpression, action) {
  return {
    ...action,
    line: readLine(callExpression.getSourceFile(), callExpression),
    column: readColumn(callExpression.getSourceFile(), callExpression),
  };
}

function isSupabaseSelectCallExpression(expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'select';
}

function isSupabaseIncrementalFilterExpression(expression) {
  return ts.isPropertyAccessExpression(expression) && ['gt', 'gte'].includes(expression.name.text);
}

function isSupabaseStorageFromExpression(expression) {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'from') return false;
  const receiver = unwrapParenthesizedExpression(expression.expression);
  return Boolean(ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage');
}

function isSupabaseFunctionInvokeExpression(expression) {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'invoke') return false;
  const receiver = unwrapParenthesizedExpression(expression.expression);
  return Boolean(ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'functions');
}

function isSupabaseRpcExpression(expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'rpc';
}

function isSupabaseTableWriteExpression(expression) {
  return ts.isPropertyAccessExpression(expression)
    && ['insert', 'update', 'upsert', 'delete'].includes(expression.name.text);
}

function readObjectLiteralPropertyNames(node) {
  if (!node) return [];
  const expression = unwrapParenthesizedExpression(node);
  if (!ts.isObjectLiteralExpression(expression)) return [];
  return expression.properties
    .map(property => {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
        return readPropertyName(property.name);
      }
      return null;
    })
    .filter(Boolean);
}

function isSupabaseRealtimeChannelExpression(expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'channel';
}

function isSupabaseRealtimeOnExpression(expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'on';
}

function readStaticStringExpression(node, bindings = new Map()) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map(span => `\${${span.expression.getText()}}${span.literal.text}`),
    ].join('');
  }
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    return readStaticStringExpression(node.expression, bindings);
  }
  if (ts.isSatisfiesExpression?.(node)) {
    return readStaticStringExpression(node.expression, bindings);
  }
  return null;
}

function readIncrementalCursorKeyword(name) {
  return /(last[_\s-]?sync|since|cursor|updated[_\s-]?after|after[_\s-]?updated)/i.test(String(name ?? ''))
    ? 'last_sync_time'
    : null;
}

function readSupabaseSelectConfigReference(node) {
  if (!node) return null;
  const directReference = readReferenceName(node);
  if (directReference?.startsWith(`${SUPABASE_SELECT_CONFIG_OBJECT}.`)) return directReference;

  if (ts.isCallExpression(node)) {
    for (const argument of node.arguments) {
      const nestedReference = readSupabaseSelectConfigReference(argument);
      if (nestedReference) return nestedReference;
    }
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    return readSupabaseSelectConfigReference(node.expression);
  }
  if (ts.isSatisfiesExpression?.(node)) {
    return readSupabaseSelectConfigReference(node.expression);
  }
  return null;
}

function readSupabaseFromTableName(selectExpression) {
  if (!ts.isPropertyAccessExpression(selectExpression)) return null;
  let current = selectExpression.expression;
  while (current) {
    if (ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'from') {
        const tableArgument = current.arguments[0];
        return tableArgument && ts.isStringLiteralLike(tableArgument) ? tableArgument.text : null;
      }
      current = ts.isPropertyAccessExpression(current.expression)
        ? current.expression.expression
        : current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return null;
}

function readCallExpressionName(expression) {
  if (ts.isIdentifier(expression)) {
    return isIgnoredValueReference(expression.text) ? null : expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const root = readPropertyAccessRootName(expression);
    if (root && isIgnoredValueReference(root)) return null;
    if (ts.isIdentifier(expression.expression) && !CALL_RECEIVER_SKIP_NAMES.has(expression.expression.text)) {
      return `${expression.expression.text}.${expression.name.text}`;
    }
    return expression.name.text;
  }
  return null;
}

function readNewExpressions(node) {
  const names = [];
  visit(node, child => {
    if (!ts.isNewExpression(child)) return;
    const name = readReferenceName(child.expression);
    if (name && !isIgnoredValueReference(name)) names.push(name);
  });
  return unique(names);
}

function readParameters(source, node, ignoredTypeNames = new Set()) {
  if (!node || !('parameters' in node)) return [];
  return (node.parameters ?? [])
    .map(parameter => {
      const name = readBindingName(parameter.name);
      if (!name) return null;
      return {
        name,
        ...readNodeLocation(source, parameter),
        docstring: readDocstring(source, parameter),
        signature: parameter.getText(source),
        returns: readTypeName(parameter.type, ignoredTypeNames),
        typeReferences: readTypeReferenceNames(parameter.type, ignoredTypeNames),
      };
    })
    .filter(Boolean);
}

function readValueReferences(node) {
  if (!node) return [];
  const names = [];
  const localNames = new Set();

  visit(node, child => {
    if (ts.isParameter(child)) {
      for (const name of readBindingNames(child.name)) {
        localNames.add(name);
      }
      return;
    }

    if (ts.isVariableDeclaration(child)) {
      for (const name of readBindingNames(child.name)) {
        localNames.add(name);
      }
    }

    if (ts.isIdentifier(child)) {
      if (isReferenceIdentifier(child) && !localNames.has(child.text) && !isIgnoredValueReference(child.text)) {
        names.push(child.text);
      }
      return;
    }

    if (ts.isPropertyAccessExpression(child)) {
      const root = readPropertyAccessRootName(child);
      if (root && !localNames.has(root) && !isIgnoredValueReference(root)) {
        names.push(root);
      }
    }
  });

  return unique(names);
}

function isReferenceIdentifier(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isTypeParameterDeclaration(parent)) return false;
  if (typeof ts.isTypeNode === 'function' && ts.isTypeNode(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return false;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return false;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isExportSpecifier(parent)) return false;
  if (ts.isTypeReferenceNode(parent)) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (ts.isExpressionWithTypeArguments(parent)) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if (ts.isNewExpression(parent) && parent.expression === node) return false;
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === node) return false;
  if (ts.isJsxClosingElement(parent) && parent.tagName === node) return false;
  return true;
}

function isIgnoredValueReference(name) {
  return [
    'this',
    'super',
    'undefined',
    'null',
    'true',
    'false',
    'return',
  ].includes(name) || TYPESCRIPT_GLOBAL_VALUE_REFERENCES.has(name);
}

function readJsxReferences(node) {
  if (!node) return [];
  const names = [];
  visit(node, child => {
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
      const name = readJsxTagName(child.tagName);
      if (name && isComponentLikeJsxName(name)) {
        names.push(name);
      }
    }
  });
  return unique(names);
}

function readJsxTagName(tagName) {
  if (ts.isIdentifier(tagName)) return tagName.text;
  if (ts.isPropertyAccessExpression(tagName)) return readReferenceName(tagName);
  if (tagName.kind === ts.SyntaxKind.ThisKeyword) return null;
  return null;
}

function isComponentLikeJsxName(name) {
  return /^[A-Z]/.test(name) || String(name).includes('.');
}

function readDecorators(source, node) {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  return decorators
    .map(decorator => {
      const call = ts.isCallExpression(decorator.expression) ? decorator.expression : null;
      const expression = call
        ? call.expression
        : decorator.expression;
      const name = readReferenceName(expression);
      return name
        ? {
          name,
          line: readLine(source, decorator),
          column: readColumn(source, decorator),
          argumentReferences: call
            ? unique(call.arguments.flatMap(argument => readInitializerTypeReferenceNames(argument)))
            : [],
        }
        : null;
    })
    .filter(Boolean);
}

function isDecoratorCallExpression(callExpression) {
  const parent = callExpression.parent;
  return Boolean(parent && ts.isDecorator(parent) && parent.expression === callExpression);
}

function mergeFunctionOverloads(functions) {
  const byKey = new Map();
  for (const fn of functions) {
    const key = `${fn.file}:${fn.qualifiedName ?? fn.name}`;
    const group = byKey.get(key) ?? { signatures: [], implementation: null };
    if (fn.hasBody) {
      group.implementation = fn;
    } else {
      group.signatures.push(fn);
    }
    byKey.set(key, group);
  }

  return [...byKey.values()].map(group => {
    const selected = group.implementation ?? group.signatures.at(-1);
    return stripNullValues({
      ...selected,
      overloads: group.signatures.length || null,
      overloadSignatures: group.signatures.map(signature => signature.signature),
    });
  });
}

function readNamespace(source, statement, file, isExported, qualifiedName) {
  const members = [];
  if (statement.body && ts.isModuleBlock(statement.body)) {
    for (const child of statement.body.statements) {
      const name = readTopLevelDeclarationName(child);
      if (!name) continue;
      members.push({
        kind: readTopLevelDeclarationKind(child),
        name,
        ...readNodeLocation(source, child),
      });
    }
  }

  return {
    name: qualifiedName ?? readReferenceName(statement.name),
    file,
    ...readNodeLocation(source, statement),
    docstring: readDocstring(source, statement),
    signature: `namespace ${qualifiedName ?? readReferenceName(statement.name)}`,
    isExported,
    members,
  };
}

function readTopLevelDeclarationName(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map(declaration => readBindingName(declaration.name))
      .filter(Boolean)[0] ?? null;
  }
  if ('name' in statement && statement.name) {
    return readPropertyName(statement.name);
  }
  return null;
}

function readTopLevelDeclarationKind(statement) {
  if (ts.isClassDeclaration(statement)) return 'class';
  if (ts.isFunctionDeclaration(statement)) return 'function';
  if (ts.isInterfaceDeclaration(statement)) return 'interface';
  if (ts.isTypeAliasDeclaration(statement)) return 'type';
  if (ts.isEnumDeclaration(statement)) return 'enum';
  if (ts.isVariableStatement(statement)) return 'variable';
  if (ts.isModuleDeclaration(statement)) return 'namespace';
  return 'variable';
}

function readClassTypeReferences(classNode) {
  const typeParameterNames = readTypeParameterNames(classNode.typeParameters);
  return unique([
    ...readHeritageTypeReferenceNames(classNode, ts.SyntaxKind.ExtendsKeyword, typeParameterNames),
    ...readHeritageTypeReferenceNames(classNode, ts.SyntaxKind.ImplementsKeyword, typeParameterNames),
    ...classNode.members.flatMap(member => {
      if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        return readCallableTypeReferences(member, typeParameterNames);
      }
      if (ts.isPropertyDeclaration(member)) {
        const callable = readClassFieldFunctionInitializer(member.initializer);
        const memberTypeParameterNames = mergeNameSets(typeParameterNames, readTypeParameterNames(callable?.typeParameters));
        return unique([
          ...readTypeReferenceNames(member.type, typeParameterNames),
          ...readCallableTypeReferences(callable, memberTypeParameterNames),
        ]);
      }
      return [];
    }),
  ]);
}

function readInterfaceTypeReferences(interfaceNode) {
  const typeParameterNames = readTypeParameterNames(interfaceNode.typeParameters);
  return unique([
    ...readHeritageTypeReferenceNames(interfaceNode, ts.SyntaxKind.ExtendsKeyword, typeParameterNames),
    ...interfaceNode.members.flatMap(member => {
      if (ts.isMethodSignature(member)) return readCallableTypeReferences(member, typeParameterNames);
      if (ts.isPropertySignature(member)) return readTypeReferenceNames(member.type, typeParameterNames);
      return [];
    }),
  ]);
}

function readCallableTypeReferences(node, ignoredTypeNames = new Set()) {
  if (!node || (!('parameters' in node) && !('type' in node))) return [];
  const typeParameterNames = mergeNameSets(ignoredTypeNames, readTypeParameterNames(node.typeParameters));
  return unique([
    ...readTypeReferenceNames(node.type, typeParameterNames),
    ...(node.typeParameters ?? []).flatMap(parameter => [
      ...readTypeReferenceNames(parameter.constraint, typeParameterNames),
      ...readTypeReferenceNames(parameter.default, typeParameterNames),
    ]),
    ...(node.parameters ?? []).flatMap(parameter => readTypeReferenceNames(parameter.type, typeParameterNames)),
  ]);
}

function readTypeParameterReferences(typeParameters, ignoredTypeNames = new Set()) {
  const typeParameterNames = mergeNameSets(ignoredTypeNames, readTypeParameterNames(typeParameters));
  return (typeParameters ?? []).flatMap(parameter => {
    const typeParameter = parameter.name?.text;
    if (!typeParameter) return [];
    return [
      ...readTypeReferenceNames(parameter.constraint, typeParameterNames).map(target => ({
        relation: 'type-parameter-constraint',
        typeParameter,
        target,
      })),
      ...readTypeReferenceNames(parameter.default, typeParameterNames).map(target => ({
        relation: 'type-parameter-default',
        typeParameter,
        target,
      })),
    ];
  });
}

function readInitializerTypeReferenceNames(initializer) {
  if (!initializer) return [];
  if (ts.isPropertyAccessExpression(initializer)) {
    const root = readPropertyAccessRootName(initializer);
    if (root && !isIgnoredInitializerReferenceName(root)) return [root];
    return [];
  }
  const directName = readReferenceName(initializer);
  if (directName && !isIgnoredInitializerReferenceName(directName)) return [directName];
  const names = [];
  visit(initializer, child => {
    if (ts.isPropertyAccessExpression(child)) {
      const root = readPropertyAccessRootName(child);
      if (root && !isIgnoredInitializerReferenceName(root)) names.push(root);
      return;
    }
    if (ts.isNewExpression(child)) {
      const name = readReferenceName(child.expression);
      if (name && !isIgnoredInitializerReferenceName(name)) names.push(name);
    }
  });
  return unique(names);
}

function readPropertyAccessRootName(node) {
  let current = node.expression;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function readTypeReferenceNames(typeNode, ignoredTypeNames = new Set()) {
  if (!typeNode) return [];
  const names = [];
  visitTypeNode(typeNode, ignoredTypeNames);
  return unique(names);

  function visitTypeNode(node, activeIgnoredTypeNames) {
    const scopedIgnoredTypeNames = mergeNameSets(activeIgnoredTypeNames, readNodeTypeParameterNames(node));
    if (ts.isTypeReferenceNode(node)) {
      const name = readReferenceName(node.typeName);
      if (name && !isIgnoredTypeReferenceName(name, scopedIgnoredTypeNames)) names.push(name);
    }
    if (ts.isExpressionWithTypeArguments(node)) {
      const name = readReferenceName(node.expression);
      if (name && !isIgnoredTypeReferenceName(name, scopedIgnoredTypeNames)) names.push(name);
    }
    ts.forEachChild(node, child => visitTypeNode(child, scopedIgnoredTypeNames));
  }
}

function readNodeTypeParameterNames(node) {
  const names = readTypeParameterNames(node?.typeParameters);
  const typeParameter = node?.typeParameter;
  if (typeParameter?.name?.text) names.add(typeParameter.name.text);
  return names;
}

function isIgnoredTypeReferenceName(name, ignoredTypeNames = new Set()) {
  if (!name) return false;
  const normalized = String(name);
  if (ignoredTypeNames.has(normalized)) return true;
  if (TYPESCRIPT_BUILTIN_TYPE_REFERENCES.has(normalized)) return true;
  if (normalized.startsWith('globalThis.')) {
    return TYPESCRIPT_BUILTIN_TYPE_REFERENCES.has(normalized.slice('globalThis.'.length));
  }
  return false;
}

function readTypeParameterNames(typeParameters) {
  return new Set((typeParameters ?? [])
    .map(parameter => parameter.name?.text)
    .filter(Boolean));
}

function readTypeParameterList(typeParameters) {
  return [...readTypeParameterNames(typeParameters)];
}

function mergeNameSets(...sets) {
  const merged = new Set();
  for (const set of sets) {
    for (const value of set ?? []) {
      if (value) merged.add(value);
    }
  }
  return merged;
}

function isIgnoredInitializerReferenceName(name) {
  return isIgnoredTypeReferenceName(name) || isIgnoredValueReference(name);
}

function scriptKindForFile(filePath) {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.js$/i.test(filePath) || /\.mjs$/i.test(filePath) || /\.cjs$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function listFiles(projectRoot) {
  return buildSourceManifest(projectRoot).entries
    .map(entry => path.join(projectRoot, ...entry.path.split('/')));
}

function captureSourceManifest(projectRoot) {
  const manifest = buildSourceManifest(projectRoot);
  return {
    ...manifest,
    files: manifest.entries.map(entry => path.join(projectRoot, ...entry.path.split('/'))),
  };
}

function isJavaScriptFamilySource(filePath) {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(filePath)
    && !filePath.includes(`${path.sep}node_modules${path.sep}`);
}

function buildSpecMap(projectRoot, sourceFiles) {
  const specBySubject = new Map();
  for (const file of sourceFiles) {
    if (!isSpecFile(file)) continue;
    if (!isProjectSemanticTestSource(relative(projectRoot, file))) continue;
    specBySubject.set(stripSpecSuffix(file), file);
  }
  return specBySubject;
}

function isSpecFile(filePath) {
  return /\.(?:spec|test)(?:-[^.]+)?\.[cm]?[jt]sx?$/i.test(filePath);
}

function stripSpecSuffix(filePath) {
  return filePath.replace(/\.(?:spec|test)(?:-[^.]+)?(\.[cm]?[jt]sx?)$/i, '$1');
}

function collectAngular(projectRoot, sourceFiles, specBySubject) {
  const components = [];
  const directives = [];
  const pipes = [];
  const injectables = [];
  const injectors = [];
  const dynamicImports = [];
  const routes = [];
  const applicationProviders = [];

  for (const file of sourceFiles) {
    if (isSpecFile(file)) continue;

    const sourceText = readSnapshotFileUtf8(file);
    if (sourceText === null) continue;
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFile(file),
    );

    const fileDynamicImports = [];
    const fileInjects = [];
    const fileConstructorInjects = [];

    visit(source, node => {
      const injected = readInjectCall(node);
      if (injected) {
        fileInjects.push(injected);
      }

      const dynamicImport = readDynamicImport(projectRoot, file, node);
      if (dynamicImport) {
        fileDynamicImports.push(dynamicImport);
      }
    });

    for (const imported of fileDynamicImports) {
      dynamicImports.push({
        file: relative(projectRoot, file),
        target: imported,
      });
    }

    routes.push(...readRoutes(projectRoot, file, source));
    applicationProviders.push(...readAngularApplicationProviders(projectRoot, file, source));

    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const injectDependencyDetails = readInjectDependencyDetails(source, statement);
      const constructorDependencyDetails = readConstructorDependencyDetails(source, statement);
      const constructorDependencies = unique(constructorDependencyDetails.map(detail => detail.name));
      fileConstructorInjects.push(...constructorDependencies);

      const component = readComponent(
        projectRoot,
        file,
        source,
        statement,
        injectDependencyDetails,
        fileDynamicImports,
        constructorDependencyDetails,
        specBySubject,
      );
      if (component) {
        components.push(component);
      }

      const directive = readDirective(
        projectRoot,
        file,
        source,
        statement,
        injectDependencyDetails,
        constructorDependencyDetails,
        specBySubject,
      );
      if (directive) {
        directives.push(directive);
      }

      const pipe = readPipe(projectRoot, file, source, statement, specBySubject);
      if (pipe) {
        pipes.push(pipe);
      }

      const injectable = readInjectable(
        projectRoot,
        file,
        source,
        statement,
        injectDependencyDetails,
        constructorDependencyDetails,
        specBySubject,
      );
      if (injectable) {
        injectables.push(injectable);
      }
    }

    const dependencies = unique([...fileInjects, ...fileConstructorInjects]);
    if (dependencies.length > 0) {
      injectors.push({
        file: relative(projectRoot, file),
        dependencies,
      });
    }
  }

  return {
    components,
    directives,
    pipes,
    injectables,
    injectors,
    dynamicImports,
    routes,
    applicationProviders,
  };
}

function visit(node, visitor) {
  visitor(node);
  ts.forEachChild(node, child => visit(child, visitor));
}

function readInjectCall(node) {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'inject') return null;
  const firstArg = node.arguments[0];
  return readReferenceName(firstArg);
}

function readInjectDependencyDetails(source, classNode) {
  const details = [];
  visit(classNode, node => {
    const name = readInjectCall(node);
    if (!name) return;
    details.push({
      name,
      injectionKind: 'inject',
      line: readLine(source, node),
      column: readColumn(source, node),
      matchedNeedle: node.getText(source),
    });
  });
  return uniqueObjects(details);
}

function readReferenceName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isQualifiedName(node)) {
    const left = readReferenceName(node.left);
    return left ? `${left}.${node.right.text}` : node.right.text;
  }
  if (ts.isPropertyAccessExpression(node)) return node.getText();
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return readReferenceName(node.expression);
  }
  return null;
}

function readDynamicImport(projectRoot, sourceFile, node) {
  if (!ts.isCallExpression(node)) return null;
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;

  const firstArg = node.arguments[0];
  if (!firstArg || !ts.isStringLiteralLike(firstArg)) return null;

  return resolveImportPath(projectRoot, sourceFile, firstArg.text);
}

function readComponent(
  projectRoot,
  file,
  source,
  classNode,
  injectDependencyDetails,
  fileDynamicImports,
  constructorDependencyDetails,
  specBySubject,
) {
  const decorator = findDecoratorCall(classNode, 'Component');
  if (!decorator) return null;

  const metadata = decorator.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return null;

  const className = classNode.name.text;
  const selector = readStringProperty(metadata, 'selector');
  const templateUrl = readPathProperty(projectRoot, file, metadata, 'templateUrl');
  const templateInline = readStringProperty(metadata, 'template') !== null;
  const styleUrls = [
    ...readPathArrayProperty(projectRoot, file, metadata, 'styleUrls'),
    ...readPathArrayProperty(projectRoot, file, metadata, 'styleUrl'),
  ];
  const inlineTemplateInfo = readStringPropertyWithStartLine(source, metadata, 'template');
  const inlineTemplate = inlineTemplateInfo?.text ?? null;
  const classSemantics = readClassSemantics(source, classNode);
  const hostMetadata = readHostMetadataProperty(source, metadata);
  const testMappings = findTestMappings(projectRoot, file, specBySubject);
  const importDetails = readReferenceArrayPropertyDetails(source, metadata, 'imports');
  const providerDetails = readReferenceArrayPropertyDetails(source, metadata, 'providers');
  const dependencyDetails = uniqueObjects([
    ...injectDependencyDetails,
    ...constructorDependencyDetails,
  ]);
  const constructorDependencies = unique(constructorDependencyDetails.map(detail => detail.name));

  return {
    className,
    file: relative(projectRoot, file),
    selector,
    standalone: readBooleanProperty(metadata, 'standalone'),
    changeDetection: readChangeDetection(metadata),
    imports: unique(importDetails.map(detail => detail.name)),
    importDetails,
    providers: unique(providerDetails.map(detail => detail.name)),
    providerDetails,
    hostDirectives: readHostDirectivesProperty(source, metadata),
    templateUrl,
    templateInline,
    styleUrls,
    dependencies: unique(dependencyDetails.map(detail => detail.name)),
    dependencyDetails,
    constructorDependencies,
    dynamicImports: unique(fileDynamicImports),
    inputs: classSemantics.inputs,
    outputs: classSemantics.outputs,
    models: classSemantics.models,
    queries: classSemantics.queries,
    signals: classSemantics.signals,
    hostAttributes: hostMetadata.attributes,
    hostBindings: uniqueObjects([...classSemantics.hostBindings, ...hostMetadata.bindings]),
    hostListeners: uniqueObjects([...classSemantics.hostListeners, ...hostMetadata.listeners]),
    templateBindings: readTemplateBindings(projectRoot, templateUrl, inlineTemplate, inlineTemplateInfo?.startLine),
    templateUsages: readTemplateUsages(projectRoot, templateUrl, inlineTemplate, inlineTemplateInfo?.startLine),
    line: readLine(source, classNode),
    tests: testFilesFromMappings(testMappings),
    testMappings,
  };
}

function readDirective(
  projectRoot,
  file,
  source,
  classNode,
  injectDependencyDetails,
  constructorDependencyDetails,
  specBySubject,
) {
  const decorator = findDecoratorCall(classNode, 'Directive');
  if (!decorator) return null;

  const metadata = decorator.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return null;

  const classSemantics = readClassSemantics(source, classNode);
  const hostMetadata = readHostMetadataProperty(source, metadata);
  const testMappings = findTestMappings(projectRoot, file, specBySubject);
  const providerDetails = readReferenceArrayPropertyDetails(source, metadata, 'providers');
  const dependencyDetails = uniqueObjects([
    ...injectDependencyDetails,
    ...constructorDependencyDetails,
  ]);
  const constructorDependencies = unique(constructorDependencyDetails.map(detail => detail.name));
  return {
    className: classNode.name.text,
    file: relative(projectRoot, file),
    selector: readStringProperty(metadata, 'selector'),
    standalone: readBooleanProperty(metadata, 'standalone'),
    providers: unique(providerDetails.map(detail => detail.name)),
    providerDetails,
    hostDirectives: readHostDirectivesProperty(source, metadata),
    dependencies: unique(dependencyDetails.map(detail => detail.name)),
    dependencyDetails,
    constructorDependencies,
    inputs: classSemantics.inputs,
    outputs: classSemantics.outputs,
    hostAttributes: hostMetadata.attributes,
    hostBindings: uniqueObjects([...classSemantics.hostBindings, ...hostMetadata.bindings]),
    hostListeners: uniqueObjects([...classSemantics.hostListeners, ...hostMetadata.listeners]),
    line: readLine(source, classNode),
    tests: testFilesFromMappings(testMappings),
    testMappings,
  };
}

function readPipe(projectRoot, file, source, classNode, specBySubject) {
  const decorator = findDecoratorCall(classNode, 'Pipe');
  if (!decorator) return null;

  const metadata = decorator.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return null;
  const testMappings = findTestMappings(projectRoot, file, specBySubject);

  return {
    className: classNode.name.text,
    file: relative(projectRoot, file),
    name: readStringProperty(metadata, 'name'),
    standalone: readBooleanProperty(metadata, 'standalone'),
    pure: readBooleanProperty(metadata, 'pure'),
    line: readLine(source, classNode),
    tests: testFilesFromMappings(testMappings),
    testMappings,
  };
}

function readInjectable(
  projectRoot,
  file,
  source,
  classNode,
  injectDependencyDetails,
  constructorDependencyDetails,
  specBySubject,
) {
  const decorator = findDecoratorCall(classNode, 'Injectable');
  if (!decorator) return null;

  const metadata = decorator.arguments[0];
  const providedIn = metadata && ts.isObjectLiteralExpression(metadata)
    ? readProviderScope(metadata, 'providedIn')
    : null;
  const testMappings = findReferencingTestMappings(projectRoot, classNode.name.text, specBySubject);
  const dependencyDetails = uniqueObjects([
    ...injectDependencyDetails,
    ...constructorDependencyDetails,
  ]);
  const constructorDependencies = unique(constructorDependencyDetails.map(detail => detail.name));

  return {
    className: classNode.name.text,
    file: relative(projectRoot, file),
    providedIn,
    dependencies: unique(dependencyDetails.map(detail => detail.name)),
    dependencyDetails,
    constructorDependencies,
    line: readLine(source, classNode),
    tests: testFilesFromMappings(testMappings),
    testMappings,
  };
}

function readProviderScope(objectLiteral, name) {
  const initializer = readPropertyInitializer(objectLiteral, name);
  return readReferenceName(initializer);
}

function buildNativeGraph(overlay) {
  const graphUpdatedAt = Date.parse(overlay.generatedAt) || Date.now();
  const nodesById = new Map();
  const symbolNodesByName = new Map();
  const symbolNodesByFileAndName = new Map();
  const importAliasesByFileAndName = buildImportAliasIndex(overlay);
  const exportTargetsByFileAndName = buildExportTargetIndex(overlay);
  const supabaseSelectFieldsByConfig = new Map();
  const supabaseIncrementalPredicates = [];
  const supabaseEdgeFunctionRoutesByInvokeName = buildSupabaseEdgeFunctionRouteIndex(overlay);
  const hardRuleImplementationsByKeyword = buildHardRuleImplementationIndex(overlay);
  const angularTemplateUsageIndex = buildAngularTemplateUsageIndex(overlay);
  const edges = [];
  const edgeKeys = new Set();

  const addNode = (kind, name, filePath, options = {}) => {
    if (!name) return null;
    const language = normalizeCodeGraphLanguage(options.language ?? inferLanguage(filePath));
    const id = options.id ?? graphNodeId(kind, filePath, name);
    const location = nativeNodeLocation(options);
    const node = stripNullValues({
      id,
      kind,
      name,
      qualifiedName: options.qualifiedName ?? name,
      filePath,
      language,
      ...location,
      docstring: options.docstring ?? null,
      signature: options.signature ?? null,
      visibility: options.visibility ?? null,
      decorators: normalizeDecoratorNames(options.decorators),
      typeParameters: nonEmptyArray(options.typeParameters),
      returnType: isCallableGraphNodeKind(kind) ? options.returnType ?? options.returns ?? null : null,
      isExported: options.isExported ?? null,
      isAsync: options.isAsync ?? null,
      isStatic: options.isStatic ?? null,
      isAbstract: options.isAbstract ?? null,
      metadata: nonEmptyObject(options.metadata),
      updatedAt: options.updatedAt ?? graphUpdatedAt,
    });

    const existing = nodesById.get(id);
    if (existing) {
      nodesById.set(id, mergeNode(existing, node));
    } else {
      nodesById.set(id, node);
    }

    if (isSymbolLikeKind(kind)) {
      const normalized = normalizeSymbolName(name);
      if (!symbolNodesByName.has(normalized)) {
        symbolNodesByName.set(normalized, id);
      }
      const scopedKey = symbolKey(filePath, name);
      if (!symbolNodesByFileAndName.has(scopedKey)) {
        symbolNodesByFileAndName.set(scopedKey, id);
      }
      if (node.qualifiedName && node.qualifiedName !== name) {
        const qualifiedKey = symbolKey(filePath, node.qualifiedName);
        if (!symbolNodesByFileAndName.has(qualifiedKey)) {
          symbolNodesByFileAndName.set(qualifiedKey, id);
        }
      }
    }

    return id;
  };

  const addReferenceNode = (name, filePath, options = {}) => {
    if (options.qualifiedName) {
      const qualifiedId = symbolNodesByFileAndName.get(symbolKey(filePath, options.qualifiedName));
      if (qualifiedId) return qualifiedId;
    }
    const scopedId = resolveReferenceNodeId(
      name,
      filePath,
      options,
      symbolNodesByFileAndName,
      importAliasesByFileAndName,
      exportTargetsByFileAndName,
    );
    if (scopedId) {
      return scopedId;
    }
    if (options.allowGlobalFallback !== false) {
      const normalized = normalizeSymbolName(name);
      if (symbolNodesByName.has(normalized)) {
        return symbolNodesByName.get(normalized);
      }
    }
    if (options.materializeUnresolved === false) {
      return null;
    }
    return addNode(options.kind ?? 'variable', name, filePath ?? options.filePath ?? '', {
      line: options.line,
      startLine: options.startLine,
      endLine: options.endLine,
      startColumn: options.startColumn,
      endColumn: options.endColumn,
      metadata: {
        relation: options.relation ?? 'external-reference',
        ...(options.metadata ?? {}),
      },
    });
  };

  const addEdge = (kind, sourceId, targetId, metadata = {}, options = {}) => {
    if (!sourceId || !targetId) return;
    const { line: metadataLine, column: metadataColumn, ...edgeMetadata } = metadata ?? {};
    const metadataColumnIsPosition = typeof metadataColumn === 'number';
    if (!metadataColumnIsPosition && metadataColumn !== undefined) {
      edgeMetadata.column = metadataColumn;
    }
    const edge = stripNullValues({
      kind,
      source: sourceId,
      target: targetId,
      line: options.line ?? metadataLine ?? null,
      column: options.column ?? (metadataColumnIsPosition ? metadataColumn : null),
      provenance: options.provenance ?? null,
      metadata: stripNullValues(edgeMetadata),
    });
    const key = JSON.stringify(edge);
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };

  const addCallableEdges = (sourceId, sourceFile, item) => {
    addTypeScriptCallableEdges(
      addNode,
      addReferenceNode,
      addEdge,
      sourceId,
      sourceFile,
      item,
      supabaseSelectFieldsByConfig,
      supabaseIncrementalPredicates,
      supabaseEdgeFunctionRoutesByInvokeName,
    );
  };

  for (const file of overlay.typescript?.files ?? []) {
    addNode('file', file.file, file.file, {
      language: file.language,
      metadata: { relation: 'source-file' },
    });
  }

  for (const classSymbol of overlay.typescript?.classes ?? []) {
    const classId = addNode('class', classSymbol.className, classSymbol.file, {
      id: graphNodeId('class', classSymbol.file, classSymbol.qualifiedName ?? classSymbol.className),
      ...nodeOptions(classSymbol),
      signature: classSymbol.signature ?? `class ${classSymbol.className}`,
    });
    registerDefaultExportAlias(classSymbol, classId, symbolNodesByFileAndName);
  }

  for (const interfaceSymbol of overlay.typescript?.interfaces ?? []) {
    const interfaceId = addNode('interface', interfaceSymbol.name, interfaceSymbol.file, {
      id: graphNodeId('interface', interfaceSymbol.file, interfaceSymbol.qualifiedName ?? interfaceSymbol.name),
      ...nodeOptions(interfaceSymbol),
      signature: interfaceSymbol.signature ?? `interface ${interfaceSymbol.name}`,
    });
    registerDefaultExportAlias(interfaceSymbol, interfaceId, symbolNodesByFileAndName);
  }

  for (const typeSymbol of overlay.typescript?.types ?? []) {
    const typeId = addNode('type_alias', typeSymbol.name, typeSymbol.file, {
      id: graphNodeId('type_alias', typeSymbol.file, typeSymbol.qualifiedName ?? typeSymbol.name),
      ...nodeOptions(typeSymbol),
      signature: typeSymbol.signature ?? `type ${typeSymbol.name}`,
    });
    registerDefaultExportAlias(typeSymbol, typeId, symbolNodesByFileAndName);
  }

  for (const variableSymbol of overlay.typescript?.variables ?? []) {
    const variableId = addNode(variableKind(variableSymbol), variableSymbol.name, variableSymbol.file, {
      id: graphNodeId(variableKind(variableSymbol), variableSymbol.file, variableSymbol.qualifiedName ?? variableSymbol.name),
      ...nodeOptions(variableSymbol),
      signature: variableSymbol.signature ?? `const ${variableSymbol.name}`,
    });
    for (const configProperty of variableSymbol.configProperties ?? []) {
      const propertyId = addNode('property', configProperty.name, variableSymbol.file, {
        id: graphNodeId('property', variableSymbol.file, configProperty.qualifiedName ?? configProperty.name),
        ...nodeOptions(configProperty),
        signature: configProperty.signature ?? `${configProperty.name}`,
        metadata: {
          relation: 'config-property',
          configObject: configProperty.configObject,
          configPath: configProperty.configPath,
          parentConfigPath: configProperty.parentConfigPath,
          configProperty: configProperty.configProperty,
        },
      });
      const parentPropertyId = configProperty.parentConfigPath
        ? symbolNodesByFileAndName.get(symbolKey(
          variableSymbol.file,
          `${configProperty.configObject}.${configProperty.parentConfigPath}`,
        ))
        : null;
      addEdge('contains', parentPropertyId ?? variableId, propertyId, {
        relation: 'config-property',
        configObject: configProperty.configObject,
        configPath: configProperty.configPath,
        parentConfigPath: configProperty.parentConfigPath,
        configProperty: configProperty.configProperty,
      });
    }
    for (const selectField of variableSymbol.supabaseSelectFields ?? []) {
      const fieldId = addNode('property', selectField.name, variableSymbol.file, {
        id: graphNodeId('property', variableSymbol.file, `${selectField.selectConfig}.${selectField.field}`),
        ...nodeOptions(selectField),
        signature: selectField.signature ?? `${selectField.qualifiedName}`,
        metadata: {
          relation: 'supabase-select-field',
          table: selectField.table,
          field: selectField.field,
          selectConfig: selectField.selectConfig,
        },
      });
      if (!supabaseSelectFieldsByConfig.has(selectField.selectConfig)) {
        supabaseSelectFieldsByConfig.set(selectField.selectConfig, []);
      }
      supabaseSelectFieldsByConfig.get(selectField.selectConfig).push({
        ...selectField,
        id: fieldId,
      });
      addEdge('contains', variableId, fieldId, {
        relation: 'supabase-select-field',
        table: selectField.table,
        field: selectField.field,
        selectConfig: selectField.selectConfig,
      });
    }
  }

  for (const functionSymbol of overlay.typescript?.functions ?? []) {
    const functionId = addNode('function', functionSymbol.name, functionSymbol.file, {
      id: graphNodeId('function', functionSymbol.file, functionSymbol.qualifiedName ?? functionSymbol.name),
      ...nodeOptions(functionSymbol),
      signature: functionSymbol.signature ?? `function ${functionSymbol.name}`,
      metadata: functionSymbol.overloads
        ? {
          overloads: functionSymbol.overloads,
          overloadSignatures: functionSymbol.overloadSignatures,
        }
        : null,
    });
    registerDefaultExportAlias(functionSymbol, functionId, symbolNodesByFileAndName);
  }

  for (const enumSymbol of overlay.typescript?.enums ?? []) {
    const enumId = addNode('enum', enumSymbol.name, enumSymbol.file, {
      id: graphNodeId('enum', enumSymbol.file, enumSymbol.qualifiedName ?? enumSymbol.name),
      ...nodeOptions(enumSymbol),
      signature: enumSymbol.signature ?? `enum ${enumSymbol.name}`,
    });
    registerDefaultExportAlias(enumSymbol, enumId, symbolNodesByFileAndName);
  }

  for (const namespaceSymbol of overlay.typescript?.namespaces ?? []) {
    addNode('namespace', namespaceSymbol.name, namespaceSymbol.file, {
      id: graphNodeId('namespace', namespaceSymbol.file, namespaceSymbol.name),
      ...nodeOptions(namespaceSymbol),
      signature: namespaceSymbol.signature ?? `namespace ${namespaceSymbol.name}`,
    });
  }

  for (const importSymbol of overlay.typescript?.imports ?? []) {
    addNode('import', importSymbol.name, importSymbol.file, {
      id: graphNodeId('import', importSymbol.file, `${importSymbol.name}:${importSymbol.target ?? ''}:${importSymbol.importedName ?? ''}:${importSymbol.line ?? ''}`),
      ...nodeOptions(importSymbol),
      signature: importSymbol.importedName
        ? `import ${importSymbol.name} from ${importSymbol.target}`
        : `import ${importSymbol.name}`,
      metadata: {
        importedName: importSymbol.importedName ?? null,
        target: importSymbol.target ?? null,
        relation: importSymbol.relation ?? 'import',
        isTypeOnly: Boolean(importSymbol.isTypeOnly),
      },
    });
  }

  for (const exportSymbol of overlay.typescript?.exports ?? []) {
    addNode('export', exportSymbol.exportName ?? exportSymbol.name, exportSymbol.file, {
      id: graphNodeId('export', exportSymbol.file, `${exportSymbol.exportName ?? exportSymbol.name}:${exportSymbol.target ?? ''}:${exportSymbol.line ?? ''}`),
      ...nodeOptions(exportSymbol),
      signature: `export ${exportSymbol.exportName ?? exportSymbol.name}`,
      metadata: {
        name: exportSymbol.name,
        exportName: exportSymbol.exportName,
        target: exportSymbol.target ?? null,
        relation: exportSymbol.relation ?? 'export',
        isTypeOnly: Boolean(exportSymbol.isTypeOnly),
      },
    });
  }

  for (const classSymbol of overlay.typescript?.classes ?? []) {
    const classId = graphNodeId('class', classSymbol.file, classSymbol.qualifiedName ?? classSymbol.className);
    addFileContainsEdge(addReferenceNode, addEdge, classSymbol.file, classId);
    addLocalDeclarationEdge(addReferenceNode, addEdge, classSymbol, classId);
    for (const decorator of classSymbol.decorators ?? []) {
      addEdge('decorates', classId, addReferenceNode(decorator.name, classSymbol.file, { relation: 'decorator' }), {
        relation: 'decorator',
        line: decorator.line,
        column: decorator.column,
      });
      for (const argumentReference of decorator.argumentReferences ?? []) {
        addEdge('references', classId, addReferenceNode(argumentReference, classSymbol.file, {
          relation: 'decorator-argument',
          allowGlobalFallback: false,
        }), {
          relation: 'decorator-argument',
          line: decorator.line,
          column: decorator.column,
        });
      }
    }
    for (const baseClass of classSymbol.extends ?? []) {
      addEdge('extends', classId, addReferenceNode(baseClass, classSymbol.file, { relation: 'extends' }), {
        relation: 'extends',
      });
    }
    for (const implemented of classSymbol.implements ?? []) {
      addEdge('implements', classId, addReferenceNode(implemented, classSymbol.file, { relation: 'implements' }), {
        relation: 'implements',
      });
    }
    for (const instantiated of classSymbol.instantiates ?? []) {
      addEdge('instantiates', classId, addReferenceNode(instantiated, classSymbol.file, { relation: 'new' }), {
        relation: 'new',
      });
    }
    for (const typeReference of classSymbol.typeReferences ?? []) {
      addTypeReferenceEdge(addReferenceNode, addEdge, classId, classSymbol.file, typeReference);
    }
    addTypeParameterReferenceEdges(addReferenceNode, addEdge, classId, classSymbol.file, classSymbol.typeParameterReferences);
    for (const valueReference of classSymbol.valueReferences ?? []) {
      addValueReferenceEdge(addReferenceNode, addEdge, classId, classSymbol.file, valueReference);
    }
    for (const jsxReference of classSymbol.jsxReferences ?? []) {
      addJsxReferenceEdge(addReferenceNode, addEdge, classId, classSymbol.file, jsxReference);
    }
    for (const property of classSymbol.properties ?? []) {
      const propertyId = addNode('property', property.name, classSymbol.file, {
        id: graphNodeId('property', classSymbol.file, `${classSymbol.qualifiedName ?? classSymbol.className}.${property.name}`),
        qualifiedName: `${classSymbol.qualifiedName ?? classSymbol.className}::${property.name}`,
        ...property,
      });
      addEdge('contains', classId, propertyId, { relation: 'class-member' });
      addMemberSemanticEdges(addReferenceNode, addEdge, propertyId, classSymbol.file, classSymbol, property);
      addCallableEdges(propertyId, classSymbol.file, property);
      for (const typeReference of property.typeReferences ?? []) {
        addTypeReferenceEdge(addReferenceNode, addEdge, propertyId, classSymbol.file, typeReference);
      }
      for (const valueReference of property.valueReferences ?? []) {
        addValueReferenceEdge(addReferenceNode, addEdge, propertyId, classSymbol.file, valueReference);
      }
      for (const jsxReference of property.jsxReferences ?? []) {
        addJsxReferenceEdge(addReferenceNode, addEdge, propertyId, classSymbol.file, jsxReference);
      }
    }
    for (const method of classSymbol.methods ?? []) {
      const methodId = addNode('method', method.name, classSymbol.file, {
        id: graphNodeId('method', classSymbol.file, `${classSymbol.qualifiedName ?? classSymbol.className}.${method.name}`),
        qualifiedName: `${classSymbol.qualifiedName ?? classSymbol.className}::${method.name}`,
        ...method,
        signature: method.signature ?? `${method.name}()`,
      });
      addEdge('contains', classId, methodId, { relation: 'class-member' });
      addMemberSemanticEdges(addReferenceNode, addEdge, methodId, classSymbol.file, classSymbol, method);
      addCallableEdges(methodId, classSymbol.file, method);
      addParameterEdges(addNode, addReferenceNode, addEdge, methodId, classSymbol.file, `${classSymbol.qualifiedName ?? classSymbol.className}.${method.name}`, `${classSymbol.qualifiedName ?? classSymbol.className}::${method.name}`, method.parameters);
      addTypeParameterReferenceEdges(addReferenceNode, addEdge, methodId, classSymbol.file, method.typeParameterReferences);
      for (const typeReference of method.typeReferences ?? []) {
        addTypeReferenceEdge(addReferenceNode, addEdge, methodId, classSymbol.file, typeReference);
      }
      for (const valueReference of method.valueReferences ?? []) {
        addValueReferenceEdge(addReferenceNode, addEdge, methodId, classSymbol.file, valueReference);
      }
      for (const jsxReference of method.jsxReferences ?? []) {
        addJsxReferenceEdge(addReferenceNode, addEdge, methodId, classSymbol.file, jsxReference);
      }
    }
  }

  for (const interfaceSymbol of overlay.typescript?.interfaces ?? []) {
    const interfaceId = addNode('interface', interfaceSymbol.name, interfaceSymbol.file, {
      id: graphNodeId('interface', interfaceSymbol.file, interfaceSymbol.qualifiedName ?? interfaceSymbol.name),
      ...nodeOptions(interfaceSymbol),
      signature: interfaceSymbol.signature ?? `interface ${interfaceSymbol.name}`,
    });
    addFileContainsEdge(addReferenceNode, addEdge, interfaceSymbol.file, interfaceId);
    addLocalDeclarationEdge(addReferenceNode, addEdge, interfaceSymbol, interfaceId);
    for (const baseInterface of interfaceSymbol.extends ?? []) {
      addEdge('extends', interfaceId, addReferenceNode(baseInterface, interfaceSymbol.file, { relation: 'extends' }), {
        relation: 'extends',
      });
    }
    for (const typeReference of interfaceSymbol.typeReferences ?? []) {
      addTypeReferenceEdge(addReferenceNode, addEdge, interfaceId, interfaceSymbol.file, typeReference);
    }
    addTypeParameterReferenceEdges(addReferenceNode, addEdge, interfaceId, interfaceSymbol.file, interfaceSymbol.typeParameterReferences);
    for (const property of interfaceSymbol.properties ?? []) {
      const propertyId = addNode('property', property.name, interfaceSymbol.file, {
        id: graphNodeId('property', interfaceSymbol.file, `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}.${property.name}`),
        qualifiedName: `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}::${property.name}`,
        ...property,
      });
      addEdge('contains', interfaceId, propertyId, { relation: 'interface-member' });
      addCallableEdges(propertyId, interfaceSymbol.file, property);
      addParameterEdges(addNode, addReferenceNode, addEdge, propertyId, interfaceSymbol.file, `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}.${property.name}`, `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}::${property.name}`, property.parameters);
      for (const typeReference of property.typeReferences ?? []) {
        addTypeReferenceEdge(addReferenceNode, addEdge, propertyId, interfaceSymbol.file, typeReference);
      }
    }
    for (const method of interfaceSymbol.methods ?? []) {
      const methodId = addNode('method', method.name, interfaceSymbol.file, {
        id: graphNodeId('method', interfaceSymbol.file, `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}.${method.name}`),
        qualifiedName: `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}::${method.name}`,
        ...method,
      });
      addEdge('contains', interfaceId, methodId, { relation: 'interface-member' });
      addCallableEdges(methodId, interfaceSymbol.file, method);
      addParameterEdges(addNode, addReferenceNode, addEdge, methodId, interfaceSymbol.file, `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}.${method.name}`, `${interfaceSymbol.qualifiedName ?? interfaceSymbol.name}::${method.name}`, method.parameters);
      addTypeParameterReferenceEdges(addReferenceNode, addEdge, methodId, interfaceSymbol.file, method.typeParameterReferences);
      for (const typeReference of method.typeReferences ?? []) {
        addTypeReferenceEdge(addReferenceNode, addEdge, methodId, interfaceSymbol.file, typeReference);
      }
    }
  }

  for (const typeSymbol of overlay.typescript?.types ?? []) {
    const typeId = addNode('type_alias', typeSymbol.name, typeSymbol.file, {
      id: graphNodeId('type_alias', typeSymbol.file, typeSymbol.qualifiedName ?? typeSymbol.name),
      ...nodeOptions(typeSymbol),
      signature: typeSymbol.signature ?? `type ${typeSymbol.name}`,
    });
    addFileContainsEdge(addReferenceNode, addEdge, typeSymbol.file, typeId);
    addLocalDeclarationEdge(addReferenceNode, addEdge, typeSymbol, typeId);
    for (const typeReference of typeSymbol.typeReferences ?? []) {
      addTypeReferenceEdge(addReferenceNode, addEdge, typeId, typeSymbol.file, typeReference);
    }
    addTypeParameterReferenceEdges(addReferenceNode, addEdge, typeId, typeSymbol.file, typeSymbol.typeParameterReferences);
    for (const property of typeSymbol.properties ?? []) {
      const propertyId = addNode('property', property.name, typeSymbol.file, {
        id: graphNodeId('property', typeSymbol.file, `${typeSymbol.qualifiedName ?? typeSymbol.name}.${property.name}`),
        qualifiedName: `${typeSymbol.qualifiedName ?? typeSymbol.name}::${property.name}`,
        ...property,
      });
      addEdge('contains', typeId, propertyId, { relation: 'type-literal-member' });
      addCallableEdges(propertyId, typeSymbol.file, property);
      addParameterEdges(addNode, addReferenceNode, addEdge, propertyId, typeSymbol.file, `${typeSymbol.qualifiedName ?? typeSymbol.name}.${property.name}`, `${typeSymbol.qualifiedName ?? typeSymbol.name}::${property.name}`, property.parameters);
      for (const typeReference of property.typeReferences ?? []) {
        addTypeReferenceEdge(addReferenceNode, addEdge, propertyId, typeSymbol.file, typeReference);
      }
    }
    for (const method of typeSymbol.methods ?? []) {
      const methodId = addNode('method', method.name, typeSymbol.file, {
        id: graphNodeId('method', typeSymbol.file, `${typeSymbol.qualifiedName ?? typeSymbol.name}.${method.name}`),
        qualifiedName: `${typeSymbol.qualifiedName ?? typeSymbol.name}::${method.name}`,
        ...method,
      });
      addEdge('contains', typeId, methodId, { relation: 'type-literal-member' });
      addCallableEdges(methodId, typeSymbol.file, method);
      addParameterEdges(addNode, addReferenceNode, addEdge, methodId, typeSymbol.file, `${typeSymbol.qualifiedName ?? typeSymbol.name}.${method.name}`, `${typeSymbol.qualifiedName ?? typeSymbol.name}::${method.name}`, method.parameters);
      addTypeParameterReferenceEdges(addReferenceNode, addEdge, methodId, typeSymbol.file, method.typeParameterReferences);
      for (const typeReference of method.typeReferences ?? []) {
        addTypeReferenceEdge(addReferenceNode, addEdge, methodId, typeSymbol.file, typeReference);
      }
    }
  }

  addInterfaceImplementationEdges(overlay, addReferenceNode, addEdge);

  for (const variableSymbol of overlay.typescript?.variables ?? []) {
    const kind = variableKind(variableSymbol);
    const variableId = addNode(kind, variableSymbol.name, variableSymbol.file, {
      id: graphNodeId(kind, variableSymbol.file, variableSymbol.qualifiedName ?? variableSymbol.name),
      ...nodeOptions(variableSymbol),
      signature: variableSymbol.signature ?? `const ${variableSymbol.name}`,
    });
    addFileContainsEdge(addReferenceNode, addEdge, variableSymbol.file, variableId);
    addCallableEdges(variableId, variableSymbol.file, variableSymbol);
    for (const typeReference of variableSymbol.typeReferences ?? []) {
      addTypeReferenceEdge(addReferenceNode, addEdge, variableId, variableSymbol.file, typeReference);
    }
    for (const valueReference of variableSymbol.valueReferences ?? []) {
      addValueReferenceEdge(addReferenceNode, addEdge, variableId, variableSymbol.file, valueReference);
    }
    for (const jsxReference of variableSymbol.jsxReferences ?? []) {
      addJsxReferenceEdge(addReferenceNode, addEdge, variableId, variableSymbol.file, jsxReference);
    }
  }

  for (const functionSymbol of overlay.typescript?.functions ?? []) {
    const functionId = addNode('function', functionSymbol.name, functionSymbol.file, {
      id: graphNodeId('function', functionSymbol.file, functionSymbol.qualifiedName ?? functionSymbol.name),
      ...nodeOptions(functionSymbol),
      signature: functionSymbol.signature ?? `function ${functionSymbol.name}`,
      metadata: functionSymbol.overloads
        ? {
          overloads: functionSymbol.overloads,
          overloadSignatures: functionSymbol.overloadSignatures,
        }
        : null,
    });
    addFileContainsEdge(addReferenceNode, addEdge, functionSymbol.file, functionId);
    if (functionSymbol.objectOwnerName) {
      const ownerId = addReferenceNode(functionSymbol.objectOwnerName, functionSymbol.file, {
        kind: functionSymbol.objectOwnerKind ?? 'variable',
        qualifiedName: functionSymbol.objectOwnerQualifiedName ?? functionSymbol.objectOwnerName,
        relation: 'object-owner',
      });
      addEdge('contains', ownerId, functionId, { relation: 'object-function' });
    }
    if (functionSymbol.nestedOwnerQualifiedName) {
      const ownerId = addReferenceNode(readQualifiedNameLeaf(functionSymbol.nestedOwnerQualifiedName), functionSymbol.file, {
        kind: 'function',
        qualifiedName: functionSymbol.nestedOwnerQualifiedName,
        relation: 'nested-owner',
      });
      addEdge('contains', ownerId, functionId, { relation: 'nested-function' });
    }
    addCallableEdges(functionId, functionSymbol.file, functionSymbol);
    addParameterEdges(addNode, addReferenceNode, addEdge, functionId, functionSymbol.file, functionSymbol.qualifiedName ?? functionSymbol.name, functionSymbol.qualifiedName ?? functionSymbol.name, functionSymbol.parameters);
    addTypeParameterReferenceEdges(addReferenceNode, addEdge, functionId, functionSymbol.file, functionSymbol.typeParameterReferences);
    for (const localTypeReference of functionSymbol.localTypeReferences ?? []) {
      addEdge('type_of', functionId, addReferenceNode(localTypeReference, functionSymbol.file, { relation: 'local-variable-type' }), {
        relation: 'local-variable-type',
      });
    }
    for (const typeReference of functionSymbol.typeReferences ?? []) {
      addTypeReferenceEdge(addReferenceNode, addEdge, functionId, functionSymbol.file, typeReference);
    }
    for (const valueReference of functionSymbol.valueReferences ?? []) {
      addValueReferenceEdge(addReferenceNode, addEdge, functionId, functionSymbol.file, valueReference);
    }
    for (const jsxReference of functionSymbol.jsxReferences ?? []) {
      addJsxReferenceEdge(addReferenceNode, addEdge, functionId, functionSymbol.file, jsxReference);
    }
  }

  for (const enumSymbol of overlay.typescript?.enums ?? []) {
    const enumId = addNode('enum', enumSymbol.name, enumSymbol.file, {
      id: graphNodeId('enum', enumSymbol.file, enumSymbol.qualifiedName ?? enumSymbol.name),
      ...nodeOptions(enumSymbol),
      signature: enumSymbol.signature ?? `enum ${enumSymbol.name}`,
    });
    addFileContainsEdge(addReferenceNode, addEdge, enumSymbol.file, enumId);
    addLocalDeclarationEdge(addReferenceNode, addEdge, enumSymbol, enumId);
    for (const member of enumSymbol.members ?? []) {
      const memberId = addNode('enum_member', member.name, enumSymbol.file, {
        id: graphNodeId('enum_member', enumSymbol.file, `${enumSymbol.qualifiedName ?? enumSymbol.name}.${member.name}`),
        qualifiedName: `${enumSymbol.qualifiedName ?? enumSymbol.name}::${member.name}`,
        ...nodeOptions(member),
        signature: member.signature ?? member.name,
      });
      addEdge('contains', enumId, memberId, { relation: 'enum-member' });
    }
  }

  for (const namespaceSymbol of overlay.typescript?.namespaces ?? []) {
    const namespaceId = addNode('namespace', namespaceSymbol.name, namespaceSymbol.file, {
      id: graphNodeId('namespace', namespaceSymbol.file, namespaceSymbol.name),
      ...nodeOptions(namespaceSymbol),
      signature: namespaceSymbol.signature ?? `namespace ${namespaceSymbol.name}`,
    });
    addFileContainsEdge(addReferenceNode, addEdge, namespaceSymbol.file, namespaceId);
    for (const member of namespaceSymbol.members ?? []) {
      const memberId = addReferenceNode(member.name, namespaceSymbol.file, {
        kind: member.kind,
        filePath: namespaceSymbol.file,
        qualifiedName: `${namespaceSymbol.name}::${member.name}`,
        relation: 'namespace-member',
      });
      addEdge('contains', namespaceId, memberId, { relation: 'namespace-member' });
    }
  }

  for (const importSymbol of overlay.typescript?.imports ?? []) {
    const sourceId = addReferenceNode(importSymbol.name, importSymbol.file, { kind: 'import', relation: 'import' });
    const targetId = addNode('file', importSymbol.target, importSymbol.target, {
      metadata: { relation: 'import' },
    });
    const importNodeId = graphNodeId('import', importSymbol.file, `${importSymbol.name}:${importSymbol.target ?? ''}:${importSymbol.importedName ?? ''}:${importSymbol.line ?? ''}`);
    addFileContainsEdge(addReferenceNode, addEdge, importSymbol.file, importNodeId);
    addEdge('imports', sourceId, targetId, {
      relation: importSymbol.relation ?? 'import',
      line: importSymbol.line,
      importedName: importSymbol.importedName,
      isTypeOnly: importSymbol.isTypeOnly,
    });
  }

  for (const exportSymbol of overlay.typescript?.exports ?? []) {
    const sourceId = addReferenceNode(exportSymbol.targetName ?? exportSymbol.name, exportSymbol.file, { kind: 'export', relation: 'export' });
    const targetFile = exportSymbol.target ?? exportSymbol.file;
    const targetId = addNode('file', targetFile, targetFile, {
      metadata: { relation: exportSymbol.relation === 're-export' ? 're-export-file' : 'export-file' },
    });
    const exportNodeId = graphNodeId('export', exportSymbol.file, `${exportSymbol.exportName ?? exportSymbol.name}:${exportSymbol.target ?? ''}:${exportSymbol.line ?? ''}`);
    addFileContainsEdge(addReferenceNode, addEdge, exportSymbol.file, exportNodeId);
    addEdge('exports', sourceId, targetId, {
      relation: exportSymbol.relation ?? 'export',
      line: exportSymbol.line,
      exportName: exportSymbol.exportName,
      targetName: exportSymbol.targetName,
      isTypeOnly: exportSymbol.isTypeOnly,
    });
  }

  for (const component of overlay.angular?.components ?? []) {
    addNode('component', component.className, component.file, {
      line: component.line,
      signature: `class ${component.className}`,
      metadata: {
        framework: 'angular',
        decorator: 'Component',
        selector: component.selector,
        standalone: component.standalone,
        changeDetection: component.changeDetection,
      },
    });
  }

  for (const directive of overlay.angular?.directives ?? []) {
    addNode('class', directive.className, directive.file, {
      line: directive.line,
      signature: `class ${directive.className}`,
      metadata: {
        framework: 'angular',
        decorator: 'Directive',
        selector: directive.selector,
        standalone: directive.standalone,
      },
    });
  }

  for (const pipe of overlay.angular?.pipes ?? []) {
    addNode('class', pipe.className, pipe.file, {
      line: pipe.line,
      signature: `class ${pipe.className}`,
      metadata: {
        framework: 'angular',
        decorator: 'Pipe',
        pipeName: pipe.name,
        standalone: pipe.standalone,
        pure: pipe.pure,
      },
    });
  }

  for (const injectable of overlay.angular?.injectables ?? []) {
    addNode('class', injectable.className, injectable.file, {
      line: injectable.line,
      signature: `class ${injectable.className}`,
      metadata: {
        framework: 'angular',
        decorator: 'Injectable',
        providedIn: injectable.providedIn,
      },
    });
  }

  for (const route of overlay.angular?.routes ?? []) {
    addNode('route', angularRouteGraphName(route), route.file, {
      line: route.line,
      metadata: {
        framework: 'angular',
        path: route.path,
        redirectTo: route.redirectTo,
        pathMatch: route.pathMatch,
        exportName: route.exportName,
      },
    });
  }

  for (const edgeFunction of overlay.supabase?.edgeFunctions ?? []) {
    // 以 serve()/Deno.serve() handler 行作为 Edge Function 节点锚点，
    // 避免源码窗口停留在文件头注释而看不到真实实现。
    addNode('function', edgeFunction.name, edgeFunction.entry, {
      line: edgeFunction.routes?.[0]?.line,
      metadata: {
        platform: 'supabase-edge-function',
        riskTags: edgeFunction.riskTags,
      },
    });
    for (const route of edgeFunction.routes ?? []) {
      addNode('route', route.path, edgeFunction.entry, {
        line: route.line,
        metadata: {
          platform: 'supabase-edge-function',
          relation: 'edge-function-route',
          invokeName: route.invokeName,
        },
      });
    }
    for (const method of edgeFunction.methods ?? []) {
      const methodFile = method.sourceFile ?? edgeFunction.entry;
      addNode('variable', method.method, methodFile, {
        id: graphNodeId('variable', methodFile, `edge-function-method:${edgeFunction.name}:${method.method}:${method.line ?? ''}`),
        line: method.line,
        metadata: {
          platform: 'supabase-edge-function',
          relation: 'edge-function-method',
          method: method.method,
          methodSource: method.methodSource,
          functionName: edgeFunction.name,
        },
      });
    }
    for (const header of edgeFunction.headers ?? []) {
      const headerFile = header.sourceFile ?? edgeFunction.entry;
      addNode('variable', header.header, headerFile, {
        id: graphNodeId('variable', headerFile, `edge-function-header:${edgeFunction.name}:${header.normalizedHeader}:${header.line ?? ''}`),
        line: header.line,
        metadata: {
          platform: 'supabase-edge-function',
          relation: 'edge-function-header',
          header: header.header,
          normalizedHeader: header.normalizedHeader,
          functionName: edgeFunction.name,
        },
      });
    }
  }

  for (const migration of overlay.supabase?.migrations ?? []) {
    addNode('file', migration.name, migration.file, {
      language: 'sql',
      metadata: {
        platform: 'supabase-migration',
        riskTags: migration.riskTags,
      },
    });
  }

  for (const hardRule of overlay.agentRules?.hardRules ?? []) {
    addNode('variable', hardRule.heading, hardRule.file, {
      line: hardRule.line,
      language: 'markdown',
      metadata: {
        source: 'AGENTS.md',
        relation: 'hard-rule',
        body: hardRule.body,
        keywords: hardRule.keywords,
      },
    });
  }

  for (const syncRule of overlay.agentRules?.syncRules ?? []) {
    addNode('variable', syncRule.name, syncRule.file, {
      id: graphNodeId('variable', syncRule.file, `sync-rule:${syncRule.ownerHeading}:${syncRule.name}`),
      line: syncRule.line,
      language: 'markdown',
      metadata: {
        source: 'AGENTS.md',
        relation: 'sync-rule',
        ownerHeading: syncRule.ownerHeading,
        body: syncRule.body,
        keywords: syncRule.keywords,
      },
    });
  }

  for (const doc of overlay.context7?.documents ?? []) {
    addNode('file', context7DocumentNodeName(doc), doc.file, {
      id: context7DocumentNodeId(doc),
      line: doc.line,
      language: 'unknown',
      signature: `Context7 doc ${context7DocumentNodeName(doc)}`,
      metadata: {
        source: 'docs/context7',
        relation: 'context7-doc',
        title: doc.title,
        categories: doc.categories,
        routeQueries: doc.routeQueries,
      },
    });
  }

  for (const category of overlay.context7?.categories ?? []) {
    addNode('variable', category.name, category.file, {
      id: context7CategoryNodeId(category),
      line: category.line,
      language: 'unknown',
      signature: `Context7 category ${category.name}`,
      metadata: {
        source: 'docs/context7/catalog.json',
        relation: 'context7-category',
        category: category.name,
        docs: category.docs,
      },
    });
  }

  for (const route of overlay.context7?.retrievalRoutes ?? []) {
    addNode('variable', route.query, route.file, {
      id: context7RetrievalRouteNodeId(route),
      line: route.line,
      language: 'unknown',
      signature: `Context7 retrieval route ${route.query}`,
      metadata: {
        source: 'docs/context7/catalog.json',
        relation: 'context7-retrieval-route',
        query: route.query,
        primary: route.primary,
        secondary: route.secondary,
      },
    });
  }

  for (const route of overlay.context7?.sourceMapRoutes ?? []) {
    addNode('variable', route.question, route.file, {
      id: context7SourceMapRouteNodeId(route),
      line: route.line,
      language: 'unknown',
      signature: `Context7 source map route ${route.question}`,
      metadata: {
        source: 'docs/context7/source-map.md',
        relation: 'context7-source-map-route',
        question: route.question,
        doc: route.doc,
        docs: context7SourceMapRouteDocs(route),
        sourcePaths: route.sourcePaths,
      },
    });
  }

  for (const file of overlay.android?.files ?? []) {
    addNode('file', file.file, file.file, {
      language: file.language,
      metadata: {
        platform: 'android',
        relation: file.relation ?? 'android-file',
      },
    });
  }

  for (const kotlinImport of overlay.android?.kotlinImports ?? []) {
    addNode('import', kotlinImport.name, kotlinImport.file, {
      id: graphNodeId(
        'import',
        kotlinImport.file,
        `${kotlinImport.name}:${kotlinImport.target ?? ''}:${kotlinImport.importedName ?? ''}:${kotlinImport.line ?? ''}`,
      ),
      qualifiedName: kotlinImport.qualifiedName ?? kotlinImport.target ?? kotlinImport.name,
      language: 'kotlin',
      line: kotlinImport.line,
      startLine: kotlinImport.startLine,
      endLine: kotlinImport.endLine,
      startColumn: kotlinImport.startColumn,
      endColumn: kotlinImport.endColumn,
      signature: kotlinImport.signature ?? `import ${kotlinImport.name}`,
      metadata: {
        platform: 'android',
        relation: 'android-kotlin-import',
        importedName: kotlinImport.importedName,
        alias: kotlinImport.alias,
        target: kotlinImport.target,
        packageName: kotlinImport.packageName,
        wildcard: Boolean(kotlinImport.wildcard),
      },
    });
  }

  for (const kotlinClass of overlay.android?.kotlinClasses ?? []) {
    const nodeKind = androidKotlinNodeKind(kotlinClass);
    addNode(nodeKind, kotlinClass.name, kotlinClass.file, {
      id: graphNodeId(nodeKind, kotlinClass.file, kotlinClass.qualifiedName ?? kotlinClass.name),
      qualifiedName: kotlinClass.qualifiedName ?? kotlinClass.name,
      language: 'kotlin',
      line: kotlinClass.line,
      startLine: kotlinClass.startLine,
      endLine: kotlinClass.endLine,
      signature: kotlinClass.signature ?? `${kotlinClass.classKind ?? 'class'} ${kotlinClass.name}`,
      decorators: androidKotlinAnnotationNames(kotlinClass),
      isAbstract: kotlinClass.isAbstract,
      isStatic: kotlinClass.classKind === 'object',
      metadata: {
        platform: 'android',
        relation: androidKotlinClassRelation(kotlinClass),
        packageName: kotlinClass.packageName,
        classKind: kotlinClass.classKind,
        declarationKind: kotlinClass.declarationKind,
        modifiers: kotlinClass.modifiers,
        annotationNames: androidKotlinAnnotationNames(kotlinClass),
        ownerName: kotlinClass.ownerName,
        ownerQualifiedName: kotlinClass.ownerQualifiedName,
      },
    });
  }

  for (const kotlinEnum of overlay.android?.kotlinEnums ?? []) {
    addNode('enum', kotlinEnum.name, kotlinEnum.file, {
      id: graphNodeId('enum', kotlinEnum.file, kotlinEnum.qualifiedName ?? kotlinEnum.name),
      qualifiedName: kotlinEnum.qualifiedName ?? kotlinEnum.name,
      language: 'kotlin',
      line: kotlinEnum.line,
      startLine: kotlinEnum.startLine,
      endLine: kotlinEnum.endLine,
      signature: `enum class ${kotlinEnum.name}`,
      decorators: androidKotlinAnnotationNames(kotlinEnum),
      metadata: {
        platform: 'android',
        relation: 'android-kotlin-enum',
        packageName: kotlinEnum.packageName,
        classKind: kotlinEnum.classKind,
        annotationNames: androidKotlinAnnotationNames(kotlinEnum),
      },
    });
    for (const member of kotlinEnum.members ?? []) {
      addNode('enum_member', member.name, member.file, {
        id: graphNodeId('enum_member', member.file, member.qualifiedName ?? member.name),
        qualifiedName: member.qualifiedName ?? member.name,
        language: 'kotlin',
        line: member.line,
        startLine: member.startLine,
        endLine: member.endLine,
        signature: member.signature,
        metadata: {
          platform: 'android',
          relation: 'android-kotlin-enum-member',
          packageName: member.packageName,
          ownerName: member.ownerName,
          ownerQualifiedName: member.ownerQualifiedName,
        },
      });
    }
  }

  for (const kotlinConstructor of overlay.android?.kotlinConstructors ?? []) {
    addNode('method', kotlinConstructor.name, kotlinConstructor.file, {
      id: graphNodeId('method', kotlinConstructor.file, kotlinConstructor.qualifiedName ?? kotlinConstructor.name),
      qualifiedName: kotlinConstructor.qualifiedName ?? kotlinConstructor.name,
      language: 'kotlin',
      line: kotlinConstructor.line,
      startLine: kotlinConstructor.startLine,
      endLine: kotlinConstructor.endLine,
      signature: kotlinConstructor.signature,
      decorators: androidKotlinAnnotationNames(kotlinConstructor),
      visibility: kotlinConstructor.visibility,
      isAsync: false,
      isStatic: false,
      metadata: {
        platform: 'android',
        relation: 'android-kotlin-constructor',
        packageName: kotlinConstructor.packageName,
        ownerName: kotlinConstructor.ownerName,
        ownerQualifiedName: kotlinConstructor.ownerQualifiedName,
        annotationNames: androidKotlinAnnotationNames(kotlinConstructor),
      },
    });
  }

  for (const kotlinProperty of overlay.android?.kotlinProperties ?? []) {
    addNode('property', kotlinProperty.name, kotlinProperty.file, {
      id: graphNodeId('property', kotlinProperty.file, kotlinProperty.qualifiedName ?? kotlinProperty.name),
      qualifiedName: kotlinProperty.qualifiedName ?? kotlinProperty.name,
      language: 'kotlin',
      line: kotlinProperty.line,
      startLine: kotlinProperty.startLine,
      endLine: kotlinProperty.endLine,
      signature: kotlinProperty.signature,
      decorators: androidKotlinAnnotationNames(kotlinProperty),
      visibility: kotlinProperty.visibility,
      isStatic: kotlinProperty.isStatic,
      metadata: {
        platform: 'android',
        relation: 'android-kotlin-property',
        packageName: kotlinProperty.packageName,
        ownerName: kotlinProperty.ownerName,
        ownerQualifiedName: kotlinProperty.ownerQualifiedName,
        isConst: kotlinProperty.isConst,
        isMutable: kotlinProperty.isMutable,
        isOverride: kotlinProperty.isOverride,
        constructorParameter: kotlinProperty.constructorParameter,
        typeName: kotlinProperty.typeName,
        annotationNames: androidKotlinAnnotationNames(kotlinProperty),
      },
    });
  }

  for (const kotlinMethod of overlay.android?.kotlinMethods ?? []) {
    addNode('method', kotlinMethod.name, kotlinMethod.file, {
      id: graphNodeId('method', kotlinMethod.file, kotlinMethod.qualifiedName ?? kotlinMethod.name),
      qualifiedName: kotlinMethod.qualifiedName ?? kotlinMethod.name,
      language: 'kotlin',
      line: kotlinMethod.line,
      startLine: kotlinMethod.startLine,
      endLine: kotlinMethod.endLine,
      signature: kotlinMethod.signature,
      decorators: androidKotlinAnnotationNames(kotlinMethod),
      visibility: kotlinMethod.visibility,
      isAsync: kotlinMethod.isAsync,
      isStatic: kotlinMethod.isStatic,
      returnType: kotlinMethod.returnType,
      metadata: {
        platform: 'android',
        relation: 'android-kotlin-method',
        packageName: kotlinMethod.packageName,
        ownerName: kotlinMethod.ownerName,
        ownerQualifiedName: kotlinMethod.ownerQualifiedName,
        isOverride: kotlinMethod.isOverride,
        annotationNames: androidKotlinAnnotationNames(kotlinMethod),
      },
    });
  }

  for (const kotlinFunction of overlay.android?.kotlinFunctions ?? []) {
    addNode('function', kotlinFunction.name, kotlinFunction.file, {
      id: graphNodeId('function', kotlinFunction.file, kotlinFunction.qualifiedName ?? kotlinFunction.name),
      qualifiedName: kotlinFunction.qualifiedName ?? kotlinFunction.name,
      language: 'kotlin',
      line: kotlinFunction.line,
      startLine: kotlinFunction.startLine,
      endLine: kotlinFunction.endLine,
      signature: kotlinFunction.signature,
      decorators: androidKotlinAnnotationNames(kotlinFunction),
      visibility: kotlinFunction.visibility,
      isAsync: kotlinFunction.isAsync,
      isStatic: kotlinFunction.isStatic,
      returnType: kotlinFunction.returnType,
      metadata: {
        platform: 'android',
        relation: 'android-kotlin-function',
        packageName: kotlinFunction.packageName,
        annotationNames: androidKotlinAnnotationNames(kotlinFunction),
      },
    });
  }

  for (const resource of overlay.android?.xmlResources ?? []) {
    addNode('file', resource.file, resource.file, {
      language: 'xml',
      line: resource.line,
      metadata: {
        platform: 'android',
        relation: 'android-resource-file',
        resourceType: resource.resourceType,
        resourceName: resource.resourceName,
        rootTag: resource.rootTag,
      },
    });
  }

  for (const component of overlay.angular?.components ?? []) {
    const sourceId = addReferenceNode(component.className, component.file, { kind: 'component' });
    addImportEdges(addNode, addReferenceNode, addEdge, sourceId, component.file, component);
    addDependencyEdges(
      addReferenceNode,
      addEdge,
      sourceId,
      component.file,
      component.dependencies,
      component.dependencyDetails,
    );
    addTestEdges(addReferenceNode, addEdge, sourceId, component.tests, component.testMappings);
    addClassSemanticEdges(addReferenceNode, addEdge, sourceId, component.file, component);
    addAngularTemplateUsageEdges(addReferenceNode, addEdge, sourceId, component, angularTemplateUsageIndex);
    for (const provider of referenceDetails(component.providers, component.providerDetails)) {
      addEdge('references', sourceId, addReferenceNode(provider.name, component.file, { relation: 'provider' }), {
        relation: 'provider',
        line: provider.line,
        column: provider.column,
        matchedNeedle: provider.matchedNeedle,
      });
    }
  }

  for (const directive of overlay.angular?.directives ?? []) {
    const sourceId = addReferenceNode(directive.className, directive.file);
    addDependencyEdges(
      addReferenceNode,
      addEdge,
      sourceId,
      directive.file,
      directive.dependencies,
      directive.dependencyDetails,
    );
    addTestEdges(addReferenceNode, addEdge, sourceId, directive.tests, directive.testMappings);
    addClassSemanticEdges(addReferenceNode, addEdge, sourceId, directive.file, directive);
    for (const provider of referenceDetails(directive.providers, directive.providerDetails)) {
      addEdge('references', sourceId, addReferenceNode(provider.name, directive.file, { relation: 'provider' }), {
        relation: 'provider',
        line: provider.line,
        column: provider.column,
        matchedNeedle: provider.matchedNeedle,
      });
    }
  }

  for (const pipe of overlay.angular?.pipes ?? []) {
    const sourceId = addReferenceNode(pipe.className, pipe.file);
    addTestEdges(addReferenceNode, addEdge, sourceId, pipe.tests, pipe.testMappings);
    if (pipe.name) {
      addEdge('references', sourceId, addReferenceNode(pipe.name, pipe.file, { relation: 'pipe-name' }), {
        relation: 'pipe-name',
      });
    }
  }

  for (const injectable of overlay.angular?.injectables ?? []) {
    const sourceId = addReferenceNode(injectable.className, injectable.file);
    addDependencyEdges(
      addReferenceNode,
      addEdge,
      sourceId,
      injectable.file,
      injectable.dependencies,
      injectable.dependencyDetails,
    );
    addTestEdges(addReferenceNode, addEdge, sourceId, injectable.tests, injectable.testMappings);
    if (injectable.providedIn) {
      addEdge('decorates', sourceId, addReferenceNode(injectable.providedIn, injectable.file, {
        relation: 'providedIn',
        allowGlobalFallback: false,
      }), {
        relation: 'providedIn',
      });
    }
  }

  for (const injector of overlay.angular?.injectors ?? []) {
    const sourceId = addNode('file', injector.file, injector.file, {
      metadata: { framework: 'angular', relation: 'injector-file' },
    });
    addDependencyEdges(addReferenceNode, addEdge, sourceId, injector.file, injector.dependencies);
  }

  for (const dynamicImport of overlay.angular?.dynamicImports ?? []) {
    const sourceId = addNode('file', dynamicImport.file, dynamicImport.file, {
      metadata: { framework: 'angular', relation: 'dynamic-import-file' },
    });
    const targetId = addNode('file', dynamicImport.target, dynamicImport.target, {
      metadata: { framework: 'angular', relation: 'dynamic-import-target' },
    });
    addEdge('imports', sourceId, targetId, { relation: 'dynamic-import' });
  }

  for (const applicationProviderGroup of overlay.angular?.applicationProviders ?? []) {
    const sourceId = addNode('file', applicationProviderGroup.file, applicationProviderGroup.file, {
      metadata: {
        framework: 'angular',
        relation: 'angular-app-config',
        bootstrapComponent: applicationProviderGroup.bootstrapComponent,
        configName: applicationProviderGroup.configName,
      },
    });
    for (const provider of applicationProviderGroup.providers ?? []) {
      const targetId = addReferenceNode(provider.name, applicationProviderGroup.file, {
        relation: 'angular-app-provider',
        allowGlobalFallback: false,
        line: provider.line,
      });
      addEdge('references', sourceId, targetId, {
        relation: 'angular-app-provider',
        provider: provider.name,
        providerKind: provider.providerKind,
        bootstrapComponent: applicationProviderGroup.bootstrapComponent,
        bootstrapLine: applicationProviderGroup.line,
        configName: applicationProviderGroup.configName,
        useClass: provider.useClass,
        useExisting: provider.useExisting,
        useFactory: provider.useFactory,
        deps: provider.deps,
        arguments: provider.arguments,
        endLine: provider.endLine,
        line: provider.line,
        column: provider.column,
      }, {
        line: provider.line,
        column: provider.column,
      });
    }
  }

  for (const route of overlay.angular?.routes ?? []) {
    const sourceId = addReferenceNode(angularRouteGraphName(route), route.file, { kind: 'route' });
    const targetId = resolveAngularRouteTargetId(route, addReferenceNode, addNode);
    addEdge('references', sourceId, targetId, {
      relation: 'route',
      path: route.path,
      exportName: route.exportName,
    });
    addAngularRouteSemanticEdges(route, sourceId, addReferenceNode, addEdge);
  }

  for (const edgeFunction of overlay.supabase?.edgeFunctions ?? []) {
    const sourceId = addReferenceNode(edgeFunction.name, edgeFunction.entry);
    addTestEdges(addReferenceNode, addEdge, sourceId, edgeFunction.tests, edgeFunction.testMappings);
    addCallableEdges(sourceId, edgeFunction.entry, edgeFunction);
    for (const route of edgeFunction.routes ?? []) {
      addEdge('references', sourceId, addReferenceNode(route.path, edgeFunction.entry, {
        kind: 'route',
        relation: 'edge-function-route',
        allowGlobalFallback: false,
        line: route.line,
      }), {
        relation: 'edge-function-route',
        path: route.path,
        invokeName: route.invokeName,
        line: route.line,
      });
    }
    for (const method of edgeFunction.methods ?? []) {
      const methodFile = method.sourceFile ?? edgeFunction.entry;
      const methodId = graphNodeId(
        'variable',
        methodFile,
        `edge-function-method:${edgeFunction.name}:${method.method}:${method.line ?? ''}`,
      );
      addEdge('references', sourceId, methodId, {
        relation: 'edge-function-method',
        method: method.method,
        methodSource: method.methodSource,
        sourceFile: method.sourceFile,
        line: method.line,
      });
    }
    for (const header of edgeFunction.headers ?? []) {
      const headerFile = header.sourceFile ?? edgeFunction.entry;
      const headerId = graphNodeId(
        'variable',
        headerFile,
        `edge-function-header:${edgeFunction.name}:${header.normalizedHeader}:${header.line ?? ''}`,
      );
      addEdge('references', sourceId, headerId, {
        relation: 'edge-function-header',
        header: header.header,
        normalizedHeader: header.normalizedHeader,
        sourceFile: header.sourceFile,
        line: header.line,
      });
    }
    for (const sourceImport of edgeFunction.imports ?? []) {
      addEdge('imports', sourceId, addReferenceNode(sourceImport.target, sourceImport.target, { kind: 'file', relation: 'edge-function-source' }), {
        relation: 'edge-function-source',
        sourceFile: sourceImport.source,
      });
    }
    for (const envVar of edgeFunction.envVars ?? []) {
      addEdge('references', sourceId, addReferenceNode(envVar, edgeFunction.entry, {
        relation: 'env-var',
        metadata: { envVar },
      }), {
        relation: 'env-var',
        envVar,
      });
    }
    for (const riskTag of edgeFunction.riskTags ?? []) {
      addEdge('decorates', sourceId, addReferenceNode(riskTag, edgeFunction.entry, {
        relation: 'risk-tag',
        metadata: { riskTag, riskSource: 'edge-function' },
      }), {
        relation: 'risk-tag',
        riskTag,
        riskSource: 'edge-function',
      });
    }
  }

  for (const migration of overlay.supabase?.migrations ?? []) {
    const sourceId = graphNodeId('file', migration.file, migration.name);
    addTestEdges(addReferenceNode, addEdge, sourceId, migration.tests, migration.testMappings);
    for (const table of migration.affectedTables ?? []) {
      addEdge('references', sourceId, addReferenceNode(table, migration.file, {
        relation: 'table',
        allowGlobalFallback: false,
      }), {
        relation: 'table',
      });
    }
    for (const rls of migration.rlsDetails ?? []) {
      const rlsName = `${rls.table} rls ${rls.action}`;
      const rlsId = addNode('variable', rlsName, migration.file, {
        id: graphNodeId('variable', migration.file, `migration-rls:${rls.table}:${rls.action}:${rls.line ?? 'unknown-line'}`),
        line: rls.line,
        signature: `rls ${rls.action}${rls.table ? ` on ${rls.table}` : ''}`,
        metadata: {
          relation: 'migration-rls',
          table: rls.table,
          action: rls.action,
        },
      });
      if (!rlsId) continue;
      addEdge('references', sourceId, rlsId, {
        relation: 'migration-rls',
        table: rls.table,
        action: rls.action,
        line: rls.line,
      }, {
        line: rls.line,
      });
    }
    for (const publication of migration.realtimePublicationDetails ?? []) {
      const publicationId = addNode('variable', `${publication.publication} ${publication.action} ${publication.table}`, migration.file, {
        id: graphNodeId(
          'variable',
          migration.file,
          `migration-realtime-publication:${publication.publication}:${publication.action}:${publication.table}:${publication.line ?? 'unknown-line'}`,
        ),
        line: publication.line,
        signature: `alter publication ${publication.publication} ${publication.action} table ${publication.table}`,
        metadata: {
          relation: 'migration-realtime-publication',
          publication: publication.publication,
          action: publication.action,
          table: publication.table,
        },
      });
      if (!publicationId) continue;
      addEdge('references', sourceId, publicationId, {
        relation: 'migration-realtime-publication',
        publication: publication.publication,
        action: publication.action,
        table: publication.table,
        line: publication.line,
      }, {
        line: publication.line,
      });
    }
    for (const view of migration.viewDetails ?? []) {
      const viewId = addNode('variable', view.view, migration.file, {
        id: graphNodeId('variable', migration.file, `migration-view:${view.view}:${view.line ?? 'unknown-line'}`),
        line: view.line,
        signature: `${view.materialized ? 'materialized view' : 'view'} ${view.view}`,
        metadata: {
          relation: 'migration-view',
          view: view.view,
          materialized: view.materialized,
          orReplace: view.orReplace,
        },
      });
      if (!viewId) continue;
      addEdge('references', sourceId, viewId, {
        relation: 'migration-view',
        view: view.view,
        materialized: view.materialized,
        line: view.line,
      }, {
        line: view.line,
      });
    }
    const policyDetailsByName = new Map((migration.policyDetails ?? []).map(policy => [policy.name, policy]));
    for (const policy of migration.policies ?? []) {
      const policyDetail = policyDetailsByName.get(policy);
      const policyId = addNode('variable', policy, migration.file, {
        line: policyDetail?.line,
        signature: `policy ${policy}`,
        metadata: {
          relation: 'policy',
          table: policyDetail?.table,
          command: policyDetail?.command,
          type: policyDetail?.type,
          roles: policyDetail?.roles,
          using: policyDetail?.using,
          withCheck: policyDetail?.withCheck,
        },
      });
      addEdge('decorates', sourceId, policyId, {
        relation: 'policy',
      });
    }
    for (const policy of migration.policyDetails ?? []) {
      const policyId = addNode('variable', policy.name, migration.file, {
        line: policy.line,
        signature: `policy ${policy.name}`,
        metadata: {
          relation: 'policy',
          table: policy.table,
          command: policy.command,
          type: policy.type,
          roles: policy.roles,
          using: policy.using,
          withCheck: policy.withCheck,
        },
      });
      if (!policyId) continue;
      if (policy.type) {
        addEdge('references', sourceId, policyId, {
          relation: 'policy-type',
          policy: policy.name,
          type: policy.type,
        });
      }
      if (policy.command) {
        addEdge('references', sourceId, policyId, {
          relation: 'policy-command',
          policy: policy.name,
          command: policy.command,
        });
      }
      for (const role of policy.roles ?? []) {
        addEdge('references', sourceId, policyId, {
          relation: 'policy-role',
          policy: policy.name,
          role,
        });
      }
      if (policy.using) {
        addEdge('references', sourceId, policyId, {
          relation: 'policy-using',
          policy: policy.name,
          expression: policy.using,
        });
      }
      if (policy.withCheck) {
        addEdge('references', sourceId, policyId, {
          relation: 'policy-with-check',
          policy: policy.name,
          expression: policy.withCheck,
        });
      }
	      for (const storageBucket of readStoragePolicyBuckets(policy)) {
	        const bucketId = addNode('variable', storageBucket.bucket, migration.file, {
	          id: graphNodeId(
	            'variable',
	            migration.file,
	            `supabase-storage-bucket:${storageBucket.bucket}:policy:${policy.name}:${policy.line ?? 'unknown-line'}`,
	          ),
	          qualifiedName: `policy ${policy.name}::storage.bucket:${storageBucket.bucket}`,
	          line: policy.line,
	          startLine: policy.line,
	          endLine: policy.line,
          startColumn: 0,
          endColumn: 0,
          signature: `storage bucket ${storageBucket.bucket}`,
          metadata: {
            relation: 'supabase-storage-bucket',
            bucket: storageBucket.bucket,
            storageSource: 'storage-policy',
            policy: policy.name,
            table: policy.table,
          },
        });
        addEdge('references', sourceId, bucketId, {
          relation: 'supabase-storage-bucket',
          bucket: storageBucket.bucket,
          storageSource: 'storage-policy',
          policy: policy.name,
          table: policy.table,
        }, {
          line: policy.line,
        });
      }
    }
    for (const privilege of migration.privilegeDetails ?? []) {
      for (const permission of privilege.privileges ?? []) {
        const privilegeId = addNode('variable', permission, migration.file, {
          id: graphNodeId('variable', migration.file, `privilege:${privilege.action}:${permission}:${privilege.objectType}:${privilege.line ?? 'unknown-line'}`),
          line: privilege.line,
          signature: `${privilege.action} ${permission} on ${privilege.objectType}`,
          metadata: {
            relation: 'privilege',
            action: privilege.action,
            privilege: permission,
            objectType: privilege.objectType,
            objectNames: privilege.objectNames,
            roles: privilege.roles,
            grantOption: privilege.grantOption,
            grantOptionFor: privilege.grantOptionFor,
            revokeBehavior: privilege.revokeBehavior,
          },
        });
        for (const objectName of privilege.objectNames ?? [undefined]) {
          for (const role of privilege.roles ?? [undefined]) {
            addEdge('references', sourceId, privilegeId, {
              relation: `privilege-${privilege.action}`,
              action: privilege.action,
              privilege: permission,
              objectType: privilege.objectType,
              objectName,
              role,
              grantOption: privilege.grantOption,
              grantOptionFor: privilege.grantOptionFor,
              revokeBehavior: privilege.revokeBehavior,
              line: privilege.line,
            });
          }
        }
      }

      for (const objectName of privilege.objectNames ?? []) {
        const objectId = addNode('variable', objectName, migration.file, {
          id: graphNodeId('variable', migration.file, `privilege-object:${privilege.action}:${privilege.objectType}:${objectName}:${privilege.line ?? 'unknown-line'}`),
          line: privilege.line,
          signature: `${privilege.objectType} ${objectName}`,
          metadata: {
            relation: 'privilege-object',
            action: privilege.action,
            objectType: privilege.objectType,
            objectName,
            privileges: privilege.privileges,
            roles: privilege.roles,
            grantOption: privilege.grantOption,
            grantOptionFor: privilege.grantOptionFor,
            revokeBehavior: privilege.revokeBehavior,
          },
        });
        addEdge('references', sourceId, objectId, {
          relation: 'privilege-object',
          action: privilege.action,
          objectType: privilege.objectType,
          objectName,
          privileges: privilege.privileges,
          roles: privilege.roles,
          grantOption: privilege.grantOption,
          grantOptionFor: privilege.grantOptionFor,
          revokeBehavior: privilege.revokeBehavior,
          line: privilege.line,
        });
      }

      for (const role of privilege.roles ?? []) {
        const roleId = addNode('variable', role, migration.file, {
          id: graphNodeId('variable', migration.file, `privilege-role:${privilege.action}:${role}:${privilege.line ?? 'unknown-line'}`),
          line: privilege.line,
          signature: `role ${role}`,
          metadata: {
            relation: 'privilege-role',
            action: privilege.action,
            role,
            privileges: privilege.privileges,
            objectType: privilege.objectType,
            objectNames: privilege.objectNames,
            grantOption: privilege.grantOption,
            grantOptionFor: privilege.grantOptionFor,
            revokeBehavior: privilege.revokeBehavior,
          },
        });
        addEdge('references', sourceId, roleId, {
          relation: 'privilege-role',
          action: privilege.action,
          role,
          privileges: privilege.privileges,
          objectType: privilege.objectType,
          objectNames: privilege.objectNames,
          grantOption: privilege.grantOption,
          grantOptionFor: privilege.grantOptionFor,
          revokeBehavior: privilege.revokeBehavior,
          line: privilege.line,
        });
      }
    }
    for (const fn of migration.functionDetails ?? []) {
      const functionId = addNode('function', fn.name, migration.file, {
        line: fn.line,
        signature: `function ${fn.name}()${fn.returnType ? ` returns ${fn.returnType}` : ''}`,
        returnType: fn.returnType,
        metadata: {
          relation: 'sql-function',
          returnType: fn.returnType,
          language: fn.language,
          security: fn.security,
        },
      });
      addEdge('references', sourceId, functionId, {
        relation: 'sql-function',
        functionName: fn.name,
        returnType: fn.returnType,
        language: fn.language,
        security: fn.security,
        line: fn.line,
      });
    }
    for (const trigger of migration.triggerDetails ?? []) {
      const triggerId = addNode('variable', trigger.name, migration.file, {
        id: graphNodeId('variable', migration.file, `${trigger.name}:${trigger.table ?? 'unknown-table'}:${trigger.line ?? 'unknown-line'}`),
        line: trigger.line,
        signature: `trigger ${trigger.name}${trigger.table ? ` on ${trigger.table}` : ''}`,
        metadata: {
          relation: 'trigger',
          table: trigger.table,
          timing: trigger.timing,
          events: trigger.events,
          functionName: trigger.functionName,
        },
      });
      if (!triggerId) continue;
      addEdge('references', sourceId, triggerId, {
        relation: 'trigger',
        trigger: trigger.name,
        table: trigger.table,
        timing: trigger.timing,
        events: trigger.events,
        line: trigger.line,
      });
      if (trigger.functionName) {
        addEdge('references', sourceId, addReferenceNode(trigger.functionName, migration.file, { relation: 'trigger-function' }), {
          relation: 'trigger-function',
          trigger: trigger.name,
          functionName: trigger.functionName,
          line: trigger.line,
        });
      }
    }
    for (const index of migration.indexDetails ?? []) {
      const indexId = addNode('variable', index.name, migration.file, {
        line: index.line,
        signature: `index ${index.name}${index.table ? ` on ${index.table}` : ''}${index.columns?.length ? ` (${index.columns.join(', ')})` : ''}`,
        metadata: {
          relation: 'migration-index',
          table: index.table,
          columns: index.columns,
          method: index.method,
          unique: index.unique,
          concurrently: index.concurrently,
          predicate: index.predicate,
        },
      });
      if (!indexId) continue;
      addEdge('references', sourceId, indexId, {
        relation: 'migration-index',
        indexName: index.name,
        table: index.table,
        columns: index.columns,
        method: index.method,
        unique: index.unique,
        concurrently: index.concurrently,
        predicate: index.predicate,
        line: index.line,
      });
    }
    const constraintOccurrences = new Map();
    const constraintIdsByNameAndTable = new Map();
    for (const constraint of migration.constraintDetails ?? []) {
      const occurrenceKey = constraint.name;
      const occurrenceIndex = constraintOccurrences.get(occurrenceKey) ?? 0;
      constraintOccurrences.set(occurrenceKey, occurrenceIndex + 1);
      const constraintNodeId = occurrenceIndex === 0
        ? undefined
        : graphNodeId('variable', migration.file, `constraint:${constraint.name}:${constraint.table ?? 'unknown-table'}:${constraint.line ?? 'unknown-line'}`);
      const constraintId = addNode('variable', constraint.name, migration.file, {
        id: constraintNodeId,
        line: constraint.line,
        signature: `constraint ${constraint.name}${constraint.table ? ` on ${constraint.table}` : ''}${constraint.constraintType ? ` ${constraint.constraintType}` : ''}`,
        metadata: {
          relation: 'migration-constraint',
          table: constraint.table,
          constraintType: constraint.constraintType,
          constraintSource: constraint.constraintSource,
          expression: constraint.expression,
          columns: constraint.columns,
          referencedTable: constraint.referencedTable,
          referencedColumns: constraint.referencedColumns,
          nullsDistinct: constraint.nullsDistinct,
          matchType: constraint.matchType,
          onDelete: constraint.onDelete,
          onDeleteColumns: constraint.onDeleteColumns,
          onUpdate: constraint.onUpdate,
          onUpdateColumns: constraint.onUpdateColumns,
          usingIndex: constraint.usingIndex,
          indexMethod: constraint.indexMethod,
          excludeElements: constraint.excludeElements,
          predicate: constraint.predicate,
          deferrable: constraint.deferrable,
          initially: constraint.initially,
          notValid: constraint.notValid,
        },
      });
      if (!constraintId) continue;
      if (constraint.table) {
        constraintIdsByNameAndTable.set(`${constraint.name}\0${constraint.table}`, constraintId);
      }
      addEdge('references', sourceId, constraintId, {
        relation: 'migration-constraint',
        constraintName: constraint.name,
        table: constraint.table,
        constraintType: constraint.constraintType,
        constraintSource: constraint.constraintSource,
        expression: constraint.expression,
        columns: constraint.columns,
        referencedTable: constraint.referencedTable,
        referencedColumns: constraint.referencedColumns,
        nullsDistinct: constraint.nullsDistinct,
        matchType: constraint.matchType,
        onDelete: constraint.onDelete,
        onDeleteColumns: constraint.onDeleteColumns,
        onUpdate: constraint.onUpdate,
        onUpdateColumns: constraint.onUpdateColumns,
        usingIndex: constraint.usingIndex,
        indexMethod: constraint.indexMethod,
        excludeElements: constraint.excludeElements,
        predicate: constraint.predicate,
        deferrable: constraint.deferrable,
        initially: constraint.initially,
        notValid: constraint.notValid,
        line: constraint.line,
      });
    }
    for (const validation of migration.constraintValidationDetails ?? []) {
      const targetConstraintId = validation.table
        ? constraintIdsByNameAndTable.get(`${validation.name}\0${validation.table}`)
        : null;
      const legacyConstraintId = graphNodeId('variable', migration.file, validation.name);
      let targetId = targetConstraintId ?? legacyConstraintId;
      if (!nodesById.has(targetId)) {
        targetId = addNode('variable', validation.name, migration.file, {
          id: graphNodeId('variable', migration.file, `constraint-validation:${validation.name}:${validation.table ?? 'unknown-table'}:${validation.line ?? 'unknown-line'}`),
          line: validation.line,
          signature: `validate constraint ${validation.name}${validation.table ? ` on ${validation.table}` : ''}`,
          metadata: {
            relation: 'migration-constraint-validation',
            table: validation.table,
          },
        });
      }
      if (!targetId) continue;
      addEdge('references', sourceId, targetId, {
        relation: 'migration-constraint-validation',
        constraintName: validation.name,
        table: validation.table,
        line: validation.line,
      });
    }
    for (const riskTag of migration.riskTags ?? []) {
      addEdge('decorates', sourceId, addReferenceNode(riskTag, migration.file, {
        relation: 'risk-tag',
        metadata: { riskTag, riskSource: 'migration' },
      }), {
        relation: 'risk-tag',
        riskTag,
        riskSource: 'migration',
      });
    }
  }

  for (const hardRule of overlay.agentRules?.hardRules ?? []) {
    const sourceId = addReferenceNode(hardRule.heading, hardRule.file);
    addEdge('decorates', sourceId, addReferenceNode('AGENTS.md', hardRule.file, { kind: 'file', relation: 'source-file' }), {
      relation: 'hard-rule',
      line: hardRule.line,
    });
    for (const keyword of hardRule.keywords ?? []) {
      const keywordId = addNode('variable', keyword, hardRule.file, {
        id: graphNodeId('variable', hardRule.file, `hard-rule-keyword:${hardRule.heading}:${keyword}`),
        line: hardRule.line,
        signature: `hard-rule keyword ${keyword}`,
        metadata: {
          relation: 'hard-rule-keyword',
          rule: hardRule.heading,
          keywordMapping: 'hard-rule-keyword',
          matchedNeedle: keyword,
        },
      });
      addEdge('references', sourceId, keywordId, {
        relation: 'hard-rule-keyword',
        line: hardRule.line,
        keyword,
        keywordMapping: 'hard-rule-keyword',
        matchedNeedle: keyword,
        rule: hardRule.heading,
      });
      for (const selectField of findRequiredSyncFieldsForKeyword(keyword, supabaseSelectFieldsByConfig)) {
        addEdge('references', keywordId, selectField.id, {
          relation: 'sync-required-field',
          field: selectField.field,
          table: selectField.table,
          requiredBy: hardRule.file,
        });
      }
      for (const implementation of hardRuleImplementationsByKeyword.get(keyword) ?? []) {
        addEdge('references', keywordId, implementation.id, {
          relation: implementation.relation,
          keyword,
          matchedNeedle: keyword,
          call: implementation.call,
          requiredBy: hardRule.file,
        }, {
          line: implementation.line,
          column: implementation.column,
        });
      }
    }
  }

  for (const syncRule of overlay.agentRules?.syncRules ?? []) {
    const sourceId = graphNodeId('variable', syncRule.file, `sync-rule:${syncRule.ownerHeading}:${syncRule.name}`);
    const ownerId = addReferenceNode(syncRule.ownerHeading, syncRule.file);
    addEdge('decorates', sourceId, ownerId, {
      relation: 'sync-rule',
      line: syncRule.line,
      ownerHeading: syncRule.ownerHeading,
    });
    const configKey = readAgentsConfigKeyParts(syncRule.name);
    if (configKey) {
      const configSourceId = addReferenceNode(configKey.configObject, configKey.filePath, {
        relation: 'config-source',
        allowGlobalFallback: false,
        materializeUnresolved: false,
      });
      const configPropertyId = addReferenceNode(configKey.configKey, configKey.filePath, {
        qualifiedName: configKey.configKey,
        relation: 'config-source',
        allowGlobalFallback: false,
        materializeUnresolved: false,
      });
      addEdge('references', sourceId, configPropertyId ?? configSourceId, {
        relation: 'config-source',
        line: syncRule.line,
        configKey: syncRule.name,
        configObject: configKey.configObject,
        configProperty: configKey.configProperty,
        configPath: configKey.configPath,
      });
      if (configKey.configObject === 'SYNC_CONFIG') {
        addEdge('references', sourceId, configSourceId, {
          relation: 'sync-config-source',
          line: syncRule.line,
          configKey: syncRule.name,
          configObject: configKey.configObject,
          configProperty: configKey.configProperty,
          configPath: configKey.configPath,
        });
      }
    }
    for (const keyword of syncRule.keywords ?? []) {
      const keywordId = addNode('variable', keyword, syncRule.file, {
        id: graphNodeId('variable', syncRule.file, `sync-rule-keyword:${syncRule.ownerHeading}:${syncRule.name}:${keyword}`),
        line: syncRule.line,
        signature: `sync-rule keyword ${keyword}`,
        metadata: {
          relation: 'sync-rule-keyword',
          ownerHeading: syncRule.ownerHeading,
          rule: syncRule.name,
        },
      });
      addEdge('references', sourceId, keywordId, {
        relation: 'sync-rule-keyword',
        line: syncRule.line,
        keyword,
        keywordMapping: keyword === syncRule.name && /^SYNC_CONFIG\.[A-Z0-9_]+$/.test(syncRule.name)
          ? 'sync-config-keyword'
          : 'sync-body-keyword',
        matchedNeedle: keyword,
        ownerHeading: syncRule.ownerHeading,
      });
      for (const predicate of findRequiredSyncPredicatesForKeyword(keyword, supabaseIncrementalPredicates)) {
        addEdge('references', keywordId, predicate.id, {
          relation: 'sync-required-predicate',
          keyword,
          table: predicate.table,
          column: predicate.column,
          operator: predicate.operator,
          cursor: predicate.cursor,
          requiredBy: syncRule.file,
        });
      }
    }
  }

  const context7DocsByFile = new Map((overlay.context7?.documents ?? []).map(doc => [doc.file, doc]));

  for (const category of overlay.context7?.categories ?? []) {
    const sourceId = context7CategoryNodeId(category);
    for (const docPath of category.docs ?? []) {
      const doc = context7DocsByFile.get(docPath);
      if (!doc) continue;
      addEdge('references', sourceId, context7DocumentNodeId(doc), {
        relation: 'context7-category-doc',
        category: category.name,
        docPath,
        line: category.line,
      });
    }
  }

  for (const route of overlay.context7?.retrievalRoutes ?? []) {
    const sourceId = context7RetrievalRouteNodeId(route);
    const primaryDoc = context7DocsByFile.get(route.primary);
    if (primaryDoc) {
      addEdge('references', sourceId, context7DocumentNodeId(primaryDoc), {
        relation: 'context7-retrieval-primary',
        query: route.query,
        docPath: route.primary,
        line: route.line,
      });
    }
    for (const docPath of route.secondary ?? []) {
      const doc = context7DocsByFile.get(docPath);
      if (!doc) continue;
      addEdge('references', sourceId, context7DocumentNodeId(doc), {
        relation: 'context7-retrieval-secondary',
        query: route.query,
        docPath,
        line: route.line,
      });
    }
  }

  for (const route of overlay.context7?.sourceMapRoutes ?? []) {
    const sourceId = context7SourceMapRouteNodeId(route);
    for (const docPath of context7SourceMapRouteDocs(route)) {
      const doc = context7DocsByFile.get(docPath);
      if (doc) {
        addEdge('references', sourceId, context7DocumentNodeId(doc), {
          relation: 'context7-source-map-doc',
          question: route.question,
          docPath,
          line: route.line,
        });
      }
    }
    for (const sourcePath of route.sourcePaths ?? []) {
      const sourcePathTarget = context7SourcePathTarget(overlay.project?.root, route.file, sourcePath);
      const targetId = addNode(sourcePathTarget.kind, sourcePath, sourcePathTarget.filePath, {
        id: sourcePathTarget.id,
        line: sourcePathTarget.line,
        language: sourcePathTarget.language,
        signature: `Context7 source path ${sourcePath}`,
        metadata: {
          source: 'docs/context7/source-map.md',
          relation: 'context7-source-path',
          sourcePath,
        },
      });
      addEdge('references', sourceId, targetId, {
        relation: 'context7-source-map-source',
        question: route.question,
        sourcePath,
        line: route.line,
      });
    }
  }

  const androidKotlinDeclarations = [
    ...(overlay.android?.kotlinClasses ?? []),
    ...(overlay.android?.kotlinEnums ?? []),
  ];
  const androidKotlinMethodIndex = buildAndroidKotlinMemberIndex(overlay.android?.kotlinMethods ?? []);
  const androidKotlinPropertyIndex = buildAndroidKotlinMemberIndex(overlay.android?.kotlinProperties ?? []);

  for (const kotlinImport of overlay.android?.kotlinImports ?? []) {
    const importId = graphNodeId(
      'import',
      kotlinImport.file,
      `${kotlinImport.name}:${kotlinImport.target ?? ''}:${kotlinImport.importedName ?? ''}:${kotlinImport.line ?? ''}`,
    );
    const targetId = addReferenceNode(kotlinImport.target, kotlinImport.file, {
      kind: 'variable',
      relation: 'android-kotlin-import',
      allowGlobalFallback: false,
    });
    addFileContainsEdge(addReferenceNode, addEdge, kotlinImport.file, importId);
    addEdge('imports', importId, targetId, {
      relation: 'android-kotlin-import',
      importedName: kotlinImport.importedName,
      alias: kotlinImport.alias,
      target: kotlinImport.target,
      packageName: kotlinImport.packageName,
      wildcard: Boolean(kotlinImport.wildcard),
      line: kotlinImport.line,
    }, {
      line: kotlinImport.line,
      column: kotlinImport.startColumn,
    });
  }

  for (const kotlinClass of overlay.android?.kotlinClasses ?? []) {
    const classNodeKind = androidKotlinNodeKind(kotlinClass);
    const classId = graphNodeId(classNodeKind, kotlinClass.file, kotlinClass.qualifiedName ?? kotlinClass.name);
    addFileContainsEdge(addReferenceNode, addEdge, kotlinClass.file, classId);
    if (kotlinClass.isCompanionObject) {
      const ownerId = graphNodeId(
        androidKotlinOwnerNodeKind(kotlinClass.ownerKind),
        kotlinClass.file,
        kotlinClass.ownerQualifiedName ?? kotlinClass.ownerName,
      );
      addEdge('contains', ownerId, classId, {
        relation: 'android-kotlin-companion-object',
        ownerName: kotlinClass.ownerName,
        objectName: kotlinClass.name,
        line: kotlinClass.line,
      }, {
        line: kotlinClass.line,
      });
    } else if (kotlinClass.classKind === 'object') {
      addEdge('contains', addReferenceNode(kotlinClass.file, kotlinClass.file, { kind: 'file', relation: 'source-file' }), classId, {
        relation: 'android-kotlin-object',
        objectName: kotlinClass.name,
        line: kotlinClass.line,
      }, {
        line: kotlinClass.line,
      });
    }
    addAndroidKotlinAnnotationEdges(kotlinClass, classId, addReferenceNode, addEdge);
    const heritageEntries = (kotlinClass.heritage?.length ? kotlinClass.heritage : null)
      ?? (kotlinClass.heritageTypes ?? []).map(typeName => ({ name: typeName, hasConstructorCall: false }));
    for (const [heritageIndex, heritage] of heritageEntries.entries()) {
      const heritageType = typeof heritage === 'string' ? heritage : heritage?.name;
      if (!heritageType) continue;
      const target = resolveAndroidKotlinHeritageDeclaration(kotlinClass, heritageType, androidKotlinDeclarations);
      const edgeKind = androidKotlinHeritageEdgeKind(kotlinClass, target, heritage, heritageIndex);
      const relation = edgeKind === 'implements' ? 'android-kotlin-implements' : 'android-kotlin-extends';
      const targetName = target?.qualifiedName
        ?? resolveAndroidKotlinExternalHeritageTarget(kotlinClass, heritageType, overlay.android?.kotlinImports)?.targetName
        ?? heritageType;
      const targetId = target
        ? graphNodeId(target.classKind === 'enum class' ? 'enum' : androidKotlinNodeKind(target), target.file, target.qualifiedName ?? target.name)
        : addReferenceNode(targetName, kotlinClass.file, {
          kind: 'variable',
          relation,
          allowGlobalFallback: false,
          metadata: {
            typeName: heritageType,
            targetName,
          },
        });
      addEdge(edgeKind, classId, targetId, {
        relation,
        typeName: heritageType,
        targetName,
        line: kotlinClass.line,
      }, {
        line: kotlinClass.line,
      });
    }
  }

  for (const kotlinEnum of overlay.android?.kotlinEnums ?? []) {
    const enumId = graphNodeId('enum', kotlinEnum.file, kotlinEnum.qualifiedName ?? kotlinEnum.name);
    addFileContainsEdge(addReferenceNode, addEdge, kotlinEnum.file, enumId);
    addAndroidKotlinAnnotationEdges(kotlinEnum, enumId, addReferenceNode, addEdge);
    for (const member of kotlinEnum.members ?? []) {
      const memberId = graphNodeId('enum_member', member.file, member.qualifiedName ?? member.name);
      addEdge('contains', enumId, memberId, {
        relation: 'android-kotlin-enum-member',
        ownerName: member.ownerName,
        memberName: member.name,
        line: member.line,
      }, {
        line: member.line,
      });
    }
  }

  for (const kotlinConstructor of overlay.android?.kotlinConstructors ?? []) {
    const classId = graphNodeId(
      androidKotlinOwnerNodeKind(kotlinConstructor.ownerKind),
      kotlinConstructor.file,
      kotlinConstructor.ownerQualifiedName ?? kotlinConstructor.ownerName,
    );
    const constructorId = graphNodeId(
      'method',
      kotlinConstructor.file,
      kotlinConstructor.qualifiedName ?? kotlinConstructor.name,
    );
    addEdge('contains', classId, constructorId, {
      relation: 'android-kotlin-constructor',
      ownerName: kotlinConstructor.ownerName,
      line: kotlinConstructor.line,
    }, {
      line: kotlinConstructor.line,
    });
    addAndroidKotlinAnnotationEdges(kotlinConstructor, constructorId, addReferenceNode, addEdge);
  }

  for (const kotlinProperty of overlay.android?.kotlinProperties ?? []) {
    const classId = graphNodeId(
      androidKotlinOwnerNodeKind(kotlinProperty.ownerKind),
      kotlinProperty.file,
      kotlinProperty.ownerQualifiedName ?? kotlinProperty.ownerName,
    );
    const propertyId = graphNodeId(
      'property',
      kotlinProperty.file,
      kotlinProperty.qualifiedName ?? kotlinProperty.name,
    );
    addEdge('contains', classId, propertyId, {
      relation: 'android-kotlin-property',
      ownerName: kotlinProperty.ownerName,
      propertyName: kotlinProperty.name,
      isConst: kotlinProperty.isConst,
      isMutable: kotlinProperty.isMutable,
      constructorParameter: kotlinProperty.constructorParameter,
      line: kotlinProperty.line,
    }, {
      line: kotlinProperty.line,
    });
    addAndroidKotlinAnnotationEdges(kotlinProperty, propertyId, addReferenceNode, addEdge);
    addAndroidKotlinTypeReferenceEdges(
      addReferenceNode,
      addEdge,
      propertyId,
      kotlinProperty,
      kotlinProperty.typeReferences,
      androidKotlinDeclarations,
      overlay.android?.kotlinImports,
    );
    addAndroidKotlinOverrideEdges(
      addReferenceNode,
      addEdge,
      propertyId,
      kotlinProperty,
      findAndroidKotlinOwnerDeclaration(kotlinProperty, androidKotlinDeclarations),
      androidKotlinPropertyIndex,
      androidKotlinDeclarations,
      overlay.android?.kotlinImports,
      'property',
    );
  }

  for (const kotlinMethod of overlay.android?.kotlinMethods ?? []) {
    const classId = graphNodeId(
      androidKotlinOwnerNodeKind(kotlinMethod.ownerKind),
      kotlinMethod.file,
      kotlinMethod.ownerQualifiedName ?? kotlinMethod.ownerName,
    );
    const methodId = graphNodeId('method', kotlinMethod.file, kotlinMethod.qualifiedName ?? kotlinMethod.name);
    addEdge('contains', classId, methodId, {
      relation: 'android-kotlin-method',
      ownerName: kotlinMethod.ownerName,
      methodName: kotlinMethod.name,
      line: kotlinMethod.line,
    }, {
      line: kotlinMethod.line,
    });
    addAndroidKotlinAnnotationEdges(kotlinMethod, methodId, addReferenceNode, addEdge);
    addAndroidKotlinTypeReferenceEdges(
      addReferenceNode,
      addEdge,
      methodId,
      kotlinMethod,
      kotlinMethod.typeReferences,
      androidKotlinDeclarations,
      overlay.android?.kotlinImports,
    );
    addAndroidKotlinOverrideEdges(
      addReferenceNode,
      addEdge,
      methodId,
      kotlinMethod,
      findAndroidKotlinOwnerDeclaration(kotlinMethod, androidKotlinDeclarations),
      androidKotlinMethodIndex,
      androidKotlinDeclarations,
      overlay.android?.kotlinImports,
      'method',
    );
  }

  for (const kotlinFunction of overlay.android?.kotlinFunctions ?? []) {
    const functionId = graphNodeId('function', kotlinFunction.file, kotlinFunction.qualifiedName ?? kotlinFunction.name);
    addFileContainsEdge(addReferenceNode, addEdge, kotlinFunction.file, functionId);
    addEdge('contains', addReferenceNode(kotlinFunction.file, kotlinFunction.file, { kind: 'file', relation: 'source-file' }), functionId, {
      relation: 'android-kotlin-function',
      functionName: kotlinFunction.name,
      line: kotlinFunction.line,
    }, {
      line: kotlinFunction.line,
    });
    addAndroidKotlinAnnotationEdges(kotlinFunction, functionId, addReferenceNode, addEdge);
    addAndroidKotlinTypeReferenceEdges(
      addReferenceNode,
      addEdge,
      functionId,
      kotlinFunction,
      kotlinFunction.typeReferences,
      androidKotlinDeclarations,
      overlay.android?.kotlinImports,
    );
  }

  for (const kotlinCall of overlay.android?.kotlinCalls ?? []) {
    const sourceId = graphNodeId(kotlinCall.sourceKind ?? 'method', kotlinCall.sourceFile, kotlinCall.sourceQualifiedName);
    const targetId = graphNodeId(kotlinCall.targetKind ?? 'method', kotlinCall.targetFile, kotlinCall.targetQualifiedName);
    addEdge('calls', sourceId, targetId, {
      relation: 'android-kotlin-call',
      callName: kotlinCall.callName,
      receiver: kotlinCall.receiver,
      line: kotlinCall.line,
    }, {
      line: kotlinCall.line,
    });
  }

  for (const permission of overlay.android?.manifestPermissions ?? []) {
    const manifestId = addNode('file', permission.file, permission.file, {
      language: 'xml',
      metadata: {
        platform: 'android',
        relation: 'android-manifest',
      },
    });
    const permissionId = addNode('variable', permission.permission, permission.file, {
      id: `variable:${permission.file}:android-permission:${permission.permission}`,
      line: permission.line,
      language: 'unknown',
      signature: `${permission.declarationType} ${permission.permission}`,
      metadata: {
        platform: 'android',
        relation: 'android-manifest-permission',
        permission: permission.permission,
      },
    });
    addEdge('references', manifestId, permissionId, {
      relation: 'android-manifest-uses-permission',
      permission: permission.permission,
      declarationType: permission.declarationType,
      line: permission.line,
    }, {
      line: permission.line,
    });
  }

  for (const query of overlay.android?.manifestQueries ?? []) {
    const manifestId = addNode('file', query.file, query.file, {
      language: 'xml',
      metadata: {
        platform: 'android',
        relation: 'android-manifest',
      },
    });
    const queryId = addNode('variable', query.queryValue, query.file, {
      id: `variable:${query.file}:android-manifest-query:${query.queryType}:${query.queryValue}`,
      line: query.line,
      language: 'unknown',
      signature: `Android Manifest ${query.queryType} query ${query.queryValue}`,
      metadata: {
        platform: 'android',
        relation: 'android-manifest-query',
        queryType: query.queryType,
        queryValue: query.queryValue,
      },
    });
    addEdge('references', manifestId, queryId, {
      relation: 'android-manifest-query',
      queryType: query.queryType,
      queryValue: query.queryValue,
      actions: query.actions,
      categories: query.categories,
      data: query.data,
      line: query.line,
    }, {
      line: query.line,
    });
  }

  for (const component of overlay.android?.manifestComponents ?? []) {
    const manifestId = addNode('file', component.file, component.file, {
      language: 'xml',
      metadata: {
        platform: 'android',
        relation: 'android-manifest',
      },
    });
    const classId = resolveAndroidComponentClassId(component, addReferenceNode, addNode);
    addEdge('references', manifestId, classId, {
      relation: 'android-manifest-component',
      componentType: component.componentType,
      className: component.className,
      rawName: component.rawName,
      exported: component.exported,
      actions: component.actions,
      line: component.line,
    }, {
      line: component.line,
    });
    if (component.permission) {
      const permissionId = addNode('variable', component.permission, component.file, {
        id: `variable:${component.file}:android-permission:${component.permission}`,
        line: component.line,
        language: 'unknown',
        signature: `Android component permission ${component.permission}`,
        metadata: {
          platform: 'android',
          relation: 'android-manifest-permission',
          permission: component.permission,
        },
      });
      addEdge('references', classId, permissionId, {
        relation: 'android-manifest-component-permission',
        componentType: component.componentType,
        className: component.className,
        permission: component.permission,
        line: component.line,
      }, {
        line: component.line,
      });
    }
    for (const intentFilter of component.intentFilters ?? []) {
      for (const action of intentFilter.actions ?? []) {
        const actionId = addNode('variable', action.name, component.file, {
          id: `variable:${component.file}:android-intent-action:${action.name}`,
          line: action.line,
          language: 'unknown',
          signature: `Android intent action ${action.name}`,
          metadata: {
            platform: 'android',
            relation: 'android-manifest-intent-filter-value',
            valueType: 'action',
          },
        });
        addEdge('references', classId, actionId, {
          relation: 'android-manifest-intent-filter-action',
          action: action.name,
          line: action.line,
        }, {
          line: action.line,
        });
      }
      for (const category of intentFilter.categories ?? []) {
        const categoryId = addNode('variable', category.name, component.file, {
          id: `variable:${component.file}:android-intent-category:${category.name}`,
          line: category.line,
          language: 'unknown',
          signature: `Android intent category ${category.name}`,
          metadata: {
            platform: 'android',
            relation: 'android-manifest-intent-filter-value',
            valueType: 'category',
          },
        });
        addEdge('references', classId, categoryId, {
          relation: 'android-manifest-intent-filter-category',
          category: category.name,
          line: category.line,
        }, {
          line: category.line,
        });
      }
      for (const data of intentFilter.data ?? []) {
        const dataValue = androidManifestDataValue(data);
        if (!dataValue) continue;
        const dataId = addNode('variable', dataValue, component.file, {
          id: `variable:${component.file}:android-intent-data:${dataValue}`,
          line: data.line,
          language: 'unknown',
          signature: `Android intent data ${dataValue}`,
          metadata: {
            platform: 'android',
            relation: 'android-manifest-intent-filter-value',
            valueType: 'data',
          },
        });
        addEdge('references', classId, dataId, {
          relation: 'android-manifest-intent-filter-data',
          ...data,
        }, {
          line: data.line,
        });
      }
    }
  }

  for (const widgetProvider of overlay.android?.widgetProviders ?? []) {
    const classId = resolveAndroidComponentClassId(widgetProvider, addReferenceNode, addNode);
    const resourceId = addNode('file', widgetProvider.resourcePath, widgetProvider.resourcePath, {
      language: 'xml',
      metadata: {
        platform: 'android',
        relation: 'android-widget-provider',
        resourceType: widgetProvider.resourceType,
        resourceName: widgetProvider.resourceName,
      },
    });
    addEdge('references', classId, resourceId, {
      relation: 'android-widget-provider',
      componentType: widgetProvider.componentType,
      className: widgetProvider.className,
      resourceType: widgetProvider.resourceType,
      resourceName: widgetProvider.resourceName,
      manifestFile: widgetProvider.manifestFile,
      line: widgetProvider.line,
    }, {
      line: widgetProvider.line,
    });
  }

  for (const resourceReference of overlay.android?.resourceReferences ?? []) {
    const sourceId = addNode('file', resourceReference.sourceFile, resourceReference.sourceFile, {
      language: 'xml',
      metadata: {
        platform: 'android',
        relation: 'android-resource-file',
      },
    });
    const targetId = addNode('file', resourceReference.targetFile, resourceReference.targetFile, {
      language: inferLanguage(resourceReference.targetFile),
      metadata: {
        platform: 'android',
        relation: 'android-resource-file',
        resourceType: resourceReference.resourceType,
        resourceName: resourceReference.resourceName,
      },
    });
    addEdge('imports', sourceId, targetId, {
      relation: 'android-resource-reference',
      resourceType: resourceReference.resourceType,
      resourceName: resourceReference.resourceName,
      line: resourceReference.line,
    }, {
      line: resourceReference.line,
    });
  }

  for (const resourceReference of overlay.android?.kotlinResourceReferences ?? []) {
    const sourceId = addNode('file', resourceReference.sourceFile, resourceReference.sourceFile, {
      language: 'kotlin',
      metadata: {
        platform: 'android',
        relation: 'android-kotlin-source',
      },
    });
    const targetId = addNode('file', resourceReference.targetFile, resourceReference.targetFile, {
      language: inferLanguage(resourceReference.targetFile),
      metadata: {
        platform: 'android',
        relation: 'android-resource-file',
        resourceType: resourceReference.resourceType,
        resourceName: resourceReference.resourceName,
      },
    });
    addEdge('references', sourceId, targetId, {
      relation: 'android-kotlin-resource-reference',
      resourceType: resourceReference.resourceType,
      resourceName: resourceReference.resourceName,
      line: resourceReference.line,
    }, {
      line: resourceReference.line,
    });
  }

  return {
    schemaVersion: 1,
    nodes: [...nodesById.values()].sort(compareGraphNodes),
    edges: edges.sort(compareGraphEdges),
  };
}

function resolveAndroidComponentClassId(component, addReferenceNode, addNode) {
  const simpleName = component.simpleName
    ?? String(component.className ?? '').split('.').filter(Boolean).at(-1)
    ?? component.rawName;
  const filePath = component.kotlinFile ?? component.file;
  const resolvedId = addReferenceNode(simpleName, filePath, {
    kind: 'class',
    qualifiedName: component.className,
    relation: 'android-manifest-component',
    allowGlobalFallback: false,
    materializeUnresolved: false,
  });
  if (resolvedId) return resolvedId;

  return addNode('class', simpleName, filePath, {
    qualifiedName: component.className ?? simpleName,
    language: component.kotlinFile ? 'kotlin' : inferLanguage(filePath),
    line: component.line,
    startLine: component.startLine ?? component.line,
    endLine: component.endLine ?? component.line,
    signature: `class ${simpleName}`,
    metadata: {
      platform: 'android',
      relation: 'android-manifest-component',
      className: component.className,
      componentType: component.componentType,
    },
  });
}

function addAndroidKotlinAnnotationEdges(item, sourceId, addReferenceNode, addEdge) {
  for (const annotation of item?.annotations ?? []) {
    const annotationName = annotation.name ?? annotation.qualifiedName;
    if (!annotationName) continue;
    addEdge('decorates', sourceId, addReferenceNode(annotationName, item.file, {
      relation: 'android-kotlin-annotation',
      allowGlobalFallback: false,
    }), {
      relation: 'android-kotlin-annotation',
      annotationName,
      annotationQualifiedName: annotation.qualifiedName,
      line: annotation.line,
      column: annotation.column,
    }, {
      line: annotation.line,
      column: annotation.column,
    });
  }
}

function addImportEdges(addNode, addReferenceNode, addEdge, sourceId, sourceFile, item) {
  addEdge('imports', sourceId, addNode('file', item.templateUrl, item.templateUrl, {
    metadata: {
      framework: 'angular',
      relation: 'template-url',
      angularProperty: 'templateUrl',
      legacyRelation: 'templateUrl',
    },
  }), {
    framework: 'angular',
    relation: 'template-url',
    angularProperty: 'templateUrl',
    legacyRelation: 'templateUrl',
  });

  for (const styleUrl of item.styleUrls ?? []) {
    addEdge('imports', sourceId, addNode('file', styleUrl, styleUrl, {
      metadata: {
        framework: 'angular',
        relation: 'style-url',
        angularProperty: 'styleUrl',
        legacyRelation: 'styleUrl',
      },
    }), {
      framework: 'angular',
      relation: 'style-url',
      angularProperty: 'styleUrl',
      legacyRelation: 'styleUrl',
    });
  }

  for (const imported of referenceDetails(item.imports, item.importDetails)) {
    addEdge('imports', sourceId, addReferenceNode(imported.name, sourceFile, { relation: 'standalone-import' }), {
      relation: 'standalone-import',
      line: imported.line,
      column: imported.column,
      matchedNeedle: imported.matchedNeedle,
    });
  }

  for (const dynamicImport of item.dynamicImports ?? []) {
    addEdge('imports', sourceId, addNode('file', dynamicImport, dynamicImport, {
      metadata: { relation: 'dynamic-import' },
    }), {
      relation: 'dynamic-import',
    });
  }
}

function resolveAngularRouteTargetId(route, addReferenceNode, addNode) {
  if (route.component) {
    return addReferenceNode(route.component, route.file, { relation: 'route-target' });
  }

  const lazyTarget = route.loadComponent ?? route.loadChildren;
  if (!lazyTarget) return null;

  if (route.exportName) {
    const exportedTargetId = addReferenceNode(route.exportName, lazyTarget, {
      relation: 'route-target',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    });
    if (exportedTargetId) return exportedTargetId;
  }

  return addNode('file', lazyTarget, lazyTarget, {
    metadata: {
      framework: 'angular',
      relation: 'route-target',
      path: route.path,
      exportName: route.exportName,
    },
  });
}

function angularRouteGraphName(route) {
  if (route.path !== null && route.path !== undefined && route.path !== '') return route.path;
  return route.component ?? route.loadComponent ?? route.loadChildren ?? '(root)';
}

function addAngularRouteSemanticEdges(route, sourceId, addReferenceNode, addEdge) {
  if (route.redirectTo !== null && route.redirectTo !== undefined) {
    const targetRoute = normalizeAngularRedirectPath(route.redirectTo);
    const targetId = addReferenceNode(targetRoute, route.file, {
      kind: 'route',
      relation: 'angular-route-redirect',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    });
    addEdge('references', sourceId, targetId, {
      relation: 'angular-route-redirect',
      path: route.path,
      redirectTo: route.redirectTo,
      pathMatch: route.pathMatch,
      line: route.line,
    });
  }

  for (const guard of route.guards ?? []) {
    const targetId = addReferenceNode(guard.name, route.file, {
      relation: 'angular-route-guard',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    });
    addEdge('references', sourceId, targetId, {
      relation: 'angular-route-guard',
      guardKind: guard.guardKind,
      path: route.path,
      line: guard.line,
      column: guard.column,
    });
  }

  for (const resolver of route.resolvers ?? []) {
    const targetId = addReferenceNode(resolver.name, route.file, {
      relation: 'angular-route-resolver',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    });
    addEdge('references', sourceId, targetId, {
      relation: 'angular-route-resolver',
      resolverKey: resolver.resolverKey,
      path: route.path,
      line: resolver.line,
      column: resolver.column,
    });
  }

  for (const provider of route.providers ?? []) {
    const targetId = addReferenceNode(provider.name, route.file, {
      relation: 'angular-route-provider',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    });
    addEdge('references', sourceId, targetId, {
      relation: 'angular-route-provider',
      provider: provider.name,
      path: route.path,
      line: provider.line,
      column: provider.column,
    });
  }
}

function normalizeAngularRedirectPath(redirectTo) {
  return String(redirectTo ?? '').replace(/^\/+/, '');
}

function referenceDetails(names, details) {
  if (Array.isArray(details) && details.length > 0) {
    return details.filter(detail => detail?.name);
  }
  return (names ?? []).map(name => ({ name }));
}

function addDependencyEdges(addReferenceNode, addEdge, sourceId, sourceFile, dependencies, dependencyDetails) {
  for (const dependency of referenceDetails(dependencies, dependencyDetails)) {
    addEdge('type_of', sourceId, addReferenceNode(dependency.name, sourceFile, { relation: 'dependency' }), {
      relation: 'dependency',
      injectionKind: dependency.injectionKind,
      line: dependency.line,
      column: dependency.column,
      matchedNeedle: dependency.matchedNeedle,
    });
  }
}

function addTypeScriptCallableEdges(
  addNode,
  addReferenceNode,
  addEdge,
  sourceId,
  sourceFile,
  item,
  supabaseSelectFieldsByConfig = new Map(),
  supabaseIncrementalPredicates = [],
  supabaseEdgeFunctionRoutesByInvokeName = new Map(),
) {
  addTypeScriptNativeCallableEdges(addReferenceNode, addEdge, sourceId, sourceFile, item);
  addSupabaseCallableSemanticEdges(
    addNode,
    addEdge,
    sourceId,
    sourceFile,
    item,
    supabaseSelectFieldsByConfig,
    supabaseIncrementalPredicates,
    supabaseEdgeFunctionRoutesByInvokeName,
  );
}

function addTypeScriptNativeCallableEdges(addReferenceNode, addEdge, sourceId, sourceFile, item) {
  if (item.returns) {
    addEdge('returns', sourceId, addReferenceNode(item.returns, sourceFile, { relation: 'return-type' }), {
      relation: 'return-type',
    });
  }

  for (const call of item.calls ?? []) {
    addEdge('calls', sourceId, addReferenceNode(call, sourceFile, {
      relation: 'call',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    }), {
      relation: 'call',
    });
  }

  for (const instantiated of item.instantiates ?? []) {
    addEdge('instantiates', sourceId, addReferenceNode(instantiated, sourceFile, { relation: 'new' }), {
      relation: 'new',
    });
  }
}

function addSupabaseCallableSemanticEdges(
  addNode,
  addEdge,
  sourceId,
  sourceFile,
  item,
  supabaseSelectFieldsByConfig = new Map(),
  supabaseIncrementalPredicates = [],
  supabaseEdgeFunctionRoutesByInvokeName = new Map(),
) {
  for (const selectCall of item.supabaseSelects ?? []) {
    for (const inlineField of selectCall.fields ?? []) {
      const owner = callableOwnerFromSourceId(sourceId) || item.qualifiedName || item.name;
      const ownerName = String(owner).replaceAll('::', '.');
      const table = selectCall.table ?? 'unknown';
      const fieldId = addNode('property', inlineField, sourceFile, {
        id: graphNodeId('property', sourceFile, `${ownerName}.${table}.${inlineField}`),
        qualifiedName: `${ownerName}::${table}.${inlineField}`,
        line: selectCall.line,
        startLine: selectCall.line,
        endLine: selectCall.line,
        startColumn: selectCall.column,
        endColumn: selectCall.column,
        signature: `${ownerName}::${table}.${inlineField}: inline select`,
        metadata: {
          relation: 'supabase-select-field',
          table,
          field: inlineField,
          selectSource: 'inline-select',
        },
      });
      const selectField = {
        id: fieldId,
        field: inlineField,
        table,
        selectSource: 'inline-select',
      };
      if (!supabaseSelectFieldsByConfig.has('__inline__')) {
        supabaseSelectFieldsByConfig.set('__inline__', []);
      }
      supabaseSelectFieldsByConfig.get('__inline__').push(selectField);
      addEdge('references', sourceId, fieldId, {
        relation: 'supabase-select-field',
        field: inlineField,
        table,
        selectSource: 'inline-select',
        line: selectCall.line,
        column: selectCall.column,
      });
    }

    const selectFields = supabaseSelectFieldsByConfig.get(selectCall.selectConfig) ?? [];
    for (const selectField of selectFields) {
      if (selectCall.table && selectField.table && selectCall.table !== selectField.table) continue;
      addEdge('references', sourceId, selectField.id, {
        relation: 'supabase-select-field',
        field: selectField.field,
        table: selectCall.table ?? selectField.table,
        selectConfig: selectCall.selectConfig,
        line: selectCall.line,
        column: selectCall.column,
      });
    }
  }

  for (const predicate of item.supabaseIncrementalPredicates ?? []) {
    const owner = callableOwnerFromSourceId(sourceId) || item.qualifiedName || item.name;
    const predicateId = addNode('variable', predicate.name, sourceFile, {
      id: graphNodeId(
        'variable',
        sourceFile,
        `supabase-incremental-predicate:${predicate.table}:${predicate.column}:${predicate.operator}:${owner}`,
      ),
      qualifiedName: `${owner}::${predicate.column}>${predicate.cursorKeyword}`,
      line: predicate.line,
      startLine: predicate.line,
      endLine: predicate.line,
      startColumn: predicate.columnNumber,
      endColumn: predicate.columnNumber,
      signature: `${predicate.table}.${predicate.column} ${predicate.operator} ${predicate.cursor}`,
      metadata: {
        relation: 'supabase-incremental-predicate',
        table: predicate.table,
        column: predicate.column,
        operator: predicate.operator,
        cursor: predicate.cursor,
        cursorKeyword: predicate.cursorKeyword,
      },
    });
    supabaseIncrementalPredicates.push({
      ...predicate,
      id: predicateId,
      sourceId,
      sourceFile,
    });
    addEdge('references', sourceId, predicateId, {
      relation: 'supabase-incremental-predicate',
      table: predicate.table,
      column: predicate.column,
      operator: predicate.operator,
      cursor: predicate.cursor,
      cursorKeyword: predicate.cursorKeyword,
    }, {
      line: predicate.line,
      column: predicate.columnNumber,
    });
  }

  for (const storageBucket of item.supabaseStorageBuckets ?? []) {
    const bucketId = addNode('variable', storageBucket.bucket, sourceFile, {
      id: graphNodeId('variable', sourceFile, `supabase-storage-bucket:${storageBucket.bucket}`),
      qualifiedName: `storage.bucket:${storageBucket.bucket}`,
      line: storageBucket.line,
      startLine: storageBucket.line,
      endLine: storageBucket.line,
      startColumn: storageBucket.column,
      endColumn: storageBucket.column,
      signature: `storage bucket ${storageBucket.bucket}`,
      metadata: {
        relation: 'supabase-storage-bucket',
        bucket: storageBucket.bucket,
        storageSource: 'storage.from',
      },
    });
    addEdge('references', sourceId, bucketId, {
      relation: 'supabase-storage-bucket',
      bucket: storageBucket.bucket,
      storageSource: 'storage.from',
    }, {
      line: storageBucket.line,
      column: storageBucket.column,
    });
  }

  for (const rpcCall of item.supabaseRpcCalls ?? []) {
    const rpcSourceFile = rpcCall.sourceFile ?? sourceFile;
    const rpcId = addNode('variable', rpcCall.functionName, rpcSourceFile, {
      id: graphNodeId('variable', rpcSourceFile, `supabase-rpc:${rpcCall.functionName}`),
      qualifiedName: `supabase.rpc:${rpcCall.functionName}`,
      line: rpcCall.line,
      startLine: rpcCall.line,
      endLine: rpcCall.line,
      startColumn: rpcCall.column,
      endColumn: rpcCall.column,
      signature: `rpc ${rpcCall.functionName}`,
      metadata: stripNullValues({
        relation: 'supabase-rpc',
        functionName: rpcCall.functionName,
        argNames: rpcCall.argNames?.length ? rpcCall.argNames : null,
      }),
    });
    addEdge('references', sourceId, rpcId, stripNullValues({
      relation: 'supabase-rpc',
      functionName: rpcCall.functionName,
      argNames: rpcCall.argNames?.length ? rpcCall.argNames : null,
    }), {
      line: rpcCall.line,
      column: rpcCall.column,
    });
  }

  for (const tableWrite of item.supabaseTableWrites ?? []) {
    const tableWriteSourceFile = tableWrite.sourceFile ?? sourceFile;
    const writeName = `${tableWrite.table}.${tableWrite.writeOperation}`;
    const writeId = addNode('variable', writeName, tableWriteSourceFile, {
      id: graphNodeId(
        'variable',
        tableWriteSourceFile,
        `supabase-table-write:${tableWrite.table}:${tableWrite.writeOperation}`,
      ),
      qualifiedName: `supabase.table_write:${tableWrite.table}.${tableWrite.writeOperation}`,
      line: tableWrite.line,
      startLine: tableWrite.line,
      endLine: tableWrite.line,
      startColumn: tableWrite.column,
      endColumn: tableWrite.column,
      signature: `${tableWrite.writeOperation} ${tableWrite.table}`,
      metadata: stripNullValues({
        relation: 'supabase-table-write',
        table: tableWrite.table,
        writeOperation: tableWrite.writeOperation,
        payloadKeys: tableWrite.payloadKeys?.length ? tableWrite.payloadKeys : null,
        optionKeys: tableWrite.optionKeys?.length ? tableWrite.optionKeys : null,
      }),
    });
    addEdge('references', sourceId, writeId, stripNullValues({
      relation: 'supabase-table-write',
      table: tableWrite.table,
      writeOperation: tableWrite.writeOperation,
      payloadKeys: tableWrite.payloadKeys?.length ? tableWrite.payloadKeys : null,
      optionKeys: tableWrite.optionKeys?.length ? tableWrite.optionKeys : null,
    }), {
      line: tableWrite.line,
      column: tableWrite.column,
    });
  }

  const realtimeOwner = callableOwnerFromSourceId(sourceId) || item.qualifiedName || item.name;
  for (const realtimeChannel of item.supabaseRealtimeChannels ?? []) {
    const channelId = addNode('variable', realtimeChannel.channelName, sourceFile, {
      id: graphNodeId(
        'variable',
        sourceFile,
        `supabase-realtime-channel:${realtimeOwner}:${realtimeChannel.channelName}:${realtimeChannel.line ?? 'unknown-line'}`,
      ),
      qualifiedName: `realtime.channel:${realtimeOwner}:${realtimeChannel.channelName}`,
      line: realtimeChannel.line,
      startLine: realtimeChannel.line,
      endLine: realtimeChannel.line,
      startColumn: realtimeChannel.column,
      endColumn: realtimeChannel.column,
      signature: `realtime channel ${realtimeChannel.channelName}`,
      metadata: {
        relation: 'supabase-realtime-channel',
        channelName: realtimeChannel.channelName,
        owner: realtimeOwner,
      },
    });
    addEdge('references', sourceId, channelId, {
      relation: 'supabase-realtime-channel',
      channelName: realtimeChannel.channelName,
      owner: realtimeOwner,
    }, {
      line: realtimeChannel.line,
      column: realtimeChannel.column,
    });
  }

  for (const postgresChange of item.supabaseRealtimePostgresChanges ?? []) {
    const target = `${postgresChange.schema}.${postgresChange.table ?? '*'}`;
    const postgresChangeId = addNode('variable', `${target} ${postgresChange.event}`, sourceFile, {
      id: graphNodeId(
        'variable',
        sourceFile,
        `supabase-realtime-postgres-change:${realtimeOwner}:${postgresChange.channelName}:${target}:${postgresChange.event}:${postgresChange.line ?? 'unknown-line'}`,
      ),
      qualifiedName: `realtime.postgres_changes:${realtimeOwner}:${postgresChange.channelName}:${target}:${postgresChange.event}`,
      line: postgresChange.line,
      startLine: postgresChange.line,
      endLine: postgresChange.line,
      startColumn: postgresChange.column,
      endColumn: postgresChange.column,
      signature: `postgres_changes ${postgresChange.event} on ${target}`,
      metadata: stripNullValues({
        relation: 'supabase-realtime-postgres-change',
        owner: realtimeOwner,
        channelName: postgresChange.channelName,
        event: postgresChange.event,
        schema: postgresChange.schema,
        table: postgresChange.table ?? null,
        filter: postgresChange.filter ?? null,
      }),
    });
    addEdge('references', sourceId, postgresChangeId, stripNullValues({
      relation: 'supabase-realtime-postgres-change',
      owner: realtimeOwner,
      channelName: postgresChange.channelName,
      event: postgresChange.event,
      schema: postgresChange.schema,
      table: postgresChange.table ?? null,
      filter: postgresChange.filter ?? null,
    }), {
      line: postgresChange.line,
      column: postgresChange.column,
    });
  }

  for (const lifecycleAction of item.supabaseRealtimeLifecycleActions ?? []) {
    const lifecycleOwner = callableOwnerFromSourceId(sourceId) || item.qualifiedName || item.name;
    const actionScope = lifecycleAction.channelName ?? lifecycleAction.channelVariable;
    const actionTarget = actionScope
      ? `${lifecycleAction.action} ${actionScope}`
      : lifecycleAction.action;
    const lifecycleId = addNode('variable', actionTarget, sourceFile, {
      id: graphNodeId(
        'variable',
        sourceFile,
        actionScope
          ? `${lifecycleAction.relation}:${lifecycleOwner}:${actionScope}`
          : `${lifecycleAction.relation}:${lifecycleOwner}`,
      ),
      qualifiedName: actionScope
        ? `realtime.lifecycle:${lifecycleOwner}:${actionScope}:${lifecycleAction.action}`
        : `realtime.lifecycle:${lifecycleOwner}:${lifecycleAction.action}`,
      line: lifecycleAction.line,
      startLine: lifecycleAction.line,
      endLine: lifecycleAction.line,
      startColumn: lifecycleAction.column,
      endColumn: lifecycleAction.column,
      signature: lifecycleAction.channelName
        ? `realtime ${lifecycleAction.action} ${lifecycleAction.channelName}`
        : lifecycleAction.channelVariable
          ? `realtime ${lifecycleAction.action} ${lifecycleAction.channelVariable}`
        : `realtime ${lifecycleAction.action}`,
      metadata: stripNullValues({
        relation: lifecycleAction.relation,
        action: lifecycleAction.action,
        owner: lifecycleOwner,
        channelName: lifecycleAction.channelName ?? null,
        channelVariable: lifecycleAction.channelVariable ?? null,
      }),
    });
    addEdge('references', sourceId, lifecycleId, stripNullValues({
      relation: lifecycleAction.relation,
      action: lifecycleAction.action,
      owner: lifecycleOwner,
      channelName: lifecycleAction.channelName ?? null,
      channelVariable: lifecycleAction.channelVariable ?? null,
    }), {
      line: lifecycleAction.line,
      column: lifecycleAction.column,
    });
  }

  for (const realtimeStatus of item.supabaseRealtimeStatuses ?? []) {
    const statusOwner = callableOwnerFromSourceId(sourceId) || item.qualifiedName || item.name;
    const statusId = addNode('variable', `Realtime status ${realtimeStatus.status}`, sourceFile, {
      id: graphNodeId(
        'variable',
        sourceFile,
        `supabase-realtime-status:${statusOwner}:${realtimeStatus.status}`,
      ),
      qualifiedName: `realtime.status:${statusOwner}:${realtimeStatus.status}`,
      line: realtimeStatus.line,
      startLine: realtimeStatus.line,
      endLine: realtimeStatus.line,
      startColumn: realtimeStatus.column,
      endColumn: realtimeStatus.column,
      signature: `realtime status ${realtimeStatus.status}`,
      metadata: {
        relation: 'supabase-realtime-status',
        status: realtimeStatus.status,
        action: realtimeStatus.action,
        owner: statusOwner,
      },
    });
    addEdge('references', sourceId, statusId, {
      relation: 'supabase-realtime-status',
      status: realtimeStatus.status,
      action: realtimeStatus.action,
      owner: statusOwner,
    }, {
      line: realtimeStatus.line,
      column: realtimeStatus.column,
    });
  }

  for (const invoke of item.supabaseFunctionInvokes ?? []) {
    const route = supabaseEdgeFunctionRoutesByInvokeName.get(invoke.invokeName);
    if (!route) continue;
    addEdge('references', sourceId, route.id, {
      relation: 'edge-function-invoke',
      invokeName: invoke.invokeName,
      path: route.path ?? invoke.path,
    }, {
      line: invoke.line,
      column: invoke.column,
    });
  }
}

function callableOwnerFromSourceId(sourceId) {
  if (typeof sourceId !== 'string') return '';
  return sourceId.split(':').slice(2).join(':');
}

function buildHardRuleImplementationIndex(overlay) {
  const implementations = new Map();
  const addImplementation = (keyword, implementation) => {
    if (!implementations.has(keyword)) implementations.set(keyword, []);
    implementations.get(keyword).push(implementation);
  };

  const visitCallable = (id, callable) => {
    for (const implementationCall of callable.hardRuleImplementationCalls ?? []) {
      addImplementation(implementationCall.keyword, {
        id,
        relation: isTestSourceFile(implementationCall.file ?? callable.file ?? filePathFromGraphNodeId(id))
          ? 'hard-rule-test-evidence'
          : 'hard-rule-implementation',
        call: implementationCall.call,
        line: implementationCall.line ?? callable.line ?? callable.startLine,
        column: implementationCall.column ?? callable.column ?? callable.startColumn,
      });
    }
  };

  for (const classSymbol of overlay.typescript?.classes ?? []) {
    const className = classSymbol.qualifiedName ?? classSymbol.className;
    for (const method of classSymbol.methods ?? []) {
      visitCallable(
        graphNodeId('method', classSymbol.file, `${className}.${method.name}`),
        method,
      );
    }
    for (const property of classSymbol.properties ?? []) {
      visitCallable(
        graphNodeId('property', classSymbol.file, `${className}.${property.name}`),
        property,
      );
    }
  }

  for (const functionSymbol of overlay.typescript?.functions ?? []) {
    visitCallable(
      graphNodeId('function', functionSymbol.file, functionSymbol.qualifiedName ?? functionSymbol.name),
      functionSymbol,
    );
  }

  for (const variableSymbol of overlay.typescript?.variables ?? []) {
    visitCallable(
      graphNodeId(variableKind(variableSymbol), variableSymbol.file, variableSymbol.qualifiedName ?? variableSymbol.name),
      variableSymbol,
    );
  }

  for (const [keyword, items] of implementations) {
    implementations.set(keyword, uniqueObjects(items));
  }
  return implementations;
}

function filePathFromGraphNodeId(id) {
  if (typeof id !== 'string') return '';
  const [, filePath = ''] = id.split(':');
  return filePath;
}

function isTestSourceFile(filePath) {
  return /(?:^|[\\/])(?:e2e|test|tests|__tests__)[\\/]/i.test(filePath)
    || /\.(?:spec|test)(?:-[^.]+)?\.[cm]?[jt]sx?$/i.test(filePath);
}

function findRequiredSyncFieldsForKeyword(keyword, supabaseSelectFieldsByConfig) {
  const requiredField = String(keyword ?? '').trim();
  if (!requiredField) return [];
  return [...supabaseSelectFieldsByConfig.values()]
    .flat()
    .filter(selectField => selectField.field === requiredField);
}

function findRequiredSyncPredicatesForKeyword(keyword, supabaseIncrementalPredicates) {
  const normalized = String(keyword ?? '').trim();
  if (normalized === 'updated_at') {
    return supabaseIncrementalPredicates.filter(predicate => predicate.column === 'updated_at');
  }
  if (normalized === 'last_sync_time') {
    return supabaseIncrementalPredicates.filter(predicate => predicate.cursorKeyword === 'last_sync_time');
  }
  return [];
}

function addMemberSemanticEdges(addReferenceNode, addEdge, memberId, sourceFile, classSymbol, member) {
  for (const decorator of member.decorators ?? []) {
    addEdge('decorates', memberId, addReferenceNode(decorator.name, sourceFile, { relation: 'decorator' }), {
      relation: 'decorator',
      line: decorator.line,
      column: decorator.column,
    });
    for (const argumentReference of decorator.argumentReferences ?? []) {
      addEdge('references', memberId, addReferenceNode(argumentReference, sourceFile, {
        relation: 'decorator-argument',
        allowGlobalFallback: false,
      }), {
        relation: 'decorator-argument',
        line: decorator.line,
        column: decorator.column,
      });
    }
  }

  if (!member.isOverride) return;
  for (const baseClass of classSymbol.extends ?? []) {
    addEdge('overrides', memberId, addReferenceNode(member.name, sourceFile, {
      relation: 'override',
      qualifiedName: `${baseClass}::${member.name}`,
    }), {
      relation: 'override',
    });
  }
}

function addInterfaceImplementationEdges(overlay, addReferenceNode, addEdge) {
  const ownerMethodsById = new Map();
  for (const classSymbol of overlay.typescript?.classes ?? []) {
    registerTypeOwnerMethods(ownerMethodsById, 'class', classSymbol);
  }
  for (const interfaceSymbol of overlay.typescript?.interfaces ?? []) {
    registerTypeOwnerMethods(ownerMethodsById, 'interface', interfaceSymbol);
  }
  for (const typeSymbol of overlay.typescript?.types ?? []) {
    registerTypeOwnerMethods(ownerMethodsById, 'type_alias', typeSymbol);
  }

  const seen = new Set();
  for (const classSymbol of overlay.typescript?.classes ?? []) {
    const classId = graphNodeId('class', classSymbol.file, typeOwnerQualifiedName(classSymbol));
    const implMethods = ownerMethodsById.get(classId) ?? [];
    if (!implMethods.length) continue;

    const implByName = new Map();
    for (const method of implMethods) {
      const methods = implByName.get(method.name) ?? [];
      methods.push(method);
      implByName.set(method.name, methods);
    }

    const supertypes = [
      ...(classSymbol.implements ?? []).map(name => ({ name, relation: 'implements' })),
      ...(classSymbol.extends ?? []).map(name => ({ name, relation: 'extends' })),
    ];
    for (const supertype of supertypes) {
      const baseId = addReferenceNode(supertype.name, classSymbol.file, { relation: supertype.relation });
      if (!baseId || baseId === classId) continue;

      const baseMethods = ownerMethodsById.get(baseId) ?? [];
      let added = 0;
      for (const baseMethod of baseMethods) {
        if (added >= MAX_SYNTHETIC_EDGES_PER_CHANNEL) break;
        for (const implMethod of implByName.get(baseMethod.name) ?? []) {
          if (added >= MAX_SYNTHETIC_EDGES_PER_CHANNEL) break;
          if (baseMethod.id === implMethod.id) continue;

          const key = `${baseMethod.id}>${implMethod.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          addEdge('calls', baseMethod.id, implMethod.id, {
            synthesizedBy: 'interface-impl',
            via: implMethod.name,
            registeredAt: implMethod.line ? `${implMethod.file}:${implMethod.line}` : null,
          }, {
            line: baseMethod.line,
            provenance: 'heuristic',
          });
          added++;
        }
      }
    }
  }
}

function registerTypeOwnerMethods(ownerMethodsById, kind, symbol) {
  const ownerQualifiedName = typeOwnerQualifiedName(symbol);
  const ownerId = graphNodeId(kind, symbol.file, ownerQualifiedName);
  ownerMethodsById.set(ownerId, (symbol.methods ?? []).map(method => ({
    id: graphNodeId('method', symbol.file, `${ownerQualifiedName}.${method.name}`),
    name: method.name,
    file: symbol.file,
    line: method.startLine ?? method.line ?? null,
  })));
}

function typeOwnerQualifiedName(symbol) {
  return symbol.qualifiedName ?? symbol.className ?? symbol.name;
}

function addFileContainsEdge(addReferenceNode, addEdge, filePath, symbolId) {
  addEdge('contains', addReferenceNode(filePath, filePath, { kind: 'file', relation: 'source-file' }), symbolId, {
    relation: 'file-symbol',
  });
}

function addLocalDeclarationEdge(addReferenceNode, addEdge, symbol, symbolId) {
  if (!symbol?.localDeclarationOwnerQualifiedName) return;
  const ownerId = addReferenceNode(
    readQualifiedNameLeaf(symbol.localDeclarationOwnerQualifiedName),
    symbol.file,
    {
      kind: symbol.localDeclarationOwnerKind ?? 'function',
      qualifiedName: symbol.localDeclarationOwnerQualifiedName,
      relation: 'local-declaration-owner',
    },
  );
  addEdge('contains', ownerId, symbolId, { relation: 'local-declaration' });
}

function addTypeReferenceEdge(addReferenceNode, addEdge, sourceId, sourceFile, typeReference) {
  addEdge('type_of', sourceId, addReferenceNode(typeReference, sourceFile, { relation: 'type-reference' }), {
    relation: 'type-reference',
  });
}

function addTypeParameterReferenceEdges(addReferenceNode, addEdge, sourceId, sourceFile, typeParameterReferences) {
  for (const reference of typeParameterReferences ?? []) {
    addEdge('type_of', sourceId, addReferenceNode(reference.target, sourceFile, { relation: reference.relation }), {
      relation: reference.relation,
      typeParameter: reference.typeParameter,
    });
  }
}

function addAndroidKotlinTypeReferenceEdges(
  addReferenceNode,
  addEdge,
  sourceId,
  sourceItem,
  typeReferences,
  declarations,
  kotlinImports,
) {
  for (const reference of typeReferences ?? []) {
    const typeName = reference.typeName;
    if (!typeName || isAndroidKotlinBuiltinType(typeName)) continue;
    const resolvedType = resolveAndroidKotlinTypeTarget(sourceItem, typeName, declarations, kotlinImports);
    const targetName = resolvedType.targetName ?? typeName;
    const targetId = resolvedType.declaration
      ? graphNodeId(
        resolvedType.declaration.classKind === 'enum class' ? 'enum' : androidKotlinNodeKind(resolvedType.declaration),
        resolvedType.declaration.file,
        resolvedType.declaration.qualifiedName ?? resolvedType.declaration.name,
      )
      : addReferenceNode(targetName, sourceItem.file, {
        kind: 'variable',
        relation: 'android-kotlin-type-reference',
        allowGlobalFallback: false,
        line: reference.line,
        metadata: {
          typeName,
          targetName,
          typeRole: reference.typeRole,
          parameterName: reference.parameterName,
        },
      });
    addEdge('type_of', sourceId, targetId, {
      relation: 'android-kotlin-type-reference',
      typeName,
      targetName,
      typeRole: reference.typeRole,
      parameterName: reference.parameterName,
      line: reference.line,
    }, {
      line: reference.line,
      column: reference.column,
    });
  }
}

function addAndroidKotlinOverrideEdges(
  addReferenceNode,
  addEdge,
  sourceId,
  member,
  ownerDeclaration,
  memberIndex,
  declarations,
  kotlinImports,
  targetKind,
) {
  for (const overrideTarget of findAndroidKotlinOverrideTargets(
    member,
    ownerDeclaration,
    memberIndex,
    declarations,
    kotlinImports,
  )) {
    const targetId = overrideTarget.targetMember
      ? graphNodeId(targetKind, overrideTarget.targetMember.file, overrideTarget.targetMember.qualifiedName ?? overrideTarget.targetMember.name)
      : addReferenceNode(overrideTarget.targetName, member.file, {
        kind: 'variable',
        relation: 'android-kotlin-override',
        allowGlobalFallback: false,
        line: member.line,
        metadata: {
          typeName: overrideTarget.typeName,
          memberName: member.name,
          targetName: overrideTarget.targetName,
        },
      });
    addEdge('overrides', sourceId, targetId, {
      relation: 'android-kotlin-override',
      typeName: overrideTarget.typeName,
      memberName: member.name,
      targetName: overrideTarget.targetName,
      line: member.line,
    }, {
      line: member.line,
    });
  }
}

function addValueReferenceEdge(addReferenceNode, addEdge, sourceId, sourceFile, valueReference) {
  addEdge('references', sourceId, addReferenceNode(valueReference, sourceFile, {
    relation: 'initializer-reference',
    allowGlobalFallback: false,
  }), {
    relation: 'initializer-reference',
  });
}

function addJsxReferenceEdge(addReferenceNode, addEdge, sourceId, sourceFile, jsxReference) {
  addEdge('calls', sourceId, addReferenceNode(jsxReference, sourceFile, { relation: 'jsx-component' }), {
    relation: 'jsx-component',
  });
}

function addParameterEdges(addNode, addReferenceNode, addEdge, ownerId, sourceFile, idOwnerName, qualifiedOwnerName, parameters) {
  for (const parameter of parameters ?? []) {
    const parameterId = addNode('parameter', parameter.name, sourceFile, {
      id: graphNodeId('parameter', sourceFile, `${idOwnerName}.${parameter.name}`),
      qualifiedName: `${qualifiedOwnerName}::${parameter.name}`,
      ...nodeOptions(parameter),
      signature: parameter.signature,
    });
    addEdge('contains', ownerId, parameterId, { relation: 'parameter' });
    for (const typeReference of parameter.typeReferences ?? []) {
      addEdge('type_of', parameterId, addReferenceNode(typeReference, sourceFile, { relation: 'parameter-type' }), {
        relation: 'parameter-type',
      });
    }
  }
}

function addTestEdges(addReferenceNode, addEdge, sourceId, tests, testMappings = []) {
  const normalizedMappings = uniqueTestMappings(testMappings);
  if (normalizedMappings.length > 0) {
    for (const mapping of normalizedMappings) {
      addEdge('references', sourceId, addReferenceNode(mapping.file, mapping.file, { kind: 'file', relation: 'test' }), {
        relation: 'test',
        testMapping: mapping.testMapping,
        matchedNeedle: mapping.matchedNeedle,
      });
    }
    return;
  }

  for (const test of tests ?? []) {
    addEdge('references', sourceId, addReferenceNode(test, test, { kind: 'file', relation: 'test' }), {
      relation: 'test',
    });
  }
}

function addClassSemanticEdges(addReferenceNode, addEdge, sourceId, sourceFile, item) {
  for (const binding of item.templateBindings ?? []) {
    addEdge('references', sourceId, addReferenceNode(binding.name, sourceFile, { relation: 'template-binding' }), {
      relation: 'template-binding',
      bindingKind: binding.kind,
      binding: binding.binding,
      templateFile: binding.templateFile,
      matchedNeedle: binding.matchedNeedle ?? binding.name,
      line: binding.line,
      column: binding.column,
    });
  }

  for (const input of item.inputs ?? []) {
    addEdge('references', sourceId, addReferenceNode(input.name, sourceFile, { relation: 'input' }), {
      relation: 'input',
      api: input.api,
      alias: input.alias,
      line: input.line,
    });
  }

  for (const output of item.outputs ?? []) {
    addEdge('calls', sourceId, addReferenceNode(output.name, sourceFile, { relation: 'output' }), {
      relation: 'output',
      api: output.api,
      alias: output.alias,
      line: output.line,
    });
  }

  for (const model of item.models ?? []) {
    addEdge('references', sourceId, addReferenceNode(model.name, sourceFile, { relation: 'model' }), {
      relation: 'model',
      api: model.api,
      line: model.line,
    });
  }

  for (const query of item.queries ?? []) {
    addEdge('references', sourceId, addReferenceNode(query.target ?? query.name, sourceFile, { relation: 'query' }), {
      relation: 'query',
      api: query.api,
      line: query.line,
    });
  }

  for (const signal of item.signals ?? []) {
    addEdge('calls', sourceId, addReferenceNode(signal.name, sourceFile, { relation: 'signal' }), {
      relation: 'signal',
      api: signal.api,
      line: signal.line,
    });
  }

  for (const hostAttribute of item.hostAttributes ?? []) {
    addEdge('references', sourceId, addReferenceNode(hostAttribute.name, sourceFile, {
      relation: 'host-attribute',
      allowGlobalFallback: false,
      line: hostAttribute.line,
    }), {
      relation: 'host-attribute',
      api: hostAttribute.api,
      attribute: hostAttribute.name,
      value: hostAttribute.value,
      kind: hostAttribute.kind,
      line: hostAttribute.line,
    });
  }

  for (const hostBinding of item.hostBindings ?? []) {
    addEdge('references', sourceId, addReferenceNode(hostBinding.name, sourceFile, {
      allowGlobalFallback: false,
      line: hostBinding.line,
    }), {
      relation: 'host-binding',
      api: hostBinding.api,
      binding: hostBinding.binding,
      expression: hostBinding.expression,
      kind: hostBinding.kind,
      line: hostBinding.line,
    });
  }

  for (const hostListener of item.hostListeners ?? []) {
    addEdge('calls', sourceId, addReferenceNode(hostListener.name, sourceFile, {
      allowGlobalFallback: false,
      line: hostListener.line,
    }), {
      relation: 'host-listener',
      api: hostListener.api,
      event: hostListener.event,
      expression: hostListener.expression,
      line: hostListener.line,
    });
  }

  for (const hostDirective of item.hostDirectives ?? []) {
    if (!hostDirective.directive) continue;
    addEdge('references', sourceId, addReferenceNode(hostDirective.directive, sourceFile, { relation: 'host-directive' }), {
      relation: 'host-directive',
      inputs: hostDirective.inputs,
      outputs: hostDirective.outputs,
      line: hostDirective.line,
    });
  }
}

function buildAngularTemplateUsageIndex(overlay) {
  const componentsByElement = new Map();
  const directiveSelectors = [];
  const pipesByName = new Map();

  for (const component of overlay.angular?.components ?? []) {
    const selector = normalizeAngularElementSelector(component.selector);
    if (!selector || componentsByElement.has(selector)) continue;
    componentsByElement.set(selector, component);
  }

  for (const directive of overlay.angular?.directives ?? []) {
    for (const selector of readAngularDirectiveSelectors(directive.selector)) {
      if (selector) {
        directiveSelectors.push({ directive, selector });
      }
    }
  }

  for (const pipe of overlay.angular?.pipes ?? []) {
    if (!pipe.name || pipesByName.has(pipe.name)) continue;
    pipesByName.set(pipe.name, pipe);
  }

  return {
    componentsByElement,
    directiveSelectors,
    pipesByName,
  };
}

function addAngularTemplateUsageEdges(addReferenceNode, addEdge, sourceId, component, index) {
  const sourceFile = component.file;
  for (const elementUsage of component.templateUsages?.elements ?? []) {
    const element = readTemplateUsageName(elementUsage);
    const target = index.componentsByElement.get(element);
    if (!target) continue;
    const targetId = addReferenceNode(target.className, target.file, {
      relation: 'template-component',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    });
    addEdge('references', sourceId, targetId, {
      relation: 'template-component',
      selector: target.selector,
      element,
      ...templateUsageLocationMetadata(elementUsage, element),
    });
  }

  const directiveEdges = new Set();
  for (const usage of component.templateUsages?.elementUsages ?? []) {
    for (const entry of index.directiveSelectors) {
      const metadata = matchAngularDirectiveSelector(entry.selector, usage);
      if (!metadata) continue;
      const target = entry.directive;
      const targetId = addReferenceNode(target.className, target.file, {
        relation: 'template-directive',
        allowGlobalFallback: false,
        materializeUnresolved: false,
      });
      const key = `${targetId}:${entry.selector.raw}:${metadata.element ?? ''}:${metadata.attribute ?? ''}:${metadata.attributeValue ?? ''}:${metadata.className ?? ''}`;
      if (directiveEdges.has(key)) continue;
      directiveEdges.add(key);
      addEdge('references', sourceId, targetId, {
        relation: 'template-directive',
        selector: target.selector,
        ...metadata,
        ...templateUsageLocationMetadata(usage, metadata.attribute ?? metadata.className ?? metadata.element ?? usage.tagName),
      });
    }
  }

  for (const pipeUsage of component.templateUsages?.pipes ?? []) {
    const pipeName = readTemplateUsageName(pipeUsage);
    const target = index.pipesByName.get(pipeName);
    if (!target) continue;
    const targetId = addReferenceNode(target.className, target.file, {
      relation: 'template-pipe',
      allowGlobalFallback: false,
      materializeUnresolved: false,
    });
    addEdge('references', sourceId, targetId, {
      relation: 'template-pipe',
      pipeName,
      ...templateUsageLocationMetadata(pipeUsage, pipeName),
    });
  }
}

function readTemplateUsageName(usage) {
  return typeof usage === 'string' ? usage : usage?.name;
}

function templateUsageLocationMetadata(usage, matchedNeedle) {
  if (!usage || typeof usage === 'string') return {};
  return stripNullValues({
    templateFile: usage.templateFile,
    line: usage.line,
    column: usage.column,
    matchedNeedle,
  });
}

function normalizeAngularElementSelector(selector) {
  if (!selector || selector.includes(',') || selector.includes('[') || selector.includes('.') || selector.includes(':')) {
    return null;
  }
  const trimmed = selector.trim();
  return /^[a-z][\w.-]*$/u.test(trimmed) ? trimmed : null;
}

function readAngularDirectiveSelectors(selector) {
  if (!selector) return [];
  return splitAngularSelectorList(selector)
    .map(part => parseAngularDirectiveSelector(part.trim()))
    .filter(Boolean);
}

function splitAngularSelectorList(selector) {
  const parts = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  let escaped = false;
  for (const char of String(selector ?? '')) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      current += char;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
      current += char;
      continue;
    }
    if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function parseAngularDirectiveSelector(selector) {
  if (!selector) return null;
  const notSelectors = [];
  let positiveSelector = selector;
  positiveSelector = positiveSelector.replace(/:not\(([^()]*)\)/gu, (_match, negatedSelector) => {
    const parsedNegatedSelector = parseAngularDirectiveSelector(String(negatedSelector).trim());
    if (parsedNegatedSelector) notSelectors.push(parsedNegatedSelector);
    return '';
  });
  if (positiveSelector.includes(':')) return null;
  const elementMatch = /^([a-z][\w.-]*)/u.exec(positiveSelector);
  const classNames = [];
  const attributes = [];
  const selectorWithoutAttributeValues = positiveSelector.replace(/\[[^\]]*\]/gu, '');
  const classPattern = /\.([A-Za-z_$][\w$.-]*)/gu;
  const attributePattern = /\[\s*([A-Za-z_$][\w$.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/gu;
  let match;
  while ((match = classPattern.exec(selectorWithoutAttributeValues)) !== null) {
    classNames.push(match[1]);
  }
  while ((match = attributePattern.exec(positiveSelector)) !== null) {
    attributes.push({
      name: match[1],
      value: match[2] ?? match[3] ?? match[4] ?? null,
    });
  }
  if (!elementMatch && classNames.length === 0 && attributes.length === 0) return null;
  return {
    raw: selector,
    element: elementMatch?.[1] ?? null,
    classNames: unique(classNames),
    attributes: uniqueObjects(attributes),
    notSelectors,
  };
}

function matchAngularDirectiveSelector(selector, usage) {
  if (selector.element && selector.element !== usage.tagName) return null;
  for (const className of selector.classNames) {
    if (!(usage.classes ?? []).includes(className)) return null;
  }
  for (const expected of selector.attributes) {
    const actual = (usage.attributes ?? []).find(attribute => attribute.name === expected.name);
    if (!actual) return null;
    if (expected.value !== null && expected.value !== undefined && actual.value !== expected.value) return null;
  }
  for (const negatedSelector of selector.notSelectors ?? []) {
    if (matchAngularDirectiveSelector(negatedSelector, usage)) return null;
  }

  return stripNullValues({
    element: selector.element ?? usage.tagName,
    className: selector.classNames[0] ?? null,
    attribute: selector.attributes[0]?.name ?? null,
    attributeValue: selector.attributes[0]?.value ?? null,
  });
}

function buildImportAliasIndex(overlay) {
  const aliases = new Map();
  for (const importSymbol of overlay.typescript?.imports ?? []) {
    if (!importSymbol.name || !importSymbol.target) continue;
    aliases.set(symbolKey(importSymbol.file, importSymbol.name), {
      targetFile: importSymbol.target,
      importedName: importSymbol.importedName ?? importSymbol.name,
      relation: importSymbol.relation ?? 'import',
    });
  }
  return aliases;
}

function registerDefaultExportAlias(symbol, symbolId, symbolNodesByFileAndName) {
  if (!symbol?.isDefaultExport || !symbol?.file || !symbolId) return;
  if (!symbolNodesByFileAndName.has(symbolKey(symbol.file, 'default'))) {
    symbolNodesByFileAndName.set(symbolKey(symbol.file, 'default'), symbolId);
  }
}

function buildExportTargetIndex(overlay) {
  const exportsByFileAndName = new Map();
  for (const exportSymbol of overlay.typescript?.exports ?? []) {
    if (!exportSymbol.name || !exportSymbol.target) continue;
    exportsByFileAndName.set(symbolKey(exportSymbol.file, exportSymbol.exportName ?? exportSymbol.name), {
      targetFile: exportSymbol.target,
      targetName: exportSymbol.name,
    });
  }
  return exportsByFileAndName;
}

function buildSupabaseEdgeFunctionRouteIndex(overlay) {
  const routesByInvokeName = new Map();
  for (const edgeFunction of overlay.supabase?.edgeFunctions ?? []) {
    for (const route of edgeFunction.routes ?? []) {
      if (!route.invokeName || !route.path || !edgeFunction.entry) continue;
      if (routesByInvokeName.has(route.invokeName)) continue;
      routesByInvokeName.set(route.invokeName, {
        id: graphNodeId('route', edgeFunction.entry, route.path),
        entry: edgeFunction.entry,
        path: route.path,
        functionName: edgeFunction.name,
      });
    }
  }
  return routesByInvokeName;
}

function resolveReferenceNodeId(
  name,
  sourceFile,
  options,
  symbolNodesByFileAndName,
  importAliasesByFileAndName,
  exportTargetsByFileAndName,
) {
  if (!name) return null;

  const commonJsAlias = importAliasesByFileAndName.get(symbolKey(sourceFile, name));
  if (commonJsAlias?.relation === 'commonjs-require') {
    const imported = resolveImportedAliasNodeId(name, commonJsAlias, symbolNodesByFileAndName, exportTargetsByFileAndName);
    if (imported) return imported;
  }

  const direct = symbolNodesByFileAndName.get(symbolKey(sourceFile, name));
  if (direct) return direct;

  const qualified = resolveQualifiedNameNodeId(name, sourceFile, symbolNodesByFileAndName);
  if (qualified) return qualified;

  const imported = importAliasesByFileAndName.get(symbolKey(sourceFile, name));
  const importedAlias = resolveImportedAliasNodeId(name, imported, symbolNodesByFileAndName, exportTargetsByFileAndName);
  if (importedAlias) return importedAlias;

  const namespaceMember = resolveNamespaceImportMemberNodeId(
    name,
    sourceFile,
    symbolNodesByFileAndName,
    importAliasesByFileAndName,
    exportTargetsByFileAndName,
  );
  if (namespaceMember) return namespaceMember;

  const importedMember = resolveImportedObjectMemberNodeId(
    name,
    sourceFile,
    symbolNodesByFileAndName,
    importAliasesByFileAndName,
    exportTargetsByFileAndName,
  );
  if (importedMember) return importedMember;

  const explicitFile = options.filePath;
  if (explicitFile) {
    return symbolNodesByFileAndName.get(symbolKey(explicitFile, name)) ?? null;
  }

  return null;
}

function resolveImportedAliasNodeId(name, imported, symbolNodesByFileAndName, exportTargetsByFileAndName) {
  if (!imported || imported.importedName === '*') return null;
  if (imported.relation === 'commonjs-require' && imported.importedName === 'module.exports') {
    return symbolNodesByFileAndName.get(symbolKey(imported.targetFile, 'module.exports')) ?? null;
  }

  const importedName = imported.importedName === 'default' ? 'default' : imported.importedName;
  const exported = exportTargetsByFileAndName.get(symbolKey(imported.targetFile, importedName));
  if (exported) {
    return symbolNodesByFileAndName.get(symbolKey(exported.targetFile, exported.targetName))
      ?? symbolNodesByFileAndName.get(symbolKey(exported.targetFile, importedName))
      ?? null;
  }
  return symbolNodesByFileAndName.get(symbolKey(imported.targetFile, importedName))
    ?? symbolNodesByFileAndName.get(symbolKey(imported.targetFile, name))
    ?? null;
}

function resolveQualifiedNameNodeId(name, sourceFile, symbolNodesByFileAndName) {
  if (!String(name).includes('.')) return null;
  const segments = String(name).split('.');
  for (let index = 1; index < segments.length; index += 1) {
    const qualifiedName = `${segments.slice(0, index).join('.')}::${segments.slice(index).join('.')}`;
    const candidate = symbolNodesByFileAndName.get(symbolKey(sourceFile, qualifiedName));
    if (candidate) return candidate;
  }
  return null;
}

function resolveNamespaceImportMemberNodeId(
  name,
  sourceFile,
  symbolNodesByFileAndName,
  importAliasesByFileAndName,
  exportTargetsByFileAndName,
) {
  const dotIndex = String(name).indexOf('.');
  if (dotIndex <= 0) return null;

  const namespaceAlias = String(name).slice(0, dotIndex);
  const memberName = String(name).slice(dotIndex + 1);
  if (!namespaceAlias || !memberName) return null;

  const imported = importAliasesByFileAndName.get(symbolKey(sourceFile, namespaceAlias));
  if (!imported || imported.importedName !== '*') return null;

  const exported = exportTargetsByFileAndName.get(symbolKey(imported.targetFile, memberName));
  if (exported) {
    return symbolNodesByFileAndName.get(symbolKey(exported.targetFile, exported.targetName))
      ?? symbolNodesByFileAndName.get(symbolKey(exported.targetFile, memberName))
      ?? null;
  }

  return symbolNodesByFileAndName.get(symbolKey(imported.targetFile, memberName)) ?? null;
}

function resolveImportedObjectMemberNodeId(
  name,
  sourceFile,
  symbolNodesByFileAndName,
  importAliasesByFileAndName,
  exportTargetsByFileAndName,
) {
  const dotIndex = String(name).indexOf('.');
  if (dotIndex <= 0) return null;

  const localAlias = String(name).slice(0, dotIndex);
  const memberName = String(name).slice(dotIndex + 1);
  if (!localAlias || !memberName) return null;

  const imported = importAliasesByFileAndName.get(symbolKey(sourceFile, localAlias));
  if (!imported || imported.importedName === '*') return null;

  if (imported.relation === 'commonjs-require' && imported.importedName === 'module.exports') {
    const exported = exportTargetsByFileAndName.get(symbolKey(imported.targetFile, memberName));
    if (exported) {
      return symbolNodesByFileAndName.get(symbolKey(exported.targetFile, exported.targetName))
        ?? symbolNodesByFileAndName.get(symbolKey(exported.targetFile, memberName))
        ?? null;
    }
    return symbolNodesByFileAndName.get(symbolKey(imported.targetFile, `module.exports::${memberName}`))
      ?? symbolNodesByFileAndName.get(symbolKey(imported.targetFile, memberName))
      ?? null;
  }

  const importedName = imported.importedName === 'default' ? 'default' : imported.importedName;
  const exported = exportTargetsByFileAndName.get(symbolKey(imported.targetFile, importedName));
  const targetFile = exported?.targetFile ?? imported.targetFile;
  const ownerName = exported?.targetName ?? importedName;

  return symbolNodesByFileAndName.get(symbolKey(targetFile, `${ownerName}::${memberName}`))
    ?? symbolNodesByFileAndName.get(symbolKey(targetFile, memberName))
    ?? null;
}

function inferLanguage(filePath) {
  if (!filePath) return 'unknown';
  if (/\.(ts|mts|cts)$/.test(filePath)) return 'typescript';
  if (/\.tsx$/.test(filePath)) return 'tsx';
  if (/\.(js|mjs|cjs)$/.test(filePath)) return 'javascript';
  if (/\.jsx$/.test(filePath)) return 'jsx';
  if (/\.kt$/i.test(filePath)) return 'kotlin';
  if (/\.xml$/i.test(filePath)) return 'xml';
  return 'unknown';
}

function normalizeCodeGraphLanguage(language) {
  return OFFICIAL_CODEGRAPH_LANGUAGES.has(language) ? language : 'unknown';
}

function graphNodeId(kind, filePath, name) {
  return `${kind}:${filePath ?? ''}:${name}`;
}

function symbolKey(filePath, name) {
  return `${filePath ?? ''}:${normalizeSymbolName(name)}`;
}

function normalizeSymbolName(name) {
  return String(name ?? '');
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readAgentsConfigKeyParts(name) {
  const match = /^([A-Z0-9_]+_CONFIG)\.([A-Z0-9_]+(?:\.[A-Z0-9_]+)*)$/.exec(String(name ?? ''));
  if (!match) return null;
  const [, configObject, configPath] = match;
  const filePath = AGENTS_CONFIG_SOURCE_FILES.get(configObject);
  if (!filePath) return null;
  const pathSegments = configPath.split('.');
  return {
    configObject,
    configKey: `${configObject}.${configPath}`,
    configProperty: pathSegments.at(-1),
    configPath,
    filePath,
  };
}

function readQualifiedNameLeaf(name) {
  return String(name ?? '').split('::').at(-1) ?? '';
}

function isSymbolLikeKind(kind) {
  return ['component', 'class', 'function', 'method', 'interface', 'type_alias', 'constant', 'variable', 'property', 'enum', 'enum_member', 'namespace', 'route'].includes(kind);
}

function isCallableGraphNodeKind(kind) {
  return kind === 'function' || kind === 'method';
}

function variableKind(symbol) {
  return symbol?.isConst ? 'constant' : 'variable';
}

function mergeNode(existing, next) {
  return stripNullValues({
    ...existing,
    ...next,
    ...mergeNodeLocation(existing, next),
    metadata: nonEmptyObject({
      ...(existing.metadata ?? {}),
      ...(next.metadata ?? {}),
    }),
  });
}

function nativeNodeLocation(options = {}) {
  const startLine = normalizePositiveLine(options.startLine ?? options.line);
  const endLine = Math.max(startLine, normalizePositiveLine(options.endLine ?? options.line ?? startLine));
  return {
    startLine,
    endLine,
    startColumn: normalizeColumn(options.startColumn),
    endColumn: normalizeColumn(options.endColumn ?? options.startColumn),
  };
}

function mergeNodeLocation(existing, next) {
  const first = nativeNodeLocation(existing);
  const second = nativeNodeLocation(next);
  const startLine = Math.min(first.startLine, second.startLine);
  const endLine = Math.max(first.endLine, second.endLine);
  return {
    startLine,
    endLine,
    startColumn: first.startLine <= second.startLine ? first.startColumn : second.startColumn,
    endColumn: first.endLine >= second.endLine ? first.endColumn : second.endColumn,
  };
}

function normalizePositiveLine(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizeColumn(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function compareGraphNodes(a, b) {
  return String(a.filePath ?? '').localeCompare(String(b.filePath ?? ''))
    || String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
    || String(a.name ?? '').localeCompare(String(b.name ?? ''));
}

function compareGraphEdges(a, b) {
  return String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
    || String(a.source ?? '').localeCompare(String(b.source ?? ''))
    || String(a.target ?? '').localeCompare(String(b.target ?? ''));
}

function stripNullValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== null && entryValue !== undefined),
  );
}

function nonEmptyObject(value) {
  if (!value) return null;
  const stripped = stripNullValues(value);
  return Object.keys(stripped).length > 0 ? stripped : null;
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function normalizeDecoratorNames(decorators) {
  if (!Array.isArray(decorators)) return null;
  return nonEmptyArray(unique(decorators
    .map(decorator => typeof decorator === 'string' ? decorator : decorator?.name)
    .filter(Boolean)));
}

function findReferencingTests(projectRoot, className, specBySubject) {
  return testFilesFromMappings(findReferencingTestMappings(projectRoot, className, specBySubject));
}

function findReferencingTestMappings(projectRoot, className, specBySubject) {
  const mappings = [];
  const seen = new Set();
  for (const specFile of specBySubject.values()) {
    if (seen.has(specFile)) continue;
    seen.add(specFile);

    const source = readSnapshotFileUtf8(specFile);
    if (source === null) continue;
    if (hasClassReferenceTestEvidence(specFile, source, className)) {
      mappings.push({
        file: relative(projectRoot, specFile),
        testMapping: 'class-reference',
        matchedSymbol: className,
      });
    }
  }
  return uniqueTestMappings(mappings);
}

function hasClassReferenceTestEvidence(specFile, sourceText, className) {
  if (!sourceText.includes(className)) {
    return false;
  }

  const source = ts.createSourceFile(
    specFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(specFile),
  );
  let found = false;
  visit(source, node => {
    if (found || !ts.isIdentifier(node) || node.text !== className) {
      return;
    }
    if (isIgnoredClassReferenceTestIdentifier(node)) {
      return;
    }
    found = true;
  });
  return found;
}

function isIgnoredClassReferenceTestIdentifier(node) {
  if (isInsideImportOrExportDeclaration(node)) {
    return true;
  }
  if (isInsideTypeOnlyTestReference(node)) {
    return true;
  }
  if (isAngularProviderTokenReference(node)) {
    return true;
  }
  return false;
}

function isInsideImportOrExportDeclaration(node) {
  let current = node;
  while (current) {
    if (
      ts.isImportDeclaration(current)
      || ts.isImportSpecifier(current)
      || ts.isImportClause(current)
      || ts.isNamespaceImport(current)
      || ts.isNamedImports(current)
      || ts.isExportDeclaration(current)
      || ts.isExportSpecifier(current)
      || ts.isExportAssignment(current)
    ) {
      return true;
    }
    if (ts.isSourceFile(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isInsideTypeOnlyTestReference(node) {
  let current = node;
  while (current) {
    if (
      ts.isTypeReferenceNode(current)
      || ts.isExpressionWithTypeArguments(current)
      || ts.isTypeAliasDeclaration(current)
      || ts.isInterfaceDeclaration(current)
      || ts.isImportTypeNode(current)
    ) {
      return true;
    }
    if (ts.isExpressionStatement(current) || ts.isStatement(current) || ts.isSourceFile(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isAngularProviderTokenReference(node) {
  const parent = node.parent;
  if (
    ts.isPropertyAssignment(parent)
    && parent.initializer === node
    && readPropertyName(parent.name) === 'provide'
  ) {
    return true;
  }
  if (
    ts.isArrayLiteralExpression(parent)
    && parent.elements.includes(node)
    && ts.isPropertyAssignment(parent.parent)
    && readPropertyName(parent.parent.name) === 'providers'
  ) {
    return true;
  }
  return false;
}

function findDecoratorCall(classNode, name) {
  const decorators = ts.canHaveDecorators(classNode) ? ts.getDecorators(classNode) ?? [] : [];
  for (const decorator of decorators) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) continue;
    if (ts.isIdentifier(expression.expression) && expression.expression.text === name) {
      return expression;
    }
  }
  return null;
}

function readConstructorDependencyDetails(source, classNode) {
  const details = [];
  for (const member of classNode.members) {
    if (!ts.isConstructorDeclaration(member)) continue;

    for (const parameter of member.parameters) {
      const injectedToken = findDecoratorCall(parameter, 'Inject')?.arguments?.[0];
      const name = readReferenceName(injectedToken) ?? readTypeName(parameter.type);
      if (!name) continue;
      details.push({
        name,
        injectionKind: 'constructor',
        line: readLine(source, parameter),
        column: readColumn(source, parameter),
        matchedNeedle: parameter.getText(source),
      });
    }
  }
  return uniqueObjects(details);
}

function nodeOptions(symbol) {
  const {
    name,
    className,
    file,
    methods,
    properties,
    members,
    extends: extendsNames,
    implements: implementsNames,
    calls,
    instantiates,
    returns,
    typeReferences,
    typeParameterReferences,
    isConst,
    overloadSignatures,
    overloads,
    configProperties,
    supabaseSelectFields,
    supabaseSelects,
    supabaseIncrementalPredicates,
    supabaseStorageBuckets,
    supabaseFunctionInvokes,
    supabaseRpcCalls,
    supabaseTableWrites,
    supabaseRealtimeChannels,
    supabaseRealtimePostgresChanges,
    supabaseRealtimeLifecycleActions,
    supabaseRealtimeStatuses,
    selectConfig,
    selectConfigProperty,
    table,
    field,
    parentConfigPath,
    hasBody,
    ...options
  } = symbol;
  void name;
  void className;
  void file;
  void methods;
  void properties;
  void members;
  void extendsNames;
  void implementsNames;
  void calls;
  void instantiates;
  void returns;
  void typeReferences;
  void typeParameterReferences;
  void isConst;
  void overloadSignatures;
  void overloads;
  void configProperties;
  void supabaseSelectFields;
  void supabaseSelects;
  void supabaseIncrementalPredicates;
  void supabaseStorageBuckets;
  void supabaseFunctionInvokes;
  void supabaseRpcCalls;
  void supabaseTableWrites;
  void supabaseRealtimeChannels;
  void supabaseRealtimePostgresChanges;
  void supabaseRealtimeLifecycleActions;
  void supabaseRealtimeStatuses;
  void selectConfig;
  void selectConfigProperty;
  void table;
  void field;
  void parentConfigPath;
  void hasBody;
  return stripNullValues({
    ...options,
    returnType: options.returnType ?? returns ?? null,
  });
}

function readNodeLocation(source, node) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    line: start.line + 1,
    startLine: start.line + 1,
    endLine: end.line + 1,
    startColumn: start.character,
    endColumn: end.character,
  };
}

function readDocstring(source, node) {
  if (!source || !node) return null;
  const text = source.text ?? source.getFullText();
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  if (comments.length === 0) return null;

  const docstring = comments
    .map(comment => cleanDocComment(text.slice(comment.pos, comment.end)))
    .filter(Boolean)
    .join('\n')
    .trim();
  return docstring || null;
}

function cleanDocComment(comment) {
  return comment
    .replace(/^\/\*\*?|\*\/$/g, '')
    .replace(/^\/\/\s?/gm, '')
    .replace(/^\s*\*\s?/gm, '')
    .trim();
}

function hasModifier(node, kind) {
  return Boolean(ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind));
}

function readVisibility(node) {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  if (hasModifier(node, ts.SyntaxKind.PublicKeyword)) return 'public';
  return null;
}

function isParameterProperty(parameter) {
  return Boolean(ts.canHaveModifiers(parameter)
    && (ts.getModifiers(parameter) ?? []).some(modifier => [
      ts.SyntaxKind.PublicKeyword,
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword,
      ts.SyntaxKind.ReadonlyKeyword,
    ].includes(modifier.kind)));
}

function readCallableSignature(source, node) {
  const parameters = node.parameters
    ? node.parameters.map(parameter => parameter.getText(source)).join(', ')
    : '';
  const typeParameters = node.typeParameters?.length
    ? `<${node.typeParameters.map(parameter => parameter.getText(source)).join(', ')}>`
    : '';
  const returnType = node.type ? `: ${node.type.getText(source)}` : '';
  return `${typeParameters}(${parameters})${returnType}`;
}

function readVariableSignature(source, statement, declaration, displayName = null) {
  const keyword = statement.declarationList.flags & ts.NodeFlags.Const
    ? 'const'
    : statement.declarationList.flags & ts.NodeFlags.Let
      ? 'let'
      : 'var';
  const type = declaration.type ? `: ${declaration.type.getText(source)}` : '';
  return `${keyword} ${displayName ?? readBindingName(declaration.name) ?? declaration.name.getText(source)}${type}`;
}

function readVariableFunctionSignature(source, name, initializer, declaredType) {
  const callable = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : null;
  if (!callable) return `const ${name}`;
  const typeParameters = callable.typeParameters?.length
    ? `<${callable.typeParameters.map(parameter => parameter.getText(source)).join(', ')}>`
    : '';
  const parameters = callable.parameters
    ? callable.parameters.map(parameter => parameter.getText(source)).join(', ')
    : '';
  const returnType = callable.type
    ? `: ${callable.type.getText(source)}`
    : declaredType
      ? `: ${declaredType.getText(source)}`
      : '';
  return `${name}${typeParameters}(${parameters})${returnType}`;
}

function readCallableReturnTypeName(node, ignoredTypeNames = new Set()) {
  if (!node || !('type' in node)) return null;
  return readTypeName(node.type, ignoredTypeNames);
}

function readPropertySignature(source, member) {
  const name = readMemberName(member) ?? '(property)';
  const optional = member.questionToken ? '?' : '';
  const type = member.type ? `: ${member.type.getText(source)}` : '';
  return `${name}${optional}${type}`;
}

function readIndexSignatureName(source, member) {
  const parameters = member.parameters
    .map(parameter => readParameterSignature(source, parameter))
    .join(', ');
  return `[${parameters}]`;
}

function readParameterSignature(source, parameter) {
  const name = readBindingName(parameter.name) ?? parameter.name.getText(source);
  const type = parameter.type ? `: ${parameter.type.getText(source)}` : '';
  return `${name}${type}`;
}

function readParameterPropertySignature(source, parameter) {
  const name = readBindingName(parameter.name) ?? parameter.name.getText(source);
  const type = parameter.type ? `: ${parameter.type.getText(source)}` : '';
  return `${name}${type}`;
}

function readEnumMemberSignature(source, member) {
  const name = readPropertyName(member.name) ?? member.name.getText(source);
  return member.initializer ? `${name} = ${member.initializer.getText(source)}` : name;
}

function readTypeName(typeNode, ignoredTypeNames = new Set()) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = readReferenceName(typeNode.typeName);
    if (name && !isIgnoredTypeReferenceName(name, ignoredTypeNames)) return name;
    return readTypeReferenceNames(typeNode, ignoredTypeNames)[0] ?? null;
  }
  if (ts.isUnionTypeNode(typeNode)) {
    for (const type of typeNode.types) {
      const name = readTypeName(type, ignoredTypeNames);
      if (name && name !== 'null' && name !== 'undefined') return name;
    }
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return readTypeName(typeNode.type, ignoredTypeNames);
  }
  if (ts.isArrayTypeNode(typeNode)) {
    return readTypeName(typeNode.elementType, ignoredTypeNames);
  }
  if (ts.isTypeOperatorNode(typeNode)) {
    return readTypeName(typeNode.type, ignoredTypeNames);
  }
  return null;
}

function readClassSemantics(source, classNode) {
  const semantics = {
    inputs: [],
    outputs: [],
    models: [],
    queries: [],
    signals: [],
    hostBindings: [],
    hostListeners: [],
  };

  for (const member of classNode.members) {
    const name = readMemberName(member) ?? (ts.isConstructorDeclaration(member) ? 'constructor' : null);

    if (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      readDecoratedIo(source, member, name, semantics);
      readHostBinding(source, member, name, semantics);
    }

    if (ts.isMethodDeclaration(member)) {
      readHostListener(source, member, name, semantics);
    }

    if (ts.isPropertyDeclaration(member) && member.initializer && name) {
      readInitializerSemantics(source, member.initializer, name, semantics);
    }

    if (ts.isConstructorDeclaration(member) && member.body) {
      visit(member.body, node => {
        if (isIdentifierCall(node, 'effect')) {
          semantics.signals.push({
            name: 'constructor',
            api: 'effect',
            line: readLine(source, node),
          });
        }
      });
    }
  }

  return {
    inputs: uniqueObjects(semantics.inputs),
    outputs: uniqueObjects(semantics.outputs),
    models: uniqueObjects(semantics.models),
    queries: uniqueObjects(semantics.queries),
    signals: uniqueObjects(semantics.signals),
    hostBindings: uniqueObjects(semantics.hostBindings),
    hostListeners: uniqueObjects(semantics.hostListeners),
  };
}

function readDecoratedIo(source, member, name, semantics) {
  if (!name) return;
  const input = findDecoratorCall(member, 'Input');
  if (input) {
    semantics.inputs.push({
      name,
      api: '@Input',
      alias: readReferenceName(input.arguments?.[0]),
      line: readLine(source, member),
    });
  }

  const output = findDecoratorCall(member, 'Output');
  if (output) {
    semantics.outputs.push({
      name,
      api: '@Output',
      alias: readReferenceName(output.arguments?.[0]),
      line: readLine(source, member),
    });
  }
}

function readHostBinding(source, member, name, semantics) {
  if (!name) return;
  const decorator = findDecoratorCall(member, 'HostBinding');
  if (!decorator) return;

  semantics.hostBindings.push({
    name,
    api: '@HostBinding',
    binding: readReferenceName(decorator.arguments?.[0]),
    line: readLine(source, member),
  });
}

function readHostListener(source, member, name, semantics) {
  if (!name) return;
  const decorator = findDecoratorCall(member, 'HostListener');
  if (!decorator) return;

  semantics.hostListeners.push({
    name,
    api: '@HostListener',
    event: readReferenceName(decorator.arguments?.[0]),
    line: readLine(source, member),
  });
}

function readInitializerSemantics(source, initializer, name, semantics) {
  const api = readAngularApiCall(initializer);
  if (!api) return;

  const base = {
    name,
    api,
    line: readLine(source, initializer),
  };

  if (api === 'input' || api === 'input.required') {
    semantics.inputs.push(base);
    return;
  }

  if (api === 'output') {
    semantics.outputs.push(base);
    return;
  }

  if (api === 'model') {
    semantics.models.push(base);
    return;
  }

  if (api === 'viewChild' || api === 'viewChildren' || api === 'contentChild' || api === 'contentChildren') {
    semantics.queries.push({
      ...base,
      target: readReferenceName(initializer.arguments?.[0]),
    });
    return;
  }

  if (api === 'signal' || api === 'computed' || api === 'effect') {
    semantics.signals.push(base);
  }
}

function readAngularApiCall(node) {
  if (!ts.isCallExpression(node)) return null;
  const expressionText = node.expression.getText();
  if (expressionText === 'input.required') return 'input.required';
  if ([
    'input',
    'output',
    'model',
    'viewChild',
    'viewChildren',
    'contentChild',
    'contentChildren',
    'signal',
    'computed',
    'effect',
  ].includes(expressionText)) {
    return expressionText;
  }
  return null;
}

function isIdentifierCall(node, name) {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === name;
}

function readMemberName(member) {
  if (!member.name) return null;
  return readPropertyName(member.name);
}

function readClassName(classNode) {
  return classNode?.name ? readPropertyName(classNode.name) : null;
}

function readStringProperty(objectLiteral, name) {
  const initializer = readPropertyInitializer(objectLiteral, name);
  if (!initializer) return null;
  return ts.isStringLiteralLike(initializer) ? initializer.text : null;
}

function readStringPropertyWithStartLine(source, objectLiteral, name) {
  const initializer = readPropertyInitializer(objectLiteral, name);
  if (!initializer || !ts.isStringLiteralLike(initializer)) return null;
  return {
    text: initializer.text,
    startLine: readLine(source, initializer),
  };
}

function readReferenceArrayPropertyDetails(source, objectLiteral, name) {
  const initializer = readPropertyInitializer(objectLiteral, name);
  if (!initializer) return [];

  const entries = ts.isArrayLiteralExpression(initializer)
    ? [...initializer.elements]
    : [initializer];
  return uniqueObjects(entries.flatMap(entry => (
    readProviderOrReferenceNames(entry).map(referenceName => ({
      name: referenceName,
      line: readLine(source, entry),
      column: readColumn(source, entry),
      matchedNeedle: entry.getText(source),
    }))
  )));
}

function readAngularApplicationProviders(projectRoot, file, source) {
  const groups = [];
  visit(source, node => {
    if (ts.isCallExpression(node) && readReferenceName(node.expression) === 'bootstrapApplication') {
      const config = node.arguments?.[1];
      if (!config || !ts.isObjectLiteralExpression(config)) return;
      const providers = readAngularProvidersProperty(source, config);
      if (providers.length === 0) return;
      groups.push({
        file: relative(projectRoot, file),
        bootstrapComponent: readReferenceName(node.arguments?.[0]),
        configName: null,
        line: readLine(source, node),
        providers,
      });
      return;
    }

    if (!isApplicationConfigObjectLiteral(node)) return;
    const providers = readAngularProvidersProperty(source, node);
    if (providers.length === 0) return;
    groups.push({
      file: relative(projectRoot, file),
      bootstrapComponent: null,
      configName: readApplicationConfigOwnerName(node),
      line: readLine(source, node),
      providers,
    });
  });
  return uniqueObjects(groups);
}

function readAngularProvidersProperty(source, objectLiteral) {
  const providers = readPropertyInitializer(objectLiteral, 'providers');
  if (!providers) return [];
  return uniqueObjects(readAngularProviderEntries(source, providers));
}

function readAngularProviderEntries(source, node) {
  if (!node) return [];
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(element => readAngularProviderEntries(source, element));
  }
  if (ts.isSpreadElement(node)) {
    const name = readReferenceName(node.expression);
    const location = readNodeLocation(source, node);
    return name
      ? [stripNullValues({
          name,
          providerKind: 'spread',
          line: location.line,
          column: location.startColumn,
          endLine: location.endLine,
        })]
      : [];
  }
  if (ts.isObjectLiteralExpression(node)) {
    const provide = readReferenceName(readPropertyInitializer(node, 'provide'));
    if (!provide) return [];
    const location = readNodeLocation(source, node);
    return [stripNullValues({
      name: provide,
      providerKind: 'object',
      useClass: readReferenceName(readPropertyInitializer(node, 'useClass')),
      useExisting: readReferenceName(readPropertyInitializer(node, 'useExisting')),
      useFactory: readReferenceName(readPropertyInitializer(node, 'useFactory')),
      deps: readAngularProviderDependencyNames(readPropertyInitializer(node, 'deps')),
      line: location.line,
      column: location.startColumn,
      endLine: location.endLine,
    })];
  }
  if (ts.isCallExpression(node)) {
    const name = readReferenceName(node.expression);
    const location = readNodeLocation(source, node);
    return name
      ? [stripNullValues({
          name,
          providerKind: 'factory-call',
          arguments: unique(node.arguments.flatMap(readAngularProviderArgumentNames)),
          line: location.line,
          column: location.startColumn,
          endLine: location.endLine,
        })]
      : [];
  }
  const direct = readReferenceName(node);
  const location = readNodeLocation(source, node);
  return direct
    ? [stripNullValues({
        name: direct,
        providerKind: 'token',
        line: location.line,
        column: location.startColumn,
        endLine: location.endLine,
      })]
    : [];
}

function readAngularProviderDependencyNames(node) {
  if (!node) return [];
  if (ts.isArrayLiteralExpression(node)) {
    return unique(node.elements.flatMap(readProviderOrReferenceNames));
  }
  return unique(readProviderOrReferenceNames(node));
}

function readAngularProviderArgumentNames(node) {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isCallExpression(node)) return [readReferenceName(node.expression)].filter(Boolean);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(readAngularProviderArgumentNames);
  }
  const direct = readReferenceName(node);
  if (direct) return [direct];
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties
      .map(property => property.name ? readPropertyName(property.name) : null)
      .filter(Boolean);
  }
  return [];
}

function isApplicationConfigObjectLiteral(node) {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const parent = node.parent;
  if (!parent || !ts.isVariableDeclaration(parent) || parent.initializer !== node) return false;
  const typeName = readTypeName(parent.type);
  return typeName === 'ApplicationConfig' || typeName?.endsWith('.ApplicationConfig');
}

function readApplicationConfigOwnerName(objectLiteral) {
  const parent = objectLiteral.parent;
  if (parent && ts.isVariableDeclaration(parent)) {
    return readBindingName(parent.name);
  }
  return null;
}

function readHostDirectivesProperty(source, objectLiteral) {
  const initializer = readPropertyInitializer(objectLiteral, 'hostDirectives');
  if (!initializer) return [];

  const entries = ts.isArrayLiteralExpression(initializer)
    ? initializer.elements
    : [initializer];
  return entries
    .map(entry => readHostDirectiveEntry(source, entry))
    .filter(Boolean);
}

function readHostDirectiveEntry(source, node) {
  if (ts.isSpreadElement(node)) return null;

  if (ts.isObjectLiteralExpression(node)) {
    const directive = readReferenceName(readPropertyInitializer(node, 'directive'));
    if (!directive) return null;
    return {
      directive,
      inputs: readStringArrayProperty(node, 'inputs'),
      outputs: readStringArrayProperty(node, 'outputs'),
      line: readLine(source, node),
    };
  }

  const directive = readReferenceName(node);
  return directive
    ? {
        directive,
        inputs: [],
        outputs: [],
        line: readLine(source, node),
      }
    : null;
}

function readHostMetadataProperty(source, objectLiteral) {
  const initializer = readPropertyInitializer(objectLiteral, 'host');
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    return { attributes: [], bindings: [], listeners: [] };
  }

  const attributes = [];
  const bindings = [];
  const listeners = [];
  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = readPropertyName(property.name);
    const value = ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null;
    if (!key || value === null) continue;

    const event = readHostListenerEvent(key);
    if (event) {
      for (const name of readTemplateExpressionReferences(value)) {
        listeners.push({
          name,
          api: 'host',
          event,
          expression: value,
          line: readLine(source, property),
        });
      }
      continue;
    }

    const binding = readHostBindingKey(key);
    if (binding) {
      for (const name of readTemplateExpressionReferences(value)) {
        bindings.push({
          name,
          api: 'host',
          binding,
          expression: value,
          kind: readHostBindingKind(binding),
          line: readLine(source, property),
        });
      }
      continue;
    }

    attributes.push({
      name: key,
      api: 'host',
      value,
      kind: 'attribute',
      line: readLine(source, property),
    });
  }

  return {
    attributes: uniqueObjects(attributes),
    bindings: uniqueObjects(bindings),
    listeners: uniqueObjects(listeners),
  };
}

function readHostListenerEvent(key) {
  const match = /^\((.+)\)$/.exec(key);
  return match?.[1] ?? null;
}

function readHostBindingKey(key) {
  const match = /^\[([^\]]+)\]$/.exec(key);
  return match?.[1] ?? null;
}

function readHostBindingKind(binding) {
  if (binding.startsWith('attr.')) return 'attribute';
  if (binding.startsWith('class.')) return 'class';
  if (binding.startsWith('style.')) return 'style';
  return 'property';
}

function readStringArrayProperty(objectLiteral, name) {
  const initializer = readPropertyInitializer(objectLiteral, name);
  if (!initializer) return [];

  if (ts.isStringLiteralLike(initializer)) {
    return [initializer.text];
  }

  if (!ts.isArrayLiteralExpression(initializer)) return [];
  return unique(initializer.elements
    .filter(ts.isStringLiteralLike)
    .map(element => element.text));
}

function readProviderOrReferenceNames(node) {
  const direct = readReferenceName(node);
  if (direct) return [direct];

  if (ts.isObjectLiteralExpression(node)) {
    const provide = readPropertyInitializer(node, 'provide');
    const useClass = readPropertyInitializer(node, 'useClass');
    const useExisting = readPropertyInitializer(node, 'useExisting');
    const useValue = readPropertyInitializer(node, 'useValue');
    return [
      readReferenceName(provide),
      readReferenceName(useClass),
      readReferenceName(useExisting),
      readReferenceName(useValue),
    ].filter(Boolean);
  }

  if (ts.isSpreadElement(node)) {
    return readProviderOrReferenceNames(node.expression);
  }

  return [];
}

function readBooleanProperty(objectLiteral, name) {
  const initializer = readPropertyInitializer(objectLiteral, name);
  if (!initializer) return null;
  if (initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function readChangeDetection(objectLiteral) {
  const initializer = readPropertyInitializer(objectLiteral, 'changeDetection');
  if (!initializer) return null;
  const text = initializer.getText();
  if (text.endsWith('.OnPush')) return 'OnPush';
  if (text.endsWith('.Default')) return 'Default';
  return text;
}

function readPathProperty(projectRoot, file, objectLiteral, name) {
  const value = readStringProperty(objectLiteral, name);
  return value ? resolveRelativeFile(projectRoot, file, value) : null;
}

function readPathArrayProperty(projectRoot, file, objectLiteral, name) {
  const initializer = readPropertyInitializer(objectLiteral, name);
  if (!initializer) return [];

  if (ts.isStringLiteralLike(initializer)) {
    return [resolveRelativeFile(projectRoot, file, initializer.text)];
  }

  if (!ts.isArrayLiteralExpression(initializer)) return [];
  return initializer.elements
    .filter(ts.isStringLiteralLike)
    .map(element => resolveRelativeFile(projectRoot, file, element.text));
}

function readPropertyInitializer(objectLiteral, name) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = readPropertyName(property.name);
    if (propertyName === name) {
      return property.initializer;
    }
  }
  return null;
}

function readPropertyName(nameNode) {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

function readRoutes(projectRoot, file, source) {
  const routes = [];

  visit(source, node => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const pathValue = readStringProperty(node, 'path');
    const component = readReferenceName(readPropertyInitializer(node, 'component'));
    const loadComponent = readLoadComponent(projectRoot, file, readPropertyInitializer(node, 'loadComponent'));
    const loadChildren = readLoadComponent(projectRoot, file, readPropertyInitializer(node, 'loadChildren'));
    const redirectTo = readStringProperty(node, 'redirectTo');
    const pathMatch = readStringProperty(node, 'pathMatch');
    const guards = readRouteGuardReferences(source, node);
    const resolvers = readRouteResolverReferences(source, node);
    const providers = readRouteProviderReferences(source, node);

    if (pathValue === null && !component && !loadComponent && !loadChildren && redirectTo === null) return;

    routes.push({
      path: pathValue,
      file: relative(projectRoot, file),
      component,
      loadComponent: loadComponent?.target ?? null,
      loadChildren: loadChildren?.target ?? null,
      redirectTo,
      pathMatch,
      exportName: loadComponent?.exportName ?? loadChildren?.exportName ?? null,
      guards,
      resolvers,
      providers,
      line: readLine(source, node),
    });
  });

  return routes;
}

function readRouteGuardReferences(source, objectLiteral) {
  const guardProperties = [
    'canActivate',
    'canActivateChild',
    'canDeactivate',
    'canMatch',
    'canLoad',
  ];
  return uniqueObjects(guardProperties.flatMap(guardKind => (
    readRouteReferenceList(source, readPropertyInitializer(objectLiteral, guardKind))
      .map(guard => ({ ...guard, guardKind }))
  )));
}

function readRouteResolverReferences(source, objectLiteral) {
  const initializer = readPropertyInitializer(objectLiteral, 'resolve');
  if (!initializer) return [];

  if (ts.isObjectLiteralExpression(initializer)) {
    return uniqueObjects(initializer.properties.flatMap(property => {
      if (!ts.isPropertyAssignment(property)) return [];
      const resolverKey = readPropertyName(property.name);
      return readRouteReferenceList(source, property.initializer)
        .map(resolver => ({ ...resolver, resolverKey }));
    }));
  }

  return readRouteReferenceList(source, initializer)
    .map(resolver => ({ ...resolver, resolverKey: 'default' }));
}

function readRouteProviderReferences(source, objectLiteral) {
  return uniqueObjects(readRouteReferenceList(source, readPropertyInitializer(objectLiteral, 'providers')));
}

function readRouteReferenceList(source, initializer) {
  if (!initializer) return [];
  const entries = ts.isArrayLiteralExpression(initializer)
    ? initializer.elements
    : [initializer];

  return entries.flatMap(entry => {
    if (ts.isSpreadElement(entry)) return readRouteReferenceList(source, entry.expression);
    return readProviderOrReferenceNames(entry).map(name => ({
      name,
      line: readLine(source, entry),
      column: readColumn(source, entry),
    }));
  });
}

function readLoadComponent(projectRoot, file, initializer) {
  if (!initializer) return null;
  let dynamicTarget = null;
  let exportName = null;

  visit(initializer, node => {
    if (!dynamicTarget) {
      const target = readDynamicImport(projectRoot, file, node);
      if (target) {
        dynamicTarget = target;
      }
    }

    if (!exportName && ts.isPropertyAccessExpression(node) && node.expression.getText() === 'm') {
      exportName = node.name.text;
    }
  });

  return dynamicTarget ? { target: dynamicTarget, exportName } : null;
}

function readTemplateBindings(projectRoot, templateUrl, inlineTemplate, inlineTemplateStartLine = null) {
  const template = templateUrl
    ? readTemplateFile(projectRoot, templateUrl)
    : inlineTemplate;
  if (!template) return [];

  const bindings = [];
  const templateFile = templateUrl ?? null;
  const lineOffset = templateFile ? 0 : inlineTemplateLineOffset(inlineTemplateStartLine);
  const localNames = readTemplateLocalNames(template);
  const propertyPattern = /\[([A-Za-z_$][\w$.-]*)\]\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = propertyPattern.exec(template)) !== null) {
    for (const name of readTemplateExpressionReferences(match[2], localNames)) {
      bindings.push({
        kind: 'property',
        binding: match[1],
        name,
        ...templateBindingLocationMetadata(template, match.index, templateFile, name, lineOffset),
      });
    }
  }

  const eventPattern = /\(([A-Za-z_$][\w$.-]*)\)\s*=\s*"([^"]*)"/g;
  while ((match = eventPattern.exec(template)) !== null) {
    for (const name of readTemplateExpressionReferences(match[2], localNames)) {
      bindings.push({
        kind: 'event',
        binding: match[1],
        name,
        ...templateBindingLocationMetadata(template, match.index, templateFile, name, lineOffset),
      });
    }
  }

  const interpolationPattern = /\{\{([\s\S]*?)\}\}/g;
  while ((match = interpolationPattern.exec(template)) !== null) {
    for (const name of readTemplateExpressionReferences(match[1], localNames)) {
      bindings.push({
        kind: 'interpolation',
        name,
        ...templateBindingLocationMetadata(template, match.index, templateFile, name, lineOffset),
      });
    }
  }

  const bananaPattern = /\[\(([A-Za-z_$][\w$.-]*)\)\]\s*=\s*"([^"]*)"/g;
  while ((match = bananaPattern.exec(template)) !== null) {
    for (const name of readTemplateExpressionReferences(match[2], localNames)) {
      bindings.push({
        kind: 'model',
        binding: match[1],
        name,
        ...templateBindingLocationMetadata(template, match.index, templateFile, name, lineOffset),
      });
    }
  }

  for (const expression of readTemplateControlFlowExpressions(template)) {
    const expressionOffset = template.indexOf(expression);
    for (const name of readTemplateExpressionReferences(expression, localNames)) {
      bindings.push({
        kind: 'control-flow',
        name,
        ...templateBindingLocationMetadata(template, expressionOffset, templateFile, name, lineOffset),
      });
    }
  }

  const structuralPattern = /\*([A-Za-z_$][\w$.-]*)\s*=\s*"([^"]*)"/g;
  while ((match = structuralPattern.exec(template)) !== null) {
    for (const name of readTemplateExpressionReferences(readStructuralDirectiveExpressions(match[2]).join('; '), localNames)) {
      bindings.push({
        kind: 'structural',
        binding: match[1],
        name,
        ...templateBindingLocationMetadata(template, match.index, templateFile, name, lineOffset),
      });
    }
  }

  return uniqueObjects(bindings);
}

function readTemplateUsages(projectRoot, templateUrl, inlineTemplate, inlineTemplateStartLine = null) {
  const template = templateUrl
    ? readTemplateFile(projectRoot, templateUrl)
    : inlineTemplate;
  if (!template) return [];
  const templateFile = templateUrl ?? null;
  const lineOffset = templateFile ? 0 : inlineTemplateLineOffset(inlineTemplateStartLine);

  return {
    elements: readTemplateElementNameUsages(template, templateFile, lineOffset),
    attributes: readTemplateAttributeNames(template),
    elementUsages: readTemplateElementUsages(template, templateFile, lineOffset),
    pipes: readTemplatePipeUsages(template, templateFile, lineOffset),
  };
}

function inlineTemplateLineOffset(inlineTemplateStartLine) {
  return Number.isInteger(inlineTemplateStartLine) && inlineTemplateStartLine >= 1
    ? inlineTemplateStartLine - 1
    : 0;
}

function readTemplateElementNameUsages(template, templateFile = null, lineOffset = 0) {
  return uniqueTemplateUsagesByName(readTemplateOpeningTags(template).map(tag => ({
    name: tag.tagName,
    ...templatePositionMetadata(template, tag.index, templateFile, lineOffset),
  })));
}

function readTemplateElementNames(template) {
  const names = [];
  const tagPattern = /<\/?\s*([a-z][\w.-]*)\b/gu;
  let match;
  while ((match = tagPattern.exec(template)) !== null) {
    names.push(match[1]);
  }
  return unique(names);
}

function readTemplateAttributeNames(template) {
  return unique(readTemplateOpeningTags(template)
    .flatMap(tag => readTemplateAttributeEntries(tag.rawAttributes))
    .map(attribute => attribute.name)
    .filter(Boolean));
}

function readTemplateElementUsages(template, templateFile = null, lineOffset = 0) {
  return uniqueObjects(readTemplateOpeningTags(template).map(tag => {
    const attributes = readTemplateAttributeEntries(tag.rawAttributes);
    return {
      tagName: tag.tagName,
      attributes,
      classes: readTemplateClassNames(attributes),
      ...templatePositionMetadata(template, tag.index, templateFile, lineOffset),
    };
  }));
}

function readTemplateOpeningTags(template) {
  const tags = [];
  const tagPattern = /<\s*([a-z][\w.-]*)\b/gu;
  let match;
  while ((match = tagPattern.exec(template)) !== null) {
    const endIndex = findTemplateOpeningTagEnd(template, tagPattern.lastIndex);
    tags.push({
      tagName: match[1],
      rawAttributes: template.slice(tagPattern.lastIndex, endIndex),
      index: match.index,
    });
    tagPattern.lastIndex = endIndex < template.length ? endIndex + 1 : template.length;
  }
  return tags;
}

function findTemplateOpeningTagEnd(template, startIndex) {
  let quote = null;
  let escaped = false;
  for (let index = startIndex; index < template.length; index += 1) {
    const char = template[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') {
      return index;
    }
  }
  return template.length;
}

function readTemplateAttributeEntries(rawAttributes) {
  const attributes = [];
  for (const rawAttribute of readRawTemplateAttributes(rawAttributes)) {
    for (const name of readTemplateAttributeMatchNames(rawAttribute.name)) {
      attributes.push({
        name,
        value: normalizeTemplateAttributeValue(rawAttribute.value, rawAttribute.name),
      });
    }
  }
  return uniqueObjects(attributes);
}

function readRawTemplateAttributes(rawAttributes) {
  const attributes = [];
  let index = 0;
  while (index < rawAttributes.length) {
    while (index < rawAttributes.length && /\s/u.test(rawAttributes[index])) index += 1;
    if (index >= rawAttributes.length) break;
    if (rawAttributes[index] === '/') {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (
      index < rawAttributes.length
      && !/\s|=|\/|>/u.test(rawAttributes[index])
    ) {
      index += 1;
    }
    const name = rawAttributes.slice(nameStart, index).trim();
    if (!name) {
      index += 1;
      continue;
    }

    while (index < rawAttributes.length && /\s/u.test(rawAttributes[index])) index += 1;
    let value = null;
    if (rawAttributes[index] === '=') {
      index += 1;
      while (index < rawAttributes.length && /\s/u.test(rawAttributes[index])) index += 1;
      const quote = rawAttributes[index] === '"' || rawAttributes[index] === "'" ? rawAttributes[index] : null;
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < rawAttributes.length && rawAttributes[index] !== quote) index += 1;
        value = rawAttributes.slice(valueStart, index);
        if (rawAttributes[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < rawAttributes.length && !/\s|>/u.test(rawAttributes[index])) index += 1;
        value = rawAttributes.slice(valueStart, index);
      }
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function readTemplateAttributeMatchNames(rawName) {
  const name = String(rawName ?? '').trim();
  if (!name || name.startsWith('#') || name.startsWith('@') || name.startsWith('ref-') || name.startsWith('let-')) {
    return [];
  }
  if (name.startsWith('*')) {
    return normalizeTemplateAttributeMatchName(name.slice(1));
  }
  const banana = /^\[\((.+)\)\]$/u.exec(name);
  if (banana) {
    return normalizeTemplateAttributeMatchName(banana[1]);
  }
  const property = /^\[(.+)\]$/u.exec(name);
  if (property) {
    return normalizeTemplateAttributeMatchName(property[1]);
  }
  if (/^\(.+\)$/u.test(name) || name.startsWith('on-')) {
    return [];
  }
  if (name.startsWith('bindon-')) {
    return normalizeTemplateAttributeMatchName(name.slice('bindon-'.length));
  }
  if (name.startsWith('bind-')) {
    return normalizeTemplateAttributeMatchName(name.slice('bind-'.length));
  }
  return normalizeTemplateAttributeMatchName(name);
}

function normalizeTemplateAttributeMatchName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.startsWith('class.') || trimmed.startsWith('style.')) return [];
  if (trimmed.startsWith('attr.')) {
    return [trimmed.slice('attr.'.length)].filter(Boolean);
  }
  return [trimmed];
}

function normalizeTemplateAttributeValue(value, rawName) {
  if (value === null || value === undefined) return null;
  if (!isAngularBindingAttributeName(rawName)) return value;
  const trimmed = String(value).trim();
  const literal = /^(["'])([\s\S]*)\1$/u.exec(trimmed);
  return literal ? literal[2] : value;
}

function isAngularBindingAttributeName(rawName) {
  const name = String(rawName ?? '').trim();
  return name.startsWith('[') || name.startsWith('bind-') || name.startsWith('bindon-');
}

function readTemplateClassNames(attributes) {
  const classAttribute = attributes.find(attribute => attribute.name === 'class');
  if (!classAttribute?.value) return [];
  return unique(String(classAttribute.value).split(/\s+/).filter(Boolean));
}

function readTemplatePipeNames(template) {
  const names = [];
  const expressionPatterns = [
    /\{\{([\s\S]*?)\}\}/gu,
    /\[[A-Za-z_$][\w$.-]*\]\s*=\s*"([^"]*)"/gu,
    /\[\([A-Za-z_$][\w$.-]*\)\]\s*=\s*"([^"]*)"/gu,
  ];
  for (const pattern of expressionPatterns) {
    let match;
    while ((match = pattern.exec(template)) !== null) {
      names.push(...readPipeNamesFromExpression(match[1]));
    }
  }
  return unique(names);
}

function readTemplatePipeUsages(template, templateFile = null, lineOffset = 0) {
  const usages = [];
  const expressionPatterns = [
    /\{\{([\s\S]*?)\}\}/gu,
    /\[[A-Za-z_$][\w$.-]*\]\s*=\s*"([^"]*)"/gu,
    /\[\([A-Za-z_$][\w$.-]*\)\]\s*=\s*"([^"]*)"/gu,
  ];
  for (const pattern of expressionPatterns) {
    let match;
    while ((match = pattern.exec(template)) !== null) {
      const expression = match[1];
      for (const pipe of readPipeUsagesFromExpression(expression, template, match.index, templateFile, lineOffset)) {
        usages.push(pipe);
      }
    }
  }
  return uniqueTemplateUsagesByName(usages);
}

function readPipeNamesFromExpression(expression) {
  const names = [];
  const pipePattern = /\|\s*([A-Za-z_$][\w$]*)\b/gu;
  let match;
  while ((match = pipePattern.exec(expression)) !== null) {
    names.push(match[1]);
  }
  return names;
}

function readTemplateFile(projectRoot, templateUrl) {
  const absolute = path.resolve(projectRoot, templateUrl);
  if (!fs.existsSync(absolute)) return null;
  return fs.readFileSync(absolute, 'utf8');
}

function readTemplateControlFlowExpressions(template) {
  const expressions = [];
  const blockPattern = /@(else\s+if|if|switch|case|for|defer)\s*\(/g;
  let match;
  while ((match = blockPattern.exec(template)) !== null) {
    const openParenIndex = match.index + match[0].lastIndexOf('(');
    const expression = readBalancedParenthesizedText(template, openParenIndex);
    if (!expression) continue;
    if (match[1] === 'for') {
      expressions.push(...readForBlockExpressions(expression));
    } else if (match[1] === 'defer') {
      expressions.push(...readDeferBlockExpressions(expression));
    } else {
      expressions.push(readControlFlowPrimaryExpression(expression));
    }
  }

  const letPattern = /@let\s+[A-Za-z_$][\w$]*\s*=\s*([^;]+);/g;
  while ((match = letPattern.exec(template)) !== null) {
    expressions.push(match[1]);
  }

  return expressions;
}

function readBalancedParenthesizedText(text, openParenIndex) {
  if (text[openParenIndex] !== '(') return null;
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openParenIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openParenIndex + 1, index);
      }
    }
  }

  return null;
}

function readForBlockExpressions(expression) {
  const expressions = [];
  const ofMatch = /\b(?:[A-Za-z_$][\w$]*)\s+of\s+([^;]+)/.exec(expression);
  if (ofMatch) expressions.push(ofMatch[1]);
  const trackMatch = /(?:^|;)\s*track\s+([^;]+)/.exec(expression);
  if (trackMatch) expressions.push(trackMatch[1]);
  return expressions;
}

function readDeferBlockExpressions(expression) {
  const expressions = [];
  for (const clause of splitTemplateClauseList(expression)) {
    const trimmed = clause.trim();
    const whenMatch = /^when\s+([\s\S]+)$/.exec(trimmed);
    if (whenMatch) {
      expressions.push(whenMatch[1]);
      continue;
    }
    const prefetchWhenMatch = /^prefetch\s+when\s+([\s\S]+)$/.exec(trimmed);
    if (prefetchWhenMatch) {
      expressions.push(prefetchWhenMatch[1]);
    }
  }
  return expressions;
}

function splitTemplateClauseList(expression) {
  const clauses = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ';' && depth === 0) {
      clauses.push(expression.slice(start, index));
      start = index + 1;
    }
  }

  clauses.push(expression.slice(start));
  return clauses;
}

function readControlFlowPrimaryExpression(expression) {
  return expression.split(';')[0]?.trim() ?? expression;
}

function readStructuralDirectiveExpressions(expression) {
  const expressions = [];
  const ofMatch = /\bof\s+([^;]+)/.exec(expression);
  if (ofMatch) expressions.push(ofMatch[1]);
  const trackByMatch = /\btrackBy\s*:\s*([^;]+)/.exec(expression);
  if (trackByMatch) expressions.push(trackByMatch[1]);
  const ngIfMatch = expression.match(/^\s*([^;]+)/);
  if (ngIfMatch && !/\blet\b|\bof\b|\btrackBy\b/.test(ngIfMatch[1])) {
    expressions.push(stripStructuralAliasExpression(ngIfMatch[1]));
  }
  return expressions;
}

function stripStructuralAliasExpression(expression) {
  return expression.replace(/\s+as\s+[A-Za-z_$][\w$]*\s*$/u, '').trim();
}

function readTemplateLocalNames(template) {
  const locals = new Set([
    '$index',
    '$count',
    '$first',
    '$last',
    '$even',
    '$odd',
  ]);
  const patterns = [
    /@for\s*\(\s*([A-Za-z_$][\w$]*)\s+of\b/g,
    /;\s*as\s+([A-Za-z_$][\w$]*)/g,
    /\*[\w$.-]+\s*=\s*"[^"]*\bas\s+([A-Za-z_$][\w$]*)/g,
    /@let\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\blet\s+([A-Za-z_$][\w$]*)\b/g,
    /[,;]\s*(?:let\s+)?([A-Za-z_$][\w$]*)\s*=\s*\$(?:index|count|first|last|even|odd)\b/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(template)) !== null) {
      locals.add(match[1]);
    }
  }
  return locals;
}

function readTemplateExpressionReferences(expression, localNames = new Set()) {
  const reserved = new Set([
    'true',
    'false',
    'null',
    'undefined',
    'let',
    'as',
    '$event',
    'class',
    'style',
  ]);
  const names = [];
  const propertyNames = new Set();
  const pipeNames = new Set(readPipeNamesFromExpression(expression));
  const propertyPattern = /\.([A-Za-z_$][\w$]*)\b/g;
  let propertyMatch;
  while ((propertyMatch = propertyPattern.exec(expression)) !== null) {
    propertyNames.add(propertyMatch[1]);
  }

  const pattern = /\b([A-Za-z_$][\w$]*)\s*(?=\(|\.|\)|\||\??:|$|\s|,|\]|\})/g;
  let match;
  while ((match = pattern.exec(expression)) !== null) {
    const name = match[1];
    const previousChar = expression[match.index - 1];
    if (
      previousChar !== '$'
      && !reserved.has(name)
      && !localNames.has(name)
      && !propertyNames.has(name)
      && !pipeNames.has(name)
      && !/^[A-Z]/.test(name)
    ) {
      names.push(name);
    }
  }
  return unique(names);
}

function readPipeUsagesFromExpression(expression, template, expressionStartIndex, templateFile = null, lineOffset = 0) {
  const usages = [];
  const pipePattern = /\|\s*([A-Za-z_$][\w$]*)\b/gu;
  let match;
  while ((match = pipePattern.exec(expression)) !== null) {
    usages.push({
      name: match[1],
      ...templatePositionMetadata(template, expressionStartIndex + match.index, templateFile, lineOffset),
    });
  }
  return usages;
}

function templatePositionMetadata(template, offset, templateFile = null, lineOffset = 0) {
  const prefix = template.slice(0, Math.max(0, offset));
  const line = prefix.split(/\r?\n/).length;
  const lastLineBreak = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
  return stripNullValues({
    templateFile,
    line: line + lineOffset,
    column: offset - lastLineBreak,
  });
}

function templateBindingLocationMetadata(template, offset, templateFile, matchedNeedle, lineOffset = 0) {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  return {
    ...templatePositionMetadata(template, safeOffset, templateFile, lineOffset),
    matchedNeedle,
  };
}

function uniqueTemplateUsagesByName(usages) {
  const seen = new Set();
  const result = [];
  for (const usage of usages) {
    if (!usage?.name) continue;
    const key = [
      usage.name,
      usage.templateFile ?? '',
      usage.line ?? '',
      usage.column ?? '',
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(stripNullValues(usage));
  }
  return result;
}

function resolveRelativeFile(projectRoot, sourceFile, relativePath) {
  return relative(projectRoot, path.resolve(path.dirname(sourceFile), relativePath));
}

function resolveImportPath(projectRoot, sourceFile, specifier) {
  if (!specifier.startsWith('.')) return specifier;

  const base = path.resolve(path.dirname(sourceFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.mts'),
    path.join(base, 'index.cts'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ]) {
    if (fs.existsSync(candidate)) {
      return relative(projectRoot, candidate);
    }
  }

  return relative(projectRoot, `${base}.ts`);
}

function findTests(projectRoot, file, specBySubject) {
  return testFilesFromMappings(findTestMappings(projectRoot, file, specBySubject));
}

function findTestMappings(projectRoot, file, specBySubject) {
  const exact = specBySubject.get(file);
  if (exact) {
    return [{
      file: relative(projectRoot, exact),
      testMapping: 'same-basename',
      subject: relative(projectRoot, file),
    }];
  }

  const basename = path.basename(file).replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '');
  const directory = path.dirname(file);
  const localSpecs = [];
  for (const suffix of ['.spec.ts', '.test.ts', '.spec.tsx', '.test.tsx', '.spec.js', '.test.js', '.spec.jsx', '.test.jsx']) {
    const candidate = path.join(directory, `${basename}${suffix}`);
    if (fs.existsSync(candidate)) {
      localSpecs.push({
        file: relative(projectRoot, candidate),
        testMapping: 'same-basename',
        subject: relative(projectRoot, file),
      });
    }
  }
  return uniqueTestMappings(localSpecs);
}

function buildTestSourceIndex(projectRoot, allFiles) {
  return allFiles
    .map(file => ({ absoluteFile: file, relativeFile: relative(projectRoot, file) }))
    .filter(({ absoluteFile, relativeFile }) => (
      isSpecFile(absoluteFile)
      && isProjectSemanticTestSource(relativeFile)
    ))
    .flatMap(({ absoluteFile, relativeFile }) => {
      const source = readSnapshotFileUtf8(absoluteFile);
      return source === null ? [] : [{ file: relativeFile, source }];
    });
}

function isProjectSemanticTestSource(relativeFile) {
  return !isScriptContractTestFile(relativeFile);
}

function isScriptContractTestFile(relativeFile) {
  return /^src\/tests\/scripts\//.test(relativeFile);
}

function findReferencingTestFiles(needles, testSources) {
  return testFilesFromMappings(findReferencingTestFileMappings(needles, testSources));
}

function findReferencingTestFileMappings(needles, testSources) {
  const normalizedNeedles = uniqueObjects((needles ?? [])
    .map(normalizeTestNeedle)
    .filter(needle => needle.value));
  if (normalizedNeedles.length === 0) return [];

  const matches = [];
  const seenGroups = new Set();
  for (const test of testSources) {
    for (const needle of normalizedNeedles) {
      if (!test.source.includes(needle.value)) continue;

      const groupKey = `${test.file}:${needle.exclusiveGroup ?? needle.testMapping ?? needle.value}`;
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      matches.push({
        file: test.file,
        testMapping: needle.testMapping,
        matchedNeedle: needle.matchedNeedle ?? needle.value,
      });
    }
  }

  return uniqueTestMappings(matches);
}

function normalizeTestNeedle(needle) {
  if (!needle) return {};
  if (typeof needle === 'string') {
    return { value: needle, matchedNeedle: needle };
  }
  return {
    value: needle.value,
    testMapping: needle.testMapping,
    matchedNeedle: needle.matchedNeedle ?? needle.value,
    exclusiveGroup: needle.exclusiveGroup,
  };
}

function buildEdgeFunctionTestNeedles(name, entry) {
  return [
    { value: entry, testMapping: 'path-reference', exclusiveGroup: 'path-reference' },
    { value: `supabase/functions/${name}`, testMapping: 'path-reference', exclusiveGroup: 'path-reference' },
    { value: `/functions/v1/${name}`, testMapping: 'route-reference', exclusiveGroup: 'route-reference' },
    { value: `functions/v1/${name}`, testMapping: 'route-reference', exclusiveGroup: 'route-reference' },
    { value: `functions.invoke('${name}'`, testMapping: 'invoke-reference', exclusiveGroup: 'invoke-reference' },
    { value: `functions.invoke("${name}"`, testMapping: 'invoke-reference', exclusiveGroup: 'invoke-reference' },
    { value: `invoke('${name}'`, testMapping: 'invoke-reference', exclusiveGroup: 'invoke-reference' },
    { value: `invoke("${name}"`, testMapping: 'invoke-reference', exclusiveGroup: 'invoke-reference' },
  ];
}

function buildMigrationTestNeedles(name, file) {
  return [
    { value: name, testMapping: 'filename-reference', exclusiveGroup: 'migration-reference' },
    { value: file, testMapping: 'path-reference', exclusiveGroup: 'migration-reference' },
  ];
}

function collectSupabase(projectRoot, allFiles) {
  const edgeFunctions = [];
  const migrations = [];
  const testSources = buildTestSourceIndex(projectRoot, allFiles);
  const supabaseFunctionFiles = new Set(allFiles
    .map(file => relative(projectRoot, file))
    .filter(file => file.startsWith('supabase/functions/')));

  for (const file of allFiles) {
    const rel = relative(projectRoot, file);

    const functionMatch = /^supabase\/functions\/([^/]+)\/index\.(ts|js|mts)$/.exec(rel);
    if (functionMatch) {
      const sourceGraph = collectEdgeFunctionSourceGraph(projectRoot, file, supabaseFunctionFiles);
      const sourceEntries = sourceGraph.sourceFiles.flatMap(sourceFile => {
        const source = readSnapshotFileUtf8(path.resolve(projectRoot, sourceFile));
        return source === null ? [] : [{ file: sourceFile, source }];
      });
      const sources = sourceEntries.map(entry => entry.source);
      const entrySource = readSnapshotFileUtf8(file);
      if (entrySource === null) continue;
      const testMappings = findReferencingTestFileMappings(
        buildEdgeFunctionTestNeedles(functionMatch[1], rel),
        testSources,
      );
      edgeFunctions.push({
        name: functionMatch[1],
        entry: rel,
        sourceFiles: sourceGraph.sourceFiles,
        imports: sourceGraph.imports,
        tests: testFilesFromMappings(testMappings),
        testMappings,
        envVars: unique(sources.flatMap(source => readEdgeFunctionEnvVars(source))),
        routes: readEdgeFunctionRoutes(functionMatch[1], rel, entrySource),
        methods: uniqueObjects(sourceEntries.flatMap(sourceEntry => (
          readEdgeFunctionHttpMethods(sourceEntry.source)
            .map(method => ({ ...method, sourceFile: sourceEntry.file }))
        ))),
        headers: uniqueObjects(sourceEntries.flatMap(sourceEntry => (
          readEdgeFunctionRequestHeaders(sourceEntry.source)
            .map(header => ({ ...header, sourceFile: sourceEntry.file }))
        ))),
        supabaseRpcCalls: uniqueObjects(sourceEntries.flatMap(sourceEntry => (
          readEdgeFunctionSupabaseRpcCalls(sourceEntry.source, sourceEntry.file)
        ))),
        supabaseTableWrites: uniqueObjects(sourceEntries.flatMap(sourceEntry => (
          readEdgeFunctionSupabaseTableWriteCalls(sourceEntry.source, sourceEntry.file)
        ))),
        riskTags: classifyEdgeFunctionRisk(sources.join('\n')),
      });
      continue;
    }

    if (/^supabase\/migrations\/[^/]+\.sql$/.test(rel)) {
      const sql = readSnapshotFileUtf8(file);
      if (sql === null) continue;
      const name = path.basename(file);
      const testMappings = findReferencingTestFileMappings(
        buildMigrationTestNeedles(name, rel),
        testSources,
      );
      migrations.push({
        name,
        file: rel,
        tests: testFilesFromMappings(testMappings),
        testMappings,
        riskTags: classifyMigrationRisk(sql),
        affectedTables: readMigrationTables(sql),
        rlsDetails: readMigrationRlsDetails(sql),
        realtimePublicationDetails: readMigrationPublicationDetails(sql),
        viewDetails: readMigrationViewDetails(sql),
        policies: readMigrationPolicies(sql),
        policyDetails: readMigrationPolicyDetails(sql),
        privilegeDetails: readMigrationPrivilegeDetails(sql),
        functionDetails: readMigrationFunctionDetails(sql),
        triggerDetails: readMigrationTriggerDetails(sql),
        indexDetails: readMigrationIndexDetails(sql),
        constraintDetails: readMigrationConstraintDetails(sql),
        constraintValidationDetails: readMigrationConstraintValidationDetails(sql),
      });
    }
  }

  return { edgeFunctions, migrations };
}

function collectEdgeFunctionSourceGraph(projectRoot, entryFile, supabaseFunctionFiles) {
  const sourceFiles = [];
  const imports = [];
  const visited = new Set();
  const stack = [relative(projectRoot, entryFile)];

  while (stack.length > 0 && visited.size < 100) {
    const rel = stack.pop();
    const file = path.resolve(projectRoot, rel);
    if (visited.has(rel) || !supabaseFunctionFiles.has(rel) || !fs.existsSync(file)) {
      continue;
    }

    visited.add(rel);
    sourceFiles.push(rel);
    const source = readSnapshotFileUtf8(file);
    if (source === null) continue;
    for (const target of readEdgeFunctionImportTargets(projectRoot, file, source)) {
      if (!supabaseFunctionFiles.has(target)) continue;
      imports.push({ source: rel, target });
      if (!visited.has(target)) {
        stack.push(target);
      }
    }
  }

  return {
    sourceFiles: unique(sourceFiles),
    imports: uniqueObjects(imports),
  };
}

function readEdgeFunctionImportTargets(projectRoot, file, source) {
  const targets = [];
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  for (const statement of parsed.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      targets.push(resolveImportPath(projectRoot, file, statement.moduleSpecifier.text));
      continue;
    }

    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const expression = statement.moduleReference.expression;
      if (ts.isStringLiteralLike(expression)) {
        targets.push(resolveImportPath(projectRoot, file, expression.text));
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const specifier = readCommonJsRequireSpecifier(declaration.initializer);
        if (specifier) {
          targets.push(resolveImportPath(projectRoot, file, specifier));
        }
      }
    }
  }

  visit(parsed, node => {
    const target = readDynamicImport(projectRoot, file, node);
    if (target) targets.push(target);
  });

  return unique(targets);
}

function readEdgeFunctionEnvVars(source) {
  const envVars = [];
  const patterns = [
    /\bDeno\.env\.get\(\s*['"`]([A-Z0-9_]+)['"`]\s*\)/g,
    /\bprocess\.env\.([A-Z0-9_]+)\b/g,
    /\bprocess\.env\[['"`]([A-Z0-9_]+)['"`]\]/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      envVars.push(match[1]);
    }
  }

  return unique(envVars);
}

function readEdgeFunctionRoutes(name, entry, source) {
  return [{
    path: `/functions/v1/${name}`,
    invokeName: name,
    entry,
    line: readEdgeFunctionEntrypointLine(source),
  }];
}

function readEdgeFunctionEntrypointLine(source) {
  const patterns = [
    /\bDeno\.serve\s*\(/,
    // std/http 的裸 `serve(...)` 入口（import { serve } ...），排除成员调用形态
    /(?<![.\w$])serve\s*\(/,
    /\bexport\s+default\s+\{[\s\S]*?\bfetch\s*:/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) return lineNumberAt(source, match.index);
  }
  return 1;
}

function readEdgeFunctionHttpMethods(source) {
  const methods = [];
  const equalityPatterns = [
    /\b[A-Za-z_$][\w$]*\.method\s*={2,3}\s*['"`]([A-Z]+)['"`]/g,
    /['"`]([A-Z]+)['"`]\s*={2,3}\s*\b[A-Za-z_$][\w$]*\.method/g,
  ];
  for (const pattern of equalityPatterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      addEdgeFunctionHttpMethod(methods, source, match[1], match.index, 'method-equality');
    }
  }

  const inequalityPatterns = [
    /\b[A-Za-z_$][\w$]*\.method\s*!={1,2}\s*['"`]([A-Z]+)['"`]/g,
    /['"`]([A-Z]+)['"`]\s*!={1,2}\s*\b[A-Za-z_$][\w$]*\.method/g,
  ];
  for (const pattern of inequalityPatterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      addEdgeFunctionHttpMethod(methods, source, match[1], match.index, 'method-inequality-guard');
    }
  }

  if (/\b[A-Za-z_$][\w$]*\.method\b/.test(source)) {
    const casePattern = /\bcase\s+['"`]([A-Z]+)['"`]\s*:/g;
    let match;
    while ((match = casePattern.exec(source)) !== null) {
      addEdgeFunctionHttpMethod(methods, source, match[1], match.index, 'switch-case');
    }
  }

  readEdgeFunctionCorsAllowedMethods(source)
    .forEach(method => addEdgeFunctionHttpMethod(methods, source, method.method, method.offset, 'cors-allowed-methods'));

  return uniqueObjects(methods);
}

function readEdgeFunctionCorsAllowedMethods(source) {
  const parsed = ts.createSourceFile('edge-function.ts', source, ts.ScriptTarget.Latest, true);
  const methods = [];
  visit(parsed, node => {
    if (ts.isCallExpression(node) && isCorsHeadersCallExpression(node.expression)) {
      for (const argument of node.arguments) {
        addEdgeFunctionAllowedMethodString(methods, source, argument);
      }
      return;
    }

    if (!ts.isPropertyAssignment(node)) return;
    const propertyName = readPropertyName(node.name);
    if (propertyName !== 'Access-Control-Allow-Methods') return;
    addEdgeFunctionAllowedMethodString(methods, source, node.initializer);
  });
  return methods;
}

function isCorsHeadersCallExpression(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text === 'getCorsHeaders';
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === 'getCorsHeaders';
  }
  return false;
}

function addEdgeFunctionAllowedMethodString(methods, source, node) {
  if (!node || !ts.isStringLiteralLike(node)) return;
  for (const method of parseHttpMethodsList(node.text)) {
    methods.push({
      method,
      offset: node.getStart(),
    });
  }
}

function parseHttpMethodsList(value) {
  return unique(String(value)
    .split(',')
    .map(part => part.trim().toUpperCase())
    .filter(isHttpMethod));
}

function readEdgeFunctionRequestHeaders(source) {
  const headers = [];
  const pattern = /\b[A-Za-z_$][\w$]*\.headers\.get\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const header = match[1].trim();
    if (!header) continue;
    headers.push({
      header,
      normalizedHeader: header.toLowerCase(),
      line: lineNumberAt(source, match.index),
    });
  }
  return uniqueObjects(headers);
}

function readEdgeFunctionSupabaseRpcCalls(source, sourceFile) {
  const parsed = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
  return readSupabaseRpcCalls(parsed)
    .map(rpcCall => ({ ...rpcCall, sourceFile }));
}

function readEdgeFunctionSupabaseTableWriteCalls(source, sourceFile) {
  const parsed = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
  return readSupabaseTableWriteCalls(parsed)
    .map(tableWrite => ({ ...tableWrite, sourceFile }));
}

function addEdgeFunctionHttpMethod(methods, source, method, offset, methodSource) {
  if (!isHttpMethod(method)) return;
  methods.push({
    method,
    line: lineNumberAt(source, offset),
    methodSource,
  });
}

function isHttpMethod(method) {
  return [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ].includes(method);
}

function classifyEdgeFunctionRisk(source) {
  const lower = source.toLowerCase();
  const tags = [];
  if (/\b(secret|api[_-]?key|service_role|authorization)\b/.test(lower)) {
    tags.push('secret-safety');
  }
  if (/\bsupabase|createclient|from\(/.test(lower)) {
    tags.push('supabase-access');
  }
  if (/\bdeno\.serve|serve\(/.test(lower)) {
    tags.push('edge-entrypoint');
  }
  return unique(tags);
}

function classifyMigrationRisk(sql) {
  const lower = sql.toLowerCase();
  const tags = [];
  if (/\b(drop\s+default|generated\s+by\s+default|identity|serial|uuid_generate|gen_random_uuid)\b/.test(lower)) {
    tags.push('client-id-policy');
  }
  if (/\b(row\s+level\s+security|create\s+policy|alter\s+policy|drop\s+policy|enable\s+row\s+level\s+security)\b/.test(lower)) {
    tags.push('rls-policy');
  }
  if (/\b(updated_at|last_sync|deleted_at|tombstone)\b/.test(lower)) {
    tags.push('sync-lww');
  }
  if (/\bservice_role|secret|private|api[_-]?key\b/.test(lower)) {
    tags.push('secret-safety');
  }
  return tags;
}

function readMigrationTables(sql) {
  const tables = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const tableName = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const objectName = String.raw`${identifier}(?:\s*\.\s*${identifier})?`;
  const policyName = String.raw`(?:"[^"]+"|'[^']+'|[a-zA-Z_][\w-]*)`;
  const patterns = [
    new RegExp(String.raw`\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`(?<!['"])\balter\s+table(?:\s+if\s+exists)?\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\bdrop\s+table(?:\s+if\s+exists)?\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\bcreate\s+policy\s+${policyName}\s+on\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\balter\s+policy\s+${policyName}\s+on\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\bdrop\s+policy(?:\s+if\s+exists)?\s+${policyName}\s+on\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+${objectName}\s+on\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+${identifier}\b[^;]*?\bon\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\bcomment\s+on\s+table\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\binsert\s+into\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\bupdate\s+(?:only\s+)?${tableName}(?:\s+(?:as\s+)?${identifier})?\s+set\b`, 'gi'),
    new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${tableName}`, 'gi'),
    new RegExp(String.raw`\btruncate\b(?!\s+on\b)(?:\s+table)?\s+(?:only\s+)?${tableName}`, 'gi'),
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(sql)) !== null) {
      tables.push(normalizeSqlIdentifier(match[1]));
    }
  }

  return unique(tables);
}

function normalizeSqlIdentifier(identifier) {
  return String(identifier ?? '').replace(/"/g, '').replace(/\s*\.\s*/g, '.');
}

function readMigrationPolicies(sql) {
  const policies = [];
  const pattern = /\bcreate\s+policy\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z_][\w-]*))/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    policies.push(match[1] ?? match[2] ?? match[3]);
  }
  return unique(policies);
}

function readMigrationRlsDetails(sql) {
  const details = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const tablePattern = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const pattern = new RegExp(
    String.raw`^\s*alter\s+table(?:\s+if\s+exists)?\s+(?:only\s+)?${tablePattern}\s+(no\s+force|enable|disable|force)\s+row\s+level\s+security\b`,
    'i',
  );
  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = pattern.exec(statement);
    if (!match) continue;
    details.push({
      table: normalizeSqlIdentifier(match[1]),
      action: normalizeMigrationRlsAction(match[2]),
      line: lineNumberAt(sql, start + match.index),
    });
  }
  return uniqueObjects(details);
}

function normalizeMigrationRlsAction(action) {
  return String(action ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

// `ALTER PUBLICATION <name> ADD|DROP|SET TABLE t1[, t2 ...]`：连接 DB 侧 Realtime
// 发布表与 TS 侧 postgres_changes 订阅的关键语义，按表拆分为独立事实。
function readMigrationPublicationDetails(sql) {
  const details = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const pattern = new RegExp(
    String.raw`^\s*alter\s+publication\s+(${identifier})\s+(add|drop|set)\s+table\s+([\s\S]+)$`,
    'i',
  );
  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = pattern.exec(statement);
    if (!match) continue;
    const publication = normalizeSqlIdentifier(match[1]);
    const action = match[2].toLowerCase();
    const line = lineNumberAt(sql, start + match.index);
    for (const entry of splitSqlCommaList(match[3])) {
      const table = normalizeSqlIdentifier(entry
        .replace(/^\s*only\s+/i, '')
        .replace(/\s+where\s*\([\s\S]*$/i, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim());
      if (!table) continue;
      details.push({ publication, action, table, line });
    }
  }
  return uniqueObjects(details);
}

// statement-level `CREATE [OR REPLACE] [MATERIALIZED] VIEW`：视图参与 RLS 与
// 同步查询路径，缺视图语义会让 migration -> 查询链路断裂。
function readMigrationViewDetails(sql) {
  const details = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const pattern = new RegExp(
    String.raw`^\s*create\s+(or\s+replace\s+)?(materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(${identifier}(?:\s*\.\s*${identifier})?)`,
    'i',
  );
  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = pattern.exec(statement);
    if (!match) continue;
    details.push({
      view: normalizeSqlIdentifier(match[3]),
      materialized: Boolean(match[2]),
      orReplace: Boolean(match[1]),
      line: lineNumberAt(sql, start + match.index),
    });
  }
  return uniqueObjects(details);
}

function readMigrationPolicyDetails(sql) {
  const details = [];
  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = /^\s*create\s+policy\s+("[^"]+"|'[^']+'|[a-zA-Z_][\w-]*)\s+on\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)([\s\S]*)$/i.exec(statement);
    if (!match) continue;
    const tail = match[3] ?? '';
    details.push({
      name: normalizeSqlStringIdentifier(match[1]),
      table: normalizeSqlIdentifier(match[2]),
      command: readPolicyCommand(tail),
      type: readPolicyType(tail),
      roles: readPolicyRoles(tail),
      using: readPolicyExpression(tail, 'using'),
      withCheck: readPolicyExpression(tail, 'with check'),
      line: lineNumberAt(sql, start + match.index),
    });
  }
  return uniqueObjects(details);
}

function readStoragePolicyBuckets(policy) {
  if (normalizeSqlIdentifier(policy?.table).toLowerCase() !== 'storage.objects') return [];
  const expression = [policy.using, policy.withCheck].filter(Boolean).join(' ');
  const buckets = [];
  const patterns = [
    /\bbucket_id\b\s*=\s*'([^']+)'(?:\s*::\s*\w+)?/gi,
    /'([^']+)'(?:\s*::\s*\w+)?\s*=\s*\bbucket_id\b/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(expression)) !== null) {
      buckets.push({
        bucket: match[1],
      });
    }
  }
  return uniqueObjects(buckets);
}

function readMigrationPrivilegeDetails(sql) {
  const details = [];
  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const parsed = readPrivilegeStatement(statement);
    if (!parsed) continue;
    details.push({
      ...parsed,
      line: lineNumberAt(sql, start),
    });
  }
  return uniqueObjects(details);
}

function readPrivilegeStatement(statement) {
  const grantMatch = /^\s*grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)\s*(?:\s+granted\s+by\s+[\s\S]+)?$/i.exec(statement);
  if (grantMatch) {
    const object = readPrivilegeObjectSpec(grantMatch[2]);
    return {
      action: 'grant',
      privileges: readPrivilegeList(grantMatch[1]),
      objectType: object.objectType,
      objectNames: object.objectNames,
      roles: readPrivilegeRoles(grantMatch[3]),
      grantOption: /\bwith\s+grant\s+option\b/i.test(grantMatch[3]),
    };
  }

  const revokeMatch = /^\s*revoke\s+(grant\s+option\s+for\s+)?([\s\S]+?)\s+on\s+([\s\S]+?)\s+from\s+([\s\S]+?)\s*(?:\s+granted\s+by\s+[\s\S]+?(?=\s+(?:cascade|restrict)\s*$|$))?(?:\s+(cascade|restrict))?$/i.exec(statement);
  if (!revokeMatch) return null;

  const object = readPrivilegeObjectSpec(revokeMatch[3]);
  return {
    action: 'revoke',
    privileges: readPrivilegeList(revokeMatch[2]),
    objectType: object.objectType,
    objectNames: object.objectNames,
    roles: readPrivilegeRoles(revokeMatch[4]),
    grantOptionFor: Boolean(revokeMatch[1]),
    revokeBehavior: revokeMatch[5]?.toLowerCase(),
  };
}

function readPrivilegeList(text) {
  const normalized = String(text ?? '').trim();
  if (/^all(?:\s+privileges)?$/i.test(normalized)) return ['all'];
  return unique(normalized
    .split(',')
    .map(privilege => privilege.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean));
}

function readPrivilegeObjectSpec(text) {
  const normalized = String(text ?? '').trim();
  const allInSchemaMatch = /^all\s+(tables|sequences|functions|procedures|routines|schemas|types)\s+in\s+schema\s+([\s\S]+)$/i.exec(normalized);
  if (allInSchemaMatch) {
    return {
      objectType: `${allInSchemaMatch[1].toLowerCase()}-in-schema`,
      objectNames: splitSqlCommaList(allInSchemaMatch[2]).map(normalizeSqlPrivilegeObjectName),
    };
  }

  const typedMatch = /^(table|function|procedure|routine|schema|sequence|type|database)\s+([\s\S]+)$/i.exec(normalized);
  if (typedMatch) {
    return {
      objectType: typedMatch[1].toLowerCase(),
      objectNames: splitSqlCommaList(typedMatch[2]).map(normalizeSqlPrivilegeObjectName),
    };
  }

  return {
    objectType: 'table',
    objectNames: splitSqlCommaList(normalized).map(normalizeSqlPrivilegeObjectName),
  };
}

function readPrivilegeRoles(text) {
  const roleText = String(text ?? '')
    .replace(/\s+with\s+grant\s+option\b[\s\S]*$/i, '')
    .replace(/\s+granted\s+by\b[\s\S]*$/i, '')
    .replace(/\s+(?:cascade|restrict)\b[\s\S]*$/i, '');
  return unique(splitSqlCommaList(roleText)
    .map(role => role.replace(/^\s*(?:group|user)\s+/i, ''))
    .map(normalizeSqlStringIdentifier)
    .filter(Boolean));
}

function splitSqlCommaList(text) {
  const items = [];
  let current = '';
  let depth = 0;
  let quote = null;
  const value = String(text ?? '');

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      const item = current.trim();
      if (item) items.push(item);
      current = '';
      continue;
    }

    current += char;
  }

  const item = current.trim();
  if (item) items.push(item);
  return items;
}

function normalizeSqlPrivilegeObjectName(name) {
  return String(name ?? '')
    .trim()
    .replace(/"([^"]+)"/g, '$1')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s+/g, ' ');
}

function readMigrationFunctionDetails(sql) {
  const details = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const functionName = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const pattern = new RegExp(String.raw`^\s*create\s+(?:or\s+replace\s+)?function\s+${functionName}\s*\(`, 'i');

  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = pattern.exec(statement);
    if (!match) continue;

    const argsOpenIndex = match.index + match[0].length - 1;
    const argsText = readBalancedParenthesizedText(statement, argsOpenIndex);
    if (argsText === null) continue;

    const argsCloseIndex = argsOpenIndex + argsText.length + 1;
    const afterArgs = statement.slice(argsCloseIndex + 1);
    const bodyMatch = /\bas\s+(?:\$[A-Za-z_][\w$]*\$|\$\$|'|")/i.exec(afterArgs);
    const header = bodyMatch ? afterArgs.slice(0, bodyMatch.index) : afterArgs.split(';', 1)[0] ?? '';

    details.push({
      name: normalizeSqlIdentifier(match[1]),
      returnType: readFunctionReturnType(header),
      language: readFunctionLanguage(header),
      security: readFunctionSecurity(header),
      line: lineNumberAt(sql, start + match.index),
    });
  }

  return uniqueObjects(details);
}

function readMigrationTriggerDetails(sql) {
  const details = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const triggerName = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$-]*)`;
  const tableName = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const functionName = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const pattern = new RegExp(
    String.raw`^\s*create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(${triggerName})\s+` +
      String.raw`(before|after|instead\s+of)\s+([\s\S]*?)\s+on\s+(?:only\s+)?${tableName}[\s\S]*?` +
      String.raw`\bexecute\s+(?:function|procedure)\s+${functionName}\s*\(`,
    'i',
  );

  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = pattern.exec(statement);
    if (!match) continue;
    details.push({
      name: normalizeSqlStringIdentifier(match[1]),
      timing: match[2].toLowerCase().replace(/\s+/g, ' '),
      events: readTriggerEvents(match[3]),
      table: normalizeSqlIdentifier(match[4]),
      functionName: normalizeSqlIdentifier(match[5]),
      line: lineNumberAt(sql, start + match.index),
    });
  }

  return uniqueObjects(details);
}

function readMigrationIndexDetails(sql) {
  const details = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const indexName = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const tableName = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const pattern = new RegExp(
    String.raw`^\s*create\s+(unique\s+)?index\s+(concurrently\s+)?(?:if\s+not\s+exists\s+)?${indexName}\s+` +
      String.raw`on\s+(?:only\s+)?${tableName}(?:\s+using\s+([a-zA-Z_][\w$]*))?\s*\(`,
    'i',
  );

  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = pattern.exec(statement);
    if (!match) continue;
    const openParenIndex = match.index + match[0].lastIndexOf('(');
    const columnsText = readBalancedParenthesizedText(statement, openParenIndex);
    if (columnsText === null) continue;

    const closeParenIndex = openParenIndex + columnsText.length + 1;
    details.push({
      name: normalizeSqlIdentifier(match[3]),
      table: normalizeSqlIdentifier(match[4]),
      columns: readIndexColumns(columnsText),
      method: match[5]?.toLowerCase() ?? null,
      unique: Boolean(match[1]),
      concurrently: Boolean(match[2]),
      predicate: readIndexPredicate(statement.slice(closeParenIndex + 1)),
      line: lineNumberAt(sql, start + match.index),
    });
  }

  return uniqueObjects(details);
}

function readMigrationConstraintDetails(sql) {
  const details = [];
  const patterns = createMigrationConstraintPatterns();

  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    details.push(...readMigrationCreateTableConstraintDetails(sql, statement, start, patterns));
    const detail =
      readMigrationCheckConstraintDetail(sql, statement, start, patterns) ??
      readMigrationForeignKeyConstraintDetail(sql, statement, start, patterns) ??
      readMigrationUniqueOrPrimaryConstraintDetail(sql, statement, start, patterns) ??
      readMigrationExcludeConstraintDetail(sql, statement, start, patterns);
    if (detail) details.push(detail);
  }

  return uniqueObjects(details);
}

function createMigrationConstraintPatterns() {
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const qualifiedIdentifier = String.raw`${identifier}(?:\s*\.\s*${identifier})?`;
  const tableName = String.raw`(${qualifiedIdentifier})`;
  const constraintName = String.raw`(${identifier})`;
  const alterTablePrefix = String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${tableName}\s+`;
  return {
    check: new RegExp(
      alterTablePrefix + String.raw`add\s+constraint\s+${constraintName}\s+check\s*\(`,
      'i',
    ),
    foreignKey: new RegExp(
      alterTablePrefix + String.raw`add\s+constraint\s+${constraintName}\s+foreign\s+key\s*\(`,
      'i',
    ),
    uniqueOrPrimary: new RegExp(
      alterTablePrefix + String.raw`add\s+constraint\s+${constraintName}\s+(unique|primary\s+key)\b`,
      'i',
    ),
    exclude: new RegExp(
      alterTablePrefix + String.raw`add\s+constraint\s+${constraintName}\s+exclude\b`,
      'i',
    ),
    createTable: new RegExp(
      String.raw`^\s*create\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${tableName}\s*\(`,
      'i',
    ),
    identifier: new RegExp(String.raw`^\s*(${identifier})\b`, 'i'),
    references: new RegExp(String.raw`^\s*references\s+(${qualifiedIdentifier})(?=\s|\(|$)`, 'i'),
  };
}

function readMigrationCreateTableConstraintDetails(sql, statement, start, patterns) {
  const match = patterns.createTable.exec(statement);
  if (!match) return [];
  const openParenIndex = match.index + match[0].lastIndexOf('(');
  const tableBody = readBalancedParenthesizedText(statement, openParenIndex);
  if (tableBody === null) return [];
  const table = normalizeSqlIdentifier(match[1]);
  return splitSqlCommaList(tableBody).flatMap(element => {
    const constraintMatch = /^\s*constraint\s+((?:"[^"]+"|[a-zA-Z_][\w$]*))\s+([\s\S]+)$/i.exec(element);
    if (!constraintMatch) return [];
    const constraintOffset = statement.indexOf(element, openParenIndex + 1);
    const line = lineNumberAt(sql, start + Math.max(0, constraintOffset));
    const syntheticStatement = `alter table ${table} add constraint ${constraintMatch[1]} ${constraintMatch[2]}`;
    const detail =
      readMigrationCheckConstraintDetail(syntheticStatement, syntheticStatement, 0, patterns) ??
      readMigrationForeignKeyConstraintDetail(syntheticStatement, syntheticStatement, 0, patterns) ??
      readMigrationUniqueOrPrimaryConstraintDetail(syntheticStatement, syntheticStatement, 0, patterns) ??
      readMigrationExcludeConstraintDetail(syntheticStatement, syntheticStatement, 0, patterns);
    return detail ? [{ ...detail, constraintSource: 'create-table', line }] : [];
  });
}

function readMigrationCheckConstraintDetail(sql, statement, start, patterns) {
  const match = patterns.check.exec(statement);
  if (!match) return null;
  const openParenIndex = match.index + match[0].lastIndexOf('(');
  const expression = readBalancedParenthesizedText(statement, openParenIndex);
  if (expression === null) return null;
  const closeParenIndex = openParenIndex + expression.length + 1;

  return {
    name: normalizeSqlIdentifier(match[2]),
    table: normalizeSqlIdentifier(match[1]),
    constraintType: 'check',
    constraintSource: 'alter-table',
    expression: expression.trim().replace(/\s+/g, ' '),
    notValid: /\bnot\s+valid\b/i.test(statement.slice(closeParenIndex + 1)),
    line: lineNumberAt(sql, start + match.index),
  };
}

function readMigrationForeignKeyConstraintDetail(sql, statement, start, patterns) {
  const match = patterns.foreignKey.exec(statement);
  if (!match) return null;
  const columnsStart = match.index + match[0].lastIndexOf('(');
  const columnsText = readBalancedParenthesizedText(statement, columnsStart);
  if (columnsText === null) return null;
  const columnsEnd = columnsStart + columnsText.length + 1;
  const references = readForeignKeyReference(statement, columnsEnd, patterns);
  if (!references) return null;
  const tail = statement.slice(references.end + 1);

  return {
    name: normalizeSqlIdentifier(match[2]),
    table: normalizeSqlIdentifier(match[1]),
    constraintType: 'foreign-key',
    constraintSource: 'alter-table',
    columns: readSqlIdentifierList(columnsText),
    referencedTable: references.table,
    referencedColumns: references.columns,
    matchType: readForeignKeyMatchType(tail),
    onDelete: readForeignKeyAction(tail, 'delete'),
    onDeleteColumns: readForeignKeyActionColumns(tail, 'delete'),
    onUpdate: readForeignKeyAction(tail, 'update'),
    onUpdateColumns: readForeignKeyActionColumns(tail, 'update'),
    deferrable: readForeignKeyDeferrability(tail),
    initially: readForeignKeyInitially(tail),
    notValid: /\bnot\s+valid\b/i.test(tail),
    line: lineNumberAt(sql, start + match.index),
  };
}

function readMigrationUniqueOrPrimaryConstraintDetail(sql, statement, start, patterns) {
  const match = patterns.uniqueOrPrimary.exec(statement);
  if (!match) return null;
  const constraintType = match[3].replace(/\s+/g, '-').toLowerCase();
  const tail = statement.slice(match.index + match[0].length);
  const usingIndex = readConstraintUsingIndex(tail, patterns);
  if (usingIndex) {
    return {
      name: normalizeSqlIdentifier(match[2]),
      table: normalizeSqlIdentifier(match[1]),
      constraintType,
      constraintSource: 'alter-table',
      usingIndex: usingIndex.name,
      deferrable: readForeignKeyDeferrability(usingIndex.tail),
      initially: readForeignKeyInitially(usingIndex.tail),
      notValid: /\bnot\s+valid\b/i.test(usingIndex.tail),
      line: lineNumberAt(sql, start + match.index),
    };
  }

  const columnsStart = tail.indexOf('(');
  if (columnsStart < 0) return null;
  const columnsText = readBalancedParenthesizedText(tail, columnsStart);
  if (columnsText === null) return null;
  const afterColumns = tail.slice(columnsStart + columnsText.length + 2);

  return {
    name: normalizeSqlIdentifier(match[2]),
    table: normalizeSqlIdentifier(match[1]),
    constraintType,
    constraintSource: 'alter-table',
    columns: readSqlConstraintColumnList(columnsText),
    nullsDistinct: constraintType === 'unique' ? readUniqueNullsDistinct(tail.slice(0, columnsStart)) : undefined,
    deferrable: readForeignKeyDeferrability(afterColumns),
    initially: readForeignKeyInitially(afterColumns),
    notValid: /\bnot\s+valid\b/i.test(afterColumns),
    line: lineNumberAt(sql, start + match.index),
  };
}

function readMigrationExcludeConstraintDetail(sql, statement, start, patterns) {
  const match = patterns.exclude.exec(statement);
  if (!match) return null;
  const tail = statement.slice(match.index + match[0].length);
  const methodMatch = /^\s+using\s+([a-zA-Z_][\w$]*)\b/i.exec(tail);
  const afterMethod = methodMatch ? tail.slice(methodMatch.index + methodMatch[0].length) : tail;
  const elementsStart = afterMethod.indexOf('(');
  if (elementsStart < 0) return null;
  const elementsText = readBalancedParenthesizedText(afterMethod, elementsStart);
  if (elementsText === null) return null;
  const afterElements = afterMethod.slice(elementsStart + elementsText.length + 2);

  return {
    name: normalizeSqlIdentifier(match[2]),
    table: normalizeSqlIdentifier(match[1]),
    constraintType: 'exclude',
    constraintSource: 'alter-table',
    indexMethod: methodMatch ? methodMatch[1].toLowerCase() : undefined,
    excludeElements: readExcludeElements(elementsText),
    predicate: readConstraintPredicate(afterElements),
    deferrable: readForeignKeyDeferrability(afterElements),
    initially: readForeignKeyInitially(afterElements),
    notValid: /\bnot\s+valid\b/i.test(afterElements),
    line: lineNumberAt(sql, start + match.index),
  };
}

function readForeignKeyReference(statement, columnsEnd, patterns) {
  const tail = statement.slice(columnsEnd + 1);
  const match = patterns.references.exec(tail);
  if (!match) return null;
  const afterReferenceStart = columnsEnd + 1 + match.index + match[0].length;
  const afterReference = statement.slice(afterReferenceStart);
  const nextTokenIndex = afterReference.search(/\S/);
  if (nextTokenIndex < 0 || afterReference[nextTokenIndex] !== '(') {
    return {
      table: normalizeSqlIdentifier(match[1]),
      columns: [],
      end: afterReferenceStart - 1,
    };
  }
  const columnsStart = afterReferenceStart + nextTokenIndex;
  const columnsText = readBalancedParenthesizedText(statement, columnsStart);
  if (columnsText === null) return null;
  return {
    table: normalizeSqlIdentifier(match[1]),
    columns: readSqlIdentifierList(columnsText),
    end: columnsStart + columnsText.length + 1,
  };
}

function readSqlIdentifierList(text) {
  return splitSqlCommaList(text)
    .map(normalizeSqlIdentifier)
    .filter(Boolean);
}

function readSqlConstraintColumnList(text) {
  return splitSqlCommaList(text)
    .map(column => normalizeSqlIdentifier(
      column
        .replace(/\s+without\s+overlaps\s*$/i, '')
        .replace(/^\s*period\s+/i, '')
        .trim(),
    ))
    .filter(Boolean);
}

function readConstraintUsingIndex(tail, patterns) {
  const usingIndexMatch = /^\s+using\s+index\b/i.exec(String(tail ?? ''));
  if (!usingIndexMatch) return null;
  const afterUsingIndex = String(tail ?? '').slice(usingIndexMatch.index + usingIndexMatch[0].length);
  const nameMatch = patterns.identifier.exec(afterUsingIndex);
  if (!nameMatch) return null;
  return {
    name: normalizeSqlIdentifier(nameMatch[1]),
    tail: afterUsingIndex.slice(nameMatch.index + nameMatch[0].length),
  };
}

function readUniqueNullsDistinct(prefix) {
  const value = String(prefix ?? '');
  if (/\bnulls\s+not\s+distinct\b/i.test(value)) return false;
  if (/\bnulls\s+distinct\b/i.test(value)) return true;
  return undefined;
}

function readExcludeElements(text) {
  return splitSqlCommaList(text)
    .map(element => element.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function readConstraintPredicate(tail) {
  const match = /\bwhere\s*\(/i.exec(String(tail ?? ''));
  if (!match) return undefined;
  const openParenIndex = match.index + match[0].lastIndexOf('(');
  const predicate = readBalancedParenthesizedText(String(tail ?? ''), openParenIndex);
  return predicate === null ? undefined : predicate.trim().replace(/\s+/g, ' ');
}

function readForeignKeyAction(tail, action) {
  const pattern = new RegExp(String.raw`\bon\s+${action}\s+(no\s+action|restrict|cascade|set\s+null|set\s+default)\b`, 'i');
  const match = pattern.exec(String(tail ?? ''));
  return match ? match[1].toLowerCase().replace(/\s+/g, '-') : undefined;
}

function readForeignKeyActionColumns(tail, action) {
  const value = String(tail ?? '');
  const pattern = new RegExp(String.raw`\bon\s+${action}\s+(?:set\s+null|set\s+default)\b`, 'i');
  const match = pattern.exec(value);
  if (!match) return undefined;
  const afterActionStart = match.index + match[0].length;
  const afterAction = value.slice(afterActionStart);
  const nextTokenIndex = afterAction.search(/\S/);
  if (nextTokenIndex < 0 || afterAction[nextTokenIndex] !== '(') return undefined;
  const openParenIndex = afterActionStart + nextTokenIndex;
  const columnsText = readBalancedParenthesizedText(value, openParenIndex);
  return columnsText === null ? undefined : readSqlIdentifierList(columnsText);
}

function readForeignKeyMatchType(tail) {
  const match = /\bmatch\s+(full|partial|simple)\b/i.exec(String(tail ?? ''));
  return match ? match[1].toLowerCase() : undefined;
}

function readForeignKeyDeferrability(tail) {
  const value = String(tail ?? '');
  if (/\bnot\s+deferrable\b/i.test(value)) return false;
  if (/\bdeferrable\b/i.test(value)) return true;
  return undefined;
}

function readForeignKeyInitially(tail) {
  const match = /\binitially\s+(deferred|immediate)\b/i.exec(String(tail ?? ''));
  return match ? match[1].toLowerCase() : undefined;
}

function readMigrationConstraintValidationDetails(sql) {
  const details = [];
  const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
  const tableName = String.raw`(${identifier}(?:\s*\.\s*${identifier})?)`;
  const constraintName = String.raw`(${identifier})`;
  const pattern = new RegExp(
    String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${tableName}\s+` +
      String.raw`validate\s+constraint\s+${constraintName}` +
      String.raw`(?=\s|$)`,
    'i',
  );

  for (const { text: statement, start } of splitSqlStatementRanges(sql)) {
    const match = pattern.exec(statement);
    if (!match) continue;
    details.push({
      name: normalizeSqlIdentifier(match[2]),
      table: normalizeSqlIdentifier(match[1]),
      line: lineNumberAt(sql, start + match.index),
    });
  }

  return uniqueObjects(details);
}

function readIndexColumns(columnsText) {
  return splitSqlCommaList(columnsText)
    .map(column => column.trim())
    .map(column => column.replace(/\s+(?:asc|desc)\b[\s\S]*$/i, ''))
    .map(column => column.replace(/\s+nulls\s+(?:first|last)\b[\s\S]*$/i, ''))
    .map(normalizeSqlIndexColumn)
    .filter(Boolean);
}

function normalizeSqlIndexColumn(column) {
  const normalized = String(column ?? '').trim();
  const simpleIdentifier = /^"([^"]+)"$|^([a-zA-Z_][\w$]*)$/.exec(normalized);
  if (simpleIdentifier) return simpleIdentifier[1] ?? simpleIdentifier[2];
  return normalized.replace(/\s+/g, ' ');
}

function readIndexPredicate(tail) {
  const match = /\bwhere\s+([\s\S]+)$/i.exec(String(tail ?? '').trim());
  return match ? match[1].trim() : null;
}

function readFunctionReturnType(header) {
  const match = /\breturns\s+([\s\S]*?)(?=\blanguage\b|\bsecurity\b|\bcost\b|\brows\b|\bset\b|\bstable\b|\bimmutable\b|\bvolatile\b|\bstrict\b|\bparallel\b|$)/i.exec(header);
  return match ? normalizeSqlType(match[1]) : null;
}

function readFunctionLanguage(header) {
  const match = /\blanguage\s+([a-zA-Z_][\w$]*)/i.exec(header);
  return match ? match[1].toLowerCase() : null;
}

function readFunctionSecurity(header) {
  const match = /\bsecurity\s+(definer|invoker)\b/i.exec(header);
  return match ? match[1].toLowerCase() : null;
}

function normalizeSqlType(typeText) {
  return String(typeText ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^"([^"]+)"$/, '$1');
}

function readTriggerEvents(eventClause) {
  return unique(String(eventClause ?? '')
    .split(/\bor\b/i)
    .map(event => event.trim().toLowerCase())
    .filter(event => /^(insert|update|delete|truncate)$/.test(event)));
}

function splitSqlStatements(sql) {
  return splitSqlStatementRanges(sql).map(statement => statement.text);
}

function splitSqlStatementRanges(sql) {
  const statements = [];
  let start = 0;
  let quote = null;
  let dollarQuote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }
    if (quote) {
      if (char === quote && sql[index + 1] === quote) {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    const dollarQuoteMatch = /^\$[A-Za-z_][\w$]*\$|^\$\$/.exec(sql.slice(index));
    if (dollarQuoteMatch) {
      dollarQuote = dollarQuoteMatch[0];
      index += dollarQuote.length - 1;
      continue;
    }
    if (char !== ';') continue;
    pushSqlStatementRange(statements, sql, start, index);
    start = index + 1;
  }
  pushSqlStatementRange(statements, sql, start, sql.length);
  return statements;
}

function pushSqlStatementRange(statements, sql, start, end) {
  const raw = sql.slice(start, end);
  const leadingWhitespace = /^\s*/.exec(raw)?.[0].length ?? 0;
  const trailingWhitespace = /\s*$/.exec(raw)?.[0].length ?? 0;
  const text = raw.slice(leadingWhitespace, raw.length - trailingWhitespace);
  if (!text) return;
  statements.push({
    text,
    start: start + leadingWhitespace,
  });
}

function lineNumberAt(source, offset) {
  let line = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let index = 0; index < end; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

function normalizeSqlStringIdentifier(identifier) {
  const value = String(identifier ?? '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1).replace(/""/g, '"').replace(/''/g, '\'');
  }
  return value;
}

function readPolicyCommand(policyTail) {
  const match = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(policyTail);
  return match ? match[1].toLowerCase() : 'all';
}

function readPolicyType(policyTail) {
  const match = /\bas\s+(permissive|restrictive)\b/i.exec(policyTail);
  return match ? match[1].toLowerCase() : 'permissive';
}

function readPolicyRoles(policyTail) {
  const match = /\bto\s+([\s\S]*?)(?=\busing\s*\(|\bwith\s+check\s*\(|$)/i.exec(policyTail);
  if (!match) return ['public'];
  return unique(match[1]
    .split(',')
    .map(role => normalizeSqlStringIdentifier(role.trim()))
    .map(role => role.replace(/\s+/g, ' '))
    .filter(Boolean));
}

function readPolicyExpression(policyTail, clause) {
  const pattern = clause === 'with check' ? /\bwith\s+check\s*\(/i : /\busing\s*\(/i;
  const match = pattern.exec(policyTail);
  if (!match) return null;
  const openParenIndex = match.index + match[0].lastIndexOf('(');
  return readBalancedParenthesizedText(policyTail, openParenIndex)?.trim() ?? null;
}

function collectAgentRules(projectRoot) {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return { syncRules: [], hardRules: [] };
  }

  const hardRules = [];
  const lines = fs.readFileSync(agentsPath, 'utf8').split(/\r?\n/);
  let insideHardRules = false;
  let currentRule = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (!heading) {
      if (currentRule) {
        const bodyLine = line.trim();
        if (bodyLine) currentRule.bodyLines.push(bodyLine);
      }
      continue;
    }

    const level = heading[1].length;
    const title = heading[2].trim();
    if (level === 2) {
      currentRule = null;
      insideHardRules = /hard rules/i.test(title) || /^5\./.test(title);
      continue;
    }

    if (insideHardRules && level === 3) {
      currentRule = {
        heading: title,
        file: 'AGENTS.md',
        line: index + 1,
        bodyLines: [],
      };
      hardRules.push(currentRule);
      continue;
    }

    if (currentRule) {
      currentRule.bodyLines.push(title);
    }
  }

  const hardRuleSyncRules = collectSyncRulesFromHardRules(hardRules);
  const configSyncRules = collectSyncRulesFromConfigTables(lines);

  return {
    syncRules: uniqueObjects([...hardRuleSyncRules, ...configSyncRules]),
    hardRules: hardRules.map(({ bodyLines, ...rule }) => {
      const body = bodyLines.join('\n');
      return {
        ...rule,
        body,
        keywords: readHardRuleKeywords(`${rule.heading}\n${body}`),
      };
    }),
  };
}

function collectSyncRulesFromHardRules(hardRules) {
  const syncRules = [];
  for (const hardRule of hardRules) {
    for (let offset = 0; offset < hardRule.bodyLines.length; offset += 1) {
      const line = hardRule.bodyLines[offset];
      const syncRule = readSyncRuleLine(line, hardRule, offset);
      if (syncRule) syncRules.push(syncRule);
    }
  }
  return syncRules;
}

function collectSyncRulesFromConfigTables(lines) {
  const syncRules = [];
  let ownerHeading = 'AGENTS.md';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      ownerHeading = heading[2].trim();
      continue;
    }

    const row = readMarkdownTableRow(line);
    if (!row || row.length < 2) continue;
    const [name, body] = row;
    if (!readAgentsConfigKeyParts(name)) continue;

    const keywords = readSyncRuleKeywords(`${name} ${body}`);
    if (keywords.length === 0) continue;
    syncRules.push({
      name,
      file: 'AGENTS.md',
      line: index + 1,
      ownerHeading,
      body,
      keywords,
    });
  }

  return syncRules;
}

function readSyncRuleLine(line, hardRule, offset) {
  const match = /^\s*[-*]\s*([^:：-]+?)\s*(?::|：|->|-)\s*(.+?)\s*$/.exec(line);
  if (!match) return null;

  const name = match[1].trim();
  const body = match[2].trim();
  const keywords = readSyncRuleKeywords(`${name} ${body}`);
  if (keywords.length === 0) return null;

  return {
    name,
    file: hardRule.file,
    line: hardRule.line + offset + 1,
    ownerHeading: hardRule.heading,
    body,
    keywords,
  };
}

function readMarkdownTableRow(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed
    .slice(1, -1)
    .split('|')
    .map(stripMarkdownInline)
    .filter(cell => cell.length > 0);
  if (cells.length === 0 || cells.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return cells;
}

function readHardRuleKeywords(text) {
  const checks = [
    ['crypto.randomUUID()', /crypto\.randomUUID\s*\(\s*\)/i],
    ['database autoincrement ID', /\bdatabase\s+autoincrement\s+ids?\b|数据库自增\s*ID/i],
    ['temporary ID', /\btemporary\s+ids?\b|临时\s*ID/i],
    ['ID mapping', /\bid\s+mapping\b|ID\s*映射/i],
    ['IndexedDB', /\bIndexedDB\b/i],
    ['RetryQueue', /\bRetryQueue\b/i],
    ['LWW', /\bLWW\b|Last-Write-Wins/i],
    ['Exportable', /\bExportable\b/i],
    ['Restorable', /\bRestorable\b/i],
    ['Replayable', /\bReplayable\b/i],
    ['Explainable', /\bExplainable\b/i],
    ['content', /\bcontent\b|不可漏字段|必须包含\s*content|must\s+include\s+content/i],
    ['@defer', /@defer\b/i],
    ['visibility:hidden', /visibility\s*:\s*hidden/i],
    ['FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH', /\bFLOATING_TREE_CONFIG\.MAX_SUBTREE_DEPTH\b/i],
    ['StoreService', /\bStoreService\b/i],
    ['facade Store', /\bfacade\s+Store\b|门面\s*Store/i],
    ['NgRx', /\bNgRx\b/i],
    ['RxJS Store', /\bRxJS\s+Store\b/i],
  ];
  return unique(checks
    .filter(([, pattern]) => pattern.test(text))
    .map(([keyword]) => keyword));
}

function stripMarkdownInline(value) {
  const trimmed = String(value ?? '').trim();
  const singleCodeSpan = /^`([^`]+)`$/.exec(trimmed);
  return (singleCodeSpan?.[1] ?? trimmed).trim();
}

function readSyncRuleKeywords(text) {
  const keywords = [];
  for (const match of String(text ?? '').matchAll(/\b[A-Z0-9_]+_CONFIG\.[A-Z0-9_]+(?:\.[A-Z0-9_]+)*\b/g)) {
    keywords.push(match[0]);
  }
  const checks = [
    ['RetryQueue', /\bRetryQueue\b/i],
    ['LWW', /\bLWW\b|Last-Write-Wins/i],
    ['IndexedDB', /\bIndexedDB\b/i],
    ['incremental pull', /\bincremental\s+pull\b|增量拉取/i],
    ['updated_at', /\bupdated_at\b/i],
    ['last_sync_time', /\blast_sync_time\b/i],
    ['debounce', /\bdebounce\b|DEBOUNCE_DELAY|防抖/i],
    ['local write', /\blocal\s+write\b|本地写入/i],
  ];
  for (const [keyword, pattern] of checks) {
    if (pattern.test(text)) keywords.push(keyword);
  }
  return unique(keywords);
}

function readPackageName(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) return path.basename(projectRoot);

  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return typeof pkg.name === 'string' ? pkg.name : path.basename(projectRoot);
  } catch {
    return path.basename(projectRoot);
  }
}

function unique(values) {
  return [...new Set(values.filter(value => value !== null && value !== undefined))];
}

function appendMapValue(map, key, value) {
  if (key === undefined || key === null) return;
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function uniqueObjects(values) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    const normalized = Object.fromEntries(
      Object.entries(value).filter(([, entryValue]) => entryValue !== null && entryValue !== undefined),
    );
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function uniqueTestMappings(values) {
  return uniqueObjects(values)
    .filter(mapping => mapping.file);
}

function testFilesFromMappings(testMappings) {
  return unique((testMappings ?? []).map(mapping => mapping.file));
}

function readLine(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function readColumn(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).character;
}

function relative(projectRoot, file) {
  return toPosix(path.relative(projectRoot, file));
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
