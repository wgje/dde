import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL as NodeURL } from 'node:url';
import { TextDecoder, types } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const requireModule = createRequire(import.meta.url);
type SafetyModule = {
  resolveSupabaseBrowserCredentials: (sources: {
    processKey?: unknown;
    localKey?: unknown;
    processUrl?: unknown;
    localUrl?: unknown;
    localEnvSource?: unknown;
  }) => {
    keySource: 'process' | 'local' | null;
    urlSource: 'process' | 'local' | null;
    keyKind: 'publishable' | 'legacy-anon-jwt' | null;
    hostedProjectRef: string | null;
  };
};

function loadSafety(): SafetyModule {
  return requireModule('../../../scripts/lib/supabase-browser-key-safety.cjs') as SafetyModule;
}

const fixtureKey = 'sb_publishable_testkeyforbrowserbuild_12345678';
const alternateFixtureKey = 'sb_publishable_anotherbrowserfixture1_87654321';
const secretPrefix = 'sb_' + 'secret_';
const tempRoots: string[] = [];

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function legacyAnonJwt(
  payloadSource = JSON.stringify({ iss: 'supabase', role: 'anon', ref: 'projectref' }),
  headerSource = JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  signature: string | Uint8Array = new Uint8Array(32),
): string {
  return [base64Url(headerSource), base64Url(payloadSource), base64Url(signature)].join('.');
}

function makeFixture(
  scriptName: 'set-env.cjs' | 'ensure-env-files.cjs',
  indexHtml = '<!doctype html>\n',
): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-browser-key-safety-'));
  tempRoots.push(fixtureRoot);
  const scriptsDir = path.join(fixtureRoot, 'scripts');
  const libDir = path.join(scriptsDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts', scriptName), path.join(scriptsDir, scriptName));
  fs.copyFileSync(
    path.join(root, 'scripts/lib/supabase-browser-key-safety.cjs'),
    path.join(libDir, 'supabase-browser-key-safety.cjs'),
  );
  if (scriptName === 'set-env.cjs') {
    fs.copyFileSync(
      path.join(root, 'scripts/write-file-if-changed.cjs'),
      path.join(scriptsDir, 'write-file-if-changed.cjs'),
    );
    fs.writeFileSync(path.join(fixtureRoot, 'index.html'), indexHtml, 'utf8');
  }
  return fixtureRoot;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_PATH: path.join(root, 'node_modules'),
  };
  delete env.NG_APP_SUPABASE_URL;
  delete env.NG_APP_SUPABASE_ANON_KEY;
  return env;
}

