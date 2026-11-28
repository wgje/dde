import { describe, expect, it } from 'vitest';
import { DEMO_PREVIEW_SCENARIOS, demoPreviewHref, resolveDemoPreviewScenario } from './demo-preview-registry';

describe('direct development preview registry', () => {
  it('has unique stable links with no entity IDs', () => {
    const links = DEMO_PREVIEW_SCENARIOS.map(example => demoPreviewHref(example.widget, example.state));
    expect(new Set(links).size).toBe(links.length);
    expect(links.every(link => link.startsWith('/#/dev-preview/'))).toBe(true);
  });
  it('resolves each declared example and rejects unknown states', () => {
    for (const example of DEMO_PREVIEW_SCENARIOS) expect(resolveDemoPreviewScenario(example.widget, example.state)).toBe(example);
    expect(resolveDemoPreviewScenario('task', 'unknown')).toBeUndefined();
    expect(resolveDemoPreviewScenario('unknown', 'active')).toBeUndefined();
  });
  it('includes before and result views for interactive changes', () => {
    expect(resolveDemoPreviewScenario('dock', 'create')).toBeDefined();
    expect(resolveDemoPreviewScenario('dock', 'created')).toBeDefined();
    expect(resolveDemoPreviewScenario('recovery', 'before')).toBeDefined();
    expect(resolveDemoPreviewScenario('recovery', 'restored')).toBeDefined();
  });
});