import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayEdgeFunctionCodeBlockSpecs } from './codegraph-nanoflow-overlay-query-edge-function-code-blocks.spec-helpers';
import { registerCodegraphOverlayEdgeFunctionTestMappingNoiseSpecs } from './codegraph-nanoflow-overlay-query-edge-function-test-mapping-noise.spec-helpers';

export function registerCodegraphOverlayEdgeFunctionQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess, writeFile } = context;
  it('queries Supabase Edge Function routes and methods as focused native relationships', () => {
    const root = makeFixture();

    const routeResult = queryOverlay(root, 'edge-function-route', ['--limit', '20']);
    const methodResult = queryOverlay(root, 'edge-function-method', ['--limit', '20']);

    expectSpawnSuccess(routeResult);
    expectSpawnSuccess(methodResult);
    const routeResponse = JSON.parse(routeResult.stdout);
    const methodResponse = JSON.parse(methodResult.stdout);

    expect(routeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', name: 'transcribe' }),
      expect.objectContaining({
        kind: 'route',
        name: '/functions/v1/transcribe',
        filePath: 'supabase/functions/transcribe/index.ts',
      }),
    ]));
    expect(routeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        metadata: expect.objectContaining({
          relation: 'edge-function-route',
          path: '/functions/v1/transcribe',
          invokeName: 'transcribe',
        }),
      }),
    ]));
    expect(routeResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'transcribe',
        target: '/functions/v1/transcribe',
        relation: 'edge-function-route',
      }),
    ]));
    expect(routeResponse.markdown).toContain('## Exploration: edge-function-route');
    expect(routeResponse.markdown).toContain('transcribe → /functions/v1/transcribe');
    expect(routeResponse.markdown).toContain('relation: edge-function-route');

    expect(methodResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        metadata: expect.objectContaining({
          relation: 'edge-function-method',
          method: 'OPTIONS',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        metadata: expect.objectContaining({
          relation: 'edge-function-method',
          method: 'POST',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/widget-focus-action/index.ts:widget-focus-action',
        metadata: expect.objectContaining({
          relation: 'edge-function-method',
          method: 'OPTIONS',
          methodSource: 'method-equality',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/widget-focus-action/index.ts:widget-focus-action',
        metadata: expect.objectContaining({
          relation: 'edge-function-method',
          method: 'POST',
          methodSource: 'cors-allowed-methods',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/widget-focus-action/index.ts:widget-focus-action',
        metadata: expect.objectContaining({
          relation: 'edge-function-method',
          method: 'POST',
          methodSource: 'method-inequality-guard',
        }),
      }),
    ]));
  });

  registerCodegraphOverlayEdgeFunctionCodeBlockSpecs(context);
  it('queries Supabase Edge Function request headers as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'edge-function-header', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);

    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'transcribe',
        filePath: 'supabase/functions/transcribe/index.ts',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'Authorization',
        filePath: 'supabase/functions/transcribe/index.ts',
        metadata: expect.objectContaining({
          relation: 'edge-function-header',
          header: 'Authorization',
          normalizedHeader: 'authorization',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        metadata: expect.objectContaining({
          relation: 'edge-function-header',
          header: 'Authorization',
          normalizedHeader: 'authorization',
          sourceFile: 'supabase/functions/transcribe/index.ts',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'transcribe',
        target: 'Authorization',
        relation: 'edge-function-header',
        header: 'Authorization',
      }),
    ]));
    expect(response.markdown).toContain('relation: edge-function-header');
  });

  it('keeps shared helper Edge Function header and method targets scoped per function', () => {
    const root = makeFixture();
    writeFile(
      root,
      'supabase/functions/_shared/shared-gateway.ts',
      [
        'export function readSharedGateway(req: Request): Response | null {',
        "  const authHeader = req.headers.get('x-shared-auth');",
        '  switch (req.method) {',
        "    case 'PATCH':",
        "      return new Response(authHeader ?? 'missing');",
        '    default:',
        '      return null;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    for (const name of ['alpha-action', 'beta-action']) {
      writeFile(
        root,
        `supabase/functions/${name}/index.ts`,
        [
          "import { readSharedGateway } from '../_shared/shared-gateway';",
          'Deno.serve((req) => readSharedGateway(req) ?? new Response("ok"));',
          '',
        ].join('\n'),
      );
    }

    const headerResult = queryOverlay(root, 'edge-function-header', ['--limit', '200']);
    const methodResult = queryOverlay(root, 'edge-function-method', ['--limit', '200']);

    expectSpawnSuccess(headerResult);
    expectSpawnSuccess(methodResult);
    const headerResponse = JSON.parse(headerResult.stdout);
    const methodResponse = JSON.parse(methodResult.stdout);

    for (const name of ['alpha-action', 'beta-action']) {
      expect(headerResponse.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'references',
          source: `function:supabase/functions/${name}/index.ts:${name}`,
          target: `variable:supabase/functions/_shared/shared-gateway.ts:edge-function-header:${name}:x-shared-auth:2`,
          metadata: expect.objectContaining({
            relation: 'edge-function-header',
            header: 'x-shared-auth',
            normalizedHeader: 'x-shared-auth',
            sourceFile: 'supabase/functions/_shared/shared-gateway.ts',
          }),
        }),
      ]));
      expect(methodResponse.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'references',
          source: `function:supabase/functions/${name}/index.ts:${name}`,
          target: `variable:supabase/functions/_shared/shared-gateway.ts:edge-function-method:${name}:PATCH:4`,
          metadata: expect.objectContaining({
            relation: 'edge-function-method',
            method: 'PATCH',
            sourceFile: 'supabase/functions/_shared/shared-gateway.ts',
          }),
        }),
      ]));
    }
  });

  it('keeps multi-endpoint Edge Function relation queries from overconstraining to one edge', () => {
    const root = makeFixture();
    writeFile(
      root,
      'supabase/functions/virus-scan/index.ts',
      [
        'Deno.serve((req) => {',
        "  if (req.method === 'OPTIONS') {",
        "    return new Response('ok');",
        '  }',
        "  if (req.method === 'POST') {",
        "    return new Response('accepted');",
        '  }',
        "  return new Response('Method not allowed', { status: 405 });",
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/services/virus-scan.service.ts',
      [
        'export class VirusScanService {',
        ...Array.from({ length: 30 }, (_, index) => `  scanNoise${index}(): string { return 'virus-scan'; }`),
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'edge-function-method transcribe virus-scan',
      ['--limit', '20'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const relationEdges = response.edges.filter((edge: { source?: string; metadata?: { relation?: string } }) =>
      edge.metadata?.relation === 'edge-function-method'
      && (
        edge.source === 'function:supabase/functions/transcribe/index.ts:transcribe'
        || edge.source === 'function:supabase/functions/virus-scan/index.ts:virus-scan'
      )
    );

    expect(relationEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
      }),
      expect.objectContaining({
        source: 'function:supabase/functions/virus-scan/index.ts:virus-scan',
      }),
    ]));
    expect(new Set(relationEdges.map((edge: { source?: string }) => edge.source)).size).toBe(2);
    expect(response.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'transcribe' }),
      expect.objectContaining({ name: 'virus-scan' }),
    ]));
  });

  it('queries Supabase Edge Function invokes from client calls as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'edge-function-invoke', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'method:src/services/transcribe-client.service.ts:TranscribeClientService.invokeTranscribe',
        kind: 'method',
        name: 'invokeTranscribe',
        filePath: 'src/services/transcribe-client.service.ts',
      }),
      expect.objectContaining({
        id: 'route:supabase/functions/transcribe/index.ts:/functions/v1/transcribe',
        kind: 'route',
        name: '/functions/v1/transcribe',
        filePath: 'supabase/functions/transcribe/index.ts',
        metadata: expect.objectContaining({
          relation: 'edge-function-route',
          invokeName: 'transcribe',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/services/transcribe-client.service.ts:TranscribeClientService.invokeTranscribe',
        target: 'route:supabase/functions/transcribe/index.ts:/functions/v1/transcribe',
        metadata: expect.objectContaining({
          relation: 'edge-function-invoke',
          invokeName: 'transcribe',
          path: '/functions/v1/transcribe',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'invokeTranscribe',
        target: '/functions/v1/transcribe',
        relation: 'edge-function-invoke',
        invokeName: 'transcribe',
      }),
    ]));
    expect(response.markdown).toContain('relation: edge-function-invoke');
  });

  it('prioritizes explicit Edge Function source for mixed invoke and route-reference quality queries', () => {
    const root = makeFixture();

    const result = queryOverlay(
      root,
      'supabase functions transcribe edge-function-invoke route-reference source ordering',
      ['--limit', '20'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'transcribe',
      filePath: 'supabase/functions/transcribe/index.ts',
    }));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'supabase/functions/transcribe/index.ts',
      nodeName: 'transcribe',
    }));
    expect(response.markdown.indexOf('#### supabase/functions/transcribe/index.ts'))
      .toBeLessThan(response.markdown.indexOf('### Related Symbols'));
    expect(response.markdown).not.toContain('#### docs/context7/');
  });

  it('prioritizes explicit Edge Function source before route-reference test evidence for source-quality queries', () => {
    const root = makeFixture();

    const result = queryOverlay(
      root,
      'supabase functions transcribe route-reference source ordering',
      ['--limit', '20'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'transcribe',
      filePath: 'supabase/functions/transcribe/index.ts',
    }));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'supabase/functions/transcribe/index.ts',
      nodeName: 'transcribe',
    }));
    expect(response.codeBlocks.map((block: { filePath?: string }) => block.filePath))
      .toContain('src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts');
  });

  it('queries Supabase RPC calls inside Edge Function entrypoints as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'supabase-rpc consume_transcription_quota', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'function:supabase/functions/transcribe/index.ts:transcribe',
        kind: 'function',
        name: 'transcribe',
        filePath: 'supabase/functions/transcribe/index.ts',
      }),
      expect.objectContaining({
        id: 'variable:supabase/functions/transcribe/index.ts:supabase-rpc:consume_transcription_quota',
        kind: 'variable',
        name: 'consume_transcription_quota',
        filePath: 'supabase/functions/transcribe/index.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-rpc',
          functionName: 'consume_transcription_quota',
          argNames: ['user_id'],
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        target: 'variable:supabase/functions/transcribe/index.ts:supabase-rpc:consume_transcription_quota',
        metadata: expect.objectContaining({
          relation: 'supabase-rpc',
          functionName: 'consume_transcription_quota',
          argNames: ['user_id'],
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'transcribe',
        target: 'consume_transcription_quota',
        relation: 'supabase-rpc',
        functionName: 'consume_transcription_quota',
      }),
    ]));
    expect(response.markdown).toContain('relation: supabase-rpc');
  });

  it('queries Supabase test mapping provenance as focused native relationships', () => {
    const root = makeFixture();

    const routeResult = queryOverlay(root, 'route-reference', ['--limit', '20']);
    const invokeResult = queryOverlay(root, 'invoke-reference', ['--limit', '20']);
    const filenameResult = queryOverlay(root, 'filename-reference', ['--limit', '20']);

    expectSpawnSuccess(routeResult);
    expectSpawnSuccess(invokeResult);
    expectSpawnSuccess(filenameResult);
    const routeResponse = JSON.parse(routeResult.stdout);
    const invokeResponse = JSON.parse(invokeResult.stdout);
    const filenameResponse = JSON.parse(filenameResult.stdout);

    expect(routeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        target: 'file:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'route-reference',
          matchedNeedle: '/functions/v1/transcribe',
        }),
      }),
    ]));
    expect(routeResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'transcribe',
        target: 'src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
        relation: 'test',
        testMapping: 'route-reference',
        matchedNeedle: '/functions/v1/transcribe',
      }),
    ]));
    expect(routeResponse.markdown).toContain('testMapping: route-reference');

    expect(invokeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        target: 'file:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'invoke-reference',
          matchedNeedle: "functions.invoke('transcribe'",
        }),
      }),
    ]));
    expect(invokeResponse.markdown).toContain('testMapping: invoke-reference');

    expect(filenameResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'file:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:20260609020000_drop_entity_uuid_defaults.sql',
        target: 'file:src/tests/contracts/drop-entity-uuid-defaults.contract.spec.ts:src/tests/contracts/drop-entity-uuid-defaults.contract.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'filename-reference',
          matchedNeedle: '20260609020000_drop_entity_uuid_defaults.sql',
        }),
      }),
    ]));
    expect(filenameResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '20260609020000_drop_entity_uuid_defaults.sql',
        target: 'src/tests/contracts/drop-entity-uuid-defaults.contract.spec.ts',
        relation: 'test',
        testMapping: 'filename-reference',
      }),
    ]));
    expect(filenameResponse.markdown).toContain('testMapping: filename-reference');
  });

  registerCodegraphOverlayEdgeFunctionTestMappingNoiseSpecs(context);
}
