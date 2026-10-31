#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  isNodeCommand,
  readCodexCodegraphMcpConfig,
  repairCodexCodegraphMcpConfig,
} = require('./codegraph-codex-config.cjs');
const {
  commandLineContainsPath,
  commandLineLooksLikeWrapperProcess,
  readLiveProcessList,
  terminateWrapperProcessTree,
} = require('./codegraph-adapter-doctor-live-processes.cjs');
const {
  readOverlayCurrentReceipt,
} = require('./lib/codegraph-overlay-current-receipt.cjs');

const REQUIRED_PACKAGE_SCRIPTS = new Map([
  ['codegraph:adapter:gate', 'node scripts/run-codegraph-adapter-gate.cjs'],
  ['codegraph:adapter:quick-gate', 'node scripts/run-codegraph-adapter-gate.cjs --profile quick'],
  ['codegraph:adapter:context', 'node scripts/codegraph-adapter-context.cjs'],
  ['codegraph:adapter:doctor', 'node scripts/codegraph-adapter-doctor.cjs'],
  ['codegraph:adapter:preflight', 'node scripts/codegraph-adapter-preflight.cjs'],
  ['codegraph:overlay:validate', 'npm run codegraph:overlay:docs:assert-clean && npm run codegraph:overlay:docs:validate'],
  ['codegraph:overlay:baseline:manifest', 'node scripts/generate-codegraph-overlay-baseline-manifest.cjs'],
  ['agent:file-lease', 'node scripts/agent-file-lease.cjs'],
]);
const REQUIRED_CODEX_MCP_ENV = new Map([
  ['CODEGRAPH_NO_DAEMON', '0'],
  ['CODEGRAPH_NO_WATCH', '0'],
  ['CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS', '300000'],
  ['CODEGRAPH_DAEMON_MAX_IDLE_MS', '1800000'],
  ['NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS', '30000'],
  ['NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE', '0'],
]);
const REQUIRED_CODEGRAPH_TARGET = '@colbymchenry/codegraph@1.5.0';
const HOST_MCP_ENV_KEYS_TO_COMPARE = [
  'CODEGRAPH_NO_DAEMON',
  'CODEGRAPH_NO_WATCH',
  'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
  'CODEGRAPH_DAEMON_MAX_IDLE_MS',
  'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS',
  'NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS',
  'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
];
const DIRECT_MCP_INCIDENT_SCHEMA_VERSION = 1;
const OVERLAY_AGE_HINT_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WRAPPER_WINDOW_MS = 30 * 60 * 1000;
const LIVE_PROCESS_START_CLOCK_SKEW_MS = 5_000;
const STALE_WRAPPER_CLEANUP_MIN_IDLE_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    explain: false,
    json: false,
    repairConfig: false,
    cleanupStaleWrappers: false,
    applyCleanup: false,
    cleanupMinIdleMs: STALE_WRAPPER_CLEANUP_MIN_IDLE_MS,
    cleanupRunIds: [],
    strict: false,
    directMcpError: null,
    observedAt: null,
    timeoutMs: null,
    phase: 'pre-generation',
    phaseExplicit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--root requires a value');
      }
      parsed.root = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--explain') {
      parsed.explain = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--repair-config') {
      parsed.repairConfig = true;
      continue;
    }
    if (arg === '--cleanup-stale-wrappers') {
      parsed.cleanupStaleWrappers = true;
      continue;
    }
    if (arg === '--apply-cleanup') {
      parsed.applyCleanup = true;
      continue;
    }
    if (arg === '--cleanup-min-idle-ms') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--cleanup-min-idle-ms requires a value');
      }
      parsed.cleanupMinIdleMs = parsePositiveIntegerArg('--cleanup-min-idle-ms', value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--cleanup-min-idle-ms=')) {
      parsed.cleanupMinIdleMs = parsePositiveIntegerArg(
        '--cleanup-min-idle-ms',
        arg.slice('--cleanup-min-idle-ms='.length),
      );
      continue;
    }
    if (arg === '--cleanup-run-id') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--cleanup-run-id requires a value');
      }
      parsed.cleanupRunIds.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--cleanup-run-id=')) {
      const value = arg.slice('--cleanup-run-id='.length);
      if (!value) {
        throw new Error('--cleanup-run-id requires a value');
      }
      parsed.cleanupRunIds.push(value);
      continue;
    }
    if (arg === '--strict') {
      parsed.strict = true;
      continue;
    }
    if (arg === '--phase') {
      const value = argv[index + 1];
      if (!value) throw new Error('--phase requires a value');
      if (value !== 'pre-generation' && value !== 'post-generation') {
        throw new Error('--phase must be pre-generation or post-generation');
      }
      parsed.phase = value;
      parsed.phaseExplicit = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('--phase=')) {
      const value = arg.slice('--phase='.length);
      if (value !== 'pre-generation' && value !== 'post-generation') {
        throw new Error('--phase must be pre-generation or post-generation');
      }
      parsed.phase = value;
      parsed.phaseExplicit = true;
      continue;
    }
    if (arg === '--direct-mcp-error') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--direct-mcp-error requires a value');
      }
      parsed.directMcpError = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--direct-mcp-error=')) {
      parsed.directMcpError = arg.slice('--direct-mcp-error='.length);
      continue;
    }
    if (arg === '--observed-at') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--observed-at requires a value');
      }
      parsed.observedAt = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--observed-at=')) {
      parsed.observedAt = arg.slice('--observed-at='.length);
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--timeout-ms requires a value');
      }
      parsed.timeoutMs = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = arg.slice('--timeout-ms='.length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.explain && parsed.json) {
    throw new Error('--json cannot be combined with --explain');
  }
  if (parsed.applyCleanup && !parsed.cleanupStaleWrappers) {
    throw new Error('--apply-cleanup requires --cleanup-stale-wrappers');
  }
  if (parsed.cleanupStaleWrappers && (parsed.explain || parsed.json || parsed.repairConfig || parsed.strict)) {
    throw new Error('--cleanup-stale-wrappers cannot be combined with --explain, --json, --repair-config, or --strict');
  }
  if (parsed.strict && !parsed.phaseExplicit) parsed.phase = 'post-generation';
  return parsed;
}

function parsePositiveIntegerArg(name, value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return parsed;
}

