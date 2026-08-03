#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isNodeCommand, readCodexCodegraphMcpConfig } = require('./codegraph-codex-config.cjs');
const {
  parseNanoFlowContextOutcomeV1,
} = require('./lib/codegraph-context-outcome.cjs');

const DEFAULT_CODEGRAPH_TARGET = '@colbymchenry/codegraph@1.5.0';
const DEFAULT_QUERY = 'ProjectShellComponent';
const DEFAULT_OVERLAY_QUERY = 'sync-rule-keyword';
const DEFAULT_TIMEOUT_MS = 60_000;
const WRAPPER_TIMEOUT_HEADROOM_MIN_MS = 1_000;
const WRAPPER_TIMEOUT_HEADROOM_MAX_MS = 5_000;

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    codegraphTarget: null,
    query: DEFAULT_QUERY,
    overlayQuery: DEFAULT_OVERLAY_QUERY,
    overlayLimit: 1,
    overlayQueryLimit: 40,
    repeat: 1,
    roundDelayMs: 0,
    simulateStaleWrapperScript: false,
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
    else if (arg === '--repeat') parsed.repeat = parsePositiveInteger(next(), arg);
    else if (arg === '--round-delay-ms') parsed.roundDelayMs = parseNonNegativeInteger(next(), arg);
    else if (arg === '--simulate-stale-wrapper-script') parsed.simulateStaleWrapperScript = true;
    else if (arg === '--timeout-ms') parsed.timeoutMs = parsePositiveInteger(next(), arg);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.root = path.resolve(parsed.root);
  return parsed;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
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

function deriveWrapperRequestTimeoutMs(timeoutMs) {
  const headroomMs = Math.min(
    WRAPPER_TIMEOUT_HEADROOM_MAX_MS,
    Math.max(WRAPPER_TIMEOUT_HEADROOM_MIN_MS, Math.floor(timeoutMs * 0.1)),
  );
  return Math.max(1, timeoutMs - headroomMs);
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/smoke-codegraph-mcp-wrapper.cjs [options]',
    '',
    'Options:',
    '  --root <path>                 Project root. Defaults to cwd.',
    '  --codegraph-target <target>   CodeGraph package spec or local fake script.',
    '  --query <query>               Context-pack query.',
    '  --overlay-query <query>       Overlay query.',
    '  --overlay-limit <n>           Context-pack overlay limit.',
    '  --overlay-query-limit <n>     Overlay query limit.',
    '  --repeat <n>                  Repeat context/overlay/tools-list checks in the same wrapper process.',
    '  --round-delay-ms <n>          Delay between repeat rounds to verify long-lived idle wrapper continuity.',
    '  --simulate-stale-wrapper-script  Mutate a temporary wrapper copy after startup; verify current NanoFlow response success plus stale-wrapper recycle diagnostics.',
    '  --timeout-ms <n>              Per-request timeout.',
    '',
  ].join('\n'));
}

