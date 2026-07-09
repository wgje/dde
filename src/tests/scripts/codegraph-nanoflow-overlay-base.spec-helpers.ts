import { it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { assertBaseOverlayAngularAndGraph } from './codegraph-nanoflow-overlay-base-assertions.spec-helpers';
import { assertBaseOverlaySupabaseAndRules } from './codegraph-nanoflow-overlay-base-supabase-assertions.spec-helpers';

export function registerCodegraphOverlayBaseSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, runOverlay, expectSpawnSuccess } = context;

  it('emits NanoFlow-specific relationships that base codegraph misses', () => {
    const root = makeFixture();

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    assertBaseOverlayAngularAndGraph(overlay, root);
    assertBaseOverlaySupabaseAndRules(overlay);
  });
}
