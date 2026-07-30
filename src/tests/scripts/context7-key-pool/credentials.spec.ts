import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const credentialsPath = path.join(projectRoot, 'scripts', 'context7-key-pool', 'credentials.cjs');
const redactionPath = path.join(projectRoot, 'scripts', 'context7-key-pool', 'redaction.cjs');

const { KEY_NAMES, fingerprint, loadCredentialPool } = require(credentialsPath) as {
  KEY_NAMES: readonly string[];
  fingerprint(value: string): string;
  loadCredentialPool(env: Record<string, string | undefined>): Array<{
    slot: number;
    name: string;
    value: string;
    fingerprintSha256: string;
    publicIdentity: { slot: number; fingerprintSha256_12: string; length: number };
  }>;
};
const { createRedactor } = require(redactionPath) as {
  createRedactor(values: string[]): (input: unknown) => unknown;
};

function fixtureEnv(): Record<string, string | undefined> {
  return {
    CONTEXT7_API_KEY_1: 'fixture-secret-alpha',
    CONTEXT7_API_KEY_2: 'fixture-secret-bravo',
    CONTEXT7_API_KEY_3: 'fixture-secret-charlie',
    CONTEXT7_API_KEY_4: 'fixture-secret-delta',
  };
}

describe('Context7 credential boundary', () => {
  it('loads four ordered slots and exposes only public identities', () => {
    const env = fixtureEnv();
    const pool = loadCredentialPool(env);
    expect(KEY_NAMES).toEqual(['CONTEXT7_API_KEY_1','CONTEXT7_API_KEY_2','CONTEXT7_API_KEY_3','CONTEXT7_API_KEY_4']);
    expect(pool.map(entry => entry.slot)).toEqual([1, 2, 3, 4]);
    expect(pool.map(entry => entry.name)).toEqual(KEY_NAMES);
    expect(pool.map(entry => entry.value)).toEqual(KEY_NAMES.map(name => env[name]));
    for (const entry of pool) {
      expect(entry.fingerprintSha256).toBe(fingerprint(entry.value));
      expect(entry.publicIdentity).toEqual({ slot: entry.slot, fingerprintSha256_12: entry.fingerprintSha256.slice(0, 12), length: entry.value.length });
      expect(Object.keys(entry.publicIdentity).sort()).toEqual(['fingerprintSha256_12', 'length', 'slot']);
      expect(JSON.stringify(entry.publicIdentity)).not.toContain(entry.value);
    }
  });

  it('rejects every missing slot and duplicate fingerprint', () => {
    for (let slot = 1; slot <= 4; slot += 1) {
      const env = fixtureEnv();
      delete env[`CONTEXT7_API_KEY_${slot}`];
      expect(() => loadCredentialPool(env)).toThrow(`missing-context7-key-slot:${slot}`);
    }
    const duplicate = fixtureEnv();
    duplicate.CONTEXT7_API_KEY_4 = duplicate.CONTEXT7_API_KEY_2;
    expect(() => loadCredentialPool(duplicate)).toThrow('duplicate-context7-key-slots:2,4');
  });

  it('rejects empty or surrounding-whitespace values without normalizing them', () => {
    const empty = fixtureEnv();
    empty.CONTEXT7_API_KEY_3 = '';
    expect(() => loadCredentialPool(empty)).toThrow('missing-context7-key-slot:3');
    for (const invalid of [' ', ' fixture-secret-alpha', 'fixture-secret-alpha ']) {
      const env = fixtureEnv();
      env.CONTEXT7_API_KEY_1 = invalid;
      expect(() => loadCredentialPool(env)).toThrow('invalid-context7-key-whitespace-slot:1');
    }
  });

  it('redacts nested strings, Error fields, circular values and every CONTEXT7_API_KEY prefix field', () => {
    const first = 'fixture-secret-alpha';
    const second = 'fixture-secret-bravo';
    const error = new Error(`request failed for ${second}`, { cause: { detail: `cause=${first}` } });
    const input: Record<string, unknown> = {
      message: `selected=${first}`,
      nested: [{ value: `token:${second}` }],
      CONTEXT7_API_KEY_1: 'field-value-is-always-redacted',
      context7_api_key_backup: 'case-insensitive-field-redaction',
      error,
    };
    input.self = input;
    const output = createRedactor([first, second])(input) as Record<string, unknown>;
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(first);
    expect(serialized).not.toContain(second);
    expect(output.CONTEXT7_API_KEY_1).toBe('[REDACTED_SECRET]');
    expect(output.context7_api_key_backup).toBe('[REDACTED_SECRET]');
    expect(output.self).toBe('[Circular]');
    expect(output.error).toEqual(expect.objectContaining({ name: 'Error', message: 'request failed for [REDACTED_SECRET]', cause: { detail: 'cause=[REDACTED_SECRET]' } }));
  });

  it('does not mutate the original diagnostic object', () => {
    const secret = 'fixture-secret-alpha';
    const nested = { value: `token:${secret}` };
    const error = new Error(`failed:${secret}`);
    const input = { nested, error };
    const output = createRedactor([secret])(input) as typeof input;
    expect(output).not.toBe(input);
    expect(output.nested).not.toBe(nested);
    expect(input.nested).toBe(nested);
    expect(input.nested.value).toBe(`token:${secret}`);
    expect(input.error).toBe(error);
    expect(input.error.message).toBe(`failed:${secret}`);
  });
});
