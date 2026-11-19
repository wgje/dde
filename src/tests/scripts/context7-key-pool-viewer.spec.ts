import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const repoRoot = process.cwd();
const tokenEnvKeys = [
  'CONTEXT7_API_KEY', 'CONTEXT7_API_KEYS', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_OAUTH_CLIENT_SECRET',
  'SUPABASE_METRICS_SECRET', 'SUPABASE_SECRET_KEY', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY',
  'NG_APP_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY',
];

type ServerHandle = { child: ChildProcess; tempRoot: string; port: number };
const servers: ServerHandle[] = [];

function freePort(): number {
  return 46000 + Math.floor(Math.random() * 500);
}

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on('error', reject);
  });
}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await request(port, '/');
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`local server did not start on ${port}`);
}

function safeEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of tokenEnvKeys) delete env[key];
  return { ...env, ...overrides };
}

function start(script: string, overrides: Record<string, string>): ServerHandle {
  const tempRoot = mkdtempSync(join(tmpdir(), 'nanoflow-c249-tools-'));
  const child = spawn(process.execPath, [script], {
    cwd: repoRoot,
    env: safeEnv(overrides),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = Number(overrides.CONTEXT7_POOL_VIEWER_PORT || overrides.QUOTA_MONITOR_PORT);
  const handle = { child, tempRoot, port };
  servers.push(handle);
  return handle;
}

function stop(handle: ServerHandle): void {
  if (!handle.child.killed) handle.child.kill();
  rmSync(handle.tempRoot, { recursive: true, force: true });
}

afterEach(() => {
  while (servers.length > 0) stop(servers.pop()!);
});

describe('context7 key pool viewer local safety', () => {
  it('serves loopback GET-only status with CSP/no-store and no token-like values', async () => {
    const server = start('scripts/context7-key-pool-viewer.cjs', {
      LOCALAPPDATA: mkdtempSync(join(tmpdir(), 'nanoflow-c249-viewer-state-')),
      CONTEXT7_POOL_VIEWER_PORT: String(freePort()),
    });
    await waitForServer(server.port);
    const root = await request(server.port, '/', { host: `127.0.0.1:${server.port}` });
    const status = await request(server.port, '/api/status', { host: `127.0.0.1:${server.port}` });
    const wrongHost = await request(server.port, '/api/status', { host: `localhost:${server.port}` });
    const wrongMethod = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.port, path: '/api/status', method: 'POST', headers: { host: `127.0.0.1:${server.port}` } }, response => resolve({ status: response.statusCode ?? 0 }));
      req.on('error', reject);
      req.end();
    });
    expect(root.status).toBe(200);
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toContain('no-store');
    expect(status.headers['content-security-policy']).toContain("default-src 'none'");
    expect(wrongHost.status).toBe(403);
    expect(wrongMethod.status).toBe(405);
    expect(status.body).not.toMatch(/(?:sk-|ctx7|token|secret|api[_-]?key)[A-Za-z0-9_-]{12,}/i);
  });
});

describe('quota monitor local safe read surfaces', () => {
  it('serves loopback GET health/config/snapshot without credentials or remote collection', async () => {
    const server = start('scripts/quota-monitor.cjs', {
      QUOTA_MONITOR_DATA_DIR: mkdtempSync(join(tmpdir(), 'nanoflow-c249-quota-state-')),
      QUOTA_MONITOR_PORT: String(freePort()),
      QUOTA_MONITOR_AUTOCOLLECT: '0',
      SUPABASE_PROJECT_REF: '',
      CLOUDFLARE_API_TOKEN: '',
    });
    await waitForServer(server.port);
    const headers = { host: `127.0.0.1:${server.port}` };
    const root = await request(server.port, '/', headers);
    const health = await request(server.port, '/api/health', headers);
    const oauthApps = await request(server.port, '/api/oauth-apps', headers);
    const config = await request(server.port, '/api/config', headers);
    const snapshot = await request(server.port, '/api/snapshot', headers);
    for (const response of [root, health, oauthApps, config, snapshot]) {
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.body).not.toMatch(/(?:sk-|ctx7|token|secret|api[_-]?key)[A-Za-z0-9_-]{12,}/i);
    }
    expect(health.body).toContain('"ok":true');
    expect(oauthApps.body).toContain('"cloudflare":false');
    expect(oauthApps.body).toContain('"supabase":false');
    expect(config.body).toContain('"savedCredentials"');
    expect(snapshot.body).toContain('"catalog"');
  });
});
