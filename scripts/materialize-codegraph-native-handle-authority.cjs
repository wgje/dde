#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  canonicalJson,
  materializeNativeHandleAuthorityRequest,
} = require('./lib/codegraph-native-handle-authority-materializer.cjs');

function usage() {
  return 'usage: materialize-codegraph-native-handle-authority [--input <json>|--stdin] [--output <file>]';
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input' && argv[index + 1]) parsed.input = argv[++index];
    else if (argv[index] === '--stdin') parsed.stdin = true;
    else if (argv[index] === '--output' && argv[index + 1]) parsed.output = argv[++index];
    else return null;
  }
  return parsed;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args || (!args.input && !args.stdin) || (args.input && args.stdin)) {
    process.stderr.write(`usage: ${usage()}\n`);
    return 2;
  }
  const text = args.stdin ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(args.input), 'utf8');
  const input = JSON.parse(text);
  const request = await materializeNativeHandleAuthorityRequest(input);
  if (args.output) atomicWriteJson(path.resolve(args.output), request);
  process.stdout.write(`${canonicalJson(request)}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ main, parseArgs });
