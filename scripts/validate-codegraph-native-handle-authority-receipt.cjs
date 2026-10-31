'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifySignedReceipt } = require('./lib/codegraph-native-handle-authority-receipt-verifier.cjs');

const REPO = path.resolve(__dirname, '..');
const SCHEMA = path.join(__dirname, 'contracts', 'codegraph-native-handle-authority-receipt.schema.json');

function usage() {
  console.error('usage: validate-codegraph-native-handle-authority-receipt.cjs --dry-read-only --receipt <file> --pending-packet-digest <sha256> [--trust-anchor-fingerprint <sha256>] [--trust-anchor-public-key <file>] [--expected-source-rows <file>] [--ledger <file>]');
  process.exit(2);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(JSON.stringify({ error: 'JSON_READ_FAILED', label, code: error.code || null }));
    process.exit(3);
  }
}

function compileSchema() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  let Ajv2020;
  try {
    Ajv2020 = require('ajv/dist/2020');
  } catch {
    Ajv2020 = require(path.join(REPO, 'node_modules', 'ajv', 'dist', '2020.js'));
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(schema);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--dry-read-only')) usage();
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
  };
  const receiptFile = option('--receipt');
  const pendingPacketDigest = option('--pending-packet-digest');
  const trustAnchorFingerprint = option('--trust-anchor-fingerprint');
  const trustAnchorPublicKeyFile = option('--trust-anchor-public-key');
  const expectedSourceRowsFile = option('--expected-source-rows');
  const ledgerFile = option('--ledger');
  if (!receiptFile || !pendingPacketDigest) usage();
  const receipt = readJson(receiptFile, 'receipt');
  const expectedSourceRows = expectedSourceRowsFile ? readJson(expectedSourceRowsFile, 'expected-source-rows') : null;
  const ledger = ledgerFile ? readJson(ledgerFile, 'ledger') : [];
  let trustAnchorPublicKey = null;
  if (trustAnchorPublicKeyFile) {
    try {
      const bytes = fs.readFileSync(trustAnchorPublicKeyFile);
      trustAnchorPublicKey = bytes.toString('utf8').includes('BEGIN PUBLIC KEY') || bytes.toString('utf8').includes('BEGIN RSA PUBLIC KEY')
        ? bytes
        : { key: bytes, format: 'der', type: 'spki' };
    } catch {
      console.error(JSON.stringify({ error: 'TRUST_ANCHOR_UNAVAILABLE', detail: 'public key read failed' }));
      process.exit(4);
    }
  }
  if (!trustAnchorFingerprint || !trustAnchorPublicKey) {
    console.log(JSON.stringify({ status: 'TRUST_ANCHOR_UNAVAILABLE', dryReadOnly: true }));
    return;
  }
  const validate = compileSchema();
  if (!validate(receipt)) {
    console.error(JSON.stringify({ error: 'SCHEMA_INVALID', details: validate.errors, dryReadOnly: true }));
    process.exit(1);
  }
  verifySignedReceipt({ receipt, pendingPacketDigest, expectedSourceRows, trustAnchorFingerprint, trustAnchorPublicKey, ledger })
    .then((result) => {
      console.log(JSON.stringify({ ...result, dryReadOnly: true }));
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: error.code || error.message, dryReadOnly: true }));
      process.exit(1);
    });
}

main();
