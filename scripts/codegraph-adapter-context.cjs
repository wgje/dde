#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isNodeCommand, readCodexCodegraphMcpConfig } = require('./codegraph-codex-config.cjs');
const {
  CODEGRAPH_DEDUP_MAINTENANCE_FOCUSED_QUERY,
} = require('./codegraph-nanoflow-dedup-query.cjs');
const {
  classifySpecializedMaintenanceQuery,
} = require('./codegraph-nanoflow-specialized-query.cjs');
const {
  OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS,
  buildNanoFlowContextOutcomeV1,
  parseNanoFlowContextOutcomeV1,
} = require('./lib/codegraph-context-outcome.cjs');

const DEFAULT_CODEGRAPH_TARGET = '@colbymchenry/codegraph@1.5.0';
const REQUIRED_FRESH_FALLBACK_ENV = {
  NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
  NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
};
const DEFAULT_QUERY = 'ProjectShellComponent';
const DEFAULT_TIMEOUT_MS = 60_000;
const WRAPPER_TIMEOUT_HEADROOM_MIN_MS = 2_500;
const WRAPPER_TIMEOUT_HEADROOM_MAX_MS = 5_000;
const TOOLING_TRIAGE_WRAPPER_TIMEOUT_MS = 15_000;
const TOOLING_QUALITY_FOCUSED_QUERY = 'codegraph adapter context wrapper log guard sourceOrdering sourceSelection';
const TOOLING_ISSUE_REGISTRY_FOCUSED_QUERY = 'docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues';
const TOOLING_TRIAGE_ANCHOR_SEGMENTS = new Set(['codegraph', 'nanoflow', 'mcp']);
const KNOWN_OVERLAY_MCP_FAILURE_CLASSES = new Set([
  OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS,
  'overlay-empty-response',
  'overlay-invalid-json-shape',
  'overlay-nonzero-exit',
  'overlay-timeout',
  'overlay-wrapper-error',
  'overlay-error',
]);
const KNOWN_CONTEXT_MCP_FAILURE_CLASSES = new Set([
  'base-codegraph-timeout',
  'base-codegraph-timeout-overlay-only',
  'base-codegraph-error',
  'base-codegraph-unavailable',
  'base-codegraph-child-exit',
  'context-pack-entry-error',
  'context-pack-error',
  'shared-daemon-fallback-recovery-max-wait',
  'child-stdout-stream-error',
]);
const TOOLING_TRIAGE_SEGMENTS = new Set([
  'adapter',
  'context',
  'doctor',
  'gate',
  'guard',
  'issue',
  'issues',
  'log',
  'logs',
  'ordering',
  'output',
  'outputs',
  'quality',
  'registry',
  'result',
  'results',
  'source',
  'stdio',
  'timeout',
  'timeouts',
  'token',
  'tokens',
  'transport',
  'truncation',
  'truncated',
  'wrapper',
]);
const TOOLING_OVERLAY_QUERY_NOISE_SEGMENTS = new Set([
  'android',
  'codegraph',
  'context',
  'logger',
  'main',
  'nanoflow',
  'noise',
  'noisy',
  'ordering',
  'output',
  'outputs',
  'pack',
  'polluted',
  'polluting',
  'pollution',
  'queries',
  'query',
  'result',
  'results',
  'service',
  'source',
  'telemetry',
  'test',
  'tests',
  'testing',
  'token',
  'tokens',
  'tooling',
  'truncated',
  'truncation',
]);
const TOOLING_QUALITY_SEGMENTS = new Set([
  'duplicate',
  'duplicates',
  'quality',
  'section',
  'sections',
  'sourceordering',
  'sourceselection',
  'selection',
]);
const TOOLING_DEDUP_MAINTENANCE_ANCHOR_SEGMENTS = new Set([
  'adapter',
  'codegraph',
  'mcp',
  'nanoflow',
  'overlay',
]);
const TOOLING_DEDUP_MAINTENANCE_INTENT_SEGMENTS = new Set([
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
  'upstream',
]);
const TOOLING_ISSUE_REGISTRY_ANCHOR_SEGMENTS = new Set([
  'adapter',
  'adaptation',
  'codegraph',
  'nanoflow',
]);
const TOOLING_ISSUE_REGISTRY_INTENT_SEGMENTS = new Set([
  'issue',
  'issues',
  'registry',
]);
const TOOLING_ISSUE_REGISTRY_STATUS_SEGMENTS = new Set([
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
const TOOLING_LOCALIZED_QUERY_ALIASES = [
  { pattern: /适配/, aliases: ['adapter', 'adaptation'] },
  { pattern: /问题|错误/, aliases: ['issue'] },
  { pattern: /登记|记录/, aliases: ['registry'] },
  { pattern: /文档/, aliases: ['doc'] },
  { pattern: /质量/, aliases: ['quality'] },
  { pattern: /修复/, aliases: ['fixed'] },
];

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    codegraphTarget: null,
    query: DEFAULT_QUERY,
    overlayQuery: null,
    overlayLimit: 20,
    overlayQueryLimit: 40,
    maxFiles: 8,
    maxFilesExplicit: false,
    json: false,
    includeOverlayJson: false,
    printOverlay: false,
    requireOverlayMatch: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    if (arg === '--root') parsed.root = next();
    else if (arg === '--codegraph-target') parsed.codegraphTarget = next();
    else if (arg === '--query') parsed.query = next();
    else if (arg === '--overlay-query') parsed.overlayQuery = next();
    else if (arg === '--overlay-limit') parsed.overlayLimit = parsePositiveInteger(next(), arg);
    else if (arg === '--overlay-query-limit') parsed.overlayQueryLimit = parsePositiveInteger(next(), arg);
    else if (arg === '--max-files') {
      parsed.maxFiles = parsePositiveInteger(next(), arg);
      parsed.maxFilesExplicit = true;
    }
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--include-overlay-json') parsed.includeOverlayJson = true;
    else if (arg === '--print-overlay') parsed.printOverlay = true;
    else if (arg === '--require-overlay-match') parsed.requireOverlayMatch = true;
    else if (arg === '--timeout-ms') parsed.timeoutMs = parsePositiveInteger(next(), arg);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.root = path.resolve(parsed.root);
  if (parsed.maxFiles < 1 || parsed.maxFiles > 20) {
    throw new Error('--max-files must be an integer between 1 and 20');
  }
  return parsed;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/codegraph-adapter-context.cjs [options]',
    '',
    'Starts a fresh NanoFlow CodeGraph wrapper and calls nanoflow_context_pack.',
    'Use this as the adapter-preserving fallback when the host MCP session is stale or unavailable.',
    '',
    'Options:',
    '  --root <path>                 Project root. Defaults to cwd.',
    '  --codegraph-target <target>   CodeGraph package spec or local fake script.',
    '  --query <query>               Context-pack query.',
    '  --overlay-query <query>       Overlay query for provenance JSON. Defaults to --query.',
    '  --overlay-limit <n>           Context-pack overlay limit.',
    '  --overlay-query-limit <n>     Overlay query limit.',
    '  --max-files <n>               Maximum base CodeGraph source files for nanoflow_context_pack.',
    '                                When omitted, the wrapper may auto-narrow focused tooling queries before using its default of 8.',
    '                                On base timeout, the CLI retries once with maxFiles=1.',
    '  --json                        Print context, compact overlay summary, and diagnostics as JSON.',
    '  --include-overlay-json        With --json, include full overlay JSON instead of a compact summary.',
    '  --print-overlay               In text mode, print overlay JSON after the context pack.',
    '  --require-overlay-match       Fail when the provenance overlay query is unavailable or returns zero results.',
    '  --timeout-ms <n>              Per-request timeout.',
    '                                Temporary wrapper logs are checked for critical transport failures and current source-ordering issues.',
    '',
  ].join('\n'));
}

