import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const runtimeSourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const localModuleExtensions = [
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.json',
  '.node',
];

function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function relativeRepoPath(root: string, filePath: string): string {
  return normalizeRepoPath(path.relative(root, filePath));
}

function listTrackedFiles(root: string, pathspecs: string[] = []): string[] {
  const args = ['ls-files', '-z'];
  if (pathspecs.length > 0) {
    args.push('--', ...pathspecs);
  }
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepoPath);
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.ts':
    case '.cts':
    case '.mts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

function staticModuleText(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function collectStaticLocalModuleSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const specifiers = new Set<string>();
  const addLocalSpecifier = (specifier: string | null): void => {
    if (specifier?.startsWith('.')) {
      specifiers.add(specifier);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLocalSpecifier(staticModuleText(node.moduleSpecifier));
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLocalSpecifier(staticModuleText(node.moduleReference.expression));
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isRequireResolve = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'require'
        && node.expression.name.text === 'resolve';
      if (isDynamicImport || isRequire || isRequireResolve) {
        addLocalSpecifier(staticModuleText(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...specifiers];
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveLocalModule(importerPath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [basePath];
  if (!path.extname(basePath)) {
    candidates.push(...localModuleExtensions.map(extension => `${basePath}${extension}`));
  }
  candidates.push(...localModuleExtensions.map(extension => path.join(basePath, `index${extension}`)));
  return candidates.find(isFile) ?? null;
}

function entryViolation(entryPath: string, reason: 'missing' | 'untracked'): string {
  return `${entryPath} (entry ${reason})`;
}

export function findTrackedRuntimeScripts(root: string): string[] {
  return listTrackedFiles(root, ['scripts'])
    .filter(filePath => runtimeSourceExtensions.has(path.extname(filePath).toLowerCase()))
    .sort();
}

export function findUntrackedLocalDependencyViolations(
  root: string,
  entryPaths: string[],
): string[] {
  const trackedFiles = new Set(listTrackedFiles(root));
  const pending = [...new Set(entryPaths.map(normalizeRepoPath))];
  const visited = new Set<string>();
  const violations = new Set<string>();

  while (pending.length > 0) {
    const importer = pending.shift()!;
    if (visited.has(importer)) continue;
    visited.add(importer);

    const importerPath = path.resolve(root, importer);
    if (!trackedFiles.has(importer)) {
      violations.add(entryViolation(importer, isFile(importerPath) ? 'untracked' : 'missing'));
      continue;
    }
    if (!isFile(importerPath)) {
      violations.add(entryViolation(importer, 'missing'));
      continue;
    }
    if (!runtimeSourceExtensions.has(path.extname(importer).toLowerCase())) {
      continue;
    }

    for (const specifier of collectStaticLocalModuleSpecifiers(importerPath)) {
      const resolvedPath = resolveLocalModule(importerPath, specifier);
      const dependencyPath = relativeRepoPath(
        root,
        resolvedPath ?? path.resolve(path.dirname(importerPath), specifier),
      );
      if (!resolvedPath) {
        violations.add(`${importer} -> ${specifier} -> ${dependencyPath} (missing)`);
        continue;
      }
      if (!trackedFiles.has(dependencyPath)) {
        violations.add(`${importer} -> ${specifier} -> ${dependencyPath} (untracked)`);
        continue;
      }
      if (runtimeSourceExtensions.has(path.extname(dependencyPath).toLowerCase())) {
        pending.push(dependencyPath);
      }
    }
  }

  return [...violations].sort();
}