afterEach(() => {
  for (const fixtureRoot of tempRoots.splice(0)) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('Supabase browser key safety', () => {
  it('loads the shared browser credential fence', () => {
    expect(() => loadSafety()).not.toThrow();
  });

  it('rejects duplicate raw credential definitions before dotenv normalization', () => {
    const safety = loadSafety();
    expect(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: [
      `NG_APP_SUPABASE_ANON_KEY=${secretPrefix}hidden`,
      `NG_APP_SUPABASE_ANON_KEY=${fixtureKey}`,
    ].join('\n') })).toThrow('supabase-browser-key-source-duplicate');
    expect(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: [
      'NG_APP_SUPABASE_URL=https://projectref.supabase.co',
      'export NG_APP_SUPABASE_URL=https://otherref.supabase.co',
    ].join('\n') })).toThrow('supabase-browser-url-source-duplicate');
    expect(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: [
      'OTHER="first',
      `NG_APP_SUPABASE_ANON_KEY=${secretPrefix}inside_multiline`,
      'last"',
      `NG_APP_SUPABASE_ANON_KEY=${fixtureKey}`,
    ].join('\n') })).not.toThrow();
  });

  it('rejects nested raw env objects and proxies without coercion or traps', () => {
    const safety = loadSafety();
    let coercions = 0;
    const objectSource = { toString: () => { coercions += 1; return ''; } };
    expect(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: objectSource }))
      .toThrow('supabase-browser-source-invalid');
    expect(coercions).toBe(0);

    const trapCounts = { get: 0, getPrototypeOf: 0 };
    const proxySource = new Proxy({}, {
      get() { trapCounts.get += 1; throw new Error('nested-get'); },
      getPrototypeOf() { trapCounts.getPrototypeOf += 1; throw new Error('nested-prototype'); },
    });
    expect(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: proxySource }))
      .toThrow('supabase-browser-source-invalid');
    expect(trapCounts).toEqual({ get: 0, getPrototypeOf: 0 });
  });

  it('ignores independent and combined mutation of credential decision methods', () => {
    const safety = loadSafety();
    const validJwt = legacyAnonJwt();
    const validSegments = validJwt.split('.');
    const validEnv = Buffer.from(`NG_APP_SUPABASE_ANON_KEY=${fixtureKey}\n`, 'utf8');
    const invalidEnv = Buffer.from([0xc3, 0x28]);
    const validHeader = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const invalidUtf8 = `${validHeader}.${base64Url(invalidEnv)}.${base64Url('signature')}`;
    const duplicateEnv = [
      `NG_APP_SUPABASE_ANON_KEY=${secretPrefix}hidden`,
      `NG_APP_SUPABASE_ANON_KEY=${fixtureKey}`,
    ].join('\n');
    const originalBufferFrom = Buffer.from;
    const mutations = [
      { id: 'stringToString', target: String.prototype, property: 'toString', replacement: () => { throw new Error('mutated'); } },
      { id: 'stringReplace', target: String.prototype, property: 'replace', replacement: () => { throw new Error('mutated'); } },
      { id: 'stringMatchAll', target: String.prototype, property: 'matchAll', replacement: () => { throw new Error('mutated'); } },
      { id: 'regexpTest', target: RegExp.prototype, property: 'test', replacement: () => true },
      { id: 'stringSplit', target: String.prototype, property: 'split', replacement: () => validSegments },
      { id: 'bufferIsBuffer', target: Buffer, property: 'isBuffer', replacement: () => true },
      {
        id: 'bufferFrom',
        target: Buffer,
        property: 'from',
        replacement: (...args: unknown[]) => Reflect.apply(originalBufferFrom, Buffer, args),
      },
      { id: 'bufferToString', target: Buffer.prototype, property: 'toString', replacement: () => { throw new Error('mutated'); } },
      { id: 'textDecode', target: TextDecoder.prototype, property: 'decode', replacement: () => { throw new Error('mutated'); } },
    ];
    const scenarios = [...mutations.map(mutation => [mutation]), mutations];
    const zeroCalls = Object.fromEntries(mutations.map(mutation => [mutation.id, 0]));
    let instanceCalls = 0;
    Object.defineProperty(validEnv, 'toString', {
      value: () => { instanceCalls += 1; throw new Error('buffer-instance-toString'); },
    });
    const captureFailure = (operation: () => unknown) => {
      try {
        operation();
        return null;
      } catch (error) {
        return error;
      }
    };

    for (const scenario of scenarios) {
      const calls = { ...zeroCalls };
      const descriptors = scenario.map(mutation => ({
        mutation,
        descriptor: Object.getOwnPropertyDescriptor(mutation.target, mutation.property)!,
      }));
      for (const { mutation, descriptor } of descriptors) {
        Object.defineProperty(mutation.target, mutation.property, {
          ...descriptor,
          value: (...args: unknown[]) => {
            calls[mutation.id] += 1;
            return mutation.replacement(...args);
          },
        });
      }
      let results;
      try {
        results = {
          publishable: safety.resolveSupabaseBrowserCredentials({ processKey: fixtureKey }),
          legacy: safety.resolveSupabaseBrowserCredentials({ processKey: validJwt }),
          raw: safety.resolveSupabaseBrowserCredentials({ processKey: fixtureKey, localEnvSource: validEnv }),
          duplicate: captureFailure(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: duplicateEnv })),
          invalidUtf8: captureFailure(() => safety.resolveSupabaseBrowserCredentials({ processKey: invalidUtf8 })),
          secret: captureFailure(() => safety.resolveSupabaseBrowserCredentials({ processKey: `${secretPrefix}browser` })),
          arbitrary: captureFailure(() => safety.resolveSupabaseBrowserCredentials({ processKey: 'not-a-jwt' })),
          invalidRaw: captureFailure(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: {} })),
          invalidBuffer: captureFailure(() => safety.resolveSupabaseBrowserCredentials({ localEnvSource: invalidEnv })),
        };
      } finally {
        for (const { mutation, descriptor } of descriptors.reverse()) {
          Object.defineProperty(mutation.target, mutation.property, descriptor);
        }
      }
      expect(calls).toEqual(zeroCalls);
      expect(results.publishable).toMatchObject({ keyKind: 'publishable' });
      expect(results.legacy).toMatchObject({ keyKind: 'legacy-anon-jwt' });
      expect(results.raw).toMatchObject({ keyKind: 'publishable' });
      expect(results.duplicate).toMatchObject({ code: 'supabase-browser-key-source-duplicate' });
      expect(results.invalidUtf8).toMatchObject({ code: 'supabase-browser-key-invalid' });
      expect(results.secret).toMatchObject({ code: 'supabase-browser-key-invalid' });
      expect(results.arbitrary).toMatchObject({ code: 'supabase-browser-key-invalid' });
      expect(results.invalidRaw).toMatchObject({ code: 'supabase-browser-source-invalid' });
      expect(results.invalidBuffer).toMatchObject({ code: 'supabase-browser-source-invalid' });
    }
    expect(instanceCalls).toBe(0);
  });
  it('uses captured methods and accessors throughout credential decisions', () => {
    const safety = loadSafety();
    const validJwt = legacyAnonJwt();
    const patches: Array<[object, PropertyKey, 'value' | 'get' | 'set']> = [
      [RegExp.prototype, 'exec', 'value'], [String.prototype, Symbol.split, 'value'],
      ...['charCodeAt', 'endsWith', 'includes', 'slice', 'toLowerCase']
        .map(name => [String.prototype, name, 'value'] as [String, string, 'value']),
      [JSON, 'parse', 'value'], [Array, 'isArray', 'value'], [Buffer, Symbol.hasInstance, 'value'],
      [Object, 'getOwnPropertyDescriptor', 'value'], [Object, 'getPrototypeOf', 'value'],
      [Object, 'hasOwn', 'value'], [Map.prototype, 'get', 'value'],
      [Set.prototype, 'add', 'value'], [Set.prototype, 'has', 'value'], [types, 'isProxy', 'value'],
      ...['protocol', 'username', 'password', 'hostname', 'origin', 'search', 'hash', 'pathname']
        .map(name => [NodeURL.prototype, name, 'get'] as [NodeURL, string, 'get']),
      [RegExp.prototype, 'global', 'get'], [RegExp.prototype, 'unicode', 'get'],
      [Error.prototype, 'code', 'set'], [Buffer.prototype, 'length', 'get'],
    ];
    const originals = patches.map(([target, property]) =>
      [target, property, Object.getOwnPropertyDescriptor(target, property)] as const);
    let calls = 0;
    for (const [target, property, kind] of patches) Object.defineProperty(target, property, {
      configurable: true, [kind]: () => { calls += 1; throw new Error('mutated-intrinsic'); },
    });
    let valid, duplicateFailure, secretFailure, invalidRawFailure;
    try {
      valid = safety.resolveSupabaseBrowserCredentials({
        processKey: validJwt, processUrl: 'https://projectref.supabase.co',
      });
      try { safety.resolveSupabaseBrowserCredentials({ localEnvSource: `NG_APP_SUPABASE_URL=a\r\nNG_APP_SUPABASE_URL=b\r\n` }); } catch (error) { duplicateFailure = error; }
      try { safety.resolveSupabaseBrowserCredentials({ processKey: `${secretPrefix}browser` }); } catch (error) { secretFailure = error; }
      try { safety.resolveSupabaseBrowserCredentials({ localEnvSource: {} }); } catch (error) { invalidRawFailure = error; }
    } finally {
      for (const [target, property, descriptor] of originals) {
        if (descriptor) Object.defineProperty(target, property, descriptor);
        else delete (target as Record<PropertyKey, unknown>)[property];
      }
    }
    expect(calls).toBe(0);
    expect(valid).toMatchObject({ keyKind: 'legacy-anon-jwt', hostedProjectRef: 'projectref' });
    expect(duplicateFailure).toMatchObject({ code: 'supabase-browser-url-source-duplicate' });
    expect(secretFailure).toMatchObject({ code: 'supabase-browser-key-invalid' });
    expect(invalidRawFailure).toMatchObject({ code: 'supabase-browser-source-invalid' });
  });
  it('accepts only the frozen publishable-key shape', () => {
    const safety = loadSafety();
    expect(safety.resolveSupabaseBrowserCredentials({ processKey: fixtureKey }).keyKind)
      .toBe('publishable');
    for (const invalid of [
      'sb_publishable_testkeyforbrowserbuil_12345678',
      'sb_publishable_testkeyforbrowserbuild_1234567',
      'sb_publishable_testkeyforbrowserbuild_123456789',
      'sb_publishable_testkeyforbrowserbuild!12345678',
      `${secretPrefix}testkeyforbrowserbuild_12345678`,
      'service_role_testkeyforbrowserbuild_12345678',
      '',
      ' ',
      '\t',
    ]) {
      expect(() => safety.resolveSupabaseBrowserCredentials({ processKey: invalid }))
        .toThrow('supabase-browser-key-invalid');
    }
  });

  it('accepts canonical legacy anon JWTs bound to an exact hosted project', () => {
    const safety = loadSafety();
    const key = legacyAnonJwt();
    const result = safety.resolveSupabaseBrowserCredentials({
      processKey: key,
      processUrl: 'HTTPS://PROJECTREF.SUPABASE.CO.:8443',
    });

    expect(result).toEqual({
      keySource: 'process',
      urlSource: 'process',
      keyKind: 'legacy-anon-jwt',
      hostedProjectRef: 'projectref',
    });
  });
  it('rejects noncanonical, malformed, duplicate-key and unauthorized JWTs', () => {
    const safety = loadSafety();
    const duplicatePayload = '{"iss":"supabase","role":"anon","\\u0072ole":"anon","ref":"projectref"}';
    const duplicateHeader = '{"alg":"HS256","\\u0061lg":"HS256"}';
    const fatalUtf8 = base64Url(Uint8Array.from([0xc3, 0x28]));
    const validPayload = base64Url(JSON.stringify({ iss: 'supabase', role: 'anon', ref: 'projectref' }));
    const validHeader = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const invalid = [
      legacyAnonJwt(duplicatePayload),
      legacyAnonJwt(undefined, duplicateHeader),
      legacyAnonJwt(`${'{"x":'.repeat(50_000)}null${'}'.repeat(50_000)}`),
      `${validHeader}.${fatalUtf8}.${base64Url('signature')}`,
      `${validHeader}.${validPayload}.AB`,
      `${validHeader}.${validPayload}.${base64Url('signature')}=`,
      `${validHeader}=.${validPayload}.${base64Url('signature')}`,
      legacyAnonJwt(undefined, JSON.stringify({ alg: 'none', typ: 'JWT' })),
      legacyAnonJwt(undefined, JSON.stringify({ alg: 'HS256', typ: 'JWS' })),
      legacyAnonJwt(undefined, JSON.stringify({ alg: 'HS256' })),
      legacyAnonJwt(JSON.stringify({ iss: 'supabase', role: 'authenticated', ref: 'projectref' })),
      legacyAnonJwt(JSON.stringify({ iss: 'other', role: 'anon', ref: 'projectref' })),
      legacyAnonJwt(JSON.stringify({ iss: 'supabase', role: 'anon', ref: '' })),
      legacyAnonJwt(JSON.stringify({ iss: 'supabase', role: 'anon', ref: 'nested.project' })),
      legacyAnonJwt(JSON.stringify(['supabase', 'anon', 'projectref'])),
      legacyAnonJwt(undefined, JSON.stringify(['HS256'])),
    ];

    for (const key of invalid) {
      expect(() => safety.resolveSupabaseBrowserCredentials({ processKey: key }))
        .toThrow('supabase-browser-key-invalid');
    }
  });

  it('enforces hosted URL syntax and exact legacy project binding', () => {
    const safety = loadSafety();
    const key = legacyAnonJwt();
    for (const invalidUrl of [
      'ftp://projectref.supabase.co',
      'https://user@projectref.supabase.co',
      'https://@projectref.supabase.co',
      'https://supabase.co',
      'https://a.projectref.supabase.co',
      'https://projectref.supabase.co..',
      'https://.supabase.co',
      'http://projectref.supabase.co',
      'https://projectref.supabase.co/path',
      'https://projectref.supabase.co/a/..',
      'https://projectref.supabase.co/%2e%2e',
      'https://projectref.supabase.co?query=1',
      'https://projectref.supabase.co#fragment',
      'not a URL',
    ]) {
      expect(() => safety.resolveSupabaseBrowserCredentials({ processKey: key, processUrl: invalidUrl }))
        .toThrow('supabase-browser-url-invalid');
    }
    expect(() => safety.resolveSupabaseBrowserCredentials({
      processKey: key,
      processUrl: 'https://otherref.supabase.co',
    })).toThrow('supabase-browser-project-ref-mismatch');
  });

  it('permits genuine custom domains without claiming domain ownership', () => {
    const safety = loadSafety();
    const result = safety.resolveSupabaseBrowserCredentials({
      processKey: legacyAnonJwt(),
      processUrl: 'https://BÜCHER.example:8443',
    });

    expect(result.hostedProjectRef).toBeNull();
    expect(result.keyKind).toBe('legacy-anon-jwt');
    expect(safety.resolveSupabaseBrowserCredentials({
      processKey: fixtureKey,
      processUrl: 'http://localhost:54321/',
    })).toMatchObject({ urlSource: 'process', hostedProjectRef: null });
  });

  it('validates every source, rejects conflicts and keeps exact-equal process precedence', () => {
    const safety = loadSafety();
    expect(() => safety.resolveSupabaseBrowserCredentials({
      processKey: fixtureKey,
      localKey: alternateFixtureKey,
    })).toThrow('supabase-browser-key-source-conflict');
    expect(() => safety.resolveSupabaseBrowserCredentials({
      processKey: fixtureKey,
      localKey: `${secretPrefix}local`,
    })).toThrow('supabase-browser-key-invalid');
    expect(() => safety.resolveSupabaseBrowserCredentials({
      processUrl: 'https://custom.example',
      localUrl: 'ftp://ignored-local.example',
    })).toThrow('supabase-browser-url-invalid');
    expect(() => safety.resolveSupabaseBrowserCredentials({
      processUrl: 'https://custom.example',
      localUrl: 'https://other.example',
    })).toThrow('supabase-browser-url-source-conflict');

    expect(safety.resolveSupabaseBrowserCredentials({
      processKey: fixtureKey,
      localKey: fixtureKey,
      processUrl: 'https://custom.example',
      localUrl: 'https://custom.example',
    })).toEqual({
      keySource: 'process',
      urlSource: 'process',
      keyKind: 'publishable',
      hostedProjectRef: null,
    });

    for (const name of ['processKey', 'localKey', 'processUrl', 'localUrl'] as const) {
      for (const value of ['', ' ', '\t']) {
        expect(() => safety.resolveSupabaseBrowserCredentials({ [name]: value }))
          .toThrow(name.endsWith('Key')
            ? 'supabase-browser-key-invalid'
            : 'supabase-browser-url-invalid');
      }
    }
  });

  it('returns only the frozen safe receipt without serializing credential inputs', () => {
    const safety = loadSafety();
    const inputUrl = 'https://custom.example';
    const receipt = safety.resolveSupabaseBrowserCredentials({
      localKey: fixtureKey,
      localUrl: inputUrl,
    });

    expect(Object.keys(receipt)).toEqual([
      'keySource',
      'urlSource',
      'keyKind',
      'hostedProjectRef',
    ]);
    expect(receipt).toEqual({
      keySource: 'local',
      urlSource: 'local',
      keyKind: 'publishable',
      hostedProjectRef: null,
    });
    expect(JSON.stringify(receipt)).not.toContain(fixtureKey);
    expect(JSON.stringify(receipt)).not.toContain(inputUrl);
  });

  it('rejects accessor-backed and inherited credential sources without reading them', () => {
    const safety = loadSafety();
    let getterReads = 0;
    const accessorSources = {} as { processKey?: string };
    Object.defineProperty(accessorSources, 'processKey', {
      get() {
        getterReads += 1;
        return getterReads === 1 ? fixtureKey : `${secretPrefix}late`;
      },
    });

    expect(() => safety.resolveSupabaseBrowserCredentials(accessorSources))
      .toThrow('supabase-browser-source-invalid');
    expect(getterReads).toBe(0);
    expect(() => safety.resolveSupabaseBrowserCredentials(
      Object.create({ processKey: fixtureKey }) as { processKey?: string },
    )).toThrow('supabase-browser-source-invalid');
  });

  it('rejects proxy credential sources without triggering any proxy trap', () => {
    const safety = loadSafety();
    const trapCounts = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 };
    const handler: ProxyHandler<Record<string, string>> = {};
    for (const trap of Object.keys(trapCounts) as (keyof typeof trapCounts)[]) {
      handler[trap] = (() => {
        trapCounts[trap] += 1;
        throw new Error(`proxy-${trap}`);
      }) as never;
    }
    for (const target of [
      { processKey: fixtureKey },
      Object.assign(Object.create(null) as Record<string, string>, { processKey: fixtureKey }),
    ]) {
      expect(() => safety.resolveSupabaseBrowserCredentials(new Proxy(target, handler)))
        .toThrow('supabase-browser-source-invalid');
    }
    expect(trapCounts).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 });

    const revocable = Proxy.revocable({ processKey: fixtureKey }, handler);
    revocable.revoke();
    expect(() => safety.resolveSupabaseBrowserCredentials(revocable.proxy))
      .toThrow('supabase-browser-source-invalid');
    expect(trapCounts).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 });
  });

  it('accepts an ordinary null-prototype record with own credential data', () => {
    const safety = loadSafety();
    const sources = Object.assign(Object.create(null) as Record<string, string>, {
      processKey: fixtureKey,
      processUrl: 'https://custom.example',
    });

    expect(safety.resolveSupabaseBrowserCredentials(sources)).toMatchObject({
      keySource: 'process',
      urlSource: 'process',
      keyKind: 'publishable',
    });
  });

  it('keeps all three consumers ordered behind the shared acceptance receipt', () => {
    const boundaries = [
      ['scripts/validate-env.cjs', 'const env = {'],
      ['scripts/set-env.cjs', 'const targetPath ='],
      ['scripts/ensure-env-files.cjs', 'fs.mkdirSync(envDir'],
    ] as const;

    for (const [relativePath, firstSideEffect] of boundaries) {
      const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
      const rawFenceIndex = source.indexOf('resolveSupabaseBrowserCredentials({ localEnvSource })');
      const normalizedFenceIndex = source.lastIndexOf('resolveSupabaseBrowserCredentials({');
      expect(source.indexOf('const processSupabaseUrl = process.env.NG_APP_SUPABASE_URL'))
        .toBeLessThan(rawFenceIndex);
      expect(rawFenceIndex).toBeLessThan(source.indexOf('dotenv.parse'));
      expect(source.indexOf('dotenv.parse')).toBeLessThan(normalizedFenceIndex);
      expect(normalizedFenceIndex).toBeLessThan(source.indexOf(firstSideEffect));
      expect(source).not.toContain('dotenv.config(');
    }
  });

  it('rejects set-env credentials before creating output directories', () => {
    const fixtureRoot = makeFixture('set-env.cjs');
    const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/set-env.cjs')], {
      cwd: fixtureRoot,
      env: {
        ...cleanEnv(),
        NG_APP_SUPABASE_URL: 'https://projectref.supabase.co',
        NG_APP_SUPABASE_ANON_KEY: `${secretPrefix}must_not_reach_browser_output`,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('supabase-browser-key-invalid');
    expect(`${result.stdout}${result.stderr}`).not.toContain('must_not_reach_browser_output');
    expect(fs.existsSync(path.join(fixtureRoot, 'src/environments'))).toBe(false);
    expect(fs.existsSync(path.join(fixtureRoot, '.tmp'))).toBe(false);
  });

  it('rejects local ensure-env-files credentials before mkdir', () => {
    const fixtureRoot = makeFixture('ensure-env-files.cjs');
    fs.writeFileSync(
      path.join(fixtureRoot, '.env.local'),
      `NG_APP_SUPABASE_URL=https://projectref.supabase.co\nNG_APP_SUPABASE_ANON_KEY=${secretPrefix}local\n`,
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, 'scripts/ensure-env-files.cjs')],
      { cwd: fixtureRoot, env: cleanEnv(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('supabase-browser-key-invalid');
    expect(`${result.stdout}${result.stderr}`).not.toContain(`${secretPrefix}local`);
    expect(fs.existsSync(path.join(fixtureRoot, 'src/environments'))).toBe(false);
  });

  it.each(['set-env.cjs', 'ensure-env-files.cjs'] as const)(
    'rejects every duplicate local key occurrence before %s output mutation',
    scriptName => {
      for (const [first, second] of [
        [`${secretPrefix}hidden_duplicate`, fixtureKey],
        [fixtureKey, alternateFixtureKey],
      ]) {
        const fixtureRoot = makeFixture(scriptName);
        fs.writeFileSync(path.join(fixtureRoot, '.env.local'), [
          'NG_APP_SUPABASE_URL=https://projectref.supabase.co',
          `NG_APP_SUPABASE_ANON_KEY=${first}`,
          `NG_APP_SUPABASE_ANON_KEY=${second}`,
          '',
        ].join('\n'), 'utf8');
        const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts', scriptName)], {
          cwd: fixtureRoot,
          env: cleanEnv(),
          encoding: 'utf8',
        });

        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain('supabase-browser-key-source-duplicate');
        expect(`${result.stdout}${result.stderr}`).not.toContain('hidden_duplicate');
        expect(fs.existsSync(path.join(fixtureRoot, 'src/environments'))).toBe(false);
        expect(fs.existsSync(path.join(fixtureRoot, '.tmp'))).toBe(false);
      }
    },
  );

  it('rejects a derived hosted URL bound to a different legacy JWT project before mkdir', () => {
    const sourceHtml = '<link rel="preconnect" href="https://otherref.supabase.co">\n';
    const fixtureRoot = makeFixture('set-env.cjs', sourceHtml);
    const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/set-env.cjs')], {
      cwd: fixtureRoot,
      env: { ...cleanEnv(), NG_APP_SUPABASE_ANON_KEY: legacyAnonJwt() },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('supabase-browser-project-ref-mismatch');
    expect(fs.existsSync(path.join(fixtureRoot, 'src/environments'))).toBe(false);
    expect(fs.existsSync(path.join(fixtureRoot, '.tmp'))).toBe(false);
    expect(fs.readFileSync(path.join(fixtureRoot, 'index.html'), 'utf8')).toBe(sourceHtml);
  });

  it('accepts a matching derived hosted URL for a legacy JWT before publishing generated copies', () => {
    const sourceHtml = '<link rel="preconnect" href="https://projectref.supabase.co">\n';
    const fixtureRoot = makeFixture('set-env.cjs', sourceHtml);
    const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/set-env.cjs')], {
      cwd: fixtureRoot,
      env: { ...cleanEnv(), NG_APP_SUPABASE_ANON_KEY: legacyAnonJwt() },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(fixtureRoot, 'index.html'), 'utf8')).toBe(sourceHtml);
    expect(fs.readFileSync(path.join(fixtureRoot, '.tmp/index.generated.html'), 'utf8'))
      .toContain('https://projectref.supabase.co');
  });

  it('rewrites hosted hints only in the generated copy and removes stale hints for self-host', () => {
    const sourceHtml = [
      '<!doctype html>',
      '<link rel="preconnect" href="https://oldref.supabase.co">',
      '<link rel="dns-prefetch" href="https://oldref.supabase.co">',
      "<script>var SUPABASE_URL = ''; var SUPABASE_ANON_KEY = '';</script>",
      '',
    ].join('\n');

    for (const [url, expectedHint] of [
      ['https://projectref.supabase.co', 'https://projectref.supabase.co'],
      ['HTTPS://PROJECTREF.SUPABASE.CO.:8443/', 'HTTPS://PROJECTREF.SUPABASE.CO.:8443/'],
      ['http://localhost:54321', null],
    ] as const) {
      const fixtureRoot = makeFixture('set-env.cjs', sourceHtml);
      const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/set-env.cjs')], {
        cwd: fixtureRoot,
        env: {
          ...cleanEnv(),
          NG_APP_SUPABASE_URL: url,
          NG_APP_SUPABASE_ANON_KEY: fixtureKey,
        },
        encoding: 'utf8',
      });
      const generated = fs.readFileSync(path.join(fixtureRoot, '.tmp/index.generated.html'), 'utf8');

      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(fixtureRoot, 'index.html'), 'utf8')).toBe(sourceHtml);
      expect(generated.includes('oldref.supabase.co')).toBe(false);
      if (expectedHint) {
        expect(generated).toContain(`<link rel="preconnect" href="${expectedHint}">`);
        expect(generated).toContain(`<link rel="dns-prefetch" href="${expectedHint}">`);
      } else {
        expect(generated).not.toContain('rel="preconnect"');
        expect(generated).not.toContain('rel="dns-prefetch"');
      }
    }
  });
});
