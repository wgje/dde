#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { loadRequiredFilesManifest } = require('./required-files-manifest.cjs');

const RETRY_QUEUE_TYPE_FILES = new Set([
  'src/app/core/services/sync/retry-queue-items.service.ts',
  'src/app/core/services/sync/retry-queue.service.ts',
]);
const RETRY_QUEUE_TYPE_NAMES = new Set([
  'RetryQueueItemsLayer',
  'RetryQueueService',
]);

function normalizePath(input) {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseRootArg() {
  const arg = process.argv.slice(2).find(item => item.startsWith('--root='));
  return arg ? path.resolve(arg.slice('--root='.length)) : process.cwd();
}

function parseFilesArg() {
  const arg = process.argv.slice(2).find(item => item.startsWith('--files='));
  if (!arg) return [];

  return arg
    .slice('--files='.length)
    .split(',')
    .map(item => normalizePath(item.trim()))
    .filter(Boolean);
}

function isIgnoredPath(relativePath) {
  const rel = normalizePath(relativePath);
  const basename = path.posix.basename(rel);

  return (
    rel.startsWith('src/tests/')
    || rel.includes('/mocks/')
    || rel.includes('/stubs/')
    || rel.includes('/fixtures/')
    || basename.startsWith('test-setup')
    || /\.spec\.ts$/.test(basename)
    || /\.test\.ts$/.test(basename)
    || /\.spec-helpers\.ts$/.test(basename)
    || /\.test-helpers\.ts$/.test(basename)
    || /\.spec-context\.ts$/.test(basename)
    || /\.spec-harness\.ts$/.test(basename)
  );
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function loadProgram(root) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    throw new Error(`tsconfig.json not found under ${root}`);
  }

  const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configResult.error) {
    throw new Error(formatDiagnostic(configResult.error));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configResult.config,
    ts.sys,
    root,
    { noEmit: true },
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatDiagnostic).join('\n'));
  }

  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

function symbolDeclaresRetryQueueType(symbol, root) {
  if (!symbol || !RETRY_QUEUE_TYPE_NAMES.has(symbol.getName())) {
    return false;
  }

  return (symbol.declarations ?? []).some(declaration => {
    const relativePath = normalizePath(path.relative(root, declaration.getSourceFile().fileName));
    return RETRY_QUEUE_TYPE_FILES.has(relativePath);
  });
}

function declarationBelongsToRetryQueueType(declaration, root) {
  let current = declaration;
  while (current) {
    if (
      (ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current))
      && current.name
      && RETRY_QUEUE_TYPE_NAMES.has(current.name.text)
    ) {
      const relativePath = normalizePath(path.relative(root, current.getSourceFile().fileName));
      return RETRY_QUEUE_TYPE_FILES.has(relativePath);
    }
    current = current.parent;
  }
  return false;
}

function isRetryQueueType(type, checker, root, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);

  if (type.isUnionOrIntersection?.()) {
    return type.types.some(member => isRetryQueueType(member, checker, root, seen));
  }

  if (
    symbolDeclaresRetryQueueType(type.aliasSymbol, root)
    || symbolDeclaresRetryQueueType(type.getSymbol?.(), root)
  ) {
    return true;
  }

  const baseTypes = typeof type.getBaseTypes === 'function' ? type.getBaseTypes() : [];
  if (baseTypes?.some(baseType => isRetryQueueType(baseType, checker, root, seen))) {
    return true;
  }

  const apparentType = checker.getApparentType(type);
  return apparentType !== type && isRetryQueueType(apparentType, checker, root, seen);
}

function hasRetryQueueAddDeclaration(type, receiver, checker, root) {
  const addProperty = checker.getPropertyOfType(type, 'add');
  if (!addProperty) return false;

  if ((addProperty.declarations ?? []).some(declaration => (
    declarationBelongsToRetryQueueType(declaration, root)
  ))) {
    return true;
  }

  const addType = checker.getTypeOfSymbolAtLocation(addProperty, receiver);
  return checker.getSignaturesOfType(addType, ts.SignatureKind.Call).some(signature => {
    const declaration = signature.getDeclaration?.() ?? signature.declaration;
    return declaration ? declarationBelongsToRetryQueueType(declaration, root) : false;
  });
}

function getUnsafeAddReceiver(node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'add') {
    return node.expression;
  }

  if (
    ts.isElementAccessExpression(node)
    && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === 'add'
  ) {
    return node.expression;
  }

  return null;
}

function findViolations(root, program, explicitFiles) {
  const checker = program.getTypeChecker();
  const explicitSet = new Set(explicitFiles.map(normalizePath));
  const violations = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || program.isSourceFileFromExternalLibrary(sourceFile)) {
      continue;
    }

    const relativePath = normalizePath(path.relative(root, sourceFile.fileName));
    if (
      !relativePath.startsWith('src/')
      || isIgnoredPath(relativePath)
      || (explicitSet.size > 0 && !explicitSet.has(relativePath))
    ) {
      continue;
    }

    const visit = node => {
      const receiver = getUnsafeAddReceiver(node);
      const receiverType = receiver ? checker.getTypeAtLocation(receiver) : null;
      if (
        receiver
        && (
          isRetryQueueType(receiverType, checker, root)
          || hasRetryQueueAddDeclaration(receiverType, receiver, checker, root)
        )
      ) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          file: relativePath,
          line: start.line + 1,
          column: start.character + 1,
          sourceLine: sourceFile.text.split(/\r?\n/)[start.line]?.trim() ?? '',
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

function main() {
  const root = parseRootArg();
  let files;
  try {
    const manifestFiles = loadRequiredFilesManifest({ projectRoot: root });
    files = manifestFiles ?? parseFilesArg();
  } catch (error) {
    console.error(`[quality:guard:retryqueue-durable-add] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let program;
  try {
    program = loadProgram(root);
  } catch (error) {
    console.error(`[quality:guard:retryqueue-durable-add] unable to load TypeScript project: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const violations = findViolations(root, program, files);
  if (violations.length === 0) {
    console.log('[quality:guard:retryqueue-durable-add] passed');
    process.exit(0);
  }

  console.error('[quality:guard:retryqueue-durable-add] blocked because production code accesses RetryQueueService.add():');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}:${violation.column}`);
    console.error('  use addDurably() or RetryQueueEnqueueService.addToRetryQueueDurably() so retry intent is persisted before success is reported.');
    console.error(`  source: ${violation.sourceLine}`);
  }
  console.error('Compatibility add() is allowed only in test/helper files; production retry writes must use a durable API.');
  process.exit(1);
}

main();
