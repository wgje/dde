import path from 'node:path';
import { expect } from 'vitest';

type LogEntry = Record<string, unknown>;

interface WrapperDiagnosticsOptions {
  logPath: string;
  repoRoot: string;
  wrapperScriptPath: string;
}

export function assertWrapperDiagnosticsLog(
  logEntries: LogEntry[],
  options: WrapperDiagnosticsOptions,
): void {
  assertRequiredDiagnosticEvents(logEntries);
  assertBaseDiagnosticEnvelope(logEntries, options);
  const requestId = assertOverlayRequestStart(logEntries);
  const queryId = assertOverlayQueryStart(logEntries, requestId, options.repoRoot);
  assertOverlayQuerySpawn(logEntries, requestId, queryId);
  assertOverlayQueryExit(logEntries, requestId, queryId);
  assertOverlayResponses(logEntries, requestId, queryId);
}

function assertRequiredDiagnosticEvents(logEntries: LogEntry[]): void {
  const events = logEntries.map((entry) => entry.event);
  [
    'wrapper.start',
    'overlay.refresh.skip',
    'client.stdin.chunk',
    'client.mode.detected',
    'child.stdout.chunk',
    'tools.list.augmented',
    'nanoflow.overlay.handle',
    'overlay.query.start',
    'overlay.query.spawn',
    'overlay.query.exit',
  ].forEach((event) => expect(events).toContain(event));
}

function assertBaseDiagnosticEnvelope(
  logEntries: LogEntry[],
  { logPath, wrapperScriptPath }: WrapperDiagnosticsOptions,
): void {
  expect(logEntries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      seq: expect.any(Number),
      sinceStartMs: expect.any(Number),
      wrapperPid: expect.any(Number),
    }),
  ]));
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'wrapper.start',
    diagnosticSchemaVersion: 2,
    logPath,
    wrapperVersion: expect.any(String),
    scriptPath: wrapperScriptPath,
    scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    outputModes: expect.objectContaining({
      overlayTool: 'markdown',
      contextOverlayQuery: 'json',
      contextOverlayQueryCompact: 'context-json',
      nativeJson: 'native-json',
      nativeMarkdown: 'native-markdown',
      contextPack: 'markdown',
    }),
    env: expect.objectContaining({ NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0' }),
    refreshOnStartup: false,
  }));
  assertTransportEnvelope(logEntries);
}

function assertTransportEnvelope(logEntries: LogEntry[]): void {
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'overlay.refresh.skip',
    reason: 'disabled-by-env',
  }));
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'client.stdin.chunk',
    bytes: expect.any(Number),
    bufferedStdinBytes: expect.any(Number),
    modeBefore: null,
    runtime: expect.objectContaining({
      childPid: expect.any(Number),
      clientMode: null,
    }),
  }));
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'child.stdout.chunk',
    pid: expect.any(Number),
    bytes: expect.any(Number),
    bufferedChildStdoutBytes: expect.any(Number),
    runtime: expect.objectContaining({ childPid: expect.any(Number) }),
  }));
}

function assertOverlayRequestStart(logEntries: LogEntry[]): unknown {
  const requestStartEntry = logEntries.find((entry) =>
    entry.event === 'client.request.start'
    && entry.id === 12
    && entry.tool === 'nanoflow_overlay_query');
  expect(requestStartEntry).toEqual(expect.objectContaining({
    requestId: expect.any(String),
    requestKind: 'nanoflow-overlay',
    query: 'ProjectShellComponent',
    mode: 'newline',
    runtime: expect.objectContaining({
      childPid: expect.any(Number),
      clientMode: 'newline',
      activeRequestCount: expect.any(Number),
    }),
  }));
  const requestId = requestStartEntry?.requestId;
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'nanoflow.overlay.handle',
    requestId,
    id: 12,
    query: 'ProjectShellComponent',
  }));
  return requestId;
}

