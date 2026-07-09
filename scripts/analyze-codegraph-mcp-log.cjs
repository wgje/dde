#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readCodexCodegraphMcpConfig } = require('./codegraph-codex-config.cjs');

const args = process.argv.slice(2);
const flags = new Set();
const positional = [];
let sinceValue = null;
let observedAtValue = null;
let directMcpErrorValue = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--since') {
    flags.add('--since');
    sinceValue = args[i + 1] ?? null;
    i++;
    continue;
  }
  if (arg.startsWith('--since=')) {
    flags.add('--since');
    sinceValue = arg.slice('--since='.length);
    continue;
  }
  if (arg === '--observed-at') {
    flags.add('--observed-at');
    observedAtValue = args[i + 1] ?? null;
    i++;
    continue;
  }
  if (arg.startsWith('--observed-at=')) {
    flags.add('--observed-at');
    observedAtValue = arg.slice('--observed-at='.length);
    continue;
  }
  if (arg === '--direct-mcp-error') {
    flags.add('--direct-mcp-error');
    directMcpErrorValue = args[i + 1] ?? null;
    i++;
    continue;
  }
  if (arg.startsWith('--direct-mcp-error=')) {
    flags.add('--direct-mcp-error');
    directMcpErrorValue = arg.slice('--direct-mcp-error='.length);
    continue;
  }
  if (arg.startsWith('--')) {
    flags.add(arg);
    continue;
  }
  positional.push(arg);
}
const logPath = path.resolve(positional[0] ?? path.join('.codegraph', 'nanoflow-mcp-wrapper.log'));
const projectRoot = inferProjectRootFromLogPath(logPath);
const sinceMs = sinceValue ? Date.parse(sinceValue) : Number.NaN;
const observedDirectMcpError = normalizeOptionalText(
  directMcpErrorValue ?? process.env.NANOFLOW_CODEGRAPH_DIRECT_MCP_ERROR,
);
const observedDirectMcpFailureClass = classifyObservedDirectMcpError(observedDirectMcpError);
const observedAtMs = parseObservedAtMs(observedAtValue ?? (observedDirectMcpError ? 'now' : null));
const ACTIVE_WRAPPER_WINDOW_MS = 30 * 60 * 1000;
const ACTIVE_WRAPPER_DETAIL_LIMIT = 20;
const DIAGNOSTIC_LOG_ANALYSIS_COMMAND = 'node scripts/analyze-codegraph-mcp-log.cjs .codegraph\\nanoflow-mcp-wrapper.log --text --observed-at now';
const FRESH_ADAPTER_FALLBACK_COMMAND = 'npm run codegraph:adapter:context -- --query "<query>" --json';
const ADAPTER_DOCTOR_COMMAND = 'npm run codegraph:adapter:doctor -- --explain';
const DIAGNOSTIC_DETAIL_LIMIT = 8;
const WRAPPER_ENV_DIAGNOSTIC_KEYS = [
  'CODEGRAPH_NO_DAEMON',
  'CODEGRAPH_NO_WATCH',
  'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
  'CODEGRAPH_DAEMON_MAX_IDLE_MS',
  'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
  'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS',
  'NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP',
  'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
  'NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE',
];
const SOURCE_ORDERING_GENERATED_FILE_PATTERNS = [
  /\.pb\.go$/,
  /\.pulsar\.go$/,
  /_grpc\.pb\.go$/,
  /_mock\.go$/,
  /_mocks\.go$/,
  /^mock_[^/]+\.go$/,
  /\.generated\.[jt]sx?$/,
  /\.gen\.[jt]sx?$/,
  /\.pb\.[jt]s$/,
  /_pb\.[jt]s$/,
  /_grpc_pb\.[jt]s$/,
  /_pb2(_grpc)?\.py$/,
  /_pb2\.pyi$/,
  /\.pb\.(cc|h)$/,
  /\.g\.cs$/,
  /Grpc\.cs$/,
  /OuterClass\.java$/,
  /Grpc\.java$/,
  /\.pb\.swift$/,
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.pb\.dart$/,
  /\.pbgrpc\.dart$/,
  /\.chopper\.dart$/,
  /\.generated\.rs$/,
];

function count(map, key) {
  const safeKey = key === undefined || key === null || key === '' ? '(none)' : String(key);
  map[safeKey] = (map[safeKey] ?? 0) + 1;
}

