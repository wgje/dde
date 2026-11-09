#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  CODEGRAPH_DEDUP_MAINTENANCE_FOCUSED_QUERY,
} = require('./codegraph-nanoflow-dedup-query.cjs');
const {
  classifySpecializedMaintenanceQuery,
} = require('./codegraph-nanoflow-specialized-query.cjs');
const {
  buildNanoFlowContextOutcomeV1,
  isNanoFlowContextOutcomeError,
} = require('./lib/codegraph-context-outcome.cjs');

const WRAPPER_VERSION = 'nanoflow-codegraph-wrapper-2026-07-14.1';
const CODEGRAPH_DAEMON_IDLE_TIMEOUT_DEFAULT = '300000';
const CODEGRAPH_DAEMON_MAX_IDLE_DEFAULT = '1800000';
const DIAGNOSTIC_LOG_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
const DIAGNOSTIC_LOG_LOCK_WAIT_MS = 2_000;
const DIAGNOSTIC_LOG_LOCK_STALE_MS = 10_000;
const DIAGNOSTIC_QUERY_PREVIEW_CHARS = 512;
const DIAGNOSTIC_QUERY_TAIL_CHARS = 96;
const WRAPPER_OUTPUT_MODES = {
  overlayTool: 'markdown',
  contextOverlayQuery: 'json',
  contextOverlayQueryCompact: 'context-json',
  nativeJson: 'native-json',
  nativeMarkdown: 'native-markdown',
  contextPack: 'markdown',
};
const OVERLAY_STALE_SKIP_REFRESH = 'overlay-stale-skip-refresh';
const DIAGNOSTIC_SCHEMA_VERSION = 2;
const ENV_OBSERVATION_SCHEMA_VERSION = 1;
const CODEGRAPH_CHILD_ENV_KEYS = [
  'CODEGRAPH_NO_DAEMON',
  'CODEGRAPH_NO_WATCH',
  'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
  'CODEGRAPH_DAEMON_MAX_IDLE_MS',
  'NANOFLOW_CODEGRAPH_ALLOW_DAEMON',
];
const WRAPPER_CODEX_CONFIG_ENV_KEYS = [
  'CODEGRAPH_NO_DAEMON',
  'CODEGRAPH_NO_WATCH',
  'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
  'CODEGRAPH_DAEMON_MAX_IDLE_MS',
  'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
  'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
  'npm_config_cache',
];
const WRAPPER_START_OBSERVED_ENV_KEYS = [...new Set([
  ...CODEGRAPH_CHILD_ENV_KEYS,
  'CODEGRAPH_MCP_DEBUG',
  'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS',
  'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_MAX_BUFFER_BYTES',
  'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
  'NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP',
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_AFTER',
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_INITIAL_MS',
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_MAX_MS',
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_WINDOW_MS',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS',
  'NANOFLOW_CODEGRAPH_STALE_WRAPPER_RECYCLE_GRACE_MS',
  'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
  'NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE',
  'npm_config_cache',
])];
const WRAPPER_CODEX_CONFIG_NEXT_EVIDENCE = [
  'wrapper.start.codexConfigAlignment',
  'wrapper.config.mismatch',
  'wrapper.config.override',
  'codegraph:adapter:doctor -- --explain',
  'activeWrappers',
  'currentWrapper',
  'currentContextWrapper',
  'liveProcessMismatches',
];
const FRESH_ADAPTER_FALLBACK_COMMAND = 'npm run codegraph:adapter:context -- --query "<query>" --json';
const ADAPTER_DOCTOR_COMMAND = 'npm run codegraph:adapter:doctor -- --explain';

const rawArgs = process.argv.slice(2);
const codegraphTarget = rawArgs.shift();
const WRAPPER_SCRIPT_PATH = __filename;
const WRAPPER_STARTUP_SCRIPT_SHA256 = hashFileSha256(WRAPPER_SCRIPT_PATH);

if (!codegraphTarget) {
  process.stderr.write('[codegraph-nanoflow-mcp-stdio] Missing codegraph package spec or local dist/bin/codegraph.js path.\n');
  process.exit(2);
}

if (rawArgs.length === 0) {
  process.stderr.write('[codegraph-nanoflow-mcp-stdio] Missing codegraph command arguments.\n');
  process.exit(2);
}

const codegraphArgs = normalizeCodegraphArgs(rawArgs);
const projectRoot = resolveProjectRoot(codegraphArgs);
const startupChildEnvNormalization = normalizeCodegraphChildEnv(process.env);
const diagnostics = createDiagnostics(projectRoot);
const OVERLAY_QUERY_TIMEOUT_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS',
  30_000,
);
const OVERLAY_QUERY_MAX_BUFFER_BYTES = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_MAX_BUFFER_BYTES',
  16 * 1024 * 1024,
);
const OVERLAY_QUERY_KILL_GRACE_MS = 1000;
const CONTEXT_PACK_TIMEOUT_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
  30_000,
);
const CONTEXT_PACK_TIMEOUT_OVERLAY_GRACE_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_CONTEXT_PACK_OVERLAY_GRACE_MS',
  750,
);
const SUPPRESSED_CHILD_RESPONSE_ID_TTL_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_SUPPRESSED_CHILD_RESPONSE_ID_TTL_MS',
  30_000,
);
const CONTEXT_PACK_OVERLAY_SOURCE_BLOCK_LIMIT = 4;
const CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT = CONTEXT_PACK_OVERLAY_SOURCE_BLOCK_LIMIT;
const CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT = 8;
const CONTEXT_PACK_RELATED_SYMBOL_FILE_LIMIT = 8;
const CONTEXT_PACK_RELATED_SYMBOLS_PER_FILE_LIMIT = 12;
const CONTEXT_PACK_SOURCE_BLOCK_NODE_LIMIT = 8;
const CONTEXT_PACK_FOCUSED_SOURCE_VISIBLE_LINE_LIMIT = 40;
const CONTEXT_PACK_FOCUSED_SOURCE_VISIBLE_CHAR_LIMIT = 12_000;
const RECENT_DIAGNOSTIC_ENTRY_LIMIT = 12;
const CONTEXT_PACK_SOURCE_EXTENSION_PATTERN = '(?:[cm]?js\\.map|css\\.map|[cm]?[tj]sx?|kt|kts|xml|json|mdx?|html|css|scss|sass|less|sql)';
const CONTEXT_PACK_SOURCE_EXTENSION_RE = new RegExp(`\\.${CONTEXT_PACK_SOURCE_EXTENSION_PATTERN}$`, 'i');
const CONTEXT_PACK_SOURCE_EXTENSION_WITH_LINE_RE = new RegExp(
  `(\\.${CONTEXT_PACK_SOURCE_EXTENSION_PATTERN})(?::\\d+(?::\\d+)?)?$`,
  'i',
);
const CONTEXT_PACK_SOURCE_EXTENSION_IN_TEXT_RE = new RegExp(
  `\\.${CONTEXT_PACK_SOURCE_EXTENSION_PATTERN}(?::\\d+(?::\\d+)?)?(?![a-z0-9_.-])`,
  'i',
);
const CONTEXT_PACK_GENERATED_FILE_PATTERNS = [
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
const CONTEXT_PACK_SOURCE_SECTION_HEADING_RE = /(^|\n)(?:### (?:Source Code|Code)\b|\*\*Source Code\*\*)/;
const CONTEXT_PACK_SOURCE_BLOCK_HEADING_RE = /^(?:####\s+(.+)|\*\*`([^`]+)`\*\*(?:\s+[—-]\s*(.*))?)$/gm;
const CONTEXT_PACK_FOLLOWING_SECTION_RE = /\n(?:### (?!(?:Source Code|Code)\b)|\*\*(?!`|Source Code\*\*)[^*\n]+\*\*)/;
const CONTEXT_PACK_BASE_SOURCE_FILTER_RELATIONS = new Set([
  'android-resource-file',
  'android-resource-reference',
  'android-widget-provider',
  'style-url',
  'template-url',
]);
const CONTEXT_PACK_OVERLAY_QUERY_NOISE_SEGMENTS = new Set([
  'codegraph',
  'context',
  'pack',
  'quality',
  'source',
  'ordering',
  'order',
  'ordered',
  'low',
  'value',
  'related',
  'symbols',
  'symbol',
  'nanoflow',
  'overlay',
]);
const CONTEXT_PACK_OVERLAY_TOOLING_QUERY_NOISE_SEGMENTS = new Set([
  'assert',
  'assertion',
  'assertions',
  'content',
  'diagnostic',
  'diagnostics',
  'error',
  'errors',
  'expect',
  'expected',
  'host',
  'hosts',
  'json',
  'jsonrpc',
  'markdown',
  'native',
  'output',
  'outputs',
  'result',
  'results',
  'restart',
  'restarted',
  'restarting',
  'restarts',
  'runtime',
  'runtimes',
  'token',
  'tokens',
  'truncation',
  'truncated',
  'timeout',
  'timeouts',
  'timed',
  'waiting',
  'wait',
  'hung',
  'hang',
  'stalled',
  'polluted',
  'polluting',
  'pollution',
  'noise',
  'noisy',
  'spec',
  'specs',
  'test',
  'tests',
  'testing',
  'tooling',
  'query',
  'queries',
  'response',
  'responses',
  'warning',
  'warnings',
]);
const CONTEXT_PACK_TOOLING_POLLUTION_SOURCE_SEGMENTS = new Set([
  'android',
  'bootstrap',
  'logger',
  'loggerservice',
  'main',
  'nanoflowwidgettelemetry',
  'telemetry',
]);
const CONTEXT_PACK_DEDUP_MAINTENANCE_INTENT_SEGMENTS = new Set([
  'audit',
  'audits',
  'boundary',
  'boundaries',
  'contract',
  'contracts',
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
]);
const CONTEXT_PACK_DEDUP_MAINTENANCE_STRONG_INTENT_SEGMENTS = new Set([
  'audit',
  'audits',
  'boundary',
  'boundaries',
  'contract',
  'contracts',
  'dedup',
  'dedupe',
  'deduplication',
  'hotspot',
  'hotspots',
  'manifest',
  'upstream',
  'validator',
  'validators',
]);
const CONTEXT_PACK_DEDUP_MAINTENANCE_HELPER_SIGNAL_SEGMENTS = new Set([
  'angular',
  'api',
  'block',
  'budget',
  'classification',
  'classify',
  'code',
  'context',
  'edge',
  'edges',
  'format',
  'formatter',
  'helper',
  'helpers',
  'json',
  'markdown',
  'native',
  'ordering',
  'pack',
  'query',
  'rank',
  'ranking',
  'reached',
  'score',
  'scoring',
  'section',
  'selection',
  'select',
  'semantic',
  'source',
  'sourceordering',
  'sourceselection',
  'strict',
  'summarize',
]);
const CONTEXT_PACK_DEDUP_MAINTENANCE_HELPER_COMPOUND_SIGNALS = [
  ['select', 'angular', 'semantic', 'api', 'edges'],
  ['strict', 'native', 'code', 'block', 'budget', 'reached'],
  ['summarize', 'context', 'pack', 'source', 'ordering'],
  ['context', 'pack', 'source', 'ordering'],
  ['source', 'ordering'],
  ['sourceordering'],
  ['query', 'scoring'],
  ['native', 'markdown'],
  ['native', 'json'],
];
const CONTEXT_PACK_OVERLAY_TOOLING_INTENT_SEGMENTS = new Set([
  'adapter',
  'adapters',
  'codex',
  'doctor',
  'gate',
  'log',
  'logs',
  'mcp',
  'script',
  'scripts',
  'smoke',
  'stdio',
  'transport',
  'wrapper',
]);
const CONTEXT_PACK_TOOLING_LIFECYCLE_INTENT_SEGMENTS = new Set([
  'session',
  'sessions',
  'stdio',
  'transport',
  'wrapper',
]);
const CONTEXT_PACK_TOOLING_LIFECYCLE_DIAGNOSTIC_SEGMENTS = new Set([
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
const CONTEXT_PACK_TOOLING_QUALITY_FOCUSED_QUERY = 'codegraph adapter context wrapper log guard sourceOrdering sourceSelection';
const CONTEXT_PACK_TOOLING_RUNTIME_DIAGNOSTICS_FOCUSED_QUERY = [
  'scripts/codegraph-nanoflow-mcp-stdio.cjs',
  'forwardNanoFlowContextPackRequest',
  'handleNanoFlowContextPackEntryError',
  'summarizeChildStderrDiagnostics',
  'child.stdin.write.error',
  'client.stdout.error',
  'requestTrace',
  'diagnostics',
].join(' ');
const CONTEXT_PACK_TOOLING_QUALITY_SEGMENTS = new Set([
  'duplicate',
  'duplicates',
  'section',
  'sections',
  'sourceordering',
  'sourceselection',
  'selection',
]);
const CONTEXT_PACK_LOCALIZED_QUERY_ALIASES = [
  { pattern: /测试|单测|用例/, aliases: ['test'] },
  { pattern: /断言|期望/, aliases: ['assertion', 'expect'] },
  { pattern: /返回/, aliases: ['return'] },
  { pattern: /退出/, aliases: ['exit'] },
  { pattern: /关闭/, aliases: ['closed', 'shutdown'] },
  { pattern: /重启/, aliases: ['restart'] },
  { pattern: /崩溃/, aliases: ['crash'] },
  { pattern: /超时/, aliases: ['timeout'] },
  { pattern: /适配/, aliases: ['adapter', 'adaptation'] },
  { pattern: /问题|错误/, aliases: ['issue'] },
  { pattern: /登记|记录/, aliases: ['registry'] },
  { pattern: /文档/, aliases: ['doc'] },
  { pattern: /质量/, aliases: ['quality'] },
  { pattern: /修复/, aliases: ['fixed'] },
];
const CONTEXT_PACK_ISSUE_REGISTRY_FOCUSED_QUERY = 'docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues';
const CONTEXT_PACK_ISSUE_REGISTRY_ANCHOR_SEGMENTS = new Set([
  'adapter',
  'adaptation',
  'codegraph',
  'nanoflow',
]);
const CONTEXT_PACK_ISSUE_REGISTRY_INTENT_SEGMENTS = new Set([
  'issue',
  'issues',
  'registry',
]);
const CONTEXT_PACK_ISSUE_REGISTRY_STATUS_SEGMENTS = new Set([
  'doc',
  'docs',
  'document',
  'documentation',
  'fixed',
  'gap',
  'gaps',
  'open',
  'opened',
  'quality',
  'remaining',
  'status',
  'statuses',
]);
const REFRESH_ON_STARTUP = process.env.NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP === '1';
const EXPIRED_CONTEXT_PACK_ID_TTL_MS = 5 * 60 * 1000;
const OVERLAY_REFRESH_LOCK_STALE_MS = 5 * 60 * 1000;
const CHILD_RESTART_BACKOFF_AFTER = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_AFTER',
  3,
);
const CHILD_RESTART_BACKOFF_INITIAL_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_INITIAL_MS',
  250,
);
const CHILD_RESTART_BACKOFF_MAX_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_MAX_MS',
  5_000,
);
const CHILD_RESTART_BACKOFF_WINDOW_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_WINDOW_MS',
  10_000,
);
const SHARED_DAEMON_FALLBACK_RECOVERY_ENABLED =
  process.env.NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY !== '0';
const SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS',
  250,
);
const SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS',
  250,
);
const SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS',
  30_000,
);
const STALE_WRAPPER_RECYCLE_GRACE_MS = parsePositiveIntegerEnv(
  'NANOFLOW_CODEGRAPH_STALE_WRAPPER_RECYCLE_GRACE_MS',
  2_000,
);
const STALE_WRAPPER_AUTO_RECYCLE = process.env.NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE === '1';
const CODEX_CONFIG_ALIGNMENT_MODE = process.env.NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE ?? 'strict';
let wrapperConfigAlignmentLoggedSignature = null;
const startupCodexConfigAlignment = inspectCodexMcpConfigAlignmentSafely();

function inspectCodexMcpConfigAlignmentSafely() {
  if (typeof inspectCodexMcpConfigAlignment !== 'function') {
    return {
      status: 'unavailable',
      reason: 'codex-config-alignment-inspector-missing',
      inspectorName: 'inspectCodexMcpConfigAlignment',
    };
  }
  try {
    return inspectCodexMcpConfigAlignment();
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'codex-config-alignment-error',
      error: serializeDiagnosticError(error),
    };
  }
}

diagnostics.log('wrapper.start', {
  pid: process.pid,
  logPath: diagnostics.logPath,
  diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
  wrapperVersion: WRAPPER_VERSION,
  scriptPath: WRAPPER_SCRIPT_PATH,
  scriptSha256: WRAPPER_STARTUP_SCRIPT_SHA256,
  node: process.execPath,
  codegraphTarget,
  codegraphArgs,
  projectRoot,
  cwd: process.cwd(),
  outputModes: WRAPPER_OUTPUT_MODES,
  envObservationSchemaVersion: ENV_OBSERVATION_SCHEMA_VERSION,
  observedEnvKeys: WRAPPER_START_OBSERVED_ENV_KEYS,
  env: pickEnv(process.env, WRAPPER_START_OBSERVED_ENV_KEYS),
  effectiveChildEnv: pickEnv(createCodegraphChildEnv(), CODEGRAPH_CHILD_ENV_KEYS),
  runtimeTopology: summarizeCodegraphRuntimeTopology(createCodegraphChildEnv()),
  overlayQueryTimeoutMs: OVERLAY_QUERY_TIMEOUT_MS,
  overlayQueryMaxBufferBytes: OVERLAY_QUERY_MAX_BUFFER_BYTES,
  contextPackTimeoutMs: CONTEXT_PACK_TIMEOUT_MS,
  refreshOnStartup: REFRESH_ON_STARTUP,
  childRestartBackoff: {
    after: CHILD_RESTART_BACKOFF_AFTER,
    initialMs: CHILD_RESTART_BACKOFF_INITIAL_MS,
    maxMs: CHILD_RESTART_BACKOFF_MAX_MS,
    windowMs: CHILD_RESTART_BACKOFF_WINDOW_MS,
  },
  sharedDaemonFallbackRecovery: {
    enabled: SHARED_DAEMON_FALLBACK_RECOVERY_ENABLED,
    delayMs: SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS,
    deferMs: SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS,
    maxWaitMs: SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS,
  },
  staleWrapperRecycleGraceMs: STALE_WRAPPER_RECYCLE_GRACE_MS,
  staleWrapperAutoRecycle: STALE_WRAPPER_AUTO_RECYCLE,
  codexConfigAlignment: summarizeCodexMcpConfigAlignment(startupCodexConfigAlignment),
});
if (startupChildEnvNormalization.corrections.length > 0) {
  diagnostics.log('wrapper.env.normalized', {
    failureClass: 'stale-host-daemon-lifetime-env',
    corrections: startupChildEnvNormalization.corrections,
    receivedEnv: startupChildEnvNormalization.receivedEnv,
    effectiveChildEnv: pickEnv(createCodegraphChildEnv(), CODEGRAPH_CHILD_ENV_KEYS),
    investigation: {
      failureBoundary: 'codex-mcp-host-env-to-wrapper-child',
      failureClass: 'stale-host-daemon-lifetime-env',
      transportShouldStayAlive: true,
      likelyRootCause: 'The Codex MCP host supplied a non-positive shared-daemon lifetime value from a stale session; the wrapper replaced it with the pinned positive contract before spawning CodeGraph.',
      nextEvidence: [
        'wrapper.start.env',
        'wrapper.env.normalized.corrections',
        'wrapper.start.effectiveChildEnv',
        'child.spawn.env',
        'codegraph:adapter:doctor -- --strict --explain',
      ],
    },
  });
}
logWrapperConfigAlignmentIfNeeded('startup', null, startupCodexConfigAlignment);

if (REFRESH_ON_STARTUP) {
  scheduleNanoFlowOverlayRefresh(projectRoot);
} else {
  diagnostics.log('overlay.refresh.skip', {
    reason: process.env.NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP === '0'
      ? 'disabled-by-env'
      : 'disabled-by-default',
  });
}

let child = null;
const pendingToolsListIds = new Set();
const pendingContextPacks = new Map();
const expiredContextPackIds = new Set();
const expiredContextPackIdTimers = new Map();
const suppressedChildResponseIds = new Set();
const suppressedChildResponseIdTimers = new Map();
let nextInternalRequestId = -1;
let nextOverlayQueryId = 1;
let nextClientRequestId = 1;
const activeClientRequests = new Map();
let activeOverlayRefreshLockPath = null;
let lastInitializeParams = null;
let clientInitialized = false;

const CHILD_TERMINATION_GRACE_MS = 2000;
let childExited = false;
let shuttingDown = false;
let clientStdinShutdownRequested = false;
let childTerminationTimer = null;
let wrapperScriptStaleLogged = false;
let wrapperScriptStaleDetails = null;
let staleWrapperRecycleRequested = false;
let staleWrapperRecycleSkippedLogged = false;
let staleWrapperRecycleTimer = null;
let staleWrapperRecycleRequestedAtMs = 0;
let staleWrapperRecycleReason = null;
let staleWrapperRecycleDeferCount = 0;
let staleWrapperRecycleScheduledDelayMs = 0;

let clientMode = null;
let stdinBuffer = Buffer.alloc(0);
let childStdoutBuffer = Buffer.alloc(0);
const pendingChildLines = [];
const clientOutputQueue = [];
const childInputQueue = [];
let clientStdoutBackpressured = false;
let lastClientOutputFlushAtMs = 0;
let childStdinBackpressured = false;
let wrapperShutdownCause = null;
let childRestartTimer = null;
let childRuntimeTopology = summarizeCodegraphRuntimeTopology(createCodegraphChildEnv());
let sharedDaemonFallbackRecoveryTimer = null;
let sharedDaemonFallbackRecoveryChild = null;
let sharedDaemonFallbackRecoveryRequestedAtMs = 0;
let sharedDaemonFallbackRecoveryDeferCount = 0;
let sharedDaemonFallbackRecoveryTrigger = null;
let sharedDaemonFallbackDetectedAtMs = 0;
const childRestartExitTimestamps = [];
const recentDiagnosticHistory = {
  childStderr: [],
  childStdout: [],
  clientRequests: [],
  clientResponses: [],
};
let fatalShutdownLogged = false;

installProcessFatalDiagnostics();
installProcessStdioDiagnostics();
spawnManagedCodegraph('startup');

process.stdin.on('data', chunk => {
  const modeBefore = clientMode;
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  diagnostics.log('client.stdin.chunk', {
    bytes: Buffer.byteLength(chunk),
    bufferedStdinBytes: stdinBuffer.length,
    modeBefore,
    runtime: summarizeRuntimeState(),
  });
  drainClientInput();
});

process.stdin.on('end', () => {
  diagnostics.log('client.stdin.end', { runtime: summarizeRuntimeState() });
  requestClientStdinShutdown('end');
});

process.stdin.on('close', () => {
  diagnostics.log('client.stdin.close', { runtime: summarizeRuntimeState() });
  requestClientStdinShutdown('close');
});

process.on('exit', () => {
  releaseOverlayRefreshLock(activeOverlayRefreshLockPath);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownAndExit();
  });
}

function spawnManagedCodegraph(reason) {
  const previousPid = child?.pid ?? null;
  const previousRuntimeTopology = childRuntimeTopology;
  clearChildRestartTimer();
  clearSharedDaemonFallbackRecoveryTimer();
  const retainedChildInputQueue = extractRestartChildInputQueue(reason);
  childExited = false;
  childStdoutBuffer = Buffer.alloc(0);
  childStdinBackpressured = false;
  clearChildTerminationTimer();
  const childStartedAtMs = Date.now();
  child = spawnCodegraph(codegraphTarget, codegraphArgs);
  child.__nanoflowStartedAtMs = childStartedAtMs;
  childRuntimeTopology = summarizeCodegraphRuntimeTopology(createCodegraphChildEnv());
  sharedDaemonFallbackRecoveryChild = null;
  sharedDaemonFallbackRecoveryRequestedAtMs = 0;
  sharedDaemonFallbackRecoveryDeferCount = 0;
  sharedDaemonFallbackRecoveryTrigger = null;
  sharedDaemonFallbackDetectedAtMs = 0;
  attachChildEventHandlers(child);
  diagnostics.log(reason === 'startup' ? 'child.managed.start' : 'child.restart', {
    reason,
    previousPid,
    pid: child.pid,
    childStartedAtMs,
    runtimeTopology: childRuntimeTopology,
    runtime: summarizeRuntimeState(),
  });
  if (reason !== 'startup' && isInProcessFallbackTopology(previousRuntimeTopology)) {
    diagnostics.log('child.runtime-topology.reset', {
      reason,
      previousPid,
      pid: child.pid,
      from: previousRuntimeTopology,
      to: childRuntimeTopology,
      failureClass: 'shared-daemon-fallback-recovered-by-child-restart',
      runtime: summarizeRuntimeState(),
    });
  }
  replayCodegraphSessionToChild(reason);
  restoreRestartChildInputQueue(retainedChildInputQueue, reason);
  flushChildInputQueue();
}

function extractRestartChildInputQueue(reason) {
  if (childInputQueue.length === 0) {
    return [];
  }

  const retained = [];
  const discardedReasons = [];
  for (const entry of childInputQueue) {
    if (String(entry.reason ?? '').startsWith('replay-')) {
      discardedReasons.push(entry.reason);
    } else {
      retained.push(entry);
    }
  }

  if (discardedReasons.length === 0) {
    childInputQueue.length = 0;
    diagnostics.log('child.stdin.queue.defer-for-session-replay', {
      reason,
      retainedCount: retained.length,
      retainedReasons: retained.map(entry => entry.reason).slice(0, 8),
      runtime: summarizeRuntimeState(),
    });
    return retained;
  }

  childInputQueue.length = 0;
  diagnostics.log('child.stdin.queue.discard-stale-replay', {
    reason,
    discardedCount: discardedReasons.length,
    discardedReasons,
    retainedCount: retained.length,
    runtime: summarizeRuntimeState(),
  });
  return retained;
}

function restoreRestartChildInputQueue(retained, reason) {
  if (!Array.isArray(retained) || retained.length === 0) {
    return;
  }

  childInputQueue.push(...retained);
  diagnostics.log('child.stdin.queue.restore-after-session-replay', {
    reason,
    restoredCount: retained.length,
    restoredReasons: retained.map(entry => entry.reason).slice(0, 8),
    runtime: summarizeRuntimeState(),
  });
}

function attachChildEventHandlers(managedChild) {
  managedChild.stderr.on('error', error => {
    handleChildOutputStreamError(managedChild, 'stderr', error);
  });

  managedChild.stderr.on('data', chunk => {
    const text = chunk.toString('utf8');
    observeChildRuntimeTopology(managedChild, text);
    const stderrDiagnostics = summarizeChildStderrDiagnostics(text);
    const runtime = summarizeRuntimeState();
    rememberDiagnosticHistory('childStderr', {
      pid: managedChild.pid,
      bytes: Buffer.byteLength(chunk),
      lineCount: text.split(/\r?\n/).filter(Boolean).length,
      textTail: text.trimEnd().slice(-2000),
      failureClass: stderrDiagnostics.failureClass,
    });
    diagnostics.log('child.stderr', {
      pid: managedChild.pid,
      bytes: Buffer.byteLength(chunk),
      lineCount: text.split(/\r?\n/).filter(Boolean).length,
      text: text.trimEnd(),
      ...stderrDiagnostics,
      rootCauseSnapshot: stderrDiagnostics.failureClass
        ? buildRootCauseSnapshot(runtime)
        : undefined,
      runtime,
    });
    writeToWrapperStderr(chunk, {
      event: 'client.stderr.forward.error',
      failureClass: 'client-stderr-forward-error',
      operation: 'forward-child-stderr',
      childPid: managedChild.pid,
    });
  });

  managedChild.stdout.on('error', error => {
    handleChildOutputStreamError(managedChild, 'stdout', error);
  });

  managedChild.stdout.on('data', chunk => {
    if (managedChild !== child) {
      rememberDiagnosticHistory('childStdout', {
        pid: managedChild.pid,
        stale: true,
        bytes: Buffer.byteLength(chunk),
        preview: Buffer.from(chunk).toString('utf8').slice(0, 500),
      });
      diagnostics.log('child.stdout.stale', {
        pid: managedChild.pid,
        bytes: Buffer.byteLength(chunk),
        runtime: summarizeRuntimeState(),
      });
      return;
    }
    childStdoutBuffer = Buffer.concat([
      childStdoutBuffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
    ]);
    rememberDiagnosticHistory('childStdout', {
      pid: managedChild.pid,
      stale: false,
      bytes: Buffer.byteLength(chunk),
      bufferedChildStdoutBytes: childStdoutBuffer.length,
      preview: Buffer.from(chunk).toString('utf8').slice(0, 500),
    });
    diagnostics.log('child.stdout.chunk', {
      pid: managedChild.pid,
      bytes: Buffer.byteLength(chunk),
      bufferedChildStdoutBytes: childStdoutBuffer.length,
      runtime: summarizeRuntimeState(),
    });
    drainChildOutput();
  });

  managedChild.on('error', error => {
    const runtime = summarizeRuntimeState();
    const failureClass = 'child-process-error';
    const diagnosticError = serializeDiagnosticError(error);
    const willExitWrapper = managedChild === child && !shuttingDown;
    diagnostics.log('child.error', {
      pid: managedChild.pid,
      failureClass,
      currentChild: managedChild === child,
      message: error.message,
      code: error.code,
      error: diagnosticError,
      shuttingDown,
      investigation: buildChildProcessErrorInvestigation(failureClass, !willExitWrapper),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    if (managedChild !== child) {
      return;
    }
    if (shuttingDown) {
      return;
    }
    diagnostics.log('wrapper.exit', {
      code: 1,
      reason: 'child-error',
      ...buildWrapperShutdownCause('child-process-error', runtime),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] Failed to start codegraph: ${error.message}\n`, {
      operation: 'report-child-process-error',
      childPid: managedChild.pid,
    });
    process.exit(1);
  });

  managedChild.on('exit', (code, signal) => {
    const currentChild = managedChild === child;
    const runtime = summarizeRuntimeState();
    const childExitDiagnostics = buildChildExitDiagnostics(code, signal, managedChild);
    diagnostics.log('child.exit', {
      pid: managedChild.pid,
      currentChild,
      code,
      signal,
      ...childExitDiagnostics,
      shuttingDown,
      ...runtime,
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    if (!currentChild) {
      diagnostics.log('child.exit.stale', {
        pid: managedChild.pid,
        code,
        signal,
        ...childExitDiagnostics,
      });
      return;
    }

    childExited = true;
    clearSharedDaemonFallbackRecoveryTimer();
    clearChildTerminationTimer();
    if (signal) {
      writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] Codegraph exited from signal ${signal}.\n`, {
        operation: 'report-child-signal-exit',
        childPid: managedChild.pid,
      });
    }
    if (shuttingDown) {
      const shutdownRuntime = summarizeRuntimeState();
      diagnostics.log('wrapper.exit.await-child-close', {
        code,
        signal,
        childPid: managedChild.pid,
        ...(wrapperShutdownCause ?? buildWrapperShutdownCause('child-exit', shutdownRuntime)),
        rootCauseSnapshot: buildRootCauseSnapshot(shutdownRuntime),
        runtime: shutdownRuntime,
      });
      return;
    }

    const restartRuntime = summarizeRuntimeState();
    diagnostics.log('child.restart.request', {
      reason: 'unexpected-exit',
      code,
      signal,
      ...childExitDiagnostics,
      previousPid: managedChild.pid,
      ...restartRuntime,
      rootCauseSnapshot: buildRootCauseSnapshot(restartRuntime),
      runtime: restartRuntime,
    });
    failBaseCodegraphPendingRequests('base-codegraph-child-exit', managedChild.pid, code, signal);
    failPendingContextPacksForBaseChildExit('base-codegraph-child-exit', managedChild.pid, code, signal);
    clearAllSuppressedChildResponseIds('child-exit-before-suppressed-response', managedChild.pid);
    clearAllExpiredContextPackIds('child-exit-before-expired-context-response', managedChild.pid);
    scheduleManagedCodegraphRestart(managedChild, code, signal, restartRuntime);
  });

  managedChild.on('close', (code, signal) => {
    const runtime = summarizeRuntimeStateSafely();
    const childCloseDiagnostics = buildChildExitDiagnostics(code, signal, managedChild);
    diagnostics.log('child.close', {
      pid: managedChild.pid,
      code,
      signal,
      currentChild: managedChild === child,
      shuttingDown,
      ...childCloseDiagnostics,
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    if (managedChild === child && shuttingDown) {
      clearChildTerminationTimer();
      const shutdownRuntime = summarizeRuntimeStateSafely();
      diagnostics.log('wrapper.exit', {
        code: 0,
        reason: 'child-exit',
        ...(wrapperShutdownCause ?? buildWrapperShutdownCause('child-exit', shutdownRuntime)),
        rootCauseSnapshot: buildRootCauseSnapshot(shutdownRuntime),
        runtime: shutdownRuntime,
      });
      process.exit(0);
    }
  });

  managedChild.stdin.on('error', error => {
    const failureClass = 'child-stdin-stream-error';
    const runtime = summarizeRuntimeStateSafely();
    const diagnosticError = serializeDiagnosticError(error);
    const benignStreamClose = error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED';
    diagnostics.log('child.stdin.error', {
      pid: managedChild.pid,
      stream: 'stdin',
      failureClass,
      currentChild: managedChild === child,
      message: error.message,
      code: error.code,
      error: diagnosticError,
      benignStreamClose,
      investigation: buildChildStdinErrorInvestigation(failureClass, true),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    if (benignStreamClose) {
      return;
    }
    writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] Codegraph stdin error: ${error.message}\n`, {
      operation: 'report-child-stdin-error',
      childPid: managedChild.pid,
    });
  });
}

function buildChildProcessErrorInvestigation(failureClass, transportShouldStayAlive) {
  return {
    failureBoundary: 'base-codegraph-child',
    failureClass,
    transportShouldStayAlive,
    likelyRootCause: transportShouldStayAlive
      ? 'A stale or shutting-down base CodeGraph child emitted a process error; inspect child.spawn, child.exit, and runtime.currentChild before treating this as a transport crash'
      : 'The current base CodeGraph child failed to spawn or emitted a process error; the wrapper records child.error and wrapper.exit before closing the parent transport',
    nextEvidence: [
      'error.name',
      'error.message',
      'error.code',
      'error.syscall',
      'error.stack',
      'child.spawn',
      'child.stderr',
      'wrapper.exit',
      'runtime',
    ],
  };
}

function observeChildRuntimeTopology(managedChild, text) {
  if (managedChild !== child || shuttingDown || childExited) {
    return null;
  }

  const value = String(text ?? '');
  const startupTopology = summarizeCodegraphRuntimeTopology(createCodegraphChildEnv());
  if (startupTopology.daemonDisabled) {
    return null;
  }

  let latestTransition = null;
  if (isSharedDaemonConnectionLostText(value)) {
    latestTransition = applyChildRuntimeTopologyTransition(managedChild, {
      reason: 'shared-daemon-connection-lost',
      text: value,
      nextTopology: {
      ...startupTopology,
      mode: 'in-process-fallback',
      watcherOwnership: startupTopology.watchDisabled
        ? 'disabled-manual-sync'
        : 'in-process-fallback-initializing',
      fileLockContentionRisk: startupTopology.watchDisabled
        ? 'none-no-watcher'
        : 'multi-wrapper-writers-pending',
      },
    }) ?? latestTransition;
  }
  if (
    isCodegraphFileWatcherActiveText(value)
    && isInProcessFallbackTopology(childRuntimeTopology)
    && childRuntimeTopology.watchDisabled === false
  ) {
    latestTransition = applyChildRuntimeTopologyTransition(managedChild, {
      reason: 'fallback-file-watcher-active',
      text: value,
      nextTopology: {
        ...childRuntimeTopology,
        mode: 'in-process-fallback-watcher',
        watcherOwnership: 'per-wrapper-fallback-watcher',
        fileLockContentionRisk: 'multi-wrapper-writers',
      },
    }) ?? latestTransition;
  }
  return latestTransition;
}

function applyChildRuntimeTopologyTransition(managedChild, { reason, text, nextTopology }) {
  if (!nextTopology || runtimeTopologiesEqual(childRuntimeTopology, nextTopology)) {
    return null;
  }

  const from = childRuntimeTopology;
  childRuntimeTopology = nextTopology;
  if (!sharedDaemonFallbackDetectedAtMs) {
    sharedDaemonFallbackDetectedAtMs = Date.now();
  }
  const failureClass = nextTopology.mode === 'in-process-fallback-watcher'
    ? 'shared-daemon-fallback-watcher'
    : 'shared-daemon-fallback';
  const runtime = summarizeRuntimeState();
  diagnostics.log('child.runtime-topology.transition', {
    pid: managedChild.pid,
    reason,
    failureClass,
    from,
    to: nextTopology,
    textTail: warningTextTail(text, 1200),
    investigation: buildSharedDaemonFallbackInvestigation(failureClass),
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
  });
  requestSharedDaemonFallbackRecovery(managedChild, reason);
  return { reason, failureClass, from, to: nextTopology };
}

function requestSharedDaemonFallbackRecovery(managedChild, trigger) {
  if (managedChild !== child || shuttingDown || childExited) {
    return;
  }
  const startupTopology = summarizeCodegraphRuntimeTopology(createCodegraphChildEnv());
  if (startupTopology.daemonDisabled || !SHARED_DAEMON_FALLBACK_RECOVERY_ENABLED) {
    diagnostics.log('child.shared-daemon-fallback.recovery.skipped', {
      pid: managedChild.pid,
      trigger,
      failureClass: 'shared-daemon-fallback',
      reason: startupTopology.daemonDisabled
        ? 'shared-daemon-disabled-by-config'
        : 'recovery-disabled-by-env',
      runtime: summarizeRuntimeState(),
    });
    return;
  }

  if (sharedDaemonFallbackRecoveryTimer && sharedDaemonFallbackRecoveryChild === managedChild) {
    diagnostics.log('child.shared-daemon-fallback.recovery.coalesced', {
      pid: managedChild.pid,
      trigger,
      originalTrigger: sharedDaemonFallbackRecoveryTrigger,
      failureClass: 'shared-daemon-fallback',
      runtime: summarizeRuntimeState(),
    });
    return;
  }

  sharedDaemonFallbackRecoveryChild = managedChild;
  sharedDaemonFallbackRecoveryRequestedAtMs = sharedDaemonFallbackRecoveryRequestedAtMs || Date.now();
  sharedDaemonFallbackRecoveryTrigger = sharedDaemonFallbackRecoveryTrigger ?? trigger;
  diagnostics.log('child.shared-daemon-fallback.recovery.request', {
    pid: managedChild.pid,
    trigger,
    failureClass: 'shared-daemon-fallback',
    delayMs: SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS,
    maxWaitMs: SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS,
    runtime: summarizeRuntimeState(),
  });
  scheduleSharedDaemonFallbackRecoveryAttempt(
    managedChild,
    SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS,
  );
}

function scheduleSharedDaemonFallbackRecoveryAttempt(managedChild, delayMs) {
  clearSharedDaemonFallbackRecoveryTimer();
  sharedDaemonFallbackRecoveryChild = managedChild;
  sharedDaemonFallbackRecoveryTimer = setTimeout(() => {
    sharedDaemonFallbackRecoveryTimer = null;
    attemptSharedDaemonFallbackRecovery(managedChild);
  }, delayMs);
  sharedDaemonFallbackRecoveryTimer.unref?.();
}

function attemptSharedDaemonFallbackRecovery(managedChild) {
  if (managedChild !== child || shuttingDown || childExited) {
    diagnostics.log('child.shared-daemon-fallback.recovery.cancelled', {
      pid: managedChild?.pid ?? null,
      failureClass: 'shared-daemon-fallback',
      reason: managedChild !== child
        ? 'child-already-replaced'
        : shuttingDown
          ? 'wrapper-shutting-down'
          : 'child-already-exited',
      runtime: summarizeRuntimeState(),
    });
    return;
  }

  const busyReasons = sharedDaemonFallbackRecoveryBusyReasons();
  const elapsedMs = sharedDaemonFallbackRecoveryRequestedAtMs > 0
    ? Date.now() - sharedDaemonFallbackRecoveryRequestedAtMs
    : 0;
  if (busyReasons.length > 0 && elapsedMs < SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS) {
    sharedDaemonFallbackRecoveryDeferCount++;
    diagnostics.log('child.shared-daemon-fallback.recovery.deferred', {
      pid: managedChild.pid,
      failureClass: 'shared-daemon-fallback',
      busyReasons,
      elapsedMs,
      deferCount: sharedDaemonFallbackRecoveryDeferCount,
      nextDelayMs: SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS,
      maxWaitMs: SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS,
      runtime: summarizeRuntimeState(),
    });
    scheduleSharedDaemonFallbackRecoveryAttempt(
      managedChild,
      SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS,
    );
    return;
  }

  if (busyReasons.length > 0) {
    diagnostics.log('child.shared-daemon-fallback.recovery.force', {
      pid: managedChild.pid,
      failureClass: 'shared-daemon-fallback-recovery-max-wait',
      busyReasons,
      elapsedMs,
      deferCount: sharedDaemonFallbackRecoveryDeferCount,
      maxWaitMs: SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS,
      rootCauseSnapshot: buildRootCauseSnapshot(summarizeRuntimeState()),
      runtime: summarizeRuntimeState(),
    });
    failBaseCodegraphPendingRequests(
      'shared-daemon-fallback-recovery-max-wait',
      managedChild.pid,
      null,
      null,
    );
    failPendingContextPacksForBaseChildExit(
      'shared-daemon-fallback-recovery-max-wait',
      managedChild.pid,
      null,
      null,
    );
    clearAllSuppressedChildResponseIds('shared-daemon-fallback-recovery', managedChild.pid);
    clearAllExpiredContextPackIds('shared-daemon-fallback-recovery', managedChild.pid);
  }

  const runtime = summarizeRuntimeState();
  diagnostics.log('child.shared-daemon-fallback.recovery.restart', {
    pid: managedChild.pid,
    failureClass: 'shared-daemon-fallback',
    trigger: sharedDaemonFallbackRecoveryTrigger,
    elapsedMs,
    deferCount: sharedDaemonFallbackRecoveryDeferCount,
    runtimeTopology: childRuntimeTopology,
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
  });
  clearChildRestartTimer();
  clearChildTerminationTimer();
  terminateProcessTree(managedChild.pid, managedChild);
  spawnManagedCodegraph('shared-daemon-fallback');
}

function sharedDaemonFallbackRecoveryBusyReasons() {
  const reasons = [];
  if (activeClientRequests.size > 0) reasons.push('active-client-requests');
  if (pendingContextPacks.size > 0) reasons.push('pending-context-packs');
  if (pendingToolsListIds.size > 0) reasons.push('pending-tools-list');
  if (childInputQueue.length > 0) reasons.push('child-input-queue');
  if (childStdinBackpressured) reasons.push('child-stdin-backpressure');
  if (childStdoutBuffer.length > 0) reasons.push('buffered-child-stdout');
  return reasons;
}

function isSharedDaemonConnectionLostText(text) {
  return /Shared daemon connection lost; serving this session in-process \(degraded\)/i.test(
    String(text ?? ''),
  );
}

function isCodegraphFileWatcherActiveText(text) {
  return /\[CodeGraph MCP\]\s+File watcher active\b/i.test(String(text ?? ''));
}

function isInProcessFallbackTopology(value) {
  return String(value?.mode ?? '').startsWith('in-process-fallback');
}

function runtimeTopologiesEqual(left, right) {
  return left?.mode === right?.mode
    && left?.watcherOwnership === right?.watcherOwnership
    && left?.fileLockContentionRisk === right?.fileLockContentionRisk
    && left?.daemonDisabled === right?.daemonDisabled
    && left?.watchDisabled === right?.watchDisabled;
}

function buildSharedDaemonFallbackInvestigation(failureClass) {
  return {
    failureBoundary: 'base-codegraph-process-topology',
    failureClass,
    transportShouldStayAlive: true,
    likelyRootCause: failureClass === 'shared-daemon-fallback-watcher'
      ? 'The upstream shared-daemon proxy permanently fell back to an in-process engine and started a per-wrapper watcher, creating another SQLite writer candidate.'
      : 'The upstream shared-daemon proxy lost its daemon socket and permanently switched this live session to its in-process fallback engine.',
    nextEvidence: [
      'child.runtime-topology.transition',
      'child.shared-daemon-fallback.recovery.request',
      'child.shared-daemon-fallback.recovery.restart',
      'child.restart',
      '.codegraph/daemon.log',
      'hostMcp.activeInProcessFallbackWatcherRuns',
    ],
  };
}

function buildChildStdinErrorInvestigation(failureClass, transportShouldStayAlive) {
  return {
    failureBoundary: 'base-codegraph-child',
    failureClass,
    transportShouldStayAlive,
    likelyRootCause: 'The base CodeGraph child stdin stream emitted an error; inspect error.code to distinguish an expected closed pipe from a write-path failure',
    nextEvidence: [
      'error.name',
      'error.message',
      'error.code',
      'error.stack',
      'benignStreamClose',
      'child.stdin.write.error',
      'child.exit',
      'runtime',
    ],
  };
}

function handleChildOutputStreamError(managedChild, stream, error) {
  const failureClass = stream === 'stdout'
    ? 'child-stdout-stream-error'
    : 'child-stderr-stream-error';
  const runtime = summarizeRuntimeStateSafely();
  const diagnosticError = serializeDiagnosticError(error);
  diagnostics.log(`child.${stream}.error`, {
    pid: managedChild.pid,
    stream,
    failureClass,
    currentChild: managedChild === child,
    shuttingDown,
    error: diagnosticError,
    investigation: {
      failureBoundary: 'base-codegraph-child',
      failureClass,
      transportShouldStayAlive: true,
      likelyRootCause: stream === 'stdout'
        ? 'The base CodeGraph child stdout stream emitted an error, so MCP responses from the child are no longer reliable; the wrapper will restart the child while keeping the parent transport alive'
        : 'The base CodeGraph child stderr diagnostic stream emitted an error; stdout may still be usable, so the wrapper records the stream failure without closing the parent transport',
      nextEvidence: [
        'pid',
        'stream',
        'error',
        'currentChild',
        'child.restart',
        'child.exit',
        'runtime',
      ],
    },
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
  });

  if (managedChild !== child || shuttingDown || childExited || stream !== 'stdout') {
    return;
  }

  failBaseCodegraphPendingRequests(failureClass, managedChild.pid, null, null);
  failPendingContextPacksForBaseChildExit(failureClass, managedChild.pid, null, null);
  clearAllSuppressedChildResponseIds('child-stdout-stream-error', managedChild.pid);
  clearAllExpiredContextPackIds('child-stdout-stream-error', managedChild.pid);
  clearChildRestartTimer();
  clearSharedDaemonFallbackRecoveryTimer();
  clearChildTerminationTimer();
  terminateProcessTree(managedChild.pid, managedChild);
  spawnManagedCodegraph('stdout-stream-error');
}

function replayCodegraphSessionToChild(reason) {
  if (!lastInitializeParams) {
    return;
  }

  const initializeId = nextInternalRequestId;
  nextInternalRequestId -= 1;
  suppressChildResponseId(initializeId, 'session-replay-initialize');
  diagnostics.log('child.session.replay', {
    reason,
    initializeId,
    initializedNotification: clientInitialized,
  });
  writeToCodegraphStdin(`${JSON.stringify({
    jsonrpc: '2.0',
    id: initializeId,
    method: 'initialize',
    params: lastInitializeParams,
  })}\n`, 'replay-initialize');
  if (clientInitialized) {
    writeToCodegraphStdin(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })}\n`, 'replay-initialized');
  }
}

function suppressChildResponseId(id, reason) {
  const key = String(id);
  clearSuppressedChildResponseId(key);
  suppressedChildResponseIds.add(key);
  const timer = setTimeout(() => {
    if (!suppressedChildResponseIds.delete(key)) {
      suppressedChildResponseIdTimers.delete(key);
      return;
    }
    suppressedChildResponseIdTimers.delete(key);
    diagnostics.log('child.response.suppressed.expired', {
      id,
      reason,
      ttlMs: SUPPRESSED_CHILD_RESPONSE_ID_TTL_MS,
      runtime: summarizeRuntimeState(),
    });
  }, SUPPRESSED_CHILD_RESPONSE_ID_TTL_MS);
  timer.unref?.();
  suppressedChildResponseIdTimers.set(key, timer);
}

function clearSuppressedChildResponseId(id) {
  const key = String(id);
  const timer = suppressedChildResponseIdTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    suppressedChildResponseIdTimers.delete(key);
  }
  suppressedChildResponseIds.delete(key);
}

function clearAllSuppressedChildResponseIds(reason, childPid) {
  if (suppressedChildResponseIds.size === 0) {
    return;
  }

  const clearedIds = [...suppressedChildResponseIds];
  for (const id of clearedIds) {
    clearSuppressedChildResponseId(id);
  }
  diagnostics.log('child.response.suppressed.clear', {
    reason,
    childPid,
    clearedCount: clearedIds.length,
    clearedIds: clearedIds.slice(0, 8),
    runtime: summarizeRuntimeState(),
  });
}

function rememberExpiredContextPackId(id, reason) {
  const key = String(id);
  clearExpiredContextPackId(key);
  expiredContextPackIds.add(key);
  const timer = setTimeout(() => {
    if (!expiredContextPackIds.delete(key)) {
      expiredContextPackIdTimers.delete(key);
      return;
    }
    expiredContextPackIdTimers.delete(key);
    diagnostics.log('nanoflow.context.expired.expired', {
      internalId: id,
      reason,
      ttlMs: EXPIRED_CONTEXT_PACK_ID_TTL_MS,
      runtime: summarizeRuntimeState(),
    });
  }, EXPIRED_CONTEXT_PACK_ID_TTL_MS);
  timer.unref?.();
  expiredContextPackIdTimers.set(key, timer);
}

function clearExpiredContextPackId(id) {
  const key = String(id);
  const timer = expiredContextPackIdTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    expiredContextPackIdTimers.delete(key);
  }
  expiredContextPackIds.delete(key);
}

function clearAllExpiredContextPackIds(reason, childPid) {
  if (expiredContextPackIds.size === 0) {
    return;
  }

  const clearedIds = [...expiredContextPackIds];
  for (const id of clearedIds) {
    clearExpiredContextPackId(id);
  }
  diagnostics.log('nanoflow.context.expired.clear', {
    reason,
    childPid,
    clearedCount: clearedIds.length,
    clearedIds: clearedIds.slice(0, 8),
    runtime: summarizeRuntimeState(),
  });
}

function failBaseCodegraphPendingRequests(failureClass, childPid, code, signal) {
  const failedRequests = [...activeClientRequests.values()].filter(isBaseCodegraphPendingRequest);
  if (failedRequests.length === 0) {
    return;
  }

  diagnostics.log('base-codegraph.pending.fail', {
    failureClass,
    childPid,
    code,
    signal,
    failedRequestCount: failedRequests.length,
    failedRequests: failedRequests.slice(0, 8).map(requestTrace => ({
      requestId: requestTrace.requestId,
      clientId: requestTrace.clientId,
      requestKind: requestTrace.requestKind,
      method: requestTrace.method,
      tool: requestTrace.tool,
      ...summarizeDiagnosticQuery(requestTrace.query),
      elapsedMs: Date.now() - requestTrace.startedAtMs,
    })),
    runtime: summarizeRuntimeState(),
  });

  for (const requestTrace of failedRequests) {
    pendingToolsListIds.delete(String(requestTrace.clientId));
    writeJsonToClient({
      jsonrpc: '2.0',
      id: requestTrace.clientId,
      error: {
        code: -32001,
        message: 'Base CodeGraph child exited before responding. Retry after the wrapper restarts the child or use the codegraph CLI fallback.',
      },
    }, {
      source: 'base-codegraph-child',
      failureClass,
      childPid,
      childExitCode: code,
      childExitSignal: signal,
    });
  }
}

function failPendingContextPacksForBaseChildExit(failureClass, childPid, code, signal) {
  const failedContextPacks = [...pendingContextPacks.entries()];
  if (failedContextPacks.length === 0) {
    return;
  }

  diagnostics.log('nanoflow.context.pending.fail', {
    failureClass,
    childPid,
    code,
    signal,
    failedContextPackCount: failedContextPacks.length,
    failedContextPacks: failedContextPacks.slice(0, 8).map(([internalId, pending]) => ({
      internalId,
      originalId: pending.originalId,
      contextId: pending.contextId,
      query: pending.query,
      elapsedMs: Date.now() - pending.startedAtMs,
    })),
    runtime: summarizeRuntimeState(),
  });

  for (const [internalId, pending] of failedContextPacks) {
    clearTimeout(pending.timeoutTimer);
    pendingContextPacks.delete(internalId);
    const text = 'Base CodeGraph child exited before responding. Retry after the wrapper restarts the child or use the codegraph CLI fallback.';
    const failed = buildNanoFlowContextPackFailureResult({ text, failureClass });
    writeJsonToClient({
      jsonrpc: '2.0',
      id: pending.originalId,
      result: failed.result,
    }, {
      source: 'nanoflow-context-pack',
      contextId: pending.contextId,
      failureClass,
      childPid,
      childExitCode: code,
      childExitSignal: signal,
    });
  }
}

function isBaseCodegraphPendingRequest(requestTrace) {
  if (!requestTrace) {
    return false;
  }
  if (requestTrace.requestKind === 'tools-list') {
    return pendingToolsListIds.has(String(requestTrace.clientId));
  }
  return requestTrace.requestKind === 'codegraph-tool'
    || requestTrace.requestKind === 'tools-call'
    || requestTrace.requestKind === 'initialize';
}

function scheduleManagedCodegraphRestart(managedChild, code, signal, runtime) {
  const restartPlan = planManagedCodegraphRestart();
  const childExitDiagnostics = buildChildExitDiagnostics(code, signal, managedChild);
  if (restartPlan.delayMs > 0) {
    diagnostics.log('child.restart.delayed', {
      reason: 'unexpected-exit',
      code,
      signal,
      ...childExitDiagnostics,
      previousPid: managedChild.pid,
      delayMs: restartPlan.delayMs,
      rapidExitCount: restartPlan.rapidExitCount,
      restartWindowMs: CHILD_RESTART_BACKOFF_WINDOW_MS,
      restartBackoffAfter: CHILD_RESTART_BACKOFF_AFTER,
      restartBackoffInitialMs: CHILD_RESTART_BACKOFF_INITIAL_MS,
      restartBackoffMaxMs: CHILD_RESTART_BACKOFF_MAX_MS,
      investigation: {
        failureBoundary: 'base-codegraph-child',
        failureClass: 'base-codegraph-crash-loop',
        transportShouldStayAlive: true,
        likelyRootCause: 'Base CodeGraph child is exiting repeatedly during startup; wrapper is delaying restarts to avoid a hot restart loop',
        nextEvidence: [
          'code',
          'childExitCodeHex',
          'childExitClass',
          'childExitName',
          'childUptimeMs',
          'signal',
          'rapidExitCount',
          'delayMs',
          'child.exit',
          'child.stderr',
          'child.stdin.write.error',
        ],
      },
      runtime,
    });
    childRestartTimer = setTimeout(() => {
      childRestartTimer = null;
      if (!shuttingDown && child === managedChild) {
        spawnManagedCodegraph('unexpected-exit');
      }
    }, restartPlan.delayMs);
    childRestartTimer.unref?.();
    return;
  }

  setImmediate(() => {
    if (!shuttingDown && child === managedChild) {
      spawnManagedCodegraph('unexpected-exit');
    }
  });
}

function planManagedCodegraphRestart() {
  const now = Date.now();
  childRestartExitTimestamps.push(now);
  while (
    childRestartExitTimestamps.length > 0
    && childRestartExitTimestamps[0] < now - CHILD_RESTART_BACKOFF_WINDOW_MS
  ) {
    childRestartExitTimestamps.shift();
  }

  const rapidExitCount = childRestartExitTimestamps.length;
  if (rapidExitCount < CHILD_RESTART_BACKOFF_AFTER) {
    return { delayMs: 0, rapidExitCount };
  }

  const exponent = Math.min(8, rapidExitCount - CHILD_RESTART_BACKOFF_AFTER);
  const delayMs = Math.min(
    CHILD_RESTART_BACKOFF_MAX_MS,
    CHILD_RESTART_BACKOFF_INITIAL_MS * (2 ** exponent),
  );
  return { delayMs, rapidExitCount };
}

function buildChildExitDiagnostics(code, signal, managedChild) {
  const startedAtMs = Number(managedChild?.__nanoflowStartedAtMs);
  const uptimeMs = Number.isFinite(startedAtMs)
    ? Math.max(0, Date.now() - startedAtMs)
    : null;
  return {
    ...classifyChildExit(code, signal),
    childUptimeMs: uptimeMs,
  };
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

function requestChildShutdown(reason) {
  if (childExited) {
    return;
  }

  diagnostics.log('child.shutdown.request', { childPid: child.pid, reason });
  try {
    child.stdin.end();
  } catch (error) {
    diagnostics.log('child.stdin.end.error', {
      message: error?.message,
      code: error?.code,
      reason,
    });
  }

  if (!childTerminationTimer) {
    childTerminationTimer = setTimeout(() => {
      terminateChildTree(child.pid);
    }, CHILD_TERMINATION_GRACE_MS);
    childTerminationTimer.unref?.();
  }
}

function requestStaleWrapperRecycle(reason, staleDetails, requestTrace) {
  if (shuttingDown) {
    return;
  }
  staleWrapperRecycleReason = reason;
  if (!STALE_WRAPPER_AUTO_RECYCLE) {
    if (staleWrapperRecycleSkippedLogged) {
      return;
    }
    staleWrapperRecycleSkippedLogged = true;
    const runtime = summarizeRuntimeState();
    diagnostics.log('wrapper.script.stale.recycle.skipped', {
      reason,
      failureClass: 'stale-wrapper-script',
      expectedExit: false,
      autoRecycle: false,
      ...staleDetails,
      ...requestTraceDiagnostics(requestTrace),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
      investigation: {
        failureBoundary: 'mcp-host-transport',
        failureClass: 'stale-wrapper-script',
        transportShouldStayAlive: true,
        likelyRootCause: 'The wrapper script changed on disk while this MCP host still routes calls to the old wrapper process; automatic recycle is disabled because this host exposes wrapper exit as client-visible Transport closed',
        nextEvidence: [
          'wrapper.script.stale',
          'wrapper.script.stale.continue',
          'wrapper.script.stale.recycle.skipped',
          'codegraph:adapter:doctor',
        ],
      },
    });
    return;
  }
  if (staleWrapperRecycleRequested) {
    return;
  }
  staleWrapperRecycleRequested = true;
  staleWrapperRecycleRequestedAtMs = Date.now();
  staleWrapperRecycleDeferCount = 0;
  const runtime = summarizeRuntimeState();
  diagnostics.log('wrapper.script.stale.recycle.request', {
    reason,
    failureClass: 'stale-wrapper-script',
    ...staleDetails,
    ...requestTraceDiagnostics(requestTrace),
    recycleGraceMs: STALE_WRAPPER_RECYCLE_GRACE_MS,
    graceStartsAfter: 'last-client-output-flush',
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
    investigation: {
      failureBoundary: 'mcp-host-transport',
      failureClass: 'stale-wrapper-script',
      transportShouldStayAlive: false,
      likelyRootCause: 'The wrapper script changed on disk while this MCP host still routes calls to the old wrapper process; recycle only after the current response has been written and the host has had a full drain grace window',
      nextEvidence: [
        'wrapper.script.stale',
        'wrapper.script.stale.recycle.request',
        'wrapper.script.stale.recycle.defer',
        'wrapper.shutdown.stale-wrapper-script',
        'wrapper.exit',
        'runtime.lastClientOutputAgeMs',
      ],
    },
  });
  scheduleStaleWrapperRecycle();
}

function scheduleStaleWrapperRecycle(delayMs = STALE_WRAPPER_RECYCLE_GRACE_MS) {
  if (staleWrapperRecycleTimer || shuttingDown) {
    return;
  }

  const scheduledDelayMs = Math.max(1, delayMs);
  staleWrapperRecycleScheduledDelayMs = scheduledDelayMs;
  staleWrapperRecycleTimer = setTimeout(() => {
    staleWrapperRecycleTimer = null;
    staleWrapperRecycleScheduledDelayMs = 0;
    if (shuttingDown) {
      return;
    }

    const now = Date.now();
    const runtime = summarizeRuntimeState();
    if (
      runtime.activeRequestCount > 0
      || runtime.clientOutputQueueLength > 0
      || runtime.clientStdoutBackpressured
    ) {
      staleWrapperRecycleDeferCount += 1;
      diagnostics.log('wrapper.script.stale.recycle.defer', {
        reason: 'active-client-work',
        recycleGraceMs: STALE_WRAPPER_RECYCLE_GRACE_MS,
        nextDelayMs: STALE_WRAPPER_RECYCLE_GRACE_MS,
        recycleDeferCount: staleWrapperRecycleDeferCount,
        rootCauseSnapshot: buildRootCauseSnapshot(runtime),
        runtime,
      });
      scheduleStaleWrapperRecycle();
      return;
    }

    const lastOutputAgeMs = lastClientOutputFlushAtMs > 0
      ? now - lastClientOutputFlushAtMs
      : null;
    if (lastOutputAgeMs !== null && lastOutputAgeMs < STALE_WRAPPER_RECYCLE_GRACE_MS) {
      const nextDelayMs = Math.max(1, STALE_WRAPPER_RECYCLE_GRACE_MS - lastOutputAgeMs);
      staleWrapperRecycleDeferCount += 1;
      diagnostics.log('wrapper.script.stale.recycle.defer', {
        reason: 'recent-client-output',
        recycleGraceMs: STALE_WRAPPER_RECYCLE_GRACE_MS,
        lastClientOutputAgeMs: lastOutputAgeMs,
        nextDelayMs,
        recycleDeferCount: staleWrapperRecycleDeferCount,
        rootCauseSnapshot: buildRootCauseSnapshot(runtime),
        runtime,
        investigation: {
          failureBoundary: 'mcp-host-transport',
          failureClass: 'stale-wrapper-script',
          transportShouldStayAlive: true,
          likelyRootCause: 'The stale wrapper has finished request work but recently wrote the MCP response; delaying shutdown avoids surfacing a successful response as Transport closed in the host UI',
          nextEvidence: [
            'client.response',
            'lastClientOutputAgeMs',
            'nextDelayMs',
            'wrapper.shutdown.stale-wrapper-script',
          ],
        },
      });
      scheduleStaleWrapperRecycle(nextDelayMs);
      return;
    }

    shuttingDown = true;
    wrapperShutdownCause = buildWrapperShutdownCause('stale-wrapper-script', runtime, {
      transportClosedBy: 'wrapper-script-stale',
    });
    diagnostics.log('wrapper.shutdown.stale-wrapper-script', {
      childPid: child?.pid ?? null,
      recycleGraceMs: STALE_WRAPPER_RECYCLE_GRACE_MS,
      recycleDeferCount: staleWrapperRecycleDeferCount,
      staleWrapperRecycleElapsedMs: staleWrapperRecycleRequestedAtMs > 0
        ? now - staleWrapperRecycleRequestedAtMs
        : null,
      lastClientOutputAgeMs: lastOutputAgeMs,
      ...wrapperShutdownCause,
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    clearChildRestartTimer();
    clearSharedDaemonFallbackRecoveryTimer();
    requestChildShutdown('stale-wrapper-script');
  }, scheduledDelayMs);
  staleWrapperRecycleTimer.unref?.();
}

function requestClientStdinShutdown(streamEvent) {
  if (clientStdinShutdownRequested) {
    return;
  }
  clientStdinShutdownRequested = true;
  shuttingDown = true;
  const runtime = summarizeRuntimeState();
  wrapperShutdownCause = buildWrapperShutdownCause('host-stdin-closed', runtime, {
    transportClosedBy: 'client-stdin',
    streamEvent,
  });
  diagnostics.log('wrapper.shutdown.client-stdin', {
    streamEvent,
    childPid: child.pid,
    ...wrapperShutdownCause,
    runtime,
  });
  clearChildRestartTimer();
  clearSharedDaemonFallbackRecoveryTimer();
  clearStaleWrapperRecycleTimer();
  requestChildShutdown('client-stdin');
}

function handleClientStdioError(stream, error, extra = {}) {
  const failureClass = clientStdioFailureClass(stream);
  const transportClosedBy = `client-${stream}`;
  const runtime = summarizeRuntimeStateSafely();
  const diagnosticError = serializeDiagnosticError(error);
  const benignStreamClose = isBenignClientStreamClose(error);
  const shouldShutdown = stream !== 'stderr';
  const investigation = buildClientStdioErrorInvestigation(failureClass, stream, shouldShutdown);
  diagnostics.log(`client.${stream}.error`, {
    stream,
    failureClass,
    transportClosedBy,
    benignStreamClose,
    shouldShutdown,
    error: diagnosticError,
    investigation,
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
    ...extra,
  });

  if (!shouldShutdown) {
    return;
  }

  requestClientStdioShutdown({
    stream,
    streamEvent: 'error',
    failureClass,
    transportClosedBy,
  });
}

function requestClientStdioShutdown({
  stream,
  streamEvent,
  failureClass,
  transportClosedBy,
}) {
  if (clientStdinShutdownRequested) {
    return;
  }
  clientStdinShutdownRequested = true;
  shuttingDown = true;
  const runtime = summarizeRuntimeState();
  wrapperShutdownCause = buildWrapperShutdownCause(failureClass, runtime, {
    transportClosedBy,
    streamEvent,
    stream,
  });
  diagnostics.log('wrapper.shutdown.client-stdio', {
    stream,
    streamEvent,
    childPid: child?.pid ?? null,
    ...wrapperShutdownCause,
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
  });
  clearChildRestartTimer();
  clearSharedDaemonFallbackRecoveryTimer();
  clearStaleWrapperRecycleTimer();
  requestChildShutdown(transportClosedBy);
}

function shutdownAndExit() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const runtime = summarizeRuntimeState();
  wrapperShutdownCause = buildWrapperShutdownCause('host-signal', runtime, {
    transportClosedBy: 'process-signal',
  });
  diagnostics.log('wrapper.shutdown.signal', {
    childPid: child.pid,
    ...wrapperShutdownCause,
    runtime,
  });
  clearChildRestartTimer();
  clearSharedDaemonFallbackRecoveryTimer();
  clearStaleWrapperRecycleTimer();
  requestChildShutdown('signal');
  terminateChildTree(child.pid);
}

function installProcessFatalDiagnostics() {
  process.on('uncaughtException', error => {
    handleWrapperFatalRuntimeError('uncaughtException', error);
  });
  process.on('unhandledRejection', reason => {
    handleWrapperFatalRuntimeError('unhandledRejection', reason);
  });
  process.on('warning', warning => {
    handleWrapperProcessWarning(warning);
  });
  process.on('rejectionHandled', () => {
    handleWrapperRejectionHandled();
  });
}

function installProcessStdioDiagnostics() {
  process.stdin.on('error', error => {
    handleClientStdioError('stdin', error);
  });
  process.stdout.on('error', error => {
    handleClientStdioError('stdout', error);
  });
  process.stderr.on('error', error => {
    handleClientStdioError('stderr', error);
  });
}

function handleWrapperProcessWarning(warning) {
  const runtime = summarizeRuntimeStateSafely();
  const diagnosticWarning = serializeDiagnosticError(warning);
  const investigation = buildWrapperRuntimeDiagnosticInvestigation(
    'wrapper-process-warning',
    'Node emitted a process warning inside the wrapper; inspect warning.stack and preceding request, child, and overlay events',
  );
  const rootCauseSnapshot = buildRootCauseSnapshot(runtime);
  logWrapperRuntimeDiagnostic({
    kind: 'warning',
    failureClass: 'wrapper-process-warning',
    fatal: false,
    warning: diagnosticWarning,
    investigation,
    rootCauseSnapshot,
    runtime,
  });
  diagnostics.log('wrapper.process.warning', {
    kind: 'warning',
    failureClass: 'wrapper-process-warning',
    warning: diagnosticWarning,
    investigation,
    rootCauseSnapshot,
    runtime,
  });
}

function handleWrapperRejectionHandled() {
  const runtime = summarizeRuntimeStateSafely();
  const investigation = buildWrapperRuntimeDiagnosticInvestigation(
    'wrapper-rejection-handled-after-warning',
    'A previously unhandled Promise rejection was later handled; inspect preceding unhandledRejection/fatal events and async request boundaries',
  );
  const rootCauseSnapshot = buildRootCauseSnapshot(runtime);
  logWrapperRuntimeDiagnostic({
    kind: 'rejectionHandled',
    failureClass: 'wrapper-rejection-handled-after-warning',
    fatal: false,
    investigation,
    rootCauseSnapshot,
    runtime,
  });
  diagnostics.log('wrapper.process.rejection-handled', {
    kind: 'rejectionHandled',
    failureClass: 'wrapper-rejection-handled-after-warning',
    investigation,
    rootCauseSnapshot,
    runtime,
  });
}

function handleWrapperFatalRuntimeError(kind, reason) {
  const failureClass = kind === 'unhandledRejection'
    ? 'wrapper-unhandled-rejection'
    : 'wrapper-uncaught-exception';
  const runtime = summarizeRuntimeStateSafely();
  const error = serializeDiagnosticError(reason);
  const investigation = buildWrapperFatalInvestigation(failureClass, kind);
  const rootCauseSnapshot = buildRootCauseSnapshot(runtime);
  const fatalCause = {
    failureClass,
    expectedExit: false,
    transportClosedBy: 'wrapper-process-fatal',
    activeRequestsAtShutdown: runtime?.activeRequestCount ?? 0,
    investigation,
  };
  const isFirstFatalShutdown = !fatalShutdownLogged;

  if (isFirstFatalShutdown) {
    fatalShutdownLogged = true;
    logWrapperRuntimeDiagnostic({
      kind,
      failureClass,
      fatal: true,
      expectedExit: false,
      transportClosedBy: 'wrapper-process-fatal',
      error,
      investigation,
      rootCauseSnapshot,
      runtime,
    });
    diagnostics.log('wrapper.fatal', {
      kind,
      childPid: child?.pid ?? null,
      ...fatalCause,
      error,
      rootCauseSnapshot,
      runtime,
    });
  } else {
    diagnostics.log('wrapper.fatal.duplicate', {
      kind,
      childPid: child?.pid ?? null,
      ...fatalCause,
      error,
      rootCauseSnapshot,
      runtime,
    });
  }

  writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] Fatal wrapper ${kind}: ${error.message}\n`, {
    operation: 'report-wrapper-fatal',
    reason: kind,
    childPid: child?.pid ?? null,
  });
  if (error.stack) {
    writeToWrapperStderr(`${error.stack}\n`, {
      operation: 'report-wrapper-fatal-stack',
      reason: kind,
      childPid: child?.pid ?? null,
    });
  }

  shuttingDown = true;
  wrapperShutdownCause = fatalCause;
  clearChildRestartTimer();
  clearStaleWrapperRecycleTimer();
  clearChildTerminationTimer();
  releaseOverlayRefreshLock(activeOverlayRefreshLockPath);
  activeOverlayRefreshLockPath = null;
  try {
    if (child?.pid && !childExited) {
      terminateProcessTree(child.pid, child);
    }
  } catch {
    // Fatal path: diagnostics above are the authoritative evidence.
  }
  if (isFirstFatalShutdown) {
    diagnostics.log('wrapper.exit', {
      code: 1,
      reason: 'wrapper-fatal',
      kind,
      childPid: child?.pid ?? null,
      ...fatalCause,
      error,
      rootCauseSnapshot,
      runtime,
    });
  }
  process.exit(1);
}

function logWrapperRuntimeDiagnostic({
  kind,
  failureClass,
  fatal,
  expectedExit = null,
  transportClosedBy = null,
  error,
  warning,
  investigation,
  rootCauseSnapshot,
  runtime,
  extra = {},
}) {
  diagnostics.log('wrapper.runtime.diagnostic', {
    kind,
    failureClass,
    fatal,
    expectedExit,
    transportClosedBy,
    activeRequestsAtShutdown: runtime?.activeRequestCount ?? 0,
    ...(error ? { error } : {}),
    ...(warning ? { warning } : {}),
    investigation,
    rootCauseSnapshot,
    runtime,
    ...extra,
  });
}

function clearStaleWrapperRecycleTimer() {
  if (!staleWrapperRecycleTimer) {
    return;
  }
  clearTimeout(staleWrapperRecycleTimer);
  staleWrapperRecycleTimer = null;
  staleWrapperRecycleScheduledDelayMs = 0;
}

function terminateChildTree(pid) {
  if (!pid || childExited) {
    return;
  }

  diagnostics.log('child.terminate', { pid, platform: process.platform });
  terminateProcessTree(pid, child);
}

function terminateProcessTree(pid, fallbackProcess) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        fallbackProcess?.kill('SIGTERM');
      } catch {
        // Best effort. The wrapper will exit when the child exits or the host closes it.
      }
    });
    return;
  }

  try {
    fallbackProcess?.kill('SIGTERM');
  } catch {
    // Best effort.
  }
}

function clearChildTerminationTimer() {
  if (!childTerminationTimer) {
    return;
  }
  clearTimeout(childTerminationTimer);
  childTerminationTimer = null;
}

function clearChildRestartTimer() {
  if (!childRestartTimer) {
    return;
  }
  clearTimeout(childRestartTimer);
  childRestartTimer = null;
}

function clearSharedDaemonFallbackRecoveryTimer() {
  if (!sharedDaemonFallbackRecoveryTimer) {
    return;
  }
  clearTimeout(sharedDaemonFallbackRecoveryTimer);
  sharedDaemonFallbackRecoveryTimer = null;
}

function scheduleNanoFlowOverlayRefresh(projectRoot) {
  setTimeout(() => refreshNanoFlowOverlay(projectRoot), 0).unref();
}

function refreshNanoFlowOverlay(root) {
  const script = path.join(root, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs');
  if (!fs.existsSync(script)) {
    diagnostics.log('overlay.refresh.skip', { script, reason: 'missing-script' });
    return;
  }

  const lock = tryAcquireOverlayRefreshLock(root);
  if (!lock.acquired) {
    diagnostics.log('overlay.refresh.skip', {
      script,
      reason: lock.reason,
      lockPath: lock.lockPath,
      lockAgeMs: lock.lockAgeMs,
    });
    return;
  }
  activeOverlayRefreshLockPath = lock.lockPath;

  diagnostics.log('overlay.refresh.start', { script });
  const overlayChild = spawn(process.execPath, [script, '--root', root], {
    cwd: root,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  overlayChild.stdout?.setEncoding('utf8');
  overlayChild.stderr?.setEncoding('utf8');
  overlayChild.stdout?.on('data', chunk => { stdout += chunk; });
  overlayChild.stderr?.on('data', chunk => { stderr += chunk; });
  overlayChild.on('error', error => {
    diagnostics.log('overlay.refresh.error', { message: error.message, code: error.code });
    releaseOverlayRefreshLock(lock.lockPath);
    if (activeOverlayRefreshLockPath === lock.lockPath) {
      activeOverlayRefreshLockPath = null;
    }
  });
  overlayChild.on('exit', (code, signal) => {
    releaseOverlayRefreshLock(lock.lockPath);
    if (activeOverlayRefreshLockPath === lock.lockPath) {
      activeOverlayRefreshLockPath = null;
    }
    if (code !== 0) {
      diagnostics.log('overlay.refresh.error', {
        status: code,
        signal,
        stderr: stderr.trimEnd(),
        stdout: stdout.trimEnd(),
      });
      writeToWrapperStderr('[codegraph-nanoflow-mcp-stdio] Failed to refresh NanoFlow overlay in background.\n', {
        operation: 'report-overlay-refresh-error',
        childPid: overlayChild.pid ?? null,
      });
      if (stderr) {
        writeToWrapperStderr(stderr, {
          operation: 'forward-overlay-refresh-stderr',
          childPid: overlayChild.pid ?? null,
        });
      }
      return;
    }

    diagnostics.log('overlay.refresh.ok', { stdout: stdout.trimEnd() });
    if (stdout) {
      writeToWrapperStderr(stdout, {
        operation: 'forward-overlay-refresh-stdout',
        childPid: overlayChild.pid ?? null,
      });
    }
  });
}

function tryAcquireOverlayRefreshLock(root) {
  const lockPath = path.join(root, '.codegraph', 'nanoflow-overlay-refresh.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  try {
    const stat = fs.statSync(lockPath);
    const lockAgeMs = Date.now() - stat.mtimeMs;
    const lockOwnerPid = readOverlayRefreshLockPid(lockPath);
    if (lockOwnerPid && !isProcessAlive(lockOwnerPid)) {
      fs.rmSync(lockPath, { force: true });
      diagnostics.log('overlay.refresh.skip', {
        reason: 'stale-lock',
        lockPath,
        lockAgeMs,
        lockOwnerPid,
      });
    } else if (lockAgeMs <= OVERLAY_REFRESH_LOCK_STALE_MS) {
      return { acquired: false, reason: 'lock-held', lockPath, lockAgeMs };
    } else {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Missing or unreadable lock: attempt exclusive creation below.
  }

  try {
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }), { flag: 'wx' });
    return { acquired: true, lockPath };
  } catch (error) {
    return {
      acquired: false,
      reason: error?.code === 'EEXIST' ? 'lock-held' : 'lock-error',
      lockPath,
      message: error?.message,
      code: error?.code,
    };
  }
}

function readOverlayRefreshLockPid(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseOverlayRefreshLock(lockPath) {
  if (!lockPath) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch (error) {
    diagnostics.log('overlay.refresh.lock-release.error', {
      lockPath,
      message: error?.message,
      code: error?.code,
    });
  }
}

function resolveProjectRoot(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === '--path' || arg === '-p') && index + 1 < args.length) {
      return path.resolve(args[index + 1]);
    }
  }
  return process.cwd();
}

function spawnCodegraph(target, childArgs) {
  const childEnv = createCodegraphChildEnv();
  if (target.startsWith('@colbymchenry/codegraph@')) {
    const npxArgs = ['-y', target, ...childArgs];
    diagnostics.log('child.spawn', {
      mode: 'npx-package',
      command: process.platform === 'win32' ? 'cmd.exe' : 'npx',
      args: process.platform === 'win32' ? ['/d', '/s', '/c', quoteCmdCommand(['npx', ...npxArgs])] : npxArgs,
      target,
      packageName: target.replace(/@[^@]+$/, ''),
      packageVersion: target.includes('@') ? target.split('@').at(-1) : null,
      env: pickEnv(childEnv, CODEGRAPH_CHILD_ENV_KEYS),
      runtimeTopology: summarizeCodegraphRuntimeTopology(childEnv),
    });
    if (process.platform === 'win32') {
      return spawn(
        'cmd.exe',
        ['/d', '/s', '/c', quoteCmdCommand(['npx', ...npxArgs])],
        createSpawnOptions(childEnv),
      );
    }
    return spawn('npx', npxArgs, createSpawnOptions(childEnv));
  }

  const resolvedTarget = normalizePath(target);
  const localTargetExists = fs.existsSync(resolvedTarget);
  diagnostics.log('child.spawn.resolve-local', {
    target,
    resolvedTarget,
    exists: localTargetExists,
  });
  if (!localTargetExists) {
    const message = `Local codegraph entry not found: ${resolvedTarget}`;
    diagnostics.log('child.spawn.error', {
      mode: 'local',
      target,
      resolvedTarget,
      exists: false,
      reason: 'missing-target',
      code: 'ENOENT',
      message,
      cwd: process.cwd(),
      args: childArgs,
      runtime: summarizeRuntimeState(),
      investigation: {
        failureBoundary: 'base-codegraph-child',
        failureClass: 'child-spawn-missing-target',
        transportShouldStayAlive: false,
        likelyRootCause: 'Configured local CodeGraph target path does not exist before the base child can spawn',
        nextEvidence: [
          'target',
          'resolvedTarget',
          'cwd',
          'args',
          'runtime',
        ],
      },
    });
    writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] ${message}\n`, {
      operation: 'report-child-spawn-missing-target',
      reason: 'missing-target',
    });
    process.exit(2);
  }

  diagnostics.log('child.spawn', {
    mode: 'local',
    command: process.execPath,
    args: [resolvedTarget, ...childArgs],
    target,
    resolvedTarget,
    env: pickEnv(childEnv, CODEGRAPH_CHILD_ENV_KEYS),
    runtimeTopology: summarizeCodegraphRuntimeTopology(childEnv),
  });
  return spawn(process.execPath, [resolvedTarget, ...childArgs], createSpawnOptions(childEnv));
}

function createSpawnOptions(env = createCodegraphChildEnv()) {
  return {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

function createCodegraphChildEnv() {
  const daemonOverride = process.env.NANOFLOW_CODEGRAPH_ALLOW_DAEMON;
  const configuredNoDaemon = process.env.CODEGRAPH_NO_DAEMON ?? '0';
  const noDaemon = daemonOverride === '0'
    ? '1'
    : daemonOverride === '1'
      ? '0'
      : configuredNoDaemon;
  return {
    ...process.env,
    CODEGRAPH_NO_DAEMON: noDaemon,
    CODEGRAPH_NO_WATCH: process.env.CODEGRAPH_NO_WATCH ?? '0',
    CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS:
      positiveIntegerEnvValue(process.env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS)
      ?? CODEGRAPH_DAEMON_IDLE_TIMEOUT_DEFAULT,
    CODEGRAPH_DAEMON_MAX_IDLE_MS:
      positiveIntegerEnvValue(process.env.CODEGRAPH_DAEMON_MAX_IDLE_MS)
      ?? CODEGRAPH_DAEMON_MAX_IDLE_DEFAULT,
  };
}

function normalizeCodegraphChildEnv(env) {
  const receivedEnv = pickEnv(env, [
    'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
    'CODEGRAPH_DAEMON_MAX_IDLE_MS',
  ]);
  const corrections = [];
  normalizePositiveIntegerChildEnv(
    env,
    'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
    CODEGRAPH_DAEMON_IDLE_TIMEOUT_DEFAULT,
    corrections,
  );
  normalizePositiveIntegerChildEnv(
    env,
    'CODEGRAPH_DAEMON_MAX_IDLE_MS',
    CODEGRAPH_DAEMON_MAX_IDLE_DEFAULT,
    corrections,
  );
  return { receivedEnv, corrections };
}

function normalizePositiveIntegerChildEnv(env, key, fallback, corrections) {
  if (env[key] === undefined) return;
  const effective = positiveIntegerEnvValue(env[key]);
  if (effective !== null) return;
  const received = String(env[key]);
  env[key] = fallback;
  corrections.push({
    key,
    received,
    effective: fallback,
    reason: 'non-positive-or-invalid',
  });
}

function positiveIntegerEnvValue(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : null;
}

function summarizeCodegraphRuntimeTopology(env) {
  const daemonDisabled = isTruthyEnvValue(env.CODEGRAPH_NO_DAEMON);
  const watchDisabled = env.CODEGRAPH_NO_WATCH === '1';
  return {
    mode: daemonDisabled ? 'direct-session' : 'shared-daemon-proxy',
    watcherOwnership: watchDisabled
      ? 'disabled-manual-sync'
      : daemonDisabled
        ? 'per-wrapper-watcher'
        : 'shared-daemon-single-watcher',
    fileLockContentionRisk: watchDisabled
      ? 'none-no-watcher'
      : daemonDisabled
        ? 'multi-wrapper-writers'
        : 'single-writer',
    daemonDisabled,
    watchDisabled,
    daemonIdleTimeoutMs: Number(env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS),
    daemonMaxIdleMs: Number(env.CODEGRAPH_DAEMON_MAX_IDLE_MS),
  };
}

function isTruthyEnvValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

function quoteCmdCommand(args) {
  return args.map(quoteCmdArg).join(' ');
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) {
    return text;
  }

  return `"${text
    .replace(/"/g, '\\"')
    .replace(/%/g, '^%')
    .replace(/[&|<>^]/g, '^$&')}"`;
}

function normalizeCodegraphArgs(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    normalized.push(arg);

    if ((arg === '--path' || arg === '-p') && index + 1 < args.length) {
      index += 1;
      normalized.push(normalizePath(args[index]));
    }
  }
  return normalized;
}

function normalizePath(value) {
  if (!value || value.includes('${')) {
    return value;
  }

  try {
    return fs.realpathSync.native(value);
  } catch {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  }
}

function drainClientInput() {
  while (stdinBuffer.length > 0) {
    if (!clientMode) {
      const prefix = stdinBuffer.toString('utf8', 0, Math.min(stdinBuffer.length, 128)).trimStart();
      if (prefix.startsWith('Content-Length:')) {
        clientMode = 'content-length';
        diagnostics.log('client.mode.detected', { mode: clientMode });
        flushPendingChildLines();
      } else if (stdinBuffer.includes(0x0a)) {
        clientMode = 'newline';
        diagnostics.log('client.mode.detected', { mode: clientMode });
        flushPendingChildLines();
      } else {
        return;
      }
    }

    if (clientMode === 'content-length') {
      if (!drainContentLengthMessage()) {
        return;
      }
      continue;
    }

    if (!drainLineMessage()) {
      return;
    }
  }
}

function drainContentLengthMessage() {
  const headerEnd = findHeaderEnd(stdinBuffer);
  if (!headerEnd) {
    return false;
  }

  const header = stdinBuffer.slice(0, headerEnd.index).toString('utf8');
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
  if (!match) {
    handleInvalidClientHeader(header);
    writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] Invalid MCP header: ${JSON.stringify(header)}\n`, {
      operation: 'report-invalid-client-header',
      reason: 'client-invalid-header',
      childPid: child?.pid ?? null,
    });
    process.exit(1);
  }

  const bodyLength = Number(match[1]);
  const bodyStart = headerEnd.index + headerEnd.length;
  const bodyEnd = bodyStart + bodyLength;
  if (stdinBuffer.length < bodyEnd) {
    return false;
  }

  const body = stdinBuffer.slice(bodyStart, bodyEnd).toString('utf8');
  stdinBuffer = stdinBuffer.slice(bodyEnd);
  return forwardToCodegraph(body);
}

function handleInvalidClientHeader(header) {
  const failureClass = 'client-invalid-header';
  const runtime = summarizeRuntimeStateSafely();
  const investigation = buildClientInvalidHeaderInvestigation();
  const rootCauseSnapshot = buildRootCauseSnapshot(runtime);
  const shutdownCause = {
    failureClass,
    expectedExit: false,
    transportClosedBy: 'client-invalid-header',
    activeRequestsAtShutdown: runtime?.activeRequestCount ?? 0,
    investigation,
  };

  diagnostics.log('client.header.invalid', {
    failureClass,
    headerPreview: String(header ?? '').slice(0, 500),
    headerBytes: Buffer.byteLength(String(header ?? ''), 'utf8'),
    rootCauseSnapshot,
    runtime,
    investigation,
  });
  logWrapperRuntimeDiagnostic({
    kind: 'clientInvalidHeader',
    failureClass,
    fatal: true,
    expectedExit: false,
    transportClosedBy: 'client-invalid-header',
    investigation,
    rootCauseSnapshot,
    runtime,
  });

  shuttingDown = true;
  wrapperShutdownCause = shutdownCause;
  clearChildRestartTimer();
  clearStaleWrapperRecycleTimer();
  clearChildTerminationTimer();
  releaseOverlayRefreshLock(activeOverlayRefreshLockPath);
  activeOverlayRefreshLockPath = null;
  try {
    if (child?.pid && !childExited) {
      terminateProcessTree(child.pid, child);
    }
  } catch {
    // Exit path: diagnostic events above preserve the root-cause evidence.
  }
  diagnostics.log('wrapper.exit', {
    code: 1,
    reason: 'client-invalid-header',
    childPid: child?.pid ?? null,
    ...shutdownCause,
    rootCauseSnapshot,
    runtime,
  });
}

function drainChildOutput() {
  if (clientStdoutBackpressured) {
    return false;
  }

  while (childStdoutBuffer.length > 0) {
    if (startsWithContentLengthHeader(childStdoutBuffer)) {
      if (!drainChildContentLengthMessage()) return !clientStdoutBackpressured;
      continue;
    }

    const newlineIndex = childStdoutBuffer.indexOf(0x0a);
    if (newlineIndex === -1) return true;

    const line = childStdoutBuffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '');
    childStdoutBuffer = childStdoutBuffer.slice(newlineIndex + 1);
    if (line.trim().length > 0) {
      const augmented = augmentServerMessage(line);
      if (augmented !== null && !writeToClient(augmented)) return false;
    }
  }

  return true;
}

function startsWithContentLengthHeader(buffer) {
  const prefix = buffer.toString('utf8', 0, Math.min(buffer.length, 64));
  return /^Content-Length:/i.test(prefix);
}

function drainChildContentLengthMessage() {
  const headerEnd = findHeaderEnd(childStdoutBuffer);
  if (!headerEnd) return false;

  const header = childStdoutBuffer.slice(0, headerEnd.index).toString('utf8');
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
  if (!match) {
    diagnostics.log('child.header.invalid', { header });
    return drainChildLineMessage();
  }

  const bodyLength = Number(match[1]);
  const bodyStart = headerEnd.index + headerEnd.length;
  const bodyEnd = bodyStart + bodyLength;
  if (childStdoutBuffer.length < bodyEnd) return false;

  const body = childStdoutBuffer.slice(bodyStart, bodyEnd).toString('utf8');
  childStdoutBuffer = childStdoutBuffer.slice(bodyEnd);
  if (body.trim().length > 0) {
    const augmented = augmentServerMessage(body);
    return augmented === null ? true : writeToClient(augmented);
  }
  return true;
}

function drainChildLineMessage() {
  const newlineIndex = childStdoutBuffer.indexOf(0x0a);
  if (newlineIndex === -1) return false;

  const line = childStdoutBuffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '');
  childStdoutBuffer = childStdoutBuffer.slice(newlineIndex + 1);
  if (line.trim().length > 0) {
    const augmented = augmentServerMessage(line);
    return augmented === null ? true : writeToClient(augmented);
  }
  return true;
}

function drainLineMessage() {
  const newlineIndex = stdinBuffer.indexOf(0x0a);
  if (newlineIndex === -1) {
    return false;
  }

  const line = stdinBuffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '');
  stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
  if (line.trim().length > 0) {
    return forwardToCodegraph(line);
  }
  return true;
}

function findHeaderEnd(buffer) {
  const crlfIndex = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (crlfIndex !== -1) {
    return { index: crlfIndex, length: 4 };
  }

  const lfIndex = buffer.indexOf(Buffer.from('\n\n'));
  if (lfIndex !== -1) {
    return { index: lfIndex, length: 2 };
  }

  return null;
}

function forwardToCodegraph(jsonText) {
  const text = jsonText.trim();
  let message = null;
  try {
    message = JSON.parse(text);
  } catch {
    diagnostics.log('client.forward.raw', {
      bytes: Buffer.byteLength(text, 'utf8'),
      preview: text.slice(0, 500),
      reason: 'json-parse-failed',
      runtime: summarizeRuntimeState(),
    });
    return writeToCodegraphStdin(`${text}\n`, 'raw-client-message');
  }

  const staleWrapperScript = logWrapperScriptStaleIfNeeded();
  const requestTrace = beginClientRequest(message, text);
  diagnostics.log('client.message', {
    ...summarizeMcpMessage(message),
    ...requestTraceDiagnostics(requestTrace),
    rawMessageBytes: Buffer.byteLength(text, 'utf8'),
    runtime: summarizeRuntimeState(),
  });
  rememberCodegraphSessionMessage(message);

  if (isNanoFlowOverlayToolCall(message)) {
    diagnostics.log('nanoflow.overlay.handle', {
      ...summarizeMcpMessage(message),
      ...requestTraceDiagnostics(requestTrace),
      runtime: summarizeRuntimeState(),
    });
    if (staleWrapperScript) {
      logStaleWrapperScriptContinuation(message, requestTrace, 'nanoflow-overlay', staleWrapperScript);
      requestStaleWrapperRecycle('nanoflow-overlay', staleWrapperScript, requestTrace);
    }
    handleNanoFlowOverlayToolCall(message, requestTrace);
    return true;
  }

  if (isNanoFlowContextPackToolCall(message)) {
    diagnostics.log('nanoflow.context.forward.start', {
      ...summarizeMcpMessage(message),
      ...requestTraceDiagnostics(requestTrace),
      runtime: summarizeRuntimeState(),
    });
    if (staleWrapperScript) {
      logStaleWrapperScriptContinuation(message, requestTrace, 'nanoflow-context-pack', staleWrapperScript);
      requestStaleWrapperRecycle('nanoflow-context-pack', staleWrapperScript, requestTrace);
    }
    return forwardNanoFlowContextPackRequest(message, requestTrace);
  }

  if (isMcpResourceDiscoveryRequest(message)) {
    handleMcpResourceDiscoveryRequest(message, requestTrace);
    return true;
  }

  if (message?.method === 'tools/list' && message.id !== undefined) {
    pendingToolsListIds.add(String(message.id));
    diagnostics.log('tools.list.pending', {
      id: message.id,
      ...requestTraceDiagnostics(requestTrace),
      runtime: summarizeRuntimeState(),
    });
  }

  diagnostics.log('client.forward.child', {
    ...summarizeMcpMessage(message),
    ...requestTraceDiagnostics(requestTrace),
    runtime: summarizeRuntimeState(),
  });
  if (!isCodegraphChildWritable()) {
    if (message?.method === 'tools/list' && message.id !== undefined) {
      pendingToolsListIds.delete(String(message.id));
    }
    return writeBaseCodegraphUnavailableResponse(message, requestTrace, 'base-codegraph-tool');
  }
  return writeToCodegraphStdin(`${text}\n`, 'client-message');
}

function isCodegraphChildWritable() {
  return Boolean(
    child
    && !childExited
    && !child.stdin.destroyed
    && !child.stdin.writableEnded
  );
}

function writeBaseCodegraphUnavailableResponse(message, requestTrace, source) {
  diagnostics.log('base-codegraph.unavailable', {
    ...summarizeMcpMessage(message),
    ...requestTraceDiagnostics(requestTrace),
    source,
    failureClass: 'base-codegraph-unavailable',
    childRestartBackoffPending: Boolean(childRestartTimer),
    runtime: summarizeRuntimeState(),
    investigation: {
      failureBoundary: 'base-codegraph-child',
      failureClass: 'base-codegraph-unavailable',
      transportShouldStayAlive: true,
      likelyRootCause: 'Base CodeGraph child is not writable because it exited or is backing off after rapid restarts',
      nextEvidence: [
        'child.exit',
        'child.restart.request',
        'child.restart.delayed',
        'runtime.childExited',
        'runtime.childInputQueueLength',
      ],
    },
    rootCauseSnapshot: buildRootCauseSnapshot(summarizeRuntimeState()),
  });

  if (message?.id === undefined) {
    return true;
  }

  const unavailableMessage = 'Base CodeGraph child is restarting or unavailable. Retry after the wrapper logs child.restart or use the codegraph CLI fallback.';
  if (source === 'nanoflow-context-pack') {
    const failureClass = 'base-codegraph-unavailable';
    const failed = buildNanoFlowContextPackFailureResult({
      text: unavailableMessage,
      failureClass,
    });
    return writeJsonToClient({
      jsonrpc: '2.0',
      id: message.id,
      result: failed.result,
    }, { source, failureClass });
  }

  return writeJsonToClient({
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32001,
      message: unavailableMessage,
    },
  }, {
    source,
    failureClass: 'base-codegraph-unavailable',
  });
}

function rememberCodegraphSessionMessage(message) {
  if (message?.method === 'initialize' && message.id !== undefined) {
    lastInitializeParams = message.params ?? {};
    clientInitialized = false;
    diagnostics.log('client.session.initialize', { id: message.id });
    return;
  }
  if (message?.method === 'notifications/initialized') {
    clientInitialized = true;
    diagnostics.log('client.session.initialized');
  }
}

function writeToCodegraphStdin(text, reason) {
  const writeDiagnostics = buildChildInputWriteDiagnostics(text, reason);
  if (!child || childExited || child.stdin.destroyed || child.stdin.writableEnded) {
    diagnostics.log('child.stdin.write.skip', {
      reason,
      ...writeDiagnostics,
      childExited,
      runtime: summarizeRuntimeState(),
    });
    return false;
  }

  childInputQueue.push({ text, reason, writeDiagnostics });
  return flushChildInputQueue();
}

function buildChildInputWriteDiagnostics(text, reason) {
  let message;
  try {
    message = JSON.parse(String(text ?? '').trim());
  } catch {
    return { reason };
  }
  const pending = message?.id === undefined
    ? null
    : pendingContextPacks.get(String(message.id));
  const requestTrace = pending?.requestTrace
    ?? (message?.id === undefined ? null : getClientRequestTrace(message.id));
  return {
    reason,
    childRequestId: message?.id,
    internalId: pending ? message.id : undefined,
    originalId: pending?.originalId,
    contextId: pending?.contextId,
    ...requestTraceDiagnostics(requestTrace),
  };
}

function buildChildStdinWriteInvestigation(failureClass) {
  return {
    failureBoundary: 'base-codegraph-child',
    failureClass,
    transportShouldStayAlive: true,
    likelyRootCause: 'Writing a traced MCP request to the base CodeGraph child stdin failed; inspect the request identity, error code, child exit events, and restart state',
    nextEvidence: [
      'requestId',
      'clientId',
      'requestKind',
      'tool',
      'query',
      'childRequestId',
      'error.name',
      'error.message',
      'error.code',
      'error.syscall',
      'child.exit',
      'child.restart',
      'runtime',
    ],
  };
}

function flushChildInputQueue() {
  if (childStdinBackpressured) {
    return false;
  }

  if (!child || childExited || child.stdin.destroyed || child.stdin.writableEnded) {
    return false;
  }

  let activeEntry = null;
  try {
    while (childInputQueue.length > 0) {
      activeEntry = childInputQueue.shift();
      const { text, reason, writeDiagnostics = {} } = activeEntry;
      const ok = child.stdin.write(text, error => {
        if (!error) {
          return;
        }
        const failureClass = 'child-stdin-write-error';
        const runtime = summarizeRuntimeStateSafely();
        diagnostics.log('child.stdin.write.error', {
          failureClass,
          message: error.message,
          code: error.code,
          reason,
          ...writeDiagnostics,
          error: serializeDiagnosticError(error),
          investigation: buildChildStdinWriteInvestigation(failureClass),
          rootCauseSnapshot: buildRootCauseSnapshot(runtime),
          runtime,
        });
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
          writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] Codegraph stdin write error: ${error.message}\n`, {
            operation: 'report-child-stdin-write-error',
            reason,
            childPid: child?.pid ?? null,
          });
        }
      });

      if (!ok) {
        childStdinBackpressured = true;
        diagnostics.log('child.stdin.backpressure', {
          reason,
          ...writeDiagnostics,
          bytes: Buffer.byteLength(text, 'utf8'),
          queuedMessages: childInputQueue.length,
          runtime: summarizeRuntimeState(),
        });
        process.stdin.pause?.();
        child.stdin.once('drain', onChildStdinDrain);
        return false;
      }
      activeEntry = null;
    }
  } catch (error) {
    const failureClass = 'child-stdin-write-throw';
    const runtime = summarizeRuntimeStateSafely();
    diagnostics.log('child.stdin.write.throw', {
      failureClass,
      message: error?.message,
      code: error?.code,
      reason: activeEntry?.reason,
      ...(activeEntry?.writeDiagnostics ?? {}),
      error: serializeDiagnosticError(error),
      queuedMessages: childInputQueue.length,
      investigation: buildChildStdinWriteInvestigation(failureClass),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') {
      writeToWrapperStderr(`[codegraph-nanoflow-mcp-stdio] Codegraph stdin write error: ${error.message}\n`, {
        operation: 'report-child-stdin-write-throw',
        childPid: child?.pid ?? null,
      });
    }
    return false;
  }

  return true;
}

function onChildStdinDrain() {
  childStdinBackpressured = false;
  diagnostics.log('child.stdin.drain', {
    queuedMessages: childInputQueue.length,
    runtime: summarizeRuntimeState(),
  });
  const flushed = flushChildInputQueue();
  if (flushed && !clientStdoutBackpressured && !shuttingDown) {
    process.stdin.resume?.();
    drainClientInput();
  }
}

function augmentServerMessage(line) {
  let message = null;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }

  if (message?.id !== undefined && suppressedChildResponseIds.delete(String(message.id))) {
    diagnostics.log('child.response.suppressed', {
      id: message.id,
      method: message.method,
      hasError: Boolean(message.error),
    });
    clearSuppressedChildResponseId(message.id);
    return null;
  }

  if (message?.id !== undefined && pendingToolsListIds.delete(String(message.id))) {
    const tools = message?.result?.tools;
    if (Array.isArray(tools)) {
      appendToolIfMissing(tools, createNanoFlowOverlayToolDefinition());
      appendToolIfMissing(tools, createNanoFlowContextPackToolDefinition());
      const failureClass = message.error ? 'child-error-response' : 'success';
      diagnostics.log('tools.list.augmented', {
        id: message.id,
        ...requestTraceDiagnostics(getClientRequestTrace(message.id)),
        toolCount: tools.length,
        hasOverlay: tools.some(tool => tool?.name === 'nanoflow_overlay_query'),
        hasContextPack: tools.some(tool => tool?.name === 'nanoflow_context_pack'),
        failureClass,
      });
      completeClientRequest(message.id, message, {
        source: 'child',
        failureClass,
        augmentation: 'tools-list',
      });
      return JSON.stringify(message);
    }
  }

  if (message?.id !== undefined && pendingContextPacks.has(String(message.id))) {
    const pending = pendingContextPacks.get(String(message.id));
    diagnostics.log('nanoflow.context.child.response', {
      internalId: message.id,
      ...requestTraceDiagnostics(pending?.requestTrace),
      contextId: pending?.contextId,
      hasError: Boolean(message.error),
      isError: Boolean(message?.result?.isError),
    });
    handleCodegraphContextPackResponse(message);
    return null;
  }

  if (message?.id !== undefined && expiredContextPackIds.has(String(message.id))) {
    handleCodegraphContextPackResponse(message);
    return null;
  }

  if (message?.id !== undefined) {
    completeClientRequest(message.id, message, {
      source: 'child',
      failureClass: message.error ? 'child-error-response' : 'success',
    });
  }
  return line;
}

function appendToolIfMissing(tools, toolDefinition) {
  if (!tools.some(tool => tool?.name === toolDefinition.name)) {
    tools.push(toolDefinition);
  }
}

function isNanoFlowOverlayToolCall(message) {
  return message?.method === 'tools/call'
    && message?.params?.name === 'nanoflow_overlay_query'
    && message.id !== undefined;
}

function isNanoFlowContextPackToolCall(message) {
  return message?.method === 'tools/call'
    && message?.params?.name === 'nanoflow_context_pack'
    && message.id !== undefined;
}

function isMcpResourceDiscoveryRequest(message) {
  return (
    message?.method === 'resources/list'
    || message?.method === 'resources/templates/list'
  ) && message.id !== undefined;
}

function handleMcpResourceDiscoveryRequest(message, requestTrace) {
  const isTemplateList = message.method === 'resources/templates/list';
  const resultKey = isTemplateList ? 'resourceTemplates' : 'resources';
  diagnostics.log(isTemplateList ? 'resources.templates.list.empty' : 'resources.list.empty', {
    ...summarizeMcpMessage(message),
    ...requestTraceDiagnostics(requestTrace),
    resultKey,
    failureClass: 'success',
    runtime: summarizeRuntimeState(),
  });
  writeJsonToClient({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      [resultKey]: [],
    },
  }, {
    source: 'wrapper',
    failureClass: 'success',
    augmentation: 'resources-discovery',
  });
}

function buildNanoFlowContextPackToolResult(text, outcome, failureClass) {
  return {
    content: [{ type: 'text', text: String(text ?? '') }],
    isError: isNanoFlowContextOutcomeError(outcome),
    structuredContent: { outcome },
    _meta: {
      nanoflowFailureClass: failureClass,
      nanoflowOutcomeSchemaVersion: outcome.schemaVersion,
      nanoflowOutcomeStatus: outcome.status,
      nanoflowContextUsable: outcome.usableContext,
    },
  };
}

function buildNanoFlowContextPackFailureResult({
  text,
  failureClass,
  baseText = '',
  baseIsError = true,
  overlayAvailable = false,
  overlayFailureClass = null,
  overlayGenerationId = null,
}) {
  const outcome = buildNanoFlowContextOutcomeV1({
    primaryFailureClass: failureClass,
    base: {
      available: !baseIsError && Buffer.byteLength(baseText, 'utf8') > 0,
      isError: baseIsError,
      text: baseText,
      failureClass: baseIsError ? failureClass : null,
    },
    overlay: {
      available: overlayAvailable,
      isError: !overlayAvailable,
      failureClass: overlayAvailable ? null : overlayFailureClass,
      generationId: overlayGenerationId,
    },
  });
  return {
    outcome,
    result: buildNanoFlowContextPackToolResult(text, outcome, failureClass),
  };
}

function forwardNanoFlowContextPackRequest(message, requestTrace) {
  try {
    return forwardNanoFlowContextPackRequestUnchecked(message, requestTrace);
  } catch (error) {
    return handleNanoFlowContextPackEntryError(message, requestTrace, error);
  }
}

function forwardNanoFlowContextPackRequestUnchecked(message, requestTrace) {
  const args = message.params?.arguments ?? {};
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    writeInvalidParamsResponse(
      message.id,
      'nanoflow_context_pack requires a non-empty query string.',
      'nanoflow-context-pack',
    );
    return;
  }
  const overlayLimit = args.overlayLimit === undefined ? 20 : args.overlayLimit;
  const maxFilesWasDefaulted = args.maxFiles === undefined;
  const maxFiles = maxFilesWasDefaulted ? 8 : args.maxFiles;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 20) {
    writeInvalidParamsResponse(
      message.id,
      'nanoflow_context_pack maxFiles must be an integer between 1 and 20.',
      'nanoflow-context-pack',
    );
    return;
  }
  if (!Number.isInteger(overlayLimit) || overlayLimit < 1 || overlayLimit > 100) {
    writeInvalidParamsResponse(
      message.id,
      'nanoflow_context_pack overlayLimit must be an integer between 1 and 100.',
      'nanoflow-context-pack',
    );
    return;
  }
  if (!isCodegraphChildWritable()) {
    return writeBaseCodegraphUnavailableResponse(message, requestTrace, 'nanoflow-context-pack');
  }

  const internalId = nextInternalRequestId;
  nextInternalRequestId -= 1;
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + CONTEXT_PACK_TIMEOUT_MS;
  const contextId = `${diagnostics.runId}:context-${Math.abs(internalId)}`;
  const baseQuery = contextPackExploreQueryFor(query);
  const baseQueryFocused = baseQuery !== query;
  const baseMaxFiles = baseQueryFocused && maxFilesWasDefaulted ? 1 : maxFiles;
  const timeoutTimer = setTimeout(() => {
    handleNanoFlowContextPackTimeout(internalId);
  }, CONTEXT_PACK_TIMEOUT_MS);
  timeoutTimer.unref?.();
  pendingContextPacks.set(String(internalId), {
    originalId: message.id,
    query,
    baseQuery,
    baseQueryFocused,
    overlayLimit,
    maxFiles,
    maxFilesWasDefaulted,
    baseMaxFiles,
    contextId,
    requestTrace,
    startedAtMs,
    deadlineMs,
    timeoutTimer,
  });

  diagnostics.log('nanoflow.context.child.request', {
    originalId: message.id,
    internalId,
    ...requestTraceDiagnostics(requestTrace),
    contextId,
    query,
    baseQuery,
    baseQueryFocused,
    maxFiles,
    baseMaxFiles,
    overlayLimit,
    startedAtMs,
    deadlineMs,
    timeoutMs: CONTEXT_PACK_TIMEOUT_MS,
  });
  const forwarded = writeToCodegraphStdin(`${JSON.stringify({
    jsonrpc: '2.0',
    id: internalId,
    method: 'tools/call',
    params: {
      name: 'codegraph_explore',
      arguments: {
        query: baseQuery,
        maxFiles: baseMaxFiles,
      },
    },
  })}\n`, 'context-pack-codegraph-explore');

  if (!forwarded && !childStdinBackpressured) {
    return failPendingContextPackForwarding(internalId, 'context-pack-codegraph-explore-write-failed');
  }

  if (forwarded) {
    startPendingContextPackOverlay(internalId);
  }

  return forwarded;
}

function handleNanoFlowContextPackEntryError(message, requestTrace, error) {
  const pendingEntry = removePendingContextPackByOriginalId(message?.id);
  const pending = pendingEntry?.pending ?? null;
  const internalId = pendingEntry?.internalId ?? null;
  const query = pending?.query ?? requestTrace?.query ?? getMessageQuery(message);
  const runtime = summarizeRuntimeState();
  const contextId = pending?.contextId ?? null;
  const queryPlan = pending
    ? buildContextPackQueryPlan(pending)
    : {
        rawQuery: query,
        contextTimeoutMs: CONTEXT_PACK_TIMEOUT_MS,
        overlayTimeoutMs: OVERLAY_QUERY_TIMEOUT_MS,
      };

  diagnostics.log('nanoflow.context.error', {
    originalId: message?.id,
    internalId,
    ...requestTraceDiagnostics(requestTrace),
    contextId,
    query,
    queryClassification: query ? safeSummarizeContextPackQueryClassification(query) : undefined,
    queryPlan,
    elapsedMs: pending?.startedAtMs ? Date.now() - pending.startedAtMs : undefined,
    failureClass: 'context-pack-entry-error',
    message: errorToMessage(error),
    stack: errorToStack(error),
    investigation: buildContextPackInvestigation('context-pack-entry-error'),
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
  });

  if (message?.id === undefined) {
    return true;
  }

  const failureClass = 'context-pack-entry-error';
  const text = [
    'NanoFlow context pack failed before forwarding to base CodeGraph.',
    '',
    errorToMessage(error),
    '',
    'The MCP wrapper is still alive; retry a narrower query or use a native CodeGraph tool directly.',
  ].join('\n');
  const failed = buildNanoFlowContextPackFailureResult({ text, failureClass });
  return writeJsonToClient({
    jsonrpc: '2.0',
    id: message.id,
    result: failed.result,
  }, {
    source: 'nanoflow-context-pack',
    contextId,
    failureClass: 'context-pack-entry-error',
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
  });
}

function safeSummarizeContextPackQueryClassification(query) {
  try {
    return summarizeContextPackQueryClassification(query);
  } catch (error) {
    return {
      classificationError: serializeDiagnosticError(error),
    };
  }
}

function removePendingContextPackByOriginalId(originalId) {
  if (originalId === undefined) {
    return null;
  }
  for (const [internalId, pending] of pendingContextPacks.entries()) {
    if (pending.originalId !== originalId) {
      continue;
    }
    clearTimeout(pending.timeoutTimer);
    pendingContextPacks.delete(internalId);
    return { internalId, pending };
  }
  return null;
}

function startPendingContextPackOverlay(internalId) {
  const pending = pendingContextPacks.get(String(internalId));
  if (!pending || pending.overlayPromise) {
    return pending?.overlayPromise ?? null;
  }

  const overlayStartedAtMs = Date.now();
  const baseElapsedMs = overlayStartedAtMs - pending.startedAtMs;
  const deadlineRemainingMs = Math.max(1, pending.deadlineMs - overlayStartedAtMs);
  const overlayTimeoutMs = Math.max(deadlineRemainingMs, OVERLAY_QUERY_TIMEOUT_MS);
  const overlayQuery = contextPackOverlayQueryFor(pending.query);
  diagnostics.log('nanoflow.context.overlay.start', {
    originalId: pending.originalId,
    internalId,
    ...requestTraceDiagnostics(pending.requestTrace),
    contextId: pending.contextId,
    query: pending.query,
    baseQuery: pending.baseQuery,
    overlayQuery,
    elapsedMs: baseElapsedMs,
      baseElapsedMs,
      deadlineRemainingMs,
      timeoutMs: overlayTimeoutMs,
      contextTimeoutMs: CONTEXT_PACK_TIMEOUT_MS,
      overlayTimeoutMs: OVERLAY_QUERY_TIMEOUT_MS,
      overlayRecoveryGraceMs: CONTEXT_PACK_TIMEOUT_OVERLAY_GRACE_MS,
      queryPlan: buildContextPackQueryPlan(pending, {
        deadlineRemainingMs,
        overlayTimeoutMs,
      }),
      runtime: summarizeRuntimeState(),
    });

  pending.overlayQuery = overlayQuery;
  pending.overlayStartedAtMs = overlayStartedAtMs;
  pending.overlayTimeoutMs = overlayTimeoutMs;
  pending.overlayDeadlineMs = overlayStartedAtMs + overlayTimeoutMs;
  pending.overlayPromise = runNanoFlowOverlayQuery(overlayQuery, pending.overlayLimit, {
    contextJson: true,
    timeoutMs: overlayTimeoutMs,
    settleOnTimeout: true,
    requestTrace: pending.requestTrace,
    contextId: pending.contextId,
  });
  return pending.overlayPromise;
}

function buildContextPackQueryPlan(pending, extra = {}) {
  const overlayQuery = pending.overlayQuery ?? contextPackOverlayQueryFor(pending.query);
  return {
    rawQuery: pending.query,
    baseQuery: pending.baseQuery,
    overlayQuery,
    baseQueryFocused: pending.baseQueryFocused,
    maxFiles: pending.maxFiles,
    maxFilesWasDefaulted: pending.maxFilesWasDefaulted,
    baseMaxFiles: pending.baseMaxFiles,
    overlayLimit: pending.overlayLimit,
    contextTimeoutMs: CONTEXT_PACK_TIMEOUT_MS,
    overlayTimeoutMs: pending.overlayTimeoutMs ?? OVERLAY_QUERY_TIMEOUT_MS,
    overlayDeadlineRemainingMs: Number.isFinite(pending.overlayDeadlineMs)
      ? Math.max(0, pending.overlayDeadlineMs - Date.now())
      : null,
    overlayRecoveryGraceMs: CONTEXT_PACK_TIMEOUT_OVERLAY_GRACE_MS,
    ...extra,
  };
}

async function resolvePendingContextPackOverlay(internalId, pending) {
  if (!pending.overlayPromise) {
    startPendingContextPackOverlay(internalId);
  }
  return pending.overlayPromise;
}

async function resolvePendingContextPackOverlayForTimeout(internalId, pending) {
  const overlayPromise = resolvePendingContextPackOverlay(internalId, pending);
  const overlayDeadlineWaitMs = (pending.overlayDeadlineMs ?? pending.deadlineMs) - Date.now();
  const overlayRecoveryTimeoutMs = Math.max(
    1,
    overlayDeadlineWaitMs > 0
      ? overlayDeadlineWaitMs + CONTEXT_PACK_TIMEOUT_OVERLAY_GRACE_MS
      : CONTEXT_PACK_TIMEOUT_OVERLAY_GRACE_MS,
  );
  const timeoutSentinel = Symbol('context-pack-overlay-timeout');
  let timer = null;
  try {
    const result = await Promise.race([
      overlayPromise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(timeoutSentinel), overlayRecoveryTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result !== timeoutSentinel) {
      return {
        overlay: result,
        overlayRecoveryTimedOut: false,
        overlayRecoveryTimeoutMs,
      };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  void overlayPromise.catch(error => {
    diagnostics.log('nanoflow.context.overlay.late-error', {
      originalId: pending.originalId,
      internalId,
      ...requestTraceDiagnostics(pending.requestTrace),
      contextId: pending.contextId,
      query: pending.query,
      queryPlan: buildContextPackQueryPlan(pending),
      failureClass: 'overlay-wrapper-error',
      message: errorToMessage(error),
      stack: errorToStack(error),
      runtime: summarizeRuntimeState(),
    });
  });

  return {
    overlay: {
      isError: true,
      text: `NanoFlow overlay query timed out after ${overlayRecoveryTimeoutMs}ms while building the context pack.`,
      data: null,
      diagnostics: {
        failureClass: 'overlay-timeout',
      },
    },
    overlayRecoveryTimedOut: true,
    overlayRecoveryTimeoutMs,
  };
}

function failPendingContextPackForwarding(internalId, source) {
  const key = String(internalId);
  const pending = pendingContextPacks.get(key);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeoutTimer);
  pendingContextPacks.delete(key);
  diagnostics.log('nanoflow.context.forward.fail', {
    originalId: pending.originalId,
    internalId,
    ...requestTraceDiagnostics(pending.requestTrace),
    contextId: pending.contextId,
    query: pending.query,
    baseQuery: pending.baseQuery,
    overlayQuery: pending.overlayQuery,
    queryPlan: buildContextPackQueryPlan(pending),
    elapsedMs: Date.now() - pending.startedAtMs,
    failureClass: 'base-codegraph-unavailable',
    source,
    runtime: summarizeRuntimeState(),
    investigation: buildContextPackInvestigation('base-codegraph-unavailable'),
  });

  const failureClass = 'base-codegraph-unavailable';
  const text = 'Base CodeGraph child is restarting or unavailable. Retry after the wrapper logs child.restart or use the codegraph CLI fallback.';
  const failed = buildNanoFlowContextPackFailureResult({ text, failureClass });
  return writeJsonToClient({
    jsonrpc: '2.0',
    id: pending.originalId,
    result: failed.result,
  }, {
    source: 'nanoflow-context-pack',
    contextId: pending.contextId,
    failureClass,
  });
}

async function handleCodegraphContextPackResponse(message) {
  const pending = pendingContextPacks.get(String(message.id));
  pendingContextPacks.delete(String(message.id));
  if (!pending) {
    if (expiredContextPackIds.has(String(message.id))) {
      clearExpiredContextPackId(message.id);
      diagnostics.log('nanoflow.context.late-response', {
        internalId: message.id,
        hasError: Boolean(message.error),
        isError: Boolean(message?.result?.isError),
        runtime: summarizeRuntimeState(),
      });
      return;
    }
    diagnostics.log('nanoflow.context.missing-pending', { internalId: message.id });
    writeJsonToClient(message);
    return;
  }
  clearTimeout(pending.timeoutTimer);

  let baseText = '';
  let baseIsError = true;
  try {
    baseText = extractMcpText(message?.result?.content);
    baseIsError = Boolean(message?.result?.isError || message?.error);
    const baseElapsedMs = Date.now() - pending.startedAtMs;
    const overlayResult = await resolvePendingContextPackOverlayForTimeout(message.id, pending);
    const overlay = overlayResult.overlay;
    const overlayRecoveryTimedOut = overlayResult.overlayRecoveryTimedOut;
    const overlayRecoveryTimeoutMs = overlayResult.overlayRecoveryTimeoutMs;
    const overlayElapsedMs = pending.overlayStartedAtMs
      ? Date.now() - pending.overlayStartedAtMs
      : undefined;
    const totalElapsedMs = Date.now() - pending.startedAtMs;
    const pack = {
      schemaVersion: 1,
      query: pending.query,
      projectRoot,
      maxFiles: pending.maxFiles,
      maxFilesExplicit: !pending.maxFilesWasDefaulted,
      overlayLimit: pending.overlayLimit,
      baseCodegraph: {
        isError: baseIsError,
        text: message?.error ? JSON.stringify(message.error) : baseText,
      },
      nanoFlowOverlay: {
        isError: overlay.isError,
        data: overlay.data,
        matches: overlay.data?.matches ?? [],
        relationshipGroups: overlay.data?.relationshipGroups ?? {},
        nodes: overlay.data?.nodes ?? [],
        edges: overlay.data?.edges ?? [],
        coverage: overlay.data?.coverage ?? null,
        rawError: overlay.isError ? overlay.text : undefined,
      },
      nextSteps: [
        'Use codegraph_node or targeted file reads only for files named in this context pack.',
        'When changing Angular components, inspect templateUrl/styleUrls and tests listed in nanoFlowOverlay before editing.',
        'When changing Supabase sync or migrations, inspect riskTags and AGENTS hard rules before implementation.',
      ],
    };
    augmentContextPackIssueRegistryOverlay(pack.nanoFlowOverlay, pending.query);
    const qualityDiagnostics = {};
    const text = formatNanoFlowContextPackAsMarkdown(pack, qualityDiagnostics);
    const failureClass = pack.baseCodegraph.isError
      ? 'base-codegraph-error'
      : (pack.nanoFlowOverlay.isError ? (overlay.diagnostics?.failureClass ?? 'overlay-error') : 'success');
    const outcome = buildNanoFlowContextOutcomeV1({
      primaryFailureClass: failureClass === 'success' ? null : failureClass,
      base: {
        available: !pack.baseCodegraph.isError && baseText.trim().length > 0,
        isError: pack.baseCodegraph.isError,
        text: baseText,
      },
      overlay: {
        available: !pack.nanoFlowOverlay.isError,
        isError: pack.nanoFlowOverlay.isError,
        failureClass: pack.nanoFlowOverlay.isError ? failureClass : null,
        generationId: overlay.data?.generationId ?? null,
      },
    });
    const effectiveFailureClass = outcome.primaryFailureClass ?? 'success';
    const responseText = outcome.status === 'partial'
      && outcome.base.status === 'available'
      && outcome.overlay.status !== 'available'
      ? formatNanoFlowPartialContextAsMarkdown(
          baseText,
          pack.nanoFlowOverlay.rawError ?? failureClass,
        )
      : text;
    const baseResponseWarnings = summarizeMcpTextWarnings(baseText);
    const responseWarnings = mergeMcpTextWarnings(
      baseResponseWarnings,
      summarizeMcpTextWarnings(responseText),
    );
    const runtime = summarizeRuntimeState();
    const responseRootCauseSnapshot = effectiveFailureClass === 'success'
      ? undefined
      : buildRootCauseSnapshot(runtime);
    const queryClassification = summarizeContextPackQueryClassification(pending.query);
    diagnostics.log('nanoflow.context.response', {
      originalId: pending.originalId,
      internalId: message.id,
      ...requestTraceDiagnostics(pending.requestTrace),
      contextId: pending.contextId,
      outputMode: WRAPPER_OUTPUT_MODES.contextPack,
      query: pending.query,
      baseQuery: pending.baseQuery,
      baseQueryFocused: pending.baseQueryFocused,
      overlayQuery: pending.overlayQuery,
      queryClassification,
      maxFiles: pending.maxFiles,
      maxFilesWasDefaulted: pending.maxFilesWasDefaulted,
      baseMaxFiles: pending.baseMaxFiles,
      overlayLimit: pending.overlayLimit,
      queryPlan: buildContextPackQueryPlan(pending, {
        deadlineRemainingMs: Math.max(0, pending.deadlineMs - Date.now()),
        overlayRecoveryTimedOut,
        overlayRecoveryTimeoutMs,
      }),
      textBytes: Buffer.byteLength(responseText, 'utf8'),
      textStartsWithJson: responseText.trimStart().startsWith('{'),
      baseResponse: summarizeMcpResponse(message),
      baseResponseWarnings,
      responseWarnings,
      baseTextDiagnostics: qualityDiagnostics.baseTextDiagnostics,
      rawBaseTextDiagnostics: qualityDiagnostics.rawBaseTextDiagnostics,
      baseSectionFiltering: qualityDiagnostics.baseSectionFiltering,
      sourceSelection: qualityDiagnostics.sourceSelection,
      baseIsError: pack.baseCodegraph.isError,
      overlayIsError: pack.nanoFlowOverlay.isError,
      outcome,
      outcomeSchemaVersion: outcome.schemaVersion,
      outcomeStatus: outcome.status,
      contextUsable: outcome.usableContext,
      failureClass: effectiveFailureClass,
      baseElapsedMs,
      overlayElapsedMs,
      overlayRecoveryTimedOut,
      overlayRecoveryTimeoutMs,
      totalElapsedMs,
      overlayQueryId: overlay.diagnostics?.queryId,
      overlayMatchCount: pack.nanoFlowOverlay.matches.length,
      overlayNodeCount: pack.nanoFlowOverlay.nodes.length,
      overlayEdgeCount: pack.nanoFlowOverlay.edges.length,
      overlayRelationshipGroupCount: Object.keys(pack.nanoFlowOverlay.relationshipGroups ?? {}).length,
      sourceOrdering: summarizeContextPackSourceOrdering(
        responseText,
        pending.query,
        contextPackSourceEvidenceNodesForOverlay(pack.nanoFlowOverlay),
        pack.nanoFlowOverlay.matches,
      ),
      investigation: buildContextPackInvestigation(effectiveFailureClass),
      rootCauseSnapshot: responseRootCauseSnapshot,
      runtime,
    });

    const result = buildNanoFlowContextPackToolResult(responseText, outcome, effectiveFailureClass);
    writeJsonToClient({
      jsonrpc: '2.0',
      id: pending.originalId,
      result,
    }, {
      source: 'nanoflow-context-pack',
      contextId: pending.contextId,
      overlayQueryId: overlay.diagnostics?.queryId,
      failureClass: effectiveFailureClass,
      rootCauseSnapshot: responseRootCauseSnapshot,
    });
  } catch (error) {
    const runtime = summarizeRuntimeState();
    diagnostics.log('nanoflow.context.error', {
      originalId: pending.originalId,
      internalId: message.id,
      ...requestTraceDiagnostics(pending.requestTrace),
      contextId: pending.contextId,
      query: pending.query,
      baseQuery: pending.baseQuery,
      overlayQuery: pending.overlayQuery,
      queryClassification: summarizeContextPackQueryClassification(pending.query),
      queryPlan: buildContextPackQueryPlan(pending),
      elapsedMs: Date.now() - pending.startedAtMs,
      failureClass: 'context-pack-error',
      message: errorToMessage(error),
      stack: errorToStack(error),
      investigation: buildContextPackInvestigation('context-pack-error'),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    const failureClass = 'context-pack-error';
    const errorText = errorToMessage(error);
    const responseText = !baseIsError && Buffer.byteLength(baseText, 'utf8') > 0
      ? formatNanoFlowPartialContextAsMarkdown(baseText, errorText)
      : [
          'NanoFlow context pack failed while combining base CodeGraph and overlay results.',
          '',
          errorText,
          '',
          'The MCP wrapper is still alive; retry a narrower query or use a native CodeGraph tool directly.',
        ].join('\n');
    const failed = buildNanoFlowContextPackFailureResult({
      text: responseText,
      failureClass,
      baseText,
      baseIsError,
      overlayFailureClass: failureClass,
    });
    writeJsonToClient({
      jsonrpc: '2.0',
      id: pending.originalId,
      result: failed.result,
    }, {
      source: 'nanoflow-context-pack',
      contextId: pending.contextId,
      failureClass: 'context-pack-error',
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    });
  }
}

function handleNanoFlowContextPackTimeout(internalId) {
  const key = String(internalId);
  const pending = pendingContextPacks.get(key);
  if (!pending) {
    return;
  }

  pendingContextPacks.delete(key);
  rememberExpiredContextPackId(key, 'base-codegraph-timeout');

  void handleNanoFlowContextPackTimeoutResponse(internalId, pending);
}

async function handleNanoFlowContextPackTimeoutResponse(internalId, pending) {
  let overlay = null;
  let overlayRecoveryTimedOut = false;
  let overlayRecoveryTimeoutMs = CONTEXT_PACK_TIMEOUT_OVERLAY_GRACE_MS;
  try {
    const overlayResult = await resolvePendingContextPackOverlayForTimeout(internalId, pending);
    overlay = overlayResult.overlay;
    overlayRecoveryTimedOut = overlayResult.overlayRecoveryTimedOut;
    overlayRecoveryTimeoutMs = overlayResult.overlayRecoveryTimeoutMs;
  } catch (error) {
    overlay = {
      isError: true,
      text: errorToMessage(error),
      data: null,
      diagnostics: {
        failureClass: 'overlay-wrapper-error',
      },
    };
  }

  const overlaySucceeded = overlay && !overlay.isError;
  const pack = {
    schemaVersion: 1,
    query: pending.query,
    projectRoot,
    maxFiles: pending.maxFiles,
    maxFilesExplicit: !pending.maxFilesWasDefaulted,
    overlayLimit: pending.overlayLimit,
    baseCodegraph: {
      isError: true,
      text: '',
      rawError: `NanoFlow context pack timed out waiting for base CodeGraph after ${CONTEXT_PACK_TIMEOUT_MS}ms.`,
    },
    nanoFlowOverlay: {
      isError: !overlaySucceeded,
      data: overlay?.data,
      matches: overlay?.data?.matches ?? [],
      relationshipGroups: overlay?.data?.relationshipGroups ?? {},
      nodes: overlay?.data?.nodes ?? [],
      edges: overlay?.data?.edges ?? [],
      coverage: overlay?.data?.coverage ?? null,
      rawError: overlay?.isError ? overlay.text : undefined,
    },
    nextSteps: [
      'Base CodeGraph timed out before returning source; use the overlay relationships below as partial context.',
      'Retry with a narrower query or maxFiles=1 when full base CodeGraph source is required.',
      'Use nanoflow_overlay_query --skip-refresh for focused NanoFlow semantic checks.',
    ],
  };
  augmentContextPackIssueRegistryOverlay(pack.nanoFlowOverlay, pending.query);
  const qualityDiagnostics = {};
  const text = formatNanoFlowContextPackAsMarkdown(pack, qualityDiagnostics);
  const failureClass = overlaySucceeded
    ? 'base-codegraph-timeout-overlay-only'
    : 'base-codegraph-timeout';
  const overlayFailureClass = overlaySucceeded
    ? null
    : (overlay?.diagnostics?.failureClass ?? 'overlay-error');
  const failed = buildNanoFlowContextPackFailureResult({
    text,
    failureClass,
    overlayAvailable: overlaySucceeded,
    overlayFailureClass,
    overlayGenerationId: overlay?.data?.generationId ?? null,
  });
  const elapsedMs = Date.now() - pending.startedAtMs;
  const overlayElapsedMs = pending.overlayStartedAtMs
    ? Date.now() - pending.overlayStartedAtMs
    : undefined;

  const runtime = summarizeRuntimeState();
  const queryClassification = summarizeContextPackQueryClassification(pending.query);
  diagnostics.log('nanoflow.context.timeout', {
    originalId: pending.originalId,
    internalId,
    ...requestTraceDiagnostics(pending.requestTrace),
      contextId: pending.contextId,
      query: pending.query,
      baseQuery: pending.baseQuery,
      overlayQuery: pending.overlayQuery,
    queryClassification,
    queryPlan: buildContextPackQueryPlan(pending, {
      deadlineRemainingMs: Math.max(0, pending.deadlineMs - Date.now()),
      overlayRecoveryTimedOut,
      overlayRecoveryTimeoutMs,
    }),
    elapsedMs,
    timeoutMs: CONTEXT_PACK_TIMEOUT_MS,
    overlayRecoveryTimedOut,
    overlayRecoveryTimeoutMs,
    failureClass,
    outcome: failed.outcome,
    outcomeSchemaVersion: failed.outcome.schemaVersion,
    outcomeStatus: failed.outcome.status,
    contextUsable: failed.outcome.usableContext,
    recoveredWithOverlayOnly: overlaySucceeded,
    textBytes: Buffer.byteLength(text, 'utf8'),
    textStartsWithJson: text.trimStart().startsWith('{'),
    baseTextDiagnostics: qualityDiagnostics.baseTextDiagnostics,
    rawBaseTextDiagnostics: qualityDiagnostics.rawBaseTextDiagnostics,
    baseSectionFiltering: qualityDiagnostics.baseSectionFiltering,
    overlayElapsedMs,
    overlayQueryId: overlay?.diagnostics?.queryId,
    overlayMatchCount: pack.nanoFlowOverlay.matches.length,
    overlayNodeCount: pack.nanoFlowOverlay.nodes.length,
    overlayEdgeCount: pack.nanoFlowOverlay.edges.length,
    overlayRelationshipGroupCount: Object.keys(pack.nanoFlowOverlay.relationshipGroups ?? {}).length,
    sourceSelection: qualityDiagnostics.sourceSelection,
    sourceOrdering: summarizeContextPackSourceOrdering(
      text,
      pending.query,
      contextPackSourceEvidenceNodesForOverlay(pack.nanoFlowOverlay),
      pack.nanoFlowOverlay.matches,
    ),
    investigation: buildContextPackInvestigation(failureClass),
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    runtime,
  });
  writeJsonToClient({
    jsonrpc: '2.0',
    id: pending.originalId,
    result: failed.result,
  }, {
    source: 'nanoflow-context-pack',
    contextId: pending.contextId,
    overlayQueryId: overlay?.diagnostics?.queryId,
    failureClass,
    rootCauseSnapshot: buildRootCauseSnapshot(runtime),
  });
}

function extractMcpText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n\n');
}

async function handleNanoFlowOverlayToolCall(message, requestTrace) {
  try {
    const args = message.params?.arguments ?? {};
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = args.limit === undefined ? 20 : args.limit;
    const requestedJson = args.json === true;
    const nativeJson = args.nativeJson === true;
    const nativeMarkdown = args.nativeMarkdown === true;

    if (!query) {
      writeInvalidParamsResponse(message.id, 'nanoflow_overlay_query requires a non-empty query string.');
      return;
    }

    const invalidOutputFlag = ['json', 'nativeJson', 'nativeMarkdown']
      .find(flag => args[flag] !== undefined && typeof args[flag] !== 'boolean');
    if (invalidOutputFlag) {
      writeInvalidParamsResponse(
        message.id,
        `nanoflow_overlay_query ${invalidOutputFlag} must be a boolean when provided.`,
      );
      return;
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      writeInvalidParamsResponse(message.id, 'nanoflow_overlay_query limit must be an integer between 1 and 100.');
      return;
    }

    if (nativeMarkdown && (requestedJson || nativeJson)) {
      writeInvalidParamsResponse(
        message.id,
        'nanoflow_overlay_query nativeMarkdown cannot be combined with json or nativeJson output modes.',
      );
      return;
    }

    const json = requestedJson || nativeJson;

    const overlay = await runNanoFlowOverlayQuery(query, String(limit), {
      json,
      nativeJson,
      nativeMarkdown,
      requestTrace,
    });
    const failureClass = overlay.diagnostics?.failureClass ?? (overlay.isError ? 'overlay-error' : 'success');
    const resultStats = summarizeOverlayToolResultStats(overlay.text, {
      jsonExpected: json,
      nativeJson,
      nativeMarkdown,
    });
    const runtime = summarizeRuntimeState();
    const responseRootCauseSnapshot = overlay.isError || failureClass !== 'success'
      ? buildRootCauseSnapshot(runtime)
      : undefined;
    diagnostics.log('nanoflow.overlay.response', {
      id: message.id,
      ...requestTraceDiagnostics(requestTrace),
      queryId: overlay.diagnostics?.queryId,
      outputMode: nativeJson
        ? WRAPPER_OUTPUT_MODES.nativeJson
        : (nativeMarkdown ? WRAPPER_OUTPUT_MODES.nativeMarkdown : (json ? WRAPPER_OUTPUT_MODES.contextOverlayQuery : WRAPPER_OUTPUT_MODES.overlayTool)),
      elapsedMs: overlay.diagnostics?.elapsedMs,
      textBytes: Buffer.byteLength(overlay.text, 'utf8'),
      textStartsWithJson: overlay.text.trimStart().startsWith('{'),
      isError: overlay.isError,
      failureClass,
      resultStats,
      investigation: buildOverlayInvestigation(failureClass),
      rootCauseSnapshot: responseRootCauseSnapshot,
      runtime,
    });

    writeJsonToClient({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: overlay.text }],
        isError: overlay.isError,
        _meta: {
          nanoflowFailureClass: failureClass,
        },
      },
    }, {
      source: 'nanoflow-overlay',
      queryId: overlay.diagnostics?.queryId,
      failureClass,
      rootCauseSnapshot: responseRootCauseSnapshot,
    });
  } catch (error) {
    const runtime = summarizeRuntimeState();
    diagnostics.log('nanoflow.overlay.error', {
      id: message.id,
      ...requestTraceDiagnostics(requestTrace),
      failureClass: 'overlay-wrapper-error',
      message: errorToMessage(error),
      stack: errorToStack(error),
      investigation: buildOverlayInvestigation('overlay-wrapper-error'),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    writeJsonToClient({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{
          type: 'text',
          text: [
            'NanoFlow overlay query failed inside the MCP wrapper.',
            '',
            errorToMessage(error),
            '',
            'The MCP wrapper is still alive; retry a narrower query or use a native CodeGraph tool directly.',
          ].join('\n'),
        }],
        isError: true,
      },
    }, {
      source: 'nanoflow-overlay',
      failureClass: 'overlay-wrapper-error',
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
    });
  }
}

function writeInvalidParamsResponse(id, message, source = 'nanoflow-overlay') {
  writeJsonToClient({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32602,
      message,
    },
  }, {
    source,
    failureClass: 'invalid-params',
  });
}

function runNanoFlowOverlayQuery(query, limit, options = {}) {
  const script = path.join(projectRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  const args = [script, '--root', projectRoot, '--query', query, '--limit', String(limit)];
  const queryId = `${diagnostics.runId}:overlay-${nextOverlayQueryId++}`;
  const startedAtMs = Date.now();
  const overlayFile = getOverlayFileDiagnostics(projectRoot);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : OVERLAY_QUERY_TIMEOUT_MS;
  const outputMode = options.nativeJson
    ? WRAPPER_OUTPUT_MODES.nativeJson
    : (options.nativeMarkdown
        ? WRAPPER_OUTPUT_MODES.nativeMarkdown
        : (options.contextJson
            ? WRAPPER_OUTPUT_MODES.contextOverlayQueryCompact
            : (options.json ? WRAPPER_OUTPUT_MODES.contextOverlayQuery : WRAPPER_OUTPUT_MODES.overlayTool)));
  const jsonOutput = Boolean(options.json || options.contextJson || options.nativeJson);
  const requestTrace = options.requestTrace ?? null;
  const requestFields = requestTraceDiagnostics(requestTrace);
  if (options.contextJson) {
    args.push('--context-json');
  } else if (options.json) {
    args.push('--json');
  }
  if (options.skipRefresh !== false) {
    args.push('--skip-refresh');
  }
  if (options.nativeJson) {
    args.push('--native-json');
  }
  if (options.nativeMarkdown) {
    args.push('--native-markdown');
  }

  diagnostics.log('overlay.query.start', {
    queryId,
    ...requestFields,
    contextId: options.contextId,
    query,
    limit,
    script,
    args,
    cwd: path.dirname(projectRoot),
    startedAtMs,
    overlayFile,
    json: jsonOutput,
    contextJson: Boolean(options.contextJson),
    nativeJson: Boolean(options.nativeJson),
    nativeMarkdown: Boolean(options.nativeMarkdown),
    outputMode,
    timeoutMs,
    maxBufferBytes: OVERLAY_QUERY_MAX_BUFFER_BYTES,
    runtime: summarizeRuntimeState(),
  });

  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      NANOFLOW_OVERLAY_QUERY_PROFILE: process.env.NANOFLOW_OVERLAY_QUERY_PROFILE ?? '1',
      NANOFLOW_OVERLAY_SKIP_REFRESH: process.env.NANOFLOW_OVERLAY_SKIP_REFRESH ?? '1',
    };
    const overlayChild = spawn(process.execPath, args, {
      cwd: path.dirname(projectRoot),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    diagnostics.log('overlay.query.spawn', {
      queryId,
      ...requestFields,
      contextId: options.contextId,
      query,
      limit,
      pid: overlayChild.pid,
      node: process.execPath,
      cwd: path.dirname(projectRoot),
      args,
      overlayFile,
      env: pickEnv(childEnv, [
        'NANOFLOW_OVERLAY_QUERY_PROFILE',
        'NANOFLOW_OVERLAY_SKIP_REFRESH',
        'NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP',
      ]),
      runtime: summarizeRuntimeState(),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let timeoutMessage = null;
    let killGraceTimer = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutMessage = `NanoFlow overlay query timed out after ${timeoutMs}ms.`;
      const runtime = summarizeRuntimeState();
      diagnostics.log('overlay.query.timeout', {
        queryId,
        ...requestFields,
        contextId: options.contextId,
        query,
        limit,
        pid: overlayChild.pid,
        startedAtMs,
        elapsedMs: Date.now() - startedAtMs,
        timeoutMs,
        failureClass: 'overlay-timeout',
        outputMode,
        overlayFile,
        jsonExpected: jsonOutput,
        investigation: buildOverlayInvestigation('overlay-timeout'),
        rootCauseSnapshot: buildRootCauseSnapshot(runtime),
        runtime,
        ...summarizeOverlayProcessBuffers(stdout, stderr),
      });
      terminateProcessTree(overlayChild.pid, overlayChild);
      if (options.settleOnTimeout === true) {
        settle({
          status: null,
          signal: 'timeout',
          error: new Error(timeoutMessage),
        });
        return;
      }
      killGraceTimer = setTimeout(() => {
        settle({
          status: null,
          signal: 'timeout',
          error: new Error(timeoutMessage),
        });
      }, OVERLAY_QUERY_KILL_GRACE_MS);
      killGraceTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    overlayChild.stdout?.setEncoding('utf8');
    overlayChild.stderr?.setEncoding('utf8');
    overlayChild.stdout?.on('data', chunk => {
      stdout += chunk;
      enforceOverlayOutputLimit();
    });
    overlayChild.stderr?.on('data', chunk => {
      stderr += chunk;
      enforceOverlayOutputLimit();
    });
    overlayChild.on('error', error => {
      settle({ status: null, signal: null, error });
    });
    overlayChild.on('exit', (status, signal) => {
      settle({ status, signal, error: null });
    });

    function enforceOverlayOutputLimit() {
      if (outputLimitExceeded) {
        return;
      }

      const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(stderr, 'utf8');
      if (stdoutBytes + stderrBytes <= OVERLAY_QUERY_MAX_BUFFER_BYTES) {
        return;
      }

      outputLimitExceeded = true;
      const runtime = summarizeRuntimeState();
      diagnostics.log('overlay.query.max-buffer', {
        queryId,
        ...requestFields,
        contextId: options.contextId,
        query,
        limit,
        pid: overlayChild.pid,
        startedAtMs,
        elapsedMs: Date.now() - startedAtMs,
        failureClass: 'overlay-max-buffer',
        outputMode,
        overlayFile,
        jsonExpected: jsonOutput,
        investigation: buildOverlayInvestigation('overlay-max-buffer'),
        rootCauseSnapshot: buildRootCauseSnapshot(runtime),
        runtime,
        ...summarizeOverlayProcessBuffers(stdout, stderr),
        maxBufferBytes: OVERLAY_QUERY_MAX_BUFFER_BYTES,
      });
      terminateProcessTree(overlayChild.pid, overlayChild);
      settle({
        status: null,
        signal: 'max-buffer',
        error: new Error(`NanoFlow overlay query exceeded ${OVERLAY_QUERY_MAX_BUFFER_BYTES} bytes of output.`),
      });
    }

    function settle({ status, signal, error }) {
      if (settled) {
        diagnostics.log('overlay.query.child.exit.after-settle', {
          queryId,
          ...requestFields,
          contextId: options.contextId,
          query,
          limit,
          pid: overlayChild.pid,
          status,
          signal,
          elapsedMs: Date.now() - startedAtMs,
          error: error?.message,
          failureClass: classifyOverlayQueryFailure({
            status,
            signal,
            error,
            timedOut,
            outputLimitExceeded,
            stderr,
          }),
          outputMode,
          timedOut,
          outputLimitExceeded,
          runtime: summarizeRuntimeState(),
        });
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (killGraceTimer) {
        clearTimeout(killGraceTimer);
        killGraceTimer = null;
      }
      const elapsedMs = Date.now() - startedAtMs;
      const processSummary = summarizeOverlayProcessBuffers(stdout, stderr);
      const effectiveError = error
        ?? (timedOut ? new Error(timeoutMessage) : null)
        ?? (outputLimitExceeded ? new Error(`NanoFlow overlay query exceeded ${OVERLAY_QUERY_MAX_BUFFER_BYTES} bytes of output.`) : null);
      const rawText = status === 0
        ? stdout.trim()
        : (effectiveError?.message || stderr || stdout || 'NanoFlow overlay query failed.').trim();
      let data = null;
      let jsonParseOk = null;
      let jsonParseError = null;
      let jsonShapeError = null;
      const emptyJsonResponse = status === 0 && jsonOutput && rawText.length === 0;
      if (status === 0 && jsonOutput) {
        if (emptyJsonResponse) {
          jsonParseOk = false;
        } else {
          try {
            data = JSON.parse(rawText);
            jsonParseOk = true;
            jsonShapeError = validateOverlayJsonResponseShape(data, options);
          } catch (parseError) {
            jsonParseOk = false;
            jsonParseError = errorToMessage(parseError);
          }
        }
      }
      const failureClass = classifyOverlayQueryFailure({
        status,
        signal,
        error: effectiveError,
        timedOut,
        outputLimitExceeded,
        jsonOutput,
        jsonParseError,
        jsonShapeError,
        emptyJsonResponse,
        stderr,
      });
      const text = failureClass === OVERLAY_STALE_SKIP_REFRESH
        ? OVERLAY_STALE_SKIP_REFRESH
        : (failureClass === 'overlay-empty-response'
            ? 'NanoFlow overlay query returned no text content.'
            : rawText);
      const isError = status !== 0 || failureClass !== 'success';
      const runtime = summarizeRuntimeState();
      const resultStats = summarizeOverlayToolResultStats(stdout, {
        jsonExpected: jsonOutput,
        nativeJson: options.nativeJson === true,
        nativeMarkdown: options.nativeMarkdown === true,
      });
      diagnostics.log('overlay.query.exit', {
        queryId,
        ...requestFields,
        contextId: options.contextId,
        query,
        limit,
        pid: overlayChild.pid,
        startedAtMs,
        elapsedMs,
        status,
        signal,
        error: effectiveError?.message,
        timedOut,
        outputLimitExceeded,
        failureClass,
        jsonExpected: jsonOutput,
        jsonParseOk,
        jsonParseError,
        jsonShapeError,
        outputMode,
        overlayFile,
        stderr: stderr.trimEnd(),
        resultStats,
        investigation: buildOverlayInvestigation(failureClass),
        rootCauseSnapshot: failureClass === 'success' ? undefined : buildRootCauseSnapshot(runtime),
        runtime,
        ...processSummary,
      });

      resolve({
        isError,
        text,
        data,
        diagnostics: {
          queryId,
          pid: overlayChild.pid,
          startedAtMs,
          elapsedMs,
          outputMode,
          timedOut,
          outputLimitExceeded,
          failureClass,
          jsonExpected: jsonOutput,
          jsonParseOk,
          jsonParseError,
          overlayFile,
          ...processSummary,
        },
      });
    }
  });
}

function summarizeOverlayToolResultStats(text, {
  jsonExpected = false,
  nativeJson = false,
  nativeMarkdown = false,
} = {}) {
  const rawText = String(text ?? '');
  const trimmed = rawText.trim();
  const markdownStats = summarizeOverlayMarkdownResultStats(rawText);
  const stats = {
    outputFormat: jsonExpected ? 'json' : 'markdown',
    nativeJson: Boolean(nativeJson),
    nativeMarkdown: Boolean(nativeMarkdown),
    textBytes: Buffer.byteLength(rawText, 'utf8'),
    textLineCount: rawText ? rawText.split(/\r?\n/).length : 0,
    textStartsWithJson: trimmed.startsWith('{'),
    parsedJson: false,
    parseError: null,
    query: null,
    count: null,
    matchCount: null,
    nodeCount: null,
    edgeCount: null,
    codeBlockCount: null,
    relatedFileCount: null,
    relationshipGroupCount: null,
    relationshipEdgeCount: null,
    markdownBytes: null,
    ...markdownStats,
  };

  if (!trimmed.startsWith('{')) {
    return stats;
  }

  try {
    const json = JSON.parse(trimmed);
    const relationshipGroups = json?.relationshipGroups && typeof json.relationshipGroups === 'object'
      ? json.relationshipGroups
      : {};
    const relationshipGroupEntries = Object.values(relationshipGroups);
    const relationshipEdgeCount = relationshipGroupEntries.reduce(
      (total, group) => total + (Array.isArray(group) ? group.length : 0),
      0,
    );
    return {
      ...stats,
      parsedJson: true,
      query: typeof json?.query === 'string' ? json.query : null,
      count: Number.isFinite(Number(json?.count)) ? Number(json.count) : null,
      matchCount: Array.isArray(json?.matches) ? json.matches.length : null,
      nodeCount: Array.isArray(json?.nodes) ? json.nodes.length : null,
      edgeCount: Array.isArray(json?.edges) ? json.edges.length : null,
      codeBlockCount: Array.isArray(json?.codeBlocks) ? json.codeBlocks.length : null,
      relatedFileCount: Array.isArray(json?.relatedFiles) ? json.relatedFiles.length : null,
      relationshipGroupCount: relationshipGroupEntries.length,
      relationshipEdgeCount,
      markdownBytes: typeof json?.markdown === 'string' ? Buffer.byteLength(json.markdown, 'utf8') : null,
      ...summarizeOverlayMarkdownResultStats(typeof json?.markdown === 'string' ? json.markdown : rawText),
    };
  } catch (error) {
    return {
      ...stats,
      parseError: errorToMessage(error).slice(0, 500),
    };
  }
}

function summarizeOverlayMarkdownResultStats(text) {
  const rawText = String(text ?? '');
  const sourceFiles = extractContextPackSourceBlockFiles(rawText);
  const relationshipsSectionCount = countContextPackMarkdownSectionHeadings(rawText, 'Relationships');
  const relatedSymbolsSectionCount = countContextPackMarkdownSectionHeadings(rawText, 'Related Symbols');
  const relationshipKindSectionCounts = countContextPackRelationshipKindSections(rawText);
  return {
    hasEntryPointsSection: /(^|\n)(?:### Entry Points\b|\*\*Entry Points\*\*)/.test(rawText),
    hasRelationshipsSection: relationshipsSectionCount > 0,
    hasRelatedSymbolsSection: relatedSymbolsSectionCount > 0,
    hasSourceCodeSection: /(^|\n)(?:### (?:Source Code|Code)\b|\*\*Source Code\*\*)/.test(rawText),
    relationshipsSectionCount,
    duplicateRelationshipsSectionCount: Math.max(0, relationshipsSectionCount - 1),
    relationshipKindSectionCounts,
    duplicateRelationshipKindSectionCount: duplicateContextPackRelationshipKindSectionCount(relationshipKindSectionCounts),
    relatedSymbolsSectionCount,
    duplicateRelatedSymbolsSectionCount: Math.max(0, relatedSymbolsSectionCount - 1),
    sourceSectionCount: countContextPackSourceSections(rawText),
    sourceBlockCount: sourceFiles.length,
    firstSourceFiles: sourceFiles.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    truncated: rawText.includes('output truncated to budget'),
  };
}

function buildOverlayInvestigation(failureClass) {
  const likelyRootCauseByClass = {
    success: 'overlay subprocess completed',
    'overlay-timeout': 'overlay subprocess exceeded its deadline; inspect profilePhases, stderrTail, and overlayFile age before increasing timeouts',
    'overlay-max-buffer': 'overlay subprocess produced more output than the wrapper buffer budget',
    'overlay-json-parse': 'overlay subprocess exited successfully but stdout was not valid JSON for the requested output mode',
    'overlay-process-error': 'overlay subprocess failed to spawn or emitted a process error',
    [OVERLAY_STALE_SKIP_REFRESH]: 'skip-refresh rejected an overlay that is stale against current repository sources',
    'overlay-nonzero-exit': 'overlay subprocess exited non-zero; inspect stderrTail and profilePhases',
    'overlay-signal-exit': 'overlay subprocess exited from a signal',
    'overlay-wrapper-error': 'wrapper-side overlay handler threw before or after the subprocess result',
  };
  return {
    failureBoundary: 'overlay-subprocess',
    failureClass,
    transportShouldStayAlive: true,
    likelyRootCause: likelyRootCauseByClass[failureClass] ?? 'overlay failure class is not recognized',
    nextEvidence: [
      'requestId',
      'queryId',
      'failureClass',
      'profileMeta',
      'profilePhases',
      'lastProfilePhase',
      'stderrTail',
      'overlayFile',
      'runtime',
    ],
  };
}

function buildContextPackInvestigation(failureClass) {
  const failureBoundary = failureClass === 'base-codegraph-timeout'
    || failureClass === 'base-codegraph-timeout-overlay-only'
    || failureClass === 'base-codegraph-error'
    ? 'base-codegraph-child'
    : (failureClass === 'stale-wrapper-script'
        ? 'mcp-host-transport'
        : (failureClass?.startsWith('overlay-') ? 'overlay-subprocess' : 'context-pack-wrapper'));
  return {
    failureBoundary,
    failureClass,
    transportShouldStayAlive: true,
    nextEvidence: [
      'requestId',
      'contextId',
      'overlayQueryId',
      'baseElapsedMs',
      'overlayElapsedMs',
      'deadlineRemainingMs',
      'runtime',
    ],
  };
}

function buildWrapperShutdownCause(failureClass, runtime, extra = {}) {
  const activeRequestsAtShutdown = runtime?.activeRequestCount ?? 0;
  const expectedExit = failureClass === 'host-stdin-closed'
    || failureClass === 'host-stdout-closed'
    || failureClass === 'host-stderr-closed'
    || failureClass === 'host-signal'
    || failureClass === 'child-exit'
    || failureClass === 'stale-wrapper-script';
  return {
    failureClass,
    expectedExit,
    transportClosedBy: extra.transportClosedBy ?? transportClosedByForFailureClass(failureClass),
    streamEvent: extra.streamEvent,
    stream: extra.stream,
    activeRequestsAtShutdown,
    investigation: buildWrapperExitInvestigation(failureClass, runtime),
  };
}

function transportClosedByForFailureClass(failureClass) {
  if (failureClass === 'host-stdin-closed') return 'client-stdin';
  if (failureClass === 'host-stdout-closed') return 'client-stdout';
  if (failureClass === 'host-stderr-closed') return 'client-stderr';
  if (failureClass === 'host-signal') return 'process-signal';
  if (failureClass === 'child-process-error' || failureClass === 'child-exit') return 'base-codegraph-child';
  if (failureClass === 'stale-wrapper-script') return 'wrapper-script-stale';
  return 'wrapper';
}

function buildWrapperExitInvestigation(failureClass, runtime = {}) {
  const activeRequests = runtime?.activeRequestCount ?? 0;
  const likelyRootCauseByClass = {
    'host-stdin-closed': activeRequests > 0
      ? 'MCP host closed wrapper stdin while requests were still active; inspect activeRequests and preceding client.stdin.* events'
      : 'MCP host closed wrapper stdin after requests drained; Transport closed is an expected host shutdown, not a wrapper crash',
    'host-stdout-closed': activeRequests > 0
      ? 'MCP host closed wrapper stdout while responses could still be active; inspect activeRequests, client.stdout.error, and the host-side transport close'
      : 'MCP host closed wrapper stdout after requests drained; Transport closed is an expected host transport shutdown, not a wrapper crash',
    'host-stderr-closed': 'MCP host closed wrapper stderr diagnostic stream; wrapper records the stderr pipe error so stdout transport behavior can be judged separately',
    'host-signal': 'wrapper received a process signal from the host or OS',
    'child-process-error': 'base CodeGraph child failed to spawn or emitted a process error',
    'child-exit': 'base CodeGraph child exited while wrapper was already shutting down',
    'stale-wrapper-script': 'wrapper script changed on disk while this long-lived MCP process was still active; wrapper exits after the current response so the MCP host can reconnect to the fresh script',
  };
  const failureBoundary = failureClass === 'host-stdin-closed'
    || failureClass === 'host-stdout-closed'
    || failureClass === 'host-stderr-closed'
    || failureClass === 'host-signal'
    || failureClass === 'stale-wrapper-script'
    ? 'mcp-host-transport'
    : (failureClass === 'child-process-error' || failureClass === 'child-exit' ? 'base-codegraph-child' : 'wrapper-process');
  return {
    failureBoundary,
    failureClass,
    transportShouldStayAlive: !(failureClass === 'host-stdin-closed'
      || failureClass === 'host-stdout-closed'
      || failureClass === 'host-signal'
      || failureClass === 'stale-wrapper-script'),
    likelyRootCause: likelyRootCauseByClass[failureClass] ?? 'wrapper exit class is not recognized',
    nextEvidence: [
      'failureClass',
      'expectedExit',
      'transportClosedBy',
      'activeRequestsAtShutdown',
      'client.stdin.end',
      'client.stdin.close',
      'client.stdin.error',
      'client.stdout.error',
      'client.stderr.error',
      'child.exit',
      'runtime.activeRequests',
    ],
  };
}

function buildWrapperFatalInvestigation(failureClass, kind) {
  const likelyRootCause = kind === 'unhandledRejection'
    ? 'Unhandled Promise rejection escaped the wrapper request, child, or overlay subprocess boundary; inspect error.stack and the preceding request events'
    : 'Uncaught exception escaped the wrapper request, child, or overlay subprocess boundary; inspect error.stack and the preceding request events';
  return {
    failureBoundary: 'wrapper-process',
    failureClass,
    transportShouldStayAlive: false,
    likelyRootCause,
    nextEvidence: [
      'error.name',
      'error.message',
      'error.stack',
      'runtime.activeRequests',
      'runtime.pendingContextPackCount',
      'runtime.pendingToolsListCount',
      'client.message',
      'child.stderr',
      'overlay.query.exit',
    ],
  };
}

function buildWrapperRuntimeDiagnosticInvestigation(failureClass, likelyRootCause) {
  return {
    failureBoundary: 'wrapper-process',
    failureClass,
    transportShouldStayAlive: true,
    likelyRootCause,
    nextEvidence: [
      'warning.name',
      'warning.message',
      'warning.code',
      'warning.detail',
      'warning.stack',
      'runtime.activeRequests',
      'runtime.pendingContextPackCount',
      'runtime.pendingToolsListCount',
      'client.request.start',
      'child.stderr',
      'overlay.query.exit',
    ],
  };
}

function clientStdioFailureClass(stream) {
  if (stream === 'stdout') return 'host-stdout-closed';
  if (stream === 'stderr') return 'host-stderr-closed';
  return 'host-stdin-closed';
}

function isBenignClientStreamClose(error) {
  return error?.code === 'EPIPE'
    || error?.code === 'ERR_STREAM_DESTROYED'
    || error?.code === 'ECONNRESET';
}

function buildClientStdioErrorInvestigation(failureClass, stream, shouldShutdown) {
  const likelyRootCauseByStream = {
    stdin: 'The MCP host input pipe emitted an error; wrapper records the stream failure and shuts down because no more client requests can be trusted',
    stdout: 'The MCP host output pipe emitted an error; wrapper records the stream failure and shuts down because responses can no longer be delivered reliably',
    stderr: 'The MCP host diagnostic stderr pipe emitted an error; wrapper records the stream failure while keeping the main stdout transport separate',
  };
  return {
    failureBoundary: 'mcp-host-transport',
    failureClass,
    transportShouldStayAlive: !shouldShutdown,
    likelyRootCause: likelyRootCauseByStream[stream] ?? 'A wrapper stdio stream emitted an error; inspect stream, error.code, and host transport events',
    nextEvidence: [
      'stream',
      'error.name',
      'error.message',
      'error.code',
      'error.syscall',
      'error.stack',
      'benignStreamClose',
      'activeRequestsAtShutdown',
      'runtime.activeRequests',
      'wrapper.shutdown.client-stdio',
      'wrapper.exit',
    ],
  };
}

function buildWrapperStderrWriteInvestigation(failureClass, operation) {
  return {
    failureBoundary: 'mcp-host-stdio',
    failureClass,
    transportShouldStayAlive: true,
    likelyRootCause: 'The MCP host stderr diagnostic pipe rejected a wrapper diagnostic write; stdout remains the MCP response transport, so the wrapper records the stderr failure and keeps serving',
    nextEvidence: [
      'operation',
      'bytes',
      'textTail',
      'error.name',
      'error.message',
      'error.code',
      'error.stack',
      'child.stderr',
      'client.stderr.forward.error',
      'client.stderr.write.error',
      'runtime.activeRequests',
      operation,
    ].filter(Boolean),
  };
}

function buildClientInvalidHeaderInvestigation() {
  return {
    failureBoundary: 'mcp-client-input',
    failureClass: 'client-invalid-header',
    transportShouldStayAlive: false,
    likelyRootCause: 'The MCP client sent a Content-Length header that could not be parsed; the wrapper closes the transport after preserving protocol and runtime diagnostics',
    nextEvidence: [
      'client.header.invalid.headerPreview',
      'client.header.invalid.rootCauseSnapshot',
      'wrapper.runtime.diagnostic',
      'wrapper.exit',
      'runtime.clientMode',
      'runtime.stdinBufferBytes',
      'runtime.activeRequests',
    ],
  };
}

function summarizeRuntimeStateSafely() {
  try {
    return summarizeRuntimeState();
  } catch (error) {
    return {
      summaryError: serializeDiagnosticError(error),
    };
  }
}

function serializeDiagnosticError(error, depth = 0) {
  if (error instanceof Error) {
    const serialized = {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      path: error.path,
      detail: error.detail,
    };
    if (error.cause !== undefined && depth < 2) {
      serialized.cause = serializeDiagnosticError(error.cause, depth + 1);
    }
    const extra = serializeDiagnosticObjectProperties(error, new Set(Object.keys(serialized)));
    if (Object.keys(extra).length > 0) {
      serialized.properties = extra;
    }
    return serialized;
  }
  if (error && typeof error === 'object') {
    return {
      name: error.constructor?.name ?? 'object',
      message: safeStringifyDiagnosticValue(error),
      stack: undefined,
      code: error.code,
      properties: serializeDiagnosticObjectProperties(error),
    };
  }
  return {
    name: typeof error,
    message: String(error),
    stack: undefined,
    code: undefined,
  };
}

function serializeDiagnosticObjectProperties(value, excludedKeys = new Set()) {
  const properties = {};
  if (!value || typeof value !== 'object') {
    return properties;
  }
  for (const key of Object.keys(value).sort()) {
    if (excludedKeys.has(key)) {
      continue;
    }
    const propertyValue = value[key];
    if (propertyValue === undefined) {
      continue;
    }
    properties[key] = serializeDiagnosticPropertyValue(propertyValue);
  }
  return properties;
}

function serializeDiagnosticPropertyValue(value) {
  if (value instanceof Error) {
    return serializeDiagnosticError(value, 1);
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => serializeDiagnosticPropertyValue(item));
  }
  if (typeof value === 'object') {
    return safeStringifyDiagnosticValue(value);
  }
  return String(value);
}

function safeStringifyDiagnosticValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeOverlayProcessBuffers(stdout, stderr) {
  const stdoutTrimmed = stdout.trimStart();
  const stderrLines = stderr.split(/\r?\n/).filter(Boolean);
  const stdoutLines = stdout.split(/\r?\n/).filter(Boolean);
  return {
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stderrTail: stderr.slice(-4000),
    stdoutPreview: stdout.slice(0, 500),
    stdoutStartsWithJson: stdoutTrimmed.startsWith('{') || stdoutTrimmed.startsWith('['),
    stdoutLineCount: stdoutLines.length,
    stderrLineCount: stderrLines.length,
    ...extractOverlayProfileDiagnostics(stderrLines),
  };
}

function extractOverlayProfileDiagnostics(stderrLines) {
  const profilePhases = [];
  let profileMeta = null;
  const profileParseErrors = [];

  for (const line of stderrLines) {
    if (!line.includes('nanoflow.overlay.profile')) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      profileParseErrors.push({
        message: errorToMessage(error),
        line: line.slice(0, 500),
      });
      continue;
    }

    if (parsed?.event === 'nanoflow.overlay.profile.meta') {
      profileMeta = parsed;
      continue;
    }

    if (parsed?.event === 'nanoflow.overlay.profile') {
      profilePhases.push({
        phase: parsed.phase,
        elapsedMs: parsed.elapsedMs,
        pid: parsed.pid,
      });
    }
  }

  const diagnostics = {
    stderrProfileCount: profilePhases.length,
    profilePhases,
    lastProfilePhase: profilePhases.at(-1) ?? null,
  };
  if (profileMeta) {
    diagnostics.profileMeta = profileMeta;
  }
  if (profileParseErrors.length > 0) {
    diagnostics.profileParseErrors = profileParseErrors;
  }
  return diagnostics;
}

function getOverlayFileDiagnostics(root) {
  const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
  const relativePath = path.relative(root, currentPath).split(path.sep).join('/');
  try {
    const stat = fs.statSync(currentPath);
    const nowMs = Date.now();
    return {
      path: currentPath,
      relativePath,
      exists: true,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ageMs: Math.max(0, nowMs - stat.mtimeMs),
      isFile: stat.isFile(),
    };
  } catch (error) {
    return {
      path: currentPath,
      relativePath,
      exists: false,
      error: errorToMessage(error),
    };
  }
}

function escapeContextPackRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesContextPackMarkdownSectionHeading(line, sectionName) {
  const trimmed = String(line ?? '').trim();
  const escaped = escapeContextPackRegExp(sectionName);
  return new RegExp(`^###\\s+${escaped}\\b`).test(trimmed)
    || new RegExp(`^\\*\\*${escaped}\\*\\*$`).test(trimmed);
}

function isContextPackMajorMarkdownHeading(line) {
  const trimmed = String(line ?? '').trim();
  return /^#{2,4}\s+(?:Exploration:|Code Context\b|Entry Points\b|Blast radius\b|Relationships\b|Related Symbols\b|Source Code\b|Code\b|NanoFlow Coverage\b|Next Steps\b)/.test(trimmed)
    || /^\*\*(?:Exploration:|Code Context|Entry Points|Blast radius\b.*|Relationships|Related Symbols|Source Code|Code|Next Steps)\*\*$/.test(trimmed);
}

function normalizeContextPackInsertedSectionLines(contentLines) {
  const lines = [...contentLines];
  while (lines.length > 0 && String(lines[0] ?? '').trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && String(lines.at(-1) ?? '').trim() === '') {
    lines.pop();
  }
  return lines.length > 0 ? ['', ...lines, ''] : [];
}

function insertContextPackSectionContent(text, sectionName, contentLines) {
  const lines = String(text ?? '').split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => matchesContextPackMarkdownSectionHeading(line, sectionName));
  if (sectionIndex < 0) {
    return null;
  }
  const insertAt = lines.findIndex((line, index) => (
    index > sectionIndex
    && isContextPackMajorMarkdownHeading(line)
  ));
  const insertionIndex = insertAt >= 0 ? insertAt : lines.length;
  const insertion = normalizeContextPackInsertedSectionLines(contentLines);
  if (insertion.length === 0) {
    return text;
  }
  return [
    ...lines.slice(0, insertionIndex),
    ...insertion,
    ...lines.slice(insertionIndex),
  ].join('\n').trim();
}

function contextPackRelationshipSubsectionKind(line) {
  const match = String(line ?? '').trim().match(/^\*\*([^*:][^*]*):\*\*$/);
  return match ? match[1].trim().toLowerCase() : null;
}

function countContextPackRelationshipKindSections(text) {
  const counts = {};
  const lines = String(text ?? '').split(/\r?\n/);
  let inRelationshipsSection = false;
  for (const line of lines) {
    if (matchesContextPackMarkdownSectionHeading(line, 'Relationships')) {
      inRelationshipsSection = true;
      continue;
    }
    if (inRelationshipsSection && isContextPackMajorMarkdownHeading(line)) {
      inRelationshipsSection = false;
    }
    if (!inRelationshipsSection) {
      continue;
    }
    const kind = contextPackRelationshipSubsectionKind(line);
    if (kind) {
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return counts;
}

function duplicateContextPackRelationshipKindSectionCount(counts) {
  return Object.values(counts ?? {}).reduce((total, count) => {
    const numericCount = Number(count);
    return total + Math.max(0, Number.isFinite(numericCount) ? numericCount - 1 : 0);
  }, 0);
}

function trimContextPackBlankLines(lines) {
  const result = [...lines];
  while (result.length > 0 && String(result[0] ?? '').trim() === '') {
    result.shift();
  }
  while (result.length > 0 && String(result.at(-1) ?? '').trim() === '') {
    result.pop();
  }
  return result;
}

function splitContextPackRelationshipLineGroups(contentLines) {
  const groups = [];
  const prefix = [];
  let currentGroup = null;
  for (const line of trimContextPackBlankLines(contentLines)) {
    const kind = contextPackRelationshipSubsectionKind(line);
    if (kind) {
      currentGroup = {
        kind,
        heading: line,
        body: [],
      };
      groups.push(currentGroup);
      continue;
    }
    if (currentGroup) {
      currentGroup.body.push(line);
    } else {
      prefix.push(line);
    }
  }
  return {
    prefix: trimContextPackBlankLines(prefix),
    groups: groups.map(group => ({
      ...group,
      body: trimContextPackBlankLines(group.body),
    })),
  };
}

function contextPackSectionEndIndex(lines, sectionIndex) {
  const insertAt = lines.findIndex((line, index) => (
    index > sectionIndex
    && isContextPackMajorMarkdownHeading(line)
  ));
  return insertAt >= 0 ? insertAt : lines.length;
}

function contextPackContentEndBeforeTrailingBlanks(lines, startIndex, endIndex) {
  let index = endIndex;
  while (index > startIndex && String(lines[index - 1] ?? '').trim() === '') {
    index--;
  }
  return index;
}

function findContextPackRelationshipSubsection(lines, startIndex, endIndex, kind) {
  for (let index = startIndex; index < endIndex; index++) {
    if (contextPackRelationshipSubsectionKind(lines[index]) === kind) {
      return index;
    }
  }
  return -1;
}

function contextPackRelationshipSubsectionEnd(lines, headingIndex, sectionEndIndex) {
  const nextHeadingIndex = lines.findIndex((line, index) => (
    index > headingIndex
    && index < sectionEndIndex
    && contextPackRelationshipSubsectionKind(line)
  ));
  const endIndex = nextHeadingIndex >= 0 ? nextHeadingIndex : sectionEndIndex;
  return contextPackContentEndBeforeTrailingBlanks(lines, headingIndex + 1, endIndex);
}

function insertContextPackRelationshipContent(text, contentLines) {
  const lines = String(text ?? '').split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => matchesContextPackMarkdownSectionHeading(line, 'Relationships'));
  if (sectionIndex < 0) {
    return null;
  }

  const { prefix, groups } = splitContextPackRelationshipLineGroups(contentLines);
  if (groups.length === 0) {
    return insertContextPackSectionContent(text, 'Relationships', contentLines);
  }

  if (prefix.length > 0) {
    const sectionEndIndex = contextPackSectionEndIndex(lines, sectionIndex);
    const insertAt = contextPackContentEndBeforeTrailingBlanks(lines, sectionIndex + 1, sectionEndIndex);
    lines.splice(insertAt, 0, ...normalizeContextPackInsertedSectionLines(prefix));
  }

  for (const group of groups) {
    const sectionEndIndex = contextPackSectionEndIndex(lines, sectionIndex);
    const existingHeadingIndex = findContextPackRelationshipSubsection(
      lines,
      sectionIndex + 1,
      sectionEndIndex,
      group.kind,
    );

    if (existingHeadingIndex >= 0) {
      const groupEndIndex = contextPackRelationshipSubsectionEnd(lines, existingHeadingIndex, sectionEndIndex);
      const existingLines = new Set(lines
        .slice(existingHeadingIndex + 1, groupEndIndex)
        .map(line => String(line ?? '').trim())
        .filter(Boolean));
      const bodyLines = group.body.filter(line => {
        const trimmed = String(line ?? '').trim();
        return trimmed !== '' && !existingLines.has(trimmed);
      });
      if (bodyLines.length > 0) {
        lines.splice(groupEndIndex, 0, ...bodyLines);
      }
      continue;
    }

    const appendSectionEndIndex = contextPackSectionEndIndex(lines, sectionIndex);
    const appendAt = contextPackContentEndBeforeTrailingBlanks(
      lines,
      sectionIndex + 1,
      appendSectionEndIndex,
    );
    const groupLines = trimContextPackBlankLines([group.heading, ...group.body]);
    const insertion = [];
    if (appendAt > sectionIndex + 1 && String(lines[appendAt - 1] ?? '').trim() !== '') {
      insertion.push('');
    }
    insertion.push(...groupLines);
    if (
      appendAt < lines.length
      && String(lines[appendAt] ?? '').trim() !== ''
      && !isContextPackMajorMarkdownHeading(lines[appendAt])
    ) {
      insertion.push('');
    }
    lines.splice(appendAt, 0, ...insertion);
  }

  return lines.join('\n').trim();
}

function buildContextPackRelationshipLines(relationshipGroups, nodes, contextSourceFileRanks, sourceRankingQuery) {
  const lines = [];
  const relationshipEntries = Object.entries(relationshipGroups);
  if (relationshipEntries.length === 0) {
    lines.push('- No overlay relationships matched this query.', '');
    return lines;
  }
  for (const [kind, rawEdges] of relationshipEntries) {
    const edges = sortRelationshipEdgesForMarkdown(rawEdges, nodes, contextSourceFileRanks, sourceRankingQuery);
    lines.push(`**${kind}:**`);
    for (const edge of edges.slice(0, 20)) {
      const suffix = formatEdgeMetadata(edge);
      lines.push(`- ${edge.source} → ${edge.target}${suffix}`);
    }
    if (edges.length > 20) {
      lines.push(`- ... and ${edges.length - 20} more`);
    }
    lines.push('');
  }
  return lines;
}

function buildContextPackRelatedSymbolLines(nodes, matches, contextSourceFileRanks, sourceRankingQuery) {
  const lines = [];
  if (nodes.length > 0) {
    const relatedGroups = groupMarkdownRelatedNodesByFile(nodes, contextSourceFileRanks, sourceRankingQuery);
    if (relatedGroups.length > 0) {
      for (const [filePath, groupedNodes] of relatedGroups.slice(0, CONTEXT_PACK_RELATED_SYMBOL_FILE_LIMIT)) {
        const shownNodes = groupedNodes.slice(0, CONTEXT_PACK_RELATED_SYMBOLS_PER_FILE_LIMIT);
        const symbols = shownNodes
          .map(node => `${node.name}${node.startLine ? `:${node.startLine}` : ''}`)
          .join(', ');
        const omittedSymbols = groupedNodes.length - shownNodes.length;
        const suffix = omittedSymbols > 0 ? `, +${omittedSymbols} more` : '';
        lines.push(`- ${filePath}: ${symbols}${suffix}`);
      }
      const omittedFiles = relatedGroups.length - CONTEXT_PACK_RELATED_SYMBOL_FILE_LIMIT;
      if (omittedFiles > 0) {
        lines.push(`- ... and ${omittedFiles} more files`);
      }
      lines.push('');
    } else {
      lines.push('- No overlay symbols matched this query.', '');
    }
  } else if (matches.length === 0) {
    lines.push('- No overlay symbols matched this query.', '');
  } else {
    for (const match of matches) {
      lines.push(`- \`${match.kind}\` ${match.name} (${match.file})${formatMatchSummary(match)}`);
    }
    lines.push('');
  }
  return lines;
}

function formatNanoFlowPartialContextAsMarkdown(baseText, overlayErrorText) {
  const warning = '> **Partial NanoFlow context:** base CodeGraph context remains usable; the NanoFlow overlay is unavailable.';
  const contextText = String(baseText ?? '');
  const overlayErrorSection = `### NanoFlow Overlay Error\n\n${String(overlayErrorText ?? '').trim()}`;
  return `${warning}\n\n${contextText}\n\n${overlayErrorSection}`;
}

function formatNanoFlowContextPackAsMarkdown(pack, qualityDiagnostics = null) {
  const lines = [];
  const queryData = pack.nanoFlowOverlay.rawError ? null : {
    matches: pack.nanoFlowOverlay.matches ?? [],
    relationshipGroups: pack.nanoFlowOverlay.relationshipGroups ?? {},
    nodes: pack.nanoFlowOverlay.nodes ?? [],
    edges: pack.nanoFlowOverlay.edges ?? [],
    coverage: pack.nanoFlowOverlay.coverage ?? {},
  };
  const data = pack.nanoFlowOverlay.data ?? queryData;
  const sourceRankingQuery = contextPackSourceRankingQueryFor(pack.query);
  const budgetedEvidence = limitContextPackOverlayEvidence({
    relationshipGroups: data?.relationshipGroups
      ?? pack.nanoFlowOverlay.relationshipGroups
      ?? buildRelationshipGroupsFromMatches(pack.nanoFlowOverlay.matches ?? []),
    matches: data?.matches ?? pack.nanoFlowOverlay.matches ?? [],
    nodes: data?.nodes ?? pack.nanoFlowOverlay.nodes ?? [],
    codeBlocks: data?.codeBlocks ?? pack.nanoFlowOverlay.codeBlocks ?? [],
  }, pack.maxFiles, pack.maxFilesExplicit, sourceRankingQuery);
  const relationshipGroups = budgetedEvidence.relationshipGroups;
  const matches = budgetedEvidence.matches;
  const nodes = budgetedEvidence.nodes;
  const codeBlocks = budgetedEvidence.codeBlocks;
  const sourceEvidenceNodes = mergeContextPackSourceEvidenceNodes(nodes, codeBlocks);
  const coverage = data?.coverage ?? pack.nanoFlowOverlay.coverage ?? {};
  const rewrittenBaseText = rewriteContextPackExplorationHeading(
    pack.baseCodegraph.text?.trim(),
    pack.query,
  );
  const sourceVisibilityQuery = pack.query;
  const baseSectionFilteringResult = sanitizeContextPackBaseMarkdownSections(
    rewrittenBaseText,
    pack.query,
    sourceEvidenceNodes,
    matches,
  );
  const baseText = baseSectionFilteringResult.text;
  if (qualityDiagnostics && typeof qualityDiagnostics === 'object') {
    qualityDiagnostics.baseSectionFiltering = baseSectionFilteringResult.diagnostics;
    qualityDiagnostics.baseTextDiagnostics = summarizeContextPackMarkdownText(baseText);
    qualityDiagnostics.rawBaseTextDiagnostics = summarizeContextPackMarkdownText(rewrittenBaseText);
  }
  if (isPureNoHitContextPack({
    baseText,
    baseIsError: pack.baseCodegraph.isError,
    overlayIsError: pack.nanoFlowOverlay.isError,
    matches,
    nodes,
    codeBlocks,
    relationshipGroups,
  })) {
    return baseText || `## Exploration: ${pack.query}\n\nNo code context matched this query.`;
  }
  if (isWeakExplicitNoHitContextPack({
    query: pack.query,
    baseText,
    baseIsError: pack.baseCodegraph.isError,
    overlayIsError: pack.nanoFlowOverlay.isError,
    matches,
    nodes,
    codeBlocks,
    relationshipGroups,
  })) {
    return `## Exploration: ${pack.query}\n\nNo code context matched this query.`;
  }
  const sourceVisibilityQueryTerms = queryTokens(String(sourceVisibilityQuery ?? '').toLowerCase());
  const overlaySourceFileRankEntries = prioritizeContextPackPreferredSymbolEvidence(
    rankContextPackSourceFileEntries(sourceEvidenceNodes, sourceRankingQuery, matches),
    sourceVisibilityQuery,
    sourceVisibilityQueryTerms,
  );
  const overlaySourceFileRanks = new Map(overlaySourceFileRankEntries
    .map((entry, index) => [entry.normalizedFilePath, index]));
  const contextSourceFileRankEntries = prioritizeContextPackPreferredSymbolEvidence(
    baseText
      ? rankContextPackSourceFileEntriesForContextText(baseText, sourceEvidenceNodes, sourceRankingQuery, matches)
      : rankContextPackSourceFileEntries(sourceEvidenceNodes, sourceRankingQuery, matches),
    sourceVisibilityQuery,
    sourceVisibilityQueryTerms,
  );
  const contextSourceFileRanks = new Map(contextSourceFileRankEntries
    .map((entry, index) => [entry.normalizedFilePath, index]));
  const prioritizedBaseText = baseText
    ? prioritizeContextPackBaseSourceBlocks(baseText, contextSourceFileRanks, pack.query, contextSourceFileRankEntries)
    : '';
  const overlaySourceBlocks = buildContextPackOverlaySourceBlocks(
    sourceEvidenceNodes,
    prioritizedBaseText,
    sourceVisibilityQuery,
    matches,
    overlaySourceFileRanks,
    pack.query,
  ).slice(0, normalizeContextPackFileBudget(pack.maxFiles, pack.maxFilesExplicit));
  const injectedBaseText = prioritizedBaseText
    ? injectContextPackOverlaySourceBlocks(prioritizedBaseText, overlaySourceBlocks)
    : '';
  const overlaySourceBlocksInjected = Boolean(prioritizedBaseText)
    && overlaySourceBlocks.length > 0
    && injectedBaseText !== prioritizedBaseText;
  let orderedInjectedBaseText = overlaySourceBlocksInjected
    ? prioritizeContextPackBaseSourceBlocks(injectedBaseText, contextSourceFileRanks, pack.query, contextSourceFileRankEntries)
    : injectedBaseText;
  const relationshipLines = buildContextPackRelationshipLines(
    relationshipGroups,
    nodes,
    contextSourceFileRanks,
    sourceRankingQuery,
  );
  const relatedSymbolLines = buildContextPackRelatedSymbolLines(
    nodes,
    matches,
    contextSourceFileRanks,
    sourceRankingQuery,
  );
  let relationshipsMergedIntoBase = false;
  let relatedSymbolsMergedIntoBase = false;
  if (orderedInjectedBaseText) {
    const mergedRelationships = insertContextPackRelationshipContent(
      orderedInjectedBaseText,
      relationshipLines,
    );
    if (mergedRelationships !== null) {
      orderedInjectedBaseText = mergedRelationships;
      relationshipsMergedIntoBase = true;
    }
    const mergedRelatedSymbols = insertContextPackSectionContent(
      orderedInjectedBaseText,
      'Related Symbols',
      relatedSymbolLines,
    );
    if (mergedRelatedSymbols !== null) {
      orderedInjectedBaseText = mergedRelatedSymbols;
      relatedSymbolsMergedIntoBase = true;
    }
  }
  if (baseText) {
    lines.push(orderedInjectedBaseText);
  } else {
    lines.push(`## Exploration: ${pack.query}`, '', 'No base CodeGraph context was returned.');
  }

  if (pack.baseCodegraph.rawError) {
    lines.push('', '### Base CodeGraph Error', '', pack.baseCodegraph.rawError, '');
  }

  if (pack.nanoFlowOverlay.rawError) {
    lines.push('', '### NanoFlow Overlay Error', '', pack.nanoFlowOverlay.rawError, '');
  }

  if (!relationshipsMergedIntoBase) {
    lines.push('', '### Relationships', '', ...relationshipLines);
  }

  if (!relatedSymbolsMergedIntoBase) {
    lines.push('### Related Symbols', '', ...relatedSymbolLines);
  }

  if (overlaySourceBlocks.length > 0 && !overlaySourceBlocksInjected) {
    lines.push('### Source Code', '');
    lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
    lines.push('');
    appendContextPackSourceBlocks(lines, overlaySourceBlocks);
  }

  lines.push('### NanoFlow Coverage', '');
  const coverageEntries = Object.entries(coverage);
  if (coverageEntries.length === 0) {
    lines.push('- Coverage unavailable.');
  } else {
    for (const [name, count] of coverageEntries) {
      lines.push(`- ${name}: ${count}`);
    }
  }

  lines.push('', '### Next Steps', '');
  for (const step of pack.nextSteps) {
    lines.push(`- ${step}`);
  }

  const renderedText = lines.join('\n');
  const finalSourceFileRankEntries = prioritizeContextPackPreferredSymbolEvidence(
    rankContextPackSourceFileEntriesForContextText(
      renderedText,
      sourceEvidenceNodes,
      sourceRankingQuery,
      matches,
    ),
    sourceVisibilityQuery,
    sourceVisibilityQueryTerms,
  );
  const finalSourceFileRanks = new Map(finalSourceFileRankEntries
    .map((entry, index) => [entry.normalizedFilePath, index]));
  const finalText = limitContextPackMarkdownSourceFiles(prioritizeContextPackBaseSourceBlocks(
    renderedText,
    finalSourceFileRanks,
    pack.query,
    finalSourceFileRankEntries,
  ), normalizeContextPackFileBudget(pack.maxFiles, pack.maxFilesExplicit));
  if (qualityDiagnostics && typeof qualityDiagnostics === 'object') {
    qualityDiagnostics.sourceSelection = summarizeContextPackSourceSelection({
      rawQuery: pack.query,
      sourceRankingQuery,
      sourceVisibilityQuery,
      rawBaseText: rewrittenBaseText,
      sanitizedBaseText: baseText,
      prioritizedBaseText,
      injectedBaseText: orderedInjectedBaseText,
      finalText,
      overlaySourceBlocks,
      overlaySourceFileRankEntries,
      contextSourceFileRankEntries,
      finalSourceFileRankEntries,
    });
  }
  return finalText;
}

function normalizeContextPackFileBudget(value, explicit) {
  if (explicit !== true) return Number.MAX_SAFE_INTEGER;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function limitContextPackOverlayEvidence(evidence, maxFilesValue, maxFilesExplicit, rawQuery) {
  if (maxFilesExplicit !== true) {
    return {
      relationshipGroups: evidence.relationshipGroups ?? {},
      matches: Array.isArray(evidence.matches) ? evidence.matches : [],
      nodes: Array.isArray(evidence.nodes) ? evidence.nodes : [],
      codeBlocks: Array.isArray(evidence.codeBlocks) ? evidence.codeBlocks : [],
    };
  }
  const maxFiles = normalizeContextPackFileBudget(maxFilesValue, maxFilesExplicit);
  const nodes = Array.isArray(evidence.nodes) ? evidence.nodes : [];
  const codeBlocks = Array.isArray(evidence.codeBlocks) ? evidence.codeBlocks : [];
  const matches = Array.isArray(evidence.matches) ? evidence.matches : [];
  const rankedPaths = rankContextPackSourceFileEntries(
    mergeContextPackSourceEvidenceNodes(nodes, codeBlocks),
    rawQuery,
    matches,
  ).map(entry => entry.filePath);
  const fallbackPaths = [
    ...nodes.map(node => node?.filePath),
    ...codeBlocks.map(block => block?.filePath),
    ...matches.map(match => match?.file ?? match?.filePath ?? match?.item?.filePath),
  ];
  const requestedRelationEndpointPaths = contextPackRequestedRelationEndpointPaths(evidence, rawQuery);
  const orderedPaths = [];
  const seenPaths = new Set();
  for (const filePath of [...requestedRelationEndpointPaths, ...rankedPaths, ...fallbackPaths]) {
    const normalized = normalizeSearchPath(filePath);
    if (!normalized || seenPaths.has(normalized)) continue;
    seenPaths.add(normalized);
    orderedPaths.push(normalized);
  }
  const allowedPaths = new Set(orderedPaths.slice(0, maxFiles));
  if (allowedPaths.size === 0) {
    return {
      relationshipGroups: {},
      matches: [],
      nodes: [],
      codeBlocks: [],
    };
  }

  const belongsToAllowedFile = item => {
    const filePath = item?.filePath ?? item?.file ?? item?.item?.filePath;
    return allowedPaths.has(normalizeSearchPath(filePath));
  };
  const budgetedNodes = nodes.filter(belongsToAllowedFile);
  const endpointKeys = new Set(budgetedNodes.flatMap(node => [
    node?.id,
    node?.name,
    node?.qualifiedName,
  ].filter(Boolean)));
  const relationshipGroups = Object.fromEntries(Object.entries(evidence.relationshipGroups ?? {})
    .map(([kind, rawEdges]) => [
      kind,
      (Array.isArray(rawEdges) ? rawEdges : []).filter(edge => (
        endpointKeys.has(edge?.source) && endpointKeys.has(edge?.target)
      )),
    ])
    .filter(([, edges]) => edges.length > 0));

  return {
    relationshipGroups,
    matches: matches.filter(belongsToAllowedFile),
    nodes: budgetedNodes,
    codeBlocks: codeBlocks.filter(belongsToAllowedFile),
  };
}

function contextPackRequestedRelationEndpointPaths(evidence, rawQuery = '') {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const querySegments = new Set(contextPackSearchSignalSegments(queryTerms));
  const endpointKeys = new Set();
  for (const rawEdges of Object.values(evidence?.relationshipGroups ?? {})) {
    for (const edge of Array.isArray(rawEdges) ? rawEdges : []) {
      if (!contextPackQueryRequestsOverlayRelation(edge?.relation ?? edge?.metadata?.relation, queryTerms, querySegments)) {
        continue;
      }
      for (const endpoint of [edge?.source, edge?.target]) {
        if (endpoint) endpointKeys.add(String(endpoint));
      }
    }
  }
  if (endpointKeys.size === 0) return [];

  const allowLowValueEndpoint = queryMentionsTests(rawQuery);
  return unique((Array.isArray(evidence?.nodes) ? evidence.nodes : [])
    .filter(node => [node?.id, node?.name, node?.qualifiedName]
      .some(endpoint => endpoint && endpointKeys.has(String(endpoint))))
    .map(node => normalizeSearchPath(node?.filePath))
    .filter(filePath => filePath && (
      allowLowValueEndpoint
      || contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery) <= 0
      || queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms)
    )));
}

function contextPackQueryRequestsOverlayRelation(relationValue, queryTerms, querySegments) {
  const relation = normalizeContextPackResourceRelation(relationValue);
  if (!relation) return false;
  if (queryTerms.some(term => normalizeContextPackResourceRelation(term) === relation)) {
    return true;
  }
  const relationSegments = splitSearchSignalSegments(relation)
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2);
  return relationSegments.length > 1 && relationSegments.every(segment => querySegments.has(segment));
}

function isPureNoHitContextPack({
  baseText,
  baseIsError,
  overlayIsError,
  matches,
  nodes,
  codeBlocks,
  relationshipGroups,
}) {
  if (baseIsError || overlayIsError) return false;
  const hasOverlayRelationships = Object.values(relationshipGroups ?? {})
    .some(edges => Array.isArray(edges) && edges.length > 0);
  if (matches.length > 0 || nodes.length > 0 || codeBlocks.length > 0 || hasOverlayRelationships) {
    return false;
  }
  return !baseText || /(?:found\s+0\s+symbols|no\s+(?:matching\s+)?(?:symbols|results|code context)|nothing\s+matched)/i.test(baseText);
}

function isWeakExplicitNoHitContextPack({
  query,
  baseText,
  baseIsError,
  overlayIsError,
  matches,
  nodes,
  codeBlocks,
  relationshipGroups,
}) {
  if (baseIsError || overlayIsError || !baseText) return false;
  const hasOverlayRelationships = Object.values(relationshipGroups ?? {})
    .some(edges => Array.isArray(edges) && edges.length > 0);
  if (matches.length > 0 || nodes.length > 0 || codeBlocks.length > 0 || hasOverlayRelationships) {
    return false;
  }

  const explicitTerms = unique([
    ...explicitContextPackQueryTerms(query),
    ...queryTokens(String(query ?? '').toLowerCase()).filter(isOpaqueNoHitProbeTerm),
  ]);
  if (explicitTerms.length === 0) return false;

  const evidenceText = String(baseText)
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:##\s+|\*\*)?Exploration\b/i.test(line))
    .join('\n')
    .toLowerCase();
  return explicitTerms.every(term => !evidenceText.includes(term));
}

function isOpaqueNoHitProbeTerm(term) {
  const value = String(term ?? '');
  return value.length >= 12
    && /[_-]/.test(value)
    && /\d/.test(value);
}

function limitContextPackMarkdownSourceFiles(text, maxFiles) {
  if (!text) return text;
  const sourceSection = findContextPackSourceSection(text);
  if (!sourceSection || sourceSection.blocksStart < 0) return text;
  const chunks = splitContextPackSourceBlockChunks(text.slice(sourceSection.blocksStart, sourceSection.end));
  if (chunks.length <= maxFiles) return text;
  return [
    text.slice(0, sourceSection.blocksStart),
    joinContextPackSourceBlockChunks(chunks.slice(0, maxFiles)),
    text.slice(sourceSection.end),
  ].join('');
}

function prioritizeContextPackBaseSourceBlocks(baseText, sourceFileRanks, rawQuery = '', rankedEntries = []) {
  if (!baseText) {
    return baseText;
  }

  const sourceSection = findContextPackSourceSection(baseText);
  if (!sourceSection || sourceSection.blocksStart < 0) {
    return baseText;
  }

  const chunks = splitContextPackSourceBlockChunks(baseText.slice(sourceSection.blocksStart, sourceSection.end));
  if (chunks.length <= 1) {
    return baseText;
  }
  const effectiveSourceFileRanks = sourceFileRanks instanceof Map ? sourceFileRanks : new Map();
  const entries = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      priority: contextPackSourceBlockPriority(chunk, effectiveSourceFileRanks),
    }));
  const canReorder = contextPackSourceOrderingCanReorderBaseSourceBlocks(rawQuery, entries, rankedEntries);
  const ordered = canReorder
    ? [...entries].sort((a, b) => a.priority - b.priority || a.index - b.index)
    : entries;
  const shouldFilter = shouldFilterContextPackBaseSourceBlocks(rawQuery, ordered, rankedEntries);
  const filtered = shouldFilter
    ? filterContextPackBaseSourceBlockEntries(ordered, rankedEntries, rawQuery)
    : ordered;
  if (filtered.length === chunks.length && filtered.every((entry, index) => entry.index === index)) {
    return baseText;
  }

  return [
    baseText.slice(0, sourceSection.blocksStart),
    joinContextPackSourceBlockChunks(filtered.map(entry => entry.chunk)),
    baseText.slice(sourceSection.end),
  ].join('');
}

function contextPackSourceOrderingCanReorderBaseSourceBlocks(rawQuery, entries, rankedEntries = []) {
  return contextPackSourceOrderingBaseReorderReason(rawQuery, entries, rankedEntries) !== 'native-order-preserved';
}

function contextPackSourceOrderingBaseReorderReason(rawQuery, entries, rankedEntries = []) {
  if (queryMentionsCodegraphTooling(rawQuery)) {
    return 'codegraph-tooling-query';
  }
  if (explicitContextPackQueryTerms(rawQuery).some(isExplicitPathTerm)) {
    return 'explicit-path-query';
  }
  if (contextPackBaseSourceFilterRelationQueries(rawQuery).length > 0) {
    return 'resource-relation-query';
  }
  if (contextPackSourceOrderingHasNanoFlowRelationEvidence(rankedEntries)) {
    return 'nanoflow-relation-evidence';
  }
  if (contextPackSourceOrderingHasFocusedOverlayEvidence(rawQuery, entries, rankedEntries)) {
    return 'focused-member-overlay-evidence';
  }
  if (hasAvoidableLowValueContextPackBaseSourceBlocks(entries, rankedEntries, rawQuery)) {
    return 'avoidable-low-value-source';
  }
  return 'native-order-preserved';
}

function contextPackSourceOrderingHasNanoFlowRelationEvidence(rankedEntries = []) {
  return rankedEntries.some(entry => (
    Array.isArray(entry?.groupedNodes)
    && entry.groupedNodes.some(node => Boolean(node?.metadata?.relation))
  ));
}

function contextPackSourceOrderingHasFocusedOverlayEvidence(rawQuery, entries, rankedEntries = []) {
  if (!Array.isArray(entries) || entries.length <= 1 || !Array.isArray(rankedEntries) || rankedEntries.length === 0) {
    return false;
  }

  const visibleFiles = entries
    .map(entry => normalizeSearchPath(extractContextPackSourceBlockFile(entry?.chunk)))
    .filter(Boolean);
  if (visibleFiles.length <= 1) {
    return false;
  }

  const visibleFileSet = new Set(visibleFiles);
  const topVisibleRankedEntry = rankedEntries.find(entry => (
    visibleFileSet.has(normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath))
  ));
  if (!topVisibleRankedEntry) {
    return false;
  }

  const topFile = normalizeSearchPath(topVisibleRankedEntry.filePath ?? topVisibleRankedEntry.normalizedFilePath);
  const currentFirstFile = visibleFiles[0];
  if (!topFile || !currentFirstFile) {
    return false;
  }

  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const topEvidence = contextPackFocusedSourceReorderEvidence(topVisibleRankedEntry, queryTerms);
  if (topEvidence.memberMatchCount < 2) {
    return false;
  }

  const rankedEntriesByFile = new Map(rankedEntries
    .map(entry => [normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath), entry])
    .filter(([filePath]) => Boolean(filePath)));
  const currentFirstEvidence = contextPackFocusedSourceReorderEvidence(
    rankedEntriesByFile.get(currentFirstFile),
    queryTerms,
  );
  return topFile === currentFirstFile
    || topEvidence.score > currentFirstEvidence.score
    || topEvidence.memberMatchCount > currentFirstEvidence.memberMatchCount;
}

function contextPackFocusedSourceReorderEvidence(entry, queryTerms) {
  const nodes = Array.isArray(entry?.groupedNodes) ? entry.groupedNodes : [];
  let memberMatchCount = 0;
  let matchedNodeCount = 0;
  for (const node of nodes) {
    if (!contextPackNodeMatchesQueryTerms(node, queryTerms)) {
      continue;
    }
    matchedNodeCount += 1;
    if (contextPackFocusedSourceReorderNodeKind(node?.kind)) {
      memberMatchCount += 1;
    }
  }
  return {
    matchedNodeCount,
    memberMatchCount,
    score: memberMatchCount * 3 + matchedNodeCount,
  };
}

function contextPackFocusedSourceReorderNodeKind(kind) {
  const normalized = String(kind ?? '').toLowerCase();
  return normalized === 'method'
    || normalized === 'function'
    || normalized === 'constructor'
    || normalized === 'property'
    || normalized === 'getter'
    || normalized === 'setter'
    || normalized === 'variable'
    || normalized === 'constant';
}

function shouldFilterContextPackBaseSourceBlocks(rawQuery, orderedEntries, rankedEntries = []) {
  const specializedSourceScope = contextPackSpecializedMaintenanceSourceScopeFor(rawQuery);
  if (specializedSourceScope) {
    const scopedVisibleEntries = orderedEntries.filter(entry => (
      contextPackSourcePathMatchesSpecializedMaintenanceScope(
        extractContextPackSourceBlockFile(entry.chunk),
        specializedSourceScope,
      )
    ));
    const hasScopedRankedAlternative = rankedEntries.some(entry => (
      contextPackSourcePathMatchesSpecializedMaintenanceScope(
        entry?.filePath ?? entry?.normalizedFilePath,
        specializedSourceScope,
      )
    ));
    if (
      hasScopedRankedAlternative
      && scopedVisibleEntries.length > 0
      && scopedVisibleEntries.length < orderedEntries.length
    ) {
      return true;
    }
  }
  if (orderedEntries.length <= 1) return false;
  if (queryMentionsCodegraphTooling(rawQuery) && orderedEntries.some(entry => {
    const filePath = extractContextPackSourceBlockFile(entry.chunk);
    return isCodegraphToolingSourcePath(filePath);
  })) {
    return true;
  }
  if (hasAvoidableLowValueContextPackBaseSourceBlocks(orderedEntries, rankedEntries, rawQuery)) {
    return true;
  }
  if (orderedEntries.length <= CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT) return false;
  return explicitContextPackQueryTerms(rawQuery).some(isExplicitPathTerm)
    || contextPackBaseSourceFilterRelationQueries(rawQuery).length > 0;
}

function contextPackBaseSourceFilterRelationQueries(rawQuery) {
  return queryTokens(String(rawQuery ?? '').toLowerCase())
    .flatMap(term => String(term).split('/'))
    .map(term => term.trim().toLowerCase())
    .filter(term => CONTEXT_PACK_BASE_SOURCE_FILTER_RELATIONS.has(term));
}

function filterContextPackBaseSourceBlockEntries(orderedEntries, rankedEntries = [], rawQuery = '') {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const sourceFileLowValuePenalty = (filePath) => contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery);
  const issueRegistryFocusedQuery = contextPackIssueRegistryQueryFor(rawQuery, queryTerms);
  const specializedSourceScope = contextPackSpecializedMaintenanceSourceScopeFor(rawQuery);
  if (specializedSourceScope) {
    const hasScopedRankedAlternative = rankedEntries.some(entry => (
      contextPackSourcePathMatchesSpecializedMaintenanceScope(
        entry?.filePath ?? entry?.normalizedFilePath,
        specializedSourceScope,
      )
    ));
    const scopedEntries = orderedEntries.filter(entry => (
      contextPackSourcePathMatchesSpecializedMaintenanceScope(
        extractContextPackSourceBlockFile(entry.chunk),
        specializedSourceScope,
      )
    ));
    if (hasScopedRankedAlternative && scopedEntries.length > 0) {
      return scopedEntries.slice(0, CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT);
    }
  }
  const firstPreferredRankedEntry = prioritizeContextPackPreferredSymbolEvidence(
    rankedEntries,
    rawQuery,
    queryTerms,
  ).find(entry => (
    sourceFileLowValuePenalty(entry.filePath ?? entry.normalizedFilePath) <= 0
    || contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, queryTerms)
  ));
  const firstPreferredFile = normalizeSearchPath(
    firstPreferredRankedEntry?.filePath ?? firstPreferredRankedEntry?.normalizedFilePath,
  );
  const visibleDocumentationRankedEntry = rankedEntries.find(entry => {
    const filePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
    return Boolean(filePath)
      && isContextPackDocumentationSourcePath(filePath)
      && !isCodegraphToolingSourcePath(filePath)
      && orderedEntries.some(orderedEntry => (
        normalizeSearchPath(extractContextPackSourceBlockFile(orderedEntry.chunk)) === filePath
      ));
  });
  const visibleDocumentationFile = normalizeSearchPath(
    visibleDocumentationRankedEntry?.filePath ?? visibleDocumentationRankedEntry?.normalizedFilePath,
  );
  if (queryMentionsCodegraphTooling(rawQuery) && !issueRegistryFocusedQuery) {
    const toolingEntries = orderedEntries.filter(entry => {
      const filePath = extractContextPackSourceBlockFile(entry.chunk);
      return isCodegraphToolingSourcePath(filePath);
    });
    if (toolingEntries.length > 0) {
      const visibleNonToolingRankedEntry = rankedEntries.find(entry => {
        const filePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
        return Boolean(filePath)
          && !isCodegraphToolingSourcePath(filePath)
          && orderedEntries.some(orderedEntry => (
            normalizeSearchPath(extractContextPackSourceBlockFile(orderedEntry.chunk)) === filePath
          ))
          && (
            sourceFileLowValuePenalty(filePath) <= 0
            || contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, queryTerms)
          );
      });
      const visibleNonToolingFile = normalizeSearchPath(
        visibleNonToolingRankedEntry?.filePath ?? visibleNonToolingRankedEntry?.normalizedFilePath,
      );
      const visibleExplicitNonToolingRankedEntry = rankedEntries.find(entry => {
        const filePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
        return Boolean(filePath)
          && !isCodegraphToolingSourcePath(filePath)
          && queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms)
          && orderedEntries.some(orderedEntry => (
            normalizeSearchPath(extractContextPackSourceBlockFile(orderedEntry.chunk)) === filePath
          ));
      });
      const visibleExplicitNonToolingFile = normalizeSearchPath(
        visibleExplicitNonToolingRankedEntry?.filePath ?? visibleExplicitNonToolingRankedEntry?.normalizedFilePath,
      );
      const visibleToolingRankedEntry = rankedEntries.find(entry => {
        const filePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
        return Boolean(filePath)
          && isCodegraphToolingSourcePath(filePath)
          && orderedEntries.some(orderedEntry => (
            normalizeSearchPath(extractContextPackSourceBlockFile(orderedEntry.chunk)) === filePath
          ));
      });
      const visibleToolingFile = normalizeSearchPath(
        visibleToolingRankedEntry?.filePath ?? visibleToolingRankedEntry?.normalizedFilePath,
      );
      const preferredVisibleFile = visibleDocumentationFile
        || visibleExplicitNonToolingFile
        || visibleToolingFile
        || visibleNonToolingFile
        || firstPreferredFile;
      const preferredVisibleEntries = preferredVisibleFile
        ? orderedEntries.filter(entry => (
          normalizeSearchPath(extractContextPackSourceBlockFile(entry.chunk)) === preferredVisibleFile
        ))
        : [];
      const seenFiles = new Set();
      return [...preferredVisibleEntries, ...toolingEntries]
        .filter(entry => {
          const normalizedFilePath = normalizeSearchPath(extractContextPackSourceBlockFile(entry.chunk));
          if (!normalizedFilePath || seenFiles.has(normalizedFilePath)) {
            return false;
          }
          seenFiles.add(normalizedFilePath);
          return true;
        })
        .slice(0, CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT);
    }
  }
  const rankedEntriesByFile = new Map(rankedEntries
    .map(entry => [entry.normalizedFilePath, entry])
    .filter(([filePath]) => Boolean(filePath)));
  const preferredRankedEntries = rankedEntries.filter(entry => (
    sourceFileLowValuePenalty(entry.filePath ?? entry.normalizedFilePath) <= 0
    || contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, queryTerms)
  ));
  const rankingPool = preferredRankedEntries.length > 0 ? preferredRankedEntries : rankedEntries;
  const rankedFiles = new Set(rankingPool
    .slice(0, CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT)
    .map(entry => entry.normalizedFilePath)
    .filter(Boolean));
  let filtered = orderedEntries
    .filter(entry => {
      const filePath = extractContextPackSourceBlockFile(entry.chunk);
      return rankedFiles.has(normalizeSearchPath(filePath));
    })
    .slice(0, CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT);
  const cleanOrderedEntries = orderedEntries.filter(entry => {
    const filePath = extractContextPackSourceBlockFile(entry.chunk);
    return sourceFileLowValuePenalty(filePath) <= 0;
  });
  const filteredHasLowValueSource = filtered.some(entry => {
    const filePath = extractContextPackSourceBlockFile(entry.chunk);
    const rankedEntry = rankedEntriesByFile.get(normalizeSearchPath(filePath));
    return sourceFileLowValuePenalty(filePath) > 0
      && !contextPackSourceEntryHasPreferredSymbolEvidence(rankedEntry, rawQuery, queryTerms);
  });
  if ((filtered.length === 0 || filteredHasLowValueSource) && cleanOrderedEntries.length > 0) {
    filtered = cleanOrderedEntries.slice(0, CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT);
  }
  return filtered.length > 0 ? filtered : orderedEntries.slice(0, CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT);
}

function hasAvoidableLowValueContextPackBaseSourceBlocks(orderedEntries, rankedEntries = [], rawQuery = '') {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const sourceFileLowValuePenalty = (filePath) => contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery);
  const rankedEntriesByFile = new Map(rankedEntries
    .map(entry => [normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath), entry])
    .filter(([filePath]) => Boolean(filePath)));
  const hasPreferredSymbolEvidence = (filePath) => contextPackSourceEntryHasPreferredSymbolEvidence(
    rankedEntriesByFile.get(normalizeSearchPath(filePath)),
    rawQuery,
    queryTerms,
  );
  const cleanVisibleCandidates = orderedEntries.filter(entry => {
    const filePath = extractContextPackSourceBlockFile(entry.chunk);
    return sourceFileLowValuePenalty(filePath) <= 0 || hasPreferredSymbolEvidence(filePath);
  });
  if (cleanVisibleCandidates.length === 0) {
    return false;
  }

  const lowValueRankedFiles = new Set(rankedEntries
    .filter(entry => (
      sourceFileLowValuePenalty(entry.filePath ?? entry.normalizedFilePath) > 0
      && !contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, queryTerms)
    ))
    .map(entry => entry.normalizedFilePath)
    .filter(Boolean));

  return orderedEntries
    .slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT)
    .some(entry => {
      const filePath = extractContextPackSourceBlockFile(entry.chunk);
      return lowValueRankedFiles.has(normalizeSearchPath(filePath))
        || (sourceFileLowValuePenalty(filePath) > 0 && !hasPreferredSymbolEvidence(filePath));
    });
}

function splitContextPackSourceBlockChunks(blocksText) {
  const matches = [...blocksText.matchAll(CONTEXT_PACK_SOURCE_BLOCK_HEADING_RE)];
  if (matches.length === 0) {
    return [];
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length
      ? matches[index + 1].index ?? blocksText.length
      : blocksText.length;
    return blocksText.slice(start, end);
  });
}

function joinContextPackSourceBlockChunks(chunks) {
  return chunks.reduce((joined, chunk) => {
    if (!joined) {
      return chunk;
    }
    const nextChunk = String(chunk ?? '').replace(/^\n+/, '');
    return joined.endsWith('\n')
      ? `${joined}${nextChunk}`
      : `${joined}\n${nextChunk}`;
  }, '');
}

function removeContextPackSourceBlockChunks(baseText, filePaths) {
  const normalizedFiles = new Set((filePaths ?? [])
    .map(filePath => normalizeSearchPath(filePath))
    .filter(Boolean));
  if (!baseText || normalizedFiles.size === 0) {
    return baseText;
  }

  const sourceSection = findContextPackSourceSection(baseText);
  if (!sourceSection || sourceSection.blocksStart < 0) {
    return baseText;
  }

  const chunks = splitContextPackSourceBlockChunks(baseText.slice(sourceSection.blocksStart, sourceSection.end));
  if (chunks.length === 0) {
    return baseText;
  }

  const keptChunks = chunks.filter(chunk => (
    !normalizedFiles.has(normalizeSearchPath(extractContextPackSourceBlockFile(chunk)))
  ));
  if (keptChunks.length === chunks.length) {
    return baseText;
  }

  return [
    baseText.slice(0, sourceSection.blocksStart),
    joinContextPackSourceBlockChunks(keptChunks),
    baseText.slice(sourceSection.end),
  ].join('');
}

function contextPackSourceBlockPriority(chunk, sourceFileRanks) {
  const filePath = extractContextPackSourceBlockFile(chunk);
  if (!filePath) {
    return Number.MAX_SAFE_INTEGER;
  }
  return sourceFileRanks.get(filePath) ?? Number.MAX_SAFE_INTEGER;
}

function injectContextPackOverlaySourceBlocks(baseText, overlaySourceBlocks) {
  if (!baseText || overlaySourceBlocks.length === 0) {
    return baseText;
  }

  // 注入块 header 必须跟随 base 源码区自身的格式：pinned 原生 explore 用 **`file`**，
  // legacy fixture 用 #### file；否则 header 混排会破坏按 header 定位源码块的消费者。
  const nativeHeaderStyle = contextPackSourceSectionUsesNativeHeaders(baseText);
  const dedupedBaseText = removeContextPackSourceBlockChunks(
    baseText,
    overlaySourceBlocks.map(block => block.filePath),
  );
  const sourceSection = findContextPackSourceSection(dedupedBaseText);
  if (!sourceSection) {
    return dedupedBaseText;
  }

  const blockLines = [];
  appendContextPackSourceBlocks(blockLines, overlaySourceBlocks, nativeHeaderStyle);
  const insertAt = sourceSection.blocksStart >= 0 ? sourceSection.blocksStart : sourceSection.end;
  return insertContextPackText(dedupedBaseText, insertAt, blockLines.join('\n').trimEnd());
}

function contextPackSourceSectionUsesNativeHeaders(baseText) {
  // 按源码区标题判定，而不是首个源码块：mixed-style base 或过滤后残留块
  // 会让首块风格漂移，标题（**Source Code** vs ### Source Code/Code）才稳定。
  const sourceHeadingMatch = CONTEXT_PACK_SOURCE_SECTION_HEADING_RE.exec(String(baseText ?? ''));
  if (!sourceHeadingMatch) {
    return false;
  }
  return sourceHeadingMatch[0].includes('**Source Code**');
}

function findContextPackSourceSection(text) {
  const sourceHeadingMatch = CONTEXT_PACK_SOURCE_SECTION_HEADING_RE.exec(text);
  if (!sourceHeadingMatch) {
    return null;
  }

  const headingStart = sourceHeadingMatch.index + sourceHeadingMatch[1].length;
  const sourceSection = text.slice(headingStart);
  const firstSourceBlockMatch = new RegExp(`\\n(?:####\\s+|\\*\\*\`)`).exec(sourceSection);
  const blocksStart = firstSourceBlockMatch
    ? headingStart + firstSourceBlockMatch.index + 1
    : -1;
  const nextSectionSearchStart = blocksStart >= 0 ? blocksStart : headingStart + 1;
  const followingSectionMatch = CONTEXT_PACK_FOLLOWING_SECTION_RE.exec(text.slice(nextSectionSearchStart));
  const end = followingSectionMatch
    ? nextSectionSearchStart + followingSectionMatch.index
    : text.length;

  return {
    headingStart,
    blocksStart,
    end,
  };
}

function insertContextPackText(text, insertAt, insertedText) {
  const before = text.slice(0, insertAt).replace(/\s+$/, '');
  const after = text.slice(insertAt).replace(/^\n+/, '');
  return after
    ? `${before}\n\n${insertedText}\n${after}`
    : `${before}\n\n${insertedText}`;
}

function appendContextPackSourceBlocks(lines, sourceBlocks, nativeHeaderStyle = false) {
  for (const block of sourceBlocks) {
    const symbolSuffix = block.symbols ? ` — ${block.symbols}` : '';
    lines.push(nativeHeaderStyle
      ? `**\`${block.filePath}\`**${symbolSuffix}`
      : `#### ${block.filePath}${symbolSuffix}`);
    lines.push('');
    lines.push(`\`\`\`${block.language}`);
    lines.push(block.source);
    lines.push('```');
    lines.push('');
  }
}

function buildContextPackOverlaySourceBlocks(
  nodes,
  baseText = '',
  rawQuery = '',
  matches = [],
  sourceFileRanks = null,
  visibilityQuery = rawQuery,
) {
  const rankedFiles = sourceFileRanks ?? rankContextPackSourceFiles(nodes, rawQuery, matches);
  const existingBaseSourceFiles = collectContextPackSourceBlockFiles(baseText);
  const groupedNodesByFile = new Map(groupContextPackSourceEvidenceByFile(nodes, matches));
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const visibilityQueryTerms = queryTokens(String(visibilityQuery ?? '').toLowerCase());
  const candidates = [...rankedFiles.entries()]
    .map(([normalizedFilePath, rank]) => {
      const groupedEntry = [...groupedNodesByFile.entries()]
        .find(([filePath]) => normalizeSearchPath(filePath) === normalizedFilePath);
      return groupedEntry ? { filePath: groupedEntry[0], groupedNodes: groupedEntry[1], rank } : null;
    })
    .filter(Boolean)
    .filter(({ filePath, groupedNodes }) => shouldIncludeContextPackOverlaySourceBlock(
      baseText,
      filePath,
      groupedNodes,
      existingBaseSourceFiles,
      queryTerms,
      rawQuery,
    ))
    .sort((a, b) => a.rank - b.rank || a.filePath.localeCompare(b.filePath));
  const grouped = prioritizeContextPackOverlaySourceBlockCandidates(
    candidates,
    visibilityQueryTerms,
    visibilityQuery,
  )
    .slice(0, CONTEXT_PACK_OVERLAY_SOURCE_BLOCK_LIMIT);
  const blocks = [];
  for (const { filePath, groupedNodes } of grouped) {
    const block = buildContextPackSourceBlock(filePath, groupedNodes, rawQuery);
    if (block) {
      blocks.push(block);
    }
  }
  return blocks;
}

function shouldIncludeContextPackOverlaySourceBlock(baseText, filePath, groupedNodes, existingBaseSourceFiles, queryTerms, rawQuery = '') {
  const normalizedFilePath = normalizeSearchPath(filePath);
  if (!existingBaseSourceFiles.has(normalizedFilePath)) {
    return true;
  }
  if (contextPackLifecycleTestEvidenceQueryFor(rawQuery, queryTerms)) {
    return !contextPackBaseTextContainsLifecycleEvidence(baseText, filePath, rawQuery);
  }
  return !contextPackBaseTextContainsFocusedNodeEvidence(baseText, filePath, groupedNodes, queryTerms);
}

function contextPackBaseTextContainsLifecycleEvidence(baseText, filePath, rawQuery = '') {
  const chunk = findContextPackSourceBlockChunk(baseText, filePath);
  if (!chunk) return false;
  const segmentSet = new Set(contextPackSearchSignalSegments(queryTokens(rawQuery)));
  const asksForProcessExit = [
    'exit',
    'exits',
    'exited',
    'return',
    'returns',
    'returned',
    'restart',
    'restarts',
    'restarted',
    'restarting',
  ].some(segment => segmentSet.has(segment));
  if (!asksForProcessExit) {
    return true;
  }

  const text = String(chunk ?? '').toLowerCase();
  return text.includes('wrapper.shutdown.stale-wrapper-script')
    && text.includes('expectedexit')
    && text.includes('childexitpromise')
    && (/\bcode:\s*0\b/.test(text) || /\bsignal:\s*null\b/.test(text));
}

function contextPackBaseTextContainsFocusedNodeEvidence(baseText, filePath, groupedNodes, queryTerms) {
  const chunk = findContextPackSourceBlockChunk(baseText, filePath);
  if (!chunk) return false;
  const focusedNodes = groupedNodes
    .filter(node => node?.kind !== 'file' && node?.kind !== 'import' && node?.kind !== 'export')
    .filter(node => Number.isInteger(Number(node?.startLine)) && Number(node.startLine) > 0)
    .filter(node => contextPackNodeMatchesQueryTerms(node, queryTerms));
  if (focusedNodes.length === 0) {
    return true;
  }
  return focusedNodes.every(node => contextPackSourceChunkContainsFocusedLine(chunk, Number(node.startLine)));
}

function findContextPackSourceBlockChunk(text, filePath) {
  const sourceSection = findContextPackSourceSection(text);
  if (!sourceSection || sourceSection.blocksStart < 0) {
    return null;
  }
  const normalizedFilePath = normalizeSearchPath(filePath);
  const chunks = splitContextPackSourceBlockChunks(text.slice(sourceSection.blocksStart, sourceSection.end));
  return chunks.find(chunk => normalizeSearchPath(extractContextPackSourceBlockFile(chunk)) === normalizedFilePath) ?? null;
}

function contextPackSourceChunkContainsLine(chunk, lineNumber) {
  return new RegExp(`^${lineNumber}\\t`, 'm').test(String(chunk ?? ''));
}

function contextPackSourceChunkContainsFocusedLine(chunk, lineNumber) {
  const text = String(chunk ?? '');
  const match = new RegExp(`^${lineNumber}\\t`, 'm').exec(text);
  if (!match) {
    return false;
  }
  const prefix = text.slice(0, match.index);
  const precedingNumberedLines = (prefix.match(/^\d+\t/gm) ?? []).length;
  return match.index <= CONTEXT_PACK_FOCUSED_SOURCE_VISIBLE_CHAR_LIMIT
    && precedingNumberedLines <= CONTEXT_PACK_FOCUSED_SOURCE_VISIBLE_LINE_LIMIT;
}

function contextPackNodeMatchesQueryTerms(node, queryTerms) {
  const compactNames = [
    node?.name,
    node?.qualifiedName,
  ]
    .map(value => String(value ?? '').toLowerCase().replace(/[^a-z0-9_$]+/g, ''))
    .filter(Boolean);
  if (queryTerms.some(term => {
    const compactTerm = String(term ?? '').toLowerCase().replace(/[^a-z0-9_$]+/g, '');
    return compactTerm && compactNames.some(name => name.includes(compactTerm) || compactTerm.includes(name));
  })) {
    return true;
  }

  const segments = new Set([
    ...splitSearchSignalSegments(node?.name ?? ''),
    ...splitSearchSignalSegments(node?.qualifiedName ?? ''),
  ].map(segment => segment.toLowerCase()).filter(segment => segment.length >= 2));
  if (segments.size === 0) {
    return false;
  }
  return queryTerms
    .flatMap(searchPathSignalSegments)
    .some(segment => segments.has(segment));
}

function contextPackSourceEntryHasExplicitSymbolEvidence(entry, rawQuery = '') {
  const explicitSymbolTerms = explicitContextPackQueryTerms(rawQuery)
    .filter(term => !isExplicitPathTerm(term));
  if (explicitSymbolTerms.length === 0) {
    return false;
  }
  return (entry?.groupedNodes ?? [])
    .some(node => contextPackNodeMatchesQueryTerms(node, explicitSymbolTerms));
}

function contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery = '', precomputedQueryTerms = null) {
  const filePath = entry?.filePath ?? entry?.normalizedFilePath;
  if (
    queryMentionsCodegraphRuntimeDiagnostics(rawQuery)
    && normalizeSearchPath(filePath) === 'scripts/codegraph-nanoflow-mcp-stdio.cjs'
  ) {
    return true;
  }
  if (!contextPackSourceEntryHasExplicitSymbolEvidence(entry, rawQuery)) {
    return false;
  }
  const queryTerms = Array.isArray(precomputedQueryTerms)
    ? precomputedQueryTerms
    : queryTokens(String(rawQuery ?? '').toLowerCase());
  if (isCodegraphToolingSourcePath(filePath)) {
    return true;
  }
  return contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery) <= 0;
}

function prioritizeContextPackOverlaySourceBlockCandidates(candidates, queryTerms, rawQuery) {
  const primary = [];
  const fallback = [];
  for (const candidate of candidates) {
    const penalty = contextPackSourceFileLowValuePenalty(candidate.filePath, queryTerms, rawQuery);
    if (penalty > 0 && !contextPackSourceEntryHasPreferredSymbolEvidence(candidate, rawQuery, queryTerms)) {
      fallback.push(candidate);
    } else {
      primary.push(candidate);
    }
  }
  if (primary.length > 0) {
    const orderedPrimary = prioritizeContextPackPreferredSymbolEvidence(primary, rawQuery, queryTerms);
    if (queryMentionsCodegraphDedupMaintenance(rawQuery)) {
      return orderedPrimary;
    }
    return [
      ...orderedPrimary,
      ...fallback.filter(candidate => !isAuxiliaryContextPackSourcePath(candidate.filePath)),
    ];
  }
  return fallback;
}

function prioritizeContextPackPreferredSymbolEvidence(entries, rawQuery = '', queryTerms = null) {
  const ranked = entries.map((entry, index) => ({
    entry,
    index,
    tier: contextPackPreferredSymbolEvidenceTier(entry, rawQuery, queryTerms),
  }));
  if (!ranked.some(item => item.tier > 0)) {
    return entries;
  }
  return ranked
    .sort((a, b) => b.tier - a.tier || a.index - b.index)
    .map(item => item.entry);
}

function contextPackPreferredSymbolEvidenceTier(entry, rawQuery = '', queryTerms = null) {
  const filePath = entry?.filePath ?? entry?.normalizedFilePath;
  if (
    queryMentionsCodegraphRuntimeDiagnostics(rawQuery)
    && normalizeSearchPath(filePath) === 'scripts/codegraph-nanoflow-mcp-stdio.cjs'
  ) {
    return 4;
  }
  if (!contextPackSourceEntryHasExplicitSymbolEvidence(entry, rawQuery)) {
    return 0;
  }
  if (isCodegraphToolingSourcePath(filePath)) {
    return 3;
  }
  const terms = Array.isArray(queryTerms)
    ? queryTerms
    : queryTokens(String(rawQuery ?? '').toLowerCase());
  if (contextPackSourceFileLowValuePenalty(filePath, terms, rawQuery) <= 0) {
    return 2;
  }
  return 0;
}

function collectContextPackSourceBlockFiles(text) {
  return new Set(extractContextPackSourceBlockFiles(text));
}

function extractContextPackSourceBlockFiles(text) {
  const files = new Set();
  if (!text) {
    return [];
  }
  for (const match of text.matchAll(CONTEXT_PACK_SOURCE_BLOCK_HEADING_RE)) {
    const normalizedPath = extractContextPackSourceBlockFile(match[0]);
    if (normalizedPath) {
      files.add(normalizedPath);
    }
  }
  return [...files];
}

function extractContextPackSourceBlockFile(blockOrHeader) {
  const markdownHeader = /^####\s+(.+)$/m.exec(String(blockOrHeader ?? ''))?.[1];
  const nativeBoldHeader = /^\*\*`([^`]+)`\*\*/m.exec(String(blockOrHeader ?? ''))?.[1];
  const text = markdownHeader ?? nativeBoldHeader ?? String(blockOrHeader ?? '');
  return extractSearchPathFromText(text);
}

function summarizeContextPackSourceOrdering(text, rawQuery = '', nodes = [], matches = []) {
  const sourceFiles = extractContextPackSourceBlockFiles(text);
  const sourceSectionCount = countContextPackSourceSections(text);
  const relationshipsSectionCount = countContextPackMarkdownSectionHeadings(text, 'Relationships');
  const relatedSymbolsSectionCount = countContextPackMarkdownSectionHeadings(text, 'Related Symbols');
  const relationshipKindSectionCounts = countContextPackRelationshipKindSections(text);
  const sourceRankingQuery = contextPackSourceRankingQueryFor(rawQuery);
  const sourceVisibilityQuery = String(rawQuery ?? '').trim();
  const queryClassification = summarizeContextPackQueryClassification(rawQuery);
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const rankedSourceFileEntries = rankContextPackSourceFileEntriesForContextText(
    text,
    nodes,
    sourceRankingQuery,
    matches,
  );
  const overlayEvidenceFileEntries = rankedSourceFileEntries.filter(contextPackSourceFileEntryHasOverlayEvidence);
  const rankedOverlayFileEntries = overlayEvidenceFileEntries.length > 0
    ? overlayEvidenceFileEntries
    : rankedSourceFileEntries;
  const rankedOverlayFiles = rankedOverlayFileEntries.map(entry => entry.normalizedFilePath);
  const rawTopRankedOverlayEntry = rankedOverlayFileEntries[0] ?? null;
  const rawTopRankedOverlayFile = rawTopRankedOverlayEntry?.normalizedFilePath ?? null;
  const topRankedOverlayEntry = selectContextPackDiagnosticTopRankedOverlayEntry(
    rankedOverlayFileEntries,
    rawQuery,
    rankedSourceFileEntries,
  );
  const topRankedOverlayFile = topRankedOverlayEntry?.normalizedFilePath ?? null;
  const topRankedOverlayFileSelectionReason = contextPackDiagnosticTopRankedOverlaySelectionReason(
    rawTopRankedOverlayEntry,
    topRankedOverlayEntry,
    rawQuery,
  );
  const topRankedOverlayFileVisibleIndex = topRankedOverlayFile
    ? sourceFiles.indexOf(topRankedOverlayFile)
    : -1;
  const sourceSection = findContextPackSourceSection(text);
  const sourceBlockChunks = sourceSection && sourceSection.blocksStart >= 0
    ? splitContextPackSourceBlockChunks(text.slice(sourceSection.blocksStart, sourceSection.end))
    : [];
  const sourceBlockEntries = sourceBlockChunks.map((chunk, index) => ({
    chunk,
    index,
    priority: contextPackSourceBlockPriority(
      chunk,
      new Map(rankedOverlayFileEntries.map((entry, rank) => [entry.normalizedFilePath, rank])),
    ),
  }));
  const baseSourceReorderReason = contextPackSourceOrderingBaseReorderReason(
    rawQuery,
    sourceBlockEntries,
    rankedOverlayFileEntries,
  );
  const baseSourceReorderAllowed = baseSourceReorderReason !== 'native-order-preserved';
  const topRankedOverlayDecision = summarizeContextPackTopRankedOverlayDecision({
    rawEntry: rawTopRankedOverlayEntry,
    selectedEntry: topRankedOverlayEntry,
    rawQuery,
    sourceFiles,
    selectionReason: topRankedOverlayFileSelectionReason,
    baseSourceReorderAllowed,
    baseSourceReorderReason,
  });
  return {
    sourceRankingQuery,
    sourceVisibilityQuery,
    baseSourceReorderAllowed,
    baseSourceReorderReason,
    sourceSectionCount,
    duplicateSourceSectionCount: Math.max(0, sourceSectionCount - 1),
    relationshipsSectionCount,
    duplicateRelationshipsSectionCount: Math.max(0, relationshipsSectionCount - 1),
    relationshipKindSectionCounts,
    duplicateRelationshipKindSectionCount: duplicateContextPackRelationshipKindSectionCount(relationshipKindSectionCounts),
    relatedSymbolsSectionCount,
    duplicateRelatedSymbolsSectionCount: Math.max(0, relatedSymbolsSectionCount - 1),
    sourceBlockCount: sourceFiles.length,
    firstSourceFiles: sourceFiles.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    rankedOverlayFiles: rankedOverlayFiles.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    rawTopRankedOverlayFile,
    visibleSourceFileDetails: contextPackVisibleSourceFileDetails(
      sourceFiles,
      rankedOverlayFileEntries,
      sourceRankingQuery,
    ),
    rankedOverlayFileDetails: rankedOverlayFileEntries.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT).map(entry => {
      const explicitSymbolEvidence = contextPackSourceEntryHasExplicitSymbolEvidence(entry, rawQuery);
      const preferredSymbolEvidence = contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, queryTerms);
      const filePath = entry.normalizedFilePath;
      return {
        filePath,
        score: entry.score,
        matchRank: entry.matchRank,
        nodeRank: entry.nodeRank,
        matchScore: entry.matchScore,
        nodeScore: entry.nodeScore,
        pathScore: entry.pathScore,
        symbolScore: entry.symbolScore,
        codeBlockScore: entry.codeBlockScore,
        sourceBlockScore: entry.sourceBlockScore,
        lowValuePenalty: preferredSymbolEvidence ? 0 : entry.lowValuePenalty,
        rawLowValuePenalty: entry.lowValuePenalty,
        pathClassLowValue: isLowValueContextPackSourcePath(filePath),
        codegraphToolingSource: isCodegraphToolingSourcePath(filePath),
        dedupMaintenanceSource: isCodegraphDedupMaintenanceSourcePath(filePath),
        explicitSymbolEvidence,
        preferredSymbolEvidence,
        explicitFileRequested: queryExplicitlyRequestsContextPackFilePath(filePath, queryTerms),
        explicitSourcePathRequested: queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms),
      };
    }),
    topRankedOverlayFile,
    topRankedOverlayFileSelectionReason,
    topRankedOverlayDecision,
    topRankedOverlayFileSkippedLowValue: topRankedOverlayDecision.skippedLowValue === true,
    topRankedOverlayFileVisibleIndex,
    firstSourceBlockIsTopRankedOverlayFile: Boolean(topRankedOverlayFile && topRankedOverlayFileVisibleIndex === 0),
    topRankedOverlayFileMissing: Boolean(topRankedOverlayFile && topRankedOverlayFileVisibleIndex < 0),
    queryClassification,
  };
}

function summarizeContextPackSourceSelection({
  rawQuery = '',
  sourceRankingQuery = rawQuery,
  sourceVisibilityQuery = rawQuery,
  rawBaseText = '',
  sanitizedBaseText = '',
  prioritizedBaseText = '',
  injectedBaseText = '',
  finalText = '',
  overlaySourceBlocks = [],
  overlaySourceFileRankEntries = [],
  contextSourceFileRankEntries = [],
  finalSourceFileRankEntries = [],
} = {}) {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const finalSourceFiles = extractContextPackSourceBlockFiles(finalText);
  const finalSourceSet = new Set(finalSourceFiles.map(normalizeSearchPath));
  const rawBaseSourceFiles = extractContextPackSourceBlockFiles(rawBaseText);
  const sanitizedBaseSourceFiles = extractContextPackSourceBlockFiles(sanitizedBaseText);
  const prioritizedBaseSourceFiles = extractContextPackSourceBlockFiles(prioritizedBaseText);
  const injectedSourceFiles = extractContextPackSourceBlockFiles(injectedBaseText);
  const overlayInjectedFiles = overlaySourceBlocks
    .map(block => normalizeSearchPath(block?.filePath))
    .filter(Boolean);
  const rankedEntriesByPath = new Map();
  for (const entry of [
    ...overlaySourceFileRankEntries,
    ...contextSourceFileRankEntries,
    ...finalSourceFileRankEntries,
  ]) {
    const normalizedFilePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
    if (normalizedFilePath && !rankedEntriesByPath.has(normalizedFilePath)) {
      rankedEntriesByPath.set(normalizedFilePath, entry);
    }
  }

  const visibleSourceFiles = finalSourceFiles
    .slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT)
    .map((filePath, visibleIndex) => contextPackSourceSelectionFileDetail(
      filePath,
      rawQuery,
      queryTerms,
      rankedEntriesByPath.get(normalizeSearchPath(filePath)),
      {
        visibleIndex,
        selected: true,
        origin: overlayInjectedFiles.includes(normalizeSearchPath(filePath)) ? 'overlay-injected-or-retained' : 'base-or-rendered',
      },
    ));

  const rawBaseFilteredSourceFiles = unique(rawBaseSourceFiles.map(normalizeSearchPath))
    .filter(filePath => filePath && !finalSourceSet.has(filePath))
    .slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT)
    .map((filePath, rawBaseIndex) => {
      const entry = rankedEntriesByPath.get(filePath);
      return {
        ...contextPackSourceSelectionFileDetail(filePath, rawQuery, queryTerms, entry, {
          rawBaseIndex,
          selected: false,
        }),
        reason: contextPackSourceSelectionFilterReason(filePath, rawQuery, queryTerms, entry),
      };
    });
  const rawBaseFilteredPathSet = new Set(rawBaseFilteredSourceFiles.map(entry => normalizeSearchPath(entry.filePath)));
  const overlayFilteredSourceFiles = [
    ...overlaySourceFileRankEntries,
    ...contextSourceFileRankEntries,
  ]
    .map((entry, rank) => ({ entry, rank }))
    .filter(({ entry }) => {
      const filePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
      if (!filePath || finalSourceSet.has(filePath) || rawBaseFilteredPathSet.has(filePath)) return false;
      return contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery) > 0;
    })
    .slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT)
    .map(({ entry, rank }) => contextPackSourceSelectionFileDetail(
      entry.filePath ?? entry.normalizedFilePath,
      rawQuery,
      queryTerms,
      entry,
      {
        rank,
        selected: false,
        reason: contextPackSourceSelectionFilterReason(
          entry.filePath ?? entry.normalizedFilePath,
          rawQuery,
          queryTerms,
          entry,
        ),
      },
    ));
  const filteredSourceFiles = [
    ...rawBaseFilteredSourceFiles,
    ...overlayFilteredSourceFiles,
  ].slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT);

  return {
    sourceRankingQuery,
    sourceVisibilityQuery,
    sourceBlockLimit: CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT,
    rawBaseSourceBlockCount: rawBaseSourceFiles.length,
    sanitizedBaseSourceBlockCount: sanitizedBaseSourceFiles.length,
    prioritizedBaseSourceBlockCount: prioritizedBaseSourceFiles.length,
    injectedSourceBlockCount: injectedSourceFiles.length,
    finalSourceBlockCount: finalSourceFiles.length,
    rawBaseSourceFiles: rawBaseSourceFiles.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    sanitizedBaseSourceFiles: sanitizedBaseSourceFiles.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    prioritizedBaseSourceFiles: prioritizedBaseSourceFiles.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    finalSourceFiles: finalSourceFiles.slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    visibleSourceFiles,
    filteredSourceFiles,
    overlayCandidateFiles: overlaySourceFileRankEntries
      .slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT)
      .map((entry, rank) => contextPackSourceSelectionFileDetail(
        entry.filePath ?? entry.normalizedFilePath,
        rawQuery,
        queryTerms,
        entry,
        {
          rank,
          selected: finalSourceSet.has(normalizeSearchPath(entry.filePath ?? entry.normalizedFilePath)),
        },
      )),
    contextCandidateFiles: contextSourceFileRankEntries
      .slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT)
      .map((entry, rank) => contextPackSourceSelectionFileDetail(
        entry.filePath ?? entry.normalizedFilePath,
        rawQuery,
        queryTerms,
        entry,
        {
          rank,
          selected: finalSourceSet.has(normalizeSearchPath(entry.filePath ?? entry.normalizedFilePath)),
        },
      )),
  };
}

function contextPackSourceSelectionFileDetail(filePath, rawQuery, queryTerms, rankedEntry = null, extra = {}) {
  const normalizedFilePath = normalizeSearchPath(filePath);
  const explicitSymbolEvidence = contextPackSourceEntryHasExplicitSymbolEvidence(rankedEntry, rawQuery);
  const preferredSymbolEvidence = contextPackSourceEntryHasPreferredSymbolEvidence(rankedEntry, rawQuery, queryTerms);
  const rawLowValuePenalty = contextPackSourceFileLowValuePenalty(normalizedFilePath, queryTerms, rawQuery);
  return {
    filePath: normalizedFilePath,
    score: Number.isFinite(Number(rankedEntry?.score)) ? Number(rankedEntry.score) : null,
    matchRank: Number.isFinite(Number(rankedEntry?.matchRank)) ? Number(rankedEntry.matchRank) : null,
    nodeRank: Number.isFinite(Number(rankedEntry?.nodeRank)) ? Number(rankedEntry.nodeRank) : null,
    matchScore: Number.isFinite(Number(rankedEntry?.matchScore)) ? Number(rankedEntry.matchScore) : null,
    nodeScore: Number.isFinite(Number(rankedEntry?.nodeScore)) ? Number(rankedEntry.nodeScore) : null,
    pathScore: Number.isFinite(Number(rankedEntry?.pathScore)) ? Number(rankedEntry.pathScore) : null,
    symbolScore: Number.isFinite(Number(rankedEntry?.symbolScore)) ? Number(rankedEntry.symbolScore) : null,
    codeBlockScore: Number.isFinite(Number(rankedEntry?.codeBlockScore)) ? Number(rankedEntry.codeBlockScore) : null,
    sourceBlockScore: Number.isFinite(Number(rankedEntry?.sourceBlockScore)) ? Number(rankedEntry.sourceBlockScore) : null,
    lowValuePenalty: preferredSymbolEvidence ? 0 : rawLowValuePenalty,
    rawLowValuePenalty,
    pathClassLowValue: isLowValueContextPackSourcePath(normalizedFilePath),
    codegraphToolingSource: isCodegraphToolingSourcePath(normalizedFilePath),
    dedupMaintenanceSource: isCodegraphDedupMaintenanceSourcePath(normalizedFilePath),
    explicitSymbolEvidence,
    preferredSymbolEvidence,
    explicitFileRequested: queryExplicitlyRequestsContextPackFilePath(normalizedFilePath, queryTerms),
    explicitSourcePathRequested: queryExplicitlyRequestsContextPackSourcePath(normalizedFilePath, queryTerms),
    ...extra,
  };
}

function contextPackSourceSelectionFilterReason(filePath, rawQuery, queryTerms, rankedEntry = null) {
  const specializedSourceScope = contextPackSpecializedMaintenanceSourceScopeFor(rawQuery);
  if (
    specializedSourceScope
    && !contextPackSourcePathMatchesSpecializedMaintenanceScope(filePath, specializedSourceScope)
  ) {
    return 'specialized-maintenance-unrelated-source';
  }
  if (
    queryMentionsCodegraphToolingSourcePollution(rawQuery)
    && isCodegraphToolingPollutionSourcePath(filePath)
  ) {
    return 'tooling-pollution-source';
  }
  if (
    queryMentionsCodegraphToolingSourcePollution(rawQuery)
    && isTestLikeContextPackSourcePath(filePath)
    && !isCodegraphToolingTestSourcePath(filePath)
  ) {
    return 'tooling-test-source';
  }
  if (
    contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery) > 0
    && !contextPackSourceEntryHasPreferredSymbolEvidence(rankedEntry, rawQuery, queryTerms)
  ) {
    return 'low-value-source-path';
  }
  if (!rankedEntry) {
    return 'not-ranked-by-overlay';
  }
  return 'not-selected-by-source-budget';
}

function contextPackVisibleSourceFileDetails(sourceFiles, rankedOverlayFileEntries, rawQuery = '') {
  const rankedEntriesByPath = new Map(rankedOverlayFileEntries
    .map((entry, index) => [entry.normalizedFilePath, { ...entry, rank: index }])
    .filter(([filePath]) => Boolean(filePath)));
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  return sourceFiles
    .slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT)
    .map((filePath, visibleIndex) => {
      const normalizedFilePath = normalizeSearchPath(filePath);
      const rankedEntry = rankedEntriesByPath.get(normalizedFilePath);
      const explicitSymbolEvidence = contextPackSourceEntryHasExplicitSymbolEvidence(rankedEntry, rawQuery);
      const preferredSymbolEvidence = contextPackSourceEntryHasPreferredSymbolEvidence(rankedEntry, rawQuery, queryTerms);
      const rawLowValuePenalty = rankedEntry?.lowValuePenalty
        ?? contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery);
      const lowValuePenalty = preferredSymbolEvidence ? 0 : rawLowValuePenalty;
      return {
        filePath: normalizedFilePath,
        visibleIndex,
        rankedIndex: rankedEntry?.rank ?? -1,
        lowValuePenalty,
        rawLowValuePenalty,
        pathClassLowValue: isLowValueContextPackSourcePath(filePath),
        codegraphToolingSource: isCodegraphToolingSourcePath(filePath),
        dedupMaintenanceSource: isCodegraphDedupMaintenanceSourcePath(filePath),
        explicitSymbolEvidence,
        preferredSymbolEvidence,
        explicitPathRequested: queryExplicitlyRequestsContextPackFilePath(filePath, queryTerms),
        explicitSourcePathRequested: queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms),
      };
    });
}

function selectContextPackDiagnosticTopRankedOverlayEntry(entries, rawQuery = '', sourceEvidenceEntries = []) {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const preferredCandidates = sourceEvidenceEntries.length > 0
    ? sourceEvidenceEntries
    : entries;
  const preferredEntry = prioritizeContextPackPreferredSymbolEvidence(preferredCandidates, rawQuery, queryTerms).find(entry => (
    contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, queryTerms)
  ));
  if (preferredEntry) {
    return preferredEntry;
  }
  const rawEntry = entries[0] ?? null;
  const rawFile = normalizeSearchPath(rawEntry?.filePath ?? rawEntry?.normalizedFilePath);
  const rawExplicitSourcePath = rawFile
    ? queryExplicitlyRequestsContextPackSourcePath(rawFile, queryTerms)
    : false;
  if (queryMentionsCodegraphTooling(rawQuery) && isCodegraphToolingSourcePath(rawFile) && !rawExplicitSourcePath) {
    const explicitNonToolingEntry = entries.find(entry => {
      const filePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
      return Boolean(filePath)
        && !isCodegraphToolingSourcePath(filePath)
        && queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms);
    });
    if (explicitNonToolingEntry) {
      return explicitNonToolingEntry;
    }
  }
  if (queryMentionsCodegraphDedupMaintenance(rawQuery) && !queryMentionsTests(rawQuery)) {
    const visibleDedupMaintenanceEntry = sourceEvidenceEntries.find(entry => {
      const filePath = normalizeSearchPath(entry?.filePath ?? entry?.normalizedFilePath);
      return Boolean(filePath)
        && isCodegraphDedupMaintenanceSourcePath(filePath)
        && contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery) <= 0;
    });
    if (visibleDedupMaintenanceEntry) {
      return visibleDedupMaintenanceEntry;
    }
  }
  // “直接看 X / inspect X” 式查询：已渲染源码里直接命中显式符号的干净文件
  // 是比 raw overlay 匹配分数更强的 top-ranked 证据（overlay 可能根本没收录该文件）。
  if (!rawEntry?.focusedSymbolEvidence) {
    const focusedVisibleEntry = sourceEvidenceEntries.find(entry => (
      Boolean(entry?.focusedSymbolEvidence)
      && contextPackSourceFileLowValuePenalty(
        entry?.filePath ?? entry?.normalizedFilePath,
        queryTerms,
        rawQuery,
      ) <= 0
    ));
    if (focusedVisibleEntry) {
      return focusedVisibleEntry;
    }
  }
  const cleanEntry = entries.find(entry => (
    contextPackSourceFileLowValuePenalty(entry?.filePath ?? entry?.normalizedFilePath, queryTerms, rawQuery) <= 0
  ));
  return cleanEntry ?? entries[0] ?? null;
}

function contextPackDiagnosticTopRankedOverlaySelectionReason(rawEntry, selectedEntry, rawQuery = '') {
  if (!selectedEntry) {
    return 'none';
  }
  const rawFile = normalizeSearchPath(rawEntry?.filePath ?? rawEntry?.normalizedFilePath);
  const selectedFile = normalizeSearchPath(selectedEntry?.filePath ?? selectedEntry?.normalizedFilePath);
  if (rawFile && selectedFile && rawFile === selectedFile) {
    return 'raw-score-top';
  }
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  if (contextPackSourceEntryHasPreferredSymbolEvidence(selectedEntry, rawQuery, queryTerms)) {
    return 'preferred-symbol-evidence';
  }
  if (selectedEntry?.focusedSymbolEvidence && !rawEntry?.focusedSymbolEvidence) {
    return 'preferred-symbol-evidence';
  }
  if (
    queryMentionsCodegraphTooling(rawQuery)
    && isCodegraphToolingSourcePath(rawFile)
    && !queryExplicitlyRequestsContextPackSourcePath(rawFile, queryTerms)
    && !isCodegraphToolingSourcePath(selectedFile)
    && queryExplicitlyRequestsContextPackSourcePath(selectedFile, queryTerms)
  ) {
    return 'explicit-non-tooling-source-evidence';
  }
  const rawPenalty = contextPackSourceFileLowValuePenalty(rawFile, queryTerms, rawQuery);
  const selectedPenalty = contextPackSourceFileLowValuePenalty(selectedFile, queryTerms, rawQuery);
  if (
    queryMentionsCodegraphDedupMaintenance(rawQuery)
    && !queryMentionsTests(rawQuery)
    && rawPenalty > 0
    && selectedPenalty <= 0
    && isCodegraphDedupMaintenanceSourcePath(selectedFile)
  ) {
    return 'dedup-maintenance-source-evidence';
  }
  if (rawPenalty > 0 && selectedPenalty <= 0) {
    return 'low-value-source-skipped';
  }
  return 'clean-source-fallback';
}

function summarizeContextPackTopRankedOverlayDecision({
  rawEntry,
  selectedEntry,
  rawQuery = '',
  sourceFiles = [],
  selectionReason = 'none',
  baseSourceReorderAllowed = true,
  baseSourceReorderReason = null,
}) {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const rawFile = normalizeSearchPath(rawEntry?.filePath ?? rawEntry?.normalizedFilePath);
  const selectedFile = normalizeSearchPath(selectedEntry?.filePath ?? selectedEntry?.normalizedFilePath);
  const rawDecisionEntry = contextPackTopRankedOverlayDecisionEntry(rawEntry, rawQuery, sourceFiles, queryTerms);
  const selectedDecisionEntry = contextPackTopRankedOverlayDecisionEntry(selectedEntry, rawQuery, sourceFiles, queryTerms);
  const rawLowValuePenalty = rawDecisionEntry?.lowValuePenalty ?? null;
  const selectedLowValuePenalty = selectedDecisionEntry?.lowValuePenalty ?? null;
  const rawCandidateSkippedLowValue = Number(rawLowValuePenalty ?? 0) > 0
    && Number(selectedLowValuePenalty ?? 0) <= 0;
  const selectedOverlayPreferredPenaltyWaived = contextPackSourceFileEntryHasOverlayEvidence(selectedEntry)
    && Number(selectedDecisionEntry?.rawLowValuePenalty ?? 0) > 0
    && Number(selectedLowValuePenalty ?? 0) <= 0;
  const result = {
    rawFile: rawFile || null,
    selectedFile: selectedFile || null,
    selectionReason,
    rawVisibleIndex: rawFile ? sourceFiles.indexOf(rawFile) : -1,
    selectedVisibleIndex: selectedFile ? sourceFiles.indexOf(selectedFile) : -1,
    rawLowValuePenalty,
    selectedLowValuePenalty,
    rawPathClassLowValue: rawFile ? isLowValueContextPackSourcePath(rawFile) : null,
    selectedPathClassLowValue: selectedFile ? isLowValueContextPackSourcePath(selectedFile) : null,
    rawCodegraphToolingSource: rawFile ? isCodegraphToolingSourcePath(rawFile) : null,
    selectedCodegraphToolingSource: selectedFile ? isCodegraphToolingSourcePath(selectedFile) : null,
    rawDedupMaintenanceSource: rawFile ? isCodegraphDedupMaintenanceSourcePath(rawFile) : null,
    selectedDedupMaintenanceSource: selectedFile ? isCodegraphDedupMaintenanceSourcePath(selectedFile) : null,
    skippedLowValue: Boolean(
      rawFile
      && selectedFile
      && rawFile !== selectedFile
      && (rawCandidateSkippedLowValue || selectedOverlayPreferredPenaltyWaived)
    ),
    baseSourceReorderAllowed,
    baseSourceReorderReason,
    queryMentionsTests: queryMentionsTests(rawQuery),
    queryMentionsCodegraphDedupMaintenance: queryMentionsCodegraphDedupMaintenance(rawQuery),
    queryMentionsCodegraphTooling: queryMentionsCodegraphTooling(rawQuery),
    rawEntry: rawDecisionEntry,
    selectedEntry: selectedDecisionEntry,
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined || result[key] === null) {
      delete result[key];
    }
  }
  return result;
}

function contextPackTopRankedOverlayDecisionEntry(entry, rawQuery = '', sourceFiles = [], queryTerms = null) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const terms = queryTerms ?? queryTokens(String(rawQuery ?? '').toLowerCase());
  const filePath = normalizeSearchPath(entry.filePath ?? entry.normalizedFilePath);
  if (!filePath) {
    return null;
  }
  const rawLowValuePenalty = Number.isFinite(Number(entry.lowValuePenalty))
    ? Number(entry.lowValuePenalty)
    : contextPackSourceFileLowValuePenalty(filePath, terms, rawQuery);
  const preferredSymbolEvidence = contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, terms);
  const result = {
    filePath,
    visibleIndex: sourceFiles.indexOf(filePath),
    score: entry.score,
    matchRank: entry.matchRank,
    nodeRank: entry.nodeRank,
    matchScore: entry.matchScore,
    nodeScore: entry.nodeScore,
    pathScore: entry.pathScore,
    symbolScore: entry.symbolScore,
    codeBlockScore: entry.codeBlockScore,
    sourceBlockScore: entry.sourceBlockScore,
    lowValuePenalty: preferredSymbolEvidence ? 0 : rawLowValuePenalty,
    rawLowValuePenalty,
    pathClassLowValue: isLowValueContextPackSourcePath(filePath),
    codegraphToolingSource: isCodegraphToolingSourcePath(filePath),
    dedupMaintenanceSource: isCodegraphDedupMaintenanceSourcePath(filePath),
    explicitSymbolEvidence: contextPackSourceEntryHasExplicitSymbolEvidence(entry, rawQuery),
    preferredSymbolEvidence,
    explicitFileRequested: queryExplicitlyRequestsContextPackFilePath(filePath, terms),
    explicitSourcePathRequested: queryExplicitlyRequestsContextPackSourcePath(filePath, terms),
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined || result[key] === null) {
      delete result[key];
    }
  }
  return result;
}

function countContextPackSourceSections(text) {
  return [...String(text ?? '').matchAll(/^(?:### (?:Source Code|Code)\b|\*\*Source Code\*\*)/gm)].length;
}

function countContextPackMarkdownSectionHeadings(text, sectionName) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(line => matchesContextPackMarkdownSectionHeading(line, sectionName))
    .length;
}

function rankContextPackSourceFiles(nodes, rawQuery = '', matches = []) {
  return new Map(rankContextPackSourceFileEntries(nodes, rawQuery, matches)
    .map((entry, index) => [entry.normalizedFilePath, index]));
}

function rankContextPackSourceFilesForContextText(text, nodes, rawQuery = '', matches = []) {
  return new Map(rankContextPackSourceFileEntriesForContextText(text, nodes, rawQuery, matches)
    .map((entry, index) => [entry.normalizedFilePath, index]));
}

function rankContextPackSourceFileEntriesForContextText(text, nodes, rawQuery = '', matches = []) {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const entries = new Map();
  for (const entry of rankContextPackSourceFileEntries(nodes, rawQuery, matches)) {
    entries.set(entry.normalizedFilePath, {
      ...entry,
      sourceBlockRank: Number.MAX_SAFE_INTEGER,
      sourceBlockScore: 0,
    });
  }

  for (const sourceEntry of scoreContextPackSourceBlockFiles(text, rawQuery, queryTerms)) {
    const previous = entries.get(sourceEntry.normalizedFilePath) ?? {
      filePath: sourceEntry.filePath,
      normalizedFilePath: sourceEntry.normalizedFilePath,
      groupedNodes: [],
      score: 0,
      matchRank: Number.MAX_SAFE_INTEGER,
      nodeRank: Number.MAX_SAFE_INTEGER,
      matchScore: 0,
      nodeScore: 0,
      pathScore: 0,
      symbolScore: 0,
      codeBlockScore: 0,
      lowValuePenalty: sourceEntry.lowValuePenalty,
      sourceBlockRank: Number.MAX_SAFE_INTEGER,
      sourceBlockScore: 0,
    };
    const hasOverlayEvidence = Array.isArray(previous.groupedNodes) && previous.groupedNodes.length > 0;
    const sourceBlockEvidenceBoost = hasOverlayEvidence && sourceEntry.lowValuePenalty <= 0
      ? Math.min(120_000, Math.max(0, sourceEntry.sourceBlockScore))
      : 0;
    entries.set(sourceEntry.normalizedFilePath, {
      ...previous,
      filePath: previous.filePath || sourceEntry.filePath,
      score: hasOverlayEvidence
        ? previous.score + sourceBlockEvidenceBoost
        : Math.max(previous.score, sourceEntry.score),
      pathScore: Math.max(previous.pathScore ?? 0, sourceEntry.pathScore),
      lowValuePenalty: Math.max(previous.lowValuePenalty ?? 0, sourceEntry.lowValuePenalty ?? 0),
      sourceBlockRank: Math.min(previous.sourceBlockRank ?? Number.MAX_SAFE_INTEGER, sourceEntry.rank),
      sourceBlockScore: Math.max(previous.sourceBlockScore ?? 0, sourceEntry.sourceBlockScore),
      focusedSymbolEvidence: Boolean(previous.focusedSymbolEvidence) || Boolean(sourceEntry.focusedSymbolEvidence),
    });
  }

  return [...entries.values()]
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score
      || a.sourceBlockRank - b.sourceBlockRank
      || a.matchRank - b.matchRank
      || a.nodeRank - b.nodeRank
      || a.filePath.localeCompare(b.filePath));
}

function contextPackSourceFileEntryHasOverlayEvidence(entry) {
  return (Array.isArray(entry?.groupedNodes) && entry.groupedNodes.length > 0)
    || Number(entry?.matchScore ?? 0) > 0
    || Number(entry?.nodeScore ?? 0) > 0
    || Number(entry?.symbolScore ?? 0) > 0
    || Number(entry?.codeBlockScore ?? 0) > 0;
}

function rankContextPackSourceFileEntries(nodes, rawQuery = '', matches = []) {
  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const matchFileScores = scoreContextPackMatchFiles(matches, queryTerms);
  const nodeFileScores = scoreContextPackNodeFiles(nodes, queryTerms);
  const files = new Map();

  for (const [filePath, groupedNodes] of groupContextPackSourceEvidenceByFile(nodes, matches)) {
    if (!filePath || filePath === '(unknown)') continue;
    const normalizedFilePath = normalizeSearchPath(filePath);
    if (!normalizedFilePath || !isRenderableContextPackSourcePath(normalizedFilePath)) continue;
    files.set(normalizedFilePath, {
      filePath,
      normalizedFilePath,
      groupedNodes,
    });
  }

  for (const normalizedFilePath of matchFileScores.keys()) {
    if (!files.has(normalizedFilePath)) {
      files.set(normalizedFilePath, {
        filePath: normalizedFilePath,
        normalizedFilePath,
        groupedNodes: [],
      });
    }
  }

  return [...files.values()]
    .map(entry => ({
      ...entry,
      ...scoreContextPackSourceFile(
        entry.filePath,
        entry.groupedNodes,
        queryTerms,
        matchFileScores,
        nodeFileScores,
        rawQuery,
      ),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score
      || a.matchRank - b.matchRank
      || a.nodeRank - b.nodeRank
      || a.filePath.localeCompare(b.filePath));
}

function scoreContextPackSourceFile(filePath, nodes, queryTerms, matchFileScores, nodeFileScores, rawQuery = '') {
  const normalizedFilePath = normalizeSearchPath(filePath);
  const matchDetails = matchFileScores.get(normalizedFilePath) ?? createEmptyContextPackFileScore();
  const nodeDetails = nodeFileScores.get(normalizedFilePath) ?? createEmptyContextPackFileScore();
  const pathScore = scorePathTermMatch(filePath, queryTerms);
  const symbolScore = scoreContextPackSourceFileSymbols(nodes, queryTerms);
  const resourceRelationScore = scoreContextPackResourceRelationFile(nodes, queryTerms);
  const codeBlockScore = scoreContextPackCodeBlockSourceFile(nodes, queryTerms);
  const lowValuePenalty = contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery);
  const score = matchDetails.score
    + nodeDetails.score
    + pathScore
    + symbolScore
    + resourceRelationScore
    + codeBlockScore
    - lowValuePenalty;
  return {
    score,
    matchRank: matchDetails.rank,
    nodeRank: nodeDetails.rank,
      matchScore: matchDetails.score,
      nodeScore: nodeDetails.score,
      pathScore,
      symbolScore,
      codeBlockScore,
      sourceBlockScore: 0,
      lowValuePenalty,
    };
}

function scoreContextPackCodeBlockSourceFile(nodes, queryTerms) {
  const codeBlockNodes = (Array.isArray(nodes) ? nodes : [])
    .filter(node => node?.metadata?.contextPackCodeBlock === true);
  if (codeBlockNodes.length === 0) {
    return 0;
  }

  let score = 80_000;
  for (const node of codeBlockNodes) {
    score += 10_000;
    if (contextPackNodeMatchesQueryTerms(node, queryTerms)) {
      score += 80_000;
    }
    const startLine = Number(node?.startLine);
    const endLine = Number(node?.endLine);
    if (Number.isInteger(startLine) && Number.isInteger(endLine) && endLine >= startLine) {
      score += Math.min(20_000, Math.max(0, endLine - startLine + 1) * 100);
    }
  }
  return score;
}

function scoreContextPackResourceRelationFile(nodes, queryTerms) {
  const requestedRelations = requestedContextPackResourceRelations(queryTerms);
  if (requestedRelations.size === 0) return 0;
  return nodes.some(node => requestedRelations.has(normalizeContextPackResourceRelation(node?.metadata?.relation)))
    ? 350
    : 0;
}

function requestedContextPackResourceRelations(queryTerms) {
  const requested = new Set();
  for (const term of queryTerms) {
    const relation = normalizeContextPackResourceRelation(term);
    if (CONTEXT_PACK_BASE_SOURCE_FILTER_RELATIONS.has(relation)) {
      requested.add(relation);
    }
  }
  return requested;
}

function normalizeContextPackResourceRelation(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'styleurl') return 'style-url';
  if (normalized === 'templateurl') return 'template-url';
  return normalized;
}

function scoreContextPackSourceBlockFiles(text, rawQuery = '', queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase())) {
  const sourceSection = findContextPackSourceSection(text);
  if (!sourceSection || sourceSection.blocksStart < 0) {
    return [];
  }

  const explicitTerms = explicitContextPackQueryTerms(rawQuery);
  const focusedTerms = focusedExplicitContextPackQueryTerms(rawQuery, explicitTerms);
  const chunks = splitContextPackSourceBlockChunks(text.slice(sourceSection.blocksStart, sourceSection.end));
  return chunks
    .map((chunk, index) => {
      const filePath = extractContextPackSourceBlockFile(chunk);
      const normalizedFilePath = normalizeSearchPath(filePath);
      if (!normalizedFilePath || !isRenderableContextPackSourcePath(normalizedFilePath)) {
        return null;
      }
      const pathScore = scorePathTermMatch(filePath, queryTerms);
      const explicitScore = scoreContextPackSourceBlockExplicitTerms(
        chunk,
        focusedTerms,
        explicitTerms,
        queryTerms,
      );
      const sourceBlockScore = explicitScore + pathScore;
      const lowValuePenalty = contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery);
      const score = sourceBlockScore - lowValuePenalty;
      return {
        filePath,
        normalizedFilePath,
        rank: index,
        score,
        pathScore,
        sourceBlockScore,
        focusedSymbolEvidence: contextPackSourceBlockHasFocusedSymbolEvidence(chunk, focusedTerms),
        lowValuePenalty,
      };
    })
    .filter(entry => entry && entry.score > 0);
}

// 判断可见源码块 header 是否直接命中“直接看/inspect/show X”式聚焦符号；
// 该证据允许诊断 top-ranked 选择采信已渲染的显式请求源码，而不是 raw overlay 分数。
function contextPackSourceBlockHasFocusedSymbolEvidence(chunk, focusedTerms = []) {
  if (!Array.isArray(focusedTerms) || focusedTerms.length === 0) {
    return false;
  }
  const header = String(chunk ?? '').split(/\r?\n/, 1)[0] ?? '';
  const normalizedHeader = header.toLowerCase();
  const headerSegments = new Set(splitSearchSignalSegments(header)
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2)
    .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment)));
  return focusedTerms.some(term => {
    if (normalizedHeader.includes(term)) {
      return true;
    }
    const termSegments = splitSearchSignalSegments(term)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2)
      .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment));
    return termSegments.length >= 2 && termSegments.every(segment => headerSegments.has(segment));
  });
}

function explicitContextPackQueryTerms(rawQuery = '') {
  return unique(String(rawQuery ?? '')
    .split(/[^a-z0-9_$:.@/\\-]+/i)
    .map(term => term.trim())
    .filter(term => term.length >= 2)
    .filter(term => !isContextPackResourceRelationTerm(term))
    .filter(term => isExplicitPathTerm(term) || isLikelyExplicitSymbolTerm(term))
    .map(term => term.toLowerCase()));
}

function focusedExplicitContextPackQueryTerms(rawQuery = '', explicitTerms = explicitContextPackQueryTerms(rawQuery)) {
  const query = String(rawQuery ?? '').toLowerCase();
  return explicitTerms.filter(term => {
    const index = query.indexOf(term);
    if (index < 0) return false;
    const prefix = query.slice(Math.max(0, index - 24), index);
    return /(直接看|查看|看|定位|打开|源码|定义|inspect|show|source)\s*$/.test(prefix);
  });
}

function isLikelyExplicitSymbolTerm(term) {
  const value = String(term ?? '');
  if (value.length < 6) return false;
  if (value.includes('::')) return true;
  if (/^[A-Z][A-Z0-9_$]*(?:[.:][A-Z][A-Z0-9_$]*)+$/.test(value)) return true;
  return /[a-z0-9][A-Z]/.test(value) || /[A-Z]{2,}[a-z]/.test(value);
}

function scoreContextPackSourceBlockExplicitTerms(chunk, focusedTerms, explicitTerms, queryTerms = []) {
  if (explicitTerms.length === 0) {
    const header = String(chunk ?? '').split(/\r?\n/, 1)[0] ?? '';
    return scoreContextPackSourceBlockQueryTermCoverage(header, queryTerms);
  }

  const header = String(chunk ?? '').split(/\r?\n/, 1)[0] ?? '';
  const normalizedHeader = header.toLowerCase();
  const headerSegments = new Set(splitSearchSignalSegments(header)
    .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2)
      .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment)));
  let score = 0;
  const focusedSet = new Set(focusedTerms);
  for (const term of focusedTerms) {
    if (normalizedHeader.includes(term)) {
      score += 100_000 + term.length;
      continue;
    }
    const termSegments = splitSearchSignalSegments(term)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2)
      .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment));
    if (termSegments.length >= 2 && termSegments.every(segment => headerSegments.has(segment))) {
      score += 40_000 + term.length;
    }
  }
  for (const term of explicitTerms) {
    if (focusedSet.has(term)) continue;
    if (normalizedHeader.includes(term)) {
      score += 5_000 + term.length;
      continue;
    }
    const termSegments = splitSearchSignalSegments(term)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2)
      .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment));
    if (termSegments.length >= 2 && termSegments.every(segment => headerSegments.has(segment))) {
      score += 2_000 + term.length;
    }
  }
  return score + scoreContextPackSourceBlockQueryTermCoverage(header, queryTerms);
}

function scoreContextPackSourceBlockQueryTermCoverage(header, queryTerms = []) {
  const headerText = String(header ?? '');
  if (!headerText) {
    return 0;
  }
  const normalizedHeader = headerText.toLowerCase();
  const compactHeader = normalizedHeader.replace(/[^a-z0-9_$]+/g, '');
  const headerSegments = new Set(splitSearchSignalSegments(headerText)
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2)
    .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment)));
  const seenTerms = new Set();
  let score = 0;
  for (const term of queryTerms) {
    const normalizedTerm = String(term ?? '').trim().toLowerCase();
    const compactTerm = normalizedTerm.replace(/[^a-z0-9_$]+/g, '');
    if (compactTerm.length < 6 || seenTerms.has(compactTerm) || CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(compactTerm)) {
      continue;
    }
    if (compactHeader.includes(compactTerm)) {
      score += 12_000 + Math.min(2_000, compactTerm.length * 10);
      seenTerms.add(compactTerm);
      continue;
    }

    const termSegments = splitSearchSignalSegments(normalizedTerm)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2)
      .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment));
    if (termSegments.length >= 2 && termSegments.every(segment => headerSegments.has(segment))) {
      score += 3_000 + Math.min(1_000, termSegments.length * 120);
      seenTerms.add(compactTerm);
    }
  }
  return score;
}

function scoreContextPackSourceFileSymbols(nodes, queryTerms) {
  let score = 0;
  for (const node of nodes) {
    const name = String(node.name ?? '').toLowerCase();
    const qualifiedName = String(node.qualifiedName ?? '').toLowerCase();
    const nameSegments = new Set(searchPathSignalSegments(node.name));
    const qualifiedSegments = new Set(searchPathSignalSegments(node.qualifiedName));
    score += scoreContextPackCompoundSymbolCoverage(node.name, queryTerms);
    score += scoreContextPackCompoundSymbolCoverage(node.qualifiedName, queryTerms);
    score += scoreContextPackCompoundSymbolCoverage(node?.metadata?.matchedNeedle, queryTerms);
    if (queryTerms.some(term => term === name || term === qualifiedName)) {
      score += 160;
    }
    for (const term of queryTerms) {
      const termSegments = searchPathSignalSegments(term);
      if (termSegments.length === 0) continue;
      if (name.includes(term) || qualifiedName.includes(term)) {
        score += 30;
      }
      if (termSegments.every(segment => nameSegments.has(segment) || qualifiedSegments.has(segment))) {
        score += 50;
      }
    }
  }
  return score;
}

function scoreContextPackCompoundSymbolCoverage(value, queryTerms) {
  const querySegmentSet = new Set(queryTerms
    .flatMap(term => splitSearchSignalSegments(term))
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2));
  if (querySegmentSet.size < 2) return 0;

  const symbolText = String(value ?? '');
  if (!symbolText) return 0;
  let score = 0;
  const parts = symbolText.split(/[.:]+/);
  for (const part of parts) {
    const segments = splitSearchSignalSegments(part)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2);
    if (segments.length < 2) continue;
    if (segments.every(segment => querySegmentSet.has(segment))) {
      const meaningfulSegments = segments.filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment));
      score += 8_000 + meaningfulSegments.length * 250 + part.length;
      continue;
    }
    const meaningfulSegments = segments.filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment));
    if (meaningfulSegments.length >= 2 && meaningfulSegments.every(segment => querySegmentSet.has(segment))) {
      score += 4_000 + meaningfulSegments.length * 200 + part.length;
    }
  }
  return score;
}

function scoreContextPackMatchFiles(matches, queryTerms) {
  const scores = new Map();
  matches.forEach((match, index) => {
    const filePath = readContextPackMatchFile(match);
    const normalizedFilePath = normalizeSearchPath(filePath);
    if (!normalizedFilePath || !isRenderableContextPackSourcePath(normalizedFilePath)) return;
    const explicitPathScore = scorePathTermMatch(filePath, queryTerms);
    const matchScore = Number.isFinite(Number(match?.score)) ? Number(match.score) : 0;
    const kindScore = scoreContextPackMatchKind(match?.kind);
    const nameScore = scoreContextPackMatchName(match, queryTerms);
    const score = 12000
      + Math.max(0, 3000 - index * 120)
      + Math.min(2000, Math.round(matchScore * 25))
      + kindScore
      + nameScore
      + explicitPathScore;
    mergeContextPackFileScore(scores, normalizedFilePath, {
      score,
      rank: index,
    });
  });
  return scores;
}

function scoreContextPackNodeFiles(nodes, queryTerms) {
  const scores = new Map();
  nodes.forEach((node, index) => {
    const normalizedFilePath = normalizeSearchPath(node?.filePath);
    if (!normalizedFilePath || !isRenderableContextPackSourcePath(normalizedFilePath)) return;
    const pathScore = scorePathTermMatch(node.filePath, queryTerms);
    const symbolScore = scoreContextPackSourceFileSymbols([node], queryTerms);
    const kindScore = scoreContextPackNodeKind(node?.kind);
    const score = Math.max(0, 2400 - index * 20)
      + pathScore
      + symbolScore
      + kindScore;
    mergeContextPackFileScore(scores, normalizedFilePath, {
      score,
      rank: index,
    });
  });
  return scores;
}

function mergeContextPackFileScore(scores, normalizedFilePath, next) {
  const previous = scores.get(normalizedFilePath) ?? createEmptyContextPackFileScore();
  scores.set(normalizedFilePath, {
    score: Math.max(previous.score, next.score),
    rank: Math.min(previous.rank, next.rank),
  });
}

function createEmptyContextPackFileScore() {
  return {
    score: 0,
    rank: Number.MAX_SAFE_INTEGER,
  };
}

function scoreContextPackMatchKind(kind) {
  const normalized = String(kind ?? '').toLowerCase();
  if (normalized.includes('component') || normalized.includes('route') || normalized.includes('migration')) return 500;
  if (normalized === 'class' || normalized === 'function' || normalized === 'method') return 420;
  if (normalized === 'constant' || normalized === 'type_alias' || normalized === 'interface') return 360;
  if (normalized === 'file' || normalized === 'export') return 280;
  return 120;
}

function scoreContextPackNodeKind(kind) {
  const normalized = String(kind ?? '').toLowerCase();
  if (normalized === 'class' || normalized === 'component' || normalized === 'function' || normalized === 'method') return 180;
  if (normalized === 'constant' || normalized === 'type_alias' || normalized === 'interface') return 130;
  if (normalized === 'file') return 80;
  if (normalized === 'import' || normalized === 'export') return 10;
  return 50;
}

function scoreContextPackMatchName(match, queryTerms) {
  const rawMatchName = String(match?.name ?? match?.item?.className ?? match?.item?.name ?? '');
  const matchName = rawMatchName.toLowerCase();
  if (!matchName) return 0;
  const matchSegments = new Set(searchPathSignalSegments(rawMatchName));
  let score = scoreContextPackCompoundSymbolCoverage(rawMatchName, queryTerms);
  for (const term of queryTerms.filter(term => !isContextPackResourceRelationTerm(term))) {
    if (matchName === term) {
      score += 260;
    } else if (matchName.includes(term)) {
      score += 90;
    }
    const termSegments = searchPathSignalSegments(term);
    if (termSegments.length > 0 && termSegments.every(segment => matchSegments.has(segment))) {
      score += 140;
    }
  }
  return score;
}

function groupContextPackSourceEvidenceByFile(nodes, matches = []) {
  const byFile = new Map();
  for (const node of nodes) {
    appendContextPackSourceEvidence(byFile, node?.filePath || '(unknown)', node);
  }
  for (const match of matches) {
    const node = contextPackNodeFromMatch(match);
    if (node) {
      appendContextPackSourceEvidence(byFile, node.filePath, node);
    }
  }
  return [...byFile.entries()]
    .map(([filePath, group]) => [filePath, group.sort(compareGraphNode)])
    .sort(([a], [b]) => a.localeCompare(b));
}

function appendContextPackSourceEvidence(byFile, filePath, node) {
  if (!node) return;
  const normalizedFilePath = normalizeSearchPath(filePath);
  if (!normalizedFilePath || !isRenderableContextPackSourcePath(normalizedFilePath)) return;
  const group = byFile.get(filePath) ?? [];
  if (!group.some(existing => isSameContextPackSourceEvidence(existing, node, filePath))) {
    group.push(node);
  }
  byFile.set(filePath, group);
}

function isSameContextPackSourceEvidence(a, b, fallbackFilePath = '') {
  const sameSymbol = String(a?.kind ?? '') === String(b?.kind ?? '')
    && String(a?.name ?? '') === String(b?.name ?? '')
    && String(a?.qualifiedName ?? '') === String(b?.qualifiedName ?? '')
    && normalizeSearchPath(a?.filePath ?? fallbackFilePath) === normalizeSearchPath(b?.filePath ?? fallbackFilePath);
  if (!sameSymbol) return false;
  const aLine = a?.startLine ?? null;
  const bLine = b?.startLine ?? null;
  return aLine === bLine || aLine === null || bLine === null;
}

function contextPackNodeFromMatch(match) {
  const filePath = readContextPackMatchFile(match);
  if (!filePath || !isRenderableContextPackSourcePath(filePath)) return null;
  const item = match?.item ?? {};
  return {
    id: item.id ?? `match:${match?.kind ?? 'match'}:${filePath}:${match?.name ?? item.name ?? item.className ?? ''}`,
    kind: match?.kind ?? item.kind ?? 'match',
    name: match?.name ?? item.className ?? item.name ?? filePath,
    qualifiedName: item.qualifiedName ?? match?.name ?? item.className ?? item.name ?? filePath,
    filePath,
    language: item.language ?? inferLanguage(filePath),
    startLine: item.startLine ?? item.line,
    endLine: item.endLine ?? item.line,
  };
}

function readContextPackMatchFile(match) {
  return match?.file
    ?? match?.item?.file
    ?? match?.item?.filePath
    ?? match?.item?.entry
    ?? match?.item?.target
    ?? '';
}

function inferLanguage(filePath) {
  const normalized = String(filePath ?? '').toLowerCase();
  if (/\.(ts|mts|cts)$/.test(normalized)) return 'typescript';
  if (/\.tsx$/.test(normalized)) return 'tsx';
  if (/\.(js|mjs|cjs)$/.test(normalized)) return 'javascript';
  if (/\.jsx$/.test(normalized)) return 'jsx';
  if (/\.kts?$/.test(normalized)) return 'kotlin';
  if (/\.xml$/.test(normalized)) return 'xml';
  if (/\.json$/.test(normalized)) return 'json';
  if (/\.(md|mdx)$/.test(normalized)) return 'markdown';
  if (/\.(html|htm)$/.test(normalized)) return 'html';
  if (/\.(css|scss|sass|less)$/.test(normalized)) return 'css';
  if (/\.sql$/.test(normalized)) return 'sql';
  return 'text';
}

function queryTokens(query) {
  const rawQuery = String(query ?? '');
  const rawTerms = rawQuery
    .split(/[^a-z0-9_$:.@/\\-]+/i)
    .flatMap(term => String(term).split('/'))
    .map(term => term.trim())
    .filter(Boolean);
  return unique([
    ...rawTerms,
    ...rawTerms.flatMap(term => splitSearchSignalSegments(term)),
    ...localizedContextPackQueryAliases(rawQuery),
  ]
    .map(term => term.trim().toLowerCase())
    .flatMap(expandQueryTokenAliases)
    .filter(term => term.length >= 2));
}

function localizedContextPackQueryAliases(query) {
  const text = String(query ?? '');
  return unique(CONTEXT_PACK_LOCALIZED_QUERY_ALIASES
    .filter(entry => entry.pattern.test(text))
    .flatMap(entry => entry.aliases));
}

function contextPackSearchSignalSegments(queryTerms = []) {
  return queryTerms
    .flatMap(term => splitSearchSignalSegments(term))
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2);
}

// 聚焦查询必须基于原始词序列构建，避免 queryTokens 的分段扩展把
// `edge-function-invoke` 这类精确 relation token 稀释成松散片段；
// 词条统一小写以保持聚焦输出与既有 baseQuery 合同一致。
function contextPackRawQueryTerms(rawQuery = '') {
  const query = String(rawQuery ?? '');
  return unique([
    ...query
      .split(/[^a-z0-9_$:.@/\\-]+/i)
      .map(term => term.trim())
      .filter(term => term.length >= 2),
    ...localizedContextPackQueryAliases(query),
  ].map(term => term.toLowerCase()));
}

// NanoFlow metadata.relation / testMapping 词汇族（kebab-case 首段）；
// 只有这些族的 kebab 词条在聚焦时保持完整，避免 `edge-function-source`、
// `config-source` 等 relation token 被噪声段拆散，同时 `stale-smoke` 这类
// 普通工具词仍按噪声分段收敛。
const EXACT_RELATION_QUERY_TERM_FAMILIES = new Set([
  'android',
  'angular',
  'class',
  'commonjs',
  'config',
  'context7',
  'control',
  'dynamic',
  'edge',
  'external',
  'filename',
  'hard',
  'host',
  'invoke',
  'local',
  'migration',
  'nested',
  'object',
  'path',
  'policy',
  'privilege',
  'route',
  'same',
  'style',
  'supabase',
  'sync',
  'template',
  'type',
]);

function isExactRelationQueryTerm(term) {
  const value = String(term ?? '').toLowerCase();
  if (!/^[a-z0-9$_]+(?:-[a-z0-9$_]+)+$/.test(value)) {
    return false;
  }
  return EXACT_RELATION_QUERY_TERM_FAMILIES.has(value.split('-', 1)[0]);
}

function contextPackFocusedQueryTerms(queryTerms = [], noiseSegments = new Set()) {
  return unique(queryTerms.flatMap(term => {
    const segments = splitSearchSignalSegments(term)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2);
    if (segments.length === 0) return [];
    const signalSegments = segments.filter(segment => !noiseSegments.has(segment));
    if (signalSegments.length === 0) return [];
    if (
      signalSegments.length < segments.length
      && !isExplicitPathTerm(term)
      && !isExactRelationQueryTerm(term)
      && !isCodegraphToolingScriptNameTerm(term, segments)
    ) {
      return signalSegments;
    }
    return [term];
  }));
}

// `codegraph-nanoflow-mcp-stdio` / `codegraph-adapter-doctor` 这类复合脚本名
// 是显式文件排序信号；聚焦去噪时必须整词保留，不能被 codegraph/nanoflow
// 噪声段拆成松散片段而丢失显式命名的 wrapper 排序优先级。
function isCodegraphToolingScriptNameTerm(term, precomputedSegments = null) {
  if (!/[-_.]/.test(String(term ?? ''))) return false;
  const segments = Array.isArray(precomputedSegments)
    ? precomputedSegments
    : splitSearchSignalSegments(term)
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2);
  if (segments.length < 2) return false;
  const hasCodegraphAnchor = segments.some(segment => (
    segment === 'codegraph' || segment === 'nanoflow' || segment === 'codex'
  ));
  const hasToolingIntent = segments.some(segment => CONTEXT_PACK_OVERLAY_TOOLING_INTENT_SEGMENTS.has(segment));
  return hasCodegraphAnchor && hasToolingIntent;
}

function contextPackIssueRegistryQueryFor(rawQuery = '', queryTerms = queryTokens(rawQuery)) {
  const query = String(rawQuery ?? '').toLowerCase();
  if (query.includes('codegraph-nanoflow-adaptation-issues')) {
    return CONTEXT_PACK_ISSUE_REGISTRY_FOCUSED_QUERY;
  }

  const querySegments = contextPackSearchSignalSegments(queryTerms);
  const hasAdapterAnchor = querySegments.some(segment => (
    CONTEXT_PACK_ISSUE_REGISTRY_ANCHOR_SEGMENTS.has(segment)
  ));
  const hasIssueRegistryIntent = querySegments.some(segment => (
    CONTEXT_PACK_ISSUE_REGISTRY_INTENT_SEGMENTS.has(segment)
  ));
  const hasStatusOrDocIntent = querySegments.some(segment => (
    CONTEXT_PACK_ISSUE_REGISTRY_STATUS_SEGMENTS.has(segment)
  ));

  return hasAdapterAnchor && hasIssueRegistryIntent && hasStatusOrDocIntent
    ? CONTEXT_PACK_ISSUE_REGISTRY_FOCUSED_QUERY
    : '';
}

function contextPackIssueRegistrySourceNodeFor(rawQuery = '') {
  if (!contextPackIssueRegistryQueryFor(rawQuery)) {
    return null;
  }

  const filePath = 'docs/codegraph-nanoflow-adaptation-issues.md';
  const absolutePath = resolveProjectFilePath(filePath);
  if (!absolutePath) {
    return null;
  }

  let sourceLines;
  try {
    sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
  if (sourceLines.length === 0) {
    return null;
  }

  const focusRange = contextPackIssueRegistryFocusRange(sourceLines, rawQuery);
  return {
    id: `file:${filePath}`,
    kind: 'file',
    name: 'codegraph-nanoflow-adaptation-issues.md',
    qualifiedName: filePath,
    filePath,
    language: 'markdown',
    startLine: focusRange.startLine,
    endLine: focusRange.endLine,
  };
}

function contextPackIssueRegistryFocusRange(sourceLines, rawQuery = '') {
  const startLine = contextPackIssueRegistryFocusLine(sourceLines, rawQuery);
  const lineText = String(sourceLines[startLine - 1] ?? '');
  const query = String(rawQuery ?? '').toLowerCase();
  const asksOpenAndFixed = /\bopen(?:ed)?\b/.test(query) && /\bfixed\b/.test(query);
  const headingLines = [];
  for (let index = startLine; index < sourceLines.length; index += 1) {
    if (/^##\s+/.test(String(sourceLines[index] ?? ''))) {
      headingLines.push(index + 1);
    }
  }

  let sectionEndExclusive = sourceLines.length + 1;
  if (/^##\s+Open Issues\b/i.test(lineText)) {
    sectionEndExclusive = headingLines[0] ?? sectionEndExclusive;
  } else if (asksOpenAndFixed && /^##\s+CG-NF-\d{8}-\d+\b/i.test(lineText)) {
    const nextAfterSecondIssue = headingLines.find((lineNumber, index) => (
      index > 0 || !/^##\s+CG-NF-\d{8}-\d+\b/i.test(String(sourceLines[lineNumber - 1] ?? ''))
    ));
    sectionEndExclusive = nextAfterSecondIssue ?? sectionEndExclusive;
  } else {
    sectionEndExclusive = headingLines[0] ?? sectionEndExclusive;
  }

  const sectionEndLine = Math.max(startLine, sectionEndExclusive - 1);
  return {
    startLine,
    endLine: Math.min(sourceLines.length, sectionEndLine, startLine + 60),
  };
}

function contextPackIssueRegistryFocusLine(sourceLines, rawQuery = '') {
  const query = String(rawQuery ?? '').toLowerCase();
  const explicitIssueId = /cg-nf-\d{8}-\d+/i.exec(query)?.[0]?.toUpperCase();
  const templateIndex = sourceLines.findIndex(line => /^##\s+Entry Template\b/i.test(String(line ?? '')));
  const searchEnd = templateIndex >= 0 ? templateIndex : sourceLines.length;
  const issueHeadings = [];
  for (let index = 0; index < searchEnd; index += 1) {
    const line = String(sourceLines[index] ?? '');
    if (/^##\s+CG-NF-\d{8}-\d+\b/.test(line)) {
      issueHeadings.push(index + 1);
    }
  }
  if (issueHeadings.length === 0) {
    return 1;
  }

  if (explicitIssueId) {
    const explicitLine = issueHeadings.find(lineNumber => (
      String(sourceLines[lineNumber - 1] ?? '').toUpperCase().includes(explicitIssueId)
    ));
    if (explicitLine) {
      return explicitLine;
    }
  }

  const asksOpen = /\bopen(?:ed)?\b/.test(query);
  const asksFixed = /\bfixed\b/.test(query);
  if (asksOpen && asksFixed && issueHeadings.length > 1) {
    return issueHeadings.at(-2);
  }

  if (asksOpen && !asksFixed) {
    const matchingHeading = findLastIssueHeadingWithStatus(sourceLines, issueHeadings, searchEnd, 'open');
    if (matchingHeading) {
      return matchingHeading;
    }
    const openIssuesIndex = sourceLines.findIndex(line => /^##\s+Open Issues\b/i.test(String(line ?? '')));
    if (openIssuesIndex >= 0) {
      return openIssuesIndex + 1;
    }
  }

  if (asksFixed) {
    const matchingHeading = findLastIssueHeadingWithStatus(sourceLines, issueHeadings, searchEnd, 'fixed');
    if (matchingHeading) {
      return matchingHeading;
    }
  }

  return issueHeadings.at(-1);
}

function findLastIssueHeadingWithStatus(sourceLines, issueHeadings, searchEnd, status) {
  const expected = `- status: ${status}`;
  for (let index = issueHeadings.length - 1; index >= 0; index -= 1) {
    const startLine = issueHeadings[index];
    const nextHeadingLine = issueHeadings[index + 1] ?? (searchEnd + 1);
    const block = sourceLines.slice(startLine - 1, nextHeadingLine - 1);
    if (block.some(line => String(line ?? '').trim().toLowerCase() === expected)) {
      return startLine;
    }
  }
  return null;
}

function augmentContextPackIssueRegistryOverlay(nanoFlowOverlay, rawQuery = '') {
  const issueRegistryNode = contextPackIssueRegistrySourceNodeFor(rawQuery);
  if (!issueRegistryNode || !nanoFlowOverlay) {
    return;
  }

  const prependNode = (nodes) => {
    const existingNodes = Array.isArray(nodes) ? nodes : [];
    const normalizedIssuePath = normalizeSearchPath(issueRegistryNode.filePath);
    if (existingNodes.some(node => normalizeSearchPath(node?.filePath) === normalizedIssuePath)) {
      return existingNodes;
    }
    return [issueRegistryNode, ...existingNodes];
  };
  const prependMatch = (matches) => {
    const existingMatches = Array.isArray(matches) ? matches : [];
    const normalizedIssuePath = normalizeSearchPath(issueRegistryNode.filePath);
    if (existingMatches.some(match => normalizeSearchPath(match?.file) === normalizedIssuePath)) {
      return existingMatches;
    }
    return [{
      kind: issueRegistryNode.kind,
      name: issueRegistryNode.name,
      file: issueRegistryNode.filePath,
      item: issueRegistryNode,
      score: Number.MAX_SAFE_INTEGER,
    }, ...existingMatches];
  };

  nanoFlowOverlay.nodes = prependNode(nanoFlowOverlay.nodes);
  nanoFlowOverlay.matches = prependMatch(nanoFlowOverlay.matches);
  if (nanoFlowOverlay.data && typeof nanoFlowOverlay.data === 'object') {
    nanoFlowOverlay.data.nodes = prependNode(nanoFlowOverlay.data.nodes);
    nanoFlowOverlay.data.matches = prependMatch(nanoFlowOverlay.data.matches);
  }
}

function contextPackExploreQueryFor(rawQuery = '') {
  const query = String(rawQuery ?? '').trim();
  if (!query) return query;
  const queryTerms = queryTokens(query);
  const issueRegistryQuery = contextPackIssueRegistryQueryFor(query, queryTerms);
  if (issueRegistryQuery) return issueRegistryQuery;
  if (explicitContextPackQueryTerms(query).some(isExplicitPathTerm)) return query;
  const lifecycleTestEvidenceQuery = contextPackLifecycleTestEvidenceQueryFor(query, queryTerms);
  if (lifecycleTestEvidenceQuery) return lifecycleTestEvidenceQuery;
  if (queryMentionsTests(query) && !queryMentionsCodegraphTooling(query)) return query;

  const querySegments = contextPackSearchSignalSegments(queryTerms);
  if (queryMentionsCodegraphDedupMaintenance(query, querySegments)) {
    return CODEGRAPH_DEDUP_MAINTENANCE_FOCUSED_QUERY;
  }
  const specializedMaintenanceQuery = contextPackSpecializedMaintenanceQueryFor(query, querySegments);
  if (specializedMaintenanceQuery) {
    return specializedMaintenanceQuery;
  }
  if (queryMentionsCodegraphToolingQuality(query, querySegments)) {
    return CONTEXT_PACK_TOOLING_QUALITY_FOCUSED_QUERY;
  }
  if (queryMentionsCodegraphRuntimeDiagnostics(query, querySegments)) {
    return unique([
      ...CONTEXT_PACK_TOOLING_RUNTIME_DIAGNOSTICS_FOCUSED_QUERY.split(/\s+/),
      ...explicitContextPackQueryTerms(query),
    ]).join(' ');
  }
  const hasToolingIntent = querySegments.some(segment => CONTEXT_PACK_OVERLAY_TOOLING_INTENT_SEGMENTS.has(segment));
  const hasToolingOutputNoise = querySegments.some(segment => (
    CONTEXT_PACK_OVERLAY_TOOLING_QUERY_NOISE_SEGMENTS.has(segment)
  ));
  if (!hasToolingIntent || !hasToolingOutputNoise) {
    return query;
  }

  const noiseSegments = new Set(CONTEXT_PACK_OVERLAY_QUERY_NOISE_SEGMENTS);
  for (const segment of CONTEXT_PACK_OVERLAY_TOOLING_QUERY_NOISE_SEGMENTS) {
    noiseSegments.add(segment);
  }
  if (queryMentionsTests(query) && hasToolingIntent) {
    for (const segment of CONTEXT_PACK_TOOLING_LIFECYCLE_DIAGNOSTIC_SEGMENTS) {
      noiseSegments.add(segment);
    }
  }
  if (queryMentionsCodegraphToolingSourcePollution(query, querySegments)) {
    for (const segment of CONTEXT_PACK_TOOLING_POLLUTION_SOURCE_SEGMENTS) {
      noiseSegments.add(segment);
    }
  }
  const focusedTerms = contextPackFocusedQueryTerms(contextPackRawQueryTerms(query), noiseSegments);
  const focused = focusedTerms.join(' ');
  return focused.length >= 2 ? focused : query;
}

function contextPackOverlayQueryFor(rawQuery = '') {
  return contextPackFocusedQueryFor(rawQuery);
}

function contextPackFocusedQueryFor(rawQuery = '') {
  const query = String(rawQuery ?? '').trim();
  if (!query) return query;
  const queryTerms = queryTokens(query);
  const issueRegistryQuery = contextPackIssueRegistryQueryFor(query, queryTerms);
  if (issueRegistryQuery) return issueRegistryQuery;
  if (explicitContextPackQueryTerms(query).some(isExplicitPathTerm)) return query;
  const lifecycleTestEvidenceQuery = contextPackLifecycleTestEvidenceQueryFor(query, queryTerms);
  if (lifecycleTestEvidenceQuery) return lifecycleTestEvidenceQuery;
  if (queryMentionsTests(query) && !queryMentionsCodegraphTooling(query)) return query;

  const querySegments = contextPackSearchSignalSegments(queryTerms);
  if (queryMentionsCodegraphDedupMaintenance(query, querySegments)) {
    return CODEGRAPH_DEDUP_MAINTENANCE_FOCUSED_QUERY;
  }
  const specializedMaintenanceQuery = contextPackSpecializedMaintenanceQueryFor(query, querySegments);
  if (specializedMaintenanceQuery) {
    return specializedMaintenanceQuery;
  }
  if (queryMentionsCodegraphToolingQuality(query, querySegments)) {
    return CONTEXT_PACK_TOOLING_QUALITY_FOCUSED_QUERY;
  }
  if (queryMentionsCodegraphRuntimeDiagnostics(query, querySegments)) {
    return unique([
      ...CONTEXT_PACK_TOOLING_RUNTIME_DIAGNOSTICS_FOCUSED_QUERY.split(/\s+/),
      ...explicitContextPackQueryTerms(query),
    ]).join(' ');
  }
  const hasToolingIntent = querySegments.some(segment => CONTEXT_PACK_OVERLAY_TOOLING_INTENT_SEGMENTS.has(segment));
  const noiseSegments = new Set(CONTEXT_PACK_OVERLAY_QUERY_NOISE_SEGMENTS);
  if (hasToolingIntent) {
    for (const segment of CONTEXT_PACK_OVERLAY_TOOLING_QUERY_NOISE_SEGMENTS) {
      noiseSegments.add(segment);
    }
    if (queryMentionsTests(query)) {
      for (const segment of CONTEXT_PACK_TOOLING_LIFECYCLE_DIAGNOSTIC_SEGMENTS) {
        noiseSegments.add(segment);
      }
    }
    if (queryMentionsCodegraphToolingSourcePollution(query, querySegments)) {
      for (const segment of CONTEXT_PACK_TOOLING_POLLUTION_SOURCE_SEGMENTS) {
        noiseSegments.add(segment);
      }
    }
  }
  if (!querySegments.some(segment => noiseSegments.has(segment))) {
    return query;
  }

  const focusedTerms = contextPackFocusedQueryTerms(contextPackRawQueryTerms(query), noiseSegments);
  const focused = focusedTerms.join(' ');
  return focused.length >= 2 ? focused : query;
}

function contextPackSourceRankingQueryFor(rawQuery = '') {
  const query = String(rawQuery ?? '').trim();
  if (!query) return query;
  return contextPackFocusedQueryFor(query) || query;
}

function rewriteContextPackExplorationHeading(text, query) {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) return '';
  const lines = normalizedText.split(/\r?\n/);
  if (/^## Exploration: /.test(lines[0] ?? '')) {
    lines[0] = `## Exploration: ${query}`;
    return lines.join('\n');
  }
  if (/^\*\*Exploration: .*?\*\*$/.test(lines[0] ?? '')) {
    lines[0] = `**Exploration: ${query}**`;
    return lines.join('\n');
  }
  return normalizedText;
}

function sanitizeContextPackBaseMarkdownSections(text, rawQuery = '', nodes = [], matches = []) {
  const diagnostics = createBaseSectionFilteringDiagnostics(text);
  if (!text) {
    return { text: '', diagnostics };
  }

  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  const rankedEntries = rankContextPackSourceFileEntries(nodes, contextPackSourceRankingQueryFor(rawQuery), matches);
  const baseSourceBlockFiles = extractContextPackSourceBlockFiles(text);
  const specializedSourceScope = contextPackSpecializedMaintenanceSourceScopeFor(rawQuery);
  const hasSpecializedSourceAlternative = Boolean(specializedSourceScope) && (
    rankedEntries.some(entry => contextPackSourcePathMatchesSpecializedMaintenanceScope(
      entry?.filePath ?? entry?.normalizedFilePath,
      specializedSourceScope,
    ))
    || baseSourceBlockFiles.some(filePath => contextPackSourcePathMatchesSpecializedMaintenanceScope(
      filePath,
      specializedSourceScope,
    ))
  );
  const hasCleanAlternative = rankedEntries.some(entry => (
    contextPackSourceFileLowValuePenalty(entry.filePath ?? entry.normalizedFilePath, queryTerms, rawQuery) <= 0
    || contextPackSourceEntryHasPreferredSymbolEvidence(entry, rawQuery, queryTerms)
  )) || baseSourceBlockFiles.some(filePath => (
    contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery) <= 0
  ));
  const nodesByName = buildContextPackNodesByName(
    nodes,
    new Map(rankedEntries.map((entry, index) => [entry.normalizedFilePath, index])),
    queryTerms,
    rawQuery,
  );
  const lines = String(text).split(/\r?\n/);
  const keptLines = [];
  let currentSection = null;
  let inSourceSection = false;

  for (const line of lines) {
    const heading = classifyContextPackBaseMarkdownHeading(line);
    if (heading) {
      currentSection = heading === 'Other' ? null : heading;
      inSourceSection = heading === 'Source Code';
      keptLines.push(line);
      continue;
    }

    if (
      !inSourceSection
      && currentSection
      && currentSection !== 'Source Code'
      && /^\s*-\s+/.test(line)
    ) {
      const decision = contextPackBaseMetadataLineFilterDecision(
        line,
        currentSection,
        rawQuery,
        queryTerms,
        nodesByName,
        hasCleanAlternative,
        specializedSourceScope,
        hasSpecializedSourceAlternative,
      );
      if (decision.filtered) {
        recordContextPackBaseSectionFilteredLine(diagnostics, decision);
        continue;
      }
    }

    keptLines.push(line);
  }

  diagnostics.keptLineCount = keptLines.length;
  diagnostics.sectionsTouched = [...diagnostics.sectionsTouched];
  return {
    text: keptLines.join('\n').trim(),
    diagnostics,
  };
}

function createBaseSectionFilteringDiagnostics(text) {
  return {
    rawLineCount: text ? String(text).split(/\r?\n/).length : 0,
    keptLineCount: text ? String(text).split(/\r?\n/).length : 0,
    filteredLineCount: 0,
    filteredByReason: {},
    sectionsTouched: new Set(),
    filteredLineDetails: [],
  };
}

function classifyContextPackBaseMarkdownHeading(line) {
  const trimmed = String(line ?? '').trim();
  if (/^(?:#{2,4}\s+|\*\*)Source Code\b/i.test(trimmed)) return 'Source Code';
  if (/^(?:#{2,4}\s+|\*\*)Blast radius\b/i.test(trimmed)) return 'Blast radius';
  if (/^(?:#{2,4}\s+Relationships\b|\*\*Relationships\*\*$)/i.test(trimmed)) return 'Relationships';
  if (/^(?:#{2,4}\s+Related Symbols\b|\*\*Related Symbols\*\*$)/i.test(trimmed)) return 'Related Symbols';
  if (/^(?:#{2,4}\s+|\*\*)Not shown above\b/i.test(trimmed)) return 'Not shown';
  if (/^#{2,4}\s+/.test(trimmed)) return 'Other';
  if (/^\*\*[^*\n]+\*\*$/.test(trimmed) && !/^\*\*(?:calls|references|contains|type_of):\*\*$/i.test(trimmed)) {
    return 'Other';
  }
  return null;
}

function contextPackBaseMetadataLineFilterDecision(
  line,
  section,
  rawQuery,
  queryTerms,
  nodesByName,
  hasCleanAlternative,
  specializedSourceScope = null,
  hasSpecializedSourceAlternative = false,
) {
  const lineText = String(line ?? '');
  const explicitFilePath = extractSearchPathFromText(lineText);
  if (explicitFilePath && isRenderableContextPackSourcePath(explicitFilePath)) {
    const pathDecision = contextPackBaseMetadataPathFilterDecision(
      explicitFilePath,
      rawQuery,
      queryTerms,
      hasCleanAlternative,
      'path',
      specializedSourceScope,
      hasSpecializedSourceAlternative,
    );
    if (pathDecision.filtered) {
      return {
        ...pathDecision,
        section,
        linePreview: previewContextPackDiagnosticLine(lineText),
      };
    }
  }

  for (const symbol of extractContextPackBaseRelationshipSymbols(lineText)) {
    const node = nodesByName.get(symbol);
    if (!node) continue;
    const pathDecision = contextPackBaseMetadataPathFilterDecision(
      node.filePath,
      rawQuery,
      queryTerms,
      hasCleanAlternative,
      'symbol',
      specializedSourceScope,
      hasSpecializedSourceAlternative,
    );
    if (pathDecision.filtered) {
      return {
        ...pathDecision,
        section,
        symbol,
        linePreview: previewContextPackDiagnosticLine(lineText),
      };
    }
  }

  const textNoiseReason = contextPackBaseMetadataTextNoiseReason(
    lineText,
    rawQuery,
    hasCleanAlternative,
    specializedSourceScope,
    hasSpecializedSourceAlternative,
  );
  if (textNoiseReason) {
    return {
      filtered: true,
      reason: textNoiseReason,
      filePath: null,
      section,
      linePreview: previewContextPackDiagnosticLine(lineText),
    };
  }

  return { filtered: false };
}

function contextPackBaseMetadataPathFilterDecision(
  filePath,
  rawQuery,
  queryTerms,
  hasCleanAlternative,
  source = 'path',
  specializedSourceScope = null,
  hasSpecializedSourceAlternative = false,
) {
  if (!hasCleanAlternative) return { filtered: false };
  if (queryExplicitlyRequestsContextPackFilePath(filePath, queryTerms)) return { filtered: false };
  if (queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms)) return { filtered: false };
  if (
    hasSpecializedSourceAlternative
    && specializedSourceScope
    && !contextPackSourcePathMatchesSpecializedMaintenanceScope(filePath, specializedSourceScope)
  ) {
    return {
      filtered: true,
      reason: source === 'symbol'
        ? 'specialized-maintenance-unrelated-symbol'
        : 'specialized-maintenance-unrelated-source',
      filePath: normalizeSearchPath(filePath),
      specializedSourceScope: specializedSourceScope.id,
    };
  }
  if (
    queryMentionsCodegraphDedupMaintenance(rawQuery)
    && !isCodegraphDedupMaintenanceSourcePath(filePath)
  ) {
    return {
      filtered: true,
      reason: source === 'symbol'
        ? 'dedup-maintenance-unrelated-symbol'
        : 'dedup-maintenance-unrelated-source',
      filePath: normalizeSearchPath(filePath),
    };
  }
  if (queryMentionsCodegraphTooling(rawQuery) && isCodegraphToolingSourcePath(filePath)) {
    return { filtered: false };
  }
  if (
    queryMentionsCodegraphToolingSourcePollution(rawQuery)
    && isCodegraphToolingPollutionSourcePath(filePath)
  ) {
    return {
      filtered: true,
      reason: source === 'symbol' ? 'tooling-pollution-symbol' : 'tooling-pollution-source',
      filePath: normalizeSearchPath(filePath),
    };
  }
  if (
    queryMentionsCodegraphToolingSourcePollution(rawQuery)
    && isTestLikeContextPackSourcePath(filePath)
    && !isCodegraphToolingTestSourcePath(filePath)
  ) {
    return {
      filtered: true,
      reason: source === 'symbol' ? 'tooling-test-symbol' : 'tooling-test-source',
      filePath: normalizeSearchPath(filePath),
    };
  }
  const lowValuePenalty = contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery);
  if (lowValuePenalty > 0) {
    return {
      filtered: true,
      reason: source === 'symbol' ? 'low-value-symbol' : 'low-value-source',
      filePath: normalizeSearchPath(filePath),
      lowValuePenalty,
    };
  }
  return { filtered: false };
}

function extractContextPackBaseRelationshipSymbols(line) {
  const text = String(line ?? '').replace(/`/g, '').replace(/^\s*-\s+/, '');
  const match = /^(.+?)\s*(?:→|->)\s*(.+?)(?:\s+\(|$)/.exec(text);
  if (!match) return [];
  return [match[1], match[2]]
    .map(value => String(value ?? '').trim())
    .map(value => value.replace(/\s+-\s+.*$/, '').replace(/\s+—\s+.*$/, '').trim())
    .filter(Boolean);
}

function contextPackBaseMetadataTextNoiseReason(
  line,
  rawQuery,
  hasCleanAlternative,
  specializedSourceScope = null,
  hasSpecializedSourceAlternative = false,
) {
  if (
    hasSpecializedSourceAlternative
    && specializedSourceScope
    && !contextPackMetadataLineMatchesSpecializedMaintenanceScope(line, specializedSourceScope)
  ) {
    return 'specialized-maintenance-unrelated-symbol';
  }
  if (!hasCleanAlternative || !queryMentionsCodegraphToolingSourcePollution(rawQuery)) {
    return '';
  }
  const segments = new Set(splitSearchSignalSegments(line).map(segment => segment.toLowerCase()));
  if (segments.has('telemetry') || segments.has('loggerservice') || segments.has('logger')) {
    return 'tooling-pollution-symbol';
  }
  if (segments.has('spec') || segments.has('test') || segments.has('mock') || segments.has('stub') || segments.has('fixture')) {
    return 'tooling-test-symbol';
  }
  return '';
}

function recordContextPackBaseSectionFilteredLine(diagnostics, decision) {
  diagnostics.filteredLineCount += 1;
  diagnostics.filteredByReason[decision.reason] = (diagnostics.filteredByReason[decision.reason] ?? 0) + 1;
  diagnostics.sectionsTouched.add(decision.section);
  if (diagnostics.filteredLineDetails.length < 20) {
    diagnostics.filteredLineDetails.push({
      section: decision.section,
      reason: decision.reason,
      filePath: decision.filePath ?? null,
      symbol: decision.symbol,
      lowValuePenalty: decision.lowValuePenalty,
      linePreview: decision.linePreview,
    });
  }
}

function previewContextPackDiagnosticLine(line, maxLength = 240) {
  const normalized = String(line ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function summarizeContextPackMarkdownText(text) {
  const normalizedText = String(text ?? '');
  const relationshipsSectionCount = countContextPackMarkdownSectionHeadings(normalizedText, 'Relationships');
  const relatedSymbolsSectionCount = countContextPackMarkdownSectionHeadings(normalizedText, 'Related Symbols');
  const relationshipKindSectionCounts = countContextPackRelationshipKindSections(normalizedText);
  return {
    bytes: Buffer.byteLength(normalizedText, 'utf8'),
    lineCount: normalizedText ? normalizedText.split(/\r?\n/).length : 0,
    startsWithJson: normalizedText.trimStart().startsWith('{'),
    sourceSectionCount: countContextPackSourceSections(normalizedText),
    relationshipsSectionCount,
    duplicateRelationshipsSectionCount: Math.max(0, relationshipsSectionCount - 1),
    relationshipKindSectionCounts,
    duplicateRelationshipKindSectionCount: duplicateContextPackRelationshipKindSectionCount(relationshipKindSectionCounts),
    relatedSymbolsSectionCount,
    duplicateRelatedSymbolsSectionCount: Math.max(0, relatedSymbolsSectionCount - 1),
    sourceBlockCount: extractContextPackSourceBlockFiles(normalizedText).length,
    firstHeadings: normalizedText
      .split(/\r?\n/)
      .filter(line => /^(?:#{2,4}\s+|\*\*)/.test(line.trim()))
      .slice(0, 12),
  };
}

function expandQueryTokenAliases(term) {
  const relation = normalizeContextPackResourceRelation(term);
  const aliases = relation && relation !== term ? [term, relation] : [term];
  if (term === 'assert' || term === 'assertion' || term === 'assertions') {
    aliases.push('expect', 'expected');
  }
  return unique(aliases);
}

function isContextPackResourceRelationTerm(term) {
  return CONTEXT_PACK_BASE_SOURCE_FILTER_RELATIONS.has(normalizeContextPackResourceRelation(term));
}

function scorePathTermMatch(filePath, queryTerms) {
  const normalizedPath = normalizeSearchPath(filePath);
  if (!normalizedPath) return 0;

  const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;
  const fileStem = fileName.replace(CONTEXT_PACK_SOURCE_EXTENSION_RE, '');
  const querySegmentSet = new Set(queryTerms.flatMap(searchPathSignalSegments));
  let score = 0;
  for (const term of queryTerms) {
    const normalizedTerm = normalizeSearchPath(term);
    if (normalizedTerm && (normalizedTerm === fileStem || normalizedTerm === fileName)) {
      score += 5_000;
    }
  }
  for (const term of queryTerms.filter(isExplicitPathTerm)) {
    const normalizedTerm = normalizeSearchPath(term);
    if (!normalizedTerm) continue;
    if (normalizedPath === normalizedTerm || fileName === normalizedTerm) {
      score += 250;
      continue;
    }
    if (normalizedPath.endsWith(`/${normalizedTerm}`)) {
      score += 220;
      continue;
    }
    if (normalizedTerm.endsWith(`/${normalizedPath}`) || normalizedTerm.endsWith(`/${fileName}`)) {
      score += 220;
      continue;
    }
    if (normalizedPath.includes(normalizedTerm)) {
      score += 120;
    }
  }
  score += scorePathSegmentCoverage(fileName, querySegmentSet, 90);
  score += scorePathSegmentCoverage(normalizedPath, querySegmentSet, 45);
  return score;
}

function isExplicitPathTerm(term) {
  const normalized = normalizeSearchPath(term);
  return /[/.\\]/.test(String(term ?? ''))
    && CONTEXT_PACK_SOURCE_EXTENSION_RE.test(normalized);
}

function normalizeSearchPath(value) {
  let normalized = String(value ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(CONTEXT_PACK_SOURCE_EXTENSION_WITH_LINE_RE, '$1')
    .replace(/^\.\//, '');
  const normalizedRoot = String(projectRoot ?? '').trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)) {
    normalized = normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function scorePathSegmentCoverage(pathLike, querySegmentSet, fullCoverageScore) {
  const segments = searchPathSignalSegments(pathLike);
  if (segments.length < 2) return 0;
  const matched = segments.filter(segment => querySegmentSet.has(segment));
  if (matched.length === segments.length) return fullCoverageScore;
  if (matched.length === 1 && querySegmentSet.size <= 2) return Math.floor(fullCoverageScore / 2);
  if (matched.length >= 2) return Math.floor((matched.length / segments.length) * (fullCoverageScore / 3));
  return 0;
}

function searchPathSignalSegments(value) {
  const normalized = normalizeSearchPath(value);
  const fileName = normalized.split('/').at(-1) ?? normalized;
  const withoutExtension = fileName.replace(CONTEXT_PACK_SOURCE_EXTENSION_RE, '');
  return unique(splitSearchSignalSegments(withoutExtension)
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2)
    .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment)));
}

function splitSearchSignalSegments(value) {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-z0-9$]+/i)
    .filter(Boolean);
}

function extractSearchPathFromText(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^-\s+/, '')
    .replace(/^####\s+/, '')
    .replace(/^['"`]+/, '');
  const parenthesizedPathMatch = new RegExp(
    `\\(([^()\\n]+\\.${CONTEXT_PACK_SOURCE_EXTENSION_PATTERN}(?::\\d+(?::\\d+)?)?)\\)`,
    'i',
  ).exec(text);
  if (parenthesizedPathMatch) {
    return normalizeSearchPath(parenthesizedPathMatch[1]);
  }
  const extensionMatch = CONTEXT_PACK_SOURCE_EXTENSION_IN_TEXT_RE.exec(text);
  if (extensionMatch) {
    const end = extensionMatch.index + extensionMatch[0].length;
    return normalizeSearchPath(text.slice(0, end).replace(/^['"`]+|['"`]+$/g, ''));
  }
  return normalizeSearchPath(text.split(/\s+—|\r?\n/)[0]);
}

function isRenderableContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  if (!normalized || normalized === '(unknown)') {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    return false;
  }
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized)) {
    return false;
  }
  if (/(^|\/)(node_modules|\.pnpm)\//.test(normalized)) {
    return false;
  }
  if (!CONTEXT_PACK_SOURCE_EXTENSION_RE.test(normalized)) {
    return false;
  }
  const absolutePath = resolveProjectFilePath(normalized);
  if (!absolutePath) {
    return false;
  }
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function queryMentionsTests(query) {
  return /\b(test|tests|testing|spec|verify|verifies|e2e|cy|cypress|playwright|fixture|fixtures|mock|mocks|stub|stubs|harness|snapshot|snapshots)\b/i.test(String(query ?? ''))
    || localizedContextPackQueryAliases(query).includes('test');
}

function contextPackLifecycleTestEvidenceQueryFor(rawQuery = '', precomputedQueryTerms = null) {
  const query = String(rawQuery ?? '').trim();
  if (!query) return '';
  const queryTerms = Array.isArray(precomputedQueryTerms) ? precomputedQueryTerms : queryTokens(query);
  const segments = queryTerms
    .flatMap(term => splitSearchSignalSegments(term))
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2);
  const segmentSet = new Set(segments);
  const isStaleWrapperQuery = segmentSet.has('stale') && segmentSet.has('wrapper');
  if (!isStaleWrapperQuery || segmentSet.has('smoke')) return '';

  const asksForTestEvidence = queryMentionsTests(query)
    || ['assert', 'assertion', 'assertions', 'expect', 'expected'].some(segment => segmentSet.has(segment));
  if (!asksForTestEvidence) return '';

  const hasLifecycleDiagnostic = segments.some(segment => (
    CONTEXT_PACK_TOOLING_LIFECYCLE_DIAGNOSTIC_SEGMENTS.has(segment)
  )) || ['exit', 'exits', 'exited', 'return', 'returns', 'returned'].some(segment => segmentSet.has(segment));
  if (!hasLifecycleDiagnostic) return '';

  return 'stale wrapper shutdown lifecycle diagnostics spec assertions';
}

function queryMentionsCodegraphTooling(query) {
  const rawText = String(query ?? '').toLowerCase();
  const segments = queryTokens(query)
    .flatMap(term => splitSearchSignalSegments(term))
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2);
  const segmentSet = new Set(segments);
  const hasCodegraphAnchor = ['codegraph', 'codex', 'nanoflow', 'mcp'].some(segment => (
    segmentSet.has(segment) || rawText.includes(segment)
  ));
  const hasLifecycleToolingIntent = segments.some(segment => (
    CONTEXT_PACK_TOOLING_LIFECYCLE_INTENT_SEGMENTS.has(segment)
  ));
  const hasLifecycleDiagnostic = segments.some(segment => (
    CONTEXT_PACK_TOOLING_LIFECYCLE_DIAGNOSTIC_SEGMENTS.has(segment)
  ));
  const hasLifecycleToolingQuery = hasLifecycleToolingIntent && hasLifecycleDiagnostic;
  if (!hasCodegraphAnchor && !hasLifecycleToolingQuery) return false;
  if (hasCodegraphAnchor && hasLifecycleDiagnostic) return true;
  return segments.some(segment => CONTEXT_PACK_OVERLAY_TOOLING_INTENT_SEGMENTS.has(segment))
    || segments.some(segment => CONTEXT_PACK_OVERLAY_TOOLING_QUERY_NOISE_SEGMENTS.has(segment))
    || hasLifecycleToolingQuery;
}

function queryMentionsCodegraphToolingSourcePollution(query, precomputedSegments = null) {
  if (!queryMentionsCodegraphTooling(query)) return false;
  const text = String(query ?? '').toLowerCase();
  if (/无用|噪音|污染|占满|干扰/.test(text)) return true;
  const segments = Array.isArray(precomputedSegments)
    ? precomputedSegments
    : queryTokens(query)
      .flatMap(term => splitSearchSignalSegments(term))
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2);
  if (queryMentionsCodegraphDedupMaintenance(query, segments)) return true;
  const segmentSet = new Set(segments);
  if (segments.some(segment => (
    segment === 'diagnostic'
    || segment === 'diagnostics'
    || segment === 'error'
    || segment === 'errors'
    || segment === 'guard'
    || segment === 'guards'
    || segment === 'log'
    || segment === 'logging'
    || segment === 'logs'
    || segment === 'mismatch'
    || segment === 'mismatches'
    || segment === 'response'
    || segment === 'responses'
    || segment === 'transport'
    || segment === 'transports'
    || segment === 'warning'
    || segment === 'warnings'
  ))) {
    return true;
  }
  if (
    (segmentSet.has('closed') || segmentSet.has('close'))
    && (segmentSet.has('transport') || segmentSet.has('stdio') || segmentSet.has('wrapper'))
  ) {
    return true;
  }
  if (segmentSet.has('root') && (segmentSet.has('cause') || segmentSet.has('causes'))) {
    return true;
  }
  if (segments.some(segment => (
    segment === 'noise'
    || segment === 'noisy'
    || segment === 'polluted'
    || segment === 'polluting'
    || segment === 'pollution'
  ))) {
    return true;
  }
  const hasLowValuePhrase = /low[-_\s]?value/.test(text)
    || (segmentSet.has('low') && segmentSet.has('value'));
  if (!hasLowValuePhrase) return false;
  return [
    'budget',
    'budgets',
    'block',
    'blocks',
    'section',
    'sections',
    'source',
    'sources',
    'visible',
    'visibility',
    'rank',
    'ranking',
    'order',
    'ordering',
  ].some(segment => segmentSet.has(segment));
}

function queryMentionsCodegraphToolingQuality(query, precomputedSegments = null) {
  if (!queryMentionsCodegraphTooling(query)) return false;
  const segments = Array.isArray(precomputedSegments)
    ? precomputedSegments
    : queryTokens(query)
      .flatMap(term => splitSearchSignalSegments(term))
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2);
  const segmentSet = new Set(segments);
  return segments.some(segment => CONTEXT_PACK_TOOLING_QUALITY_SEGMENTS.has(segment))
    || (segmentSet.has('low') && segmentSet.has('value') && [
      'source',
      'sources',
      'ordering',
      'order',
      'section',
      'sections',
      'rank',
      'ranking',
      'visible',
      'visibility',
    ].some(segment => segmentSet.has(segment)));
}

function contextPackSpecializedMaintenanceQueryFor(query, precomputedSegments = null) {
  return classifyContextPackSpecializedMaintenanceQuery(query, precomputedSegments).focusedQuery;
}

function classifyContextPackSpecializedMaintenanceQuery(query, precomputedSegments = null) {
  const segments = Array.isArray(precomputedSegments)
    ? precomputedSegments
    : contextPackSearchSignalSegments(queryTokens(query));
  return classifySpecializedMaintenanceQuery({
    segments,
    codegraphTooling: queryMentionsCodegraphTooling(query),
    context7Documentation: queryMentionsContext7Documentation(query),
  });
}

function contextPackSpecializedMaintenanceSourceScopeFor(query, precomputedClassification = null) {
  if (queryMentionsCodegraphDedupMaintenance(query)) {
    return null;
  }
  const classification = precomputedClassification
    ?? classifyContextPackSpecializedMaintenanceQuery(query);
  if (classification.strictNativeOutputMaintenance) {
    return {
      id: 'strict-native-output-maintenance',
      exactPaths: ['scripts/query-codegraph-nanoflow-overlay.mjs'],
      pathPrefixes: [],
      metadataSignals: [
        'query-codegraph-nanoflow-overlay',
        'formatstrictnativemarkdown',
        'formatnativemarkdown',
        'buildstrictnativemarkdownrelationshipgroups',
        'nativejsonedgeline',
      ],
    };
  }
  if (classification.context7Maintenance) {
    return {
      id: 'context7-maintenance',
      exactPaths: [],
      pathPrefixes: ['docs/context7/'],
      metadataSignals: ['context7', 'docs/context7/'],
    };
  }
  if (classification.toolingFixtureQuality) {
    return {
      id: 'tooling-fixture-quality',
      exactPaths: [
        'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
      ],
      pathPrefixes: [],
      metadataSignals: [
        'codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures',
        'buildfakecodegraphexplorescript',
        'writefakecodegraphexplorescript',
      ],
    };
  }
  return null;
}

function contextPackSourcePathMatchesSpecializedMaintenanceScope(filePath, sourceScope) {
  const normalizedFilePath = normalizeSearchPath(filePath);
  if (!normalizedFilePath || !sourceScope) return false;
  return (sourceScope.exactPaths ?? []).some(candidate => normalizedFilePath === normalizeSearchPath(candidate))
    || (sourceScope.pathPrefixes ?? []).some(prefix => (
      normalizedFilePath.startsWith(normalizeSearchPath(prefix))
    ));
}

function contextPackMetadataLineMatchesSpecializedMaintenanceScope(line, sourceScope) {
  const normalizedLine = String(line ?? '').replace(/\\/g, '/').toLowerCase();
  if (!normalizedLine || !sourceScope) return false;
  return (sourceScope.exactPaths ?? []).some(candidate => normalizedLine.includes(normalizeSearchPath(candidate)))
    || (sourceScope.pathPrefixes ?? []).some(prefix => normalizedLine.includes(normalizeSearchPath(prefix)))
    || (sourceScope.metadataSignals ?? []).some(signal => normalizedLine.includes(String(signal).toLowerCase()));
}

function queryMentionsCodegraphRuntimeDiagnostics(query, precomputedSegments = null) {
  if (!queryMentionsCodegraphTooling(query)) return false;
  const segments = Array.isArray(precomputedSegments)
    ? precomputedSegments
    : queryTokens(query)
      .flatMap(term => splitSearchSignalSegments(term))
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2);
  const segmentSet = new Set(segments);
  const hasRuntimeBoundary = [
    'mcp',
    'stderr',
    'stdin',
    'stdout',
    'stdio',
    'transport',
    'wrapper',
  ].some(segment => segmentSet.has(segment));
  const hasDiagnosticIntent = [
    'diagnostic',
    'diagnostics',
    'error',
    'errors',
    'exception',
    'fatal',
    'log',
    'logging',
    'runtime',
    'uncaught',
    'unhandled',
    'warning',
    'write',
  ].some(segment => segmentSet.has(segment));
  return hasRuntimeBoundary && hasDiagnosticIntent;
}

function queryMentionsCodegraphDedupMaintenance(query, precomputedSegments = null) {
  return classifyCodegraphDedupMaintenanceQuery(query, precomputedSegments)
    .codegraphDedupMaintenance;
}

function summarizeContextPackQueryClassification(query, precomputedSegments = null) {
  const segments = Array.isArray(precomputedSegments)
    ? unique(precomputedSegments
      .map(segment => String(segment).toLowerCase())
      .filter(segment => segment.length >= 2))
    : contextPackSearchSignalSegments(queryTokens(query));
  const dedupMaintenance = classifyCodegraphDedupMaintenanceQuery(query, segments);
  const specializedMaintenance = classifyContextPackSpecializedMaintenanceQuery(query, segments);
  const specializedSourceScope = contextPackSpecializedMaintenanceSourceScopeFor(query, specializedMaintenance);
  return {
    ...dedupMaintenance,
    codegraphTooling: queryMentionsCodegraphTooling(query),
    codegraphToolingQuality: queryMentionsCodegraphToolingQuality(query, segments),
    codegraphToolingSourcePollution: queryMentionsCodegraphToolingSourcePollution(query, segments),
    context7Documentation: queryMentionsContext7Documentation(query),
    strictNativeOutputMaintenance: specializedMaintenance.strictNativeOutputMaintenance,
    context7Maintenance: specializedMaintenance.context7Maintenance,
    toolingFixtureQuality: specializedMaintenance.toolingFixtureQuality,
    specializedMaintenanceSourceScope: specializedSourceScope?.id ?? null,
    tests: queryMentionsTests(query),
  };
}

function classifyCodegraphDedupMaintenanceQuery(query, precomputedSegments = null) {
  const providedSegments = Array.isArray(precomputedSegments)
    ? unique(precomputedSegments.map(segment => String(segment).toLowerCase()).filter(segment => segment.length >= 2))
    : queryTokens(query)
      .flatMap(term => splitSearchSignalSegments(term))
      .map(segment => segment.toLowerCase())
      .filter(segment => segment.length >= 2);
  const rawQuerySegments = String(query ?? '')
    .split(/[^a-z0-9_$:.@/\\-]+/i)
    .flatMap(term => splitSearchSignalSegments(term))
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2);
  const segments = unique([
    ...providedSegments,
    ...rawQuerySegments,
  ]);
  const segmentSet = new Set(segments);
  const matchedCodegraphAnchorSegments = ['codegraph', 'nanoflow', 'mcp', 'adapter', 'overlay']
    .filter(segment => segmentSet.has(segment));
  const matchedMaintenanceIntentSegments = unique(segments
    .filter(segment => CONTEXT_PACK_DEDUP_MAINTENANCE_INTENT_SEGMENTS.has(segment)));
  const matchedStrongMaintenanceIntentSegments = unique(segments
    .filter(segment => CONTEXT_PACK_DEDUP_MAINTENANCE_STRONG_INTENT_SEGMENTS.has(segment)));
  const matchedDedupMaintenanceHelperSegments = unique(segments
    .filter(segment => CONTEXT_PACK_DEDUP_MAINTENANCE_HELPER_SIGNAL_SEGMENTS.has(segment)));
  const matchedDedupMaintenanceHelperCompoundSignals = CONTEXT_PACK_DEDUP_MAINTENANCE_HELPER_COMPOUND_SIGNALS
    .filter(signal => signal.every(segment => segmentSet.has(segment)))
    .map(signal => signal.join(':'));
  const hasCodegraphAnchor = matchedCodegraphAnchorSegments.length > 0;
  const hasMaintenanceIntent = matchedMaintenanceIntentSegments.length > 0;
  const hasStrongMaintenanceIntent = matchedStrongMaintenanceIntentSegments.length > 0;
  const hasDedupMaintenanceHelperSignal = matchedDedupMaintenanceHelperCompoundSignals.length > 0
    || matchedDedupMaintenanceHelperSegments.length >= 3;
  const codegraphDedupMaintenance = hasMaintenanceIntent
    && hasStrongMaintenanceIntent
    && (hasCodegraphAnchor || hasDedupMaintenanceHelperSignal);
  let dedupMaintenanceReason = 'not-dedup-maintenance';
  if (!hasMaintenanceIntent) {
    dedupMaintenanceReason = 'missing-maintenance-intent';
  } else if (!hasStrongMaintenanceIntent) {
    dedupMaintenanceReason = 'missing-strong-maintenance-intent';
  } else if (hasCodegraphAnchor) {
    dedupMaintenanceReason = 'anchored-dedup-maintenance';
  } else if (hasDedupMaintenanceHelperSignal) {
    dedupMaintenanceReason = 'strong-maintenance-helper-signal';
  } else {
    dedupMaintenanceReason = 'missing-codegraph-anchor-or-helper-signal';
  }
  return {
    segments: unique(segments).slice(0, CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT),
    codegraphDedupMaintenance,
    dedupMaintenanceReason,
    hasCodegraphAnchor,
    hasMaintenanceIntent,
    hasStrongMaintenanceIntent,
    hasDedupMaintenanceHelperSignal,
    matchedCodegraphAnchorSegments,
    matchedMaintenanceIntentSegments,
    matchedStrongMaintenanceIntentSegments,
    matchedDedupMaintenanceHelperSegments,
    matchedDedupMaintenanceHelperCompoundSignals,
  };
}

function isCodegraphDedupMaintenanceSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  if (!normalized) return false;
  if (normalized === 'agents.md') return true;
  if (normalized === 'docs/codegraph-nanoflow-dedup-contract.json') return true;
  if (/^docs\/codegraph-nanoflow-adaptation(?:-issues)?\.md$/.test(normalized)) return true;
  if (isCodegraphToolingSourcePath(normalized)) return true;
  return normalized === 'scripts/generate-codegraph-nanoflow-overlay.mjs'
    || normalized === 'scripts/query-codegraph-nanoflow-overlay.mjs'
    || normalized === 'scripts/codegraph-nanoflow-mcp-stdio.cjs'
    || normalized === 'scripts/analyze-codegraph-mcp-log.cjs'
    || normalized === 'scripts/validate-codegraph-overlay-docs.cjs';
}

function isCodegraphToolingSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  if (!normalized.startsWith('scripts/')) return false;
  const fileName = normalized.split('/').at(-1) ?? normalized;
  return fileName.includes('codegraph')
    || fileName.startsWith('analyze-codegraph-mcp-log')
    || fileName.startsWith('smoke-codegraph-mcp')
    || fileName.startsWith('run-codegraph-adapter')
    || fileName.startsWith('validate-codegraph-overlay');
}

function isCodegraphToolingTestSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  const fileName = normalized.split('/').at(-1) ?? normalized;
  return normalized.startsWith('src/tests/scripts/codegraph-')
    || (/\.(?:test|spec|spec-helpers)\.[cm]?[jt]sx?$/.test(fileName)
      && (fileName.includes('codegraph') || fileName.includes('mcp')));
}

function isContextPackDocumentationSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return normalized.startsWith('docs/')
    && /\.(?:mdx?|json)$/i.test(normalized);
}

function isContext7DocumentationSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return normalized.startsWith('docs/context7/')
    && /\.(?:mdx?|json)$/i.test(normalized);
}

function queryMentionsContext7Documentation(rawQuery = '', precomputedQueryTerms = null) {
  const query = String(rawQuery ?? '').toLowerCase().replace(/\\/g, '/');
  if (query.includes('docs/context7') || query.includes('context7')) {
    return true;
  }
  const queryTerms = Array.isArray(precomputedQueryTerms)
    ? precomputedQueryTerms
    : queryTokens(query);
  const termSet = new Set(queryTerms);
  const hasDocumentationIntent = [
    'doc',
    'docs',
    'documentation',
    'document',
    'documents',
    'reference',
    'guide',
    'guides',
    'catalog',
    'retrieval',
  ].some(term => termSet.has(term));
  return hasDocumentationIntent && ['source-map', 'sourcemap', 'context'].some(term => termSet.has(term));
}

function isTestLikeContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return /(^|\/)(e2e|cypress|playwright)(\/|$)/.test(normalized)
    || /\/(tests?|__tests?__|spec)\//.test(normalized)
    || /(^|\/)(__fixtures__|__mocks__|fixtures?|mocks?|stubs?|snapshots?|test-fixtures|testdata|test-data)(\/|$)/.test(normalized)
    || /(^|\/)helpers?\//.test(normalized)
    || /(?:^|\/)test_[^/]+\.py$/.test(normalized)
    || /_test\.[a-z]+$/.test(normalized)
    || /\.(?:cy|e2e)\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(?:test|spec)-helpers\.[cm]?[jt]sx?$/.test(normalized)
    || /\.helpers?\.[cm]?[jt]sx?$/.test(normalized)
    || /\.(?:fixture|fixtures|mock|mocks|stub|stubs|harness|snapshot|snapshots)\.[cm]?[jt]sx?$/.test(normalized);
}

function isAuxiliaryContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return /(^|\/)(?:\d+-)?(stories?|storybook|demos?|samples?|examples?|playground)\//.test(normalized)
    || /\.(?:stories?|story|demo|sample|example|playground)\.[cm]?[jt]sx?$/.test(normalized);
}

function isGeneratedContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  const fileName = normalized.split('/').at(-1) ?? normalized;
  return CONTEXT_PACK_GENERATED_FILE_PATTERNS.some(pattern => pattern.test(fileName));
}

function isBuildCacheContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return /(^|\/)(dist|build|out|coverage|\.angular|\.cache|\.codegraph|\.next|\.nuxt|\.svelte-kit|\.turbo|\.vite|tmp|temp)(\/|$)/.test(normalized);
}

function isPackagedArtifactContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  const fileName = normalized.split('/').at(-1) ?? normalized;
  return /\.(?:min|bundle|chunk)\.(?:[cm]?js|css)$/.test(fileName)
    || /\.(?:[cm]?js|css)\.map$/.test(fileName)
    || /(?:^|[-.])lock(?:file)?\.(?:json|ya?ml|toml)$/.test(fileName)
    || fileName === 'yarn.lock'
    || fileName === 'bun.lock'
    || fileName === 'bun.lockb';
}

function queryMentionsGeneratedContextPackSource(rawQuery = '', queryTerms = null) {
  const query = String(rawQuery ?? '');
  if (/\b(?:generated|gen|proto|protobuf|pb|grpc)\b/i.test(query)) return true;
  const termSet = new Set(Array.isArray(queryTerms) ? queryTerms : queryTokens(query.toLowerCase()));
  return ['generated', 'gen', 'proto', 'protobuf', 'pb', 'grpc'].some(term => termSet.has(term));
}

function isLowValueContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return isTestLikeContextPackSourcePath(normalized)
    || isAuxiliaryContextPackSourcePath(normalized)
    || isGeneratedContextPackSourcePath(normalized)
    || isBuildCacheContextPackSourcePath(normalized)
    || isPackagedArtifactContextPackSourcePath(normalized)
    || isToolingHelperContextPackSourcePath(normalized)
    || /\bicons?\b/.test(normalized)
    || /\bi18n\b/.test(normalized);
}

function isToolingHelperContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return /(^|\/)scripts\//.test(normalized)
    || /(^|\/)\.github\//.test(normalized)
    || /(^|\/)cloudflare\/workers-static-assets\//.test(normalized);
}

function isAndroidResourceContextPackSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  return /(^|\/)android\/app\/src\/main\/res\/(?:anim|color|drawable|layout|menu|mipmap|values|xml)(?:\/|$)/.test(normalized);
}

function queryMentionsAndroidResourceSource(filePath, queryTerms = []) {
  if (queryExplicitlyRequestsContextPackFilePath(filePath, queryTerms)) return true;
  const segmentSet = new Set(queryTerms.flatMap(searchPathSignalSegments));
  if ([
    'android',
    'drawable',
    'layout',
    'mipmap',
    'resource',
    'resources',
    'res',
    'xml',
    'widget',
  ].some(segment => segmentSet.has(segment))) {
    return true;
  }

  const fileNameSegments = searchPathSignalSegments(normalizeSearchPath(filePath));
  return fileNameSegments.length > 1 && fileNameSegments.every(segment => segmentSet.has(segment));
}

function contextPackSourceFileLowValuePenalty(filePath, queryTerms, rawQuery) {
  if (contextPackLifecycleTestEvidenceQueryFor(rawQuery)) {
    if (isCodegraphToolingSourcePath(filePath) || isCodegraphToolingTestSourcePath(filePath)) return 0;
    return 6_000;
  }
  if (queryExplicitlyRequestsContextPackFilePath(filePath, queryTerms)) return 0;
  if (
    queryMentionsCodegraphToolingSourcePollution(rawQuery)
    && isCodegraphToolingPollutionSourcePath(filePath)
  ) {
    return 12_000;
  }
  if (
    isContext7DocumentationSourcePath(filePath)
    && !queryMentionsContext7Documentation(rawQuery, queryTerms)
  ) {
    return 10_000;
  }
  // scripts/.github/workers-static-assets 属于工具助手目录：普通业务查询里
  // “storage bucket”这类泛词恰好覆盖文件 stem 不构成显式请求，只有显式路径词、
  // script(s) 词或 CodeGraph 工具/去重维护意图才能豁免默认低价值处罚。
  if (
    queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms)
    && (
      !isToolingHelperContextPackSourcePath(filePath)
      || queryTerms.includes('script')
      || queryTerms.includes('scripts')
      || queryMentionsCodegraphTooling(rawQuery)
      || queryMentionsCodegraphDedupMaintenance(rawQuery)
    )
  ) {
    return 0;
  }
  if (
    queryMentionsCodegraphDedupMaintenance(rawQuery)
  ) {
    return isCodegraphDedupMaintenanceSourcePath(filePath) ? 0 : 9_000;
  }
  if (
    isAuxiliaryContextPackSourcePath(filePath)
    && queryMentionsContextPackAuxiliarySource(filePath, queryTerms)
  ) {
    return 0;
  }
  if (
    isGeneratedContextPackSourcePath(filePath)
    && queryMentionsGeneratedContextPackSource(rawQuery, queryTerms)
  ) {
    return 0;
  }
  if (queryMentionsTests(rawQuery)) return 0;
  if (queryMentionsCodegraphTooling(rawQuery) && isCodegraphToolingSourcePath(filePath)) return 0;
  if (
    isAndroidResourceContextPackSourcePath(filePath)
    && !queryMentionsAndroidResourceSource(filePath, queryTerms)
  ) {
    return 6_000;
  }
  if (isLowValueContextPackSourcePath(filePath)) return 6_000;
  const normalized = normalizeSearchPath(filePath);
  if (
    /(^|\/)scripts\//.test(normalized)
    && requestedContextPackResourceRelations(queryTerms).size > 0
    && !queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms)
  ) {
    return 6_000;
  }
  return 0;
}

function queryMentionsContextPackAuxiliarySource(filePath, queryTerms = []) {
  const normalized = normalizeSearchPath(filePath);
  const segmentSet = new Set(queryTerms.flatMap(searchPathSignalSegments));
  if (/(^|\/)(stories?|storybook)\//.test(normalized) || /\.(?:stories?|story)\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['story', 'stories', 'storybook'].some(segment => segmentSet.has(segment));
  }
  if (/(^|\/)demos?\//.test(normalized) || /\.demo\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['demo', 'demos'].some(segment => segmentSet.has(segment));
  }
  if (/(^|\/)samples?\//.test(normalized) || /\.sample\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['sample', 'samples'].some(segment => segmentSet.has(segment));
  }
  if (/(^|\/)examples?\//.test(normalized) || /\.example\.[cm]?[jt]sx?$/.test(normalized)) {
    return ['example', 'examples'].some(segment => segmentSet.has(segment));
  }
  if (/(^|\/)playground\//.test(normalized) || /\.playground\.[cm]?[jt]sx?$/.test(normalized)) {
    return segmentSet.has('playground');
  }
  return false;
}

function queryExplicitlyRequestsContextPackFilePath(filePath, queryTerms) {
  const normalizedPath = normalizeSearchPath(filePath);
  if (!normalizedPath) return false;
  const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;
  return queryTerms.some(term => {
    const normalizedTerm = normalizeSearchPath(term);
    return normalizedTerm
      && isExplicitPathTerm(term)
      && (normalizedPath.includes(normalizedTerm) || fileName.includes(normalizedTerm));
  });
}

function queryExplicitlyRequestsContextPackSourcePath(filePath, queryTerms) {
  const normalizedPath = normalizeSearchPath(filePath);
  if (!normalizedPath) return false;
  const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;
  if (queryExplicitlyRequestsContextPackFilePath(filePath, queryTerms)) {
    return true;
  }

  if (/\bi18n\b/.test(normalizedPath) && queryTerms.includes('i18n')) return true;
  if (/\bicons?\b/.test(normalizedPath) && queryTerms.some(term => term === 'icon' || term === 'icons')) {
    return true;
  }
  if (isTestLikeContextPackSourcePath(normalizedPath)) return false;

  const querySegmentSet = new Set(queryTerms.flatMap(searchPathSignalSegments));
  const pathSegments = searchPathSignalSegments(fileName);
  if (pathSegments.length > 0 && pathSegments.every(segment => querySegmentSet.has(segment))) {
    return true;
  }

  return false;
}

function isCodegraphToolingPollutionSourcePath(filePath) {
  const normalized = normalizeSearchPath(filePath);
  if (!normalized) return false;
  const fileName = normalized.split('/').at(-1) ?? normalized;
  return fileName === 'main.ts'
    || fileName === 'main.js'
    || fileName === 'main.mjs'
    || fileName === 'main.cjs'
    || /(^|\/)main\.[cm]?[jt]sx?$/.test(normalized)
    || /logger\.service\.[cm]?[jt]sx?$/.test(fileName)
    || fileName.includes('telemetry')
    || /(^|\/)telemetry\//.test(normalized);
}

const CONTEXT_PACK_LOW_VALUE_SEGMENTS = new Set([
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

function unique(values) {
  return [...new Set(values)];
}

function mergeContextPackSourceEvidenceNodes(nodes = [], codeBlocks = []) {
  const merged = [];
  const seen = new Set();
  const append = (node) => {
    if (!node || typeof node !== 'object') return;
    const filePath = normalizeSearchPath(node.filePath);
    if (!filePath || !isRenderableContextPackSourcePath(filePath)) return;
    const key = [
      filePath,
      node.kind ?? '',
      node.name ?? '',
      node.qualifiedName ?? '',
      node.startLine ?? '',
      node.endLine ?? '',
      node?.metadata?.contextPackCodeBlock ? 'code-block' : 'node',
    ].join('\0');
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(node);
  };

  for (const node of contextPackCodeBlockSourceEvidenceNodes(codeBlocks)) {
    append(node);
  }
  for (const node of Array.isArray(nodes) ? nodes : []) {
    append(node);
  }
  return merged;
}

function contextPackSourceEvidenceNodesForOverlay(nanoFlowOverlay = {}) {
  const data = nanoFlowOverlay?.data && typeof nanoFlowOverlay.data === 'object'
    ? nanoFlowOverlay.data
    : {};
  return mergeContextPackSourceEvidenceNodes(
    data.nodes ?? nanoFlowOverlay?.nodes ?? [],
    data.codeBlocks ?? nanoFlowOverlay?.codeBlocks ?? [],
  );
}

function contextPackCodeBlockSourceEvidenceNodes(codeBlocks = []) {
  if (!Array.isArray(codeBlocks)) {
    return [];
  }
  return codeBlocks
    .map((block, index) => {
      const filePath = String(block?.filePath ?? '').trim();
      const startLine = Number(block?.startLine);
      const endLine = Number(block?.endLine);
      if (!filePath || !Number.isInteger(startLine) || startLine <= 0) {
        return null;
      }
      const boundedEndLine = Number.isInteger(endLine) && endLine >= startLine ? endLine : startLine;
      const nodeName = String(block?.nodeName ?? '').trim();
      const nodeKind = String(block?.nodeKind ?? '').trim();
      return {
        id: `context-code-block:${filePath}:${startLine}:${boundedEndLine}:${nodeName || index}`,
        kind: nodeKind || 'code',
        name: nodeName || filePath,
        qualifiedName: nodeName || filePath,
        filePath,
        language: block?.language ?? inferLanguage(filePath),
        startLine,
        endLine: boundedEndLine,
        metadata: {
          contextPackCodeBlock: true,
        },
      };
    })
    .filter(Boolean);
}

function buildContextPackSourceBlock(filePath, nodes, rawQuery = '') {
  const absolutePath = resolveProjectFilePath(filePath);
  if (!absolutePath) {
    return null;
  }

  let sourceLines;
  try {
    sourceLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }

  const lifecycleEvidenceQuery = contextPackLifecycleTestEvidenceQueryFor(rawQuery);
  const sourceFocusQuery = lifecycleEvidenceQuery || rawQuery;
  const sourceLineWindowQuery = lifecycleEvidenceQuery
    ? `${lifecycleEvidenceQuery} ${rawQuery}`
    : sourceFocusQuery;
  const sourceNodes = selectContextPackSourceBlockNodes(nodes, sourceFocusQuery);
  let windows = mergeContextPackLineWindows(sourceNodes, sourceLines.length, { preserveOrder: true });
  if (sourceFocusQuery !== rawQuery) {
    const matchedLineWindows = contextPackMatchedLineWindows(sourceLines, sourceLineWindowQuery, sourceNodes);
    const fullFileMatchedLineWindows = lifecycleEvidenceQuery
      ? contextPackMatchedLineWindows(sourceLines, sourceLineWindowQuery, [])
      : [];
    const lifecycleEvidenceLineWindows = lifecycleEvidenceQuery
      ? contextPackLifecycleEvidenceLineWindows(sourceLines, filePath)
      : [];
    windows = mergeContextPackWindowRanges([
      ...windows,
      ...matchedLineWindows,
      ...fullFileMatchedLineWindows,
      ...lifecycleEvidenceLineWindows,
    ], { preserveOrder: true, mergeGap: lifecycleEvidenceQuery ? 8 : undefined });
  }
  if (windows.length === 0) {
    return null;
  }

  const numbered = [];
  for (const window of windows) {
    if (numbered.length > 0) {
      numbered.push('');
      numbered.push('... (gap) ...');
      numbered.push('');
    }
    for (let lineNumber = window.start; lineNumber <= window.end; lineNumber += 1) {
      numbered.push(`${lineNumber}\t${sourceLines[lineNumber - 1] ?? ''}`);
    }
  }

  const symbols = sourceNodes
    .filter(node => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
    .map(node => `${node.name}${node.kind ? `(${node.kind})` : ''}`)
    .filter(Boolean)
    .filter((symbol, index, symbols) => symbols.indexOf(symbol) === index)
    .slice(0, 5)
    .join(', ');

  return {
    filePath,
    language: languageForContextPackSourceBlock(filePath, sourceNodes),
    symbols,
    source: numbered.join('\n'),
  };
}

function selectContextPackSourceBlockNodes(nodes, rawQuery = '') {
  const candidates = (Array.isArray(nodes) ? nodes : []).filter(Boolean);
  if (candidates.length <= 1) {
    return candidates;
  }

  const queryTerms = queryTokens(String(rawQuery ?? '').toLowerCase());
  if (queryTerms.length === 0) {
    return [...candidates]
      .sort(compareGraphNode)
      .slice(0, CONTEXT_PACK_SOURCE_BLOCK_NODE_LIMIT);
  }

  const ranked = candidates
    .map((node, index) => {
      const lowInformation = isLowInformationContextPackSourceNode(node);
      const focused = !lowInformation && contextPackNodeMatchesQueryTerms(node, queryTerms);
      return {
        node,
        index,
        focused,
        score: scoreContextPackSourceEvidenceNode(node, queryTerms, focused, lowInformation),
      };
    })
    .sort((a, b) => b.score - a.score
      || Number(b.focused) - Number(a.focused)
      || compareGraphNode(a.node, b.node)
      || a.index - b.index);

  const focused = ranked.filter(entry => entry.focused && entry.score > 0);
  const scored = ranked.filter(entry => entry.score > 0);
  const pool = focused.length > 0 ? focused : scored;
  const selected = (pool.length > 0 ? pool : ranked)
    .slice(0, CONTEXT_PACK_SOURCE_BLOCK_NODE_LIMIT)
    .map(entry => entry.node);
  return selected.length > 0 ? selected : candidates.slice(0, CONTEXT_PACK_SOURCE_BLOCK_NODE_LIMIT);
}

function isLowInformationContextPackSourceNode(node) {
  const kind = String(node?.kind ?? '').toLowerCase();
  return kind === 'file' || kind === 'import' || kind === 'export';
}

function scoreContextPackSourceEvidenceNode(node, queryTerms, focused = false, lowInformation = false) {
  const name = String(node?.name ?? '');
  const qualifiedName = String(node?.qualifiedName ?? '');
  const compactNames = [name, qualifiedName]
    .map(value => value.toLowerCase().replace(/[^a-z0-9_$]+/g, ''))
    .filter(Boolean);
  const querySegments = queryTerms
    .flatMap(searchPathSignalSegments)
    .map(segment => segment.toLowerCase())
    .filter(Boolean);
  const nodeSegments = new Set([
    ...splitSearchSignalSegments(name),
    ...splitSearchSignalSegments(qualifiedName),
  ].map(segment => segment.toLowerCase()).filter(segment => segment.length >= 2));
  const matchedSegments = unique(querySegments.filter(segment => nodeSegments.has(segment)));
  let score = focused ? 100_000 : 0;
  score += matchedSegments.length * 2_500;
  if (matchedSegments.length >= 2) {
    score += 12_000;
  }
  for (const term of queryTerms) {
    const compactTerm = String(term ?? '').toLowerCase().replace(/[^a-z0-9_$]+/g, '');
    if (!compactTerm) continue;
    if (compactNames.some(value => value === compactTerm)) {
      score += 40_000 + compactTerm.length;
    } else if (compactNames.some(value => value.includes(compactTerm) || compactTerm.includes(value))) {
      score += 8_000 + compactTerm.length;
    }
  }
  score += scoreContextPackSourceFileSymbols([node], queryTerms);
  score += scoreContextPackNodeKind(node?.kind);
  if (Number.isInteger(Number(node?.startLine)) && Number(node.startLine) > 0) {
    score += 25;
  }
  if (node?.metadata?.contextPackCodeBlock === true) {
    score += 120_000;
  }
  if (lowInformation) {
    score -= 20_000;
  }
  return score;
}

function resolveProjectFilePath(filePath) {
  const normalizedRelativePath = String(filePath ?? '').replace(/\\/g, '/');
  if (!normalizedRelativePath || path.isAbsolute(normalizedRelativePath)) {
    return null;
  }

  const absolutePath = path.resolve(projectRoot, normalizedRelativePath);
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return absolutePath;
}

function mergeContextPackLineWindows(nodes, lineCount, options = {}) {
  const preserveOrder = Boolean(options?.preserveOrder);
  const windows = nodes
    .map(node => {
      const startLine = Number.isInteger(node.startLine) && node.startLine > 0 ? node.startLine : 1;
      const endLine = Number.isInteger(node.endLine) && node.endLine >= startLine ? node.endLine : startLine;
      const boundedStart = Math.max(1, Math.min(startLine, lineCount));
      const boundedEnd = Math.max(boundedStart, Math.min(endLine, lineCount));
      if (boundedEnd - boundedStart > 120) {
        return {
          start: boundedStart,
          end: Math.min(lineCount, boundedStart + 120),
        };
      }
      return {
        start: boundedStart,
        end: boundedEnd,
      };
    });
  return mergeContextPackWindowRanges(windows, { preserveOrder });
}

function mergeContextPackWindowRanges(windows, options = {}) {
  const preserveOrder = Boolean(options?.preserveOrder);
  const mergeGap = Number.isInteger(options?.mergeGap) && options.mergeGap >= 0 ? options.mergeGap : 3;
  const orderedWindows = [...windows]
    .filter(window => Number.isInteger(window?.start) && Number.isInteger(window?.end))
    .sort((a, b) => preserveOrder ? 0 : (a.start - b.start || a.end - b.end));
  const merged = [];
  for (const window of orderedWindows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + mergeGap) {
      previous.end = Math.max(previous.end, window.end);
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

function contextPackMatchedLineWindows(sourceLines, rawQuery = '', nodes = []) {
  const querySegments = unique(queryTokens(rawQuery)
    .flatMap(term => splitSearchSignalSegments(term))
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 3)
    .filter(segment => !CONTEXT_PACK_LOW_VALUE_SEGMENTS.has(segment)));
  if (querySegments.length === 0) return [];

  const nodeRanges = nodes
    .map(node => {
      const startLine = Number.isInteger(node?.startLine) && node.startLine > 0 ? node.startLine : 1;
      const endLine = Number.isInteger(node?.endLine) && node.endLine >= startLine ? node.endLine : startLine;
      return {
        start: Math.max(1, Math.min(startLine, sourceLines.length)),
        end: Math.max(startLine, Math.min(endLine, sourceLines.length)),
      };
    })
    .filter(range => range.start <= range.end);
  const searchRanges = nodeRanges.length > 0 ? nodeRanges : [{ start: 1, end: sourceLines.length }];
  const scoredLines = [];
  searchRanges.forEach((range, rangeIndex) => {
    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      const lineText = String(sourceLines[lineNumber - 1] ?? '').toLowerCase();
      const matchedSegments = unique(querySegments.filter(segment => lineText.includes(segment)));
      if (matchedSegments.length < 2) continue;
      scoredLines.push({
        lineNumber,
        rangeIndex,
        score: matchedSegments.length * 100 + matchedSegments.join('').length,
      });
    }
  });
  return scoredLines
    .sort((a, b) => b.score - a.score || a.rangeIndex - b.rangeIndex || a.lineNumber - b.lineNumber)
    .slice(0, 3)
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map(entry => ({
      start: Math.max(1, entry.lineNumber - 2),
      end: Math.min(sourceLines.length, entry.lineNumber + 2),
    }));
}

function contextPackLifecycleEvidenceLineWindows(sourceLines, filePath = '') {
  const includeTestAssertionEvidence = isCodegraphToolingTestSourcePath(filePath);
  const windows = [];
  sourceLines.forEach((line, index) => {
    const lineNumber = index + 1;
    const text = String(line ?? '');
    const lower = text.toLowerCase();
    if (text.includes('wrapper.shutdown.stale-wrapper-script')) {
      windows.push({
        start: Math.max(1, lineNumber - 4),
        end: Math.min(sourceLines.length, lineNumber + 16),
      });
      return;
    }
    if (includeTestAssertionEvidence && (
      text.includes("source: 'nanoflow-context-pack'")
      || text.includes("reason: 'nanoflow-context-pack'")
      || text.includes('childExitPromise')
      || text.includes('expectedExit')
      || lower.includes('code: 0')
      || lower.includes('signal: null')
    )) {
      windows.push({
        start: Math.max(1, lineNumber - 3),
        end: Math.min(sourceLines.length, lineNumber + 3),
      });
    }
  });
  return windows;
}

function languageForContextPackSourceBlock(filePath, nodes) {
  const language = nodes.find(node => node.language)?.language;
  if (language) {
    return language;
  }
  if (/\.tsx?$/i.test(filePath) || /\.(mts|cts)$/i.test(filePath)) return 'typescript';
  if (/\.(jsx?|mjs|cjs)$/i.test(filePath)) return 'javascript';
  if (/\.kts?$/i.test(filePath)) return 'kotlin';
  if (/\.xml$/i.test(filePath)) return 'xml';
  if (/\.html$/i.test(filePath)) return 'html';
  if (/\.(css|scss)$/i.test(filePath)) return 'css';
  if (/\.sql$/i.test(filePath)) return 'sql';
  if (/\.md$/i.test(filePath)) return 'markdown';
  return '';
}

function formatEdgeMetadata(edge) {
  const ignored = new Set(['source', 'target']);
  const entries = Object.entries(edge).filter(([key, value]) => !ignored.has(key) && value !== undefined);
  if (entries.length === 0) return '';
  return ` (${entries.map(([key, value]) => `${key}: ${value}`).join(', ')})`;
}

function sortRelationshipEdgesForMarkdown(rawEdges, nodes = [], sourceFileRanks = null, rawQuery = '') {
  const edges = Array.isArray(rawEdges) ? [...rawEdges] : [];
  const queryTerms = queryTokens(rawQuery);
  const nodesByName = buildContextPackNodesByName(nodes, sourceFileRanks, queryTerms, rawQuery);
  const scopedEdges = filterRelationshipEdgesForMarkdown(edges, nodesByName, sourceFileRanks, queryTerms, rawQuery);
  return scopedEdges.sort((a, b) => (
    relationshipEdgeSourceOrder(a, nodesByName, queryTerms, rawQuery) - relationshipEdgeSourceOrder(b, nodesByName, queryTerms, rawQuery)
    || String(a?.source ?? '').localeCompare(String(b?.source ?? ''))
    || String(a?.target ?? '').localeCompare(String(b?.target ?? ''))
  ));
}

function filterRelationshipEdgesForMarkdown(edges, nodesByName, sourceFileRanks, queryTerms, rawQuery) {
  const scopedEdges = edges.filter(edge => shouldShowContextPackRelationshipEdge(
    edge,
    nodesByName,
    sourceFileRanks,
    queryTerms,
    rawQuery,
  ));
  return scopedEdges;
}

function shouldShowContextPackRelationshipEdge(edge, nodesByName, sourceFileRanks, queryTerms, rawQuery) {
  const endpointNodes = [
    nodesByName.get(edge?.source),
    nodesByName.get(edge?.target),
  ].filter(Boolean);
  if (endpointNodes.length === 0) return true;
  if (endpointNodes.some(node => contextPackRelationshipNodePenalty(node, queryTerms, rawQuery) > 0)) {
    return false;
  }
  return endpointNodes.some(node => (
    contextPackSourceFileRank(node.filePath, sourceFileRanks) < CONTEXT_PACK_SOURCE_ORDERING_FILE_LIMIT
    || contextPackRelationshipNodeQueryScore(node, queryTerms) >= 100
  ));
}

function contextPackRelationshipNodeQueryScore(node, queryTerms) {
  if (!node) return 0;
  return scorePathTermMatch(node.filePath, queryTerms)
    + scoreContextPackSourceFileSymbols([node], queryTerms);
}

function buildContextPackNodesByName(nodes, sourceFileRanks = null, queryTerms = [], rawQuery = '') {
  const nodesByName = new Map();
  for (const node of nodes ?? []) {
    if (!node?.name) continue;
    const existing = nodesByName.get(node.name);
    if (
      !existing
      || compareRelatedGraphNodeOrder(node, existing, sourceFileRanks, queryTerms, rawQuery) < 0
    ) {
      nodesByName.set(node.name, node);
    }
  }
  return nodesByName;
}

function relationshipEdgeSourceOrder(edge, nodesByName, queryTerms = [], rawQuery = '') {
  const sourceNode = nodesByName.get(edge?.source);
  const targetNode = nodesByName.get(edge?.target);
  const sourcePenalty = contextPackRelationshipNodePenalty(sourceNode, queryTerms, rawQuery);
  const targetPenalty = contextPackRelationshipNodePenalty(targetNode, queryTerms, rawQuery);
  const pathPenalty = Math.min(sourcePenalty, targetPenalty);
  const explicitLine = normalizedLineNumber(edge?.line);
  if (explicitLine !== Number.MAX_SAFE_INTEGER) {
    return pathPenalty + explicitLine;
  }
  if (targetNode) {
    return pathPenalty + normalizedLineNumber(targetNode.startLine);
  }
  if (sourceNode) {
    return pathPenalty + normalizedLineNumber(sourceNode.startLine);
  }
  return Number.MAX_SAFE_INTEGER;
}

function contextPackRelationshipNodePenalty(node, queryTerms, rawQuery) {
  if (!node) return 500_000;
  if (queryMentionsTests(rawQuery)) return 0;
  if (queryExplicitlyRequestsContextPackSourcePath(node.filePath, queryTerms)) return 0;
  return contextPackSourceFileLowValuePenalty(node.filePath, queryTerms, rawQuery) > 0 ? 300_000 : 0;
}

function formatMatchSummary(match) {
  const item = match.item ?? {};
  const parts = [];
  if (item.selector) parts.push(`selector: ${item.selector}`);
  if (item.path !== undefined && item.path !== null) parts.push(`path: ${item.path}`);
  if (item.riskTags?.length) parts.push(`risk: ${item.riskTags.join(', ')}`);
  if (item.tests?.length) parts.push(`tests: ${item.tests.join(', ')}`);
  return parts.length > 0 ? ` — ${parts.join('; ')}` : '';
}

function groupNodesByFile(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const filePath = node.filePath || '(unknown)';
    const group = groups.get(filePath) ?? [];
    group.push(node);
    groups.set(filePath, group);
  }
  return [...groups.entries()]
    .map(([filePath, group]) => [filePath, group.sort(compareGraphNode)])
    .sort(([a], [b]) => a.localeCompare(b));
}

function groupMarkdownRelatedNodesByFile(nodes, sourceFileRanks = null, rawQuery = '') {
  const groups = new Map();
  const seenDisplayKeys = new Set();
  const queryTerms = queryTokens(rawQuery);
  const sortedNodes = nodes
    .filter(node => node?.kind !== 'import' && node?.kind !== 'export')
    .filter(node => {
      const key = markdownRelatedSymbolKey(node);
      if (seenDisplayKeys.has(key)) return false;
      seenDisplayKeys.add(key);
      return true;
    })
    .sort((a, b) => compareRelatedGraphNodeOrder(a, b, sourceFileRanks, queryTerms, rawQuery));
  const hasCleanRelatedNode = sortedNodes.some(node => (
    contextPackRelatedNodeLowValuePenalty(node, queryTerms, rawQuery) <= 0
  ));
  if (sortedNodes.length > 0 && !queryMentionsTests(rawQuery) && !hasCleanRelatedNode) {
    return [];
  }
  const visibleNodes = !queryMentionsTests(rawQuery) && hasCleanRelatedNode
    ? sortedNodes.filter(node => contextPackRelatedNodeLowValuePenalty(node, queryTerms, rawQuery) <= 0)
    : sortedNodes;
  for (const node of visibleNodes) {
    const filePath = node.filePath || '(unknown)';
    const group = groups.get(filePath) ?? [];
    group.push(node);
    groups.set(filePath, group);
  }
  return [...groups.entries()];
}

function compareRelatedGraphNodeOrder(a, b, sourceFileRanks, queryTerms = [], rawQuery = '') {
  return contextPackSourceFileRank(a?.filePath, sourceFileRanks) - contextPackSourceFileRank(b?.filePath, sourceFileRanks)
    || contextPackRelatedNodeLowValuePenalty(a, queryTerms, rawQuery) - contextPackRelatedNodeLowValuePenalty(b, queryTerms, rawQuery)
    || compareGraphNodeSourceOrder(a, b);
}

function contextPackRelatedNodeLowValuePenalty(node, queryTerms, rawQuery) {
  if (queryMentionsTests(rawQuery)) return 0;
  if (queryExplicitlyRequestsContextPackSourcePath(node?.filePath, queryTerms)) return 0;
  return contextPackSourceFileLowValuePenalty(node?.filePath, queryTerms, rawQuery) > 0 ? 300_000 : 0;
}

function contextPackSourceFileRank(filePath, sourceFileRanks) {
  if (!sourceFileRanks || sourceFileRanks.size === 0) return Number.MAX_SAFE_INTEGER;
  const normalizedFilePath = normalizeSearchPath(filePath);
  return sourceFileRanks.get(normalizedFilePath) ?? Number.MAX_SAFE_INTEGER;
}

function markdownRelatedSymbolKey(node) {
  return [
    node?.filePath ?? '',
    node?.name ?? '',
    node?.startLine ?? '',
  ].join('\0');
}

function compareGraphNode(a, b) {
  return String(a.filePath ?? '').localeCompare(String(b.filePath ?? ''))
    || String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
    || String(a.name ?? '').localeCompare(String(b.name ?? ''));
}

function compareGraphNodeSourceOrder(a, b) {
  return String(a?.filePath ?? '').localeCompare(String(b?.filePath ?? ''))
    || normalizedLineNumber(a?.startLine) - normalizedLineNumber(b?.startLine)
    || normalizedLineNumber(a?.endLine) - normalizedLineNumber(b?.endLine)
    || String(a?.kind ?? '').localeCompare(String(b?.kind ?? ''))
    || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

function normalizedLineNumber(value) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function buildRelationshipGroupsFromMatches(matches) {
  const groups = {};
  for (const match of matches) {
    if (match.kind === 'angular-component') {
      addEdge(groups, 'imports', match.name, match.item?.templateUrl, { kind: 'templateUrl' });
      for (const dependency of match.item?.dependencies ?? []) {
        addEdge(groups, 'type_of', match.name, dependency, { kind: 'dependency' });
      }
      for (const test of match.item?.tests ?? []) {
        addEdge(groups, 'tests', match.name, test, { kind: 'covered-by' });
      }
    }
  }
  return groups;
}

function addEdge(groups, kind, source, target, metadata = {}) {
  if (!source || !target) return;
  const group = groups[kind] ?? [];
  group.push({ source, target, ...metadata });
  groups[kind] = group;
}

function createNanoFlowOverlayToolDefinition() {
  return {
    name: 'nanoflow_overlay_query',
    description: 'Query NanoFlow-specific CodeGraph overlay relations: Angular metadata, inject() dependencies, dynamic imports, tests, Supabase risk tags, and AGENTS hard-rule anchors.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol, component, service, migration risk tag, file, or feature keyword to search.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        json: {
          type: 'boolean',
          default: false,
          description: 'Return machine-readable JSON instead of native CodeGraph-style Markdown. Mutually exclusive with nativeMarkdown.',
        },
        nativeJson: {
          type: 'boolean',
          default: false,
          description: 'Return the strict native CodeGraph JSON formatter projection without NanoFlow extension fields. Mutually exclusive with nativeMarkdown.',
        },
        nativeMarkdown: {
          type: 'boolean',
          default: false,
          description: 'Return the strict native CodeGraph Markdown formatter projection without NanoFlow extension sections. Mutually exclusive with json and nativeJson.',
        },
      },
      required: ['query'],
    },
  };
}

function createNanoFlowContextPackToolDefinition() {
  return {
    name: 'nanoflow_context_pack',
    description: 'Return a combined context pack with base CodeGraph exploration plus NanoFlow overlay relations for Angular, Supabase, tests, and hard rules.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Task, symbol, component, service, migration, or feature to explore.',
        },
        maxFiles: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 8,
          description: 'Maximum files to request from codegraph_explore.',
        },
        overlayLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Maximum NanoFlow overlay matches to include.',
        },
      },
      required: ['query'],
    },
  };
}

function writeJsonToClient(message, responseDiagnostics = {}) {
  if (message?.id !== undefined) {
    completeClientRequest(message.id, message, responseDiagnostics);
  }
  return writeToClient(JSON.stringify(message));
}

function writeToClient(line) {
  if (!clientMode) {
    diagnostics.log('client.write.pending', {
      bytes: Buffer.byteLength(line, 'utf8'),
      runtime: summarizeRuntimeState(),
    });
    pendingChildLines.push(line);
    return true;
  }

  clientOutputQueue.push({
    chunk: formatClientOutput(line),
    outputDiagnostics: buildClientOutputDiagnostics(line),
  });
  return flushClientOutputQueue();
}

function buildClientOutputDiagnostics(line) {
  let response;
  try {
    response = JSON.parse(String(line ?? ''));
  } catch {
    return {};
  }
  if (response?.id === undefined) {
    return {
      response: {
        id: undefined,
        ...summarizeMcpResponse(response),
      },
    };
  }
  const completedTrace = findRecentClientResponseTrace(response.id);
  return {
    responseId: response.id,
    ...(completedTrace ? {
      requestId: completedTrace.requestId,
      clientId: completedTrace.clientId,
      requestKind: completedTrace.requestKind,
      method: completedTrace.method,
      tool: completedTrace.tool,
      query: completedTrace.query,
    } : {}),
    response: {
      id: response.id,
      ...summarizeMcpResponse(response),
    },
  };
}

function findRecentClientResponseTrace(responseId) {
  for (let index = recentDiagnosticHistory.clientResponses.length - 1; index >= 0; index -= 1) {
    const entry = recentDiagnosticHistory.clientResponses[index];
    if (String(entry?.clientId) === String(responseId)) {
      return entry;
    }
  }
  return null;
}

function formatClientOutput(line) {
  if (clientMode === 'content-length') {
    const payload = Buffer.from(line, 'utf8');
    return Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8'),
      payload,
    ]);
  }

  return Buffer.from(`${line}\n`, 'utf8');
}

function flushClientOutputQueue() {
  if (clientStdoutBackpressured) {
    return false;
  }

  while (clientOutputQueue.length > 0) {
    const { chunk, outputDiagnostics = {} } = clientOutputQueue.shift();
    let ok = false;
    try {
      ok = process.stdout.write(chunk);
      lastClientOutputFlushAtMs = Date.now();
    } catch (error) {
      handleClientStdioError('stdout', error, {
        operation: 'write',
        bytes: chunk.length,
        queuedMessages: clientOutputQueue.length,
        bufferedChildStdoutBytes: childStdoutBuffer.length,
        ...outputDiagnostics,
      });
      return false;
    }
    if (!ok) {
      clientStdoutBackpressured = true;
      diagnostics.log('client.stdout.backpressure', {
        bytes: chunk.length,
        queuedMessages: clientOutputQueue.length,
        bufferedChildStdoutBytes: childStdoutBuffer.length,
        ...outputDiagnostics,
        runtime: summarizeRuntimeState(),
      });
      process.stdin.pause?.();
      child.stdout.pause?.();
      process.stdout.once('drain', onClientStdoutDrain);
      return false;
    }
  }

  return true;
}

function onClientStdoutDrain() {
  clientStdoutBackpressured = false;
  lastClientOutputFlushAtMs = Date.now();
  diagnostics.log('client.stdout.drain', {
    queuedMessages: clientOutputQueue.length,
    bufferedChildStdoutBytes: childStdoutBuffer.length,
    runtime: summarizeRuntimeState(),
  });

  if (!flushClientOutputQueue()) {
    return;
  }

  if (childStdoutBuffer.length > 0 && !drainChildOutput()) {
    return;
  }

  if (!childStdinBackpressured && !shuttingDown) {
    process.stdin.resume?.();
    drainClientInput();
  }
  child.stdout.resume?.();
}

function writeToWrapperStderr(chunk, options = {}) {
  try {
    return process.stderr.write(chunk);
  } catch (error) {
    const event = options.event ?? 'client.stderr.write.error';
    const failureClass = options.failureClass ?? 'client-stderr-write-error';
    const operation = options.operation ?? 'write-wrapper-stderr';
    const runtime = summarizeRuntimeStateSafely();
    diagnostics.log(event, {
      stream: 'stderr',
      failureClass,
      operation,
      childPid: options.childPid ?? child?.pid ?? null,
      reason: options.reason,
      bytes: diagnosticChunkByteLength(chunk),
      textTail: diagnosticChunkTextTail(chunk),
      error: serializeDiagnosticError(error),
      investigation: buildWrapperStderrWriteInvestigation(failureClass, operation),
      rootCauseSnapshot: buildRootCauseSnapshot(runtime),
      runtime,
    });
    return false;
  }
}

function diagnosticChunkByteLength(chunk) {
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  return Buffer.byteLength(String(chunk), 'utf8');
}

function diagnosticChunkTextTail(chunk) {
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString('utf8')
    : String(chunk);
  return text.trimEnd().slice(-2000);
}

function flushPendingChildLines() {
  diagnostics.log('client.write.flush-pending', {
    count: pendingChildLines.length,
    mode: clientMode,
    runtime: summarizeRuntimeState(),
  });
  while (pendingChildLines.length > 0) {
    writeToClient(pendingChildLines.shift());
  }
}

function createDiagnostics(root) {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const startedAtMs = Date.now();
  let logWriteFailureReported = false;
  let sequence = 0;
  const logPath = process.env.NANOFLOW_CODEGRAPH_MCP_LOG
    ? path.resolve(process.env.NANOFLOW_CODEGRAPH_MCP_LOG)
    : path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log');
  const maxLogBytes = Math.max(
    64 * 1024,
    parsePositiveIntegerEnv(
      'NANOFLOW_CODEGRAPH_MCP_LOG_MAX_BYTES',
      DIAGNOSTIC_LOG_MAX_BYTES_DEFAULT,
    ),
  );
  const archivePath = `${logPath}.1`;
  const lockPath = `${logPath}.lock`;

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    // Logging must never break MCP startup.
  }

  return {
    logPath,
    runId,
    startedAtMs,
    log(event, data = {}) {
      sequence += 1;
      const entry = {
        ts: new Date().toISOString(),
        runId,
        seq: sequence,
        sinceStartMs: Date.now() - startedAtMs,
        wrapperPid: process.pid,
        diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        event,
        ...data,
      };
      try {
        appendBoundedDiagnosticEntry({
          logPath,
          archivePath,
          lockPath,
          maxLogBytes,
          entry,
        });
      } catch (error) {
        if (!logWriteFailureReported) {
          logWriteFailureReported = true;
          const diagnosticError = serializeDiagnosticError(error);
          try {
            process.stderr.write(
              `[codegraph-nanoflow-mcp-stdio] Diagnostic log write failed event=${event} logPath=${logPath} error=${diagnosticError.code ?? diagnosticError.name}: ${diagnosticError.message}\n`,
            );
          } catch {
            // Keep stdout clean and never fail MCP because diagnostics failed.
          }
        }
      }
    },
  };
}

function appendBoundedDiagnosticEntry({ logPath, archivePath, lockPath, maxLogBytes, entry }) {
  withDiagnosticLogLock(lockPath, () => {
    let serialized = serializeDiagnosticEntry(entry, maxLogBytes);
    const currentBytes = fileSizeOrZero(logPath);
    if (currentBytes + Buffer.byteLength(serialized, 'utf8') > maxLogBytes) {
      entry.diagnosticLogRotation = rotateDiagnosticLog({
        logPath,
        archivePath,
        maxLogBytes,
        previousBytes: currentBytes,
      });
      serialized = serializeDiagnosticEntry(entry, maxLogBytes);
    }
    fs.appendFileSync(logPath, serialized, 'utf8');
  });
}

function serializeDiagnosticEntry(entry, maxLogBytes) {
  const serialized = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') <= maxLogBytes) {
    return serialized;
  }
  const compacted = {
    ts: entry.ts,
    runId: entry.runId,
    seq: entry.seq,
    sinceStartMs: entry.sinceStartMs,
    wrapperPid: entry.wrapperPid,
    diagnosticSchemaVersion: entry.diagnosticSchemaVersion,
    event: entry.event,
    requestId: entry.requestId,
    failureClass: entry.failureClass,
    diagnosticEntryTruncated: {
      originalBytes: Buffer.byteLength(serialized, 'utf8'),
      maxLogBytes,
      omittedKeys: Object.keys(entry).filter(key => ![
        'ts',
        'runId',
        'seq',
        'sinceStartMs',
        'wrapperPid',
        'diagnosticSchemaVersion',
        'event',
        'requestId',
        'failureClass',
      ].includes(key)),
    },
  };
  return `${JSON.stringify(compacted)}\n`;
}

function rotateDiagnosticLog({ logPath, archivePath, maxLogBytes, previousBytes }) {
  const archivedText = readDiagnosticLogTail(logPath, maxLogBytes);
  const temporaryArchivePath = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryArchivePath, archivedText, 'utf8');
  fs.rmSync(archivePath, { force: true });
  fs.renameSync(temporaryArchivePath, archivePath);
  fs.truncateSync(logPath, 0);
  return {
    reason: 'max-bytes-exceeded',
    maxLogBytes,
    previousBytes,
    archivedBytes: Buffer.byteLength(archivedText, 'utf8'),
    archivePath,
  };
}

function readDiagnosticLogTail(logPath, maxBytes) {
  if (!fs.existsSync(logPath)) return '';
  const size = fileSizeOrZero(logPath);
  if (size <= maxBytes) {
    return fs.readFileSync(logPath, 'utf8');
  }
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(size - start);
  const handle = fs.openSync(logPath, 'r');
  try {
    fs.readSync(handle, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(handle);
  }
  const text = buffer.toString('utf8');
  const firstNewline = text.indexOf('\n');
  return firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
}

function fileSizeOrZero(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function withDiagnosticLogLock(lockPath, callback) {
  const deadline = Date.now() + DIAGNOSTIC_LOG_LOCK_WAIT_MS;
  while (true) {
    let handle;
    try {
      handle = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      removeStaleDiagnosticLogLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for diagnostic log lock: ${lockPath}`);
      }
      sleepSync(5);
      continue;
    }
    try {
      return callback();
    } finally {
      fs.closeSync(handle);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function removeStaleDiagnosticLogLock(lockPath) {
  try {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs > DIAGNOSTIC_LOG_LOCK_STALE_MS) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Another writer may have released the lock between stat and removal.
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pickEnv(env, names) {
  return Object.fromEntries(
    names
      .filter(name => env[name] !== undefined)
      .map(name => [name, env[name]]),
  );
}

function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorToStack(error) {
  return error instanceof Error ? error.stack : undefined;
}

function parsePositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hashFileSha256(filePath) {
  try {
    return crypto.createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex');
  } catch {
    return null;
  }
}

function logWrapperScriptStaleIfNeeded() {
  if (wrapperScriptStaleDetails) {
    return wrapperScriptStaleDetails;
  }

  if (!WRAPPER_STARTUP_SCRIPT_SHA256) {
    return null;
  }

  const diskScriptSha256 = hashFileSha256(WRAPPER_SCRIPT_PATH);
  if (!diskScriptSha256 || diskScriptSha256 === WRAPPER_STARTUP_SCRIPT_SHA256) {
    return null;
  }

  wrapperScriptStaleDetails = {
    scriptPath: WRAPPER_SCRIPT_PATH,
    startupScriptSha256: WRAPPER_STARTUP_SCRIPT_SHA256,
    diskScriptSha256,
    staleAgainstDisk: true,
  };

  if (wrapperScriptStaleLogged) {
    return wrapperScriptStaleDetails;
  }

  wrapperScriptStaleLogged = true;
  const transportShouldStayAlive = !STALE_WRAPPER_AUTO_RECYCLE;
  diagnostics.log('wrapper.script.stale', {
    ...wrapperScriptStaleDetails,
    runtime: summarizeRuntimeState(),
    investigation: {
      failureBoundary: 'mcp-host-transport',
      failureClass: 'stale-wrapper-script',
      transportShouldStayAlive,
      likelyRootCause: STALE_WRAPPER_AUTO_RECYCLE
        ? 'The MCP host is still using a wrapper process that was started before the on-disk wrapper script changed; automatic stale-wrapper recycle is enabled and may surface as client-visible Transport closed after the current NanoFlow response'
        : 'The MCP host is still using a wrapper process that was started before the on-disk wrapper script changed; automatic recycle is disabled so the transport stays alive until the MCP host/session is restarted',
      nextEvidence: [
        'startupScriptSha256',
        'diskScriptSha256',
        'activeWrappers',
        'currentWrapper',
        'currentContextWrapper',
        STALE_WRAPPER_AUTO_RECYCLE
          ? 'wrapper.script.stale.recycle.request'
          : 'wrapper.script.stale.recycle.skipped',
      ],
    },
  });
  return wrapperScriptStaleDetails;
}

function logStaleWrapperScriptContinuation(message, requestTrace, source, staleDetails) {
  const transportShouldStayAlive = !STALE_WRAPPER_AUTO_RECYCLE;
  diagnostics.log('wrapper.script.stale.continue', {
    id: message.id,
    ...requestTraceDiagnostics(requestTrace),
    source,
    tool: message.params?.name,
    failureClass: 'stale-wrapper-script',
    ...staleDetails,
    investigation: {
      failureBoundary: 'mcp-host-transport',
      failureClass: 'stale-wrapper-script',
      transportShouldStayAlive,
      likelyRootCause: STALE_WRAPPER_AUTO_RECYCLE
        ? 'The MCP host is still routing this NanoFlow tool call to a wrapper process that was started before the on-disk wrapper script changed; automatic stale-wrapper recycle is enabled and may surface as client-visible Transport closed after the response'
        : 'The MCP host is still routing this NanoFlow tool call to a wrapper process that was started before the on-disk wrapper script changed; automatic recycle is disabled so the transport stays alive until the MCP host/session is restarted',
      nextEvidence: [
        'startupScriptSha256',
        'diskScriptSha256',
        'activeWrappers',
        'currentWrapper',
        'currentContextWrapper',
        'wrapper.script.stale.recycle.skipped',
      ],
    },
    runtime: summarizeRuntimeState(),
  });
}

function inspectCodexMcpConfigAlignment() {
  try {
    const helper = loadCodexConfigHelper();
    if (!helper.readCodexCodegraphMcpConfig) {
      return {
        status: 'unavailable',
        reason: 'codex-config-helper-missing',
        helperCandidates: helper.candidates,
      };
    }

    const codexConfig = helper.readCodexCodegraphMcpConfig(projectRoot);
    const config = summarizeCodexConfig(codexConfig);
    if (!codexConfig.exists) {
      return { status: 'unavailable', reason: 'codex-config-missing', config };
    }
    if (codexConfig.parseError) {
      return { status: 'unavailable', reason: 'codex-config-parse-error', config };
    }

    const server = (codexConfig.appliesToRoot || process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG)
      ? codexConfig.server
      : null;
    if (!server) {
      return { status: 'unavailable', reason: 'no-applicable-codegraph-server', config };
    }

    const args = Array.isArray(server.args) ? server.args : [];
    const expected = {
      wrapperScriptPath: args[0] ? resolveCodexConfigValue(args[0]) : null,
      codegraphTarget: args[1] ? resolveCodexConfigValue(args[1]) : null,
      codegraphArgs: args.slice(2).map(resolveCodexConfigValue),
      env: pickExpectedCodexConfigEnv(server.env),
    };
    const actual = {
      wrapperScriptPath: WRAPPER_SCRIPT_PATH,
      codegraphTarget,
      codegraphArgs,
      env: pickActualCodexConfigEnv(expected.env),
    };
    const mismatches = compareCodexConfigAlignment(expected, actual);
    if (CODEX_CONFIG_ALIGNMENT_MODE !== 'strict') {
      return {
        status: 'override',
        reason: 'wrapper-config-alignment-intentional-override',
        alignmentMode: CODEX_CONFIG_ALIGNMENT_MODE,
        config,
        expected,
        actual,
        mismatches,
      };
    }
    return {
      status: mismatches.length === 0 ? 'match' : 'mismatch',
      reason: mismatches.length === 0 ? 'current-wrapper-matches-codex-config' : 'current-wrapper-differs-from-codex-config',
      alignmentMode: CODEX_CONFIG_ALIGNMENT_MODE,
      config,
      expected,
      actual,
      mismatches,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'codex-config-alignment-error',
      error: serializeDiagnosticError(error),
    };
  }
}

function loadCodexConfigHelper() {
  const candidates = unique([
    path.join(path.dirname(WRAPPER_SCRIPT_PATH), 'codegraph-codex-config.cjs'),
    path.join(projectRoot, 'scripts', 'codegraph-codex-config.cjs'),
  ]);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const helper = require(candidate);
      if (typeof helper.readCodexCodegraphMcpConfig === 'function') {
        return {
          helperPath: candidate,
          candidates,
          readCodexCodegraphMcpConfig: helper.readCodexCodegraphMcpConfig,
        };
      }
    } catch {
      // Fall through to the next candidate; config diagnostics must not break MCP startup.
    }
  }
  return { helperPath: null, candidates, readCodexCodegraphMcpConfig: null };
}

function summarizeCodexConfig(codexConfig) {
  return {
    source: codexConfig?.source ?? 'codex',
    path: codexConfig?.path ?? null,
    exists: codexConfig?.exists ?? false,
    parseError: codexConfig?.parseError ?? null,
    appliesToRoot: codexConfig?.appliesToRoot ?? null,
  };
}

function resolveCodexConfigValue(value) {
  return String(value).replaceAll('${workspaceFolder}', projectRoot);
}

function pickExpectedCodexConfigEnv(env) {
  const source = env && typeof env === 'object' ? env : {};
  return Object.fromEntries(
    WRAPPER_CODEX_CONFIG_ENV_KEYS
      .filter(key => typeof source[key] === 'string')
      .map(key => [key, String(source[key])]),
  );
}

function pickActualCodexConfigEnv(expectedEnv) {
  return Object.fromEntries(
    Object.keys(expectedEnv ?? {})
      .map(key => [key, process.env[key] === undefined ? null : String(process.env[key])]),
  );
}

function compareCodexConfigAlignment(expected, actual) {
  const mismatches = [];
  if (
    expected.wrapperScriptPath
    && !samePathForDiagnostics(actual.wrapperScriptPath, expected.wrapperScriptPath)
  ) {
    mismatches.push({
      field: 'wrapperScriptPath',
      expected: expected.wrapperScriptPath,
      actual: actual.wrapperScriptPath,
    });
  }
  if (
    expected.codegraphTarget
    && !sameConfigValueForDiagnostics(actual.codegraphTarget, expected.codegraphTarget)
  ) {
    mismatches.push({
      field: 'codegraphTarget',
      expected: expected.codegraphTarget,
      actual: actual.codegraphTarget,
    });
  }
  for (const [key, expectedValue] of Object.entries(expected.env ?? {})) {
    const actualValue = actual.env?.[key] ?? null;
    if (!sameEnvValueForDiagnostics(key, actualValue, expectedValue)) {
      mismatches.push({
        field: `env.${key}`,
        expected: expectedValue,
        actual: actualValue,
      });
    }
  }
  return mismatches;
}

function samePathForDiagnostics(actual, expected) {
  try {
    return path.resolve(String(actual)).toLowerCase() === path.resolve(String(expected)).toLowerCase();
  } catch {
    return sameConfigValueForDiagnostics(actual, expected);
  }
}

function sameConfigValueForDiagnostics(actual, expected) {
  return normalizeConfigValueForDiagnostics(actual) === normalizeConfigValueForDiagnostics(expected);
}

function sameEnvValueForDiagnostics(key, actual, expected) {
  if (String(key).toLowerCase() === 'npm_config_cache') {
    return normalizeWindowsPathForDiagnostics(actual) === normalizeWindowsPathForDiagnostics(expected);
  }
  return actual === expected;
}

function normalizeWindowsPathForDiagnostics(value) {
  const normalized = path.win32.normalize(String(value ?? '').replace(/\//g, '\\'))
    .replace(/\\/g, '/')
    .toLowerCase();
  if (/^[a-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function normalizeConfigValueForDiagnostics(value) {
  return String(value ?? '').replace(/\\/g, '/').toLowerCase();
}

function summarizeCodexMcpConfigAlignment(alignment) {
  return {
    status: alignment?.status ?? 'unavailable',
    reason: alignment?.reason ?? null,
    alignmentMode: alignment?.alignmentMode ?? CODEX_CONFIG_ALIGNMENT_MODE,
    config: alignment?.config ?? null,
    expected: alignment?.expected ?? null,
    actual: alignment?.actual ?? null,
    mismatches: alignment?.mismatches ?? [],
    mismatchCount: Array.isArray(alignment?.mismatches) ? alignment.mismatches.length : 0,
  };
}

function logWrapperConfigAlignmentIfNeeded(source, requestTrace = null, alignment = inspectCodexMcpConfigAlignmentSafely()) {
  if (!alignment || (source !== 'startup' && (alignment.status === 'match' || alignment.status === 'override'))) {
    return;
  }
  const summary = summarizeCodexMcpConfigAlignment(alignment);
  const signature = JSON.stringify({
    status: summary.status,
    reason: summary.reason,
    mismatches: summary.mismatches,
  });
  if (source !== 'startup' && signature === wrapperConfigAlignmentLoggedSignature) {
    return;
  }
  wrapperConfigAlignmentLoggedSignature = signature;

  const event = summary.status === 'mismatch'
    ? 'wrapper.config.mismatch'
    : summary.status === 'override'
      ? 'wrapper.config.override'
      : summary.status === 'match'
        ? 'wrapper.config.match'
        : 'wrapper.config.unavailable';
  const runtime = summarizeConfigAlignmentRuntimeState(source);
  const investigation = buildWrapperConfigAlignmentInvestigation(summary.status);
  const recovery = buildWrapperConfigAlignmentRecovery(summary.status);
  const misdiagnosisGuards = buildWrapperConfigAlignmentMisdiagnosisGuards(summary);
  const requiredEvidenceBeforeConclusion = buildWrapperConfigAlignmentRequiredEvidenceBeforeConclusion(summary);
  diagnostics.log(event, {
    source,
    ...(requestTrace ? requestTraceDiagnostics(requestTrace) : {}),
    failureClass: summary.status === 'mismatch'
      ? 'mcp-host-config-mismatch'
      : summary.status === 'override'
        ? 'mcp-host-config-intentional-override'
        : summary.status === 'match'
          ? 'success'
          : 'mcp-host-config-unknown',
    ...summary,
    investigation,
    recovery,
    misdiagnosisGuards,
    requiredEvidenceBeforeConclusion,
    runtime,
  });

  if (summary.status === 'mismatch' || summary.status === 'unavailable') {
    logWrapperRuntimeDiagnostic({
      kind: 'configAlignment',
      failureClass: summary.status === 'mismatch'
        ? 'mcp-host-config-mismatch'
        : 'mcp-host-config-unknown',
      fatal: false,
      investigation,
      rootCauseSnapshot: buildConfigAlignmentRootCauseSnapshot(source, runtime),
      runtime,
      extra: {
        source,
        ...(requestTrace ? requestTraceDiagnostics(requestTrace) : {}),
        configAlignment: summary,
        recovery,
        misdiagnosisGuards,
        requiredEvidenceBeforeConclusion,
      },
    });
  }
}

function buildWrapperConfigAlignmentInvestigation(status) {
  if (status === 'match') {
    return {
      failureBoundary: 'codex-mcp-host',
      failureClass: 'success',
      transportShouldStayAlive: true,
      likelyRootCause: 'The running wrapper process matches the current Codex MCP config for wrapper path, CodeGraph target, and compared environment keys',
      nextEvidence: WRAPPER_CODEX_CONFIG_NEXT_EVIDENCE,
    };
  }
  if (status === 'mismatch') {
    return {
      failureBoundary: 'codex-mcp-host',
      failureClass: 'mcp-host-config-mismatch',
      transportShouldStayAlive: true,
      likelyRootCause: 'The MCP host is routing calls to a wrapper process whose startup target or environment differs from the current Codex config; restart the MCP host/session before trusting direct MCP results',
      nextEvidence: WRAPPER_CODEX_CONFIG_NEXT_EVIDENCE,
    };
  }
  if (status === 'override') {
    return {
      failureBoundary: 'codex-mcp-host',
      failureClass: 'mcp-host-config-intentional-override',
      transportShouldStayAlive: true,
      likelyRootCause: 'This wrapper was started by an adapter fallback or smoke diagnostic that intentionally overrides the active Codex MCP config; do not treat its target/env differences as a direct MCP host drift root cause',
      nextEvidence: WRAPPER_CODEX_CONFIG_NEXT_EVIDENCE,
    };
  }
  return {
    failureBoundary: 'codex-mcp-host',
    failureClass: 'mcp-host-config-unknown',
    transportShouldStayAlive: true,
    likelyRootCause: 'The wrapper could not inspect the current Codex MCP config, so use codegraph:adapter:doctor to determine whether direct MCP is trusted',
    nextEvidence: WRAPPER_CODEX_CONFIG_NEXT_EVIDENCE,
  };
}

function buildWrapperConfigAlignmentMisdiagnosisGuards(summary) {
  const status = summary?.status ?? 'unavailable';
  const alignmentMode = summary?.alignmentMode ?? CODEX_CONFIG_ALIGNMENT_MODE;
  if (status === 'mismatch') {
    return [
      {
        mistakenConclusion: 'adapter-source-regression',
        blockedBy: 'failureBoundary=codex-mcp-host; wrapper target/env mismatch is host/session config evidence, not adapter source behavior.',
        requiredEvidenceBeforeConclusion: `fresh adapter fallback (${FRESH_ADAPTER_FALLBACK_COMMAND}) reproduces the same failure after adapter doctor (${ADAPTER_DOCTOR_COMMAND}) confirms matching Codex config.`,
      },
      {
        mistakenConclusion: 'wrapper-transport-crash',
        blockedBy: 'transportShouldStayAlive=true; config mismatch is diagnostic evidence and does not close the MCP transport.',
        requiredEvidenceBeforeConclusion: 'wrapper.fatal, child.exit with active requests, or critical wrapper.exit in the current wrapper log window.',
      },
      {
        mistakenConclusion: 'overlay-timeout',
        blockedBy: 'Codex MCP host config drift is present; timeout symptoms from this direct MCP process are not actionable until config alignment is current.',
        requiredEvidenceBeforeConclusion: 'fresh wrapper run with matching Codex config reproduces overlay.query.timeout or nanoflow.context.timeout.',
      },
    ];
  }
  if (status === 'override') {
    return [
      {
        mistakenConclusion: 'live-codex-host-config-drift',
        blockedBy: `status=override alignmentMode=${alignmentMode}; target/env differences are intentional for adapter fallback or smoke diagnostics.`,
        requiredEvidenceBeforeConclusion: 'direct Codex MCP wrapper.start without override mode showing the same mismatch against C:\\Users\\MI\\.codex\\config.toml.',
      },
      {
        mistakenConclusion: 'adapter-source-regression',
        blockedBy: 'adapter fallback override is an evidence-gathering mode; it does not by itself prove adapter source failure.',
        requiredEvidenceBeforeConclusion: `${FRESH_ADAPTER_FALLBACK_COMMAND} reproduces an adapter failure with wrapper runtime diagnostics or failing response evidence.`,
      },
    ];
  }
  if (status === 'unavailable') {
    return [
      {
        mistakenConclusion: 'adapter-source-regression',
        blockedBy: 'Codex MCP config inspection is unavailable; adapter source behavior cannot be judged until config evidence is collected.',
        requiredEvidenceBeforeConclusion: ADAPTER_DOCTOR_COMMAND,
      },
      {
        mistakenConclusion: 'direct-mcp-healthy',
        blockedBy: 'Codex MCP config alignment is unknown; direct MCP trust is not established from this log event.',
        requiredEvidenceBeforeConclusion: 'wrapper.config.match or currentConfiguredWrapper evidence after Codex MCP host/session restart.',
      },
    ];
  }
  return [];
}

function buildWrapperConfigAlignmentRequiredEvidenceBeforeConclusion(summary) {
  const status = summary?.status ?? 'unavailable';
  if (status === 'mismatch') {
    return [
      {
        conclusion: 'adapter-source-regression',
        requiredEvidence: [
          `fresh adapter fallback (${FRESH_ADAPTER_FALLBACK_COMMAND}) reproduces the same failure`,
          `adapter doctor (${ADAPTER_DOCTOR_COMMAND}) confirms the current Codex MCP config and wrapper target/env`,
          'current wrapper.start matches the current on-disk wrapper script hash',
        ],
      },
      {
        conclusion: 'wrapper-transport-crash',
        requiredEvidence: [
          'wrapper.fatal',
          'child.exit with active requests',
          'critical wrapper.exit with active request or wrapper-process failure evidence',
        ],
      },
      {
        conclusion: 'overlay-timeout',
        requiredEvidence: [
          'fresh wrapper run with matching Codex config',
          'overlay.query.timeout or nanoflow.context.timeout from the fresh run',
        ],
      },
    ];
  }
  if (status === 'override') {
    return [
      {
        conclusion: 'live-codex-host-config-drift',
        requiredEvidence: [
          'direct Codex MCP wrapper.start without override mode',
          'wrapper.config.mismatch against C:\\Users\\MI\\.codex\\config.toml',
          `${ADAPTER_DOCTOR_COMMAND} showing the same live-process mismatch`,
        ],
      },
    ];
  }
  if (status === 'unavailable') {
    return [
      {
        conclusion: 'adapter-source-regression',
        requiredEvidence: [
          ADAPTER_DOCTOR_COMMAND,
          `${FRESH_ADAPTER_FALLBACK_COMMAND} reproduces the same failure`,
        ],
      },
    ];
  }
  return [];
}

function buildWrapperConfigAlignmentRecovery(status) {
  if (status === 'mismatch') {
    return [
      'Restart the Codex MCP host/session so direct MCP loads the current C:\\Users\\MI\\.codex\\config.toml.',
      `Until restart, use ${FRESH_ADAPTER_FALLBACK_COMMAND} for repository facts.`,
      `Run ${ADAPTER_DOCTOR_COMMAND} to compare the live wrapper target/env with the active Codex config.`,
    ];
  }
  if (status === 'unavailable') {
    return [
      `Run ${ADAPTER_DOCTOR_COMMAND} to inspect the active Codex MCP config and wrapper logs.`,
      `Until config inspection is available, use ${FRESH_ADAPTER_FALLBACK_COMMAND} for repository facts.`,
    ];
  }
  if (status === 'override') {
    return [
      'No direct MCP host repair is implied; this process is an adapter fallback or smoke diagnostic override.',
    ];
  }
  return [];
}

function summarizeConfigAlignmentRuntimeState(source) {
  if (source === 'startup') {
    return {
      childPid: null,
      childExited: false,
      shuttingDown: false,
      clientStdinShutdownRequested: false,
      clientMode: null,
      childStdinBackpressured: false,
      clientStdoutBackpressured: false,
      stdinBufferBytes: 0,
      pendingChildLineCount: 0,
      suppressedChildResponseCount: 0,
      suppressedChildResponseTimerCount: 0,
      expiredContextPackCount: 0,
      expiredContextPackTimerCount: 0,
      activeOverlayRefreshLockPath: null,
      activeRequestCount: 0,
      pendingContextPackCount: 0,
      pendingContextPackIds: [],
      pendingToolsListCount: 0,
      pendingToolsListIds: [],
      childInputQueueLength: 0,
      childInputQueueReasons: [],
      clientOutputQueueLength: 0,
      bufferedChildStdoutBytes: 0,
      staleWrapperAutoRecycle: STALE_WRAPPER_AUTO_RECYCLE,
      staleWrapperRecycleRequested: false,
      staleWrapperRecycleSkippedLogged: false,
      staleWrapperRecycleTimerActive: false,
      staleWrapperRecycleReason: null,
      staleWrapperRecycleDeferCount: 0,
      staleWrapperRecycleScheduledDelayMs: 0,
      staleWrapperRecycleRequestedAtMs: null,
      staleWrapperRecycleElapsedMs: null,
      lastClientOutputFlushAtMs: null,
      lastClientOutputAgeMs: null,
      activeRequests: [],
    };
  }
  return summarizeRuntimeStateSafely();
}

function buildConfigAlignmentRootCauseSnapshot(source, runtime) {
  if (source === 'startup') {
    return {
      diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      wrapperVersion: WRAPPER_VERSION,
      scriptPath: WRAPPER_SCRIPT_PATH,
      startupScriptSha256: WRAPPER_STARTUP_SCRIPT_SHA256,
      diskScriptSha256: hashFileSha256(WRAPPER_SCRIPT_PATH),
      codegraphTarget,
      codegraphArgs,
      projectRoot,
      cwd: process.cwd(),
      runtime,
      recentChildStderr: [],
      recentChildStdout: [],
      recentClientRequests: [],
      recentClientResponses: [],
    };
  }
  try {
    return buildRootCauseSnapshot(runtime);
  } catch (error) {
    return {
      diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      wrapperVersion: WRAPPER_VERSION,
      scriptPath: WRAPPER_SCRIPT_PATH,
      startupScriptSha256: WRAPPER_STARTUP_SCRIPT_SHA256,
      codegraphTarget,
      codegraphArgs,
      projectRoot,
      cwd: process.cwd(),
      runtime,
      snapshotError: serializeDiagnosticError(error),
    };
  }
}

function summarizeMcpMessage(message) {
  return {
    id: message?.id,
    method: message?.method,
    tool: message?.params?.name,
    ...summarizeDiagnosticQuery(getMessageQuery(message)),
    hasParams: Boolean(message?.params),
  };
}

function summarizeDiagnosticQuery(query) {
  if (typeof query !== 'string') {
    return {};
  }

  const queryChars = query.length;
  const queryBytes = Buffer.byteLength(query, 'utf8');
  if (queryChars <= DIAGNOSTIC_QUERY_PREVIEW_CHARS) {
    return {
      query,
      queryChars,
      queryBytes,
      queryTruncated: false,
    };
  }

  const separator = ' ... ';
  const tail = query.slice(-DIAGNOSTIC_QUERY_TAIL_CHARS);
  const headLength = DIAGNOSTIC_QUERY_PREVIEW_CHARS - separator.length - tail.length;
  return {
    query: `${query.slice(0, headLength)}${separator}${tail}`,
    queryChars,
    queryBytes,
    queryTruncated: true,
  };
}

function beginClientRequest(message, rawText = '') {
  if (message?.id === undefined) {
    return null;
  }

  const requestTrace = {
    requestId: `${diagnostics.runId}:request-${nextClientRequestId++}`,
    clientId: message.id,
    id: message.id,
    method: message.method,
    tool: message?.params?.name,
    query: getMessageQuery(message),
    requestKind: classifyClientRequest(message),
    mode: clientMode,
    rawMessageBytes: Buffer.byteLength(rawText, 'utf8'),
    startedAtMs: Date.now(),
  };
  logWrapperConfigAlignmentIfNeeded('client-request', requestTrace);
  activeClientRequests.set(String(message.id), requestTrace);
  rememberDiagnosticHistory('clientRequests', {
    requestId: requestTrace.requestId,
    clientId: requestTrace.clientId,
    requestKind: requestTrace.requestKind,
    method: requestTrace.method,
    tool: requestTrace.tool,
    ...summarizeDiagnosticQuery(requestTrace.query),
    rawMessageBytes: requestTrace.rawMessageBytes,
    startedAtMs: requestTrace.startedAtMs,
  });
  diagnostics.log('client.request.start', {
    ...requestTrace,
    ...summarizeDiagnosticQuery(requestTrace.query),
    hasParams: Boolean(message?.params),
    argumentKeys: getMessageArgumentKeys(message),
    activeRequestCount: activeClientRequests.size,
    runtime: summarizeRuntimeState(),
  });
  return requestTrace;
}

function completeClientRequest(id, response, extra = {}) {
  const requestTrace = getClientRequestTrace(id);
  const responseSummary = summarizeMcpResponse(response);
  if (!requestTrace) {
    diagnostics.log('client.response.untracked', {
      id,
      ...responseSummary,
      ...extra,
      runtime: summarizeRuntimeState(),
    });
    return;
  }

  activeClientRequests.delete(String(id));
  rememberDiagnosticHistory('clientResponses', {
    requestId: requestTrace.requestId,
    clientId: requestTrace.clientId,
    requestKind: requestTrace.requestKind,
    method: requestTrace.method,
    tool: requestTrace.tool,
    ...summarizeDiagnosticQuery(requestTrace.query),
    elapsedMs: Date.now() - requestTrace.startedAtMs,
    failureClass: extra.failureClass,
    isError: responseSummary.isError,
    hasError: responseSummary.hasError,
    errorCode: responseSummary.errorCode,
    errorMessage: responseSummary.errorMessage,
    textBytes: responseSummary.textBytes,
  });
  diagnostics.log('client.response', {
    ...requestTraceDiagnostics(requestTrace),
    id,
    method: requestTrace.method,
    tool: requestTrace.tool,
    rawMessageBytes: requestTrace.rawMessageBytes,
    elapsedMs: Date.now() - requestTrace.startedAtMs,
    activeRequestCount: activeClientRequests.size,
    runtime: summarizeRuntimeState(),
    ...responseSummary,
    ...extra,
  });
}

function getClientRequestTrace(id) {
  return activeClientRequests.get(String(id)) ?? null;
}

function requestTraceDiagnostics(requestTrace) {
  if (!requestTrace) {
    return {};
  }
  return {
    requestId: requestTrace.requestId,
    clientId: requestTrace.clientId,
    requestKind: requestTrace.requestKind,
    tool: requestTrace.tool,
    ...summarizeDiagnosticQuery(requestTrace.query),
    rawMessageBytes: requestTrace.rawMessageBytes,
  };
}

function classifyClientRequest(message) {
  if (isNanoFlowOverlayToolCall(message)) return 'nanoflow-overlay';
  if (isNanoFlowContextPackToolCall(message)) return 'nanoflow-context-pack';
  if (message?.method === 'tools/list') return 'tools-list';
  if (message?.method === 'initialize') return 'initialize';
  if (message?.method === 'tools/call') return message?.params?.name ? 'codegraph-tool' : 'tools-call';
  return message?.method ?? 'unknown';
}

function getMessageQuery(message) {
  const query = message?.params?.arguments?.query;
  return typeof query === 'string' ? query.trim() : undefined;
}

function getMessageArgumentKeys(message) {
  const args = message?.params?.arguments;
  return args && typeof args === 'object' && !Array.isArray(args)
    ? Object.keys(args).slice(0, 20)
    : undefined;
}

function summarizeMcpResponse(message) {
  const content = message?.result?.content;
  const textBytes = Array.isArray(content)
    ? content
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .reduce((total, part) => total + Buffer.byteLength(part.text, 'utf8'), 0)
    : undefined;
  const tools = message?.result?.tools;
  return {
    hasError: Boolean(message?.error),
    isError: Boolean(message?.error || message?.result?.isError),
    errorCode: message?.error?.code,
    errorMessage: message?.error?.message,
    contentPartCount: Array.isArray(content) ? content.length : undefined,
    textBytes,
    toolCount: Array.isArray(tools) ? tools.length : undefined,
    resultKeys: message?.result && typeof message.result === 'object'
      ? Object.keys(message.result).slice(0, 20)
      : undefined,
  };
}

function summarizeChildStderrDiagnostics(text) {
  const value = typeof text === 'string' ? text : '';
  if (isSharedDaemonConnectionLostText(value)) {
    return {
      failureClass: 'shared-daemon-fallback',
      textTail: warningTextTail(value, 2000),
      investigation: buildSharedDaemonFallbackInvestigation('shared-daemon-fallback'),
    };
  }
  if (isCodegraphFileWatcherActiveText(value) && isInProcessFallbackTopology(childRuntimeTopology)) {
    return {
      failureClass: 'shared-daemon-fallback-watcher',
      textTail: warningTextTail(value, 2000),
      investigation: buildSharedDaemonFallbackInvestigation('shared-daemon-fallback-watcher'),
    };
  }
  const warningSummary = summarizeMcpTextWarnings(value, { allowEmbeddedDiagnostic: true });
  if (warningSummary.codegraphAutoSyncDisabled) {
    return {
      failureClass: warningSummary.failureClass,
      textTail: warningSummary.textTail,
      investigation: buildBaseCodegraphStderrInvestigation(warningSummary.failureClass),
    };
  }

  if (isBaseCodegraphStderrExceptionText(value)) {
    return {
      failureClass: 'base-codegraph-stderr-exception',
      textTail: warningTextTail(value, 2000),
      investigation: buildBaseCodegraphStderrInvestigation('base-codegraph-stderr-exception'),
    };
  }

  return {
    textTail: warningTextTail(value, 2000),
  };
}

function buildBaseCodegraphStderrInvestigation(failureClass) {
  const likelyRootCauseByClass = {
    'codegraph-autosync-disabled': 'Base CodeGraph reported that file watching or auto-sync is disabled; index freshness cannot be trusted until the lock is released and the graph is synced.',
    'base-codegraph-stderr-exception': 'Base CodeGraph emitted exception-like stderr while the wrapper was serving a request; inspect textTail, runtime.activeRequests, and any following child.exit or client.response events.',
    'shared-daemon-fallback': 'The shared CodeGraph daemon connection was lost and the upstream proxy permanently switched this wrapper child to an in-process fallback engine.',
    'shared-daemon-fallback-watcher': 'The in-process fallback engine started its own file watcher, so this wrapper became another potential SQLite writer.',
  };
  return {
    failureBoundary: 'base-codegraph-child',
    failureClass,
    transportShouldStayAlive: true,
    likelyRootCause: likelyRootCauseByClass[failureClass]
      ?? 'Base CodeGraph emitted diagnostic stderr; inspect textTail and runtime.activeRequests before blaming the MCP host transport.',
    nextEvidence: [
      'textTail',
      'runtime.activeRequests',
      'rootCauseSnapshot.recentClientRequests',
      'child.exit',
      'child.close',
      'base-codegraph.pending.fail',
      'client.response',
    ],
  };
}

function isBaseCodegraphStderrExceptionText(text) {
  const value = String(text ?? '');
  return /(?:^|\n)\s*(?:ReferenceError|TypeError|SyntaxError|RangeError|EvalError|URIError|AssertionError|Error):\s+/m.test(value)
    || /(?:^|\n)\s+at\s+.+:\d+:\d+/m.test(value)
    || /Unhandled(?:Promise)?Rejection|uncaughtException/i.test(value);
}

function summarizeMcpTextWarnings(text, options = {}) {
  const value = typeof text === 'string' ? text : '';
  const codegraphAutoSyncDisabled = isCodegraphAutoSyncDisabledText(value, options);
  if (!codegraphAutoSyncDisabled) {
    return {
      codegraphAutoSyncDisabled: false,
    };
  }
  return {
    codegraphAutoSyncDisabled: true,
    failureClass: 'codegraph-autosync-disabled',
    textTail: warningTextTail(value),
  };
}

function mergeMcpTextWarnings(...summaries) {
  const codegraphSummary = summaries.find(summary => summary?.codegraphAutoSyncDisabled === true);
  if (codegraphSummary) {
    return {
      codegraphAutoSyncDisabled: true,
      failureClass: 'codegraph-autosync-disabled',
      textTail: codegraphSummary.textTail,
    };
  }
  return {
    codegraphAutoSyncDisabled: false,
  };
}

function isCodegraphAutoSyncDisabledText(text, options = {}) {
  const value = String(text ?? '');
  const lower = value.toLowerCase();
  if (options.allowEmbeddedDiagnostic === true) {
    return lower.includes('codegraph auto-sync is disabled')
      || (lower.includes('auto-sync disabled') && lower.includes('file lock'))
      || (lower.includes('index is frozen') && lower.includes('codegraph'));
  }

  const leadingLine = value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean);
  if (!leadingLine) return false;
  const normalizedLeadingLine = leadingLine
    .replace(/^>\s*/u, '')
    .replace(/^\*\*\s*/u, '')
    .replace(/^\u26a0\ufe0f?\s*/u, '')
    .replace(/^\*\*\s*/u, '')
    .toLowerCase();
  return normalizedLeadingLine.startsWith('codegraph auto-sync is disabled')
    || (
      normalizedLeadingLine.startsWith('auto-sync disabled')
      && (lower.includes('file lock') || lower.includes('index is frozen'))
    )
    || (
      normalizedLeadingLine.startsWith('codegraph')
      && normalizedLeadingLine.includes('index is frozen')
    );
}

function warningTextTail(text, maxLength = 1200) {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  const excerpt = warningTextExcerpt(value, maxLength);
  if (excerpt) return excerpt;
  return value.length > maxLength ? value.slice(-maxLength) : value;
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
  const end = Math.min(value.length, firstIndex + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < value.length ? '...' : '';
  return `${prefix}${value.slice(start, end)}${suffix}`;
}

function classifyOverlayQueryFailure({
  status,
  signal,
  error,
  timedOut,
  outputLimitExceeded,
  jsonOutput = false,
  jsonParseError = null,
  jsonShapeError = null,
  emptyJsonResponse = false,
  stderr = '',
}) {
  if (timedOut) return 'overlay-timeout';
  if (outputLimitExceeded) return 'overlay-max-buffer';
  if (error) return 'overlay-process-error';
  if (signal) return 'overlay-signal-exit';
  if (status !== 0 && String(stderr).split(/\r?\n/).includes(OVERLAY_STALE_SKIP_REFRESH)) {
    return OVERLAY_STALE_SKIP_REFRESH;
  }
  if (status === 0 && jsonOutput && emptyJsonResponse) return 'overlay-empty-response';
  if (status === 0 && jsonOutput && jsonParseError) return 'overlay-json-parse';
  if (status === 0 && jsonOutput && jsonShapeError) return 'overlay-invalid-json-shape';
  if (status === 0) return 'success';
  return 'overlay-nonzero-exit';
}

function validateOverlayJsonResponseShape(data, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'NanoFlow overlay query JSON response must be an object.';
  }
  if (!options.nativeJson && !Array.isArray(data.matches)) {
    return 'NanoFlow overlay query JSON response is missing matches.';
  }
  return null;
}

function summarizeRuntimeState() {
  const now = Date.now();
  return {
    childPid: child?.pid ?? null,
    runtimeTopology: childRuntimeTopology,
    childExited,
    shuttingDown,
    clientStdinShutdownRequested,
    clientMode,
    childStdinBackpressured,
    clientStdoutBackpressured,
    stdinBufferBytes: stdinBuffer.length,
    pendingChildLineCount: pendingChildLines.length,
    suppressedChildResponseCount: suppressedChildResponseIds.size,
    suppressedChildResponseTimerCount: suppressedChildResponseIdTimers.size,
    expiredContextPackCount: expiredContextPackIds.size,
    expiredContextPackTimerCount: expiredContextPackIdTimers.size,
    activeOverlayRefreshLockPath,
    sharedDaemonFallbackDetectedAtMs: sharedDaemonFallbackDetectedAtMs || null,
    sharedDaemonFallbackDetectedAgeMs: sharedDaemonFallbackDetectedAtMs > 0
      ? now - sharedDaemonFallbackDetectedAtMs
      : null,
    sharedDaemonFallbackRecoveryEnabled: SHARED_DAEMON_FALLBACK_RECOVERY_ENABLED,
    sharedDaemonFallbackRecoveryTimerActive: Boolean(sharedDaemonFallbackRecoveryTimer),
    sharedDaemonFallbackRecoveryRequestedAtMs: sharedDaemonFallbackRecoveryRequestedAtMs || null,
    sharedDaemonFallbackRecoveryElapsedMs: sharedDaemonFallbackRecoveryRequestedAtMs > 0
      ? now - sharedDaemonFallbackRecoveryRequestedAtMs
      : null,
    sharedDaemonFallbackRecoveryDeferCount,
    sharedDaemonFallbackRecoveryTrigger,
    activeRequestCount: activeClientRequests.size,
    pendingContextPackCount: pendingContextPacks.size,
    pendingContextPackIds: [...pendingContextPacks.keys()].slice(0, 8),
    pendingToolsListCount: pendingToolsListIds.size,
    pendingToolsListIds: [...pendingToolsListIds].slice(0, 8),
    childInputQueueLength: childInputQueue.length,
    childInputQueueReasons: childInputQueue.map(entry => entry.reason).slice(0, 8),
    clientOutputQueueLength: clientOutputQueue.length,
    bufferedChildStdoutBytes: childStdoutBuffer.length,
    staleWrapperAutoRecycle: STALE_WRAPPER_AUTO_RECYCLE,
    staleWrapperRecycleRequested,
    staleWrapperRecycleSkippedLogged,
    staleWrapperRecycleTimerActive: Boolean(staleWrapperRecycleTimer),
    staleWrapperRecycleReason,
    staleWrapperRecycleDeferCount,
    staleWrapperRecycleScheduledDelayMs,
    staleWrapperRecycleRequestedAtMs: staleWrapperRecycleRequestedAtMs || null,
    staleWrapperRecycleElapsedMs: staleWrapperRecycleRequestedAtMs > 0
      ? now - staleWrapperRecycleRequestedAtMs
      : null,
    lastClientOutputFlushAtMs: lastClientOutputFlushAtMs || null,
    lastClientOutputAgeMs: lastClientOutputFlushAtMs > 0
      ? now - lastClientOutputFlushAtMs
      : null,
    activeRequests: [...activeClientRequests.values()].slice(0, 8).map(requestTrace => ({
      requestId: requestTrace.requestId,
      clientId: requestTrace.clientId,
      requestKind: requestTrace.requestKind,
      method: requestTrace.method,
      tool: requestTrace.tool,
      ...summarizeDiagnosticQuery(requestTrace.query),
      elapsedMs: now - requestTrace.startedAtMs,
    })),
  };
}

function rememberDiagnosticHistory(name, entry) {
  const history = recentDiagnosticHistory[name];
  if (!Array.isArray(history)) {
    return;
  }
  history.push({
    atMs: Date.now(),
    ...entry,
  });
  while (history.length > RECENT_DIAGNOSTIC_ENTRY_LIMIT) {
    history.shift();
  }
}

function buildRootCauseSnapshot(runtime = summarizeRuntimeStateSafely()) {
  return {
    diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    wrapperVersion: WRAPPER_VERSION,
    scriptPath: WRAPPER_SCRIPT_PATH,
    startupScriptSha256: WRAPPER_STARTUP_SCRIPT_SHA256,
    diskScriptSha256: hashFileSha256(WRAPPER_SCRIPT_PATH),
    codegraphTarget,
    codegraphArgs,
    projectRoot,
    cwd: process.cwd(),
    runtime,
    recentChildStderr: recentDiagnosticHistory.childStderr.slice(-5),
    recentChildStdout: recentDiagnosticHistory.childStdout.slice(-5),
    recentClientRequests: recentDiagnosticHistory.clientRequests.slice(-8),
    recentClientResponses: recentDiagnosticHistory.clientResponses.slice(-8),
  };
}