function resolveWrapperInvocation(options) {
  if (options.codegraphTarget) {
    return {
      wrapperScriptPath: path.join(options.root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
      codegraphTarget: options.codegraphTarget,
      codegraphArgs: ['serve', '--mcp', '--path', options.root],
      configEnv: {},
    };
  }

  const codexConfig = readCodexCodegraphMcpConfig(options.root);
  if (process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG && !codexConfig.exists) {
    throw new Error(`Codex MCP config not found: ${codexConfig.path}`);
  }
  if (codexConfig.parseError && process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG) {
    throw new Error(`Unsupported Codex MCP config in ${codexConfig.path}: ${codexConfig.parseError}`);
  }
  if (codexConfig.server && (codexConfig.appliesToRoot || process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG)) {
    const args = Array.isArray(codexConfig.server.args) ? codexConfig.server.args : [];
    if (!isNodeCommand(codexConfig.server.command) || args.length < 2) {
      throw new Error(`Unsupported Codex MCP config in ${codexConfig.path}`);
    }
    return {
      wrapperScriptPath: replaceWorkspaceFolder(args[0], options.root),
      codegraphTarget: replaceWorkspaceFolder(args[1], options.root),
      codegraphArgs: args.slice(2).map(arg => replaceWorkspaceFolder(arg, options.root)),
      configEnv: resolveConfigEnv(codexConfig.server.env ?? {}),
    };
  }

  return {
    wrapperScriptPath: path.join(options.root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
    codegraphTarget: DEFAULT_CODEGRAPH_TARGET,
    codegraphArgs: ['serve', '--mcp', '--path', options.root],
    configEnv: {},
  };
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
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${label}. logPath=${options.logPath ?? 'n/a'} stderrTail=${stderr}`));
      }, timeoutMs);
      let waiter;

      const cleanup = () => {
        clearTimeout(timer);
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          waiters.splice(waiterIndex, 1);
        }
      };

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

  return {
    request,
    stderrTail: () => stderr,
    pendingWaiterCount: () => waiters.length,
  };
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

async function runMcpClientTimeoutSelfTest() {
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    stdin: { write() {} },
  };
  const client = createMcpClient(child, 1);
  try {
    await client.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'self-test timeout');
  } catch {
    // Expected timeout.
  }
  process.stdout.write(`${JSON.stringify({ pendingWaiters: client.pendingWaiterCount() })}\n`);
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

function assertEmptyResourceDiscovery(response, label, resultKey) {
  const resources = response?.result?.[resultKey];
  if (!Array.isArray(resources) || resources.length !== 0) {
    throw new Error(`${label} did not return an empty ${resultKey} array`);
  }
}

function assertToolTextResponse(response, label, { allowIsError = false } = {}) {
  if (response?.result?.isError && !allowIsError) {
    throw new Error(`${label} returned MCP isError: ${response.result.content?.[0]?.text ?? ''}`);
  }
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`${label} returned no text content`);
  }
  return text;
}

function assertCanonicalContextOutcome(response, label) {
  const outcome = parseNanoFlowContextOutcomeV1(response?.result?.structuredContent?.outcome);
  if (!outcome) {
    throw new Error(`${label} returned no canonical NanoFlow context outcome`);
  }
  const isError = Boolean(response?.result?.isError);
  if (isError !== (outcome.status !== 'complete')) {
    throw new Error(
      `${label} returned MCP isError=${isError} for ${outcome.status} NanoFlow context outcome`,
    );
  }
  return outcome;
}

function hasNativeExplorationHeading(text, query) {
  const escapedQuery = escapeRegExp(String(query ?? '').trim());
  if (!escapedQuery) return false;
  return new RegExp(`(^|\\n)(?:##\\s+Exploration:\\s+${escapedQuery}\\b|\\*\\*Exploration:\\s+${escapedQuery}\\*\\*)`, 'i')
    .test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertToolErrorTextResponse(response, label, expectedText) {
  if (!response?.result?.isError) {
    throw new Error(`${label} did not return MCP isError`);
  }
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`${label} returned no error text content`);
  }
  if (!text.includes(expectedText)) {
    throw new Error(`${label} error text did not include ${JSON.stringify(expectedText)}: ${text}`);
  }
  return text;
}

function analyzeLog(root, logPath) {
  const analyzerPath = path.join(root, 'scripts', 'analyze-codegraph-mcp-log.cjs');
  const result = spawnSync(
    process.execPath,
    [analyzerPath, logPath, '--json', '--fail-on-critical'],
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

function latestWrapperExitAnalysis(logAnalysis) {
  return logAnalysis?.wrapperExit?.latest ?? logAnalysis?.wrapperExit ?? null;
}

function readLogEvents(logPath) {
  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function verifyStaleWrapperAnalysis(logAnalysis, logPath, contextOutcome) {
  const failures = [];
  if (logAnalysis?.transportHealthy !== true) {
    failures.push('transportHealthy is not true');
  }
  if (Number(logAnalysis?.criticalTransportFailures ?? 0) !== 0) {
    failures.push(`criticalTransportFailures is ${logAnalysis?.criticalTransportFailures}`);
  }
  if (logAnalysis?.currentWrapper?.matchesDisk !== false) {
    failures.push('currentWrapper.matchesDisk is not false');
  }
  if (logAnalysis?.currentContextWrapper?.matchesDisk !== false) {
    failures.push('currentContextWrapper.matchesDisk is not false');
  }
  const logText = fs.readFileSync(logPath, 'utf8');
  if (!logText.includes('"event":"wrapper.script.stale"')) {
    failures.push('wrapper.script.stale log event is missing');
  }
  if (!logText.includes('"event":"wrapper.script.stale.continue"')) {
    failures.push('wrapper.script.stale.continue log event is missing');
  }
  if (!logText.includes('"event":"wrapper.script.stale.recycle.request"')) {
    failures.push('wrapper.script.stale.recycle.request log event is missing');
  }
  if (!logText.includes('"event":"wrapper.shutdown.stale-wrapper-script"')) {
    failures.push('wrapper.shutdown.stale-wrapper-script log event is missing');
  }
  const wrapperExit = latestWrapperExitAnalysis(logAnalysis);
  if (wrapperExit?.failureClass !== 'stale-wrapper-script') {
    failures.push(`wrapperExit.failureClass is ${wrapperExit?.failureClass}`);
  }
  if (wrapperExit?.expectedExit !== true) {
    failures.push(`wrapperExit.expectedExit is ${wrapperExit?.expectedExit}`);
  }
  const events = readLogEvents(logPath);
  const recycleRequest = events.find(event => event.event === 'wrapper.script.stale.recycle.request');
  const staleShutdown = events.find(event => event.event === 'wrapper.shutdown.stale-wrapper-script');
  const contextResponse = events.find(event => (
    event.event === 'client.response'
    && event.requestKind === 'nanoflow-context-pack'
    && event.failureClass === contextOutcome?.primaryFailureClass
    && event.isError === true
  ));
  if (contextOutcome?.status !== 'partial' || contextOutcome?.usableContext !== true) {
    failures.push(`stale context outcome is ${contextOutcome?.status}/${contextOutcome?.usableContext}`);
  }
  const recycleGraceMs = Number(recycleRequest?.recycleGraceMs ?? 0);
  if (recycleGraceMs < 1000) {
    failures.push(`wrapper.script.stale.recycle.request recycleGraceMs is ${recycleRequest?.recycleGraceMs}`);
  }
  if (!contextResponse) {
    failures.push('strict-partial nanoflow_context_pack client.response is missing before stale shutdown');
  }
  if (!staleShutdown) {
    failures.push('wrapper.shutdown.stale-wrapper-script parsed event is missing');
  }
  if (contextResponse && staleShutdown) {
    const responseTs = Date.parse(contextResponse.ts);
    const shutdownTs = Date.parse(staleShutdown.ts);
    if (Number.isFinite(responseTs) && Number.isFinite(shutdownTs) && shutdownTs < responseTs) {
      failures.push('stale wrapper shutdown happened before nanoflow_context_pack response was logged');
    }
  }
  const shutdownOutputAgeMs = Number(staleShutdown?.lastClientOutputAgeMs ?? 0);
  if (recycleGraceMs > 0 && shutdownOutputAgeMs < Math.max(250, recycleGraceMs - 100)) {
    failures.push(`stale wrapper shutdown lastClientOutputAgeMs ${staleShutdown?.lastClientOutputAgeMs} is too close to the response write for recycleGraceMs ${recycleGraceMs}`);
  }

  if (failures.length > 0) {
    throw new Error([
      'Simulated stale wrapper smoke did not produce the required stale diagnostics.',
      ...failures.map(failure => `- ${failure}`),
    ].join('\n'));
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function shutdownChildProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
  } catch {
    // Fall through to process termination below.
  }

  if (await waitForExit(child, timeoutMs)) {
    return;
  }

  child.kill();
  if (await waitForExit(child, timeoutMs)) {
    return;
  }

  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    await waitForExit(child, 1_000);
  }
}

async function main() {
  if (process.env.NANOFLOW_MCP_SMOKE_SELF_TEST_TIMEOUT_CLEANUP === '1') {
    await runMcpClientTimeoutSelfTest();
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const invocation = resolveWrapperInvocation(options);
  const explicitLogPath = process.env.NANOFLOW_CODEGRAPH_MCP_LOG
    ? path.resolve(process.env.NANOFLOW_CODEGRAPH_MCP_LOG)
    : null;
  const logRoot = explicitLogPath
    ? path.dirname(explicitLogPath)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-mcp-smoke-'));
  fs.mkdirSync(logRoot, { recursive: true });
  const logPath = explicitLogPath ?? path.join(logRoot, 'wrapper.log');
  if (explicitLogPath) {
    fs.rmSync(explicitLogPath, { force: true });
  }
  if (options.simulateStaleWrapperScript) {
    const temporaryWrapperScriptPath = path.join(logRoot, 'codegraph-nanoflow-mcp-stdio.cjs');
    fs.copyFileSync(invocation.wrapperScriptPath, temporaryWrapperScriptPath);
    fs.copyFileSync(
      path.join(path.dirname(invocation.wrapperScriptPath), 'codegraph-nanoflow-dedup-query.cjs'),
      path.join(logRoot, 'codegraph-nanoflow-dedup-query.cjs'),
    );
    fs.copyFileSync(
      path.join(path.dirname(invocation.wrapperScriptPath), 'codegraph-nanoflow-specialized-query.cjs'),
      path.join(logRoot, 'codegraph-nanoflow-specialized-query.cjs'),
    );
    const libraryRoot = path.join(logRoot, 'lib');
    fs.mkdirSync(libraryRoot, { recursive: true });
    fs.copyFileSync(
      path.join(path.dirname(invocation.wrapperScriptPath), 'lib', 'codegraph-context-outcome.cjs'),
      path.join(libraryRoot, 'codegraph-context-outcome.cjs'),
    );
    invocation.wrapperScriptPath = temporaryWrapperScriptPath;
  }
  const wrapperRequestTimeoutMs = deriveWrapperRequestTimeoutMs(options.timeoutMs);
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
        NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE: 'smoke',
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: String(wrapperRequestTimeoutMs),
        NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: String(wrapperRequestTimeoutMs),
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: options.simulateStaleWrapperScript ? '1' : '0',
      },
      windowsHide: true,
    },
  );
  const client = createMcpClient(child, options.timeoutMs, { logPath });
  const steps = [];
  let nextRequestId = 1;
  let contextText = '';
  let contextOutcome = null;
  let overlayMatchCount = 0;
  let totalContextTextBytes = 0;
  let totalOverlayMatchCount = 0;
  let staleWrapperRecycled = false;

  const nextId = () => nextRequestId++;
  const repeatSuffix = round => options.repeat === 1 ? '' : `:${round}`;

  try {
    const firstTools = await client.request(
      { jsonrpc: '2.0', id: nextId(), method: 'tools/list' },
      'first tools/list',
    );
    assertToolsList(firstTools, 'first tools/list');
    steps.push('tools/list:first');
    if (options.simulateStaleWrapperScript) {
      fs.appendFileSync(
        invocation.wrapperScriptPath,
        `\n// simulated stale wrapper script after startup ${Date.now()}\n`,
      );
      steps.push('wrapper-script:stale-on-disk');
    }

    const resources = await client.request(
      { jsonrpc: '2.0', id: nextId(), method: 'resources/list', params: {} },
      'resources/list',
    );
    assertEmptyResourceDiscovery(resources, 'resources/list', 'resources');
    steps.push('resources/list');

    const resourceTemplates = await client.request(
      { jsonrpc: '2.0', id: nextId(), method: 'resources/templates/list', params: {} },
      'resources/templates/list',
    );
    assertEmptyResourceDiscovery(resourceTemplates, 'resources/templates/list', 'resourceTemplates');
    steps.push('resources/templates/list');

    for (let round = 1; round <= options.repeat; round += 1) {
      const contextResponse = await client.request({
        jsonrpc: '2.0',
        id: nextId(),
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: options.query, overlayLimit: options.overlayLimit },
        },
      }, `nanoflow_context_pack round ${round}`);
      contextOutcome = assertCanonicalContextOutcome(
        contextResponse,
        `nanoflow_context_pack round ${round}`,
      );
      contextText = assertToolTextResponse(
        contextResponse,
        `nanoflow_context_pack round ${round}`,
        {
          allowIsError: contextOutcome.status === 'partial'
            && contextOutcome.usableContext === true,
        },
      );
      if (!hasNativeExplorationHeading(contextText, options.query)) {
        throw new Error(`nanoflow_context_pack round ${round} response is missing the expected native Exploration heading`);
      }
      totalContextTextBytes += Buffer.byteLength(contextText, 'utf8');
      steps.push(`nanoflow_context_pack${repeatSuffix(round)}`);

      if (options.simulateStaleWrapperScript) {
        const staleExit = await waitForExit(child, 5_000);
        if (!staleExit || staleExit.code !== 0 || staleExit.signal !== null) {
          throw new Error(`stale wrapper did not recycle cleanly after nanoflow_context_pack: ${JSON.stringify(staleExit)}`);
        }
        staleWrapperRecycled = true;
        steps.push('wrapper-script:stale-recycled');
        break;
      }

      const overlayResponse = await client.request({
        jsonrpc: '2.0',
        id: nextId(),
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: options.overlayQuery, limit: options.overlayQueryLimit, json: true },
        },
      }, `nanoflow_overlay_query round ${round}`);
      const overlayText = assertToolTextResponse(overlayResponse, `nanoflow_overlay_query round ${round}`);
      const overlayJson = JSON.parse(overlayText);
      if (!Array.isArray(overlayJson.matches)) {
        throw new Error(`nanoflow_overlay_query round ${round} JSON response is missing matches`);
      }
      overlayMatchCount = overlayJson.matches.length;
      totalOverlayMatchCount += overlayMatchCount;
      steps.push(`nanoflow_overlay_query${repeatSuffix(round)}`);

      const toolsLabel = options.repeat === 1 ? 'second tools/list' : `tools/list after round ${round}`;
      const toolsStep = options.repeat === 1 ? 'tools/list:second' : `tools/list:after-${round}`;
      const toolsResponse = await client.request(
        { jsonrpc: '2.0', id: nextId(), method: 'tools/list' },
        toolsLabel,
      );
      assertToolsList(toolsResponse, toolsLabel);
      steps.push(toolsStep);

      if (options.roundDelayMs > 0 && round < options.repeat) {
        await sleep(options.roundDelayMs);
        steps.push(`round-delay:${round}`);
      }
    }

    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    const wrapperShutdown = await waitForExit(child, 5_000);
    if (wrapperShutdown?.code !== 0 || wrapperShutdown.signal !== null) {
      throw new Error(`wrapper-shutdown-failure exitCode=${wrapperShutdown === null ? 'timeout' : wrapperShutdown.code} signal=${wrapperShutdown?.signal ?? 'none'}`);
    }
    const logAnalysis = analyzeLog(options.root, logPath);
    const staleWrapperVerified = options.simulateStaleWrapperScript;
    const wrapperExit = latestWrapperExitAnalysis(logAnalysis);
    if (options.simulateStaleWrapperScript) {
      verifyStaleWrapperAnalysis(logAnalysis, logPath, contextOutcome);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      steps,
      logPath,
      wrapperScriptPath: invocation.wrapperScriptPath,
      codegraphTarget: invocation.codegraphTarget,
      repeat: options.repeat,
      roundDelayMs: options.roundDelayMs,
      timeoutMs: options.timeoutMs,
      wrapperRequestTimeoutMs,
      simulateStaleWrapperScript: options.simulateStaleWrapperScript,
      staleWrapperVerified,
      staleWrapperRecycled,
      contextOutcome,
      contextTextBytes: Buffer.byteLength(contextText, 'utf8'),
      totalContextTextBytes,
      overlayMatchCount,
      totalOverlayMatchCount,
      logAnalysis: {
        transportHealthy: logAnalysis.transportHealthy,
        criticalTransportFailures: logAnalysis.criticalTransportFailures,
        overlayTimeouts: logAnalysis.overlayTimeouts,
        wrapperExit,
        currentWrapper: logAnalysis.currentWrapper,
        currentContextWrapper: logAnalysis.currentContextWrapper,
        activeWrappers: logAnalysis.activeWrappers,
      },
    }, null, 2)}\n`);
  } catch (error) {
    await shutdownChildProcess(child);
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
