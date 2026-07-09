import { assertBaseOverlayAgentRules } from './codegraph-nanoflow-overlay-base-agent-rule-assertions.spec-helpers';
import { assertBaseOverlayEdgeFunctions } from './codegraph-nanoflow-overlay-base-edge-function-assertions.spec-helpers';
import { assertBaseOverlayMigrationGraph } from './codegraph-nanoflow-overlay-base-migration-graph-assertions.spec-helpers';
import { assertBaseOverlayMigrationSummary } from './codegraph-nanoflow-overlay-base-migration-summary-assertions.spec-helpers';

type ParsedOverlay = ReturnType<typeof JSON.parse>;

export function assertBaseOverlaySupabaseAndRules(overlay: ParsedOverlay): void {
    assertBaseOverlayEdgeFunctions(overlay);
    assertBaseOverlayMigrationSummary(overlay);
    assertBaseOverlayMigrationGraph(overlay);
    assertBaseOverlayAgentRules(overlay);
}
