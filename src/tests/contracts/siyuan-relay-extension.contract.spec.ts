import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = process.cwd();
const relayRoot = path.join(root, 'extensions', 'siyuan-relay');
const manifestPath = path.join(relayRoot, 'manifest.json');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

interface ExtensionManifest {
  manifest_version?: number;
  version?: string;
  background?: {
    service_worker?: string;
  };
  content_scripts?: Array<{
    js?: string[];
    matches?: string[];
  }>;
  options_page?: string;
}

function readManifest(): ExtensionManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;
}

function expectRelayFile(relativePath: string | undefined): void {
  if (!relativePath) {
    throw new Error('manifest must reference a concrete file path');
  }
  expect(fs.existsSync(path.join(relayRoot, relativePath))).toBe(true);
}

interface RelayBackgroundMessage {
  type: string;
  requestId: string;
  ownerUserId?: string;
  configIssuedAt?: number;
  payload?: Record<string, unknown>;
}

interface RelayBackgroundResponse {
  type: string;
  requestId: string;
  ownerUserId?: string;
  ok: boolean;
  errorCode?: string;
}

function createBackgroundHarness(initialStorage: Record<string, unknown> = {}) {
  const background = read('extensions/siyuan-relay/src/background.js');
  const storage = new Map<string, unknown>(Object.entries(initialStorage));
  let listener: ((
    message: RelayBackgroundMessage,
    sender: unknown,
    sendResponse: (response: RelayBackgroundResponse) => void,
  ) => boolean) | undefined;
  const consoleMock = {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    const data = pathname === '/api/block/getBlockKramdown'
      ? { id: '20260426123456-abc1234', kramdown: 'owner scoped preview' }
      : pathname === '/api/filetree/getHPathByID'
        ? { hPath: '/owner/scoped' }
        : pathname === '/api/block/getChildBlocks'
          ? []
          : {};
    return {
      status: 200,
      ok: true,
      json: async () => ({ code: 0, data }),
      requestInit: init,
    };
  });
  const chrome = {
    runtime: {
      onMessage: {
        addListener: vi.fn((next: typeof listener) => {
          listener = next;
        }),
      },
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(
          keys.filter(key => storage.has(key)).map(key => [key, storage.get(key)]),
        )),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const key of keys) storage.delete(key);
        }),
        setAccessLevel: vi.fn(async () => undefined),
      },
    },
  };

  vm.runInNewContext(background, {
    AbortController,
    DOMException,
    URL,
    chrome,
    clearTimeout,
    console: consoleMock,
    crypto: globalThis.crypto,
    fetch: fetchMock,
    setTimeout,
  });

  return {
    chrome,
    consoleMock,
    fetchMock,
    storage,
    async send(message: RelayBackgroundMessage): Promise<RelayBackgroundResponse> {
      if (!listener) throw new Error('background message listener was not registered');
      return await new Promise(resolve => {
        listener?.(message, {}, resolve);
      });
    },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SiYuan relay extension contract', () => {
  it('keeps the unpacked extension root loadable by Chrome', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readManifest();
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe('0.3.0');
    expectRelayFile(manifest.background?.service_worker);
    expectRelayFile(manifest.options_page);

    const contentScripts = manifest.content_scripts ?? [];
    expect(contentScripts.length).toBeGreaterThan(0);
    for (const script of contentScripts) {
      expect(script.js?.length ?? 0).toBeGreaterThan(0);
      for (const jsPath of script.js ?? []) {
        expectRelayFile(jsPath);
      }
    }
  });
});

/**
 * 这些契约用例锁定 SiYuan Relay 扩展静态文件与 NanoFlow 页面侧
 * `SiyuanExtensionProvider` 之间的"消息形状/白名单/origin 约束"约定，
 * 防止其中一侧无声地漂移导致页面填了 baseUrl/token 却不联通到扩展。
 */
