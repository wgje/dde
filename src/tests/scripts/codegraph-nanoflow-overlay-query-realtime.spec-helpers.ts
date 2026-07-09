import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayRealtimeQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, runOverlay, queryOverlay, expectSpawnSuccess } = context;

  it('queries Supabase Realtime channels and postgres changes as focused native relationships', () => {
    const root = makeFixture();

    const channelResult = queryOverlay(root, 'supabase-realtime-channel', ['--limit', '20']);
    const postgresChangesResult = queryOverlay(root, 'supabase-realtime-postgres-change', ['--limit', '20']);

    expectSpawnSuccess(channelResult);
    expectSpawnSuccess(postgresChangesResult);
    const channelResponse = JSON.parse(channelResult.stdout);
    const postgresChangesResponse = JSON.parse(postgresChangesResult.stdout);
    const methodId = 'method:src/services/realtime-client.service.ts:RealtimeClientService.subscribeTasks';
    const owner = 'RealtimeClientService.subscribeTasks';
    const channelNode = channelResponse.nodes.find((node: { id?: string; metadata?: { relation?: string; channelName?: string; owner?: string } }) =>
      node.metadata?.relation === 'supabase-realtime-channel'
      && node.metadata.channelName === 'realtime:public:tasks'
      && node.metadata.owner === owner
    );
    const postgresChangesNode = postgresChangesResponse.nodes.find((node: { id?: string; metadata?: { relation?: string; channelName?: string; table?: string; owner?: string } }) =>
      node.metadata?.relation === 'supabase-realtime-postgres-change'
      && node.metadata.channelName === 'realtime:public:tasks'
      && node.metadata.table === 'tasks'
      && node.metadata.owner === owner
    );
    const channelId = channelNode?.id;
    const postgresChangesId = postgresChangesNode?.id;

    expect(channelResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: methodId,
        kind: 'method',
        name: 'subscribeTasks',
        filePath: 'src/services/realtime-client.service.ts',
      }),
      expect.objectContaining({
        id: channelId,
        kind: 'variable',
        name: 'realtime:public:tasks',
        filePath: 'src/services/realtime-client.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-channel',
          channelName: 'realtime:public:tasks',
          owner,
        }),
      }),
    ]));
    expect(channelResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: channelId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-channel',
          channelName: 'realtime:public:tasks',
          owner,
        }),
      }),
    ]));

    expect(postgresChangesResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: methodId }),
      expect.objectContaining({
        id: postgresChangesId,
        kind: 'variable',
        name: 'public.tasks UPDATE',
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-postgres-change',
          owner,
          channelName: 'realtime:public:tasks',
          event: 'UPDATE',
          schema: 'public',
          table: 'tasks',
          filter: 'user_id=eq.fixture',
        }),
      }),
    ]));
    expect(postgresChangesResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: postgresChangesId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-postgres-change',
          owner,
          channelName: 'realtime:public:tasks',
          event: 'UPDATE',
          schema: 'public',
          table: 'tasks',
          filter: 'user_id=eq.fixture',
        }),
      }),
    ]));
    expect(postgresChangesResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'subscribeTasks',
        target: 'public.tasks UPDATE',
        relation: 'supabase-realtime-postgres-change',
      }),
    ]));
    expect(postgresChangesResponse.markdown).toContain('relation: supabase-realtime-postgres-change');
  });

  it('keeps same-channel realtime subscription endpoints scoped by owner', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/services/realtime-duplicate-client.service.ts',
      [
        'type RealtimeChannel = {',
        "  on(type: 'postgres_changes', config: { event: string; schema: string; table: string }, callback: (payload: unknown) => void): {",
        '    subscribe(): unknown;',
        '  };',
        '};',
        '',
        'type RealtimeClient = {',
        '  channel(name: string): RealtimeChannel;',
        '};',
        '',
        'export class RealtimeDuplicateClientService {',
        '  subscribePrimary(client: RealtimeClient): unknown {',
        "    return client.channel('realtime:public:tasks')",
        "      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tasks' }, payload => void payload)",
        '      .subscribe();',
        '  }',
        '',
        '  subscribeSecondary(client: RealtimeClient): unknown {',
        "    return client.channel('realtime:public:tasks')",
        "      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tasks' }, payload => void payload)",
        '      .subscribe();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);

    expectSpawnSuccess(overlayResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const duplicateFile = 'src/services/realtime-duplicate-client.service.ts';
    const channelNodes = overlay.graph.nodes.filter((node: { filePath?: string; metadata?: { relation?: string } }) =>
      node.filePath === duplicateFile && node.metadata?.relation === 'supabase-realtime-channel'
    );
    const postgresChangeNodes = overlay.graph.nodes.filter((node: { filePath?: string; metadata?: { relation?: string } }) =>
      node.filePath === duplicateFile && node.metadata?.relation === 'supabase-realtime-postgres-change'
    );
    const channelEdges = overlay.graph.edges.filter((edge: { source?: string; metadata?: { relation?: string } }) =>
      edge.source?.startsWith(`method:${duplicateFile}:RealtimeDuplicateClientService.subscribe`)
      && edge.metadata?.relation === 'supabase-realtime-channel'
    );
    const postgresChangeEdges = overlay.graph.edges.filter((edge: { source?: string; metadata?: { relation?: string } }) =>
      edge.source?.startsWith(`method:${duplicateFile}:RealtimeDuplicateClientService.subscribe`)
      && edge.metadata?.relation === 'supabase-realtime-postgres-change'
    );

    expect(channelNodes).toHaveLength(2);
    expect(postgresChangeNodes).toHaveLength(2);
    expect(new Set(channelEdges.map((edge: { target: string }) => edge.target)).size).toBe(2);
    expect(new Set(postgresChangeEdges.map((edge: { target: string }) => edge.target)).size).toBe(2);
    expect(channelEdges).toHaveLength(2);
    expect(postgresChangeEdges).toHaveLength(2);
  });

  it('keeps multi-endpoint realtime relation queries from overconstraining to one edge', () => {
    const root = makeFixture();
    const duplicateFile = 'src/services/realtime-duplicate-client.service.ts';
    writeFile(
      root,
      duplicateFile,
      [
        'type RealtimeChannel = {',
        "  on(type: 'postgres_changes', config: { event: string; schema: string; table: string }, callback: (payload: unknown) => void): {",
        '    subscribe(): unknown;',
        '  };',
        '};',
        '',
        'type RealtimeClient = {',
        '  channel(name: string): RealtimeChannel;',
        '};',
        '',
        'export class RealtimeDuplicateClientService {',
        '  subscribePrimary(client: RealtimeClient): unknown {',
        "    return client.channel('realtime:public:tasks')",
        "      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tasks' }, payload => void payload)",
        '      .subscribe();',
        '  }',
        '',
        '  subscribeSecondary(client: RealtimeClient): unknown {',
        "    return client.channel('realtime:public:tasks')",
        "      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tasks' }, payload => void payload)",
        '      .subscribe();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'supabase-realtime-channel subscribePrimary subscribeSecondary',
      ['--limit', '20'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const relationEdges = response.edges.filter((edge: { source?: string; metadata?: { relation?: string } }) =>
      edge.source?.startsWith(`method:${duplicateFile}:RealtimeDuplicateClientService.subscribe`)
      && edge.metadata?.relation === 'supabase-realtime-channel'
    );

    expect(relationEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: `method:${duplicateFile}:RealtimeDuplicateClientService.subscribePrimary`,
      }),
      expect.objectContaining({
        source: `method:${duplicateFile}:RealtimeDuplicateClientService.subscribeSecondary`,
      }),
    ]));
    expect(relationEdges).toHaveLength(2);
    expect(response.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'subscribePrimary' }),
      expect.objectContaining({ name: 'subscribeSecondary' }),
    ]));
  });

  it('preserves template-derived realtime channel names and postgres filters', () => {
    const root = makeFixture();
    const sourceFile = 'src/services/realtime-template-client.service.ts';
    writeFile(
      root,
      sourceFile,
      [
        'type RealtimeChannel = {',
        "  on(type: 'postgres_changes', config: { event: string; schema: string; table: string; filter: string }, callback: (payload: unknown) => void): {",
        '    subscribe(): unknown;',
        '  };',
        '};',
        '',
        'type RealtimeClient = {',
        '  channel(name: string): RealtimeChannel;',
        '};',
        '',
        'export class RealtimeTemplateClientService {',
        '  subscribeTenant(client: RealtimeClient, tenantId: string, userId: string): unknown {',
        '    return client.channel(`realtime:${tenantId}`)',
        "      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` }, payload => void payload)",
        '      .subscribe();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const channelResult = queryOverlay(root, 'supabase-realtime-channel', ['--limit', '20']);
    const postgresChangesResult = queryOverlay(root, 'supabase-realtime-postgres-change', ['--limit', '20']);
    const nativePostgresChangesResult = queryOverlay(root, 'supabase-realtime-postgres-change', [
      '--limit',
      '20',
      '--native-json',
    ]);

    expectSpawnSuccess(channelResult);
    expectSpawnSuccess(postgresChangesResult);
    expectSpawnSuccess(nativePostgresChangesResult);
    const channelResponse = JSON.parse(channelResult.stdout);
    const postgresChangesResponse = JSON.parse(postgresChangesResult.stdout);
    const nativePostgresChangesResponse = JSON.parse(nativePostgresChangesResult.stdout);
    const methodId = 'method:src/services/realtime-template-client.service.ts:RealtimeTemplateClientService.subscribeTenant';
    const owner = 'RealtimeTemplateClientService.subscribeTenant';
    const channelNode = channelResponse.nodes.find((node: { metadata?: { relation?: string; channelName?: string; owner?: string } }) =>
      node.metadata?.relation === 'supabase-realtime-channel'
      && node.metadata.channelName === 'realtime:${tenantId}'
      && node.metadata.owner === owner
    );
    const postgresChangesNode = postgresChangesResponse.nodes.find((node: { metadata?: { relation?: string; channelName?: string; filter?: string; owner?: string } }) =>
      node.metadata?.relation === 'supabase-realtime-postgres-change'
      && node.metadata.channelName === 'realtime:${tenantId}'
      && node.metadata.filter === 'user_id=eq.${userId}'
      && node.metadata.owner === owner
    );

    expect(channelNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'realtime:${tenantId}',
      filePath: sourceFile,
    }));
    expect(channelResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: channelNode?.id,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-channel',
          channelName: 'realtime:${tenantId}',
          owner,
        }),
      }),
    ]));
    expect(postgresChangesNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'public.tasks UPDATE',
      filePath: sourceFile,
      metadata: expect.objectContaining({
        relation: 'supabase-realtime-postgres-change',
        channelName: 'realtime:${tenantId}',
        filter: 'user_id=eq.${userId}',
      }),
    }));
    expect(postgresChangesResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: postgresChangesNode?.id,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-postgres-change',
          channelName: 'realtime:${tenantId}',
          filter: 'user_id=eq.${userId}',
          owner,
        }),
      }),
    ]));
    expect(nativePostgresChangesResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: sourceFile,
        nodeKind: 'method',
        nodeName: 'subscribeTenant',
        content: expect.stringContaining('client.channel(`realtime:${tenantId}`)'),
      }),
    ]));
  });

  it('suppresses same-file synthetic realtime subscription endpoints from strict native code blocks', () => {
    const root = makeFixture();

    const channelResult = queryOverlay(root, 'supabase-realtime-channel', ['--limit', '20', '--native-json']);
    const postgresChangesResult = queryOverlay(root, 'supabase-realtime-postgres-change', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(channelResult);
    expectSpawnSuccess(postgresChangesResult);
    const channelResponse = JSON.parse(channelResult.stdout);
    const postgresChangesResponse = JSON.parse(postgresChangesResult.stdout);
    const sourceFile = 'src/services/realtime-client.service.ts';

    expect(channelResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: sourceFile,
        nodeKind: 'method',
        nodeName: 'subscribeTasks',
        content: expect.stringContaining("client.channel('realtime:public:tasks')"),
      }),
    ]));
    expect(channelResponse.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: sourceFile,
        nodeKind: 'variable',
        nodeName: 'realtime:public:tasks',
      }),
    ]));

    expect(postgresChangesResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: sourceFile,
        nodeKind: 'method',
        nodeName: 'subscribeTasks',
        content: expect.stringContaining("'postgres_changes'"),
      }),
    ]));
    expect(postgresChangesResponse.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: sourceFile,
        nodeKind: 'variable',
        nodeName: 'public.tasks UPDATE',
      }),
    ]));
  });

  it('queries Supabase Realtime subscribe statuses as focused native relationships', () => {
    const root = makeFixture();
    writeFile(
      root,
      'scripts/generate-codegraph-nanoflow-overlay.mjs',
      [
        'export function readSupabaseRealtimeStatusAction(status) {',
        "  return status === 'SUBSCRIBED' ? 'subscribed' : 'fallback';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/tests/scripts/codegraph-nanoflow-overlay-query.spec-helpers.ts',
      [
        'export function assertRealtimeStatusFixture() {',
        "  return ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'];",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/test-setup.mocks.ts',
      [
        'export function mockSupabaseChannel(status: string) {',
        "  return status === 'SUBSCRIBED';",
        '}',
        '',
      ].join('\n'),
    );

    const methodId = 'method:src/services/realtime-client.service.ts:RealtimeClientService.handleStatus';
    const overlayResult = runOverlay(root);
    const statusResult = queryOverlay(root, 'supabase-realtime-status', ['--limit', '20']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(statusResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const realtimeStatusSources = overlay.graph.edges
      .filter((edge: { metadata?: { relation?: string } }) => edge.metadata?.relation === 'supabase-realtime-status')
      .map((edge: { source: string }) => edge.source);
    expect(realtimeStatusSources).toEqual(expect.arrayContaining([
      methodId,
    ]));
    expect(realtimeStatusSources.every((source: string) => !source.includes('readSupabaseRealtimeStatusAction'))).toBe(true);
    expect(realtimeStatusSources.every((source: string) => !source.includes('assertRealtimeStatusFixture'))).toBe(true);
    expect(realtimeStatusSources.every((source: string) => !source.includes('mockSupabaseChannel'))).toBe(true);
    const response = JSON.parse(statusResult.stdout);
    const owner = 'RealtimeClientService.handleStatus';
    const subscribedId = `variable:src/services/realtime-client.service.ts:supabase-realtime-status:${owner}:SUBSCRIBED`;
    const errorId = `variable:src/services/realtime-client.service.ts:supabase-realtime-status:${owner}:CHANNEL_ERROR`;
    const timedOutId = `variable:src/services/realtime-client.service.ts:supabase-realtime-status:${owner}:TIMED_OUT`;
    const closedId = `variable:src/services/realtime-client.service.ts:supabase-realtime-status:${owner}:CLOSED`;

    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: subscribedId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-status',
          status: 'SUBSCRIBED',
          action: 'subscribed',
          owner,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: errorId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-status',
          status: 'CHANNEL_ERROR',
          action: 'fallback',
          owner,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: timedOutId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-status',
          status: 'TIMED_OUT',
          action: 'fallback',
          owner,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: closedId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-status',
          status: 'CLOSED',
          action: 'fallback',
          owner,
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'handleStatus',
        target: 'Realtime status SUBSCRIBED',
        relation: 'supabase-realtime-status',
        action: 'subscribed',
      }),
    ]));
    expect(response.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: expect.stringContaining('readSupabaseRealtimeStatusAction'),
      }),
      expect.objectContaining({
        source: expect.stringContaining('assertRealtimeStatusFixture'),
      }),
      expect.objectContaining({
        source: expect.stringContaining('mockSupabaseChannel'),
      }),
    ]));
    expect(response.markdown).toContain('relation: supabase-realtime-status');
  });

  it('queries Supabase Realtime lifecycle cleanup as focused native relationships', () => {
    const root = makeFixture();

    const unsubscribeResult = queryOverlay(root, 'supabase-realtime-unsubscribe', ['--limit', '20']);
    const removeChannelResult = queryOverlay(root, 'supabase-realtime-remove-channel', ['--limit', '20']);
    const removeAllChannelsResult = queryOverlay(root, 'supabase-realtime-remove-all-channels', ['--limit', '20']);

    expectSpawnSuccess(unsubscribeResult);
    expectSpawnSuccess(removeChannelResult);
    expectSpawnSuccess(removeAllChannelsResult);
    const unsubscribeResponse = JSON.parse(unsubscribeResult.stdout);
    const removeChannelResponse = JSON.parse(removeChannelResult.stdout);
    const removeAllChannelsResponse = JSON.parse(removeAllChannelsResult.stdout);
    const methodId = 'method:src/services/realtime-client.service.ts:RealtimeClientService.cleanupTasks';
    const owner = 'RealtimeClientService.cleanupTasks';
    const unsubscribeId = `variable:src/services/realtime-client.service.ts:supabase-realtime-unsubscribe:${owner}:realtime:public:tasks`;
    const removeChannelId = `variable:src/services/realtime-client.service.ts:supabase-realtime-remove-channel:${owner}:realtime:public:tasks`;
    const removeAllChannelsId = `variable:src/services/realtime-client.service.ts:supabase-realtime-remove-all-channels:${owner}`;

    expect(unsubscribeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: unsubscribeId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-unsubscribe',
          channelName: 'realtime:public:tasks',
          action: 'unsubscribe',
        }),
      }),
    ]));
    expect(removeChannelResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: removeChannelId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-remove-channel',
          channelName: 'realtime:public:tasks',
          action: 'removeChannel',
        }),
      }),
    ]));
    expect(removeAllChannelsResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: methodId,
        target: removeAllChannelsId,
        metadata: expect.objectContaining({
          relation: 'supabase-realtime-remove-all-channels',
          action: 'removeAllChannels',
        }),
      }),
    ]));
    expect(removeChannelResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'cleanupTasks',
        target: 'removeChannel realtime:public:tasks',
        relation: 'supabase-realtime-remove-channel',
      }),
    ]));
    expect(removeAllChannelsResponse.markdown).toContain('relation: supabase-realtime-remove-all-channels');
  });

  it('keeps Realtime unsubscribe cleanup when channel names are not statically known', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/services/realtime-fallback-cleanup.service.ts',
      [
        'type RealtimeChannel = {',
        '  unsubscribe(): Promise<void>;',
        '};',
        '',
        'type RealtimeClient = {',
        '  removeChannel(channel: RealtimeChannel): Promise<void>;',
        '};',
        '',
        'export async function unsubscribeRealtimeChannel(channel: RealtimeChannel): Promise<void> {',
        '  await channel.unsubscribe();',
        '}',
        '',
        'export class RealtimeFallbackCleanupService {',
        '  private channel: RealtimeChannel | null = null;',
        '',
        '  async teardown(client: RealtimeClient | null): Promise<void> {',
        '    const channel = this.channel;',
        '    this.channel = null;',
        '    if (!channel) {',
        '      return;',
        '    }',
        '',
        '    if (client) {',
        '      try {',
        '        await client.removeChannel(channel);',
        '        return;',
        '      } catch {',
        '        // Fall through to the channel-owned unsubscribe fallback below.',
        '      }',
        '    }',
        '',
        '    await channel.unsubscribe().catch(() => undefined);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);
    const unsubscribeResult = queryOverlay(root, 'supabase-realtime-unsubscribe', ['--limit', '20', '--native-json']);
    const removeChannelResult = queryOverlay(root, 'supabase-realtime-remove-channel', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(unsubscribeResult);
    expectSpawnSuccess(removeChannelResult);

    const fallbackFile = 'src/services/realtime-fallback-cleanup.service.ts';
    const unsubscribeResponse = JSON.parse(unsubscribeResult.stdout);
    const removeChannelResponse = JSON.parse(removeChannelResult.stdout);

    expect(unsubscribeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: `function:${fallbackFile}:unsubscribeRealtimeChannel`,
        target: `variable:${fallbackFile}:supabase-realtime-unsubscribe:unsubscribeRealtimeChannel:channel`,
      }),
      expect.objectContaining({
        kind: 'references',
        source: `method:${fallbackFile}:RealtimeFallbackCleanupService.teardown`,
        target: `variable:${fallbackFile}:supabase-realtime-unsubscribe:RealtimeFallbackCleanupService.teardown:channel`,
      }),
    ]));
    expect(unsubscribeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: fallbackFile,
        nodeKind: 'function',
        nodeName: 'unsubscribeRealtimeChannel',
        content: expect.stringContaining('await channel.unsubscribe();'),
      }),
      expect.objectContaining({
        filePath: fallbackFile,
        nodeKind: 'method',
        nodeName: 'teardown',
        content: expect.stringContaining('await channel.unsubscribe().catch(() => undefined);'),
      }),
    ]));
    expect(removeChannelResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: `method:${fallbackFile}:RealtimeFallbackCleanupService.teardown`,
        target: `variable:${fallbackFile}:supabase-realtime-remove-channel:RealtimeFallbackCleanupService.teardown:channel`,
      }),
    ]));
  });

  it('keeps same-channel realtime lifecycle cleanup endpoints scoped by owner', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/services/realtime-duplicate-cleanup.service.ts',
      [
        'type RealtimeChannel = {',
        '  unsubscribe(): unknown;',
        '};',
        '',
        'type RealtimeClient = {',
        '  channel(name: string): RealtimeChannel;',
        '  removeChannel(channel: RealtimeChannel): unknown;',
        '  removeAllChannels(): unknown;',
        '};',
        '',
        'export class RealtimeDuplicateCleanupService {',
        '  cleanupPrimary(client: RealtimeClient): unknown {',
        "    const channel = client.channel('realtime:public:tasks');",
        '    channel.unsubscribe();',
        '    client.removeChannel(channel);',
        '    return client.removeAllChannels();',
        '  }',
        '',
        '  cleanupSecondary(client: RealtimeClient): unknown {',
        "    const channel = client.channel('realtime:public:tasks');",
        '    channel.unsubscribe();',
        '    client.removeChannel(channel);',
        '    return client.removeAllChannels();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);
    const removeChannelResult = queryOverlay(root, 'supabase-realtime-remove-channel', ['--limit', '20', '--native-json']);
    const removeAllChannelsResult = queryOverlay(root, 'supabase-realtime-remove-all-channels', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(removeChannelResult);
    expectSpawnSuccess(removeAllChannelsResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const duplicateFile = 'src/services/realtime-duplicate-cleanup.service.ts';
    const cleanupEdges = overlay.graph.edges.filter((edge: { source?: string; metadata?: { relation?: string } }) =>
      edge.source?.startsWith(`method:${duplicateFile}:RealtimeDuplicateCleanupService.cleanup`)
      && (
        edge.metadata?.relation === 'supabase-realtime-unsubscribe'
        || edge.metadata?.relation === 'supabase-realtime-remove-channel'
        || edge.metadata?.relation === 'supabase-realtime-remove-all-channels'
      )
    );
    const targetIdsByRelation = new Map<string, Set<string>>();
    for (const edge of cleanupEdges as Array<{ target: string; metadata: { relation: string } }>) {
      const targetIds = targetIdsByRelation.get(edge.metadata.relation) ?? new Set<string>();
      targetIds.add(edge.target);
      targetIdsByRelation.set(edge.metadata.relation, targetIds);
    }

    expect(cleanupEdges).toHaveLength(6);
    expect(targetIdsByRelation.get('supabase-realtime-unsubscribe')?.size).toBe(2);
    expect(targetIdsByRelation.get('supabase-realtime-remove-channel')?.size).toBe(2);
    expect(targetIdsByRelation.get('supabase-realtime-remove-all-channels')?.size).toBe(2);

    const removeChannelResponse = JSON.parse(removeChannelResult.stdout);
    const removeAllChannelsResponse = JSON.parse(removeAllChannelsResult.stdout);
    expect(removeChannelResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: duplicateFile,
        nodeKind: 'method',
        nodeName: 'cleanupPrimary',
        content: expect.stringContaining('client.removeChannel(channel);'),
      }),
      expect.objectContaining({
        filePath: duplicateFile,
        nodeKind: 'method',
        nodeName: 'cleanupSecondary',
        content: expect.stringContaining('client.removeChannel(channel);'),
      }),
    ]));
    expect(removeAllChannelsResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: duplicateFile,
        nodeKind: 'method',
        nodeName: 'cleanupPrimary',
        content: expect.stringContaining('return client.removeAllChannels();'),
      }),
      expect.objectContaining({
        filePath: duplicateFile,
        nodeKind: 'method',
        nodeName: 'cleanupSecondary',
        content: expect.stringContaining('return client.removeAllChannels();'),
      }),
    ]));
  });
}
