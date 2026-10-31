import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterContextCliQueryFocusSpecContext {
  repoRoot: string;
  adapterContextScriptPath: string;
  trackTempRoot: (root: string) => void;
  makeContextReturningFakeCodegraph: () => string;
  makeMaxFilesSensitiveFakeCodegraph: () => string;
  makeConfigBackedAdapterProject: () => string;
}

export function registerCodegraphAdapterContextCliQueryFocusSpecs(
  context: CodegraphAdapterContextCliQueryFocusSpecContext,
): void {
  it('focuses camel-cased NanoFlow CodeGraph quality queries before provenance overlay lookup', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-quality-focus-'));
    context.trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'NanoFlow CodeGraph adapter output quality source ordering duplicate sections low value sourceSelection',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '10000',
        '--json',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe('codegraph adapter context wrapper log guard sourceOrdering sourceSelection');
    expect(summary.contextText).toBe([
      '## Exploration: NanoFlow CodeGraph adapter output quality source ordering duplicate sections low value sourceSelection',
      '',
      'No code context matched this query.',
    ].join('\n'));
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"baseQuery":"codegraph adapter context wrapper log guard sourceOrdering sourceSelection"');
    expect(logText).toContain('"baseQueryFocused":true');
    expect(logText).toContain('"baseMaxFiles":1');
  }, 60_000);

  it.each([
    {
      label: 'strict native output maintenance',
      query: 'NanoFlow CodeGraph strict native output markdown json related symbols line numbering standard current adaptation quality',
      focusedQuery: [
        'scripts/query-codegraph-nanoflow-overlay.mjs',
        'formatStrictNativeMarkdown',
        'formatNativeMarkdown',
        'buildStrictNativeMarkdownRelationshipGroups',
        'nativeJsonEdgeLine',
      ].join(' '),
    },
    {
      label: 'Context7 retrieval source-map maintenance',
      query: 'NanoFlow CodeGraph context7 retrieval source map docs route standard current adaptation quality',
      focusedQuery: [
        'docs/context7/catalog.json',
        'docs/context7/source-map.md',
        'context7-retrieval-route',
        'context7-source-map-route',
        'context7-retrieval-primary',
        'context7-source-map-source',
      ].join(' '),
    },
    {
      label: 'helper fixture quality',
      query: 'NanoFlow CodeGraph current adaptation helper fixtures generic script source blocks quality standard',
      focusedQuery: [
        'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
        'buildFakeCodegraphExploreScript',
        'writeFakeCodegraphExploreScript',
        'context-pack source quality fixtures',
      ].join(' '),
    },
  ])('focuses $label queries before provenance overlay lookup', ({ query, focusedQuery }) => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-specialized-focus-'));
    context.trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        query,
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '10000',
        '--json',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      overlayQuery?: string;
    };
    expect(summary.ok).toBe(true);
    expect(summary.overlayQuery).toBe(focusedQuery);
    expect(summary.overlayQuery).not.toBe('codegraph adapter context wrapper log guard sourceOrdering sourceSelection');
  }, 60_000);

  it('rewrites de-duplication contract maintenance queries to the dedicated canonical query', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeContextReturningFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-dedup-quality-'));
    context.trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const query = 'NanoFlow CodeGraph dedup contract context-pack quality source ordering adapter gate current duplicate hotspots project semantic coverage';
    const focusedQuery = 'docs/codegraph-nanoflow-dedup-contract.json scripts/validate-codegraph-overlay-docs.cjs scripts/query-codegraph-nanoflow-overlay.mjs scripts/codegraph-nanoflow-mcp-stdio.cjs dedup contract';
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        query,
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '10000',
        '--json',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe(focusedQuery);
    expect(summary.overlayQuery).not.toBe('codegraph adapter context wrapper log guard sourceOrdering sourceSelection');
    expect(summary.contextText).toContain('## Exploration: ' + query);
  }, 60_000);

  it('focuses NanoFlow CodeGraph quality issue registry queries on the adaptation issue registry', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-quality-registry-'));
    context.trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'NanoFlow CodeGraph quality issue registry',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '10000',
        '--json',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe('docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues');
    expect(summary.contextText).toBe([
      '## Exploration: NanoFlow CodeGraph quality issue registry',
      '',
      'No code context matched this query.',
    ].join('\n'));
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"baseQuery":"docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues"');
    expect(logText).toContain('"baseQueryFocused":true');
    expect(logText).toContain('"baseMaxFiles":1');
  }, 60_000);

  it('focuses Chinese NanoFlow CodeGraph issue registry queries on the adaptation issue registry', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-quality-registry-cjk-'));
    context.trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'NanoFlow适配错误问题记录文档',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '10000',
        '--json',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe('docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues');
    expect(summary.contextText).toBe([
      '## Exploration: NanoFlow适配错误问题记录文档',
      '',
      'No code context matched this query.',
    ].join('\n'));
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"baseQuery":"docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues"');
    expect(logText).toContain('"baseQueryFocused":true');
    expect(logText).toContain('"baseMaxFiles":1');
  }, 60_000);
}
