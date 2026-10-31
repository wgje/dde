'use strict';

function createRpcLexicalResolver(ts, sourceFile) {
  const scopes = new Map();
  const bindingsByScope = new Map();
  const declarationBindings = new Map();
  const writes = new Map();
  const calls = [];
  const allBindings = [];
  let nextScopeId = 1;

  function unwrap(node) {
    let current = node;
    while (current && (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isTypeAssertionExpression(current)
    )) current = current.expression;
    return current;
  }

  function isFunction(node) {
    return ts.isFunctionLike(node) && !!node.body;
  }

  function createsScope(node) {
    return node !== sourceFile && (
      isFunction(node)
      || ts.isClassLike(node)
      || ts.isBlock(node)
      || ts.isCatchClause(node)
      || ts.isForStatement(node)
      || ts.isForInStatement(node)
      || ts.isForOfStatement(node)
      || ts.isWhileStatement(node)
      || ts.isDoStatement(node)
    );
  }

  const rootScope = { id: nextScopeId++, kind: 'source', node: sourceFile, parent: null };
  function assignScopes(node, inherited) {
    const scope = createsScope(node)
      ? { id: nextScopeId++, kind: isFunction(node) ? 'function' : 'block', node, parent: inherited }
      : inherited;
    scopes.set(node, scope);
    if (!bindingsByScope.has(scope)) bindingsByScope.set(scope, new Map());
    ts.forEachChild(node, child => assignScopes(child, scope));
  }
  assignScopes(sourceFile, rootScope);

  function nearestFunctionScope(scope) {
    let current = scope;
    while (current.parent && current.kind !== 'function' && current.kind !== 'source') current = current.parent;
    return current;
  }

  function addBinding(identifier, declaration, kind, scope, source = null, selectors = []) {
    const binding = {
      declaration,
      identifier,
      initializedAt: source?.end ?? declaration.end,
      kind,
      name: identifier.text,
      scope,
      selectors,
      source,
    };
    const names = bindingsByScope.get(scope);
    const candidates = names.get(binding.name) || [];
    candidates.push(binding);
    names.set(binding.name, candidates);
    declarationBindings.set(identifier, binding);
    writes.set(binding, []);
    allBindings.push(binding);
    return binding;
  }

  function registerPattern(pattern, declaration, kind, scope, source, selectors = []) {
    if (ts.isIdentifier(pattern)) {
      addBinding(pattern, declaration, kind, scope, source, selectors);
      return;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        registerPattern(element.name, declaration, kind, scope, source, [
          ...selectors,
          { kind: element.dotDotDotToken ? 'spread' : 'array', key: index },
        ]);
      });
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        const key = element.propertyName || element.name;
        registerPattern(element.name, declaration, kind, scope, source, [
          ...selectors,
          { kind: element.dotDotDotToken ? 'spread' : 'object', key },
        ]);
      }
    }
  }

  function declarationScope(node, kind) {
    let scope = scopes.get(node);
    if (kind === 'var') scope = nearestFunctionScope(scope);
    return scope;
  }

  function collectDeclarations(node) {
    if (ts.isImportSpecifier(node)) {
      const declaration = node.parent.parent.parent;
      addBinding(node.name, node, 'import', rootScope, null, [{
        imported: (node.propertyName || node.name).text,
        kind: 'import',
        module: declaration.moduleSpecifier.text,
        typeOnly: node.isTypeOnly || node.parent.parent.isTypeOnly,
      }]);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      const scope = isFunction(node) ? scopes.get(node).parent : scopes.get(node);
      addBinding(node.name, node, 'function', scope, node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addBinding(node.name, node, 'class', scopes.get(node).parent, node);
    } else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
      addBinding(node.name, node, 'type', scopes.get(node), node);
    } else if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const kind = list.flags & ts.NodeFlags.Const ? 'const'
        : list.flags & ts.NodeFlags.Let ? 'let' : 'var';
      registerPattern(node.name, node, kind, declarationScope(node, kind), node.initializer);
    } else if (ts.isParameter(node)) {
      registerPattern(node.name, node, 'parameter', nearestFunctionScope(scopes.get(node)), null);
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      addBinding(node.name, node, 'self', scopes.get(node), node);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      registerPattern(
        node.variableDeclaration.name,
        node.variableDeclaration,
        'catch',
        scopes.get(node),
        null,
      );
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  function binding(identifier) {
    if (!identifier || !ts.isIdentifier(identifier)) return null;
    const declared = declarationBindings.get(identifier);
    if (declared) return declared;
    let scope = scopes.get(identifier);
    while (scope) {
      const candidates = bindingsByScope.get(scope)?.get(identifier.text) || [];
      if (candidates.length !== 0) return candidates.length === 1 ? candidates[0] : null;
      scope = scope.parent;
    }
    return null;
  }

  function targetIdentifiers(node, result = []) {
    const target = unwrap(node);
    if (!target) return result;
    if (ts.isIdentifier(target)) result.push(target);
    else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      targetIdentifiers(target.expression, result);
    }
    else if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)
      || ts.isArrayBindingPattern(target) || ts.isObjectBindingPattern(target)) {
      ts.forEachChild(target, child => targetIdentifiers(child, result));
    } else if (ts.isPropertyAssignment(target)) targetIdentifiers(target.initializer, result);
    else if (ts.isShorthandPropertyAssignment(target) || ts.isBindingElement(target)) {
      targetIdentifiers(target.name, result);
    }
    return result;
  }

  function collectWrites(node) {
    let target = null;
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) target = node.left;
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
    else if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && !ts.isVariableDeclarationList(node.initializer)) target = node.initializer;
    for (const identifier of targetIdentifiers(target)) {
      const resolved = binding(identifier);
      if (resolved) writes.get(resolved).push(node);
    }
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(sourceFile);

  function propertyName(node) {
    if (!node) return null;
    if (ts.isComputedPropertyName(node)) {
      const result = immutableString(node.expression);
      return result.kind === 'exact' ? result.value : null;
    }
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
    return null;
  }

  function isNamedPropertyCall(node, name) {
    const expression = ts.isCallExpression(node) ? unwrap(node.expression) : null;
    return !!expression && ts.isPropertyAccessExpression(expression) && expression.name.text === name;
  }

  function isProperty(node, name) {
    return ts.isPropertyAccessExpression(node) && node.name.text === name;
  }

  function enclosingNamedFunction(node) {
    const owner = functionAncestor(node);
    return owner?.name ? propertyName(owner.name) : null;
  }

  function valueParent(node) {
    let current = node;
    while (current.parent && unwrap(current.parent) === current) current = current.parent;
    return current.parent;
  }

  function containsMember(node, expected) {
    let found = false;
    function scan(current) {
      if (found) return;
      const result = ts.isElementAccessExpression(current)
        ? immutableString(current.argumentExpression) : null;
      const parent = result && valueParent(current);
      found = isProperty(current, expected) || !!result && (result.kind === 'exact'
        ? result.value === expected
        : result.candidates?.includes(expected) || result.complete !== true
          && ts.isCallExpression(parent) && parent.expression === current);
      if (!found) ts.forEachChild(current, scan);
    }
    scan(node);
    return found;
  }

  function location(node, filePath) {
    const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { column: point.character + 1, line: point.line + 1, path: filePath };
  }

  function memberType(typeNode, name) {
    if (!typeNode || !ts.isTypeLiteralNode(typeNode)) return null;
    const member = typeNode.members.find(candidate => propertyName(candidate.name) === name);
    return member && ts.isPropertySignature(member) ? member.type : null;
  }

  function rawSource(resolved) {
    return resolved?.source
      ? { expression: unwrap(resolved.source), selectors: [...resolved.selectors] }
      : null;
  }

  function stringTypeCandidates(typeNode, seen = new Set()) {
    if (!typeNode) return { candidates: [], complete: false };
    if (ts.isParenthesizedTypeNode(typeNode)) return stringTypeCandidates(typeNode.type, seen);
    if (ts.isUnionTypeNode(typeNode)) {
      const parts = typeNode.types.map(type => stringTypeCandidates(type, new Set(seen)));
      return { candidates: parts.flatMap(part => part.candidates),
        complete: parts.every(part => part.complete) };
    }
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
      const declaration = binding(typeNode.typeName)?.declaration;
      if (!declaration || !ts.isTypeAliasDeclaration(declaration) || seen.has(declaration)) {
        return { candidates: [], complete: false };
      }
      seen.add(declaration);
      return stringTypeCandidates(declaration.type, seen);
    }
    return ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)
      ? { candidates: [typeNode.literal.text], complete: true }
      : { candidates: [], complete: false };
  }

  function immutableString(node, seen = new Set()) {
    const expression = unwrap(node);
    if (!expression) return { candidates: [], kind: 'unknown', reason: 'missing' };
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
      || ts.isNumericLiteral(expression)) {
      return { kind: 'exact', value: expression.text };
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const part = immutableString(span.expression, seen);
        if (part.kind !== 'exact') return part;
        value += part.value + span.literal.text;
      }
      return { kind: 'exact', value };
    }
    if (ts.isConditionalExpression(expression)) {
      const left = immutableString(expression.whenTrue, new Set(seen));
      const right = immutableString(expression.whenFalse, new Set(seen));
      if (left.kind === 'exact' && right.kind === 'exact' && left.value === right.value) return left;
      const candidates = [left, right].flatMap(value => value.kind === 'exact'
        ? [value.value] : value.candidates || []);
      const complete = [left, right].every(value => value.kind === 'exact' || value.complete === true);
      return { candidates: [...new Set(candidates)], complete, kind: 'unknown', reason: 'conditional' };
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = immutableString(expression.left, seen);
      const right = immutableString(expression.right, seen);
      return left.kind === 'exact' && right.kind === 'exact'
        ? { kind: 'exact', value: left.value + right.value }
        : left.kind !== 'exact' ? left : right;
    }
    if (!ts.isIdentifier(expression)) return { candidates: [], kind: 'unknown', reason: 'dynamic' };
    const resolved = binding(expression);
    if (!resolved) return { candidates: [], kind: 'unknown', reason: 'unbound' };
    if (seen.has(resolved)) return { candidates: [], kind: 'unknown', reason: 'cycle' };
    seen.add(resolved);
    const source = rawSource(resolved);
    const declared = resolved.kind === 'parameter' && writes.get(resolved).length === 0
      ? stringTypeCandidates(resolved.declaration.type) : { candidates: [], complete: false };
    if (!source && declared.candidates.length > 0) {
      return { candidates: [...new Set(declared.candidates)], complete: declared.complete,
        kind: 'unknown', reason: 'declared-literals' };
    }
    if (!source || source.selectors.some(selector => selector.kind !== 'import')) {
      return { candidates: [], kind: 'unknown', reason: 'selector' };
    }
    const initial = immutableString(source.expression, new Set(seen));
    if (initial.kind !== 'exact' && initial.reason === 'cycle') return initial;
    const candidates = initial.kind === 'exact' ? [initial.value] : initial.candidates || [];
    if (resolved.kind !== 'const') return { candidates, kind: 'unknown', reason: 'mutable-binding' };
    if (writes.get(resolved).length !== 0) return { candidates, kind: 'unknown', reason: 'mutation' };
    if (expression.getStart(sourceFile) < resolved.initializedAt) return { candidates, kind: 'unknown', reason: 'tdz' };
    return initial;
  }

  function sameBinding(node, declaration) {
    const expression = unwrap(node);
    const declared = ts.isIdentifier(declaration) ? binding(declaration) : null;
    return !!declared && ts.isIdentifier(expression) && binding(expression) === declared;
  }

  function importMarker(node) {
    const expression = unwrap(node);
    const resolved = ts.isIdentifier(expression) ? binding(expression) : null;
    return resolved?.selectors.find(selector => selector.kind === 'import') || null;
  }

  function isDirectImport(node, moduleName, importedName, allowTypeOnly = false) {
    const marker = importMarker(node);
    return !!marker && marker.module === moduleName && marker.imported === importedName
      && (allowTypeOnly || !marker.typeOnly);
  }

  function isLocalInterfaceType(typeNode, name, requiredMembers) {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return false;
    const resolved = binding(typeNode.typeName);
    const declaration = resolved?.declaration;
    const exported = declaration?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const members = ts.isInterfaceDeclaration(declaration)
      ? new Set(declaration.members.map(member => propertyName(member.name)).filter(Boolean)) : new Set();
    return !!exported && declaration.parent === sourceFile && declaration.name.text === name
      && requiredMembers.every(member => members.has(member));
  }

  function isImportedTypeRoot(typeNode, moduleName, importedName) {
    let current = typeNode;
    while (current && ts.isIndexedAccessTypeNode(current)) current = current.objectType;
    return !!current && ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)
      && isDirectImport(current.typeName, moduleName, importedName, true);
  }

  function computedKeyType(node) {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) {
      const resolved = binding(expression);
      let type = resolved?.declaration?.type;
      if (type && ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.KeyOfKeyword) type = type.type;
      return type ? { ownerName: enclosingNamedFunction(resolved.declaration),
        stable: writes.get(resolved).length === 0, type } : null;
    }
    if (!ts.isPropertyAccessExpression(expression)) return null;
    const resolved = ts.isIdentifier(unwrap(expression.expression))
      ? binding(unwrap(expression.expression)) : null;
    const declaration = resolved?.declaration;
    const list = declaration && ts.isVariableDeclaration(declaration) ? declaration.parent : null;
    const loop = list && ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent) ? list.parent : null;
    const source = loop && unwrap(loop.expression);
    const sourceBinding = ts.isIdentifier(source) ? binding(source) : null;
    const type = sourceBinding?.declaration?.type;
    return type && ts.isArrayTypeNode(type) ? { ownerName: enclosingNamedFunction(sourceBinding.declaration),
      stable: (writes.get(resolved) || []).length === 0 && (writes.get(sourceBinding) || []).length === 0,
      type: type.elementType } : null;
  }

  function classAncestor(node) {
    let current = node?.parent;
    while (current && !ts.isClassLike(current)) current = current.parent;
    return current || null;
  }

  function typeImportFingerprint(typeNode) {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return null;
    const marker = importMarker(typeNode.typeName);
    return marker ? `${marker.module}:${marker.imported}:${marker.typeOnly ? 'type' : 'value'}` : null;
  }

  function callbackFingerprint(resolved, ownerClass) {
    const parameter = resolved?.declaration;
    const callback = parameter?.parent;
    const call = callback?.parent;
    const member = call && ts.isCallExpression(call) ? unwrap(call.expression) : null;
    const owner = member && ts.isPropertyAccessExpression(member) ? unwrap(member.expression) : null;
    if (!parameter || !ts.isParameter(parameter) || !callback || !isFunction(callback)
      || !member || !ts.isPropertyAccessExpression(member) || !owner
      || !ts.isPropertyAccessExpression(owner) || unwrap(owner.expression).kind !== ts.SyntaxKind.ThisKeyword) return null;
    const property = ownerClass?.members.find(candidate => propertyName(candidate.name) === owner.name.text);
    const type = property && ts.isPropertyDeclaration(property) ? property.type : null;
    if (!type || !ts.isTypeReferenceNode(type) || type.typeArguments?.length !== 1) return null;
    const root = typeImportFingerprint(type);
    const argument = typeImportFingerprint(type.typeArguments[0]);
    const writes = classPropertyWrites(ownerClass, owner.name.text);
    const assignment = writes.length === 1 && ts.isBinaryExpression(writes[0])
      && writes[0].operatorToken.kind === ts.SyntaxKind.EqualsToken ? writes[0] : null;
    const assignmentTarget = assignment && unwrap(assignment.left);
    const assignmentOwner = assignment && functionAncestor(assignment);
    const initializer = assignment && unwrap(assignment.right);
    const constructed = initializer && ts.isNewExpression(initializer) ? importMarker(initializer.expression) : null;
    const constructedType = constructed
      ? `${constructed.module}:${constructed.imported}:${constructed.typeOnly ? 'type' : 'value'}` : null;
    if (!root || !argument || !property.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
      || property.initializer || !assignmentTarget || !ts.isPropertyAccessExpression(assignmentTarget)
      || unwrap(assignmentTarget.expression).kind !== ts.SyntaxKind.ThisKeyword
      || assignmentTarget.name.text !== owner.name.text || !assignmentOwner
      || !ts.isConstructorDeclaration(assignmentOwner)
      || constructedType !== root) return null;
    return [owner.name.text, member.name.text, callback.parameters.indexOf(parameter),
      call.arguments.indexOf(callback), root, argument].join('|');
  }

  function classDeclaresProperty(ownerClass, name) {
    return !!ownerClass && !!name && ownerClass.members.some(member =>
      propertyName(member.name) === name || ts.isConstructorDeclaration(member)
        && member.parameters.some(parameter => propertyName(parameter.name) === name));
  }

  function targetWritesProperty(target, name) {
    let found = false;
    function scan(node) {
      if (found) return;
      const expression = unwrap(node);
      const owner = ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
        ? unwrap(expression.expression) : null;
      const key = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isElementAccessExpression(expression) ? immutableString(expression.argumentExpression) : null;
      if (owner?.kind === ts.SyntaxKind.ThisKeyword && (typeof key === 'string'
        ? key === name : key?.kind === 'exact' && key.value === name)) found = true;
      else ts.forEachChild(expression, scan);
    }
    if (target) scan(target);
    return found;
  }

  function classPropertyWrites(ownerClass, name) {
    if (!ownerClass || !name) return [];
    const writes = [];
    function scan(node) {
      if (node !== ownerClass && ts.isClassLike(node)) return;
      const target = ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)
        ? node.left : ts.isDeleteExpression(node) ? node.expression : null;
      if (targetWritesProperty(target, name)) writes.push(node);
      ts.forEachChild(node, scan);
    }
    scan(ownerClass);
    return writes;
  }

  function classWritesProperty(ownerClass, name) {
    return classPropertyWrites(ownerClass, name).length !== 0;
  }

  function computedDispatch(node) {
    const member = ts.isCallExpression(node) ? unwrap(node.expression) : null;
    if (!member || !ts.isElementAccessExpression(member)) return null;
    const receiver = unwrap(member.expression);
    const receiverBinding = ts.isIdentifier(receiver) ? binding(receiver) : null;
    const parameter = !!receiverBinding && ts.isParameter(receiverBinding.declaration);
    const logger = ts.isPropertyAccessExpression(receiver)
      && receiver.expression.kind === ts.SyntaxKind.ThisKeyword;
    const receiverName = parameter ? receiver.text : logger ? receiver.name.text : null;
    const ownerClass = classAncestor(node);
    const base = ownerClass?.heritageClauses?.find(clause =>
      clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    const baseBinding = base && ts.isIdentifier(base) ? binding(base) : null;
    const ownerBaseImport = baseBinding?.selectors.find(selector => selector.kind === 'import') || null;
    const keyExpression = unwrap(member.argumentExpression);
    const key = computedKeyType(member.argumentExpression);
    return { argument: member.argumentExpression, callbackFingerprint: callbackFingerprint(receiverBinding, ownerClass),
      key,
      keyPropertyName: ts.isPropertyAccessExpression(keyExpression) ? keyExpression.name.text : null,
      keyTypeImport: key?.type && ts.isTypeReferenceNode(key.type) && ts.isIdentifier(key.type.typeName)
        ? importMarker(key.type.typeName) : null,
      ownerBaseImport,
      ownerClassName: ownerClass?.name?.text || null,
      receiverDeclaredInOwner: classDeclaresProperty(ownerClass, receiverName),
      receiverKind: parameter ? 'parameter' : logger ? 'logger' : null,
      receiverName,
      receiverWrittenInOwner: classWritesProperty(ownerClass, receiverName) };
  }

  function functionAncestor(node) {
    let current = node?.parent;
    while (current && !isFunction(current)) current = current.parent;
    return current || null;
  }

  function bindingPatternMentions(node, expected) {
    if (!node) return false;
    const target = unwrap(node);
    if (ts.isIdentifier(target)) return target.text === expected;
    if (ts.isComputedPropertyName(target)) {
      const result = immutableString(target.expression);
      return result.kind === 'exact' ? result.value === expected : true;
    }
    return target.getChildren(sourceFile).some(child => bindingPatternMentions(child, expected));
  }

  return {
    allBindings: () => [...allBindings],
    binding,
    bindingPatternMentions,
    computedDispatch,
    computedKeyType,
    containsMember,
    enclosingNamedFunction,
    calls: () => [...calls],
    functionAncestor,
    immutableString,
    isDirectImport,
    isImportedTypeRoot,
    isLocalInterfaceType,
    isNamedPropertyCall,
    isProperty,
    location,
    memberType,
    propertyName,
    rawSource,
    sameBinding,
    scopeOf: node => scopes.get(node) || null,
    unwrap,
    valueParent,
    writesFor: resolved => [...(writes.get(resolved) || [])],
  };
}

module.exports = { createRpcLexicalResolver };
