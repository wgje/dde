'use strict';
const ts = require('typescript');
const path = require('node:path');
const {
  createStaticProgramGraph, createStructuralProgramAdapter, createTypeScriptCallFrameResolver, resolveStaticCallableSet,
  indexRootedCallsiteLanes,
} = require('./codegraph-overlay-callback-reachability-solver.cjs');
const EAGER_ARRAY_METHODS = new Set(['map', 'sort', 'filter', 'some', 'every', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'flatMap', 'forEach', 'reduce', 'reduceRight', ]);
const ARRAY_RESULT_METHODS = new Set(['map', 'filter', 'flatMap', 'sort', 'slice']);
const ARRAY_ELEMENT_PRESERVING_METHODS = new Set(['filter', 'sort', 'slice']);
const PROFILE_ROOT_CALLEES = new Map([
  ['queryOverlay', 'queryOverlay'], ['selectGraphResults', 'selectGraphResults'],
  ['buildSourceBlocks', 'buildSourceBlocks'], ['buildNativeCodeBlocks', 'buildNativeCodeBlocks'],
  ['formatNativeMarkdown', 'formatNativeMarkdown'], ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown'],
]);
const PROFILE_VALUE_CALLEES = new Map([
  ['selectGraphResults', 'selectGraphResults'], ['toNativeEdges', 'toNativeEdge'],
  ['buildSourceBlocks', 'buildSourceBlocks'], ['buildNativeCodeBlocks', 'buildNativeCodeBlocks'],
  ['formatNativeMarkdown', 'formatNativeMarkdown'], ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown'],
]);
const ENTRY_VALUE_CALLEES = new Map([
  ['prioritizedGraphNodes', 'prioritizeQueryRelevantGraphNodes'],
  ['graphNodes', 'fillGraphNodeBudgetWithRelevantEndpoints'],
  ['closedGraphEdges', 'closeGraphEdgesOverSelectedNodes'], ['entryPoints', 'selectEntryPoints'],
]);
const staticName = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) ? node.text : null;
function isRuntimePublication(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
    && node.expression.name.text === 'assign';
}
function hasInstallerRuntimeCallBinding(body) {
  if (!ts.isBlock(body)) return false;
  return body.statements.some(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => {
      const outer = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'call' || !outer
        || !ts.isArrowFunction(outer) || outer.parameters.length === 0 || !ts.isIdentifier(outer.parameters[0].name)
        || !ts.isArrowFunction(outer.body) || !ts.isCallExpression(outer.body.body)
        || !ts.isElementAccessExpression(outer.body.body.expression)) {
        return false;
      }
      const access = outer.body.body.expression;
      return ts.isIdentifier(access.expression) && access.expression.text === 'runtime'
        && ts.isIdentifier(access.argumentExpression)
        && access.argumentExpression.text === outer.parameters[0].name.text;
    }));
}
function buildCallbackReachabilityProgram(input) {
  input?.instrumentation?.onProgramBuild?.();
  const diagnostics = [];
  const structuralSummary = { rootLaneQueuePops: 0, rootLaneStateInsertions: 0, rootLaneArcVisits: 0, eagerSiteSeeds: 0, eagerSiteQueuePops: 0, eagerDependencyChecks: 0, eagerDependencyWakes: 0 };
  const rawSources = Array.isArray(input?.sources) ? input.sources : [];
  const sourcePaths = new Set();
  const sources = [];
  for (const source of rawSources) {
    if (typeof source?.sourcePath !== 'string' || typeof source?.text !== 'string') {
      diagnostics.push('sources must contain sourcePath/text strings');
      continue;
    }
    if (sourcePaths.has(source.sourcePath)) {
      diagnostics.push(`duplicate source path: ${source.sourcePath}`);
      continue;
    }
    sourcePaths.add(source.sourcePath);
    sources.push({ ...source, ast: ts.createSourceFile(source.sourcePath, source.text, ts.ScriptTarget.Latest, true,
        ts.ScriptKind.TS, ),
    });
  }
  let nextIdentity = 1;
  const nodeIdentities = new WeakMap();
  const identityOf = node => {
    if (!nodeIdentities.has(node)) nodeIdentities.set(node, nextIdentity++);
    return nodeIdentities.get(node);
  };
  const scopes = [];
  const scopeByNode = new Map();
  const modulesByPath = new Map();
  const callablesByName = new Map();
  function createScope(node, body, parent, sourcePath, name = null, isModule = false) {
    const scope = {
      id: nextIdentity++, node, body, parent, sourcePath, name, isModule,
      installerRuntime: !isModule && hasInstallerRuntimeCallBinding(body), bindings: new Map(),
    };
    scopes.push(scope);
    scopeByNode.set(node, scope);
    if (name) callablesByName.set(name, [...(callablesByName.get(name) ?? []), scope]);
    return scope;
  }
  function collectCallables(node, parent, sourcePath) {
    const callable = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node);
    if (callable) {
      const declaredName = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        ? staticName(node.name) : null;
      const assignedName = ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)
        ? staticName(node.parent.name) : null;
      const scope = createScope(node, node.body, parent, sourcePath, declaredName ?? assignedName);
      ts.forEachChild(node.body, child => collectCallables(child, scope, sourcePath));
      return;
    }
    ts.forEachChild(node, child => collectCallables(child, parent, sourcePath));
  }
  for (const source of sources) {
    const moduleScope = createScope(source.ast, source.ast, null, source.sourcePath, null, true, );
    modulesByPath.set(source.sourcePath, moduleScope);
    ts.forEachChild(source.ast, child => collectCallables(child, moduleScope, source.sourcePath));
  }
  function bindingIn(scope, name) {
    if (!scope.bindings.has(name)) {
      scope.bindings.set(name, {
        id: nextIdentity++, name, scope, sources: [], parameter: null,
      });
    }
    return scope.bindings.get(name);
  }
  function resolveBinding(name, scope) {
    for (let current = scope; current; current = current.parent) {
      if (current.bindings.has(name)) return current.bindings.get(name);
    }
    return null;
  }
  const expressionRef = (node, scope) => ({ kind: 'expression', node, scope });
  const unknownRef = () => ({ kind: 'unknown', id: nextIdentity++ });
  function visitBindingPattern(pattern, path, onKnown, onUnknown) {
    if (ts.isIdentifier(pattern)) {
      onKnown(pattern, path);
      return;
    }
    const objectPattern = ts.isObjectBindingPattern(pattern);
    if (!objectPattern && !ts.isArrayBindingPattern(pattern)) return;
    pattern.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      const key = objectPattern ? staticName(element.propertyName ?? element.name) : index;
      if (element.dotDotDotToken || key === null) onUnknown(element.name);
      else visitBindingPattern(element.name, [...path, key], onKnown, onUnknown);
    });
  }
  function addPatternSource(scope, pattern, sourceRef, sourceScope, path = []) {
    visitBindingPattern(
      pattern,
      path,
      (identifier, sourcePath) => bindingIn(scope, identifier.text).sources.push({
        ref: sourceRef, sourceScope, path: sourcePath,
      }),
      unknownPattern => addPatternSource(scope, unknownPattern, unknownRef(), sourceScope),
    );
  }
  function addParameterPattern(scope, pattern, index, rest, path = []) {
    if (rest && !ts.isIdentifier(pattern)) {
      addPatternSource(scope, pattern, unknownRef(), scope);
      return;
    }
    visitBindingPattern(
      pattern,
      path,
      (identifier, parameterPath) => {
        bindingIn(scope, identifier.text).parameter = { index, rest, path: parameterPath };
      },
      unknownPattern => addPatternSource(scope, unknownPattern, unknownRef(), scope),
    );
  }
  const nodesByScope = new Map();
  function walkScope(scope, callback) {
    let nodes = nodesByScope.get(scope);
    if (!nodes) {
      nodes = [];
      function visit(node) {
        nodes.push(node);
        if (node === scope.body || !scopeByNode.has(node)) ts.forEachChild(node, visit);
      }
      if (!scope.isModule) {
        for (const parameter of scope.node.parameters) {
          if (parameter.initializer) visit(parameter.initializer);
        }
      }
      visit(scope.body);
      nodesByScope.set(scope, nodes);
    }
    for (const node of nodes) callback(node);
  }
  for (const scope of scopes) {
    if (!scope.isModule) {
      scope.node.parameters.forEach((parameter, index) => {
        addParameterPattern(scope, parameter.name, index, Boolean(parameter.dotDotDotToken));
      });
    }
    walkScope(scope, node => {
      const nested = scopeByNode.get(node);
      if (nested && nested !== scope && ts.isFunctionDeclaration(node) && node.name) {
        bindingIn(scope, node.name.text).sources.push({
          ref: { kind: 'callable', scope: nested }, sourceScope: scope, path: [],
        });
      }
      if (ts.isClassDeclaration(node) && node.name) {
        bindingIn(scope, node.name.text).sources.push({
          ref: { kind: 'class', node, scope }, sourceScope: scope, path: [],
        });
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) bindingIn(scope, node.name.text);
        if (node.initializer) {
          addPatternSource(scope, node.name, expressionRef(node.initializer, scope), scope);
        }
      }
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          addPatternSource(scope, declaration.name, { kind: 'element', base: expressionRef(node.expression, scope) },
            scope, );
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)) {
        const binding = resolveBinding(node.left.text, scope) ?? bindingIn(scope, node.left.text);
        binding.sources.push({ ref: expressionRef(node.right, scope), sourceScope: scope, path: [] });
      }
    });
  }
  const normalizedModules = new Map([...modulesByPath].map(([sourcePath, scope]) => (
    [sourcePath.replaceAll('\\', '/'), scope]
  )));
  function relativeModule(from, specifier) {
    if (!specifier.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from.replaceAll('\\', '/')), specifier));
    for (const candidate of [base, ...['.mjs', '.js', '.ts', '.cjs'].map(extension => `${base}${extension}`),
      ...['.mjs', '.js', '.ts', '.cjs'].map(extension => `${base}/index${extension}`)]) {
      if (normalizedModules.has(candidate)) return normalizedModules.get(candidate);
    }
    return null;
  }
  for (const source of sources) {
    const importer = modulesByPath.get(source.sourcePath);
    for (const statement of source.ast.statements) {
      const namedBindings = ts.isImportDeclaration(statement) && statement.importClause?.namedBindings;
      if (!namedBindings || !ts.isStringLiteral(statement.moduleSpecifier) || !ts.isNamedImports(namedBindings)) continue;
      const importedModule = relativeModule(source.sourcePath, statement.moduleSpecifier.text);
      if (!importedModule) continue;
      for (const element of namedBindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        const matches = (callablesByName.get(importedName) ?? [])
          .filter(scope => scope.parent === importedModule);
        if (matches.length === 1) bindingIn(importer, element.name.text).sources.push({
          ref: { kind: 'callable', scope: matches[0] }, sourceScope: importer, path: [],
        });
        else if (matches.length > 1) diagnostics.push(
          `ambiguous import binding: ${source.sourcePath}#${element.name.text} (${matches.length} matches)`,
        );
      }
    }
  }
  function namedCallableTargets(name, owner) {
    const binding = resolveBinding(name, owner);
    if (binding) return { binding, targets: null, complete: true };
    for (let current = owner; current; current = current.parent) {
      const matches = (callablesByName.get(name) ?? []).filter(scope => scope.parent === current);
      if (matches.length > 0) return { binding: null, targets: new Set(matches), complete: true };
    }
    const matches = (callablesByName.get(name) ?? []).filter(scope => scope.parent?.isModule);
    return {
      binding: null, targets: new Set(matches), complete: matches.length > 0,
    };
  }
  const entryModule = modulesByPath.get(input?.entrySourcePath);
  if (!entryModule) diagnostics.push(`entry source not found: ${String(input?.entrySourcePath ?? '')}`);
  const directCallableTarget = binding => {
    if (binding?.sources.length !== 1 || binding.sources[0].path.length !== 0) return null;
    const ref = binding.sources[0].ref;
    return ref.kind === 'callable' ? ref.scope : ref.kind === 'expression' ? scopeByNode.get(ref.node) ?? null : null;
  };
  const entryValueCandidates = [];
  const profileSites = new WeakMap();
  const profileValueCandidates = [];
  let nativeJsonCandidate = null;
  if (entryModule) walkScope(entryModule, node => {
    if (!ts.isCallExpression(node)) return;
    const declaration = node.parent;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer === node
      && ts.isIdentifier(declaration.name) && ts.isIdentifier(node.expression)
      && ENTRY_VALUE_CALLEES.get(declaration.name.text) === node.expression.text) {
      entryValueCandidates.push({ call: node, name: node.expression.text });
    }
    if (ts.isIdentifier(node.expression) && node.expression.text === 'profilePhase'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0])) {
      const phase = node.arguments[0].text;
      const expected = PROFILE_ROOT_CALLEES.get(phase) ?? PROFILE_VALUE_CALLEES.get(phase);
      const callback = scopeByNode.get(node.arguments[1]);
      const inner = callback && ts.isCallExpression(callback.body) ? callback.body : null;
      const direct = inner && ts.isIdentifier(inner.expression) && inner.expression.text === expected;
      const mapped = phase === 'toNativeEdges' && inner && ts.isPropertyAccessExpression(inner.expression)
        && ts.isIdentifier(inner.expression.expression) && inner.expression.expression.text === 'graphEdges'
        && inner.expression.name.text === 'map' && ts.isIdentifier(inner.arguments[0])
        && inner.arguments[0].text === expected;
      if (expected && callback?.parent === entryModule && (direct || mapped)) {
        profileSites.set(node, Object.freeze({ phase, callback, root: PROFILE_ROOT_CALLEES.has(phase) }));
        if (PROFILE_VALUE_CALLEES.has(phase) && direct) profileValueCandidates.push({ call: inner, name: expected,
          caller: callback, });
      }
    }
    if (ts.isIdentifier(node.expression) && node.expression.text === 'toNativeJsonFormatterResponse'
      && node.arguments.length === 1 && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'response'
      && ts.isConditionalExpression(node.parent) && node.parent.whenTrue === node
      && ts.isPropertyAccessExpression(node.parent.condition)
      && node.parent.condition.getText() === 'args.nativeJson'
      && ts.isIdentifier(node.parent.whenFalse) && node.parent.whenFalse.text === 'response'
      && ts.isVariableDeclaration(node.parent.parent) && ts.isIdentifier(node.parent.parent.name)
      && node.parent.parent.name.text === 'outputResponse') nativeJsonCandidate = node;
  });
  function approvedProfileCallback(call, scope) {
    if (scope !== entryModule || !ts.isIdentifier(call.expression) || call.expression.text !== 'profilePhase'
      || directCallableTarget(resolveBinding('profilePhase', entryModule))?.name !== 'profilePhase') return null;
    return profileSites.get(call)?.callback ?? null;
  }
  const installedRuntimeTargets = new Map();
  const installedRuntimeScopes = [];
  if (entryModule) walkScope(entryModule, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.arguments.length === 0
      || !ts.isIdentifier(node.arguments[0])) return;
    const target = directCallableTarget(resolveBinding(node.expression.text, entryModule));
    const runtimeBinding = resolveBinding(node.arguments[0].text, entryModule);
    if (!target || !runtimeBinding) return;
    if (target.installerRuntime) installedRuntimeScopes.push({ target, runtimeBinding });
  });
  for (const { target, runtimeBinding } of installedRuntimeScopes) walkScope(target, node => {
    if (!isRuntimePublication(node) || node.arguments.length < 2 || !ts.isIdentifier(node.arguments[0])
      || !ts.isObjectLiteralExpression(node.arguments[1])) return;
    const runtimeParameter = resolveBinding(node.arguments[0].text, target);
    if (runtimeParameter?.parameter?.index !== 0) return;
    if (!installedRuntimeTargets.has(runtimeBinding)) installedRuntimeTargets.set(runtimeBinding, new Map());
    const runtimeTargets = installedRuntimeTargets.get(runtimeBinding);
    for (const property of node.arguments[1].properties) {
      if (!ts.isShorthandPropertyAssignment(property)) continue;
      const callable = directCallableTarget(resolveBinding(property.name.text, target));
      if (!callable || runtimeTargets.has(property.name.text)) {
        runtimeTargets.set(property.name.text, null);
        continue;
      }
      runtimeTargets.set(property.name.text, callable);
    }
  });
  function entryInstalledTarget(call) {
    if (!ts.isIdentifier(call.expression)) return null;
    const binding = resolveBinding(call.expression.text, entryModule);
    if (!binding || binding.sources.length !== 1) return null;
    const source = binding.sources[0];
    if (source.sourceScope !== entryModule || source.path.length !== 1
      || source.path[0] !== call.expression.text || source.ref.kind !== 'expression'
      || !ts.isIdentifier(source.ref.node)) return null;
    const runtimeBinding = resolveBinding(source.ref.node.text, entryModule);
    return installedRuntimeTargets.get(runtimeBinding)?.get(call.expression.text) ?? null;
  }
  function installedRuntimeTarget(name) {
    const targets = new Set([...installedRuntimeTargets.values()].map(values => values.get(name)).filter(Boolean));
    return targets.size === 1 ? [...targets][0] : null;
  }
  const descriptors = new WeakMap();
  const fixedCall = (call, target) => call.arguments.length === target.node.parameters.length && !call.arguments.some(ts.isSpreadElement);
  const fixedLocalCall = (call, target) => fixedCall(call, target)
    && target.node.parameters.every(parameter => !parameter.dotDotDotToken
      && !parameter.questionToken && !parameter.initializer);
  function descriptor(call, caller, target, kind, rootFrame = false) {
    if (!target || !fixedCall(call, target) || (kind === 'native-json' && !fixedLocalCall(call, target))) return null;
    return Object.freeze({ call, caller, target, kind, rootFrame,
      key: Object.freeze([identityOf(call), caller.id, target.id]), });
  }
  for (const candidate of entryValueCandidates) {
    const target = entryInstalledTarget(candidate.call)
      ?? directCallableTarget(resolveBinding(candidate.name, entryModule));
    const value = descriptor(candidate.call, entryModule, target, 'producer', true);
    if (value) descriptors.set(candidate.call, value);
  }
  function exactEntryDependency(node, name) {
    if (ts.isIdentifier(node)) return node.text === name;
    return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'slice' && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === name;
  }
  const provenArrayBindings = new Set();
  for (const candidate of entryValueCandidates) {
    const declaration = candidate.call.parent, name = ts.isVariableDeclaration(declaration)
      && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    const prerequisite = name === 'graphNodes' ? 'prioritizedGraphNodes'
      : name === 'closedGraphEdges' || name === 'entryPoints' ? 'graphNodes' : null;
    const prerequisiteProven = !prerequisite || (provenArrayBindings.has(resolveBinding(prerequisite, entryModule))
      && candidate.call.arguments.some(argument => exactEntryDependency(argument, prerequisite)));
    if (name && descriptors.has(candidate.call) && prerequisiteProven) provenArrayBindings.add(resolveBinding(name, entryModule));
  }
  const graphEdgesBinding = entryModule?.bindings.get('graphEdges');
  const graphEdgesSource = graphEdgesBinding?.sources.find(source => source.ref.kind === 'expression'
    && ts.isConditionalExpression(source.ref.node));
  const graphSelectionBinding = entryModule?.bindings.get('graphSelection');
  const graphSelectionSource = graphSelectionBinding?.sources.find(source => source.ref.kind === 'expression'
    && ts.isCallExpression(source.ref.node) && approvedProfileCallback(source.ref.node, entryModule));
  const closedGraphEdgesBinding = entryModule?.bindings.get('closedGraphEdges');
  if (graphEdgesBinding && graphEdgesSource && graphSelectionSource
    && provenArrayBindings.has(closedGraphEdgesBinding)
    && graphEdgesSource.ref.node.whenTrue.getText().includes('graphSelection.edges')
    && graphEdgesSource.ref.node.whenFalse.getText().includes('closedGraphEdges.slice')) {
    provenArrayBindings.add(graphEdgesBinding);
  }
  for (const candidate of profileValueCandidates) {
    const value = descriptor(candidate.call, candidate.caller, installedRuntimeTarget(candidate.name), 'profile', true);
    if (value) descriptors.set(candidate.call, value);
  }
  if (nativeJsonCandidate) {
    const value = descriptor(nativeJsonCandidate, entryModule, installedRuntimeTarget('toNativeJsonFormatterResponse'),
      'native-json', true, );
    if (value) descriptors.set(nativeJsonCandidate, value);
  }
  function valueCallDescriptor(call, caller, originalTarget = null) {
    const exact = descriptors.get(call);
    if (exact) return exact.caller === caller && (!originalTarget || exact.target === originalTarget) ? exact : null;
    if (!originalTarget || !ts.isIdentifier(call.expression) || caller.parent !== originalTarget.parent
      || !caller.parent?.installerRuntime || !fixedLocalCall(call, originalTarget)) return null;
    const named = directCallableTarget(resolveBinding(call.expression.text, caller));
    return named === originalTarget ? descriptor(call, caller, originalTarget, 'installer-local') : null;
  }
  function installerCallableTargets(name) {
    const binding = entryModule?.bindings.get(name);
    const direct = directCallableTarget(binding);
    const installed = installedRuntimeTarget(name);
    return resolveStaticCallableSet({ binding, direct, installed, matches: callablesByName.get(name) ?? [],
      onAmbiguous: count => diagnostics.push(`ambiguous installer runtime callable: ${name} (${count} matches)`),
    });
  }
  for (const scope of scopes.filter(candidate => candidate.installerRuntime)) walkScope(scope, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'call'
      && ts.isStringLiteral(node.arguments[0])) installerCallableTargets(node.arguments[0].text);
  });
  function expressionReturnRefs(scope) {
    const refs = [];
    if (ts.isArrowFunction(scope.node) && !ts.isBlock(scope.body)) refs.push(expressionRef(scope.body, scope));
    else walkScope(scope, node => {
      if (ts.isReturnStatement(node)) refs.push(node.expression
        ? expressionRef(node.expression, scope) : unknownRef());
    });
    return refs.length > 0 ? refs : [unknownRef()];
  }
  const namedCaller = scope => {
    for (let current = scope; current; current = current.parent) if (current.name) return current;
    return scope;
  };
  const structural = createStructuralProgramAdapter({
    evidenceSource: namedCaller,
    describeScope: scope => ({ sourcePath: scope.sourcePath, name: scope.name, identity: scope.id,
      start: scope.node.getStart(), end: scope.node.getEnd() }),
    describeSite: site => {
      const source = site.getSourceFile(), start = ts.getLineAndCharacterOfPosition(source, site.getStart());
      const end = ts.getLineAndCharacterOfPosition(source, site.getEnd());
      return { sourcePath: source.fileName, start: site.getStart(), end: site.getEnd(),
        line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 };
    },
  });
  const { callsiteKey, edgeKey, provenanceEdge, scopeKey } = structural;
  const localMemberTarget = (expression, scope) => {
    if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) return null;
    const binding = resolveBinding(expression.expression.text, scope);
    const source = binding?.sources.length === 1 && binding.sources[0].path.length === 0 ? binding.sources[0] : null;
    const object = source?.ref.kind === 'expression' && ts.isObjectLiteralExpression(source.ref.node) ? source.ref.node : null;
    const members = object?.properties.filter(property => staticName(property.name) === expression.name.text) ?? [];
    const member = members.length === 1 ? members[0] : null;
    return member ? scopeByNode.get(ts.isPropertyAssignment(member) ? member.initializer : member) ?? null : null;
  };
  const directTarget = (call, scope) => {
    if (!ts.isIdentifier(call.expression)) return localMemberTarget(call.expression, scope);
    const named = namedCallableTargets(call.expression.text, scope);
    return named.binding ? directCallableTarget(named.binding)
      : named.targets.size === 1 ? [...named.targets][0] : null;
  };
  const sitesByScope = new Map();
  for (const scope of scopes) {
    const calls = [];
    const delegates = [];
    walkScope(scope, node => {
      if (scope.installerRuntime && ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)
        && node.left.text.endsWith('Delegate')) delegates.push(node);
      if (!ts.isCallExpression(node) || isRuntimePublication(node)) return;
      const eager = ts.isPropertyAccessExpression(node.expression)
        && EAGER_ARRAY_METHODS.has(node.expression.name.text) && node.arguments.length > 0;
      const installerName = scope.installerRuntime && ts.isIdentifier(node.expression)
        && node.expression.text === 'call' && ts.isStringLiteral(node.arguments[0])
        ? node.arguments[0].text : null;
      const target = directTarget(node, scope);
      const frameDescriptor = valueCallDescriptor(node, scope) ?? (target
        ? valueCallDescriptor(node, scope, target) : null);
      calls.push(Object.freeze({ node, caller: scope, directTarget: target, eager,
        installerName, frameDescriptor, profileCallback: approvedProfileCallback(node, scope),
        key: callsiteKey(node) }));
    });
    calls.sort((left, right) => left.node.getStart() - right.node.getStart() || left.node.getEnd() - right.node.getEnd());
    delegates.sort((left, right) => left.getStart() - right.getStart());
    sitesByScope.set(scope, Object.freeze({ calls: Object.freeze(calls), delegates: Object.freeze(delegates) }));
  }
  const mapSetSites = Object.freeze([...sitesByScope].flatMap(([scope, sites]) => sites.calls
    .filter(site => ts.isPropertyAccessExpression(site.node.expression)
      && site.node.expression.name.text === 'set' && site.node.arguments.length >= 2)
    .map(site => Object.freeze({ call: site.node, scope }))));
  const rootSeedSites = Object.freeze(entryModule ? (sitesByScope.get(entryModule)?.calls ?? []).flatMap(site => [
    Object.freeze({ caller: entryModule, site }),
    ...(site.profileCallback ? (sitesByScope.get(site.profileCallback)?.calls ?? []).map(callbackSite => (
      Object.freeze({ caller: site.profileCallback, site: callbackSite })
    )) : []),
  ]) : []);
  const delegateTargets = new Map();
  for (const scope of scopes.filter(candidate => candidate.installerRuntime)) {
    for (const assignment of sitesByScope.get(scope)?.delegates ?? []) {
      if (!ts.isIdentifier(assignment.left) || !ts.isIdentifier(assignment.right)) continue;
      const target = directCallableTarget(resolveBinding(assignment.right.text, scope));
      const previous = delegateTargets.get(assignment.left.text);
      delegateTargets.set(assignment.left.text, previous && previous !== target ? null : target);
    }
  }
  function runtimeBindingTarget(binding) {
    if (!binding) return null;
    const targets = new Set();
    for (const source of binding.sources) {
      const node = source.ref.kind === 'expression' ? source.ref.node : null;
      if (!source.sourceScope.installerRuntime || source.path.length !== 0 || !node
        || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'call'
        || !ts.isStringLiteral(node.arguments[0])) continue;
      const resolved = installerCallableTargets(node.arguments[0].text);
      if (resolved.binding) {
        const direct = directCallableTarget(resolved.binding);
        if (direct) targets.add(direct);
      } else if (resolved.complete) for (const target of resolved.targets) targets.add(target);
    }
    return targets.size === 1 ? [...targets][0] : null;
  }
  const exactSiteTargets = site => {
    const targets = new Set();
    if (site.directTarget) targets.add(site.directTarget);
    if (site.installerName) {
      const installed = installerCallableTargets(site.installerName);
      if (!installed.binding && installed.complete) for (const target of installed.targets) targets.add(target);
      if (installed.binding) {
        const direct = directCallableTarget(installed.binding);
        if (direct) targets.add(direct);
      }
    }
    const call = site.node;
    if (ts.isCallExpression(call.expression) && ts.isIdentifier(call.expression.expression)
      && call.expression.expression.text === 'installedDelegate'
      && ts.isIdentifier(call.expression.arguments[0])) {
      const delegated = delegateTargets.get(call.expression.arguments[0].text);
      if (delegated) targets.add(delegated);
    }
    if (ts.isIdentifier(call.expression)) {
      const runtimeTarget = runtimeBindingTarget(resolveBinding(call.expression.text, site.caller));
      if (runtimeTarget) targets.add(runtimeTarget);
      const delegated = delegateTargets.get(call.expression.text);
      if (delegated) targets.add(delegated);
    }
    return [...targets];
  };
  const callSitesByTarget = new Map();
  for (const [caller, sites] of sitesByScope) for (const site of sites.calls) {
    const targets = new Set(exactSiteTargets(site));
    if (site.frameDescriptor) targets.add(site.frameDescriptor.target);
    for (const target of targets) {
      if (!callSitesByTarget.has(target)) callSitesByTarget.set(target, []);
      callSitesByTarget.get(target).push({ call: site.node, caller, frameDescriptor: site.frameDescriptor });
    }
  }
  const framedTargetNames = new Set([...ENTRY_VALUE_CALLEES.values(), ...PROFILE_VALUE_CALLEES.values(),
    'toNativeJsonFormatterResponse']);
  const rootedCallsites = indexRootedCallsiteLanes({ callSitesByTarget,
    roots: [...framedTargetNames].map(installedRuntimeTarget).filter(Boolean),
    isRootSite: (site, root) => site.frameDescriptor?.target === root,
  });
  structuralSummary.rootLaneQueuePops = rootedCallsites.summary.queuePops; structuralSummary.rootLaneStateInsertions = rootedCallsites.summary.stateInsertions; structuralSummary.rootLaneArcVisits = rootedCallsites.summary.arcVisits;
  const valueCallSiteGroups = target => framedTargetNames.has(target.name) && target.parent !== entryModule
    && !rootedCallsites.rootsByTarget.has(target) ? [] : rootedCallsites.groups(target);
  const valueCallSites = target => valueCallSiteGroups(target).flatMap(group => group.sites);
  const callbackFrames = new Map(); let activeEagerDependencies = null;
  const latestLocalSource = (binding, use, scope) => binding?.sources.filter(source => source.sourceScope === scope
    && source.ref.kind === 'expression' && source.ref.node.end <= use.pos)
    .sort((left, right) => right.ref.node.pos - left.ref.node.pos)[0] ?? null;
  const staticFrames = createTypeScriptCallFrameResolver({
    syntax: ts, scopeKey, identityOf, scopeByNode, resolveBinding, directCallableTarget,
    runtimeBindingTarget, localMemberTarget, latestLocalSource, callSitesOf: valueCallSites,
    delegateTarget: name => delegateTargets.get(name),
  });
  const callableExpressionTargets = (node, scope) => staticFrames.callableTargets({ node, scope });
  function mapValues(node, scope) {
    if (!ts.isIdentifier(node)) return [];
    const binding = resolveBinding(node.text, scope);
    if (!binding) return [];
    return mapSetSites.flatMap(({ call, scope: setScope }) => {
      if (!ts.isPropertyAccessExpression(call.expression)
        || !ts.isIdentifier(call.expression.expression)
        || resolveBinding(call.expression.expression.text, setScope) !== binding) return [];
      return call.arguments[1] ? [{ node: call.arguments[1], scope: setScope }] : [];
    });
  }
  const isNativeMapReceiver = (node, scope) => ts.isIdentifier(node) && resolveBinding(node.text, scope)?.sources.some(source =>
    source.ref.kind === 'expression' && ts.isNewExpression(source.ref.node) && ts.isIdentifier(source.ref.node.expression)
      && source.ref.node.expression.text === 'Map');
  const sameExpression = (left, right) => left?.getText() === right?.getText();
  const guardedArrayBranch = (condition, branch, scope) => ts.isCallExpression(condition)
    && ts.isPropertyAccessExpression(condition.expression)
    && ts.isIdentifier(condition.expression.expression) && condition.expression.expression.text === 'Array'
    && condition.expression.name.text === 'isArray' && !resolveBinding('Array', scope)
    && condition.arguments.length === 1 && sameExpression(condition.arguments[0], branch);
  function expressionAtPath(node, scope, requestedPath, stack) {
    const key = `array:${scopeKey(scope)}:${identityOf(node)}:${requestedPath.join('.')}`;
    if (stack.has(key)) return false;
    const next = new Set(stack).add(key);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
      || ts.isTypeAssertionExpression(node)) return expressionAtPath(node.expression, scope, requestedPath, next);
    if (ts.isIdentifier(node)) {
      const binding = resolveBinding(node.text, scope);
      if (requestedPath.length === 0 && provenArrayBindings.has(binding)) return true;
      const local = latestLocalSource(binding, node, scope);
      if (scope === entryModule && requestedPath.length === 0 && local?.ref.kind === 'expression'
        && ENTRY_VALUE_CALLEES.has(binding?.name)) return false;
      return Boolean(binding) && (local ? local.ref.kind === 'expression'
        && expressionAtPath(local.ref.node, local.ref.scope, [...local.path, ...requestedPath], next)
        : bindingAtPath(binding, requestedPath, next));
    }
    if (ts.isPropertyAccessExpression(node)) {
      return expressionAtPath(node.expression, scope, [node.name.text, ...requestedPath], next);
    }
    if (ts.isObjectLiteralExpression(node) && requestedPath.length > 0) {
      const property = node.properties.find(candidate => staticName(candidate.name) === String(requestedPath[0]));
      if (property && ts.isPropertyAssignment(property)) return expressionAtPath(property.initializer, scope,
        requestedPath.slice(1), next);
      if (property && ts.isShorthandPropertyAssignment(property)) return expressionAtPath(property.name, scope,
        requestedPath.slice(1), next);
      return false;
    }
    if (ts.isArrayLiteralExpression(node) && requestedPath.length > 0 && Number.isInteger(requestedPath[0])) {
      const element = node.elements[requestedPath[0]];
      return Boolean(element && !ts.isSpreadElement(element)
        && expressionAtPath(element, scope, requestedPath.slice(1), next));
    }
    if (requestedPath.length > 0 && ts.isCallExpression(node)) {
      const callback = approvedProfileCallback(node, scope);
      if (callback) return expressionReturnRefs(callback).every(ref => ref.kind === 'expression'
        && expressionAtPath(ref.node, ref.scope, requestedPath, next));
      const targets = exactCallTargets(node, scope);
      return targets.length === 1 && expressionReturnRefs(targets[0]).every(ref => ref.kind === 'expression'
        && expressionAtPath(ref.node, ref.scope, requestedPath, next));
    }
    if (requestedPath.length > 0) return false;
    if (ts.isArrayLiteralExpression(node)) return true;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Array'
      && !resolveBinding('Array', scope)) return true;
    if (ts.isConditionalExpression(node)) {
      const trueArray = guardedArrayBranch(node.condition, node.whenTrue, scope)
        || expressionAtPath(node.whenTrue, scope, [], next);
      return trueArray && expressionAtPath(node.whenFalse, scope, [], next);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && ts.isCallExpression(node.left) && ts.isPropertyAccessExpression(node.left.expression)
        && node.left.expression.name.text === 'get'
        && isNativeMapReceiver(node.left.expression.expression, scope)
        && expressionAtPath(node.right, scope, [], next)) return true;
      return expressionAtPath(node.left, scope, [], next) && expressionAtPath(node.right, scope, [], next);
    }
    if (!ts.isCallExpression(node)) return false;
    const callback = approvedProfileCallback(node, scope);
    if (callback) return expressionReturnRefs(callback).every(ref => ref.kind === 'expression'
      && expressionAtPath(ref.node, ref.scope, [], next));
    if (ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression, method = node.expression.name.text;
      if (ts.isIdentifier(receiver) && receiver.text === 'Array' && method === 'from'
        && !resolveBinding('Array', scope)) return true;
      if (ARRAY_RESULT_METHODS.has(method)) return expressionAtPath(receiver, scope, [], next);
      if (method === 'get') {
        const values = mapValues(receiver, scope);
        return values.length > 0 && values.every(value => expressionAtPath(value.node, value.scope, [], next));
      }
    }
    const targets = exactCallTargets(node, scope);
    return targets.length === 1 && expressionReturnRefs(targets[0]).every(ref => ref.kind === 'expression'
      && expressionAtPath(ref.node, ref.scope, [], next));
  }
  function elementAtPath(node, scope, requestedPath, stack) {
    const key = `element:${scopeKey(scope)}:${identityOf(node)}:${requestedPath.join('.')}`;
    if (stack.has(key)) return false;
    const next = new Set(stack).add(key);
    if (ts.isIdentifier(node)) {
      const binding = resolveBinding(node.text, scope);
      const local = latestLocalSource(binding, node, scope);
      const sources = local ? [local] : binding?.sources ?? [];
      return sources.length > 0 && sources.every(source => source.ref.kind === 'expression'
        && source.path.length === 0 && elementAtPath(source.ref.node, source.ref.scope, requestedPath, next));
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.length > 0 && node.elements.every(element => (
      ts.isSpreadElement(element) ? elementAtPath(element.expression, scope, requestedPath, next)
        : expressionAtPath(element, scope, requestedPath, next)
    ));
    if (!ts.isCallExpression(node)) return false;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression, method = node.expression.name.text;
      if (ARRAY_ELEMENT_PRESERVING_METHODS.has(method)) return elementAtPath(receiver, scope, requestedPath, next);
      if (method === 'entries' && requestedPath[0] === 1) {
        const values = mapValues(receiver, scope);
        return values.length > 0 && values.every(value => expressionAtPath(value.node, value.scope,
          requestedPath.slice(1), next));
      }
      if (method === 'map') {
        const targets = callableExpressionTargets(node.arguments[0], scope);
        return targets.length === 1 && expressionReturnRefs(targets[0]).every(ref => ref.kind === 'expression'
          && expressionAtPath(ref.node, ref.scope, requestedPath, next));
      }
    }
    const targets = exactCallTargets(node, scope);
    return targets.length === 1 && expressionReturnRefs(targets[0]).every(ref => ref.kind === 'expression'
      && elementAtPath(ref.node, ref.scope, requestedPath, next));
  }
  function bindingAtPath(binding, requestedPath, stack) {
    if (binding.parameter) {
      activeEagerDependencies?.add(binding.scope);
      const frames = callbackFrames.get(binding.scope) ?? [];
      if (binding.parameter.index === 0 && frames.some(frame => elementAtPath(frame.receiver, frame.caller,
        [...binding.parameter.path, ...requestedPath], stack))) return true;
      if (binding.parameter.index === 2 && binding.parameter.path.length === 0
        && frames.some(frame => expressionAtPath(frame.receiver, frame.caller, requestedPath, stack))) return true;
      return valueCallSiteGroups(binding.scope).some(group => {
        const frames = group.sites.map(({ call, caller }) => staticFrames.expandCall({ node: call, scope: caller }));
        const proven = values => values.length > 0 && values.every(frame => {
          const argument = frame[binding.parameter.index];
          return Boolean(argument && expressionAtPath(argument.node, argument.scope,
            [...binding.parameter.path, ...requestedPath], stack));
        });
        return frames.length > 0 && (group.root ? frames.some(proven) : frames.every(proven));
      });
    }
    if (binding.sources.length === 0) return false;
    return binding.sources.every(source => source.ref.kind === 'expression'
      && expressionAtPath(source.ref.node, source.ref.scope,
        [...source.path, ...requestedPath], stack));
  }
  function exactCallTargets(call, caller) {
    const site = (sitesByScope.get(caller)?.calls ?? []).find(candidate => candidate.node === call);
    if (site) return [...new Set([...exactSiteTargets(site),
      ...(site.frameDescriptor ? [site.frameDescriptor.target] : [])])];
    const target = directTarget(call, caller);
    return target ? [target] : [];
  }
  const staticGraph = createStaticProgramGraph({ key: 'forward', nodes: scopes.map(scopeKey).sort() });
  function addGraphArc(kind, call, caller, target, candidate = false) {
    const producerNode = kind === 'array-callback' ? call.arguments[0] : kind === 'delegate' ? call.right : call.expression;
    const candidateRecord = candidate && { producer: callsiteKey(producerNode), caller: scopeKey(caller),
      callsite: callsiteKey(call), target: scopeKey(target), argumentIndex: kind === 'array-callback' ? 0 : null };
    const key = edgeKey(kind, call, caller, target);
    return staticGraph.add({ key, source: scopeKey(caller), target: scopeKey(target),
      sourceFactKind: 'root', targetFactKind: 'root', kind,
      evidence: provenanceEdge(kind, caller, target, call), candidate: candidateRecord }, candidate);
  }
  const eagerSites = [];
  for (const [caller, sites] of sitesByScope) for (const site of sites.calls) {
    const exact = new Set(exactSiteTargets(site));
    for (const target of exact) addGraphArc('call', site.node, caller, target);
    for (const target of callableExpressionTargets(site.node.expression, caller)) {
      if (!exact.has(target)) addGraphArc('argument-callback', site.node, caller, target, true);
    }
    if (site.eager && ts.isPropertyAccessExpression(site.node.expression)) eagerSites.push({ caller, site });
  }
  for (const [caller, sites] of sitesByScope) for (const assignment of sites.delegates) {
    const target = ts.isIdentifier(assignment.right) && directCallableTarget(resolveBinding(assignment.right.text, caller));
    if (target) addGraphArc('delegate', assignment, caller, target, true);
  }
  structuralSummary.eagerSiteSeeds = eagerSites.length; const eagerKey = value => `${scopeKey(value.caller)}\0${callsiteKey(value.site.node)}`;
  const eagerQueue = [...eagerSites].sort((left, right) => eagerKey(left).localeCompare(eagerKey(right))), eagerQueued = new Set(eagerQueue), dependenciesByEager = new Map(), waitersByScope = new Map();
  function replaceEagerDependencies(entry, dependencies) {
    for (const scope of dependenciesByEager.get(entry) ?? []) waitersByScope.get(scope)?.delete(entry);
    dependenciesByEager.set(entry, dependencies); structuralSummary.eagerDependencyChecks += dependencies.size;
    for (const scope of dependencies) { const waiters = waitersByScope.get(scope) ?? new Set(); waiters.add(entry); waitersByScope.set(scope, waiters); }
  }
  function wakeEager(entry) {
    if (eagerQueued.has(entry)) return;
    eagerQueued.add(entry); eagerQueue.push(entry); structuralSummary.eagerDependencyWakes += 1;
  }
  for (let cursor = 0; cursor < eagerQueue.length; cursor += 1) {
    const entry = eagerQueue[cursor], { caller, site } = entry, receiver = site.node.expression.expression;
    eagerQueued.delete(entry); structuralSummary.eagerSiteQueuePops += 1;
    activeEagerDependencies = new Set(); const proven = expressionAtPath(receiver, caller, [], new Set()), dependencies = activeEagerDependencies; activeEagerDependencies = null; replaceEagerDependencies(entry, dependencies);
    if (!proven) continue;
    for (const target of callableExpressionTargets(site.node.arguments[0], caller)) {
      addGraphArc('array-callback', site.node, caller, target, true); if (!callbackFrames.has(target)) callbackFrames.set(target, []);
      if (callbackFrames.get(target).some(frame => frame.call === site.node)) continue;
      callbackFrames.get(target).push({ call: site.node, caller, receiver }); for (const waiter of [...(waitersByScope.get(target) ?? [])].sort((left, right) => eagerKey(left).localeCompare(eagerKey(right)))) wakeEager(waiter);
    }
  }
  const { condensation, directionGraph, frameCandidates, graphArcs } = staticGraph.finish();
  const rootCallSites = Object.freeze(rootSeedSites.flatMap(({ caller, site }) => exactSiteTargets(site).map(target => Object.freeze(
    { target, caller, call: site.node, evidence: provenanceEdge('root-call', caller, target, site.node) }))));
  const resolveRootMatches = root => (callablesByName.get(root?.name) ?? [])
    .filter(scope => scope.sourcePath === root?.sourcePath);
  return Object.freeze({
    diagnostics, provenanceEdge, resolveRootMatches, scopeKey,
    condensation, directionGraph, frameCandidates: Object.freeze(frameCandidates), graphArcs,
    rootCallSites, structuralSummary: Object.freeze(structuralSummary), scopeByKey: new Map(scopes.map(scope => [scopeKey(scope), scope])),
  });
}
module.exports = { buildCallbackReachabilityProgram };
