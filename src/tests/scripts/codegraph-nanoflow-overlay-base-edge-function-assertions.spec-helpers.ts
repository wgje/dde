import { expect } from 'vitest';

type ParsedOverlay = ReturnType<typeof JSON.parse>;

export function assertBaseOverlayEdgeFunctions(overlay: ParsedOverlay): void {
  expect(overlay.supabase.edgeFunctions).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: 'transcribe',
      entry: 'supabase/functions/transcribe/index.ts',
      sourceFiles: [
        'supabase/functions/transcribe/index.ts',
        'supabase/functions/_shared/edge-env.ts',
      ],
      imports: [
        {
          source: 'supabase/functions/transcribe/index.ts',
          target: 'supabase/functions/_shared/edge-env.ts',
        },
      ],
      envVars: ['GROQ_API_KEY', 'SUPABASE_URL', 'SHARED_EDGE_SECRET'],
      routes: [
        expect.objectContaining({
          path: '/functions/v1/transcribe',
          invokeName: 'transcribe',
        }),
      ],
      methods: [
        expect.objectContaining({ method: 'OPTIONS' }),
        expect.objectContaining({ method: 'POST' }),
      ],
      headers: [
        expect.objectContaining({ header: 'Authorization', normalizedHeader: 'authorization' }),
        expect.objectContaining({ header: 'Origin', normalizedHeader: 'origin' }),
        expect.objectContaining({ header: 'content-length', normalizedHeader: 'content-length' }),
      ],
      supabaseRpcCalls: [
        expect.objectContaining({
          functionName: 'consume_transcription_quota',
          argNames: ['user_id'],
        }),
      ],
      tests: expect.arrayContaining([
        'src/tests/contracts/transcribe-edge-function.contract.spec.ts',
        'src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
      ]),
      testMappings: expect.arrayContaining([
        expect.objectContaining({
          file: 'src/tests/contracts/transcribe-edge-function.contract.spec.ts',
          testMapping: 'path-reference',
          matchedNeedle: 'supabase/functions/transcribe/index.ts',
        }),
        expect.objectContaining({
          file: 'src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
          testMapping: 'route-reference',
          matchedNeedle: '/functions/v1/transcribe',
        }),
        expect.objectContaining({
          file: 'src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
          testMapping: 'invoke-reference',
          matchedNeedle: "functions.invoke('transcribe'",
        }),
      ]),
    }),
    expect.objectContaining({
      name: 'widget-focus-action',
      entry: 'supabase/functions/widget-focus-action/index.ts',
      sourceFiles: [
        'supabase/functions/widget-focus-action/index.ts',
        'supabase/functions/_shared/widget-common.ts',
      ],
      imports: [
        {
          source: 'supabase/functions/widget-focus-action/index.ts',
          target: 'supabase/functions/_shared/widget-common.ts',
        },
      ],
      routes: [
        expect.objectContaining({
          path: '/functions/v1/widget-focus-action',
          invokeName: 'widget-focus-action',
        }),
      ],
      methods: expect.arrayContaining([
        expect.objectContaining({
          method: 'OPTIONS',
          methodSource: 'method-equality',
        }),
        expect.objectContaining({
          method: 'OPTIONS',
          methodSource: 'cors-allowed-methods',
        }),
        expect.objectContaining({
          method: 'POST',
          methodSource: 'cors-allowed-methods',
        }),
        expect.objectContaining({
          method: 'POST',
          methodSource: 'method-inequality-guard',
        }),
      ]),
      headers: [
        expect.objectContaining({ header: 'Origin', normalizedHeader: 'origin' }),
      ],
    }),
  ]));
  expect(overlay.supabase.edgeFunctions).toHaveLength(2);

  const edgeFunctionId = 'function:supabase/functions/transcribe/index.ts:transcribe';
  const widgetEdgeFunctionId = 'function:supabase/functions/widget-focus-action/index.ts:widget-focus-action';
  expect(overlay.graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      target: 'file:src/tests/contracts/transcribe-edge-function.contract.spec.ts:src/tests/contracts/transcribe-edge-function.contract.spec.ts',
      metadata: expect.objectContaining({
        relation: 'test',
        testMapping: 'path-reference',
        matchedNeedle: 'supabase/functions/transcribe/index.ts',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      target: 'file:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
      metadata: expect.objectContaining({
        relation: 'test',
        testMapping: 'route-reference',
        matchedNeedle: '/functions/v1/transcribe',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      target: 'file:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts:src/tests/contracts/transcribe-edge-function-invoke.contract.spec.ts',
      metadata: expect.objectContaining({
        relation: 'test',
        testMapping: 'invoke-reference',
        matchedNeedle: "functions.invoke('transcribe'",
      }),
    }),
    expect.objectContaining({
      kind: 'imports',
      source: edgeFunctionId,
      target: 'file:supabase/functions/_shared/edge-env.ts:supabase/functions/_shared/edge-env.ts',
      metadata: expect.objectContaining({
        relation: 'edge-function-source',
        sourceFile: 'supabase/functions/transcribe/index.ts',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      metadata: expect.objectContaining({
        relation: 'edge-function-route',
        path: '/functions/v1/transcribe',
        invokeName: 'transcribe',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      metadata: expect.objectContaining({
        relation: 'edge-function-method',
        method: 'OPTIONS',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      metadata: expect.objectContaining({
        relation: 'edge-function-method',
        method: 'POST',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      metadata: expect.objectContaining({
        relation: 'edge-function-header',
        header: 'Authorization',
        normalizedHeader: 'authorization',
        sourceFile: 'supabase/functions/transcribe/index.ts',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: edgeFunctionId,
      target: 'variable:supabase/functions/transcribe/index.ts:supabase-rpc:consume_transcription_quota',
      metadata: expect.objectContaining({
        relation: 'supabase-rpc',
        functionName: 'consume_transcription_quota',
        argNames: ['user_id'],
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: widgetEdgeFunctionId,
      metadata: expect.objectContaining({
        relation: 'edge-function-method',
        method: 'POST',
        methodSource: 'cors-allowed-methods',
        sourceFile: 'supabase/functions/widget-focus-action/index.ts',
      }),
    }),
    expect.objectContaining({
      kind: 'references',
      source: widgetEdgeFunctionId,
      metadata: expect.objectContaining({
        relation: 'edge-function-method',
        method: 'POST',
        methodSource: 'method-inequality-guard',
        sourceFile: 'supabase/functions/widget-focus-action/index.ts',
      }),
    }),
  ]));
}
