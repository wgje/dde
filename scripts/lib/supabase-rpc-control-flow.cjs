'use strict';
const { createRpcLexicalResolver } = require('./supabase-rpc-lexical-binding.cjs');

function createRpcControlFlowAnalyzer(ts, sourceFile) {
  const lexical = ts && sourceFile ? createRpcLexicalResolver(ts, sourceFile) : null;

  function proven(extra = {}) {
    return { ...extra, reasonCode: null, verdict: 'proven' };
  }
  function indeterminate(reasonCode, node = null, extra = {}) {
    return { ...extra, node, reasonCode, verdict: 'indeterminate' };
  }
  function position(node) {
    return node?.getStart ? node.getStart(sourceFile) : Number.MAX_SAFE_INTEGER;
  }
  function isFunction(node) {
    return !!node && ts.isFunctionLike(node) && !!node.body;
  }
  function descendants(node, predicate, result = []) {
    if (!node) return result;
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, child => { descendants(child, predicate, result); });
    return result;
  }
  function staticBoolean(node) {
    const expression = lexical.unwrap(node);
    if (expression?.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression?.kind === ts.SyntaxKind.FalseKeyword) return false;
    return null;
  }
  function statementTerminates(node) {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
    if (ts.isBlock(node)) return node.statements.some(statementTerminates);
    if (!ts.isIfStatement(node)) return false;
    const condition = staticBoolean(node.expression);
    if (condition === true) return statementTerminates(node.thenStatement);
    if (condition === false) return !!node.elseStatement && statementTerminates(node.elseStatement);
    return !!node.elseStatement && statementTerminates(node.thenStatement)
      && statementTerminates(node.elseStatement);
  }
  function executionIsReachable(node, boundary) {
    let child = node;
    let current = node?.parent;
    while (current && current !== boundary) {
      if (ts.isIfStatement(current)) {
        const condition = staticBoolean(current.expression);
        if (condition === false && child === current.thenStatement
          || condition === true && child === current.elseStatement) return false;
      } else if (ts.isConditionalExpression(current)) {
        const condition = staticBoolean(current.condition);
        if (condition === false && child === current.whenTrue
          || condition === true && child === current.whenFalse) return false;
      } else if (ts.isBinaryExpression(current) && child === current.right) {
        const left = staticBoolean(current.left);
        if (left === false && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || left === true && current.operatorToken.kind === ts.SyntaxKind.BarBarToken) return false;
      }
      if (ts.isBlock(current) || ts.isSourceFile(current)
        || ts.isCaseBlock(current) || ts.isCaseClause(current) || ts.isDefaultClause(current)) {
        const statements = current.statements || [];
        const index = statements.indexOf(child);
        if (index >= 0 && statements.slice(0, index).some(statementTerminates)) return false;
      }
      child = current;
      current = current.parent;
    }
    return current === boundary;
  }
  function writeValue(write, resolved) {
    if (!ts.isBinaryExpression(write) || write.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
    const target = lexical.unwrap(write.left);
    return ts.isIdentifier(target) && lexical.binding(target) === resolved
      ? lexical.unwrap(write.right) : null;
  }
  function controlArm(node, boundary) {
    const frames = [];
    let child = node;
    let current = node?.parent;
    while (current && current !== boundary) {
      if (ts.isIfStatement(current)) {
        frames.push({ arm: child === current.thenStatement ? 'then' : 'else', owner: current });
      } else if (ts.isConditionalExpression(current)) {
        frames.push({ arm: child === current.whenTrue ? 'then' : 'else', owner: current });
      } else if (ts.isBinaryExpression(current) && child === current.right
        && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken].includes(current.operatorToken.kind)) {
        frames.push({ arm: 'short-circuit', owner: current });
      } else if (ts.isCaseClause(current) || ts.isDefaultClause(current)) {
        frames.push({ arm: 'case', owner: current });
      } else if (ts.isForStatement(current) || ts.isForInStatement(current)
        || ts.isForOfStatement(current) || ts.isWhileStatement(current)
        || ts.isDoStatement(current)) {
        frames.push({ arm: 'loop', owner: current });
      } else if (ts.isCatchClause(current)) {
        frames.push({ arm: 'catch', owner: current.parent });
      } else if (ts.isTryStatement(current)) {
        const arm = child === current.tryBlock ? 'try'
          : child === current.finallyBlock ? 'finally' : 'catch';
        frames.push({ arm, owner: current });
      }
      child = current;
      current = current.parent;
    }
    return current === boundary ? frames : null;
  }
  function dominanceEvidence(definition, use, boundary = lexical.functionAncestor(use)) {
    if (!definition || !use || !boundary || position(definition) >= position(use)) {
      return indeterminate('CFG_DEFINITION_NOT_BEFORE_USE', use);
    }
    if (!executionIsReachable(definition, boundary) || !executionIsReachable(use, boundary)) {
      return indeterminate('CFG_NODE_UNREACHABLE', use);
    }
    const definitionFrames = controlArm(definition, boundary);
    const useFrames = controlArm(use, boundary);
    if (!definitionFrames || !useFrames) return indeterminate('CFG_BOUNDARY_UNKNOWN', use);
    for (const frame of definitionFrames) {
      if (!useFrames.some(candidate => candidate.owner === frame.owner && candidate.arm === frame.arm)) {
        return indeterminate('CFG_DEFINITION_DOES_NOT_DOMINATE', definition);
      }
    }
    return proven({ definition, use });
  }
  function callTarget(call, seen = new Set()) {
    const callee = lexical.unwrap(call.expression);
    if (isFunction(callee)) return callee;
    if (ts.isIdentifier(callee)) {
      const resolved = lexical.binding(callee);
      if (!resolved || seen.has(resolved) || position(call) < resolved.initializedAt) return null;
      seen.add(resolved);
      if (lexical.writesFor(resolved).some(write => position(write) < position(call))) return null;
      const source = lexical.rawSource(resolved)?.expression;
      return isFunction(source) ? source : isFunction(resolved.declaration) ? resolved.declaration : null;
    }
    if (!ts.isPropertyAccessExpression(callee)
      || lexical.unwrap(callee.expression).kind !== ts.SyntaxKind.ThisKeyword) return null;
    let owner = call.parent;
    while (owner && !ts.isClassLike(owner)) owner = owner.parent;
    return owner?.members.find(member => isFunction(member)
      && lexical.propertyName(member.name) === callee.name.text) || null;
  }
  function functionEscapes(target) {
    const declarationName = target.name && ts.isIdentifier(target.name) ? target.name
      : ts.isVariableDeclaration(target.parent) && target.parent.initializer === target
        && ts.isIdentifier(target.parent.name) ? target.parent.name : null;
    const binding = declarationName ? lexical.binding(declarationName) : null;
    if (!binding) return false;
    let escaped = false;
    function visit(node) {
      if (escaped || node === declarationName) return;
      if (ts.isIdentifier(node) && lexical.binding(node) === binding) {
        const parent = lexical.valueParent(node);
        if (!(ts.isCallExpression(parent) && parent.expression === node)) escaped = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return escaped;
  }
  function isReachable(node, entry, activate, active = new Set()) {
    if (node === entry) return true;
    const owner = lexical.functionAncestor(node);
    if (!owner || !executionIsReachable(node, owner)) return false;
    if (owner === entry) return true;
    if (active.has(owner) || functionEscapes(owner)) return false;
    active.add(owner);
    return lexical.calls().some(call => {
      const activated = callTarget(call) === owner
        || !!activate && call.arguments.some(argument => lexical.unwrap(argument) === owner)
          && activate(call, owner);
      return activated && isReachable(call, entry, activate, new Set(active));
    });
  }
  function aliasesOf(resolved) {
    const aliases = new Set([resolved]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of lexical.allBindings()) {
        const source = lexical.rawSource(candidate);
        const expression = source && lexical.unwrap(source.expression);
        if (expression && ts.isIdentifier(expression) && aliases.has(lexical.binding(expression)) && !aliases.has(candidate)) {
          aliases.add(candidate);
          changed = true;
        }
      }
    }
    return aliases;
  }
  function arrayIsStable(resolved, use) {
    const aliases = aliasesOf(resolved);
    for (const alias of aliases) {
      if (lexical.writesFor(alias).some(write => position(write) < position(use))) return false;
    }
    for (const call of lexical.calls()) {
      if (position(call) >= position(use)) continue;
      const callee = lexical.unwrap(call.expression);
      if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        const receiver = lexical.unwrap(callee.expression);
        if (ts.isIdentifier(receiver) && aliases.has(lexical.binding(receiver))) return false;
      }
      if (call.arguments.some(argument => {
        let found = false;
        function visit(node) {
          if (found) return;
          if (ts.isIdentifier(node) && aliases.has(lexical.binding(node))) found = true;
          else ts.forEachChild(node, visit);
        }
        visit(argument);
        return found;
      })) return false;
    }
    return true;
  }
  function selectArrayElement(node, index, use, seen = new Set()) {
    const expression = lexical.unwrap(node);
    if (ts.isArrayLiteralExpression(expression)) {
      if (expression.elements.some(ts.isSpreadElement)) return { kind: 'unknown', reason: 'spread' };
      const element = expression.elements[index];
      return element && !ts.isOmittedExpression(element)
        ? { expression: lexical.unwrap(element), kind: 'expression' }
        : { kind: 'unknown', reason: 'hole' };
    }
    if (!ts.isIdentifier(expression)) return { kind: 'unknown', reason: 'dynamic-array' };
    const resolved = lexical.binding(expression);
    if (!resolved || seen.has(resolved)) return { kind: 'unknown', reason: 'cycle' };
    if (position(use) < resolved.initializedAt || !arrayIsStable(resolved, use)) {
      return { kind: 'unknown', reason: 'mutation' };
    }
    seen.add(resolved);
    const source = lexical.rawSource(resolved);
    if (!source || source.selectors.some(selector => selector.kind !== 'import')) {
      return { kind: 'unknown', reason: 'selector' };
    }
    return selectArrayElement(source.expression, index, use, seen);
  }
  function mergeCandidates(...results) {
    const candidates = results.flatMap(result => result.kind === 'exact'
      ? [result.value] : result.candidates || []);
    return { candidates: [...new Set(candidates)], complete: results.every(result => result.kind === 'exact'
      || result.complete === true), kind: 'unknown', reason: 'conditional' };
  }
  function evaluateString(node, seen = new Set()) {
    const expression = lexical.unwrap(node);
    if (!expression) return { candidates: [], kind: 'unknown', reason: 'missing' };
    const immutable = lexical.immutableString(expression, new Set(seen));
    if (immutable.kind === 'exact' || immutable.reason === 'cycle') return immutable;
    if (ts.isConditionalExpression(expression)) {
      const left = evaluateString(expression.whenTrue, new Set(seen));
      const right = evaluateString(expression.whenFalse, new Set(seen));
      return left.kind === 'exact' && right.kind === 'exact' && left.value === right.value
        ? left : mergeCandidates(left, right);
    }
    if (ts.isElementAccessExpression(expression)) {
      const key = evaluateString(expression.argumentExpression, seen);
      const index = key.kind === 'exact' && /^(?:0|[1-9][0-9]*)$/.test(key.value)
        ? Number(key.value) : null;
      if (index === null) return { ...mergeCandidates(key), complete: false };
      const selected = selectArrayElement(expression.expression, index, expression, seen);
      return selected.kind === 'expression'
        ? evaluateString(selected.expression, seen) : selected;
    }
    return immutable;
  }
  function bindingPatternMentions(node, expected) {
    if (!node) return false;
    const target = lexical.unwrap(node);
    if (ts.isIdentifier(target)) return target.text === expected;
    if (ts.isComputedPropertyName(target) || ts.isElementAccessExpression(target)) {
      const computed = ts.isComputedPropertyName(target);
      const value = evaluateString(computed ? target.expression : target.argumentExpression);
      if (value.kind === 'exact') return value.value === expected;
      if (value.candidates?.includes(expected) || computed && value.complete !== true) return true;
    }
    return target.getChildren(sourceFile).some(child => bindingPatternMentions(child, expected));
  }

  function definitionForUse(resolved, use) {
    const candidates = [];
    const source = lexical.rawSource(resolved);
    if (source) candidates.push({ node: resolved.declaration, value: source.expression });
    for (const write of lexical.writesFor(resolved)) {
      const value = position(write) < position(use) ? writeValue(write, resolved) : undefined;
      if (value) candidates.push({ node: write, value });
      else if (value === null && executionIsReachable(write, lexical.functionAncestor(use))) return null;
    }
    const dominating = candidates.filter(candidate =>
      dominanceEvidence(candidate.node, use).verdict === 'proven'
    );
    if (dominating.length === 0) return null;
    const selected = dominating.sort((left, right) => position(right.node) - position(left.node))[0];
    const laterUnknown = candidates.some(candidate => position(candidate.node) > position(selected.node)
      && dominanceEvidence(candidate.node, use).verdict !== 'proven');
    return laterUnknown ? null : selected.value;
  }

  function functionReturnsFrom(target, origin, allowCall, seen) {
    if (functionEscapes(target)) return false;
    if (!ts.isBlock(target.body)) return flowsFrom(target.body, origin, allowCall, new Set(seen));
    const returns = descendants(target.body, node => ts.isReturnStatement(node)
      && lexical.functionAncestor(node) === target);
    if (returns.length === 0 || !returns.every(statement => statement.expression
      && flowsFrom(statement.expression, origin, allowCall, new Set(seen)))) return false;
    function canFallThrough(node) {
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return false;
      if (ts.isBlock(node)) {
        for (const statement of node.statements) if (!canFallThrough(statement)) return false;
        return true;
      }
      if (!ts.isIfStatement(node)) return true;
      const condition = staticBoolean(node.expression);
      if (condition === true) return canFallThrough(node.thenStatement);
      if (condition === false) return node.elseStatement ? canFallThrough(node.elseStatement) : true;
      return canFallThrough(node.thenStatement)
        || !node.elseStatement || canFallThrough(node.elseStatement);
    }
    return !canFallThrough(target.body);
  }
  function flowsFrom(node, origin, allowCall, seen = new Set()) {
    const expression = lexical.unwrap(node);
    const target = lexical.unwrap(origin);
    if (!expression || !target) return false;
    if (expression === target) return true;
    if (ts.isAwaitExpression(expression)) return flowsFrom(expression.expression, target, allowCall, seen);
    if (ts.isConditionalExpression(expression)) {
      return flowsFrom(expression.whenTrue, target, allowCall, new Set(seen))
        && flowsFrom(expression.whenFalse, target, allowCall, new Set(seen));
    }
    if (ts.isIdentifier(expression)) {
      const resolved = lexical.binding(expression);
      if (!resolved || seen.has(resolved) || position(expression) < resolved.initializedAt) return false;
      seen.add(resolved);
      const source = lexical.rawSource(resolved);
      if (!source) return false;
      let selected = { expression: source.expression, kind: 'expression' };
      for (const selector of source.selectors) {
        if (selector.kind === 'import') continue;
        if (selector.kind !== 'array') return false;
        selected = selectArrayElement(selected.expression, selector.key, expression, seen);
        if (selected.kind !== 'expression') return false;
      }
      if (lexical.writesFor(resolved).length !== 0) {
        const reaching = definitionForUse(resolved, expression);
        if (!reaching) return false;
        selected = { expression: reaching, kind: 'expression' };
      }
      return flowsFrom(selected.expression, target, allowCall, seen);
    }
    if (ts.isElementAccessExpression(expression)) {
      const key = evaluateString(expression.argumentExpression);
      const index = key.kind === 'exact' && /^(?:0|[1-9][0-9]*)$/.test(key.value)
        ? Number(key.value) : null;
      if (index === null) return false;
      const selected = selectArrayElement(expression.expression, index, expression);
      return selected.kind === 'expression' && flowsFrom(selected.expression, target, allowCall, seen);
    }
    if (!ts.isCallExpression(expression)) return false;
    const callee = lexical.unwrap(expression.expression);
    const receiver = (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      ? callee.expression : null;
    if (receiver && allowCall?.(expression, () => flowsFrom(receiver, target, allowCall, new Set(seen)))) return true;
    const localTarget = callTarget(expression);
    return !!localTarget && functionReturnsFrom(localTarget, target, allowCall, seen);
  }

  function observedExecution(origin, entry, allowCall, activate) {
    return descendants(entry.body, node => ts.isReturnStatement(node)
      || ts.isAwaitExpression(node) && !ts.isExpressionStatement(lexical.valueParent(node)))
      .some(observation => lexical.functionAncestor(observation) === entry
        && isReachable(observation, entry, activate)
        && !!observation.expression
        && flowsFrom(observation.expression, origin, allowCall));
  }

  function importedFactoryEvidence(node, proof, seen = new Set()) {
    let expression = lexical.unwrap(node);
    if (ts.isAwaitExpression(expression)) expression = lexical.unwrap(expression.expression);
    if (ts.isIdentifier(expression)) {
      const resolved = lexical.binding(expression);
      if (!resolved || seen.has(resolved) || lexical.writesFor(resolved).length !== 0) {
        return indeterminate('FACTORY_BINDING_MUTABLE', expression);
      }
      seen.add(resolved);
      const source = lexical.rawSource(resolved);
      return source ? importedFactoryEvidence(source.expression, proof, seen)
        : indeterminate('FACTORY_SOURCE_UNKNOWN', expression);
    }
    if (!ts.isCallExpression(expression)) return indeterminate('FACTORY_CALL_UNKNOWN', expression);
    if (lexical.isDirectImport(expression.expression, proof.module, proof.imported)) {
      return proven({ call: expression });
    }
    const callee = lexical.unwrap(expression.expression);
    const resolved = ts.isIdentifier(callee) ? lexical.binding(callee) : null;
    const target = resolved?.declaration;
    if (!target || !isFunction(target) || lexical.propertyName(target.name) !== proof.localFactory) {
      return indeterminate('FACTORY_PROVENANCE_UNKNOWN', expression);
    }
    const returns = descendants(target.body, candidate => ts.isReturnStatement(candidate)
      && lexical.functionAncestor(candidate) === target);
    if (returns.length === 0) return indeterminate('FACTORY_RETURN_MISSING', target);
    const results = returns.map(statement => statement.expression
      ? importedFactoryEvidence(statement.expression, { ...proof, localFactory: null }, new Set(seen))
      : indeterminate('FACTORY_RETURN_UNKNOWN', statement));
    return results.every(result => result.verdict === 'proven')
      ? proven({ call: expression }) : results.find(result => result.verdict !== 'proven');
  }

  function injectedFieldEvidence(sink, fieldName) {
    let owner = sink.parent;
    while (owner && !ts.isClassLike(owner)) owner = owner.parent;
    const field = owner?.members.find(member => ts.isPropertyDeclaration(member)
      && lexical.propertyName(member.name) === fieldName);
    const initializer = field?.initializer && lexical.unwrap(field.initializer);
    if (!field || !initializer || !ts.isCallExpression(initializer)) {
      return indeterminate('INJECTED_FIELD_UNKNOWN', sink);
    }
    return proven({ field, initializer, owner });
  }

  function rejectsNull(node, resolved) {
    const expression = lexical.unwrap(node);
    if (ts.isPrefixUnaryExpression(expression)
      && expression.operator === ts.SyntaxKind.ExclamationToken) {
      const value = lexical.unwrap(expression.operand);
      return ts.isIdentifier(value) && lexical.binding(value) === resolved;
    }
    return ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      && (rejectsNull(expression.left, resolved) || rejectsNull(expression.right, resolved));
  }

  function isUnconditionalReturn(node) {
    if (ts.isReturnStatement(node)) return true;
    return ts.isBlock(node) && node.statements.length === 1 && ts.isReturnStatement(node.statements[0]);
  }

  function nullGuardEvidence(identifier, sink, resolved) {
    const owner = lexical.functionAncestor(sink);
    if (!owner?.body || !ts.isBlock(owner.body)) return indeterminate('CAPTURED_GUARD_UNKNOWN', sink);
    const guard = owner.body.statements.find(statement => position(statement) < position(sink)
      && ts.isIfStatement(statement) && rejectsNull(statement.expression, resolved)
      && isUnconditionalReturn(statement.thenStatement));
    return guard && dominanceEvidence(guard, sink, owner).verdict === 'proven'
      ? proven({ guard }) : indeterminate('CAPTURED_NULL_GUARD_MISSING', identifier);
  }

  function capturedReceiverEvidence(identifier, sink, authoritativeValue) {
    const resolved = lexical.binding(identifier);
    const owner = lexical.functionAncestor(sink);
    if (!resolved || !owner) return indeterminate('CAPTURED_BINDING_UNKNOWN', identifier);
    const guard = nullGuardEvidence(identifier, sink, resolved);
    if (guard.verdict !== 'proven') return guard;
    const writes = lexical.writesFor(resolved).map(write => ({ write, value: writeValue(write, resolved) }));
    if (writes.length !== 1 || !writes[0].value) {
      return indeterminate('CAPTURED_DEFINITION_AMBIGUOUS', identifier);
    }
    const authority = authoritativeValue(writes[0].value);
    if (authority.verdict !== 'proven') return authority;
    const writeOwner = lexical.functionAncestor(writes[0].write);
    const sinkContainer = lexical.functionAncestor(owner);
    if (!writeOwner || writeOwner !== sinkContainer) {
      return indeterminate('CAPTURED_WRITE_CLOSURE_UNKNOWN', writes[0].write);
    }
    if (!executionIsReachable(writes[0].write, writeOwner)) {
      return indeterminate('CAPTURED_WRITE_UNREACHABLE', writes[0].write);
    }
    const writeFrames = controlArm(writes[0].write, writeOwner);
    if (!writeFrames || writeFrames.some(frame => !['try'].includes(frame.arm))) {
      return indeterminate('CAPTURED_WRITE_CONDITIONAL', writes[0].write);
    }
    const activations = lexical.calls().filter(call => callTarget(call) === owner
      && executionIsReachable(call, sinkContainer));
    if (activations.length === 0 || functionEscapes(owner)) {
      return indeterminate('CAPTURED_ACTIVATION_UNKNOWN', owner);
    }
    const beforeActivation = activations.every(call => position(writes[0].write) < position(call));
    return beforeActivation ? proven({ activations, guard: guard.guard, write: writes[0].write })
      : indeterminate('CAPTURED_WRITE_AFTER_ACTIVATION', writes[0].write);
  }

  function injectedReceiverEvidence(receiver, sink, proof) {
    let expression = lexical.unwrap(receiver);
    if (ts.isIdentifier(expression)) {
      const resolved = lexical.binding(expression);
      const source = resolved && lexical.rawSource(resolved);
      if (!source || lexical.writesFor(resolved).length !== 0) {
        return indeterminate('INJECTED_RECEIVER_MUTABLE', expression);
      }
      expression = lexical.unwrap(source.expression);
      if (ts.isAwaitExpression(expression)) expression = lexical.unwrap(expression.expression);
    }
    if (!ts.isCallExpression(expression)) return indeterminate('INJECTED_RECEIVER_UNKNOWN', expression);
    const member = lexical.unwrap(expression.expression);
    if (!ts.isPropertyAccessExpression(member) || member.name.text !== proof.method) {
      return indeterminate('INJECTED_CLIENT_METHOD_UNKNOWN', expression);
    }
    const owner = lexical.unwrap(member.expression);
    if (!ts.isPropertyAccessExpression(owner) || owner.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      return indeterminate('INJECTED_OWNER_UNKNOWN', owner);
    }
    const field = injectedFieldEvidence(sink, owner.name.text);
    if (field.verdict !== 'proven') return field;
    return lexical.isDirectImport(field.initializer.expression, proof.injectModule, proof.injectImported)
      && lexical.isDirectImport(field.initializer.arguments[0], proof.tokenModule, proof.token)
      ? proven({ field: field.field }) : indeterminate('INJECTED_TOKEN_PROVENANCE_UNKNOWN', field.field);
  }

  function providerReceiverEvidence(receiver, sink, proof) {
    if (!ts.isIdentifier(receiver)) return indeterminate('PROVIDER_RECEIVER_UNKNOWN', receiver);
    const client = lexical.binding(receiver);
    const source = client && lexical.rawSource(client);
    if (!source || client.kind !== 'const' || lexical.writesFor(client).length !== 0) {
      return indeterminate('PROVIDER_CLIENT_AUTHORITY_UNKNOWN', receiver);
    }
    let expression = source && lexical.unwrap(source.expression);
    if (ts.isAwaitExpression(expression)) expression = lexical.unwrap(expression.expression);
    if (!ts.isCallExpression(expression)) return indeterminate('PROVIDER_CLIENT_FLOW_UNKNOWN', receiver);
    const member = lexical.unwrap(expression.expression);
    const provider = ts.isPropertyAccessExpression(member) ? lexical.unwrap(member.expression) : null;
    const providerBinding = ts.isIdentifier(provider) ? lexical.binding(provider) : null;
    if (!providerBinding || !ts.isParameter(providerBinding.declaration)
      || lexical.writesFor(providerBinding).length !== 0 || member.name.text !== proof.getClient) {
      return indeterminate('PROVIDER_CLIENT_AUTHORITY_UNKNOWN', receiver);
    }
    const callback = lexical.functionAncestor(sink);
    const activation = callback?.parent;
    const activationMember = ts.isCallExpression(activation) ? lexical.unwrap(activation.expression) : null;
    const activationOwner = ts.isPropertyAccessExpression(activationMember)
      ? lexical.unwrap(activationMember.expression) : null;
    let observed = activation;
    while (observed && (ts.isAwaitExpression(observed.parent) || ts.isParenthesizedExpression(observed.parent))) {
      observed = observed.parent;
    }
    const active = !!callback && ts.isCallExpression(activation) && activation.arguments.includes(callback)
      && ts.isPropertyAccessExpression(activationMember) && activationMember.name.text === proof.activate
      && ts.isIdentifier(activationOwner) && lexical.binding(activationOwner) === providerBinding
      && activation.arguments.length === 2 && activation.arguments[1] === callback
      && (ts.isReturnStatement(observed.parent) || ts.isVariableDeclaration(observed.parent));
    return active ? proven({ activation, providerBinding })
      : indeterminate('PROVIDER_CALLBACK_ACTIVATION_UNKNOWN', callback || sink);
  }

  function receiverEvidence(receiver, sink, proof) {
    const expression = lexical.unwrap(receiver);
    if (proof.kind === 'parameter') {
      const resolved = ts.isIdentifier(expression) ? lexical.binding(expression) : null;
      const valid = !!resolved && ts.isParameter(resolved.declaration)
        && resolved.declaration.type?.getText() === proof.type && lexical.writesFor(resolved).length === 0;
      return valid ? proven({ binding: resolved }) : indeterminate('PARAMETER_RECEIVER_UNKNOWN', expression);
    }
    if (proof.kind === 'factory') return importedFactoryEvidence(expression, proof);
    if (proof.kind === 'injected') return injectedReceiverEvidence(expression, sink, proof);
    if (proof.kind === 'provider') return providerReceiverEvidence(expression, sink, proof);
    if (proof.kind === 'captured') return ts.isIdentifier(expression)
      ? capturedReceiverEvidence(expression, sink, value => importedFactoryEvidence(value, proof))
      : indeterminate('CAPTURED_RECEIVER_UNKNOWN', expression);
    return indeterminate('RECEIVER_PROOF_KIND_UNKNOWN', expression);
  }

  function transportEvidence(serviceClass, method, options) {
    const sinkCalls = [];
    const clientCalls = [];
    let issue = null;
    function scan(node) {
      if (issue) return;
      const update = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
        ? node.operand : null;
      const target = ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)
        ? node.left : update || (ts.isForInStatement(node) || ts.isForOfStatement(node) ? node.initializer : null);
      const declaration = ts.isVariableDeclaration(node) || ts.isParameter(node)
        || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ? node.name : null;
      if ([declaration, target].some(candidate => options.parameterNames.some(name =>
        bindingPatternMentions(candidate, name)))) {
        issue = indeterminate('TRANSPORT_PARAMETER_MUTATION', declaration || target);
        return;
      }
      if (lexical.isNamedPropertyCall(node, options.sinkName)) sinkCalls.push(node);
      if (lexical.isNamedPropertyCall(node, options.clientName)) clientCalls.push(node);
      ts.forEachChild(node, scan);
    }
    scan(method.body);
    if (issue) return issue;
    if (sinkCalls.length !== 1) return indeterminate('TRANSPORT_SINK_COUNT_INVALID', method);
    const sink = sinkCalls[0];
    if (!isReachable(sink, method) || !options.validateSink(sink)) {
      return indeterminate('TRANSPORT_SINK_INVALID', sink);
    }
    const origins = clientCalls.filter(call => isReachable(call, method) && options.isClientOrigin(call));
    const member = lexical.unwrap(sink.expression);
    const receiver = ts.isPropertyAccessExpression(member) ? lexical.unwrap(member.expression) : null;
    if (origins.length !== 1 || !flowsFrom(receiver, origins[0])
      || !observedExecution(sink, method, options.allowBuilderCall)) {
      return indeterminate('TRANSPORT_EXECUTION_UNOBSERVED', sink);
    }
    const literalCalls = [];
    function visit(node, entry) {
      if (issue) return;
      if (entry && !isReachable(node, entry)) {
        if (lexical.containsMember(node, options.memberName)) {
          issue = indeterminate('TRANSPORT_EXECUTION_UNOBSERVED', node);
        }
        return;
      }
      const aliasTarget = ts.isVariableDeclaration(node) || ts.isParameter(node) ? node.name
        : ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind) ? node.left
          : ts.isForInStatement(node) || ts.isForOfStatement(node) ? node.initializer : null;
      if (bindingPatternMentions(aliasTarget, options.memberName)) {
        issue = indeterminate('TRANSPORT_ALIAS_AMBIGUOUS', aliasTarget);
        return;
      }
      const element = ts.isElementAccessExpression(node) ? evaluateString(node.argumentExpression) : null;
      const namedElement = element && (element.kind === 'exact' ? element.value === options.memberName
        : element.reason === 'cycle' || element.candidates?.includes(options.memberName));
      if (((ts.isPropertyAccessExpression(node) && node.name.text === options.memberName) || namedElement)
        && (namedElement || lexical.unwrap(node.expression).kind !== ts.SyntaxKind.ThisKeyword
          || !(ts.isCallExpression(node.parent) && node.parent.expression === node))) {
        issue = indeterminate('TRANSPORT_ALIAS_AMBIGUOUS', node);
        return;
      }
      if (options.isMemberCall(node)) {
        if (node.arguments.length < options.minArgs || node.arguments.length > options.maxArgs
          || node.arguments.some(ts.isSpreadElement)) {
          issue = indeterminate('TRANSPORT_CALLER_ARITY', node);
          return;
        }
        const value = evaluateString(node.arguments[0]);
        if (value.kind !== 'exact') {
          issue = indeterminate('TRANSPORT_CALLER_NAME_DYNAMIC', node.arguments[0] || node);
          return;
        }
        literalCalls.push({ call: node, name: value.value, nameNode: node.arguments[0] });
      }
      ts.forEachChild(node, child => visit(child, entry));
    }
    for (const memberNode of serviceClass.members) {
      if (memberNode !== method) visit(memberNode, ts.isMethodDeclaration(memberNode) ? memberNode : null);
    }
    return issue || proven({ literalCalls, sink });
  }

  function exactThisCall(node, methodName) {
    let expression = node && lexical.unwrap(node);
    if (ts.isAwaitExpression(expression)) expression = lexical.unwrap(expression.expression);
    if (!ts.isCallExpression(expression)) return null;
    const member = lexical.unwrap(expression.expression);
    return ts.isPropertyAccessExpression(member)
      && member.expression.kind === ts.SyntaxKind.ThisKeyword
      && member.name.text === methodName ? expression : null;
  }

  function providerFactoryEvidence(owner, spec) {
    const member = name => owner?.members.find(candidate => lexical.propertyName(candidate.name) === name);
    const provider = member(spec.providerMethod);
    const result = provider?.body?.statements.find(ts.isReturnStatement)?.expression;
    const object = result && lexical.unwrap(result);
    if (!owner || !ts.isMethodDeclaration(provider) || !ts.isObjectLiteralExpression(object)
      || object.properties.length !== 2) {
      return indeterminate('PROJECT_PROVIDER_FACTORY_INVALID', provider || owner);
    }
    const property = name => object.properties.find(candidate => lexical.propertyName(candidate.name) === name);
    const clientInitializer = property(spec.clientProperty)?.initializer;
    const retryInitializer = property(spec.retryProperty)?.initializer;
    const clientCall = ts.isArrowFunction(clientInitializer)
      ? exactThisCall(clientInitializer.body, spec.getClientMethod) : null;
    const retryCall = ts.isArrowFunction(retryInitializer)
      ? exactThisCall(retryInitializer.body, spec.retryMethod) : null;
    if (provider.body.statements.length !== 1 || !ts.isReturnStatement(provider.body.statements[0])
      || !clientCall || clientCall.arguments.length !== 0 || !retryCall
      || retryInitializer.parameters.length !== 2 || retryCall.arguments.length !== 2
      || !lexical.sameBinding(retryCall.arguments[0], retryInitializer.parameters[0].name)
      || !lexical.sameBinding(retryCall.arguments[1], retryInitializer.parameters[1].name)) {
      return indeterminate('PROJECT_PROVIDER_FACTORY_INVALID', provider);
    }
    return proven({ clientCall, provider, retryCall });
  }

  function methodCallEvidence(owner, spec) {
    const method = owner?.members.find(candidate => ts.isMethodDeclaration(candidate)
      && lexical.propertyName(candidate.name) === spec.methodName);
    if (!method?.body) return indeterminate('PROJECT_PROVIDER_CALLER_INVALID', method || owner);
    const returns = descendants(method.body, candidate => ts.isReturnStatement(candidate)
      && lexical.functionAncestor(candidate) === method);
    if (method.body.statements.length !== 1 || returns.length !== 1 || !returns[0].expression) {
      return indeterminate('PROJECT_PROVIDER_CALLER_INVALID', method);
    }
    let expression = lexical.unwrap(returns[0].expression);
    if (ts.isAwaitExpression(expression)) expression = lexical.unwrap(expression.expression);
    const call = ts.isCallExpression(expression) ? expression : null;
    const member = call && lexical.unwrap(call.expression);
    const receiver = ts.isPropertyAccessExpression(member) ? lexical.unwrap(member.expression) : null;
    const exactReceiver = ts.isPropertyAccessExpression(receiver)
      && receiver.expression.kind === ts.SyntaxKind.ThisKeyword
      && receiver.name.text === spec.receiverField;
    if (!call || !ts.isPropertyAccessExpression(member) || !exactReceiver
      || member.name.text !== spec.delegateName) {
      return indeterminate('PROJECT_PROVIDER_CALLER_INVALID', call || expression || method);
    }
    if (call.arguments.length !== spec.forwardedParameters.length + 1) {
      return indeterminate('PROJECT_PROVIDER_CALLER_INVALID', call);
    }
    for (let index = 0; index < spec.forwardedParameters.length; index += 1) {
      const parameter = method.parameters[spec.forwardedParameters[index]];
      if (!parameter || !lexical.sameBinding(call.arguments[index], parameter.name)) {
        return indeterminate('PROJECT_PROVIDER_CALLER_INVALID', call.arguments[index] || call);
      }
    }
    const providerCall = exactThisCall(call.arguments.at(-1), spec.providerMethod);
    return providerCall && providerCall.arguments.length === 0
      ? proven({ call, method, providerCall })
      : indeterminate('PROJECT_PROVIDER_CALLER_INVALID', call);
  }

  function sqlEventContextEvidence(masked, events) {
    const unsupported = /\b(?:case|goto|return|exit|raise|exception)\b/i.test(masked);
    const tokens = [];
    const expression = /\bend\s+if\b|\belsif\b[\s\S]*?\bthen\b|\belse\b|\bif\b[\s\S]*?\bthen\b|\bend\s+loop\b|\b(?:for|while)\b[\s\S]*?\bloop\b|\bloop\b|\bexception\b/gi;
    let match;
    while ((match = expression.exec(masked))) tokens.push({ index: match.index, text: match[0] });
    const classified = events.map(event => {
      const stack = [];
      for (const token of tokens) {
        if (token.index >= event.index) break;
        if (/^end\s+if/i.test(token.text)) stack.pop();
        else if (/^elsif\b/i.test(token.text)) {
          const frame = stack.at(-1);
          if (frame?.kind !== 'if') stack.push({ context: 'indeterminate', kind: 'unknown' });
          else {
            const condition = token.text.replace(/^elsif\s+/i, '').replace(/\s+then$/i, '').trim();
            frame.context = frame.matched === 'yes' ? 'dead'
              : frame.matched === 'maybe' ? 'indeterminate'
                : /^false$/i.test(condition) ? 'dead'
                  : /^true$/i.test(condition) ? 'must' : 'indeterminate';
            frame.matched = frame.matched === 'yes' || /^true$/i.test(condition) ? 'yes'
              : frame.matched === 'maybe' || !/^false$/i.test(condition) ? 'maybe' : 'no';
          }
        }
        else if (/^else$/i.test(token.text)) {
          const frame = stack.at(-1);
          if (frame?.kind === 'if') {
            frame.context = frame.matched === 'no' ? 'must'
              : frame.matched === 'yes' ? 'dead' : 'indeterminate';
            frame.matched = 'yes';
          }
        } else if (/^if\b/i.test(token.text)) {
          const condition = token.text.replace(/^if\s+/i, '').replace(/\s+then$/i, '').trim();
          const exactTrue = /^true$/i.test(condition);
          const exactFalse = /^false$/i.test(condition);
          stack.push({ context: exactFalse ? 'dead' : exactTrue ? 'must' : 'indeterminate',
            kind: 'if', matched: exactTrue ? 'yes' : exactFalse ? 'no' : 'maybe' });
        } else if (/^end\s+loop/i.test(token.text)) stack.pop();
        else if (/^exception$/i.test(token.text)) stack.push({ context: 'indeterminate', kind: 'exception' });
        else stack.push({ context: 'indeterminate', kind: 'loop' });
      }
      const contexts = stack.map(frame => frame.context);
      const context = contexts.includes('dead') ? 'dead'
        : unsupported || contexts.includes('indeterminate') ? 'indeterminate' : 'must';
      return { ...event, context };
    });
    return proven({ events: classified });
  }

  if (!lexical) return { sqlEventContextEvidence };
  return {
    facts: lexical,
    dominanceEvidence,
    methodCallEvidence,
    providerFactoryEvidence,
    reachabilityEvidence: (node, entry, activate) => isReachable(node, entry, activate)
      ? proven({ node }) : indeterminate('CFG_NODE_UNREACHABLE', node),
    receiverEvidence,
    sqlEventContextEvidence,
    stringEvidence: evaluateString,
    transportEvidence,
    valueFlowEvidence: (node, origin, allowCall) => flowsFrom(node, origin, allowCall)
      ? proven({ node, origin }) : indeterminate('CFG_VALUE_FLOW_UNKNOWN', node),
  };
}

module.exports = { createRpcControlFlowAnalyzer };
