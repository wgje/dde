import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(__filename);
const solverPath = path.join(repoRoot, 'scripts/lib/codegraph-overlay-callback-reachability-solver.cjs');
const facadePath = path.join(repoRoot, 'scripts/lib/codegraph-overlay-callback-reachability.cjs');

type Summary = Record<string, number>;
type Result = {
  facts: Array<{ key: string; atoms: string[] }>;
  adjudications: Array<{ owner: string; arcKey: string; producerNode: string;
    targetNode: string; classification: string }>;
  projections: Array<{ owner: string; node: string; path: unknown[] }>;
  summary: Summary;
};
type DirectModule = {
  condenseDirectionalGraphs(input: { graphs: Array<{ key: string; nodes: string[];
    arcs: Array<Record<string, unknown>> }> }): { summary: { nodeVisits: number; arcVisits: number } };
  indexRootedCallsiteLanes(input: Record<string, unknown>): { rootsByTarget: Map<string, Set<string>>;
    summary: { queuePops: number; arcVisits: number } };
  solveDirectionalFactLattice(input: Record<string, unknown>): Result;
};
type Effects = { mapperCalls: number; transfers: number; summaries: number; paths: number };
type FacadeResult = { diagnostics: string[]; reachableCallableNames: string[]; rejections: unknown[];
  reachableCallables: Array<{ sourcePath: string; name: string; identity: number }>;
  terminalProvenance: Array<{ identity: number; predecessors: Array<{ kind: string }> }> };

const direct = require(solverPath) as DirectModule;
const { analyzeCallbackReachabilityBatch } = require(facadePath) as {
  analyzeCallbackReachabilityBatch(input: Record<string, unknown>): { ownerResults: FacadeResult[] };
};

function candidate(owner: string, producerNode: string, targetNode: string, tag: string) {
  const receipt = { producer: `producer:${producerNode}`, caller: `caller:${tag}`,
    callsite: `site:${tag}`, target: `target:${targetNode}`, argumentIndex: 0 };
  const arc = { key: `arc:${tag}`, source: producerNode, target: targetNode,
    sourceFactKind: 'root', targetFactKind: 'root', candidate: receipt, evidence: { tag } };
  return { ...receipt, key: `${owner}\0${arc.key}`, direction: 'forward', owner, producerNode,
    targetNode, factKind: 'root', arcKey: arc.key, arc };
}

function solve(
  owners: string[], candidates: Array<ReturnType<typeof candidate>>, seeds: Array<[string, string]>,
  effects?: Effects, ordinary: Array<[string, string]> = [], witness = false, ownerEdges = false,
  solverModule = direct,
) {
  const nodes = [...new Set([...candidates.flatMap(value => [value.producerNode, value.targetNode]),
    ...seeds.map(([, node]) => node), ...ordinary.flat()])].sort();
  const arcs = ordinary.map(([source, target]) => ({ key: `ordinary:${source}:${target}`, source, target,
    sourceFactKind: 'root', targetFactKind: 'root' }));
  return solverModule.solveDirectionalFactLattice({
    owners, candidates,
    condensation: solverModule.condenseDirectionalGraphs({ graphs: [{ key: 'forward', nodes, arcs }] }),
    atomUniverses: [{ factKind: 'root', atoms: ['root'] }], producerFactKinds: ['root'],
    seeds: seeds.map(([owner, node]) => ({ direction: 'forward', owner, node, factKind: 'root',
      atoms: ['root'], ...(witness ? { path: [{ kind: 'root', node }], witnessKey: node } : {}) })),
    mapArcAtom: ({ atom }: { atom: string }) => {
      if (effects) effects.mapperCalls += 1;
      return [atom];
    },
    mapPathEdge: witness ? ({ owner, arc }: { owner: string; arc: { key: string } }) => (
      { kind: 'edge', key: arc.key, ...(ownerEdges ? { owner } : {}) }
    ) : undefined,
    instrumentation: { onSummary: (summary: Summary) => {
      if (effects) {
        effects.transfers = summary.transferApplications;
        effects.paths = summary.witnessEdgeVisits;
        effects.summaries += 1;
      }
    } },
  });
}

