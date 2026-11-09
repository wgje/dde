import fs from 'node:fs';

interface FakeCodegraphSourceBlock {
  header: string;
  language: string;
  lines: string[];
}

interface FakeCodegraphExploreResponse {
  includeMaxFiles?: boolean;
  preludeLines?: string[];
  sourceBlocks?: FakeCodegraphSourceBlock[];
}

interface FakeCodegraphQueryAwareExploreResponse {
  focusedQuery: string;
  focused: FakeCodegraphExploreResponse;
  fallback?: FakeCodegraphExploreResponse;
}

type FakeCodegraphExploreScriptOptions =
  | FakeCodegraphExploreResponse
  | FakeCodegraphQueryAwareExploreResponse;

interface FakeCodegraphExploreScriptConfig {
  focusedQuery: string | null;
  focused: FakeCodegraphExploreResponse;
  fallback: FakeCodegraphExploreResponse;
}

function normalizeFakeCodegraphExploreScriptConfig(
  options: FakeCodegraphExploreScriptOptions,
): FakeCodegraphExploreScriptConfig {
  const queryAware = 'focusedQuery' in options;
  const focused = queryAware ? options.focused : options;
  const fallback = queryAware ? options.fallback ?? options.focused : options;

  return {
    focusedQuery: queryAware ? options.focusedQuery : null,
    focused,
    fallback,
  };
}

function buildFakeCodegraphExploreScript(config: FakeCodegraphExploreScriptConfig): string {
  return [
    "'use strict';",
    "const readline = require('node:readline');",
    `const config = ${JSON.stringify(config)};`,
    "function renderText(args) {",
    "  const response = config.focusedQuery && args.query !== config.focusedQuery ? config.fallback : config.focused;",
    "  const lines = ['## Exploration: ' + args.query, 'baseQuery=' + args.query];",
    "  if (response.includeMaxFiles) {",
    "    lines.push('baseMaxFiles=' + args.maxFiles);",
    "  }",
    "  if (response.preludeLines?.length) {",
    "    lines.push('', ...response.preludeLines);",
    "  }",
    "  if (response.sourceBlocks?.length) {",
    "    lines.push('', '### Source Code', '');",
    "    for (const block of response.sourceBlocks) {",
    "      lines.push('#### ' + block.header, '', '```' + block.language, ...block.lines, '```', '');",
    "    }",
    "  }",
    "  return lines.join('\\n').replace(/\\n$/, '');",
    "}",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', line => {",
    "  if (!line.trim()) return;",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'tools/list') {",
    "    console.log(JSON.stringify({",
    "      jsonrpc: '2.0',",
    "      id: message.id,",
    "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
    "    }));",
    "    return;",
    "  }",
    "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
    "    const text = renderText(message.params.arguments);",
    "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
    "    return;",
    "  }",
    "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
    "});",
    '',
  ].join('\n');
}

export function writeFakeCodegraphExploreScript(
  fakeCodegraph: string,
  options: FakeCodegraphExploreScriptOptions,
): void {
  fs.writeFileSync(fakeCodegraph, buildFakeCodegraphExploreScript(
    normalizeFakeCodegraphExploreScriptConfig(options),
  ));
}
