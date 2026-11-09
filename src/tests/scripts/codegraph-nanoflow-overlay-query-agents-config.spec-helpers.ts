import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAgentConfigQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess, repoRoot, queryScriptPath } = context;

  it('queries AGENTS configuration baselines as focused native source relationships', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'config-source', ['--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule:9. Key Config:SYNC_CONFIG.DEBOUNCE_DELAY',
        target: 'property:src/config/sync.config.ts:SYNC_CONFIG.DEBOUNCE_DELAY',
        metadata: expect.objectContaining({
          relation: 'config-source',
          configKey: 'SYNC_CONFIG.DEBOUNCE_DELAY',
          configObject: 'SYNC_CONFIG',
          configProperty: 'DEBOUNCE_DELAY',
          configPath: 'DEBOUNCE_DELAY',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule:9. Key Config:SYNC_CONFIG.REALTIME_ENABLED',
        target: 'property:src/config/sync.config.ts:SYNC_CONFIG.REALTIME_ENABLED',
        metadata: expect.objectContaining({
          relation: 'config-source',
          configKey: 'SYNC_CONFIG.REALTIME_ENABLED',
          configObject: 'SYNC_CONFIG',
          configProperty: 'REALTIME_ENABLED',
          configPath: 'REALTIME_ENABLED',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule:9. Key Config:TIMEOUT_CONFIG.QUICK',
        target: 'property:src/config/timeout.config.ts:TIMEOUT_CONFIG.QUICK',
        metadata: expect.objectContaining({
          relation: 'config-source',
          configKey: 'TIMEOUT_CONFIG.QUICK',
          configObject: 'TIMEOUT_CONFIG',
          configProperty: 'QUICK',
          configPath: 'QUICK',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule:9. Key Config:AUTH_CONFIG.LOCAL_MODE_USER_ID',
        target: 'property:src/config/auth.config.ts:AUTH_CONFIG.LOCAL_MODE_USER_ID',
        metadata: expect.objectContaining({
          relation: 'config-source',
          configKey: 'AUTH_CONFIG.LOCAL_MODE_USER_ID',
          configObject: 'AUTH_CONFIG',
          configProperty: 'LOCAL_MODE_USER_ID',
          configPath: 'LOCAL_MODE_USER_ID',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule:9. Key Config:FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        target: 'property:src/config/focus.config.ts:FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        metadata: expect.objectContaining({
          relation: 'config-source',
          configKey: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
          configObject: 'FOCUS_CONFIG',
          configProperty: 'MAX_SNOOZE_PER_DAY',
          configPath: 'GATE.MAX_SNOOZE_PER_DAY',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'TIMEOUT_CONFIG.QUICK',
        target: 'TIMEOUT_CONFIG.QUICK',
        relation: 'config-source',
        configPath: 'QUICK',
      }),
      expect.objectContaining({
        source: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        target: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        relation: 'config-source',
        configPath: 'GATE.MAX_SNOOZE_PER_DAY',
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'property',
        name: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        qualifiedName: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        filePath: 'src/config/focus.config.ts',
        metadata: expect.objectContaining({
          relation: 'config-property',
          configObject: 'FOCUS_CONFIG',
          configPath: 'GATE.MAX_SNOOZE_PER_DAY',
          configProperty: 'MAX_SNOOZE_PER_DAY',
        }),
      }),
    ]));
    expect(response.markdown).toContain('relation: config-source');
  });

  it('queries AGENTS configuration property containment as native parent-child relationships', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'config-property', ['--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'property:src/config/focus.config.ts:FOCUS_CONFIG.GATE',
        kind: 'property',
        name: 'FOCUS_CONFIG.GATE',
        qualifiedName: 'FOCUS_CONFIG.GATE',
        metadata: expect.objectContaining({
          relation: 'config-property',
          configObject: 'FOCUS_CONFIG',
          configPath: 'GATE',
          configProperty: 'GATE',
        }),
      }),
      expect.objectContaining({
        id: 'property:src/config/focus.config.ts:FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        kind: 'property',
        name: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        qualifiedName: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        metadata: expect.objectContaining({
          relation: 'config-property',
          configObject: 'FOCUS_CONFIG',
          configPath: 'GATE.MAX_SNOOZE_PER_DAY',
          configProperty: 'MAX_SNOOZE_PER_DAY',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: 'property:src/config/focus.config.ts:FOCUS_CONFIG.GATE',
        target: 'property:src/config/focus.config.ts:FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        metadata: expect.objectContaining({
          relation: 'config-property',
          configObject: 'FOCUS_CONFIG',
          configPath: 'GATE.MAX_SNOOZE_PER_DAY',
          configProperty: 'MAX_SNOOZE_PER_DAY',
        }),
      }),
    ]));
    expect(response.relationshipGroups.contains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'FOCUS_CONFIG.GATE',
        target: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        relation: 'config-property',
        configPath: 'GATE.MAX_SNOOZE_PER_DAY',
      }),
    ]));
  });

  it('queries AGENTS non-sync configuration baselines by config key', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'TIMEOUT_CONFIG.QUICK');
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agent-sync-rule',
        name: 'TIMEOUT_CONFIG.QUICK',
        file: 'AGENTS.md',
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'TIMEOUT_CONFIG.QUICK',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule',
          ownerHeading: '9. Key Config',
          body: '5000ms',
          keywords: expect.arrayContaining(['TIMEOUT_CONFIG.QUICK']),
        }),
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'TIMEOUT_CONFIG.QUICK',
        qualifiedName: 'TIMEOUT_CONFIG.QUICK',
        filePath: 'src/config/timeout.config.ts',
        metadata: expect.objectContaining({
          relation: 'config-property',
          configObject: 'TIMEOUT_CONFIG',
          configPath: 'QUICK',
          configProperty: 'QUICK',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'TIMEOUT_CONFIG.QUICK',
        target: 'TIMEOUT_CONFIG.QUICK',
        relation: 'config-source',
        configKey: 'TIMEOUT_CONFIG.QUICK',
        configObject: 'TIMEOUT_CONFIG',
        configProperty: 'QUICK',
        configPath: 'QUICK',
      }),
    ]));
  });

  it('queries AGENTS sync configuration baselines by config key', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'SYNC_CONFIG.DEBOUNCE_DELAY');
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agent-sync-rule',
        name: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        file: 'AGENTS.md',
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule',
          ownerHeading: '9. Key Config',
          body: '3000ms',
          keywords: expect.arrayContaining(['SYNC_CONFIG.DEBOUNCE_DELAY', 'debounce']),
        }),
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          rule: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        }),
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'SYNC_CONFIG',
        filePath: 'src/config/sync.config.ts',
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        target: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        relation: 'sync-rule-keyword',
        keywordMapping: 'sync-config-keyword',
        matchedNeedle: 'SYNC_CONFIG.DEBOUNCE_DELAY',
      }),
      expect.objectContaining({
        source: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        target: 'SYNC_CONFIG',
        relation: 'sync-config-source',
        configKey: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        configObject: 'SYNC_CONFIG',
        configProperty: 'DEBOUNCE_DELAY',
      }),
    ]));
    expect(response.markdown).toContain('SYNC_CONFIG.DEBOUNCE_DELAY');
    expect(response.markdown).toContain('3000ms');
  });

  it('queries AGENTS sync config source links as focused native relationships', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'sync-config-source', ['--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule:9. Key Config:SYNC_CONFIG.DEBOUNCE_DELAY',
        target: 'constant:src/config/sync.config.ts:SYNC_CONFIG',
        metadata: expect.objectContaining({
          relation: 'sync-config-source',
          configKey: 'SYNC_CONFIG.DEBOUNCE_DELAY',
          configObject: 'SYNC_CONFIG',
          configProperty: 'DEBOUNCE_DELAY',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        target: 'SYNC_CONFIG',
        relation: 'sync-config-source',
        configProperty: 'DEBOUNCE_DELAY',
      }),
    ]));
    expect(response.markdown).toContain('relation: sync-config-source');
  });

  it('uses concrete config property code blocks for strict native sync config source queries', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'sync-config-source', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'property:src/config/sync.config.ts:SYNC_CONFIG.DEBOUNCE_DELAY',
        kind: 'property',
        name: 'SYNC_CONFIG.DEBOUNCE_DELAY',
        filePath: 'src/config/sync.config.ts',
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeKind: 'property',
      nodeName: 'SYNC_CONFIG.DEBOUNCE_DELAY',
      content: expect.stringContaining('DEBOUNCE_DELAY: 3000'),
    }));
  });

  it('uses concrete config property code blocks for strict native sync config source Markdown', () => {
    const root = makeFixture();
    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'sync-config-source',
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
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('**references:**');
    expect(result.stdout).toContain('- SYNC_CONFIG.DEBOUNCE_DELAY -> SYNC_CONFIG');
    expect(result.stdout).toContain('### Related Symbols');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### SYNC_CONFIG.DEBOUNCE_DELAY (src/config/sync.config.ts:2)');
    expect(result.stdout).toContain('DEBOUNCE_DELAY: 3000');
    expect(result.stdout).not.toContain('#### SYNC_CONFIG.DEBOUNCE_DELAY (AGENTS.md');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('relation: agents-config');
    expect(result.stdout).not.toContain('metadata');
    expect(result.stdout).not.toContain('provenance');
  });
}
