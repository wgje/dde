import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const facadePath = 'scripts/query-codegraph-nanoflow-overlay.mjs';
const executionPaths = [facadePath, 'scripts/lib/codegraph-overlay-current-receipt.cjs',
  'scripts/lib/codegraph-overlay-query-terms.mjs', 'scripts/lib/codegraph-overlay-native-codeblock-evidence.mjs',
  'scripts/lib/codegraph-overlay-candidate-index.mjs', 'scripts/lib/codegraph-overlay-semantic-selection.mjs',
  'scripts/lib/codegraph-overlay-context-assembly.mjs', 'scripts/lib/codegraph-overlay-native-codeblock-selection.mjs',
  'scripts/lib/codegraph-overlay-output-projection.mjs'];
const owners = ['queryOverlay', 'scoreCandidate', 'selectGraphResults', 'formatStrictNativeMarkdown',
  'toNativeJsonFormatterResponse', 'formatNativeMarkdown'];
const implementationPaths: Record<string, string> = {
  queryOverlay: executionPaths[4], scoreCandidate: executionPaths[4], selectGraphResults: executionPaths[5],
  formatStrictNativeMarkdown: executionPaths[8], toNativeJsonFormatterResponse: executionPaths[8], formatNativeMarkdown: executionPaths[8],
};
const sources = executionPaths.map(sourcePath => ({ sourcePath, text: fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8') }));
const source = sources[0].text;
type Edge = { sourceIdentity: number; targetIdentity: number; sourcePath: string; line: number | null;
  column: number | null; endLine: number | null; endColumn: number | null };
type Callable = { sourcePath: string; name: string; identity: number };
type Flow = { ownerId: string; diagnostics: string[]; resolvedRoots: Callable[]; reachableCallables: Callable[];
  provenancePaths: { identity: number; path: Edge[] }[]; terminalProvenance: { identity: number; predecessors: Edge[] }[] };
const { analyzeCallbackReachabilityBatch } = createRequire(__filename)(
  path.join(repoRoot, 'scripts/lib/codegraph-overlay-callback-reachability.cjs'),
) as { analyzeCallbackReachabilityBatch(input: unknown): { ownerResults: Flow[] } };

function nodes(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    result.push(node);
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return result;
}
function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root).filter(ts.isCallExpression).filter(call => ts.isIdentifier(call.expression) && call.expression.text === name);
}
function outerFunction(node: ts.Node): ts.FunctionDeclaration | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent;
  }
  return null;
}
function checkWiring(text: string): ts.SourceFile {
  const file = ts.createSourceFile(facadePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = (name: string) => {
    const matches = file.statements.filter(ts.isFunctionDeclaration).filter(fn => fn.name?.text === name);
    expect(matches, `one current ${name} declaration`).toHaveLength(1);
    return matches[0];
  };
  const readerImport = file.statements.filter(ts.isImportDeclaration)
    .filter(node => node.moduleSpecifier.getText(file) === "'./lib/codegraph-overlay-current-receipt.cjs'");
  expect(readerImport).toHaveLength(1);
  expect(readerImport[0].importClause?.name?.text).toBe('currentReceiptReader');
  const readerBinding = nodes(file).filter(ts.isVariableDeclaration)
    .filter(node => ts.isObjectBindingPattern(node.name)
      && node.name.elements.some(element => element.name.getText(file) === 'readOverlayCurrentReceipt'));
  expect(readerBinding).toHaveLength(1);
  expect(readerBinding[0].initializer?.getText(file)).toBe('currentReceiptReader');
  const worker = declaration('runOverlayQueryWorker');
  const execute = declaration('executeOverlayQuery');
  const receipts = calls(file, 'readOverlayCurrentReceipt');
  expect(receipts).toHaveLength(2);
  for (const name of ['runOverlayQueryWorker', 'executeOverlayQuery']) {
    const call = receipts.filter(value => outerFunction(value)?.name?.text === name);
    expect(call, `${name} owns one receipt read`).toHaveLength(1);
    expect(call[0].arguments.map(arg => arg.getText(file))).toEqual(['root']);
    expect(ts.isArrowFunction(call[0].parent) && call[0].parent.body === call[0]).toBe(true);
    const parent = call[0].parent.parent as ts.CallExpression;
    expect(parent.expression.getText(file)).toBe('profilePhase');
    expect(parent.arguments[0].getText(file)).toBe("'readOverlayCurrentReceipt'");
  }
  const prewarm = nodes(worker).filter(ts.isIfStatement)
    .filter(node => node.expression.getText(file) === "request.args.includes('--prewarm')");
  expect(prewarm).toHaveLength(1);
  expect(calls(prewarm[0].thenStatement, 'readOverlayCurrentReceipt')).toHaveLength(1);
  expect(calls(prewarm[0].thenStatement, 'executeOverlayQuery')).toHaveLength(0);
  expect(nodes(prewarm[0].thenStatement).filter(ts.isContinueStatement)).toHaveLength(1);
  const dispatches = calls(file, 'executeOverlayQuery');
  expect(dispatches).toHaveLength(2);
  expect(dispatches.filter(call => outerFunction(call) === worker)).toHaveLength(1);
  expect(dispatches.filter(call => outerFunction(call) === null)).toHaveLength(1);
  for (const call of dispatches) expect(call.arguments.map(arg => arg.getText(file))).toEqual(['args', 'root']);
  const workerBranch = file.statements.filter(ts.isIfStatement)
    .filter(node => node.expression.getText(file) === "process.argv[2] === '--worker'");
  expect(workerBranch).toHaveLength(1);
  expect(calls(workerBranch[0].thenStatement, 'runOverlayQueryWorker')).toHaveLength(1);
  expect(workerBranch[0].elseStatement).toBeDefined();
  expect(calls(workerBranch[0].elseStatement!, 'executeOverlayQuery')).toHaveLength(1);
  const rootFence = nodes(worker).filter(ts.isIfStatement)
    .find(node => node.expression.getText(file) === 'requestedRoot !== root');
  expect(rootFence, 'worker cannot query another root').toBeDefined();
  expect(nodes(rootFence!.thenStatement).filter(ts.isThrowStatement)).toHaveLength(1);
  for (const installer of ['installQueryTerms', 'installNativeCodeblockEvidence', 'installCandidateIndex',
    'installSemanticSelection', 'installContextAssembly', 'installNativeCodeblockSelection', 'installOutputProjection']) {
    const installCalls = calls(file, installer);
    expect(installCalls, `${installer} is installed once`).toHaveLength(1);
    expect(installCalls[0].arguments.map(arg => arg.getText(file))).toEqual(['overlayQueryRuntime']);
  }
  expect(calls(execute, 'queryOverlay')).toHaveLength(1);
  return file;
}
function analyze(text = source, rootNames = owners): Flow[] {
  return analyzeCallbackReachabilityBatch({ sources: sources.map(value => value.sourcePath === facadePath ? { ...value, text } : value),
    entrySourcePath: facadePath,
    ownerRequests: rootNames.map(name => ({ ownerId: name, rootCallables: [{ sourcePath: facadePath, name }] })),
  }).ownerResults;
}
function requireImplementation(flow: Flow, owner: string): void {
  expect(flow.diagnostics).toEqual([]);
  const root = flow.resolvedRoots.find(value => value.sourcePath === facadePath && value.name === owner);
  const targets = flow.reachableCallables.filter(value => value.sourcePath === implementationPaths[owner] && value.name === owner);
  expect(root).toBeDefined();
  expect(targets).toHaveLength(1);
  const trail = flow.provenancePaths.find(value => value.identity === targets[0].identity)?.path;
  expect(trail).toBeDefined();
  expect(trail![0].targetIdentity).toBe(root!.identity);
  expect(trail!.at(-1)?.targetIdentity).toBe(targets[0].identity);
  expect(trail!.every((edge, index) => index === 0 || trail![index - 1].targetIdentity === edge.sourceIdentity)).toBe(true);
}
function mutated(from: string, to: string): string {
  expect(source.includes(from), 'negative mutation must land in current source').toBe(true);
  return source.replace(from, to);
}

describe('current CodeGraph worker and CLI wiring (not release coordinates)', () => {
  it('separates prewarm and execution receipts, preserves root fencing and shares CLI/worker execution', () => {
    checkWiring(source);
  });
  it('solves all six current wrapper-to-implementation owners with contiguous provenance', () => {
    const flows = analyze();
    expect(flows).toHaveLength(6);
    flows.forEach(flow => requireImplementation(flow, flow.ownerId));
  });
  it('attributes current nested execution callbacks to actual AST call locations', () => {
    const file = checkWiring(source);
    const flow = analyze(source, ['executeOverlayQuery'])[0];
    expect(flow.diagnostics).toEqual([]);
    const execute = file.statements.filter(ts.isFunctionDeclaration).find(fn => fn.name?.text === 'executeOverlayQuery')!;
    for (const name of owners.filter(name => name !== 'scoreCandidate')) {
      const astCall = calls(execute, name)[0];
      expect(astCall).toBeDefined();
      const target = flow.reachableCallables.find(value => value.sourcePath === facadePath && value.name === name);
      expect(target, `${name} current execution is reachable`).toBeDefined();
      const start = file.getLineAndCharacterOfPosition(astCall.getStart(file));
      const end = file.getLineAndCharacterOfPosition(astCall.getEnd());
      const last = flow.provenancePaths.find(value => value.identity === target!.identity)?.path.at(-1);
      expect(last).toMatchObject({ sourcePath: facadePath, targetIdentity: target!.identity,
        line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 });
    }
  });
  it.each([
    ['wrong receipt import', './lib/codegraph-overlay-current-receipt.cjs', './lib/other-receipt.cjs'],
    ['wrong receipt root', 'readOverlayCurrentReceipt(root)', 'readOverlayCurrentReceipt(otherRoot)'],
    ['missing execution receipt', "const currentReceipt = profilePhase('readOverlayCurrentReceipt', () => readOverlayCurrentReceipt(root));", 'const currentReceipt = null;'],
    ['missing prewarm receipt', "const receipt = profilePhase('readOverlayCurrentReceipt', () => readOverlayCurrentReceipt(root));", 'const receipt = null;'],
    ['wrong dispatch arguments', 'executeOverlayQuery(args, root)', 'executeOverlayQuery(args, requestedRoot)'],
    ['wrong installer runtime', 'installOutputProjection(overlayQueryRuntime);', 'installOutputProjection(otherRuntime);'],
  ])('rejects %s rather than accepting the same receipt/call count', (_label, from, to) => {
    expect(() => checkWiring(mutated(from, to))).toThrow();
  });
  it('does not report implementation reachability after a wrapper stops delegating', () => {
    const broken = mutated('function queryOverlay(...values) { return queryOverlayImpl(...values); }',
      'function queryOverlay(...values) { return undefined; }');
    const flow = analyze(broken, ['queryOverlay'])[0];
    expect(() => requireImplementation(flow, 'queryOverlay')).toThrow();
  });
});
