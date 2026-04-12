import { createRequire } from 'node:module';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildDevServerUrl,
  detectExistingNanoFlowServer,
  resolveDevServerBinding,
} = require('../../../scripts/dev-server-port.cjs') as {
  buildDevServerUrl: (binding: { host?: string; publicHost?: string; port: number }) => string;
  detectExistingNanoFlowServer: (binding: { host: string; port: number; timeoutMs?: number }) => Promise<boolean>;
  resolveDevServerBinding: (options?: {
    args?: string[];
    env?: Record<string, string>;
    portScanSpan?: number;
    checkPortAvailability?: (binding: { host: string; port: number }) => Promise<{ available: boolean; errorCode?: string | null }>;
    checkExistingServer?: (binding: { host: string; port: number }) => Promise<boolean>;
    allowExistingNanoFlowServer?: boolean;
  }) => Promise<{
    host: string;
    publicHost: string;
    port: number;
    fallbackApplied: boolean;
    lastErrorCode: string | null;
    unresolved: boolean;
    reusedExistingServer: boolean;
  }>;
};

describe('dev-server-port', () => {
  it('falls back to the next available port when the default port is blocked', async () => {
    const checkPortAvailability = vi.fn()
      .mockResolvedValueOnce({ available: false, errorCode: 'EACCES' })
      .mockResolvedValueOnce({ available: true, errorCode: null });

    const binding = await resolveDevServerBinding({
      args: ['serve'],
      env: {},
      portScanSpan: 4,
      checkPortAvailability,
    });

    expect(checkPortAvailability).toHaveBeenNthCalledWith(1, { host: 'localhost', port: 3000 });
    expect(checkPortAvailability).toHaveBeenNthCalledWith(2, { host: 'localhost', port: 3001 });
    expect(binding.port).toBe(3001);
    expect(binding.fallbackApplied).toBe(true);
    expect(binding.lastErrorCode).toBe('EACCES');
    expect(buildDevServerUrl(binding)).toBe('http://localhost:3001');
  });

  it('respects an explicit CLI port without probing alternative ports', async () => {
    const checkPortAvailability = vi.fn();

    const binding = await resolveDevServerBinding({
      args: ['serve', '--port=4100'],
      env: {},
      checkPortAvailability,
    });

    expect(binding.port).toBe(4100);
    expect(binding.fallbackApplied).toBe(false);
    expect(checkPortAvailability).not.toHaveBeenCalled();
  });

  it('maps wildcard hosts back to loopback for browser-facing URLs', async () => {
    const checkPortAvailability = vi.fn();

    const binding = await resolveDevServerBinding({
      args: ['serve'],
      env: {
        HOST: '0.0.0.0',
        PORT: '4300',
      },
      checkPortAvailability,
    });

    expect(binding.host).toBe('0.0.0.0');
    expect(binding.publicHost).toBe('127.0.0.1');
    expect(buildDevServerUrl(binding)).toBe('http://127.0.0.1:4300');
    expect(checkPortAvailability).not.toHaveBeenCalled();
  });

  it('marks the binding unresolved when the fallback window is exhausted', async () => {
    const checkPortAvailability = vi.fn().mockResolvedValue({
      available: false,
      errorCode: 'EADDRINUSE',
    });

    const binding = await resolveDevServerBinding({
      args: ['serve'],
      env: {
        NANOFLOW_DEV_SERVER_PORT_SCAN_SPAN: '1',
      },
      checkPortAvailability,
    });

    expect(binding.unresolved).toBe(true);
    expect(binding.port).toBe(3000);
    expect(binding.lastErrorCode).toBe('EADDRINUSE');
    expect(checkPortAvailability).toHaveBeenCalledTimes(2);
  });

  it('can reuse an existing NanoFlow server for Playwright-managed startup', async () => {
    const checkPortAvailability = vi.fn()
      .mockResolvedValueOnce({ available: false, errorCode: 'EACCES' })
      .mockResolvedValueOnce({ available: false, errorCode: 'EACCES' });
    const checkExistingServer = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const binding = await resolveDevServerBinding({
      args: ['serve'],
      env: {},
      portScanSpan: 3,
      allowExistingNanoFlowServer: true,
      checkPortAvailability,
      checkExistingServer,
    });

    expect(binding.port).toBe(3001);
    expect(binding.fallbackApplied).toBe(true);
    expect(binding.reusedExistingServer).toBe(true);
    expect(checkExistingServer).toHaveBeenNthCalledWith(1, { host: 'localhost', port: 3000 });
    expect(checkExistingServer).toHaveBeenCalledWith({ host: 'localhost', port: 3001 });
  });

  it('does not mistake a generic Angular shell for NanoFlow', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Other App</title></head><body><app-root></app-root></body></html>');
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('无法解析测试服务器端口');
    }

    try {
      await expect(detectExistingNanoFlowServer({
        host: '127.0.0.1',
        port: address.port,
        timeoutMs: 100,
      })).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
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