function assertOverlayQueryStart(
  logEntries: LogEntry[],
  requestId: unknown,
  repoRoot: string,
): unknown {
  const startEntry = logEntries.find((entry) => entry.event === 'overlay.query.start');
  expect(startEntry).toEqual(expect.objectContaining({
    requestId,
    requestKind: 'nanoflow-overlay',
    clientId: 12,
    queryId: expect.any(String),
    startedAtMs: expect.any(Number),
    json: false,
    outputMode: 'markdown',
    runtime: expect.objectContaining({
      childPid: expect.any(Number),
      activeRequestCount: expect.any(Number),
    }),
    overlayFile: expect.objectContaining({
      path: path.join(repoRoot, '.codegraph', 'nanoflow-overlay.json'),
      relativePath: '.codegraph/nanoflow-overlay.json',
      exists: true,
      bytes: expect.any(Number),
      mtimeMs: expect.any(Number),
      ageMs: expect.any(Number),
    }),
  }));
  return startEntry?.queryId;
}

function assertOverlayQuerySpawn(
  logEntries: LogEntry[],
  requestId: unknown,
  queryId: unknown,
): void {
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'overlay.query.spawn',
    requestId,
    queryId,
    pid: expect.any(Number),
    env: expect.objectContaining({
      NANOFLOW_OVERLAY_QUERY_PROFILE: '1',
      NANOFLOW_OVERLAY_SKIP_REFRESH: '1',
    }),
  }));
}

function assertOverlayQueryExit(
  logEntries: LogEntry[],
  requestId: unknown,
  queryId: unknown,
): void {
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'overlay.query.exit',
    requestId,
    queryId,
    pid: expect.any(Number),
    status: 0,
    signal: null,
    failureClass: 'success',
    elapsedMs: expect.any(Number),
    stdoutStartsWithJson: false,
    stdoutLineCount: expect.any(Number),
    stderrLineCount: expect.any(Number),
    stdoutBytes: expect.any(Number),
    stderr: expect.stringContaining('nanoflow.overlay.profile'),
    investigation: expect.objectContaining({
      failureBoundary: 'overlay-subprocess',
      transportShouldStayAlive: true,
    }),
    profileMeta: expect.objectContaining({
      query: 'ProjectShellComponent',
      skipRefresh: true,
    }),
    profilePhases: expect.arrayContaining([
      expect.objectContaining({ phase: 'readOverlayFile', elapsedMs: expect.any(Number) }),
      expect.objectContaining({ phase: 'parseOverlayJson', elapsedMs: expect.any(Number) }),
    ]),
    lastProfilePhase: expect.objectContaining({
      phase: expect.any(String),
      elapsedMs: expect.any(Number),
    }),
  }));
}

function assertOverlayResponses(
  logEntries: LogEntry[],
  requestId: unknown,
  queryId: unknown,
): void {
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'nanoflow.overlay.response',
    requestId,
    id: 12,
    queryId,
    failureClass: 'success',
    isError: false,
    resultStats: expect.objectContaining({
      outputFormat: 'markdown',
      nativeJson: false,
      nativeMarkdown: false,
      parsedJson: false,
      textBytes: expect.any(Number),
      sourceSectionCount: expect.any(Number),
      sourceBlockCount: expect.any(Number),
      hasRelationshipsSection: expect.any(Boolean),
      truncated: expect.any(Boolean),
    }),
    runtime: expect.objectContaining({ activeRequestCount: expect.any(Number) }),
  }));
  expect(logEntries).toContainEqual(expect.objectContaining({
    event: 'client.response',
    requestId,
    id: 12,
    method: 'tools/call',
    tool: 'nanoflow_overlay_query',
    query: 'ProjectShellComponent',
    isError: false,
    failureClass: 'success',
    runtime: expect.objectContaining({
      childPid: expect.any(Number),
      activeRequestCount: expect.any(Number),
    }),
  }));
}