function parseObservedAtMs(value) {
  if (!value) return Number.NaN;
  if (String(value).toLowerCase() === 'now') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isoFromMs(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function eventTimestampMs(event) {
  const parsed = Date.parse(event?.ts ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isTimestampInsideActiveWindow(tsMs, referenceMs) {
  if (!Number.isFinite(tsMs) || !Number.isFinite(referenceMs)) return false;
  return tsMs <= referenceMs && referenceMs - tsMs <= ACTIVE_WRAPPER_WINDOW_MS;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, value: null, error: null };
  }
  try {
    return {
      exists: true,
      value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      value: null,
      error: error.message,
    };
  }
}

function makeCheck(name, ok, details = {}) {
  return {
    name,
    ok,
    ...details,
  };
}

function inspectPackageScripts(root) {
  const packagePath = path.join(root, 'package.json');
  const parsed = readJsonIfExists(packagePath);
  const checks = [];
  const scripts = parsed.value?.scripts ?? {};

  checks.push(makeCheck('package:file', parsed.exists && !parsed.error, {
    path: relativePath(root, packagePath),
    ...(parsed.error ? { error: parsed.error } : {}),
  }));

  for (const [scriptName, expected] of REQUIRED_PACKAGE_SCRIPTS) {
    const actual = scripts?.[scriptName];
    checks.push(makeCheck(`package-script:${scriptName}`, actual === expected, {
      expected,
      actual: actual ?? null,
    }));
  }

  return checks;
}

function inspectOverlay(root, phase = 'pre-generation') {
  const statePath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
  const docsTransactionPath = path.join(root, '.codegraph', 'codegraph-overlay-doc-sync-transaction');
  const docsPreparingTransactionPath = `${docsTransactionPath}.preparing`;
  const currentReceipt = readOverlayCurrentReceipt(root);
  let stat = null;
  try { stat = fs.statSync(statePath); } catch { /* Reader owns the fixed error classification. */ }
  const ageMs = stat ? Math.max(0, Date.now() - stat.mtimeMs) : null;
  const graphNodes = Array.isArray(currentReceipt.overlay?.graph?.nodes)
    ? currentReceipt.overlay.graph.nodes.length
    : null;
  const graphEdges = Array.isArray(currentReceipt.overlay?.graph?.edges)
    ? currentReceipt.overlay.graph.edges.length
    : null;

  const pendingDocsTransaction = fs.existsSync(docsTransactionPath)
    || fs.existsSync(docsPreparingTransactionPath);
  let freshness = currentReceipt.ok
    ? 'fresh'
    : currentReceipt.errorCode === 'CURRENT_MISSING' ? 'unknown' : 'corrupt';
  let freshnessReason = currentReceipt.ok
    ? null
    : currentReceipt.errorCode === 'CURRENT_MISSING'
      ? 'missing-current-state'
      : `current-receipt-${String(currentReceipt.errorCode).toLowerCase().replaceAll('_', '-')}`;
  if (pendingDocsTransaction) {
    freshness = 'corrupt';
    freshnessReason = 'pending-docs-transaction';
  }
  const freshnessOk = phase === 'post-generation'
    ? freshness === 'fresh'
    : freshness === 'fresh' || freshness === 'unknown';
  const currentStateAllowed = currentReceipt.ok
    || (phase === 'pre-generation' && currentReceipt.errorCode === 'CURRENT_MISSING');
  const stateExists = currentReceipt.ok || currentReceipt.errorCode !== 'CURRENT_MISSING';
  const payloadPath = currentReceipt.ok
    ? path.join(
        root,
        '.codegraph',
        'nanoflow-generations',
        currentReceipt.current.generationId,
        ...currentReceipt.manifest.compatibility.path.split('/'),
      )
    : null;

  const overlay = {
    path: payloadPath ? relativePath(root, payloadPath) : null,
    statePath: relativePath(root, statePath),
    stateExists,
    stateParseError: currentReceipt.ok ? null : currentReceipt.errorCode,
    exists: currentReceipt.ok,
    parseError: currentReceipt.ok ? null : currentReceipt.errorCode,
    mtime: stat ? stat.mtime.toISOString() : null,
    ageMs,
    ageHintOver24h: ageMs !== null ? ageMs > OVERLAY_AGE_HINT_MS : null,
    freshness,
    freshnessReason,
    stale: freshness !== 'fresh',
    generationId: currentReceipt.current?.generationId ?? null,
    sequence: currentReceipt.current?.sequence ?? null,
    pendingDocsTransaction,
    graphNodes,
    graphEdges,
  };
  const checks = [
    makeCheck('overlay:file', currentStateAllowed && !pendingDocsTransaction, overlay),
    makeCheck('overlay:freshness', currentStateAllowed && freshnessOk && !pendingDocsTransaction, {
      phase,
      freshness,
      reason: freshnessReason,
      statePath: overlay.statePath,
      stateExists,
      ageMs,
      ageHintMs: OVERLAY_AGE_HINT_MS,
      ageHintOver24h: overlay.ageHintOver24h,
      stale: overlay.stale,
    }),
  ];

  return { overlay, checks };
}

function inspectLeases(root) {
  const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
  const staleLockPath = `${leasePath}.lock`;
  const parsed = readJsonIfExists(leasePath);
  const now = Date.now();
  const allLeases = parsed.value?.leases && typeof parsed.value.leases === 'object'
    ? parsed.value.leases
    : {};
  const activeEntries = Object.entries(allLeases)
    .filter(([, lease]) => !Number.isFinite(lease?.expiresAtMs) || lease.expiresAtMs > now);
  const expiredEntries = Object.entries(allLeases)
    .filter(([, lease]) => Number.isFinite(lease?.expiresAtMs) && lease.expiresAtMs <= now);
  const owners = [...new Set(activeEntries
    .map(([, lease]) => lease?.owner)
    .filter(owner => typeof owner === 'string' && owner.length > 0))]
    .sort();
  const conflictsByFile = Object.fromEntries(Object.entries(allLeases)
    .filter(([, lease]) => lease?.owner && Number.isFinite(lease?.expiresAtMs) && lease.expiresAtMs > now)
    .map(([file, lease]) => [file, lease.owner]));
  const leases = {
    path: relativePath(root, leasePath),
    exists: parsed.exists,
    parseError: parsed.error,
    activeCount: activeEntries.length,
    expiredCount: expiredEntries.length,
    owners,
    files: activeEntries.map(([file]) => file).sort(),
    conflictOwnersByFile: conflictsByFile,
    staleLock: fs.existsSync(staleLockPath),
  };
  const checks = parsed.error
    ? [makeCheck('lease:file', false, leases)]
    : [makeCheck('lease:file', true, leases)];

  return { leases, checks };
}

function inspectMcpConfig(root) {
  const codexConfig = readCodexCodegraphMcpConfig(root);
  return inspectMcpServerConfig(root, {
    source: 'codex',
    scope: codexConfig.scope,
    configPath: codexConfig.path,
    userConfigPath: codexConfig.userConfigPath,
    projectConfigPath: codexConfig.projectConfigPath,
    candidateConfigs: codexConfig.candidateConfigs,
    exists: codexConfig.exists,
    parseError: codexConfig.parseError,
    appliesToRoot: codexConfig.appliesToRoot,
    serverDeclared: codexConfig.serverDeclared,
    server: codexConfig.server,
  });
}

function inspectMcpServerConfig(root, config) {
  const server = config.server;
  const args = Array.isArray(server?.args) ? server.args : [];
  const env = server?.env && typeof server.env === 'object' ? server.env : {};
  const wrapperScriptPath = args[0] ? replaceWorkspaceFolder(args[0], root) : null;
  const codegraphTarget = args[1] ? replaceWorkspaceFolder(args[1], root) : null;
  const wrapperScriptExists = wrapperScriptPath ? fs.existsSync(wrapperScriptPath) : null;
  const codegraphServerConfigured = Boolean(server);
  const rootContractEnforced = config.scope !== 'override';
  const appliesToRoot = config.appliesToRoot === true;
  const requiredEnv = Object.fromEntries([...REQUIRED_CODEX_MCP_ENV].map(([key, expected]) => {
    const actual = typeof env[key] === 'string' ? env[key] : null;
    return [key, {
      actual,
      expected,
      ok: actual === expected,
    }];
  }));
  const targetContractEnforced = config.scope !== 'override';
  const targetMatchesRequired = targetContractEnforced
    ? codegraphTarget === REQUIRED_CODEGRAPH_TARGET
    : null;
  const configContractMismatches = [
    ...(!rootContractEnforced || !codegraphServerConfigured || appliesToRoot ? [] : [{
      field: 'appliesToRoot',
      expected: true,
      actual: false,
    }]),
    ...(!targetContractEnforced || targetMatchesRequired ? [] : [{
      field: 'codegraphTarget',
      expected: REQUIRED_CODEGRAPH_TARGET,
      actual: codegraphTarget,
    }]),
    ...Object.entries(requiredEnv)
      .filter(([, value]) => !value.ok)
      .map(([key, value]) => ({
        field: `env.${key}`,
        expected: value.expected,
        actual: value.actual,
      })),
  ];
  const mcpConfig = {
    source: config.source,
    scope: config.scope ?? null,
    path: config.source === 'codex' ? config.configPath : relativePath(root, config.configPath),
    userConfigPath: config.userConfigPath ?? null,
    projectConfigPath: config.projectConfigPath ?? null,
    candidateConfigs: Array.isArray(config.candidateConfigs) ? config.candidateConfigs : [],
    exists: config.exists,
    parseError: config.parseError,
    appliesToRoot: config.appliesToRoot ?? null,
    codegraphServerDeclared: config.serverDeclared === true,
    codegraphServerConfigured,
    type: server?.type ?? null,
    command: server?.command ?? null,
    argsCount: args.length,
    wrapperScriptPath: wrapperScriptPath ? relativePath(root, wrapperScriptPath) : null,
    wrapperScriptExists,
    codegraphTarget,
    requiredCodegraphTarget: REQUIRED_CODEGRAPH_TARGET,
    targetContractEnforced,
    targetMatchesRequired,
    codegraphArgs: args.slice(2).map(arg => replaceWorkspaceFolder(arg, root)),
    configuredEnv: env,
    requiredEnv,
    contractMatchesRequired: configContractMismatches.length === 0,
    contractMismatches: configContractMismatches,
    runtimeToolDiscoveryVisible: 'unknown-host-state',
    recommendation: null,
  };

  if (
    config.exists
    && !config.parseError
    && codegraphServerConfigured
    && isNodeCommand(server?.command)
    && wrapperScriptExists
    && codegraphTarget
  ) {
    mcpConfig.recommendation = [
      'If the agent tool registry shows no mcp__codegraph.* tools while this config is valid, treat it as host tool discovery failure.',
      'Restart the MCP host/session; until then, use: npm run codegraph:adapter:context -- --query "<query>" --json',
    ];
  }
  if (configContractMismatches.length > 0) {
    mcpConfig.recommendation = [
      `Update the active ${mcpConfig.scope ?? 'Codex'} config at ${mcpConfig.path} so target/env match the NanoFlow MCP contract.`,
      `Required target: ${REQUIRED_CODEGRAPH_TARGET}; required env: ${JSON.stringify(Object.fromEntries(REQUIRED_CODEX_MCP_ENV))}.`,
      'Restart the Codex MCP host/session after updating the active config; until then use: npm run codegraph:adapter:context -- --query "<query>" --json',
    ];
  }

  const hasConfig = config.exists && !config.parseError;
  const checks = [
    makeCheck('mcp-config:file', config.exists && !config.parseError, {
      exists: config.exists,
      path: mcpConfig.path,
      source: mcpConfig.source,
      ...(config.parseError ? { error: config.parseError } : {}),
    }),
    makeCheck('mcp-config:scope', ['override', 'project', 'user'].includes(config.scope), {
      scope: mcpConfig.scope,
      activePath: mcpConfig.path,
      userConfigPath: mcpConfig.userConfigPath,
      projectConfigPath: mcpConfig.projectConfigPath,
    }),
    makeCheck('mcp-config:codegraph-server', hasConfig && codegraphServerConfigured, {
      configured: codegraphServerConfigured,
    }),
    makeCheck(
      'mcp-config:applies-to-root',
      codegraphServerConfigured && (!rootContractEnforced || appliesToRoot),
      {
        expected: true,
        actual: config.appliesToRoot ?? null,
        enforced: rootContractEnforced,
      },
    ),
    makeCheck('mcp-config:command', codegraphServerConfigured && isNodeCommand(server?.command), {
      command: server?.command ?? null,
      expected: 'node or node.exe path',
    }),
    makeCheck('mcp-config:wrapper-script', codegraphServerConfigured && wrapperScriptExists === true, {
      path: mcpConfig.wrapperScriptPath,
      exists: wrapperScriptExists,
    }),
    makeCheck(
      'mcp-config:codegraph-target',
      codegraphServerConfigured && Boolean(codegraphTarget) && (!targetContractEnforced || targetMatchesRequired),
      {
      expected: REQUIRED_CODEGRAPH_TARGET,
      actual: codegraphTarget,
        enforced: targetContractEnforced,
      },
    ),
    ...Object.entries(requiredEnv).map(([key, value]) => makeCheck(
      `mcp-config:env:${key}`,
      codegraphServerConfigured && value.ok,
      {
        expected: value.expected,
        actual: value.actual,
      },
    )),
  ];

  return { mcpConfig, checks };
}

function inspectTopology(root) {
  const checks = [];
  const packageText = fs.existsSync(path.join(root, 'package.json'))
    ? fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    : '';
  const workflowPath = path.join(root, '.github', 'workflows', 'test-full-suite.yml');
  const workflowText = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';
  const gatePath = path.join(root, 'scripts', 'run-codegraph-adapter-gate.cjs');
  const gateText = fs.existsSync(gatePath) ? fs.readFileSync(gatePath, 'utf8') : '';

  checks.push(makeCheck('topology:workflow', (
    workflowText.includes('codegraph-adapter-gate:')
    && workflowText.includes('npm run codegraph:adapter:gate')
    && workflowText.includes('NANOFLOW_CODEGRAPH_GATE_LOG_DIR')
    && workflowText.includes('runner.temp')
    && workflowText.includes('concurrency:')
    && workflowText.includes('cancel-in-progress: true')
  ), {
    path: relativePath(root, workflowPath),
  }));

  checks.push(makeCheck('topology:infra-tests', [
    'src/tests/scripts/agent-file-lease.spec.ts',
    'src/tests/scripts/codegraph-adapter-preflight.spec.ts',
    'src/tests/scripts/codegraph-overlay-baseline-manifest.spec.ts',
  ].every(testPath => packageText.includes(testPath) && gateText.includes(testPath)), {
    requiredTests: [
      'agent-file-lease',
      'codegraph-adapter-preflight',
      'codegraph-overlay-baseline-manifest',
    ],
  }));

  checks.push(makeCheck('topology:quick-gate', (
    packageText.includes('codegraph:adapter:quick-gate')
    && gateText.includes('codegraph:adapter:doctor:post-generation:strict')
    && gateText.includes('scripts/codegraph-adapter-doctor.cjs')
    && gateText.includes('--strict')
    && gateText.includes('quick')
    && gateText.includes('--profile')
    && gateText.includes('codegraph:adapter:preflight')
  )));

  checks.push(makeCheck('topology:strict-log-guard', (
    gateText.includes('--fail-on-stale-current-wrapper')
    && gateText.includes('--fail-on-untrusted-direct-mcp')
    && gateText.includes('codegraph-adapter-gate-mcp-wrapper.log')
  )));

  return checks;
}

function inspectHostMcp(root, mcpConfig = {}, liveProcesses = null, options = {}) {
  const configuredEnv = mcpConfig.configuredEnv ?? {};
  const expectedCodegraphTarget = typeof mcpConfig.codegraphTarget === 'string'
    ? mcpConfig.codegraphTarget
    : null;
  const observedDirectMcpError = normalizeOptionalText(
    options.directMcpError ?? process.env.NANOFLOW_CODEGRAPH_DIRECT_MCP_ERROR,
  );
  const observedAtMs = parseObservedAtMs(
    options.observedAt ?? (observedDirectMcpError ? 'now' : null),
  );
  const observedAt = isoFromMs(observedAtMs);
  const logPath = path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log');
  const wrapperScriptPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
  const diskScriptSha256 = hashFileIfExists(wrapperScriptPath);
  const hostMcp = {
    logPath: relativePath(root, logPath),
    logExists: fs.existsSync(logPath),
    logReadError: null,
    logMalformedLines: 0,
    latestMalformedLogLine: null,
    wrapperScriptPath: relativePath(root, wrapperScriptPath),
    diskScriptSha256,
    currentWrapper: null,
    currentConfiguredWrapper: null,
    currentContextWrapper: null,
    currentConfiguredContextWrapper: null,
    currentContextWrapperLatestTs: null,
    currentContextWrapperLatestRequestId: null,
    currentWrapperMatchesDisk: null,
    currentContextWrapperMatchesDisk: null,
    currentContextWrapperRawMatchesDisk: null,
    currentContextWrapperSupersededByFreshWrapper: false,
    currentContextWrapperScriptSupersededByFreshWrapper: false,
    currentContextWrapperConfigSupersededByFreshWrapper: false,
    currentContextWrapperSupersededReason: null,
    currentWrapperEnvMatchesConfig: null,
    currentContextWrapperEnvMatchesConfig: null,
    currentWrapperEnv: null,
    currentContextWrapperEnv: null,
    currentContextWrapperRawEnv: null,
    currentWrapperTarget: null,
    currentContextWrapperTarget: null,
    currentContextWrapperRawTarget: null,
    currentWrapperTargetMatchesConfig: null,
    currentContextWrapperTargetMatchesConfig: null,
    currentWrapperRuntimeTopology: null,
    currentContextWrapperRuntimeTopology: null,
    activeDirectWatcherRuns: [],
    activeSharedDaemonFallbackRuns: [],
    activeInProcessFallbackWatcherRuns: [],
    codegraphAutoSyncDisabled: createCodegraphAutoSyncDisabledSummary(),
    currentCodegraphAutoSyncDisabled: createCodegraphAutoSyncDisabledSummary(),
    activeCodegraphAutoSyncDisabled: createCodegraphAutoSyncDisabledSummary(),
    activeCodegraphAutoSyncDisabledRuns: [],
    staleWrapperCleanup: {
      observedAt: null,
      minIdleMs: options.cleanupMinIdleMs ?? STALE_WRAPPER_CLEANUP_MIN_IDLE_MS,
      candidates: [],
      skipped: [],
    },
    observedDirectMcpError,
    observedDirectMcpFailureClass: classifyObservedDirectMcpError(observedDirectMcpError),
    scriptStaleAgainstDisk: false,
    hostConfigMismatch: false,
    staleAgainstDisk: false,
    rootCauseSummary: null,
    liveWrapperLogFilter: {
      applied: false,
      liveWrapperPids: [],
      liveWrapperProcesses: [],
      processStartClockSkewMs: LIVE_PROCESS_START_CLOCK_SKEW_MS,
      ignoredWrapperStarts: 0,
      ignoredContextResponses: 0,
      ignoredPidReuseWrapperStarts: 0,
      ignoredPidReuseContextResponses: 0,
    },
    currentEvidenceWindow: {
      applied: Number.isFinite(observedAtMs),
      observedAt,
      activeWindowMs: ACTIVE_WRAPPER_WINDOW_MS,
      ignoredWrapperStarts: 0,
      ignoredContextResponses: 0,
    },
    logEvidence: {
      observedAt,
      latestTs: null,
      latestEvent: null,
      latestRunId: null,
      latestWrapperStartTs: null,
      latestWrapperStartRunId: null,
      latestLogAgeMs: null,
      activeWindowMs: ACTIVE_WRAPPER_WINDOW_MS,
      staleAgainstObservedAt: false,
      hasCurrentWrapperEvidence: false,
      parsedEventCount: 0,
      noCurrentWrapperEvidence: Boolean(observedDirectMcpError),
      liveWrapperLogFilter: null,
      currentEvidenceWindow: null,
    },
    recommendation: null,
  };

  if (hostMcp.observedDirectMcpFailureClass) {
    hostMcp.recommendation = [
      'Direct CodeGraph MCP returned an error before fresh wrapper evidence was written; treat the connected Codex MCP host/session as closed.',
      `Restart the Codex MCP host/session so direct MCP reloads the active config at ${mcpConfig.path ?? 'the doctor-reported Codex config path'} and reconnects to the current wrapper.`,
      'Until then, use: npm run codegraph:adapter:context -- --query "<query>" --json',
    ];
  }

  if (!hostMcp.logExists) {
    hostMcp.rootCauseSummary = buildHostMcpRootCauseSummary(hostMcp, mcpConfig, liveProcesses);
    return {
      hostMcp,
      checks: [
        makeCheck('host-mcp:log', true, { exists: false }),
        makeCheck('host-mcp:observed-direct-mcp-error', !hostMcp.observedDirectMcpFailureClass, {
          error: hostMcp.observedDirectMcpError,
          failureClass: hostMcp.observedDirectMcpFailureClass,
          investigation: observedDirectMcpErrorInvestigation(hostMcp.observedDirectMcpFailureClass),
        }),
      ],
    };
  }

  const startsByRunId = new Map();
  const cleanupStartsByRunId = new Map();
  const runtimeTopologyByRunId = new Map();
  const autoSyncDisabledByRunId = new Map();
  const cleanupLatestEntryByRunId = new Map();
  let currentWrapper = null;
  let currentContextWrapper = null;
  let currentConfiguredWrapper = null;
  let currentConfiguredContextWrapper = null;
  const logEntries = readJsonLines(logPath);
  hostMcp.logReadError = logEntries.readError;
  const liveWrapperProcesses = liveWrapperProcessIdentities(liveProcesses);
  const latestLogEntry = selectLatestLogEntry(logEntries.entries);
  const latestWrapperStartEntry = selectLatestLogEntry(
    logEntries.entries.filter(entry => entry?.event === 'wrapper.start'),
  );
  const latestLogMs = eventTimestampMs(latestLogEntry);
  hostMcp.liveWrapperLogFilter = {
    applied: liveWrapperProcesses !== null,
    liveWrapperPids: liveWrapperProcesses
      ? [...liveWrapperProcesses.keys()].sort((left, right) => left - right)
      : [],
    liveWrapperProcesses: liveWrapperProcesses
      ? [...liveWrapperProcesses.values()]
          .sort((left, right) => left.pid - right.pid)
          .map(processInfo => ({
            pid: processInfo.pid,
            startedAt: processInfo.startedAt,
          }))
      : [],
    processStartClockSkewMs: LIVE_PROCESS_START_CLOCK_SKEW_MS,
    ignoredWrapperStarts: 0,
    ignoredContextResponses: 0,
    ignoredPidReuseWrapperStarts: 0,
    ignoredPidReuseContextResponses: 0,
  };
  hostMcp.currentEvidenceWindow = {
    applied: Number.isFinite(observedAtMs),
    observedAt,
    activeWindowMs: ACTIVE_WRAPPER_WINDOW_MS,
    ignoredWrapperStarts: 0,
    ignoredContextResponses: 0,
  };
  hostMcp.logEvidence = {
    observedAt,
    latestTs: latestLogEntry?.ts ?? null,
    latestEvent: latestLogEntry?.event ?? null,
    latestRunId: latestLogEntry?.runId ?? null,
    latestWrapperStartTs: latestWrapperStartEntry?.ts ?? null,
    latestWrapperStartRunId: latestWrapperStartEntry?.runId ?? null,
    latestLogAgeMs: Number.isFinite(observedAtMs) && Number.isFinite(latestLogMs)
      ? Math.max(0, observedAtMs - latestLogMs)
      : null,
    activeWindowMs: ACTIVE_WRAPPER_WINDOW_MS,
    staleAgainstObservedAt: Number.isFinite(observedAtMs)
      && !isTimestampInsideActiveWindow(latestLogMs, observedAtMs),
    hasCurrentWrapperEvidence: false,
    parsedEventCount: logEntries.entries.length,
    noCurrentWrapperEvidence: false,
    liveWrapperLogFilter: hostMcp.liveWrapperLogFilter,
    currentEvidenceWindow: hostMcp.currentEvidenceWindow,
  };
  hostMcp.logMalformedLines = logEntries.malformedLines;
  hostMcp.latestMalformedLogLine = logEntries.latestMalformedLine;
  let currentContextWrapperLatestTs = null;
  let currentContextWrapperLatestRequestId = null;
  for (const entry of logEntries.entries) {
    if (entry?.runId) {
      const liveMatch = wrapperLogEntryMatchesLiveWrapper(entry, liveWrapperProcesses);
      if (liveMatch.matches) {
        const runId = String(entry.runId);
        const previous = cleanupLatestEntryByRunId.get(runId);
        if (!previous || eventTimestampMs(entry) >= eventTimestampMs(previous)) {
          cleanupLatestEntryByRunId.set(runId, entry);
        }
      }
    }
    if (entry?.event === 'wrapper.start') {
      const liveMatch = wrapperLogEntryMatchesLiveWrapper(entry, liveWrapperProcesses);
      if (!liveMatch.matches) {
        hostMcp.liveWrapperLogFilter.ignoredWrapperStarts++;
        if (liveMatch.pidReused) {
          hostMcp.liveWrapperLogFilter.ignoredPidReuseWrapperStarts++;
        }
        continue;
      }
      cleanupStartsByRunId.set(String(entry.runId ?? ''), pickWrapperStart(entry));
      if (!wrapperLogEntryIsCurrentEvidence(entry, observedAtMs)) {
        hostMcp.currentEvidenceWindow.ignoredWrapperStarts++;
        continue;
      }
      const start = pickWrapperStart(entry);
      startsByRunId.set(String(entry.runId ?? ''), start);
      runtimeTopologyByRunId.set(String(entry.runId ?? ''), start.runtimeTopology);
      currentWrapper = start;
      if (wrapperStartMatchesCurrentConfig(start, diskScriptSha256, configuredEnv, expectedCodegraphTarget)) {
        currentConfiguredWrapper = start;
      }
      continue;
    }
    if (entry?.runId) {
      const runId = String(entry.runId);
      const start = startsByRunId.get(runId);
      const runtimeTopology = runtimeTopologyFromDoctorLogEntry(
        entry,
        runtimeTopologyByRunId.get(runId),
        start?.effectiveChildEnv,
      );
      if (runtimeTopology) {
        runtimeTopologyByRunId.set(runId, runtimeTopology);
        if (start) {
          start.runtimeTopology = runtimeTopology;
        }
      }
    }
    if (entry?.event === 'nanoflow.context.response') {
      const liveMatch = wrapperLogEntryMatchesLiveWrapper(entry, liveWrapperProcesses);
      if (!liveMatch.matches) {
        hostMcp.liveWrapperLogFilter.ignoredContextResponses++;
        if (liveMatch.pidReused) {
          hostMcp.liveWrapperLogFilter.ignoredPidReuseContextResponses++;
        }
        continue;
      }
      if (!wrapperLogEntryIsCurrentEvidence(entry, observedAtMs)) {
        hostMcp.currentEvidenceWindow.ignoredContextResponses++;
        continue;
      }
      const contextWrapper = pickWrapperStart(entry.wrapperStart)
        ?? startsByRunId.get(String(entry.runId ?? ''))
        ?? currentContextWrapper;
      currentContextWrapper = contextWrapper;
      if (wrapperStartMatchesCurrentConfig(contextWrapper, diskScriptSha256, configuredEnv, expectedCodegraphTarget)) {
        currentConfiguredContextWrapper = contextWrapper;
      }
      currentContextWrapperLatestTs = entry.ts ?? currentContextWrapperLatestTs;
      currentContextWrapperLatestRequestId = entry.requestId ?? currentContextWrapperLatestRequestId;
    }
    if (isCodegraphAutoSyncDisabledLogEntry(entry)) {
      recordCodegraphAutoSyncDisabled(hostMcp.codegraphAutoSyncDisabled, entry);
      const runId = String(entry.runId ?? '');
      if (runId) {
        if (!autoSyncDisabledByRunId.has(runId)) {
          autoSyncDisabledByRunId.set(runId, createCodegraphAutoSyncDisabledSummary());
        }
        recordCodegraphAutoSyncDisabled(autoSyncDisabledByRunId.get(runId), entry);
      }
    }
  }

  hostMcp.staleWrapperCleanup = buildStaleWrapperCleanupPlan({
    startsByRunId: cleanupStartsByRunId,
    latestEntryByRunId: cleanupLatestEntryByRunId,
    autoSyncDisabledByRunId,
    liveProcesses,
    diskScriptSha256,
    configuredEnv,
    expectedCodegraphTarget,
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : Date.now(),
    minIdleMs: options.cleanupMinIdleMs ?? STALE_WRAPPER_CLEANUP_MIN_IDLE_MS,
  });

  hostMcp.currentWrapper = currentWrapper;
  hostMcp.currentConfiguredWrapper = currentConfiguredWrapper;
  hostMcp.currentContextWrapper = currentContextWrapper;
  hostMcp.currentConfiguredContextWrapper = currentConfiguredContextWrapper;
  hostMcp.logEvidence.noCurrentWrapperEvidence = !currentWrapper && !currentContextWrapper;
  hostMcp.logEvidence.hasCurrentWrapperEvidence = Boolean(currentWrapper || currentContextWrapper);
  hostMcp.logEvidence.liveWrapperLogFilter = hostMcp.liveWrapperLogFilter;
  hostMcp.logEvidence.currentEvidenceWindow = hostMcp.currentEvidenceWindow;
  hostMcp.currentContextWrapperLatestTs = currentContextWrapperLatestTs;
  hostMcp.currentContextWrapperLatestRequestId = currentContextWrapperLatestRequestId;
  hostMcp.currentWrapperMatchesDisk = wrapperStartMatchesDisk(currentWrapper, diskScriptSha256);
  hostMcp.currentContextWrapperRawMatchesDisk = currentContextWrapper
    ? wrapperStartMatchesDisk(currentContextWrapper, diskScriptSha256)
    : null;
  const currentContextFreshnessBoundary = currentContextWrapperLatestTs
    ? { ts: currentContextWrapperLatestTs }
    : currentContextWrapper;
  hostMcp.currentWrapperEnv = compareWrapperStartEnv(currentWrapper, configuredEnv);
  hostMcp.currentContextWrapperRawEnv = compareWrapperStartEnv(currentContextWrapper, configuredEnv);
  hostMcp.currentWrapperTarget = compareWrapperStartTarget(currentWrapper, expectedCodegraphTarget);
  hostMcp.currentContextWrapperRawTarget = compareWrapperStartTarget(
    currentContextWrapper,
    expectedCodegraphTarget,
  );
  hostMcp.currentContextWrapperScriptSupersededByFreshWrapper =
    hostMcp.currentContextWrapperRawMatchesDisk === false
    && hostMcp.currentWrapperMatchesDisk === true
    && wrapperStartIsAfter(currentWrapper, currentContextFreshnessBoundary);
  hostMcp.currentContextWrapperConfigSupersededByFreshWrapper = Boolean(
    currentConfiguredWrapper
    && (
      hostMcp.currentContextWrapperRawEnv.matches === false
      || hostMcp.currentContextWrapperRawTarget.matches === false
    )
    && wrapperStartIsAfter(currentConfiguredWrapper, currentContextFreshnessBoundary),
  );
  hostMcp.currentContextWrapperSupersededByFreshWrapper =
    hostMcp.currentContextWrapperScriptSupersededByFreshWrapper
    || hostMcp.currentContextWrapperConfigSupersededByFreshWrapper;
  hostMcp.currentContextWrapperSupersededReason =
    hostMcp.currentContextWrapperScriptSupersededByFreshWrapper
    && hostMcp.currentContextWrapperConfigSupersededByFreshWrapper
      ? 'script-and-config'
      : hostMcp.currentContextWrapperScriptSupersededByFreshWrapper
        ? 'script'
        : hostMcp.currentContextWrapperConfigSupersededByFreshWrapper
          ? 'config'
          : null;
  hostMcp.currentContextWrapperMatchesDisk = hostMcp.currentContextWrapperScriptSupersededByFreshWrapper
    ? null
    : hostMcp.currentContextWrapperRawMatchesDisk;
  hostMcp.currentContextWrapperEnv = hostMcp.currentContextWrapperSupersededByFreshWrapper
    ? { matches: null, expected: hostMcp.currentWrapperEnv.expected, actual: null }
    : hostMcp.currentContextWrapperRawEnv;
  hostMcp.currentWrapperEnvMatchesConfig = hostMcp.currentWrapperEnv.matches;
  hostMcp.currentContextWrapperEnvMatchesConfig = hostMcp.currentContextWrapperEnv.matches;
  hostMcp.currentContextWrapperTarget = hostMcp.currentContextWrapperSupersededByFreshWrapper
    ? { matches: null, expected: expectedCodegraphTarget, actual: null }
    : hostMcp.currentContextWrapperRawTarget;
  hostMcp.currentWrapperTargetMatchesConfig = hostMcp.currentWrapperTarget.matches;
  hostMcp.currentContextWrapperTargetMatchesConfig = hostMcp.currentContextWrapperTarget.matches;
  hostMcp.currentWrapperRuntimeTopology = currentWrapper?.runtimeTopology ?? null;
  hostMcp.currentContextWrapperRuntimeTopology = hostMcp.currentContextWrapperSupersededByFreshWrapper
    ? null
    : currentContextWrapper?.runtimeTopology ?? null;
  hostMcp.scriptStaleAgainstDisk = hostMcp.currentWrapperMatchesDisk === false
    || hostMcp.currentContextWrapperMatchesDisk === false;
  hostMcp.currentCodegraphAutoSyncDisabled = currentWrapper?.runId
    ? autoSyncDisabledByRunId.get(String(currentWrapper.runId)) ?? createCodegraphAutoSyncDisabledSummary()
    : createCodegraphAutoSyncDisabledSummary();
  for (const [runId, runSummary] of autoSyncDisabledByRunId.entries()) {
    const start = startsByRunId.get(String(runId));
    if (!start || Number(runSummary.count ?? 0) <= 0) continue;
    mergeCodegraphAutoSyncDisabledSummary(hostMcp.activeCodegraphAutoSyncDisabled, runSummary);
    hostMcp.activeCodegraphAutoSyncDisabledRuns.push({
      runId,
      pid: start.wrapperPid ?? start.pid ?? null,
      codegraphTarget: start.codegraphTarget ?? null,
      count: runSummary.count,
      latest: runSummary.latest,
    });
  }
  hostMcp.activeDirectWatcherRuns = [...startsByRunId.values()]
    .filter(start => (
      start.runtimeTopology?.mode === 'direct-session'
      && start.runtimeTopology?.watchDisabled === false
    ))
    .map(start => ({
      runId: start.runId,
      pid: start.wrapperPid ?? start.pid ?? null,
      mode: start.runtimeTopology.mode,
      watcherOwnership: start.runtimeTopology.watcherOwnership,
      fileLockContentionRisk: start.runtimeTopology.fileLockContentionRisk,
      effectiveChildEnv: start.effectiveChildEnv,
    }));
  hostMcp.activeSharedDaemonFallbackRuns = [...startsByRunId.values()]
    .filter(start => String(start.runtimeTopology?.mode ?? '').startsWith('in-process-fallback'))
    .map(compactFallbackRuntimeStart);
  hostMcp.activeInProcessFallbackWatcherRuns = hostMcp.activeSharedDaemonFallbackRuns
    .filter(start => start.mode === 'in-process-fallback-watcher');
  hostMcp.hostConfigMismatch = hostMcp.currentWrapperEnvMatchesConfig === false
    || hostMcp.currentContextWrapperEnvMatchesConfig === false
    || hostMcp.currentWrapperTargetMatchesConfig === false
    || hostMcp.currentContextWrapperTargetMatchesConfig === false;
  hostMcp.staleAgainstDisk = hostMcp.scriptStaleAgainstDisk;
  if (
    hostMcp.scriptStaleAgainstDisk
    || hostMcp.hostConfigMismatch
    || hostMcp.logReadError
    || hostMcp.logMalformedLines > 0
  ) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      'Restart the MCP host/session so codegraph reconnects to the current wrapper script and Codex MCP configuration.',
      'Until then, use: npm run codegraph:adapter:context -- --query "<query>" --json',
    ];
  }
  if (hostMcp.observedDirectMcpFailureClass && hostMcp.logEvidence.noCurrentWrapperEvidence) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      'No current wrapper log evidence was found for the observed direct MCP error; inspect hostMcp.logEvidence before blaming the adapter or stale historical wrapper entries.',
    ];
  }
  if (hostMcp.currentCodegraphAutoSyncDisabled.count > 0) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      'Current CodeGraph auto-sync is disabled and the index may be frozen; inspect hostMcp.currentCodegraphAutoSyncDisabled.latest.textTail, release the file lock, run codegraph sync, then retry the MCP query before judging adapter quality.',
    ];
  } else if (hostMcp.activeCodegraphAutoSyncDisabled.count > 0) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      'A live CodeGraph MCP wrapper returned auto-sync disabled while another wrapper may look current; inspect hostMcp.activeCodegraphAutoSyncDisabledRuns, release the file lock, run codegraph sync, and restart the MCP host before trusting direct MCP.',
    ];
  }
  if (hostMcp.activeDirectWatcherRuns.length > 0) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      'Live direct-session wrappers still own per-wrapper CodeGraph watchers; restart those MCP sessions so they reconnect through the official shared daemon before file-lock contention disables auto-sync.',
    ];
  }
  if (hostMcp.activeInProcessFallbackWatcherRuns.length > 0) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      'Live shared-daemon proxies have fallen back to per-wrapper in-process watchers; recycle those base children before SQLite writer contention disables auto-sync.',
    ];
  } else if (hostMcp.activeSharedDaemonFallbackRuns.length > 0) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      'Live shared-daemon proxies are serving through in-process fallback engines; recycle those base children so they reconnect before fallback watchers start.',
    ];
  }
  hostMcp.rootCauseSummary = buildHostMcpRootCauseSummary(hostMcp, mcpConfig, liveProcesses);

  return {
    hostMcp,
    checks: [
      makeCheck('host-mcp:log-read', !hostMcp.logReadError, {
        error: hostMcp.logReadError,
        investigation: {
          failureBoundary: 'codegraph-mcp-diagnostic-log',
          failureClass: 'host-mcp-log-read-failed',
          likelyRootCause: 'The wrapper diagnostic log path exists but could not be read, so current MCP root-cause evidence is incomplete.',
          nextEvidence: [
            'hostMcp.logPath',
            'hostMcp.logReadError.code',
            'hostMcp.logReadError.message',
            'filesystem type and permissions for the log path',
            'fresh adapter fallback logPath',
          ],
        },
      }),
      makeCheck('host-mcp:log-parse', hostMcp.logMalformedLines === 0, {
        malformedLines: hostMcp.logMalformedLines,
        latestMalformedLogLine: hostMcp.latestMalformedLogLine,
      }),
      makeCheck('host-mcp:current-wrapper', hostMcp.currentWrapperMatchesDisk !== false, {
        matchesDisk: hostMcp.currentWrapperMatchesDisk,
      }),
      makeCheck('host-mcp:current-context-wrapper', hostMcp.currentContextWrapperMatchesDisk !== false, {
        matchesDisk: hostMcp.currentContextWrapperMatchesDisk,
        rawMatchesDisk: hostMcp.currentContextWrapperRawMatchesDisk,
        supersededByFreshWrapper: hostMcp.currentContextWrapperSupersededByFreshWrapper,
        supersededReason: hostMcp.currentContextWrapperSupersededReason,
      }),
      makeCheck('host-mcp:current-wrapper-env', hostMcp.currentWrapperEnvMatchesConfig !== false, {
        expected: hostMcp.currentWrapperEnv.expected,
        actual: hostMcp.currentWrapperEnv.actual,
        investigation: hostConfigMismatchInvestigation('mcp-host-env'),
      }),
      makeCheck('host-mcp:current-context-wrapper-env', hostMcp.currentContextWrapperEnvMatchesConfig !== false, {
        expected: hostMcp.currentContextWrapperEnv.expected,
        actual: hostMcp.currentContextWrapperEnv.actual,
        raw: hostMcp.currentContextWrapperRawEnv,
        supersededByFreshWrapper: hostMcp.currentContextWrapperConfigSupersededByFreshWrapper,
        investigation: hostConfigMismatchInvestigation('mcp-host-env'),
      }),
      makeCheck('host-mcp:current-wrapper-target', hostMcp.currentWrapperTargetMatchesConfig !== false, {
        expected: hostMcp.currentWrapperTarget.expected,
        actual: hostMcp.currentWrapperTarget.actual,
        investigation: hostConfigMismatchInvestigation('mcp-host-codegraph-target'),
      }),
      makeCheck('host-mcp:current-context-wrapper-target', hostMcp.currentContextWrapperTargetMatchesConfig !== false, {
        expected: hostMcp.currentContextWrapperTarget.expected,
        actual: hostMcp.currentContextWrapperTarget.actual,
        raw: hostMcp.currentContextWrapperRawTarget,
        supersededByFreshWrapper: hostMcp.currentContextWrapperConfigSupersededByFreshWrapper,
        investigation: hostConfigMismatchInvestigation('mcp-host-codegraph-target'),
      }),
      makeCheck('host-mcp:current-autosync-disabled', hostMcp.currentCodegraphAutoSyncDisabled.count === 0, {
        count: hostMcp.currentCodegraphAutoSyncDisabled.count,
        latest: hostMcp.currentCodegraphAutoSyncDisabled.latest,
        investigation: codegraphAutoSyncDisabledInvestigation(),
      }),
      makeCheck('host-mcp:active-autosync-disabled', hostMcp.activeCodegraphAutoSyncDisabled.count === 0, {
        count: hostMcp.activeCodegraphAutoSyncDisabled.count,
        latest: hostMcp.activeCodegraphAutoSyncDisabled.latest,
        runs: hostMcp.activeCodegraphAutoSyncDisabledRuns,
        investigation: codegraphAutoSyncDisabledInvestigation('active-live-wrapper'),
      }),
      makeCheck('host-mcp:active-direct-watchers', hostMcp.activeDirectWatcherRuns.length === 0, {
        count: hostMcp.activeDirectWatcherRuns.length,
        runs: hostMcp.activeDirectWatcherRuns,
        investigation: directWatcherContentionInvestigation(),
      }),
      makeCheck(
        'host-mcp:active-shared-daemon-fallbacks',
        hostMcp.activeSharedDaemonFallbackRuns
          .filter(run => run.mode !== 'in-process-fallback-watcher').length === 0,
        {
          count: hostMcp.activeSharedDaemonFallbackRuns
            .filter(run => run.mode !== 'in-process-fallback-watcher').length,
          runs: hostMcp.activeSharedDaemonFallbackRuns
            .filter(run => run.mode !== 'in-process-fallback-watcher'),
          investigation: sharedDaemonFallbackInvestigation('active-shared-daemon-fallback'),
        },
      ),
      makeCheck(
        'host-mcp:active-in-process-fallback-watchers',
        hostMcp.activeInProcessFallbackWatcherRuns.length === 0,
        {
          count: hostMcp.activeInProcessFallbackWatcherRuns.length,
          runs: hostMcp.activeInProcessFallbackWatcherRuns,
          investigation: sharedDaemonFallbackInvestigation('active-in-process-fallback-watcher'),
        },
      ),
      makeCheck('host-mcp:observed-direct-mcp-error', !hostMcp.observedDirectMcpFailureClass, {
        error: hostMcp.observedDirectMcpError,
        failureClass: hostMcp.observedDirectMcpFailureClass,
        investigation: observedDirectMcpErrorInvestigation(hostMcp.observedDirectMcpFailureClass),
      }),
    ],
  };
}