function eventTimestampMs(event) {
  const parsed = Date.parse(event?.ts ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseObservedAtMs(value) {
  if (!value) return Number.NaN;
  if (String(value).toLowerCase() === 'now') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeOptionalText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function classifyObservedDirectMcpError(errorText) {
  if (!errorText) return null;
  return /transport\s+closed/i.test(errorText)
    ? 'observed-direct-mcp-transport-closed'
    : 'observed-direct-mcp-error';
}

function isoFromMs(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function classifyChildExit(code, signal) {
  if (signal) {
    return {
      childExitCodeHex: null,
      childExitClass: 'signal',
      childExitName: String(signal),
    };
  }

  if (code === undefined || code === null || code === '') {
    return {
      childExitCodeHex: null,
      childExitClass: 'unknown',
      childExitName: 'UNKNOWN',
    };
  }

  const numericCode = Number(code);
  if (!Number.isFinite(numericCode)) {
    return {
      childExitCodeHex: null,
      childExitClass: 'non-numeric-exit',
      childExitName: String(code),
    };
  }

  const unsignedCode = numericCode >>> 0;
  const childExitCodeHex = `0x${unsignedCode.toString(16).padStart(unsignedCode > 0xff ? 8 : 2, '0')}`;
  if (numericCode === 0) {
    return {
      childExitCodeHex,
      childExitClass: 'zero-exit',
      childExitName: 'EXIT_SUCCESS',
    };
  }

  const windowsStatusNames = {
    0xc0000005: 'STATUS_ACCESS_VIOLATION',
    0xc0000135: 'STATUS_DLL_NOT_FOUND',
    0xc0000142: 'STATUS_DLL_INIT_FAILED',
    0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN',
  };
  if (unsignedCode >= 0xc0000000) {
    return {
      childExitCodeHex,
      childExitClass: 'windows-native-crash',
      childExitName: windowsStatusNames[unsignedCode] ?? `NTSTATUS_${childExitCodeHex.toUpperCase()}`,
    };
  }

  return {
    childExitCodeHex,
    childExitClass: 'nonzero-exit',
    childExitName: `EXIT_${numericCode}`,
  };
}

function compactWrapperStart(event) {
  if (!event) return null;
  return {
    ts: event.ts,
    runId: event.runId,
    pid: event.pid,
    wrapperPid: event.wrapperPid ?? event.pid,
    wrapperVersion: event.wrapperVersion,
    scriptPath: event.scriptPath,
    scriptSha256: event.scriptSha256,
    codegraphTarget: event.codegraphTarget,
    codegraphArgs: Array.isArray(event.codegraphArgs) ? event.codegraphArgs : undefined,
    env: compactWrapperEnv(event.env),
    effectiveChildEnv: compactWrapperEnv(event.effectiveChildEnv),
    codexConfigAlignment: compactCodexConfigAlignment(event.codexConfigAlignment),
  };
}

function compactCodexConfigAlignment(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return {
    status: value.status,
    reason: value.reason,
    alignmentMode: value.alignmentMode,
    config: value.config,
    expected: value.expected,
    actual: value.actual,
    mismatches: Array.isArray(value.mismatches) ? value.mismatches : [],
    mismatchCount: value.mismatchCount ?? (
      Array.isArray(value.mismatches) ? value.mismatches.length : undefined
    ),
  };
}

function compactWrapperEnv(env) {
  if (!env || typeof env !== 'object') {
    return undefined;
  }
  const result = {};
  for (const key of WRAPPER_ENV_DIAGNOSTIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      result[key] = env[key];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readFileSha256(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { sha256: null, error: 'missing-script-path' };
  }
  try {
    return {
      sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
      error: null,
    };
  } catch (error) {
    return {
      sha256: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function enrichWrapperStartWithDiskHash(wrapperStart) {
  if (!wrapperStart) return null;
  const { sha256, error } = readFileSha256(wrapperStart.scriptPath);
  const loggedSha256 = wrapperStart.scriptSha256 ?? null;
  const matchesDisk = Boolean(loggedSha256 && sha256) ? loggedSha256 === sha256 : null;
  return {
    ...wrapperStart,
    diskScriptSha256: sha256,
    diskScriptHashError: error,
    matchesDisk,
    staleAgainstDisk: matchesDisk === false,
  };
}

function wrapperStartedAfter(candidate, previous) {
  const candidateTime = eventTimestampMs(candidate);
  const previousTime = eventTimestampMs(previous);
  return Number.isFinite(candidateTime) && Number.isFinite(previousTime) && candidateTime > previousTime;
}

function markSupersededContextWrapper(summary) {
  const latestContextActivity = summary.currentContextWrapper?.latestTs
    ? { ts: summary.currentContextWrapper.latestTs }
    : summary.currentContextWrapper;
  if (
    summary.currentContextWrapper?.matchesDisk === false
    && summary.currentWrapper?.matchesDisk === true
    && wrapperStartedAfter(summary.currentWrapper, latestContextActivity)
  ) {
    summary.currentContextWrapper = {
      ...summary.currentContextWrapper,
      rawMatchesDisk: false,
      matchesDisk: null,
      staleAgainstDisk: false,
      supersededByFreshWrapper: true,
    };
  }
}

function enrichActivityWithWrapperIdentity(activity, wrapperStartsByRunId) {
  if (!activity?.event?.runId) return null;
  const wrapperStart = wrapperStartsByRunId.get(activity.event.runId);
  if (!wrapperStart) return null;
  return {
    ...enrichWrapperStartWithDiskHash(compactWrapperStart(wrapperStart)),
    latestTs: activity.event.ts,
    latestEvent: activity.event.event,
    latestRequestId: activity.event.requestId,
    latestRequestKind: activity.event.requestKind,
    latestTool: activity.event.tool,
    latestFailureClass: activity.event.failureClass,
  };
}

function compactEvent(event, wrapperStartsByRunId = null) {
  if (!event) return null;
  const wrapperStart = event.event !== 'wrapper.start'
    && event.runId
    && wrapperStartsByRunId?.get?.(event.runId);
  return {
    ts: event.ts,
    runId: event.runId,
    seq: event.seq,
    event: event.event,
    requestId: event.requestId,
    requestKind: event.requestKind,
    tool: event.tool,
    query: event.query,
    queryClassification: compactQueryClassification(event.queryClassification),
    queryId: event.queryId,
    outputMode: event.outputMode,
    contextJson: event.contextJson,
    kind: event.kind,
    failureClass: event.failureClass,
    fatal: event.fatal,
    message: event.message,
    textTail: textTail(event.text),
    code: event.code,
    childExitCodeHex: event.childExitCodeHex,
    childExitClass: event.childExitClass,
    childExitName: event.childExitName,
    childUptimeMs: event.childUptimeMs,
    mode: event.mode,
    reason: event.reason,
    target: event.target,
    resolvedTarget: event.resolvedTarget,
    exists: event.exists,
    cwd: event.cwd,
    args: event.args,
    signal: event.signal,
    expectedExit: event.expectedExit,
    transportClosedBy: event.transportClosedBy,
    error: event.error,
    autoRecycle: event.autoRecycle,
    status: event.status,
    alignmentMode: event.alignmentMode,
    config: event.config,
    expected: event.expected,
    actual: event.actual,
    mismatches: event.mismatches,
    mismatchCount: event.mismatchCount,
    configAlignment: compactCodexConfigAlignment(event.configAlignment),
    codexConfigAlignment: compactCodexConfigAlignment(event.codexConfigAlignment),
    recovery: Array.isArray(event.recovery) ? event.recovery.slice(0, 8) : undefined,
    misdiagnosisGuards: Array.isArray(event.misdiagnosisGuards)
      ? event.misdiagnosisGuards.slice(0, 8)
      : undefined,
    requiredEvidenceBeforeConclusion: Array.isArray(event.requiredEvidenceBeforeConclusion)
      ? event.requiredEvidenceBeforeConclusion.slice(0, 8)
      : undefined,
    startupScriptSha256: event.startupScriptSha256,
    diskScriptSha256: event.diskScriptSha256,
    staleAgainstDisk: event.staleAgainstDisk,
    activeRequestCount: event.activeRequestCount ?? event.runtime?.activeRequestCount,
    activeRequestsAtShutdown: event.activeRequestsAtShutdown,
    pendingContextPackCount: event.pendingContextPackCount ?? event.runtime?.pendingContextPackCount,
    pendingToolsListCount: event.pendingToolsListCount ?? event.runtime?.pendingToolsListCount,
    recycleGraceMs: event.recycleGraceMs,
    recycleDeferCount: event.recycleDeferCount ?? event.runtime?.staleWrapperRecycleDeferCount,
    nextDelayMs: event.nextDelayMs,
    staleWrapperRecycleElapsedMs: event.staleWrapperRecycleElapsedMs ?? event.runtime?.staleWrapperRecycleElapsedMs,
    lastClientOutputAgeMs: event.lastClientOutputAgeMs ?? event.runtime?.lastClientOutputAgeMs,
    graceStartsAfter: event.graceStartsAfter,
    lastProfilePhase: event.lastProfilePhase,
    profileMeta: event.profileMeta,
    profilePhases: event.profilePhases,
    stdoutBytes: event.stdoutBytes,
    stderrBytes: event.stderrBytes,
    stdoutStartsWithJson: event.stdoutStartsWithJson,
    elapsedMs: event.elapsedMs,
    delayMs: event.delayMs,
    rapidExitCount: event.rapidExitCount,
    restartWindowMs: event.restartWindowMs,
    childRestartBackoffPending: event.childRestartBackoffPending,
    source: event.source,
    limit: event.limit,
    wrapperVersion: event.wrapperVersion,
    scriptPath: event.scriptPath,
    scriptSha256: event.scriptSha256,
    wrapperStart: wrapperStart ? compactWrapperStart(wrapperStart) : undefined,
    investigation: event.investigation,
    resultStats: event.resultStats,
    sourceOrdering: compactSourceOrdering(event.sourceOrdering),
    sourceSelection: compactSourceSelection(event.sourceSelection),
    baseSectionFiltering: compactBaseSectionFiltering(event.baseSectionFiltering),
    baseTextDiagnostics: event.baseTextDiagnostics,
    rawBaseTextDiagnostics: event.rawBaseTextDiagnostics,
  };
}

function compactAutoSyncDisabledEvent(event, wrapperStartsByRunId = null) {
  if (!event) return null;
  const wrapperStart = event.event !== 'wrapper.start'
    && event.runId
    && wrapperStartsByRunId?.get?.(event.runId);
  return {
    ts: event.ts,
    runId: event.runId,
    seq: event.seq,
    event: event.event,
    requestId: event.requestId,
    requestKind: event.requestKind,
    tool: event.tool,
    query: event.query,
    outputMode: event.outputMode,
    failureClass: event.failureClass,
    message: event.message,
    textTail: textTail(event.text),
    activeRequestCount: event.activeRequestCount ?? event.runtime?.activeRequestCount,
    pendingContextPackCount: event.pendingContextPackCount ?? event.runtime?.pendingContextPackCount,
    pendingToolsListCount: event.pendingToolsListCount ?? event.runtime?.pendingToolsListCount,
    wrapperStart: wrapperStart ? compactWrapperStart(wrapperStart) : undefined,
    investigation: event.investigation,
    baseResponseWarnings: compactResponseWarnings(event.baseResponseWarnings),
    responseWarnings: compactResponseWarnings(event.responseWarnings),
  };
}

function compactDiagnosticFileDetail(detail) {
  if (!detail || typeof detail !== 'object') {
    return null;
  }
  const result = {
    filePath: detail.filePath,
    visibleIndex: detail.visibleIndex,
    rankedIndex: detail.rankedIndex,
    score: detail.score,
    matchRank: detail.matchRank,
    nodeRank: detail.nodeRank,
    matchScore: detail.matchScore,
    nodeScore: detail.nodeScore,
    pathScore: detail.pathScore,
    symbolScore: detail.symbolScore,
    codeBlockScore: detail.codeBlockScore,
    sourceBlockScore: detail.sourceBlockScore,
    lowValuePenalty: detail.lowValuePenalty,
    rawLowValuePenalty: detail.rawLowValuePenalty,
    pathClassLowValue: detail.pathClassLowValue,
    codegraphToolingSource: detail.codegraphToolingSource,
    dedupMaintenanceSource: detail.dedupMaintenanceSource,
    explicitSymbolEvidence: detail.explicitSymbolEvidence,
    preferredSymbolEvidence: detail.preferredSymbolEvidence,
    explicitPathRequested: detail.explicitPathRequested,
    explicitFileRequested: detail.explicitFileRequested,
    explicitSourcePathRequested: detail.explicitSourcePathRequested,
    selected: detail.selected,
    reason: detail.reason,
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }
  return result;
}

function compactDiagnosticFileDetails(details) {
  if (!Array.isArray(details)) {
    return [];
  }
  return details
    .slice(0, DIAGNOSTIC_DETAIL_LIMIT)
    .map(compactDiagnosticFileDetail)
    .filter(Boolean);
}

function compactStringArray(values) {
  return Array.isArray(values) ? values.slice(0, DIAGNOSTIC_DETAIL_LIMIT) : [];
}

function compactQueryClassification(classification) {
  if (!classification || typeof classification !== 'object') {
    return null;
  }
  return {
    codegraphDedupMaintenance: classification.codegraphDedupMaintenance,
    dedupMaintenanceReason: classification.dedupMaintenanceReason,
    hasCodegraphAnchor: classification.hasCodegraphAnchor,
    hasMaintenanceIntent: classification.hasMaintenanceIntent,
    hasStrongMaintenanceIntent: classification.hasStrongMaintenanceIntent,
    hasDedupMaintenanceHelperSignal: classification.hasDedupMaintenanceHelperSignal,
    matchedCodegraphAnchorSegments: compactStringArray(classification.matchedCodegraphAnchorSegments),
    matchedMaintenanceIntentSegments: compactStringArray(classification.matchedMaintenanceIntentSegments),
    matchedStrongMaintenanceIntentSegments: compactStringArray(classification.matchedStrongMaintenanceIntentSegments),
    matchedDedupMaintenanceHelperSegments: compactStringArray(classification.matchedDedupMaintenanceHelperSegments),
    matchedDedupMaintenanceHelperCompoundSignals: compactStringArray(classification.matchedDedupMaintenanceHelperCompoundSignals),
    codegraphTooling: classification.codegraphTooling,
    codegraphToolingQuality: classification.codegraphToolingQuality,
    codegraphToolingSourcePollution: classification.codegraphToolingSourcePollution,
    context7Documentation: classification.context7Documentation,
    tests: classification.tests,
    segments: compactStringArray(classification.segments),
  };
}

function compactSourceOrdering(sourceOrdering) {
  if (!sourceOrdering || typeof sourceOrdering !== 'object') {
    return null;
  }
  return {
    queryClassification: compactQueryClassification(sourceOrdering.queryClassification),
    sourceRankingQuery: sourceOrdering.sourceRankingQuery,
    sourceVisibilityQuery: sourceOrdering.sourceVisibilityQuery,
    baseSourceReorderAllowed: sourceOrdering.baseSourceReorderAllowed,
    sourceSectionCount: sourceOrdering.sourceSectionCount,
    duplicateSourceSectionCount: sourceOrdering.duplicateSourceSectionCount,
    relationshipsSectionCount: sourceOrdering.relationshipsSectionCount,
    duplicateRelationshipsSectionCount: sourceOrdering.duplicateRelationshipsSectionCount,
    relationshipKindSectionCounts: sourceOrdering.relationshipKindSectionCounts,
    duplicateRelationshipKindSectionCount: sourceOrdering.duplicateRelationshipKindSectionCount,
    relatedSymbolsSectionCount: sourceOrdering.relatedSymbolsSectionCount,
    duplicateRelatedSymbolsSectionCount: sourceOrdering.duplicateRelatedSymbolsSectionCount,
    sourceBlockCount: sourceOrdering.sourceBlockCount,
    firstSourceFiles: compactStringArray(sourceOrdering.firstSourceFiles),
    rankedOverlayFiles: compactStringArray(sourceOrdering.rankedOverlayFiles),
    visibleSourceFileDetails: compactDiagnosticFileDetails(sourceOrdering.visibleSourceFileDetails),
    rankedOverlayFileDetails: compactDiagnosticFileDetails(sourceOrdering.rankedOverlayFileDetails),
    rawTopRankedOverlayFile: sourceOrdering.rawTopRankedOverlayFile,
    topRankedOverlayFile: sourceOrdering.topRankedOverlayFile,
    topRankedOverlayFileSelectionReason: sourceOrdering.topRankedOverlayFileSelectionReason,
    topRankedOverlayDecision: compactTopRankedOverlayDecision(sourceOrdering.topRankedOverlayDecision),
    topRankedOverlayFileSkippedLowValue: sourceOrdering.topRankedOverlayFileSkippedLowValue,
    topRankedOverlayFileVisibleIndex: sourceOrdering.topRankedOverlayFileVisibleIndex,
    firstSourceBlockIsTopRankedOverlayFile: sourceOrdering.firstSourceBlockIsTopRankedOverlayFile,
    topRankedOverlayFileMissing: sourceOrdering.topRankedOverlayFileMissing,
  };
}

function compactTopRankedOverlayDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    return null;
  }
  const result = {
    rawFile: decision.rawFile,
    selectedFile: decision.selectedFile,
    selectionReason: decision.selectionReason,
    rawVisibleIndex: decision.rawVisibleIndex,
    selectedVisibleIndex: decision.selectedVisibleIndex,
    rawLowValuePenalty: decision.rawLowValuePenalty,
    selectedLowValuePenalty: decision.selectedLowValuePenalty,
    rawPathClassLowValue: decision.rawPathClassLowValue,
    selectedPathClassLowValue: decision.selectedPathClassLowValue,
    rawCodegraphToolingSource: decision.rawCodegraphToolingSource,
    selectedCodegraphToolingSource: decision.selectedCodegraphToolingSource,
    rawDedupMaintenanceSource: decision.rawDedupMaintenanceSource,
    selectedDedupMaintenanceSource: decision.selectedDedupMaintenanceSource,
    skippedLowValue: decision.skippedLowValue,
    baseSourceReorderAllowed: decision.baseSourceReorderAllowed,
    baseSourceReorderReason: decision.baseSourceReorderReason,
    queryMentionsTests: decision.queryMentionsTests,
    queryMentionsCodegraphDedupMaintenance: decision.queryMentionsCodegraphDedupMaintenance,
    queryMentionsCodegraphTooling: decision.queryMentionsCodegraphTooling,
    rawEntry: compactDiagnosticFileDetail(decision.rawEntry),
    selectedEntry: compactDiagnosticFileDetail(decision.selectedEntry),
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined || result[key] === null) {
      delete result[key];
    }
  }
  return result;
}

function compactBaseSectionFiltering(baseSectionFiltering) {
  if (!baseSectionFiltering || typeof baseSectionFiltering !== 'object') {
    return null;
  }
  return {
    rawLineCount: baseSectionFiltering.rawLineCount,
    keptLineCount: baseSectionFiltering.keptLineCount,
    filteredLineCount: baseSectionFiltering.filteredLineCount,
    filteredByReason: baseSectionFiltering.filteredByReason,
    sectionsTouched: baseSectionFiltering.sectionsTouched,
    filteredLineDetails: Array.isArray(baseSectionFiltering.filteredLineDetails)
      ? baseSectionFiltering.filteredLineDetails.slice(0, 20)
      : [],
  };
}

function compactSourceSelection(sourceSelection) {
  if (!sourceSelection || typeof sourceSelection !== 'object') {
    return null;
  }
  return {
    sourceRankingQuery: sourceSelection.sourceRankingQuery,
    sourceVisibilityQuery: sourceSelection.sourceVisibilityQuery,
    sourceBlockLimit: sourceSelection.sourceBlockLimit,
    rawBaseSourceBlockCount: sourceSelection.rawBaseSourceBlockCount,
    finalSourceBlockCount: sourceSelection.finalSourceBlockCount,
    rawBaseSourceFiles: compactStringArray(sourceSelection.rawBaseSourceFiles),
    finalSourceFiles: compactStringArray(sourceSelection.finalSourceFiles),
    visibleSourceFiles: compactStringArray(sourceSelection.visibleSourceFiles),
    filteredSourceFiles: compactStringArray(sourceSelection.filteredSourceFiles),
    overlayCandidateFiles: compactDiagnosticFileDetails(sourceSelection.overlayCandidateFiles),
    contextCandidateFiles: compactDiagnosticFileDetails(sourceSelection.contextCandidateFiles),
  };
}

function activeWorkCount(event) {
  return Number(event.activeRequestCount ?? event.runtime?.activeRequestCount ?? 0)
    + Number(event.pendingContextPackCount ?? event.runtime?.pendingContextPackCount ?? 0)
    + Number(event.pendingToolsListCount ?? event.runtime?.pendingToolsListCount ?? 0)
    + activeChildInputQueueWorkCount(event);
}

function activeChildInputQueueWorkCount(event) {
  const queueLength = Number(event.childInputQueueLength ?? event.runtime?.childInputQueueLength ?? 0);
  if (queueLength <= 0) {
    return 0;
  }

  const reasons = event.childInputQueueReasons ?? event.runtime?.childInputQueueReasons;
  if (!Array.isArray(reasons) || reasons.length < queueLength) {
    return queueLength;
  }

  return reasons
    .slice(0, queueLength)
    .filter(reason => !String(reason ?? '').startsWith('replay-'))
    .length;
}

function isExpectedHostStdinExit(event) {
  return event.failureClass === 'host-stdin-closed'
    && event.expectedExit === true
    && event.transportClosedBy === 'client-stdin';
}

function isExpectedHostStdoutExit(event) {
  return event.failureClass === 'host-stdout-closed'
    && event.expectedExit === true
    && event.transportClosedBy === 'client-stdout';
}

function isExpectedHostStderrExit(event) {
  return event.failureClass === 'host-stderr-closed'
    && event.expectedExit === true
    && event.transportClosedBy === 'client-stderr';
}

function isExpectedHostStdioExit(event) {
  return isExpectedHostStdinExit(event)
    || isExpectedHostStdoutExit(event)
    || isExpectedHostStderrExit(event);
}

function isCriticalTransportFailure(event) {
  if (event.event === 'child.exit') {
    return activeWorkCount(event) > 0;
  }

  if (event.event === 'wrapper.exit' || String(event.event ?? '').startsWith('wrapper.shutdown.')) {
    if (isExpectedHostStdioExit(event)) return false;
    if (event.failureClass === 'client-invalid-header') return true;
    return activeWorkCount(event) > 0 || Number(event.activeRequestsAtShutdown ?? 0) > 0;
  }

  if (event.event === 'wrapper.fatal') {
    return true;
  }

  if (event.event === 'wrapper.runtime.diagnostic' && event.fatal === true) {
    return true;
  }

  return false;
}

function isRunActivityEvent(event) {
  if (!event?.runId || event.event === 'wrapper.start') return false;
  return true;
}

function isContextSourceOrderingEvent(event) {
  return event?.event === 'nanoflow.context.response'
    || event?.event === 'nanoflow.context.timeout';
}

function isOverlaySubprocessFailure(event) {
  const failureClass = String(event?.failureClass ?? '');
  return failureClass.startsWith('overlay-') && failureClass !== 'overlay-timeout';
}

function createStaleWrapperSummary() {
  return {
    detected: 0,
    continued: 0,
    recycleSkipped: 0,
    recycleRequested: 0,
    shutdown: 0,
    latest: null,
  };
}

function recordStaleWrapperEvent(bucket, event, wrapperStartsByRunId) {
  if (!bucket || !event) return;
  if (event.event === 'wrapper.script.stale') {
    bucket.detected++;
  } else if (event.event === 'wrapper.script.stale.continue') {
    bucket.continued++;
  } else if (event.event === 'wrapper.script.stale.recycle.skipped') {
    bucket.recycleSkipped++;
  } else if (event.event === 'wrapper.script.stale.recycle.request') {
    bucket.recycleRequested++;
  } else if (event.event === 'wrapper.shutdown.stale-wrapper-script') {
    bucket.shutdown++;
  } else {
    return;
  }
  bucket.latest = compactEvent(event, wrapperStartsByRunId);
}

function createWrapperRuntimeDiagnosticSummary() {
  return {
    count: 0,
    fatal: 0,
    nonFatal: 0,
    byKind: {},
    byClass: {},
    first: null,
    latest: null,
    firstFatal: null,
    latestFatal: null,
    firstNonFatal: null,
    latestNonFatal: null,
  };
}

function recordWrapperRuntimeDiagnostic(bucket, event, wrapperStartsByRunId) {
  if (!bucket || event?.event !== 'wrapper.runtime.diagnostic') return;
  const compactedEvent = compactEvent(event, wrapperStartsByRunId);
  bucket.count++;
  if (event.fatal === true) {
    bucket.fatal++;
    if (!bucket.firstFatal) {
      bucket.firstFatal = compactedEvent;
    }
    bucket.latestFatal = compactedEvent;
  } else {
    bucket.nonFatal++;
    if (!bucket.firstNonFatal) {
      bucket.firstNonFatal = compactedEvent;
    }
    bucket.latestNonFatal = compactedEvent;
  }
  count(bucket.byKind, event.kind);
  count(bucket.byClass, event.failureClass);
  if (!bucket.first) {
    bucket.first = compactedEvent;
  }
  bucket.latest = compactedEvent;
}

function createCodegraphAutoSyncDisabledSummary() {
  return {
    count: 0,
    byDate: {},
    latest: null,
  };
}

function textTail(value, maxLength = 1200) {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function autoSyncDisabledWarningTextTail(event, maxLength = 1200) {
  return warningTextExcerpt(event?.text, maxLength)
    ?? warningTextExcerpt(event?.responseWarnings?.textTail, maxLength)
    ?? warningTextExcerpt(event?.baseResponseWarnings?.textTail, maxLength);
}

function warningTextExcerpt(text, maxLength = 1200) {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  const indexes = [
    'codegraph auto-sync is disabled',
    'auto-sync disabled',
    'file watcher disabled',
    'file watcher degraded',
    'index is frozen',
  ]
    .map(pattern => lower.indexOf(pattern))
    .filter(index => index >= 0);
  if (indexes.length === 0) return undefined;

  const firstIndex = Math.min(...indexes);
  const start = Math.max(0, firstIndex - 160);
  const paragraphEnd = value.indexOf('\n\n', firstIndex);
  const diagnosticEnd = paragraphEnd >= 0 ? paragraphEnd : value.length;
  const end = Math.min(diagnosticEnd, firstIndex + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < value.length ? '...' : '';
  return `${prefix}${value.slice(start, end)}${suffix}`;
}

function isCodegraphAutoSyncDisabledEvent(event) {
  if (
    event?.baseResponseWarnings?.codegraphAutoSyncDisabled === true
    || event?.responseWarnings?.codegraphAutoSyncDisabled === true
  ) {
    return true;
  }
  if (event?.event !== 'child.stderr') return false;
  const text = String(event.text ?? '').toLowerCase();
  return text.includes('codegraph auto-sync is disabled')
    || (text.includes('auto-sync disabled') && text.includes('file lock'))
    || (text.includes('index is frozen') && text.includes('codegraph'));
}

function recordCodegraphAutoSyncDisabled(bucket, event, wrapperStartsByRunId) {
  if (!bucket || !isCodegraphAutoSyncDisabledEvent(event)) return;
  bucket.count++;
  const dateKey = typeof event.ts === 'string' ? event.ts.slice(0, 10) : '(unknown)';
  count(bucket.byDate, dateKey);
  const warningText = autoSyncDisabledWarningTextTail(event);
  const latest = {
    ...compactAutoSyncDisabledEvent(event, wrapperStartsByRunId),
    failureClass: 'codegraph-autosync-disabled',
    baseResponseWarnings: compactResponseWarnings(event.baseResponseWarnings),
    responseWarnings: compactResponseWarnings(event.responseWarnings),
  };
  if (warningText) {
    latest.textTail = warningText;
  }
  if (warningText || !bucket.latest) {
    bucket.latest = latest;
  }
}

function compactActiveAutoSyncDisabledLatest(latest) {
  if (!latest || typeof latest !== 'object') return null;
  const result = {
    ts: latest.ts,
    runId: latest.runId,
    seq: latest.seq,
    event: latest.event,
    requestId: latest.requestId,
    requestKind: latest.requestKind,
    tool: latest.tool,
    outputMode: latest.outputMode,
    failureClass: latest.failureClass,
    textTail: latest.textTail,
    activeRequestCount: latest.activeRequestCount,
    pendingContextPackCount: latest.pendingContextPackCount,
    pendingToolsListCount: latest.pendingToolsListCount,
    baseResponseWarnings: compactResponseWarnings(latest.baseResponseWarnings),
    responseWarnings: compactResponseWarnings(latest.responseWarnings),
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function compactResponseWarnings(warnings) {
  if (!warnings || typeof warnings !== 'object') {
    return undefined;
  }
  const result = {
    codegraphAutoSyncDisabled: warnings.codegraphAutoSyncDisabled,
    failureClass: warnings.failureClass,
    textTail: warningTextExcerpt(warnings.textTail) ?? textTail(warnings.textTail),
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeCodegraphAutoSyncDisabledSummary(target, source) {
  if (!target || !source || Number(source.count ?? 0) <= 0) return;
  target.count += Number(source.count ?? 0);
  for (const [dateKey, countValue] of Object.entries(source.byDate ?? {})) {
    target.byDate[dateKey] = (target.byDate[dateKey] ?? 0) + Number(countValue ?? 0);
  }
  if (source.latest?.textTail || !target.latest) {
    target.latest = source.latest ?? target.latest;
  }
}

function createSummary() {
  return {
    logPath,
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    observedAt: isoFromMs(observedAtMs),
    observedDirectMcpError,
    observedDirectMcpFailureClass,
    totalLines: 0,
    totalEvents: 0,
    malformedLines: 0,
    malformedLineNumbers: [],
    malformedLineRootCauseClasses: {},
    malformedLineDetails: [],
    firstTs: null,
    lastTs: null,
    logFreshness: {
      observedAt: isoFromMs(observedAtMs),
      latestLogTs: null,
      latestLogAgeMs: null,
      activeWindowMs: ACTIVE_WRAPPER_WINDOW_MS,
      staleAgainstObservedAt: false,
      hasCurrentWrapperEvidence: true,
    },
    eventCounts: {},
    failureClassCounts: {},
    transportHealthy: true,
    criticalTransportFailures: 0,
    latestCriticalTransportFailure: null,
    currentTransportHealthy: true,
    currentCriticalTransportFailures: 0,
    latestCurrentCriticalTransportFailure: null,
    transportHealthScope: 'log-window',
    effectiveTransportHealthy: true,
    effectiveCriticalTransportFailures: 0,
    latestEffectiveCriticalTransportFailure: null,
    diagnosticTriage: null,
    childExit: {
      total: 0,
      idleZeroExit: 0,
      idleNonZeroExit: 0,
      withActiveRequests: 0,
      latest: null,
    },
    childSpawnErrors: {
      count: 0,
      byCode: {},
      byDate: {},
      latest: null,
    },
    childRestartBackoff: {
      count: 0,
      byCode: {},
      byExitClass: {},
      byExitName: {},
      maxDelayMs: 0,
      latest: null,
    },
    currentChildRestartBackoff: {
      count: 0,
      byCode: {},
      byExitClass: {},
      byExitName: {},
      maxDelayMs: 0,
      latest: null,
    },
    baseCodegraphUnavailable: {
      count: 0,
      byRequestKind: {},
      latest: null,
    },
    currentBaseCodegraphUnavailable: {
      count: 0,
      byRequestKind: {},
      latest: null,
    },
    wrapperExit: {
      total: 0,
      expectedHostStdinClosed: 0,
      expectedHostStdoutClosed: 0,
      expectedHostStderrClosed: 0,
      idleUnclassified: 0,
      critical: 0,
      latest: null,
    },
    wrapperRuntimeDiagnostics: createWrapperRuntimeDiagnosticSummary(),
    currentWrapperRuntimeDiagnostics: createWrapperRuntimeDiagnosticSummary(),
    staleWrapper: createStaleWrapperSummary(),
    currentStaleWrapper: createStaleWrapperSummary(),
    overlayTimeouts: {
      count: 0,
      byDate: {},
    },
    latestOverlayTimeout: null,
    overlayFailures: {
      count: 0,
      byClass: {},
      byDate: {},
      latest: null,
    },
    childErrorResponses: {
      count: 0,
      byRequestKind: {},
    },
    codegraphAutoSyncDisabled: createCodegraphAutoSyncDisabledSummary(),
    currentCodegraphAutoSyncDisabled: createCodegraphAutoSyncDisabledSummary(),
    activeCodegraphAutoSyncDisabled: createCodegraphAutoSyncDisabledSummary(),
    activeCodegraphAutoSyncDisabledRuns: [],
    wrapperStarts: {
      total: 0,
      versions: {},
      latest: null,
    },
    activeWrappers: {
      total: 0,
      matchingDisk: 0,
      staleAgainstDisk: 0,
      unknownDiskHash: 0,
      distinctScriptSha256: 0,
      distinctCodegraphTargets: 0,
      codegraphTargets: {},
      contextPackTimeoutMs: {},
      staleWrapperAutoRecycle: {},
      activeWindowMs: ACTIVE_WRAPPER_WINDOW_MS,
      detailLimit: ACTIVE_WRAPPER_DETAIL_LIMIT,
      latest: [],
    },
    contextSourceOrdering: {
      ...createContextSourceOrderingSummary(),
    },
    currentWrapper: null,
    currentDiskWrapper: null,
    currentConfiguredWrapper: null,
    currentContextWrapper: null,
    currentDiskContextWrapper: null,
    currentConfiguredContextWrapper: null,
    currentContextSourceOrdering: createContextSourceOrderingSummary(),
    currentDiskContextSourceOrdering: createContextSourceOrderingSummary(),
    rootCauseSummary: null,
    recommendations: [],
  };
}

function createContextSourceOrderingSummary() {
  return {
    total: 0,
    withDiagnostics: 0,
    missingDiagnostics: 0,
    duplicateSourceSections: 0,
    duplicateRelationshipsSections: 0,
    duplicateRelationshipKindSections: 0,
    duplicateRelatedSymbolsSections: 0,
    topRankedMissing: 0,
    benignTopRankedMissing: 0,
    topRankedNotFirst: 0,
    lowValueVisibleSourceBlocks: 0,
    lowValueSourcePollution: 0,
    baseSectionFilteringEvents: 0,
    baseSectionFilteredLines: 0,
    latestBaseSectionFiltering: null,
    sourceSelectionEvents: 0,
    sourceSelectionFilteredFiles: 0,
    latestSourceSelection: null,
    latestIssue: null,
    latestBenignTopRankedMissing: null,
    latestMissingDiagnostics: null,
  };
}

const REQUIRED_SOURCE_ORDERING_DIAGNOSTIC_FIELDS = [
  'sourceRankingQuery',
  'sourceVisibilityQuery',
  'sourceSectionCount',
  'duplicateSourceSectionCount',
  'relationshipsSectionCount',
  'duplicateRelationshipsSectionCount',
  'relationshipKindSectionCounts',
  'duplicateRelationshipKindSectionCount',
  'relatedSymbolsSectionCount',
  'duplicateRelatedSymbolsSectionCount',
  'sourceBlockCount',
  'firstSourceFiles',
  'rankedOverlayFiles',
  'rankedOverlayFileDetails',
  'topRankedOverlayFileVisibleIndex',
  'firstSourceBlockIsTopRankedOverlayFile',
  'topRankedOverlayFileMissing',
];

function missingSourceOrderingDiagnosticFields(sourceOrdering) {
  if (!sourceOrdering || typeof sourceOrdering !== 'object') {
    return REQUIRED_SOURCE_ORDERING_DIAGNOSTIC_FIELDS;
  }
  return REQUIRED_SOURCE_ORDERING_DIAGNOSTIC_FIELDS.filter(field => (
    !Object.prototype.hasOwnProperty.call(sourceOrdering, field)
  ));
}

function normalizeSourceOrderingPath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/').toLowerCase();
}

function sourceOrderingQueryMentionsTests(query) {
  return /\b(test|tests|testing|spec|verify|verifies|e2e|cy|cypress|playwright|fixture|fixtures|mock|mocks|stub|stubs|harness|snapshot|snapshots)\b/i.test(String(query ?? ''))
    || /测试|单测|用例/.test(String(query ?? ''));
}

function sourceOrderingQueryMentionsResourceRelation(query) {
  return /\b(?:template-url|templateurl|style-url|styleurl)\b/i.test(String(query ?? ''));
}

function sourceOrderingQueryMentionsContext7Documentation(query) {
  const normalized = normalizeSourceOrderingPath(query);
  if (normalized.includes('docs/context7') || normalized.includes('context7')) {
    return true;
  }
  const segments = new Set(searchPathSignalSegments(query));
  const hasDocumentationIntent = [
    'doc',
    'docs',
    'documentation',
    'document',
    'documents',
    'guide',
    'guides',
    'catalog',
    'retrieval',
  ].some(segment => segments.has(segment));
  const hasSourceMapIntent = normalized.includes('source-map')
    || normalized.includes('sourcemap')
    || (segments.has('source') && segments.has('map'));
  return hasDocumentationIntent && (segments.has('context') || hasSourceMapIntent);
}

function sourceOrderingQueryMentionsGeneratedSource(query) {
  return /\b(?:generated|gen|proto|protobuf|pb|grpc)\b/i.test(String(query ?? ''));
}

const SOURCE_ORDERING_TOOLING_LIFECYCLE_INTENT_SEGMENTS = new Set([
  'session',
  'sessions',
  'stdio',
  'transport',
  'wrapper',
]);

const SOURCE_ORDERING_TOOLING_LIFECYCLE_DIAGNOSTIC_SEGMENTS = new Set([
  'closed',
  'crash',
  'crashed',
  'crashes',
  'recycle',
  'recycled',
  'restart',
  'restarted',
  'restarting',
  'restarts',
  'shutdown',
  'stale',
  'timeout',
  'timeouts',
]);

function sourceOrderingQueryMentionsCodegraphTooling(query) {
  const segments = new Set(searchPathSignalSegments(query));
  const hasCodegraphAnchor = ['codegraph', 'codex', 'nanoflow', 'mcp'].some(segment => segments.has(segment));
  const hasLifecycleToolingQuery = [...segments].some(segment => (
    SOURCE_ORDERING_TOOLING_LIFECYCLE_INTENT_SEGMENTS.has(segment)
  )) && [...segments].some(segment => (
    SOURCE_ORDERING_TOOLING_LIFECYCLE_DIAGNOSTIC_SEGMENTS.has(segment)
  ));
  const hasToolingIntent = [
    'adapter',
    'autosync',
    'diagnostic',
    'diagnostics',
    'disabled',
    'doctor',
    'error',
    'errors',
    'frozen',
    'gate',
    'log',
    'logs',
    'mcp',
    'response',
    'responses',
    'script',
    'scripts',
    'smoke',
    'stdio',
    'transport',
    'warning',
    'warnings',
    'wrapper',
  ].some(segment => segments.has(segment));
  if (!hasCodegraphAnchor && hasLifecycleToolingQuery) return hasToolingIntent;
  if (hasCodegraphAnchor && hasToolingIntent) return true;

  const hasDedupBoundaryIntent = [
    'contract',
    'dedup',
    'dedupe',
    'deduplication',
    'dup',
    'duplicate',
    'duplicates',
    'duplication',
    'hotspot',
    'hotspots',
    'manifest',
    'upstream',
    'validator',
    'validators',
  ].some(segment => segments.has(segment));
  const hasGeneratorImplementationSignal = [
    'add',
    'android',
    'annotation',
    'annotations',
    'api',
    'build',
    'budget',
    'call',
    'calls',
    'collect',
    'context',
    'edge',
    'edges',
    'format',
    'formatter',
    'generator',
    'graph',
    'index',
    'kotlin',
    'markdown',
    'native',
    'ordering',
    'pack',
    'overlay',
    'read',
    'reference',
    'references',
    'resolve',
    'score',
    'scoring',
    'select',
    'semantic',
    'strict',
    'summarize',
    'symbol',
    'symbols',
    'type',
    'typescript',
  ].some(segment => segments.has(segment));
  return hasDedupBoundaryIntent && hasGeneratorImplementationSignal;
}

function sourceOrderingQueryAllowsLowValuePath(rawQuery, filePath) {
  const normalized = normalizeSourceOrderingPath(filePath);
  if (!normalized) return false;
  if (sourceOrderingQueryDirectlyMentionsPath(rawQuery, normalized)) return true;
  if (
    normalized.startsWith('docs/context7/')
    && /\.(?:mdx?|json)$/i.test(normalized)
  ) {
    return sourceOrderingQueryMentionsContext7Documentation(rawQuery);
  }
  if (sourceOrderingQueryCoversPathSegments(rawQuery, normalized)) {
    return !isTestLikeSourceOrderingPath(normalized)
      || sourceOrderingQueryMentionsTests(rawQuery);
  }
  if (isTestLikeSourceOrderingPath(normalized)) {
    return sourceOrderingQueryMentionsTests(rawQuery)
      && sourceOrderingQueryMentionsCodegraphTooling(rawQuery);
  }
  if (/(^|\/)scripts\//.test(normalized)) return sourceOrderingQueryMentionsCodegraphTooling(rawQuery);
  if (isAuxiliarySourceOrderingPath(normalized)) {
    return sourceOrderingQueryMentionsAuxiliarySource(rawQuery, normalized);
  }
  if (isGeneratedSourceOrderingPath(normalized)) {
    return sourceOrderingQueryMentionsGeneratedSource(rawQuery);
  }
  if (/\bicons?\b/.test(normalized)) {
    return /\bicons?\b/i.test(String(rawQuery ?? ''));
  }
  if (/\bi18n\b/.test(normalized)) {
    return /\bi18n\b/i.test(String(rawQuery ?? ''));
  }
  return false;
}

function sourceOrderingQueryMentionsPath(rawQuery, filePath) {
  return sourceOrderingQueryDirectlyMentionsPath(rawQuery, filePath)
    || sourceOrderingQueryCoversPathSegments(rawQuery, filePath);
}

function sourceOrderingQueryDirectlyMentionsPath(rawQuery, filePath) {
  const normalizedQuery = normalizeSourceOrderingPath(rawQuery);
  const normalizedPath = normalizeSourceOrderingPath(filePath);
  if (!normalizedQuery || !normalizedPath) return false;
  const basename = normalizedPath.split('/').pop();
  return normalizedQuery.includes(normalizedPath)
    || (Boolean(basename) && normalizedQuery.includes(basename));
}

function sourceOrderingQueryCoversPathSegments(rawQuery, filePath) {
  const querySegments = new Set(searchPathSignalSegments(rawQuery));
  const pathSegments = searchPathSignalSegments(normalizeSourceOrderingPath(filePath).split('/').pop());
  return pathSegments.length >= 2 && pathSegments.every(segment => querySegments.has(segment));
}

const SOURCE_ORDERING_LOW_VALUE_SEGMENTS = new Set([
  'src',
  'app',
  'lib',
  'test',
  'tests',
  'spec',
  'service',
  'component',
  'module',
  'index',
  'config',
  'setup',
  'file',
  'source',
  'code',
]);

function searchPathSignalSegments(value) {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\.[cm]?[jt]sx?$/i, '')
    .replace(/\.(?:html|css|scss|sass|less|sql|md|json)$/i, '');
  return [...new Set(String(normalized ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-z0-9$]+/i)
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2)
    .filter(segment => !SOURCE_ORDERING_LOW_VALUE_SEGMENTS.has(segment)))];
}

function isInferredLowValueSourceOrderingPath(filePath, rawQuery = '') {
  if (sourceOrderingQueryMentionsTests(rawQuery)) return false;
  const normalized = normalizeSourceOrderingPath(filePath);
  if (!normalized) return false;
  if (sourceOrderingQueryAllowsLowValuePath(rawQuery, filePath)) return false;
  if (
    normalized.startsWith('docs/context7/')
    && /\.(?:mdx?|json)$/i.test(normalized)
  ) {
    return !sourceOrderingQueryMentionsContext7Documentation(rawQuery);
  }
  if (isTestLikeSourceOrderingPath(normalized)) return true;
  if (isAuxiliarySourceOrderingPath(normalized)) {
    return !sourceOrderingQueryMentionsAuxiliarySource(rawQuery, normalized);
  }
  if (isGeneratedSourceOrderingPath(normalized)) {
    return !sourceOrderingQueryMentionsGeneratedSource(rawQuery);
  }
  if (isBuildCacheSourceOrderingPath(normalized)) {
    return true;
  }
  if (isPackagedArtifactSourceOrderingPath(normalized)) {
    return true;
  }
  if (/(^|\/)\.github\//.test(normalized)) {
    return true;
  }
  if (/(^|\/)cloudflare\/workers-static-assets\//.test(normalized)) {
    return true;
  }
  if (/(^|\/)scripts\//.test(normalized)) {
    return !sourceOrderingQueryMentionsCodegraphTooling(rawQuery);
  }
  if (/\bicons?\b/.test(normalized)) {
    return !/\bicons?\b/i.test(String(rawQuery ?? ''));
  }
  if (/\bi18n\b/.test(normalized)) {
    return !/\bi18n\b/i.test(String(rawQuery ?? ''));
  }
  return false;
}

function isTestLikeSourceOrderingPath(filePath) {
  const normalized = normalizeSourceOrderingPath(filePath);
  return /(^|\/)(e2e|cypress|playwright)(\/|$)/.test(normalized)
    || /\/(tests?|__tests?__|spec)\//.test(normalized)
    || /(^|\/)(__fixtures__|__mocks__|fixtures?|mocks?|stubs?|snapshots?|test-fixtures|testdata|test-data)(\/|$)/.test(normalized)
    || /(?:^|\/)test_[^/]+\.py$/.test(normalized)
    || /_test\.[a-z]+$/.test(normalized)
    || /\.(?:cy|e2e)\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(?:test|spec)-helpers\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(?:fixture|fixtures|mock|mocks|stub|stubs|harness|snapshot|snapshots)\.[cm]?[jt]sx?$/.test(normalized);
}

function isAuxiliarySourceOrderingPath(filePath) {
  const normalized = normalizeSourceOrderingPath(filePath);
  return /(^|\/)(stories?|storybook|demos?|samples?|examples?|playground)\//.test(normalized)
    || /\.(?:stories?|story|demo|sample|example|playground)\.[cm]?[jt]sx?$/.test(normalized);
}

function isGeneratedSourceOrderingPath(filePath) {
  const normalized = normalizeSourceOrderingPath(filePath);
  const fileName = normalized.split('/').pop() ?? normalized;
  return SOURCE_ORDERING_GENERATED_FILE_PATTERNS.some(pattern => pattern.test(fileName));
}

function isBuildCacheSourceOrderingPath(filePath) {
  const normalized = normalizeSourceOrderingPath(filePath);
  return /(^|\/)(dist|build|out|coverage|\.angular|\.cache|\.codegraph|\.next|\.nuxt|\.svelte-kit|\.turbo|\.vite|tmp|temp)(\/|$)/.test(normalized);
}

function isPackagedArtifactSourceOrderingPath(filePath) {
  const normalized = normalizeSourceOrderingPath(filePath);
  const fileName = normalized.split('/').pop() ?? normalized;
  return /\.(?:min|bundle|chunk)\.(?:[cm]?js|css)$/.test(fileName)
    || /\.(?:[cm]?js|css)\.map$/.test(fileName)
    || /(?:^|[-.])lock(?:file)?\.(?:json|ya?ml|toml)$/.test(fileName)
    || fileName === 'yarn.lock'
    || fileName === 'bun.lock'
    || fileName === 'bun.lockb';
}

function sourceOrderingQueryMentionsAuxiliarySource(rawQuery = '', filePath = '') {
  const segments = new Set(searchPathSignalSegments(rawQuery));
  const normalized = normalizeSourceOrderingPath(filePath);
  if (/(^|\/)(stories?|storybook)\//.test(normalized) || /\.(?:stories?|story)\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['story', 'stories', 'storybook'].some(segment => segments.has(segment));
  }
  if (/(^|\/)demos?\//.test(normalized) || /\.demo\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['demo', 'demos'].some(segment => segments.has(segment));
  }
  if (/(^|\/)samples?\//.test(normalized) || /\.sample\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['sample', 'samples'].some(segment => segments.has(segment));
  }
  if (/(^|\/)examples?\//.test(normalized) || /\.example\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['example', 'examples'].some(segment => segments.has(segment));
  }
  if (/(^|\/)playground\//.test(normalized) || /\.playground\.[cm]?[jt]sx?$/.test(normalized)) {
    return segments.has('playground');
  }
  return false;
}

function summarizeLowValueSourcePollution(sourceOrdering, rawQuery = '') {
  if (!sourceOrdering || typeof sourceOrdering !== 'object') {
    return {
      visibleLowValueSourceFiles: [],
      unpenalizedSourceFiles: [],
      unpenalizedSourceFilesOutsideVisible: [],
      isPolluted: false,
    };
  }

  const firstSourceFiles = Array.isArray(sourceOrdering.firstSourceFiles)
    ? sourceOrdering.firstSourceFiles
    : [];
  const rankedDetails = Array.isArray(sourceOrdering.rankedOverlayFileDetails)
    ? sourceOrdering.rankedOverlayFileDetails
    : [];

  const visibleSourceFiles = firstSourceFiles
    .map((filePath, index) => ({
      filePath: String(filePath ?? ''),
      normalizedFilePath: normalizeSourceOrderingPath(filePath),
      index,
    }))
    .filter(entry => entry.normalizedFilePath);
  const visiblePathSet = new Set(visibleSourceFiles.map(entry => entry.normalizedFilePath));
  const detailsByPath = new Map();
  const unpenalizedSourceFiles = new Map();

  for (const detail of rankedDetails) {
    if (!detail || typeof detail !== 'object') continue;
    const filePath = detail.filePath ?? detail.normalizedFilePath ?? detail.path;
    const normalizedFilePath = normalizeSourceOrderingPath(filePath);
    if (!normalizedFilePath) continue;
    const lowValuePenalty = sourceOrderingQueryAllowsLowValuePath(rawQuery, filePath)
      ? 0
      : Number(detail.lowValuePenalty ?? 0);
    const compactDetail = {
      filePath: String(filePath ?? ''),
      normalizedFilePath,
      lowValuePenalty,
      rawLowValuePenalty: Number(detail.rawLowValuePenalty ?? detail.lowValuePenalty ?? 0),
      explicitFileRequested: detail.explicitFileRequested === true,
      explicitPathRequested: detail.explicitPathRequested === true,
      explicitSourcePathRequested: detail.explicitSourcePathRequested === true,
      preferredSymbolEvidence: detail.preferredSymbolEvidence === true,
    };
    detailsByPath.set(normalizedFilePath, compactDetail);
    if (lowValuePenalty <= 0 && !unpenalizedSourceFiles.has(normalizedFilePath)) {
      unpenalizedSourceFiles.set(normalizedFilePath, compactDetail);
    }
  }

  const visibleLowValueSourceFiles = [];
  for (const visibleSourceFile of visibleSourceFiles) {
    const detail = detailsByPath.get(visibleSourceFile.normalizedFilePath);
    const lowValuePenalty = Number(detail?.lowValuePenalty ?? 0);
    const suppressInferredLowValue = sourceOrderingDetailSuppressesInferredLowValue(detail, rawQuery);
    const inferredLowValue = lowValuePenalty > 0
      || (!suppressInferredLowValue && isInferredLowValueSourceOrderingPath(visibleSourceFile.filePath, rawQuery));
    if (inferredLowValue) {
      visibleLowValueSourceFiles.push({
        ...visibleSourceFile,
        lowValuePenalty,
        inferredLowValue: lowValuePenalty <= 0,
      });
    } else if (!unpenalizedSourceFiles.has(visibleSourceFile.normalizedFilePath)) {
      unpenalizedSourceFiles.set(visibleSourceFile.normalizedFilePath, {
        filePath: visibleSourceFile.filePath,
        normalizedFilePath: visibleSourceFile.normalizedFilePath,
        lowValuePenalty: 0,
      });
    }
  }

  const unpenalizedSourceFileList = [...unpenalizedSourceFiles.values()];
  const unpenalizedSourceFilesOutsideVisible = unpenalizedSourceFileList
    .filter(detail => !visiblePathSet.has(detail.normalizedFilePath));
  const firstSourceFileIsLowValue = visibleLowValueSourceFiles.some(entry => entry.index === 0);
  const hasCleanAlternative = unpenalizedSourceFileList.length > 0;
  const hasVisibleCleanAlternative = visibleSourceFiles.some(visibleSourceFile => (
    !visibleLowValueSourceFiles.some(lowValueSourceFile => (
      lowValueSourceFile.normalizedFilePath === visibleSourceFile.normalizedFilePath
    ))
  ));
  const hasCleanReplacementBudget =
    unpenalizedSourceFilesOutsideVisible.length >= visibleLowValueSourceFiles.length;

  return {
    visibleLowValueSourceFiles,
    unpenalizedSourceFiles: unpenalizedSourceFileList,
    unpenalizedSourceFilesOutsideVisible,
    isPolluted: visibleLowValueSourceFiles.length > 0
      && (
        (firstSourceFileIsLowValue && hasCleanAlternative)
        || (rankedDetails.length === 0 && hasVisibleCleanAlternative)
        || hasCleanReplacementBudget
      ),
  };
}

function sourceOrderingDetailSuppressesInferredLowValue(detail, rawQuery = '') {
  if (!detail || typeof detail !== 'object') return false;
  if (sourceOrderingQueryAllowsLowValuePath(rawQuery, detail.filePath)) return true;
  if (detail.preferredSymbolEvidence === true) return true;
  if (
    detail.explicitFileRequested === true
    || detail.explicitPathRequested === true
    || detail.explicitSourcePathRequested === true
  ) {
    return true;
  }
  return Number(detail.rawLowValuePenalty ?? 0) > 0
    && Number(detail.lowValuePenalty ?? 0) <= 0;
}

function isBenignLowValueTopRankedOverlayMissing(sourceOrdering, rawQuery = '') {
  if (!sourceOrdering || typeof sourceOrdering !== 'object') return false;
  if (sourceOrdering.topRankedOverlayFileMissing !== true) return false;
  const topRankedOverlayFile = sourceOrdering.topRankedOverlayFile
    ?? sourceOrdering.rawTopRankedOverlayFile;
  if (!topRankedOverlayFile) return false;

  const normalizedTopRanked = normalizeSourceOrderingPath(topRankedOverlayFile);
  const rankedDetails = Array.isArray(sourceOrdering.rankedOverlayFileDetails)
    ? sourceOrdering.rankedOverlayFileDetails
    : [];
  const topRankedDetail = rankedDetails.find(detail => (
    normalizeSourceOrderingPath(detail?.filePath ?? detail?.normalizedFilePath ?? detail?.path) === normalizedTopRanked
  ));
  const topRankedIsLowValue = (
    Number(topRankedDetail?.lowValuePenalty ?? 0) > 0
    && !sourceOrderingQueryAllowsLowValuePath(rawQuery, topRankedOverlayFile)
  ) || isInferredLowValueSourceOrderingPath(topRankedOverlayFile, rawQuery);
  if (!topRankedIsLowValue) return false;

  const pollution = summarizeLowValueSourcePollution(sourceOrdering, rawQuery);
  return pollution.visibleLowValueSourceFiles.length === 0
    && pollution.unpenalizedSourceFiles.some(detail => (
      Array.isArray(sourceOrdering.firstSourceFiles)
      && sourceOrdering.firstSourceFiles
        .map(normalizeSourceOrderingPath)
        .includes(detail.normalizedFilePath)
    ));
}

function classifyContextSourceOrderingIssue(sourceOrdering, rawQuery = '') {
  if (!sourceOrdering || typeof sourceOrdering !== 'object') {
    return 'missing-source-ordering';
  }

  if (
    sourceOrdering.topRankedOverlayFileMissing === true
    && sourceOrderingRequiresTopRankedOverlayFirst(sourceOrdering)
    && !isBenignLowValueTopRankedOverlayMissing(sourceOrdering, rawQuery)
  ) {
    return 'top-ranked-overlay-missing';
  }

  if (
    sourceOrdering.topRankedOverlayFile
    && sourceOrderingRequiresTopRankedOverlayFirst(sourceOrdering)
    && Number(sourceOrdering.topRankedOverlayFileVisibleIndex ?? -1) >= 0
    && sourceOrdering.firstSourceBlockIsTopRankedOverlayFile === false
  ) {
    return 'top-ranked-overlay-not-first';
  }

  if (Number(sourceOrdering.duplicateSourceSectionCount ?? 0) > 0) {
    return 'duplicate-source-sections';
  }

  if (
    Number(sourceOrdering.duplicateRelationshipsSectionCount ?? 0) > 0
    || Number(sourceOrdering.duplicateRelatedSymbolsSectionCount ?? 0) > 0
  ) {
    return 'duplicate-native-relationship-sections';
  }

  if (Number(sourceOrdering.duplicateRelationshipKindSectionCount ?? 0) > 0) {
    return 'duplicate-relationship-kind-sections';
  }

  if (summarizeLowValueSourcePollution(sourceOrdering, rawQuery).isPolluted) {
    return 'low-value-source-block-visible';
  }

  return null;
}

function sourceOrderingRequiresTopRankedOverlayFirst(sourceOrdering) {
  return sourceOrdering?.baseSourceReorderAllowed !== false;
}

function recordContextSourceOrdering(target, event, wrapperStartsByRunId) {
  target.total++;
  const filteredBaseLines = Number(event.baseSectionFiltering?.filteredLineCount ?? 0);
  if (filteredBaseLines > 0) {
    target.baseSectionFilteringEvents++;
    target.baseSectionFilteredLines += filteredBaseLines;
    target.latestBaseSectionFiltering = {
      ...compactEvent(event, wrapperStartsByRunId),
      baseSectionFiltering: compactBaseSectionFiltering(event.baseSectionFiltering),
    };
  }
  const sourceSelection = compactSourceSelection(event.sourceSelection);
  const filteredSourceFileCount = Array.isArray(sourceSelection?.filteredSourceFiles)
    ? sourceSelection.filteredSourceFiles.length
    : 0;
  if (sourceSelection) {
    target.sourceSelectionEvents++;
    target.sourceSelectionFilteredFiles += filteredSourceFileCount;
    target.latestSourceSelection = {
      ...compactEvent(event, wrapperStartsByRunId),
      sourceSelection,
    };
  }
  const sourceOrdering = event.sourceOrdering;
  const issue = classifyContextSourceOrderingIssue(sourceOrdering, event.query);
  const missingFields = missingSourceOrderingDiagnosticFields(sourceOrdering);
  const lowValuePollution = sourceOrdering && typeof sourceOrdering === 'object'
    ? summarizeLowValueSourcePollution(sourceOrdering, event.query)
    : null;
  if (lowValuePollution) {
    target.lowValueVisibleSourceBlocks += lowValuePollution.visibleLowValueSourceFiles.length;
    if (lowValuePollution.isPolluted) {
      target.lowValueSourcePollution++;
    }
  }
  if (!sourceOrdering || typeof sourceOrdering !== 'object' || missingFields.length > 0) {
    target.missingDiagnostics++;
    target.latestMissingDiagnostics = {
      ...compactEvent(event, wrapperStartsByRunId),
      missingSourceOrderingFields: missingFields,
    };
  } else {
    target.withDiagnostics++;
    if (Number(sourceOrdering.duplicateSourceSectionCount ?? 0) > 0) {
      target.duplicateSourceSections++;
    }
    if (Number(sourceOrdering.duplicateRelationshipsSectionCount ?? 0) > 0) {
      target.duplicateRelationshipsSections++;
    }
    if (Number(sourceOrdering.duplicateRelationshipKindSectionCount ?? 0) > 0) {
      target.duplicateRelationshipKindSections++;
    }
    if (Number(sourceOrdering.duplicateRelatedSymbolsSectionCount ?? 0) > 0) {
      target.duplicateRelatedSymbolsSections++;
    }
    const benignTopRankedMissing = (
      sourceOrdering.topRankedOverlayFileMissing === true
      && sourceOrderingRequiresTopRankedOverlayFirst(sourceOrdering)
      && isBenignLowValueTopRankedOverlayMissing(sourceOrdering, event.query)
    );
    if (benignTopRankedMissing) {
      target.benignTopRankedMissing++;
      target.latestBenignTopRankedMissing = {
        ...compactEvent(event, wrapperStartsByRunId),
        benignReason: 'low-value-top-ranked-overlay-filtered',
        lowValuePollution,
      };
    }
    if (
      sourceOrdering.topRankedOverlayFileMissing === true
      && sourceOrderingRequiresTopRankedOverlayFirst(sourceOrdering)
      && !benignTopRankedMissing
    ) {
      target.topRankedMissing++;
    }
    if (
      sourceOrdering.topRankedOverlayFile
      && sourceOrderingRequiresTopRankedOverlayFirst(sourceOrdering)
      && Number(sourceOrdering.topRankedOverlayFileVisibleIndex ?? -1) >= 0
      && sourceOrdering.firstSourceBlockIsTopRankedOverlayFile === false
    ) {
      target.topRankedNotFirst++;
    }
  }
  if (issue && issue !== 'missing-source-ordering') {
    target.latestIssue = {
      ...compactEvent(event, wrapperStartsByRunId),
      issue,
    };
  }
}

function hasContextSourceOrderingIssues(sourceOrderingSummary) {
  return Boolean(sourceOrderingSummary)
    && (
      Number(sourceOrderingSummary.duplicateSourceSections ?? 0) > 0
      || Number(sourceOrderingSummary.duplicateRelationshipsSections ?? 0) > 0
      || Number(sourceOrderingSummary.duplicateRelationshipKindSections ?? 0) > 0
      || Number(sourceOrderingSummary.duplicateRelatedSymbolsSections ?? 0) > 0
      || Number(sourceOrderingSummary.topRankedMissing ?? 0) > 0
      || Number(sourceOrderingSummary.topRankedNotFirst ?? 0) > 0
      || Number(sourceOrderingSummary.lowValueSourcePollution ?? 0) > 0
    );
}

function hasCurrentContextSourceOrderingGuardFailure(summary) {
  const currentMatchesDisk = summary?.currentContextWrapper?.matchesDisk === true;
  const currentDiskMatchesDisk = summary?.currentDiskContextWrapper?.matchesDisk === true;
  const candidates = [
    currentMatchesDisk ? summary.currentContextSourceOrdering : null,
    !currentMatchesDisk && currentDiskMatchesDisk ? summary.currentDiskContextSourceOrdering : null,
  ].filter(Boolean);
  return candidates.some(sourceOrderingSummary => (
    Number(sourceOrderingSummary.total ?? 0) > 0
    && (
      Number(sourceOrderingSummary.missingDiagnostics ?? 0) > 0
      || hasContextSourceOrderingIssues(sourceOrderingSummary)
    )
  ));
}

function hasStaleCurrentWrapperGuardFailure(summary) {
  return summary?.currentWrapper?.matchesDisk === false
    || summary?.currentContextWrapper?.matchesDisk === false;
}

function hasActiveStaleWrappersGuardFailure(summary) {
  return Number(summary?.activeWrappers?.staleAgainstDisk ?? 0) > 0
    || Number(summary?.activeWrappers?.distinctScriptSha256 ?? 0) > 1;
}

function hasUntrustedDirectMcpGuardFailure(summary) {
  const directMcpTrust = String(summary?.rootCauseSummary?.directMcpTrust ?? '');
  return directMcpTrust.startsWith('do-not-trust-direct-mcp');
}

function recordChildRestartBackoff(target, event, wrapperStartsByRunId) {
  const exitClassification = classifyChildExit(event.code, event.signal);
  target.count++;
  count(target.byCode, event.code);
  count(target.byExitClass, event.childExitClass ?? exitClassification.childExitClass);
  count(target.byExitName, event.childExitName ?? exitClassification.childExitName);
  target.maxDelayMs = Math.max(target.maxDelayMs, Number(event.delayMs ?? 0));
  target.latest = compactEvent({
    ...exitClassification,
    ...event,
    childExitCodeHex: event.childExitCodeHex ?? exitClassification.childExitCodeHex,
    childExitClass: event.childExitClass ?? exitClassification.childExitClass,
    childExitName: event.childExitName ?? exitClassification.childExitName,
  }, wrapperStartsByRunId);
}

function recordBaseCodegraphUnavailable(target, event, wrapperStartsByRunId) {
  target.count++;
  count(target.byRequestKind, event.requestKind);
  target.latest = compactEvent(event, wrapperStartsByRunId);
}

function selectLatestRunActivity(activityByRunId, wrapperStartsByRunId) {
  return [...activityByRunId.values()]
    .filter(activity => wrapperStartsByRunId.has(activity.event.runId))
    .sort((a, b) => {
      const aTs = Number.isFinite(a.tsMs) ? a.tsMs : Number.NEGATIVE_INFINITY;
      const bTs = Number.isFinite(b.tsMs) ? b.tsMs : Number.NEGATIVE_INFINITY;
      return bTs - aTs;
    })[0];
}

function isTimestampInsideActiveWindow(tsMs, referenceMs) {
  if (!Number.isFinite(referenceMs)) return true;
  return Number.isFinite(tsMs)
    && tsMs >= referenceMs - ACTIVE_WRAPPER_WINDOW_MS;
}

function isActivityInsideActiveWindow(activity, referenceMs) {
  return isTimestampInsideActiveWindow(activity?.tsMs, referenceMs);
}

function selectLatestCurrentRunActivity(activityByRunId, wrapperStartsByRunId, referenceMs) {
  return [...activityByRunId.values()]
    .filter(activity => wrapperStartsByRunId.has(activity.event.runId))
    .filter(activity => isActivityInsideActiveWindow(activity, referenceMs))
    .sort((a, b) => {
      const aTs = Number.isFinite(a.tsMs) ? a.tsMs : Number.NEGATIVE_INFINITY;
      const bTs = Number.isFinite(b.tsMs) ? b.tsMs : Number.NEGATIVE_INFINITY;
      return bTs - aTs;
    })[0];
}

function selectLatestMatchingDiskRunActivity(activityByRunId, wrapperStartsByRunId, referenceMs = Number.NaN) {
  return [...activityByRunId.values()]
    .filter(activity => {
      if (!wrapperStartsByRunId.has(activity.event.runId)) return false;
      if (!isActivityInsideActiveWindow(activity, referenceMs)) return false;
      const wrapper = enrichActivityWithWrapperIdentity(activity, wrapperStartsByRunId);
      return wrapper?.matchesDisk === true;
    })
    .sort((a, b) => {
      const aTs = Number.isFinite(a.tsMs) ? a.tsMs : Number.NEGATIVE_INFINITY;
      const bTs = Number.isFinite(b.tsMs) ? b.tsMs : Number.NEGATIVE_INFINITY;
      return bTs - aTs;
    })[0];
}

function summarizeActiveWrappers(activityByRunId, wrapperStartsByRunId, referenceMs) {
  const activityCutoffMs = Number.isFinite(referenceMs)
    ? referenceMs - ACTIVE_WRAPPER_WINDOW_MS
    : Number.NEGATIVE_INFINITY;
  const latest = [...activityByRunId.values()]
    .filter(activity => {
      const activityMs = Number.isFinite(activity.tsMs) ? activity.tsMs : Number.NEGATIVE_INFINITY;
      return activityMs >= activityCutoffMs;
    })
    .map(activity => enrichActivityWithWrapperIdentity(activity, wrapperStartsByRunId))
    .filter(Boolean)
    .sort((a, b) => {
      const aTs = eventTimestampMs({ ts: a.latestTs });
      const bTs = eventTimestampMs({ ts: b.latestTs });
      return bTs - aTs;
    });
  const scriptHashes = new Set(latest.map(wrapper => wrapper.scriptSha256).filter(Boolean));
  const codegraphTargets = {};
  const contextPackTimeoutMs = {};
  const staleWrapperAutoRecycle = {};
  for (const wrapper of latest) {
    count(codegraphTargets, wrapper.codegraphTarget);
    count(contextPackTimeoutMs, wrapper.env?.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS);
    count(staleWrapperAutoRecycle, wrapper.env?.NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE);
  }

  return {
    total: latest.length,
    matchingDisk: latest.filter(wrapper => wrapper.matchesDisk === true).length,
    staleAgainstDisk: latest.filter(wrapper => wrapper.matchesDisk === false).length,
    unknownDiskHash: latest.filter(wrapper => wrapper.matchesDisk === null).length,
    distinctScriptSha256: scriptHashes.size,
    distinctCodegraphTargets: distinctPresentKeys(codegraphTargets),
    codegraphTargets,
    contextPackTimeoutMs,
    staleWrapperAutoRecycle,
    activeWindowMs: ACTIVE_WRAPPER_WINDOW_MS,
    detailLimit: ACTIVE_WRAPPER_DETAIL_LIMIT,
    latest: latest.slice(0, ACTIVE_WRAPPER_DETAIL_LIMIT),
  };
}

function distinctPresentKeys(counts) {
  return Object.keys(counts ?? {}).filter(key => key !== '(none)').length;
}

function selectLatestMatchingDiskWrapper(wrappers, predicate = () => true) {
  return wrappers.find(wrapper => wrapper.matchesDisk === true && predicate(wrapper)) ?? null;
}

function wrapperMatchesCurrentCodexConfig(wrapper, codexMcpConfig) {
  if (!wrapper || wrapper.matchesDisk !== true) return false;
  if (!codexMcpConfig?.codegraphServerConfigured) return false;
  const targetMatches = compareExpectedCodegraphTarget(
    wrapper,
    codexMcpConfig.expectedCodegraphTarget,
  ).matches === true;
  const envMatches = compareExpectedWrapperEnv(
    wrapper,
    codexMcpConfig.expectedEnv,
  ).matches === true;
  return targetMatches && envMatches;
}

function selectLatestConfiguredWrapper(wrappers, codexMcpConfig) {
  return selectLatestMatchingDiskWrapper(
    wrappers,
    wrapper => wrapperMatchesCurrentCodexConfig(wrapper, codexMcpConfig),
  );
}

function selectLatestConfiguredRunActivity(activityByRunId, wrapperStartsByRunId, codexMcpConfig, referenceMs = Number.NaN) {
  return [...activityByRunId.values()]
    .filter(activity => {
      if (!wrapperStartsByRunId.has(activity.event.runId)) return false;
      if (!isActivityInsideActiveWindow(activity, referenceMs)) return false;
      const wrapper = enrichActivityWithWrapperIdentity(activity, wrapperStartsByRunId);
      return wrapperMatchesCurrentCodexConfig(wrapper, codexMcpConfig);
    })
    .sort((a, b) => {
      const aTs = Number.isFinite(a.tsMs) ? a.tsMs : Number.NEGATIVE_INFINITY;
      const bTs = Number.isFinite(b.tsMs) ? b.tsMs : Number.NEGATIVE_INFINITY;
      return bTs - aTs;
    })[0];
}

function readLogEntries(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(entry => entry.line.trim())
    .map(({ line, lineNumber }) => {
      try {
        const event = JSON.parse(line);
        return {
          event,
          malformed: false,
          line,
          lineNumber,
          tsMs: eventTimestampMs(event),
        };
      } catch (error) {
        return {
          event: null,
          malformed: true,
          line,
          lineNumber,
          parseError: error instanceof Error ? error.message : String(error),
          tsMs: Number.NaN,
        };
      }
    });
}

function recordMalformedLine(summary, entries, entryIndex, wrapperStartsByRunId) {
  const entry = entries[entryIndex];
  const rootCauseClass = classifyMalformedLogLine(entry.line, entry.parseError);
  count(summary.malformedLineRootCauseClasses, rootCauseClass);
  if (summary.malformedLineNumbers.length < 200) {
    summary.malformedLineNumbers.push(entry.lineNumber);
  }
  if (summary.malformedLineDetails.length >= ACTIVE_WRAPPER_DETAIL_LIMIT) return;

  const previousEntry = findNearestValidEntry(entries, entryIndex, -1);
  const nextEntry = findNearestValidEntry(entries, entryIndex, 1);
  const suspectedRunId = readJsonLikeStringField(entry.line, 'runId');
  const suspectedEvent = readJsonLikeStringField(entry.line, 'event');
  const suspectedSeq = readJsonLikeNumberField(entry.line, 'seq');
  const previousEvent = previousEntry?.event ? compactEvent(previousEntry.event, wrapperStartsByRunId) : null;
  const nextEvent = nextEntry?.event ? compactEvent(nextEntry.event, wrapperStartsByRunId) : null;

  summary.malformedLineDetails.push({
    lineNumber: entry.lineNumber,
    rootCauseClass,
    parseError: entry.parseError,
    linePreview: previewLogLine(entry.line),
    suspectedRunId,
    suspectedEvent,
    suspectedSeq,
    nearbyRunId: suspectedRunId ?? previousEvent?.runId ?? nextEvent?.runId,
    nearbySeq: suspectedSeq ?? previousEvent?.seq ?? nextEvent?.seq,
    previousEvent,
    nextEvent,
  });
}

function findNearestValidEntry(entries, startIndex, direction) {
  for (let index = startIndex + direction; index >= 0 && index < entries.length; index += direction) {
    if (entries[index]?.event) return entries[index];
  }
  return null;
}

function classifyMalformedLogLine(line, parseError = '') {
  const text = String(line ?? '').trim();
  const errorText = String(parseError ?? '').toLowerCase();
  if (!text.startsWith('{')) return 'non-json-log-line';
  if (!text.endsWith('}') || errorText.includes('unexpected end')) return 'truncated-json-line';
  return 'invalid-json-line';
}

function readJsonLikeStringField(line, fieldName) {
  const match = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"([^"]*)"`).exec(String(line ?? ''));
  return match?.[1] ?? null;
}

function readJsonLikeNumberField(line, fieldName) {
  const match = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*(-?\\d+)`).exec(String(line ?? ''));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function previewLogLine(line, maxLength = 300) {
  const normalized = String(line ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferProjectRootFromLogPath(resolvedLogPath) {
  const logDir = path.dirname(resolvedLogPath);
  return path.basename(logDir).toLowerCase() === '.codegraph'
    ? path.dirname(logDir)
    : logDir;
}

function inspectCodexMcpConfig(summary) {
  const result = {
    source: 'codex',
    root: projectRoot,
    path: null,
    exists: false,
    parseError: null,
    appliesToRoot: null,
    codegraphServerConfigured: false,
    expectedCodegraphTarget: null,
    expectedEnv: {},
    currentWrapperTarget: compareExpectedCodegraphTarget(summary.currentWrapper, null),
    currentContextWrapperTarget: compareExpectedCodegraphTarget(summary.currentContextWrapper, null),
    currentWrapperEnv: compareExpectedWrapperEnv(summary.currentWrapper, {}),
    currentContextWrapperEnv: compareExpectedWrapperEnv(summary.currentContextWrapper, {}),
    hostConfigAlignmentOverrides: [],
    mismatch: false,
    rootCause: null,
  };

  let config;
  try {
    config = readCodexCodegraphMcpConfig(projectRoot);
  } catch (error) {
    return {
      ...result,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  const server = (
    config.appliesToRoot
    || config.parseError
    || process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG
  ) ? config.server : null;
  const args = Array.isArray(server?.args) ? server.args : [];
  const expectedCodegraphTarget = args[1] ? replaceWorkspaceFolder(args[1], projectRoot) : null;
  const expectedEnv = server?.env && typeof server.env === 'object' ? server.env : {};
  const currentContextWrapperTarget = summary.currentContextWrapper?.supersededByFreshWrapper === true
    ? { matches: null, expected: expectedCodegraphTarget, actual: null }
    : compareExpectedCodegraphTarget(summary.currentContextWrapper, expectedCodegraphTarget);
  const currentContextWrapperEnv = summary.currentContextWrapper?.supersededByFreshWrapper === true
    ? { matches: null, expected: expectedEnv, actual: null, mismatchedKeys: [], mismatches: [] }
    : compareExpectedWrapperEnv(summary.currentContextWrapper, expectedEnv);
  const currentWrapperTarget = compareExpectedCodegraphTarget(summary.currentWrapper, expectedCodegraphTarget);
  const currentWrapperEnv = compareExpectedWrapperEnv(summary.currentWrapper, expectedEnv);
  const hostConfigAlignmentOverrides = buildHostConfigAlignmentOverrides({
    currentWrapperTarget,
    currentContextWrapperTarget,
    currentWrapperEnv,
    currentContextWrapperEnv,
  });
  const mismatch = [
    currentWrapperTarget.matches,
    currentContextWrapperTarget.matches,
    currentWrapperEnv.matches,
    currentContextWrapperEnv.matches,
  ].some(value => value === false);

  return {
    ...result,
    path: config.path,
    exists: config.exists,
    parseError: config.parseError,
    appliesToRoot: config.appliesToRoot,
    codegraphServerConfigured: Boolean(server),
    expectedCodegraphTarget,
    expectedEnv,
    currentWrapperTarget,
    currentContextWrapperTarget,
    currentWrapperEnv,
    currentContextWrapperEnv,
    hostConfigAlignmentOverrides,
    mismatch,
    rootCause: mismatch ? hostConfigMismatchRootCause() : null,
  };
}

function compareExpectedCodegraphTarget(wrapperStart, expectedCodegraphTarget) {
  if (!expectedCodegraphTarget) {
    return { matches: null, expected: null, actual: wrapperStart?.codegraphTarget ?? null };
  }
  if (!wrapperStart || typeof wrapperStart.codegraphTarget !== 'string') {
    return { matches: null, expected: expectedCodegraphTarget, actual: null };
  }
  const alignmentOverride = getWrapperConfigAlignmentOverride(wrapperStart);
  if (alignmentOverride) {
    return {
      matches: null,
      expected: expectedCodegraphTarget,
      actual: wrapperStart.codegraphTarget,
      ignored: true,
      ignoredReason: alignmentOverride.reason,
      status: alignmentOverride.status,
      alignmentMode: alignmentOverride.alignmentMode,
      mismatchCount: alignmentOverride.mismatchCount,
      configAlignmentMismatches: alignmentOverride.mismatches,
    };
  }
  return {
    matches: codegraphTargetsMatch(wrapperStart.codegraphTarget, expectedCodegraphTarget),
    expected: expectedCodegraphTarget,
    actual: wrapperStart.codegraphTarget,
  };
}

function compareExpectedWrapperEnv(wrapperStart, configuredEnv) {
  const expected = Object.fromEntries(
    Object.entries(configuredEnv ?? {})
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, String(value)]),
  );
  if (Object.keys(expected).length === 0) {
    return { matches: null, expected, actual: null, mismatchedKeys: [], mismatches: [] };
  }
  if (!wrapperStart || !wrapperStart.env || typeof wrapperStart.env !== 'object') {
    return { matches: null, expected, actual: null, mismatchedKeys: [], mismatches: [] };
  }
  const actual = Object.fromEntries(
    Object.keys(expected).map(key => [
      key,
      typeof wrapperStart.env[key] === 'string' ? String(wrapperStart.env[key]) : null,
    ]),
  );
  const alignmentOverride = getWrapperConfigAlignmentOverride(wrapperStart);
  if (alignmentOverride) {
    return {
      matches: null,
      expected,
      actual,
      mismatchedKeys: [],
      mismatches: [],
      ignored: true,
      ignoredReason: alignmentOverride.reason,
      status: alignmentOverride.status,
      alignmentMode: alignmentOverride.alignmentMode,
      mismatchCount: alignmentOverride.mismatchCount,
      configAlignmentMismatches: alignmentOverride.mismatches,
    };
  }
  const mismatchedKeys = Object.keys(expected).filter(key => actual[key] !== expected[key]);
  const mismatches = mismatchedKeys.map(key => ({
    key,
    expected: expected[key],
    actual: actual[key],
  }));
  return { matches: mismatchedKeys.length === 0, expected, actual, mismatchedKeys, mismatches };
}

function getWrapperConfigAlignmentOverride(wrapperStart) {
  const alignment = wrapperStart?.codexConfigAlignment;
  const envMode = wrapperStart?.env?.NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE;
  const alignmentMode = typeof alignment?.alignmentMode === 'string'
    ? alignment.alignmentMode
    : typeof envMode === 'string'
      ? envMode
      : null;
  const status = typeof alignment?.status === 'string' ? alignment.status : null;
  if (status !== 'override' && (!alignmentMode || alignmentMode === 'strict')) {
    return null;
  }
  const mismatches = Array.isArray(alignment?.mismatches) ? alignment.mismatches : [];
  return {
    status: status ?? 'override',
    reason: typeof alignment?.reason === 'string'
      ? alignment.reason
      : 'wrapper-config-alignment-intentional-override',
    alignmentMode: alignmentMode ?? 'override',
    mismatchCount: alignment?.mismatchCount ?? mismatches.length,
    mismatches,
  };
}

function buildHostConfigMismatches(codexMcpConfig) {
  const result = [];
  appendTargetMismatch(result, 'currentWrapper', codexMcpConfig?.currentWrapperTarget);
  appendTargetMismatch(result, 'currentContextWrapper', codexMcpConfig?.currentContextWrapperTarget);
  appendEnvMismatches(result, 'currentWrapper', codexMcpConfig?.currentWrapperEnv);
  appendEnvMismatches(result, 'currentContextWrapper', codexMcpConfig?.currentContextWrapperEnv);
  return result;
}

function buildHostConfigAlignmentOverrides(comparisons) {
  const result = [];
  appendHostConfigAlignmentOverride(result, 'currentWrapper', comparisons.currentWrapperTarget);
  appendHostConfigAlignmentOverride(result, 'currentContextWrapper', comparisons.currentContextWrapperTarget);
  appendHostConfigAlignmentOverride(result, 'currentWrapper', comparisons.currentWrapperEnv);
  appendHostConfigAlignmentOverride(result, 'currentContextWrapper', comparisons.currentContextWrapperEnv);
  return result;
}

function appendHostConfigAlignmentOverride(result, scope, comparison) {
  if (comparison?.ignored !== true) {
    return;
  }
  if (result.some(item => item.scope === scope)) {
    return;
  }
  result.push({
    scope,
    status: comparison.status ?? 'override',
    reason: comparison.ignoredReason ?? 'wrapper-config-alignment-intentional-override',
    alignmentMode: comparison.alignmentMode ?? null,
    mismatchCount: comparison.mismatchCount ?? 0,
    mismatches: Array.isArray(comparison.configAlignmentMismatches)
      ? comparison.configAlignmentMismatches
      : [],
  });
}

function appendTargetMismatch(result, scope, comparison) {
  if (comparison?.matches !== false) {
    return;
  }
  result.push({
    scope,
    field: 'codegraphTarget',
    expected: comparison.expected ?? null,
    actual: comparison.actual ?? null,
  });
}

function appendEnvMismatches(result, scope, comparison) {
  const mismatches = Array.isArray(comparison?.mismatches) ? comparison.mismatches : [];
  for (const mismatch of mismatches) {
    result.push({
      scope,
      field: `env.${mismatch.key}`,
      key: mismatch.key,
      expected: mismatch.expected ?? null,
      actual: mismatch.actual ?? null,
    });
  }
}

function replaceWorkspaceFolder(value, root) {
  return String(value).replaceAll('${workspaceFolder}', root);
}

function codegraphTargetsMatch(actual, expected) {
  if (actual === expected) return true;
  return normalizePathLikeString(actual) === normalizePathLikeString(expected);
}

function normalizePathLikeString(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^"|"$/g, '').toLowerCase();
}

function hostConfigMismatchRootCause() {
  return {
    failureBoundary: 'mcp-host-config',
    failureClass: 'mcp-host-config-drift',
    transportShouldStayAlive: true,
    likelyRootCause: 'Live CodeGraph MCP wrapper target/env does not match the active Codex MCP configuration; the MCP host is still using an old session.',
    nextEvidence: [
      'codexMcpConfig.currentWrapperTarget',
      'codexMcpConfig.currentWrapperEnv',
      'codexMcpConfig.currentContextWrapperTarget',
      'codexMcpConfig.currentContextWrapperEnv',
      'C:\\Users\\MI\\.codex\\config.toml',
      'wrapper.start.codegraphTarget',
      'wrapper.start.env',
    ],
  };
}

function buildRootCauseSummary(summary) {
  const failureClasses = [];
  const recovery = [];
  const observed = {
    latestEffectiveCriticalTransportFailure: summary.latestEffectiveCriticalTransportFailure ?? null,
    currentWrapperMatchesDisk: summary.currentWrapper?.matchesDisk ?? null,
    currentContextWrapperMatchesDisk: summary.currentContextWrapper?.matchesDisk ?? null,
    activeWrapperCount: summary.activeWrappers?.total ?? 0,
    activeWrapperTargets: summary.activeWrappers?.codegraphTargets ?? {},
    activeContextPackTimeoutMs: summary.activeWrappers?.contextPackTimeoutMs ?? {},
    activeStaleWrapperAutoRecycle: summary.activeWrappers?.staleWrapperAutoRecycle ?? {},
    expectedCodegraphTarget: summary.codexMcpConfig?.expectedCodegraphTarget ?? null,
    currentWrapperTarget: summary.codexMcpConfig?.currentWrapperTarget?.actual ?? summary.currentWrapper?.codegraphTarget ?? null,
    currentContextWrapperTarget: summary.codexMcpConfig?.currentContextWrapperTarget?.actual ?? summary.currentContextWrapper?.codegraphTarget ?? null,
    currentWrapperTargetComparison: summary.codexMcpConfig?.currentWrapperTarget ?? null,
    currentContextWrapperTargetComparison: summary.codexMcpConfig?.currentContextWrapperTarget ?? null,
    currentDiskWrapperTarget: summary.currentDiskWrapper?.codegraphTarget ?? null,
    currentDiskContextWrapperTarget: summary.currentDiskContextWrapper?.codegraphTarget ?? null,
    currentConfiguredWrapperRunId: summary.currentConfiguredWrapper?.runId ?? null,
    currentConfiguredWrapperTarget: summary.currentConfiguredWrapper?.codegraphTarget ?? null,
    currentConfiguredContextWrapperRunId: summary.currentConfiguredContextWrapper?.runId ?? null,
    currentConfiguredContextWrapperTarget: summary.currentConfiguredContextWrapper?.codegraphTarget ?? null,
    currentWrapperEnvMismatchedKeys: summary.codexMcpConfig?.currentWrapperEnv?.mismatchedKeys ?? [],
    currentContextWrapperEnvMismatchedKeys: summary.codexMcpConfig?.currentContextWrapperEnv?.mismatchedKeys ?? [],
    currentWrapperEnvComparison: summary.codexMcpConfig?.currentWrapperEnv ?? null,
    currentContextWrapperEnvComparison: summary.codexMcpConfig?.currentContextWrapperEnv ?? null,
    hostConfigMismatches: buildHostConfigMismatches(summary.codexMcpConfig),
    hostConfigAlignmentOverrides: summary.codexMcpConfig?.hostConfigAlignmentOverrides ?? [],
    currentAutoSyncDisabledTail: summary.currentCodegraphAutoSyncDisabled?.latest?.textTail ?? null,
    activeAutoSyncDisabledCount: summary.activeCodegraphAutoSyncDisabled?.count ?? 0,
    activeAutoSyncDisabledTail: summary.activeCodegraphAutoSyncDisabled?.latest?.textTail ?? null,
    activeAutoSyncDisabledRuns: summary.activeCodegraphAutoSyncDisabledRuns ?? [],
    currentChildRestartBackoff: summary.currentChildRestartBackoff?.latest ?? null,
    currentBaseCodegraphUnavailable: summary.currentBaseCodegraphUnavailable?.latest ?? null,
    currentStaleWrapper: summary.currentStaleWrapper?.latest ?? null,
    currentContextSourceOrderingLatestIssue: summary.currentContextSourceOrdering?.latestIssue ?? null,
    currentContextSourceOrderingBenignTopRankedMissing:
      summary.currentContextSourceOrdering?.benignTopRankedMissing ?? 0,
    currentContextSourceOrderingLatestBenignTopRankedMissing:
      summary.currentContextSourceOrdering?.latestBenignTopRankedMissing ?? null,
    historicalContextSourceOrderingBenignTopRankedMissing:
      summary.contextSourceOrdering?.benignTopRankedMissing ?? 0,
    observedAt: summary.observedAt ?? null,
    latestLogTs: summary.logFreshness?.latestLogTs ?? null,
    latestLogAgeMs: summary.logFreshness?.latestLogAgeMs ?? null,
    logStaleAgainstObservedAt: summary.logFreshness?.staleAgainstObservedAt ?? false,
    hasCurrentWrapperEvidence: summary.logFreshness?.hasCurrentWrapperEvidence ?? true,
    directMcpError: summary.observedDirectMcpError ?? null,
    observedDirectMcpFailureClass: summary.observedDirectMcpFailureClass ?? null,
  };
  let status = 'direct-mcp-currently-healthy';
  let failureBoundary = 'none';
  let adapterFailureLikely = false;
  let directMcpTrust = 'trust-current-wrapper';
  const hasObservedDirectMcpError = Boolean(summary.observedDirectMcpFailureClass);
  if (summary.observedDirectMcpFailureClass) {
    failureClasses.push(summary.observedDirectMcpFailureClass);
  }

  if (
    summary.logFreshness?.staleAgainstObservedAt === true
    && summary.logFreshness?.hasCurrentWrapperEvidence === false
  ) {
    status = summary.observedDirectMcpFailureClass === 'observed-direct-mcp-transport-closed'
      ? 'direct-mcp-host-transport-closed'
      : 'direct-mcp-host-no-current-wrapper-evidence';
    failureBoundary = 'codex-mcp-host-transport';
    adapterFailureLikely = false;
    directMcpTrust = hasObservedDirectMcpError
      ? 'do-not-trust-direct-mcp-until-host-restarts'
      : 'do-not-trust-direct-mcp-until-host-writes-wrapper-log';
    failureClasses.push('no-current-wrapper-evidence');
    failureClasses.push('mcp-host-wrapper-not-started');
    recovery.push('Restart the Codex MCP host/session and confirm a fresh wrapper.start appears in .codegraph/nanoflow-mcp-wrapper.log.');
    recovery.push('Until current wrapper evidence appears, use npm run codegraph:adapter:context -- --query "<query>" --json for repository facts.');
  }

  if (!summary.effectiveTransportHealthy) {
    status = 'current-wrapper-transport-failure';
    failureBoundary = 'mcp-wrapper-transport';
    adapterFailureLikely = true;
    directMcpTrust = 'do-not-trust-direct-mcp-until-current-transport-failure-is-fixed';
    failureClasses.push('current-critical-transport-failure');
    recovery.push('Inspect latestEffectiveCriticalTransportFailure, active requests, and wrapper runtime diagnostics before changing timeout values.');
  }

  if (
    hasObservedDirectMcpError
    && !summary.latestEffectiveCriticalTransportFailure
    && status === 'direct-mcp-currently-healthy'
  ) {
    status = summary.observedDirectMcpFailureClass === 'observed-direct-mcp-transport-closed'
      ? 'direct-mcp-host-transport-closed'
      : 'direct-mcp-host-observed-error';
    failureBoundary = 'codex-mcp-host-transport';
    adapterFailureLikely = false;
    directMcpTrust = 'do-not-trust-direct-mcp-until-host-restarts';
    recovery.push('Direct CodeGraph MCP returned an error without a current wrapper crash; restart the Codex MCP host/session and use the fresh adapter fallback until direct MCP reconnects.');
    recovery.push('Until restart, use npm run codegraph:adapter:context -- --query "<query>" --json for repository facts.');
  }

  if (summary.currentChildRestartBackoff.count > 0 || summary.currentBaseCodegraphUnavailable.count > 0) {
    if (status === 'direct-mcp-currently-healthy') {
      status = 'base-codegraph-child-unavailable';
      failureBoundary = 'base-codegraph-child';
      directMcpTrust = 'degraded-until-base-codegraph-child-recovers';
    }
    failureClasses.push('base-codegraph-child-restart-backoff');
    recovery.push('Inspect currentChildRestartBackoff/currentBaseCodegraphUnavailable and retry after the base CodeGraph child restarts cleanly.');
  }

  if (summary.codexMcpConfig?.mismatch === true) {
    if (status === 'direct-mcp-currently-healthy') {
      status = 'direct-mcp-host-config-mismatch';
      failureBoundary = 'codex-mcp-host';
      directMcpTrust = 'do-not-trust-direct-mcp-until-host-restarts';
    }
    failureClasses.push('mcp-host-config-drift');
    if (summary.codexMcpConfig.currentWrapperTarget?.matches === false) {
      failureClasses.push('mcp-host-codegraph-target-mismatch');
    }
    if (
      summary.codexMcpConfig.currentWrapperEnv?.matches === false
      || summary.codexMcpConfig.currentContextWrapperEnv?.matches === false
    ) {
      failureClasses.push('mcp-host-env-mismatch');
    }
    recovery.push('Restart the Codex MCP host/session so direct MCP reloads C:\\Users\\MI\\.codex\\config.toml.');
    recovery.push('Until restart, use npm run codegraph:adapter:context -- --query "<query>" --json for repository facts.');
  }

  if (
    summary.currentWrapper?.matchesDisk === false
    || summary.currentContextWrapper?.matchesDisk === false
    || summary.activeWrappers.staleAgainstDisk > 0
    || summary.activeWrappers.distinctScriptSha256 > 1
  ) {
    if (status === 'direct-mcp-currently-healthy') {
      status = 'direct-mcp-host-stale-wrapper';
      failureBoundary = 'codex-mcp-host';
      directMcpTrust = 'do-not-trust-direct-mcp-until-host-restarts';
    }
    failureClasses.push('mcp-host-wrapper-script-stale');
    recovery.push('Restart the MCP host/session so direct MCP loads the current on-disk wrapper script.');
  }

  if (
    summary.currentCodegraphAutoSyncDisabled.count > 0
    || summary.activeCodegraphAutoSyncDisabled.count > 0
  ) {
    if (status === 'direct-mcp-currently-healthy') {
      status = 'base-codegraph-autosync-disabled';
      failureBoundary = 'base-codegraph-index-watcher';
      directMcpTrust = 'do-not-trust-direct-mcp-index-freshness-until-sync-runs';
    } else if (status.startsWith('direct-mcp-host-')) {
      status = 'direct-mcp-host-stale-or-index-frozen';
      failureBoundary = 'codex-mcp-host-and-base-codegraph-index-watcher';
      directMcpTrust = 'do-not-trust-direct-mcp-until-host-restarts-or-index-syncs';
    }
    failureClasses.push('codegraph-autosync-disabled');
    if (summary.activeCodegraphAutoSyncDisabled.count > 0) {
      failureClasses.push('active-wrapper-autosync-disabled');
    }
    recovery.push('Release the CodeGraph writer lock, run codegraph sync, then retry the MCP query before judging adapter quality.');
  }

  if (failureClasses.length === 0 && summary.criticalTransportFailures > 0) {
    status = 'historical-transport-failures-only';
    failureBoundary = 'historical-log-window';
    directMcpTrust = 'trust-current-wrapper';
    failureClasses.push('historical-critical-transport-failure');
    recovery.push('Use currentTransportHealthy/effectiveTransportHealthy for present-state triage; inspect historical failures only if they recur.');
  }

  if (failureClasses.length === 0 && summary.staleWrapper.recycleSkipped > 0) {
    status = 'historical-stale-wrapper-only';
    failureBoundary = 'historical-log-window';
    directMcpTrust = 'trust-current-wrapper';
    failureClasses.push('historical-stale-wrapper-script');
    recovery.push('Historical stale wrapper events are not current evidence unless currentWrapper/currentContextWrapper is also stale.');
  }

  return {
    status,
    failureBoundary,
    adapterFailureLikely,
    directMcpTrust,
    failureClasses: [...new Set(failureClasses)],
    observed,
    fallback: FRESH_ADAPTER_FALLBACK_COMMAND,
    recovery: [...new Set(recovery)],
  };
}

function buildDiagnosticTriage(rootCauseSummary) {
  const observed = rootCauseSummary?.observed ?? {};
  const fallback = rootCauseSummary?.fallback ?? FRESH_ADAPTER_FALLBACK_COMMAND;
  return {
    status: rootCauseSummary?.status ?? 'unknown',
    failureBoundary: rootCauseSummary?.failureBoundary ?? 'unknown',
    adapterFailureLikely: rootCauseSummary?.adapterFailureLikely ?? null,
    directMcpTrust: rootCauseSummary?.directMcpTrust ?? 'unknown',
    conclusionConfidence: selectDiagnosticConclusionConfidence(rootCauseSummary),
    failureClasses: Array.isArray(rootCauseSummary?.failureClasses)
      ? rootCauseSummary.failureClasses
      : [],
    doNotMisdiagnoseAs: buildDoNotMisdiagnoseAs(rootCauseSummary),
    primaryEvidence: {
      latestEffectiveCriticalTransportFailure: observed.latestEffectiveCriticalTransportFailure ?? null,
      currentWrapperMatchesDisk: observed.currentWrapperMatchesDisk ?? null,
      currentContextWrapperMatchesDisk: observed.currentContextWrapperMatchesDisk ?? null,
      activeWrapperCount: observed.activeWrapperCount ?? 0,
      expectedCodegraphTarget: observed.expectedCodegraphTarget ?? null,
      currentWrapperTarget: observed.currentWrapperTarget ?? null,
      currentContextWrapperTarget: observed.currentContextWrapperTarget ?? null,
      currentWrapperTargetComparison: observed.currentWrapperTargetComparison ?? null,
      currentContextWrapperTargetComparison: observed.currentContextWrapperTargetComparison ?? null,
      currentConfiguredWrapperRunId: observed.currentConfiguredWrapperRunId ?? null,
      currentConfiguredContextWrapperRunId: observed.currentConfiguredContextWrapperRunId ?? null,
      currentWrapperEnvMismatchedKeys: observed.currentWrapperEnvMismatchedKeys ?? [],
      currentContextWrapperEnvMismatchedKeys: observed.currentContextWrapperEnvMismatchedKeys ?? [],
      currentWrapperEnvComparison: observed.currentWrapperEnvComparison ?? null,
      currentContextWrapperEnvComparison: observed.currentContextWrapperEnvComparison ?? null,
      hostConfigMismatches: observed.hostConfigMismatches ?? [],
      hostConfigAlignmentOverrides: observed.hostConfigAlignmentOverrides ?? [],
      activeAutoSyncDisabledCount: observed.activeAutoSyncDisabledCount ?? 0,
      activeAutoSyncDisabledRuns: observed.activeAutoSyncDisabledRuns ?? [],
      latestLogAgeMs: observed.latestLogAgeMs ?? null,
      logStaleAgainstObservedAt: observed.logStaleAgainstObservedAt ?? false,
      hasCurrentWrapperEvidence: observed.hasCurrentWrapperEvidence ?? true,
      directMcpError: observed.directMcpError ?? null,
      observedDirectMcpFailureClass: observed.observedDirectMcpFailureClass ?? null,
    },
    fallback,
    decisionContract: buildDiagnosticDecisionContract(rootCauseSummary),
    evidenceGaps: buildDiagnosticEvidenceGaps(rootCauseSummary),
    requiredEvidenceBeforeConclusion: buildDiagnosticRequiredEvidenceBeforeConclusion(rootCauseSummary),
    investigationChecklist: buildDiagnosticInvestigationChecklist(rootCauseSummary, fallback),
    misdiagnosisGuards: buildDiagnosticMisdiagnosisGuards(rootCauseSummary),
    nextAction: selectDiagnosticTriageNextAction(rootCauseSummary),
  };
}

function selectDiagnosticConclusionConfidence(rootCauseSummary) {
  const failureClasses = new Set(rootCauseSummary?.failureClasses ?? []);
  const observed = rootCauseSummary?.observed ?? {};
  if (
    failureClasses.has('observed-direct-mcp-transport-closed')
    && observed.directMcpError
  ) {
    return 'high';
  }
  if (
    failureClasses.has('mcp-host-config-drift')
    && (
      observed.currentWrapperTarget !== observed.expectedCodegraphTarget
      || observed.currentContextWrapperTarget !== observed.expectedCodegraphTarget
      || (observed.currentWrapperEnvMismatchedKeys?.length ?? 0) > 0
      || (observed.currentContextWrapperEnvMismatchedKeys?.length ?? 0) > 0
    )
  ) {
    return 'high';
  }
  if (
    failureClasses.has('mcp-host-wrapper-script-stale')
    && (
      observed.currentWrapperMatchesDisk === false
      || observed.currentContextWrapperMatchesDisk === false
    )
  ) {
    return 'high';
  }
  if (rootCauseSummary?.adapterFailureLikely === true) {
    return observed.latestEffectiveCriticalTransportFailure ? 'high' : 'medium';
  }
  if (failureClasses.size > 0 || rootCauseSummary?.failureClasses?.length > 0) {
    return 'medium';
  }
  return 'low';
}

function buildDiagnosticDecisionContract(rootCauseSummary) {
  const directMcpTrust = String(rootCauseSummary?.directMcpTrust ?? '');
  const failureBoundary = String(rootCauseSummary?.failureBoundary ?? '');
  const failureClasses = new Set(rootCauseSummary?.failureClasses ?? []);
  const mustUseFreshAdapterFallback = directMcpTrust.startsWith('do-not-trust-direct-mcp');
  const mustRestartMcpHost = failureBoundary.includes('codex-mcp-host')
    || failureClasses.has('mcp-host-config-drift')
    || failureClasses.has('mcp-host-wrapper-script-stale');
  return {
    canDiagnoseAdapterFromDirectMcp: rootCauseSummary?.adapterFailureLikely !== false
      && !mustUseFreshAdapterFallback,
    mustUseFreshAdapterFallback,
    mustRestartMcpHost,
    mustRunDoctorBeforeAdapterFix: mustUseFreshAdapterFallback || mustRestartMcpHost,
    adapterFixBlockedUntilFreshEvidence: rootCauseSummary?.adapterFailureLikely === false
      && (mustUseFreshAdapterFallback || mustRestartMcpHost),
    canTreatAsTransportCrash: rootCauseSummary?.adapterFailureLikely === true
      && failureBoundary.includes('transport'),
    canTrustIndexFreshness: !failureClasses.has('codegraph-autosync-disabled')
      && !failureClasses.has('active-wrapper-autosync-disabled'),
  };
}

function buildDiagnosticEvidenceGaps(rootCauseSummary) {
  const gaps = [];
  const observed = rootCauseSummary?.observed ?? {};
  const contract = buildDiagnosticDecisionContract(rootCauseSummary);
  const failureClasses = new Set(rootCauseSummary?.failureClasses ?? []);
  const addGap = (gap) => {
    if (!gap?.missingEvidence) return;
    if (gaps.some(existing => existing.missingEvidence === gap.missingEvidence)) return;
    gaps.push(gap);
  };

  if (
    observed.hasCurrentWrapperEvidence === false
    || failureClasses.has('mcp-host-wrapper-not-started')
  ) {
    addGap({
      missingEvidence: 'current-wrapper-log-evidence',
      whyItMatters: 'Without a current wrapper.start or active wrapper event, direct MCP Transport closed belongs to the Codex host/session boundary, not to adapter code.',
      expectedLogEvent: 'wrapper.start',
      expectedLogPath: '.codegraph/nanoflow-mcp-wrapper.log',
      blocksConclusions: [
        'adapter-source-regression',
        'wrapper-transport-crash',
        'direct-mcp-healthy',
      ],
    });
  }

  if (contract.mustUseFreshAdapterFallback) {
    addGap({
      missingEvidence: 'fresh-adapter-fallback-result',
      whyItMatters: 'A fresh adapter fallback runs the on-disk wrapper in a new process; direct MCP errors cannot prove adapter failure until the fresh process reproduces them.',
      requiredCommand: FRESH_ADAPTER_FALLBACK_COMMAND,
      blocksConclusions: [
        'adapter-source-regression',
        'wrapper-transport-crash',
        'nanoflow-ranking-regression',
      ],
    });
  }

  if (contract.mustRunDoctorBeforeAdapterFix) {
    addGap({
      missingEvidence: 'adapter-doctor-config-snapshot',
      whyItMatters: 'Doctor output records the active Codex config, wrapper script path, CodeGraph target, and env so host drift is not mistaken for adapter behavior.',
      requiredCommand: ADAPTER_DOCTOR_COMMAND,
      blocksConclusions: [
        'adapter-source-regression',
        'overlay-timeout',
        'mcp-config-current',
      ],
    });
  }

  if (
    rootCauseSummary?.adapterFailureLikely === false
    && !observed.latestEffectiveCriticalTransportFailure
  ) {
    addGap({
      missingEvidence: 'current-wrapper-transport-failure-evidence',
      whyItMatters: 'No current child.exit, wrapper.fatal, or wrapper.exit critical event was found, so Transport closed should not be labeled as a wrapper crash.',
      requiredEvidence: 'latestEffectiveCriticalTransportFailure or currentCriticalTransportFailures > 0',
      blocksConclusions: [
        'wrapper-transport-crash',
      ],
    });
  }

  if (
    contract.mustRestartMcpHost
    && !observed.currentConfiguredWrapperRunId
  ) {
    addGap({
      missingEvidence: 'current-configured-wrapper-evidence',
      whyItMatters: 'Direct MCP has not shown a current wrapper that matches C:\\Users\\MI\\.codex\\config.toml, so host/session state may still be stale.',
      requiredEvidence: 'currentConfiguredWrapper.runId or currentConfiguredContextWrapper.runId after Codex MCP host/session restart',
      blocksConclusions: [
        'direct-mcp-healthy',
        'mcp-config-current',
      ],
    });
  }

  if (!contract.canTrustIndexFreshness) {
    addGap({
      missingEvidence: 'fresh-codegraph-index-evidence',
      whyItMatters: 'Auto-sync disabled means native CodeGraph may serve a frozen index, so missing or noisy source results are not reliable adapter-quality evidence.',
      requiredEvidence: 'release writer lock, run codegraph sync, then retry via fresh adapter fallback',
      blocksConclusions: [
        'nanoflow-ranking-regression',
        'missing-indexed-source',
      ],
    });
  }

  return gaps;
}

function buildDiagnosticRequiredEvidenceBeforeConclusion(rootCauseSummary) {
  const required = [];
  const observed = rootCauseSummary?.observed ?? {};
  const contract = buildDiagnosticDecisionContract(rootCauseSummary);
  const failureClasses = new Set(rootCauseSummary?.failureClasses ?? []);
  const addRequirement = (entry) => {
    if (!entry?.conclusion) return;
    if (required.some(existing => existing.conclusion === entry.conclusion)) return;
    required.push(entry);
  };

  if (
    rootCauseSummary?.adapterFailureLikely === false
    || contract.mustUseFreshAdapterFallback
  ) {
    addRequirement({
      conclusion: 'adapter-source-regression',
      requiredEvidence: [
        'fresh adapter fallback reproduces the same failure',
        'adapter doctor confirms the current Codex MCP config and wrapper target/env',
        'current wrapper log matches the current on-disk wrapper script',
      ],
      currentBlockingEvidence: [
        `adapterFailureLikely=${rootCauseSummary?.adapterFailureLikely}`,
        `directMcpTrust=${rootCauseSummary?.directMcpTrust ?? 'unknown'}`,
      ],
    });
  }

  if (!observed.latestEffectiveCriticalTransportFailure) {
    addRequirement({
      conclusion: 'wrapper-transport-crash',
      requiredEvidence: [
        'latestEffectiveCriticalTransportFailure or currentCriticalTransportFailures > 0',
        'current wrapper child.exit, wrapper.fatal, or critical wrapper.exit event with active request evidence',
      ],
      currentBlockingEvidence: [
        'latestEffectiveCriticalTransportFailure=null',
      ],
    });
  }

  if (failureClasses.has('codegraph-autosync-disabled') || failureClasses.has('active-wrapper-autosync-disabled')) {
    addRequirement({
      conclusion: 'nanoflow-ranking-regression',
      requiredEvidence: [
        'fresh CodeGraph index sync evidence',
        'fresh adapter fallback sourceOrdering/sourceSelection diagnostics after sync',
      ],
      currentBlockingEvidence: [
        'codegraph-autosync-disabled',
      ],
    });
  }

  if (String(rootCauseSummary?.directMcpTrust ?? '').startsWith('do-not-trust-direct-mcp')) {
    addRequirement({
      conclusion: 'direct-mcp-healthy',
      requiredEvidence: [
        'Codex MCP host/session restart',
        'fresh wrapper.start matching C:\\Users\\MI\\.codex\\config.toml',
        'fresh nanoflow_context_pack response from the restarted direct MCP host',
      ],
      currentBlockingEvidence: [
        `directMcpTrust=${rootCauseSummary?.directMcpTrust ?? 'unknown'}`,
      ],
    });
  }

  return required;
}

function buildDiagnosticInvestigationChecklist(rootCauseSummary, fallback) {
  const checklist = [
    DIAGNOSTIC_LOG_ANALYSIS_COMMAND,
    fallback,
  ];
  const contract = buildDiagnosticDecisionContract(rootCauseSummary);
  if (contract.mustRunDoctorBeforeAdapterFix || contract.mustRestartMcpHost) {
    checklist.push(ADAPTER_DOCTOR_COMMAND);
  }
  const recovery = Array.isArray(rootCauseSummary?.recovery)
    ? rootCauseSummary.recovery
    : [];
  checklist.push(...recovery);
  checklist.push('Compare diagnosticTriage.primaryEvidence against codexMcpConfig/currentWrapper/currentContextWrapper before changing adapter code.');
  return [...new Set(checklist)];
}

function buildDiagnosticMisdiagnosisGuards(rootCauseSummary) {
  const guards = [];
  const failureClasses = new Set(rootCauseSummary?.failureClasses ?? []);
  const observed = rootCauseSummary?.observed ?? {};
  const directMcpTrust = String(rootCauseSummary?.directMcpTrust ?? '');
  if (rootCauseSummary?.adapterFailureLikely === false) {
    guards.push({
      mistakenConclusion: 'adapter-source-regression',
      blockedBy: 'adapterFailureLikely=false; direct MCP evidence belongs to the host/session boundary until a fresh adapter fallback reproduces it.',
      requiredEvidenceBeforeConclusion: FRESH_ADAPTER_FALLBACK_COMMAND,
    });
  }
  if (!observed.latestEffectiveCriticalTransportFailure) {
    guards.push({
      mistakenConclusion: 'wrapper-transport-crash',
      blockedBy: observed.observedDirectMcpFailureClass
        ? `direct MCP reported ${observed.observedDirectMcpFailureClass} while latestEffectiveCriticalTransportFailure=null; treat this as host/session evidence until a fresh adapter fallback reproduces a wrapper crash.`
        : 'latestEffectiveCriticalTransportFailure=null; no current effective wrapper transport crash is present in this log window.',
      requiredEvidenceBeforeConclusion: 'latestEffectiveCriticalTransportFailure or currentCriticalTransportFailures > 0',
    });
  }
  if (directMcpTrust.startsWith('do-not-trust-direct-mcp')) {
    guards.push({
      mistakenConclusion: 'direct-mcp-healthy',
      blockedBy: `directMcpTrust=${directMcpTrust}; current direct MCP evidence is not trustworthy for adapter quality decisions.`,
      requiredEvidenceBeforeConclusion: 'fresh wrapper.start matching C:\\Users\\MI\\.codex\\config.toml plus a fresh nanoflow_context_pack response',
    });
  }
  if (
    failureClasses.has('codegraph-autosync-disabled')
    || failureClasses.has('active-wrapper-autosync-disabled')
  ) {
    guards.push({
      mistakenConclusion: 'nanoflow-ranking-regression',
      blockedBy: 'CodeGraph auto-sync disabled evidence means the native index may be frozen; ranking/source quality cannot be judged from this direct MCP response.',
      requiredEvidenceBeforeConclusion: 'release writer lock, run codegraph sync, then retry via fresh adapter fallback',
    });
    guards.push({
      mistakenConclusion: 'missing-indexed-source',
      blockedBy: 'auto-sync disabled can hide fresh indexed source even when adapter logic is correct.',
      requiredEvidenceBeforeConclusion: 'fresh index sync plus codegraph:adapter:context output',
    });
  }
  if (
    failureClasses.has('mcp-host-config-drift')
    || failureClasses.has('mcp-host-wrapper-script-stale')
  ) {
    guards.push({
      mistakenConclusion: 'overlay-timeout',
      blockedBy: 'host config/script drift is present; timeout symptoms from stale direct MCP must be reproduced in a fresh wrapper before changing overlay timeouts.',
      requiredEvidenceBeforeConclusion: 'fresh adapter fallback timeout with matching configured target/env',
    });
  }
  if (
    Number(observed.currentContextSourceOrderingBenignTopRankedMissing ?? 0) > 0
    && !observed.currentContextSourceOrderingLatestIssue
  ) {
    guards.push({
      mistakenConclusion: 'nanoflow-ranking-regression',
      blockedBy: 'currentContextSourceOrdering.benignTopRankedMissing>0 and latestIssue=null; the top-ranked missing signal was explained by low-value helper/test filtering.',
      requiredEvidenceBeforeConclusion: 'currentContextSourceOrdering.latestIssue or a fresh adapter fallback reproducing a non-benign source-ordering issue',
    });
  }
  return guards;
}

function buildDoNotMisdiagnoseAs(rootCauseSummary) {
  const result = [];
  const failureClasses = new Set(rootCauseSummary?.failureClasses ?? []);
  const status = String(rootCauseSummary?.status ?? '');
  const directMcpTrust = String(rootCauseSummary?.directMcpTrust ?? '');

  if (rootCauseSummary?.adapterFailureLikely === false) {
    result.push('adapter-source-regression');
  }
  if (directMcpTrust.startsWith('do-not-trust-direct-mcp')) {
    result.push('direct-mcp-healthy');
  }
  if (
    status.includes('host')
    || failureClasses.has('mcp-host-config-drift')
    || failureClasses.has('mcp-host-wrapper-script-stale')
  ) {
    result.push('wrapper-transport-crash');
    result.push('overlay-timeout');
  }
  if (
    failureClasses.has('codegraph-autosync-disabled')
    || failureClasses.has('active-wrapper-autosync-disabled')
  ) {
    result.push('nanoflow-ranking-regression');
    result.push('missing-indexed-source');
  }
  if (failureClasses.has('base-codegraph-child-restart-backoff')) {
    result.push('overlay-timeout');
  }
  if (
    Number(rootCauseSummary?.observed?.currentContextSourceOrderingBenignTopRankedMissing ?? 0) > 0
    && !rootCauseSummary?.observed?.currentContextSourceOrderingLatestIssue
  ) {
    result.push('nanoflow-ranking-regression');
  }

  return [...new Set(result)];
}

function selectDiagnosticTriageNextAction(rootCauseSummary) {
  const recovery = Array.isArray(rootCauseSummary?.recovery)
    ? rootCauseSummary.recovery
    : [];
  return recovery[0]
    ?? rootCauseSummary?.fallback
    ?? 'Inspect rootCauseSummary.observed before changing adapter code.';
}

function analyzeLog() {
  const summary = createSummary();
  if (!fs.existsSync(logPath)) {
    throw new Error(`MCP wrapper log not found: ${logPath}`);
  }

  const wrapperStartsByRunId = new Map();
  const latestRunActivityByRunId = new Map();
  const latestContextResponseByRunId = new Map();
  const autoSyncDisabledByRunId = new Map();
  const entries = readLogEntries(logPath);
  for (const { event, tsMs } of entries) {
    if (!event) continue;
    if (event.event === 'wrapper.start' && event.runId) {
      wrapperStartsByRunId.set(event.runId, event);
    }
    if (Number.isFinite(sinceMs) && Number.isFinite(tsMs) && tsMs < sinceMs) {
      continue;
    }
    if (isRunActivityEvent(event)) {
      const previous = latestRunActivityByRunId.get(event.runId);
      if (!previous || (Number.isFinite(tsMs) && tsMs >= previous.tsMs)) {
        latestRunActivityByRunId.set(event.runId, { tsMs, event });
      }
    }
    if (isContextSourceOrderingEvent(event) && event.runId) {
      const previous = latestContextResponseByRunId.get(event.runId);
      if (!previous || (Number.isFinite(tsMs) && tsMs >= previous.tsMs)) {
        latestContextResponseByRunId.set(event.runId, { tsMs, event });
      }
    }
  }

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const { event, malformed, tsMs } = entries[entryIndex];
    summary.totalLines++;

    if (malformed) {
      summary.malformedLines++;
      recordMalformedLine(summary, entries, entryIndex, wrapperStartsByRunId);
      continue;
    }

    if (Number.isFinite(sinceMs) && Number.isFinite(tsMs) && tsMs < sinceMs) {
      continue;
    }

    summary.totalEvents++;
    summary.firstTs ??= event.ts ?? null;
    summary.lastTs = event.ts ?? summary.lastTs;
    count(summary.eventCounts, event.event);
    count(summary.failureClassCounts, event.failureClass);

    if (event.event === 'child.exit') {
      summary.childExit.total++;
      summary.childExit.latest = compactEvent(event, wrapperStartsByRunId);
      if (activeWorkCount(event) > 0) {
        summary.childExit.withActiveRequests++;
      } else if ((event.code === 0 || event.code === '0') && !event.signal) {
        summary.childExit.idleZeroExit++;
      } else {
        summary.childExit.idleNonZeroExit++;
      }
    }

    if (event.event === 'child.spawn.error') {
      summary.childSpawnErrors.count++;
      count(summary.childSpawnErrors.byCode, event.code);
      const dateKey = typeof event.ts === 'string' ? event.ts.slice(0, 10) : '(unknown)';
      count(summary.childSpawnErrors.byDate, dateKey);
      summary.childSpawnErrors.latest = compactEvent(event, wrapperStartsByRunId);
    }

    if (event.event === 'child.restart.delayed') {
      recordChildRestartBackoff(summary.childRestartBackoff, event, wrapperStartsByRunId);
    }

    if (event.event === 'base-codegraph.unavailable') {
      recordBaseCodegraphUnavailable(summary.baseCodegraphUnavailable, event, wrapperStartsByRunId);
    }

    if (event.event === 'wrapper.exit') {
      summary.wrapperExit.total++;
      summary.wrapperExit.latest = compactEvent(event, wrapperStartsByRunId);
      if (isExpectedHostStdinExit(event)) {
        summary.wrapperExit.expectedHostStdinClosed++;
      } else if (isExpectedHostStdoutExit(event)) {
        summary.wrapperExit.expectedHostStdoutClosed++;
      } else if (isExpectedHostStderrExit(event)) {
        summary.wrapperExit.expectedHostStderrClosed++;
      } else if (isCriticalTransportFailure(event)) {
        summary.wrapperExit.critical++;
      } else {
        summary.wrapperExit.idleUnclassified++;
      }
    }

    recordStaleWrapperEvent(summary.staleWrapper, event, wrapperStartsByRunId);
    recordWrapperRuntimeDiagnostic(summary.wrapperRuntimeDiagnostics, event, wrapperStartsByRunId);
    recordCodegraphAutoSyncDisabled(summary.codegraphAutoSyncDisabled, event, wrapperStartsByRunId);
    if (isCodegraphAutoSyncDisabledEvent(event) && event.runId) {
      if (!autoSyncDisabledByRunId.has(event.runId)) {
        autoSyncDisabledByRunId.set(event.runId, createCodegraphAutoSyncDisabledSummary());
      }
      recordCodegraphAutoSyncDisabled(autoSyncDisabledByRunId.get(event.runId), event, wrapperStartsByRunId);
    }

    if (event.event === 'wrapper.start') {
      summary.wrapperStarts.total++;
      count(summary.wrapperStarts.versions, event.wrapperVersion);
      summary.wrapperStarts.latest = compactEvent(event, wrapperStartsByRunId);
    }

    if (isContextSourceOrderingEvent(event)) {
      recordContextSourceOrdering(summary.contextSourceOrdering, event, wrapperStartsByRunId);
    }

    if (event.event === 'overlay.query.timeout') {
      summary.overlayTimeouts.count++;
      const dateKey = typeof event.ts === 'string' ? event.ts.slice(0, 10) : '(unknown)';
      count(summary.overlayTimeouts.byDate, dateKey);
      summary.latestOverlayTimeout = compactEvent(event, wrapperStartsByRunId);
    }

    if (isOverlaySubprocessFailure(event)) {
      summary.overlayFailures.count++;
      count(summary.overlayFailures.byClass, event.failureClass);
      const dateKey = typeof event.ts === 'string' ? event.ts.slice(0, 10) : '(unknown)';
      count(summary.overlayFailures.byDate, dateKey);
      summary.overlayFailures.latest = compactEvent(event, wrapperStartsByRunId);
    }

    if (event.failureClass === 'child-error-response') {
      summary.childErrorResponses.count++;
      count(summary.childErrorResponses.byRequestKind, event.requestKind);
    }

    if (isCriticalTransportFailure(event)) {
      summary.criticalTransportFailures++;
      summary.latestCriticalTransportFailure = compactEvent(event, wrapperStartsByRunId);
    }
  }

  const latestLogMs = eventTimestampMs({ ts: summary.lastTs });
  const currentReferenceMs = Number.isFinite(observedAtMs) ? observedAtMs : latestLogMs;
  summary.logFreshness.latestLogTs = summary.lastTs;
  summary.logFreshness.latestLogAgeMs = Number.isFinite(observedAtMs) && Number.isFinite(latestLogMs)
    ? Math.max(0, observedAtMs - latestLogMs)
    : null;
  summary.logFreshness.staleAgainstObservedAt = Number.isFinite(observedAtMs)
    && !isTimestampInsideActiveWindow(latestLogMs, observedAtMs);

  const latestActivity = selectLatestCurrentRunActivity(
    latestRunActivityByRunId,
    wrapperStartsByRunId,
    currentReferenceMs,
  );
  const latestWrapperStartMs = eventTimestampMs(summary.wrapperStarts.latest);
  const currentWrapperStart = latestActivity
    ? wrapperStartsByRunId.get(latestActivity.event.runId)
    : isTimestampInsideActiveWindow(latestWrapperStartMs, currentReferenceMs)
      ? summary.wrapperStarts.latest
      : null;
  summary.currentWrapper = currentWrapperStart
    ? enrichWrapperStartWithDiskHash(compactWrapperStart(currentWrapperStart))
    : null;
  const latestContextActivity = selectLatestCurrentRunActivity(
    latestContextResponseByRunId,
    wrapperStartsByRunId,
    currentReferenceMs,
  );
  const currentContextWrapperStart = latestContextActivity
    ? wrapperStartsByRunId.get(latestContextActivity.event.runId)
    : null;
  summary.currentContextWrapper = currentContextWrapperStart
    ? {
        ...enrichWrapperStartWithDiskHash(compactWrapperStart(currentContextWrapperStart)),
        latestTs: latestContextActivity.event.ts,
        latestEvent: latestContextActivity.event.event,
        latestRequestId: latestContextActivity.event.requestId,
        latestRequestKind: latestContextActivity.event.requestKind,
        latestTool: latestContextActivity.event.tool,
        latestFailureClass: latestContextActivity.event.failureClass,
        supersededByFreshWrapper: false,
      }
    : null;
  markSupersededContextWrapper(summary);
  summary.activeWrappers = summarizeActiveWrappers(
    latestRunActivityByRunId,
    wrapperStartsByRunId,
    currentReferenceMs,
  );
  summary.logFreshness.hasCurrentWrapperEvidence = Boolean(
    summary.currentWrapper || summary.activeWrappers.total > 0,
  );
  for (const wrapper of summary.activeWrappers.latest) {
    if (!wrapper?.runId) continue;
    const runSummary = autoSyncDisabledByRunId.get(wrapper.runId);
    if (!runSummary || Number(runSummary.count ?? 0) <= 0) continue;
    mergeCodegraphAutoSyncDisabledSummary(summary.activeCodegraphAutoSyncDisabled, runSummary);
    if (summary.activeCodegraphAutoSyncDisabledRuns.length < ACTIVE_WRAPPER_DETAIL_LIMIT) {
      summary.activeCodegraphAutoSyncDisabledRuns.push({
        runId: wrapper.runId,
        pid: wrapper.wrapperPid ?? wrapper.pid ?? null,
        codegraphTarget: wrapper.codegraphTarget ?? null,
        latestTs: wrapper.latestTs ?? null,
        latestEvent: wrapper.latestEvent ?? null,
        matchesDisk: wrapper.matchesDisk ?? null,
        count: runSummary.count,
        latest: compactActiveAutoSyncDisabledLatest(runSummary.latest),
      });
    }
  }
  summary.currentDiskWrapper = selectLatestMatchingDiskWrapper(summary.activeWrappers.latest);
  const latestDiskContextActivity = selectLatestMatchingDiskRunActivity(
    latestContextResponseByRunId,
    wrapperStartsByRunId,
    currentReferenceMs,
  );
  summary.currentDiskContextWrapper = latestDiskContextActivity
    ? enrichActivityWithWrapperIdentity(latestDiskContextActivity, wrapperStartsByRunId)
    : null;
  const currentRunId = summary.currentWrapper?.runId;
  const currentContextRunId = summary.currentContextWrapper?.runId;
  const currentDiskContextRunId = summary.currentDiskContextWrapper?.runId;
  if (currentRunId || currentContextRunId || currentDiskContextRunId) {
    for (const { event, tsMs } of entries) {
      if (!event) continue;
      if (Number.isFinite(sinceMs) && Number.isFinite(tsMs) && tsMs < sinceMs) {
        continue;
      }
      if (
        event.runId !== currentRunId
        && event.runId !== currentContextRunId
        && event.runId !== currentDiskContextRunId
      ) {
        continue;
      }
      if (event.runId === currentRunId && isCriticalTransportFailure(event)) {
        summary.currentCriticalTransportFailures++;
        summary.latestCurrentCriticalTransportFailure = compactEvent(event, wrapperStartsByRunId);
      }
      if (event.runId === currentRunId && event.event === 'child.restart.delayed') {
        recordChildRestartBackoff(summary.currentChildRestartBackoff, event, wrapperStartsByRunId);
      }
      if (event.runId === currentRunId && event.event === 'base-codegraph.unavailable') {
        recordBaseCodegraphUnavailable(summary.currentBaseCodegraphUnavailable, event, wrapperStartsByRunId);
      }
      if (event.runId === currentRunId) {
        recordStaleWrapperEvent(summary.currentStaleWrapper, event, wrapperStartsByRunId);
        recordWrapperRuntimeDiagnostic(summary.currentWrapperRuntimeDiagnostics, event, wrapperStartsByRunId);
        recordCodegraphAutoSyncDisabled(summary.currentCodegraphAutoSyncDisabled, event, wrapperStartsByRunId);
      }
      if (event.runId === currentContextRunId && isContextSourceOrderingEvent(event)) {
        recordContextSourceOrdering(summary.currentContextSourceOrdering, event, wrapperStartsByRunId);
      }
      if (event.runId === currentDiskContextRunId && isContextSourceOrderingEvent(event)) {
        recordContextSourceOrdering(summary.currentDiskContextSourceOrdering, event, wrapperStartsByRunId);
      }
    }
  }

  summary.transportHealthy = summary.criticalTransportFailures === 0;
  summary.currentTransportHealthy = summary.currentCriticalTransportFailures === 0;
  summary.transportHealthScope = summary.currentWrapper ? 'current-wrapper' : 'log-window';
  summary.effectiveTransportHealthy = summary.currentWrapper
    ? summary.currentTransportHealthy
    : summary.transportHealthy;
  summary.effectiveCriticalTransportFailures = summary.currentWrapper
    ? summary.currentCriticalTransportFailures
    : summary.criticalTransportFailures;
  summary.latestEffectiveCriticalTransportFailure = summary.currentWrapper
    ? summary.latestCurrentCriticalTransportFailure
    : summary.latestCriticalTransportFailure;
  summary.codexMcpConfig = inspectCodexMcpConfig(summary);
  summary.currentConfiguredWrapper = selectLatestConfiguredWrapper(
    summary.activeWrappers.latest,
    summary.codexMcpConfig,
  );
  const latestConfiguredContextActivity = selectLatestConfiguredRunActivity(
    latestContextResponseByRunId,
    wrapperStartsByRunId,
    summary.codexMcpConfig,
    currentReferenceMs,
  );
  summary.currentConfiguredContextWrapper = latestConfiguredContextActivity
    ? enrichActivityWithWrapperIdentity(latestConfiguredContextActivity, wrapperStartsByRunId)
    : null;
  summary.rootCauseSummary = buildRootCauseSummary(summary);
  summary.diagnosticTriage = buildDiagnosticTriage(summary.rootCauseSummary);
  if (
    summary.logFreshness.staleAgainstObservedAt === true
    && summary.logFreshness.hasCurrentWrapperEvidence === false
  ) {
    summary.recommendations.push('No current CodeGraph MCP wrapper activity was recorded inside the observed active window; treat the failure as Codex MCP host transport/tool-registry state until a fresh wrapper.start appears in .codegraph/nanoflow-mcp-wrapper.log.');
  }
  if (
    summary.observedDirectMcpFailureClass
    && !summary.latestEffectiveCriticalTransportFailure
  ) {
    summary.recommendations.push('Observed direct CodeGraph MCP error was supplied to the log analyzer, but no current effective wrapper transport failure is present; treat this as Codex MCP host/session transport evidence and use npm run codegraph:adapter:context -- --query "<query>" --json before changing adapter code.');
  } else if (
    summary.observedDirectMcpFailureClass
    && summary.latestEffectiveCriticalTransportFailure
  ) {
    summary.recommendations.push('Observed direct CodeGraph MCP error is present alongside a current effective wrapper transport failure; inspect latestEffectiveCriticalTransportFailure before classifying the issue as host-only.');
  }
  if (summary.codexMcpConfig.mismatch) {
    summary.recommendations.push('Live CodeGraph MCP wrapper target/env does not match the active Codex MCP configuration; restart the MCP host/session so codegraph reconnects to the configured wrapper target, and until then use: npm run codegraph:adapter:context -- --query "<query>" --json');
  }
  if ((summary.codexMcpConfig.hostConfigAlignmentOverrides?.length ?? 0) > 0) {
    const modes = [...new Set(
      summary.codexMcpConfig.hostConfigAlignmentOverrides
        .map(item => item.alignmentMode)
        .filter(Boolean),
    )].join(', ');
    summary.recommendations.push(`Current wrapper logged Codex config alignment override mode(s): ${modes || 'override'}; treat target/env differences as adapter fallback or smoke probe evidence, not live Codex MCP host drift.`);
  }
  if (!summary.transportHealthy) {
    if (summary.effectiveTransportHealthy && summary.transportHealthScope === 'current-wrapper') {
      summary.recommendations.push('Historical critical transport failures remain in the log, but the current wrapper has no critical transport failures; use effectiveTransportHealthy/currentTransportHealthy for present-state MCP triage.');
    } else {
      summary.recommendations.push('Inspect latestCriticalTransportFailure.requestId and active requests before changing overlay timeouts.');
    }
  }
  if (summary.wrapperRuntimeDiagnostics.fatal > 0) {
    summary.recommendations.push('Wrapper runtime diagnostics recorded fatal errors; inspect wrapperRuntimeDiagnostics.latestFatal.rootCauseSnapshot, failureClass, and investigation before treating Transport closed as a generic MCP host failure. Non-fatal configAlignment diagnostics may appear earlier in the same log.');
  } else if (summary.wrapperRuntimeDiagnostics.count > 0) {
    summary.recommendations.push('Wrapper runtime diagnostics recorded non-fatal process warnings; inspect wrapperRuntimeDiagnostics.latestNonFatal before changing retry or timeout settings.');
  }
  if (!summary.currentTransportHealthy) {
    summary.recommendations.push('The current wrapper still has critical transport failures; inspect latestCurrentCriticalTransportFailure and active requests before changing overlay timeouts.');
  }
  if (summary.malformedLines > 0) {
    summary.recommendations.push('Malformed MCP log lines include line-level diagnostics; inspect malformedLineDetails.lineNumber, rootCauseClass, parseError, nearbyRunId, previousEvent, and nextEvent before assuming the wrapper crashed.');
  }
  if (summary.overlayTimeouts.count > 0) {
    summary.recommendations.push('Overlay timeouts are query-path failures; inspect latestOverlayTimeout.lastProfilePhase and skipRefresh before treating them as transport crashes.');
  }
  if (summary.overlayFailures.count > 0) {
    summary.recommendations.push('Overlay subprocess failures are query-path failures; inspect overlayFailures.latest.failureClass, stdout/stderr bytes, and profile phases before treating them as transport crashes.');
  }
  if (summary.childSpawnErrors.count > 0) {
    summary.recommendations.push('Child spawn errors are startup failures; inspect childSpawnErrors.latest.message/code and the configured CodeGraph target before changing request-time timeout handling.');
  }
  if (summary.currentChildRestartBackoff.count > 0) {
    summary.recommendations.push('The current wrapper is backing off base CodeGraph child restarts; inspect currentChildRestartBackoff.latest.code/delayMs/rapidExitCount and child stderr before retrying broad MCP calls.');
  } else if (summary.childRestartBackoff.count > 0) {
    summary.recommendations.push('Historical base CodeGraph child restart backoff was detected; inspect childRestartBackoff.latest.code/delayMs/rapidExitCount before treating Transport closed as an overlay timeout.');
  }
  if (summary.currentBaseCodegraphUnavailable.count > 0) {
    summary.recommendations.push('The current wrapper returned base-codegraph-unavailable responses while keeping the MCP transport alive; inspect currentBaseCodegraphUnavailable.latest and retry after child.restart.');
  } else if (summary.baseCodegraphUnavailable.count > 0) {
    summary.recommendations.push('Historical base-codegraph-unavailable responses were recorded; inspect baseCodegraphUnavailable.latest to see which requests hit child restart backoff.');
  }
  if (summary.currentCodegraphAutoSyncDisabled.count > 0) {
    summary.recommendations.push('CodeGraph auto-sync is disabled for the current wrapper; the index may be frozen. Inspect currentCodegraphAutoSyncDisabled.latest.textTail, release the file lock, run codegraph sync, then retry the MCP query before judging adapter quality.');
  } else if (summary.activeCodegraphAutoSyncDisabled.count > 0) {
    summary.recommendations.push('One or more recently active CodeGraph MCP wrappers returned auto-sync disabled warnings; direct MCP may route to a frozen index even when the latest wrapper looks clean. Inspect activeCodegraphAutoSyncDisabledRuns, release the writer lock, run codegraph sync, and use the fresh adapter fallback until the MCP host is restarted.');
  } else if (summary.codegraphAutoSyncDisabled.count > 0) {
    summary.recommendations.push('Historical CodeGraph auto-sync disabled warnings were recorded; inspect codegraphAutoSyncDisabled.latest.textTail before treating stale results as adapter quality failures.');
  }
  if (summary.wrapperExit.expectedHostStdinClosed > 0) {
    summary.recommendations.push('host-stdin-closed wrapper exits are expected when the MCP host closes stdin with no active requests.');
  }
  if (summary.wrapperExit.expectedHostStdoutClosed > 0) {
    summary.recommendations.push('host-stdout-closed wrapper exits are expected when the MCP host closes stdout; inspect client.stdout.error before treating Transport closed as a wrapper crash.');
  }
  if (summary.wrapperExit.expectedHostStderrClosed > 0) {
    summary.recommendations.push('host-stderr-closed wrapper exits indicate the diagnostic stream closed; inspect client.stderr.error and stdout transport health separately.');
  }
  if (summary.currentStaleWrapper.recycleSkipped > 0) {
    summary.recommendations.push('The current wrapper detected a stale script and skipped automatic recycle; MCP transport should stay alive, but restart the MCP host/session to load the current on-disk wrapper.');
  } else if (summary.staleWrapper.recycleSkipped > 0) {
    summary.recommendations.push('Historical stale wrapper detections skipped automatic recycle and kept transport alive; inspect staleWrapper.latest before treating Transport closed as a wrapper crash.');
  }
  if (summary.currentStaleWrapper.recycleRequested > 0 || summary.currentStaleWrapper.shutdown > 0) {
    summary.recommendations.push('The current wrapper auto-recycled after stale detection; Transport closed is expected when NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=1 is active and the current NanoFlow response has completed.');
  } else if (summary.staleWrapper.recycleRequested > 0 || summary.staleWrapper.shutdown > 0) {
    summary.recommendations.push('Historical stale wrapper auto-recycle events were recorded; verify whether NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=1 was set before treating the wrapper exit as a crash.');
  }
  if (summary.currentWrapper?.matchesDisk === false) {
    summary.recommendations.push('current wrapper script hash does not match the current on-disk wrapper script; restart the MCP host/session before judging context-pack behavior.');
  } else if (summary.currentWrapper && summary.currentWrapper.matchesDisk === null) {
    summary.recommendations.push('The current wrapper script hash could not be compared with disk; inspect currentWrapper.diskScriptHashError before judging whether the live MCP process is stale.');
  }
  if (summary.activeWrappers.distinctScriptSha256 > 1) {
    summary.recommendations.push('Multiple active wrapper script hashes are handling MCP requests; inspect activeWrappers.latest to find stale long-lived MCP sessions before judging current fixes.');
  }
  if (summary.activeWrappers.distinctCodegraphTargets > 1) {
    summary.recommendations.push('Multiple active CodeGraph targets are handling MCP requests; inspect activeWrappers.codegraphTargets and activeWrappers.latest before judging whether the current Codex MCP config is loaded.');
  }
  if (
    distinctPresentKeys(summary.activeWrappers.contextPackTimeoutMs) > 1
    || distinctPresentKeys(summary.activeWrappers.staleWrapperAutoRecycle) > 1
  ) {
    summary.recommendations.push('Multiple active MCP wrapper env values are present; inspect activeWrappers.contextPackTimeoutMs, activeWrappers.staleWrapperAutoRecycle, and wrapper.start.env before treating MCP errors as overlay failures.');
  }
  if (summary.activeWrappers.staleAgainstDisk > 0) {
    summary.recommendations.push('Active wrapper sessions still use an older on-disk script hash; restart the MCP host/session or route verification through a fresh wrapper process before judging the latest wrapper code.');
  }
  if (summary.currentContextWrapper?.supersededByFreshWrapper === true) {
    summary.recommendations.push('The latest host context-pack response is older than a fresh wrapper start; treat context-pack freshness as unconfirmed until the MCP host serves a new nanoflow_context_pack response.');
  }
  if (
    summary.currentWrapper?.matchesDisk === false
    && summary.currentDiskWrapper
  ) {
    summary.recommendations.push('currentDiskWrapper matches the current disk script; use it to judge current script bytes only while stale long-lived sessions are still active.');
  }
  if (
    summary.currentContextWrapper?.matchesDisk === false
    && summary.currentDiskContextWrapper
  ) {
    summary.recommendations.push('currentDiskContextWrapper matches the current disk script; use it to judge current context-pack script behavior only while stale sessions remain active.');
  }
  if (
    summary.currentDiskWrapper
    && summary.codexMcpConfig?.codegraphServerConfigured
    && !summary.currentConfiguredWrapper
  ) {
    summary.recommendations.push('currentDiskWrapper matches the current disk script but not the current Codex target/env; direct MCP is still untrusted until currentConfiguredWrapper appears after an MCP host/session restart.');
  }
  if (
    summary.currentDiskContextWrapper
    && summary.codexMcpConfig?.codegraphServerConfigured
    && !summary.currentConfiguredContextWrapper
  ) {
    summary.recommendations.push('currentDiskContextWrapper matches the current disk script but not the current Codex target/env; context-pack behavior is not proven against the active Codex config until currentConfiguredContextWrapper appears after an MCP host/session restart.');
  }
  if (summary.currentContextWrapper?.matchesDisk === false) {
    summary.recommendations.push('current context-pack wrapper script hash does not match the current on-disk wrapper script; restart the MCP host/session before judging context-pack source-ordering behavior.');
  } else if (
    summary.currentContextWrapper
    && summary.currentContextWrapper.matchesDisk === null
    && summary.currentContextWrapper.supersededByFreshWrapper !== true
  ) {
    summary.recommendations.push('The current context-pack wrapper script hash could not be compared with disk; inspect currentContextWrapper.diskScriptHashError before judging context-pack source-ordering behavior.');
  }
  const currentContextEvidenceFresh = summary.currentContextWrapper?.matchesDisk === true;
  const currentContextEvidenceStale = summary.currentContextWrapper?.matchesDisk === false;
  if (
    currentContextEvidenceFresh
    && summary.currentContextSourceOrdering.total > 0
    && summary.currentContextSourceOrdering.missingDiagnostics > 0
  ) {
    summary.recommendations.push('The current wrapper still has context-pack responses without sourceOrdering diagnostics; inspect currentContextSourceOrdering.latestMissingDiagnostics.');
  } else if (summary.contextSourceOrdering.missingDiagnostics > 0) {
    summary.recommendations.push('Historical context-pack responses lack sourceOrdering diagnostics; inspect contextSourceOrdering.latestMissingDiagnostics and compare wrapperStart.scriptSha256 before judging current fixes.');
  }
  if (summary.currentContextSourceOrdering.benignTopRankedMissing > 0) {
    summary.recommendations.push('The current context-pack recorded benign top-ranked overlay missing evidence; inspect currentContextSourceOrdering.latestBenignTopRankedMissing before treating low-value helper/test filtering as an adapter quality regression.');
  } else if (summary.contextSourceOrdering.benignTopRankedMissing > 0) {
    summary.recommendations.push('Historical benign top-ranked overlay missing evidence was recorded; inspect contextSourceOrdering.latestBenignTopRankedMissing before treating older source-ordering logs as adapter regressions.');
  }
  if (currentContextEvidenceFresh && hasContextSourceOrderingIssues(summary.currentContextSourceOrdering)) {
    summary.recommendations.push('The current wrapper still has context-pack source ordering issues; inspect currentContextSourceOrdering.latestIssue and ensure top-ranked overlay files appear before generic base CodeGraph source blocks without low-value source pollution.');
  } else if (hasContextSourceOrderingIssues(summary.contextSourceOrdering)) {
    summary.recommendations.push('Historical context-pack source ordering issues remain in the log; inspect contextSourceOrdering.latestIssue and compare wrapperStart.scriptSha256 against currentWrapper.scriptSha256.');
  }
  if (summary.currentContextSourceOrdering.baseSectionFilteredLines > 0) {
    summary.recommendations.push('The current context-pack filtered low-value base CodeGraph metadata sections; inspect currentContextSourceOrdering.latestBaseSectionFiltering before treating base Blast radius or Relationships noise as an overlay source-ordering failure.');
  } else if (summary.contextSourceOrdering.baseSectionFilteredLines > 0) {
    summary.recommendations.push('Historical context-pack base metadata filtering was recorded; inspect contextSourceOrdering.latestBaseSectionFiltering to see which base Blast radius, Relationships, or Related Symbols lines were suppressed.');
  }
  if (summary.currentContextSourceOrdering.sourceSelectionEvents > 0) {
    summary.recommendations.push('The current context-pack recorded source selection diagnostics; inspect currentContextSourceOrdering.latestSourceSelection to see visible files, filtered files, overlay candidates, and why source budget entries were kept or dropped.');
  } else if (summary.contextSourceOrdering.sourceSelectionEvents > 0) {
    summary.recommendations.push('Historical context-pack source selection diagnostics were recorded; inspect contextSourceOrdering.latestSourceSelection to see visible files, filtered files, overlay candidates, and why source budget entries were kept or dropped.');
  }

  return summary;
}

try {
  const summary = analyzeLog();
  const wantsText = flags.has('--text') || flags.has('--no-json');
  if (flags.has('--json') && !wantsText) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write([
      `MCP log: ${summary.logPath}`,
      `events=${summary.totalEvents} malformed=${summary.malformedLines}`,
      `observedAt=${summary.observedAt ?? '(none)'}`,
      `logFreshness.latestLogTs=${summary.logFreshness.latestLogTs ?? '(none)'}`,
      `logFreshness.latestLogAgeMs=${summary.logFreshness.latestLogAgeMs ?? '(unknown)'}`,
      `logFreshness.staleAgainstObservedAt=${summary.logFreshness.staleAgainstObservedAt}`,
      `logFreshness.hasCurrentWrapperEvidence=${summary.logFreshness.hasCurrentWrapperEvidence}`,
      `observedDirectMcpError=${summary.observedDirectMcpError ?? '(none)'}`,
      `observedDirectMcpFailureClass=${summary.observedDirectMcpFailureClass ?? '(none)'}`,
      `effectiveTransportHealthy=${summary.effectiveTransportHealthy} transportHealthScope=${summary.transportHealthScope} effectiveCriticalTransportFailures=${summary.effectiveCriticalTransportFailures}`,
      `diagnosticTriage.status=${summary.diagnosticTriage?.status ?? '(unknown)'}`,
      `diagnosticTriage.failureBoundary=${summary.diagnosticTriage?.failureBoundary ?? '(unknown)'}`,
      `diagnosticTriage.adapterFailureLikely=${summary.diagnosticTriage?.adapterFailureLikely ?? '(unknown)'}`,
      `diagnosticTriage.directMcpTrust=${summary.diagnosticTriage?.directMcpTrust ?? '(unknown)'}`,
      `diagnosticTriage.conclusionConfidence=${summary.diagnosticTriage?.conclusionConfidence ?? '(unknown)'}`,
      `diagnosticTriage.failureClasses=${JSON.stringify(summary.diagnosticTriage?.failureClasses ?? [])}`,
      `diagnosticTriage.doNotMisdiagnoseAs=${JSON.stringify(summary.diagnosticTriage?.doNotMisdiagnoseAs ?? [])}`,
      `diagnosticTriage.primaryEvidence=${JSON.stringify(summary.diagnosticTriage?.primaryEvidence ?? {})}`,
      `diagnosticTriage.fallback=${summary.diagnosticTriage?.fallback ?? '(none)'}`,
      `diagnosticTriage.decisionContract=${JSON.stringify(summary.diagnosticTriage?.decisionContract ?? {})}`,
      `diagnosticTriage.evidenceGaps=${JSON.stringify(summary.diagnosticTriage?.evidenceGaps ?? [])}`,
      `diagnosticTriage.requiredEvidenceBeforeConclusion=${JSON.stringify(summary.diagnosticTriage?.requiredEvidenceBeforeConclusion ?? [])}`,
      `diagnosticTriage.investigationChecklist=${JSON.stringify(summary.diagnosticTriage?.investigationChecklist ?? [])}`,
      `diagnosticTriage.misdiagnosisGuards=${JSON.stringify(summary.diagnosticTriage?.misdiagnosisGuards ?? [])}`,
      `diagnosticTriage.nextAction=${summary.diagnosticTriage?.nextAction ?? '(none)'}`,
      `rootCauseSummary.status=${summary.rootCauseSummary?.status ?? '(unknown)'}`,
      `rootCauseSummary.failureBoundary=${summary.rootCauseSummary?.failureBoundary ?? '(unknown)'}`,
      `rootCauseSummary.adapterFailureLikely=${summary.rootCauseSummary?.adapterFailureLikely ?? '(unknown)'}`,
      `rootCauseSummary.failureClasses=${JSON.stringify(summary.rootCauseSummary?.failureClasses ?? [])}`,
      `rootCauseSummary.directMcpTrust=${summary.rootCauseSummary?.directMcpTrust ?? '(unknown)'}`,
      `rootCauseSummary.fallback=${summary.rootCauseSummary?.fallback ?? '(none)'}`,
      `rootCauseSummary.recovery=${JSON.stringify(summary.rootCauseSummary?.recovery ?? [])}`,
      `transportHealthy=${summary.transportHealthy} criticalTransportFailures=${summary.criticalTransportFailures}`,
      `currentTransportHealthy=${summary.currentTransportHealthy} currentCriticalTransportFailures=${summary.currentCriticalTransportFailures}`,
      `childExit.total=${summary.childExit.total} childExit.withActiveRequests=${summary.childExit.withActiveRequests}`,
      `childSpawnErrors=${summary.childSpawnErrors.count}`,
      `childRestartBackoff=${summary.childRestartBackoff.count}`,
      `currentChildRestartBackoff=${summary.currentChildRestartBackoff.count}`,
      `baseCodegraphUnavailable=${summary.baseCodegraphUnavailable.count}`,
      `currentBaseCodegraphUnavailable=${summary.currentBaseCodegraphUnavailable.count}`,
      `wrapperRuntimeDiagnostics.count=${summary.wrapperRuntimeDiagnostics.count}`,
      `wrapperRuntimeDiagnostics.fatal=${summary.wrapperRuntimeDiagnostics.fatal}`,
      `wrapperRuntimeDiagnostics.nonFatal=${summary.wrapperRuntimeDiagnostics.nonFatal}`,
      `wrapperRuntimeDiagnostics.byKind=${JSON.stringify(summary.wrapperRuntimeDiagnostics.byKind)}`,
      `wrapperRuntimeDiagnostics.latestFatal=${JSON.stringify(summary.wrapperRuntimeDiagnostics.latestFatal)}`,
      `wrapperRuntimeDiagnostics.latestNonFatal=${JSON.stringify(summary.wrapperRuntimeDiagnostics.latestNonFatal)}`,
      `currentWrapperRuntimeDiagnostics.count=${summary.currentWrapperRuntimeDiagnostics.count}`,
      `currentWrapperRuntimeDiagnostics.fatal=${summary.currentWrapperRuntimeDiagnostics.fatal}`,
      `currentWrapperRuntimeDiagnostics.nonFatal=${summary.currentWrapperRuntimeDiagnostics.nonFatal}`,
      `currentWrapperRuntimeDiagnostics.latestFatal=${JSON.stringify(summary.currentWrapperRuntimeDiagnostics.latestFatal)}`,
      `currentWrapperRuntimeDiagnostics.latestNonFatal=${JSON.stringify(summary.currentWrapperRuntimeDiagnostics.latestNonFatal)}`,
      `codegraphAutoSyncDisabled=${summary.codegraphAutoSyncDisabled.count}`,
      `currentCodegraphAutoSyncDisabled=${summary.currentCodegraphAutoSyncDisabled.count}`,
      `activeCodegraphAutoSyncDisabled=${summary.activeCodegraphAutoSyncDisabled.count}`,
      `wrapperExit.expectedHostStdinClosed=${summary.wrapperExit.expectedHostStdinClosed}`,
      `wrapperExit.expectedHostStdoutClosed=${summary.wrapperExit.expectedHostStdoutClosed}`,
      `wrapperExit.expectedHostStderrClosed=${summary.wrapperExit.expectedHostStderrClosed}`,
      `staleWrapper.detected=${summary.staleWrapper.detected}`,
      `staleWrapper.recycleSkipped=${summary.staleWrapper.recycleSkipped}`,
      `staleWrapper.recycleRequested=${summary.staleWrapper.recycleRequested}`,
      `staleWrapper.shutdown=${summary.staleWrapper.shutdown}`,
      `currentStaleWrapper.recycleSkipped=${summary.currentStaleWrapper.recycleSkipped}`,
      `currentStaleWrapper.recycleRequested=${summary.currentStaleWrapper.recycleRequested}`,
      `currentStaleWrapper.shutdown=${summary.currentStaleWrapper.shutdown}`,
      `overlayTimeouts=${summary.overlayTimeouts.count}`,
      `wrapperStarts.total=${summary.wrapperStarts.total}`,
      `activeWrappers.distinctCodegraphTargets=${summary.activeWrappers.distinctCodegraphTargets}`,
      `activeWrappers.codegraphTargets=${JSON.stringify(summary.activeWrappers.codegraphTargets)}`,
      `activeWrappers.contextPackTimeoutMs=${JSON.stringify(summary.activeWrappers.contextPackTimeoutMs)}`,
      `activeWrappers.staleWrapperAutoRecycle=${JSON.stringify(summary.activeWrappers.staleWrapperAutoRecycle)}`,
      `currentWrapper.scriptSha256=${summary.currentWrapper?.scriptSha256 ?? '(none)'}`,
      `currentWrapper.diskScriptSha256=${summary.currentWrapper?.diskScriptSha256 ?? '(none)'}`,
      `currentWrapper.matchesDisk=${summary.currentWrapper?.matchesDisk ?? '(unknown)'}`,
      `currentWrapper.codegraphTarget=${summary.currentWrapper?.codegraphTarget ?? '(none)'}`,
      `currentDiskWrapper.scriptSha256=${summary.currentDiskWrapper?.scriptSha256 ?? '(none)'}`,
      `currentDiskWrapper.latestRequestKind=${summary.currentDiskWrapper?.latestRequestKind ?? '(none)'}`,
      `currentDiskWrapper.codegraphTarget=${summary.currentDiskWrapper?.codegraphTarget ?? '(none)'}`,
      `currentConfiguredWrapper.runId=${summary.currentConfiguredWrapper?.runId ?? '(none)'}`,
      `currentConfiguredWrapper.codegraphTarget=${summary.currentConfiguredWrapper?.codegraphTarget ?? '(none)'}`,
      `currentContextWrapper.scriptSha256=${summary.currentContextWrapper?.scriptSha256 ?? '(none)'}`,
      `currentContextWrapper.matchesDisk=${summary.currentContextWrapper?.matchesDisk ?? '(unknown)'}`,
      `currentContextWrapper.supersededByFreshWrapper=${summary.currentContextWrapper?.supersededByFreshWrapper ?? false}`,
      `currentContextWrapper.codegraphTarget=${summary.currentContextWrapper?.codegraphTarget ?? '(none)'}`,
      `codexMcpConfig.exists=${summary.codexMcpConfig?.exists ?? false}`,
      `codexMcpConfig.mismatch=${summary.codexMcpConfig?.mismatch ?? false}`,
      `codexMcpConfig.expectedCodegraphTarget=${summary.codexMcpConfig?.expectedCodegraphTarget ?? '(none)'}`,
      `codexMcpConfig.currentWrapperTarget.actual=${summary.codexMcpConfig?.currentWrapperTarget?.actual ?? '(none)'}`,
      `codexMcpConfig.currentWrapperTarget.matches=${summary.codexMcpConfig?.currentWrapperTarget?.matches ?? '(unknown)'}`,
      `codexMcpConfig.currentWrapperEnv.matches=${summary.codexMcpConfig?.currentWrapperEnv?.matches ?? '(unknown)'}`,
      `codexMcpConfig.currentWrapperEnv.mismatchedKeys=${JSON.stringify(summary.codexMcpConfig?.currentWrapperEnv?.mismatchedKeys ?? [])}`,
      `codexMcpConfig.hostConfigAlignmentOverrides=${JSON.stringify(summary.codexMcpConfig?.hostConfigAlignmentOverrides ?? [])}`,
      `currentDiskContextWrapper.scriptSha256=${summary.currentDiskContextWrapper?.scriptSha256 ?? '(none)'}`,
      `currentDiskContextWrapper.latestRequestKind=${summary.currentDiskContextWrapper?.latestRequestKind ?? '(none)'}`,
      `currentDiskContextWrapper.codegraphTarget=${summary.currentDiskContextWrapper?.codegraphTarget ?? '(none)'}`,
      `currentConfiguredContextWrapper.runId=${summary.currentConfiguredContextWrapper?.runId ?? '(none)'}`,
      `currentConfiguredContextWrapper.codegraphTarget=${summary.currentConfiguredContextWrapper?.codegraphTarget ?? '(none)'}`,
      `contextSourceOrdering.missingDiagnostics=${summary.contextSourceOrdering.missingDiagnostics}`,
      `contextSourceOrdering.duplicateRelationshipsSections=${summary.contextSourceOrdering.duplicateRelationshipsSections}`,
      `contextSourceOrdering.duplicateRelatedSymbolsSections=${summary.contextSourceOrdering.duplicateRelatedSymbolsSections}`,
      `contextSourceOrdering.benignTopRankedMissing=${summary.contextSourceOrdering.benignTopRankedMissing}`,
      `contextSourceOrdering.topRankedNotFirst=${summary.contextSourceOrdering.topRankedNotFirst}`,
      `contextSourceOrdering.lowValueSourcePollution=${summary.contextSourceOrdering.lowValueSourcePollution}`,
      `contextSourceOrdering.baseSectionFilteredLines=${summary.contextSourceOrdering.baseSectionFilteredLines}`,
      `currentContextSourceOrdering.missingDiagnostics=${summary.currentContextSourceOrdering.missingDiagnostics}`,
      `currentContextSourceOrdering.duplicateRelationshipsSections=${summary.currentContextSourceOrdering.duplicateRelationshipsSections}`,
      `currentContextSourceOrdering.duplicateRelatedSymbolsSections=${summary.currentContextSourceOrdering.duplicateRelatedSymbolsSections}`,
      `currentContextSourceOrdering.benignTopRankedMissing=${summary.currentContextSourceOrdering.benignTopRankedMissing}`,
      `currentContextSourceOrdering.topRankedNotFirst=${summary.currentContextSourceOrdering.topRankedNotFirst}`,
      `currentContextSourceOrdering.lowValueSourcePollution=${summary.currentContextSourceOrdering.lowValueSourcePollution}`,
      `currentContextSourceOrdering.baseSectionFilteredLines=${summary.currentContextSourceOrdering.baseSectionFilteredLines}`,
      `currentDiskContextSourceOrdering.missingDiagnostics=${summary.currentDiskContextSourceOrdering.missingDiagnostics}`,
      `currentDiskContextSourceOrdering.duplicateRelationshipsSections=${summary.currentDiskContextSourceOrdering.duplicateRelationshipsSections}`,
      `currentDiskContextSourceOrdering.duplicateRelatedSymbolsSections=${summary.currentDiskContextSourceOrdering.duplicateRelatedSymbolsSections}`,
      `currentDiskContextSourceOrdering.benignTopRankedMissing=${summary.currentDiskContextSourceOrdering.benignTopRankedMissing}`,
      `currentDiskContextSourceOrdering.topRankedNotFirst=${summary.currentDiskContextSourceOrdering.topRankedNotFirst}`,
      `currentDiskContextSourceOrdering.lowValueSourcePollution=${summary.currentDiskContextSourceOrdering.lowValueSourcePollution}`,
      `currentDiskContextSourceOrdering.baseSectionFilteredLines=${summary.currentDiskContextSourceOrdering.baseSectionFilteredLines}`,
      '',
    ].join('\n'));
  }
  const failOnCritical = summary.currentWrapper
    ? !summary.currentTransportHealthy
    : !summary.transportHealthy;
  const failOnCurrentSourceOrdering = flags.has('--fail-on-current-source-ordering')
    && hasCurrentContextSourceOrderingGuardFailure(summary);
  const failOnStaleCurrentWrapper = flags.has('--fail-on-stale-current-wrapper')
    && hasStaleCurrentWrapperGuardFailure(summary);
  const failOnActiveStaleWrappers = flags.has('--fail-on-active-stale-wrappers')
    && hasActiveStaleWrappersGuardFailure(summary);
  const failOnHostConfigMismatch = flags.has('--fail-on-host-config-mismatch')
    && summary.codexMcpConfig?.mismatch === true;
  const failOnUntrustedDirectMcp = flags.has('--fail-on-untrusted-direct-mcp')
    && hasUntrustedDirectMcpGuardFailure(summary);
  const failOnCurrentAutoSyncDisabled = flags.has('--fail-on-current-autosync-disabled')
    && summary.currentCodegraphAutoSyncDisabled.count > 0;
  process.exit(
    (flags.has('--fail-on-critical') && failOnCritical)
    || failOnCurrentSourceOrdering
    || failOnStaleCurrentWrapper
    || failOnActiveStaleWrappers
    || failOnHostConfigMismatch
    || failOnUntrustedDirectMcp
    || failOnCurrentAutoSyncDisabled
      ? 1
      : 0,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