const chain = (prefix: string, width: number) => Array.from(
  { length: width }, (_, index) => [`${prefix}${index}`, `${prefix}${index + 1}`] as [string, string],
);
const ownerRows = (value: Result, owner: string) => JSON.stringify({
  facts: value.facts.filter(row => (JSON.parse(row.key) as string[])[1] === owner),
  adjudications: value.adjudications.filter(row => row.owner === owner),
  projections: value.projections.filter(row => row.owner === owner),
});
function expectChecks(label: string, checks: Record<string, boolean>) {
  expect.soft(checks, label).toEqual(Object.fromEntries(Object.keys(checks).map(key => [key, true])));
}
function replaceChecked(source: string, from: string, to: string) {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}
type DriftBoundary = 'before-check' | 'after-adjudication-check' | 'after-transfer' | 'before-summary';
function mutatedSolver(arcKey: string, field: string, value: unknown, boundary: DriftBoundary = 'before-check') {
  const source = fs.readFileSync(solverPath, 'utf8');
  const markers: Record<DriftBoundary, string> = {
    'before-check': '    const { candidates, group, owner } = lane, rooted = [...lane.rootedProducers].sort(compare);',
    'after-adjudication-check': "      assertCandidateReceipt(value, owner);\n      if (value.classification === 'COMMIT') {",
    'after-transfer': '        applyArcMask(directionByKey.get(value.direction), bitByOwner.get(owner), value.arc, value.roots,\n          ({ atom }) => [atom]);',
    'before-summary': '    candidateCyclicGroups: cyclicCandidateLanes, ...structural, ...stats });',
  };
  const publicationMarker = '  return freezeRecord({ facts: factRecords, adjudications, projections, summary });';
  const mutation = `
    const injectedDrift = globalThis.__receiptDrift;
    if (injectedDrift) {
      const injectedEntry = [...candidateReceipts].find(([, receipt]) => receipt.arcKey === injectedDrift.arcKey);
      if (injectedEntry) {
        const [injectedKey, injectedReceipt] = injectedEntry;
        candidateReceipts.set(injectedKey, freezeRecord({
          ...injectedReceipt, [injectedDrift.field]: injectedDrift.value,
        }));
      }
    }`;
  const injected = replaceChecked(
    replaceChecked(source, markers[boundary], `${markers[boundary]}${mutation}`), publicationMarker,
    `  globalThis.__publishedResult = { facts: factRecords, adjudications, projections, summary };\n${publicationMarker}`,
  );
  const loaded = { exports: {} as DirectModule };
  const sandbox = { module: loaded, exports: loaded.exports, require, __filename: solverPath,
    __dirname: path.dirname(solverPath), __receiptDrift: { arcKey, field, value },
    __publishedResult: null as Result | null };
  require('node:vm').runInNewContext(injected, sandbox);
  return { module: loaded.exports, published: sandbox.__publishedResult };
}

