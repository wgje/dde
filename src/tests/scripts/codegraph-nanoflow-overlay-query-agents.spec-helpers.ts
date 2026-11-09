import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayAgentConfigQuerySpecs } from './codegraph-nanoflow-overlay-query-agents-config.spec-helpers';
import { registerCodegraphOverlayAgentHardRuleQuerySpecs } from './codegraph-nanoflow-overlay-query-agents-hard-rules.spec-helpers';
import { registerCodegraphOverlayAgentPredicateQuerySpecs } from './codegraph-nanoflow-overlay-query-agents-predicates.spec-helpers';
import { registerCodegraphOverlayAgentSyncFieldQuerySpecs } from './codegraph-nanoflow-overlay-query-agents-sync-fields.spec-helpers';

export function registerCodegraphOverlayAgentRuleQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess, repoRoot, queryScriptPath } = context;
  registerCodegraphOverlayAgentHardRuleQuerySpecs(context);

  it('queries AGENTS sync rules by synchronization keywords', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'RetryQueue');
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agent-sync-rule',
        name: 'Write path',
        file: 'AGENTS.md',
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'Write path',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule',
          ownerHeading: '5.2 Offline-first',
          keywords: expect.arrayContaining(['RetryQueue']),
        }),
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'RetryQueue',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'Write path',
        target: 'RetryQueue',
        relation: 'sync-rule-keyword',
        keywordMapping: 'sync-body-keyword',
        matchedNeedle: 'RetryQueue',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          keyword: 'RetryQueue',
          keywordMapping: 'sync-body-keyword',
          matchedNeedle: 'RetryQueue',
        }),
      }),
    ]));
    expect(response.markdown).toContain('Write path');
  });

  it('uses AGENTS sync body keyword endpoints as strict native entry points', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'sync-body-keyword', ['--native-json', '--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const entryPoints = response.entryPoints as Array<{
      filePath?: string;
      kind?: string;
      name?: string;
    }>;

    expect(entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'incremental pull',
        filePath: 'AGENTS.md',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'debounce',
        filePath: 'AGENTS.md',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'LWW',
        filePath: 'AGENTS.md',
      }),
    ]));
    expect(entryPoints[0]?.name).not.toBe('AUTH_CONFIG.LOCAL_MODE_USER_ID');
  });

  it('uses AGENTS sync body keyword evidence lines in strict native Markdown', () => {
    const root = makeFixture();
    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'sync-body-keyword',
      '--native-markdown',
      '--limit',
      '20',
      '--skip-refresh',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    const codeContextIndex = result.stdout.indexOf('## Code Context');
    const entryPointsIndex = result.stdout.indexOf('### Entry Points');
    const relationshipsIndex = result.stdout.indexOf('### Relationships');
    const relatedSymbolsIndex = result.stdout.indexOf('### Related Symbols');
    const codeIndex = result.stdout.indexOf('### Code');
    const entryPoints = result.stdout.slice(entryPointsIndex, relationshipsIndex);
    const code = result.stdout.slice(codeIndex);

    expect(codeContextIndex).toBeGreaterThanOrEqual(0);
    expect(entryPointsIndex).toBeGreaterThan(codeContextIndex);
    expect(relationshipsIndex).toBeGreaterThan(entryPointsIndex);
    expect(relatedSymbolsIndex).toBeGreaterThan(relationshipsIndex);
    expect(codeIndex).toBeGreaterThan(relatedSymbolsIndex);
    expect(entryPoints).toContain('- **incremental pull** (variable) - AGENTS.md:9');
    expect(entryPoints).toContain('- **debounce** (variable) - AGENTS.md:7');
    expect(entryPoints).toContain('- **LWW** (variable) - AGENTS.md:8');
    expect(entryPoints).not.toContain('AUTH_CONFIG.LOCAL_MODE_USER_ID');
    expect(code).toContain('#### incremental pull (AGENTS.md:9)');
    expect(code).toContain('- Read path: IndexedDB -> incremental pull using updated_at > last_sync_time.');
    expect(code).toContain('#### debounce (AGENTS.md:7)');
    expect(code).toContain('- Write path: local write + UI immediate update -> 3s debounce push -> failure enters RetryQueue.');
    expect(code).toContain('#### LWW (AGENTS.md:8)');
    expect(code).toContain('- Conflict policy: LWW.');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('uses AGENTS sync config keyword endpoints as strict native entry points', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'sync-config-keyword', ['--native-json', '--limit', '20']);
    const markdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'sync-config-keyword',
      '--native-markdown',
      '--limit',
      '20',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    expectSpawnSuccess(result);
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    const entryPoints = response.entryPoints as Array<{
      filePath?: string;
      kind?: string;
      name?: string;
    }>;
    const expectedConfigOrder = [
      'SYNC_CONFIG.DEBOUNCE_DELAY',
      'SYNC_CONFIG.CLOUD_LOAD_TIMEOUT',
      'SYNC_CONFIG.POLLING_INTERVAL',
      'SYNC_CONFIG.POLLING_ACTIVE_INTERVAL',
      'SYNC_CONFIG.REALTIME_ENABLED',
    ];

    expect(entryPoints.slice(0, 5)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        filePath: 'AGENTS.md',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'SYNC_CONFIG.CLOUD_LOAD_TIMEOUT',
        filePath: 'AGENTS.md',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'SYNC_CONFIG.POLLING_INTERVAL',
        filePath: 'AGENTS.md',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'SYNC_CONFIG.POLLING_ACTIVE_INTERVAL',
        filePath: 'AGENTS.md',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'SYNC_CONFIG.REALTIME_ENABLED',
        filePath: 'AGENTS.md',
      }),
    ]));
    expect(markdownResult.stdout).toContain([
      '- AGENTS.md: SYNC_CONFIG.DEBOUNCE_DELAY:16, SYNC_CONFIG.CLOUD_LOAD_TIMEOUT:17, SYNC_CONFIG.POLLING_INTERVAL:18, SYNC_CONFIG.POLLING_ACTIVE_INTERVAL:19, SYNC_CONFIG.REALTIME_ENABLED:20',
    ].join('\n'));
    const defaultResult = queryOverlay(root, 'sync-config-keyword', ['--limit', '20']);
    expectSpawnSuccess(defaultResult);
    const defaultResponse = JSON.parse(defaultResult.stdout);
    expect((defaultResponse.relationshipGroups.references as Array<{
      keywordMapping?: string;
      keyword?: string;
    }>)
      .filter(edge => edge.keywordMapping === 'sync-config-keyword')
      .map(edge => edge.keyword)
      .slice(0, expectedConfigOrder.length)).toEqual(expectedConfigOrder);
    expect(defaultResponse.markdown).toContain([
      '- AGENTS.md: SYNC_CONFIG.DEBOUNCE_DELAY:16, SYNC_CONFIG.CLOUD_LOAD_TIMEOUT:17, SYNC_CONFIG.POLLING_INTERVAL:18, SYNC_CONFIG.POLLING_ACTIVE_INTERVAL:19, SYNC_CONFIG.REALTIME_ENABLED:20',
    ].join('\n'));
    const expectedVisibleRelationshipOrder = expectedConfigOrder.slice(0, 4);
    const defaultRelationshipOffsets = expectedVisibleRelationshipOrder.map(key => defaultResponse.markdown.indexOf(`${key} → ${key}`));
    expect(defaultRelationshipOffsets.every(offset => offset >= 0)).toBe(true);
    expect(defaultRelationshipOffsets).toEqual([...defaultRelationshipOffsets].sort((a, b) => a - b));
    const defaultBlastRadiusOffsets = expectedConfigOrder.slice(0, 2)
      .map(key => defaultResponse.markdown.indexOf(`\`${key}\` (AGENTS.md`));
    expect(defaultBlastRadiusOffsets.every(offset => offset >= 0)).toBe(true);
    expect(defaultBlastRadiusOffsets).toEqual([...defaultBlastRadiusOffsets].sort((a, b) => a - b));
  });

  it('queries AGENTS keyword provenance as focused native relationships', () => {
    const root = makeFixture();
    const hardRuleResult = queryOverlay(root, 'hard-rule-keyword', ['--limit', '20']);
    const syncBodyResult = queryOverlay(root, 'sync-body-keyword', ['--limit', '20']);
    const syncConfigResult = queryOverlay(root, 'sync-config-keyword', ['--limit', '20']);

    expectSpawnSuccess(hardRuleResult);
    expectSpawnSuccess(syncBodyResult);
    expectSpawnSuccess(syncConfigResult);
    const hardRuleResponse = JSON.parse(hardRuleResult.stdout);
    const syncBodyResponse = JSON.parse(syncBodyResult.stdout);
    const syncConfigResponse = JSON.parse(syncConfigResult.stdout);

    expect(hardRuleResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'hard-rule-keyword',
          keywordMapping: 'hard-rule-keyword',
          matchedNeedle: 'crypto.randomUUID()',
        }),
      }),
    ]));
    expect(hardRuleResponse.markdown).toContain('keywordMapping: hard-rule-keyword');

    expect(syncBodyResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          keywordMapping: 'sync-body-keyword',
          matchedNeedle: 'RetryQueue',
        }),
      }),
    ]));
    expect(syncBodyResponse.markdown).toContain('keywordMapping: sync-body-keyword');

    expect(syncConfigResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          keywordMapping: 'sync-config-keyword',
          matchedNeedle: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        }),
      }),
    ]));
    expect(syncConfigResponse.markdown).toContain('keywordMapping: sync-config-keyword');
  });

  registerCodegraphOverlayAgentConfigQuerySpecs(context);
  registerCodegraphOverlayAgentSyncFieldQuerySpecs(context);
  registerCodegraphOverlayAgentPredicateQuerySpecs(context);
}