function deriveWrapperRequestTimeoutMs(timeoutMs, options = {}) {
  const headroomMs = Math.min(
    WRAPPER_TIMEOUT_HEADROOM_MAX_MS,
    Math.max(WRAPPER_TIMEOUT_HEADROOM_MIN_MS, Math.floor(timeoutMs * 0.1)),
  );
  const derived = Math.max(1, timeoutMs - headroomMs);
  return shouldUseFastToolingTriageTimeout(options)
    ? Math.min(derived, TOOLING_TRIAGE_WRAPPER_TIMEOUT_MS)
    : derived;
}

function shouldUseFastToolingTriageTimeout(options) {
  return !options.maxFilesExplicit && isLikelyToolingTriageQuery(options.query);
}

function isLikelyToolingTriageQuery(query) {
  const segments = new Set(adapterContextQuerySegments(query));
  const hasAnchor = [...TOOLING_TRIAGE_ANCHOR_SEGMENTS].some(segment => segments.has(segment));
  const hasTriageTerm = [...TOOLING_TRIAGE_SEGMENTS].some(segment => segments.has(segment));
  return hasAnchor && hasTriageTerm;
}

function adapterContextQuerySegments(query) {
  const rawQuery = String(query ?? '');
  const segments = rawQuery
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)
    .map(segment => segment.toLowerCase())
    .filter(segment => segment.length >= 2);
  return unique([
    ...segments,
    ...localizedAdapterContextQueryAliases(rawQuery),
    ...adapterContextCompoundSegments(segments),
  ]);
}

function localizedAdapterContextQueryAliases(query) {
  const text = String(query ?? '');
  return TOOLING_LOCALIZED_QUERY_ALIASES
    .filter(entry => entry.pattern.test(text))
    .flatMap(entry => entry.aliases);
}

function adapterContextCompoundSegments(segments) {
  const aliases = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    const pair = `${segments[index]}:${segments[index + 1]}`;
    if (pair === 'code:graph') aliases.push('codegraph');
    else if (pair === 'nano:flow') aliases.push('nanoflow');
    else if (pair === 'source:selection') aliases.push('sourceselection');
    else if (pair === 'source:ordering') aliases.push('sourceordering');
    else if (pair === 'low:value') aliases.push('lowvalue');
  }
  return aliases;
}

function unique(values) {
  return [...new Set(values)];
}

function focusedAdapterOverlayQuery(query) {
  const rawQuery = String(query ?? '').trim();
  if (!rawQuery || !isLikelyToolingTriageQuery(rawQuery)) {
    return rawQuery;
  }

  const segments = adapterContextQuerySegments(rawQuery);
  const issueRegistryQuery = focusedAdapterIssueRegistryQuery(rawQuery, segments);
  if (issueRegistryQuery) {
    return issueRegistryQuery;
  }
  if (isLikelyDedupMaintenanceQuery(segments)) {
    return CODEGRAPH_DEDUP_MAINTENANCE_FOCUSED_QUERY;
  }
  const specializedMaintenanceQuery = classifySpecializedMaintenanceQuery({
    segments,
    codegraphTooling: true,
    context7Documentation: segments.includes('context7'),
  }).focusedQuery;
  if (specializedMaintenanceQuery) {
    return specializedMaintenanceQuery;
  }
  if (isLikelyToolingQualityQuery(segments)) {
    return TOOLING_QUALITY_FOCUSED_QUERY;
  }
  if (!segments.some(segment => TOOLING_OVERLAY_QUERY_NOISE_SEGMENTS.has(segment))) {
    return rawQuery;
  }

  const focused = unique(segments.filter(segment => !TOOLING_OVERLAY_QUERY_NOISE_SEGMENTS.has(segment)))
    .join(' ');
  return focused.length >= 2 ? focused : rawQuery;
}

function focusedAdapterIssueRegistryQuery(rawQuery, segments = adapterContextQuerySegments(rawQuery)) {
  const normalizedQuery = String(rawQuery ?? '').toLowerCase();
  if (normalizedQuery.includes('codegraph-nanoflow-adaptation-issues')) {
    return TOOLING_ISSUE_REGISTRY_FOCUSED_QUERY;
  }
  const segmentSet = new Set(segments);
  const hasAdapterAnchor = [...TOOLING_ISSUE_REGISTRY_ANCHOR_SEGMENTS]
    .some(segment => segmentSet.has(segment));
  const hasIssueRegistryIntent = [...TOOLING_ISSUE_REGISTRY_INTENT_SEGMENTS]
    .some(segment => segmentSet.has(segment));
  const hasStatusOrDocIntent = [...TOOLING_ISSUE_REGISTRY_STATUS_SEGMENTS]
    .some(segment => segmentSet.has(segment));
  return hasAdapterAnchor && hasIssueRegistryIntent && hasStatusOrDocIntent
    ? TOOLING_ISSUE_REGISTRY_FOCUSED_QUERY
    : '';
}

function isLikelyToolingQualityQuery(segments) {
  const segmentSet = new Set(segments);
  return segments.some(segment => TOOLING_QUALITY_SEGMENTS.has(segment))
    || (segmentSet.has('low') && segmentSet.has('value') && (
      segmentSet.has('source')
      || segmentSet.has('ordering')
      || segmentSet.has('section')
      || segmentSet.has('sections')
    ));
}