describe('CodeGraph callback reachability solver contract', { timeout: 30_000 }, () => {
  it('settles only cyclic lanes and keeps duplicate-owner diagnostics in the facade', () => {
    const cycle = solve(['A'], [
      candidate('A', 'p1', 'p2', 'cycle-1'), candidate('A', 'p2', 'p1', 'cycle-2'),
      candidate('A', 'p1', 'descendant', 'blocked'), candidate('A', 'rooted', 'descendant', 'rooted'),
    ], [['A', 'rooted']]);
    expect.soft(cycle.adjudications.filter(value => ['p1', 'p2'].includes(value.targetNode))
      .map(value => value.classification)).toEqual([
      'CYCLIC_PRODUCER_DEPENDENCY', 'CYCLIC_PRODUCER_DEPENDENCY',
    ]);
    expect.soft(cycle.adjudications.find(value => value.producerNode === 'rooted')?.classification)
      .toBe('COMMIT');
    expect.soft(cycle.facts.some(value => (JSON.parse(value.key) as string[])
      .slice(1, 3).join(':') === 'A:descendant')).toBe(true);

    const ambiguity = solve(['A'], [candidate('A', 'a', 'middle', 'a-middle'),
      candidate('A', 'b', 'middle', 'b-middle'), candidate('A', 'middle', 'tail', 'middle-tail')],
    [['A', 'a'], ['A', 'b']]);
    expect(ambiguity.adjudications.map(value => value.classification)).toEqual([
      'AMBIGUOUS_PRODUCERS', 'AMBIGUOUS_PRODUCERS', 'UNROOTED_PRODUCER',
    ]);

    const sourcePath = 'duplicate-site.mjs';
    const sources = [{ sourcePath,
      text: 'function root(){[1].map(producer);[2].map(producer)} function producer(){}' }];
    const request = { ownerId: 'duplicate', rootCallables: [{ sourcePath, name: 'root' }] };
    const duplicate = () => analyzeCallbackReachabilityBatch({ sources, entrySourcePath: sourcePath,
      ownerRequests: [request, request] }).ownerResults;
    expect.soft(duplicate, 'duplicate owner diagnostic surface').not.toThrow();
    expect.soft(duplicate().map(row => [row.diagnostics, row.reachableCallableNames, row.rejections]))
      .toEqual(Array(2).fill([['duplicate owner id: duplicate'], [], []]));
    const single = analyzeCallbackReachabilityBatch({ sources, entrySourcePath: sourcePath,
      ownerRequests: [request] }).ownerResults[0];
    const target = single.reachableCallables.find(row => row.name === 'producer')!;
    expect(single.terminalProvenance.find(row => row.identity === target.identity)?.predecessors
      .filter(row => row.kind === 'array-callback')).toHaveLength(1);
  });

  it('isolates owner masks and bounds candidate and ordinary graph work', () => {
    const a = candidate('A', 'a', 'shared', 'a'), b = candidate('B', 'b', 'shared', 'b');
    const alone = solve(['A'], [a], [['A', 'a'], ['A', 'b']]);
    const paired = solve(['A', 'B'], [a, b], [['A', 'a'], ['A', 'b'], ['B', 'b']]);
    expect.soft(ownerRows(paired, 'A'), 'A-alone/A-with-B candidate-membership bytes')
      .toBe(ownerRows(alone, 'A'));

    const width = 48, ordinary = chain('n', width);
    const candidateChain = Array.from({ length: width }, (_, index) => (
      candidate('S', `n${index}`, `n${index + 1}`, `chain-${index}`)
    ));
    const scaled = solve(['S'], candidateChain, [['S', 'n0']]).summary;
    expectChecks('bounded candidate work', {
      propagation: scaled.threatPropagationVisits <= width && scaled.threatPropagationEdges <= width,
      dependencies: scaled.threatDependencyEdges <= width,
      wakes: scaled.candidateWakeOperations <= width * 2,
      readiness: scaled.candidateReadinessChecks <= width * 4,
      queue: scaled.candidateQueuePushes <= width && scaled.candidateQueuePops <= width,
      scc: scaled.candidateSccRuns === 1 && scaled.candidateSccNodeVisits <= width
        && scaled.candidateSccEdgeVisits <= width,
    });

    const zeroCandidates = Array.from({ length: width }, (_, index) => (
      candidate('S', `p${index}`, `n${index}`, `ordinary-${index}`)
    ));
    const zero = solve(['S'], zeroCandidates, [], undefined, ordinary).summary;
    const sparse = solve(['S'], [...zeroCandidates, candidate('S', `n${width}`, 'sink', 'sparse')],
      [], undefined, ordinary).summary;
    expectChecks('zero and sparse dependency work', {
      zeroVisits: zero.threatPropagationVisits <= width + 1,
      zeroEdges: zero.threatPropagationEdges <= width,
      zeroDependencies: zero.threatDependencyEdges === 0,
      sparseVisits: sparse.threatPropagationVisits <= width + 2,
      sparseEdges: sparse.threatPropagationEdges <= width,
      sparseDependencies: sparse.threatDependencyEdges <= width,
      condensation: zero.condensationNodeVisits <= zero.nodes * 2
        && zero.condensationArcVisits <= width * 3 && sparse.condensationNodeVisits <= sparse.nodes * 2
        && sparse.condensationArcVisits <= width * 3,
    });

    const owners = Array.from({ length: width }, (_, index) => `O${index}`);
    const seeds = owners.map(owner => [owner, 'n0'] as [string, string]);
    const forward = solve(owners, [], seeds, undefined, ordinary, true);
    const reverse = solve([...owners].reverse(), [], [...seeds].reverse(), undefined,
      [...ordinary].reverse(), true);
    expect.soft(JSON.stringify(forward), 'dense forward/reverse permutation bytes')
      .toBe(JSON.stringify(reverse));
    expect.soft(ownerRows(forward, 'O0'), 'dense owner isolation')
      .toBe(ownerRows(solve(['O0'], [], [['O0', 'n0']], undefined, ordinary, true), 'O0'));
    const denseCandidates = owners.map((owner, index) => (
      candidate(owner, `n${width}`, 'n0', `dense-${index}`)
    ));
    const dense = solve(owners, denseCandidates, [], undefined, ordinary);
    const denseReverse = solve([...owners].reverse(), [...denseCandidates].reverse(), [], undefined,
      [...ordinary].reverse());
    expect.soft(JSON.stringify(dense.adjudications), 'dense candidate-mask permutation bytes')
      .toBe(JSON.stringify(denseReverse.adjudications));
    expectChecks('dense mask and condensation work', {
      factEdges: forward.summary.edgeAtomTraversals <= width,
      witnessEdges: forward.summary.witnessEdgeVisits <= width,
      maskDependencies: dense.summary.threatDependencyEdges === width,
      maskSccEdges: dense.summary.candidateSccEdgeVisits === width,
      condensationNodes: forward.summary.condensationNodeVisits <= (width + 1) * 2,
      condensationArcs: forward.summary.condensationArcVisits <= width * 3,
    });
    const predecessor = solve(['A', 'B'], [], [['A', 'n0'], ['B', 'n0']], undefined,
      ordinary, true, true);
    for (const projection of predecessor.projections) {
      expect.soft((projection.path as Array<{ owner?: string }>).slice(1)
        .every(edge => edge.owner === projection.owner),
      `owner-authenticated predecessor:${projection.owner}`).toBe(true);
    }
  });

  it('uses iterative bounded SCC, root-lane, sparse-mask, and witness structures', () => {
    const deepWidth = 4096, deepArcs = chain('d', deepWidth);
    const deepGraph = direct.condenseDirectionalGraphs({ graphs: [{ key: 'forward',
      nodes: Array.from({ length: deepWidth + 1 }, (_, index) => `d${index}`),
      arcs: deepArcs.map(([source, target]) => ({ key: `${source}:${target}`, source, target,
        sourceFactKind: 'root', targetFactKind: 'root' })) }] });
    expectChecks('iterative deep condensation', {
      nodes: deepGraph.summary.nodeVisits <= (deepWidth + 1) * 2,
      arcs: deepGraph.summary.arcVisits <= deepWidth * 3,
    });
    const rootedNodes = Array.from({ length: 801 }, (_, index) => `r${index}`);
    const rootedSites = new Map(rootedNodes.slice(1).map((target, index) => (
      [target, [{ caller: rootedNodes[index] }]]
    )));
    const rooted = direct.indexRootedCallsiteLanes({ roots: [rootedNodes[0]],
      callSitesByTarget: rootedSites, isRootSite: () => false });
    expect.soft(rooted.rootsByTarget.get(rootedNodes.at(-1)!)?.has(rootedNodes[0]),
      'reverse-chain root closure').toBe(true);
    expectChecks('no hidden root rescans', {
      queue: rooted.summary.queuePops <= rootedNodes.length,
      arcs: rooted.summary.arcVisits <= rootedNodes.length,
    });
    const witnessDepth = 2048;
    const witness = solve(['A'], [], [['A', 'w0']], undefined, chain('w', witnessDepth), true);
    const outputElements = witness.projections.reduce((sum, row) => sum + row.path.length, 0);
    expectChecks('persistent witness allocation bounds', {
      records: witness.summary.witnessPathRecords <= witnessDepth + 2,
      working: witness.summary.witnessWorkingPathElements <= witnessDepth + 2,
      ancestors: witness.summary.witnessAncestorPointers <= witness.summary.witnessPathRecords,
      paths: witness.summary.witnessMaterializedPaths === witness.projections.length,
      elements: witness.summary.witnessMaterializedPathElements === outputElements,
    });
    for (const width of [250, 500, 1000, 2000]) {
      const owners = Array.from({ length: width }, (_, index) => `M${index}`);
      const summary = solve(owners, [], [[owners.at(-1)!, 'm0']], undefined, chain('m', width)).summary;
      expect.soft(summary.ownerBitInspections, `sparse active-bit decoding:${width}`)
        .toBe((width + 1) * 2);
    }
  });

  it('traverses canonical multipaths and multi-owner shared suffixes exactly once', () => {
    for (const width of [100, 200]) {
      const selectors = Array.from({ length: width }, (_, index) => `b${String(index).padStart(3, '0')}`);
      const shared = Array.from({ length: width + 1 }, (_, index) => `a${String(index).padStart(3, '0')}`);
      const multipath = [...selectors.map(node => ['root', node] as [string, string]),
        ...selectors.map((node, index) => [node, shared[index]] as [string, string]),
        ...shared.slice(0, -1).map((node, index) => [node, shared[index + 1]] as [string, string])];
      const forward = solve(['A'], [], [['A', 'root']], undefined, multipath, true);
      const reverse = solve(['A'], [], [['A', 'root']], undefined, [...multipath].reverse(), true);
      const nodeBound = selectors.length + shared.length + 1;
      const output = forward.projections.reduce((sum, row) => sum + row.path.length, 0);
      const expectedNodes = ['root', ...selectors, ...shared].sort();
      const factNodes = forward.facts.map(row => (JSON.parse(row.key) as string[])[2]).sort();
      const projectionNodes = forward.projections.map(row => row.node).sort();
      const comparisonBound = (multipath.length + nodeBound)
        * (Math.ceil(Math.log2(nodeBound)) + 1) * 4;
      expect.soft(ownerRows(forward, 'A'), `multipath permutation bytes:${width}`)
        .toBe(ownerRows(reverse, 'A'));
      expect.soft({ visits: forward.summary.witnessEdgeVisits, ranks: forward.summary.witnessImprovements,
        queuePops: forward.summary.witnessQueuePops,
        queuePushes: forward.summary.witnessEnqueueSuccesses, stale: forward.summary.witnessStalePops,
        comparisons: forward.summary.witnessHeapComparisons <= comparisonBound
          && forward.summary.witnessRankComparisons <= comparisonBound,
        records: forward.summary.witnessPathRecords, working: forward.summary.witnessWorkingPathElements,
        ancestors: forward.summary.witnessAncestorPointers, facts: factNodes,
        adjudications: forward.adjudications.length, projections: projectionNodes,
        output: forward.summary.witnessMaterializedPathElements }, `multipath exact BFS/output:${width}`)
        .toEqual({ visits: multipath.length, ranks: nodeBound, queuePops: nodeBound,
          queuePushes: nodeBound, stale: 0, comparisons: true, records: multipath.length + 1,
          working: multipath.length + 1, ancestors: multipath.length + 1, facts: expectedNodes,
          adjudications: 0, projections: expectedNodes, output });
    }
    const depth = 64, suffix = chain('s', depth);
    const edges = [['r1', 's0'], ['r2', 's0'], ...suffix] as Array<[string, string]>;
    const seeds = [['A', 'r1'], ['A', 'r2'], ['B', 'r1'], ['B', 'r2']] as Array<[string, string]>;
    const forward = solve(['A', 'B'], [], seeds, undefined, edges, true);
    const reverse = solve(['B', 'A'], [], [...seeds].reverse(), undefined, [...edges].reverse(), true);
    expect.soft({ visits: forward.summary.witnessEdgeVisits,
      improvements: forward.summary.witnessImprovements, queue: forward.summary.witnessQueuePops,
      stale: forward.summary.witnessStalePops, masks: forward.summary.witnessMaskDeltas,
      groups: forward.summary.witnessPathGroupBuilds,
      ownerInspections: forward.summary.witnessTransferOwnerInspections, facts: forward.facts.length,
      adjudications: forward.adjudications.length, projections: forward.projections.length,
      permutation: JSON.stringify(forward) === JSON.stringify(reverse) },
    'multi-owner/root shared suffix is traversed once').toEqual({ visits: depth + 2,
      improvements: depth + 3, queue: depth + 3, stale: 0, masks: depth + 5,
      groups: depth + 2, ownerInspections: (depth + 2) * 2, facts: (depth + 3) * 2,
      adjudications: 0, projections: (depth + 3) * 2, permutation: true });
  });

  it('authenticates all receipt fields before every classification publication', () => {
    const canonical = candidate('A', 'producer', 'target', 'receipt');
    const ambiguousA = candidate('A', 'left', 'ambiguous', 'ambiguous-a');
    const ambiguousB = candidate('A', 'right', 'ambiguous', 'ambiguous-b');
    const ignoreCommit = candidate('A', 'duplicate', 'ignored', 'ignore-a');
    const ignoreTarget = candidate('A', 'duplicate', 'ignored', 'ignore-z');
    const cyclic = candidate('A', 'cycle', 'cycle', 'cycle');
    const outcomes = [
      ['COMMIT', [canonical], [['A', 'producer']], canonical],
      ['UNROOTED_PRODUCER', [canonical], [], canonical],
      ['AMBIGUOUS_PRODUCERS', [ambiguousA, ambiguousB], [['A', 'left'], ['A', 'right']], ambiguousA],
      ['CYCLIC_PRODUCER_DEPENDENCY', [cyclic], [], cyclic],
      ['IGNORE', [ignoreCommit, ignoreTarget], [['A', 'duplicate']], ignoreTarget],
    ] as Array<[string, Array<ReturnType<typeof candidate>>, Array<[string, string]>,
      ReturnType<typeof candidate>]>;
    const drifts = [['owner', 'owner', 'B'], ['arc', 'arcKey', 'arc:other'],
      ['source', 'producerNode', 'other'], ['targetNode', 'targetNode', 'other'],
      ['producer', 'producer', 'other'], ['caller', 'caller', 'other'],
      ['callsite', 'callsite', 'other'], ['target', 'target', 'other'],
      ['argumentIndex', 'argumentIndex', 1]] as const;
    for (const [classification, candidates, seeds, target] of outcomes) {
      const baseline = solve(['A'], candidates, seeds);
      expect(baseline.adjudications.find(row => row.arcKey === target.arcKey)?.classification,
        `${classification} baseline`).toBe(classification);
      for (const [label, field, drift] of drifts) {
        const mutated = mutatedSolver(target.arcKey, field, drift);
        const effects = { mapperCalls: 0, transfers: 0, summaries: 0, paths: 0 };
        expect.soft(() => solve(['A'], candidates, seeds, effects, [], true, false, mutated.module),
          `${classification}:${label} post-intake mutation`)
          .toThrow(/candidate receipt mismatch before publication/);
        expect.soft({ transfers: effects.transfers, summaries: effects.summaries, paths: effects.paths },
          `${classification}:${label} zero transfer, provenance, or summary publication`)
          .toEqual({ transfers: 0, summaries: 0, paths: 0 });
        expect.soft(mutated.published, `${classification}:${label} zero result publication`).toBeNull();
      }
    }
    for (const boundary of ['after-adjudication-check', 'after-transfer', 'before-summary'] as const) {
      for (const [label, field, drift] of drifts) {
        const mutated = mutatedSolver(canonical.arcKey, field, drift, boundary);
        const effects = { mapperCalls: 0, transfers: 0, summaries: 0, paths: 0 };
        expect.soft(() => solve(['A'], [canonical], [['A', 'producer']], effects, [], true, false,
          mutated.module), `${boundary}:${label}`).toThrow(/candidate receipt mismatch before publication/);
        expect.soft(effects, `${boundary}:${label} publishes no transfer, provenance, or summary`)
          .toEqual({ mapperCalls: 0, transfers: 0, summaries: 0, paths: 0 });
        expect.soft(mutated.published, `${boundary}:${label} publishes no result`).toBeNull();
      }
    }
  });
});
