import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextSourceRankingPromotionSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('promotes an explicitly named service above sync-rule helper and migration noise', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-explicit-service-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/sync/task-sync-push.service.ts',
      [
        'export class TaskSyncPushService {',
        '  async pushTask(): Promise<void> {',
        '    await this.executeTaskPush();',
        '  }',
        '',
        '  private async executeTaskPush(): Promise<void> {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts',
      [
        'export interface TaskSyncOperationsRpcUpsertSpecContext {',
        '  getUpsertPayload(): unknown;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'supabase/migrations/20260509145500_sync_rpc_lww_upsert_semantics.sql',
      [
        'create or replace function public.sync_upsert_task(payload jsonb)',
        'returns jsonb',
        'language plpgsql',
        'as $$',
        'begin',
        '  return payload;',
        'end;',
        '$$;',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'TaskSyncOperationsService 本身只是转发。我要直接看 TaskSyncPushService，确认 RPC 被拒绝或不可用时是否会直接落到 table upsert，还是进入 RetryQueue。',",
        '  matches: [{',
        '    kind: "interface",',
        '    name: "TaskSyncOperationsRpcUpsertSpecContext",',
        '    file: "src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts"',
        '  }, {',
        '    kind: "function",',
        '    name: "public.sync_upsert_task",',
        '    file: "supabase/migrations/20260509145500_sync_rpc_lww_upsert_semantics.sql"',
        '  }],',
        '  nodes: [{',
        '    id: "interface:src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts:TaskSyncOperationsRpcUpsertSpecContext",',
        '    kind: "interface",',
        '    name: "TaskSyncOperationsRpcUpsertSpecContext",',
        '    qualifiedName: "TaskSyncOperationsRpcUpsertSpecContext",',
        '    filePath: "src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: "function:supabase/migrations/20260509145500_sync_rpc_lww_upsert_semantics.sql:public.sync_upsert_task",',
        '    kind: "function",',
        '    name: "public.sync_upsert_task",',
        '    qualifiedName: "public.sync_upsert_task",',
        '    filePath: "supabase/migrations/20260509145500_sync_rpc_lww_upsert_semantics.sql",',
        '    language: "sql",',
        '    startLine: 1,',
        '    endLine: 8',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 2, graphNodes: 3, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-explicit-service-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-explicit-service-log-')),
      'wrapper.log',
    );
    tempRoots.push(path.dirname(logPath));
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method !== 'tools/call' || message.params?.name !== 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "    return;",
        "  }",
        "  const query = message.params.arguments.query;",
        "  const text = [",
        "    '**Exploration: ' + query + '**',",
        "    '',",
        "    'Found 3 symbols across 3 files.',",
        "    '',",
        "    '**Source Code**',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '**`src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts`** — TaskSyncOperationsRpcUpsertSpecContext(interface)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport interface TaskSyncOperationsRpcUpsertSpecContext {',",
        "    '2\\t  getUpsertPayload(): unknown;',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '**`supabase/migrations/20260509145500_sync_rpc_lww_upsert_semantics.sql`** — public.sync_upsert_task(function)',",
        "    '',",
        "    '```sql',",
        "    '1\\tcreate or replace function public.sync_upsert_task(payload jsonb)',",
        "    '2\\treturns jsonb',",
        "    '```',",
        "    '',",
        "    '**`src/app/core/services/sync/task-sync-push.service.ts`** — TaskSyncPushService(class), pushTask(method)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class TaskSyncPushService {',",
        "    '2\\t  async pushTask(): Promise<void> {',",
        "    '3\\t    await this.executeTaskPush();',",
        "    '4\\t  }',",
        "    '5\\t}',",
        "    '```',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({",
        "    jsonrpc: '2.0',",
        "    id: message.id,",
        "    result: { content: [{ type: 'text', text }] },",
        "  }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'TaskSyncOperationsService 本身只是转发。我要直接看 TaskSyncPushService，确认 RPC 被拒绝或不可用时是否会直接落到 table upsert，还是进入 RetryQueue。',
            overlayLimit: 3,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const serviceIndex = text.indexOf('task-sync-push.service.ts');
      const helperIndex = text.indexOf('task-sync-operations-rpc-upsert.spec-helpers.ts');
      const migrationIndex = text.indexOf('20260509145500_sync_rpc_lww_upsert_semantics.sql');
      expect(serviceIndex).toBeGreaterThanOrEqual(0);
      if (helperIndex >= 0) {
        expect(serviceIndex).toBeLessThan(helperIndex);
      }
      if (migrationIndex >= 0) {
        expect(serviceIndex).toBeLessThan(migrationIndex);
      }

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 51,
      );
      expect(responseEvent).toEqual(expect.objectContaining({
        sourceOrdering: expect.objectContaining({
          topRankedOverlayFile: 'src/app/core/services/sync/task-sync-push.service.ts',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
          topRankedOverlayFileMissing: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('keeps wrapper tooling source first for MCP wrapper maintenance queries with generic diagnostic noise', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-wrapper-maintenance-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/services/task-operation-adapter-warmup.controller.ts',
      [
        'export class TaskOperationAdapterWarmupController {',
        '  captureRuntimeErrorLogging(): void {}',
        '  handleTransportClosedRecovery(): void {}',
        '  runtimeLoggerCaptureDiagnostics(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        'function handleToolCall(message) {',
        '  return message;',
        '}',
        'function writeToCodegraphStdin(text, reason) {',
        '  return Boolean(text && reason);',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/codegraph-adapter-doctor.cjs',
      [
        'function buildDoctorReport() {',
        '  return {};',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'CodeGraph MCP wrapper runtime error logging codegraph-nanoflow-mcp-stdio handleToolCall error capture logger wrapper script stale transport closed adapter doctor diagnostics',",
        '  matches: [{',
        '    kind: "class",',
        '    name: "TaskOperationAdapterWarmupController",',
        '    file: "src/services/task-operation-adapter-warmup.controller.ts"',
        '  }, {',
        '    kind: "method",',
        '    name: "captureRuntimeErrorLogging",',
        '    file: "src/services/task-operation-adapter-warmup.controller.ts"',
        '  }, {',
        '    kind: "function",',
        '    name: "buildDoctorReport",',
        '    file: "scripts/codegraph-adapter-doctor.cjs"',
        '  }, {',
        '    kind: "function",',
        '    name: "handleToolCall",',
        '    file: "scripts/codegraph-nanoflow-mcp-stdio.cjs"',
        '  }],',
        '  nodes: [{',
        '    id: "class:src/services/task-operation-adapter-warmup.controller.ts:TaskOperationAdapterWarmupController",',
        '    kind: "class",',
        '    name: "TaskOperationAdapterWarmupController",',
        '    qualifiedName: "TaskOperationAdapterWarmupController",',
        '    filePath: "src/services/task-operation-adapter-warmup.controller.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 5',
        '  }, {',
        '    id: "method:src/services/task-operation-adapter-warmup.controller.ts:TaskOperationAdapterWarmupController::captureRuntimeErrorLogging",',
        '    kind: "method",',
        '    name: "captureRuntimeErrorLogging",',
        '    qualifiedName: "TaskOperationAdapterWarmupController::captureRuntimeErrorLogging",',
        '    filePath: "src/services/task-operation-adapter-warmup.controller.ts",',
        '    language: "typescript",',
        '    startLine: 2,',
        '    endLine: 2',
        '  }, {',
        '    id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:handleToolCall",',
        '    kind: "function",',
        '    name: "handleToolCall",',
        '    qualifiedName: "handleToolCall",',
        '    filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs",',
        '    language: "javascript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:writeToCodegraphStdin",',
        '    kind: "function",',
        '    name: "writeToCodegraphStdin",',
        '    qualifiedName: "writeToCodegraphStdin",',
        '    filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs",',
        '    language: "javascript",',
        '    startLine: 4,',
        '    endLine: 6',
        '  }, {',
        '    id: "function:scripts/codegraph-adapter-doctor.cjs:buildDoctorReport",',
        '    kind: "function",',
        '    name: "buildDoctorReport",',
        '    qualifiedName: "buildDoctorReport",',
        '    filePath: "scripts/codegraph-adapter-doctor.cjs",',
        '    language: "javascript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 3, graphNodes: 5, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-wrapper-maintenance-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-wrapper-maintenance-log-')),
      'wrapper.log',
    );
    tempRoots.push(path.dirname(logPath));
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method !== 'tools/call' || message.params?.name !== 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "    return;",
        "  }",
        "  const query = message.params.arguments.query;",
        "  const text = [",
        "    '**Exploration: ' + query + '**',",
        "    '',",
        "    'Found 5 symbols across 3 files.',",
        "    '',",
        "    '**Source Code**',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '**`src/services/task-operation-adapter-warmup.controller.ts`** — TaskOperationAdapterWarmupController(class), captureRuntimeErrorLogging(method), handleTransportClosedRecovery(method), runtimeLoggerCaptureDiagnostics(method)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class TaskOperationAdapterWarmupController {',",
        "    '2\\t  captureRuntimeErrorLogging(): void {}',",
        "    '3\\t  handleTransportClosedRecovery(): void {}',",
        "    '4\\t  runtimeLoggerCaptureDiagnostics(): void {}',",
        "    '5\\t}',",
        "    '```',",
        "    '',",
        "    '**`scripts/codegraph-nanoflow-mcp-stdio.cjs`** — handleToolCall(function), writeToCodegraphStdin(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tfunction handleToolCall(message) {',",
        "    '2\\t  return message;',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '**`scripts/codegraph-adapter-doctor.cjs`** — buildDoctorReport(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tfunction buildDoctorReport() {',",
        "    '2\\t  return {};',",
        "    '3\\t}',",
        "    '```',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({",
        "    jsonrpc: '2.0',",
        "    id: message.id,",
        "    result: { content: [{ type: 'text', text }] },",
        "  }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'CodeGraph MCP wrapper runtime error logging codegraph-nanoflow-mcp-stdio handleToolCall error capture logger wrapper script stale transport closed adapter doctor diagnostics',
            overlayLimit: 5,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const wrapperIndex = text.indexOf('scripts/codegraph-nanoflow-mcp-stdio.cjs`**');
      const businessIndex = text.indexOf('src/services/task-operation-adapter-warmup.controller.ts`**');
      expect(wrapperIndex).toBeGreaterThanOrEqual(0);
      if (businessIndex >= 0) {
        expect(wrapperIndex).toBeLessThan(businessIndex);
      }

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 53,
      );
      const sourceOrdering = responseEvent.sourceOrdering as {
        sourceRankingQuery: string;
        topRankedOverlayFile: string;
        topRankedOverlayFileVisibleIndex: number;
        firstSourceBlockIsTopRankedOverlayFile: boolean;
      };
      expect(String(sourceOrdering.sourceRankingQuery).toLowerCase()).not.toContain('runtime');
      expect(String(sourceOrdering.sourceRankingQuery).toLowerCase()).toContain('handletoolcall');
      expect(sourceOrdering).toEqual(expect.objectContaining({
        topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('keeps a requested NanoFlow relation endpoint ahead of low-value match noise under a hard file budget', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-relation-budget-'));
    tempRoots.push(projectRoot);
    const routeFile = 'src/app.routes.ts';
    const helperFile = 'src/tests/scripts/codegraph-nanoflow-overlay-query-angular-route-guard-source-budget.spec-helpers.ts';
    writeFile(
      projectRoot,
      routeFile,
      [
        'export const routes = [',
        "  { path: '', redirectTo: '/projects', pathMatch: 'full' },",
        "  { path: 'projects', loadComponent: () => import('./workspace-shell.component') },",
        '];',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      helperFile,
      [
        'export function registerCodegraphOverlayAngularRouteGuardSourceBudgetSpecs(): void {',
        "  const query = 'angular-route-redirect';",
        '  void query;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const routeFile = "src/app.routes.ts";',
        'const helperFile = "src/tests/scripts/codegraph-nanoflow-overlay-query-angular-route-guard-source-budget.spec-helpers.ts";',
        'const response = {',
        "  query: 'angular-route-redirect',",
        '  matches: [{',
        '    kind: "function",',
        '    name: "registerCodegraphOverlayAngularRouteGuardSourceBudgetSpecs",',
        '    file: helperFile,',
        '  }],',
        '  nodes: [{',
        '    id: "route:src/app.routes.ts:(root)",',
        '    kind: "route",',
        '    name: "(root)",',
        '    qualifiedName: "(root)",',
        '    filePath: routeFile,',
        '    language: "typescript",',
        '    startLine: 2,',
        '    endLine: 2,',
        '    metadata: { framework: "angular", path: "", redirectTo: "/projects" },',
        '  }, {',
        '    id: "route:src/app.routes.ts:projects",',
        '    kind: "route",',
        '    name: "projects",',
        '    qualifiedName: "projects",',
        '    filePath: routeFile,',
        '    language: "typescript",',
        '    startLine: 3,',
        '    endLine: 3,',
        '    metadata: { framework: "angular", path: "projects" },',
        '  }],',
        '  relationshipGroups: {',
        '    references: [{',
        '      source: "(root)",',
        '      target: "projects",',
        '      relation: "angular-route-redirect",',
        '      path: "",',
        '      redirectTo: "/projects",',
        '    }],',
        '  },',
        '  coverage: { routes: 2, graphNodes: 3, graphEdges: 1 },',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-relation-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-relation-log-')),
      'wrapper.log',
    );
    tempRoots.push(path.dirname(logPath));
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        '  const message = JSON.parse(line);',
        "  if (message.method !== 'tools/call' || message.params?.name !== 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        '    return;',
        '  }',
        '  const text = [',
        "    '**Exploration: angular-route-redirect**',",
        "    '',",
        "    '**Source Code**',",
        "    '',",
        "    '**`src/tests/scripts/codegraph-nanoflow-overlay-query-angular-route-guard-source-budget.spec-helpers.ts`** — registerCodegraphOverlayAngularRouteGuardSourceBudgetSpecs(function)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport function registerCodegraphOverlayAngularRouteGuardSourceBudgetSpecs(): void {}',",
        "    '```',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
        '});',
        '',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 55,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'angular-route-redirect',
            maxFiles: 1,
            overlayLimit: 8,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('**`src/app.routes.ts`**');
      expect(text).not.toContain(`**\`${helperFile}\`**`);

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 55,
      );
      expect(responseEvent).toEqual(expect.objectContaining({
        sourceOrdering: expect.objectContaining({
          firstSourceFiles: [routeFile],
          topRankedOverlayFile: routeFile,
          topRankedOverlayFileVisibleIndex: 0,
          topRankedOverlayFileMissing: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 12_000);
}
