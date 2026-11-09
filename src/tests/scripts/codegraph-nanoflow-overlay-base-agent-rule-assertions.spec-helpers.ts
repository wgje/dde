import { expect } from 'vitest';

type ParsedOverlay = ReturnType<typeof JSON.parse>;

export function assertBaseOverlayAgentRules(overlay: ParsedOverlay): void {
  expect(overlay.agentRules.hardRules).toEqual([
    expect.objectContaining({
      heading: '5.1 ID Strategy',
      keywords: expect.arrayContaining(['crypto.randomUUID()', 'database autoincrement ID']),
    }),
    expect.objectContaining({ heading: '5.2 Offline-first' }),
  ]);

  const idStrategyId = 'variable:AGENTS.md:5.1 ID Strategy';
  const randomUuidKeywordId = 'variable:AGENTS.md:hard-rule-keyword:5.1 ID Strategy:crypto.randomUUID()';
  expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: randomUuidKeywordId,
      kind: 'variable',
      name: 'crypto.randomUUID()',
      filePath: 'AGENTS.md',
      metadata: expect.objectContaining({
        relation: 'hard-rule-keyword',
        rule: '5.1 ID Strategy',
      }),
    }),
  ]));
  expect(overlay.graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'references',
      source: idStrategyId,
      target: randomUuidKeywordId,
      metadata: expect.objectContaining({
        relation: 'hard-rule-keyword',
        keyword: 'crypto.randomUUID()',
      }),
    }),
  ]));
  expect(overlay.agentRules.syncRules).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: 'Write path',
      ownerHeading: '5.2 Offline-first',
      keywords: expect.arrayContaining(['RetryQueue', 'debounce', 'local write']),
    }),
    expect.objectContaining({
      name: 'Conflict policy',
      ownerHeading: '5.2 Offline-first',
      keywords: expect.arrayContaining(['LWW']),
    }),
    expect.objectContaining({
      name: 'Read path',
      ownerHeading: '5.2 Offline-first',
      keywords: expect.arrayContaining(['IndexedDB', 'incremental pull', 'updated_at', 'last_sync_time']),
    }),
    expect.objectContaining({
      name: 'SYNC_CONFIG.DEBOUNCE_DELAY',
      ownerHeading: '9. Key Config',
      body: '3000ms',
      keywords: expect.arrayContaining(['SYNC_CONFIG.DEBOUNCE_DELAY', 'debounce']),
    }),
  ]));
}
