'use strict';
const defaultCompare = (left, right) => String(left).localeCompare(String(right));
const sortedUnique = (values, compare) => [...new Set(values)].sort(compare);
function getOrCreate(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}
function createStableHeap(compare) {
  const values = [];
  function push(value) {
    let index = values.push(value) - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (compare(values[parent], value) <= 0) break;
      values[index] = values[parent]; index = parent;
    }
    values[index] = value;
  }
  function pop() {
    if (values.length === 0) return null;
    const first = values[0], last = values.pop();
    if (values.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= values.length) break;
        const right = left + 1, child = right < values.length && compare(values[right], values[left]) < 0 ? right : left;
        if (compare(values[child], last) >= 0) break;
        values[index] = values[child]; index = child;
      }
      values[index] = last;
    }
    return first;
  }
  return Object.freeze({ get size() { return values.length; }, peek: () => values[0] ?? null, push, pop });
}
function freezeRecord(value) {
  if (Array.isArray(value)) return Object.isFrozen(value) ? value : Object.freeze(value.map(freezeRecord));
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeRecord(child)])));
}
function createStructuralProgramAdapter(input) {
  if (typeof input?.describeScope !== 'function' || typeof input?.describeSite !== 'function') {
    throw new TypeError('structural adapter requires scope and site descriptors');
  }
  const sourceScope = typeof input.evidenceSource === 'function' ? input.evidenceSource : value => value;
  const scopeKey = value => {
    const scope = input.describeScope(value);
    return [scope.sourcePath.replaceAll('\\', '/'), scope.name ?? '<module>', scope.start, scope.end].join('\0');
  };
  const callsiteKey = value => {
    const site = input.describeSite(value);
    return [site.sourcePath.replaceAll('\\', '/'), site.start, site.end].join('\0');
  };
  const edgeKey = (kind, site, source, target) => [kind, scopeKey(source), callsiteKey(site), scopeKey(target)].join('\0');
  function provenanceEdge(kind, source, target, site = null) {
    const origin = input.describeScope(sourceScope(source ?? target)), destination = input.describeScope(target);
    const span = site ? input.describeSite(site) : null;
    return { kind, sourceIdentity: origin.identity ?? destination.identity, targetIdentity: destination.identity,
      sourcePath: origin.sourcePath, line: span?.line ?? null, column: span?.column ?? null,
      endLine: span?.endLine ?? null, endColumn: span?.endColumn ?? null };
  }
  return Object.freeze({ callsiteKey, edgeKey, provenanceEdge, scopeKey });
}
function resolveStaticCallableSet(input) {
  if (input.direct) return { binding: input.binding, targets: null, complete: true };
  if (input.installed) return { binding: null, targets: new Set([input.installed]), complete: true };
  const matches = input.matches ?? [];
  if (matches.length > 1) input.onAmbiguous?.(matches.length);
  return { binding: null, targets: new Set(matches.length === 1 ? matches : []), complete: matches.length === 1 };
}
function indexRootedCallsiteLanes(input) {
  const roots = [...new Set(input?.roots ?? [])], rootSet = new Set(roots), rootsByTarget = new Map();
  const targetsByCaller = new Map(), queue = [], summary = { queuePops: 0, arcVisits: 0, stateInsertions: 0 };
  for (const [target, sites] of input.callSitesByTarget ?? []) for (const site of sites) {
    getOrCreate(targetsByCaller, site.caller, () => []).push({ target, site });
  }
  for (const root of roots) { rootsByTarget.set(root, new Set([root])); queue.push({ root, target: root }); summary.stateInsertions += 1; }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]; summary.queuePops += 1;
    for (const edge of targetsByCaller.get(current.target) ?? []) {
      summary.arcVisits += 1; if (rootSet.has(edge.target) && edge.target !== current.target) continue;
      const targetRoots = rootsByTarget.get(edge.target) ?? new Set();
      if (targetRoots.has(current.root)) continue;
      targetRoots.add(current.root); rootsByTarget.set(edge.target, targetRoots); queue.push({ root: current.root, target: edge.target });
      summary.stateInsertions += 1;
    }
  }
  function groups(target) {
    const sites = input.callSitesByTarget.get(target) ?? [], targetRoots = rootsByTarget.get(target);
    if (!targetRoots) return [{ root: null, sites }];
    return [...targetRoots].map(root => ({ root, sites: sites.filter(site => target === root
      ? input.isRootSite(site, root) : rootsByTarget.get(site.caller)?.has(root)) }));
  }
  return Object.freeze({ groups, rootsByTarget, summary: freezeRecord(summary) });
}
function createStaticCallFrameResolver(input) {
  const compare = input?.compare ?? defaultCompare;
  const required = ['argumentsOf', 'callSitesOf', 'directTargets', 'keyOf', 'parameterOf', 'spreadArguments'];
  for (const name of required) if (typeof input?.[name] !== 'function') {
    throw new TypeError(`static frame resolver requires ${name}`);
  }
  function expandDescriptors(descriptors, stack) {
    let frames = [[]];
    for (const descriptor of descriptors) {
      const alternatives = descriptor.spread ? expandSpread(descriptor.value, stack) : [[descriptor.value]];
      if (alternatives.length === 0) return [];
      frames = frames.flatMap(prefix => alternatives.map(values => [...prefix, ...values]));
    }
    return frames;
  }
  function expandCall(value, stack = new Set()) {
    const key = `call:${input.keyOf(value)}`;
    if (stack.has(key)) return [];
    return expandDescriptors(input.argumentsOf(value), new Set(stack).add(key));
  }
  function expandSpread(value, stack) {
    const key = `spread:${input.keyOf(value)}`;
    if (stack.has(key)) return [];
    const next = new Set(stack).add(key), descriptors = input.spreadArguments(value);
    if (descriptors) return expandDescriptors(descriptors, next);
    const parameter = input.parameterOf(value);
    if (!parameter?.rest || parameter.path.length !== 0) return [];
    const sites = input.callSitesOf(parameter.target);
    if (sites.length === 0) return [];
    const groups = sites.map(site => expandCall(site, next).map(frame => frame.slice(parameter.index)));
    return groups.some(group => group.length === 0) ? [] : groups.flat();
  }
  function callableTargets(value, stack = new Set()) {
    const key = `callable:${input.keyOf(value)}`;
    if (stack.has(key)) return [];
    const next = new Set(stack).add(key), direct = input.directTargets(value);
    if (direct) return sortedUnique(direct, compare);
    const parameter = input.parameterOf(value);
    if (!parameter || parameter.rest || parameter.path.length !== 0) return [];
    const sites = input.callSitesOf(parameter.target);
    if (sites.length === 0) return [];
    const groups = sites.flatMap(site => expandCall(site, next).map(frame => {
      const argument = frame[parameter.index];
      return argument ? callableTargets(argument, next) : [];
    }));
    return groups.length === 0 || groups.some(group => group.length === 0)
      ? [] : sortedUnique(groups.flat(), compare);
  }
  return Object.freeze({ callableTargets, expandCall });
}
function createTypeScriptCallFrameResolver(input) {
  const ts = input?.syntax;
  if (!ts) throw new TypeError('TypeScript frame resolver requires syntax predicates');
  const argumentDescriptors = ({ node, scope }) => [...(node.arguments ?? node.elements ?? [])].map(argument => ({
    spread: ts.isSpreadElement(argument),
    value: { node: ts.isSpreadElement(argument) ? argument.expression : argument, scope },
  }));
  return createStaticCallFrameResolver({
    compare: (left, right) => input.scopeKey(left).localeCompare(input.scopeKey(right)),
    keyOf: ({ node, scope }) => `${input.scopeKey(scope)}:${input.identityOf(node)}`,
    argumentsOf: argumentDescriptors,
    callSitesOf: target => input.callSitesOf(target).map(({ call, caller }) => ({ node: call, scope: caller })),
    parameterOf: ({ node, scope }) => {
      const binding = ts.isIdentifier(node) ? input.resolveBinding(node.text, scope) : null;
      return binding?.parameter ? { ...binding.parameter, target: binding.scope } : null;
    },
    spreadArguments: value => {
      let { node, scope } = value;
      const binding = ts.isIdentifier(node) ? input.resolveBinding(node.text, scope) : null;
      const source = input.latestLocalSource(binding, node, scope)
        ?? (binding?.sources.length === 1 ? binding.sources[0] : null);
      if (source?.path.length === 0 && source.ref.kind === 'expression') ({ node, scope } = source.ref);
      return ts.isArrayLiteralExpression(node) ? argumentDescriptors({ node, scope }) : null;
    },
    directTargets: ({ node, scope }) => {
      const direct = input.scopeByNode.get(node) ?? input.localMemberTarget(node, scope);
      if (direct) return [direct];
      if (!ts.isIdentifier(node)) return [];
      const binding = input.resolveBinding(node.text, scope);
      const target = input.directCallableTarget(binding) ?? input.runtimeBindingTarget(binding)
        ?? input.delegateTarget(node.text);
      return target ? [target] : null;
    },
  });
}
function createStaticProgramGraph(input) {
  if (typeof input?.key !== 'string') throw new TypeError('static program graph requires a direction key');
  const nodes = Object.freeze([...(input.nodes ?? [])]), graphArcs = new Map(), frameCandidates = [];
  function add(arc, candidate = false) {
    if (graphArcs.has(arc.key)) return false;
    const frozen = freezeRecord(arc);
    graphArcs.set(frozen.key, frozen);
    if (candidate) frameCandidates.push(freezeRecord({ ...frozen.candidate, key: frozen.key, arc: frozen,
      producerNode: frozen.source, targetNode: frozen.target, factKind: frozen.sourceFactKind, arcKey: frozen.key }));
    return true;
  }
  function finish() {
    const directionGraph = freezeRecord({ key: input.key, nodes,
      arcs: [...graphArcs.values()].filter(arc => !arc.candidate).sort((left, right) => left.key.localeCompare(right.key)) });
    return Object.freeze({ directionGraph, graphArcs, frameCandidates: Object.freeze(frameCandidates),
      condensation: condenseDirectionalGraphs({ graphs: [directionGraph] }) });
  }
  return Object.freeze({ add, finish });
}
function validateGraph(graph, compare) {
  if (!graph || typeof graph.key !== 'string') throw new TypeError('direction graph requires a string key');
  const nodes = sortedUnique(graph.nodes ?? [], compare);
  if (nodes.length !== (graph.nodes ?? []).length) throw new TypeError(`duplicate node in direction ${graph.key}`);
  const nodeSet = new Set(nodes);
  const arcKeys = new Set();
  const arcs = [...(graph.arcs ?? [])].sort((left, right) => compare(left.key, right.key));
  for (const arc of arcs) {
    if (!arc || typeof arc.key !== 'string' || arcKeys.has(arc.key)) throw new TypeError(`invalid or duplicate arc in direction ${graph.key}`);
    if (!nodeSet.has(arc.source) || !nodeSet.has(arc.target)) throw new TypeError(`arc endpoint is outside direction ${graph.key}: ${arc.key}`);
    if (typeof arc.sourceFactKind !== 'string' || typeof arc.targetFactKind !== 'string') throw new TypeError(`arc fact kinds are invalid: ${arc.key}`);
    arcKeys.add(arc.key);
  }
  return { key: graph.key, nodes, nodeSet, arcs };
}
function tarjanComponents(graph, compare, stats = { nodeVisits: 0, arcVisits: 0 }) {
  const outgoing = new Map(graph.nodes.map(node => [node, []]));
  for (const arc of graph.arcs) { outgoing.get(arc.source).push(arc); stats.arcVisits += 1; }
  for (const arcs of outgoing.values()) arcs.sort((left, right) => (
    compare(left.key, right.key) || compare(left.target, right.target)
  ));
  let nextIndex = 0;
  const indexes = new Map(), lowLinks = new Map(), stack = [], stacked = new Set(), components = [];
  for (const root of graph.nodes) {
    if (indexes.has(root)) continue; const frames = [{ node: root, parent: null, arcIndex: 0, entered: false }];
    while (frames.length > 0) {
      const frame = frames.at(-1), node = frame.node;
      if (!frame.entered) {
        frame.entered = true; stats.nodeVisits += 1; indexes.set(node, nextIndex); lowLinks.set(node, nextIndex);
        nextIndex += 1; stack.push(node); stacked.add(node);
      }
      const arcs = outgoing.get(node);
      if (frame.arcIndex < arcs.length) {
        const arc = arcs[frame.arcIndex++]; stats.arcVisits += 1;
        if (!indexes.has(arc.target)) { frames.push({ node: arc.target, parent: node, arcIndex: 0, entered: false }); continue; }
        if (stacked.has(arc.target)) lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(arc.target)));
        continue;
      }
      frames.pop(); if (frame.parent !== null) lowLinks.set(frame.parent, Math.min(lowLinks.get(frame.parent), lowLinks.get(node)));
      if (lowLinks.get(node) !== indexes.get(node)) continue;
      const members = [];
      while (stack.length > 0) { const member = stack.pop(); stacked.delete(member); members.push(member); if (member === node) break; }
      members.sort(compare); components.push({ key: members.join('\u0001'), nodes: members });
    }
  }
  return { components, outgoing };
}
function topologicalComponents(graph, raw, compare, stats) {
  const componentByNode = new Map();
  raw.components.forEach((component, index) => component.nodes.forEach(node => componentByNode.set(node, index)));
  const successors = raw.components.map(() => new Set()), indegree = raw.components.map(() => 0);
  const internalArcs = raw.components.map(() => []), outgoingArcs = raw.components.map(() => []);
  for (const arc of graph.arcs) {
    stats.arcVisits += 1;
    const source = componentByNode.get(arc.source), target = componentByNode.get(arc.target);
    if (source === target) { internalArcs[source].push(arc); continue; }
    outgoingArcs[source].push(arc);
    if (successors[source].has(target)) continue;
    successors[source].add(target); indegree[target] += 1;
  }
  const ready = createStableHeap((left, right) => compare(left.component.key, right.component.key));
  raw.components.forEach((component, index) => { if (indegree[index] === 0) ready.push({ component, index }); });
  const ordered = [];
  while (ready.size > 0) {
    stats.nodeVisits += 1;
    const current = ready.pop(); ordered.push(current.index);
    for (const successor of [...successors[current.index]].sort((left, right) => (
      compare(raw.components[left].key, raw.components[right].key)))) {
      indegree[successor] -= 1;
      if (indegree[successor] === 0) {
        ready.push({ component: raw.components[successor], index: successor });
      }
    }
  }
  if (ordered.length !== raw.components.length) throw new Error(`component topology failed for ${graph.key}`);
  const rankByRaw = new Map(ordered.map((rawIndex, rank) => [rawIndex, rank]));
  const components = ordered.map((rawIndex, rank) => {
    const nodes = raw.components[rawIndex].nodes;
    return freezeRecord({ rank, key: raw.components[rawIndex].key, nodes, internalArcs: internalArcs[rawIndex], outgoingArcs: outgoingArcs[rawIndex] });
  });
  const componentRankByNode = new Map([...componentByNode].map(([node, rawIndex]) => [node, rankByRaw.get(rawIndex)]));
  return { components, componentRankByNode, outgoing: raw.outgoing };
}
function condenseDirectionalGraphs(input) {
  const compare = input?.compare ?? defaultCompare;
  if (typeof compare !== 'function') throw new TypeError('compare must be a function');
  const directions = [...(input?.graphs ?? [])].map(value => validateGraph(value, compare))
    .sort((left, right) => compare(left.key, right.key));
  const duplicate = directions.find((graph, index) => graph.key === directions[index - 1]?.key);
  if (duplicate) throw new TypeError(`duplicate direction: ${duplicate.key}`);
  const stats = { nodeVisits: 0, arcVisits: 0 };
  const frozenDirections = directions.map(graph => {
    const topology = topologicalComponents(graph, tarjanComponents(graph, compare, stats), compare, stats);
    return Object.freeze({ key: graph.key, nodes: Object.freeze(graph.nodes), arcs: Object.freeze(graph.arcs),
      components: Object.freeze(topology.components), componentRankByNode: topology.componentRankByNode, outgoing: topology.outgoing });
  });
  return Object.freeze({ directions: Object.freeze(frozenDirections), summary: freezeRecord(stats) });
}
const laneKey = (direction, owner, node, factKind) => JSON.stringify([direction, owner, node, factKind]);
const processedKey = (direction, arc, factKind, atom) => JSON.stringify([direction, arc.key, factKind, atom]);
function atomUniverses(input, compare) {
  const entries = input ?? [], kinds = new Set(entries.map(entry => entry?.factKind));
  if (entries.some(entry => !entry || typeof entry.factKind !== 'string') || kinds.size !== entries.length) {
    throw new TypeError('atom universes require unique fact kinds');
  }
  return new Map(entries.map(entry => [entry.factKind, new Set(sortedUnique(entry.atoms ?? [], compare))]));
}
function solveDirectionalFactLattice(input) {
  const compare = input?.compare ?? defaultCompare;
  const condensation = input?.condensation;
  if (!condensation?.directions) throw new TypeError('condensation is required');
  const owners = sortedUnique(input.owners ?? [], compare);
  if (owners.length !== (input.owners ?? []).length) throw new TypeError('owners must be unique');
  const universes = atomUniverses(input.atomUniverses, compare);
  const factKinds = [...universes.keys()].sort(compare);
  const producerKinds = new Set(input.producerFactKinds ?? []);
  const mapArcAtom = input.mapArcAtom;
  if (typeof mapArcAtom !== 'function') throw new TypeError('mapArcAtom is required');
  const allowsArc = typeof input.allowsArc === 'function' ? input.allowsArc : null;
  const mapPathEdge = typeof input.mapPathEdge === 'function' ? input.mapPathEdge : null;
  const directionByKey = new Map(condensation.directions.map(direction => [direction.key, direction]));
  const ownerSet = new Set(owners), bitByOwner = new Map(owners.map((owner, index) => [owner, 1n << BigInt(index)]));
  const ownerByBit = new Map([...bitByOwner].map(([owner, bit]) => [bit, owner]));
  const factMasks = new Map(), pendingFactMasks = new Map(), processedEdgeMasks = new Map();
  const outgoingByDirection = new Map(condensation.directions.map(direction => {
    const outgoing = new Map(direction.nodes.map(node => [node, []]));
    for (const arc of direction.arcs) outgoing.get(arc.source).push(arc);
    for (const arcs of outgoing.values()) arcs.sort((left, right) => compare(left.key, right.key));
    return [direction.key, outgoing];
  }));
  const workQueue = createStableHeap((left, right) => {
    if (left.kind === 'witness' || right.kind === 'witness') stats.witnessHeapComparisons += 1;
    return left.rank - right.rank || (left.kind === 'witness' ? comparePathRanks(left.pathRank, right.pathRank) : 0) || compare(left.key, right.key);
  });
  const queuedStates = new Set(), pendingFactKeysByState = new Map(), pendingWitnessEvents = new Map(), settledWitnessMasks = new Map();
  let refreshCandidateFactLanes = () => {};
  const stats = {
    firstFactInsertions: 0, factSetImprovements: 0, producerSetImprovements: 0,
    newAtomInsertions: 0, enqueueAttempts: 0, enqueueSuccesses: 0,
    duplicateEnqueueSuppressions: 0, queuePops: 0, stalePops: 0,
    transferApplications: 0, edgeAtomTraversals: 0, candidateAdjudications: 0,
    witnessImprovements: 0, witnessEnqueueSuccesses: 0, witnessQueuePops: 0,
    witnessStalePops: 0, witnessEdgeVisits: 0, witnessHeapComparisons: 0, witnessRankComparisons: 0, threatPropagationVisits: 0,
    threatPropagationEdges: 0, threatDependencyEdges: 0, candidateReadinessChecks: 0,
    candidateWakeOperations: 0, candidateQueuePushes: 0, candidateQueuePops: 0,
    candidateQueueStalePops: 0, candidateSccRuns: 0, candidateSccNodeVisits: 0, candidateSccEdgeVisits: 0,
    ownerBitInspections: 0, witnessMaskDeltas: 0, witnessPathGroupBuilds: 0,
    witnessTransferOwnerInspections: 0, witnessPathRecords: 0, witnessWorkingPathElements: 0,
    witnessAncestorPointers: 0, witnessMaterializedPaths: 0, witnessMaterializedPathElements: 0,
  };
  const factMaskKey = (direction, node, factKind, atom) => JSON.stringify([direction, node, factKind, atom]);
  function ownersInMask(mask) {
    const result = [];
    for (let remaining = mask; remaining !== 0n; remaining &= remaining - 1n) {
      const bit = remaining & -remaining; stats.ownerBitInspections += 1; result.push(ownerByBit.get(bit));
    }
    return result;
  }
  function maskSize(mask) { let count = 0; for (let value = mask; value !== 0n; value &= value - 1n) { count += 1; stats.ownerBitInspections += 1; } return count; }
  function validateState(direction, node, factKind) {
    if (!directionByKey.get(direction)?.componentRankByNode.has(node) || !universes.has(factKind)) {
      throw new TypeError(`unknown fact state: ${JSON.stringify([direction, node, factKind])}`);
    }
  }
  function validateLane(direction, owner, node, factKind) {
    if (!ownerSet.has(owner)) throw new TypeError(`unknown fact lane: ${laneKey(direction, owner, node, factKind)}`);
    validateState(direction, node, factKind);
  }
  function validatedAtoms(factKind, atoms) {
    const universe = universes.get(factKind), values = sortedUnique(atoms ?? [], compare);
    for (const atom of values) if (!universe.has(atom)) throw new TypeError(`unknown ${factKind} atom: ${atom}`);
    return values;
  }
  const graphStateKey = (direction, node) => JSON.stringify([direction, node]);
  function enqueueState(direction, node) {
    const key = graphStateKey(direction, node);
    stats.enqueueAttempts += 1;
    if (queuedStates.has(key)) { stats.duplicateEnqueueSuppressions += 1; return; }
    queuedStates.add(key); workQueue.push({ rank: 0, kind: 'state', key }); stats.enqueueSuccesses += 1;
  }
  function mergeMask(direction, node, factKind, atoms, ownerMask) {
    validateState(direction, node, factKind);
    let inserted = 0;
    for (const atom of validatedAtoms(factKind, atoms)) {
      const key = factMaskKey(direction, node, factKind, atom), current = factMasks.get(key) ?? 0n;
      const fresh = ownerMask & ~current;
      if (fresh === 0n) continue;
      const count = maskSize(fresh); inserted += count; factMasks.set(key, current | fresh);
      pendingFactMasks.set(key, (pendingFactMasks.get(key) ?? 0n) | fresh);
      const state = graphStateKey(direction, node);
      getOrCreate(pendingFactKeysByState, state, () => new Set()).add(key);
      stats.firstFactInsertions += count; stats.factSetImprovements += count; stats.newAtomInsertions += count;
      if (producerKinds.has(factKind)) stats.producerSetImprovements += count;
      enqueueState(direction, node); refreshCandidateFactLanes(key, fresh);
    }
    return inserted;
  }
  function ownerAtoms(direction, owner, node, factKind) {
    const bit = bitByOwner.get(owner);
    return [...universes.get(factKind)].filter(atom => (
      ((factMasks.get(factMaskKey(direction, node, factKind, atom)) ?? 0n) & bit) !== 0n
    )).sort(compare);
  }
  const seedGroups = new Map();
  for (const seed of input.seeds ?? []) {
    validateLane(seed.direction, seed.owner, seed.node, seed.factKind);
    const key = laneKey(seed.direction, seed.owner, seed.node, seed.factKind);
    const group = getOrCreate(seedGroups, key, () => ({ ...seed, atoms: new Set() }));
    for (const atom of validatedAtoms(seed.factKind, seed.atoms)) group.atoms.add(atom);
  }
  function applyArcMask(direction, ownerMask, arc, inputAtoms, transfer = mapArcAtom) {
    if (inputAtoms.length === 0) throw new Error(`empty-batch transfer forbidden: ${arc.key}`);
    for (const atom of inputAtoms) {
      const key = processedKey(direction.key, arc, arc.sourceFactKind, atom);
      const freshMask = ownerMask & ~(processedEdgeMasks.get(key) ?? 0n);
      if (freshMask === 0n) continue;
      const output = transfer(freezeRecord({ arc, sourceFactKind: arc.sourceFactKind,
        targetFactKind: arc.targetFactKind, atom }));
      if (!Array.isArray(output)) throw new TypeError(`transfer must return an atom array: ${arc.key}`);
      mergeMask(direction.key, arc.target, arc.targetFactKind, output, freshMask);
      processedEdgeMasks.set(key, (processedEdgeMasks.get(key) ?? 0n) | freshMask);
      stats.transferApplications += 1; stats.edgeAtomTraversals += 1;
    }
  }
  const coordinateFields = Object.freeze(['producer', 'caller', 'callsite', 'target']);
  const receiptFields = Object.freeze(['owner', 'arcKey', 'producerNode', 'targetNode', ...coordinateFields, 'argumentIndex']);
  const candidateReceiptKey = (owner, arcKey) => JSON.stringify([owner, arcKey]);
  const receiptFor = candidate => freezeRecord(Object.fromEntries(receiptFields.map(field => [field, candidate[field]])));
  function candidateReceiptMatches(candidate, receipt) {
    const metadata = candidate.arc?.candidate;
    return Boolean(receipt) && candidate.key === `${String(receipt.owner)}\0${receipt.arcKey}`
      && receiptFields.every(field => candidate[field] === receipt[field])
      && candidate.arc?.key === receipt.arcKey
      && candidate.arc?.source === receipt.producerNode && candidate.arc?.target === receipt.targetNode
      && coordinateFields.every(field => metadata?.[field] === receipt[field])
      && metadata?.argumentIndex === receipt.argumentIndex;
  }
  function assertCandidateReceipt(value, owner) {
    if (candidateReceiptMatches(value, candidateReceipts.get(candidateReceiptKey(owner, value.arcKey)))) return;
    throw new Error(`candidate receipt mismatch before publication: ${value.arcKey}`);
  }
  const orderedCandidates = [...(input.candidates ?? [])].map(freezeRecord).sort((left, right) => compare(left.key, right.key));
  const candidateGroups = new Map(), candidateArcKeys = new Set(), candidateReceipts = new Map();
  for (const candidate of orderedCandidates) {
    validateLane(candidate.direction, candidate.owner, candidate.producerNode, candidate.factKind);
    if (!coordinateFields.every(key => typeof candidate[key] === 'string')
      || (candidate.argumentIndex !== null && !Number.isInteger(candidate.argumentIndex))) {
      throw new TypeError(`candidate requires stable source-coordinate identities: ${String(candidate.arcKey)}`);
    }
    const receipt = receiptFor(candidate), receiptKey = candidateReceiptKey(candidate.owner, candidate.arcKey);
    if (typeof candidate.arcKey !== 'string' || !candidateReceiptMatches(candidate, receipt)) {
      throw new TypeError(`candidate receipt mismatch: ${String(candidate.arcKey)}`);
    }
    if (candidateArcKeys.has(receiptKey)) throw new TypeError(`invalid or duplicate candidate arc: ${candidate.arcKey}`);
    candidateArcKeys.add(receiptKey); candidateReceipts.set(receiptKey, receipt);
    const key = JSON.stringify([candidate.direction, candidate.targetNode, candidate.factKind]);
    const group = getOrCreate(candidateGroups, key, () => ({ key, direction: candidate.direction,
      targetNode: candidate.targetNode, factKind: candidate.factKind, byOwner: new Map() }));
    getOrCreate(group.byOwner, candidate.owner, () => []).push(candidate);
  }
  const groups = [...candidateGroups.values()].sort((left, right) => compare(left.key, right.key));
  for (const group of groups) for (const [owner, candidates] of group.byOwner) group.byOwner.set(
    owner, candidates.sort((left, right) => compare(left.key, right.key)));
  const adjudications = [], adjudicationByOwnerArc = new Map(), committedCandidateMasksBySource = new Map();
  const candidateLaneKey = (group, owner) => JSON.stringify([group.key, owner]);
  const pendingCandidateLanes = new Map(groups.flatMap(group => [...group.byOwner].map(([owner, candidates]) => {
    const key = candidateLaneKey(group, owner);
    return [key, { key, group, owner, candidates, producerNodes: sortedUnique(
      candidates.map(candidate => candidate.producerNode), compare,
    ), rootedProducers: new Set(), unresolvedByProducer: new Map(), unresolvedProducerCount: 0 }];
  })));
  const dependentCandidateLanes = new Map([...pendingCandidateLanes.keys()].map(key => [key, new Map()]));
  const producerLanesByComponent = new Map();
  const componentIndexKey = (direction, rank) => JSON.stringify([direction, rank]);
  for (const lane of pendingCandidateLanes.values()) for (const producer of lane.producerNodes) {
    const direction = directionByKey.get(lane.group.direction), rank = direction.componentRankByNode.get(producer);
    const indexKey = componentIndexKey(direction.key, rank);
    const owners = getOrCreate(producerLanesByComponent, indexKey, () => new Map());
    const entries = getOrCreate(owners, lane.owner, () => new Map());
    getOrCreate(entries, lane.key, () => new Set()).add(producer);
  }
  const successorsByDirection = new Map(condensation.directions.map(direction => [direction.key,
    direction.components.map(component => sortedUnique(component.outgoingArcs
      .map(arc => direction.componentRankByNode.get(arc.target)), (left, right) => left - right))]));
  for (const direction of condensation.directions) {
    const lanes = [...pendingCandidateLanes.values()].filter(lane => lane.group.direction === direction.key).sort((left, right) => compare(left.key, right.key));
    const bitByLane = new Map(lanes.map((lane, index) => [lane.key, 1n << BigInt(index)]));
    const laneByBit = new Map(lanes.map(lane => [bitByLane.get(lane.key), lane]));
    const ownerMasks = new Map(), masks = direction.components.map(() => 0n);
    for (const lane of lanes) {
      const bit = bitByLane.get(lane.key), rank = direction.componentRankByNode.get(lane.group.targetNode);
      masks[rank] |= bit; ownerMasks.set(lane.owner, (ownerMasks.get(lane.owner) ?? 0n) | bit);
    }
    for (let rank = 0; rank < masks.length; rank += 1) {
      const mask = masks[rank];
      if (mask === 0n) continue;
      stats.threatPropagationVisits += 1;
      const producersByOwner = producerLanesByComponent.get(componentIndexKey(direction.key, rank)) ?? new Map();
      for (const owner of [...producersByOwner.keys()].sort(compare)) {
        const ownerMask = mask & (ownerMasks.get(owner) ?? 0n), entries = producersByOwner.get(owner);
        if (ownerMask === 0n) continue;
        let remaining = ownerMask;
        while (remaining !== 0n) {
          const bit = remaining & -remaining, sourceLane = laneByBit.get(bit);
          for (const targetKey of [...entries.keys()].sort(compare)) {
            const producers = entries.get(targetKey), targets = dependentCandidateLanes.get(sourceLane.key);
            const existing = getOrCreate(targets, targetKey, () => new Set());
            for (const producer of producers) if (!existing.has(producer)) {
              existing.add(producer); stats.threatDependencyEdges += 1;
            }
          }
          remaining ^= bit;
        }
      }
      for (const successor of successorsByDirection.get(direction.key)[rank]) {
        stats.threatPropagationEdges += 1; masks[successor] |= mask;
      }
    }
  }
  for (const targets of dependentCandidateLanes.values()) for (const [targetKey, producers] of targets) {
    const lane = pendingCandidateLanes.get(targetKey);
    for (const producer of producers) {
      const count = lane.unresolvedByProducer.get(producer) ?? 0;
      lane.unresolvedByProducer.set(producer, count + 1);
      if (count === 0) lane.unresolvedProducerCount += 1;
    }
  }
  const candidateLanesByFact = new Map();
  for (const lane of pendingCandidateLanes.values()) {
    for (const producer of lane.producerNodes) for (const atom of universes.get(lane.group.factKind)) {
      const factKey = factMaskKey(lane.group.direction, producer, lane.group.factKind, atom);
      getOrCreate(candidateLanesByFact, factKey, () => new Map())
        .set(lane.key, { producer, bit: bitByOwner.get(lane.owner) });
    }
  }
  stats.candidateSccRuns += 1;
  const candidateDependencyNodes = [...pendingCandidateLanes.keys()].sort(compare);
  const candidateDependencyArcs = [...dependentCandidateLanes].flatMap(([source, targets]) => (
    [...targets.keys()].map(target => ({ key: JSON.stringify([source, target]), source, target }))));
  stats.candidateSccNodeVisits = candidateDependencyNodes.length;
  stats.candidateSccEdgeVisits = candidateDependencyArcs.length;
  const rawCandidateComponents = tarjanComponents({ nodes: candidateDependencyNodes, arcs: candidateDependencyArcs }, compare);
  const cyclicCandidateLaneKeys = new Set(rawCandidateComponents.components.filter(component => component.nodes.length > 1
    || dependentCandidateLanes.get(component.nodes[0])?.has(component.nodes[0])).flatMap(component => component.nodes));
  const readyCandidateLanes = new Set();
  function candidateLaneReady(lane) {
    stats.candidateReadinessChecks += 1;
    if (lane.rootedProducers.size > 1) return true;
    if (lane.rootedProducers.size === 0) return lane.unresolvedProducerCount === 0;
    const rooted = lane.rootedProducers.values().next().value;
    return lane.unresolvedProducerCount - (lane.unresolvedByProducer.has(rooted) ? 1 : 0) === 0;
  }
  function queueCandidateLane(key) {
    const lane = pendingCandidateLanes.get(key);
    if (!lane || readyCandidateLanes.has(key) || !candidateLaneReady(lane)) return;
    workQueue.push({ rank: 1, kind: 'candidate', key });
    readyCandidateLanes.add(key); stats.candidateQueuePushes += 1;
  }
  function settleCandidateLane(lane) {
    pendingCandidateLanes.delete(lane.key);
    readyCandidateLanes.delete(lane.key);
    for (const [dependentKey, producers] of dependentCandidateLanes.get(lane.key)) {
      const dependent = pendingCandidateLanes.get(dependentKey);
      if (!dependent) continue;
      for (const producer of producers) {
        const count = dependent.unresolvedByProducer.get(producer);
        if (!count) continue;
        if (count === 1) { dependent.unresolvedByProducer.delete(producer); dependent.unresolvedProducerCount -= 1; }
        else dependent.unresolvedByProducer.set(producer, count - 1);
        stats.candidateWakeOperations += 1;
      }
      queueCandidateLane(dependentKey);
    }
  }
  refreshCandidateFactLanes = (factKey, freshMask) => {
    for (const [key, entry] of candidateLanesByFact.get(factKey) ?? []) {
      const lane = pendingCandidateLanes.get(key);
      if (lane && (freshMask & entry.bit) !== 0n && !lane.rootedProducers.has(entry.producer)) {
        lane.rootedProducers.add(entry.producer); stats.candidateWakeOperations += 1; queueCandidateLane(key);
      }
    }
  };
  for (const group of [...seedGroups.values()].sort((left, right) => compare(
    laneKey(left.direction, left.owner, left.node, left.factKind), laneKey(right.direction, right.owner, right.node, right.factKind),
  ))) mergeMask(group.direction, group.node, group.factKind, [...group.atoms], bitByOwner.get(group.owner));
  for (const key of pendingCandidateLanes.keys()) queueCandidateLane(key);
  function adjudicateLane(lane, cyclic) {
    const { candidates, group, owner } = lane, rooted = [...lane.rootedProducers].sort(compare);
    const canonical = rooted.length === 1 ? candidates.find(candidate => candidate.producerNode === rooted[0]) : null;
    const values = candidates.map(candidate => {
      const roots = ownerAtoms(candidate.direction, owner, candidate.producerNode, candidate.factKind);
      const classification = cyclic ? 'CYCLIC_PRODUCER_DEPENDENCY' : roots.length === 0 ? 'UNROOTED_PRODUCER'
        : rooted.length > 1 ? 'AMBIGUOUS_PRODUCERS' : candidate === canonical ? 'COMMIT' : 'IGNORE';
      const reason = classification === 'CYCLIC_PRODUCER_DEPENDENCY' ? 'candidate dependency cycle cannot commit'
        : classification === 'UNROOTED_PRODUCER' ? 'producer has no owner-rooted predecessor after convergence'
          : classification === 'AMBIGUOUS_PRODUCERS' ? `target has ${rooted.length} rooted producers after convergence`
            : classification === 'IGNORE' ? 'noncanonical duplicate producer site' : null;
      return freezeRecord({ ...candidate, roots, rootedProducers: rooted,
        groupProducerNodes: lane.producerNodes, classification, reason });
    });
    for (const value of values) {
      assertCandidateReceipt(value, owner);
      if (value.classification === 'COMMIT') {
        applyArcMask(directionByKey.get(value.direction), bitByOwner.get(owner), value.arc, value.roots,
          ({ atom }) => [atom]);
        assertCandidateReceipt(value, owner);
        const sourceKey = graphStateKey(value.direction, value.producerNode);
        const byArc = getOrCreate(committedCandidateMasksBySource, sourceKey, () => new Map());
        const committed = getOrCreate(byArc, value.arc.key, () => ({ arc: value.arc, mask: 0n }));
        committed.mask |= bitByOwner.get(owner); byArc.set(value.arc.key, committed);
      }
      adjudications.push(value); adjudicationByOwnerArc.set(`${owner}\0${value.arcKey}`, value);
      stats.candidateAdjudications += 1;
    }
  }
  function committedCandidate(owner, arc) {
    const value = adjudicationByOwnerArc.get(`${owner}\0${arc.key}`);
    const finalRooted = value?.groupProducerNodes.filter(producer => (
      ownerAtoms(value.direction, owner, producer, value.factKind).length > 0)) ?? [];
    return value?.classification === 'COMMIT' && candidateReceiptMatches(value,
      candidateReceipts.get(candidateReceiptKey(owner, arc.key)))
      && finalRooted.length === 1 && finalRooted[0] === arc.source;
  }
  const witnessRanks = new Map(), witnessPathGroups = new Map(), internedPaths = new Map(); let nextWitnessRank = 1;
  const witnessStateKey = (direction, node) => JSON.stringify([direction, node]);
  const publicWitnessStateKey = (direction, owner, node) => JSON.stringify([direction, owner, node]);
  const rootPathRank = Object.freeze({ rank: 0, root: '', parent: null, depth: 0, edge: null, stepKey: '', target: '' });
  function internPath(parent, edge, stepKey, root, target) {
    const key = JSON.stringify([parent.rank, root, stepKey, target]); if (internedPaths.has(key)) return internedPaths.get(key);
    const rank = Object.freeze({ rank: nextWitnessRank++, root, parent, depth: parent.depth + 1,
      edge: freezeRecord(edge), stepKey, target });
    internedPaths.set(key, rank); stats.witnessPathRecords += 1; stats.witnessWorkingPathElements += 1; stats.witnessAncestorPointers += 1;
    return rank;
  }
  function comparePathRanks(left, right) {
    stats.witnessRankComparisons += 1; if (left === right) return 0;
    return left.depth - right.depth || compare(left.root, right.root) || left.parent.rank - right.parent.rank
      || compare(left.stepKey, right.stepKey) || compare(left.target, right.target);
  }
  const seedRoot = seed => String(seed.witnessKey ?? JSON.stringify(seed.path));
  function seedPathRank(seed) {
    const root = seedRoot(seed); let rank = rootPathRank;
    for (const [index, edge] of seed.path.entries()) rank = internPath(rank, edge, `${index}\0${JSON.stringify(edge)}`, root, seed.node);
    return rank;
  }
  function mergeWitnessMask(direction, node, rank, ownerMask) {
    validateState(direction, node, factKinds[0]);
    const state = witnessStateKey(direction, node), ranks = getOrCreate(witnessRanks, state, () => new Map());
    let acceptedMask = ownerMask;
    for (const [previous, previousMask] of [...ranks]) {
      const overlap = acceptedMask & previousMask;
      if (overlap === 0n) continue;
      if (comparePathRanks(previous, rank) <= 0) { acceptedMask &= ~overlap; continue; }
      if (((settledWitnessMasks.get(state)?.get(previous) ?? 0n) & overlap) !== 0n) throw new Error(`witness scheduler rank regression: ${state}`);
      const retained = previousMask & ~overlap; if (retained === 0n) ranks.delete(previous); else ranks.set(previous, retained);
    }
    if (acceptedMask === 0n) return false;
    ranks.set(rank, (ranks.get(rank) ?? 0n) | acceptedMask); stats.witnessMaskDeltas += 1;
    const byRank = pendingWitnessEvents.get(state) ?? new Map(), pending = byRank.get(rank);
    if (pending) pending.ownerMask |= acceptedMask;
    else {
      const event = { rank: 2, kind: 'witness', key: state, direction, node, pathRank: rank, ownerMask: acceptedMask };
      byRank.set(rank, event); pendingWitnessEvents.set(state, byRank);
      workQueue.push(event); stats.witnessEnqueueSuccesses += 1;
    }
    return true;
  }
  function pathGroupsFor(direction, arc, candidate, ownerMask) {
    const key = JSON.stringify([direction, arc.key, candidate]), cached = witnessPathGroups.get(key) ?? { resolvedMask: 0n, groups: new Map() };
    const unresolvedMask = ownerMask & ~cached.resolvedMask;
    for (const owner of ownersInMask(unresolvedMask)) {
      stats.witnessTransferOwnerInspections += 1;
      if ((candidate && !committedCandidate(owner, arc)) || (!candidate && allowsArc && !allowsArc(freezeRecord({ direction, owner, arc })))) continue;
      const edge = mapPathEdge(freezeRecord({ direction, owner, arc }));
      if (!edge || typeof edge !== 'object') throw new TypeError(`path transfer must return an edge: ${arc.key}`);
      const stepKey = `${arc.key}\0${JSON.stringify(edge)}`, group = cached.groups.get(stepKey) ?? { edge: freezeRecord(edge), stepKey, mask: 0n };
      if (!cached.groups.has(stepKey)) stats.witnessPathGroupBuilds += 1;
      group.mask |= bitByOwner.get(owner); cached.groups.set(stepKey, group);
    }
    cached.resolvedMask |= unresolvedMask; witnessPathGroups.set(key, cached); return cached.groups.values();
  }
  function propagateWitnessArc(direction, arc, ownerMask, parent, candidate = false) {
    for (const group of pathGroupsFor(direction, arc, candidate, ownerMask)) {
      const mask = ownerMask & group.mask; if (mask === 0n) continue;
      const rank = internPath(parent, group.edge, group.stepKey, parent.root, arc.target);
      stats.witnessEdgeVisits += 1; mergeWitnessMask(direction, arc.target, rank, mask);
    }
  }
  if (mapPathEdge) for (const seed of [...(input.seeds ?? [])].sort((left, right) => compare(seedRoot(left), seedRoot(right)) || compare(
    laneKey(left.direction, left.owner, left.node, left.factKind), laneKey(right.direction, right.owner, right.node, right.factKind),
  ) || compare(JSON.stringify(left.path), JSON.stringify(right.path)))) if (Array.isArray(seed.path) && seed.path.length > 0) mergeWitnessMask(seed.direction, seed.node,
    seedPathRank(seed), bitByOwner.get(seed.owner));
  input?.instrumentation?.onSchedulerRun?.();
  let cyclicCandidateLanes = 0;
  while (workQueue.size > 0 || pendingCandidateLanes.size > 0) {
    if (pendingCandidateLanes.size > 0 && (!workQueue.peek() || workQueue.peek().kind === 'witness')) {
      const cyclicLanes = [...cyclicCandidateLaneKeys].flatMap(key => { const lane = pendingCandidateLanes.get(key); return lane ? [lane] : []; });
      if (cyclicLanes.length === 0) throw new Error('candidate scheduler stalled outside a cyclic SCC');
      for (const lane of cyclicLanes) { settleCandidateLane(lane); adjudicateLane(lane, true); }
      cyclicCandidateLanes += cyclicLanes.length; continue;
    }
    const event = workQueue.pop();
    if (event.kind === 'state') {
      queuedStates.delete(event.key); stats.queuePops += 1; const [directionKey, node] = JSON.parse(event.key);
      const factKeys = [...(pendingFactKeysByState.get(event.key) ?? [])].sort(compare); pendingFactKeysByState.delete(event.key); let worked = false;
      const direction = directionByKey.get(directionKey);
      for (const factKey of factKeys) {
        const [, , factKind, atom] = JSON.parse(factKey), deltaMask = pendingFactMasks.get(factKey) ?? 0n;
        pendingFactMasks.delete(factKey);
        if (deltaMask === 0n) continue; worked = true;
        for (const arc of outgoingByDirection.get(directionKey).get(node).filter(value => value.sourceFactKind === factKind)) {
          let allowedMask = deltaMask;
          if (allowsArc) {
            allowedMask = 0n;
            for (const owner of ownersInMask(deltaMask)) if (allowsArc(freezeRecord({ direction: directionKey, owner, arc }))) allowedMask |= bitByOwner.get(owner);
          }
          if (allowedMask !== 0n) applyArcMask(direction, allowedMask, arc, [atom]);
        }
      }
      if (!worked) stats.stalePops += 1;
      continue;
    }
    if (event.kind === 'witness') {
      stats.witnessQueuePops += 1; const pending = pendingWitnessEvents.get(event.key);
      pending?.delete(event.pathRank);
      if (pending?.size === 0) pendingWitnessEvents.delete(event.key);
      const currentMask = witnessRanks.get(event.key)?.get(event.pathRank) ?? 0n;
      const settled = getOrCreate(settledWitnessMasks, event.key, () => new Map());
      const activeMask = event.ownerMask & currentMask & ~(settled.get(event.pathRank) ?? 0n);
      if (activeMask === 0n) { stats.witnessStalePops += 1; continue; }
      settled.set(event.pathRank, (settled.get(event.pathRank) ?? 0n) | activeMask); stats.witnessImprovements += 1;
      for (const arc of outgoingByDirection.get(event.direction).get(event.node)) propagateWitnessArc(event.direction, arc, activeMask, event.pathRank);
      for (const row of committedCandidateMasksBySource.get(graphStateKey(event.direction, event.node))?.values() ?? []) {
        const mask = activeMask & row.mask;
        if (mask !== 0n) propagateWitnessArc(event.direction, row.arc, mask, event.pathRank, true);
      }
      continue;
    }
    if (event.kind === 'candidate') {
      readyCandidateLanes.delete(event.key); stats.candidateQueuePops += 1;
      const lane = pendingCandidateLanes.get(event.key);
      if (!lane || !candidateLaneReady(lane)) { stats.candidateQueueStalePops += 1; continue; }
      settleCandidateLane(lane); adjudicateLane(lane, false); continue;
    }
    throw new Error(`unknown scheduler event: ${String(event.kind)}`);
  }
  adjudications.sort((left, right) => compare(left.key, right.key));
  const atomCountByFactKind = Object.fromEntries([...universes].map(([kind, atoms]) => [kind, atoms.size]));
  const atomHeight = Object.values(atomCountByFactKind).reduce((sum, count) => sum + count, 0);
  const directions = condensation.directions.length;
  const nodes = Math.max(0, ...condensation.directions.map(direction => direction.nodes.length));
  const edges = Math.max(0, ...condensation.directions.map(direction => direction.arcs.length
    + new Set(orderedCandidates.filter(candidate => candidate.direction === direction.key)
      .map(candidate => candidate.arcKey)).size));
  const ordinaryCandidateEdges = condensation.directions.reduce((sum, direction) => sum
    + direction.arcs.filter(arc => arc.candidate).length, 0);
  const factsByLane = new Map();
  for (const [key, mask] of factMasks) {
    const [direction, node, factKind, atom] = JSON.parse(key);
    for (const owner of ownersInMask(mask)) {
      const outputKey = laneKey(direction, owner, node, factKind), atoms = factsByLane.get(outputKey) ?? new Set(); atoms.add(atom); factsByLane.set(outputKey, atoms);
    }
  }
  const factRecords = [...factsByLane].map(([key, atoms]) => ({ key, atoms: [...atoms].sort(compare) }))
    .sort((left, right) => compare(left.key, right.key));
  const materializedPaths = new Map();
  function materializePath(rank) {
    if (materializedPaths.has(rank.rank)) return materializedPaths.get(rank.rank);
    const path = Array(rank.depth); let cursor = rank; while (cursor.depth > 0) { path[cursor.depth - 1] = cursor.edge; cursor = cursor.parent; }
    const frozen = Object.freeze(path); materializedPaths.set(rank.rank, frozen);
    stats.witnessMaterializedPaths += 1; stats.witnessMaterializedPathElements += path.length; return frozen;
  }
  const publicWitnessRanks = new Map();
  for (const [state, ranks] of witnessRanks) {
    const [direction, node] = JSON.parse(state);
    for (const [rank, mask] of ranks) for (const owner of ownersInMask(mask)) {
      const key = publicWitnessStateKey(direction, owner, node), previous = publicWitnessRanks.get(key);
      if (!previous || comparePathRanks(rank, previous) < 0) publicWitnessRanks.set(key, rank);
    }
  }
  const projections = [...publicWitnessRanks].map(([state, rank]) => {
    const [direction, owner, node] = JSON.parse(state); return { direction, owner, node, path: materializePath(rank) };
  }).sort((left, right) => compare(publicWitnessStateKey(left.direction, left.owner, left.node),
    publicWitnessStateKey(right.direction, right.owner, right.node)));
  const structural = { rootLaneQueuePops: 0, rootLaneStateInsertions: 0, rootLaneArcVisits: 0, eagerSiteSeeds: 0,
    eagerSiteQueuePops: 0, eagerDependencyChecks: 0, eagerDependencyWakes: 0, ...(input.structuralSummary ?? {}) };
  const summary = freezeRecord({ directions, owners: owners.length, nodes, edges, factKinds: factKinds.length,
    condensationNodeVisits: condensation.summary?.nodeVisits ?? 0,
    condensationArcVisits: condensation.summary?.arcVisits ?? 0, atomCountByFactKind,
    latticeHeight: directions * owners.length * nodes * atomHeight,
    candidateLanes: adjudications.length, ordinaryCandidateEdges, candidateDependencyGroups: groups.length,
    candidateCyclicGroups: cyclicCandidateLanes, ...structural, ...stats });
  for (const value of adjudications) assertCandidateReceipt(value, value.owner);
  input?.instrumentation?.onSummary?.(summary);
  return freezeRecord({ facts: factRecords, adjudications, projections, summary });
}
module.exports = { condenseDirectionalGraphs, createStaticCallFrameResolver, createStaticProgramGraph, createStructuralProgramAdapter,
  createTypeScriptCallFrameResolver, indexRootedCallsiteLanes, resolveStaticCallableSet, solveDirectionalFactLattice };
