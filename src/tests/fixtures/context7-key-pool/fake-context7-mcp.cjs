'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const argv = process.argv.slice(2);

function option(name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function has(name) {
  return argv.includes(name);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
}

function baseTools() {
  return [
    {
      name: 'resolve-library-id',
      title: 'Resolve a library',
      description: 'Resolve docs library identifiers.',
      inputSchema: {
        type: 'object',
        required: ['libraryName', 'query'],
        properties: { libraryName: { type: 'string' }, query: { type: 'string' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      _meta: { fixture: true },
    },
    {
      name: 'query-docs',
      title: 'Query documentation',
      description: 'Query resolved documentation.',
      inputSchema: {
        type: 'object',
        required: ['libraryId', 'query'],
        properties: { libraryId: { type: 'string' }, query: { type: 'string' } },
      },
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
  ];
}

function fixtureTools() {
  const tools = baseTools();
  switch (option('--tool-shape')) {
    case 'missing': return tools.slice(0, 1);
    case 'extra': return [...tools, { name: 'extra-tool', inputSchema: { type: 'object', properties: {} } }];
    case 'collision': return [...tools, { name: 'context7-pool-status', inputSchema: { type: 'object', properties: {} } }];
    case 'non-object-schema': tools[0].inputSchema = []; break;
    case 'required-non-string': tools[0].inputSchema.required = ['libraryName', 7]; break;
    case 'required-drift': tools[0].inputSchema.required = ['libraryName']; break;
    case 'string-drift': tools[0].inputSchema.properties.query = { type: 'number' }; break;
    default: break;
  }
  return tools;
}

const pidFile = option('--pid-file');
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
if (has('--immediate-exit')) process.exit(19);
const stderrBytes = Number(option('--stderr-bytes', '0'));
if (stderrBytes > 0) fs.writeSync(2, Buffer.alloc(stderrBytes, 120));

const server = new Server(
  { name: 'fake-context7-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await delay(option('--delay-list', '0'));
  return { tools: fixtureTools() };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await delay(option('--delay-call', '0'));
  const args = request.params.arguments || {};
  if (args.query === 'mode:exit-now') process.exit(23);
  if (args.query === 'mode:env') {
    const key = process.env.CONTEXT7_API_KEY;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          envNames: Object.keys(process.env).sort(),
          keyFingerprint: key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) : null,
        }),
      }],
    };
  }
  if (args.query === 'mode:standard-result') {
    const marker = process.env.NANOFLOW_CONTEXT7_FAILURE_MARKER;
    return {
      content: [
        { type: 'text', text: `plain ${marker} text`, annotations: { audience: ['assistant'], priority: 0.5 } },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
        { type: 'resource_link', uri: 'fixture://resource', name: `resource ${marker}`, mimeType: 'text/plain' },
        { type: 'resource', resource: { uri: 'fixture://embedded', mimeType: 'text/plain', text: marker } },
      ],
      isError: true,
      structuredContent: { answer: marker, nested: ['preserved'] },
      _meta: { fixture: marker, nested: { kept: true } },
    };
  }
  return { content: [{ type: 'text', text: 'fixture-ok' }] };
});

(async () => {
  await delay(option('--delay-initialize', '0'));
  await server.connect(new StdioServerTransport());
})().catch(() => process.exit(29));
