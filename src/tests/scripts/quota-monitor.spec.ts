import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const tokenKeys = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_OAUTH_CLIENT_SECRET', 'SUPABASE_METRICS_SECRET', 'SUPABASE_SECRET_KEY', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY'];
const processes: Array<{ child: ReturnType<typeof spawn>; tempRoot: string }> = [];
const port = 46400 + Math.floor(Math.random() * 400);

function get(pathname: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}` } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
  });
}

async function start(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'nanoflow-c249-quota-spec-'));
  const env: NodeJS.ProcessEnv = { ...process.env, QUOTA_MONITOR_DATA_DIR: tempRoot, QUOTA_MONITOR_PORT: String(port), QUOTA_MONITOR_AUTOCOLLECT: '0' };
  for (const key of tokenKeys) delete env[key];
  const child = spawn(process.execPath, ['scripts/quota-monitor.cjs'], { cwd: process.cwd(), env, stdio: 'ignore', windowsHide: true });
  processes.push({ child, tempRoot });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await get('/api/health'); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error('quota monitor did not start');
}

afterEach(() => {
  for (const { child, tempRoot } of processes.splice(0)) {
    if (!child.killed) child.kill();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('quota-monitor local safe read contract', () => {
  it('keeps safe GET endpoints loopback-only and credential-free', async () => {
    await start();
    for (const pathname of ['/', '/api/health', '/api/oauth-apps', '/api/config', '/api/snapshot']) {
      const response = await get(pathname);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.body).not.toMatch(/(?:sk-|ctx7|token|secret|api[_-]?key)[A-Za-z0-9_-]{12,}/i);
    }
    expect((await get('/api/oauth-apps')).body).toMatch(/"cloudflare":false/);
    expect((await get('/api/oauth-apps')).body).toMatch(/"supabase":false/);
  });
});
