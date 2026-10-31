'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createRpcControlFlowAnalyzer } = require('./supabase-rpc-control-flow.cjs');
const TEST_SEGMENTS = new Set([
  '__tests__',
  'fixture',
  'fixtures',
  'harness',
  'harnesses',
  'mock',
  'mocks',
  'stub',
  'stubs',
  'test',
  'tests',
]);
const SOURCE_EXTENSION = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i;
const TEST_FILE = /\.(?:spec|test)(?:[-.][^/]*)?\.(?:cjs|js|jsx|mjs|ts|tsx)$/i;
const TEST_ROLE_FILE = /\.(?:fixtures?|harness(?:es)?|mocks?|stubs?)(?:[-.][^/]*)?\.(?:cjs|js|jsx|mjs|ts|tsx)$/i;
function normalizePath(filePath) { return filePath.replace(/\\/g, '/').replace(/^\.\//, ''); }
function isRpcCoverageRuntimeFile(filePath) {
  const normalized = normalizePath(filePath);
  if (!SOURCE_EXTENSION.test(normalized) || /\.d\.ts$/i.test(normalized)) return false;
  if (!(normalized.startsWith('src/') || normalized.startsWith('supabase/functions/'))) return false;
  const segments = normalized.toLowerCase().split('/');
  if (segments.includes('node_modules')) return false;
  if (segments.some(segment => TEST_SEGMENTS.has(segment))) return false;
  return !TEST_FILE.test(normalized) && !TEST_ROLE_FILE.test(normalized);
}
function contractError(reasonCode, filePath, node, facts) {
  const position = facts.location(node, normalizePath(filePath));
  const error = new Error(`${REASON_TEXT[reasonCode] || 'RPC coverage contract is indeterminate'} at ${position.path}:${position.line}:${position.column}`);
  error.reasonCode = reasonCode;
  error.position = position;
  return error;
}
const DOMAIN_RPC_DATA_PROOFS = new Map([
  ['src/services/data-safety-package.ts:toAuditReplayPlanStep', ['local', 'rpc']],
  ['src/services/disaster-backup-data-safety.helpers.ts:toBackupReplayPlanStep', ['import', 'rpc']],
  ['src/services/disaster-backup-data-safety.helpers.ts:toDataSafetyLastWriteExplain', ['import', 'rpcResult']],
]);
const PARAMETER_RPC_PROOFS = new Map([
  ['supabase/functions/cleanup-attachments/cleanup-outbox.ts', ['AttachmentCleanupOutboxClient', 'claimTaskAttachmentCleanup', 'drainAttachmentCleanupOutbox', 'completeJob', 'releaseFailedJob']],
  ['supabase/functions/virus-scan/index.ts', ['ServiceRoleClient', 'claimAttachmentScanRescan']],
  ['supabase/functions/_shared/widget-common.ts', ['SupabaseAdminClient', 'consumeWidgetRateLimit']],
  ['supabase/functions/widget-notify/index.ts', ['ReturnType<typeof createServiceRoleClient>', 'loadActiveAndroidDevices']],
  ['src/app/core/services/sync/project-sync-probe.service.ts', ['SupabaseClient', 'loadProjectHeadPages']],
  ['src/services/black-box-sync-pull.helpers.ts', ['BlackBoxSupabaseClient | null', 'readBlackBoxRemoteWatermark']],
  ['src/app/core/services/sync/tombstone.service.ts', ['SupabaseClient', 'fetchBatchTombstones']],
]);
const SERVICE_ROLE_FACTORY = { imported: 'createClient', module: 'https://esm.sh/@supabase/supabase-js@2.93.2' };
const ANGULAR_INJECT_PROOF = { injectImported: 'inject', injectModule: '@angular/core' };
const FACTORY_RPC_PROOFS = new Map([
  ['supabase/functions/virus-scan/index.ts', { ...SERVICE_ROLE_FACTORY, kind: 'factory', localFactory: 'createServiceRoleClient' }],
  ['supabase/functions/widget-summary/index.ts', { imported: 'createServiceRoleClient', kind: 'factory', module: '../_shared/widget-common.ts' }],
  ['supabase/functions/widget-black-box-action/index.ts', { ...SERVICE_ROLE_FACTORY, kind: 'factory', localFactory: 'createServiceRoleClient' }],
]);
const PROJECT_PROVIDER_PROOF = {
  ...ANGULAR_INJECT_PROOF,
  className: 'ProjectDataService', field: 'supabase', getClientMethod: 'getSupabaseClient',
  clientProperty: 'getClient', providerMethod: 'syncProbeDependencies', retryMethod: 'withAuthRetry',
  retryProperty: 'withAuthRetry',
  syncField: 'syncProbes', syncToken: 'ProjectSyncProbeService', syncTokenModule: './project-sync-probe.service',
  token: 'SupabaseClientService', tokenModule: '../../../../services/supabase-client.service' };
const PROJECT_PROVIDER_CALLERS = [
  ['getProjectSyncWatermark', 'getProjectSyncWatermark', [0]],
  ['getUserProjectsWatermark', 'getUserProjectsWatermark', []],
  ['listProjectHeadsSince', 'listProjectHeadsSince', [0, 1]],
  ['getAccessibleProjectProbe', 'getAccessibleProjectProbe', [0]],
  ['getBlackBoxSyncWatermark', 'getBlackBoxSyncWatermark', []],
  ['getResumeRecoveryProbe', 'getResumeRecoveryProbe', [0]],
];
const NON_RPC_COMPUTED_DISPATCH_PROOFS = new Map([
  ['src/app/core/shell/workspace-shell-lazy-lifecycle-group-lazy-delegate.controller.ts', ['./workspace-shell-lazy-lifecycle-group.factory', 'WorkspaceShellLazyLifecycleGroupControllerLike', 'run', 'parameter', 'controller', 'WorkspaceShellLazyLifecycleGroupLazyDelegateController', null, null, null, 'host|run|0|0|./workspace-shell-lazy-delegate-call-host.controller:WorkspaceShellLazyDelegateCallHostController:value|./workspace-shell-lazy-lifecycle-group.factory:WorkspaceShellLazyLifecycleGroupControllerLike:type']],
  ['src/services/black-box-sync-local.service.ts', ['./black-box-sync-local-hydration.helpers', 'BlackBoxLocalHydrationLogEvent', 'logLocalHydrationEvents', 'logger', 'logger', 'BlackBoxSyncLocalLayer', 'level', './black-box-sync-queue-realtime.service', 'BlackBoxSyncQueueRealtimeLayer', null]],
]);
const SQL_CLAIM_SCOPE = Object.freeze({
  deployedStateEvaluated: false,
  kind: 'FRESH_INIT_ONLY',
  migrationReplayEvaluated: false,
  sourcePath: 'scripts/init-supabase.sql',
});
const REASON_TEXT = Object.freeze({
  PROJECT_PROVIDER_CALLER_INVALID: 'ProjectSync provider caller authority is invalid',
  PROJECT_PROVIDER_FACTORY_INVALID: 'ProjectSync provider factory authority is invalid',
  PROJECT_PROVIDER_PROVENANCE_INVALID: 'ProjectSync provider provenance is invalid',
  RPC_ALIAS_NOT_ADMISSIBLE: 'rpc alias provenance is not statically admissible',
  RPC_ARITY_NOT_ADMISSIBLE: 'rpc arity is not statically admissible',
  RPC_RECEIVER_UNAUTHORIZED: 'unauthorized rpc receiver authority',
  TRANSPORT_ALIAS_AMBIGUOUS: 'invokeRpc transport alias is not statically admissible',
  TRANSPORT_CALLER_ARITY: 'invokeRpc transport caller arity is ambiguous',
  TRANSPORT_CALLER_NAME_DYNAMIC: 'invokeRpc transport caller name is dynamic',
  TRANSPORT_EXECUTION_UNOBSERVED: 'invokeRpc transport execution is unobserved',
  TRANSPORT_PARAMETER_MUTATION: 'invokeRpc transport parameter is mutable or shadowed',
  TRANSPORT_SINK_COUNT_INVALID: 'invokeRpc transport sink count is invalid',
  TRANSPORT_SINK_INVALID: 'invokeRpc transport sink is invalid',
});
function isAnchoredDomainRpcData(node, filePath, resolver) {
  const owner = resolver.unwrap(node.expression);
  if (!ts.isIdentifier(owner)) return false;
  const binding = resolver.binding(owner);
  const key = `${normalizePath(filePath)}:${resolver.enclosingNamedFunction(node)}`;
  const proof = DOMAIN_RPC_DATA_PROOFS.get(key);
  if (proof && ts.isParameter(binding?.declaration)) {
    const parent = resolver.valueParent(node);
    const typeProven = proof[0] === 'local'
      ? resolver.isLocalInterfaceType(binding.declaration.type, 'DataSafetyReplayEntry', ['queue', 'rpc', 'lww', 'lastSyncTime'])
      : resolver.isImportedTypeRoot(binding.declaration.type, '../../supabase/functions/_shared/backup-utils', 'BackupDataSafetySnapshot');
    return typeProven
      && ts.isPropertyAssignment(parent) && resolver.propertyName(parent.name) === proof[1]
      && resolver.unwrap(parent.initializer) === node;
  }
  if (key !== 'src/services/import-backup-data-safety-metadata.helpers.ts:isBackupReplayEntry'
    || !ts.isVariableDeclaration(binding?.declaration)) return false;
  const initializer = binding.declaration.initializer;
  const castType = initializer && (ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer))
    ? initializer.type.getText() : null;
  const ownerFunction = resolver.functionAncestor(node);
  return castType === 'Record<string, unknown>' && ts.isParameter(ownerFunction?.parameters[0])
    && resolver.sameBinding(initializer.expression, ownerFunction.parameters[0].name)
    && ts.isPrefixUnaryExpression(node.parent)
    && node.parent.operator === ts.SyntaxKind.ExclamationToken
    && ts.isPrefixUnaryExpression(node.parent.parent)
    && node.parent.parent.operator === ts.SyntaxKind.ExclamationToken;
}
function isAnchoredInjectedSyncRpcOwner(node, filePath, resolver) {
  if (normalizePath(filePath) !== 'src/services/project-conflict-direct-sync.service.ts') return false;
  if (!ts.isPropertyAccessExpression(node) || resolver.unwrap(node.expression).kind !== ts.SyntaxKind.ThisKeyword) return false;
  let owner = node.parent;
  while (owner && !ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) owner = owner.parent;
  if (!owner || owner.name?.text !== 'ProjectConflictDirectSyncService') return false;
  const member = owner.members.find(candidate =>
    ts.isPropertyDeclaration(candidate) && resolver.propertyName(candidate.name) === node.name.text
  );
  const value = member?.initializer && resolver.unwrap(member.initializer);
  const call = ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)
    && node.parent.parent.expression === node.parent ? node.parent.parent : null;
  return !!value && ts.isCallExpression(value)
    && resolver.isDirectImport(value.expression, '@angular/core', 'inject')
    && resolver.isDirectImport(value.arguments[0], './sync-rpc-client.service', 'SyncRpcClientService')
    && !!call && ['deleteTasks', 'upsertConnection', 'upsertProject', 'upsertTask'].includes(node.parent.name.text);
}
function rpcValueUse(node, filePath, resolver) {
  let current = node;
  while (current.parent && resolver.unwrap(current.parent) === node) current = current.parent;
  const parent = current.parent;
  if (isAnchoredDomainRpcData(node, filePath, resolver)
    || isAnchoredInjectedSyncRpcOwner(node, filePath, resolver)) return 'data';
  if (ts.isCallExpression(parent) && parent.expression === current) return 'call';
  return 'alias';
}
function isAnchoredNonRpcComputedDispatch(call, filePath, resolver) {
  const proof = NON_RPC_COMPUTED_DISPATCH_PROOFS.get(filePath);
  const dispatch = resolver.computedDispatch(call);
  if (!proof || !dispatch) return false;
  const [moduleName, importedName, ownerName, receiverKind, receiverName, className, keyPropertyName, baseModule, baseName, callbackFingerprint] = proof;
  return dispatch.receiverKind === receiverKind && dispatch.receiverName === receiverName
    && dispatch.key?.stable && dispatch.key.ownerName === ownerName
    && dispatch.keyTypeImport?.module === moduleName && dispatch.keyTypeImport.imported === importedName
    && (!className || dispatch.ownerClassName === className && (baseName
      ? dispatch.keyPropertyName === keyPropertyName && !dispatch.receiverDeclaredInOwner
        && !dispatch.receiverWrittenInOwner && dispatch.ownerBaseImport?.module === baseModule
        && dispatch.ownerBaseImport.imported === baseName && !dispatch.ownerBaseImport.typeOnly
      : dispatch.callbackFingerprint === callbackFingerprint));
}
function isAuthorizedRpcReceiver(call, filePath, resolver, flow) {
  const member = resolver.unwrap(call.expression);
  const receiver = ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)
    ? resolver.unwrap(member.expression) : null;
  const sinkOwner = resolver.enclosingNamedFunction(call);
  const owner = ts.isIdentifier(receiver) ? resolver.enclosingNamedFunction(resolver.binding(receiver)?.declaration) : sinkOwner;
  const parameter = PARAMETER_RPC_PROOFS.get(filePath);
  if (parameter?.slice(1).includes(owner)
    && flow.receiverEvidence(receiver, call, { kind: 'parameter', type: parameter[0] }).verdict === 'proven') return true;
  if (filePath === 'supabase/functions/transcribe/index.ts') {
    const proof = { ...SERVICE_ROLE_FACTORY, kind: sinkOwner === 'releaseQuotaReservation' ? 'captured' : 'factory' };
    if (flow.receiverEvidence(receiver, call, proof).verdict === 'proven') return true;
  }
  const factory = FACTORY_RPC_PROOFS.get(filePath) || FACTORY_RPC_PROOFS.get(filePath.replace(/\.js$/, '.ts'));
  if (factory && flow.receiverEvidence(receiver, call, factory).verdict === 'proven') return true;
  const injected = filePath === 'src/services/clock-sync.service.ts'
    ? { ...ANGULAR_INJECT_PROOF, kind: 'injected', method: 'client', token: 'SupabaseClientService', tokenModule: './supabase-client.service' }
    : filePath === 'src/services/sync-rpc-client.service.ts'
      ? { ...ANGULAR_INJECT_PROOF, kind: 'injected', method: 'clientAsync', token: 'SupabaseClientService', tokenModule: './supabase-client.service' }
      : null;
  if (injected && flow.receiverEvidence(receiver, call, injected).verdict === 'proven') return true;
  if (filePath === 'src/app/core/services/sync/project-sync-probe.service.ts'
    && owner !== 'loadProjectHeadPages') {
    const evidence = flow.receiverEvidence(receiver, call, {
      activate: 'withAuthRetry', getClient: 'getClient', kind: 'provider', type: 'ProjectSyncProbeDependencies',
    });
    const typeText = evidence.providerBinding?.declaration?.type?.getText();
    if (evidence.verdict === 'proven' && typeText === 'ProjectSyncProbeDependencies') return true;
  }
  return false;
}
function isThisInvokeRpc(node, resolver) {
  const member = ts.isCallExpression(node) ? resolver.unwrap(node.expression) : null;
  return !!member && ts.isPropertyAccessExpression(member) && member.name.text === 'invokeRpc'
    && resolver.unwrap(member.expression).kind === ts.SyntaxKind.ThisKeyword;
}
function validateSyncRpcTransport(sourceFile, filePath, resolver, flow) {
  const serviceClass = sourceFile.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SyncRpcClientService');
  if (!serviceClass) throw new Error('invokeRpc transport class is missing');
  const methods = serviceClass.members.filter(member =>
    ts.isMethodDeclaration(member) && resolver.propertyName(member.name) === 'invokeRpc'
  );
  if (methods.length !== 1) throw new Error('invokeRpc transport must have exactly one method');
  const method = methods[0];
  const parameterNames = method.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : null);
  if (parameterNames.length < 2 || parameterNames.length > 4
    || parameterNames[0] !== 'name' || parameterNames[1] !== 'payload') {
    throw new Error('invokeRpc transport signature is ambiguous');
  }
  const inspected = flow.transportEvidence(serviceClass, method, {
    allowBuilderCall: (call, receiverFlows) => {
      const member = resolver.unwrap(call.expression);
      return ts.isPropertyAccessExpression(member) && member.name.text === 'abortSignal' && receiverFlows();
    },
    clientName: 'clientAsync',
    isClientOrigin: call => {
    const member = resolver.unwrap(call.expression);
    const owner = member && ts.isPropertyAccessExpression(member) ? resolver.unwrap(member.expression) : null;
      return ts.isPropertyAccessExpression(owner)
      && owner.name.text === 'supabase' && resolver.unwrap(owner.expression).kind === ts.SyntaxKind.ThisKeyword;
    },
    isMemberCall: node => isThisInvokeRpc(node, resolver),
    label: 'invokeRpc transport',
    maxArgs: 4,
    memberName: 'invokeRpc',
    minArgs: 2,
    parameterNames: ['name', 'payload'],
    sinkName: 'rpc',
    validateSink: sink => {
      const sinkName = sink.arguments[0] && resolver.unwrap(sink.arguments[0]);
      const sinkPayload = sink.arguments[1] && resolver.unwrap(sink.arguments[1]);
      const property = ts.isObjectLiteralExpression(sinkPayload)
        ? sinkPayload.properties.find(candidate => resolver.propertyName(candidate.name) === 'payload') : null;
      const value = property && ts.isPropertyAssignment(property) ? resolver.unwrap(property.initializer) : null;
      const carriesPayload = property && (ts.isShorthandPropertyAssignment(property)
        ? resolver.sameBinding(property.name, method.parameters[1].name)
        : resolver.sameBinding(value, method.parameters[1].name));
      return sink.arguments.length === 2 && resolver.sameBinding(sinkName, method.parameters[0].name)
        && ts.isObjectLiteralExpression(sinkPayload) && sinkPayload.properties.length === 1 && !!carriesPayload;
    },
  });
  if (inspected.verdict !== 'proven') {
    throw contractError(inspected.reasonCode, filePath, inspected.node || method, resolver);
  }
  return {
    references: inspected.literalCalls.map(entry => ({
      ...resolver.location(entry.nameNode, normalizePath(filePath)),
      kind: 'sync-rpc-transport', name: entry.name,
    })),
    sink: inspected.sink,
  };
}
function sortReferences(references) {
  return references.sort((left, right) => left.name.localeCompare(right.name)
    || left.path.localeCompare(right.path) || left.line - right.line
    || left.column - right.column);
}
function parseSource(source, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx'
    ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostic = sourceFile.parseDiagnostics[0];
  if (diagnostic) {
    const point = sourceFile.getLineAndCharacterOfPosition(diagnostic.start || 0);
    throw new Error(`${normalizePath(filePath)}:${point.line + 1}:${point.character + 1}: source parse error`);
  }
  return sourceFile;
}
function validateProjectProvider(sourceFile, filePath, flow) {
  const facts = flow.facts;
  const owner = sourceFile.statements.find(statement => ts.isClassDeclaration(statement)
    && statement.name?.text === PROJECT_PROVIDER_PROOF.className);
  const member = name => owner?.members.find(candidate => facts.propertyName(candidate.name) === name);
  const injectedField = (name, tokenModule, token) => {
    const field = member(name);
    const initializer = field?.initializer && facts.unwrap(field.initializer);
    return ts.isPropertyDeclaration(field) && ts.isCallExpression(initializer)
      && facts.isDirectImport(initializer.expression,
        PROJECT_PROVIDER_PROOF.injectModule, PROJECT_PROVIDER_PROOF.injectImported)
      && facts.isDirectImport(initializer.arguments[0], tokenModule, token) ? field : null;
  };
  const supabaseField = injectedField(PROJECT_PROVIDER_PROOF.field,
    PROJECT_PROVIDER_PROOF.tokenModule, PROJECT_PROVIDER_PROOF.token);
  const syncField = injectedField(PROJECT_PROVIDER_PROOF.syncField,
    PROJECT_PROVIDER_PROOF.syncTokenModule, PROJECT_PROVIDER_PROOF.syncToken);
  if (!owner || !supabaseField || !syncField) {
    throw contractError('PROJECT_PROVIDER_PROVENANCE_INVALID', filePath,
      syncField || supabaseField || owner || sourceFile, facts);
  }
  const provider = flow.providerFactoryEvidence(owner, PROJECT_PROVIDER_PROOF);
  if (provider.verdict !== 'proven') {
    throw contractError(provider.reasonCode, filePath, provider.node || owner, facts);
  }
  const getClient = member(PROJECT_PROVIDER_PROOF.getClientMethod);
  const returns = [];
  function collectReturns(node) {
    if (node !== getClient && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    else ts.forEachChild(node, collectReturns);
  }
  if (!ts.isMethodDeclaration(getClient)) {
    throw contractError('PROJECT_PROVIDER_PROVENANCE_INVALID', filePath, owner, facts);
  }
  collectReturns(getClient.body);
  let authoritativeReturn = false;
  const validReturns = returns.length > 0 && returns.every(statement => {
    let value = statement.expression && facts.unwrap(statement.expression);
    if (value?.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isAwaitExpression(value)) value = facts.unwrap(value.expression);
    const call = ts.isCallExpression(value) ? value : null;
    const access = call && facts.unwrap(call.expression);
    const target = ts.isPropertyAccessExpression(access) ? facts.unwrap(access.expression) : null;
    const authoritative = ts.isPropertyAccessExpression(access) && access.name.text === 'clientAsync'
      && ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword
      && target.name.text === PROJECT_PROVIDER_PROOF.field && call.arguments.length === 0;
    authoritativeReturn ||= authoritative;
    return authoritative;
  });
  if (!validReturns || !authoritativeReturn || !ts.isMethodDeclaration(member(PROJECT_PROVIDER_PROOF.retryMethod))) {
    throw contractError('PROJECT_PROVIDER_PROVENANCE_INVALID', filePath, getClient, facts);
  }
  for (const [methodName, delegateName, forwardedParameters] of PROJECT_PROVIDER_CALLERS) {
    const evidence = flow.methodCallEvidence(owner, {
      delegateName, forwardedParameters, methodName,
      providerMethod: PROJECT_PROVIDER_PROOF.providerMethod,
      receiverField: PROJECT_PROVIDER_PROOF.syncField,
    });
    if (evidence.verdict !== 'proven') {
      throw contractError(evidence.reasonCode, filePath, evidence.node || owner, facts);
    }
  }
}
function extractStaticRpcFunctionReferences(source, filePath) {
  const normalized = normalizePath(filePath);
  const sourceFile = parseSource(source, normalized);
  const flow = createRpcControlFlowAnalyzer(ts, sourceFile);
  const resolver = flow.facts;
  if (normalized === 'src/app/core/services/sync/project-data.service.ts') {
    validateProjectProvider(sourceFile, normalized, flow);
  }
  const transport = normalized === 'src/services/sync-rpc-client.service.ts'
    ? validateSyncRpcTransport(sourceFile, normalized, resolver, flow)
    : { references: [], sink: null };
  const references = [...transport.references];
  const unresolvedDynamicSites = [];
  function isAnchoredRpcCallback(node) {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
    const call = node.parent;
    const member = ts.isCallExpression(call) ? resolver.unwrap(call.expression) : null;
    const owner = member && ts.isPropertyAccessExpression(member) ? resolver.unwrap(member.expression) : null;
    const ownerBinding = owner && ts.isIdentifier(owner) ? resolver.binding(owner) : null;
    const probeRetry = normalized === 'src/app/core/services/sync/project-sync-probe.service.ts'
      && ts.isCallExpression(call) && call.arguments[1] === node
      && ts.isPropertyAccessExpression(member) && member.name.text === 'withAuthRetry'
      && ts.isParameter(ownerBinding?.declaration)
      && ownerBinding.declaration.type?.getText() === 'ProjectSyncProbeDependencies';
    if (probeRetry) return true;
    if (normalized !== 'src/app/core/services/sync/tombstone.service.ts'
      || resolver.enclosingNamedFunction(node) !== 'fetchBatchTombstones'
      || !ts.isCallExpression(call) || call.arguments[1] !== node
      || !ts.isPropertyAccessExpression(member) || member.name.text !== 'execute'
      || !ts.isPropertyAccessExpression(owner) || owner.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
    let serviceClass = node.parent;
    while (serviceClass && !ts.isClassDeclaration(serviceClass)) serviceClass = serviceClass.parent;
    const field = serviceClass?.members.find(candidate =>
      ts.isPropertyDeclaration(candidate) && resolver.propertyName(candidate.name) === owner.name.text
    );
    const initializer = field?.initializer && resolver.unwrap(field.initializer);
    return !!initializer && ts.isCallExpression(initializer)
      && resolver.isDirectImport(initializer.expression, '@angular/core', 'inject')
      && resolver.isDirectImport(
        initializer.arguments[0], '../../../../services/request-throttle.service', 'RequestThrottleService',
      );
  }
  function computedRpcCallStatus(node) {
    const dispatch = resolver.computedDispatch(node);
    if (!dispatch) return null;
    const key = flow.stringEvidence(dispatch.argument);
    const mayDispatchRpc = key.kind === 'exact' ? key.value === 'rpc'
      : key.complete !== true || key.candidates?.includes('rpc');
    if (isAuthorizedRpcReceiver(node, normalized, resolver, flow)) return 'authorized';
    return mayDispatchRpc && !isAnchoredNonRpcComputedDispatch(node, normalized, resolver)
      ? 'unauthorized' : 'other';
  }
  function visit(node, entry = null) {
    const assignment = ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)
      ? resolver.unwrap(node.left) : ts.isForInStatement(node) || ts.isForOfStatement(node) ? node.initializer : null;
    if ((ts.isFunctionLike(node) && node.parameters.some(parameter => resolver.bindingPatternMentions(parameter.name, 'rpc'))) || ((ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) && resolver.bindingPatternMentions(node, 'rpc'))
      || (assignment && (ts.isObjectLiteralExpression(assignment) || ts.isArrayLiteralExpression(assignment))
        && resolver.bindingPatternMentions(assignment, 'rpc'))) {
      throw contractError('RPC_ALIAS_NOT_ADMISSIBLE', normalized, assignment || node, resolver);
    }
    const activeEntry = isAnchoredRpcCallback(node)
      ? node : entry || (ts.isFunctionLike(node) && node.body ? node : null);
    if (activeEntry && node !== activeEntry
      && flow.reachabilityEvidence(node, activeEntry).verdict !== 'proven') {
      if (!resolver.containsMember(node, 'rpc')) return;
      if (ts.isFunctionLike(node) && node.body) {
        ts.forEachChild(node, child => visit(child, node));
        return;
      }
      if (ts.isCallExpression(node) && isAnchoredNonRpcComputedDispatch(node, normalized, resolver)) return;
      let unauthorizedRpc = null;
      function findUnauthorizedRpc(candidate) {
        if (unauthorizedRpc) return;
        const computedStatus = computedRpcCallStatus(candidate);
        if ((resolver.isNamedPropertyCall(candidate, 'rpc') && candidate !== transport.sink
          && !isAuthorizedRpcReceiver(candidate, normalized, resolver, flow))
          || computedStatus === 'unauthorized') unauthorizedRpc = candidate;
        else ts.forEachChild(candidate, findUnauthorizedRpc);
      }
      findUnauthorizedRpc(node);
      if (unauthorizedRpc) throw contractError('RPC_RECEIVER_UNAUTHORIZED', normalized, unauthorizedRpc, resolver);
      throw contractError('RPC_ALIAS_NOT_ADMISSIBLE', normalized, node, resolver);
    }
    const elementResult = ts.isElementAccessExpression(node)
      ? flow.stringEvidence(node.argumentExpression) : null;
    const rpcElement = elementResult && (elementResult.kind === 'exact'
      ? elementResult.value === 'rpc'
      : ['cycle', 'mutation'].includes(elementResult.reason));
    const valueUse = resolver.isProperty(node, 'rpc') || rpcElement
      ? rpcValueUse(node, normalized, resolver) : null;
    if ((resolver.isProperty(node, 'rpc') && valueUse === 'alias')
      || (rpcElement && valueUse !== 'data')) throw contractError('RPC_ALIAS_NOT_ADMISSIBLE', normalized, node, resolver);
    const callee = ts.isCallExpression(node) ? resolver.unwrap(node.expression) : null;
    if (callee && ts.isIdentifier(callee) && callee.text === 'rpc') throw contractError('RPC_ALIAS_NOT_ADMISSIBLE', normalized, node, resolver);
    const computedStatus = computedRpcCallStatus(node);
    if (computedStatus === 'unauthorized') throw contractError('RPC_RECEIVER_UNAUTHORIZED', normalized, node, resolver);
    if (computedStatus === 'authorized') throw contractError('RPC_ALIAS_NOT_ADMISSIBLE', normalized, node, resolver);
    if (resolver.isNamedPropertyCall(node, 'rpc') && node !== transport.sink) {
      if (!isAuthorizedRpcReceiver(node, normalized, resolver, flow)) throw contractError('RPC_RECEIVER_UNAUTHORIZED', normalized, node, resolver);
      if (node.arguments.length < 1 || node.arguments.length > 3 || node.arguments.some(ts.isSpreadElement)) {
        throw contractError('RPC_ARITY_NOT_ADMISSIBLE', normalized, node, resolver);
      }
      const result = node.arguments[0] && flow.stringEvidence(node.arguments[0]);
      if (result?.kind === 'exact') {
        references.push({
          ...resolver.location(node.arguments[0], normalized),
          kind: 'direct-rpc',
          name: result.value,
        });
      } else {
        unresolvedDynamicSites.push({
          ...resolver.location(node.arguments[0] || node, normalized),
          reason: 'dynamic-rpc-name',
        });
      }
    }
    ts.forEachChild(node, child => visit(child, activeEntry));
  }
  visit(sourceFile);
  return {
    references: sortReferences(references),
    unresolvedDynamicSites: unresolvedDynamicSites.sort((left, right) => left.path.localeCompare(right.path)
      || left.line - right.line || left.column - right.column),
  };
}
function extractGeneratedPublicFunctionNames(source, filePath = 'supabase.ts') {
  const sourceFile = parseSource(source, filePath);
  const resolver = createRpcControlFlowAnalyzer(ts, sourceFile).facts;
  const database = sourceFile.statements.find(statement =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Database'
  );
  const publicType = database && resolver.memberType(database.type, 'public');
  const functionsType = resolver.memberType(publicType, 'Functions');
  if (!functionsType || !ts.isTypeLiteralNode(functionsType)) {
    throw new Error(`${filePath}: Database.public.Functions type is missing`);
  }
  return [...new Set(functionsType.members.map(member => resolver.propertyName(member.name)).filter(Boolean))]
    .sort();
}
function blockCommentEnd(source, start) {
  let depth = 1, index = start + 2;
  while (index < source.length && depth > 0) {
    if (source.startsWith('/*', index)) { depth += 1; index += 2; }
    else if (source.startsWith('*/', index)) { depth -= 1; index += 2; }
    else index += 1;
  }
  return depth === 0 ? index : -1;
}
function dollarTagAt(source, index) {
  return source[index] === '$' && !/[\p{L}\p{N}\p{M}\p{Pc}$]$/u.test(source.slice(0, index))
    ? source.slice(index).match(/^\$[A-Za-z0-9_]*\$/)?.[0] || null : null;
}
function quotedEnd(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === quote && source[index + 1] === quote) index += 1;
    else if (source[index] === quote) return index + 1;
  }
  return -1;
}
function splitSqlStatements(source, filePath) {
  const statements = [];
  let start = 0;
  let index = 0;
  let state = 'normal';
  let dollar = null;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (state === 'line-comment') {
      if (source[index] === '\n') state = 'normal';
      index += 1;
      continue;
    }
    if (state === 'dollar') {
      if (source.startsWith(dollar, index)) {
        index += dollar.length;
        state = 'normal';
        dollar = null;
      } else index += 1;
      continue;
    }
    if (pair === '--') {
      state = 'line-comment';
      index += 2;
    } else if (pair === '/*') {
      const end = blockCommentEnd(source, index);
      if (end < 0) throw new Error(`${filePath}: unterminated SQL block-comment`);
      index = end;
    } else if ((source[index] === 'E' || source[index] === 'e') && source[index + 1] === "'") {
      throw new Error(`${filePath}: unsupported SQL escape string`);
    } else if (source[index] === "'" || source[index] === '"') {
      const end = quotedEnd(source, index, source[index]);
      if (end < 0) throw new Error(`${filePath}: unterminated SQL quoted string`);
      index = end;
    } else if (source[index] === '$') {
      const tag = dollarTagAt(source, index);
      if (tag) {
        dollar = tag;
        state = 'dollar';
        index += dollar.length;
      } else index += 1;
    } else if (source[index] === ';') {
      statements.push(source.slice(start, index + 1));
      start = index + 1;
      index += 1;
    } else index += 1;
  }
  if (state !== 'normal' && state !== 'line-comment') {
    throw new Error(`${filePath}: unterminated SQL ${state}`);
  }
  if (source.slice(start).trim()) statements.push(source.slice(start));
  return statements;
}
function stripLeadingComments(statement) {
  let result = statement.trimStart();
  while (result.startsWith('--') || result.startsWith('/*')) {
    const lineComment = result.startsWith('--');
    const end = lineComment ? result.indexOf('\n') : blockCommentEnd(result, 0);
    if (end < 0) return '';
    result = result.slice(end + (lineComment ? 1 : 0)).trimStart();
  }
  return result;
}
function maskProceduralLiteralsAndComments(source, maskQuotedIdentifiers = false) {
  const result = source.split('');
  function blank(start, end) {
    for (let index = start; index < end; index += 1)
      if (result[index] !== '\n' && result[index] !== '\r') result[index] = ' ';
  }
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index + 2);
      blank(index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const start = index;
      const end = blockCommentEnd(source, index);
      if (end < 0) throw new Error('unterminated procedural block-comment');
      index = end;
      blank(start, index);
      continue;
    }
    const dollar = dollarTagAt(source, index);
    if (dollar) {
      const end = source.indexOf(dollar, index + dollar.length);
      if (end < 0) throw new Error('unterminated procedural dollar string');
      blank(index, end + dollar.length);
      index = end + dollar.length;
      continue;
    }
    if ((source[index] === 'E' || source[index] === 'e') && source[index + 1] === "'") throw new Error('unsupported procedural escape string');
    if (source[index] === "'" || source[index] === '"') {
      const quote = source[index];
      const end = quotedEnd(source, index, quote);
      if (end < 0) throw new Error('unterminated procedural quoted string');
      if (quote === "'" || maskQuotedIdentifiers) blank(index, end);
      index = end;
    } else {
      index += 1;
    }
  }
  return result.join('');
}
function sqlIdentifierAt(source, index) {
  while (/\s/.test(source[index] || '')) index += 1;
  if (source[index] === '"') {
    const end = quotedEnd(source, index, '"');
    return end < 0 ? null : { end, value: source.slice(index + 1, end - 1).replace(/""/g, '"') };
  }
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(source.slice(index));
  return match ? { end: index + match[0].length, value: match[0].toLowerCase() } : null;
}
function publicNameAt(source, index) {
  const schema = sqlIdentifierAt(source, index);
  if (!schema) return null;
  const separator = /^\s*\.\s*/.exec(source.slice(schema.end));
  const name = separator && sqlIdentifierAt(source, schema.end + separator[0].length);
  return schema.value === 'public' && name ? { end: name.end, name: name.value } : null;
}
function parenthesizedEnd(source, index) {
  while (/\s/.test(source[index] || '')) index += 1;
  if (source[index] !== '(') return index;
  const masked = maskProceduralLiteralsAndComments(source.slice(index), true);
  for (let depth = 0, offset = 0; offset < masked.length; offset += 1) {
    if (masked[offset] === '(') depth += 1;
    else if (masked[offset] === ')' && --depth === 0) return index + offset + 1;
    else if (masked[offset] === ';') return -1;
  }
  return -1;
}
function staticRenameAt(source, index) {
  const oldName = publicNameAt(source, index);
  if (!oldName) return null;
  const signatureEnd = parenthesizedEnd(source, oldName.end);
  const suffix = signatureEnd >= 0 && /^\s*rename\s+to\b/i.exec(source.slice(signatureEnd));
  const next = suffix && sqlIdentifierAt(source, signatureEnd + suffix[0].length);
  return next ? { newName: next.value, oldName: oldName.name } : null;
}
function applyStaticRename(state, certainty, oldName, newName) {
  const existed = state.delete(oldName);
  certainty.set(oldName, true);
  if (existed) state.add(newName);
  certainty.set(newName, true);
}
function analyzeDoBody(body, required, state, certainty) {
  const identifierSource = maskProceduralLiteralsAndComments(body);
  const terminatorMask = maskProceduralLiteralsAndComments(body, true);
  const events = [];
  const lifecycle = /\b(drop|alter)\s+(?:function|routine)\b/gi;
  let match;
  while ((match = lifecycle.exec(terminatorMask))) {
    const nameIndex = match.index + match[0].length;
    const renamed = match[1].toLowerCase() === 'alter' && staticRenameAt(identifierSource, nameIndex);
    if (renamed) { events.push({ index: match.index, kind: 'rename', ...renamed }); continue; }
    const end = terminatorMask.indexOf(';', match.index);
    const expression = terminatorMask.slice(match.index, end < 0 ? body.length : end + 1);
    const removed = publicNameAt(identifierSource, nameIndex);
    if (removed && (match[1].toLowerCase() === 'drop' || /\bset\s+schema\b/i.test(expression))) events.push({ index: match.index, kind: 'remove', name: removed.name });
  }
  const execute = /\bexecute\b/gi;
  while ((match = execute.exec(terminatorMask))) {
    const end = terminatorMask.indexOf(';', match.index);
    const expression = body.slice(match.index, end < 0 ? body.length : end + 1);
    const visibleExpression = terminatorMask.slice(match.index + match[0].length, end < 0 ? body.length : end).trim();
    const rawExpression = expression.slice(match[0].length).trim();
    const isStaticString = visibleExpression.length === 0
      && /^(?:'(?:''|[^'])*'|\$[A-Za-z0-9_]*\$[\s\S]*\$[A-Za-z0-9_]*\$)\s*;?$/i.test(rawExpression);
    const hasStaticNonLifecycleOperation = /^format\s*\(\s*'(?:revoke\s+all\s+on\s+function\s+%s\s+from|grant\s+execute\s+on\s+function\s+%s\s+to)\s+[A-Za-z_,\s]+'\s*,\s*function_signature\s*\)\s*;?$/i.test(rawExpression);
    if (!isStaticString && !hasStaticNonLifecycleOperation) {
      events.push({ index: match.index, kind: 'dynamic', names: required });
    } else if (/\b(?:alter|create|drop)\b[\s\S]*\b(?:function|procedure|routine)\b/i.test(expression)) {
      events.push({ index: match.index, kind: 'dynamic', names: required.filter(name => expression.toLowerCase().includes(name.toLowerCase())) });
    }
  }
  events.sort((left, right) => left.index - right.index);
  const contextEvidence = createRpcControlFlowAnalyzer().sqlEventContextEvidence(terminatorMask, events);
  for (const event of contextEvidence.events) {
    if (event.context === 'dead') continue;
    const affected = event.kind === 'rename' ? [event.oldName, event.newName]
      : event.kind === 'remove' ? [event.name] : event.names;
    if (event.context === 'indeterminate') { for (const name of affected) certainty.set(name, false); continue; }
    if (event.kind === 'rename') applyStaticRename(state, certainty, event.oldName, event.newName);
    else if (event.kind === 'remove') { state.delete(event.name); certainty.set(event.name, true); }
    else for (const name of event.names) certainty.set(name, false);
  }
}
function analyzeFreshInitRpcDeclarationCoverage(source, requiredNames, filePath = 'init-supabase.sql') {
  const required = [...new Set(requiredNames)].sort();
  const state = new Set();
  const certainty = new Map(required.map(name => [name, true]));
  const create = /^\s*create\s+(?:or\s+replace\s+)?function\b/i;
  const lifecycle = /^\s*(drop|alter)\s+(?:function|routine)\b/i;
  for (const rawStatement of splitSqlStatements(source, filePath)) {
    const statement = stripLeadingComments(rawStatement);
    let match = statement.match(create);
    const created = match && publicNameAt(statement, match[0].length);
    if (created) {
      state.add(created.name);
      certainty.set(created.name, true);
      continue;
    }
    match = statement.match(lifecycle);
    if (match) {
      const nameIndex = match[0].length;
      const renamed = match[1].toLowerCase() === 'alter' && staticRenameAt(statement, nameIndex);
      if (renamed) { applyStaticRename(state, certainty, renamed.oldName, renamed.newName); continue; }
      const removed = publicNameAt(statement, nameIndex);
      if (removed && (match[1].toLowerCase() === 'drop' || /\bset\s+schema\b/i.test(statement))) {
        state.delete(removed.name); certainty.set(removed.name, true); continue;
      }
    }
    if (/^\s*do(?:\s+language\s+[A-Za-z_][A-Za-z0-9_$]*)?\s+\$/i.test(statement)) {
      const bodyMatch = statement.match(/^\s*do(?:\s+language\s+[A-Za-z_][A-Za-z0-9_$]*)?\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1/i);
      if (!bodyMatch) throw new Error(`${filePath}: unresolved DO dollar body`);
      analyzeDoBody(bodyMatch[2], required, state, certainty);
    } else if (/^\s*do\b/i.test(statement)) throw new Error(`${filePath}: unresolved DO body`);
  }
  const indeterminate = required.filter(name => certainty.get(name) === false);
  const present = required.filter(name => certainty.get(name) !== false && state.has(name));
  const missing = required.filter(name => certainty.get(name) !== false && !state.has(name));
  return { indeterminate, missing, present };
}
function listRuntimeFiles(root) {
  const files = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(target);
      } else if (entry.isFile()) files.push(target);
    }
  }
  for (const relativeRoot of ['src', path.join('supabase', 'functions')]) walk(path.join(root, relativeRoot));
  return files.sort();
}
function analyzeRepositoryRpcFunctionCoverage(root) {
  const references = [];
  const unresolvedDynamicSites = [];
  for (const sourcePath of listRuntimeFiles(root)) {
    const relativePath = normalizePath(path.relative(root, sourcePath));
    if (!isRpcCoverageRuntimeFile(relativePath)) continue;
    const report = extractStaticRpcFunctionReferences(fs.readFileSync(sourcePath, 'utf8'), relativePath);
    references.push(...report.references);
    unresolvedDynamicSites.push(...report.unresolvedDynamicSites);
  }
  sortReferences(references);
  const rpcNames = [...new Set(references.map(reference => reference.name))].sort();
  const generatedPath = path.join(root, 'src', 'types', 'supabase.ts');
  const generatedPublicFunctions = extractGeneratedPublicFunctionNames(
    fs.readFileSync(generatedPath, 'utf8'),
    normalizePath(path.relative(root, generatedPath)),
  );
  const initPath = path.join(root, 'scripts', 'init-supabase.sql');
  const freshInitRpcDeclarations = analyzeFreshInitRpcDeclarationCoverage(
    fs.readFileSync(initPath, 'utf8'),
    rpcNames,
    normalizePath(path.relative(root, initPath)),
  );
  return {
    freshInitRpcDeclarations,
    generatedPublicFunctions,
    missingFromFreshInit: freshInitRpcDeclarations.missing,
    missingFromGeneratedTypes: rpcNames.filter(name => !generatedPublicFunctions.includes(name)),
    references,
    rpcNames,
    sqlClaimScope: SQL_CLAIM_SCOPE,
    unresolvedDynamicSites: unresolvedDynamicSites.sort((left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column
    ),
  };
}
module.exports = {
  analyzeFreshInitRpcDeclarationCoverage,
  analyzeRepositoryRpcFunctionCoverage,
  extractGeneratedPublicFunctionNames,
  extractStaticRpcFunctionReferences,
  isRpcCoverageRuntimeFile,
};
