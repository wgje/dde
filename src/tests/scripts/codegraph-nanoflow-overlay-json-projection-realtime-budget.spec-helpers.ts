import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionRealtimeBudgetSpecs(context: CodegraphOverlaySpecContext): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;
  const queryNativeMarkdown = (root: string, query: string) => spawnSync(process.execPath, [
    queryScriptPath,
    '--root',
    root,
    '--query',
    query,
    '--limit',
    '20',
    '--native-markdown',
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const nativeMarkdownCodeSection = (stdout: string): string => stdout.slice(stdout.indexOf('### Code'));

  it('prioritizes owner code blocks for realtime channel and postgres-change relation queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-realtime-subscription-source-budget-'));
    tempRoots.push(root);
    const methodNames = [
      'subscribeTasks',
      'subscribeProjects',
      'subscribeBlackBox',
      'subscribeConnections',
      'subscribeAttachments',
      'subscribeComments',
    ];
    const sourceLines = [
      'export class RealtimeSubscriptionController {',
      ...methodNames.flatMap((methodName, index) => [
        `  ${methodName}(client: { channel(name: string): { on(type: string, config: unknown, callback: () => void): { subscribe(): void } } }): void {`,
        `    client.channel('topic-${index}')`,
        `      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'table_${index}' }, () => undefined)`,
        '      .subscribe();',
        '  }',
      ]),
      '}',
      '',
    ];
    writeFile(
      root,
      'src/app/core/services/sync/realtime-subscription.controller.ts',
      sourceLines.join('\n'),
    );
    const methodNodes = methodNames.map((methodName, index) => {
      const startLine = 2 + (index * 5);
      return {
        id: `method:src/app/core/services/sync/realtime-subscription.controller.ts:RealtimeSubscriptionController::${methodName}`,
        kind: 'method',
        name: methodName,
        qualifiedName: `RealtimeSubscriptionController::${methodName}`,
        filePath: 'src/app/core/services/sync/realtime-subscription.controller.ts',
        language: 'typescript',
        startLine,
        endLine: startLine + 4,
      };
    });
    const channelNodes = methodNames.map((methodName, index) => {
      const line = 3 + (index * 5);
      return {
        id: `variable:src/app/core/services/sync/realtime-subscription.controller.ts:supabase-realtime-channel:${methodName}:topic-${index}:${line}`,
        kind: 'variable',
        name: `topic-${index}`,
        qualifiedName: `RealtimeSubscriptionController::${methodName}::topic-${index}`,
        filePath: 'src/app/core/services/sync/realtime-subscription.controller.ts',
        language: 'typescript',
        startLine: line,
        endLine: line,
      };
    });
    const postgresChangeNodes = methodNames.map((methodName, index) => {
      const line = 4 + (index * 5);
      return {
        id: `variable:src/app/core/services/sync/realtime-subscription.controller.ts:supabase-realtime-postgres-change:${methodName}:table_${index}:${line}`,
        kind: 'variable',
        name: `public.table_${index} UPDATE`,
        qualifiedName: `RealtimeSubscriptionController::${methodName}::public.table_${index} UPDATE`,
        filePath: 'src/app/core/services/sync/realtime-subscription.controller.ts',
        language: 'typescript',
        startLine: line,
        endLine: line,
      };
    });
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/app/core/services/sync/realtime-subscription.controller.ts'],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: methodNames.flatMap((_, index) => [methodNodes[index], channelNodes[index], postgresChangeNodes[index]]),
        edges: methodNames.flatMap((methodName, index) => ([
          {
            source: methodNodes[index].id,
            target: channelNodes[index].id,
            kind: 'references',
            line: 3 + (index * 5),
            column: 12,
            metadata: {
              relation: 'supabase-realtime-channel',
              channelName: `topic-${index}`,
              owner: methodName,
            },
          },
          {
            source: methodNodes[index].id,
            target: postgresChangeNodes[index].id,
            kind: 'references',
            line: 4 + (index * 5),
            column: 8,
            metadata: {
              relation: 'supabase-realtime-postgres-change',
              channelName: `topic-${index}`,
              event: 'UPDATE',
              schema: 'public',
              table: `table_${index}`,
              owner: methodName,
            },
          },
        ])),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const channelResult = queryOverlay(root, 'supabase-realtime-channel', ['--limit', '20', '--native-json']);
    const postgresChangeResult = queryOverlay(root, 'supabase-realtime-postgres-change', ['--limit', '20', '--native-json']);
    const channelMarkdownResult = queryNativeMarkdown(root, 'supabase-realtime-channel');
    const postgresChangeMarkdownResult = queryNativeMarkdown(root, 'supabase-realtime-postgres-change');

    expectSpawnSuccess(channelResult);
    expectSpawnSuccess(postgresChangeResult);
    expectSpawnSuccess(channelMarkdownResult);
    expectSpawnSuccess(postgresChangeMarkdownResult);
    const channelResponse = JSON.parse(channelResult.stdout);
    const postgresChangeResponse = JSON.parse(postgresChangeResult.stdout);
    expect(channelResponse.edges.length).toBe(methodNames.length);
    expect(postgresChangeResponse.edges.length).toBe(methodNames.length);
    expect(channelResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/core/services/sync/realtime-subscription.controller.ts',
      nodeKind: 'method',
      nodeName: 'subscribeTasks',
      content: expect.stringContaining("client.channel('topic-0')"),
    }));
    expect(postgresChangeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/core/services/sync/realtime-subscription.controller.ts',
      nodeKind: 'method',
      nodeName: 'subscribeTasks',
      content: expect.stringContaining("table: 'table_0'"),
    }));
    expect(channelResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'method')).toBe(true);
    expect(postgresChangeResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'method')).toBe(true);

    const channelMarkdownCode = nativeMarkdownCodeSection(channelMarkdownResult.stdout);
    const postgresChangeMarkdownCode = nativeMarkdownCodeSection(postgresChangeMarkdownResult.stdout);
    expect(channelMarkdownCode).toMatch(/^### Code\s+#### subscribeTasks \(src\/app\/core\/services\/sync\/realtime-subscription\.controller\.ts:2\)/);
    expect(channelMarkdownCode).toContain("client.channel('topic-0')");
    expect(channelMarkdownCode).not.toContain('#### topic-0');
    expect(postgresChangeMarkdownCode).toMatch(/^### Code\s+#### subscribeTasks \(src\/app\/core\/services\/sync\/realtime-subscription\.controller\.ts:2\)/);
    expect(postgresChangeMarkdownCode).toContain("table: 'table_0'");
    expect(postgresChangeMarkdownCode).not.toContain('#### public.table_0 UPDATE');
  });

  it('prioritizes implementation source code blocks for realtime status relation queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-realtime-status-source-budget-'));
    tempRoots.push(root);
    const statuses = ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'SUBSCRIBED_AGAIN', 'CHANNEL_ERROR_AGAIN'];
    const sourceLines = [
      'export class RealtimeStatusController {',
      ...statuses.flatMap((status, index) => [
        `  handleStatus${index}(status: string): void {`,
        `    if (status === '${status}') {`,
        '      return;',
        '    }',
        '  }',
      ]),
      '}',
      '',
    ];
    writeFile(
      root,
      'src/app/core/services/sync/realtime-status.controller.ts',
      sourceLines.join('\n'),
    );
    const methodNodes = statuses.map((_, index) => {
      const startLine = 2 + (index * 5);
      return {
        id: `method:src/app/core/services/sync/realtime-status.controller.ts:RealtimeStatusController::handleStatus${index}`,
        kind: 'method',
        name: `handleStatus${index}`,
        qualifiedName: `RealtimeStatusController::handleStatus${index}`,
        filePath: 'src/app/core/services/sync/realtime-status.controller.ts',
        language: 'typescript',
        startLine,
        endLine: startLine + 4,
      };
    });
    const statusNodes = statuses.map((status, index) => {
      const line = 3 + (index * 5);
      return {
        id: `variable:src/app/core/services/sync/realtime-status.controller.ts:Realtime status ${status}:${line}`,
        kind: 'variable',
        name: `Realtime status ${status}`,
        qualifiedName: `RealtimeStatusController::Realtime status ${status}`,
        filePath: 'src/app/core/services/sync/realtime-status.controller.ts',
        language: 'typescript',
        startLine: line,
        endLine: line,
      };
    });
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/app/core/services/sync/realtime-status.controller.ts'],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: statuses.flatMap((_, index) => [methodNodes[index], statusNodes[index]]),
        edges: statuses.map((status, index) => ({
          source: methodNodes[index].id,
          target: statusNodes[index].id,
          kind: 'references',
          line: 3 + (index * 5),
          column: 8,
          metadata: {
            relation: 'supabase-realtime-status',
            status,
          },
        })),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'supabase-realtime-status', ['--limit', '20', '--native-json']);
    const markdownResult = queryNativeMarkdown(root, 'supabase-realtime-status');

    expectSpawnSuccess(result);
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBe(statuses.length);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/core/services/sync/realtime-status.controller.ts',
      nodeKind: 'method',
      nodeName: 'handleStatus0',
      content: expect.stringContaining("if (status === 'SUBSCRIBED')"),
    }));
    expect(response.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'method')).toBe(true);

    const markdownCode = nativeMarkdownCodeSection(markdownResult.stdout);
    expect(markdownCode).toMatch(/^### Code\s+#### handleStatus0 \(src\/app\/core\/services\/sync\/realtime-status\.controller\.ts:2\)/);
    expect(markdownCode).toContain("if (status === 'SUBSCRIBED')");
    expect(markdownCode).not.toContain('#### Realtime status SUBSCRIBED');
  });

  it('prioritizes lifecycle owner code blocks for realtime remove-channel relation queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-realtime-remove-channel-source-budget-'));
    tempRoots.push(root);
    const methodNames = [
      'cleanup',
      'fallbackToPolling',
      'teardownActiveTransport',
      'handleBlackBoxRealtimeStatus',
      'teardownRealtimeSubscription',
      'disposeRealtimeChannel',
    ];
    const sourceLines = [
      'export class RealtimeLifecycleController {',
      ...methodNames.flatMap((methodName, index) => [
        `  ${methodName}(client: { removeChannel(channel: unknown): Promise<void> }, channel: unknown): void {`,
        `    void client.removeChannel(channel).catch(() => ${index});`,
        '  }',
      ]),
      '}',
      '',
    ];
    writeFile(
      root,
      'src/app/core/services/sync/realtime-lifecycle.controller.ts',
      sourceLines.join('\n'),
    );
    const methodNodes = methodNames.map((methodName, index) => {
      const startLine = 2 + (index * 3);
      return {
        id: `method:src/app/core/services/sync/realtime-lifecycle.controller.ts:RealtimeLifecycleController::${methodName}`,
        kind: 'method',
        name: methodName,
        qualifiedName: `RealtimeLifecycleController::${methodName}`,
        filePath: 'src/app/core/services/sync/realtime-lifecycle.controller.ts',
        language: 'typescript',
        startLine,
        endLine: startLine + 2,
      };
    });
    const removeChannelNodes = methodNames.map((methodName, index) => {
      const line = 3 + (index * 3);
      return {
        id: `variable:src/app/core/services/sync/realtime-lifecycle.controller.ts:supabase-realtime-remove-channel:${methodName}:${line}`,
        kind: 'variable',
        name: 'removeChannel channel',
        qualifiedName: `RealtimeLifecycleController::${methodName}::removeChannel channel`,
        filePath: 'src/app/core/services/sync/realtime-lifecycle.controller.ts',
        language: 'typescript',
        startLine: line,
        endLine: line,
      };
    });
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/app/core/services/sync/realtime-lifecycle.controller.ts'],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: methodNames.flatMap((_, index) => [methodNodes[index], removeChannelNodes[index]]),
        edges: methodNames.map((methodName, index) => ({
          source: methodNodes[index].id,
          target: removeChannelNodes[index].id,
          kind: 'references',
          line: 3 + (index * 3),
          column: 16,
          metadata: {
            relation: 'supabase-realtime-remove-channel',
            channelVariable: 'channel',
            owner: methodName,
          },
        })),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'supabase-realtime-remove-channel', ['--limit', '20', '--native-json']);
    const markdownResult = queryNativeMarkdown(root, 'supabase-realtime-remove-channel');

    expectSpawnSuccess(result);
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBe(methodNames.length);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/core/services/sync/realtime-lifecycle.controller.ts',
      nodeKind: 'method',
      nodeName: 'cleanup',
      content: expect.stringContaining('void client.removeChannel(channel)'),
    }));
    expect(response.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'method')).toBe(true);

    const markdownCode = nativeMarkdownCodeSection(markdownResult.stdout);
    expect(markdownCode).toMatch(/^### Code\s+#### cleanup \(src\/app\/core\/services\/sync\/realtime-lifecycle\.controller\.ts:2\)/);
    expect(markdownCode).toContain('void client.removeChannel(channel)');
    expect(markdownCode).not.toContain('#### removeChannel channel');
  });

  it('prioritizes lifecycle owner code blocks for realtime unsubscribe and remove-all-channels relation queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-realtime-lifecycle-source-budget-'));
    tempRoots.push(root);
    const methodNames = [
      'teardownTasks',
      'teardownProjects',
      'teardownBlackBox',
      'teardownConnections',
      'teardownAttachments',
      'teardownComments',
    ];
    const sourceLines = [
      'export class RealtimeLifecycleController {',
      ...methodNames.flatMap((methodName, index) => [
        `  ${methodName}(client: { removeAllChannels(): Promise<void> }, channel: { unsubscribe(): Promise<void> }): void {`,
        `    void channel.unsubscribe().catch(() => ${index});`,
        `    void client.removeAllChannels().catch(() => ${index});`,
        '  }',
      ]),
      '}',
      '',
    ];
    writeFile(
      root,
      'src/app/core/services/sync/realtime-lifecycle-all.controller.ts',
      sourceLines.join('\n'),
    );
    const methodNodes = methodNames.map((methodName, index) => {
      const startLine = 2 + (index * 4);
      return {
        id: `method:src/app/core/services/sync/realtime-lifecycle-all.controller.ts:RealtimeLifecycleController::${methodName}`,
        kind: 'method',
        name: methodName,
        qualifiedName: `RealtimeLifecycleController::${methodName}`,
        filePath: 'src/app/core/services/sync/realtime-lifecycle-all.controller.ts',
        language: 'typescript',
        startLine,
        endLine: startLine + 3,
      };
    });
    const unsubscribeNodes = methodNames.map((methodName, index) => {
      const line = 3 + (index * 4);
      return {
        id: `variable:src/app/core/services/sync/realtime-lifecycle-all.controller.ts:supabase-realtime-unsubscribe:${methodName}:${line}`,
        kind: 'variable',
        name: 'unsubscribe channel',
        qualifiedName: `RealtimeLifecycleController::${methodName}::unsubscribe channel`,
        filePath: 'src/app/core/services/sync/realtime-lifecycle-all.controller.ts',
        language: 'typescript',
        startLine: line,
        endLine: line,
      };
    });
    const removeAllChannelsNodes = methodNames.map((methodName, index) => {
      const line = 4 + (index * 4);
      return {
        id: `variable:src/app/core/services/sync/realtime-lifecycle-all.controller.ts:supabase-realtime-remove-all-channels:${methodName}:${line}`,
        kind: 'variable',
        name: 'removeAllChannels',
        qualifiedName: `RealtimeLifecycleController::${methodName}::removeAllChannels`,
        filePath: 'src/app/core/services/sync/realtime-lifecycle-all.controller.ts',
        language: 'typescript',
        startLine: line,
        endLine: line,
      };
    });
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/app/core/services/sync/realtime-lifecycle-all.controller.ts'],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: methodNames.flatMap((_, index) => [
          methodNodes[index],
          unsubscribeNodes[index],
          removeAllChannelsNodes[index],
        ]),
        edges: methodNames.flatMap((methodName, index) => ([
          {
            source: methodNodes[index].id,
            target: unsubscribeNodes[index].id,
            kind: 'references',
            line: 3 + (index * 4),
            column: 16,
            metadata: {
              relation: 'supabase-realtime-unsubscribe',
              owner: methodName,
            },
          },
          {
            source: methodNodes[index].id,
            target: removeAllChannelsNodes[index].id,
            kind: 'references',
            line: 4 + (index * 4),
            column: 16,
            metadata: {
              relation: 'supabase-realtime-remove-all-channels',
              owner: methodName,
            },
          },
        ])),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const unsubscribeResult = queryOverlay(root, 'supabase-realtime-unsubscribe', ['--limit', '20', '--native-json']);
    const removeAllChannelsResult = queryOverlay(root, 'supabase-realtime-remove-all-channels', ['--limit', '20', '--native-json']);
    const unsubscribeMarkdownResult = queryNativeMarkdown(root, 'supabase-realtime-unsubscribe');
    const removeAllChannelsMarkdownResult = queryNativeMarkdown(root, 'supabase-realtime-remove-all-channels');

    expectSpawnSuccess(unsubscribeResult);
    expectSpawnSuccess(removeAllChannelsResult);
    expectSpawnSuccess(unsubscribeMarkdownResult);
    expectSpawnSuccess(removeAllChannelsMarkdownResult);
    const unsubscribeResponse = JSON.parse(unsubscribeResult.stdout);
    const removeAllChannelsResponse = JSON.parse(removeAllChannelsResult.stdout);
    expect(unsubscribeResponse.edges.length).toBe(methodNames.length);
    expect(removeAllChannelsResponse.edges.length).toBe(methodNames.length);
    expect(unsubscribeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/core/services/sync/realtime-lifecycle-all.controller.ts',
      nodeKind: 'method',
      nodeName: 'teardownTasks',
      content: expect.stringContaining('void channel.unsubscribe()'),
    }));
    expect(removeAllChannelsResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/core/services/sync/realtime-lifecycle-all.controller.ts',
      nodeKind: 'method',
      nodeName: 'teardownTasks',
      content: expect.stringContaining('void client.removeAllChannels()'),
    }));
    expect(unsubscribeResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'method')).toBe(true);
    expect(removeAllChannelsResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'method')).toBe(true);

    const unsubscribeMarkdownCode = nativeMarkdownCodeSection(unsubscribeMarkdownResult.stdout);
    const removeAllChannelsMarkdownCode = nativeMarkdownCodeSection(removeAllChannelsMarkdownResult.stdout);
    expect(unsubscribeMarkdownCode).toMatch(/^### Code\s+#### teardownTasks \(src\/app\/core\/services\/sync\/realtime-lifecycle-all\.controller\.ts:2\)/);
    expect(unsubscribeMarkdownCode).toContain('void channel.unsubscribe()');
    expect(unsubscribeMarkdownCode).not.toContain('#### unsubscribe channel');
    expect(removeAllChannelsMarkdownCode).toMatch(/^### Code\s+#### teardownTasks \(src\/app\/core\/services\/sync\/realtime-lifecycle-all\.controller\.ts:2\)/);
    expect(removeAllChannelsMarkdownCode).toContain('void client.removeAllChannels()');
    expect(removeAllChannelsMarkdownCode).not.toContain('#### removeAllChannels');
  });
}
