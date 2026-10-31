'use strict';

const { buildCallbackReachabilityProgram } = require('./codegraph-overlay-callback-reachability-program.cjs');
const { solveDirectionalFactLattice } = require('./codegraph-overlay-callback-reachability-solver.cjs');

const ownerSortKey = value => `${typeof value}\u0000${JSON.stringify(value)}`;
const ownerLaneKey = value => `owner:${ownerSortKey(value)}`;
const pathOrderKey = path => path.map(edge => [edge.kind, edge.sourcePath, edge.line, edge.column,
  edge.endLine, edge.endColumn].join('\u0001')).join('\u0002');
const stateKey = (owner, node) => JSON.stringify([owner, node]);

function candidateReceiptMatches(value, arc) {
  const candidate = arc?.candidate;
  return candidate && ['producer', 'caller', 'callsite', 'target'].every(key => typeof candidate[key] === 'string')
    && (candidate.argumentIndex === null || Number.isInteger(candidate.argumentIndex))
    && value?.arcKey === arc?.key && value.producerNode === arc?.source && value.targetNode === arc?.target
    && value.producer === candidate?.producer && value.caller === candidate?.caller
    && value.callsite === candidate?.callsite && value.target === candidate?.target
    && value.argumentIndex === candidate?.argumentIndex;
}

function analyzeCallbackReachabilityBatch(input) {
  const program = buildCallbackReachabilityProgram(input);
  const {
    diagnostics, directionGraph, condensation, frameCandidates, graphArcs, provenanceEdge, structuralSummary,
    resolveRootMatches, rootCallSites, scopeByKey, scopeKey,
  } = program;
  const requests = Array.isArray(input?.ownerRequests) ? input.ownerRequests : [];
  const canonicalOwners = requests.map((request, requestIndex) => ({
    ownerId: request?.ownerId ?? requestIndex,
    requestIndex,
    lane: ownerLaneKey(request?.ownerId ?? requestIndex),
  })).sort((left, right) => left.lane.localeCompare(right.lane));
  const duplicateLanes = new Set();
  canonicalOwners.forEach((owner, index) => {
    if (canonicalOwners[index - 1]?.lane === owner.lane) duplicateLanes.add(owner.lane);
  });
  const rootResolutionCache = new Map();
  function resolveRoot(root) {
    const key = `${String(root?.sourcePath)}\u0000${String(root?.name)}`;
    if (!rootResolutionCache.has(key)) {
      input?.instrumentation?.onRootResolution?.();
      rootResolutionCache.set(key, resolveRootMatches(root));
    }
    return rootResolutionCache.get(key);
  }
  const ownerByRequest = new Map(canonicalOwners.map(owner => [owner.requestIndex, owner]));
  const resolutions = requests.map((request, requestIndex) => {
    const owner = ownerByRequest.get(requestIndex);
    const ownerDiagnostics = [...diagnostics], resolvedRoots = [];
    if (duplicateLanes.has(owner.lane)) ownerDiagnostics.push(`duplicate owner id: ${String(owner.ownerId)}`);
    for (const root of Array.isArray(request?.rootCallables) ? request.rootCallables : []) {
      const matches = resolveRoot(root);
      if (matches.length === 0) {
        ownerDiagnostics.push(`root not found: ${String(root?.sourcePath)}#${String(root?.name)}`);
      } else if (matches.length > 1) {
        ownerDiagnostics.push(`ambiguous root: ${root.sourcePath}#${root.name} (${matches.length} matches)`);
      } else {
        resolvedRoots.push({ sourcePath: root.sourcePath, name: root.name,
          identity: matches[0].id, scope: matches[0], atom: scopeKey(matches[0]) });
      }
    }
    return { ownerId: owner.ownerId, lane: owner.lane, requestIndex, ownerDiagnostics, resolvedRoots };
  });
  const solverOwners = [...new Set(resolutions.filter(resolution => (
    resolution.ownerDiagnostics.length === 0
  )).map(resolution => resolution.lane))];
  const rootAtoms = [...new Set(resolutions.flatMap(resolution => (
    resolution.ownerDiagnostics.length === 0 ? resolution.resolvedRoots.map(root => root.atom) : []
  )))].sort();
  const seeds = resolutions.flatMap(resolution => resolution.ownerDiagnostics.length > 0 ? []
    : resolution.resolvedRoots.map(root => ({
      direction: directionGraph.key, owner: resolution.lane, node: root.atom,
      factKind: 'root', atoms: [root.atom], witnessKey: root.atom,
      path: [provenanceEdge('root', root.scope, root.scope)],
    })));
  const candidates = resolutions.flatMap(resolution => resolution.ownerDiagnostics.length > 0 ? []
    : frameCandidates.map(candidate => ({ ...candidate, direction: directionGraph.key, owner: resolution.lane,
      key: `${resolution.lane}\u0000${candidate.key}` })));
  input?.instrumentation?.onFixedPointRun?.({ ownerIds: resolutions.map(resolution => resolution.ownerId) });
  input?.instrumentation?.onSharedStateCreate?.({ ownerIds: resolutions.map(resolution => resolution.ownerId) });
  const solved = solveDirectionalFactLattice({
    condensation,
    structuralSummary,
    owners: solverOwners,
    atomUniverses: [{ factKind: 'root', atoms: rootAtoms }],
    producerFactKinds: ['root'],
    seeds,
    candidates,
    mapArcAtom: ({ atom }) => [atom],
    mapPathEdge: ({ arc }) => ({ ...arc.evidence, sourceIdentity: scopeByKey.get(arc.source).id,
      targetIdentity: scopeByKey.get(arc.target).id }),
    instrumentation: {
      onSchedulerRun: () => input?.instrumentation?.onSchedulerRun?.({
        ownerIds: resolutions.map(resolution => resolution.ownerId),
      }),
      onSummary: summary => input?.instrumentation?.onSolverSummary?.(summary),
    },
  });
  const adjudicationByOwnerArc = new Map(solved.adjudications.map(value => (
    [`${value.owner}\u0000${value.arcKey}`, value]
  )));
  const candidateArcKeys = new Set(frameCandidates.map(value => value.arcKey));
  for (const value of solved.adjudications) if (!solverOwners.includes(value.owner)
    || !candidateReceiptMatches(value, graphArcs.get(value.arcKey))) {
    throw new Error(`callback candidate changed before publication: ${value.arcKey}`);
  }
  const projection = new Map(solved.projections.map(value => [stateKey(value.owner, value.node), value.path]));
  return { ownerResults: resolutions.sort((left, right) => left.requestIndex - right.requestIndex)
    .map(resolution => projectOwner(resolution, projection, graphArcs, candidateArcKeys,
      adjudicationByOwnerArc, provenanceEdge, scopeByKey, rootCallSites)) };
}

