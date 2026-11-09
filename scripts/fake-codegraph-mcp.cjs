#!/usr/bin/env node
'use strict';

const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', line => {
  if (!line.trim()) return;

  const message = JSON.parse(line);
  if (message.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'codegraph_explore',
            description: 'fake CodeGraph explore for wrapper smoke tests',
            inputSchema: { type: 'object' },
          },
        ],
      },
    })}\n`);
    return;
  }

  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {
    const query = message.params.arguments?.query ?? '';
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{
          type: 'text',
          text: [
            `## Exploration: ${query}`,
            '',
            'base codegraph context',
          ].join('\n'),
        }],
      },
    })}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: message.id,
    result: { content: [] },
  })}\n`);
});
