import { expect, it } from 'vitest';

import { makeFixture, runSync, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

export function registerValidateCodegraphOverlayDocsDriftCountSpecs(): void {
  it('fails when documented Supabase operation and Realtime node counts drift from the overlay', () => {
    const root = makeFixture({
      supabaseRealtimeChannelNodesInDocs: 0,
      supabaseRealtimePostgresChangeNodesInDocs: 0,
      supabaseRealtimeRemoveChannelNodesInDocs: 0,
      supabaseSelectFieldNodesInDocs: 0,
      inlineSelectFieldNodesInDocs: 0,
      supabaseIncrementalPredicateNodesInDocs: 0,
      supabaseStorageBucketNodesInDocs: 0,
      supabaseRpcNodesInDocs: 0,
      supabaseTableWriteNodesInDocs: 0,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md supabaseRealtimeChannelNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md supabaseRealtimePostgresChangeNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md supabaseRealtimeRemoveChannelNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md supabaseSelectFieldNodes expected 2, found 0');
    expect(result.stderr).toContain('AGENTS.md inlineSelectFieldNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md supabaseIncrementalPredicateNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md supabaseStorageBucketNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md supabaseRpcNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md supabaseTableWriteNodes expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md supabaseRealtimeChannelNodes expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md supabaseSelectFieldNodes expected 2, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md supabaseRpcNodes expected 1, found 0');
  });

  it('fails when documented test mapping counts drift from the overlay', () => {
    const root = makeFixture({ totalTestEdgesInDocs: 4 });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md totalTestEdges expected 5, found 4');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md totalTestEdges expected 5, found 4');
  });

  it('fails when documented Realtime status layer prose drifts from the overlay', () => {
    const root = makeFixture({ realtimeStatusLayerCountInDocs: 0 });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md supabaseRealtimeStatusNodes expected 1, found 0');
  });

  it('syncs documented Realtime status layer prose counts from the overlay', () => {
    const root = makeFixture({ realtimeStatusLayerCountInDocs: 0 });

    const syncResult = runSync(root);
    const result = runValidator(root);

    expect(syncResult.status, syncResult.stderr || syncResult.stdout).toBe(0);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
}
