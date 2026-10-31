import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(__filename);
const facadeSourcePath = 'scripts/query-codegraph-nanoflow-overlay.mjs';
const currentReceiptSourcePath = 'scripts/lib/codegraph-overlay-current-receipt.cjs';
const sourcePaths = [facadeSourcePath, 'scripts/lib/codegraph-overlay-query-terms.mjs',
  'scripts/lib/codegraph-overlay-native-codeblock-evidence.mjs', 'scripts/lib/codegraph-overlay-candidate-index.mjs',
  'scripts/lib/codegraph-overlay-semantic-selection.mjs', 'scripts/lib/codegraph-overlay-context-assembly.mjs',
  'scripts/lib/codegraph-overlay-native-codeblock-selection.mjs', 'scripts/lib/codegraph-overlay-output-projection.mjs'] as const;
const releasedExecutionSourceShas = new Map([
  [facadeSourcePath, '1eda64dbdec47fe002e76be6d7af16ecc0cb576f88d6e2f22a44de7581681e61'],
  [currentReceiptSourcePath, '7c971f4e6651d841f2ba92c8c2b9a71a36ca92e914f5b882842950b9a972830d'],
  [sourcePaths[1], '0ab0960ba8085eb459b948341f3306679971ba847524553de0010bee13fbdb2d'],
  [sourcePaths[2], '6c59275f5bb62fa62d3eb2663e26d81a7d0217f2901ad48c7f4e9885bc78bcdd'],
  [sourcePaths[3], '9dfff9d2a6f0d0b293f0e670453379ab8ffdd8a35a9e9958a9d327d67bc7533a'],
  [sourcePaths[4], '417350bf7f7a5f4e1c39ed2d63e09feb949ca5bd1356be47d440c9152ea84a76'],
  [sourcePaths[5], '61b33839231aa6e936eb63240f8bef4d1475a9bb332503608fdce44ece49923e'],
  [sourcePaths[6], 'bc5595d3d3827e90956669c8217f1d97c8212f6a70b36d851599e433af8e54b8'],
  [sourcePaths[7], 'c77e44e5679ab8ed04ac48580c9abfe75fb284c998e02792f17c305c08ad8eed'],
]);
const releasedNormalizedDigest = 'dd75d6377dcf78eb2b0590332b1d90f23ad04752c62931f17110cb54dd2e5248';
const manifestPath = path.join(repoRoot, 'docs', 'codegraph-nanoflow-dedup-contract.json');
const ownerNames = ['queryOverlay', 'scoreCandidate', 'selectGraphResults', 'formatStrictNativeMarkdown',
  'toNativeJsonFormatterResponse', 'formatNativeMarkdown'] as const;
type OwnerName = typeof ownerNames[number];
type Classification = 'A' | 'B' | 'C' | 'D' | 'S'; type EdgeKind = 'root' | 'root-call' | 'call' | 'array-callback' | 'value-frame';
type CallableRecord = { sourcePath: string; name: string; identity: number };
type ProvenanceEdge = { kind: EdgeKind; sourceIdentity: number; targetIdentity: number; sourcePath: string;
  line: number | null; column: number | null; endLine: number | null; endColumn: number | null };
type ReachabilityResult = {
  ownerId: string; resolvedRoots: CallableRecord[]; reachableCallables: CallableRecord[]; reachableCallableNames: string[]; diagnostics: string[];
  provenancePaths: Array<{ identity: number; path: ProvenanceEdge[] }>;
  terminalProvenance: Array<{ identity: number; predecessors: ProvenanceEdge[] }>;
  rejections: Array<{ code: 'UNROOTED_PRODUCER' | 'AMBIGUOUS_PRODUCERS' | 'CYCLIC_PRODUCER_DEPENDENCY'; owner: string;
    producer: string; caller: string; callsite: string; target: string; argumentIndex: number | null; reason: string }>;
};
type SolverSummary = {
  directions: number; owners: number; nodes: number; edges: number; factKinds: number; condensationNodeVisits: number; condensationArcVisits: number;
  atomCountByFactKind: Record<string, number>; latticeHeight: number; candidateLanes: number;
  firstFactInsertions: number; factSetImprovements: number; producerSetImprovements: number;
  newAtomInsertions: number; enqueueAttempts: number; enqueueSuccesses: number;
  duplicateEnqueueSuppressions: number; queuePops: number; stalePops: number;
  transferApplications: number; edgeAtomTraversals: number; candidateAdjudications: number;
  witnessImprovements: number; witnessEnqueueSuccesses: number; witnessQueuePops: number; witnessStalePops: number; witnessEdgeVisits: number; ordinaryCandidateEdges: number;
  ownerBitInspections: number; witnessPathRecords: number; witnessWorkingPathElements: number; witnessAncestorPointers: number; witnessHeapComparisons: number; witnessRankComparisons: number; witnessMaterializedPaths: number; witnessMaterializedPathElements: number;
  rootLaneQueuePops: number; rootLaneStateInsertions: number; rootLaneArcVisits: number; eagerSiteSeeds: number; eagerSiteQueuePops: number; eagerDependencyChecks: number; eagerDependencyWakes: number;
  threatPropagationVisits: number; threatPropagationEdges: number; threatDependencyEdges: number; candidateReadinessChecks: number;
  candidateWakeOperations: number; candidateQueuePushes: number; candidateQueuePops: number; candidateSccRuns: number; candidateSccNodeVisits: number; candidateSccEdgeVisits: number;
}; type ReachabilityModule = {
  analyzeCallbackReachabilityBatch(input: {
    sources: Array<{ sourcePath: string; text: string }>;
    entrySourcePath: string;
    ownerRequests: Array<{
      ownerId: string;
      rootCallables: Array<{ sourcePath: string; name: string }>;
    }>;
    instrumentation?: {
      onProgramBuild?(): void;
      onFixedPointRun?(event?: { ownerIds: string[] }): void;
      onSharedStateCreate?(event?: { ownerIds: string[] }): void;
      onSchedulerRun?(event?: { ownerIds: string[] }): void;
      onSolverSummary?(event: SolverSummary): void;
    };
  }): { ownerResults: ReachabilityResult[] };
};
type Hotspot = { name: string; sourceSymbols?: string[]; coveredChildSymbols?: string[] };
type GapExpectation = {
  originalOwner: OwnerName; classification: Classification; expectedOwner: OwnerName; expectedRoot: string;
  child: string; caller: string; childSourcePath: string; callerSourcePath: string;
  terminal: readonly [line: number, column: number, endLine: number, endColumn: number, kind: EdgeKind];
  firstBlocked: readonly [line: number, column: number, endLine: number, endColumn: number, kind: string] | null;
  blockedNow: boolean;
};
const { analyzeCallbackReachabilityBatch } = require(
  path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-callback-reachability.cjs'),
) as ReachabilityModule;
const rootDeclarationPaths: Record<string, string> = {
  queryOverlay: facadeSourcePath, scoreCandidate: facadeSourcePath, selectGraphResults: facadeSourcePath,
  selectEntryPoints: sourcePaths[5], orderRelatedFilesForQuery: sourcePaths[1], formatStrictNativeMarkdown: facadeSourcePath,
  buildRelationshipGroups: sourcePaths[5], capRelationshipGroups: sourcePaths[5], buildNativeCodeBlocks: facadeSourcePath,
  buildBlastRadiusEntries: sourcePaths[5], buildNotShownEntries: sourcePaths[5], formatSummary: sourcePaths[5],
  buildSourceBlocks: facadeSourcePath, toNativeJsonFormatterResponse: facadeSourcePath, formatNativeMarkdown: facadeSourcePath,
};
const wrapperBackedRoots = [['queryOverlay', 'queryOverlay', sourcePaths[3]], ['scoreCandidate', 'scoreCandidate', sourcePaths[3]],
  ['selectGraphResults', 'selectGraphResults', sourcePaths[4]], ['formatStrictNativeMarkdown', 'buildSourceBlocks', sourcePaths[5]],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', sourcePaths[6]], ['formatNativeMarkdown', 'formatNativeMarkdown', sourcePaths[7]],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', sourcePaths[7]],
  ['toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponse', sourcePaths[7]]] as const satisfies ReadonlyArray<readonly [OwnerName, string, string]>;
