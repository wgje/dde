import type { ChildProcessWithoutNullStreams, SpawnSyncReturns } from 'node:child_process';

export type OverlaySpawnResult = SpawnSyncReturns<string>;

export interface CodegraphOverlaySpecContext {
  repoRoot: string;
  scriptPath: string;
  queryScriptPath: string;
  wrapperScriptPath: string;
  codexConfigHelperPath: string;
  adapterContextScriptPath: string;
  adapterDoctorScriptPath: string;
  mcpSmokeScriptPath: string;
  adaptationDocPath: string;
  WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS: number;
  WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS: number;
  WRAPPER_REPO_OVERLAY_ENV: Record<string, string>;
  tempRoots: string[];
  officialCodeGraphLanguages: Set<string>;
  officialCodeGraphNodeKinds: Set<string>;
  writeFile(root: string, relativePath: string, content: string): void;
  makeFixture(): string;
  makeFreshMcpFixture(): string;
  runOverlay(root: string, args?: string[]): OverlaySpawnResult;
  queryOverlay(root: string, query: string, args?: string[] | number): OverlaySpawnResult;
  expectSpawnSuccess(result: OverlaySpawnResult): void;
  makeFakeCodegraph(): string;
  makeContentLengthFakeCodegraph(): string;
  makeSlowFakeCodegraph(): string;
  makeExitingToolsListFakeCodegraph(): string;
  makeReplayBackpressureFakeCodegraph(): string;
  makeHangingExploreFakeCodegraph(): string;
  makeDelayedExploreFakeCodegraph(): string;
  makeBlockedInputFakeCodegraph(): string;
  makeMalformedContentFakeCodegraph(): string;
  parseJsonLines(filePath: string): Array<Record<string, unknown>>;
  parseJsonLinesFromText(text: string): Array<Record<string, unknown>>;
  waitForLogEvent(
    logPath: string,
    eventName: string,
    timeoutMs?: number,
    predicate?: (entry: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readJsonLine(child: ChildProcessWithoutNullStreams, timeoutMs?: number): Promise<unknown>;
  writeMcpFrame(child: ChildProcessWithoutNullStreams, message: unknown): void;
  writeManyJsonLines(
    child: ChildProcessWithoutNullStreams,
    messages: unknown[],
    stopSignal: Promise<unknown>,
  ): Promise<void>;
  readMcpFrame(child: ChildProcessWithoutNullStreams): Promise<unknown>;
}
