#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256Text, digestPreimage } = require('./lib/codegraph-native-handle-authority-materializer.cjs');

const REPO = path.resolve(__dirname, '..');
const REQUEST = path.join(REPO, '..', '_codex_external_review_packets', 'codegraph-exact15-native-handle-authority-revision4.json');
const SCHEMA = path.join(__dirname, 'contracts', 'codegraph-native-handle-authority-revision4.schema.json');

function parseArgs(argv) {
  if (!argv.includes('--dry-read-only')) return null;
  const parsed = { dryReadOnly: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--request' && argv[index + 1]) parsed.request = argv[++index];
    else if (argv[index] === '--schema' && argv[index + 1]) parsed.schema = argv[++index];
  }
  return parsed;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) return 2;
  const requestPath = path.resolve(args.request ?? REQUEST);
  const schemaPath = path.resolve(args.schema ?? SCHEMA);
  if (!fs.existsSync(requestPath)) {
    process.stderr.write('REQUEST_MISSING\n');
    return 1;
  }
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  let Ajv2020;
  try {
    Ajv2020 = require('ajv/dist/2020');
  } catch {
    Ajv2020 = require(path.join(REPO, 'node_modules', 'ajv', 'dist', '2020.js'));
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(request)) {
    process.stderr.write(`REQUEST_SCHEMA_INVALID:${JSON.stringify(validate.errors)}\n`);
    return 1;
  }
  if (request.status !== 'PENDING_EXTERNAL_SIGNATURE' || request.receipt !== null
    || request.artifactRevision !== 4 || request.release !== 'HOLD_RELEASE') {
    process.stderr.write('AUTHORITY_STATE_INVALID\n');
    return 1;
  }
  const withoutPacket = { ...request };
  delete withoutPacket.packetDigest;
  if (request.packetDigest !== sha256Text(digestPreimage(withoutPacket))) {
    process.stderr.write('PACKET_DIGEST_MISMATCH\n');
    return 1;
  }
  const output = { artifactKind: 'CODEGRAPH_EXACT15_NATIVE_HANDLE_AUTHORITY_VERIFIER_OUTPUT', artifactRevision: 4, status: request.status, release: request.release, receipt: null };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = Object.freeze({ main, parseArgs });
