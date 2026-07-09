import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createPwaPreviewServer,
  resolveStaticRoot,
} = require('../../../scripts/serve-pwa-preview.cjs') as {
  createPwaPreviewServer: (options: { staticRoot: string }) => {
    listen: (port: number, host: string, callback: () => void) => void;
    address: () => string | { port: number } | null;
    close: (callback: (error?: Error) => void) => void;
  };
  resolveStaticRoot: (workspaceRoot: string) => string;
};

async function request(port: number, pathname: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    get({
      host: '127.0.0.1',
      port,
      path: pathname,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          body,
        });
      });
    }).on('error', reject);
  });
}

describe('serve-pwa-preview', () => {
  it('serves dist/browser as the preferred Angular production output root', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'nanoflow-pwa-preview-'));
    try {
      mkdirSync(join(workspace, 'dist', 'browser'), { recursive: true });
      mkdirSync(join(workspace, 'dist'), { recursive: true });
      writeFileSync(join(workspace, 'dist', 'browser', 'index.html'), '<html>browser</html>');
      writeFileSync(join(workspace, 'dist', 'index.html'), '<html>dist</html>');

      expect(resolveStaticRoot(workspace)).toBe(join(workspace, 'dist', 'browser'));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('serves service-worker assets directly and falls back app routes to index.html', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'nanoflow-pwa-preview-'));
    mkdirSync(join(workspace, 'dist', 'browser'), { recursive: true });
    writeFileSync(join(workspace, 'dist', 'browser', 'index.html'), '<!doctype html><app-root></app-root>');
    writeFileSync(join(workspace, 'dist', 'browser', 'ngsw-worker.js'), 'self.__worker = true;');

    const server = createPwaPreviewServer({ staticRoot: join(workspace, 'dist', 'browser') });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('无法解析测试服务器端口');
    }

    try {
      await expect(request(address.port, '/ngsw-worker.js')).resolves.toMatchObject({
        status: 200,
        contentType: expect.stringContaining('text/javascript'),
        body: 'self.__worker = true;',
      });
      await expect(request(address.port, '/projects/local/offline')).resolves.toMatchObject({
        status: 200,
        contentType: expect.stringContaining('text/html'),
        body: '<!doctype html><app-root></app-root>',
      });
      await expect(request(address.port, '/%2e%2e/package.json')).resolves.toMatchObject({
        status: 403,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          rmSync(workspace, { recursive: true, force: true });
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