function projectOwner(resolution, projection, graphArcs, candidateArcKeys, adjudications,
  provenanceEdge, scopeByKey, rootCallSites) {
  if (resolution.ownerDiagnostics.length > 0) return {
    ownerId: resolution.ownerId, resolvedRoots: [], reachableCallables: [],
    reachableCallableIdentities: [], reachableCallableNames: [], diagnostics: resolution.ownerDiagnostics,
    provenancePaths: [], terminalProvenance: [], rejections: [],
  };
  const reachableEntries = [...scopeByKey].filter(([node]) => (
    projection.has(stateKey(resolution.lane, node))
  ));
  const reachable = reachableEntries.filter(([, scope]) => scope.name)
    .sort((left, right) => left[0].localeCompare(right[0]));
  const reachableNodes = new Set(reachableEntries.map(([node]) => node));
  const terminal = new Map(reachable.map(([, scope]) => [scope.id, []]));
  for (const root of resolution.resolvedRoots) {
    terminal.get(root.identity)?.push(provenanceEdge('root', root.scope, root.scope));
    for (const site of rootCallSites.filter(value => value.target === root.scope)) {
      terminal.get(root.identity)?.push(site.evidence);
    }
  }
  for (const arc of graphArcs.values()) {
    if (!reachableNodes.has(arc.source) || !reachableNodes.has(arc.target)) continue;
    if (candidateArcKeys.has(arc.key)
      && adjudications.get(`${resolution.lane}\u0000${arc.key}`)?.classification !== 'COMMIT') continue;
    const target = scopeByKey.get(arc.target);
    terminal.get(target.id)?.push(arc.evidence);
  }
  for (const records of terminal.values()) records.sort((left, right) => pathOrderKey([left]).localeCompare(
    pathOrderKey([right]),
  ));
  const reachableCallables = reachable.map(([, scope]) => ({
    sourcePath: scope.sourcePath, name: scope.name, identity: scope.id,
  }));
  const rejections = [...adjudications.values()].filter(value => value.owner === resolution.lane
    && !['COMMIT', 'IGNORE'].includes(value.classification)).map(value => ({
    code: value.classification, owner: String(resolution.ownerId), producer: value.producer,
    caller: value.caller, callsite: value.callsite, target: value.target,
    argumentIndex: value.argumentIndex, reason: value.reason,
  })).sort((left, right) => left.callsite.localeCompare(right.callsite) || left.producer.localeCompare(right.producer));
  return {
    ownerId: resolution.ownerId,
    resolvedRoots: resolution.resolvedRoots.map(({ sourcePath, name, identity }) => ({ sourcePath, name, identity })),
    reachableCallables,
    reachableCallableIdentities: reachableCallables.map(value => value.identity).sort((left, right) => left - right),
    reachableCallableNames: [...new Set(reachableCallables.map(value => value.name))].sort(),
    diagnostics: resolution.ownerDiagnostics,
    provenancePaths: reachable.map(([node, scope]) => ({ identity: scope.id,
      path: projection.get(stateKey(resolution.lane, node)) })),
    terminalProvenance: reachable.map(([, scope]) => ({ identity: scope.id,
      predecessors: terminal.get(scope.id) ?? [] })),
    rejections,
  };
}

function analyzeCallbackReachability(input) {
  const result = analyzeCallbackReachabilityBatch({
    sources: input?.sources,
    entrySourcePath: input?.entrySourcePath,
    instrumentation: input?.instrumentation,
    ownerRequests: [{ ownerId: 'single', rootCallables: input?.rootCallables ?? [] }],
  }).ownerResults[0];
  return { reachableCallableNames: result.reachableCallableNames, diagnostics: result.diagnostics };
}

module.exports = { analyzeCallbackReachability, analyzeCallbackReachabilityBatch };