const releasedFacadeRootCalls = [
  ['queryOverlay', 'queryOverlay', 303, 52, 303, 97],
  ['selectGraphResults', 'selectGraphResults', 304, 65, 304, 125],
  ['formatStrictNativeMarkdown', 'buildSourceBlocks', 368, 64, 374, 4],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 377, 66, 383, 4],
  ['formatNativeMarkdown', 'formatNativeMarkdown', 410, 68, 410, 112],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 413, 56, 413, 92],
] as const satisfies ReadonlyArray<readonly [OwnerName, string, number, number, number, number]>;
const priorReleasedFacadeRootCalls = [
  ['queryOverlay', 'queryOverlay', 283, 52, 283, 97],
  ['selectGraphResults', 'selectGraphResults', 284, 65, 284, 125],
  ['formatStrictNativeMarkdown', 'buildSourceBlocks', 347, 64, 353, 4],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 356, 66, 362, 4],
  ['formatNativeMarkdown', 'formatNativeMarkdown', 389, 68, 389, 112],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 392, 56, 392, 92],
] as const satisfies ReadonlyArray<readonly [OwnerName, string, number, number, number, number]>;
const legacyFacadeRootCalls = [
  ['queryOverlay', 'queryOverlay', 277, 52, 277, 97],
  ['selectGraphResults', 'selectGraphResults', 278, 65, 278, 125],
  ['formatStrictNativeMarkdown', 'buildSourceBlocks', 341, 64, 347, 4],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 350, 66, 356, 4],
  ['formatNativeMarkdown', 'formatNativeMarkdown', 383, 68, 383, 112],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 386, 56, 386, 92],
] as const satisfies ReadonlyArray<readonly [OwnerName, string, number, number, number, number]>;
function gapRows(
  originalOwner: OwnerName,
  classification: Classification,
  expectedOwner: OwnerName,
  expectedRoot: string,
  rows: ReadonlyArray<readonly [child: string, childPath: number, caller: string, callerPath: number,
    line: number, column: number, endLine: number, endColumn: number, kind?: EdgeKind,
    blockedLine?: number, blockedColumn?: number, blockedEndLine?: number, blockedEndColumn?: number,
    blockedKind?: string, blockedNow?: boolean]>,
): GapExpectation[] {
  return rows.map(([child, childPath, caller, callerPath, line, column, endLine, endColumn, kind = 'call',
    blockedLine = line, blockedColumn = column, blockedEndLine = endLine, blockedEndColumn = endColumn,
    blockedKind = kind, blockedNow = false]) => ({
    originalOwner, classification, expectedOwner, expectedRoot, child, caller,
    childSourcePath: sourcePaths[childPath], callerSourcePath: sourcePaths[callerPath],
    terminal: [line, column, endLine, endColumn, kind],
    firstBlocked: classification === 'D'
      ? [blockedLine, blockedColumn, blockedEndLine, blockedEndColumn, blockedKind] : null,
    blockedNow,
  }));
}
const expectedGaps: GapExpectation[] = [
  ...gapRows('queryOverlay', 'C', 'scoreCandidate', 'scoreCandidate', [
    ['scoreNanoFlowSemanticCandidate', 3, 'scoreCandidate', 3, 119, 12, 119, 98],
  ]),
  ...gapRows('scoreCandidate', 'C', 'queryOverlay', 'queryOverlay', [
    ['scoreExplicitCandidateMatch', 3, 'queryOverlay', 3, 38, 29, 38, 96],
    ['scoreFocusedCandidateMatch', 3, 'queryOverlay', 3, 37, 28, 37, 79],
    ['scoreExplicitQueryTermText', 1, 'scoreExplicitCandidateMatch', 3, 146, 12, 152, 6],
  ]),
  ...gapRows('scoreCandidate', 'D', 'scoreCandidate', 'scoreCandidate', [
    ['queryTokens', 0, 'scoreCandidate', 3, 118, 58, 118, 76, 'call', 118, 58, 118, 76, 'default-parameter'],
  ]),
  ...gapRows('selectGraphResults', 'D', 'selectGraphResults', 'selectGraphResults', [
    ['edgeMatchesQueryTermsWithEndpoints', 3, 'selectNanoFlowRelationGraphResults', 4, 364, 40, 364, 116,
      'call', 361, 29, 362, 81, 'array-callback', true],
    ['edgeMatchesAnyQueryTermWithEndpoints', 3, 'selectNanoFlowRelationGraphResults', 4, 328, 40, 328, 118,
      'call', 325, 29, 326, 110, 'array-callback', true],
  ]),
  ...gapRows('selectGraphResults', 'S', 'formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', [
    ['scoreNodeRelevanceForQuery', 1, 'scoreNativeProjectionItemForQuery', 7, 317, 10, 317, 51],
  ]),
  ...gapRows('selectGraphResults', 'C', 'formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', [
    ['queryScoringContext', 1, 'orderNativeProjectionItems', 7, 279, 21, 279, 50],
    ['compareGeneratedFileOrder', 5, 'orderNativeProjectionItems', 7, 299, 12, 299, 53],
  ]),
  ...gapRows('selectGraphResults', 'S', 'formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', [
    ['lowInformationNodePenalty', 1, 'scoreNativeProjectionItemForQuery', 7, 316, 30, 316, 76],
    ['lowInformationFilePenalty', 1, 'lowInformationNodePenalty', 1, 434, 12, 434, 63],
    ['queryAllowsTestFiles', 1, 'lowInformationFilePenalty', 1, 457, 10, 457, 37],
    ['isLowInformationTestFilePath', 1, 'lowInformationFilePenalty', 1, 457, 41, 457, 81],
  ]),
  ...gapRows('selectGraphResults', 'C', 'selectGraphResults', 'selectEntryPoints', [
    ['selectEntryPoints', 5, '<top>', 5, 0, 0, 0, 0, 'root'],
    ['compareSyncBodyKeywordEndpointPriority', 5, 'syncBodyKeywordExactRelationEntryPointIds', 5,
      450, 19, 453, 52, 'array-callback'],
    ['compareSyncConfigKeywordEndpointPriority', 5, 'syncConfigKeywordExactRelationEntryPointIds', 5,
      459, 19, 462, 54, 'array-callback'],
    ['exactMetadataQueryFromEdges', 6, 'preferredExactRelationEntryPoints', 5, 359, 32, 359, 73],
    ['exactMetadataQueriesFromEdges', 6, 'exactMetadataQueryFromEdges', 6, 195, 12, 195, 55],
  ]),
  ...gapRows('selectGraphResults', 'C', 'selectGraphResults', 'orderRelatedFilesForQuery', [
    ['orderRelatedFilesForQuery', 1, '<top>', 1, 0, 0, 0, 0, 'root'],
  ]),
  ...gapRows('selectGraphResults', 'C', 'formatStrictNativeMarkdown', 'buildSourceBlocks', [
    ['selectedContext7RetrievalRouteIds', 6, 'scorePreferredSourceFileGroupForQuery', 5, 689, 30, 689, 90],
    ['scorePreferredSourceFileGroupForQuery', 5, 'scoreSourceFileGroupForQuery', 5, 678, 23, 678, 104],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'D', 'formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', [
    ['scoreNativeProjectionItemForQuery', 7, 'orderNativeProjectionItems', 7, 286, 10, 286, 58],
    ['compareNativeProjectionRelevance', 7, 'orderNativeProjectionItems', 7, 297, 30, 297, 68],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatStrictNativeMarkdown', 'buildRelationshipGroups', [
    ['buildRelationshipGroups', 5, '<top>', 5, 0, 0, 0, 0, 'root'],
    ['formatEdgeSource', 5, 'buildRelationshipGroups', 5, 39, 17, 39, 39],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatStrictNativeMarkdown', 'capRelationshipGroups', [
    ['capRelationshipGroups', 5, '<top>', 5, 0, 0, 0, 0, 'root'],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatStrictNativeMarkdown', 'buildNativeCodeBlocks', [
    ['buildNativeCodeBlocks', 6, 'buildNativeCodeBlocksImpl', 6, 7, 63, 7, 186],
    ['pushNativeCodeBlockWithinNativeBudget', 6, 'buildNativeCodeBlocks', 6, 106, 7, 106, 90],
    ['buildExactRelationEdgeCodeBlocks', 6, 'buildNativeCodeBlocks', 6, 67, 37, 67, 124],
    ['compareExactRelationEdgeCodeBlockOrder', 6, 'buildExactRelationEdgeCodeBlocks', 6,
      297, 52, 297, 122],
    ['compareNativeCodeBlockNodeOrder', 6, 'compareExactRelationEdgeCodeBlockOrder', 6, 315, 12, 319, 6],
    ['readNodeCodeBlock', 2, 'buildNativeCodeBlocks', 6, 106, 53, 106, 89],
    ['readEdgeLineCodeBlock', 2, 'buildExactRelationEdgeCodeBlocks', 6, 300, 11, 300, 106],
    ['pushNativeCodeBlock', 2, 'buildNativeCodeBlocks', 6, 124, 7, 124, 41],
    ['compareExplicitPathCodeBlockCandidate', 6, 'explicitPathNativeCodeBlockNodes', 6,
      242, 24, 242, 82],
    ['focusedExplicitPathCodeBlockFilePaths', 6, 'buildNativeCodeBlocks', 6, 46, 48, 46, 104],
    ['explicitPathNativeCodeBlockNodes', 6, 'buildNativeCodeBlocks', 6, 69, 37, 75, 6],
    ['exactRelationEndpointCodeBlockNodes', 6, 'buildNativeCodeBlocks', 6, 61, 32, 64, 7],
    ['prioritizeExactRelationCodeBlockEdges', 6, 'exactRelationEndpointCodeBlockNodes', 6, 480, 33, 486, 8],
    ['resolveNativeCodeBlockNode', 0, 'buildNativeCodeBlocks', 6, 60, 22, 60, 74],
    ['shouldSuppressBroadNativeCodeBlock', 6, 'buildNativeCodeBlocks', 6, 85, 15, 85, 103],
    ['suppressedNativeCodeBlockNodeIds', 6, 'buildNativeCodeBlocks', 6, 45, 40, 45, 114],
    ['suppressedExactRelationCodeBlockEndpointIds', 4, 'suppressedNativeCodeBlockNodeIds', 6, 284, 24, 284, 105],
    ['shouldSuppressLocalEvidenceEndpointForOwnerPreferredRelation', 4,
      'suppressedExactRelationCodeBlockEndpointIds', 4, 735, 11, 735, 118],
    ['buildProvenanceEdgeLineCodeBlocksForQuery', 6, 'buildProvenanceEdgeLineCodeBlocks', 6, 328, 7, 328, 90],
    ['buildProvenanceEdgeLineCodeBlocks', 6, 'buildNativeCodeBlocks', 6, 36, 38, 36, 126],
    ['compareProvenanceEdgeLineCodeBlockOrder', 6, 'buildProvenanceEdgeLineCodeBlocksForQuery', 6,
      346, 23, 346, 86],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatStrictNativeMarkdown', 'buildBlastRadiusEntries', [
    ['buildBlastRadiusEntries', 5, '<top>', 5, 0, 0, 0, 0, 'root'],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatStrictNativeMarkdown', 'buildNotShownEntries', [
    ['buildNotShownEntries', 5, '<top>', 5, 0, 0, 0, 0, 'root'],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatStrictNativeMarkdown', 'formatSummary', [
    ['formatSummary', 5, '<top>', 5, 0, 0, 0, 0, 'root'],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'selectGraphResults', 'selectEntryPoints', [
    ['suppressedExactRelationEntryPointIds', 5, 'selectEntryPoints', 5, 277, 9, 277, 66],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatNativeMarkdown', 'formatNativeMarkdown', [
    ['filterRelationshipGroupsForMarkdown', 5, 'formatNanoFlowAugmentedMarkdown', 7, 56, 48, 56, 128],
    ['formatInlineFileList', 7, 'formatNanoFlowAugmentedMarkdown', 7, 46, 28, 46, 70],
    ['formatEdgeMetadata', 7, 'formatNanoFlowAugmentedMarkdown', 7, 64, 26, 64, 50],
    ['markdownRelatedSymbolKey', 7, 'groupMarkdownRelatedNodesByFile', 7, 628, 21, 628, 51],
    ['truncateMarkdownOutput', 7, 'formatNanoFlowAugmentedMarkdown', 7, 124, 12, 124, 81],
    ['groupMarkdownRelatedNodesByFile', 7, 'formatNanoFlowAugmentedMarkdown', 7, 91, 37, 91, 84],
  ]),
  ...gapRows('formatStrictNativeMarkdown', 'C', 'formatStrictNativeMarkdown', 'buildSourceBlocks', [
    ['buildSourceBlocks', 5, 'buildSourceBlocksImpl', 5, 7, 59, 7, 165],
    ['readSourceBlock', 5, 'buildSourceBlocks', 5, 671, 39, 671, 102],
    ['formatSourceBlockSymbols', 5, 'readSourceBlock', 5, 521, 16, 521, 84],
    ['scoreSourceFileGroupForQuery', 5, 'buildSourceBlocks', 5, 659, 12, 659, 84],
    ['formatSourceWindows', 5, 'readSourceBlock', 5, 522, 16, 522, 81],
  ]),
  ...gapRows('toNativeJsonFormatterResponse', 'D', 'toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponse', [
    ['serializeNativeJsonNode', 7, 'toNativeJsonFormatterResponse', 7, 399, 20, 399, 67, 'array-callback'],
    ['serializeNativeJsonEdge', 7, 'toNativeJsonFormatterResponse', 7, 401, 14, 401, 54, 'array-callback'],
    ['nativeJsonEdgeLine', 7, 'serializeNativeJsonEdge', 7, 442, 13, 442, 37,
      'call', 401, 14, 401, 54, 'array-callback'],
    ['nativeJsonEdgeColumn', 7, 'serializeNativeJsonEdge', 7, 443, 15, 443, 41,
      'call', 401, 14, 401, 54, 'array-callback'],
    ['serializeNativeJsonCodeBlock', 7, 'toNativeJsonFormatterResponse', 7, 395, 24, 395, 75, 'array-callback'],
  ]),
];
const FORMER_M26 = ([
  ['selectGraphResults', 'selectGraphResults', 3, 'edgeMatchesQueryTermsWithEndpoints'],
  ['selectGraphResults', 'selectGraphResults', 3, 'edgeMatchesAnyQueryTermWithEndpoints'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 1, 'scoreNodeRelevanceForQuery'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 1, 'lowInformationNodePenalty'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 1, 'lowInformationFilePenalty'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 1, 'queryAllowsTestFiles'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 1, 'isLowInformationTestFilePath'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 5, 'compareGeneratedFileOrder'],
  ['selectGraphResults', 'selectEntryPoints', 5, 'compareSyncBodyKeywordEndpointPriority'],
  ['selectGraphResults', 'selectEntryPoints', 5, 'compareSyncConfigKeywordEndpointPriority'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 7, 'scoreNativeProjectionItemForQuery'],
  ['formatStrictNativeMarkdown', 'formatStrictNativeMarkdown', 7, 'compareNativeProjectionRelevance'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 6, 'compareExactRelationEdgeCodeBlockOrder'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 6, 'compareNativeCodeBlockNodeOrder'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 2, 'readEdgeLineCodeBlock'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 6, 'compareExplicitPathCodeBlockCandidate'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 0, 'resolveNativeCodeBlockNode'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 6, 'shouldSuppressBroadNativeCodeBlock'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 6, 'buildProvenanceEdgeLineCodeBlocksForQuery'],
  ['formatStrictNativeMarkdown', 'buildNativeCodeBlocks', 6, 'compareProvenanceEdgeLineCodeBlockOrder'],
  ['formatNativeMarkdown', 'formatNativeMarkdown', 7, 'markdownRelatedSymbolKey'],
  ['toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponse', 7, 'serializeNativeJsonNode'],
  ['toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponse', 7, 'serializeNativeJsonEdge'],
  ['toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponse', 7, 'nativeJsonEdgeLine'],
  ['toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponse', 7, 'nativeJsonEdgeColumn'],
  ['toNativeJsonFormatterResponse', 'toNativeJsonFormatterResponse', 7, 'serializeNativeJsonCodeBlock'],
] as const).map(([owner, root, sourceIndex, child]) => ({ owner, root, sourcePath: sourcePaths[sourceIndex], child }));
const GUARDED_SOURCE_PROOF_MISSING = Object.freeze(FORMER_M26.slice(0, 2));
const probeKey = (owner: OwnerName, root: string) => `flow:${owner}:${root}`;
const childKey = (row: GapExpectation) => `child:${row.childSourcePath}:${row.child}`;
const exactCallable = (result: ReachabilityResult, sourcePath: string, name: string) => {
  const matches = result.reachableCallables.filter(value => value.sourcePath === sourcePath && value.name === name);
  return matches.length === 1 ? matches[0] : null;
};
function exactEdge(result: ReachabilityResult, row: GapExpectation, target: number, source: number): boolean {
  const [line, column, endLine, endColumn, kind] = row.terminal;
  return (result.terminalProvenance.find(value => value.identity === target)?.predecessors ?? []).some(edge => (
    edge.kind === kind && edge.sourceIdentity === source && edge.targetIdentity === target
    && edge.sourcePath === row.callerSourcePath && edge.line === (line || null) && edge.column === (column || null)
    && edge.endLine === (endLine || null) && edge.endColumn === (endColumn || null)
  ));
}
const hasCallEdge = (result: ReachabilityResult, target: number, source: number) => (
  result.terminalProvenance.find(value => value.identity === target)?.predecessors ?? []
).some(edge => edge.kind === 'call' && edge.sourceIdentity === source && edge.targetIdentity === target);
function hasIdentityPath(result: ReachabilityResult, target: number, root: number, seen = new Set<number>()): boolean {
  if (target === root) return true;
  if (seen.has(target)) return false;
  const next = new Set(seen).add(target);
  return (result.terminalProvenance.find(value => value.identity === target)?.predecessors ?? [])
    .some(edge => edge.sourceIdentity !== target && hasIdentityPath(result, edge.sourceIdentity, root, next));
}
function missingRows(results: Map<string, ReachabilityResult>) {
  return expectedGaps.flatMap(row => {
    const flow = results.get(row.expectedOwner)!;
    const child = exactCallable(flow, row.childSourcePath, row.child);
    const caller = row.caller === '<top>' ? child : exactCallable(flow, row.callerSourcePath, row.caller);
    const root = flow.resolvedRoots.find(value => value.sourcePath === rootDeclarationPaths[row.expectedRoot]
      && value.name === row.expectedRoot);
    return child && caller && root && exactEdge(flow, row, child.identity, caller.identity)
      && hasIdentityPath(flow, child.identity, root.identity) ? [] : [{ owner: row.expectedOwner,
        root: row.expectedRoot, sourcePath: row.childSourcePath, child: row.child }];
  });
}
function sourceHasCallsite(row: GapExpectation, sources: Array<{ sourcePath: string; text: string }>, blocked = false): boolean {
  const span = blocked ? row.firstBlocked : row.terminal;
  if (!span || span[0] === 0) return true;
  const sourcePath = row.callerSourcePath;
  const source = sources.find(value => value.sourcePath === sourcePath);
  if (!source) return false;
  const ast = ts.createSourceFile(sourcePath, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const start = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      const end = ast.getLineAndCharacterOfPosition(node.getEnd());
      found ||= start.line + 1 === span[0] && start.character + 1 === span[1]
        && end.line + 1 === span[2] && end.character + 1 === span[3];
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}
function replaceChecked(text: string, from: string, to: string, expectedCount = 1): string {
  if (text.split(from).length - 1 !== expectedCount) throw new Error(`blocked mutation mismatch: ${from}`);
  return text.replaceAll(from, to);
}
function blockedSources(sources: Array<{ sourcePath: string; text: string }>) {
  return sources.map(source => {
    let text = source.text;
    if (source.sourcePath === sourcePaths[3]) {
      text = replaceChecked(text, 'queryTerms = queryTokens(query)', 'queryTerms = undefined', 4);
    }
    if (source.sourcePath === sourcePaths[7]) {
      text = replaceChecked(text, '...scoreNativeProjectionItemForQuery(item, context),', 'node: item,');
      text = replaceChecked(text, '(hasRelevanceScore ? compareNativeProjectionRelevance(a, b) : 0)',
        '(hasRelevanceScore ? 0 : 0)');
      text = replaceChecked(text, '.map(serializeNativeJsonNode)', '.map(node => node)', 2);
      text = replaceChecked(text, '.map(serializeNativeJsonEdge)', '.map(edge => edge)');
      text = replaceChecked(text, '.map(serializeNativeJsonCodeBlock)', '.map(block => block)');
    }
    return { ...source, text };
  });
}
function facadeMutation(sources: Array<{ sourcePath: string; text: string }>, from: string, to: string,
  expectedCount = 1) {
  return sources.map(source => source.sourcePath === facadeSourcePath ? {
    ...source,
    text: replaceChecked(source.text, from, to, expectedCount),
  } : source);
}
const valueSourceMutations = [
  ['selection', "profilePhase('selectGraphResults'", "profilePhase('selectGraphResultz'", 'selectGraphResults', 5, 'compareSyncBodyKeywordEndpointPriority', 1],
  ['unlisted-entry', 'prioritizedGraphNodes', 'unlistedGraphNodes', 'selectGraphResults', 5, 'compareSyncBodyKeywordEndpointPriority', 2],
  ['priority', 'const prioritizedGraphNodes = prioritizeQueryRelevantGraphNodes(', 'const prioritizedGraphNodes = prioritizeQueryRelevantGraphNodez(', 'selectGraphResults', 5, 'compareSyncBodyKeywordEndpointPriority'],
  ['node-budget', 'fillGraphNodeBudgetWithRelevantEndpoints(', 'fillGraphNodeBudgetWithRelevantEndpointz(', 'selectGraphResults', 5, 'compareSyncConfigKeywordEndpointPriority'],
  ['edge-close', 'closeGraphEdgesOverSelectedNodes(', 'closeGraphEdgesOverSelectedNodez(', 'toNativeJsonFormatterResponse', 7, 'serializeNativeJsonEdge'],
  ['entry-points', 'selectEntryPoints(', 'selectEntryPointz(', 'formatStrictNativeMarkdown', 4, 'isStrongSingleTermNodeMatch'],
  ['native-edges', "profilePhase('toNativeEdges'", "profilePhase('toNativeEdgez'", 'toNativeJsonFormatterResponse', 7, 'serializeNativeJsonEdge'],
] as const;
const descriptorMutations = [
  ['wrong-branch', facadeSourcePath,
    'const outputResponse = args.nativeJson ? toNativeJsonFormatterResponse(response) : response;',
    'const outputResponse = args.nativeJson ? response : toNativeJsonFormatterResponse(response);'],
  ['wrong-argument', facadeSourcePath, 'toNativeJsonFormatterResponse(response)',
    'toNativeJsonFormatterResponse(sourceBlocks)'],
  ['alias', facadeSourcePath, 'toNativeJsonFormatterResponse(response)',
    '((nativeJsonFormatter) => nativeJsonFormatter(response))(toNativeJsonFormatterResponse)'],
  ['spread', facadeSourcePath, 'toNativeJsonFormatterResponse(response)',
    'toNativeJsonFormatterResponse(...[response])'],
  ['arity', facadeSourcePath, 'toNativeJsonFormatterResponse(response)',
    'toNativeJsonFormatterResponse(response, sourceBlocks)'],
  ['wrong-runtime', facadeSourcePath, 'installOutputProjection(overlayQueryRuntime);',
    'installOutputProjection({ ...overlayQueryRuntime });'],
  ['reassigned-publication', sourcePaths[7],
    'toNativeJsonFormatterResponseDelegate = toNativeJsonFormatterResponse;',
    'toNativeJsonFormatterResponseDelegate = toNativeJsonFormatterResponse; toNativeJsonFormatterResponse = formatNativeMarkdown;'],
  ['duplicate-publication', sourcePaths[7],
    'displayLineNumber, toNativeJsonFormatterResponse,\n    serializeNativeJsonNode',
    'displayLineNumber, toNativeJsonFormatterResponse, toNativeJsonFormatterResponse,\n    serializeNativeJsonNode'],
  ['wrong-publication-target', sourcePaths[7],
    'displayLineNumber, toNativeJsonFormatterResponse,\n    serializeNativeJsonNode',
    'displayLineNumber, toNativeJsonFormatterResponse: formatNativeMarkdown,\n    serializeNativeJsonNode'],
  ['ambiguous-target', sourcePaths[7], 'function toNativeJsonFormatterResponse(context) {',
    'function toNativeJsonFormatterResponse(other) { return other; } function toNativeJsonFormatterResponse(context) {'],
  ['rest-target', sourcePaths[7], 'function toNativeJsonFormatterResponse(context) {',
    'function toNativeJsonFormatterResponse(...context) {'],
  ['default-target', sourcePaths[7], 'function toNativeJsonFormatterResponse(context) {',
    'function toNativeJsonFormatterResponse(context = {}) {'],
  ['optional-target', sourcePaths[7], 'function toNativeJsonFormatterResponse(context) {',
    'function toNativeJsonFormatterResponse(context?) {'],
] as const;
describe('CodeGraph callback reachability real manifest', { timeout: 30_000 }, () => {
  it('classifies the exact 68 real callsites and solves six owners through one isolated shared worklist', async () => {
    const sources = [...sourcePaths, currentReceiptSourcePath].map(sourcePath => ({
      sourcePath,
      text: fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8'),
    }));
    for (const [sourcePath, expectedSha] of releasedExecutionSourceShas) {
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, sourcePath))).digest('hex'),
        `${sourcePath} released execution source`).toBe(expectedSha);
    }
    const facadeSource = sources.find(source => source.sourcePath === facadeSourcePath)!.text;
    expect(facadeSource).toContain("import currentReceiptReader from './lib/codegraph-overlay-current-receipt.cjs';");
    expect(facadeSource).toContain('const { readOverlayCurrentReceipt } = currentReceiptReader;');
    expect(facadeSource.match(/\breadOverlayCurrentReceipt\(/g)).toHaveLength(1);
    expect(facadeSource).toContain('const overlay = currentReceipt.overlay;');
    expect(facadeSource).not.toMatch(/nanoflow-overlay\.json|nanoflow-overlay\.v1\.json/);
    for (const installer of ['installQueryTerms', 'installNativeCodeblockEvidence', 'installCandidateIndex',
      'installSemanticSelection', 'installContextAssembly', 'installNativeCodeblockSelection', 'installOutputProjection']) {
      expect(facadeSource.match(new RegExp(`\\b${installer}\\(overlayQueryRuntime\\);`, 'g')),
        `${installer} released facade wiring`).toHaveLength(1);
    }
    const semanticSource = sources.find(source => source.sourcePath === sourcePaths[4])!.text;
    const guard = '    const graphEdges = Array.isArray(graph.edges) ? graph.edges : [];\n';
    expect.soft(semanticSource.split('\n').filter(line => line.includes('graph.edges'))).toEqual([guard.trimEnd()]);
    expect.soft(semanticSource.indexOf(guard)).toBeLessThan(semanticSource.indexOf('const graphIndexes = buildGraphIndexes'));
    const semantic = await import(`${pathToFileURL(path.join(repoRoot, sourcePaths[4])).href}?a-prime`);
    const indexedEdges: unknown[] = [];
    const emptyIndexes = () => ({ nodesById: new Map(), nodesByName: new Map(), exportEdgesByName: new Map(),
      equivalentIdsByDisplayKey: new Map(), edgesByNodeId: new Map() });
    const runtime = new Proxy({
      buildGraphIndexes: (graph: { edges: unknown }) => { indexedEdges.push(graph.edges); return emptyIndexes(); },
      explicitPathScopeFilePaths: () => new Set(), codeBlockSourceFirstRelationQueries: () => new Set(),
      dedupeScoredEntryByDisplay: () => () => true, dedupeNodeByDisplay: () => () => true,
      exactMetadataQueryFromTerms: () => null,
    }, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => [] });
    semantic.installSemanticSelection(runtime);
    for (const edges of [null, {}, 'invalid', 1]) {
      const result = semantic.selectGraphResultsImpl({ graph: { nodes: [], edges } }, '', [], 1);
      expect.soft(indexedEdges.at(-1), `normalized malformed edges ${String(edges)}`).toEqual([]);
      expect(result).toEqual({ nodes: [], edges: [] });
    }
    const validEdges: unknown[] = [];
    semantic.selectGraphResultsImpl({ graph: { nodes: [], edges: validEdges } }, '', [], 1);
    expect(indexedEdges.at(-1)).toBe(validEdges);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { hotspots: Hotspot[] };
    const entries = new Map(ownerNames.map(owner => {
      const entry = manifest.hotspots.find(candidate => candidate.name === `${owner}()`);
      expect(entry, `missing manifest owner ${owner}`).toBeDefined();
      return [owner, entry!] as const;
    }));
    expect(expectedGaps).toHaveLength(68);
    expect(new Set(expectedGaps.map(row => `${row.originalOwner}\0${row.child}`)).size).toBe(68);
    const oracleStartedAt = performance.now();
    for (const row of expectedGaps) {
      const target = entries.get(row.expectedOwner)!;
      expect(target.sourceSymbols, `${row.child} root ${row.expectedRoot}`).toContain(row.expectedRoot);
      expect(new Set([...(target.sourceSymbols ?? []), ...(target.coveredChildSymbols ?? [])]),
        `${row.child} placement under ${row.expectedOwner}`).toContain(row.child);
      expect(sourceHasCallsite(row, sources), `${row.child} exact terminal callsite`).toBe(true);
      if (row.firstBlocked) expect(sourceHasCallsite(row, sources, true), `${row.child} first blocked callsite`).toBe(true);
    }
    let structuralBuilds = 0;
    let fixedPointRuns = 0;
    let sharedState = 0;
    let schedulerRuns = 0;
    const solverSummaries: SolverSummary[] = [];
    const fixedPointOwners: OwnerName[][] = [];
    const sharedStateOwners: OwnerName[][] = [];
    const ownerRequests = ownerNames.map(ownerId => ({
      ownerId,
      rootCallables: (entries.get(ownerId)!.sourceSymbols ?? []).map(name => {
        expect(rootDeclarationPaths[name], `missing exact declaration path for ${name}`).toBeDefined();
        return { sourcePath: rootDeclarationPaths[name], name };
      }),
    }));
    const batchStartedAt = performance.now();
    const batch = analyzeCallbackReachabilityBatch({
      sources,
      entrySourcePath: facadeSourcePath,
      ownerRequests,
      instrumentation: {
        onProgramBuild: () => { structuralBuilds += 1; },
        onFixedPointRun: event => { fixedPointRuns += 1; fixedPointOwners.push((event?.ownerIds ?? []) as OwnerName[]); },
        onSharedStateCreate: event => { sharedState += 1; sharedStateOwners.push((event?.ownerIds ?? []) as OwnerName[]); },
        onSchedulerRun: () => { schedulerRuns += 1; },
        onSolverSummary: event => { solverSummaries.push(event); },
      },
    });
    const forwardAnalyzeMs = performance.now() - batchStartedAt;
    expect(fs.readFileSync(path.join(repoRoot, 'scripts/lib/codegraph-overlay-callback-reachability.cjs'), 'utf8'))
      .not.toContain('canonicalRootedProjection');
    const rejections = batch.ownerResults.flatMap(result => result.rejections);
    expect(rejections.some(value => value.code === 'UNROOTED_PRODUCER')).toBe(true);
    expect(rejections.every(rejection => (
      Object.keys(rejection).sort().join(',') === 'argumentIndex,caller,callsite,code,owner,producer,reason,target'
      && rejection.owner.length > 0 && rejection.reason.length > 0 && [rejection.producer, rejection.caller, rejection.callsite, rejection.target].every(id => id.split('\0').length >= 3)
    )), 'stable structured rejection API').toBe(true);
    expect(solverSummaries, 'one causal solver summary').toHaveLength(1);
    if (process.env['NANOFLOW_CALLBACK_REACHABILITY_SINGLE_BATCH'] === '1') {
      const singleResults = new Map(batch.ownerResults.map(result => [result.ownerId, result]));
      expect(missingRows(singleResults), 'single real six-owner missing set').toEqual([]);
      return;
    }
    const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const sorted = <T>(values: T[]) => [...values].sort((a, b) => (
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    ));
    const normalizeOwner = (result: ReachabilityResult) => ({
      owner: result.ownerId,
      roots: sorted(result.resolvedRoots),
      reachable: sorted(result.reachableCallables),
      terminal: sorted(result.terminalProvenance.map(value => ({
        ...value, predecessors: sorted(value.predecessors),
      }))),
      paths: sorted(result.provenancePaths),
      rejections: sorted(result.rejections),
    });
    const assertRooted = (result: ReachabilityResult) => {
      const roots = new Set(result.resolvedRoots.map(root => root.identity));
      for (const entry of result.provenancePaths) {
        expect(entry.path.length, `${result.ownerId}:${entry.identity} nonempty path`).toBeGreaterThan(0);
        expect(roots.has(entry.path[0].targetIdentity), `${result.ownerId}:${entry.identity} root-started`).toBe(true);
        expect(entry.path.every((edge, index) => index === 0
          || entry.path[index - 1].targetIdentity === edge.sourceIdentity),
        `${result.ownerId}:${entry.identity} contiguous`).toBe(true);
        expect(entry.path.at(-1)?.targetIdentity, `${result.ownerId}:${entry.identity} terminal`).toBe(entry.identity);
      }
    };
    batch.ownerResults.forEach(assertRooted);
    const normalized = (results: ReachabilityResult[]) => results.map(normalizeOwner)
      .sort((a, b) => a.owner.localeCompare(b.owner));
    const forward = normalized(batch.ownerResults);
    const reverseStartedAt = performance.now();
    const reversed = analyzeCallbackReachabilityBatch({
      sources, entrySourcePath: facadeSourcePath, ownerRequests: [...ownerRequests].reverse(),
      instrumentation: { onSolverSummary: event => { solverSummaries.push(event); } },
    });
    const reverseAnalyzeMs = performance.now() - reverseStartedAt;
    reversed.ownerResults.forEach(assertRooted);
    const reverse = normalized(reversed.ownerResults);
    expect(digest(forward), 'released Query normalized forward digest').toBe(releasedNormalizedDigest);
    expect(digest(reverse), 'released Query normalized reverse digest').toBe(releasedNormalizedDigest);
    const orderEquivalent = JSON.stringify(forward) === JSON.stringify(reverse);
    const membership = (values: typeof forward) => new Set(values.flatMap(value => value.reachable
      .map(target => `${value.owner}\0${target.sourcePath}\0${target.name}`)));
    const difference = (left: Set<string>, right: Set<string>) => [...left].filter(value => !right.has(value)).sort();
    const forwardMembership = membership(forward), reverseMembership = membership(reverse);
    console.info(JSON.stringify({ kind: 'provenance-summary',
      forward: { count: forwardMembership.size, digest: digest(forward) },
      reverse: { count: reverseMembership.size, digest: digest(reverse) },
      symmetricDifference: { forwardOnly: digest(difference(forwardMembership, reverseMembership)),
        reverseOnly: digest(difference(reverseMembership, forwardMembership)) },
      orderEquivalent, preBatchOracleMs: batchStartedAt - oracleStartedAt, forwardAnalyzeMs, reverseAnalyzeMs }));
    expect(orderEquivalent, 'forward/reverse normalized owner equivalence').toBe(true);
    expect(forwardAnalyzeMs, 'forward six-owner batch under 20s').toBeLessThan(20_000);
    expect(reverseAnalyzeMs, 'reverse six-owner batch under 20s').toBeLessThan(20_000);
    expect(solverSummaries).toHaveLength(2);
    for (const summary of solverSummaries) {
      const atomHeight = Object.values(summary.atomCountByFactKind).reduce((sum, count) => sum + count, 0);
      const heightBound = summary.directions * summary.owners * summary.nodes * atomHeight;
      const traversalBound = summary.directions * summary.owners * summary.edges * atomHeight;
      expect(summary.latticeHeight).toBe(heightBound);
      expect(summary.factSetImprovements).toBeLessThanOrEqual(summary.newAtomInsertions);
      expect(summary.newAtomInsertions).toBeLessThanOrEqual(heightBound);
      expect(summary.enqueueAttempts).toBe(summary.enqueueSuccesses + summary.duplicateEnqueueSuppressions);
      expect(summary.queuePops).toBe(summary.enqueueSuccesses);
      expect(summary.stalePops).toBe(0);
      expect(summary.ordinaryCandidateEdges).toBe(0);
      expect(summary.edgeAtomTraversals).toBeLessThanOrEqual(traversalBound);
      expect(summary.candidateAdjudications).toBe(summary.candidateLanes);
      expect(summary.witnessQueuePops).toBe(summary.witnessEnqueueSuccesses); expect(summary.witnessQueuePops).toBeGreaterThan(0);
      expect(summary.witnessEdgeVisits).toBeLessThanOrEqual(summary.owners * summary.edges * summary.nodes);
      expect(summary.rootLaneQueuePops).toBe(summary.rootLaneStateInsertions); expect(summary.eagerSiteQueuePops).toBe(summary.eagerSiteSeeds + summary.eagerDependencyWakes);
      expect(summary.rootLaneQueuePops + summary.rootLaneArcVisits + summary.eagerSiteQueuePops + summary.eagerDependencyChecks + summary.eagerDependencyWakes).toBeGreaterThan(0);
    }
    const requestFor = (ownerId: string, name: string) => ({ ownerId,
      rootCallables: [{ sourcePath: rootDeclarationPaths[name], name }] });
    const strictRequest = requestFor('strict-only', 'formatStrictNativeMarkdown'),
      buildRequest = requestFor('build-only', 'buildNativeCodeBlocks');
    const strictAlone = analyzeCallbackReachabilityBatch({ sources, entrySourcePath: facadeSourcePath, ownerRequests: [strictRequest] }).ownerResults[0];
    const paired = analyzeCallbackReachabilityBatch({ sources, entrySourcePath: facadeSourcePath, ownerRequests: [strictRequest, buildRequest] }).ownerResults;
    const pairedStrict = paired.find(result => result.ownerId === strictRequest.ownerId)!;
    expect.soft(JSON.stringify(normalizeOwner(strictAlone)), 'A-alone versus A-with-B owner byte isolation')
      .toBe(JSON.stringify(normalizeOwner(pairedStrict)));
    expect.soft(exactCallable(strictAlone, sourcePaths[6], 'pushNativeCodeBlockWithinNativeBudget'), 'identity562 strict-only absence').toBeNull();
    const buildFlow = paired.find(result => result.ownerId === buildRequest.ownerId)!;
    const pushRow = expectedGaps.find(row => row.child === 'pushNativeCodeBlockWithinNativeBudget')!;
    const pushTarget = exactCallable(buildFlow, sourcePaths[6], pushRow.child),
      pushCaller = exactCallable(buildFlow, sourcePaths[6], pushRow.caller);
    expect.soft(Boolean(pushTarget && pushCaller && exactEdge(buildFlow, pushRow,
      pushTarget.identity, pushCaller.identity)), 'identity562 independent rooted terminal').toBe(true);
    expect.soft(Boolean(pushTarget && pushCaller && exactEdge(buildFlow, { ...pushRow,
      terminal: [107, ...pushRow.terminal.slice(1)] as unknown as GapExpectation['terminal'] },
    pushTarget.identity, pushCaller.identity)), 'identity562 terminal-line mutation').toBe(false);
    expect({ structuralBuilds, sharedState, schedulerRuns, fixedPointRuns }).toEqual({
      structuralBuilds: 1, sharedState: 1, schedulerRuns: 1, fixedPointRuns: 1,
    });
    expect(fixedPointOwners).toEqual([ownerNames]);
    expect(sharedStateOwners).toEqual([ownerNames]);
    expect(batch.ownerResults).toHaveLength(ownerNames.length);
    expect(batch.ownerResults.map(result => result.ownerId)).toEqual(ownerNames);
    expect(batch.ownerResults.flatMap(result => result.diagnostics)).toEqual([]);
    const results = new Map(batch.ownerResults.map(result => [result.ownerId, result]));
    const moduleAnchorFlow = results.get('toNativeJsonFormatterResponse')!;
    const moduleAnchor = moduleAnchorFlow.resolvedRoots.find(root => root.name === 'toNativeJsonFormatterResponse')!;
    const moduleSourceIdentity = moduleAnchorFlow.terminalProvenance
      .find(value => value.identity === moduleAnchor.identity)?.predecessors
      .find(edge => edge.kind === 'root-call')?.sourceIdentity;
    expect(moduleSourceIdentity, 'entry module root-call source identity').toBeDefined();
    const moduleCallbackSourceIdentities = new Set<number>();
    const missingModuleCallbackEvidence = releasedFacadeRootCalls.flatMap(([owner, name, line, column,
      endLine, endColumn]) => {
      const flow = results.get(owner)!;
      const target = flow.resolvedRoots.find(root => root.sourcePath === facadeSourcePath && root.name === name);
      const edge = target && flow.terminalProvenance.find(value => value.identity === target.identity)?.predecessors
        .find(value => value.kind === 'root-call' && value.sourceIdentity !== moduleSourceIdentity
          && value.targetIdentity === target.identity && value.sourcePath === facadeSourcePath
          && value.line === line && value.column === column && value.endLine === endLine
          && value.endColumn === endColumn);
      if (edge) moduleCallbackSourceIdentities.add(edge.sourceIdentity);
      return edge ? [] : [{ owner, name, line, column, endLine, endColumn }];
    });
    expect.soft(missingModuleCallbackEvidence, 'exact entry-module callback root-call evidence').toEqual([]);
    expect(moduleCallbackSourceIdentities.size, 'unique direct callback root-call source identities')
      .toBe(releasedFacadeRootCalls.length);
    const legacyModuleCallbackEvidence = [...priorReleasedFacadeRootCalls, ...legacyFacadeRootCalls]
      .flatMap(([owner, name, line, column,
      endLine, endColumn]) => {
      const flow = results.get(owner)!;
      const target = flow.resolvedRoots.find(root => root.sourcePath === facadeSourcePath && root.name === name);
      if (!target) return [];
      return flow.terminalProvenance.find(value => value.identity === target.identity)?.predecessors
        .filter(value => value.kind === 'root-call' && value.sourcePath === facadeSourcePath
          && value.line === line && value.column === column && value.endLine === endLine
          && value.endColumn === endColumn) ?? [];
      });
    expect(legacyModuleCallbackEvidence, 'legacy entry-module root-call identities stay absent').toEqual([]);
    for (const flow of results.values()) {
      expect(exactCallable(flow, facadeSourcePath, 'profilePhase'), `${flow.ownerId} profilePhase is not reachable`)
        .toBeNull();
      expect([...flow.resolvedRoots, ...flow.reachableCallables]
        .some(value => moduleCallbackSourceIdentities.has(value.identity)), `${flow.ownerId} callback is not reachable`)
        .toBe(false);
      expect(flow.reachableCallables.filter(value => ['prioritizeContext7RetrievalNodes',
        'fillGraphNodeBudgetWithRelevantEndpoints', 'closeGraphEdgesOverSelectedNodes'].includes(value.name)),
      `${flow.ownerId} value-only producers stay non-reachable`).toEqual([]);
    }
    for (const [owner, name, implementationPath] of wrapperBackedRoots) {
      const flow = results.get(owner)!;
      const facadeRoot = flow.resolvedRoots.find(root => root.sourcePath === facadeSourcePath && root.name === name)!;
      const implementation = exactCallable(flow, implementationPath, name)!;
      const implementationWrapper = exactCallable(flow, implementationPath, `${name}Impl`)!;
      const installedDelegate = exactCallable(flow, implementationPath, 'installedDelegate')!;
      expect([facadeRoot, implementationWrapper, installedDelegate, implementation].every(Boolean),
        `${name} exact facade delegation chain`).toBe(true);
      expect(new Set([facadeRoot.identity, implementationWrapper.identity, installedDelegate.identity,
        implementation.identity]).size, `${name} unique delegation identities`).toBe(4);
      expect(hasCallEdge(flow, implementationWrapper.identity, facadeRoot.identity), `${name} wrapper to impl`).toBe(true);
      expect(hasCallEdge(flow, installedDelegate.identity, implementationWrapper.identity),
        `${name} impl to installedDelegate`).toBe(true);
      expect(hasCallEdge(flow, implementation.identity, implementationWrapper.identity),
        `${name} installed delegate result`).toBe(true);
    }
    const flowRoots = new Map<string, { owner: OwnerName; root: string }>();
    const childRows = new Map<string, GapExpectation>();
    for (const row of expectedGaps) {
      childRows.set(childKey(row), row);
      if (row.classification === 'C' || row.classification === 'S') {
        flowRoots.set(probeKey(row.originalOwner, row.originalOwner), {
          owner: row.originalOwner, root: row.originalOwner,
        });
      }
    }
    const flowRequests = [...flowRoots].map(([ownerId, value]) => ({ ownerId, rootCallables: [{
      sourcePath: rootDeclarationPaths[value.root], name: value.root,
    }] }));
    const childRequests = [...childRows].map(([ownerId, row]) => ({
      ownerId, rootCallables: [{ sourcePath: row.childSourcePath, name: row.child }],
    }));
    const alternateQueryTokensOwnerId = `child:${sourcePaths[1]}:queryTokens`;
    childRequests.push({ ownerId: alternateQueryTokensOwnerId,
      rootCallables: [{ sourcePath: sourcePaths[1], name: 'queryTokens' }] });
    const probes = analyzeCallbackReachabilityBatch({
      sources, entrySourcePath: facadeSourcePath, ownerRequests: [...flowRequests, ...childRequests],
    });
    expect(probes.ownerResults.flatMap(result => result.diagnostics)).toEqual([]);
    const probeResults = new Map(probes.ownerResults.map(result => [result.ownerId, result]));
    const blockedRequests = [...new Set(expectedGaps.filter(row => row.classification === 'D')
      .map(row => row.expectedOwner))].map(ownerId => ({ ownerId,
      rootCallables: (entries.get(ownerId)!.sourceSymbols ?? []).map(name => ({
        sourcePath: rootDeclarationPaths[name], name,
      })),
    }));
    const blocked = analyzeCallbackReachabilityBatch({
      sources: blockedSources(sources), entrySourcePath: facadeSourcePath, ownerRequests: blockedRequests,
    });
    expect(blocked.ownerResults.flatMap(result => result.diagnostics)).toEqual([]);
    const blockedResults = new Map(blocked.ownerResults.map(result => [result.ownerId, result]));
    const actualMissing: Array<{ owner: OwnerName; root: string; sourcePath: string; child: string }> = [];
    for (const row of expectedGaps) {
      const flow = results.get(row.expectedOwner)!;
      const declaration = probeResults.get(childKey(row))!.resolvedRoots[0];
      const child = exactCallable(flow, row.childSourcePath, row.child);
      if (child) {
        expect(child.identity, `${row.child} exact terminal identity`).toBe(declaration.identity);
        const caller = row.caller === '<top>' ? child : exactCallable(flow, row.callerSourcePath, row.caller);
        const root = flow.resolvedRoots.find(value => value.sourcePath === rootDeclarationPaths[row.expectedRoot]
          && value.name === row.expectedRoot)!;
        const exact = Boolean(caller) && exactEdge(flow, row, child.identity, caller!.identity)
          && hasIdentityPath(flow, child.identity, root.identity);
        if (exact) {
          expect(caller, `${row.child} exact caller identity`).not.toBeNull();
          expect(exactEdge(flow, row, child.identity, caller!.identity), `${row.child} exact provenance edge`).toBe(true);
          expect(hasIdentityPath(flow, child.identity, root.identity), `${row.child} exact root identity`).toBe(true);
        } else actualMissing.push({ owner: row.expectedOwner, root: row.expectedRoot,
          sourcePath: row.childSourcePath, child: row.child });
      } else {
        actualMissing.push({ owner: row.expectedOwner, root: row.expectedRoot,
          sourcePath: row.childSourcePath, child: row.child });
      }
      if (row.classification === 'C') {
        expect(row.expectedOwner !== row.originalOwner || row.expectedRoot !== row.originalOwner,
          `${row.child} C owner/root separation`).toBe(true);
        const original = probeResults.get(probeKey(row.originalOwner, row.originalOwner))!;
        expect(exactCallable(original, row.childSourcePath, row.child), `${row.child} original owner/root absence`).toBeNull();
      } else if (row.classification === 'S') {
        const original = probeResults.get(probeKey(row.originalOwner, row.originalOwner))!;
        const originalChild = exactCallable(original, row.childSourcePath, row.child);
        const originalRoot = original.resolvedRoots.find(value => value.sourcePath === rootDeclarationPaths[row.originalOwner]
          && value.name === row.originalOwner);
        expect(originalChild, `${row.child} shared original owner/root presence`).not.toBeNull();
        expect(Boolean(originalChild && originalRoot
          && hasIdentityPath(original, originalChild.identity, originalRoot.identity)),
        `${row.child} shared original owner/root path`).toBe(true);
      } else {
        expect([row.expectedOwner, row.expectedRoot]).toEqual([row.originalOwner, row.originalOwner]);
        const preProof = blockedResults.get(row.expectedOwner)!;
        const preProofChild = exactCallable(preProof, row.childSourcePath, row.child);
        if (row.blockedNow) {
          expect.soft(preProofChild, `${row.child} guarded owner-local source proof`).not.toBeNull();
        } else {
          expect(preProofChild, `${row.child} pre-proof owner-local absence`).toBeNull();
        }
      }
    }
    const dRow = expectedGaps.find(row => row.child === 'queryTokens')!;
    const dFlow = results.get(dRow.expectedOwner)!;
    const dChild = exactCallable(dFlow, dRow.childSourcePath, dRow.child)!;
    const dCaller = exactCallable(dFlow, dRow.callerSourcePath, dRow.caller)!;
    const sameNameDeclaration = probeResults.get(alternateQueryTokensOwnerId)!.resolvedRoots[0];
    const exactQueryTokensEdges = dFlow.terminalProvenance.flatMap(value => value.predecessors).filter(edge => (
      edge.kind === dRow.terminal[4] && edge.sourceIdentity === dCaller.identity
      && edge.sourcePath === dRow.callerSourcePath && edge.line === dRow.terminal[0]
      && edge.column === dRow.terminal[1] && edge.endLine === dRow.terminal[2]
      && edge.endColumn === dRow.terminal[3]
    ));
    expect(dChild.identity).not.toBe(sameNameDeclaration.identity);
    expect(exactQueryTokensEdges.map(edge => edge.targetIdentity), 'unique exact queryTokens target identity')
      .toEqual([dChild.identity]);
    expect(exactQueryTokensEdges.some(edge => edge.targetIdentity === sameNameDeclaration.identity),
      'zero same-span edge to query-terms queryTokens').toBe(false);
    expect(exactCallable(dFlow, sourcePaths[1], dRow.child)?.identity,
      'same-name implementation remains distinct from exact terminal target').toBe(sameNameDeclaration.identity);
    expect(exactEdge(dFlow, { ...dRow, terminal: [117, ...dRow.terminal.slice(1)] as unknown as GapExpectation['terminal'] },
      dChild.identity, dCaller.identity), 'altered terminal callsite').toBe(false);
    expect(exactEdge(dFlow, dRow, dFlow.resolvedRoots[0].identity, dCaller.identity),
      'root identity substituted for terminal child identity').toBe(false);
    expect(sourceHasCallsite({ ...dRow, firstBlocked: [117, ...dRow.firstBlocked!.slice(1)] as unknown as NonNullable<GapExpectation['firstBlocked']> },
      sources, true), 'altered first blocked callsite').toBe(false);
    expect.soft(actualMissing, 'canonical real-closure missing set').toEqual([]); expect(missingRows(results), 'canonical helper mirrors real-closure missing set').toEqual(actualMissing);
    const guardedSourceProofMissing = expectedGaps.filter(row => row.blockedNow).map(row => ({
      owner: row.expectedOwner, root: row.expectedRoot, sourcePath: row.childSourcePath, child: row.child,
    }));
    expect(guardedSourceProofMissing.map(row => row.child)).toEqual([
      'edgeMatchesQueryTermsWithEndpoints', 'edgeMatchesAnyQueryTermWithEndpoints',
    ]);
    expect(guardedSourceProofMissing).toEqual(GUARDED_SOURCE_PROOF_MISSING);
    for (const [name, from, to, owner, sourceIndex, child, expectedCount = 1] of valueSourceMutations) {
      const mutated = analyzeCallbackReachabilityBatch({
        sources: facadeMutation(sources, from, to, expectedCount), entrySourcePath: facadeSourcePath, ownerRequests,
      });
      expect(mutated.ownerResults.flatMap(result => result.diagnostics), `${name} diagnostics`).toEqual([]);
      const flow = mutated.ownerResults.find(result => result.ownerId === owner)!;
      expect(exactCallable(flow, sourcePaths[sourceIndex], child), `${name} exact value-source sentinel`).toBeNull();
    }
    const nativeJsonRequest = ownerRequests.find(request => request.ownerId === 'toNativeJsonFormatterResponse')!;
    for (const [name, sourcePath, from, to] of descriptorMutations) {
      const mutatedSources = sources.map(source => source.sourcePath === sourcePath
        ? { ...source, text: replaceChecked(source.text, from, to) } : source);
      const mutated = analyzeCallbackReachabilityBatch({
        sources: mutatedSources, entrySourcePath: facadeSourcePath, ownerRequests: [nativeJsonRequest],
      });
      const flow = mutated.ownerResults[0];
      const missing = ['serializeNativeJsonEdge', 'nativeJsonEdgeLine', 'nativeJsonEdgeColumn']
        .filter(child => !exactCallable(flow, sourcePaths[7], child));
      expect(missing, `${name} exact descriptor fails closed`).toContain('serializeNativeJsonEdge');
      if (['wrong-branch', 'wrong-argument', 'alias', 'spread', 'arity'].includes(name)) {
        expect(missing, `${name} zero partial callback commit`).toEqual(expect.arrayContaining([
          'serializeNativeJsonEdge', 'nativeJsonEdgeLine', 'nativeJsonEdgeColumn',
        ]));
      }
    }
  });
});
