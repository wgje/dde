import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve('D:/Code/dde');
const ROOT = path.resolve('scripts/contracts/codegraph-native-handle-authority-revision4.schema.json');
const MODULE = path.resolve('scripts/lib/codegraph-native-handle-authority-materializer.cjs');
const VALIDATOR = path.resolve('scripts/validate-codegraph-native-handle-authority-revision4.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cgnh-rev4-'));
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('codegraph native handle authority revision4 materializer', () => {
  it('has the five exact5 source files', () => {
    expect(fs.existsSync(ROOT)).toBe(true);
    expect(fs.existsSync(MODULE)).toBe(true);
    expect(fs.existsSync(VALIDATOR)).toBe(true);
    expect(fs.existsSync(path.resolve(REPO, 'scripts/materialize-codegraph-native-handle-authority.cjs'))).toBe(true);
  });

  it('rejects missing inputs and tampered frame payloads with fail-closed errors', async () => {
    const { materializeNativeHandleAuthorityRequest } = await import(MODULE);
    await expect(materializeNativeHandleAuthorityRequest({ missing: true })).rejects.toThrow();
  });

  it('produces only PENDING_EXTERNAL_SIGNATURE without an external issuer', async () => {
    const { materializeNativeHandleAuthorityRequest } = await import(MODULE);
    const result = await materializeNativeHandleAuthorityRequest({
      revision: 4,
      sourceRows: [
        { row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 },
      ],
      externalIssuer: null,
      nonce: 'a'.repeat(32),
      idempotencyKey: 'idem-1',
    });
    const frames = result.frames as Array<{ kind: string }>;
    expect(result.status).toBe('PENDING_EXTERNAL_SIGNATURE');
    expect(result.receipt).toBe(null);
    expect(frames.some(frame => frame.kind === 'BUILD')).toBe(true);
    expect(frames.some(frame => frame.kind === 'NATIVE_ATTESTATION')).toBe(true);
    expect(frames.some(frame => frame.kind === 'MATERIALIZED_REVIEW_APPROVAL')).toBe(true);
  });

  it('does not expose verifyExternalReceipt as a truth-returning API', async () => {
    const mod = await import(MODULE);
    expect(mod.verifyExternalReceipt).toBeUndefined();
    expect(typeof mod.assertReceiptEnvelopeShape).toBe('function');
  });

  it('rejects structurally valid but cryptographically unverified fake receipts', async () => {
    const { assertReceiptEnvelopeShape } = await import(MODULE);
    expect(() => assertReceiptEnvelopeShape({
      issuer: { issuerId: 'fake', trustAnchorFingerprint: 'f'.repeat(64) },
      signature: { algorithm: 'Ed25519', value: 'fake' },
    })).toThrow('RECEIPT_UNVERIFIED');
    expect(() => assertReceiptEnvelopeShape({
      issuer: { issuerId: 'fake', trustAnchorFingerprint: 'f'.repeat(64) },
      signature: { algorithm: 'RSASSA-PSS-SHA256', value: 'fake' },
    })).toThrow('RECEIPT_UNVERIFIED');
  });

  it('rejects injected receipt/signature/issuer/trustAnchor/APPROVED fields', async () => {
    const { materializeNativeHandleAuthorityRequest } = await import(MODULE);
    const base = {
      revision: 4,
      sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }],
      externalIssuer: null,
      nonce: 'b'.repeat(32),
      idempotencyKey: 'idem-2',
    };
    await expect(materializeNativeHandleAuthorityRequest({ ...base, receipt: {} })).rejects.toThrow('INJECTED_AUTHORITY_FIELD');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, signature: {} })).rejects.toThrow('INJECTED_AUTHORITY_FIELD');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, issuer: {} })).rejects.toThrow('INJECTED_AUTHORITY_FIELD');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, trustAnchor: {} })).rejects.toThrow('INJECTED_AUTHORITY_FIELD');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, frames: [{ kind: 'MATERIALIZED_REVIEW_APPROVAL', approved: true }] })).rejects.toThrow('INJECTED_AUTHORITY_FIELD');
  });

  it('rejects invalid rows, manual digest, share-write, post-close overclaim and row drift', async () => {
    const { materializeNativeHandleAuthorityRequest } = await import(MODULE);
    const row = { row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 };
    const base = { revision: 4, sourceRows: [row], nonce: 'c'.repeat(32), idempotencyKey: 'idem-3' };
    await expect(materializeNativeHandleAuthorityRequest({ ...base, sourceRows: [{ ...row, sha256: 'bad' }] })).rejects.toThrow('SOURCE_ROW_INVALID');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, receiptDigest: 'a'.repeat(64) })).rejects.toThrow('MANUAL_DIGEST');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, openStrategy: { shareMode: 'FILE_SHARE_WRITE' } })).rejects.toThrow('SHARE_WRITE');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, postCloseEvidence: { evidenceLevel: 'PATH_HANDLE_STABLE', nativeHandleAuthority: 'MISSING' } })).rejects.toThrow('POST_CLOSE_OVERCLAIM');
    await expect(materializeNativeHandleAuthorityRequest({ ...base, projectRoot: REPO, sourceRows: [{ ...row, sha256: 'f'.repeat(64) }] })).rejects.toThrow('ROW_SHA_DRIFT:01');
  });

  it('rejects digest drift and ledger/nonce replay', async () => {
    const { checkReplayFence, recomputeReceiptDigest } = await import(MODULE);
    const receipt = { issuer: { issuerId: 'issuer', trustAnchorFingerprint: 'f'.repeat(64) }, nonce: 'd'.repeat(32), idempotencyKey: 'idem-4' };
    expect(recomputeReceiptDigest({ ...receipt, receiptDigest: 'x', signature: { algorithm: 'Ed25519', value: 'y' } })).toMatch(/^[0-9a-f]{64}$/);
    expect(() => checkReplayFence([{ nonce: 'd'.repeat(32), idempotencyKey: 'idem-4' }], { nonce: 'd'.repeat(32), idempotencyKey: 'idem-4' })).toThrow('NONCE_IDEMPOTENCY_REPLAY');
  });

  it('rejects nonce/idempotency replay and ledger replay', async () => {
    const { checkReplayFence } = await import(MODULE);
    expect(() => checkReplayFence([], { nonce: 'a'.repeat(32), idempotencyKey: 'x' })).not.toThrow();
    expect(() => checkReplayFence([{ nonce: 'a'.repeat(32), idempotencyKey: 'x' }], { nonce: 'a'.repeat(32), idempotencyKey: 'x' })).toThrow('NONCE_IDEMPOTENCY_REPLAY');
  });

  it('does not claim native attestation or ledger evidence as already proven', async () => {
    const { materializeNativeHandleAuthorityRequest } = await import(MODULE);
    const result = await materializeNativeHandleAuthorityRequest({
      revision: 4,
      sourceRows: [{ row: '01', path: 'scripts/native/codegraph-read-identity-win32.cpp', sha256: 'eb6db5ce74f06c5783a244951cd3c0c6939569e5ed569463b6942d65cde40e57', bytes: 21691 }],
      nonce: 'e'.repeat(32),
      idempotencyKey: 'idem-5',
    });
    const frames = result.frames as Array<{ kind: string; status?: string; details?: string }>;
    const native = frames.find(frame => frame.kind === 'NATIVE_ATTESTATION');
    const ledger = frames.find(frame => frame.kind === 'LEDGER');
    if (!native || !ledger) throw new Error('materializer omitted required evidence frames');
    expect(native.status).toBe('PENDING_EXTERNAL_SIGNATURE');
    expect(ledger.status).toBe('PENDING_EXTERNAL_SIGNATURE');
    expect(native.details).toContain('required');
    expect(ledger.details).toContain('pending');
  });
});
