import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAgentHardRuleQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess, writeFile, repoRoot, queryScriptPath } = context;
  it('queries AGENTS hard rules by body-only terms', () => {
    const root = makeFixture();
    const result = queryOverlay(root, '断网可写');
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agent-hard-rule',
        name: '5.2 Offline-first',
        file: 'AGENTS.md',
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: '5.2 Offline-first',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'hard-rule',
          body: expect.stringContaining('断网可写'),
        }),
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'Write path',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule',
          ownerHeading: '5.2 Offline-first',
          body: expect.stringContaining('RetryQueue'),
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          keyword: 'RetryQueue',
        }),
      }),
    ]));
    expect(response.markdown).toContain('5.2 Offline-first');
    expect(response.markdown).toContain('Write path');
  });

  it('queries AGENTS hard-rule keywords as scoped native relationships', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'crypto.randomUUID', ['--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agent-hard-rule',
        name: '5.1 ID Strategy',
        file: 'AGENTS.md',
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: '5.1 ID Strategy',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'hard-rule',
          keywords: expect.arrayContaining(['crypto.randomUUID()']),
        }),
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'crypto.randomUUID()',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'hard-rule-keyword',
          rule: '5.1 ID Strategy',
        }),
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'createTaskId',
        filePath: 'src/services/task-id-factory.service.ts',
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '5.1 ID Strategy',
        target: 'crypto.randomUUID()',
        relation: 'hard-rule-keyword',
        keywordMapping: 'hard-rule-keyword',
        matchedNeedle: 'crypto.randomUUID()',
      }),
      expect.objectContaining({
        source: 'crypto.randomUUID()',
        target: 'createTaskId',
        relation: 'hard-rule-implementation',
        keyword: 'crypto.randomUUID()',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          relation: 'hard-rule-keyword',
          keyword: 'crypto.randomUUID()',
          keywordMapping: 'hard-rule-keyword',
          matchedNeedle: 'crypto.randomUUID()',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:hard-rule-keyword:5.1 ID Strategy:crypto.randomUUID()',
        target: 'method:src/services/task-id-factory.service.ts:TaskIdFactoryService.createTaskId',
        metadata: expect.objectContaining({
          relation: 'hard-rule-implementation',
          keyword: 'crypto.randomUUID()',
          matchedNeedle: 'crypto.randomUUID()',
          requiredBy: 'AGENTS.md',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:hard-rule-keyword:5.1 ID Strategy:crypto.randomUUID()',
        target: 'function:src/services/task-id-factory.service.spec.ts:createSpecFallbackId',
        metadata: expect.objectContaining({
          relation: 'hard-rule-test-evidence',
          keyword: 'crypto.randomUUID()',
          matchedNeedle: 'crypto.randomUUID()',
          requiredBy: 'AGENTS.md',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:hard-rule-keyword:5.1 ID Strategy:crypto.randomUUID()',
        target: 'function:src/services/task-id-factory.spec-helpers.ts:createSpecHelperTaskId',
        metadata: expect.objectContaining({
          relation: 'hard-rule-test-evidence',
          keyword: 'crypto.randomUUID()',
          matchedNeedle: 'crypto.randomUUID()',
          requiredBy: 'AGENTS.md',
        }),
      }),
    ]));
    const implementationTargets = response.edges
      .filter((edge: { metadata?: { relation?: string } }) => edge.metadata?.relation === 'hard-rule-implementation')
      .map((edge: { target: string }) => edge.target);
    expect(implementationTargets).not.toContain('function:src/services/task-id-factory.service.spec.ts:createSpecFallbackId');
    expect(implementationTargets).not.toContain('function:src/services/task-id-factory.spec-helpers.ts:createSpecHelperTaskId');
    expect(response.markdown).toContain('5.1 ID Strategy');
    expect(response.markdown).toContain('crypto.randomUUID()');
    expect(response.markdown).toContain('relation: hard-rule-implementation');
    expect(response.markdown).toContain('relation: hard-rule-test-evidence');
  });

  it('queries Personal Data Safety guarantees as hard-rule keywords', () => {
    const root = makeFixture();
    writeFile(
      root,
      'AGENTS.md',
      [
        '# NanoFlow',
        '## 5. Hard Rules',
        '### 5.6 Personal Data Safety',
        '- Data safety outranks feature velocity.',
        '- NanoFlow must preserve four guarantees:',
        '  - Exportable: current local data, sync cursor, pending queue, and relevant metadata can be exported at any time.',
        '  - Restorable: a valid export can restore the local working state without ID remapping.',
        '  - Replayable: pending and recent sync actions can be replayed or inspected deterministically.',
        '  - Explainable: the app can explain the latest write, including conflict/LWW decision and lastSyncTime effect.',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'hard-rule-keyword Exportable Restorable Replayable Explainable Personal Data Safety',
      ['--limit', '20'],
    );
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);

    for (const keyword of ['Exportable', 'Restorable', 'Replayable', 'Explainable', 'LWW']) {
      expect(response.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'variable',
          name: keyword,
          filePath: 'AGENTS.md',
          metadata: expect.objectContaining({
            relation: 'hard-rule-keyword',
            rule: '5.6 Personal Data Safety',
          }),
        }),
      ]));
      expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: '5.6 Personal Data Safety',
          target: keyword,
          relation: 'hard-rule-keyword',
          keywordMapping: 'hard-rule-keyword',
          matchedNeedle: keyword,
        }),
      ]));
    }
  });

  it('uses hard-rule keyword evidence lines for strict native code blocks', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'hard-rule-keyword', ['--native-json', '--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const randomUuidBlock = response.codeBlocks.find((block: { nodeName?: string }) => (
      block.nodeName === 'crypto.randomUUID()'
    ));
    const autoincrementIdBlock = response.codeBlocks.find((block: { nodeName?: string }) => (
      block.nodeName === 'database autoincrement ID'
    ));

    expect(randomUuidBlock).toEqual(expect.objectContaining({
      filePath: 'AGENTS.md',
      content: expect.stringContaining('crypto.randomUUID()'),
    }));
    expect(randomUuidBlock.content).not.toContain('### 5.1 ID Strategy');
    if (autoincrementIdBlock) {
      expect(autoincrementIdBlock).toEqual(expect.objectContaining({
        filePath: 'AGENTS.md',
        content: expect.stringContaining('database autoincrement ID'),
      }));
      expect(autoincrementIdBlock.content).not.toContain('### 5.1 ID Strategy');
    }
  });

  it('uses hard-rule keyword evidence lines for direct keyword strict native code blocks', () => {
    const root = makeFixture();
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      [
        '# NanoFlow',
        '## 5. Hard Rules',
        '### 5.1 ID Strategy',
        '- 所有实体 ID 必须客户端生成：`crypto.randomUUID()`。',
        '- 禁止数据库自增 ID、临时 ID、同步时 ID 映射转换。',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'autoincrement', ['--native-json', '--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const autoincrementIdBlock = response.codeBlocks.find((block: { nodeName?: string }) => (
      block.nodeName === 'database autoincrement ID'
    ));

    expect(autoincrementIdBlock).toEqual(expect.objectContaining({
      filePath: 'AGENTS.md',
      content: expect.stringContaining('数据库自增 ID'),
    }));
    expect(autoincrementIdBlock.content).not.toContain('### 5.1 ID Strategy');
  });

  it('uses hard-rule keyword evidence lines in strict native Markdown', () => {
    const root = makeFixture();
    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'hard-rule-keyword',
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
    expect(entryPoints).toContain('- **crypto.randomUUID()** (variable) - AGENTS.md:3');
    expect(entryPoints).toContain('- **database autoincrement ID** (variable) - AGENTS.md:3');
    expect(entryPoints).toContain('- **content** (variable) - AGENTS.md:5');
    expect(code).toContain('#### crypto.randomUUID() (AGENTS.md:4)');
    expect(code).toContain('- Client IDs must use crypto.randomUUID(); database autoincrement IDs are forbidden.');
    expect(code).toContain('#### content (AGENTS.md:10)');
    expect(code).toContain('- Sync query required fields: tasks select must include content.');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('uses hard-rule implementation targets as strict native entry points', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'hard-rule-implementation', ['--native-json', '--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const entryPoints = response.entryPoints as Array<{
      filePath?: string;
      kind?: string;
      name?: string;
    }>;

    expect(entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'method',
        name: 'createTaskId',
        filePath: 'src/services/task-id-factory.service.ts',
      }),
    ]));
    expect(entryPoints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'crypto.randomUUID()',
        filePath: 'AGENTS.md',
      }),
    ]));
    expect(entryPoints.every(entry => entry.kind === 'function' || entry.kind === 'method')).toBe(true);
  });

  it('uses hard-rule implementation targets as strict native Markdown entry points and code blocks', () => {
    const root = makeFixture();
    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'hard-rule-implementation',
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
    const entryPointsStart = result.stdout.indexOf('### Entry Points');
    const relatedSymbolsStart = result.stdout.indexOf('### Related Symbols');
    const entryPoints = result.stdout.slice(entryPointsStart, relatedSymbolsStart);
    const codeStart = result.stdout.indexOf('### Code');
    const code = result.stdout.slice(codeStart);

    expect(entryPoints).toContain('- **createTaskId** (method) - src/services/task-id-factory.service.ts:2');
    expect(entryPoints).not.toContain('- **crypto.randomUUID()** (variable) - AGENTS.md');
    expect(code).toContain('#### createTaskId (src/services/task-id-factory.service.ts:2)');
    expect(code).toContain('crypto.randomUUID()');
    expect(code).not.toContain('#### crypto.randomUUID() (AGENTS.md');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('### Source Code');
  });

  it('uses hard-rule test evidence targets as strict native entry points and code blocks', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'hard-rule-test-evidence', ['--native-json', '--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const entryPoints = response.entryPoints as Array<{
      filePath?: string;
      kind?: string;
      name?: string;
    }>;
    const codeBlocks = response.codeBlocks as Array<{
      filePath?: string;
      nodeKind?: string;
      nodeName?: string;
    }>;

    expect(entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'createSpecFallbackId',
        filePath: 'src/services/task-id-factory.service.spec.ts',
      }),
    ]));
    expect(entryPoints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'crypto.randomUUID()',
        filePath: 'AGENTS.md',
      }),
    ]));
    expect(entryPoints.every(entry => entry.kind === 'function' || entry.kind === 'method')).toBe(true);
    expect(codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeKind: 'function',
        nodeName: 'createSpecFallbackId',
        filePath: 'src/services/task-id-factory.service.spec.ts',
      }),
    ]));
    expect(codeBlocks.some(block => block.filePath === 'AGENTS.md')).toBe(false);
  });

  it('uses matched hard-rule test evidence lines for strict native code blocks', () => {
    const root = makeFixture();
    const specFile = 'src/tests/long-hard-rule-evidence.spec.ts';
    const fillerLines = Array.from({ length: 80 }, (_, index) => (
      `  const filler${index} = '${'x'.repeat(80)}';`
    ));
    const evidenceLine = fillerLines.length + 2;
    writeFile(root, specFile, [
      'export function registerLongHardRuleEvidenceSpecs(): void {',
      ...fillerLines,
      '  const generatedId = crypto.randomUUID();',
      '  expect(generatedId).toBeTruthy();',
      '}',
      '',
    ].join('\n'));
    writeFile(root, 'AGENTS.md', [
      '# Rules',
      '### 5.1 ID Strategy',
      '- Client IDs must use crypto.randomUUID().',
      '',
    ].join('\n'));

    const keywordNode = {
      id: 'variable:AGENTS.md:hard-rule-keyword:5.1 ID Strategy:crypto.randomUUID()',
      kind: 'variable',
      name: 'crypto.randomUUID()',
      qualifiedName: 'crypto.randomUUID()',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 3,
      endLine: 3,
      signature: 'hard-rule keyword crypto.randomUUID()',
    };
    const evidenceFunctionNode = {
      id: `function:${specFile}:registerLongHardRuleEvidenceSpecs`,
      kind: 'function',
      name: 'registerLongHardRuleEvidenceSpecs',
      qualifiedName: 'registerLongHardRuleEvidenceSpecs',
      filePath: specFile,
      language: 'typescript',
      startLine: 1,
      endLine: evidenceLine + 2,
      signature: '(): void',
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [specFile],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: [keywordNode, evidenceFunctionNode],
        edges: [{
          source: keywordNode.id,
          target: evidenceFunctionNode.id,
          kind: 'references',
          line: evidenceLine,
          column: 23,
          metadata: {
            relation: 'hard-rule-test-evidence',
            keyword: 'crypto.randomUUID()',
            matchedNeedle: 'crypto.randomUUID()',
            requiredBy: 'AGENTS.md',
          },
        }],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'hard-rule-test-evidence', ['--native-json', '--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const codeBlocks = response.codeBlocks as Array<{
      content?: string;
      filePath?: string;
      nodeKind?: string;
      nodeName?: string;
      startLine?: number;
    }>;
    const evidenceBlock = codeBlocks.find(block => block.filePath === specFile);

    expect(evidenceBlock).toEqual(expect.objectContaining({
      nodeKind: 'function',
      nodeName: 'registerLongHardRuleEvidenceSpecs',
      startLine: evidenceLine,
      content: '  const generatedId = crypto.randomUUID();',
    }));
  });

  it('uses hard-rule body evidence lines instead of earlier AGENTS self-documentation matches', () => {
    const root = makeFixture();
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      [
        '# NanoFlow',
        '- Adapter documentation may mention crypto.randomUUID() before the hard rules.',
        '## 5. Hard Rules',
        '### 5.1 ID Strategy',
        '- Client IDs must use crypto.randomUUID(); database autoincrement IDs are forbidden.',
        '### 5.2 Offline-first',
        '- local first; 断网可写',
        '- Write path: local write + UI immediate update -> 3s debounce push -> failure enters RetryQueue.',
        '- Conflict policy: LWW.',
        '- Read path: IndexedDB -> incremental pull using updated_at > last_sync_time.',
        '- Sync query required fields: tasks select must include content.',
        '## 9. Key Config',
        '| Config | Value |',
        '| ------ | ----- |',
        '| `SYNC_CONFIG.DEBOUNCE_DELAY` | `3000ms` |',
        '| `SYNC_CONFIG.REALTIME_ENABLED` | `false` |',
        '| `TIMEOUT_CONFIG.QUICK` | `5000ms` |',
        '| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | `local-user` |',
        '| `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY` | `3` |',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'hard-rule-keyword', ['--native-json', '--limit', '20']);
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const randomUuidBlock = response.codeBlocks.find((block: { nodeName?: string }) => (
      block.nodeName === 'crypto.randomUUID()'
    ));

    expect(randomUuidBlock).toEqual(expect.objectContaining({
      filePath: 'AGENTS.md',
      startLine: 5,
      content: '- Client IDs must use crypto.randomUUID(); database autoincrement IDs are forbidden.',
    }));
    expect(randomUuidBlock.content).not.toContain('Adapter documentation');
  });
}