function isLikelyDedupMaintenanceQuery(segments) {
  const segmentSet = new Set(segments);
  const hasAnchor = [...TOOLING_DEDUP_MAINTENANCE_ANCHOR_SEGMENTS]
    .some(segment => segmentSet.has(segment));
  const hasMaintenanceIntent = [...TOOLING_DEDUP_MAINTENANCE_INTENT_SEGMENTS]
    .some(segment => segmentSet.has(segment));
  const hasStrongMaintenanceIntent = [
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
    'upstream',
  ].some(segment => segmentSet.has(segment));
  return hasAnchor && hasMaintenanceIntent && hasStrongMaintenanceIntent;
}

function resolveWrapperInvocation(options) {
  if (options.codegraphTarget) {
    return {
      wrapperScriptPath: path.join(options.root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
      codegraphTarget: options.codegraphTarget,
      codegraphArgs: ['serve', '--mcp', '--path', options.root],
      configEnv: {},
      configScope: 'cli-override',
      configPath: null,
      configContractOverride: false,
      configContractMismatches: [],
    };
  }

  const codexConfig = readCodexCodegraphMcpConfig(options.root);
  if (process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG && !codexConfig.exists) {
    throw new Error(`Codex MCP config not found: ${codexConfig.path}`);
  }
  if (codexConfig.parseError && process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG) {
    throw new Error(`Unsupported Codex MCP config in ${codexConfig.path}: ${codexConfig.parseError}`);
  }
  if (codexConfig.server && codexConfig.scope === 'project' && !codexConfig.appliesToRoot) {
    throw new Error(`Active project Codex CodeGraph config does not apply to ${path.resolve(options.root)}: ${codexConfig.path}`);
  }
  if (codexConfig.server) {
    const args = Array.isArray(codexConfig.server.args) ? codexConfig.server.args : [];
    if (!isNodeCommand(codexConfig.server.command) || args.length < 2) {
      throw new Error(`Unsupported Codex MCP config in ${codexConfig.path}`);
    }
    const configuredTarget = replaceWorkspaceFolder(args[1], options.root);
    const configuredEnv = resolveConfigEnv(codexConfig.server.env ?? {});
    const configContractMismatches = codexConfig.scope === 'override'
      ? []
      : freshFallbackConfigContractMismatches(configuredTarget, configuredEnv);
    const configContractOverride = configContractMismatches.length > 0;
    return {
      wrapperScriptPath: replaceWorkspaceFolder(args[0], options.root),
      codegraphTarget: configContractOverride ? DEFAULT_CODEGRAPH_TARGET : configuredTarget,
      codegraphArgs: args.slice(2).map(arg => replaceWorkspaceFolder(arg, options.root)),
      configEnv: configContractOverride
        ? { ...configuredEnv, ...REQUIRED_FRESH_FALLBACK_ENV }
        : configuredEnv,
      configScope: codexConfig.scope ?? null,
      configPath: codexConfig.path ?? null,
      configContractOverride,
      configContractMismatches,
    };
  }

  return {
    wrapperScriptPath: path.join(options.root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
    codegraphTarget: DEFAULT_CODEGRAPH_TARGET,
    codegraphArgs: ['serve', '--mcp', '--path', options.root],
    configEnv: { ...REQUIRED_FRESH_FALLBACK_ENV },
    configScope: codexConfig.scope ?? null,
    configPath: codexConfig.path ?? null,
    configContractOverride: false,
    configContractMismatches: [],
  };
}

function freshFallbackConfigContractMismatches(codegraphTarget, configEnv) {
  const mismatches = [];
  if (codegraphTarget !== DEFAULT_CODEGRAPH_TARGET) {
    mismatches.push({
      field: 'codegraphTarget',
      expected: DEFAULT_CODEGRAPH_TARGET,
      actual: codegraphTarget,
    });
  }
  for (const [key, expected] of Object.entries(REQUIRED_FRESH_FALLBACK_ENV)) {
    const actual = typeof configEnv[key] === 'string' ? configEnv[key] : null;
    if (actual !== expected) {
      mismatches.push({ field: `env.${key}`, expected, actual });
    }
  }
  return mismatches;
}

function replaceWorkspaceFolder(value, root) {
  return String(value).replaceAll('${workspaceFolder}', root);
}

function resolveConfigEnv(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => typeof value === 'string' && !String(value).includes('${input:'))
      .map(([key, value]) => [key, String(value)]),
  );
}