function inspectLiveMcpProcesses(root, mcpConfig) {
  const expectedWrapperPath = mcpConfig.wrapperScriptPath
    ? path.resolve(root, mcpConfig.wrapperScriptPath)
    : path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
  const expectedCommand = typeof mcpConfig.command === 'string' ? mcpConfig.command : null;
  const expectedCodegraphTarget = typeof mcpConfig.codegraphTarget === 'string'
    ? mcpConfig.codegraphTarget
    : null;
  const processList = readLiveProcessList();
  const liveProcesses = {
    checked: true,
    available: processList.available,
    source: processList.source,
    error: processList.error,
    expectedWrapperPath,
    expectedCommand,
    expectedCodegraphTarget,
    totalProcessCount: processList.processes.length,
    wrapperProcessCount: 0,
    matchingWrapperCount: 0,
    auxiliaryProcessCount: 0,
    hostParentPids: [],
    commandMismatchCount: 0,
    targetMismatchCount: 0,
    mismatchedProcesses: [],
    auxiliaryProcesses: [],
    processes: [],
    recommendation: null,
  };

  if (!processList.available) {
    return {
      liveProcesses,
      checks: [
        makeCheck('host-mcp:live-process-config', true, {
          available: false,
          error: processList.error,
        }),
      ],
    };
  }

  const requireExactCommandMatch = shouldMatchExactCommand(expectedCommand);
  const wrapperProcesses = [];
  for (const processInfo of processList.processes) {
    const commandLine = String(processInfo.commandLine ?? '');
    if (!commandLineLooksLikeWrapperProcess(commandLine, expectedWrapperPath)) {
      continue;
    }

    const commandMatches = !requireExactCommandMatch
      || commandLineContainsPath(commandLine, expectedCommand);
    const targetMatches = !expectedCodegraphTarget
      || commandLineContainsPath(commandLine, expectedCodegraphTarget);
    const liveProcess = {
      pid: processInfo.pid ?? null,
      parentPid: processInfo.parentPid ?? null,
      parentName: processInfo.parentName ?? null,
      parentCommandLine: processInfo.parentCommandLine ?? null,
      parentClassification: classifyWrapperParentProcess(processInfo),
      startedAt: processInfo.startedAt ?? null,
      commandLine,
      observedCodegraphTarget: extractCodegraphTargetFromCommandLine(commandLine, expectedWrapperPath),
      commandMatches,
      targetMatches,
    };
    wrapperProcesses.push(liveProcess);
  }

  liveProcesses.wrapperProcessCount = wrapperProcesses.length;
  liveProcesses.auxiliaryProcesses = wrapperProcesses
    .filter(processInfo => processInfo.parentClassification === 'auxiliary-non-codex')
    .map(processInfo => ({
      pid: processInfo.pid,
      parentPid: processInfo.parentPid,
      parentName: processInfo.parentName,
      parentCommandLine: processInfo.parentCommandLine,
      observedCodegraphTarget: processInfo.observedCodegraphTarget,
      commandMatches: processInfo.commandMatches,
      targetMatches: processInfo.targetMatches,
      commandLine: processInfo.commandLine,
      classificationReason: 'wrapper-parent-is-not-codex-host',
    }));
  liveProcesses.auxiliaryProcessCount = liveProcesses.auxiliaryProcesses.length;
  liveProcesses.processes = wrapperProcesses
    .filter(processInfo => processInfo.parentClassification !== 'auxiliary-non-codex');
  liveProcesses.hostParentPids = [...new Set(liveProcesses.processes
    .filter(processInfo => processInfo.parentClassification === 'codex-host')
    .map(processInfo => Number(processInfo.parentPid))
    .filter(parentPid => Number.isFinite(parentPid)))]
    .sort((left, right) => left - right);
  liveProcesses.matchingWrapperCount = liveProcesses.processes.length;
  liveProcesses.commandMismatchCount = liveProcesses.processes
    .filter(processInfo => processInfo.commandMatches === false).length;
  liveProcesses.targetMismatchCount = liveProcesses.processes
    .filter(processInfo => processInfo.targetMatches === false).length;
  liveProcesses.mismatchedProcesses = summarizeLiveProcessMismatches(liveProcesses.processes, 20);

  const ok = liveProcesses.commandMismatchCount === 0 && liveProcesses.targetMismatchCount === 0;
  if (!ok) {
    liveProcesses.recommendation = [
      'Live CodeGraph MCP wrapper processes do not match the current Codex MCP config.',
      'Restart the Codex app-server/MCP host so new direct MCP calls use the configured wrapper command and CodeGraph target.',
      'Until then, use: npm run codegraph:adapter:context -- --query "<query>" --json',
    ];
  }

  return {
    liveProcesses,
    checks: [
      makeCheck('host-mcp:live-process-config', ok, {
        expected: {
          command: expectedCommand,
          codegraphTarget: expectedCodegraphTarget,
        },
        actual: liveProcesses.processes
          .filter(processInfo => processInfo.commandMatches === false || processInfo.targetMatches === false)
          .slice(0, 3)
          .map(processInfo => ({
            pid: processInfo.pid,
            commandLine: processInfo.commandLine,
          })),
        expectedWrapperPath,
        expectedCommand,
        expectedCodegraphTarget,
        matchingWrapperCount: liveProcesses.matchingWrapperCount,
        wrapperProcessCount: liveProcesses.wrapperProcessCount,
        auxiliaryProcessCount: liveProcesses.auxiliaryProcessCount,
        auxiliaryProcesses: liveProcesses.auxiliaryProcesses.slice(0, 3),
        hostParentPids: liveProcesses.hostParentPids,
        commandMismatchCount: liveProcesses.commandMismatchCount,
        targetMismatchCount: liveProcesses.targetMismatchCount,
        mismatchedProcesses: liveProcesses.mismatchedProcesses.slice(0, 5),
        investigation: hostConfigMismatchInvestigation('live-process-config'),
      }),
    ],
  };
}

