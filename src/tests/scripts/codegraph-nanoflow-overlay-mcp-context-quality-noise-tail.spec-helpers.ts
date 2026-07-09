import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualityNoiseTailSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    makeFakeCodegraph,
    waitForLogEvent,
  } = context;
  const writeSource = (projectRoot: string, filePath: string, lines: string[]) => {
    writeFile(projectRoot, filePath, [...lines, ''].join('\n'));
  };

  it('filters e2e fixture mock and stub paths from broad implementation context-pack queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-implementation-noise-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/session.service.ts',
      [
        'export class SessionService {',
        '  resume(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'e2e/helpers/session-flow.ts',
      [
        'export function sessionFlow(): void {',
        '  cy.log("session");',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/fixtures/session-data.ts',
      [
        'export const sessionFixture = {',
        '  id: "fixture-session",',
        '};',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/__mocks__/session.service.ts',
      [
        'export class SessionServiceMock {',
        '  resume(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/stubs/session-store.ts',
      [
        'export const sessionStoreStub = {',
        '  resume: true,',
        '};',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'cypress/e2e/session.cy.ts',
      [
        'describe("session", () => {',
        '  it("resumes", () => {});',
        '});',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'session service',
      matches: [
        { kind: 'function', name: 'sessionFlow', file: 'e2e/helpers/session-flow.ts' },
        { kind: 'constant', name: 'sessionFixture', file: 'src/fixtures/session-data.ts' },
        { kind: 'class', name: 'SessionServiceMock', file: 'src/__mocks__/session.service.ts' },
        { kind: 'constant', name: 'sessionStoreStub', file: 'src/stubs/session-store.ts' },
        { kind: 'class', name: 'SessionService', file: 'src/app/core/services/session.service.ts' },
        { kind: 'file', name: 'session.cy.ts', file: 'cypress/e2e/session.cy.ts' },
      ],
      nodes: [
        {
          id: 'function:e2e/helpers/session-flow.ts:sessionFlow',
          kind: 'function',
          name: 'sessionFlow',
          qualifiedName: 'sessionFlow',
          filePath: 'e2e/helpers/session-flow.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'constant:src/fixtures/session-data.ts:sessionFixture',
          kind: 'constant',
          name: 'sessionFixture',
          qualifiedName: 'sessionFixture',
          filePath: 'src/fixtures/session-data.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'class:src/__mocks__/session.service.ts:SessionServiceMock',
          kind: 'class',
          name: 'SessionServiceMock',
          qualifiedName: 'SessionServiceMock',
          filePath: 'src/__mocks__/session.service.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'constant:src/stubs/session-store.ts:sessionStoreStub',
          kind: 'constant',
          name: 'sessionStoreStub',
          qualifiedName: 'sessionStoreStub',
          filePath: 'src/stubs/session-store.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'class:src/app/core/services/session.service.ts:SessionService',
          kind: 'class',
          name: 'SessionService',
          qualifiedName: 'SessionService',
          filePath: 'src/app/core/services/session.service.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'file:cypress/e2e/session.cy.ts',
          kind: 'file',
          name: 'session.cy.ts',
          qualifiedName: 'cypress/e2e/session.cy.ts',
          filePath: 'cypress/e2e/session.cy.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {
        calls: [
          { source: 'sessionFlow', target: 'SessionService', relation: 'e2e-helper' },
          { source: 'sessionStoreStub', target: 'SessionService', relation: 'stub-helper' },
        ],
        references: [
          { source: 'sessionFixture', target: 'SessionService', relation: 'fixture-data' },
          { source: 'SessionServiceMock', target: 'SessionService', relation: 'mock-helper' },
        ],
      },
      coverage: { typescriptFiles: 6, graphNodes: 6, graphEdges: 4 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'session service',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders.join('\n')).toContain('src/app/core/services/session.service.ts');
    expect(sourceHeaders.join('\n')).not.toContain('e2e/helpers/session-flow.ts');
    expect(sourceHeaders.join('\n')).not.toContain('src/fixtures/session-data.ts');
    expect(sourceHeaders.join('\n')).not.toContain('src/__mocks__/session.service.ts');
    expect(sourceHeaders.join('\n')).not.toContain('src/stubs/session-store.ts');
    expect(sourceHeaders.join('\n')).not.toContain('cypress/e2e/session.cy.ts');

    const relationships = text.slice(text.indexOf('### Relationships'), text.indexOf('### Related Symbols'));
    expect(relationships).not.toContain('sessionFlow');
    expect(relationships).not.toContain('sessionFixture');
    expect(relationships).not.toContain('SessionServiceMock');
    expect(relationships).not.toContain('sessionStoreStub');
    const relatedSymbols = text.slice(text.indexOf('### Related Symbols'), text.indexOf('### Source Code'));
    expect(relatedSymbols).toContain('src/app/core/services/session.service.ts');
    expect(relatedSymbols).not.toContain('e2e/helpers/session-flow.ts');
    expect(relatedSymbols).not.toContain('src/fixtures/session-data.ts');
    expect(relatedSymbols).not.toContain('src/__mocks__/session.service.ts');
    expect(relatedSymbols).not.toContain('src/stubs/session-store.ts');
    expect(relatedSymbols).not.toContain('cypress/e2e/session.cy.ts');

    const responseEvent = await waitForLogEvent(
      process.env.NANOFLOW_CODEGRAPH_MCP_LOG ?? '',
      'nanoflow.context.response',
      2_000,
      (entry) => entry.query === 'session service',
    );
    expect(responseEvent.queryPlan).toEqual(expect.objectContaining({
      rawQuery: 'session service',
      baseQuery: 'session service',
      overlayQuery: 'session service',
      maxFiles: 8,
      baseMaxFiles: 8,
      overlayLimit: 20,
    }));
    expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
      sourceBlockCount: sourceHeaders.length,
      firstSourceFiles: expect.not.arrayContaining([
        'e2e/helpers/session-flow.ts',
        'src/fixtures/session-data.ts',
        'src/__mocks__/session.service.ts',
        'src/stubs/session-store.ts',
        'cypress/e2e/session.cy.ts',
      ]),
    }));
  }, 12_000);
}