describe('SiYuan Relay extension contracts', () => {
  it('content-script whitelists the page→extension message types in lockstep with responseTypeFor', () => {
    const contentScript = read('extensions/siyuan-relay/src/content-script.js');

    expect(contentScript).toMatch(/ALLOWED_MESSAGE_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    const allowedBlock = contentScript.match(/ALLOWED_MESSAGE_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/)![1];
    const allowed = Array.from(allowedBlock.matchAll(/'([^']+)'/g)).map((m) => m[1]).sort();

    expect(allowed).toEqual([
      'nanoflow.siyuan.ping',
      'nanoflow.siyuan.v3.get-config-status',
      'nanoflow.siyuan.v3.get-preview',
      'nanoflow.siyuan.v3.set-config',
      'nanoflow.siyuan.v3.test-connection',
    ]);
    expect(allowed).not.toContain('nanoflow.siyuan.set-config');
    expect(allowed).not.toContain('nanoflow.siyuan.get-preview');

    // 每一个 allowed type 都必须能映射到一个 response type
    for (const requestType of allowed) {
      expect(contentScript).toContain(`'${requestType}'`);
    }
    expect(contentScript).toContain("'nanoflow.siyuan.v3.set-config-result'");
    expect(contentScript).toContain("'nanoflow.siyuan.v3.config-status-result'");
  });

  it('background.js handles set-config and get-config-status, but never returns token plaintext', () => {
    const background = read('extensions/siyuan-relay/src/background.js');

    expect(background).toContain("message.type === 'nanoflow.siyuan.v3.set-config'");
    expect(background).toContain("message.type === 'nanoflow.siyuan.v3.get-config-status'");

    // get-config-status 的 data 字段只能包含 baseUrl / hasToken。
    const statusBlock = background.match(/async function getConfigStatus[\s\S]*?\n\}/);
    expect(statusBlock).toBeTruthy();
    const statusSrc = statusBlock![0];
    expect(statusSrc).toContain('hasToken');
    // 不允许在响应里直接写出 token 明文字段
    expect(statusSrc).not.toMatch(/data:\s*\{[^}]*\btoken\s*:/);
  });

  it('background.js validates baseUrl with the same 127.0.0.1/localhost whitelist as the page provider', () => {
    const background = read('extensions/siyuan-relay/src/background.js');
    // 与 src/app/core/external-sources/siyuan/siyuan-direct-provider.ts 的白名单语义一致：
    expect(background).toContain("'http://127.0.0.1:6806'");
    expect(background).toContain("'http://localhost:6806'");
    expect(background).toContain('isTrustedBaseUrl');
    expect(background).toContain("'/api/filetree/getPathByID'");
    expect(background).toContain("'/api/filetree/getHPathByPath'");
    expect(background).toContain('ABSOLUTE_HPATH_FETCH_TIMEOUT_MS');
  });

  it('manifest content_scripts whitelist still covers nanoflow domains and uses an MV3 service worker', () => {
    const manifest = JSON.parse(read('extensions/siyuan-relay/manifest.json')) as {
      manifest_version: number;
      background: { service_worker: string };
      content_scripts: { matches: string[] }[];
    };

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe('src/background.js');
    const matches = manifest.content_scripts[0]?.matches ?? [];
    expect(matches).toContain('https://nanoflow.app/*');
    expect(matches).toContain('https://nanoflow.pages.dev/*');
  });

  it('keeps the published manifest and runtime allowlist aligned without local development origins', () => {
    const manifest = readManifest();
    const manifestOrigins = (manifest.content_scripts ?? [])
      .flatMap(script => script.matches ?? [])
      .map(match => new URL(match.replace(/\*$/, '')).origin)
      .sort();
    const contentScript = read('extensions/siyuan-relay/src/content-script.js');
    const runtimeBlock = contentScript.match(/BUILTIN_ALLOWED_ORIGINS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);

    expect(runtimeBlock).toBeTruthy();
    const runtimeOrigins = Array.from(runtimeBlock![1].matchAll(/'([^']+)'/g))
      .map(match => match[1])
      .sort();

    for (const origin of [...manifestOrigins, ...runtimeOrigins]) {
      expect(new URL(origin).hostname).not.toMatch(/^(?:localhost|127\.0\.0\.1)$/);
    }
    expect(runtimeOrigins).toEqual(manifestOrigins);
  });

  it('page-side SiyuanExtensionProvider speaks the same message types as the extension', () => {
    const provider = read('src/app/core/external-sources/siyuan/siyuan-extension-provider.ts');

    expect(provider).toContain("'nanoflow.siyuan.v3.set-config'");
    expect(provider).toContain("'nanoflow.siyuan.v3.set-config-result'");
    expect(provider).toContain("'nanoflow.siyuan.v3.get-config-status'");
    expect(provider).toContain("'nanoflow.siyuan.v3.config-status-result'");

    // pushConfig 的 payload 只允许包含 baseUrl 和（可选的）token，
    // 防止未来误加字段被 content-script 静默放行后透传给扩展。
    const pushSource = provider.match(/async pushConfig[\s\S]*?\n  \}/);
    expect(pushSource).toBeTruthy();
    expect(pushSource![0]).toMatch(/payload\s*:\s*Record<string,\s*unknown>\s*=\s*\{\s*baseUrl/);
    expect(pushSource![0]).toContain('payload.token = input.token');
  });

  it('owner A credentials cannot execute a get-preview request captured for owner B', async () => {
    const relay = createBackgroundHarness();
    await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'set-owner-a',
      ownerUserId: 'owner-a',
      configIssuedAt: 100,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'token-a' },
    });

    const response = await relay.send({
      type: 'nanoflow.siyuan.v3.get-preview',
      requestId: 'preview-owner-b',
      ownerUserId: 'owner-b',
      payload: { blockId: '20260426123456-abc1234' },
    });

    expect(response).toMatchObject({
      requestId: 'preview-owner-b',
      ownerUserId: 'owner-b',
      ok: false,
      errorCode: 'not-configured',
    });
    expect(relay.fetchMock).not.toHaveBeenCalled();
  });

  it('legacy ownerless credentials remain fail-closed instead of being guessed into the current owner', async () => {
    const relay = createBackgroundHarness({
      baseUrl: 'http://127.0.0.1:6806',
      token: 'legacy-token',
    });

    const response = await relay.send({
      type: 'nanoflow.siyuan.v3.get-preview',
      requestId: 'legacy-preview',
      ownerUserId: 'owner-b',
      payload: { blockId: '20260426123456-abc1234' },
    });

    expect(response).toMatchObject({ ok: false, errorCode: 'not-configured' });
    expect(relay.fetchMock).not.toHaveBeenCalled();
  });

  it('A-B-A restores the credential keyed to A instead of reusing B', async () => {
    const relay = createBackgroundHarness();
    await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'set-a',
      ownerUserId: 'owner-a',
      configIssuedAt: 100,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'token-a' },
    });
    await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'set-b',
      ownerUserId: 'owner-b',
      configIssuedAt: 200,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'token-b' },
    });

    const response = await relay.send({
      type: 'nanoflow.siyuan.v3.get-preview',
      requestId: 'preview-a-again',
      ownerUserId: 'owner-a',
      payload: { blockId: '20260426123456-abc1234' },
    });

    expect(response).toMatchObject({ ok: true, ownerUserId: 'owner-a' });
    expect(JSON.stringify(response)).not.toContain('token-a');
    expect(relay.fetchMock).toHaveBeenCalled();
    for (const call of relay.fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Token token-a' });
    }
    expect(relay.consoleMock.log).not.toHaveBeenCalled();
    expect(relay.consoleMock.warn).not.toHaveBeenCalled();
    expect(relay.consoleMock.error).not.toHaveBeenCalled();
  });

  it('a late owner A config write cannot replace owner B credentials', async () => {
    const relay = createBackgroundHarness();
    await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'set-b-first',
      ownerUserId: 'owner-b',
      configIssuedAt: 200,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'token-b' },
    });
    await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'late-set-a',
      ownerUserId: 'owner-a',
      configIssuedAt: 100,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'late-token-a' },
    });

    const response = await relay.send({
      type: 'nanoflow.siyuan.v3.get-preview',
      requestId: 'preview-b-after-late-a',
      ownerUserId: 'owner-b',
      payload: { blockId: '20260426123456-abc1234' },
    });

    expect(response).toMatchObject({ ok: true, ownerUserId: 'owner-b' });
    expect(relay.fetchMock).toHaveBeenCalled();
    for (const call of relay.fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Token token-b' });
    }
  });

  it('an older A config arriving last cannot overwrite a newer A config', async () => {
    const relay = createBackgroundHarness();
    await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'new-a-config',
      ownerUserId: 'owner-a',
      configIssuedAt: 200,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'new-token-a' },
    });
    await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'old-a-config-arrived-late',
      ownerUserId: 'owner-a',
      configIssuedAt: 100,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'old-token-a' },
    });

    const response = await relay.send({
      type: 'nanoflow.siyuan.v3.get-preview',
      requestId: 'preview-a-after-stale-write',
      ownerUserId: 'owner-a',
      payload: { blockId: '20260426123456-abc1234' },
    });

    expect(response).toMatchObject({ ok: true, ownerUserId: 'owner-a' });
    expect(relay.fetchMock).toHaveBeenCalled();
    for (const call of relay.fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Token new-token-a' });
    }
  });

  it('does not apply legacy unversioned set-config messages to global or owner storage', async () => {
    const relay = createBackgroundHarness({
      baseUrl: 'http://127.0.0.1:6806',
      token: 'legacy-token',
    });

    const response = await relay.send({
      type: 'nanoflow.siyuan.set-config',
      requestId: 'legacy-set-config',
      ownerUserId: 'owner-a',
      configIssuedAt: 300,
      payload: { baseUrl: 'http://localhost:6806', token: 'new-token' },
    });

    expect(response).toMatchObject({
      type: 'nanoflow.siyuan.v3.preview-result',
      requestId: 'legacy-set-config',
      ok: false,
      errorCode: 'unknown',
    });
    expect(relay.storage.get('baseUrl')).toBe('http://127.0.0.1:6806');
    expect(relay.storage.get('token')).toBe('legacy-token');
    expect(relay.storage.has('nanoflow.siyuan.owner.owner-a')).toBe(false);
  });

  it('rejects unsupported set-config payload fields before storage writes', async () => {
    const relay = createBackgroundHarness();

    const response = await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'set-config-extra-field',
      ownerUserId: 'owner-a',
      configIssuedAt: 300,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'new-token', debug: true },
    });

    expect(response).toMatchObject({
      type: 'nanoflow.siyuan.v3.set-config-result',
      requestId: 'set-config-extra-field',
      ownerUserId: 'owner-a',
      ok: false,
      errorCode: 'unknown',
    });
    expect(relay.storage.size).toBe(0);
  });

  it('serializes same-owner config writes while allowing other owners to proceed', async () => {
    const ownerAKey = 'nanoflow.siyuan.owner.owner-a';
    const ownerARecord = {
      ownerUserId: 'owner-a',
      baseUrl: 'http://127.0.0.1:6806',
      token: 'old-token-a',
      configIssuedAt: 100,
    };
    const relay = createBackgroundHarness({ [ownerAKey]: ownerARecord });
    const firstWriteStarted = createDeferred<void>();
    const finishFirstWrite = createDeferred<void>();
    const ownerAReads: string[][] = [];

    relay.chrome.storage.local.get.mockImplementation(async (keys) => {
      if (keys[0] === ownerAKey) ownerAReads.push(keys);
      return Object.fromEntries(keys.filter(key => relay.storage.has(key)).map(key => [key, relay.storage.get(key)]));
    });
    relay.chrome.storage.local.set.mockImplementation(async (values) => {
      const ownerA = values[ownerAKey] as typeof ownerARecord | undefined;
      if (ownerA?.configIssuedAt === 200) {
        firstWriteStarted.resolve();
        await finishFirstWrite.promise;
      }
      for (const [key, value] of Object.entries(values)) relay.storage.set(key, value);
    });

    const olderWrite = relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'older-write',
      ownerUserId: 'owner-a',
      configIssuedAt: 200,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'older-token-a' },
    });
    await firstWriteStarted.promise;

    const newerWrite = relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'newer-write',
      ownerUserId: 'owner-a',
      configIssuedAt: 300,
      payload: { baseUrl: 'http://localhost:6806', token: 'newer-token-a' },
    });
    const otherOwnerWrite = await relay.send({
      type: 'nanoflow.siyuan.v3.set-config',
      requestId: 'other-owner-write',
      ownerUserId: 'owner-b',
      configIssuedAt: 100,
      payload: { baseUrl: 'http://127.0.0.1:6806', token: 'token-b' },
    });

    expect(otherOwnerWrite).toMatchObject({ requestId: 'other-owner-write', ownerUserId: 'owner-b', ok: true });
    expect(ownerAReads).toHaveLength(1);

    finishFirstWrite.resolve();
    const [olderResponse, newerResponse] = await Promise.all([olderWrite, newerWrite]);

    expect(olderResponse).toMatchObject({ requestId: 'older-write', ownerUserId: 'owner-a', ok: true });
    expect(newerResponse).toMatchObject({ requestId: 'newer-write', ownerUserId: 'owner-a', ok: true });
    expect(ownerAReads).toHaveLength(2);
    expect(relay.storage.get(ownerAKey)).toEqual({
      ownerUserId: 'owner-a',
      baseUrl: 'http://localhost:6806',
      token: 'newer-token-a',
      configIssuedAt: 300,
    });
  });

  it('the extension Options page cannot create ownerless relay credentials', () => {
    const options = read('extensions/siyuan-relay/src/options.js');
    const optionsHtml = read('extensions/siyuan-relay/src/options.html');

    expect(options).not.toContain('chrome.storage.local.set');
    expect(optionsHtml).not.toContain('id="token"');
    expect(optionsHtml).toContain('NanoFlow 设置页');
  });
});