function summarizeLiveProcessMismatches(processes, limit = 5) {
  return (processes ?? [])
    .filter(processInfo => processInfo.commandMatches === false || processInfo.targetMatches === false)
    .slice(0, limit)
    .map(processInfo => ({
      pid: processInfo.pid,
      parentPid: processInfo.parentPid,
      observedCodegraphTarget: processInfo.observedCodegraphTarget,
      commandMatches: processInfo.commandMatches,
      targetMatches: processInfo.targetMatches,
      commandLineTail: textTail(processInfo.commandLine, 500),
    }));
}

function buildHostMcpRootCauseSummary(hostMcp, mcpConfig = {}, liveProcesses = null) {
  const failureClasses = [];
  const addFailureClass = failureClass => {
    if (failureClass && !failureClasses.includes(failureClass)) {
      failureClasses.push(failureClass);
    }
  };

  const observedDirectMcpError = normalizeOptionalText(hostMcp.observedDirectMcpError);
  const observedDirectMcpFailureClass = classifyObservedDirectMcpError(observedDirectMcpError);
  if (observedDirectMcpFailureClass) {
    addFailureClass(observedDirectMcpFailureClass);
    if (liveProcesses?.available === true && liveProcesses.matchingWrapperCount === 0) {
      addFailureClass('direct-mcp-no-live-wrapper-process');
    }
  }
  if (mcpConfig.contractMatchesRequired === false) {
    addFailureClass('codex-mcp-config-contract-mismatch');
    if (mcpConfig.targetContractEnforced !== false && mcpConfig.targetMatchesRequired === false) {
      addFailureClass('codex-mcp-config-target-outdated');
    }
    if (Object.values(mcpConfig.requiredEnv ?? {}).some(value => value?.ok === false)) {
      addFailureClass('codex-mcp-config-required-env-mismatch');
    }
  }
  if (hostMcp.logReadError) addFailureClass('host-mcp-log-read-failed');
  if (hostMcp.logMalformedLines > 0) addFailureClass('host-mcp-log-malformed');
  if (hostMcp.scriptStaleAgainstDisk) addFailureClass('mcp-host-wrapper-script-stale');
  if (
    hostMcp.currentWrapperEnvMatchesConfig === false
    || hostMcp.currentContextWrapperEnvMatchesConfig === false
  ) {
    addFailureClass('mcp-host-env-mismatch');
  }
  if (
    hostMcp.currentWrapperTargetMatchesConfig === false
    || hostMcp.currentContextWrapperTargetMatchesConfig === false
  ) {
    addFailureClass('mcp-host-codegraph-target-mismatch');
  }
  if (
    liveProcesses?.commandMismatchCount > 0
    || liveProcesses?.targetMismatchCount > 0
  ) {
    addFailureClass('mcp-host-live-process-config-mismatch');
  }
  const hasActiveDirectWatchers = hostMcp.activeDirectWatcherRuns.length > 0;
  if (hasActiveDirectWatchers) {
    addFailureClass('active-direct-wrapper-watchers');
  }
  const hasActiveSharedDaemonFallbacks = hostMcp.activeSharedDaemonFallbackRuns.length > 0;
  const hasActiveInProcessFallbackWatchers =
    hostMcp.activeInProcessFallbackWatcherRuns.length > 0;
  if (hasActiveSharedDaemonFallbacks) {
    addFailureClass('active-shared-daemon-fallback');
  }
  if (hasActiveInProcessFallbackWatchers) {
    addFailureClass('active-in-process-fallback-watcher');
  }
  const hasCurrentAutoSyncDisabled = hostMcp.currentCodegraphAutoSyncDisabled?.count > 0;
  const hasActiveAutoSyncDisabled = hostMcp.activeCodegraphAutoSyncDisabled?.count > 0;
  if (hasCurrentAutoSyncDisabled || hasActiveAutoSyncDisabled) {
    addFailureClass('codegraph-autosync-disabled');
    if (hasActiveAutoSyncDisabled) {
      addFailureClass('active-wrapper-autosync-disabled');
    }
  }

  if (failureClasses.length === 0) {
    return {
      status: 'no-current-host-mcp-root-cause',
      failureBoundary: null,
      failureClasses,
      adapterFailureLikely: false,
      directMcpTrust: 'current-host-log-clean',
      recovery: [],
    };
  }

  const mismatchedProcesses = (liveProcesses?.mismatchedProcesses ?? [])
    .slice(0, 5);
  const autoSyncDisabledEvidence = hasCurrentAutoSyncDisabled || hasActiveAutoSyncDisabled
    ? selectAutoSyncDisabledEvidence(
        hostMcp.currentCodegraphAutoSyncDisabled,
        hostMcp.activeCodegraphAutoSyncDisabled,
        hostMcp.codegraphAutoSyncDisabled,
      )
    : null;
  const envMismatches = [
    ...summarizeEnvMismatches('current-wrapper', hostMcp.currentWrapperEnv),
    ...summarizeEnvMismatches('current-context-wrapper', hostMcp.currentContextWrapperEnv),
  ];
  const hasObservedDirectMcpTransportClosed =
    observedDirectMcpFailureClass === 'observed-direct-mcp-transport-closed';
  const hasObservedDirectMcpError = Boolean(observedDirectMcpFailureClass);
  const status = hasObservedDirectMcpTransportClosed
    ? 'direct-mcp-host-transport-closed'
    : failureClasses.includes('host-mcp-log-read-failed')
      ? 'host-mcp-diagnostic-log-unreadable'
    : hasActiveInProcessFallbackWatchers
      ? 'base-codegraph-shared-daemon-fallback-watcher'
      : hasActiveSharedDaemonFallbacks
        ? 'base-codegraph-shared-daemon-fallback'
    : failureClasses.includes('codegraph-autosync-disabled')
      ? 'direct-mcp-host-stale-or-index-frozen'
      : hasActiveDirectWatchers
        ? 'base-codegraph-direct-watcher-contention-risk'
      : hasObservedDirectMcpError
        ? 'direct-mcp-host-observed-error'
        : 'direct-mcp-host-config-mismatch';
  const failureBoundary = hasObservedDirectMcpError
    ? 'codex-mcp-host-transport'
    : failureClasses.includes('host-mcp-log-read-failed')
      ? 'codegraph-mcp-diagnostic-log'
    : hasActiveSharedDaemonFallbacks
      ? 'base-codegraph-process-topology'
    : failureClasses.includes('codegraph-autosync-disabled')
      ? 'codex-mcp-host-and-base-codegraph-index-watcher'
      : hasActiveDirectWatchers
        ? 'base-codegraph-process-topology'
      : 'codex-mcp-host';
  const directMcpTrust = hasObservedDirectMcpError
    ? 'do-not-trust-direct-mcp-until-host-restarts'
    : hasActiveSharedDaemonFallbacks
      ? 'do-not-trust-direct-mcp-until-fallback-proxies-restart'
      : 'do-not-trust-direct-mcp-until-host-restarts-or-index-syncs';

  return {
    status,
    failureBoundary,
    failureClasses,
    adapterFailureLikely: false,
    directMcpTrust,
    fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
    expected: {
      codexConfigSource: mcpConfig.source ?? null,
      codexConfigScope: mcpConfig.scope ?? null,
      codexConfigPath: mcpConfig.path ?? null,
      userConfigPath: mcpConfig.userConfigPath ?? null,
      projectConfigPath: mcpConfig.projectConfigPath ?? null,
      wrapperScriptPath: mcpConfig.wrapperScriptPath ?? null,
      codegraphTarget: mcpConfig.codegraphTarget ?? null,
      requiredCodegraphTarget: mcpConfig.requiredCodegraphTarget ?? null,
      configContractMismatches: mcpConfig.contractMismatches ?? [],
      env: hostMcp.currentWrapperEnv?.expected ?? null,
    },
    observed: {
      currentWrapper: summarizeWrapperStartForRootCause(hostMcp.currentWrapper),
      currentConfiguredWrapper: summarizeWrapperStartForRootCause(hostMcp.currentConfiguredWrapper),
      currentContextWrapper: summarizeWrapperStartForRootCause(hostMcp.currentContextWrapper),
      currentConfiguredContextWrapper: summarizeWrapperStartForRootCause(hostMcp.currentConfiguredContextWrapper),
      currentContextWrapperLatestTs: hostMcp.currentContextWrapperLatestTs,
      currentContextWrapperLatestRequestId: hostMcp.currentContextWrapperLatestRequestId,
      directMcpError: observedDirectMcpError,
      liveWrapperProcessCount: liveProcesses?.matchingWrapperCount ?? null,
      currentWrapperEnv: hostMcp.currentWrapperEnv?.actual ?? null,
      currentContextWrapperEnv: hostMcp.currentContextWrapperEnv?.actual ?? null,
      envMismatchCount: envMismatches.length,
      envMismatches,
      currentWrapperTarget: hostMcp.currentWrapperTarget?.actual ?? null,
      currentContextWrapperTarget: hostMcp.currentContextWrapperTarget?.actual ?? null,
      autoSyncDisabled: autoSyncDisabledEvidence,
      activeAutoSyncDisabledCount: hostMcp.activeCodegraphAutoSyncDisabled?.count ?? 0,
      activeAutoSyncDisabledRuns: hostMcp.activeCodegraphAutoSyncDisabledRuns,
      activeDirectWatcherCount: hostMcp.activeDirectWatcherRuns.length,
      activeDirectWatcherRuns: hostMcp.activeDirectWatcherRuns,
      activeSharedDaemonFallbackCount: hostMcp.activeSharedDaemonFallbackRuns.length,
      activeSharedDaemonFallbackRuns: hostMcp.activeSharedDaemonFallbackRuns,
      activeInProcessFallbackWatcherCount:
        hostMcp.activeInProcessFallbackWatcherRuns.length,
      activeInProcessFallbackWatcherRuns: hostMcp.activeInProcessFallbackWatcherRuns,
      liveProcessMismatchCount: mismatchedProcesses.length,
      liveProcessMismatches: mismatchedProcesses,
      malformedLogLine: hostMcp.latestMalformedLogLine,
      logReadError: hostMcp.logReadError,
      logEvidence: hostMcp.logEvidence ?? null,
    },
    recovery: [
      ...(mcpConfig.contractMatchesRequired === false
        ? [`Update the active Codex MCP config at ${mcpConfig.path ?? 'the reported config path'} so its target/env match the reported contract.`]
        : []),
      'Restart the Codex MCP host/session after the active config is correct so direct MCP reconnects with the current target/env.',
      'If auto-sync disabled is present, release the CodeGraph index writer lock and run codegraph sync before trusting direct MCP freshness.',
      ...(hasActiveDirectWatchers
        ? ['Restart live direct-session wrappers so they reconnect through the official shared daemon and collapse per-session watchers into one writer.']
        : []),
      ...(hasActiveSharedDaemonFallbacks
        ? ['Recycle live fallback base children so they reconnect through the shared daemon instead of retaining per-wrapper in-process engines.']
        : []),
      'Until the host is restarted, use npm run codegraph:adapter:context -- --query "<query>" --json as the fresh adapter fallback.',
    ],
  };
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

function selectAutoSyncDisabledEvidence(currentSummary, activeSummary, globalSummary) {
  const currentLatest = currentSummary?.latest ?? null;
  const activeLatest = activeSummary?.latest ?? null;
  const globalLatest = globalSummary?.latest ?? null;
  if (currentLatest?.textTail) {
    return {
      ...currentLatest,
      scope: 'current-wrapper',
    };
  }
  if (activeLatest?.textTail) {
    return {
      ...activeLatest,
      scope: 'active-live-wrapper',
    };
  }
  if (globalLatest?.textTail) {
    return {
      ...globalLatest,
      scope: currentSummary?.count > 0 ? 'host-log-fallback-for-current-wrapper' : 'historical-host-log',
    };
  }
  if (currentLatest) {
    return {
      ...currentLatest,
      scope: 'current-wrapper-without-warning-text',
    };
  }
  if (activeLatest) {
    return {
      ...activeLatest,
      scope: 'active-live-wrapper-without-warning-text',
    };
  }
  if (globalLatest) {
    return {
      ...globalLatest,
      scope: 'historical-host-log-without-warning-text',
    };
  }
  return null;
}

function summarizeEnvMismatches(scope, comparison) {
  if (!comparison || comparison.matches !== false) return [];
  const keys = Array.isArray(comparison.mismatchedKeys)
    ? comparison.mismatchedKeys
    : Object.keys(comparison.expected ?? {})
        .filter(key => comparison.actual?.[key] !== comparison.expected?.[key]);
  return keys.map(key => ({
    scope,
    key,
    expected: comparison.expected?.[key] ?? null,
    actual: comparison.actual?.[key] ?? null,
  }));
}

function summarizeWrapperStartForRootCause(wrapperStart) {
  if (!wrapperStart) return null;
  return {
    ts: wrapperStart.ts ?? null,
    runId: wrapperStart.runId ?? null,
    pid: wrapperStart.wrapperPid ?? wrapperStart.pid ?? null,
    scriptSha256: wrapperStart.scriptSha256 ?? null,
    codegraphTarget: wrapperStart.codegraphTarget ?? null,
    env: wrapperStart.env ?? null,
    effectiveChildEnv: wrapperStart.effectiveChildEnv ?? null,
  };
}

function classifyWrapperParentProcess(processInfo) {
  const parentName = String(processInfo?.parentName ?? '').trim().toLowerCase();
  const parentCommandLine = String(processInfo?.parentCommandLine ?? '').trim().toLowerCase();
  if (!parentName && !parentCommandLine) return 'unknown';
  if (
    parentName === 'codex'
    || parentName === 'codex.exe'
    || /(?:^|[\\/])codex(?:\.exe)?(?:["'\s]|$)/u.test(parentCommandLine)
    || /(?:^|\s)codex(?:\.exe)?(?:\s|$)/u.test(parentCommandLine)
  ) {
    return 'codex-host';
  }
  return 'auxiliary-non-codex';
}

function extractCodegraphTargetFromCommandLine(commandLine, wrapperPath) {
  const text = String(commandLine ?? '');
  const packageMatch = text.match(/@colbymchenry\/codegraph@[^\s"']+/i);
  if (packageMatch) return packageMatch[0];

  const tokens = tokenizeCommandLine(text);
  const normalizedWrapperPath = normalizePathLikeString(wrapperPath);
  const wrapperIndex = tokens.findIndex(token => {
    const normalized = normalizePathLikeString(token);
    return normalized === normalizedWrapperPath || normalized.endsWith(normalizedWrapperPath);
  });
  if (wrapperIndex >= 0 && tokens[wrapperIndex + 1]) {
    return tokens[wrapperIndex + 1];
  }
  return null;
}

function tokenizeCommandLine(commandLine) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(commandLine ?? ''))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function buildStaleWrapperCleanupPlan({
  startsByRunId,
  latestEntryByRunId,
  autoSyncDisabledByRunId,
  liveProcesses,
  diskScriptSha256,
  configuredEnv,
  expectedCodegraphTarget,
  observedAtMs,
  minIdleMs,
}) {
  const candidates = [];
  const skipped = [];
  const processByPid = new Map((liveProcesses?.processes ?? [])
    .map(processInfo => [Number(processInfo?.pid), processInfo])
    .filter(([pid]) => Number.isFinite(pid)));

  for (const [runId, start] of startsByRunId.entries()) {
    const pid = Number(start.wrapperPid ?? start.pid);
    const processInfo = processByPid.get(pid);
    if (!Number.isFinite(pid) || !processInfo) continue;
    const reasons = [];
    const envComparison = compareWrapperStartEnv(start, configuredEnv);
    const targetComparison = compareWrapperStartTarget(start, expectedCodegraphTarget);
    if (wrapperStartMatchesDisk(start, diskScriptSha256) === false) {
      reasons.push('wrapper-script-stale');
    }
    if (envComparison.matches === false) {
      reasons.push('wrapper-env-mismatch');
    }
    if (targetComparison.matches === false) {
      reasons.push('codegraph-target-mismatch');
    }
    if (daemonLifetimeEnvInvalid(start.env)) {
      reasons.push('daemon-lifetime-env-invalid');
    }
    if (Number(autoSyncDisabledByRunId.get(runId)?.count ?? 0) > 0) {
      reasons.push('codegraph-autosync-disabled');
    }
    if (reasons.length === 0) continue;

    const latestEntry = latestEntryByRunId.get(runId) ?? start;
    const latestMs = eventTimestampMs(latestEntry);
    const idleMs = Number.isFinite(latestMs) && Number.isFinite(observedAtMs)
      ? Math.max(0, observedAtMs - latestMs)
      : null;
    const activeWorkCount = doctorLogEntryActiveWorkCount(latestEntry);
    const skipReasons = [];
    if (activeWorkCount > 0) {
      skipReasons.push('active-work');
    }
    if (!Number.isFinite(idleMs) || idleMs < minIdleMs) {
      skipReasons.push('inside-min-idle-window');
    }
    const item = {
      runId,
      pid,
      parentPid: processInfo.parentPid ?? null,
      startedAt: processInfo.startedAt ?? null,
      latestTs: latestEntry?.ts ?? start.ts ?? null,
      latestEvent: latestEntry?.event ?? 'wrapper.start',
      idleMs,
      activeWorkCount,
      reasons,
      skipReasons,
      scriptSha256: start.scriptSha256 ?? null,
      diskScriptSha256: diskScriptSha256 ?? null,
      envMismatchedKeys: envComparison.mismatchedKeys ?? [],
      codegraphTarget: start.codegraphTarget ?? null,
      commandLine: processInfo.commandLine ?? null,
    };
    if (skipReasons.length === 0) {
      candidates.push(item);
    } else {
      skipped.push(item);
    }
  }

  const byOldestActivity = (left, right) => {
    const leftMs = eventTimestampMs({ ts: left.latestTs });
    const rightMs = eventTimestampMs({ ts: right.latestTs });
    return leftMs - rightMs;
  };
  candidates.sort(byOldestActivity);
  skipped.sort(byOldestActivity);
  return {
    observedAt: isoFromMs(observedAtMs),
    minIdleMs,
    liveWrapperCount: liveProcesses?.matchingWrapperCount ?? null,
    candidates,
    skipped,
    dryRunCommand: 'node scripts/codegraph-adapter-doctor.cjs --cleanup-stale-wrappers',
    applyCommandTemplate: 'node scripts/codegraph-adapter-doctor.cjs --cleanup-stale-wrappers --apply-cleanup --cleanup-run-id <runId>',
  };
}

function daemonLifetimeEnvInvalid(env) {
  return [
    env?.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS,
    env?.CODEGRAPH_DAEMON_MAX_IDLE_MS,
  ].some(value => {
    const parsed = Number(value);
    return !Number.isFinite(parsed) || parsed <= 0;
  });
}

function doctorLogEntryActiveWorkCount(entry) {
  const runtime = entry?.runtime && typeof entry.runtime === 'object'
    ? entry.runtime
    : {};
  return [
    runtime.activeRequestCount,
    runtime.pendingContextPackCount,
    runtime.pendingToolsListCount,
    runtime.childInputQueueLength,
    runtime.clientOutputQueueLength,
  ].reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
}

function liveWrapperProcessIdentities(liveProcesses) {
  if (!liveProcesses?.available) {
    return null;
  }
  if (liveProcesses.matchingWrapperCount <= 0) {
    return new Map();
  }
  return new Map((liveProcesses.processes ?? [])
    .map(processInfo => {
      const pid = Number(processInfo?.pid);
      if (!Number.isFinite(pid)) return null;
      const startedAtMs = Date.parse(String(processInfo?.startedAt ?? ''));
      return [pid, {
        pid,
        startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
        startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Number.NaN,
      }];
    })
    .filter(Boolean));
}

function wrapperLogEntryMatchesLiveWrapper(entry, liveWrapperProcesses) {
  if (!liveWrapperProcesses) {
    return { matches: true, pidReused: false };
  }
  if (liveWrapperProcesses.size === 0) {
    return { matches: false, pidReused: false };
  }
  const entryTimestampMs = eventTimestampMs(entry);
  let matchedPid = false;
  let pidReused = false;
  const candidatePids = [...new Set([
    entry?.wrapperPid,
    entry?.pid,
    entry?.wrapperStart?.wrapperPid,
    entry?.wrapperStart?.pid,
  ].map(pid => Number(pid)).filter(pid => Number.isFinite(pid)))];
  for (const pid of candidatePids) {
    const liveProcess = liveWrapperProcesses.get(pid);
    if (!liveProcess) continue;
    matchedPid = true;
    if (
      !Number.isFinite(entryTimestampMs)
      || !Number.isFinite(liveProcess.startedAtMs)
      || entryTimestampMs >= liveProcess.startedAtMs - LIVE_PROCESS_START_CLOCK_SKEW_MS
    ) {
      return { matches: true, pidReused: false };
    }
    pidReused = true;
  }
  return {
    matches: false,
    pidReused: matchedPid && pidReused,
  };
}

function wrapperLogEntryIsCurrentEvidence(entry, observedAtMs) {
  if (!Number.isFinite(observedAtMs)) return true;
  return isTimestampInsideActiveWindow(eventTimestampMs(entry), observedAtMs);
}

function shouldMatchExactCommand(command) {
  return typeof command === 'string'
    && command.length > 0
    && (path.isAbsolute(command) || command.includes('/') || command.includes('\\'));
}

function createCodegraphAutoSyncDisabledSummary() {
  return {
    count: 0,
    byDate: {},
    latest: null,
  };
}

function isCodegraphAutoSyncDisabledLogEntry(entry) {
  const responseWarnings = [entry?.baseResponseWarnings, entry?.responseWarnings];
  if (responseWarnings.some(warnings => (
    warnings?.codegraphAutoSyncDisabled === true
    && isLeadingCodegraphAutoSyncDisabledWarningText(warnings?.textTail)
  ))) {
    return true;
  }
  if (entry?.event !== 'child.stderr') return false;
  const text = String(entry.text ?? '').toLowerCase();
  return text.includes('codegraph auto-sync is disabled')
    || (text.includes('auto-sync disabled') && text.includes('file lock'))
    || (text.includes('index is frozen') && text.includes('codegraph'));
}

function isLeadingCodegraphAutoSyncDisabledWarningText(text) {
  const value = String(text ?? '');
  const lower = value.toLowerCase();
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

function recordCodegraphAutoSyncDisabled(summary, entry) {
  if (!summary || !isCodegraphAutoSyncDisabledLogEntry(entry)) return;
  summary.count++;
  const dateKey = typeof entry.ts === 'string' ? entry.ts.slice(0, 10) : '(unknown)';
  summary.byDate[dateKey] = (summary.byDate[dateKey] ?? 0) + 1;
  const warningText = autoSyncDisabledWarningTextTail(entry);
  const latest = {
    ts: entry.ts ?? null,
    runId: entry.runId ?? null,
    event: entry.event,
    failureClass: 'codegraph-autosync-disabled',
    textTail: warningText,
    baseResponseWarnings: compactResponseWarnings(entry.baseResponseWarnings),
    responseWarnings: compactResponseWarnings(entry.responseWarnings),
  };
  if (warningText || !summary.latest) {
    summary.latest = latest;
  }
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

function textTail(value, maxLength = 1200) {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function autoSyncDisabledWarningTextTail(entry, maxLength = 1200) {
  return warningTextExcerpt(entry?.text, maxLength)
    ?? warningTextExcerpt(entry?.responseWarnings?.textTail, maxLength)
    ?? warningTextExcerpt(entry?.baseResponseWarnings?.textTail, maxLength);
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

function readJsonLines(filePath) {
  try {
    const entries = [];
    let malformedLines = 0;
    let latestMalformedLine = null;
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line, index) => {
        try {
          entries.push(JSON.parse(line));
        } catch {
          malformedLines++;
          latestMalformedLine = {
            lineNumber: index + 1,
            textTail: line.length > 1200 ? line.slice(-1200) : line,
          };
        }
      });
    return { entries, malformedLines, latestMalformedLine, readError: null };
  } catch (error) {
    return {
      entries: [],
      malformedLines: 0,
      latestMalformedLine: null,
      readError: serializeIncidentError(error),
    };
  }
}

function selectLatestLogEntry(entries) {
  let latest = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const tsMs = Date.parse(entry?.ts ?? '');
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs >= latestMs) {
      latest = entry;
      latestMs = tsMs;
    }
  }
  return latest;
}

function pickWrapperStart(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ts: value.ts ?? null,
    runId: value.runId ?? null,
    pid: value.pid ?? null,
    wrapperPid: value.wrapperPid ?? value.pid ?? null,
    scriptPath: value.scriptPath ?? null,
    scriptSha256: value.scriptSha256 ?? null,
    codegraphTarget: value.codegraphTarget ?? null,
    codegraphArgs: Array.isArray(value.codegraphArgs) ? value.codegraphArgs : null,
    env: value.env && typeof value.env === 'object' ? value.env : null,
    codexConfigAlignment: value.codexConfigAlignment && typeof value.codexConfigAlignment === 'object'
      ? value.codexConfigAlignment
      : null,
    effectiveChildEnv: value.effectiveChildEnv && typeof value.effectiveChildEnv === 'object'
      ? value.effectiveChildEnv
      : null,
    runtimeTopology: normalizeWrapperRuntimeTopology(value.runtimeTopology, value.effectiveChildEnv),
  };
}

function normalizeWrapperRuntimeTopology(value, effectiveChildEnv = null) {
  const env = effectiveChildEnv && typeof effectiveChildEnv === 'object'
    ? effectiveChildEnv
    : {};
  const daemonDisabled = value?.daemonDisabled ?? envFlagEnabled(env.CODEGRAPH_NO_DAEMON);
  const watchDisabled = value?.watchDisabled ?? env.CODEGRAPH_NO_WATCH === '1';
  return {
    mode: value?.mode ?? (daemonDisabled ? 'direct-session' : 'shared-daemon-proxy'),
    watcherOwnership: value?.watcherOwnership ?? (
      watchDisabled
        ? 'disabled-manual-sync'
        : daemonDisabled
          ? 'per-wrapper-watcher'
          : 'shared-daemon-single-watcher'
    ),
    fileLockContentionRisk: value?.fileLockContentionRisk ?? (
      watchDisabled
        ? 'none-no-watcher'
        : daemonDisabled
          ? 'multi-wrapper-writers'
          : 'single-writer'
    ),
    daemonDisabled,
    watchDisabled,
    daemonIdleTimeoutMs: finiteNumberOrNull(
      value?.daemonIdleTimeoutMs ?? env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS,
    ),
    daemonMaxIdleMs: finiteNumberOrNull(
      value?.daemonMaxIdleMs ?? env.CODEGRAPH_DAEMON_MAX_IDLE_MS,
    ),
  };
}

function runtimeTopologyFromDoctorLogEntry(entry, fallbackTopology = null, effectiveChildEnv = null) {
  if (!entry) return fallbackTopology;
  const value = entry.event === 'child.runtime-topology.transition'
    || entry.event === 'child.runtime-topology.reset'
      ? entry.to
      : entry.runtimeTopology ?? entry.runtime?.runtimeTopology;
  if (!value || typeof value !== 'object') {
    return fallbackTopology;
  }
  return normalizeWrapperRuntimeTopology(value, effectiveChildEnv);
}

function compactFallbackRuntimeStart(start) {
  return {
    runId: start.runId,
    pid: start.wrapperPid ?? start.pid ?? null,
    mode: start.runtimeTopology?.mode ?? null,
    watcherOwnership: start.runtimeTopology?.watcherOwnership ?? null,
    fileLockContentionRisk: start.runtimeTopology?.fileLockContentionRisk ?? null,
    effectiveChildEnv: start.effectiveChildEnv,
  };
}

function envFlagEnabled(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

function finiteNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareWrapperStartEnv(wrapperStart, configuredEnv) {
  const expected = Object.fromEntries(
    HOST_MCP_ENV_KEYS_TO_COMPARE
      .filter(key => typeof configuredEnv?.[key] === 'string')
      .map(key => [key, String(configuredEnv[key])]),
  );
  if (Object.keys(expected).length === 0) {
    return { matches: null, expected, actual: null, mismatchedKeys: [] };
  }
  if (!wrapperStart || !wrapperStart.env || typeof wrapperStart.env !== 'object') {
    return { matches: null, expected, actual: null, mismatchedKeys: [] };
  }
  const actual = Object.fromEntries(
    Object.keys(expected).map(key => [
      key,
      typeof wrapperStart.env[key] === 'string' ? String(wrapperStart.env[key]) : null,
    ]),
  );
  const mismatchedKeys = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key);
  return { matches: mismatchedKeys.length === 0, expected, actual, mismatchedKeys };
}

function compareWrapperStartTarget(wrapperStart, expectedCodegraphTarget) {
  if (!expectedCodegraphTarget) {
    return { matches: null, expected: null, actual: wrapperStart?.codegraphTarget ?? null };
  }
  if (!wrapperStart || typeof wrapperStart.codegraphTarget !== 'string') {
    return { matches: null, expected: expectedCodegraphTarget, actual: null };
  }
  return {
    matches: codegraphTargetsMatch(wrapperStart.codegraphTarget, expectedCodegraphTarget),
    expected: expectedCodegraphTarget,
    actual: wrapperStart.codegraphTarget,
  };
}

function codegraphTargetsMatch(actual, expected) {
  if (actual === expected) return true;
  const normalizedActual = normalizePathLikeString(actual);
  const normalizedExpected = normalizePathLikeString(expected);
  return normalizedActual === normalizedExpected;
}

function normalizePathLikeString(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^"|"$/g, '').toLowerCase();
}

function hostConfigMismatchInvestigation(failureClass) {
  return {
    failureBoundary: 'mcp-host-config',
    failureClass,
    likelyRootCause: 'Live CodeGraph MCP host process does not match the active Codex MCP configuration.',
    nextEvidence: [
      'doctor mcpConfig.path / active Codex config',
      'wrapper.start.codegraphTarget',
      'wrapper.start.env',
      'live process commandLine',
      'codegraph:adapter:context fresh wrapper',
    ],
  };
}

function codegraphAutoSyncDisabledInvestigation(scope = 'current-wrapper') {
  return {
    failureBoundary: 'base-codegraph-index-watcher',
    failureClass: 'codegraph-autosync-disabled',
    scope,
    likelyRootCause: 'Base CodeGraph auto-sync stopped because the index file lock was held past the retry budget, so the MCP host may be serving a frozen index.',
    nextEvidence: [
      'hostMcp.currentCodegraphAutoSyncDisabled.latest.textTail',
      'hostMcp.activeCodegraphAutoSyncDisabledRuns',
      'child.stderr',
      '.codegraph index file lock owner',
      'codegraph sync',
      'fresh adapter context after sync',
    ],
  };
}

function directWatcherContentionInvestigation() {
  return {
    failureBoundary: 'base-codegraph-process-topology',
    failureClass: 'active-direct-wrapper-watchers',
    likelyRootCause: 'Multiple live MCP wrappers are running CodeGraph in direct mode with one watcher each, so they can repeatedly contend for the same index writer lock before auto-sync visibly degrades.',
    nextEvidence: [
      'hostMcp.activeDirectWatcherRuns',
      'wrapper.start.runtimeTopology',
      'wrapper.start.effectiveChildEnv.CODEGRAPH_NO_DAEMON',
      '.codegraph/daemon.pid',
      '.codegraph/daemon.log',
      'fresh shared-daemon smoke',
    ],
  };
}

function sharedDaemonFallbackInvestigation(failureClass) {
  return {
    failureBoundary: 'base-codegraph-process-topology',
    failureClass,
    likelyRootCause: failureClass === 'active-in-process-fallback-watcher'
      ? 'A live upstream shared-daemon proxy permanently fell back to an in-process engine and started a per-wrapper watcher, creating another SQLite writer candidate before auto-sync necessarily reports a lock failure.'
      : 'A live upstream shared-daemon proxy lost its daemon socket and permanently switched to an in-process fallback engine instead of reconnecting.',
    nextEvidence: [
      'hostMcp.activeSharedDaemonFallbackRuns',
      'hostMcp.activeInProcessFallbackWatcherRuns',
      'child.runtime-topology.transition',
      'child.shared-daemon-fallback.recovery.request',
      'child.shared-daemon-fallback.recovery.restart',
      '.codegraph/daemon.log',
    ],
  };
}

function observedDirectMcpErrorInvestigation(failureClass) {
  return {
    failureBoundary: 'codex-mcp-host-transport',
    failureClass,
    adapterFailureLikely: false,
    likelyRootCause: 'The Codex MCP host reported an error before a fresh wrapper process wrote new request evidence; treat the connected host/session as stale or closed until it restarts.',
    nextEvidence: [
      'observed direct MCP tool error',
      'hostMcp.liveProcesses.matchingWrapperCount',
      '.codegraph/nanoflow-mcp-wrapper.log latest wrapper.start',
      'codegraph:adapter:context fresh wrapper',
      'codegraph:mcp:smoke fresh wrapper continuity',
    ],
  };
}

function hashFileIfExists(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function wrapperStartMatchesDisk(wrapperStart, diskScriptSha256) {
  if (!wrapperStart || !diskScriptSha256) return null;
  if (!wrapperStart.scriptSha256) return null;
  return wrapperStart.scriptSha256 === diskScriptSha256;
}

function wrapperStartMatchesCurrentConfig(
  wrapperStart,
  diskScriptSha256,
  configuredEnv,
  expectedCodegraphTarget,
) {
  return wrapperStartMatchesDisk(wrapperStart, diskScriptSha256) === true
    && compareWrapperStartEnv(wrapperStart, configuredEnv).matches === true
    && compareWrapperStartTarget(wrapperStart, expectedCodegraphTarget).matches === true;
}

function wrapperStartIsAfter(candidate, previous) {
  const candidateTime = Date.parse(candidate?.ts ?? '');
  const previousTime = Date.parse(previous?.ts ?? '');
  return Number.isFinite(candidateTime) && Number.isFinite(previousTime) && candidateTime > previousTime;
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function replaceWorkspaceFolder(value, root) {
  return String(value).replaceAll('${workspaceFolder}', root);
}

function buildReport(root, options = {}) {
  const checks = [];
  checks.push(...inspectPackageScripts(root));
  const phase = options.phase ?? (options.strict ? 'post-generation' : 'pre-generation');
  const { overlay, checks: overlayChecks } = inspectOverlay(root, phase);
  const { leases, checks: leaseChecks } = inspectLeases(root);
  const { mcpConfig, checks: mcpConfigChecks } = inspectMcpConfig(root);
  const { liveProcesses, checks: liveProcessChecks } = inspectLiveMcpProcesses(root, mcpConfig);
  const { hostMcp, checks: hostMcpChecks } = inspectHostMcp(root, mcpConfig, liveProcesses, {
    directMcpError: options.directMcpError,
    observedAt: options.observedAt,
    cleanupMinIdleMs: options.cleanupMinIdleMs,
  });
  hostMcp.liveProcesses = liveProcesses;
  if (liveProcesses.recommendation) {
    hostMcp.recommendation = [
      ...(hostMcp.recommendation ?? []),
      ...liveProcesses.recommendation,
    ];
  }
  checks.push(...overlayChecks, ...leaseChecks, ...mcpConfigChecks, ...hostMcpChecks, ...liveProcessChecks);
  if (options.strict) {
    checks.push(...inspectTopology(root));
  }

  return {
    ok: checks.every(check => check.ok),
    runtimeOk: null,
    pendingHostRestart: false,
    root,
    strict: options.strict === true,
    phase,
    overlay,
    leases,
    mcpConfig,
    hostMcp,
    checks,
  };
}

function applyConfigRepairRuntimeState(report, configRepair) {
  if (!configRepair) return;

  const matchingRuntimeObserved = Boolean(
    report.hostMcp.currentConfiguredWrapper
    || report.hostMcp.currentConfiguredContextWrapper,
  );
  const pendingHostRestart = configRepair.changed && !matchingRuntimeObserved;
  report.runtimeOk = configRepair.changed ? matchingRuntimeObserved : null;
  report.pendingHostRestart = pendingHostRestart;
  report.mcpConfig.repair = {
    ...configRepair,
    runtimeOk: report.runtimeOk,
    pendingHostRestart,
  };

  if (!pendingHostRestart) return;

  const runtimeCheck = makeCheck('mcp-config:runtime-reloaded', false, {
    expected: 'matching live wrapper after Codex MCP host/session restart',
    actual: 'no matching live wrapper observed',
  });
  report.checks.push(runtimeCheck);
  report.ok = false;
  report.mcpConfig.recommendation = [
    ...(report.mcpConfig.recommendation ?? []),
    'The active Codex config is repaired on disk, but the connected MCP host has not loaded a matching wrapper yet.',
    'Restart the Codex MCP host/session; until a matching wrapper.start is observed, use: npm run codegraph:adapter:context -- --query "<query>" --json',
  ];
}

function persistDirectMcpIncidentReport(report, options = {}) {
  if (!options.directMcpError) {
    return null;
  }

  const incidentPath = path.join(report.root, '.codegraph', 'codegraph-mcp-incident.latest.json');
  const generatedAt = new Date().toISOString();
  const payload = buildDirectMcpIncidentPayload(report, options, generatedAt);
  try {
    fs.mkdirSync(path.dirname(incidentPath), { recursive: true });
    const tempPath = `${incidentPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, incidentPath);
    return {
      schemaVersion: DIRECT_MCP_INCIDENT_SCHEMA_VERSION,
      path: relativePath(report.root, incidentPath),
      written: true,
      generatedAt,
      directMcpError: options.directMcpError,
      rootCauseStatus: report.hostMcp.rootCauseSummary?.status ?? null,
      failureClasses: report.hostMcp.rootCauseSummary?.failureClasses ?? [],
      fallback: report.hostMcp.rootCauseSummary?.fallback ?? null,
    };
  } catch (error) {
    return {
      schemaVersion: DIRECT_MCP_INCIDENT_SCHEMA_VERSION,
      path: relativePath(report.root, incidentPath),
      written: false,
      generatedAt,
      directMcpError: options.directMcpError,
      rootCauseStatus: report.hostMcp.rootCauseSummary?.status ?? null,
      failureClasses: report.hostMcp.rootCauseSummary?.failureClasses ?? [],
      fallback: report.hostMcp.rootCauseSummary?.fallback ?? null,
      error: serializeIncidentError(error),
    };
  }
}

function buildDirectMcpIncidentPayload(report, options, generatedAt) {
  const rootCauseSummary = report.hostMcp.rootCauseSummary ?? null;
  const observedAt = rootCauseSummary?.observed?.logEvidence?.observedAt
    ?? isoFromMs(parseObservedAtMs(options.observedAt))
    ?? null;
  return {
    schemaVersion: DIRECT_MCP_INCIDENT_SCHEMA_VERSION,
    generatedAt,
    root: report.root,
    directMcpError: options.directMcpError,
    observedAt,
    fallback: rootCauseSummary?.fallback ?? null,
    rootCauseSummary,
    failedChecks: report.checks
      .filter(check => !check.ok)
      .map(summarizeFailedDoctorCheck),
    recovery: report.hostMcp.recommendation ?? [],
    mcpConfig: {
      source: report.mcpConfig.source,
      scope: report.mcpConfig.scope,
      path: report.mcpConfig.path,
      userConfigPath: report.mcpConfig.userConfigPath,
      projectConfigPath: report.mcpConfig.projectConfigPath,
      candidateConfigs: report.mcpConfig.candidateConfigs,
      wrapperScriptPath: report.mcpConfig.wrapperScriptPath,
      codegraphTarget: report.mcpConfig.codegraphTarget,
      requiredCodegraphTarget: report.mcpConfig.requiredCodegraphTarget,
      targetContractEnforced: report.mcpConfig.targetContractEnforced,
      targetMatchesRequired: report.mcpConfig.targetMatchesRequired,
      configuredEnv: report.mcpConfig.configuredEnv,
      requiredEnv: report.mcpConfig.requiredEnv,
      contractMatchesRequired: report.mcpConfig.contractMatchesRequired,
      contractMismatches: report.mcpConfig.contractMismatches,
    },
    hostMcp: {
      logPath: report.hostMcp.logPath,
      logReadError: report.hostMcp.logReadError,
      logMalformedLines: report.hostMcp.logMalformedLines,
      observedDirectMcpError: report.hostMcp.observedDirectMcpError,
      observedDirectMcpFailureClass: report.hostMcp.observedDirectMcpFailureClass,
      currentWrapperMatchesDisk: report.hostMcp.currentWrapperMatchesDisk,
      currentContextWrapperMatchesDisk: report.hostMcp.currentContextWrapperMatchesDisk,
      hostConfigMismatch: report.hostMcp.hostConfigMismatch,
      staleAgainstDisk: report.hostMcp.staleAgainstDisk,
      logEvidence: report.hostMcp.logEvidence ?? null,
      currentEvidenceWindow: report.hostMcp.currentEvidenceWindow ?? null,
      liveWrapperLogFilter: report.hostMcp.liveWrapperLogFilter ?? null,
      liveProcesses: {
        available: report.hostMcp.liveProcesses?.available ?? null,
        wrapperProcessCount: report.hostMcp.liveProcesses?.wrapperProcessCount ?? null,
        matchingWrapperCount: report.hostMcp.liveProcesses?.matchingWrapperCount ?? null,
        auxiliaryProcessCount: report.hostMcp.liveProcesses?.auxiliaryProcessCount ?? null,
        hostParentPids: report.hostMcp.liveProcesses?.hostParentPids ?? [],
        auxiliaryProcesses: report.hostMcp.liveProcesses?.auxiliaryProcesses ?? [],
        commandMismatchCount: report.hostMcp.liveProcesses?.commandMismatchCount ?? null,
        targetMismatchCount: report.hostMcp.liveProcesses?.targetMismatchCount ?? null,
        mismatchedProcesses: (report.hostMcp.liveProcesses?.mismatchedProcesses ?? [])
          .slice(0, 20),
      },
    },
  };
}

function summarizeFailedDoctorCheck(check) {
  return {
    name: check.name,
    ok: false,
    ...(Object.prototype.hasOwnProperty.call(check, 'expected') ? { expected: check.expected } : {}),
    ...(Object.prototype.hasOwnProperty.call(check, 'actual') ? { actual: check.actual } : {}),
    ...(check.error ? { error: check.error } : {}),
    ...(check.failureClass ? { failureClass: check.failureClass } : {}),
    ...(check.investigation?.failureClass ? { failureClass: check.investigation.failureClass } : {}),
  };
}

function serializeIncidentError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    code: error?.code,
    stack: error?.stack,
  };
}

function formatExplain(report) {
  const currentWrapperConfigMatches = wrapperConfigMatches(
    report.hostMcp.currentWrapperEnvMatchesConfig,
    report.hostMcp.currentWrapperTargetMatchesConfig,
  );
  const currentContextWrapperConfigMatches = wrapperConfigMatches(
    report.hostMcp.currentContextWrapperEnvMatchesConfig,
    report.hostMcp.currentContextWrapperTargetMatchesConfig,
  );
  const lines = [
    'CodeGraph adapter doctor',
    `root: ${report.root}`,
    `strict: ${report.strict ? 'true' : 'false'}`,
    `overlay: ${report.overlay.exists ? 'present' : 'missing'}; nodes=${report.overlay.graphNodes ?? 'n/a'} edges=${report.overlay.graphEdges ?? 'n/a'} stale=${report.overlay.stale}`,
    `leases: active=${report.leases.activeCount} expired=${report.leases.expiredCount} owners=${report.leases.owners.join(',') || 'none'}`,
    `mcpConfig: source=${report.mcpConfig.source ?? 'unknown'} scope=${report.mcpConfig.scope ?? 'unknown'} file=${report.mcpConfig.exists ? 'present' : 'missing'} path=${report.mcpConfig.path ?? 'n/a'} codegraphServer=${report.mcpConfig.codegraphServerConfigured ? 'present' : 'missing'} wrapper=${formatOptionalPresent(report.mcpConfig.wrapperScriptExists)} target=${report.mcpConfig.codegraphTarget ?? 'n/a'} runtimeToolDiscovery=${report.mcpConfig.runtimeToolDiscoveryVisible}`,
    `mcpConfig contract: matches=${report.mcpConfig.contractMatchesRequired} requiredTarget=${report.mcpConfig.requiredCodegraphTarget ?? 'n/a'} mismatches=${JSON.stringify(report.mcpConfig.contractMismatches ?? [])}`,
    `mcpConfig runtime: runtimeOk=${formatCheckDetailValue(report.runtimeOk)} pendingHostRestart=${report.pendingHostRestart ? 'true' : 'false'}`,
    `hostMcp: log=${report.hostMcp.logExists ? 'present' : 'missing'} malformed=${report.hostMcp.logMalformedLines ?? 0} currentWrapper=${formatHostMcpFreshness(report.hostMcp.currentWrapperMatchesDisk, false, currentWrapperConfigMatches)} currentContextWrapper=${formatHostMcpFreshness(report.hostMcp.currentContextWrapperMatchesDisk, report.hostMcp.currentContextWrapperSupersededByFreshWrapper, currentContextWrapperConfigMatches)} scriptStale=${report.hostMcp.scriptStaleAgainstDisk ? 'yes' : 'no'} hostConfigMismatch=${report.hostMcp.hostConfigMismatch ? 'yes' : 'no'} currentAutoSyncDisabled=${report.hostMcp.currentCodegraphAutoSyncDisabled?.count ?? 0} activeAutoSyncDisabled=${report.hostMcp.activeCodegraphAutoSyncDisabled?.count ?? 0} activeDirectWatchers=${report.hostMcp.activeDirectWatcherRuns?.length ?? 0} activeSharedDaemonFallbacks=${report.hostMcp.activeSharedDaemonFallbackRuns?.length ?? 0} activeFallbackWatchers=${report.hostMcp.activeInProcessFallbackWatcherRuns?.length ?? 0}`,
    `hostMcp liveProcesses: available=${formatOptionalPresent(report.hostMcp.liveProcesses?.available)} wrappers=${report.hostMcp.liveProcesses?.wrapperProcessCount ?? 'n/a'} matching=${report.hostMcp.liveProcesses?.matchingWrapperCount ?? 'n/a'} auxiliary=${report.hostMcp.liveProcesses?.auxiliaryProcessCount ?? 'n/a'} hostParentPids=${formatCheckDetailValue(report.hostMcp.liveProcesses?.hostParentPids)} commandMismatch=${report.hostMcp.liveProcesses?.commandMismatchCount ?? 'n/a'} targetMismatch=${report.hostMcp.liveProcesses?.targetMismatchCount ?? 'n/a'}`,
    'checks:',
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${formatCheckDetails(check)}`);
  }
  if (report.hostMcp.recommendation) {
    lines.push('host MCP recovery:');
    for (const recommendation of report.hostMcp.recommendation) {
      lines.push(`- ${recommendation}`);
    }
  }
  if (report.hostMcp.rootCauseSummary?.failureClasses?.length > 0) {
    const summary = report.hostMcp.rootCauseSummary;
    lines.push('host MCP root cause:');
    lines.push(`- status=${summary.status} boundary=${summary.failureBoundary} adapterFailureLikely=${summary.adapterFailureLikely} directMcpTrust=${summary.directMcpTrust}`);
    lines.push(`- failureClasses=${summary.failureClasses.join(',')}`);
    if (summary.expected?.codegraphTarget || summary.observed?.currentWrapperTarget) {
      lines.push(`- codegraphTarget expected=${formatCheckDetailValue(summary.expected?.codegraphTarget)} current=${formatCheckDetailValue(summary.observed?.currentWrapperTarget)} context=${formatCheckDetailValue(summary.observed?.currentContextWrapperTarget)}`);
    }
    if (summary.observed?.directMcpError) {
      lines.push(`- observedDirectMcpError=${formatCheckDetailValue(summary.observed.directMcpError)} liveWrapperProcessCount=${formatCheckDetailValue(summary.observed.liveWrapperProcessCount)}`);
    }
    if (summary.observed?.logEvidence) {
      const logEvidence = summary.observed.logEvidence;
      const filter = logEvidence.liveWrapperLogFilter ?? {};
      const evidenceWindow = logEvidence.currentEvidenceWindow ?? {};
      lines.push(`- logEvidence latestTs=${formatCheckDetailValue(logEvidence.latestTs)} latestEvent=${formatCheckDetailValue(logEvidence.latestEvent)} latestRunId=${formatCheckDetailValue(logEvidence.latestRunId)} observedAt=${formatCheckDetailValue(logEvidence.observedAt)} latestLogAgeMs=${formatCheckDetailValue(logEvidence.latestLogAgeMs)} staleAgainstObservedAt=${formatCheckDetailValue(logEvidence.staleAgainstObservedAt)} hasCurrentWrapperEvidence=${formatCheckDetailValue(logEvidence.hasCurrentWrapperEvidence)} ignoredWrapperStarts=${formatCheckDetailValue(filter.ignoredWrapperStarts)} ignoredContextResponses=${formatCheckDetailValue(filter.ignoredContextResponses)} ignoredPidReuseWrapperStarts=${formatCheckDetailValue(filter.ignoredPidReuseWrapperStarts)} ignoredPidReuseContextResponses=${formatCheckDetailValue(filter.ignoredPidReuseContextResponses)} processStartClockSkewMs=${formatCheckDetailValue(filter.processStartClockSkewMs)} ignoredStaleWrapperStarts=${formatCheckDetailValue(evidenceWindow.ignoredWrapperStarts)} ignoredStaleContextResponses=${formatCheckDetailValue(evidenceWindow.ignoredContextResponses)} noCurrentWrapperEvidence=${formatCheckDetailValue(logEvidence.noCurrentWrapperEvidence)}`);
    }
    lines.push(`- configuredWrapper current=${formatCheckDetailValue(summary.observed?.currentConfiguredWrapper?.codegraphTarget)} context=${formatCheckDetailValue(summary.observed?.currentConfiguredContextWrapper?.codegraphTarget)}`);
    if (summary.observed?.envMismatchCount > 0) {
      lines.push(`- envMismatches=${summary.observed.envMismatchCount} ${formatEnvMismatches(summary.observed.envMismatches)}`);
    }
    if (summary.observed?.liveProcessMismatchCount > 0) {
      const processText = summary.observed.liveProcessMismatches
        .map(processInfo => `pid=${processInfo.pid} target=${processInfo.observedCodegraphTarget ?? '<unknown>'}`)
        .join('; ');
      lines.push(`- liveProcessMismatches=${summary.observed.liveProcessMismatchCount} ${processText}`);
    }
    if (summary.observed?.autoSyncDisabled?.textTail) {
      lines.push(`- autoSyncDisabledTail=${formatCheckDetailValue(summary.observed.autoSyncDisabled.textTail)}`);
    }
    if (summary.observed?.activeAutoSyncDisabledCount > 0) {
      const allRuns = summary.observed.activeAutoSyncDisabledRuns ?? [];
      const visibleRuns = allRuns.slice(0, 5);
      const hiddenRunCount = Math.max(0, allRuns.length - visibleRuns.length);
      const runs = visibleRuns
        .map(run => `runId=${run.runId} pid=${run.pid ?? '<unknown>'} target=${run.codegraphTarget ?? '<unknown>'}`)
        .join('; ');
      const suffix = hiddenRunCount > 0 ? `; +${hiddenRunCount} more` : '';
      lines.push(`- activeAutoSyncDisabled=${summary.observed.activeAutoSyncDisabledCount} ${runs}${suffix}`);
    }
    lines.push(`- fallback=${summary.fallback}`);
  }
  if (report.mcpConfig.recommendation) {
    lines.push('MCP config/tool discovery note:');
    for (const recommendation of report.mcpConfig.recommendation) {
      lines.push(`- ${recommendation}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatCheckDetails(check) {
  if (check.ok) {
    return '';
  }
  const details = [];
  if (Object.prototype.hasOwnProperty.call(check, 'expected')) {
    details.push(`expected=${formatCheckDetailValue(check.expected)}`);
  }
  if (Object.prototype.hasOwnProperty.call(check, 'actual')) {
    details.push(`actual=${formatCheckDetailValue(check.actual)}`);
  }
  return details.length > 0 ? ` ${details.join(' ')}` : '';
}

function formatCheckDetailValue(value) {
  if (value === null || typeof value === 'undefined') {
    return '<missing>';
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatCheckDetailValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatEnvMismatches(mismatches) {
  return (Array.isArray(mismatches) ? mismatches : [])
    .map(mismatch => [
      `${mismatch.scope}.${mismatch.key}`,
      `expected=${formatCheckDetailValue(mismatch.expected)}`,
      `actual=${formatCheckDetailValue(mismatch.actual)}`,
    ].join(' '))
    .join('; ');
}

function wrapperConfigMatches(envMatches, targetMatches) {
  if (envMatches === false || targetMatches === false) return false;
  if (envMatches === true && targetMatches === true) return true;
  return null;
}

function formatHostMcpFreshness(value, supersededByFreshWrapper = false, configMatches = null) {
  if (supersededByFreshWrapper) return 'unknown-after-fresh-wrapper';
  if (value === true) return configMatches === false ? 'fresh-config-mismatch' : 'fresh';
  if (value === false) return configMatches === false ? 'stale-config-mismatch' : 'stale';
  return 'unknown';
}

function formatOptionalPresent(value) {
  if (value === true) return 'present';
  if (value === false) return 'missing';
  return 'unknown';
}

function executeStaleWrapperCleanup(report, args) {
  const plan = report.hostMcp?.staleWrapperCleanup ?? {
    minIdleMs: args.cleanupMinIdleMs,
    candidates: [],
    skipped: [],
  };
  const requestedRunIds = [...new Set(args.cleanupRunIds)];
  const requestedRunIdSet = new Set(requestedRunIds);
  const candidates = requestedRunIds.length > 0
    ? plan.candidates.filter(candidate => requestedRunIdSet.has(candidate.runId))
    : plan.candidates;
  const missingRunIds = requestedRunIds.filter(runId => (
    !plan.candidates.some(candidate => candidate.runId === runId)
  ));
  const result = {
    ok: missingRunIds.length === 0,
    command: 'cleanup-stale-wrappers',
    apply: args.applyCleanup,
    root: report.root,
    doctorOk: report.ok,
    minIdleMs: plan.minIdleMs,
    observedAt: plan.observedAt,
    liveWrapperCount: plan.liveWrapperCount,
    requestedRunIds,
    missingRunIds,
    candidates,
    skipped: plan.skipped,
    results: [],
    safety: {
      defaultMode: 'dry-run',
      requiresIdle: true,
      requiresStaleEvidence: true,
      requiresExplicitRunIdForTargetedApply: false,
      neverTargetsCodexParent: true,
      liveProcessSource: report.hostMcp?.liveProcesses?.source ?? null,
    },
  };
  if (!args.applyCleanup || !result.ok) {
    return result;
  }
  if (report.hostMcp?.liveProcesses?.source === 'env') {
    result.ok = false;
    result.results.push({
      ok: false,
      reason: 'apply-refused-for-synthetic-process-list',
    });
    return result;
  }

  const freshProcessList = readLiveProcessList();
  for (const candidate of candidates) {
    const processInfo = (freshProcessList.processes ?? [])
      .find(entry => Number(entry.pid) === Number(candidate.pid));
    if (!processInfo) {
      result.results.push({
        ok: true,
        pid: candidate.pid,
        runId: candidate.runId,
        reason: 'already-exited',
      });
      continue;
    }
    if (
      candidate.startedAt
      && processInfo.startedAt
      && candidate.startedAt !== processInfo.startedAt
    ) {
      result.results.push({
        ok: false,
        pid: candidate.pid,
        runId: candidate.runId,
        reason: 'pid-reused-since-plan',
        expectedStartedAt: candidate.startedAt,
        actualStartedAt: processInfo.startedAt,
      });
      continue;
    }
    result.results.push({
      runId: candidate.runId,
      ...terminateWrapperProcessTree(
        processInfo,
        path.join(report.root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
        candidate.codegraphTarget ?? report.mcpConfig?.codegraphTarget ?? REQUIRED_CODEGRAPH_TARGET,
      ),
    });
  }
  result.ok = result.results.every(entry => entry.ok);
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configRepair = args.repairConfig
    ? repairCodexCodegraphMcpConfig(args.root, {
        codegraphTarget: REQUIRED_CODEGRAPH_TARGET,
        requiredEnv: Object.fromEntries(REQUIRED_CODEX_MCP_ENV),
      })
    : null;
  const report = buildReport(args.root, {
    strict: args.strict,
    phase: args.phase,
    directMcpError: args.directMcpError,
    observedAt: args.observedAt,
    cleanupMinIdleMs: args.cleanupMinIdleMs,
  });
  if (args.cleanupStaleWrappers) {
    const cleanup = executeStaleWrapperCleanup(report, args);
    process.stdout.write(`${JSON.stringify(cleanup, null, 2)}\n`);
    process.exit(cleanup.ok ? 0 : 1);
  }
  const directMcpIncident = persistDirectMcpIncidentReport(report, {
    directMcpError: args.directMcpError,
    observedAt: args.observedAt,
  });
  if (directMcpIncident) {
    report.hostMcp.directMcpIncident = directMcpIncident;
  }
  applyConfigRepairRuntimeState(report, configRepair);
  process.stdout.write(args.explain ? formatExplain(report) : `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main();
