import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve('D:/Code/dde');
const ROOT = path.resolve('scripts/contracts/codegraph-native-handle-authority-receipt.schema.json');
const MODULE = path.resolve('scripts/lib/codegraph-native-handle-authority-receipt-verifier.cjs');
const CLI = path.resolve('scripts/validate-codegraph-native-handle-authority-receipt.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cgnh-receipt-'));
afterEach(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
  }
});
function sha256Bytes(buf: Uint8Array | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

type UnknownRecord = Record<string, unknown>;

function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSort);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.keys(value as UnknownRecord).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => [key, canonicalSort((value as UnknownRecord)[key])]));
  }
  return value;
}

function digestPreimage(value: unknown): string {
  return JSON.stringify(canonicalSort(value));
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

interface SourceRow {
  row: string;
  path: string;
  sha256: string;
  bytes: number;
}

interface PendingPacket {
  packetDigest: string;
  sourceRows: SourceRow[];
  [key: string]: unknown;
}

function buildPendingPacket({ sourceRows = [] }: { sourceRows?: SourceRow[] } = {}): PendingPacket {
  const base = {
    artifactKind: 'CODEGRAPH_EXACT15_NATIVE_HANDLE_AUTHORITY_REQUEST',
    artifactRevision: 4,
    status: 'PENDING_EXTERNAL_SIGNATURE',
    normativeState: 'PENDING_EXTERNAL_SIGNATURE',
    canonicalEncoding: { bom: false, characterEncoding: 'UTF-8', digestPreimage: 'canonical UTF-8 JSON without final LF', finalLineEnding: 'LF', indent: 2, keyOrder: 'recursive UTF-16 code-unit ascending', safeIntegersOnly: true },
    protocol: 'codegraph-native-handle-authority-v1',
    sourceRows,
    frames: [],
    trustAnchor: { required: true, selfIssued: false, status: 'PENDING_EXTERNAL_SIGNATURE', type: 'EXTERNAL', fingerprint: null },
    receipt: null,
    release: 'HOLD_RELEASE',
  };
  const packetDigest = sha256Text(digestPreimage(base));
  return { ...base, packetDigest };
}

function makeEd25519Pair(): crypto.KeyPairKeyObjectResult {
  return crypto.generateKeyPairSync('ed25519');
}

function makeRsaPair(): crypto.KeyPairKeyObjectResult {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function spkiFingerprint(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return sha256Bytes(der);
}

interface ReceiptOptions {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject | null;
  packetDigest: string;
  algorithm?: 'Ed25519' | 'RSASSA-PSS-SHA256';
  rows?: SourceRow[];
  nonce?: string;
  idempotencyKey?: string;
  overrides?: Record<string, unknown>;
}

interface Receipt extends Record<string, unknown> {
  packetDigest: string;
  sourceRows: SourceRow[];
  trustAnchorFingerprint: string;
  nonce: string;
  idempotencyKey: string;
  receiptDigest: string;
  signature: { algorithm: 'Ed25519' | 'RSASSA-PSS-SHA256'; value: string };
}

function makeReceipt({ publicKey, privateKey, packetDigest, algorithm = 'Ed25519', rows = [], nonce = 'n'.repeat(32), idempotencyKey = 'idem-1', overrides = {} }: ReceiptOptions): Receipt {
  const body = {
    protocol: 'codegraph-native-handle-authority-v1',
    artifactKind: 'CODEGRAPH_EXACT15_NATIVE_HANDLE_AUTHORITY_REQUEST',
    artifactRevision: 4,
    packetDigest,
    sourceRows: rows,
    trustAnchorFingerprint: spkiFingerprint(publicKey),
    issuer: { issuerId: 'external-issuer' },
    nonce,
    idempotencyKey,
    verifiedAt: '2026-08-16T00:00:00.000Z',
  };
  const receiptDigest = sha256Text(digestPreimage(body));
  const full = { ...body, ...overrides };
  const preimage = sha256Text(digestPreimage(full));
  let value;
  if (algorithm === 'Ed25519') {
    value = crypto.sign(null, Buffer.from(preimage, 'utf8'), privateKey as crypto.KeyObject).toString('base64');
  } else if (algorithm === 'RSASSA-PSS-SHA256') {
    value = crypto.sign('sha256', Buffer.from(preimage, 'utf8'), {
      key: privateKey as crypto.KeyObject,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
  } else {
    throw new Error('bad algorithm');
  }
  return { ...full, receiptDigest, signature: { algorithm, value } } as Receipt;
}

describe('codegraph native handle authority receipt verifier exact4', () => {
  it('has the four exact4 source files', () => {
    expect(fs.existsSync(ROOT)).toBe(true);
    expect(fs.existsSync(MODULE)).toBe(true);
    expect(fs.existsSync(CLI)).toBe(true);
  });

  it('verifies valid Ed25519 and RSASSA-PSS-SHA256 receipts', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    const result = await verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] });
    expect(result.status).toBe('VERIFIED');
    expect(result.receiptDigest).toBe(receipt.receiptDigest);
    const rsa = makeRsaPair();
    const rsaPacket = buildPendingPacket({ sourceRows: packet.sourceRows });
    const rsaReceipt = makeReceipt({ publicKey: rsa.publicKey, privateKey: rsa.privateKey, packetDigest: rsaPacket.packetDigest, rows: rsaPacket.sourceRows, algorithm: 'RSASSA-PSS-SHA256' });
    const rsaResult = await verifySignedReceipt({ receipt: rsaReceipt, pendingPacketDigest: rsaPacket.packetDigest, expectedSourceRows: rsaPacket.sourceRows, trustAnchorFingerprint: spkiFingerprint(rsa.publicKey), trustAnchorPublicKey: rsa.publicKey, ledger: [] });
    expect(rsaResult.signature.algorithm).toBe('RSASSA-PSS-SHA256');
  });

  it('rejects a fake signature even when the envelope shape is valid', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    receipt.signature.value = 'c2lnbmF0dXJlLWZha2U=';
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('SIGNATURE_INVALID');
  });

  it('rejects wrong SPKI fingerprint', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const other = makeEd25519Pair().publicKey;
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(other), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('TRUST_ANCHOR_FINGERPRINT_MISMATCH');
  });

  it('rejects digest drift', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    receipt.receiptDigest = 'f'.repeat(64);
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('DIGEST_DRIFT');
  });

  it('rejects pending packet digest drift', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: 'a'.repeat(64), expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('PACKET_DIGEST_DRIFT');
  });

  it('rejects full15 row drift', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: [{ ...packet.sourceRows[0], sha256: 'f'.repeat(64) }], trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('SOURCE_ROW_DRIFT');
  });

  it('rejects missing/replayed nonce and idempotency', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    const clean = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'nonce')) as unknown as Receipt;
    await expect(verifySignedReceipt({ receipt: clean, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('FENCE_FIELDS_MISSING');
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [{ nonce: receipt.nonce, idempotencyKey: receipt.idempotencyKey }] })).rejects.toThrow('NONCE_IDEMPOTENCY_REPLAY');
  });

  it('rejects CONSUMED/REJECTED ledger state and share-write/open-schema fields', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows });
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [{ nonce: receipt.nonce, idempotencyKey: receipt.idempotencyKey, state: 'CONSUMED' }] })).rejects.toThrow('NONCE_IDEMPOTENCY_REPLAY');
    const open = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows, overrides: { shareWriteForbidden: false } });
    await expect(verifySignedReceipt({ receipt: open, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('SHARE_WRITE');
  });

  it('CLI returns TRUST_ANCHOR_UNAVAILABLE when no trust anchor is supplied', async () => {
    const { execFileSync } = await import('node:child_process');
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgnh-receipt-cli-'));
    const receiptFile = path.join(localTmp, 'receipt.json');
    fs.writeFileSync(receiptFile, JSON.stringify({ status: 'PENDING_EXTERNAL_SIGNATURE' }), 'utf8');
    const result = execFileSync('node', [CLI, '--dry-read-only', '--receipt', receiptFile, '--pending-packet-digest', 'a'.repeat(64)], { encoding: 'utf8' });
    fs.rmSync(localTmp, { recursive: true, force: true });
    expect(result).toContain('TRUST_ANCHOR_UNAVAILABLE');
  });

  it('rejects manual/extra receiptDigest or signature in canonical preimage and open schema fields', async () => {
    const { verifySignedReceipt } = await import(MODULE);
    const { publicKey, privateKey } = makeEd25519Pair();
    const packet = buildPendingPacket({ sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }] });
    const receipt = makeReceipt({ publicKey, privateKey, packetDigest: packet.packetDigest, rows: packet.sourceRows, overrides: { extra: 'x' } });
    await expect(verifySignedReceipt({ receipt, pendingPacketDigest: packet.packetDigest, expectedSourceRows: packet.sourceRows, trustAnchorFingerprint: spkiFingerprint(publicKey), trustAnchorPublicKey: publicKey, ledger: [] })).rejects.toThrow('SCHEMA_INVALID');
  });
});