function createMcpClient(child, timeoutMs, options = {}) {
  let buffer = '';
  const waiters = [];
  let stderr = '';
  let terminalState = null;
  let observedExit = null;

  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    drainStdout();
  });

  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 16_384) {
      stderr = stderr.slice(-16_384);
    }
  });

  child.stdout.on?.('error', error => {
    failAllPendingRequests({
      event: 'stdout-error',
      error,
    });
  });

  child.stderr.on?.('error', error => {
    failAllPendingRequests({
      event: 'stderr-error',
      error,
    });
  });

  child.stdin.on?.('error', error => {
    failAllPendingRequests({
      event: 'stdin-error',
      error,
    });
  });

  child.once?.('error', error => {
    failAllPendingRequests({
      event: 'process-error',
      error,
    });
  });

  child.once?.('exit', (code, signal) => {
    observedExit = { code, signal };
  });

  child.once?.('close', (code, signal) => {
    failAllPendingRequests({
      event: 'close',
      code: code ?? observedExit?.code ?? null,
      signal: signal ?? observedExit?.signal ?? null,
    });
  });

  function drainStdout() {
    while (waiters.length > 0) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      const waiter = waiters.shift();
      try {
        waiter.resolve(JSON.parse(line));
      } catch (error) {
        waiter.reject(error);
      }
    }
  }

  function failAllPendingRequests(state) {
    terminalState = {
      ...state,
      stderrTail: stderr,
      logPath: options.logPath,
    };
    for (const waiter of [...waiters]) {
      waiter.reject(buildWrapperTerminalError(waiter.label, terminalState));
    }
  }

  function request(message, label) {
    return new Promise((resolve, reject) => {
      if (terminalState) {
        reject(buildWrapperTerminalError(label, terminalState));
        return;
      }
      let waiter;
      const cleanup = () => {
        clearTimeout(timer);
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          waiters.splice(waiterIndex, 1);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${label}. logPath=${options.logPath ?? 'n/a'} stderrTail=${stderr}`));
      }, timeoutMs);

      waiter = {
        label,
        resolve: value => {
          cleanup();
          resolve(value);
        },
        reject: error => {
          cleanup();
          reject(error);
        },
      };
      waiters.push(waiter);
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, error => {
          if (error) {
            waiter.reject(buildWrapperTerminalError(label, {
              event: 'stdin-write-error',
              error,
              stderrTail: stderr,
              logPath: options.logPath,
            }));
          }
        });
      } catch (error) {
        waiter.reject(buildWrapperTerminalError(label, {
          event: 'stdin-write-throw',
          error,
          stderrTail: stderr,
          logPath: options.logPath,
        }));
        return;
      }
      drainStdout();
    });
  }

  return { request, stderrTail: () => stderr };
}

function buildWrapperTerminalError(label, state) {
  const event = state?.event ?? 'unknown';
  const error = state?.error;
  const exited = event === 'close' || event === 'exit';
  const action = exited ? 'exited' : 'errored';
  const details = [
    `Wrapper process ${action} before ${label}.`,
    `event=${event}`,
  ];
  if (state?.code !== undefined) details.push(`exitCode=${state.code}`);
  if (state?.signal !== undefined) details.push(`signal=${state.signal}`);
  if (error?.code) details.push(`errorCode=${error.code}`);
  if (error?.message) details.push(`errorMessage=${error.message}`);
  details.push(`logPath=${state?.logPath ?? 'n/a'}`);
  details.push(`stderrTail=${state?.stderrTail ?? ''}`);
  return new Error(details.join(' '));
}

function assertToolsList(response, label) {
  const tools = response?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`${label} did not return result.tools`);
  }
  const toolNames = new Set(tools.map(tool => tool?.name));
  for (const name of ['codegraph_explore', 'nanoflow_context_pack', 'nanoflow_overlay_query']) {
    if (!toolNames.has(name)) {
      throw new Error(`${label} missing ${name}`);
    }
  }
}

function assertToolTextResponse(response, label) {
  if (response?.result?.isError) {
    throw new Error(`${label} returned MCP isError: ${response.result.content?.[0]?.text ?? ''}`);
  }
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`${label} returned no text content`);
  }
  return text;
}

function extractToolTextResponse(response) {
  return response?.result?.content?.[0]?.text;
}

function compactOverlayJson(overlayJson, limit = 8) {
  const matches = Array.isArray(overlayJson?.matches) ? overlayJson.matches : [];
  const entryPoints = Array.isArray(overlayJson?.entryPoints) ? overlayJson.entryPoints : [];
  const relationshipGroupCounts = overlayJson?.relationshipGroups && typeof overlayJson.relationshipGroups === 'object'
    ? Object.fromEntries(Object.entries(overlayJson.relationshipGroups)
      .map(([kind, value]) => [kind, Array.isArray(value) ? value.length : 0]))
    : {};

  return {
    query: overlayJson?.query ?? null,
    summary: overlayJson?.summary ?? null,
    count: Number.isFinite(Number(overlayJson?.count)) ? Number(overlayJson.count) : matches.length,
    matches: matches.slice(0, limit).map(compactOverlayMatch),
    entryPoints: entryPoints.slice(0, limit).map(compactOverlayNode),
    relationshipGroupCounts,
    truncated: matches.length > limit || entryPoints.length > limit,
    omittedFields: [
      'nodes',
      'edges',
      'codeBlocks',
      'relatedFiles',
      'markdown',
      'coverage',
    ],
  };
}

function overlayUnavailableSummary(failureClass, message, rawResponse = null) {
  return {
    unavailable: true,
    failureClass,
    message: String(message ?? '').slice(0, 2_000),
    rawResponse: typeof rawResponse === 'string'
      ? rawResponse.slice(0, 4_000)
      : null,
  };
}

function serializeAdapterError(error) {
  if (!error || typeof error !== 'object') {
    return {
      name: typeof error,
      message: String(error),
    };
  }
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : String(error),
    ...(typeof error.code === 'string' || typeof error.code === 'number' ? { code: error.code } : {}),
    ...(typeof error.errno === 'string' || typeof error.errno === 'number' ? { errno: error.errno } : {}),
    ...(typeof error.syscall === 'string' ? { syscall: error.syscall } : {}),
    ...(typeof error.signal === 'string' ? { signal: error.signal } : {}),
    ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
  };
}

function classifyOverlayRequestFailure(error) {
  const diagnosticError = serializeAdapterError(error);
  if (
    diagnosticError.code === 'ETIMEDOUT'
    || /Timed out waiting for nanoflow_overlay_query/i.test(diagnosticError.message)
  ) {
    return 'overlay-request-timeout';
  }
  if (/Wrapper process (?:exited|errored) before nanoflow_overlay_query/i.test(diagnosticError.message)) {
    return 'overlay-transport-error';
  }
  return 'overlay-request-error';
}

function shouldPreserveContextAcrossCriticalLogFailure(overlayResult) {
  return overlayResult?.failureClass === 'overlay-transport-error';
}

async function requestOverlayProvenance(client, message) {
  try {
    return parseOverlayProvenanceResponse(
      await client.request(message, 'nanoflow_overlay_query'),
    );
  } catch (error) {
    const diagnosticError = serializeAdapterError(error);
    const failureClass = classifyOverlayRequestFailure(error);
    return {
      ok: false,
      text: '',
      textBytes: 0,
      matchCount: 0,
      resultCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      failureClass,
      message: diagnosticError.message,
      error: diagnosticError,
      output: {
        ...overlayUnavailableSummary(failureClass, diagnosticError.message),
        error: diagnosticError,
      },
    };
  }
}

function parseOverlayProvenanceResponse(response) {
  const text = extractToolTextResponse(response);
  if (response?.result?.isError) {
    const declaredFailureClass = normalizeOverlayMcpFailureClass(
      response?.result?._meta?.nanoflowFailureClass,
    );
    if (declaredFailureClass) {
      return {
        ok: false,
        text,
        textBytes: Buffer.byteLength(text, 'utf8'),
        matchCount: 0,
        failureClass: declaredFailureClass,
        message: text || `nanoflow_overlay_query returned ${declaredFailureClass}`,
        output: overlayUnavailableSummary(declaredFailureClass, text, text || null),
      };
    }
    return {
      ok: false,
      text: '',
      textBytes: 0,
      matchCount: 0,
      failureClass: 'overlay-mcp-error',
      message: text || 'nanoflow_overlay_query returned MCP isError',
      output: overlayUnavailableSummary('overlay-mcp-error', text),
    };
  }

  if (typeof text !== 'string' || text.length === 0) {
    return {
      ok: false,
      text: '',
      textBytes: 0,
      matchCount: 0,
      failureClass: 'overlay-empty-response',
      message: 'nanoflow_overlay_query returned no text content',
      output: overlayUnavailableSummary('overlay-empty-response', 'nanoflow_overlay_query returned no text content'),
    };
  }

  try {
    const overlayJson = JSON.parse(text);
    if (!Array.isArray(overlayJson.matches)) {
      return {
        ok: false,
        text,
        textBytes: Buffer.byteLength(text, 'utf8'),
        matchCount: 0,
        failureClass: 'overlay-invalid-json-shape',
        message: 'nanoflow_overlay_query JSON response is missing matches',
        output: overlayUnavailableSummary(
          'overlay-invalid-json-shape',
          'nanoflow_overlay_query JSON response is missing matches',
          text,
        ),
      };
    }
    return {
      ok: true,
      text,
      textBytes: Buffer.byteLength(text, 'utf8'),
      matchCount: overlayJson.matches.length,
      resultCount: Number.isFinite(Number(overlayJson?.count)) ? Number(overlayJson.count) : overlayJson.matches.length,
      nodeCount: Array.isArray(overlayJson?.nodes) ? overlayJson.nodes.length : 0,
      edgeCount: Array.isArray(overlayJson?.edges) ? overlayJson.edges.length : 0,
      failureClass: 'success',
      message: null,
      overlayJson,
      output: overlayJson,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text,
      textBytes: Buffer.byteLength(text, 'utf8'),
      matchCount: 0,
      failureClass: 'overlay-json-parse-error',
      message,
      output: overlayUnavailableSummary('overlay-json-parse-error', message, text),
    };
  }
}

function normalizeOverlayMcpFailureClass(value) {
  if (value === 'overlay-json-parse') return 'overlay-json-parse-error';
  if (value === 'overlay-json-parse-error') return value;
  if (KNOWN_OVERLAY_MCP_FAILURE_CLASSES.has(value)) return value;
  return null;
}

function normalizeContextMcpFailureClass(value) {
  if (value === 'success') return null;
  return normalizeOverlayMcpFailureClass(value)
    ?? (KNOWN_CONTEXT_MCP_FAILURE_CLASSES.has(value) ? value : null);
}

function isBaseContextFailureClass(value) {
  return typeof value === 'string' && (
    value.startsWith('base-codegraph-')
    || value === 'shared-daemon-fallback-recovery-max-wait'
    || value === 'child-stdout-stream-error'
  );
}

function hasOwn(value, key) {
  return Boolean(value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key));
}

function compactOverlayMatch(match) {
  const item = match?.item && typeof match.item === 'object' ? match.item : {};
  return {
    kind: match?.kind ?? item.kind ?? null,
    name: match?.name ?? item.name ?? item.qualifiedName ?? null,
    file: match?.file ?? item.filePath ?? null,
    line: item.startLine ?? match?.line ?? null,
    score: match?.score ?? null,
  };
}

function compactOverlayNode(node) {
  return {
    kind: node?.kind ?? null,
    name: node?.name ?? node?.qualifiedName ?? null,
    filePath: node?.filePath ?? null,
    startLine: node?.startLine ?? null,
  };
}

function parseContextOutcomeMetadata(response, text, mcpIsError, declaredFailureClass) {
  const meta = response?.result?._meta;
  if (hasOwn(meta, 'nanoflowFailureClass')
    && meta.nanoflowFailureClass !== 'success'
    && !declaredFailureClass) return null;
  const hasCanonicalMetadata = [
    'nanoflowOutcomeSchemaVersion',
    'nanoflowOutcomeStatus',
    'nanoflowContextUsable',
  ].some(key => hasOwn(meta, key));
  if (!hasCanonicalMetadata) {
    return inferContextOutcomeFromLegacyMetadata({
      text,
      mcpIsError,
      failureClass: declaredFailureClass,
    });
  }
  if (meta?.nanoflowOutcomeSchemaVersion !== 1
    || !['complete', 'partial', 'failed'].includes(meta?.nanoflowOutcomeStatus)
    || typeof meta?.nanoflowContextUsable !== 'boolean') return null;

  const status = meta.nanoflowOutcomeStatus;
  const failureClass = status === 'complete' ? null : declaredFailureClass;
  const baseFailed = status !== 'complete' && isBaseContextFailureClass(failureClass);
  const baseStatus = status === 'complete'
    ? 'available'
    : (status === 'failed' || baseFailed ? 'unavailable' : 'available');
  const overlayStatus = status === 'complete'
    ? 'available'
    : (failureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS
        ? 'stale'
        : (status === 'partial' && baseFailed ? 'available' : 'unavailable'));
  const overlayOwnsFailure = typeof failureClass === 'string'
    && failureClass.startsWith('overlay-');
  const outcome = buildNanoFlowContextOutcomeV1({
    primaryFailureClass: failureClass,
    base: {
      status: baseStatus,
      isError: baseStatus === 'unavailable',
      textBytes: baseStatus === 'available' ? Buffer.byteLength(text, 'utf8') : 0,
      failureClass: baseFailed ? failureClass : null,
    },
    overlay: {
      status: overlayStatus,
      isError: overlayStatus !== 'available',
      failureClass: overlayStatus === 'available' || !overlayOwnsFailure ? null : failureClass,
      generationId: null,
    },
  });
  return outcome.status === status && outcome.usableContext === meta.nanoflowContextUsable
    ? outcome
    : null;
}

function inferContextOutcomeFromLegacyMetadata({ text, mcpIsError, failureClass }) {
  if (!failureClass) return null;
  const textBytes = Buffer.byteLength(text, 'utf8');
  if (isBaseContextFailureClass(failureClass)) {
    const overlayAvailable = failureClass === 'base-codegraph-timeout-overlay-only';
    return buildNanoFlowContextOutcomeV1({
      primaryFailureClass: failureClass,
      base: { status: 'unavailable', isError: true, textBytes: 0, failureClass },
      overlay: {
        status: overlayAvailable ? 'available' : 'unavailable',
        isError: !overlayAvailable,
        failureClass: null,
        generationId: null,
      },
    });
  }
  const baseAvailable = hasNativeExplorationText(text)
    && text.trim() !== OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS;
  return buildNanoFlowContextOutcomeV1({
    primaryFailureClass: failureClass,
    base: {
      status: baseAvailable ? 'available' : 'unavailable',
      isError: !baseAvailable && mcpIsError,
      textBytes: baseAvailable ? textBytes : 0,
    },
    overlay: {
      status: failureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS ? 'stale' : 'unavailable',
      isError: true,
      failureClass,
      generationId: null,
    },
  });
}

function invalidContextOutcome(failureClass) {
  return buildNanoFlowContextOutcomeV1({
    primaryFailureClass: failureClass,
    base: { status: 'unavailable', isError: true, textBytes: 0, failureClass },
    overlay: { status: 'unavailable', isError: true, failureClass: null, generationId: null },
  });
}

function hasContextOutcomeMetadata(response) {
  const meta = response?.result?._meta;
  return [
    'nanoflowFailureClass',
    'nanoflowOutcomeSchemaVersion',
    'nanoflowOutcomeStatus',
    'nanoflowContextUsable',
  ].some(key => hasOwn(meta, key));
}

function inferContextOutcomeFromText({ text, mcpIsError, declaredFailureClass, baseTimedOut }) {
  const textBytes = Buffer.byteLength(text, 'utf8');
  if (text.trim() === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS) {
    return buildNanoFlowContextOutcomeV1({
      primaryFailureClass: OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS,
      base: { status: 'unavailable', isError: true, textBytes: 0 },
      overlay: {
        status: 'stale',
        isError: true,
        failureClass: OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS,
        generationId: null,
      },
    });
  }

  if (baseTimedOut) {
    const overlayAvailable = hasNativeExplorationText(text);
    return buildNanoFlowContextOutcomeV1({
      primaryFailureClass: mcpIsError ? 'base-codegraph-timeout' : 'base-codegraph-timeout-overlay-only',
      base: {
        status: 'unavailable',
        isError: mcpIsError,
        textBytes: 0,
        failureClass: 'base-codegraph-timeout',
      },
      overlay: {
        status: overlayAvailable ? 'available' : 'unavailable',
        isError: !overlayAvailable,
        failureClass: overlayAvailable ? null : declaredFailureClass,
        generationId: null,
      },
    });
  }

  if (mcpIsError && hasNativeExplorationText(text) && text.includes('### NanoFlow Overlay Error')) {
    const overlayFailureClass = declaredFailureClass
      ?? (text.includes('NanoFlow overlay query timed out') ? 'overlay-timeout' : 'overlay-error');
    return buildNanoFlowContextOutcomeV1({
      primaryFailureClass: overlayFailureClass,
      base: { status: 'available', isError: false, textBytes },
      overlay: {
        status: overlayFailureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS ? 'stale' : 'unavailable',
        isError: true,
        failureClass: overlayFailureClass,
        generationId: null,
      },
    });
  }

  if (!mcpIsError) {
    return buildNanoFlowContextOutcomeV1({
      base: { status: textBytes > 0 ? 'available' : 'unavailable', isError: false, textBytes },
      overlay: { status: 'available', isError: false, failureClass: null, generationId: null },
    });
  }

  return buildNanoFlowContextOutcomeV1({
    primaryFailureClass: declaredFailureClass ?? 'mcp-error',
    base: { status: 'unavailable', isError: true, textBytes: 0 },
    overlay: {
      status: declaredFailureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS ? 'stale' : 'unavailable',
      isError: true,
      failureClass: declaredFailureClass,
      generationId: null,
    },
  });
}

function contextOutcomeFromResponse(response, text, mcpIsError, declaredFailureClass, baseTimedOut) {
  const structuredContent = response?.result?.structuredContent;
  if (hasOwn(structuredContent, 'outcome')) {
    return {
      outcome: parseNanoFlowContextOutcomeV1(structuredContent.outcome)
        ?? invalidContextOutcome('context-outcome-invalid'),
      source: 'structured',
    };
  }
  if (hasContextOutcomeMetadata(response)) {
    return {
      outcome: parseContextOutcomeMetadata(response, text, mcpIsError, declaredFailureClass)
        ?? invalidContextOutcome('context-outcome-metadata-invalid'),
      source: 'metadata',
    };
  }
  return {
    outcome: inferContextOutcomeFromText({ text, mcpIsError, declaredFailureClass, baseTimedOut }),
    source: 'text',
  };
}

function classifyContextPackResponse(response) {
  const text = extractToolTextResponse(response);
  const mcpIsError = Boolean(response?.result?.isError);
  const rawFailureClass = response?.result?._meta?.nanoflowFailureClass;
  const declaredFailureClass = normalizeContextMcpFailureClass(rawFailureClass);
  const baseTimedOut = hasBaseCodegraphTimeoutText(text);
  const resolvedOutcome = contextOutcomeFromResponse(
    response,
    text,
    mcpIsError,
    declaredFailureClass,
    baseTimedOut,
  );
  const outcome = resolvedOutcome.outcome;
  const failureClass = outcome.primaryFailureClass
    ?? (outcome.status === 'complete' ? 'success' : (mcpIsError ? 'mcp-error' : 'context-outcome-failed'));
  return {
    isError: !outcome.usableContext,
    mcpIsError,
    complete: outcome.status === 'complete',
    partial: outcome.status === 'partial',
    contextUsable: outcome.usableContext,
    outcome,
    outcomeSource: resolvedOutcome.source,
    failureClass,
    text: typeof text === 'string' ? text : '',
    textBytes: typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0,
  };
}

function summarizeContextPackAttempt(attempt, classified) {
  return {
    maxFiles: attempt.reportedMaxFiles,
    maxFilesExplicit: attempt.maxFilesExplicit,
    maxFilesOmitted: attempt.maxFilesOmitted,
    isError: classified.isError,
    mcpIsError: classified.mcpIsError,
    complete: classified.complete,
    partial: classified.partial,
    contextUsable: classified.contextUsable,
    outcomeStatus: classified.outcome?.status,
    failureClass: classified.failureClass,
    textBytes: classified.textBytes,
    textPreview: classified.text ? classified.text.slice(0, 240) : '',
  };
}

function hasNativeExplorationText(text) {
  return /(^|\n)(?:##\s+Exploration:|\*\*Exploration:)/.test(String(text ?? ''));
}

function hasBaseCodegraphTimeoutText(text) {
  if (typeof text !== 'string') return false;
  return text.includes('timed out waiting for base CodeGraph')
    || text.includes('Base CodeGraph timed out before returning source')
    || text.includes('No base CodeGraph context was returned.');
}

function contextPackMaxFilesAttempts(options) {
  const attempts = [{
    requestMaxFiles: options.maxFilesExplicit ? options.maxFiles : undefined,
    reportedMaxFiles: options.maxFiles,
    maxFilesExplicit: options.maxFilesExplicit,
    maxFilesOmitted: !options.maxFilesExplicit,
  }];
  if (options.maxFiles > 1) {
    attempts.push({
      requestMaxFiles: 1,
      reportedMaxFiles: 1,
      maxFilesExplicit: true,
      maxFilesOmitted: false,
    });
  }
  return attempts;
}

function isRetryableBaseTimeout(classified) {
  return classified.failureClass === 'base-codegraph-timeout'
    || classified.failureClass === 'base-codegraph-timeout-overlay-only';
}

function shouldAcceptToolingOverlayOnlyTimeout(options, attempt, classified) {
  return attempt.maxFilesOmitted
    && isLikelyToolingTriageQuery(options.query)
    && (
      classified.failureClass === 'base-codegraph-timeout-overlay-only'
      || (classified.failureClass === 'base-codegraph-timeout' && classified.partial)
    );
}

function acceptedContextPackResult(response, classified, attempts) {
  return {
    response,
    text: classified.text,
    attempts,
    complete: classified.complete,
    partial: classified.partial,
    contextUsable: classified.contextUsable,
    outcome: classified.outcome,
  };
}

async function requestContextPackWithRetries(client, nextId, options) {
  const attempts = [];
  let lastResponse = null;
  const maxFilesAttempts = contextPackMaxFilesAttempts(options);
  for (let attemptIndex = 0; attemptIndex < maxFilesAttempts.length; attemptIndex += 1) {
    const attemptConfig = maxFilesAttempts[attemptIndex];
    const isLastAttempt = attemptIndex === maxFilesAttempts.length - 1;
    const contextPackArguments = {
      query: options.query,
      overlayLimit: options.overlayLimit,
    };
    if (attemptConfig.requestMaxFiles !== undefined) {
      contextPackArguments.maxFiles = attemptConfig.requestMaxFiles;
    }
    const response = await client.request({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'nanoflow_context_pack',
        arguments: contextPackArguments,
      },
    }, attemptConfig.maxFilesOmitted
      ? 'nanoflow_context_pack wrapper-default maxFiles'
      : (attemptConfig.reportedMaxFiles === options.maxFiles
          ? 'nanoflow_context_pack'
          : `nanoflow_context_pack retry maxFiles=${attemptConfig.reportedMaxFiles}`));

    lastResponse = response;
    const classified = classifyContextPackResponse(response);
    const acceptToolingTimeout = shouldAcceptToolingOverlayOnlyTimeout(
      options,
      attemptConfig,
      classified,
    );
    const effectiveClassified = acceptToolingTimeout && classified.isError
      ? {
          ...classified,
          isError: false,
          partial: true,
          failureClass: 'base-codegraph-timeout-overlay-only',
        }
      : classified;
    const attempt = summarizeContextPackAttempt(attemptConfig, effectiveClassified);
    attempts.push(attempt);

    if (acceptToolingTimeout) {
      return acceptedContextPackResult(response, effectiveClassified, attempts);
    }

    if (classified.failureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS) {
      return acceptedContextPackResult(response, classified, attempts);
    }

    if (isRetryableBaseTimeout(classified) && !isLastAttempt) {
      continue;
    }

    if (!classified.isError) {
      return acceptedContextPackResult(response, classified, attempts);
    }

    if (classified.outcomeSource !== 'text') {
      return acceptedContextPackResult(response, classified, attempts);
    }

    if (!isRetryableBaseTimeout(classified)) {
      break;
    }
  }

  assertToolTextResponse(lastResponse, 'nanoflow_context_pack');
  throw new Error('nanoflow_context_pack returned no response');
}

function analyzeLog(root, logPath, options = {}) {
  const analyzerPath = path.join(root, 'scripts', 'analyze-codegraph-mcp-log.cjs');
  const analyzerArgs = [
    analyzerPath,
    logPath,
    '--json',
    '--fail-on-current-source-ordering',
    '--project-root',
    root,
  ];
  if (!options.allowCriticalTransportFailure) {
    analyzerArgs.push('--fail-on-critical');
  }
  const result = spawnSync(
    process.execPath,
    analyzerArgs,
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `MCP log guard failed with status ${result.status}`,
      result.stdout,
      result.stderr,
      result.error?.message ?? '',
    ].join('\n'));
  }

  return JSON.parse(result.stdout);
}

function createChildCloseTracker(child) {
  let closed = false;
  let closeResult = null;
  let resolveClose;
  const closePromise = new Promise(resolve => {
    resolveClose = resolve;
  });
  child.once('close', (code, signal) => {
    closed = true;
    closeResult = { code, signal };
    resolveClose(closeResult);
  });
  return {
    isClosed: () => closed,
    result: () => closeResult,
    wait(timeoutMs) {
      if (closed) return Promise.resolve(closeResult);
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        closePromise.then(result => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
  };
}

function endChildInput(child) {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
  try {
    child.stdin.end();
  } catch {
    // The process may already be closing; the close tracker remains authoritative.
  }
}

function signalChild(child, signal) {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function terminateWindowsProcessTree(pid) {
  return new Promise(resolve => {
    if (!pid) {
      resolve({ attempted: false, code: null, signal: null, error: null });
      return;
    }
    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      resolve({ attempted: true, code: null, signal: null, error });
      return;
    }
    let settled = false;
    const settle = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    killer.once('error', error => {
      settle({ attempted: true, code: null, signal: null, error });
    });
    killer.once('close', (code, signal) => {
      settle({ attempted: true, code, signal, error: null });
    });
  });
}

async function shutdownProcessTree(child, closeTracker, options = {}) {
  if (!child || closeTracker.isClosed()) return closeTracker.result();

  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3_000;
  const forcedTimeoutMs = options.forcedTimeoutMs ?? 3_000;
  endChildInput(child);
  const gracefulClose = await closeTracker.wait(gracefulTimeoutMs);
  if (gracefulClose) return gracefulClose;

  if (process.platform === 'win32') {
    const taskkill = await terminateWindowsProcessTree(child.pid);
    if (taskkill.error) {
      signalChild(child, 'SIGTERM');
    }
  } else {
    signalChild(child, 'SIGTERM');
  }

  const terminatedClose = await closeTracker.wait(forcedTimeoutMs);
  if (terminatedClose) return terminatedClose;

  signalChild(child, 'SIGKILL');
  return closeTracker.wait(forcedTimeoutMs);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const invocation = resolveWrapperInvocation(options);
  const wrapperRequestTimeoutMs = deriveWrapperRequestTimeoutMs(options.timeoutMs, options);
  const explicitLogPath = process.env.NANOFLOW_CODEGRAPH_MCP_LOG
    ? path.resolve(process.env.NANOFLOW_CODEGRAPH_MCP_LOG)
    : null;
  const logRoot = explicitLogPath
    ? path.dirname(explicitLogPath)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-'));
  fs.mkdirSync(logRoot, { recursive: true });
  const logPath = explicitLogPath ?? path.join(logRoot, 'wrapper.log');
  if (explicitLogPath) {
    fs.rmSync(explicitLogPath, { force: true });
  }

  const child = spawn(
    process.execPath,
    [
      invocation.wrapperScriptPath,
      invocation.codegraphTarget,
      ...invocation.codegraphArgs,
    ],
    {
      cwd: options.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...invocation.configEnv,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_NO_WATCH: '1',
        NANOFLOW_CODEGRAPH_ALLOW_DAEMON: '0',
        NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE: 'adapter-fallback',
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: String(wrapperRequestTimeoutMs),
        NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: String(wrapperRequestTimeoutMs),
      },
      windowsHide: true,
    },
  );
  const childCloseTracker = createChildCloseTracker(child);
  const client = createMcpClient(child, options.timeoutMs, { logPath });
  let nextRequestId = 1;
  const nextId = () => nextRequestId++;

  try {
    const tools = await client.request(
      { jsonrpc: '2.0', id: nextId(), method: 'tools/list' },
      'tools/list',
    );
    assertToolsList(tools, 'tools/list');

    const contextResult = await requestContextPackWithRetries(client, nextId, options);
    const contextText = contextResult.text;
    const effectiveOverlayQuery = options.overlayQuery ?? focusedAdapterOverlayQuery(options.query);

    const overlayResult = await requestOverlayProvenance(client, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'nanoflow_overlay_query',
        arguments: { query: effectiveOverlayQuery, limit: options.overlayQueryLimit, json: true },
      },
    });

    await shutdownProcessTree(child, childCloseTracker);
    const logAnalysis = analyzeLog(options.root, logPath, {
      allowCriticalTransportFailure: shouldPreserveContextAcrossCriticalLogFailure(overlayResult),
    });
    if (options.requireOverlayMatch && (!overlayResult.ok || overlayResult.resultCount < 1)) {
      const failureClass = overlayResult.failureClass ?? 'overlay-empty-result';
      throw new Error([
        `Overlay query "${effectiveOverlayQuery}" returned no usable results for adapter context gate.`,
        `failureClass=${failureClass}`,
        `matchCount=${overlayResult.matchCount ?? 0}`,
        `resultCount=${overlayResult.resultCount ?? 0}`,
        `nodeCount=${overlayResult.nodeCount ?? 0}`,
        `edgeCount=${overlayResult.edgeCount ?? 0}`,
        `logPath=${logPath}`,
        'Rerun without --require-overlay-match to inspect the context-only response.',
      ].join('\n'));
    }
    const overlayOutput = overlayResult.ok
      ? (options.includeOverlayJson ? overlayResult.overlayJson : compactOverlayJson(overlayResult.overlayJson))
      : overlayResult.output;
    const malformedOverlayResponse = [
      'overlay-empty-response',
      'overlay-json-parse-error',
      'overlay-invalid-json-shape',
    ].includes(overlayResult.failureClass);
    const staleSkipRefreshFailure = (
      overlayResult.failureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS
      || contextResult.attempts.some(
        attempt => attempt.failureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS,
      )
    );
    const strictPartialContextFailure = contextResult.partial
      && contextResult.outcome?.base?.status === 'available'
      && contextResult.outcome?.overlay?.status !== 'available';
    const summary = {
      ok: contextResult.complete
        && !malformedOverlayResponse
        && !staleSkipRefreshFailure
        && !strictPartialContextFailure,
      complete: contextResult.complete,
      partial: contextResult.partial,
      contextUsable: contextResult.contextUsable,
      outcome: contextResult.outcome,
      query: options.query,
      overlayQuery: effectiveOverlayQuery,
      logPath,
      wrapperScriptPath: invocation.wrapperScriptPath,
      codegraphTarget: invocation.codegraphTarget,
      configScope: invocation.configScope,
      configPath: invocation.configPath,
      configContractOverride: invocation.configContractOverride,
      configContractMismatches: invocation.configContractMismatches,
      timeoutMs: options.timeoutMs,
      wrapperRequestTimeoutMs,
      toolingTriageFastTimeout: shouldUseFastToolingTriageTimeout(options),
      maxFiles: options.maxFiles,
      maxFilesExplicit: options.maxFilesExplicit,
      contextText,
      overlay: overlayOutput,
      diagnostics: {
        contextTextBytes: Buffer.byteLength(contextText, 'utf8'),
        overlayTextBytes: overlayResult.textBytes,
        overlayCompacted: !options.includeOverlayJson,
        contextAttempts: contextResult.attempts,
        overlayMatchCount: overlayResult.matchCount,
        overlayResultCount: overlayResult.resultCount ?? 0,
        overlayNodeCount: overlayResult.nodeCount ?? 0,
        overlayEdgeCount: overlayResult.edgeCount ?? 0,
        overlayUnavailable: !overlayResult.ok,
        overlayMalformed: malformedOverlayResponse,
        overlayFailureClass: overlayResult.failureClass,
        overlayFailureMessage: overlayResult.message,
        overlayRequestError: overlayResult.error ?? null,
        transportHealthy: logAnalysis.transportHealthy,
        criticalTransportFailures: logAnalysis.criticalTransportFailures,
        overlayTimeouts: logAnalysis.overlayTimeouts,
        currentWrapper: logAnalysis.currentWrapper,
        currentContextWrapper: logAnalysis.currentContextWrapper,
        currentContextSourceOrdering: logAnalysis.currentContextSourceOrdering,
        currentDiskContextWrapper: logAnalysis.currentDiskContextWrapper,
        currentDiskContextSourceOrdering: logAnalysis.currentDiskContextSourceOrdering,
        activeWrappers: logAnalysis.activeWrappers,
      },
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }

    process.stdout.write(contextText.endsWith('\n') ? contextText : `${contextText}\n`);
    if (options.printOverlay) {
      process.stdout.write('\n--- NanoFlow overlay JSON ---\n');
      process.stdout.write(`${JSON.stringify(overlayOutput, null, 2)}\n`);
    }
  } finally {
    await shutdownProcessTree(child, childCloseTracker);
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  createChildCloseTracker,
  requestOverlayProvenance,
  resolveWrapperInvocation,
  shutdownProcessTree,
  shouldPreserveContextAcrossCriticalLogFailure,
};
